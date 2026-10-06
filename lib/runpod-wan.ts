// RunPod Wan2.2 T2V — OnVideo "움직이는 AI 영상" 엔진.
// OnVideo는 Railway(GPU없음)라 생성은 RunPod A40 팟의 ComfyUI로 위임한다.
// ★근거(2026-10-06 실측): hearmeman/comfyui-wan-template v29 번들 워크플로 Wan2.2_T2V.json을
//   공식소스로 그대로 재구성(ModelSamplingSD3 shift5, lightx2v 4step 로라, negative=ConditioningZeroOut,
//   8step MoE high/low, RIFE 4x→60fps, VHS h264-mp4). 실사 토끼셰프 480x832 60fps 노이즈0 확인.
import {writeFile} from 'node:fs/promises';

const REST = 'https://rest.runpod.io/v1';
const UA = 'Mozilla/5.0';

// 템플릿 download_wan22=true가 받는 정확한 파일명(실측).
const HI_UNET = 'wan2.2_t2v_high_noise_14B_fp16.safetensors';
const LO_UNET = 'wan2.2_t2v_low_noise_14B_fp16.safetensors';
const HI_LORA = 'wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors';
const LO_LORA = 'wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors';

export type WanOpts = {
  width?: number;      // 기본 480 (Wan 네이티브 480p)
  height?: number;     // 기본 832 (9:16 세로 쇼츠)
  length?: number;     // 프레임수(기본 81 ≈ 5s@16fps)
  seed?: number;
  interpolate?: boolean; // RIFE 4x→60fps(기본 true). false면 16fps 원본.
  fps?: number;        // 출력 fps(기본 interpolate면 60, 아니면 16)
  log?: (m: string) => void;
};

const podBase = (podId: string) => `https://${podId}-8188.proxy.runpod.net`;

