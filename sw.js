// network-first so updates show up; cache is the offline fallback
const C = 'medidote';
addEventListener('install', e => { skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./', 'index.html', 'js/app.js', 'js/assign.js', 'js/theme.js', 'js/vendor/pdf.min.js', 'js/vendor/pdf.worker.min.js', 'manifest.json', 'assets/icons/icon.png', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/favicon-32.png', 'assets/icons/favicon-64.png'])));});
addEventListener('activate', e => e.waitUntil(clients.claim()));
addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(   // the cache only stores GET requests; other calls (like the AI function) go straight to the network
  fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request))
); });
