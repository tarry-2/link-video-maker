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
import {intensifyHooks, autoSpace} from './script';
import {addPortfolio, listPortfolio, countBySourceKey} from './portfolio';
import {r2Enabled, videoKey, uploadFile, getStream, head as r2Head, deleteKey as deleteR2Key} from './storage';
import {geminiGenerate, GeminiImage} from './gemini';
import {RULE, contentStrategy, sceneContext} from './prompt-rules'; // ★로직 센터 — 소재유형·화면우선·답/정보·오보금지 단일 출처
import {generateImageFlux, generateImageSmart} from './image';
import {ttsElevenJoined, alignToWords, pickVoice, VOICES, type Word} from './tts';
import type {SceneData} from '../src/Scene';
import {pickHlTemplate, getHlTemplate} from '../src/highlight-templates';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FPS = 30;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 자막 폰트(Black Han Sans 등)가 못 그리는 이모지·기호(🧙⭐▶￭ 등)를 제거한다 → 안 지우면 후킹에 □□(두부)로 깨진다.
//   한글·영문·숫자·공백·흔한 문장부호만 남긴다. (KBS 원제목에 이모지가 박혀 있는 경우가 많음 — 테리 실측)
export function stripUnrenderable(s: string): string {
  return (s || '')
    // 이모지/기호/장식 유니코드 블록 제거(그려지지 않는 것들).
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2000}-\u{206F}\u{25A0}-\u{25FF}\u{2300}-\u{23FF}]/gu, '')
    .replace(/[�‍]/g, '') // 치환문자·ZWJ
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 제목을 '단어/구분자 경계'에서 깔끔하게 자른다(글자 수로 뚝 자르면 "...1화 둘"처럼 단어 중간이 끊긴다).
//   구분자(|·-·[]()·화/회/편) 앞에서 끊고, 없으면 공백 단위로. 그래도 길면 글자 수 폴백.
// ★후킹은 '한국어'여야 한다. 제목·자막이 영어여도 한국어 후킹을 창작/번역한다(테리: 후킹은 한글이야).
async function koreanHook(geminiKeys: string[], title: string, transcript: string, log: (m: string) => void, images?: GeminiImage[]): Promise<{hookTop: string; hookAccent: string} | null> {
  if (!geminiKeys.length) return null;
  const prompt = `아래 '한 장면'의 '한국어' 쇼츠 후킹을 만들어라. 제목/자막이 영어여도 반드시 자연스러운 한국어로 창작·번역한다.

${sceneContext({title, transcript, hasVision: !!images?.length})}

후킹은 두 줄로 화면 위에 동시에 뜬다. 윗줄(hookTop)=상황/셋업, 아랫줄(hookAccent)=그걸 터뜨리는 '반전 펀치'다.
★가장 중요: hookAccent는 hookTop에 '이미 쓴 단어·표현을 절대 반복하지 마라'. 같은 말을 두 번 쓰면 촌스럽고 식상하다. 윗줄에서 궁금하게 만들고(상황/셋업), 아랫줄은 완전히 다른 단어로 그 결과·반전·감정을 꽂아라.
(이건 형식 규칙일 뿐이다 — 예시 소재를 베끼지 말고 반드시 '이 장면'의 내용으로 만들어라.)

요구:
- hookTop: 스크롤을 멈추게 하는 한국어 10~16자. 궁금증·긴장을 만드는 셋업. 제목 그대로 복붙 금지, 영어 금지, 뻔한 표현(대박·레전드·충격 남발) 금지.
- hookAccent: hookTop과 단어가 겹치지 않는 강펀치 한국어 6~12자. 결과·반전·감정을 터뜨린다(예: "결국 무릎 꿇음", "소름 돋는 반전").
JSON만: {"hookTop":"...","hookAccent":"..."}`;
  try {
    const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 220, temperature: 0.9, images});
    const m = raw.match(/\{[\s\S]*\}/); const d = m ? JSON.parse(m[0]) : {};
    const ht = String(d.hookTop || '').slice(0, 24).trim();
    if (!/[가-힣]/.test(ht)) return null; // 한글이 없으면 실패로 간주
    return {hookTop: ht, hookAccent: String(d.hookAccent || '').slice(0, 12).trim()};
  } catch (e: any) { log('[후킹] 한국어 후킹 생성 실패: ' + (e?.message || '').slice(0, 60)); return null; }
}
// 후킹 윗줄(top)과 아랫줄(accent)이 같은 말을 반복하면 촌스럽다 → 겹치면 accent를 비운다.
//   공백·구두점·이모지 제거 후, 한쪽이 다른 쪽에 포함(substring)되거나 토큰이 과반 겹치면 중복으로 판정.
function dedupAccent(top: string, accent: string): string {
  const norm = (s: string) => (s || '').replace(/[\s.,!?~·…"'()\[\]]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  const t = norm(top), a = norm(accent);
  if (!a) return '';
  if (a.length >= 2 && (t.includes(a) || a.includes(t))) return '';
  // 2글자 이상 연속 어절이 top에 그대로 있으면(핵심 단어 반복) 비운다.
  const toks = (accent || '').split(/\s+/).filter((w) => w.replace(/[^가-힣A-Za-z0-9]/g, '').length >= 2);
  if (toks.length && toks.every((w) => t.includes(norm(w)))) return '';
  return accent;
}
function cleanTitle(raw: string, max = 20): string {
  const t = stripUnrenderable(raw || '').trim();
  if (t.length <= max) return t;
  // 1) 구분자(| - – — [ ( · :) 기준으로 앞 조각이 적당하면 그걸 쓴다.
  const bySep = t.split(/\s*[|\-–—\[\]()·:]\s*/).map((s) => s.trim()).filter(Boolean);
  if (bySep[0] && bySep[0].length >= 4 && bySep[0].length <= max) return bySep[0];
  // 2) 'N화/N회/N편'까지 포함해 끊으면 자연스러운 경우.
  const epMatch = t.match(/^(.{4,}?\d+\s*[화회편])/);
  if (epMatch && epMatch[1].length <= max) return epMatch[1].trim();
  // 3) 공백 단위로 max 안까지 담되 단어 중간은 안 자른다.
  const words = t.split(/\s+/); let out = '';
  for (const w of words) { if ((out + ' ' + w).trim().length > max) break; out = (out + ' ' + w).trim(); }
  if (out.length >= 4) return out;
  // 4) 폴백: 글자 수(그래도 맨 끝 공백은 정리).
  return t.slice(0, max).trim();
}

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

// ★클립의 '실제 화면' 프레임을 뽑아 Gemini 비전용 이미지로(폭 512로 줄여 토큰·시간 절약).
//   후킹·해설이 제목/자막 '텍스트'가 아니라 '화면'에 근거하게 해서 "인물 이름 뒤바뀜·없는데 있다고" 방지.
//   짧은 편은 1장(중앙), 긴 편은 2장(1/4·3/5 지점)으로 장면 변화를 커버.
async function clipVisionFrames(clipAbs: string, durSec: number, workDir: string): Promise<GeminiImage[]> {
  const pts = durSec > 6 ? [durSec * 0.25, durSec * 0.6] : [Math.max(0.3, durSec * 0.5)];
  const imgs: GeminiImage[] = [];
  for (const at of pts) {
    const png = path.join(workDir, `vframe-${randomUUID()}.png`);
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const ps = spawn(FFMPEG, ['-y', '-ss', String(at), '-i', clipAbs, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', png], {stdio: ['ignore', 'ignore', 'ignore']});
        const t = setTimeout(() => { ps.kill('SIGKILL'); resolve(false); }, 30000);
        ps.on('error', () => { clearTimeout(t); resolve(false); });
        ps.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(png)); });
      });
      if (ok) { const b = fs.readFileSync(png); if (b.length) imgs.push({mimeType: 'image/png', dataB64: b.toString('base64')}); }
      if (fs.existsSync(png)) fs.unlinkSync(png);
    } catch { /* 프레임 실패해도 텍스트 기반으로 진행 */ }
  }
  return imgs;
}

