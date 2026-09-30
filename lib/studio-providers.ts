import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pipelineKeys} from './keys';
import {fetchSource} from './pipeline';
import {generateStoryboard} from './script';
import {generateManualDraft} from './manual';
import {generateImageFlux} from './image';
import {ttsEleven, alignToWords, VOICES} from './tts';
import {generateBgm} from './music';
import {getPreset} from './presets';
import {renderVideo} from './render';
import {resolveProduct} from './studio-model';
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
    const source = await fetchSource([p.input.url], log);
    return generateStoryboard(k.gemini, source, {duration: p.input.duration, openaiKey: k.openai,
      preset: getPreset(p.input.presetId), log});
  },
  async image(p, s, file, log) {
    const k = pipelineKeys();
    if (!k.replicate) throw new Error('키 설정에서 Replicate 키를 저장하세요.');
    await generateImageFlux(k.replicate, `${p.subject}. ${s.visualPrompt}`, file, log, p.input.quality, p.input.imageStyle);
  },
  async voice(p, s, file) {
    const k = pipelineKeys();
    if (!k.elevenlabs) throw new Error('키 설정에서 ElevenLabs 키를 저장하세요.');
    const voice = p.input.voice || getPreset(p.input.presetId)?.voice || 'adam';
    const text = resolveProduct(s.narration, p.input.product);
    const align = await ttsEleven(k.elevenlabs, text, file, (VOICES[voice] || VOICES.adam).id);
    if (!align?.length) throw new Error('음성 타이밍을 받지 못했습니다. 해당 장면을 다시 시도하세요.');
    return {words: alignToWords(align, 30), frames: Math.max(30, Math.ceil(align[align.length - 1].end * 30) + 6)};
  },
  async music(p, file, log) {
    const k = pipelineKeys();
    const ms = p.scenes.reduce((n, s) => n + (s.voice?.frames || 0), 0) / 30 * 1000;
    if (!k.elevenlabs || !await generateBgm(k.elevenlabs, p.musicPrompt, ms, file, log))
      throw new Error('배경음악 생성에 실패했습니다. 이어서 재시작하면 이미지·음성을 재사용합니다.');
  },
  async render(p, dir, output, log) {
    // Fresh public folder per render: cached bundles must never serve an older scene.
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onvideo-render-'));
    try {
      for (const folder of ['fonts', 'sfx']) await fs.cp(path.join(process.cwd(), 'public', folder), path.join(publicDir, folder), {recursive: true});
      const prefix = `studio/${p.id}`;
      const mediaDir = path.join(publicDir, prefix);
      await fs.mkdir(mediaDir, {recursive: true});
      const names = new Set(p.scenes.flatMap(s => [s.image!.file, s.voice!.file]));
      if (p.bgm) names.add(p.bgm.file);
      for (const name of names) await fs.copyFile(path.join(dir, name), path.join(mediaDir, name));
      const scenes = p.scenes.map((s, i) => ({
        image: `${prefix}/${s.image!.file}`, voiceSrc: `${prefix}/${s.voice!.file}`,
        hookTop: resolveProduct(s.hookTop, p.input.product), hookAccent: resolveProduct(s.hookAccent, p.input.product),
        accentColor: s.accentColor, words: s.voice!.words || [], durationInFrames: s.voice!.frames!,
        motion: i, punch: i === 0, product: p.input.product || undefined,
      }));
      await renderVideo(scenes, 0, output, log, p.bgm ? `${prefix}/${p.bgm.file}` : undefined, undefined, publicDir);
    } finally { await fs.rm(publicDir, {recursive: true, force: true}); }
  },
};
