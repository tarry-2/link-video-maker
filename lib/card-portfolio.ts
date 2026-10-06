// 카드 덱 → studio 프로젝트로 등록.
// ★핵심: 서버의 서빙·업로드·배지 스택(resolveVideo·readProject*·/portfolio-item·/portfolio-thumb·
//   유튜브/인스타 업로드)은 전부 data/studio/{id}/project.json을 디스크에서 직접 읽는다. 그래서 카드가
//   영상과 "똑같은 모양"의 project.json을 써주기만 하면 영상의 모든 기능(유튜브·인스타·썸네일·삭제·서빙)이
//   코드 수정 없이 그대로 재활용된다. 영상 studio.ts의 완성 처리(R2 업로드·썸네일·addPortfolio)와 동일 패턴.
import fs from 'node:fs';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {addPortfolio} from './portfolio';
import {r2Enabled, videoKey, uploadFile} from './storage';
import {renderCardStills, buildRenderPublic} from './render';
import type {CardData} from '../src/Card';

const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const studioDir = (id: string) => path.join(STUDIO_DATA_DIR, 'studio', id);

export type CardRegister = {
  cards: CardData[];
  title: string;
  kind: 'video' | 'post';
  out: string;              // video: 완성 mp4 절대경로. post면 미사용.
  images?: string[];        // post: public 상대경로 PNG 목록(캐러셀 순서).
  narrations: string[];     // 카드별 읽기 텍스트(유튜브/인스타 메타·캡션 생성용 resolveVideo.scenes).
  voice: string;            // 목소리 라벨(없으면 '카드뉴스').
  category: string;         // 카테고리 라벨.
  goal: 'issue' | 'info' | 'sell' | 'heal';
  orientation?: 'portrait' | 'landscape';
  durSec?: number;          // 전체 길이(초) — 메타 생성 참고.
  log?: (m: string) => void;
};

function writeProject(dir: string, proj: any) {
  fs.mkdirSync(dir, {recursive: true});
  const pj = path.join(dir, 'project.json');
  fs.writeFileSync(pj + '.tmp', JSON.stringify(proj));
  fs.renameSync(pj + '.tmp', pj);
}

export async function registerCardDeck(reg: CardRegister): Promise<string> {
  const log = reg.log || (() => {});
  const id = randomUUID(); // 36자 — 서버 서빙 라우트 정규식(^[0-9a-f-]{36}$)과 일치.
  const dir = studioDir(id);
  fs.mkdirSync(dir, {recursive: true});

  // resolveVideo가 narrations/durSec를 scenes에서 뽑으므로 영상과 같은 모양으로 넣는다.
  const fps = 30;
  const perFrames = reg.durSec ? Math.round((reg.durSec * fps) / Math.max(1, reg.cards.length)) : 90;
  const proj: any = {
    id,
    title: reg.title,
    status: 'completed',
    createdAt: new Date().toISOString(),
    scenes: reg.narrations.map((n) => ({narration: n, voice: {frames: perFrames}})),
    input: {duration: reg.durSec ? Math.round(reg.durSec) : 30},
    cardKind: reg.kind === 'post' ? 'card-post' : 'card',
  };

  if (reg.kind === 'video') {
    const output = 'video.mp4';
    const outAbs = path.join(dir, output);
    fs.copyFileSync(reg.out, outAbs); // 원본(out/)은 즉시 결과화면·다운로드에 쓰이므로 복사만(삭제는 기존 cleanup이 처리).

    // 썸네일(커버) = 커버 카드 스틸. 영상과 같은 scenes/폰트로 렌더되어 글자 안 깨지고 통일감.
    const coverIdx = Math.max(0, reg.cards.findIndex((c) => c.type === 'cover'));
    const thumbName = 'thumb.png';
    const thumbAbs = path.join(dir, thumbName);
    // ★썸네일은 글자를 상단 정렬(thumbTop) — 유튜브가 하단을 재생시간·제목으로 가리기 때문.
    // 캐시 번들엔 이 작업의 커버 bg 이미지가 없으므로(카드 영상/게시물과 동일 이유), 폰트 + 커버 작업
    // 폴더만 담은 전용 public 폴더로 렌더해 bg·폰트를 staticFile이 전부 찾게 한다.
    const coverCard = {...reg.cards[coverIdx], thumbTop: true};
    const thumbPublic = await buildRenderPublic(coverCard.bg ? path.dirname(coverCard.bg) : undefined);
    try {
      await renderCardStills([coverCard], [thumbAbs], log, thumbPublic);
    } catch (e: any) { log('[썸네일] 생성 건너뜀: ' + (e?.message || e)); }
    finally { await rm(thumbPublic, {recursive: true, force: true}); }

    proj.output = output;
    proj.thumb = fs.existsSync(thumbAbs) ? thumbName : undefined;
    proj.thumbR2 = undefined;
    proj.outputR2 = undefined;

    if (r2Enabled()) {
      try {
        const key = videoKey(id, output);
        if (await uploadFile(key, outAbs, 'video/mp4')) { proj.outputR2 = key; fs.rmSync(outAbs, {force: true}); }
        if (proj.thumb) {
          const tk = videoKey(id, thumbName);
          if (await uploadFile(tk, thumbAbs, 'image/png')) { proj.thumbR2 = tk; fs.rmSync(thumbAbs, {force: true}); }
        }
        log('[저장] 완성 카드영상을 클라우드(R2)에 올렸습니다.');
      } catch (e: any) { log('[저장] R2 업로드 일부 실패(로컬 보관): ' + (e?.message || e)); }
    }
    writeProject(dir, proj);
    addPortfolio({
      projectId: id, title: reg.title, output,
      voice: reg.voice, category: reg.category, goal: reg.goal,
      createdAt: proj.createdAt, orientation: reg.orientation || 'portrait', kind: 'card',
    });
  } else {
    // 게시물(캐러셀): PNG들을 studio 폴더로 복사 + R2.
    const names: string[] = [];
    const r2keys: string[] = [];
    const srcs = reg.images || [];
    for (let i = 0; i < srcs.length; i++) {
      const srcAbs = path.join(process.cwd(), 'public', srcs[i]);
      if (!fs.existsSync(srcAbs)) continue;
      const name = `card-${i + 1}.png`;
      const destAbs = path.join(dir, name);
      try { fs.copyFileSync(srcAbs, destAbs); } catch { continue; }
      names.push(name);
      if (r2Enabled()) {
        try { const key = videoKey(id, name); if (await uploadFile(key, destAbs, 'image/png')) { r2keys[names.length - 1] = key; fs.rmSync(destAbs, {force: true}); } }
        catch { /* R2 실패 → 로컬 보관 */ }
      }
    }
    proj.images = names;
    if (r2keys.length) proj.imagesR2 = r2keys;
    proj.thumb = names[0];
    if (r2keys[0]) proj.thumbR2 = r2keys[0];
    writeProject(dir, proj);
    addPortfolio({
      projectId: id, title: reg.title, output: '',
      voice: reg.voice, category: reg.category, goal: reg.goal,
      createdAt: proj.createdAt, orientation: 'portrait', kind: 'card-post', images: names,
    });
    if (r2keys.length) log('[저장] 카드 게시물을 클라우드(R2)에 올렸습니다.');
  }

  log('[완료] 포트폴리오에 자동 등록됐습니다.');
  return id;
}
