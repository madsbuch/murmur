#!/usr/bin/env python3
"""Check the optimized APK's reflective scanner entry points before publishing."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile


ANDROID = "{http://schemas.android.com/apk/res/android}"
REGISTRAR_INTERFACE = "com.google.firebase.components.ComponentRegistrar"
REGISTRAR_PREFIX = "com.google.firebase.components:"
REQUIRED_REGISTRARS = {
    "com.google.mlkit.vision.barcode.internal.BarcodeRegistrar",
    "com.google.mlkit.vision.common.internal.VisionCommonRegistrar",
    "com.google.mlkit.common.internal.CommonComponentRegistrar",
}
MODEL_ASSETS = (
    "assets/mlkit_barcode_models/barcode_ssd_mobilenet_v1_dmp25_quant.tflite",
    "assets/mlkit_barcode_models/oned_auto_regressor_mobile.tflite",
    "assets/mlkit_barcode_models/oned_feature_extractor_mobile.tflite",
)


def android_tools():
    env = os.environ.copy()
    studio_java = Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
    if not env.get("JAVA_HOME") and studio_java.is_dir():
        env["JAVA_HOME"] = str(studio_java)

    sdk_candidates = [
        env.get("ANDROID_HOME"),
        env.get("ANDROID_SDK_ROOT"),
        Path.home() / "Library/Android/sdk",
        Path.home() / "Android/Sdk",
    ]
    executable = "apkanalyzer.bat" if os.name == "nt" else "apkanalyzer"
    for candidate in sdk_candidates:
        if not candidate:
            continue
        sdk = Path(candidate)
        candidates = [sdk / "cmdline-tools/latest/bin" / executable]
        candidates += sorted(sdk.glob(f"cmdline-tools/*/bin/{executable}"), reverse=True)
        candidates.append(sdk / "tools/bin" / executable)
        for analyzer in candidates:
            if analyzer.is_file():
                return str(analyzer), env
    analyzer = shutil.which(executable)
    if analyzer:
        return analyzer, env
    raise RuntimeError("Install Android SDK command-line tools and set ANDROID_HOME.")


def analyze(analyzer, env, *args):
    result = subprocess.run(
        [analyzer, *map(str, args)],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        raise RuntimeError(f"apkanalyzer failed: {detail[-2000:]}")
    return result.stdout


def check(apk):
    analyzer, env = android_tools()
    manifest = ET.fromstring(analyze(analyzer, env, "manifest", "print", apk))
    errors = []
    application = manifest.find("application")
    if application is None:
        errors.append("APK manifest has no application.")
    elif application.get(ANDROID + "debuggable", "false") != "false":
        errors.append("APK must be a non-debuggable release build.")

    registrars = {
        node.get(ANDROID + "name", "")[len(REGISTRAR_PREFIX):]
        for node in manifest.iter("meta-data")
        if node.get(ANDROID + "value") == REGISTRAR_INTERFACE
        and node.get(ANDROID + "name", "").startswith(REGISTRAR_PREFIX)
    }
    for missing in sorted(REQUIRED_REGISTRARS - registrars):
        errors.append(f"Missing ML Kit registrar in APK manifest: {missing}")

    # ML Kit discovers these classes by manifest strings, then calls
    # getDeclaredConstructor().newInstance(). R8 can keep a class name while
    # removing its constructor, so inspecting names alone would miss the crash.
    for registrar in sorted(registrars):
        try:
            code = analyze(analyzer, env, "dex", "code", "--class", registrar, apk)
        except RuntimeError as error:
            errors.append(f"Cannot inspect registrar {registrar}: {error}")
            continue
        methods = [line.strip().split() for line in code.splitlines() if line.strip().startswith(".method ")]
        if not any("public" in method and "<init>()V" in method for method in methods):
            errors.append(f"Missing public no-argument constructor in release DEX: {registrar}")

    with zipfile.ZipFile(apk) as archive:
        for asset in MODEL_ASSETS:
            try:
                if archive.getinfo(asset).file_size == 0:
                    errors.append(f"Empty offline barcode model: {asset}")
            except KeyError:
                errors.append(f"Missing offline barcode model: {asset}")

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: non-debuggable APK, {len(registrars)} registrar constructors, and bundled offline QR models.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path, help="Release APK to inspect")
    args = parser.parse_args()
    if not args.apk.is_file():
        parser.error(f"APK does not exist: {args.apk}")
    try:
        return check(args.apk.resolve())
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ET.ParseError, zipfile.BadZipFile) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
