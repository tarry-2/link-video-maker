// 전체 파이프라인 — 링크 → 본문 → 대본 → 장면별(이미지+음성+자막타이밍) → Remotion 렌더.
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {generateStoryboard} from './script';
import {generateImageFlux} from './image';
import {ttsElevenJoined, alignToWords, VOICES, pickVoice, DEFAULT_VOICE} from './tts';
import {generateBgm} from './music';
import {getPreset} from './presets';
import {renderVideo, buildRenderPublic} from './render';
import {getStyle} from './styles';
import {ensureWanPod, wanT2V, terminatePod} from './runpod-wan';
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
  runpod?: string; // RunPod 키(움직이는 AI 영상, 선택)
};

export type PipelineOpts = {
  duration: number;
  voice?: string; // 지정 안 하면 프리셋 추천 목소리 사용
  purpose?: string;
  presetId?: string; // ★카테고리 프리셋 id (있으면 톤·이미지·목소리·BGM 자동)
  quality?: 'fast' | 'high'; // 이미지 화질(fast=schnell 싸게 / high=dev 실사)
  imageStyle?: string; // 이미지 스타일 id(레지스트리 lib/styles.ts. real·anime·chalkboard 등)
  sceneCount?: number; // ★장면(이미지) 수 직접 지정(0/미지정=길이로 자동). 2~12.
  aiClips?: number; // 움직이는 AI 영상(Wan2.2) 클립 개수(0=안씀, 기본 0). 앞에서부터 N개 장면에 적용.
  autoShutdown?: boolean; // 움직이는 영상 작업이 끝나면 RunPod 팟을 자동 종료(과금 중단). 기본 true.
  narration?: boolean; // 나레이션(AI 음성) 넣기. 기본 true. false면 음성·단어자막 없이 영상만.
  bgm?: boolean; // 배경음악 넣기. 기본 true. false면 음악 없음.
  transitionFrames?: number;
  log?: (m: string) => void;
  isCancelled?: () => boolean; // ★사용자 중단 — 단계 경계마다 확인해서 멈춘다(하이라이트와 동일).
};

