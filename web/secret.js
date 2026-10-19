// 시크릿 콘솔 — /api/secret/state 폴링해 상태·로그·스샷을 그리고, control로 봇을 조작한다.
//   진입 게이트(345678)는 클라이언트 표시용(숨김 유지). 실제 데이터는 온비디오 로그인 세션으로 보호됨.
(function () {
  'use strict';
  var GATE = '345678';
  var $ = function (id) { return document.getElementById(id); };

  // ── 게이트 ──
  function openApp() { $('gate').style.display = 'none'; $('app').style.display = 'block'; start(); }
  (function gate() {
    if (sessionStorage.getItem('ovsec') === GATE) { openApp(); return; }
    var inp = $('gate-pw'), err = $('gate-err');
    inp.focus();
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (inp.value === GATE) { sessionStorage.setItem('ovsec', GATE); openApp(); }
      else { err.textContent = '코드가 맞지 않습니다'; inp.value = ''; setTimeout(function () { err.textContent = ''; }, 1800); }
    });
  })();

  // ── 토글 ──
  function bindToggle(id) {
    var el = $(id);
    el.addEventListener('click', function () { el.classList.toggle('on'); });
    return { on: function () { return el.classList.contains('on'); }, set: function (v) { el.classList.toggle('on', !!v); } };
  }
  var tgProxy, tgVisible;

  // ── API ──
  function api(path, body) {
    return fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function control(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    return api('/api/secret/control', body).then(function (s) { if (s && s.status) render(s); return s; });
  }

  // ── 렌더 ──
  var lastLogN = -1, lastShot = '';
  function fmtTime(t) { var d = new Date(t); function p(n){return (n<10?'0':'')+n;} return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function classOf(m) {
    if (/✅|등록 완료|성공|달성/.test(m)) return 'ok';
    if (/⚠️|실패|필요|못 찾/.test(m)) return 'warn';
    if (/✕|오류|에러/.test(m)) return 'err';
    return '';
  }
  function render(s) {
    if (!s || !s.status) return;
    if (s.accounts) renderAccounts(s.accounts, s.account);
    var running = s.status === 'running', paused = s.status === 'paused';
    var led = $('led'); led.className = 'led' + (running ? ' on' : paused ? ' pause' : '');
    $('st-badge').textContent = running ? '가동중' : paused ? '일시정지' : (s.status === 'stopped' ? '정지' : '대기');
    $('st-count').textContent = (s.count || 0) + (s.dailyLimit ? ' / ' + s.dailyLimit : '');

    // 버튼 활성/비활성
    $('b-start').disabled = running;
    $('b-pause').disabled = !running;
    $('b-resume').disabled = !paused;
    $('b-stop').disabled = s.status === 'stopped' || s.status === 'idle';
    $('b-cancel').disabled = s.status === 'idle';

    // 로그(증분 렌더)
    var logs = s.logs || [];
    if (logs.length !== lastLogN) {
      var box = $('log');
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.innerHTML = logs.map(function (l) {
        var img = l.shot ? '<img src="' + l.shot + '" data-big="' + l.shot + '" alt="캡처">' : '';
        return '<div class="ln ' + classOf(l.m) + '"><span class="ts">' + fmtTime(l.t) + '</span><span class="mg">' + esc(l.m) + img + '</span></div>';
      }).join('');
      if (atBottom) box.scrollTop = box.scrollHeight;
      lastLogN = logs.length;
      // 최근 스샷 → 뷰어
      var withShot = logs.filter(function (l) { return l.shot; });
      if (withShot.length) {
        var last = withShot[withShot.length - 1];
        if (last.shot !== lastShot) {
          lastShot = last.shot;
          $('shot').style.display = 'block';
          $('shot-img').src = last.shot;
          $('shot-cap').textContent = fmtTime(last.t) + ' · 봇 캡처';
        }
      }
    }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ── 테마(라이트/다크) ──
  var theme = localStorage.getItem('ovsec-theme') || 'dark';
  function applyTheme() { document.body.setAttribute('data-theme', theme); var b = $('theme-toggle'); if (b) b.textContent = theme === 'light' ? '☀' : '☾'; }

  // ── 계정 목록 렌더(변경 있을 때만) ──
  var lastAccJson = '';
  function renderAccounts(accs, sel) {
    accs = accs || [];
    var key = JSON.stringify(accs) + '|' + (sel || '');
    if (key === lastAccJson) return; // 변경 없으면 skip(select 조작 방해 방지)
    lastAccJson = key;
    var selEl = $('f-acct-sel');
    if (document.activeElement !== selEl) {
      selEl.innerHTML = accs.length
        ? accs.map(function (a) { return '<option value="' + esc(a.label) + '"' + (a.label === sel ? ' selected' : '') + '>' + esc(a.label) + (a.loggedIn ? ' ✓' : ' (로그인 필요)') + '</option>'; }).join('')
        : '<option value="">계정 없음 — 아래에서 추가하세요</option>';
    }
    $('acct-list').innerHTML = accs.map(function (a) {
      var st = a.loggedIn ? '<span style="color:var(--neon)">● 연결됨</span>'
        : (a.lastError ? '<span style="color:var(--red)">❌ ' + esc(a.lastError) + '</span>' : '<span style="color:var(--amber)">○ 연결 안 됨</span>');
      var relink = a.loggedIn ? '' : '<button data-relink="' + esc(a.label) + '" style="background:none;border:1px solid var(--line);color:var(--neon);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:10px;padding:2px 7px">다시 연결</button>';
      return '<div style="display:flex;align-items:center;gap:8px;font-size:11px;padding:6px 0;border-bottom:1px solid var(--line)">' +
        '<span style="flex:1;color:var(--tx)">' + esc(a.label) + ' <i style="color:var(--dim2);font-style:normal">@' + esc(a.username || '') + '</i><br><span style="font-size:10px">' + st + '</span></span>' +
        relink +
        '<button data-rm="' + esc(a.label) + '" style="background:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:10px;padding:2px 7px">삭제</button></div>';
    }).join('');
  }

  // ── 모달(크게보기) ──
  function bigImg(src) { $('modal-body').innerHTML = '<img src="' + src + '">'; $('modal').classList.add('show'); }
  function bigText(txt) { $('modal-body').innerHTML = '<pre></pre>'; $('modal-body').querySelector('pre').textContent = txt; $('modal').classList.add('show'); }
  $('modal-x').addEventListener('click', function () { $('modal').classList.remove('show'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.remove('show'); });
  $('log').addEventListener('click', function (e) { var b = e.target.getAttribute && e.target.getAttribute('data-big'); if (b) bigImg(b); });
  $('shot-img').addEventListener('click', function () { if (lastShot) bigImg(lastShot); });

  // ── 폴링 ──
  var timer = null;
  function tick() { api('/api/secret/state').then(function (s) { if (s && !s.error) render(s); }); }
  function start() {
    tgProxy = bindToggle('tg-proxy'); tgVisible = bindToggle('tg-visible');
    $('b-start').addEventListener('click', function () {
      var kw = $('f-keyword').value.trim();
      if (!kw) { $('f-keyword').focus(); return; }
      control('start', {
        keyword: kw, account: ($('f-acct-sel').value || 'main'),
        dailyLimit: +$('f-limit').value || 20, termSec: +$('f-term').value || 180,
        proxyOn: tgProxy.on(), visible: tgVisible.on(),
      });
    });
    $('b-pause').addEventListener('click', function () { control('pause'); });
    $('b-resume').addEventListener('click', function () { control('resume'); });
    $('b-stop').addEventListener('click', function () { control('stop'); });
    $('b-cancel').addEventListener('click', function () { if (confirm('취소하면 오늘 카운트도 0으로 돌아가요. 계속할까요?')) control('cancel'); });
    $('b-clear').addEventListener('click', function () { control('clear'); lastLogN = -1; });
    $('b-copy').addEventListener('click', function () {
      var txt = Array.prototype.map.call($('log').querySelectorAll('.ln'), function (ln) { return ln.textContent; }).join('\n');
      navigator.clipboard.writeText(txt).then(function () { var b = $('b-copy'); b.textContent = '복사됨!'; setTimeout(function () { b.textContent = '⧉ 복사'; }, 1200); });
    });
    $('b-big').addEventListener('click', function () {
      var txt = Array.prototype.map.call($('log').querySelectorAll('.ln'), function (ln) { return ln.textContent; }).join('\n');
      bigText(txt);
    });
    // 테마
    applyTheme();
    $('theme-toggle').addEventListener('click', function () { theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('ovsec-theme', theme); applyTheme(); });
    // 계정 관리
    $('b-acct-add').addEventListener('click', function () { var f = $('acct-form'); f.style.display = f.style.display === 'none' ? 'block' : 'none'; });
    $('a-pw-eye').addEventListener('click', function () { var i = $('a-pw'); var show = i.type === 'password'; i.type = show ? 'text' : 'password'; this.textContent = show ? '🙈' : '👁'; i.focus(); });
    $('a-save').addEventListener('click', function () {
      var label = $('a-label').value.trim() || 'main', id = $('a-id').value.trim(), pw = $('a-pw').value;
      if (!id || !pw) { alert('아이디와 비밀번호를 입력하세요'); return; }
      api('/api/secret/account/add', { label: label, id: id, pw: pw }).then(function (r) {
        if (r.error) { alert(r.error); return; }
        $('a-pw').value = ''; $('a-id').value = ''; $('acct-form').style.display = 'none';
        lastAccJson = ''; renderAccounts(r.accounts, r.account);
      });
    });
    $('f-acct-sel').addEventListener('change', function () { if (this.value) api('/api/secret/account/select', { label: this.value }); });
    $('acct-list').addEventListener('click', function (e) {
      var t = e.target;
      var relink = t.getAttribute && t.getAttribute('data-relink');
      if (relink) { $('acct-form').style.display = 'block'; $('a-label').value = relink; $('a-id').value = ''; $('a-pw').value = ''; $('a-id').focus(); return; }
      var rm = t.getAttribute && t.getAttribute('data-rm');
      if (rm && confirm('"' + rm + '" 계정을 뺄까요? (세션도 끊겨요)')) api('/api/secret/account/remove', { label: rm }).then(function (r) { lastAccJson = ''; renderAccounts(r.accounts, r.account); });
    });
    // 버전 배지(재배포 확인용)
    fetch('/api/version').then(function (r) { return r.json(); }).then(function (j) { if (j && j.version) $('ver-badge').textContent = 'v' + j.version; }).catch(function () {});
    tick();
    timer = setInterval(tick, 2000);
  }
})();
