// Run: node test.mjs
import assert from 'node:assert/strict';
import { sniff, kindOf } from './public/types.js';
import { encodeWav } from './public/wav.js';

const bytes = (...parts) => {
  const out = new Uint8Array(16);
  let o = 0;
  for (const p of parts) for (const x of typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p) out[o++] = x;
  return out;
};

assert.equal(sniff(bytes('ID3')), 'audio');
assert.equal(sniff(bytes([0xff, 0xfb])), 'audio');
assert.equal(sniff(bytes('RIFF', [0, 0, 0, 0], 'WAVE')), 'audio');
assert.equal(sniff(bytes('fLaC')), 'audio');
assert.equal(sniff(bytes('OggS')), 'audio');
assert.equal(sniff(bytes('FORM', [0, 0, 0, 0], 'AIFF')), 'audio');
assert.equal(sniff(bytes([0, 0, 0, 0x20], 'ftypM4A ')), 'audio');
assert.equal(sniff(bytes([0x1a, 0x45, 0xdf, 0xa3])), 'audio');
assert.equal(sniff(bytes([0xff, 0xd8, 0xff])), 'cover');
assert.equal(sniff(bytes([0x89], 'PNG')), 'cover');
assert.equal(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBP')), 'cover');
assert.equal(sniff(bytes([0, 0, 0, 0x18], 'ftypheic')), 'cover');
assert.equal(sniff(bytes('MZ')), null); // .exe renamed to .mp3
assert.equal(sniff(bytes('PK')), null); // zip

assert.equal(kindOf('beat.WAV'), 'audio');
assert.equal(kindOf('art.heic'), 'cover');
assert.equal(kindOf('beats.zip'), null);
assert.equal(kindOf('video.mp4'), null);
assert.equal(kindOf('noext'), null);

const fake = { numberOfChannels: 2, length: 3, sampleRate: 44100, getChannelData: c => Float32Array.of(0, 1, -1).map(x => x * (c ? -1 : 1)) };
const wav = new Uint8Array(await encodeWav(fake).arrayBuffer());
assert.equal(wav.length, 44 + 3 * 2 * 3);
assert.equal(sniff(wav.slice(0, 16)), 'audio');
const dv = new DataView(wav.buffer);
assert.equal(dv.getUint16(34, true), 24);
assert.deepEqual([...wav.slice(50, 53)], [0xff, 0xff, 0x7f]); // sample 1, left = +1.0
assert.deepEqual([...wav.slice(53, 56)], [0x00, 0x00, 0x80]); // sample 1, right = -1.0

console.log('ok');

// ---- BPM / key detection ----
const { parseName, estimateBpm, estimateKey } = await import('./public/detect.js');
const names = {
  'day2 147 e min.wav': [147, 'E min'],
  'catch me 150 e minor.mp3': [150, 'E min'],
  'bleed + wyd (150x142) G Minor prod. ssixr.wav': [150, 'G min'],
  '155 g# minor time.wav': [155, 'G# min'],
  '154 C#Minor wylin.mp3': [154, 'C# min'],
  '150 F# Major (Reversed, Simple, Pitched).wav': [150, 'F# maj'],
  '0005 (133, f min) prod. 1ssixr.mp3': [133, 'F min'],
  '0004 (148, A Maj, -32 cents or 432hz) prod. 1ssixr.mp3': [148, 'A maj'],
  'Heartburn 158 B maj.mp3': [158, 'B maj'],
  'reliquia 146 g minor prod 1ssixr & 1musgo.wav': [146, 'G min'],
  'Lil Uzi Vert - Feelings Mutual (432Hz).mp3': [null, null],
  'izaya tiji - tom cruise (prod. 1ssixr).mp3': [null, null],
  'I Am Legend 90bpm Bbm.wav': [90, 'A# min'],
  'ssixr 2026.wav': [null, null],
};
for (const [n, [bpm, key]] of Object.entries(names)) assert.deepEqual(parseName(n), { bpm, key }, n);

// synthetic 147 BPM kick + hats, 30 s at 22050 Hz
const sr = 22050, secs = 30, x = new Float32Array(sr * secs), beat = 60 / 147;
for (let i = 0; i < x.length; i++) {
  const t = i / sr, ph = t % beat, ph8 = t % (beat / 2);
  x[i] = Math.sin(2 * Math.PI * 55 * ph) * Math.exp(-ph * 30) * 0.8 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.exp(-ph8 * 200) * 0.2;
}
assert.equal(estimateBpm(x, sr), 147);

// synthetic E minor: i–VI–VII–i chords (Em, C, D, Em) over a tonic bass
const hz = m => 440 * 2 ** ((m - 69) / 12), y = new Float32Array(sr * 16);
const chords = [[52, 64, 67, 71], [48, 64, 67, 72], [50, 66, 69, 74], [52, 64, 67, 71]];
for (let i = 0; i < y.length; i++) {
  const t = i / sr, ch = chords[Math.floor(t / 4) % 4];
  y[i] = ch.reduce((s, m, j) => s + Math.sin(2 * Math.PI * hz(m) * t) * (j ? 0.25 : 0.5), 0);
}
assert.equal(estimateKey(y, sr), 'E min');

console.log('detect ok');

// ---- ZIP writer ----
const { crc32, makeZip, safeName } = await import('./public/zip.js');
assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
assert.equal(safeName('a/b:c*?"<>|d'), 'a_b_c______d');
const zip = new Uint8Array(await (await makeZip([{ name: 'p/one.txt', data: 'hello' }, { name: 'two.bin', data: new Uint8Array([1, 2, 3]) }])).arrayBuffer());
const zv = new DataView(zip.buffer);
assert.equal(zv.getUint32(0, true), 0x04034b50);
assert.equal(zv.getUint32(14, true), 0x3610a686);
const eocd = zip.length - 22;
assert.equal(zv.getUint32(eocd, true), 0x06054b50);
assert.equal(zv.getUint16(eocd + 10, true), 2);
const cdOffset = zv.getUint32(eocd + 16, true);
assert.equal(zv.getUint32(cdOffset, true), 0x02014b50);
if (process.platform === 'win32') { // real-world check: let Windows' own tar open it
  const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'ziptest-'));
  writeFileSync(join(dir, 't.zip'), zip);
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', 't.zip'], { cwd: dir }); // Windows' tar reads ZIPs
  assert.equal(readFileSync(join(dir, 'p', 'one.txt'), 'utf8'), 'hello');
}
console.log('zip ok');

