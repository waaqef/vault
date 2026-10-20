import { encodeWav } from './wav.js';
import { MAX } from './types.js';
import { icon } from './icons.js';
import { settings } from './settings.js';
import { peaksOf } from './wave.js';
import { shiftKey } from './detect.js';
import { PitchShifter, SoundTouch, SimpleFilter, WebAudioBufferSource } from './lib/soundtouch.js';

// ponytail: audio is decoded and rendered at 44.1 kHz. Other source rates get resampled; read the file's real rate if that matters.
const PREFERRED_RATE = 44100;
const db = x => Math.pow(10, x / 20);
const toDb = g => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const TYPES = { peaking: 'Bell', lowshelf: 'Low shelf', highshelf: 'High shelf', highpass: 'High-pass', lowpass: 'Low-pass', notch: 'Notch' };
const HAS_GAIN = t => ['peaking', 'lowshelf', 'highshelf'].includes(t);
const SHELF = t => t === 'lowshelf' || t === 'highshelf'; // Web Audio shelves have no Q
const CUT = t => t === 'highpass' || t === 'lowpass';
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const defaults = () => ({
  varispeed: 1, tempo: 1, pitch: 0,
  inGain: 0, outGain: 0, pan: 0,
  eqOn: true,
  eq: [
    { type: 'lowshelf', freq: 100, gain: 0, q: 0.7 },
    { type: 'peaking', freq: 500, gain: 0, q: 1 },
    { type: 'peaking', freq: 2500, gain: 0, q: 1 },
    { type: 'highshelf', freq: 8000, gain: 0, q: 0.7 },
  ],
  comp: { on: false, threshold: -24, ratio: 4, knee: 6, attack: 10, release: 250, makeup: 0 },
  limit: { on: false, ceiling: -1 },
});

// The processing chain. Built the same way for live preview and for the final render, so they match.
function makeChain(ctx, s) {
  const gain = v => { const g = ctx.createGain(); g.gain.value = db(v); return g; };
  const c = { inG: gain(s.inGain), eq: [], comp: null, makeup: null, lim: null, pan: ctx.createStereoPanner(), outG: gain(s.outGain) };
  c.pan.pan.value = s.pan;
  if (s.eqOn) c.eq = s.eq.map(b => setBand(ctx.createBiquadFilter(), b));
  if (s.comp.on) { c.comp = setComp(ctx.createDynamicsCompressor(), s.comp); c.makeup = gain(s.comp.makeup); }
  if (s.limit.on) c.lim = setLimit(ctx.createDynamicsCompressor(), s.limit);
  const nodes = [c.inG, ...c.eq, c.comp, c.makeup, c.lim, c.pan, c.outG].filter(Boolean);
  nodes.slice(1).forEach((n, i) => nodes[i].connect(n));
  c.input = c.inG; c.output = c.outG;
  return c;
}
// Web Audio reads a high/low-pass Q as dB of resonance; the dial uses the usual Q (0.71 = a clean slope, no bump), so it's converted.
function setBand(f, b) { f.type = b.type; f.frequency.value = b.freq; f.Q.value = CUT(b.type) ? 20 * Math.log10(b.q) : b.q; f.gain.value = b.gain; return f; }
function setComp(n, c) {
  n.threshold.value = c.threshold; n.ratio.value = c.ratio; n.knee.value = c.knee;
  n.attack.value = c.attack / 1000; n.release.value = c.release / 1000; return n;
}
// ponytail: limiter is a hard-knee 20:1 compressor, not a true brickwall. The WAV encoder clips anything left over 0 dBFS.
function setLimit(n, l) { n.threshold.value = l.ceiling; n.ratio.value = 20; n.knee.value = 0; n.attack.value = 0.001; n.release.value = 0.05; return n; }

// Independent pitch/tempo (and varispeed alongside) via SoundTouch, processed in chunks so the page stays responsive.
async function stretch(buf, s, onProgress) {
  const pad = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length + buf.sampleRate, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) pad.getChannelData(c).set(buf.getChannelData(c)); // 1s of silence flushes the tail
  const st = new SoundTouch();
  st.rate = s.varispeed; st.tempo = s.tempo; st.pitchSemitones = s.pitch;
  const f = new SimpleFilter(new WebAudioBufferSource(pad), st);
  const want = Math.round(buf.length / (s.tempo * s.varispeed));
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, want), sampleRate: buf.sampleRate });
  const L = out.getChannelData(0), R = out.getChannelData(1), N = 16384, tmp = new Float32Array(N * 2);
  let o = 0, n, k = 0;
  while (o < want && (n = f.extract(tmp, N)) > 0) {
    for (let i = 0; i < n && o < want; i++, o++) { L[o] = tmp[2 * i]; R[o] = tmp[2 * i + 1]; }
    if (++k % 16 === 0) { onProgress(o / want); await new Promise(r => setTimeout(r)); }
  }
  return out;
}

