// Seedance 2.0 (ByteDance) image-to-video via fal.ai — 정지 이미지 + 모션 프롬프트 → 영상(mp4).
// 런팟 Wan 대비 체급이 높음(ReelShort급 사람 모션·1080p). 우리 자막/TTS를 얹으므로 네이티브 오디오는 끔.
// 인증: Authorization: Key <FAL_KEY>.  업로드: rest.alpha.fal.ai/storage.  생성: queue.fal.run.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_INIT = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn';
const QUEUE = 'https://queue.fal.run';
// Fast = 최저가(테리 지정). fast가 없으면 표준으로 폴백.
const ENDPOINTS_FAST = ['bytedance/seedance-2.0/fast/image-to-video', 'bytedance/seedance-2.0/image-to-video'];
const ENDPOINTS_STD = ['bytedance/seedance-2.0/image-to-video'];
const ENDPOINTS_25 = ['bytedance/seedance-2.5/image-to-video']; // 2.5 고급(비쌈·최대30초·립싱크·매프레임 레퍼런스)
// ★fal 실제 단가(USD/초, 720p) — 2.0 Standard=최상 품질, 2.5=고급. (fast $0.242는 품질↓라 2.0은 Standard 사용)
const USD_PER_SEC: Record<string, number> = {'2.0': 0.3024, '2.5': 0.473};

// 블록버스터 시네마 품질 꼬리표(스타일만 — 피사체 재설명 금지).
export const SEEDANCE_CINE = 'cinematic blockbuster film quality, dramatic movie lighting, shallow depth of field, filmic grain, Hollywood production grade, ultra detailed';

// ★Seedance i2v 프롬프트 빌더 — 공식 베스트프랙티스(온라인 다수 리뷰/가이드 교차확인):
//   · i2v는 시작 스틸에 '인물·구도·룩'이 이미 있으므로, 프롬프트는 '바뀔 것 = 동작 + 카메라'만 묘사(장면 재설명 금지).
//   · 정적 동사(서 있다/앉아 있다)는 거의 안 움직임 → 미세 동작(숨쉬기·고개 살짝·머리카락·옷 흔들림)으로 모션 활성화.
//   · 카메라는 느리고 부드럽게(영화는 느리다), 최대 1~2개.
//   · ★캐릭터 일관성(테리 최우선): "같은 인물, [외형 고정특징], 얼굴·머리·옷 바꾸지 마"를 명시해 컷마다 안 변하게.
// 샷 타입 → '카메라 무브 1개'(Seedance 공식: 샷당 primary 무브 하나, 느리게). 블록버스터 카메라 언어.
function cameraFor(shot?: string): string {
  const s = (shot || '').toLowerCase();
  if (s.includes('wide') || s.includes('establish')) return 'slow dolly-in from a wide establishing shot';
  if (s.includes('extreme close')) return 'a very gentle slow push-in on the eyes';
  if (s.includes('close')) return 'a gentle slow push-in on the face';
  if (s.includes('over-the-shoulder') || s.includes('over the shoulder')) return 'steady over-the-shoulder framing with a subtle push-in';
  if (s.includes('low-angle') || s.includes('low angle') || s.includes('hero')) return 'a slow rising low-angle hero shot';
  if (s.includes('track') || s.includes('follow')) return 'a smooth tracking shot that follows the subject, keeping distance';
  if (s.includes('aerial') || s.includes('drone') || s.includes('bird')) return 'a slow descending aerial drone shot';
  if (s.includes('orbit') || s.includes('arc')) return 'a slow orbit arc around the subject';
  if (s.includes('pov') || s.includes('point of view')) return 'a steady point-of-view shot';
  if (s.includes('medium')) return 'a steady medium shot with a subtle push-in';
  return 'a slow cinematic push-in';
}

