import { MAX, ACCEPT_AUDIO, ACCEPT_IMAGE, kindOf, extForType } from './types.js';
import { icon } from './icons.js';
import { settings, setSetting, ACCENTS } from './settings.js';
import { decodeAudio, bpmKeyOf, parseName, trackInfo, readTags, cleanTitle, leadNumbers } from './detect.js';
import { peaksOf, waveSvg } from './wave.js';
import { makeZip, safeName } from './zip.js';

const APP_VERSION = '[vault] v3.6.4'; // shown in Settings and sent with bug reports
// ---- helpers ------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onsubmit') { el.noValidate = true; el.addEventListener('submit', sendOnce(el, v)); } // the app shows what's missing itself
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else if (k in el && k !== 'list') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  return fill(el, ...kids), el;
}
// Forms: while one is being sent its buttons are switched off, so a double tap can't send it twice.
const sendOnce = (form, send) => async function (e) {
  if (form.busy) return e.preventDefault();
  if (!form.checkValidity()) { e.preventDefault(); return showMissing(form); }
  form.busy = true;
  const btns = [...form.querySelectorAll('button:not([type=button])')].filter(b => !b.disabled);
  btns.forEach(b => { b.disabled = true; });
  try { await send.call(form, e); } finally { form.busy = false; btns.forEach(b => { b.disabled = false; }); }
};
// A form sent with something missing or wrong: each such field gets a red outline and a short note under it, and the
// first one is brought into view. The note goes as soon as the field is changed.
function markField(el, msg) {
  el.classList.add('invalid');
  el.setAttribute('aria-invalid', 'true');
  const anchor = el.closest('label') || el;
  let note = anchor.nextElementSibling?.classList.contains('field-note') ? anchor.nextElementSibling : null;
  if (!note) { note = h('small', { className: 'field-note', role: 'alert' }); anchor.after(note); }
  note.textContent = msg;
  const clear = () => { el.classList.remove('invalid'); el.removeAttribute('aria-invalid'); note.remove(); };
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', clear, { once: true });
}
function whatsWrong(el) {
  const v = el.validity;
  if (el.type === 'checkbox') return 'Tick this to continue';
  if (v.valueMissing) return 'Fill this in';
  if (v.tooShort) return `Use at least ${el.minLength} characters`;
  if (v.patternMismatch) return el.autocomplete === 'username' ? 'Only letters, numbers, dots, dashes and underscores' : "That doesn't look right";
  if (v.rangeUnderflow || v.rangeOverflow) return `Between ${el.min} and ${el.max}`;
  if (v.typeMismatch) return "That doesn't look right";
  return el.validationMessage || "That doesn't look right";
}
function showMissing(form) {
  const bad = [...form.elements].filter(el => el.willValidate && !el.checkValidity());
  bad.forEach(el => markField(el, whatsWrong(el)));
  const first = bad[0];
  if (!first) return;
  (first.closest('label') || first).scrollIntoView({ block: 'center', behavior: 'smooth' });
  first.focus({ preventScroll: true });
  first.classList.remove('nudge'); void first.offsetWidth; first.classList.add('nudge');
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
  let r;
  try {
    r = await fetch('/api' + path, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // no connection (a TypeError on purpose: that's how load() tells "offline" from a real error)
    throw Object.assign(new TypeError("Can't reach [vault]. Check your connection and try again."), { fromApi: true });
  }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/signup') { showLogin(); throw new Error('Not logged in'); }
  if (!r.ok) throw Object.assign(new Error(plainError(r.status, d.error)), { fromApi: true, status: r.status });
  return d;
}
// What to tell someone when a request fails: the server's own words when it has some, never a bare status code.
const plainError = (status, said) => (said && said !== 'Not found' ? said
  : status === 404 ? "That isn't there any more, or you no longer have access to it."
    : status === 429 ? 'Too many tries. Wait a minute, then try again.'
      : status >= 500 ? "Something went wrong on [vault]'s side. Try again in a moment."
        : "That didn't work. Try again.");
// Nothing fails silently: a request that went wrong and wasn't handled where it was made still says so.
addEventListener('unhandledrejection', e => { if (e.reason?.fromApi) { e.preventDefault(); oops(e.reason); } });

export function toast(msg, { error = false, ms = 3500, action, quiet = false } = {}) {
  const el = h('div', { className: 'toast' + (error ? ' error' : '') + (action ? ' has-action' : '') + (quiet ? ' quiet' : '') }, h('span', {}, msg),
    action && h('button', { className: 'toast-btn', onclick: () => { el.remove(); action.run(); } }, action.label));
  el.remove = () => { el.classList.add('out'); setTimeout(() => Element.prototype.remove.call(el), 200); };
  const box = $('#toasts');
  box.append(el);
  // Toasts live in the top layer (a popover), re-raised each time so they sit above any open menu or dialog, not under its blur.
  try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch {}
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
// Error messages offer to report the problem; the last few are remembered for the report.
const recentErrors = [];
const noteError = msg => { recentErrors.push(`${new Date().toISOString().slice(11, 19)} ${String(msg).slice(0, 300)}`); if (recentErrors.length > 8) recentErrors.shift(); };
addEventListener('error', e => noteError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', e => noteError(e.reason?.message || e.reason));
const oops = e => {
  if (e.message === 'Not logged in') return;
  noteError(e.message);
  return toast(e.message, { error: true, ms: 7000, action: S.me && { label: 'Report', run: () => bugDialog(e.message) } });
};

// locked: can't be closed by Escape or clicking outside (login, Connect Drive, first project)
function dialog(content, { className = '', locked = false } = {}) {
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
  d.addEventListener('cancel', e => { if (locked) e.preventDefault(); else if (!className.includes('editor')) { e.preventDefault(); d.close(); } });
  d.addEventListener('click', e => {
    if (e.target !== d || locked || className.includes('editor')) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); // backdrop click
  });
  document.body.append(d);
  d.showModal();
  const toasts = $('#toasts');
  try { if (toasts?.childElementCount && toasts.matches(':popover-open')) { toasts.hidePopover(); toasts.showPopover(); } } catch {}
  // phones: don't jump into the first text box (that pops the keyboard up); prompts that want typing focus it themselves
  if (matchMedia('(pointer: coarse)').matches && /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { document.activeElement.blur(); d.focus?.(); }
  return d;
}
function prompt(title, value = '', { label = 'Name', ok = 'Save', optional = false, max = 200 } = {}) {
  return new Promise(res => {
    const input = h('input', { type: 'text', value, required: !optional, maxLength: max });
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
  const list = []; // dividers only between groups that have something in them
  for (const it of items.filter(Boolean)) if (it !== '-' || (list.length && list[list.length - 1] !== '-')) list.push(it);
  if (list[list.length - 1] === '-') list.pop();
  const d = dialog(h('div', {}, list.map((it, i) => it === '-' ? h('hr', { style: { '--i': i } }) : h('button', { className: it.danger ? 'danger' : '', style: { '--i': i }, onclick: () => { d.close(); it.run(); } }, it.icon && icon(it.icon), it.label))), { className: 'sheet' });
}
function pickFiles(accept, multiple = true) {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept, multiple });
    i.onchange = () => res([...i.files]);
    i.oncancel = () => res([]);
    i.click();
  });
}

// ---- state ----------------------------------------------------------------------
const S = {
  folders: [], projects: [], tracks: [], usage: 0, limit: 10e9, online: true,
  view: { type: 'home' } /* set from the address at start-up: viewFromHash */, homeFolder: null, sort: store.get('sort', 'newest'), projectSort: store.get('projectSort', 'manual'), q: '', tag: '',
  open: new Set(store.get('open', [])), offline: new Set(store.get('offline', [])),
  filter: blankFilter(), select: null, trash: 0, comments: {}, sharedProjects: [], sharedTracks: [], playlists: [],
  searchIn: 'all', commentHits: new Map(), // search: where to look, and tracks whose comments match (from the server)
};
const playlistOf = id => S.playlists.find(p => p.id === id);
const projectOf = id => S.projects.find(p => p.id === id) || S.sharedProjects.find(p => p.id === id);
const trackOf = id => S.tracks.find(t => t.id === id) || S.sharedTracks.find(t => t.id === id);
// Shared with me: projects people added me to (viewer or editor) and ones saved from a link. A single saved
// track shows as its own little project. Viewers listen; editors can also change tracks; your own = 'owner'.
const roleOf = pid => projectOf(pid)?.role || 'owner';
const canEdit = pid => roleOf(pid) !== 'viewer';
const isShared = pid => !!projectOf(pid)?.owner;
const canComment = pid => !isShared(pid) || !!projectOf(pid)?.member; // the owner and people added to it (not saved links)
function applyTree(d) {
  Object.assign(S, d);
  const sh = d.shared || { projects: [], tracks: [], singles: [] };
  S.sharedProjects = [...sh.projects, ...sh.singles.map(t => ({ id: 'track:' + t.id, name: t.name, cover: t.cover || t.project_cover, owner: t.owner, role: 'viewer', single: t.id, created_at: t.created_at }))];
  S.sharedTracks = [...sh.tracks, ...sh.singles.map(({ owner, project_cover, ...t }) => ({ ...t, project_id: 'track:' + t.id }))];
}
// The page you're on is in the address (/library#project/<id>, #playlist/<id>, #starred …), so refreshing keeps it
// and the browser's back / forward buttons move between pages. Home has no #.
const viewHash = v => (v.type === 'home' ? '' : v.id ? `#${v.type}/${v.id}` : `#${v.type}`);
const VIEW_TYPES = ['home', 'all', 'starred', 'offline', 'trash', 'project', 'playlist'];
function viewFromHash() {
  const [type, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (!VIEW_TYPES.includes(type) || ((type === 'project' || type === 'playlist') && !id)) return { type: 'home' };
  return id && (type === 'project' || type === 'playlist') ? { type, id } : { type };
}
// replace = fix up the address without adding a step to the back button
function markView(v, replace = false) {
  S.view = v; store.set('view', v);
  const want = viewHash(v);
  if (location.hash !== want) history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + want);
}
const setView = v => { markView(v); S.arrange = false; S.select = null; S.homeAll = false; document.body.classList.remove('side-open'); render(); };
addEventListener('popstate', () => { S.view = viewFromHash(); S.arrange = false; S.select = null; S.homeAll = false; document.body.classList.remove('side-open'); render(); });

// Opened from a share page's "Sign in" / "Sign up": go back there once signed in. Only share links are allowed.
try {
  const q = new URLSearchParams(location.search).get('next');
  if (q && /^\/s\/[0-9a-f]{32}$/.test(q)) sessionStorage.setItem('next', q);
} catch {}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me?.needsDrive) load(); });
const takeNext = () => { try { const n = sessionStorage.getItem('next'); sessionStorage.removeItem('next'); return n; } catch { return null; } };

async function load() {
  try {
    const d = await api('/tree');
    applyTree(d); S.online = true;
    store.set('tree', d);
    if (d.me?.needsDrive) { driveBack(); return driveStep(); } // say why connecting didn't work, if it didn't
    $('#login')?.closest('dialog')?.close(); // e.g. Drive was just connected in Safari
    const next = takeNext();
    if (next) return location.replace(next);
    if (d.me && !d.me.owner && !d.projects.length && !d.trash && !S.sharedProjects.length) firstProject(); // not for people who joined to listen to something shared
    askForNotifications();
    // once per session: if Backblaze is refusing files (key or daily limit), say so straight away
    if (!S.checkedStorage && S.tracks.length) { S.checkedStorage = true; storageProblem().then(why => why && toast(why, { error: true, ms: 15000 })); }
  } catch (e) {
    if (e.message === 'Not logged in') return;
    const d = store.get('tree');
    if (d) applyTree(d);
    // no connection: play what's saved. Anything else is a real error, so say what it was.
    S.online = !(e instanceof TypeError);
    toast(S.online ? `Couldn't load your library: ${e.message}` : "You're offline. Showing your saved library.", { error: S.online, ms: S.online ? 8000 : 3500 });
  }
  if ((S.view.type === 'project' && !projectOf(S.view.id)) || (S.view.type === 'playlist' && !playlistOf(S.view.id))) markView({ type: 'all' }, true);
  render();
  driveBack();
  if (new URLSearchParams(location.search).has('reports')) { history.replaceState(null, '', '/library' + viewHash(S.view)); if (S.me?.isAdmin) reportsDialog(); }
  if (new URLSearchParams(location.search).has('bugs')) { history.replaceState(null, '', '/library' + viewHash(S.view)); if (S.me?.isAdmin) bugsDialog(); }
  const deep = new URLSearchParams(location.search).get('track');
  if (deep) { history.replaceState(null, '', '/library' + viewHash(S.view)); if (trackOf(deep)) (canEdit(trackOf(deep).project_id) ? detailsDialog : commentsDialog)(trackOf(deep)); }
}

// Back from connecting Google Drive: ?drive=connected, or what went wrong.
function driveBack() {
  const back = new URLSearchParams(location.search).get('drive');
  if (!back) return;
  history.replaceState(null, '', '/library' + viewHash(S.view));
  // That Google account belongs to another [vault] account: sign in to that one, or pick another Google account.
  if (back.startsWith('taken:')) return toast(h('span', {}, `${back.slice(6)} is already connected to a different [vault] account. Please `,
    h('a', { href: '/login', className: 'toast-link', onclick(e) { e.preventDefault(); logout(); } }, 'sign in'), ' or ',
    h('a', { href: '/api/drive/connect', className: 'toast-link' }, 'connect a different Google account'), '.'), { error: true, ms: 20000 });
  toast(back === 'connected' ? 'Google Drive connected' : back, { error: back !== 'connected', ms: 6000 });
}

function showLogin() {
  if ($('#login')) return;
  // Signed out (or the account was deleted): nothing from the last account may show behind the sign-in box,
  // so the library saved on this device and its songs are forgotten, and the page behind is emptied.
  forgetDevice();
  Object.assign(S, { folders: [], projects: [], tracks: [], sharedProjects: [], sharedTracks: [], me: null, trash: 0, unread: 0 });
  fill($('#side')); fill($('#main')); tintFrom(null);
  if (cur) { audio.pause(); audio.removeAttribute('src'); cur = null; queue = []; renderPlayer(); }
  const box = h('div', { id: 'login', className: 'login' });
  const d = dialog(box, { locked: true });
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
    const user = field('text', 'username'), pw = field('password', 'current-password', { required: true });
    fill(box, head, h('div', { className: 'brandmark' }, '[vault]'), form(async () => {
      await api('/login', { method: 'POST', body: { username: user.value.trim(), password: pw.value } });
      history.replaceState(null, '', '/library' + location.search); // signed in: the address becomes the library
      d.close(); load();
    }, h('label', {}, '[username]', user), h('label', {}, '[password]', pw), err(), h('button', { className: 'btn primary', style: big }, 'Sign in')),
    link('New here? Make an account', signUp),
    h('small', { className: 'login-links' }, h('a', { href: '/' }, 'About'), h('a', { href: '/privacy' }, 'Privacy'), h('a', { href: '/terms' }, 'Terms')));
  }
  // Sign up: username, password and an optional profile picture (then Connect Google Drive).
  function signUp() {
    let avatar = null;
    const pic = h('button', { type: 'button', className: 'avatar xl pick', 'aria-label': 'Choose a profile picture', async onclick() {
      const [file] = await pickFiles('image/*,.heic,.heif', false);
      if (!file) return;
      try { const a = await avatarData(file); if (a) { avatar = a; paintAvatar(pic, avatar); } } catch (e) { oops(e); }
    } }, icon('plus', 20));
    const shown = field('text', 'name', { maxLength: 40, placeholder: 'e.g. Maya Lee', autocapitalize: 'words' });
    const user = field('text', 'username', { required: true, minLength: 3, maxLength: 24, pattern: '[A-Za-z0-9._\\-]+', placeholder: 'letters, numbers, . _ -' });
    const pw = field('password', 'new-password', { required: true, minLength: 8 }), again = field('password', 'new-password', { required: true });
    // Cloudflare Turnstile: usually invisible; sometimes a tick box
    let human = '';
    const check = h('div', { className: 'ts-box' });
    const agree = h('input', { type: 'checkbox', required: true });
    const terms = h('label', { className: 'agree' }, agree, h('span', {}, "I'm 13 or older and agree to the ",
      h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), '.'));
    api('/signup-config').then(async c => {
      if (!c.turnstile) return;
      if (!window.turnstile) await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      window.turnstile.render(check, { sitekey: c.turnstile, theme: 'dark', callback: t => { human = t; }, 'expired-callback': () => { human = ''; } });
    }).catch(() => {});
    fill(box, h('div', { className: 'brandmark' }, '[make an account]'), form(async () => {
      if (pw.value !== again.value) return markField(again, "This doesn't match the password above");
      try { await api('/signup', { method: 'POST', body: { username: user.value.trim(), display_name: shown.value.trim(), password: pw.value, avatar, turnstile: human, agree: agree.checked } }); }
      catch (x) { if (window.turnstile && check.firstChild) { window.turnstile.reset(check); human = ''; } throw x; }
      history.replaceState(null, '', '/library' + location.search.replace(/[?&]signup=1/, '').replace(/^&/, '?'));
      driveStep(box, d);
    }, pic, h('small', { className: 'muted' }, 'Profile picture (optional)'),
    h('label', {}, '[name] what people see (optional)', shown), h('label', {}, '[username] unique, for signing in', user), h('label', {}, '[password] 8+ characters', pw), h('label', {}, '[password again]', again), terms, check, err(),
    h('button', { className: 'btn primary', style: big }, 'Create account')),
    link('Already have an account? Sign in', signIn),
    h('small', { className: 'login-links' }, h('a', { href: '/privacy' }, 'Privacy'), h('a', { href: '/terms' }, 'Terms')));
  }
  new URLSearchParams(location.search).has('signup') ? signUp() : signIn();
}
// Step 3 of sign-up (and shown on sign-in until it's done): connect Google Drive, where this account's music is kept.
function driveStep(box, d) {
  if (!box) { if ($('#login')) return; box = h('div', { id: 'login', className: 'login' }); d = dialog(box, { locked: true }); }
  fill(box, h('div', { className: 'stack' }, h('div', { className: 'brandmark' }, '[connect drive]'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Your music is stored in your own Google Drive, in a folder called [vault]. The app can only see files it puts there, nothing else in your Drive.'),
    h('a', { className: 'btn primary', href: '/api/drive/connect', style: { width: '100%', height: '42px', display: 'grid', placeItems: 'center' } }, 'Connect Google Drive'),
    h('small', { className: 'muted' }, 'In the iPhone app this opens Safari: come back here once it says connected.'),
    h('button', { type: 'button', className: 'linkish', onclick: logout }, 'Log out')));
}
// Profile pictures: cropped here (round preview), a 256px JPEG kept with the account. Null if cancelled.
async function avatarData(file) {
  const out = await cropCover(file, { size: 256, round: true, title: 'Crop picture', ok: 'Use picture' });
  return out && new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(out); });
}
function paintAvatar(el, src, name = '') {
  el.classList.toggle('has', !!src);
  el.style.backgroundImage = src ? `url("${src}")` : '';
  fill(el, src ? '' : (name[0] || '?').toUpperCase());
}
// What people see: the display name, or the username for accounts without one.
const nameOf = u => u?.displayName || u?.display_name || u?.username || '';
const avatarEl = (me, cls = 'avatar') => { const a = h('span', { className: cls }); paintAvatar(a, me?.avatar, nameOf(me)); return a; };
// Logging out also forgets this account's songs kept on the device, so the next person doesn't get them.
// What this device keeps of an account: the saved library, downloads and kept songs.
function forgetDevice() {
  try { ['tree', 'offline', 'view', 'played', 'recent'].forEach(k => localStorage.removeItem(k)); } catch {}
  S.offline = new Set();
  return Promise.all(['audio', 'played'].map(c => caches.delete(c).catch(() => {})));
}
async function logout() {
  await fetch('/api/logout').catch(() => {});
  await forgetDevice();
  location.replace('/login');
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
      S.me && h('button', { className: 'icon-btn sm bell', 'aria-label': S.unread ? `Inbox, ${S.unread} new` : 'Inbox', title: 'Inbox', onclick: inboxDialog },
        icon('bell', 17), S.unread > 0 && h('span', { className: 'bell-n num' }, S.unread > 9 ? '9+' : S.unread)),
      S.me && h('button', { className: 'me', title: `Signed in as ${nameOf(S.me)} (@${S.me.username})`, 'aria-label': `Account: ${nameOf(S.me)}`, onclick: () => settingsDialog('account') }, avatarEl(S.me))),
    navItem('home', 'Home', '', 'home'),
    navItem('all', 'All tracks', S.tracks.length, 'music'),
    navItem('starred', 'Starred', S.tracks.filter(t => t.mark === 'star').length, 'star'),
    navItem('offline', 'Downloaded', [...S.tracks, ...S.sharedTracks].filter(isOffline).length, 'download'),
    navItem('trash', 'Recently deleted', S.trash || 0, 'trash'),
    h('div', { className: 'section', 'data-root': '', title: 'Drop here to move to the top level' }, h('span', { className: 'mono' }, '[library]'), h('span', { className: 'tools' },
      h('button', { className: 'icon-btn sm', title: 'New folder', 'aria-label': 'New folder', onclick: () => newFolder(null) }, icon('folderPlus', 16)),
      h('button', { className: 'icon-btn sm', title: 'New project', 'aria-label': 'New project', onclick: () => newProject(null) }, icon('plus', 16)))),
    tree(null, 0),
    h('div', { className: 'section' }, h('span', { className: 'mono' }, '[playlists]'), h('span', { className: 'tools' },
      h('button', { className: 'icon-btn sm', title: 'New playlist', 'aria-label': 'New playlist', onclick: () => newPlaylist() }, icon('plus', 16)))),
    S.playlists.map(pl => h('button', { className: 'nav' + (S.view.type === 'playlist' && S.view.id === pl.id ? ' on' : ''), onclick: () => setView({ type: 'playlist', id: pl.id }) },
      h('span', { className: 'caret' }), h('span', { className: 'nav-ic' }, icon('queue', 15)), h('span', { className: 'label' }, pl.name), h('span', { className: 'count' }, pl.ids.filter(trackOf).length))),
    S.sharedProjects.length > 0 && h('div', { className: 'section' }, h('span', { className: 'mono' }, '[shared with me]')),
    S.sharedProjects.map(p => h('button', { className: 'nav' + (S.view.type === 'project' && S.view.id === p.id ? ' on' : ''), title: `${p.name}, shared by ${p.owner}${p.role === 'editor' ? ' (you can edit)' : ''}`,
      onclick: () => setView({ type: 'project', id: p.id }) },
      h('span', { className: 'caret' }), thumb(p.cover), h('span', { className: 'label' }, p.name), h('span', { className: 'count' }, p.owner))),
    h('button', { className: 'nav settings-nav', onclick: () => settingsDialog() }, icon('gear', 16), h('span', { className: 'label' }, 'Settings')),
    h('button', { className: 'meter mono', title: 'Manage storage', 'aria-label': `Storage: ${fmtBytes(S.usage)} of ${fmtBytes(S.limit)} used. Manage storage`, onclick: storageDialog },
      `${fmtBytes(S.usage)} / ${fmtBytes(S.limit)}`, h('div', { className: 'bar' + (pct > 90 ? ' full' : '') }, h('i', { style: { width: pct + '%' } }))),
  );
}

