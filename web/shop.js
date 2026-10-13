// 🛍 쇼핑 쇼츠 — 상품 링크 하나로 리뷰 쇼츠(카드형/나레이션형). 로그·진행·작업내역·업로드는
// 창작/하이라이트 페이지와 동일 수준(공통 인프라 그대로 이식). kind='shopping'·origin='shopping'으로 이원화.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  // ── 공통 보일러플레이트(테마·버전) — create.js와 동일 ──
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

  // ── 공용 모달 ──
  function modal(innerHtml, wire) {
    let box = $('sh-up-modal');
    if (!box) { box = document.createElement('div'); box.id = 'sh-up-modal'; document.body.appendChild(box); }
    box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:60';
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto">${innerHtml}</div>`;
    const close = () => box.remove();
    box.onclick = (e) => { if (e.target === box || e.target.closest('[data-x="close"]')) close(); };
    wire(box, close); return box;
  }

  // ── 상태 ──
  let STYLES = [['real', '실사'], ['anime', '애니'], ['cinema', '시네마'], ['classic', '고전']];
  let fmt = 'card';            // card | narration
  let linkMode = 'partner';    // partner | direct
  let style = 'real', voice = '';
  let count = 6, dur = 30, cardVideo = true, narr = true, bgm = true;
  let product = null;
  let curJobId = null, curES = null, startTs = 0, tickTimer = null, lastLogAt = 0;
  let shownResultId = null, resultTimer = null, lastJobId = null;

  // ── 세그 렌더 ──
  function seg(el, list, cur, attr) {
    if (!el) return;
    el.innerHTML = list.map((x) => {
      const [v, label] = Array.isArray(x) ? x : [x, x];
      return `<button type="button" class="seg-btn${String(cur) === String(v) ? ' active' : ''}" data-${attr}="${v}">${label}</button>`;
    }).join('');
  }
  function renderStyle() { seg($('sh-style'), STYLES, style, 's'); }
  function applyFormat() {
    document.querySelectorAll('#sh-format .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
    $('sh-card-opts').classList.toggle('hidden', fmt !== 'card');
    $('sh-narr-opts').classList.toggle('hidden', fmt !== 'narration');
    $('sh-fmt-note').textContent = fmt === 'card'
      ? '카드형 = 상품 사진 위에 핵심 문구를 얹은 카드들이 넘어가는 쇼츠(빠른 제작).'
      : '나레이션형 = 상품 사진을 바탕으로 성우가 리뷰하듯 소개하는 영상(장면 전환 + 음성).';
  }

  // ── 목소리/그림체 로드(영상만들기와 동일 /api/categories) ──
  async function loadVoices() {
    try {
      const res = await fetch('/api/categories'); if (!res.ok) return;
      const d = await res.json();
      if (Array.isArray(d.voices)) {
        const useName = {issue: '📰 이슈·미스터리', info: '💡 정보·건강', sell: '🛍️ 판매·리뷰', heal: '🌿 힐링·음식·여행', anime: '🎨 애니·동화·키즈'};
        const grouped = {};
        for (const v of d.voices) (grouped[v.use[0]] = grouped[v.use[0]] || []).push(v);
        let html = '<option value="">🎯 자동 추천(판매·리뷰 톤)</option>';
        for (const key of ['sell', 'heal', 'info', 'issue', 'anime']) {
          if (!grouped[key]) continue;
          html += `<optgroup label="${useName[key]}">` + grouped[key].map((v) => `<option value="${v.id}">${v.label} (${v.gender})</option>`).join('') + '</optgroup>';
        }
        const sel = $('sh-voice'); if (sel) { sel.innerHTML = html; sel.value = voice || ''; sel.onchange = () => { voice = sel.value; }; }
      }
      if (Array.isArray(d.styles) && d.styles.length) {
        STYLES = d.styles.map((s) => [s.id, `${s.emoji || ''} ${s.name}`.trim()]);
        if (!STYLES.some((x) => x[0] === style)) style = STYLES[0][0];
        renderStyle();
      }
    } catch {}
  }

  // ── 세그/토글 이벤트 ──
  $('sh-format').addEventListener('click', (e) => { const b = e.target.closest('[data-fmt]'); if (!b) return; fmt = b.dataset.fmt; applyFormat(); });
  $('sh-linkmode').addEventListener('click', (e) => { const b = e.target.closest('[data-linkmode]'); if (!b) return; linkMode = b.dataset.linkmode; document.querySelectorAll('#sh-linkmode .seg-btn').forEach((x) => x.classList.toggle('active', x === b)); });
  $('sh-style').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; style = b.dataset.s; renderStyle(); });
  $('sh-count').addEventListener('click', (e) => { const b = e.target.closest('[data-count]'); if (!b) return; count = Number(b.dataset.count); document.querySelectorAll('#sh-count .seg-btn').forEach((x) => x.classList.toggle('active', x === b)); });
  $('sh-dur').addEventListener('click', (e) => { const b = e.target.closest('[data-dur]'); if (!b) return; dur = Number(b.dataset.dur); document.querySelectorAll('#sh-dur .seg-btn').forEach((x) => x.classList.toggle('active', x === b)); });
  $('sh-card-video').addEventListener('change', (e) => { cardVideo = e.target.checked; });
  $('sh-narr').addEventListener('change', (e) => { narr = e.target.checked; });
  $('sh-bgm').addEventListener('change', (e) => { bgm = e.target.checked; });

  // ── 상품 불러오기 ──
  $('sh-fetch').addEventListener('click', async () => {
    const link = $('sh-link').value.trim();
    if (!link) { $('sh-msg').textContent = '상품 링크를 넣으세요.'; return; }
    $('sh-msg').textContent = '상품 불러오는 중…'; $('sh-preview').classList.add('hidden');
    try {
      const d = await (await fetch('/api/partner/product?url=' + encodeURIComponent(link), {cache: 'no-store'})).json();
      if (!d.product) throw new Error(d.error || '상품을 찾지 못했어요.');
      product = d.product;
      $('sh-img').src = product.image || '';
      $('sh-name').textContent = product.name || '';
      $('sh-price').textContent = product.price ? product.price.toLocaleString('ko-KR') + '원' : '';
      $('sh-preview').classList.remove('hidden');
      $('sh-msg').innerHTML = '<span style="color:var(--teal)">✅ 상품 확인됨 — 아래에서 바로 만들 수 있어요</span>';
      // 제휴 링크가 없는(온종일팜 다이렉트) 상품이면 다이렉트로 자동 고정.
      if (!product.partnerUrl && product.shopUrl) {
        linkMode = 'direct';
        document.querySelectorAll('#sh-linkmode .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.linkmode === 'direct'));
      }
    } catch (e) { $('sh-msg').textContent = '실패: ' + e.message; }
  });

  // ── 로그/에너지(create.js와 동일) ──
  function setEnergy(pct, label) { const e = $('sh-energy'); if (e) e.style.width = Math.max(4, Math.min(100, pct)) + '%'; const l = $('sh-energy-label'); if (l && label != null) l.textContent = label; }
  function getEnergy() { const e = $('sh-energy'); return e ? (parseFloat(e.style.width) || 0) : 0; }
  function addLog(m) { const box = $('sh-log'); if (!box) return; const d = document.createElement('div'); d.textContent = m; box.appendChild(d); box.scrollTop = box.scrollHeight; const big = $('sh-log-big'); if (big && !$('sh-log-modal').classList.contains('hidden')) { const d2 = document.createElement('div'); d2.textContent = m; big.appendChild(d2); big.scrollTop = big.scrollHeight; } }
  const logText = () => Array.from($('sh-log').children).map((d) => d.textContent).join('\n');
  $('sh-log-copy').onclick = () => navigator.clipboard?.writeText(logText());
  $('sh-log-clear').onclick = () => { $('sh-log').innerHTML = ''; };
  $('sh-log-expand').onclick = () => { $('sh-log-big').innerHTML = $('sh-log').innerHTML; $('sh-log-modal').classList.remove('hidden'); };
  $('sh-log-modal-close').onclick = () => $('sh-log-modal').classList.add('hidden');
  $('sh-log-modal-copy').onclick = () => navigator.clipboard?.writeText(logText());
  function startTick() {
    stopTick(); startTs = startTs || Date.now();
    tickTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startTs) / 1000);
      let txt = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      const quiet = (curJobId && lastLogAt) ? Math.floor((Date.now() - lastLogAt) / 1000) : 0;
      if (quiet >= 20) txt += ` · ⚠️ ${quiet}초째 새 소식 없음(무거운 단계 처리 중이거나 멈춤일 수 있어요)`;
      $('sh-elapsed').textContent = txt;
    }, 1000);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  // ── 제작 ──
  $('sh-make').onclick = async () => {
    const productLink = $('sh-link').value.trim();
    if (!productLink) { $('sh-make-state').textContent = '상품 링크를 넣고 "상품 불러오기"를 눌러 확인하세요.'; $('sh-link').focus(); return; }
    shownResultId = null; clearTimeout(resultTimer);
    $('sh-progress').classList.remove('hidden'); $('sh-result-block').classList.add('hidden');
    $('sh-log').innerHTML = ''; setEnergy(6, '시작…'); $('sh-make').disabled = true; $('sh-stop').classList.remove('hidden');
    $('sh-phase').textContent = '제작 준비'; startTs = Date.now(); startTick();
    try {
      let url, body;
      if (fmt === 'narration') {
        url = '/api/generate-shopping-video';
        body = {productLink, linkMode, duration: dur, imageStyle: style, narration: narr, bgm, voice: voice || undefined};
      } else {
        url = '/api/generate-cards';
        body = {productLink, linkMode, output: cardVideo ? 'video' : 'post', count, imageStyle: style, narration: cardVideo ? narr : false, bgm: cardVideo ? bgm : false, voice: voice || undefined};
      }
      const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '제작 실패');
      attach(d.id);
    } catch (e) { addLog('⚠️ ' + e.message); $('sh-make').disabled = false; $('sh-stop').classList.add('hidden'); stopTick(); setEnergy(100, '실패'); }
  };
  $('sh-stop').onclick = async () => { if (curJobId) { try { await fetch('/api/generate/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: curJobId})}); } catch {} addLog('중단 요청…'); } };

  function attach(id) {
    curJobId = id; lastJobId = id;
    if (curES) { try { curES.close(); } catch {} }
    try { localStorage.setItem('onvideo-shop-job', id); } catch {}
    $('sh-log').innerHTML = ''; // 서버가 로그를 처음부터 재전송 → 재연결 시 중복 방지(교체)
    const es = new EventSource('/api/progress?id=' + id); curES = es; let n = 0;
    startTick();
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.log) {
        addLog(m.log); n++;
        const mm = m.log.match(/^\[([^\]]+)\]/); if (mm) $('sh-phase').textContent = mm[1];
        lastLogAt = Date.now();
        const cur = getEnergy();
        const rm = m.log.match(/\[렌더\]\s*(\d+)%/);
        const sm = m.log.match(/장면\s*(\d+)\s*\/\s*(\d+)/);
        const cm = m.log.match(/카드\s*(\d+)\s*\/\s*(\d+)/);
        if (rm) { const rp = Number(rm[1]); setEnergy(72 + Math.min(27, rp * 0.27), `🎬 최종 합성 ${rp}%`); }
        else if (/\[렌더\]|영상 합성/.test(m.log)) setEnergy(Math.max(cur, 72), '🎬 최종 합성 준비…');
        else if (/배경음악/.test(m.log)) setEnergy(Math.max(cur, 70), '🎵 배경음악 까는 중…');
        else if (sm) { const i = Number(sm[1]), tot = Number(sm[2]) || 1; setEnergy(Math.max(cur, 8 + Math.min(1, i / tot) * 60), `🖼 그림·목소리 ${i}/${tot}…`); }
        else if (cm) { const i = Number(cm[1]), tot = Number(cm[2]) || 1; setEnergy(Math.max(cur, 8 + Math.min(1, i / tot) * 60), `🎴 카드 ${i}/${tot}…`); }
        else if (/\[쇼핑\]/.test(m.log)) setEnergy(Math.max(cur, 10), '🛍 상품 준비 중…');
        else if (/\[대본\]/.test(m.log)) setEnergy(Math.max(cur, 14), '✍️ 리뷰 대본 쓰는 중…');
        else setEnergy(Math.max(cur, Math.min(66, 8 + n)), '제작 중…');
      }
      if (m.done) {
        es.close(); curES = null; curJobId = null; stopTick();
        try { localStorage.removeItem('onvideo-shop-job'); } catch {}
        $('sh-make').disabled = false; $('sh-stop').classList.add('hidden');
        if (m.error) { setEnergy(100, m.error.includes('중단') ? '중단됨' : '실패'); addLog('⚠️ ' + m.error); return; }
        setEnergy(100, '완성! 🎉');
        const pid = m.projectId || (m.clips && m.clips[0] && m.clips[0].projectId);
        showResult(pid, m.title, m);
        loadHistory();
      }
    };
    es.onerror = () => { es.close(); if (curES === es) curES = null; };
  }

  async function viewServerLog(jobId) {
    if (!jobId) { alert('이 작업의 로그 id가 없어요(새로고침 전 작업).'); return; }
    try {
      const d = await (await fetch('/api/job-logs/' + encodeURIComponent(jobId))).json();
      const txt = (d.logs || []).join('\n') || '(로그가 비어 있어요)';
      if ($('sh-log-big')) $('sh-log-big').textContent = txt;
      if ($('sh-log-modal')) $('sh-log-modal').classList.remove('hidden');
    } catch { alert('로그를 불러오지 못했어요(서버 재시작 시 사라질 수 있어요).'); }
  }

  // ── 결과 카드 ──
  function showResult(projectId, title, m) {
    const box = $('sh-result-block'); if (!box) return;
    const key = projectId || '_done';
    if (key === shownResultId) return;
    shownResultId = key;
    box.classList.remove('hidden');
    // 카드게시물(캐러셀)은 mp4가 없음 — 작업 내역 안내만.
    const isPost = m && m.kind === 'card-post';
    if (!projectId || isPost) { box.innerHTML = '<p class="mini-state">✅ 완성됐어요 — 아래 작업 내역에서 확인하고 발송하세요.</p>'; return; }
    const b = Date.now();
    box.innerHTML = `<h2 class="block-title" style="margin:0 0 4px">🛍 쇼핑 쇼츠 완성!</h2>
      <p class="mini-state" style="margin-bottom:12px">크게보기·다운로드·유튜브·인스타 업로드할 수 있어요(구매 링크·제휴 고지 자동). 페북·스레드 발송은 🎬 포트폴리오 탭에서.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px">
        <div style="border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)">
          <video poster="/portfolio-thumb/${projectId}.png?b=${b}" src="/portfolio-item/${projectId}.mp4?b=${b}#t=0.5" controls playsinline preload="metadata" style="width:100%;display:block;background:#000;aspect-ratio:9/16;object-fit:cover"></video>
          <div style="padding:10px"><b style="display:block;margin-bottom:8px;font-size:14px">${esc(title || '쇼핑 쇼츠')}</b>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="ghost-btn small sh-big" data-id="${projectId}">🔍 크게보기</button>
              <a class="ghost-btn small" href="/portfolio-item/${projectId}.mp4" download="${esc(title || 'onvideo')}.mp4">⬇ 다운로드</a>
              <button type="button" class="ghost-btn small sh-yt" data-id="${projectId}">📺 유튜브</button>
              <button type="button" class="ghost-btn small sh-ig" data-id="${projectId}">📷 인스타</button>
              <button type="button" class="ghost-btn small sh-logview" data-job="${lastJobId || ''}">📋 로그</button>
            </div>
          </div>
        </div>
      </div>`;
    box.querySelector('.sh-big').onclick = (e) => bigView(e.target.dataset.id);
    box.querySelector('.sh-yt').onclick = (e) => uploadYouTube(e.target, e.target.dataset.id);
    box.querySelector('.sh-ig').onclick = (e) => uploadInstagram(e.target, e.target.dataset.id);
    const lv = box.querySelector('.sh-logview'); if (lv) lv.onclick = (e) => viewServerLog(e.target.dataset.job);
    box.scrollIntoView({behavior: 'smooth', block: 'start'});
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { box.classList.add('hidden'); box.innerHTML = ''; }, 5 * 60 * 1000);
  }

  function bigView(id) {
    const b = Date.now();
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2>미리보기</h2><button class="ghost-btn" data-x="close">✕</button></div>
      <video src="/portfolio-item/${id}.mp4?b=${b}" controls autoplay playsinline style="width:100%;max-height:78vh;border-radius:12px;background:#000;aspect-ratio:9/16;object-fit:contain"></video>`, () => {});
  }

  // ── 유튜브/인스타 업로드(create.js와 동일 — 캡션에 구매 링크·제휴 고지 자동) ──
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
  async function uploadInstagram(btn, id) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '📷 준비 중…';
    try {
      const st = await (await fetch('/api/instagram/status')).json();
      if (!st.connected) { alert('먼저 영상 만들기 화면의 ⚙ 키 설정에서 인스타 계정을 연결하세요.'); return; }
      btn.textContent = '📷 캡션 만드는 중…';
      const r = await fetch('/api/instagram/caption/' + encodeURIComponent(id)); const d = await r.json();
      if (!r.ok) throw new Error(d.error || '캡션 생성 실패');
      modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>📷 인스타 올리기</h2><button class="ghost-btn" data-x="close">✕</button></div>
        <input type="hidden" id="cu-k" value="reels">
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
    if (!confirm('이 쇼핑 쇼츠를 삭제할까요? (되돌릴 수 없어요)')) return;
    try { const r = await fetch('/api/portfolio/' + encodeURIComponent(id), {method: 'DELETE'}); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '삭제 실패'); } loadHistory(); }
    catch (e) { alert('삭제 실패: ' + e.message); }
  }

  // ── 🛍 쇼핑 쇼츠 작업 내역(origin=shopping만, 이원화) ──
  let histItems = [];
  async function loadHistory() {
    const box = $('sh-history'); if (!box) return;
    try {
      const d = await (await fetch('/api/portfolio', {cache: 'no-store'})).json();
      histItems = (Array.isArray(d.items) ? d.items : []).filter((it) => it.kind === 'mine' && it.origin === 'shopping');
      renderHistory();
    } catch { box.innerHTML = '<p class="mini-state">작업 내역을 불러오지 못했어요.</p>'; }
  }
  function renderHistory() {
    const box = $('sh-history'); if (!box) return;
    if (!histItems.length) { box.innerHTML = '<p class="mini-state">아직 만든 쇼핑 쇼츠가 없어요. 위에서 상품 링크로 만들어보세요.</p>'; return; }
    box.innerHTML = histItems.map((it) => {
      const yt = it.youtubeUrl ? ' <span class="badge">YT</span>' : '';
      const ig = it.instagramUrl ? ' <span class="badge">IG</span>' : '';
      const fb = it.facebookUrl ? ' <span class="badge">FB</span>' : '';
      const th = it.threadsUrl ? ' <span class="badge">TH</span>' : '';
      const when = it.createdAt ? new Date(it.createdAt).toLocaleString('ko-KR') : '';
      const isPost = it.kind === 'card-post';
      const dl = isPost ? '' : `<a class="ghost-btn small" href="${esc(it.video)}" download="${esc(it.title)}.mp4">⬇</a>`;
      const big = isPost ? '' : `<button type="button" class="ghost-btn small sh-h-big" data-id="${esc(it.id)}">🔍</button>`;
      return `<div class="history-item"><span><strong>${esc(it.title)}</strong><small>${esc(when)} · 🛍 쇼핑${it.productName ? ' · ' + esc(it.productName) : ''}${yt}${ig}${fb}${th}</small></span>
        <span class="hi-actions">
          ${big}${dl}
          ${isPost ? '' : `<button type="button" class="ghost-btn small sh-h-yt" data-id="${esc(it.id)}">📺</button><button type="button" class="ghost-btn small sh-h-ig" data-id="${esc(it.id)}">📷</button>`}
          <button type="button" class="ghost-btn small sh-h-del" data-id="${esc(it.id)}">🗑</button>
        </span></div>`;
    }).join('');
    box.querySelectorAll('.sh-h-big').forEach((b) => b.onclick = () => bigView(b.dataset.id));
    box.querySelectorAll('.sh-h-yt').forEach((b) => b.onclick = () => uploadYouTube(b, b.dataset.id));
    box.querySelectorAll('.sh-h-ig').forEach((b) => b.onclick = () => uploadInstagram(b, b.dataset.id));
    box.querySelectorAll('.sh-h-del').forEach((b) => b.onclick = () => del(b.dataset.id));
  }
  $('sh-history-refresh').onclick = loadHistory;

  // ── 기기 연동 + 새로고침 복원(진행 중인 쇼핑 작업에 다시 붙기) ──
  //   1순위 = 서버의 현재 작업(/api/jobs/current, 다른 기기 것도). 2순위 = 이 브라우저가 기억한 작업 id
  //   (localStorage) — currentGenJob이 다른 작업으로 덮여도 내 작업에 직접 재연결(새로고침해도 안 사라짐).
  async function syncCurrentJob() {
    if (curJobId) return;
    try {
      const d = await (await fetch('/api/jobs/current', {cache: 'no-store'})).json();
      if (d && d.id && d.kind === 'shopping') { $('sh-progress').classList.remove('hidden'); addLog('🔗 진행 중인 쇼핑 작업에 연결했어요(다른 기기에서 시작한 것도 보여요).'); attach(d.id); return; }
      if (d && d.done && d.done.kind === 'shopping') { lastJobId = d.doneId || d.done.id || lastJobId; showResult(d.done.projectId, d.done.title, d.done); loadHistory(); try { localStorage.removeItem('onvideo-shop-job'); } catch {} return; }
      // 2순위: 내가 기억한 작업 id가 아직 서버에서 살아있으면(덮여도) 직접 재연결.
      let saved = ''; try { saved = localStorage.getItem('onvideo-shop-job') || ''; } catch {}
      if (saved) {
        const jl = await (await fetch('/api/job-logs/' + encodeURIComponent(saved), {cache: 'no-store'})).json().catch(() => null);
        if (jl && !jl.error && jl.done === false) { $('sh-progress').classList.remove('hidden'); addLog('🔗 새로고침 전 작업에 다시 연결했어요.'); attach(saved); return; }
        try { localStorage.removeItem('onvideo-shop-job'); } catch {} // 끝났거나 사라진 작업
      }
    } catch {}
  }
  // 탭 복귀 시 연결이 끊겨 있으면(curJobId 있는데 live 연결 죽음) 다시 붙여 로그가 이어지게.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && curJobId && !curES) { const id = curJobId; curJobId = null; attach(id); }
  });

  // 🔆 작업 중 화면 꺼짐 방지
  let _wakeLock = null;
  async function _wakeSync() {
    try {
      if (curJobId && !_wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        _wakeLock = await navigator.wakeLock.request('screen');
        _wakeLock.addEventListener('release', () => { _wakeLock = null; });
      } else if (!curJobId && _wakeLock) { await _wakeLock.release(); _wakeLock = null; }
    } catch { _wakeLock = null; }
  }
  setInterval(_wakeSync, 3000);
  document.addEventListener('visibilitychange', _wakeSync);

  // 초기화
  renderStyle(); applyFormat(); loadVoices(); loadHistory();
  syncCurrentJob(); setInterval(syncCurrentJob, 4000);
})();
