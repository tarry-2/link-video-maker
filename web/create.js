// 창작 탭 — 장르·키워드 → 오리지널 시나리오(표) → 편집 → 제작. 재창작과 분리된 kind='create'로 기기 연동.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  // ── 공통 보일러플레이트(테마·버전·GPU 배지) ──
  const theme = localStorage.getItem('lvm-theme') || 'light';
  if (theme === 'dark') document.documentElement.classList.add('dark');
  $('theme-btn') && ($('theme-btn').onclick = () => {
    document.documentElement.classList.toggle('dark');
    const cur = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    localStorage.setItem('lvm-theme', cur);
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
  let scenario = null; // 생성된 스토리보드(편집 표의 원본)
  let curJobId = null, curES = null;

  // ── 렌더: 칩/세그 ──
  function renderGenres() {
    $('cr-genres').innerHTML = GENRES.map((g) => `<button type="button" class="cr-chip${genres.includes(g) ? ' active' : ''}" data-g="${g}">${g}</button>`).join('');
  }
  function seg(el, list, cur, attr) {
    el.innerHTML = list.map((x) => {
      const [v, label] = Array.isArray(x) ? x : [x, x + (typeof x === 'number' ? '초' : '')];
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

  $('cr-genres').addEventListener('click', (e) => {
    const b = e.target.closest('.cr-chip'); if (!b) return;
    const g = b.dataset.g;
    if (genres.includes(g)) genres = genres.filter((x) => x !== g); else genres.push(g);
    renderGenres(); save();
  });
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
    try {
      syncTableToScenario();
      localStorage.setItem(KEY, JSON.stringify({genres, dur, orient, style, out, clips, narr, bgm, brief: $('cr-brief').value, scenario}));
    } catch {}
  }
  function restore() {
    let s; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (!s) return;
    genres = Array.isArray(s.genres) && s.genres.length ? s.genres : genres;
    dur = s.dur || dur; orient = s.orient || orient; style = s.style || style;
    out = s.out === 'wan' ? 'wan' : 'image'; clips = s.clips || clips;
    narr = s.narr !== false; bgm = s.bgm !== false;
    $('cr-brief').value = s.brief || '';
    $('cr-narr').checked = narr; $('cr-bgm').checked = bgm;
    if (s.scenario && s.scenario.scenes) { scenario = s.scenario; renderTable(); }
  }

  // ── 시나리오 생성 ──
  $('cr-gen').onclick = $('cr-regen').onclick = async () => {
    if (!genres.length && !$('cr-brief').value.trim()) { $('cr-gen-state').textContent = '장르나 키워드를 하나 이상 골라주세요.'; return; }
    $('cr-gen').disabled = true; $('cr-gen-state').textContent = '✍️ 시나리오 집필 중… (10~20초)';
    try {
      const r = await fetch('/api/create-scenario', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({genre: genres.join(' '), keywords: genres, brief: $('cr-brief').value.trim(), duration: dur, orientation: orient, imageStyle: style}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '생성 실패');
      scenario = d.storyboard;
      renderTable();
      $('cr-gen-state').textContent = '✅ 시나리오 완성 — 표에서 고친 뒤 아래에서 제작하세요.';
      save();
      $('cr-step2').scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (e) { $('cr-gen-state').textContent = '⚠️ ' + e.message; }
    finally { $('cr-gen').disabled = false; }
  };

  // ── 편집 표 ──
  function cell(v) { return `<td contenteditable>${esc(v)}</td>`; }
  function renderTable() {
    if (!scenario || !scenario.scenes) return;
    $('cr-step2').classList.remove('hidden'); $('cr-step3').classList.remove('hidden');
    $('cr-title').value = scenario.title || '';
    $('cr-music').value = scenario.musicPrompt || '';
    $('cr-tbody').innerHTML = scenario.scenes.map((s, i) => `<tr data-i="${i}">
      <td class="cr-scene-num">${i + 1}</td>
      ${cell(s.shot || '')}
      ${cell((s.characters || []).join(', '))}
      ${cell(s.hookTop || '')}
      ${cell(s.hookAccent || '')}
      ${cell(s.narration || '')}
      ${cell(s.visualPrompt || '')}
    </tr>`).join('');
  }
  // 표의 수정 내용을 scenario 객체로 되돌려 반영(제작·저장 전에 호출).
  function syncTableToScenario() {
    if (!scenario || !scenario.scenes) return;
    scenario.title = $('cr-title') ? ($('cr-title').value || scenario.title) : scenario.title;
    scenario.musicPrompt = $('cr-music') ? ($('cr-music').value || scenario.musicPrompt) : scenario.musicPrompt;
    document.querySelectorAll('#cr-tbody tr').forEach((tr) => {
      const i = Number(tr.dataset.i); const s = scenario.scenes[i]; if (!s) return;
      const td = tr.querySelectorAll('td');
      s.shot = td[1].textContent.trim();
      s.characters = td[2].textContent.split(',').map((x) => x.trim()).filter(Boolean);
      s.hookTop = td[3].textContent.trim();
      s.hookAccent = td[4].textContent.trim();
      s.narration = td[5].textContent.trim();
      s.visualPrompt = td[6].textContent.trim();
    });
  }
  $('cr-tbody').addEventListener('input', () => { syncTableToScenario(); });
  $('cr-title').addEventListener('input', save);
  $('cr-music').addEventListener('input', save);

  // ── 제작 ──
  function setEnergy(pct, label) { const e = $('cr-energy'); if (e) { e.style.width = Math.max(4, Math.min(100, pct)) + '%'; } const l = $('cr-energy-label'); if (l) l.textContent = label || ''; }
  function addLog(m) { const box = $('cr-log'); if (!box) return; const d = document.createElement('div'); d.textContent = m; box.appendChild(d); box.scrollTop = box.scrollHeight; }

  $('cr-make').onclick = async () => {
    syncTableToScenario();
    if (!scenario || !scenario.scenes || !scenario.scenes.length) { alert('먼저 시나리오를 만들어 주세요.'); return; }
    save();
    $('cr-progress').classList.remove('hidden'); $('cr-result-block').classList.add('hidden');
    $('cr-log').innerHTML = ''; setEnergy(6, '시작…'); $('cr-make').disabled = true; $('cr-stop').classList.remove('hidden');
    try {
      const r = await fetch('/api/create-produce', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storyboard: scenario, duration: dur, orientation: orient, imageStyle: style, aiClips: out === 'wan' ? clips : 0, narration: narr, bgm}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '제작 실패');
      attach(d.id);
    } catch (e) { addLog('⚠️ ' + e.message); $('cr-make').disabled = false; $('cr-stop').classList.add('hidden'); }
  };
  $('cr-stop').onclick = async () => { if (curJobId) { try { await fetch('/api/generate/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: curJobId})}); } catch {} addLog('중단 요청…'); } };

  function attach(id) {
    curJobId = id;
    if (curES) { try { curES.close(); } catch {} }
    const es = new EventSource('/api/progress?id=' + id);
    curES = es;
    let n = 0;
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.log) { addLog(m.log); n++; setEnergy(Math.min(92, 10 + n * 4), '제작 중…'); }
      if (m.done) {
        es.close(); curES = null; curJobId = null; $('cr-make').disabled = false; $('cr-stop').classList.add('hidden');
        refreshGpu();
        if (m.error) { setEnergy(100, m.error.includes('중단') ? '중단됨' : '실패'); addLog('⚠️ ' + m.error); return; }
        setEnergy(100, '완성! 🎉');
        showResult(m.projectId || (m.clips && m.clips[0] && m.clips[0].projectId), m.title);
      }
    };
    es.onerror = () => { es.close(); if (curES === es) curES = null; };
  }

  function showResult(projectId, title) {
    const box = $('cr-result-block'); if (!box) return;
    box.classList.remove('hidden');
    if (!projectId) { box.innerHTML = '<div class="card"><p class="mini-state">완성됐어요 — 포트폴리오에서 확인하세요.</p></div>'; return; }
    const b = Date.now();
    box.innerHTML = `<div class="card">
      <h2 style="margin:0 0 8px">✍️ 창작 완성!</h2>
      <p class="mini-state" style="margin-bottom:10px">그 자리에서 다운로드·유튜브·인스타로 올릴 수 있어요. 작업 내역(포트폴리오)에도 저장됐어요.</p>
      <video poster="/portfolio-thumb/${projectId}.png?b=${b}" src="/portfolio-item/${projectId}.mp4?b=${b}#t=0.5" controls playsinline preload="metadata" style="width:100%;max-width:${orient === 'landscape' ? '640px' : '320px'};border-radius:12px"></video>
      <div style="margin-top:8px"><b>${esc(title || '창작 영상')}</b></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <a class="ghost-btn small" href="/portfolio-item/${projectId}.mp4" download="${esc(title || 'onvideo')}.mp4">⬇ 다운로드</a>
        <a class="ghost-btn small" href="/voices?tab=pf" target="_blank">🎬 포트폴리오에서 유튜브·인스타 올리기</a>
      </div>
    </div>`;
    box.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  // ── 기기 연동(다른 기기/새로고침에서 진행 중인 창작 작업에 붙기) ──
  async function syncCurrentJob() {
    if (curJobId) return;
    try {
      const d = await (await fetch('/api/jobs/current', {cache: 'no-store'})).json();
      if (d && d.id && d.kind === 'create') {
        $('cr-progress').classList.remove('hidden'); addLog('🔗 진행 중인 창작 작업에 연결했어요.');
        attach(d.id);
      } else if (d && d.done && d.done.kind === 'create') {
        showResult(d.done.projectId, d.done.title);
      }
    } catch {}
  }

  // 초기화
  renderGenres(); renderSegs(); restore();
  syncCurrentJob(); setInterval(syncCurrentJob, 4000);
})();
