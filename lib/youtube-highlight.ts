// 재사용(CC) 유튜브 영상 → 하이라이트 숏폼 여러 편 완성.
// 흐름: extractHighlights(다운+자막+Gemini구간+9:16크롭) → 각 클립을 fullBleed Scene으로 렌더(상단 후킹) →
//       data/studio/{projectId}/ 에 저장 + 포트폴리오 등록(기존 유튜브·인스타 자동 업로드 그대로 재사용).
// ★비용 0(GPU 생성 없음). CC BY는 출처 표기 의무 → 설명/포폴에 원작자+원본 링크 자동 포함.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pipelineKeys} from './keys';
import {extractHighlights} from './youtube-clip';
import {renderVideo, buildRenderPublic} from './render';
import {addPortfolio} from './portfolio';
import type {SceneData} from '../src/Scene';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FPS = 30;

export type HighlightJobResult = {projectId: string; file: string; title: string; hookTop: string}[];

// videoId(CC 영상) → N편의 완성 하이라이트 숏폼. 각 편은 독립 projectId(포폴·업로드 재사용).
export async function makeHighlights(
  videoId: string,
  meta: {title: string; channel: string},
  opts: {count?: number; clipSec?: number; log?: (m: string) => void} = {},
): Promise<HighlightJobResult> {
  const log = opts.log || (() => {});
  const k = pipelineKeys();
  // 1) 다운로드 + 하이라이트 구간 추출 + 9:16 크롭 (임시 폴더)
  const workDir = path.join(os.tmpdir(), `onvideo-hl-${videoId}-${Date.now()}`);
  log('[하이라이트] 재사용 영상에서 숏폼 소재를 뽑습니다…');
  const clips = await extractHighlights(videoId, workDir, k.gemini, {count: opts.count, clipSec: opts.clipSec, log});
  log(`[하이라이트] ${clips.length}개 구간 확보 — 후킹 자막 얹어 완성합니다.`);

  const attribution = `출처: ${meta.channel} — https://youtu.be/${videoId} (Creative Commons BY)`;
  const results: HighlightJobResult = [];

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const projectId = randomUUID();
    const studioDir = path.join(DATA_DIR, 'studio', projectId);
    await fsp.mkdir(studioDir, {recursive: true});

    // 렌더용 public 폴더(fonts/sfx + 이 작업 클립). Scene은 staticFile로 public 기준 상대경로를 읽는다.
    const jobRel = `jobs/highlight-${projectId}`;
    const pubClipDir = path.join(process.cwd(), 'public', jobRel);
    await fsp.mkdir(pubClipDir, {recursive: true});
    const clipName = 'clip.mp4';
    await fsp.copyFile(c.file, path.join(pubClipDir, clipName));

    // 클립 길이(초)로 프레임 수 산정.
    const durSec = Math.max(1, c.end - c.start);
    const scene: SceneData = {
      image: `${jobRel}/${clipName}`, // 폴백용(사용 안 함 — fullBleed가 video 사용)
      video: `${jobRel}/${clipName}`,
      fullBleed: true, // 이미 9:16 → 꽉 채우고 원본 소리 + 상단 후킹만
      hookTop: c.hookTop || meta.title.slice(0, 20),
      hookAccent: c.hookAccent || '',
      accentColor: '#FFE24B',
      words: [],
      durationInFrames: Math.round(durSec * FPS),
    };

    const output = `highlight-${i + 1}-${randomUUID().slice(0, 8)}.mp4`;
    // 로컬/볼륨 저장(기존 포폴 서빙 경로 resolveVideo가 data/studio/{id}/{output}에서 찾음).
    const outAbs = path.join(studioDir, output);
    const publicDir = await buildRenderPublic(jobRel);
    try {
      log(`[하이라이트] ${i + 1}/${clips.length} 편 렌더…`);
      await renderVideo([scene], 0, outAbs, log, undefined, undefined, publicDir, 'portrait');
    } finally {
      await fsp.rm(publicDir, {recursive: true, force: true});
      await fsp.rm(pubClipDir, {recursive: true, force: true}); // 렌더 끝났으니 public 클립 정리
    }

    const title = (c.hookTop || meta.title).slice(0, 80);
    // 포트폴리오 등록 → voices.html 카드 + 유튜브/인스타 자동 업로드 재사용.
    try {
      addPortfolio({
        projectId, title, output,
        voice: '원본 음성(CC)', category: '🎬 유튜브 하이라이트', goal: 'info',
        createdAt: new Date().toISOString(), orientation: 'portrait', kind: 'video',
      });
    } catch (e: any) { log('[하이라이트] 포트폴리오 등록 건너뜀: ' + (e?.message || '')); }
    // 출처(attribution)를 프로젝트 폴더에 남겨 업로드 설명에 쓸 수 있게.
    try { fs.writeFileSync(path.join(studioDir, 'attribution.txt'), attribution); } catch {}

    results.push({projectId, file: output, title, hookTop: c.hookTop || ''});
    log(`[하이라이트] ${i + 1}편 완성: ${title}`);
  }

  // 원본 작업 폴더 정리(용량 절약).
  try { await fsp.rm(workDir, {recursive: true, force: true}); } catch {}
  log(`[하이라이트] 총 ${results.length}편 완성! 포트폴리오에서 유튜브·인스타로 올릴 수 있어요.`);
  return results;
}
