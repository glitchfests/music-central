// Music Central: Spotify and YouTube accounts.
// Both use your own free developer keys (entered in Settings) and only read your library;
// nothing is ever downloaded from either service.
'use strict';

const Accounts = (() => {
  // "streaming" lets the app itself play songs (Premium); "app-remote-control" is for the Android Spotify app.
  const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private app-remote-control';
  // Shown in Settings: Spotify's Android SDK checks the app's package name and signing key fingerprint.
  const ANDROID_PACKAGE = 'com.glitchfests.musiccentral';
  const ANDROID_SHA1 = '84:11:19:84:1B:99:F4:41:68:C7:9B:DA:D6:43:DA:C6:6D:A2:E2:77';
  const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
  // Spotify's dashboard needs the exact redirect address, port included, so the apps always use this one.
  const SPOTIFY_PORT = 43821;
  const SPOTIFY_APP_REDIRECT = `http://127.0.0.1:${SPOTIFY_PORT}/callback`;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const setupError = msg => Object.assign(new Error(msg), { setup: true });
  const form = obj => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj) });

  // PKCE (sign-in without a client secret)
  const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = async v => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

  // Playlists lists are cached for a few minutes so the Library doesn't refetch on every visit.
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  // ---------- Spotify ----------

  const spotify = {
    key: 'spotify',
    label: 'Spotify',
    likedLabel: 'Liked Songs',
    get clientId() { return settings.get('spotifyId', ''); },
    get connected() { return !!settings.get('tok.spotify', null); },
    get user() { return settings.get('spotifyUser', null); },
    // Sign-ins from before 2.1.0 didn't ask for the "streaming" permission.
    get canStream() { return (settings.get('tok.spotify', null)?.scope || '').split(' ').includes('streaming'); },
    webRedirect: () => location.origin + location.pathname,

    async connect() {
      if (!this.clientId) throw new Error('Paste your Spotify Client ID first.');
      const verifier = randomString();
      const params = {
        response_type: 'code', client_id: this.clientId, scope: SPOTIFY_SCOPES,
        code_challenge_method: 'S256', code_challenge: await challenge(verifier),
      };
      if (!Native.canLoopbackAuth) {
        // Browser version: Spotify sends us back to this page (see handleWebRedirect).
        settings.set('spotifyVerifier', verifier);
        location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ ...params, redirect_uri: this.webRedirect(), state: 'spotify' });
        return new Promise(() => {});
      }
      const { query, redirectUri } = await Native.loopbackAuth(`https://accounts.spotify.com/authorize?${new URLSearchParams(params)}&redirect_uri={REDIRECT}`, SPOTIFY_PORT);
      const q = new URLSearchParams(query);
      if (!q.get('code')) throw new Error(q.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled' : `Spotify said: ${q.get('error') || 'no code'}`);
      await this.exchange({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri, code_verifier: verifier });
      await this.loadUser();
    },

    async handleWebRedirect() {
      const q = new URLSearchParams(location.search);
      if (q.get('state') !== 'spotify') return;
      history.replaceState(null, '', location.pathname + location.hash);
      if (!q.get('code')) return toast('Spotify sign-in was cancelled');
      try {
        await this.exchange({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: this.webRedirect(), code_verifier: settings.get('spotifyVerifier', '') });
        await this.loadUser();
        toast('Spotify connected');
      } catch (err) { toast(err.message); }
    },

    async exchange(body) {
      const r = await fetch('https://accounts.spotify.com/api/token', form({ client_id: this.clientId, ...body }));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error_description || d.error || 'Spotify sign-in failed');
      const old = settings.get('tok.spotify', null) || {};
      settings.set('tok.spotify', { access: d.access_token, refresh: d.refresh_token || old.refresh, scope: d.scope || old.scope || '', expires: Date.now() + (d.expires_in - 60) * 1000 });
    },

    async token() {
      const t = settings.get('tok.spotify', null);
      if (!t) throw setupError('Connect Spotify in Settings first.');
      if (Date.now() < t.expires) return t.access;
      try { await this.exchange({ grant_type: 'refresh_token', refresh_token: t.refresh }); } catch {
        this.disconnect();
        throw setupError('Your Spotify sign-in expired. Connect again in Settings.');
      }
      return settings.get('tok.spotify', null).access;
    },

    async api(path, opts = {}) {
      const url = path.startsWith('https://') ? path : 'https://api.spotify.com/v1' + path;
      const headers = { Authorization: 'Bearer ' + await this.token() };
      if (opts.body) headers['Content-Type'] = 'application/json';
      const r = await fetch(url, { ...opts, headers });
      if (r.status === 204 || r.status === 202) return null;
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(d.error?.message || `Spotify error ${r.status}`), { status: r.status, reason: d.error?.reason });
      return d;
    },

    async loadUser() {
      const me = await this.api('/me');
      settings.set('spotifyUser', { name: me.display_name || me.id, premium: me.product === 'premium' });
    },

    disconnect() {
      settings.set('tok.spotify', null);
      settings.set('spotifyUser', null);
      cache.clear();
    },

    track(t) {
      if (!t?.id) return null;
      return remember({
        id: 'spotify:' + t.id, source: 'spotify',
        title: t.name, artist: (t.artists || []).map(a => a.name).join(', '), album: t.album?.name || '',
        duration: (t.duration_ms || 0) / 1000, art: t.album?.images?.[0]?.url || '',
        streamUrl: '', downloadUrl: '', downloadable: false, license: '',
        pageUrl: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
        uri: t.uri || 'spotify:track:' + t.id,
      });
    },

    async search(q) {
      const d = await this.api('/search?' + new URLSearchParams({ q, type: 'track', limit: '10' }));
      return d.tracks.items.map(t => this.track(t)).filter(Boolean);
    },

    playlists() {
      return cached('spotify:playlists', async () => {
        const out = [];
        for (let url = '/me/playlists?limit=50'; url && out.length < 500;) {
          const d = await this.api(url);
          out.push(...d.items.filter(Boolean));
          url = d.next;
        }
        return out.map(p => ({ id: p.id, name: p.name, art: p.images?.[0]?.url || '', count: (p.items || p.tracks)?.total ?? null }));
      });
    },

    async tracks(id) {
      const out = [];
      let url = id === 'liked' ? '/me/tracks?limit=50' : `/playlists/${encodeURIComponent(id)}/items?limit=50`;
      while (url && out.length < 3000) {
        let d;
        try { d = await this.api(url); } catch (err) {
          if (err.status === 403 || err.status === 404) throw new Error("Spotify only lets personal developer apps read playlists you created or collaborate on. Copy this playlist into one of your own in Spotify to see it here.");
          throw err;
        }
        for (const it of d.items) {
          const t = it.item || it.track;
          if (t && t.type !== 'episode') out.push(this.track(t));
        }
        url = d.next;
      }
      return out.filter(Boolean);
    },

    // Plays a song (or a whole playlist) in your Spotify app. Needs Premium.
    async play(t, contextUri) {
      const openInApp = () => openExternal(t.pageUrl);
      if (!this.connected) { toast('Opening in Spotify…'); return openInApp(); }
      if (!this.user?.premium) { toast('Controlling Spotify from another app needs Premium. Opening Spotify…'); return openInApp(); }
      try {
        const { devices } = await this.api('/me/player/devices');
        const device = devices.find(d => d.is_active) || devices[0];
        if (!device) { toast('Open the Spotify app on any device first, then try again.'); return openInApp(); }
        const body = contextUri ? { context_uri: contextUri } : { uris: [t.uri] };
        await this.api(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, { method: 'PUT', body: JSON.stringify(body) });
        toast(`Playing on Spotify (${device.name})`);
      } catch (err) { toast(`Spotify: ${err.message}`); }
    },
  };

  // ---------- YouTube ----------
  // Google sign-in uses the "TV and limited input device" flow: the app shows a short code that you
  // enter at google.com/device. It works the same on Windows, Android and in a browser.

  const youtube = {
    key: 'youtube',
    label: 'YouTube',
    likedLabel: 'Liked videos',
    signIn: null, // { code, url, cancel } while waiting for the code to be entered
    get clientId() { return settings.get('ytClientId', ''); },
    get clientSecret() { return settings.get('ytClientSecret', ''); },
    get connected() { return !!settings.get('tok.youtube', null); },
    get user() { return settings.get('youtubeUser', null); },

    async connect(onCode) {
      if (!this.clientId || !this.clientSecret) throw new Error('Paste your Google Client ID and Client secret first.');
      const r = await fetch('https://oauth2.googleapis.com/device/code', form({ client_id: this.clientId, scope: YOUTUBE_SCOPE }));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error_description || d.error || 'Google sign-in failed');
      let cancelled = false;
      this.signIn = { code: d.user_code, url: d.verification_url || 'https://www.google.com/device', cancel: () => { cancelled = true; } };
      onCode(this.signIn);
      try {
        let interval = (d.interval || 5) * 1000;
        const until = Date.now() + d.expires_in * 1000;
        while (Date.now() < until) {
          await sleep(interval);
          if (cancelled) throw new Error('Sign-in cancelled');
          const t = await fetch('https://oauth2.googleapis.com/token', form({
            client_id: this.clientId, client_secret: this.clientSecret, device_code: d.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }));
          const j = await t.json().catch(() => ({}));
          if (t.ok) {
            settings.set('tok.youtube', { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in - 60) * 1000 });
            await this.loadUser();
            return;
          }
          if (j.error === 'authorization_pending') continue;
          if (j.error === 'slow_down') { interval += 5000; continue; }
          throw new Error(j.error === 'access_denied' ? 'Sign-in was cancelled' : j.error_description || j.error || 'Google sign-in failed');
        }
        throw new Error('The code expired. Press Connect to get a new one.');
      } finally {
        this.signIn = null;
      }
    },

    async token() {
      const t = settings.get('tok.youtube', null);
      if (!t) throw setupError('Connect YouTube in Settings first.');
      if (Date.now() < t.expires) return t.access;
      const r = await fetch('https://oauth2.googleapis.com/token', form({
        client_id: this.clientId, client_secret: this.clientSecret, refresh_token: t.refresh, grant_type: 'refresh_token',
      }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        this.disconnect();
        throw setupError('Your YouTube sign-in expired. Connect again in Settings.');
      }
      settings.set('tok.youtube', { ...t, access: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 });
      return j.access_token;
    },

    async api(path, params) {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: 'Bearer ' + await this.token() },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = d.error?.errors?.[0]?.reason;
        throw new Error(reason === 'quotaExceeded' ? "YouTube's daily limit for your key is used up. It resets at midnight Pacific time." : d.error?.message || `YouTube error ${r.status}`);
      }
      return d;
    },

    async loadUser() {
      const d = await this.api('channels', { part: 'snippet', mine: 'true' });
      settings.set('youtubeUser', { name: d.items?.[0]?.snippet?.title || 'your account' });
    },

    disconnect() {
      settings.set('tok.youtube', null);
      settings.set('youtubeUser', null);
      cache.clear();
    },

    // "PT1H2M3S" → seconds
    isoDuration(v) {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v || '');
      return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0;
    },

    track(videoId, sn, duration) {
      return remember({
        id: 'youtube:' + videoId, source: 'youtube', videoId,
        title: sn.title, artist: (sn.videoOwnerChannelTitle || sn.channelTitle || '').replace(/ - Topic$/, ''), album: '',
        duration, art: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
        streamUrl: '', downloadUrl: '', downloadable: false, license: '',
        pageUrl: 'https://www.youtube.com/watch?v=' + videoId,
      });
    },

    // Looks up durations (and drops videos that no longer exist) 50 at a time.
    async withDetails(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const d = await this.api('videos', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
        for (const v of d.items) out.push(this.track(v.id, v.snippet, this.isoDuration(v.contentDetails?.duration)));
      }
      return out;
    },

    async search(q) {
      const d = await this.api('search', { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '20', q });
      return this.withDetails(d.items.map(i => i.id.videoId).filter(Boolean));
    },

    playlists() {
      return cached('youtube:playlists', async () => {
        const out = [];
        let pageToken = '';
        do {
          const d = await this.api('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(pageToken && { pageToken }) });
          out.push(...d.items);
          pageToken = d.nextPageToken;
        } while (pageToken && out.length < 500);
        return out.map(p => ({ id: p.id, name: p.snippet.title, art: p.snippet.thumbnails?.medium?.url || '', count: p.contentDetails?.itemCount ?? null }));
      });
    },

    async tracks(id) {
      const out = [];
      let pageToken = '';
      if (id === 'liked') {
        do {
          const d = await this.api('videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: '50', ...(pageToken && { pageToken }) });
          for (const v of d.items) out.push(this.track(v.id, v.snippet, this.isoDuration(v.contentDetails?.duration)));
          pageToken = d.nextPageToken;
        } while (pageToken && out.length < 1000);
        return out;
      }
      const ids = [];
      do {
        const d = await this.api('playlistItems', { part: 'contentDetails', playlistId: id, maxResults: '50', ...(pageToken && { pageToken }) });
        ids.push(...d.items.map(i => i.contentDetails.videoId));
        pageToken = d.nextPageToken;
      } while (pageToken && ids.length < 1000);
      return this.withDetails(ids);
    },
  };

  const services = { spotify, youtube };

  // ---------- Playing Spotify songs inside Music Central ----------
  // Windows (and Chrome/Edge): Spotify's Web Playback SDK makes the app its own Spotify player. This
  // needs Widevine copy protection, which the Windows app gets from castLabs Electron.
  // Android: the Spotify app plays in the background, controlled through the App Remote SDK.
  // Either way it's a Premium-only feature. If it fails, the song plays on your Spotify device instead.

  const webSdk = {
    ready: null,
    player: null,
    deviceId: null,
    broken: '',

    init() {
      if (this.ready) return this.ready;
      this.ready = new Promise((resolve, reject) => {
        const fail = msg => { this.broken = msg; this.ready = null; reject(new Error(msg)); };
        const timer = setTimeout(() => fail("Spotify's player didn't start in time"), 25000);
        const start = () => {
          this.player?.disconnect();
          const p = new Spotify.Player({
            name: 'Music Central',
            getOAuthToken: cb => spotify.token().then(cb, () => cb('')),
            volume: Number(settings.get('volume', 1)),
          });
          p.addListener('ready', ({ device_id }) => { this.deviceId = device_id; clearTimeout(timer); resolve(); });
          p.addListener('not_ready', () => { this.deviceId = null; });
          p.addListener('initialization_error', ({ message }) => { clearTimeout(timer); fail(`This device can't play Spotify (${message})`); });
          p.addListener('authentication_error', ({ message }) => { clearTimeout(timer); this.ready = null; reject(new Error(`Spotify sign-in problem: ${message}. Try reconnecting in Settings.`)); });
          p.addListener('account_error', () => { clearTimeout(timer); fail('Playing Spotify inside the app needs Premium'); });
          p.addListener('playback_error', ({ message }) => spotifyEngine.failed(message));
          p.addListener('player_state_changed', st => {
            if (!st) return;
            const cur = st.track_window?.current_track;
            spotifyEngine.onState({
              uri: cur?.uri || '', linkedUri: cur?.linked_from?.uri || '',
              paused: st.paused, position: st.position, duration: st.duration,
              previous: (st.track_window?.previous_tracks || []).map(t => t.uri),
            });
          });
          p.connect().then(ok => {
            // Usually a sign-in problem rather than the device, so try again next time.
            if (!ok) { clearTimeout(timer); this.ready = null; reject(new Error("Couldn't start Spotify's player. Try reconnecting Spotify in Settings.")); }
          });
          this.player = p;
        };
        if (window.Spotify?.Player) return start();
        window.onSpotifyWebPlaybackSDKReady = start;
        const sc = document.createElement('script');
        sc.src = 'https://sdk.scdn.co/spotify-player.js';
        sc.onerror = () => { clearTimeout(timer); this.ready = null; reject(new Error("Couldn't load Spotify's player")); };
        document.head.appendChild(sc);
      });
      return this.ready;
    },

    async play(uri) {
      await this.init();
      await spotify.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
    },
    pause: () => webSdk.player?.pause(),
    resume: () => webSdk.player?.resume(),
    seek: sec => webSdk.player?.seek(Math.round(sec * 1000)),
    setVolume: v => webSdk.player?.setVolume(v),
  };

  const appRemote = {
    connected: false,
    listening: false,
    async init() {
      const r = Native.spotifyRemote;
      if (!this.listening) {
        this.listening = true;
        r.onState(st => spotifyEngine.onState({ uri: st.uri, linkedUri: '', paused: st.paused, position: st.position, duration: st.duration, previous: [] }));
        r.onDisconnected(() => { this.connected = false; });
      }
      if (this.connected) return;
      if (!await r.isInstalled()) throw new Error('Install the Spotify app (and log in) to play Spotify songs here.');
      await r.connect(spotify.clientId, SPOTIFY_APP_REDIRECT);
      this.connected = true;
    },
    async play(uri) { await this.init(); await Native.spotifyRemote.play(uri); },
    pause: () => Native.spotifyRemote.pause().catch(() => {}),
    resume: () => Native.spotifyRemote.resume().catch(() => {}),
    seek: sec => Native.spotifyRemote.seek(sec).catch(() => {}),
    setVolume: () => {},
  };

  const spotifyEngine = {
    expected: '',   // the song we asked Spotify to play
    started: false, // Spotify has reported playing it
    finished: false,
    last: { paused: true, position: 0, duration: 0, at: 0 },
    timer: null,

    get backend() { return Native.spotifyRemote ? appRemote : webSdk; },

    async load(t) {
      this.expected = t.uri;
      this.started = false;
      this.finished = false;
      this.last = { paused: true, position: 0, duration: (t.duration || 0) * 1000, at: performance.now() };
      clearTimeout(this.watchdog);
      await this.backend.play(t.uri);
      // If Spotify accepted the request but nothing starts (e.g. it won't license this device), give up on in-app playback.
      this.watchdog = setTimeout(() => { if (player.engine === 'spotify' && this.expected === t.uri && !this.started) this.failed('nothing started playing'); }, 12000);
    },

    onState(st) {
      if (player.engine !== 'spotify' || !this.expected || this.finished) return;
      const mine = st.uri === this.expected || st.linkedUri === this.expected;
      if (!mine) {
        // Spotify moved on to something else by itself: our song is over.
        if (this.started || st.previous.includes(this.expected)) this.finish();
        return;
      }
      const wasNearEnd = this.started && this.last.duration && this.last.position > this.last.duration - 5000;
      if (st.paused && st.position === 0 && (wasNearEnd || st.previous.includes(this.expected))) return this.finish();
      if (!st.paused || st.position > 0) this.started = true;
      this.last = { paused: st.paused, position: st.position, duration: st.duration, at: performance.now() };
      clearInterval(this.timer);
      if (!st.paused) this.timer = setInterval(() => onTime(this.time(), this.duration()), 500);
      onPlayState(!st.paused);
      onTime(this.time(), this.duration());
    },

    finish() {
      this.finished = true;
      clearInterval(this.timer);
      // Pause first so Spotify's autoplay doesn't carry on after our song, then move on.
      Promise.resolve(this.backend.pause()).catch(() => {}).finally(() => player.next(true));
    },

    failed(message) {
      if (player.engine !== 'spotify') return;
      if (this.started || this.backend !== webSdk) return toast(`Spotify: ${message}`);
      // Never got going: switch this device to playing on your Spotify app instead.
      webSdk.broken = `Spotify wouldn't play here: ${message}`;
      const t = player.current;
      this.stop();
      player.useEngine(null);
      onPlayState(false);
      toast(`${webSdk.broken}. Playing on your Spotify device instead.`);
      if (t) spotify.play(t);
    },

    // engine interface used by the player
    play() { this.backend.resume(); },
    pause() { this.backend.pause(); },
    seek(sec) { this.backend.seek(sec); this.last = { ...this.last, position: sec * 1000, at: performance.now() }; },
    time() { return (this.last.position + (this.last.paused ? 0 : performance.now() - this.last.at)) / 1000; },
    duration() { return this.last.duration / 1000; },
    paused() { return this.last.paused; },
    stop() {
      clearInterval(this.timer);
      clearTimeout(this.watchdog);
      if (this.expected && !this.finished) this.backend.pause();
      this.expected = '';
    },
  };
  engines.spotify = spotifyEngine;

  // Can this device play Spotify songs itself right now?
  spotify.canPlayInApp = () => {
    if (!spotify.connected || !spotify.user?.premium) return false;
    if (Native.spotifyRemote) return true;
    return spotify.canStream && !webSdk.broken && !!navigator.requestMediaKeySystemAccess;
  };
  spotify.inAppProblem = () => webSdk.broken;
  spotify.setVolume = v => spotifyEngine.backend.setVolume(v);

  // Free-copy links are saved with the song; bring them back onto freshly fetched tracks.
  async function withLinks(tracks) {
    await Promise.all(tracks.map(async t => {
      if (t.freeCopy) return;
      const saved = await db.get('tracks', t.id);
      if (saved?.freeCopy) t.freeCopy = saved.freeCopy;
    }));
    return tracks;
  }

  // Searching Spotify and YouTube from the Search page.
  sources.spotify = { label: 'Spotify', search: async q => withLinks(await spotify.search(q)) };
  sources.youtube = { label: 'YouTube', search: async q => withLinks(await youtube.search(q)) };

  // ---------- Free copies ----------

  async function linkFreeCopy(orig, copy) {
    if (copy) { await saveTrack(copy); orig.freeCopy = copy.id; } else delete orig.freeCopy;
    await saveTrack(orig);
    toast(copy ? `Linked. "${orig.title}" now plays (and downloads) as the free copy.` : 'Free copy unlinked');
    if (copy) history.back(); else render();
  }

  // "Song Title (Official Video) [HD]" → "Song Title"
  const cleanTitle = s => s.replace(/\s*[([][^)\]]*(official|video|audio|lyrics?|hd|4k|remaster|visuali[sz]er|mv)[^)\]]*[)\]]/gi, '').replace(/\s+-\s+topic$/i, '').trim();

  views.match = async id => {
    const t = state.known.get(id) || await db.get('tracks', id);
    if (!t) { main.innerHTML = '<p class="empty">Song not found.</p>'; return; }
    remember(t);
    const q = `${t.artist.split(',')[0]} ${cleanTitle(t.title)}`.trim();
    main.innerHTML = `<button class="back" onclick="history.back()">‹ Back</button>
      <h1>Free copies</h1>
      <p class="muted">Looking for "${esc(cleanTitle(t.title))}" by ${esc(t.artist)} on Audius and Jamendo…</p><div class="spinner"></div>`;
    const want = ['audius', ...(settings.get('jamendoId', '') ? ['jamendo'] : [])];
    const results = (await Promise.allSettled(want.map(k => sources[k].search(q))))
      .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      .filter(x => x.downloadable);
    if (currentRoute().arg !== id) return;
    main.innerHTML = `<button class="back" onclick="history.back()">‹ Back</button>
      <h1>Free copies</h1>
      <p class="muted">Downloadable versions of "${esc(t.title)}" by ${esc(t.artist)}. Check it's really the same song, then use ⋯ → <b>Use as free copy</b>.
      After that, playing the ${SOURCE_LABEL[t.source]} song plays this one instead, and you can download it.</p>
      ${results.length ? trackList(results, 'match', { matchFor: t.id })
        : `<p class="empty">No free, downloadable copy found. Many big-label songs only exist on paid services.${settings.get('jamendoId', '') ? '' : ' Adding a Jamendo key in Settings searches one more catalog.'}</p>`}`;
  };

  // ---------- Library: your Spotify and YouTube playlists ----------

  const card = (svc, p) => {
    const cover = p.art ? `<img src="${esc(p.art)}" alt="" loading="lazy">` : `<div class="cover">${p.id === 'liked' ? '♥' : '♪'}</div>`;
    const count = p.count == null ? svc.label : `${p.count} ${svc.key === 'youtube' ? 'video' : 'song'}${p.count === 1 ? '' : 's'}`;
    return `<button class="card" data-go="#/${svc.key}/${encodeURIComponent(p.id)}">${cover}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${esc(count)}</div></button>`;
  };

  async function renderLibrarySections(box) {
    const parts = await Promise.all(Object.values(services).map(async svc => {
      if (!svc.connected) return '';
      try {
        const pls = await svc.playlists();
        return `<h2>${svc.label}</h2><div class="cards">${card(svc, { id: 'liked', name: svc.likedLabel, art: '', count: null })}${pls.map(p => card(svc, p)).join('')}</div>`;
      } catch (err) {
        return `<h2>${svc.label}</h2><p class="empty">${esc(err.message)}</p>`;
      }
    }));
    const missing = Object.values(services).filter(s => !s.connected).map(s => s.label);
    if (missing.length) parts.push(`<div class="notice small" style="margin-top:24px">Connect ${missing.join(' and ')} in <button class="btn ghost" data-go="#/settings">Settings</button> to see your playlists here.</div>`);
    if (box.isConnected) box.innerHTML = parts.join('');
  }

  async function serviceView(svc, id) {
    main.innerHTML = `<button class="back" data-go="#/library">‹ Library</button><div class="spinner"></div>`;
    let tracks, name;
    try {
      name = id === 'liked' ? svc.likedLabel : (await svc.playlists()).find(p => p.id === id)?.name || 'Playlist';
      tracks = await withLinks(await svc.tracks(id));
    } catch (err) {
      main.innerHTML = `<button class="back" data-go="#/library">‹ Library</button><p class="empty">${esc(err.message)}</p>`;
      return;
    }
    if (currentRoute().arg !== id) return;
    const linked = tracks.filter(t => t.freeCopy).length;
    main.innerHTML = `
      <button class="back" data-go="#/library">‹ Library</button>
      <div class="small muted">${svc.label}</div>
      <h1>${esc(name)}</h1>
      <p class="muted">${tracks.length} ${svc.key === 'youtube' ? 'videos' : 'songs'}${svc.key === 'spotify' ? ` · ${linked} with a free copy` : ''}</p>
      <div class="row-actions">
        <button class="btn" id="svPlay" ${tracks.length ? '' : 'disabled'}>▶ ${svc.key === 'spotify' ? 'Play on Spotify' : 'Play'}</button>
        <button class="btn ghost" id="svImport" ${tracks.length ? '' : 'disabled'}>＋ Copy into a Music Central playlist</button>
      </div>
      ${svc.key === 'spotify' ? '<p class="muted small">Spotify songs play in your Spotify app. Use ⌕ to find a free copy you can download and play here.</p>' : '<p class="muted small">YouTube videos play in the video player while the app is open. They can\'t be downloaded; use ⌕ to find a free copy.</p>'}
      ${trackList(tracks, 'svc')}`;
    $('#svPlay').onclick = () => {
      if (svc.key === 'youtube') player.setQueue(tracks, 0);
      else spotify.play(tracks[0], id === 'liked' ? null : `spotify:playlist:${id}`);
    };
    $('#svImport').onclick = async () => {
      const p = await createPlaylist(name);
      if (p) await addToPlaylist(p.id, tracks.map(t => t.id));
    };
  }
  views.spotify = id => serviceView(spotify, id);
  views.youtube = id => serviceView(youtube, id);

  // ---------- Settings ----------

  function statusLine(svc) {
    if (!svc.connected) return '<p class="muted small">Not connected.</p>';
    const u = svc.user;
    let extra = '';
    if (svc.key === 'spotify') {
      if (u && !u.premium) extra = ' · no Premium: songs open in the Spotify app';
      else if (!Native.spotifyRemote && !spotify.canStream) extra = '</p><p class="small" style="color:#ffc46b">Disconnect and connect again to let Music Central play Spotify songs itself (it needs one more permission).';
      else if (spotify.inAppProblem()) extra = `</p><p class="small" style="color:#ffc46b">In-app playback isn't working on this device (${esc(spotify.inAppProblem())}), so songs play on your Spotify device instead.`;
      else extra = Native.spotifyRemote ? ' · songs play through the Spotify app in the background' : ' · songs play inside Music Central';
    }
    return `<p class="small" style="color:var(--accent)">Connected as ${esc(u?.name || 'you')}${extra}</p>`;
  }

  function settingsHtml() {
    const link = (url, text) => `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent)">${text}</a>`;
    const spRedirects = `<code>${esc(Native.canLoopbackAuth ? SPOTIFY_APP_REDIRECT : spotify.webRedirect())}</code>`;
    return `
      <h2>Spotify</h2>
      <p class="muted">See your Spotify playlists and liked songs, search Spotify, and play Spotify songs right here (Premium).
      ${Native.spotifyRemote ? 'On Android the Spotify app must be installed and logged in; it plays in the background while you stay here.' : ''}</p>
      <details class="notice small"><summary><b>How to get a Client ID</b> (one time, about 3 minutes)</summary>
        <ol>
          <li>Go to ${link('https://developer.spotify.com/dashboard', 'developer.spotify.com/dashboard')} and log in.</li>
          <li>Press <b>Create app</b>. Any name and description. Tick <b>Web API</b>.</li>
          <li>Under <b>Redirect URIs</b>, add ${spRedirects} exactly, and save.</li>
          <li>For the Android app, also tick <b>Android</b> and add the package name <code>${ANDROID_PACKAGE}</code>
            with the SHA1 fingerprint <code>${ANDROID_SHA1}</code>.</li>
          <li>Open the app's settings and copy the <b>Client ID</b> into the box below.</li>
        </ol>
        <p style="margin-bottom:0">Spotify's rules for personal developer apps: the account that creates the app needs <b>Premium</b>, and up to 5 people can use it.
        Spotify also only shows playlists you created or collaborate on.</p>
      </details>
      <div class="field"><label for="spId">Spotify Client ID</label>
        <input id="spId" value="${esc(spotify.clientId)}" autocomplete="off" spellcheck="false"></div>
      ${statusLine(spotify)}
      <div class="row-actions">
        ${spotify.connected ? '<button class="btn danger" id="spOff">Disconnect</button>' : '<button class="btn" id="spOn">Connect Spotify</button>'}
      </div>

      <h2>YouTube</h2>
      <p class="muted">See your YouTube playlists and liked videos, search YouTube, and play videos in the app.</p>
      <details class="notice small"><summary><b>How to get a Client ID and secret</b> (one time, about 5 minutes)</summary>
        <ol>
          <li>Go to ${link('https://console.cloud.google.com/', 'console.cloud.google.com')} and create a project (any name).</li>
          <li>In <b>APIs &amp; Services → Library</b>, find <b>YouTube Data API v3</b> and press <b>Enable</b>.</li>
          <li>In <b>Google Auth Platform</b> (or <b>OAuth consent screen</b>), set it up as <b>External</b>, and under <b>Audience → Test users</b> add your own Google account.</li>
          <li>In <b>Clients</b> (or <b>Credentials</b>), create an <b>OAuth client ID</b> of type <b>TVs and Limited Input devices</b>.</li>
          <li>Copy its <b>Client ID</b> and <b>Client secret</b> into the boxes below.</li>
        </ol>
        <p style="margin-bottom:0">While the Google project is in "testing", Google signs you out after 7 days. Press Connect again when that happens.</p>
      </details>
      <div class="field"><label for="ytId">Google Client ID</label>
        <input id="ytId" value="${esc(youtube.clientId)}" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="ytSecret">Google Client secret</label>
        <input id="ytSecret" type="password" value="${esc(youtube.clientSecret)}" autocomplete="off" spellcheck="false"></div>
      ${statusLine(youtube)}
      <div id="ytCode"></div>
      <div class="row-actions">
        ${youtube.connected ? '<button class="btn danger" id="ytOff">Disconnect</button>' : '<button class="btn" id="ytOn">Connect YouTube</button>'}
      </div>`;
  }

  function showYouTubeCode(si) {
    const box = $('#ytCode');
    if (!box) return;
    box.innerHTML = `<div class="notice">
      <p style="margin-top:0">On any phone or computer, go to <b>${esc(si.url.replace(/^https?:\/\//, ''))}</b> and enter this code:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:3px;margin:8px 0">${esc(si.code)}</p>
      <div class="row-actions" style="margin-bottom:0">
        <button class="btn" id="ytOpen">Open the page</button>
        <button class="btn ghost" id="ytCopy">Copy code</button>
        <button class="btn ghost" id="ytCancel">Cancel</button>
      </div>
      <p class="muted small" style="margin-bottom:0">Waiting for you to approve…</p></div>`;
    $('#ytOpen').onclick = () => openExternal(si.url);
    $('#ytCopy').onclick = () => navigator.clipboard?.writeText(si.code).then(() => toast('Code copied'), () => toast(si.code));
    $('#ytCancel').onclick = () => si.cancel();
  }

  function bindSettings() {
    const save = () => {
      settings.set('spotifyId', $('#spId').value.trim());
      settings.set('ytClientId', $('#ytId').value.trim());
      settings.set('ytClientSecret', $('#ytSecret').value.trim());
    };
    ['#spId', '#ytId', '#ytSecret'].forEach(sel => { $(sel).onchange = save; });
    const btn = (sel, fn) => { const b = $(sel); if (b) b.onclick = fn; };
    btn('#spOn', async e => {
      save();
      e.target.disabled = true;
      e.target.textContent = 'Waiting for Spotify…';
      try { await spotify.connect(); toast('Spotify connected'); } catch (err) { toast(err.message); }
      if (currentRoute().view === 'settings') render();
    });
    btn('#spOff', () => { spotify.disconnect(); render(); });
    btn('#ytOn', async e => {
      save();
      e.target.disabled = true;
      try { await youtube.connect(showYouTubeCode); toast('YouTube connected'); } catch (err) { toast(err.message); }
      if (currentRoute().view === 'settings') render();
    });
    btn('#ytOff', () => { youtube.disconnect(); render(); });
    if (youtube.signIn) { showYouTubeCode(youtube.signIn); $('#ytOn').disabled = true; }
  }

  async function init() {
    await spotify.handleWebRedirect();
  }

  return { spotify, youtube, init, linkFreeCopy, renderLibrarySections, settingsHtml, bindSettings };
})();
