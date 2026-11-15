#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# An explicit target makes the output deterministic on local Macs and CI.
npm run tauri -- build --target aarch64-apple-darwin --bundles app -- --locked

bundle_dir="src-tauri/target/aarch64-apple-darwin/release/bundle"
app="$bundle_dir/macos/Murmur.app"
bash scripts/build-macos-share.sh "$app"
codesign --verify --deep --strict --verbose=2 "$app"
test "$(lipo -archs "$app/Contents/MacOS/murmur")" = arm64
python3 - "$app" <<'PY'
import plistlib
import subprocess
import sys
from pathlib import Path
app = Path(sys.argv[1])
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info.get('NSCameraUsageDescription'), 'Missing Mac camera usage description'
assert '_murmur._tcp' in info.get('NSBonjourServices', []), 'Missing Bonjour service declaration'
signed = subprocess.run(['codesign', '--display', '--entitlements', ':-', str(app)],
                        check=True, capture_output=True)
entitlements = plistlib.loads(signed.stdout)
assert entitlements.get('com.apple.security.device.camera') is True, 'Missing signed camera entitlement'
PY

mkdir -p out
# A standard drag-to-Applications image needs no Finder automation permission,
# so this works identically on developer machines and headless CI runners.
stage="$(mktemp -d "${TMPDIR:-/tmp}/murmur-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Murmur.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname Murmur -srcfolder "$stage" -ov -format UDZO out/Murmur-macos-apple-silicon.dmg
hdiutil verify out/Murmur-macos-apple-silicon.dmg
ditto -c -k --sequesterRsrc --keepParent "$app" out/Murmur-macos-apple-silicon.app.zip
(
  cd out
  shasum -a 256 Murmur-macos-apple-silicon.dmg Murmur-macos-apple-silicon.app.zip > SHA256SUMS-macos
)
