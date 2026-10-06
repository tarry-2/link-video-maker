const $ = (id) => document.getElementById(id);

// 이미지·영상 롱프레스/우클릭 메뉴(공유·저장) 차단
document.addEventListener('contextmenu', (e) => {
  if (e.target && /^(IMG|VIDEO)$/.test(e.target.tagName)) e.preventDefault();
});

// ★한 번에 영상 하나만 재생 — 카드 결과와 studio 편집기 영상이 동시에 돌아 BGM이 섞이는 문제 방지.
document.addEventListener('play', (e) => {
  if (e.target.tagName !== 'VIDEO') return;
  document.querySelectorAll('video').forEach((v) => { if (v !== e.target && !v.paused) v.pause(); });
}, true);

let selectedPreset = null;
let mode = 'auto'; // auto | topic | manual
let uploadedImages = []; // dataURL 배열

// ── 탭 전환 ──
$('tab-auto').onclick = () => setMode('auto');
$('tab-topic').onclick = () => setMode('topic');
$('tab-manual').onclick = () => setMode('manual');
$('tab-batch').onclick = () => setMode('batch');
$('tab-card').onclick = () => setMode('card');
function applyMode(m) {
  mode = m;
  for (const t of ['auto', 'topic', 'manual', 'batch', 'card']) {
    $('tab-' + t)?.classList.toggle('active', m === t);
    $('pane-' + t)?.classList.toggle('hidden', m !== t);
  }
  // 하이라이트 pane은 상단 네비(뷰)로만 켜짐 — 생성 소탭엔 없음.
  $('pane-highlight')?.classList.toggle('hidden', m !== 'highlight');
  // 배치·하이라이트 모드에선 공용 제작 버튼 숨김(자체 생성 버튼 사용).
  const gen = $('generate'); if (gen) gen.classList.toggle('hidden', m === 'batch' || m === 'highlight');
  // 카드 모드일 땐 오른쪽 studio 편집기를 숨긴다(카드는 studio 시스템을 안 쓰므로 혼란 방지).
  document.querySelector('.app-grid')?.classList.toggle('card-mode', m === 'card');
  // 작업 내역 완전 분리 — 영상 모드=영상 내역 / 카드 모드=카드 내역(서로 숨김).
  $('video-history-section')?.classList.toggle('hidden', m === 'card');
  $('card-history-section')?.classList.toggle('hidden', m !== 'card');
  if (m !== 'card') $('card-editor')?.classList.add('hidden'); // 카드모드 벗어나면 편집창 닫기
  if (m === 'card') loadCardHistory();
  // 카드 모드는 대본 검토 단계가 없어 버튼 라벨을 바로 제작으로.
  if (gen) gen.textContent = m === 'card' ? '🎴 카드 대본 만들기' : '🎬 영상 만들기';
  // 공용 세부설정은 영상계열(auto/topic/manual/batch)에서만. 카드·하이라이트는 자체 설정이라 숨김.
  const selfSettings = m === 'card' || m === 'highlight';
  $('detail-settings')?.classList.toggle('hidden', selfSettings);
  // 오른쪽 안내: 카드 모드=카드 안내, 그 외=영상 안내(preview-hint). 서로 숨겨 :has()가 꼬이지 않게.
  $('card-hint')?.classList.toggle('hidden', m !== 'card');
  $('preview-hint')?.classList.toggle('hidden', m === 'card');
  // 영상 종류(움직임)·오디오 토글은 카드·하이라이트 모드에선 숨김(자체 설정).
  $('advanced-row')?.classList.toggle('hidden', selfSettings);
  $('audio-row')?.classList.toggle('hidden', selfSettings);
  if (m === 'batch' && typeof window.startBatchPoll === 'function') window.startBatchPoll();
  // ★하이라이트는 상단 네비의 독립 '뷰' — 생성 소탭(.tabs)·히어로를 숨겨 전용 화면처럼 보인다.
  //   🔴 app-right는 통째로 숨기면 진행상황·로그·결과(progress-block/result-block)까지 사라져 "생성해도 반응없음"이 됨.
  //      → app-right는 두고, 그 안의 '미리보기 안내(preview-hint)'만 숨긴다. 진행/결과는 보여야 함.
  const hl = m === 'highlight';
  document.querySelector('.tabs')?.classList.toggle('hidden', hl);
  document.querySelector('.app-grid')?.classList.toggle('highlight-mode', hl); // 왼쪽이 전체폭(카드 안 짜부라지게)
  if (hl) {
    $('preview-hint')?.classList.add('hidden'); // 하이라이트는 영상 미리보기 안내 불필요
    $('progress-block')?.classList.remove('hidden'); // 로그 패널 처음부터 보이게(생성 전부터)
    // 처음 진입 시 안내 로그 한 줄(이미 로그가 있으면 건드리지 않음 = 초기화 전까지 유지)
    if ($('log') && !$('log').children.length) { setCardEnergy(0, '준비됨 — 나라·주제를 고르고 영상을 선택하세요'); hlLog('🎬 유튜브 하이라이트 준비됨. 나라와 주제를 골라 재사용 영상을 찾아보세요.'); }
  }
  $('video-history-section')?.classList.toggle('hidden', hl || m === 'card'); // 하이라이트 뷰에선 영상 내역도 숨김
  $('nav-make')?.classList.toggle('active', !hl);
  $('nav-highlight')?.classList.toggle('active', hl);
  const hero = document.querySelector('.page-head .hero');
  if (hero) hero.textContent = hl ? '유튜브 하이라이트' : '주제나 링크만 넣으면 영상이 완성돼요';
  const sub = document.querySelector('.page-head .sub');
  if (sub) sub.textContent = hl ? '저작권 걱정 없는 재사용 영상에서 터질 순간만 뽑아 숏폼으로. 상단 후킹·자동 업로드까지.' : '대본·이미지·음성·자막·배경음악까지 자동으로. 세부 설정은 안 건드려도 됩니다.';
}
function setMode(m) { applyMode(m); saveFormState(); }

// ── 주제 추천(링크·이미지 없이) ──
// 추천 결과 렌더(저장된 상태 복원에도 재사용). selected=이전에 고른 주제 제목.
function renderTopics(topics, selected) {
  const list = $('topic-list');
  window.__topics = topics || [];
  list.innerHTML = (topics || []).map((t) =>
    `<button class="topic-item" type="button" data-title="${(t.title || '').replace(/"/g, '&quot;')}">${t.title || ''}${t.why ? `<span class="topic-why">${t.why}</span>` : ''}</button>`
  ).join('');
  list.querySelectorAll('.topic-item').forEach((b) => b.addEventListener('click', () => {
    list.querySelectorAll('.topic-item').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('topic-input').value = b.dataset.title;
    saveFormState();
  }));
  if (selected) {
    const sel = [...list.querySelectorAll('.topic-item')].find((b) => b.dataset.title === selected);
    if (sel) sel.classList.add('active');
  }
}
$('topic-fetch')?.addEventListener('click', async () => {
  const st = $('topic-state'), list = $('topic-list');
  st.textContent = '요즘 잘 되는 주제 찾는 중…';
  list.innerHTML = '';
  try {
    const r = await fetch('/api/topics?preset=' + encodeURIComponent(selectedPreset || ''));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '실패');
    if (!d.topics || !d.topics.length) { st.textContent = '추천 결과가 없어요. 다시 시도해 주세요.'; return; }
    st.textContent = '마음에 드는 주제를 누르세요 (다시 누르면 새 주제).';
    renderTopics(d.topics);
    saveFormState();
  } catch (e) { st.textContent = e.message; }
});

// ── 카드뉴스: 주제 추천(기존 /api/topics 재사용) ──
$('card-topic-fetch')?.addEventListener('click', async () => {
  const st = $('card-topic-state'), list = $('card-topic-list');
  st.textContent = '요즘 잘 되는 주제 찾는 중…'; list.innerHTML = '';
  try {
    const r = await fetch('/api/topics?preset=' + encodeURIComponent(selectedPreset || ''));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '실패');
    if (!d.topics || !d.topics.length) { st.textContent = '추천 결과가 없어요.'; return; }
    st.textContent = '마음에 드는 주제를 누르세요.';
    list.innerHTML = (d.topics || []).map((t) =>
      `<button class="topic-item" type="button" data-title="${(t.title || '').replace(/"/g, '&quot;')}">${t.title || ''}${t.why ? `<span class="topic-why">${t.why}</span>` : ''}</button>`).join('');
    list.querySelectorAll('.topic-item').forEach((b) => b.addEventListener('click', () => {
      list.querySelectorAll('.topic-item').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); $('card-topic').value = b.dataset.title;
    }));
  } catch (e) { st.textContent = e.message; }
});
// 카드 배경이 '업로드'일 때만 파일 선택 노출.
$('card-bg')?.addEventListener('change', (e) => {
  $('card-images').classList.toggle('hidden', e.target.value !== 'upload');
  if (e.target.value !== 'upload') { cardImages = []; $('card-thumbs').innerHTML = ''; }
});
let cardImages = [];
$('card-images').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 12);
  cardImages = []; $('card-thumbs').innerHTML = '';
  for (const f of files) {
    const durl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    cardImages.push(durl);
    const img = document.createElement('img'); img.src = durl; $('card-thumbs').appendChild(img);
  }
};

// ── 이미지 업로드 ──
$('images').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 20);
  uploadedImages = [];
  $('thumbs').innerHTML = '';
  for (const f of files) {
    const durl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(f);
    });
    uploadedImages.push(durl);
    const img = document.createElement('img');
    img.src = durl;
    $('thumbs').appendChild(img);
  }
  saveFormState();
};

// ── 카테고리 · 목소리 로드 ──
async function loadCategories() {
  const res = await fetch('/api/categories');
  if (!res.ok) return; // 비로그인(401) 등 — 로그인 후 재호출된다.
  const d = await res.json();
  if (!Array.isArray(d.voices) || !Array.isArray(d.presets)) return;

  // 목소리 셀렉트 — 용도 그룹으로(optgroup). 카테고리 고르면 자동 추천이 기본.
  window.__voices = d.voices;
  const useName = { issue: '📰 이슈·미스터리', info: '💡 정보·건강', sell: '🛍️ 판매·리뷰', heal: '🌿 힐링·음식·여행', anime: '🎨 애니·동화·키즈 (밝고 명랑)' };
  const grouped = {};
  for (const v of d.voices) (grouped[v.use[0]] = grouped[v.use[0]] || []).push(v);
  let html = '<option value="">🎯 카테고리 자동 추천</option>';
  for (const key of ['issue', 'info', 'sell', 'heal', 'anime']) {
    if (!grouped[key]) continue;
    html += `<optgroup label="${useName[key]}">`;
    html += grouped[key].map((v) => `<option value="${v.id}">${v.label} (${v.gender})</option>`).join('');
    html += '</optgroup>';
  }
  $('voice').innerHTML = html;
  document.dispatchEvent(new Event('onvideo-auth-ready'));
  // 선택 시 팁 표시
  $('voice').onchange = () => {
    const v = (window.__voices || []).find((x) => x.id === $('voice').value);
    $('voice-state').textContent = v ? v.tip : '';
    saveFormState();
  };

  // 카테고리 그룹별 칩
  const groups = {};
  window.__presets = d.presets;
  for (const p of d.presets) (groups[p.group] = groups[p.group] || []).push(p);
  const wrap = $('categories');
  wrap.innerHTML = '';
  for (const [g, items] of Object.entries(groups)) {
    const box = document.createElement('div');
    box.innerHTML = `<div class="cat-group-title">${g}</div>`;
    const chips = document.createElement('div');
    chips.className = 'cat-chips';
    for (const p of items) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.dataset.preset = p.id;
      b.textContent = `${p.emoji} ${p.label}`;
      b.onclick = () => {
        document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        selectedPreset = p.id;
        // 카테고리 고르면 어울리는 이미지 스타일 자동 선택(애니 카테고리=애니 등). ✨추천 배지도 갱신.
        if (p.recommendStyle) setStyle(p.recommendStyle);
        renderStyleGallery();
        syncCharacterRow();
        saveFormState();
      };
      chips.appendChild(b);
    }
    box.appendChild(chips);
    wrap.appendChild(box);
  }
  // 이미지 스타일 갤러리(느낌 골라쓰기) — 서버 레지스트리(real·anime·칠판·화이트보드·인포·클레이…)
  window.__styles = Array.isArray(d.styles) ? d.styles : [];
  renderStyleGallery();

  restoreFormState(); // 카테고리·목소리가 채워진 뒤 저장된 입력 복원
  // 상단 네비 '유튜브 하이라이트'로 들어오면(?view=highlight) 저장된 모드보다 우선해 하이라이트 뷰로.
  try { if (new URLSearchParams(location.search).get('view') === 'highlight') setModeSilent('highlight'); } catch {}
  loadCharacters();
}

