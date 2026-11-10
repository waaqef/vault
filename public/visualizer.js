// The visualizer: Alchemy, after Windows Media Player's. A small 3D world that moves with the music: every several
// seconds it jumps to a random scene (ribbons of dots, bead pillars, waveform sheets, zigzag bursts, rays, rings,
// string art, wires with stars, a haze), with new colours and a new way the camera and trails move. Each frame is
// drawn over the last one (slightly moved and faded), so one scene melts into the next.
// Tap for a new scene.
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
  return main.analyser;
}

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];
const hueOf = rgb => { const [r, g, b] = rgb.split(',').map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 280; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };

// How the last frame is carried into the next, per scene: zoom (>1 flows outward), spin, sideways drift,
// how much of it stays (alpha), and the background. (blur: unused; a filter per frame was far too slow)
const SCENES = {
  ribbon: () => ({ zoom: 1.004, rot: 0, drift: 1, alpha: 0.9, blur: 1.4, bgc: '#0a0f1c' }),
  pillars: () => ({ zoom: 1, rot: 0, drift: 0.4, alpha: 0.55, blur: 0.4, bgc: '#020203' }),
  sheet: () => ({ zoom: 1.002, rot: 0, drift: 0.6, alpha: 0.82, blur: 0.8, bgc: '#030304' }),
  zigzag: () => ({ zoom: rnd(1.01, 1.03), rot: rnd(-0.02, 0.02), drift: 0, alpha: 0.9, blur: 1, bgc: '#040306' }),
  wire: () => ({ zoom: 1.006, rot: rnd(-0.006, 0.006), drift: 0.5, alpha: 0.85, blur: 0.8, bgc: '#030306' }),
  rays: () => ({ zoom: 1.02, rot: rnd(-0.01, 0.01), drift: 0, alpha: 0.88, blur: 0.8, bgc: '#05060a' }),
  rings: () => ({ zoom: 1.03, rot: rnd(-0.004, 0.004), drift: 0, alpha: 0.9, blur: 0.6, bgc: '#04070b' }),
  string: () => ({ zoom: 0.996, rot: rnd(-0.02, 0.02), drift: 0, alpha: 0.88, blur: 0.6, bgc: '#05040a' }),
  haze: () => ({ zoom: 1.008, rot: rnd(-0.03, 0.03), drift: 0, alpha: 0.915, blur: 1.4, bgc: '#040404' }),
};