function visibleTracks() {
  let list = S.view.type === 'project' ? (isShared(S.view.id) ? S.sharedTracks : S.tracks).filter(t => t.project_id === S.view.id)
    : S.view.type === 'playlist' ? (playlistOf(S.view.id)?.ids || []).map(trackOf).filter(Boolean)
    : S.view.type === 'offline' ? [...S.tracks, ...S.sharedTracks].filter(isOffline)
      : S.view.type === 'starred' ? S.tracks.filter(t => t.mark === 'star') : S.q ? [...S.tracks, ...S.sharedTracks] : [...S.tracks]; // searching covers shared projects too
  const q = S.q.trim().toLowerCase();
  if (q) {
    const look = { title: t => [t.name], notes: t => [t.notes], tags: t => [t.tags], producer: t => [t.artist], comments: () => [] }[S.searchIn]
      || (t => [t.name, t.tags, t.notes, t.artist, projectOf(t.project_id)?.name]);
    const inComments = S.searchIn === 'all' || S.searchIn === 'comments';
    list = list.filter(t => (inComments && S.commentHits.has(t.id)) || look(t).some(v => (v || '').toLowerCase().includes(q)));
  }
  const f = S.filter;
  if (f.tag) list = list.filter(t => tagsOf(t).includes(f.tag));
  if (f.bpmMin) list = list.filter(t => t.bpm && t.bpm >= +f.bpmMin);
  if (f.bpmMax) list = list.filter(t => t.bpm && t.bpm <= +f.bpmMax);
  if (f.key) list = list.filter(t => t.musical_key === f.key);
  if (f.mode) list = list.filter(t => (t.musical_key || '').endsWith(' ' + f.mode));
  if (f.throw) list = list.filter(t => (t.mark === 'throw') === (f.throw === 'only'));
  if (f.star) list = list.filter(t => t.mark === 'star');
  if (f.added) list = list.filter(t => t.created_at > Date.now() - f.added * 864e5);
  const by = {
    manual: (a, b) => (S.view.type === 'project' ? (a.disc || 1) - (b.disc || 1) : 0) || a.position - b.position,
    newest: (a, b) => b.created_at - a.created_at,
    oldest: (a, b) => a.created_at - b.created_at,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    bpm: (a, b) => (a.bpm ?? 1e9) - (b.bpm ?? 1e9),
    key: (a, b) => (KEYS.indexOf(a.musical_key) + 1 || 99) - (KEYS.indexOf(b.musical_key) + 1 || 99),
    length: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
  };
  if (S.view.type === 'playlist' && effSort() === 'manual') return list; // the playlist's own order
  return list.sort(by[effSort()] || by.newest);
}
// Inside a project the order is its own setting (Custom, the arranged order, by default); everywhere else Newest.
const ordered = () => S.view.type === 'project' || S.view.type === 'playlist'; // views with their own (Custom) order
const effSort = () => (ordered() ? S.projectSort : S.sort === 'manual' ? 'newest' : S.sort);
function setSort(v) { const k = ordered() ? 'projectSort' : 'sort'; S[k] = v; store.set(k, v); }
const tagsOf = t => (t.tags || '').split(',').map(s => s.trim()).filter(Boolean);
const filterCount = () => Object.values(S.filter).filter(Boolean).length;

// The background wash takes its colours from the cover of the project you're in; anywhere else (or no cover) it's
// the default pastel palette. Colours are picked once per cover from a 32px copy: the strongest hues, by saturation.
const tintCache = new Map();
let tintKey = null;
// A cover's strongest colours (up to 4, as 'r,g,b'), or null for black-and-white covers. Cached per cover.
function coverPalette(key) {
  if (!tintCache.has(key)) tintCache.set(key, (async () => {
    const img = await loadImg(await (await fetch(coverUrl(key))).blob());
    const c = h('canvas', { width: 32, height: 32 }), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const px = g.getImageData(0, 0, 32, 32).data, bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const [r, gr, b] = [px[i], px[i + 1], px[i + 2]], mx = Math.max(r, gr, b), mn = Math.min(r, gr, b), sat = mx ? (mx - mn) / mx : 0;
      if (mx < 40 || sat < 0.18) continue; // skip near-black and greys
      const hue = mx === mn ? 0 : mx === r ? ((gr - b) / (mx - mn) + 6) % 6 : mx === gr ? (b - r) / (mx - mn) + 2 : (r - gr) / (mx - mn) + 4;
      const bin = bins[Math.floor(hue * 2) % 12], w = sat * (mx / 255);
      bin.w += w; bin.r += r * w; bin.g += gr * w; bin.b += b * w;
    }
    const top = bins.filter(x => x.w > 0.5).sort((x, y) => y.w - x.w).slice(0, 4).map(x => [x.r, x.g, x.b].map(v => Math.round(v / x.w)).join(','));
    return top.length ? top : null; // a black-and-white cover keeps the default palette
  })().catch(() => null));
  return tintCache.get(key);
}
function tintFrom(key) {
  if (key === tintKey) return;
  tintKey = key;
  const holo = $('#holo i');
  const apply = colors => {
    if (tintKey !== key || !holo) return;
    document.documentElement.classList.toggle('cover-tint', !!colors);
    if (!colors) return holo.style.removeProperty('--holo');
    const spots = [['42% 38% at 12% 18%', .1], ['46% 40% at 88% 12%', .1], ['50% 46% at 72% 88%', .085], ['42% 42% at 18% 86%', .09], ['36% 30% at 50% 50%', .045]];
    holo.style.setProperty('--holo', spots.map(([at, a], i) => `radial-gradient(${at}, rgba(${colors[i % colors.length]},${a}), transparent 70%)`).join(', '));
  };
  if (!key) return apply(null);
  coverPalette(key).then(apply);
}


const whyOff = ro => (!S.online ? "You're offline. Uploading and recording need a connection." : ro ? 'You can listen to this project, not add to it' : null);
function renderMain() {
  tintFrom(S.view.type === 'project' ? projectOf(S.view.id)?.cover || null : null);
  const main = $('#main');
  if (S.view.type === 'trash') { renderBulk(); return renderTrash(); }
  const p = S.view.type === 'project' && projectOf(S.view.id), pl = S.view.type === 'playlist' && playlistOf(S.view.id);
  const list = visibleTracks();
  const fc = filterCount();
  const shared = p && p.owner, ro = p && !canEdit(p.id); // a shared project, and whether it's listen-only

  const toolbar = h('div', { className: 'toolbar' },
    h('button', { id: 'menu-btn', className: 'icon-btn', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('side-open') }, icon('menu', 20)),
    h('label', { className: 'search' }, icon('search', 16),
      h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', value: S.q, oninput(e) {
        S.q = e.target.value; searchComments();
        if (S.view.type !== 'home') return renderList(true);
        setView({ type: 'all' });
        const i = $('.search input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
      } })),
    S.view.type !== 'home' && h('button', { className: 'btn' + (fc ? ' on' : ''), 'aria-label': fc ? `Filters, ${fc} on` : 'Filter', onclick: filterDialog },
      icon('filter', 16), h('span', { className: 'lbl' }, 'Filter'), fc > 0 && h('span', { className: 'badge num' }, fc)),
    S.view.type !== 'home' && h('select', { 'aria-label': 'Sort', onchange(e) { setSort(e.target.value); renderList(true); } },
      [['manual', 'Custom'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name'], ['bpm', 'BPM'], ['key', 'Key'], ['length', 'Length']]
        .filter(([v]) => p || pl || v !== 'manual').map(([v, l]) => h('option', { value: v, selected: effSort() === v }, l))),
    h('span', { className: 'grow' }),
    h('button', { className: 'btn', onclick: recordDialog, disabled: !S.online || ro, title: whyOff(ro), 'aria-label': 'Record' }, icon('mic', 16), h('span', { className: 'lbl' }, 'Record')),
    h('button', { className: 'btn primary', disabled: !S.online || ro, title: whyOff(ro), async onclick() { const f = await pickFiles(ACCEPT_AUDIO); f.length && uploadTracks(f, await targetProject()); }, 'aria-label': 'Upload' }, icon('upload', 16), h('span', { className: 'lbl' }, 'Upload')),
  );

  if (S.view.type === 'home') return renderHome(toolbar);

  // Play / Shuffle / Rearrange / Select, or "Done" while rearranging or selecting.
  const busy = S.arrange || S.select;
  const labelled = (ic, text) => [icon(ic, 16), h('span', { className: 'lbl-sm' }, text)];
  const iconAction = (ic, label, run) => h('button', { className: 'icon-btn act-ic', 'aria-label': label, title: label, onclick: run }, icon(ic, 18));
  const actions = [
    S.arrange ? h('button', { className: 'btn primary', onclick: () => { S.arrange = false; renderMain(); } }, icon('check', 16), 'Done')
      : S.select ? h('button', { className: 'btn primary', onclick: () => { S.select = null; renderMain(); } }, icon('check', 16), 'Done')
        : list.length > 0 && h('button', { className: 'btn primary', onclick: () => playList(list, 0, { shuffle: false }) }, icon('play', 14), 'Play'),
    !busy && list.length > 1 && h('button', { className: 'btn', 'aria-label': 'Shuffle', onclick: () => playList(list, Math.floor(Math.random() * list.length), { shuffle: true }) }, labelled('shuffle', 'Shuffle')),
    S.arrange && h('span', { className: 'mono arrange-hint' }, '[drag the dots to reorder]'),
    S.select && h('span', { className: 'mono arrange-hint' }, '[tap tracks to select]'),
    p && !shared && !busy && h('button', { className: 'btn', 'aria-label': 'Share', onclick: () => shareDialog('project', p.id, p.name) }, labelled('share', 'Share')),
    pl && !busy && list.length > 0 && h('button', { className: 'btn', 'aria-label': 'Share', onclick: () => shareDialog('playlist', pl.id, pl.name) }, labelled('share', 'Share')),
    // the less-used ones as icons, next to the ⋯ menu
    (p || pl) && !ro && !busy && list.length > 1 && iconAction('grip', 'Rearrange', () => {
      S.arrange = true;
      if (S.projectSort !== 'manual') setSort('manual');
      renderMain();
    }),
    !shared && !busy && list.length > 0 && iconAction('check', 'Select tracks', () => { S.select = new Set(); renderMain(); }),
    p && !busy && iconAction('more', 'Project options', () => projectMenu(p)),
    pl && !busy && iconAction('more', 'Playlist options', () => playlistMenu(pl)),
  ];
  const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
  const count = `${list.length} ${list.length === 1 ? 'track' : 'tracks'} · ${fmtTime(dur)}${fc ? ' · filtered' : ''}`;
  const hero = p
    ? h('div', { className: 'hero' },
      h('button', { className: 'art' + (p.cover ? '' : ' disc') + (ro || p.single ? ' locked' : ''), style: bg(p.cover), 'aria-label': ro ? p.name : 'Change cover', onclick: () => !ro && !p.single && setCover('projects', p) },
        !ro && !p.single && h('span', { className: 'hint' }, p.cover ? '[change cover]' : '[add cover]')),
      h('div', {},
        h('div', { className: 'eyebrow' }, shared ? `[shared by ${p.owner} · ${p.role === 'editor' ? 'you can edit' : 'listen only'}]` : '[project]'),
        h('h1', {}, p.name),
        h('div', { className: 'meta mono' }, count),
        h('div', { className: 'actions' }, actions)))
    : pl ? h('div', { className: 'hero' }, playlistArt(pl),
      h('div', {},
        h('div', { className: 'eyebrow' }, '[playlist]'),
        h('h1', {}, pl.name),
        h('div', { className: 'meta mono' }, list.length ? count : 'empty · add tracks with ⋯ → Add to playlist'),
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
// How many project tiles fit in one row of Home (matches .card-grid: 168px minimum, 18px gaps; two rows of 2 on phones).
const homeCols = () => (phone.matches ? 4 : Math.max(2, Math.floor(($('#main').clientWidth - 72 + 18) / (168 + 18))));
let lastHomeCols = 0;
addEventListener('resize', () => { if (S.view.type === 'home' && !S.homeAll && homeCols() !== lastHomeCols) renderMain(); });

// Project tiles glow in their cover's own colours on hover (white-ish for covers without colour).
function glowFrom(el, key) {
  if (key) coverPalette(key).then(c => { if (c) c.slice(0, 3).forEach((rgb, i) => el.style.setProperty(`--g${i + 1}`, `rgb(${rgb})`)); });
  return el;
}

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
    return glowFrom(h('div', { className: 'card', role: 'button', tabIndex: 0, style: { '--i': Math.min(n++, 14) }, onclick: () => setView({ type: 'project', id: p.id }),
      onkeydown(e) { if (e.key === 'Enter') setView({ type: 'project', id: p.id }); } },
      h('span', { className: 'card-art' + (p.cover ? '' : ' disc'), style: bg(p.cover) },
        list.length > 0 && h('button', { className: 'card-play', 'aria-label': `Play ${p.name}`, onclick(e) { e.stopPropagation(); playList(list, 0, { shuffle: false }); } }, icon('play', 16))),
      h('span', { className: 'card-t' }, p.name),
      h('span', { className: 'card-s mono' }, `${list.length} ${list.length === 1 ? 'track' : 'tracks'}`)), p.cover);
  };
  // One row of recent projects; if there are more, the last tile is a stack of the next covers that opens them all.
  const recentRow = list => {
    const cols = homeCols(), more = list.length > cols, shown = list.slice(0, more ? cols - 1 : cols), rest = list.slice(shown.length);
    const open = () => { S.homeAll = true; renderMain(); };
    return h('div', { className: 'card-grid' }, shown.map(card), more && h('div', { className: 'card stack-card', role: 'button', tabIndex: 0, style: { '--i': Math.min(n++, 14) },
      'aria-label': `All projects, ${list.length}`, onclick: open, onkeydown(e) { if (e.key === 'Enter') open(); } },
      h('span', { className: 'card-art stack-art' },
        rest.slice(0, 3).map((p, i) => h('span', { className: 'stack-layer' + (p.cover ? '' : ' disc'), style: { ...bg(p.cover), '--k': i } })),
        h('span', { className: 'stack-folder' }, h('span', { className: 'stack-n' }, `+${rest.length}`))),
      h('span', { className: 'card-t' }, 'All projects'),
      h('span', { className: 'card-s mono' }, `${list.length} projects`)));
  };
  const trackCard = (t, list, i) => h('button', { className: 'tcard', style: { '--i': Math.min(n++, 14) }, onclick: () => playList(list, i) },
    thumb(coverOf(t), 'tcard-art' + (t.mark === 'star' ? ' starred' : ''), h('span', { className: 'tcard-play' }, icon('play', 14))),
    h('span', { className: 'tcard-t' }, t.name),
    h('span', { className: 'tcard-s' }, [t.artist, projectOf(t.project_id)?.name].filter(Boolean).join(' · ')));
  const shelf = (title, list, more) => list.length > 0 && h('section', { className: 'shelf' },
    h('div', { className: 'shelf-h' }, h('h2', {}, title), more && h('button', { className: 'btn ghost', onclick: more }, 'See all')),
    h('div', { className: 'shelf-row' }, list.map((t, i) => trackCard(t, list, i))));
  const newest = [...S.tracks].sort((x, y) => y.created_at - x.created_at);
  const starred = newest.filter(t => t.mark === 'star').slice(0, 12);
  const tracksIn = id => [...S.tracks, ...S.sharedTracks].filter(t => t.project_id === id).sort((x, y) => x.position - y.position);
  const projectShelf = (title, list, more) => list.length > 0 && h('section', { className: 'shelf' },
    h('div', { className: 'shelf-h' }, h('h2', {}, title), more && h('button', { className: 'btn ghost', onclick: more }, 'See all')),
    h('div', { className: 'shelf-row projects-row' }, list.map(p => {
      const tl = tracksIn(p.id);
      return glowFrom(h('div', { className: 'card', role: 'button', tabIndex: 0, style: { '--i': Math.min(n++, 14) }, onclick: () => setView({ type: 'project', id: p.id }),
        onkeydown(e) { if (e.key === 'Enter') setView({ type: 'project', id: p.id }); } },
        h('span', { className: 'card-art' + (p.cover ? '' : ' disc'), style: bg(p.cover) },
          tl.length > 0 && h('button', { className: 'card-play', 'aria-label': `Play ${p.name}`, onclick(e) { e.stopPropagation(); playList(tl, 0, { shuffle: false }); } }, icon('play', 16))),
        h('span', { className: 'card-t' }, p.name),
        h('span', { className: 'card-s mono' }, p.owner ? `by ${p.owner}` : `${tl.length} ${tl.length === 1 ? 'track' : 'tracks'}`)), p.cover);
    })));
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
      S.tracks.length > 0 && h('div', { className: 'meta mono' }, `${S.tracks.length} tracks · ${S.projects.length} projects`)),
    // a brand-new library: three plain steps instead of an empty page
    !S.tracks.length && h('section', { className: 'get-started' }, // until the first song is in
      h('h2', {}, 'Get started'),
      h('div', { className: 'gs-steps' },
        h('button', { className: 'gs-step', disabled: !S.online, async onclick() { const f = await pickFiles(ACCEPT_AUDIO); f.length && uploadTracks(f, await targetProject()); } },
          h('span', { className: 'gs-n mono' }, '1'), h('b', {}, 'Upload a song'), h('span', {}, 'Beats, demos, voice memos. Or drag files onto the page.')),
        h('button', { className: 'gs-step' + (S.projects.length ? ' done' : ''), onclick: () => newProject(null) },
          h('span', { className: 'gs-n mono' }, S.projects.length ? '✓' : '2'), h('b', {}, 'Make a project'), h('span', {}, S.projects.length ? 'Done. Make more any time.' : 'Group tracks like an album or a folder of ideas.')),
        h('div', { className: 'gs-step' },
          h('span', { className: 'gs-n mono' }, '3'), h('b', {}, 'Share it'), h('span', {}, 'Open a project and tap Share to send a link or add people.')))),
    // projects: one row of the most recent (two on phones), the full grid with folder filters behind "See all"
    ...(S.homeAll ? [{ k: 'projects' }] : homeLayout().filter(x => x.on)).map(x => x.k === 'custom'
      ? projectShelf(x.name, x.projects.map(projectOf).filter(Boolean))
      : ({
      projects: () => S.projects.length > 0 && h('section', { className: 'shelf' },
        h('div', { className: 'shelf-h' },
          S.homeAll ? h('button', { className: 'btn ghost back-btn', onclick: () => { S.homeAll = false; S.homeFolder = null; renderMain(); } }, icon('chevron', 15), 'Back')
            : h('h2', {}, 'Recent projects'),
          h('span', { className: 'shelf-acts' },
            !S.homeAll && h('button', { className: 'btn ghost', onclick: customizeHome }, icon('sliders', 15), 'Customize'),
            h('button', { className: 'btn ghost', onclick: () => newProject(S.homeFolder) }, icon('plus', 15), 'New'))),
        S.homeAll && h('h2', { className: 'all-title' }, 'All projects'),
        S.homeAll && chips,
        S.homeAll ? (projects.length ? h('div', { className: 'card-grid' }, projects.map(card)) : h('div', { className: 'muted' }, 'No projects in this folder yet.'))
          : recentRow(projects)),
      shared: () => projectShelf('Shared with me', S.sharedProjects.slice(0, 12)),
      starred: () => shelf('Starred', starred, () => setView({ type: 'starred' })),
      added: () => shelf('Recently added', newest.slice(0, 12), () => setView({ type: 'all' })),
    })[x.k]?.()),
    // only when Recent projects is hidden (its header has the Customize button otherwise)
    !S.homeAll && !(S.projects.length && homeLayout().some(x => x.k === 'projects' && x.on)) && h('div', { className: 'home-foot' }, h('button', { className: 'btn ghost', onclick: customizeHome }, icon('sliders', 15), 'Customize home')));

  const key = JSON.stringify(S.view) + S.homeFolder + S.homeAll;
  lastHomeCols = homeCols();
  const fresh = key !== lastView; lastView = key;
  main.replaceChildren(toolbar, page);
  main.classList.toggle('enter', fresh);
  if (fresh) main.scrollTop = 0;
  renderBulk();
}

