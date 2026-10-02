// 카드뉴스 영상 파이프라인 — 주제→카드대본→배경→(나레이션/BGM 토글)→렌더.
// '카드만' 모드 = 나레이션 OFF. 글자 중심 카드가 슬라이드로 넘어가고 BGM만.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {generateCardStoryboard, type CardPlan} from './cards';
import {getPreset} from './presets';
import {generateImageFlux} from './image';
import {ttsElevenJoined} from './tts';
import {VOICES, pickVoice} from './tts';
import {generateBgm} from './music';
import {renderCardVideo, renderCardStills} from './render';
import {buildZip} from './zip';
import {writeFile} from 'node:fs/promises';
import type {CardData, MotionStyle} from '../src/Card';

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
  imageStyle?: 'real' | 'anime';
  cardTheme?: 'light' | 'dark'; // 본문 카드 톤(기본 light=매거진). cover/closing은 항상 사진 위 다크.
  motion?: MotionStyle;    // 등장 효과(auto/pop/slide/type/zoom/flip)
  log?: (m: string) => void;
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
  return parts.join('. ').replace(/\n/g, ' ').slice(0, 300) || '다음';
}

// 카드 → 읽을 글자 수(나레이션 OFF일 때 표시 시간 산정용).
function cardLen(c: CardPlan): number {
  return cardSpeech(c).length;
}

export async function makeCardVideo(keys: CardKeys, opts: CardOpts): Promise<{out: string; title: string; dir: string; kind: CardOutput; images?: string[]}> {
  const log = opts.log || (() => {});
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/card-${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  const bgMode: CardBg = opts.bg || 'solid';
  const output: CardOutput = opts.output === 'post' ? 'post' : 'video';
  const count = Math.max(3, Math.min(12, opts.count || 7));

  log('[대본] 카드 구성 중…');
  const sb = await generateCardStoryboard({gemini: keys.gemini, openai: keys.openai}, opts.topic, count, preset);
  log(`[대본] "${sb.title}" · 카드 ${sb.cards.length}장 (${sb.cards.map(c => c.type).join('/')})`);

  // 배경 준비 — ai=카드별 flux, upload=사용자 이미지, solid=없음.
  const bgRel: (string | undefined)[] = [];
  for (let i = 0; i < sb.cards.length; i++) {
    if (bgMode === 'ai') {
      if (!keys.replicate) throw new Error('AI 배경을 쓰려면 Replicate 키가 필요합니다.');
      const rel = `${pubRel}/bg-${i}.jpg`;
      const prompt = `${opts.topic}. clean minimal background photo for a text card, soft focus, no text, no letters, muted tones`;
      log(`[배경 ${i + 1}/${sb.cards.length}] 이미지 생성…`);
      try { await generateImageFlux(keys.replicate, prompt, abs(rel), log, 'fast', opts.imageStyle || 'real', false); bgRel.push(`${pubRel}/bg-${i}.jpg`); }
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
  if (opts.narration && output === 'video') {
    if (!keys.elevenlabs) throw new Error('나레이션을 쓰려면 ElevenLabs 키가 필요합니다.');
    const voiceKey = pickVoice(opts.voice, preset?.voice, opts.imageStyle);
    const voiceId = VOICES[voiceKey]?.id || VOICES.adam.id;
    log('[음성] 나레이션 생성 중…');
    const voiceRel = `${pubRel}/voice.mp3`;
    const {sceneRanges} = await ttsElevenJoined(keys.elevenlabs, sb.cards.map(cardSpeech), abs(voiceRel), voiceId);
    voiceSrc = voiceRel;
    ranges = sceneRanges;
  }

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
      kicker: isHero ? undefined : (preset?.label || undefined),
      badge: c.badge, big: c.big, small: c.small, title: c.title, body: c.body,
      number: c.number, unit: c.unit, items: c.items,
      before: c.before, after: c.after, wrong: c.wrong, right: c.right,
      durationInFrames, index: i, total: sb.cards.length,
    };
  });

  await mkdir(path.join(process.cwd(), 'out'), {recursive: true});

  // ── 게시물(캐러셀) 모드: 카드 N장을 4:5 PNG로 뽑고 ZIP으로 묶는다(오디오 없음). ──
  if (output === 'post') {
    const pngAbs = cards.map((_, i) => abs(`${pubRel}/card-${i + 1}.png`));
    log('[게시물] 카드 이미지 생성 중…');
    await renderCardStills(cards, pngAbs, log);
    const files = pngAbs.map((p, i) => ({name: `${String(i + 1).padStart(2, '0')}.png`, path: p}));
    const zipAbs = path.join(process.cwd(), 'out', `cards-${id}.zip`);
    await writeFile(zipAbs, buildZip(files));
    log(`[완료] 게시물 카드 ${cards.length}장 완성! (ZIP + 개별 이미지)`);
    // images = 웹에서 미리보기할 public 상대경로.
    return {out: zipAbs, title: sb.title, dir: abs(pubRel), kind: 'post', images: cards.map((_, i) => `${pubRel}/card-${i + 1}.png`)};
  }

  // ── 영상(릴스) 모드 ──
  let bgmSrc: string | undefined;
  if (opts.bgm) {
    if (!keys.elevenlabs) throw new Error('배경음악을 쓰려면 ElevenLabs 키가 필요합니다.');
    const totalMs = (cards.reduce((a, c) => a + c.durationInFrames, 0) / FPS) * 1000;
    const bgmRel = `${pubRel}/bgm.mp3`;
    log('[BGM] 배경음악 생성 중…');
    await generateBgm(keys.elevenlabs, sb.musicPrompt, totalMs, abs(bgmRel), log);
    bgmSrc = bgmRel;
  }

  log('[렌더] 최종 합성…');
  const out = path.join(process.cwd(), 'out', `card-${id}.mp4`);
  const transitionFrames = 12;
  await renderCardVideo(cards, transitionFrames, out, log, bgmSrc, voiceSrc, undefined, 'portrait');
  log('[완료] 카드뉴스 영상 완성!');
  return {out, title: sb.title, dir: abs(pubRel), kind: 'video'};
}
