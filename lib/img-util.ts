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