// ---- waveforms: 100 bars, loudest = 63, silence = 0 ----
{
  const { peaksOf, decodePeaks, resample, waveSvg } = await import('./public/wave.js');
  const len = 44100, data = new Float32Array(len);
  for (let i = 0; i < len; i++) data[i] = i < len / 2 ? 0 : Math.sin(i / 10) * (i / len); // silent, then a swell
  const p = peaksOf({ numberOfChannels: 1, getChannelData: () => data });
  assert.equal(p.length, 100);
  assert.match(p, /^[A-Za-z0-9+/]{100}$/);
  const v = decodePeaks(p);
  assert.equal(v[0], 0);
  assert.equal(Math.max(...v), 1);
  assert.ok(v[99] > v[60], 'the swell gets louder');
  assert.equal(resample(v, 48).length, 48);
  assert.match(waveSvg(p), /^<svg class="w0".*<svg class="w1"/);
  console.log('wave ok');
}

// ---- push: what the server sends decrypts on the phone's side (RFC 8291), and the VAPID JWT verifies ----
{
  const { encryptPush, vapidHeader, makeVapidKeys, b64u, unb64u } = await import('./push.js');
  const { subtle } = globalThis.crypto;
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = { title: 'Mike is listening', body: 'catch me 150 e minor' };
  const sealed = await encryptPush({ p256dh: b64u(uaPub), auth: b64u(auth) }, msg);
  // decrypt as the browser would
  const salt = sealed.slice(0, 16), rs = new DataView(sealed.buffer).getUint32(16), idlen = sealed[20], asPub = sealed.slice(21, 21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hkdf = async (s, ikm, info, n) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = s => new TextEncoder().encode(s);
  const ikm = await hkdf(auth, shared, new Uint8Array([...te('WebPush: info\0'), ...uaPub, ...asPub]), 32);
  const cek = await subtle.importKey('raw', await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12) }, cek, sealed.slice(21 + idlen)));
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), msg);
  // VAPID
  const keys = await makeVapidKeys();
  assert.equal(unb64u(keys.pub).length, 65);
  const hdr = await vapidHeader(keys, 'https://web.push.apple.com/abc', 'https://vault.example');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(hdr);
  assert.equal(k, keys.pub);
  const [h64, c64, s64] = jwt.split('.');
  const claims = JSON.parse(new TextDecoder().decode(unb64u(c64)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://vault.example');
  const pubKey = await subtle.importKey('raw', unb64u(keys.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, unb64u(s64), te(h64 + '.' + c64)), 'VAPID signature verifies');
  console.log('push ok');
}

// ---- editor: key after a pitch change ----
{
  const { shiftKey } = await import('./public/detect.js');
  assert.equal(shiftKey('G min', -2.02), 'F min'); // speed 89%
  assert.equal(shiftKey('C maj', -1), 'B maj');
  assert.equal(shiftKey('A# min', 3), 'C# min');
  assert.equal(shiftKey('G min', 0), 'G min');
  assert.equal(shiftKey(null, 2), null);
  console.log('key shift ok');
}

{ // Google Drive helpers: file keys, and the encrypted refresh token round-trips (and fails with the wrong secret)
  const d = await import('./drive.js');
  assert.ok(d.DRIVE_KEY_RE.test('drive:audio:1AbC_dEf-2345678'));
  assert.ok(!d.DRIVE_KEY_RE.test('drive:audio:../../x') && !d.DRIVE_KEY_RE.test('drive:video:1AbC_dEf-2345678'));
  assert.equal(d.driveId('drive:cover:1AbC_dEf-2345678'), '1AbC_dEf-2345678');
  const sealed = await d.seal('s3cret', 'refresh-token');
  assert.equal(await d.unseal('s3cret', sealed), 'refresh-token');
  await assert.rejects(d.unseal('other', sealed));
  console.log('drive ok');
}
