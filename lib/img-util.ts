// 이미지 포맷 변환 — 인스타 API는 JPEG만 받으므로 카드 PNG를 JPEG로 바꿀 때 사용.
// 별도 의존성 없이 시스템 ffmpeg(FFMPEG_PATH)로 변환(렌더에 이미 쓰는 바이너리).
import {spawn} from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function pngToJpeg(srcPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -q:v 2 = 고화질 JPEG. 흰 배경 합성(알파 제거)으로 투명 PNG도 안전.
    const p = spawn(FFMPEG, ['-y', '-i', srcPath, '-q:v', '2', outPath]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('JPEG 변환 실패: ' + err.slice(-200)))));
  });
}

// 영상에서 '커버용' 프레임 1장을 JPEG로 뽑는다(로컬 경로 또는 http(s) URL 모두 입력 가능).
//   ★인스타 릴스 커버 폴백 전용 — 우리 디자인 썸네일(thumb.png)이 없을 때 '검은 0프레임'을 피하려고
//     영상 중간 지점에서 뽑는다. thumbnail 필터로 seek 지점부터 N프레임 중 '대표(특징적) 프레임'을
//     고르게 해 암전·단색 프레임을 가급적 회피한다(공연 영상의 깜깜한 첫 장면 방지).
export function videoFrameToJpeg(srcPathOrUrl: string, outPath: string, atSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const at = Math.max(0, atSec || 0);
    const p = spawn(FFMPEG, ['-y', '-ss', String(at), '-i', srcPathOrUrl,
      '-vf', 'thumbnail=100', '-frames:v', '1', '-q:v', '2', '-update', '1', outPath]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('커버 프레임 추출 시간초과')); }, 60000);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('커버 프레임 추출 실패: ' + err.slice(-200))); });
  });
}

// 라이브러리/업로드용 — 긴 변 width 이하로 줄이고 고화질 JPEG로. 원본보다 크게 늘리진 않음(min).
export function resizeJpeg(srcPath: string, outPath: string, width = 1080): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-i', srcPath, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', '-frames:v', '1', '-update', '1', outPath]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('리사이즈 실패: ' + err.slice(-200)))));
  });
}
