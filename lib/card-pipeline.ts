// 카드뉴스 영상 파이프라인 — 주제→카드대본→배경→(나레이션/BGM 토글)→렌더.
// '카드만' 모드 = 나레이션 OFF. 글자 중심 카드가 슬라이드로 넘어가고 BGM만.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir, rm} from 'node:fs/promises';
import {generateCardStoryboard, type CardPlan, type CardStoryboard} from './cards';
import {getPreset} from './presets';
import {generateImageFlux} from './image';
import {ttsElevenJoined, alignToWords} from './tts';
import {VOICES, pickVoice, DEFAULT_VOICE} from './tts';
import type {CharAlign} from './tts';
import {generateBgm} from './music';
import {renderCardVideo, renderCardStills, buildRenderPublic} from './render';
import {buildZip} from './zip';
import {writeFile} from 'node:fs/promises';
import type {CardData, MotionStyle} from '../src/Card';
import {pickSkin, getSkin} from '../src/skins';
import {registerCardDeck} from './card-portfolio';

const FPS = 30;

export type CardKeys = {gemini: string[]; openai?: string; elevenlabs?: string; replicate?: string};
export type CardBg = 'ai' | 'solid' | 'upload';
export type CardOutput = 'video' | 'post';
export type CardOpts = {
  topic: string;
  count?: number;          // 카드 장수(3~12)
  presetId?: string;
  output?: CardOutput;     // video=릴스 MP4 / post=캐러셀 PNG N장+ZIP
  bg?: CardBg;             // 배경: ai 이미지 / 단색 그라데이션 / 업로드
  uploads?: string[];      // bg=upload일 때 public 상대경로들(카드순)
  narration?: boolean;     // 나레이션 ON/OFF (video만)
  bgm?: boolean;           // 배경음악 ON/OFF (video만)
  voice?: string;          // 나레이션 목소리 키
  imageStyle?: string; // 아트스타일 id(레지스트리 lib/styles.ts)
  cardTheme?: 'light' | 'dark'; // 본문 카드 톤(기본 light=매거진). cover/closing은 항상 사진 위 다크.
  motion?: MotionStyle;    // 등장 효과(auto/pop/slide/type/zoom/flip)
  skin?: string;           // 디자인 시스템 id(skins.ts). 미지정=주제로 자동 선택.
  font?: string;           // 제목 폰트(모든 탭 공통, 화이트리스트 통과분). 미지정=스킨 폰트.
  storyboard?: CardStoryboard; // ★대본편집: 사용자가 고친 카드 대본(있으면 AI 재생성 안 하고 이걸로 제작).
  log?: (m: string) => void;
  isCancelled?: () => boolean; // ★사용자 중단 — 단계 경계마다 확인(영상 파이프라인과 동일).
};

