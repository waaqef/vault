import { MAX, ACCEPT_AUDIO, ACCEPT_IMAGE, kindOf } from './types.js';
import { icon } from './icons.js';
import { settings, setSetting, ACCENTS } from './settings.js';
import { decodeAudio, bpmKeyOf, parseName } from './detect.js';
import { peaksOf, waveSvg } from './wave.js';
import { makeZip, safeName } from './zip.js';

// ---- helpers ------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else if (k in el && k !== 'list') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  return fill(el, ...kids), el;
}
// Like replaceChildren, but accepts nested arrays and skips null/false (for `cond && el`).
function fill(el, ...kids) { el.replaceChildren(...kids.flat(9).filter(k => k != null && k !== false)); }
const fmtTime = s => (s == null || !isFinite(s) ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const fmtBytes = b => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
const fmtDate = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// "Today", "Yesterday", "3 days ago", "Oct 9", or "Oct 9, 2025" for older years.
function fmtAdded(t) {
  const d = new Date(t), day = 864e5, startOfToday = new Date().setHours(0, 0, 0, 0);
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - day) return 'Yesterday';
  if (t >= startOfToday - 6 * day) return Math.ceil((startOfToday - t) / day) + ' days ago';
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].flatMap(k => [k + ' maj', k + ' min']);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const coverUrl = key => (key ? `/api/cover/${key}` : '');
const bg = key => (key ? { backgroundImage: `url("${coverUrl(key)}")` } : {});
// A cover thumbnail: the image if there is one, otherwise a monochrome disc.
const thumb = (key, cls = 'thumb', ...kids) => h('span', { className: cls + (key ? '' : ' disc'), style: bg(key) }, ...kids);
const coverOf = t => t.cover || projectOf(t.project_id)?.cover;
// Sliders show their filled part via --p (WebKit has no native "progress" styling).
const syncRange = r => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%');

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/signup') { showLogin(); throw new Error('Not logged in'); }
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export function toast(msg, { error = false, ms = 3500, action, quiet = false } = {}) {
  const el = h('div', { className: 'toast' + (error ? ' error' : '') + (action ? ' has-action' : '') + (quiet ? ' quiet' : '') }, h('span', {}, msg),
    action && h('button', { className: 'toast-btn', onclick: () => { el.remove(); action.run(); } }, action.label));
  el.remove = () => { el.classList.add('out'); setTimeout(() => Element.prototype.remove.call(el), 200); };
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
const oops = e => e.message !== 'Not logged in' && toast(e.message, { error: true, ms: 6000 });

function dialog(content, { className = '' } = {}) {
  const d = h('dialog', { className }, content);
  d.addEventListener('close', () => d.remove());
  const nativeClose = d.close.bind(d);
  d.close = value => {
    if (!d.open || d.classList.contains('closing')) return;
    d.classList.add('closing');
    let done = false;
    const finish = () => { if (!done) { done = true; d.classList.remove('closing'); nativeClose(value); } };
    d.addEventListener('animationend', e => { if (e.target === d) finish(); });
    setTimeout(finish, 360); // in case the animation never runs
  };
  // Escape: animate out too (the editor handles Escape itself, to ask before discarding)
  d.addEventListener('cancel', e => { if (!className.includes('editor')) { e.preventDefault(); d.close(); } });
  d.addEventListener('click', e => {
    if (e.target !== d || className.includes('editor')) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); // backdrop click
  });
  document.body.append(d);
  d.showModal();
  // phones: don't jump into the first text box (that pops the keyboard up); prompts that want typing focus it themselves
  if (matchMedia('(pointer: coarse)').matches && /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { document.activeElement.blur(); d.focus?.(); }
  return d;
}
function prompt(title, value = '', { label = 'Name', ok = 'Save' } = {}) {
  return new Promise(res => {
    const input = h('input', { type: 'text', value, required: true, maxLength: 200 });
    const d = dialog(h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); res(input.value.trim()); d.close(); } },
      h('h2', {}, title), h('label', {}, label, input),
      h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, ok))));
    d.addEventListener('close', () => res(null));
    input.select();
  });
}
function confirm(title, text, ok = 'Delete', cancel = 'Cancel') {
  return new Promise(res => {
    const d = dialog(h('div', { className: 'stack' }, h('h2', {}, title), h('p', { className: 'muted', style: { margin: 0 } }, text),
      h('div', { className: 'btns' }, h('button', { className: 'btn ghost', onclick: () => { res(false); d.close(); } }, cancel),
        h('button', { className: 'btn primary', style: { background: 'var(--danger)', color: '#fff' }, onclick: () => { res(true); d.close(); } }, ok))));
    d.addEventListener('close', () => res(false));
  });
}
function sheet(items) {
  const d = dialog(h('div', {}, items.filter(Boolean).map((it, i) => it === '-' ? h('hr', { style: { '--i': i } }) : h('button', { className: it.danger ? 'danger' : '', style: { '--i': i }, onclick: () => { d.close(); it.run(); } }, it.icon && icon(it.icon), it.label))), { className: 'sheet' });
}
function pickFiles(accept, multiple = true) {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept, multiple });
    i.onchange = () => res([...i.files]);
    i.click();
  });
}

// ---- state ----------------------------------------------------------------------
const S = {
  folders: [], projects: [], tracks: [], usage: 0, limit: 10e9, online: true,
  view: { type: 'home' }, homeFolder: null, sort: store.get('sort', 'newest'), q: '', tag: '',
  open: new Set(store.get('open', [])), offline: new Set(store.get('offline', [])),
  filter: blankFilter(), select: null, trash: 0, comments: {},
};
const projectOf = id => S.projects.find(p => p.id === id);
const trackOf = id => S.tracks.find(t => t.id === id);
const setView = v => { S.view = v; S.arrange = false; S.select = null; store.set('view', v); document.body.classList.remove('side-open'); render(); };

async function load() {
  try {
    const d = await api('/tree');
    Object.assign(S, d, { online: true });
    store.set('tree', d);
    if (d.me?.needsDrive) return driveStep();
    if (d.me && !d.me.isAdmin && !d.projects.length && !d.trash) firstProject();
    // once per session: if Backblaze is refusing files (key or daily limit), say so straight away
    if (!S.checkedStorage && S.tracks.length) { S.checkedStorage = true; storageProblem().then(why => why && toast(why, { error: true, ms: 15000 })); }
  } catch (e) {
    if (e.message === 'Not logged in') return;
    const d = store.get('tree');
    if (d) Object.assign(S, d);
    S.online = false;
    toast("You're offline. Showing your saved library.");
  }
  if (S.view.type === 'project' && !projectOf(S.view.id)) S.view = { type: 'all' };
  render();
  const back = new URLSearchParams(location.search).get('drive');
  if (back) { history.replaceState(null, '', '/'); toast(back === 'connected' ? 'Google Drive connected' : back, { error: back !== 'connected', ms: 6000 }); }
  const deep = new URLSearchParams(location.search).get('track');
  if (deep) { history.replaceState(null, '', '/'); if (trackOf(deep)) detailsDialog(trackOf(deep)); }
}

function showLogin() {
  if ($('#login')) return;
  const box = h('div', { id: 'login', className: 'login' });
  const d = dialog(box);
  d.addEventListener('cancel', e => e.preventDefault());
  const head = h('div', { className: 'disc', style: { width: '56px', height: '56px', justifySelf: 'center', animation: 'spin 14s linear infinite' } });
  const field = (type, auto, extra = {}) => h('input', { type, autocomplete: auto, autocapitalize: 'none', spellcheck: false, ...extra });
  const err = () => h('p', { className: 'form-err' });
  const big = { width: '100%', height: '42px' };
  const link = (text, fn) => h('button', { type: 'button', className: 'linkish', onclick: fn }, text);
  const form = (submit, ...kids) => h('form', { className: 'stack', async onsubmit(e) {
    e.preventDefault();
    const btn = this.querySelector('.primary'), msg = this.querySelector('.form-err');
    btn.disabled = true; msg.textContent = '';
    try { await submit(); } catch (x) { msg.textContent = x.message; }
    btn.disabled = false;
  } }, ...kids);

  // Sign in: username + password, or just the admin password.
  function signIn() {
    const user = field('text', 'username', { placeholder: 'leave empty for admin' }), pw = field('password', 'current-password', { required: true });
    fill(box, head, h('div', { className: 'brandmark' }, '[vault]'), form(async () => {
      await api('/login', { method: 'POST', body: { username: user.value.trim(), password: pw.value } });
      d.close(); load();
    }, h('label', {}, '[username]', user), h('label', {}, '[password]', pw), err(), h('button', { className: 'btn primary', style: big }, 'Sign in')),
    link('Have an invite code? Sign up', signUp),
    h('small', { className: 'login-links' }, h('a', { href: '/about' }, 'About'), h('a', { href: '/privacy' }, 'Privacy'), h('a', { href: '/terms' }, 'Terms')));
  }
  // Sign up, step 1: the invite code.
  function signUp() {
    const code = field('text', 'one-time-code', { required: true, placeholder: 'XXXX-XXXX', style: { textTransform: 'uppercase', textAlign: 'center', letterSpacing: '.12em' } });
    fill(box, head, h('div', { className: 'brandmark' }, '[sign up]'), form(async () => {
      await api('/signup', { method: 'POST', body: { invite: code.value, checkOnly: true } });
      profile(code.value.trim().toUpperCase());
    }, h('label', {}, '[invite code]', code), err(), h('button', { className: 'btn primary', style: big }, 'Next')),
    link('Back to sign in', signIn));
  }
  // Step 2: username, password and an optional profile picture.
  function profile(invite) {
    let avatar = null;
    const pic = h('button', { type: 'button', className: 'avatar xl pick', 'aria-label': 'Choose a profile picture', async onclick() {
      const [file] = await pickFiles('image/*,.heic,.heif', false);
      if (!file) return;
      try { avatar = await avatarData(file); paintAvatar(pic, avatar); } catch (e) { oops(e); }
    } }, icon('plus', 20));
    const user = field('text', 'username', { required: true, minLength: 3, maxLength: 24, pattern: '[A-Za-z0-9._\\-]+', placeholder: 'letters, numbers, . _ -' });
    const pw = field('password', 'new-password', { required: true, minLength: 8 }), again = field('password', 'new-password', { required: true });
    fill(box, h('div', { className: 'brandmark' }, '[your account]'), form(async () => {
      if (pw.value !== again.value) throw new Error("The passwords don't match.");
      await api('/signup', { method: 'POST', body: { invite, username: user.value.trim(), password: pw.value, avatar } });
      driveStep(box, d);
    }, pic, h('small', { className: 'muted' }, 'Profile picture (optional)'),
    h('label', {}, '[username]', user), h('label', {}, '[password] 8+ characters', pw), h('label', {}, '[password again]', again), err(),
    h('button', { className: 'btn primary', style: big }, 'Create account')),
    link('Back', signUp));
  }
  signIn();
}
// Step 3 of sign-up (and shown on sign-in until it's done): connect Google Drive, where this account's music is kept.
function driveStep(box, d) {
  if (!box) { if ($('#login')) return; box = h('div', { id: 'login', className: 'login' }); d = dialog(box); d.addEventListener('cancel', e => e.preventDefault()); }
  fill(box, h('div', { className: 'stack' }, h('div', { className: 'brandmark' }, '[connect drive]'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Your music is stored in your own Google Drive, in a folder called [vault]. The app can only see files it puts there, nothing else in your Drive.'),
    h('a', { className: 'btn primary', href: '/api/drive/connect', style: { width: '100%', height: '42px', display: 'grid', placeItems: 'center' } }, 'Connect Google Drive'),
    h('small', { className: 'muted' }, 'Google may warn that the app isn\'t verified. Tap Advanced → Go to [vault] to continue.'),
    h('button', { type: 'button', className: 'linkish', onclick: logout }, 'Log out')));
}
// Profile pictures: a 256px square JPEG made here, kept with the account.
async function avatarData(file) {
  const img = await loadImg(await toJpeg(file));
  const n = Math.min(img.naturalWidth, img.naturalHeight), c = h('canvas', { width: 256, height: 256 });
  c.getContext('2d').drawImage(img, (img.naturalWidth - n) / 2, (img.naturalHeight - n) / 2, n, n, 0, 0, 256, 256);
  return c.toDataURL('image/jpeg', 0.85);
}
function paintAvatar(el, src, name = '') {
  el.classList.toggle('has', !!src);
  el.style.backgroundImage = src ? `url("${src}")` : '';
  fill(el, src ? '' : (name[0] || '?').toUpperCase());
}
const avatarEl = (me, cls = 'avatar') => { const a = h('span', { className: cls }); paintAvatar(a, me?.avatar, me?.username); return a; };
// Logging out also forgets this account's songs kept on the device, so the next person doesn't get them.
async function logout() {
  await fetch('/api/logout').catch(() => {});
  try { localStorage.removeItem('tree'); localStorage.removeItem('offline'); localStorage.removeItem('view'); } catch {}
  await Promise.all(['audio', 'played'].map(c => caches.delete(c).catch(() => {})));
  location.reload();
}

// ---- rendering ------------------------------------------------------------------
function render() { renderSide(); renderMain(); }

function renderSide() {
  const side = $('#side');
  const count = id => S.tracks.filter(t => t.project_id === id).length;
  const projectNav = (p, depth) => h('button', {
    className: 'nav' + (S.view.type === 'project' && S.view.id === p.id ? ' on' : ''), style: { paddingLeft: 8 + depth * 14 + 'px' },
    onclick: () => setView({ type: 'project', id: p.id }),
    onpointerdown(e) { sideDragStart(e, 'project', p, this); },
    ondragover(e) { if (e.dataTransfer.types.includes('text/x-track') || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); this.classList.add('target'); } },
    ondragleave() { this.classList.remove('target'); },
    async ondrop(e) {
      this.classList.remove('target');
      const id = e.dataTransfer.getData('text/x-track');
      if (id) { e.preventDefault(); e.stopPropagation(); await api(`/tracks/${id}`, { method: 'PATCH', body: { project_id: p.id } }).catch(oops); load(); return; }
      if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); hideDrop(); handleDrop(e.dataTransfer, p.id); }
    },
  }, h('span', { className: 'caret' }), thumb(p.cover), h('span', { className: 'label' }, p.name), h('span', { className: 'count' }, count(p.id)));

  const tree = (parent, depth) => [
    ...S.folders.filter(f => (f.parent_id || null) === parent).map(f => {
      const open = S.open.has(f.id);
      return [
        h('button', {
          className: 'nav', style: { paddingLeft: 10 + depth * 14 + 'px' }, 'data-folder': f.id,
          onclick() { open ? S.open.delete(f.id) : S.open.add(f.id); store.set('open', [...S.open]); S.justOpened = open ? null : f.id; renderSide(); S.justOpened = null; },
          onpointerdown(e) { sideDragStart(e, 'folder', f, this); },
          oncontextmenu(e) { e.preventDefault(); folderMenu(f); },
        }, h('span', { className: 'caret' + (open ? ' open' : '') }, icon('chevron', 12)), folderGlyph(f), h('span', { className: 'label' }, f.name),
        h('span', { className: 'icon-btn sm more', role: 'button', tabIndex: 0, 'aria-label': 'Folder options', onclick(e) { e.stopPropagation(); folderMenu(f); } }, icon('more', 16))),
        open && h('div', { className: 'tree-kids' + (S.justOpened === f.id ? ' opening' : '') }, tree(f.id, depth + 1)),
      ];
    }),
    ...S.projects.filter(p => (p.folder_id || null) === parent).map(p => projectNav(p, depth)),
  ];

  const pct = Math.min(100, (S.usage / S.limit) * 100);
  const navItem = (type, label, n, ic) => h('button', { className: 'nav' + (S.view.type === type ? ' on' : ''), onclick: () => setView({ type }) },
    ic && h('span', { className: 'nav-ic' }, icon(ic, 16)), h('span', { className: 'label' }, label), h('span', { className: 'count' }, n));
  fill(side,
    h('div', { className: 'brand' }, h('button', { className: 'brand-home', 'aria-label': 'Home', title: 'Home', onclick: () => setView({ type: 'home' }) }, '[vault]'), !S.online && h('span', { className: 'mono' }, '[offline]'),
      S.me && h('button', { className: 'me', title: `Signed in as ${S.me.username}`, 'aria-label': `Account: ${S.me.username}`, onclick: () => settingsDialog('account') }, avatarEl(S.me))),
    navItem('home', 'Home', '', 'home'),
    navItem('all', 'All tracks', S.tracks.length, 'music'),
    navItem('starred', 'Starred', S.tracks.filter(t => t.mark === 'star').length, 'star'),
    navItem('offline', 'Downloaded', S.tracks.filter(isOffline).length, 'download'),
    navItem('trash', 'Recently deleted', S.trash || 0, 'trash'),
    h('div', { className: 'section', 'data-root': '', title: 'Drop here to move to the top level' }, h('span', { className: 'mono' }, '[library]'), h('span', { className: 'tools' },
      h('button', { className: 'icon-btn sm', title: 'New folder', 'aria-label': 'New folder', onclick: () => newFolder(null) }, icon('folderPlus', 16)),
      h('button', { className: 'icon-btn sm', title: 'New project', 'aria-label': 'New project', onclick: () => newProject(null) }, icon('plus', 16)))),
    tree(null, 0),
    h('button', { className: 'nav settings-nav', onclick: () => settingsDialog() }, icon('gear', 16), h('span', { className: 'label' }, 'Settings')),
    h('button', { className: 'meter mono', title: 'Manage storage', 'aria-label': `Storage: ${fmtBytes(S.usage)} of ${fmtBytes(S.limit)} used. Manage storage`, onclick: storageDialog },
      `${fmtBytes(S.usage)} / ${fmtBytes(S.limit)}`, h('div', { className: 'bar' + (pct > 90 ? ' full' : '') }, h('i', { style: { width: pct + '%' } }))),
  );
}

function visibleTracks() {
  let list = S.view.type === 'project' ? S.tracks.filter(t => t.project_id === S.view.id)
    : S.view.type === 'offline' ? S.tracks.filter(isOffline)
      : S.view.type === 'starred' ? S.tracks.filter(t => t.mark === 'star') : [...S.tracks];
  const q = S.q.toLowerCase();
  if (q) list = list.filter(t => [t.name, t.tags, t.notes, t.artist, projectOf(t.project_id)?.name].some(v => (v || '').toLowerCase().includes(q)));
  const f = S.filter;
  if (f.tag) list = list.filter(t => tagsOf(t).includes(f.tag));
  if (f.bpmMin) list = list.filter(t => t.bpm && t.bpm >= +f.bpmMin);
  if (f.bpmMax) list = list.filter(t => t.bpm && t.bpm <= +f.bpmMax);
  if (f.key) list = list.filter(t => t.musical_key === f.key);
  if (f.mode) list = list.filter(t => (t.musical_key || '').endsWith(' ' + f.mode));
  if (f.throw) list = list.filter(t => (t.mark === 'throw') === (f.throw === 'only'));
  const by = {
    manual: (a, b) => a.position - b.position,
    newest: (a, b) => b.created_at - a.created_at,
    oldest: (a, b) => a.created_at - b.created_at,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    bpm: (a, b) => (a.bpm ?? 1e9) - (b.bpm ?? 1e9),
    key: (a, b) => (KEYS.indexOf(a.musical_key) + 1 || 99) - (KEYS.indexOf(b.musical_key) + 1 || 99),
    length: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
  };
  const sort = S.view.type !== 'project' && S.sort === 'manual' ? 'newest' : S.sort;
  return list.sort(by[sort] || by.newest);
}
const tagsOf = t => (t.tags || '').split(',').map(s => s.trim()).filter(Boolean);
const filterCount = () => Object.values(S.filter).filter(Boolean).length;

