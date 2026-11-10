// The visualizer: Alchemy, after Windows Media Player's. A trippy 3D world that moves with the music, in the cover's
// colours. A metronome runs at the song's BPM: every beat gives the picture a small push (zoom, a nudge to the camera), no flashing,
// and every 8 beats it's a random new scene (a twisting helix, a tunnel, aurora, a spirograph, a planet of dots, a
// galaxy, an oscilloscope shape, a rolling terrain, a kaleidoscope), with a new way the camera and trails move. Each frame is
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

// How the last frame is carried into the next, per scene: zoom (>1 flows outward, <1 sucks inward), spin,
// sideways drift, rise (trails float upward), and how much of the last frame stays (alpha: higher = longer trails).
const SCENES = {
  helix: () => ({ zoom: 1.004, rot: 0, drift: 1, rise: 0, alpha: 0.9 }),         // two ribbons of dots twisting round each other
  tunnel: () => ({ zoom: 1.012, rot: rnd(-0.01, 0.01), drift: 0, rise: 0, alpha: 0.78, sides: pick([3, 4, 5, 6, 8, 48]), twist: rnd(0.1, 0.5) }),
  aurora: () => ({ zoom: 1, rot: 0, drift: 0, rise: 1, alpha: 0.93 }),            // glowing curtains, their trails rising
  spiro: () => ({ zoom: 1, rot: rnd(-0.004, 0.004), drift: 0, rise: 0, alpha: 0.965, r: pick([0.21, 0.29, 0.36, 0.41, 0.58, 0.67]), theta: 0 }),
  planet: () => ({ zoom: 1.006, rot: 0, drift: 0, rise: 0, alpha: 0.8 }),         // a sphere of dots, rippling with the spectrum
  galaxy: () => ({ zoom: 0.988, rot: rnd(0.008, 0.016) * pick([-1, 1]), drift: 0, rise: 0, alpha: 0.92, arms: pick([2, 3, 4]) }),
  scope: () => ({ zoom: 1.003, rot: rnd(-0.006, 0.006), drift: 0, rise: 0, alpha: 0.9, lag: Math.floor(rnd(20, 90)) }), // the sound drawn as a shape (XY)
  terrain: () => ({ zoom: 1, rot: 0, drift: 0, rise: 0, alpha: 0.55 }),           // the spectrum as a landscape rolling towards you
  kaleido: () => ({ zoom: 0.985, rot: rnd(0.004, 0.01), drift: 0, rise: 0, alpha: 0.9, n: pick([6, 8, 10, 12]) }),
};
// points spread evenly over a sphere (for the planet)
const SPHERE = Array.from({ length: 640 }, (_, i) => { const y = 1 - (2 * (i + 0.5)) / 640, r = Math.sqrt(1 - y * y), ph = i * 2.399963; return [Math.cos(ph) * r, y, Math.sin(ph) * r]; });

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
  let pal = null, lastInfo = ''; // the cover's colours as { h, s } (null: a black-and-white cover, so it draws in greys)
  const toHS = rgb => { const [r, gg, b] = rgb.split(',').map(v => v / 255), mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2, d = mx - mn;
    return { h: hueOf(rgb), s: d ? Math.round((d / (1 - Math.abs(2 * l - 1))) * 100) : 0 }; };
  const refresh = i => {
    el.querySelector('.viz-t b').textContent = i.title || '';
    el.querySelector('.viz-t span').textContent = i.artist || '';
    pal = i.palette?.length ? i.palette.map(toHS) : null;
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

  let peakB = 0.2, peakL = 0.2, pulse = 0, lastBeat = null;
  let bassS = 0, t = 0, last = performance.now(), avgBass = 0, kick = 0, raf = 0, closed = false, scene = null;
  // the camera: it turns slowly round the scene (faster when it's loud; kicks nudge it)
  const cam = { ax: 0.4, ay: -0.3, az: 0, vx: 0, vy: 0, vz: 0 };
  const sparks = [];
  const land = []; let landT = 0; // the terrain's rows of spectrum, newest first
  const stars = Array.from({ length: 700 }, () => ({ a: rnd(0, Math.PI * 2), r: rnd(0.05, 1), k: Math.floor(rnd(0, 4)) })); // the galaxy's
  const newScene = () => {
    const kinds = Object.keys(SCENES).filter(k => k !== scene?.kind), kind = pick(kinds);
    scene = { kind, ...SCENES[kind](), kicks: 0, born: performance.now() / 1000, hue: rnd(0, 360), dir: rnd(0, Math.PI * 2) };
    el.dataset.scene = kind; // (handy for checking what's showing)
    cam.vx = rnd(-0.12, 0.12); cam.vy = rnd(-0.15, 0.15); cam.vz = rnd(-0.06, 0.06);
  };
  cv.onclick = () => { newScene(); haptic(); };

  const frame = () => {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    const i = info(), key = `${i.title}|${i.palette}`;
    const bpm = i.bpm >= 50 && i.bpm <= 220 ? i.bpm : 0;
    if (key !== lastInfo) { lastInfo = key; refresh(i); }
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(wave);
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000), clock = now / 1000; last = now; t += dt;
    // loudness and bass, each against its own recent peak, so quiet songs move it as much as loud ones
    let bass = 0; for (let j = 1; j < 12; j++) bass += freq[j]; bass /= 11 * 255;
    let level = 0; for (let j = 0; j < freq.length; j += 8) level += freq[j]; level /= (freq.length / 8) * 255;
    peakB = Math.max(bass, peakB - dt * 0.04, 0.08); peakL = Math.max(level, peakL - dt * 0.03, 0.05);
    bass = Math.min(1, bass / peakB); level = Math.min(1, level / peakL);
    bassS += (bass - bassS) * (bass > bassS ? 0.6 : 0.1);
    avgBass += (bass - avgBass) * 0.03;
    kick = Math.max(0, kick - dt * 3); pulse = Math.max(0, pulse - dt * 3.5);
    if (bass > 0.6 && bass > avgBass * 1.25 && kick < 0.4) { kick = 1; if (scene) scene.kicks++; } // the bass jumping above its recent average
    // the metronome: the song's own BPM, counted from where the song is, so it stays on the beat after seeking.
    // Each beat punches everything; every 8 beats it's the next scene.
    if (!scene) newScene();
    if (bpm && !audio.paused) {
      const n = Math.floor((audio.currentTime * bpm) / 60);
      if (n !== lastBeat) {
        if (lastBeat !== null) { pulse = 1; if (Math.floor(n / 8) !== Math.floor(lastBeat / 8)) newScene(); }
        lastBeat = n;
      }
    } else if (scene.kicks >= 8 || clock - scene.born > 20) newScene(); // no BPM saved for this song: every 8 kicks (or 20 s)
    const sc = scene, cx = W / 2, cy = H / 2, S = Math.min(W, H) * (0.9 + pulse * 0.07 + level * 0.12);
    const hue = sc.hue + t * 6 + bassS * 50; // which of the cover's colours, drifting slowly between them
    // a colour from the cover's palette: h picks a point along it (blending neighbouring colours), l is lightness
    const hsl = (h, l = 60, a = 1) => {
      const L = Math.min(92, l); // no brightness change on the beat (flashing is hard on the eyes)
      if (!pal) return `hsla(0,0%,${L}%,${a})`;
      const n = pal.length, q = ((((h % 360) + 360) % 360) / 360) * n, k = Math.floor(q) % n, f = q - Math.floor(q), A = pal[k], B = pal[(k + 1) % n];
      let dh = B.h - A.h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
      return `hsla(${(A.h + dh * f + 360) % 360},${Math.max(45, A.s + (B.s - A.s) * f)}%,${L}%,${a})`;
    };

    // the last frame, carried over: moved, blurred, colour-shifted and a bit darker
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    bg.setTransform(1, 0, 0, 1, 0, 0); bg.globalCompositeOperation = 'copy'; bg.drawImage(cv, 0, 0);
    g.fillStyle = pal ? `hsl(${pal[0].h},${Math.round(pal[0].s * 0.5)}%,4%)` : '#05060a'; g.fillRect(0, 0, W, H); // the darkest of the cover's colour
    sc.dir += dt * 0.2 * Math.sin(t * 0.13);
    const push = sc.drift * S * (0.0045 + level * 0.006), zoom = sc.zoom + bassS * 0.02 + pulse * 0.018;
    g.save(); g.translate(cx + Math.cos(sc.dir) * push, cy + Math.sin(sc.dir) * push - sc.rise * S * (0.004 + level * 0.004)); g.rotate(sc.rot * (1 + level)); g.scale(zoom, zoom); g.translate(-cx, -cy);
    g.globalAlpha = sc.alpha;
    g.drawImage(buf, 0, 0, W, H);
    g.restore(); g.globalAlpha = 1;
    g.globalCompositeOperation = 'lighter';

    // the camera, and 3D → screen
    const sp = 1 + level * 2.5 + kick * 3;
    cam.ax += cam.vx * dt * sp; cam.ay += cam.vy * dt * sp; cam.az += cam.vz * dt * sp;
    if (pulse > 0.95 || kick > 0.95) { cam.vx += rnd(-0.25, 0.25); cam.vy += rnd(-0.25, 0.25); cam.vz += rnd(-0.1, 0.1); }
    cam.vx *= 0.995; cam.vy *= 0.995;
    const [sx, cxr, sy, cyr, sz, czr] = [Math.sin(cam.ax), Math.cos(cam.ax), Math.sin(cam.ay), Math.cos(cam.ay), Math.sin(cam.az), Math.cos(cam.az)];
    const proj = (x, y, z) => {
      const y1 = y * cxr - z * sx, z1 = y * sx + z * cxr, x2 = x * cyr + z1 * sy, z2 = -x * sy + z1 * cyr;
      const x3 = x2 * czr - y1 * sz, y3 = x2 * sz + y1 * czr, f = 2.6 / Math.max(0.4, 2.6 + z2);
      return [cx + x3 * f * S * 0.62, cy + y3 * f * S * 0.62, f];
    };
    const step = n => Math.floor(wave.length / n), w = k => (wave[k] - 128) / 128;

    if (sc.kind === 'helix') {
      // two strands of square dots twisting round each other; the waveform ripples them, the spectrum swells them
      const N = 120, spec = bands(N, 40, 12000), st = step(N), tw = 3 + bassS * 2;
      for (let strand = 0; strand < 2; strand++) for (let k = 0; k < N; k++) {
        const u = k / (N - 1), a = u * Math.PI * 2 * tw + t * 1.2 + strand * Math.PI, r = 0.22 + spec[k] * 0.35;
        const [px, py, f] = proj((u - 0.5) * 1.9, Math.sin(a) * r + w(k * st) * 0.12, Math.cos(a) * r), sz = (1.4 + spec[k] * 2.6) * f * (1 + level * 0.6);
        g.fillStyle = hsl(hue + u * 300 + strand * 60, 50 + f * 18, 0.75 + spec[k] * 0.25);
        g.fillRect(px - sz, py - sz, sz * 2, sz * 2);
      }
      if (kick > 0.95 && sparks.length < 24) for (let n = 0; n < 4; n++) { const [px, py] = proj(rnd(-0.9, 0.9), 0, 0); sparks.push({ x: px, y: py, vx: rnd(-0.3, 0.3) * S, vy: rnd(-0.3, 0.3) * S, life: 1, h: hue + rnd(0, 200) }); }
    } else if (sc.kind === 'tunnel') {
      // rings rushing at you down a tunnel; their edges bend with the spectrum, the whole thing twists
      const R = 16, sides = sc.sides, b = bands(sides === 48 ? 48 : sides * 4);
      sc.phase = ((sc.phase || 0) + dt * (0.35 + level * 1.4)) % 1;
      for (let j = R - 1; j >= 0; j--) {
        const z = (j + 1 - sc.phase) / R, near = 1 - z, sr = (S * 0.09) / (z * 1.1 + 0.05);
        g.strokeStyle = hsl(hue + j * 22, 30 + near * 45, 0.15 + near * 0.8); g.lineWidth = 0.6 + near * 3.2;
        g.beginPath();
        for (let v = 0; v <= sides; v++) {
          const a = (v / sides) * Math.PI * 2 + j * sc.twist + t * 0.4, bend = 1 + b[(v * Math.floor(b.length / sides)) % b.length] * 0.45 * (0.4 + bassS);
          const x = cx + Math.cos(a) * sr * bend + Math.sin(t * 0.7 + j * 0.3) * S * 0.04 * z, y = cy + Math.sin(a) * sr * bend + Math.cos(t * 0.5 + j * 0.3) * S * 0.04 * z;
          v ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    } else if (sc.kind === 'aurora') {
      // five glowing curtains waving across the screen; louder = taller waves; their trails drift up and fade
      const b = bands(5, 40, 8000);
      for (let l = 0; l < 5; l++) {
        const base = H * (0.42 + l * 0.08), amp = S * (0.05 + b[l] * 0.14 + bassS * 0.05), f1 = 0.004 + l * 0.0012, f2 = 0.011 - l * 0.001;
        g.beginPath();
        for (let x = -10; x <= W + 10; x += 10) { const y = base + Math.sin(x * f1 + t * (0.6 + l * 0.17) + l) * amp + Math.sin(x * f2 - t * (1.1 - l * 0.1)) * amp * 0.45; x < 0 ? g.moveTo(x, y) : g.lineTo(x, y); }
        for (const [lw, al] of [[18 + b[l] * 30, 0.06], [6, 0.16], [1.5, 0.55]]) { g.lineWidth = lw; g.strokeStyle = hsl(hue + l * 55, 62, al + level * al); g.stroke(); }
      }
    } else if (sc.kind === 'spiro') {
      // a spirograph drawing itself: its loops change with the bass, and the long trails let the lace build up
      const r = sc.r, d = 0.25 + bassS * 0.55 + Math.sin(t * 0.2) * 0.1, sc2 = S * 0.36 * (0.85 + level * 0.25), steps = 140;
      g.lineWidth = 1 + level * 1.2; g.beginPath();
      for (let k = 0; k <= steps; k++) {
        const th = sc.theta + k * 0.02, rr = 1 - r;
        const x = rr * Math.cos(th) + d * Math.cos((rr / r) * th), y = rr * Math.sin(th) - d * Math.sin((rr / r) * th), rot = t * 0.15;
        const px = cx + (x * Math.cos(rot) - y * Math.sin(rot)) * sc2, py = cy + (x * Math.sin(rot) + y * Math.cos(rot)) * sc2;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.strokeStyle = hsl(hue + sc.theta * 8, 60, 0.55 + level * 0.4); g.stroke();
      sc.theta += steps * 0.02 * (0.6 + level * 0.8);
    } else if (sc.kind === 'planet') {
      // a sphere of dots that breathes with the bass; each band of latitude bulges with its part of the spectrum
      const b = bands(24), R = 0.42 * (0.85 + bassS * 0.35);
      for (const [x, y, z] of SPHERE) {
        const band = b[Math.min(23, Math.floor((y + 1) * 12))], wob = 1 + band * 0.45 + Math.sin(Math.atan2(z, x) * 6 + t * 2) * 0.04 * level;
        const [px, py, f] = proj(x * R * wob, y * R * wob, z * R * wob), sz = (1.2 + band * 2.6) * f;
        g.fillStyle = hsl(hue + y * 140 + band * 60, 45 + f * 25, Math.min(1, 0.55 + band * 0.45) * Math.min(1, f));
        g.fillRect(px - sz, py - sz, sz * 2, sz * 2);
      }
      if (kick > 0.95 && sparks.length < 24) for (let n = 0; n < 6; n++) { const a = rnd(0, Math.PI * 2); sparks.push({ x: cx, y: cy, vx: Math.cos(a) * S * 0.45, vy: Math.sin(a) * S * 0.45, life: 1, h: hue + rnd(0, 200) }); }
    } else if (sc.kind === 'galaxy') {
      // stars swirling in spiral arms, falling inward faster when it's loud; the trails twist into a vortex
      const sp = 0.03 + level * 0.18;
      for (const q of stars) {
        q.r -= dt * sp * (0.4 + q.r); q.a += dt * (0.35 + level * 1.2) / (0.15 + q.r);
        if (q.r < 0.03) { q.r = rnd(0.85, 1); q.a = rnd(0, Math.PI * 2); }
        const arm = (q.k % sc.arms) * ((Math.PI * 2) / sc.arms), a = q.a + arm + q.r * 3, px = cx + Math.cos(a) * q.r * S * 0.62, py = cy + Math.sin(a) * q.r * S * 0.42;
        const sz = 0.7 + (1 - q.r) * 1.6 + bassS;
        g.fillStyle = hsl(hue + q.r * 200, 55, 0.35 + (1 - q.r) * 0.5); g.fillRect(px - sz, py - sz, sz * 2, sz * 2);
      }
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, S * (0.05 + bassS * 0.05)); core.addColorStop(0, hsl(hue + 30, 50, 0.35)); core.addColorStop(1, hsl(hue + 30, 50, 0));
      g.fillStyle = core; g.fillRect(cx - S * 0.1, cy - S * 0.1, S * 0.2, S * 0.2);
    } else if (sc.kind === 'scope') {
      // the sound itself as a shape: each sample against one a moment later (like an oscilloscope in XY mode),
      // spinning in 3D. Real music makes it knot and bloom
      const N = 600, lag = sc.lag, gain = 1.6 + bassS;
      g.lineWidth = 1.3 + level; g.beginPath();
      for (let k = 0; k < N; k++) {
        const j = Math.floor((k / N) * (wave.length - lag - 1)), [px, py] = proj(w(j) * gain * 0.6, w(j + lag) * gain * 0.6, Math.sin(k * 0.02 + t) * 0.25);
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.strokeStyle = hsl(hue + t * 20, 60, 0.6 + level * 0.35); g.stroke();
    } else if (sc.kind === 'terrain') {
      // the spectrum as a landscape rolling towards you (a new row every 50 ms), drawn as glowing lines
      landT += dt;
      if (landT > 0.05 || !land.length) { landT = 0; land.unshift(Array.from(bands(40))); if (land.length > 30) land.pop(); }
      // a wireframe: each row of the spectrum as a ridge line, joined front to back, in perspective from just above it
      const horizon = H * 0.36, pts = land.map((row, r) => {
        const z = (r + landT / 0.05) / 30, f = 1 / (z * 2.4 + 0.3);
        return row.length && Array.from({ length: 40 }, (_, c) => {
          const v = row[c < 20 ? 19 - c : c - 20] * (0.8 + bassS * 0.9); // low notes in the middle, mirrored out
          return [cx + (c / 39 - 0.5) * 3.4 * f * S * 0.5, horizon + (0.42 - v * 1.1) * f * S * 0.5, z];
        });
      });
      for (let r = pts.length - 1; r >= 0; r--) {
        const row = pts[r], near = 1 - row[0][2];
        g.strokeStyle = hsl(hue + r * 7, 35 + near * 30, 0.1 + near * 0.8); g.lineWidth = 0.6 + near * 1.8;
        g.beginPath(); row.forEach(([x, y], c) => (c ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
        if (r > 0) { // the lines running towards you
          const prev = pts[r - 1]; g.lineWidth = 0.5 + near; g.beginPath();
          for (let c = 0; c < 40; c += 3) { g.moveTo(row[c][0], row[c][1]); g.lineTo(prev[c][0], prev[c][1]); }
          g.stroke();
        }
      }
    } else {
      // kaleidoscope: blobs and a strand of waveform in one slice, mirrored round; the inward spin turns it into a tunnel
      const n = sc.n, b = bands(16), N = 30, st = step(N);
      for (let s2 = 0; s2 < n; s2++) {
        g.save(); g.translate(cx, cy); g.rotate((s2 / n) * Math.PI * 2 + t * 0.12); if (s2 % 2) g.scale(1, -1);
        for (let k = 0; k < 16; k += 2) {
          const d = S * (0.06 + (k / 16) * 0.4) * (1 + bassS * 0.25), sz = 1.5 + b[k] * S * 0.03;
          g.fillStyle = hsl(hue + k * 14 + s2 * 6, 55, 0.3 + b[k] * 0.6);
          g.beginPath(); g.arc(d, Math.sin(t * 1.3 + k) * d * 0.22, sz, 0, Math.PI * 2); g.fill();
        }
        g.strokeStyle = hsl(hue + 120, 60, 0.35 + level * 0.4); g.lineWidth = 1;
        g.beginPath(); for (let k = 0; k < N; k++) { const x = (k / N) * S * 0.45, y = w(k * st) * S * 0.05; k ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
        g.restore();
      }
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
