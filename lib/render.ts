// Remotion 프로그래매틱 렌더 — CLI 없이 코드에서 scenes 데이터를 주입해 MP4 생성.
// pipeline이 대본→이미지→음성으로 scenes를 만든 뒤 이 함수만 호출하면 된다.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia} from '@remotion/renderer';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import type {SceneData} from '../src/Scene';

let cachedServeUrl: string | null = null;

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
  log?.(
    `[렌더] ${scenes.length}장면 · ${composition.durationInFrames}프레임 인코딩`,
  );
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    // Docker/Linux 서버 안정화 + 멀티코어 병렬 렌더
    chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
    onProgress: ({progress}) => {
      if (Math.round(progress * 100) % 20 === 0)
        log?.(`[렌더] ${Math.round(progress * 100)}%`);
    },
  });
  log?.(`[렌더] 완료 → ${outPath}`);
  } finally {
    if (publicDir) await rm(serveUrl, {recursive: true, force: true});
  }
}
