import fs from 'node:fs';
import path from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {ZodError} from 'zod';
import {Studio, StudioError} from './studio';
import {studioProviders} from './studio-providers';
import {getStream} from './storage';
import {BatchQueue, type BatchConfig} from './batch';

export const studio = new Studio(path.join(process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data'), 'studio'), studioProviders);
export const batch = new BatchQueue(studio);
// 서버 부팅 시 중단됐던 큐를 이어서 진행(재배포/재시작 복구).
batch.tick();

// 오늘(한국시간) 완성한 영상 수 — 업로드와 별개로 "제작량" 모니터용. 완성 시각 근사=updatedAt.
export function todayProducedCount(): number {
  const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
  try {
    return studio.list().filter((p) => p.status === 'completed' && p.updatedAt &&
      new Date(p.updatedAt).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'}) === todayKst).length;
  } catch { return 0; }
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}
function read(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) {
        if (!failed) reject(new StudioError('한 작업의 업로드 총 크기는 30MB 이내로 줄여주세요.', 413));
        failed = true; chunks.length = 0;
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new StudioError('요청 형식을 확인하세요.')); }
    });
    req.on('error', reject);
  });
}
function sendAsset(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = fs.statSync(file).size;
  const mime: Record<string, string> = {'.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'};
  const headers = {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes'};
  let start = 0; let end = size - 1; let code = 200;
  if (req.headers.range) {
    const m = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); res.end(); return; }
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); res.end(); return; }
    code = 206;
  }
  res.writeHead(code, {...headers, 'Content-Length': end - start + 1, ...(code === 206 ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {})});
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file, {start, end});
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
// R2에 있는 완성영상을 스트리밍(Range 지원). 전송료 0이라 영상 서빙에 최적.
async function sendAssetR2(req: IncomingMessage, res: ServerResponse, key: string) {
  const head = await getStream(key);
  if (!head) { res.writeHead(404); res.end('not found'); return; }
  const size = head.size;
  head.stream.destroy(); // HEAD용으로만 받았으니 닫고 Range로 다시 연다
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const m = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); res.end(); return; }
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); res.end(); return; }
    code = 206;
  }
  const headers: Record<string, string | number> = {'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1};
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const got = await getStream(key, {start, end});
  if (!got) { res.destroy(); return; }
  got.stream.on('error', () => res.destroy()); res.on('close', () => got.stream.destroy()); got.stream.pipe(res);
}
export async function handleStudio(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (pathname !== '/api/studio' && !pathname.startsWith('/api/studio/') && !pathname.startsWith('/api/batch')) return false;
  try {
    if (!['GET', 'HEAD'].includes(req.method || '') && req.headers.origin) {
      if (new URL(req.headers.origin).host !== req.headers.host) throw new StudioError('같은 사이트에서 요청하세요.', 403);
    }
    // ── 배치 생성: 주제 여러 개를 큐에 넣어 순차 자동 제작 ──
    if (pathname === '/api/batch') {
      if (req.method === 'GET') { json(res, 200, batch.status()); return true; }
      if (req.method === 'POST') {
        const b = await read(req);
        const topics: string[] = Array.isArray(b.topics) ? b.topics.map((x: any) => String(x)) : String(b.topics || '').split('\n');
        const cfg: BatchConfig = {
          presetId: String(b.presetId || ''), duration: Number(b.duration) || 40,
          voice: String(b.voice || ''), quality: b.quality === 'fast' ? 'fast' : 'high',
          imageStyle: b.imageStyle === 'anime' ? 'anime' : 'real', music: !!b.music,
          characterId: String(b.characterId || ''),
        };
        if (!topics.filter(t => t.trim()).length) throw new StudioError('주제를 한 줄에 하나씩 입력하세요.');
        json(res, 202, batch.enqueue(topics, cfg)); return true;
      }
      if (req.method === 'DELETE') { json(res, 200, batch.clear()); return true; }
      throw new StudioError('지원하지 않는 요청입니다.', 405);
    }
    if (pathname === '/api/studio') {
      if (req.method === 'GET') json(res, 200, studio.list().map(p => studio.summary(p)));
      else if (req.method === 'POST') json(res, 202, studio.create(await read(req)));
      else throw new StudioError('지원하지 않는 요청입니다.', 405);
      return true;
    }
    const m = pathname.match(/^\/api\/studio\/([0-9a-f-]{36})(?:\/(.*))?$/);
    if (!m) throw new StudioError('작업을 찾을 수 없습니다.', 404);
    const [, id, action = ''] = m;
    if (!action && req.method === 'GET') json(res, 200, studio.view(id));
    else if (!action && req.method === 'PUT') json(res, 200, studio.edit(id, await read(req)));
    else if (action.startsWith('assets/') && ['GET', 'HEAD'].includes(req.method || '')) {
      const loc = studio.assetLocation(id, action.slice(7));
      if (loc.r2) await sendAssetR2(req, res, loc.r2);
      else sendAsset(req, res, loc.local!);
    }
    else if (action === 'render' && req.method === 'POST') {
      const b = await read(req); json(res, 202, studio.render(id, b.revision));
    } else if (/^scenes\/\d+\/(image|voice)$/.test(action) && req.method === 'POST') {
      const [, index, kind] = action.split('/'); const b = await read(req);
      json(res, 202, studio.regenerate(id, Number(index), kind as 'image' | 'voice', b.revision));
    } else if (action === 'portfolio' && req.method === 'POST') {
      json(res, 200, studio.addToPortfolio(id));
    } else throw new StudioError('지원하지 않는 요청입니다.', 404);
  } catch (e) {
    if (e instanceof ZodError) json(res, 400, {error: '입력값을 확인하세요: ' + e.issues.map(i => `${i.path.join('.')} ${i.message}`).join(', ').slice(0, 500)});
    else json(res, e instanceof StudioError ? e.status : 500, {error: e instanceof Error ? e.message : '작업에 실패했습니다.'});
  }
  return true;
}