// 스타일 카드 갤러리 렌더(그룹별 + 이름+느낌 + 카테고리 추천 ✨배지). 클릭 시 hidden #image-style 값 세팅.
function renderStyleGallery() {
  const wrap = $('style-gallery');
  if (!wrap || !window.__styles || !window.__styles.length) return;
  const cur = $('image-style') ? $('image-style').value : 'real';
  const preset = (window.__presets || []).find((p) => p.id === selectedPreset);
  const rec = preset && preset.recommendStyle; // 선택한 카테고리가 추천하는 스타일
  wrap.innerHTML = '';
  const groups = {};
  for (const s of window.__styles) (groups[s.group] = groups[s.group] || []).push(s);
  for (const [g, items] of Object.entries(groups)) {
    const title = document.createElement('div');
    title.className = 'cat-group-title';
    title.textContent = g;
    wrap.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'style-grid';
    for (const s of items) {
      const b = document.createElement('button');
      b.className = 'style-card' + (s.id === cur ? ' active' : '');
      b.type = 'button';
      b.dataset.style = s.id;
      const recTag = s.id === rec ? '<span class="sc-rec">✨추천</span>' : '';
      b.innerHTML = `<span class="sc-name">${s.emoji} ${s.name}${recTag}</span><span class="sc-desc">${s.desc}</span>`;
      b.onclick = () => setStyle(s.id);
      grid.appendChild(b);
    }
    wrap.appendChild(grid);
  }
  updateStyleCurrent();
}
// 스타일 선택 — hidden input 값 세팅 + 카드 하이라이트 + 트리거 라벨 갱신 + 모달 닫기 + change 발생.
function setStyle(id) {
  const inp = $('image-style');
  if (!inp) return;
  inp.value = id;
  document.querySelectorAll('#style-gallery .style-card').forEach((c) => c.classList.toggle('active', c.dataset.style === id));
  updateStyleCurrent();
  inp.dispatchEvent(new Event('change'));
  $('style-modal')?.classList.add('hidden'); // 고르면 팝업 닫기
}
// 폼의 "현재 스타일" 트리거 라벨을 선택값으로 갱신(세로로 안 늘어지게 갤러리는 팝업에만).
function updateStyleCurrent() {
  const el = $('style-current');
  if (!el) return;
  const id = $('image-style') ? $('image-style').value : 'real';
  const s = (window.__styles || []).find((x) => x.id === id);
  el.textContent = s ? `${s.emoji} ${s.name}` : '📷 실사';
}
// 스타일 팝업 열고/닫기(네 UI 취향=기능을 팝업으로 분산).
$('style-open')?.addEventListener('click', () => $('style-modal')?.classList.remove('hidden'));
$('style-close')?.addEventListener('click', () => $('style-modal')?.classList.add('hidden'));
$('style-modal')?.addEventListener('click', (e) => { if (e.target.id === 'style-modal') $('style-modal').classList.add('hidden'); });

