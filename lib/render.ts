// Remotion 프로그래매틱 렌더 — CLI 없이 코드에서 scenes 데이터를 주입해 MP4 생성.
// pipeline이 대본→이미지→음성으로 scenes를 만든 뒤 이 함수만 호출하면 된다.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia} from '@remotion/renderer';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import type {SceneData} from '../src/Scene';

let cachedServeUrl: string | null = null;

// ★컨테이너(Railway/Docker) 진짜 메모리 한계를 읽는다. os.totalmem()은 호스트 물리 메모리(예: 322GB)를
// 반환해서 착시 → 실제로는 cgroup으로 컨테이너에 훨씬 작은 한계(예: 8GB)가 걸려 있고, 이걸 넘으면
// 커널 OOM killer가 FFmpeg를 SIGKILL로 죽인다. cgroup v2/v1 순으로 읽고, 없으면 호스트 값 폴백.
function containerMemGB(): number {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (raw && raw !== 'max') {
        const n = Number(raw);
        // 매우 큰 값(≈무제한, 대략 호스트 전체)은 한계 없음으로 간주 → 호스트 값 사용
        if (Number.isFinite(n) && n > 0 && n < os.totalmem() * 1.5) return n / 1024 ** 3;
      }
    } catch {}
  }
  return os.totalmem() / 1024 ** 3;
}

// ★OOM 방지: Remotion 기본 concurrency는 CPU 코어 수 기준 → Chrome 인스턴스가 컨테이너 메모리 한계를
// 넘겨 FFmpeg가 SIGKILL로 죽는다. 컨테이너 실제 메모리 기준으로 동시성 결정. RENDER_CONCURRENCY로 수동 튜닝.
function pickConcurrency(memGB: number): number | null {
  const env = Number(process.env.RENDER_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const onServer = !!(process.env.RAILWAY_ENVIRONMENT || process.env.PORT === '8080' || process.platform === 'linux');
  // 컨테이너 메모리가 넉넉하면(≥12GB) 자동, 그 외/서버는 1개(가장 안전).
  if (!onServer && memGB >= 12) return null;
  return 1;
}

// 번들은 한 번만(재사용). 이미지/음성이 public/에 있으면 staticFile로 잡힌다.
async function getServeUrl(log?: (m: string) => void): Promise<string> {
  if (cachedServeUrl) return cachedServeUrl;
  const entry = path.join(process.cwd(), 'src/index.ts');
  log?.('[렌더] 번들링 중…');
  cachedServeUrl = await bundle({entryPoint: entry});
  return cachedServeUrl;
}

export async function renderVideo(
  scenes: SceneData[],
  transitionFrames: number,
  outPath: string,
  log?: (m: string) => void,
  bgmSrc?: string,
  voiceSrc?: string,
  publicDir?: string,
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
  const inputProps = {scenes, transitionFrames, bgmSrc, voiceSrc};
  const composition = await selectComposition({
    serveUrl,
    id: 'Video',
    inputProps,
  });
  const memGB = containerMemGB();
  const hostGB = os.totalmem() / 1024 ** 3;
  const concurrency = pickConcurrency(memGB);
  const memNote = memGB < hostGB * 0.9 ? `컨테이너 ${memGB.toFixed(1)}GB` : `${memGB.toFixed(1)}GB`;
  log?.(
    `[렌더] ${scenes.length}장면 · ${composition.durationInFrames}프레임 인코딩 (동시성 ${concurrency ?? '자동'} · 메모리한계 ${memNote})`,
  );
  if (memGB < 4)
    log?.(`[렌더] ⚠️ 컨테이너 메모리 한계가 ${memGB.toFixed(1)}GB로 작습니다. 이 값 미만이면 렌더가 SIGKILL로 죽을 수 있어요(Railway 서비스 메모리 상향 필요).`);
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    // ★메모리 절약: concurrency 제한(서버 OOM 방지) — 낮을수록 느리지만 안 죽는다.
    ...(concurrency ? {concurrency} : {}),
    // ★저메모리 컨테이너: 단일 프로세스가 메모리를 덜 쓴다. multiProcess는 프로세스가 늘어 메모리 증가 →
    // OOM 상황에선 끈다. gl swiftshader는 서버 GPU 없는 환경 필수.
    chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: false},
    // 중간 프레임을 JPEG로(PNG보다 메모리·디스크 대폭 절감), 품질은 쇼츠에 충분한 수준.
    imageFormat: 'jpeg',
    jpegQuality: 80,
    // 프레임 캐시 상한을 낮게(저메모리에서 캐시가 한계를 밀어올리는 것 방지).
    offthreadVideoCacheSizeInBytes: 100 * 1024 * 1024,
    onProgress: ({progress}) => {
      const pct = Math.round(progress * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        log?.(`[렌더] ${pct}%`);
      }
    },
  });
  log?.(`[렌더] 완료 → ${outPath}`);
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}
