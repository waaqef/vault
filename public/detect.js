// BPM and key detection. File name first (it's what the producer wrote), then the audio itself.
// The analysis runs locally in the browser; nothing is uploaded for it.

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PC = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };

// "147 e min", "C#Minor", "(150x142) G Minor", "0005 (133, f min)", "F#m", "155bpm" → { bpm, key }
export function parseName(name) {
  const s = name.replace(/\.[^.]+$/, '').replace(/♯/g, '#').replace(/♭/g, 'b');
  let bpm = null;
  const tagged = s.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i);
  if (tagged) bpm = +tagged[1];
  else {
    // a 2–3 digit number, not part of a longer number, and not Hz / cents / %
    for (const m of s.matchAll(/(?<![\d.])(\d{2,3})(?![\d.]|\s*(?:k?hz|cents?|%))/gi)) {
      const v = +m[1];
      if (v >= 60 && v <= 200) { bpm = v; break; }
    }
  }
  let key = null;
  const word = s.match(/(?<![a-z])([a-g])\s?([#b])?\s?(major|maj|minor|min)(?![a-z])/i); // "e min", "C#Minor", "A Maj"
  const short = s.match(/(?<![a-z])([a-g])([#b])m(?![a-z])/i); // "F#m", "Bbm" (needs the sharp/flat so "I Am" doesn't count)
  const m = word || short;
  if (m) {
    const pc = PC[(m[1] + (m[2] || '')).toLowerCase()];
    const minor = word ? /^min/i.test(m[3]) : true;
    if (pc !== undefined) key = `${NOTES[pc]} ${minor ? 'min' : 'maj'}`;
  }
  return { bpm, key };
}

// ---- audio analysis --------------------------------------------------------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// Calls onFrame(magnitudes) for each windowed frame.
function frames(x, size, hop, onFrame) {
  const win = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float32Array(size), im = new Float32Array(size), mag = new Float32Array(size / 2);
  for (let start = 0; start + size <= x.length; start += hop) {
    for (let i = 0; i < size; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(mag);
  }
}

// Tempo from an onset-strength curve (spectral flux), scored by how well it repeats at each candidate beat length.
export function estimateBpm(x, sr) {
  const size = 1024, hop = 128, fps = sr / hop;
  const env = [];
  let prev = null;
  frames(x, size, hop, mag => {
    const lm = mag.map(v => Math.log1p(100 * v));
    let flux = 0;
    if (prev) for (let k = 1; k < lm.length; k++) { const d = lm[k] - prev[k]; if (d > 0) flux += d; }
    env.push(flux);
    prev = lm;
  });
  // keep only what rises above the local average (the hits)
  const w = Math.round(fps / 2), e = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) { s += env[j]; n++; }
    e[i] = Math.max(0, env[i] - s / n);
  }
  // Fold the hits onto one beat length: at the true tempo they all land in the same few phase bins.
  const total = e.reduce((s, v) => s + v, 0) || 1;
  const score = bpm => {
    const p = (fps * 60) / bpm, bins = Math.max(8, Math.round(p / 2)), hist = new Float64Array(bins);
    for (let t = 0; t < e.length; t++) if (e[t]) hist[Math.floor(((t % p) / p) * bins) % bins] += e[t];
    let peak = 0;
    for (let i = 0; i < bins; i++) peak = Math.max(peak, hist[(i + bins - 1) % bins] + hist[i] + hist[(i + 1) % bins]);
    return peak / total;
  };
  let best = 0, bestScore = -1;
  for (let b = 70; b <= 175; b += 0.25) { const sc = score(b); if (sc >= bestScore) { bestScore = sc; best = b; } } // >= : ties go to the faster tempo
  for (let b = best - 0.5; b <= best + 0.5; b += 0.02) { const sc = score(b); if (sc > bestScore) { bestScore = sc; best = b; } }
  return bestScore > 0 ? Math.round(best) : null;
}

// Key: average pitch-class energy, matched against the Krumhansl–Kessler major/minor profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export function estimateKey(x, sr) {
  const size = 8192, hop = 4096, chroma = new Float64Array(12);
  const pcOf = new Int8Array(size / 2).fill(-1);
  for (let k = 1; k < size / 2; k++) {
    const f = (k * sr) / size;
    if (f >= 55 && f <= 2000) pcOf[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }
  const frame = new Float64Array(12);
  frames(x, size, hop, mag => {
    frame.fill(0);
    for (let k = 1; k < mag.length; k++) if (pcOf[k] >= 0) frame[pcOf[k]] += mag[k];
    const sum = frame.reduce((a, b) => a + b, 0);
    if (sum > 1e-6) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / sum; // each frame counts equally
  });
  if (!chroma.some(v => v > 0)) return null;
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db || 1);
  };
  let best = null, bestR = -2;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = p => Array.from({ length: 12 }, (_, i) => p[(i - tonic + 12) % 12]);
    for (const [mode, prof] of [['maj', MAJOR], ['min', MINOR]]) {
      const r = corr(chroma, rot(prof));
      if (r > bestR) { bestR = r; best = `${NOTES[tonic]} ${mode}`; }
    }
  }
  return best;
}

// Decoding is shared with the waveform, so an upload is only decoded once.
export async function decodeAudio(blob) {
  return new OfflineAudioContext(1, 1, 22050).decodeAudioData(await blob.arrayBuffer());
}

// Name first; fill whatever's missing by analysing up to 60 seconds from the middle of the track.
export function bpmKeyOf(buf, name) {
  const found = parseName(name || '');
  if (found.bpm && found.key) return found;
  const sr = buf.sampleRate, len = Math.min(buf.length, 60 * sr), start = Math.floor((buf.length - len) / 2);
  const mono = new Float32Array(len);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[start + i] / buf.numberOfChannels;
  }
  return { bpm: found.bpm ?? estimateBpm(mono, sr), key: found.key ?? estimateKey(mono, sr) };
}