// 재사용 영상에 '내 관점의 해설'을 입혀 수익화(변형 가치) 기준을 충족시키기 위한 나레이션 대본 생성.
//   원본 대사(transcript)를 근거로 맥락·논평을 더한다(단순 중계/낭독 금지).
async function writeCommentary(
  geminiKeys: string[], title: string, transcript: string, hook: string, clipSec: number,
  log?: (m: string) => void, images?: GeminiImage[], episodeIdx = 0, handoff = false,
): Promise<string> {
  if (!geminiKeys.length) { log?.('[하이라이트] 해설 생략: Gemini 키가 없습니다.'); return ''; }
  // ★분량을 클립 길이에 '꽉' 채운다 — 한국어 나레이션 ~4.9자/초(TTS 실측, 끝까지 말이 이어지게).
  //   예전 4.4는 AI가 ±적게 쓰면 45~50초로 짧게 끝났다(테리 지적) → 하한을 길이의 90%로 못박음.
  const targetChars = Math.max(60, Math.round(clipSec * 4.9));
  const minChars = Math.round(clipSec * 4.4); // 이보다 짧으면 지정 길이에 한참 못 미침
  // ★시리즈 2편+는 앞 편과 똑같은 도입(소개)을 반복하지 마라 — 바로 '이번 장면 본내용'으로.
  const seriesHint = episodeIdx >= 1
    ? `\n★★이건 시리즈 ${episodeIdx + 1}편이다. 1편에서 이미 한 '전체 소개·배경 설명'(무슨 행사·누가 나왔는지 등)을 또 반복하지 마라. 시청자는 앞 편을 봤다고 가정하고, '이번 장면의 새로운 내용'으로 곧바로 들어가라(도입에 시간 낭비 금지 — 첫 문장부터 이 장면의 핵심).`
    : '';
  const prompt = `너는 유튜브 '리뷰·해설' 채널 운영자다. 아래는 남의 영상(재사용)에서 가져온 한 장면이다.
이 장면에 '네 관점의 해설/논평'을 한국어로 입혀 영상에 깔 나레이션을 써라. 장면을 그대로 중계·낭독하지 말고,
배경·맥락 설명, 왜 중요한지, 포인트 짚기, 너의 해석 한마디를 넣어 '원본과 구별되는 가치'를 더해라.

${sceneContext({title, hook, transcript, hasVision: !!images?.length})}

[규칙]
- 분량: ${targetChars}자 내외로 '꽉' 채워라(최소 ${minChars}자 이상 — 이 장면 ${clipSec}초 끝까지 말이 이어지게, 짧으면 영상이 빈 채로 끝난다). 모자라지 않게.
- 구어체로 말하듯. ★★첫 문장이 생사다 — 인사·뜸들이기 절대 금지. 0.5초 안에 가장 센 포인트·반전·질문부터 때려 스크롤을 멈춰라(쇼츠는 첫 1초에 확산이 갈린다).${seriesHint}
- 해설·논평·맥락 중심(받아쓰기·중계 금지).
${contentStrategy()}
${RULE.answer}
${RULE.factTruth}
${handoff
  ? `- ★이 해설은 영상 ${clipSec}초쯤에서 끝나고, 그 뒤 남은 부분은 '원본 소리(노래·무대·현장음)'가 그대로 흐른다. 그러니 할 말을 ${clipSec}초 안에 깔끔히 맺고, 마지막 문장은 반드시 원본으로 자연스럽게 넘기는 매끄러운 멘트로 끝내라(예: "자, 그럼 지금부터 함께 보시죠", "한번 들어보세요", "끝까지 감상해 보세요"). 말을 뚝 끊지 말고 '넘기는' 느낌으로.`
  : '- 답/정보를 분명히 준 뒤 마지막 한마디로만 짧은 여운.'}
${RULE.polite}
- 해시태그·이모지·따옴표 없이 '읽을 문장'만.
JSON만 출력: {"commentary":"..."}`;
  // 레이트리밋·일시 오류·빈 응답이면 짧게 쉬고 1회 재시도(편마다 연속 호출이라 2편째부터 레이트에 걸리기 쉬움).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 1024, temperature: 0.8, images});
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
  geminiKeys: string[], replicateKey: string, falKey: string | undefined, title: string, transcript: string, hook: string,
  durSec: number, pubClipDir: string, jobRel: string, log: (m: string) => void,
): Promise<{path: string; start: number; end: number}[]> {
  // ★90초 미만=1장, 90초 이상=2장(테리 결정). 짧은 쇼츠(대부분 59초)는 1장으로 비용·시간 절약,
  //   긴 롱폼일 때만 2장. (예전 25초 기준은 59초 영상도 전부 2장이라 편당 2분·돈 낭비였음)
  const n = durSec >= 90 ? 2 : 1;
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
      await generateImageSmart({fal: falKey, replicate: replicateKey}, prompts[i] + ', no text, no watermark, high detail', abs, log, 'fast', 'real', true);
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
  opts: {count?: number; clipSec?: number; log?: (m: string) => void; isCancelled?: () => boolean; orientation?: 'portrait' | 'landscape'; commentary?: boolean; narrationCoverage?: number; voice?: string; reframe?: 'track' | 'letterbox'; muteOriginal?: boolean; localFile?: string; template?: string; font?: string; removeSilence?: boolean; broll?: boolean; captionEn?: boolean; source?: 'search' | 'url' | 'upload' | 'archive'; onClip?: (c: {projectId: string; file: string; title: string; score: number; reason?: string}) => void} = {},
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
  const clips = await extractHighlights(videoId, workDir, k.gemini, {count: opts.count, clipSec: opts.clipSec, log, isCancelled: cancelled, orientation, reframe: opts.reframe, localFile: opts.localFile, removeSilence: opts.removeSilence, title: meta.title});
  stopIfCancelled();
  log(`[하이라이트] ${clips.length}개 구간 확보 — 후킹 자막 얹어 완성합니다.`);

  // 출처 표기. 본인 영상=출처 불필요. CC 영상이면 (Creative Commons BY) 명시. 비-CC면 거짓표기 없이 출처만.
  const attribution = isMine
    ? ''
    : (meta.isCc === false
      ? `출처: ${meta.channel} — https://youtu.be/${videoId}`
      : `출처: ${meta.channel} — https://youtu.be/${videoId} (Creative Commons BY)`);
  const results: HighlightJobResult = [];

  // ★누적 회차('N편') — 같은 소재로 지금까지 만든 편 수에 이어서 번호를 붙인다(배포 구분 편하게).
  //   소재 식별: 유튜브/아카이브=videoId, 업로드=영상 제목. 이번 제작의 첫 편은 (기존수+1)편부터.
  const sourceKey = isMine ? ('upload:' + (meta.title || '').trim()) : ('yt:' + videoId);
  const startEpisode = countBySourceKey(sourceKey);

  // ★완성도 게이트(테리): 설정 길이의 80% 미만인 구간은 억지로 만들지 않고 스킵+로그한다.
  //   "한 편을 둘로 쪼개 반토막" 방지 — 한 편 덜 만들어도 각 편은 제 길이. (clipSec 지정 시만, 미지정이면 통과)
  const minSec = opts.clipSec ? Math.max(10, Math.floor(opts.clipSec * 0.8)) : 0;
  let episodeNo = 0; // 실제로 '만든' 편 수(스킵한 편은 번호 안 밀림)
  for (let i = 0; i < clips.length; i++) {
    stopIfCancelled();
    const c = clips[i];
    if (minSec && (c.end - c.start) < minSec) {
      log(`[하이라이트] 구간이 짧아(${Math.round(c.end - c.start)}초 · 기준 ${minSec}초) 완성도 위해 한 편을 스킵했습니다.`);
      continue;
    }
    episodeNo++;
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
    // ★길이 락(hard cap) — 사용자가 고른 한 편 길이(clipSec)를 '절대' 넘지 않게 한다.
    //   저작권 때문에 59초로 맞췄는데 해설 나레이션이 길어 60초를 넘기면 "쇼츠 전세계 차단" 위험 → 넘침 금지.
    //   clipSec이 지정돼 있으면 그 프레임을 상한으로 쓴다(지정 안 하면 clipFrames 그대로).
    const capFrames = opts.clipSec ? Math.round(opts.clipSec * FPS) : clipFrames;

    // ★이 구간의 '실제 화면' 프레임 — 후킹·해설을 '보이는 것' 기준으로(인물 이름 단정·뒤바뀜 방지, 테리 대형 지적).
    const visionFrames = await clipVisionFrames(path.join(pubClipDir, clipName), durSec, studioDir).catch(() => []);
    if (visionFrames.length) log(`[하이라이트] ${i + 1}편 화면 ${visionFrames.length}장 분석 — 후킹·해설을 화면 기준으로 생성(없는 인물·이름 방지)`);
    else log(`[하이라이트] ${i + 1}편 화면 프레임 추출 실패 — 텍스트 기준으로 진행`);

    // ── 해설 나레이션(선택) — 원본에 '내 관점의 해설'을 입혀 수익화(변형 가치) 충족 ──
    //   Gemini로 해설 대본 → ElevenLabs TTS(단어 타이밍) → 원본 소리는 더킹, 카라오케 자막으로 표시.
    let words: Word[] = [];
    let voiceRel: string | undefined;
    let narrFrames = 0;
    let commentaryText = ''; // 실제 해설 대본 — 업로드 상세설명도 이걸 기반으로 쓴다(나레이션↔설명 일치).
    if (opts.commentary) {
      // 해설 길이도 '길이 락' 안에 맞춘다 — 영상이 capFrames에서 잘리므로 나레이션이 그보다 길면 뒷말이 뚝 끊긴다.
      //   캡의 92%를 목표 길이로(여운 1.3초 + 여유). 사용자가 59초로 맞췄으면 해설은 ~54초 분량으로 생성.
      const capSec = capFrames / FPS;
      // ★나레이션 커버리지(테리): 1.0=끝까지 / 0.8 / 0.6 — 뒷부분은 원본 소리(노래·무대)가 커지며 재생된다.
      const coverage = Math.max(0.3, Math.min(1, opts.narrationCoverage ?? 1));
      const handoff = coverage < 0.95; // 중간에 끝나면 '자, 들어보시죠' 식 매끄러운 마무리
      const narrTargetSec = Math.max(5, Math.min(Math.round(durSec), Math.floor(capSec * 0.92 * coverage)));
      if (handoff) log(`[하이라이트] ${i + 1}편 해설 ${Math.round(coverage * 100)}%까지(${narrTargetSec}초) — 나머지는 원본 소리로 마무리`);
      const commentary = await writeCommentary(k.gemini, meta.title, c.transcript || '', c.hookTop || '', narrTargetSec, log, visionFrames, episodeNo - 1, handoff);
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
    // ★후킹은 나레이션(해설)과 무관하게 '항상', 그리고 '한국어'로 들어가야 한다.
    const hasVisibleHook = (s: string) => /[0-9A-Za-z가-힣]/.test(s || '');
    const hasKorean = (s: string) => /[가-힣]/.test(s || '');
    let hookTopFinal = hasVisibleHook(c.hookTop) ? c.hookTop : cleanTitle(meta.title, 20);
    let hookAccentFinal = c.hookAccent || '';
    // 후킹에 한글이 하나도 없으면(영어 제목·영어 자막이라 AI가 영어로 뽑았거나 제목으로 폴백된 경우)
    //   제목+대사로 '한국어 후킹'을 새로 만든다. 이게 테리가 말한 "후킹은 한글이야".
    if (!hasKorean(hookTopFinal)) {
      const kh = await koreanHook(k.gemini, meta.title, c.transcript || '', log, visionFrames);
      if (kh) { hookTopFinal = kh.hookTop; if (!hasKorean(hookAccentFinal)) hookAccentFinal = kh.hookAccent; }
    }
    if (!hasVisibleHook(hookTopFinal)) hookTopFinal = cleanTitle(meta.title, 20) || (meta.title || '').slice(0, 20) || '하이라이트';
    // ★중복 가드 — hookAccent가 hookTop에 이미 들어간 말이면 "했던 말을 또 하는" 꼴이라 지운다(테리 지적).
    //   (공백·구두점 제거해 비교. 서로 substring이면 중복으로 본다.)
    hookAccentFinal = dedupAccent(hookTopFinal, hookAccentFinal);
    // ★후킹 강화 게이트 — "항상 90점 이상"으로 재작성(밋밋 방지, 테리 지시). 영상 대사(transcript)에 근거.
    try {
      const [strong] = await intensifyHooks(k.gemini, [{hookTop: hookTopFinal, hookAccent: hookAccentFinal, context: (c.transcript || meta.title || '').slice(0, 300)}], log, visionFrames);
      if (strong && strong.hookTop && hasKorean(strong.hookTop)) { hookTopFinal = strong.hookTop; hookAccentFinal = strong.hookAccent; }
    } catch (e: any) { log('[후킹강화] 건너뜀: ' + (e?.message || '').slice(0, 50)); }
    log(`[하이라이트] ${i + 1}편 후킹: "${hookTopFinal}"${hookAccentFinal ? ` / "${hookAccentFinal}"` : ''}${hasKorean(hookTopFinal) ? '' : ' (한글 변환 실패—원문 유지)'}`);
    const scene: SceneData = {
      image: `${jobRel}/${clipName}`, // 폴백용(사용 안 함 — fullBleed가 video 사용)
      video: `${jobRel}/${clipName}`,
      fullBleed: true, // 이미 비율 맞춤 → 꽉 채우고 상단 후킹 + (해설 시)카라오케 자막
      template: tpl.id,
      font: opts.font || undefined, // 사용자가 고른 제목 폰트(모든 탭 공통). 자동이면 템플릿 폰트.
      hookTop: hookTopFinal,
      hookAccent: hookAccentFinal,
      accentColor: tpl.accentColor,
      words, // 해설 있으면 카라오케 자막, 없으면 []
      duckAudio: hasNarration, // 해설 깔면 원본 소리를 줄인다
      muteOriginal: !!opts.muteOriginal && hasNarration, // 원본 제거는 '해설이 있을 때만' — 없으면 무음 방지로 원본 유지

      // ★해설 있으면 "나레이션 끝나는 지점 + 1.3초 여운"까지만(뒤 허전함 제거). 나레이션이 더 길면 그만큼.
      //   해설 없으면 클립 전체. 단 어느 경우든 capFrames(사용자 지정 길이)를 '절대' 넘지 않는다(길이 락).
      durationInFrames: Math.min(capFrames, words.length ? narrFrames + Math.round(FPS * 1.3) : clipFrames),
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
      try { brollCuts = await genBroll(k.gemini, k.replicate, k.fal, meta.title, c.transcript || '', c.hookTop || '', durSec, pubClipDir, jobRel, log); } catch (e: any) { log('[B-roll] 생성 건너뜀: ' + (e?.message || '').slice(0, 60)); }
    } else if (opts.broll && !k.replicate) {
      log('[B-roll] 이미지 생성 키(Replicate)가 없어 b-roll 없이 진행합니다.');
    }

    const publicDir = await buildRenderPublic(jobRel); // bg.png + broll 이미지 포함(위에서 pubClipDir에 생성)
    try {
      log(`[하이라이트] ${i + 1}/${clips.length} 편 렌더…`);
      // ★빠른 렌더(프레임별 재렌더 없이 ffmpeg 합성) 우선 → 실패 시 기존 Remotion으로 폴백(무회귀).
      const fast = await renderHighlightFast({
        clipAbs: c.file, outPath: outAbs, hookTop: scene.hookTop, hookAccent: scene.hookAccent, template: tpl.id, font: opts.font,
        words, narrationAbs: voiceRel ? path.join(pubClipDir, 'narration.mp3') : undefined,
        muteOriginal: !!opts.muteOriginal, duckAudio: !!voiceRel,
        durationSec: scene.durationInFrames / FPS, orientation, broll: brollCuts, subLines: enLines, log, isCancelled: cancelled,
      });
      if (!fast) await renderVideo([scene], 0, outAbs, log, undefined, voiceRel, publicDir, orientation);
      // 디자인 썸네일(일반영상과 동일 Thumbnail 컴포지션) — 깨끗한 프레임 배경 + 후킹 큰글자 + 강조 뱃지.
      if (bgOk) {
        try {
          await renderThumbnail(
            // ★하드컷을 18→28자로 완화(잘림 방지) — Thumbnail이 글자 수에 맞춰 폰트를 자동 축소해 프레임 안에 넣는다.
            {image: `${jobRel}/${bgName}`,
              big: hookTopFinal ? hookTopFinal.slice(0, 28) : cleanTitle(meta.title, 28),
              small: '',
              badge: (hookAccentFinal || '').slice(0, 8),
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

    // 후킹 그대로 + 끝에 누적 회차('N편'). 같은 소재 몇 번을 만들든 이어서 번호가 붙어 배포 구분이 쉽다.
    //   ★스킵된 편은 번호를 안 밀리게 episodeNo(실제 만든 순서) 사용.
    const episode = startEpisode + episodeNo;
    const baseT = hookTopFinal ? hookTopFinal.slice(0, 74) : cleanTitle(meta.title, 74);
    const title = `${baseT} ${episode}편`;
    const createdAt = new Date().toISOString();

    // ★서버의 업로드·상세설명·서빙 스택(resolveVideo·ensureInstaVideoR2·readProject*·/portfolio-item)은
    //   전부 data/studio/{id}/project.json을 디스크에서 직접 읽는다. 영상·카드와 "똑같은 모양"의
    //   project.json을 써줘야 유튜브·인스타 업로드와 제목·설명 자동생성이 작동한다.
    //   (안 쓰면 resolveVideo가 null → "영상을 찾을 수 없습니다" / 상세설명 생성 실패.)
    // ★상세설명(유튜브·인스타) 생성 재료 = 실제 해설 대본(있으면). 없으면 후킹·제목.
    //   이렇게 해야 "말하는 나레이션 내용"과 "설명글"이 일치한다(테리 지적: 둘이 동떨어짐).
    const narrationSeed = (commentaryText && commentaryText.length > 15)
      ? commentaryText
      : ([hookTopFinal, hookAccentFinal].filter(Boolean).join(' ').trim() || title);
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
        transcript: (c.transcript || '').slice(0, 1200), // ★AI 후킹 추천이 '영상 내용'을 보고 뽑도록 대사 저장
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
    // ★바탕화면에도 내보내기(로컬 맥에서만 — Railway엔 Desktop 없어 try/catch로 무시). 다른 탭과 동일 정책.
    //   여기서 복사해야 한다 — 아래 R2 블록이 outAbs(/tmp)를 업로드 후 삭제하므로 그 전에.
    try {
      const safeT = title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
      const today = new Date().toLocaleDateString('sv-SE');
      const folder = path.join(os.homedir(), 'Desktop', `온비디오 하이라이트 ${today}`);
      fs.mkdirSync(folder, {recursive: true});
      fs.copyFileSync(outAbs, path.join(folder, `${safeT}.mp4`));
      log(`[완료] 바탕화면에도 저장됨: ${folder}`);
    } catch {}
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
      // ★project.json도 R2에 백업 — 볼륨이 정리/재생성돼도 재편집 메타(hlEdit·words)가 안 날아가게(테리: 수정 모달 빈칸 사고).
      if (r2Enabled()) { try { await uploadFile(videoKey(projectId, 'project.json'), pjPath, 'application/json'); } catch {} }
    } catch (e: any) { log('[하이라이트] project.json 저장 실패: ' + (e?.message || '')); }

    // 포트폴리오 등록 → voices.html 카드 + 유튜브/인스타 자동 업로드 재사용.
    try {
      addPortfolio({
        projectId, title, output,
        voice: '원본 음성(CC)', category: '🎬 유튜브 하이라이트', goal: 'info',
        createdAt, orientation, kind: 'highlight', score: c.score,
        source: opts.source || (isMine ? 'upload' : 'search'), // 작업내역 탭별 이원화용 소재 출처
        sourceKey, // 같은 소재 누적 회차('N편') 계산용
        attribution, // ★출처를 포트폴리오에도 저장 — project.json이 날아가도 업로드 캡션/설명에 출처가 붙게.
      });
    } catch (e: any) { log('[하이라이트] 포트폴리오 등록 건너뜀: ' + (e?.message || '')); }
    // 출처(attribution)를 프로젝트 폴더에도 남긴다(상세설명 폴백 — project.json 읽기 실패 대비).
    try { fs.writeFileSync(path.join(studioDir, 'attribution.txt'), attribution); } catch {}

    results.push({projectId, file: output, title, hookTop: hookTopFinal || '', score: c.score});
    // ★먼저 끝난 편은 바로 쓸 수 있게 — 완성 즉시 콜백(server가 SSE로 흘려 프론트 카드 노출).
    try { opts.onClip?.({projectId, file: output, title, score: c.score, reason: c.reason}); } catch {}
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

// ★하이라이트 project.json 복구 로더 — 디스크 → R2 백업 → 포폴+R2 source로 최소 재구성 순.
//   볼륨이 정리돼 project.json이 날아가도(테리 H.O.T 영상 사고) source.mp4만 R2에 살아있으면 재편집 가능하게.
//   반환: {proj, restored} 또는 null(원본 자체가 없어 복구 불가).
export async function loadHlProject(projectId: string): Promise<{proj: any; dir: string} | null> {
  const dir = path.join(DATA_DIR, 'studio', projectId);
  const pjPath = path.join(dir, 'project.json');
  // 1) 디스크
  if (fs.existsSync(pjPath)) {
    try { return {proj: JSON.parse(fs.readFileSync(pjPath, 'utf8')), dir}; } catch {}
  }
  if (!r2Enabled()) return null;
  await fsp.mkdir(dir, {recursive: true}).catch(() => {});
  // 2) R2에 백업된 project.json 복원
  if (await fetchToTmp(videoKey(projectId, 'project.json'), undefined, pjPath)) {
    try { return {proj: JSON.parse(fs.readFileSync(pjPath, 'utf8')), dir}; } catch {}
  }
  // 3) project.json이 R2에도 없음 — source.mp4가 R2에 살아있으면 포폴 메타로 '최소 재구성'(옛 영상 구제)
  const srcKey = videoKey(projectId, 'source.mp4');
  const srcAlive = await r2Head(srcKey).catch(() => null);
  if (!srcAlive) return null; // 원본 클립조차 없으면 재편집 불가
  const item = listPortfolio().find((x) => x.projectId === projectId);
  const narrAlive = await r2Head(videoKey(projectId, 'narration.mp3')).catch(() => null);
  const title = (item?.title || '하이라이트');
  const baseTitle = title.replace(/\s\d+편\s*$/, '').trim();
  const orientation = item?.orientation === 'landscape' ? 'landscape' : 'portrait';
  const proj: any = {
    id: projectId, title, status: 'completed', orientation,
    output: item?.output, outputR2: item?.output ? srcKeyToOutput(projectId, item.output) : undefined,
    sourceR2: srcKey, narrationR2: narrAlive ? videoKey(projectId, 'narration.mp3') : undefined,
    scenes: [{narration: '', voice: {frames: 0}}],
    input: {duration: 30},
    kind: 'highlight',
    // 메타는 날아갔으니 기본값 — 사용자가 후킹·나레이션을 직접 입력해 재렌더한다.
    hlEdit: {hookTop: baseTitle.slice(0, 40), hookAccent: '', template: 'variety', words: [],
      durFrames: 0, muteOriginal: false, hasNarration: !!narrAlive, orientation, baseTitle},
  };
  return {proj, dir};
}
function srcKeyToOutput(projectId: string, output: string): string { return videoKey(projectId, output); }

// ★AI가 '영상 화면'을 보고 나레이션(해설)을 직접 써준다 — 나레이션 텍스트가 날아간 영상(테리 H.O.T)도
//   빈칸으로 두지 않고 화면 기준으로 복원·재작성. 인물 이름 단정 금지(로직센터 RULE은 writeCommentary가 적용).
export async function suggestNarration(projectId: string, log: (m: string) => void = () => {}): Promise<string> {
  const loaded = await loadHlProject(projectId);
  if (!loaded) throw new Error('이 영상은 원본(클립)이 없어 나레이션을 만들 수 없어요. 새로 만들어 주세요.');
  const {proj} = loaded;
  const e = proj.hlEdit || {};
  const k = pipelineKeys();
  if (!k.gemini.length) throw new Error('키 설정에서 Gemini 키를 저장하세요.');
  const work = path.join(os.tmpdir(), `hl-narr-${projectId}-${Date.now()}`);
  await fsp.mkdir(work, {recursive: true});
  try {
    // 깨끗한 클립 확보(R2/볼륨) → 화면 프레임 추출.
    const clipAbs = path.join(work, 'clip.mp4');
    const got = await fetchToTmp(proj.sourceR2, proj.source && path.join(loaded.dir, proj.source), clipAbs);
    const durSec = Math.max(5, (e.durFrames ? e.durFrames / FPS : (Number(proj.input?.duration) || 30)));
    const frames = got ? await clipVisionFrames(clipAbs, durSec, work).catch(() => []) : [];
    if (frames.length) log(`[나레이션] 화면 ${frames.length}장 분석 — 보이는 것 기준으로 작성(없는 인물 이름 방지)`);
    else log('[나레이션] 화면을 못 불러와 제목·대사 기준으로 작성합니다.');
    const title = e.baseTitle || proj.title || '';
    const transcript = e.transcript || '';
    const hook = e.hookTop || '';
    const text = await writeCommentary(k.gemini, title, transcript, hook, Math.round(durSec), log, frames);
    if (!text) throw new Error('나레이션 생성에 실패했어요. 다시 시도해 주세요.');
    return await autoSpace(k.gemini, text);
  } finally { await fsp.rm(work, {recursive: true, force: true}).catch(() => {}); }
}

// ★하이라이트 한 편을 '편집'해서 그 클립만 다시 렌더한다('✏️ 편집' 저장). 깨끗한 소스(source.mp4)+나레이션을
//   보존해뒀다가 후킹 문구·강조·디자인 템플릿만 바꿔 새로 렌더→output·썸네일 교체→project.json 갱신.
export async function reRenderHighlight(
  projectId: string,
  overrides: {hookTop?: string; hookAccent?: string; template?: string; narration?: string; voice?: string; thumbBig?: string; thumbBadge?: string; narrationOff?: boolean},
  log: (m: string) => void = () => {},
): Promise<{output: string}> {
  const studioDir = path.join(DATA_DIR, 'studio', projectId);
  const pjPath = path.join(studioDir, 'project.json');
  // ★project.json이 날아갔어도 R2 백업/포폴+source로 복구(테리 H.O.T 영상 사고 근본 수정).
  const loaded = await loadHlProject(projectId);
  if (!loaded) throw new Error('이 영상은 원본(클립)이 없어 다시 만들 수 없어요. 새로 만들어 주세요.');
  const proj: any = loaded.proj;
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
  let newWords: Word[] | undefined; // 나레이션을 새로 생성했으면 그 타이밍(기존 e.words 대체)
  // ★나레이션 끄기(설정) — 해설 없이 원본 소리만. 켜진 기존 나레이션도 제거.
  const narrationOff = !!overrides.narrationOff;
  // ★나레이션 수정 — 사용자가 새 해설 텍스트를 주면 TTS 재생성(저장된 깨끗한 클립에 새로 입힘).
  //   저장 전에 띄어쓰기·맞춤법 자동 교정(테리 요구 — 내용은 안 바뀜).
  let narrText = (!narrationOff && typeof overrides.narration === 'string') ? overrides.narration.trim() : '';
  if (narrText) { try { narrText = await autoSpace(pipelineKeys().gemini, narrText); } catch {} }
  if (narrText) {
    const ek = pipelineKeys().elevenlabs;
    if (ek) {
      log('[편집] 나레이션을 새로 만드는 중(TTS)…');
      try {
        const narrAbs = path.join(pubClipDir, 'narration.mp3');
        const voiceId = (VOICES[pickVoice(overrides.voice || proj.input?.voice, undefined)] || VOICES[pickVoice(undefined, undefined)]).id;
        const {align} = await ttsElevenJoined(ek, [narrText], narrAbs, voiceId);
        newWords = alignToWords(align, FPS);
        voiceRel = `${jobRel}/narration.mp3`;
      } catch (err: any) { log('[편집] 나레이션 생성 실패 → 기존 유지: ' + (err?.message || '').slice(0, 60)); }
    } else log('[편집] ElevenLabs 키가 없어 나레이션은 기존대로 둡니다.');
  }
  // 새로 안 만들었고 기존 나레이션이 있으면 그걸 재사용(후킹만 고친 경우 = 무회귀). ★나레이션 끄기면 재사용 안 함.
  if (!voiceRel && !narrationOff && e.hasNarration) {
    const narrAbs = path.join(pubClipDir, 'narration.mp3');
    if (await fetchToTmp(proj.narrationR2, proj.narration && path.join(studioDir, proj.narration), narrAbs)) voiceRel = `${jobRel}/narration.mp3`;
  }
  if (narrationOff) log('[편집] 나레이션 끄기 — 해설 없이 원본 소리로 만듭니다.');

  // 2) 장면 재구성 — 저장된 메타 + 사용자 오버라이드(후킹·템플릿).
  const tpl = getHlTemplate(overrides.template && overrides.template !== 'auto' ? overrides.template : e.template);
  const orientation: 'portrait' | 'landscape' = e.orientation === 'landscape' ? 'landscape' : 'portrait';
  const hookTop = (overrides.hookTop !== undefined ? overrides.hookTop : e.hookTop || '').slice(0, 40);
  const hookAccent = (overrides.hookAccent !== undefined ? overrides.hookAccent : e.hookAccent || '').slice(0, 20);
  // 나레이션 끄면 자막(words)도 비우고, 원본 소리를 살린다(muteOriginal 강제 해제 — 무음 방지).
  const words = narrationOff ? [] : (newWords ?? (Array.isArray(e.words) ? e.words : []));
  const durFrames = (newWords && newWords.length)
    ? newWords[newWords.length - 1].e + 15 // 새 나레이션 길이에 맞춤(끝 0.5초 여운)
    : (e.durFrames || Math.round((Number(proj.input?.duration) || 30) * FPS));
  const scene: SceneData = {
    image: `${jobRel}/clip.mp4`, video: `${jobRel}/clip.mp4`, fullBleed: true,
    template: tpl.id, hookTop, hookAccent, accentColor: tpl.accentColor,
    words, duckAudio: !!voiceRel, muteOriginal: narrationOff ? false : !!e.muteOriginal,
    durationInFrames: durFrames,
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
        // 썸네일 문구 — 사용자가 썸네일칸을 직접 고쳤으면 그걸, 아니면 후킹으로 자동.
        const thBig = (overrides.thumbBig !== undefined && overrides.thumbBig.trim() ? overrides.thumbBig : (hookTop || e.baseTitle || '')).slice(0, 28);
        const thBadge = (overrides.thumbBadge !== undefined ? overrides.thumbBadge : (hookAccent || '')).slice(0, 8);
        await renderThumbnail({image: `${jobRel}/${bgName}`, big: thBig, small: '', badge: thBadge, accentColor: tpl.accentColor}, thumbAbs, log, publicDir, orientation);
        thumbOk = fs.existsSync(thumbAbs);
      } catch {}
    }
    if (!thumbOk) { try { thumbOk = await extractThumb(outAbs, thumbAbs, 1.0); } catch {} }
    // 나레이션을 새로 만들었으면 R2/볼륨에 갱신(pubClipDir 삭제 전 — 다음 편집·업로드가 새 나레이션을 씀).
    if (newWords && voiceRel) {
      const narrSrc = path.join(pubClipDir, 'narration.mp3');
      if (r2Enabled()) { try { const nk = videoKey(projectId, 'narration.mp3'); if (await uploadFile(nk, narrSrc, 'audio/mpeg')) proj.narrationR2 = nk; } catch {} }
      else { try { fs.copyFileSync(narrSrc, path.join(studioDir, 'narration.mp3')); proj.narration = 'narration.mp3'; } catch {} }
    }
  } finally {
    await fsp.rm(publicDir, {recursive: true, force: true});
    await fsp.rm(pubClipDir, {recursive: true, force: true});
    await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
  }

  // 4) output·썸네일 교체 + project.json 갱신(R2 포함). 옛 output은 교체되므로 R2 키만 바꾸면 됨.
  const oldOutput = proj.output;
  proj.output = output;
  // 편집(후킹 변경)해도 끝의 누적 회차('N편')는 유지한다. 기존 제목에서 회차를 떼어내 새 후킹 뒤에 다시 붙임.
  const epM = /\s(\d+편)\s*$/.exec(proj.title || '');
  const epSuffix = epM ? ' ' + epM[1] : '';
  const newBase = (hookTop || (proj.title || '').replace(/\s\d+편\s*$/, '') || e.baseTitle || '하이라이트').slice(0, 74);
  proj.title = (newBase + epSuffix).slice(0, 80);
  proj.hlEdit = {...e, hookTop, hookAccent, template: tpl.id, muteOriginal: scene.muteOriginal,
    ...(overrides.thumbBig !== undefined ? {thumbBig: overrides.thumbBig.slice(0, 40)} : {}),
    ...(overrides.thumbBadge !== undefined ? {thumbBadge: overrides.thumbBadge.slice(0, 20)} : {}),
    ...(narrationOff ? {words: [], hasNarration: false, durFrames} : (newWords ? {words: newWords, hasNarration: true, durFrames} : {}))};
  if (narrationOff && Array.isArray(proj.scenes) && proj.scenes[0]) proj.scenes[0].narration = '';
  if (narrText && newWords) {
    // edit-info가 돌려줄 '현재 나레이션'을 갱신(다음에 또 열면 수정한 텍스트가 보이게).
    if (!Array.isArray(proj.scenes) || !proj.scenes.length) proj.scenes = [{}];
    proj.scenes[0] = {...proj.scenes[0], narration: narrText, voice: {frames: durFrames}};
  }
  if (r2Enabled()) {
    try {
      const key = videoKey(projectId, output);
      if (await uploadFile(key, outAbs, 'video/mp4')) { proj.outputR2 = key; fs.rmSync(outAbs, {force: true}); }
      else { fs.copyFileSync(outAbs, path.join(studioDir, output)); fs.rmSync(outAbs, {force: true}); delete proj.outputR2; }
      if (thumbOk && fs.existsSync(thumbAbs)) { const tk = videoKey(projectId, 'thumb.png'); if (await uploadFile(tk, thumbAbs, 'image/png')) proj.thumbR2 = tk; }
      // ★인스타 커버(cover.jpg) 캐시 무효화 — 썸네일 바꿨는데 인스타에 옛 커버가 나오던 버그(테리 H.O.T→구피).
      //   ensureThumbJpegUrl이 cover.jpg가 있으면 그대로 재사용하므로, 재렌더 시 삭제해 새 썸네일로 다시 만들게 한다.
      try { await deleteR2Key(videoKey(projectId, 'cover.jpg')); } catch {}
      delete proj.thumbJpgR2;
    } catch (e2: any) { log('[편집] R2 갱신 실패(로컬 보관): ' + (e2?.message || '')); try { fs.copyFileSync(outAbs, path.join(studioDir, output)); fs.rmSync(outAbs, {force: true}); delete proj.outputR2; } catch {} }
  }
  proj.thumb = thumbOk ? 'thumb.png' : proj.thumb;
  fs.writeFileSync(pjPath + '.tmp', JSON.stringify(proj));
  fs.renameSync(pjPath + '.tmp', pjPath);
  // ★project.json도 R2 백업(볼륨 날아가도 재편집 메타 보존).
  if (r2Enabled()) { try { await uploadFile(videoKey(projectId, 'project.json'), pjPath, 'application/json'); } catch {} }
  // 포트폴리오 제목 동기화.
  try {
    const items = listPortfolio();
    const idx = items.findIndex((x) => x.projectId === projectId);
    if (idx >= 0) {
      const it = items[idx];
      it.title = proj.title; it.editV = Date.now(); // 썸네일 캐시버스터 — 수정하면 새 썸네일이 바로 보이게
      // ★수정한 영상을 맨 앞으로(테리: 수정하면 포폴 맨 앞에 뜨게). 포폴은 앞이 최신.
      items.splice(idx, 1); items.unshift(it);
      const fp = path.join(DATA_DIR, 'portfolio.json'); fs.writeFileSync(fp + '.tmp', JSON.stringify(items)); fs.renameSync(fp + '.tmp', fp);
    }
  } catch {}
  log('[편집] ✅ 다시 렌더 완료!');
  return {output};
}