function renderMain() {
  const main = $('#main');
  if (S.view.type === 'trash') { renderBulk(); return renderTrash(); }
  const p = S.view.type === 'project' && projectOf(S.view.id);
  const list = visibleTracks();
  const fc = filterCount();

  const toolbar = h('div', { className: 'toolbar' },
    h('button', { id: 'menu-btn', className: 'icon-btn', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('side-open') }, icon('menu', 20)),
    h('label', { className: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', value: S.q, oninput(e) {
        S.q = e.target.value;
        if (S.view.type !== 'home') return renderList(true);
        setView({ type: 'all' });
        const i = $('.search input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
      } })),
    S.view.type !== 'home' && h('button', { className: 'btn' + (fc ? ' on' : ''), 'aria-label': fc ? `Filters, ${fc} on` : 'Filter', onclick: filterDialog },
      icon('filter', 16), h('span', { className: 'lbl' }, 'Filter'), fc > 0 && h('span', { className: 'badge num' }, fc)),
    S.view.type !== 'home' && h('select', { 'aria-label': 'Sort', onchange(e) { S.sort = e.target.value; store.set('sort', S.sort); renderList(true); } },
      [['manual', 'Custom'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name'], ['bpm', 'BPM'], ['key', 'Key'], ['length', 'Length']]
        .filter(([v]) => p || v !== 'manual').map(([v, l]) => h('option', { value: v, selected: S.sort === v }, l))),
    h('span', { className: 'grow' }),
    h('button', { className: 'btn', onclick: recordDialog, disabled: !S.online, 'aria-label': 'Record' }, icon('mic', 16), h('span', { className: 'lbl' }, 'Record')),
    h('button', { className: 'btn primary', disabled: !S.online, async onclick() { const f = await pickFiles(ACCEPT_AUDIO); f.length && uploadTracks(f, await targetProject()); }, 'aria-label': 'Upload' }, icon('upload', 16), h('span', { className: 'lbl' }, 'Upload')),
  );

  if (S.view.type === 'home') return renderHome(toolbar);

  // Play / Shuffle / Rearrange / Select, or "Done" while rearranging or selecting.
  const busy = S.arrange || S.select;
  const labelled = (ic, text) => [icon(ic, 16), h('span', { className: 'lbl-sm' }, text)];
  const actions = [
    S.arrange ? h('button', { className: 'btn primary', onclick: () => { S.arrange = false; renderMain(); } }, icon('check', 16), 'Done')
      : S.select ? h('button', { className: 'btn primary', onclick: () => { S.select = null; renderMain(); } }, icon('check', 16), 'Done')
        : list.length > 0 && h('button', { className: 'btn primary', onclick: () => playList(list, 0, { shuffle: false }) }, icon('play', 14), 'Play'),
    !busy && list.length > 1 && h('button', { className: 'btn', 'aria-label': 'Shuffle', onclick: () => playList(list, Math.floor(Math.random() * list.length), { shuffle: true }) }, labelled('shuffle', 'Shuffle')),
    p && !busy && list.length > 1 && h('button', { className: 'btn', 'aria-label': 'Rearrange', onclick: () => {
      S.arrange = true;
      if (S.sort !== 'manual') { S.sort = 'manual'; store.set('sort', 'manual'); }
      renderMain();
    } }, labelled('grip', 'Rearrange')),
    !busy && list.length > 0 && h('button', { className: 'btn', 'aria-label': 'Select tracks', onclick: () => { S.select = new Set(); renderMain(); } }, labelled('check', 'Select')),
    S.arrange && h('span', { className: 'mono arrange-hint' }, '[drag the dots to reorder]'),
    S.select && h('span', { className: 'mono arrange-hint' }, '[tap tracks to select]'),
    p && !busy && h('button', { className: 'btn', 'aria-label': 'Share', onclick: () => shareDialog('project', p.id, p.name) }, labelled('share', 'Share')),
    p && !busy && h('button', { className: 'icon-btn', style: { background: 'var(--fill-2)' }, 'aria-label': 'Project options', onclick: () => projectMenu(p) }, icon('more', 18)),
  ];
  const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
  const count = `${list.length} ${list.length === 1 ? 'track' : 'tracks'} · ${fmtTime(dur)}${fc ? ' · filtered' : ''}`;
  const hero = p
    ? h('div', { className: 'hero' },
      h('button', { className: 'art' + (p.cover ? '' : ' disc'), style: bg(p.cover), 'aria-label': 'Change cover', onclick: () => setCover('projects', p) },
        h('span', { className: 'hint' }, p.cover ? '[change cover]' : '[add cover]')),
      h('div', {},
        h('div', { className: 'eyebrow' }, '[project]'),
        h('h1', {}, p.name),
        h('div', { className: 'meta mono' }, count),
        h('div', { className: 'actions' }, actions)))
    : h('div', { className: 'hero' }, h('div', {},
      h('div', { className: 'eyebrow' }, { offline: '[on this device]', starred: '[favourites]' }[S.view.type] || '[library]'),
      h('h1', {}, { offline: 'Downloaded', starred: 'Starred' }[S.view.type] || 'All tracks'),
      h('div', { className: 'meta mono' }, S.view.type === 'offline' ? 'saved for offline listening' : S.view.type === 'starred' || fc ? count : `${S.tracks.length} tracks · ${S.projects.length} projects`),
      h('div', { className: 'actions' }, actions)));

  // Animate only when the view itself changes, not on every refresh.
  const key = JSON.stringify(S.view);
  const fresh = key !== lastView; lastView = key;
  main.replaceChildren(toolbar, hero, h('div', { className: 'tracks', id: 'tracks' }));
  main.classList.toggle('enter', fresh);
  if (fresh) main.scrollTop = 0;
  renderList(fresh);
  renderBulk();
}
let lastView = null;

// ---- home: a gallery of what's in the vault ----------------------------------------------------
function renderHome(toolbar) {
  const main = $('#main');
  const under = (folderId, fid) => { for (let x = folderId; x; x = S.folders.find(f => f.id === x)?.parent_id) if (x === fid) return true; return false; };
  const tracksOf = id => S.tracks.filter(t => t.project_id === id).sort((x, y) => x.position - y.position);
  const activity = p => Math.max(p.created_at || 0, ...tracksOf(p.id).map(t => t.created_at));
  if (S.homeFolder && !S.folders.some(f => f.id === S.homeFolder)) S.homeFolder = null;
  const projects = S.projects.filter(p => !S.homeFolder || under(p.folder_id, S.homeFolder)).sort((x, y) => activity(y) - activity(x));
  let n = 0; // stagger index
  const card = p => {
    const list = tracksOf(p.id);
    return h('div', { className: 'card', role: 'button', tabIndex: 0, style: { '--i': Math.min(n++, 14) }, onclick: () => setView({ type: 'project', id: p.id }),
      onkeydown(e) { if (e.key === 'Enter') setView({ type: 'project', id: p.id }); } },
      h('span', { className: 'card-art' + (p.cover ? '' : ' disc'), style: bg(p.cover) },
        list.length > 0 && h('button', { className: 'card-play', 'aria-label': `Play ${p.name}`, onclick(e) { e.stopPropagation(); playList(list, 0, { shuffle: false }); } }, icon('play', 16))),
      h('span', { className: 'card-t' }, p.name),
      h('span', { className: 'card-s mono' }, `${list.length} ${list.length === 1 ? 'track' : 'tracks'}`));
  };
  const trackCard = (t, list, i) => h('button', { className: 'tcard', style: { '--i': Math.min(n++, 14) }, onclick: () => playList(list, i) },
    thumb(coverOf(t), 'tcard-art' + (t.mark === 'star' ? ' starred' : ''), h('span', { className: 'tcard-play' }, icon('play', 14))),
    h('span', { className: 'tcard-t' }, t.name),
    h('span', { className: 'tcard-s' }, [t.artist, projectOf(t.project_id)?.name].filter(Boolean).join(' · ')));
  const shelf = (title, list, more) => list.length > 0 && h('section', { className: 'shelf' },
    h('div', { className: 'shelf-h' }, h('h2', {}, title), more && h('button', { className: 'btn ghost', onclick: more }, 'See all')),
    h('div', { className: 'shelf-row' }, list.map((t, i) => trackCard(t, list, i))));
  const newest = [...S.tracks].sort((x, y) => y.created_at - x.created_at);
  const recent = store.get('recent', []).map(trackOf).filter(Boolean).slice(0, 12);
  const starred = newest.filter(t => t.mark === 'star').slice(0, 12);
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'up late' : hour < 12 ? 'good morning' : hour < 18 ? 'good afternoon' : 'good evening';
  const topFolders = S.folders.filter(f => !f.parent_id);
  const chips = topFolders.length > 0 && h('div', { className: 'chips-row', role: 'tablist', 'aria-label': 'Folders' },
    h('button', { className: 'chip' + (!S.homeFolder ? ' on' : ''), role: 'tab', 'aria-selected': !S.homeFolder, onclick: () => { S.homeFolder = null; renderMain(); } }, 'All'),
    topFolders.map(f => h('button', { className: 'chip' + (S.homeFolder === f.id ? ' on' : ''), role: 'tab', 'aria-selected': S.homeFolder === f.id, onclick: () => { S.homeFolder = f.id; renderMain(); } }, folderGlyph(f, 14), f.name)));

  const page = h('div', { className: 'home' },
    h('div', { className: 'home-hero' },
      h('div', { className: 'eyebrow' }, `[${hello}]`),
      h('h1', {}, 'Home'),
      h('div', { className: 'meta mono' }, `${S.tracks.length} tracks · ${S.projects.length} projects`)),
    !S.tracks.length && !S.projects.length && h('div', { className: 'empty' }, h('span', { className: 'disc' }), h('b', {}, 'Nothing here yet'), 'Make a project, then drag audio files in or press Upload.'),
    S.projects.length > 0 && h('section', { className: 'shelf' },
      h('div', { className: 'shelf-h' }, h('h2', {}, 'Projects'), h('button', { className: 'btn ghost', onclick: () => newProject(S.homeFolder) }, icon('plus', 15), 'New')),
      chips,
      projects.length ? h('div', { className: 'card-grid' }, projects.map(card)) : h('div', { className: 'muted' }, 'No projects in this folder yet.')),
    shelf('Jump back in', recent),
    shelf('Starred', starred, () => setView({ type: 'starred' })),
    shelf('Recently added', newest.slice(0, 12), () => setView({ type: 'all' })));

  const key = JSON.stringify(S.view) + S.homeFolder;
  const fresh = key !== lastView; lastView = key;
  main.replaceChildren(toolbar, page);
  main.classList.toggle('enter', fresh);
  if (fresh) main.scrollTop = 0;
  renderBulk();
}

function renderList(animate = false) {
  const box = $('#tracks');
  if (!box) return;
  const list = visibleTracks();
  const p = S.view.type === 'project';
  const manual = p && S.sort === 'manual';
  box.classList.remove('stagger');
  box.classList.toggle('arranging', !!S.arrange && p);
  box.classList.toggle('selecting', !!S.select);
  if (animate) { void box.offsetWidth; box.classList.add('stagger'); }
  if (!list.length) {
    const filtered = S.q || filterCount();
    box.replaceChildren(h('div', { className: 'empty' },
      h('span', { className: 'disc' }),
      h('b', {}, filtered ? 'No matches' : 'Nothing here yet'),
      filtered ? 'Try a different search, or clear the filters.' : 'Drag audio files or folders here, or press Upload.',
      filterCount() > 0 && h('button', { className: 'btn', style: { marginTop: '10px' }, onclick: () => { S.filter = blankFilter(); renderMain(); } }, 'Clear filters')));
    return;
  }
  let dragId = null;
  fill(box,
    h('div', { className: 'trow thead' }, h('span'), h('span', {}, '[title]'), h('span', { className: 'c-wave' }), h('span', { className: 'cell c-bpm' }, '[bpm]'), h('span', { className: 'cell c-key' }, '[key]'), h('span', { className: 'cell' }, '[time]'), h('span'), h('span'), h('span')),
    list.map((t, i) => h('div', {
      className: 'trow' + (cur?.id === t.id ? ' on' : '') + (S.select?.has(t.id) ? ' selected' : '') + (t.mark === 'throw' ? ' throw' : '') + (justMarked?.id === t.id && justMarked.mark === 'throw' ? ' just-throw' : ''),
      draggable: !S.arrange && !S.select, 'data-id': t.id, style: { '--i': i },
      'aria-selected': S.select ? String(S.select.has(t.id)) : null,
      onclick() {
        if (this.dataset.swiped) return;
        if (S.select) {
          S.select.has(t.id) ? S.select.delete(t.id) : S.select.add(t.id);
          this.classList.toggle('selected', S.select.has(t.id));
          this.setAttribute('aria-selected', S.select.has(t.id));
          renderBulk();
        } else if (!S.arrange) playList(list, i);
      },
      ondragstart(e) { dragId = t.id; e.dataTransfer.setData('text/x-track', t.id); e.dataTransfer.effectAllowed = 'move'; },
      ondragover(e) { if (manual && dragId && dragId !== t.id) { e.preventDefault(); this.classList.add('drag-over'); } },
      ondragleave() { this.classList.remove('drag-over'); },
      ondrop(e) {
        this.classList.remove('drag-over');
        if (!manual || !dragId) return;
        e.preventDefault(); e.stopPropagation();
        const ids = list.map(x => x.id).filter(id => id !== dragId);
        ids.splice(ids.indexOf(t.id), 0, dragId);
        reorder(ids);
      },
    },
    // Selecting: a tick box. Inside a project: the track number (the playing one turns into bars). Elsewhere: the cover.
    S.select ? h('span', { className: 'sel-box' }, icon('check', 14))
      : p ? h('span', { className: 'tnum num' }, h('b', {}, i + 1), h('span', { className: 'bars' }, h('i'), h('i'), h('i')))
        : thumb(coverOf(t), 'thumb', h('span', { className: 'bars' }, h('i'), h('i'), h('i'))),
    h('div', { style: { minWidth: 0 } },
      h('div', { className: 'name' }, t.name),
      h('div', { className: 'sub' },
        isOffline(t) && h('span', { className: 'saved', title: 'Saved offline' }, icon('download', 12)),
        t.mark === 'throw' && h('span', { className: 'tag throw-tag' }, 'throwaway'),
        t.notes && h('span', { className: 'saved', title: 'Has notes' }, icon('note', 12)),
        S.comments[t.id] > 0 && h('span', { className: 'saved', title: `${S.comments[t.id]} comments` }, icon('comment', 12), S.comments[t.id]),
        h('span', {}, [t.artist, !p && projectOf(t.project_id)?.name, fmtAdded(t.created_at)].filter(Boolean).join(' · ')),
        tagsOf(t).map(x => h('span', { className: 'tag' }, x)))),
    waveCell(t),
    h('span', { className: 'cell c-bpm num' }, t.bpm ? Math.round(t.bpm * 10) / 10 : '–'),
    h('span', { className: 'cell c-key num' }, t.musical_key || '–'),
    h('span', { className: 'cell num' }, fmtTime(t.duration)),
    S.arrange || S.select ? markDot(t, 'star') : starBtn(t),
    S.arrange || S.select ? markDot(t, 'throw') : throwBtn(t),
    S.arrange && p
      ? h('span', { className: 'grip', role: 'button', tabIndex: 0, 'aria-label': `Move ${t.name}. Drag, or use the arrow keys.`,
          onpointerdown(e) { startReorder(e, this.closest('.trow')); },
          onclick(e) { e.stopPropagation(); },
          onkeydown(e) {
            const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
            if (!d || i + d < 0 || i + d >= list.length) return;
            e.preventDefault();
            const ids = list.map(x => x.id); ids.splice(i + d, 0, ids.splice(i, 1)[0]);
            reorder(ids).then(() => document.querySelector(`.trow[data-id="${t.id}"] .grip`)?.focus());
          } }, icon('grip', 18))
      : S.select ? h('span')
        : h('button', { className: 'icon-btn', 'aria-label': 'Track options', onclick(e) { e.stopPropagation(); trackMenu(t, list); } }, icon('more', 18)))),
  );
  marquees(box);
}
// Highlight the playing row without re-rendering (so the list doesn't re-animate).
// Two densities: 30 bars for the column, 90 when it stretches under the playing row on smaller screens.
const waveHtml = p => `<span class="wv wv-col">${waveSvg(p, 30)}</span><span class="wv wv-wide">${waveSvg(p, 90)}</span>`;
// A track's waveform. On the playing track it fills as it plays, and tapping it jumps there.
function waveCell(t) {
  const el = h('span', { className: 'c-wave' + (t.peaks ? '' : ' none'),
    onclick(e) {
      if (cur?.id !== t.id || !audio.duration || S.select || S.arrange) return;
      e.stopPropagation();
      const r = this.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audio.duration;
    } });
  if (t.peaks) el.innerHTML = waveHtml(t.peaks); // after h(), which replaces children
  return el;
}
// While selecting or rearranging the buttons step aside, but marked tracks still show their star / throwaway.
const markDot = (t, mark) => h('span', { className: 'mark-dot ' + mark, title: t.mark === mark ? (mark === 'star' ? 'Starred' : 'Throwaway') : null },
  t.mark === mark && icon(mark === 'star' ? 'star' : 'ban', 16));
let justMarked = null; // { id, mark } of the track you just marked: only it animates, not the whole redrawn list
const starBtn = (t, cls = '') => h('button', { className: 'icon-btn star ' + cls + (t.mark === 'star' ? ' on' : '') + (justMarked?.id === t.id && justMarked.mark === 'star' ? ' pop' : ''), 'aria-label': t.mark === 'star' ? `Unstar ${t.name}` : `Star ${t.name}`, 'aria-pressed': t.mark === 'star', title: t.mark === 'star' ? 'Starred' : 'Star',
  onclick(e) { e.stopPropagation(); haptic(); setMark(t, t.mark === 'star' ? null : 'star'); } }, icon('star', 17));
const throwBtn = (t, cls = '') => h('button', { className: 'icon-btn throw-btn ' + cls + (t.mark === 'throw' ? ' on' : '') + (justMarked?.id === t.id && justMarked.mark === 'throw' ? ' pop' : ''), 'aria-label': t.mark === 'throw' ? 'Not a throwaway' : 'Mark as throwaway', 'aria-pressed': t.mark === 'throw', title: t.mark === 'throw' ? 'Throwaway' : 'Mark as throwaway',
  onclick(e) { e.stopPropagation(); haptic(); setMark(t, t.mark === 'throw' ? null : 'throw'); } }, icon('ban', 17));

// Star = favourite, throwaway = probably not using it. One or the other (or neither). Shows straight away, saves in the background.
async function setMark(t, mark) {
  const before = t.mark ?? null, all = [t, trackOf(t.id), cur?.id === t.id && cur, ...queue.filter(x => x.id === t.id)].filter(Boolean);
  all.forEach(x => { x.mark = mark; });
  justMarked = mark ? { id: t.id, mark } : null;
  setTimeout(() => { if (justMarked?.id === t.id) justMarked = null; }, 600);
  renderSide(); renderList(); if (cur?.id === t.id) renderPlayer();
  if (mark === 'throw') toast(`“${t.name}” marked as a throwaway`, { ms: 4000, action: { label: 'Undo', run: () => setMark(t, before) } });
  try { await api(`/tracks/${t.id}`, { method: 'PATCH', body: { mark } }); }
  catch (e) { all.forEach(x => { x.mark = before; }); renderSide(); renderList(); oops(e); }
}

// Phones: text too long for its line scrolls sideways (pause, glide, loop), like the iOS Music player.
const phone = matchMedia('(max-width: 760px)');
function marquee(el) {
  if (el.classList.contains('marquee') || el.scrollWidth <= el.clientWidth + 1) return;
  const w = el.scrollWidth, gap = 36, dist = w + gap;
  const inner = h('span', { className: 'mq-in' }); inner.append(...el.childNodes);
  const copy = inner.cloneNode(true); copy.setAttribute('aria-hidden', 'true');
  el.replaceChildren(h('span', { className: 'mq', style: { '--mq-d': dist + 'px', '--mq-t': (dist / 32 / 0.75).toFixed(1) + 's' } }, inner, copy));
  el.classList.add('marquee');
}
const marquees = root => { if (phone.matches && settings.motion) root.querySelectorAll('.trow:not(.thead) .name, .trow:not(.thead) .sub, #player .np .t, #player .np .p').forEach(marquee); };

function markPlaying() {
  document.querySelectorAll('.trow[data-id]').forEach(r => r.classList.toggle('on', r.dataset.id === cur?.id));
}

// Drag a track by its grip: it follows the pointer, the others slide aside, and the list scrolls near the edges.
let dragging = false;
function startReorder(e, row) {
  e.preventDefault(); e.stopPropagation();
  const box = row.parentNode, rows = [...box.querySelectorAll('.trow[data-id]')], from = rows.indexOf(row);
  const step = rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : row.offsetHeight;
  const scroller = $('#main'), y0 = e.clientY, s0 = scroller.scrollTop;
  let to = from, lastY = e.clientY, raf = 0;
  dragging = true;
  row.classList.add('lifting'); box.classList.add('reordering');
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  const layout = () => {
    const dy = lastY - y0 + (scroller.scrollTop - s0);
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
    row.style.transform = `translateY(${dy}px) scale(1.02)`;
    rows.forEach((r, i) => {
      if (r === row) return;
      const shift = from < to && i > from && i <= to ? -step : from > to && i < from && i >= to ? step : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const autoscroll = () => {
    const r = scroller.getBoundingClientRect(), edge = 80;
    const v = lastY < r.top + edge ? -(r.top + edge - lastY) / 5 : lastY > r.bottom - edge ? (lastY - (r.bottom - edge)) / 5 : 0;
    if (v) { scroller.scrollTop += v; layout(); }
    raf = requestAnimationFrame(autoscroll);
  };
  const move = ev => { if (ev.pointerId === e.pointerId) { lastY = ev.clientY; layout(); } };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
    dragging = false;
    rows.forEach(r => { r.style.transform = ''; r.classList.remove('lifting'); });
    box.classList.remove('reordering');
    if (to !== from) { const ids = rows.map(r => r.dataset.id); ids.splice(to, 0, ids.splice(from, 1)[0]); reorder(ids); }
  };
  addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
  raf = requestAnimationFrame(autoscroll);
}

// Drag a project or folder in the sidebar onto a folder (or [library] for the top level).
// Mouse: just drag. Touch: press and hold briefly, then drag, so normal scrolling still works.
let sideDrag = null, suppressClick = false;
function sideDragStart(e, kind, item, el) {
  if (e.button > 0 || e.target.closest('.more')) return;
  const touch = e.pointerType !== 'mouse', side = $('#side');
  const st = { x: e.clientX, y: e.clientY, active: false, target: null, timer: 0, ghost: null };
  sideDrag = st;
  // folders can't go inside themselves or their own subfolders
  const blocked = new Set(kind === 'folder' ? [item.id] : []);
  if (kind === 'folder') for (let grew = true; grew;) { grew = false; for (const f of S.folders) if (blocked.has(f.parent_id) && !blocked.has(f.id)) { blocked.add(f.id); grew = true; } }
  const begin = () => {
    st.active = dragging = true;
    el.classList.add('drag-src');
    try { el.setPointerCapture(e.pointerId); } catch {}
    st.ghost = h('div', { className: 'side-ghost' }, icon(kind === 'folder' ? 'folder' : 'disc', 14), h('span', {}, item.name));
    document.body.append(st.ghost);
    navigator.vibrate?.(12);
    place();
  };
  const place = () => {
    st.ghost.style.left = st.x + 'px'; st.ghost.style.top = st.y + 'px';
    const hit = document.elementFromPoint(st.x, st.y)?.closest('#side [data-folder], #side [data-root]');
    const ok = hit && !(hit.dataset.folder && blocked.has(hit.dataset.folder));
    if (st.target !== (ok ? hit : null)) { st.target?.classList.remove('target'); st.target = ok ? hit : null; st.target?.classList.add('target'); }
    const r = side.getBoundingClientRect(); // scroll the sidebar near its edges
    if (st.y < r.top + 50) side.scrollTop -= 8; else if (st.y > r.bottom - 50) side.scrollTop += 8;
  };
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const d = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY);
    if (!st.active) {
      if (touch) { if (d > 8) stop(); return; } // moved before the hold finished: it's a scroll
      if (d < 6) return;
      begin();
    }
    st.x = ev.clientX; st.y = ev.clientY; place();
  };
  const stop = async ev => {
    clearTimeout(st.timer);
    removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop);
    if (sideDrag === st) sideDrag = null;
    if (!st.active) return;
    dragging = false;
    el.classList.remove('drag-src'); st.ghost.remove(); st.target?.classList.remove('target');
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    if (!st.target || ev?.type === 'pointercancel') return;
    const to = st.target.dataset.folder || null;
    const current = kind === 'folder' ? item.parent_id || null : item.folder_id || null;
    if (to === current) return;
    if (to) { S.open.add(to); store.set('open', [...S.open]); }
    await api(`/${kind === 'folder' ? 'folders' : 'projects'}/${item.id}`, { method: 'PATCH', body: kind === 'folder' ? { parent_id: to } : { folder_id: to } }).catch(oops);
    toast(`Moved “${item.name}” ${to ? 'into ' + (S.folders.find(f => f.id === to)?.name || 'folder') : 'to the top level'}`, { ms: 2000 });
    load();
  };
  if (touch) st.timer = setTimeout(() => { if (sideDrag === st) begin(); }, 380);
  addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
}
// A drag shouldn't also count as a click, and the page must not scroll under a finger that's dragging.
addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
addEventListener('touchmove', e => { if (dragging) e.preventDefault(); }, { passive: false });
addEventListener('contextmenu', e => { if (dragging || sideDrag) e.preventDefault(); });