// Home layout: built-in sections (on/off) and your own named sections of projects, in your order.
// Saved to your account, so it's the same on every device.
const HOME_SECTIONS = { projects: 'Recent projects', shared: 'Shared with me', starred: 'Starred songs', added: 'Recently added songs' };
function homeLayout() {
  const saved = (S.me?.home || [{ k: 'projects', on: true }, { k: 'shared', on: true }]).filter(x => x.k === 'custom' || HOME_SECTIONS[x.k]);
  return [...saved, ...Object.keys(HOME_SECTIONS).filter(k => !saved.some(x => x.k === k)).map(k => ({ k, on: false }))];
}
function customizeHome() {
  let layout = homeLayout().map(x => ({ ...x }));
  const list = h('div', { className: 'list' });
  const move = (i, d) => { [layout[i + d], layout[i]] = [layout[i], layout[i + d]]; draw(); };
  const draw = () => fill(list, layout.map((x, i) => h('div', { className: 'item layout-row' + (x.on ? '' : ' off') },
    h('span', { className: 'layout-move' },
      h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, icon('up', 14)),
      h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Move down', disabled: i === layout.length - 1, onclick: () => move(i, 1) }, icon('down', 14))),
    h('span', { className: 'grow' }, x.k === 'custom' ? x.name : HOME_SECTIONS[x.k],
      x.k === 'custom' && h('small', { className: 'muted' }, ` · ${x.projects.length} ${x.projects.length === 1 ? 'project' : 'projects'}`)),
    x.k === 'custom'
      ? [h('button', { type: 'button', className: 'btn ghost', onclick: async () => { const r = await sectionEditor(x); if (r) { Object.assign(x, r); draw(); } } }, 'Edit'),
         h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': `Delete ${x.name}`, onclick: () => { layout.splice(i, 1); draw(); } }, icon('trash', 14))]
      : h('input', { type: 'checkbox', className: 'toggle', checked: x.on, 'aria-label': `Show ${HOME_SECTIONS[x.k]}`, onchange() { x.on = this.checked; draw(); } }))));
  draw();
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Customize home'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Reorder sections, switch them on or off, or make your own section of hand-picked projects.'), list,
    h('button', { type: 'button', className: 'btn', onclick: async () => { const r = await sectionEditor(null); if (r) { layout.unshift({ k: 'custom', id: crypto.randomUUID().slice(0, 8), on: true, ...r }); draw(); } } }, icon('plus', 15), 'New section'),
    h('div', { className: 'btns' },
      h('button', { type: 'button', className: 'btn ghost', onclick: () => { layout = [{ k: 'projects', on: true }, { k: 'shared', on: true }, { k: 'starred', on: false }, { k: 'added', on: false }]; draw(); } }, 'Reset'),
      h('button', { type: 'button', className: 'btn primary', async onclick() {
        try { await api('/me', { method: 'PATCH', body: { home: layout } }); S.me.home = layout; d.close(); renderMain(); } catch (e) { oops(e); }
      } }, 'Save'))), { className: 'settings-dlg' });
}
// Make or edit a custom section: a name, and projects picked in the order you tick them.
function sectionEditor(sec) {
  return new Promise(res => {
    const picked = [...(sec?.projects || [])];
    const name = h('input', { type: 'text', value: sec?.name || '', placeholder: 'e.g. For the EP', maxLength: 60, required: true, 'aria-label': 'Section name' });
    const all = [...S.projects, ...S.sharedProjects.filter(p => !p.single)];
    const box = h('div', { className: 'list pick-list' });
    const draw = () => fill(box, all.map(p => h('label', { className: 'item pick' },
      h('input', { type: 'checkbox', checked: picked.includes(p.id), onchange() { const at = picked.indexOf(p.id); this.checked ? at < 0 && picked.push(p.id) : at >= 0 && picked.splice(at, 1); draw(); } }),
      thumb(p.cover), h('span', { className: 'grow' }, p.name, p.owner && h('small', { className: 'muted' }, ` · ${p.owner}`)),
      picked.includes(p.id) && h('span', { className: 'num pick-n' }, picked.indexOf(p.id) + 1))));
    draw();
    let done = false;
    const d = dialog(h('form', { className: 'stack', onsubmit(e) {
      e.preventDefault();
      if (!picked.length) return toast('Pick at least one project', { error: true });
      done = true; res({ name: name.value.trim(), projects: [...picked] }); d.close();
    } }, h('h2', {}, sec ? 'Edit section' : 'New section'), h('label', {}, 'Name', name),
    h('span', { className: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)' } }, 'Projects (they show in the order you tick them)'), box,
    h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, sec ? 'Done' : 'Add section'))), { className: 'settings-dlg' });
    d.addEventListener('close', () => { if (!done) res(null); });
  });
}

function renderList(animate = false) {
  const box = $('#tracks');
  if (!box) return;
  const list = visibleTracks();
  const p = S.view.type === 'project';
  const manual = ordered() && S.projectSort === 'manual';
  box.classList.remove('stagger');
  box.classList.toggle('arranging', !!S.arrange && ordered());
  box.classList.toggle('selecting', !!S.select);
  if (animate) { void box.offsetWidth; box.classList.add('stagger'); }
  if (!list.length) {
    const filtered = S.q || filterCount(), touch = matchMedia('(pointer: coarse)').matches;
    const [title, text] = filtered ? ['No matches', 'Try a different search, or clear the filters.']
      : S.view.type === 'starred' ? ['No starred tracks yet', 'Tap the star on a track and it shows up here.']
        : S.view.type === 'offline' ? ['Nothing downloaded yet', 'Use ⋯ → Save offline on a track or a project to play it without a connection.']
          : p && !canEdit(S.view.id) ? ['No tracks yet', 'Nothing has been added to this project.']
            : ['Nothing here yet', touch ? 'Tap Upload to add your first tracks.' : 'Drag audio files or folders here, or press Upload.'];
    box.replaceChildren(searchChips() || '', h('div', { className: 'empty' },
      h('span', { className: 'disc' }),
      h('b', {}, title),
      text,
      filterCount() > 0 && h('button', { className: 'btn', style: { marginTop: '10px' }, onclick: () => { S.filter = blankFilter(); renderMain(); } }, 'Clear filters')));
    return;
  }
  let dragId = null;
  // An album on more than one disc gets a [disc N] heading before each disc (in the project's own order).
  const discs = p && manual && new Set(list.map(t => t.disc || 1)).size > 1;
  const discHead = (t, i) => discs && (i === 0 || (list[i - 1].disc || 1) !== (t.disc || 1)) ? h('div', { className: 'disc-head mono' }, `[disc ${t.disc || 1}]`) : null;
  fill(box, searchChips(),
    h('div', { className: 'trow thead' }, h('span'), h('span', {}, '[title]'), h('span', { className: 'c-wave' }), h('span', { className: 'cell c-bpm' }, '[bpm]'), h('span', { className: 'cell c-key' }, '[key]'), h('span', { className: 'cell' }, '[time]'), h('span'), h('span'), h('span')),
    list.flatMap((t, i) => [discHead(t, i), h('div', {
      className: 'trow' + (cur?.id === t.id ? ' on' : '') + (S.select?.has(t.id) ? ' selected' : '') + (t.mark === 'throw' ? ' throw' : '') + (justMarked?.id === t.id && justMarked.mark === 'throw' ? ' just-throw' : ''),
      draggable: !S.arrange && !S.select && !isShared(t.project_id), 'data-id': t.id, style: { '--i': i },
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
      ondragover(e) {
        if (manual && dragId && dragId !== t.id) { e.preventDefault(); this.classList.add('drag-over'); }
        // files from the computer: a line shows where they'll land (above or below this row)
        else if (manual && !dragId && e.dataTransfer.types.includes('Files') && canEdit(t.project_id)) {
          e.preventDefault();
          const r = this.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
          this.classList.toggle('drop-after', after); this.classList.toggle('drag-over', !after);
        }
      },
      ondragleave() { this.classList.remove('drag-over', 'drop-after'); },
      ondrop(e) {
        const after = this.classList.contains('drop-after');
        this.classList.remove('drag-over', 'drop-after');
        if (manual && !dragId && e.dataTransfer.types.includes('Files') && canEdit(t.project_id)) {
          e.preventDefault(); e.stopPropagation(); dragDepth = 0; hideDrop();
          if (!S.online) return toast("You're offline", { error: true });
          return handleDrop(e.dataTransfer, t.project_id, { id: t.id, after });
        }
        if (!manual || !dragId) return;
        e.preventDefault(); e.stopPropagation();
        const ids = list.map(x => x.id).filter(id => id !== dragId);
        ids.splice(ids.indexOf(t.id), 0, dragId);
        reorder(ids);
      },
    },
    // Selecting: a tick box. Inside a project: the track number (the playing one turns into bars). Elsewhere: the cover.
    S.select ? h('span', { className: 'sel-box' }, icon('check', 14))
      : p ? h('span', { className: 'tnum num' }, h('span', { className: 'bars' }, h('i'), h('i'), h('i')))
        : thumb(coverOf(t), 'thumb', h('span', { className: 'bars' }, h('i'), h('i'), h('i'))),
    h('div', { style: { minWidth: 0 } },
      h('div', { className: 'name' }, t.name),
      h('div', { className: 'sub' },
        isOffline(t) && h('span', { className: 'saved', title: 'Saved offline' }, icon('download', 12)),
        t.mark === 'throw' && h('span', { className: 'tag throw-tag' }, 'throwaway'),
        t.notes && h('span', { className: 'saved', title: 'Has notes' }, icon('note', 12)),
        S.comments[t.id] > 0 && h('span', { className: 'saved', title: `${S.comments[t.id]} comments` }, icon('comment', 12), S.comments[t.id]),
        h('span', {}, [t.artist, !p && projectOf(t.project_id)?.name, fmtAdded(t.created_at)].filter(Boolean).join(' · ')),
        tagsOf(t).map(x => h('span', { className: 'tag' }, x))),
      S.q.trim() && S.commentHits.has(t.id) && h('div', { className: 'hit' }, icon('comment', 12), h('b', {}, S.commentHits.get(t.id).name), ' ', S.commentHits.get(t.id).body)),
    waveCell(t),
    h('span', { className: 'cell c-bpm num' }, t.bpm ? Math.round(t.bpm * 10) / 10 : '–'),
    h('span', { className: 'cell c-key num' }, t.musical_key || '–'),
    h('span', { className: 'cell num' }, fmtTime(t.duration)),
    S.arrange || S.select ? markDot(t, 'star') : canEdit(t.project_id) ? starBtn(t) : h('span'),
    S.arrange || S.select ? markDot(t, 'throw') : canEdit(t.project_id) ? throwBtn(t) : h('span'),
    S.arrange && ordered()
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
        : h('button', { className: 'icon-btn', 'aria-label': 'Track options', onclick(e) { e.stopPropagation(); trackMenu(t, list); } }, icon('more', 18)))]),
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
  if (!canEdit(t.project_id)) return toast(`Only people who can edit “${projectOf(t.project_id)?.name}” can star tracks in it`, { quiet: true });
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
    const moved = await api(`/${kind === 'folder' ? 'folders' : 'projects'}/${item.id}`, { method: 'PATCH', body: kind === 'folder' ? { parent_id: to } : { folder_id: to } }).then(() => true, oops);
    if (moved) toast(`Moved “${item.name}” ${to ? 'into ' + (S.folders.find(f => f.id === to)?.name || 'folder') : 'to the top level'}`, { ms: 2000 });
    load();
  };
  if (touch) st.timer = setTimeout(() => { if (sideDrag === st) begin(); }, 380);
  addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
}
// A drag shouldn't also count as a click, and the page must not scroll under a finger that's dragging.
addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
addEventListener('touchmove', e => { if (dragging) e.preventDefault(); }, { passive: false });
addEventListener('contextmenu', e => { if (dragging || sideDrag) e.preventDefault(); });

