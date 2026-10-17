# Music Central v1.1.0

Music Central as installable apps for **Windows** and **Android**. No server needed.

## Install

The ready-made installers are in [`builds/`](builds/).

### Windows: `MusicCentral-Setup-1.1.0.exe`
1. Download it and double-click it.
2. Windows SmartScreen may say "Windows protected your PC", because the installer isn't signed with a paid certificate.
   Click **More info → Run anyway**.
3. Choose where to install, then open **Music Central** from the Start menu or the desktop shortcut.

Uninstall it from Settings → Apps like any other program. Your playlists and downloads are kept unless you delete
`%APPDATA%\Music Central`.

### Android: `MusicCentral-1.1.0.apk`
1. Copy the file to your phone (or download it there) and tap it.
2. Android asks to allow installing apps from that source (your browser or Files app). Allow it, go back, and tap **Install**.
3. Play Protect may warn that it doesn't recognise the app. Tap **More details → Install anyway**.

Later versions are signed with the same key, so they install over this one and keep your playlists and downloads.

## What's new in 1.1.0
- Windows app (installer with Start menu and desktop shortcuts).
- Android app (APK).
- Links to artist pages and licenses open in your normal browser.
- Everything from 1.0.0: search Internet Archive, Audius and Jamendo, playlists, offline downloads, importing your own files.

## Folders
| Folder | What it is |
|---|---|
| `web/` | The app itself (shared by both builds; also still works as a website). |
| `desktop/` | Windows app (Electron). |
| `android-app/` | Android app (Capacitor). The signing key (`signing/`) is not in git: keep your copy safe. |
| `resources/` | Icon and splash images. |
| `builds/` | The finished installers. |

## Rebuilding
- **Windows** (on Windows, or Linux with Wine): `cd desktop && npm install && npm run build:win` → `desktop/dist/`
- **Android** (needs JDK 21 and the Android SDK): `cd android-app && npm install && npm run build:apk`
  → `android-app/android/app/build/outputs/apk/release/app-release.apk`

### Android signing key
The APK is signed with `android-app/signing/music-central.jks` and its `keystore.properties`. These are kept out of git
on purpose. Keep your copy somewhere safe, and put both files back in `android-app/signing/` before building a new
version. Without that same key, a new version can't install over the old one: you'd have to uninstall first and
would lose your downloads.
