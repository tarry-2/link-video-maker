(() => {
  const el = id => document.getElementById(id);
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const labels = {draft:'대본', image:'이미지', voice:'음성', music:'배경음악'};
  const productLabels = {name:'상품명', price:'가격', benefit:'혜택', url:'구매 주소'};
  const displayText = text => String(text).replace(/\{\{product\.(name|price|benefit|url)\}\}/g, (_, k) => '[' + productLabels[k] + ']');
  const storeText = text => Object.entries(productLabels).reduce((s, [k, label]) => s.split('[' + label + ']').join('{{product.' + k + '}}'), text);
  const stateNames = {planning:'대본 작성 중', draft:'검토 가능', running:'제작 중', failed:'재시작 필요', completed:'완성'};
  let current = null, dirty = false, timer = null, loading = false;
  const active = p => p && ['planning', 'running'].includes(p.status);
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
    const count = n <= 30 ? 4 : n <= 60 ? 6 : Math.min(10, Math.ceil(n / 12));
    const r = rates();
    const chars = Math.round(n * 5.6); // 대본 예상 글자수
    const quantities = {draft:1, image:mode === 'manual' ? 0 : count, voice:chars / 1000, music:el('studio-music').checked ? n / 60 : 0};
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
    if (!el('studio-music').checked) html += `<br><small>· 배경음악 미포함(옵션 꺼짐)</small>`;
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
  // The existing pipeline does not implement AI clips. Do not estimate or charge for that option.
  el('aiClips').value = '0'; el('aiClips').disabled = true;
  el('aiClips').title = '장면 편집에서는 원본 사진 또는 AI 이미지를 사용합니다.';
  updateEstimate();
  async function loadHistory() {
    const rows = await api('/api/studio');
    el('studio-history').innerHTML = rows.length ? rows.map(p => `<button class="history-item" data-project="${p.id}"><span><strong>${escape(p.title)}</strong><small>${escape(new Date(p.updatedAt).toLocaleString('ko-KR'))}</small></span><span class="badge ${p.status === 'failed' ? 'error' : ''}">${stateNames[p.status]}</span></button>`).join('') : '<p class="mini-state">첫 대본을 만들어보세요.</p>';
  }
  const report = e => message(e.message || String(e), true);
  el('history-refresh').onclick = () => loadHistory().catch(report);
  document.addEventListener('onvideo-auth-ready', () => loadHistory().catch(report));
  el('studio-history').onclick = async e => {
    const button = e.target.closest('[data-project]');
    if (!button) return;
    if (dirty) { message('현재 대본의 수정 내용을 먼저 저장하세요.', true); return; }
    try { await open(button.dataset.project); } catch (err) { report(err); }
  };
  function render(p) {
    current = p; dirty = false;
    el('log').textContent = p.logs.join('\n');
    const busy = active(p), disabled = busy ? 'disabled' : '';
    el('studio-editor').classList.remove('hidden');
    el('studio-editor').innerHTML = `
      <div class="modal-head"><h2>대본 검토 · 장면 편집</h2><span class="badge">${stateNames[p.status]}</span></div>
      <p class="mini-state">${escape(p.phase)}</p><p id="editor-message" class="mini-state" role="status"></p>
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
      ${p.output ? `<div class="studio-result"><h3>${p.outputRevision === p.revision ? '완성 영상' : '이전 완성본 — 수정 사항은 최종 제작 후 반영됩니다'}</h3><video class="result-video" controls preload="metadata" src="${asset(p, p.output)}"></video><a class="ghost-btn" href="${asset(p, p.output)}" download="${escape(p.title.replace(/[\\/:*?"<>|]/g, '_'))}.mp4">영상 다운로드</a></div>` : ''}
      <details ${busy || p.status === 'failed' ? 'open' : ''}><summary>제작 로그</summary><div class="scene-actions"><button class="ghost-btn" data-action="copy-log">로그 복사</button><button class="ghost-btn" data-action="expand-log">크게 보기</button></div><pre class="log">${escape(p.logs.join('\n'))}</pre></details>`;
    el('generate').disabled = busy;
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
    render(await api('/api/studio/' + id)); schedule();
    el('studio-editor').scrollIntoView({behavior:'smooth', block:'start'});
  }
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
        music:el('studio-music').checked, product, rates:rates()});
      render(p); schedule(); await loadHistory();
      el('studio-editor').scrollIntoView({behavior:'smooth'}); message('대본 작성이 시작됐습니다. 작업 내역에서 다시 열 수 있습니다.');
    } catch (e) { report(e); }
    finally { loading = false; el('generate').disabled = active(current); }
  };
})();