// `ids` are the tracks on screen in their new order. While a search or filter hides some, the shown ones swap
// between the places they already had and the hidden ones stay put.
async function reorder(ids) {
  const pl = S.view.type === 'playlist' && playlistOf(S.view.id);
  if (pl) { // the shown ones swap places; tracks hidden by a search or filter stay put
    const shown = new Set(ids), next = [...ids];
    pl.ids = pl.ids.map(id => (shown.has(id) ? next.shift() : id));
    renderList();
    return api(`/playlists/${pl.id}/order`, { method: 'POST', body: { ids: pl.ids } }).catch(oops);
  }
  const pid = trackOf(ids[0])?.project_id, shown = new Set(ids), next = [...ids];
  const all = [...S.tracks, ...S.sharedTracks].filter(t => t.project_id === pid).sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  const full = all.map(t => (shown.has(t.id) ? next.shift() : t.id));
  full.forEach((id, i) => { trackOf(id).position = i; });
  renderList();
  await api('/tracks/reorder', { method: 'POST', body: { ids: full } }).catch(oops);
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
  markView({ type: 'project', id: r.id });
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
  const tracks = () => [...S.tracks, ...S.sharedTracks].filter(t => t.project_id === p.id).sort((a, b) => a.position - b.position);
  if (p.owner) { // shared with me
    const ed = canEdit(p.id);
    return sheet([
      ed && { icon: 'pencil', label: 'Rename', async run() { const name = await prompt('Rename project', p.name); name && api(`/projects/${p.id}`, { method: 'PATCH', body: { name } }).then(load, oops); } },
      ed && { icon: 'image', label: 'Change cover', run: () => setCover('projects', p) },
      ed && { icon: 'gauge', label: 'Detect missing BPM & keys', run: () => detectTracks(tracks().filter(t => !t.bpm || !t.musical_key), false) },
      ed && { icon: 'download', label: 'Export as ZIP', run: () => zipTracks(tracks(), p.name, p.cover) },
      { icon: 'download', label: 'Save all offline', run: () => saveAllOffline(tracks()) },
      p.member && { icon: 'clock', label: 'Activity', run: () => activityDialog(p) },
      '-',
      { icon: 'close', label: 'Remove from my library', danger: true, async run() {
        if (!(await confirm(`Remove “${p.name}”?`, `It's ${p.owner}'s, so nothing is deleted. You just won't see it any more unless they share it again.`, 'Remove'))) return;
        await api('/shared/leave', { method: 'POST', body: p.single ? { track_id: p.single } : { project_id: p.id } }).catch(oops);
        setView({ type: 'home' }); load();
      } },
    ]);
  }
  sheet([
    { icon: 'pencil', label: 'Rename', async run() { const name = await prompt('Rename project', p.name); name && api(`/projects/${p.id}`, { method: 'PATCH', body: { name } }).then(load, oops); } },
    { icon: 'folder', label: 'Move to folder…', async run() { const to = await folderPicker('Move project', p.folder_id); to !== undefined && api(`/projects/${p.id}`, { method: 'PATCH', body: { folder_id: to } }).then(load, oops); } },
    { icon: 'image', label: 'Change cover', run: () => setCover('projects', p) },
    p.cover && { icon: 'close', label: 'Remove cover', run: () => api(`/projects/${p.id}`, { method: 'PATCH', body: { cover: null } }).then(load, oops) },
    { icon: 'gauge', label: 'Detect missing BPM & keys', run: () => detectTracks(tracks().filter(t => !t.bpm || !t.musical_key), false) },
    { icon: 'download', label: 'Export as ZIP', run: () => zipTracks(tracks(), p.name, p.cover) },
    { icon: 'download', label: 'Save all offline', run: () => saveAllOffline(tracks()) },
    { icon: 'clock', label: 'Activity', run: () => activityDialog(p) },
    '-',
    { icon: 'trash', label: 'Move to trash', danger: true, async run() {
      const n = tracks().length;
      if (!(await confirm(`Move “${p.name}” to the trash?`, `You can restore the project and its ${n} ${n === 1 ? 'track' : 'tracks'} from Recently deleted for 30 days.`, 'Move to trash'))) return;
      if (!(await api(`/projects/${p.id}`, { method: 'DELETE' }).then(() => true, oops))) return;
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
      const cropped = await cropCover(f).catch(e => (oops(e), null));
      if (!cropped) return;
      file = cropped;
      cover.style.backgroundImage = `url("${URL.createObjectURL(cropped)}")`;
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
        if (file) await api(`/projects/${id}`, { method: 'PATCH', body: { cover: await uploadFile(file) } }).catch(oops);
        markView({ type: 'project', id });
        d.close(); await load(); res(id);
      } catch (x) { err.textContent = x.message; btn.disabled = false; }
    } }, h('h2', {}, 'Make your first project'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Projects hold your tracks, like an album or a folder of ideas. You can make more any time.'),
    cover, h('label', {}, 'Name', name), err,
    h('button', { className: 'btn primary', style: { width: '100%', height: '42px' } }, 'Create project')), { locked: true });
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
export async function uploadFile(file, onProgress = () => {}, project_id) {
  const r = await api('/upload-url', { method: 'POST', body: { name: file.name, type: file.type, size: file.size, project_id } });
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
// Each file's title, artist, producer and track number are read first (its tags, else its name), and an album's
// worth of numbered files goes in in track order, whatever order they were picked or dropped in.
async function uploadTracks(files, project_id, folder = projectOf(project_id)?.name || '') {
  const numbered = leadNumbers(files.map(f => f.name));
  const infos = await Promise.all(files.map(f => (kindOf(f.name) === 'audio' ? trackInfo(f, numbered).catch(() => null) : null)));
  const order = files.map((file, i) => ({ file, info: infos[i], i }));
  if (order.filter(x => x.info?.track != null).length > 1) order.sort((a, b) => (a.info?.disc ?? 1) - (b.info?.disc ?? 1) || (a.info?.track ?? 1e9) - (b.info?.track ?? 1e9) || a.i - b.i);
  const seen = new Map(S.tracks.map(t => [`${t.name.toLowerCase()}|${t.size}`, projectOf(t.project_id)?.name || 'your library']));
  for (const j of Q.jobs) if (j.status !== 'skipped') seen.set(`${(j.info?.title || baseName(j.file.name)).toLowerCase()}|${j.size}`, j.folder || 'this upload');
  const jobs = order.map(({ file, info }) => {
    const bad = kindOf(file.name) !== 'audio' ? 'Not an audio file' : file.size > MAX.audio ? 'Too big (over 1 GB)' : null;
    const sig = `${baseName(file.name).toLowerCase()}|${file.size}`, named = info?.title ? `${info.title.toLowerCase()}|${file.size}` : sig;
    const dupOf = !bad && settings.skipDups ? seen.get(sig) || seen.get(named) : null;
    if (!bad) seen.set(named, folder || 'this upload');
    const error = bad || (dupOf ? `Already in ${dupOf}` : null);
    return { file, info, project_id, folder, size: file.size, loaded: 0, status: error ? 'skipped' : 'queued', error, dup: !!dupOf, phase: '', row: null, sig: '' };
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
      const file_key = await uploadFile(job.file, p => { job.loaded = p * job.size; drawQueueSoon(); }, job.project_id);
      job.phase = settings.detect ? 'Detecting BPM & key' : 'Drawing waveform'; job.loaded = job.size; drawQueue();
      const { bpm, key, peaks } = await analysing;
      job.found = [bpm && bpm + ' BPM', key].filter(Boolean).join(' · ');
      job.phase = 'Saving'; drawQueue();
      const info = job.info || {};
      await api('/tracks', { method: 'POST', body: { project_id: job.project_id, name: info.title || baseName(job.file.name), file_key, duration, bpm, musical_key: key, peaks,
        artist: info.artist || settings.artist, tags: info.prod ? `prod. ${info.prod}` : '', disc: info.disc || null } });
      job.status = 'done';
      Q.refresh ||= setTimeout(() => { Q.refresh = 0; load(); }, 2500); // refresh the library every few seconds, not after every file
    } catch (e) {
      job.status = e.message === 'Cancelled' ? 'cancelled' : 'failed';
      job.error = e.message; job.loaded = 0;
      if (/Storage full|Drive is full/.test(e.message)) Q.jobs.forEach(j => { if (j.status === 'queued') { j.status = 'failed'; j.error = 'Storage full'; j.done(); } });
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
async function decodeImage(file) {
  try { return await loadImg(file); } catch {
    if (!/\.(heic|heif)$/i.test(file.name)) throw new Error(`${file.name} couldn't be read as an image`);
    if (!window.heic2any) await loadScript('/lib/heic2any.min.js');
    return loadImg(await window.heic2any({ blob: file, toType: 'image/jpeg' }));
  }
}
async function toJpeg(file) {
  const img = await decodeImage(file);
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
  let jpeg;
  try { jpeg = await cropCover(file); } catch (e) { return oops(e); }
  if (!jpeg) return; // cancelled
  const t = toast('Uploading cover…', { ms: 0 });
  try {
    const cover = await uploadFile(jpeg, undefined, table === 'projects' ? item.id : item.project_id);
    await api(`/${table}/${item.id}`, { method: 'PATCH', body: { cover } });
    await load();
  } catch (e) { oops(e); }
  t.remove();
}

// Crop & adjust a cover before it's uploaded: drag to move, pinch / scroll / slider to zoom, rotate, and a brightness
// and contrast touch-up. Reset puts it all back. Resolves with a square 1000px JPEG, or null if cancelled.
async function cropCover(file, { size: OUT = 1000, round = false, title = 'Crop cover', ok = 'Use cover' } = {}) {
  let img = await decodeImage(file);
  const V = Math.min(320, innerWidth - 80); // the square you see, in CSS px
  const st = { z: 1, x: 0, y: 0, light: 0, contrast: 0 };
  let base = 1;
  const frame = h('div', { className: 'crop-frame' + (round ? ' round' : ''), style: { width: V + 'px', height: V + 'px' } });
  const pic = h('canvas', { className: 'crop-img' });
  frame.append(pic, h('div', { className: 'crop-grid', 'aria-hidden': 'true' }));
  const zoom = h('input', { type: 'range', min: 1, max: 4, step: 0.01, value: 1, 'aria-label': 'Zoom', oninput() { zoomTo(+this.value); } });
  const light = h('input', { type: 'range', min: -50, max: 50, step: 1, value: 0, 'aria-label': 'Brightness', oninput() { st.light = +this.value; paint(); } });
  const contrast = h('input', { type: 'range', min: -50, max: 50, step: 1, value: 0, 'aria-label': 'Contrast', oninput() { st.contrast = +this.value; paint(); } });
  const filter = () => `brightness(${1 + st.light / 100}) contrast(${1 + st.contrast / 100})`;
  const size = () => [img.naturalWidth * base * st.z, img.naturalHeight * base * st.z];
  // keep the picture covering the whole square
  const clamp = () => { const [w, hh] = size(); st.x = Math.min(0, Math.max(V - w, st.x)); st.y = Math.min(0, Math.max(V - hh, st.y)); };
  function paint() {
    clamp();
    const [w, hh] = size();
    Object.assign(pic.style, { width: w + 'px', height: hh + 'px', transform: `translate(${st.x}px, ${st.y}px)`, filter: filter() });
    zoom.value = st.z; light.value = st.light; contrast.value = st.contrast;
    [zoom, light, contrast].forEach(syncRange);
  }
  // zoom around a point of the square (its centre unless a pinch or the mouse says otherwise)
  function zoomTo(z, cx = V / 2, cy = V / 2) {
    z = Math.min(4, Math.max(1, z));
    const k = z / st.z;
    st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.z = z;
    paint();
  }
  function useImage(src) {
    img = src;
    pic.width = img.naturalWidth || img.width; pic.height = img.naturalHeight || img.height;
    if (!img.naturalWidth) { img.naturalWidth = img.width; img.naturalHeight = img.height; }
    pic.getContext('2d').drawImage(img, 0, 0);
    base = V / Math.min(img.naturalWidth, img.naturalHeight);
    const [w, hh] = [img.naturalWidth * base * st.z, img.naturalHeight * base * st.z];
    st.x = (V - w) / 2; st.y = (V - hh) / 2;
    paint();
  }
  function reset() { Object.assign(st, { z: 1, light: 0, contrast: 0 }); useImage(original); }
  function rotate() {
    const c = h('canvas', { width: img.naturalHeight, height: img.naturalWidth }), g = c.getContext('2d');
    g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(img, 0, 0);
    Object.assign(c, { naturalWidth: c.width, naturalHeight: c.height });
    st.z = 1; useImage(c);
  }
  const original = img;
  // drag to move; two fingers pinch to zoom
  const pts = new Map();
  let last = null;
  frame.addEventListener('pointerdown', e => { frame.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = null; });
  frame.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { st.x += e.clientX - prev[0]; st.y += e.clientY - prev[1]; return paint(); }
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = frame.getBoundingClientRect();
    if (last) zoomTo(st.z * (d / last), (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
    last = d;
  });
  const up = e => { pts.delete(e.pointerId); last = null; };
  frame.addEventListener('pointerup', up); frame.addEventListener('pointercancel', up);
  frame.addEventListener('wheel', e => { e.preventDefault(); const r = frame.getBoundingClientRect(); zoomTo(st.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  frame.addEventListener('dblclick', () => zoomTo(st.z > 1.5 ? 1 : 2));

  const slider = (label, input) => h('label', { className: 'crop-slider' }, h('span', { className: 'mono' }, label), input);
  return new Promise(res => {
    let done = false;
    const d = dialog(h('div', { className: 'stack crop' },
      h('h2', {}, title),
      frame,
      h('small', { className: 'muted', style: { textAlign: 'center' } }, matchMedia('(pointer: coarse)').matches ? 'Drag to move · pinch to zoom' : 'Drag to move · scroll to zoom'),
      slider('[zoom]', zoom), slider('[brightness]', light), slider('[contrast]', contrast),
      h('div', { className: 'btns', style: { justifyContent: 'flex-start', marginTop: 0 } },
        h('button', { type: 'button', className: 'btn', onclick: rotate }, icon('undo', 15), 'Rotate'),
        h('button', { type: 'button', className: 'btn ghost', onclick: reset }, 'Reset')),
      h('div', { className: 'btns' },
        h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'),
        h('button', { type: 'button', className: 'btn primary', async onclick() {
          // the square you see, cut out of the full-size picture
          const k = base * st.z, c = h('canvas', { width: OUT, height: OUT }), g = c.getContext('2d');
          g.filter = filter();
          g.drawImage(img, -st.x / k, -st.y / k, V / k, V / k, 0, 0, OUT, OUT);
          const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
          done = true; res(new File([blob], 'cover.jpg', { type: 'image/jpeg' })); d.close();
        } }, ok))), { className: 'settings-dlg crop-dlg' });
    d.addEventListener('close', () => { if (!done) res(null); });
    useImage(img);
  });
}

// Drag and drop: loose files go to the current project; each dropped folder becomes a project.
const dropEl = $('#drop');
const hideDrop = () => { dropEl.hidden = true; };
let dragDepth = 0;
addEventListener('dragenter', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++; dropEl.hidden = false;
  // in a project in Custom order the list stays visible, so you can drop between tracks to choose the spot
  const placing = S.view.type === 'project' && S.projectSort === 'manual' && canEdit(S.view.id) && !!$('.trow[data-id]');
  dropEl.classList.toggle('placing', placing);
  dropEl.firstElementChild.textContent = placing ? 'Drop between tracks to choose the spot' : 'Drop to upload';
});
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
// Moves tracks that were just uploaded to where the files were dropped (`at`: a track's id, and above or below it).
async function placeDropped(pid, had, at) {
  await load();
  const all = S.tracks.concat(S.sharedTracks).filter(t => t.project_id === pid).sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  const fresh = all.filter(t => !had.has(t.id)).map(t => t.id), order = all.filter(t => had.has(t.id)).map(t => t.id);
  const i = order.indexOf(at.id);
  if (!fresh.length || i < 0) return;
  order.splice(i + (at.after ? 1 : 0), 0, ...fresh);
  await reorder(order);
}
// at (optional): where in the project's order the files were dropped.
async function handleDrop(dt, projectId, at) {
  const into = projectId || (S.view.type === 'project' ? S.view.id : null);
  if (into && !canEdit(into)) return toast('You can listen to this project, not add to it', { error: true });
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const loose = [], folders = [];
  for (const en of entries) en.isDirectory ? folders.push({ name: en.name, files: await walk(en) }) : loose.push(await fileOf(en));
  if (!entries.length) loose.push(...dt.files);
  const waits = [];
  try {
    if (loose.length) {
      const images = loose.filter(f => kindOf(f.name) === 'cover');
      const rest = loose.filter(f => kindOf(f.name) !== 'cover');
      if (images.length && !rest.length) {
        // an image on its own is a cover, and only for the project it was dropped on (never a guess)
        if (!into) return toast('To set a cover, open the project first and drop the image there.', { ms: 5000 });
        return setCover('projects', projectOf(into), images[0]);
      }
      const pid = projectId || await targetProject();
      const had = new Set(S.tracks.concat(S.sharedTracks).filter(t => t.project_id === pid).map(t => t.id));
      waits.push(uploadTracks(rest, pid).then(() => at && placeDropped(pid, had, at)));
    }
    const folderId = S.view.type === 'project' ? projectOf(S.view.id)?.folder_id || null : null;
    for (const f of folders) {
      const { id } = await api('/projects', { method: 'POST', body: { name: f.name, folder_id: folderId } });
      const art = f.files.find(x => kindOf(x.name) === 'cover');
      // Everything else (including other images, docs, etc.) goes in the queue; non-audio shows up as "skipped".
      waits.push(uploadTracks(f.files.filter(x => x !== art), id, f.name).then(() => art && setCover('projects', { id }, art)));
    }
  } catch (e) { oops(e); }
  await Promise.all(waits);
}

// ---- tracks -----------------------------------------------------------------------------
function trackMenu(t, list) {
  const manual = ordered() && S.projectSort === 'manual', inPl = S.view.type === 'playlist' && playlistOf(S.view.id);
  const i = list.indexOf(t);
  const move = d => { const ids = list.map(x => x.id); ids.splice(i, 1); ids.splice(i + d, 0, t.id); reorder(ids); };
  const ed = canEdit(t.project_id), own = !isShared(t.project_id); // shared tracks: viewers listen, editors change them
  sheet([
    ed && { icon: 'star', label: t.mark === 'star' ? 'Unstar' : 'Star', run: () => setMark(t, t.mark === 'star' ? null : 'star') },
    ed && { icon: 'ban', label: t.mark === 'throw' ? 'Not a throwaway' : 'Mark as throwaway', run: () => setMark(t, t.mark === 'throw' ? null : 'throw') },
    ed && '-',
    { icon: 'play', label: 'Play next', run: () => playNextTrack(t) },
    { icon: 'queue', label: 'Add to queue', run: () => addToQueue(t) },
    { icon: 'plus', label: 'Add to playlist…', run: () => addToPlaylist([t]) },
    inPl && { icon: 'close', label: 'Remove from this playlist', run: () => api(`/playlists/${inPl.id}/tracks/${t.id}`, { method: 'DELETE' }).then(() => { inPl.ids = inPl.ids.filter(x => x !== t.id); render(); }, oops) },
    '-',
    ed && { icon: 'sliders', label: 'Edit audio', run: () => openEditor(t) },
    ed && { icon: 'upload', label: 'Replace with a new version', run: () => replaceAudio(t) },
    ed && { icon: 'info', label: 'Details, notes & versions', run: () => detailsDialog(t) },
    ed && { icon: 'gauge', label: 'Detect BPM & key', run: () => detectTracks([t], true) },
    '-',
    canComment(t.project_id) && { icon: 'comment', label: 'Comments', run: () => commentsDialog(t) },
    own && { icon: 'share', label: 'Share', run: () => shareDialog('track', t.id, t.name) },
    '-',
    isOffline(t) ? { icon: 'close', label: 'Remove from this device', run: () => removeOffline(t) } : { icon: 'download', label: 'Save offline', run: () => saveOffline(t) },
    ed && { icon: 'download', label: 'Export file', run: () => exportTrack(t) },
    '-',
    (ed || inPl) && manual && i > 0 && { icon: 'up', label: 'Move up', run: () => move(-1) },
    (ed || inPl) && manual && i < list.length - 1 && { icon: 'down', label: 'Move down', run: () => move(1) },
    '-',
    ed && { icon: 'trash', label: 'Move to trash', danger: true, async run() {
      if (!(await api(`/tracks/${t.id}`, { method: 'DELETE' }).then(() => true, oops))) return;
      load();
      toast(`Moved “${t.name}” to the trash`, { ms: 7000, action: { label: 'Undo', run: () => restore('track', t.id) } });
    } },
  ]);
}

// Inbox: every notification (comments, listens, projects shared with you), newest first.
async function inboxDialog() {
  document.body.classList.remove('side-open');
  const list = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Inbox'), list,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  const open = url => {
    d.close();
    const track = /^\/\?track=([\w-]+)$/.exec(url || '')?.[1];
    if (track && trackOf(track)) (canEdit(trackOf(track).project_id) ? detailsDialog : commentsDialog)(trackOf(track));
    else if (/^\/s\/[0-9a-f]{32}$/.test(url || '')) location.href = url;
    else if (url === '/?bugs=1' && S.me?.isAdmin) bugsDialog();
    else if (url === '/?reports=1' && S.me?.isAdmin) reportsDialog();
  };
  let lastTitle = '';
  const rows = await api('/inbox').catch(e => (oops(e), []));
  fill(list, rows.length ? rows.map(n => h('button', { type: 'button', className: 'item inbox-item' + (n.read ? '' : ' unread'), onclick: () => { lastTitle = n.title; open(n.url); } },
    h('span', { className: 'grow' }, h('b', {}, n.title), n.body && h('div', { className: 'muted' }, n.body), h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, fmtDate(n.created_at)))))
    : h('div', { className: 'muted' }, 'Nothing yet. Comments, listens and projects shared with you show up here.'));
  if (S.unread) { S.unread = 0; renderSide(); api('/inbox/read', { method: 'POST' }).catch(() => {}); }
}

// Comments on a track, from share links and from people on the project. Writing one pins it to where you are in the track.
async function commentsDialog(t) {
  const list = h('div', { className: 'list comments' }, h('div', { className: 'muted' }, 'Loading…'));
  const input = h('input', { type: 'text', maxLength: 1000, placeholder: 'Write a comment…', 'aria-label': 'Comment' });
  const at = () => (cur?.id === t.id && audio.currentTime ? audio.currentTime : null);
  async function draw() {
    const rows = await api(`/tracks/${t.id}/comments`).catch(e => (oops(e), []));
    fill(list, rows.length ? rows.slice().reverse().map(cm => h('div', { className: 'item comment' },
      cm.at != null ? h('button', { type: 'button', className: 'ts num', title: 'Play from here', onclick: () => playFrom(t, cm.at) }, fmtTime(cm.at)) : h('span', { className: 'ts num' }, '—'),
      h('span', { className: 'grow' }, h('b', {}, cm.name), ' ', cm.body, h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, fmtDate(cm.created_at))),
      (canEdit(t.project_id) || cm.user_id === S.me?.id) && h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Delete comment',
        onclick: () => api(`/comments/${cm.id}`, { method: 'DELETE' }).then(draw, oops) }, icon('trash', 15))))
      : h('div', { className: 'muted' }, 'No comments yet.'));
    list.scrollTop = list.scrollHeight;
  }
  const d = dialog(h('form', { className: 'stack', async onsubmit(e) {
    e.preventDefault();
    if (!input.value.trim()) return;
    try { await api(`/tracks/${t.id}/comments`, { method: 'POST', body: { body: input.value.trim(), at: at() } }); input.value = ''; draw(); } catch (x) { oops(x); }
  } }, h('h2', {}, `Comments · ${t.name}`), list,
  h('div', { className: 'people-add' }, input, h('button', { className: 'btn primary' }, 'Post')),
  h('small', { className: 'people-note' }, cur?.id === t.id ? `Your comment is pinned to ${fmtTime(audio.currentTime)}.` : 'Play the track first to pin your comment to a moment in it.'),
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Done'))));
  draw();
}

// Who changed what in a project (its owner and the people on it can see this).
async function activityDialog(p) {
  const list = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, `Activity · ${p.name}`), list,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))));
  const rows = await api(`/projects/${p.id}/activity`).catch(e => (oops(e), []));
  fill(list, rows.length ? rows.map(r => h('div', { className: 'item' }, avatarEl(r),
    h('span', { className: 'grow' }, h('b', {}, nameOf(r) || 'Someone'), ' ', r.text, h('div', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, fmtDate(r.created_at)))))
    : h('div', { className: 'muted' }, 'Nothing yet. Changes made by you and the people on this project show up here.'));
}

