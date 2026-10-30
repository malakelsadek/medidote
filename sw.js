// network-first so updates show up; cache is the offline fallback
const C = 'medidote';
addEventListener('install', e => { skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./', 'index.html', 'app.js', 'assign.js', 'theme.js', 'pdf.min.js', 'pdf.worker.min.js', 'manifest.json', 'icon.png', 'icon-192.png', 'icon-512.png', 'favicon-32.png', 'favicon-64.png'])));});
addEventListener('activate', e => e.waitUntil(clients.claim()));
addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(   // the cache only stores GET requests; other calls (like the AI function) go straight to the network
  fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request))
); });
