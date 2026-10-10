// 유튜브 하이라이트 전용 페이지 — 영상 만들기와 완전 분리(독립). 재사용(CC) 영상에서 숏폼만 뽑는다.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDur = (s) => { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
  // 유튜브 업로드 후 썸네일 지정 결과 안내(쇼츠 첫화면이 늦게 뜨는 이유를 바로 알 수 있게).
  const ytThumbNote = (t) => !t ? '' : t.set
    ? '<br><span class="hint">🖼 썸네일 지정됨 — 쇼츠는 유튜브 처리가 끝나야 첫화면(미리보기)에 반영돼요(몇 분~수십 분). 처리 전엔 비어 보일 수 있어요.</span>'
    : `<br><span class="hint" style="color:#d9822b">⚠️ 썸네일 미적용: ${esc(t.detail || ('HTTP ' + (t.status || '?')))} — 유튜브가 자동 프레임을 쓰므로 첫화면이 더 늦게 떠요.</span>`;

  // ── 버전 배지 ──
  fetch('/api/version').then(r => r.json()).then(d => { if ($('ver')) $('ver').textContent = 'v' + d.version; }).catch(() => {});

  // ── 테마 ──
  // ★모든 페이지와 localStorage 키 통일('lvm-theme'). 전엔 하이라이트만 'onvideo-theme'라
  //   탭 전환 시 라이트↔다크가 따로 놀아 테마가 튀었다(테리 실측 2026-10-09).
  const theme = localStorage.getItem('lvm-theme') || 'light';
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  if ($('theme-btn')) $('theme-btn').textContent = theme === 'dark' ? '☀️' : '🌙';
  $('theme-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (cur === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('lvm-theme', cur);
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
          mediaBust = String(Date.now()); // 편집 재렌더 후 새 영상·썸네일 보이게 캐시 무효화
          if (resultClips.length) showResults(resultClips, false);
          loadHistory();
        }
        // 🎭 재창작은 단일 영상(kind='video') — /api/video/<file>로 보기·다운로드 + 포폴(업로드) 링크.
        if (m.kind === 'video' && m.file && !m.error) { showVideoResult(m.file, m.title, m.projectId); loadHistory(); }
      }
    };
    es.onerror = () => {
      es.close(); if (curES === es) curES = null;
      if (curJobId === id && reconnTries < 12) { reconnTries++; setTimeout(() => { if (curJobId === id && !curES) attachProgress(id); }, 2500); }
    };
  }

  // 바이럴 점수 → 등급(A+/A/B/C/D) + 판정. OpusClip식 "올려 말아" 한눈에.
  function gradeOf(score) {
    const s = Math.round(score);
    if (s >= 85) return {g: 'A+', cls: 'hot', verdict: '🔥 터질 각! 바로 올려', short: '강추'};
    if (s >= 75) return {g: 'A', cls: 'hot', verdict: '👍 좋아요 — 올리는 거 추천', short: '추천'};
    if (s >= 65) return {g: 'B', cls: 'good', verdict: '🆗 괜찮아요 — 올릴 만해요', short: '무난'};
    if (s >= 50) return {g: 'C', cls: 'mild', verdict: '😐 보통 — 후킹을 더 세게 바꿔보세요', short: '보통'};
    return {g: 'D', cls: 'mild', verdict: '🥱 약해요 — 다른 구간을 추천해요', short: '약함'};
  }
  // 등급 뱃지 — 영상 위 오버레이(등급+점수). score 없으면 빈 문자열.
  function scoreBadge(score, overlay) {
    if (typeof score !== 'number' || !isFinite(score)) return '';
    const s = Math.round(score); const gr = gradeOf(s);
    return `<span class="score-badge ${gr.cls}${overlay ? ' ov' : ''}" title="AI 예상 바이럴 점수 ${s}/100">${gr.g} · ${s}</span>`;
  }

  // ── 완성 결과(여러 편) — 먼저 끝난 편부터 바로 노출 + 점수순 정렬 ──
  let resultClips = []; // 완성된 편 누적(SSE로 하나씩 들어옴)
  let mediaBust = ''; // 편집 재렌더 후 영상·썸네일 캐시 무효화용(URL에 ?b= 붙임)
  const bust = () => mediaBust ? ('?b=' + mediaBust) : '';
  function addResultClip(c) {
    if (!c || !c.projectId) return;
    if (!resultClips.some((x) => x.projectId === c.projectId)) resultClips.push(c);
    showResults(resultClips, !!curJobId); // 아직 작업 중이면 "나머지 제작 중" 표시
  }
  // 🎭 재창작 단일 영상 결과 — 미리보기 + 다운로드 + 포트폴리오(유튜브·인스타 업로드).
  function showVideoResult(file, title, projectId) {
    const box = $('hl-result-block'); if (!box || !file) return;
    box.classList.remove('hidden');
    const src = '/api/video/' + encodeURIComponent(file);
    const t = (title || '재창작 영상');
    box.innerHTML = `<div class="hl-result-head">🎭 재창작 완성!</div>
      <div class="hl-result-grid"><div class="hl-rcard">
        <video src="${src}" controls playsinline preload="metadata" style="width:100%;border-radius:12px;background:#000"></video>
        <div class="hl-rcard-title">${esc(t)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <a class="ghost-btn small" href="${src}" download="${esc(t)}.mp4">⬇ 다운로드</a>
          <a class="ghost-btn small" href="/voices?tab=pf" target="_blank">📤 포트폴리오에서 유튜브·인스타 올리기</a>
        </div>
      </div></div>
      <p class="mini-state" style="margin-top:6px">✅ 포트폴리오에 자동 등록됐어요 — 포트폴리오 탭에서 유튜브·인스타로 바로 올릴 수 있어요.</p>`;
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
      <p class="mini-state" style="margin-bottom:12px">🏅 등급 = AI가 예측한 "터질 확률"(<b>A+ 강추 → D 약함</b>, 높은 순 정렬). 등급 아래 '올려 말아' 판정을 보고 고르세요. ${inProgress ? '<b>먼저 끝난 편은 지금 바로</b> 다운로드·업로드할 수 있어요(나머지는 계속 제작 중).' : '유튜브·인스타로 바로 올릴 수 있고, 작업 내역에도 저장됐어요.'}</p>
      <div class="hl-result-grid">${clips.map((c, i) => `
        <div class="hl-result-item ${orient === 'landscape' ? 'land' : ''}" style="position:relative">
          ${scoreBadge(c.score, true)}
          <video poster="/portfolio-thumb/${c.projectId}.png${bust()}" src="/portfolio-item/${c.projectId}.mp4${bust()}#t=0.5" controls playsinline preload="metadata"></video>
          <b style="display:block;margin:6px 0">${esc(c.title || ('하이라이트 ' + (i+1)))}</b>
          ${typeof c.score === 'number' ? `<div class="hl-verdict ${gradeOf(c.score).cls}">${gradeOf(c.score).verdict}${c.reason ? ` · <span style="opacity:.8">${esc(c.reason)}</span>` : ''}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="ghost-btn small hl-edit" data-id="${c.projectId}">✏️ 편집</button>
            <a class="ghost-btn small" href="/portfolio-item/${c.projectId}.mp4" download="${esc(c.title || 'highlight')}.mp4">⬇ 다운로드</a>
            <button class="ghost-btn small hl-yt" data-id="${c.projectId}">📺 유튜브</button>
            <button class="ghost-btn small hl-ig" data-id="${c.projectId}">📷 인스타</button>
          </div>
        </div>`).join('')}</div>`;
    box.querySelectorAll('.hl-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.hl-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id, orient === 'landscape'));
    box.querySelectorAll('.hl-edit').forEach((b) => b.onclick = () => openEditModal(b.dataset.id));
    box.scrollIntoView({behavior: 'smooth'});
  }

  // ── 편집 모달 — 후킹 문구 + 디자인 템플릿 바꿔 그 클립만 다시 렌더(Phase3b) ──
  const TPLS = [['variety','예능 자막'],['impact','임팩트 레드'],['cinema','감성 시네마'],['neon','네온 힙'],['magazine','매거진 다큐'],['pop','버블 팝']];
  async function openEditModal(projectId) {
    let info = {};
    try { info = await (await fetch('/api/highlight/edit-info/' + encodeURIComponent(projectId))).json(); } catch {}
    if (info && info.editable === false) { alert('이 하이라이트는 옛 버전이라 편집 소스가 없어요. 새로 만든 하이라이트부터 편집할 수 있어요.'); return; }
    const curTpl = info.template || 'variety';
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2>✏️ 하이라이트 편집</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <video src="/portfolio-item/${projectId}.mp4#t=0.5" poster="/portfolio-thumb/${projectId}.png" controls playsinline preload="metadata" style="width:100%;border-radius:12px;background:#000;max-height:380px"></video>
        </div>
        <div style="flex:1.2;min-width:240px">
          <label class="field-label">상단 후킹 문구 <span class="hint">(윗줄)</span></label>
          <input id="ed-top" class="input" maxlength="40" value="${esc(info.hookTop || '')}">
          <label class="field-label" style="margin-top:8px">강조 문구 <span class="hint">(아랫줄·색강조)</span></label>
          <input id="ed-acc" class="input" maxlength="20" value="${esc(info.hookAccent || '')}">
          <button id="ed-ai" class="ghost-btn small" type="button" style="margin-top:8px">✨ AI로 후킹 다시 추천</button>
          <label class="field-label" style="margin-top:12px">🎨 디자인 템플릿 <span class="hint">— 미리보기를 보고 골라요</span></label>
          <div id="ed-tpl" class="tpl-grid">
            ${TPLS.map(([v,l]) => `<button type="button" class="tpl-card ed-tpl-b ${v===curTpl?'active':''}" data-t="${v}"><span class="tpl-thumb-wrap"><img class="tpl-thumb" src="/tpl-preview/${v}.png" alt="${l} 미리보기" loading="lazy"></span><span class="tpl-name">${l}</span></button>`).join('')}
          </div>
          <button id="ed-save" class="primary-btn" style="margin-top:14px">💾 저장하고 다시 만들기</button>
          <p class="mini-state">저장하면 이 편만 새 디자인으로 다시 렌더해요(1~3분). 완성되면 자동으로 새로고침됩니다.</p>
          <p id="ed-msg" class="mini-state"></p>
        </div>
      </div>`,
      (box, close) => {
        let tpl = curTpl;
        box.querySelectorAll('.ed-tpl-b').forEach((b) => b.onclick = () => { box.querySelectorAll('.ed-tpl-b').forEach((x) => x.classList.remove('active')); b.classList.add('active'); tpl = b.dataset.t; });
        box.querySelector('#ed-ai').onclick = async (ev) => {
          const btn = ev.target; btn.disabled = true; const o = btn.textContent; btn.textContent = '✨ 영상 보고 생각 중…';
          try { const d = await (await fetch('/api/highlight/hook-suggest/' + encodeURIComponent(projectId))).json();
            if (d.hookTop) box.querySelector('#ed-top').value = d.hookTop;
            if (d.hookAccent) box.querySelector('#ed-acc').value = d.hookAccent;
            // 영상 대사를 보고 뽑았는지 알려줘 신뢰감 — 자막 없으면 제목 기반.
            box.querySelector('#ed-msg').textContent = d.basedOn === 'transcript'
              ? '✅ 이 장면의 실제 대사를 보고 추천했어요.'
              : 'ℹ️ 이 영상은 대사(자막)가 없어 제목으로 추천했어요.';
          } catch { box.querySelector('#ed-msg').textContent = 'AI 추천 실패 — 직접 입력하세요.'; }
          finally { btn.disabled = false; btn.textContent = o; }
        };
        box.querySelector('#ed-save').onclick = async (ev) => {
          const btn = ev.target; btn.disabled = true; btn.textContent = '저장 중…';
          try {
            const body = {projectId, hookTop: box.querySelector('#ed-top').value, hookAccent: box.querySelector('#ed-acc').value, template: tpl};
            const d = await (await fetch('/api/highlight/re-render', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
            if (d.error) throw new Error(d.error);
            close();
            // 진행 로그 창에 붙여 재렌더 진행을 보여주고, 끝나면 결과·내역 새로고침.
            addLog('✏️ 편집 재렌더 시작…', 'done');
            if (d.id) attachProgress(d.id);
          } catch (e) { box.querySelector('#ed-msg').textContent = '실패: ' + e.message; btn.disabled = false; btn.textContent = '💾 저장하고 다시 만들기'; }
        };
      });
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
            box.querySelector('#cu-msg').innerHTML = `✅ 완료! <a href="${d.url}" target="_blank" style="color:var(--teal)">${d.url}</a>` + ytThumbNote(d.thumbnail); up.textContent = '완료 🎉'; loadHistory();
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
  // 작업내역 소스별 분류(탭 이원화) — 주제검색 / 영상URL / 내 영상 / 아카이브.
  const SRC_META = {
    search: {label: '🔎 주제로 찾기', order: 0},
    archive: {label: '📼 아카이브', order: 1},
    url: {label: '🔗 영상 URL', order: 2},
    upload: {label: '📁 내 영상', order: 3},
  };
  let histFilter = 'all'; // all 또는 search/archive/url/upload
  let histPage = 0; // 작업내역 페이지(가로 페이지네이션)
  const HIST_PER_PAGE = 10;
  function histItemHtml(it) {
    const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
    const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
    const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
    const srcLabel = (SRC_META[it.source] || {}).label || '🎬 하이라이트';
    return `<div class="history-item"><span><strong>${scoreBadge(it.score)} ${esc(it.title)}</strong><small>${esc(when)} · ${srcLabel}${yt}${ig}</small></span>
      <span class="hi-actions">
        <button type="button" class="ghost-btn small hh-edit" data-id="${esc(it.id)}">✏️</button>
        <a class="ghost-btn small" href="${esc(it.video)}" download="${esc(it.title)}.mp4">⬇</a>
        <button type="button" class="ghost-btn small hh-yt" data-id="${esc(it.id)}">📺</button>
        <button type="button" class="ghost-btn small hh-ig" data-id="${esc(it.id)}" data-land="${it.orientation === 'landscape' ? '1' : ''}">📷</button>
        <button type="button" class="ghost-btn small hh-del" data-id="${esc(it.id)}">🗑</button>
      </span></div>`;
  }
  let histItems = [];
  function renderHistory() {
    const box = $('hl-history'); if (!box) return;
    if (!histItems.length) { box.innerHTML = '<p class="mini-state">아직 만든 하이라이트가 없어요. 위에서 재사용 영상을 골라 만들어보세요.</p>'; return; }
    // 소스별로 그룹핑(각 그룹 안에서 점수순). 레거시(source 없음)는 '주제로 찾기'로.
    const groups = {};
    for (const it of histItems) { const s = SRC_META[it.source] ? it.source : 'search'; (groups[s] ||= []).push(it); }
    const order = Object.keys(groups).sort((a, b) => (SRC_META[a].order) - (SRC_META[b].order));
    // 소스 필터 탭(2개 이상 소스가 있을 때만 노출).
    let tabs = '';
    if (order.length > 1) {
      tabs = `<div class="seg" style="margin:4px 0 12px;flex-wrap:wrap">
        <button type="button" class="seg-btn hh-tab ${histFilter==='all'?'active':''}" data-f="all">전체 (${histItems.length})</button>
        ${order.map((s) => `<button type="button" class="seg-btn hh-tab ${histFilter===s?'active':''}" data-f="${s}">${SRC_META[s].label} (${groups[s].length})</button>`).join('')}
      </div>`;
    }
    // 선택된 소스들의 항목을 소스 순서대로 평탄화 → 10개씩 페이지. 밑으로 안 길어지게 가로 페이저.
    const shown = order.filter((s) => histFilter === 'all' || histFilter === s);
    const items = [];
    for (const s of shown) {
      const list = groups[s].slice().sort((a, b) => (b.score || 0) - (a.score || 0));
      for (const it of list) items.push(it);
    }
    const totalPages = Math.max(1, Math.ceil(items.length / HIST_PER_PAGE));
    if (histPage >= totalPages) histPage = totalPages - 1;
    if (histPage < 0) histPage = 0;
    const from = histPage * HIST_PER_PAGE, to = from + HIST_PER_PAGE;
    const pageItems = items.slice(from, to);
    let body = '';
    let lastSrc = null;
    for (const it of pageItems) {
      const s = SRC_META[it.source] ? it.source : 'search';
      if (order.length > 1 && s !== lastSrc) { body += `<div class="field-label" style="margin:10px 0 4px">${SRC_META[s].label}</div>`; lastSrc = s; }
      body += histItemHtml(it);
    }
    // 가로 페이저
    let pager = '';
    if (totalPages > 1) {
      const nums = [];
      for (let i = 0; i < totalPages; i++) {
        if (i === 0 || i === totalPages - 1 || (i >= histPage - 2 && i <= histPage + 2)) nums.push(i);
        else if (nums[nums.length - 1] !== '…') nums.push('…');
      }
      pager = `<div class="arc-pager" style="margin-top:12px">
        <button type="button" class="arc-pg nav hh-pg" data-p="${Math.max(0, histPage - 1)}" ${histPage === 0 ? 'disabled' : ''}>◀</button>
        ${nums.map((n) => n === '…' ? '<span class="arc-pg dots">…</span>' : `<button type="button" class="arc-pg hh-pg ${n === histPage ? 'active' : ''}" data-p="${n}">${n + 1}</button>`).join('')}
        <button type="button" class="arc-pg nav hh-pg" data-p="${Math.min(totalPages - 1, histPage + 1)}" ${histPage >= totalPages - 1 ? 'disabled' : ''}>▶</button>
      </div>`;
    }
    box.innerHTML = tabs + body + pager;
    box.querySelectorAll('.hh-tab').forEach((b) => b.onclick = () => { histFilter = b.dataset.f; histPage = 0; renderHistory(); });
    box.querySelectorAll('.hh-pg[data-p]').forEach((b) => b.onclick = () => { histPage = Number(b.dataset.p); renderHistory(); box.scrollIntoView({behavior: 'smooth', block: 'start'}); });
    box.querySelectorAll('.hh-edit').forEach((b) => b.onclick = () => openEditModal(b.dataset.id));
    box.querySelectorAll('.hh-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.hh-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id, !!b.dataset.land));
    box.querySelectorAll('.hh-del').forEach((b) => b.onclick = () => del(b.dataset.id));
  }
  async function loadHistory() {
    const box = $('hl-history'); if (!box) return;
    try {
      const d = await (await fetch('/api/portfolio', {cache: 'no-store'})).json();
      histItems = (Array.isArray(d.items) ? d.items : []).filter((it) => it.kind === 'mine' && it.media === 'highlight');
      renderHistory();
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
  let count = 3, sec = 30, query = '', pageToken = '', loadedCount = 0, orient = 'portrait', reframeMode = 'track', muteOriginal = 0, tplMode = 'auto', removeSilence = 0, broll = 0;
  // 세로일 때만 "세로 변환 방식" 노출(가로는 무의미).
  function applyReframeRow() { const r = $('hl-reframe-row'); if (r) r.style.display = orient === 'portrait' ? '' : 'none'; }
  let commentary = 1, voice = ''; // 해설 넣기(0/1) · 해설 목소리 — 기본 ON(재업로드 강등 탈출·수익화 유리)
  let font = ''; // 제목 폰트(모든 탭 공통). 빈값=자동(템플릿 폰트)
  let captionEn = 0; // 영어 번역 자막 함께(0/1, 해설 켤 때만)
  let license = 'cc'; // 영상 범위: cc(안전·재사용 허가만) / all(전체)
  let mode = 'search'; // 소재 가져오는 방법: search(주제로 찾기) / url(영상 URL 붙여넣기)
  let makeMode = 'clip'; // 제작 방식: clip(원본 자르기=하이라이트) / remake(재창작=내용만 뽑아 새 영상)
  let rmOut = 'image';   // 재창작 출력: image(이미지영상) / wan(움직이는영상)

  // ── 선택/검색 상태 저장·복원(탭 나갔다 와도 유지, '초기화' 전까지) ──
  const STATE_KEY = 'onvideo-hl-state';
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        region, order, cat, count, sec, orient, reframeMode, muteOriginal, tplMode, removeSilence, broll, commentary, captionEn, voice, font, query, pageToken, loadedCount, picked, license, mode, cmV2: 1,
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
    license = s.license === 'all' ? 'all' : 'cc'; mode = ['url', 'upload', 'archive'].includes(s.mode) ? s.mode : 'search';
    document.querySelectorAll('.hl-lic').forEach((b) => b.classList.toggle('active', b.dataset.lic === license));
    applyLicenseNote(); applyMode();
    document.querySelectorAll('.hl-orient').forEach((b) => b.classList.toggle('active', b.dataset.o === orient));
    document.querySelectorAll('.hl-rf').forEach((b) => b.classList.toggle('active', b.dataset.rf === reframeMode));
    muteOriginal = s.muteOriginal ? 1 : 0;
    document.querySelectorAll('.hl-mute').forEach((b) => b.classList.toggle('active', Number(b.dataset.m) === muteOriginal));
    removeSilence = s.removeSilence ? 1 : 0;
    document.querySelectorAll('.hl-sil').forEach((b) => b.classList.toggle('active', Number(b.dataset.sil) === removeSilence));
    broll = s.broll ? 1 : 0;
    document.querySelectorAll('.hl-broll').forEach((b) => b.classList.toggle('active', Number(b.dataset.broll) === broll));
    tplMode = s.tplMode || 'auto';
    document.querySelectorAll('.hl-tpl').forEach((b) => b.classList.toggle('active', b.dataset.t === tplMode));
    applyReframeRow();
    count = s.count || 3; sec = s.sec || 30; query = s.query || ''; pageToken = s.pageToken || ''; loadedCount = s.loadedCount || 0;
    // 해설(commentary) 기본값을 ON으로 바꿈(재업로드 강등 탈출). 기존 사용자(cmV2 없음)는 1회 ON으로 이행,
    //   이후엔 사용자가 끈 선택을 존중(cmV2 플래그가 저장됨).
    commentary = s.cmV2 ? (s.commentary ? 1 : 0) : 1; voice = s.voice || '';
    font = s.font || '';
    document.querySelectorAll('#hl-font-picker .font-chip').forEach((b) => b.classList.toggle('active', (b.dataset.font || '') === font));
    captionEn = s.captionEn ? 1 : 0;
    picked = s.picked || null;
    document.querySelectorAll('.hl-cm').forEach((b) => b.classList.toggle('active', Number(b.dataset.c) === commentary));
    $('hl-voice-row')?.classList.toggle('hidden', !commentary);
    $('hl-en-row')?.classList.toggle('hidden', !commentary);
    document.querySelectorAll('.hl-en').forEach((b) => b.classList.toggle('active', Number(b.dataset.en) === captionEn));
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
  // 영상 길이에서 최대 몇 편 뽑을 수 있나. 예전엔 40%(0.4)만 써서 4~5분 영상도 60초 클립이면 1편으로 고정됐다
  //   → 영상의 90%까지 활용해 겹치지 않는 선에서 최대한 여러 편 뽑게 완화(테리: 60초 이상도 1편 고정되는 거 풀어라).
  function maxClips(durationSec, clipSec) { return Math.max(1, Math.min(10, Math.floor((durationSec * 0.9) / Math.max(clipSec, 15)))); }
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
    if (risk === 'archive') return {cls: 'archive', label: '📼 공개 아카이브'};
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
    picked = {videoId: v.videoId, title: v.title, channel: v.channel, durationSec: Number(v.durationSec) || 300, isCc: v.isCc !== false, risk: v.risk || ''};
    document.querySelectorAll('.hl-card').forEach((x) => x.classList.toggle('active', x.dataset.id === picked.videoId));
    $('hl-picked').textContent = `선택: ${picked.title}`;
    renderCountSeg(); saveState();
    addLog(`🎥 영상 선택: ${picked.title} (${fmtDur(picked.durationSec)} · ${picked.channel})`);
    fetchReframeAdvice(); // 영상 파악해서 '꽉채움/전체보존' 추천
    $('hl-options')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  // ── 세로변환 방식 추천 — 선택한 영상을 분석해 어울리는 쪽(track/letterbox)에 ✨추천 뱃지를 붙인다. ──
  //   강제 아님(사용자가 최종 선택). 분석 실패/세로영상이면 뱃지 없이 기존 안내 유지.
  function setRfBadges(recommend) {
    document.querySelectorAll('.rf-badge').forEach((s) => { s.textContent = s.dataset.for === recommend ? ' ✨추천' : ''; });
  }
  let rfAdviceSeq = 0; // 영상 빠르게 바꿀 때 이전 분석 결과가 늦게 와서 덮어쓰는 것 방지
  async function fetchReframeAdvice() {
    setRfBadges(null); // 초기화(이전 영상 뱃지 제거)
    if (!picked || orient !== 'portrait') return;
    const note = $('hl-rf-advice'); const seq = ++rfAdviceSeq;
    const picId = picked.mine ? picked.uploadId : picked.videoId;
    // 진행 표시 — 유튜브/아카이브 영상은 분석용으로 영상을 잠깐 받아서 ~30초 걸릴 수 있다. 멈춘 것처럼 안 보이게 경과초 표시.
    const t0 = Date.now();
    if (note) note.innerHTML = '🔎 <b>영상을 분석해 어울리는 세로변환 방식을 찾는 중…</b> <span class="hint">(영상을 잠깐 받아 얼굴을 분석해요 · 최대 40초)</span>';
    const tick = setInterval(() => {
      if (seq !== rfAdviceSeq) { clearInterval(tick); return; }
      const s = Math.round((Date.now() - t0) / 1000);
      if (note) note.innerHTML = `🔎 <b>영상 분석 중…</b> <span class="hint">(얼굴 감지 ${s}초 경과 · 최대 40초, 끝나면 추천이 떠요)</span>`;
    }, 1000);
    // fetch 타임아웃 넉넉히(50초) — 분석이 오래 걸려도 끊기지 않게.
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 50000);
    try {
      const q = picked.mine ? ('uploadId=' + encodeURIComponent(picked.uploadId || '')) : ('videoId=' + encodeURIComponent(picked.videoId || ''));
      const d = await (await fetch('/api/highlight/reframe-advice?' + q, {signal: ctrl.signal})).json();
      clearInterval(tick); clearTimeout(to);
      if (seq !== rfAdviceSeq || picId !== (picked && (picked.mine ? picked.uploadId : picked.videoId))) return; // 그새 다른 영상 고름 → 무시
      const a = d.advice;
      if (!a) { if (note) note.innerHTML = '<b>인물 꽉채움</b> = 1인·인터뷰에 좋아요. <b>전체 보존</b> = 여러 명·자막 많은 영상에 좋아요. <span class="hint">(이 영상은 자동 분석을 못 해 기본값 — 직접 골라도 돼요)</span>'; return; }
      setRfBadges(a.recommend);
      reframeMode = a.recommend; // 추천 쪽을 기본 선택으로(사용자가 다시 누르면 변경)
      document.querySelectorAll('.hl-rf').forEach((b) => b.classList.toggle('active', b.dataset.rf === reframeMode));
      if (note) note.innerHTML = `✨ <b>${a.recommend === 'track' ? '인물 꽉채움' : '전체 보존'}</b> 추천 — ${esc(a.reason)} <span class="hint">(원하면 다른 쪽을 눌러 바꿀 수 있어요)</span>`;
      saveState();
      addLog(`✨ 세로변환 추천: ${a.recommend === 'track' ? '인물 꽉채움' : '전체 보존'} (${a.reason})`);
    } catch (e) {
      clearInterval(tick); clearTimeout(to);
      if (seq !== rfAdviceSeq) return;
      if (note) note.innerHTML = '세로변환 자동 추천을 못 받았어요(시간 초과 등) — <b>직접 골라주세요</b>. <span class="hint">1인·인터뷰=꽉채움 / 여러 명·자막많음=전체 보존</span>';
    }
  }
  // 크게보기 — 온비디오 안에서 유튜브 영상을 바로 재생해 내용을 미리 본다(제작 전).
  function openPreview(v) {
    const risk = v.risk || (v.isCc ? 'cc' : 'ok');
    const badge = risk === 'cc'
      ? '<span style="color:#2bb673;font-weight:700">✅ 재사용 허가(CC) — 출처만 밝히면 합법 수익화</span>'
      : risk === 'archive'
      ? '<span style="color:#d9822b;font-weight:700">📼 아카이브 — ⚠️ 둘리·영화·가요 등 원저작권자가 따로인 콘텐츠는 Content ID에 걸릴 수 있어요. <b>59초 이하</b>로 만들면 "쇼츠 전세계 차단"을 피해요(1~3분 위험). 걸리면 원본 소리도 제거하세요.</span>'
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
    $('hl-archive-panel')?.classList.toggle('hidden', mode !== 'archive');
    // ★내 영상 올리기 모드에선 다른 영상(검색 결과·주제·정렬)이 보일 필요 없음 → 전부 숨김(내 영상만 집중).
    //   다른 모드로 돌아오면 결과 카드가 있을 때만 다시 보여준다(없으면 계속 숨김).
    const hideOthers = mode === 'upload';
    const hasResults = !!$('hl-results')?.querySelector('.hl-card');
    $('hl-results')?.classList.toggle('hidden', hideOthers);
    $('hl-search-state')?.classList.toggle('hidden', hideOthers);
    if (hideOthers) $('hl-sort-row')?.classList.add('hidden');
    else if (hasResults && mode === 'search') $('hl-sort-row')?.classList.remove('hidden');
    document.querySelectorAll('.hl-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }
  document.querySelectorAll('.hl-mode').forEach((b) => b.addEventListener('click', () => {
    mode = ['url', 'upload', 'archive'].includes(b.dataset.mode) ? b.dataset.mode : 'search'; applyMode(); saveState();
  }));

  // ── 📼 아카이브 — 방송사 공식 공개 아카이브(옛날티비/KBS)에서 주제로 영상을 가져온다. ──
  //   검색 결과를 기존 하이라이트 카드 형식으로 매핑 → 미리보기·선택·제작(기존 엔진)을 그대로 재사용.
  let archiveSrc = 'kbs';
  // 장르 / 주제 2그룹으로 분류(찾기 쉽게). 각 칩의 q는 KBS 아카이브 채널 검색어.
  const ARC_GENRES = [
    {ko:'드라마', q:'드라마'}, {ko:'예능', q:'예능'}, {ko:'코미디', q:'코미디'},
    {ko:'영화', q:'영화'}, {ko:'만화·애니', q:'만화영화'}, {ko:'가요·음악', q:'가요무대'},
    {ko:'토크쇼', q:'토크쇼'}, {ko:'드라마게임', q:'드라마게임'}, {ko:'시트콤', q:'시트콤'},
  ];
  const ARC_TOPICS = [
    // ★'진짜 미스터리'(실제 미제사건·초자연·심령)는 KBS 아카이브엔 없다(드라마·만화만 섞여 나와 헛돎) →
    //   전용 소스 "🔮 미스터리(서프라이즈·심야괴담회)"로 분리. 여기 KBS 주제 칩엔 미스터리 칩을 넣지 않는다.
    {ko:'7080 추억', q:'7080'}, {ko:'다큐멘터리', q:'다큐멘터리'}, {ko:'역사', q:'역사'},
    {ko:'시사·뉴스', q:'뉴스'}, {ko:'스포츠', q:'스포츠'}, {ko:'동물·자연', q:'동물의 왕국'},
    {ko:'요리·음식', q:'요리'}, {ko:'여행', q:'여행'}, {ko:'교양·지식', q:'교양'},
    {ko:'어린이', q:'어린이'}, {ko:'연예·스타', q:'스타'}, {ko:'명장면', q:'명장면'},
  ];
  // 가로 페이지네이션 — 밑으로 길어지지 않게 한 페이지(12개)씩 보여주고 ◀ 1 2 3 ▶ 로 넘긴다.
  const ARC_PER_PAGE = 12;
  let arcQuery = '', arcAll = [], arcSort = 'view', arcServerMore = false, arcLoading = false, arcPage = 0, arcServerOffset = 0;
  function renderArcChips() {
    const mk = (c) => `<button type="button" class="hl-cat hl-arc-cat" data-q="${esc(c.q)}" data-ko="${esc(c.ko)}">${c.ko}</button>`;
    if ($('hl-arc-genres')) $('hl-arc-genres').innerHTML = ARC_GENRES.map(mk).join('');
    if ($('hl-arc-topics')) $('hl-arc-topics').innerHTML = ARC_TOPICS.map(mk).join('');
    document.querySelectorAll('.hl-arc-cat').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.hl-arc-cat').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      cat = b.dataset.ko; if ($('hl-arc-query')) $('hl-arc-query').value = '';
      addLog(`📼 아카이브: ${cat} (옛날티비)`);
      archiveSearch(b.dataset.q);
    }));
  }
  // 아카이브 영상 → 하이라이트 카드 형식으로 매핑(미리보기·선택·제작 재사용).
  function arcToCard(v, srcLabel) {
    // ★채널=실제 소스 라벨(KBS 뉴스·EBS 다큐 등). 출처 표기가 '옛날티비' 하나로 뭉뚱그려지지 않게.
    return {videoId: v.id, title: v.title, channel: srcLabel || '옛날티비', durationSec: v.duration || 0, thumb: v.thumbnail, views: v.viewCount || 0, isCc: false, risk: 'archive'};
  }
  function sortArc(list) {
    const a = list.slice();
    if (arcSort === 'long') a.sort((x, y) => (y.durationSec || 0) - (x.durationSec || 0));
    else if (arcSort === 'short') a.sort((x, y) => (x.durationSec || 0) - (y.durationSec || 0));
    else a.sort((x, y) => (y.views || 0) - (x.views || 0)); // 기본=조회수순
    return a;
  }
  function arcTotalPages() {
    // 서버에 더 있을 수 있으면(arcServerMore) 마지막 페이지 다음에 '다음'을 열어둔다.
    const base = Math.ceil(arcAll.length / ARC_PER_PAGE) || 1;
    return arcServerMore ? base + 1 : base;
  }
  // 페이지 번호 바(가로). 현재 페이지 주변 + 처음/끝. 밑으로 안 길어지게 결과 '위'에 배치.
  function renderArcPager() {
    const wrap = $('hl-arc-pager'); if (!wrap) return;
    const total = arcTotalPages();
    if (arcAll.length <= ARC_PER_PAGE && !arcServerMore) { wrap.innerHTML = ''; wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const cur = arcPage;
    const nums = [];
    const win = 2; // 현재 ±2
    for (let i = 0; i < total; i++) {
      if (i === 0 || i === total - 1 || (i >= cur - win && i <= cur + win)) nums.push(i);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    wrap.innerHTML =
      `<button type="button" class="arc-pg nav" data-p="${Math.max(0, cur - 1)}" ${cur === 0 ? 'disabled' : ''}>◀</button>` +
      nums.map((n) => n === '…'
        ? `<span class="arc-pg dots">…</span>`
        : `<button type="button" class="arc-pg ${n === cur ? 'active' : ''}" data-p="${n}">${n + 1}</button>`).join('') +
      `<button type="button" class="arc-pg nav" data-p="${Math.min(total - 1, cur + 1)}" ${cur >= total - 1 ? 'disabled' : ''}>▶</button>`;
    wrap.querySelectorAll('.arc-pg[data-p]').forEach((b) => b.onclick = () => gotoArcPage(Number(b.dataset.p)));
  }
  function renderArcPage() {
    const box = $('hl-results'); if (!box) return;
    const sorted = sortArc(arcAll);
    const startI = arcPage * ARC_PER_PAGE;
    const slice = sorted.slice(startI, startI + ARC_PER_PAGE);
    box.innerHTML = slice.map(cardHtml).join('');
    wireCards(box);
    if (picked) document.querySelectorAll('.hl-card').forEach((b) => b.classList.toggle('active', b.dataset.id === picked.videoId));
    renderArcPager();
    const st = $('hl-search-state');
    if (st) st.textContent = `${arcPage + 1}페이지 · ${arcAll.length}개${arcServerMore ? '+' : ''} 중 ${slice.length}개 표시 · 하나 고르세요`;
  }
  async function gotoArcPage(p) {
    if (p < 0 || arcLoading) return;
    // 그 페이지를 채울 데이터가 아직 없고 서버에 더 있으면 먼저 다음 묶음을 받아온다.
    while (p * ARC_PER_PAGE >= arcAll.length && arcServerMore && !arcLoading) {
      const ok = await fetchArcBatch();
      if (!ok) break;
    }
    const maxPage = Math.max(0, Math.ceil(arcAll.length / ARC_PER_PAGE) - 1);
    arcPage = Math.min(p, maxPage);
    renderArcPage();
    $('hl-results')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    saveState();
  }
  // 서버에서 다음 묶음(60개)을 받아 arcAll에 누적. 성공 시 true.
  async function fetchArcBatch() {
    if (arcLoading) return false;
    arcLoading = true;
    try {
      const d = await (await fetch(`/api/archive-search?src=${encodeURIComponent(archiveSrc)}&q=${encodeURIComponent(arcQuery)}&offset=${arcServerOffset}`)).json();
      if (d.error) { $('hl-search-state').textContent = '⚠️ ' + d.error; arcServerMore = false; return false; }
      const vids = (d.videos || []).map((v) => arcToCard(v, d.source));
      const seen = new Set(arcAll.map((x) => x.videoId));
      const fresh = vids.filter((v) => !seen.has(v.videoId));
      arcAll = arcAll.concat(fresh);
      arcServerOffset = d.nextOffset || (arcServerOffset + vids.length);
      arcServerMore = !!d.hasMore && fresh.length > 0;
      return true;
    } catch { $('hl-search-state').textContent = '아카이브를 불러오지 못했어요. 잠시 후 다시 시도하세요.'; arcServerMore = false; return false; }
    finally { arcLoading = false; }
  }
  async function archiveSearch(forcedQuery) {
    const st = $('hl-search-state');
    if (arcLoading) return;
    const q = (forcedQuery != null ? forcedQuery : ($('hl-arc-query')?.value || '')).trim();
    // ★빈 쿼리면 그 채널의 최신 전체목록(/videos)을 받는다 — 단일 장르 채널(뉴스·드라마 등)은 탭만 눌러도
    //   바로 보이게(alert 제거). 옛날티비는 장르칩이 쿼리를 넣고, 직접검색도 됨.
    arcQuery = q; arcAll = []; arcServerOffset = 0; arcServerMore = false; arcPage = 0;
    picked = null; $('hl-picked').textContent = ''; $('hl-results').innerHTML = ''; renderCountSeg();
    $('hl-sort-row')?.classList.add('hidden'); $('hl-arc-pager')?.classList.add('hidden');
    st.textContent = '아카이브에서 가져오는 중…';
    query = arcQuery || (document.querySelector('.hl-arc-src.active')?.textContent.trim() || '아카이브'); // 제작 로그/상태용
    const ok = await fetchArcBatch();
    if (!ok) return;
    if (!arcAll.length) { st.textContent = '결과가 없어요. 다른 장르·검색어로 시도해보세요.'; return; }
    $('hl-arc-sort-row')?.classList.remove('hidden');
    renderArcPage();
    addLog(`📼 아카이브 "${arcQuery}" — ${arcAll.length}개${arcServerMore ? '+' : ''} (페이지로 넘겨보세요)`);
    saveState();
  }
  renderArcChips();
  document.querySelectorAll('.hl-arc-src').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-arc-src').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    archiveSrc = b.dataset.src || 'kbs';
    // ★옛날티비(kbs)만 온갖 장르가 섞여 있어 장르·주제 칩이 필요하다. 나머지(드라마·뉴스·다큐·예능)는
    //   채널 자체가 이미 한 장르라 장르·주제 필터가 무의미·복잡 → 숨기고 탭 누르면 바로 전체목록 로드(테리 지시).
    const isMixed = archiveSrc === 'kbs';
    ['#hl-arc-genres', '#hl-arc-topics', '#hl-arc-genre-label', '#hl-arc-topic-label'].forEach((sel) => document.querySelector(sel)?.classList.toggle('hidden', !isMixed));
    document.querySelectorAll('.hl-arc-cat.active').forEach((x) => x.classList.remove('active'));
    $('hl-results').innerHTML = ''; $('hl-arc-pager')?.classList.add('hidden');
    if (!isMixed) { addLog(`📼 ${b.textContent.trim()} — 최신 영상 불러오는 중…`); archiveSearch(''); } // 단일 채널=바로 전체목록
    else if ($('hl-search-state')) $('hl-search-state').textContent = '장르를 고르거나 검색하세요.';
  }));
  $('hl-arc-search')?.addEventListener('click', () => { document.querySelector('.hl-arc-cat.active')?.classList.remove('active'); archiveSearch(); });
  $('hl-arc-query')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { document.querySelector('.hl-arc-cat.active')?.classList.remove('active'); archiveSearch(); } });
  document.querySelectorAll('.hl-arc-sort').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-arc-sort').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    arcSort = b.dataset.sort || 'view'; if (arcAll.length) { arcPage = 0; renderArcPage(); }
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
    const sizeMB = Math.round(file.size / 1048576);
    addLog(`📤 내 영상 올리는 중… ${file.name} (${sizeMB}MB)`);
    let lastPct = 0;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/highlight/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      bar.style.width = pct + '%';
      // 로그는 25% 단위로만(도배 방지) — "영상 올리는 중"이 로그에 보이게.
      if (pct >= lastPct + 25 && pct < 100) { lastPct = pct; addLog(`📤 올리는 중… ${pct}%`); }
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status !== 200 || d.error) { st.textContent = '⚠️ ' + (d.error || '업로드 실패'); st.style.color = '#e23d3d'; addLog('⚠️ 업로드 실패: ' + (d.error || ('HTTP ' + xhr.status)), 'fail'); return; }
        bar.style.width = '100%';
        const durTxt = d.duration ? fmtDur(d.duration) : '길이 확인 안됨';
        st.textContent = `✅ 업로드 완료 (${durTxt}) — 아래 옵션 정하고 "하이라이트 숏폼 만들기"를 누르세요.`; st.style.color = '#2bb673';
        addLog(`✅ 내 영상 업로드 완료 — ${d.title || '내 영상'} (${durTxt}, ${d.sizeMB || sizeMB}MB)`, 'done');
        // picked를 업로드 영상으로 — 저작권 자유(risk 없음), uploadId로 생성.
        picked = {uploadId: d.uploadId, title: d.title || '내 영상', channel: '내 영상', durationSec: d.duration || 0, isCc: true, risk: 'cc', mine: true};
        $('hl-options')?.scrollIntoView({behavior: 'smooth'});
        saveState();
      } catch { st.textContent = '⚠️ 업로드 응답 오류'; st.style.color = '#e23d3d'; addLog('⚠️ 업로드 응답 오류', 'fail'); }
    };
    xhr.onerror = () => { st.textContent = '⚠️ 업로드 중 네트워크 오류'; st.style.color = '#e23d3d'; addLog('⚠️ 업로드 중 네트워크 오류', 'fail'); };
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
  function saveSecCustom() {
    const raw = Number($('hl-sec-custom').value) || 0;
    const m = $('hl-sec-saved');
    if (raw < 15 || raw > 600) { if (m) { m.style.color = '#e0410a'; m.textContent = '15~600초(최대 10분) 사이로 입력하세요.'; } return; }
    sec = Math.round(raw);
    document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active'));
    renderCountSeg(); saveState();
    const mm = Math.floor(sec/60), ss = sec%60;
    if (m) { m.style.color = '#2bb673'; m.textContent = `✅ 저장되었습니다 — 한 편 ${sec}초${mm?` (${mm}분 ${ss}초)`:''}`; }
    addLog(`⏱ 한 편 길이 = ${sec}초로 저장됨`);
  }
  $('hl-sec-save')?.addEventListener('click', saveSecCustom);
  // Enter로도 저장(버튼만으론 '안 먹을 때가 있다'는 문제 — 입력칸에서 Enter 치면 바로 저장).
  $('hl-sec-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSecCustom(); } });
  // 해설 넣기 토글
  document.querySelectorAll('.hl-cm').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-cm').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    commentary = Number(b.dataset.c); $('hl-voice-row')?.classList.toggle('hidden', !commentary); $('hl-en-row')?.classList.toggle('hidden', !commentary); saveState();
  }));
  document.querySelectorAll('.hl-en').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-en').forEach((x) => x.classList.remove('active')); b.classList.add('active'); captionEn = Number(b.dataset.en); saveState();
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
  document.querySelectorAll('.hl-sil').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-sil').forEach((x) => x.classList.remove('active')); b.classList.add('active'); removeSilence = Number(b.dataset.sil); saveState();
  }));
  document.querySelectorAll('.hl-broll').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-broll').forEach((x) => x.classList.remove('active')); b.classList.add('active'); broll = Number(b.dataset.broll); saveState();
  }));
  document.querySelectorAll('.hl-tpl').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-tpl').forEach((x) => x.classList.remove('active')); b.classList.add('active'); tplMode = b.dataset.t; saveState();
  }));
  // 🔤 제목 폰트 선택(모든 탭 공통) — 자동(빈값)이면 템플릿 폰트.
  document.querySelectorAll('#hl-font-picker .font-chip').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#hl-font-picker .font-chip').forEach((x) => x.classList.remove('active')); b.classList.add('active'); font = b.dataset.font || ''; saveState();
  }));
  // 🔍 템플릿 미리보기 크게 보기 — 버튼 선택과 분리(stopPropagation), 샘플 이미지를 모달로 크게.
  document.querySelectorAll('.tpl-zoom').forEach((z) => z.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = z.dataset.zoom; const name = z.dataset.zname || '';
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">🎨 ${name}</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <img src="/tpl-preview/${id}.png" alt="${name} 미리보기" style="width:100%;max-width:300px;display:block;margin:0 auto;border-radius:12px;background:#000">
      <p class="hint" style="text-align:center;margin-top:10px">후킹·자막이 이 스타일로 영상에 얹혀요. 마음에 들면 아래 카드를 눌러 선택하세요.</p>
      <button class="primary-btn" data-pick="${id}" type="button" style="margin-top:8px">이 템플릿으로 선택</button>`,
    (box, close) => {
      box.querySelector('[data-pick]')?.addEventListener('click', () => {
        const card = document.querySelector(`.hl-tpl[data-t="${id}"]`);
        if (card) card.click();
        close();
      });
    });
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
  // 네비에서 "📼 아카이브"로 들어오면(?mode=archive) 바로 아카이브 모드로.
  try { if (new URLSearchParams(location.search).get('mode') === 'archive') { mode = 'archive'; applyMode(); saveState(); } } catch {}
  renderCountSeg(); // 편수 버튼을 처음부터 보이게(영상 고르기 전에도)

  // ── 생성 ──
  let lastBody = null, lastEndpoint = '/api/generate-highlights'; // '이어서 다시'가 올바른 엔드포인트로 가게 기억
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
  let rmClips = 1; // 재창작 움직이는영상 장면 수(기본 1)
  // 제작 방식 토글(하이라이트/재창작) — 재창작이면 전용 옵션 노출 + 하이라이트 전용 옵션 숨김 + 버튼 문구 변경.
  function applyMakeMode() {
    const remake = makeMode === 'remake';
    document.querySelectorAll('.hl-make').forEach((x) => x.classList.toggle('active', x.dataset.make === makeMode));
    $('hl-remake-opts')?.classList.toggle('hidden', !remake);
    // 하이라이트 전용 옵션(세로변환·편수·해설·영어자막·원본소리·무음·b-roll·디자인)은 재창작 땐 숨긴다.
    document.querySelectorAll('.hl-clip-only').forEach((el) => el.classList.toggle('hidden', remake));
    // 목소리 행: 재창작은 항상 나레이션이라 상시 표시. 하이라이트는 해설(commentary) 종속으로 복원.
    $('hl-voice-row')?.classList.toggle('hidden', remake ? false : !commentary);
    applyRmMotion();
    const b = $('hl-generate'); if (b) b.textContent = remake ? '🎭 이 내용으로 새 영상 만들기' : '🎬 하이라이트 숏폼 만들기';
  }
  // 재창작 '움직이는영상'일 때만 장면수 UI 노출.
  function applyRmMotion() {
    $('hl-rm-motion')?.classList.toggle('hidden', !(makeMode === 'remake' && rmOut === 'wan'));
    document.querySelectorAll('.hl-rmclip').forEach((x) => x.classList.toggle('active', Number(x.dataset.n) === rmClips));
  }
  document.querySelectorAll('.hl-make').forEach((b) => b.addEventListener('click', () => {
    makeMode = b.dataset.make === 'remake' ? 'remake' : 'clip'; applyMakeMode();
    addLog(makeMode === 'remake' ? '🎭 제작 방식 = 재창작(새로 만들기)' : '✂️ 제작 방식 = 하이라이트(원본 자르기)');
  }));
  document.querySelectorAll('.hl-rmout').forEach((b) => b.addEventListener('click', () => {
    rmOut = b.dataset.out === 'wan' ? 'wan' : 'image';
    document.querySelectorAll('.hl-rmout').forEach((x) => x.classList.toggle('active', x.dataset.out === rmOut));
    applyRmMotion();
    addLog(rmOut === 'wan' ? `🎬 출력 = 움직이는영상 (장면 ${rmClips}개)` : '🖼 출력 = 이미지영상');
  }));
  // 재창작 장면수 프리셋 버튼.
  document.querySelectorAll('.hl-rmclip').forEach((b) => b.addEventListener('click', () => {
    rmClips = Math.max(1, Math.min(20, Number(b.dataset.n) || 1)); applyRmMotion();
    if ($('hl-rmclip-saved')) $('hl-rmclip-saved').textContent = '';
    addLog(`🎬 움직이는 장면 수 = ${rmClips}개`);
  }));
  // 재창작 장면수 직접 입력 저장 — 확실 적용 + '저장됨' + 로그. 버튼 + Enter 둘 다.
  function saveRmClip() {
    const raw = Number($('hl-rmclip-custom')?.value);
    const s = $('hl-rmclip-saved');
    if (!Number.isFinite(raw) || raw < 1) { if (s) { s.style.color = '#e0410a'; s.textContent = '1~20 사이 숫자를 넣어주세요.'; } return; }
    rmClips = Math.max(1, Math.min(20, Math.round(raw))); applyRmMotion();
    if (s) { s.style.color = '#2bb673'; s.textContent = `✅ 저장됨 — 움직이는 장면 ${rmClips}개로 만들어요.`; }
    addLog(`🎬 움직이는 장면 수 = ${rmClips}개로 저장됨`);
  }
  $('hl-rmclip-save')?.addEventListener('click', saveRmClip);
  $('hl-rmclip-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveRmClip(); } });
  async function generate(body, endpoint) {
    const btn = $('hl-generate'); btn.disabled = true; btn.textContent = '시작하는 중…';
    resultClips = []; $('hl-result-block')?.classList.add('hidden'); // 새 제작 → 이전 결과 비움
    ['hl-resume','hl-reset'].forEach((id) => $(id)?.classList.add('hidden'));
    try {
      const d = await (await fetch(endpoint || '/api/generate-highlights', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
      if (d.error) { addLog('[실패] ' + d.error, 'fail'); showStopped(); alert(d.error); return; }
      if (d.id) attachProgress(d.id);
    } catch (e) { addLog('[실패] 시작 실패: ' + e.message, 'fail'); showStopped(); alert('시작 실패: ' + e.message); }
    finally { btn.disabled = false; applyMakeMode(); }
  }
  $('hl-generate')?.addEventListener('click', () => {
    if (!picked) { alert('먼저 영상을 고르세요.'); return; }
    if (curJobId) { alert('이미 제작이 진행 중이에요. 끝나거나 중단한 뒤에 다시 시작하세요.'); return; } // 중복 생성 방지
    // 🎭 재창작 — 원본을 자르지 않고 그 '내용'으로 우리 이미지·목소리·자막의 새 영상을 만든다(저작권 free).
    if (makeMode === 'remake') {
      addLog('──────── 🎭 재창작 시작 ────────', 'done');
      addLog(`• 원본(소재): ${picked.title}`);
      addLog('• 방식: 원본 영상·소리·로고 미사용 → 그 이야기로 완전 새 영상(저작권 걱정 0)');
      addLog(`• 출력: ${rmOut === 'wan' ? `🎬 움직이는영상(툴 제작 · 장면 ${rmClips}개)` : '🖼 이미지영상'} · 길이 ${sec}초 · ${orient === 'landscape' ? '가로' : '세로'}`);
      addLog(`• 목소리: ${$('hl-voice')?.selectedOptions[0]?.textContent || voice || '자동'}`);
      addLog('────────────────────────────');
      startTs = Date.now(); setEnergy(8, '재창작을 시작합니다…'); estTotalText = '약 3~8분';
      try { localStorage.setItem('onvideo-hljob-meta', JSON.stringify({startTs, estTotalText})); } catch {}
      lastBody = {
        title: picked.title, channel: picked.channel || '',
        duration: sec, orientation: orient, voice, font,
        aiClips: rmOut === 'wan' ? rmClips : 0, // >0 = 움직이는영상(앞 N장면 Wan), 0 = 이미지영상
      };
      lastEndpoint = '/api/generate-remake';
      generate(lastBody, lastEndpoint);
      return;
    }
    // ★저작권 주의·아카이브(둘리·영화·가요 등 원저작권자 따로) 영상 처리. 테리 실측:
    //   1~3분 쇼츠는 Content ID 걸리면 "전세계 차단". 59초 미만이면 그 차단을 피한다(길이가 핵심).
    //   ※ 길이는 '사용자가 고른 값'을 그대로 존중한다 — 예전엔 60초 이상이면 confirm으로 59초로 강제
    //     덮어썼지만, 테리 지시로 강제 락 제거. 저작권 주의 영상이면 '안내만' 띄우고 길이는 건드리지 않음.
    if ((picked.risk === 'caution' || picked.risk === 'archive') && sec >= 60) {
      addLog(`ℹ️ 저작권 주의 영상이고 길이가 ${sec}초예요 — 1~3분 쇼츠는 Content ID에 걸리면 "전세계 차단" 위험이 있어요. 차단을 피하려면 59초 미만을 권장합니다(걸려도 원본 소리를 제거하면 풀려요). 지금 고른 길이 그대로 진행할게요.`, 'warn');
    }
    addLog('──────── 하이라이트 제작 시작 ────────', 'done');
    addLog(`• 소재: ${picked.mine ? '📁 내 영상(저작권 자유)' : (mode === 'archive' ? '📼 ' + (picked.channel || '공개 아카이브') + ' · ' + (cat || '직접 검색') : (mode === 'url' ? 'URL 직접 입력' : (region === 'global' ? '해외' : '한국') + ' · ' + (cat || '직접 검색')))}`);
    addLog(`• 라이선스: ${picked.mine ? '내 소유(차단 걱정 없음)' : (picked.risk === 'archive' ? (picked.channel || '방송사') + ' 공식 공개 아카이브(출처 표기 시 안전)' : (picked.isCc !== false ? '재사용 허가(CC)' : '표준 라이선스(권한 확인 필요)'))}`);
    addLog(`• 원본 영상: ${picked.title}`);
    addLog(`• 원본 길이: ${fmtDur(picked.durationSec)} → 클립 ${sec}초짜리`);
    addLog(`• 화면 방향: ${orient === 'landscape' ? '가로 16:9' : '세로 9:16'}${orient === 'portrait' ? ' · ' + (reframeMode === 'letterbox' ? '전체 보존(블러)' : '인물 꽉채움') : ''}`);
    addLog(`• 만들 편수: ${count}편`);
    addLog(`• 해설: ${commentary ? 'AI 해설 입힘 (' + ($('hl-voice')?.selectedOptions[0]?.textContent || voice) + ')' : '원본 그대로'}`);
    addLog(`• 원본 소리: ${muteOriginal ? '제거(저작권 회피)' : '살리기'}`);
    addLog(`• 무음 제거: ${removeSilence ? '✂️ 켜짐(템포 UP)' : '끄기'}`);
    addLog(`• AI B-roll: ${broll ? '🖼 켜짐(이미지 생성 — 비용 발생)' : '끄기'}`);
    if (commentary) addLog(`• 영어 자막: ${captionEn ? '🌐 한국어+English 함께' : '한국어만'}`);
    addLog(`• 디자인: ${document.querySelector('.hl-tpl.active')?.dataset.name || tplMode}`);
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
    // 소재 출처(작업내역 탭별 이원화) — 내 영상 업로드면 upload, 그 외는 현재 모드(search/url/archive).
    const src = picked.mine ? 'upload' : (['url', 'archive'].includes(mode) ? mode : 'search');
    lastBody = {videoId: picked.videoId, uploadId: picked.uploadId, title: picked.title, channel: picked.channel, count, clipSec: sec, orientation: orient, reframe: reframeMode, muteOriginal: !!muteOriginal, template: tplMode, font, removeSilence: !!removeSilence, broll: !!broll, commentary: !!commentary, captionEn: !!captionEn, source: src, voice, isCc: picked.isCc !== false};
    lastEndpoint = '/api/generate-highlights';
    generate(lastBody, lastEndpoint);
  });
  $('hl-resume')?.addEventListener('click', () => { if (lastBody) generate(lastBody, lastEndpoint); });
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

  // ── 실시간 기기간 연동 ──
  // 어느 기기(PC·모바일·태블릿)에서 하이라이트 제작을 시작하든, 다른 기기도 지금 진행 중인 그 작업에
  // 자동으로 붙어 로그·완성본이 실시간으로 보인다. (예전엔 'localStorage에 내 id 있을 때 1회만' 확인해서
  // 다른 기기엔 연동이 안 됐다 — 그 조건을 없애고, 진행 중이면 누구든 attach + 유휴 중 주기 폴링.)
  let lastDoneJob = ''; // 같은 완료 작업을 중복 처리하지 않게
  // ★작업이 끝났는데 진행화면이 '합성 중…'에 멈춰 보이던 문제 해결 — done이면 끝까지 완성 처리로 닫는다.
  //   (긴 작업에서 SSE가 done을 놓치거나 세션이 끊겨 완료 신호를 못 받으면 진행바가 안 닫혔음. 테리 반복 지적.)
  function finishFromDone(done) {
    if (!done || lastDoneJob === (done.id || done.projectId)) return;
    const wasRunning = !!curJobId; // 진행화면에 붙어 있었나(그럼 멈춘 로딩을 닫아줘야)
    lastDoneJob = done.id || done.projectId;
    if (curES) { try { curES.close(); } catch {} curES = null; }
    curJobId = null; try { clearTimeout(tickTimer); } catch {}
    try { localStorage.removeItem('onvideo-hljob'); localStorage.removeItem('onvideo-hljob-meta'); } catch {}
    if (wasRunning) {
      $('hl-stop')?.classList.add('hidden');
      setEnergy(100, '완성! 🎉'); const f = $('hl-energy'); if (f) f.classList.remove('anim');
      showStopped();
      addLog('✅ 제작이 끝났어요 — 완성본은 아래 작업 내역에서 바로 올리거나 다운로드하세요.', 'done');
      try { celebrate(); } catch {}
    }
    loadHistory();
  }
  async function syncCurrentJob() {
    try {
      const d = await (await fetch('/api/jobs/current', {cache: 'no-store'})).json();
      if (d && d.id && (!d.kind || d.kind === 'highlight')) {
        if (curJobId) return; // 이미 붙어 진행 보고 있으면 그대로
        // 다른 기기(또는 새로고침)에서 돌고 있는 하이라이트 작업 — 바로 붙어 실시간 표시.
        try { const mt = JSON.parse(localStorage.getItem('onvideo-hljob-meta') || 'null');
          if (mt) { if (mt.startTs) startTs = mt.startTs; estTotalText = mt.estTotalText || ''; } } catch {}
        addLog('🔗 진행 중인 제작에 연결했어요(다른 기기에서 시작한 작업도 여기서 실시간으로 보여요).', 'done');
        attachProgress(d.id);
      } else if (d && d.done && d.done.kind === 'highlight') {
        // ★끝난 작업 — 진행화면에 붙어 있었든(SSE가 done 놓침) 아니든, 완성 처리로 멈춘 로딩을 닫는다.
        finishFromDone(d.done);
      }
    } catch {}
  }
  syncCurrentJob();                          // 진입 즉시 1회
  setInterval(syncCurrentJob, 4000);         // 유휴 중 4초마다 — 다른 기기서 시작한 작업을 실시간 포착

  // 🔆 작업 중 화면 꺼짐 방지(Screen Wake Lock). 하이라이트 제작 진행 중(curJobId)이면 화면을 켜둔다.
  let wakeLock = null;
  async function wakeSync() {
    try {
      if (curJobId && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!curJobId && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch { wakeLock = null; }
  }
  setInterval(wakeSync, 3000);
  document.addEventListener('visibilitychange', wakeSync);
})();
