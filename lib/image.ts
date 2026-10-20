// 이미지 생성 — Flux(Replicate). ★9:16 네이티브(aspect_ratio) → 짤림 없음. no-text 강화.
// 애니 시리즈는 nano-banana(google, Replicate)로 캐릭터 참조 생성 → 장면·편이 바뀌어도 같은 주인공.
import {writeFile, readFile} from 'node:fs/promises';
import fs from 'node:fs';
import {getStyle, type ImageStyle} from './styles';
export type {ImageStyle} from './styles'; // 스타일 id(레지스트리) — 과거 'real'|'anime' 호환.

const NEG_TEXT =
  ', absolutely no text, no letters, no words, no numbers, no captions, no charts, no tables, no documents, no price tags, no signage, no watermark';

// ★음식·상품 의인화 금지(테리: 픽사풍 쇼핑쇼츠에서 '구운 장어'에 살아있는 얼굴이 붙음).
//   일러스트/3D 스타일(픽사 등)이 음식·재료·상품에도 눈·얼굴을 붙이는 걸 막는다. 캐릭터·사람·동물'캐릭터'엔 영향 없음
//   (여기선 '음식/재료/상품'만 콕 집어 금지). 조리된 음식은 진짜 조리된 음식으로 보이게.
const NEG_FOOD =
  ', food, dishes, cooked meat, grilled fish or eel, ingredients and grocery products are shown as realistic appetizing real food and plain inanimate objects only — never give any food, ingredient or product a face, eyes, mouth or facial expression, no anthropomorphized food, no googly eyes on food, cooked or grilled food looks properly cooked and real, not alive';

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
  const st = getStyle(style); // 레지스트리에서 스타일 레시피(프롬프트·사람정책·guidance)
  const styleStr = st.promptAdd + st.peopleAdd;
  const input: Record<string, unknown> = {
    prompt: prompt + styleStr + NEG_TEXT + NEG_FOOD,
    aspect_ratio: landscape ? '16:9' : '9:16', // ★롱폼=가로 16:9 / 쇼츠=세로 9:16 네이티브
    num_outputs: 1,
    output_format: 'jpg',
    output_quality: high ? 95 : 90,
  };
  if (high) {
    // flux-dev 품질 파라미터(실사=guidance 낮게 밸런스, 일러스트=조금 높여 스타일 강조) — 스타일별 지정.
    input.guidance = st.guidance;
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

// ── fal flux 이미지 생성 (충전액 소진용 — 이미지는 fal을 먼저 쓰고, 소진되면 Replicate로 폴백) ──
// fal queue API(seedance.ts와 동일 패턴): POST → status_url 폴링 → response_url. 모델 id = fal-ai/flux/{dev|schnell}.
// image_size: portrait_16_9=세로 9:16 / landscape_16_9=가로 16:9 (fal 공식 프리셋). 결과는 images[0].url.
const FAL_QUEUE = 'https://queue.fal.run';

// ★크레딧 소진/권한 등 '재시도해도 안 되는' fal 에러인지 — 이러면 즉시 Replicate로 폴백(돈 한 푼도 안 버림).
export function isFalExhausted(msg: string): boolean {
  return /402|403|balance|exhaust|insufficient|credit|quota|payment|forbidden/i.test(msg || '');
}

export async function generateImageFal(
  key: string,
  prompt: string,
  outPath: string,
  log?: (m: string) => void,
  quality: 'fast' | 'high' = 'high',
  style: ImageStyle = 'real',
  landscape = false,
): Promise<void> {
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await falFluxOnce(key, prompt, outPath, log, quality, style, landscape); }
    catch (e: any) {
      const m = String(e?.message || '');
      if (isFalExhausted(m)) throw e; // 크레딧 소진류는 재시도 무의미 → 던져서 Replicate 폴백
      lastErr = e;
      log?.(`[이미지] fal 생성 실패(${m}) — 재시도 ${attempt}/3`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function falFluxOnce(
  key: string,
  prompt: string,
  outPath: string,
  log: ((m: string) => void) | undefined,
  quality: 'fast' | 'high',
  style: ImageStyle,
  landscape: boolean,
): Promise<void> {
  const st = getStyle(style);
  const styleStr = st.promptAdd + st.peopleAdd;
  const model = quality === 'fast' ? 'fal-ai/flux/schnell' : 'fal-ai/flux/dev';
  const input: Record<string, unknown> = {
    prompt: prompt + styleStr + NEG_TEXT + NEG_FOOD,
    image_size: landscape ? 'landscape_16_9' : 'portrait_16_9', // 세로 쇼츠=portrait_16_9(9:16)
    num_images: 1,
    output_format: 'jpeg',
  };
  if (quality !== 'fast') { input.num_inference_steps = 32; input.guidance_scale = st.guidance; }

  // 제출 → request_id·status_url·response_url(네임스페이스 모델은 응답이 주는 URL을 그대로 써야 함, seedance.ts 교훈)
  const sub = await fetch(`${FAL_QUEUE}/${model}`, {
    method: 'POST',
    headers: {Authorization: `Key ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  const subTxt = await sub.text();
  if (!sub.ok) throw new Error(`fal flux 실패(${sub.status}): ${subTxt.slice(0, 150)}`);
  const sd: any = JSON.parse(subTxt);
  const reqId = sd.request_id || sd.requestId;
  const statusUrl = sd.status_url || `${FAL_QUEUE}/${model}/requests/${reqId}/status`;
  const responseUrl = sd.response_url || `${FAL_QUEUE}/${model}/requests/${reqId}`;

  // 폴링(이미지는 보통 수 초, 최대 2분)
  const started = Date.now();
  let status = '';
  while (Date.now() - started < 120000) {
    await new Promise((r) => setTimeout(r, 1500));
    const stp = await fetch(statusUrl, {headers: {Authorization: `Key ${key}`}, signal: AbortSignal.timeout(20000)});
    const spd: any = await stp.json().catch(() => ({}));
    status = spd.status || '';
    if (status === 'COMPLETED') break;
    if (status === 'FAILED' || status === 'ERROR') throw new Error('fal flux 생성 실패(FAILED)');
  }
  if (status !== 'COMPLETED') throw new Error('fal flux 생성 시간 초과');

  const res = await fetch(responseUrl, {headers: {Authorization: `Key ${key}`}, signal: AbortSignal.timeout(30000)});
  const rd: any = await res.json();
  const url: string | undefined = rd?.images?.[0]?.url || rd?.image?.url;
  if (!url) throw new Error('fal flux 결과 URL 없음');
  const img = await fetch(url, {signal: AbortSignal.timeout(60000)});
  if (!img.ok) throw new Error('fal flux 이미지 다운로드 실패');
  await writeFile(outPath, Buffer.from(await img.arrayBuffer()));
  log?.(`[이미지] fal flux ${landscape ? '16:9' : '9:16'} 생성 완료`);
}

// ── 통합 이미지 생성(폴백) — 모든 진입점이 이걸 쓴다(반쪽 패치 방지). ──
// fal 키 있으면 fal(충전액) 먼저 → 실패/크레딧 소진이면 Replicate flux로 자동 전환(돈 안 버림).
// fal 키 없으면 바로 Replicate. 캐릭터 일관성(nano-banana)은 fal 동등 모델이 없어 별도(Replicate 유지).
export async function generateImageSmart(
  keys: {fal?: string; replicate: string},
  prompt: string,
  outPath: string,
  log?: (m: string) => void,
  quality: 'fast' | 'high' = 'high',
  style: ImageStyle = 'real',
  landscape = false,
): Promise<void> {
  if (keys.fal) {
    try {
      await generateImageFal(keys.fal, prompt, outPath, log, quality, style, landscape);
      return;
    } catch (e: any) {
      const m = String(e?.message || '');
      log?.(`[이미지] fal → Replicate 폴백(${isFalExhausted(m) ? '크레딧 소진' : '실패'}): ${m.slice(0, 60)}`);
    }
  }
  await generateImageFlux(keys.replicate, prompt, outPath, log, quality, style, landscape);
}

// ── nano-banana(google, Replicate): 애니 캐릭터 일관성 생성 ──
// refPaths(기준 캐릭터 이미지들)를 참조로 넣으면 같은 캐릭터를 다른 장면/포즈로 그려준다.
// 참조가 없으면(첫 캐릭터) 텍스트만으로 생성 → 그 결과가 이후 장면들의 기준이 된다.
const NANO_STYLE =
  ', charming 2D anime illustration for a wholesome kids story, soft cel shading, clean linework, vibrant pastel colors, Studio Ghibli and modern Korean webtoon inspired, cute and expressive, warm soft lighting, high quality';

export async function generateImageNano(
  key: string,
  prompt: string,
  outPath: string,
  log?: (m: string) => void,
  refPaths: string[] = [],
  landscape = false,
  styleAdd?: string, // ★비우면 애니 기본(NANO_STYLE). 실사·시네마 등 서사형 캐릭터 일관성용으로 그 스타일의 promptAdd를 넘긴다.
): Promise<void> {
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await nanoOnce(key, prompt, outPath, log, refPaths, landscape, styleAdd); }
    catch (e: any) {
      lastErr = e;
      log?.(`[이미지] 애니 생성 실패(${e.message}) — 재시도 ${attempt}/3`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function nanoOnce(
  key: string,
  prompt: string,
  outPath: string,
  log: ((m: string) => void) | undefined,
  refPaths: string[],
  landscape: boolean,
  styleAdd?: string,
): Promise<void> {
  // 참조 캐릭터를 강조하는 지시(동일 인물 유지). 참조 유무로 프롬프트가 달라진다.
  const keepLine = refPaths.length
    ? 'Keep the EXACT same character(s) from the reference image — identical face, hairstyle, outfit and colors. Only change the pose, action and background as described. '
    : '';
  const input: Record<string, unknown> = {
    prompt: keepLine + prompt + (styleAdd || NANO_STYLE) + NEG_TEXT + NEG_FOOD,
    aspect_ratio: landscape ? '16:9' : '9:16',
    output_format: 'jpg',
  };
  // 로컬 참조 파일 → data URI(Replicate 지원). 존재하는 것만.
  const refs: string[] = [];
  for (const rp of refPaths) {
    try { if (fs.existsSync(rp)) refs.push('data:image/jpeg;base64,' + (await readFile(rp)).toString('base64')); } catch {}
  }
  if (refs.length) input.image_input = refs;

  const r = await fetch('https://api.replicate.com/v1/models/google/nano-banana/predictions', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'wait'},
    body: JSON.stringify({input}),
  });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`nano-banana 실패(${r.status}): ${d?.detail || ''}`);
  let url: string | undefined = Array.isArray(d.output) ? d.output[0] : d.output;
  if (!url && d?.urls?.get) {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const pr = await fetch(d.urls.get, {headers: {Authorization: 'Bearer ' + key}});
      const pd: any = await pr.json();
      if (pd.status === 'succeeded') { url = Array.isArray(pd.output) ? pd.output[0] : pd.output; break; }
      if (pd.status === 'failed' || pd.status === 'canceled') throw new Error('nano-banana 생성 실패: ' + (pd.error || pd.status));
    }
  }
  if (!url) throw new Error('nano-banana 결과 URL 없음');
  const img = await fetch(url);
  if (!img.ok) throw new Error('nano-banana 이미지 다운로드 실패');
  await writeFile(outPath, Buffer.from(await img.arrayBuffer()));
  log?.(`[이미지] 캐릭터 일관 생성 ${landscape ? '16:9' : '9:16'}${refs.length ? ' (기준 얼굴 유지)' : ' (기준 캐릭터 생성)'} 완료`);
}
