// I2V 워크플로 확정용 프로브 — 팟 확보 후 번들 I2V JSON을 Jupyter Contents API(무과금)로 읽어
// 실제 UNET/LoRA 파일명·노드 구성을 출력한다. 추측 생성으로 돈 날리기 전에 잠그는 용도.
import fs from 'node:fs';
import path from 'node:path';
import {ensureWanPod} from '../lib/runpod-wan';

// .env.local에서 RUNPOD 키 로드
const envPath = path.join(process.cwd(), '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.RUNPOD_API_KEY || '';

async function jget(pod: string, p: string) {
  const r = await fetch(`https://${pod}-8888.proxy.runpod.net${p}`, {headers: {'User-Agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(30000)});
  return {ok: r.ok, status: r.status, text: await r.text()};
}

(async () => {
  const log = (m: string) => console.log(m);
  const pod = await ensureWanPod(KEY, log);
  console.log('POD READY:', pod);
  // 워크플로 폴더 나열
  const dir = '/api/contents/workspace/ComfyUI/user/default/workflows/Wan%202.2/Video%20Generation?content=1';
  let d = await jget(pod, dir);
  if (!d.ok) { // 경로가 다를 수 있으니 상위 폴더 탐색
    console.log('기본 경로 실패(', d.status, ') → 상위 탐색');
    const alt = await jget(pod, '/api/contents/workspace/ComfyUI/user/default/workflows?content=1');
    console.log('workflows dir:', alt.text.slice(0, 800));
  } else {
    try { const j = JSON.parse(d.text); console.log('파일 목록:', (j.content || []).map((c: any) => c.name).join(' | ')); } catch { console.log(d.text.slice(0, 800)); }
  }
  // I2V json 읽기 시도(여러 후보명)
  for (const name of ['Wan2.2_I2V.json', 'Wan2.2_14B_I2V.json', 'Wan2.2_I2V_14B.json']) {
    const f = await jget(pod, `/api/contents/workspace/ComfyUI/user/default/workflows/Wan%202.2/Video%20Generation/${encodeURIComponent(name)}?content=1`);
    if (!f.ok) { console.log(`[${name}] 없음(${f.status})`); continue; }
    console.log(`\n==== ${name} 발견 ====`);
    const j = JSON.parse(f.text);
    const g = j.content; // ComfyUI UI json
    const nodes = g.nodes || [];
    for (const n of nodes) {
      const t = n.type;
      if (['UNETLoader', 'LoraLoaderModelOnly', 'CLIPVisionLoader', 'WanImageToVideo', 'ModelSamplingSD3', 'CLIPLoader', 'VAELoader'].includes(t)) {
        console.log(t, '→', JSON.stringify(n.widgets_values || []).slice(0, 160));
      }
    }
    console.log('전체 노드 타입:', [...new Set(nodes.map((n: any) => n.type))].join(', '));
    break;
  }
  console.log('\n(프로브 끝 — 팟은 켜둠. 확정 후 클립 생성 또는 수동 종료.)');
})().catch((e) => { console.error('PROBE ERR:', e.message); process.exit(1); });