// 🎴 카드 작업 내역 — 영상 내역과 완전 분리. 내가 만든 카드(영상·게시물)만 포트폴리오에서 추려 보여줌.
async function loadCardHistory() {
  const box = $('card-history');
  if (!box) return;
  try {
    const d = await (await fetch('/api/portfolio', {cache: 'no-store'})).json();
    const items = (Array.isArray(d.items) ? d.items : [])
      .filter((it) => it.kind === 'mine' && (it.media === 'card' || it.media === 'card-post'));
    box.innerHTML = items.length ? items.map((it) => {
      const isPost = it.media === 'card-post';
      const badge = isPost ? '🖼 카드 게시물' : '🎬 카드 영상';
      const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
      const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
      const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
      const action = isPost
        ? `<a class="ghost-btn small" href="/voices?tab=pf" target="_blank" rel="noopener">📂 포트폴리오</a>`
        : `<a class="ghost-btn small" href="${esc2(it.video)}" download="${esc2(it.title)}.mp4">⬇ 다운로드</a>`;
      return `<div class="history-item" data-card-id="${esc2(it.id)}" data-title="${esc2(it.title)}" data-media="${esc2(it.media)}"><span><strong>${esc2(it.title)}</strong><small>${esc2(when)} · ${badge}${yt}${ig}</small></span><span class="hi-actions"><button type="button" class="ghost-btn small" data-reset="${esc2(it.id)}">⟳ 다시 세팅</button>${action}</span></div>`;
    }).join('') : '<p class="mini-state">아직 만든 카드가 없어요. 카드뉴스를 만들어보세요.</p>';
  } catch {
    box.innerHTML = '<p class="mini-state">카드 작업 내역을 불러오지 못했어요.</p>';
  }
}
$('card-history-refresh')?.addEventListener('click', () => loadCardHistory());
// 카드 작업 내역 클릭 → 그 카드를 만든 설정으로 폼 '다시 세팅'(영상 작업내역처럼 다시 만들 수 있게).
$('card-history')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reset]');
  if (!btn) return;
  const row = btn.closest('[data-card-id]');
  applyCardSettings(btn.dataset.reset, row?.dataset.title || '', row?.dataset.media || '');
});
// 저장된 카드 설정(projectId별)을 폼에 복원. 없으면 제목·출력종류만이라도 채워 다시 만들 수 있게.
function applyCardSettings(id, title, media) {
  setMode('card');
  let body = null;
  try { body = JSON.parse(localStorage.getItem('onvideo-card-' + id) || 'null'); } catch {}
  if (!body) body = {topic: title, output: media === 'card-post' ? 'post' : 'video'};
  if ($('card-topic')) $('card-topic').value = body.topic || title || '';
  if (body.count && $('card-count')) $('card-count').value = body.count;
  setCardOutput(body.output || (media === 'card-post' ? 'post' : 'video'));
  if (body.bg && $('card-bg')) { $('card-bg').value = body.bg; $('card-bg').dispatchEvent(new Event('change')); }
  if ($('card-narration') && typeof body.narration === 'boolean') $('card-narration').checked = body.narration;
  if ($('card-bgm') && typeof body.bgm === 'boolean') $('card-bgm').checked = body.bgm;
  if (body.motion && $('card-motion')) $('card-motion').value = body.motion;
  if (body.cardTheme && $('card-theme')) $('card-theme').value = body.cardTheme;
  if (body.voice != null && $('voice')) $('voice').value = body.voice;
  if (body.imageStyle) setStyle(body.imageStyle);
  if (body.presetId) {
    selectedPreset = body.presetId;
    const chip = document.querySelector('.chip[data-preset="' + body.presetId + '"]');
    if (chip) { document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active'); }
  }
  saveFormState();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

// ── 캐릭터 풀(애니 주인공) ──
async function loadCharacters() {
  const sel = $('character-select');
  if (!sel) return;
  try {
    const d = await (await fetch('/api/characters', {cache: 'no-store'})).json();
    const cur = sel.value;
    sel.innerHTML = '<option value="">🎲 랜덤 (이야기에 맞게 매번 새 캐릭터)</option>' +
      (d.characters || []).map((c) => `<option value="${c.id}">${c.emoji} ${c.name}</option>`).join('');
    if (cur) sel.value = cur;
    updateCharacterThumb();
  } catch {}
}
function updateCharacterThumb() {
  const sel = $('character-select'), thumb = $('character-thumb');
  if (!sel || !thumb) return;
  if (sel.value) { thumb.src = `/api/characters/${encodeURIComponent(sel.value)}/image`; thumb.style.display = ''; }
  else thumb.style.display = 'none';
}
// 애니일 때만 캐릭터 선택 노출
function syncCharacterRow() {
  const row = $('character-row');
  if (row) row.style.display = ($('image-style')?.value === 'anime') ? 'flex' : 'none';
}
$('image-style')?.addEventListener('change', () => { syncCharacterRow(); saveFormState(); });
$('character-select')?.addEventListener('change', () => { updateCharacterThumb(); saveFormState(); });
$('character-new')?.addEventListener('click', async () => {
  const name = prompt('캐릭터 이름? (예: 토끼 몽이)');
  if (name === null) return;
  const description = prompt('캐릭터 생김새를 적어주세요\n(예: 곱슬머리 7살 남자아이, 파란 멜빵바지, 환하게 웃는)');
  if (!description || !description.trim()) return;
  const btn = $('character-new'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '만드는 중…';
  try {
    const r = await fetch('/api/characters', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, description})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '생성 실패');
    await loadCharacters();
    $('character-select').value = d.id; updateCharacterThumb(); saveFormState();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});

// 목소리 미리듣기는 '🎙 목소리 듣기' 탭(/voices)으로 분리됨 — 생성화면은 선택만.

// ── 영상 생성 ──
$('generate').onclick = async () => {
  let endpoint, body;
  if (mode === 'card') {
    const topic = $('card-topic').value.trim();
    if (!topic) { alert('카드뉴스 주제를 입력하세요.'); return; }
    const bg = $('card-bg').value;
    if (bg === 'upload' && !cardImages.length) { alert('배경으로 쓸 이미지를 올리거나 다른 배경을 고르세요.'); return; }
    endpoint = '/api/generate-cards';
    body = {
      topic,
      count: Number($('card-count').value),
      bg,
      images: bg === 'upload' ? cardImages : undefined,
      narration: $('card-narration').checked,
      bgm: $('card-bgm').checked,
      presetId: selectedPreset,
      voice: $('voice').value,
      imageStyle: $('image-style') ? $('image-style').value : 'real',
    };
  } else if (mode === 'auto' || mode === 'topic') {
    // 주제 추천 모드도 링크 대신 주제를 /api/generate로 보냄(url 자리에 주제).
    const url = mode === 'topic' ? $('topic-input').value.trim() : $('url').value.trim();
    if (!url) { alert(mode === 'topic' ? '주제를 입력하거나 추천에서 고르세요.' : '링크를 입력하세요.'); return; }
    endpoint = '/api/generate';
    body = {
      url,
      duration: Number($('duration').value),
      presetId: selectedPreset,
      voice: $('voice').value,
      quality: $('quality').value,
      imageStyle: $('image-style') ? $('image-style').value : 'real',
      aiClips: Number($('aiClips').value),
      autoShutdown: $('auto-shutdown') ? $('auto-shutdown').checked : true,
      narration: $('v-narration') ? $('v-narration').checked : true,
      bgm: $('v-bgm') ? $('v-bgm').checked : true,
    };
  } else {
    if (!uploadedImages.length) { alert('이미지를 넣어주세요.'); return; }
    endpoint = '/api/generate-manual';
    body = {
      images: uploadedImages,
      keywords: $('keywords').value.trim(),
      facts: $('facts').value.trim(),
      duration: Number($('duration').value),
      presetId: selectedPreset,
      voice: $('voice').value,
    };
  }
  $('generate').disabled = true;
  $('progress-block').classList.remove('hidden');
  $('result-block').classList.add('hidden');
  $('log').textContent = '';

  let id;
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    id = d.id;
  } catch (e) {
    addLog('[실패] ' + e.message, 'fail');
    $('generate').disabled = false;
    return;
  }

  // SSE 진행로그 — 화면 내렸다 와도 이어지게 재연결 지원.
  attachProgress(id, true);
};

// 카드 출력 형태 토글(영상/게시물).
let cardOutput = 'video';
function setCardOutput(o) {
  cardOutput = o;
  $('card-out-video').classList.toggle('active', o === 'video');
  $('card-out-post').classList.toggle('active', o === 'post');
  // 게시물은 오디오(나레이션·BGM) 불필요 → 숨김.
  $('card-audio-row').classList.toggle('hidden', o === 'post');
  $('card-audio-hint').classList.toggle('hidden', o === 'post');
  $('card-out-hint').textContent = o === 'post'
    ? '카드별 이미지 여러 장 → 인스타 게시물(손가락으로 넘기는 카드뉴스)로 올려요.'
    : '자동으로 넘어가는 세로 영상 1개 → 릴스/쇼츠에 올려요.';
}
$('card-out-video')?.addEventListener('click', () => { setCardOutput('video'); saveFormState(); });
$('card-out-post')?.addEventListener('click', () => { setCardOutput('post'); saveFormState(); });

// ── 카드뉴스 생성(studio.js의 generate가 버튼을 덮으므로, 카드 모드는 이 함수로 처리) ──
let cardPlanBody = null, cardEditStoryboard = null;
window.startCardGen = async function () {
  const topic = $('card-topic').value.trim();
  if (!topic) { alert('카드뉴스 주제를 입력하세요.'); return; }
  const bg = $('card-bg').value;
  if (bg === 'upload' && !cardImages.length) { alert('배경으로 쓸 이미지를 올리거나 다른 배경을 고르세요.'); return; }
  const body = {
    topic, count: Number($('card-count').value), output: cardOutput, bg,
    images: bg === 'upload' ? cardImages : undefined,
    narration: $('card-narration').checked, bgm: $('card-bgm').checked,
    presetId: selectedPreset, voice: $('voice').value,
    imageStyle: $('image-style') ? $('image-style').value : 'real',
    motion: $('card-motion') ? $('card-motion').value : 'auto',
    cardTheme: $('card-theme') ? $('card-theme').value : 'light',
  };
  cardPlanBody = body;
  // 1단계: 대본만 생성 → 편집(렌더 전에 문구 수정). 이미지·디자인은 제작 때 자동.
  const ed = $('card-editor');
  $('generate').disabled = true;
  if (ed) { ed.classList.remove('hidden'); ed.innerHTML = '<p class="mini-state">카드 대본 만드는 중… ✍️</p>'; ed.scrollIntoView({behavior: 'smooth', block: 'start'}); }
  try {
    const r = await fetch('/api/card-plan', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({topic, count: body.count, presetId: body.presetId, imageStyle: body.imageStyle})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '대본 생성 실패');
    renderCardEditor(d.storyboard);
  } catch (e) {
    if (ed) ed.innerHTML = `<p class="mini-state">대본 생성 실패: ${esc2(e.message)}</p>`;
  } finally { $('generate').disabled = false; }
};
const CARD_TYPE_NAME = {cover: '표지', number: '큰 숫자', list: '리스트', quote: '인용', compare: '비교', fix: '실수vs해결', body: '본문', closing: '마무리', checklist: '체크리스트', step: '단계', qa: 'Q&A', stat: '통계'};
const CARD_EDIT_FIELDS = [['badge', '뱃지'], ['big', '큰 제목'], ['small', '작은 윗줄'], ['number', '숫자'], ['unit', '단위'], ['title', '제목'], ['before', '전(Before)'], ['after', '후(After)'], ['wrong', '흔한 실수'], ['right', '올바른 방법'], ['body', '본문']];
// 카드 대본 편집 화면 렌더(타입별로 있는 문구만 수정 가능하게).
function renderCardEditor(sb) {
  cardEditStoryboard = sb;
  const ed = $('card-editor'); if (!ed || !sb) return;
  const cardsHtml = (sb.cards || []).map((c, i) => {
    const fields = CARD_EDIT_FIELDS.filter(([k]) => c[k] != null && c[k] !== '').map(([k, label]) => {
      const val = esc2(c[k]);
      return k === 'body'
        ? `<label class="ce-field"><span>${label}</span><textarea data-ci="${i}" data-ck="${k}" rows="2">${val}</textarea></label>`
        : `<label class="ce-field"><span>${label}</span><input data-ci="${i}" data-ck="${k}" value="${val}" /></label>`;
    }).join('');
    const itemsHtml = Array.isArray(c.items) && c.items.length
      ? `<label class="ce-field"><span>리스트(줄바꿈으로 구분)</span><textarea data-ci="${i}" data-ck="items" rows="${c.items.length}">${esc2(c.items.join('\n'))}</textarea></label>` : '';
    return `<div class="ce-card"><div class="ce-type">${i + 1}. ${CARD_TYPE_NAME[c.type] || c.type}</div>${fields}${itemsHtml}</div>`;
  }).join('');
  ed.innerHTML = `<div class="modal-head"><h3 class="block-title">✍️ 카드 대본 편집</h3><span class="badge">${(sb.cards || []).length}장</span></div>
    <p class="hint">문구를 고친 뒤 제작하세요. 이미지·디자인·배경음악은 제작할 때 자동으로 입혀져요.</p>
    ${cardsHtml}
    <button id="card-make" class="primary-btn" type="button" style="margin-top:14px">✅ 이대로 카드 제작</button>`;
  $('card-make').onclick = () => { if (cardPlanBody) runCardGen({...cardPlanBody, storyboard: collectCardEditor()}); };
  ed.scrollIntoView({behavior: 'smooth', block: 'start'});
}
// 편집 입력값을 대본 객체로 되모으기(type·accent·visualPrompt 등은 원본 유지).
function collectCardEditor() {
  const sb = JSON.parse(JSON.stringify(cardEditStoryboard));
  document.querySelectorAll('#card-editor [data-ci]').forEach((el) => {
    const i = Number(el.dataset.ci), k = el.dataset.ck;
    if (!sb.cards[i]) return;
    if (k === 'items') sb.cards[i].items = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else sb.cards[i][k] = el.value;
  });
  return sb;
}
// ★이어서 다시 만들기 — 마지막 카드 생성 설정을 저장(새로고침에도)해두고, 멈추거나 실패하면 그대로 재생성.
//   (카드는 영상 studio처럼 '완료단계부터'가 아니라, 같은 설정으로 다시 돌리는 방식)
function saveLastCardBody(body) { try { localStorage.setItem('onvideo-lastcard', JSON.stringify(body)); } catch {} }
function loadLastCardBody() { try { return JSON.parse(localStorage.getItem('onvideo-lastcard') || 'null'); } catch { return null; } }
async function runCardGen(body) {
  saveLastCardBody(body);
  $('card-editor')?.classList.add('hidden'); // 제작 시작하면 편집창 닫기
  $('progress-block').classList.remove('hidden');
  $('result-block').classList.add('hidden');
  $('post-result').classList.add('hidden');
  if ($('card-resume')) $('card-resume').classList.add('hidden');
  if ($('log')) $('log').textContent = '';
  const en = $('card-energy'); if (en) en.classList.add('anim');
  cardPct = 0; cardStartTs = Date.now(); cardJobStart = null;
  try {
    const r = await fetch('/api/generate-cards', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '실패');
    attachProgress(d.id, true);
  } catch (e) { addLog('[실패] ' + e.message, 'fail'); showCardResume(); }
}
// 실패/중단 시 '이어서 다시 만들기' 버튼 노출.
let lastHlBody = null; // 하이라이트 마지막 설정(이어서하기용)
function showCardResume() {
  const b = $('card-resume'); if (!b) return;
  if (!lastHlBody && !loadLastCardBody()) return; // 하이라이트·카드 둘 중 재시작할 게 있어야 표시
  b.classList.remove('hidden');
}
$('card-resume')?.addEventListener('click', () => {
  // 하이라이트 작업이 마지막이면 그 설정으로 재시작, 아니면 카드 재시작.
  if (lastHlBody) { runHighlightGen(lastHlBody); return; }
  const b = loadLastCardBody(); if (b) runCardGen(b);
});
// 하이라이트 재시작(이어서하기) — 마지막 설정으로 다시 생성.
async function runHighlightGen(body) {
  if ($('card-resume')) $('card-resume').classList.add('hidden');
  hlLog('⟳ 같은 설정으로 다시 시작합니다…');
  setCardEnergy(8, '다시 시작하는 중…');
  try {
    const d = await (await fetch('/api/generate-highlights', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})).json();
    if (d.error) { hlLog('[실패] ' + d.error, 'fail'); showCardResume(); return; }
    if (d.id) attachProgress(d.id, true);
  } catch (e) { hlLog('[실패] ' + e.message, 'fail'); showCardResume(); }
}
// 게시물 결과 렌더(이미지 그리드 + ZIP).
window.showPostResult = function (title, images, zip, projectId) {
  $('post-result').classList.remove('hidden');
  $('post-title').textContent = title || '';
  $('post-grid').innerHTML = (images || []).map((rel, i) =>
    `<div class="post-card"><img src="/api/card-img/${encodeURIComponent(rel)}" alt="카드 ${i + 1}" /><span>${i + 1}</span></div>`).join('');
  if (zip) { $('post-zip').href = '/api/cards-zip/' + zip; $('post-zip').classList.remove('hidden'); }
  else $('post-zip').classList.add('hidden');
  cardUpId = projectId || null;
  $('cp-actions').classList.toggle('hidden', !cardUpId);
};

