// 창작 탭 — 장르·키워드 → 오리지널 시나리오(표) → 편집 → 제작. 로그·결과카드·작업내역·업로드는
// 하이라이트 페이지와 동일 수준으로(토시 하나 안 틀리게 이식). kind='create'로 기기 연동 분리.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  // ── 공통 보일러플레이트(테마·버전·GPU 배지) ──
  if ((localStorage.getItem('lvm-theme') || 'light') === 'dark') document.documentElement.classList.add('dark');
  $('theme-btn') && ($('theme-btn').onclick = () => {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('lvm-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  });
  fetch('/api/version').then((r) => r.json()).then((d) => { if ($('ver')) $('ver').textContent = 'v' + d.version; }).catch(() => {});
  async function refreshGpu() {
    try {
      const d = await (await fetch('/api/runpod/status', {cache: 'no-store'})).json();
      const b = $('gpu-badge'); if (!b) return;
      if (!d.configured) { b.className = 'gpu-badge unknown'; b.textContent = '● GPU 미설정'; return; }
      const on = (d.pods || []).some((p) => p.status === 'RUNNING');
      b.className = 'gpu-badge ' + (on ? 'on' : 'off');
      b.textContent = on ? '● GPU 켜짐(과금중)' : '● GPU 꺼짐';
    } catch {}
  }
  refreshGpu(); setInterval(refreshGpu, 60000);

  // ── 공용 모달(하이라이트와 동일) ──
  function modal(innerHtml, wire) {
    let box = $('cr-up-modal');
    if (!box) { box = document.createElement('div'); box.id = 'cr-up-modal'; document.body.appendChild(box); }
    box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:60';
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto">${innerHtml}</div>`;
    const close = () => box.remove();
    box.onclick = (e) => { if (e.target === box || e.target.closest('[data-x="close"]')) close(); };
    wire(box, close); return box;
  }

  // ── 선택지 ──
  const GENRES = ['미스터리', '공포', '귀신', '사랑', '배신', '복수', '교훈', '감동', '운명', '반전', '스릴러', '판타지', '코미디', '실화풍'];
  const DURS = [30, 60, 90, 120];
  const ORIENTS = [['portrait', '세로'], ['landscape', '가로']];
  const STYLES = [['real', '실사'], ['anime', '애니'], ['cinema', '시네마'], ['classic', '고전']];
  const OUTS = [['image', '🖼 이미지영상'], ['wan', '🎬 움직이는영상']];
  const CLIPS = [1, 2, 3, 4, 6];

  // ── 상태 ──
  let genres = ['미스터리'];
  let dur = 60, orient = 'portrait', style = 'real';
  let out = 'image', clips = 2, narr = true, bgm = true;
  let scenario = null;
  let curJobId = null, curES = null, startTs = 0, tickTimer = null;

  // ── 렌더: 칩/세그 ──
  function renderGenres() {
    $('cr-genres').innerHTML = GENRES.map((g) => `<button type="button" class="cr-chip${genres.includes(g) ? ' active' : ''}" data-g="${g}">${g}</button>`).join('');
  }
  function seg(el, list, cur, attr) {
    el.innerHTML = list.map((x) => {
      const [v, label] = Array.isArray(x) ? x : [x, x + '초'];
      return `<button type="button" class="seg-btn${String(cur) === String(v) ? ' active' : ''}" data-${attr}="${v}">${label}</button>`;
    }).join('');
  }
  function renderSegs() {
    seg($('cr-dur'), DURS, dur, 'd');
    seg($('cr-orient'), ORIENTS, orient, 'o');
    seg($('cr-style'), STYLES, style, 's');
    seg($('cr-out'), OUTS, out, 'out');
    seg($('cr-clips'), CLIPS, clips, 'c');
    $('cr-clip-row').classList.toggle('hidden', out !== 'wan');
  }

  $('cr-genres').addEventListener('click', (e) => { const b = e.target.closest('.cr-chip'); if (!b) return; const g = b.dataset.g; if (genres.includes(g)) genres = genres.filter((x) => x !== g); else genres.push(g); renderGenres(); save(); });
  $('cr-dur').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (!b) return; dur = Number(b.dataset.d); renderSegs(); save(); });
  $('cr-orient').addEventListener('click', (e) => { const b = e.target.closest('[data-o]'); if (!b) return; orient = b.dataset.o; renderSegs(); save(); });
  $('cr-style').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; style = b.dataset.s; renderSegs(); save(); });
  $('cr-out').addEventListener('click', (e) => { const b = e.target.closest('[data-out]'); if (!b) return; out = b.dataset.out; renderSegs(); save(); });
  $('cr-clips').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; clips = Number(b.dataset.c); renderSegs(); save(); });
  $('cr-narr').addEventListener('change', (e) => { narr = e.target.checked; save(); });
  $('cr-bgm').addEventListener('change', (e) => { bgm = e.target.checked; save(); });
  $('cr-brief').addEventListener('input', save);

  // ── 상태 저장/복원(탭 이동·새로고침·기기 바꿔도 유지) ──
  const KEY = 'onvideo-create-state';
  function save() {
    try { syncTableToScenario(); localStorage.setItem(KEY, JSON.stringify({genres, dur, orient, style, out, clips, narr, bgm, brief: $('cr-brief').value, scenario})); } catch {}
  }
  function restore() {
    let s; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (!s) return;
    genres = Array.isArray(s.genres) && s.genres.length ? s.genres : genres;
    dur = s.dur || dur; orient = s.orient || orient; style = s.style || style;
    out = s.out === 'wan' ? 'wan' : 'image'; clips = s.clips || clips;
    narr = s.narr !== false; bgm = s.bgm !== false;
    $('cr-brief').value = s.brief || ''; $('cr-narr').checked = narr; $('cr-bgm').checked = bgm;
    if (s.scenario && s.scenario.scenes) { scenario = s.scenario; renderTable(); }
  }

  // ── 시나리오 생성 ──
  $('cr-gen').onclick = $('cr-regen').onclick = async () => {
    if (!genres.length && !$('cr-brief').value.trim()) { $('cr-gen-state').textContent = '장르나 키워드를 하나 이상 골라주세요.'; return; }
    $('cr-gen').disabled = true; $('cr-gen-state').textContent = '✍️ 시나리오 집필 중… (10~20초)';
    try {
      const r = await fetch('/api/create-scenario', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({genre: genres.join(' '), keywords: genres, brief: $('cr-brief').value.trim(), duration: dur, orientation: orient, imageStyle: style})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '생성 실패');
      scenario = d.storyboard; renderTable();
      $('cr-gen-state').textContent = '✅ 시나리오 완성 — 표에서 고친 뒤 아래에서 제작하세요.'; save();
      $('cr-step2').scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (e) { $('cr-gen-state').textContent = '⚠️ ' + e.message; }
    finally { $('cr-gen').disabled = false; }
  };

  // ── 편집 표 ──
  const cell = (v) => `<td contenteditable>${esc(v)}</td>`;
  function renderTable() {
    if (!scenario || !scenario.scenes) return;
    $('cr-step2').classList.remove('hidden'); $('cr-step3').classList.remove('hidden');
    $('cr-title').value = scenario.title || ''; $('cr-music').value = scenario.musicPrompt || '';
    $('cr-tbody').innerHTML = scenario.scenes.map((s, i) => `<tr data-i="${i}">
      <td class="cr-scene-num">${i + 1}</td>${cell(s.shot || '')}${cell((s.characters || []).join(', '))}${cell(s.hookTop || '')}${cell(s.hookAccent || '')}${cell(s.narration || '')}${cell(s.visualPrompt || '')}
    </tr>`).join('');
  }
  function syncTableToScenario() {
    if (!scenario || !scenario.scenes) return;
    if ($('cr-title')) scenario.title = $('cr-title').value || scenario.title;
    if ($('cr-music')) scenario.musicPrompt = $('cr-music').value || scenario.musicPrompt;
    document.querySelectorAll('#cr-tbody tr').forEach((tr) => {
      const i = Number(tr.dataset.i); const s = scenario.scenes[i]; if (!s) return;
      const td = tr.querySelectorAll('td');
      s.shot = td[1].textContent.trim();
      s.characters = td[2].textContent.split(',').map((x) => x.trim()).filter(Boolean);
      s.hookTop = td[3].textContent.trim(); s.hookAccent = td[4].textContent.trim();
      s.narration = td[5].textContent.trim(); s.visualPrompt = td[6].textContent.trim();
    });
  }
  $('cr-tbody').addEventListener('input', syncTableToScenario);
  $('cr-title').addEventListener('input', save); $('cr-music').addEventListener('input', save);

  // ── 로그 UI(복사/크게보기/초기화, 하이라이트와 동일) ──
  function setEnergy(pct, label) { const e = $('cr-energy'); if (e) e.style.width = Math.max(4, Math.min(100, pct)) + '%'; const l = $('cr-energy-label'); if (l && label != null) l.textContent = label; }
  function addLog(m) { const box = $('cr-log'); if (!box) return; const d = document.createElement('div'); d.textContent = m; box.appendChild(d); box.scrollTop = box.scrollHeight; const big = $('cr-log-big'); if (big && !$('cr-log-modal').classList.contains('hidden')) { const d2 = document.createElement('div'); d2.textContent = m; big.appendChild(d2); big.scrollTop = big.scrollHeight; } }
  const logText = () => Array.from($('cr-log').children).map((d) => d.textContent).join('\n');
  $('cr-log-copy').onclick = () => navigator.clipboard?.writeText(logText());
  $('cr-log-clear').onclick = () => { $('cr-log').innerHTML = ''; };
  $('cr-log-expand').onclick = () => { $('cr-log-big').innerHTML = $('cr-log').innerHTML; $('cr-log-modal').classList.remove('hidden'); };
  $('cr-log-modal-close').onclick = () => $('cr-log-modal').classList.add('hidden');
  $('cr-log-modal-copy').onclick = () => navigator.clipboard?.writeText(logText());
  function startTick() { stopTick(); startTs = startTs || Date.now(); tickTimer = setInterval(() => { const s = Math.floor((Date.now() - startTs) / 1000); $('cr-elapsed').textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 1000); }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  // ── 제작 ──
  $('cr-make').onclick = async () => {
    syncTableToScenario();
    if (!scenario || !scenario.scenes || !scenario.scenes.length) { alert('먼저 시나리오를 만들어 주세요.'); return; }
    save();
    $('cr-progress').classList.remove('hidden'); $('cr-result-block').classList.add('hidden');
    $('cr-log').innerHTML = ''; setEnergy(6, '시작…'); $('cr-make').disabled = true; $('cr-stop').classList.remove('hidden');
    $('cr-phase').textContent = '제작 준비'; startTs = Date.now(); startTick();
    try {
      const r = await fetch('/api/create-produce', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storyboard: scenario, duration: dur, orientation: orient, imageStyle: style, aiClips: out === 'wan' ? clips : 0, narration: narr, bgm})});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '제작 실패');
      attach(d.id);
    } catch (e) { addLog('⚠️ ' + e.message); $('cr-make').disabled = false; $('cr-stop').classList.add('hidden'); stopTick(); }
  };
  $('cr-stop').onclick = async () => { if (curJobId) { try { await fetch('/api/generate/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: curJobId})}); } catch {} addLog('중단 요청…'); } };

  function attach(id) {
    curJobId = id;
    if (curES) { try { curES.close(); } catch {} }
    try { localStorage.setItem('onvideo-create-job', id); } catch {}
    const es = new EventSource('/api/progress?id=' + id); curES = es; let n = 0;
    startTick();
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.log) { addLog(m.log); n++; setEnergy(Math.min(92, 10 + n * 3), '제작 중…'); const mm = m.log.match(/^\[([^\]]+)\]/); if (mm) $('cr-phase').textContent = mm[1]; }
      if (m.done) {
        es.close(); curES = null; curJobId = null; stopTick();
        try { localStorage.removeItem('onvideo-create-job'); } catch {}
        $('cr-make').disabled = false; $('cr-stop').classList.add('hidden'); refreshGpu();
        if (m.error) { setEnergy(100, m.error.includes('중단') ? '중단됨' : '실패'); addLog('⚠️ ' + m.error); return; }
        setEnergy(100, '완성! 🎉');
        showResult(m.projectId || (m.clips && m.clips[0] && m.clips[0].projectId), m.title);
        loadHistory();
      }
    };
    es.onerror = () => { es.close(); if (curES === es) curES = null; };
  }

  // ── 결과 카드(크게보기·다운로드·유튜브·인스타) ──
  function showResult(projectId, title) {
    const box = $('cr-result-block'); if (!box) return;
    box.classList.remove('hidden');
    if (!projectId) { box.innerHTML = '<p class="mini-state">완성됐어요 — 아래 작업 내역에서 확인하세요.</p>'; return; }
    const b = Date.now();
    box.innerHTML = `<h2 class="block-title" style="margin:0 0 4px">✍️ 창작 완성!</h2>
      <p class="mini-state" style="margin-bottom:12px">그 자리에서 크게보기·다운로드·유튜브·인스타 업로드할 수 있어요. 작업 내역에도 저장됐어요.</p>
      <div class="cr-result-grid"><div class="cr-card ${orient === 'landscape' ? 'land' : ''}">
        <video poster="/portfolio-thumb/${projectId}.png?b=${b}" src="/portfolio-item/${projectId}.mp4?b=${b}#t=0.5" controls playsinline preload="metadata"></video>
        <div class="cr-card-body"><b>${esc(title || '창작 영상')}</b>
          <div class="cr-card-actions">
            <button type="button" class="ghost-btn small cr-big" data-id="${projectId}" data-land="${orient === 'landscape' ? '1' : ''}">🔍 크게보기</button>
            <a class="ghost-btn small" href="/portfolio-item/${projectId}.mp4" download="${esc(title || 'onvideo')}.mp4">⬇ 다운로드</a>
            <button type="button" class="ghost-btn small cr-yt" data-id="${projectId}">📺 유튜브</button>
            <button type="button" class="ghost-btn small cr-ig" data-id="${projectId}" data-land="${orient === 'landscape' ? '1' : ''}">📷 인스타</button>
          </div>
        </div>
      </div></div>`;
    box.querySelector('.cr-big').onclick = (e) => bigView(e.target.dataset.id, !!e.target.dataset.land);
    box.querySelector('.cr-yt').onclick = (e) => uploadYouTube(e.target, e.target.dataset.id);
    box.querySelector('.cr-ig').onclick = (e) => uploadInstagram(e.target, e.target.dataset.id, !!e.target.dataset.land);
    box.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  function bigView(id, isLand) {
    const b = Date.now();
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2>미리보기</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <video src="/portfolio-item/${id}.mp4?b=${b}" controls autoplay playsinline style="width:100%;max-height:78vh;border-radius:12px;background:#000;${isLand ? '' : 'aspect-ratio:9/16;object-fit:contain'}"></video>`, () => {});
  }

  // ── 유튜브 업로드(하이라이트와 동일) ──
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
            const rr = await fetch('/api/youtube/upload/' + encodeURIComponent(id), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title: box.querySelector('#cu-t').value, description: box.querySelector('#cu-d').value, tags: box.querySelector('#cu-tags').value.split(',').map((s) => s.trim()).filter(Boolean), privacy: box.querySelector('#cu-p').value})});
            const d = await rr.json(); if (!rr.ok) throw new Error(d.error || '업로드 실패');
            box.querySelector('#cu-msg').innerHTML = `✅ 완료! <a href="${d.url}" target="_blank" style="color:var(--teal)">${d.url}</a>`; up.textContent = '완료 🎉'; loadHistory();
          } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '유튜브에 올리기'; }
        }; });
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
  }

  // ── 인스타 업로드(하이라이트와 동일) ──
  async function uploadInstagram(btn, id, isLandscape) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
    try {
      const st = await (await fetch('/api/instagram/status')).json();
      if (!st.connected) { alert('먼저 영상 만들기 화면의 ⚙ 키 설정에서 인스타 계정을 연결하세요.'); return; }
      btn.textContent = '📷 캡션 만드는 중…';
      const r = await fetch('/api/instagram/caption/' + encodeURIComponent(id)); const d = await r.json();
      if (!r.ok) throw new Error(d.error || '캡션 생성 실패');
      const igKind = isLandscape ? 'feed' : 'reels';
      const methodField = `<label class="field-label">방식<input class="input" value="${isLandscape ? '🖥 가로 → 피드 게시물(자동)' : '📱 세로 → 릴스(자동)'}" disabled></label><input type="hidden" id="cu-k" value="${igKind}">`;
      modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📷 인스타 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
        ${methodField}
        <label class="field-label">캡션·해시태그<textarea id="cu-c" class="input" rows="7" maxlength="2200">${esc(d.caption || '')}</textarea></label>
        <button class="primary-btn" data-up="1">인스타에 올리기</button><p id="cu-msg" class="mini-state">업로드 인코딩에 1~2분 걸릴 수 있어요.</p>`,
        (box) => { box.querySelector('[data-up]').onclick = async (ev) => {
          const up = ev.target; up.disabled = true; up.textContent = '올리는 중…'; box.querySelector('#cu-msg').textContent = '처리 중…';
          try {
            const rr = await fetch('/api/instagram/upload/' + encodeURIComponent(id), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({kind: box.querySelector('#cu-k').value, caption: box.querySelector('#cu-c').value})});
            const dd = await rr.json(); if (!rr.ok) throw new Error(dd.error || '업로드 실패');
            box.querySelector('#cu-msg').innerHTML = dd.permalink ? `✅ 완료! <a href="${dd.permalink}" target="_blank" style="color:var(--teal)">인스타에서 열기</a>` : '✅ 게시 완료!'; up.textContent = '완료 🎉'; loadHistory();
          } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '인스타에 올리기'; }
        }; });
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
  }

  async function del(id) {
    if (!confirm('이 창작 영상을 삭제할까요? (되돌릴 수 없어요)')) return;
    try { const r = await fetch('/api/portfolio/' + encodeURIComponent(id), {method: 'DELETE'}); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '삭제 실패'); } loadHistory(); }
    catch (e) { alert('삭제 실패: ' + e.message); }
  }

  // ── 창작 작업 내역(origin=create만, 이원화) ──
  let histItems = [];
  async function loadHistory() {
    const box = $('cr-history'); if (!box) return;
    try {
      const d = await (await fetch('/api/portfolio', {cache: 'no-store'})).json();
      histItems = (Array.isArray(d.items) ? d.items : []).filter((it) => it.kind === 'mine' && it.origin === 'create');
      renderHistory();
    } catch { box.innerHTML = '<p class="mini-state">작업 내역을 불러오지 못했어요.</p>'; }
  }
  function renderHistory() {
    const box = $('cr-history'); if (!box) return;
    if (!histItems.length) { box.innerHTML = '<p class="mini-state">아직 만든 창작 영상이 없어요. 위에서 시나리오를 만들어보세요.</p>'; return; }
    box.innerHTML = histItems.map((it) => {
      const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
      const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
      const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
      return `<div class="history-item"><span><strong>${esc(it.title)}</strong><small>${esc(when)} · ✍️ 창작${it.motion ? ' · 🎬 영상' : ''}${yt}${ig}</small></span>
        <span class="hi-actions">
          <button type="button" class="ghost-btn small ch-big" data-id="${esc(it.id)}" data-land="${it.orientation === 'landscape' ? '1' : ''}">🔍</button>
          <a class="ghost-btn small" href="${esc(it.video)}" download="${esc(it.title)}.mp4">⬇</a>
          <button type="button" class="ghost-btn small ch-yt" data-id="${esc(it.id)}">📺</button>
          <button type="button" class="ghost-btn small ch-ig" data-id="${esc(it.id)}" data-land="${it.orientation === 'landscape' ? '1' : ''}">📷</button>
          <button type="button" class="ghost-btn small ch-del" data-id="${esc(it.id)}">🗑</button>
        </span></div>`;
    }).join('');
    box.querySelectorAll('.ch-big').forEach((b) => b.onclick = () => bigView(b.dataset.id, !!b.dataset.land));
    box.querySelectorAll('.ch-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.ch-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id, !!b.dataset.land));
    box.querySelectorAll('.ch-del').forEach((b) => b.onclick = () => del(b.dataset.id));
  }
  $('cr-history-refresh').onclick = loadHistory;

  // ── 기기 연동(다른 기기/새로고침에서 진행 중인 창작 작업에 붙기) ──
  async function syncCurrentJob() {
    if (curJobId) return;
    try {
      const local = localStorage.getItem('onvideo-create-job');
      const d = await (await fetch('/api/jobs/current', {cache: 'no-store'})).json();
      if (d && d.id && d.kind === 'create') { $('cr-progress').classList.remove('hidden'); addLog('🔗 진행 중인 창작 작업에 연결했어요(다른 기기에서 시작한 것도 여기서 보여요).'); attach(d.id); }
      else if (d && d.done && d.done.kind === 'create') { showResult(d.done.projectId, d.done.title); loadHistory(); }
      else if (local) { try { localStorage.removeItem('onvideo-create-job'); } catch {} }
    } catch {}
  }

  // 초기화
  renderGenres(); renderSegs(); restore(); loadHistory();
  syncCurrentJob(); setInterval(syncCurrentJob, 4000);
})();
