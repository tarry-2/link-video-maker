// 완성된 '일반 영상'(makeVideo 출력)을 studio 프로젝트로 등록 → 포트폴리오 편입.
// ★핵심은 card-portfolio.ts와 동일: 서버의 서빙·업로드·배지 스택(resolveVideo·readProject*·/portfolio-item·
//   유튜브/인스타 업로드·삭제)은 전부 data/studio/{id}/project.json을 디스크에서 직접 읽는다. 영상과 "똑같은
//   모양"의 project.json + addPortfolio만 써주면 그 모든 기능이 코드 수정 없이 재활용된다.
//   재창작(/api/generate-remake) 영상이 유튜브·인스타에 올라가려면 이 등록이 필요하다(테리 지시).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {addPortfolio} from './portfolio';
import {r2Enabled, videoKey, uploadFile} from './storage';

const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const studioDir = (id: string) => path.join(STUDIO_DATA_DIR, 'studio', id);

function writeProject(dir: string, proj: any) {
  fs.mkdirSync(dir, {recursive: true});
  const pj = path.join(dir, 'project.json');
  fs.writeFileSync(pj + '.tmp', JSON.stringify(proj));
  fs.renameSync(pj + '.tmp', pj);
}

export type VideoRegister = {
  out: string;               // 완성 mp4 절대경로
  title: string;
  thumb?: string;            // ★후킹 박힌 전용 썸네일(png) 절대경로 — 있으면 이걸 커버로(없으면 첫 장면 이미지 폴백).
  imageDir?: string;         // 장면 이미지 폴더(img-N.jpg) — 첫 이미지를 썸네일로 쓴다.
  narrations?: string[];     // 장면별 나레이션(유튜브/인스타 설명 생성용). 없으면 제목으로 폴백.
  voice: string;             // 목소리 라벨.
  category: string;          // 카테고리 라벨.
  goal?: 'issue' | 'info' | 'sell' | 'heal';
  orientation?: 'portrait' | 'landscape';
  durSec?: number;
  attribution?: string;      // 출처 표기(재창작 소재).
  source?: 'search' | 'url' | 'upload' | 'archive';
  origin?: 'video' | 'remake' | 'create'; // ★작업내역 탭별 이원화(영상만들기/재창작/창작).
  motion?: boolean;          // 움직이는 영상(Wan)인지 — 작업내역 '🎬 영상' 배지.
  log?: (m: string) => void;
};

export async function registerVideoToPortfolio(reg: VideoRegister): Promise<string> {
  const log = reg.log || (() => {});
  const id = randomUUID(); // 36자 — 서버 서빙 라우트 정규식(^[0-9a-f-]{36}$)과 일치.
  const dir = studioDir(id);
  fs.mkdirSync(dir, {recursive: true});

  const fps = 30;
  const narrations = (reg.narrations && reg.narrations.length) ? reg.narrations : [reg.title];
  const perFrames = reg.durSec ? Math.round((reg.durSec * fps) / Math.max(1, narrations.length)) : 90;
  const proj: any = {
    id, title: reg.title, status: 'completed', createdAt: new Date().toISOString(),
    // resolveVideo가 narrations/durSec를 scenes에서 뽑는다 → 영상과 같은 모양.
    scenes: narrations.map((n) => ({narration: n, voice: {frames: perFrames}})),
    input: {duration: reg.durSec ? Math.round(reg.durSec) : 30},
    orientation: reg.orientation || 'portrait',
    attribution: reg.attribution,
  };

  const output = 'video.mp4';
  const outAbs = path.join(dir, output);
  fs.copyFileSync(reg.out, outAbs);

  // 썸네일 — ①후킹 박힌 전용 썸네일(reg.thumb, png)이 있으면 그걸 커버로(다른 탭과 동일, 미리보기·클릭률↑).
  //   ②없으면 첫 장면 이미지 복사(폴백). 서빙 라우트는 .png를 기대하므로 전용 썸네일은 thumb.png로 둔다.
  let thumbName: string | undefined;
  try {
    if (reg.thumb && fs.existsSync(reg.thumb)) {
      thumbName = 'thumb.png';
      fs.copyFileSync(reg.thumb, path.join(dir, thumbName));
    } else if (reg.imageDir && fs.existsSync(reg.imageDir)) {
      const imgs = fs.readdirSync(reg.imageDir).filter((f) => /img-\d+\.(jpg|png)$/.test(f)).sort();
      if (imgs.length) {
        const ext = path.extname(imgs[0]).toLowerCase() === '.png' ? '.png' : '.jpg';
        thumbName = 'thumb' + ext;
        fs.copyFileSync(path.join(reg.imageDir, imgs[0]), path.join(dir, thumbName));
      }
    }
  } catch {}

  proj.output = output;
  if (thumbName) proj.thumb = thumbName;

  if (r2Enabled()) {
    try {
      const key = videoKey(id, output);
      if (await uploadFile(key, outAbs, 'video/mp4')) { proj.outputR2 = key; fs.rmSync(outAbs, {force: true}); }
      if (thumbName) {
        const tAbs = path.join(dir, thumbName);
        const tk = videoKey(id, thumbName);
        if (fs.existsSync(tAbs) && await uploadFile(tk, tAbs, thumbName.endsWith('.png') ? 'image/png' : 'image/jpeg')) {
          proj.thumbR2 = tk; fs.rmSync(tAbs, {force: true});
        }
      }
      log('[저장] 완성 영상을 클라우드(R2)에 올렸습니다.');
    } catch (e: any) { log('[저장] R2 업로드 일부 실패(로컬 보관): ' + (e?.message || e)); }
  }

  writeProject(dir, proj);
  if (reg.motion) proj.motion = true;
  addPortfolio({
    projectId: id, title: reg.title, output,
    voice: reg.voice, category: reg.category, goal: reg.goal || 'issue',
    createdAt: proj.createdAt, orientation: reg.orientation || 'portrait',
    kind: 'video', origin: reg.origin || 'video', source: reg.source || 'archive', attribution: reg.attribution,
    motion: !!reg.motion,
  });
  log('[완료] 포트폴리오에 등록됐습니다 — 유튜브·인스타 업로드·다운로드 가능.');
  return id;
}
