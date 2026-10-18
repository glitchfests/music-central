# Music Central v2.1.0

Installers are in [`builds/`](builds/): `MusicCentral-Setup-2.1.0.exe` (Windows) and `MusicCentral-2.1.0.apk` (Android).
They install over any earlier version and keep your playlists and downloads.

## New in 2.1.0: Spotify songs play inside Music Central (Premium)
- **Windows:** Music Central is now its own Spotify player (Spotify's Web Playback SDK), so Spotify songs play in the
  app's player and queue, mixed with your other music, and keep playing when the window is minimised. This needs
  Widevine copy protection, so the Windows app is now built on castLabs Electron. See "Windows: castLabs signing" below.
- **Android:** the Spotify app plays in the background (Spotify App Remote SDK) while you stay in Music Central and use
  its player, queue and notification. The Spotify app must be installed and logged in.
- **After updating:** in Settings → Spotify, press **Disconnect** then **Connect Spotify** once. Playing songs needs a
  permission the old sign-in didn't ask for.
- **Spotify dashboard (Android only):** in your Spotify developer app, tick **Android** and add package name
  `com.glitchfests.musiccentral` with SHA1 fingerprint `84:11:19:84:1B:99:F4:41:68:C7:9B:DA:D6:43:DA:C6:6D:A2:E2:77`.
- If in-app playback doesn't work on a device, Spotify songs play on your Spotify device instead, as in 2.0.
- **YouTube on Windows** keeps playing when the window is minimised. On Android, YouTube still pauses in the background
  (YouTube only allows that in its own apps).

## Windows: castLabs signing
Spotify's copy protection (Widevine) only gives full-song licences to apps registered with castLabs' free EVS service.
This build is **not registered yet**, so on Windows Spotify may refuse to play and the app falls back to your Spotify
device. To register it:
1. Create a free account: install Python, then run `pip install castlabs-evs` and `python -m castlabs_evs.account signup`
   (it emails you a confirmation code).
2. Either sign the installed app yourself after each install or update:
   `python -m castlabs_evs.vmp sign-pkg "%LOCALAPPDATA%\Programs\Music Central"`,
   or add `EVS_ACCOUNT_NAME` and `EVS_PASSWD` to the build environment's secrets, and the build signs it automatically
   (`desktop/evs-sign.js`).

## Earlier changes (2.0.x)
- **2.0.1:** the Spotify redirect address has a port: `http://127.0.0.1:43821/callback`.
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

- **Spotify** redirect URI to register: `http://127.0.0.1:43821/callback`. Spotify requires the account that creates the
  developer app to have Premium, allows up to 5 users, and only shows playlists you created or collaborate on.
- **YouTube** needs a Google Cloud project with the YouTube Data API v3 enabled and an OAuth client of type
  "TVs and Limited Input devices". Signing in shows a code you enter at google.com/device.

Spotify and YouTube music can't be downloaded: both services forbid it. That's what free copies are for.

## Updates
The app reads `latest.json` from this repository's `main` branch. **The repository must be public**
for this to work (the app has no GitHub login). To publish a new version: put its installers in `vX.Y.Z/builds/` and
update `latest.json`.

## Folders
| Folder | What it is |
|---|---|
| `web/` | The app itself. `native.js` talks to Windows/Android, `accounts.js` is Spotify + YouTube, `updates.js` the update check. |
| `desktop/` | Windows app (castLabs Electron, for Widevine). `preload.js` adds browser sign-in and installing updates; `evs-sign.js` registers the build with castLabs EVS when an account is configured. |
| `android-app/` | Android app (Capacitor). `MediaControlsPlugin.java` + `PlaybackService.java` do background playback, sign-in and updates; `SpotifyRemotePlugin.java` controls the Spotify app (SDK in `android/app/libs`). The signing key (`signing/`) is not in git. |
| `resources/` | Icon and splash images. |
| `builds/` | The finished installers. |

## Rebuilding
Same as 1.1.0: `cd desktop && npm install && npm run build:win`, and `cd android-app && npm install && npm run build:apk`
(with the signing key files in `android-app/signing/`).