// "G min" moved by n semitones (rounded) → "F min".
export function shiftKey(k, st) {
  const [n, mode] = (k || '').split(' '), i = NOTES.indexOf(n);
  return i < 0 || !mode ? k : `${NOTES[(((i + Math.round(st)) % 12) + 12) % 12]} ${mode}`;
}

// ---- what a file says about itself: title, artist, producer, track number ---------------------------------
// From its tags when it has them (MP3 / ID3, M4A / MP4, FLAC) and from its name: "03 - Song (prod. X)", "01. Song",
// "Song prod. X", "Artist - Song". The name wins for the title (it's what the producer wrote, BPM and key included)
// unless it's a generic one like "Track 03" or "New Recording 5"; tags fill in the artist and track number.
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const utf8 = b => new TextDecoder('utf-8').decode(b).replace(/\0+$/, '').trim();
const bytes = async (file, o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer());

function id3(b) {
  const ver = b[3], end = Math.min(b.length, 10 + synchsafe(b, 6)), out = {};
  if (ver < 3) return out; // ID3v2.2 (very old files): skipped
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? synchsafe(b, 10) : be32(b, 10) + 4; // extended header
  const text = d => {
    const enc = d[0], body = d.subarray(1);
    const s = enc === 1 ? new TextDecoder('utf-16').decode(body) : enc === 2 ? new TextDecoder('utf-16be').decode(body) : enc === 3 ? utf8(body) : new TextDecoder('windows-1252').decode(body);
    return s.replace(/\0+$/, '').trim();
  };
  while (o + 10 <= end) {
    const id = ascii(b, o, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4 ? synchsafe(b, o + 4) : be32(b, o + 4), d = b.subarray(o + 10, o + 10 + len);
    o += 10 + len;
    if (id === 'TIT2') out.title = text(d);
    else if (id === 'TPE1') out.artist = text(d);
    else if (id === 'TRCK') out.track = parseInt(text(d)) || null;
    else if (id === 'TPOS') out.disc = parseInt(text(d)) || null;
    else if (id === 'TXXX') { const [k, v] = text(d).split('\0'); if (/produc/i.test(k || '') && v) out.producer = v.trim(); }
  }
  return out;
}
function mp4Tags(b) {
  const out = {};
  const each = (from, to, fn) => { for (let o = from; o + 8 <= to;) { const len = be32(b, o); if (len < 8) break; fn(ascii(b, o + 4, 4), o + 8, Math.min(to, o + len)); o += len; } };
  const walk = (from, to) => each(from, to, (t, s, e) => {
    if (t === 'udta') walk(s, e);
    else if (t === 'meta') walk(s + 4, e); // a version / flags word comes first
    else if (t === 'ilst') each(s, e, (key, is, ie) => each(is, ie, (dt, ds, de) => {
      if (dt !== 'data') return;
      const v = b.subarray(ds + 8, de); // after its type and locale
      if (key === '©nam') out.title = utf8(v);
      else if (key === '©ART') out.artist = utf8(v);
      else if (key === 'trkn') out.track = ((v[2] << 8) | v[3]) || null;
      else if (key === 'disk') out.disc = ((v[2] << 8) | v[3]) || null;
    }));
  });
  walk(0, b.length);
  return out;
}
async function mp4(file) {
  for (let o = 0, i = 0; i < 64 && o + 8 <= file.size; i++) {
    const h = await bytes(file, o, 16);
    let len = be32(h, 0), head = 8;
    if (len === 1) { len = be32(h, 8) * 2 ** 32 + be32(h, 12); head = 16; } else if (len === 0) len = file.size - o;
    if (len < 8) break;
    if (ascii(h, 4, 4) === 'moov') return len > 64e6 ? {} : mp4Tags(await bytes(file, o + head, len - head));
    o += len;
  }
  return {};
}
async function flac(file) {
  for (let o = 4, i = 0; i < 64 && o + 4 <= file.size; i++) {
    const h = await bytes(file, o, 4), type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) { // Vorbis comments: KEY=value
      const b = await bytes(file, o + 4, len), out = {};
      let p = 4 + le32(b, 0);
      const n = le32(b, p); p += 4;
      for (let k = 0; k < n && p + 4 <= b.length; k++) {
        const l = le32(b, p), kv = utf8(b.subarray(p + 4, p + 4 + l)); p += 4 + l;
        const at = kv.indexOf('='), key = kv.slice(0, at).toUpperCase(), v = kv.slice(at + 1).trim();
        if (key === 'TITLE') out.title = v; else if (key === 'ARTIST') out.artist = v;
        else if (key === 'TRACKNUMBER') out.track = parseInt(v) || null; else if (key === 'PRODUCER') out.producer = v;
        else if (key === 'DISCNUMBER') out.disc = parseInt(v) || null;
      }
      return out;
    }
    if (h[0] & 0x80) break; // that was the last block
    o += 4 + len;
  }
  return {};
}
export async function readTags(file) {
  try {
    const head = await bytes(file, 0, 512 * 1024);
    if (ascii(head, 0, 3) === 'ID3') {
      const size = 10 + synchsafe(head, 6); // the tag can hold a big cover picture: read all of it (up to 16 MB)
      return id3(size > head.length ? await bytes(file, 0, Math.min(size, 16e6)) : head);
    }
    if (ascii(head, 4, 4) === 'ftyp') return await mp4(file);
    if (ascii(head, 0, 4) === 'fLaC') return await flac(file);
  } catch {}
  return {};
}
// "03 - Song (prod. Che)" -> { title: 'Song', track: 3, prod: 'Che' }. A leading number only counts as a track number
// when it's zero-padded ("01 Song") or followed by . - ) etc ("1. Song"), so "50 Cent" and "150 e minor" are left alone.
// numbered: the leading numbers of the names it came with (leadNumbers). A plain "10 Song" is track 10 when there's
// a number just before or after it in the same album ("09 Song", "11 Song"); plain numbers under 10 never are.
export const parseTitle = (raw, artist = '', numbered = null) =>
  cleanTitle(String(raw || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' '), artist, numbered);
