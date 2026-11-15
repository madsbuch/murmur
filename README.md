# Murmur

**Notes, kept close.** A minimal offline notebook for Android and iOS. Create a private network, invite another device with a QR code, and share notes directly on the same local network.

No accounts, hosted backend, relay, or required runtime cloud services. Internet access is needed to install development dependencies, not to use the app.

## Stack

- Latest stable Tauri **2.12.5**; JavaScript API and CLI **2.12.4**, pinned with lockfiles. Tauri 3 is currently prerelease.
- Plain TypeScript, CSS, and Vite. No frontend framework.
- Rust **Automerge 0.12.0** for text CRDTs, local persistence, and synchronization.
- Android `NsdManager`, iOS Bonjour `NetService`, desktop `mdns-sd` for `_murmur._tcp` discovery.
- Tauri's official barcode scanner for Android/iOS; QR codes generated locally. Android substitutes the bundled `com.google.mlkit:barcode-scanning:17.3.0` detector for the plugin's default downloaded model, so scanning works on first launch without an Internet connection.

## Run

Install Node.js 22.12+ and Rust 1.90+ with your platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). This project was verified with Node 26 and Rust 1.92.

```sh
npm ci
npm run tauri -- dev
```

The desktop app uses the real Rust store, CRDT, encryption, and LAN discovery. QR camera scanning is mobile-only; desktop can paste invitations.

Phones use separate list/editor views. Tablets show the notes list beside the editor, with portrait and landscape support, safe-area padding, touch targets of at least 44 pixels, and keyboard-aware editor height. Narrow tablet split-screen windows automatically use the phone layout. The iOS target supports both iPhone and iPad. Responsive checks cover 320, 600, 768, 1024, and 1366 pixel widths.

```sh
npm run android       # Connected Android device / emulator
npm run android:build # Debug arm64 APK
npm run ios           # iOS device / simulator
```

The generated Android and Xcode projects are included in `src-tauri/gen/`. The Android helper detects the usual SDK, NDK, and Android Studio JDK paths; environment variables `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` take precedence. If regenerating, run `node scripts/mobile.mjs android init` or `npm run tauri -- ios init`.

Keep the Android root Gradle scanner dependency substitution and `android:allowBackup="false"` manifest setting if regenerating the native project.

iOS device builds need an Apple development team and signing certificate. Set `APPLE_DEVELOPMENT_TEAM` or `bundle.iOS.developmentTeam` in the Tauri configuration. An unsigned simulator build can be made with:

```sh
npm run tauri -- ios build --debug --target aarch64-sim --no-sign --ci
```

`npm run dev` opens an explicitly labeled **browser preview**. Its separate localStorage adapter supports interface development only; native LAN sync and camera scanning run in the Tauri app.

## GitHub releases and permanent signing