// Seedance i2v 프롬프트 — 공식 베스트프랙티스: [카메라 1개] + [미세 동작] + [정체성 고정] + [시네마 품질].
//   i2v는 스틸이 피사체·룩을 이미 주므로 '바뀔 것(동작·카메라)'만. 정적 금지→미세동작. 샷당 카메라 1개.
export function seedancePrompt(opts: {motion?: string; characterLook?: string; shot?: string} = {}): string {
  const parts: string[] = [];
  parts.push(opts.motion && opts.motion.trim() ? opts.motion.trim() : 'the subject moves naturally and energetically');
  parts.push('lively, dynamic full-body motion: the character walks, moves through the scene, gestures with hands, and talks with clear lip and facial movement — full of life and energy like a real movie shot (NOT a still photo, NOT just subtle breathing)');
  parts.push(`${cameraFor(opts.shot)}, cinematic and dynamic`);
  if (opts.characterLook && opts.characterLook.trim()) parts.push(`the person is ${opts.characterLook.trim()}; keep this exact same person`);
  parts.push('keep the SAME face, hairstyle and clothing throughout the shot (do NOT change, morph or swap the identity), but let the body, pose, gestures and facial expression move freely and vividly');
  parts.push(SEEDANCE_CINE);
  return parts.join('. ');
}

export type SeedanceOpts = {
  resolution?: '480p' | '720p';
  duration?: number; // 초. 2.0=최대15, 2.5=최대30.
  model?: '2.0' | '2.5'; // 품질 토글(기본 2.0=쌈). 2.5=고급(비쌈·30초·립싱크).
  aspectRatio?: '9:16' | '16:9' | '1:1' | 'auto';
  seed?: number;
  fast?: boolean; // 기본 true(최저가 Fast)
  log?: (m: string) => void;
};

