// 🧵 스레드 스튜디오 — 주제→글, 이미지 생성, 선택한 여러 계정에 일괄 발행.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (url, body) => {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '요청 실패');
    return d;
  };
  const state = { imageKey: '', imageMode: 'none', accounts: [], selected: new Set() };

  // 테마(라이트 기본). ★data-theme 속성으로 — style.css가 이걸 본다. 키는 lvm-theme로 다른 페이지와 통일.
  const tb = $('theme-btn');
  function applyTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (tb) tb.textContent = t === 'dark' ? '☀️' : '🌙';
  }
  let theme = localStorage.getItem('lvm-theme') || 'light';
  applyTheme(theme);
  tb.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('lvm-theme', theme); applyTheme(theme); };

  // 글 소스 세그(주제로 AI / 직접 작성)
  $('src-seg').onclick = (e) => {
    const b = e.target.closest('[data-src]'); if (!b) return;
    [...$('src-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    $('src-topic').classList.toggle('hidden', b.dataset.src !== 'topic');
  };

  // 글자 카운터
  const txt = $('text');
  function updateCount() { const n = txt.value.length; const c = $('count'); c.textContent = n + ' / 500'; c.classList.toggle('over', n > 500); }
  txt.oninput = updateCount;

  // 스레드 글 생성
  $('gen-text').onclick = async () => {
    const topic = $('topic').value.trim();
    if (!topic) { alert('주제를 입력하세요.'); return; }
    const btn = $('gen-text'); const o = btn.textContent; btn.disabled = true; btn.textContent = '✍️ 생성 중…';
    try { const d = await api('/api/social/compose', { topic, platform: 'threads' }); txt.value = d.text || ''; updateCount(); }
    catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = o; }
  };

  // 이미지 세그
  $('img-seg').onclick = (e) => {
    const b = e.target.closest('[data-img]'); if (!b) return;
    [...$('img-seg').children].forEach((x) => x.classList.toggle('on', x === b));
    state.imageMode = b.dataset.img;
    $('img-gen').classList.toggle('hidden', b.dataset.img !== 'gen');
    if (b.dataset.img === 'none') { state.imageKey = ''; $('img-prev').style.display = 'none'; }
  };

  // 이미지 생성
  $('gen-img').onclick = async () => {
    const prompt = $('img-prompt').value.trim();
    if (!prompt) { alert('이미지 설명을 입력하세요.'); return; }
    const btn = $('gen-img'); const o = btn.textContent; btn.disabled = true; btn.textContent = '🎨 생성 중… (최대 1분)';
    try {
      const d = await api('/api/social/image', { prompt });
      state.imageKey = d.key || '';
      const im = $('img-prev'); im.src = d.url; im.style.display = 'block';
    } catch (e) { alert(e.message); } finally { btn.disabled = false; btn.textContent = o; }
  };

  // 계정 로드(다계정)
  async function loadAccounts() {
    try {
      const d = await api('/api/threads/status');
      state.accounts = d.accounts || [];
      const box = $('accts');
      if (!state.accounts.length) { box.innerHTML = '<p class="mini-state">연결된 스레드 계정이 없어요. 영상 만들기 → ⚙ 키 설정에서 스레드 계정을 연결하세요.</p>'; return; }
      box.innerHTML = state.accounts.map((a) =>
        `<div class="acct-row"><input type="checkbox" id="a-${a.id}" data-aid="${a.id}"><label for="a-${a.id}">🧵 ${a.label || a.username || a.id}${a.username ? ` <span class="acct-niche">@${a.username}</span>` : ''}</label></div>`
      ).join('');
      box.onchange = (e) => { const cb = e.target.closest('[data-aid]'); if (!cb) return; if (cb.checked) state.selected.add(cb.dataset.aid); else state.selected.delete(cb.dataset.aid); };
    } catch (e) { $('accts').innerHTML = '<p class="mini-state">계정 불러오기 실패: ' + e.message + '</p>'; }
  }
  loadAccounts();

  // 발행
  const log = $('log');
  function addLog(m) { log.style.display = 'block'; log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; }
  $('publish').onclick = async () => {
    const text = txt.value.trim();
    const accountIds = [...state.selected];
    if (!accountIds.length) { alert('올릴 계정을 선택하세요.'); return; }
    if (!text && !state.imageKey) { alert('글이나 이미지를 넣으세요.'); return; }
    if (text.length > 500) { alert('글이 500자를 넘어요. 줄여주세요.'); return; }
    const btn = $('publish'); const o = btn.textContent; btn.disabled = true; btn.textContent = '🚀 올리는 중…';
    log.textContent = ''; addLog(`${accountIds.length}개 계정에 발행 시작…`);
    try {
      const d = await api('/api/social/publish', { text, imageKey: state.imageKey || undefined, link: $('link').value.trim() || undefined, accountIds });
      const rl = $('res-list'); rl.innerHTML = '';
      (d.results || []).forEach((r) => {
        const a = state.accounts.find((x) => x.id === r.accountId);
        const name = a ? (a.label || a.username || r.accountId) : r.accountId;
        rl.innerHTML += `<div class="res-item">${r.ok ? '✅' : '❌'} ${name} ${r.ok ? `<a href="${r.permalink}" target="_blank">열기</a>` : '— ' + r.error}</div>`;
        addLog(`${r.ok ? '✅' : '❌'} ${name} ${r.ok ? r.permalink : r.error}`);
      });
      $('results').classList.remove('hidden');
    } catch (e) { addLog('실패: ' + e.message); alert(e.message); }
    finally { btn.disabled = false; btn.textContent = o; }
  };
})();
