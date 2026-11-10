// The visualizer: a full-screen view over the player that moves with the music. Six looks (tap to switch): three
// trippy ones (Alchemy, Kaleido, Nebula), a ring of bars around the cover, mirrored bars, and the waveform.
// Colours start from the cover's.
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

const MODES = [['alchemy', 'Alchemy'], ['kaleido', 'Kaleido'], ['nebula', 'Nebula'], ['ring', 'Ring'], ['bars', 'Bars'], ['wave', 'Wave']];
// The trippy ones draw on top of the last frame, slightly zoomed, spun and colour-shifted, so everything smears into
// glowing trails that swirl with the music (the old Alchemy / Milkdrop trick).
const FEEDBACK = new Set(['alchemy', 'kaleido', 'nebula']);
const hueOf = rgb => { const [r, g, b] = rgb.split(',').map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 280; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };

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

  const setMode = m => { mode = (m + MODES.length) % MODES.length; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#060608'; g.fillRect(0, 0, cv.width, cv.height); modeBtn.textContent = `[${MODES[mode][1].toLowerCase()}]`; try { localStorage.setItem('vizMode', mode); } catch {} };
  setMode(mode);
  const next = () => { setMode(mode + 1); haptic(); };
  modeBtn.onclick = next;
  cv.onclick = next;
  el.querySelector('.viz-x').onclick = () => close();
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); } };
  addEventListener('keydown', onKey, true);

  // size, cover and colours (refreshed when the song changes)
  let W = 0, H = 0, dpr = 1;
  const buf = document.createElement('canvas'), bg = buf.getContext('2d');
  const canFilter = 'filter' in g;
  const fit = () => { dpr = Math.min(devicePixelRatio || 1, 1.5); W = el.clientWidth; H = el.clientHeight; cv.width = buf.width = W * dpr; cv.height = buf.height = H * dpr; };
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
  let bassSmooth = 0, spin = 0, raf = 0, closed = false, t = 0, last = performance.now(), avgBass = 0, kick = 0, morph = 0;
  const parts = Array.from({ length: 420 }, () => ({ x: Math.random(), y: Math.random(), vx: 0, vy: 0, h: Math.random() * 60 }));

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
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    // a kick: the bass jumping well above its recent average
    avgBass += (bass - avgBass) * 0.02;
    kick = Math.max(0, kick - dt * 3);
    if (bass > 0.3 && bass > avgBass * 1.35 && kick < 0.4) kick = 1;
    let level = 0; for (let j = 0; j < freq.length; j += 8) level += freq[j]; level /= (freq.length / 8) * 255;
    const m = MODES[mode][0], cx = W / 2, cy = H / 2, S = Math.min(W, H);
    const hue = hueOf(cols[0]) + t * 14 + bassSmooth * 60; // starts at the cover's colour and keeps drifting round

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (FEEDBACK.has(m)) {
      // last frame → buffer → back, zoomed / rotated / hue-shifted and a bit darker
      bg.setTransform(1, 0, 0, 1, 0, 0); bg.globalCompositeOperation = 'copy'; bg.drawImage(cv, 0, 0);
      g.fillStyle = '#040406'; g.fillRect(0, 0, W, H);
      const zoom = m === 'kaleido' ? 0.985 - kick * 0.02 : 1.012 + bassSmooth * 0.03 + kick * 0.03;
      const rot = (m === 'nebula' ? 0.002 : 0.006) * Math.sin(t * 0.21) + (m === 'alchemy' ? 0.004 + level * 0.01 : 0);
      g.save(); g.translate(cx, cy); g.rotate(rot); g.scale(zoom, zoom); g.translate(-cx, -cy);
      g.globalAlpha = m === 'nebula' ? 0.9 : 0.93;
      if (canFilter) g.filter = `hue-rotate(${(1.5 + level * 4).toFixed(1)}deg) saturate(1.05)`;
      g.drawImage(buf, 0, 0, W, H);
      g.restore(); g.filter = 'none'; g.globalAlpha = 1;
    } else {
      // fade the last frame instead of clearing it, for a little motion trail
      g.fillStyle = 'rgba(6,6,8,0.32)'; g.fillRect(0, 0, W, H);
    }
    // a glow in the cover's colour that breathes with the bass
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, S * (0.55 + beat * 0.35));
    glow.addColorStop(0, `rgba(${cols[0]},${0.10 + beat * 0.35})`); glow.addColorStop(1, `rgba(${cols[0]},0)`);
    if (!FEEDBACK.has(m)) { g.fillStyle = glow; g.fillRect(0, 0, W, H); } // (the trippy looks would pile it up into white)
    g.globalCompositeOperation = 'lighter';

    const color = k => `rgb(${cols[k % cols.length]})`;
    const hsl = (h, l = 60, a = 1) => `hsla(${h % 360},95%,${l}%,${a})`;
    if (m === 'alchemy') {
      // morphing rose curves: the number of petals drifts, each band pushes its own part of the curve out
      morph += dt * (0.05 + level * 0.25);
      const b = bands(64), petals = 3 + 2.5 * (1 + Math.sin(morph)), R = S * (0.16 + bassSmooth * 0.14 + kick * 0.05);
      for (let layer = 0; layer < 3; layer++) {
        g.beginPath();
        for (let k = 0; k <= 240; k++) {
          const a = (k / 240) * Math.PI * 2, v = b[Math.floor((k / 240) * 63)];
          const r = R * (0.55 + 0.45 * Math.sin(petals * a + t * (0.6 + layer * 0.35) + layer * 2.1)) * (1 + v * 0.9) * (1 + layer * 0.28);
          const x = cx + Math.cos(a + t * 0.2 * (layer - 1)) * r, y = cy + Math.sin(a + t * 0.2 * (layer - 1)) * r;
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.strokeStyle = hsl(hue + layer * 70, 55 + level * 25, 0.55 + level * 0.4); g.lineWidth = 1.2 + bassSmooth * 3 - layer * 0.3; g.stroke();
      }
      if (kick > 0.9) { // a flash ring on each kick
        g.strokeStyle = hsl(hue + 180, 75, 0.7); g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R * 1.6, 0, Math.PI * 2); g.stroke();
      }
    } else if (m === 'kaleido') {
      // one wedge of shapes, mirrored round 10 times; the feedback pulls it all inward like a tunnel
      const n = 10, b = bands(24);
      for (let s2 = 0; s2 < n; s2++) {
        g.save(); g.translate(cx, cy); g.rotate((s2 / n) * Math.PI * 2 + t * 0.15); if (s2 % 2) g.scale(1, -1);
        for (let k = 0; k < 24; k += 2) {
          const v = b[k], d = S * (0.08 + (k / 24) * 0.42) * (1 + bassSmooth * 0.3), sz = 1.5 + v * S * 0.035;
          g.fillStyle = hsl(hue + k * 9 + s2 * 4, 50 + v * 30, 0.35 + v * 0.6);
          g.beginPath(); g.arc(d, Math.sin(t * 1.3 + k) * d * 0.25, sz, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }
    } else if (m === 'nebula') {
      // particles drifting through a swirling field; the bass speeds them up and kicks blow them outward
      const sp = 0.0006 + level * 0.004 + kick * 0.006;
      for (const q of parts) {
        const ax = Math.sin(q.y * 6 + t * 0.7) + Math.cos(q.x * 4 - t * 0.5), ay = Math.cos(q.x * 6 - t * 0.6) - Math.sin(q.y * 5 + t * 0.4);
        const dx = q.x - 0.5, dy = q.y - 0.5, dist = Math.hypot(dx, dy) || 1;
        q.vx = q.vx * 0.92 + (ax * sp + (dx / dist) * kick * 0.004);
        q.vy = q.vy * 0.92 + (ay * sp + (dy / dist) * kick * 0.004);
        q.x += q.vx; q.y += q.vy;
        if (q.x < -0.05 || q.x > 1.05 || q.y < -0.05 || q.y > 1.05) { q.x = 0.5 + (Math.random() - 0.5) * 0.2; q.y = 0.5 + (Math.random() - 0.5) * 0.2; q.vx = q.vy = 0; }
        g.fillStyle = hsl(hue + q.h + dist * 120, 65, 0.5 + level * 0.5);
        g.fillRect(q.x * W, q.y * H, 1.6 + bassSmooth * 2.2, 1.6 + bassSmooth * 2.2);
      }
    } else if (m === 'ring') {
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
    } else if (m === 'bars') {
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