// MP3 at 320 kbps via lamejs, loaded on first use. Encodes in chunks so the page stays responsive.
async function encodeMp3(buffer, onProgress) {
  if (!window.lamejs) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/lib/lame.min.js'; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the MP3 encoder"));
      document.head.append(s);
    });
  }
  const toInt16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return o; };
  const stereo = buffer.numberOfChannels > 1;
  const enc = new window.lamejs.Mp3Encoder(stereo ? 2 : 1, buffer.sampleRate, 320);
  const L = toInt16(buffer.getChannelData(0)), R = stereo ? toInt16(buffer.getChannelData(1)) : null;
  const block = 1152 * 32, parts = [];
  for (let i = 0, k = 0; i < L.length; i += block, k++) {
    const out = R ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (out.length) parts.push(new Uint8Array(out));
    if (k % 8 === 0) { onProgress(i / L.length); await new Promise(r => setTimeout(r)); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}

const copyBuf = (b, len = b.length) => new AudioBuffer({ numberOfChannels: b.numberOfChannels, length: Math.max(1, len), sampleRate: b.sampleRate });

const fmtS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz');
const sign = v => (v > 0 ? '+' : '') + v;

export async function openEditor(track, app) {
  const { h, api, toast, oops, dialog, prompt, confirm, uploadFile, audioBlob, onSaved, project, startAt: openAt = 0, autoplay = false, onClosed, haptic: tap = () => {} } = app;
  let actx;
  try { actx = new AudioContext({ sampleRate: PREFERRED_RATE }); } catch { actx = new AudioContext(); }

  let confirming = false; // the discard dialog is open
  let closed = false; // closed (maybe before the track finished loading)
  let saved = false; // saved at least once this session (the player reloads the new version on close)
  let s = defaults(), buf, orig = null, ab = false, undo = [], ops = [], sel = null, loop = false, holdLoop = null;
  let chain, src = null, shifter = null, playing = false, startAt = 0, offset = openAt, raf = 0, busy = false;
  let tab = 'adjust', adjustMode = 'varispeed', dynMode = 'comp', eqSel = 0, linked = true;
  // Linked = varispeed (tape): speed and pitch move together. Unlinked: Speed keeps the pitch, Pitch keeps the speed.
  const syncLinked = () => { linked = s.tempo === 1 && s.pitch === 0; };
  function setLinked(on) {
    if (on === linked) return;
    if (on) { s.varispeed = Math.min(2, Math.max(0.5, +(s.tempo * s.varispeed).toFixed(2))); s.tempo = 1; s.pitch = 0; } // pitch follows speed again
    else { s.tempo = s.varispeed; s.pitch = +(12 * Math.log2(s.varispeed)).toFixed(1); s.varispeed = 1; } // same sound, now two dials
    linked = on; haptic(); rebuild(); live(); renderPanel();
  }
  const analyser = actx.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0.85; analyser.connect(actx.destination);
  const scratch = new Float32Array(analyser.fftSize);
  // Phones: Web Audio goes quiet when the screen locks or you switch apps, but an <audio> element keeps going.
  // That route can crackle on iPhones, so it's only used while the app is in the background; on screen the sound
  // goes straight out. (The <audio> element is started on a tap so iOS lets it take over later.)
  let bgEl = null, bgDest = null, bgOn = false;
  if (matchMedia('(pointer: coarse)').matches && actx.createMediaStreamDestination) {
    bgDest = actx.createMediaStreamDestination();
    bgEl = new Audio(); bgEl.srcObject = bgDest.stream;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  const route = background => {
    if (!bgDest || background === bgOn) return;
    bgOn = background;
    analyser.disconnect();
    analyser.connect(background ? bgDest : actx.destination);
  };
  // Back on screen: sound goes straight out again, and playback restarts cleanly from where it is. While the app was
  // away the phone may have paused the audio engine; carrying on from that half-stalled state glitches badly
  // (especially with pitch/tempo on), so it resumes the engine first and then starts afresh at the same spot.
  const onVis = () => {
    if (document.visibilityState === 'hidden') return route(playing);
    route(false);
    if (playing) { const at = pos(); actx.resume().then(() => { if (playing) play(at); }); }
  };
  document.addEventListener('visibilitychange', onVis);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: [track.artist, project].filter(Boolean).join(' · ') || '[vault]', album: 'Editing' });
    navigator.mediaSession.setActionHandler('play', () => { if (!playing) toggle(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (playing) toggle(); });
  }
  // A red "Clipping" chip shows for a moment whenever the edit goes past full scale (Save turns it down so it won't clip).
  let clipAt = -1e9;
  const clipChip = h('span', { className: 'ed-clip', hidden: true, title: 'This edit goes past full scale. Save will turn the track down just enough so it doesn\'t distort. To keep it loud, use the Limiter (Dynamics).' }, 'Clipping');
  const spectrum = new Float32Array(analyser.frequencyBinCount);

  // ---- layout ----------------------------------------------------------------------
  const saveLabel = h('span', {}, 'Save');
  const saveBtn = h('button', { className: 'ed-save', disabled: true, onclick: apply }, icon('check', 16), saveLabel);
  const abBtn = h('button', { className: 'ed-ab', type: 'button', 'aria-pressed': 'false', title: 'Compare the edit with the original (key: B)', onclick: () => toggleAB() }, h('b', {}, 'B'), h('span', {}, 'edited'));
  const scroller = h('canvas', { className: 'ed-scroll', 'aria-label': 'Waveform. Drag sideways to scrub.' });
  // Phone and laptop share these elements; .m-only / .d-only parts are swapped by CSS at 900px.
  const elapsed = h('span', { className: 'num' }, '0:00'), remain = h('span', { className: 'num' }, 'loading');
  const timeBoth = h('div', { className: 'ed-time num m-only' }, 'Loading…');
  const playBtn = h('button', { className: 'ed-play', 'aria-label': 'Play or pause', onclick: toggle }, icon('play', 24));
  const holdBtn = h('button', { className: 'ed-round hold', 'aria-label': 'Hold to loop the current bar', title: 'Hold to loop a bar' },
    h('span', { className: 'd-only' }, icon('loop', 20)), h('span', { className: 'm-only' }, 'Hold to loop'));
  const mini = h('canvas', { className: 'ed-mini', 'aria-label': 'Overview. Drag the handles to pick a section.' });
  const panel = h('div', { className: 'ed-panel' });
  const TABS = [['adjust', 'Adjust', 'gauge'], ['eq', 'EQ', 'eqv'], ['dyn', 'Dynamics', 'dyn'], ['tools', 'Tools', 'scissors']];
  const tabs = h('div', { className: 'ed-tabs', role: 'tablist' }, TABS.map(([id, label, ic]) =>
    h('button', { role: 'tab', 'data-tab': id, onclick() { tab = id; renderPanel(); } }, icon(ic, 20), h('span', {}, label))));
  const chip = text => h('span', { className: 'ed-chip num' }, text);
  // BPM and key as they'll be after this edit: Speed and Tempo change the BPM; Speed (as pitch) and Transpose change the key.
  const metaKey = h('span'), metaBpm = h('span'), keyChip = chip(''), bpmChip = chip('');
  const meta = h('div', { className: 'mono' }, project, metaKey, metaBpm);
  const after = () => {
    const st = 12 * Math.log2(s.varispeed) + s.pitch;
    return { bpm: track.bpm ? Math.round(track.bpm * s.varispeed * s.tempo * 10) / 10 : null, key: track.musical_key ? shiftKey(track.musical_key, st) : null };
  };
  function paintMeta() {
    const { bpm, key } = after(), bpmMoved = bpm != null && Math.round(bpm) !== Math.round(track.bpm), keyMoved = key !== track.musical_key;
    const sep = project ? '  ·  ' : '';
    metaKey.textContent = key ? sep + key : ''; metaKey.classList.toggle('shifted', keyMoved);
    metaBpm.textContent = bpm ? (key || project ? '  ·  ' : '') + Math.round(bpm) + ' bpm' : ''; metaBpm.classList.toggle('shifted', bpmMoved);
    keyChip.textContent = key || ''; keyChip.hidden = !key; keyChip.classList.toggle('shifted', keyMoved);
    bpmChip.textContent = bpm ? Math.round(bpm) + ' BPM' : ''; bpmChip.hidden = !bpm; bpmChip.classList.toggle('shifted', bpmMoved);
  }

  const d = dialog(h('div', { className: 'ed' },
    h('div', { className: 'ed-head' },
      h('button', { className: 'icon-btn d-only', 'aria-label': 'Close editor', onclick: close }, icon('close', 20)),
      h('button', { className: 'ed-cancel m-only', onclick: close }, 'Cancel'),
      h('div', { className: 'ed-title d-only' }, h('h2', {}, track.name), meta),
      clipChip, abBtn, saveBtn),
    h('div', { className: 'ed-main' },
      h('div', { className: 'ed-left' },
        h('div', { className: 'ed-mtitle m-only' },
          h('h2', {}, track.name),
          project && h('div', { className: 'sub' }, project),
          (track.musical_key || track.bpm) && h('div', { className: 'chips' }, keyChip, bpmChip)),
        scroller,
        h('div', { className: 'ed-times d-only' }, elapsed, remain),
        timeBoth,
        h('div', { className: 'ed-transport' },
          h('button', { className: 'ed-round start', 'aria-label': 'Back to start', title: 'Back to start', onclick: () => seek(sel ? sel[0] : 0) }, icon('toStart', 20)),
          playBtn, holdBtn),
        h('div', { className: 'ed-hint mono d-only' }, '[hold the loop button to repeat a bar]'),
        mini),
      h('div', { className: 'ed-right' }, panel, tabs))), { className: 'editor' });
  const phone = () => matchMedia('(max-width: 900px)').matches;
  d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  const onKey = e => { if (confirming) return; if (e.code === 'KeyB' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); toggleAB(); return; } if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) && e.target.getAttribute('role') !== 'slider') { e.preventDefault(); toggle(); } };
  addEventListener('keydown', onKey);

  // ---- transport ------------------------------------------------------------------
  const needsST = () => s.tempo !== 1 || s.pitch !== 0;
  function pos() {
    if (!playing) return offset;
    if (shifter) return Math.min(buf.duration, shifter.timePlayed);
    let p = offset + (actx.currentTime - startAt) * (ab ? 1 : s.varispeed);
    if (src.loop && p >= src.loopEnd) p = src.loopStart + ((p - src.loopStart) % (src.loopEnd - src.loopStart));
    return Math.min(ab ? orig.duration : buf.duration, p);
  }
  function play(from = offset) {
    halt();
    actx.resume(); bgEl?.play().catch(() => {});
    if (ab) {
      if (from >= orig.duration - 0.01) from = 0;
      src = actx.createBufferSource(); src.buffer = orig;
      const me = src;
      src.onended = () => { if (src === me) { halt(); offset = 0; updatePlay(); } };
      src.connect(analyser); src.start(0, from);
      startAt = actx.currentTime; offset = from; playing = true;
      return updatePlay();
    }
    if (from >= buf.duration - 0.01) from = 0;
    if (needsST()) {
      // Looping with pitch/tempo changed is done by jumping back in tick() (SoundTouch only streams forward).
      shifter = new PitchShifter(actx, buf, 4096, () => { if (shifter) { halt(); offset = 0; updatePlay(); } });
      shifter.rate = s.varispeed; shifter.tempo = s.tempo; shifter.pitchSemitones = s.pitch;
      shifter.percentagePlayed = from / buf.duration;
      shifter.connect(chain.input);
    } else {
      src = actx.createBufferSource();
      src.buffer = buf; src.playbackRate.value = s.varispeed;
      if (loop && sel && !holdLoop) {
        src.loop = true; src.loopStart = sel[0]; src.loopEnd = sel[1];
        if (from < sel[0] || from >= sel[1]) from = sel[0];
      }
      const me = src;
      src.onended = () => { if (src === me) { halt(); offset = 0; updatePlay(); } };
      src.connect(chain.input);
      src.start(0, from);
    }
    startAt = actx.currentTime; offset = from; playing = true;
    updatePlay();
  }
  function halt() {
    if (playing) offset = pos();
    if (src) { src.onended = null; try { src.stop(); } catch {} src.disconnect(); src = null; }
    if (shifter) { const sh = shifter; shifter = null; sh.disconnect(); }
    playing = false;
  }
  // A/B: flip between the untouched original (A) and the edit (B), keeping roughly the same spot in the song.
  function toggleAB(force) {
    const next = force ?? !ab;
    if (next === ab || !orig) return;
    const was = playing, at = pos(), from = ab ? orig.duration : buf.duration, to = next ? orig.duration : buf.duration;
    halt();
    ab = next; offset = Math.min(to, (at / from) * to);
    abBtn.classList.toggle('on', ab); abBtn.setAttribute('aria-pressed', String(ab));
    abBtn.replaceChildren(h('b', {}, ab ? 'A' : 'B'), h('span', {}, ab ? 'original' : 'edited'));
    if (was) play(offset);
  }
  function toggle() { if (!buf) return; playing ? (halt(), updatePlay()) : play(); }
  function updatePlay() { playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 24)); playBtn.classList.toggle('on', playing); }
  function seek(t) { if (!buf) return; offset = Math.max(0, Math.min(buf.duration, t)); if (playing) play(offset); }

  // Hold to loop: repeats one bar (from the track's BPM, else 2 seconds) from where you pressed, while held.
  const holdStart = e => {
    if (!buf) return;
    e.preventDefault(); try { holdBtn.setPointerCapture(e.pointerId); } catch {}
    const len = track.bpm ? (4 * 60) / track.bpm : 2;
    const a = pos();
    holdLoop = [a, Math.min(buf.duration, a + len)];
    holdBtn.classList.add('on');
    if (!playing) play(a);
  };
  const holdEnd = () => { if (!holdLoop) return; holdLoop = null; holdBtn.classList.remove('on'); };
  holdBtn.addEventListener('pointerdown', holdStart);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => holdBtn.addEventListener(ev, holdEnd));
  holdBtn.addEventListener('contextmenu', e => e.preventDefault());

  // Swap the processing chain (when bands or units are added/removed) without stopping playback.
  function rebuild() {
    if (!chain) return;
    const old = chain;
    chain = makeChain(actx, s); chain.output.connect(analyser);
    old.output.disconnect();
    if (src && !ab) { src.disconnect(); src.connect(chain.input); }
    if (shifter) { shifter.disconnect(); shifter.connect(chain.input); }
    if (playing && (!!shifter !== needsST())) play(pos());
    drawEq(); paintMeta();
  }
  // Live parameter changes: set values on the running nodes.
  function live() {
    if (ab) toggleAB(false);
    chain.inG.gain.value = db(s.inGain); chain.outG.gain.value = db(s.outGain); chain.pan.pan.value = s.pan;
    chain.eq.forEach((f, i) => setBand(f, s.eq[i]));
    if (chain.comp) { setComp(chain.comp, s.comp); chain.makeup.gain.value = db(s.comp.makeup); }
    if (chain.lim) setLimit(chain.lim, s.limit);
    if (src && !ab && src.playbackRate.value !== s.varispeed) { offset = pos(); startAt = actx.currentTime; src.playbackRate.value = s.varispeed; }
    if (shifter) { shifter.rate = s.varispeed; shifter.tempo = s.tempo; shifter.pitchSemitones = s.pitch; }
    if (playing && (!!shifter !== needsST())) play(pos());
    drawEq(); paintMeta();
  }

  // ---- buffer edits (applied immediately, undoable) ---------------------------------
  const range = b => sel ? [Math.floor(sel[0] * b.sampleRate), Math.floor(sel[1] * b.sampleRate)] : null;
  function edit(name, fn) {
    if (ab) toggleAB(false);
    if (!buf || busy) return;
    const next = fn(buf);
    if (!next) return;
    const was = playing; halt();
    undo.push(buf); ops.push(name);
    if (undo.length > 10) undo.shift();
    buf = next; offset = Math.min(offset, buf.duration);
    if (name === 'Trim' || name === 'Cut') sel = null;
    drawPeaks(); if (tab === 'tools') renderPanel();
    if (was) play(offset);
    toast(name === 'Trim' ? 'Trimmed' : `${name} done`, { ms: 1500 });
  }
  function doUndo() {
    if (!undo.length) return;
    const was = playing; halt();
    buf = undo.pop(); ops.pop(); sel = null;
    offset = Math.min(offset, buf.duration);
    drawPeaks(); if (tab === 'tools') renderPanel();
    if (was) play(offset);
  }
  const needSel = () => (sel ? true : (toast('Drag the handles on the overview strip to pick a section first'), false));
  function trim(b) {
    if (!needSel()) return;
    const [a, z] = range(b), out = copyBuf(b, z - a);
    for (let c = 0; c < b.numberOfChannels; c++) out.getChannelData(c).set(b.getChannelData(c).subarray(a, z));
    return out;
  }
  function cut(b) {
    if (!needSel()) return;
    const [a, z] = range(b), out = copyBuf(b, b.length - (z - a));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), dst = out.getChannelData(c);
      dst.set(src.subarray(0, a)); dst.set(src.subarray(z), a);
    }
    return out;
  }
  function mapRange(b, fn) {
    const [a, z] = range(b) || [0, b.length];
    const out = copyBuf(b);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c), dst = out.getChannelData(c);
      dst.set(src);
      fn(dst, a, z, src);
    }
    return out;
  }
  const silence = b => needSel() && mapRange(b, (d, a, z) => d.fill(0, a, z));
  function fade(b, isIn) {
    // Without a selection, fade the first/last 2 seconds.
    const len = Math.min(b.length, 2 * b.sampleRate);
    const [a, z] = range(b) || (isIn ? [0, len] : [b.length - len, b.length]);
    const out = copyBuf(b);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const dst = out.getChannelData(c); dst.set(b.getChannelData(c));
      for (let i = a; i < z; i++) { const x = (i - a) / (z - a); dst[i] *= isIn ? x * x : (1 - x) * (1 - x); }
      if (isIn) dst.fill(0, 0, a); // a fade-in starts from silence
      else dst.fill(0, z);
    }
    return out;
  }
  function normalize(b) {
    let peak = 0;
    const [a, z] = range(b) || [0, b.length];
    for (let c = 0; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let i = a; i < z; i++) peak = Math.max(peak, Math.abs(x[i])); }
    if (!peak) return toast('That part is silent'), null;
    const g = db(-0.3) / peak;
    return mapRange(b, (d, a, z) => { for (let i = a; i < z; i++) d[i] *= g; });
  }
  const reverse = b => mapRange(b, (d, a, z) => d.subarray(a, z).reverse());
  function mono(b) {
    if (b.numberOfChannels < 2) return toast('Already mono'), null;
    const out = copyBuf(b), L = b.getChannelData(0), R = b.getChannelData(1);
    const m = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) m[i] = (L[i] + R[i]) / 2;
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).set(m);
    return out;
  }

  // ---- waveforms --------------------------------------------------------------------
  // One peak per bar. The big scroller moves past a fixed centre playhead; the overview shows the whole track.
  const PPS = 64, BAR = 8; // css px per second, css px per bar
  let bars = null, drawnBuf = null, drawnAt = 0;
  function drawPeaks() {
    if (!buf) return;
    const n = Math.max(1, Math.ceil(buf.duration * (PPS / BAR)));
    bars = new Float32Array(n);
    const chs = Array.from({ length: buf.numberOfChannels }, (_, k) => buf.getChannelData(k)), step = buf.length / n;
    let top = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), z = Math.min(buf.length, Math.floor((i + 1) * step)), stride = Math.max(1, Math.floor((z - a) / 300));
      let p = 0;
      for (const ch of chs) for (let j = a; j < z; j += stride) { const v = Math.abs(ch[j]); if (v > p) p = v; }
      bars[i] = p; if (p > top) top = p;
    }
    if (top > 0) for (let i = 0; i < n; i++) bars[i] /= top;
    if (buf !== drawnBuf) { drawnBuf = buf; drawnAt = performance.now(); }
  }
  const fit = c => {
    const dpr = devicePixelRatio || 1, W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    return [c.getContext('2d'), W, H, dpr];
  };
  const HI = getComputedStyle(document.documentElement).getPropertyValue('--user-accent').trim() || '#4d8dff'; // accent from Settings
  function drawScroller() {
    if (!bars) return;
    const [g, W, H, dpr] = fit(scroller);
    const thin = phone(); // phone: thin square lines like the reference; laptop: rounded bars
    const p = pos(), cx = W / 2, pps = PPS * dpr, bw = thin ? Math.max(1, Math.round(1.6 * dpr)) : Math.max(2, Math.round(3.5 * dpr)), r = thin ? 0 : bw / 2;
    const grow = 1 - Math.pow(1 - Math.min(1, (performance.now() - drawnAt) / 500), 3);
    g.clearRect(0, 0, W, H);
    const first = Math.max(0, Math.floor((p - cx / pps) * (PPS / BAR))), last = Math.min(bars.length - 1, Math.ceil((p + cx / pps) * (PPS / BAR)));
    // Rounded bars; already-played audio is blue, what's ahead is white, quieter bars fade back.
    for (let i = first; i <= last; i++) {
      const x = cx + ((i * BAR) / PPS - p) * pps;
      const v = bars[i], bh = Math.max(bw, v * (H - 20 * dpr)) * grow;
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, v * 1.6);
      g.fillStyle = x < cx ? (thin ? 'rgba(255,255,255,.35)' : HI) : '#fff';
      g.beginPath(); g.roundRect ? g.roundRect(x - r, (H - bh) / 2, bw, bh, r) : g.rect(x - r, (H - bh) / 2, bw, bh); g.fill();
    }
    g.globalAlpha = 1;
    if (sel) { // dim outside the chosen section
      const xa = cx + (sel[0] - p) * pps, xb = cx + (sel[1] - p) * pps;
      g.fillStyle = 'rgba(25,25,25,.65)';
      if (xa > 0) g.fillRect(0, 0, Math.min(W, xa), H);
      if (xb < W) g.fillRect(Math.max(0, xb), 0, W, H);
    }
    g.fillStyle = HI;
    if (thin) { g.fillRect(Math.round(cx - dpr), 0, 2 * dpr, H); return; } // phone: plain full-height playhead
    g.fillRect(Math.round(cx - 0.75 * dpr), 6 * dpr, 1.5 * dpr, H - 12 * dpr); // laptop: line with round caps
    for (const y of [6 * dpr, H - 6 * dpr]) { g.beginPath(); g.arc(cx, y, 4 * dpr, 0, 7); g.fill(); }
  }
  function drawMini() {
    if (!bars) return;
    const [g, W, H, dpr] = fit(mini);
    const pad = 12 * dpr, inner = W - 2 * pad, n = Math.floor(inner / (4 * dpr));
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < n; i++) {
      const v = bars[Math.floor((i / n) * bars.length)], bh = Math.max(2 * dpr, v * (H - 18 * dpr));
      g.fillStyle = v > 0.12 ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.3)';
      g.fillRect(Math.round(pad + i * 4 * dpr), (H - bh) / 2, Math.max(1, dpr), bh);
    }
    const X = t => pad + (t / buf.duration) * inner;
    const [a, b] = sel || [0, buf.duration];
    g.fillStyle = 'rgba(25,25,25,.7)';
    g.fillRect(0, 0, X(a), H); g.fillRect(X(b), 0, W - X(b), H);
    if (phone()) { // phone: white bar handles like the reference
      g.fillStyle = '#fff';
      for (const x of [X(a) - 5 * dpr, X(b)]) { g.beginPath(); g.roundRect ? g.roundRect(x, 4 * dpr, 5 * dpr, H - 8 * dpr, 2.5 * dpr) : g.rect(x, 4 * dpr, 5 * dpr, H - 8 * dpr); g.fill(); }
      g.fillStyle = HI; g.fillRect(Math.round(X(pos()) - dpr), 6 * dpr, 2 * dpr, H - 12 * dpr);
      return;
    }
    // laptop: a blue outline with bracket handles at each end
    const top = 3 * dpr, bot = H - 3 * dpr, arm = 7 * dpr, lw = 2.5 * dpr;
    g.strokeStyle = HI; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round';
    if (sel) { g.lineWidth = 1.5 * dpr; g.strokeRect(X(a), top, X(b) - X(a), bot - top); }
    g.lineWidth = 4 * dpr;
    for (const [x, dir] of [[X(a), 1], [X(b), -1]]) {
      g.beginPath(); g.moveTo(x + dir * arm, top); g.lineTo(x, top); g.lineTo(x, bot); g.lineTo(x + dir * arm, bot); g.stroke();
    }
    g.fillStyle = '#fff'; g.fillRect(Math.round(X(pos()) - dpr), 8 * dpr, 2 * dpr, H - 16 * dpr);
  }

  // Scrub the big waveform by dragging it.
  let scrub = null;
  scroller.addEventListener('pointerdown', e => { if (!buf) return; scroller.setPointerCapture(e.pointerId); scrub = { x: e.clientX, t: pos(), was: playing }; if (playing) halt(); updatePlay(); });
  scroller.addEventListener('pointermove', e => { if (scrub) offset = Math.max(0, Math.min(buf.duration, scrub.t - (e.clientX - scrub.x) / PPS)); });
  const endScrub = () => { if (!scrub) return; const was = scrub.was; scrub = null; if (was) play(offset); };
  scroller.addEventListener('pointerup', endScrub); scroller.addEventListener('pointercancel', endScrub);

  // Overview: drag a handle to set the section, tap elsewhere to jump.
  let grabMini = null;
  const miniT = e => { const r = mini.getBoundingClientRect(), pad = 12; return Math.max(0, Math.min(1, (e.clientX - r.left - pad) / (r.width - 2 * pad))) * buf.duration; };
  mini.addEventListener('pointerdown', e => {
    if (!buf) return;
    const t = miniT(e), [a, b] = sel || [0, buf.duration], tol = (24 / mini.clientWidth) * buf.duration;
    grabMini = Math.abs(t - a) < tol ? 0 : Math.abs(t - b) < tol ? 1 : null;
    if (grabMini === null) return seek(t);
    mini.setPointerCapture(e.pointerId);
  });
  mini.addEventListener('pointermove', e => {
    if (grabMini === null) return;
    const t = miniT(e), [a, b] = sel || [0, buf.duration], min = 0.1;
    const next = grabMini === 0 ? [Math.min(t, b - min), b] : [a, Math.max(t, a + min)];
    sel = next[0] <= 0.01 && next[1] >= buf.duration - 0.01 ? null : next;
  });
  mini.addEventListener('pointerup', () => { if (grabMini !== null && sel && (offset < sel[0] || offset > sel[1])) seek(sel[0]); grabMini = null; if (tab === 'tools') renderPanel(); });

  // Haptic tick: vibrate() on Android; on iPhone (Safari 18+) tapping a hidden "switch" checkbox gives a light tap.
  // It lives inside the editor dialog because everything outside a modal dialog is inert.
  const touch = matchMedia('(pointer: coarse)').matches;
  // Android ticks while you drag; iPhones only allow a tap right after a tap/release, so there it comes when you let go.
  const vib = typeof navigator.vibrate === 'function' || !!window.webkit?.messageHandlers?.haptic; // Android, or the iPhone app
  function haptic(mid = false) { if (touch && (!mid || vib)) tap(); }

  // ---- controls: dial rulers, pills -------------------------------------------------
  // A tick-mark dial: drag sideways (or arrow keys / scroll) to change the value; double-click resets.
  let painters = [];
  // notch = how far apart the haptic ticks are (and you always feel the centre/reset point).
  function ruler(label, min, max, step, get, set, show, reset, span = 300, notch = (max - min) / 40) {
    span *= 3; // finer: a full sweep is three times as far as it used to be
    const val = h('span', { className: 'rv num' }, show(get()));
    const track = h('div', { className: 'rt' });
    const row = h('div', { className: 'ruler', role: 'slider', tabIndex: 0, 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max },
      h('div', { className: 'rh' }, h('span', { className: 'rl' }, label), val), track);
    const paint = () => {
      const v = get();
      track.style.setProperty('--x', -((v - min) / (max - min)) * span + 'px');
      val.textContent = show(v);
      row.setAttribute('aria-valuenow', v); row.setAttribute('aria-valuetext', show(v));
    };
    const setV = v => {
      v = +(Math.round(Math.max(min, Math.min(max, v)) / step) * step).toFixed(4);
      const was = get();
      if (v === was) return;
      if (Math.floor(v / notch + 1e-6) !== Math.floor(was / notch + 1e-6) || (v - reset) * (was - reset) <= 0) haptic(true);
      set(v); painters.forEach(p => p()); live();
    };
    let drag = null;
    track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); drag = { x: e.clientX, v: get() }; row.classList.add('active'); });
    track.addEventListener('pointermove', e => { if (drag) setV(drag.v - ((e.clientX - drag.x) / span) * (max - min)); });
    const end = () => { if (drag && drag.v !== get() && !vib) haptic(); drag = null; row.classList.remove('active'); };
    track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
    // Double-tap / double-click resets. Done by hand because iPhones don't reliably send dblclick for touch.
    let tap = null, lastTap = 0;
    row.addEventListener('pointerdown', e => { tap = { x: e.clientX, y: e.clientY }; });
    row.addEventListener('pointerup', e => {
      if (!tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) { tap = null; lastTap = 0; return; }
      tap = null;
      if (performance.now() - lastTap < 350) { lastTap = 0; setV(reset); if (!vib) haptic(); row.classList.remove('reset'); void row.offsetWidth; row.classList.add('reset'); }
      else lastTap = performance.now();
    });
    let acc = 0; // trackpads send lots of tiny scrolls; add them up and move by whole steps
    track.addEventListener('wheel', e => {
      e.preventDefault();
      const d = Math.max(-24, Math.min(24, -(e.deltaY || -e.deltaX))); // a mouse-wheel notch counts as 24px
      acc += (d / span) * (max - min) * (e.shiftKey ? 5 : 1);
      const whole = Math.trunc(acc / step) * step;
      if (whole) { acc -= whole; setV(get() + whole); }
    }, { passive: false });
    row.addEventListener('keydown', e => {
      const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (k) { e.preventDefault(); setV(get() + k * step * (e.shiftKey ? 10 : 1)); }
      if (e.key === 'Home' || e.key === 'Backspace') { e.preventDefault(); setV(reset); }
    });
    painters.push(paint); paint();
    return row;
  }
  // Segmented control for switching modes, with an optional control on the right.
  const modes = (current, list, onPick, right) => h('div', { className: 'ed-modes' },
    h('div', { className: 'seg', role: 'radiogroup' }, list.map(([id, label, cls = '']) =>
      h('button', { role: 'radio', 'aria-checked': current === id, className: (current === id ? 'on ' : '') + cls, onclick: () => onPick(id) }, label))),
    h('span', { className: 'grow' }), right);
  const power = (on, flip) => h('label', { className: 'switch' }, on ? 'On' : 'Off',
    h('input', { type: 'checkbox', className: 'toggle', checked: on, onchange: () => { flip(); rebuild(); renderPanel(); } }));
  const linkRow = () => h('div', { className: 'ed-link' },
    h('button', { type: 'button', className: linked ? 'on' : '', 'aria-pressed': linked, 'aria-label': linked ? 'Unlink speed and pitch' : 'Link speed and pitch',
      title: linked ? 'Linked: speed and pitch move together' : 'Unlinked: speed and pitch move separately', onclick: () => setLinked(!linked) }, icon(linked ? 'link' : 'unlink', 16)),
    h('small', {}, linked ? '[linked]' : '[separate]'));
  const pct = v => Math.round(v * 100) + '%';
  const dbs = v => sign(+v.toFixed(1)) + ' dB';

  // ---- EQ graph ----------------------------------------------------------------------
  const eqCanvas = h('canvas', { className: 'eq-canvas', 'aria-label': 'EQ curve. Drag the numbered dots.' });
  const FMIN = 20, FMAX = 20000, DBR = 18; // the graph and the gain dials go to ±18 dB
  const fx = (f, W) => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * W;
  const xf = (x, W) => FMIN * Math.pow(FMAX / FMIN, x / W);
  const gy = (g, H) => H / 2 - (g / DBR) * (H / 2);
  let grab = -1;
  function drawEq() {
    if (!eqCanvas.isConnected || !chain) return;
    const [g, W, H, dpr] = fit(eqCanvas);
    g.clearRect(0, 0, W, H);
    if (playing) { // live spectrum behind the curve
      analyser.getFloatFrequencyData(spectrum);
      const bin = actx.sampleRate / analyser.fftSize;
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 2 * dpr) g.lineTo(x, H - Math.max(0, Math.min(1, (spectrum[Math.min(spectrum.length - 1, Math.round(xf(x, W) / bin))] + 100) / 80)) * H);
      g.lineTo(W, H); g.closePath(); g.fillStyle = 'rgba(255,255,255,.05)'; g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1; g.fillStyle = 'rgba(255,255,255,.3)';
    g.font = `${10 * dpr}px "Plex Mono", monospace`;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx(f, W); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 4 * dpr, H - 6 * dpr); }
    g.textAlign = 'right';
    for (const v of [-12, -6, 0, 6, 12]) {
      const y = gy(v, H);
      g.strokeStyle = v ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.14)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      if (v && Math.abs(v) === 12) g.fillText(sign(v), W - 4 * dpr, y - 3 * dpr);
    }
    g.textAlign = 'start';
    const n = 256, freqs = new Float32Array(n), total = new Float32Array(n).fill(1), own = new Float32Array(n).fill(1), mag = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) freqs[i] = xf((i / (n - 1)) * W, W);
    if (s.eqOn) chain.eq.forEach((f, j) => { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < n; i++) { total[i] *= mag[i]; if (j === eqSel) own[i] = mag[i]; } });
    const yOf = m => gy(Math.max(-DBR, Math.min(DBR, toDb(m))), H);
    if (s.eqOn && chain.eq[eqSel]) { // the picked band's own shape, faintly, so you can see what that dot does
      g.beginPath(); g.moveTo(0, H / 2); own.forEach((m, i) => g.lineTo((i / (n - 1)) * W, yOf(m))); g.lineTo(W, H / 2); g.closePath();
      g.globalAlpha = 0.2; g.fillStyle = HI; g.fill(); g.globalAlpha = 1;
    }
    const pts = Array.from(freqs, (_, i) => [(i / (n - 1)) * W, yOf(total[i])]);
    g.beginPath(); g.moveTo(0, H / 2); pts.forEach(([x, y]) => g.lineTo(x, y)); g.lineTo(W, H / 2); g.closePath();
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fill();
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = s.eqOn ? '#fff' : 'rgba(255,255,255,.3)'; g.lineWidth = 1.75 * dpr; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    s.eq.forEach((b, i) => {
      const x = fx(b.freq, W), y = gy(HAS_GAIN(b.type) ? Math.max(-DBR, Math.min(DBR, b.gain)) : 0, H), on = i === eqSel;
      g.globalAlpha = s.eqOn ? 1 : 0.4;
      g.fillStyle = on ? HI : '#fff'; g.beginPath(); g.arc(x, y, (on ? 10 : 8) * dpr, 0, 7); g.fill();
      g.fillStyle = on ? '#fff' : '#191919'; g.fillText(String(i + 1), x, y + 0.5 * dpr);
    });
    g.globalAlpha = 1; g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    const b = s.eq[eqSel]; // what the picked band is set to, top left
    if (b) {
      g.font = `${11 * dpr}px "Plex Mono", monospace`; g.fillStyle = 'rgba(255,255,255,.7)';
      g.fillText([`${eqSel + 1} ${TYPES[b.type]}`, fmtHz(b.freq), HAS_GAIN(b.type) && dbs(b.gain), !SHELF(b.type) && `Q ${b.q.toFixed(2)}`].filter(Boolean).join('  ·  '), 8 * dpr, 16 * dpr);
    }
  }
  // EQ resets: the whole EQ back to flat, or one band back to how it started (the four starting bands, or a plain bell).
  function resetEq() { s.eq = defaults().eq; s.eqOn = true; eqSel = 0; haptic(); rebuild(); live(); renderPanel(); toast('EQ back to flat', { ms: 1500 }); }
  function resetBand(i) { if (!s.eq[i]) return; Object.assign(s.eq[i], defaults().eq[i] || { type: 'peaking', freq: 1000, gain: 0, q: 1 }); haptic(); live(); renderPanel(); }
  let lastDot = { i: -1, t: 0 }, drag = null;
  const eqPoint = e => { const r = eqCanvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width, r.height]; };
  const nearestDot = (e, reach) => {
    const [x, y, W, H] = eqPoint(e);
    let best = reach, at = -1;
    s.eq.forEach((b, i) => { const dd = Math.hypot(fx(b.freq, W) - x, gy(HAS_GAIN(b.type) ? Math.max(-DBR, Math.min(DBR, b.gain)) : 0, H) - y); if (dd < best) { best = dd; at = i; } });
    return at;
  };
  // A dot moves from where it is (it doesn't jump to your finger), and calmly: on a phone it moves 60% as far as your
  // finger, and Shift on a computer is finer still. Each direction only starts once you clearly push that way, so
  // raising a band doesn't nudge its frequency too. Gain clicks into 0 dB on the way past.
  const dragRate = e => (touch ? 0.6 : 1) * (e.shiftKey ? 0.25 : 1);
  eqCanvas.addEventListener('pointerdown', e => {
    grab = nearestDot(e, touch ? 36 : 24);
    if (grab >= 0 && lastDot.i === grab && performance.now() - lastDot.t < 350) { resetBand(grab); lastDot = { i: -1, t: 0 }; grab = -1; return; } // double-tap a dot
    if (grab < 0) return;
    lastDot = { i: grab, t: performance.now() };
    e.preventDefault();
    if (eqSel !== grab) { eqSel = grab; renderPanel(); } // before capturing: redrawing the panel would drop the capture
    const b = s.eq[grab];
    drag = { x: e.clientX, y: e.clientY, freq: b.freq, gain: b.gain, k: dragRate(e), ax: false, ay: false };
    eqCanvas.setPointerCapture(e.pointerId);
  });
  eqCanvas.addEventListener('pointermove', e => {
    if (grab < 0 || !drag) return;
    const r = eqCanvas.getBoundingClientRect(), b = s.eq[grab], k = dragRate(e);
    if (k !== drag.k) Object.assign(drag, { x: e.clientX, y: e.clientY, freq: b.freq, gain: b.gain, k }); // Shift pressed mid-drag: carry on from here
    if (!drag.ax && Math.abs(e.clientX - drag.x) > 6) { drag.ax = true; drag.x += Math.sign(e.clientX - drag.x) * 6; }
    if (!drag.ay && Math.abs(e.clientY - drag.y) > 6) { drag.ay = true; drag.y += Math.sign(e.clientY - drag.y) * 6; }
    if (drag.ax) b.freq = Math.round(Math.max(FMIN, Math.min(FMAX, drag.freq * Math.pow(FMAX / FMIN, ((e.clientX - drag.x) * k) / r.width))));
    if (drag.ay && HAS_GAIN(b.type)) {
      const raw = drag.gain - ((e.clientY - drag.y) * k * 2 * DBR) / r.height;
      const g = Math.abs(raw) < 0.6 ? 0 : Math.round(Math.max(-DBR, Math.min(DBR, raw)) * 10) / 10;
      if ((g === 0) !== (b.gain === 0)) haptic(true);
      b.gain = g;
    }
    live(); painters.forEach(p => p());
  });
  const endDrag = () => { grab = -1; drag = null; };
  eqCanvas.addEventListener('pointerup', endDrag); eqCanvas.addEventListener('pointercancel', endDrag);
  // Scroll over a dot (or anywhere, for the picked band) to change its Q.
  eqCanvas.addEventListener('wheel', e => {
    const at = nearestDot(e, 40), i = at >= 0 ? at : eqSel, b = s.eq[i];
    if (!b || SHELF(b.type)) return;
    e.preventDefault();
    b.q = +Math.max(0.1, Math.min(18, b.q * Math.exp(-Math.sign(e.deltaY) * (e.shiftKey ? 0.02 : 0.08)))).toPrecision(3);
    if (eqSel !== i) { eqSel = i; renderPanel(); }
    live(); painters.forEach(p => p());
  }, { passive: false });

  // ---- panels (one per tab) ----------------------------------------------------------
  let grBar = null, pkBar = null, grText = null, pkText = null, shownPanel = '';
  const meter = (label, bar, text) => h('div', { className: 'meters' }, label, h('div', { className: 'bar' + (label === '[gr]' ? ' gr' : '') }, bar), text);
  function renderPanel() {
    tabs.querySelectorAll('[role=tab]').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    grBar = pkBar = null; painters = []; paintMeta();
    let content;
    if (tab === 'adjust') {
      content = {
        varispeed: linked ? [
          ruler('Speed', 0.5, 2, 0.01, () => s.varispeed, v => { s.varispeed = v; }, pct, 1, 300, 0.05),
          linkRow(),
          ruler('Pitch', -12, 12, 0.1, () => 12 * Math.log2(s.varispeed), v => { s.varispeed = Math.pow(2, v / 12); }, v => sign(+v.toFixed(1)) + ' st', 0, 480, 1),
        ] : [
          ruler('Speed', 0.5, 2, 0.01, () => s.tempo, v => { s.tempo = v; }, pct, 1, 300, 0.05),
          linkRow(),
          ruler('Pitch', -12, 12, 0.1, () => s.pitch, v => { s.pitch = v; }, v => sign(+v.toFixed(1)) + ' st', 0, 480, 1),
        ],
        gain: [
          ruler('Gain', -24, 24, 0.1, () => s.outGain, v => { s.outGain = v; }, dbs, 0, 360),
          ruler('Pan', -1, 1, 0.01, () => s.pan, v => (s.pan = v), v => (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), 0),
        ],
      }[adjustMode];
      content.unshift(modes(adjustMode, [['varispeed', linked ? 'Varispeed' : 'Speed/Pitch'], ['gain', 'Gain', 'push']], m => { adjustMode = m; renderPanel(); }));
    } else if (tab === 'eq') {
      eqSel = Math.min(eqSel, s.eq.length - 1);
      const b = s.eq[eqSel];
      content = [
        h('div', { className: 'ed-modes' },
          s.eq.map((_, i) => h('button', { className: 'mode band-n' + (i === eqSel ? ' on' : ''), 'aria-label': `Band ${i + 1}`, onclick: () => { eqSel = i; renderPanel(); } }, String(i + 1))),
          s.eq.length < 8 && h('button', { className: 'mode band-n', 'aria-label': 'Add band', onclick: () => { s.eq.push({ type: 'peaking', freq: 1000, gain: 0, q: 1 }); eqSel = s.eq.length - 1; rebuild(); renderPanel(); } }, '+'),
          h('span', { className: 'grow' }),
          h('button', { className: 'mode', title: 'Every band back to flat', onclick: resetEq }, 'Reset EQ'),
          power(s.eqOn, () => { s.eqOn = !s.eqOn; })),
        eqCanvas,
        b && h('div', { className: 'ed-modes scroll' },
          Object.entries(TYPES).map(([v, l]) => h('button', { className: 'mode' + (b.type === v ? ' on' : ''), onclick: () => { if (CUT(v) !== CUT(b.type)) b.q = CUT(v) ? 0.71 : 1; b.type = v; live(); renderPanel(); } }, l)),
          h('button', { className: 'mode', title: 'This band back to flat (or double-tap its dot)', onclick: () => resetBand(eqSel) }, 'Reset band'),
          s.eq.length > 1 && h('button', { className: 'mode', 'aria-label': `Remove band ${eqSel + 1}`, onclick: () => { s.eq.splice(eqSel, 1); eqSel = Math.max(0, eqSel - 1); rebuild(); renderPanel(); } }, icon('trash', 14))),
        b && ruler('Freq', 0, 1, 0.001, () => Math.log(b.freq / 20) / Math.log(1000), v => { b.freq = Math.round(20 * Math.pow(1000, v)); }, () => fmtHz(b.freq), Math.log(1000 / 20) / Math.log(1000), 420),
        b && HAS_GAIN(b.type) && ruler('Gain', -DBR, DBR, 0.1, () => b.gain, v => { b.gain = v; }, dbs, 0, 360),
        b && !SHELF(b.type) && ruler('Q', 0, 1, 0.001, () => Math.log(b.q / 0.1) / Math.log(180), v => { b.q = +(0.1 * Math.pow(180, v)).toPrecision(3); }, () => b.q.toFixed(2), Math.log((CUT(b.type) ? 0.71 : 1) / 0.1) / Math.log(180), 420),
      ];
    } else if (tab === 'dyn') {
      grText = h('span', { className: 'num' }, '0.0'); pkText = h('span', { className: 'num' }, '–∞');
      grBar = h('i'); pkBar = h('i');
      content = dynMode === 'comp' ? [
        modes(dynMode, [['comp', 'Compressor'], ['limit', 'Limiter']], m => { dynMode = m; renderPanel(); }, power(s.comp.on, () => { s.comp.on = !s.comp.on; })),
        ruler('Input', -24, 24, 0.1, () => s.inGain, v => { s.inGain = v; }, dbs, 0, 360),
        ruler('Thresh', -60, 0, 0.5, () => s.comp.threshold, v => { s.comp.threshold = v; }, dbs, -24),
        ruler('Ratio', 1, 20, 0.1, () => s.comp.ratio, v => { s.comp.ratio = v; }, v => v.toFixed(1) + ':1', 4),
        ruler('Attack', 0, 200, 0.5, () => s.comp.attack, v => { s.comp.attack = v; }, v => v.toFixed(1) + ' ms', 10),
        ruler('Release', 10, 1000, 1, () => s.comp.release, v => { s.comp.release = v; }, v => Math.round(v) + ' ms', 250),
        ruler('Knee', 0, 40, 0.5, () => s.comp.knee, v => { s.comp.knee = v; }, dbs, 6),
        ruler('Makeup', 0, 24, 0.1, () => s.comp.makeup, v => { s.comp.makeup = v; }, dbs, 0),
        meter('[gr]', grBar, grText),
      ] : [
        modes(dynMode, [['comp', 'Compressor'], ['limit', 'Limiter']], m => { dynMode = m; renderPanel(); }, power(s.limit.on, () => { s.limit.on = !s.limit.on; })),
        ruler('Ceiling', -12, 0, 0.1, () => s.limit.ceiling, v => { s.limit.ceiling = v; }, dbs, -1),
        meter('[peak]', pkBar, pkText),
        h('div', { className: 'note' }, 'Keeps peaks under the ceiling so the file never clips.'),
      ];
    } else {
      // A section is set at the playhead (Start here / End here) or with the handles on the overview strip.
      // Section tools stay greyed out until there is one; the rest work on the section, or the whole track without one.
      const tool = (label, fn, off = false) => h('button', { className: 'tool', disabled: off, onclick: fn }, label);
      const mark = end => {
        const p = pos(), d = buf.duration;
        const [a, b] = end ? [sel && sel[0] < p - 0.1 ? sel[0] : 0, p] : [p, sel && sel[1] > p + 0.1 ? sel[1] : d];
        if (b - a < 0.1) return toast(end ? 'Move past the start first' : 'Move before the end first', { ms: 1800 });
        sel = a <= 0.01 && b >= d - 0.01 ? null : [a, b];
        haptic(); renderPanel();
      };
      const presetSel = h('select', { 'aria-label': 'Presets', onchange() { loadPreset(this.value); this.value = ''; } },
        h('option', { value: '' }, 'Load preset'), presets.map(p => h('option', { value: p.id }, p.name)),
        presets.length > 0 && h('option', { value: '__delete' }, 'Delete a preset…'));
      content = [
        h('div', { className: 'sec-bar' },
          h('div', { className: 'sec-t' }, h('span', { className: 'mono' }, '[section]'),
            h('b', { className: 'num' }, sel ? `${fmt(sel[0])} – ${fmt(sel[1])}` : 'None'),
            !sel && h('small', {}, 'Play to a spot, then tap Start here and End here')),
          sel && h('button', { className: 'mode', 'aria-label': 'Clear the section', title: 'Clear', onclick: () => { sel = null; renderPanel(); } }, icon('close', 14)),
          h('div', { className: 'sec-btns' },
            h('button', { className: 'mode', onclick: () => mark(false) }, 'Start here'),
            h('button', { className: 'mode', onclick: () => mark(true) }, 'End here'))),
        h('div', { className: 'tools-grid two' },
          tool('Keep only this', () => edit('Trim', trim), !sel), tool('Cut it out', () => edit('Cut', cut), !sel),
          tool('Silence it', () => edit('Silence', silence), !sel),
          h('button', { className: 'tool' + (loop && sel ? ' on' : ''), disabled: !sel, 'aria-pressed': loop && !!sel, onclick() { loop = !loop; if (playing) play(pos()); renderPanel(); } }, 'Loop it')),
        h('div', { className: 'tool-h mono' }, sel ? '[on the section]' : '[on the whole track]'),
        h('div', { className: 'tools-grid' },
          tool('Fade in', () => edit('Fade in', b => fade(b, true))), tool('Fade out', () => edit('Fade out', b => fade(b, false))), tool('Normalize', () => edit('Normalize', normalize)),
          tool('Reverse', () => edit('Reverse', reverse)), tool('Mono', () => edit('Mono', mono)),
          h('button', { className: 'tool', disabled: !undo.length, title: undo.length ? `Undo ${ops[ops.length - 1]}` : 'Nothing to undo', onclick: doUndo }, icon('undo', 15), ' Undo')),
        h('div', { className: 'tool-h mono' }, '[presets]'),
        h('div', { className: 'preset-row' }, presetSel, h('button', { className: 'mode', onclick: savePreset }, 'Save'),
          h('button', { className: 'mode', title: 'Speed, EQ, dynamics and gain back to how they started', onclick: () => { s = defaults(); syncLinked(); rebuild(); live(); renderPanel(); toast('Dials reset', { ms: 1500 }); } }, 'Reset dials')),
      ];
    }
    fill(panel, content);
    const shown = [tab, adjustMode, dynMode, linked].join();
    panel.classList.toggle('still', shown === shownPanel);
    if (shown !== shownPanel) { shownPanel = shown; panel.classList.remove('swap'); void panel.offsetWidth; panel.classList.add('swap'); }
    if (tab === 'eq') requestAnimationFrame(drawEq);
  }
  const fill = (el, kids) => el.replaceChildren(...kids.flat(9).filter(k => k != null && k !== false));

  // ---- frame loop: waveforms, meters, loops, save state ---------------------------------
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!buf) return;
    const p = pos();
    if (playing && holdLoop && p >= holdLoop[1] - 0.005) play(holdLoop[0]);
    else if (playing && loop && sel && shifter && p >= sel[1]) play(sel[0]);
    elapsed.textContent = fmtS(p); remain.textContent = '-' + fmtS(Math.max(0, buf.duration - p)); timeBoth.textContent = fmtS(p) + ' / ' + fmtS(buf.duration);
    drawScroller(); drawMini();
    if (playing && tab === 'eq') drawEq();
    if (!busy) saveBtn.disabled = !changes().length;
    if (playing && !ab) {
      analyser.getFloatTimeDomainData(scratch);
      for (const v of scratch) if (v > 1 || v < -1) { clipAt = performance.now(); break; }
    }
    clipChip.hidden = performance.now() - clipAt > 1500;
    if (pkBar?.isConnected) {
      analyser.getFloatTimeDomainData(scratch);
      let pk = 0; for (const v of scratch) pk = Math.max(pk, Math.abs(v));
      const pdb = toDb(pk);
      pkBar.style.width = Math.max(0, Math.min(100, ((pdb + 48) / 48) * 100)) + '%';
      pkBar.style.background = pdb > -0.1 ? 'var(--danger)' : '';
      pkText.textContent = isFinite(pdb) ? pdb.toFixed(1) : '–∞';
    }
    if (grBar?.isConnected) {
      const gr = chain.comp ? -chain.comp.reduction : 0;
      grBar.style.width = Math.min(100, (gr / 24) * 100) + '%';
      grText.textContent = gr.toFixed(1);
    }
  }

  // ---- presets ----------------------------------------------------------------------
  let presets = [];
  async function loadPresets() { presets = await api('/presets').catch(() => []); if (tab === 'tools') renderPanel(); }
  async function loadPreset(v) {
    if (v === '__delete') {
      const name = await prompt('Delete preset', '', { label: 'Type the preset name', ok: 'Delete' });
      const p = presets.find(p => p.name === name);
      if (p) { await api(`/presets/${p.id}`, { method: 'DELETE' }).catch(oops); loadPresets(); }
      return;
    }
    const p = presets.find(p => p.id === v);
    if (!p) return;
    s = { ...defaults(), ...JSON.parse(p.settings) }; syncLinked();
    rebuild(); live(); renderPanel();
    toast(`Loaded “${p.name}”`);
  }
  async function savePreset() {
    const name = await prompt('Save preset', '', { label: 'Preset name (e.g. “vocal chain”)' });
    if (!name) return;
    await api('/presets', { method: 'POST', body: { name, settings: s } }).then(() => toast('Preset saved'), oops);
    loadPresets();
  }

  // ---- save (apply to file) ----------------------------------------------------------
  function changes() {
    const out = [...new Set(ops)];
    if (s.varispeed !== 1) out.push(`Varispeed ${Math.round(s.varispeed * 100)}% (${sign(+(12 * Math.log2(s.varispeed)).toFixed(1))} st)`);
    if (s.tempo !== 1) out.push(`Tempo ${Math.round(s.tempo * 100)}%`);
    if (s.pitch !== 0) out.push(`Transpose ${sign(s.pitch)} st`);
    if (s.eqOn && s.eq.some(b => (HAS_GAIN(b.type) ? b.gain !== 0 : true))) out.push('EQ');
    if (s.comp.on) out.push('Compressor');
    if (s.limit.on) out.push('Limiter');
    if (s.inGain || s.outGain) out.push('Gain');
    if (s.pan) out.push('Pan');
    return out;
  }
  async function apply() {
    const what = changes();
    if (!what.length) return;
    const wasPlaying = playing, rateBefore = s.varispeed * s.tempo;
    busy = true; saveBtn.disabled = true; halt(); updatePlay();
    const say = t => { saveLabel.textContent = t; };
    if (ab) toggleAB(false);
    try {
      let input = buf, rate = s.varispeed;
      if (needsST()) { input = await stretch(buf, s, p => say(`${Math.round(p * 100)}%`)); rate = 1; }
      say('Rendering');
      const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(input.length / rate)), input.sampleRate);
      const c = makeChain(off, s); c.output.connect(off.destination);
      const sn = off.createBufferSource(); sn.buffer = input; sn.playbackRate.value = rate; sn.connect(c.input); sn.start();
      const out = await off.startRendering();
      const mp3 = settings.saveFormat !== 'wav';
      // Loud masters sit right at full scale, so anything that adds level (bass, gain, makeup, pitch) pushes peaks over it,
      // and a file can't hold that: it would clip and distort. Turn the whole render down just enough instead.
      // (MP3 gets an extra half dB, because MP3 decoders overshoot slightly.)
      const ceiling = mp3 ? 0.944 : 0.989;
      let pk = 0;
      for (let ch = 0; ch < out.numberOfChannels; ch++) { const x = out.getChannelData(ch); for (let i = 0; i < x.length; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > pk) pk = v; } }
      const trim = pk > ceiling ? ceiling / pk : 1;
      if (trim < 1) for (let ch = 0; ch < out.numberOfChannels; ch++) { const x = out.getChannelData(ch); for (let i = 0; i < x.length; i++) x[i] *= trim; }
      say(mp3 ? 'Encoding' : 'Saving');
      const blob = mp3 ? await encodeMp3(out, p => say(`MP3 ${Math.round(p * 100)}%`)) : encodeWav(out);
      if (blob.size > MAX.audio) throw new Error('The result is over 1 GB. Trim it first.');
      const file_key = await uploadFile(new File([blob], `${track.name}.${mp3 ? 'mp3' : 'wav'}`, { type: mp3 ? 'audio/mpeg' : 'audio/wav' }), p => say(`${Math.round(p * 100)}%`));
      await api(`/tracks/${track.id}/versions`, { method: 'POST', body: { file_key, duration: out.duration, peaks: peaksOf(out), note: what.join(', ').slice(0, 300) } });
      const now = after(), moved = {};
      if (now.bpm != null && now.bpm !== track.bpm) moved.bpm = now.bpm;
      if (now.key && now.key !== track.musical_key) moved.musical_key = now.key;
      if (Object.keys(moved).length) { await api(`/tracks/${track.id}`, { method: 'PATCH', body: moved }).catch(oops); Object.assign(track, moved); }
      // The saved result becomes the new starting point.
      buf = orig = await actx.decodeAudioData(await blob.arrayBuffer());
      s = defaults(); syncLinked(); undo = []; ops = []; sel = null;
      offset = Math.min(offset / rateBefore, Math.max(0, buf.duration - 0.05)); // same moment in the new (maybe longer/shorter) file
      saved = true;
      rebuild(); renderPanel(); drawPeaks(); paintMeta();
      const turned = -20 * Math.log10(trim);
      toast(turned > 0.6
        ? `Saved. Turned it down ${turned.toFixed(1)} dB so the loud parts don't distort. To keep it louder, use the Limiter in Dynamics.`
        : 'Saved to the file. The previous version is kept under Details & versions.', { ms: turned > 0.6 ? 9000 : 6000 });
      onSaved();
      close(true, wasPlaying); // done: back to the player, at the same moment, playing if it was
    } catch (e) { oops(e); }
    say('Save'); busy = false;
  }

  async function close(force, resume) {
    if (confirming) return;
    if (busy && force !== true) return toast('Wait for Save to finish');
    if (force !== true && changes().length) {
      confirming = true;
      const ok = await confirm('Discard your changes?', "Your edits haven't been saved to the file.", 'Discard', 'Keep editing');
      confirming = false;
      if (!ok) return;
    }
    if (ab) toggleAB(false);
    closed = true;
    const back = { at: playing ? pos() : offset, playing: resume ?? (buf ? playing : autoplay), saved }; // closed while loading: carry on as before
    halt(); cancelAnimationFrame(raf); removeEventListener('keydown', onKey);
    actx.close().catch(() => {});
    document.removeEventListener('visibilitychange', onVis);
    if (bgEl) { bgEl.pause(); bgEl.srcObject = null; }
    if ('mediaSession' in navigator) { navigator.mediaSession.setActionHandler('play', null); navigator.mediaSession.setActionHandler('pause', null); }
    d.close();
    onClosed?.(back);
  }

  // ---- load (last, so everything above is initialised) ---------------------------------
  try {
    buf = orig = await actx.decodeAudioData(await (await audioBlob(track)).arrayBuffer());
  } catch (e) {
    if (closed) return;
    oops(new Error(`Couldn't open ${track.name} for editing. This browser may not support the format.`));
    return close(true);
  }
  if (closed) return; // closed before it finished loading
  chain = makeChain(actx, s); chain.output.connect(analyser);
  offset = Math.min(openAt, Math.max(0, buf.duration - 0.05));
  drawPeaks(); renderPanel(); loadPresets(); tick();
  if (autoplay) play(offset);
}
