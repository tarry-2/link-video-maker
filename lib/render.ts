// Remotion 프로그래매틱 렌더 — CLI 없이 코드에서 scenes 데이터를 주입해 MP4 생성.
// pipeline이 대본→이미지→음성으로 scenes를 만든 뒤 이 함수만 호출하면 된다.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia, renderStill} from '@remotion/renderer';
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

// ★동시성 = 컨테이너 메모리 기준. Chrome 렌더 스레드가 메모리를 먹으므로 메모리 ÷ 2.5GB로 안전하게 산정
// (최소 1, 최대 4). 메모리를 넘기면 OOM(SIGKILL), 1로 너무 낮추면 느리고 단일프로세스 hang 위험.
// RENDER_CONCURRENCY env로 수동 오버라이드 가능.
function pickConcurrency(memGB: number): number {
  const env = Number(process.env.RENDER_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, Math.min(4, Math.floor(memGB / 2.5)));
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
  orientation: 'portrait' | 'landscape' = 'portrait',
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
  // ★orientation을 inputProps로 넘기면 Root.tsx calculateMetadata가 세로/가로 해상도를 정한다.
  const inputProps = {scenes, transitionFrames, bgmSrc, voiceSrc, orientation};
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
    `[렌더] ${scenes.length}장면 · ${composition.durationInFrames}프레임 인코딩 (동시성 ${concurrency} · 메모리한계 ${memNote})`,
  );
  if (memGB < 4)
    log?.(`[렌더] ⚠️ 컨테이너 메모리 한계가 ${memGB.toFixed(1)}GB로 작습니다. Railway 서비스 메모리를 4GB 이상으로 올리면 안정적입니다.`);
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    // 메모리 기준 동시성(OOM 방지). 메모리가 풀린 뒤엔 1보다 크게 잡아 속도↑.
    concurrency,
    // ★enableMultiProcessOnLinux는 반드시 true. false면 단일프로세스 Chrome이 리눅스에서 0%에 hang 걸린다
    // (메모리와 무관한 별개 버그). gl swiftshader는 서버 GPU 없는 환경 필수.
    chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    // 중간 프레임을 JPEG로(PNG보다 메모리·디스크 대폭 절감), 품질은 쇼츠에 충분한 수준.
    imageFormat: 'jpeg',
    jpegQuality: 80,
    offthreadVideoCacheSizeInBytes: 150 * 1024 * 1024,
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

// 썸네일(커버) 1장 생성 — 영상의 후킹이 꽉 찬 프레임을 고화질 PNG로 추출(renderStill).
// 영상과 똑같은 scenes/레이아웃/폰트를 재사용하므로 글자 안 깨지고 통일감 있다. 첫 장면 중반(후킹+줌) 프레임.
export async function renderThumbnail(
  scenes: SceneData[],
  transitionFrames: number,
  outPath: string,
  log?: (m: string) => void,
  publicDir?: string,
  orientation: 'portrait' | 'landscape' = 'portrait',
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
    const inputProps = {scenes, transitionFrames, orientation};
    const composition = await selectComposition({serveUrl, id: 'Video', inputProps});
    // 첫 장면 중반 프레임(후킹 문구가 크게 들어오고 줌펀치가 꽉 찬 지점). 범위 안전 클램프.
    const firstDur = (scenes[0] as any)?.durationInFrames || Math.round(composition.durationInFrames / Math.max(1, scenes.length));
    const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(firstDur * 0.5)));
    log?.('[썸네일] 후킹 프레임 추출 중…');
    await renderStill({
      composition,
      serveUrl,
      output: outPath,
      inputProps,
      frame,
      imageFormat: 'png',
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    });
    log?.(`[썸네일] 완료 → ${outPath}`);
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}