// 로컬 이미지 → fal 스토리지 업로드 → 공개 file_url 반환.
async function falUpload(key: string, filePath: string, contentType = 'image/jpeg'): Promise<string> {
  const init = await fetch(UPLOAD_INIT, {
    method: 'POST',
    headers: {Authorization: `Key ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({content_type: contentType, file_name: path.basename(filePath)}),
    signal: AbortSignal.timeout(30000),
  });
  if (!init.ok) throw new Error(`fal 업로드 준비 실패(${init.status})`);
  const d: any = await init.json();
  if (!d.upload_url || !d.file_url) throw new Error('fal 업로드 URL을 못 받음');
  const buf = await readFile(filePath);
  const put = await fetch(d.upload_url, {method: 'PUT', headers: {'Content-Type': contentType}, body: new Uint8Array(buf), signal: AbortSignal.timeout(120000)});
  if (!put.ok) throw new Error(`fal 업로드 전송 실패(${put.status})`);
  return d.file_url;
}

// 한 컷 생성: 시작 이미지 + 프롬프트 → outPath(mp4). 반환: 실제 영상 길이(초)·추정 비용(USD).
export async function seedanceI2V(key: string, prompt: string, startImagePath: string, outPath: string, opts: SeedanceOpts = {}): Promise<{seconds: number; costUsd: number}> {
  const log = opts.log || (() => {});
  if (!key) throw new Error('fal(Seedance) 키가 없습니다. 키 설정에서 저장하세요.');

  log('[영상] Seedance에 시작 이미지 업로드 중…');
  const imageUrl = await falUpload(key, startImagePath, 'image/jpeg');

  const input: Record<string, unknown> = {
    prompt,
    image_url: imageUrl,
    resolution: opts.resolution || '720p',
    generate_audio: false, // 우리 TTS·자막을 얹으므로 네이티브 오디오 끔
  };
  const model = opts.model === '2.5' ? '2.5' : '2.0';
  const maxDur = model === '2.5' ? 30 : 15;
  const dur = opts.duration ? Math.max(4, Math.min(maxDur, Math.round(opts.duration))) : 0;
  if (dur) input.duration = String(dur);
  if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
  if (opts.seed != null) input.seed = opts.seed;

  // 제출. ★제출 응답이 주는 status_url·response_url을 '그대로' 쓴다(네임스페이스 모델은 조립 경로가 안 맞아 폴링 헛돎).
  const endpoints = model === '2.5' ? ENDPOINTS_25 : ENDPOINTS_STD; // 2.0=Standard(최상 품질, 720p)
  let reqId = '', endpoint = '', statusUrl = '', responseUrl = '', lastErr = '';
  for (const ep of endpoints) {
    const sub = await fetch(`${QUEUE}/${ep}`, {
      method: 'POST',
      headers: {Authorization: `Key ${key}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
    const txt = await sub.text();
    if (sub.ok) {
      const d = JSON.parse(txt);
      reqId = d.request_id || d.requestId; endpoint = ep;
      statusUrl = d.status_url || `${QUEUE}/${ep}/requests/${reqId}/status`;
      responseUrl = d.response_url || `${QUEUE}/${ep}/requests/${reqId}`;
      break;
    }
    lastErr = `${sub.status}: ${txt.slice(0, 180)}`;
    if (sub.status !== 404) break; // 404(엔드포인트 없음)만 다음 후보로
  }
  if (!reqId || !statusUrl) throw new Error(`Seedance 제출 실패(${lastErr})`);
  log(`[영상] Seedance 생성 시작(${endpoint.includes('fast') ? 'Fast·최저가' : '표준'}) — 보통 30~120초`);

  // 폴링(최대 8분) — 제출이 돌려준 status_url 사용.
  const started = Date.now();
  let status = '';
  while (Date.now() - started < 8 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await fetch(statusUrl, {headers: {Authorization: `Key ${key}`}, signal: AbortSignal.timeout(20000)});
    const sd: any = await st.json().catch(() => ({}));
    status = sd.status || '';
    if (status === 'COMPLETED') break;
    if (status === 'FAILED' || status === 'ERROR') throw new Error('Seedance 생성 실패(FAILED)');
  }
  if (status !== 'COMPLETED') throw new Error('Seedance 생성 시간 초과(8분)');

  // 결과 → 영상 URL (response_url 그대로 사용)
  const res = await fetch(responseUrl, {headers: {Authorization: `Key ${key}`}, signal: AbortSignal.timeout(30000)});
  const rd: any = await res.json();
  const videoUrl = rd?.video?.url || rd?.videos?.[0]?.url;
  if (!videoUrl) throw new Error('Seedance 결과에 영상 URL이 없습니다.');
  const vid = await fetch(videoUrl, {signal: AbortSignal.timeout(180000)});
  if (!vid.ok) throw new Error(`Seedance 영상 다운로드 실패(${vid.status})`);
  const vbuf = Buffer.from(await vid.arrayBuffer());
  await writeFile(outPath, vbuf);

  const seconds = dur || 5;
  const costUsd = Number((seconds * (USD_PER_SEC[model] || 0.3)).toFixed(3));
  log(`[영상] Seedance 완성(${(vbuf.length / 1e6).toFixed(1)}MB · 약 ${seconds}초)`);
  return {seconds, costUsd};
}

// Seedance 2.0 Fast 추정 단가(USD/초). 실제 fal 청구와 맞춰 조정(로그의 '추정 비용' 표기용).
export const SEEDANCE_USD_PER_SEC = 0.04;

// 잔액 조회(Admin 키 필요 — 일반 생성 키는 권한 없음). {ok, credits, error}.
export async function falBalance(key: string): Promise<{ok: boolean; credits?: number; error?: string}> {
  if (!key) return {ok: false, error: 'fal 키 없음'};
  try {
    const r = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {headers: {Authorization: `Key ${key}`}, signal: AbortSignal.timeout(20000)});
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) return {ok: false, error: d?.error?.message || `HTTP ${r.status}`};
    const credits = d?.credits ?? d?.credit_balance ?? d?.balance ?? d?.user?.credits;
    return {ok: true, credits: typeof credits === 'number' ? credits : undefined};
  } catch (e: any) {
    return {ok: false, error: e?.message || '조회 실패'};
  }
}
