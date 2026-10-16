// Waveforms: 100 bars stored as one base64 character each (0–63), so a track's whole waveform is a 100-character string.
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const BARS = 100;

// Loudness (RMS) of each slice, scaled so the loudest bar is full height. RMS keeps the shape visible on loud, limited beats.
export function peaksOf(buffer, bars = BARS) {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const len = chans[0].length, step = Math.max(1, Math.floor(len / bars / 2000)); // ~2000 samples per bar is plenty
  const out = [];
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * len) / bars), to = Math.max(from + 1, Math.floor(((b + 1) * len) / bars));
    let sum = 0, n = 0;
    for (const d of chans) for (let i = from; i < to && i < len; i += step) { sum += d[i] * d[i]; n++; }
    out.push(Math.sqrt(sum / (n || 1)));
  }
  const top = Math.max(...out) || 1;
  return out.map(v => ABC[Math.round((v / top) * 63)]).join('');
}

export const decodePeaks = s => [...(s || '')].map(ch => Math.max(0, ABC.indexOf(ch)) / 63);

// `bars` bars from the stored 100 (loudest of each group).
export function resample(v, bars) {
  return Array.from({ length: bars }, (_, i) => {
    const a = Math.floor((i * v.length) / bars), b = Math.max(a + 1, Math.floor(((i + 1) * v.length) / bars));
    return Math.max(...v.slice(a, b));
  });
}

// Loud beats are loud almost everywhere; a curve brings out the shape (quiet parts drop away faster).
export const shape = x => x ** 1.8;

// Two stacked copies: the base and the played part (clipped to --p by CSS).
export function waveSvg(s, bars = 30) {
  const v = resample(decodePeaks(s), bars), w = bars * 3;
  const d = v.map((x, i) => { const hh = Math.max(1.5, shape(x) * 22); return `M${i * 3 + 1} ${((24 - hh) / 2).toFixed(1)}v${hh.toFixed(1)}`; }).join('');
  const svg = cls => `<svg class="${cls}" viewBox="0 0 ${w} 24" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
  return svg('w0') + svg('w1');
}
