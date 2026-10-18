// Music Central: what the installed apps add on top of the browser.
// Windows (Electron) exposes window.MCNative from its preload script; Android (Capacitor)
// has the MediaControls plugin. In a plain browser every feature here quietly does nothing.
'use strict';

const Native = (() => {
  const electron = window.MCNative || null;
  const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
  const plugin = cap ? cap.registerPlugin('MediaControls') : null;
  const spotify = cap ? cap.registerPlugin('SpotifyRemote') : null;
  const platform = electron ? 'windows' : cap ? 'android' : '';

  return {
    platform,

    // Browser sign-in that comes back to http://127.0.0.1:<port>/callback (port 0 = any free port).
    // `url` contains {REDIRECT} where the encoded redirect address goes.
    canLoopbackAuth: !!(electron || plugin),
    loopbackAuth(url, port = 0) {
      if (electron) return electron.loopbackAuth(url, port);
      if (plugin) return plugin.loopbackAuth({ url, port });
      return Promise.reject(new Error('Not available in the browser'));
    },

    canInstallUpdates: !!(electron || plugin),
    installUpdate(url, onProgress) {
      if (electron) {
        electron.onUpdateProgress(onProgress);
        return electron.installUpdate(url);
      }
      if (plugin) {
        const sub = plugin.addListener('updateProgress', e => onProgress(e.percent));
        return plugin.installUpdate({ url }).finally(() => Promise.resolve(sub).then(s => s.remove()));
      }
      return Promise.reject(new Error('Not available in the browser'));
    },

    // Android: Spotify songs play through the Spotify app in the background (App Remote SDK).
    spotifyRemote: spotify && {
      isInstalled: () => spotify.isInstalled().then(r => r.installed),
      connect: (clientId, redirectUri) => spotify.connect({ clientId, redirectUri }),
      play: uri => spotify.play({ uri }),
      pause: () => spotify.pause(),
      resume: () => spotify.resume(),
      seek: sec => spotify.seek({ position: sec }),
      onState: fn => spotify.addListener('state', fn),
      onDisconnected: fn => spotify.addListener('disconnected', fn),
    },

    // Android media notification / lock screen. Windows gets this from navigator.mediaSession.
    media: {
      update(s) { if (plugin) plugin.update(s).catch(() => {}); },
      clear() { if (plugin) plugin.clear().catch(() => {}); },
      onAction(fn) { if (plugin) plugin.addListener('action', fn); },
    },
  };
})();
