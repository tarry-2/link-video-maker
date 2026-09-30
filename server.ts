// OnVideo 웹 서버 — 브라우저에서 링크→카테고리→영상 생성. 단일 사용자 로컬 앱.
import http from 'node:http';
import {handleStudio} from './lib/studio-http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import {makeVideo} from './lib/pipeline';
import {makeVideoManual} from './lib/manual';
import {PRESETS} from './lib/presets';
import {VOICES, ttsEleven} from './lib/tts';
import {geminiGenerate} from './lib/gemini';
import {openaiJson} from './lib/openai';
import {loadEnv, saveEnv, pipelineKeys, maskKey} from './lib/keys';
import {listPortfolio, removePortfolio} from './lib/portfolio';
import {youtubeStatus, saveYouTube, authUrl, exchangeCode, generateMeta, uploadVideo} from './lib/youtube';

const PORT = Number(process.env.PORT) || 4000;
const ROOT = process.cwd();
const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(ROOT, 'data');
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

// 유튜브 OAuth redirect_uri용 프로토콜 — Railway 등 프록시 뒤에서는 x-forwarded-proto가 실제(https).
// 로컬(localhost)만 http, 그 외(배포 도메인)는 https로 고정(구글 콘솔 등록값과 일치시킴).
function ytProto(req: http.IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (fwd) return fwd;
  return String(req.headers.host || '').startsWith('localhost') ? 'http' : 'https';
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
      // HTML/JS/CSS는 배포마다 바뀌므로 항상 최신을 받게 강제(브라우저가 옛 파일 붙잡는 문제 방지).
      // v1의 서비스워커(network-first)가 하던 "항상 최신" 역할을 서버가 직접 헤더로 강제한다.
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
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

  // ── 버전(재배포 확인용) ──
  if (p === '/api/version') {
    let v = '?';
    try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '?'; } catch {}
    return json(res, 200, {version: v});
  }
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
  if (p === '/studio.js')
    return serveFile(res, path.join(ROOT, 'web', 'studio.js'), 'text/javascript; charset=utf-8');
  if (p === '/app.js')
    return serveFile(res, path.join(ROOT, 'web', 'app.js'), 'text/javascript; charset=utf-8');
  if (p === '/style.css')
    return serveFile(res, path.join(ROOT, 'web', 'style.css'), 'text/css; charset=utf-8');
  // 목소리 포트폴리오 샘플 영상(공개, 로그인 전에도 /voices에서 재생)
  if (p.startsWith('/portfolio/')) {
    const name = path.basename(p); // path traversal 방지
    if (!/^[\w.-]+\.mp4$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(ROOT, 'public', 'portfolio', name);
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); }
      else { res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400'}); res.end(buf); }
    });
  }

  // ── 자동 포트폴리오: 목록(공개, voices.html이 로드) ──
  if (p === '/api/portfolio' && req.method === 'GET') {
    const items = listPortfolio().map((it) => ({
      projectId: it.projectId,
      title: it.title,
      voice: it.voice,
      category: it.category,
      goal: it.goal,
      createdAt: it.createdAt,
      video: `/portfolio-item/${it.projectId}.mp4`,
    }));
    return json(res, 200, {items});
  }
  // ── 자동 포트폴리오: 완성 영상 공개 서빙(로그인 없이 /voices에서 재생, Range 지원) ──
  if (p.startsWith('/portfolio-item/')) {
    const m = p.match(/^\/portfolio-item\/([0-9a-f-]{36})\.mp4$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const item = listPortfolio().find((x) => x.projectId === m[1]);
    // 포트폴리오에 등록된 작업의 output만 서빙(목록에 없으면 비공개).
    if (!item || item.output !== path.basename(item.output)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(STUDIO_DATA_DIR, 'studio', m[1], item.output);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const size = fs.statSync(file).size;
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
      res.writeHead(206, {'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1});
      return fs.createReadStream(file, {start, end}).pipe(res);
    }
    res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600'});
    return fs.createReadStream(file).pipe(res);
  }

  // ── 유튜브 OAuth 콜백(공개: 구글이 로그인 쿠키 없이 여기로 리다이렉트) ──
  // redirect_uri는 항상 이 경로로 고정 → 구글 콘솔에도 이 주소를 등록한다.
  if (p === '/api/youtube/callback' && req.method === 'GET') {
    const code = u.searchParams.get('code') || '';
    const err = u.searchParams.get('error') || '';
    const redirectUri = `${ytProto(req)}://${req.headers.host}/api/youtube/callback`;
    const done = (msg: string, ok: boolean) =>
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#231e18;color:#efe9e0;text-align:center;padding:60px"><h2>${ok ? '✅ 유튜브 연결 완료' : '❌ 연결 실패'}</h2><p>${msg}</p><p><a style="color:#4fe0d0" href="/">← 돌아가기</a> (이 창은 닫아도 됩니다)</p></body>`);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    if (err) return done('구글에서 취소됨: ' + err, false);
    if (!code) return done('인증 코드가 없습니다.', false);
    try { await exchangeCode(code, redirectUri); return done('이제 완성 영상을 유튜브에 올릴 수 있어요.', true); }
    catch (e: any) { return done(e.message, false); }
  }

  // ── 이 아래 모든 /api 는 로그인 필요(비번 설정 시) ──
  if (p.startsWith('/api/') && !authed(req))
    return json(res, 401, {error: '로그인이 필요합니다.'});

  // ── 유튜브: 연결 상태 ──
  if (p === '/api/youtube/status' && req.method === 'GET')
    return json(res, 200, youtubeStatus());
  // ── 유튜브: Client ID/Secret 저장 ──
  if (p === '/api/youtube/config' && req.method === 'POST') {
    const b = await readBody(req);
    saveYouTube({
      clientId: String(b.clientId || '').trim() || undefined,
      clientSecret: String(b.clientSecret || '').trim() || undefined,
    });
    return json(res, 200, {ok: true});
  }
  // ── 유튜브: 구글 동의 URL 발급(팝업으로 열게) ──
  if (p === '/api/youtube/auth' && req.method === 'GET') {
    try {
      const redirectUri = `${ytProto(req)}://${req.headers.host}/api/youtube/callback`;
      return json(res, 200, {url: authUrl(redirectUri)});
    } catch (e: any) { return json(res, 400, {error: e.message}); }
  }
  // ── 유튜브: 완성 영상 업로드 ──
  if (p.startsWith('/api/youtube/upload/') && req.method === 'POST') {
    const id = p.slice('/api/youtube/upload/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
    const pjPath = path.join(dir, 'project.json');
    if (!fs.existsSync(pjPath)) return json(res, 404, {error: '작업을 찾을 수 없습니다.'});
    const proj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    if (proj.status !== 'completed' || !proj.output) return json(res, 400, {error: '완성된 영상만 업로드할 수 있습니다.'});
    const file = path.join(dir, proj.output);
    if (proj.output !== path.basename(proj.output) || !fs.existsSync(file)) return json(res, 404, {error: '영상 파일이 없습니다.'});
    const b = await readBody(req);
    const privacy = ['public', 'unlisted', 'private'].includes(b.privacy) ? b.privacy : 'public';
    try {
      const r = await uploadVideo(file, {
        title: String(b.title || proj.title).slice(0, 100),
        description: String(b.description || '').slice(0, 4900),
        tags: Array.isArray(b.tags) ? b.tags.map((x: any) => String(x)).slice(0, 15) : [],
        privacy: privacy as any,
      });
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }
  // ── 유튜브: 메타(제목·설명·태그) 자동 생성 ──
  if (p.startsWith('/api/youtube/meta/') && req.method === 'GET') {
    const id = p.slice('/api/youtube/meta/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    const pjPath = path.join(STUDIO_DATA_DIR, 'studio', id, 'project.json');
    if (!fs.existsSync(pjPath)) return json(res, 404, {error: '작업을 찾을 수 없습니다.'});
    const proj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    const k = pipelineKeys();
    const narrations = (proj.scenes || []).map((s: any) => s.narration || '');
    const durSec = (proj.scenes || []).reduce((n: number, s: any) => n + (s.voice?.frames || 0), 0) / 30 || proj.input?.duration || 30;
    try {
      const meta = await generateMeta({gemini: k.gemini, openai: k.openai}, proj.title, narrations, durSec);
      return json(res, 200, meta);
    } catch (e: any) { return json(res, 502, {error: '메타 생성 실패: ' + e.message}); }
  }

  // ── 포트폴리오 삭제(관리, 로그인 필요) ──
  if (p.startsWith('/api/portfolio/') && req.method === 'DELETE') {
    const id = p.slice('/api/portfolio/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    removePortfolio(id);
    return json(res, 200, {ok: true});
  }

  if (await handleStudio(req, res, p)) return;

  // ── 주제 추천(링크·이미지 없이): 카테고리별로 요즘 잘 되는 주제 후보 ──
  if (p === '/api/topics' && req.method === 'GET') {
    const presetId = u.searchParams.get('preset') || '';
    const preset = PRESETS.find((x) => x.id === presetId);
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '키 설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const cat = preset ? `${preset.group}/${preset.label}` : '전 분야';
    const prompt = `너는 한국 유튜브 쇼츠·릴스 트렌드 전문가다. "${cat}" 분야에서 지금 조회수가 잘 나오고 사람들이 좋아하고 저장·공유하는 쇼츠 "주제" 8개를 제안하라.
각 주제는 클릭하고 싶은 구체적이고 호기심을 자극하는 한 줄 제목(한국어)으로. 뻔하고 일반적인 것 금지, 구체적 숫자·반전·꿀팁 위주. 정치·종교·자극·혐오 제외.
JSON만 출력: {"topics":[{"title":"...","why":"왜 잘 되는지 8자 이내"}]}`;
    try {
      let raw = '';
      if (k.gemini.length) {
        try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 1024, temperature: 1.1}); } catch {}
      }
      if (!raw && k.openai) raw = await openaiJson(k.openai, prompt, 1024);
      const m = raw.match(/\{[\s\S]*\}/);
      const data = m ? JSON.parse(m[0]) : {topics: []};
      return json(res, 200, {topics: Array.isArray(data.topics) ? data.topics.slice(0, 8) : []});
    } catch (e: any) {
      return json(res, 502, {error: '주제 추천 실패: ' + e.message});
    }
  }

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
    // 목소리 용도(issue/info/sell/heal)에 맞는 샘플 대본 — 그 목소리의 성격이 드러나게.
    const PREVIEW_TEXT: Record<string, string> = {
      issue: '한때 북적이던 이 거리가, 지금은 텅 비어버렸습니다. 대체 무슨 일이 있었던 걸까요?',
      info: '하루 한 잔의 물, 별거 아닌 것 같죠? 그런데 우리 몸을 이렇게나 바꿔놓습니다.',
      sell: '이 가격, 실화인가요? 한 번 써보면 왜 다들 재구매하는지 바로 아실 거예요!',
      heal: '노릇하게 익어가는 소리, 고소하게 퍼지는 냄새. 오늘 하루도, 참 수고 많으셨어요.',
    };
    const use0 = VOICES[voice].use?.[0] || 'info';
    const previewText = PREVIEW_TEXT[use0] || PREVIEW_TEXT.info;
    // 파일명에 용도 포함 → 옛 캐시(모두 같은 문구) 무효화 + 용도별 캐시 분리.
    const file = path.join(SAMPLE_DIR, `${voice}_${use0}.mp3`);
    if (!fs.existsSync(file)) {
      try {
        await ttsEleven(k.elevenlabs, previewText, file, VOICES[voice].id);
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
          imageStyle: b.imageStyle === 'anime' ? 'anime' : 'real',
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
