// 유튜브 하이라이트 전용 페이지 — 영상 만들기와 완전 분리(독립). 재사용(CC) 영상에서 숏폼만 뽑는다.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDur = (s) => { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

  // ── 버전 배지 ──
  fetch('/api/version').then(r => r.json()).then(d => { if ($('ver')) $('ver').textContent = 'v' + d.version; }).catch(() => {});

  // ── 테마 ──
  const theme = localStorage.getItem('onvideo-theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  if ($('theme-btn')) $('theme-btn').textContent = theme === 'dark' ? '☀️' : '🌙';
  $('theme-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur); localStorage.setItem('onvideo-theme', cur);
    $('theme-btn').textContent = cur === 'dark' ? '☀️' : '🌙';
  });

  // ── GPU 상태 배지 ──
  async function refreshGpu() {
    const b = $('gpu-badge'); if (!b) return;
    try {
      const d = await (await fetch('/api/runpod/status')).json();
      if (!d.configured) { b.className = 'gpu-badge unknown'; b.textContent = '● GPU 미설정'; return; }
      const running = (d.pods || []).filter(p => p.status === 'RUNNING');
      if (running.length) { b.className = 'gpu-badge on'; b.textContent = `● GPU 켜짐 ${running.length}대 · 과금중`; }
      else { b.className = 'gpu-badge off'; b.textContent = '● GPU 꺼짐 · 과금없음'; }
    } catch { b.className = 'gpu-badge unknown'; b.textContent = '● GPU 확인실패'; }
  }
  refreshGpu(); setInterval(refreshGpu, 60000);

  // ── 로그(실시간 시각, 초기화 전까지 유지) ──
  function addLog(text, cls) {
    $('progress-block')?.classList.remove('hidden');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const n = new Date();
    const ts = `[${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}] `;
    line.textContent = ts + text;
    $('log').appendChild(line);
    $('log').scrollTop = $('log').scrollHeight;
  }
  function copyLog(btn) {
    const txt = $('log')?.innerText || '';
    navigator.clipboard?.writeText(txt).then(() => { if (btn) { const o = btn.textContent; btn.textContent = '복사됨!'; setTimeout(() => btn.textContent = o, 1200); } });
  }
  $('log-copy')?.addEventListener('click', (e) => copyLog(e.currentTarget));
  $('log-modal-copy')?.addEventListener('click', (e) => copyLog(e.currentTarget));
  let logMirror = null;
  $('log-expand')?.addEventListener('click', () => {
    const big = $('log-big'), src = $('log'); if (big && src) big.innerHTML = src.innerHTML;
    $('log-modal').classList.remove('hidden');
    logMirror = setInterval(() => { if (big && src) { big.innerHTML = src.innerHTML; big.scrollTop = big.scrollHeight; } }, 500);
  });
  $('log-modal-close')?.addEventListener('click', () => { $('log-modal').classList.add('hidden'); if (logMirror) { clearInterval(logMirror); logMirror = null; } });
  $('log-clear')?.addEventListener('click', () => {
    if (curJobId) { alert('제작이 진행 중일 땐 로그를 지울 수 없어요. 끝난 뒤에 초기화하세요.'); return; }
    if (!confirm('로그를 모두 지울까요?')) return;
    if ($('log')) $('log').textContent = ''; logJobId = null; logCount = 0;
  });

  // ── 에너지바 + 경과시간 ──
  let energyPct = 0, startTs = 0, tickTimer = null, estTotalText = '';
  function setEnergy(pct, label) { energyPct = Math.max(0, Math.min(100, pct)); const f = $('hl-energy'); if (f) f.style.width = energyPct + '%'; if ($('hl-energy-label')) $('hl-energy-label').textContent = `${Math.round(energyPct)}% · ${label || ''}`; }
  function elapsedText() { if (!startTs) return ''; const s = Math.floor((Date.now() - startTs) / 1000); const base = `⏱ ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; return estTotalText ? `${base} · 예상 ${estTotalText}` : base; }
  function tick() { clearTimeout(tickTimer); const n = $('hl-elapsed'); if (!n) return; n.textContent = elapsedText(); tickTimer = setTimeout(tick, 1000); }
  function energyFromLog(line) {
    if (/소재를 뽑습니다|자막·정보|자막 확보|자막/.test(line)) setEnergy(Math.max(energyPct, 15), '자막·정보 가져오는 중…');
    else if (/구간 .*확정|구간 .*개/.test(line)) setEnergy(Math.max(energyPct, 35), '하이라이트 고르는 중…');
    else if (/구간 받는 중/.test(line)) setEnergy(Math.max(energyPct, 45), '필요한 구간만 받는 중…');
    else if (/자르는 중/.test(line)) setEnergy(Math.max(energyPct, 60), '세로로 자르는 중…');
    else if (/편 렌더/.test(line)) setEnergy(Math.max(energyPct, 75), '자막 얹어 렌더 중…');
    else if (/편 완성/.test(line)) setEnergy(Math.min(98, energyPct + 5), '편집 마무리 중…');
  }
  function celebrate() {
    const c = document.createElement('div'); c.className = 'confetti';
    const colors = ['#12a998','#6b4cf0','#ff4d8d','#ffc83d','#36d1a0'];
    for (let i = 0; i < 90; i++) { const bit = document.createElement('i'); bit.style.left = Math.random()*100+'%'; bit.style.background = colors[i%colors.length]; bit.style.animationDelay = (Math.random()*0.5).toFixed(2)+'s'; bit.style.animationDuration = (2.2+Math.random()*1.3).toFixed(2)+'s'; c.appendChild(bit); }
    document.body.appendChild(c); setTimeout(() => c.remove(), 4200);
  }

  // ── 진행 SSE ──
  let curJobId = null, curES = null, reconnTries = 0, logJobId = null, logCount = 0;
  function attachProgress(id) {
    curJobId = id;
    try { localStorage.setItem('onvideo-hljob', id); } catch {}
    if (curES) { try { curES.close(); } catch {} curES = null; }
    if (id !== logJobId) { logJobId = id; logCount = 0; } // 로그는 안 비움(초기화 전까지 유지)
    if (!startTs) startTs = Date.now();
    $('progress-block').classList.remove('hidden');
    $('hl-stop')?.classList.remove('hidden'); // 진행 중엔 '지금 중단'만 노출
    $('hl-resume')?.classList.add('hidden');
    $('hl-reset')?.classList.add('hidden');
    tick();
    let recv = 0;
    const es = new EventSource('/api/progress?id=' + id); curES = es;
    es.onmessage = (ev) => {
      reconnTries = 0;
      const m = JSON.parse(ev.data);
      if (m.log) { recv++; if (recv > logCount) { addLog(m.log, m.log.includes('[완료]') ? 'done' : m.log.includes('[실패]') ? 'fail' : ''); energyFromLog(m.log); logCount = recv; } }
      if (m.clip) { addResultClip(m.clip); loadHistory(); } // 먼저 끝난 편 바로 노출(+작업내역 갱신)
      if (m.done) {
        es.close(); curES = null; curJobId = null;
        clearTimeout(tickTimer);
        try { localStorage.removeItem('onvideo-hljob'); localStorage.removeItem('onvideo-hljob-meta'); } catch {}
        refreshGpu();
        $('hl-stop')?.classList.add('hidden'); // 끝났으니 중단 버튼 숨김
        if (m.error) { setEnergy(energyPct, m.error.includes('중단') ? '중단됨' : '실패'); }
        else { setEnergy(100, '완성! 🎉'); const f = $('hl-energy'); if (f) f.classList.remove('anim'); celebrate(); }
        showStopped(); // 성공·실패 공통: '같은 설정으로 다시' + '취소하고 새 영상' 노출
        if (m.kind === 'highlight' && !m.error) {
          (m.clips || []).forEach((c) => { if (!resultClips.some((x) => x.projectId === c.projectId)) resultClips.push(c); });
          showResults(resultClips, false); loadHistory();
        }
      }
    };
    es.onerror = () => {
      es.close(); if (curES === es) curES = null;
      if (curJobId === id && reconnTries < 12) { reconnTries++; setTimeout(() => { if (curJobId === id && !curES) attachProgress(id); }, 2500); }
    };
  }

  // 바이럴 점수 뱃지 — 80+ 핫(빨강), 65~79 좋음(주황), 그 아래 보통(회색). score 없으면 빈 문자열.
  function scoreBadge(score, overlay) {
    if (typeof score !== 'number' || !isFinite(score)) return '';
    const s = Math.round(score);
    const cls = s >= 80 ? 'hot' : s >= 65 ? 'good' : 'mild';
    return `<span class="score-badge ${cls}${overlay ? ' ov' : ''}" title="AI 예상 바이럴 점수">🔥 ${s}</span>`;
  }

  // ── 완성 결과(여러 편) — 먼저 끝난 편부터 바로 노출 + 점수순 정렬 ──
  let resultClips = []; // 완성된 편 누적(SSE로 하나씩 들어옴)
  function addResultClip(c) {
    if (!c || !c.projectId) return;
    if (!resultClips.some((x) => x.projectId === c.projectId)) resultClips.push(c);
    showResults(resultClips, !!curJobId); // 아직 작업 중이면 "나머지 제작 중" 표시
  }
  function showResults(clips, inProgress) {
    const box = $('hl-result-block'); if (!box) return;
    box.classList.remove('hidden');
    if (!clips.length) { box.innerHTML = '<p class="mini-state">완성된 클립이 없어요.</p>'; return; }
    clips = clips.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const head = inProgress
      ? `✅ ${clips.length}편 완성 · 나머지 제작 중…`
      : `🎬 하이라이트 ${clips.length}편 완성!`;
    box.innerHTML = `<h2 style="margin:0 0 4px">${head}</h2>
      <p class="mini-state" style="margin-bottom:12px">🔥 점수 = AI가 예측한 "터질 확률"(높은 순). ${inProgress ? '<b>먼저 끝난 편은 지금 바로</b> 다운로드·업로드할 수 있어요(나머지는 계속 제작 중).' : '유튜브·인스타로 바로 올릴 수 있고, 작업 내역에도 저장됐어요.'}</p>
      <div class="hl-result-grid">${clips.map((c, i) => `
        <div class="hl-result-item ${orient === 'landscape' ? 'land' : ''}" style="position:relative">
          ${scoreBadge(c.score, true)}
          <video poster="/portfolio-thumb/${c.projectId}.png" src="/portfolio-item/${c.projectId}.mp4#t=0.5" controls playsinline preload="metadata"></video>
          <b style="display:block;margin:6px 0">${esc(c.title || ('하이라이트 ' + (i+1)))}</b>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="ghost-btn small" href="/portfolio-item/${c.projectId}.mp4" download="${esc(c.title || 'highlight')}.mp4">⬇ 다운로드</a>
            <button class="ghost-btn small hl-yt" data-id="${c.projectId}">📺 유튜브</button>
            <button class="ghost-btn small hl-ig" data-id="${c.projectId}">📷 인스타</button>
          </div>
        </div>`).join('')}</div>`;
    box.querySelectorAll('.hl-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.hl-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id, orient === 'landscape'));
    box.scrollIntoView({behavior: 'smooth'});
  }

  // ── 업로드 모달(유튜브·인스타) — projectId 기반, 영상과 동일 엔드포인트 ──
  function modal(innerHtml, wire) {
    let box = $('hl-up-modal');
    if (!box) { box = document.createElement('div'); box.id = 'hl-up-modal'; document.body.appendChild(box); }
    box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:60';
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto">${innerHtml}</div>`;
    const close = () => box.remove();
    box.onclick = (e) => { if (e.target === box || e.target.closest('[data-x="close"]')) close(); };
    wire(box, close); return box;
  }
  async function uploadYouTube(btn, id) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📺 준비 중…';
    try {
      const st = await (await fetch('/api/youtube/status')).json();
      if (!st.connected) { alert('먼저 영상 만들기 화면의 ⚙ 키 설정에서 유튜브 계정을 연결하세요.'); return; }
      btn.textContent = '📺 제목·설명 만드는 중…';
      const r = await fetch('/api/youtube/meta/' + encodeURIComponent(id)); const meta = await r.json();
      if (!r.ok) throw new Error(meta.error || '메타 생성 실패');
      modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📺 유튜브 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
        <label class="field-label">제목<input id="cu-t" class="input" maxlength="100" value="${esc(meta.title || '')}"></label>
        <label class="field-label">설명<textarea id="cu-d" class="input" rows="5" maxlength="4900">${esc(meta.description || '')}</textarea></label>
        <label class="field-label">태그<input id="cu-tags" class="input" value="${esc((meta.tags || []).join(', '))}"></label>
        <label class="field-label">공개<select id="cu-p" class="input"><option value="public">바로 공개</option><option value="unlisted">미등록</option><option value="private">비공개</option></select></label>
        <button class="primary-btn" data-up="1">유튜브에 올리기</button><p id="cu-msg" class="mini-state"></p>`,
        (box) => { box.querySelector('[data-up]').onclick = async (ev) => {
          const up = ev.target; up.disabled = true; up.textContent = '올리는 중…';
          try {
            const rr = await fetch('/api/youtube/upload/' + encodeURIComponent(id), {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title: box.querySelector('#cu-t').value, description: box.querySelector('#cu-d').value, tags: box.querySelector('#cu-tags').value.split(',').map(s=>s.trim()).filter(Boolean), privacy: box.querySelector('#cu-p').value})});
            const d = await rr.json(); if (!rr.ok) throw new Error(d.error || '업로드 실패');
            box.querySelector('#cu-msg').innerHTML = `✅ 완료! <a href="${d.url}" target="_blank" style="color:var(--teal)">${d.url}</a>`; up.textContent = '완료 🎉'; loadHistory();
          } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '유튜브에 올리기'; }
        }; });
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
  }
  async function uploadInstagram(btn, id, isLandscape) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
    try {
      const st = await (await fetch('/api/instagram/status')).json();
      if (!st.connected) { alert('먼저 영상 만들기 화면의 ⚙ 키 설정에서 인스타 계정을 연결하세요.'); return; }
      btn.textContent = '📷 캡션 만드는 중…';
      const r = await fetch('/api/instagram/caption/' + encodeURIComponent(id)); const d = await r.json();
      if (!r.ok) throw new Error(d.error || '캡션 생성 실패');
      // ★방식은 방향에 따라 자동 결정(고르지 않음). 세로=릴스, 가로=피드 게시물로 노출.
      //   (인스타는 영상을 전부 REELS로 올리고 share_to_feed로 피드에 노출 — 가로도 그대로 피드에 게시됨.)
      const igKind = isLandscape ? 'feed' : 'reels';
      const methodField = `<label class="field-label">방식<input class="input" value="${isLandscape ? '🖥 가로 → 피드 게시물(자동)' : '📱 세로 → 릴스(자동)'}" disabled></label><input type="hidden" id="cu-k" value="${igKind}">`;
      modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📷 인스타 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
        ${methodField}
        <label class="field-label">캡션·해시태그<textarea id="cu-c" class="input" rows="7" maxlength="2200">${esc(d.caption || '')}</textarea></label>
        <button class="primary-btn" data-up="1">인스타에 올리기</button><p id="cu-msg" class="mini-state">업로드 인코딩에 1~2분 걸릴 수 있어요.</p>`,
        (box) => { box.querySelector('[data-up]').onclick = async (ev) => {
          const up = ev.target; up.disabled = true; up.textContent = '올리는 중…'; box.querySelector('#cu-msg').textContent = '처리 중…';
          try {
            const rr = await fetch('/api/instagram/upload/' + encodeURIComponent(id), {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind: box.querySelector('#cu-k').value, caption: box.querySelector('#cu-c').value})});
            const dd = await rr.json(); if (!rr.ok) throw new Error(dd.error || '업로드 실패');
            box.querySelector('#cu-msg').innerHTML = dd.permalink ? `✅ 완료! <a href="${dd.permalink}" target="_blank" style="color:var(--teal)">인스타에서 열기</a>` : '✅ 게시 완료!'; up.textContent = '완료 🎉'; loadHistory();
          } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '인스타에 올리기'; }
        }; });
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
  }

  // ── 작업 내역(하이라이트만) ──
  async function loadHistory() {
    const box = $('hl-history'); if (!box) return;
    try {
      const d = await (await fetch('/api/portfolio', {cache: 'no-store'})).json();
      const items = (Array.isArray(d.items) ? d.items : []).filter((it) => it.kind === 'mine' && it.media === 'highlight')
        .sort((a, b) => (b.score || 0) - (a.score || 0)); // 점수순(터질 것부터)
      box.innerHTML = items.length ? items.map((it) => {
        const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
        const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
        const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
        return `<div class="history-item"><span><strong>${scoreBadge(it.score)} ${esc(it.title)}</strong><small>${esc(when)} · 🎬 하이라이트${yt}${ig}</small></span>
          <span class="hi-actions">
            <a class="ghost-btn small" href="${esc(it.video)}" download="${esc(it.title)}.mp4">⬇</a>
            <button type="button" class="ghost-btn small hh-yt" data-id="${esc(it.id)}">📺</button>
            <button type="button" class="ghost-btn small hh-ig" data-id="${esc(it.id)}" data-land="${it.orientation === 'landscape' ? '1' : ''}">📷</button>
            <button type="button" class="ghost-btn small hh-del" data-id="${esc(it.id)}">🗑</button>
          </span></div>`;
      }).join('') : '<p class="mini-state">아직 만든 하이라이트가 없어요. 위에서 재사용 영상을 골라 만들어보세요.</p>';
      box.querySelectorAll('.hh-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
      box.querySelectorAll('.hh-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id, !!b.dataset.land));
      box.querySelectorAll('.hh-del').forEach((b) => b.onclick = () => del(b.dataset.id));
    } catch { box.innerHTML = '<p class="mini-state">작업 내역을 불러오지 못했어요.</p>'; }
  }
  async function del(id) {
    if (!confirm('이 하이라이트를 삭제할까요? (되돌릴 수 없어요)')) return;
    try { const r = await fetch('/api/portfolio/' + encodeURIComponent(id), {method: 'DELETE'}); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '삭제 실패'); } loadHistory(); }
    catch (e) { alert('삭제 실패: ' + e.message); }
  }
  $('hl-history-refresh')?.addEventListener('click', loadHistory);
  loadHistory();

  // ── 검색/선택/설정 ──
  let picked = null, region = 'kr', order = 'viewCount', cat = '';
  let count = 3, sec = 30, query = '', pageToken = '', loadedCount = 0, orient = 'portrait', reframeMode = 'track', muteOriginal = 0;
  // 세로일 때만 "세로 변환 방식" 노출(가로는 무의미).
  function applyReframeRow() { const r = $('hl-reframe-row'); if (r) r.style.display = orient === 'portrait' ? '' : 'none'; }
  let commentary = 0, voice = ''; // 해설 넣기(0/1) · 해설 목소리
  let license = 'cc'; // 영상 범위: cc(안전·재사용 허가만) / all(전체)
  let mode = 'search'; // 소재 가져오는 방법: search(주제로 찾기) / url(영상 URL 붙여넣기)

  // ── 선택/검색 상태 저장·복원(탭 나갔다 와도 유지, '초기화' 전까지) ──
  const STATE_KEY = 'onvideo-hl-state';
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        region, order, cat, count, sec, orient, reframeMode, muteOriginal, commentary, voice, query, pageToken, loadedCount, picked, license, mode,
        resultsHtml: ($('hl-results')?.innerHTML || '').replace(/ data-w="1"/g, ''), // data-w 빼고 저장(복원시 재바인딩되게)
        moreVisible: !!$('hl-more'),
        searchState: $('hl-search-state')?.textContent || '',
        catActive: document.querySelector('.hl-cat.active')?.dataset.ko || '',
      }));
    } catch {}
  }
  function restoreState() {
    let s; try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch {}
    if (!s) return false;
    region = s.region || 'kr'; order = s.order || 'viewCount'; cat = s.cat || ''; orient = s.orient || 'portrait';
    reframeMode = s.reframeMode === 'letterbox' ? 'letterbox' : 'track';
    license = s.license === 'all' ? 'all' : 'cc'; mode = ['url', 'upload'].includes(s.mode) ? s.mode : 'search';
    document.querySelectorAll('.hl-lic').forEach((b) => b.classList.toggle('active', b.dataset.lic === license));
    applyLicenseNote(); applyMode();
    document.querySelectorAll('.hl-orient').forEach((b) => b.classList.toggle('active', b.dataset.o === orient));
    document.querySelectorAll('.hl-rf').forEach((b) => b.classList.toggle('active', b.dataset.rf === reframeMode));
    muteOriginal = s.muteOriginal ? 1 : 0;
    document.querySelectorAll('.hl-mute').forEach((b) => b.classList.toggle('active', Number(b.dataset.m) === muteOriginal));
    applyReframeRow();
    count = s.count || 3; sec = s.sec || 30; query = s.query || ''; pageToken = s.pageToken || ''; loadedCount = s.loadedCount || 0;
    commentary = s.commentary || 0; voice = s.voice || '';
    picked = s.picked || null;
    document.querySelectorAll('.hl-cm').forEach((b) => b.classList.toggle('active', Number(b.dataset.c) === commentary));
    $('hl-voice-row')?.classList.toggle('hidden', !commentary);
    // 버튼 활성 복원
    document.querySelectorAll('.hl-region').forEach((b) => b.classList.toggle('active', b.dataset.region === region));
    document.querySelectorAll('.hl-order').forEach((b) => b.classList.toggle('active', b.dataset.order === order));
    document.querySelectorAll('.hl-sec').forEach((b) => b.classList.toggle('active', Number(b.dataset.s) === sec));
    // 프리셋에 없는 커스텀 길이면 입력칸에 표시(버튼 활성 없음).
    if (![15,30,45,60,90,120,180,300].includes(sec) && $('hl-sec-custom')) $('hl-sec-custom').value = sec;
    if (s.catActive) document.querySelectorAll('.hl-cat').forEach((b) => b.classList.toggle('active', b.dataset.ko === s.catActive));
    if (s.query) $('hl-query').value = s.query;
    // 검색 결과 복원(카드 다시 클릭되게 바인딩)
    if (s.resultsHtml) {
      $('hl-results').innerHTML = s.resultsHtml;
      // 🔴저장된 HTML엔 이미 data-w="1"가 박혀 있어 wireCards의 :not([data-w])가 전부 걸러버린다 → 클릭 안됨.
      //   복원 후엔 data-w를 싹 지우고 다시 바인딩해야 카드가 눌린다.
      $('hl-results').querySelectorAll('.hl-card[data-w]').forEach((c) => c.removeAttribute('data-w'));
      wireCards($('hl-results'));
      $('hl-sort-row').classList.remove('hidden');
      if ($('hl-search-state')) $('hl-search-state').textContent = s.searchState;
      // 선택됐던 카드 표시 + 더보기 버튼
      if (picked) document.querySelectorAll('.hl-card').forEach((b) => b.classList.toggle('active', b.dataset.id === picked.videoId));
      if (s.moreVisible && pageToken) {
        const more = document.createElement('button');
        more.id = 'hl-more'; more.type = 'button'; more.className = 'ghost-btn'; more.style.cssText = 'width:100%;margin-top:10px';
        more.textContent = `▼ 더 보기 (지금 ${loadedCount}개)`;
        more.onclick = () => { more.disabled = true; more.textContent = '불러오는 중…'; search(null, true); };
        $('hl-results').parentNode.insertBefore(more, $('hl-results').nextSibling);
      }
    }
    if (picked) $('hl-picked').textContent = `선택: ${picked.title}`;
    return true;
  }
  const CATS = [
    {ko:'연예·스타', kq:'연예인 인터뷰', gq:'celebrity interview'},
    {ko:'예능·토크쇼', kq:'예능 토크쇼', gq:'talk show funny'},
    {ko:'드라마·영화', kq:'드라마 명장면', gq:'movie scene'},
    {ko:'K-pop·음악', kq:'케이팝 무대', gq:'music performance live'},
    {ko:'스포츠', kq:'스포츠 하이라이트', gq:'sports highlights'},
    {ko:'경제·재테크', kq:'경제 뉴스 재테크', gq:'economy finance explained'},
    {ko:'시사·뉴스', kq:'뉴스 이슈', gq:'news report'},
    {ko:'IT·테크', kq:'IT 리뷰 테크', gq:'tech review'},
    {ko:'게임', kq:'게임 플레이', gq:'gaming highlights'},
    {ko:'먹방·음식', kq:'먹방 맛집', gq:'food mukbang'},
    {ko:'여행', kq:'여행 브이로그', gq:'travel vlog'},
    {ko:'교육·지식', kq:'지식 교양', gq:'educational documentary'},
    {ko:'역사', kq:'역사 이야기', gq:'history documentary'},
    {ko:'과학', kq:'과학 다큐', gq:'science documentary'},
    {ko:'동물·펫', kq:'동물 반려동물', gq:'animals pets funny'},
    {ko:'자동차', kq:'자동차 리뷰', gq:'car review'},
  ];
  function renderCats() {
    const box = $('hl-cats'); if (!box) return;
    box.innerHTML = CATS.map((c) => `<button type="button" class="hl-cat" data-kq="${c.kq}" data-gq="${c.gq}" data-ko="${c.ko}">${c.ko}</button>`).join('');
    box.querySelectorAll('.hl-cat').forEach((b) => b.addEventListener('click', () => {
      box.querySelectorAll('.hl-cat').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      cat = b.dataset.ko; $('hl-query').value = '';
      addLog(`📂 주제 선택: ${cat} (${region === 'global' ? '해외' : '한국'})`);
      search(region === 'global' ? b.dataset.gq : b.dataset.kq);
    }));
    // 작업 내역에서 쓰는 버튼 바인딩용(복원 시 wireCards 호출 전에 CATS 정의돼 있어야 함)
  }
  function maxClips(durationSec, clipSec) { return Math.max(1, Math.min(10, Math.floor((durationSec * 0.4) / Math.max(clipSec, 20)))); }
  function renderCountSeg() {
    const seg = $('hl-count-seg'); if (!seg) return;
    // 영상 선택 전엔 기본(1~10편) 다 보이고, 선택하면 그 영상 길이에 맞게 최대편수까지만.
    const max = picked ? maxClips(picked.durationSec, sec) : 10;
    if (count > max) count = max;
    const opts = []; for (const n of [1,2,3,5,8,10]) if (n <= max) opts.push(n);
    if (!opts.includes(max)) opts.push(max);
    seg.innerHTML = opts.map((n) => `<button type="button" class="seg-btn hl-count ${n === count ? 'active' : ''}" data-n="${n}">${n}편</button>`).join('');
    seg.querySelectorAll('.hl-count').forEach((b) => b.addEventListener('click', () => { seg.querySelectorAll('.hl-count').forEach((x) => x.classList.remove('active')); b.classList.add('active'); count = Number(b.dataset.n); saveState(); }));
    if ($('hl-maxnote')) $('hl-maxnote').textContent = picked ? `— 이 영상(${fmtDur(picked.durationSec)})에서 최대 ${max}편까지 추천` : '— 영상을 고르면 그 길이에 맞게 추천해요';
  }
  // 저작권 위험도 뱃지: cc(안전)·ok(무난)·caution(주의)
  function riskInfo(risk) {
    if (risk === 'cc') return {cls: 'cc', label: '✅ 재사용 허가'};
    if (risk === 'caution') return {cls: 'caution', label: '⚠️ 저작권 주의'};
    return {cls: 'ok', label: '🆗 무난'};
  }
  function cardHtml(v) {
    const risk = v.risk || (v.isCc ? 'cc' : 'ok');
    const r = riskInfo(risk);
    return `<button type="button" class="hl-card" data-id="${v.videoId}" data-title="${esc(v.title)}" data-channel="${esc(v.channel)}" data-dur="${v.durationSec}" data-cc="${risk === 'cc' ? '1' : '0'}" data-risk="${esc(risk)}">
      <img src="${v.thumb}" alt="" loading="lazy" />
      <div class="hl-play">▶ 미리보기</div>
      <span class="hl-risk ${r.cls}">${r.label}</span>
      <div class="hl-meta"><b>${esc(v.title)}</b><span>${esc(v.channel)} · ${fmtDur(v.durationSec)} · 조회 ${Number(v.views).toLocaleString('ko-KR')}</span></div>
    </button>`;
  }
  // 카드 클릭 = 크게보기(영상 미리보기). 내용 먼저 확인하고 모달 안에서 '이 영상으로 만들기'로 고른다.
  function wireCards(box) {
    box.querySelectorAll('.hl-card:not([data-w])').forEach((b) => {
      b.setAttribute('data-w', '1');
      b.addEventListener('click', () => openPreview({
        videoId: b.dataset.id, title: b.dataset.title, channel: b.dataset.channel,
        durationSec: Number(b.dataset.dur) || 300, isCc: b.dataset.cc === '1', risk: b.dataset.risk || '',
      }));
    });
  }
  function selectPicked(v) {
    picked = {videoId: v.videoId, title: v.title, channel: v.channel, durationSec: Number(v.durationSec) || 300, isCc: v.isCc !== false};
    document.querySelectorAll('.hl-card').forEach((x) => x.classList.toggle('active', x.dataset.id === picked.videoId));
    $('hl-picked').textContent = `선택: ${picked.title}`;
    renderCountSeg(); saveState();
    addLog(`🎥 영상 선택: ${picked.title} (${fmtDur(picked.durationSec)} · ${picked.channel})`);
    $('hl-options')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  // 크게보기 — 온비디오 안에서 유튜브 영상을 바로 재생해 내용을 미리 본다(제작 전).
  function openPreview(v) {
    const risk = v.risk || (v.isCc ? 'cc' : 'ok');
    const badge = risk === 'cc'
      ? '<span style="color:#2bb673;font-weight:700">✅ 재사용 허가(CC) — 출처만 밝히면 합법 수익화</span>'
      : risk === 'caution'
      ? '<span style="color:#e5484d;font-weight:700">⚠️ 저작권 주의 — 영화·방송·음원·스포츠일 수 있어요. 재가공해도 위험하니 가급적 피하세요.</span>'
      : '<span style="color:#d08700;font-weight:700">🆗 무난 — 일반 롱폼. 해설·자막으로 재가공 + 출처를 남기면 안전 범위예요.</span>';
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">미리보기</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <div style="position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden">
        <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.videoId)}?rel=0&autoplay=1" title="미리보기" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
      </div>
      <b style="display:block;margin:12px 0 2px">${esc(v.title)}</b>
      <p class="hint" style="margin:0 0 6px">${esc(v.channel)} · ${fmtDur(Number(v.durationSec) || 0)}</p>
      <p class="mini-state" style="margin:0 0 12px">${badge}</p>
      <button class="primary-btn" data-pick="1" style="width:100%">✓ 이 영상으로 만들기</button>`,
      (box, close) => { box.querySelector('[data-pick]').onclick = () => { selectPicked(v); close(); }; });
  }
  async function search(forcedQuery, append) {
    const box = $('hl-results'), st = $('hl-search-state');
    if (!append) {
      const q = (forcedQuery != null ? forcedQuery : $('hl-query').value).trim();
      if (!q) { alert('주제를 고르거나 검색어를 입력하세요.'); return; }
      query = q; pageToken = ''; loadedCount = 0;
      box.innerHTML = ''; picked = null; $('hl-picked').textContent = ''; renderCountSeg();
      st.textContent = `${region === 'global' ? '해외' : '한국'} 재사용 영상을 찾는 중…`;
    } else st.textContent = '더 불러오는 중…';
    $('hl-more')?.remove();
    try {
      const url = `/api/yt-search?q=${encodeURIComponent(query)}&region=${region}&order=${order}&license=${license}` + (pageToken ? `&pageToken=${pageToken}` : '');
      const d = await (await fetch(url)).json();
      if (d.error) { st.textContent = '⚠️ ' + d.error; return; }
      const vids = d.videos || [];
      $('hl-sort-row').classList.remove('hidden');
      pageToken = d.nextPageToken || ''; loadedCount += vids.length;
      if (!append && !vids.length) { st.textContent = '결과가 없어요. 다른 주제나 검색어로 시도해보세요.'; return; }
      box.insertAdjacentHTML('beforeend', vids.map(cardHtml).join(''));
      wireCards(box);
      st.textContent = `${loadedCount}개 표시 중${pageToken ? ' — 더 있어요' : ' (끝)'} · 하나 고르세요`;
      addLog(append ? `➕ ${vids.length}개 더 불러옴 (총 ${loadedCount}개)` : `🔎 "${query}" 검색 완료 — ${loadedCount}개 (${order === 'viewCount' ? '조회수순' : order === 'date' ? '최신순' : '관련도순'})`);
      saveState();
      if (pageToken) {
        const more = document.createElement('button');
        more.id = 'hl-more'; more.type = 'button'; more.className = 'ghost-btn'; more.style.cssText = 'width:100%;margin-top:10px';
        more.textContent = `▼ 더 보기 (지금 ${loadedCount}개)`;
        more.onclick = () => { more.disabled = true; more.textContent = '불러오는 중…'; search(null, true); };
        box.parentNode.insertBefore(more, box.nextSibling);
      }
    } catch { st.textContent = '검색에 실패했어요. 영상 만들기 화면에서 유튜브 계정이 연결됐는지 확인하세요.'; }
  }
  document.querySelectorAll('.hl-region').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-region').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    region = b.dataset.region; addLog(`🌍 나라 선택: ${region === 'global' ? '해외' : '한국'}`);
    const ac = document.querySelector('.hl-cat.active'); if (ac) search(region === 'global' ? ac.dataset.gq : ac.dataset.kq);
  }));
  document.querySelectorAll('.hl-order').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-order').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    order = b.dataset.order;
    const ac = document.querySelector('.hl-cat.active'); const q = ac ? (region === 'global' ? ac.dataset.gq : ac.dataset.kq) : $('hl-query').value.trim(); if (q) search(q);
  }));
  $('hl-search')?.addEventListener('click', () => { document.querySelector('.hl-cat.active')?.classList.remove('active'); search(); });
  $('hl-query')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { document.querySelector('.hl-cat.active')?.classList.remove('active'); search(); } });

  // ── 영상 범위(라이선스) 토글 — 기본 CC(안전) ──
  function applyLicenseNote() {
    const n = $('hl-lic-note'); if (!n) return;
    if (license === 'all') {
      n.classList.add('warn');
      n.innerHTML = '⚠️ <b>전체 모드</b> — 영화·방송(지상파·케이블)·음원·스포츠 중계 같은 <b>강성 저작권</b>은 해설을 얹어도 위험해요(수동 신고·삭제). 아래 결과의 <b>🆗 무난</b>·<b>✅ 재사용 허가</b> 위주로 고르고 <b>⚠️ 저작권 주의</b>는 피하세요. 해설·자막으로 재가공하면 안전 범위가 넓어지고, 출처는 자동으로 붙어요.';
    } else {
      n.classList.remove('warn');
      n.innerHTML = '원작자가 "가져다 써도 좋다"고 허락한 CC 영상만 보여줘요. 출처만 밝히면 합법 수익화돼요.';
    }
  }
  document.querySelectorAll('.hl-lic').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-lic').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    license = b.dataset.lic === 'all' ? 'all' : 'cc'; applyLicenseNote(); saveState();
    addLog(`🔎 영상 범위: ${license === 'all' ? '전체 영상' : '재사용 허가(CC)'}`);
    const ac = document.querySelector('.hl-cat.active'); const q = ac ? (region === 'global' ? ac.dataset.gq : ac.dataset.kq) : $('hl-query').value.trim(); if (q) search(q);
  }));

  // ── ↻ 최신 가져오기 — 지금 검색을 다시 돌려 새로 올라온 영상만 맨 위에 추가하고 "N개 업데이트했습니다" ──
  async function refresh() {
    if (!query) { alert('먼저 주제를 고르거나 검색하세요.'); return; }
    const box = $('hl-results'), st = $('hl-search-state');
    const existing = new Set([...box.querySelectorAll('.hl-card')].map((c) => c.dataset.id));
    const btn = $('hl-refresh'); const o = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
    st.textContent = '새로 올라온 영상을 확인하는 중…';
    try {
      const url = `/api/yt-search?q=${encodeURIComponent(query)}&region=${region}&order=${order}&license=${license}`;
      const d = await (await fetch(url)).json();
      if (d.error) { st.textContent = '⚠️ ' + d.error; return; }
      const fresh = (d.videos || []).filter((v) => !existing.has(v.videoId));
      if (!fresh.length) { st.textContent = `업데이트할 새 영상이 없어요 (지금 ${existing.size}개).`; addLog('↻ 최신 가져오기 — 새 영상 없음'); return; }
      box.insertAdjacentHTML('afterbegin', fresh.map(cardHtml).join('')); // 새것은 맨 위로
      wireCards(box); loadedCount = existing.size + fresh.length;
      st.textContent = `✅ ${fresh.length}개 업데이트했습니다 — 맨 위에 추가됐어요 (총 ${existing.size + fresh.length}개)`;
      addLog(`↻ 최신 가져오기 — ${fresh.length}개 업데이트`); saveState();
    } catch { st.textContent = '최신 가져오기에 실패했어요.'; }
    finally { if (btn) { btn.disabled = false; btn.textContent = o; } }
  }
  $('hl-refresh')?.addEventListener('click', refresh);

  // ── 소재 가져오는 방법: 주제로 찾기 / 영상 URL 붙여넣기 ──
  function applyMode() {
    $('hl-search-panel')?.classList.toggle('hidden', mode !== 'search');
    $('hl-url-panel')?.classList.toggle('hidden', mode !== 'url');
    $('hl-upload-panel')?.classList.toggle('hidden', mode !== 'upload');
    document.querySelectorAll('.hl-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }
  document.querySelectorAll('.hl-mode').forEach((b) => b.addEventListener('click', () => {
    mode = ['url', 'upload'].includes(b.dataset.mode) ? b.dataset.mode : 'search'; applyMode(); saveState();
  }));

  // ── 내 영상 올리기 — 업로드 → picked(uploadId) 설정 → 바로 '만들기' 가능(저작권 자유) ──
  $('hl-file-pick')?.addEventListener('click', () => $('hl-file')?.click());
  $('hl-file')?.addEventListener('change', () => {
    const f = $('hl-file').files && $('hl-file').files[0];
    if (!f) return;
    if (f.size > 600 * 1024 * 1024) { alert('파일이 너무 커요(최대 600MB). 더 짧거나 낮은 화질로 올려주세요.'); return; }
    $('hl-file-name').textContent = f.name + ` (${Math.round(f.size/1048576)}MB)`;
    uploadMyVideo(f);
  });
  function uploadMyVideo(file) {
    const wrap = $('hl-up-bar-wrap'), bar = $('hl-up-bar'), st = $('hl-up-state');
    wrap.style.display = ''; bar.style.width = '0%'; st.textContent = '올리는 중…'; st.style.color = '';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/highlight/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status !== 200 || d.error) { st.textContent = '⚠️ ' + (d.error || '업로드 실패'); st.style.color = '#e23d3d'; return; }
        bar.style.width = '100%';
        const durTxt = d.duration ? fmtDur(d.duration) : '길이 확인 안됨';
        st.textContent = `✅ 업로드 완료 (${durTxt}) — 아래 옵션 정하고 "하이라이트 숏폼 만들기"를 누르세요.`; st.style.color = '#2bb673';
        // picked를 업로드 영상으로 — 저작권 자유(risk 없음), uploadId로 생성.
        picked = {uploadId: d.uploadId, title: d.title || '내 영상', channel: '내 영상', durationSec: d.duration || 0, isCc: true, risk: 'cc', mine: true};
        $('hl-options')?.scrollIntoView({behavior: 'smooth'});
        saveState();
      } catch { st.textContent = '⚠️ 업로드 응답 오류'; st.style.color = '#e23d3d'; }
    };
    xhr.onerror = () => { st.textContent = '⚠️ 업로드 중 네트워크 오류'; st.style.color = '#e23d3d'; };
    xhr.send(file);
  }
  // URL 모드: 붙여넣은 롱폼 확인 → 카드 1개로 띄우고 바로 크게보기 → '이 영상으로 만들기'
  async function loadUrl() {
    const raw = $('hl-url').value.trim();
    if (!raw) { alert('유튜브 영상 URL을 붙여넣으세요.'); return; }
    const btn = $('hl-url-go'), o = btn.textContent; btn.disabled = true; btn.textContent = '확인 중…';
    const st = $('hl-search-state'); st.textContent = '영상 정보를 확인하는 중…';
    try {
      const d = await (await fetch('/api/yt-video?url=' + encodeURIComponent(raw))).json();
      if (d.error) { st.textContent = '⚠️ ' + d.error; alert(d.error); return; }
      $('hl-results').innerHTML = cardHtml(d); wireCards($('hl-results'));
      $('hl-sort-row')?.classList.add('hidden');
      st.textContent = d.isCc ? '✅ 재사용 허가(CC) 영상이에요 — 바로 만들 수 있어요.' : '⚠️ 표준 라이선스 영상이에요 — 내 영상·권한 있는 영상만 사용하세요.';
      addLog(`🔗 URL 확인: ${d.title} (${d.isCc ? 'CC 재사용 허가' : '표준 라이선스'})`);
      openPreview(d); // 바로 크게보기로 내용 확인
    } catch { st.textContent = '영상 정보를 가져오지 못했어요.'; }
    finally { btn.disabled = false; btn.textContent = o; }
  }
  $('hl-url-go')?.addEventListener('click', loadUrl);
  $('hl-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl(); });
  applyLicenseNote(); applyMode(); // 초기 상태 반영(restoreState가 다시 덮을 수 있음)
  document.querySelectorAll('.hl-sec').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active')); b.classList.add('active'); sec = Number(b.dataset.s);
    if ($('hl-sec-custom')) $('hl-sec-custom').value = ''; renderCountSeg(); saveState();
  }));
  // 길이 직접 입력(15~600초) — 버튼 선택 해제하고 그 값을 쓴다.
  $('hl-sec-custom')?.addEventListener('input', () => {
    const v = Math.max(15, Math.min(600, Number($('hl-sec-custom').value) || 0));
    if (v >= 15) { sec = v; document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active')); renderCountSeg(); saveState(); }
    if ($('hl-sec-saved')) $('hl-sec-saved').textContent = ''; // 값 바꾸면 안내 지움
  });
  // 저장 버튼 — 직접 입력한 길이를 적용·저장하고 "저장되었습니다" 안내.
  $('hl-sec-save')?.addEventListener('click', () => {
    const raw = Number($('hl-sec-custom').value) || 0;
    if (raw < 15 || raw > 600) { alert('15~600초(최대 10분) 사이로 입력하세요.'); return; }
    sec = Math.round(raw);
    document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active'));
    renderCountSeg(); saveState();
    const m = $('hl-sec-saved'); if (m) { const mm = Math.floor(sec/60), ss = sec%60;
      m.textContent = `✅ 저장되었습니다 — 한 편 ${sec}초${mm?` (${mm}분 ${ss}초)`:''}`; }
  });
  // 해설 넣기 토글
  document.querySelectorAll('.hl-cm').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-cm').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    commentary = Number(b.dataset.c); $('hl-voice-row')?.classList.toggle('hidden', !commentary); saveState();
  }));
  $('hl-voice')?.addEventListener('change', () => { voice = $('hl-voice').value; saveState(); });
  // 해설 목소리 목록 채우기(영상 만들기와 같은 ElevenLabs 목소리 재사용).
  (async () => {
    try {
      const d = await (await fetch('/api/categories')).json();
      const sel = $('hl-voice'); if (!sel || !d.voices) return;
      sel.innerHTML = d.voices.map((v) => `<option value="${v.id}">${esc(v.label)}${v.note ? ' · ' + esc(v.note) : ''}</option>`).join('');
      if (voice) sel.value = voice; else voice = sel.value;
    } catch {}
  })();
  document.querySelectorAll('.hl-orient').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-orient').forEach((x) => x.classList.remove('active')); b.classList.add('active'); orient = b.dataset.o; applyReframeRow(); saveState();
  }));
  document.querySelectorAll('.hl-rf').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-rf').forEach((x) => x.classList.remove('active')); b.classList.add('active'); reframeMode = b.dataset.rf; saveState();
  }));
  document.querySelectorAll('.hl-mute').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-mute').forEach((x) => x.classList.remove('active')); b.classList.add('active'); muteOriginal = Number(b.dataset.m); saveState();
  }));
  applyReframeRow();
  // ── 유튜브 쿠키 등록(봇차단 뚫기) ──
  async function refreshCookieStatus() {
    try { const d = await (await fetch('/api/youtube-cookies')).json();
      if ($('ck-status')) $('ck-status').textContent = d.saved ? `✅ 등록됨 (${new Date(d.when).toLocaleDateString('ko-KR')})` : '— 미등록';
    } catch {}
  }
  $('ck-save')?.addEventListener('click', async () => {
    const txt = $('ck-input').value.trim();
    if (!txt) { alert('쿠키 내용을 붙여넣으세요.'); return; }
    const btn = $('ck-save'); btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const r = await fetch('/api/youtube-cookies', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cookies: txt})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '저장 실패');
      $('ck-msg').innerHTML = `✅ 저장됨! 유튜브 쿠키 ${d.lines}줄. 이제 다운로드가 뚫립니다.`;
      $('ck-input').value = ''; refreshCookieStatus();
    } catch (e) { $('ck-msg').textContent = '실패: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = '🔑 쿠키 저장'; }
  });
  refreshCookieStatus();

  renderCats();
  restoreState(); // 탭 나갔다 와도 선택·검색결과 유지(초기화 전까지)
  renderCountSeg(); // 편수 버튼을 처음부터 보이게(영상 고르기 전에도)

  // ── 생성 ──
  let lastBody = null;
  // 작업이 끝/중단/실패했을 때: 중단버튼 숨기고 '이어서 다시'(설정 그대로) + '취소하고 새 영상'을 보여준다.
  function showStopped() {
    $('hl-stop')?.classList.add('hidden');
    if (lastBody) $('hl-resume')?.classList.remove('hidden');
    $('hl-reset')?.classList.remove('hidden');
  }
  function showResume() { showStopped(); }
  // 진행 중인 SSE/작업 표시만 즉시 끊어 UI를 풀어준다(서버 작업은 중단요청으로 알아서 죽음).
  //   → 이걸 해야 '중단' 직후 설정 바꿔 바로 다시 시작할 수 있다(curJobId가 안 풀려 막히던 문제 해결).
  function detachJob() {
    if (curES) { try { curES.close(); } catch {} curES = null; }
    curJobId = null; clearTimeout(tickTimer);
    try { localStorage.removeItem('onvideo-hljob'); localStorage.removeItem('onvideo-hljob-meta'); } catch {}
  }
  // 전체 초기화 — 로그·진행·결과·에너지바까지 싹 비우고 처음 상태로.
  function resetAll() {
    detachJob(); lastBody = null; startTs = 0; estTotalText = ''; resultClips = [];
    if ($('log')) $('log').textContent = ''; logJobId = null; logCount = 0;
    setEnergy(0, ''); const f = $('hl-energy'); if (f) f.classList.add('anim');
    $('progress-block')?.classList.add('hidden');
    $('hl-result-block')?.classList.add('hidden');
    ['hl-stop','hl-resume','hl-reset'].forEach((id) => $(id)?.classList.add('hidden'));
  }
  async function generate(body) {
    const btn = $('hl-generate'); btn.disabled = true; btn.textContent = '시작하는 중…';
    resultClips = []; $('hl-result-block')?.classList.add('hidden'); // 새 제작 → 이전 결과 비움
    ['hl-resume','hl-reset'].forEach((id) => $(id)?.classList.add('hidden'));
    try {
      const d = await (await fetch('/api/generate-highlights', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
      if (d.error) { addLog('[실패] ' + d.error, 'fail'); showStopped(); alert(d.error); return; }
      if (d.id) attachProgress(d.id);
    } catch (e) { addLog('[실패] 시작 실패: ' + e.message, 'fail'); showStopped(); alert('시작 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🎬 하이라이트 숏폼 만들기'; }
  }
  $('hl-generate')?.addEventListener('click', () => {
    if (!picked) { alert('먼저 영상을 고르세요.'); return; }
    if (curJobId) { alert('이미 제작이 진행 중이에요. 끝나거나 중단한 뒤에 다시 시작하세요.'); return; } // 중복 생성 방지
    // ★저작권 '주의'(드라마·예능·영화·음방·방송사) 영상 처리. 핵심: 세로(쇼츠=3분미만)는 Content ID 클레임만
    //   걸려도 "무조건 차단"(유튜브 정책) → 세로+비CC는 거의 다 막힘. 가로 3분+는 차단이 아니라 "클레임"(채널
    //   안 죽고 영상 살아있음, 수익만 원저작자). → 비CC면 가로 3분+로 유도.
    if (picked.risk === 'caution') {
      if (orient === 'portrait') {
        // 세로 = 쇼츠 = 차단. 가로로 바꾸라고 강하게 유도.
        const go = confirm(
          '⚠️ 이 영상(드라마·예능 등)은 세로(쇼츠)로 만들면 거의 차단돼요\n\n' +
          '유튜브는 3분 미만 쇼츠에 저작권이 걸리면 "무조건 차단"합니다(정책). ' +
          '같은 영상도 가로 3분 이상이면 차단이 아니라 "클레임"으로 끝나요(채널 안 죽고 영상은 살아있음, 조회수·구독 쌓임. 광고수익만 원저작자).\n\n' +
          '👉 [확인] 가로 3분+로 바꾸기(권장)   /   [취소] 그래도 세로로(연습·소장용)'
        );
        if (go) {
          // 가로 + 길이 3분(180초)로 자동 전환.
          orient = 'landscape'; sec = 180;
          document.querySelectorAll('.hl-orient').forEach((x) => x.classList.toggle('active', x.dataset.o === 'landscape'));
          document.querySelectorAll('.hl-sec').forEach((x) => x.classList.toggle('active', Number(x.dataset.s) === 180));
          applyReframeRow(); saveState();
          addLog('↪ 저작권 때문에 가로 3분으로 바꿨어요(차단 대신 클레임 — 채널 안전).', 'done');
        }
        // 취소면 세로 유지(사용자 선택). 어느 쪽이든 아래로 진행.
      } else if (picked.durationSec && sec < 180) {
        // 가로지만 3분 미만이면 여전히 쇼츠 취급될 수 있음 → 3분+ 권장.
        const bump = confirm(
          '⚠️ 저작권 주의 영상이에요\n\n' +
          '가로는 세로보다 안전하지만, 3분 미만이면 유튜브가 쇼츠로 보고 차단할 수 있어요. ' +
          '3분 이상이면 "클레임"(채널 안전)으로 끝납니다.\n\n' +
          '👉 [확인] 한 편 길이 3분으로   /   [취소] 지금 길이 유지'
        );
        if (bump) {
          sec = 180;
          document.querySelectorAll('.hl-sec').forEach((x) => x.classList.toggle('active', Number(x.dataset.s) === 180));
          saveState();
        }
      }
    }
    addLog('──────── 하이라이트 제작 시작 ────────', 'done');
    addLog(`• 소재: ${picked.mine ? '📁 내 영상(저작권 자유)' : (mode === 'url' ? 'URL 직접 입력' : (region === 'global' ? '해외' : '한국') + ' · ' + (cat || '직접 검색'))}`);
    addLog(`• 라이선스: ${picked.mine ? '내 소유(차단 걱정 없음)' : (picked.isCc !== false ? '재사용 허가(CC)' : '표준 라이선스(권한 확인 필요)')}`);
    addLog(`• 원본 영상: ${picked.title}`);
    addLog(`• 원본 길이: ${fmtDur(picked.durationSec)} → 클립 ${sec}초짜리`);
    addLog(`• 화면 방향: ${orient === 'landscape' ? '가로 16:9' : '세로 9:16'}${orient === 'portrait' ? ' · ' + (reframeMode === 'letterbox' ? '전체 보존(블러)' : '인물 꽉채움') : ''}`);
    addLog(`• 만들 편수: ${count}편`);
    addLog(`• 해설: ${commentary ? 'AI 해설 입힘 (' + ($('hl-voice')?.selectedOptions[0]?.textContent || voice) + ')' : '원본 그대로'}`);
    addLog(`• 원본 소리: ${muteOriginal ? '제거(저작권 회피)' : '살리기'}`);
    if (muteOriginal && !commentary) addLog('⚠️ 소리를 뺐는데 해설이 꺼져 있어요 — 영상이 무음이 됩니다. 해설을 켜는 걸 권장!', 'fail');
    // 예상 소요 — 편수·한 편 길이 기준 러프 추정(렌더가 대부분이라 길이·편수에 비례). 서버 상황 따라 달라짐.
    const estBase = 2 + count * (sec * 3.5 / 60 + 0.5) + (commentary ? count * 0.4 : 0);
    const estLo = Math.max(2, Math.round(estBase * 0.8)), estHi = Math.round(estBase * 1.2);
    estTotalText = `약 ${estLo}~${estHi}분`;
    addLog(`• 예상 소요: ${estTotalText} (서버 상황 따라 달라져요 · 길이·편수 줄이면 빨라짐)`);
    addLog('────────────────────────────');
    startTs = Date.now(); setEnergy(8, '하이라이트 제작을 시작합니다…');
    // 새로고침해도 경과·예상시간이 안 사라지게 저장(복원 시 읽음).
    try { localStorage.setItem('onvideo-hljob-meta', JSON.stringify({startTs, estTotalText})); } catch {}
    lastBody = {videoId: picked.videoId, uploadId: picked.uploadId, title: picked.title, channel: picked.channel, count, clipSec: sec, orientation: orient, reframe: reframeMode, muteOriginal: !!muteOriginal, commentary: !!commentary, voice, isCc: picked.isCc !== false};
    generate(lastBody);
  });
  $('hl-resume')?.addEventListener('click', () => { if (lastBody) generate(lastBody); });
  // 🗑 취소하고 새 영상 — 로그·진행·결과 싹 비우고 처음부터(다른 영상/설정으로).
  $('hl-reset')?.addEventListener('click', () => {
    if (curJobId && !confirm('진행 중인 제작을 멈추고 전부 비울까요?')) return;
    if (curJobId) { try { fetch('/api/generate-highlights/cancel', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: curJobId})}); } catch {} }
    resetAll();
  });
  // ⏹ 지금 중단 — 누르면 돌아가던 다운로드/편집을 서버가 바로 죽이고, UI는 즉시 풀려 설정 바꿔 다시 시작 가능.
  $('hl-stop')?.addEventListener('click', async () => {
    const jid = curJobId;
    if (!jid) return;
    if (!confirm('지금 만들던 하이라이트를 중단할까요? (바로 멈춥니다)')) return;
    // 서버에 중단 요청 → 돌아가던 yt-dlp/ffmpeg 즉시 kill.
    try { await fetch('/api/generate-highlights/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: jid})}); } catch {}
    // UI 즉시 해제(서버 완료 신호 안 기다림) → '이어서/취소' 노출, 재시작 잠금 해제.
    detachJob();
    addLog('⏹ 중단했습니다. 같은 설정으로 다시 하거나, 취소하고 새 영상을 고르세요.', 'fail');
    setEnergy(energyPct, '중단됨'); const f = $('hl-energy'); if (f) f.classList.remove('anim');
    showStopped();
  });

  // 진행 중이던 하이라이트 작업만 자동 복구(이미 끝났거나 영상 만들기 작업이면 복구 안 함 → 화면 안 막힘).
  (async () => {
    let id = null; try { id = localStorage.getItem('onvideo-hljob'); } catch {}
    if (!id) return;
    try {
      const d = await (await fetch('/api/jobs/current')).json();
      if (d.id === id) {
        // 경과·예상시간 복원(새로고침해도 안 사라지게).
        try { const mt = JSON.parse(localStorage.getItem('onvideo-hljob-meta') || 'null');
          if (mt) { if (mt.startTs) startTs = mt.startTs; estTotalText = mt.estTotalText || ''; } } catch {}
        attachProgress(id); // 지금도 진행 중인 그 작업일 때만
      } else { try { localStorage.removeItem('onvideo-hljob'); localStorage.removeItem('onvideo-hljob-meta'); } catch {} } // 끝난 작업이면 흔적 지움
    } catch {}
  })();
})();