async function reorder(ids) {
  ids.forEach((id, i) => { trackOf(id).position = i; });
  renderList();
  await api('/tracks/reorder', { method: 'POST', body: { ids } }).catch(oops);
}

// ---- folders & projects --------------------------------------------------------------
async function newFolder(parent_id) {
  const name = await prompt('New folder');
  if (!name) return;
  const { id } = await api('/folders', { method: 'POST', body: { name, parent_id } }).catch(oops) || {};
  if (parent_id) S.open.add(parent_id);
  store.set('open', [...S.open]);
  id && load();
}
async function newProject(folder_id) {
  const name = await prompt('New project');
  if (!name) return;
  const r = await api('/projects', { method: 'POST', body: { name, folder_id } }).catch(oops);
  if (!r) return;
  if (folder_id) { S.open.add(folder_id); store.set('open', [...S.open]); }
  S.view = { type: 'project', id: r.id }; store.set('view', S.view);
  load();
}
function folderPicker(title, current, exclude) {
  return new Promise(res => {
    const sel = h('select', {}, h('option', { value: '' }, 'Top level'),
      S.folders.filter(f => f.id !== exclude).map(f => h('option', { value: f.id, selected: f.id === current }, f.name)));
    const d = dialog(h('form', { onsubmit(e) { e.preventDefault(); res(sel.value || null); d.close(); } },
      h('h2', {}, title), h('label', {}, 'Folder', sel),
      h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Move'))));
    d.addEventListener('close', () => res(undefined));
  });
}
// Folder icons: one of these, or any emoji. A colour tints the icon.
const FOLDER_ICONS = ['folder', 'star', 'heart', 'music', 'mic', 'headphones', 'disc', 'flame', 'bolt', 'moon', 'sparkle', 'crown', 'archive', 'clock', 'lock', 'tag'];
const FOLDER_COLORS = [['', 'Default'], ['#f5f5f5', 'White'], ['#ff5c5c', 'Red'], ['#ff9a3d', 'Orange'], ['#ffcf45', 'Yellow'], ['#3ecf8e', 'Green'],
  ['#2fd3d3', 'Teal'], ['#4d8dff', 'Blue'], ['#9b7bff', 'Violet'], ['#ff6fb0', 'Pink']];
function folderGlyph(f, size = 16) {
  const name = f.icon || 'folder';
  const el = FOLDER_ICONS.includes(name) ? icon(name, size) : h('span', { className: 'ic emoji', style: { fontSize: size - 1 + 'px', width: size + 'px' } }, name);
  if (f.color) { el.style.color = f.color; el.classList.add('tinted'); }
  return el;
}
const firstGrapheme = s => (!s ? '' : window.Intl?.Segmenter ? [...new Intl.Segmenter().segment(s)][0]?.segment || '' : [...s][0]);
function folderStyleDialog(f) {
  const pick = { icon: f.icon || 'folder', color: f.color || '' };
  const preview = h('div', { className: 'fs-preview' });
  const icons = h('div', { className: 'fs-grid', role: 'radiogroup', 'aria-label': 'Icon' });
  const colors = h('div', { className: 'swatches fs-colors', role: 'radiogroup', 'aria-label': 'Colour' });
  const emoji = h('input', { type: 'text', placeholder: 'Or type any emoji', maxLength: 16, 'aria-label': 'Emoji icon',
    value: FOLDER_ICONS.includes(pick.icon) ? '' : pick.icon,
    oninput() { pick.icon = firstGrapheme(this.value.trim()) || 'folder'; draw(); } });
  function draw() {
    fill(preview, folderGlyph(pick, 30), h('span', {}, f.name));
    fill(icons, FOLDER_ICONS.map(n => h('button', { type: 'button', role: 'radio', className: 'fs-icon' + (pick.icon === n ? ' on' : ''), 'aria-checked': pick.icon === n, 'aria-label': n, title: n,
      onclick() { pick.icon = n; emoji.value = ''; draw(); } }, folderGlyph({ icon: n, color: pick.color }, 20))));
    fill(colors, FOLDER_COLORS.map(([c, label]) => h('button', { type: 'button', role: 'radio', className: 'swatch' + (pick.color === c ? ' on' : '') + (c ? '' : ' plain'), 'aria-checked': pick.color === c, 'aria-label': label, title: label,
      style: { background: c || 'var(--fill-3)' }, onclick() { pick.color = c; draw(); } })));
  }
  draw();
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      await api(`/folders/${f.id}`, { method: 'PATCH', body: { icon: pick.icon === 'folder' ? null : pick.icon, color: pick.color || null } }).catch(oops);
      d.close(); load();
    },
  }, h('h2', {}, 'Icon & colour'), preview,
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Icon'), icons, emoji),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Colour'), colors),
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Save'))));
}

function folderMenu(f) {
  sheet([
    { icon: 'plus', label: 'New project here', run: () => newProject(f.id) },
    { icon: 'folderPlus', label: 'New folder inside', run: () => newFolder(f.id) },
    '-',
    { icon: 'sparkle', label: 'Icon & colour', run: () => folderStyleDialog(f) },
    { icon: 'pencil', label: 'Rename', async run() { const name = await prompt('Rename folder', f.name); name && api(`/folders/${f.id}`, { method: 'PATCH', body: { name } }).then(load, oops); } },
    { icon: 'folder', label: 'Move to…', async run() { const to = await folderPicker('Move folder', f.parent_id, f.id); to !== undefined && api(`/folders/${f.id}`, { method: 'PATCH', body: { parent_id: to } }).then(load, oops); } },
    { icon: 'trash', label: 'Delete folder', danger: true, async run() { (await confirm('Delete folder?', 'Projects and folders inside move up a level. Nothing else is deleted.')) && api(`/folders/${f.id}`, { method: 'DELETE' }).then(load, oops); } },
  ]);
}
function projectMenu(p) {
  const tracks = () => S.tracks.filter(t => t.project_id === p.id).sort((a, b) => a.position - b.position);
  sheet([
    { icon: 'pencil', label: 'Rename', async run() { const name = await prompt('Rename project', p.name); name && api(`/projects/${p.id}`, { method: 'PATCH', body: { name } }).then(load, oops); } },
    { icon: 'folder', label: 'Move to folder…', async run() { const to = await folderPicker('Move project', p.folder_id); to !== undefined && api(`/projects/${p.id}`, { method: 'PATCH', body: { folder_id: to } }).then(load, oops); } },
    { icon: 'image', label: 'Change cover', run: () => setCover('projects', p) },
    p.cover && { icon: 'close', label: 'Remove cover', run: () => api(`/projects/${p.id}`, { method: 'PATCH', body: { cover: null } }).then(load, oops) },
    { icon: 'gauge', label: 'Detect missing BPM & keys', run: () => detectTracks(tracks().filter(t => !t.bpm || !t.musical_key), false) },
    { icon: 'download', label: 'Download as ZIP', run: () => zipTracks(tracks(), p.name, p.cover) },
    { icon: 'download', label: 'Save all offline', run: () => tracks().forEach(saveOffline) },
    '-',
    { icon: 'trash', label: 'Move to trash', danger: true, async run() {
      const n = tracks().length;
      if (!(await confirm(`Move “${p.name}” to the trash?`, `You can restore the project and its ${n} ${n === 1 ? 'track' : 'tracks'} from Recently deleted for 30 days.`, 'Move to trash'))) return;
      await api(`/projects/${p.id}`, { method: 'DELETE' }).catch(oops);
      setView({ type: 'all' }); load();
      toast(`Moved “${p.name}” to the trash`, { ms: 7000, action: { label: 'Undo', run: () => restore('project', p.id) } });
    } },
  ]);
}

// Upload target when not inside a project: the Inbox if there is one, otherwise the newest project,
// and with no projects at all, the person makes their first one.
async function targetProject() {
  if (S.view.type === 'project') return S.view.id;
  const inbox = S.projects.find(p => p.name === 'Inbox' && !p.folder_id);
  if (inbox) return inbox.id;
  const newest = [...S.projects].sort((a, b) => b.created_at - a.created_at)[0];
  return newest ? newest.id : firstProject();
}

// New accounts start by making a project: a name and, if they like, cover art. Resolves with its id.
function firstProject() {
  if ($('#first-project')) return S.firstProject;
  return (S.firstProject = new Promise(res => {
    let file = null;
    const cover = h('button', { type: 'button', className: 'first-cover', 'aria-label': 'Choose cover art', async onclick() {
      const [f] = splitAccepted(await pickFiles(ACCEPT_IMAGE, false), 'cover');
      if (!f) return;
      file = f;
      cover.style.backgroundImage = `url("${URL.createObjectURL(f)}")`;
      cover.classList.add('has');
    } }, icon('plus', 22), h('span', { className: 'mono' }, '[cover art]'));
    const name = h('input', { type: 'text', required: true, maxLength: 200, placeholder: 'e.g. Summer beats', 'aria-label': 'Project name' });
    const err = h('p', { className: 'form-err' });
    const d = dialog(h('form', { id: 'first-project', className: 'stack first-project', async onsubmit(e) {
      e.preventDefault();
      const btn = this.querySelector('.primary');
      btn.disabled = true; err.textContent = '';
      try {
        const { id } = await api('/projects', { method: 'POST', body: { name: name.value.trim() } });
        if (file) await api(`/projects/${id}`, { method: 'PATCH', body: { cover: await uploadFile(await toJpeg(file)) } }).catch(oops);
        S.view = { type: 'project', id }; store.set('view', S.view);
        d.close(); await load(); res(id);
      } catch (x) { err.textContent = x.message; btn.disabled = false; }
    } }, h('h2', {}, 'Make your first project'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Projects hold your tracks, like an album or a folder of ideas. You can make more any time.'),
    cover, h('label', {}, 'Name', name), err,
    h('button', { className: 'btn primary', style: { width: '100%', height: '42px' } }, 'Create project')));
    d.addEventListener('cancel', e => e.preventDefault());
    if (matchMedia("(pointer: fine)").matches) name.focus(); // no keyboard popping up on phones
  }));
}

// ---- uploads --------------------------------------------------------------------------
function put(url, file, contentType, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    Q.xhr = x;
    x.onabort = () => rej(new Error('Cancelled'));
    x.open('PUT', url);
    x.setRequestHeader('content-type', contentType);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? res(x.responseText) : rej(new Error(x.status === 403 ? 'Storage refused the upload (it may be full)' : `Upload failed (${x.status})`)));
    x.onerror = () => rej(new Error('Upload failed. Check your connection.'));
    x.send(file);
  });
}
export async function uploadFile(file, onProgress = () => {}) {
  const r = await api('/upload-url', { method: 'POST', body: { name: file.name, type: file.type, size: file.size } });
  const reply = await put(r.url, file, r.contentType, onProgress);
  if (!r.drive) return r.key;
  const id = JSON.parse(reply || '{}').id; // Google Drive picks the file id and sends it back
  if (!id) throw new Error("Google Drive didn't confirm the upload. Try again.");
  return `drive:${r.drive}:${id}`;
}
const durationOf = file => new Promise(res => {
  const a = new Audio(), u = URL.createObjectURL(file);
  const done = d => { URL.revokeObjectURL(u); res(isFinite(d) ? d : null); };
  a.preload = 'metadata';
  a.onloadedmetadata = () => done(a.duration);
  a.onerror = () => done(null);
  setTimeout(() => done(null), 8000);
  a.src = u;
});
const baseName = n => n.replace(/\.[^.]+$/, '');

// Rejects anything that isn't audio, naming each file.
function splitAccepted(files, kind) {
  const ok = [], bad = [];
  for (const f of files) (kindOf(f.name) === kind && f.size <= MAX[kind] ? ok : bad).push(f);
  for (const f of bad) toast(f.size > MAX[kind] && kindOf(f.name) === kind ? `${f.name} is too big` : `${f.name} isn't ${kind === 'audio' ? 'an audio file' : 'a supported image'}`, { error: true, ms: 6000 });
  return ok;
}

// ---- upload queue -----------------------------------------------------------------------
// Every audio upload goes through one queue, shown in a panel with overall and per-file progress.
const Q = { jobs: [], running: false, expanded: false, minimized: true, hideTimer: 0, xhr: null, speed: 0, sample: null, refresh: 0 };
const fmtSize = b => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const fmtEta = s => (!isFinite(s) || s <= 0 ? '' : s < 60 ? `~${Math.ceil(s)}s left` : s < 3600 ? `~${Math.round(s / 60)} min left` : `~${(s / 3600).toFixed(1)} h left`);

// Adds files to the queue. Resolves once all of them have finished (uploaded, failed or skipped).
function uploadTracks(files, project_id, folder = projectOf(project_id)?.name || '') {
  const seen = new Map(S.tracks.map(t => [`${t.name.toLowerCase()}|${t.size}`, projectOf(t.project_id)?.name || 'your library']));
  for (const j of Q.jobs) if (j.status !== 'skipped') seen.set(`${baseName(j.file.name).toLowerCase()}|${j.size}`, j.folder || 'this upload');
  const jobs = files.map(file => {
    const bad = kindOf(file.name) !== 'audio' ? 'Not an audio file' : file.size > MAX.audio ? 'Too big (over 1 GB)' : null;
    const sig = `${baseName(file.name).toLowerCase()}|${file.size}`;
    const dupOf = !bad && settings.skipDups ? seen.get(sig) : null;
    if (!bad) seen.set(sig, folder || 'this upload');
    const error = bad || (dupOf ? `Already in ${dupOf}` : null);
    return { file, project_id, folder, size: file.size, loaded: 0, status: error ? 'skipped' : 'queued', error, dup: !!dupOf, phase: '', row: null, sig: '' };
  });
  const finished = Promise.all(jobs.map(j => new Promise(res => { j.done = res; if (j.status === 'skipped') res(); })));
  Q.jobs.push(...jobs);
  clearTimeout(Q.hideTimer); Q.panel?.classList.remove('leaving');
  drawQueue(); pump();
  return finished;
}

async function pump() {
  if (Q.running) return;
  Q.running = true; wakeLock(true);
  for (let job; (job = Q.jobs.find(j => j.status === 'queued'));) {
    job.status = 'uploading'; job.phase = 'Preparing'; drawQueue();
    try {
      const duration = await durationOf(job.file);
      const analysing = analyse(job.file, job.file.name, settings.detect);
      job.phase = 'Uploading';
      const file_key = await uploadFile(job.file, p => { job.loaded = p * job.size; drawQueueSoon(); });
      job.phase = settings.detect ? 'Detecting BPM & key' : 'Drawing waveform'; job.loaded = job.size; drawQueue();
      const { bpm, key, peaks } = await analysing;
      job.found = [bpm && bpm + ' BPM', key].filter(Boolean).join(' · ');
      job.phase = 'Saving'; drawQueue();
      await api('/tracks', { method: 'POST', body: { project_id: job.project_id, name: baseName(job.file.name), file_key, duration, bpm, musical_key: key, peaks, artist: settings.artist } });
      job.status = 'done';
      Q.refresh ||= setTimeout(() => { Q.refresh = 0; load(); }, 2500); // refresh the library every few seconds, not after every file
    } catch (e) {
      job.status = e.message === 'Cancelled' ? 'cancelled' : 'failed';
      job.error = e.message; job.loaded = 0;
      if (/Storage full/.test(e.message)) Q.jobs.forEach(j => { if (j.status === 'queued') { j.status = 'failed'; j.error = 'Storage full'; j.done(); } });
    }
    job.done(); drawQueue();
  }
  Q.running = false; Q.xhr = null; wakeLock(false);
  clearTimeout(Q.refresh); Q.refresh = 0; load(); drawQueue();
  autoHide();
}

// Finished uploads tidy themselves away: quickly when everything went fine, after a while when something was skipped.
// Failures stay until you retry or close them. Waits while you're hovering or have the details open.
function autoHide() {
  clearTimeout(Q.hideTimer);
  if (Q.running || !Q.jobs.length || Q.jobs.some(j => j.status === 'failed')) return;
  const wait = Q.jobs.some(j => j.status === 'skipped' || j.status === 'cancelled') ? 9000 : 2500;
  Q.hideTimer = setTimeout(function tryHide() {
    if (Q.running) return;
    if (!Q.minimized || Q.panel.matches(':hover') || Q.panel.contains(document.activeElement)) return (Q.hideTimer = setTimeout(tryHide, 1500));
    Q.panel.classList.add('leaving');
    Q.hideTimer = setTimeout(() => { Q.panel.classList.remove('leaving'); clearQueue(); }, 400);
  }, wait);
}

function cancelQueue() {
  Q.jobs.forEach(j => { if (j.status === 'queued') { j.status = 'cancelled'; j.error = 'Cancelled'; j.done(); } });
  Q.xhr?.abort();
  drawQueue();
}
function retryFailed() {
  Q.jobs.forEach(j => { if (j.status === 'failed' || j.status === 'cancelled') { j.status = 'queued'; j.error = null; j.loaded = 0; j.done = () => {}; } });
  drawQueue(); pump();
}
function clearQueue() {
  Q.jobs = Q.jobs.filter(j => j.status === 'queued' || j.status === 'uploading');
  Q.list?.replaceChildren(); Q.jobs.forEach(j => { j.row = null; j.sig = ''; });
  drawQueue();
}

// Keep the phone awake while uploading, and warn before leaving mid-upload.
let screenLock = null;
async function wakeLock(on) {
  try {
    if (on && !screenLock && navigator.wakeLock) screenLock = await navigator.wakeLock.request('screen');
    else if (!on && screenLock) { await screenLock.release(); screenLock = null; }
  } catch {}
}
addEventListener('beforeunload', e => { if (Q.running) { e.preventDefault(); e.returnValue = ''; } });

