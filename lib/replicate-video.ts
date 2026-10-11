// Replicate Seedance 2.0 i2v — 영화(영화) 엔진.
// fal보다 저렴(원청 매칭 요율)하고, RunPod/fal 크레딧 소진 시 최종 폴백 엔진이기도 하다.
// 모델: bytedance/seedance-2.0-mini(저가·대량, 480/720p) / bytedance/seedance-2.0(고품질, ~1080p).
// ★input 스키마는 Replicate 공식에서 실측 확인(2026-10-11): image·prompt·duration·resolution·aspect_ratio·
//   generate_audio·reference_images. generate_audio=false(우리 TTS/자막을 얹음).
// ★캐릭터 일관성(테리 최우선): reference_images에 '기준 얼굴' 스틸을 넣으면 컷마다 같은 인물 유지.
import {readFile, writeFile} from 'node:fs/promises';
import fs from 'node:fs';

const REP = 'https://api.replicate.com/v1';

export type RepSeedanceOpts = {
  resolution?: '480p' | '720p' | '1080p';
  duration?: number; // 초(4~15). 기본 5.
  aspectRatio?: '9:16' | '16:9' | '1:1';
  model?: 'mini' | 'standard'; // 기본 mini(저가·대량). standard=고품질(1080p).
  refImagePaths?: string[]; // 캐릭터 일관성 참조 이미지(기준 얼굴 스틸)
  seed?: number;
  log?: (m: string) => void;
};

// Replicate i2v 공개 요율(USD/초, 로그의 '추정 비용'용 — 실제 청구와 맞춰 조정).
//   mini 720p ≈ $0.076/s, standard 720p ≈ $0.15/s (2026-10-11 조사).
const REP_USD_PER_SEC: Record<'mini' | 'standard', number> = {mini: 0.076, standard: 0.15};

// data URI로 변환(Replicate는 image 필드에 data URI 허용). 존재하는 파일만.
async function toDataUri(p: string): Promise<string | null> {
  try { if (!fs.existsSync(p)) return null; return 'data:image/jpeg;base64,' + (await readFile(p)).toString('base64'); }
  catch { return null; }
}

// 한 컷 생성: 시작 이미지 + 프롬프트 → outPath(mp4). 반환: 실제 길이(초)·추정 비용(USD).
export async function seedanceReplicateI2V(
  key: string,
  prompt: string,
  startImagePath: string,
  outPath: string,
  opts: RepSeedanceOpts = {},
): Promise<{seconds: number; costUsd: number}> {
  const log = opts.log || (() => {});
  if (!key) throw new Error('Replicate 키가 없습니다. 키 설정에서 저장하세요.');
  const tier: 'mini' | 'standard' = opts.model === 'standard' ? 'standard' : 'mini';
  const model = tier === 'standard' ? 'bytedance/seedance-2.0' : 'bytedance/seedance-2.0-mini';
  const dur = opts.duration ? Math.max(4, Math.min(15, Math.round(opts.duration))) : 5;

  const imageData = await toDataUri(startImagePath);
  if (!imageData) throw new Error('Seedance 시작 이미지를 읽지 못했습니다: ' + startImagePath);

  const input: Record<string, unknown> = {
    image: imageData,
    prompt,
    duration: dur,
    resolution: opts.resolution || '720p',
    aspect_ratio: opts.aspectRatio || '9:16',
    generate_audio: false, // 우리 TTS·자막을 얹으므로 네이티브 오디오 끔
  };
  if (opts.seed != null) input.seed = opts.seed;
  if (opts.refImagePaths?.length) {
    const refs: string[] = [];
    for (const rp of opts.refImagePaths) { const u = await toDataUri(rp); if (u) refs.push(u); }
    if (refs.length) input.reference_images = refs; // 캐릭터 일관성
  }

  log(`[영화] Replicate Seedance(${tier === 'standard' ? '고품질' : 'Mini·저가'}) 생성 시작 — 보통 1~3분`);
  const sub = await fetch(`${REP}/models/${model}/predictions`, {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    body: JSON.stringify({input}),
    signal: AbortSignal.timeout(30000),
  });
  const sd: any = await sub.json().catch(() => ({}));
  if (!sub.ok) throw new Error(`Replicate Seedance 제출 실패(${sub.status}): ${sd?.detail || sd?.title || ''}`);

  // Replicate predictions: output이 바로 오거나, urls.get 폴링(영상은 보통 폴링).
  let url: string | undefined = Array.isArray(sd.output) ? sd.output[0] : sd.output;
  const getUrl: string | undefined = sd?.urls?.get;
  if (!url && getUrl) {
    const started = Date.now();
    while (Date.now() - started < 8 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await fetch(getUrl, {headers: {Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(20000)});
      const pd: any = await p.json().catch(() => ({}));
      if (pd.status === 'succeeded') { url = Array.isArray(pd.output) ? pd.output[0] : pd.output; break; }
      if (pd.status === 'failed' || pd.status === 'canceled') throw new Error('Replicate Seedance 생성 실패: ' + (pd.error || pd.status));
    }
  }
  if (!url) throw new Error('Replicate Seedance 결과 URL 없음(시간 초과)');

  const vid = await fetch(url, {signal: AbortSignal.timeout(180000)});
  if (!vid.ok) throw new Error(`Replicate Seedance 영상 다운로드 실패(${vid.status})`);
  await writeFile(outPath, Buffer.from(await vid.arrayBuffer()));

  const seconds = dur;
  const costUsd = Number((seconds * REP_USD_PER_SEC[tier]).toFixed(3));
  log(`[영화] Replicate Seedance 완성(약 ${seconds}초)`);
  return {seconds, costUsd};
}
