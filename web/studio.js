(() => {
  const el = id => document.getElementById(id);
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const labels = {draft:'대본', image:'이미지', voice:'음성', music:'배경음악'};
  const productLabels = {name:'상품명', price:'가격', benefit:'혜택', url:'구매 주소'};
  const displayText = text => String(text).replace(/\{\{product\.(name|price|benefit|url)\}\}/g, (_, k) => '[' + productLabels[k] + ']');
  const storeText = text => Object.entries(productLabels).reduce((s, [k, label]) => s.split('[' + label + ']').join('{{product.' + k + '}}'), text);
  const stateNames = {planning:'대본 작성 중', draft:'검토 가능', running:'제작 중', failed:'재시작 필요', completed:'완성'};
  let current = null, dirty = false, timer = null, loading = false;
  let elapsedTimer = null, prevRender = {id: null, status: null};
  const active = p => p && ['planning', 'running'].includes(p.status);

  // ── 진행 표시 헬퍼(경과시간·에너지바·완성 폭죽) ──
  const fmtDur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  // 전체 진행률(대본6% → 소재 10~70% → 배경음악 72% → 렌더 75~99% → 완성 100%)
  function progressOf(p) {
    if (p.status === 'completed') return 100;
    if (p.status === 'planning') return 6;
    if (p.status !== 'running') return null;
    const total = p.scenes.length || 1;
    const done = p.scenes.filter(s => s.image && s.voice).length;
    let pct = 10 + (done / total) * 60;
    if (/배경음악/.test(p.phase)) pct = Math.max(pct, 72);
    const rlog = [...p.logs].reverse().find(l => /\[렌더\][^0-9]*(\d+)%/.test(l));
    if (/합성|렌더/.test(p.phase) || rlog) { const n = rlog ? Number(rlog.match(/(\d+)%/)[1]) : 0; pct = 75 + n * 0.24; }
    return Math.max(1, Math.min(99, Math.round(pct)));
  }
  // 경과시간 텍스트(렌더 시 즉시 채움 → 항상 보이게). started 없으면 빈 문자열.
  function elapsedText(p) {
    const started = p?.startedAt ? new Date(p.startedAt).getTime() : null;
    if (!started) return '';
    if (['planning', 'running'].includes(p.status)) return '⏱ ' + fmtDur(Date.now() - started);
    if (p.status === 'completed') return '⏱ ' + fmtDur(new Date(p.updatedAt).getTime() - started) + ' 만에 완성';
    return '';
  }
  // 경과시간 1초마다 갱신(재귀 setTimeout — setInterval 겹침 금지)
  function tickElapsed() {
    clearTimeout(elapsedTimer);
    const node = el('job-elapsed');
    if (!node || !current) return;
    node.textContent = elapsedText(current);
    if (active(current) && current.startedAt) elapsedTimer = setTimeout(tickElapsed, 1000);
  }
  // 완성 영상 다운로드 — PWA(앱)에선 <a download>가 막히므로 blob으로 강제 저장.
  async function downloadVideo(btn) {
    if (!current?.output) return;
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '⬇ 내려받는 중…';
    try {
      const r = await fetch(asset(current, current.output), {cache: 'no-store'});
      if (!r.ok) throw new Error('다운로드 실패');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = (current.title || 'onvideo').replace(/[\\/:*?"<>|]/g, '_') + '.mp4';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      btn.textContent = '✓ 저장됨';
    } catch (e) {
      report(e); btn.textContent = '⬇ 영상 다운로드';
    } finally { btn.disabled = false; setTimeout(() => { if (btn.textContent === '✓ 저장됨') btn.textContent = orig; }, 1500); }
  }
  // 유튜브 올리기 — 연결 확인 → Gemini 메타 자동생성 → 확인/수정 → 업로드.
  async function openYouTube(btn) {
    if (!current?.output) return;
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📺 준비 중…';
    try {
      const st = await (await fetch('/api/youtube/status')).json();
      if (!st.connected) {
        message('먼저 ⚙ 키 설정에서 유튜브 계정을 연결하세요.', true);
        btn.disabled = false; btn.textContent = orig; return;
      }
      btn.textContent = '📺 제목·설명 만드는 중…';
      const meta = await api('/api/youtube/meta/' + current.id, undefined); // GET
      openYtModal(meta, st.channelTitle);
    } catch (e) { report(e); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }
  function openYtModal(meta, channel) {
    let box = el('yt-modal');
    if (!box) {
      box = document.createElement('div'); box.id = 'yt-modal'; box.className = 'modal hidden';
      document.body.appendChild(box);
    }
    box.innerHTML = `<div class="modal-box">
      <div class="modal-head"><h2>📺 유튜브 올리기</h2><button class="ghost-btn" data-yt="close">✕</button></div>
      <p class="sub small">${channel ? '채널: <b>' + escape(channel) + '</b> · ' : ''}제목·설명은 수정할 수 있어요.</p>
      <label class="field-label">제목<input id="yt-title" class="input" maxlength="100" value="${escape(meta.title || '')}" /></label>
      <label class="field-label">설명<textarea id="yt-desc" class="input" rows="6" maxlength="4900">${escape(meta.description || '')}</textarea></label>
      <label class="field-label">태그(쉼표로 구분)<input id="yt-tags" class="input" value="${escape((meta.tags || []).join(', '))}" /></label>
      <label class="field-label">공개 범위<select id="yt-privacy" class="input">
        <option value="public" selected>바로 공개</option>
        <option value="unlisted">미등록(링크만)</option>
        <option value="private">비공개</option>
      </select></label>
      <button class="primary-btn" data-yt="upload">유튜브에 올리기</button>
      <p id="yt-up-msg" class="mini-state"></p>
    </div>`;
    box.classList.remove('hidden');
    box.onclick = async e => {
      const act = e.target.closest('[data-yt]')?.dataset.yt;
      if (act === 'close' || e.target === box) { box.classList.add('hidden'); return; }
      if (act === 'upload') {
        const up = e.target; up.disabled = true; up.textContent = '올리는 중… (잠시 걸려요)';
        el('yt-up-msg').textContent = '';
        try {
          const r = await api('/api/youtube/upload/' + current.id, {
            title: el('yt-title').value, description: el('yt-desc').value,
            tags: el('yt-tags').value.split(',').map(s => s.trim()).filter(Boolean),
            privacy: el('yt-privacy').value,
          });
          el('yt-up-msg').innerHTML = `✅ 업로드 완료! <a href="${r.url}" target="_blank" style="color:var(--teal)">${r.url}</a>`;
          up.textContent = '완료 🎉';
        } catch (err) { el('yt-up-msg').textContent = '실패: ' + err.message; up.disabled = false; up.textContent = '유튜브에 올리기'; }
      }
    };
  }
  // 인스타 올리기 — 연결 확인 → 캡션 자동생성 → 릴스/게시물 선택 → 업로드.
  async function openInstagram(btn) {
    if (!current?.output) return;
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
    try {
      const st = await (await fetch('/api/instagram/status')).json();
      if (!st.connected) {
        message('먼저 ⚙ 키 설정에서 인스타 계정을 연결하세요.', true);
        btn.disabled = false; btn.textContent = orig; return;
      }
      btn.textContent = '📷 캡션 만드는 중…';
      const d = await api('/api/instagram/caption/' + current.id, undefined); // GET
      openIgModal(d.caption || '', st.username);
    } catch (e) { report(e); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }
  function openIgModal(caption, username) {
    // 세로(쇼츠)면 릴스 기본, 가로(롱폼)면 게시물 기본.
    const vertical = !current || (current.input?.duration || 45) < 90;
    let box = el('ig-modal');
    if (!box) { box = document.createElement('div'); box.id = 'ig-modal'; box.className = 'modal hidden'; document.body.appendChild(box); }
    box.innerHTML = `<div class="modal-box">
      <div class="modal-head"><h2>📷 인스타 올리기</h2><button class="ghost-btn" data-ig="close">✕</button></div>
      <p class="sub small">${username ? '계정: <b>@' + escape(username) + '</b> · ' : ''}캡션은 수정할 수 있어요.</p>
      <label class="field-label">올릴 방식<select id="ig-kind" class="input">
        <option value="reels" ${vertical ? 'selected' : ''}>릴스 (세로 쇼츠)</option>
        <option value="feed" ${vertical ? '' : 'selected'}>게시물 (피드에도 노출)</option>
      </select></label>
      <label class="field-label">캡션 · 해시태그<textarea id="ig-caption" class="input" rows="7" maxlength="2200">${escape(caption)}</textarea></label>
      <button class="primary-btn" data-ig="upload">인스타에 올리기</button>
      <p id="ig-up-msg" class="mini-state">릴스는 인코딩 때문에 1~2분 걸릴 수 있어요.</p>
    </div>`;
    box.classList.remove('hidden');
    box.onclick = async e => {
      const act = e.target.closest('[data-ig]')?.dataset.ig;
      if (act === 'close' || e.target === box) { box.classList.add('hidden'); return; }
      if (act === 'upload') {
        const up = e.target; up.disabled = true; up.textContent = '올리는 중… (1~2분)';
        el('ig-up-msg').textContent = '인스타가 영상을 받아 처리하는 중이에요…';
        try {
          const r = await api('/api/instagram/upload/' + current.id, {kind: el('ig-kind').value, caption: el('ig-caption').value});
          el('ig-up-msg').innerHTML = r.permalink ? `✅ 게시 완료! <a href="${r.permalink}" target="_blank" style="color:var(--teal)">${r.permalink}</a>` : '✅ 게시 완료! 인스타 앱에서 확인하세요.';
          up.textContent = '완료 🎉';
        } catch (err) { el('ig-up-msg').textContent = '실패: ' + err.message; up.disabled = false; up.textContent = '인스타에 올리기'; }
      }
    };
  }
  function celebrate() {
    const c = document.createElement('div'); c.className = 'confetti';
    const colors = ['#17b5a4', '#7c5cff', '#ff4d8d', '#FFE24B', '#ff8a5c', '#4fe0d0'];
    for (let i = 0; i < 90; i++) { const bit = document.createElement('i'); bit.style.left = Math.random() * 100 + '%'; bit.style.background = colors[i % colors.length]; bit.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's'; bit.style.animationDuration = (2.2 + Math.random() * 1.3).toFixed(2) + 's'; c.appendChild(bit); }
    document.body.appendChild(c); setTimeout(() => c.remove(), 4200);
  }
  const asset = (p, file) => `/api/studio/${p.id}/assets/${encodeURIComponent(file)}`;
  const devMode = () => document.documentElement.getAttribute('data-dev') === 'on';
  function regenerationCost(p, s, kind) {
    const rate = p.input.rates[kind];
    if (rate === null) return '유료 · 단가 미산정';
    const narration = s.narration.replace(/\{\{product\.(name|price|benefit|url)\}\}/g, (_, k) => p.input.product?.[k] || '');
    const amount = Math.ceil(rate * (kind === 'image' ? 1 : narration.length / 1000));
    return '약 ' + amount.toLocaleString('ko-KR') + '원';
  }
  // 비용 괄호는 관리자(dev) 모드에서만 버튼에 붙인다(강의 화면 노출 방지).
  const costSuffix = (p, s, kind) => devMode() ? ` (${regenerationCost(p, s, kind)})` : '';

  function message(text, error = false) { for (const id of ['studio-message','editor-message']) { const node = el(id); if (node) { node.textContent = text; node.classList.toggle('error', error); } } }
  async function api(url, body, method = 'POST') {
    const r = await fetch(url, body === undefined ? {cache:'no-store'} : {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401) el('login-overlay').classList.remove('hidden');
      throw new Error(data.error || '요청에 실패했습니다.');
    }
    return data;
  }
  function rates() {
    return Object.fromEntries(Object.keys(labels).map(k => {
      const v = el('rate-' + k).value;
      return [k, v === '' ? null : Number(v)];
    }));
  }
  function priceText(e) {
    const amount = `${Number(e.subtotal).toLocaleString('ko-KR')}원`;
    return e.complete ? `추가 API 비용 약 ${amount}` : `산정된 비용 ${amount} + ${e.missing.map(k => labels[k]).join('·')} 미산정`;
  }
  function updateEstimate() {
    const n = Number(el('duration').value);
    const sc = Number(el('scene-count')?.value) || 0;
    const count = (sc >= 2) ? Math.min(12, sc) : (n <= 30 ? 4 : n <= 60 ? 6 : Math.min(10, Math.ceil(n / 12)));
    const r = rates();
    const chars = Math.round(n * 5.6); // 대본 예상 글자수
    const quantities = {draft:1, image:mode === 'manual' ? 0 : count, voice:chars / 1000, music:el('v-bgm')?.checked ? n / 60 : 0};
    const qtyLabel = {draft:'1회', image:`${count}장`, voice:`${chars.toLocaleString('ko-KR')}자`, music:`${(n/60).toFixed(1)}분`};
    let subtotal = 0; const lines = []; const missing = [];
    for (const [k, qty] of Object.entries(quantities)) {
      if (!qty) continue; // 배경음악 OFF 등 수량 0은 제외
      if (r[k] === null) { missing.push(labels[k]); continue; }
      const amt = Math.round(r[k] * qty);
      subtotal += amt;
      lines.push(`${labels[k]} ${r[k].toLocaleString('ko-KR')}원×${qtyLabel[k]} = ${amt.toLocaleString('ko-KR')}원`);
    }
    let html = `<b>예상 비용 약 ${Math.ceil(subtotal).toLocaleString('ko-KR')}원</b>`;
    if (lines.length) html += `<br><small>${lines.join('<br>')}</small>`;
    if (missing.length) html += `<br><small>· ${missing.join('·')} 단가 미입력(미산정)</small>`;
    if (!el('v-bgm')?.checked) html += `<br><small>· 배경음악 미포함(옵션 꺼짐)</small>`;
    html += `<br><small>약 ${count}장면 기준 · 서버 비용·재시도 별도</small>`;
    el('create-estimate').innerHTML = html;
    try { localStorage.setItem('onvideo-unit-rates', JSON.stringify(r)); } catch {}
  }
  try {
    const r = JSON.parse(localStorage.getItem('onvideo-unit-rates') || '{}');
    Object.keys(labels).forEach(k => { if (Number.isFinite(r[k]) && r[k] >= 0) el('rate-' + k).value = r[k]; });
  } catch {}
  document.querySelectorAll('.studio-options input, #rate-section input, #duration, #quality').forEach(i => i.addEventListener('input', updateEstimate));
  ['tab-auto', 'tab-topic', 'tab-manual'].forEach(id => el(id) && el(id).addEventListener('click', updateEstimate));
  el('product-lock').onchange = () => el('product-fields').classList.toggle('hidden', !el('product-lock').checked);
  // 영상 종류(aiClips)는 app.js의 버튼이 관리한다. 여기서 건드리지 않음.
  updateEstimate();
  async function loadHistory() {
    const rows = await api('/api/studio');
    el('studio-history').innerHTML = rows.length ? rows.map(p => `<button class="history-item" data-project="${p.id}"><span><strong>${escape(p.title)}</strong><small>${escape(new Date(p.updatedAt).toLocaleString('ko-KR'))}</small></span><span class="badge ${p.status === 'failed' ? 'error' : ''}">${stateNames[p.status]}</span></button>`).join('') : '<p class="mini-state">첫 대본을 만들어보세요.</p>';
    return rows;
  }
  const loadHistoryRows = loadHistory;
  const report = e => message(e.message || String(e), true);
  el('history-refresh').onclick = () => loadHistory().catch(report);
  // 탭 나갔다 들어와도 진행 상태가 초기화되지 않게 — 진행 중 작업을 자동으로 다시 연다.
  document.addEventListener('onvideo-auth-ready', async () => {
    try {
      const rows = await loadHistoryRows();
      if (current) return; // 이미 열려 있으면 유지
      const act = rows.find(r => ['planning', 'running'].includes(r.status));
      const lastId = localStorage.getItem('onvideo-open');
      const target = act || (lastId ? rows.find(r => r.id === lastId) : null);
      if (target) await open(target.id);
    } catch (e) { report(e); }
  });
  el('studio-history').onclick = async e => {
    const button = e.target.closest('[data-project]');
    if (!button) return;
    if (dirty) { message('현재 대본의 수정 내용을 먼저 저장하세요.', true); return; }
    try { await open(button.dataset.project); } catch (err) { report(err); }
  };
  function render(p) {
    current = p; dirty = false;
    // 완성으로 막 전환된 순간에만 폭죽(작업 내역에서 옛 완성본을 열 땐 안 터짐)
    if (p.status === 'completed' && prevRender.id === p.id && prevRender.status && prevRender.status !== 'completed') celebrate();
    prevRender = {id: p.id, status: p.status};
    const prog = progressOf(p);
    el('log').textContent = p.logs.join('\n');
    const busy = active(p), disabled = busy ? 'disabled' : '';
    el('studio-editor').classList.remove('hidden');
    el('studio-editor').innerHTML = `
      <div class="modal-head"><h2>대본 검토 · 장면 편집</h2><span class="badge">${stateNames[p.status]}</span></div>
      <div class="job-status"><span class="job-phase">${escape(p.phase || '')}</span><span id="job-elapsed" class="job-elapsed">${elapsedText(p)}</span></div>
      ${prog !== null ? `<div class="energy"><div class="energy-fill${busy ? ' anim' : ''}" style="width:${prog}%"></div></div><p class="energy-label">${prog}%${busy ? ' 진행 중…' : p.status === 'completed' ? ' 완성! 🎉' : ''}</p>` : ''}
      <p id="editor-message" class="mini-state" role="status"></p>
      ${p.error ? `<p class="error" role="alert">${escape(p.error)}</p>` : ''}
      ${p.input.product ? `<div class="product-summary"><strong>고정된 상품 정보</strong><p>${escape(p.input.product.name)} · ${escape(p.input.product.price)}</p><p>${escape(p.input.product.benefit)}</p><p>${escape(p.input.product.url)}</p><small>상품 정보는 이 작업에서 변경되지 않습니다. 대본의 [상품명], [가격], [혜택]은 위 값으로 읽힙니다. 직접 쓰는 문구의 사실관계는 확인해주세요.</small></div>` : ''}
      ${p.scenes.length ? `<label class="field-label" for="edit-title">영상 제목</label><input id="edit-title" class="input" maxlength="120" value="${escape(p.title)}" ${disabled} />
      ${p.input.music ? `<label class="field-label" for="edit-music">배경음악 분위기</label><input id="edit-music" class="input" maxlength="1000" value="${escape(p.musicPrompt)}" ${disabled} />` : ''}
      <div class="scene-list">${p.scenes.map((s, i) => `
        <article class="scene-editor" data-scene="${i}">
          <h3>장면 ${i + 1}</h3>${(s.image && !s.imageCurrent) || (s.voice && !s.voiceCurrent) ? '<p class="hint">이전 생성 미리보기입니다. 최종 제작하면 수정 내용으로 갱신됩니다.</p>' : ''}
          <div class="scene-layout">
            <div>${s.image ? `<img class="scene-preview" src="${asset(p, s.image.file)}" alt="장면 ${i + 1} 이미지" />` : p.input.mode === 'manual' ? `<img class="scene-preview" src="${asset(p, p.sources[s.imageIndex])}" alt="선택한 원본 사진" />` : '<div class="scene-preview placeholder">제작 후 이미지가 표시됩니다</div>'}</div>
            <div>
              <label class="field-label" for="narration-${i}">나레이션 · 하단 자막</label><textarea id="narration-${i}" data-field="narration" class="input" rows="4" maxlength="1600" ${disabled}>${escape(displayText(s.narration))}</textarea>
              <div class="row"><label class="col field-label">상단 첫 줄<input data-field="hookTop" class="input" maxlength="120" value="${escape(displayText(s.hookTop))}" ${disabled} /></label><label class="col field-label">강조 문구<input data-field="hookAccent" class="input" maxlength="120" value="${escape(displayText(s.hookAccent))}" ${disabled} /></label></div>
              <label class="field-label">강조색 <input data-field="accentColor" type="color" value="${escape(s.accentColor)}" ${disabled} /></label>
              ${p.input.mode === 'manual' ? `<label class="field-label">원본 사진<select data-field="imageIndex" class="input" ${disabled}>${p.sources.map((_, n) => `<option value="${n}" ${s.imageIndex === n ? 'selected' : ''}>사진 ${n + 1}</option>`).join('')}</select></label>` : `<label class="field-label">이미지 설명<textarea data-field="visualPrompt" class="input" rows="2" maxlength="2000" ${disabled}>${escape(s.visualPrompt)}</textarea></label>`}
              ${s.voice ? `<audio controls preload="none" src="${asset(p, s.voice.file)}"></audio>` : ''}
              <div class="scene-actions">${p.input.mode === 'auto' ? `<button class="ghost-btn" data-action="image" data-index="${i}" ${disabled}>이미지만 다시 생성${costSuffix(p, s, 'image')}</button>` : ''}<button class="ghost-btn" data-action="voice" data-index="${i}" ${disabled}>음성만 다시 생성${costSuffix(p, s, 'voice')}</button></div>
            </div>
          </div>
        </article>`).join('')}</div>
        <p id="edit-state" class="mini-state" role="status">저장된 대본입니다. 수정한 장면만 새로 생성합니다.</p>
        <div class="cost-box dev-only">${priceText(p.estimate)}<small>남은 생성: 이미지 ${p.estimate.images}장 · 음성 ${p.estimate.characters}자. 입력 단가 기준이며 서버 비용·재시도 비용은 별도입니다.</small></div>
        <button class="ghost-btn" data-action="save" ${disabled}>대본 수정 저장</button>
        <button class="primary-btn" data-action="render" ${disabled}>${p.status === 'failed' ? '완료된 단계부터 이어서 재시작' : '2. 검토한 대본으로 최종 제작'}</button>
        <p class="mini-state">나레이션 수정은 해당 장면 음성을 다시 생성합니다. 상단 문구·색상만 바꾸면 음성을 재사용합니다. 장면별 음성은 이어지는 억양이 달라질 수 있습니다.</p>` : !busy ? '<button class="primary-btn" data-action="render">대본 작성 재시작</button>' : ''}
      ${p.output ? `<div class="studio-result"><h3>${p.outputRevision === p.revision ? '완성 영상' : '이전 완성본 — 수정 사항은 최종 제작 후 반영됩니다'}</h3><video class="result-video" controls preload="metadata" src="${asset(p, p.output)}"></video><button class="primary-btn" data-action="download">⬇ 영상 다운로드</button><div class="result-actions"><button class="ghost-btn" data-action="add-portfolio">🎬 포트폴리오에 추가</button><button class="btn-yt" data-action="youtube">📺 유튜브 올리기</button><button class="btn-ig" data-action="instagram">📷 인스타 올리기</button></div><p class="mini-state">앱에서 안 열리면 위 영상을 꾹 눌러 "동영상 저장"을 쓰세요. 포트폴리오는 완성 시 자동 등록되며, 필요하면 위 버튼으로 다시 넣을 수 있어요.</p></div>` : ''}
      <details ${busy || p.status === 'failed' ? 'open' : ''}><summary>제작 로그</summary><div class="scene-actions"><button class="ghost-btn" data-action="copy-log">로그 복사</button><button class="ghost-btn" data-action="expand-log">크게 보기</button></div><pre class="log">${escape(p.logs.join('\n'))}</pre></details>`;
    el('generate').disabled = busy;
    tickElapsed();
    // 로그를 항상 최신(맨 아래)으로 스크롤 — 상단 고정 문제 해결.
    const logEl = el('studio-editor').querySelector('.log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  function schedule() {
    clearTimeout(timer);
    if (!active(current)) return;
    timer = setTimeout(async () => {
      try {
        const id = current.id;
        const p = await api('/api/studio/' + id);
        if (current?.id !== id) return;
        render(p); if (!active(p)) await loadHistory(); schedule();
      } catch (e) { report(e); schedule(); }
    }, 1800);
  }
  async function open(id) {
    clearTimeout(timer);
    try { localStorage.setItem('onvideo-open', id); } catch {}
    render(await api('/api/studio/' + id)); schedule();
    el('studio-editor').scrollIntoView({behavior:'smooth', block:'start'});
  }
  // ★화면 내렸다(백그라운드) 돌아와도 안 멈추게 — 모바일은 백그라운드에서 폴링 타이머를 정지시킨다.
  //   제작은 서버에서 계속 돌므로, 복귀하는 즉시 최신 상태를 다시 받아 이어붙이고 폴링을 재개한다.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !active(current)) return;
    clearTimeout(timer);
    try {
      const id = current.id;
      const p = await api('/api/studio/' + id);
      if (current?.id === id) { render(p); if (!active(p)) await loadHistory(); }
    } catch (e) { report(e); }
    schedule();
  });
  el('studio-editor').addEventListener('input', () => {
    dirty = true;
    const status = el('edit-state');
    if (status) status.textContent = '저장하지 않은 수정이 있습니다. 먼저 저장하면 남은 예상 비용을 다시 계산합니다.';
  });
  async function save() {
    if (!dirty) return;
    const scenes = [...document.querySelectorAll('.scene-editor')].map((box, i) => {
      const s = {...current.scenes[i]};
      box.querySelectorAll('[data-field]').forEach(input => { s[input.dataset.field] = input.dataset.field === 'imageIndex' ? Number(input.value) : ['narration','hookTop','hookAccent'].includes(input.dataset.field) ? storeText(input.value) : input.value; });
      return s;
    });
    render(await api('/api/studio/' + current.id, {revision:current.revision, title:el('edit-title').value,
      musicPrompt:el('edit-music')?.value ?? current.musicPrompt, scenes}, 'PUT'));
    await loadHistory(); message('대본을 저장했습니다.');
  }
  el('studio-editor').onclick = async e => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'copy-log') { copyLog(button); return; }
    if (button.dataset.action === 'expand-log') { el('log-expand').click(); return; }
    if (button.dataset.action === 'download') { downloadVideo(button); return; }
    if (button.dataset.action === 'add-portfolio') {
      try {
        await api(`/api/studio/${current.id}/portfolio`, {});
        button.textContent = '✓ 포트폴리오에 추가됨'; button.disabled = true;
        message('포트폴리오에 추가했습니다. 목소리 페이지에서 확인하세요.');
      } catch (err) { report(err); }
      return;
    }
    if (button.dataset.action === 'youtube') { openYouTube(button); return; }
    if (button.dataset.action === 'instagram') { openInstagram(button); return; }
    if (loading || active(current)) return;
    loading = true;
    try {
      const action = button.dataset.action;
      if (action === 'save') await save();
      else {
        if (dirty) { message('대본 수정 저장을 먼저 눌러 예상 비용과 수정 내용을 확인하세요.', true); return; }
        button.disabled = true;
        const endpoint = action === 'render' ? 'render' : `scenes/${button.dataset.index}/${action}`;
        render(await api(`/api/studio/${current.id}/${endpoint}`, {revision:current.revision}));
        schedule(); await loadHistory();
      }
    } catch (err) { report(err); button.disabled = false; }
    finally { loading = false; }
  };
  el('generate').onclick = async () => {
    if (loading) return;
    // 카드뉴스 모드는 studio 작업 시스템이 아니라 전용 카드 파이프라인(app.js)으로 처리.
    if (typeof mode !== 'undefined' && mode === 'card') { if (window.startCardGen) window.startCardGen(); return; }
    if (dirty) { message('편집 중인 대본을 먼저 저장하세요.', true); return; }
    loading = true; el('generate').disabled = true; message('대본 작업을 준비하고 있습니다…');
    try {
      const images = [];
      if (mode === 'manual') {
        const files = [...el('images').files];
        if (!files.length || files.length > 20) throw new Error('이미지는 1~20장 선택하세요.');
        if ([...el('videos').files].length) throw new Error('새 장면 편집은 사진을 지원합니다. 영상 파일 선택을 해제하세요.');
        if (files.reduce((n, f) => n + f.size, 0) > 21 * 1024 * 1024) throw new Error('사진 전체 크기를 21MB 이하로 줄여주세요.');
        for (const file of files) {
          if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('JPG·PNG·WebP 사진만 지원합니다.');
          images.push(await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('사진을 읽지 못했습니다.')); reader.readAsDataURL(file); }));
        }
      }
      const product = el('product-lock').checked ? Object.fromEntries(['name','price','benefit','url'].map(k => [k, el('product-' + k).value.trim()])) : null;
      const p = await api('/api/studio', {mode, url:el('url').value.trim(), topic:el('topic-input') ? el('topic-input').value.trim() : '', images, keywords:el('keywords').value.trim(), facts:el('facts').value.trim(),
        duration:Number(el('duration').value), voice:el('voice').value, presetId:selectedPreset || '', quality:el('quality').value,
        imageStyle:el('image-style') ? el('image-style').value : 'real',
        characterId:el('character-select') ? el('character-select').value : '',
        sceneCount:Number(el('scene-count')?.value) || 0,
        aiClips:Number(el('aiClips')?.value) || 0, autoShutdown:el('auto-shutdown') ? el('auto-shutdown').checked : true,
        music:el('v-bgm') ? el('v-bgm').checked : true, product, rates:rates()});
      try { localStorage.setItem('onvideo-open', p.id); } catch {}
      render(p); schedule(); await loadHistory();
      el('studio-editor').scrollIntoView({behavior:'smooth'}); message('대본 작성이 시작됐습니다. 작업 내역에서 다시 열 수 있습니다.');
    } catch (e) { report(e); }
    finally { loading = false; el('generate').disabled = active(current); }
  };

  // ── 📚 배치 생성: 주제 여러 개 → 순차 자동 제작 ──
  let batchTimer = null;
  const batchStart = el('batch-start');
  if (batchStart) batchStart.onclick = async () => {
    const topics = el('batch-topics').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!topics.length) { alert('주제를 한 줄에 하나씩 입력하세요.'); return; }
    if (!selectedPreset) { alert('아래에서 카테고리를 먼저 골라주세요.'); return; }
    batchStart.disabled = true; batchStart.textContent = '큐에 등록 중…';
    try {
      await api('/api/batch', {
        topics,
        presetId: selectedPreset || '', duration: Number(el('duration').value),
        voice: el('voice').value, quality: el('quality').value,
        imageStyle: el('image-style') ? el('image-style').value : 'real',
        characterId: el('character-select') ? el('character-select').value : '',
        music: el('v-bgm') ? el('v-bgm').checked : true,
      });
      el('batch-topics').value = '';
      renderBatch();
    } catch (e) { report(e); }
    finally { batchStart.disabled = false; batchStart.textContent = '📚 이 목록으로 순차 제작 시작'; }
  };
  const batchClear = () => api('/api/batch', null, 'DELETE').then(renderBatch).catch(() => {});
  async function renderBatch() {
    const box = el('batch-status'); if (!box) return;
    let d; try { d = await (await fetch('/api/batch')).json(); } catch { return; }
    if (!d.total) { box.hidden = true; return; }
    box.hidden = false;
    const icon = {queued: '⏳', creating: '✍️', rendering: '🎬', done: '✅', failed: '⚠️'};
    const label = {queued: '대기', creating: '대본 작성', rendering: '영상 제작', done: '완성', failed: '실패'};
    const rows = d.items.map(it => `<div class="batch-row ${it.status}"><span class="batch-ic">${icon[it.status] || ''}</span><span class="batch-tp">${escape(it.topic)}</span><span class="batch-st">${label[it.status] || ''}</span></div>`).join('');
    box.innerHTML = `
      <div class="batch-head"><b>진행 ${d.done}/${d.total}</b> <span class="mini-state">${d.pending ? `· 남은 ${d.pending}편 자동 제작 중…` : (d.running ? '' : '· 완료')}</span>
        ${d.pending ? '<button class="ghost-btn small" id="batch-clear" type="button">대기 취소</button>' : ''}</div>
      <div class="batch-list">${rows}</div>`;
    const bc = el('batch-clear'); if (bc) bc.onclick = batchClear;
  }
  function startBatchPoll() {
    renderBatch();
    if (batchTimer) return;
    batchTimer = setInterval(renderBatch, 6000);
  }
  window.startBatchPoll = startBatchPoll; // app.js setMode에서 호출
})();
