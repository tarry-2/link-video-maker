// OnVideo 웹 서버 — 브라우저에서 링크→카테고리→영상 생성. 단일 사용자 로컬 앱.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import {makeVideo} from './lib/pipeline';
import {makeVideoManual} from './lib/manual';
import {PRESETS} from './lib/presets';
import {VOICES, ttsEleven} from './lib/tts';
import {loadEnv, saveEnv, pipelineKeys, maskKey} from './lib/keys';

const PORT = Number(process.env.PORT) || 4000;
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'out');
const SAMPLE_DIR = path.join(ROOT, 'public', 'voice-samples');

// ── 로그인(비번) ──
// ADMIN_PASSWORD 환경변수 있으면 로그인 필수, 없으면(로컬 개발) 로그인 생략.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.APP_SECRET || 'onvideo-dev-secret-change-me';
const COOKIE = 'onvideo_sess';
function sign(v: string) {
  return createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
}
function makeToken() {
  const exp = String(Date.now() + 12 * 3600e3);
  return `${exp}.${sign(exp)}`;
}
function validToken(tok: string): boolean {
  const [exp, sig] = (tok || '').split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
function authed(req: http.IncomingMessage): boolean {
  if (!ADMIN_PASSWORD) return true; // 비번 미설정(로컬) = 통과
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp(COOKIE + '=([^;]+)'));
  return m ? validToken(decodeURIComponent(m[1])) : false;
}

// 진행 중인 작업의 로그를 SSE로 흘리기 위한 저장소
type Job = {id: string; logs: string[]; done: boolean; file?: string; title?: string; error?: string};
const jobs = new Map<string, Job>();

function json(res: http.ServerResponse, code: number, data: unknown) {
  const b = JSON.stringify(data);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(b);
}

