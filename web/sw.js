// OnVideo service worker — 설치 가능(PWA)용 최소 캐시. API/영상은 항상 네트워크.
// ★network-first: 온라인이면 항상 최신을 받고 캐시에 갱신 → 옛 자산 고착 없음. 오프라인이면 캐시 폴백.
const CACHE = 'onvideo-v3';
const ASSETS = ['/', '/index.html', '/voices', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // GET만, API·영상(포트폴리오/결과)은 캐시 안 함(항상 네트워크).
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/portfolio')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok && url.origin === location.origin) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/'))),
  );
});
