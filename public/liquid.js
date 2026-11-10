// The background glow moves like a fast liquid as you scroll: scrolling pushes the colour blobs around and turns
// their colours, and a quick spring (a fast pull with a little overshoot) carries them there and lets them settle.
// When you're not scrolling it keeps floating: each blob drifts on its own slow loop and the colours sway.
// Used by the About page (its .wash blobs) and the simple pages (their body::before wash, through CSS variables).
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const blobs = [...document.querySelectorAll('.wash i')];
  const wash = document.querySelector('.wash');
  // one spring per value: k = stiffness (snappy), c = damping (a touch of overshoot, so it feels liquid)
  const K = 210, C = 19;
  const spring = () => ({ x: 0, v: 0, t: 0 });
  const hue = spring(), parts = (blobs.length ? blobs : [root]).map(() => ({ x: spring(), y: spring() }));
  function aim(now) {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight), p = Math.min(1, scrollY / max);
    const t = now / 1000; // seconds: the idle float, a slow loop per blob
    hue.t = p * 210 + Math.sin(t * 0.3) * 24; // degrees: the colours turn as you go down the page, and sway
    parts.forEach((b, k) => {
      b.x.t = Math.sin(p * Math.PI * 1.6 + k * 1.9) * 9 + Math.sin(t * (0.33 + k * 0.06) + k * 2.1) * 5; // vw
      b.y.t = Math.cos(p * Math.PI * 1.3 + k * 1.2) * 7 - p * 6 + Math.cos(t * (0.27 + k * 0.05) + k * 1.3) * 4; // vh
    });
  }
  let last = 0;
  // Runs every frame (the browser pauses it on its own when the page isn't on screen).
  function step(now) {
    const dt = Math.min(0.033, (now - (last || now)) / 1000) || 0.016; last = now;
    aim(now);
    for (const s of [hue, ...parts.flatMap(b => [b.x, b.y])]) { s.v += (K * (s.t - s.x) - C * s.v) * dt; s.x += s.v * dt; }
    parts.forEach((b, k) => {
      // stretch a little with speed, like a drop being pulled
      const stretch = 1 + Math.min(0.3, Math.hypot(b.x.v, b.y.v) * 0.006);
      if (blobs.length) { blobs[k].style.translate = `${b.x.x.toFixed(2)}vw ${b.y.x.toFixed(2)}vh`; blobs[k].style.scale = stretch.toFixed(3); }
      else { root.style.setProperty('--lx', b.x.x.toFixed(2) + 'vw'); root.style.setProperty('--ly', b.y.x.toFixed(2) + 'vh'); root.style.setProperty('--ls', stretch.toFixed(3)); }
    });
    (wash || root).style.setProperty('--lh', hue.x.toFixed(1) + 'deg');
    requestAnimationFrame(step);
  }
  aim(performance.now());
  parts.forEach(b => { b.x.x = b.x.t; b.y.x = b.y.t; }); hue.x = hue.t; // start where the float is, not with a jump
  requestAnimationFrame(step);
})();
