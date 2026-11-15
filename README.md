# Murmur

**Notes, kept close.** A minimal offline notebook for Android and iOS. Create a private network, invite another device with a QR code, and share notes directly on the same local network.

No accounts, hosted backend, relay, or required runtime cloud services. Internet access is needed to install development dependencies, not to use the app.

## Stack

- Latest stable Tauri **2.12.5**; JavaScript API and CLI **2.12.4**, pinned with lockfiles. Tauri 3 is currently prerelease.
- Plain TypeScript, CSS, and Vite. No frontend framework.
- Rust **Automerge 0.12.0** for text CRDTs, local persistence, and synchronization.
- **Diesel 2.4.0** with bundled **SQLite** for all native durable data: device identity, active network, saved networks and secrets, Automerge history, and recovery drafts.
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

Keep the Android root Gradle scanner dependency substitution, the ML Kit registrar constructor rules in `app/proguard-rules.pro`, and the `android:allowBackup="false"` manifest setting if regenerating the native project. The constructor rules prevent release optimization from removing the classes' reflective entry points and crashing the scanner after camera permission is granted.

iOS device distribution needs an Apple development team and signing certificate. Set `APPLE_DEVELOPMENT_TEAM` or `bundle.iOS.developmentTeam` in the Tauri configuration. Xcode 27 also requires Rust's LLVM tools to export the Swift plugin entry points. To build an unsigned device archive:

```sh
rustup component add llvm-tools
npm run tauri -- ios build --target aarch64 --no-sign --archive-only --ci
```

`npm run dev` opens an explicitly labeled, temporary **browser preview**. Its in-memory adapter supports interface development; reloading clears the demo. Durable SQLite storage, LAN sync, and camera scanning run in the Tauri app.

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

The Rust store uses Diesel to write `murmur.sqlite3` in Tauri's app data directory. Embedded migrations create the schema. SQLite transactions, WAL journaling, and full synchronous writes keep note commits and network changes durable. Each network retains its complete Automerge document as a binary value, including edit history and deletion tombstones. Recovery drafts also live in SQLite. The app creates database files with private permissions on Unix platforms.

On upgrade, the store validates and imports the previous JSON identity and all saved network files in one transaction. Original files are moved to `legacy-json-backup` only after the database commit succeeds; a failed import leaves them intact. These files are inert migration backups. Existing WebView recovery drafts are validated and imported once, without replacing a newer database draft, before their old storage entry is removed.

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
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-deps -- -D warnings
```

The Rust suite exercises SQLite migration and rollback, private file permissions, durable drafts, atomic draft cleanup, concurrent edits, persistence/rejoin, malformed invitations, authenticated encryption, loopback TCP exchange, reconnect, and automatic sync. Playwright exercises phone and tablet layouts, QR display, switching/rejoining, deletion, draft rebasing, runtime validation, recovery failures and retries, and the temporary browser preview. Native IPC mocks cover UI failure cases; Rust tests verify the actual database. If Chromium is missing, run `npx playwright install chromium`.

Safety rules apply to Murmur's own Rust and TypeScript code. Both Rust crates forbid `unsafe` code and `as` conversions; numeric conversions are checked or lossless. TypeScript uses strict indexed and optional-property checking, runtime validation of IPC and parsed data, and type-aware ESLint rules that reject `any`, assertions, non-null assertions, and implicit value coercions. `npm run build` runs these checks, and CI also runs Clippy for desktop and Android code. Dependencies retain their own implementations, including Diesel/SQLite's native internals.

Local release builds and GitHub Actions run `scripts/check-android-scanner.py` against the signed APK before distribution. It checks that the release retains the manifest-discovered ML Kit constructors and includes its offline models. Version 0.1.1 fixes a release-only camera crash caused by R8 removing those constructors; the check rejects the affected 0.1.0 APK.

Test the **signed release APK** on an unlocked, disposable English-language Android emulator with a back camera using `python3 scripts/test-android-scanner.py --serial emulator-5580 --apk out/Murmur-android-universal.apk`. This installs an update without clearing notes, resets camera permission, grants it through the system dialog, checks that the bundled detector initializes and the camera streams while the app stays alive, and cancels/reopens the scanner. It rejects physical devices and debuggable APKs, and does not print notebook contents or raw logs. This catches release-only shrinking failures that browser and debug-build tests cannot cover.

Verified on November 15, 2026 for version 0.2.0: production frontend build, 18 Rust tests, 17 Playwright tests, strict desktop/Android Clippy, a signed ARM64/ARMv7 release APK, and an unsigned iOS device archive. An Android emulator upgraded a saved 0.1.1 notebook to SQLite with its network identity and text intact, then retained a new edit across force-stop/relaunch. TypeScript safety checks also rejected deliberate examples of nine prohibited patterns. The iOS archive supports iPhone and iPad; physical iOS behavior still requires device testing.

The signed, optimized Android 0.2.0 APK also passed the camera smoke test with Wi-Fi and mobile data disabled: first permission grant, bundled detector initialization, sustained preview, cancellation, and reopening. The same test reproduced the crash in the published 0.1.0 APK.

For physical-device acceptance, run the two-phone flow above on Android ↔ iOS, deny and then grant LAN/camera permissions, toggle Wi-Fi, background/foreground both apps, and restart both with notes saved. Simulator and loopback tests cannot establish that a particular Wi-Fi network permits Bonjour or that physical camera scanning works.

## Layout

- `src/`: small interface, editor save queue, QR screens, browser preview adapter.
- `native.ts`: discovery lifecycle and peer events.
- `src-tauri/src/engine.rs`: Automerge document and durable local store.
- `src-tauri/src/storage.rs`, `schema.rs`, and `migrations/`: Diesel SQLite storage and schema migrations.
- `src-tauri/src/transport.rs`: encrypted peer protocol and retries.
- `src-tauri/plugins/lan/`: native Android/iOS discovery and desktop fallback.
- `src-tauri/Info.ios.plist`: camera and Bonjour privacy declarations.

API references: [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [barcode scanner](https://v2.tauri.app/plugin/barcode-scanner/), [bundled Android detector](https://developers.google.com/ml-kit/vision/barcode-scanning/android), [Automerge](https://docs.rs/automerge/0.12.0/automerge/).