let qFrame = 0;
const drawQueueSoon = () => { qFrame ||= requestAnimationFrame(() => { qFrame = 0; drawQueue(); }); };
function drawQueue() {
  if (!Q.panel) {
    Q.title = h('div', { className: 'uq-title' }); Q.pct = h('div', { className: 'uq-pct num' });
    Q.fill = h('i'); Q.bar = h('div', { className: 'uq-bar' }, Q.fill);
    Q.stats = h('div', { className: 'uq-stats num' }); Q.now = h('div', { className: 'uq-now' });
    Q.actions = h('div', { className: 'uq-actions' }); Q.list = h('div', { className: 'uq-list', role: 'list' });
    Q.minBtn = h('button', { className: 'icon-btn sm', 'aria-label': 'Show upload details', onclick: () => { Q.minimized = !Q.minimized; drawQueue(); if (Q.minimized) autoHide(); } }, icon('chevron', 16));
    Q.closeBtn = h('button', { className: 'icon-btn sm', 'aria-label': 'Close uploads', onclick: clearQueue }, icon('close', 16));
    Q.panel = h('section', { className: 'uq', 'aria-label': 'Uploads' },
      h('div', { className: 'uq-head', onclick(e) { if (Q.minimized && !e.target.closest('button')) { Q.minimized = false; drawQueue(); } } },
        h('div', { className: 'uq-hl' }, Q.title, Q.pct), Q.minBtn, Q.closeBtn),
      Q.bar, Q.stats, Q.now, Q.actions, Q.list);
    document.body.append(Q.panel);
  }
  const jobs = Q.jobs;
  Q.panel.hidden = !jobs.length;
  queueMicrotask(() => document.body.style.setProperty('--uq-h', Q.panel.hidden ? '0px' : Q.panel.offsetHeight + 10 + 'px')); // toasts sit above it
  if (!jobs.length) return;

  const by = s => jobs.filter(j => j.status === s);
  const done = by('done'), failed = by('failed'), skipped = by('skipped'), cancelled = by('cancelled'), queued = by('queued');
  const current = jobs.find(j => j.status === 'uploading');
  const counted = jobs.filter(j => j.status !== 'skipped' && j.status !== 'cancelled');
  const total = counted.reduce((s, j) => s + j.size, 0);
  const sent = counted.reduce((s, j) => s + (j.status === 'done' ? j.size : j.loaded), 0);
  const pct = total ? (sent / total) * 100 : 100;

  // speed: smoothed bytes per second, sampled about once a second
  const now = performance.now();
  if (!Q.sample || !Q.running) Q.sample = { t: now, b: sent };
  else if (now - Q.sample.t > 1000) {
    const v = (sent - Q.sample.b) / ((now - Q.sample.t) / 1000);
    Q.speed = Q.speed ? Q.speed * 0.7 + v * 0.3 : v;
    Q.sample = { t: now, b: sent };
  }
  if (!Q.running) Q.speed = 0;

  const finishedCount = done.length + failed.length;
  Q.title.textContent = Q.running
    ? `Uploading ${Math.min(finishedCount + 1, counted.length)} of ${counted.length}`
    : failed.length ? `Finished with ${failed.length} failed` : `Uploaded ${done.length} ${done.length === 1 ? 'track' : 'tracks'}`;
  Q.pct.textContent = Math.floor(pct) + '%';
  Q.fill.style.width = pct + '%';
  Q.panel.classList.toggle('running', Q.running);
  Q.panel.classList.toggle('min', Q.minimized);
  Q.panel.classList.toggle('has-failed', failed.length > 0);
  Q.minBtn.classList.toggle('flip', Q.minimized);
  Q.minBtn.setAttribute('aria-label', Q.minimized ? 'Show upload details' : 'Hide upload details');
  Q.closeBtn.hidden = Q.running;

  fill(Q.stats, 
    h('span', {}, `${fmtSize(sent)} of ${fmtSize(total)}`),
    Q.running && Q.speed > 0 && h('span', {}, `${fmtSize(Q.speed)}/s`),
    Q.running && Q.speed > 0 && h('span', {}, fmtEta((total - sent) / Q.speed)),
    h('span', { className: 'ok' }, `✓ ${done.length}`),
    queued.length > 0 && h('span', {}, `${queued.length} queued`),
    failed.length > 0 && h('span', { className: 'bad' }, `${failed.length} failed`),
    skipped.length > 0 && h('span', {}, `${skipped.length} skipped`),
    cancelled.length > 0 && h('span', {}, `${cancelled.length} cancelled`),
  );
  fill(Q.now, ...(current ? [
    h('span', { className: 'uq-now-label num' }, current.phase === 'Uploading' ? Math.floor((current.loaded / current.size) * 100) + '%' : current.phase),
    h('span', { className: 'uq-now-name' }, current.file.name),
    current.folder && h('span', { className: 'uq-now-folder' }, current.folder),
  ] : []));
  Q.now.hidden = !current;

  fill(Q.actions, 
    h('button', { className: 'btn ghost', onclick: () => { Q.expanded = !Q.expanded; drawQueue(); } }, Q.expanded ? 'Hide files' : `Show all ${jobs.length} files`),
    jobs.some(j => j.dup && j.status === 'skipped') && h('button', { className: 'btn', onclick() {
      Q.jobs.forEach(j => { if (j.dup && j.status === 'skipped') { j.status = 'queued'; j.error = null; j.dup = false; j.done = () => {}; } });
      drawQueue(); pump();
    } }, (n => `Upload ${n} duplicate${n === 1 ? '' : 's'} anyway`)(jobs.filter(j => j.dup && j.status === 'skipped').length)),
    (failed.length || cancelled.length) && !Q.running ? h('button', { className: 'btn', onclick: retryFailed }, `Retry ${failed.length + cancelled.length}`) : null,
    Q.running && h('button', { className: 'btn ghost danger', onclick: cancelQueue }, 'Cancel'),
  );

  Q.list.hidden = !Q.expanded;
  if (!Q.expanded) return;
  for (const j of jobs) {
    const p = j.status === 'done' ? 100 : j.status === 'uploading' ? Math.floor((j.loaded / j.size) * 100) : 0;
    const sig = j.status + p + j.phase + (j.error || '') + (j.found || '');
    if (j.row && j.sig === sig) continue;
    j.sig = sig;
    const label = { queued: 'Queued', uploading: j.phase === 'Uploading' ? p + '%' : j.phase, done: 'Done', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' }[j.status];
    const row = h('div', { className: 'uq-row ' + j.status, role: 'listitem' },
      h('div', { className: 'uq-row-main' },
        h('div', { className: 'uq-row-name', title: j.file.name }, j.file.name),
        h('div', { className: 'uq-row-sub num' }, [j.folder, fmtSize(j.size), j.found, j.error].filter(Boolean).join(' · '))),
      h('span', { className: 'uq-row-status num' }, label),
      h('div', { className: 'uq-row-bar' }, h('i', { style: { width: p + '%' } })));
    j.row ? j.row.replaceWith(row) : Q.list.append(row);
    j.row = row;
  }
}

// Covers are resized to 1000px JPEG in the browser. HEIC is decoded natively on iPhone, and with heic2any elsewhere.
const loadImg = blob => new Promise((res, rej) => {
  const img = new Image(), u = URL.createObjectURL(blob);
  img.onload = () => { URL.revokeObjectURL(u); res(img); };
  img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('unreadable')); };
  img.src = u;
});
const loadScript = src => new Promise((res, rej) => document.head.append(h('script', { src, onload: res, onerror: rej })));
async function toJpeg(file) {
  let img;
  try { img = await loadImg(file); } catch {
    if (!/\.(heic|heif)$/i.test(file.name)) throw new Error(`${file.name} couldn't be read as an image`);
    if (!window.heic2any) await loadScript('/lib/heic2any.min.js');
    img = await loadImg(await window.heic2any({ blob: file, toType: 'image/jpeg' }));
  }
  const s = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = h('canvas', { width: Math.round(img.naturalWidth * s), height: Math.round(img.naturalHeight * s) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  return new File([blob], 'cover.jpg', { type: 'image/jpeg' });
}
async function setCover(table, item, file) {
  if (!file) {
    const files = splitAccepted(await pickFiles(ACCEPT_IMAGE, false), 'cover');
    if (!files.length) return;
    file = files[0];
  }
  const t = toast('Uploading cover…', { ms: 0 });
  try {
    const cover = await uploadFile(await toJpeg(file));
    await api(`/${table}/${item.id}`, { method: 'PATCH', body: { cover } });
    await load();
  } catch (e) { oops(e); }
  t.remove();
}

// Drag and drop: loose files go to the current project; each dropped folder becomes a project.
const dropEl = $('#drop');
const hideDrop = () => { dropEl.hidden = true; };
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; dropEl.hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hideDrop(); } });
addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  dragDepth = 0; hideDrop();
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  if (!S.online) return toast("You're offline", { error: true });
  handleDrop(e.dataTransfer, null);
});
const readDir = dir => new Promise((res, rej) => {
  const r = dir.createReader(), out = [];
  const next = () => r.readEntries(es => (es.length ? (out.push(...es), next()) : res(out)), rej);
  next();
});
const fileOf = entry => new Promise((res, rej) => entry.file(res, rej));
async function walk(entry) {
  if (entry.isFile) return [await fileOf(entry)];
  const kids = await readDir(entry);
  return (await Promise.all(kids.filter(k => !k.name.startsWith('.')).map(walk))).flat();
}
async function handleDrop(dt, projectId) {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const loose = [], folders = [];
  for (const en of entries) en.isDirectory ? folders.push({ name: en.name, files: await walk(en) }) : loose.push(await fileOf(en));
  if (!entries.length) loose.push(...dt.files);
  const waits = [];
  if (loose.length) {
    const images = loose.filter(f => kindOf(f.name) === 'cover');
    const rest = loose.filter(f => kindOf(f.name) !== 'cover');
    const pid = projectId || await targetProject();
    if (images.length && !rest.length) return setCover('projects', projectOf(pid), images[0]);
    waits.push(uploadTracks(rest, pid));
  }
  const folderId = S.view.type === 'project' ? projectOf(S.view.id)?.folder_id || null : null;
  for (const f of folders) {
    const { id } = await api('/projects', { method: 'POST', body: { name: f.name, folder_id: folderId } });
    const art = f.files.find(x => kindOf(x.name) === 'cover');
    // Everything else (including other images, docs, etc.) goes in the queue; non-audio shows up as "skipped".
    waits.push(uploadTracks(f.files.filter(x => x !== art), id, f.name).then(() => art && setCover('projects', { id }, art)));
  }
  await Promise.all(waits);
}

// ---- tracks -----------------------------------------------------------------------------
function trackMenu(t, list) {
  const manual = S.view.type === 'project' && S.sort === 'manual';
  const i = list.indexOf(t);
  const move = d => { const ids = list.map(x => x.id); ids.splice(i, 1); ids.splice(i + d, 0, t.id); reorder(ids); };
  sheet([
    { icon: 'star', label: t.mark === 'star' ? 'Unstar' : 'Star', run: () => setMark(t, t.mark === 'star' ? null : 'star') },
    { icon: 'ban', label: t.mark === 'throw' ? 'Not a throwaway' : 'Mark as throwaway', run: () => setMark(t, t.mark === 'throw' ? null : 'throw') },
    '-',
    { icon: 'play', label: 'Play next', run: () => playNextTrack(t) },
    { icon: 'queue', label: 'Add to queue', run: () => addToQueue(t) },
    '-',
    { icon: 'sliders', label: 'Edit audio', run: () => openEditor(t) },
    { icon: 'info', label: 'Details, notes & versions', run: () => detailsDialog(t) },
    { icon: 'gauge', label: 'Detect BPM & key', run: () => detectTracks([t], true) },
    { icon: 'share', label: 'Share', run: () => shareDialog('track', t.id, t.name) },
    isOffline(t) ? { icon: 'close', label: 'Remove download', run: () => removeOffline(t) } : { icon: 'download', label: 'Save offline', run: () => saveOffline(t) },
    { icon: 'download', label: 'Download file', run: () => downloadTrack(t) },
    manual && i > 0 && { icon: 'up', label: 'Move up', run: () => move(-1) },
    manual && i < list.length - 1 && { icon: 'down', label: 'Move down', run: () => move(1) },
    '-',
    { icon: 'trash', label: 'Move to trash', danger: true, async run() {
      await api(`/tracks/${t.id}`, { method: 'DELETE' }).catch(oops);
      load();
      toast(`Moved “${t.name}” to the trash`, { ms: 7000, action: { label: 'Undo', run: () => restore('track', t.id) } });
    } },
  ]);
}

// Detects BPM & key for existing tracks. overwrite=false only fills in what's missing.
// Decodes once and returns the waveform, plus BPM & key when detect is on.
async function analyse(blob, name, detect = true) {
  try {
    const buf = await decodeAudio(blob);
    return { ...(detect ? bpmKeyOf(buf, name) : {}), peaks: peaksOf(buf) };
  } catch {
    return detect ? parseName(name) : {}; // this browser can't decode it: keep whatever the name gives
  }
}

// Tracks without a waveform (older uploads, the iPhone Shortcut, switched versions) get one the first time they play.
const peaking = new Set();
async function fillPeaks(t) {
  if (t.peaks || peaking.has(t.id) || !S.online || t.size > 300e6) return;
  peaking.add(t.id);
  try {
    const { peaks } = await analyse(await audioBlob(t), t.name, false);
    if (!peaks) return;
    await api(`/tracks/${t.id}`, { method: 'PATCH', body: { peaks } });
    [t, trackOf(t.id), cur?.id === t.id && cur].forEach(x => { if (x) x.peaks = peaks; });
    const w = document.querySelector(`.trow[data-id="${t.id}"] .c-wave`);
    if (w) { w.innerHTML = waveHtml(peaks); w.classList.remove('none'); w.classList.add('fresh'); }
  } catch {} finally { peaking.delete(t.id); }
}
async function makeWaveforms() {
  const list = S.tracks.filter(t => !t.peaks);
  if (!list.length) return toast('Every track already has a waveform');
  const note = toast('', { ms: 0 });
  for (const [i, t] of list.entries()) { note.firstChild.textContent = `Drawing waveforms… ${i + 1} of ${list.length}`; await fillPeaks(t); }
  note.remove();
  toast('Waveforms done');
}

async function detectTracks(list, overwrite) {
  if (!list.length) return toast('Every track here already has a BPM and key');
  const note = toast('', { ms: 0 });
  let changed = 0;
  for (const [i, t] of list.entries()) {
    note.firstChild.textContent = list.length > 1 ? `Detecting BPM & key… ${i + 1} of ${list.length}` : `Detecting BPM & key for ${t.name}…`;
    try {
      const { bpm, key, peaks } = await analyse(await audioBlob(t), t.name);
      const body = {};
      if (peaks && !t.peaks) body.peaks = peaks;
      if (bpm && (overwrite || !t.bpm)) body.bpm = bpm;
      if (key && (overwrite || !t.musical_key)) body.musical_key = key;
      if (body.bpm || body.musical_key || body.peaks) { await api(`/tracks/${t.id}`, { method: 'PATCH', body }); Object.assign(t, body); changed++; }
      if (list.length === 1) toast(bpm || key ? `${t.name}: ${[bpm && bpm + ' BPM', key].filter(Boolean).join(' · ')}` : `Couldn't detect anything for ${t.name}`);
    } catch (e) { oops(new Error(`${t.name}: ${e.message}`)); }
  }
  note.remove();
  if (list.length > 1) toast(`Updated ${changed} of ${list.length} tracks`);
  renderList();
}

async function detailsDialog(t) {
  const name = h('input', { type: 'text', value: t.name, required: true });
  const artist = h('input', { type: 'text', value: t.artist || '', placeholder: settings.artist || 'e.g. ssixr', maxLength: 120 });
  const bpm = h('input', { type: 'number', min: 20, max: 400, step: 0.1, value: t.bpm ?? '', placeholder: '—' });
  const key = h('select', {}, h('option', { value: '' }, '—'), KEYS.map(k => h('option', { value: k, selected: t.musical_key === k }, k)));
  const tags = h('input', { type: 'text', value: t.tags || '', placeholder: 'dark, trap, sent to Mike' });
  const proj = h('select', {}, S.projects.map(p => h('option', { value: p.id, selected: p.id === t.project_id }, p.name)));
  const notes = h('textarea', { rows: 5, value: t.notes || '', placeholder: 'Lyrics, ideas, who you sent it to…', maxLength: 20000 });
  const versions = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const comments = h('div', { className: 'list comments' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      await api(`/tracks/${t.id}`, { method: 'PATCH', body: {
        name: name.value.trim(), artist: artist.value.trim(), bpm: bpm.value ? +bpm.value : null, musical_key: key.value || null,
        tags: tags.value.split(',').map(s => s.trim()).filter(Boolean).join(', '), project_id: proj.value, notes: notes.value,
      } }).catch(oops);
      d.close(); load();
    },
  },
  h('h2', {}, 'Track details'),
  h('label', {}, 'Name', name),
  h('label', {}, 'Producer / artist', artist),
  h('div', { className: 'row2' }, h('label', {}, 'BPM', bpm), h('label', {}, 'Key', key)),
  h('label', {}, 'Tags (comma separated)', tags),
  h('label', {}, 'Project', proj),
  h('label', {}, 'Notes', notes),
  h('div', { className: 'btns', style: { justifyContent: 'flex-start' } },
    h('button', { type: 'button', className: 'btn', onclick: () => { d.close(); setCover('tracks', t); } }, t.cover ? 'Change cover' : 'Add cover'),
    t.cover && h('button', { type: 'button', className: 'btn ghost', onclick: () => { d.close(); api(`/tracks/${t.id}`, { method: 'PATCH', body: { cover: null } }).then(load, oops); } }, 'Remove cover')),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Comments from share links'), comments),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Versions'), versions), // not a <label>: that would click the first button inside
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Save'))));

  api(`/tracks/${t.id}/comments`).then(list => fill(comments, list.length ? list.map(cm => h('div', { className: 'item comment' },
    cm.at != null
      ? h('button', { type: 'button', className: 'ts num', title: 'Play from here', onclick: () => playFrom(t, cm.at) }, fmtTime(cm.at))
      : h('span', { className: 'ts num' }, '—'),
    h('span', { className: 'grow' }, h('b', {}, cm.name), ' ', cm.body, h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, fmtDate(cm.created_at))),
    h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Delete comment', async onclick() {
      await api(`/comments/${cm.id}`, { method: 'DELETE' }).catch(oops);
      this.closest('.comment').remove();
      if (S.comments[t.id]) S.comments[t.id]--;
    } }, icon('trash', 15)))) : h('div', { className: 'muted' }, 'None yet. People can comment at a moment in the track from any share link.')), oops);

  // Versions: switching or deleting one keeps this open and redraws the list.
  let inUse = t.file_key, preview = null;
  d.addEventListener('close', () => preview?.pause());
  async function drawVersions() {
    const vs = await api(`/tracks/${t.id}/versions`).catch(e => (oops(e), []));
    const older = vs.filter(v => v.file_key !== inUse);
    fill(versions, vs.map(v => h('div', { className: 'item' },
      h('span', { className: 'grow', title: v.note || 'Edit' }, v.note || 'Edit', h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, `${fmtDate(v.created_at)} · ${fmtBytes(v.size)}`)),
      v.file_key === inUse ? h('span', { className: 'pill' }, 'in use') : [
        h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Preview this version', onclick: () => { preview?.pause(); preview = new Audio(`/api/audio/${t.id}?v=${v.id}`); preview.play(); } }, icon('play', 14)),
        h('button', { type: 'button', className: 'btn', async onclick() {
          try { await api(`/versions/${v.id}/use`, { method: 'POST' }); } catch (e) { return oops(e); }
          preview?.pause(); inUse = v.file_key; toast('Switched version', { ms: 1500 });
          if (cur?.id === t.id) await editorClosed(t, { at: audio.currentTime, playing: !audio.paused, saved: true }); else await load();
          drawVersions();
        } }, 'Use'),
        h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Delete this version', async onclick() {
          if (!(await confirm('Delete this version?', 'It will be gone for good.'))) return;
          try { await api(`/versions/${v.id}`, { method: 'DELETE' }); } catch (e) { return oops(e); }
          drawVersions(); load();
        } }, icon('trash', 16)),
      ])), older.length > 1 && h('button', { type: 'button', className: 'btn', style: { justifySelf: 'start', marginTop: '4px' }, async onclick() { if (await cleanVersions(t.id)) drawVersions(); } },
        `Delete ${older.length} old versions · ${fmtBytes(older.reduce((s, v) => s + v.size, 0))}`));
  }
  drawVersions();
}

// Deletes every version except the one in use (for one track, or the whole library), a batch at a time.
async function cleanVersions(track_id) {
  const ok = await confirm('Delete old versions?', track_id
    ? 'The version this track uses now stays. Older ones are gone for good.'
    : 'Every track keeps the version it uses now. All older versions, including the originals of edited tracks, are gone for good.', 'Delete');
  if (!ok) return false;
  const note = toast('Deleting old versions…', { ms: 0 });
  let n = 0, freed = 0;
  try {
    for (;;) {
      const r = await api('/versions/cleanup', { method: 'POST', body: track_id ? { track_id } : {} });
      n += r.deleted; freed += r.freed;
      note.firstChild.textContent = `Deleting old versions… ${n}`;
      if (!r.left || !r.deleted) break;
    }
    toast(`Deleted ${n} old ${n === 1 ? 'version' : 'versions'}. Freed ${fmtBytes(freed)}.`);
  } catch (e) { oops(e); }
  note.remove(); load();
  return true;
}

async function downloadTrack(t) {
  try {
    const blob = await audioBlob(t);
    const a = h('a', { href: URL.createObjectURL(blob), download: t.name + extFromType(blob.type) });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } catch (e) { oops(e); }
}
const extFromType = type => ({ 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/flac': '.flac', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/aiff': '.aiff', 'audio/webm': '.weba' })[type] || '';

