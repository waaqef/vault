import { AwsClient } from 'aws4fetch';
import { MAX, STORAGE_LIMIT, kindOf, ext, contentType, sniff } from './public/types.js';
import { parseName } from './public/detect.js';
import { sharePage } from './share-page.js';
import { encryptPush, vapidHeader, makeVapidKeys } from './push.js';
import * as drive from './drive.js';

const json = (d, status = 200, headers = {}) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (error, status = 400) => json({ error }, status);
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const DAY = 864e5;
const TRASH_DAYS = 30;
const OWNER = 'owner'; // the admin account (the original single owner); everything that existed before accounts is theirs

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const cookie = (req, name) =>
  (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='))?.slice(name.length + 1);
const same = (a = '', b = '') => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const setCookie = (name, value, path, maxAge) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const clientIp = req => req.headers.get('cf-connecting-ip') || 'local';

// ---- small key/value settings stored in the database (admin password, admin session, push keys) ----
const getConfig = async (env, key) => (await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first())?.value ?? null;
const setConfig = (env, key, value) =>
  value === null
    ? env.DB.prepare('DELETE FROM config WHERE key = ?').bind(key).run()
    : env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();

// ---- accounts ----------------------------------------------------------------
// The admin's password: the one set in Settings (salted, keyed with the server secret), or APP_PASSWORD until then.
async function adminPasswordOk(env, pw) {
  const saved = await getConfig(env, 'password');
  if (saved) { const { salt, hash } = JSON.parse(saved); return same(await hmac(env.APP_PASSWORD, `pw:${salt}:${pw}`), hash); }
  return same(await hmac('login', pw || ''), await hmac('login', env.APP_PASSWORD));
}
const passHash = (env, salt, pw) => hmac(env.APP_PASSWORD, `pw:${salt}:${pw}`);
// The pre-accounts login cookie, still honoured so the admin isn't logged out by the upgrade.
async function legacyOwnerToken(env) {
  const session = await getConfig(env, 'session');
  return hmac(env.APP_PASSWORD, session ? `owner:${session}` : 'owner');
}
// Login cookie: "<user id>.<signature>". The signature includes the user's session id, so changing a password
// (which changes the session) logs out their other devices.
async function sessionOf(env, user) {
  return user.id === OWNER ? (await getConfig(env, 'session')) || '' : user.session || '';
}
const authCookie = async (env, user) =>
  setCookie('auth', `${user.id}.${await hmac(env.APP_PASSWORD, `user:${user.id}:${await sessionOf(env, user)}`)}`, '/', 365 * 86400);
const getUser = (env, id) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
async function userFromCookie(req, env) {
  const c = cookie(req, 'auth') || '';
  const dot = c.indexOf('.');
  if (dot > 0) {
    const user = await getUser(env, c.slice(0, dot));
    if (!user || user.disabled) return null;
    const want = await hmac(env.APP_PASSWORD, `user:${user.id}:${await sessionOf(env, user)}`);
    return same(c.slice(dot + 1), want) ? user : null;
  }
  return c && same(c, await legacyOwnerToken(env)) ? getUser(env, OWNER) : null;
}
const USERNAME_RE = /^[a-z0-9._-]{3,24}$/;
const publicUser = (u, extra = {}) => ({ id: u.id, username: u.username, avatar: u.avatar || null, isAdmin: !!u.is_admin,
  storage: u.storage, driveConnected: !!u.drive_refresh, ...extra });
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{20,200000}$/;

// ---- lockout after repeated wrong passwords/keys: 5 tries per 15 minutes per address ----
const LOCK_TRIES = 5, LOCK_MS = 15 * 60 * 1000;
async function lockedFor(env, key) {
  const r = await env.DB.prepare('SELECT count, first_at FROM login_attempts WHERE key = ?').bind(key).first();
  if (!r || now() - r.first_at > LOCK_MS || r.count < LOCK_TRIES) return 0;
  return Math.ceil((LOCK_MS - (now() - r.first_at)) / 1000);
}
async function recordFail(env, key) {
  const r = await env.DB.prepare('SELECT first_at FROM login_attempts WHERE key = ?').bind(key).first();
  if (!r || now() - r.first_at > LOCK_MS) await env.DB.prepare('INSERT OR REPLACE INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)').bind(key, now()).run();
  else await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE key = ?').bind(key).run();
}
const clearFails = (env, key) => env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
const lockMessage = secs => `Too many wrong attempts. Try again in ${Math.ceil(secs / 60)} min.`;

// ---- file storage -------------------------------------------------------
// The admin's files: Backblaze B2 (S3 API). Invited users' files: their own Google Drive (drive.js).
// Local dev (`npm run dev:local`): everyone uses a simulated R2 bucket behind /blob/*.
const s3 = env => new AwsClient({ accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY, service: 's3', region: env.B2_REGION });
const objUrl = (env, key) => `${env.B2_ENDPOINT}/${env.B2_BUCKET}/${key}`;
const KEY_RE = /^(audio|cover)\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
const validKey = k => KEY_RE.test(k) || drive.DRIVE_KEY_RE.test(k);
const keyKind = k => (drive.isDriveKey(k) ? drive.driveKind(k) : k.split('/')[0]);
const usesDrive = (env, user) => !env.LOCAL && user.storage === 'drive';

async function presign(env, key, method, headers = {}) {
  if (env.LOCAL) return `/blob/${key}`;
  const u = new URL(objUrl(env, key));
  u.searchParams.set('X-Amz-Expires', '7200');
  // Sign at the top of the hour so the URL stays the same for an hour.
  const datetime = new Date().toISOString().slice(0, 13).replace(/-/g, '') + '0000Z';
  // allHeaders signs Content-Type too, so B2 refuses an upload whose type doesn't match what we approved.
  return (await s3(env).sign(u.toString(), { method, headers, aws: { signQuery: true, datetime, allHeaders: true } })).url;
}
// Fetch a file's bytes from wherever it lives (Range passes through).
async function getObject(env, req, key, owner) {
  const range = req?.headers.get('range');
  if (drive.isDriveKey(key)) return drive.fetchFile(env, owner, key, range);
  if (env.LOCAL) return localBlob(req || new Request('http://x/'), env, key);
  return s3(env).fetch(objUrl(env, key), { headers: range ? { Range: range } : {} });
}
async function firstBytes(env, key, owner) {
  if (drive.isDriveKey(key)) {
    const info = await drive.fileInfo(env, owner, key);
    if (!info) return null;
    const r = await drive.fetchFile(env, owner, key, 'bytes=0-15');
    return r.ok ? { size: +info.size, bytes: new Uint8Array(await r.arrayBuffer()) } : null;
  }
  if (env.LOCAL) {
    const o = await env.LOCAL.get(key, { range: { offset: 0, length: 16 } });
    return o && { size: o.size, bytes: new Uint8Array(await o.arrayBuffer()) };
  }
  const r = await s3(env).fetch(objUrl(env, key), { headers: { Range: 'bytes=0-15' } });
  if (!r.ok) return null;
  return { size: Number((r.headers.get('content-range') || '').split('/')[1]), bytes: new Uint8Array(await r.arrayBuffer()) };
}
async function remove(env, key, owner) {
  if (!key) return;
  if (drive.isDriveKey(key)) return owner ? drive.deleteFile(env, owner, key).catch(() => ({ ok: false })) : { ok: false };
  return env.LOCAL ? env.LOCAL.delete(key) : s3(env).fetch(objUrl(env, key), { method: 'DELETE' });
}

// After a file is uploaded, read it back and check it really is what it claims.
async function verify(env, key, kind, owner) {
  if (!validKey(key) || keyKind(key) !== kind) throw userError('Bad file key');
  if (drive.isDriveKey(key) !== usesDrive(env, owner)) throw userError('Bad file key');
  const got = await firstBytes(env, key, owner);
  if (!got) throw userError('Upload not found — try again');
  if (sniff(got.bytes) !== kind || !(got.size <= MAX[kind])) {
    await remove(env, key, owner);
    throw userError(kind === 'audio' ? "That file isn't real audio, so it was deleted" : "That file isn't a real image, so it was deleted");
  }
  return got.size;
}

// Waveform: ~100 bars, one base64 character (0–63) each.
const PEAKS_RE = /^[A-Za-z0-9+/]{16,400}$/;
const peaksOrNull = p => (typeof p === 'string' && PEAKS_RE.test(p) ? p : null);
const fmtAt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const userError = message => Object.assign(new Error(message), { status: 400 });

// ---- ownership: every query is limited to the signed-in user's own things ----
const MY_PROJECTS = '(SELECT id FROM projects WHERE owner_id = ?)';
const ownProject = (env, u, id) => env.DB.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
const ownFolder = (env, u, id) => env.DB.prepare('SELECT * FROM folders WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
const ownTrack = (env, u, id) => env.DB.prepare(`SELECT * FROM tracks WHERE id = ? AND project_id IN ${MY_PROJECTS}`).bind(id, u.id).first();
// Shared projects. EDITABLE: your own, and ones you were added to as an editor. READABLE: also ones you were
// added to as a viewer, and ones saved to your library from a share link that still works (a linked copy).
// Files always live in the project owner's storage, whoever adds them.
const EDITABLE = `(SELECT id FROM projects WHERE owner_id = ? UNION SELECT project_id FROM project_members WHERE user_id = ? AND role = 'editor')`;
const editArgs = u => [u.id, u.id];
const LINKED = kind => `(SELECT s.target_id FROM saved_shares v JOIN shares s ON s.token = v.token WHERE v.user_id = ? AND s.kind = '${kind}' AND s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?))`;
const READABLE = `(SELECT id FROM projects WHERE owner_id = ? UNION SELECT project_id FROM project_members WHERE user_id = ? UNION ${LINKED('project').slice(1, -1)})`;
const readArgs = u => [u.id, u.id, u.id, now()];
const editProject = (env, u, id) => env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL AND id IN ${EDITABLE}`).bind(id, ...editArgs(u)).first();
const editTrack = (env, u, id) => env.DB.prepare(`SELECT t.*, p.owner_id FROM tracks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.project_id IN ${EDITABLE}`).bind(id, ...editArgs(u)).first();
const readTrack = (env, u, id) => env.DB.prepare(`SELECT t.*, p.owner_id FROM tracks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND (t.project_id IN ${READABLE} OR t.id IN ${LINKED('track')})`).bind(id, ...readArgs(u), u.id, now()).first();
// The account whose storage holds a project's files.
const storeOf = (env, ownerId, u) => (ownerId === u.id ? u : getUser(env, ownerId));
// Who owns a project / track (for deletes and share pages).
const projectOwner = async (env, projectId) => {
  const p = await env.DB.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(projectId).first();
  return p && getUser(env, p.owner_id);
};
// Storage used by this user, counted from the database (versions and trash included).
const usage = async (env, u) => (await env.DB.prepare(`SELECT COALESCE(SUM(v.size), 0) AS n FROM track_versions v JOIN tracks t ON t.id = v.track_id WHERE t.project_id IN ${MY_PROJECTS}`).bind(u.id).first()).n;
const adminUsage = async env => (await env.DB.prepare(`SELECT COALESCE(SUM(v.size), 0) AS n FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = p.owner_id WHERE u.storage = 'b2'`).first()).n;
// The space this user has: Drive users get their Drive's own quota; the admin gets the 10 GB Backblaze bucket.
async function space(env, u) {
  if (usesDrive(env, u)) {
    const q = u.drive_refresh ? await drive.quota(env, u).catch(() => null) : null;
    return { usage: q ? q.used : 0, limit: q ? q.limit : 15e9, email: q?.email || '' };
  }
  return { usage: u.storage === 'b2' ? await adminUsage(env) : await usage(env, u), limit: STORAGE_LIMIT };
}

// ---- routing --------------------------------------------------------------
const routes = [];
const on = (method, path, fn) =>
  routes.push([method, new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn]);

async function update(env, table, id, body, fields) {
  const keys = Object.keys(body).filter(k => fields.includes(k));
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map(k => body[k] ?? null), id).run();
}

// ---- permanent deletes (used by the trash) ----
async function deleteTrack(env, id) {
  const t = await env.DB.prepare('SELECT cover, project_id FROM tracks WHERE id = ?').bind(id).first();
  if (!t) return;
  const owner = await projectOwner(env, t.project_id);
  const { results: vs } = await env.DB.prepare('SELECT file_key FROM track_versions WHERE track_id = ?').bind(id).all();
  await Promise.all([...vs.map(v => remove(env, v.file_key, owner)), remove(env, t.cover, owner)]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM track_versions WHERE track_id = ?').bind(id),
    env.DB.prepare('DELETE FROM comments WHERE track_id = ?').bind(id),
    env.DB.prepare("DELETE FROM shares WHERE kind = 'track' AND target_id = ?").bind(id),
    env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(id),
  ]);
}
async function deleteProject(env, id) {
  const p = await env.DB.prepare('SELECT cover, owner_id FROM projects WHERE id = ?').bind(id).first();
  if (!p) return;
  const { results: tracks } = await env.DB.prepare('SELECT id FROM tracks WHERE project_id = ?').bind(id).all();
  for (const t of tracks) await deleteTrack(env, t.id);
  await remove(env, p.cover, await getUser(env, p.owner_id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shares WHERE kind = 'project' AND target_id = ?").bind(id),
    env.DB.prepare('DELETE FROM project_members WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
}
// Anything in the trash longer than 30 days goes for good (a few at a time, whenever a library loads).
async function purgeOldTrash(env) {
  const cutoff = now() - TRASH_DAYS * DAY;
  const [p, t] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM projects WHERE deleted_at < ? LIMIT 5').bind(cutoff),
    env.DB.prepare('SELECT id FROM tracks WHERE deleted_at < ? LIMIT 10').bind(cutoff),
  ]);
  for (const r of p.results) await deleteProject(env, r.id);
  for (const r of t.results) await deleteTrack(env, r.id);
}

// Projects shared with this user (added as a viewer/editor, or saved from a link), and single saved tracks.
const SHARED_P = `SELECT p.id, p.name, p.cover, p.created_at, u.username AS owner,
    COALESCE((SELECT role FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?), 'viewer') AS role,
    EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?) AS member
  FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.deleted_at IS NULL AND p.owner_id != ? AND p.id IN ${READABLE} ORDER BY p.name COLLATE NOCASE`;
const SHARED_T = `SELECT * FROM tracks WHERE deleted_at IS NULL AND project_id IN (SELECT p.id FROM projects p WHERE p.deleted_at IS NULL AND p.owner_id != ? AND p.id IN ${READABLE}) ORDER BY position, created_at`;
const SAVED_T = `SELECT t.*, u.username AS owner, p.cover AS project_cover FROM tracks t JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = p.owner_id
  WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_id != ? AND t.id IN ${LINKED('track')} AND t.project_id NOT IN ${READABLE}`;

const liveTracks = `deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND owner_id = ?)`;

on('GET', '/api/tree', async (req, env, b, p, url, ctx, u) => {
  ctx?.waitUntil?.(purgeOldTrash(env).catch(() => {}));
  const [f, pr, t, tr, cm] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM folders WHERE owner_id = ? ORDER BY name COLLATE NOCASE').bind(u.id),
    env.DB.prepare('SELECT * FROM projects WHERE deleted_at IS NULL AND owner_id = ? ORDER BY name COLLATE NOCASE').bind(u.id),
    env.DB.prepare(`SELECT * FROM tracks WHERE ${liveTracks} ORDER BY position, created_at`).bind(u.id),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM projects WHERE deleted_at IS NOT NULL AND owner_id = ?) + (SELECT COUNT(*) FROM tracks WHERE deleted_at IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND owner_id = ?)) AS n`).bind(u.id, u.id),
    env.DB.prepare(`SELECT track_id, COUNT(*) AS n FROM comments WHERE track_id IN (SELECT id FROM tracks WHERE project_id IN ${MY_PROJECTS}) GROUP BY track_id`).bind(u.id),
  ]);
  const comments = Object.fromEntries(cm.results.map(r => [r.track_id, r.n]));
  const s = await space(env, u);
  const [sp, st, sv] = await env.DB.batch([
    env.DB.prepare(SHARED_P).bind(u.id, u.id, u.id, ...readArgs(u)),
    env.DB.prepare(SHARED_T).bind(u.id, ...readArgs(u)),
    env.DB.prepare(SAVED_T).bind(u.id, u.id, now(), ...readArgs(u)),
  ]);
  return json({ folders: f.results, projects: pr.results, tracks: t.results, comments, trash: tr.results[0].n,
    shared: { projects: sp.results, tracks: st.results, singles: sv.results },
    usage: s.usage, limit: s.limit, me: publicUser(u, { driveEmail: s.email || '', needsDrive: usesDrive(env, u) && !u.drive_refresh }) });
});

