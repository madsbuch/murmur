# Murmur

Murmur is an offline note and file-sharing app for Android, iOS, and macOS. Create a network, invite devices by QR code or word phrase, and synchronize directly on the same local network.

No accounts, hosted backend, relay, or required runtime cloud services. Internet access is needed to install development dependencies, not to use the app.

## Stack

- Latest stable Tauri **2.12.5**; JavaScript API and CLI **2.12.4**, pinned with lockfiles. Tauri 3 is currently prerelease.
- Plain TypeScript, CSS, and Vite. No frontend framework.
- Rust **Automerge 0.12.0** for text CRDTs, local persistence, and synchronization.
- The Rust core uses **Diesel 2.4.0** with bundled **SQLite** for its durable data: device identity, active network, saved networks and secrets, Automerge history, recovery drafts, shared file contents, theme preferences, incoming shares, and handoff receipts.
- Android `NsdManager`, iOS Bonjour `NetService`, desktop `mdns-sd` for `_murmur._tcp` discovery.
- Tauri's official barcode scanner for Android/iOS and local jsQR camera decoding on macOS; QR codes generated locally. Android substitutes the bundled `com.google.mlkit:barcode-scanning:17.3.0` detector for the plugin's default downloaded model, so scanning works on first launch without an Internet connection.

## Run

Install Node.js 22.12+ and Rust 1.90+ with your platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). This project was verified with Node 26 and Rust 1.92.

```sh
npm ci
npm run tauri -- dev
```

The desktop app uses the real Rust store, CRDT, encryption, and LAN discovery. The Mac window opens with a two-pane layout and resizes down to the compact phone layout. Mobile uses the native QR scanner; Mac uses its camera with local QR decoding. Both can join by typing or pasting an invitation phrase.

Phones use separate list/editor views. Tablets show the notes list beside the editor, with portrait and landscape support, safe-area padding, touch targets of at least 44 pixels, and keyboard-aware editor height. Narrow tablet split-screen windows automatically use the phone layout. The iOS target supports both iPhone and iPad. Settings offers System (default), Light, and Dark themes; transitions respect Reduce Motion. The compact interface uses system sans-serif and monospace fonts without network font downloads. Only the note list, note body, file grid, and settings content scroll; navigation stays inside the visible viewport when the keyboard opens. Responsive checks cover 320, 430, 600, 768, 1024, 1100, and 1366 pixel widths. With a landscape keyboard open, the editor hides global navigation and keeps Back, save status, and the note body usable even at 150–200 pixels of available height.

```sh
npm run android       # Connected Android device / emulator
npm run android:build # Debug arm64 APK
npm run ios           # iOS device / simulator
npm run macos:release # Apple Silicon app, DMG, and zipped app
```

The generated Android and Xcode projects are included in `src-tauri/gen/`. The Android helper detects the usual SDK, NDK, and Android Studio JDK paths; environment variables `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` take precedence. If regenerating, run `node scripts/mobile.mjs android init` or `npm run tauri -- ios init`.

Keep the Android root Gradle scanner dependency substitution, the ML Kit registrar constructor rules in `app/proguard-rules.pro`, the `android:allowBackup="false"` manifest setting, share intent filters, and the checked-in activity/plugins if regenerating the native project. The constructor rules prevent release optimization from removing the classes' reflective entry points and crashing the scanner after camera permission is granted.

iOS device distribution needs an Apple development team and signing certificate. Set `APPLE_DEVELOPMENT_TEAM` or `bundle.iOS.developmentTeam` in the Tauri configuration. Xcode 27 also requires Rust's LLVM tools to export the Swift plugin entry points. To build an unsigned device archive:

```sh
rustup component add llvm-tools
npm run tauri -- ios build --target aarch64 --no-sign --archive-only --ci
```

`npm run dev` opens an explicitly labeled, temporary **browser preview**. Its in-memory adapter supports interface development; reloading clears the demo. Browser camera scanning is available when the browser permits camera access. Durable SQLite storage, LAN sync, and operating-system share reception require the installed Tauri app.

## GitHub releases and permanent signing

