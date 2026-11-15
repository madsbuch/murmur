#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

app="${1:?Pass the built Murmur.app path}"
if [[ "$app" != /* ]]; then app="$PWD/$app"; fi
test -d "$app/Contents/MacOS"
test "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = app.murmur.notes
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
xcodegen generate --spec src-tauri/apple-share/macOS/project.yml
xcodebuild -project src-tauri/apple-share/macOS/MurmurShare.xcodeproj \
  -scheme MurmurShare -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath src-tauri/apple-share/build/mac -jobs 2 \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$version" build

extension="src-tauri/apple-share/build/mac/Build/Products/Release/MurmurShare.appex"
test -d "$extension"
mkdir -p "$app/Contents/PlugIns"
rm -rf "$app/Contents/PlugIns/MurmurShare.appex"
ditto "$extension" "$app/Contents/PlugIns/MurmurShare.appex"
codesign --force --sign - --options runtime --timestamp=none \
  --entitlements src-tauri/apple-share/macOS/Entitlements.plist "$app/Contents/PlugIns/MurmurShare.appex"
# Embedding changes the outer bundle seal, so sign the host again last.
codesign --force --sign - --options runtime --timestamp=none \
  --entitlements src-tauri/Entitlements.macos.plist "$app"
codesign --verify --deep --strict --verbose=2 "$app"
