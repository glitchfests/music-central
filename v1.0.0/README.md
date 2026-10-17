# Music Central v1.0.0

An installable web app (PWA) for phone and computer.

## Features
- **Search** Internet Archive (concerts, netlabels, public domain), Audius (independent artists) and Jamendo (Creative Commons).
- **Playlists**: create, rename, reorder, delete. Add songs with the ⋯ button, or a whole album at once.
- **Offline**: press ⬇ to download a song, or "Download all" on a playlist or album. Downloads play with no internet, and the app itself opens offline.
  Audius songs can only be downloaded when the artist allows it.
- **Your own files**: Library → Import music files (MP3, M4A, FLAC, OGG, WAV).
- **Player**: queue, play next, shuffle, repeat one/all, lock-screen controls, space bar to play/pause.

Everything (playlists, downloads, imports) is stored on your device, in the browser you use.

## Run it
It needs to be served over `http://localhost` or `https://` (not opened as a file), so offline mode works:

```
cd v1.0.0
python3 -m http.server 8000
```

Then open http://localhost:8000. To use it on your phone, host the folder on any HTTPS static host
(for example GitHub Pages or Netlify), open it on the phone and choose "Install app" / "Add to Home Screen".

## Jamendo
Jamendo search needs a free Client ID: sign up at https://devportal.jamendo.com/, create an app,
and paste the Client ID in Settings. The other two sources work without setup.
