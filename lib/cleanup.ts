// 디스크(볼륨) 자동 청소 유틸.
// OnVideo는 제작/재시도마다 이미지·음성·영상을 data/studio/{id}/에 쌓고, 렌더는 /tmp에 임시파일을 만든다.
// 지우는 코드가 없으면 Railway 영구 볼륨이 꽉 차서 마지막 ffmpeg(faststart)가 ENOSPC(exit 228)로 죽는다.
// 여기 함수들로 ①job 폴더의 고아 파일(옛 video/music) ②오래된 job ③/tmp 렌더 잔재를 정리한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 디렉토리에서 keep 목록에 없는 "파일"만 삭제(하위 디렉토리는 건드리지 않음). 삭제한 개수/바이트 반환.
export function pruneDir(dir: string, keep: string[]): {removed: number; bytes: number} {
  let removed = 0, bytes = 0;
  const keepSet = new Set(keep);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return {removed, bytes}; }
  for (const e of entries) {
    if (!e.isFile() || keepSet.has(e.name)) continue;
    const f = path.join(dir, e.name);
    try { bytes += fs.statSync(f).size; fs.rmSync(f, {force: true}); removed++; } catch {}
  }
  return {removed, bytes};
}

// 디렉토리 총 용량(바이트). 삭제 전 확보량 집계용.
export function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const f = path.join(dir, e.name);
      try { total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } catch {}
    }
  } catch {}
  return total;
}

// 렌더 임시 디렉토리(/tmp/remotion-*) 중 오래된 것 삭제. 진행 중 렌더를 건드리지 않게 mtime 기준(기본 1시간).
export function cleanTmpRemotion(maxAgeMs = 60 * 60 * 1000): {removed: number; bytes: number} {
  const tmp = os.tmpdir();
  let removed = 0, bytes = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(tmp, {withFileTypes: true}); } catch { return {removed, bytes}; }
  const now = Date.now();
  for (const e of entries) {
    if (!e.name.startsWith('remotion-')) continue;
    const f = path.join(tmp, e.name);
    try {
      if (now - fs.statSync(f).mtimeMs < maxAgeMs) continue;
      bytes += dirSize(f);
      fs.rmSync(f, {recursive: true, force: true});
      removed++;
    } catch {}
  }
  return {removed, bytes};
}

export function mb(bytes: number): string { return (bytes / 1024 ** 2).toFixed(1); }