// The same for a name already in the library: no extension, and its underscores are left as they are.
export const leadNumbers = names => new Set(names.map(n => /^(?:\d-)?(\d{1,3})(?:\s|[._-])/.exec(String(n || ''))?.[1]).filter(Boolean).map(Number));
export function cleanTitle(name, artist = '', numbered = null) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  let track = null, prod = null, disc = null;
  const n = s.match(/^(?:track\s*)?(?:(\d)-(?=\d\d\s))?[([]?(\d{1,3})[)\]]?(?:\s*[.\-–—:)]\s*|\s+)(?=\S)/i); // "1-01 Song": disc 1, track 1
  if (n && ((+n[2] >= 10 && [-3, -2, -1, 1].some(k => numbered?.has?.(+n[2] + k))) || /^0\d/.test(n[2]) || /[.\-–—:)\]]/.test(n[0]) || /^track/i.test(n[0]))) { track = +n[2]; disc = n[1] ? +n[1] : null; s = s.slice(n[0].length); }
  const p = s.match(/\s*[([{]\s*(?:prod(?:uced)?\.?(?:\s*by)?)\s*[:.]?\s*([^)\]}]+)[)\]}]/i) || s.match(/\s+[-–—|]?\s*prod(?:uced)?\.?(?:\s*by)?[:.]?\s+(.+)$/i);
  if (p) { prod = p[1].replace(/[\s+&,-]+$/, '').trim() || null; s = (s.slice(0, p.index) + s.slice(p.index + p[0].length)).trim(); }
  if (artist) {
    const a = artist.toLowerCase(), low = s.toLowerCase();
    if (low.startsWith(a + ' - ')) s = s.slice(artist.length + 3); else if (low.endsWith(' - ' + a)) s = s.slice(0, -(artist.length + 3));
  }
  return { title: s.trim() || String(name || ''), track, prod, disc };
}
export async function trackInfo(file, numbered = null) {
  const tags = await readTags(file);
  const byName = parseTitle(file.name, tags.artist, numbered);
  const fromTag = tags.title ? parseTitle(tags.title, tags.artist) : null;
  const generic = /^(?:track|audio|untitled|new recording|recording|voice memo|bounce|export|mixdown|master)?\s*\d*$/i.test(byName.title) || /^[0-9a-f-]{16,}$/i.test(byName.title);
  return {
    title: generic && fromTag?.title ? fromTag.title : byName.title,
    artist: tags.artist || '',
    prod: byName.prod || fromTag?.prod || tags.producer || '',
    track: byName.track ?? tags.track ?? fromTag?.track ?? null,
    disc: byName.disc ?? tags.disc ?? null,
  };
}
