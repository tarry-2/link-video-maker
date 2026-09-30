const $ = (id) => document.getElementById(id);
let selectedPreset = null;
let mode = 'auto'; // auto | manual
let uploadedImages = []; // dataURL 배열

// ── 탭 전환 ──
$('tab-auto').onclick = () => setMode('auto');
$('tab-manual').onclick = () => setMode('manual');
function setMode(m) {
  mode = m;
  $('tab-auto').classList.toggle('active', m === 'auto');
  $('tab-manual').classList.toggle('active', m === 'manual');
  $('pane-auto').classList.toggle('hidden', m !== 'auto');
  $('pane-manual').classList.toggle('hidden', m !== 'manual');
}

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
};

// ── 카테고리 · 목소리 로드 ──
async function loadCategories() {
  const d = await (await fetch('/api/categories')).json();

  // 목소리 셀렉트 — 용도 그룹으로(optgroup). 카테고리 고르면 자동 추천이 기본.
  window.__voices = d.voices;
  const useName = { issue: '📰 이슈·미스터리', info: '💡 정보·건강', sell: '🛍️ 판매·리뷰', heal: '🌿 힐링·음식·여행' };
  const grouped = {};
  for (const v of d.voices) (grouped[v.use[0]] = grouped[v.use[0]] || []).push(v);
  let html = '<option value="">🎯 카테고리 자동 추천</option>';
  for (const key of ['issue', 'info', 'sell', 'heal']) {
    if (!grouped[key]) continue;
    html += `<optgroup label="${useName[key]}">`;
    html += grouped[key].map((v) => `<option value="${v.id}">${v.label} (${v.gender})</option>`).join('');
    html += '</optgroup>';
  }
  $('voice').innerHTML = html;
  // 선택 시 팁 표시
  $('voice').onchange = () => {
    const v = (window.__voices || []).find((x) => x.id === $('voice').value);
    $('voice-state').textContent = v ? v.tip : '';
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
      b.textContent = `${p.emoji} ${p.label}`;
      b.onclick = () => {
        document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        selectedPreset = p.id;
      };
      chips.appendChild(b);
    }
    box.appendChild(chips);
    wrap.appendChild(box);
  }
}

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

  // SSE 진행로그
  const es = new EventSource('/api/progress?id=' + id);
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.log) addLog(m.log, m.log.includes('[완료]') ? 'done' : m.log.includes('[실패]') ? 'fail' : '');
    if (m.done) {
      es.close();
      $('generate').disabled = false;
      if (m.file) showResult(m.file, m.title);
    }
  };
  es.onerror = () => { es.close(); $('generate').disabled = false; };
};

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
  $('result-block').scrollIntoView({ behavior: 'smooth' });
}

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
  $('settings-modal').classList.remove('hidden');
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
$('save-keys').onclick = async () => {
  const body = {};
  document.querySelectorAll('#key-fields input').forEach((i) => {
    if (i.value.trim()) body[i.dataset.key] = i.value.trim();
  });
  if (!Object.keys(body).length) { $('settings-msg').textContent = '입력한 키가 없습니다.'; return; }
  await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('settings-msg').textContent = '저장했습니다.';
  setTimeout(() => $('settings-modal').classList.add('hidden'), 800);
};

// ── 로그인 ──
async function checkAuth() {
  try {
    const a = await (await fetch('/api/auth')).json();
    if (a.required && !a.ok) $('login-overlay').classList.remove('hidden');
  } catch {}
}
$('login-btn').onclick = async () => {
  const pw = $('login-pw').value;
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) { $('login-overlay').classList.add('hidden'); }
  else $('login-err').textContent = '비밀번호를 확인하세요.';
};
$('login-pw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });

checkAuth();
loadCategories();