// ---- offline ------------------------------------------------------------------------------
// Downloaded tracks live in the Cache API, keyed by file version so edits don't serve stale audio.
const offKey = t => `/offline/${t.file_key}`;
function isOffline(t) { return S.offline.has(t.file_key); }
async function saveOffline(t) {
  const note = toast(`Saving ${t.name} offline…`, { ms: 0 });
  try {
    const { url } = await api(`/audio/${t.id}?json=1`);
    const r = await fetch(url);
    if (!r.ok) throw new Error('Download failed');
    await (await caches.open('audio')).put(offKey(t), r);
    S.offline.add(t.file_key); store.set('offline', [...S.offline]);
    navigator.storage?.persist?.();
    renderSide(); renderList();
  } catch (e) { oops(e); }
  note.remove();
}
async function removeOffline(t) {
  await (await caches.open('audio')).delete(offKey(t));
  S.offline.delete(t.file_key); store.set('offline', [...S.offline]);
  renderSide(); renderList();
}
// ---- keeping played songs on this device ----
// Each song is downloaded once; after that it plays (and opens in the editor) from this device, so it doesn't count
// against Backblaze's free daily download limit again. The least recently played are dropped past the space budget.
// ponytail: 1.5 GB budget per device; make it a setting if anyone's library outgrows it.
const KEPT = 'played', KEEP_BUDGET = 1.5e9;
const keptKey = t => `/played/${t.file_key}`;
async function fromDevice(t) {
  const off = isOffline(t) && await (await caches.open('audio')).match(offKey(t));
  if (off) return off.blob();
  if (!settings.keepPlayed) return null;
  const hit = await (await caches.open(KEPT)).match(keptKey(t)).catch(() => null);
  if (!hit) return null;
  const idx = store.get('played', {});
  if (idx[t.file_key]) { idx[t.file_key].at = Date.now(); store.set('played', idx); }
  return hit.blob();
}
// Downloads the whole file once (with progress), keeping it on this device.
const downloading = new Map(); // file_key → promise, so a song being fetched in advance isn't fetched twice
function fetchAudio(t, onProgress) {
  if (!downloading.has(t.file_key)) downloading.set(t.file_key, download(t, onProgress).finally(() => downloading.delete(t.file_key)));
  return downloading.get(t.file_key);
}
async function download(t, onProgress) {
  const { url } = await api(`/audio/${t.id}?json=1`);
  const r = await fetch(url);
  if (!r.ok) throw new Error((await storageProblem()) || "Couldn't load the audio");
  const total = +r.headers.get('content-length') || t.size || 0, reader = r.body.getReader(), parts = [];
  for (let got = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onProgress?.(total ? got / total : 0);
  }
  const blob = new Blob(parts, { type: r.headers.get('content-type') || 'audio/mpeg' });
  if (settings.keepPlayed) keep(t, blob);
  return blob;
}
async function keep(t, blob) {
  try {
    const c = await caches.open(KEPT);
    await c.put(keptKey(t), new Response(blob, { headers: { 'content-type': blob.type } }));
    const idx = store.get('played', {});
    idx[t.file_key] = { size: blob.size, at: Date.now() };
    let total = Object.values(idx).reduce((s, x) => s + x.size, 0);
    for (const [k] of Object.entries(idx).sort((x, y) => x[1].at - y[1].at)) {
      if (total <= KEEP_BUDGET) break;
      if (k === t.file_key) continue;
      await c.delete(`/played/${k}`); total -= idx[k].size; delete idx[k];
    }
    store.set('played', idx);
  } catch {} // storage full or blocked: it just plays without keeping a copy
}
const keptBytes = () => Object.values(store.get('played', {})).reduce((s, x) => s + x.size, 0);
export async function audioBlob(t) { return (await fromDevice(t)) || fetchAudio(t); }

// ---- player -------------------------------------------------------------------------------
// queue = what's lined up; qi = the playing index; history = indices played before (for Previous and shuffle).
const audio = $('#audio');
const P = { shuffle: store.get('shuffle', false), repeat: store.get('repeat', 'off'), history: [] };
let queue = [], qi = -1, cur = null, blobUrl = null, playToken = 0, audioUnlocked = false;
const SILENT = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
async function playList(list, i, { shuffle } = {}) {
  queue = list.slice(); P.history = [];
  if (shuffle !== undefined) { P.shuffle = shuffle; store.set('shuffle', shuffle); }
  await playAt(i);
}
async function playAt(i, { remember = true } = {}) {
  if (i < 0 || i >= queue.length) return;
  if (remember && cur && qi >= 0 && qi !== i) P.history.push(qi);
  qi = i; cur = queue[i];
  store.set('recent', [cur.id, ...store.get('recent', []).filter(id => id !== cur.id)].slice(0, 20));
  if (blobUrl) { const old = blobUrl; setTimeout(() => URL.revokeObjectURL(old), 30000); blobUrl = null; }
  const t = cur, my = ++playToken;
  // iPhones only let audio start from a tap; start a moment of silence now so the real song can begin after downloading
  if (!audioUnlocked) { audio.src = SILENT; audio.play().then(() => { audioUnlocked = true; }, () => {}); }
  renderPlayer(); markPlaying();
  let blob = await fromDevice(t).catch(() => null);
  // Not on this device yet: download it once and keep it. (In the background, e.g. the screen is locked, stream instead.)
  if (!blob && settings.keepPlayed && S.online && !document.hidden) {
    document.body.classList.add('audio-loading');
    try { blob = await fetchAudio(t, p => document.body.style.setProperty('--load', Math.round(p * 100) + '%')); }
    catch (e) { if (my === playToken) { document.body.classList.remove('audio-loading'); if (!e.shown) toast(e.message, e.quiet ? { quiet: true, ms: 5000 } : { error: true, ms: 12000 }); } return; }
    if (my === playToken) document.body.classList.remove('audio-loading');
  }
  if (my !== playToken) return; // something else was picked while this loaded
  audio.src = blob ? (blobUrl = URL.createObjectURL(blob)) : `/api/audio/${t.id}?k=${encodeURIComponent(t.file_key)}`; // file key in the URL so a saved edit isn't served from the cached redirect
  audio.loop = P.repeat === 'one';
  audio.play().catch(() => {});
  renderPlayer(); markPlaying();
  if ('mediaSession' in navigator) {
    const art = coverOf(cur);
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.name, artist: cur.artist || projectOf(cur.project_id)?.name || '', artwork: art ? [{ src: coverUrl(art), sizes: '1000x1000', type: 'image/jpeg' }] : [] });
  }
}
function nextIndex() {
  if (P.shuffle && P.pick?.from === qi && P.pick.len === queue.length && P.pick.to < queue.length) return P.pick.to;
  const j = rollNext();
  P.pick = { from: qi, len: queue.length, to: j };
  return j;
}
function rollNext() {
  if (P.shuffle) {
    const played = new Set([...P.history, qi]);
    const left = queue.map((_, j) => j).filter(j => !played.has(j));
    if (left.length) return left[Math.floor(Math.random() * left.length)];
    if (P.repeat === 'all' && queue.length) { P.history = []; return Math.floor(Math.random() * queue.length); }
    return -1;
  }
  if (qi + 1 < queue.length) return qi + 1;
  return P.repeat === 'all' && queue.length ? 0 : -1;
}
let trackDir = 1; // +1 forward, -1 back: which way the full-screen player slides
function playNext() { const j = nextIndex(); if (j >= 0) { trackDir = 1; playAt(j); } }
const skip = () => (P.userQ.length ? advance() : playNext());
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  trackDir = -1;
  const j = P.history.pop();
  if (j !== undefined) playAt(j, { remember: false });
  else if (qi > 0) playAt(qi - 1, { remember: false });
  else audio.currentTime = 0;
}
// Your queue: songs you add play right after the current one, in the order you added them (each new one goes after the
// last one you added). The project/list you were playing carries on once your queue is empty.
P.userQ = [];
function playNextTrack(t) {
  if (!cur) return playList([t], 0);
  P.userQ.unshift(t);
  toast(`“${t.name}” plays next`, { quiet: true, ms: 2000 });
}
function addToQueue(t) {
  if (!cur) return playList([t], 0);
  P.userQ.push(t);
  toast(`Added “${t.name}” to your queue`, { quiet: true, ms: 2000 });
}
// What plays next: your queue first, then the list.
function upNext() { return P.userQ[0] || queue[nextIndex()] || null; }
function advance() {
  if (P.userQ.length) { const t = P.userQ.shift(); queue.splice(qi + 1, 0, t); trackDir = 1; return playAt(qi + 1); }
  playNext();
}
function setShuffle(on) { P.shuffle = on; store.set('shuffle', on); P.history = []; renderPlayer(); }
function cycleRepeat() {
  P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat];
  store.set('repeat', P.repeat); audio.loop = P.repeat === 'one'; renderPlayer();
  toast({ off: 'Repeat off', all: 'Repeating the list', one: 'Repeating this track' }[P.repeat], { ms: 1500 });
}
// Tracks sent from the iPhone Shortcut arrive without a length; save it the first time one plays.
audio.addEventListener('loadedmetadata', () => {
  if (!realSrc()) return;
  if (cur && !cur.duration && isFinite(audio.duration)) { cur.duration = audio.duration; api(`/tracks/${cur.id}`, { method: 'PATCH', body: { duration: audio.duration } }).catch(() => {}); }
  if (cur && !cur.peaks && (isOffline(cur) || settings.keepPlayed)) setTimeout(fillPeaks, 1500, cur); // drawn from the copy on this device (free)
});
// Play a track from a moment (comment timestamps).
async function playFrom(t, at) {
  if (cur?.id !== t.id) await playList([t], 0);
  const go = () => { audio.currentTime = at; audio.play().catch(() => {}); };
  audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
}
// ---- crossfade, and loading the next track early ----
// The outgoing track's last seconds move to a second player (`tail`) and fade out while the next one fades in.
// ponytail: volume fades need audio.volume, which iPhone Safari ignores; there it's a straight cut (still preloaded).
const canFade = (() => { const x = new Audio(); x.volume = 0.5; return x.volume === 0.5; })();
const tail = new Audio(); tail.preload = 'auto';
let fading = false, warmedFor = null;
audio.addEventListener('timeupdate', () => {
  if (!cur || !audio.duration || audio.paused || P.repeat === 'one' || !realSrc()) return;
  const left = audio.duration - audio.currentTime, next = upNext();
  if (!next || !(settings.autoplay || P.repeat === 'all')) return;
  const fade = canFade ? settings.crossfade : 0;
  // ~15 s before the end: start loading the next track (and the tail copy of this one) so the change is instant
  if (left < Math.max(fade, 5) + 15 && warmedFor !== next.id) {
    warmedFor = next.id;
    // keep the next track on the device in advance (only once, and it's kept for later, so nothing's wasted)
    if (settings.keepPlayed && S.online) fromDevice(next).then(have => have || fetchAudio(next)).catch(() => {});
    if (fade && tail.src !== audio.currentSrc) { tail.src = audio.currentSrc; tail.load(); }
  }
  if (fade && !fading && audio.duration > fade * 2 && left <= fade) startFade(fade);
});
function startFade(secs) {
  fading = true;
  if (tail.src !== audio.currentSrc) tail.src = audio.currentSrc;
  tail.currentTime = audio.currentTime; tail.volume = 1; tail.play().catch(() => {});
  audio.volume = 0;
  advance();
  const t0 = performance.now();
  (function step() {
    const p = Math.min(1, (performance.now() - t0) / (secs * 1000)), e = p * p * (3 - 2 * p);
    audio.volume = e; tail.volume = 1 - e;
    if (p < 1) setTimeout(step, 40);
    else { tail.pause(); audio.volume = 1; fading = false; }
  })();
}

const realSrc = () => !audio.currentSrc.startsWith('data:'); // not the moment of silence used to unlock iPhone audio
audio.onended = () => { if (!realSrc()) return; if (P.userQ.length || settings.autoplay || P.repeat === 'all') advance(); };
audio.onerror = async () => {
  if (!cur) return;
  const why = await storageProblem();
  toast(why || `Can't play ${cur.name} in this browser. Use Download instead.`, { error: true, ms: why ? 15000 : 6000 });
};
// Asks the server whether Backblaze is refusing files, and turns the answer into plain words (once per minute at most).
let lastCheck = 0, lastWhy = '';
async function storageProblem() {
  if (!S.online) return '';
  if (Date.now() - lastCheck < 60000) return lastWhy;
  lastCheck = Date.now();
  const r = await api('/storage-check').catch(() => null);
  if (!r || r.ok) return (lastWhy = '');
  if (r.code === 'drive') return (lastWhy = `Google Drive isn't letting [vault] read your files. ${r.message}`);
  const text = `${r.code} ${r.message}`.toLowerCase();
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  lastWhy = /cap|exceed|limit/.test(text)
    ? `Backblaze's free daily limit is used up, so songs and covers can't load right now. It resets at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : /key|access ?denied|signature|unauthori|invalid/.test(text) || r.status === 401 || r.status === 403
      ? 'Backblaze is refusing the app\'s key (it was probably deleted or replaced). On your computer, run node setup.mjs and paste your current Backblaze key.'
      : `Backblaze isn't answering properly (${r.status} ${r.code || ''}). Try again in a bit.`;
  return lastWhy;
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', () => skip());
}

const shuffleBtn = cls => h('button', { className: 'icon-btn ' + cls + (P.shuffle ? ' on' : ''), 'aria-label': 'Shuffle', 'aria-pressed': P.shuffle, title: P.shuffle ? 'Shuffle on' : 'Shuffle off', onclick: () => setShuffle(!P.shuffle) }, icon('shuffle', 17));
const repeatBtn = cls => h('button', { className: 'icon-btn repeat ' + cls + (P.repeat !== 'off' ? ' on' : ''), 'aria-label': `Repeat: ${P.repeat}`, title: { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[P.repeat], onclick: cycleRepeat },
  icon('repeat', 17), P.repeat === 'one' && h('span', { className: 'one num' }, '1'));

function renderPlayer() {
  const el = $('#player');
  el.hidden = !cur;
  document.body.classList.toggle('playing', !!cur);
  if (!cur) return;
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek', oninput(e) { syncRange(e.target); if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; } });
  syncRange(seek);
  const t1 = h('span', { className: 'num' }, '0:00'), t2 = h('span', { className: 'num' }, fmtTime(cur.duration));
  const playBtn = h('button', { className: 'play', 'aria-label': 'Play or pause', onclick: () => (audio.paused ? audio.play() : audio.pause()) });
  const showState = () => { playBtn.replaceChildren(icon(audio.paused ? 'play' : 'pause', 18)); document.body.classList.toggle('paused', audio.paused); };
  audio.ontimeupdate = () => {
    seek.value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0; syncRange(seek); t1.textContent = fmtTime(audio.currentTime); t2.textContent = fmtTime(audio.duration);
    document.querySelector('.trow.on .c-wave')?.style.setProperty('--p', seek.value / 10 + '%');
  };
  audio.onplay = audio.onpause = showState;
  showState();
  const t = cur;
  el.replaceChildren(
    h('div', { className: 'np', role: 'button', tabIndex: 0, title: 'Open the player', 'aria-label': `Open the player: ${t.name}`,
      onclick: openFullPlayer, onkeydown(e) { if (e.key === 'Enter') openFullPlayer(); } }, thumb(coverOf(t)),
      h('div', { style: { minWidth: 0 } }, h('div', { className: 't' }, t.name), h('div', { className: 'p' }, [t.artist, projectOf(t.project_id)?.name].filter(Boolean).join(' · ')))),
    h('div', { className: 'transport' },
      starBtn(t), throwBtn(t, 'hide-sm'),
      shuffleBtn('hide-sm'),
      h('button', { className: 'icon-btn hide-sm', 'aria-label': 'Previous', onclick: playPrev }, icon('prev', 18)),
      playBtn,
      h('button', { className: 'icon-btn', 'aria-label': 'Next', onclick: skip }, icon('next', 18)),
      repeatBtn('hide-sm'),
      h('button', { className: 'icon-btn', 'aria-label': 'Up next', title: 'Up next', onclick: queueDialog }, icon('queue', 18)),
      h('button', { className: 'icon-btn', 'aria-label': 'Edit audio', title: 'Edit audio', onclick: () => openEditor(t) }, icon('sliders', 18))),
    h('div', { className: 'seek' }, t1, seek, t2),
  );
  marquees(el);
  if (fp) drawFullPlayer(); // keep the full-screen player in step (new track, star, shuffle…)
}

// ---- full-screen player ----------------------------------------------------------------------
let fp = null;
function openFullPlayer() {
  if (!cur || fp?.d.open) return;
  const d = dialog(h('div', { className: 'fp' }), { className: 'fsplayer' });
  const onTime = () => paintFullPlayer(), onState = () => drawFullPlayer();
  audio.addEventListener('timeupdate', onTime); audio.addEventListener('play', onState); audio.addEventListener('pause', onState);
  d.addEventListener('close', () => {
    audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('play', onState); audio.removeEventListener('pause', onState);
    if (fp?.d === d) fp = null;
  });
  // swipe down to close: the whole sheet follows your finger
  let start = null;
  d.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, .fp-scrub')) return;
    start = { y: e.clientY, t: performance.now() };
    d.style.transition = 'none';
  });
  d.addEventListener('pointermove', e => { if (start) d.style.transform = `translateY(${Math.max(0, e.clientY - start.y)}px)`; });
  const end = e => {
    if (!start) return;
    const dy = e.clientY - start.y, fast = dy > 40 && performance.now() - start.t < 250;
    start = null; d.style.transition = '';
    if (dy > 110 || fast) d.close(); else d.style.transform = '';
  };
  d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
  fp = { d };
  drawFullPlayer();
}
function drawFullPlayer() {
  if (!fp || !cur) return;
  const t = cur, art = coverOf(t), playing = !audio.paused;
  const changed = fp.id && fp.id !== t.id; fp.id = t.id;
  // the cover that's leaving, kept as a ghost so it can blur away over the new one
  const old = changed && fp.d.querySelector('.fp-art'), oldRect = old && old.getBoundingClientRect();
  const scrubTo = (e, el) => { const r = el.getBoundingClientRect(); if (audio.duration) audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audio.duration; paintFullPlayer(); };
  const scrub = t.peaks
    ? h('div', { className: 'fp-scrub', role: 'slider', 'aria-label': 'Seek', tabIndex: 0,
        onpointerdown(e) { this.setPointerCapture(e.pointerId); this.dragging = true; scrubTo(e, this); },
        onpointermove(e) { if (this.dragging) scrubTo(e, this); },
        onpointerup() { this.dragging = false; },
        onkeydown(e) { const k = { ArrowLeft: -5, ArrowRight: 5 }[e.key]; if (k && audio.duration) { e.preventDefault(); audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + k)); } } },
        h('span', { className: 'c-wave fp-wave' }))
    : h('input', { type: 'range', className: 'fp-range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek',
        oninput(e) { syncRange(e.target); if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; } });
  if (t.peaks) scrub.firstChild.innerHTML = waveSvg(t.peaks, 70);
  fp.scrub = scrub; fp.t1 = h('span', {}, '0:00'); fp.t2 = h('span', {}, '-0:00');
  const title = h('div', { className: 'fp-t' }, t.name);
  fill(fp.d.firstChild,
    h('div', { className: 'fp-bg', style: art ? bg(art) : { backgroundImage: washFor(t) } }),
    h('span', { className: 'fp-grab', 'aria-hidden': 'true' }),
    h('div', { className: 'fp-top' },
      h('button', { className: 'icon-btn fp-close', 'aria-label': 'Close the player', onclick: () => fp.d.close() }, icon('chevron', 24)),
      h('div', { className: 'fp-from' }, h('span', { className: 'mono' }, '[now playing]'), h('b', {}, projectOf(t.project_id)?.name || 'your library')),
      h('button', { className: 'icon-btn', 'aria-label': 'Track options', onclick: () => trackMenu(t, queue) }, icon('more', 22))),
    h('div', { className: 'fp-art' + (art ? '' : ' disc') + (playing ? ' playing' : ''), style: bg(art) }),
    h('div', { className: 'fp-info' },
      h('div', { className: 'fp-titles' }, title, h('div', { className: 'fp-a' }, [t.artist, t.musical_key, t.bpm && Math.round(t.bpm) + ' bpm'].filter(Boolean).join(' · ') || '\u00a0')),
      starBtn(t), throwBtn(t)),
    scrub,
    h('div', { className: 'fp-times num' }, fp.t1, fp.t2),
    h('div', { className: 'fp-transport' },
      shuffleBtn(''),
      h('button', { className: 'icon-btn', 'aria-label': 'Previous', onclick: playPrev }, icon('prev', 26)),
      h('button', { className: 'fp-play', 'aria-label': playing ? 'Pause' : 'Play', onclick: () => (audio.paused ? audio.play() : audio.pause()) }, icon(playing ? 'pause' : 'play', 30)),
      h('button', { className: 'icon-btn', 'aria-label': 'Next', onclick: skip }, icon('next', 26)),
      repeatBtn('')),
    h('div', { className: 'fp-bottom' },
      h('button', { className: 'icon-btn', 'aria-label': 'Up next', title: 'Up next', onclick: queueDialog }, icon('queue', 20)),
      h('button', { className: 'icon-btn', 'aria-label': 'Details', title: 'Details', onclick: () => detailsDialog(trackOf(t.id) || t) }, icon('info', 20)),
      h('button', { className: 'icon-btn', 'aria-label': 'Share', title: 'Share', onclick: () => shareDialog('track', t.id, t.name) }, icon('share', 20)),
      h('button', { className: 'icon-btn', 'aria-label': 'Edit audio', title: 'Edit audio', onclick: () => { fp.d.close(); openEditor(t); } }, icon('sliders', 20))));
  if (phone.matches && settings.motion) marquee(title);
  if (changed && old) {
    const ghost = old.cloneNode(true);
    ghost.classList.add('fp-ghost', trackDir < 0 ? 'out-prev' : 'out-next');
    Object.assign(ghost.style, { left: oldRect.left + 'px', top: oldRect.top + 'px', width: oldRect.width + 'px', height: oldRect.height + 'px' });
    fp.d.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove()); setTimeout(() => ghost.remove(), 1200);
  }
  if (changed) {
    const box = fp.d.firstChild, cls = trackDir < 0 ? 'enter-prev' : 'enter-next';
    box.classList.remove('enter-prev', 'enter-next'); void box.offsetWidth; box.classList.add(cls);
    clearTimeout(fp.enterT); fp.enterT = setTimeout(() => box.classList.remove(cls), 900);
    trackDir = 1;
  }
  paintFullPlayer();
}
// Tracks without cover art get a colour wash made only from the Instagram colours, but each track mixes its own:
// three of the five, in its own order and places (always the same for that track).
const IG = ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5'];
function washFor(t) {
  let n = 0; for (const ch of t.id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((n = (n * 1103515245 + 12345) >>> 0) % 1000) / 1000; // small seeded random, so it's stable per track
  const pool = [...IG], pick = [];
  while (pick.length < 3) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return pick.map(col => `radial-gradient(${55 + rnd() * 20}% ${50 + rnd() * 20}% at ${Math.round(rnd() * 100)}% ${Math.round(rnd() * 100)}%, ${col}, transparent 72%)`).join(', ');
}
function paintFullPlayer() {
  if (!fp) return;
  const d = audio.duration || cur?.duration || 0, p = d ? audio.currentTime / d : 0;
  if (fp.scrub.classList.contains('fp-scrub')) fp.scrub.style.setProperty('--p', p * 100 + '%');
  else { fp.scrub.value = p * 1000; syncRange(fp.scrub); }
  fp.t1.textContent = fmtTime(audio.currentTime || 0);
  fp.t2.textContent = '-' + fmtTime(Math.max(0, d - (audio.currentTime || 0)));
}

// "Up next": what's playing and what's coming, with shuffle/repeat and per-track remove.
function queueDialog() {
  const box = h('div', { className: 'list queue-list' });
  const controls = h('div', { className: 'btns', style: { justifyContent: 'flex-start', marginTop: 0 } });
  const draw = () => {
    fill(controls,
      h('button', { className: 'btn' + (P.shuffle ? ' on' : ''), onclick: () => { setShuffle(!P.shuffle); draw(); } }, icon('shuffle', 15), P.shuffle ? 'Shuffle on' : 'Shuffle off'),
      h('button', { className: 'btn' + (P.repeat !== 'off' ? ' on' : ''), onclick: () => { cycleRepeat(); draw(); } }, icon('repeat', 15), { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[P.repeat]),
      queue.length > qi + 1 && h('button', { className: 'btn ghost', onclick: () => { queue.splice(qi + 1); draw(); } }, 'Clear up next'));
    const sub = t => h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, [t.artist, projectOf(t.project_id)?.name].filter(Boolean).join(' · '));
    const mine = P.userQ.map((t, k) => h('div', { className: 'item q-item mine', onclick: () => { P.userQ.splice(k, 1); queue.splice(qi + 1, 0, t); playAt(qi + 1); draw(); } },
      h('span', { className: 'mono q-n' }, k + 1), h('span', { className: 'grow' }, t.name, sub(t)),
      h('button', { className: 'icon-btn sm', 'aria-label': `Remove ${t.name} from your queue`, onclick(e) { e.stopPropagation(); P.userQ.splice(k, 1); draw(); } }, icon('close', 14))));
    const upcoming = queue.map((t, j) => [t, j]).filter(([, j]) => j >= qi);
    const from = projectOf(cur?.project_id)?.name;
    fill(box,
      cur && h('div', { className: 'q-head mono' }, '[now playing]'),
      cur && h('div', { className: 'item q-item now' }, h('span', { className: 'q-now' }, icon('play', 12)), h('span', { className: 'grow' }, cur.name, sub(cur))),
      mine.length > 0 && h('div', { className: 'q-head mono' }, h('span', {}, '[your queue]'), h('button', { className: 'btn ghost', onclick: () => { P.userQ = []; draw(); } }, 'Clear')),
      mine,
      upcoming.length > 1 && h('div', { className: 'q-head mono' }, from ? `[next from ${from}]` : '[next up]'),
      upcoming.filter(([, j]) => j !== qi).length || mine.length || cur ? upcoming.filter(([, j]) => j !== qi).map(([t, j]) => h('div', { className: 'item q-item', onclick: () => { if (j !== qi) { playAt(j); draw(); } } },
      j === qi ? h('span', { className: 'q-now' }, icon('play', 12)) : h('span', { className: 'mono q-n' }, j - qi),
      h('span', { className: 'grow' }, t.name, h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, [t.artist, projectOf(t.project_id)?.name].filter(Boolean).join(' · '))),
      j !== qi && h('button', { className: 'icon-btn sm', 'aria-label': `Remove ${t.name} from the queue`, onclick(e) {
        e.stopPropagation();
        queue.splice(j, 1);
        P.history = P.history.filter(x => x !== j).map(x => (x > j ? x - 1 : x));
        draw();
      } }, icon('close', 14)))) : h('div', { className: 'muted' }, 'Nothing playing.'));
  };
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Up next'), controls, box,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  draw();
}

