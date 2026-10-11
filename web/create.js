// 창작 탭 — 장르·키워드 → 오리지널 시나리오(표) → 편집 → 제작. 로그·결과카드·작업내역·업로드는
// 하이라이트 페이지와 동일 수준으로(토시 하나 안 틀리게 이식). kind='create'로 기기 연동 분리.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  // ── 공통 보일러플레이트(테마·버전·GPU 배지) ──
  // ★테마는 data-theme 속성으로(style.css가 이걸 봄). classList('dark')는 CSS가 안 먹어 토글이 안 됐다(테리 지적). highlight와 동일.
  const theme0 = localStorage.getItem('lvm-theme') || 'light';
  if (theme0 === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  if ($('theme-btn')) $('theme-btn').textContent = theme0 === 'dark' ? '☀️' : '🌙';
  $('theme-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (cur === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('lvm-theme', cur);
    if ($('theme-btn')) $('theme-btn').textContent = cur === 'dark' ? '☀️' : '🌙';
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

  // ── 가벼운 저장 확인 팝업(토스트) — "저장되었습니다"를 화면 가운데 띄우고 1.6초 뒤 사라진다. ──
  function toast(msg, ok) {
    let t = $('cr-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cr-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:var(--card);border:2px solid ' + (ok === false ? '#e0410a' : 'var(--teal)') + ';border-radius:16px;padding:18px 30px;font-weight:800;font-size:17px;z-index:90;box-shadow:0 14px 48px rgba(0,0,0,.35);opacity:0;transition:opacity .15s;text-align:center;max-width:86vw;white-space:pre-line;line-height:1.5';
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    clearTimeout(t._tm); t._tm = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => { if (t) t.remove(); }, 220); }, 1600);
  }

  // ── 선택지 ──
  // 🔥=지금 전 세계 세로 숏드라마(ReelShort·DramaBox, 2026)에서 조회수·완주율 최상위 장르(복수·로맨스·스릴러·심리호러·반전).
  //   리서치 근거: 로맨스=최대 완주율, 스릴러=가장 빠른 성장(18~30), 심리호러=급부상, 복수·재벌반전=대표 흥행 소재.
  const HOT = {사랑: 1, 복수: 1, 스릴러: 1, 반전: 1, 공포: 1, 배신: 1};
  const GENRES = ['미스터리', '공포', '귀신', '사랑', '배신', '복수', '교훈', '감동', '운명', '반전', '스릴러', '판타지', '코미디', '실화풍'];
  const DURS = [30, 60, 90, 120];
  const ORIENTS = [['portrait', '세로'], ['landscape', '가로']];
  const STYLES = [['real', '실사'], ['anime', '애니'], ['cinema', '시네마'], ['classic', '고전']];
  const OUTS = [['image', '🖼 이미지영상'], ['wan', '🎬 영화']];
  // ★'영화 장면 수' = 몇 '개'의 장면을 실제 영화로 만들지. 예전엔 seg() 기본 포맷이 '초'를 붙여
  //   "4초"처럼 보여 테리가 '길이(초)'로 오해함 → 명시적으로 '개' 라벨을 준다(초 아님).
  const CLIPS = [[1, '1개'], [2, '2개'], [3, '3개'], [4, '4개'], [6, '6개']];
  const EPS = [[1, '단편 1개'], [3, '3부작'], [5, '5부작'], [10, '10부작']];
  // 대본 AI 엔진 — free=무료 Gemini(2패스 재집필로 무료 최대치) / gpt=결제한 OpenAI GPT-4.1(방송국·뮤지컬 수준).
  const ENGINES = [['free', '🆓 무료 (Gemini)'], ['gpt', '⭐ 고급 (GPT)']];

  // ── 상태 ──
  let genres = ['미스터리'];
  let dur = 60, orient = 'portrait', style = 'real';
  let out = 'image', clips = 2, narr = true, bgm = true, voice = '';
  let engine = 'free'; // 대본 AI 엔진(free=무료 Gemini / gpt=고급 GPT)
  let scenario = null;
  let curJobId = null, curES = null, startTs = 0, tickTimer = null, lastLogAt = 0;
  let shownResultId = null, resultTimer = null; // 완성 결과카드: 같은 완성작 중복표시 방지 + 5분 뒤 자동 정리
  // 시리즈 상태
  let eps = 1;              // 편 수(1=단편)
  let bible = null;         // 스토리 바이블(JSON) — 시리즈일 때
  let epScenarios = [];     // 편별 시나리오(인덱스 0=1편)
  let epProduced = [];      // 편별 완성 projectId
  let curEp = 0;            // 현재 보고 있는 편(0-base)

  // ── 렌더: 칩/세그 ──
  function renderGenres() {
    $('cr-genres').innerHTML = GENRES.map((g) => `<button type="button" class="cr-chip${genres.includes(g) ? ' active' : ''}${HOT[g] ? ' hot' : ''}" data-g="${g}">${g}${HOT[g] ? '<span class="cr-fire" title="지금 숏드라마에서 조회수 터지는 장르">🔥</span>' : ''}</button>`).join('');
  }
  function seg(el, list, cur, attr) {
    el.innerHTML = list.map((x) => {
      const [v, label] = Array.isArray(x) ? x : [x, x + '초'];
      return `<button type="button" class="seg-btn${String(cur) === String(v) ? ' active' : ''}" data-${attr}="${v}">${label}</button>`;
    }).join('');
  }
  // 대본 AI 엔진 설명 — 무료 Gemini vs 고급 GPT가 '뭐가 다른지' 공부형으로 또렷이(선택된 쪽을 강조).
  function renderEngineNote() {
    const el = $('cr-engine-note'); if (!el) return;
    const on = (k) => engine === k ? 'opacity:1' : 'opacity:.55';
    el.innerHTML = `
      <div style="${on('free')}"><b>🆓 무료 (Gemini)</b> — 구글 Gemini로 집필. <b>공짜</b>, 빠름(10~20초). 초고를 쓴 뒤 <b>AI가 한 번 더 고쳐 쓰는 2패스</b>로 무료 안에서 품질을 최대한 끌어올려요. 평소 대량 제작용.</div>
      <div style="${on('gpt')};margin-top:6px"><b>⭐ 고급 (GPT-4.1)</b> — 당신이 <b>결제한 OpenAI 키</b>로 집필. 플롯 짜임새·문장력·<b>반전 설계</b>가 한 수 위예요(방송국 드라마·뮤지컬 수준 목표). 느림(20~40초), <b>글값만</b> 조금 들어요(몇 원~수십 원 — 영상 GPU·제작비와 무관). 승부 볼 중요한 영상에.</div>
      <div style="margin-top:6px;color:#e8612b">※ 고급(GPT)은 <b>⚙ 키 설정에 OpenAI 키</b>가 있어야 작동해요(없으면 자동으로 무료 Gemini로 만들어요).</div>`;
  }
  function renderSegs() {
    seg($('cr-eps'), EPS, eps, 'e');
    seg($('cr-dur'), DURS, dur, 'd');
    seg($('cr-orient'), ORIENTS, orient, 'o');
    seg($('cr-style'), STYLES, style, 's');
    seg($('cr-out'), OUTS, out, 'out');
    seg($('cr-clips'), CLIPS, clips, 'c');
    seg($('cr-engine'), ENGINES, engine, 'eng');
    renderEngineNote();
    $('cr-clip-row').classList.toggle('hidden', out !== 'wan');
    const note = $('cr-eps-note'); if (note) note.textContent = eps > 1 ? `${eps}부작 시리즈 — 세계관·인물이 이어지고 편마다 다음 편이 궁금한 클리프행어로 끊겨요.` : '단편 1개를 만들어요.';
    $('cr-gen').textContent = eps > 1 ? `✍️ ${eps}부작 시리즈 설계하기` : '✍️ 시나리오 만들기';
    // 직접입력 칸은 항상 현재 값을 비춘다(프리셋 클릭·직접저장·복원 어느 쪽이든 일치).
    if ($('cr-eps-custom')) $('cr-eps-custom').value = eps;
    if ($('cr-dur-custom')) $('cr-dur-custom').value = dur;
    updatePlan();
  }

  // ── 제작 '설계' 한눈에 — 몇 편/총 몇 장면/움직임 몇·사진 몇을 또렷이(테리: 흐름을 모르겠다) ──
  function totalScenes() { return (scenario && Array.isArray(scenario.scenes)) ? scenario.scenes.length : 0; }
  function updatePlan() {
    const T = totalScenes();
    // 영화 장면 = 고른 개수와 총 장면 중 작은 값(서버 pipeline도 scenes.length로 클램프). 이미지영상이면 0.
    const moving = out === 'wan' ? Math.min(clips, T || clips) : 0;
    // step04 안내 문구 — 총 장면을 모르면 '시나리오 먼저', 알면 정확한 분배를 보여준다.
    const note = $('cr-clip-note');
    if (note) {
      note.innerHTML = !T
        ? '시나리오를 먼저 만들면 <b>총 장면 수</b>가 정해져요. 그중 <b>앞에서부터 고른 개수</b>만 영화로, 나머지는 사진으로 만들어요. 영화 장면이 많을수록 비용이 커져요.'
        : `이 시나리오는 총 <b>${T}장면</b>이에요 → 앞 <b>${moving}장면</b>은 🎬 영화(과금), 나머지 <b>${T - moving}장면</b>은 🖼 사진이에요.`;
    }
    // 제작 요약(몇 편인지 = 테리가 가장 궁금해한 것).
    const sum = $('cr-make-summary');
    if (sum) {
      const epsN = eps > 1 ? eps : 1;
      const epLabel = epsN > 1 ? `<b>${epsN}편</b>(${epsN}부작 시리즈 — 한 편씩 제작)` : '<b>1편</b>';
      const sceneLabel = T
        ? (out === 'wan' ? `편당 총 <b>${T}장면</b> = 🎬 움직임 ${moving} + 🖼 사진 ${T - moving}` : `편당 총 <b>${T}장면</b> (🖼 전부 사진)`)
        : '장면 수는 시나리오를 만들면 정해져요';
      sum.innerHTML = `🎬 <b>만들 결과</b> — ${orient === 'landscape' ? '가로' : '세로'} ${dur}초 영상 ${epLabel}<br>· ${sceneLabel}<br>· 나레이션 ${narr ? '켜짐' : '끔'} · 배경음악 ${bgm ? '켜짐' : '끔'}${moving ? ' · <b style="color:#e8612b">영화 제작(과금)</b>' : ''}`;
    }
    markTableMoving(moving);
  }
  // 시나리오 표의 각 장면에 🎬(움직임)/🖼(사진) 표시 — 어느 장면이 움직이는지 눈으로 보이게.
  function markTableMoving(moving) {
    document.querySelectorAll('#cr-tbody tr').forEach((tr) => {
      const i = Number(tr.dataset.i);
      const numCell = tr.querySelector('.cr-scene-num');
      if (!numCell) return;
      numCell.innerHTML = out === 'wan'
        ? `${i + 1}<span class="cr-mv" title="${i < moving ? '영화' : '사진'}">${i < moving ? '🎬' : '🖼'}</span>`
        : `${i + 1}`;
    });
  }

  $('cr-genres').addEventListener('click', (e) => { const b = e.target.closest('.cr-chip'); if (!b) return; const g = b.dataset.g; if (genres.includes(g)) genres = genres.filter((x) => x !== g); else genres.push(g); renderGenres(); save(); });
  $('cr-eps').addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (!b) return; eps = Number(b.dataset.e); renderSegs(); save(); });
  $('cr-dur').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (!b) return; dur = Number(b.dataset.d); renderSegs(); save(); });
  $('cr-orient').addEventListener('click', (e) => { const b = e.target.closest('[data-o]'); if (!b) return; orient = b.dataset.o; renderSegs(); save(); });
  $('cr-style').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; style = b.dataset.s; renderSegs(); save(); });
  $('cr-out').addEventListener('click', (e) => { const b = e.target.closest('[data-out]'); if (!b) return; out = b.dataset.out; renderSegs(); save(); });
  $('cr-clips').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; clips = Number(b.dataset.c); if ($('cr-clip-saved')) $('cr-clip-saved').textContent = ''; renderSegs(); save(); });
  $('cr-engine').addEventListener('click', (e) => { const b = e.target.closest('[data-eng]'); if (!b) return; engine = b.dataset.eng; renderSegs(); save(); });
  // 영화 장면 수 직접 입력 + 저장 — 프리셋(1~6) 말고 원하는 수(1~20)를 넣고 '저장' 누르면 '저장되었습니다'.
  function saveClips() {
    const raw = Number($('cr-clip-custom')?.value);
    const s = $('cr-clip-saved');
    if (!Number.isFinite(raw) || raw < 1) { if (s) { s.style.color = '#e0410a'; s.textContent = '1~20 사이 숫자를 넣어주세요.'; } return; }
    clips = Math.max(1, Math.min(20, Math.round(raw)));
    renderSegs(); // 프리셋 버튼 활성/요약·표 아이콘 갱신
    const T = totalScenes();
    if (s) { s.style.color = '#2bb673'; s.textContent = T && clips > T ? `✅ 저장되었습니다 — 단, 총 ${T}장면뿐이라 ${T}장면까지만 움직여요.` : `✅ 저장되었습니다 — 영화 장면 ${clips}개로 만들어요.`; }
    save();
  }
  $('cr-clip-save')?.addEventListener('click', saveClips);
  $('cr-clip-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveClips(); } });

  // ── 편 수·길이 직접 입력 + 저장 — 프리셋(버튼) 말고 원하는 숫자를 넣고 '저장'하면 "저장되었습니다" 팝업. ──
  //   서버 한계와 동일하게 편수 1~20, 길이 15~180초로 클램프(그 밖 입력은 안내).
  function saveSettings() {
    const epsRaw = ($('cr-eps-custom')?.value || '').trim();
    const durRaw = ($('cr-dur-custom')?.value || '').trim();
    if (epsRaw !== '') {
      const v = Number(epsRaw);
      if (!Number.isFinite(v) || v < 1 || v > 20) { toast('편 수는 1~20 사이 숫자를 넣어주세요.', false); return; }
      eps = Math.max(1, Math.min(20, Math.round(v)));
    }
    if (durRaw !== '') {
      const v = Number(durRaw);
      if (!Number.isFinite(v) || v < 15 || v > 180) { toast('길이는 15~180초 사이 숫자를 넣어주세요.', false); return; }
      dur = Math.max(15, Math.min(180, Math.round(v)));
    }
    renderSegs(); save();
    toast(`✅ 저장되었습니다\n${eps > 1 ? eps + '부작 시리즈' : '단편 1개'} · 편당 ${dur}초`);
  }
  $('cr-setting-save')?.addEventListener('click', saveSettings);
  $('cr-eps-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSettings(); } });
  $('cr-dur-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSettings(); } });
  $('cr-narr').addEventListener('change', (e) => { narr = e.target.checked; updatePlan(); save(); });
  $('cr-bgm').addEventListener('change', (e) => { bgm = e.target.checked; updatePlan(); save(); });
  $('cr-brief').addEventListener('input', save);

  // ── 상태 저장/복원(탭 이동·새로고침·기기 바꿔도 유지) ──
  const KEY = 'onvideo-create-state';
  function save() {
    try { syncTableToScenario(); localStorage.setItem(KEY, JSON.stringify({genres, dur, orient, style, out, clips, narr, bgm, voice, engine, brief: $('cr-brief').value, scenario, eps, bible, epScenarios, epProduced, curEp})); } catch {}
  }
  function restore() {
    let s; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (!s) return;
    genres = Array.isArray(s.genres) && s.genres.length ? s.genres : genres;
    dur = s.dur || dur; orient = s.orient || orient; style = s.style || style;
    out = s.out === 'wan' ? 'wan' : 'image'; clips = s.clips || clips;
    narr = s.narr !== false; bgm = s.bgm !== false; voice = s.voice || ''; engine = s.engine === 'gpt' ? 'gpt' : 'free';
    eps = s.eps || 1; bible = s.bible || null; epScenarios = Array.isArray(s.epScenarios) ? s.epScenarios : []; epProduced = Array.isArray(s.epProduced) ? s.epProduced : []; curEp = s.curEp || 0;
    $('cr-brief').value = s.brief || ''; $('cr-narr').checked = narr; $('cr-bgm').checked = bgm;
    renderGenres(); renderSegs(); // 복원된 장르·편수·길이를 칩/세그/직접입력칸에 반영(안 하면 기본값으로 보였다)
    if (eps > 1 && bible) { renderSeriesBar(); scenario = epScenarios[curEp] || null; if (scenario) renderTable(); }
    else if (s.scenario && s.scenario.scenes) { scenario = s.scenario; renderTable(); }
  }

  // ── 목소리 목록 로드(영상만들기와 동일 /api/categories) → 창작 select 채움 ──
  async function loadVoices() {
    try {
      const res = await fetch('/api/categories');
      if (!res.ok) return;
      const d = await res.json();
      if (!Array.isArray(d.voices)) return;
      window.__voices = d.voices;
      const useName = { issue: '📰 이슈·미스터리', info: '💡 정보·건강', sell: '🛍️ 판매·리뷰', heal: '🌿 힐링·음식·여행', anime: '🎨 애니·동화·키즈' };
      const grouped = {};
      for (const v of d.voices) (grouped[v.use[0]] = grouped[v.use[0]] || []).push(v);
      let html = '<option value="">🎯 카테고리 자동 추천</option>';
      for (const key of ['issue', 'info', 'sell', 'heal', 'anime']) {
        if (!grouped[key]) continue;
        html += `<optgroup label="${useName[key]}">` + grouped[key].map((v) => `<option value="${v.id}">${v.label} (${v.gender})</option>`).join('') + '</optgroup>';
      }
      const sel = $('cr-voice'); if (!sel) return;
      sel.innerHTML = html;
      sel.value = voice || '';
      const showTip = () => { const v = (window.__voices || []).find((x) => x.id === voice); if ($('cr-voice-state')) $('cr-voice-state').textContent = v ? v.tip : ''; };
      sel.onchange = () => { voice = sel.value; showTip(); save(); };
      showTip();
    } catch {}
  }

  // ── 시나리오 생성(단편/시리즈) ──
  const briefBody = () => ({genre: genres.join(' '), keywords: genres, brief: $('cr-brief').value.trim(), duration: dur, orientation: orient, imageStyle: style, premiumScript: engine === 'gpt'});
  $('cr-gen').onclick = $('cr-regen').onclick = async () => {
    if (!genres.length && !$('cr-brief').value.trim()) { $('cr-gen-state').textContent = '장르나 키워드를 하나 이상 골라주세요.'; return; }
    $('cr-gen').disabled = true;
    try {
      if (eps > 1) {
        // 시리즈: ①스토리 바이블 ②1편 시나리오
        bible = null; epScenarios = []; epProduced = []; curEp = 0;
        $('cr-gen-state').textContent = `📖 ${eps}부작 세계관·인물 설계 중…`;
        const mb = await runJob('/api/create-bible', {...briefBody(), episodes: eps}, {phase: `📖 ${eps}부작 설계`, working: '세계관·인물 설계 중…', estSec: 22});
        bible = mb.bible;
        renderSeriesBar();
        await genEpisode(0);
      } else {
        bible = null; epScenarios = []; epProduced = [];
        $('cr-gen-state').textContent = '✍️ 시나리오 집필 중…';
        const m = await runJob('/api/create-scenario', briefBody(), {phase: '✍️ 시나리오 집필', working: '시나리오 집필 중…', estSec: 18});
        scenario = m.storyboard; $('cr-series-bar').classList.add('hidden'); renderTable();
        $('cr-gen-state').textContent = '✅ 시나리오 완성 — 표에서 고친 뒤 아래에서 제작하세요.'; save();
        $('cr-step2').scrollIntoView({behavior: 'smooth', block: 'start'});
      }
    } catch (e) { $('cr-gen-state').textContent = '⚠️ ' + e.message; }
    finally { $('cr-gen').disabled = false; }
  };

  // 바이블을 seriesBible 문자열로 — 각 편 생성 시 연속성 유지용.
  function bibleText() {
    if (!bible) return '';
    const cast = (bible.cast || []).map((c) => `- ${c.name}: ${c.look}${c.desc ? ' / ' + c.desc : ''}`).join('\n');
    const epl = (bible.episodes || []).map((e) => `${e.n}편: ${e.logline}`).join('\n');
    return `제목: ${bible.seriesTitle || ''}\n[세계관]\n${bible.world || ''}\n[등장인물]\n${cast}\n[편별 줄거리]\n${epl}`;
  }
  // N편(0-base) 시나리오 생성 → epScenarios[i]에 저장.
  async function genEpisode(i) {
    curEp = i; renderSeriesBar();
    if (epScenarios[i]) { scenario = epScenarios[i]; renderTable(); return; }
    $('cr-gen-state').textContent = `✍️ ${i + 1}편 시나리오 집필 중…`;
    const logline = (bible.episodes && bible.episodes[i]) ? bible.episodes[i].logline : '';
    const m = await runJob('/api/create-scenario', {...briefBody(), seriesBible: bibleText(), episode: i + 1, episodesTotal: eps, episodeLogline: logline}, {phase: `✍️ ${i + 1}편 집필`, working: `${i + 1}편 집필 중…`, estSec: 18});
    // 제목에 시리즈·편 표기(제작·작업내역에서 'N편'으로 구분).
    m.storyboard.title = `[${bible.seriesTitle || '시리즈'}] ${i + 1}편 · ${m.storyboard.title || ''}`.trim();
    epScenarios[i] = m.storyboard; scenario = m.storyboard; renderTable();
    $('cr-gen-state').textContent = `✅ ${i + 1}편 완성 — 표에서 고치고 제작하세요. ${i + 1 < eps ? '아래 편 탭에서 다음 편도 집필할 수 있어요.' : ''}`;
    save(); $('cr-step2').scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  // 시리즈 편 탭 렌더.
  function renderSeriesBar() {
    const bar = $('cr-series-bar');
    if (eps <= 1 || !bible) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('cr-series-title').textContent = `📖 ${bible.seriesTitle || '시리즈'} · 전 ${eps}편`;
    $('cr-ep-tabs').innerHTML = Array.from({length: eps}, (_, i) => {
      const done = epProduced[i] ? ' ✅' : (epScenarios[i] ? ' ✍️' : '');
      return `<button type="button" class="cr-chip${i === curEp ? ' active' : ''}" data-ep="${i}">${i + 1}편${done}</button>`;
    }).join('');
    $('cr-ep-tabs').querySelectorAll('[data-ep]').forEach((b) => b.onclick = async () => { $('cr-gen').disabled = true; try { await genEpisode(Number(b.dataset.ep)); } catch (e) { $('cr-gen-state').textContent = '⚠️ ' + e.message; } finally { $('cr-gen').disabled = false; } });
  }

  // ── 편집 표 ──
  const cell = (v) => `<td contenteditable>${esc(v)}</td>`;
  function renderTable() {
    if (!scenario || !scenario.scenes) return;
    $('cr-step2').classList.remove('hidden'); $('cr-step3').classList.remove('hidden');
    $('cr-title').value = scenario.title || ''; $('cr-music').value = scenario.musicPrompt || '';
    $('cr-tbody').innerHTML = scenario.scenes.map((s, i) => `<tr data-i="${i}">
      <td class="cr-scene-num">${i + 1}</td>${cell(s.shot || '')}${cell((s.characters || []).join(', '))}${cell(s.hookTop || '')}${cell(s.hookAccent || '')}${cell(s.narration || '')}${cell(s.visualPrompt || '')}
    </tr>`).join('');
    updatePlan(); // 총 장면 수가 정해졌으니 설계 요약·표 아이콘 갱신
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
  function startTick() {
    stopTick(); startTs = startTs || Date.now();
    tickTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startTs) / 1000);
      let txt = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      // ★멈춤 감지 — 서버에서 새 로그가 안 오는 시간을 센다. 20초 넘게 조용하면 '멈춤 의심'을 눈에 띄게 알린다
      //   (테리: "15분째 이 상태인데 진행 중인지 멈췄는지 모르겠다"). 서버 렌더 로그는 4초마다 오므로, 그게
      //   끊기면 진짜 멈춘 것 → 바로 표시된다.
      const quiet = (curJobId && lastLogAt) ? Math.floor((Date.now() - lastLogAt) / 1000) : 0;
      if (quiet >= 20) txt += ` · ⚠️ ${quiet}초째 새 소식 없음(무거운 단계 처리 중이거나 멈춤일 수 있어요)`;
      $('cr-elapsed').textContent = txt;
    }, 1000);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  // ── 범용 작업 실행(진행 패널+에너지바+실시간 로그) — 시나리오 집필·바이블 설계에 사용. 결과는 done 페이로드로 받는다.
  //   LLM 대기는 중간 진행값이 없어 '조용'하므로, 예상시간(estSec) 기준으로 바를 90%까지 부드럽게 채우고
  //   로그가 올 때마다 살짝 점프시킨다(테리: "얼마나 걸리는지 몰라 답답" → 멈춰있지 않게).
  function runJob(url, body, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      $('cr-progress').classList.remove('hidden');
      $('cr-result-block').classList.add('hidden');
      $('cr-log').innerHTML = ''; setEnergy(6, '시작…');
      $('cr-phase').textContent = opts.phase || '집필';
      $('cr-stop').classList.add('hidden'); // 집필은 짧아 중단 버튼 없음
      startTs = Date.now(); startTick();
      const est = (opts.estSec || 18) * 1000;
      let bumped = 0;
      const creep = setInterval(() => {
        const byTime = Math.min(88, (Date.now() - startTs) / est * 88);
        setEnergy(Math.max(byTime, bumped), opts.working || '집필 중…');
      }, 400);
      const fail = (msg) => { clearInterval(creep); stopTick(); setEnergy(100, '실패'); addLog('⚠️ ' + msg); reject(new Error(msg)); };
      fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
        .then((r) => r.json().then((d) => ({ok: r.ok, d})))
        .then(({ok, d}) => {
          if (!ok || !d.id) return fail(d.error || '시작 실패');
          const es = new EventSource('/api/progress?id=' + d.id);
          es.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.log) { addLog(m.log); bumped = Math.min(88, bumped + 14); setEnergy(bumped, opts.working || '집필 중…'); }
            if (m.done) {
              es.close(); clearInterval(creep); stopTick();
              if (m.error) return fail(m.error);
              setEnergy(100, '완성! 🎉');
              resolve(m);
            }
          };
          es.onerror = () => {}; // EventSource 자동 재연결(네트워크 블립). done에서 명시적으로 닫음.
        })
        .catch((e) => fail(e.message));
    });
  }

  // ── 본인 얼굴 업로드(선택) — 올리면 전 장면을 이 얼굴로(server가 faceRef로 받아 pipeline이 처리) ──
  let faceImage = '';
  const faceEl = $('cr-face');
  if (faceEl) faceEl.onchange = () => {
    const f = faceEl.files && faceEl.files[0];
    if (!f) { faceImage = ''; $('cr-face-preview').innerHTML = ''; return; }
    const rd = new FileReader();
    rd.onload = () => {
      faceImage = String(rd.result || '');
      $('cr-face-preview').innerHTML = `<img src="${faceImage}" alt="얼굴" style="height:72px;border-radius:10px;border:1.5px solid var(--edline);vertical-align:middle"/> <button type="button" id="cr-face-clear" class="ghost-btn small">✕ 제거</button>`;
      const c = $('cr-face-clear'); if (c) c.onclick = () => { faceImage = ''; faceEl.value = ''; $('cr-face-preview').innerHTML = ''; };
    };
    rd.readAsDataURL(f);
  };

  // ── 제작 ──
  $('cr-make').onclick = async () => {
    syncTableToScenario();
    if (!scenario || !scenario.scenes || !scenario.scenes.length) { alert('먼저 시나리오를 만들어 주세요.'); return; }
    save();
    shownResultId = null; clearTimeout(resultTimer); // 새 제작 — 이전 결과카드 가드·5분 타이머 초기화(새 완성작이 제대로 뜨고, 옛 타이머가 새 카드를 숨기지 않게)
    $('cr-progress').classList.remove('hidden'); $('cr-result-block').classList.add('hidden');
    $('cr-log').innerHTML = ''; setEnergy(6, '시작…'); $('cr-make').disabled = true; $('cr-stop').classList.remove('hidden');
    $('cr-phase').textContent = '제작 준비'; startTs = Date.now(); startTick();
    try {
      const r = await fetch('/api/create-produce', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storyboard: scenario, duration: dur, orientation: orient, imageStyle: style, aiClips: out === 'wan' ? clips : 0, narration: narr, bgm, voice: voice || undefined, faceImage: faceImage || undefined})});
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
      if (m.log) {
        addLog(m.log); n++;
        const mm = m.log.match(/^\[([^\]]+)\]/); if (mm) $('cr-phase').textContent = mm[1];
        lastLogAt = Date.now(); // 하트비트용(멈춤 감지)
        // ★렌더 % 로그가 오면 그걸 에너지바에 직접 반영(렌더=마지막 단계 → 바의 70~99% 구간).
        //   예전엔 로그 '줄 수'로만 올려서 렌더가 길면 92%에 멈춘 듯 보였다 → 이제 실제 % + 프레임 수가 라벨에.
        const rm = m.log.match(/\[렌더\]\s*(\d+)%(?:[^\(]*\(([^\)]*프레임[^\)]*)\))?/);
        if (rm) {
          const rp = Number(rm[1]);
          setEnergy(70 + Math.min(29, rp * 0.29), `🎬 최종 합성 ${rp}%` + (rm[2] ? ` · ${rm[2]}` : ''));
        } else {
          setEnergy(Math.min(68, 10 + n * 3), '제작 중…');
        }
      }
      if (m.done) {
        es.close(); curES = null; curJobId = null; stopTick();
        try { localStorage.removeItem('onvideo-create-job'); } catch {}
        $('cr-make').disabled = false; $('cr-stop').classList.add('hidden'); refreshGpu();
        if (m.error) { setEnergy(100, m.error.includes('중단') ? '중단됨' : '실패'); addLog('⚠️ ' + m.error); return; }
        setEnergy(100, '완성! 🎉');
        const pid = m.projectId || (m.clips && m.clips[0] && m.clips[0].projectId);
        if (eps > 1 && bible) { epProduced[curEp] = pid; renderSeriesBar(); save(); }
        showResult(pid, m.title);
        loadHistory();
      }
    };
    es.onerror = () => { es.close(); if (curES === es) curES = null; };
  }

  // ── 결과 카드(크게보기·다운로드·유튜브·인스타) ──
  function showResult(projectId, title) {
    const box = $('cr-result-block'); if (!box) return;
    // ★중복표시 가드 — syncCurrentJob이 4초마다 done 상태로 이 함수를 다시 부른다. 같은 완성작이면 재렌더·재스크롤
    //   하지 않는다(안 그러면 4초마다 화면이 결과카드로 끌려 내려가 스크롤이 안 됨 — 테리: "강제로 하단으로 끌고간다").
    const key = projectId || '_done';
    if (key === shownResultId) return;
    shownResultId = key;
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
    // ★껍데기 5분 뒤 자동 정리 — 영상은 이미 포폴·작업 내역에 저장됐으니, 이 결과카드는 5분만 유지하고 비운다.
    //   (5분 동안은 재생·다운로드·업로드 전부 멀쩡히 동작. 중복표시 가드 덕에 이 타이머는 리셋되지 않는다.)
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { box.classList.add('hidden'); box.innerHTML = ''; }, 5 * 60 * 1000);
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
  renderGenres(); renderSegs(); restore(); loadVoices(); loadHistory();
  syncCurrentJob(); setInterval(syncCurrentJob, 4000);
})();
