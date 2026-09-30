// 이미지 생성 — Flux(Replicate). ★9:16 네이티브(aspect_ratio) → 짤림 없음. no-text 강화.
import {writeFile} from 'node:fs/promises';

export type ImageStyle = 'real' | 'anime';

// 실사: 현실성 강화 + 사람 절제(얼굴/군중 지양, 사물·장소·현장 중심).
const REAL_STYLE =
  ', ultra-realistic photograph, shot on DSLR, sharp focus, high detail, 8k, professional photography, authentic real-world scene, natural available light, photojournalism, 35mm, realistic skin and textures, natural depth of field, subtle cinematic color grade, indistinguishable from a real photo, no illustration, no CGI, no 3D render, no AI look';
const REAL_NO_PEOPLE =
  ', avoid people, no crowds, no close-up faces, no portraits — focus on objects, places, environments and meaningful details; if a person is unavoidable show only hands, silhouette or back view, small in frame';
// 애니: 귀여운 일러스트/웹툰 톤(파스텔·부드러운 셀셰이딩). 캐릭터/마스코트 허용.
const ANIME_STYLE =
  ', charming 2D anime illustration, soft cel shading, clean crisp linework, vibrant pastel color palette, modern Korean webtoon and Studio Ghibli inspired, wholesome and cute, expressive, warm soft lighting, high quality digital art, no photorealism, no 3D render';
const ANIME_PEOPLE =
  ', cute characters and mascots are welcome, appealing and friendly';
const NEG_TEXT =
  ', absolutely no text, no letters, no words, no numbers, no captions, no charts, no tables, no documents, no price tags, no signage, no watermark';

export async function generateImageFlux(
  key: string,
  prompt: string,
  outPath: string,
  log?: (m: string) => void,
  quality: 'fast' | 'high' = 'high',
  style: ImageStyle = 'real',
  landscape = false,
): Promise<void> {
  // 일시적 네트워크 오류(fetch failed 등)에 최대 3회 재시도 — placeholder로 새는 것 방지.
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fluxOnce(key, prompt, outPath, log, quality, style, landscape);
    } catch (e: any) {
      lastErr = e;
      log?.(`[이미지] 생성 실패(${e.message}) — 재시도 ${attempt}/3`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function fluxOnce(
  key: string,
  prompt: string,
  outPath: string,
  log?: (m: string) => void,
  quality: 'fast' | 'high' = 'high',
  style: ImageStyle = 'real',
  landscape = false,
): Promise<void> {
  const high = quality !== 'fast';
  const model = high ? 'flux-dev' : 'flux-schnell';
  const styleStr = style === 'anime' ? ANIME_STYLE + ANIME_PEOPLE : REAL_STYLE + REAL_NO_PEOPLE;
  const input: Record<string, unknown> = {
    prompt: prompt + styleStr + NEG_TEXT,
    aspect_ratio: landscape ? '16:9' : '9:16', // ★롱폼=가로 16:9 / 쇼츠=세로 9:16 네이티브
    num_outputs: 1,
    output_format: 'jpg',
    output_quality: high ? 95 : 90,
  };
  if (high) {
    // flux-dev 품질 파라미터(실사=guidance 낮게 밸런스, 애니=조금 높여 스타일 강조)
    input.guidance = style === 'anime' ? 3.5 : 3;
    input.num_inference_steps = 32; // 스텝↑=디테일↑
  }
  const body = {input};
  // ★high=flux-dev(실사 고퀄, 35원) / fast=flux-schnell(4원, 테스트용)
  // Prefer: wait → 동기적으로 결과까지 대기. 안 되면 polling 폴백.
  const r = await fetch(
    `https://api.replicate.com/v1/models/black-forest-labs/${model}/predictions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify(body),
    },
  );
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Flux 실패(${r.status}): ${d?.detail || ''}`);

  let url: string | undefined = Array.isArray(d.output) ? d.output[0] : d.output;
  // Prefer:wait가 안 통했으면 상태 polling
  if (!url && d?.urls?.get) {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const p = await fetch(d.urls.get, {
        headers: {Authorization: 'Bearer ' + key},
      });
      const pd: any = await p.json();
      if (pd.status === 'succeeded') {
        url = Array.isArray(pd.output) ? pd.output[0] : pd.output;
        break;
      }
      if (pd.status === 'failed' || pd.status === 'canceled')
        throw new Error('Flux 생성 실패: ' + (pd.error || pd.status));
    }
  }
  if (!url) throw new Error('Flux 결과 URL 없음');

  const img = await fetch(url);
  if (!img.ok) throw new Error('Flux 이미지 다운로드 실패');
  await writeFile(outPath, Buffer.from(await img.arrayBuffer()));
  log?.(`[이미지] Flux ${landscape ? '16:9' : '9:16'} 생성 완료`);
}