// Folders
on('POST', '/api/folders', async (req, env, b, p, url, ctx, u) => {
  if (b.parent_id && !(await ownFolder(env, u, b.parent_id))) return fail('Folder not found', 404);
  const id = uid();
  await env.DB.prepare('INSERT INTO folders (id, name, parent_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, (b.name || 'New folder').slice(0, 200), b.parent_id || null, u.id, now()).run();
  return json({ id });
});
on('PATCH', '/api/folders/:id', async (req, env, b, { id }, url, ctx, u) => {
  if (!(await ownFolder(env, u, id))) return fail('Not found', 404);
  if (b.parent_id) {
    if (!(await ownFolder(env, u, b.parent_id))) return fail('Folder not found', 404);
    // Refuse to move a folder inside itself.
    for (let p = b.parent_id; p; p = (await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(p).first())?.parent_id)
      if (p === id) return fail("Can't move a folder inside itself");
  }
  if ('icon' in b) b.icon = typeof b.icon === 'string' && b.icon.trim() ? b.icon.trim().slice(0, 16) : null;
  if ('color' in b) b.color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null;
  await update(env, 'folders', id, b, ['name', 'parent_id', 'icon', 'color']);
  return json({ ok: true });
});
on('DELETE', '/api/folders/:id', async (req, env, b, { id }, url, ctx, u) => {
  // Contents move up a level; nothing is deleted with the folder.
  const f = await ownFolder(env, u, id);
  if (!f) return fail('Not found', 404);
  await env.DB.batch([
    env.DB.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ? AND owner_id = ?').bind(f.parent_id, id, u.id),
    env.DB.prepare('UPDATE projects SET folder_id = ? WHERE folder_id = ? AND owner_id = ?').bind(f.parent_id, id, u.id),
    env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
});

// Projects
on('POST', '/api/projects', async (req, env, b, p, url, ctx, u) => {
  if (b.folder_id && !(await ownFolder(env, u, b.folder_id))) return fail('Folder not found', 404);
  const id = uid();
  await env.DB.prepare('INSERT INTO projects (id, name, folder_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, (b.name || 'Untitled project').slice(0, 200), b.folder_id || null, u.id, now()).run();
  return json({ id });
});
on('PATCH', '/api/projects/:id', async (req, env, b, { id }, url, ctx, u) => {
  const old = await editProject(env, u, id);
  if (!old) return fail('Not found', 404);
  if (old.owner_id !== u.id) delete b.folder_id; // folders are the owner's own
  if (b.folder_id && !(await ownFolder(env, u, b.folder_id))) return fail('Folder not found', 404);
  const owner = await storeOf(env, old.owner_id, u);
  if (b.cover) await verify(env, b.cover, 'cover', owner);
  await update(env, 'projects', id, b, ['name', 'folder_id', 'cover']);
  if ('cover' in b && old.cover && old.cover !== b.cover) await remove(env, old.cover, owner);
  return json({ ok: true });
});
// Deleting moves it to the trash; it's removed for good after 30 days or when emptied.
on('DELETE', '/api/projects/:id', async (req, env, b, { id }, url, ctx, u) => {
  await env.DB.prepare('UPDATE projects SET deleted_at = ? WHERE id = ? AND owner_id = ?').bind(now(), id, u.id).run();
  return json({ ok: true });
});

// Uploads: the browser asks where to upload, uploads straight to storage, then registers the file.
// Backblaze: a signed URL (the key is chosen here). Google Drive: a resumable upload session; Drive picks the
// file id, which the browser reads from the upload's reply and sends back as drive:<kind>:<id>.
on('POST', '/api/upload-url', async (req, env, b, p, url, ctx, u) => {
  const kind = kindOf(b.name);
  if (!kind) return fail(`${b.name} isn't an audio file or cover image`);
  const top = kind === 'audio' ? 'audio/' : 'image/';
  if (b.type && b.type !== 'application/octet-stream' && !b.type.startsWith(top)) return fail(`${b.name} isn't an audio file or cover image`);
  if (!(b.size > 0) || b.size > MAX[kind]) return fail(`${b.name} is too big (max ${MAX[kind] / 1024 ** 2} MB)`);
  const type = contentType(b.name);
  let store = u; // a shared project's files go in its owner's storage
  if (b.project_id) {
    const proj = await editProject(env, u, b.project_id);
    if (!proj) return fail("You can't add to that project", 403);
    store = await storeOf(env, proj.owner_id, u);
  }
  if (usesDrive(env, store)) {
    if (!store.drive_refresh) return fail(store === u ? "Google Drive isn't connected. Open Settings → Account → Connect." : "The project owner's Google Drive isn't connected.", 409);
    const s = await space(env, store);
    if (s.usage + b.size > s.limit) return fail(store === u ? 'Your Google Drive is full. Delete old versions or empty the trash, or free up space in Drive.' : "The project owner's Google Drive is full.", 507);
    const session = await drive.uploadSession(env, store, { name: String(b.name).slice(0, 200), type, size: b.size, origin: url.origin });
    return json({ drive: kind, contentType: type, url: session });
  }
  if ((await adminUsage(env)) + b.size > STORAGE_LIMIT) return fail('Storage full (10 GB). Delete old versions or empty the trash to make room.', 507);
  const key = `${kind}/${uid()}.${ext(b.name)}`;
  return json({ key, contentType: type, url: await presign(env, key, 'PUT', { 'content-type': type }) });
});

// Tracks
async function createTrack(env, b, size) {
  const id = uid(), t = now();
  const pos = (await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tracks WHERE project_id = ?').bind(b.project_id).first()).p;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tracks (id, project_id, name, file_key, size, duration, bpm, musical_key, tags, artist, peaks, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, b.project_id, (b.name || 'Untitled').slice(0, 300), b.file_key, size, b.duration || null, b.bpm || null, b.musical_key || null, b.tags || '', (b.artist || '').slice(0, 120), peaksOrNull(b.peaks), pos, t),
    env.DB.prepare('INSERT INTO track_versions (id, track_id, file_key, size, duration, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), id, b.file_key, size, b.duration || null, 'Original', t),
  ]);
  return id;
}
on('POST', '/api/tracks', async (req, env, b, p, url, ctx, u) => {
  const proj = await editProject(env, u, b.project_id);
  if (!proj) return fail('Project not found', 404);
  const size = await verify(env, b.file_key, 'audio', await storeOf(env, proj.owner_id, u));
  return json({ id: await createTrack(env, b, size) });
});
const TRACK_FIELDS = ['name', 'project_id', 'bpm', 'musical_key', 'tags', 'cover', 'position', 'notes', 'artist', 'duration', 'peaks', 'mark'];
on('PATCH', '/api/tracks/:id', async (req, env, b, { id }, url, ctx, u) => {
  const old = await editTrack(env, u, id);
  if (!old) return fail('Not found', 404);
  // Moving is only within the same owner's projects (the file stays in that owner's storage).
  if (b.project_id && (await editProject(env, u, b.project_id))?.owner_id !== old.owner_id) return fail('Project not found', 404);
  const owner = await storeOf(env, old.owner_id, u);
  if (b.cover) await verify(env, b.cover, 'cover', owner);
  if (typeof b.notes === 'string') b.notes = b.notes.slice(0, 20000);
  if (typeof b.artist === 'string') b.artist = b.artist.slice(0, 120);
  if ('peaks' in b) b.peaks = peaksOrNull(b.peaks);
  if ('mark' in b) b.mark = ['star', 'throw'].includes(b.mark) ? b.mark : null; // favourite / throwaway
  await update(env, 'tracks', id, b, TRACK_FIELDS);
  if ('cover' in b && old.cover && old.cover !== b.cover) await remove(env, old.cover, owner);
  return json({ ok: true });
});
on('POST', '/api/tracks/reorder', async (req, env, b, p, url, ctx, u) => {
  await env.DB.batch((b.ids || []).slice(0, 2000).map((id, i) => env.DB.prepare(`UPDATE tracks SET position = ? WHERE id = ? AND project_id IN ${EDITABLE}`).bind(i, id, ...editArgs(u))));
  return json({ ok: true });
});
// Several tracks at once: move to a project, set the producer, star/throwaway, or send to the trash.
on('POST', '/api/tracks/bulk', async (req, env, b, p, url, ctx, u) => {
  const ids = (b.ids || []).slice(0, 2000);
  if (!ids.length) return json({ ok: true });
  const target = b.set?.project_id && await editProject(env, u, b.set.project_id);
  if (b.set?.project_id && !target) return fail('Project not found', 404);
  // Editable tracks only; a move only takes tracks that belong to the target's owner.
  const mine = `AND project_id IN (SELECT id FROM projects WHERE owner_id = ? UNION SELECT project_id FROM project_members WHERE user_id = ? AND role = 'editor')`;
  const stmts = [];
  for (const id of ids) {
    if (b.trash) stmts.push(env.DB.prepare(`UPDATE tracks SET deleted_at = ? WHERE id = ? ${mine}`).bind(now(), id, ...editArgs(u)));
    if (b.set?.project_id) stmts.push(env.DB.prepare(`UPDATE tracks SET project_id = ? WHERE id = ? ${mine} AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)`).bind(b.set.project_id, id, ...editArgs(u), target.owner_id));
    if (b.set && 'mark' in b.set) stmts.push(env.DB.prepare(`UPDATE tracks SET mark = ? WHERE id = ? ${mine}`).bind(['star', 'throw'].includes(b.set.mark) ? b.set.mark : null, id, ...editArgs(u)));
    if (typeof b.set?.artist === 'string') stmts.push(env.DB.prepare(`UPDATE tracks SET artist = ? WHERE id = ? ${mine}`).bind(b.set.artist.slice(0, 120), id, ...editArgs(u)));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ ok: true });
});
on('DELETE', '/api/tracks/:id', async (req, env, b, { id }, url, ctx, u) => {
  await env.DB.prepare(`UPDATE tracks SET deleted_at = ? WHERE id = ? AND project_id IN ${EDITABLE}`).bind(now(), id, ...editArgs(u)).run(); // goes to the owner's trash
  return json({ ok: true });
});

// Trash
on('GET', '/api/trash', async (req, env, b, p, url, ctx, u) => {
  const [pr, t] = await env.DB.batch([
    env.DB.prepare('SELECT p.id, p.name, p.cover, p.deleted_at, (SELECT COUNT(*) FROM tracks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS tracks FROM projects p WHERE p.deleted_at IS NOT NULL AND p.owner_id = ? ORDER BY p.deleted_at DESC').bind(u.id),
    env.DB.prepare('SELECT t.id, t.name, t.duration, t.size, t.deleted_at, p.name AS project FROM tracks t JOIN projects p ON p.id = t.project_id WHERE t.deleted_at IS NOT NULL AND p.deleted_at IS NULL AND p.owner_id = ? ORDER BY t.deleted_at DESC').bind(u.id),
  ]);
  return json({ projects: pr.results, tracks: t.results, days: TRASH_DAYS });
});
on('POST', '/api/trash/restore', async (req, env, b, p, url, ctx, u) => {
  if (b.kind === 'project') await env.DB.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ? AND owner_id = ?').bind(b.id, u.id).run();
  else await env.DB.prepare(`UPDATE tracks SET deleted_at = NULL WHERE id = ? AND project_id IN ${MY_PROJECTS}`).bind(b.id, u.id).run();
  return json({ ok: true });
});
on('DELETE', '/api/trash/:kind/:id', async (req, env, b, { kind, id }, url, ctx, u) => {
  if (kind === 'project') { if (await ownProject(env, u, id)) await deleteProject(env, id); }
  else if (await ownTrack(env, u, id)) await deleteTrack(env, id);
  return json({ ok: true });
});
on('POST', '/api/trash/empty', async (req, env, b, p, url, ctx, u) => {
  const [pr, t] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND owner_id = ?').bind(u.id),
    env.DB.prepare(`SELECT id FROM tracks WHERE deleted_at IS NOT NULL AND project_id IN ${MY_PROJECTS}`).bind(u.id),
  ]);
  for (const r of t.results) await deleteTrack(env, r.id);
  for (const r of pr.results) await deleteProject(env, r.id);
  return json({ ok: true });
});

// Versions: applying an edit adds a version and points the track at it. Older versions stay for revert.
on('GET', '/api/tracks/:id/versions', async (req, env, b, { id }, url, ctx, u) => {
  if (!(await editTrack(env, u, id))) return fail('Not found', 404);
  return json((await env.DB.prepare('SELECT * FROM track_versions WHERE track_id = ? ORDER BY created_at DESC').bind(id).all()).results);
});
on('POST', '/api/tracks/:id/versions', async (req, env, b, { id }, url, ctx, u) => {
  const t = await editTrack(env, u, id);
  if (!t) return fail('Not found', 404);
  const size = await verify(env, b.file_key, 'audio', await storeOf(env, t.owner_id, u));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO track_versions (id, track_id, file_key, size, duration, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), id, b.file_key, size, b.duration || null, (b.note || 'Edit').slice(0, 300), now()),
    env.DB.prepare('UPDATE tracks SET file_key = ?, size = ?, duration = ?, peaks = ? WHERE id = ?').bind(b.file_key, size, b.duration || null, peaksOrNull(b.peaks), id),
  ]);
  return json({ ok: true });
});
const ownVersion = (env, u, id) => env.DB.prepare(`SELECT v.*, t.file_key AS current, p.owner_id FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id WHERE v.id = ? AND t.project_id IN ${EDITABLE}`).bind(id, ...editArgs(u)).first();
on('POST', '/api/versions/:id/use', async (req, env, b, { id }, url, ctx, u) => {
  const v = await ownVersion(env, u, id);
  if (!v) return fail('Not found', 404);
  await env.DB.prepare('UPDATE tracks SET file_key = ?, size = ?, duration = ?, peaks = NULL WHERE id = ?').bind(v.file_key, v.size, v.duration, v.track_id).run();
  return json({ ok: true });
});
on('DELETE', '/api/versions/:id', async (req, env, b, { id }, url, ctx, u) => {
  const v = await ownVersion(env, u, id);
  if (!v) return fail('Not found', 404);
  if (v.file_key === v.current) return fail("That's the version in use. Switch to another one first.");
  await remove(env, v.file_key, await storeOf(env, v.owner_id, u));
  await env.DB.prepare('DELETE FROM track_versions WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

// Old versions = every version that isn't the one a track currently uses.
const OLD_VERSIONS = `FROM track_versions v JOIN tracks t ON t.id = v.track_id WHERE v.file_key != t.file_key AND t.project_id IN ${MY_PROJECTS}`;
on('GET', '/api/versions/old', async (req, env, b, p, url, ctx, u) => json(await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(v.size), 0) AS size ${OLD_VERSIONS}`).bind(u.id).first()));
// ponytail: 40 files per request keeps under the Workers subrequest limit; the app calls again until none are left.
on('POST', '/api/versions/cleanup', async (req, env, b, p, url, ctx, u) => {
  const one = typeof b.track_id === 'string', where = one ? ' AND v.track_id = ?' : '', args = one ? [u.id, b.track_id] : [u.id];
  const { results } = await env.DB.prepare(`SELECT v.id, v.file_key, v.size ${OLD_VERSIONS}${where} LIMIT 40`).bind(...args).all();
  // Only forget a version once its file is really gone, so nothing is left behind using storage.
  const gone = await Promise.all(results.map(v => Promise.resolve(remove(env, v.file_key, u)).then(r => !r || r.ok !== false, () => false)));
  const done = results.filter((v, i) => gone[i]);
  if (done.length) await env.DB.batch(done.map(v => env.DB.prepare('DELETE FROM track_versions WHERE id = ?').bind(v.id)));
  const left = (await env.DB.prepare(`SELECT COUNT(*) AS n ${OLD_VERSIONS}${where}`).bind(...args).first()).n;
  return json({ deleted: done.length, freed: done.reduce((s, v) => s + v.size, 0), left });
});

// Storage manager: what the space is made of, and the biggest projects and tracks.
on('GET', '/api/storage', async (req, env, b, p, url, ctx, u) => {
  const LIVE = 't.deleted_at IS NULL AND p.deleted_at IS NULL';
  const [sum, projects, tracks] = await env.DB.batch([
    env.DB.prepare(`SELECT
        COALESCE(SUM(CASE WHEN ${LIVE} AND v.file_key = t.file_key THEN v.size END), 0) AS current,
        COALESCE(SUM(CASE WHEN ${LIVE} AND v.file_key != t.file_key THEN v.size END), 0) AS old,
        COALESCE(SUM(CASE WHEN NOT (${LIVE}) THEN v.size END), 0) AS trash
      FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id WHERE p.owner_id = ?`).bind(u.id),
    env.DB.prepare(`SELECT p.id, p.name, p.cover, COUNT(DISTINCT t.id) AS tracks, COALESCE(SUM(v.size), 0) AS size
      FROM projects p JOIN tracks t ON t.project_id = p.id JOIN track_versions v ON v.track_id = t.id
      WHERE ${LIVE} AND p.owner_id = ? GROUP BY p.id ORDER BY size DESC LIMIT 40`).bind(u.id),
    env.DB.prepare(`SELECT t.id, t.name, t.project_id, t.file_key, t.size AS current, COUNT(v.id) AS versions, COALESCE(SUM(v.size), 0) AS size
      FROM tracks t JOIN projects p ON p.id = t.project_id JOIN track_versions v ON v.track_id = t.id
      WHERE ${LIVE} AND p.owner_id = ? GROUP BY t.id ORDER BY size DESC LIMIT 25`).bind(u.id),
  ]);
  const s = await space(env, u);
  return json({ ...sum.results[0], limit: s.limit, used: s.usage, drive: usesDrive(env, u), projects: projects.results, tracks: tracks.results });
});

// Comments listeners left on share links
on('GET', '/api/tracks/:id/comments', async (req, env, b, { id }, url, ctx, u) => {
  if (!(await editTrack(env, u, id))) return fail('Not found', 404);
  return json((await env.DB.prepare('SELECT id, name, at, body, created_at FROM comments WHERE track_id = ? ORDER BY created_at DESC LIMIT 500').bind(id).all()).results);
});
on('DELETE', '/api/comments/:id', async (req, env, b, { id }, url, ctx, u) => {
  await env.DB.prepare(`DELETE FROM comments WHERE id = ? AND track_id IN (SELECT id FROM tracks WHERE project_id IN ${EDITABLE})`).bind(id, ...editArgs(u)).run();
  return json({ ok: true });
});

// Push notifications: each device that turns them on stores its subscription here, under its user.
on('GET', '/api/push/key', async (req, env) => json({ key: (await vapid(env)).pub }));
on('POST', '/api/push/subscribe', async (req, env, b, p, url, ctx, u) => {
  const { endpoint, keys = {} } = b;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return fail('Bad subscription');
  await env.DB.prepare('INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(endpoint, keys.p256dh, keys.auth, u.id, now()).run();
  return json({ ok: true });
});
on('POST', '/api/push/unsubscribe', async (req, env, b, p, url, ctx, u) => {
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND owner_id = ?').bind(String(b.endpoint || ''), u.id).run();
  return json({ ok: true });
});
on('POST', '/api/push/test', async (req, env, b, p, url, ctx, u) => {
  const sent = await sendPush(env, u.id, { title: '[vault]', body: "Notifications are on. You'll hear when someone listens or comments.", tag: 'test' }, url.origin);
  return json({ sent: sent.filter(s => s >= 200 && s < 300).length, devices: sent.length });
});

// Streaming. ?json=1 returns this app's own URL for the file (fetched by the editor, downloads and keep-on-device).
const fileUrl = key => (drive.isDriveKey(key) ? `/api/file/drive/${drive.driveKind(key)}/${drive.driveId(key)}` : `/api/file/${key}`);
on('GET', '/api/audio/:id', async (req, env, b, { id }, url, ctx, u) => {
  const v = url.searchParams.get('v');
  const row = v
    ? await env.DB.prepare(`SELECT v.file_key, p.owner_id FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id WHERE v.id = ? AND v.track_id = ? AND t.project_id IN ${EDITABLE}`).bind(v, id, ...editArgs(u)).first()
    : await readTrack(env, u, id);
  if (!row) return fail('Not found', 404);
  if (url.searchParams.has('json')) return json({ url: fileUrl(row.file_key) });
  return streamFile(env, req, row.file_key, await storeOf(env, row.owner_id, u));
});
// A file of the signed-in user's (any version of any of their tracks).
// Whose file is this, if this user may open it? Returns the account whose storage holds it (or null).
async function fileOwner(env, u, key) {
  const r = await env.DB.prepare(`SELECT p.owner_id FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id
    WHERE v.file_key = ? AND (t.project_id IN ${READABLE} OR t.id IN ${LINKED('track')}) LIMIT 1`).bind(key, ...readArgs(u), u.id, now()).first();
  return r && storeOf(env, r.owner_id, u);
}
async function coverOwner(env, u, key) {
  const r = await env.DB.prepare(`SELECT owner_id FROM projects WHERE cover = ? AND (id IN ${READABLE} OR id IN (SELECT project_id FROM tracks WHERE id IN ${LINKED('track')}))
    UNION SELECT p.owner_id FROM tracks t JOIN projects p ON p.id = t.project_id WHERE t.cover = ? AND (t.project_id IN ${READABLE} OR t.id IN ${LINKED('track')}) LIMIT 1`)
    .bind(key, ...readArgs(u), u.id, now(), key, ...readArgs(u), u.id, now()).first();
  return r && storeOf(env, r.owner_id, u);
}
on('GET', '/api/file/audio/:name', async (req, env, b, { name }, url, ctx, u) => {
  const key = `audio/${name}`, owner = await fileOwner(env, u, key);
  return owner ? streamFile(env, req, key, owner) : fail('Not found', 404);
});
on('GET', '/api/file/drive/:kind/:id', async (req, env, b, { kind, id }, url, ctx, u) => {
  const key = `drive:${kind}:${id}`;
  const owner = kind === 'cover' ? await coverOwner(env, u, key) : await fileOwner(env, u, key);
  if (!owner) return fail('Not found', 404);
  return kind === 'cover' ? coverFile(env, key, 'private', owner) : streamFile(env, req, key, owner);
});
on('GET', '/api/cover/cover/:name', async (req, env, b, { name }, url, ctx, u) => {
  const key = `cover/${name}`, owner = await coverOwner(env, u, key);
  if (!owner) return fail('Not found', 404);
  return url.searchParams.has('json') ? json({ url: `/api/cover/${key}` }) : coverFile(env, key, 'private', owner);
});
on('GET', '/api/cover/:key', async (req, env, b, { key }, url, ctx, u) => {
  key = decodeURIComponent(key);
  const owner = drive.DRIVE_KEY_RE.test(key) && await coverOwner(env, u, key);
  if (!owner) return fail('Not found', 404);
  return url.searchParams.has('json') ? json({ url: fileUrl(key) }) : coverFile(env, key, 'private', owner);
});
// Covers never change (a new cover gets a new name), so they're served from here and cached by the browser for a year.
async function coverFile(env, key, scope, owner) {
  if (!validKey(key)) return fail('Not found', 404);
  const r = await getObject(env, null, key, owner);
  if (!r.ok) return new Response(null, { status: r.status === 404 ? 404 : 502 });
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': `${scope}, max-age=31536000, immutable` } });
}
// Streams a file through this Worker. Range requests pass straight through, so seeking works, and the
// browser can cache it for good (a file key never changes).
async function streamFile(env, req, key, owner, scope = 'private') {
  if (!validKey(key)) return fail('Not found', 404);
  const r = await getObject(env, req, key, owner);
  if (!r.ok) return new Response(null, { status: r.status === 404 ? 404 : r.status === 416 ? 416 : 502 });
  const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': `${scope}, max-age=31536000, immutable` });
  for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) { const v = r.headers.get(h); if (v) headers.set(h, v); }
  return new Response(r.body, { status: r.status, headers });
}

// Why can't files load? Asks the storage for one byte of a recent file and reports what it says.
on('GET', '/api/storage-check', async (req, env, b, p, url, ctx, u) => {
  if (env.LOCAL) return json({ ok: true });
  const t = await env.DB.prepare(`SELECT file_key FROM tracks WHERE project_id IN ${MY_PROJECTS} ORDER BY created_at DESC LIMIT 1`).bind(u.id).first();
  if (!t) return json({ ok: true });
  if (drive.isDriveKey(t.file_key)) {
    try { const r = await drive.fetchFile(env, u, t.file_key, 'bytes=0-0'); return json(r.ok ? { ok: true } : { ok: false, status: r.status, code: 'drive', message: `Google Drive said ${r.status}` }); }
    catch (e) { return json({ ok: false, status: 409, code: 'drive', message: e.message }); }
  }
  const r = await s3(env).fetch(objUrl(env, t.file_key), { headers: { Range: 'bytes=0-0' } });
  if (r.ok) return json({ ok: true });
  const body = await r.text(), tag = n => (body.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1] || '';
  return json({ ok: false, status: r.status, code: tag('Code'), message: tag('Message') || body.slice(0, 200) });
});

// Shares (only of your own projects / tracks)
const ownsTarget = (env, u, kind, id) => (kind === 'project' ? ownProject(env, u, id) : ownTrack(env, u, id));
const ownShare = (env, u, token) => env.DB.prepare(`SELECT * FROM shares WHERE token = ? AND ((kind = 'project' AND target_id IN ${MY_PROJECTS}) OR (kind = 'track' AND target_id IN (SELECT id FROM tracks WHERE project_id IN ${MY_PROJECTS})))`).bind(token, u.id, u.id).first();
on('GET', '/api/shares', async (req, env, b, p, url, ctx, u) => {
  const kind = url.searchParams.get('kind'), target = url.searchParams.get('target_id');
  if (!(await ownsTarget(env, u, kind, target))) return json([]);
  const { results } = await env.DB.prepare(
    'SELECT s.token, s.expires_at, s.revoked, s.allow_download, s.public, s.created_at, s.password_hash IS NOT NULL AS has_password, (SELECT COUNT(*) FROM listens l WHERE l.share_token = s.token) AS listens FROM shares s WHERE kind = ? AND target_id = ? ORDER BY created_at DESC'
  ).bind(kind, target).all();
  return json(results);
});
on('POST', '/api/shares', async (req, env, b, p, url, ctx, u) => {
  if (!['project', 'track'].includes(b.kind)) return fail('Bad share');
  if (!(await ownsTarget(env, u, b.kind, b.target_id))) return fail('Not found', 404);
  const token = uid().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO shares (token, kind, target_id, password_hash, expires_at, allow_download, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(token, b.kind, b.target_id, b.password ? await hmac(token, b.password) : null, b.days ? now() + b.days * DAY : null, b.allow_download ? 1 : 0, b.public ? 1 : 0, now()).run();
  return json({ token });
});
on('PATCH', '/api/shares/:token', async (req, env, b, { token }, url, ctx, u) => {
  if (!(await ownShare(env, u, token))) return fail('Not found', 404);
  if ('revoked' in b) await env.DB.prepare('UPDATE shares SET revoked = ? WHERE token = ?').bind(b.revoked ? 1 : 0, token).run();
  if ('allow_download' in b) await env.DB.prepare('UPDATE shares SET allow_download = ? WHERE token = ?').bind(b.allow_download ? 1 : 0, token).run();
  if ('public' in b) await env.DB.prepare('UPDATE shares SET public = ? WHERE token = ?').bind(b.public ? 1 : 0, token).run();
  return json({ ok: true });
});
on('GET', '/api/shares/:token/listens', async (req, env, b, { token }, url, ctx, u) => {
  if (!(await ownShare(env, u, token))) return fail('Not found', 404);
  return json((await env.DB.prepare('SELECT l.listener_name, l.at, l.seconds, l.duration, l.track_id, t.name AS track FROM listens l LEFT JOIN tracks t ON t.id = l.track_id WHERE share_token = ? ORDER BY at DESC LIMIT 1000').bind(token).all()).results);
});

// People added to a project by username: viewers can listen; editors can also add, remove, reorder and edit tracks.
on('GET', '/api/projects/:id/members', async (req, env, b, { id }, url, ctx, u) => {
  if (!(await ownProject(env, u, id))) return fail('Not found', 404);
  return json((await env.DB.prepare('SELECT x.id, x.username, x.avatar, m.role FROM project_members m JOIN users x ON x.id = m.user_id WHERE m.project_id = ? ORDER BY m.created_at').bind(id).all()).results);
});
on('POST', '/api/projects/:id/members', async (req, env, b, { id }, url, ctx, u) => {
  const p = await ownProject(env, u, id);
  if (!p) return fail('Not found', 404);
  const role = b.role === 'editor' ? 'editor' : 'viewer';
  const who = await env.DB.prepare('SELECT id, username FROM users WHERE username = ? AND (disabled IS NULL OR disabled = 0)').bind(String(b.username || '').trim().toLowerCase()).first();
  if (!who) return fail("There's no [vault] account with that username.", 404);
  if (who.id === u.id) return fail("That's you.");
  const had = await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').bind(id, who.id).first();
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role').bind(id, who.id, role, now()).run();
  if (!had) notify(ctx, env, who.id, { title: `${u.username} shared “${p.name}” with you`, body: role === 'editor' ? 'You can listen and edit it.' : 'You can listen to it.', tag: 'member-' + id, url: '/' }, url.origin);
  return json({ ok: true });
});
on('DELETE', '/api/projects/:id/members/:uid', async (req, env, b, { id, uid: who }, url, ctx, u) => {
  if (who !== u.id && !(await ownProject(env, u, id))) return fail('Not found', 404); // the owner removes anyone; people can remove themselves
  await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(id, who).run();
  return json({ ok: true });
});
// Remove a shared project (or a single saved track) from my library: leaves it and forgets saved links to it.
on('POST', '/api/shared/leave', async (req, env, b, p, url, ctx, u) => {
  const kind = b.track_id ? 'track' : 'project', target = b.track_id || b.project_id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(target, u.id),
    env.DB.prepare('DELETE FROM saved_shares WHERE user_id = ? AND token IN (SELECT token FROM shares WHERE kind = ? AND target_id = ?)').bind(u.id, kind, target),
  ]);
  return json({ ok: true });
});

// Editor presets (synced across your devices)
on('GET', '/api/presets', async (req, env, b, p, url, ctx, u) => json((await env.DB.prepare('SELECT * FROM presets WHERE owner_id = ? ORDER BY name COLLATE NOCASE').bind(u.id).all()).results));
on('POST', '/api/presets', async (req, env, b, p, url, ctx, u) => {
  await env.DB.prepare('INSERT INTO presets (id, name, settings, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(uid(), (b.name || 'Preset').slice(0, 100), JSON.stringify(b.settings), u.id, now()).run();
  return json({ ok: true });
});
on('DELETE', '/api/presets/:id', async (req, env, b, { id }, url, ctx, u) => {
  await env.DB.prepare('DELETE FROM presets WHERE id = ? AND owner_id = ?').bind(id, u.id).run();
  return json({ ok: true });
});

// ---- your account ----
// Change password (logs out your other devices).
on('POST', '/api/password', async (req, env, b, p, url, ctx, u) => {
  const lockKey = 'pw:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return fail(lockMessage(wait), 429);
  const ok = u.id === OWNER ? await adminPasswordOk(env, b.current || '') : same(await passHash(env, u.pass_salt, b.current || ''), u.pass_hash || '');
  if (!ok) { await recordFail(env, lockKey); return fail('Current password is wrong', 403); }
  if (!b.next || b.next.length < 8) return fail('Use at least 8 characters');
  const salt = uid();
  if (u.id === OWNER) {
    await setConfig(env, 'password', JSON.stringify({ salt, hash: await passHash(env, salt, b.next) }));
    await setConfig(env, 'session', uid());
  } else {
    await env.DB.prepare('UPDATE users SET pass_salt = ?, pass_hash = ?, session = ? WHERE id = ?').bind(salt, await passHash(env, salt, b.next), uid(), u.id).run();
  }
  await clearFails(env, lockKey);
  return json({ ok: true }, 200, { 'set-cookie': await authCookie(env, await getUser(env, u.id)) });
});
// Profile picture (a small JPEG made in the browser, kept in the database) and username.
on('PATCH', '/api/me', async (req, env, b, p, url, ctx, u) => {
  if ('avatar' in b) {
    if (b.avatar !== null && !AVATAR_RE.test(b.avatar || '')) return fail('That picture didn\'t work. Try another one.');
    await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(b.avatar, u.id).run();
  }
  if ('username' in b) {
    const name = String(b.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return fail('Usernames are 3–24 letters, numbers, dots, dashes or underscores.');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').bind(name, u.id).first()) return fail('That username is taken.');
    await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, u.id).run();
  }
  return json({ ok: true });
});
// iPhone Shortcut upload key (only a hash is kept).
on('GET', '/api/upload-key', async (req, env, b, p, url, ctx, u) => json({ exists: !!u.upload_key }));
on('POST', '/api/upload-key', async (req, env, b, p, url, ctx, u) => {
  const key = uid().replace(/-/g, '') + uid().replace(/-/g, '').slice(0, 16);
  await env.DB.prepare('UPDATE users SET upload_key = ? WHERE id = ?').bind(await hmac(env.APP_PASSWORD, 'key:' + key), u.id).run();
  return json({ key }); // shown once
});
on('DELETE', '/api/upload-key', async (req, env, b, p, url, ctx, u) => {
  await env.DB.prepare('UPDATE users SET upload_key = NULL WHERE id = ?').bind(u.id).run();
  return json({ ok: true });
});

// ---- Google Drive connection ----
const driveRedirect = url => `${url.origin}/api/drive/callback`;
on('GET', '/api/drive/connect', async (req, env, b, p, url, ctx, u) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail("Google Drive isn't set up on this server yet. Ask the admin.", 503);
  const state = `${u.id}.${await hmac(env.APP_PASSWORD, 'drive-state:' + u.id)}`;
  return Response.redirect(drive.authUrl(env.GOOGLE_CLIENT_ID, driveRedirect(url), state), 302);
});
// Google sends you back here after you allow access.
async function driveCallback(req, env, url) {
  const back = msg => Response.redirect(`${url.origin}/?drive=${encodeURIComponent(msg)}`, 302);
  const u = await userFromCookie(req, env);
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code');
  if (!u || !same(state, `${u.id}.${await hmac(env.APP_PASSWORD, 'drive-state:' + u.id)}`)) return back('That sign-in link expired. Try again.');
  if (!code) return back(url.searchParams.get('error') === 'access_denied' ? 'Google Drive wasn\'t connected.' : 'Google didn\'t finish. Try again.');
  try {
    const t = await drive.exchangeCode(env, code, driveRedirect(url));
    const sealed = await drive.seal(env.APP_PASSWORD, t.refresh_token);
    await env.DB.prepare("UPDATE users SET drive_refresh = ?, storage = 'drive' WHERE id = ?").bind(sealed, u.id).run();
    const fresh = await getUser(env, u.id);
    if (!fresh.drive_folder) await env.DB.prepare('UPDATE users SET drive_folder = ? WHERE id = ?').bind(await drive.makeFolder(env, fresh), u.id).run();
    return back('connected');
  } catch (e) { return back(e.message || 'Couldn\'t connect Google Drive.'); }
}
on('POST', '/api/drive/disconnect', async (req, env, b, p, url, ctx, u) => {
  if (u.id === OWNER) return fail('The admin account uses Backblaze.');
  await env.DB.prepare('UPDATE users SET drive_refresh = NULL WHERE id = ?').bind(u.id).run();
  return json({ ok: true });
});

// ---- admin: invites and people ----
const adminOnly = u => (u.is_admin ? null : fail('Only the admin can do that', 403));
on('GET', '/api/admin/invites', async (req, env, b, p, url, ctx, u) =>
  adminOnly(u) || json((await env.DB.prepare('SELECT i.code, i.created_at, i.used_at, i.disabled, x.username AS used_by FROM invites i LEFT JOIN users x ON x.id = i.used_by ORDER BY i.created_at DESC LIMIT 100').all()).results));
on('POST', '/api/admin/invites', async (req, env, b, p, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map(x => abc[x % abc.length]).join('').replace(/(.{4})/, '$1-');
  await env.DB.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').bind(code, u.id, now()).run();
  return json({ code });
});
// Turn a code off (it stops working for sign-up) or back on.
on('PATCH', '/api/admin/invites/:code', async (req, env, b, { code }, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  await env.DB.prepare('UPDATE invites SET disabled = ? WHERE code = ?').bind(b.disabled ? 1 : 0, code).run();
  return json({ ok: true });
});
on('DELETE', '/api/admin/invites/:code', async (req, env, b, { code }, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  await env.DB.prepare('DELETE FROM invites WHERE code = ?').bind(code).run(); // a used code can go too: the account stays
  return json({ ok: true });
});
on('GET', '/api/admin/requests', async (req, env, b, p, url, ctx, u) =>
  adminOnly(u) || json((await env.DB.prepare('SELECT id, name, contact, message, created_at FROM access_requests ORDER BY created_at DESC LIMIT 100').all()).results));
on('DELETE', '/api/admin/requests/:id', async (req, env, b, { id }, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  await env.DB.prepare('DELETE FROM access_requests WHERE id = ?').bind(Number(id) || 0).run();
  return json({ ok: true });
});
on('GET', '/api/admin/users', async (req, env, b, p, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  const { results } = await env.DB.prepare(`SELECT x.id, x.username, x.avatar, x.is_admin, x.storage, x.disabled, x.created_at, x.drive_refresh IS NOT NULL AS drive,
      (SELECT COUNT(*) FROM tracks t JOIN projects p ON p.id = t.project_id WHERE p.owner_id = x.id AND t.deleted_at IS NULL) AS tracks,
      (SELECT COALESCE(SUM(v.size), 0) FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN projects p ON p.id = t.project_id WHERE p.owner_id = x.id) AS used
    FROM users x ORDER BY x.is_admin DESC, x.created_at`).all();
  return json(results);
});
on('PATCH', '/api/admin/users/:id', async (req, env, b, { id }, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  if (id === OWNER) return fail("You can't change the admin account here.");
  if ('disabled' in b) await env.DB.prepare('UPDATE users SET disabled = ?, session = ? WHERE id = ?').bind(b.disabled ? 1 : 0, uid(), id).run();
  return json({ ok: true });
});
// Deleting an account removes its projects (and the files the app made in their Drive), then the account.
// Big libraries take several calls: it answers { more: true } until everything is gone.
async function deleteAccount(env, id) {
  const { results } = await env.DB.prepare('SELECT id FROM projects WHERE owner_id = ? LIMIT 20').bind(id).all();
  for (const r of results) await deleteProject(env, r.id);
  const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').bind(id).first()).n;
  if (left) return { more: true, left };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM folders WHERE owner_id = ?').bind(id),
    env.DB.prepare('DELETE FROM presets WHERE owner_id = ?').bind(id),
    env.DB.prepare('DELETE FROM push_subs WHERE owner_id = ?').bind(id),
    env.DB.prepare('DELETE FROM saved_shares WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM invites WHERE used_by = ?').bind(id),
    env.DB.prepare('DELETE FROM project_members WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return { ok: true };
}
on('DELETE', '/api/admin/users/:id', async (req, env, b, { id }, url, ctx, u) => {
  if (adminOnly(u)) return adminOnly(u);
  if (id === OWNER) return fail("The admin account can't be deleted.");
  return json(await deleteAccount(env, id));
});
// Delete my own account (needs the password). The admin account can't delete itself.
on('POST', '/api/me/delete', async (req, env, b, p, url, ctx, u) => {
  if (u.id === OWNER) return fail("The admin account can't be deleted.");
  const lockKey = 'pw:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return fail(lockMessage(wait), 429);
  if (!same(await passHash(env, u.pass_salt, b.password || ''), u.pass_hash || '')) { await recordFail(env, lockKey); return fail('Wrong password', 403); }
  const r = await deleteAccount(env, u.id);
  return json(r, 200, r.ok ? { 'set-cookie': setCookie('auth', '', '/', 0) } : {});
});

// ---- sign in / sign up (no login needed) ----
async function login(req, env) {
  const lockKey = 'login:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return fail(lockMessage(wait), 429);
  const { username = '', password = '' } = await req.json().catch(() => ({}));
  const name = String(username).trim().toLowerCase();
  let user = null;
  const admin = await getUser(env, OWNER);
  // No username (or the admin's username): the admin password signs you in as the admin.
  if ((!name || name === admin?.username) && (await adminPasswordOk(env, password))) user = admin;
  else if (name) {
    const x = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND id != ?').bind(name, OWNER).first();
    if (x && !x.disabled && same(await passHash(env, x.pass_salt, password), x.pass_hash || '')) user = x;
  }
  if (!user) { await recordFail(env, lockKey); return fail(name ? 'Wrong username or password' : 'Wrong password', 401); }
  await clearFails(env, lockKey);
  return json({ ok: true }, 200, { 'set-cookie': await authCookie(env, user) });
}
async function signup(req, env) {
  const lockKey = 'signup:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return fail(lockMessage(wait), 429);
  const b = await req.json().catch(() => ({}));
  const code = String(b.invite || '').trim().toUpperCase();
  const invite = code && await env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
  if (!invite || invite.used_by || invite.disabled) { await recordFail(env, lockKey); return fail(!invite ? "That invite code doesn't exist" : invite.used_by ? 'That invite code was already used' : 'That invite code was turned off', 400); }
  if (b.checkOnly) return json({ ok: true }); // step 1 of sign-up just checks the code
  const name = String(b.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return fail('Usernames are 3–24 letters, numbers, dots, dashes or underscores.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first()) return fail('That username is taken.');
  if (!b.password || String(b.password).length < 8) return fail('Use at least 8 characters for your password.');
  if (b.avatar && !AVATAR_RE.test(b.avatar)) return fail('That picture didn\'t work. Try another one.');
  const id = uid(), salt = uid();
  const claimed = await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND disabled = 0').bind(id, now(), code).run();
  if (!claimed.meta.changes) return fail('That invite code was just used');
  await env.DB.prepare("INSERT INTO users (id, username, pass_salt, pass_hash, is_admin, avatar, storage, session, created_at) VALUES (?, ?, ?, ?, 0, ?, 'drive', ?, ?)")
    .bind(id, name, salt, await passHash(env, salt, String(b.password)), b.avatar || null, uid(), now()).run();
  await clearFails(env, lockKey);
  return json({ ok: true }, 200, { 'set-cookie': await authCookie(env, await getUser(env, id)) });
}

// iPhone Shortcut upload: the raw file in the body, authorised by an upload key instead of the login cookie.
// Plain-text replies, because that's what a Shortcut shows.
async function shortcutUpload(req, env, url) {
  const text = (msg, status = 200) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const lockKey = 'key:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return text(lockMessage(wait), 429);
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const u = token && await env.DB.prepare('SELECT * FROM users WHERE upload_key = ? AND (disabled IS NULL OR disabled = 0)').bind(await hmac(env.APP_PASSWORD, 'key:' + token)).first();
  if (!u) {
    await recordFail(env, lockKey);
    return text('Upload key is wrong or was turned off. Make a new one in [vault] Settings.', 401);
  }
  let name = (url.searchParams.get('name') || 'Shared track').trim().slice(0, 300);
  const fileExt = (url.searchParams.get('ext') || '').trim().replace(/^\./, '').toLowerCase();
  if (fileExt && !name.toLowerCase().endsWith('.' + fileExt)) name += '.' + fileExt;
  if (kindOf(name) !== 'audio') return text(`"${name}" isn't an audio file.`, 400);
  const size = Number(req.headers.get('content-length'));
  if (!(size > 0)) return text('No file was received.', 400);
  if (size > MAX.audio) return text('That file is too big (max 1 GB).', 400);
  const s = await space(env, u);
  if (s.usage + size > s.limit) return text('Storage is full.', 507);

  const type = contentType(name);
  let key;
  if (usesDrive(env, u)) {
    const session = await drive.uploadSession(env, u, { name, type, size });
    const put = await fetch(session, { method: 'PUT', body: req.body, headers: { 'content-type': type, 'content-length': String(size) } });
    if (!put.ok) return text(`Google Drive refused the upload (${put.status}).`, 502);
    key = `drive:audio:${(await put.json()).id}`;
  } else {
    key = `audio/${uid()}.${ext(name)}`;
    if (env.LOCAL) await env.LOCAL.put(key, req.body, { httpMetadata: { contentType: type } });
    else {
      const put = await fetch(await presign(env, key, 'PUT', { 'content-type': type }), { method: 'PUT', body: req.body, headers: { 'content-type': type, 'content-length': String(size) } });
      if (!put.ok) return text(`Storage refused the upload (${put.status}).`, 502);
    }
  }
  let saved;
  try { saved = await verify(env, key, 'audio', u); } catch (e) { return text(e.message, 400); }

  // No project named: the Inbox if there is one, otherwise the newest project (only an empty library gets a new Inbox).
  const wanted = (url.searchParams.get('project') || '').trim() || 'Inbox';
  let project = await env.DB.prepare('SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND owner_id = ?').bind(wanted, u.id).first();
  if (!project && !url.searchParams.get('project'))
    project = await env.DB.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL AND owner_id = ? ORDER BY created_at DESC LIMIT 1').bind(u.id).first();
  if (!project) {
    project = { id: uid(), name: wanted };
    await env.DB.prepare('INSERT INTO projects (id, name, folder_id, owner_id, created_at) VALUES (?, ?, NULL, ?, ?)').bind(project.id, wanted.slice(0, 200), u.id, now()).run();
  }
  const base = name.replace(/\.[^.]+$/, '');
  const { bpm, key: mkey } = parseName(name);
  await createTrack(env, { project_id: project.id, name: base, file_key: key, bpm, musical_key: mkey }, saved);
  return text(`Saved "${base}" to ${project.name}.${bpm || mkey ? ' ' + [bpm && bpm + ' BPM', mkey].filter(Boolean).join(' · ') : ''}`);
}

// ---- push notifications ---------------------------------------------------------------
// The server's VAPID key pair, made on first use and kept in the database.
async function vapid(env) {
  if (!(await getConfig(env, 'vapid'))) {
    const v = JSON.stringify(await makeVapidKeys());
    await env.DB.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').bind('vapid', v).run(); // first writer wins
  }
  return JSON.parse(await getConfig(env, 'vapid'));
}
// Sends to every device of one user. Returns each push service's status; dead subscriptions are removed.
async function sendPush(env, ownerId, payload, origin) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subs WHERE owner_id = ?').bind(ownerId).all();
  const keys = results.length && await vapid(env);
  return Promise.all(results.map(async s => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', body: await encryptPush(s, payload), headers: {
        authorization: await vapidHeader(keys, s.endpoint, origin), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal',
      } });
      if (r.status === 404 || r.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
      return r.status;
    } catch { return 0; }
  }));
}
const notify = (ctx, env, ownerId, payload, origin) => ctx?.waitUntil?.(sendPush(env, ownerId, payload, origin).catch(() => {}));

