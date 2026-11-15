#!/usr/bin/env bash
# CI supplies these values from encrypted GitHub repository secrets.
# The durable original key stays outside the repo in ../signing-keys/murmur/.
set -euo pipefail
umask 077

for variable in KEYSTORE_BASE64 KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'Missing permanent signing secret: %s. Refusing to create a throwaway key.\n' "$variable" >&2
    exit 1
  fi
done

tools="${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/36.0.0"
signing_temp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/murmur-signing.XXXXXX")"
trap 'rm -rf "$signing_temp"' EXIT

printf '%s' "$KEYSTORE_BASE64" | base64 --decode > "$signing_temp/key.jks"
mapfile -t apks < <(find src-tauri/gen/android/app/build/outputs/apk -type f -name '*release*.apk')
if [[ ${#apks[@]} -ne 1 ]]; then
  printf 'Expected one universal release APK, found %s.\n' "${#apks[@]}" >&2
  exit 1
fi

mkdir -p out
"$tools/zipalign" -P 16 -f 4 "${apks[0]}" "$signing_temp/aligned.apk"
"$tools/apksigner" sign \
  --ks "$signing_temp/key.jks" \
  --ks-pass env:KEYSTORE_PASSWORD \
  --ks-key-alias "$KEY_ALIAS" \
  --key-pass env:KEY_PASSWORD \
  --out out/Murmur-android-universal.apk "$signing_temp/aligned.apk"
"$tools/apksigner" verify --verbose --print-certs out/Murmur-android-universal.apk
"$tools/zipalign" -c -P 16 4 out/Murmur-android-universal.apk
rm -f out/*.idsig
(cd out && sha256sum Murmur-android-universal.apk > SHA256SUMS)
