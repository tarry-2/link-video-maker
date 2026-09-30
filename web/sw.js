// 자폭(self-destructing) 서비스워커.
// v1 시절 설치된 PWA가 /sw.js로 옛 자산(app.js·index.html)을 캐시해 계속 서빙하던 문제 해결용.
// 브라우저가 옛 SW를 이 스크립트로 교체 → 모든 캐시 삭제 + 스스로 unregister + 열린 창 새로고침.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch (e) {}
      try {
        await self.registration.unregister();
      } catch (e) {}
      try {
        const clients = await self.clients.matchAll({type: 'window'});
        for (const client of clients) {
          try {
            client.navigate(client.url);
          } catch (e) {}
        }
      } catch (e) {}
    })(),
  );
});

// 아무것도 캐시하지 않는다 — 항상 네트워크로 통과.
self.addEventListener('fetch', () => {});
