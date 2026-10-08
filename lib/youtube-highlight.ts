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
import {renderHighlightFast} from './highlight-fast';
import {addPortfolio, listPortfolio} from './portfolio';
import {r2Enabled, videoKey, uploadFile, getStream} from './storage';
import {geminiGenerate} from './gemini';
import {generateImageFlux} from './image';
import {ttsElevenJoined, alignToWords, pickVoice, VOICES, type Word} from './tts';
import type {SceneData} from '../src/Scene';
import {pickHlTemplate, getHlTemplate} from '../src/highlight-templates';

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
  log?: (m: string) => void,
): Promise<string> {
  if (!geminiKeys.length) { log?.('[하이라이트] 해설 생략: Gemini 키가 없습니다.'); return ''; }
  // ★분량을 클립 길이에 맞게 꽉 채운다 — 한국어 나레이션 ~4.4자/초(TTS 기준). 너무 적으면 뒤가 허전해짐.
  const targetChars = Math.max(60, Math.round(clipSec * 4.4));
  const prompt = `너는 유튜브 '리뷰·해설' 채널 운영자다. 아래는 남의 영상(재사용)에서 가져온 한 장면이다.
이 장면에 '네 관점의 해설/논평'을 한국어로 입혀 영상에 깔 나레이션을 써라. 장면을 그대로 중계·낭독하지 말고,
배경·맥락 설명, 왜 중요한지, 포인트 짚기, 너의 해석 한마디를 넣어 '원본과 구별되는 가치'를 더해라.

영상 제목: ${title}
장면 상단 후킹: ${hook || '(없음)'}
장면 대사/내용: ${transcript || '(대사 없음 — 제목과 후킹으로 맥락 추론)'}

[규칙]
- 분량: ${targetChars}자 내외로 '꽉' 채워라(이 장면 ${clipSec}초 거의 끝까지 말이 이어지게). 너무 짧으면 뒤가 허전하다. ±15%.
- 구어체로 말하듯. 첫 문장은 시청자를 붙잡는 한마디.
- 해설·논평·맥락 중심(받아쓰기·중계 금지).
- ★마지막 문장은 깔끔한 마무리(핵심 정리나 여운 있는 한마디)로 끝내라 — 말이 뚝 끊기지 않게.
- 해시태그·이모지·따옴표 없이 '읽을 문장'만.
JSON만 출력: {"commentary":"..."}`;
  // 레이트리밋·일시 오류·빈 응답이면 짧게 쉬고 1회 재시도(편마다 연속 호출이라 2편째부터 레이트에 걸리기 쉬움).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 1024, temperature: 0.8});
      const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
      const text = m ? String(JSON.parse(m[0]).commentary || '').trim() : '';
      if (text) return text;
      log?.(`[하이라이트] 해설 대본이 비어서 재시도(${attempt}/2)…`);
    } catch (e: any) {
      log?.(`[하이라이트] 해설 생성 오류(${attempt}/2): ${(e?.message || '알 수 없음').slice(0, 100)}`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2500));
  }
  return '';
}