async function rest(key: string, path: string, method = 'GET', body?: any): Promise<any> {
  const r = await fetch(REST + path, {
    method,
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`RunPod ${method} ${path} → ${r.status}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : {};
}

// ComfyUI가 실제로 떠서 응답하는지(프록시 placeholder 아님) — /system_stats가 JSON이면 준비됨.
async function comfyReady(podId: string): Promise<boolean> {
  try {
    const r = await fetch(podBase(podId) + '/system_stats', {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(20000)});
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && (j.system || j.devices));
  } catch { return false; }
}

// 실행중(runtime 있음)인 wan 팟 찾기.
export async function findRunningWanPod(key: string): Promise<string | null> {
  const d = await rest(key, '/pods');
  const pods = Array.isArray(d) ? d : (d.pods || d.data || []);
  for (const p of pods) {
    if (p.desiredStatus === 'RUNNING' && p.runtime && String(p.imageName || '').includes('comfyui-wan')) return p.id;
  }
  return null;
}

// 팟 확보 — 실행중 wan 팟 있으면 재사용, 없으면 새로 만들고 ComfyUI 준비될 때까지 대기(모델 다운 ~10~15분).
export async function ensureWanPod(key: string, log: (m: string) => void = () => {}): Promise<string> {
  let podId = process.env.RUNPOD_POD_ID || (await findRunningWanPod(key));
  if (podId) {
    log(`[영상] 기존 RunPod 팟 ${podId} 사용`);
  } else {
    log('[영상] RunPod A40 팟 생성 중(모델 다운로드 ~10~15분 소요)…');
    const created = await rest(key, '/pods', 'POST', {
      name: 'wan22-onvideo',
      imageName: 'hearmeman/comfyui-wan-template:v29',
      gpuTypeIds: ['NVIDIA A40'],
      gpuCount: 1,
      containerDiskInGb: 40,
      volumeInGb: 150,
      volumeMountPath: '/workspace',
      ports: ['8188/http', '8888/http'],
      env: {download_wan22: 'true'},
    });
    podId = created.id;
    log(`[영상] 팟 ${podId} 생성됨(A40 $0.49/hr). ComfyUI 기동 대기…`);
  }
  // ComfyUI 준비 대기
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await comfyReady(podId!)) { log(`[영상] ComfyUI 준비 완료(${podId})`); return podId!; }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error('RunPod ComfyUI 준비 타임아웃(20분). 팟 상태를 확인하세요.');
}

function buildGraph(prompt: string, o: Required<Pick<WanOpts, 'width' | 'height' | 'length' | 'seed' | 'interpolate' | 'fps'>>) {
  const g: any = {
    '1': {class_type: 'UNETLoader', inputs: {unet_name: HI_UNET, weight_dtype: 'default'}},
    '2': {class_type: 'LoraLoaderModelOnly', inputs: {model: ['1', 0], lora_name: HI_LORA, strength_model: 1.0}},
    '3': {class_type: 'ModelSamplingSD3', inputs: {model: ['2', 0], shift: 5.0}},
    '4': {class_type: 'PathchSageAttentionKJ', inputs: {model: ['3', 0], sage_attention: 'auto'}},
    '5': {class_type: 'UNETLoader', inputs: {unet_name: LO_UNET, weight_dtype: 'default'}},
    '6': {class_type: 'LoraLoaderModelOnly', inputs: {model: ['5', 0], lora_name: LO_LORA, strength_model: 1.0}},
    '7': {class_type: 'ModelSamplingSD3', inputs: {model: ['6', 0], shift: 5.0}},
    '8': {class_type: 'PathchSageAttentionKJ', inputs: {model: ['7', 0], sage_attention: 'auto'}},
    '9': {class_type: 'CLIPLoader', inputs: {clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default'}},
    '10': {class_type: 'CLIPTextEncode', inputs: {clip: ['9', 0], text: prompt}},
    '11': {class_type: 'ConditioningZeroOut', inputs: {conditioning: ['10', 0]}},
    '12': {class_type: 'EmptyHunyuanLatentVideo', inputs: {width: o.width, height: o.height, length: o.length, batch_size: 1}},
    '13': {class_type: 'KSamplerAdvanced', inputs: {add_noise: 'enable', noise_seed: o.seed, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: 4, return_with_leftover_noise: 'enable', model: ['4', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['12', 0]}},
    '14': {class_type: 'KSamplerAdvanced', inputs: {add_noise: 'disable', noise_seed: o.seed, steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 4, end_at_step: 10000, return_with_leftover_noise: 'disable', model: ['8', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['13', 0]}},
    '15': {class_type: 'VAELoader', inputs: {vae_name: 'wan_2.1_vae.safetensors'}},
    '16': {class_type: 'VAEDecode', inputs: {samples: ['14', 0], vae: ['15', 0]}},
  };
  let imagesNode = '16';
  if (o.interpolate) {
    g['17'] = {class_type: 'FrameInterpolationModelLoader', inputs: {model_name: 'rife426.pth'}};
    g['18'] = {class_type: 'FrameInterpolate', inputs: {interp_model: ['17', 0], images: ['16', 0], multiplier: 4}};
    imagesNode = '18';
  }
  g['19'] = {class_type: 'VHS_VideoCombine', inputs: {images: [imagesNode, 0], frame_rate: o.fps, loop_count: 0, filename_prefix: 'onvideo', format: 'video/h264-mp4', pingpong: false, save_output: true}};
  return g;
}

async function comfyPost(podId: string, path: string, body: any): Promise<any> {
  const r = await fetch(podBase(podId) + path, {method: 'POST', headers: {'User-Agent': UA, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(60000)});
  const txt = await r.text();
  if (!r.ok) throw new Error(`ComfyUI POST ${path} → ${r.status}: ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}
async function comfyGet(podId: string, path: string): Promise<Response> {
  return fetch(podBase(podId) + path, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(60000)});
}

// 한 클립 생성 → outPath(mp4)에 저장. 팟은 이미 준비됐다고 가정(ensureWanPod).
export async function wanT2V(podId: string, prompt: string, outPath: string, opts: WanOpts = {}): Promise<void> {
  const log = opts.log || (() => {});
  const interpolate = opts.interpolate !== false;
  const o = {
    width: opts.width || 480,
    height: opts.height || 832,
    length: opts.length || 81,
    seed: opts.seed ?? Math.floor(Math.random() * 2 ** 50),
    interpolate,
    fps: opts.fps || (interpolate ? 60 : 16),
  };
  const graph = buildGraph(prompt, o);
  const clientId = `onvideo-${Math.floor(Math.random() * 1e6)}`;
  log(`[영상] Wan2.2 제출: "${prompt.slice(0, 48)}…" (${o.width}x${o.height}, ${o.length}f)`);
  const res = await comfyPost(podId, '/prompt', {prompt: graph, client_id: clientId});
  const pid: string = res.prompt_id;
  if (!pid) throw new Error('ComfyUI가 prompt_id를 주지 않았습니다: ' + JSON.stringify(res).slice(0, 200));

  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 6000));
    const hr = await comfyGet(podId, `/history/${pid}`);
    if (!hr.ok) continue;
    const h = await hr.json().catch(() => ({}));
    const entry = h[pid];
    if (!entry) continue;
    const st = entry.status || {};
    if (st.status_str === 'error') {
      const msgs = (entry.status?.messages || []).map((m: any) => JSON.stringify(m)).join(' ');
      throw new Error('Wan 생성 에러: ' + msgs.slice(0, 500));
    }
    if (st.completed || st.status_str === 'success') {
      for (const o2 of Object.values<any>(entry.outputs || {})) {
        for (const key of ['gifs', 'videos', 'images'] as const) {
          for (const f of (o2[key] || [])) {
            const q = `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'output'}`;
            const dr = await comfyGet(podId, q);
            if (!dr.ok) continue;
            const buf = Buffer.from(await dr.arrayBuffer());
            await writeFile(outPath, buf);
            log(`[영상] 클립 완료 ${(Date.now() - t0) / 1000 | 0}s · ${(buf.length / 1024) | 0}KB → ${outPath}`);
            return;
          }
        }
      }
      throw new Error('Wan 생성은 끝났으나 출력 파일을 찾지 못했습니다.');
    }
  }
  throw new Error('Wan 생성 타임아웃(15분).');
}

