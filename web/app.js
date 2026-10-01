const $ = (id) => document.getElementById(id);

// 이미지·영상 롱프레스/우클릭 메뉴(공유·저장) 차단
document.addEventListener('contextmenu', (e) => {
  if (e.target && /^(IMG|VIDEO)$/.test(e.target.tagName)) e.preventDefault();
});

let selectedPreset = null;
let mode = 'auto'; // auto | topic | manual
let uploadedImages = []; // dataURL 배열

// ── 탭 전환 ──
$('tab-auto').onclick = () => setMode('auto');
$('tab-topic').onclick = () => setMode('topic');
$('tab-manual').onclick = () => setMode('manual');
function setMode(m) {
  mode = m;
  $('tab-auto').classList.toggle('active', m === 'auto');
  $('tab-topic').classList.toggle('active', m === 'topic');
  $('tab-manual').classList.toggle('active', m === 'manual');
  $('pane-auto').classList.toggle('hidden', m !== 'auto');
  $('pane-topic').classList.toggle('hidden', m !== 'topic');
  $('pane-manual').classList.toggle('hidden', m !== 'manual');
  saveFormState();
}

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
        // 애니 카테고리면 이미지 스타일을 애니로 자동 전환(동화·안전교육은 애니가 기본).
        if (p.anime) { const sel = $('image-style'); if (sel) sel.value = 'anime'; }
        syncCharacterRow();
        saveFormState();
      };
      chips.appendChild(b);
    }
    box.appendChild(chips);
    wrap.appendChild(box);
  }
  restoreFormState(); // 카테고리·목소리가 채워진 뒤 저장된 입력 복원
  loadCharacters();
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

// ── 목소리 미리듣기 ──
let previewAudio = null;
$('voice-preview').onclick = async () => {
  // 목소리 선택 안 했으면(카테고리 추천) 그 카테고리의 추천 목소리로 미리듣기
  let voice = $('voice').value;
  if (!voice && selectedPreset) {
    const p = (window.__presets || []).find((x) => x.id === selectedPreset);
    voice = p ? p.voice : 'jaewon';
  }
  if (!voice) voice = 'jaewon';
  const st = $('voice-state');
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  st.textContent = '목소리 준비 중…';
  try {
    const r = await fetch('/api/voice-preview?voice=' + encodeURIComponent(voice));
    if (!r.ok) throw new Error((await r.json()).error || '실패');
    const url = URL.createObjectURL(await r.blob());
    previewAudio = new Audio(url);
    previewAudio.onended = () => { st.textContent = ''; URL.revokeObjectURL(url); };
    await previewAudio.play();
    st.textContent = '▶ 재생 중…';
  } catch (e) {
    st.textContent = e.message;
  }
};

// ── 영상 생성 ──
$('generate').onclick = async () => {
  let endpoint, body;
  if (mode === 'auto') {
    const url = $('url').value.trim();
    if (!url) { alert('링크를 입력하세요.'); return; }
    endpoint = '/api/generate';
    body = {
      url,
      duration: Number($('duration').value),
      presetId: selectedPreset,
      voice: $('voice').value,
      quality: $('quality').value,
      aiClips: Number($('aiClips').value),
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

// ── 진행 로그 SSE(재연결 가능) — 화면 내림/백그라운드로 끊겨도 복귀 시 자동 이어짐 ──
//   제작은 서버에서 계속 돌고, /api/progress는 재접속 시 그동안의 로그를 처음부터 다시 준다.
let curJobId = null, curES = null, reconnTries = 0;
function attachProgress(id, freshLog) {
  curJobId = id;
  try { localStorage.setItem('onvideo-genjob', id); } catch {}
  if (curES) { try { curES.close(); } catch {} curES = null; }
  if (freshLog && $('log')) $('log').textContent = ''; // 재연결 시 서버가 전체 재전송하므로 중복 방지
  $('progress-block').classList.remove('hidden');
  $('generate').disabled = true;
  const es = new EventSource('/api/progress?id=' + id);
  curES = es;
  es.onmessage = (ev) => {
    reconnTries = 0;
    const m = JSON.parse(ev.data);
    if (m.log) addLog(m.log, m.log.includes('[완료]') ? 'done' : m.log.includes('[실패]') ? 'fail' : '');
    if (m.done) {
      es.close(); curES = null; curJobId = null;
      try { localStorage.removeItem('onvideo-genjob'); } catch {}
      $('generate').disabled = false;
      if (m.file) showResult(m.file, m.title);
    }
  };
  es.onerror = () => {
    es.close(); if (curES === es) curES = null;
    if (curJobId === id && reconnTries < 6) {
      reconnTries++;
      setTimeout(() => { if (curJobId === id && !curES) attachProgress(id, true); }, 2500);
    } else if (curJobId === id) {
      // 서버에 작업이 없음(재시작 등) — 조용히 종료
      curJobId = null; try { localStorage.removeItem('onvideo-genjob'); } catch {}
      $('generate').disabled = false;
    }
  };
}
// 화면 복귀 시 끊겼던 연결 재개
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && curJobId && !curES) { reconnTries = 0; attachProgress(curJobId, true); }
});
// 페이지 다시 열었을 때 진행 중이던 작업 자동 복원
try { const j = localStorage.getItem('onvideo-genjob'); if (j) attachProgress(j, true); } catch {}