The [GitHub repository](https://github.com/madsbuch/murmur) uses the same release flow as Learn Polish. Pull requests run tests; pushes to `main` and manual workflow runs build the Android release APK for ARM64 and ARMv7. Once tests and signing pass on `main`, the workflow replaces the rolling [latest release](https://github.com/madsbuch/murmur/releases/tag/latest) with `Murmur-android-universal.apk` and its `SHA256SUMS` checksum file. Native Android customizations are checked in and preserved by CI.

The permanent Android identity is stored **outside this repository** in `../signing-keys/murmur/`: `murmur-release.jks`, `signing.json` (including the password), and `certificate.pem`. Keep a secure backup of the entire directory. The RSA-4096 certificate is valid for 100 years; future updates must use this same key. The folder is private and excluded from Git. The CI signer fails if signing secrets are missing instead of creating a temporary key.

The four encrypted GitHub Actions repository secrets are `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The helper uploads them through standard input without printing their values:

```sh
npm run signing:verify
python3 scripts/android-signing.py upload
npm run android:release
```

The local release command builds a release APK, signs it with the saved identity, and verifies its certificate. Its output is `out/Murmur-android-universal.apk`. `python3 scripts/android-signing.py create` is only for initial setup and refuses to replace an existing key directory. Use `--directory` if the backup lives elsewhere.

This matches Learn Polish's Android-only release pipeline. iOS remains buildable locally and requires an Apple-issued signing certificate and provisioning profile for device distribution; Android's permanent key does not sign iOS apps.

## Use on two phones

1. Install Murmur on both devices. Connect them to the same Wi-Fi network.
2. On the first device, select **Create a network** and enter a name.
3. Tap the network name or **Invite a device** to display its QR code.
4. On the other device, select **Join a network → Scan QR code**. Allow camera and local network access when requested. Pasting the invitation also works.
5. Keep both apps open. Notes synchronize automatically; no manual pairing or IP address entry is needed.
6. Disconnect one device, edit on both, then reconnect and reopen Murmur. Both devices converge, including concurrent edits within the same note.

Every member can read, edit, delete, and invite other members. Treat the QR invitation as a password: it includes the network ID and a random 256-bit secret. There is no member revocation in this MVP; create a new network to change membership.

Switching networks retains the previous network's data on the device. Save its invitation before switching; rejoin with that invitation to reopen it.

## How synchronization works

The Rust core is the source of truth. A network has one Automerge document with independent note maps and CRDT text objects. All devices construct the same initial history. Each editor save forks the exact revision it displayed, applies text differences, and merges that fork into the current document. This preserves edits arriving from another device while you type. Deletes use permanent tombstones so a concurrent text edit cannot resurrect a note.

The store writes a temporary file, flushes it, atomically renames it, and flushes the directory before reporting a successful save. Files live in Tauri's app data directory. The frontend keeps an unsaved draft for recovery during abrupt shutdown.

Discovery advertises only a protocol version, network ID, device ID, and an ephemeral TCP port. The shared secret is never advertised. Peers exchange length-bounded, XChaCha20-Poly1305 encrypted and authenticated Automerge snapshots over TCP. Protocol, network, and message direction are authenticated; invalid keys and malformed documents are rejected. Snapshot exchange is intentionally simple for a small notebook. CRDT merging makes duplicates and old snapshots harmless.

Synchronization retries every five seconds, after edits/discovery, and when the app returns to the foreground. Discovery refreshes peer addresses after network changes. Temporary failure leaves local notes usable.

## MVP boundaries

- Sync is designed for apps open in the foreground. iOS and Android can suspend background work; reopen Murmur to reconnect.
- Both devices must share a LAN that permits mDNS and direct peer connections. Guest Wi-Fi/client isolation can block them. There is no Internet fallback.
- Maximum 2,000 notes including deletion tombstones, 128 KiB per note body, 1 KiB per title, and 8 MiB of Automerge history per network. Full history is retained; there is no compaction/export UI.
- Notes and secrets use the OS app sandbox and private file permissions. They are not separately encrypted at rest. Android automatic app backup is disabled. Device-level access and OS backups are outside the peer encryption boundary.
- Changing networks keeps an archive but there is no network picker; keep invitations to return.
- The browser preview is not a peer and does not use the Rust CRDT store.

## Checks

```sh
npm run build
npm test
npm run test:ui
```

The Rust suite exercises independent creation, concurrent text edits, stale editor saves, delete-versus-edit, persistence/rejoin, malformed invitations, authenticated encryption, real loopback TCP exchange, reconnect, and automatic sync. Playwright exercises the mobile-sized UI, local persistence, QR display, switching/rejoining, deletion, and draft rebasing. If Chromium is missing, run `npx playwright install chromium`.

Verified on November 15, 2026: production frontend build, 12 Rust tests, 9 Playwright tests, Android debug arm64 APK/AAB, and an unsigned iOS device archive. On an Android emulator, the real app created a network, saved notes through Rust, restored them after force-stop/relaunch, generated a QR invitation, and initialized the camera scanner with Wi-Fi/mobile data disabled. The simulator build could not run with this machine's installed runtime/SDK combination; the full iOS app was compiled against the device SDK instead.

For physical-device acceptance, run the two-phone flow above on Android ↔ iOS, deny and then grant LAN/camera permissions, toggle Wi-Fi, background/foreground both apps, and restart both with notes saved. Simulator and loopback tests cannot establish that a particular Wi-Fi network permits Bonjour or that physical camera scanning works.

## Layout

- `src/`: small interface, editor save queue, QR screens, browser preview adapter.
- `native.ts`: discovery lifecycle and peer events.
- `src-tauri/src/engine.rs`: Automerge document and durable local store.
- `src-tauri/src/transport.rs`: encrypted peer protocol and retries.
- `src-tauri/plugins/lan/`: native Android/iOS discovery and desktop fallback.
- `src-tauri/Info.ios.plist`: camera and Bonjour privacy declarations.

API references: [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [barcode scanner](https://v2.tauri.app/plugin/barcode-scanner/), [bundled Android detector](https://developers.google.com/ml-kit/vision/barcode-scanning/android), [Automerge](https://docs.rs/automerge/0.12.0/automerge/).