// ---- editor ---------------------------------------------------------------------------------
async function openEditor(t) {
  if (!S.online) return toast('Editing needs a connection', { error: true });
  // The editor opens at the same spot the player was at (and keeps playing if it was), and hands it back on close.
  const same = cur?.id === t.id, startAt = same ? audio.currentTime : 0, autoplay = same && !audio.paused;
  audio.pause();
  try {
    const { openEditor } = await import('./editor.js');
    await openEditor(t, { api, toast, oops, dialog, prompt, confirm, uploadFile, audioBlob, onSaved: load, h, project: projectOf(t.project_id)?.name,
      startAt, autoplay, haptic, onClosed: back => editorClosed(t, back) });
  } catch (e) {
    // never fail silently: say what went wrong
    toast(`The editor couldn't open: ${e.message}. Try reloading the app.`, { error: true, ms: 8000 });
  }
}

// Back from the editor: the player continues from where the editor was, playing or paused,
// on the new version if one was saved.
async function editorClosed(t, { at, playing, saved }) {
  if (saved) await load();
  const fresh = trackOf(t.id) || t;
  const seek = () => {
    audio.currentTime = Math.min(at, audio.duration || at);
    if (playing) audio.play().catch(() => {}); else audio.pause();
  };
  if (cur?.id === t.id && !saved) return seek();
  if (cur?.id !== t.id && !playing) return; // opened from a menu and left paused: leave the player alone
  if (cur?.id === t.id) { queue[qi] = fresh; await playAt(qi, { remember: false }); }
  else await playList([fresh], 0);
  audio.readyState >= 1 ? seek() : audio.addEventListener('loadedmetadata', seek, { once: true });
}

// ---- sharing --------------------------------------------------------------------------------
async function shareDialog(kind, target_id, name) {
  const list = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const pw = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off' });
  const days = h('select', {}, SHARE_DAYS.map(([v, l]) => h('option', { value: v, selected: v === settings.shareDays }, l)));
  const dl = h('input', { type: 'checkbox', className: 'toggle', 'aria-label': 'Allow downloads' });
  const link = token => `${location.origin}/s/${token}`;
  const copy = async token => { try { await navigator.clipboard.writeText(link(token)); toast('Link copied'); } catch { prompt('Copy this link', link(token), { label: 'Link', ok: 'Done' }); } };
  async function refresh() {
    const rows = await api(`/shares?kind=${kind}&target_id=${target_id}`).catch(e => (oops(e), []));
    list.replaceChildren(...(rows.length ? rows.map(s => h('div', { className: 'item', style: s.revoked ? { opacity: 0.45 } : {} },
      s.has_password && h('span', { title: 'Password protected', style: { color: 'var(--fg-3)' } }, icon('lock', 14)),
      h('span', { className: 'grow mono' }, `${fmtDate(s.created_at)}${s.revoked ? ' · off' : s.expires_at ? ` · ${s.expires_at < Date.now() ? 'expired' : 'until ' + new Date(s.expires_at).toLocaleDateString()}` : ''}`),
      h('button', { type: 'button', className: 'icon-btn sm' + (s.allow_download ? ' on' : ''), 'aria-pressed': !!s.allow_download,
        title: s.allow_download ? 'Downloads allowed. Tap to turn off.' : 'Downloads off. Tap to allow.', 'aria-label': 'Allow downloads',
        onclick: () => api(`/shares/${s.token}`, { method: 'PATCH', body: { allow_download: !s.allow_download } }).then(refresh, oops) }, icon('download', 14)),
      h('button', { type: 'button', className: 'btn ghost', title: 'Who listened', onclick: () => listensDialog(s.token) }, icon('headphones', 14), String(s.listens)),
      !s.revoked && h('button', { type: 'button', className: 'btn', onclick: () => copy(s.token) }, 'Copy'),
      h('button', { type: 'button', className: 'btn ghost', onclick: () => api(`/shares/${s.token}`, { method: 'PATCH', body: { revoked: !s.revoked } }).then(refresh, oops) }, s.revoked ? 'Turn on' : 'Turn off'),
    )) : [h('div', { className: 'muted' }, 'No links yet.')]));
  }
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      const r = await api('/shares', { method: 'POST', body: { kind, target_id, password: pw.value || null, days: days.value ? +days.value : null, allow_download: dl.checked } }).catch(oops);
      if (r) { pw.value = ''; await refresh(); copy(r.token); }
    },
  }, h('h2', {}, `Share “${name}”`),
  h('div', { className: 'row2' }, h('label', {}, 'Password', pw), h('label', {}, 'Expires', days)),
  h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Allow downloads', h('small', {}, 'Listeners can save the files, not just stream them')), dl),
  h('div', { className: 'btns', style: { justifyContent: 'flex-start' } }, h('button', { className: 'btn primary' }, 'Create link')),
  h('label', {}, 'Links · downloads · who listened', list),
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Done'))));
  refresh();
}

// Who listened, how many times, and how far into each track they got.
async function listensDialog(token) {
  const rows = await api(`/shares/${token}/listens`).catch(e => (oops(e), []));
  const pctOf = r => (r.duration ? Math.min(100, Math.round(((r.seconds || 0) / r.duration) * 100)) : null);
  const byTrack = new Map();
  for (const r of rows) {
    const k = r.track || 'A deleted track', e = byTrack.get(k) || { plays: 0, sum: 0, n: 0, people: new Set() };
    e.plays++; e.people.add(r.listener_name);
    const p = pctOf(r); if (p != null) { e.sum += p; e.n++; }
    byTrack.set(k, e);
  }
  const bar = p => h('div', { className: 'bar', style: { marginTop: '6px' } }, h('i', { style: { width: (p ?? 0) + '%' } }));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Who listened'),
    rows.length ? [
      h('label', {}, 'Per track', h('div', { className: 'list' }, [...byTrack].map(([name, e]) => h('div', { className: 'item' },
        h('span', { className: 'grow' }, name,
          h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, `${e.plays} ${e.plays === 1 ? 'play' : 'plays'} · ${e.people.size} ${e.people.size === 1 ? 'person' : 'people'}${e.n ? ` · avg ${Math.round(e.sum / e.n)}% listened` : ''}`),
          e.n > 0 && bar(Math.round(e.sum / e.n))))))),
      h('label', {}, 'Every listen', h('div', { className: 'list' }, rows.map(r => {
        const p = pctOf(r);
        return h('div', { className: 'item' },
          h('span', { className: 'grow' }, `${r.listener_name} · ${r.track || 'a deleted track'}`,
            h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } },
              `${p == null ? 'started' : `${fmtTime(r.seconds)} of ${fmtTime(r.duration)} (${p}%)`} · ${fmtDate(r.at)}`),
            p != null && bar(p)));
      }))),
    ] : h('div', { className: 'muted' }, 'Nobody yet.'),
    h('div', { className: 'btns' }, h('button', { className: 'btn ghost', onclick: () => d.close() }, 'Close'))), { className: 'settings-dlg' });
}

// ---- recording ----------------------------------------------------------------------------
async function recordDialog() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch { return toast('Microphone access was blocked. Allow it in your browser settings.', { error: true, ms: 6000 }); }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = []; let started = 0, timer;
  const time = h('div', { className: 'rec-time num' }, '0:00');
  const name = h('input', { type: 'text', value: `Idea ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
  const btn = h('button', { className: 'rec-ring', 'aria-label': 'Start recording' }, h('i'));
  const hint = h('div', { className: 'mono', style: { textAlign: 'center', color: 'var(--fg-3)' } }, '[tap to record]');
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Record an idea'), time, btn, hint, h('label', {}, '[name]', name),
    h('div', { className: 'btns' }, h('button', { className: 'btn ghost', onclick: () => d.close() }, 'Cancel'))));
  rec.ondataavailable = e => chunks.push(e.data);
  btn.onclick = () => {
    if (rec.state === 'inactive') {
      rec.start(); started = Date.now();
      btn.classList.add('on'); btn.setAttribute('aria-label', 'Stop and save'); hint.textContent = '[tap to stop & save]';
      timer = setInterval(() => { time.textContent = fmtTime((Date.now() - started) / 1000); }, 250);
    } else rec.stop();
  };
  rec.onstop = async () => {
    clearInterval(timer);
    const mime = rec.mimeType || type || 'audio/webm';
    const ext = mime.includes('mp4') ? 'm4a' : 'weba';
    const file = new File(chunks, `${name.value.trim() || 'Idea'}.${ext}`, { type: mime.split(';')[0] });
    const duration = (Date.now() - started) / 1000;
    d.close();
    try {
      const pid = await targetProject();
      const t = toast('Saving recording…', { ms: 0 });
      const file_key = await uploadFile(file);
      await api('/tracks', { method: 'POST', body: { project_id: pid, name: baseName(file.name), file_key, duration } });
      t.remove(); toast('Recording saved'); load();
    } catch (e) { oops(e); }
  };
  d.addEventListener('close', () => { if (rec.state === 'recording') { rec.onstop = null; rec.stop(); } clearInterval(timer); stream.getTracks().forEach(t => t.stop()); });
}

// ---- settings ---------------------------------------------------------------------------
const SHARE_DAYS = [['', 'Never'], ['1', '1 day'], ['7', '7 days'], ['30', '30 days']];
// only = 'account': just the [account] section (opened from the profile picture).
async function settingsDialog(only) {
  document.body.classList.remove('side-open');
  const row = (title, sub, control) => h('div', { className: 'set-row' }, h('div', { className: 't' }, title, sub && h('small', {}, sub)), control);
  // flip: the switch reads the other way round from the setting (Reduce motion = motion off)
  const toggle = (key, after, flip = false) => h('input', { type: 'checkbox', className: 'toggle', checked: settings[key] !== flip, 'aria-label': key, onchange() { setSetting(key, this.checked !== flip); after?.(); } });
  const swatches = h('div', { className: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour' }, ACCENTS.map(([c, name]) =>
    h('button', { className: 'swatch' + (settings.accent === c ? ' on' : ''), role: 'radio', 'aria-checked': settings.accent === c, 'aria-label': name, title: name, style: { background: c },
      onclick() { setSetting('accent', c); swatches.querySelectorAll('.swatch').forEach(s => { const on = s === this; s.classList.toggle('on', on); s.setAttribute('aria-checked', on); }); } })));
  const shareSel = h('select', { 'aria-label': 'Default link expiry', onchange() { setSetting('shareDays', this.value); } },
    SHARE_DAYS.map(([v, l]) => h('option', { value: v, selected: v === settings.shareDays }, l)));
  const formatSel = h('select', { 'aria-label': 'Save edits as', onchange() { setSetting('saveFormat', this.value); } },
    [['mp3', 'MP3 320 kbps'], ['wav', 'WAV 24-bit']].map(([v, l]) => h('option', { value: v, selected: v === settings.saveFormat }, l)));
  const artist = h('input', { type: 'text', value: settings.artist, placeholder: 'e.g. ssixr', maxLength: 120, 'aria-label': 'Default producer name', style: { width: '150px' }, onchange() { setSetting('artist', this.value.trim()); } });
  const pct = Math.min(100, (S.usage / S.limit) * 100);
  const local = h('small', {}, 'Checking…');
  const oldInfo = h('small', {}, 'Checking…');
  const oldBtn = h('button', { className: 'btn', disabled: true, onclick: () => { d.close(); cleanVersions(); } }, 'Delete');
  const noWave = S.tracks.filter(t => !t.peaks).length;
  const meAvatar = avatarEl(S.me, 'avatar lg');
  const clearBtn = h('button', { className: 'btn', disabled: !S.offline.size, async onclick() {
    if (!(await confirm('Remove all downloads?', 'Tracks stay in your library. They just won\'t play offline on this device until you save them again.', 'Remove'))) return;
    await caches.delete('audio');
    S.offline.clear(); store.set('offline', []);
    render(); d.close(); toast('Downloads removed');
  } }, 'Remove all');
  const d = dialog(h('div', { className: 'stack settings' },
    h('h2', {}, only ? 'Account' : 'Settings'),
    h('div', { className: 'set-sec' }, h('h3', {}, '[appearance]'),
      row('Accent colour', 'Editor, playhead, progress and switches', swatches),
      row('Pure black', 'Darker background for OLED screens', toggle('oled')),
      row('Reduce motion', null, toggle('motion', null, true)),
      row('Legacy UI', 'Old UI with no depth or grain or glass', h('input', { type: 'checkbox', className: 'toggle', checked: !settings.glass, 'aria-label': 'Legacy UI',
        onchange() { setSetting('glass', !this.checked); setSetting('refined', !this.checked); } }))),
    h('div', { className: 'set-sec' }, h('h3', {}, '[library]'),
      row('BPM & key columns', 'Show them in track lists', toggle('columns')),
      row('Waveforms', noWave ? `${noWave} ${noWave === 1 ? 'track doesn’t' : 'tracks don’t'} have one yet. They also fill in as you play.` : 'Every track has one',
        h('button', { className: 'btn', disabled: !noWave || !S.online, onclick: () => { d.close(); makeWaveforms(); } }, 'Make them'))),
    h('div', { className: 'set-sec' }, h('h3', {}, '[notifications]'), pushRow()),
    h('div', { className: 'set-sec' }, h('h3', {}, '[playback]'),
      row('Autoplay next track', 'Keep playing through the list', toggle('autoplay')),
      row('Keyboard shortcuts', 'Press ? anywhere on a computer to see them', h('button', { className: 'btn', onclick: () => { d.close(); shortcutsDialog(); } }, 'Show')),
      row('Keep played songs on this device', 'Each song downloads once, then plays from here. Saves downloads from your storage, and kept songs play offline.', toggle('keepPlayed')),
      row('Crossfade', canFade ? 'Blend into the next track. The next track always loads early so there\'s no wait.' : "This browser can't fade volume (iPhone Safari), so tracks change without a blend. The next track still loads early.",
        h('select', { 'aria-label': 'Crossfade', disabled: !canFade, onchange() { setSetting('crossfade', +this.value); } },
          [[0, 'Off'], [2, '2 s'], [4, '4 s'], [6, '6 s'], [8, '8 s'], [12, '12 s']].map(([v, l]) => h('option', { value: v, selected: settings.crossfade === v }, l))))),
    h('div', { className: 'set-sec' }, h('h3', {}, '[uploads]'),
      row('Detect BPM & key', 'From the file name, or by listening to the track', toggle('detect')),
      row('Skip duplicates', 'Same name and size as a track you already have', toggle('skipDups')),
      row('Producer name', 'Added to new uploads; shown under each title', artist)),
    h('div', { className: 'set-sec' }, h('h3', {}, '[editor]'),
      row('Save edits as', 'MP3 is about 7× smaller; WAV is lossless', formatSel)),
    h('div', { className: 'set-sec' }, h('h3', {}, '[sharing]'),
      row('New links expire', 'Default for links you create', shareSel)),
    h('div', { className: 'set-sec' }, h('h3', {}, '[storage]'),
      row('Cloud', h('span', {}, `${fmtBytes(S.usage)} of ${fmtBytes(S.limit)}`, h('div', { className: 'bar' + (pct > 90 ? ' full' : '') }, h('i', { style: { width: pct + '%' } }))),
        h('button', { className: 'btn', onclick: () => { d.close(); storageDialog(); } }, 'Manage')),
      row('Old versions', oldInfo, oldBtn),
      row('Downloads on this device', local, clearBtn),
      row('Back up everything', 'Copies every project, cover and note into a folder on this computer', h('button', { className: 'btn', onclick: () => { d.close(); backupAll(); } }, 'Back up'))),
    // The share-sheet Shortcut is for the web app; hidden inside the sideloaded iPhone app.
    !nativeHaptics && h('div', { className: 'set-sec' }, h('h3', {}, '[iphone web app]'),
      row('Upload from the share sheet', 'Web app only (Safari / Home Screen), not the sideloaded app. Send audio straight from AirDrop, Files or iMessage.', h('button', { className: 'btn', onclick: () => { d.close(); shortcutDialog(); } }, 'Set up'))),
    h('div', { className: 'set-sec' }, h('h3', {}, '[account]'),
      S.me && row(h('span', { className: 'me-row' }, meAvatar, h('span', {}, S.me.username, h('small', {}, S.me.isAdmin ? 'Admin' : 'Member'))), null,
        h('span', { className: 'btns', style: { margin: 0 } },
          h('button', { className: 'btn', async onclick() {
            const [file] = await pickFiles('image/*,.heic,.heif', false);
            if (!file) return;
            try { const avatar = await avatarData(file); await api('/me', { method: 'PATCH', body: { avatar } }); S.me.avatar = avatar; paintAvatar(meAvatar, avatar); renderSide(); } catch (e) { oops(e); }
          } }, 'Picture'),
          h('button', { className: 'btn', async onclick() {
            const name = await prompt('Change username', S.me.username, { label: 'Username', ok: 'Save' });
            if (!name || name === S.me.username) return;
            try { await api('/me', { method: 'PATCH', body: { username: name } }); d.close(); load(); toast('Username changed'); } catch (e) { oops(e); }
          } }, 'Rename'))),
      S.me?.storage === 'drive' && row('Google Drive', S.me.driveEmail || (S.me.driveConnected ? 'Connected' : 'Not connected'),
        h('a', { className: 'btn', href: '/api/drive/connect' }, S.me.driveConnected ? 'Reconnect' : 'Connect')),
      S.me?.isAdmin && row('People', 'Invite codes and accounts', h('button', { className: 'btn', onclick: () => { d.close(); peopleDialog(); } }, 'Manage')),
      row('Password', 'Changing it logs out your other devices', h('button', { className: 'btn', onclick: () => { d.close(); passwordDialog(); } }, 'Change')),
      row('Log out', 'On this device only. Songs kept on this device are removed.', h('button', { className: 'btn danger', onclick: logout }, 'Log out'))),
    h('div', { className: 'btns' }, h('span', { className: 'mono', style: { marginRight: 'auto', color: 'var(--fg-3)', alignSelf: 'center' } }, '[vault] v1.4'),
      h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  if (only) d.querySelectorAll('.set-sec').forEach(sec => sec.querySelector('h3').textContent !== `[${only}]` && sec.remove());
  api('/versions/old').then(({ count, size }) => {
    oldInfo.textContent = count ? `${count} older ${count === 1 ? 'version' : 'versions'} of edited tracks · ${fmtBytes(size)}` : 'None. Only the versions in use are stored.';
    oldBtn.disabled = !count;
  }, () => { oldInfo.textContent = 'Couldn’t check'; });
  // Size of the offline audio cache on this device.
  let bytes = 0;
  try { const c = await caches.open('audio'); for (const k of await c.keys()) bytes += (await (await c.match(k)).blob()).size; } catch {}
  local.textContent = `${S.offline.size} ${S.offline.size === 1 ? 'track' : 'tracks'} · ${fmtBytes(bytes)}`;
}

// Push notifications on this device: someone played a share link, or left a comment.
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
function pushRow() {
  const sub = h('small', {}, 'Checking…'), btns = h('span', { className: 'btns', style: { margin: 0 } });
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const worker = () => Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 4000, null))]);
  async function draw() {
    if (!supported) {
      sub.textContent = /iPhone|iPad/.test(navigator.userAgent)
        ? 'On iPhone: Share → Add to Home Screen, open [vault] from your Home Screen, then turn this on there.'
        : "This browser can't show notifications.";
      return fill(btns);
    }
    if (Notification.permission === 'denied') { sub.textContent = 'Blocked. Allow notifications for this site (on iPhone: Settings → Notifications → [vault]).'; return fill(btns); }
    const reg = await worker();
    if (!reg) { sub.textContent = "The app's background worker isn't running. Reload and try again."; return fill(btns); }
    const s = await reg.pushManager.getSubscription();
    sub.textContent = s ? 'On for this device' : 'When someone plays one of your links or leaves a comment';
    fill(btns, s
      ? [h('button', { className: 'btn', onclick: test }, 'Test'), h('button', { className: 'btn', onclick: () => off(s) }, 'Turn off')]
      : h('button', { className: 'btn', onclick: on }, 'Turn on'));
  }
  async function on() {
    try {
      if ((await Notification.requestPermission()) !== 'granted') return draw();
      const reg = await worker();
      const { key } = await api('/push/key');
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
      await api('/push/subscribe', { method: 'POST', body: s.toJSON() });
      toast('Notifications are on for this device');
    } catch (e) { oops(e); }
    draw();
  }
  async function off(s) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: s.endpoint } }).catch(() => {});
    await s.unsubscribe().catch(() => {});
    draw();
  }
  async function test() {
    const r = await api('/push/test', { method: 'POST' }).catch(oops);
    if (r) toast(r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}` : "Couldn't reach this device. Turn notifications off and on again.", { error: !r.sent });
  }
  draw();
  return h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Listens & comments', sub), btns);
}

