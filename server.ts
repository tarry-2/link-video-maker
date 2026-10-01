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
import {listPortfolio, removePortfolio, setPortfolioYouTube, setSampleYouTube, loadSampleYouTube, SAMPLES} from './lib/portfolio';
import {youtubeStatus, saveYouTube, authUrl, exchangeCode, generateMeta, uploadVideo} from './lib/youtube';
import {getStream} from './lib/storage';

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

// 포트폴리오 항목 id → 실제 mp4 파일 경로 + 메타 소스. 내 완성작(uuid) / 샘플(sample:파일) 공용.
function resolveVideo(id: string): {kind: 'mine' | 'sample'; file: string; r2key?: string; title: string; narrations: string[]; durSec: number} | null {
  if (id.startsWith('sample:')) {
    const name = path.basename(id.slice('sample:'.length));
    if (!/^[\w.-]+\.mp4$/.test(name)) return null;
    const s = SAMPLES.find((x) => x.file === name);
    const file = path.join(ROOT, 'public', 'portfolio', name);
    if (!s || !fs.existsSync(file)) return null;
    return {kind: 'sample', file, title: s.title, narrations: [s.title], durSec: 40};
  }
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
  const pjPath = path.join(dir, 'project.json');
  if (!fs.existsSync(pjPath)) return null;
  const proj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  if (proj.status !== 'completed' || !proj.output || proj.output !== path.basename(proj.output)) return null;
  const file = path.join(dir, proj.output);
  // 로컬에 없고 R2에만 있으면 r2key로 표시(유튜브 업로드 시 임시 다운로드).
  if (!fs.existsSync(file) && !proj.outputR2) return null;
  const narrations = (proj.scenes || []).map((s: any) => s.narration || '');
  const durSec = (proj.scenes || []).reduce((n: number, s: any) => n + (s.voice?.frames || 0), 0) / 30 || proj.input?.duration || 30;
  return {kind: 'mine', file, r2key: fs.existsSync(file) ? undefined : proj.outputR2, title: proj.title, narrations, durSec};
}
// 유튜브 업로드용: 로컬 파일이 있으면 그대로, R2에만 있으면 임시로 내려받아 경로+정리콜백 반환.
async function localVideoFile(src: {file: string; r2key?: string}): Promise<{file: string; cleanup: () => void}> {
  if (!src.r2key) return {file: src.file, cleanup: () => {}};
  const tmp = path.join(os.tmpdir(), `yt-${randomUUID()}.mp4`);
  const got = await getStream(src.r2key);
  if (!got) throw new Error('클라우드에서 영상을 가져오지 못했습니다.');
  await new Promise<void>((resolve, reject) => {
    const w = fs.createWriteStream(tmp);
    got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject);
  });
  return {file: tmp, cleanup: () => { try { fs.rmSync(tmp, {force: true}); } catch {} }};
}

