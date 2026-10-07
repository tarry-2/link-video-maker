// 재사용(CC) 유튜브 영상 → 하이라이트 숏폼 여러 편 완성.
// 흐름: extractHighlights(다운+자막+Gemini구간+9:16크롭) → 각 클립을 fullBleed Scene으로 렌더(상단 후킹) →
//       data/studio/{projectId}/ 에 저장 + 포트폴리오 등록(기존 유튜브·인스타 자동 업로드 그대로 재사용).
// ★비용 0(GPU 생성 없음). CC BY는 출처 표기 의무 → 설명/포폴에 원작자+원본 링크 자동 포함.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pipelineKeys} from './keys';
import {extractHighlights} from './youtube-clip';
import {renderVideo, renderThumbnail, buildRenderPublic} from './render';
import {addPortfolio, listPortfolio} from './portfolio';
import {r2Enabled, videoKey, uploadFile, getStream} from './storage';
import {geminiGenerate} from './gemini';
import {ttsElevenJoined, alignToWords, pickVoice, VOICES, type Word} from './tts';
import type {SceneData} from '../src/Scene';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FPS = 30;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 완성 영상(후킹 자막이 이미 입혀진 mp4)에서 프레임 1장을 뽑아 썸네일 PNG로 저장.
//   커버가 없으면 인스타/유튜브가 영상 첫 프레임(어두운 화면)을 집어가 미리보기가 빈다.
//   후킹이 자리잡은 지점(atSec)에서 뽑아 글자가 보이는 썸네일을 만든다.
function extractThumb(videoPath: string, outPng: string, atSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ps = spawn(FFMPEG, ['-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPng],
      {stdio: ['ignore', 'ignore', 'ignore']});
    const t = setTimeout(() => { ps.kill('SIGKILL'); resolve(false); }, 60000);
    ps.on('error', () => { clearTimeout(t); resolve(false); });
    ps.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(outPng)); });
  });
}

// 재사용 영상에 '내 관점의 해설'을 입혀 수익화(변형 가치) 기준을 충족시키기 위한 나레이션 대본 생성.
//   원본 대사(transcript)를 근거로 맥락·논평을 더한다(단순 중계/낭독 금지).
async function writeCommentary(
  geminiKeys: string[], title: string, transcript: string, hook: string, clipSec: number,
): Promise<string> {
  if (!geminiKeys.length) return '';
  const targetChars = Math.max(40, Math.round(clipSec * 3.0));
  const prompt = `너는 유튜브 '리뷰·해설' 채널 운영자다. 아래는 남의 영상(재사용)에서 가져온 한 장면이다.
이 장면에 '네 관점의 해설/논평'을 한국어로 입혀 영상에 깔 나레이션을 써라. 장면을 그대로 중계·낭독하지 말고,
배경·맥락 설명, 왜 중요한지, 포인트 짚기, 너의 해석 한마디를 넣어 '원본과 구별되는 가치'를 더해라.

영상 제목: ${title}
장면 상단 후킹: ${hook || '(없음)'}
장면 대사/내용: ${transcript || '(대사 없음 — 제목과 후킹으로 맥락 추론)'}

[규칙]
- 분량: 약 ${targetChars}자(이 장면 ${clipSec}초에 얹을 분량). 넘지 마라.
- 구어체로 말하듯. 첫 문장은 시청자를 붙잡는 한마디.
- 해설·논평·맥락 중심(받아쓰기·중계 금지).
- 해시태그·이모지·따옴표 없이 '읽을 문장'만.
JSON만 출력: {"commentary":"..."}`;
  try {
    const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 512, temperature: 0.8});
    const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    return m ? String(JSON.parse(m[0]).commentary || '').trim() : '';
  } catch { return ''; }
}

export type HighlightJobResult = {projectId: string; file: string; title: string; hookTop: string}[];