function passwordDialog() {
  const field = (auto) => h('input', { type: 'password', required: true, autocomplete: auto });
  const cur = field('current-password'), next = field('new-password'), again = field('new-password');
  const err = h('p', { className: 'form-err' });
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      if (next.value.length < 8) return (err.textContent = 'Use at least 8 characters.');
      if (next.value !== again.value) return (err.textContent = "The new passwords don't match.");
      try {
        await api('/password', { method: 'POST', body: { current: cur.value, next: next.value } });
        d.close(); toast('Password changed. Your other devices were logged out.', { ms: 5000 });
      } catch (x) { err.textContent = x.message; }
    },
  }, h('h2', {}, 'Change password'),
  h('label', {}, 'Current password', cur), h('label', {}, 'New password (8+ characters)', next), h('label', {}, 'New password again', again), err,
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Change password'))));
}

// Admin: make invite codes, see who has an account, turn accounts off or delete them.
async function peopleDialog() {
  const box = h('div', { className: 'stack' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'People'), box,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  const copy = async text => { try { await navigator.clipboard.writeText(text); toast('Copied', { ms: 1200 }); } catch { prompt('Copy this', text, { label: 'Code', ok: 'Done' }); } };
  async function draw() {
    const [users, invites] = await Promise.all([api('/admin/users'), api('/admin/invites')]).catch(e => (oops(e), [[], []]));
    const open = invites.filter(i => !i.used_by);
    fill(box,
      h('div', { className: 'set-sec' }, h('h3', {}, '[invite codes]'),
        h('p', { className: 'muted', style: { margin: 0 } }, 'Each code makes one account. Send it to someone, and they choose “Sign up” on the login screen.'),
        open.map(i => h('div', { className: 'set-row' }, h('div', { className: 't' }, h('code', { className: 'mono' }, i.code), h('small', {}, `Made ${fmtAdded(i.created_at).toLowerCase()}`)),
          h('span', { className: 'btns', style: { margin: 0 } }, h('button', { className: 'btn', onclick: () => copy(i.code) }, 'Copy'),
            h('button', { className: 'btn danger', async onclick() { await api(`/admin/invites/${i.code}`, { method: 'DELETE' }).catch(oops); draw(); } }, 'Delete')))),
        h('button', { className: 'btn', async onclick() { const { code } = await api('/admin/invites', { method: 'POST' }).catch(oops) || {}; if (code) await copy(code); draw(); } }, icon('plus', 14), 'New invite code')),
      h('div', { className: 'set-sec' }, h('h3', {}, '[accounts]'),
        users.map(u => h('div', { className: 'set-row' }, h('span', { className: 'me-row' }, avatarEl(u, 'avatar lg'),
          h('span', {}, u.username + (u.disabled ? ' (off)' : ''), h('small', {}, u.is_admin ? `Admin · Backblaze · ${fmtBytes(u.used)}` : `${u.tracks} ${u.tracks === 1 ? 'track' : 'tracks'} · ${fmtBytes(u.used)} · ${u.drive ? 'Google Drive' : 'Drive not connected'}`))),
          !u.is_admin && h('span', { className: 'btns', style: { margin: 0 } },
            h('button', { className: 'btn', async onclick() { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }).catch(oops); draw(); } }, u.disabled ? 'Turn on' : 'Turn off'),
            h('button', { className: 'btn danger', async onclick() {
              if (!(await confirm(`Delete ${u.username}?`, 'Their projects are deleted, along with the files [vault] made in their Google Drive. This can\'t be undone.', 'Delete'))) return;
              const t = toast('Deleting…', { ms: 0 });
              try { while ((await api(`/admin/users/${u.id}`, { method: 'DELETE' })).more); } catch (e) { oops(e); }
              t.remove(); draw();
            } }, 'Delete'))))));
  }
  draw();
}

// iPhone share sheet: a Shortcut that sends the shared file to /api/shortcut-upload with a private upload key.
async function shortcutDialog() {
  const box = h('div', { className: 'stack' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack sc' }, h('h2', {}, 'Upload from the iPhone share sheet'), box,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  const endpoint = `${location.origin}/api/shortcut-upload`;
  const copyBtn = (text, label = 'Copy') => h('button', { className: 'btn', type: 'button', async onclick() { try { await navigator.clipboard.writeText(text); toast('Copied', { ms: 1200 }); } catch { prompt('Copy this', text, { label: 'Text', ok: 'Done' }); } } }, label);
  const code = (text) => h('div', { className: 'sc-code' }, h('code', {}, text), copyBtn(text));
  async function draw(newKey) {
    const { exists } = newKey ? { exists: true } : await api('/upload-key').catch(e => (oops(e), { exists: false }));
    const makeKey = async () => { const { key } = await api('/upload-key', { method: 'POST' }); draw(key); };
    fill(box,
      h('p', { className: 'muted', style: { margin: 0 } }, 'For the web app only (Safari or the Home Screen icon), not the sideloaded [vault] app. Make one iPhone Shortcut, then choose “Upload to [vault]” whenever you share an audio file. It lands in your Inbox with BPM and key read from the name.'),
      newKey
        ? h('div', { className: 'stack' }, h('b', {}, 'Your upload key'), code(newKey), h('small', { className: 'muted' }, "Copy it now. It won't be shown again; make a new one any time."))
        : exists
          ? h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Upload key is on', h('small', {}, 'Lost it? Make a new one; the old one stops working.')),
            h('span', { className: 'btns', style: { margin: 0 } }, h('button', { className: 'btn', onclick: makeKey }, 'New key'),
              h('button', { className: 'btn danger', async onclick() { await api('/upload-key', { method: 'DELETE' }); draw(); toast('Upload key turned off'); } }, 'Turn off')))
          : h('button', { className: 'btn primary', onclick: makeKey }, 'Create upload key'),
      h('ol', { className: 'sc-steps' },
        h('li', {}, 'Open the ', h('b', {}, 'Shortcuts'), ' app → ', h('b', {}, '+'), '. Name it ', h('b', {}, 'Upload to [vault]'), '.'),
        h('li', {}, 'Tap ', h('b', {}, 'ⓘ'), ' → turn on ', h('b', {}, 'Show in Share Sheet'), '. Set it to receive ', h('b', {}, 'Files'), '.'),
        h('li', {}, 'Add ', h('b', {}, 'Repeat with Each'), ' (item in ', h('i', {}, 'Shortcut Input'), '). Put the next steps inside it.'),
        h('li', {}, 'Add ', h('b', {}, 'Get Details of Files'), ' → ', h('b', {}, 'Name'), ' of ', h('i', {}, 'Repeat Item'), ', then ', h('b', {}, 'URL Encode'), ' that name.'),
        h('li', {}, 'Add ', h('b', {}, 'Get Details of Files'), ' → ', h('b', {}, 'File Extension'), ' of ', h('i', {}, 'Repeat Item'), '.'),
        h('li', {}, 'Add ', h('b', {}, 'Get Contents of URL'), '. URL: this, then the URL-encoded name, ', h('code', {}, '&ext='), ', then the file extension:', code(endpoint + '?name=')),
        h('li', {}, 'In that action set ', h('b', {}, 'Method: POST'), '. Add a header ', h('b', {}, 'Authorization'), ' with the value ', h('code', {}, 'Bearer '), ' followed by your key. Set ', h('b', {}, 'Request Body: File'), ' → ', h('i', {}, 'Repeat Item'), '.'),
        h('li', {}, 'Add ', h('b', {}, 'Show Notification'), ' with ', h('i', {}, 'Contents of URL'), ', so you see “Saved … to Inbox”.')),
      h('small', { className: 'muted' }, 'Want a different project? Add ', h('code', {}, '&project=Your Project Name'), ' to the URL. Too many wrong keys locks uploads for 15 minutes.'));
  }
  draw();
}

// ---- trash ----------------------------------------------------------------------------------
async function restore(kind, id) {
  await api('/trash/restore', { method: 'POST', body: { kind, id } }).catch(oops);
  await load();
  toast('Restored', { ms: 1500 });
}
async function renderTrash() {
  const main = $('#main');
  const fresh = lastView !== 'trash'; lastView = 'trash';
  const body = h('div', { className: 'tracks' }, h('div', { className: 'muted', style: { padding: '20px 10px' } }, 'Loading…'));
  const emptyBtn = h('button', { className: 'btn danger', disabled: true, async onclick() {
    if (!(await confirm('Empty the trash?', 'Everything in Recently deleted is removed for good, including every saved version.', 'Empty trash'))) return;
    await api('/trash/empty', { method: 'POST' }).catch(oops); load(); toast('Trash emptied');
  } }, icon('trash', 15), 'Empty trash');
  main.replaceChildren(
    h('div', { className: 'toolbar' }, h('button', { id: 'menu-btn', className: 'icon-btn', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('side-open') }, icon('menu', 20))),
    h('div', { className: 'hero' }, h('div', {},
      h('div', { className: 'eyebrow' }, '[trash]'),
      h('h1', {}, 'Recently deleted'),
      h('div', { className: 'meta mono' }, 'removed for good after 30 days · still counts toward storage until then'),
      h('div', { className: 'actions' }, emptyBtn))),
    body);
  main.classList.toggle('enter', fresh);
  const data = await api('/trash').catch(e => (oops(e), null));
  if (!data || S.view.type !== 'trash') return;
  const left = at => Math.max(0, data.days - Math.floor((Date.now() - at) / 864e5));
  const row = (cover, title, sub, kind, id) => h('div', { className: 'trow trash-row' }, thumb(cover),
    h('div', { style: { minWidth: 0 } }, h('div', { className: 'name' }, title), h('div', { className: 'sub' }, h('span', {}, sub))),
    h('button', { className: 'btn', onclick: () => restore(kind, id) }, 'Restore'),
    h('button', { className: 'icon-btn', 'aria-label': `Delete ${title} forever`, title: 'Delete forever', async onclick() {
      if (!(await confirm(`Delete “${title}” forever?`, 'This can’t be undone.', 'Delete forever'))) return;
      await api(`/trash/${kind}/${id}`, { method: 'DELETE' }).catch(oops); load();
    } }, icon('trash', 16)));
  const items = [
    ...data.projects.map(p => row(p.cover, p.name, `Project · ${p.tracks} ${p.tracks === 1 ? 'track' : 'tracks'} · ${left(p.deleted_at)} days left`, 'project', p.id)),
    ...data.tracks.map(t => row(null, t.name, `in ${t.project} · ${fmtTime(t.duration)} · ${left(t.deleted_at)} days left`, 'track', t.id)),
  ];
  emptyBtn.disabled = !items.length;
  fill(body, items.length ? items : h('div', { className: 'empty' }, h('span', { className: 'disc' }), h('b', {}, 'Nothing here'), 'Deleted tracks and projects wait here for 30 days.'));
}

// ---- selecting several tracks --------------------------------------------------------------
function renderBulk() {
  let bar = $('#bulk');
  if (!bar) { bar = h('div', { id: 'bulk', role: 'toolbar', 'aria-label': 'Selected tracks' }); document.body.append(bar); }
  const show = !!S.select && S.view.type !== 'trash';
  document.body.classList.toggle('bulk-open', show);
  if (!show) {
    if (!bar.hidden && !bar.classList.contains('leaving')) {
      bar.classList.add('leaving');
      setTimeout(() => { if (bar.classList.contains('leaving')) { bar.hidden = true; bar.classList.remove('leaving'); } }, 230);
    }
    return;
  }
  bar.classList.remove('leaving'); bar.hidden = false;
  const picked = () => [...S.select].map(trackOf).filter(Boolean);
  const n = S.select.size, list = visibleTracks(), all = list.length > 0 && list.every(t => S.select.has(t.id));
  const act = (ic, label, run, danger) => h('button', { className: 'btn' + (danger ? ' danger' : ''), disabled: !n, onclick: run, 'aria-label': label }, icon(ic, 15), h('span', { className: 'lbl-sm' }, label));
  const done = () => { S.select = null; load(); };
  // Star / throwaway the selection (or undo it if they all already are), with Undo putting each track back how it was.
  const markAct = (mark, ic, onLabel, offLabel) => {
    const already = n > 0 && picked().every(t => t.mark === mark), to = already ? null : mark;
    return act(ic, already ? offLabel : onLabel, async () => {
      const before = picked().map(t => [t.id, t.mark ?? null]);
      await api('/tracks/bulk', { method: 'POST', body: { ids: before.map(([id]) => id), set: { mark: to } } }).catch(oops);
      const what = { star: ['Starred', 'Unstarred'], throw: ['Marked as throwaways:', 'No longer throwaways:'] }[mark][already ? 1 : 0];
      toast(`${what} ${n}`, { ms: 7000, action: { label: 'Undo', async run() {
        for (const m of ['star', 'throw', null]) {
          const ids = before.filter(([, x]) => x === m).map(([id]) => id);
          if (ids.length) await api('/tracks/bulk', { method: 'POST', body: { ids, set: { mark: m } } }).catch(oops);
        }
        load();
      } } });
      done();
    });
  };
  fill(bar,
    h('span', { className: 'bulk-n num' }, n, h('span', { className: 'lbl-sm' }, ' selected')),
    h('button', { className: 'btn ghost', onclick() { list.forEach(t => (all ? S.select.delete(t.id) : S.select.add(t.id))); renderList(); renderBulk(); } }, all ? 'None' : 'All'),
    h('span', { className: 'grow' }),
    act('folder', 'Move', async () => {
      const to = await projectPicker(`Move ${n} ${n === 1 ? 'track' : 'tracks'}`);
      if (!to) return;
      await api('/tracks/bulk', { method: 'POST', body: { ids: [...S.select], set: { project_id: to } } }).catch(oops);
      toast(`Moved ${n} to ${projectOf(to)?.name}`); done();
    }),
    act('tag', 'Tag', async () => {
      const tag = await prompt(`Tag ${n} ${n === 1 ? 'track' : 'tracks'}`, '', { label: 'Tag to add', ok: 'Add tag' });
      if (!tag) return;
      for (const t of picked()) if (!tagsOf(t).includes(tag)) await api(`/tracks/${t.id}`, { method: 'PATCH', body: { tags: [...tagsOf(t), tag].join(', ') } }).catch(oops);
      toast(`Tagged ${n} “${tag}”`); done();
    }),
    markAct('star', 'star', 'Star', 'Unstar'),
    markAct('throw', 'ban', 'Throwaway', 'Keep'),
    act('pencil', 'Producer', async () => {
      const name = await prompt('Set producer / artist', settings.artist, { label: 'Producer / artist', ok: 'Save' });
      if (name == null) return;
      await api('/tracks/bulk', { method: 'POST', body: { ids: [...S.select], set: { artist: name } } }).catch(oops);
      done();
    }),
    act('gauge', 'Detect', () => detectTracks(picked(), true)),
    act('download', 'ZIP', () => zipTracks(picked(), 'Selected tracks')),
    act('trash', 'Delete', async () => {
      const ids = [...S.select];
      await api('/tracks/bulk', { method: 'POST', body: { ids, trash: true } }).catch(oops);
      toast(`Moved ${ids.length} to the trash`, { ms: 7000, action: { label: 'Undo', async run() { for (const id of ids) await api('/trash/restore', { method: 'POST', body: { kind: 'track', id } }).catch(oops); load(); } } });
      done();
    }, true),
  );
}
function projectPicker(title) {
  return new Promise(res => {
    const sel = h('select', {}, [...S.projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: p.id, selected: S.view.id === p.id }, p.name)));
    const d = dialog(h('form', { onsubmit(e) { e.preventDefault(); res(sel.value); d.close(); } },
      h('h2', {}, title), h('label', {}, 'Project', sel),
      h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Move'))));
    d.addEventListener('close', () => res(null));
  });
}

// ---- filters --------------------------------------------------------------------------------
function blankFilter() { return { bpmMin: '', bpmMax: '', key: '', mode: '', tag: '', throw: '' }; }
function filterDialog() {
  const f = { ...S.filter };
  const num = (k, ph) => h('input', { type: 'number', min: 40, max: 250, step: 1, value: f[k], placeholder: ph, inputMode: 'numeric', oninput() { f[k] = this.value; } });
  const allTags = [...new Set(S.tracks.flatMap(tagsOf))].sort();
  const mode = h('div', { className: 'seg-row', role: 'radiogroup' });
  const drawMode = () => fill(mode, [['', 'Any'], ['maj', 'Major'], ['min', 'Minor']].map(([v, l]) =>
    h('button', { type: 'button', className: 'btn' + (f.mode === v ? ' on' : ''), role: 'radio', 'aria-checked': f.mode === v, onclick() { f.mode = v; drawMode(); } }, l)));
  drawMode();
  const thr = h('div', { className: 'seg-row', role: 'radiogroup' });
  const drawThr = () => fill(thr, [['', 'Show'], ['hide', 'Hide'], ['only', 'Only these']].map(([v, l]) =>
    h('button', { type: 'button', className: 'btn' + (f.throw === v ? ' on' : ''), role: 'radio', 'aria-checked': f.throw === v, onclick() { f.throw = v; drawThr(); } }, l)));
  drawThr();
  const d = dialog(h('form', { onsubmit(e) { e.preventDefault(); S.filter = f; d.close(); renderMain(); } },
    h('h2', {}, 'Filter'),
    h('div', { className: 'row2' }, h('label', {}, 'BPM from', num('bpmMin', '120')), h('label', {}, 'BPM to', num('bpmMax', '160'))),
    h('label', {}, 'Key', h('select', { onchange() { f.key = this.value; } }, h('option', { value: '' }, 'Any key'), KEYS.map(k => h('option', { value: k, selected: f.key === k }, k)))),
    h('label', {}, 'Major / minor', mode),
    h('label', {}, 'Throwaways', thr),
    allTags.length > 0 && h('label', {}, 'Tag', h('select', { onchange() { f.tag = this.value; } }, h('option', { value: '' }, 'Any tag'), allTags.map(t => h('option', { value: t, selected: f.tag === t }, t)))),
    h('div', { className: 'btns' },
      h('button', { type: 'button', className: 'btn ghost', style: { marginRight: 'auto' }, onclick() { S.filter = blankFilter(); d.close(); renderMain(); } }, 'Clear all'),
      h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'),
      h('button', { className: 'btn primary' }, 'Apply'))));
}

// ---- ZIP downloads and full backups ------------------------------------------------------------
const extOf = t => (t.file_key || '').split('.').pop() || 'mp3';
const trackMeta = t => ({ name: t.name, project: projectOf(t.project_id)?.name, producer: t.artist || undefined, bpm: t.bpm, key: t.musical_key, tags: t.tags || undefined, notes: t.notes || undefined, added: new Date(t.created_at).toISOString() });
function saveBlob(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function coverBlob(key) {
  const { url } = await api(`/cover/${key}?json=1`);
  const r = await fetch(url);
  return r.ok ? r.blob() : null;
}
// ponytail: builds the ZIP in memory; fine for projects up to a few hundred MB. Use "Back up everything" for the whole library.
async function zipTracks(list, name, cover) {
  if (!list.length) return toast('Nothing to download');
  const note = toast('', { ms: 0 }), used = new Set(), entries = [];
  const unique = n => { let x = n, i = 2; while (used.has(x.toLowerCase())) x = n.replace(/(\.[^.]+)$/, ` (${i++})$1`); used.add(x.toLowerCase()); return x; };
  try {
    for (const [i, t] of list.entries()) {
      note.textContent = `Preparing ZIP… ${i + 1} of ${list.length}`;
      entries.push({ name: unique(`${String(i + 1).padStart(2, '0')} ${safeName(t.name)}.${extOf(t)}`), data: await audioBlob(t) });
    }
    if (cover) { const b = await coverBlob(cover).catch(() => null); if (b) entries.push({ name: 'cover.jpg', data: b }); }
    entries.push({ name: 'tracks.json', data: JSON.stringify(list.map(trackMeta), null, 2) });
    note.textContent = 'Building ZIP…';
    saveBlob(await makeZip(entries), `${safeName(name)}.zip`);
  } catch (e) { oops(e); }
  note.remove();
}
// Writes the whole library into a folder you pick (folders → projects → files). Chrome/Edge on a computer.
async function backupAll() {
  if (!window.showDirectoryPicker) return toast('Full backup needs Chrome or Edge on a computer. On this device, use ⋯ → Download as ZIP on each project.', { ms: 9000 });
  let root;
  try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  const top = await root.getDirectoryHandle(`[vault] backup ${new Date().toISOString().slice(0, 10)}`, { create: true });
  const folderPath = id => { const out = []; for (let f = S.folders.find(x => x.id === id); f; f = S.folders.find(x => x.id === f.parent_id)) out.unshift(safeName(f.name)); return out; };
  const dirFor = async parts => { let d = top; for (const p of parts) d = await d.getDirectoryHandle(p, { create: true }); return d; };
  const write = async (dir, name, data) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); };
  const total = S.tracks.length, note = toast('', { ms: 0 });
  let done = 0, failed = 0;
  try {
    for (const p of S.projects) {
      const tracks = S.tracks.filter(t => t.project_id === p.id).sort((a, b) => a.position - b.position);
      const dir = await dirFor([...folderPath(p.folder_id), safeName(p.name)]);
      const used = new Set();
      for (const [i, t] of tracks.entries()) {
        note.textContent = `Backing up ${++done} of ${total}…`;
        let fname = `${String(i + 1).padStart(2, '0')} ${safeName(t.name)}.${extOf(t)}`;
        while (used.has(fname.toLowerCase())) fname = fname.replace(/(\.[^.]+)$/, ' (2)$1');
        used.add(fname.toLowerCase());
        try { await write(dir, fname, await audioBlob(t)); } catch { failed++; }
      }
      if (p.cover) { const b = await coverBlob(p.cover).catch(() => null); if (b) await write(dir, 'cover.jpg', b); }
      await write(dir, 'tracks.json', JSON.stringify(tracks.map(trackMeta), null, 2));
    }
    await write(top, 'library.json', JSON.stringify({ exported: new Date().toISOString(), folders: S.folders, projects: S.projects.map(p => ({ name: p.name, folder: folderPath(p.folder_id).join('/') })), tracks: S.tracks.map(trackMeta) }, null, 2));
    toast(failed ? `Backed up ${total - failed} of ${total} tracks (${failed} failed — run it again to retry).` : `Backed up all ${total} tracks.`, { ms: 8000, error: failed > 0 });
  } catch (e) { oops(e); }
  note.remove();
}

