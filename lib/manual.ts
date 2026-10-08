// 수동 모드 — 사용자가 직접 넣은 이미지들 + 키워드/팩트로 영상 생성.
// Gemini 비전이 이미지를 직접 보고: 좋은 것 선별 → 순서 배치 → 각 이미지에 맞는 후킹·자막·나레이션 생성.
// 이 모드는 Flux 생성 안 함(사용자 이미지 그대로 사용).
import {readFile, mkdir, copyFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {geminiGenerate, type GeminiImage} from './gemini';
import {openaiJson} from './openai';
import {ttsElevenJoined, alignToWords, VOICES, DEFAULT_VOICE} from './tts';
import {generateBgm} from './music';
import {getPreset} from './presets';
import {normalizeEnding, stripEmoji} from './script';
import {renderVideo, buildRenderPublic} from './render';
import type {PipelineKeys} from './pipeline';
import type {SceneData} from '../src/Scene';

const FPS = 30;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 영상 클립에서 대표 썸네일 1장 추출(Gemini 비전이 영상 내용을 보게 하기 위함).
function extractThumbnail(videoPath: string, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath]);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

export type ManualOpts = {
  imagePaths: string[]; // 사용자가 넣은 이미지 파일 경로들(최대 20)
  videoPaths?: string[]; // 사용자가 넣은 영상 클립 경로들
  keywords?: string; // 필수 키워드/문구
  facts?: string; // 팩트(내용) 텍스트
  duration: number;
  presetId?: string;
  voice?: string;
  log?: (m: string) => void;
  isCancelled?: () => boolean; // ★사용자 중단 — 단계 경계마다 확인(영상·카드 파이프라인과 동일).
};

export type ManualScene = {
  imageIndex: number; // 몇 번째 입력 이미지를 쓸지(선별 결과)
  narration: string;
  hookTop: string;
  hookAccent: string;
  accentColor: string;
  comment?: {user: string; text: string; likes: string};
};

async function toGeminiImage(p: string): Promise<GeminiImage> {
  const buf = await readFile(p);
  const ext = path.extname(p).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return {mimeType, dataB64: buf.toString('base64')};
}

