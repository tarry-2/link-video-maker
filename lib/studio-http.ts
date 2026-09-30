import fs from 'node:fs';
import path from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {ZodError} from 'zod';
import {Studio, StudioError} from './studio';
import {studioProviders} from './studio-providers';

const studio = new Studio(path.join(process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data'), 'studio'), studioProviders);
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
export async function handleStudio(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (pathname !== '/api/studio' && !pathname.startsWith('/api/studio/')) return false;
  try {
    if (!['GET', 'HEAD'].includes(req.method || '') && req.headers.origin) {
      if (new URL(req.headers.origin).host !== req.headers.host) throw new StudioError('같은 사이트에서 요청하세요.', 403);
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
    else if (action.startsWith('assets/') && ['GET', 'HEAD'].includes(req.method || '')) sendAsset(req, res, studio.asset(id, action.slice(7)));
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