// ── studio project.json의 유튜브 링크 read/write ──
// ★배지 버그 방지: 제작 화면에서 바로 올리면 포트폴리오 등록 순서와 어긋나 setPortfolioYouTube가
//   조용히 실패할 수 있다. project.json에도 링크를 남기고, 포트폴리오 노출 시 보강해 어느 경로든 배지가 뜨게.
function saveProjectYouTube(projectId: string, url: string) {
  try {
    const pj = path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json');
    const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    proj.youtubeUrl = url;
    fs.writeFileSync(pj, JSON.stringify(proj));
  } catch {}
}
function readProjectYouTube(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).youtubeUrl || '';
  } catch { return ''; }
}
// project.json에서 완성영상 R2 키(있으면 R2에서 서빙).
function readProjectOutputR2(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).outputR2 || '';
  } catch { return ''; }
}
// R2 완성영상 스트리밍(Range 지원). 포트폴리오 전시용.
async function streamR2Video(req: http.IncomingMessage, res: http.ServerResponse, key: string) {
  const h = await getStream(key);
  if (!h) { res.writeHead(404); return res.end('not found'); }
  const size = h.size; h.stream.destroy();
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0, end = size - 1, code = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Number(range[2]) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
    code = 206;
  }
  const headers: Record<string, string | number> = {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=3600'};
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  const got = await getStream(key, {start, end});
  if (!got) { res.destroy(); return; }
  got.stream.on('error', () => res.destroy()); res.on('close', () => got.stream.destroy()); got.stream.pipe(res);
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
  // 서비스워커(PWA) — 항상 최신을 받도록 no-store(옛 SW 고착 방지).
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
  // ── PWA 자산(앱 설치) — manifest·아이콘·파비콘. web/에 복원됨. ──
  if (p === '/manifest.json')
    return serveFile(res, path.join(ROOT, 'web', 'manifest.json'), 'application/manifest+json; charset=utf-8');
  if (p === '/icon-192.png')
    return serveFile(res, path.join(ROOT, 'web', 'icon-192.png'), 'image/png');
  if (p === '/icon-512.png')
    return serveFile(res, path.join(ROOT, 'web', 'icon-512.png'), 'image/png');
  if (p === '/favicon.svg')
    return serveFile(res, path.join(ROOT, 'web', 'favicon.svg'), 'image/svg+xml; charset=utf-8');
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

  // ── 자동 포트폴리오: 목록(공개, voices.html이 로드) ── 내 완성작 + 기본 샘플 병합.
  if (p === '/api/portfolio' && req.method === 'GET') {
    const mine = listPortfolio().map((it) => ({
      id: it.projectId,
      kind: 'mine' as const,
      title: it.title,
      voice: it.voice,
      category: it.category,
      goal: it.goal,
      createdAt: it.createdAt,
      // ★배지: portfolio.json에 링크 없으면 project.json에서 보강(제작 화면서 바로 올린 경우도 배지 뜨게).
      youtubeUrl: it.youtubeUrl || readProjectYouTube(it.projectId),
      orientation: it.orientation || 'portrait', // 레거시(없음)=세로 폴백
      video: `/portfolio-item/${it.projectId}.mp4`,
    }));
    const sampleYt = loadSampleYouTube();
    const samples = SAMPLES.map((s) => ({
      id: 'sample:' + s.file,
      kind: 'sample' as const,
      title: s.title,
      voice: s.voice,
      category: s.category,
      goal: s.goal,
      createdAt: '',
      youtubeUrl: sampleYt[s.file] || '',
      orientation: s.orientation || 'portrait', // 샘플은 전부 세로(9:16)
      video: `/portfolio/${s.file}`,
    }));
    return json(res, 200, {items: [...mine, ...samples]});
  }
  // ── 자동 포트폴리오: 완성 영상 공개 서빙(로그인 없이 /voices에서 재생, Range 지원) ──
  if (p.startsWith('/portfolio-item/')) {
    const m = p.match(/^\/portfolio-item\/([0-9a-f-]{36})\.mp4$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const item = listPortfolio().find((x) => x.projectId === m[1]);
    // 포트폴리오에 등록된 작업의 output만 서빙(목록에 없으면 비공개).
    if (!item || item.output !== path.basename(item.output)) { res.writeHead(404); return res.end('not found'); }
    // 완성영상이 R2에 있으면 거기서 스트리밍(볼륨엔 없음).
    const r2key = readProjectOutputR2(m[1]);
    if (r2key) return streamR2Video(req, res, r2key);
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
  // ── 유튜브: 완성 영상 업로드 ── 내 완성작(uuid) + 샘플(sample:파일) 둘 다 지원.
  if (p.startsWith('/api/youtube/upload/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/youtube/upload/'.length));
    const src = resolveVideo(id);
    if (!src) return json(res, 404, {error: '영상을 찾을 수 없습니다.'});
    const b = await readBody(req);
    const privacy = ['public', 'unlisted', 'private'].includes(b.privacy) ? b.privacy : 'public';
    let tmpCleanup = () => {};
    try {
      const local = await localVideoFile(src); tmpCleanup = local.cleanup;
      const r = await uploadVideo(local.file, {
        title: String(b.title || src.title).slice(0, 100),
        description: String(b.description || '').slice(0, 4900),
        tags: Array.isArray(b.tags) ? b.tags.map((x: any) => String(x)).slice(0, 15) : [],
        privacy: privacy as any,
      });
      try {
        if (src.kind === 'mine') { setPortfolioYouTube(id, r.url); saveProjectYouTube(id, r.url); }
        else setSampleYouTube(path.basename(id.slice('sample:'.length)), r.url);
      } catch {}
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
    finally { tmpCleanup(); }
  }
  // ── 유튜브: 메타(제목·설명·태그) 자동 생성 ── 내 완성작 + 샘플 둘 다.
  if (p.startsWith('/api/youtube/meta/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/youtube/meta/'.length));
    const src = resolveVideo(id);
    if (!src) return json(res, 404, {error: '영상을 찾을 수 없습니다.'});
    const k = pipelineKeys();
    try {
      const meta = await generateMeta({gemini: k.gemini, openai: k.openai}, src.title, src.narrations, src.durSec);
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
    const cat = preset ? `${preset.group}/${preset.label}` : '건강·헬시 꿀팁, 핫한 생활정보, 요리 레시피 등 저장·공유가 폭발하는 실용 분야';
    const prompt = `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자다. "${cat}"에서 지금 조회수가 폭발하고 저장·공유·완주율이 높은 쇼츠 "주제" 8개를 제안하라.

[주제 선정 원칙]
- 저장하고 싶은 실용성(바로 써먹는 꿀팁·레시피·건강법)과 안 보면 손해인 호기심을 동시에 자극.
- 막연·일반론 절대 금지. 아주 구체적이어야 한다. (X "건강에 좋은 음식" / O "자기 전에 이거 한 숟갈, 아침이 달라집니다")
- ★대상이 있는 분야(여행·명소·맛집·장소·인물·제품 등)는 반드시 "실제 고유명사"를 콕 집어라. (X "숨겨진 여행 명소" / O "포르투갈 신트라, 동화 속 이 성") 막연히 "이곳·여기"로 끝나는 주제 금지 — 제목에 실제 지명·이름이 들어가야 한다.
- 숫자·반전·의외의 사실·흔한 오해 깨기를 적극 활용.
${preset ? '' : '- 특히 건강/헬시 꿀팁, 남들 모르는 핫한 생활정보, 따라하기 쉬운 레시피를 많이 섞어라(요즘 가장 잘 터지는 분야).\n'}[제목(title)]
- 클릭·시청을 부르는 후킹형 한 줄: 궁금증 갭("아무도 안 알려주는~"), 손실 회피("모르면 손해인~"), 숫자·반전 중 하나를 꽂아라. 밋밋하면 실패.
- 정치·종교·자극·혐오 제외.

JSON만 출력: {"topics":[{"title":"...","why":"왜 터지는지 10자 이내"}]}`;
    try {
      let raw = '';
      if (k.gemini.length) {
        try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 1024, temperature: 1.1}); } catch {}
      }
      if (!raw && k.openai) raw = await openaiJson(k.openai, prompt, 1024);
      const m = raw.match(/\{[\s\S]*\}/);
      const data = m ? JSON.parse(m[0]) : {topics: []};
      // ★마크다운 별표(**강조**·*·리스트마커) 제거 — LLM이 넣은 별표가 화면에 그대로 노출되던 문제.
      const clean = (s: any) => String(s || '').replace(/\*+/g, '').replace(/^\s*[-#>]+\s*/, '').replace(/`/g, '').trim();
      const topics = (Array.isArray(data.topics) ? data.topics : []).slice(0, 8)
        .map((t: any) => ({title: clean(t.title), why: clean(t.why)}))
        .filter((t: any) => t.title);
      return json(res, 200, {topics});
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