// Detects BPM & key for existing tracks. overwrite=false only fills in what's missing.
// Decodes once and returns the waveform, plus BPM & key when detect is on.
async function analyse(blob, name, detect = true) {
  // ponytail: over 200 MB isn't decoded (that much audio in memory can crash a phone); BPM/key come from the name, no waveform
  if (blob.size > 200e6) return detect ? parseName(name) : {};
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
  if (t.peaks || peaking.has(t.id) || !S.online || t.size > 200e6 || !canEdit(t.project_id)) return; // listen-only: don't write to someone else's track
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
  list = list.filter(t => canEdit(t.project_id));
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
  if (!canEdit(t.project_id)) return toast('This project is listen-only for you', { quiet: true });
  const name = h('input', { type: 'text', value: t.name, required: true, maxLength: 300 });
  const artist = h('input', { type: 'text', value: t.artist || '', placeholder: settings.artist || 'Who made it', maxLength: 120 });
  const bpm = h('input', { type: 'number', min: 20, max: 400, step: 0.1, value: t.bpm ?? '', placeholder: '—' });
  const disc = h('input', { type: 'number', min: 1, max: 99, step: 1, value: t.disc ?? '', placeholder: '1' });
  const key = h('select', {}, h('option', { value: '' }, '—'), KEYS.map(k => h('option', { value: k, selected: t.musical_key === k }, k)));
  const tags = h('input', { type: 'text', value: t.tags || '', placeholder: 'dark, trap, sent to Mike', maxLength: 500 });
  const own = !isShared(t.project_id); // a shared track stays in its project
  const proj = own && h('select', {}, S.projects.map(p => h('option', { value: p.id, selected: p.id === t.project_id }, p.name)));
  const notes = h('textarea', { rows: 5, value: t.notes || '', placeholder: 'Lyrics, ideas, who you sent it to…', maxLength: 20000 });
  const versions = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const comments = h('div', { className: 'list comments' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      try {
        await api(`/tracks/${t.id}`, { method: 'PATCH', body: {
          name: name.value.trim(), artist: artist.value.trim(), bpm: bpm.value ? +bpm.value : null, musical_key: key.value || null, disc: disc.value ? +disc.value : null,
          tags: tags.value.split(',').map(s => s.trim()).filter(Boolean).join(', '), notes: notes.value, ...(own ? { project_id: proj.value } : {}),
        } });
      } catch (x) { return oops(x); }
      d.close(); load();
    },
  },
  h('h2', {}, 'Track details'),
  h('label', {}, 'Name', name),
  h('label', {}, 'Producer / artist', artist),
  h('div', { className: 'row2' }, h('label', {}, 'BPM', bpm), h('label', {}, 'Key', key)),
  h('div', { className: 'row2' }, h('label', {}, 'Tags (comma separated)', tags), h('label', { className: 'disc-l' }, 'Disc', disc)),
  own && h('label', {}, 'Project', proj),
  h('label', {}, 'Notes', notes),
  h('div', { className: 'btns', style: { justifyContent: 'flex-start' } },
    h('button', { type: 'button', className: 'btn', onclick: () => { d.close(); setCover('tracks', t); } }, t.cover ? 'Change cover' : 'Add cover'),
    t.cover && h('button', { type: 'button', className: 'btn ghost', onclick: () => { d.close(); api(`/tracks/${t.id}`, { method: 'PATCH', body: { cover: null } }).then(load, oops); } }, 'Remove cover')),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Comments'), comments),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Versions'), versions, // not a <label>: that would click the first button inside
    h('button', { type: 'button', className: 'btn', style: { justifySelf: 'start' }, disabled: !S.online, onclick: () => { d.close(); replaceAudio(t); } }, icon('upload', 15), 'Upload a new version')),
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
    } }, icon('trash', 15)))) : h('div', { className: 'muted' }, 'None yet. People on the project and anyone with a share link can comment at a moment in the track.')), oops);

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

// Export: saves the track's current file to this device (Downloads, or the share sheet in the iPhone app).
async function exportTrack(t) {
  const note = toast(`Getting “${t.name}” ready…`, { ms: 0 });
  try {
    const blob = await audioBlob(t);
    saveBlob(blob, safeName(t.name) + extFromType(blob.type));
  } catch (e) { oops(e); }
  note.remove();
}
// Replace a track's audio with a new file (a new bounce, a fixed mix). Its name, notes, comments and share links stay;
// the file it had is kept under Versions, so you can switch back.
async function replaceAudio(t) {
  if (!canEdit(t.project_id)) return toast('This project is listen-only for you', { quiet: true });
  if (!S.online) return toast('Replacing a file needs a connection', { error: true });
  const [file] = splitAccepted(await pickFiles(ACCEPT_AUDIO, false), 'audio');
  if (!file) return;
  const note = toast(`Uploading the new version of “${t.name}”…`, { ms: 0 });
  const say = text => { note.firstChild.textContent = text; };
  try {
    const duration = await durationOf(file);
    const analysing = analyse(file, file.name, false);
    const file_key = await uploadFile(file, p => say(`Uploading the new version of “${t.name}”… ${Math.round(p * 100)}%`), t.project_id);
    say('Saving…');
    const { peaks } = await analysing;
    await api(`/tracks/${t.id}/versions`, { method: 'POST', body: { file_key, duration, peaks, note: `New file: ${file.name}`.slice(0, 300) } });
    toast(`“${t.name}” now plays the new file. The one before is kept under Versions.`, { ms: 6000 });
    // the playing track switches to the new file at the same spot
    if (cur?.id === t.id) await editorClosed(t, { at: audio.currentTime, playing: !audio.paused, saved: true }); else await load();
  } catch (e) { if (e.message !== 'Cancelled') oops(e); }
  note.remove();
}
const extFromType = type => (extForType(type) ? '.' + extForType(type) : '');

// ---- offline ------------------------------------------------------------------------------
// Downloaded tracks live in the Cache API, keyed by file version so edits don't serve stale audio.
const offKey = t => `/offline/${t.file_key}`;
function isOffline(t) { return S.offline.has(t.file_key); }
// many = part of "Save all offline", which shows one progress note for the lot. True when it's saved.
async function saveOffline(t, many = false) {
  const note = !many && toast(`Saving “${t.name}” offline…`, { ms: 0 });
  let ok = false;
  try {
    const { url } = await api(`/audio/${t.id}?json=1`);
    const r = await fetch(url);
    if (!r.ok) throw new Error('not saved');
    await (await caches.open('audio')).put(offKey(t), r);
    S.offline.add(t.file_key); store.set('offline', [...S.offline]);
    navigator.storage?.persist?.();
    ok = true;
    if (!many) { renderSide(); renderList(); toast(`“${t.name}” is saved for offline listening`, { ms: 2500 }); }
  } catch (e) { if (!many) oops(e.fromApi ? e : new Error(`Couldn't save “${t.name}” offline. Check your connection (and this device's free space), then try again.`)); }
  if (note) note.remove();
  return ok;
}
async function saveAllOffline(list) {
  const todo = list.filter(t => !isOffline(t));
  if (!todo.length) return toast(list.length ? 'Everything here is already saved offline' : 'There are no tracks to save yet');
  const note = toast('', { ms: 0 });
  let saved = 0;
  for (const [i, t] of todo.entries()) {
    note.firstChild.textContent = `Saving offline… ${i + 1} of ${todo.length}`;
    if (await saveOffline(t, true)) saved++;
  }
  note.remove(); renderSide(); renderList();
  toast(saved === todo.length ? `Saved ${saved} ${saved === 1 ? 'track' : 'tracks'} for offline listening`
    : `Saved ${saved} of ${todo.length}. Check your connection, then try again for the rest.`, { error: saved < todo.length, ms: 5000 });
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
  P.from = S.view.type === 'playlist' ? S.view.id : null; // played from a playlist (else: each track's own project)
  if (shuffle !== undefined) { P.shuffle = shuffle; store.set('shuffle', shuffle); }
  await playAt(i);
}
let playCounted = true;
const countPlay = () => { if (playCounted || !cur || !realSrc() || !S.online) return; playCounted = true; api('/plays', { method: 'POST', body: { track_id: cur.id } }).catch(() => {}); };
audio.addEventListener('timeupdate', () => { if (audio.currentTime >= 10) countPlay(); });
audio.addEventListener('ended', countPlay);
async function playAt(i, { remember = true } = {}) {
  if (i < 0 || i >= queue.length) return;
  playCounted = false;
  if (remember && cur && qi >= 0 && qi !== i) P.history.push(qi);
  qi = i; cur = queue[i];
  store.set('recent', [cur.id, ...store.get('recent', []).filter(id => id !== cur.id)].slice(0, 20));
  if (blobUrl) { const old = blobUrl; setTimeout(() => URL.revokeObjectURL(old), 30000); blobUrl = null; }
  const t = cur, my = ++playToken;
  // iPhones only let audio start from a tap; start a moment of silence now so the real song can begin after downloading
  if (!audioUnlocked) { audio.src = SILENT; audio.play().then(() => { audioUnlocked = true; }, () => {}); }
  renderPlayer(); markPlaying();
  const blob = await fromDevice(t).catch(() => null);
  // Not on this device yet: it starts playing straight away (streamed). Once it's clearly being listened to (not
  // skipped past), a copy is saved in the background, so next time it plays from this device.
  if (!blob && settings.keepPlayed && S.online) setTimeout(() => { if (cur === t && S.online) fetchAudio(t).catch(() => {}); }, 8000);
  if (my !== playToken) return; // something else was picked while this loaded
  audio.src = blob ? (blobUrl = URL.createObjectURL(blob)) : `/api/audio/${t.id}?k=${encodeURIComponent(t.file_key)}`; // file key in the URL so a saved edit isn't served from the cached redirect
  audio.loop = P.repeat === 'one';
  // The editor opened while this was downloading: load it but don't start, or it'd play on top of the editor.
  if (editorOpen) audio.pause(); else audio.play().catch(() => {});
  renderPlayer(); markPlaying();
  nowPlaying();
}
// Lock screen / Now Playing: title, cover and the previous / next buttons.
function nowPlaying() {
  if (!cur || !('mediaSession' in navigator)) return;
  const t = cur, key = coverOf(t), meta = artwork => new MediaMetadata({ title: t.name, artist: t.artist || projectOf(t.project_id)?.name || '', album: projectOf(t.project_id)?.name || '', artwork });
  navigator.mediaSession.metadata = meta(artReady.get(key) || []); // straight away when the cover is already made
  if (key && !artReady.has(key)) lockScreenArt(key).then(a => { if (cur === t && a.length) navigator.mediaSession.metadata = meta(a); });
  // get the next song's cover ready now: by the time it starts, the phone may be locked
  const next = upNext();
  if (next) lockScreenArt(coverOf(next));
  mediaControls();
}
// The phone fetches artwork itself, without the login cookie, so a protected cover URL fails and it shows the app icon.
// Instead the page loads the cover (logged in) and hands over a small copy as a data URL. A cover that failed to load
// (a blip in the connection) is tried again the next time, not remembered as "no cover".
const artCache = new Map(), artReady = new Map();
function lockScreenArt(key) {
  if (!key) return Promise.resolve([]);
  if (!artCache.has(key)) artCache.set(key, (async () => {
    const r = await fetch(coverUrl(key));
    if (!r.ok) throw new Error('no cover');
    const img = await loadImg(await r.blob());
    const n = Math.min(img.naturalWidth, img.naturalHeight), c = h('canvas', { width: 512, height: 512 });
    c.getContext('2d').drawImage(img, (img.naturalWidth - n) / 2, (img.naturalHeight - n) / 2, n, n, 0, 0, 512, 512);
    const art = [{ src: c.toDataURL('image/jpeg', 0.85), sizes: '512x512', type: 'image/jpeg' }];
    artReady.set(key, art);
    return art;
  })().catch(() => { artCache.delete(key); return []; }));
  return artCache.get(key);
}
// Previous / next on the lock screen, headphones and keyboards, and dragging the lock screen's progress bar.
// Set again each time a song starts: iPhones can forget them when the audio changes, and then show "skip 15 seconds"
// buttons. (The seek-back / seek-forward buttons are left unset on purpose: on iPhone they take the place of previous / next.)
function mediaControls() {
  if (!('mediaSession' in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
  set('previoustrack', () => { if (!editorOpen) playPrev(); });
  set('nexttrack', () => { if (!editorOpen) skip(); });
  set('seekbackward', null); set('seekforward', null);
  set('seekto', e => { if (!editorOpen && e.seekTime != null && isFinite(audio.duration)) audio.currentTime = Math.min(e.seekTime, audio.duration); });
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
  if (cur && !cur.duration && isFinite(audio.duration)) { cur.duration = audio.duration; if (canEdit(cur.project_id)) api(`/tracks/${cur.id}`, { method: 'PATCH', body: { duration: audio.duration } }).catch(() => {}); }
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
// Volume: computers only (on phones the side buttons do it, and iPhones ignore it anyway). Remembered on this device.
const showVol = canFade && matchMedia('(pointer: fine)').matches;
let vol = showVol ? Math.min(1, Math.max(0, +store.get('volume', 1) || 0)) : 1;
audio.volume = vol;
function volumeControl() {
  let before = vol || 1;
  const btn = h('button', { className: 'icon-btn sm', onclick: () => setVol(vol ? ((before = vol), 0) : before) });
  const range = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume', oninput() { setVol(this.value / 100); } });
  range.addEventListener('wheel', e => { e.preventDefault(); setVol(Math.min(1, Math.max(0, vol - Math.sign(e.deltaY) * 0.05))); }, { passive: false });
  const paint = () => {
    range.value = Math.round(vol * 100); syncRange(range);
    btn.replaceChildren(icon(vol === 0 ? 'mute' : vol < 0.5 ? 'volLow' : 'vol', 17));
    btn.setAttribute('aria-label', vol ? 'Mute' : 'Unmute'); btn.title = vol ? `Volume ${Math.round(vol * 100)}%` : 'Muted';
  };
  function setVol(v) { vol = +v.toFixed(2); if (!fading) audio.volume = vol; store.set('volume', vol); paint(); }
  paint();
  return h('div', { className: 'vol' }, btn, range);
}
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
  tail.currentTime = audio.currentTime; tail.volume = vol; tail.play().catch(() => {});
  audio.volume = 0;
  advance();
  const t0 = performance.now();
  (function step() {
    const p = Math.min(1, (performance.now() - t0) / (secs * 1000)), e = p * p * (3 - 2 * p);
    audio.volume = e * vol; tail.volume = (1 - e) * vol;
    if (p < 1) setTimeout(step, 40);
    else { tail.pause(); audio.volume = vol; fading = false; }
  })();
}

// A spinning ring round the play button while a song is still starting or has stalled.
for (const ev of ['loadstart', 'waiting']) audio.addEventListener(ev, () => { if (realSrc()) { document.body.style.setProperty('--load', '28%'); document.body.classList.add('audio-loading'); } });
for (const ev of ['playing', 'canplay', 'error', 'emptied']) audio.addEventListener(ev, () => document.body.classList.remove('audio-loading'));
const realSrc = () => !audio.currentSrc.startsWith('data:'); // not the moment of silence used to unlock iPhone audio
audio.onended = () => { if (!realSrc()) return; if (P.userQ.length || settings.autoplay || P.repeat === 'all') advance(); };
audio.onerror = async () => {
  if (!cur) return;
  const why = await storageProblem();
  toast(why || `This browser can't play “${cur.name}”.${canEdit(cur.project_id) ? ' You can still get the file with ⋯ → Export file.' : ''}`, { error: true, ms: why ? 15000 : 7000 });
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
  if (!S.me?.owner) return (lastWhy = "Your files couldn't load right now. Try again in a bit.");
  const text = `${r.code} ${r.message}`.toLowerCase();
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  lastWhy = /cap|exceed|limit/.test(text)
    ? `Backblaze's free daily limit is used up, so songs and covers can't load right now. It resets at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : /key|access ?denied|signature|unauthori|invalid/.test(text) || r.status === 401 || r.status === 403
      ? 'Backblaze is refusing the app\'s key (it was probably deleted or replaced). On your computer, run node setup.mjs and paste your current Backblaze key.'
      : `Backblaze isn't answering properly (${r.status} ${r.code || ''}). Try again in a bit.`;
  return lastWhy;
}
mediaControls();
audio.addEventListener('playing', () => { if (realSrc() && !editorOpen) mediaControls(); });

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
      canEdit(t.project_id) && [starBtn(t), throwBtn(t, 'hide-sm')],
      shuffleBtn('hide-sm'),
      h('button', { className: 'icon-btn hide-sm', 'aria-label': 'Previous', onclick: playPrev }, icon('prev', 18)),
      playBtn,
      h('button', { className: 'icon-btn', 'aria-label': 'Next', onclick: skip }, icon('next', 18)),
      repeatBtn('hide-sm'),
      h('button', { className: 'icon-btn', 'aria-label': 'Up next', title: 'Up next', onclick: queueDialog }, icon('queue', 18)),
      canEdit(t.project_id) && h('button', { className: 'icon-btn', 'aria-label': 'Edit audio', title: 'Edit audio', onclick: () => openEditor(t) }, icon('sliders', 18))),
    h('div', { className: 'seek' }, t1, seek, t2, showVol && volumeControl()),
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
  // The project or playlist it's playing from; tapping its name (top) or the song title opens it.
  const pl = P.from && playlistOf(P.from)?.ids?.includes(t.id) ? playlistOf(P.from) : null;
  const openFrom = () => { // a song saved from someone's link has no project of yours to open
    if (!pl && !projectOf(t.project_id)) return;
    fp.d.close(); setView(pl ? { type: 'playlist', id: pl.id } : { type: 'project', id: t.project_id });
  };
  const fromName = pl ? pl.name : projectOf(t.project_id)?.name;
  const title = h('div', { className: 'fp-t fp-link', role: 'button', tabIndex: 0, title: `Open ${fromName || 'the project'}`, onclick: openFrom, onkeydown(e) { if (e.key === 'Enter') openFrom(); } }, t.name);
  fill(fp.d.firstChild,
    h('div', { className: 'fp-bg', style: art ? bg(art) : { backgroundImage: washFor(t) } }),
    h('span', { className: 'fp-grab', 'aria-hidden': 'true' }),
    h('div', { className: 'fp-top' },
      h('button', { className: 'icon-btn fp-close', 'aria-label': 'Close the player', onclick: () => fp.d.close() }, icon('chevron', 24)),
      h('button', { className: 'fp-from fp-link', title: `Open ${fromName || 'the project'}`, onclick: openFrom }, h('span', { className: 'mono' }, '[now playing]'), h('b', {}, fromName || 'your library')),
      h('button', { className: 'icon-btn', 'aria-label': 'Track options', onclick: () => trackMenu(t, queue) }, icon('more', 22))),
    h('div', { className: 'fp-art' + (art ? '' : ' disc') + (playing ? ' playing' : ''), style: bg(art), ...artPress }),
    h('div', { className: 'fp-info' },
      h('div', { className: 'fp-titles' }, title, h('div', { className: 'fp-a' }, [t.artist, t.musical_key, t.bpm && Math.round(t.bpm) + ' bpm'].filter(Boolean).join(' · ') || '\u00a0')),
      canEdit(t.project_id) && [starBtn(t), throwBtn(t)]),
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
      canEdit(t.project_id) && h('button', { className: 'icon-btn', 'aria-label': 'Details', title: 'Details', onclick: () => detailsDialog(trackOf(t.id) || t) }, icon('info', 20)),
      !canEdit(t.project_id) && canComment(t.project_id) && h('button', { className: 'icon-btn', 'aria-label': 'Comments', title: 'Comments', onclick: () => commentsDialog(t) }, icon('comment', 20)),
      !isShared(t.project_id) && h('button', { className: 'icon-btn', 'aria-label': 'Share', title: 'Share', onclick: () => shareDialog('track', t.id, t.name) }, icon('share', 20)),
      canEdit(t.project_id) && h('button', { className: 'icon-btn', 'aria-label': 'Edit audio', title: 'Edit audio', onclick: () => { fp.d.close(); openEditor(t); } }, icon('sliders', 20))));
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
let editorOpen = false; // while it's open, the player never starts on its own
async function openEditor(t) {
  if (!canEdit(t.project_id)) return toast('This project is listen-only for you', { quiet: true });
  if (!S.online) return toast('Editing needs a connection', { error: true });
  // The editor opens at the same spot the player was at (and keeps playing if it was), and hands it back on close.
  const same = cur?.id === t.id, startAt = same ? audio.currentTime : 0, autoplay = same && !audio.paused;
  audio.pause(); editorOpen = true;
  try {
    const { openEditor } = await import('./editor.js');
    await openEditor(t, { api, toast, oops, dialog, prompt, confirm, uploadFile: (f, cb) => uploadFile(f, cb, t.project_id), audioBlob, onSaved: load, h, project: projectOf(t.project_id)?.name,
      startAt, autoplay, haptic, onClosed: back => editorClosed(t, back) });
  } catch (e) {
    editorOpen = false;
    // never fail silently: say what went wrong
    toast(`The editor couldn't open: ${e.message}. Try reloading the app.`, { error: true, ms: 8000 });
  }
}

