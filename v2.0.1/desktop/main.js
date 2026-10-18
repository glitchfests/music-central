// Music Central for Windows: runs the web app (../web) in its own window.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const APP_ID = 'com.glitchfests.musiccentral';

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');

// Serve the app from app://music-central/ so it gets a stable, secure origin:
// playlists and downloads (IndexedDB) stay put between launches.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

if (!app.requestSingleInstanceLock()) app.quit();

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b0f0c',
    title: 'Music Central',
    autoHideMenuBar: true,
    icon: path.join(WEB_DIR, 'icons', 'icon.svg'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL('app://music-central/index.html');

  // Links to outside pages (artist pages, licenses) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(WEB_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(WEB_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(null);

  // YouTube's embedded player needs to know which app is embedding it. Its rules for desktop
  // apps say to send the app ID as an HTTPS Referer.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] },
    (details, cb) => {
      details.requestHeaders.Referer = `https://${APP_ID}/`;
      cb({ requestHeaders: details.requestHeaders });
    });

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ----- Sign-in through the browser (Spotify) -----
// Listens once on 127.0.0.1 (on `port`, or any free port if 0), opens the sign-in page in the
// normal browser and returns the query string the service redirects back with.
ipcMain.handle('oauth:loopback', (_e, url, port = 0) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body style="font-family:sans-serif;background:#0b0f0c;color:#eef3ef;text-align:center;padding:40px">'
      + `<h2>${u.searchParams.has('error') ? 'Sign-in cancelled' : 'Signed in'}</h2><p>You can close this tab and go back to Music Central.</p></body>`);
    clearTimeout(timer);
    server.close();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    resolve({ query: u.search.slice(1), redirectUri });
  });
  let redirectUri;
  const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out')); }, 5 * 60 * 1000);
  server.on('error', err => {
    clearTimeout(timer);
    reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is busy. Close other sign-in windows or apps using it and try again.`) : err);
  });
  server.listen(port, '127.0.0.1', () => {
    redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    shell.openExternal(url.replace('{REDIRECT}', encodeURIComponent(redirectUri)));
  });
}));

// ----- Updates -----
// Downloads the new installer, starts it and quits so it can replace this version.
ipcMain.handle('update:install', async (e, url) => {
  if (!/^https:\/\//.test(url)) throw new Error('Bad update address');
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = path.join(os.tmpdir(), `MusicCentral-Setup-${Date.now()}.exe`);
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0, last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
    got += value.length;
    const pct = total ? Math.floor(got / total * 100) : -1;
    if (pct !== last) { last = pct; e.sender.send('update:progress', pct); }
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 500);
});