// Phones: the project cover shrinks and fades as you scroll away from it, anchored at its top edge.
// It drifts at half the scroll speed and eases out over 1.3× its own height, until it's gone.
let coverFrame = 0;
$('#main').addEventListener('scroll', function () {
  if (coverFrame || !phone.matches) return;
  coverFrame = requestAnimationFrame(() => {
    coverFrame = 0;
    const art = this.querySelector('.hero .art');
    if (!art) return;
    const y = this.scrollTop, p = Math.min(1, Math.max(0, y / (art.offsetHeight * 1.3)));
    const e = p * p * (3 - 2 * p); // smoothstep: gentle start, gentle finish
    art.style.scale = (1 - e * 0.85).toFixed(4);
    art.style.opacity = (1 - e).toFixed(4);
    art.style.translate = `0 ${(y * 0.5).toFixed(1)}px`;
  });
}, { passive: true });

// The holographic background cycles its colours slowly. Scrolling speeds the cycle up with how fast you scroll
// (up to ~40×), then it eases back to its normal pace. Uses the CSS animation's playbackRate, so it stays smooth.
let holoRate = 1, holoLast = null, holoFrame = 0, holoAnim = null;
const holoCycle = () => (holoAnim?.playState === 'running' ? holoAnim : (holoAnim = document.getAnimations?.().find(a => a.animationName === 'holo-hue')));
function holoEase() {
  holoRate = holoRate < 1.02 ? 1 : 1 + (holoRate - 1) * 0.965;
  const a = holoCycle();
  if (a) a.playbackRate = holoRate;
  holoFrame = holoRate > 1 ? requestAnimationFrame(holoEase) : 0;
}
$('#main').addEventListener('scroll', function () {
  const now = performance.now(), y = this.scrollTop;
  if (holoLast && now - holoLast.t < 200) {
    const speed = Math.abs(y - holoLast.y) / Math.max(8, now - holoLast.t); // px per ms
    holoRate = Math.max(holoRate, Math.min(40, 1 + speed * 22));
  }
  holoLast = { y, t: now };
  if (!holoFrame) holoFrame = requestAnimationFrame(holoEase);
}, { passive: true });

// ---- keyboard shortcuts (computers). Not while typing; pop-ups and the editor keep their own keys. ----
const SHORTCUTS = [['Space', 'Play / pause'], ['← →', 'Back / forward 5 seconds'], ['Shift + ← →', 'Previous / next track'], ['S', 'Star the playing track'],
  ['T', 'Mark the playing track as a throwaway'], ['Q', 'Up next'], ['/', 'Search'], ['H', 'Home'], ['?', 'This list']];
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable || e.target.getAttribute?.('role') === 'slider') return;
  if (document.querySelector('dialog[open]')) return;
  const k = e.key, go = fn => { e.preventDefault(); fn(); };
  if (k === ' ') return go(() => cur && (audio.paused ? audio.play() : audio.pause()));
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    if (!cur) return;
    const fwd = k === 'ArrowRight';
    return go(() => (e.shiftKey ? (fwd ? skip() : playPrev()) : (audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + (fwd ? 5 : -5))))));
  }
  if (k === 's' || k === 'S') return cur && go(() => setMark(cur, cur.mark === 'star' ? null : 'star'));
  if (k === 't' || k === 'T') return cur && go(() => setMark(cur, cur.mark === 'throw' ? null : 'throw'));
  if (k === 'q' || k === 'Q') return cur && go(queueDialog);
  if (k === '/') return go(() => $('.search input')?.focus());
  if (k === 'h' || k === 'H') return go(() => setView({ type: 'home' }));
  if (k === '?') return go(shortcutsDialog);
});
function shortcutsDialog() {
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Keyboard shortcuts'),
    h('div', { className: 'keys' }, SHORTCUTS.map(([k, what]) => h('div', { className: 'key-row' }, h('span', {}, what), h('span', { className: 'kbds' }, k.split(' ').map(x => (x === '+' ? h('span', { className: 'plus' }, '+') : h('kbd', {}, x))))))),
    h('small', { className: 'muted' }, 'In the editor: Space plays, B flips A/B, double-click a dial to reset it.'),
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
}

// ---- storage manager: what the 10 GB is made of, and the quickest ways to free some ----
async function storageDialog() {
  document.body.classList.remove('side-open');
  const body = h('div', { className: 'stack' }, h('div', { className: 'muted' }, 'Adding it up…'));
  const d = dialog(h('div', { className: 'stack storage' }, h('h2', {}, 'Storage'), body,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg wide' });
  // Actions don't close this; they redraw it with fresh numbers (keeping your scroll position).
  async function draw() {
  let s;
  try { s = await api('/storage'); } catch (e) { return fill(body, h('div', { className: 'form-err' }, e.message)); }
  const keep = d.scrollTop;
  const used = s.current + s.old + s.trash, pc = v => Math.max(0, (v / s.limit) * 100);
  let device = 0;
  try { const c = await caches.open('audio'); for (const k of await c.keys()) device += (await (await c.match(k)).blob()).size; } catch {}
  // current audio by format
  const fmt = {};
  for (const t of S.tracks) { const x = (t.file_key.split('.').pop() || '?').toUpperCase(); fmt[x] = (fmt[x] || 0) + (t.size || 0); }
  const formats = Object.entries(fmt).sort((x, y) => y[1] - x[1]);
  const top = Math.max(1, ...s.projects.map(p => p.size)), topT = Math.max(1, ...s.tracks.map(t => t.size));
  const seg = (cls, v, label) => v > 0 && h('i', { className: 'seg-' + cls, style: { width: pc(v) + '%' }, title: `${label}: ${fmtBytes(v)}` });
  const line = (cls, label, v, sub, action) => h('div', { className: 'st-line' },
    h('span', { className: 'dot seg-' + cls }), h('div', { className: 't' }, label, sub && h('small', {}, sub)), h('span', { className: 'num st-v' }, fmtBytes(v)), action || h('span'));
  fill(body,
    h('div', { className: 'st-total' }, h('b', { className: 'num' }, fmtBytes(used)), h('span', { className: 'muted' }, ` of ${fmtBytes(s.limit)} · ${fmtBytes(Math.max(0, s.limit - used))} free`)),
    h('div', { className: 'st-bar', role: 'img', 'aria-label': `${Math.round(pc(used))}% used` }, seg('cur', s.current, 'Your tracks'), seg('old', s.old, 'Old versions'), seg('trash', s.trash, 'Recently deleted')),
    h('div', { className: 'st-lines' },
      line('cur', 'Your tracks', s.current, formats.map(([x, v]) => `${x} ${fmtBytes(v)}`).join(' · ')),
      line('old', 'Old versions', s.old, 'Earlier versions kept from edits', s.old > 0 && h('button', { className: 'btn', onclick: async () => { if (await cleanVersions()) draw(); } }, 'Delete')),
      line('trash', 'Recently deleted', s.trash, 'Goes for good after 30 days', s.trash > 0 && h('button', { className: 'btn', async onclick() {
        if (!(await confirm('Empty Recently deleted?', 'Everything in it is deleted for good.', 'Empty'))) return;
        await api('/trash/empty', { method: 'POST' }).catch(oops); toast(`Freed ${fmtBytes(s.trash)}`); await load(); draw();
      } }, 'Empty')),
      line('dev', 'Kept on this device', keptBytes(), 'Played songs, so they don\'t download again; not counted in the 10 GB', keptBytes() > 0 && h('button', { className: 'btn', async onclick() {
        await caches.delete(KEPT); store.set('played', {}); toast('Cleared. Songs will download again the next time they play.'); draw();
      } }, 'Clear')),
      line('dev', 'Downloaded on this device', device, 'Offline copies; not counted in the 10 GB', device > 0 && h('button', { className: 'btn', async onclick() {
        await caches.delete('audio'); S.offline.clear(); store.set('offline', []); render(); toast('Downloads removed from this device'); draw();
      } }, 'Remove'))),
    s.projects.length > 0 && h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Biggest projects'),
      h('div', { className: 'st-list' }, s.projects.slice(0, 12).map(p => h('button', { className: 'st-item', onclick: () => { d.close(); setView({ type: 'project', id: p.id }); } },
        h('span', { className: 'grow' }, p.name, h('small', {}, `${p.tracks} ${p.tracks === 1 ? 'track' : 'tracks'}`)),
        h('span', { className: 'st-mini' }, h('i', { style: { width: (p.size / top) * 100 + '%' } })), h('span', { className: 'num st-v' }, fmtBytes(p.size)))))),
    s.tracks.length > 0 && h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Biggest tracks'),
      h('div', { className: 'st-list' }, s.tracks.slice(0, 15).map(t => h('div', { className: 'st-item' },
        h('button', { className: 'grow st-open', onclick: () => { const x = trackOf(t.id); if (!x) return; detailsDialog(x); [...document.querySelectorAll('dialog')].pop().addEventListener('close', () => draw()); } }, t.name,
          h('small', {}, [projectOf(t.project_id)?.name, (t.file_key.split('.').pop() || '').toUpperCase(), t.versions > 1 && `${t.versions} versions`].filter(Boolean).join(' · '))),
        h('span', { className: 'st-mini' }, h('i', { style: { width: (t.size / topT) * 100 + '%' } })), h('span', { className: 'num st-v' }, fmtBytes(t.size)),
        h('button', { className: 'icon-btn sm', 'aria-label': `Move ${t.name} to the trash`, title: 'Move to trash', async onclick() {
          await api(`/tracks/${t.id}`, { method: 'DELETE' }).catch(oops);
          this.closest('.st-item').classList.add('gone');
          toast(`Moved “${t.name}” to the trash`, { ms: 7000, action: { label: 'Undo', run: () => restore('track', t.id).then(draw) } });
          await load(); setTimeout(draw, 400);
        } }, icon('trash', 15)))))));
  d.scrollTop = keep;
  }
  draw();
}

// No accidental zooming on phones. Safari ignores the viewport setting in a browser tab, so pinches are blocked here too.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---- swipe gestures (touch) ----
// Haptic tick: vibrate() on Android; on iPhone (Safari 18+) tapping a hidden "switch" gives a light tap.
// Haptic tap. Android: vibrate(). iPhone (iOS 18+): Safari taps when a "switch" checkbox flips, so a hidden one is made
// and flipped. iPhones only allow that straight after a tap or a release (not mid-swipe), so on iPhone it's used on release.
// ponytail: the iPhone part relies on Safari behaviour, not an official API; Apple could change it.
// In the [vault] iPhone app (ios-app/), haptics go to the native vibration engine instead, which works any time.
const nativeHaptics = window.webkit?.messageHandlers?.haptic;
const canVibrate = !!nativeHaptics || typeof navigator.vibrate === 'function';
export function haptic(style = 'light') {
  try {
    if (nativeHaptics) return void nativeHaptics.postMessage(style);
    if (canVibrate) return void navigator.vibrate(8);
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('switch', ''); label.append(input);
    label.setAttribute('aria-hidden', 'true'); label.style.display = 'none';
    document.head.append(label); label.click(); label.remove();
  } catch {}
}
// For moments in the middle of a gesture: only Android can tap then.
const hapticMid = () => { if (canVibrate) haptic(); };
const SWIPE_ACT = 72, SWIPE_FAR = 168;
let sw = null; // the gesture in progress
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || document.querySelector('dialog[open]')) return;
  const p = e.touches[0], sideOpen = document.body.classList.contains('side-open');
  // sidebar: swipe in from the left edge to open; swipe left anywhere to close
  if (phone.matches && (sideOpen || p.clientX < 22)) { sw = { kind: 'side', x: p.clientX, y: p.clientY, open: sideOpen }; return; }
  const row = e.target.closest('.trow[data-id]');
  if (!row || S.arrange || S.select || e.target.closest('.grip')) return;
  sw = { kind: 'row', row, x: p.clientX, y: p.clientY, t: trackOf(row.dataset.id), stage: 0 };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!sw) return;
  const p = e.touches[0], dx = p.clientX - sw.x, dy = p.clientY - sw.y;
  if (!sw.locked) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    if (Math.abs(dy) > Math.abs(dx)) { sw = null; return; } // it's a scroll
    sw.locked = true;
    if (sw.kind === 'side') { const s = $('#side'); s.style.transition = 'none'; sw.w = s.offsetWidth; }
    else { sw.row.classList.add('swiping'); sw.row.append(sw.bg = h('span', { className: 'swipe-bg' }, h('span', { className: 'sw-ic' }))); }
  }
  e.preventDefault();
  if (sw.kind === 'side') {
    const x = Math.max(-sw.w, Math.min(0, (sw.open ? 0 : -sw.w) + dx));
    $('#side').style.transform = `translateX(${x}px)`;
    document.body.style.setProperty('--side-p', 1 + x / sw.w);
    return;
  }
  const x = dx > 0 ? Math.min(dx, 140) : Math.max(dx, -220) * (dx < -SWIPE_FAR ? 0.9 : 1);
  sw.row.style.setProperty('--sx', x + 'px');
  sw.row.style.setProperty('--sp', Math.min(1, Math.abs(dx) / SWIPE_ACT).toFixed(3)); // how close to counting (icon grows)
  const stage = dx > SWIPE_ACT ? 1 : dx < -SWIPE_FAR ? -2 : dx < -SWIPE_ACT ? -1 : 0;
  if (stage !== sw.stage && stage) hapticMid();
  sw.stage = stage;
  // the icon shows from the first pixel (it grows via --sp); the word appears once letting go would count
  const t = sw.t, right = dx > 0, key = (right ? 'r' : 'l') + stage;
  if (key !== sw.key) {
    sw.key = key;
    const ic = right ? 'queue' : stage === -2 ? 'ban' : 'star';
    const word = right ? 'Queue' : stage === -2 ? (t?.mark === 'throw' ? 'Keep' : 'Throwaway') : (t?.mark === 'star' ? 'Unstar' : 'Star');
    sw.bg.className = 'swipe-bg ' + (right ? 'right' : 'left') + (stage === 1 ? ' go-queue' : stage === -1 ? ' go-star' : stage === -2 ? ' go-throw' : '');
    sw.bg.firstChild.replaceChildren(icon(ic, 20), h('span', {}, word));
  }
}, { passive: false });
const endSwipe = () => {
  const g = sw; sw = null;
  if (!g?.locked) return;
  if (g.kind === 'side') {
    const s = $('#side'), tf = getComputedStyle(s).transform, now = tf === 'none' ? 0 : new DOMMatrix(tf).m41, open = now > -g.w * 0.55;
    s.style.transition = ''; s.style.transform = ''; document.body.style.removeProperty('--side-p');
    document.body.classList.toggle('side-open', open);
    return;
  }
  const { row, t, stage } = g;
  row.dataset.swiped = '1'; setTimeout(() => delete row.dataset.swiped, 400); // don't treat it as a tap (play)
  // let go: the strip fades at once while the row glides back, so nothing overlaps the title
  g.bg?.classList.add('leaving');
  row.classList.add('swipe-back'); row.style.setProperty('--sx', '0px');
  setTimeout(() => { row.classList.remove('swiping', 'swipe-back'); row.style.removeProperty('--sp'); g.bg?.remove(); }, 380);
  if (stage && !canVibrate) haptic(); // iPhone: the tap comes as you let go
  if (stage) { const ok = 'ok-' + (stage === 1 ? 'queue' : stage === -1 ? 'star' : 'throw'); row.classList.add(ok); setTimeout(() => row.classList.remove(ok), 700); }
  if (!t) return;
  if (stage === 1) addToQueue(t);
  else if (stage === -1) setMark(t, t.mark === 'star' ? null : 'star');
  else if (stage === -2) setMark(t, t.mark === 'throw' ? null : 'throw');
};
document.addEventListener('touchend', endSwipe); document.addEventListener('touchcancel', endSwipe);

// Phones: tapping anywhere outside the open sidebar just closes it (and doesn't press whatever is underneath).
document.addEventListener('click', e => {
  if (!document.body.classList.contains('side-open') || e.target.closest('#side, #menu-btn, dialog, #toasts')) return;
  e.preventDefault(); e.stopPropagation();
  document.body.classList.remove('side-open');
}, true);
addEventListener('keydown', e => { if (e.key === 'Escape') document.body.classList.remove('side-open'); });

// The gold gradient starred stars are filled with (referenced from CSS as url(#star-gold)).
document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="star-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset=".45" stop-color="#ffcf45"/><stop offset="1" stop-color="#f19a0c"/></linearGradient></defs></svg>');

// ---- boot -----------------------------------------------------------------------------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
addEventListener('online', load);
addEventListener('offline', () => { S.online = false; render(); });
load();
