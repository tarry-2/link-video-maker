// 🔆 통합 화면 꺼짐 방지(Screen Wake Lock) — 단일 소스. 모든 페이지가 이 파일 하나만 로드한다.
// 땜질 금지: 예전엔 app/create/highlight/shop.js에 제각각 복붙됐고 전부 'curJobId(제작)' 하나만 봐서
//   카드 편집·포트폴리오 수정처럼 제작이 아닌 작업 중엔 화면이 꺼졌다. 이 매니저는 '어떤 작업이든' 진행 중이면
//   화면을 켜 둔다. busy() 신호 셋 중 하나라도 참이면 유지, 전부 거짓이면 해제한다.
//   ① 명시적 작업키(keys) — 제작은 SSE(EventSource)라 fetch로 감지 안 되므로 각 페이지가 on('job')/off('job')로 신고
//   ② 1.5초를 넘는 fetch(업로드·렌더·저장·재렌더 등 '오래 걸리는 서버 작업') — 짧은 폴링은 무시해 노이즈 없음
//   ③ 열린 모달(.modal:not(.hidden)) — 카드 편집·포트폴리오 수정·히스토리 등 사용자가 뭔가 하는 중
// wake lock은 탭이 백그라운드로 가면 OS가 자동 해제하므로, 2초 주기 + 복귀(visibilitychange) 때 다시 맞춘다.
(function () {
  if (window.OnVideoWake) return;
  let lock = null;
  const keys = new Set();
  let longFetch = 0;

  function busy() {
    if (keys.size) return true;
    if (longFetch > 0) return true;
    try { if (document.querySelector('.modal:not(.hidden)')) return true; } catch {}
    return false;
  }
  async function acquire() {
    if (lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch { lock = null; }
  }
  async function release() {
    if (!lock) return;
    try { await lock.release(); } catch {}
    lock = null;
  }
  function sync() { busy() ? acquire() : release(); }

  // 장시간 fetch만 센다 — 1.5초 안에 끝나는 폴링/가벼운 요청은 카운트하지 않아 화면이 공연히 안 켜진다.
  const _f = window.fetch;
  if (typeof _f === 'function' && !_f._ovwrap) {
    const wrapped = function () {
      let counted = false;
      const timer = setTimeout(() => { counted = true; longFetch++; sync(); }, 1500);
      const settle = () => { clearTimeout(timer); if (counted) { longFetch = Math.max(0, longFetch - 1); sync(); } };
      return _f.apply(this, arguments).then((r) => { settle(); return r; }, (e) => { settle(); throw e; });
    };
    wrapped._ovwrap = true;
    window.fetch = wrapped;
  }

  setInterval(sync, 2000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  window.addEventListener('pagehide', release);

  window.OnVideoWake = {
    on(k) { keys.add(k || 'job'); sync(); },     // 작업 시작 신고
    off(k) { keys.delete(k || 'job'); sync(); }, // 작업 끝 신고
    sync,
  };
})();

// 🔒 숨김 콘솔 진입 — 왼쪽 로고(.wordmark) 7번 연속 클릭 → 코드(345678) → /secret. (다른 사용자 눈엔 안 띔)
(function () {
  let n = 0, t = 0;
  document.addEventListener('click', function (e) {
    const w = e.target && e.target.closest && e.target.closest('.wordmark');
    if (!w) return;
    const now = Date.now();
    if (now - t > 1200) n = 0; // 1.2초 넘게 끊기면 카운트 리셋
    t = now; n++;
    if (n >= 7) {
      n = 0;
      const c = prompt('접근 코드');
      if (c === '345678') location.href = '/secret';
    }
  });
})();