// ── 진행 로그 SSE(재연결 가능) — 화면 내림/백그라운드로 끊겨도 복귀 시 자동 이어짐 ──
//   제작은 서버에서 계속 돌고, /api/progress는 재접속 시 그동안의 로그를 처음부터 다시 준다.
let curJobId = null, curES = null, reconnTries = 0, logJobId = null, logCount = 0, shownDoneId = null;
// ── 카드 진행 UX(영상과 동일): 경과시간 ⏱ · 에너지바 · 완성 폭죽 ──
let cardStartTs = 0, cardTimer = null, cardPct = 0, cardJobStart = null;
function cardElapsedText() { if (!cardStartTs) return ''; const s = Math.floor((Date.now() - cardStartTs) / 1000); const m = Math.floor(s / 60); return '⏱ ' + (m ? m + '분 ' : '') + (s % 60) + '초'; }
function cardTick() { clearTimeout(cardTimer); const n = $('card-elapsed'); if (!n) return; n.textContent = cardElapsedText(); cardTimer = setTimeout(cardTick, 1000); }
let cardLabel = '시작하는 중…';
function setCardEnergy(pct, label) {
  cardPct = Math.max(cardPct, Math.round(pct));
  if (label) cardLabel = label;
  const f = $('card-energy'); if (f) f.style.width = cardPct + '%';
  const l = $('card-energy-label'); if (l) l.textContent = cardPct + '% · ' + cardLabel; // ★영상처럼 퍼센트 표시
}
function cardEnergyFromLog(line) {
  const ph = $('card-phase'); const set = (t) => { if (ph) ph.textContent = t; };
  const im = line.match(/\[배경 (\d+)\/(\d+)\]/) || line.match(/카드 (\d+)\/(\d+) 이미지/);
  if (/\[대본\]/.test(line)) { setCardEnergy(14, '대본 짜는 중…'); set('대본'); }
  else if (/\[디자인\]/.test(line)) { setCardEnergy(18, '디자인 고르는 중…'); set('디자인'); }
  else if (im) { const i = +im[1], N = +im[2]; setCardEnergy(Math.round(20 + (i / N) * 48), `이미지 ${i}/${N} 만드는 중…`); set('이미지'); }
  else if (/\[음성\]/.test(line)) { setCardEnergy(74, '나레이션 만드는 중…'); set('나레이션'); }
  else if (/\[BGM\]/.test(line)) { setCardEnergy(80, '배경음악 만드는 중…'); set('배경음악'); }
  else if (/\[렌더\]/.test(line)) { setCardEnergy(88, '영상 합치는 중…'); set('렌더'); }
  else if (/\[게시물\]/.test(line)) { setCardEnergy(90, '카드 이미지 만드는 중…'); set('게시물'); }
  else if (/\[저장\]/.test(line)) { setCardEnergy(95, '클라우드 저장 중…'); set('저장'); }
}
function cardCelebrate() {
  const c = document.createElement('div'); c.className = 'confetti';
  const colors = ['#17b5a4', '#7c5cff', '#ff4d8d', '#FFE24B', '#ff8a5c', '#4fe0d0'];
  for (let i = 0; i < 90; i++) { const bit = document.createElement('i'); bit.style.left = Math.random() * 100 + '%'; bit.style.background = colors[i % colors.length]; bit.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's'; bit.style.animationDuration = (2.2 + Math.random() * 1.3).toFixed(2) + 's'; c.appendChild(bit); }
  document.body.appendChild(c); setTimeout(() => c.remove(), 4200);
}
function attachProgress(id, freshLog) {
  curJobId = id;
  try { localStorage.setItem('onvideo-genjob', id); } catch {}
  if (curES) { try { curES.close(); } catch {} curES = null; }
  // ★로그는 '다른 작업'으로 바뀔 때만 비운다. 같은 작업 재연결에선 절대 지우지 않고(서버가 처음부터
  //   전체를 재전송하므로) 아래 recv 카운터로 중복만 걸러 이어붙인다 → 끊김/재연결에도 로그가 안 사라진다.
  //   (freshLog 인자는 더 이상 로그 삭제에 쓰지 않는다. 테리 지시: 로그는 수동 초기화 전엔 절대 사라지면 안 됨.)
  //   단 하이라이트 모드는 생성 전 프론트 로그(검색·선택)를 이미 쌓아놨으므로 비우지 않고 이어붙인다.
  if (id !== logJobId) { logJobId = id; logCount = 0; if ($('log') && mode !== 'highlight') $('log').textContent = ''; }
  // 새 작업이면 경과시간·진행률 리셋(재연결이면 유지).
  if (cardJobStart !== id) { cardJobStart = id; cardStartTs = Date.now(); cardPct = 0; setCardEnergy(6, '시작하는 중…'); }
  $('progress-block').classList.remove('hidden');
  $('generate').disabled = true;
  cardTick();
  let recv = 0; // 이번 연결에서 받은 로그 줄 수 — logCount 이하(이미 표시됨)는 건너뛴다.
  const es = new EventSource('/api/progress?id=' + id);
  curES = es;
  es.onmessage = (ev) => {
    reconnTries = 0;
    const m = JSON.parse(ev.data);
    if (m.log) {
      recv++;
      if (recv > logCount) { // 새 줄만 추가(로그 유실·중복 둘 다 방지)
        addLog(m.log, m.log.includes('[완료]') ? 'done' : m.log.includes('[실패]') ? 'fail' : '');
        cardEnergyFromLog(m.log);
        // 움직이는영상 GPU가 켜지거나(생성 시작) 꺼질 때(팟 종료) 상단 배지를 바로 갱신해 과금상태를 눈에 보이게.
        if (/움직이는 영상|GPU|팟/.test(m.log)) refreshRunpod();
        logCount = recv;
      }
    }
    if (m.done) {
      es.close(); curES = null; curJobId = null;
      shownDoneId = id; // 이 결과는 이 기기에서 이미 표시함 → syncCurrentJob 중복표시 방지
      clearTimeout(cardTimer);
      refreshRunpod(); // 작업 끝났으니 GPU가 꺼졌는지(자동종료) 배지로 바로 확인시켜준다.
      try { localStorage.removeItem('onvideo-genjob'); } catch {}
      $('generate').disabled = false;
      if (m.error) { setCardEnergy(cardPct, '실패'); showCardResume(); }
      else {
        cardPct = 100; setCardEnergy(100, '완성! 🎉'); const f = $('card-energy'); if (f) f.classList.remove('anim');
        cardCelebrate();
      }
      if (m.kind === 'highlight') { showHighlightResults(m.clips || []); }
      else if (m.kind === 'post') { if (window.showPostResult) window.showPostResult(m.title, m.images, m.zip, m.projectId); }
      else if (m.file) showResult(m.file, m.title, m.projectId);
      if (!m.error) {
        // 이 카드를 만든 설정을 projectId로 저장 → 작업 내역에서 '다시 세팅'으로 복원.
        if (m.projectId) { try { const lb = loadLastCardBody(); if (lb) localStorage.setItem('onvideo-card-' + m.projectId, JSON.stringify(lb)); } catch {} }
        loadCardHistory(); // 완성된 카드가 카드 작업 내역에 바로 뜨게
      }
    }
  };
  es.onerror = () => {
    es.close(); if (curES === es) curES = null;
    if (curJobId === id && reconnTries < 12) {
      reconnTries++;
      setTimeout(() => { if (curJobId === id && !curES) attachProgress(id, true); }, 2500);
    } else if (curJobId === id) {
      // 재연결을 여러 번 실패 — 서버에 작업이 없음(배포로 인한 재시작 등)일 수 있다.
      // ★조용히 멈추지 않는다: 로그는 그대로 두고(절대 안 지움) 상황을 명확히 알린다.
      const wasCard = (typeof mode !== 'undefined' && mode === 'card');
      curJobId = null; try { localStorage.removeItem('onvideo-genjob'); } catch {}
      $('generate').disabled = false;
      clearTimeout(cardTimer);
      addLog('[연결 끊김] 진행 연결이 끊겼습니다(서버 업데이트·네트워크 등). 제작이 서버에서 완료됐을 수도 있으니 작업 내역을 확인하거나 다시 시작해 주세요. (로그는 유지됩니다)', 'fail');
      if (wasCard) showCardResume();
    }
  };
}
// 화면 복귀 시 끊겼던 연결 재개
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && curJobId && !curES) { reconnTries = 0; attachProgress(curJobId, true); }
});
// 페이지 다시 열었을 때 진행 중이던 작업 자동 복원 + (없으면) 서버의 현재 진행 작업에 붙어 모바일↔PC 실시간 공유
async function syncCurrentJob() {
  if (curJobId || curES) return; // 이미 보고 있으면 패스
  try {
    const local = localStorage.getItem('onvideo-genjob');
    if (local) { attachProgress(local, true); return; }
    const r = await fetch('/api/jobs/current');
    if (!r.ok) return;
    const d = await r.json();
    if (d.id) { attachProgress(d.id, true); return; } // 다른 기기(모바일/PC)가 시작한 작업을 그대로 이어 봄
    // ★다른 기기에서 방금 완성된 결과를 이 기기에도 표시(PC↔모바일 완성본 연동, 한 번만).
    if (d.done && d.done.id && d.done.id !== shownDoneId) {
      shownDoneId = d.done.id;
      if (d.done.kind === 'post') { if (window.showPostResult) window.showPostResult(d.done.title, d.done.images, d.done.zip, d.done.projectId); }
      else if (d.done.file) showResult(d.done.file, d.done.title, d.done.projectId);
    }
  } catch {}
}
syncCurrentJob();
// ★유휴 상태면 6초마다 서버 진행작업 확인 → 다른 기기에서 시작하면 여기서도 실시간으로 뜬다.
setInterval(syncCurrentJob, 6000);

