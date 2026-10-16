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
