// 전체 파이프라인 — 링크 → 본문 → 대본 → 장면별(이미지+음성+자막타이밍) → Remotion 렌더.
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {generateStoryboard} from './script';
import {generateImageFlux} from './image';
import {ttsElevenJoined, alignToWords, VOICES, pickVoice, DEFAULT_VOICE} from './tts';
import {generateBgm} from './music';
import {getPreset} from './presets';
import {renderVideo} from './render';
import type {SceneData} from '../src/Scene';

const FPS = 30;

export async function fetchSource(urls: string[], log: (m: string) => void): Promise<string> {
  const blocks: string[] = [];
  for (const u of urls) {
    try {
      const r = await fetch('https://r.jina.ai/' + u, {
        headers: {Accept: 'text/plain'},
        signal: AbortSignal.timeout(35000),
      });
      if (r.ok) {
        const t = (await r.text())
          .replace(/^URL Source:.*$|^Markdown Content:.*$/gm, '')
          .slice(0, 12000);
        if (t.length > 100) {
          blocks.push(t);
          log(`[본문] ${new URL(u).hostname} 읽음`);
        }
      }
    } catch {
      log(`[본문] ${u} 읽기 실패`);
    }
  }
  if (!blocks.length) throw new Error('링크 본문을 읽지 못했습니다.');
  return blocks.join('\n\n').slice(0, 40000);
}

export type PipelineKeys = {
  gemini: string[];
  openai?: string;
  elevenlabs: string;
  replicate: string;
};

export type PipelineOpts = {
  duration: number;
  voice?: string; // 지정 안 하면 프리셋 추천 목소리 사용
  purpose?: string;
  presetId?: string; // ★카테고리 프리셋 id (있으면 톤·이미지·목소리·BGM 자동)
  quality?: 'fast' | 'high'; // 이미지 화질(fast=schnell 싸게 / high=dev 실사)
  imageStyle?: string; // 이미지 스타일 id(레지스트리 lib/styles.ts. real·anime·chalkboard 등)
  aiClips?: number; // Veo 움직이는 클립 개수(0=안씀, 기본 0)
  transitionFrames?: number;
  log?: (m: string) => void;
};

export async function makeVideo(
  urls: string[],
  keys: PipelineKeys,
  opts: PipelineOpts,
): Promise<{out: string; title: string; imageDir: string}> {
  const log = opts.log || (() => {});
  // ★화면비: 롱폼(≥90초)=가로 16:9 / 쇼츠=세로 9:16. UI "롱폼" optgroup(90/120/180)과 일치.
  const landscape = opts.duration >= 90;
  const orientation: 'portrait' | 'landscape' = landscape ? 'landscape' : 'portrait';
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});

  const source = await fetchSource(urls, log);

  // ★카테고리 프리셋: 있으면 톤·이미지·목소리·BGM을 그 바닥 최적값으로 자동 세팅.
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  if (preset) log(`[카테고리] ${preset.emoji} ${preset.label} — 최적 세팅 자동 적용`);

  log('[대본] 생성 중…');
  const sb = await generateStoryboard(keys.gemini, source, {
    duration: opts.duration,
    purpose: opts.purpose,
    preset,
    openaiKey: keys.openai,
    log,
  });
  log(`[대본] "${sb.title}" · ${sb.scenes.length}장면`);

  // 목소리: 사용자 지정 > (애니 스타일이면 애니 목소리) > 프리셋 추천 > adam
  const voiceKey = pickVoice(opts.voice, preset?.voice, opts.imageStyle);
  const voiceId = VOICES[voiceKey]?.id || VOICES[DEFAULT_VOICE].id;
  const scenes: SceneData[] = [];

  // ★음성은 통짜로 한 번에 생성(억양이 자연스럽게 이어짐). 장면별 구간(sceneRanges)만 나눠 쓴다.
  log('[음성] 전체 나레이션 한 번에 생성(자연스러운 억양)…');
  const voiceRel = `${pubRel}/voice.mp3`;
  const {align, sceneRanges} = await ttsElevenJoined(
    keys.elevenlabs,
    sb.scenes.map((s) => s.narration),
    abs(voiceRel),
    voiceId,
  );

  for (let i = 0; i < sb.scenes.length; i++) {
    const s = sb.scenes[i];
    const imgRel = `${pubRel}/img-${i}.jpg`;

    log(`[장면 ${i + 1}/${sb.scenes.length}] 이미지 생성…`);
    const vp = sb.subject
      ? `${sb.subject}. ${s.visualPrompt}. (main subject must be ${sb.subject})`
      : s.visualPrompt;
    try {
      await generateImageFlux(keys.replicate, vp, abs(imgRel), log, opts.quality || 'high', opts.imageStyle || 'real', landscape);
    } catch (e: any) {
      log(`[장면 ${i + 1}] ⚠️ 이미지 생성 실패(${e.message}) → 임시 placeholder`);
      const r = await fetch(`https://picsum.photos/seed/ov${id}${i}/${landscape ? '1920/1080' : '1080/1920'}`);
      await writeFile(abs(imgRel), Buffer.from(await r.arrayBuffer()));
    }

    const [startSec, endSec] = sceneRanges[i] || [0, 0];
    const words = alignToWords(align, FPS, startSec, [startSec, endSec]);
    const durSec = endSec > startSec ? endSec - startSec : s.narration.length / 3.9;
    // 마지막 장면만 꼬리 여유, 중간은 딱 붙여 통짜 오디오와 싱크
    const tail = i === sb.scenes.length - 1 ? 0.5 : 0.15;
    const durationInFrames = Math.max(FPS, Math.round((durSec + tail) * FPS));

    scenes.push({
      image: imgRel,
      hookTop: s.hookTop,
      hookAccent: s.hookAccent,
      accentColor: s.accentColor || '#FFE24B',
      words,
      durationInFrames,
      audioStartSec: startSec, // 통짜 오디오에서 이 장면 시작점
      punch: i === 0,
      motion: i,
      comment: s.comment,
    });
  }

  // ★통짜 음성이라 장면 전환은 0(전환으로 겹치면 오디오 싱크가 깨진다). 컷 편집으로 딱딱.
  const transitionFrames = 0;
  const totalFrames = scenes.reduce((a, s) => a + s.durationInFrames, 0);
  const totalMs = (totalFrames / FPS) * 1000;
  const bgmRel = `${pubRel}/bgm.mp3`;
  log('[BGM] 배경음악 생성 중…');
  const musicMood = sb.musicPrompt || preset?.musicMood || '';
  // BGM 실패 시 throw(사유 포함) → 제작 중단. 웹/CLI 동일 정책.
  await generateBgm(keys.elevenlabs, musicMood, totalMs, abs(bgmRel), log);
  const bgmSrc: string = bgmRel;

  log('[렌더] 최종 합성…');
  const out = path.join(process.cwd(), 'out', `${id}.mp4`);
  await mkdir(path.join(process.cwd(), 'out'), {recursive: true});
  await renderVideo(scenes, transitionFrames, out, log, bgmSrc, voiceRel, undefined, orientation);
  log(`[완료] ${out}`);
  return {out, title: sb.title, imageDir: abs(pubRel)};
}