function addLog(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}

function showResult(file, title) {
  $('result-block').classList.remove('hidden');
  $('result-title').textContent = title || '';
  const src = '/api/video/' + file;
  $('result-video').src = src;
  $('download').href = src;
  $('download').setAttribute('download', (title || 'onvideo') + '.mp4');
  syncFormat();
  $('result-block').scrollIntoView({ behavior: 'smooth' });
}

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

// ── 키 설정 모달 ──
const KEY_META = [
  { k: 'GEMINI_KEYS', label: 'Google Gemini (대본·이미지)', desc: '여러 개는 콤마로. 하나 소진되면 자동으로 다음 키 사용.', link: 'https://aistudio.google.com/apikey' },
  { k: 'REPLICATE_API_TOKEN', label: 'Replicate (Flux 이미지)', desc: '9:16 이미지 생성용.', link: 'https://replicate.com/account/api-tokens' },
  { k: 'ELEVENLABS_API_KEY', label: 'ElevenLabs (음성·배경음악)', desc: '나레이션과 BGM 생성.', link: 'https://elevenlabs.io/app/settings/api-keys' },
  { k: 'OPENAI_API_KEY', label: 'OpenAI (폴백 대본)', desc: 'Gemini 실패 시 대본 폴백.', link: 'https://platform.openai.com/api-keys' },
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
      mode, selectedPreset,
      url: $('url')?.value || '',
      topicInput: $('topic-input')?.value || '',
      topics: window.__topics || [],
      selectedTopic: activeTopic ? activeTopic.dataset.title : '',
      duration: $('duration')?.value,
      voice: $('voice')?.value || '',
      imageStyle: $('image-style')?.value,
      characterId: $('character-select')?.value || '',
      quality: $('quality')?.value,
      keywords: $('keywords')?.value || '',
      facts: $('facts')?.value || '',
      music: $('studio-music')?.checked || false,
      productLock: $('product-lock')?.checked || false,
      product: ['name', 'price', 'benefit', 'url'].reduce((o, k) => { o[k] = $('product-' + k)?.value || ''; return o; }, {}),
    };
    localStorage.setItem(FORM_KEY, JSON.stringify(s));
  } catch {}
}
// setMode는 saveFormState를 호출하므로, 복원/리셋 땐 저장을 안 하는 조용한 버전을 쓴다.
function setModeSilent(m) {
  mode = m;
  $('tab-auto').classList.toggle('active', m === 'auto');
  $('tab-topic').classList.toggle('active', m === 'topic');
  $('tab-manual').classList.toggle('active', m === 'manual');
  $('pane-auto').classList.toggle('hidden', m !== 'auto');
  $('pane-topic').classList.toggle('hidden', m !== 'topic');
  $('pane-manual').classList.toggle('hidden', m !== 'manual');
}
function restoreFormState() {
  let s; try { s = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch {}
  if (!s) return;
  if (s.mode) setModeSilent(s.mode);
  if (s.url != null) $('url').value = s.url;
  if (s.topicInput != null) $('topic-input').value = s.topicInput;
  if (Array.isArray(s.topics) && s.topics.length) renderTopics(s.topics, s.selectedTopic);
  if (s.duration) $('duration').value = s.duration;
  if (s.voice != null && $('voice')) $('voice').value = s.voice;
  if (s.imageStyle && $('image-style')) $('image-style').value = s.imageStyle;
  syncCharacterRow();
  if (s.characterId != null && $('character-select')) { $('character-select').value = s.characterId; updateCharacterThumb(); }
  if (s.quality && $('quality')) $('quality').value = s.quality;
  if (s.keywords != null) $('keywords').value = s.keywords;
  if (s.facts != null) $('facts').value = s.facts;
  if ($('studio-music')) $('studio-music').checked = !!s.music;
  if ($('product-lock')) { $('product-lock').checked = !!s.productLock; $('product-fields').classList.toggle('hidden', !s.productLock); }
  if (s.product) ['name', 'price', 'benefit', 'url'].forEach((k) => { if ($('product-' + k)) $('product-' + k).value = s.product[k] || ''; });
  if (s.selectedPreset) {
    selectedPreset = s.selectedPreset;
    const chip = document.querySelector('.chip[data-preset="' + s.selectedPreset + '"]');
    if (chip) { document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active')); chip.classList.add('active'); }
  }
  const v = (window.__voices || []).find((x) => x.id === ($('voice')?.value));
  if (v) $('voice-state').textContent = v.tip;
  $('duration')?.dispatchEvent(new Event('input')); // studio.js 예상비용 갱신
}
function resetForm() {
  if ($('url')) $('url').value = '';
  if ($('topic-input')) $('topic-input').value = '';
  if ($('topic-list')) $('topic-list').innerHTML = ''; window.__topics = [];
  if ($('topic-state')) $('topic-state').textContent = '';
  if ($('keywords')) $('keywords').value = '';
  if ($('facts')) $('facts').value = '';
  if ($('duration')) $('duration').value = '30';
  if ($('image-style')) $('image-style').value = 'real';
  if ($('quality')) $('quality').value = 'high';
  if ($('studio-music')) $('studio-music').checked = false;
  if ($('product-lock')) { $('product-lock').checked = false; $('product-fields').classList.add('hidden'); }
  ['name', 'price', 'benefit', 'url'].forEach((k) => { if ($('product-' + k)) $('product-' + k).value = ''; });
  selectedPreset = null; document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  if ($('voice')) $('voice').value = ''; if ($('voice-state')) $('voice-state').textContent = '';
  uploadedImages = []; if ($('thumbs')) $('thumbs').innerHTML = ''; if ($('images')) $('images').value = '';
  setModeSilent('auto');
  $('duration')?.dispatchEvent(new Event('input'));
}
$('reset-form')?.addEventListener('click', () => {
  if (!confirm('입력한 내용을 모두 지울까요? (제작 중이거나 완성된 작업엔 영향 없어요)')) return;
  localStorage.removeItem(FORM_KEY);
  resetForm();
});
['url', 'topic-input', 'duration', 'quality', 'image-style', 'keywords', 'facts', 'product-name', 'product-price', 'product-benefit', 'product-url']
  .forEach((id) => { const e = $(id); if (e) e.addEventListener('input', saveFormState); });
['studio-music', 'product-lock'].forEach((id) => { const e = $(id); if (e) e.addEventListener('change', saveFormState); });

// 부트스트랩: 로그인 상태 확인 후, 인증된 경우에만 카테고리·목소리 로드(비로그인 시 401→throw 방지).
(async () => {
  const needLogin = await checkAuth();
  if (!needLogin) loadCategories();
})();

// PWA 서비스워커 등록(앱 설치 가능하게) — 예전 그대로 복원.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
