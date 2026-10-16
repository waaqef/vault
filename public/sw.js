// Keeps the app itself available offline. Downloaded audio is stored separately by app.js (Cache "audio").
const V = 'shell-v73';
const SHELL = ['/', '/style.css', '/app.js', '/editor.js', '/types.js', '/wav.js', '/lib/soundtouch.js', '/icons.js', '/settings.js', '/detect.js', '/zip.js', '/wave.js', '/fonts/inter.woff2', '/fonts/plex-mono.woff2', '/manifest.json', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('shell-') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|s|blob)\//.test(u.pathname)) return;
  // Network first so updates show up straight away; fall back to the cached copy when offline.
  // no-cache = always revalidate with the server, so an update shows up on the next load.
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('/'))));
});

// Push notifications (listens and comments on share links).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || '[vault]', { body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === location.origin);
    return open ? open.focus().then(c => (url !== location.origin + '/' ? c.navigate(url) : c)) : self.clients.openWindow(url);
  }));
});
