#!/usr/bin/env python3
"""Create, back up, upload, and use Murmur's stable Android signing identity.

Credentials live outside the repository; no command prints secret values.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from datetime import date

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIRECTORY = ROOT.parent / "signing-keys" / "murmur"
SECRET_NAMES = ("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")


def run(args, *, env=None, input=None):
    result = subprocess.run([str(a) for a in args], env=env, input=input, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or f"{args[0]} failed")
    return result.stdout


def keytool():
    candidates = [Path(os.environ.get("JAVA_HOME", "/nonexistent")) / "bin/keytool",
                  Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool")]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("keytool")
    if not found:
        raise RuntimeError("Install a JDK or set JAVA_HOME to use keytool.")
    return found


def write_private(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(content)


def load(directory):
    config = json.loads((directory / "signing.json").read_text())
    keystore = directory / "murmur-release.jks"
    if not keystore.is_file():
        raise RuntimeError(f"Keystore is missing from {directory}.")
    env = {**os.environ, "MURMUR_STORE_PASSWORD": config["password"]}
    cert = run([keytool(), "-exportcert", "-keystore", keystore, "-alias", config["alias"],
                "-storepass:env", "MURMUR_STORE_PASSWORD"], env=env)
    fingerprint = hashlib.sha256(cert).hexdigest().upper()
    if fingerprint != config["certificate_sha256"].replace(":", "").upper():
        raise RuntimeError("The keystore certificate does not match its saved fingerprint.")
    return config, keystore, env


def create(directory, repository):
    if directory.exists():
        raise RuntimeError(f"Refusing to replace an existing signing directory: {directory}")
    directory.mkdir(parents=True, mode=0o700)
    os.chmod(directory, 0o700)
    password = secrets.token_urlsafe(48)
    config = {"repository": repository, "application_id": "app.murmur.notes", "alias": "murmur",
              "password": password, "created_on": date.today().isoformat()}
    # Save recovery information first, so an interruption never leaves an unknown password.
    metadata = directory / "signing.json"
    write_private(metadata, json.dumps(config, indent=2) + "\n")
    env = {**os.environ, "MURMUR_STORE_PASSWORD": password}
    keystore = directory / "murmur-release.jks"
    run([keytool(), "-genkeypair", "-storetype", "JKS", "-keystore", keystore,
         "-alias", config["alias"], "-keyalg", "RSA", "-keysize", "4096", "-validity", "36500",
         "-storepass:env", "MURMUR_STORE_PASSWORD", "-keypass:env", "MURMUR_STORE_PASSWORD",
         "-dname", "CN=Murmur, OU=Personal, O=Murmur, C=DK"], env=env)
    os.chmod(keystore, 0o600)
    cert = run([keytool(), "-exportcert", "-keystore", keystore, "-alias", config["alias"],
                "-storepass:env", "MURMUR_STORE_PASSWORD"], env=env)
    config["certificate_sha256"] = hashlib.sha256(cert).hexdigest().upper()
    metadata.write_text(json.dumps(config, indent=2) + "\n")
    os.chmod(metadata, 0o600)
    pem = "-----BEGIN CERTIFICATE-----\n" + "\n".join(
        base64.b64encode(cert).decode()[i:i + 64] for i in range(0, len(base64.b64encode(cert)), 64)
    ) + "\n-----END CERTIFICATE-----\n"
    write_private(directory / "certificate.pem", pem)
    write_private(directory / "README.txt", "Murmur permanent Android release signing identity.\n"
                  "Keep this entire directory in a secure backup. Never commit its contents.\n"
                  "murmur-release.jks contains the RSA private key. signing.json contains its password.\n"
                  "certificate.pem is the matching public certificate.\n"
                  "Store and key use the same password; the alias is murmur.\n"
                  "Use the same identity for every release. Do not regenerate it after distribution.\n"
                  "The signing certificate is valid for 100 years.\n")
    load(directory)
    print(f"Created and verified signing identity in {directory}")
    print(f"Certificate SHA-256: {config['certificate_sha256']}")


def upload(directory, repository):
    config, keystore, _ = load(directory)
    values = [base64.b64encode(keystore.read_bytes()), config["password"].encode(),
              config["alias"].encode(), config["password"].encode()]
    for name, value in zip(SECRET_NAMES, values):
        run(["gh", "secret", "set", name, "--repo", repository], input=value)
        print(f"Configured {name} in {repository}")


def sign(directory, apk):
    config, keystore, env = load(directory)
    env.setdefault("JAVA_HOME", str(Path(keytool()).parent.parent))
    sdk = Path(os.environ.get("ANDROID_HOME", os.environ.get("ANDROID_SDK_ROOT", str(Path.home() / "Library/Android/sdk"))))
    versions = [p for p in (sdk / "build-tools").iterdir() if (p / "apksigner").is_file()]
    if not versions:
        raise RuntimeError("Android build-tools are missing. Set ANDROID_HOME.")
    tools = sorted(versions, key=lambda p: tuple(int(v) if v.isdigit() else 0 for v in p.name.split('.')))[-1]
    if apk is None:
        candidates = list((ROOT / "src-tauri/gen/android/app/build/outputs/apk").rglob("*release*.apk"))
        if len(candidates) != 1:
            raise RuntimeError("Build one release APK first, or pass --apk with the intended APK path.")
        apk = candidates[0]
    output = ROOT / "out"
    output.mkdir(exist_ok=True)
    aligned = output / "aligned.apk"
    signed = output / "Murmur-android-universal.apk"
    try:
        run([tools / "zipalign", "-P", "16", "-f", "4", apk, aligned])
        run([tools / "apksigner", "sign", "--ks", keystore, "--ks-key-alias", config["alias"],
             "--ks-pass", "env:MURMUR_STORE_PASSWORD", "--key-pass", "env:MURMUR_STORE_PASSWORD",
             "--out", signed, aligned], env=env)
        report = run([tools / "apksigner", "verify", "--print-certs", signed]).decode()
        if config["certificate_sha256"].lower() not in report.replace(":", "").lower():
            raise RuntimeError("Signed APK fingerprint does not match Murmur's saved signing identity.")
        print(f"Signed and verified {signed}")
    finally:
        aligned.unlink(missing_ok=True)
        signed.with_suffix(".apk.idsig").unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "upload", "verify", "sign"))
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--repository", default="madsbuch/murmur")
    parser.add_argument("--apk", type=Path)
    args = parser.parse_args()
    if args.command == "create":
        create(args.directory, args.repository)
    elif args.command == "upload":
        upload(args.directory, args.repository)
    elif args.command == "sign":
        sign(args.directory, args.apk)
    else:
        config, _, _ = load(args.directory)
        print(f"Verified {args.directory}; certificate SHA-256: {config['certificate_sha256']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Signing setup failed: {error}", file=sys.stderr)
        sys.exit(1)
