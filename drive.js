// Google Drive storage for invited users: their music lives in their own Drive, in a "[vault]" folder the app creates.
// Scope drive.file = the app can only see files it made, nothing else in their Drive.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// File keys for Drive files: drive:<audio|cover>:<fileId>
export const DRIVE_KEY_RE = /^drive:(audio|cover):[A-Za-z0-9_-]{10,200}$/;
export const isDriveKey = k => typeof k === 'string' && k.startsWith('drive:');
export const driveId = k => k.split(':')[2];
export const driveKind = k => k.split(':')[1];

// ---- the refresh token is stored encrypted (AES-GCM, key derived from the server secret) ----
async function secretKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + ':drive-token'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function seal(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(secret), new TextEncoder().encode(text));
  return b64(iv) + '.' + b64(ct);
}
export async function unseal(secret, sealed) {
  const [iv, ct] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await secretKey(secret), unb64(ct)));
}

// ---- OAuth ----
export const authUrl = (clientId, redirect, state) => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: DRIVE_SCOPE,
  access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
});
export async function exchangeCode(env, code, redirect) {
  const r = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams({
    code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code',
  }) });
  const d = await r.json();
  if (!r.ok || !d.refresh_token) throw Object.assign(new Error(d.error_description || d.error || "Google didn't give access"), { status: 400 });
  return d; // { access_token, refresh_token, expires_in }
}
// Access tokens last an hour; keep them per user for the life of this Worker instance.
const tokens = new Map();
export async function accessToken(env, user) {
  const hit = tokens.get(user.id);
  if (hit && hit.exp > Date.now() + 60e3) return hit.token;
  if (!user.drive_refresh) throw Object.assign(new Error('Google Drive isn\'t connected. Open Settings → Account → Connect Google Drive.'), { status: 409 });
  const r = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams({
    refresh_token: await unseal(env.APP_PASSWORD, user.drive_refresh), client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
  }) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error('Google Drive access was removed. Reconnect it in Settings → Account.'), { status: 409 });
  tokens.set(user.id, { token: d.access_token, exp: Date.now() + d.expires_in * 1000 });
  return d.access_token;
}
export const forget = id => tokens.delete(id);
const authed = async (env, user, extra = {}) => ({ authorization: `Bearer ${await accessToken(env, user)}`, ...extra });

// ---- files ----
export async function makeFolder(env, user) {
  const r = await fetch(`${API}/files?fields=id`, { method: 'POST', headers: await authed(env, user, { 'content-type': 'application/json' }),
    body: JSON.stringify({ name: '[vault]', mimeType: 'application/vnd.google-apps.folder' }) });
  if (!r.ok) throw new Error(`Couldn't make the [vault] folder in Drive (${r.status})`);
  return (await r.json()).id;
}
// A resumable upload session the browser (or the Worker) PUTs the file to. `origin` lets the browser upload directly (CORS).
export async function uploadSession(env, user, { name, type, size, origin }) {
  const r = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,size`, { method: 'POST',
    headers: await authed(env, user, { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': type, 'x-upload-content-length': String(size), ...(origin ? { origin } : {}) }),
    body: JSON.stringify({ name, parents: user.drive_folder ? [user.drive_folder] : undefined }) });
  if (!r.ok) throw Object.assign(new Error(r.status === 403 ? 'Your Google Drive is full' : `Google Drive refused the upload (${r.status})`), { status: r.status === 403 ? 507 : 502 });
  return r.headers.get('location');
}
// GET a file's bytes (Range passes through, so seeking works).
export async function fetchFile(env, user, key, range) {
  return fetch(`${API}/files/${driveId(key)}?alt=media`, { headers: await authed(env, user, range ? { range } : {}) });
}
export async function fileInfo(env, user, key) {
  const r = await fetch(`${API}/files/${driveId(key)}?fields=size,mimeType`, { headers: await authed(env, user) });
  return r.ok ? r.json() : null;
}
// Is this folder still there (and visible to the connected Google account)?
export async function folderOk(env, user, id) {
  const r = await fetch(`${API}/files/${id}?fields=id,trashed`, { headers: await authed(env, user) });
  return r.ok && !(await r.json()).trashed;
}
export async function deleteFile(env, user, key) {
  const r = await fetch(`${API}/files/${driveId(key)}`, { method: 'DELETE', headers: await authed(env, user) });
  return { ok: r.ok || r.status === 404 };
}
export async function quota(env, user) {
  const r = await fetch(`${API}/about?fields=storageQuota,user(emailAddress)`, { headers: await authed(env, user) });
  if (!r.ok) return null;
  const d = await r.json();
  return { used: +d.storageQuota.usage || 0, limit: +d.storageQuota.limit || 15e9, email: d.user?.emailAddress || '' };
}