// 카드 → 나레이션용 텍스트(타입별로 자연스럽게 읽히게 조합).
function cardSpeech(c: CardPlan): string {
  const parts: string[] = [];
  if (c.small) parts.push(c.small);
  if (c.big) parts.push(c.big);
  if (c.title) parts.push(c.title);
  if (c.number) parts.push(c.number + (c.unit || ''));
  if (c.items?.length) parts.push(c.items.join('. '));
  if (c.before) parts.push('예전엔 ' + c.before);
  if (c.after) parts.push('이제는 ' + c.after);
  if (c.wrong) parts.push('흔한 실수, ' + c.wrong);
  if (c.right) parts.push('올바른 방법, ' + c.right);
  if (c.body) parts.push(c.body);
  // ★해시태그(#태그)는 나레이션에서 읽지 않는다 — 제거하고 공백 정리(테리 지시).
  return parts.join('. ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300) || '다음';
}

// 카드 → 읽을 글자 수(나레이션 OFF일 때 표시 시간 산정용).
function cardLen(c: CardPlan): number {
  return cardSpeech(c).length;
}

export async function makeCardVideo(keys: CardKeys, opts: CardOpts): Promise<{out: string; title: string; dir: string; kind: CardOutput; images?: string[]; projectId?: string}> {
  const log = opts.log || (() => {});
  const ck = () => { if (opts.isCancelled?.()) throw new Error('사용자가 중단했습니다.'); };
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/card-${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  const bgMode: CardBg = opts.bg || 'solid';
  const output: CardOutput = opts.output === 'post' ? 'post' : 'video';
  const count = Math.max(3, Math.min(12, opts.count || 7));

  // 대본편집: 편집된 대본이 오면 그대로 사용(AI 재생성·비용 없음), 없으면 AI로 생성.
  const sb = opts.storyboard && Array.isArray(opts.storyboard.cards) && opts.storyboard.cards.length
    ? (log('[대본] 편집한 대본으로 제작'), opts.storyboard)
    : await generateCardStoryboard({gemini: keys.gemini, openai: keys.openai}, opts.topic, count, preset, opts.imageStyle);
  log(`[대본] "${sb.title}" · 카드 ${sb.cards.length}장 (${sb.cards.map(c => c.type).join('/')})`);
  ck();

  // ★스킨 자동 선택 — 주제/카테고리로 어울리는 디자인 시스템을 고른다(덱마다 폰트·배경·색·장식·모션이
  //   통째로 달라져 100개면 100개가 다른 룩). 제목 기준이라 "제목 자동인식→모션그래픽"(테리).
  const skin = opts.skin ? getSkin(opts.skin) : pickSkin(sb.title || opts.topic, preset?.label);
  log(`[디자인] 스킨 "${skin.name}" (${skin.headFont} · ${skin.bg} 배경 · ${skin.deco} 장식 · ${skin.entrance} 모션)`);

  // 배경 준비 — ai=카드별 flux, upload=사용자 이미지, solid=없음.
  const bgRel: (string | undefined)[] = [];
  for (let i = 0; i < sb.cards.length; i++) {
    ck(); // 배경 이미지 생성이 길어 중단 요청이 여기서 바로 반영됨
    if (bgMode === 'ai') {
      if (!keys.replicate) throw new Error('AI 배경을 쓰려면 Replicate 키가 필요합니다.');
      const rel = `${pubRel}/bg-${i}.jpg`;
      log(`[배경 ${i + 1}/${sb.cards.length}] 이미지 생성…`);
      // ★영상과 100% 동일: subject(핵심 소재) + 카드별 visualPrompt + 소재 강제 → flux-dev(high).
      //   (영상 pipeline.ts와 토씨까지 같은 방식. 간판/글자 깨짐은 '글자 피사체 금지' 지시 + 좋은 피사체 서술로 방지)
      const card = sb.cards[i];
      const vp = sb.subject
        ? `${sb.subject}. ${card.visualPrompt || opts.topic}. (main subject must be ${sb.subject})`
        : (card.visualPrompt || opts.topic);
      try { await generateImageFlux(keys.replicate, vp, abs(rel), log, 'high', opts.imageStyle || 'real', false); bgRel.push(`${pubRel}/bg-${i}.jpg`); }
      catch (e: any) { log(`[배경 ${i + 1}] ⚠️ 실패(${e.message}) → 단색 배경`); bgRel.push(undefined); }
    } else if (bgMode === 'upload') {
      bgRel.push(opts.uploads?.[i] || opts.uploads?.[opts.uploads.length - 1]);
    } else {
      bgRel.push(undefined);
    }
  }

  // 나레이션(토글) — ON이면 통짜 TTS + 카드별 구간으로 길이 산정.
  let voiceSrc: string | undefined;
  let ranges: [number, number][] = [];
  let alignData: CharAlign | null = null; // 카라오케 단어 타이밍 원본
  if (opts.narration && output === 'video') {
    if (!keys.elevenlabs) throw new Error('나레이션을 쓰려면 ElevenLabs 키가 필요합니다.');
    const voiceKey = pickVoice(opts.voice, preset?.voice, opts.imageStyle);
    const voiceId = VOICES[voiceKey]?.id || VOICES[DEFAULT_VOICE].id;
    log('[음성] 나레이션 생성 중…');
    const voiceRel = `${pubRel}/voice.mp3`;
    const {sceneRanges, align} = await ttsElevenJoined(keys.elevenlabs, sb.cards.map(cardSpeech), abs(voiceRel), voiceId);
    voiceSrc = voiceRel;
    ranges = sceneRanges;
    alignData = align;
  }
  ck();

  // 카드 데이터 조립 + 길이.
  const palette = preset?.accentColors?.length ? preset.accentColors : ['#FFD84D', '#4FE0D0', '#FF8ABf'];
  const bgColors = ['#20223a', '#1a2a2a', '#2a1a2a', '#222', '#1a2230', '#201a2a', '#23201a', '#2a1a24'];
  const cards: CardData[] = sb.cards.map((c, i): CardData => {
    let durationInFrames: number;
    if (opts.narration && ranges[i]) {
      const [s, e] = ranges[i];
      const sec = e > s ? e - s : cardLen(c) / 3.9;
      durationInFrames = Math.max(FPS * 2, Math.round((sec + (i === sb.cards.length - 1 ? 0.6 : 0.2)) * FPS));
    } else {
      // 나레이션 OFF: 글자 수 기준 읽을 시간(최소 2.5초, 최대 6초).
      const sec = Math.min(6, Math.max(2.5, cardLen(c) / 11));
      durationInFrames = Math.round(sec * FPS);
    }
    const isHero = c.type === 'cover' || c.type === 'closing';
    return {
      type: c.type,
      bg: bgRel[i],
      bgColor: bgColors[i % bgColors.length],
      accent: c.accent || palette[i % palette.length],
      theme: isHero ? 'dark' : (opts.cardTheme || 'light'),
      motion: opts.motion || 'auto',
      skin: skin.id,
      font: opts.font || undefined, // 사용자가 고른 제목 폰트(모든 탭 공통). 자동이면 스킨 폰트 유지.
      kicker: isHero ? undefined : (preset?.label || undefined),
      badge: c.badge, big: c.big, small: c.small, title: c.title, body: c.body,
      number: c.number, unit: c.unit, items: c.items,
      before: c.before, after: c.after, wrong: c.wrong, right: c.right,
      // ★카라오케 단어 타이밍(카드 시작 기준 프레임). 나레이션 ON일 때만.
      words: (opts.narration && alignData && ranges[i]) ? alignToWords(alignData, FPS, ranges[i][0], ranges[i]) : undefined,
      durationInFrames, index: i, total: sb.cards.length,
    };
  });

  await mkdir(path.join(process.cwd(), 'out'), {recursive: true});

  // 포트폴리오 등록용 메타(영상과 동일 양식) — 목소리 라벨·카테고리·뱃지색·나레이션·길이.
  const vKey = pickVoice(opts.voice, preset?.voice, opts.imageStyle);
  const regVoice = opts.narration ? (VOICES[vKey]?.label || vKey) : '🎴 카드뉴스';
  const regGoal: 'issue' | 'info' | 'sell' | 'heal' = (opts.narration && (VOICES[vKey]?.use?.[0] as any)) || 'info';
  const regCategory = preset ? `${preset.emoji} ${preset.label}` : '🎴 카드뉴스';
  const regNarrations = sb.cards.map(cardSpeech);
  const regDurSec = cards.reduce((a, c) => a + c.durationInFrames, 0) / FPS;

  ck(); // 렌더 직전 — 여기까지 안 멈췄으면 렌더(게시물 PNG/영상)는 끝까지 간다(통짜 단계).
  // ── 게시물(캐러셀) 모드: 카드 N장을 4:5 PNG로 뽑고 ZIP으로 묶는다(오디오 없음). ──
  if (output === 'post') {
    const pngAbs = cards.map((_, i) => abs(`${pubRel}/card-${i + 1}.png`));
    log('[게시물] 카드 이미지 생성 중…');
    // 전용 public 폴더로 렌더(캐시 번들엔 이 작업의 bg 이미지가 없다). PNG 출력은 실제 public/jobs/에 그대로 쓴다.
    const stillPublic = await buildRenderPublic(pubRel);
    try {
      await renderCardStills(cards, pngAbs, log, stillPublic);
    } finally { await rm(stillPublic, {recursive: true, force: true}); }
    const files = pngAbs.map((p, i) => ({name: `${String(i + 1).padStart(2, '0')}.png`, path: p}));
    const zipAbs = path.join(process.cwd(), 'out', `cards-${id}.zip`);
    await writeFile(zipAbs, buildZip(files));
    log(`[완료] 게시물 카드 ${cards.length}장 완성! (ZIP + 개별 이미지)`);
    // images = 웹에서 미리보기할 public 상대경로.
    const images = cards.map((_, i) => `${pubRel}/card-${i + 1}.png`);
    let projectId: string | undefined;
    try {
      projectId = await registerCardDeck({cards, title: sb.title, kind: 'post', out: zipAbs, images, narrations: regNarrations, voice: regVoice, category: regCategory, goal: regGoal, orientation: 'portrait', durSec: regDurSec, log});
    } catch (e: any) { log('[안내] 포트폴리오 등록 건너뜀: ' + (e?.message || e)); }
    return {out: zipAbs, title: sb.title, dir: abs(pubRel), kind: 'post', images, projectId};
  }

  // ── 영상(릴스) 모드 ──
  let bgmSrc: string | undefined;
  if (opts.bgm) {
    if (!keys.elevenlabs) throw new Error('배경음악을 쓰려면 ElevenLabs 키가 필요합니다.');
    const totalMs = (cards.reduce((a, c) => a + c.durationInFrames, 0) / FPS) * 1000;
    const bgmRel = `${pubRel}/bgm.mp3`;
    // ★영상과 동일: 카테고리별 검증된 무드(preset.musicMood)를 최우선으로 쓴다. 카드는 나레이션이
    //   없을 때가 많아 음악이 분위기를 주도하므로, AI 즉석 무드(어둡게 나오던 원인)보다 신뢰도 높은
    //   카테고리 무드를 우선. 둘 다 없으면 밝은 기본값. 어둡거나 무서운 무드는 쓰지 않는다.
    const musicMood = preset?.musicMood || sb.musicPrompt || 'upbeat bright cheerful light background music, positive and clean';
    log('[BGM] 배경음악 생성 중…');
    await generateBgm(keys.elevenlabs, musicMood, totalMs, abs(bgmRel), log);
    bgmSrc = bgmRel;
  }

  log('[렌더] 최종 합성…');
  const out = path.join(process.cwd(), 'out', `card-${id}.mp4`);
  // ★나레이션 ON이면 전환 0(컷) — 슬라이드 전환이 겹치면 카라오케·오디오 싱크가 밀린다(영상과 동일 정책).
  const transitionFrames = voiceSrc ? 0 : 12;
  // 전용 public 폴더로 렌더 — 이 작업의 bg/음성/BGM이 담긴 번들을 새로 만들어 staticFile이 전부 찾게 한다.
  const renderPublic = await buildRenderPublic(pubRel);
  try {
    await renderCardVideo(cards, transitionFrames, out, log, bgmSrc, voiceSrc, renderPublic, 'portrait');
  } finally { await rm(renderPublic, {recursive: true, force: true}); }
  log('[완료] 카드뉴스 영상 완성!');
  let projectId: string | undefined;
  try {
    projectId = await registerCardDeck({cards, title: sb.title, kind: 'video', out, narrations: regNarrations, voice: regVoice, category: regCategory, goal: regGoal, orientation: 'portrait', durSec: regDurSec, log});
  } catch (e: any) { log('[안내] 포트폴리오 등록 건너뜀: ' + (e?.message || e)); }
  return {out, title: sb.title, dir: abs(pubRel), kind: 'video', projectId};
}
