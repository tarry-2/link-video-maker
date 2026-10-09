// Remotion 프로그래매틱 렌더 — CLI 없이 코드에서 scenes 데이터를 주입해 MP4 생성.
// pipeline이 대본→이미지→음성으로 scenes를 만든 뒤 이 함수만 호출하면 된다.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia, renderStill} from '@remotion/renderer';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {rm, cp, mkdtemp} from 'node:fs/promises';
import type {SceneData} from '../src/Scene';
import type {CardData} from '../src/Card';

let cachedServeUrl: string | null = null;

// ★렌더 전용 public 폴더 — Remotion 렌더는 "번들에 복사된 public"만 서빙하고, getServeUrl 번들은 최초 1회만
//   만들어 캐시된다. 그래서 번들 이후 public/jobs/{id}/에 쓴 이 작업의 이미지·음성·BGM은 캐시 번들에 없어
//   404 → "Could not play audio … MediaError"로 렌더가 통째로 실패한다(실측 확인). 폰트/효과음 + 이 작업
//   폴더만 담은 임시 public 폴더를 매 렌더마다 새로 만들어 publicDir로 넘기면(studio 영상 경로와 동일),
//   그 자산이 신선한 번들에 들어가 staticFile이 전부 찾는다. 호출부는 렌더 후 rm으로 지운다.
export async function buildRenderPublic(jobRel?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'onvideo-render-'));
  for (const folder of ['fonts', 'sfx']) {
    const src = path.join(process.cwd(), 'public', folder);
    if (fs.existsSync(src)) await cp(src, path.join(dir, folder), {recursive: true});
  }
  if (jobRel) {
    const src = path.join(process.cwd(), 'public', jobRel);
    if (fs.existsSync(src)) await cp(src, path.join(dir, jobRel), {recursive: true});
  }
  return dir;
}

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

// 카드뉴스 영상 렌더 — Video와 동일 설정, 컴포지션만 CardVideo.
export async function renderCardVideo(
  cards: CardData[],
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
    const inputProps = {cards, transitionFrames, bgmSrc, voiceSrc, orientation};
    const composition = await selectComposition({serveUrl, id: 'CardVideo', inputProps});
    const memGB = containerMemGB();
    const concurrency = pickConcurrency(memGB);
    log?.(`[렌더] 카드 ${cards.length}장 · ${composition.durationInFrames}프레임 인코딩 (동시성 ${concurrency})`);
    let lastPct = -1;
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: outPath, inputProps, concurrency,
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
      imageFormat: 'jpeg', jpegQuality: 80,
      offthreadVideoCacheSizeInBytes: 150 * 1024 * 1024,
      onProgress: ({progress}) => {
        const pct = Math.round(progress * 100);
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; log?.(`[렌더] ${pct}%`); }
      },
    });
    log?.(`[렌더] 완료 → ${outPath}`);
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}

// 하이라이트 빠른 렌더용 — 후킹만 투명 PNG로(ffmpeg 합성에 오버레이). Scene 후킹과 동일 디자인.
export async function renderHookStill(
  data: {hookTop: string; hookAccent: string; template?: string; font?: string; orientation?: 'portrait' | 'landscape'},
  outPath: string,
  log?: (m: string) => void,
  publicDir?: string,
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
    const inputProps = {hookTop: data.hookTop, hookAccent: data.hookAccent, template: data.template, font: data.font, orientation: data.orientation || 'portrait'};
    const composition = await selectComposition({serveUrl, id: 'HookStill', inputProps});
    await renderStill({
      composition, serveUrl, output: outPath, inputProps,
      frame: 0, imageFormat: 'png', // png=투명 배경 보존
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    });
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}

// 카드 캐러셀(게시물) — 카드 N장을 각각 4:5 PNG로. 인스타 피드 넘기는 게시물용.
export async function renderCardStills(
  cards: CardData[],
  outPaths: string[],
  log?: (m: string) => void,
  publicDir?: string,
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
    for (let i = 0; i < cards.length; i++) {
      const composition = await selectComposition({serveUrl, id: 'CardStill', inputProps: cards[i]});
      log?.(`[게시물] 카드 ${i + 1}/${cards.length} 이미지 생성…`);
      await renderStill({
        composition, serveUrl, output: outPaths[i], inputProps: cards[i],
        frame: 45, // 등장 애니 정착 후 프레임
        imageFormat: 'png',
        chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
      });
    }
    log?.('[게시물] 모든 카드 이미지 완성');
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}

// 카드 '영상'(릴스) 커버 — 세로 9:16 한 장으로 렌더한다. 게시물용 CardStill은 4:5(1080×1350)라 릴스/유튜브
// 커버로 쓰면 좌우가 잘린다(넷플릭스→플릭스). 실제 영상 첫 장면과 같은 CardVideo(9:16) 컴포지션에서 한 프레임만 뽑아
// 영상 썸네일처럼 9:16로 만든다. 카라오케 캡션(words)은 커버에선 뺀다(깔끔한 커버).
export async function renderCardCover(
  card: CardData,
  outPath: string,
  log?: (m: string) => void,
  publicDir?: string,
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
    const inputProps = {
      cards: [{...card, words: undefined, durationInFrames: 90, index: 0, total: 1}],
      transitionFrames: 0,
      orientation: 'portrait' as const,
    };
    const composition = await selectComposition({serveUrl, id: 'CardVideo', inputProps});
    await renderStill({
      composition, serveUrl, output: outPath, inputProps,
      frame: 45, imageFormat: 'png',
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    });
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}

export type ThumbInput = {image: string; big: string; small: string; badge: string; accentColor: string};

// 전용 썸네일(커버) 1장 생성 — 영상 프레임 재활용이 아니라 독립 디자인(Thumbnail 컴포지션).
// 큰 문구 + 강조색 블록 + 대비 강한 구도로 클릭을 부른다. 영상과 같은 폰트라 통일감 유지.
export async function renderThumbnail(
  thumb: ThumbInput,
  outPath: string,
  log?: (m: string) => void,
  publicDir?: string,
  orientation: 'portrait' | 'landscape' = 'portrait',
): Promise<void> {
  const serveUrl = publicDir
    ? await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts'), publicDir})
    : await getServeUrl(log);
  try {
    const inputProps = {...thumb, orientation};
    const composition = await selectComposition({serveUrl, id: 'Thumbnail', inputProps});
    log?.('[썸네일] 전용 커버 디자인 생성 중…');
    await renderStill({
      composition,
      serveUrl,
      output: outPath,
      inputProps,
      frame: 0,
      imageFormat: 'png',
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    });
    log?.(`[썸네일] 완료 → ${outPath}`);
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}
