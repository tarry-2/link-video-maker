// 🎛 뿌리오 방송콘솔 — 영상 N개 × 계정(스레드·인스타·페북) 전체/부분을 한 번에 송출.
//   SSE(/api/progress)로 계정별 실시간 로그, /api/generate/cancel로 정지/취소, 미발행분 이어하기.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const api = async (url, body) => {
    const r = await fetch(url, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '요청 실패');
    return d;
  };

  // 테마(라이트 기본, 다른 페이지와 키 통일)
  const tb = $('theme-btn');
  function applyTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (tb) tb.textContent = t === 'dark' ? '☀️' : '🌙';
  }
  let theme = localStorage.getItem('lvm-theme') || 'light';
  applyTheme(theme);
  tb.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('lvm-theme', theme); applyTheme(theme); };

  const PLATS = ['threads', 'instagram', 'facebook'];
  const state = {
    videos: [], selVideos: new Set(),
    plat: 'threads',
    accts: {threads: [], instagram: [], facebook: []},
    sel: {threads: new Set(), instagram: new Set(), facebook: new Set()},
    vPage: 0, vFilter: 'all', mode: 'now',
  };
  function getInterval() { var el = $('interval'); return el ? Number(el.value) || 0 : 0; }
  function currentTargets() { return {threads: [...state.sel.threads], instagram: [...state.sel.instagram], facebook: [...state.sel.facebook]}; }
  const V_PER = 12; // 페이지당 영상 수
  // 작업 종류 구분(배지·필터): 하이라이트/카드영상/재창작/창작/일반영상.
  function kindOf(v) {
    if (v.media === 'highlight') return 'highlight';
    if (v.media === 'card') return 'card';
    if (v.origin === 'remake') return 'remake';
    if (v.origin === 'create') return 'create';
    return 'video';
  }
  const KIND_LABEL = {highlight: '🎬 하이라이트', card: '🎴 카드영상', remake: '🎭 재창작', create: '✍️ 창작', video: '🎞 영상'};
  const filteredVideos = () => state.vFilter === 'all' ? state.videos : state.videos.filter((v) => kindOf(v) === state.vFilter);
  let curJob = '', es = null, stopMode = null, lastRun = null, lastRunId = ''; // stopMode: 'stop'|'cancel'|null

  // ───────── 영상 그리드 ─────────
  async function loadVideos() {
    const g = $('vgrid'); g.innerHTML = '<p class="mini-state">영상 불러오는 중…</p>';
    try {
      const d = await api('/api/portfolio');
      state.videos = (d.items || []).filter((v) => v.video && v.media !== 'card-post'); // 영상만(카드 캐러셀 제외)
      renderVideos();
    } catch (e) { g.innerHTML = '<p class="mini-state">불러오기 실패: ' + esc(e.message) + '</p>'; }
  }
  function renderVideos() {
    const g = $('vgrid');
    const list = filteredVideos();
    if (!list.length) { g.innerHTML = `<p class="mini-state">${state.videos.length ? '이 종류의 영상이 없어요.' : '포트폴리오에 영상이 없어요. 먼저 영상을 만들어 주세요.'}</p>`; $('vpager').innerHTML = ''; updateVSel(); return; }
    const pages = Math.max(1, Math.ceil(list.length / V_PER));
    if (state.vPage >= pages) state.vPage = pages - 1;
    if (state.vPage < 0) state.vPage = 0;
    const items = list.slice(state.vPage * V_PER, state.vPage * V_PER + V_PER);
    g.innerHTML = items.map((v) => {
      const badges = [v.instagramUrl ? '<span title="인스타 올림">📷</span>' : '', v.facebookUrl ? '<span title="페북 올림">👍</span>' : '', v.threadsUrl ? '<span title="스레드 올림">🧵</span>' : ''].join('');
      const land = v.orientation === 'landscape' ? ' land' : '';
      return `<div class="vcard${state.selVideos.has(v.id) ? ' sel' : ''}" data-vid="${esc(v.id)}">
        <div class="vcheck">${state.selVideos.has(v.id) ? '✓' : ''}</div>
        ${v.thumb ? `<img class="vthumb${land}" src="${esc(v.thumb)}" loading="lazy" onerror="this.style.visibility='hidden'"/>` : `<div class="vthumb${land}"></div>`}
        <div class="vkind">${KIND_LABEL[kindOf(v)]}</div>
        <div class="vtitle">${esc(v.title || '(제목 없음)')}</div>
        <div class="vbadges">${badges}</div>
        <div class="vbtns"><button data-act="instagram" title="인스타로 바로">📷</button><button data-act="facebook" title="페북으로 바로">👍</button><button data-act="threads" title="스레드로 바로">🧵</button><button data-act="dl" title="다운로드">⬇</button></div>
      </div>`;
    }).join('');
    renderPager(pages);
    updateVSel();
  }
  function renderPager(pages) {
    const box = $('vpager');
    if (pages <= 1) { box.innerHTML = ''; return; }
    const cur = state.vPage; const nums = [];
    for (let i = 0; i < pages; i++) { if (i === 0 || i === pages - 1 || (i >= cur - 2 && i <= cur + 2)) nums.push(i); else if (nums[nums.length - 1] !== '…') nums.push('…'); }
    box.innerHTML = `<button data-p="${Math.max(0, cur - 1)}" ${cur === 0 ? 'disabled' : ''}>◀</button>` +
      nums.map((n) => n === '…' ? '<span class="dots">…</span>' : `<button class="${n === cur ? 'active' : ''}" data-p="${n}">${n + 1}</button>`).join('') +
      `<button data-p="${Math.min(pages - 1, cur + 1)}" ${cur === pages - 1 ? 'disabled' : ''}>▶</button>`;
  }
  function updateVSel() { $('vsel-count').textContent = state.selVideos.size + '개 선택'; }

  $('vgrid').onclick = (e) => {
    const btn = e.target.closest('.vbtns button');
    const card = e.target.closest('.vcard'); if (!card) return;
    const vid = card.dataset.vid;
    if (btn) { e.stopPropagation(); quickSend(vid, btn.dataset.act); return; }
    if (state.selVideos.has(vid)) state.selVideos.delete(vid); else state.selVideos.add(vid); // 카드 클릭 = 선택 토글
    card.classList.toggle('sel'); card.querySelector('.vcheck').textContent = state.selVideos.has(vid) ? '✓' : '';
    updateVSel();
  };
  $('v-all').onclick = () => { state.videos.forEach((v) => state.selVideos.add(v.id)); renderVideos(); };
  $('v-none').onclick = () => { state.selVideos.clear(); renderVideos(); };
  $('v-reload').onclick = loadVideos;
  $('vpager').onclick = (e) => { const b = e.target.closest('button[data-p]'); if (!b) return; state.vPage = Number(b.dataset.p); renderVideos(); };
  $('vfilter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; [...$('vfilter').children].forEach((x) => x.classList.toggle('on', x === b)); state.vFilter = b.dataset.f; state.vPage = 0; renderVideos(); };

  // ───────── 계정(플랫폼별) ─────────
  async function loadAccounts() {
    const [th, ig, fb] = await Promise.all([
      api('/api/threads/status').catch(() => ({})),
      api('/api/instagram/status').catch(() => ({})),
      api('/api/facebook/status').catch(() => ({})),
    ]);
    state.accts.threads = th.accounts || [];
    state.accts.instagram = ig.accounts || [];
    state.accts.facebook = fb.accounts || [];
    renderAccts();
  }
  function platIcon(p) { return p === 'instagram' ? '📷' : p === 'facebook' ? '👍' : '🧵'; }
  function platKo(p) { return p === 'instagram' ? '인스타' : p === 'facebook' ? '페북' : '스레드'; }
  function renderAccts() {
    const box = $('accts'); const plat = state.plat; const list = state.accts[plat]; const sel = state.sel[plat];
    if (!list.length) { box.innerHTML = `<p class="mini-state">연결된 ${platIcon(plat)} ${platKo(plat)} 계정이 없어요. 영상 만들기 → ⚙ 키 설정에서 연결하세요.</p>`; updateASel(); return; }
    box.innerHTML = list.map((a) => {
      const name = a.label || a.username || a.pageName || a.id;
      const sub = a.username ? `@${a.username}` : (a.pageName && a.label !== a.pageName ? a.pageName : '');
      return `<div class="acct-row"><input type="checkbox" id="a-${esc(a.id)}" data-aid="${esc(a.id)}" ${sel.has(a.id) ? 'checked' : ''}><label for="a-${esc(a.id)}">${platIcon(plat)} ${esc(name)}${sub ? ` <span class="acct-niche">${esc(sub)}</span>` : ''}</label></div>`;
    }).join('');
    updateASel();
  }
  function updateASel() {
    const total = PLATS.reduce((n, p) => n + state.sel[p].size, 0);
    $('asel-count').textContent = total ? `총 ${total}개 계정 선택` : '';
  }
  $('accts').onchange = (e) => {
    const cb = e.target.closest('[data-aid]'); if (!cb) return;
    if (cb.checked) state.sel[state.plat].add(cb.dataset.aid); else state.sel[state.plat].delete(cb.dataset.aid);
    updateASel();
  };
  $('plat-seg').onclick = (e) => {
    const b = e.target.closest('[data-plat]'); if (!b) return;
    [...$('plat-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    state.plat = b.dataset.plat; renderAccts();
  };
  $('a-all').onclick = () => {
    const list = state.accts[state.plat]; const sel = state.sel[state.plat];
    const allOn = list.length && list.every((a) => sel.has(a.id));
    if (allOn) sel.clear(); else list.forEach((a) => sel.add(a.id));
    renderAccts();
  };

  // ───────── 콘솔 ─────────
  const con = $('con');
  let conStarted = false;
  function addLog(m) { if (!conStarted) { con.textContent = ''; conStarted = true; } con.textContent += m + '\n'; con.scrollTop = con.scrollHeight; }
  function setBar(pct) { const b = $('bar'); b.classList.add('on'); $('bar-fill').style.width = pct + '%'; $('bar-txt').textContent = pct + '%'; }
  $('c-big').onclick = () => { $('bm-in').textContent = con.textContent; $('big-modal').classList.add('on'); };
  $('bm-x').onclick = () => $('big-modal').classList.remove('on');
  $('big-modal').onclick = (e) => { if (e.target.id === 'big-modal') $('big-modal').classList.remove('on'); };
  $('c-copy').onclick = async () => { try { await navigator.clipboard.writeText(con.textContent); $('c-copy').textContent = '✅ 복사됨'; setTimeout(() => $('c-copy').textContent = '📋 복사', 1500); } catch { alert('복사 실패'); } };
  $('c-clear').onclick = () => { if (curJob) return alert('송출 중에는 초기화할 수 없어요.'); con.textContent = '여기에 송출 로그가 실시간으로 올라옵니다.'; conStarted = false; $('bar').classList.remove('on'); $('bar-fill').style.width = '0'; $('c-resume').classList.add('hidden'); };

  function confetti() {
    const e = ['🎉', '✨', '🌱', '💚', '🎊'];
    for (let i = 0; i < 34; i++) { const s = document.createElement('div'); s.className = 'confetti'; s.textContent = e[i % e.length]; s.style.left = Math.random() * 100 + 'vw'; s.style.animationDuration = (1.6 + Math.random() * 1.4) + 's'; s.style.fontSize = (16 + Math.random() * 16) + 'px'; document.body.appendChild(s); setTimeout(() => s.remove(), 3200); }
  }
  function showCtrls(running) {
    $('c-stop').classList.toggle('hidden', !running);
    $('c-cancel').classList.toggle('hidden', !running);
    $('broadcast').disabled = running;
  }
  // 모든 (영상×계정) 작업 키 — 서버 plans와 동일 순서/형식(이어하기 skip 계산용)
  function buildKeys(videoIds, targets) {
    const keys = [];
    for (const vid of videoIds) {
      for (const aid of (targets.instagram || [])) keys.push(`${vid}|instagram|${aid}`);
      for (const aid of (targets.facebook || [])) keys.push(`${vid}|facebook|${aid}`);
      for (const aid of (targets.threads || [])) keys.push(`${vid}|threads|${aid}`);
    }
    return keys;
  }

  async function runBroadcast(videoIds, targets, skip) {
    const nAcc = (targets.threads || []).length + (targets.instagram || []).length + (targets.facebook || []).length;
    if (!videoIds.length) return alert('송출할 영상을 하나 이상 선택하세요.');
    if (!nAcc) return alert('올릴 계정을 하나 이상 선택하세요(스레드·인스타·페북 탭에서 체크).');
    lastRun = {videoIds, targets, allKeys: buildKeys(videoIds, targets)};
    stopMode = null; conStarted = true; con.textContent = '';
    $('c-resume').classList.add('hidden');
    setBar(0); showCtrls(true);
    try {
      const d = await api('/api/social/broadcast', {videoIds, targets, skip: skip || [], intervalSec: getInterval()});
      curJob = d.id; lastRunId = d.id;
      streamJob(d.id);
    } catch (e) { addLog('❌ 시작 실패: ' + e.message); showCtrls(false); }
  }

  function streamJob(id) {
    if (es) { es.close(); es = null; }
    es = new EventSource('/api/progress?id=' + encodeURIComponent(id));
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.log) {
        addLog(m.log);
        const pm = /(\d+)%\)/.exec(m.log); // "(3/10 · 30%)"에서 진행% 추출
        if (pm) setBar(Math.min(100, +pm[1]));
      }
      if (m.done) finishJob();
    };
    es.onerror = () => {}; // done 로그로 종료되면 무시(일시 끊김 허용)
  }

  async function finishJob() {
    if (es) { es.close(); es = null; }
    const wasCancel = stopMode === 'cancel';
    curJob = ''; stopMode = null;
    showCtrls(false);
    let remaining = [];
    try { const r = await api('/api/social/broadcast/remaining/' + encodeURIComponent(lastRunId)); remaining = r.remaining || []; } catch {}
    if (remaining.length) { $('c-resume').classList.remove('hidden'); } // 미발행분 있으면 이어하기(정지·취소·실패 공통)
    else if (!wasCancel) { setBar(100); confetti(); }                  // 전부 성공했을 때만 폭죽
  }

  // 메인 송출 — 모드(지금/예약)에 따라 즉시 발행 or 예약 등록
  $('broadcast').onclick = () => {
    if (state.mode === 'schedule') return scheduleBroadcast();
    runBroadcast([...state.selVideos], currentTargets(), []);
  };
  // 지금/예약 모드 전환
  $('mode-seg').onclick = (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    [...$('mode-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    state.mode = b.dataset.mode;
    $('sched-time-wrap').classList.toggle('hidden', state.mode !== 'schedule');
    $('broadcast').textContent = state.mode === 'schedule' ? '⏰ 예약 걸기' : '🚀 선택한 영상을 선택한 계정에 송출';
  };
  // 예약 등록
  async function scheduleBroadcast() {
    const videoIds = [...state.selVideos]; const targets = currentTargets();
    const nAcc = targets.threads.length + targets.instagram.length + targets.facebook.length;
    if (!videoIds.length) return alert('송출할 영상을 하나 이상 선택하세요.');
    if (!nAcc) return alert('올릴 계정을 하나 이상 선택하세요.');
    const t = $('sched-time').value;
    if (!t) return alert('예약 시각을 선택하세요.');
    const scheduledAt = new Date(t).getTime();
    if (!scheduledAt || scheduledAt < Date.now()) return alert('예약 시각을 미래로 지정하세요.');
    try {
      await api('/api/social/schedule', {videoIds, targets, scheduledAt, intervalSec: getInterval()});
      addLog(`⏰ 예약됨 — ${new Date(scheduledAt).toLocaleString('ko-KR')}에 자동 송출됩니다.`);
      alert('예약됐어요! 그 시각에 자동으로 송출됩니다.');
      loadSchedules();
    } catch (e) { alert(e.message); }
  }
  // 예약 목록
  async function loadSchedules() {
    try {
      const d = await api('/api/social/schedule');
      const box = $('sched-list');
      if (!d.items || !d.items.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="small sub" style="font-weight:800;margin-bottom:2px">⏰ 예약된 송출</div>' + d.items.map((s) => {
        const when = new Date(s.scheduledAt).toLocaleString('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
        const iv = s.intervalSec ? ` · 간격 ${s.intervalSec}초` : '';
        const st = s.status === 'running' ? ' · 🔴 발행 중…' : '';
        return `<div class="sched-item"><span class="si-when">${when}</span><span class="si-meta">영상 ${s.nVideos} × 계정 ${s.nAcc}${iv}${st}</span>${s.status === 'pending' ? `<button data-cancel="${s.id}">취소</button>` : ''}</div>`;
      }).join('');
    } catch {}
  }
  $('sched-list').onclick = async (e) => {
    const b = e.target.closest('[data-cancel]'); if (!b) return;
    if (!confirm('이 예약을 취소할까요?')) return;
    try { await fetch('/api/social/schedule/' + encodeURIComponent(b.dataset.cancel), {method: 'DELETE'}); } catch {}
    loadSchedules();
  };
  // 영상 카드 개별 4버튼 — 그 플랫폼의 '선택된 계정'으로 이 영상만 송출(⬇는 blob 다운로드)
  function quickSend(vid, act) {
    if (act === 'dl') return downloadVideo(vid);
    const accs = [...state.sel[act]];
    if (!accs.length) { alert(`${platIcon(act)} ${platKo(act)} 계정을 먼저 체크한 뒤 눌러주세요(${platKo(act)} 탭).`); return; }
    const targets = {threads: [], instagram: [], facebook: []}; targets[act] = accs;
    runBroadcast([vid], targets, []);
  }
  async function downloadVideo(vid) {
    const v = state.videos.find((x) => x.id === vid); if (!v) return;
    try {
      const r = await fetch(v.video); if (!r.ok) throw new Error('다운로드 실패(' + r.status + ')');
      const blob = await r.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = (v.title || 'video').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60) + '.mp4';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { alert('다운로드 실패: ' + e.message); }
  }

  // 정지 / 취소 / 이어하기
  async function cancelJob() { if (!curJob) return; try { await api('/api/generate/cancel', {id: curJob}); } catch {} }
  $('c-stop').onclick = async () => { stopMode = 'stop'; addLog('⏸ 정지 요청 — 진행 중인 건이 끝나면 멈춥니다…'); await cancelJob(); };
  $('c-cancel').onclick = async () => { stopMode = 'cancel'; addLog('✕ 취소 요청 — 멈춥니다…'); await cancelJob(); };
  $('c-resume').onclick = async () => {
    if (!lastRun) return;
    let remaining = [];
    try { const r = await api('/api/social/broadcast/remaining/' + encodeURIComponent(lastRunId)); remaining = r.remaining || []; } catch {}
    const skip = lastRun.allKeys.filter((k) => !remaining.includes(k)); // 이미 된 건 건너뜀
    addLog(`▶ 이어하기 — 남은 ${remaining.length}건부터 다시 보냅니다…`);
    runBroadcast(lastRun.videoIds, lastRun.targets, skip);
  };

  loadVideos();
  loadAccounts();
  loadSchedules();
})();