// videoId(CC 영상) → N편의 완성 하이라이트 숏폼. 각 편은 독립 projectId(포폴·업로드 재사용).
export async function makeHighlights(
  videoId: string,
  meta: {title: string; channel: string; isCc?: boolean},
  opts: {count?: number; clipSec?: number; log?: (m: string) => void; isCancelled?: () => boolean; orientation?: 'portrait' | 'landscape'; commentary?: boolean; voice?: string} = {},
): Promise<HighlightJobResult> {
  const log = opts.log || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const stopIfCancelled = () => { if (cancelled()) throw new Error('사용자가 중단했습니다.'); };
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const k = pipelineKeys();
  // 1) 다운로드 + 하이라이트 구간 추출 + 크롭(세로=블러레터박스 / 가로=원본) (임시 폴더)
  const workDir = path.join(os.tmpdir(), `onvideo-hl-${videoId}-${Date.now()}`);
  log(`[하이라이트] 재사용 영상에서 숏폼 소재를 뽑습니다…(${orientation === 'landscape' ? '가로 16:9' : '세로 9:16'})`);
  const clips = await extractHighlights(videoId, workDir, k.gemini, {count: opts.count, clipSec: opts.clipSec, log, isCancelled: cancelled, orientation});
  stopIfCancelled();
  log(`[하이라이트] ${clips.length}개 구간 확보 — 후킹 자막 얹어 완성합니다.`);

  // 출처 표기. CC 영상이면 (Creative Commons BY)까지 명시(합법 재사용 근거). 비-CC면 거짓표기하지 않고 출처만.
  const attribution = meta.isCc === false
    ? `출처: ${meta.channel} — https://youtu.be/${videoId}`
    : `출처: ${meta.channel} — https://youtu.be/${videoId} (Creative Commons BY)`;
  const results: HighlightJobResult = [];

  for (let i = 0; i < clips.length; i++) {
    stopIfCancelled();
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
    const clipFrames = Math.round(durSec * FPS);

    // ── 해설 나레이션(선택) — 원본에 '내 관점의 해설'을 입혀 수익화(변형 가치) 충족 ──
    //   Gemini로 해설 대본 → ElevenLabs TTS(단어 타이밍) → 원본 소리는 더킹, 카라오케 자막으로 표시.
    let words: Word[] = [];
    let voiceRel: string | undefined;
    let narrFrames = 0;
    if (opts.commentary) {
      const commentary = await writeCommentary(k.gemini, meta.title, c.transcript || '', c.hookTop || '', Math.round(durSec));
      if (commentary && k.elevenlabs) {
        log(`[하이라이트] ${i + 1}편 해설 나레이션 생성…`);
        try {
          const voiceId = VOICES[pickVoice(opts.voice, undefined)].id;
          const narrAbs = path.join(pubClipDir, 'narration.mp3'); // buildRenderPublic 전에 써야 복사됨
          const {align} = await ttsElevenJoined(k.elevenlabs, [commentary], narrAbs, voiceId);
          words = alignToWords(align, FPS);
          narrFrames = words.length ? words[words.length - 1].e + 15 : 0;
          voiceRel = `${jobRel}/narration.mp3`;
        } catch (e: any) { log('[하이라이트] 해설 음성 실패(원본 소리로 진행): ' + (e?.message || '')); }
      } else if (opts.commentary) {
        log('[하이라이트] 해설 대본/음성 키가 없어 원본 소리로 진행합니다.');
      }
    }

    const scene: SceneData = {
      image: `${jobRel}/${clipName}`, // 폴백용(사용 안 함 — fullBleed가 video 사용)
      video: `${jobRel}/${clipName}`,
      fullBleed: true, // 이미 비율 맞춤 → 꽉 채우고 상단 후킹 + (해설 시)카라오케 자막
      hookTop: c.hookTop || meta.title.slice(0, 20),
      hookAccent: c.hookAccent || '',
      accentColor: '#FFE24B',
      words, // 해설 있으면 카라오케 자막, 없으면 []
      duckAudio: !!voiceRel, // 해설 깔면 원본 소리를 줄인다
      // 해설이 클립보다 길면 나레이션 끝까지 담는다(안 그러면 말이 잘림).
      durationInFrames: Math.max(clipFrames, narrFrames),
    };

    // ★디자인 썸네일용 배경 = 후킹 글자 없는 '깨끗한' 원본 클립 프레임(c.file). 완성 mp4엔 후킹이 박혀
    //   있어 그걸 배경으로 쓰면 글자가 겹친다 → 반드시 원본 클립에서 뽑는다.
    const thumbName = 'thumb.png';
    const thumbAbs = path.join(studioDir, thumbName);
    const bgName = 'bg.png';
    const bgAbs = path.join(pubClipDir, bgName);
    let bgOk = false;
    try { bgOk = await extractThumb(c.file, bgAbs, Math.min(1.5, Math.max(0.3, durSec / 2))); } catch {}

    const output = `highlight-${i + 1}-${randomUUID().slice(0, 8)}.mp4`;
    // ★R2 활성이면 렌더 출력을 볼륨이 아니라 /tmp에 쓴다(studio와 동일). 볼륨(/app/data)이 꽉 차면
    //   Remotion 마지막 faststart 리먹스가 ENOSPC(exit 228)로 죽기 때문. /tmp는 컨테이너 로컬(수GB).
    const outAbs = r2Enabled()
      ? path.join(os.tmpdir(), `onvideo-hl-out-${projectId}-${output}`)
      : path.join(studioDir, output);
    let thumbOk = false;
    const publicDir = await buildRenderPublic(jobRel); // bg.png 포함(위에서 pubClipDir에 뽑음)
    try {
      log(`[하이라이트] ${i + 1}/${clips.length} 편 렌더…`);
      await renderVideo([scene], 0, outAbs, log, undefined, voiceRel, publicDir, orientation);
      // 디자인 썸네일(일반영상과 동일 Thumbnail 컴포지션) — 깨끗한 프레임 배경 + 후킹 큰글자 + 강조 뱃지.
      if (bgOk) {
        try {
          await renderThumbnail(
            {image: `${jobRel}/${bgName}`,
              big: (c.hookTop || meta.title).slice(0, 18),
              small: '',
              badge: (c.hookAccent || '').slice(0, 8),
              accentColor: '#FFE24B'},
            thumbAbs, log, publicDir, orientation,
          );
          thumbOk = fs.existsSync(thumbAbs);
        } catch (e: any) { log('[썸네일] 디자인 커버 실패, 프레임으로 대체: ' + (e?.message || '')); }
      }
      // 디자인 실패 시 폴백 = 완성 mp4 프레임 추출(후킹 박힌 화면이라도 커버는 생김).
      if (!thumbOk) {
        try { thumbOk = await extractThumb(outAbs, thumbAbs, Math.min(1.2, Math.max(0.3, durSec / 2))); } catch {}
      }
    } finally {
      await fsp.rm(publicDir, {recursive: true, force: true});
      await fsp.rm(pubClipDir, {recursive: true, force: true}); // 렌더 끝났으니 public 클립 정리
    }

    const title = (c.hookTop || meta.title).slice(0, 80);
    const createdAt = new Date().toISOString();

    // ★서버의 업로드·상세설명·서빙 스택(resolveVideo·ensureInstaVideoR2·readProject*·/portfolio-item)은
    //   전부 data/studio/{id}/project.json을 디스크에서 직접 읽는다. 영상·카드와 "똑같은 모양"의
    //   project.json을 써줘야 유튜브·인스타 업로드와 제목·설명 자동생성이 작동한다.
    //   (안 쓰면 resolveVideo가 null → "영상을 찾을 수 없습니다" / 상세설명 생성 실패.)
    const narrationSeed = [c.hookTop, c.hookAccent].filter(Boolean).join(' ').trim() || title;
    const proj: any = {
      id: projectId,
      title,
      status: 'completed',
      createdAt,
      output,
      orientation,
      // resolveVideo가 narrations/durSec를 scenes에서 뽑는다 → 메타 생성 재료로 후킹 문구를 넣는다.
      scenes: [{narration: narrationSeed, voice: {frames: Math.round(durSec * FPS)}}],
      input: {duration: Math.round(durSec)},
      kind: 'highlight',
      attribution, // CC BY 출처 — 상세설명/캡션에 자동 포함
    };
    // ★썸네일(커버) — 위에서 만든 디자인 커버(thumbAbs)를 project.json에 연결 + R2 업로드.
    if (thumbOk && fs.existsSync(thumbAbs)) {
      proj.thumb = thumbName;
      if (r2Enabled()) {
        try { const tk = videoKey(projectId, thumbName);
          if (await uploadFile(tk, thumbAbs, 'image/png')) proj.thumbR2 = tk; } catch {}
      }
    } else { log('[썸네일] 커버 생성 실패(커버 없이 진행)'); }
    // R2 활성이면 완성본(/tmp)을 R2로 올리고 삭제(볼륨 안 씀=228 회피). 실패하면 볼륨으로 폴백 복사해 로컬 서빙.
    if (r2Enabled()) {
      const volFile = path.join(studioDir, output);
      try {
        const key = videoKey(projectId, output);
        if (await uploadFile(key, outAbs, 'video/mp4')) { proj.outputR2 = key; fs.rmSync(outAbs, {force: true}); }
        else { fs.copyFileSync(outAbs, volFile); fs.rmSync(outAbs, {force: true}); }
      } catch (e: any) {
        log('[저장] R2 업로드 실패(로컬 보관): ' + (e?.message || e));
        try { fs.copyFileSync(outAbs, volFile); fs.rmSync(outAbs, {force: true}); } catch {}
      }
    }
    // R2 비활성이면 outAbs가 이미 볼륨(studioDir/output)이라 그대로 로컬 보관(폴백).
    try {
      const pjPath = path.join(studioDir, 'project.json');
      fs.writeFileSync(pjPath + '.tmp', JSON.stringify(proj));
      fs.renameSync(pjPath + '.tmp', pjPath);
    } catch (e: any) { log('[하이라이트] project.json 저장 실패: ' + (e?.message || '')); }

    // 포트폴리오 등록 → voices.html 카드 + 유튜브/인스타 자동 업로드 재사용.
    try {
      addPortfolio({
        projectId, title, output,
        voice: '원본 음성(CC)', category: '🎬 유튜브 하이라이트', goal: 'info',
        createdAt, orientation, kind: 'highlight',
      });
    } catch (e: any) { log('[하이라이트] 포트폴리오 등록 건너뜀: ' + (e?.message || '')); }
    // 출처(attribution)를 프로젝트 폴더에도 남긴다(상세설명 폴백 — project.json 읽기 실패 대비).
    try { fs.writeFileSync(path.join(studioDir, 'attribution.txt'), attribution); } catch {}

    results.push({projectId, file: output, title, hookTop: c.hookTop || ''});
    log(`[하이라이트] ${i + 1}편 완성: ${title}`);
  }

  // 원본 작업 폴더 정리(용량 절약).
  try { await fsp.rm(workDir, {recursive: true, force: true}); } catch {}
  log(`[하이라이트] 총 ${results.length}편 완성! 포트폴리오에서 유튜브·인스타로 올릴 수 있어요.`);
  return results;
}