export async function makeVideo(
  urls: string[],
  keys: PipelineKeys,
  opts: PipelineOpts,
): Promise<{out: string; title: string; imageDir: string}> {
  const log = opts.log || (() => {});
  // ★중단 체크 — 각 단계 경계에서 호출. 사용자가 중단을 누르면 여기서 멈춘다(렌더 같은 통짜 단계는 끝난 뒤 경계에서).
  const ck = () => { if (opts.isCancelled?.()) throw new Error('사용자가 중단했습니다.'); };
  // ★화면비: 롱폼(≥90초)=가로 16:9 / 쇼츠=세로 9:16. UI "롱폼" optgroup(90/120/180)과 일치.
  const landscape = opts.duration >= 90;
  const orientation: 'portrait' | 'landscape' = landscape ? 'landscape' : 'portrait';
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});

  const source = await fetchSource(urls, log);
  ck();

  // ★카테고리 프리셋: 있으면 톤·이미지·목소리·BGM을 그 바닥 최적값으로 자동 세팅.
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  if (preset) log(`[카테고리] ${preset.emoji} ${preset.label} — 최적 세팅 자동 적용`);

  log('[대본] 생성 중…');
  const sb = await generateStoryboard(keys.gemini, source, {
    duration: opts.duration,
    purpose: opts.purpose,
    preset,
    imageStyle: opts.imageStyle,
    sceneCount: opts.sceneCount,
    openaiKey: keys.openai,
    log,
  });
  log(`[대본] "${sb.title}" · ${sb.scenes.length}장면`);
  ck();

  // 목소리: 사용자 지정 > (애니 스타일이면 애니 목소리) > 프리셋 추천 > adam
  const voiceKey = pickVoice(opts.voice, preset?.voice, opts.imageStyle);
  const voiceId = VOICES[voiceKey]?.id || VOICES[DEFAULT_VOICE].id;
  const scenes: SceneData[] = [];

  // ★나레이션 토글 — ON이면 통짜 음성 생성(억양 자연스럽게 이어짐, 장면별 구간 sceneRanges로 나눠 씀).
  //   OFF면 음성·단어자막 없이 영상만 만든다(장면 길이는 글자 수로 산정).
  const wantNarration = opts.narration !== false;
  let voiceRel: string | undefined;
  let align: Awaited<ReturnType<typeof ttsElevenJoined>>['align'] = null;
  let sceneRanges: [number, number][] = [];
  if (wantNarration) {
    log('[음성] 전체 나레이션 한 번에 생성(자연스러운 억양)…');
    voiceRel = `${pubRel}/voice.mp3`;
    const r = await ttsElevenJoined(keys.elevenlabs, sb.scenes.map((s) => s.narration), abs(voiceRel), voiceId);
    align = r.align;
    sceneRanges = r.sceneRanges;
  } else {
    log('[음성] 나레이션 끔 — 음성 없이 영상만 만듭니다.');
  }
  ck();

  // ★움직이는 AI 영상(Wan2.2) — 앞에서부터 aiClips개 장면을 RunPod에서 영상 클립으로 만든다.
  //   이미지는 항상 먼저 만들어 폴백/썸네일로 두고, 클립 성공 시 scene.video로 교체(Scene.tsx가 video 우선 렌더).
  const aiClips = Math.max(0, Math.min(sb.scenes.length, Math.floor(opts.aiClips || 0)));
  const style = getStyle(opts.imageStyle);
  let wanPod: string | undefined;
  if (aiClips > 0) {
    if (!keys.runpod) log('[영상] RunPod 키가 없어 움직이는 영상을 건너뜁니다(이미지로 진행).');
    else {
      try { wanPod = await ensureWanPod(keys.runpod, log); }
      catch (e: any) { log(`[영상] 움직이는 영상 준비 실패(${e.message}) → 이미지로 진행`); }
    }
  }

  for (let i = 0; i < sb.scenes.length; i++) {
    ck(); // 장면마다(이미지·영상 생성이 길어 중단 요청이 여기서 바로 반영됨)
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

    // 앞 N개 장면: 움직이는 영상 클립 생성(실패하면 조용히 이미지 유지).
    let videoRel: string | undefined;
    if (wanPod && i < aiClips) {
      videoRel = `${pubRel}/clip-${i}.mp4`;
      // visualPrompt(영어·매체중립) + 선택 스타일 + 모션 큐. 모션은 스타일 결에 맞게(실사=사실적,
      //   일러스트=부드러운 애니메이션, 고전=아날로그 필름) 다르게 줘야 애니·고전도 자연스럽게 움직인다.
      const motionCue = style.id === 'classic'
        ? 'gentle period-film motion, soft vintage camera pan, subtle flicker and film grain, smooth and fluid'
        : style.illustration
        ? 'smooth animated motion, gentle character movement, soft parallax camera, fluid 2D animation'
        : 'natural lifelike motion, subtle cinematic camera movement, smooth and fluid';
      const wanPrompt = `${vp}. ${style.promptAdd}. ${motionCue}`;
      try {
        log(`[장면 ${i + 1}] 🎬 움직이는 영상 생성…`);
        await wanT2V(wanPod, wanPrompt, abs(videoRel), {
          width: landscape ? 832 : 480, height: landscape ? 480 : 832, length: 81, interpolate: true, log,
        });
      } catch (e: any) {
        log(`[장면 ${i + 1}] ⚠️ 움직이는 영상 실패(${e.message}) → 이미지 사용`);
        videoRel = undefined;
      }
    }

    const [startSec, endSec] = sceneRanges[i] || [0, 0];
    // 나레이션 ON이면 음성 타이밍으로 단어자막·구간, OFF면 자막 없이 글자 수로 읽을 시간 산정.
    const words = wantNarration ? alignToWords(align, FPS, startSec, [startSec, endSec]) : [];
    const durSec = endSec > startSec ? endSec - startSec : Math.min(6, Math.max(2.2, s.narration.length / 7));
    // 마지막 장면만 꼬리 여유, 중간은 딱 붙여 통짜 오디오와 싱크
    const tail = i === sb.scenes.length - 1 ? 0.5 : 0.15;
    const durationInFrames = Math.max(FPS, Math.round((durSec + tail) * FPS));

    scenes.push({
      image: imgRel,
      video: videoRel,
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

  // ★움직이는 영상 클립을 다 뽑았으면 RunPod 팟을 종료한다(렌더는 Railway에서 하므로 팟은 더 필요 없음).
  //   autoShutdown=false면 팟을 켜둔다(다음 작업 빠르게 — 대신 시간당 과금 계속). 기본 종료(과금 방지).
  if (wanPod && opts.autoShutdown !== false) {
    try { await terminatePod(keys.runpod!, wanPod); log('[영상] RunPod 팟 종료(과금 중단).'); }
    catch (e: any) { log(`[영상] ⚠️ 팟 자동 종료 실패(${e.message}) — 설정에서 수동으로 꺼주세요.`); }
  } else if (wanPod) {
    log('[영상] RunPod 팟을 켜둡니다(자동 종료 OFF). 끝나면 설정에서 꺼주세요(과금 계속).');
  }

  // ★통짜 음성이라 장면 전환은 0(전환으로 겹치면 오디오 싱크가 깨진다). 컷 편집으로 딱딱.
  const transitionFrames = 0;
  const totalFrames = scenes.reduce((a, s) => a + s.durationInFrames, 0);
  const totalMs = (totalFrames / FPS) * 1000;
  // ★배경음악 토글 — ON이면 분위기 음악 생성, OFF면 음악 없이.
  let bgmSrc: string | undefined;
  if (opts.bgm !== false) {
    const bgmRel = `${pubRel}/bgm.mp3`;
    log('[BGM] 배경음악 생성 중…');
    const musicMood = sb.musicPrompt || preset?.musicMood || '';
    // BGM 실패 시 throw(사유 포함) → 제작 중단. 웹/CLI 동일 정책.
    await generateBgm(keys.elevenlabs, musicMood, totalMs, abs(bgmRel), log);
    bgmSrc = bgmRel;
  } else {
    log('[BGM] 배경음악 끔.');
  }

  ck(); // 렌더 직전 — 여기까지 안 멈췄으면 렌더는 끝까지 간다(통짜 단계).
  log('[렌더] 최종 합성…');
  const out = path.join(process.cwd(), 'out', `${id}.mp4`);
  await mkdir(path.join(process.cwd(), 'out'), {recursive: true});
  // ★전용 public 폴더로 렌더 — 캐시 번들은 번들 이후 생성한 이 작업의 이미지·음성·BGM을 404로 못 서빙한다
  //   (MediaError). 이 작업 자산만 담은 번들을 새로 만들어 넘긴다(카드·studio 경로와 동일).
  const renderPublic = await buildRenderPublic(pubRel);
  try {
    await renderVideo(scenes, transitionFrames, out, log, bgmSrc, voiceRel, renderPublic, orientation);
  } finally { await rm(renderPublic, {recursive: true, force: true}); }
  log(`[완료] ${out}`);
  return {out, title: sb.title, imageDir: abs(pubRel)};
}
