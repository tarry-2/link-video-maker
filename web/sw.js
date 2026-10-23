// OnVideo service worker — PWA 설치만 지원. ★HTML/JS/CSS는 절대 캐시하지 않는다(항상 네트워크).
// 과거 cache-first/자산 캐시가 옛 화면을 고착시켜 "배포해도 안 바뀜·버튼 안 눌림"을 유발 → 근본 차단.
const CACHE = 'onvideo-v6';
// 아이콘만 설치 캐시. ★manifest는 캐시하지 않는다 — 캐시하면 크롬이 옛 manifest(id 없는 것)를 물고 있어
//   뿌리오/온비디오를 '같은 앱'으로 오인해 별도 설치가 안 된다(2026-10-23 PWA 설치 불가 원인).
const ASSETS = ['/favicon.svg', '/icon-192.png', '/icon-512.png'];
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
  const isAppCode = ['/', '/app', '/landing', '/voices', '/highlight', '/monetize'].includes(url.pathname)
    || url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')
    || url.pathname.endsWith('manifest.json'); // ★manifest는 항상 네트워크 최신(PWA 앱 식별 정보 고착 방지)
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
