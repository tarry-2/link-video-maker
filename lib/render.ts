// Remotion 프로그래매틱 렌더 — CLI 없이 코드에서 scenes 데이터를 주입해 MP4 생성.
// pipeline이 대본→이미지→음성으로 scenes를 만든 뒤 이 함수만 호출하면 된다.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia} from '@remotion/renderer';
import os from 'node:os';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import type {SceneData} from '../src/Scene';

let cachedServeUrl: string | null = null;

// ★OOM 방지: Remotion 기본 concurrency는 CPU 코어 수 기준 → 서버(Railway)에서 Chrome 인스턴스가
// 메모리를 폭발시켜 커널이 FFmpeg를 SIGKILL(=렌더 실패)로 죽인다. 메모리가 넉넉한 로컬 맥은 자동,
// 서버/저메모리 환경은 낮게 고정. RENDER_CONCURRENCY env로 수동 튜닝 가능.
function pickConcurrency(): number | null {
  const env = Number(process.env.RENDER_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const totalGB = os.totalmem() / 1024 ** 3;
  const onServer = !!(process.env.RAILWAY_ENVIRONMENT || process.env.PORT === '8080' || process.platform === 'linux');
  // 4GB 미만 or 서버면 1개(가장 안전). 그 외(로컬 맥)는 null=Remotion 자동.
  if (totalGB < 4 || onServer) return 1;
  return null;
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
  const concurrency = pickConcurrency();
  const totalGB = (os.totalmem() / 1024 ** 3).toFixed(1);
  const freeGB = (os.freemem() / 1024 ** 3).toFixed(1);
  log?.(
    `[렌더] ${scenes.length}장면 · ${composition.durationInFrames}프레임 인코딩 (동시성 ${concurrency ?? '자동'} · 메모리 ${freeGB}/${totalGB}GB)`,
  );
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    // ★메모리 절약: concurrency 제한(서버 OOM 방지) — 낮을수록 느리지만 안 죽는다.
    ...(concurrency ? {concurrency} : {}),
    // 서버 크롬 안정화. multiProcess는 메모리를 더 쓰므로 동시성 제한과 함께만 켠다.
    chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    // OffthreadVideo 프레임 캐시 상한(수동 이미지+영상 모드 대비 메모리 폭주 방지)
    offthreadVideoCacheSizeInBytes: 200 * 1024 * 1024,
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
