// 🔤 폰트 느낌 미리보기 모달 — 영상/하이라이트 공용.
//   칩만 보면 글씨체 느낌을 모른다(테리) → 폰트별로 '실제 후킹 문구에 그 폰트가 적용된 모습'을
//   영상처럼(검은 배경 · 흰 상단줄 + 강조색 둘째줄) 크게 보여주고, 눌러서 바로 고른다.
//   선택은 해당 페이지의 기존 .font-chip을 click()해서 처리(선택 로직·저장 재사용).
(function () {
  var FONTS = [
    {f: '', name: '자동', note: '디자인에 맞춰 자동 선택'},
    {f: 'Black Han Sans', name: '임팩트'},
    {f: 'Do Hyeon', name: '도현'},
    {f: 'Jua', name: '주아'},
    {f: 'Gothic A1', name: '고딕'},
    {f: 'Noto Sans KR', name: '본고딕'},
    {f: 'Gaegu', name: '손글씨'},
    {f: 'Noto Serif KR', name: '명조'},
    {f: 'Gowun Batang', name: '고운바탕'},
    {f: 'Song Myung', name: '송명'},
  ];
  var TOP = '이게 실화냐?';      // 상단 후킹(흰색) 샘플
  var ACC = '소름 돋는 결말';     // 강조색 둘째줄 샘플

  window.openFontPreview = function (pickerSel) {
    var picker = document.querySelector(pickerSel);
    var cur = picker ? ((picker.querySelector('.font-chip.active') || {}).dataset || {}).font || '' : '';
    var wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML =
      '<div class="modal-box big">' +
      '<div class="modal-head"><h3 class="block-title">🔤 폰트 느낌 미리보기</h3>' +
      '<button class="ghost-btn small fpv-x" type="button">✕</button></div>' +
      '<p class="hint" style="margin-bottom:12px">영상 후킹에 실제로 이렇게 보여요. 눌러서 고르세요.</p>' +
      '<div class="fpv-grid">' +
      FONTS.map(function (x) {
        var ff = x.f ? ("'" + x.f + "'") : 'inherit';
        var sel = (x.f || '') === cur;
        return (
          '<button type="button" class="fpv-card' + (sel ? ' sel' : '') + '" data-f="' + x.f + '">' +
          '<div class="fpv-stage">' +
          '<div class="fpv-top" style="font-family:' + ff + '">' + TOP + '</div>' +
          '<div class="fpv-acc" style="font-family:' + ff + '">' + ACC + '</div>' +
          '</div>' +
          '<div class="fpv-name">' + x.name + (sel ? ' ✓' : '') +
          (x.note ? '<span class="hint"> · ' + x.note + '</span>' : '') + '</div>' +
          '</button>'
        );
      }).join('') +
      '</div></div>';
    document.body.appendChild(wrap);
    var close = function () { wrap.remove(); };
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.querySelector('.fpv-x').onclick = close;
    wrap.querySelectorAll('.fpv-card').forEach(function (c) {
      c.onclick = function () {
        var f = c.dataset.f || '';
        // 기존 칩을 눌러 선택(active 토글 + 저장 로직 재사용). 셀렉터 특수문자 없는 폰트명이라 그대로 사용.
        var chip = picker && picker.querySelector('.font-chip[data-font="' + f + '"]');
        if (chip) chip.click();
        close();
      };
    });
  };
})();
