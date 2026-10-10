// 로컬 완성 영상을 라이브 포트폴리오에 올린다(/api/portfolio/import, 쿠키 인증).
const fs = require('fs');
const os = require('os');
const path = require('path');
const LIVE = 'https://video.xn--zk5biyyw.com';
const COOKIE = fs.readFileSync('/tmp/ov-cookie.txt', 'utf8').split('\n').map((l) => l.split('\t')).filter((a) => a[5] === 'onvideo_sess').map((a) => a[5] + '=' + a[6])[0] || '';

const JOBS = [
  {file: path.join(os.homedir(), 'Desktop', '테리', '[신버전]백설공주_이미지영상_v2.28.mp4'), title: '백설공주 실화? 디즈니가 숨긴 충격적 진실 3가지', origin: 'remake', orientation: 'portrait', durSec: 30},
  {file: path.join(os.homedir(), 'Desktop', '온비디오 창작 2026-10-10', '내 사랑을 배신한 그날, 운명의 시계가 거꾸로 돌기 시작했다', '내 사랑을 배신한 그날, 운명의 시계가 거꾸로 돌기 시작했다.mp4'), title: '내 사랑을 배신한 그날, 운명의 시계가 거꾸로 돌기 시작했다', origin: 'create', orientation: 'portrait', durSec: 30},
];

(async () => {
  for (const j of JOBS) {
    if (!fs.existsSync(j.file)) { console.log('❌ 파일 없음:', j.file); continue; }
    const mp4 = fs.readFileSync(j.file).toString('base64');
    console.log(`업로드: ${j.title.slice(0, 24)} (${(mp4.length / 1.37e6).toFixed(1)}MB)…`);
    const r = await fetch(LIVE + '/api/portfolio/import', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'Cookie': COOKIE},
      body: JSON.stringify({title: j.title, mp4, origin: j.origin, orientation: j.orientation, durSec: j.durSec}),
    });
    const d = await r.json().catch(() => ({}));
    console.log(r.ok ? `  ✅ 등록 projectId=${d.projectId}` : `  ❌ ${r.status} ${JSON.stringify(d).slice(0, 150)}`);
  }
})();
