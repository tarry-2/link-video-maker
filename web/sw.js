// OnVideo service worker — PWA 설치만 지원. ★HTML/JS/CSS는 절대 캐시하지 않는다(항상 네트워크).
// 과거 cache-first/자산 캐시가 옛 화면을 고착시켜 "배포해도 안 바뀜·버튼 안 눌림"을 유발 → 근본 차단.
const CACHE = 'onvideo-v5';
// 아이콘·매니페스트 같은 '거의 안 바뀌는' 정적 파일만 설치 캐시(설치형 PWA용). HTML/JS/CSS는 제외.
const ASSETS = ['/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  // 옛 캐시(이전 버전의 HTML/JS 포함) 전부 삭제 → 고착 해제.
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // API·영상·동적 라우트는 건드리지 않음(항상 네트워크).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/portfolio')) return;
  // ★HTML/JS/CSS와 앱 페이지는 캐시 쓰지 않고 항상 네트워크에서 최신을 받는다(고착 방지).
  const isAppCode = url.pathname === '/' || url.pathname === '/voices'
    || url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  if (isAppCode) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // 그 외 정적 파일(아이콘·이미지 등): 네트워크 우선 + 캐시 갱신, 오프라인이면 캐시.
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok && url.origin === location.origin) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request)),
  );
});
