// Music Central v1.1.0
// Searches free, legal music sources, keeps playlists on this device and
// saves tracks to IndexedDB for offline listening.
'use strict';

const APP_NAME = 'MusicCentral';
const APP_VERSION = '1.1.0';
// Set when running as the installed Windows (Electron) or Android (Capacitor) app.
const NATIVE = /Electron/.test(navigator.userAgent) ? 'windows' : window.Capacitor?.isNativePlatform?.() ? 'android' : '';
const $ = sel => document.querySelector(sel);
const main = $('#main');
const audio = $('#audio');

// ---------- Small helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Internet Archive lengths come as "mm:ss", "h:mm:ss" or seconds.
function parseLength(v) {
  if (!v) return 0;
  if (String(v).includes(':')) return String(v).split(':').reduce((a, n) => a * 60 + Number(n), 0);
  return Number(v) || 0;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Opens a web page in the system browser rather than inside the app.
function openExternal(url) {
  if (NATIVE === 'android') location.href = url; // Capacitor hands outside links to the browser
  else window.open(url, '_blank', 'noopener');
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const settings = {
  get(k, d) { try { const v = localStorage.getItem('mc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- Database (IndexedDB) ----------
// tracks:    track info, for anything in a playlist, downloaded or imported
// blobs:     the audio itself for downloaded and imported tracks, keyed by track id
// playlists: { id, name, trackIds, created }

const db = {
  conn: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('music-central', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('tracks', { keyPath: 'id' });
        d.createObjectStore('blobs');
        d.createObjectStore('playlists', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.conn = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.conn.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  get: (s, k) => db.run(s, 'readonly', st => st.get(k)),
  all: s => db.run(s, 'readonly', st => st.getAll()),
  keys: s => db.run(s, 'readonly', st => st.getAllKeys()),
  put: (s, v, k) => db.run(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
  del: (s, k) => db.run(s, 'readwrite', st => st.delete(k)),
};

// ---------- App state ----------

const state = {
  playlists: [],          // sorted by creation
  downloaded: new Set(),  // track ids that have audio saved on this device
  downloading: new Map(), // track id -> percent
  known: new Map(),       // every track the app has seen this session, by id
  lists: new Map(),       // rendered track lists, so a click knows its context
  search: { q: '', source: 'all', results: null, loading: false },
};

function remember(t) {
  const prev = state.known.get(t.id);
  state.known.set(t.id, prev ? { ...prev, ...t } : t);
  return state.known.get(t.id);
}

async function saveTrack(t) {
  remember(t);
  await db.put('tracks', t);
}

async function loadPlaylists() {
  state.playlists = (await db.all('playlists')).sort((a, b) => a.created - b.created);
}

// ---------- Music sources ----------
// Each source returns tracks shaped as:
// { id, source, title, artist, album, duration, art, streamUrl, downloadUrl, downloadable, pageUrl, license }

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const sources = {
  archive: {
    label: 'Internet Archive',
    // Returns albums (archive "items"); their tracks load when one is opened.
    async search(q) {
      const query = `(${q}) AND mediatype:(audio) AND (collection:(etree) OR collection:(opensource_audio) OR collection:(netlabels) OR collection:(audio_music))`;
      const p = new URLSearchParams({ q: query, rows: '24', output: 'json', sort: 'downloads desc' });
      ['identifier', 'title', 'creator', 'year'].forEach(f => p.append('fl[]', f));
      const d = await getJSON(`https://archive.org/advancedsearch.php?${p}`);
      return d.response.docs.map(x => ({
        id: x.identifier,
        title: Array.isArray(x.title) ? x.title[0] : x.title || x.identifier,
        artist: Array.isArray(x.creator) ? x.creator.join(', ') : x.creator || 'Unknown artist',
        year: x.year || '',
        art: `https://archive.org/services/img/${encodeURIComponent(x.identifier)}`,
      }));
    },
    async album(identifier) {
      const d = await getJSON(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      const meta = d.metadata || {};
      const album = Array.isArray(meta.title) ? meta.title[0] : meta.title || identifier;
      const albumArtist = Array.isArray(meta.creator) ? meta.creator.join(', ') : meta.creator || 'Unknown artist';
      const art = `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
      const files = (d.files || []).filter(f => /mp3/i.test(f.format || '') && !/zip/i.test(f.format || ''));
      // Prefer one MP3 per original recording.
      const seen = new Set();
      const picked = files.filter(f => {
        const key = f.original || f.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      picked.sort((a, b) => (Number(a.track) || 0) - (Number(b.track) || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      const path = n => n.split('/').map(encodeURIComponent).join('/');
      const tracks = picked.map(f => {
        const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${path(f.name)}`;
        return remember({
          id: `archive:${identifier}/${f.name}`,
          source: 'archive',
          title: f.title || f.name.replace(/\.[^.]+$/, '').split('/').pop(),
          artist: f.creator || f.artist || albumArtist,
          album,
          duration: parseLength(f.length),
          art,
          streamUrl: url,
          downloadUrl: url,
          downloadable: true,
          pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
          license: meta.licenseurl || '',
        });
      });
      return { identifier, album, artist: albumArtist, art, year: meta.year || meta.date || '', description: meta.description || '', tracks };
    },
  },

  audius: {
    label: 'Audius',
    host: null,
    async getHost() {
      if (!this.host) {
        try { this.host = (await getJSON('https://api.audius.co')).data[0]; } catch { this.host = 'https://api.audius.co'; }
      }
      return this.host;
    },
    async search(q) {
      const host = await this.getHost();
      const d = await getJSON(`${host}/v1/tracks/search?${new URLSearchParams({ query: q, app_name: APP_NAME, limit: '30' })}`);
      return d.data.filter(t => t.is_streamable !== false).map(t => {
        const stream = `${host}/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=${APP_NAME}`;
        return remember({
          id: `audius:${t.id}`,
          source: 'audius',
          title: t.title,
          artist: t.user?.name || 'Unknown artist',
          album: '',
          duration: t.duration || 0,
          art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
          streamUrl: stream,
          // Only offer downloads when the artist has allowed them.
          downloadUrl: stream,
          downloadable: !!t.is_downloadable,
          pageUrl: t.permalink ? `https://audius.co${t.permalink}` : 'https://audius.co',
          license: t.license || '',
        });
      });
    },
  },

  jamendo: {
    label: 'Jamendo',
    async search(q) {
      const clientId = settings.get('jamendoId', '');
      if (!clientId) throw Object.assign(new Error('Add a free Jamendo client ID in Settings to search Jamendo.'), { setup: true });
      const p = new URLSearchParams({ client_id: clientId, format: 'json', limit: '30', search: q, audioformat: 'mp32', include: 'musicinfo' });
      const d = await getJSON(`https://api.jamendo.com/v3.0/tracks/?${p}`);
      if (d.headers?.status !== 'success') throw new Error(d.headers?.error_message || 'Jamendo search failed');
      return d.results.map(t => remember({
        id: `jamendo:${t.id}`,
        source: 'jamendo',
        title: t.name,
        artist: t.artist_name,
        album: t.album_name || '',
        duration: t.duration || 0,
        art: t.image || t.album_image || '',
        streamUrl: t.audio,
        downloadUrl: t.audiodownload || t.audio,
        downloadable: t.audiodownload_allowed !== false,
        pageUrl: t.shareurl || 'https://www.jamendo.com',
        license: t.license_ccurl || '',
      }));
    },
  },
};

const SOURCE_LABEL = { archive: 'Internet Archive', audius: 'Audius', jamendo: 'Jamendo', local: 'My files' };

// ---------- Downloads ----------

async function download(id) {
  const t = state.known.get(id);
  if (!t || state.downloaded.has(id) || state.downloading.has(id)) return;
  if (!t.downloadable) return toast('The artist has not allowed downloads for this track');
  if (!navigator.onLine) return toast("You're offline");
  state.downloading.set(id, 0);
  refreshTrackRows(id);
  try {
    let res = await fetch(t.downloadUrl || t.streamUrl);
    if (!res.ok && t.downloadUrl !== t.streamUrl) res = await fetch(t.streamUrl);
    if (!res.ok) throw new Error(`${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, lastPaint = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total && Date.now() - lastPaint > 250) {
        state.downloading.set(id, Math.round(got / total * 100));
        refreshTrackRows(id);
        lastPaint = Date.now();
      }
    }
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
    await saveTrack(t);
    await db.put('blobs', blob, id);
    state.downloaded.add(id);
    toast(`Downloaded "${t.title}"`);
  } catch (err) {
    toast(`Download failed: ${err.message}`);
  } finally {
    state.downloading.delete(id);
    refreshTrackRows(id);
  }
}

async function removeDownload(id) {
  const t = state.known.get(id);
  if (t?.source === 'local' && !confirm(`"${t.title}" is an imported file. Remove it from this device? It will also leave your playlists.`)) return;
  await db.del('blobs', id);
  state.downloaded.delete(id);
  if (t?.source === 'local') {
    await db.del('tracks', id);
    for (const p of state.playlists) {
      if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); await db.put('playlists', p); }
    }
  }
  toast('Removed from this device');
  render();
}

async function downloadMany(ids) {
  const todo = ids.filter(id => !state.downloaded.has(id) && state.known.get(id)?.downloadable);
  if (!todo.length) return toast('Nothing new to download');
  toast(`Downloading ${todo.length} track${todo.length > 1 ? 's' : ''}…`);
  for (const id of todo) await download(id);
}

// ---------- Importing your own files ----------

async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name)) continue;
    const base = f.name.replace(/\.[^.]+$/, '');
    const dash = base.indexOf(' - ');
    const id = `local:${uid()}`;
    const t = {
      id, source: 'local',
      title: dash > 0 ? base.slice(dash + 3) : base,
      artist: dash > 0 ? base.slice(0, dash) : 'My files',
      album: '', duration: await probeDuration(f), art: '',
      streamUrl: '', downloadUrl: '', downloadable: true, pageUrl: '', license: '',
      added: Date.now(),
    };
    await saveTrack(t);
    await db.put('blobs', f, id);
    state.downloaded.add(id);
    n++;
  }
  toast(n ? `Imported ${n} file${n > 1 ? 's' : ''}` : 'No audio files found');
  render();
}

function probeDuration(file) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); resolve(d); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

// ---------- Playlists ----------

async function createPlaylist(name) {
  name = (name ?? prompt('Playlist name', `My playlist #${state.playlists.length + 1}`))?.trim();
  if (!name) return null;
  const p = { id: uid(), name, trackIds: [], created: Date.now() };
  await db.put('playlists', p);
  state.playlists.push(p);
  return p;
}

async function addToPlaylist(pid, ids) {
  const p = state.playlists.find(x => x.id === pid);
  if (!p) return;
  const fresh = ids.filter(id => !p.trackIds.includes(id));
  for (const id of fresh) await saveTrack(state.known.get(id));
  p.trackIds.push(...fresh);
  await db.put('playlists', p);
  toast(fresh.length ? `Added to ${p.name}` : `Already in ${p.name}`);
}

async function playlistTracks(p) {
  const out = [];
  for (const id of p.trackIds) {
    const t = state.known.get(id) || await db.get('tracks', id);
    if (t) out.push(remember(t));
  }
  return out;
}

// ---------- Player ----------

const player = {
  queue: [],      // track objects
  order: [],      // indices into queue, shuffled or not
  pos: -1,        // position in order
  shuffle: settings.get('shuffle', false),
  repeat: settings.get('repeat', 'off'), // off | all | one
  objectUrl: null,

  get current() { return this.queue[this.order[this.pos]] || null; },

  setQueue(tracks, startIndex = 0) {
    this.queue = tracks.slice();
    this.buildOrder(startIndex);
    this.load();
  },

  buildOrder(startIndex) {
    const idx = this.queue.map((_, i) => i);
    if (this.shuffle) {
      idx.splice(idx.indexOf(startIndex), 1);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      idx.unshift(startIndex);
      this.order = idx;
      this.pos = 0;
    } else {
      this.order = idx;
      this.pos = startIndex;
    }
  },

  async load(autoplay = true) {
    const t = this.current;
    if (!t) return;
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    let src = '';
    if (state.downloaded.has(t.id)) {
      const blob = await db.get('blobs', t.id);
      if (blob) { this.objectUrl = URL.createObjectURL(blob); src = this.objectUrl; }
    }
    if (!src) {
      if (!navigator.onLine) {
        toast(`"${t.title}" isn't downloaded. Skipping.`);
        return this.skipOfflineFrom(this.pos);
      }
      src = t.streamUrl;
    }
    audio.src = src;
    updateNowPlaying();
    if (autoplay) audio.play().catch(() => {});
  },

  // When offline, jump to the next downloaded track instead of stopping.
  skipOfflineFrom(pos) {
    for (let i = 1; i <= this.order.length; i++) {
      const p = (pos + i) % this.order.length;
      if (p <= pos && this.repeat === 'off') break;
      if (state.downloaded.has(this.queue[this.order[p]].id)) { this.pos = p; return this.load(); }
    }
    toast('No downloaded tracks left in the queue');
  },

  toggle() {
    if (!this.current) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    if (this.pos < this.order.length - 1) this.pos++;
    else if (this.repeat !== 'off') this.pos = 0;
    else { if (!auto) toast('End of queue'); return; }
    this.load();
  },

  prev() {
    if (!this.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (this.pos > 0) this.pos--;
    else if (this.repeat !== 'off') this.pos = this.order.length - 1;
    this.load();
  },

  playNext(t) {
    if (!this.current) return this.setQueue([t]);
    this.queue.push(t);
    this.order.splice(this.pos + 1, 0, this.queue.length - 1);
    toast('Playing next');
    renderQueue();
  },

  addToQueue(t) {
    if (!this.current) return this.setQueue([t]);
    this.queue.push(t);
    this.order.push(this.queue.length - 1);
    toast('Added to queue');
    renderQueue();
  },

  setShuffle(on) {
    this.shuffle = on;
    settings.set('shuffle', on);
    if (this.current) this.buildOrder(this.order[this.pos]);
    updateModeButtons();
    renderQueue();
  },

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    settings.set('repeat', this.repeat);
    updateModeButtons();
    toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[this.repeat]);
  },
};

function updateNowPlaying() {
  const t = player.current;
  $('#npTitle').textContent = t ? t.title : 'Nothing playing';
  $('#npArtist').textContent = t ? t.artist : 'Search for something to play';
  $('#npArt').src = t?.art || 'icons/icon.svg';
  $('#npArt').onerror = () => { $('#npArt').onerror = null; $('#npArt').src = 'icons/icon.svg'; };
  document.title = t ? `${t.title} · ${t.artist}` : 'Music Central';
  document.querySelectorAll('.track').forEach(el => el.classList.toggle('playing', el.dataset.id === t?.id));
  if (t && 'mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.art ? [{ src: t.art, sizes: '480x480' }] : [],
    });
  }
  renderQueue();
}

function updateModeButtons() {
  $('#btnShuffle').classList.toggle('on', player.shuffle);
  const r = $('#btnRepeat');
  r.classList.toggle('on', player.repeat !== 'off');
  r.textContent = player.repeat === 'one' ? '↻¹' : '↻';
  r.title = { off: 'Repeat', all: 'Repeat all', one: 'Repeat one' }[player.repeat];
}

function renderQueue() {
  const panel = $('#queuePanel');
  if (panel.hidden) return;
  const list = $('#queueList');
  list.innerHTML = player.order.length
    ? player.order.map((qi, p) => {
        const t = player.queue[qi];
        return `<li data-pos="${p}" class="${p === player.pos ? 'cur' : ''}">${esc(t.title)} <span class="small muted">· ${esc(t.artist)}</span></li>`;
      }).join('')
    : '<p class="muted">The queue is empty.</p>';
}

function setupPlayer() {
  const seek = $('#seek');
  let seeking = false;
  $('#btnPlay').onclick = () => player.toggle();
  $('#btnNext').onclick = () => player.next();
  $('#btnPrev').onclick = () => player.prev();
  $('#btnShuffle').onclick = () => player.setShuffle(!player.shuffle);
  $('#btnRepeat').onclick = () => player.cycleRepeat();
  $('#btnQueue').onclick = () => { const q = $('#queuePanel'); q.hidden = !q.hidden; renderQueue(); };
  $('#queueClose').onclick = () => { $('#queuePanel').hidden = true; };
  $('#queueList').onclick = e => {
    const li = e.target.closest('li[data-pos]');
    if (li) { player.pos = Number(li.dataset.pos); player.load(); }
  };

  const vol = $('#volume');
  vol.value = audio.volume = settings.get('volume', 1);
  vol.oninput = () => { audio.volume = vol.value; settings.set('volume', Number(vol.value)); };

  seek.oninput = () => { seeking = true; $('#tCur').textContent = fmtTime(seek.value / 1000 * (audio.duration || 0)); };
  seek.onchange = () => { if (isFinite(audio.duration)) audio.currentTime = seek.value / 1000 * audio.duration; seeking = false; };

  audio.ontimeupdate = () => {
    if (seeking || !isFinite(audio.duration)) return;
    seek.value = audio.currentTime / audio.duration * 1000 || 0;
    $('#tCur').textContent = fmtTime(audio.currentTime);
  };
  audio.onloadedmetadata = () => {
    $('#tDur').textContent = fmtTime(audio.duration);
    const t = player.current;
    if (t && !t.duration && isFinite(audio.duration)) { t.duration = audio.duration; if (state.downloaded.has(t.id)) db.put('tracks', t); }
  };
  audio.onplay = () => { $('#btnPlay').textContent = '❚❚'; $('#btnPlay').setAttribute('aria-label', 'Pause'); };
  audio.onpause = () => { $('#btnPlay').textContent = '▶'; $('#btnPlay').setAttribute('aria-label', 'Play'); };
  audio.onended = () => player.next(true);
  audio.onerror = () => { if (audio.getAttribute('src')) toast("Couldn't play this track"); };

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => audio.play());
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', () => player.prev());
    ms.setActionHandler('nexttrack', () => player.next());
  }

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  });
  updateModeButtons();
}

// ---------- Track rows ----------

function trackRow(t, listKey, index) {
  const dl = state.downloaded.has(t.id);
  const pct = state.downloading.get(t.id);
  let dlBtn = '';
  if (pct !== undefined) dlBtn = `<button class="icon-btn" disabled title="Downloading">${pct ? pct + '%' : '<span class="spinner"></span>'}</button>`;
  else if (dl) dlBtn = `<button class="icon-btn on" data-act="undl" title="Downloaded. Click to remove from device" aria-label="Remove download">✓</button>`;
  else if (t.downloadable) dlBtn = `<button class="icon-btn" data-act="dl" title="Download for offline" aria-label="Download">⬇</button>`;
  else dlBtn = `<button class="icon-btn" disabled title="The artist hasn't allowed downloads" aria-label="Download not allowed">⬇</button>`;
  const art = t.art ? `<img class="art" loading="lazy" src="${esc(t.art)}" alt="" onerror="this.onerror=null;this.src='icons/icon.svg'">` : '<img class="art" src="icons/icon.svg" alt="">';
  return `<li class="track${player.current?.id === t.id ? ' playing' : ''}" data-id="${esc(t.id)}" data-list="${listKey}" data-index="${index}">
    ${art}
    <div class="t-main" data-act="play">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-sub">${dl ? '<span class="badge dl">Offline</span>' : ''}<span class="badge">${esc(SOURCE_LABEL[t.source] || t.source)}</span>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div>
    </div>
    <span class="t-dur">${t.duration ? fmtTime(t.duration) : ''}</span>
    <div class="t-btns">${dlBtn}<button class="icon-btn" data-act="menu" aria-label="More options" title="More">⋯</button></div>
  </li>`;
}

function trackList(tracks, listKey, ctx = {}) {
  state.lists.set(listKey, { tracks, ...ctx });
  if (!tracks.length) return '';
  return `<ul class="tracks">${tracks.map((t, i) => trackRow(t, listKey, i)).join('')}</ul>`;
}

function refreshTrackRows(id) {
  document.querySelectorAll(`.track[data-id="${CSS.escape(id)}"]`).forEach(el => {
    const t = state.known.get(id);
    if (!t) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = trackRow(t, el.dataset.list, el.dataset.index);
    el.replaceWith(tmp.firstElementChild);
  });
}

main.addEventListener('click', e => {
  const link = e.target.closest('a[target=_blank]');
  if (link) { e.preventDefault(); openExternal(link.href); return; }
  const row = e.target.closest('.track');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (row && act) {
    const list = state.lists.get(row.dataset.list);
    const id = row.dataset.id;
    if (act === 'play' && list) player.setQueue(list.tracks, Number(row.dataset.index));
    if (act === 'dl') download(id);
    if (act === 'undl') removeDownload(id);
    if (act === 'menu') openTrackMenu(e.target.closest('[data-act]'), state.known.get(id), list, Number(row.dataset.index));
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) location.hash = go.dataset.go;
});

// ---------- Pop-up menu ----------

const menu = $('#menu');
function openMenu(anchor, items) {
  menu.innerHTML = items.map((it, i) =>
    it === '-' ? '<div class="sep"></div>'
    : it.label && !it.run ? `<div class="label">${esc(it.label)}</div>`
    : `<button data-i="${i}">${esc(it.text)}</button>`).join('');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  menu.onclick = ev => {
    const b = ev.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[b.dataset.i].run();
  };
  setTimeout(() => document.addEventListener('click', outsideClose), 0);
}
function outsideClose(e) { if (!menu.contains(e.target)) closeMenu(); }
function closeMenu() { menu.hidden = true; document.removeEventListener('click', outsideClose); }

function openTrackMenu(anchor, t, list, index) {
  const items = [
    { label: 'Add to playlist' },
    ...state.playlists.map(p => ({ text: p.name, run: () => addToPlaylist(p.id, [t.id]) })),
    { text: '＋ New playlist…', run: async () => { const p = await createPlaylist(); if (p) await addToPlaylist(p.id, [t.id]); } },
    '-',
    { text: 'Play next', run: () => player.playNext(t) },
    { text: 'Add to queue', run: () => player.addToQueue(t) },
  ];
  if (state.downloaded.has(t.id)) items.push({ text: t.source === 'local' ? 'Delete imported file' : 'Remove download', run: () => removeDownload(t.id) });
  else if (t.downloadable) items.push({ text: 'Download for offline', run: () => download(t.id) });
  if (list?.playlistId) {
    const p = state.playlists.find(x => x.id === list.playlistId);
    items.push('-');
    if (index > 0) items.push({ text: 'Move up', run: () => movePlaylistTrack(p, index, -1) });
    if (index < p.trackIds.length - 1) items.push({ text: 'Move down', run: () => movePlaylistTrack(p, index, 1) });
    items.push({ text: 'Remove from this playlist', run: async () => { p.trackIds.splice(index, 1); await db.put('playlists', p); render(); } });
  }
  if (t.pageUrl) items.push('-', { text: `Open on ${SOURCE_LABEL[t.source]}`, run: () => openExternal(t.pageUrl) });
  if (t.license) items.push({ text: 'View license', run: () => openExternal(t.license) });
  openMenu(anchor, items);
}

async function movePlaylistTrack(p, i, dir) {
  const [x] = p.trackIds.splice(i, 1);
  p.trackIds.splice(i + dir, 0, x);
  await db.put('playlists', p);
  render();
}

// ---------- Views ----------

const views = {
  search() {
    const s = state.search;
    const chip = (key, label) => `<button class="chip${s.source === key ? ' on' : ''}" data-src="${key}">${label}</button>`;
    main.innerHTML = `
      <h1>Search</h1>
      <form class="searchbar" id="searchForm" role="search">
        <input type="search" id="q" placeholder="Artists, songs, albums, genres…" value="${esc(s.q)}" autocomplete="off" enterkeyhint="search">
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="chips">${chip('all', 'All')}${chip('archive', 'Internet Archive')}${chip('audius', 'Audius')}${chip('jamendo', 'Jamendo')}</div>
      <div id="results"></div>`;
    $('#searchForm').onsubmit = e => { e.preventDefault(); runSearch($('#q').value.trim()); };
    main.querySelector('.chips').onclick = e => {
      const c = e.target.closest('[data-src]');
      if (!c) return;
      s.source = c.dataset.src;
      if (s.q) runSearch(s.q); else render();
    };
    renderResults();
    if (!s.q) $('#q').focus();
  },

  async library() {
    const local = (await db.all('tracks')).filter(t => t.source === 'local').sort((a, b) => b.added - a.added).map(remember);
    const cards = await Promise.all(state.playlists.map(async p => {
      const first = p.trackIds.map(id => state.known.get(id)).find(t => t?.art) || await db.get('tracks', p.trackIds[0] || '');
      const cover = first?.art ? `<img src="${esc(first.art)}" alt="" loading="lazy">` : '<div class="cover">♪</div>';
      return `<button class="card" data-go="#/playlist/${esc(p.id)}">${cover}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${p.trackIds.length} track${p.trackIds.length === 1 ? '' : 's'}</div></button>`;
    }));
    main.innerHTML = `
      <h1>Your library</h1>
      <div class="row-actions">
        <button class="btn" id="newPl">＋ New playlist</button>
        <button class="btn ghost" id="importBtn">Import music files</button>
      </div>
      <h2>Playlists</h2>
      ${cards.length ? `<div class="cards">${cards.join('')}</div>` : '<p class="empty">No playlists yet. Make one, then add songs from Search with the ⋯ button.</p>'}
      <h2>My files</h2>
      ${local.length ? trackList(local, 'local') : '<p class="empty">Import MP3, M4A, FLAC, OGG or WAV files you own. They are stored in the app and play offline.</p>'}`;
    $('#newPl').onclick = async () => { if (await createPlaylist()) render(); };
    $('#importBtn').onclick = () => $('#fileInput').click();
  },

  async playlist(id) {
    const p = state.playlists.find(x => x.id === id);
    if (!p) { main.innerHTML = '<p class="empty">This playlist no longer exists.</p>'; return; }
    const tracks = await playlistTracks(p);
    const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
    const offline = tracks.filter(t => state.downloaded.has(t.id)).length;
    main.innerHTML = `
      <button class="back" data-go="#/library">‹ Library</button>
      <h1>${esc(p.name)}</h1>
      <p class="muted">${tracks.length} track${tracks.length === 1 ? '' : 's'}${total ? ' · ' + fmtTime(total) : ''} · ${offline} available offline</p>
      <div class="row-actions">
        <button class="btn" id="plPlay" ${tracks.length ? '' : 'disabled'}>▶ Play</button>
        <button class="btn ghost" id="plShuffle" ${tracks.length ? '' : 'disabled'}>⤮ Shuffle</button>
        <button class="btn ghost" id="plDl" ${tracks.length ? '' : 'disabled'}>⬇ Download all</button>
        <button class="btn ghost" id="plRename">Rename</button>
        <button class="btn danger" id="plDelete">Delete</button>
      </div>
      ${tracks.length ? trackList(tracks, 'pl', { playlistId: p.id }) : '<p class="empty">This playlist is empty. Find songs in Search and use ⋯ → Add to playlist.</p>'}`;
    $('#plPlay').onclick = () => { player.setShuffle(false); player.setQueue(tracks, 0); };
    $('#plShuffle').onclick = () => { player.setShuffle(true); player.setQueue(tracks, Math.floor(Math.random() * tracks.length)); };
    $('#plDl').onclick = () => downloadMany(tracks.map(t => t.id));
    $('#plRename').onclick = async () => {
      const name = prompt('Rename playlist', p.name)?.trim();
      if (name) { p.name = name; await db.put('playlists', p); render(); }
    };
    $('#plDelete').onclick = async () => {
      if (!confirm(`Delete "${p.name}"? Downloaded songs stay on this device.`)) return;
      await db.del('playlists', p.id);
      state.playlists = state.playlists.filter(x => x.id !== p.id);
      location.hash = '#/library';
    };
  },

  async album(identifier) {
    main.innerHTML = '<button class="back" data-go="#/search">‹ Search</button><div class="spinner"></div>';
    let a;
    try { a = await sources.archive.album(identifier); } catch (err) {
      main.innerHTML = `<button class="back" data-go="#/search">‹ Search</button><p class="empty">Couldn't load this album (${esc(err.message)}).</p>`;
      return;
    }
    if (currentRoute().arg !== identifier) return; // the user moved on while it loaded
    main.innerHTML = `
      <button class="back" data-go="#/search">‹ Search</button>
      <div style="display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px">
        <img src="${esc(a.art)}" alt="" style="width:150px;height:150px;border-radius:8px;object-fit:cover;background:var(--raised)">
        <div style="min-width:0;flex:1">
          <div class="small muted">Internet Archive</div>
          <h1 style="margin:4px 0">${esc(a.album)}</h1>
          <div class="muted">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''} · ${a.tracks.length} tracks</div>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn" id="alPlay" ${a.tracks.length ? '' : 'disabled'}>▶ Play</button>
        <button class="btn ghost" id="alAdd" ${a.tracks.length ? '' : 'disabled'}>＋ Add all to playlist</button>
        <button class="btn ghost" id="alDl" ${a.tracks.length ? '' : 'disabled'}>⬇ Download all</button>
      </div>
      ${a.tracks.length ? trackList(a.tracks, 'album') : '<p class="empty">This item has no playable MP3 files.</p>'}`;
    $('#alPlay').onclick = () => player.setQueue(a.tracks, 0);
    $('#alDl').onclick = () => downloadMany(a.tracks.map(t => t.id));
    $('#alAdd').onclick = e => openMenu(e.currentTarget, [
      { label: 'Add album to' },
      ...state.playlists.map(p => ({ text: p.name, run: () => addToPlaylist(p.id, a.tracks.map(t => t.id)) })),
      { text: '＋ New playlist…', run: async () => { const p = await createPlaylist(a.album); if (p) await addToPlaylist(p.id, a.tracks.map(t => t.id)); } },
    ]);
  },

  async downloads() {
    const ids = [...state.downloaded];
    const tracks = (await Promise.all(ids.map(async id => state.known.get(id) || await db.get('tracks', id)))).filter(Boolean).map(remember);
    tracks.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    let usage = '';
    if (navigator.storage?.estimate) {
      const { usage: u = 0, quota: q = 0 } = await navigator.storage.estimate();
      usage = `<p class="muted small">Using ${fmtBytes(u)} of about ${fmtBytes(q)} available to the app</p>
        <div class="meter"><div style="width:${q ? Math.min(100, u / q * 100).toFixed(1) : 0}%"></div></div>`;
    }
    main.innerHTML = `
      <h1>Downloads</h1>
      <p class="muted">Everything here plays without internet.</p>
      ${usage}
      <div class="row-actions" style="margin-top:14px">
        <button class="btn" id="dlPlay" ${tracks.length ? '' : 'disabled'}>▶ Play all</button>
        <button class="btn ghost" id="dlShuffle" ${tracks.length ? '' : 'disabled'}>⤮ Shuffle</button>
      </div>
      ${tracks.length ? trackList(tracks, 'downloads') : '<p class="empty">Nothing downloaded yet. Press ⬇ next to a song to keep it for offline listening.</p>'}`;
    $('#dlPlay').onclick = () => { player.setShuffle(false); player.setQueue(tracks, 0); };
    $('#dlShuffle').onclick = () => { player.setShuffle(true); player.setQueue(tracks, Math.floor(Math.random() * tracks.length)); };
  },

  async settings() {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    main.innerHTML = `
      <h1>Settings</h1>
      <h2>Jamendo</h2>
      <p class="muted">Jamendo has over 600,000 free Creative Commons songs. Searching it needs a free client ID:
        sign up at <a href="https://devportal.jamendo.com/" target="_blank" rel="noopener" style="color:var(--accent)">devportal.jamendo.com</a>,
        create an app, and paste its Client ID here.</p>
      <div class="field">
        <label for="jid">Client ID</label>
        <input id="jid" value="${esc(settings.get('jamendoId', ''))}" placeholder="e.g. 1a2b3c4d" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn" id="saveJ">Save</button>

      <h2>Offline storage</h2>
      <p class="muted">${persisted
        ? 'Storage is protected: your browser will not clear downloads to free space.'
        : 'Ask your browser to keep downloads safe, so they are not cleared when the device runs low on space.'}</p>
      ${persisted ? '' : '<button class="btn ghost" id="persist">Keep my downloads safe</button>'}
      ${NATIVE ? '' : '<p class="muted small">Tip: install the app (browser menu → "Install app" or "Add to Home Screen") so it opens like a normal app and works offline.</p>'}

      <h2>About</h2>
      <div class="notice small">
        <p style="margin-top:0"><b>Music Central v${APP_VERSION}</b>${NATIVE ? ` · ${NATIVE === 'windows' ? 'Windows' : 'Android'} app` : ''}</p>
        <p>Music comes from <b>Internet Archive</b> (live concerts, netlabels, public domain), <b>Audius</b> (independent artists; downloads only where the artist allows them) and <b>Jamendo</b> (Creative Commons).
        Use ⋯ → View license on a track to see its terms.</p>
        <p style="margin-bottom:0">Your playlists, downloads and imported files are stored only on this device, in this browser.</p>
      </div>`;
    $('#saveJ').onclick = () => { settings.set('jamendoId', $('#jid').value.trim()); toast('Saved'); };
    const pb = $('#persist');
    if (pb) pb.onclick = async () => {
      const ok = await navigator.storage?.persist?.();
      toast(ok ? 'Downloads are now protected' : 'Your browser said no. Installing the app usually helps.');
      render();
    };
  },
};

async function runSearch(q) {
  const s = state.search;
  s.q = q;
  if (!q) { s.results = null; renderResults(); return; }
  if (!navigator.onLine) { toast("You're offline. Your downloads are still in Downloads."); return; }
  s.loading = true;
  const token = (s.token = uid());
  renderResults();
  const want = s.source === 'all' ? ['archive', 'audius', 'jamendo'] : [s.source];
  const settled = await Promise.allSettled(want.map(k => sources[k].search(q)));
  if (s.token !== token) return; // a newer search started
  s.results = {};
  want.forEach((k, i) => {
    const r = settled[i];
    s.results[k] = r.status === 'fulfilled' ? { items: r.value } : { error: r.reason };
  });
  s.loading = false;
  renderResults();
}

function renderResults() {
  const box = $('#results');
  if (!box) return;
  const s = state.search;
  if (s.loading) { box.innerHTML = '<div class="spinner" style="margin:30px 0"></div>'; return; }
  if (!s.results) {
    box.innerHTML = `<div class="notice"><b>Find free music you can keep.</b>
      <p class="muted small" style="margin-bottom:0">Search across Internet Archive, Audius and Jamendo. Press ⬇ to download a song for offline listening, or ⋯ to add it to a playlist.</p></div>`;
    return;
  }
  const order = s.source === 'all' ? ['audius', 'jamendo', 'archive'] : [s.source];
  let html = '', any = false;
  for (const k of order) {
    const r = s.results[k];
    if (!r) continue;
    if (r.error) {
      if (s.source === 'all' && r.error.setup) continue; // don't nag on "All"
      html += `<h2>${SOURCE_LABEL[k]}</h2><p class="empty">${esc(r.error.message)}${r.error.setup ? ' <button class="btn ghost" data-go="#/settings">Open Settings</button>' : ''}</p>`;
      continue;
    }
    if (!r.items.length) { if (s.source !== 'all') html += `<h2>${SOURCE_LABEL[k]}</h2><p class="empty">No results.</p>`; continue; }
    any = true;
    if (k === 'archive') {
      html += `<h2>Albums & concerts · Internet Archive</h2><div class="cards">${r.items.map(a => `
        <button class="card" data-go="#/album/${encodeURIComponent(a.id)}">
          <img src="${esc(a.art)}" alt="" loading="lazy"><div class="c-title">${esc(a.title)}</div>
          <div class="c-sub">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}</div></button>`).join('')}</div>`;
    } else {
      html += `<h2>Songs · ${SOURCE_LABEL[k]}</h2>${trackList(r.items, 'search-' + k)}`;
    }
  }
  if (!any && s.source === 'all' && !html) html = `<p class="empty">No results for "${esc(s.q)}".</p>`;
  box.innerHTML = html;
}

// ---------- Routing ----------

function currentRoute() {
  const [, view = 'search', ...rest] = location.hash.split('/');
  return { view: views[view] ? view : 'search', arg: decodeURIComponent(rest.join('/')) };
}

async function render() {
  const { view, arg } = currentRoute();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active',
    b.dataset.view === view || (b.dataset.view === 'library' && view === 'playlist') || (b.dataset.view === 'search' && view === 'album')));
  closeMenu();
  await views[view](arg);
}

document.querySelectorAll('.nav-btn').forEach(b => { b.onclick = () => { location.hash = '#/' + b.dataset.view; }; });
addEventListener('hashchange', () => { render(); main.scrollTop = 0; });

// ---------- Start ----------

function updateOnline() { $('#offlinePill').hidden = navigator.onLine; }
addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);

$('#fileInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };

(async function start() {
  try {
    await db.open();
    state.downloaded = new Set(await db.keys('blobs'));
    await loadPlaylists();
  } catch (err) {
    main.innerHTML = `<p class="empty">This browser can't store data (${esc(err.message)}). Private browsing can cause this.</p>`;
    return;
  }
  setupPlayer();
  updateOnline();
  render();
  // The installed apps carry their files with them, so only the web version needs the offline cache.
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