// ---- public share pages -----------------------------------------------------
async function openShare(env, token) {
  const s = await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first();
  if (!s || s.revoked || (s.expires_at && s.expires_at < now())) return null;
  const target = s.kind === 'project'
    ? await env.DB.prepare('SELECT owner_id FROM projects WHERE id = ? AND deleted_at IS NULL').bind(s.target_id).first()
    : await env.DB.prepare('SELECT p.owner_id FROM tracks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL').bind(s.target_id).first();
  return target ? { ...s, owner_id: target.owner_id } : null;
}
async function shareTracks(env, s) {
  const q = s.kind === 'project'
    ? env.DB.prepare('SELECT id, name, duration, cover, artist, peaks, size, file_key FROM tracks WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, created_at').bind(s.target_id)
    : env.DB.prepare('SELECT id, name, duration, cover, artist, peaks, size, file_key FROM tracks WHERE id = ? AND deleted_at IS NULL').bind(s.target_id);
  return (await q.all()).results;
}
const shareCookie = (env, token) => hmac(env.APP_PASSWORD, 'share:' + token);
async function shareAllowed(req, env, s) {
  return !s.password_hash || same(cookie(req, 'share'), await shareCookie(env, s.token));
}

// Visitors who aren't signed in hear the first few seconds. The server only ever sends that much of the file:
// its ID3 tag (if any) plus ~3 s more audio than the preview, sized from the file's bitrate.
// ponytail: byte-based cut; files whose index sits at the end (some .m4a) won't preview, cut audio server-side if that matters
const PREVIEW_SECS = 5;
async function previewFile(env, req, t, owner) {
  const part = range => getObject(env, new Request('http://x/', { headers: { range } }), t.file_key, owner);
  let head = 0;
  const r0 = await part('bytes=0-9');
  if (r0.ok) {
    const b = new Uint8Array(await r0.arrayBuffer());
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) head = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
  }
  const perSec = t.duration ? t.size / t.duration : 40000;
  const size = Math.min(t.size, head + Math.ceil(perSec * (PREVIEW_SECS + 3)) + 4096);
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  const start = m ? +m[1] : 0, end = Math.min(size - 1, m && m[2] ? +m[2] : size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const r = await part(`bytes=${start}-${end}`);
  if (!r.ok) return new Response(null, { status: 502 });
  const headers = { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (m) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  return new Response(r.body, { status: m ? 206 : 200, headers });
}

// Email the admin through Resend (free: 100 a day). Only once RESEND_API_KEY and NOTIFY_EMAIL are set (node setup.mjs email).
// Resend's shared sender can only email the address the Resend account was made with, which is all this needs.
async function emailAdmin(env, subject, text) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: '"[vault]" <onboarding@resend.dev>', to: [env.NOTIFY_EMAIL], subject, text }) }).catch(() => {});
}