// ★기존(구버전) 하이라이트 복구 — v1.80.0 전에 만든 하이라이트는 project.json/썸네일이 없어서
//   업로드·상세설명이 실패하고 커버(썸네일)도 빈다. mp4는 볼륨/ R2에 남아있으니 거기서 project.json과
//   썸네일을 만들어주면 되살아난다(새로 만들 필요 없음). 부팅 시 1회 실행.
export async function backfillHighlightProjects(log: (m: string) => void = () => {}): Promise<number> {
  let fixed = 0, thumbed = 0;
  for (const it of listPortfolio()) {
    if (it.kind !== 'highlight' || !it.projectId || !it.output) continue;
    const dir = path.join(DATA_DIR, 'studio', it.projectId);
    const pjPath = path.join(dir, 'project.json');
    const volMp4 = path.join(dir, it.output);

    // 1) project.json이 없으면 생성(볼륨에 mp4가 있어야 복구 가능).
    let proj: any = null;
    if (fs.existsSync(pjPath)) {
      try { proj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { proj = null; }
    }
    if (!proj) {
      if (!fs.existsSync(volMp4)) continue; // mp4가 사라졌으면 복구 불가(새로 만들어야 함)
      proj = {
        id: it.projectId, title: it.title, status: 'completed', output: it.output,
        orientation: it.orientation || 'portrait',
        scenes: [{narration: it.title || '', voice: {frames: 0}}],
        input: {duration: 30}, kind: 'highlight',
      };
      try {
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(pjPath + '.tmp', JSON.stringify(proj));
        fs.renameSync(pjPath + '.tmp', pjPath);
        fixed++;
      } catch (e: any) { log('[복구] ' + it.projectId + ' project.json 실패: ' + (e?.message || '')); continue; }
    }

    // 2) 썸네일(커버)이 없으면 영상에서 추출. 영상은 볼륨(volMp4) 또는 R2(proj.outputR2)에 있다.
    if (proj.thumb || proj.thumbR2) continue; // 이미 있으면 통과
    let srcMp4 = fs.existsSync(volMp4) ? volMp4 : '';
    let tmpDl = '';
    if (!srcMp4 && proj.outputR2) {
      try {
        const got = await getStream(proj.outputR2);
        if (got) {
          tmpDl = path.join(os.tmpdir(), `hl-bf-${it.projectId}.mp4`);
          await new Promise<void>((resolve, reject) => {
            const w = fs.createWriteStream(tmpDl);
            got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject);
          });
          srcMp4 = tmpDl;
        }
      } catch (e: any) { log('[복구] ' + it.projectId + ' R2 다운로드 실패: ' + (e?.message || '')); }
    }
    if (!srcMp4) continue; // 영상 소스 없음 → 썸네일 생략
    const thumbAbs = path.join(dir, 'thumb.png');
    try {
      const dur = Number(proj.input?.duration) || 30;
      const at = Math.min(1.2, Math.max(0.3, dur / 2));
      if (await extractThumb(srcMp4, thumbAbs, at)) {
        proj.thumb = 'thumb.png';
        if (r2Enabled()) {
          try { const tk = videoKey(it.projectId, 'thumb.png');
            if (await uploadFile(tk, thumbAbs, 'image/png')) proj.thumbR2 = tk; } catch {}
        }
        fs.writeFileSync(pjPath + '.tmp', JSON.stringify(proj));
        fs.renameSync(pjPath + '.tmp', pjPath);
        thumbed++;
      }
    } catch (e: any) { log('[복구] ' + it.projectId + ' 썸네일 실패: ' + (e?.message || '')); }
    finally { if (tmpDl) { try { fs.rmSync(tmpDl, {force: true}); } catch {} } }
  }
  if (fixed || thumbed) log(`[복구] 기존 하이라이트: project.json ${fixed}편 + 썸네일 ${thumbed}편 복구 완료.`);
  return fixed + thumbed;
}
