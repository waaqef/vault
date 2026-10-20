// Sharing permissions, end to end: owner / editor / listener / stranger / visitor, against a throwaway local
// server with an empty database. `npm run test:access` (needs .dev.vars with APP_PASSWORD, like `npm run dev:local`).
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8799, B = `http://localhost:${PORT}`;
const PW = /APP_PASSWORD=(.+)/.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();
if (await fetch(B + '/').then(() => true, () => false)) throw new Error(`Port ${PORT} is already in use (a test server left running?). Stop it and try again.`);
const dir = mkdtempSync(join(tmpdir(), 'vault-access-'));
execSync(`npx wrangler d1 execute vault --local --env local --persist-to "${dir}" --file=schema.sql`, { stdio: 'ignore' });
const server = spawn('npx', ['wrangler', 'dev', '--env', 'local', '--port', String(PORT), '--persist-to', dir], { shell: true, stdio: 'ignore' });

const cookieOf = r => (r.headers.get('set-cookie') || '').match(/auth=[^;]+/)?.[0];
async function call(cookie, method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = text; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, bytes: text.length, cookie: cookieOf(r) };
}
// A real (silent) one-second WAV, so the server's "is this really audio" check passes.
function wav(seconds = 1) {
  const n = 44100 * seconds, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

try {
  for (let i = 0; ; i++) { try { if ((await fetch(B + '/')).ok) break; } catch {} if (i > 60) throw new Error('server did not start'); await new Promise(r => setTimeout(r, 1000)); }

  const owner = (await call(null, 'POST', '/api/login', { password: PW })).cookie;
  assert.ok(owner, 'admin logs in with the admin password');
  const person = async (name, display_name) => {
    const { data } = await call(owner, 'POST', '/api/admin/invites');
    const r = await call(null, 'POST', '/api/signup', { invite: data.code, username: name, display_name, password: 'password123' });
    assert.ok(r.cookie, `${name} signs up with an invite (${JSON.stringify(r.data)})`);
    return r.cookie;
  };
  const [editor, listener, stranger] = [await person('eddie'), await person('lisa', 'Lisa L'), await person('stranger')];

  // usernames are unique; trying a taken one doesn't use up the invite
  const { data: { code } } = await call(owner, 'POST', '/api/admin/invites');
  assert.equal((await call(null, 'POST', '/api/signup', { invite: code, username: 'lisa', password: 'password123' })).data.error, 'That username is taken.');
  assert.ok((await call(null, 'POST', '/api/signup', { invite: code, username: 'lisa2', password: 'password123' })).cookie, 'the invite still works after a taken username');

  const { data: { id: project } } = await call(owner, 'POST', '/api/projects', { name: 'Beats' });
  const audio = wav(10), up = (await call(owner, 'POST', '/api/upload-url', { name: 'a.wav', type: 'audio/wav', size: audio.length })).data;
  await fetch(B + up.url, { method: 'PUT', body: audio, headers: { 'content-type': 'audio/wav' } });
  const { data: { id: track } } = await call(owner, 'POST', '/api/tracks', { project_id: project, name: 'a', file_key: up.key, duration: 10 });
  assert.equal((await call(owner, 'POST', `/api/projects/${project}/members`, { username: 'eddie', role: 'editor' })).status, 200);
  assert.equal((await call(owner, 'POST', `/api/projects/${project}/members`, { username: 'lisa', role: 'viewer' })).status, 200);

  // listening: everyone on the project, nobody else
  for (const [who, c, want] of [['owner', owner, 200], ['editor', editor, 200], ['listener', listener, 200], ['stranger', stranger, 404]])
    assert.equal((await call(c, 'GET', `/api/audio/${track}`)).status, want, `${who} playing a track`);
  assert.equal((await call(stranger, 'GET', '/api/tree')).data.shared.projects.length, 0, "a stranger doesn't see the project");
  assert.equal((await call(listener, 'GET', '/api/tree')).data.shared.projects[0].role, 'viewer', 'the listener sees it as listen-only');

  // changing things: owner and editor only
  for (const [who, c, want] of [['editor', editor, 200], ['listener', listener, 404], ['stranger', stranger, 404]])
    assert.equal((await call(c, 'PATCH', `/api/tracks/${track}`, { bpm: 140 })).status, want, `${who} editing a track`);
  assert.equal((await call(listener, 'POST', '/api/upload-url', { name: 'b.wav', type: 'audio/wav', size: 100, project_id: project })).status, 403, 'a listener uploading');
  assert.equal((await call(listener, 'GET', `/api/tracks/${track}/versions`)).status, 404, 'a listener reading versions');

  // owner-only: delete the project, see its links, manage its people
  await call(editor, 'DELETE', `/api/projects/${project}`);
  assert.equal((await call(owner, 'GET', '/api/tree')).data.projects.length, 1, "an editor can't delete the project");
  assert.equal((await call(editor, 'GET', `/api/projects/${project}/members`)).status, 404, "an editor can't see who's on it");
  assert.equal((await call(editor, 'POST', `/api/projects/${project}/members`, { username: 'stranger', role: 'editor' })).status, 404, "an editor can't add people");
  assert.deepEqual((await call(editor, 'GET', `/api/shares?kind=project&target_id=${project}`)).data, [], "an editor can't see its links");

  // comments: people on the project yes, strangers no
  assert.equal((await call(listener, 'POST', `/api/tracks/${track}/comments`, { body: 'nice', at: 3 })).status, 200, 'a listener commenting');
  const [said] = (await call(owner, 'GET', `/api/tracks/${track}/comments`)).data;
  assert.equal(said.name, 'Lisa L', 'comments show the display name');
  assert.ok(said.user_id, 'comments say who wrote them (so people can delete their own)');
  assert.equal((await call(owner, 'GET', `/api/projects/${project}/members`)).data.find(m => m.username === 'lisa').display_name, 'Lisa L');
  assert.equal((await call(stranger, 'POST', `/api/tracks/${track}/comments`, { body: 'hi' })).status, 404, 'a stranger commenting');

  // share links: signed-out visitors get a short preview; a public link plays in full
  const { data: { token } } = await call(owner, 'POST', '/api/shares', { kind: 'project', target_id: project, allow_download: true });
  const preview = await call(null, 'GET', `/s/${token}/audio/${track}`), full = await call(listener, 'GET', `/s/${token}/audio/${track}?full=1`);
  assert.ok(preview.bytes < full.bytes / 1.1, 'a visitor only gets the start of the file');
  assert.equal((await call(null, 'GET', `/s/${token}/download/${track}`)).status, 401, "a visitor can't download");
  await call(owner, 'PATCH', `/api/shares/${token}`, { public: true });
  assert.ok((await call(null, 'GET', `/s/${token}/audio/${track}?full=1`)).bytes >= full.bytes, 'a public link plays in full');

  // bad edits are ignored rather than breaking the track: no project, a blank name
  await call(owner, 'PATCH', `/api/tracks/${track}`, { project_id: null, name: '   ' });
  const kept = (await call(owner, 'GET', '/api/tree')).data.tracks.find(t => t.id === track);
  assert.ok(kept && kept.project_id === project && kept.name === 'a', 'a track keeps its project and name');

  // deleting for good goes in batches (a free-plan Worker can only make 50 requests per call)
  const { data: { id: big } } = await call(owner, 'POST', '/api/projects', { name: 'Big' });
  const keys = [];
  for (let i = 0; i < 40; i += 10) await Promise.all(Array.from({ length: 10 }, async () => {
    const small = wav(0.1), u2 = (await call(owner, 'POST', '/api/upload-url', { name: 'b.wav', type: 'audio/wav', size: small.length, project_id: big })).data;
    await fetch(B + u2.url, { method: 'PUT', body: small, headers: { 'content-type': 'audio/wav' } });
    await call(owner, 'POST', '/api/tracks', { project_id: big, name: 'b', file_key: u2.key, duration: 0.1 });
    keys.push(u2.key);
  }));
  await call(owner, 'DELETE', `/api/trash/project/${big}`);
  assert.ok((await call(owner, 'GET', '/api/tree')).data.projects.some(p => p.id === big), 'only things in the trash can be deleted for good');
  await call(owner, 'DELETE', `/api/projects/${big}`);
  let calls = 0;
  for (let more = true; more; calls++) more = (await call(owner, 'DELETE', `/api/trash/project/${big}`)).data.more;
  assert.ok(calls > 1, 'a big project takes more than one call');
  assert.equal((await call(owner, 'GET', '/api/trash')).data.projects.length, 0, 'and then it is gone');
  assert.equal((await fetch(`${B}/blob/${keys[0]}`)).status, 404, 'with its files');

  // leaving and removing
  await call(listener, 'POST', '/api/shared/leave', { project_id: project });
  assert.equal((await call(listener, 'GET', `/api/audio/${track}`)).status, 404, 'after leaving, the listener has no access');
  console.log('access ok');
} finally {
  // stop the whole process tree (npx → wrangler → workerd), children first, or wrangler restarts the server
  try { execSync(process.platform === 'win32' ? `taskkill /pid ${server.pid} /T /F` : `pkill -P ${server.pid}`, { stdio: 'ignore' }); } catch {}
  server.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