function addLog(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  // 모든 로그 줄에 실시간 시각[HH:MM:SS] 표시(테리 요구). 서버 로그도 이 함수로 들어오므로 전부 시각 찍힘.
  const now = new Date();
  const ts = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}] `;
  line.textContent = ts + text;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}
// 하이라이트 프론트 동작 로그 — 생성 누르기 전(검색·선택 등)부터 실시간으로 쌓인다. 초기화 전까지 유지.
function hlLog(text, cls) {
  $('progress-block')?.classList.remove('hidden'); // 로그 패널 항상 보이게
  addLog(text, cls);
}

// 유튜브 하이라이트 여러 편 결과 — 각 편 미리보기 + 유튜브/인스타 업로드(포폴 엔드포인트 재사용).
function showHighlightResults(clips) {
  let box = document.getElementById('hl-result-block');
  if (!box) {
    box = document.createElement('div'); box.id = 'hl-result-block'; box.className = 'card';
    box.style.marginTop = '16px';
    $('result-block').parentNode.insertBefore(box, $('result-block'));
  }
  box.classList.remove('hidden');
  if (!clips.length) { box.innerHTML = '<p class="mini-state">완성된 클립이 없어요.</p>'; return; }
  box.innerHTML = `<h2 style="margin:0 0 4px">🎬 하이라이트 ${clips.length}편 완성!</h2>
    <p class="mini-state" style="margin-bottom:12px">각 편을 확인하고 유튜브·인스타로 바로 올릴 수 있어요. (원작자 출처는 자동 표기됩니다)</p>
    <div class="hl-result-grid">${clips.map((c, i) => `
      <div class="hl-result-item">
        <video src="/portfolio-item/${c.projectId}.mp4#t=0.5" controls playsinline preload="metadata" style="width:100%;border-radius:12px;background:#000"></video>
        <b style="display:block;margin:6px 0">${(c.title || ('하이라이트 ' + (i + 1)))}</b>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="ghost-btn small" href="/portfolio-item/${c.projectId}.mp4" download="${(c.title || 'highlight')}.mp4">⬇ 다운로드</a>
          <button class="ghost-btn small hl-yt" data-id="${c.projectId}">📺 유튜브</button>
          <button class="ghost-btn small hl-ig" data-id="${c.projectId}">📷 인스타</button>
        </div>
      </div>`).join('')}</div>`;
  box.querySelectorAll('.hl-yt').forEach((b) => b.onclick = () => { cardVidUpId = b.dataset.id; cardYouTube(b); });
  box.querySelectorAll('.hl-ig').forEach((b) => b.onclick = () => cardInstagram(b, b.dataset.id, false));
  box.scrollIntoView({behavior: 'smooth'});
}

function showResult(file, title, projectId) {
  $('result-block').classList.remove('hidden');
  $('result-title').textContent = title || '';
  const src = '/api/video/' + file;
  const v = $('result-video');
  v.src = src;
  // ★재생 전 미리보기가 빈 화면(카드영상은 첫 프레임=글자 애니 전 배경만)으로 보이는 문제 →
  //   우리 커버 썸네일(글자+그림)을 poster로 깔아 재생 전에도 내용이 보이게.
  if (projectId) { v.setAttribute('poster', '/portfolio-thumb/' + projectId + '.png'); v.setAttribute('preload', 'metadata'); }
  else v.removeAttribute('poster');
  $('download').href = src;
  $('download').setAttribute('download', (title || 'onvideo') + '.mp4');
  cardVidUpId = projectId || null;
  $('cv-actions').classList.toggle('hidden', !cardVidUpId);
  syncFormat();
  $('result-block').scrollIntoView({ behavior: 'smooth' });
}

// ── 카드 완료 화면 업로드(영상처럼) — projectId로 유튜브/인스타. 포폴과 같은 엔드포인트 재사용 ──
let cardVidUpId = null, cardUpId = null;
function cardModal(innerHtml, wire) {
  let box = document.getElementById('card-up-modal');
  if (!box) { box = document.createElement('div'); box.id = 'card-up-modal'; document.body.appendChild(box); }
  box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:60';
  box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto">${innerHtml}</div>`;
  const close = () => box.remove();
  box.onclick = (e) => { if (e.target === box || e.target.closest('[data-x="close"]')) close(); };
  wire(box, close);
  return box;
}
const esc2 = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function cardYouTube(btn) {
  const id = cardVidUpId; if (!id) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '📺 준비 중…';
  try {
    const st = await (await fetch('/api/youtube/status')).json();
    if (!st.connected) { alert('먼저 ⚙ 키 설정에서 유튜브 계정을 연결하세요.'); return; }
    btn.textContent = '📺 제목·설명 만드는 중…';
    const r = await fetch('/api/youtube/meta/' + encodeURIComponent(id)); const meta = await r.json();
    if (!r.ok) throw new Error(meta.error || '메타 생성 실패');
    cardModal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📺 유튜브 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <label class="field-label">제목<input id="cu-t" class="input" maxlength="100" value="${esc2(meta.title || '')}"></label>
      <label class="field-label">설명<textarea id="cu-d" class="input" rows="5" maxlength="4900">${esc2(meta.description || '')}</textarea></label>
      <label class="field-label">태그<input id="cu-tags" class="input" value="${esc2((meta.tags || []).join(', '))}"></label>
      <label class="field-label">공개<select id="cu-p" class="input"><option value="public">바로 공개</option><option value="unlisted">미등록</option><option value="private">비공개</option></select></label>
      <button class="primary-btn" data-up="1">유튜브에 올리기</button><p id="cu-msg" class="mini-state"></p>`,
      (box) => { box.querySelector('[data-up]').onclick = async (ev) => {
        const up = ev.target; up.disabled = true; up.textContent = '올리는 중…';
        try {
          const rr = await fetch('/api/youtube/upload/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: box.querySelector('#cu-t').value, description: box.querySelector('#cu-d').value, tags: box.querySelector('#cu-tags').value.split(',').map(s => s.trim()).filter(Boolean), privacy: box.querySelector('#cu-p').value }) });
          const d = await rr.json(); if (!rr.ok) throw new Error(d.error || '업로드 실패');
          box.querySelector('#cu-msg').innerHTML = `✅ 완료! <a href="${d.url}" target="_blank" style="color:var(--teal)">${d.url}</a>`; up.textContent = '완료 🎉';
        } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '유튜브에 올리기'; }
      }; });
  } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
}
async function cardInstagram(btn, id, carousel) {
  if (!id) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
  try {
    const st = await (await fetch('/api/instagram/status')).json();
    if (!st.connected) { alert('먼저 ⚙ 키 설정에서 인스타 계정을 연결하세요.'); return; }
    btn.textContent = '📷 캡션 만드는 중…';
    const r = await fetch('/api/instagram/caption/' + encodeURIComponent(id)); const d = await r.json();
    if (!r.ok) throw new Error(d.error || '캡션 생성 실패');
    cardModal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📷 인스타 ${carousel ? '캐러셀 올리기' : '올리기'}</h2><button class="ghost-btn" data-x="close">✕</button></div>
      ${carousel ? '<p class="sub small">🎴 손가락으로 넘기는 게시물(캐러셀)로 올라갑니다.</p>' : `<label class="field-label">방식<select id="cu-k" class="input"><option value="reels">릴스(세로 쇼츠)</option><option value="feed">피드 영상</option></select></label>`}
      <label class="field-label">캡션·해시태그<textarea id="cu-c" class="input" rows="7" maxlength="2200">${esc2(d.caption || '')}</textarea></label>
      <button class="primary-btn" data-up="1">인스타에 올리기</button><p id="cu-msg" class="mini-state">${carousel ? '이미지 변환·업로드에 잠시 걸려요.' : '릴스는 1~2분 걸릴 수 있어요.'}</p>`,
      (box) => { box.querySelector('[data-up]').onclick = async (ev) => {
        const up = ev.target; up.disabled = true; up.textContent = '올리는 중…'; box.querySelector('#cu-msg').textContent = '처리 중…';
        try {
          const rr = carousel
            ? await fetch('/api/instagram/upload-carousel/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caption: box.querySelector('#cu-c').value }) })
            : await fetch('/api/instagram/upload/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: box.querySelector('#cu-k').value, caption: box.querySelector('#cu-c').value }) });
          const dd = await rr.json(); if (!rr.ok) throw new Error(dd.error || '업로드 실패');
          box.querySelector('#cu-msg').innerHTML = dd.permalink ? `✅ 완료! <a href="${dd.permalink}" target="_blank" style="color:var(--teal)">인스타에서 열기</a>` : '✅ 게시 완료!'; up.textContent = '완료 🎉';
        } catch (e) { box.querySelector('#cu-msg').textContent = '실패: ' + e.message; up.disabled = false; up.textContent = '인스타에 올리기'; }
      }; });
  } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = orig; }
}
$('cv-yt')?.addEventListener('click', (e) => cardYouTube(e.currentTarget));
$('cv-ig')?.addEventListener('click', (e) => cardInstagram(e.currentTarget, cardVidUpId, false));
$('cp-ig')?.addEventListener('click', (e) => cardInstagram(e.currentTarget, cardUpId, true));

// ── 화면비 UI 동기화: 쇼츠(<90초)=세로 9:16 / 롱폼(≥90초)=가로 16:9 ──
//   미리보기 프레임·배지·결과영상의 비율을 길이 선택에 맞춰 바꾼다(.land 클래스=가로).
function syncFormat() {
  const dur = Number($('duration')?.value || 30);
  const land = dur >= 90;
  const badge = $('ph-badge'); if (badge) badge.textContent = 'MP4 · ' + (land ? '16:9' : '9:16');
  const frame = $('ph-frame'); if (frame) frame.classList.toggle('land', land);
  const rv = $('result-video'); if (rv) rv.classList.toggle('land', land);
}
$('duration')?.addEventListener('change', syncFormat);
$('duration')?.addEventListener('input', syncFormat);
syncFormat();

// ── 유튜브 하이라이트: 나라·주제 선택 → CC 영상 쫙 → 선택 → 편수·길이 → 하이라이트 숏폼 ──
let hlPicked = null;       // 선택한 영상 {videoId, title, channel, durationSec}
let hlRegion = 'kr';       // kr | global
let hlOrder = 'viewCount'; // viewCount | date | relevance
let hlCat = '';            // 현재 선택된 카테고리 라벨(검색어 표시용)
let hlCount = 3, hlSec = 30;
function fmtDur(s) { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; }