// ── AI B-roll 팝업 생성 ──
// 클립의 내용(제목·후킹·대사)에 어울리는 '시각 소재' 이미지를 1~2장 flux로 만들어, 렌더 때 화면 중앙에
// 잠깐 떴다 사라지는 팝업으로 얹는다(지루함 제거 — OpusClip b-roll의 저비용 버전). 비용=이미지 1~2장뿐.
async function genBroll(
  geminiKeys: string[], replicateKey: string, title: string, transcript: string, hook: string,
  durSec: number, pubClipDir: string, jobRel: string, log: (m: string) => void,
): Promise<{path: string; start: number; end: number}[]> {
  const n = durSec >= 25 ? 2 : 1; // 긴 클립은 2장, 짧으면 1장(비용 최소)
  // 1) Gemini로 이 장면에 어울리는 '영어 이미지 묘사' n개(flux는 영어가 안정적).
  let prompts: string[] = [];
  try {
    const raw = await geminiGenerate(geminiKeys,
      `A short highlight clip. Title: "${title}". On-screen hook: "${hook || ''}". Transcript: "${(transcript || '').slice(0, 400)}".
Give ${n} vivid ENGLISH image prompt(s) for B-roll illustrations that visually match this scene's topic (concrete nouns/scenes, no text, no watermark, cinematic). JSON only: {"prompts":["...","..."]}`,
      {json: true, maxTokens: 400, temperature: 0.7});
    const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (m) prompts = (JSON.parse(m[0]).prompts || []).map((s: any) => String(s).trim()).filter(Boolean).slice(0, n);
  } catch {}
  if (!prompts.length) prompts = [hook || title].filter(Boolean); // 폴백: 후킹/제목으로라도
  if (!prompts.length) return [];
  // 2) 이미지 생성(세로는 정사각 느낌의 소재면 충분 — 카드로 올라감). 실패분은 건너뜀.
  const out: {path: string; start: number; end: number}[] = [];
  const slot = durSec / (prompts.length + 1); // 균등 배치
  for (let i = 0; i < prompts.length; i++) {
    const rel = `${jobRel}/broll-${i}.jpg`;
    const abs = path.join(pubClipDir, `broll-${i}.jpg`);
    try {
      log(`[B-roll] ${i + 1}/${prompts.length} 이미지 생성…`);
      await generateImageFlux(replicateKey, prompts[i] + ', no text, no watermark, high detail', abs, log, 'fast', 'real', true);
      if (fs.existsSync(abs)) {
        const start = Math.max(0.5, Math.min(durSec - 3, slot * (i + 1) - 1.3));
        out.push({path: abs, start, end: Math.min(durSec - 0.3, start + 2.8)});
      }
    } catch (e: any) { log(`[B-roll] ${i + 1}번 생성 실패(건너뜀): ${(e?.message || '').slice(0, 60)}`); }
  }
  return out;
}