// 고수준: 팟 확보 + 클립 생성.
export async function generateWanClip(key: string, prompt: string, outPath: string, opts: WanOpts = {}): Promise<void> {
  if (!key) throw new Error('RunPod 키(RUNPOD_API_KEY)가 없습니다.');
  const podId = await ensureWanPod(key, opts.log);
  await wanT2V(podId, prompt, outPath, opts);
}

// ── 팟 라이프사이클(비용 관리) ──

// 팟 종료(삭제) — 과금을 멈춘다. 작업 끝나면 자동으로, 또는 사용자가 수동으로 호출.
export async function terminatePod(key: string, podId: string): Promise<void> {
  await rest(key, `/pods/${podId}`, 'DELETE');
}

// 실행 중인 모든 wan 팟 종료(수동 "지금 끄기" 버튼용). 종료한 팟 id 배열 반환.
export async function stopAllWanPods(key: string): Promise<string[]> {
  const d = await rest(key, '/pods');
  const pods = Array.isArray(d) ? d : (d.pods || d.data || []);
  const ids: string[] = [];
  for (const p of pods) {
    if (String(p.imageName || '').includes('comfyui-wan')) {
      try { await terminatePod(key, p.id); ids.push(p.id); } catch {}
    }
  }
  return ids;
}

// 잔액($) — GraphQL myself.clientBalance. 실패하면 null(표시 안 함).
export async function getBalance(key: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.runpod.io/graphql?api_key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: 'query { myself { clientBalance } }'}),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    const b = j?.data?.myself?.clientBalance;
    return typeof b === 'number' ? b : null;
  } catch { return null; }
}

// RunPod 현황(설정 화면용) — 잔액 + 실행 중 wan 팟 목록.
export async function runpodStatus(key: string): Promise<{balance: number | null; pods: {id: string; status: string; costPerHr?: number}[]}> {
  const balance = await getBalance(key);
  let pods: {id: string; status: string; costPerHr?: number}[] = [];
  try {
    const d = await rest(key, '/pods');
    const arr = Array.isArray(d) ? d : (d.pods || d.data || []);
    pods = arr.filter((p: any) => String(p.imageName || '').includes('comfyui-wan'))
      .map((p: any) => ({id: p.id, status: p.desiredStatus || '?', costPerHr: p.costPerHr}));
  } catch {}
  return {balance, pods};
}
