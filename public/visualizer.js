// The visualizer: a full-screen view over the player that moves with the music. Three looks (tap to switch):
// a ring of bars around the cover, mirrored bars, and the waveform itself. Colours come from the cover.
//
// It listens to the player's own audio, live: from the first time it opens, the player's sound goes through an
// analyser on its way to the speakers (so it's always exactly in sync, whatever is playing).
let main = null; // { ctx, analyser }

function hear(audio) {
  if (!main) {
    const ctx = new AudioContext(), src = ctx.createMediaElementSource(audio), analyser = ctx.createAnalyser();
    src.connect(ctx.destination); src.connect(analyser);
    main = { ctx, analyser };
    // ponytail: iPhones may suspend Web Audio in the background; resume whenever playback (re)starts or the app returns
    const wake = () => main.ctx.state !== 'running' && main.ctx.resume().catch(() => {});
    audio.addEventListener('play', wake); document.addEventListener('visibilitychange', wake);
  }
  main.ctx.resume().catch(() => {});
  return { analyser: main.analyser, tick() {}, stop() {} };
}

const MODES = [['ring', 'Ring'], ['bars', 'Bars'], ['wave', 'Wave']];

// info() → { title, artist, cover (an image URL or null), palette (['r,g,b', …] or null) }, read every frame
export function openVisualizer(host, audio, info, { icon, haptic = () => {}, onClose = () => {} } = {}) {
  const ear = hear(audio), an = ear.analyser;
  an.fftSize = 2048; an.smoothingTimeConstant = 0.82;
  const freq = new Uint8Array(an.frequencyBinCount), wave = new Uint8Array(an.fftSize);
  let mode = Number(localStorage.getItem('vizMode')) || 0;

  const el = document.createElement('div');
  el.className = 'viz';
  el.innerHTML = `<canvas></canvas><div class="viz-top"><div class="viz-t"><b></b><span></span></div>
    <button class="viz-mode mono" type="button"></button><button class="icon-btn viz-x" type="button" aria-label="Close the visualizer"></button></div>
    <div class="viz-hint mono">[tap to change the look]</div>`;
  const cv = el.querySelector('canvas'), g = cv.getContext('2d'), modeBtn = el.querySelector('.viz-mode');
  el.querySelector('.viz-x').append(icon ? icon('close', 20) : '×');
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  const setMode = m => { mode = (m + MODES.length) % MODES.length; modeBtn.textContent = `[${MODES[mode][1].toLowerCase()}]`; try { localStorage.setItem('vizMode', mode); } catch {} };
  setMode(mode);
  const next = () => { setMode(mode + 1); haptic(); };
  modeBtn.onclick = next;
  cv.onclick = next;
  el.querySelector('.viz-x').onclick = () => close();
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); } };
  addEventListener('keydown', onKey, true);

  // size, cover and colours (refreshed when the song changes)
  let W = 0, H = 0, dpr = 1;
  const fit = () => { dpr = Math.min(devicePixelRatio || 1, 2); W = el.clientWidth; H = el.clientHeight; cv.width = W * dpr; cv.height = H * dpr; };
  fit(); addEventListener('resize', fit);
  let coverKey = null, img = null, cols = ['255,255,255', '200,200,255'];
  const refresh = (i) => {
    el.querySelector('.viz-t b').textContent = i.title || '';
    el.querySelector('.viz-t span').textContent = i.artist || '';
    if (i.cover !== coverKey) {
      coverKey = i.cover; img = null;
      if (coverKey) { const im = new Image(); im.onload = () => { if (coverKey === i.cover) img = im; }; im.src = coverKey; }
    }
    cols = i.palette?.length ? i.palette : ['255,255,255', '170,190,255', '255,170,220'];
  };
  let lastInfo = '';

  // a few numbers from the spectrum: overall level, bass, and log-spaced bands
  const bands = (n, lo = 30, hi = 16000) => {
    const ny = an.context.sampleRate / 2, out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const f0 = lo * Math.pow(hi / lo, k / n), f1 = lo * Math.pow(hi / lo, (k + 1) / n);
      const a = Math.floor((f0 / ny) * freq.length), b = Math.max(a + 1, Math.ceil((f1 / ny) * freq.length));
      let m = 0; for (let j = a; j < b && j < freq.length; j++) m = Math.max(m, freq[j]);
      out[k] = Math.pow(m / 255, 1.6) * (0.75 + 0.5 * (k / n)); // tilt up the highs so the whole range moves
    }
    return out;
  };
  let bassSmooth = 0, spin = 0, raf = 0, closed = false;

  const frame = () => {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    ear.tick();
    const i = info(), key = `${i.title}|${i.cover}|${i.palette}`;
    if (key !== lastInfo) { lastInfo = key; refresh(i); }
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(wave);
    let bass = 0; for (let j = 1; j < 12; j++) bass += freq[j]; bass = bass / (11 * 255);
    bassSmooth += (bass - bassSmooth) * (bass > bassSmooth ? 0.5 : 0.08);
    const beat = Math.pow(bassSmooth, 2.2);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fade the last frame instead of clearing it, for a little motion trail
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = 'rgba(6,6,8,0.32)'; g.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, S = Math.min(W, H);
    // a glow in the cover's colour that breathes with the bass
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, S * (0.55 + beat * 0.35));
    glow.addColorStop(0, `rgba(${cols[0]},${0.10 + beat * 0.35})`); glow.addColorStop(1, `rgba(${cols[0]},0)`);
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';

    const color = k => `rgb(${cols[k % cols.length]})`;
    if (MODES[mode][0] === 'ring') {
      spin += 0.0015 + beat * 0.01;
      const n = 72, b = bands(n / 2), R = S * 0.19 * (1 + beat * 0.12);
      for (let k = 0; k < n; k++) {
        const v = b[k < n / 2 ? k : n - 1 - k], a = spin + (k / n) * Math.PI * 2, len = 6 + v * S * 0.26;
        g.strokeStyle = color(Math.floor((k / n) * cols.length * 2)); g.lineWidth = Math.max(2, S * 0.011); g.lineCap = 'round';
        g.globalAlpha = 0.35 + v * 0.65;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)); g.lineTo(cx + Math.cos(a) * (R + 8 + len), cy + Math.sin(a) * (R + 8 + len)); g.stroke();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
      if (img) g.drawImage(img, cx - R, cy - R, R * 2, R * 2); else { g.fillStyle = '#111'; g.fill(); }
      g.restore();
      g.strokeStyle = `rgba(255,255,255,${0.15 + beat * 0.5})`; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    } else if (MODES[mode][0] === 'bars') {
      const n = 48, b = bands(n), gap = 4, bw = (W * 0.86 - gap * (n - 1)) / n, x0 = W * 0.07, base = H * 0.62;
      const box = (x, y, w, hh) => (g.roundRect ? g.roundRect(x, y, w, hh, Math.min(6, w / 2)) : g.rect(x, y, w, hh));
      for (let k = 0; k < n; k++) {
        const v = b[k], hgt = 4 + v * H * 0.42, x = x0 + k * (bw + gap);
        const grad = g.createLinearGradient(0, base - hgt, 0, base);
        grad.addColorStop(0, color(k)); grad.addColorStop(1, `rgba(${cols[(k + 1) % cols.length]},0.35)`);
        g.fillStyle = grad; g.globalAlpha = 0.9;
        g.beginPath(); box(x, base - hgt, bw, hgt); g.fill();
        g.globalAlpha = 0.18; // reflection
        g.beginPath(); box(x, base + 6, bw, hgt * 0.45); g.fill();
      }
      g.globalAlpha = 1;
    } else {
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = color(pass); g.lineWidth = pass ? 1.5 : 3.5; g.globalAlpha = pass ? 0.6 : 0.95; g.lineJoin = 'round';
        g.beginPath();
        const amp = H * (0.22 + beat * 0.18), step = Math.max(1, Math.floor(wave.length / W));
        for (let x = 0, j = 0; j < wave.length; j += step, x = (j / wave.length) * W) {
          const y = cy + ((wave[j] - 128) / 128) * amp * (pass ? -0.6 : 1);
          j ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  };
  frame();

  function close() {
    if (closed) return;
    closed = true; cancelAnimationFrame(raf); ear.stop(); onClose();
    removeEventListener('keydown', onKey, true); removeEventListener('resize', fit);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }
  return close;
}