// info() → { title, artist, cover (an image URL or null), palette (['r,g,b', …] or null) }, read every frame
export function openVisualizer(host, audio, info, { icon, haptic = () => {}, onClose = () => {} } = {}) {
  const an = hear(audio);
  an.fftSize = 2048; an.smoothingTimeConstant = 0.82;
  const freq = new Uint8Array(an.frequencyBinCount), wave = new Uint8Array(an.fftSize);

  const el = document.createElement('div');
  el.className = 'viz';
  el.innerHTML = `<canvas></canvas><div class="viz-top"><div class="viz-t"><b></b><span></span></div>
    <button class="icon-btn viz-x" type="button" aria-label="Close the visualizer"></button></div>
    <div class="viz-hint mono">[tap for a new scene]</div>`;
  const cv = el.querySelector('canvas'), g = cv.getContext('2d');
  el.querySelector('.viz-x').append(icon ? icon('close', 20) : '×');
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  el.querySelector('.viz-x').onclick = () => close();
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); } };
  addEventListener('keydown', onKey, true);

  let W = 0, H = 0, dpr = 1;
  const buf = document.createElement('canvas'), bg = buf.getContext('2d');
  // Drawn at about 0.7 megapixels whatever the screen (then stretched to fill it): copying the whole frame onto
  // itself every frame is the costly part, and the softness of the stretch is the original's look anyway.
  const fit = () => { W = el.clientWidth; H = el.clientHeight; dpr = Math.min(devicePixelRatio || 1, Math.sqrt(700000 / Math.max(1, W * H))); cv.width = buf.width = Math.round(W * dpr); cv.height = buf.height = Math.round(H * dpr); };
  fit(); addEventListener('resize', fit);
  let cols = ['170,190,255'], lastInfo = '';
  const refresh = i => {
    el.querySelector('.viz-t b').textContent = i.title || '';
    el.querySelector('.viz-t span').textContent = i.artist || '';
    cols = i.palette?.length ? i.palette : ['170,190,255'];
  };

  // log-spaced bands of the spectrum, 0..1 (the highs tilted up so the whole range moves)
  const bands = (n, lo = 30, hi = 16000) => {
    const ny = an.context.sampleRate / 2, out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const f0 = lo * Math.pow(hi / lo, k / n), f1 = lo * Math.pow(hi / lo, (k + 1) / n);
      const a = Math.floor((f0 / ny) * freq.length), b = Math.max(a + 1, Math.ceil((f1 / ny) * freq.length));
      let m = 0; for (let j = a; j < b && j < freq.length; j++) m = Math.max(m, freq[j]);
      out[k] = Math.pow(m / 255, 1.6) * (0.75 + 0.5 * (k / n));
    }
    return out;
  };

  let bassS = 0, t = 0, last = performance.now(), avgBass = 0, kick = 0, raf = 0, closed = false, scene = null;
  // the camera: it turns slowly round the scene (faster when it's loud; kicks nudge it)
  const cam = { ax: 0.4, ay: -0.3, az: 0, vx: 0, vy: 0, vz: 0 };
  const sparks = [], blob = { x: 0, y: 0, vx: 0, vy: 0 };
  const newScene = () => {
    const kinds = Object.keys(SCENES).filter(k => k !== scene?.kind), kind = pick(kinds);
    scene = { kind, ...SCENES[kind](), until: performance.now() / 1000 + rnd(6, 11), // a new scene every 6–11 seconds (real time)
      hue: rnd(0, 360), dir: rnd(0, Math.PI * 2),
      spokes: Math.floor(rnd(18, 48)), skip: Math.floor(rnd(2, 11)), pts: Math.floor(rnd(30, 70)), arms: Math.floor(rnd(5, 12)),
      cols2: Math.floor(rnd(2, 4)), lines: Math.floor(rnd(10, 22)) };
    cam.vx = rnd(-0.12, 0.12); cam.vy = rnd(-0.15, 0.15); cam.vz = rnd(-0.06, 0.06);
  };
  cv.onclick = () => { newScene(); haptic(); };

  const frame = () => {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    const i = info(), key = `${i.title}|${i.palette}`;
    if (key !== lastInfo) { lastInfo = key; refresh(i); }
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(wave);
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000), clock = now / 1000; last = now; t += dt;
    let bass = 0; for (let j = 1; j < 12; j++) bass += freq[j]; bass /= 11 * 255;
    bassS += (bass - bassS) * (bass > bassS ? 0.5 : 0.08);
    avgBass += (bass - avgBass) * 0.02;
    kick = Math.max(0, kick - dt * 3);
    if (bass > 0.3 && bass > avgBass * 1.35 && kick < 0.4) kick = 1; // the bass jumping well above its recent average
    let level = 0; for (let j = 0; j < freq.length; j += 8) level += freq[j]; level /= (freq.length / 8) * 255;
    if (!scene || clock > scene.until || (kick > 0.95 && clock > scene.until - 3)) newScene(); // a big kick near the end jumps early
    const sc = scene, cx = W / 2, cy = H / 2, S = Math.min(W, H);
    const hue = hueOf(cols[0]) + sc.hue + t * 14 + bassS * 60; // starts from the cover's colour and keeps drifting round
    const hsl = (h, l = 60, a = 1) => `hsla(${((h % 360) + 360) % 360},95%,${l}%,${a})`;

    // the last frame, carried over: moved, blurred, colour-shifted and a bit darker
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    bg.setTransform(1, 0, 0, 1, 0, 0); bg.globalCompositeOperation = 'copy'; bg.drawImage(cv, 0, 0);
    g.fillStyle = sc.bgc; g.fillRect(0, 0, W, H);
    sc.dir += dt * 0.2 * Math.sin(t * 0.13);
    const push = sc.drift * S * (0.0045 + level * 0.006), zoom = sc.zoom + bassS * 0.015 + kick * 0.015;
    g.save(); g.translate(cx + Math.cos(sc.dir) * push, cy + Math.sin(sc.dir) * push); g.rotate(sc.rot * (1 + level)); g.scale(zoom, zoom); g.translate(-cx, -cy);
    g.globalAlpha = sc.alpha;
    g.drawImage(buf, 0, 0, W, H);
    g.restore(); g.globalAlpha = 1;
    g.globalCompositeOperation = 'lighter';

    // the camera, and 3D → screen
    const sp = 1 + level * 2.5 + kick * 3;
    cam.ax += cam.vx * dt * sp; cam.ay += cam.vy * dt * sp; cam.az += cam.vz * dt * sp;
    if (kick > 0.95) { cam.vx += rnd(-0.2, 0.2); cam.vy += rnd(-0.2, 0.2); }
    cam.vx *= 0.995; cam.vy *= 0.995;
    const [sx, cxr, sy, cyr, sz, czr] = [Math.sin(cam.ax), Math.cos(cam.ax), Math.sin(cam.ay), Math.cos(cam.ay), Math.sin(cam.az), Math.cos(cam.az)];
    const proj = (x, y, z) => {
      const y1 = y * cxr - z * sx, z1 = y * sx + z * cxr, x2 = x * cyr + z1 * sy, z2 = -x * sy + z1 * cyr;
      const x3 = x2 * czr - y1 * sz, y3 = x2 * sz + y1 * czr, f = 2.6 / Math.max(0.4, 2.6 + z2);
      return [cx + x3 * f * S * 0.62, cy + y3 * f * S * 0.62, f];
    };
    const star = (x, y, r, h) => { // a little sparkle: a glow and a cross
      const gr = g.createRadialGradient(x, y, 0, x, y, r * 2.5); gr.addColorStop(0, hsl(h, 85, 0.9)); gr.addColorStop(1, hsl(h, 60, 0));
      g.fillStyle = gr; g.fillRect(x - r * 2.5, y - r * 2.5, r * 5, r * 5);
      g.strokeStyle = hsl(h, 90, 0.8); g.lineWidth = 1; g.beginPath(); g.moveTo(x - r * 3, y); g.lineTo(x + r * 3, y); g.moveTo(x, y - r * 3); g.lineTo(x, y + r * 3); g.stroke();
    };
    const step = n => Math.floor(wave.length / n), w = k => (wave[k] - 128) / 128;

    if (sc.kind === 'ribbon') {
      // a strip of square dots: the waveform along it, the spectrum giving it depth; rainbow along its length
      const N = 150, spec = bands(N, 40, 12000), st = step(N);
      for (let layer = 0; layer < 2; layer++) for (let k = 0; k < N; k++) {
        const [px, py, f] = proj((k / (N - 1) - 0.5) * 1.7, layer ? spec[k] * -0.35 - 0.05 : w(k * st) * (0.18 + bassS * 0.35), layer ? 0.12 : spec[k] * 0.3);
        const r = (layer ? 1.4 : 2) * f * (1 + level);
        g.fillStyle = hsl(hue + k * 1.6 + layer * 140, 58 + level * 20, layer ? 0.5 : 0.85);
        g.fillRect(px - r, py - r, r * 2, r * 2);
      }
      if (kick > 0.95 && sparks.length < 24) for (let n = 0; n < 4; n++) { const [px, py] = proj(rnd(-0.8, 0.8), 0, 0); sparks.push({ x: px, y: py, vx: rnd(-0.3, 0.3) * S, vy: rnd(-0.3, 0.3) * S, life: 1, h: hue + rnd(0, 120) }); }
    } else if (sc.kind === 'pillars') {
      // columns of glowing beads (each bead a band of the spectrum) joined by a wire across their tops
      const n = sc.cols2, beads = 14, b = bands(beads * n), tops = [];
      for (let c = 0; c < n; c++) {
        const x = (c / (n - 1) - 0.5) * 1.1, z = c % 2 ? 0.25 : -0.25;
        for (let k = 0; k < beads; k++) {
          const v = b[c * beads + k], [px, py, f] = proj(x, 0.55 - (k / beads) * 1.05 - v * 0.1, z), r = (3 + v * 7) * f;
          const gr = g.createRadialGradient(px, py, 0, px, py, r * 1.8); gr.addColorStop(0, hsl(hue + k * 12, 70, 0.9)); gr.addColorStop(1, hsl(hue + k * 12, 50, 0));
          g.fillStyle = gr; g.fillRect(px - r * 2, py - r * 2, r * 4, r * 4);
          if (k === beads - 1) tops.push([px, py, r]);
        }
      }
      g.strokeStyle = hsl(hue + 40, 80, 0.5 + bassS * 0.5); g.lineWidth = 1;
      g.beginPath(); tops.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      tops.forEach(([x, y, r]) => { g.fillStyle = hsl(hue + 30, 65, 0.85); g.beginPath(); g.arc(x, y, r * 1.6, 0, Math.PI * 2); g.fill(); });
    } else if (sc.kind === 'sheet') {
      // a stack of parallel waveform lines seen in perspective, like a rippling surface
      const L = sc.lines, N = 90, st = step(N);
      g.lineWidth = 1;
      for (let l = 0; l < L; l++) {
        const z = (l / (L - 1) - 0.5) * 1.2;
        g.strokeStyle = hsl(hue + l * 9, 55 + level * 20, 0.25 + (1 - Math.abs(z)) * 0.5);
        g.beginPath();
        for (let k = 0; k < N; k++) { const [px, py] = proj((k / (N - 1) - 0.5) * 2, w(k * st) * (0.12 + bassS * 0.3) * (1 - Math.abs(z) * 0.5) + 0.25, z); k ? g.lineTo(px, py) : g.moveTo(px, py); }
        g.stroke();
      }
      if (kick > 0.95) { const [px, py] = proj(0, 0.15, 0); star(px, py, 4, hue + 180); }
    } else if (sc.kind === 'zigzag') {
      // the waveform as jagged lines, spun round the middle into a burst
      const n = sc.arms, N = 40, st = step(N), len = S * (0.25 + bassS * 0.25);
      g.lineWidth = 1.6 + bassS * 2;
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + t * 0.2, ca = Math.cos(ang), sa = Math.sin(ang);
        g.strokeStyle = hsl(hue + a * (300 / n), 65, 0.45 + level * 0.45);
        g.beginPath();
        for (let k = 0; k < N; k++) { const u = (k / (N - 1)) * len, off = w(k * st) * S * 0.05; const x = cx + ca * u - sa * off, y = cy + sa * u + ca * off; k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      }
    } else if (sc.kind === 'wire') {
      // one thin line through the scene with stars at its ends and middle, the middle one pulsing with the bass
      const [x1, y1] = proj(-0.7, -0.5, 0), [x2, y2] = proj(0.7, 0.5, 0), [x3, y3] = proj(0, 0, 0.3 + bassS * 0.3);
      g.strokeStyle = hsl(hue + 200, 70, 0.6); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(x3, y3, x2, y2); g.stroke();
      star(x1, y1, 3 + level * 4, hue); star(x2, y2, 3 + level * 4, hue + 60); star((x1 + x2 + x3 * 2) / 4, (y1 + y2 + y3 * 2) / 4, 4 + bassS * 10, hue + 120);
    } else if (sc.kind === 'rays') {
      // thin rays out of a glowing middle, each as long as its part of the spectrum
      const n = sc.spokes, b = bands(n);
      g.lineWidth = 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + t * 0.1, len = S * (0.08 + b[k] * 0.55);
        g.strokeStyle = hsl(hue + k * 6, 75, 0.2 + b[k] * 0.5);
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
      }
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, S * (0.025 + bassS * 0.04));
      core.addColorStop(0, hsl(hue + 60, 80, 0.55)); core.addColorStop(1, hsl(hue + 60, 60, 0));
      g.fillStyle = core; g.fillRect(cx - S / 4, cy - S / 4, S / 2, S / 2);
      if (kick > 0.95 && sparks.length < 10) sparks.push({ x: cx, y: cy, vx: rnd(-0.25, 0.25) * S, vy: rnd(-0.25, 0.25) * S, life: 1, h: hue + 120 });
    } else if (sc.kind === 'rings') {
      // a thin ring at the middle that the outward flow turns into ripples
      const r = S * (0.03 + bassS * 0.04);
      g.strokeStyle = hsl(hue + 180 * Math.sin(t * 0.3), 55, 0.22 + bassS * 0.35); g.lineWidth = 1 + bassS * 4;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    } else if (sc.kind === 'string') {
      // string art: straight lines between points on a circle, each point pushed out by the music
      const n = sc.pts, b = bands(n), R = S * (0.3 + bassS * 0.1);
      const pt = k => { const a = (k / n) * Math.PI * 2 + t * 0.05, r = R * (0.8 + b[k % n] * 0.5); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
      g.lineWidth = 0.8;
      for (let k = 0; k < n; k++) {
        const [x1, y1] = pt(k), [x2, y2] = pt(k + sc.skip);
        g.strokeStyle = hsl(hue + k * 3, 70, 0.14 + b[k] * 0.35); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
      g.fillStyle = hsl(hue + 120, 70, 0.25 + bassS * 0.4); g.beginPath(); g.ellipse(cx, cy, S * 0.04 * (1 + bassS), S * 0.028 * (1 + bassS), 0, 0, Math.PI * 2); g.fill();
    } else {
      // haze: a soft blob wandering round the middle, its colour smeared out by the long trails
      blob.vx += (rnd(-0.3, 0.3) - blob.x * 0.5) * dt; blob.vy += (rnd(-0.3, 0.3) - blob.y * 0.5) * dt;
      blob.x += blob.vx * dt * (1 + level * 3); blob.y += blob.vy * dt * (1 + level * 3);
      const bx = cx + blob.x * S * 0.3, by = cy + blob.y * S * 0.3, br = S * (0.04 + bassS * 0.05);
      const gr = g.createRadialGradient(bx, by, 0, bx, by, br); gr.addColorStop(0, hsl(hue, 55, 0.16 + level * 0.16)); gr.addColorStop(1, hsl(hue, 50, 0));
      g.fillStyle = gr; g.fillRect(bx - br, by - br, br * 2, br * 2);
    }

    for (let n = sparks.length - 1; n >= 0; n--) { // sparks thrown off on kicks
      const q = sparks[n];
      q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.96; q.vy *= 0.96; q.life -= dt * 0.9;
      if (q.life <= 0) { sparks.splice(n, 1); continue; }
      g.fillStyle = hsl(q.h, 70, q.life); g.beginPath(); g.arc(q.x, q.y, 2 + q.life * 3, 0, Math.PI * 2); g.fill();
    }
  };
  frame();

  function close() {
    if (closed) return;
    closed = true; cancelAnimationFrame(raf); onClose();
    removeEventListener('keydown', onKey, true); removeEventListener('resize', fit);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }
  return close;
}