// 나라별 카테고리 — {라벨, 한국검색어, 해외검색어}. 아주 다양하게(좁으면 툴이 쪼그라듦).
const HL_CATS = [
  {ko: '연예·스타', kq: '연예인 인터뷰', gq: 'celebrity interview'},
  {ko: '예능·토크쇼', kq: '예능 토크쇼', gq: 'talk show funny'},
  {ko: '드라마·영화', kq: '드라마 명장면', gq: 'movie scene'},
  {ko: 'K-pop·음악', kq: '케이팝 무대', gq: 'music performance live'},
  {ko: '스포츠', kq: '스포츠 하이라이트', gq: 'sports highlights'},
  {ko: '경제·재테크', kq: '경제 뉴스 재테크', gq: 'economy finance explained'},
  {ko: '시사·뉴스', kq: '뉴스 이슈', gq: 'news report'},
  {ko: 'IT·테크', kq: 'IT 리뷰 테크', gq: 'tech review'},
  {ko: '게임', kq: '게임 플레이', gq: 'gaming highlights'},
  {ko: '먹방·음식', kq: '먹방 맛집', gq: 'food mukbang'},
  {ko: '여행', kq: '여행 브이로그', gq: 'travel vlog'},
  {ko: '교육·지식', kq: '지식 교양', gq: 'educational documentary'},
  {ko: '역사', kq: '역사 이야기', gq: 'history documentary'},
  {ko: '과학', kq: '과학 다큐', gq: 'science documentary'},
  {ko: '동물·펫', kq: '동물 반려동물', gq: 'animals pets funny'},
  {ko: '자동차', kq: '자동차 리뷰', gq: 'car review'},
];
function renderHlCats() {
  const box = $('hl-cats'); if (!box) return;
  box.innerHTML = HL_CATS.map((c) => `<button type="button" class="hl-cat" data-kq="${c.kq}" data-gq="${c.gq}" data-ko="${c.ko}">${c.ko}</button>`).join('');
  box.querySelectorAll('.hl-cat').forEach((b) => b.addEventListener('click', () => {
    box.querySelectorAll('.hl-cat').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    hlCat = b.dataset.ko;
    const q = hlRegion === 'global' ? b.dataset.gq : b.dataset.kq;
    $('hl-query').value = ''; // 칩 선택 시 직접검색칸 비움
    hlLog(`📂 주제 선택: ${hlCat} (${hlRegion === 'global' ? '해외' : '한국'})`);
    hlSearch(q);
  }));
}
// 영상 길이로 뽑을 수 있는 최대 편수 제안(한 편 길이 기준). 재미없는 구간까지 긁지 않게 보수적으로.
function hlMaxClips(durationSec, clipSec) {
  // 전체의 ~40%만 하이라이트감이라 보고, 한 편 간격은 clipSec*2로 띄움. 1~10편.
  const usable = durationSec * 0.4;
  return Math.max(1, Math.min(10, Math.floor(usable / Math.max(clipSec, 20))));
}
function renderHlCountSeg() {
  const seg = $('hl-count-seg'); if (!seg || !hlPicked) return;
  const max = hlMaxClips(hlPicked.durationSec, hlSec);
  if (hlCount > max) hlCount = max;
  const opts = [];
  for (const n of [1, 2, 3, 5, 8, 10]) if (n <= max) opts.push(n);
  if (!opts.includes(max)) opts.push(max);
  seg.innerHTML = opts.map((n) => `<button type="button" class="seg-btn hl-count ${n === hlCount ? 'active' : ''}" data-n="${n}">${n}편</button>`).join('');
  seg.querySelectorAll('.hl-count').forEach((b) => b.addEventListener('click', () => {
    seg.querySelectorAll('.hl-count').forEach((x) => x.classList.remove('active')); b.classList.add('active'); hlCount = Number(b.dataset.n);
  }));
  const note = $('hl-maxnote');
  if (note) note.textContent = `— 이 영상(${fmtDur(hlPicked.durationSec)})에서 최대 ${max}편까지 추천`;
}
let hlQuery = '';          // 현재 검색어(더보기용)
let hlPageToken = '';      // 다음 페이지 토큰
let hlLoadedCount = 0;     // 지금까지 로드한 개수
// 영상 카드 하나의 HTML
function hlCardHtml(v) {
  return `<button type="button" class="hl-card" data-id="${v.videoId}" data-title="${(v.title || '').replace(/"/g, '&quot;')}" data-channel="${(v.channel || '').replace(/"/g, '&quot;')}" data-dur="${v.durationSec}">
    <img src="${v.thumb}" alt="" loading="lazy" />
    <div class="hl-meta"><b>${v.title || ''}</b><span>${v.channel || ''} · ${fmtDur(v.durationSec)} · 조회 ${Number(v.views).toLocaleString('ko-KR')}</span></div>
  </button>`;
}
// 카드 클릭(선택) 바인딩 — 추가된 카드에도 적용.
function wireHlCards(scope) {
  scope.querySelectorAll('.hl-card:not([data-wired])').forEach((b) => {
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', () => {
      $('hl-results').querySelectorAll('.hl-card').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      hlPicked = {videoId: b.dataset.id, title: b.dataset.title, channel: b.dataset.channel, durationSec: Number(b.dataset.dur) || 300};
      $('hl-options').classList.remove('hidden');
      $('hl-picked').textContent = `선택: ${hlPicked.title}`;
      renderHlCountSeg();
      hlLog(`🎥 영상 선택: ${hlPicked.title} (${fmtDur(hlPicked.durationSec)} · ${hlPicked.channel})`);
      $('hl-options').scrollIntoView({behavior: 'smooth', block: 'nearest'});
    });
  });
}
async function hlSearch(forcedQuery, append) {
  const box = $('hl-results'), st = $('hl-search-state');
  if (!append) {
    const q = (forcedQuery != null ? forcedQuery : $('hl-query').value).trim();
    if (!q) { alert('주제를 고르거나 검색어를 입력하세요.'); return; }
    hlQuery = q; hlPageToken = ''; hlLoadedCount = 0;
    box.innerHTML = ''; $('hl-options').classList.add('hidden'); hlPicked = null;
    st.textContent = `${hlRegion === 'global' ? '해외' : '한국'} 재사용 영상을 찾는 중…`;
  } else {
    st.textContent = '더 불러오는 중…';
  }
  // 기존 더보기 버튼 제거(다시 그린다)
  document.getElementById('hl-more')?.remove();
  try {
    const url = `/api/yt-search?q=${encodeURIComponent(hlQuery)}&region=${hlRegion}&order=${hlOrder}` + (hlPageToken ? `&pageToken=${hlPageToken}` : '');
    const d = await (await fetch(url)).json();
    if (d.error) { st.textContent = '⚠️ ' + d.error; return; }
    const vids = d.videos || [];
    $('hl-sort-row').classList.remove('hidden');
    hlPageToken = d.nextPageToken || '';
    hlLoadedCount += vids.length;
    if (!append && !vids.length) { st.textContent = '결과가 없어요. 다른 주제나 검색어로 시도해보세요.'; return; }
    box.insertAdjacentHTML('beforeend', vids.map(hlCardHtml).join(''));
    wireHlCards(box);
    st.textContent = `${hlLoadedCount}개 표시 중${hlPageToken ? ' — 더 있어요' : ' (끝)'} · 하나 고르세요`;
    hlLog(append ? `➕ ${vids.length}개 더 불러옴 (총 ${hlLoadedCount}개)` : `🔎 "${hlQuery}" 검색 완료 — ${hlLoadedCount}개 (${hlOrder === 'viewCount' ? '조회수순' : hlOrder === 'date' ? '최신순' : '관련도순'})`);
    // '더 보기' 버튼 — 다음 페이지 있으면 결과 목록 바로 아래에(스크롤 영역 바깥).
    if (hlPageToken) {
      const more = document.createElement('button');
      more.id = 'hl-more'; more.type = 'button'; more.className = 'ghost-btn'; more.style.cssText = 'width:100%;margin-top:10px';
      more.textContent = `▼ 더 보기 (지금 ${hlLoadedCount}개)`;
      more.onclick = () => { more.disabled = true; more.textContent = '불러오는 중…'; hlSearch(null, true); };
      box.parentNode.insertBefore(more, box.nextSibling);
    }
  } catch { st.textContent = '검색에 실패했어요. 유튜브 연결(설정)이 되어 있는지 확인하세요.'; }
}
document.querySelectorAll('.hl-region').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.hl-region').forEach((x) => x.classList.remove('active')); b.classList.add('active');
  hlRegion = b.dataset.region;
  hlLog(`🌍 나라 선택: ${hlRegion === 'global' ? '해외' : '한국'}`);
  // 나라 바꾸면 선택된 카테고리로 다시 검색(있으면).
  const activeCat = document.querySelector('.hl-cat.active');
  if (activeCat) hlSearch(hlRegion === 'global' ? activeCat.dataset.gq : activeCat.dataset.kq);
}));
document.querySelectorAll('.hl-order').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.hl-order').forEach((x) => x.classList.remove('active')); b.classList.add('active');
  hlOrder = b.dataset.order;
  // 정렬 바꾸면 현재 검색어로 재검색.
  const activeCat = document.querySelector('.hl-cat.active');
  const q = activeCat ? (hlRegion === 'global' ? activeCat.dataset.gq : activeCat.dataset.kq) : $('hl-query').value.trim();
  if (q) hlSearch(q);
}));
$('hl-search')?.addEventListener('click', () => { document.querySelector('.hl-cat.active')?.classList.remove('active'); hlSearch(); });
$('hl-query')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { document.querySelector('.hl-cat.active')?.classList.remove('active'); hlSearch(); } });
document.querySelectorAll('.hl-sec').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.hl-sec').forEach((x) => x.classList.remove('active')); b.classList.add('active'); hlSec = Number(b.dataset.s);
  renderHlCountSeg(); // 길이 바뀌면 최대 편수 재계산
}));
renderHlCats();
$('hl-generate')?.addEventListener('click', async () => {
  if (!hlPicked) { alert('먼저 영상을 고르세요.'); return; }
  const btn = $('hl-generate'); btn.disabled = true; btn.textContent = '시작하는 중…';
  // ★설정 요약 로그(테리 요구: 뭘 어떻게 만드는지 다 보이게)
  hlLog('──────── 하이라이트 제작 시작 ────────', 'done');
  hlLog(`• 나라: ${hlRegion === 'global' ? '해외' : '한국'}`);
  hlLog(`• 주제: ${hlCat || '직접 검색'}`);
  hlLog(`• 원본 영상: ${hlPicked.title}`);
  hlLog(`• 원본 길이: ${fmtDur(hlPicked.durationSec)} → 클립 ${hlSec}초짜리`);
  hlLog(`• 만들 편수: ${hlCount}편`);
  hlLog('────────────────────────────');
  setCardEnergy(8, '하이라이트 제작을 시작합니다…');
  lastHlBody = {videoId: hlPicked.videoId, title: hlPicked.title, channel: hlPicked.channel, count: hlCount, clipSec: hlSec}; // 이어서하기용
  try {
    const d = await (await fetch('/api/generate-highlights', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(lastHlBody)})).json();
    if (d.error) { hlLog('[실패] ' + d.error, 'fail'); showCardResume(); alert(d.error); return; }
    if (d.id) attachProgress(d.id, true);
  } catch (e) { hlLog('[실패] 시작 실패: ' + e.message, 'fail'); showCardResume(); alert('시작 실패: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '🎬 하이라이트 숏폼 만들기'; }
});

// 영상 종류 = 버튼(세그먼트)으로 고른다. 네이티브 select가 일부 브라우저에서 안 열려서 버튼으로 교체.
// aiClips 는 숨은 input(값: 0=사진영상, 1~3=움직이는 장면 수). '움직이는 영상'을 골랐을 때만 장면수·자동끄기 노출.
let lastMotionClips = 1; // 사진영상↔움직이는영상 오갈 때 마지막으로 고른 장면 수 기억
function setAiClips(n) {
  n = Number(n) || 0;
  if (n > 0) lastMotionClips = n;
  const hid = $('aiClips'); if (hid) hid.value = String(n);
  $('vtype-photo')?.classList.toggle('active', n === 0);
  $('vtype-motion')?.classList.toggle('active', n > 0);
  $('motion-count-row')?.classList.toggle('hidden', n === 0);
  document.querySelectorAll('.vclip-n').forEach((b) => b.classList.toggle('active', Number(b.dataset.clips) === n));
}
// 장면(이미지) 수 직접 지정 — 세그먼트 버튼. 0=자동(길이로).
function setSceneCount(n) {
  n = Number(n) || 0;
  const hid = $('scene-count'); if (hid) hid.value = String(n);
  document.querySelectorAll('.sc-n').forEach((b) => b.classList.toggle('active', Number(b.dataset.n) === n));
}
document.querySelectorAll('.sc-n').forEach((b) => b.addEventListener('click', () => { setSceneCount(Number(b.dataset.n)); saveFormState(); $('duration')?.dispatchEvent(new Event('input')); }));

$('vtype-photo')?.addEventListener('click', () => { setAiClips(0); saveFormState(); $('duration')?.dispatchEvent(new Event('input')); });
$('vtype-motion')?.addEventListener('click', () => { setAiClips(lastMotionClips); saveFormState(); $('duration')?.dispatchEvent(new Event('input')); });
document.querySelectorAll('.vclip-n').forEach((b) => b.addEventListener('click', () => { setAiClips(Number(b.dataset.clips)); saveFormState(); $('duration')?.dispatchEvent(new Event('input')); }));
setAiClips(0);

// ── 키 설정 모달 ──
const KEY_META = [
  { k: 'GEMINI_KEYS', label: 'Google Gemini (대본·이미지)', desc: '여러 개는 콤마로. 하나 소진되면 자동으로 다음 키 사용.', link: 'https://aistudio.google.com/apikey' },
  { k: 'REPLICATE_API_TOKEN', label: 'Replicate (Flux 이미지)', desc: '9:16 이미지 생성용.', link: 'https://replicate.com/account/api-tokens' },
  { k: 'ELEVENLABS_API_KEY', label: 'ElevenLabs (음성·배경음악)', desc: '나레이션과 BGM 생성.', link: 'https://elevenlabs.io/app/settings/api-keys' },
  { k: 'OPENAI_API_KEY', label: 'OpenAI (폴백 대본)', desc: 'Gemini 실패 시 대본 폴백.', link: 'https://platform.openai.com/api-keys' },
  { k: 'RUNPOD_API_KEY', label: 'RunPod (움직이는 AI 영상)', desc: 'Wan2.2 영상 클립 생성용 클라우드 GPU. "움직이는 AI 영상" 켤 때만 필요.', link: 'https://www.runpod.io/console/user/settings' },
];

$('settings-btn').onclick = async () => {
  // ★입력칸을 먼저 렌더 + 모달 먼저 표시 — reveal fetch가 실패(401 등)해도 입력칸은 무조건 뜨게.
  $('key-fields').innerHTML = KEY_META.map((m) => `
    <div class="key-field">
      <label>${m.label}</label>
      <div class="desc">${m.desc} <a href="${m.link}" target="_blank">키 발급 →</a></div>
      <div class="saved-state" data-state="${m.k}"><div class="desc">…</div></div>
      <input class="input" data-key="${m.k}" placeholder="새 키 입력(비우면 유지)" style="margin-top:6px" />
    </div>`).join('');
  $('settings-msg').textContent = '';
  if ($('yt-msg')) $('yt-msg').textContent = '';
  $('settings-modal').classList.remove('hidden');
  refreshYtStatus();
  refreshIgStatus();
  refreshRunpod();
  // 저장된 키 상태는 뒤에서 채운다(실패해도 입력엔 영향 없음).
  try {
    const reveal = await (await fetch('/api/settings/reveal')).json();
    KEY_META.forEach((m) => {
      const el = document.querySelector(`[data-state="${m.k}"]`);
      if (el) el.innerHTML = reveal && reveal[m.k]
        ? `<div class="saved">● 저장됨: ${reveal[m.k]}</div>`
        : '<div class="desc">미설정</div>';
    });
  } catch {
    document.querySelectorAll('.saved-state').forEach((el) => { el.innerHTML = '<div class="desc">미설정</div>'; });
    $('settings-msg').textContent = '저장된 키 상태는 못 불러왔지만 입력·저장은 됩니다.';
  }
};
$('settings-close').onclick = () => $('settings-modal').classList.add('hidden');

// ── RunPod(움직이는 영상 GPU) 현황: 잔액 + 실행 중 팟 + 지금 끄기 ──
// 상단 배지(gpu-badge)는 항상, 설정 모달 안 정보(runpod-info/status)는 열렸을 때 함께 갱신한다.
function setGpuBadge(state, label) {
  const b = $('gpu-badge'); if (!b) return;
  b.className = 'gpu-badge ' + state; // off=초록(과금없음) / on=빨강(과금중) / unknown=회색
  b.textContent = '● ' + label;
}
async function refreshRunpod() {
  const info = $('runpod-info'), st = $('runpod-status');
  if (info) { info.textContent = '상태 확인 중…'; if (st) st.textContent = ''; }
  try {
    const d = await (await fetch('/api/runpod/status')).json();
    if (!d.configured) {
      setGpuBadge('unknown', 'GPU 미설정');
      if (info) info.textContent = 'RunPod 키 미설정 — 위에서 키를 저장하면 잔액·상태가 표시됩니다.';
      return;
    }
    const bal = (typeof d.balance === 'number') ? ('잔액 $' + d.balance.toFixed(2)) : '잔액 조회 불가';
    const running = (d.pods || []).filter(p => p.status === 'RUNNING');
    // ★상단 배지: 꺼짐이면 초록 "GPU 꺼짐", 켜졌으면 빨강 깜빡 "GPU 켜짐(과금중)"
    if (running.length) setGpuBadge('on', `GPU 켜짐 ${running.length}대 · 과금중`);
    else setGpuBadge('off', 'GPU 꺼짐 · 과금없음');
    if (st) st.innerHTML = running.length
      ? `<span style="color:#e0a030">● GPU ${running.length}대 켜짐(과금 중)</span>`
      : '<span style="color:var(--teal)">● 꺼짐</span>';
    if (info) info.textContent = `${bal} · ${running.length ? ('켜진 GPU ' + running.length + '대 — 아래 「지금 GPU 끄기」로 중단') : 'GPU 꺼짐(과금 없음)'}`;
  } catch {
    setGpuBadge('unknown', 'GPU 확인실패');
    if (info) info.textContent = '상태를 불러오지 못했습니다.';
  }
}
// 상단 배지 클릭 = 설정 열어 GPU 섹션 보이기(끄기 버튼까지). 설정 버튼을 그대로 눌러 모달 열고 스크롤.
$('gpu-badge')?.addEventListener('click', () => {
  $('settings-btn')?.click();
  setTimeout(() => $('runpod-section')?.scrollIntoView({behavior:'smooth', block:'center'}), 150);
});
// 페이지 로드시 1회 + 1분마다 자동 갱신(제작 중이면 pollGpuFast가 더 자주 갱신).
refreshRunpod();
setInterval(refreshRunpod, 60000);
$('runpod-refresh')?.addEventListener('click', refreshRunpod);
$('runpod-stop')?.addEventListener('click', async () => {
  const msg = $('runpod-msg');
  if (!confirm('실행 중인 움직이는-영상 GPU를 모두 끌까요? (진행 중인 영상 작업이 있으면 실패할 수 있어요)')) return;
  if (msg) msg.textContent = '끄는 중…';
  try {
    const d = await (await fetch('/api/runpod/stop', {method:'POST'})).json();
    if (msg) msg.textContent = d.stopped && d.stopped.length ? `GPU ${d.stopped.length}대 껐습니다(과금 중단).` : '켜진 GPU가 없습니다.';
    refreshRunpod();
  } catch { if (msg) msg.textContent = '끄기 실패 — 잠시 후 다시 시도하세요.'; }
});

// ── 유튜브 연결 ──
async function refreshYtStatus() {
  try {
    const s = await (await fetch('/api/youtube/status')).json();
    const st = $('yt-status');
    if (s.connected) st.innerHTML = `<span style="color:var(--teal)">● 연결됨${s.channelTitle ? ' · ' + s.channelTitle : ''}</span>`;
    else if (s.hasClient) st.innerHTML = '<span style="color:#e0a030">ID/Secret 저장됨 — 계정 연결 필요</span>';
    else st.textContent = '미연결';
    $('yt-connect').disabled = !s.hasClient;
  } catch {}
}
$('yt-save-config')?.addEventListener('click', async () => {
  const clientId = $('yt-client-id').value.trim();
  const clientSecret = $('yt-client-secret').value.trim();
  if (!clientId && !clientSecret) { $('yt-msg').textContent = 'ID/Secret을 입력하세요.'; return; }
  await fetch('/api/youtube/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) });
  $('yt-msg').textContent = '저장했습니다. 이제 "유튜브 계정 연결"을 누르세요.';
  $('yt-client-id').value = ''; $('yt-client-secret').value = '';
  refreshYtStatus();
});
$('yt-connect')?.addEventListener('click', async () => {
  $('yt-msg').textContent = '구글 동의 창을 여는 중…';
  try {
    const d = await (await fetch('/api/youtube/auth')).json();
    if (!d.url) throw new Error(d.error || '연결 URL 실패');
    window.open(d.url, '_blank');
    $('yt-msg').textContent = '새 창에서 구글 로그인·허용 후, 이 창으로 돌아와 상태를 새로고침하세요.';
    setTimeout(refreshYtStatus, 4000);
  } catch (e) { $('yt-msg').textContent = e.message; }
});
// ── 인스타 연결 ──
async function refreshIgStatus() {
  const st = $('ig-status'); if (!st) return;
  try {
    const s = await (await fetch('/api/instagram/status')).json();
    if (s.connected) st.innerHTML = `<span style="color:var(--teal)">● 연결됨${s.username ? ' · @' + s.username : ''}</span>`;
    else st.textContent = '미연결';
    if (s.connected) refreshIgActivity();
  } catch {}
}
// 인스타 업로드 페이스 — 오늘 몇 개·마지막 게시 시각(실제 인스타 기준).
async function refreshIgActivity() {
  const el = $('ig-activity'); if (!el) return;
  try {
    const a = await (await fetch('/api/instagram/activity')).json();
    if (a.error) { el.innerHTML = `<span style="color:var(--muted)">📅 업로드 현황 확인 불가 — ${a.error}</span>`; return; }
    let last = '없음';
    if (a.lastAt) {
      const d = new Date(a.lastAt);
      const hhmm = d.toLocaleTimeString('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit'});
      const mins = Math.floor((Date.now() - d.getTime()) / 60000);
      const ago = mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : mins < 1440 ? `${Math.floor(mins / 60)}시간 전` : `${Math.floor(mins / 1440)}일 전`;
      last = `${hhmm} (${ago})`;
    }
    el.innerHTML = `<span style="color:var(--teal)">📅 오늘 <b>${a.today}</b>개 올림 · 마지막 게시 ${last} · 총 ${a.total}개</span>`;
  } catch {}
}
$('ig-connect')?.addEventListener('click', async () => {
  const igUserId = $('ig-user-id').value.trim();
  const accessToken = $('ig-token').value.trim();
  const base = $('ig-base').value;
  if (!igUserId || !accessToken) { $('ig-msg').textContent = '계정 ID와 토큰을 입력하세요.'; return; }
  $('ig-msg').textContent = '연결 확인 중…';
  try {
    const r = await fetch('/api/instagram/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ igUserId, accessToken, base }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '연결 실패');
    $('ig-msg').innerHTML = `<span style="color:var(--teal)">✅ 연결됐습니다 · @${d.username}</span>`;
    $('ig-token').value = '';
    refreshIgStatus();
  } catch (e) { $('ig-msg').textContent = '실패: ' + e.message; }
});
$('save-keys').onclick = async () => {
  // 1) 단가를 localStorage에 저장(studio.js가 onvideo-unit-rates에서 읽어씀)
  const rateStore = {};
  ['draft', 'image', 'voice', 'music'].forEach((k) => {
    const el = $('rate-' + k);
    const v = el && el.value.trim();
    rateStore[k] = v === '' || v == null ? null : Number(v);
  });
  try { localStorage.setItem('onvideo-unit-rates', JSON.stringify(rateStore)); } catch {}

  // 2) 새로 입력한 키만 서버에 저장(비운 칸은 기존 유지)
  const body = {};
  document.querySelectorAll('#key-fields input').forEach((i) => {
    if (i.value.trim()) body[i.dataset.key] = i.value.trim();
  });
  if (Object.keys(body).length) {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  $('settings-msg').textContent = '저장했습니다.';
  setTimeout(() => $('settings-modal').classList.add('hidden'), 800);
};

// ── 로그인 ──
// 로그인되지 않았으면 true(로그인 필요), 로그인/불필요면 false 반환.
async function checkAuth() {
  try {
    const a = await (await fetch('/api/auth')).json();
    if (a.required && !a.ok) { $('login-overlay').classList.remove('hidden'); return true; }
  } catch {}
  return false;
}
$('login-btn').onclick = async () => {
  const pw = $('login-pw').value;
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) { $('login-overlay').classList.add('hidden'); loadCategories(); }
  else $('login-err').textContent = '비밀번호를 확인하세요.';
};
$('login-pw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });

// ── 다크/라이트 토글 (기본 라이트) ──
function applyTheme(t) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  const btn = $('theme-btn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
}
applyTheme(localStorage.getItem('lvm-theme') || 'light');
$('theme-btn')?.addEventListener('click', () => {
  const next = (localStorage.getItem('lvm-theme') || 'light') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('lvm-theme', next);
  applyTheme(next);
});

// ── 버전 배지(재배포 확인용) ──
fetch('/api/version').then(r => r.json()).then(d => { const v = $('ver'); if (v) v.textContent = 'v' + (d.version || '?'); }).catch(() => {});

// ── 예상 비용 표시 토글(키설정 모달 안 체크박스) ──
// 강의 화면엔 비용이 안 보이게 기본 OFF. 관리자가 키설정에서 켜면 표시.
function setDev(on) {
  if (on) document.documentElement.setAttribute('data-dev', 'on');
  else document.documentElement.removeAttribute('data-dev');
  localStorage.setItem('onvideo-dev', on ? '1' : '0');
  const cb = $('cost-visible');
  if (cb) cb.checked = on;
}
setDev(localStorage.getItem('onvideo-dev') === '1');
$('cost-visible')?.addEventListener('change', (e) => setDev(e.target.checked));

// ── 로그 복사 / 크게보기 ──
function flashCopied(btn) {
  const orig = btn.textContent;
  btn.textContent = '✓ 복사됨';
  setTimeout(() => { btn.textContent = orig; }, 1200);
}
async function copyLog(btn) {
  const text = $('log')?.innerText || '';
  try { await navigator.clipboard.writeText(text); flashCopied(btn); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); flashCopied(btn); }
}
$('log-copy')?.addEventListener('click', (e) => copyLog(e.currentTarget));
$('log-modal-copy')?.addEventListener('click', (e) => copyLog(e.currentTarget));
// 로그 수동 초기화(테리 요구: 이거 누르기 전엔 로그가 사라지면 안 됨). 진행 중이면 막는다.
$('log-clear')?.addEventListener('click', () => {
  if (curJobId) { alert('제작이 진행 중일 땐 로그를 지울 수 없어요. 끝난 뒤에 초기화하세요.'); return; }
  if (!confirm('로그를 모두 지울까요?')) return;
  if ($('log')) $('log').textContent = '';
  logJobId = null; logCount = 0;
});
let logMirror = null;
$('log-expand')?.addEventListener('click', () => {
  const big = $('log-big'), src = $('log');
  if (big && src) big.innerHTML = src.innerHTML;
  $('log-modal').classList.remove('hidden');
  // 제작 중이면 실시간 미러링(기존 로그 로직은 안 건드림)
  logMirror = setInterval(() => { if (big && src) { big.innerHTML = src.innerHTML; big.scrollTop = big.scrollHeight; } }, 500);
});
function closeLogModal() {
  $('log-modal').classList.add('hidden');
  if (logMirror) { clearInterval(logMirror); logMirror = null; }
}
$('log-modal-close')?.addEventListener('click', closeLogModal);
$('log-modal')?.addEventListener('click', (e) => { if (e.target === $('log-modal')) closeLogModal(); });

// ── 입력 폼 상태 영속(탭 이동·새로고침에도 유지, '초기화' 전까지 삭제 안 됨) ──
// 업로드한 사진 파일은 브라우저 보안상 복원 불가 → 텍스트/선택값만 저장.
const FORM_KEY = 'onvideo-form';
function saveFormState() {
  try {
    const activeTopic = document.querySelector('.topic-item.active');
    const s = {
      mode: mode === 'highlight' ? 'auto' : mode, selectedPreset, // 하이라이트는 URL 뷰라 저장 모드엔 안 남김
      url: $('url')?.value || '',
      topicInput: $('topic-input')?.value || '',
      topics: window.__topics || [],
      selectedTopic: activeTopic ? activeTopic.dataset.title : '',
      duration: $('duration')?.value,
      voice: $('voice')?.value || '',
      imageStyle: $('image-style')?.value,
      characterId: $('character-select')?.value || '',
      quality: $('quality')?.value,
      sceneCount: $('scene-count')?.value || '0',
      aiClips: $('aiClips')?.value || '0',
      keywords: $('keywords')?.value || '',
      facts: $('facts')?.value || '',

      productLock: $('product-lock')?.checked || false,
      product: ['name', 'price', 'benefit', 'url'].reduce((o, k) => { o[k] = $('product-' + k)?.value || ''; return o; }, {}),
      // 카드뉴스 입력(새로고침에도 유지, '초기화' 전까진 안 지움)
      cardTopic: $('card-topic')?.value || '',
      cardCount: $('card-count')?.value,
      cardBg: $('card-bg')?.value,
      cardOutput,
      cardNarration: $('card-narration')?.checked || false,
      cardBgm: $('card-bgm') ? $('card-bgm').checked : true,
      cardMotion: $('card-motion')?.value,
      cardTheme: $('card-theme')?.value,
    };
    localStorage.setItem(FORM_KEY, JSON.stringify(s));
  } catch {}
}
// setMode는 saveFormState를 호출하므로, 복원/리셋 땐 저장을 안 하는 조용한 버전을 쓴다.
function setModeSilent(m) { applyMode(m); }
function restoreFormState() {
  let s; try { s = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch {}
  if (!s) return;
  if (s.mode) setModeSilent(s.mode);
  if (s.url != null) $('url').value = s.url;
  if (s.topicInput != null) $('topic-input').value = s.topicInput;
  if (Array.isArray(s.topics) && s.topics.length) renderTopics(s.topics, s.selectedTopic);
  if (s.duration) $('duration').value = s.duration;
  if (s.voice != null && $('voice')) $('voice').value = s.voice;
  if (s.imageStyle && $('image-style')) { $('image-style').value = s.imageStyle; renderStyleGallery(); }
  syncCharacterRow();
  if (s.characterId != null && $('character-select')) { $('character-select').value = s.characterId; updateCharacterThumb(); }
  if (s.quality && $('quality')) $('quality').value = s.quality;
  if (s.sceneCount != null) setSceneCount(Number(s.sceneCount));
  if (s.aiClips != null) setAiClips(Number(s.aiClips));
  if (s.keywords != null) $('keywords').value = s.keywords;
  if (s.facts != null) $('facts').value = s.facts;

  if ($('product-lock')) { $('product-lock').checked = !!s.productLock; $('product-fields').classList.toggle('hidden', !s.productLock); }
  if (s.product) ['name', 'price', 'benefit', 'url'].forEach((k) => { if ($('product-' + k)) $('product-' + k).value = s.product[k] || ''; });
  if (s.selectedPreset) {
    selectedPreset = s.selectedPreset;
    const chip = document.querySelector('.chip[data-preset="' + s.selectedPreset + '"]');
    if (chip) { document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active'); }
    renderStyleGallery(); // 복원된 카테고리의 ✨추천 배지 반영
  }
  const v = (window.__voices || []).find((x) => x.id === ($('voice')?.value));
  if (v) $('voice-state').textContent = v.tip;
  $('duration')?.dispatchEvent(new Event('input')); // studio.js 예상비용 갱신
  // 카드뉴스 입력 복원
  if (s.cardTopic != null && $('card-topic')) $('card-topic').value = s.cardTopic;
  if (s.cardCount && $('card-count')) $('card-count').value = s.cardCount;
  if (s.cardMotion && $('card-motion')) $('card-motion').value = s.cardMotion;
  if (s.cardTheme && $('card-theme')) $('card-theme').value = s.cardTheme;
  if ($('card-narration')) $('card-narration').checked = !!s.cardNarration;
  if ($('card-bgm')) $('card-bgm').checked = s.cardBgm !== false;
  if (s.cardBg && $('card-bg')) { $('card-bg').value = s.cardBg; $('card-bg').dispatchEvent(new Event('change')); }
  if (s.cardOutput) setCardOutput(s.cardOutput);
}
function resetForm() {
  if ($('url')) $('url').value = '';
  if ($('topic-input')) $('topic-input').value = '';
  if ($('topic-list')) $('topic-list').innerHTML = ''; window.__topics = [];
  if ($('topic-state')) $('topic-state').textContent = '';
  if ($('keywords')) $('keywords').value = '';
  if ($('facts')) $('facts').value = '';
  if ($('duration')) $('duration').value = '30';
  if ($('image-style')) { $('image-style').value = 'real'; renderStyleGallery(); }
  if ($('quality')) $('quality').value = 'high';
  setSceneCount(0);
  setAiClips(0);

  if ($('product-lock')) { $('product-lock').checked = false; $('product-fields').classList.add('hidden'); }
  ['name', 'price', 'benefit', 'url'].forEach((k) => { if ($('product-' + k)) $('product-' + k).value = ''; });
  selectedPreset = null; document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  if ($('voice')) $('voice').value = ''; if ($('voice-state')) $('voice-state').textContent = '';
  uploadedImages = []; if ($('thumbs')) $('thumbs').innerHTML = ''; if ($('images')) $('images').value = '';
  // 카드뉴스 입력 초기화
  if ($('card-topic')) $('card-topic').value = '';
  if ($('card-topic-list')) $('card-topic-list').innerHTML = ''; if ($('card-topic-state')) $('card-topic-state').textContent = '';
  if ($('card-count')) $('card-count').value = '7';
  if ($('card-bg')) { $('card-bg').value = 'solid'; $('card-bg').dispatchEvent(new Event('change')); }
  if ($('card-motion')) $('card-motion').value = 'auto';
  if ($('card-theme')) $('card-theme').value = 'light';
  if ($('card-narration')) $('card-narration').checked = false;
  if ($('card-bgm')) $('card-bgm').checked = true;
  cardImages = []; if ($('card-thumbs')) $('card-thumbs').innerHTML = ''; if ($('card-images')) $('card-images').value = '';
  setCardOutput('video');
  setModeSilent('auto');
  $('duration')?.dispatchEvent(new Event('input'));
}
$('reset-form')?.addEventListener('click', () => {
  if (!confirm('입력한 내용을 모두 지울까요? (제작 중이거나 완성된 작업엔 영향 없어요)')) return;
  localStorage.removeItem(FORM_KEY);
  resetForm();
});
['url', 'topic-input', 'duration', 'quality', 'image-style', 'keywords', 'facts', 'product-name', 'product-price', 'product-benefit', 'product-url', 'card-topic']
  .forEach((id) => { const e = $(id); if (e) e.addEventListener('input', saveFormState); });
['product-lock', 'card-count', 'card-bg', 'card-motion', 'card-theme', 'card-narration', 'card-bgm'].forEach((id) => { const e = $(id); if (e) e.addEventListener('change', saveFormState); });

// 부트스트랩: 로그인 상태 확인 후, 인증된 경우에만 카테고리·목소리 로드(비로그인 시 401→throw 방지).
(async () => {
  const needLogin = await checkAuth();
  if (!needLogin) loadCategories();
})();

// PWA 서비스워커 등록(앱 설치 가능하게) — 예전 그대로 복원.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
