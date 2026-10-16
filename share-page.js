// The public listen page for share links. Data is loaded by script and rendered with textContent, never as HTML.
export const sharePage = exists => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>[vault]</title><meta name="robots" content="noindex"><meta name="theme-color" content="#191919">
<style>
@font-face{font-family:Inter;src:url(/fonts/inter.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Plex Mono";src:url(/fonts/plex-mono.woff2) format("woff2");font-display:swap}
:root{--bg:#191919;--fg:#fff;--fg2:rgba(255,255,255,.62);--fg3:rgba(255,255,255,.38);--f1:rgba(255,255,255,.04);--f2:rgba(255,255,255,.07);--ease:cubic-bezier(.2,.8,.2,1);color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:400 14px/1.45 Inter,system-ui,-apple-system,sans-serif;letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
.mono{font-family:"Plex Mono",ui-monospace,monospace;font-size:11px;color:var(--fg3);letter-spacing:0}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
main{max-width:680px;margin:0 auto;padding:48px 16px 140px}
main>*{animation:rise .45s var(--ease) both}
.brand{display:inline-block;color:inherit;text-decoration:none;font-weight:600;letter-spacing:-.035em;font-size:16px;margin-bottom:44px}
.head{display:flex;gap:24px;align-items:flex-end;margin-bottom:32px}
.cover{width:148px;height:148px;border-radius:14px;background:var(--f1) center/cover;flex:none;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.disc{border-radius:50%;background:radial-gradient(circle,var(--bg) 0 13%,rgba(255,255,255,.35) 13.5% 15%,transparent 15.5%),conic-gradient(from 30deg,#2a2a2a,#6d6d6d 12%,#2e2e2e 25%,#8a8a8a 38%,#2b2b2b 52%,#5e5e5e 66%,#262626 80%,#7a7a7a 92%,#2a2a2a);animation:spin 14s linear infinite}
h1{font-size:36px;font-weight:500;letter-spacing:-.045em;margin:6px 0;line-height:1.05}
.row{display:grid;grid-template-columns:28px 1fr 84px auto;align-items:center;gap:12px;padding:12px;border-radius:12px;cursor:pointer;transition:background .15s;animation:rise .4s var(--ease) both}
.row.has-dl{grid-template-columns:28px 1fr 84px auto 34px}.row .t{display:flex;flex-direction:column;min-width:0}.row .tn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.row .ta{font-size:12px;color:var(--fg3)}.dl{width:34px;height:34px;padding:0;border-radius:50%;background:none;color:var(--fg2);display:grid;place-items:center}.dl:hover{background:var(--f2);color:var(--fg)}.dl:disabled{opacity:.4}.row:hover{background:var(--f1)}.row.on{background:var(--f2)}
.row .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bars{display:none;gap:2px;height:14px;align-items:flex-end}.row.on .bars{display:flex}.row.on .n{display:none}
.bars i{width:3px;height:14px;background:#fff;border-radius:2px;transform-origin:bottom;animation:eq .9s ease-in-out infinite}
.bars i:nth-child(2){animation-duration:.7s;animation-delay:-.3s}.bars i:nth-child(3){animation-duration:1.1s;animation-delay:-.55s}
body.paused .bars i{animation-play-state:paused}
form{display:grid;gap:12px;max-width:320px;margin:12vh auto 0;text-align:center}
input,button{font:inherit;letter-spacing:inherit;padding:0 16px;height:42px;border-radius:999px;border:1px solid transparent;background:var(--f1);color:var(--fg);outline:none}
input:focus{border-color:rgba(255,255,255,.28)}
button{background:#fff;color:var(--bg);border:0;font-weight:500;cursor:pointer;transition:transform .12s var(--ease)}button:active{transform:scale(.97)}
audio{position:fixed;left:0;right:0;margin:0 auto;bottom:calc(16px + env(safe-area-inset-bottom));width:min(648px,calc(100% - 32px));animation:rise .4s var(--ease)}
.err{color:#ff6b63;min-height:1em}
.mw{display:block;width:80px;height:20px}
.now{position:sticky;top:0;z-index:2;margin:0 -12px 18px;padding:14px 12px 12px;border-radius:16px;background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27140%27 height=%27140%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.9%27 numOctaves=%272%27 stitchTiles=%27stitch%27/%3E%3CfeColorMatrix values=%270 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .16 0 0 0 0%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E") 0 0/140px,linear-gradient(165deg,rgba(62,62,62,.66),rgba(28,28,28,.6));-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 12px 40px rgba(0,0,0,.35);animation:rise .35s var(--ease)}
.now[hidden]{display:none}
.now-t{font-weight:500;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wave{display:block;width:100%;height:64px;cursor:pointer;touch-action:none}
.times{display:flex;justify-content:space-between;margin:4px 0 10px}
.cform{display:flex;gap:8px;max-width:none;margin:0;text-align:left}.cform input{flex:1;min-width:0}.cform button{flex:none}.cform button:disabled{opacity:.5}
.clist{display:grid;gap:2px;margin-top:8px;max-height:30vh;overflow-y:auto}
.cm{animation:rise .3s var(--ease) both;display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:baseline;padding:6px 2px;font-size:13px;color:var(--fg2)}.cm b{color:var(--fg);font-weight:600}
.ts{height:auto;padding:2px 9px;border-radius:999px;background:rgba(255,210,63,.16);color:#ffdf7a;font:11px "Plex Mono",ui-monospace,monospace}
.req{display:grid;gap:8px;max-width:none;margin:4px 0 0;text-align:left}.linkish{background:none;color:var(--fg2);height:auto;padding:4px 0;font-weight:400;text-decoration:underline;text-underline-offset:3px;justify-self:start}
.gate{display:grid;gap:10px;margin:0 -12px 18px;padding:16px;border-radius:16px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);transition:box-shadow .3s,background .3s}
.gate p{margin:0;color:var(--fg2)}.gate .acts{display:flex;gap:8px;flex-wrap:wrap}.gate a{display:inline-grid;place-items:center;height:38px;padding:0 18px;border-radius:999px;font-weight:500;text-decoration:none;background:#fff;color:var(--bg)}
.gate a.alt{background:rgba(255,255,255,.08);color:var(--fg)}.gate.ping{background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.4)}
.save{margin-top:12px;height:34px;padding:0 16px;font-size:13px}.save.on{background:rgba(255,255,255,.1);color:var(--fg)}
@media(max-width:560px){.mwrap{display:none}.row{grid-template-columns:28px 1fr auto}.row.has-dl{grid-template-columns:28px 1fr auto 34px}.head{flex-direction:column;align-items:flex-start}.cover{width:120px;height:120px}h1{font-size:28px}}
@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-iteration-count:1!important}}
</style></head><body><main id="m">${exists ? '' : '<div class="brand">[vault]</div><h1>Link not available</h1><p class="mono">[it may have expired or been turned off]</p>'}</main>
${exists ? `<audio id="a" controls hidden></audio>
<script>
const token = location.pathname.split('/')[2], base = '/s/' + token, m = document.getElementById('m'), a = document.getElementById('a');
const el = (t, p = {}, ...k) => { const e = document.createElement(t); Object.assign(e, p); e.append(...k); return e; };
const fmt = s => s ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '';
const brand = () => el('a', { className: 'brand', href: '/', textContent: '[vault]' });
let name = ''; try { name = localStorage.getItem('listener') || ''; } catch {}
async function open(password) {
  const r = await fetch(base + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const d = await r.json();
  if (r.status === 401) return ask(password ? d.error : '');
  if (!r.ok) { m.replaceChildren(brand(), el('h1', { textContent: 'Link not available' })); return; }
  if (d.viewer) name = d.viewer.username;
  show(d);
}
function ask(err) {
  const i = el('input', { type: 'password', placeholder: 'Password', required: true, autofocus: true });
  const f = el('form', {}, el('div', { className: 'brand', textContent: '[vault]', style: 'margin:0 0 8px' }), el('div', { className: 'mono', textContent: '[password needed]' }), i, el('button', { textContent: 'Open' }), el('div', { className: 'err', textContent: err || '' }));
  f.onsubmit = e => { e.preventDefault(); open(i.value); };
  m.replaceChildren(f);
}
function show(d) {
  // Signed in to [vault]: full songs, comments, downloads and saving. Otherwise: short previews and a sign-in card.
  const full = !!d.viewer || d.public, next = encodeURIComponent(location.pathname); // public links: full songs for everyone
  a.controls = full; // a preview's player bar would show the cut-down length
  const gate = full ? null : el('div', { className: 'gate' },
    el('div', { className: 'mono', textContent: '[preview]' }),
    el('p', { textContent: 'You\u2019re hearing ' + d.preview + '-second previews. Sign in to [vault] to hear the full songs, comment' + (d.allow_download ? ', download' : '') + ' and save this to your library.' }),
    el('div', { className: 'acts' }, el('a', { href: '/?next=' + next, textContent: 'Sign in' }), el('a', { className: 'alt', href: '/?signup=1&next=' + next, textContent: 'Sign up with an invite code' })),
    askInvite());
  // No invite code? Send the admin a request (name, how to reach you, a note).
  function askInvite() {
    const nm = el('input', { placeholder: 'Your name', maxLength: 80, required: true, value: name }), ct = el('input', { placeholder: 'How to reach you (Instagram, email…)', maxLength: 200 });
    const note = el('input', { placeholder: 'A note (optional)', maxLength: 500 }), msg = el('div', { className: 'mono' });
    const f = el('form', { className: 'req', hidden: true }, nm, ct, note, el('button', { textContent: 'Ask for an invite' }), msg);
    f.onsubmit = async e => {
      e.preventDefault(); f.querySelector('button').disabled = true;
      try {
        const r = await fetch(base + '/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: nm.value, contact: ct.value, message: note.value }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'That didn’t send');
        f.replaceChildren(el('p', { textContent: 'Sent. You’ll hear back if you get an invite.' }));
      } catch (x) { msg.textContent = x.message; f.querySelector('button').disabled = false; }
    };
    const open = el('button', { className: 'linkish', type: 'button', textContent: 'No invite code? Ask for one' });
    open.onclick = () => { open.remove(); f.hidden = false; nm.focus(); };
    return el('div', {}, open, f);
  }
  const nudge = () => { gate.classList.add('ping'); gate.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => gate.classList.remove('ping'), 900); };
  const ck = d.cover || d.tracks.find(t => t.cover)?.cover;
  const cover = el('div', { className: 'cover' + (ck ? '' : ' disc') });
  if (ck) cover.style.backgroundImage = 'url("' + base + '/cover?k=' + encodeURIComponent(ck) + '")';
  const DL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/></svg>';
  async function download(t, btn) {
    if (!full) return nudge();
    btn.disabled = true;
    try {
      const r = await fetch(base + '/download/' + t.id), j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Download failed');
      const blob = await (await fetch(j.url)).blob(), u = URL.createObjectURL(blob);
      const link = el('a', { href: u, download: j.filename });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } catch (e) { alert(e.message); }
    btn.disabled = false;
  }
  // Waveforms arrive as 100 base64 characters, one per bar (0-63).
  const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', ACC = '#ffd23f';
  const peaksOf = s => (s ? s.split('').map(ch => Math.max(0, ABC.indexOf(ch)) / 63) : null);
  function miniWave(p) {
    const c = el('canvas', { className: 'mw', width: 160, height: 40 });
    if (p) {
      const g = c.getContext('2d'); g.fillStyle = 'rgba(255,255,255,.32)';
      for (let i = 0; i < 40; i++) { const hh = Math.max(3, Math.pow(p[Math.floor((i * p.length) / 40)], 1.8) * 36); g.fillRect(i * 4, (40 - hh) / 2, 2, hh); }
    }
    return c;
  }
  const rows = d.tracks.map((t, i) => {
    const kids = [
      el('span', { className: 'mono' }, el('span', { className: 'n', textContent: String(i + 1).padStart(2, '0') }), el('span', { className: 'bars' }, el('i'), el('i'), el('i'))),
      el('span', { className: 't' }, el('span', { className: 'tn', textContent: t.name }), t.artist ? el('span', { className: 'ta', textContent: t.artist }) : ''),
      el('span', { className: 'mwrap' }, miniWave(peaksOf(t.peaks))),
      el('span', { className: 'mono', textContent: fmt(t.duration) }),
    ];
    if (d.allow_download) {
      const btn = el('button', { className: 'dl', title: 'Download', innerHTML: DL });
      btn.setAttribute('aria-label', 'Download ' + t.name);
      btn.onclick = e => { e.stopPropagation(); download(t, btn); };
      kids.push(btn);
    }
    const r = el('div', { className: 'row' + (d.allow_download ? ' has-dl' : '') }, ...kids);
    r.style.animationDelay = (0.1 + Math.min(i, 16) * 0.025) + 's';
    r.onclick = () => play(i);
    return r;
  });

  // Now playing: a big waveform to scrub, blue dots where people commented, and a comment box.
  const cv = el('canvas', { className: 'wave' });
  cv.setAttribute('aria-label', 'Seek');
  const tNow = el('span', { className: 'mono', textContent: '0:00' }), tEnd = el('span', { className: 'mono' });
  const nowName = el('div', { className: 'now-t' });
  const input = el('input', { placeholder: 'Comment…', maxLength: 1000 });
  input.setAttribute('aria-label', 'Comment');
  const post = el('button', { textContent: 'Post', type: 'submit' });
  const who = d.viewer ? null : el('input', { placeholder: 'Your name', maxLength: 80, value: name, style: 'flex:0 0 120px' });
  if (who) who.setAttribute('aria-label', 'Your name');
  const form = el('form', { className: 'cform' }, who || '', input, post);
  const list = el('div', { className: 'clist' });
  const now = el('section', { className: 'now', hidden: true }, nowName, cv, el('div', { className: 'times' }, tNow, tEnd), full ? form : '', list);
  let comments = [], pk = null, frame = 0, atMark = null;
  const clock = s => fmt(s) || '0:00';
  function draw() {
    const w = cv.clientWidth, hh = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || cur < 0) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    const dur = (full && a.duration) || d.tracks[cur].duration || a.duration || 0, p = dur ? a.currentTime / dur : 0, n = Math.max(20, Math.floor(w / 4));
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, (pk ? Math.pow(pk[Math.floor((i * pk.length) / n)], 1.8) : 0.05) * (hh - 14));
      g.fillStyle = (i + 0.5) / n <= p ? '#fff' : 'rgba(255,255,255,.26)';
      g.fillRect(i * 4, (hh - 8 - bh) / 2, 2, bh);
    }
    if (dur) {
      g.fillStyle = ACC;
      for (const c of comments) if (c.at != null) { g.beginPath(); g.arc(Math.min(w - 3, Math.max(3, (c.at / dur) * w)), hh - 3, 3, 0, 7); g.fill(); }
    }
  }
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); };
  addEventListener('resize', redraw);
  function seekTo(e) {
    const r = cv.getBoundingClientRect(), dur = (full && a.duration) || d.tracks[cur].duration || 0;
    if (!dur) return;
    const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur;
    if (!full && at >= d.preview) return nudge();
    a.currentTime = at; redraw();
  }
  cv.onpointerdown = e => { seekTo(e); cv.setPointerCapture(e.pointerId); cv.onpointermove = seekTo; };
  cv.onpointerup = cv.onpointercancel = () => { cv.onpointermove = null; };
  function drawComments() {
    list.replaceChildren(...comments.slice().sort((x, y) => (x.at ?? 1e9) - (y.at ?? 1e9)).map(c => {
      const b = el('button', { className: 'ts', type: 'button', textContent: c.at == null ? '·' : clock(c.at) });
      b.onclick = () => { if (c.at != null) { a.currentTime = c.at; a.play(); } };
      return el('div', { className: 'cm' }, b, el('div', {}, el('b', { textContent: c.name }), el('span', { textContent: ' ' + c.body })));
    }));
  }
  async function loadComments(t) {
    comments = []; drawComments();
    try { const r = await fetch(base + '/comments?track=' + t.id); if (r.ok && d.tracks[cur] === t) comments = await r.json(); } catch {}
    drawComments(); redraw();
  }
  // The comment is pinned to the moment you started typing.
  input.oninput = () => { if (atMark == null && input.value) atMark = a.currentTime || 0; };
  form.onsubmit = async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || cur < 0) return;
    post.disabled = true;
    try {
      const at = atMark ?? (a.currentTime || 0);
      if (who) { name = who.value.trim() || 'Anonymous'; try { localStorage.setItem('listener', name); } catch {} }
      const r = await fetch(base + '/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track_id: d.tracks[cur].id, name, at, body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Couldn’t post that');
      comments.push(j); input.value = ''; atMark = null; drawComments(); redraw();
    } catch (x) { alert(x.message); }
    post.disabled = false;
  };

  // One "listen" per play of a track; how far they got is reported every 10 s and when they leave.
  let cur = -1, listenId = null, maxT = 0, timer = 0, starting = null;
  function progress(leaving) {
    if (!listenId) return;
    const body = JSON.stringify({ id: listenId, seconds: maxT, duration: a.duration || (d.tracks[cur] || {}).duration || null });
    if (leaving && navigator.sendBeacon) navigator.sendBeacon(base + '/progress', new Blob([body], { type: 'application/json' }));
    else fetch(base + '/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
  function play(i) {
    progress(true); clearInterval(timer);
    listenId = null; starting = null; maxT = 0; cur = i; atMark = null;
    const t = d.tracks[i];
    rows.forEach((r, j) => r.classList.toggle('on', j === i));
    now.hidden = false; nowName.textContent = t.name; tEnd.textContent = clock(t.duration); tNow.textContent = '0:00';
    pk = peaksOf(t.peaks); loadComments(t); redraw();
    a.hidden = false; a.src = base + '/audio/' + t.id + (full ? '?full=1' : ''); a.play(); // separate URLs, so a preview is never cached as the song
  }
  a.onplay = async () => {
    document.body.classList.remove('paused');
    if (full && !listenId && !starting && cur >= 0) {
      const t = d.tracks[cur];
      starting = fetch(base + '/listen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track_id: t.id, name, duration: t.duration }) })
        .then(r => r.json()).then(j => { listenId = j.id; }).catch(() => {});
    }
    clearInterval(timer); timer = setInterval(() => progress(false), 10000);
  };
  a.onloadedmetadata = () => { if (full) tEnd.textContent = clock(a.duration); redraw(); };
  a.ontimeupdate = () => {
    if (!full && a.currentTime >= d.preview) { a.pause(); a.currentTime = 0; nudge(); }
    if (a.currentTime > maxT) maxT = a.currentTime;
    tNow.textContent = clock(a.currentTime);
    if (!input.value) input.placeholder = 'Comment at ' + clock(a.currentTime) + '…';
    redraw();
  };
  a.onpause = () => { document.body.classList.add('paused'); clearInterval(timer); progress(false); };
  // some .m4a files can't be previewed (their index is at the end); say so instead of failing silently
  a.onerror = () => { if (!full && cur >= 0) { gate.querySelector('p').textContent = 'This song doesn’t have a preview. Sign in to [vault] to hear it.'; nudge(); } };
  a.onended = () => { if (!full) return nudge(); maxT = a.duration || maxT; progress(false); clearInterval(timer); if (cur + 1 < rows.length) play(cur + 1); };
  addEventListener('pagehide', () => progress(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') progress(true); });
  let saveBtn = '';
  if (d.viewer && !d.viewer.mine) {
    saveBtn = el('button', { className: 'save' });
    const paint = () => { saveBtn.classList.toggle('on', d.viewer.saved); saveBtn.textContent = d.viewer.saved ? '\u2713 In your library' : '+ Save to my library'; };
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try { const r = await fetch(base + '/save', { method: d.viewer.saved ? 'DELETE' : 'POST' }); if (r.ok) d.viewer.saved = (await r.json()).saved; } catch {}
      saveBtn.disabled = false; paint();
    };
    paint();
  }
  m.replaceChildren(brand(), el('div', { className: 'head' }, cover, el('div', {}, el('div', { className: 'mono', textContent: '[shared with you]' }), el('h1', { textContent: d.name }), el('div', { className: 'mono', textContent: d.tracks.length + (d.tracks.length === 1 ? ' track' : ' tracks') + (d.allow_download ? ' · downloads on' : '') }), saveBtn)), gate || '', now, ...rows);
}
open();
</script>` : ''}
</body></html>`;