// ── 영어 번역 자막(이중 자막) ──
// 한국어 해설을 문장 단위로 영어로 번역하고, 각 문장을 한국어 나레이션의 '단어 타이밍'에 맞춰 배치한다.
// (한국어 카라오케 자막 아래에 영어가 문장 단위로 따라붙는다 — 해외 시청자용.)
async function translateCaptionLines(
  geminiKeys: string[], koText: string, words: Word[], log: (m: string) => void,
): Promise<{text: string; s: number; e: number}[]> {
  if (!koText || !words.length || !geminiKeys.length) return [];
  // 1) 문장 분리(마침표·물음표·느낌표·줄바꿈 기준).
  const sentences = koText.split(/(?<=[.!?。…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return [];
  // 2) 영어 번역(한 번에, 배열 in/out — 문장 수 유지).
  let en: string[] = [];
  try {
    const raw = await geminiGenerate(geminiKeys,
      `Translate each Korean sentence into natural, concise English subtitles (keep the same count & order; spoken tone).
Korean sentences (JSON): ${JSON.stringify(sentences)}
Return JSON only: {"en":["...","..."]}`,
      {json: true, maxTokens: 1200, temperature: 0.3});
    const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (m) en = (JSON.parse(m[0]).en || []).map((s: any) => String(s).trim());
  } catch (e: any) { log('[번역] 영어 자막 생성 실패 — 한국어만: ' + (e?.message || '').slice(0, 60)); return []; }
  if (!en.length) return [];
  // 3) 각 문장을 단어 타이밍에 매핑(문장 길이 비례로 단어 인덱스 분배).
  const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
  const N = words.length;
  const out: {text: string; s: number; e: number}[] = [];
  let cum = 0;
  for (let i = 0; i < sentences.length && i < en.length; i++) {
    const before = cum, after = cum + sentences[i].length; cum = after;
    const startIdx = Math.min(N - 1, Math.max(0, Math.floor((before / totalChars) * N)));
    const endIdx = Math.min(N - 1, Math.max(startIdx, Math.ceil((after / totalChars) * N) - 1));
    if (en[i]) out.push({text: en[i], s: words[startIdx].s, e: words[endIdx].e});
  }
  log(`[번역] 영어 자막 ${out.length}문장 — 한국어 아래 함께 표시.`);
  return out;
}

export type HighlightJobResult = {projectId: string; file: string; title: string; hookTop: string; score: number}[];

// videoId(CC 영상) → N편의 완성 하이라이트 숏폼. 각 편은 독립 projectId(포폴·업로드 재사용).
export async function makeHighlights(
  videoId: string,
  meta: {title: string; channel: string; isCc?: boolean},
  opts: {count?: number; clipSec?: number; log?: (m: string) => void; isCancelled?: () => boolean; orientation?: 'portrait' | 'landscape'; commentary?: boolean; voice?: string; reframe?: 'track' | 'letterbox'; muteOriginal?: boolean; localFile?: string; template?: string; removeSilence?: boolean; broll?: boolean; captionEn?: boolean; onClip?: (c: {projectId: string; file: string; title: string; score: number}) => void} = {},
): Promise<HighlightJobResult> {
  const log = opts.log || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const stopIfCancelled = () => { if (cancelled()) throw new Error('사용자가 중단했습니다.'); };
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const isMine = !!opts.localFile; // 본인 업로드 영상(저작권 자유)
  const k = pipelineKeys();
  // 1) 다운로드(또는 로컬 파일) + 하이라이트 구간 추출 + 크롭 (임시 폴더)
  const workDir = path.join(os.tmpdir(), `onvideo-hl-${videoId || 'mine'}-${Date.now()}`);
  log(isMine
    ? `[하이라이트] 내 영상에서 숏폼을 만듭니다…(${orientation === 'landscape' ? '가로 16:9' : '세로 9:16'})`
    : `[하이라이트] 재사용 영상에서 숏폼 소재를 뽑습니다…(${orientation === 'landscape' ? '가로 16:9' : '세로 9:16'})`);
  const clips = await extractHighlights(videoId, workDir, k.gemini, {count: opts.count, clipSec: opts.clipSec, log, isCancelled: cancelled, orientation, reframe: opts.reframe, localFile: opts.localFile, removeSilence: opts.removeSilence});
  stopIfCancelled();
  log(`[하이라이트] ${clips.length}개 구간 확보 — 후킹 자막 얹어 완성합니다.`);

  // 출처 표기. 본인 영상=출처 불필요. CC 영상이면 (Creative Commons BY) 명시. 비-CC면 거짓표기 없이 출처만.
  const attribution = isMine
    ? ''
    : (meta.isCc === false
      ? `출처: ${meta.channel} — https://youtu.be/${videoId}`
      : `출처: ${meta.channel} — https://youtu.be/${videoId} (Creative Commons BY)`);
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
    let commentaryText = ''; // 실제 해설 대본 — 업로드 상세설명도 이걸 기반으로 쓴다(나레이션↔설명 일치).
    if (opts.commentary) {
      const commentary = await writeCommentary(k.gemini, meta.title, c.transcript || '', c.hookTop || '', Math.round(durSec), log);
      commentaryText = commentary || '';
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
        // 왜 해설이 안 들어갔는지 정확히 — 대본 실패인지, 음성 키 문제인지 구분(진단).
        if (!commentary) log(`[하이라이트] ${i + 1}편 해설 대본 생성 실패 — 이 편은 해설 없이 진행합니다.`);
        else log(`[하이라이트] ${i + 1}편 해설 음성 키(ElevenLabs)가 없어 해설 없이 진행합니다.`);
      }
    }
    // 해설이 결국 안 들어갔는데 '원본 소리 제거'까지 켜져 있으면 그 편은 완전 무음이 된다 → 무음 방지로 원본 소리를 살린다.
    const hasNarration = !!voiceRel;
    if (opts.muteOriginal && !hasNarration && opts.commentary)
      log(`[하이라이트] ${i + 1}편: 해설이 없어 무음이 되지 않게 원본 소리를 살립니다('원본 소리 제거' 설정 무시).`);

    // 디자인 템플릿 — 사용자가 고르면 그걸로, '자동'이면 후킹/제목으로 어울리는 걸 편마다 매칭.
    const tpl = (opts.template && opts.template !== 'auto')
      ? getHlTemplate(opts.template)
      : pickHlTemplate(`${c.hookTop || ''} ${c.hookAccent || ''} ${meta.title}`);
    const scene: SceneData = {
      image: `${jobRel}/${clipName}`, // 폴백용(사용 안 함 — fullBleed가 video 사용)
      video: `${jobRel}/${clipName}`,
      fullBleed: true, // 이미 비율 맞춤 → 꽉 채우고 상단 후킹 + (해설 시)카라오케 자막
      template: tpl.id,
      hookTop: c.hookTop || meta.title.slice(0, 20),
      hookAccent: c.hookAccent || '',
      accentColor: tpl.accentColor,
      words, // 해설 있으면 카라오케 자막, 없으면 []
      duckAudio: hasNarration, // 해설 깔면 원본 소리를 줄인다
      muteOriginal: !!opts.muteOriginal && hasNarration, // 원본 제거는 '해설이 있을 때만' — 없으면 무음 방지로 원본 유지

      // ★해설 있으면 "나레이션 끝나는 지점 + 1.3초 여운"까지만(뒤 허전함 제거). 나레이션이 더 길면 그만큼.
      //   해설 없으면 클립 전체.
      durationInFrames: words.length ? narrFrames + Math.round(FPS * 1.3) : clipFrames,
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
    // ── 영어 번역 자막(선택) — 해설(한국어 나레이션)이 있을 때만. 한국어 카라오케 아래에 영어 문장을 함께. ──
    let enLines: {text: string; s: number; e: number}[] = [];
    if (opts.captionEn && words.length && commentaryText) {
      try { enLines = await translateCaptionLines(k.gemini, commentaryText, words, log); } catch (e: any) { log('[번역] 건너뜀: ' + (e?.message || '').slice(0, 60)); }
    } else if (opts.captionEn && !words.length) {
      log('[번역] 영어 자막은 \'AI 해설\'을 켜야 나옵니다(해설 나레이션에 번역을 붙이는 방식).');
    }

    // ── AI B-roll 팝업(선택) — 관련 이미지를 화면 중앙에 잠깐 띄웠다 사라지게. replicate 키 있을 때만(비용 발생). ──
    let brollCuts: {path: string; start: number; end: number}[] = [];
    if (opts.broll && k.replicate) {
      try { brollCuts = await genBroll(k.gemini, k.replicate, meta.title, c.transcript || '', c.hookTop || '', durSec, pubClipDir, jobRel, log); } catch (e: any) { log('[B-roll] 생성 건너뜀: ' + (e?.message || '').slice(0, 60)); }
    } else if (opts.broll && !k.replicate) {
      log('[B-roll] 이미지 생성 키(Replicate)가 없어 b-roll 없이 진행합니다.');
    }

    const publicDir = await buildRenderPublic(jobRel); // bg.png + broll 이미지 포함(위에서 pubClipDir에 생성)
    try {
      log(`[하이라이트] ${i + 1}/${clips.length} 편 렌더…`);
      // ★빠른 렌더(프레임별 재렌더 없이 ffmpeg 합성) 우선 → 실패 시 기존 Remotion으로 폴백(무회귀).
      const fast = await renderHighlightFast({
        clipAbs: c.file, outPath: outAbs, hookTop: scene.hookTop, hookAccent: scene.hookAccent, template: tpl.id,
        words, narrationAbs: voiceRel ? path.join(pubClipDir, 'narration.mp3') : undefined,
        muteOriginal: !!opts.muteOriginal, duckAudio: !!voiceRel,
        durationSec: scene.durationInFrames / FPS, orientation, broll: brollCuts, subLines: enLines, log, isCancelled: cancelled,
      });
      if (!fast) await renderVideo([scene], 0, outAbs, log, undefined, voiceRel, publicDir, orientation);
      // 디자인 썸네일(일반영상과 동일 Thumbnail 컴포지션) — 깨끗한 프레임 배경 + 후킹 큰글자 + 강조 뱃지.
      if (bgOk) {
        try {
          await renderThumbnail(
            {image: `${jobRel}/${bgName}`,
              big: (c.hookTop || meta.title).slice(0, 18),
              small: '',
              badge: (c.hookAccent || '').slice(0, 8),
              accentColor: tpl.accentColor},
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
    // ★상세설명(유튜브·인스타) 생성 재료 = 실제 해설 대본(있으면). 없으면 후킹·제목.
    //   이렇게 해야 "말하는 나레이션 내용"과 "설명글"이 일치한다(테리 지적: 둘이 동떨어짐).
    const narrationSeed = (commentaryText && commentaryText.length > 15)
      ? commentaryText
      : ([c.hookTop, c.hookAccent].filter(Boolean).join(' ').trim() || title);
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
      score: c.score, // AI 바이럴 점수(0~100)
      attribution, // CC BY 출처 — 상세설명/캡션에 자동 포함
      // ★편집(재렌더)용 장면 메타 — '✏️ 편집'에서 후킹·템플릿 바꿔 이 클립만 다시 렌더할 때 쓴다.
      hlEdit: {
        hookTop: scene.hookTop, hookAccent: scene.hookAccent, template: tpl.id,
        words, durFrames: scene.durationInFrames, muteOriginal: !!opts.muteOriginal,
        hasNarration: !!voiceRel, orientation, baseTitle: meta.title,
      },
    };
    // ★편집 소스 보존 — 후킹 글자 없는 '깨끗한' 클립(c.file) + 나레이션. R2 우선(볼륨 ENOSPC 회피), 없으면 볼륨.
    try {
      const narrAbsSrc = path.join(pubClipDir, 'narration.mp3');
      if (r2Enabled()) {
        const sk = videoKey(projectId, 'source.mp4');
        if (await uploadFile(sk, c.file, 'video/mp4')) proj.sourceR2 = sk;
        if (voiceRel && fs.existsSync(narrAbsSrc)) {
          const nk = videoKey(projectId, 'narration.mp3');
          if (await uploadFile(nk, narrAbsSrc, 'audio/mpeg')) proj.narrationR2 = nk;
        }
      } else {
        fs.copyFileSync(c.file, path.join(studioDir, 'source.mp4')); proj.source = 'source.mp4';
        if (voiceRel && fs.existsSync(narrAbsSrc)) { fs.copyFileSync(narrAbsSrc, path.join(studioDir, 'narration.mp3')); proj.narration = 'narration.mp3'; }
      }
    } catch (e: any) { log('[편집소스] 보존 실패(편집 불가할 수 있음): ' + (e?.message || '')); }
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
        createdAt, orientation, kind: 'highlight', score: c.score,
      });
    } catch (e: any) { log('[하이라이트] 포트폴리오 등록 건너뜀: ' + (e?.message || '')); }
    // 출처(attribution)를 프로젝트 폴더에도 남긴다(상세설명 폴백 — project.json 읽기 실패 대비).
    try { fs.writeFileSync(path.join(studioDir, 'attribution.txt'), attribution); } catch {}

    results.push({projectId, file: output, title, hookTop: c.hookTop || '', score: c.score});
    // ★먼저 끝난 편은 바로 쓸 수 있게 — 완성 즉시 콜백(server가 SSE로 흘려 프론트 카드 노출).
    try { opts.onClip?.({projectId, file: output, title, score: c.score}); } catch {}
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

// R2 또는 볼륨에서 파일을 /tmp로 내려받는다(편집 재렌더용 소스 확보).
async function fetchToTmp(r2Key: string | undefined, volPath: string | undefined, tmpPath: string): Promise<boolean> {
  if (volPath && fs.existsSync(volPath)) { fs.copyFileSync(volPath, tmpPath); return true; }
  if (r2Key && r2Enabled()) {
    try {
      const got = await getStream(r2Key);
      if (got) {
        await new Promise<void>((resolve, reject) => {
          const w = fs.createWriteStream(tmpPath);
          got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject);
        });
        return fs.existsSync(tmpPath);
      }
    } catch {}
  }
  return false;
}

// ★하이라이트 한 편을 '편집'해서 그 클립만 다시 렌더한다('✏️ 편집' 저장). 깨끗한 소스(source.mp4)+나레이션을
//   보존해뒀다가 후킹 문구·강조·디자인 템플릿만 바꿔 새로 렌더→output·썸네일 교체→project.json 갱신.
export async function reRenderHighlight(
  projectId: string,
  overrides: {hookTop?: string; hookAccent?: string; template?: string},
  log: (m: string) => void = () => {},
): Promise<{output: string}> {
  const studioDir = path.join(DATA_DIR, 'studio', projectId);
  const pjPath = path.join(studioDir, 'project.json');
  if (!fs.existsSync(pjPath)) throw new Error('이 하이라이트의 정보를 찾을 수 없어요.');
  const proj: any = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const e = proj.hlEdit;
  if (!e) throw new Error('이 하이라이트는 편집 소스가 없어요(옛 버전). 새로 만든 하이라이트부터 편집할 수 있어요.');

  // 1) 깨끗한 소스 클립 + (있으면)나레이션을 /tmp로 확보.
  const work = path.join(os.tmpdir(), `hl-edit-${projectId}-${Date.now()}`);
  await fsp.mkdir(work, {recursive: true});
  const jobRel = `jobs/highlight-edit-${projectId}`;
  const pubClipDir = path.join(process.cwd(), 'public', jobRel);
  await fsp.mkdir(pubClipDir, {recursive: true});
  const clipAbs = path.join(pubClipDir, 'clip.mp4');
  log('[편집] 원본 소스 불러오는 중…');
  const gotClip = await fetchToTmp(proj.sourceR2, proj.source && path.join(studioDir, proj.source), clipAbs);
  if (!gotClip) { await fsp.rm(pubClipDir, {recursive: true, force: true}); throw new Error('편집용 원본 영상을 찾지 못했어요.'); }
  let voiceRel: string | undefined;
  if (e.hasNarration) {
    const narrAbs = path.join(pubClipDir, 'narration.mp3');
    if (await fetchToTmp(proj.narrationR2, proj.narration && path.join(studioDir, proj.narration), narrAbs)) voiceRel = `${jobRel}/narration.mp3`;
  }

  // 2) 장면 재구성 — 저장된 메타 + 사용자 오버라이드(후킹·템플릿).
  const tpl = getHlTemplate(overrides.template && overrides.template !== 'auto' ? overrides.template : e.template);
  const orientation: 'portrait' | 'landscape' = e.orientation === 'landscape' ? 'landscape' : 'portrait';
  const hookTop = (overrides.hookTop !== undefined ? overrides.hookTop : e.hookTop || '').slice(0, 40);
  const hookAccent = (overrides.hookAccent !== undefined ? overrides.hookAccent : e.hookAccent || '').slice(0, 20);
  const scene: SceneData = {
    image: `${jobRel}/clip.mp4`, video: `${jobRel}/clip.mp4`, fullBleed: true,
    template: tpl.id, hookTop, hookAccent, accentColor: tpl.accentColor,
    words: Array.isArray(e.words) ? e.words : [], duckAudio: !!voiceRel, muteOriginal: !!e.muteOriginal,
    durationInFrames: e.durFrames || Math.round((Number(proj.input?.duration) || 30) * FPS),
  };

  // 3) 렌더(새 output) + 썸네일.
  const bgName = 'bg.png';
  let bgOk = false;
  try { bgOk = await extractThumb(clipAbs, path.join(pubClipDir, bgName), 1.0); } catch {}
  const output = `highlight-edited-${randomUUID().slice(0, 8)}.mp4`;
  const outAbs = r2Enabled() ? path.join(os.tmpdir(), `onvideo-hl-out-${projectId}-${output}`) : path.join(studioDir, output);
  const thumbAbs = path.join(studioDir, 'thumb.png');
  const publicDir = await buildRenderPublic(jobRel);
  let thumbOk = false;
  try {
    log('[편집] 새 디자인으로 다시 렌더…');
    const fast = await renderHighlightFast({
      clipAbs, outPath: outAbs, hookTop, hookAccent, template: tpl.id,
      words: scene.words, narrationAbs: voiceRel ? path.join(pubClipDir, 'narration.mp3') : undefined,
      muteOriginal: !!e.muteOriginal, duckAudio: !!voiceRel,
      durationSec: scene.durationInFrames / FPS, orientation, log,
    });
    if (!fast) await renderVideo([scene], 0, outAbs, log, undefined, voiceRel, publicDir, orientation);
    if (bgOk) {
      try {
        await renderThumbnail({image: `${jobRel}/${bgName}`, big: (hookTop || e.baseTitle || '').slice(0, 18), small: '', badge: (hookAccent || '').slice(0, 8), accentColor: tpl.accentColor}, thumbAbs, log, publicDir, orientation);
        thumbOk = fs.existsSync(thumbAbs);
      } catch {}
    }
    if (!thumbOk) { try { thumbOk = await extractThumb(outAbs, thumbAbs, 1.0); } catch {} }
  } finally {
    await fsp.rm(publicDir, {recursive: true, force: true});
    await fsp.rm(pubClipDir, {recursive: true, force: true});
    await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
  }

  // 4) output·썸네일 교체 + project.json 갱신(R2 포함). 옛 output은 교체되므로 R2 키만 바꾸면 됨.
  const oldOutput = proj.output;
  proj.output = output;
  proj.title = (hookTop || proj.title || e.baseTitle || '하이라이트').slice(0, 80);
  proj.hlEdit = {...e, hookTop, hookAccent, template: tpl.id};
  if (r2Enabled()) {
    try {
      const key = videoKey(projectId, output);
      if (await uploadFile(key, outAbs, 'video/mp4')) { proj.outputR2 = key; fs.rmSync(outAbs, {force: true}); }
      else { fs.copyFileSync(outAbs, path.join(studioDir, output)); fs.rmSync(outAbs, {force: true}); delete proj.outputR2; }
      if (thumbOk && fs.existsSync(thumbAbs)) { const tk = videoKey(projectId, 'thumb.png'); if (await uploadFile(tk, thumbAbs, 'image/png')) proj.thumbR2 = tk; }
    } catch (e2: any) { log('[편집] R2 갱신 실패(로컬 보관): ' + (e2?.message || '')); try { fs.copyFileSync(outAbs, path.join(studioDir, output)); fs.rmSync(outAbs, {force: true}); delete proj.outputR2; } catch {} }
  }
  proj.thumb = thumbOk ? 'thumb.png' : proj.thumb;
  fs.writeFileSync(pjPath + '.tmp', JSON.stringify(proj));
  fs.renameSync(pjPath + '.tmp', pjPath);
  // 포트폴리오 제목 동기화.
  try {
    const items = listPortfolio();
    const it = items.find((x) => x.projectId === projectId);
    if (it) { it.title = proj.title; const fp = path.join(DATA_DIR, 'portfolio.json'); fs.writeFileSync(fp + '.tmp', JSON.stringify(items)); fs.renameSync(fp + '.tmp', fp); }
  } catch {}
  log('[편집] ✅ 다시 렌더 완료!');
  return {output};
}