export async function generateManualDraft(
  keys: PipelineKeys,
  opts: ManualOpts,
  workspace?: string,
) {
  const log = opts.log || (() => {});
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/${id}`;
  const abs = (rel: string) => workspace ? path.join(workspace, path.basename(rel)) : path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});

  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;

  // ★소스 통합: 이미지 + 영상. 영상은 썸네일을 뽑아 Gemini가 내용을 보게 하고, 원본 영상은 배경으로 쓴다.
  type Src = {path: string; kind: 'image' | 'video'; thumb: string};
  const sources: Src[] = [];
  for (const p of opts.imagePaths.slice(0, 20)) sources.push({path: p, kind: 'image', thumb: p});
  const vids = (opts.videoPaths || []).slice(0, 10);
  for (let vi = 0; vi < vids.length; vi++) {
    const thumb = abs(`${pubRel}/vthumb-${vi}.jpg`);
    const ok = await extractThumbnail(vids[vi], thumb);
    if (ok) sources.push({path: vids[vi], kind: 'video', thumb});
  }
  if (!sources.length) throw new Error('이미지나 영상을 최소 1개 넣어주세요.');
  const imgCount = sources.filter((s) => s.kind === 'image').length;
  const vidCount = sources.filter((s) => s.kind === 'video').length;
  log(`[수동] 소스 ${sources.length}개(이미지 ${imgCount}, 영상 ${vidCount}) 분석 준비…`);

  const imgs = sources.map((s) => s.path); // imageIndex 호환용
  const geminiImages = await Promise.all(sources.map((s) => toGeminiImage(s.thumb)));

  const n = opts.duration <= 30 ? 4 : opts.duration <= 60 ? 6 : Math.min(10, Math.ceil(opts.duration / 12));
  const perScene = Math.round((opts.duration * 5.6) / n); // ★실측보정 5.6: dry-run 3회로 목표40초에 중심 맞춤(v4 통짜 rate 6.0자/초). "약 N자"만 지시(문장수 지시 금지=폭주). Gemini가 ±25% 널뛰어도 평균은 목표에 근접.
  const isSell = preset?.goal === 'sell';

  const land = opts.duration >= 90;
  const prompt = `너는 구독자 100만 한국 유튜브 ${land ? '롱폼(가로 16:9)' : '쇼츠(세로 9:16)'} 채널의 기획자이자 대본 작가다. 아래에 사용자가 직접 올린 이미지 ${imgs.length}장이 순서대로 첨부돼 있다(0번부터). 이 이미지들을 직접 보고 분석해서, 가장 좋은 이미지들만 골라 '기승전결이 있는' ${land ? '가로 롱폼' : '세로 쇼츠'}를 구성하라.

${preset ? `[카테고리] ${preset.label} — 톤: ${preset.toneGuide}` : ''}
${opts.keywords ? `[반드시 포함할 키워드/문구] ${opts.keywords} — 후킹이나 자막에 자연스럽게 꼭 넣어라.` : ''}
${opts.facts ? `[영상에 담을 내용/팩트]\n${opts.facts.slice(0, 4000)}` : ''}

[규칙]
- 장면 정확히 ${n}개. 각 장면은 첨부 이미지 중 하나를 사용(imageIndex로 지정, 0부터). ★흐릿하거나 밋밋하거나(빈 상자·포장재만 있는 것 등) 주제와 안 맞는 이미지는 절대 쓰지 마라. 가장 먹음직스럽고 매력적인 이미지 위주로.
- ★같거나 비슷한 구도의 이미지가 여러 장이면 그중 가장 좋은 1장만 써라(중복 금지).
- 1번 장면 = 스크롤 멈추는 강렬한 후킹. ${preset?.hookStyle || (isSell ? '혜택·이득으로 욕구 자극' : '호기심·의외의 사실 예고')} 첫 이미지도 가장 먹음직스럽고 시선을 끄는 것으로.
  ★★후킹 만드는 법(조회수 90%가 첫 3초 결정): 서로 다른 후킹 후보 3개를 머릿속에 떠올려라 — (A)궁금증 갭 (B)손해 회피 (C)숫자·반전 충격. 그중 가장 강력한 하나만 골라 써라. 밋밋하면 실패.
- ★★제목·키워드의 약속을 지켜라: 제목/키워드에 "N가지·N개"처럼 개수가 있으면 본문에서 그 개수를 전부 다뤄라(2~3개만 주고 끝내지 마라). 장면이 모자라면 한 장면에 묶어서라도 다 담아라.
- ★★★마지막 장면 = 영상에서 가장 중요하다. ${isSell ? '가장 먹음직스러운 완성품 또는 제품(선물세트·상품샷) 이미지를 쓰고, 구매·소장 욕구를 부르는 강한 한마디로 맺어라. 빈 상자·포장재·공정사진으로 끝내지 마라.' : (preset?.endingStyle || '시청자에게 건네는 여운 한마디로 맺음')} 반드시 앞에서 다룬 내용과 자연스럽게 이어지게 매듭지어라. 앞에 없던 뜬금없는 새 소재·엉뚱한 말로 끝내면 절대 안 된다.
- 정치·종교·갈등·자극적 주제 금지.

[각 장면 필드]
- imageIndex: 사용할 이미지 번호(0~${imgs.length - 1})
- narration: 나레이션 한국어, 구어체. ★장면당 약 ${perScene}자(공백 포함, 이 글자수를 꼭 지켜라 — 영상이 목표 ${opts.duration}초에 맞아야 한다. 훨씬 짧거나 길면 안 됨). ★매 문장에 알맹이가 있어야 한다(빈말·뻔한 말 금지). 구체적 숫자·방법·예시로 "이건 몰랐네" 싶게, 다음이 궁금하게 끊어라.
- hookTop: 상단 후킹 첫 줄(흰색) 12자 이내
- hookAccent: 상단 후킹 둘째 줄(강조색) 10자 이내
- accentColor: hex 하나 (${preset ? preset.accentColors.join(', ') : '#FFE24B, #4FE0D0, #FF6B5E'})
- comment(선택): 한 장면만 {"user":"한국이름","text":"한마디","likes":"4.2천"}

JSON만 출력:
{"title":"...","musicPrompt":"...","scenes":[{"imageIndex":0,"narration":"...","hookTop":"...","hookAccent":"...","accentColor":"#FFE24B"}]}`;

  log('[수동] Gemini 비전으로 이미지 분석 + 대본 생성…');
  if (!keys.gemini.length && !keys.openai) throw new Error('Gemini/OpenAI 키가 없습니다.');
  // ★LLM이 가끔 깨진 JSON을 뱉으면 수동 제작 전체가 실패하던 문제 → 파싱 실패 시 조용히 재생성(최대 3회).
  let plan: {title: string; musicPrompt: string; scenes: ManualScene[]} | null = null;
  let lastErr = '대본 생성 실패';
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw = '';
    if (keys.gemini.length) {
      try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 4096, images: geminiImages, log}); }
      catch (e: any) { lastErr = e?.message || '생성 실패'; log(`[수동] Gemini 실패(${lastErr})${keys.openai ? ' → OpenAI 폴백(비전없음)' : ''}`); }
    }
    if (!raw && keys.openai) { try { raw = await openaiJson(keys.openai, prompt, 4096); } catch (e: any) { lastErr = e?.message || '생성 실패'; } }
    if (!raw) continue;
    try {
      const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(s.startsWith('{') ? s : (s.match(/\{[\s\S]*\}/)?.[0] || s));
      if (parsed?.scenes?.length) { plan = parsed; break; }
      lastErr = '대본 장면이 없음';
    } catch (e: any) { lastErr = e?.message || '대본 JSON 파싱 실패'; log(`[수동] JSON 파싱 실패 → 재생성(${attempt + 1}/3)`); }
  }
  if (!plan) throw new Error('수동 대본 생성 실패(재시도 후): ' + lastErr);
  // ★나레이션 끝맺음 정규화(쉼표로 끊기는 버그 방지 — 음성·자막 둘 다 반영)
  for (const s of plan.scenes) { s.hookTop = stripEmoji(s.hookTop || ''); s.hookAccent = stripEmoji(s.hookAccent || ''); s.narration = normalizeEnding(stripEmoji(s.narration)); }
  const totalChars = plan.scenes.reduce((a, s) => a + (s.narration || '').length, 0);
  log(`[수동] "${plan.title}" · ${plan.scenes.length}장면 구성 · 목표 ${perScene}자/장면 · 실제 총 ${totalChars}자(평균 ${Math.round(totalChars / plan.scenes.length)}자/장면)`);
  return {plan, sources};
}

export async function makeVideoManual(keys: PipelineKeys, opts: ManualOpts): Promise<{out: string; title: string; imageDir: string}> {
  const log = opts.log || (() => {});
  const ck = () => { if (opts.isCancelled?.()) throw new Error('사용자가 중단했습니다.'); };
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  const {plan, sources} = await generateManualDraft(keys, opts);
  ck();
  const totalChars = plan.scenes.reduce((n, s) => n + s.narration.length, 0);
  if (process.env.DRY_SCRIPT) return {out: '', title: plan.title, imageDir: abs(pubRel)};

  const voiceKey = opts.voice || preset?.voice || DEFAULT_VOICE;
  const voiceId = VOICES[voiceKey]?.id || VOICES[DEFAULT_VOICE].id;
  const scenes: SceneData[] = [];

  // ★음성 통짜 생성(자연스러운 억양)
  log('[음성] 전체 나레이션 한 번에 생성…');
  const voiceRel = `${pubRel}/voice.mp3`;
  const {align, sceneRanges} = await ttsElevenJoined(
    keys.elevenlabs,
    plan.scenes.map((s) => s.narration),
    abs(voiceRel),
    voiceId,
  );
  const audioSec = align?.length ? align[align.length - 1].end : 0;
  log(`[음성] 통짜 오디오 ${audioSec.toFixed(1)}초 · 실측 ${totalChars}자 → 초당 ${(totalChars / (audioSec || 1)).toFixed(1)}자(${voiceKey})`);

  for (let i = 0; i < plan.scenes.length; i++) {
    ck(); // 장면마다(이미지 준비가 길어 중단 요청이 여기서 바로 반영됨)
    const s = plan.scenes[i];
    const srcIdx = Math.min(Math.max(0, s.imageIndex ?? i), sources.length - 1);
    const src = sources[srcIdx];
    const imgRel = `${pubRel}/img-${i}.jpg`;
    let videoRel: string | undefined;
    if (src.kind === 'video') {
      // 영상은 원본을 복사해 배경 클립으로, 썸네일은 폴백 이미지로
      const ext = path.extname(src.path).toLowerCase() || '.mp4';
      videoRel = `${pubRel}/clip-${i}${ext}`;
      await copyFile(src.path, abs(videoRel));
      await copyFile(src.thumb, abs(imgRel));
    } else {
      await copyFile(src.path, abs(imgRel));
    }

    const [startSec, endSec] = sceneRanges[i] || [0, 0];
    const words = alignToWords(align, FPS, startSec, [startSec, endSec]);
    const durSec = endSec > startSec ? endSec - startSec : s.narration.length / 3.9;
    const tail = i === plan.scenes.length - 1 ? 0.5 : 0.15;
    const durationInFrames = Math.max(FPS, Math.round((durSec + tail) * FPS));

    scenes.push({
      image: imgRel,
      video: videoRel,
      hookTop: s.hookTop,
      hookAccent: s.hookAccent,
      accentColor: s.accentColor || '#FFE24B',
      words,
      durationInFrames,
      audioStartSec: startSec,
      punch: i === 0,
      motion: i,
      comment: s.comment,
    });
  }

  // BGM (통짜라 전환 0)
  const transitionFrames = 0;
  const totalFrames = scenes.reduce((a, s) => a + s.durationInFrames, 0);
  const bgmRel = `${pubRel}/bgm.mp3`;
  log('[BGM] 배경음악 생성 중…');
  // BGM 실패 시 throw(사유 포함) → 제작 중단. 웹/CLI/수동 동일 정책.
  await generateBgm(keys.elevenlabs, plan.musicPrompt || preset?.musicMood || '', (totalFrames / FPS) * 1000, abs(bgmRel), log);
  const bgmSrc: string = bgmRel;

  ck(); // 렌더 직전 — 여기까지 안 멈췄으면 렌더는 끝까지 간다(통짜 단계).
  log('[렌더] 최종 합성…');
  const out = path.join(process.cwd(), 'out', `${id}.mp4`);
  await mkdir(path.join(process.cwd(), 'out'), {recursive: true});
  // ★화면비: 롱폼(≥90초)=가로 16:9 / 쇼츠=세로 9:16(자동 모드와 동일 기준).
  const orientation: 'portrait' | 'landscape' = opts.duration >= 90 ? 'landscape' : 'portrait';
  // ★전용 public 폴더로 렌더 — 캐시 번들은 번들 이후 생성한 이 작업의 이미지·클립·음성·BGM을 404로 못 서빙한다
  //   (MediaError). 이 작업 자산만 담은 번들을 새로 만들어 넘긴다(카드·studio 경로와 동일).
  const renderPublic = await buildRenderPublic(pubRel);
  try {
    await renderVideo(scenes, transitionFrames, out, log, bgmSrc, voiceRel, renderPublic, orientation);
  } finally { await rm(renderPublic, {recursive: true, force: true}); }
  log(`[완료] ${out}`);
  return {out, title: plan.title, imageDir: abs(pubRel)};
}