// Back from the editor: the player continues from where the editor was, playing or paused,
// on the new version if one was saved.
async function editorClosed(t, { at, playing, saved }) {
  editorOpen = false;
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
  const list = h('div', { className: 'list share-links' }, h('div', { className: 'muted' }, 'Loading…'));
  const pw = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off', maxLength: 200 });
  const days = h('select', {}, SHARE_DAYS.map(([v, l]) => h('option', { value: v, selected: v === settings.shareDays }, l)));
  const dl = h('input', { type: 'checkbox', className: 'toggle', 'aria-label': 'Allow downloads' });
  const pub = h('input', { type: 'checkbox', className: 'toggle', 'aria-label': 'Public link' });
  const link = token => `${location.origin}/s/${token}`;
  const copy = async token => { try { await navigator.clipboard.writeText(link(token)); toast('Link copied'); } catch { prompt('Copy this link', link(token), { label: 'Link', ok: 'Done' }); } };
  async function refresh() {
    const rows = await api(`/shares?kind=${kind}&target_id=${target_id}`).catch(e => (oops(e), []));
    list.replaceChildren(...(rows.length ? rows.map(s => h('div', { className: 'item', style: s.revoked ? { opacity: 0.45 } : {} },
      !!s.has_password && h('span', { title: 'Password protected', style: { color: 'var(--fg-3)' } }, icon('lock', 14)),
      h('span', { className: 'grow mono' }, `${fmtDate(s.created_at)}${s.revoked ? ' · off' : s.expires_at ? ` · ${s.expires_at < Date.now() ? 'expired' : 'until ' + new Date(s.expires_at).toLocaleDateString()}` : ''}`),
      h('button', { type: 'button', className: 'btn ghost' + (s.allow_download ? ' on' : ''), 'aria-pressed': !!s.allow_download,
        title: s.allow_download ? 'Downloads allowed. Tap to turn off.' : 'Downloads off. Tap to allow.',
        onclick: () => api(`/shares/${s.token}`, { method: 'PATCH', body: { allow_download: !s.allow_download } }).then(refresh, oops) }, icon('download', 14), s.allow_download ? 'On' : 'Off'),
      h('button', { type: 'button', className: 'btn ghost' + (s.public ? ' on' : ''), 'aria-pressed': !!s.public,
        title: s.public ? 'Public: anyone with the link hears full songs. Tap to make it previews-only.' : 'Previews only unless signed in. Tap to make it public.',
        onclick: () => api(`/shares/${s.token}`, { method: 'PATCH', body: { public: !s.public } }).then(refresh, oops) }, icon('globe', 14), s.public ? 'Public' : 'Accounts'),
      h('button', { type: 'button', className: 'btn ghost', title: 'Who listened', onclick: () => listensDialog(s.token) }, icon('headphones', 14), String(s.listens)),
      !s.revoked && h('button', { type: 'button', className: 'btn', onclick: () => copy(s.token) }, 'Copy'),
      h('button', { type: 'button', className: 'btn ghost', onclick: () => api(`/shares/${s.token}`, { method: 'PATCH', body: { revoked: !s.revoked } }).then(refresh, oops) }, s.revoked ? 'Turn on' : 'Turn off'),
      h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': 'Delete link', title: 'Delete link', async onclick() {
        if (!(await confirm('Delete this link?', 'It stops working, disappears from the libraries of anyone who saved it, and its listen stats are deleted. Comments stay on the tracks.', 'Delete'))) return;
        api(`/shares/${s.token}`, { method: 'DELETE' }).then(refresh, oops);
      } }, icon('trash', 14)),
    )) : [h('div', { className: 'muted' }, 'No links yet.')]));
  }
  const d = dialog(h('form', {
    async onsubmit(e) {
      e.preventDefault();
      const r = await api('/shares', { method: 'POST', body: { kind, target_id, password: pw.value || null, days: days.value ? +days.value : null, allow_download: dl.checked, public: pub.checked } }).catch(oops);
      if (r) { pw.value = ''; await refresh(); copy(r.token); }
    },
  }, h('h2', {}, `Share “${name}”`),
  h('div', { className: 'row2' }, h('label', {}, 'Password', pw), h('label', {}, 'Expires', days)),
  h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Allow downloads', h('small', {}, 'For signed-in [vault] users. Changeable per link.')), dl),
  h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Public link', h('small', {}, 'Full songs for anyone with the link. Off: previews unless signed in.')), pub),
  h('div', { className: 'btns', style: { justifyContent: 'flex-start' } }, h('button', { className: 'btn primary' }, 'Create link')),
  h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Links · downloads · public · who listened'), list),
  kind === 'project' && peopleSection(target_id),
  kind === 'playlist' && (n => n > 0 && h('small', { className: 'people-note' }, `${n} ${n === 1 ? 'track is' : 'tracks are'} from projects other people shared with you, so ${n === 1 ? "it's" : "they're"} left out of the link. Only your own tracks are shared.`))(
    (playlistOf(target_id)?.ids || []).map(trackOf).filter(t => t && isShared(t.project_id)).length),
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Done'))));
  refresh();
}

// People on a project: add [vault] users by username as viewers (listen) or editors (add, remove, reorder and edit tracks).
function peopleSection(projectId) {
  const list = h('div', { className: 'list' });
  const name = h('input', { type: 'text', placeholder: 'Username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
  const role = h('select', { 'aria-label': 'Permission' }, h('option', { value: 'viewer' }, 'Can listen'), h('option', { value: 'editor' }, 'Can edit'));
  const roleSel = m => h('select', { 'aria-label': `${nameOf(m)}'s permission`, onchange() { api(`/projects/${projectId}/members`, { method: 'POST', body: { username: m.username, role: this.value } }).then(draw, oops); } },
    h('option', { value: 'viewer', selected: m.role === 'viewer' }, 'Can listen'), h('option', { value: 'editor', selected: m.role === 'editor' }, 'Can edit'));
  async function draw() {
    const people = await api(`/projects/${projectId}/members`).catch(e => (oops(e), []));
    fill(list, people.length ? people.map(m => h('div', { className: 'item' }, avatarEl(m), h('span', { className: 'grow' }, nameOf(m), m.display_name && h('small', { className: 'muted' }, ` @${m.username}`)), roleSel(m),
      h('button', { type: 'button', className: 'icon-btn sm', 'aria-label': `Remove ${nameOf(m)}`, onclick: () => api(`/projects/${projectId}/members/${m.id}`, { method: 'DELETE' }).then(draw, oops) }, icon('close', 14))))
      : h('div', { className: 'muted' }, 'Only you so far.'));
  }
  async function add() {
    if (!name.value.trim()) return;
    try { await api(`/projects/${projectId}/members`, { method: 'POST', body: { username: name.value.trim(), role: role.value } }); toast(`Added ${name.value.trim()}`); name.value = ''; draw(); } catch (e) { oops(e); }
  }
  name.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  draw();
  return h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'People with access'), h('div', { className: 'people-add' }, name, role, h('button', { type: 'button', className: 'btn', onclick: add }, 'Add')), list,
    h('small', { className: 'people-note' }, 'It shows up in their library under [shared with me]. Editors can add, remove, reorder and edit tracks; only you can delete the project or share it.'));
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
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("This browser can't record. Record with another app, then upload the file.", { error: true, ms: 6000 });
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch { return toast('Microphone access was blocked. Allow it in your browser settings.', { error: true, ms: 6000 }); }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = []; let started = 0, timer;
  const time = h('div', { className: 'rec-time num' }, '0:00');
  const name = h('input', { type: 'text', maxLength: 200, value: `Idea ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
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
    let note;
    try {
      const pid = await targetProject();
      note = toast('Saving recording…', { ms: 0 });
      const file_key = await uploadFile(file, undefined, pid);
      await api('/tracks', { method: 'POST', body: { project_id: pid, name: baseName(file.name), file_key, duration } });
      toast('Recording saved'); load();
    } catch (e) { oops(e); }
    note?.remove();
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
  const artist = h('input', { type: 'text', value: settings.artist, placeholder: 'Your name', maxLength: 120, 'aria-label': 'Default producer name', style: { width: '150px' }, onchange() { setSetting('artist', this.value.trim()); } });
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
      row('Back up everything', 'Copies every project, cover and note into a folder on this computer', h('button', { className: 'btn', onclick: () => { d.close(); backupAll(); } }, 'Back up')),
      S.me?.owner && row('Move to Google Drive', 'Copies your files from Backblaze into your Google Drive, one at a time. You can stop and carry on any time.', h('button', { className: 'btn', onclick: () => { d.close(); moveToDrive(); } }, 'Move')),
      row('Tidy up track info', 'Takes track numbers off names (the order stays), moves “prod. X” into a tag, and fills in artists from the files', h('button', { className: 'btn', onclick: () => { d.close(); tidyTracks(); } }, 'Tidy up'))),
    // The share-sheet Shortcut is for the web app; hidden inside the sideloaded iPhone app.
    !nativeHaptics && h('div', { className: 'set-sec' }, h('h3', {}, '[iphone web app]'),
      row('Upload from the share sheet', 'Web app only (Safari / Home Screen), not the sideloaded app. Send audio straight from AirDrop, Files or iMessage.', h('button', { className: 'btn', onclick: () => { d.close(); shortcutDialog(); } }, 'Set up'))),
    h('div', { className: 'set-sec' }, h('h3', {}, '[account]'),
      S.me && row(h('span', { className: 'me-row' }, meAvatar, h('span', {}, nameOf(S.me), h('small', {}, `@${S.me.username} · ${S.me.isAdmin ? 'Admin' : 'Member'}`))), null,
        h('button', { className: 'btn', async onclick() {
          const [file] = await pickFiles('image/*,.heic,.heif', false);
          if (!file) return;
          try { const avatar = await avatarData(file); if (!avatar) return; await api('/me', { method: 'PATCH', body: { avatar } }); S.me.avatar = avatar; paintAvatar(meAvatar, avatar, nameOf(S.me)); renderSide(); } catch (e) { oops(e); }
        } }, 'Picture')),
      S.me && row('Display name', 'What people see on comments, activity and things you share',
        h('button', { className: 'btn', async onclick() {
          const name = await prompt('Display name', S.me.displayName || '', { label: 'Your name (leave it empty to show your username)', optional: true, max: 40 });
          if (name == null || name === (S.me.displayName || '')) return;
          try { await api('/me', { method: 'PATCH', body: { display_name: name } }); d.close(); load(); toast(name ? 'Name changed' : 'Showing your username'); } catch (e) { oops(e); }
        } }, 'Edit')),
      S.me && row('Username', `@${S.me.username} · unique, for signing in and being added to projects`,
        h('button', { className: 'btn', async onclick() {
          const name = await prompt('Change username', S.me.username, { label: 'Username', ok: 'Save' });
          if (!name || name === S.me.username) return;
          try { await api('/me', { method: 'PATCH', body: { username: name } }); d.close(); load(); toast('Username changed'); } catch (e) { oops(e); }
        } }, 'Change')),
      S.me?.storage === 'drive' && row('Google Drive', S.me.driveEmail || (S.me.driveConnected ? 'Connected' : 'Not connected'),
        h('a', { className: 'btn', href: '/api/drive/connect' }, S.me.driveConnected ? 'Reconnect' : 'Connect')),
      // The admin starts on Backblaze; connecting Drive sends new uploads there (files already on Backblaze keep playing from it).
      S.me && S.me.storage !== 'drive' && row('Google Drive', 'Store new uploads in your Google Drive instead of Backblaze. Files already uploaded stay where they are and keep working.',
        h('a', { className: 'btn', href: '/api/drive/connect' }, 'Connect')),
      S.me?.isAdmin && row('Analytics', 'Sign-ups, activity, plays and storage', h('button', { className: 'btn', onclick: () => { d.close(); analyticsDialog(); } }, 'Open')),
      S.me?.isAdmin && row('People', 'Everyone with an account', h('button', { className: 'btn', onclick: () => { d.close(); peopleDialog(); } }, 'Manage')),
      row('Password', 'Changing it logs out your other devices', h('button', { className: 'btn', onclick: () => { d.close(); passwordDialog(); } }, 'Change')),
      row('Log out', 'On this device only. Songs kept on this device are removed.', h('button', { className: 'btn danger', onclick: logout }, 'Log out')),
      S.me && !S.me.owner && row('Delete account', 'Deletes your projects and the files [vault] made in your Google Drive. This can\'t be undone.',
        h('button', { className: 'btn danger', onclick: () => { d.close(); deleteAccountDialog(); } }, 'Delete'))),
    !only && h('div', { className: 'set-sec' }, h('h3', {}, '[support]'),
      row('Report a bug', 'Something broken or confusing? Tell me what happened.', h('button', { className: 'btn', onclick: () => { d.close(); bugDialog(); } }, 'Report')),
      S.me?.isAdmin && row('Reported links', 'Share links people have reported', h('button', { className: 'btn', onclick: () => { d.close(); reportsDialog(); } }, 'Open')),
      S.me?.isAdmin && row('Bug reports', 'What people have reported', h('button', { className: 'btn', onclick: () => { d.close(); bugsDialog(); } }, 'Open')),
      row('Support [vault]', 'Free, no ads. Tips help keep it that way.', h('a', { className: 'btn', href: 'https://ko-fi.com/choseroxy', target: '_blank', rel: 'noopener' }, 'Tip ☕'))),
    h('div', { className: 'btns' }, h('span', { className: 'mono', style: { marginRight: 'auto', color: 'var(--fg-3)', alignSelf: 'center' } }, APP_VERSION),
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

// Notifications on this device: listens, comments, and projects shared with you.
// Browsers (and the Home Screen web app on iPhone) use web push. The sideloaded [vault] iPhone app can't (iPhone app
// web views have no web push), so the app shows them itself: it checks the inbox every minute while it's open or
// playing, and now and then in the background when iOS lets it. The page talks to it through `notify` and the app
// answers on window.vaultNotify('granted' | 'denied' | 'default').
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const nativeNotify = window.webkit?.messageHandlers?.notify;
const webPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const notifyAnswers = [];
window.vaultNotify = state => notifyAnswers.splice(0).forEach(f => f(state));
const askApp = action => new Promise(res => { notifyAnswers.push(res); nativeNotify.postMessage({ action }); setTimeout(() => res('unknown'), 20000); });
const pushWorker = () => Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 4000, null))]);
// 'on' | 'off' (can be turned on) | 'blocked' | 'unsupported'
async function notifyStatus() {
  if (nativeNotify) return { granted: 'on', denied: 'blocked', default: 'off' }[await askApp('status')] || 'unsupported';
  if (!webPush) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await pushWorker();
  return reg && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
// Asks the phone or browser for permission (needs a tap first) and switches notifications on. True when they're on.
async function turnOnNotifications() {
  try {
    if (nativeNotify) return (await askApp('request')) === 'granted';
    if ((await Notification.requestPermission()) !== 'granted') return false;
    const reg = await pushWorker();
    if (!reg) throw new Error("Notifications couldn't start. Reload the page and try again.");
    const { key } = await api('/push/key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    return true;
  } catch (e) { oops(e); return false; }
}
function pushRow() {
  const sub = h('small', {}, 'Checking…'), btns = h('span', { className: 'btns', style: { margin: 0 } });
  const iPhone = /iPhone|iPad/.test(navigator.userAgent);
  async function draw() {
    const st = await notifyStatus();
    if (st === 'unsupported') {
      sub.textContent = iPhone ? 'On iPhone: Share → Add to Home Screen, open [vault] from your Home Screen, then turn this on there.' : "This browser can't show notifications.";
      return fill(btns);
    }
    if (st === 'blocked') {
      sub.textContent = nativeNotify ? 'Off in your iPhone settings. Open Settings → Notifications and allow them.'
        : iPhone ? 'Blocked. Allow them in iPhone Settings → Notifications → [vault].' : 'Blocked. Allow notifications for this site in your browser.';
      return fill(btns, nativeNotify && h('button', { className: 'btn', onclick: () => nativeNotify.postMessage({ action: 'settings' }) }, 'Open Settings'));
    }
    sub.textContent = st === 'on'
      ? (nativeNotify ? 'On. The app checks every minute while it’s open or playing, and every so often in the background.' : 'On for this device')
      : 'When someone plays one of your links, comments, or shares a project with you';
    fill(btns, st === 'on'
      ? nativeNotify
        ? h('button', { className: 'btn', onclick: () => nativeNotify.postMessage({ action: 'settings' }) }, 'Settings')
        : [h('button', { className: 'btn', onclick: test }, 'Test'), h('button', { className: 'btn', onclick: off }, 'Turn off')]
      : h('button', { className: 'btn', async onclick() { if (await turnOnNotifications()) toast('Notifications are on for this device'); draw(); } }, 'Turn on'));
  }
  async function off() {
    const reg = await pushWorker(), s = await reg?.pushManager.getSubscription();
    if (s) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: s.endpoint } }).catch(() => {}); await s.unsubscribe().catch(() => {}); }
    draw();
  }
  async function test() {
    const r = await api('/push/test', { method: 'POST' }).catch(oops);
    if (r) toast(r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}` : "Couldn't reach this device. Turn notifications off and on again.", { error: !r.sent });
  }
  draw();
  return h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Listens & comments', sub), btns);
}
// The first time someone's signed in on a device (and notifications can work there), ask once if they'd like them.
// Asked again later only if it got skipped because something else was on screen.
async function askForNotifications() {
  if (S.askedNotify || store.get('askedNotify') || !S.me || S.me.needsDrive) return;
  S.askedNotify = true;
  await new Promise(r => setTimeout(r, 1800));
  if (document.querySelector('dialog[open]') || (await notifyStatus()) !== 'off') return;
  store.set('askedNotify', true);
  const d = dialog(h('div', { className: 'stack notify-ask' },
    h('span', { className: 'notify-ic' }, icon('bell', 26)),
    h('h2', {}, 'Turn on notifications?'),
    h('p', { className: 'muted', style: { margin: 0 } }, 'Hear when someone plays one of your share links, comments on a track, or shares a project with you.'),
    h('div', { className: 'btns' },
      h('button', { className: 'btn ghost', onclick: () => { d.close(); toast('You can turn them on any time in Settings → Notifications', { quiet: true, ms: 4000 }); } }, 'Not now'),
      h('button', { className: 'btn primary', async onclick() { d.close(); if (await turnOnNotifications()) toast('Notifications are on'); } }, 'Turn on'))));
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

// Delete my account: asks for the password, then deletes in batches until everything is gone.
function deleteAccountDialog() {
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const err = h('p', { className: 'form-err' });
  const d = dialog(h('form', { className: 'stack', async onsubmit(e) {
    e.preventDefault();
    const btn = this.querySelector('.danger');
    btn.disabled = true; err.textContent = ''; btn.textContent = 'Deleting…';
    try {
      await untilDone(() => api('/me/delete', { method: 'POST', body: { password: pw.value } }));
      d.close(); await logout();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Delete my account'; }
  } }, h('h2', {}, 'Delete your account?'),
  h('p', { className: 'muted', style: { margin: 0 } }, `This deletes your account (@${S.me.username}), every project and track, and the files [vault] put in your Google Drive. Links you shared stop working. It can't be undone.`),
  h('label', {}, 'Type your password to confirm', pw), err,
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn danger' }, 'Delete my account'))));
}

// Admin: see who has an account, turn accounts off, reset passwords or delete accounts.
async function peopleDialog() {
  const box = h('div', { className: 'stack' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'People'), box,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg' });
  async function draw() {
    const users = await api('/admin/users').catch(e => (oops(e), []));
    fill(box,
      h('div', { className: 'set-sec' }, h('h3', {}, '[accounts]'),
        users.map(u => h('div', { className: 'set-row' }, h('span', { className: 'me-row' }, avatarEl(u, 'avatar lg'),
          h('span', {}, nameOf(u) + (u.display_name ? ` @${u.username}` : '') + (u.disabled ? ' (off)' : ''), h('small', {}, u.id === 'owner' ? `Owner · Backblaze · ${fmtBytes(u.used)}` : `${u.is_admin ? 'Admin · ' : ''}${u.tracks} ${u.tracks === 1 ? 'track' : 'tracks'} · ${fmtBytes(u.used)} · ${u.drive ? 'Google Drive' : 'Drive not connected'}`))),
          // the owner can act on anyone but themselves; other admins only on people who aren't admins
          u.id !== 'owner' && (S.me.owner || !u.is_admin) && h('span', { className: 'btns', style: { margin: 0 } },
            S.me.owner && h('button', { className: 'btn', async onclick() {
              if (!u.is_admin && !(await confirm(`Make ${nameOf(u)} an admin?`, 'Admins can see Analytics, People and Bug reports, and can turn off, reset or delete accounts that aren\'t admins. They can\'t see anyone\'s files.', 'Make admin'))) return;
              if (await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } }).then(() => true, oops)) { toast(u.is_admin ? `${nameOf(u)} is no longer an admin` : `${nameOf(u)} is now an admin`); draw(); }
            } }, u.is_admin ? 'Remove admin' : 'Make admin'),
            h('button', { className: 'btn', async onclick() {
              if (!(await confirm(`Reset ${u.username}'s password?`, 'You get a temporary password to send them. Their devices are logged out; they can change it in Settings → Account.', 'Reset'))) return;
              const r = await api(`/admin/users/${u.id}/reset`, { method: 'POST' }).catch(oops);
              if (r) prompt(`${u.username}'s temporary password`, r.password, { label: 'Send this to them', ok: 'Done' });
            } }, 'Reset password'),
            h('button', { className: 'btn', async onclick() { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }).catch(oops); draw(); } }, u.disabled ? 'Turn on' : 'Turn off'),
            h('button', { className: 'btn danger', async onclick() {
              if (!(await confirm(`Delete ${u.username}?`, 'Their projects are deleted, along with the files [vault] made in their Google Drive. This can\'t be undone.', 'Delete'))) return;
              const t = toast('Deleting…', { ms: 0 });
              try { await untilDone(() => api(`/admin/users/${u.id}`, { method: 'DELETE' })); } catch (e) { oops(e); }
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
      h('p', { className: 'muted', style: { margin: 0 } }, 'For the web app only (Safari or the Home Screen icon), not the sideloaded [vault] app. Make one iPhone Shortcut, then choose “Upload to [vault]” whenever you share an audio file. It lands in your newest project (or in “Inbox”, if you have a project called that) with BPM and key read from the name.'),
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
        h('li', {}, 'Add ', h('b', {}, 'Show Notification'), ' with ', h('i', {}, 'Contents of URL'), ', so you see where it was saved.')),
      h('small', { className: 'muted' }, 'Want a different project? Add ', h('code', {}, '&project=Your Project Name'), ' to the URL. Too many wrong keys locks uploads for 15 minutes.'));
  }
  draw();
}

// ---- playlists --------------------------------------------------------------------------------
// Tracks from any of your projects (and ones shared with you), in your own order. The songs stay where they are.
function playlistArt(pl) {
  const covers = [...new Set(pl.ids.map(trackOf).filter(Boolean).map(coverOf).filter(Boolean))];
  return covers.length >= 4 ? h('div', { className: 'art pl-art' }, covers.slice(0, 4).map(c => h('i', { style: bg(c) })))
    : h('div', { className: 'art' + (covers[0] ? '' : ' disc'), style: bg(covers[0]) });
}
async function newPlaylist(tracks = []) {
  const name = await prompt('New playlist', '', { label: 'Name', ok: 'Create', max: 120 });
  if (!name) return null;
  const r = await api('/playlists', { method: 'POST', body: { name, track_ids: tracks.map(t => t.id) } }).catch(oops);
  if (!r) return null;
  await load();
  if (!tracks.length) setView({ type: 'playlist', id: r.id });
  else toast(`Made “${name}” with ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`, { ms: 4000, action: { label: 'Open', run: () => setView({ type: 'playlist', id: r.id }) } });
  return r.id;
}
// Pick a playlist (or make one) for these tracks. True once they're added.
function addToPlaylist(tracks) {
  if (!S.playlists.length) return newPlaylist(tracks).then(Boolean);
  return new Promise(res => {
    let done = false;
    const pick = async pl => {
      const fresh = tracks.filter(t => !pl.ids.includes(t.id));
      done = true; d.close();
      if (!fresh.length) { toast(`Already in “${pl.name}”`, { quiet: true }); return res(true); }
      const r = await api(`/playlists/${pl.id}/tracks`, { method: 'POST', body: { ids: fresh.map(t => t.id) } }).catch(oops);
      if (r) { await load(); toast(`Added ${r.added} to “${pl.name}”`, { ms: 4000, action: { label: 'Open', run: () => setView({ type: 'playlist', id: pl.id }) } }); }
      res(!!r);
    };
    const d = dialog(h('div', { className: 'stack' }, h('h2', {}, tracks.length === 1 ? `Add “${tracks[0].name}” to…` : `Add ${tracks.length} tracks to…`),
      h('div', { className: 'list' }, S.playlists.map(pl => h('button', { type: 'button', className: 'item pick-pl', onclick: () => pick(pl) },
        icon('queue', 16), h('span', { className: 'grow' }, pl.name), h('small', { className: 'muted' }, `${pl.ids.filter(trackOf).length} tracks`)))),
      h('div', { className: 'btns' },
        h('button', { type: 'button', className: 'btn', style: { marginRight: 'auto' }, onclick: async () => { done = true; d.close(); res(!!(await newPlaylist(tracks))); } }, icon('plus', 15), 'New playlist'),
        h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'))), { className: 'settings-dlg' });
    d.addEventListener('close', () => { if (!done) res(false); });
  });
}
function playlistMenu(pl) {
  const tracks = () => pl.ids.map(trackOf).filter(Boolean);
  sheet([
    { icon: 'share', label: 'Share', run: () => shareDialog('playlist', pl.id, pl.name) },
    { icon: 'pencil', label: 'Rename', async run() { const name = await prompt('Rename playlist', pl.name, { max: 120 }); name && api(`/playlists/${pl.id}`, { method: 'PATCH', body: { name } }).then(load, oops); } },
    { icon: 'download', label: 'Save all offline', run: () => saveAllOffline(tracks()) },
    '-',
    { icon: 'trash', label: 'Delete playlist', danger: true, async run() {
      if (!(await confirm(`Delete “${pl.name}”?`, 'Only the playlist goes. The songs stay in their projects.', 'Delete'))) return;
      if (await api(`/playlists/${pl.id}`, { method: 'DELETE' }).then(() => true, oops)) { setView({ type: 'home' }); load(); }
    } },
  ]);
}

// ---- admin: analytics ----------------------------------------------------------------------------
async function analyticsDialog() {
  const body = h('div', { className: 'stack' }, h('div', { className: 'muted' }, 'Adding it up…'));
  const d = dialog(h('div', { className: 'stack analytics' }, h('h2', {}, 'Analytics'), body,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg wide' });
  const a = await api('/admin/analytics').catch(e => (oops(e), null));
  if (!a) return d.close();
  const t = a.totals, n = x => Number(x || 0).toLocaleString();
  const tile = (label, value, sub) => h('div', { className: 'an-tile' }, h('span', { className: 'mono' }, label), h('b', { className: 'num' }, value), sub && h('small', {}, sub));
  const day = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // one series per chart, so one colour (the accent) and no legend; each bar says its day and number on hover / focus
  const bars = (title, days, unit) => {
    const max = Math.max(1, ...days.map(x => x.n)), total = days.reduce((s, x) => s + x.n, 0);
    return h('div', { className: 'an-chart' },
      h('div', { className: 'an-h' }, h('b', {}, title), h('span', { className: 'mono' }, `${n(total)} in 30 days`)),
      h('div', { className: 'an-bars', role: 'img', 'aria-label': `${title}: ${total} in the last 30 days` },
        days.map((x, i) => h('span', { className: 'an-bar' + (i < 4 ? ' l' : i > 25 ? ' r' : ''), tabIndex: 0, 'data-tip': `${day(x.day)} · ${x.n} ${x.n === 1 ? unit : unit + 's'}` },
          h('i', { className: x.n ? '' : 'zero', style: { height: (x.n / max) * 100 + '%' } })))),
      h('div', { className: 'an-axis mono' }, h('span', {}, day(days[0].day)), h('span', {}, 'today')));
  };
  fill(body,
    h('div', { className: 'an-tiles' },
      tile('[people]', n(t.users), `${n(t.new7)} new this week`),
      tile('[active · 7 days]', n(t.active7), `${n(t.active30)} in 30 days`),
      tile('[tracks]', n(t.tracks), `${n(t.projects)} projects`),
      tile('[storage]', fmtBytes(t.bytes), 'all versions, all accounts'),
      tile('[share links]', n(t.links), `${n(t.listens)} plays · ${n(t.comments)} comments`),
      tile('[plays · 30 days]', n(t.plays30), 'in the app'),
      tile('[to look at]', n(t.bugs + t.reports), `${n(t.bugs)} bug ${t.bugs === 1 ? 'report' : 'reports'} · ${n(t.reports)} link ${t.reports === 1 ? 'report' : 'reports'}`),
      tile('[playlists]', n(t.playlists))),
    bars('New accounts', a.signups, 'sign-up'),
    bars('Plays in the app', a.appPlays, 'play'),
    bars('Plays on share links', a.plays, 'play'),
    h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Most tracks'),
      h('div', { className: 'list' }, a.top.map(u => h('div', { className: 'item' }, avatarEl(u),
        h('span', { className: 'grow' }, nameOf(u), h('small', { className: 'muted' }, ` @${u.username}`)),
        h('small', { className: 'mono an-top' }, `${n(u.tracks)} tracks · ${fmtBytes(u.bytes)} · ${u.last_seen ? 'seen ' + fmtAdded(u.last_seen).toLowerCase() : 'not seen yet'}`))))),
    h('small', { className: 'muted' }, 'Active = opened [vault] (counted at most every 10 minutes). A play counts once a song has played for 10 seconds.'));
}

// ---- reported share links (admin) ----------------------------------------------------------------
// Open the link to see it, turn it off, turn off its owner's account, then mark the report done.
const REPORT_REASONS = { copyright: 'Copyright', harmful: 'Harmful or illegal', spam: 'Spam or scam', other: 'Something else' };
async function reportsDialog() {
  const list = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Reported links'), list,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg wide' });
  const patch = (r, body) => api(`/admin/reports/${r.id}`, { method: 'PATCH', body }).then(draw, oops);
  async function draw() {
    const rows = await api('/admin/reports').catch(e => (oops(e), []));
    fill(list, rows.length ? rows.map(r => {
      const done = r.status === 'done', gone = !r.kind;
      const canTurnOff = r.owner_id && r.owner_id !== 'owner' && (S.me.owner || !r.owner_admin);
      return h('div', { className: 'item bug' + (done ? ' fixed' : '') },
        h('div', { className: 'grow' },
          h('b', {}, REPORT_REASONS[r.reason] || r.reason), h('span', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, ` · ${fmtDate(r.created_at)}${done ? ' · done' : ''}`),
          h('div', { className: 'bug-text' }, gone ? 'That link has since been deleted.' : `${r.kind} “${r.target_name || '?'}” by ${r.owner_name || r.owner_username || '?'}${r.revoked ? ' · link is off' : ''}${r.owner_disabled ? ' · account is off' : ''}`),
          r.details && h('div', { className: 'bug-text muted' }, r.details),
          r.contact && h('small', { className: 'mono', style: { color: 'var(--fg-3)' } }, `contact: ${r.contact}`)),
        h('span', { className: 'btns', style: { margin: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } },
          !gone && h('a', { className: 'btn', href: `/s/${r.share_token}`, target: '_blank', rel: 'noopener' }, 'Open'),
          !gone && !r.revoked && h('button', { className: 'btn', onclick: () => patch(r, { revoke: true }) }, 'Turn link off'),
          !gone && canTurnOff && !r.owner_disabled && h('button', { className: 'btn danger', async onclick() {
            if (!(await confirm(`Turn off ${r.owner_name || r.owner_username}'s account?`, 'They are signed out and can\'t sign in or open their links until you turn it back on in People.', 'Turn off'))) return;
            await api(`/admin/users/${r.owner_id}`, { method: 'PATCH', body: { disabled: true } }).then(draw, oops);
          } }, 'Turn off account'),
          h('button', { className: 'btn ghost', onclick: () => patch(r, { status: done ? 'open' : 'done' }) }, done ? 'Reopen' : 'Done'),
          h('button', { className: 'icon-btn sm', 'aria-label': 'Delete report', onclick: () => api(`/admin/reports/${r.id}`, { method: 'DELETE' }).then(draw, oops) }, icon('trash', 15))));
    }) : h('div', { className: 'muted' }, 'No reports.'));
  }
  draw();
}

// ---- bug reports ------------------------------------------------------------------------------
// Report a bug: what happened, and (if they leave it ticked) the details that help track it down.
function bugDialog(error = '') {
  const text = h('textarea', { rows: 5, maxLength: 4000, required: true, placeholder: 'What happened, and what did you expect? Steps to make it happen again help a lot.' });
  const withInfo = h('input', { type: 'checkbox', className: 'toggle', checked: true, 'aria-label': 'Include details about this device' });
  const info = () => ({
    version: APP_VERSION, page: location.pathname + location.search, view: S.view?.type,
    browser: navigator.userAgent, app: nativeHaptics ? 'iPhone app' : matchMedia('(display-mode: standalone)').matches ? 'Home Screen web app' : 'browser',
    screen: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`, online: navigator.onLine, playing: cur?.name || null,
    errors: [...(error ? [`(reporting) ${error}`] : []), ...recentErrors],
  });
  const d = dialog(h('form', { className: 'stack', async onsubmit(e) {
    e.preventDefault();
    try {
      await api('/bugs', { method: 'POST', body: { text: text.value, info: withInfo.checked ? info() : null } });
      d.close(); toast('Thanks! Your report was sent.', { ms: 4000 });
    } catch (x) { oops(x); }
  } }, h('h2', {}, 'Report a bug'),
  error && h('div', { className: 'bug-err mono' }, error),
  h('label', {}, 'What went wrong', text),
  h('div', { className: 'set-row' }, h('div', { className: 't' }, 'Include device details', h('small', {}, 'App version, browser, screen size and the last few error messages. Nothing from your library.')), withInfo),
  h('div', { className: 'btns' }, h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'), h('button', { className: 'btn primary' }, 'Send report'))), { className: 'settings-dlg' });
  if (matchMedia('(pointer: fine)').matches) text.focus();
}
// Admin: the reports, open ones first. Mark them fixed, or delete them.
async function bugsDialog() {
  const list = h('div', { className: 'list' }, h('div', { className: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { className: 'stack' }, h('h2', {}, 'Bug reports'), list,
    h('div', { className: 'btns' }, h('button', { className: 'btn primary', onclick: () => d.close() }, 'Done'))), { className: 'settings-dlg wide' });
  async function draw() {
    const rows = await api('/admin/bugs').catch(e => (oops(e), []));
    fill(list, rows.length ? rows.map(r => {
      let info = null; try { info = JSON.parse(r.info || 'null'); } catch {}
      const fixed = r.status === 'fixed';
      return h('div', { className: 'item bug' + (fixed ? ' fixed' : '') },
        avatarEl(r),
        h('div', { className: 'grow' },
          h('b', {}, nameOf(r) || 'Deleted account'), h('span', { className: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px' } }, ` · ${fmtDate(r.created_at)}${fixed ? ' · fixed' : ''}`),
          h('div', { className: 'bug-text' }, r.text),
          info && h('details', {}, h('summary', { className: 'mono' }, 'device details'),
            h('pre', { className: 'bug-info' }, Object.entries(info).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? '\n  ' + v.join('\n  ') : v}`).join('\n')))),
        h('span', { className: 'btns', style: { margin: 0, flexWrap: 'nowrap' } },
          h('button', { className: 'btn', onclick: () => api(`/admin/bugs/${r.id}`, { method: 'PATCH', body: { status: fixed ? 'open' : 'fixed' } }).then(draw, oops) }, fixed ? 'Reopen' : 'Fixed'),
          h('button', { className: 'icon-btn sm', 'aria-label': 'Delete report', onclick: () => api(`/admin/bugs/${r.id}`, { method: 'DELETE' }).then(draw, oops) }, icon('trash', 15))));
    }) : h('div', { className: 'muted' }, 'No reports yet.'));
  }
  draw();
}

// ---- trash ----------------------------------------------------------------------------------
// Deleting for good happens a batch at a time on the server: keep asking while it says there's more.
async function untilDone(call) {
  for (let i = 0; i < 300; i++) if (!(await call()).more) return;
  throw new Error("That's taking a while. Try again in a minute; it carries on where it stopped.");
}
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
    const note = toast('Emptying the trash…', { ms: 0 });
    try { await untilDone(() => api('/trash/empty', { method: 'POST' })); toast('Trash emptied'); } catch (e) { oops(e); }
    note.remove(); load();
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
      const note = toast(`Deleting “${title}”…`, { ms: 0 });
      await untilDone(() => api(`/trash/${kind}/${id}`, { method: 'DELETE' })).catch(oops);
      note.remove(); load();
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
  const bulk = body => api('/tracks/bulk', { method: 'POST', body }).then(() => true, oops); // true when it went through
  // Star / throwaway the selection (or undo it if they all already are), with Undo putting each track back how it was.
  const markAct = (mark, ic, onLabel, offLabel) => {
    const already = n > 0 && picked().every(t => t.mark === mark), to = already ? null : mark;
    return act(ic, already ? offLabel : onLabel, async () => {
      const before = picked().map(t => [t.id, t.mark ?? null]);
      if (!(await bulk({ ids: before.map(([id]) => id), set: { mark: to } }))) return;
      const what = { star: ['Starred', 'Unstarred'], throw: ['Marked as throwaways:', 'No longer throwaways:'] }[mark][already ? 1 : 0];
      toast(`${what} ${n}`, { ms: 7000, action: { label: 'Undo', async run() {
        for (const m of ['star', 'throw', null]) {
          const ids = before.filter(([, x]) => x === m).map(([id]) => id);
          if (ids.length) await bulk({ ids, set: { mark: m } });
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
      if (!(await bulk({ ids: [...S.select], set: { project_id: to } }))) return;
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
      if (await bulk({ ids: [...S.select], set: { artist: name } })) done();
    }),
    act('gauge', 'Detect', () => detectTracks(picked(), true)),
    act('plus', 'Playlist', async () => { if (await addToPlaylist(picked())) done(); }),
    act('download', 'ZIP', () => zipTracks(picked(), 'Selected tracks')),
    act('trash', 'Delete', async () => {
      const ids = [...S.select];
      if (!(await bulk({ ids, trash: true }))) return;
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
function blankFilter() { return { bpmMin: '', bpmMax: '', key: '', mode: '', tag: '', throw: '', star: '', added: '' }; }
// Comments live on the server: a moment after typing stops, ask which tracks have a comment that matches.
let searchTimer = 0;
function searchComments() {
  clearTimeout(searchTimer);
  const q = S.q.trim();
  if (q.length < 2 || !S.online) { if (S.commentHits.size) { S.commentHits = new Map(); renderList(); } return; }
  searchTimer = setTimeout(async () => {
    const r = await api('/search?q=' + encodeURIComponent(q)).catch(() => null);
    if (!r || S.q.trim() !== q) return;
    S.commentHits = new Map(); for (const c of r.comments) if (!S.commentHits.has(c.track_id)) S.commentHits.set(c.track_id, c);
    renderList();
  }, 250);
}
// While searching: choose where to look.
const SEARCH_IN = [['all', 'Everything'], ['title', 'Titles'], ['notes', 'Notes'], ['tags', 'Tags'], ['producer', 'Producer'], ['comments', 'Comments']];
const searchChips = () => S.q.trim() && h('div', { className: 'chips-row search-in', role: 'radiogroup', 'aria-label': 'Search in' },
  h('span', { className: 'mono' }, '[search in]'),
  SEARCH_IN.map(([v, l]) => h('button', { className: 'chip' + (S.searchIn === v ? ' on' : ''), role: 'radio', 'aria-checked': S.searchIn === v, onclick() { S.searchIn = v; renderList(); } }, l)));
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
  const segs = (key, opts) => { const box = h('div', { className: 'seg-row', role: 'radiogroup' }); const draw = () => fill(box, opts.map(([v, l]) =>
    h('button', { type: 'button', className: 'btn' + (String(f[key]) === String(v) ? ' on' : ''), role: 'radio', 'aria-checked': String(f[key]) === String(v), onclick() { f[key] = v; draw(); } }, l))); draw(); return box; };
  const field = (label, el) => h('div', { className: 'field' }, h('span', { className: 'field-l' }, label), el);
  const d = dialog(h('form', { onsubmit(e) { e.preventDefault(); S.filter = f; d.close(); renderMain(); } },
    h('h2', {}, 'Filter'),
    h('div', { className: 'row2' }, h('label', {}, 'BPM from', num('bpmMin', '120')), h('label', {}, 'BPM to', num('bpmMax', '160'))),
    h('label', {}, 'Key', h('select', { onchange() { f.key = this.value; } }, h('option', { value: '' }, 'Any key'), KEYS.map(k => h('option', { value: k, selected: f.key === k }, k)))),
    field('Major / minor', mode),
    field('Starred', segs('star', [['', 'Any'], ['1', 'Starred only']])),
    field('Throwaways', thr),
    field('Added', segs('added', [['', 'Any time'], ['7', 'Past week'], ['30', 'Past month'], ['90', 'Past 3 months']])),
    allTags.length > 0 && h('label', {}, 'Tag', h('select', { onchange() { f.tag = this.value; } }, h('option', { value: '' }, 'Any tag'), allTags.map(t => h('option', { value: t, selected: f.tag === t }, t)))),
    h('div', { className: 'btns' },
      h('button', { type: 'button', className: 'btn ghost', style: { marginRight: 'auto' }, onclick() { S.filter = blankFilter(); d.close(); renderMain(); } }, 'Clear all'),
      h('button', { type: 'button', className: 'btn ghost', onclick: () => d.close() }, 'Cancel'),
      h('button', { className: 'btn primary' }, 'Apply'))));
}

// ---- ZIP downloads and full backups ------------------------------------------------------------
const extOf = (t, blob) => (/\.[a-z0-9]{2,5}$/i.test(t.file_key || '') ? t.file_key.split('.').pop() : extForType(blob?.type) || 'mp3');
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
      const data = await audioBlob(t);
      entries.push({ name: unique(`${String(i + 1).padStart(2, '0')} ${safeName(t.name)}.${extOf(t, data)}`), data });
    }
    if (cover) { const b = await coverBlob(cover).catch(() => null); if (b) entries.push({ name: 'cover.jpg', data: b }); }
    entries.push({ name: 'tracks.json', data: JSON.stringify(list.map(trackMeta), null, 2) });
    note.textContent = 'Building ZIP…';
    saveBlob(await makeZip(entries), `${safeName(name)}.zip`);
  } catch (e) { oops(e); }
  note.remove();
}
// Writes the whole library into a folder you pick (folders → projects → files). Chrome/Edge on a computer.
// Moves the files still on Backblaze into Google Drive, one per request, until none are left (or something stops it).
async function moveToDrive() {
  let st;
  try { st = await api('/move-to-drive'); } catch (e) { return oops(e); }
  if (!st.ready) return toast('Connect Google Drive first: Settings → Account → Google Drive → Connect.', { ms: 8000 });
  if (!st.left) return toast('Everything is already in Google Drive.');
  if (!(await confirm('Move to Google Drive?', `${st.left} files (songs, every version, and covers) get copied into your Google Drive. Keep this tab open while it runs; if it stops, press Move again and it carries on where it left off. The copies on Backblaze aren't deleted.`, 'Move'))) return;
  const total = st.left, note = toast('', { ms: 0 });
  let left = total;
  try {
    while (left > 0) {
      note.textContent = `Moving to Google Drive: ${total - left + 1} of ${total}… (keep this tab open)`;
      left = (await api('/move-to-drive', { method: 'POST' })).left;
    }
    note.remove();
    toast(`Done: all ${total} files are in Google Drive.`, { ms: 8000 });
  } catch (e) {
    note.remove();
    toast(`${e.message} (${total - left} of ${total} moved so far)`, { error: true, ms: 15000 });
  }
  load();
}
// A stored file read like a local one (only the parts asked for are fetched), so readTags works on it.
const remoteFile = t => ({
  size: t.size,
  slice: (a, b) => ({
    arrayBuffer: async () => {
      const end = Math.min(b, t.size);
      if (a >= end) return new ArrayBuffer(0);
      const ctl = new AbortController(), r = await fetch(`/api/audio/${t.id}`, { headers: { Range: `bytes=${a}-${end - 1}` }, signal: ctl.signal });
      if (r.status !== 206) { ctl.abort(); throw new Error(`Couldn't read the file (${r.status})`); } // never pull a whole file for its tags
      return r.arrayBuffer();
    },
  }),
});
// Every track of yours: track numbers off the names (positions don't change, so the order stays), "prod. X" out of
// the name into a tag, and the artist and producer from the file's own tags where it has them.
async function tidyTracks() {
  const mine = new Set(S.projects.map(p => p.id)), tracks = S.tracks.filter(t => mine.has(t.project_id));
  if (!tracks.length) return toast('No tracks to tidy yet.');
  if (!(await confirm('Tidy up track info?', `Goes through your ${tracks.length} tracks. Names lose their track numbers (“01 Song” → “Song”, same order) and any “prod. X” (it becomes a tag). The producer / artist and disc number are filled in from each file's own info where it has them (“1-01 Song” is disc 1).`, 'Tidy up'))) return;
  const nums = new Map([...mine].map(id => [id, leadNumbers(tracks.filter(t => t.project_id === id).map(t => t.name))]));
  const note = toast('', { ms: 0 });
  let done = 0, changed = 0, failed = 0;
  const one = async t => {
    const tags = /\.(mp3|m4a|mp4|aac|flac)$/i.test(t.file_key || '') ? await readTags(remoteFile(t)) : {};
    const n = cleanTitle(t.name, tags.artist || t.artist, nums.get(t.project_id)), prod = n.prod || tags.producer, body = {};
    if (n.title !== t.name) body.name = n.title;
    if (tags.artist && !(t.artist || '').toLowerCase().includes(tags.artist.toLowerCase())) body.artist = tags.artist.slice(0, 120);
    const disc = n.disc ?? tags.disc;
    if (disc && disc !== t.disc) body.disc = disc;
    if (prod && !tagsOf(t).some(x => /^prod\./i.test(x))) body.tags = [...tagsOf(t), `prod. ${prod}`].join(', ');
    if (Object.keys(body).length) { await api(`/tracks/${t.id}`, { method: 'PATCH', body }); Object.assign(t, body); changed++; }
  };
  const queue = [...tracks];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let t; (t = queue.shift());) {
      try { await one(t); } catch (e) { if (e.message === 'Not logged in') throw e; failed++; }
      note.textContent = `Tidying ${++done} of ${tracks.length}…`;
    }
  })).catch(oops);
  note.remove();
  renderMain();
  toast(`Tidied ${changed} track${changed === 1 ? '' : 's'}${failed ? ` (${failed} couldn't be read — run it again to retry)` : ''}.`, { ms: 8000, error: failed > 0 });
}
async function backupAll() {
  if (!window.showDirectoryPicker) return toast('Full backup needs Chrome or Edge on a computer. On this device, use ⋯ → Export as ZIP on each project.', { ms: 9000 });
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
        try {
          const data = await audioBlob(t);
          let fname = `${String(i + 1).padStart(2, '0')} ${safeName(t.name)}.${extOf(t, data)}`;
          while (used.has(fname.toLowerCase())) fname = fname.replace(/(\.[^.]+)$/, ' (2)$1');
          used.add(fname.toLowerCase());
          await write(dir, fname, data);
        } catch { failed++; }
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

// ---- storage manager: what your storage is made of, and the quickest ways to free some ----
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
  for (const t of S.tracks) { const x = /\.[a-z0-9]{2,5}$/i.test(t.file_key) ? t.file_key.split('.').pop().toUpperCase() : 'Audio'; fmt[x] = (fmt[x] || 0) + (t.size || 0); }
  const formats = Object.entries(fmt).sort((x, y) => y[1] - x[1]);
  const top = Math.max(1, ...s.projects.map(p => p.size)), topT = Math.max(1, ...s.tracks.map(t => t.size));
  const seg = (cls, v, label) => v > 0 && h('i', { className: 'seg-' + cls, style: { width: pc(v) + '%' }, title: `${label}: ${fmtBytes(v)}` });
  const line = (cls, label, v, sub, action) => h('div', { className: 'st-line' },
    h('span', { className: 'dot seg-' + cls }), h('div', { className: 't' }, label, sub && h('small', {}, sub)), h('span', { className: 'num st-v' }, fmtBytes(v)), action || h('span'));
  fill(body,
    h('div', { className: 'st-total' }, h('b', { className: 'num' }, fmtBytes(used)), h('span', { className: 'muted' }, s.drive
      ? ` in [vault] · ${fmtBytes(Math.max(0, s.limit - s.used))} free in your Google Drive` // Drive's space is shared with your other Drive files
      : ` of ${fmtBytes(s.limit)} · ${fmtBytes(Math.max(0, s.limit - used))} free`)),
    h('div', { className: 'st-bar', role: 'img', 'aria-label': `${Math.round(pc(used))}% used` }, seg('cur', s.current, 'Your tracks'), seg('old', s.old, 'Old versions'), seg('trash', s.trash, 'Recently deleted')),
    h('div', { className: 'st-lines' },
      line('cur', 'Your tracks', s.current, formats.map(([x, v]) => `${x} ${fmtBytes(v)}`).join(' · ')),
      line('old', 'Old versions', s.old, 'Earlier versions kept from edits', s.old > 0 && h('button', { className: 'btn', onclick: async () => { if (await cleanVersions()) draw(); } }, 'Delete')),
      line('trash', 'Recently deleted', s.trash, 'Goes for good after 30 days', s.trash > 0 && h('button', { className: 'btn', async onclick() {
        if (!(await confirm('Empty Recently deleted?', 'Everything in it is deleted for good.', 'Empty'))) return;
        const note = toast('Emptying…', { ms: 0 });
        try { await untilDone(() => api('/trash/empty', { method: 'POST' })); toast(`Freed ${fmtBytes(s.trash)}`); } catch (e) { oops(e); }
        note.remove(); await load(); draw();
      } }, 'Empty')),
      line('dev', 'Kept on this device', keptBytes(), 'Played songs, so they don\'t download again; not counted in your storage', keptBytes() > 0 && h('button', { className: 'btn', async onclick() {
        await caches.delete(KEPT); store.set('played', {}); toast('Cleared. Songs will download again the next time they play.'); draw();
      } }, 'Clear')),
      line('dev', 'Downloaded on this device', device, 'Offline copies; not counted in your storage', device > 0 && h('button', { className: 'btn', async onclick() {
        await caches.delete('audio'); S.offline.clear(); store.set('offline', []); render(); toast('Downloads removed from this device'); draw();
      } }, 'Remove'))),
    s.projects.length > 0 && h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Biggest projects'),
      h('div', { className: 'st-list' }, s.projects.slice(0, 12).map(p => h('button', { className: 'st-item', onclick: () => { d.close(); setView({ type: 'project', id: p.id }); } },
        h('span', { className: 'grow' }, p.name, h('small', {}, `${p.tracks} ${p.tracks === 1 ? 'track' : 'tracks'}`)),
        h('span', { className: 'st-mini' }, h('i', { style: { width: (p.size / top) * 100 + '%' } })), h('span', { className: 'num st-v' }, fmtBytes(p.size)))))),
    s.tracks.length > 0 && h('div', { className: 'field' }, h('span', { className: 'field-l' }, 'Biggest tracks'),
      h('div', { className: 'st-list' }, s.tracks.slice(0, 15).map(t => h('div', { className: 'st-item' },
        h('button', { className: 'grow st-open', onclick: () => { const x = trackOf(t.id); if (!x) return; detailsDialog(x); [...document.querySelectorAll('dialog')].pop().addEventListener('close', () => draw()); } }, t.name,
          h('small', {}, [projectOf(t.project_id)?.name, /\.[a-z0-9]{2,5}$/i.test(t.file_key) && t.file_key.split('.').pop().toUpperCase(), t.versions > 1 && `${t.versions} versions`].filter(Boolean).join(' · '))),
        h('span', { className: 'st-mini' }, h('i', { style: { width: (t.size / topT) * 100 + '%' } })), h('span', { className: 'num st-v' }, fmtBytes(t.size)),
        h('button', { className: 'icon-btn sm', 'aria-label': `Move ${t.name} to the trash`, title: 'Move to trash', async onclick() {
          if (!(await api(`/tracks/${t.id}`, { method: 'DELETE' }).then(() => true, oops))) return;
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

// Touching the cover in the full-screen player: it tips toward your finger and sinks in, a light follows the finger,
// and letting go springs it back with a ripple from where you touched.
const artPress = (() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const at = (el, e) => { const r = el.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; };
  const tilt = (x, y, deg) => `${(0.5 - y).toFixed(3)} ${(x - 0.5).toFixed(3)} 0 ${deg}deg`;
  let down = null;
  const release = function (e) {
    if (!down) return;
    const { x, y } = down; down = null;
    this.classList.remove('pressing');
    this.getAnimations().forEach(a => a.id === 'press' && a.cancel()); // the release spring takes over from the pressed pose
    if (reduce.matches) return;
    this.animate([{ scale: '.94', rotate: tilt(x, y, 9) }, { scale: '1.035', rotate: tilt(x, y, -3), offset: 0.45 }, { scale: '.995', rotate: tilt(x, y, 1), offset: 0.75 }, { scale: '1', rotate: tilt(x, y, 0) }],
      { duration: 620, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (e.type !== 'pointerup') return;
    const r = this.getBoundingClientRect(), size = Math.hypot(r.width, r.height) * 2;
    const ring = h('span', { className: 'fp-ripple', style: { left: `${x * 100}%`, top: `${y * 100}%`, width: `${size}px`, height: `${size}px` } });
    this.append(ring);
    ring.addEventListener('animationend', () => ring.remove());
  };
  return {
    onpointerdown(e) {
      const { x, y } = at(this, e);
      down = { x, y };
      this.style.setProperty('--mx', `${x * 100}%`); this.style.setProperty('--my', `${y * 100}%`);
      this.classList.add('pressing');
      haptic();
      if (!reduce.matches) this.animate([{ scale: '1', rotate: tilt(x, y, 0) }, { scale: '.94', rotate: tilt(x, y, 9) }], { duration: 160, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards', id: 'press' });
    },
    onpointermove(e) {
      if (!down) return;
      const { x, y } = at(this, e);
      down = { x, y };
      this.style.setProperty('--mx', `${x * 100}%`); this.style.setProperty('--my', `${y * 100}%`);
    },
    onpointerup: release, onpointercancel: release, onpointerleave: release,
  };
})();
// ---- swipe gestures (touch) ----
// Haptic tick: vibrate() on Android; on iPhone (Safari 18+) tapping a hidden "switch" gives a light tap.
// Haptic tap. Android: vibrate(). iPhone (iOS 18+): Safari taps when a "switch" checkbox flips, so a hidden one is made
// and flipped. iPhones only allow that straight after a tap or a release (not mid-swipe), so on iPhone it's used on release.
// ponytail: the iPhone part relies on Safari behaviour, not an official API; Apple could change it.
// In the [vault] iPhone app (ios-app/), haptics go to the native vibration engine instead, which works any time.
const nativeHaptics = window.webkit?.messageHandlers?.haptic;
const canVibrate = !!nativeHaptics || typeof navigator.vibrate === 'function';
let lastHaptic = 0, inHaptic = false;
export function haptic(style = 'light') {
  if (performance.now() - lastHaptic < 60) return; // one tap, one tick
  lastHaptic = performance.now();
  try {
    if (nativeHaptics) return void nativeHaptics.postMessage(style);
    if (canVibrate) return void navigator.vibrate(8);
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('switch', ''); label.append(input);
    label.setAttribute('aria-hidden', 'true'); label.style.display = 'none';
    // inside the open pop-up when there is one: everything outside a pop-up is switched off, and wouldn't tick
    const open = [...document.querySelectorAll('dialog[open]')].pop();
    inHaptic = true;
    (open || document.body).append(label); label.click(); label.remove();
  } catch {} finally { inHaptic = false; }
}
// Every tap on something tappable gives a light tick on phones (buttons, tracks, menu items, switches, links).
document.addEventListener('click', e => {
  if (inHaptic || !e.isTrusted || !matchMedia('(pointer: coarse)').matches) return;
  if (e.target.closest?.('button, [role=button], [role=tab], [role=radio], a, select, summary, input[type=checkbox], input[type=range], .trow[data-id], .nav, .card, .tcard')) haptic();
}, true);
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
  if (inHaptic || !document.body.classList.contains('side-open') || e.target.closest('#side, #menu-btn, dialog, #toasts')) return;
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
// The library saved from last time shows at once and is replaced by the fresh one when it arrives.
// The very first time there's nothing saved, so it says it's loading instead of showing an empty page.
S.view = viewFromHash(); // the page you were on (refreshing keeps it)
const last = store.get('tree');
if (last?.me) { applyTree(last); render(); }
else fill($('#main'), h('div', { className: 'empty boot' }, h('span', { className: 'disc' }), h('b', {}, 'Loading your library…')));
load();
