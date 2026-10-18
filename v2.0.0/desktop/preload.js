// Gives the web app a few Windows-only abilities, without exposing Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MCNative', {
  platform: 'windows',
  // Opens url ({REDIRECT} replaced by a one-time http://127.0.0.1 address) in the browser; resolves with the redirect's query.
  loopbackAuth: url => ipcRenderer.invoke('oauth:loopback', url),
  installUpdate: url => ipcRenderer.invoke('update:install', url),
  onUpdateProgress: cb => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),
});
