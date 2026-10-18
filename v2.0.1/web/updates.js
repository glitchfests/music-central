// Music Central: checking GitHub for a newer version and installing it.
// The repository's latest.json says which version is newest and where its installers are.
'use strict';

const Updates = (() => {
  const MANIFEST_URL = 'https://raw.githubusercontent.com/glitchfests/music-central/HEAD/latest.json';
  let found = null; // manifest of a newer version, once seen

  function isNewer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  }

  async function check() {
    let r;
    try { r = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' }); } catch {
      throw new Error("Couldn't reach GitHub. Check your internet connection.");
    }
    if (r.status === 404) throw new Error("Couldn't see the update file on GitHub. The repository needs to be public for the app to check it.");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}. Try again later.`);
    const m = await r.json();
    found = isNewer(m.version, APP_VERSION) ? m : null;
    settings.set('lastUpdateCheck', Date.now());
    return found;
  }

  async function install(m, onStatus) {
    if (!NATIVE) { onStatus('Reloading…'); location.reload(); return; }
    const url = m[NATIVE];
    if (!url) throw new Error(`Version ${m.version} has no ${NATIVE === 'windows' ? 'Windows' : 'Android'} download yet.`);
    onStatus('Downloading… 0%');
    await Native.installUpdate(url, pct => onStatus(pct >= 0 ? `Downloading… ${pct}%` : 'Downloading…'));
    onStatus(NATIVE === 'windows' ? 'Starting the installer…' : 'Opening the installer… Tap Update when Android asks.');
  }

  function showBanner(m) {
    const b = $('#updateBanner');
    b.innerHTML = `<span>Music Central ${esc(m.version)} is available.</span>
      <button class="btn" id="bannerUpdate">Update</button><button class="icon-btn" id="bannerClose" aria-label="Dismiss">✕</button>`;
    b.hidden = false;
    $('#bannerClose').onclick = () => { b.hidden = true; };
    $('#bannerUpdate').onclick = () => { b.hidden = true; location.hash = '#/settings'; setTimeout(() => $('#updInstall')?.click(), 300); };
  }

  // Checks quietly at most once a day when the app opens.
  async function autoCheck() {
    if (!navigator.onLine || Date.now() - settings.get('lastUpdateCheck', 0) < 24 * 3600 * 1000) return;
    try { const m = await check(); if (m) showBanner(m); } catch { /* try again tomorrow */ }
  }

  function settingsHtml() {
    return `
      <h2>Updates</h2>
      <p class="muted">You have version <b>${APP_VERSION}</b>.</p>
      <div class="row-actions">
        <button class="btn ghost" id="updCheck">Check for updates</button>
        <button class="btn" id="updInstall" ${found ? '' : 'hidden'}>${found ? `Update to ${esc(found.version)}` : 'Update'}</button>
      </div>
      <p class="muted small" id="updStatus">${found ? esc(found.notes || '') : ''}</p>`;
  }

  function bindSettings() {
    const status = msg => { const el = $('#updStatus'); if (el) el.textContent = msg; };
    const installBtn = $('#updInstall');
    $('#updCheck').onclick = async e => {
      e.target.disabled = true;
      status('Checking…');
      try {
        const m = await check();
        if (m) {
          installBtn.hidden = false;
          installBtn.textContent = `Update to ${m.version}`;
          status(m.notes || `Version ${m.version} is ready to install.`);
        } else status(`You're up to date (version ${APP_VERSION}).`);
      } catch (err) { status(err.message); }
      e.target.disabled = false;
    };
    installBtn.onclick = async () => {
      if (!found) return;
      installBtn.disabled = true;
      try { await install(found, status); } catch (err) { status(err.message); installBtn.disabled = false; }
    };
  }

  return { autoCheck, settingsHtml, bindSettings };
})();