// Ask the admin for an invite (from the sign-up screen, or a share page's sign-in card). A few per address, then a wait.
async function requestInvite(req, env, ctx, url, token = null) {
  const lockKey = 'request:' + clientIp(req), wait = await lockedFor(env, lockKey);
  if (wait) return fail(lockMessage(wait), 429);
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return fail('Add your name');
  await recordFail(env, lockKey);
  await env.DB.prepare('INSERT INTO access_requests (share_token, name, contact, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(token, name, String(b.contact || '').trim().slice(0, 200), String(b.message || '').trim().slice(0, 500), now()).run();
  const contact = String(b.contact || '').trim(), note = String(b.message || '').trim();
  ctx?.waitUntil?.(emailAdmin(env, `${name} wants an invite to [vault]`,
    `${name} asked for an invite ${token ? 'from a share link' : 'from the sign-up screen'}.

How to reach them: ${contact || '(not given)'}
Note: ${note || '(none)'}

Make a code in [vault]: profile picture → People → New invite code.
${url.origin}/`));
  notify(ctx, env, OWNER, { title: `${name} wants an invite to [vault]`, body: String(b.message || b.contact || (token ? 'From a share link' : 'From the sign-up screen')).slice(0, 200), tag: 'request', url: '/' }, url.origin);
  return json({ ok: true });
}

async function handleShare(req, env, url, ctx) {
  const [, , token, action, trackId] = url.pathname.split('/');
  const s = await openShare(env, token);
  if (!action) return new Response(sharePage(!!s), { status: s ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (!s) return fail('This link has expired or was turned off', 404);

  if (action === 'open' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const headers = {};
    if (s.password_hash) {
      const lockKey = `share:${token}:${clientIp(req)}`, wait = await lockedFor(env, lockKey);
      if (wait) return fail(lockMessage(wait), 429);
      const ok = same(cookie(req, 'share'), await shareCookie(env, token))
        || (b.password && same(await hmac(token, b.password), s.password_hash));
      if (!ok) { if (b.password) await recordFail(env, lockKey); return fail(b.password ? 'Wrong password' : 'Password needed', 401); }
      headers['set-cookie'] = setCookie('share', await shareCookie(env, token), `/s/${token}`, 30 * 86400);
    }
    const title = s.kind === 'project'
      ? await env.DB.prepare('SELECT name, cover FROM projects WHERE id = ?').bind(s.target_id).first()
      : await env.DB.prepare('SELECT name, cover FROM tracks WHERE id = ?').bind(s.target_id).first();
    const tracks = (await shareTracks(env, s)).map(({ file_key, ...t }) => ({ ...t, ext: drive.isDriveKey(file_key) ? 'mp3' : ext(file_key) }));
    const viewer = await userFromCookie(req, env);
    const saved = viewer && await env.DB.prepare('SELECT 1 FROM saved_shares WHERE user_id = ? AND token = ?').bind(viewer.id, token).first();
    return json({ ...title, allow_download: !!s.allow_download, public: !!s.public, tracks, preview: PREVIEW_SECS,
      viewer: viewer ? { username: viewer.username, avatar: viewer.avatar || null, mine: viewer.id === s.owner_id, saved: !!saved } : null }, 200, headers);
  }
  if (!(await shareAllowed(req, env, s))) return fail('Password needed', 401);
  const tracks = await shareTracks(env, s);
  const owner = () => getUser(env, s.owner_id);
  const viewer = await userFromCookie(req, env); // signed in to [vault]? (full songs, downloads, saving)

  if (action === 'request' && req.method === 'POST') return requestInvite(req, env, ctx, url, token);
  if (action === 'save') {
    if (!viewer) return fail('Sign in to save this', 401);
    if (req.method === 'DELETE') await env.DB.prepare('DELETE FROM saved_shares WHERE user_id = ? AND token = ?').bind(viewer.id, token).run();
    else await env.DB.prepare('INSERT OR IGNORE INTO saved_shares (user_id, token, created_at) VALUES (?, ?, ?)').bind(viewer.id, token, now()).run();
    return json({ saved: req.method !== 'DELETE' });
  }

  if (action === 'audio' || action === 'download') {
    const t = tracks.find(t => t.id === trackId);
    if (!t) return fail('Not found', 404);
    if (action === 'download') {
      if (!s.allow_download) return fail('Downloads are turned off for this link', 403);
      if (!viewer && !s.public) return fail('Sign in to download', 401);
      return json({ url: `/s/${token}/audio/${t.id}`, filename: `${t.name}.${drive.isDriveKey(t.file_key) ? 'mp3' : ext(t.file_key)}` });
    }
    return viewer || s.public ? streamFile(env, req, t.file_key, await owner(), 'private') : previewFile(env, req, t, await owner());
  }
  if (action === 'cover') {
    const key = url.searchParams.get('k');
    const p = s.kind === 'project' && (await env.DB.prepare('SELECT cover FROM projects WHERE id = ?').bind(s.target_id).first());
    if (!key || !(p?.cover === key || tracks.some(t => t.cover === key))) return fail('Not found', 404);
    return coverFile(env, key, 'public', await owner());
  }
  if (action === 'listen' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const t = tracks.find(t => t.id === b.track_id);
    if (!t) return fail('Not found', 404);
    const who = viewer ? viewer.username : String(b.name || '').trim().slice(0, 80) || 'Anonymous';
    // One notification per listener per half hour, not one per track.
    const recent = await env.DB.prepare('SELECT 1 FROM listens WHERE share_token = ? AND listener_name = ? AND at > ? LIMIT 1').bind(token, who, now() - 30 * 60e3).first();
    const r = await env.DB.prepare('INSERT INTO listens (share_token, listener_name, track_id, at, seconds, duration) VALUES (?, ?, ?, ?, 0, ?) RETURNING id')
      .bind(token, who, t.id, now(), Number(b.duration) || null).first();
    if (!recent) notify(ctx, env, s.owner_id, { title: `${who} is listening`, body: t.name, tag: 'listen-' + token, url: '/' }, url.origin);
    return json({ id: r.id });
  }
  // Timestamped comments: everyone on this link sees them; the owner sees them in the app.
  if (action === 'comments') {
    const tid = url.searchParams.get('track');
    if (!tracks.some(t => t.id === tid)) return fail('Not found', 404);
    return json((await env.DB.prepare('SELECT id, name, at, body, created_at FROM comments WHERE share_token = ? AND track_id = ? ORDER BY created_at').bind(token, tid).all()).results);
  }
  if (action === 'comment' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const t = tracks.find(t => t.id === b.track_id);
    if (!viewer && !s.public) return fail('Sign in to comment', 401);
    const body = String(b.body || '').trim().slice(0, 1000), who = viewer ? viewer.username : String(b.name || '').trim().slice(0, 80) || 'Anonymous';
    if (!t) return fail('Not found', 404);
    if (!body) return fail('Write something first');
    // ponytail: flood guard per link (30 per 10 min); add per-address limits if a link gets abused
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE share_token = ? AND created_at > ?').bind(token, now() - 10 * 60e3).first();
    if (n >= 30) return fail('Too many comments right now. Try again in a few minutes.', 429);
    const at = b.at == null || !isFinite(b.at) ? null : Math.max(0, Number(b.at));
    const c = { id: uid(), name: who, at, body, created_at: now() };
    await env.DB.prepare('INSERT INTO comments (id, share_token, track_id, name, at, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(c.id, token, t.id, who, at, body, viewer?.id || null, c.created_at).run();
    // Tell the owner, and everyone else who has commented on this track, so it becomes a conversation.
    const msg = { title: `${who} commented${at == null ? '' : ' at ' + fmtAt(at)}`, body: `${t.name}: ${body}`.slice(0, 300), tag: 'comment-' + c.id };
    const { results: others } = await env.DB.prepare('SELECT DISTINCT user_id FROM comments WHERE track_id = ? AND user_id IS NOT NULL').bind(t.id).all();
    for (const id of new Set([s.owner_id, ...others.map(r => r.user_id)]))
      if (id !== viewer?.id) notify(ctx, env, id, { ...msg, url: id === s.owner_id ? '/?track=' + t.id : `/s/${token}` }, url.origin);
    return json(c);
  }
  // how far into the track they got (sent while playing and when they leave)
  if (action === 'progress' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare('UPDATE listens SET seconds = MAX(COALESCE(seconds, 0), ?), duration = COALESCE(?, duration) WHERE id = ? AND share_token = ?')
      .bind(Math.max(0, Number(b.seconds) || 0), Number(b.duration) || null, Number(b.id) || 0, token).run();
    return json({ ok: true });
  }
  return fail('Not found', 404);
}

// ---- entry ------------------------------------------------------------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (!env.APP_PASSWORD) return fail('Set the APP_PASSWORD secret first (see README)', 500);
      // Google Search Console ownership check (served as-is; the asset server would redirect away from .html)
      if (path === '/google6e583667ce62f72e.html') return new Response('google-site-verification: google6e583667ce62f72e.html', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (path.startsWith('/s/')) return await handleShare(req, env, url, ctx);
      if (path.startsWith('/blob/') && env.LOCAL) return await localBlob(req, env, path.slice(6));
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

      if (path === '/api/login' && req.method === 'POST') return await login(req, env);
      if (path === '/api/signup' && req.method === 'POST') return await signup(req, env);
      if (path === '/api/request-invite' && req.method === 'POST') return await requestInvite(req, env, ctx, url);
      if (path === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': setCookie('auth', '', '/', 0) });
      if (path === '/api/shortcut-upload' && req.method === 'POST') return await shortcutUpload(req, env, url);
      if (path === '/api/drive/callback') return await driveCallback(req, env, url);
      const u = await userFromCookie(req, env);
      if (!u) return fail('Not logged in', 401);

      for (const [method, re, fn] of routes) {
        const m = req.method === method && re.exec(path);
        if (!m) continue;
        const body = ['POST', 'PATCH'].includes(method) ? await req.json().catch(() => ({})) : {};
        return await fn(req, env, body, m.groups || {}, url, ctx, u);
      }
      return fail('Not found', 404);
    } catch (e) {
      return fail(e.message || 'Something went wrong', e.status || 500);
    }
  },
};

// Local dev only: stands in for B2 using a simulated R2 bucket. Never bound in production.
async function localBlob(req, env, key) {
  if (!KEY_RE.test(key)) return fail('Bad key', 404);
  if (req.method === 'PUT') {
    await env.LOCAL.put(key, req.body, { httpMetadata: { contentType: req.headers.get('content-type') } });
    return new Response(null, { status: 200 });
  }
  const range = req.headers.get('range');
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  const o = await env.LOCAL.get(key, m ? { range: { offset: +m[1], ...(m[2] ? { length: +m[2] - +m[1] + 1 } : {}) } } : {});
  if (!o) return fail('Not found', 404);
  const headers = { 'content-type': o.httpMetadata?.contentType || 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (m) {
    const start = +m[1], end = m[2] ? +m[2] : o.size - 1;
    return new Response(o.body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${o.size}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(o.body, { headers: { ...headers, 'content-length': String(o.size) } });
}