The [GitHub repository](https://github.com/madsbuch/murmur) uses the same release flow as Learn Polish. Pull requests run tests; pushes to `main` and manual workflow runs build the Android release APK for ARM64 and ARMv7 plus the Apple Silicon macOS app and installer. Once tests and signing pass on `main`, the workflow replaces the rolling [latest release](https://github.com/madsbuch/murmur/releases/tag/latest) with `Murmur-android-universal.apk`, `Murmur-macos-apple-silicon.dmg`, `Murmur-macos-apple-silicon.app.zip`, and a combined `SHA256SUMS` checksum file. Native Android customizations are checked in and preserved by CI.

The permanent Android identity is stored **outside this repository** in `../signing-keys/murmur/`: `murmur-release.jks`, `signing.json` (including the password), and `certificate.pem`. Keep a secure backup of the entire directory. The RSA-4096 certificate is valid for 100 years; future updates must use this same key. The folder is private and excluded from Git. The CI signer fails if signing secrets are missing instead of creating a temporary key.

The four encrypted GitHub Actions repository secrets are `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The helper uploads them through standard input without printing their values:

```sh
npm run signing:verify
python3 scripts/android-signing.py upload
npm run android:release
```

The local release command builds a release APK, signs it with the saved identity, and verifies its certificate. Its output is `out/Murmur-android-universal.apk`. `python3 scripts/android-signing.py create` is only for initial setup and refuses to replace an existing key directory. Use `--directory` if the backup lives elsewhere.

The Mac build supports M1 and newer Macs running macOS 12 or later. It requires Xcode and XcodeGen to build and embed `MurmurShare.appex`; `npm run macos:release` includes that step and verifies the nested signatures. Open the DMG and drag Murmur to Applications, or unzip the app. The local build is in `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Murmur.app`; distribution copies are in `out/`. It uses an ad-hoc signature, verified during every build. It is not Apple-notarized: browser downloads may require **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. Apple Developer ID signing can be configured later with an Apple-issued certificate.

iOS remains buildable locally and requires an Apple-issued signing certificate and provisioning profile for device distribution; Android's permanent key does not sign Apple apps.

For the iOS share extension, register App Group `group.app.murmur.notes` with your Apple development team, then enable it for **both** `app.murmur.notes` and `app.murmur.notes.share` under that team. Both provisioning profiles must include that group. The host entitlement is in `src-tauri/gen/apple/murmur_iOS/murmur_iOS.entitlements`; the extension entitlement is in `src-tauri/apple-share/iOS/Entitlements.plist`. The checked-in Xcode project embeds the `MurmurShare_iOS` target. Keep the matching App Group declarations in `src-tauri/gen/apple/project.yml` when regenerating it. An unsigned archive can compile the extension but cannot establish device signing, App Group access, or share-sheet behavior. The macOS extension uses a SQLite transfer file and does not require this iOS App Group.

## Use on two devices

1. Install Murmur on both devices (phones, tablets, or Macs). Connect them to the same Wi-Fi network.
2. On the first device, select **Create a network** and enter a name.
3. Tap the network name or **Invite a device** to display its QR code.
4. On the other device, select **Join a network → Scan QR code**. Allow camera and local network access when requested. Typing or pasting the invitation phrase also works.
5. Keep both apps open. Notes synchronize automatically; no manual pairing or IP address entry is needed.
6. Disconnect one device, edit on both, then reconnect and reopen Murmur. Both devices converge, including concurrent edits within the same note.

Every member can read, edit, delete, and invite other members. Treat the QR invitation and word phrase as passwords: both contain the network identity and its random 256-bit secret. New networks use a 24-word English invitation with a checksum; the first four letters of each word are enough when typing, and capitalization or extra whitespace does not matter. Older networks use 36 words so their original identity and secret remain intact. Existing QR codes and invitation links still work. A word-only invitation labels an unfamiliar network “Shared network”; rejoining a saved network preserves its local name. There is no member revocation in this MVP; create a new network to change membership.

Switching networks retains the previous network's data on the device. Save its invitation before switching; rejoin with that invitation to reopen it.

## Shared files

Open **Files → Add files** and select tracks, videos, pictures, documents, or other files from the system picker. Files are copied into the local SQLite database and remain available offline. Other devices receive the file metadata first, show **Waiting for a nearby device**, then automatically fetch and verify the content. Tap a file to preview it: audio and video have built-in playback and seeking controls, pictures open at full size, and text and Markdown files can be read directly in Murmur. Markdown previews show headings, lists, tables, links, and code blocks. Text previews show the first 256 KiB of large files.

Playback starts when you press Play and stops when you close the preview. Supported audio/video codecs depend on the device; an unreadable format shows an explanation. PDFs and other formats without a built-in preview still offer **Save file**, which exports a copy through the system save picker so it can be opened in another app. Cancelling the picker leaves the shared copy intact.

Choose **Paste image** in Files to add an image from the system clipboard, or use **⌘V / Ctrl+V** while Files is open. Open a picture and choose **Copy image** to paste it into another app. Copying uses the full-size image as PNG (the current frame for animated images), and clipboard images are limited to 25 MiB and 40 million pixels on native platforms. Clipboard access happens only when requested; it is never polled. Text pasting in notes continues to work normally. Browser clipboard actions may require permission from the browser.

Files are immutable: importing a changed file creates a new entry. Deleting an entry propagates to peers; the final reference to its content is removed from SQLite. Files are limited to 25 MiB each, 250 MiB of unique live contents per network, and 500 entries including deletion history. Large transfers retry from the beginning after interruption.

You can also send screenshots, pictures, PDFs, or other files to Murmur from another app's Share menu:

| Platform | Incoming sharing |
| --- | --- |
| Android | Select **Murmur** in the system share chooser. Single and multiple file shares are copied into a native SQLite inbox and delivered to the app. |
| iOS / iPadOS | Select **Murmur**, then **Save to Murmur**. After saving, open Murmur to import the files. The extension requires the App Group signing setup above. |
| macOS | Select **Murmur** in a supporting app's Share menu, then **Add to Murmur**. The embedded extension prepares a SQLite transfer and opens the installed host app. Availability in the Share menu depends on extension registration and the source app. |

With an active network, Murmur saves any note being edited, imports the pending batch into that network, and opens **Files**. Recovery, an open dialog, or another operation delays importing. Without an active network, **files ready to add** remains on the start screen until you create or join one. A failed import keeps its queue and offers **Retry import** or **Discard**. Discard removes queued copies only; originals are unchanged.

The incoming inbox holds at most 32 files and 100 MiB, with the same 25 MiB per-file limit. Native handoff queues and the app inbox use SQLite; handoff receipts prevent a repeated delivery from duplicating an accepted batch. Importing the pending app inbox into a network is atomic. A source share extension can still report that only some selected files were saved if a later file fails; check its result before closing it. Files must be provided as readable file/image attachments. Folders, text-only messages, and web-link-only shares are outside this feature's scope. Murmur does not fetch remote attachments itself.

## How synchronization works

Notes support Markdown. Use **Write** to edit the source and **Preview** to read its formatting; switching views preserves the text and its normal autosave behavior. The original Markdown text synchronizes between devices. Rendering happens locally, raw HTML stays inert, and embedded remote images are shown as descriptions without network requests.

The Rust core is the source of truth. A network has one Automerge document with independent note maps and CRDT text objects. All devices construct the same initial history. Each editor save forks the exact revision it displayed, applies text differences, and merges that fork into the current document. This preserves edits arriving from another device while you type. Deletes use permanent tombstones so a concurrent text edit cannot resurrect a note.

The Rust store uses Diesel to write `murmur.sqlite3` in Tauri's app data directory. Native share receivers stage incoming copies in separate SQLite inboxes; Apple extensions use GRDB for that staging layer, and the Rust host reads and imports them through Diesel. Embedded migrations create the schema. SQLite transactions, WAL journaling, and full synchronous writes keep note commits and network changes durable. Each network retains its complete Automerge document as a binary value, including edit history and deletion tombstones. Recovery drafts also live in SQLite. The app creates database files with private permissions on Unix platforms.

On upgrade, the store validates and imports the previous JSON identity and all saved network files in one transaction. Original files are moved to `legacy-json-backup` only after the database commit succeeds; a failed import leaves them intact. These files are inert migration backups. Existing WebView recovery drafts are validated and imported once, without replacing a newer database draft, before their old storage entry is removed.

Discovery advertises only a protocol version, network ID, device ID, and an ephemeral TCP port. The shared secret is never advertised. Peers exchange length-bounded, XChaCha20-Poly1305 encrypted and authenticated Automerge snapshots over TCP. Protocol, network, and message direction are authenticated; invalid keys and malformed documents are rejected. File metadata uses independent Automerge records with deletion tombstones. File contents use a separate authenticated exchange, with SHA-256 and size validation before storing bytes in SQLite; binary contents do not inflate note history. At most two outgoing downloads and two incoming file transfers run at once, independently of note synchronization. Older Murmur versions can continue exchanging notes but need an update to show files. Snapshot exchange is intentionally simple for a small notebook. CRDT merging makes duplicates and old snapshots harmless.

Synchronization retries every five seconds, after edits/discovery, and when the app returns to the foreground. Discovery refreshes peer addresses after network changes. Temporary failure leaves local notes usable.

## MVP boundaries

- Sync is designed for apps open in the foreground. iOS and Android can suspend background work; reopen Murmur to reconnect.
- Both devices must share a LAN that permits mDNS and direct peer connections. Guest Wi-Fi/client isolation can block them. There is no Internet fallback.
- Maximum 2,000 combined note/file history entries including deletion tombstones (at most 500 files), 128 KiB per note body, 1 KiB per title, and 8 MiB of Automerge history per network. Full history is retained; there is no compaction/export UI.
- Notes and secrets use the OS app sandbox and private file permissions. They are not separately encrypted at rest. Android automatic app backup is disabled. Device-level access and OS backups are outside the peer encryption boundary.
- Changing networks keeps an archive but there is no network picker; keep invitations to return.
- The browser preview is not a peer and does not use the Rust CRDT store.

## Checks

```sh
npm run build
npm test
npm run test:ui
swift test --package-path src-tauri/apple-share -j 2
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-deps -- -D warnings
```

The Rust suite exercises SQLite migration and rollback, private file permissions, durable drafts, atomic draft cleanup, concurrent edits, word/QR invitation compatibility, shared files, incoming handoff validation and receipts, authenticated encryption, loopback TCP exchange, reconnect, and automatic sync. Playwright covers responsive and short-height keyboard layouts, themes, camera lifecycle, word invitations, file actions, incoming-share retries/discard, late typing, recovery gates, runtime validation, and the temporary browser preview. Swift tests exercise the extension SQLite queue. Native IPC mocks cover UI failure cases; Rust and Swift tests verify the actual databases. If Chromium is missing, run `npx playwright install chromium`.

Safety rules apply to Murmur's own Rust and TypeScript code. Both Rust crates forbid `unsafe` code and `as` conversions; numeric conversions are checked or lossless. TypeScript uses strict indexed and optional-property checking, runtime validation of IPC and parsed data, and type-aware ESLint rules that reject `any`, assertions, non-null assertions, and implicit value coercions. `npm run build` runs these checks, and CI also runs Clippy for desktop and Android code. Dependencies retain their own implementations, including Diesel/SQLite's native internals.

Local release builds and GitHub Actions run `scripts/check-android-scanner.py` against the signed APK before distribution. It checks that the release retains the manifest-discovered ML Kit constructors and includes its offline models. Version 0.1.1 fixes a release-only camera crash caused by R8 removing those constructors; the check rejects the affected 0.1.0 APK.

Test the **signed release APK** on an unlocked, disposable English-language Android emulator with a back camera using `python3 scripts/test-android-scanner.py --serial emulator-5580 --apk out/Murmur-android-universal.apk`. This installs an update without clearing notes, resets camera permission, grants it through the system dialog, checks that the bundled detector initializes and the camera streams while the app stays alive, and cancels/reopens the scanner. It rejects physical devices and debuggable APKs, and does not print notebook contents or raw logs. This catches release-only shrinking failures that browser and debug-build tests cannot cover.

Verified locally on November 15, 2026 for version 0.3.0: production frontend build, strict TypeScript checks, **44 Rust tests**, **50 Playwright tests**, **5 Swift queue tests**, and strict desktop/Android Clippy. The final signed ARM64/ARMv7 Android APK passed its offline-scanner checks. The Apple Silicon app and embedded share extension passed signature verification, and the DMG passed checksum verification. The unsigned iOS archive contains the current frontend and native inbox bridge, with the share extension embedded for iPhone and iPad.

Native Android acceptance used the signed release APK and the system Files app: sharing a PNG launched a stopped Murmur and imported it, while sharing a PDF to an already running Murmur used the existing activity. A mixed PNG/PDF share imported both files; relaunch retained them without duplicates. A 26 MiB file was rejected without a delayed import. The picture preview rendered, and exporting the shared PDF through the native save picker preserved its SHA-256 exactly. The landscape keyboard check kept the final typed line, caret, and editor controls visible above the keyboard.

macOS Share-menu registration/activation and physical iOS sharing remain unverified. Physical iOS camera, LAN discovery, and App Group access also require device testing; compiling the extension does not establish those behaviors.

For physical-device acceptance, run the two-phone flow above on Android ↔ iOS, deny and then grant LAN/camera permissions, toggle Wi-Fi, background/foreground both apps, and restart both with notes saved. Also share a picture and PDF from another app with Murmur both closed and already open, confirm a queued share survives without a network, and check retry/discard behavior after a rejected import. Simulator and loopback tests cannot establish that a particular Wi-Fi network permits Bonjour or that physical camera scanning works.

## Layout

- `src/main.ts`, `bridge.ts`, `types.ts`, and `validation.ts`: interface, note recovery, incoming-share queue actions, and validated native IPC.
- `src/files.ts`, `theme.ts`, and `invitations.ts`: bounded image thumbnails, appearance, and preview word-invitation compatibility.
- `src/file-preview.ts` and `markdown.ts`: local media/text previews with cleanup, file type detection, and sanitized Markdown rendering for notes and files.
- `src/clipboard.ts` and `src-tauri/src/clipboard.rs`: image clipboard actions, PNG conversion, and native desktop clipboard integration; Android/iOS use their existing `ShareInboxPlugin` bridges.
- `native.ts`: discovery lifecycle and peer events.
- `src-tauri/src/engine.rs`: Automerge document and durable local store.
- `src-tauri/src/storage.rs`, `schema.rs`, and `migrations/`: Diesel SQLite storage and schema migrations.
- `src-tauri/src/files.rs`: shared-file metadata, hashing, and limits.
- `src-tauri/src/invitations.rs`: checksummed word invitations and backward-compatible network identities.
- `src-tauri/src/incoming.rs`, `native_shares.rs`, and `apple_shares.rs`: validated native handoffs, pending batches, and duplicate-delivery receipts.
- `src-tauri/migrations/2026-11-15-000003_incoming_shares/`: pending-share and receipt tables.
- `src-tauri/gen/android/app/src/main/java/app/murmur/notes/IncomingShares.kt` and `ShareInboxPlugin.kt`: Android share receiver and SQLite staging inbox.
- `src-tauri/apple-share/`: iOS/macOS extension controllers, shared Swift SQLite queue/loader, entitlements, and tests.
- `src-tauri/plugins/lan/ios/Sources/ShareInboxPlugin.swift`: iOS App Group inbox location.
- `scripts/build-macos-share.sh`: extension embedding and nested signing.
- `src-tauri/src/appearance.rs` and Android `AppearancePlugin.kt`: native system-bar appearance.
- `tests/incoming-shares.spec.ts`, `desktop-scanner.spec.ts`, `invitations.spec.ts`, and `ux.spec.ts`: share, camera, invitation, and responsive UI regressions.
- `src/desktop-scanner.ts`: bounded local camera decoding and camera lifecycle management.
- `src-tauri/src/transport.rs`: encrypted note/file peer protocol and retries.
- `src-tauri/plugins/lan/`: native Android/iOS discovery and desktop fallback.
- `src-tauri/Info.ios.plist`: camera and Bonjour privacy declarations.

API references: [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/), [barcode scanner](https://v2.tauri.app/plugin/barcode-scanner/), [bundled Android detector](https://developers.google.com/ml-kit/vision/barcode-scanning/android), [Automerge](https://docs.rs/automerge/0.12.0/automerge/).