function serveFile(res: http.ServerResponse, file: string, type: string) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(200, {'Content-Type': type});
      res.end(buf);
    }
  });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = u.pathname;

  // ── 로그인 상태 확인 ──
  if (p === '/api/auth') return json(res, 200, {required: !!ADMIN_PASSWORD, ok: authed(req)});
  // ── 로그인 ──
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const a = Buffer.from(String(b.password || ''));
    const exp = Buffer.from(ADMIN_PASSWORD);
    const ok = ADMIN_PASSWORD && a.length === exp.length && timingSafeEqual(a, exp);
    if (!ok) return json(res, 401, {error: '비밀번호를 확인하세요.'});
    const secure = (req.headers['x-forwarded-proto'] === 'https') ? ' Secure;' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200;${secure}`,
    );
    return json(res, 200, {ok: true});
  }

  // ── 목소리 샘플 페이지 ──
  if (p === '/voices')
    return serveFile(res, path.join(ROOT, 'web', 'voices.html'), 'text/html; charset=utf-8');

  // ── 정적 ──
  if (p === '/' || p === '/index.html')
    return serveFile(res, path.join(ROOT, 'web', 'index.html'), 'text/html; charset=utf-8');
  // 자폭 SW — 옛 v1 PWA 캐시 제거용. 항상 최신을 받도록 no-store.
  if (p === '/sw.js') {
    return fs.readFile(path.join(ROOT, 'web', 'sw.js'), (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Service-Worker-Allowed': '/',
        });
        res.end(buf);
      }
    });
  }
  if (p === '/app.js')
    return serveFile(res, path.join(ROOT, 'web', 'app.js'), 'text/javascript; charset=utf-8');
  if (p === '/style.css')
    return serveFile(res, path.join(ROOT, 'web', 'style.css'), 'text/css; charset=utf-8');

  // ── 이 아래 모든 /api 는 로그인 필요(비번 설정 시) ──
  if (p.startsWith('/api/') && !authed(req))
    return json(res, 401, {error: '로그인이 필요합니다.'});

  // ── 카테고리 목록 ──
  if (p === '/api/categories')
    return json(res, 200, {
      presets: PRESETS.map((x) => ({
        id: x.id,
        label: x.label,
        emoji: x.emoji,
        group: x.group,
        goal: x.goal,
        voice: x.voice,
      })),
      voices: Object.entries(VOICES).map(([k, v]) => ({
        id: k,
        label: v.label,
        note: v.note,
        tip: v.tip,
        gender: v.gender,
        use: v.use,
      })),
    });

  // ── 키 설정 ──
  if (p === '/api/settings' && req.method === 'GET') {
    const e = loadEnv();
    return json(res, 200, {
      configured: {
        gemini: !!e.GEMINI_KEYS,
        openai: !!e.OPENAI_API_KEY,
        elevenlabs: !!e.ELEVENLABS_API_KEY,
        replicate: !!e.REPLICATE_API_TOKEN,
      },
      geminiCount: (e.GEMINI_KEYS || '').split(/[,\n]+/).filter(Boolean).length,
    });
  }
  if (p === '/api/settings/reveal' && req.method === 'GET') {
    const e = loadEnv();
    return json(res, 200, {
      GEMINI_KEYS: maskKey(e.GEMINI_KEYS),
      OPENAI_API_KEY: maskKey(e.OPENAI_API_KEY),
      ELEVENLABS_API_KEY: maskKey(e.ELEVENLABS_API_KEY),
      REPLICATE_API_TOKEN: maskKey(e.REPLICATE_API_TOKEN),
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    saveEnv(b);
    return json(res, 200, {ok: true});
  }

  // ── 목소리 미리듣기 ──
  if (p === '/api/voice-preview' && req.method === 'GET') {
    const voice = u.searchParams.get('voice') || 'jaewon';
    if (!VOICES[voice]) return json(res, 400, {error: '알 수 없는 목소리'});
    const k = pipelineKeys();
    if (!k.elevenlabs) return json(res, 400, {error: 'ElevenLabs 키를 저장하세요.'});
    fs.mkdirSync(SAMPLE_DIR, {recursive: true});
    const file = path.join(SAMPLE_DIR, `${voice}.mp3`);
    if (!fs.existsSync(file)) {
      try {
        await ttsEleven(
          k.elevenlabs,
          '한때 북적이던 이 거리가, 지금은 텅 비어버렸습니다. 대체 무슨 일이 있었던 걸까요?',
          file,
          VOICES[voice].id,
        );
      } catch (e: any) {
        return json(res, 502, {error: '미리듣기 생성 실패: ' + e.message});
      }
    }
    const buf = fs.readFileSync(file);
    res.writeHead(200, {'Content-Type': 'audio/mpeg', 'Content-Length': buf.length});
    return res.end(buf);
  }

  // ── 영상 생성 시작 ──
  if (p === '/api/generate' && req.method === 'POST') {
    const b = await readBody(req);
    const url = String(b.url || '').trim();
    if (!url) return json(res, 400, {error: '링크를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.elevenlabs || (!k.gemini.length && !k.openai))
      return json(res, 400, {error: '설정에서 키를 먼저 저장하세요(Gemini/OpenAI, ElevenLabs).'});

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);

    // 백그라운드 실행
    (async () => {
      try {
        const r = await makeVideo([url], k, {
          duration: Number(b.duration) || 30,
          presetId: b.presetId || undefined,
          voice: b.voice || undefined,
          quality: b.quality === 'fast' ? 'fast' : 'high',
          aiClips: Number(b.aiClips) || 0,
          log: (m) => job.logs.push(m),
        });
        // 바탕화면 폴더에도 저장
        const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
        const today = new Date().toLocaleDateString('sv-SE');
        const folder = path.join(os.homedir(), 'Desktop', `온비디오 ${today}`, safe);
        fs.mkdirSync(folder, {recursive: true});
        fs.copyFileSync(r.out, path.join(folder, `${safe}.mp4`));
        for (const f of fs.readdirSync(r.imageDir))
          if (/img-\d+\.(jpg|png)$/.test(f))
            fs.copyFileSync(path.join(r.imageDir, f), path.join(folder, f));
        job.file = path.basename(r.out);
        job.title = r.title;
        job.done = true;
        job.logs.push(`[완료] 바탕화면에도 저장됨: ${folder}`);
      } catch (e: any) {
        job.error = e.message;
        job.done = true;
        job.logs.push('[실패] ' + e.message);
      }
    })();

    return json(res, 202, {id});
  }

  // ── 수동 모드: 직접 넣은 이미지 + 키워드로 생성 ──
  if (p === '/api/generate-manual' && req.method === 'POST') {
    const b = await readBody(req);
    const images: string[] = Array.isArray(b.images) ? b.images : []; // dataURL 배열
    const videos: string[] = Array.isArray(b.videos) ? b.videos : []; // dataURL 배열
    if (!images.length && !videos.length)
      return json(res, 400, {error: '이미지나 영상을 최소 1개 넣으세요.'});
    const k = pipelineKeys();
    if (!k.elevenlabs || (!k.gemini.length && !k.openai))
      return json(res, 400, {error: '설정에서 키를 먼저 저장하세요.'});

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);

    (async () => {
      try {
        // dataURL → 임시 파일 저장
        const upDir = path.join(ROOT, 'public', 'uploads', id);
        fs.mkdirSync(upDir, {recursive: true});
        const paths: string[] = [];
        images.slice(0, 20).forEach((durl: string, i: number) => {
          const m = durl.match(/^data:(image\/\w+);base64,(.+)$/);
          if (!m) return;
          const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
          const f = path.join(upDir, `up-${i}.${ext}`);
          fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
          paths.push(f);
        });
        const vpaths: string[] = [];
        videos.slice(0, 10).forEach((durl: string, i: number) => {
          const m = durl.match(/^data:(video\/\w+);base64,(.+)$/);
          if (!m) return;
          const ext = m[1].includes('quicktime') ? 'mov' : m[1].split('/')[1] || 'mp4';
          const f = path.join(upDir, `vid-${i}.${ext}`);
          fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
          vpaths.push(f);
        });
        const r = await makeVideoManual(k, {
          imagePaths: paths,
          videoPaths: vpaths,
          keywords: String(b.keywords || ''),
          facts: String(b.facts || ''),
          duration: Number(b.duration) || 30,
          presetId: b.presetId || undefined,
          voice: b.voice || undefined,
          log: (m) => job.logs.push(m),
        });
        const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
        const today = new Date().toLocaleDateString('sv-SE');
        const folder = path.join(os.homedir(), 'Desktop', `온비디오 ${today}`, safe);
        fs.mkdirSync(folder, {recursive: true});
        fs.copyFileSync(r.out, path.join(folder, `${safe}.mp4`));
        job.file = path.basename(r.out);
        job.title = r.title;
        job.done = true;
        job.logs.push(`[완료] 바탕화면에도 저장됨: ${folder}`);
      } catch (e: any) {
        job.error = e.message;
        job.done = true;
        job.logs.push('[실패] ' + e.message);
      }
    })();

    return json(res, 202, {id});
  }

  // ── 진행 로그(SSE) ──
  if (p === '/api/progress') {
    const id = u.searchParams.get('id') || '';
    const job = jobs.get(id);
    if (!job) return json(res, 404, {error: 'no job'});
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let sent = 0;
    const timer = setInterval(() => {
      while (sent < job.logs.length) {
        res.write(`data: ${JSON.stringify({log: job.logs[sent]})}\n\n`);
        sent++;
      }
      if (job.done) {
        res.write(
          `data: ${JSON.stringify({done: true, file: job.file, title: job.title, error: job.error})}\n\n`,
        );
        clearInterval(timer);
        res.end();
      }
    }, 500);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // ── 완성 영상 다운로드/미리보기 ──
  if (p.startsWith('/api/video/')) {
    const file = path.join(OUT_DIR, path.basename(p));
    if (!fs.existsSync(file)) return json(res, 404, {error: 'not found'});
    const buf = fs.readFileSync(file);
    res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': buf.length});
    return res.end(buf);
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n🎬 OnVideo 웹 → http://localhost:${PORT}\n`);
});
