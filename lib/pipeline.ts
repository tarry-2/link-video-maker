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
  font?: string; // 제목·후킹 폰트(사용자 선택). 없으면 기본 Black Han Sans. Scene.tsx TITLE_FONTS와 동일 목록.
  transitionFrames?: number;
  // ★재창작(리메이크): URL을 긁지 않고 '이미 확보한 내용 텍스트'를 소스로 바로 쓴다. 인기 영상(서프라이즈 등)의
  //   제목·자막을 뽑아 이걸로 넘기면 generateStoryboard가 우리 대본·이미지·목소리로 새 영상을 만든다(저작권 free).
  sourceText?: string;
  // ★화면 방향 강제 — 지정하면 길이와 무관하게 이 방향으로(재창작은 길이·방향을 따로 고르므로 필수). 없으면 길이로 자동.
  orientation?: 'portrait' | 'landscape';
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
  // ★화면비: orientation이 명시되면 그대로(재창작은 길이·방향을 따로 고름 — 세로 120초도 가능). 없으면 길이로
  //   자동(영상 만들기 UI는 쇼츠=세로/롱폼=가로로 길이가 묶여 있어 무회귀). 예전엔 길이만 봐서 세로+120초가 가로로 나갔다(테리 지적).
  const orientation: 'portrait' | 'landscape' = opts.orientation || (opts.duration >= 90 ? 'landscape' : 'portrait');
  const landscape = orientation === 'landscape';
  const id = randomUUID().slice(0, 8);
  const pubRel = `jobs/${id}`;
  const abs = (rel: string) => path.join(process.cwd(), 'public', rel);
  await mkdir(abs(pubRel), {recursive: true});

  // 재창작이면 넘어온 내용 텍스트를 소스로, 아니면 기존대로 URL을 긁는다(무회귀).
  const source = opts.sourceText && opts.sourceText.trim().length > 20
    ? opts.sourceText.trim().slice(0, 40000)
    : await fetchSource(urls, log);
  ck();

  // ★카테고리 프리셋: 있으면 톤·이미지·목소리·BGM을 그 바닥 최적값으로 자동 세팅.
  const preset = opts.presetId ? getPreset(opts.presetId) : undefined;
  if (preset) log(`[카테고리] ${preset.emoji} ${preset.label} — 최적 세팅 자동 적용`);

  log('[대본] 생성 중…');
  const sb = await generateStoryboard(keys.gemini, source, {
    duration: opts.duration,
    orientation, // ★이미지 비율도 고른 방향에 맞춘다(세로 120초면 세로 이미지로)
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
  // ★GPU는 '움직이는 영상(aiClips>0)'일 때만 켠다. 이미지영상(aiClips=0)이면 여기 자체를 안 타므로 절대 안 켜진다.
  if (aiClips > 0) {
    if (!keys.runpod) log('[영상] RunPod 키가 없어 움직이는 영상을 건너뜁니다(이미지로 진행).');
    else {
      try { wanPod = await ensureWanPod(keys.runpod, log); }
      catch (e: any) { log(`[영상] 움직이는 영상 준비 실패(${e.message}) → 이미지로 진행`); }
    }
  }

  // ★팟을 켰으면 '무슨 일이 있어도'(중단·에러 포함) 반드시 끈다 — try/finally로 감싼다. 예전엔 루프 중간에 에러·중단이
  //   나면 아래 종료 코드를 건너뛰고 함수가 빠져나가 팟이 계속 켜진 채 과금됐다(테리 지적: 자동종료 가끔 실패).
  try {
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
    const isLastScene = i === sb.scenes.length - 1;
    let durationInFrames: number;
    if (wantNarration && endSec > startSec) {
      // ★통짜 나레이션과 '절대 프레임 좌표'로 싱크: 장면 길이 = 이 장면 오디오 구간(endFrame-startFrame).
      //   중간 장면에 꼬리(tail)를 더하면 그 시간이 '누적'돼 뒤 장면일수록 오디오보다 점점 늦어지고,
      //   끝에서 나레이션만 먼저 끝나고 자막이 계속 흘러가는 싱크 버그가 난다(테리 실측 2026-10-09). → 중간 tail 0.
      //   마지막 장면만 0.5초 여운(오디오가 이미 끝난 뒤라 드리프트 없음). 장면들이 오디오 경계에 정확히 붙는다(telescoping).
      const startFrame = Math.round(startSec * FPS);
      const endFrame = Math.round(endSec * FPS) + (isLastScene ? Math.round(0.5 * FPS) : 0);
      durationInFrames = Math.max(FPS, endFrame - startFrame);
    } else {
      // 나레이션 OFF(자막 없음): 글자 수로 읽을 시간 + 약간의 여유(싱크 대상 오디오 없음).
      const durSec = Math.min(6, Math.max(2.2, s.narration.length / 7));
      durationInFrames = Math.max(FPS, Math.round((durSec + (isLastScene ? 0.5 : 0.15)) * FPS));
    }

    scenes.push({
      image: imgRel,
      video: videoRel,
      hookTop: s.hookTop,
      hookAccent: s.hookAccent,
      accentColor: s.accentColor || '#FFE24B',
      font: opts.font, // 사용자가 고른 제목 폰트(없으면 Scene에서 기본값)
      words,
      durationInFrames,
      audioStartSec: startSec, // 통짜 오디오에서 이 장면 시작점
      punch: i === 0,
      motion: i,
      comment: s.comment,
    });
  }

  } finally {
    // ★움직이는 영상 클립을 다 뽑았거나(정상) 중간에 에러/중단이 났어도 RunPod 팟을 반드시 종료한다(렌더는
    //   Railway에서 하므로 팟 불필요). autoShutdown=false면 켜둔다(다음 작업 빠르게 — 대신 과금 계속). 종료 실패 시
    //   한 번 더 재시도(과금 방지 최우선).
    if (wanPod && opts.autoShutdown !== false) {
      try { await terminatePod(keys.runpod!, wanPod); log('[영상] RunPod 팟 종료(과금 중단).'); }
      catch (e: any) {
        log(`[영상] ⚠️ 팟 종료 실패(${(e?.message || '').slice(0, 60)}) — 5초 후 재시도…`);
        await new Promise((r) => setTimeout(r, 5000));
        try { await terminatePod(keys.runpod!, wanPod); log('[영상] RunPod 팟 종료(재시도 성공, 과금 중단).'); }
        catch (e2: any) { log(`[영상] ⚠️ 팟 자동 종료 최종 실패(${(e2?.message || '').slice(0, 60)}) — 상단 GPU 배지를 눌러 꼭 꺼주세요.`); }
      }
    } else if (wanPod) {
      log('[영상] RunPod 팟을 켜둡니다(자동 종료 OFF). 끝나면 설정에서 꺼주세요(과금 계속).');
    }
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
