import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pipelineKeys} from './keys';
import {fetchSource} from './pipeline';
import {generateStoryboard} from './script';
import {generateManualDraft} from './manual';
import {generateImageFlux, generateImageNano, generateImageSmart} from './image';
import {ttsEleven, alignToWords, VOICES, pickVoice, DEFAULT_VOICE} from './tts';
import {generateBgm} from './music';
import {getPreset} from './presets';
import {getStyle} from './styles';
import {ensureWanPod, wanT2V, wanI2V, terminatePod} from './runpod-wan';
import {seedancePrompt} from './seedance';
import {seedanceReplicateI2V} from './replicate-video';
import {renderVideo, renderThumbnail} from './render';
import {resolveProduct, fingerprint} from './studio-model';
import type {StudioDependencies} from './studio';

export const studioProviders: StudioDependencies = {
  async plan(p, dir, log) {
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) throw new Error('키 설정에서 Gemini 또는 OpenAI 키를 저장하세요.');
    if (p.input.mode === 'manual') {
      const {plan} = await generateManualDraft(k, {
        imagePaths: p.sources.map(s => path.join(dir, s)), keywords: p.input.keywords,
        facts: p.input.facts, duration: p.input.duration, presetId: p.input.presetId, log,
      }, dir);
      return {...plan, subject: '', musicPrompt: plan.musicPrompt || '', scenes: plan.scenes.map(s => ({...s, visualPrompt: ''}))};
    }
    // 주제 추천 모드: 링크 없이 선택한 주제로 대본 창작
    const source = p.input.mode === 'topic'
      ? `아래 주제로 사람들이 끝까지 볼 만한 쇼츠 영상 대본을 창작하라. 사실에 기반하되 흥미롭게.\n주제: ${p.input.topic}`
      : await fetchSource([p.input.url], log);
    return generateStoryboard(k.gemini, source, {duration: p.input.duration, openaiKey: k.openai,
      preset: getPreset(p.input.presetId), imageStyle: p.input.imageStyle, sceneCount: p.input.sceneCount, log});
  },
  async image(p, s, file, log) {
    const k = pipelineKeys();
    if (!k.replicate) throw new Error('키 설정에서 Replicate 키를 저장하세요.');
    // ★화면비: 롱폼(≥90초)=가로 16:9 이미지 / 쇼츠=세로 9:16 (render·plan과 동일 기준).
    const landscape = p.input.duration >= 90;
    const prompt = `${p.subject}. ${s.visualPrompt}`;
    const dir = path.dirname(file);
    // 애니거나, 본인 얼굴/캐릭터 기준(characterRef)이 있으면 nano-banana로 '같은 얼굴' 유지.
    //   첫 장면을 기준으로 저장(얼굴 없을 때) → 이후 장면·다음 편이 참조. 실사 등은 그 스타일 promptAdd를 nano에 넘김.
    const useNano = p.input.imageStyle === 'anime' || !!p.characterRef;
    if (useNano) {
      const refs = p.characterRef ? [path.join(dir, p.characterRef)] : [];
      const styleAdd = p.input.imageStyle === 'anime' ? undefined : getStyle(p.input.imageStyle).promptAdd;
      await generateImageNano(k.replicate, prompt, file, log, refs, landscape, styleAdd);
      if (!p.characterRef) {
        const cref = 'character-ref.jpg';
        try { await fs.copyFile(file, path.join(dir, cref)); p.characterRef = cref; } catch {}
      }
    } else {
      await generateImageSmart({fal: k.fal, replicate: k.replicate}, prompt, file, log, p.input.quality, p.input.imageStyle, landscape);
    }
  },
  async voice(p, s, file) {
    const k = pipelineKeys();
    if (!k.elevenlabs) throw new Error('키 설정에서 ElevenLabs 키를 저장하세요.');
    const voice = pickVoice(p.input.voice, getPreset(p.input.presetId)?.voice, p.input.imageStyle);
    const text = resolveProduct(s.narration, p.input.product);
    const align = await ttsEleven(k.elevenlabs, text, file, (VOICES[voice] || VOICES[DEFAULT_VOICE]).id);
    if (!align?.length) throw new Error('음성 타이밍을 받지 못했습니다. 해당 장면을 다시 시도하세요.');
    return {words: alignToWords(align, 30), frames: Math.max(30, Math.ceil(align[align.length - 1].end * 30) + 6)};
  },
  // BGM ON으로 만든 영상은 음악이 핵심 — 실패하면 generateBgm이 사유를 담아 throw하고,
  // 그 에러가 작업을 'failed'로 만들어 화면에 사유를 보여준다(영상만 뱉지 않는다).
  async music(p, file, log) {
    const k = pipelineKeys();
    if (!k.elevenlabs) throw new Error('키 설정에서 ElevenLabs 키를 저장하세요.');
    const ms = p.scenes.reduce((n, s) => n + (s.voice?.frames || 0), 0) / 30 * 1000;
    await generateBgm(k.elevenlabs, p.musicPrompt, ms, file, log);
  },
  // ★영화 — 2번 라우팅: 인물 있는 장면(대사·hero)=Seedance(고급, fal), 풍경·사물 장면=런팟 Wan(크레딧 소진).
  //   이미지는 이미 만들어져 있으니(폴백·썸네일용) 클립 실패 시 그대로 사진영상으로 진행한다.
  async clips(p, dir, log) {
    const n = Math.max(0, Math.min(p.scenes.length, Math.floor(p.input.aiClips || 0)));
    // aiClips를 줄였으면, 더는 안 쓰는 장면의 클립을 떼어내 이미지로 되돌린다(장면.video 존재 = 현재 설정 반영).
    for (let i = n; i < p.scenes.length; i++) p.scenes[i].video = undefined;
    if (n === 0) return;
    const k = pipelineKeys();
    const landscape = p.input.duration >= 90;
    const aspect: '16:9' | '9:16' = landscape ? '16:9' : '9:16';
    const style = getStyle(p.input.imageStyle);
    const motionCue = style.id === 'classic'
      ? 'lively period-film motion, the character moves and gestures expressively, cinematic camera, subtle film grain'
      : style.illustration
      ? 'energetic animated motion, the character runs, jumps, gestures and talks expressively, dynamic 2D animation'
      : 'lively realistic motion, the person walks, gestures and talks with clear visible movement, dynamic cinematic camera';

    // ★영화 엔진 라우팅(테리 2026-10-11): 스튜디오(영상만들기)는 장면에 인물 정보가 없어 '풍경 취급' —
    //   RunPod Wan(충전 크레딧) 먼저 쓰고, 소진·실패 시 Replicate Seedance로 자동 전환. 런팟 없으면 바로 Replicate.
    //   fal은 영상에 안 씀(이미지 전용).
    type Plan = {i: number; engine: 'replicate' | 'wan' | 'none'};
    const plan: Plan[] = [];
    for (let i = 0; i < n; i++) {
      const engine: Plan['engine'] = k.runpod ? 'wan' : k.replicate ? 'replicate' : 'none';
      plan.push({i, engine});
    }
    const repCount = plan.filter((x) => x.engine === 'replicate').length;
    const wanCount = plan.filter((x) => x.engine === 'wan').length;
    if (plan.every((x) => x.engine === 'none')) {
      log('[영화] Replicate·RunPod 키가 모두 없어 영화(움직임)를 건너뜁니다(사진). 키 설정에서 저장하세요.');
      for (const s of p.scenes) s.video = undefined; return;
    }
    log(`[영화] 🔀 라우팅 — 🏞 런팟 크레딧 ${wanCount}개(소진 시 Replicate 자동) · 🎭 Replicate Seedance ${repCount}개`);

    // RunPod 팟은 풍경 장면이 있을 때만 준비.
    let pod: string | undefined;
    if (wanCount > 0) {
      try { pod = await ensureWanPod(k.runpod, log); }
      catch (e: any) { log(`[영상] ⚠️ 런팟 준비 실패(${e.message}) → 풍경 장면은 사진으로 진행`); }
    }
    let totalUsd = 0;
    const won = (usd: number) => Math.round(usd * 1400);
    try {
      for (const {i, engine} of plan) {
        const s = p.scenes[i];
        const vp = p.subject ? `${p.subject}. ${s.visualPrompt}. (main subject must be ${p.subject})` : s.visualPrompt;
        const sig = fingerprint([vp, p.input.imageStyle, landscape, engine]);
        const file = `clip-${i}-${sig}.mp4`;
        if (s.video?.signature === sig && existsSync(path.join(dir, file))) { log(`[장면 ${i + 1}] 🎬 기존 영화 재사용(과금 없음)`); continue; }
        const stillPath = s.image?.file ? path.join(dir, s.image.file) : '';
        const secs = s.voice?.frames ? Math.max(4, Math.min(10, Math.round(s.voice.frames / 30))) : 5;
        try {
          if (engine === 'replicate') {
            if (!stillPath || !existsSync(stillPath)) throw new Error('시작 이미지가 없음');
            log(`[장면 ${i + 1}/${n}] 🎭 Replicate Seedance 영화 생성(${aspect})…`);
            const motionPrompt = seedancePrompt({motion: motionCue});
            const {costUsd} = await seedanceReplicateI2V(k.replicate, motionPrompt, stillPath, path.join(dir, file), {resolution: '720p', aspectRatio: aspect, duration: secs, model: 'mini', log});
            totalUsd += costUsd;
            log(`[장면 ${i + 1}] ✅ 영화 완성 — 이번 컷 추정 ₩${won(costUsd)} (약 $${costUsd})`);
            s.video = {signature: sig, file};
          } else if (engine === 'wan') {
            const wanPrompt = `${vp}. ${style.promptAdd}. ${motionCue}`;
            const wanW = landscape ? 832 : 480, wanH = landscape ? 480 : 832;
            try {
              if (!pod) throw new Error('런팟 미준비');
              log(`[장면 ${i + 1}/${n}] 🏞 런팟 Wan 영화 생성(풍경·크레딧)…(수 분)`);
              await wanT2V(pod, wanPrompt, path.join(dir, file), {width: wanW, height: wanH, length: 81, interpolate: true, log});
              s.video = {signature: sig, file};
            } catch (wanErr: any) {
              if (k.replicate && stillPath && existsSync(stillPath)) { // 런팟 실패/크레딧 소진 → Replicate 자동 전환
                log(`[장면 ${i + 1}] 🏞 런팟 실패(${String(wanErr?.message || '').slice(0, 40)}) → Replicate로 자동 전환…`);
                const motionPrompt = seedancePrompt({motion: motionCue});
                const {costUsd} = await seedanceReplicateI2V(k.replicate, motionPrompt, stillPath, path.join(dir, file), {resolution: '720p', aspectRatio: aspect, duration: secs, model: 'mini', log});
                totalUsd += costUsd; s.video = {signature: sig, file};
                log(`[장면 ${i + 1}] ✅ 영화 완성(Replicate 폴백) — ₩${won(costUsd)}`);
              } else { throw wanErr; }
            }
          } else {
            log(`[장면 ${i + 1}] 영화 불가(엔진 키 없음) → 사진 사용`); s.video = undefined;
          }
        } catch (e: any) { log(`[장면 ${i + 1}] ⚠️ 영화 실패(${e.message}) → 사진 사용`); s.video = undefined; }
      }
      if (totalUsd > 0) log(`[영화] 💳 이번 작업 추정 비용 합계 ≈ ₩${won(totalUsd)} ($${totalUsd.toFixed(2)})`);
    } finally {
      // 클립을 다 뽑았으면 팟 종료(렌더는 Railway에서 하므로 팟 불필요). autoShutdown=false면 켜둔다(과금 계속).
      if (pod && p.input.autoShutdown !== false) {
        try { await terminatePod(k.runpod, pod); log('[영상] RunPod 팟 종료(과금 중단).'); }
        catch (e: any) {
          log(`[영상] ⚠️ 팟 종료 실패(${(e?.message || '').slice(0, 60)}) — 5초 후 재시도…`);
          await new Promise((r) => setTimeout(r, 5000));
          try { await terminatePod(k.runpod, pod); log('[영상] RunPod 팟 종료(재시도 성공, 과금 중단).'); }
          catch (e2: any) { log(`[영상] ⚠️ 팟 자동 종료 최종 실패 — 상단 GPU 배지를 눌러 꼭 꺼주세요.`); }
        }
      } else if (pod) log('[영상] RunPod 팟을 켜둡니다(자동 종료 OFF). 끝나면 설정에서 꺼주세요(과금 계속).');
    }
  },
  async render(p, dir, output, log, thumbOut) {
    // Fresh public folder per render: cached bundles must never serve an older scene.
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onvideo-render-'));
    try {
      for (const folder of ['fonts', 'sfx']) await fs.cp(path.join(process.cwd(), 'public', folder), path.join(publicDir, folder), {recursive: true});
      const prefix = `studio/${p.id}`;
      const mediaDir = path.join(publicDir, prefix);
      await fs.mkdir(mediaDir, {recursive: true});
      const names = new Set(p.scenes.flatMap(s => [s.image!.file, s.voice!.file, ...(s.video ? [s.video.file] : [])]));
      if (p.bgm) names.add(p.bgm.file);
      for (const name of names) await fs.copyFile(path.join(dir, name), path.join(mediaDir, name));
      const scenes = p.scenes.map((s, i) => ({
        image: `${prefix}/${s.image!.file}`, voiceSrc: `${prefix}/${s.voice!.file}`,
        video: s.video ? `${prefix}/${s.video.file}` : undefined, // 영화 클립(있으면 Scene.tsx가 이미지 대신 렌더)
        hookTop: resolveProduct(s.hookTop, p.input.product), hookAccent: resolveProduct(s.hookAccent, p.input.product),
        accentColor: s.accentColor, words: s.voice!.words || [], durationInFrames: s.voice!.frames!,
        font: p.input.font, // 사용자가 고른 제목 폰트(없으면 Scene에서 기본 Black Han Sans)
        motion: i, punch: i === 0, product: p.input.product || undefined,
      }));
      // ★화면비: 롱폼(≥90초)=가로 16:9 / 쇼츠=세로 9:16 (자동·수동 모드와 동일 기준).
      const orientation: 'portrait' | 'landscape' = p.input.duration >= 90 ? 'landscape' : 'portrait';
      await renderVideo(scenes, 0, output, log, p.bgm ? `${prefix}/${p.bgm.file}` : undefined, undefined, publicDir, orientation);
      // 전용 썸네일(커버) — 첫 장면 이미지 + 후킹 문구로 독립 디자인. 실패해도 영상엔 영향 없음.
      if (thumbOut && scenes[0]) {
        const s0 = scenes[0];
        // 대본이 만든 전용 썸네일 문구(thumb) 우선, 없으면 후킹에서 추출.
        const t = (p as any).thumbText || {};
        const big = String(t.big || s0.hookAccent || s0.hookTop || p.title || '').slice(0, 20);
        const small = String(t.small ?? (s0.hookAccent ? s0.hookTop : '')).slice(0, 20);
        const badge = String(t.badge || badgeFor(p.input.presetId)).slice(0, 6);
        try { await renderThumbnail({image: s0.image, big, small, badge, accentColor: s0.accentColor || '#FFE24B'}, thumbOut, log, publicDir, orientation); }
        catch (e: any) { log('[썸네일] 생성 건너뜀: ' + (e?.message || '').slice(0, 100)); }
      }
    } finally { await fs.rm(publicDir, {recursive: true, force: true}); }
  },
};

// 카테고리 성격별 썸네일 충격 뱃지(대본이 전용 문구를 안 줄 때 폴백).
function badgeFor(presetId: string): string {
  const p = getPreset(presetId);
  const grp = p?.group || '';
  if (grp.includes('판매')) return '초특가';
  if (grp.includes('애니')) return '';
  if (presetId.includes('mystery') || presetId.includes('fact')) return '실화?';
  if (presetId.includes('health') || presetId.includes('money')) return '충격';
  return '실화?';
}
