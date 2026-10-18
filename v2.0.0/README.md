# Music Central v2.0.0

Installers are in [`builds/`](builds/): `MusicCentral-Setup-2.0.0.exe` (Windows) and `MusicCentral-2.0.0.apk` (Android).
Install them the same way as 1.1.0 (see [v1.1.0/README.md](../v1.1.0/README.md)). Both install over 1.1.0 and keep your
playlists and downloads.

## What's new
- **Android keeps playing in the background**, with a media notification and lock-screen, headphone and Bluetooth controls.
  The first time you play something, Android asks to allow notifications. Say yes to get the controls.
- **Spotify**: connect your account (Settings → Spotify) to see your playlists and Liked Songs, search Spotify, copy
  playlists into Music Central, and play songs in your Spotify app (Premium).
- **YouTube**: connect your account (Settings → YouTube) to see your playlists and liked videos, search YouTube, copy
  playlists into Music Central, and play videos in the app's video player.
- **Free copies**: on a Spotify or YouTube song, ⌕ (or ⋯ → Find free copy) looks for a free, downloadable version on
  Audius and Jamendo. Link one, and the song plays and downloads as that copy.
- **Check for updates**: Settings → Updates, plus a quiet daily check when the app opens.

## Setting up Spotify and YouTube
Both services need you to create a free developer key once. The steps are in the app, under Settings → Spotify and
Settings → YouTube ("How to get a Client ID").

- **Spotify** redirect URI to register: `http://127.0.0.1/callback`. Spotify requires the account that creates the
  developer app to have Premium, allows up to 5 users, and only shows playlists you created or collaborate on.
- **YouTube** needs a Google Cloud project with the YouTube Data API v3 enabled and an OAuth client of type
  "TVs and Limited Input devices". Signing in shows a code you enter at google.com/device.

Spotify and YouTube music can't be downloaded: both services forbid it. That's what free copies are for.

## Updates
The app reads [`latest.json`](../latest.json) from this repository's default branch. **The repository must be public**
for this to work (the app has no GitHub login). To publish a new version: put its installers in `vX.Y.Z/builds/` and
update `latest.json`.

## Folders
| Folder | What it is |
|---|---|
| `web/` | The app itself. `native.js` talks to Windows/Android, `accounts.js` is Spotify + YouTube, `updates.js` the update check. |
| `desktop/` | Windows app (Electron). `preload.js` adds browser sign-in and installing updates. |
| `android-app/` | Android app (Capacitor). `MediaControlsPlugin.java` + `PlaybackService.java` do background playback, sign-in and updates. The signing key (`signing/`) is not in git. |
| `resources/` | Icon and splash images. |
| `builds/` | The finished installers. |

## Rebuilding
Same as 1.1.0: `cd desktop && npm install && npm run build:win`, and `cd android-app && npm install && npm run build:apk`
(with the signing key files in `android-app/signing/`).
