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
  let energyPct = 0, startTs = 0, tickTimer = null;
  function setEnergy(pct, label) { energyPct = Math.max(0, Math.min(100, pct)); const f = $('hl-energy'); if (f) f.style.width = energyPct + '%'; if ($('hl-energy-label')) $('hl-energy-label').textContent = label || ''; }
  function elapsedText() { if (!startTs) return ''; const s = Math.floor((Date.now() - startTs) / 1000); return `⏱ ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
  function tick() { clearTimeout(tickTimer); const n = $('hl-elapsed'); if (!n) return; n.textContent = elapsedText(); tickTimer = setTimeout(tick, 1000); }
  function energyFromLog(line) {
    if (/소재를 뽑습니다|자막/.test(line)) setEnergy(Math.max(energyPct, 15), '소재 분석 중…');
    else if (/영상 다운로드/.test(line)) setEnergy(Math.max(energyPct, 25), '원본 다운로드 중…');
    else if (/구간 확보|구간 선정/.test(line)) setEnergy(Math.max(energyPct, 45), '하이라이트 고르는 중…');
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
    $('hl-stop')?.classList.remove('hidden'); // 진행 중엔 중단 버튼 노출
    $('hl-resume')?.classList.add('hidden');
    tick();
    let recv = 0;
    const es = new EventSource('/api/progress?id=' + id); curES = es;
    es.onmessage = (ev) => {
      reconnTries = 0;
      const m = JSON.parse(ev.data);
      if (m.log) { recv++; if (recv > logCount) { addLog(m.log, m.log.includes('[완료]') ? 'done' : m.log.includes('[실패]') ? 'fail' : ''); energyFromLog(m.log); logCount = recv; } }
      if (m.done) {
        es.close(); curES = null; curJobId = null;
        clearTimeout(tickTimer);
        try { localStorage.removeItem('onvideo-hljob'); } catch {}
        refreshGpu();
        $('hl-stop')?.classList.add('hidden'); // 끝났으니 중단 버튼 숨김
        if (m.error) { setEnergy(energyPct, m.error.includes('중단') ? '중단됨' : '실패'); showResume(); }
        else { setEnergy(100, '완성! 🎉'); const f = $('hl-energy'); if (f) f.classList.remove('anim'); celebrate(); }
        if (m.kind === 'highlight' && !m.error) { showResults(m.clips || []); loadHistory(); }
      }
    };
    es.onerror = () => {
      es.close(); if (curES === es) curES = null;
      if (curJobId === id && reconnTries < 12) { reconnTries++; setTimeout(() => { if (curJobId === id && !curES) attachProgress(id); }, 2500); }
    };
  }

  // ── 완성 결과(여러 편) ──
  function showResults(clips) {
    const box = $('hl-result-block'); if (!box) return;
    box.classList.remove('hidden');
    if (!clips.length) { box.innerHTML = '<p class="mini-state">완성된 클립이 없어요.</p>'; return; }
    box.innerHTML = `<h2 style="margin:0 0 4px">🎬 하이라이트 ${clips.length}편 완성!</h2>
      <p class="mini-state" style="margin-bottom:12px">각 편을 확인하고 유튜브·인스타로 바로 올릴 수 있어요. 작업 내역에도 저장됐어요.</p>
      <div class="hl-result-grid">${clips.map((c, i) => `
        <div class="hl-result-item">
          <video src="/portfolio-item/${c.projectId}.mp4#t=0.5" controls playsinline preload="metadata"></video>
          <b style="display:block;margin:6px 0">${esc(c.title || ('하이라이트 ' + (i+1)))}</b>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="ghost-btn small" href="/portfolio-item/${c.projectId}.mp4" download="${esc(c.title || 'highlight')}.mp4">⬇ 다운로드</a>
            <button class="ghost-btn small hl-yt" data-id="${c.projectId}">📺 유튜브</button>
            <button class="ghost-btn small hl-ig" data-id="${c.projectId}">📷 인스타</button>
          </div>
        </div>`).join('')}</div>`;
    box.querySelectorAll('.hl-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.hl-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id));
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
  async function uploadInstagram(btn, id) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
    try {
      const st = await (await fetch('/api/instagram/status')).json();
      if (!st.connected) { alert('먼저 영상 만들기 화면의 ⚙ 키 설정에서 인스타 계정을 연결하세요.'); return; }
      btn.textContent = '📷 캡션 만드는 중…';
      const r = await fetch('/api/instagram/caption/' + encodeURIComponent(id)); const d = await r.json();
      if (!r.ok) throw new Error(d.error || '캡션 생성 실패');
      modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📷 인스타 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
        <label class="field-label">방식<select id="cu-k" class="input"><option value="reels">릴스(세로 쇼츠)</option><option value="feed">피드 영상</option></select></label>
        <label class="field-label">캡션·해시태그<textarea id="cu-c" class="input" rows="7" maxlength="2200">${esc(d.caption || '')}</textarea></label>
        <button class="primary-btn" data-up="1">인스타에 올리기</button><p id="cu-msg" class="mini-state">릴스는 1~2분 걸릴 수 있어요.</p>`,
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
      const items = (Array.isArray(d.items) ? d.items : []).filter((it) => it.kind === 'mine' && it.media === 'highlight');
      box.innerHTML = items.length ? items.map((it) => {
        const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
        const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
        const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
        return `<div class="history-item"><span><strong>${esc(it.title)}</strong><small>${esc(when)} · 🎬 하이라이트${yt}${ig}</small></span>
          <span class="hi-actions">
            <a class="ghost-btn small" href="${esc(it.video)}" download="${esc(it.title)}.mp4">⬇</a>
            <button type="button" class="ghost-btn small hh-yt" data-id="${esc(it.id)}">📺</button>
            <button type="button" class="ghost-btn small hh-ig" data-id="${esc(it.id)}">📷</button>
            <button type="button" class="ghost-btn small hh-del" data-id="${esc(it.id)}">🗑</button>
          </span></div>`;
      }).join('') : '<p class="mini-state">아직 만든 하이라이트가 없어요. 위에서 재사용 영상을 골라 만들어보세요.</p>';
      box.querySelectorAll('.hh-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
      box.querySelectorAll('.hh-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id));
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
  let count = 3, sec = 30, query = '', pageToken = '', loadedCount = 0;

  // ── 선택/검색 상태 저장·복원(탭 나갔다 와도 유지, '초기화' 전까지) ──
  const STATE_KEY = 'onvideo-hl-state';
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        region, order, cat, count, sec, query, pageToken, loadedCount, picked,
        resultsHtml: $('hl-results')?.innerHTML || '',
        moreVisible: !!$('hl-more'),
        searchState: $('hl-search-state')?.textContent || '',
        catActive: document.querySelector('.hl-cat.active')?.dataset.ko || '',
      }));
    } catch {}
  }
  function restoreState() {
    let s; try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch {}
    if (!s) return false;
    region = s.region || 'kr'; order = s.order || 'viewCount'; cat = s.cat || '';
    count = s.count || 3; sec = s.sec || 30; query = s.query || ''; pageToken = s.pageToken || ''; loadedCount = s.loadedCount || 0;
    picked = s.picked || null;
    // 버튼 활성 복원
    document.querySelectorAll('.hl-region').forEach((b) => b.classList.toggle('active', b.dataset.region === region));
    document.querySelectorAll('.hl-order').forEach((b) => b.classList.toggle('active', b.dataset.order === order));
    document.querySelectorAll('.hl-sec').forEach((b) => b.classList.toggle('active', Number(b.dataset.s) === sec));
    if (s.catActive) document.querySelectorAll('.hl-cat').forEach((b) => b.classList.toggle('active', b.dataset.ko === s.catActive));
    if (s.query) $('hl-query').value = s.query;
    // 검색 결과 복원(카드 다시 클릭되게 바인딩)
    if (s.resultsHtml) {
      $('hl-results').innerHTML = s.resultsHtml;
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
  function cardHtml(v) {
    return `<button type="button" class="hl-card" data-id="${v.videoId}" data-title="${esc(v.title)}" data-channel="${esc(v.channel)}" data-dur="${v.durationSec}">
      <img src="${v.thumb}" alt="" loading="lazy" />
      <div class="hl-meta"><b>${esc(v.title)}</b><span>${esc(v.channel)} · ${fmtDur(v.durationSec)} · 조회 ${Number(v.views).toLocaleString('ko-KR')}</span></div>
    </button>`;
  }
  function wireCards(box) {
    box.querySelectorAll('.hl-card:not([data-w])').forEach((b) => {
      b.setAttribute('data-w', '1');
      b.addEventListener('click', () => {
        box.querySelectorAll('.hl-card').forEach((x) => x.classList.remove('active')); b.classList.add('active');
        picked = {videoId: b.dataset.id, title: b.dataset.title, channel: b.dataset.channel, durationSec: Number(b.dataset.dur) || 300};
        $('hl-picked').textContent = `선택: ${picked.title}`;
        renderCountSeg(); saveState();
        addLog(`🎥 영상 선택: ${picked.title} (${fmtDur(picked.durationSec)} · ${picked.channel})`);
      });
    });
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
      const url = `/api/yt-search?q=${encodeURIComponent(query)}&region=${region}&order=${order}` + (pageToken ? `&pageToken=${pageToken}` : '');
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
  document.querySelectorAll('.hl-sec').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active')); b.classList.add('active'); sec = Number(b.dataset.s); renderCountSeg(); saveState();
  }));
  renderCats();
  restoreState(); // 탭 나갔다 와도 선택·검색결과 유지(초기화 전까지)
  renderCountSeg(); // 편수 버튼을 처음부터 보이게(영상 고르기 전에도)

  // ── 생성 ──
  let lastBody = null;
  function showResume() { const b = $('hl-resume'); if (b && lastBody) b.classList.remove('hidden'); }
  async function generate(body) {
    const btn = $('hl-generate'); btn.disabled = true; btn.textContent = '시작하는 중…';
    $('hl-resume')?.classList.add('hidden');
    try {
      const d = await (await fetch('/api/generate-highlights', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
      if (d.error) { addLog('[실패] ' + d.error, 'fail'); showResume(); alert(d.error); return; }
      if (d.id) attachProgress(d.id);
    } catch (e) { addLog('[실패] 시작 실패: ' + e.message, 'fail'); showResume(); alert('시작 실패: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🎬 하이라이트 숏폼 만들기'; }
  }
  $('hl-generate')?.addEventListener('click', () => {
    if (!picked) { alert('먼저 영상을 고르세요.'); return; }
    addLog('──────── 하이라이트 제작 시작 ────────', 'done');
    addLog(`• 나라: ${region === 'global' ? '해외' : '한국'}`);
    addLog(`• 주제: ${cat || '직접 검색'}`);
    addLog(`• 원본 영상: ${picked.title}`);
    addLog(`• 원본 길이: ${fmtDur(picked.durationSec)} → 클립 ${sec}초짜리`);
    addLog(`• 만들 편수: ${count}편`);
    addLog('────────────────────────────');
    startTs = Date.now(); setEnergy(8, '하이라이트 제작을 시작합니다…');
    lastBody = {videoId: picked.videoId, title: picked.title, channel: picked.channel, count, clipSec: sec};
    generate(lastBody);
  });
  $('hl-resume')?.addEventListener('click', () => { if (lastBody) generate(lastBody); });
  // ⏹ 중단 버튼 — 잘못 골랐을 때. 누르면 "계속 진행 / 중단" 선택.
  $('hl-stop')?.addEventListener('click', async () => {
    if (!curJobId) return;
    // confirm: 확인=중단, 취소=계속 진행
    if (!confirm('지금 만들던 하이라이트를 중단할까요?\n\n[확인] = 중단(취소)\n[취소] = 계속 진행')) {
      addLog('▶ 계속 진행합니다.'); return;
    }
    try {
      await fetch('/api/generate-highlights/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: curJobId})});
      addLog('⏹ 중단 요청됨 — 진행 중인 단계가 끝나는 대로 멈춥니다.');
      $('hl-stop').disabled = true; $('hl-stop').textContent = '중단 중…';
      setTimeout(() => { if ($('hl-stop')) { $('hl-stop').disabled = false; $('hl-stop').textContent = '⏹ 중단'; } }, 3000);
    } catch (e) { alert('중단 요청 실패: ' + e.message); }
  });

  // 진행 중이던 하이라이트 작업만 자동 복구(이미 끝났거나 영상 만들기 작업이면 복구 안 함 → 화면 안 막힘).
  (async () => {
    let id = null; try { id = localStorage.getItem('onvideo-hljob'); } catch {}
    if (!id) return;
    try {
      const d = await (await fetch('/api/jobs/current')).json();
      if (d.id === id) attachProgress(id); // 지금도 진행 중인 그 작업일 때만
      else { try { localStorage.removeItem('onvideo-hljob'); } catch {} } // 끝난 작업이면 흔적 지움
    } catch {}
  })();
})();
