// OnVideo 웹 서버 — 브라우저에서 링크→카테고리→영상 생성. 단일 사용자 로컬 앱.
import http from 'node:http';
import {handleStudio, todayProducedCount} from './lib/studio-http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import {makeVideo} from './lib/pipeline';
import {makeVideoManual} from './lib/manual';
import {makeCardVideo} from './lib/card-pipeline';
import {generateCardStoryboard} from './lib/cards';
import {PRESETS, RECOMMEND_STYLE, getPreset} from './lib/presets';
import {STYLES, STYLE_IDS} from './lib/styles';
import {runpodStatus, stopAllWanPods} from './lib/runpod-wan';
import {VOICES, ttsEleven} from './lib/tts';
import {geminiGenerate} from './lib/gemini';
import {openaiJson} from './lib/openai';
import {loadEnv, saveEnv, pipelineKeys, maskKey} from './lib/keys';
import {listPortfolio, removePortfolio, setPortfolioYouTube, setSampleYouTube, loadSampleYouTube, setPortfolioInstagram, setSampleInstagram, loadSampleInstagram, loadSampleR2, setSampleR2, SAMPLES} from './lib/portfolio';
import {youtubeStatus, saveYouTube, authUrl, exchangeCode, generateMeta, uploadVideo, extractVideoId, getVideoStats, getUploadActivity as getYtActivity} from './lib/youtube';
import {getStream, presignGet, uploadFile, videoKey, r2Enabled} from './lib/storage';
import {listCharacters, characterImagePath, createCharacter, deleteCharacter} from './lib/characters';
import {instagramStatus, saveInstagram, verifyInstagram, publishVideo, publishCarousel, loadInstagram, generateCaption, maybeRefreshInstagram, getInstaStats, getUploadActivity} from './lib/instagram';
import {pngToJpeg} from './lib/img-util';

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

// 대본편집: 클라이언트가 보낸 편집 카드 대본을 안전하게 정리(길이·개수 제한, 타입/문자열만). 유효치 않으면 undefined→AI 생성.
function sanitizeCardStoryboard(raw: any): any {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards) || !raw.cards.length) return undefined;
  const s = (v: any, max = 400) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const cards = raw.cards.slice(0, 12).map((c: any) => ({
    type: typeof c?.type === 'string' ? c.type : 'body',
    accent: typeof c?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : undefined,
    badge: s(c?.badge, 20), big: s(c?.big, 60), small: s(c?.small, 80),
    title: s(c?.title, 80), body: s(c?.body, 400),
    number: s(c?.number, 20), unit: s(c?.unit, 20),
    items: Array.isArray(c?.items) ? c.items.map((x: any) => String(x).slice(0, 120)).slice(0, 6) : undefined,
    before: s(c?.before, 120), after: s(c?.after, 120), wrong: s(c?.wrong, 120), right: s(c?.right, 120),
    visualPrompt: s(c?.visualPrompt, 600),
  }));
  return {
    title: s(raw.title, 80) || '카드뉴스',
    musicPrompt: s(raw.musicPrompt, 200) || 'upbeat bright cheerful light background music',
    subject: s(raw.subject, 200) || '',
    cards,
  };
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
// 내 완성작의 썸네일(커버) 로컬 경로 확보 — 유튜브 커버 지정용. 로컬/R2/없음. 샘플은 썸네일 없음.
async function localThumbFile(projectId: string): Promise<{file: string; cleanup: () => void} | null> {
  try {
    const proj = JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8'));
    if (!proj.thumb) return null;
    const local = path.join(STUDIO_DATA_DIR, 'studio', projectId, proj.thumb);
    if (fs.existsSync(local)) return {file: local, cleanup: () => {}};
    if (!proj.thumbR2) return null;
    const tmp = path.join(os.tmpdir(), `thumb-${randomUUID()}.png`);
    const got = await getStream(proj.thumbR2);
    if (!got) return null;
    await new Promise<void>((resolve, reject) => {
      const w = fs.createWriteStream(tmp);
      got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject);
    });
    return {file: tmp, cleanup: () => { try { fs.rmSync(tmp, {force: true}); } catch {} }};
  } catch { return null; }
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
// ── 인스타 링크도 동일 방식으로 project.json에 보강(배지 안정화) ──
function saveProjectInstagram(projectId: string, url: string) {
  try {
    const pj = path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json');
    const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    proj.instagramUrl = url;
    fs.writeFileSync(pj, JSON.stringify(proj));
  } catch {}
}
function readProjectInstagram(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).instagramUrl || '';
  } catch { return ''; }
}
// project.json에서 완성영상 R2 키(있으면 R2에서 서빙).
function readProjectOutputR2(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).outputR2 || '';
  } catch { return ''; }
}
function readProjectThumb(projectId: string): {thumb: string; thumbR2: string} {
  try {
    const proj = JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8'));
    return {thumb: proj.thumb || '', thumbR2: proj.thumbR2 || ''};
  } catch { return {thumb: '', thumbR2: ''}; }
}
function saveProjectOutputR2(projectId: string, key: string) {
  try {
    const pj = path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json');
    const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    proj.outputR2 = key;
    fs.writeFileSync(pj, JSON.stringify(proj));
  } catch {}
}
// 인스타 업로드 전 공개 URL(R2 presign) 확보 — 내 완성작(uuid) + 샘플(sample:파일) 공용.
// R2에 없으면 로컬 완성본/샘플 파일을 R2로 백필 업로드하고 키를 기록(한 번만 올리고 재사용).
async function ensureInstaVideoR2(id: string): Promise<string> {
  const src = resolveVideo(id);
  if (!src) return '';
  if (src.kind === 'mine') {
    let key = readProjectOutputR2(id);
    if (key) return key;
    if (!r2Enabled() || !fs.existsSync(src.file)) return '';
    key = videoKey(id, 'video-backfill.mp4');
    if (!(await uploadFile(key, src.file))) return '';
    saveProjectOutputR2(id, key);
    return key;
  }
  // 샘플(public/portfolio/*.mp4): sample-r2.json에 백필 키 기록.
  const base = path.basename(src.file);
  let key = loadSampleR2()[base];
  if (key) return key;
  if (!r2Enabled() || !fs.existsSync(src.file)) return '';
  key = `samples/${base}`;
  if (!(await uploadFile(key, src.file))) return '';
  setSampleR2(base, key);
  return key;
}
// 카드 게시물(캐러셀) 메타 — project.json에서 제목·나레이션(캡션 생성용) 읽기.
function cardPostMeta(id: string): {title: string; narrations: string[]} | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    const proj = JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', id, 'project.json'), 'utf8'));
    if (proj.cardKind !== 'card-post') return null;
    const narrations = (proj.scenes || []).map((s: any) => s.narration || '').filter(Boolean);
    return {title: proj.title || '카드뉴스', narrations: narrations.length ? narrations : [proj.title || '']};
  } catch { return null; }
}
// 캐러셀 업로드용 JPEG 공개 URL 확보 — 카드 PNG를 JPEG로 변환해 R2에 올리고 presign. (인스타는 JPEG만 허용)
//   변환본 키는 project.json.imagesJpgR2에 캐시해 재업로드 때 재사용.
async function ensureCarouselJpegUrls(id: string, log: (m: string) => void): Promise<string[]> {
  if (!r2Enabled()) throw new Error('클라우드 저장소(R2)가 꺼져 있어 캐러셀 공개 링크를 만들 수 없습니다.');
  const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
  const pjPath = path.join(dir, 'project.json');
  const proj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const names: string[] = proj.images || [];
  const pngR2: string[] = proj.imagesR2 || [];
  const jpgR2: string[] = proj.imagesJpgR2 || [];
  const urls: string[] = [];
  for (let i = 0; i < names.length; i++) {
    if (!jpgR2[i]) {
      // 원본 PNG 확보(로컬 or R2) → 임시 파일.
      const tmpPng = path.join(os.tmpdir(), `card-${id}-${i}.png`);
      const localPng = path.join(dir, names[i]);
      if (fs.existsSync(localPng)) fs.copyFileSync(localPng, tmpPng);
      else if (pngR2[i]) {
        const got = await getStream(pngR2[i]);
        if (!got) throw new Error(`이미지 ${i + 1}을 가져오지 못했습니다.`);
        await new Promise<void>((resolve, reject) => { const w = fs.createWriteStream(tmpPng); got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject); });
      } else throw new Error(`이미지 ${i + 1} 파일이 없습니다.`);
      const tmpJpg = path.join(os.tmpdir(), `card-${id}-${i}.jpg`);
      log(`[인스타] 이미지 ${i + 1}/${names.length} JPEG 변환…`);
      await pngToJpeg(tmpPng, tmpJpg);
      const key = videoKey(id, `carousel-${i + 1}.jpg`);
      if (!(await uploadFile(key, tmpJpg, 'image/jpeg'))) throw new Error(`이미지 ${i + 1} 업로드 실패`);
      jgSafeUnlink(tmpPng); jgSafeUnlink(tmpJpg);
      jpgR2[i] = key;
    }
    const url = await presignGet(jpgR2[i], 3600);
    if (!url) throw new Error(`이미지 ${i + 1} 링크 생성 실패`);
    urls.push(url);
  }
  proj.imagesJpgR2 = jpgR2;
  fs.writeFileSync(pjPath, JSON.stringify(proj));
  return urls;
}
function jgSafeUnlink(p: string) { try { fs.rmSync(p, {force: true}); } catch {} }
// 썸네일(커버)을 JPEG 공개 URL로 — 인스타 릴스 cover_url용. 우리 썸네일 PNG를 JPEG 변환·R2·presign(캐시).
async function ensureThumbJpegUrl(id: string): Promise<string> {
  if (!r2Enabled() || !/^[0-9a-f-]{36}$/.test(id)) return '';
  const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
  const pjPath = path.join(dir, 'project.json');
  let proj: any;
  try { proj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { return ''; }
  if (!proj.thumb && !proj.thumbR2) return '';
  if (!proj.thumbJpgR2) {
    const tmpPng = path.join(os.tmpdir(), `cover-${id}.png`);
    const localPng = proj.thumb ? path.join(dir, proj.thumb) : '';
    if (localPng && fs.existsSync(localPng)) fs.copyFileSync(localPng, tmpPng);
    else if (proj.thumbR2) {
      const got = await getStream(proj.thumbR2);
      if (!got) return '';
      await new Promise<void>((resolve, reject) => { const w = fs.createWriteStream(tmpPng); got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject); });
    } else return '';
    const tmpJpg = path.join(os.tmpdir(), `cover-${id}.jpg`);
    await pngToJpeg(tmpPng, tmpJpg);
    const key = videoKey(id, 'cover.jpg');
    if (!(await uploadFile(key, tmpJpg, 'image/jpeg'))) { jgSafeUnlink(tmpPng); jgSafeUnlink(tmpJpg); return ''; }
    jgSafeUnlink(tmpPng); jgSafeUnlink(tmpJpg);
    proj.thumbJpgR2 = key;
    fs.writeFileSync(pjPath, JSON.stringify(proj));
  }
  return (await presignGet(proj.thumbJpgR2, 3600)) || '';
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
type Job = {id: string; logs: string[]; done: boolean; doneAt?: number; file?: string; title?: string; error?: string; kind?: 'video' | 'post'; images?: string[]; zip?: string; projectId?: string};
// ★영상 로그(studio.ts)와 동일하게 각 줄 앞에 실시간 시각(한국시간 HH:MM:SS)을 붙인다. 프론트는 그대로 출력.
function jlog(job: Job, s: string) {
  const t = new Date().toLocaleTimeString('ko-KR', {hour12: false, timeZone: 'Asia/Seoul'});
  job.logs.push(`[${t}] ${s}`.slice(0, 500));
}
const jobs = new Map<string, Job>();
// ★모바일↔PC 실시간 동기화: 현재 진행 중인 생성 작업 id. 어느 기기든 로드 시 이걸 받아 같은 SSE에 붙는다.
let currentGenJob = '';

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
    const mine = listPortfolio().map((it) => {
      const isPost = it.kind === 'card-post';
      return {
        id: it.projectId,
        kind: 'mine' as const,
        // ★작업내역 분리용 매체 종류: video(영상)·card(카드영상)·card-post(카드 캐러셀). 없으면 video.
        media: it.kind || 'video',
        title: it.title,
        voice: it.voice,
        category: it.category,
        goal: it.goal,
        createdAt: it.createdAt,
        // ★배지: portfolio.json에 링크 없으면 project.json에서 보강(제작 화면서 바로 올린 경우도 배지 뜨게).
        youtubeUrl: it.youtubeUrl || readProjectYouTube(it.projectId),
        instagramUrl: it.instagramUrl || readProjectInstagram(it.projectId),
        orientation: it.orientation || 'portrait', // 레거시(없음)=세로 폴백
        video: isPost ? '' : `/portfolio-item/${it.projectId}.mp4`,
        images: isPost ? (it.images || []).map((_, i) => `/portfolio-card/${it.projectId}/${i + 1}.png`) : undefined,
        thumb: readProjectThumb(it.projectId).thumb ? `/portfolio-thumb/${it.projectId}.png` : '',
      };
    });
    const sampleYt = loadSampleYouTube();
    const sampleIg = loadSampleInstagram();
    const samples = SAMPLES.map((s) => ({
      id: 'sample:' + s.file,
      kind: 'sample' as const,
      media: 'video' as const,
      title: s.title,
      voice: s.voice,
      category: s.category,
      goal: s.goal,
      createdAt: '',
      youtubeUrl: sampleYt[s.file] || '',
      instagramUrl: sampleIg[s.file] || '', // 샘플도 인스타 업로드 시 R2 백필 후 배지 기록
      orientation: s.orientation || 'portrait', // 샘플은 전부 세로(9:16)
      video: `/portfolio/${s.file}`,
      thumb: '', // 샘플은 썸네일 파일 없음(영상 메타프레임 사용)
    }));
    return json(res, 200, {items: [...mine, ...samples]});
  }
  // ── 포트폴리오 썸네일(커버) 공개 서빙 — 로컬/R2 ──
  if (p.startsWith('/portfolio-thumb/')) {
    const m = p.match(/^\/portfolio-thumb\/([0-9a-f-]{36})\.png$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const item = listPortfolio().find((x) => x.projectId === m[1]);
    if (!item) { res.writeHead(404); return res.end('not found'); }
    const {thumb, thumbR2} = readProjectThumb(m[1]);
    if (!thumb) { res.writeHead(404); return res.end('not found'); }
    if (thumbR2) {
      const got = await getStream(thumbR2);
      if (!got) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': got.size, 'Cache-Control': 'public, max-age=86400'});
      return got.stream.pipe(res);
    }
    const file = path.join(STUDIO_DATA_DIR, 'studio', m[1], thumb);
    if (thumb !== path.basename(thumb) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'public, max-age=86400'});
    return fs.createReadStream(file).pipe(res);
  }
  // ── 카드 게시물(캐러셀) 이미지 공개 서빙 — 로컬/R2. /portfolio-card/{id}/{n}.png ──
  if (p.startsWith('/portfolio-card/')) {
    const m = p.match(/^\/portfolio-card\/([0-9a-f-]{36})\/(\d+)\.png$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const item = listPortfolio().find((x) => x.projectId === m[1] && x.kind === 'card-post');
    if (!item) { res.writeHead(404); return res.end('not found'); }
    const n = parseInt(m[2], 10) - 1;
    let proj: any = {};
    try { proj = JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', m[1], 'project.json'), 'utf8')); } catch {}
    const names: string[] = proj.images || [];
    const r2keys: string[] = proj.imagesR2 || [];
    if (n < 0 || n >= names.length) { res.writeHead(404); return res.end('not found'); }
    if (r2keys[n]) {
      const got = await getStream(r2keys[n]);
      if (!got) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': got.size, 'Cache-Control': 'public, max-age=86400'});
      return got.stream.pipe(res);
    }
    const file = path.join(STUDIO_DATA_DIR, 'studio', m[1], names[n]);
    if (names[n] !== path.basename(names[n]) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'public, max-age=86400'});
    return fs.createReadStream(file).pipe(res);
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
  // ── 성과 추적: 올린 유튜브 영상의 조회수·좋아요·댓글 집계(공개, voices.html이 로드) ──
  if (p === '/api/youtube/stats' && req.method === 'GET') {
    if (!youtubeStatus().connected) return json(res, 200, {connected: false, items: [], summary: null});
    const sampleYt = loadSampleYouTube();
    const all = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.youtubeUrl || readProjectYouTube(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleYt[s.file] || ''})),
    ];
    const withId = all.map((x) => ({...x, videoId: extractVideoId(x.url)})).filter((x) => x.videoId);
    if (!withId.length) return json(res, 200, {connected: true, items: [], summary: null});
    const debug = u.searchParams.get('debug');
    const diag: string[] | undefined = debug ? [] : undefined;
    let stats: Record<string, {views: number; likes: number; comments: number; shares: number}> = {};
    try { stats = await getVideoStats(withId.map((x) => x.videoId), diag); }
    catch (e: any) { return json(res, 200, {connected: true, items: [], summary: null, error: e.message, ...(diag ? {debug: [...diag, '예외:' + e.message]} : {})}); }
    const items = withId
      .map((x) => ({...x, ...(stats[x.videoId] || {views: 0, likes: 0, comments: 0, shares: 0})}))
      .sort((a, b) => b.views - a.views);
    const avgBy = (key: 'voice' | 'category') => {
      const m: Record<string, number[]> = {};
      for (const it of items) (m[(it as any)[key]] = m[(it as any)[key]] || []).push(it.views);
      return Object.entries(m)
        .map(([name, v]) => ({name, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), count: v.length}))
        .sort((a, b) => b.avg - a.avg);
    };
    const summary = {
      total: items.length,
      totalViews: items.reduce((n, x) => n + x.views, 0),
      totalLikes: items.reduce((n, x) => n + x.likes, 0),
      totalShares: items.reduce((n, x) => n + (x.shares || 0), 0),
      top3: items.slice(0, 3),
      byVoice: avgBy('voice').slice(0, 5),
      byCategory: avgBy('category').slice(0, 5),
    };
    return json(res, 200, {connected: true, items, summary, ...(diag ? {debug: diag} : {})});
  }
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
    let thumbCleanup = () => {};
    try {
      const local = await localVideoFile(src); tmpCleanup = local.cleanup;
      // 내 완성작이면 후킹 프레임 썸네일을 커버로 지정(샘플은 썸네일 없음).
      const thumb = src.kind === 'mine' ? await localThumbFile(id) : null;
      if (thumb) thumbCleanup = thumb.cleanup;
      const r = await uploadVideo(local.file, {
        title: String(b.title || src.title).slice(0, 100),
        description: String(b.description || '').slice(0, 4900),
        tags: Array.isArray(b.tags) ? b.tags.map((x: any) => String(x)).slice(0, 15) : [],
        privacy: privacy as any,
      }, thumb?.file);
      try {
        if (src.kind === 'mine') { setPortfolioYouTube(id, r.url); saveProjectYouTube(id, r.url); }
        else setSampleYouTube(path.basename(id.slice('sample:'.length)), r.url);
      } catch {}
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
    finally { tmpCleanup(); thumbCleanup(); }
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

  // ── 인스타그램 ── 연결 상태
  if (p === '/api/instagram/status' && req.method === 'GET') return json(res, 200, instagramStatus());
  // ── 인스타 업로드 현황(오늘 몇 개·마지막 게시 시각) — 페이스 모니터 ──
  if (p === '/api/instagram/activity' && req.method === 'GET') return json(res, 200, await getUploadActivity());
  // ── 오늘의 활동(제작·유튜브·인스타 각각 분리) — 대시보드 ──
  if (p === '/api/activity/today' && req.method === 'GET') {
    const sampleYt = loadSampleYouTube();
    const ytIds = [
      ...listPortfolio().map((it) => it.youtubeUrl || readProjectYouTube(it.projectId)),
      ...SAMPLES.map((s) => sampleYt[s.file] || ''),
    ].filter(Boolean).map((u) => extractVideoId(u)).filter(Boolean);
    const [youtube, instagram] = await Promise.all([getYtActivity(ytIds), getUploadActivity()]);
    return json(res, 200, {produced: todayProducedCount(), youtube, instagram});
  }
  // ── 성과 추적: 올린 인스타 영상의 조회수·좋아요·댓글 집계(공개, voices.html이 로드) ──
  if (p === '/api/instagram/stats' && req.method === 'GET') {
    const debug = u.searchParams.get('debug') === '1';
    const diag: string[] | undefined = debug ? [] : undefined;
    if (!instagramStatus().connected) return json(res, 200, {connected: false, items: [], summary: null, ...(debug ? {debug: ['연결 안 됨(status)']} : {})});
    const sampleIg = loadSampleInstagram();
    const all = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.instagramUrl || readProjectInstagram(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleIg[s.file] || ''})),
    ];
    const withUrl = all.filter((x) => x.url);
    if (!withUrl.length) return json(res, 200, {connected: true, items: [], summary: null, ...(debug ? {debug: ['올린 영상 중 instagramUrl(permalink) 저장된 게 없음']} : {})});
    let byPermalink: Record<string, {views: number; likes: number; comments: number}> = {};
    try { byPermalink = await getInstaStats(diag); }
    catch (e: any) { return json(res, 200, {connected: true, items: [], summary: null, error: e.message, ...(debug ? {debug: [...(diag || []), '예외: ' + e.message]} : {})}); }
    if (diag) {
      const apiKeys = Object.keys(byPermalink);
      diag.push(`우리가 저장한 permalink ${withUrl.length}개: ${withUrl.map((x) => x.url).slice(0, 5).join(' , ')}`);
      diag.push(`Meta가 돌려준 permalink ${apiKeys.length}개: ${apiKeys.slice(0, 5).join(' , ')}`);
      const matched = withUrl.filter((x) => byPermalink[x.url]).length;
      diag.push(`permalink 매칭 성공 ${matched}/${withUrl.length}개 (0이면 키 불일치)`);
    }
    const items = withUrl
      .map((x) => ({...x, ...(byPermalink[x.url] || {views: 0, likes: 0, comments: 0})}))
      .sort((a, b) => b.views - a.views || b.likes - a.likes);
    const avgBy = (key: 'voice' | 'category') => {
      const m: Record<string, number[]> = {};
      for (const it of items) (m[(it as any)[key]] = m[(it as any)[key]] || []).push(it.views || it.likes);
      return Object.entries(m)
        .map(([name, v]) => ({name, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), count: v.length}))
        .sort((a, b) => b.avg - a.avg);
    };
    const summary = {
      total: items.length,
      totalViews: items.reduce((n, x) => n + x.views, 0),
      totalLikes: items.reduce((n, x) => n + x.likes, 0),
      top3: items.slice(0, 3),
      byVoice: avgBy('voice').slice(0, 5),
      byCategory: avgBy('category').slice(0, 5),
    };
    return json(res, 200, {connected: true, items, summary, ...(debug ? {debug: diag} : {})});
  }
  // 인스타 연결(계정 ID + 토큰 저장, 유효성 검증)
  if (p === '/api/instagram/connect' && req.method === 'POST') {
    const b = await readBody(req);
    const igUserId = String(b.igUserId || '').trim();
    const accessToken = String(b.accessToken || '').trim();
    const base = b.base === 'facebook' ? 'facebook' : 'instagram';
    if (!igUserId || !accessToken) return json(res, 400, {error: '인스타 계정 ID와 액세스 토큰을 입력하세요.'});
    try {
      const username = await verifyInstagram({igUserId, accessToken, base});
      saveInstagram({igUserId, accessToken, base, username, tokenSavedAt: Date.now()});
      return json(res, 200, {connected: true, username});
    } catch (e: any) { return json(res, 400, {error: e.message}); }
  }
  // 카드 게시물(캐러셀) 인스타 업로드 — JPEG 변환 후 publishCarousel.
  if (p.startsWith('/api/instagram/upload-carousel/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/instagram/upload-carousel/'.length));
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '올릴 수 없는 항목입니다.'});
    const item = listPortfolio().find((x) => x.projectId === id && x.kind === 'card-post');
    if (!item) return json(res, 404, {error: '카드 게시물을 찾을 수 없습니다.'});
    if (!instagramStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 인스타 계정을 연결하세요.'});
    const b = await readBody(req);
    const caption = String(b.caption || '').trim();
    try {
      const urls = await ensureCarouselJpegUrls(id, () => {});
      const r = await publishCarousel(urls, caption);
      if (r.permalink) { setPortfolioInstagram(id, r.permalink); saveProjectInstagram(id, r.permalink); }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }
  // 인스타 캡션 자동 생성(영상 제목·나레이션 기반, 해시태그 포함) — 카드 게시물도 지원.
  if (p.startsWith('/api/instagram/caption/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/instagram/caption/'.length));
    const src = resolveVideo(id);
    const meta = src ? {title: src.title, narrations: src.narrations} : cardPostMeta(id);
    if (!meta) return json(res, 404, {error: '항목을 찾을 수 없습니다.'});
    const k = pipelineKeys();
    try {
      const caption = await generateCaption({gemini: k.gemini, openai: k.openai}, meta.title, meta.narrations);
      return json(res, 200, {caption});
    } catch (e: any) { return json(res, 502, {error: '캡션 생성 실패: ' + e.message}); }
  }
  // 인스타 업로드(릴스/피드) — 완성 영상이 R2에 있어야 함(공개 presigned URL 필요)
  if (p.startsWith('/api/instagram/upload/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/instagram/upload/'.length));
    const isSample = id.startsWith('sample:');
    if (!isSample && !/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '올릴 수 없는 영상입니다.'});
    if (!instagramStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 인스타 계정을 연결하세요.'});
    const r2key = await ensureInstaVideoR2(id); // 내 완성작/샘플 모두 R2에 없으면 백필 후 진행
    if (!r2key) return json(res, 400, {error: '영상 파일을 찾을 수 없어요. 너무 오래돼 정리됐을 수 있어요 — 다시 제작해 주세요.'});
    const b = await readBody(req);
    const kind = b.kind === 'feed' ? 'feed' : 'reels';
    const caption = String(b.caption || '').trim();
    try {
      const url = await presignGet(r2key, 3600);
      if (!url) return json(res, 502, {error: '영상 임시 링크 생성 실패.'});
      // ★커버 지정(내 완성작만) — 빈 썸네일 방지. 실패해도 업로드는 진행.
      let coverUrl: string | undefined;
      if (!isSample) { try { coverUrl = (await ensureThumbJpegUrl(id)) || undefined; } catch {} }
      const r = await publishVideo(url, caption, kind as 'reels' | 'feed', undefined, coverUrl);
      // ★배지: 게시 성공 시 permalink 기록(어느 경로든 IG 배지 뜨게). 샘플/내작품 분기.
      if (r.permalink) {
        if (isSample) setSampleInstagram(path.basename(id.slice('sample:'.length)), r.permalink);
        else { setPortfolioInstagram(id, r.permalink); saveProjectInstagram(id, r.permalink); }
      }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }

  // ── 포트폴리오 삭제(관리, 로그인 필요) ──
  if (p.startsWith('/api/portfolio/') && req.method === 'DELETE') {
    const id = p.slice('/api/portfolio/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    removePortfolio(id);
    return json(res, 200, {ok: true});
  }

  if (await handleStudio(req, res, p)) return;

  // ── 캐릭터 풀: 목록 ── (애니 영상에 쓸 주인공. 기본 캐릭터 + 내가 만든 캐릭터)
  if (p === '/api/characters' && req.method === 'GET') {
    return json(res, 200, {characters: listCharacters().map(c => ({id: c.id, name: c.name, emoji: c.emoji, builtin: c.builtin}))});
  }
  // 캐릭터 썸네일 이미지
  if (p.startsWith('/api/characters/') && p.endsWith('/image') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/image'.length));
    const file = characterImagePath(id);
    if (!file) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(file);
    res.writeHead(200, {'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400'});
    return res.end(buf);
  }
  // 캐릭터 만들기(묘사 → nano-banana 생성)
  if (p === '/api/characters' && req.method === 'POST') {
    const k = pipelineKeys();
    if (!k.replicate) return json(res, 400, {error: '키 설정에서 Replicate 키를 저장하세요.'});
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const desc = String(b.description || '').trim();
    if (!desc) return json(res, 400, {error: '캐릭터 설명을 입력하세요(예: 곱슬머리 남자아이, 파란 멜빵바지).'});
    try {
      const c = await createCharacter(k.replicate, name, desc);
      return json(res, 201, {id: c.id, name: c.name, emoji: c.emoji, builtin: false});
    } catch (e: any) { return json(res, 502, {error: '캐릭터 생성 실패: ' + e.message}); }
  }
  // 캐릭터 삭제(내가 만든 것만)
  if (p.startsWith('/api/characters/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/characters/'.length));
    return json(res, 200, {ok: deleteCharacter(id)});
  }

  // ── 주제 추천(링크·이미지 없이): 카테고리별로 요즘 잘 되는 주제 후보 ──
  if (p === '/api/topics' && req.method === 'GET') {
    const presetId = u.searchParams.get('preset') || '';
    const preset = PRESETS.find((x) => x.id === presetId);
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '키 설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    // ★주제추천은 '제작을 결정하는 그 preset'에서 직접 뽑는다(톤·훅·주제영역 주입).
    //   → 카테고리(제작 느낌)와 추천 주제가 어긋나던 이원화 근본 해소. preset 없을 때만 범용 실용 기본값.
    const prompt = preset?.anime
      ? `너는 아이와 어른이 함께 보며 시간 가는 줄 모르는 애니메이션 영상을 기획하는 전문가다. "${preset.label}" 카테고리에 "정확히 들어맞는", 아이에게 실제로 유익하고 어른도 "이건 보여줘야겠다" 싶은 이야기 "주제" 8개를 제안하라.

[이 카테고리의 성격 — 주제가 반드시 이 결에 맞아야 한다]
- 이야기 톤: ${preset.toneGuide}
- 주제 영역(이 안에서만 뽑아라): ${preset.topicGuide}

[원칙]
- 아이에게 진짜 도움이 되고(배움·안전·마음), 어른이 함께 봐도 흐뭇한 것. 따뜻하고 희망적으로(겁주기·자극·무서움 과하지 않게).
- 제목은 아이도 어른도 궁금해지는 다정한 한 줄. 막연하지 말고 구체적으로.
- 정치·종교·폭력·선정성·공포 조장 제외.

JSON만 출력: {"topics":[{"title":"...","why":"왜 좋은지 10자 이내"}]}`
      : preset
      ? `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자다. 이 영상의 카테고리는 **"${preset.group} · ${preset.label}"** 한 분야다. 이 분야에 "정확히 들어맞는" 쇼츠 "주제" 8개를 제안하라. ★다른 분야 주제는 절대 섞지 마라.

[이 카테고리의 성격 — 주제가 반드시 이 결에 맞아야 한다]
- 이야기 톤: ${preset.toneGuide}
- 후킹 방식: ${preset.hookStyle}
- 주제 영역(이 안에서만 뽑아라): ${preset.topicGuide}

[공통 품질 원칙]
- 막연·일반론 절대 금지. 아주 구체적이어야 한다.
- 대상이 있는 분야(여행·명소·맛집·장소·인물·제품 등)는 반드시 "실제 고유명사"를 콕 집어라. 막연히 "이곳·여기"로 끝나는 주제 금지.
- 제목(title)은 클릭·시청을 부르는 후킹형 한 줄: 궁금증 갭·손실 회피·숫자·반전 중 하나를 위 '후킹 방식'에 맞춰 꽂아라. 밋밋하면 실패.
- 정치·종교·자극·혐오 제외.

JSON만 출력: {"topics":[{"title":"...","why":"왜 이 카테고리에 딱인지 10자 이내"}]}`
      : `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자다. "건강·헬시 꿀팁, 핫한 생활정보, 요리 레시피 등 저장·공유가 폭발하는 실용 분야"에서 지금 조회수가 폭발하고 저장·공유·완주율이 높은 쇼츠 "주제" 8개를 제안하라.

[주제 선정 원칙]
- 저장하고 싶은 실용성(바로 써먹는 꿀팁·레시피·건강법)과 안 보면 손해인 호기심을 동시에 자극.
- 막연·일반론 절대 금지. 아주 구체적이어야 한다. (X "건강에 좋은 음식" / O "자기 전에 이거 한 숟갈, 아침이 달라집니다")
- ★대상이 있는 분야(여행·명소·맛집·장소·인물·제품 등)는 반드시 "실제 고유명사"를 콕 집어라. (X "숨겨진 여행 명소" / O "포르투갈 신트라, 동화 속 이 성") 막연히 "이곳·여기"로 끝나는 주제 금지.
- 숫자·반전·의외의 사실·흔한 오해 깨기를 적극 활용. 특히 건강/헬시 꿀팁, 남들 모르는 핫한 생활정보, 따라하기 쉬운 레시피를 많이 섞어라.
[제목(title)]
- 클릭·시청을 부르는 후킹형 한 줄: 궁금증 갭("아무도 안 알려주는~"), 손실 회피("모르면 손해인~"), 숫자·반전 중 하나를 꽂아라. 밋밋하면 실패.
- 정치·종교·자극·혐오 제외.

JSON만 출력: {"topics":[{"title":"...","why":"왜 터지는지 10자 이내"}]}`;
    // ★마크다운 별표(**강조**·*·리스트마커) 제거 — LLM이 넣은 별표가 화면에 그대로 노출되던 문제.
    const clean = (s: any) => String(s || '').replace(/\*+/g, '').replace(/^\s*[-#>]+\s*/, '').replace(/`/g, '').trim();
    // ★LLM(Gemini)이 고온도에서 가끔 깨진 JSON(문자열 내 따옴표 미escape 등)을 뱉어 "Expected ',' or '}'"로
    //   터지던 간헐 오류 → 파싱 실패해도 조용히 재생성(최대 3회, 재시도는 저온도로 JSON 안정화). 코드펜스도 제거.
    const extractTopics = (raw: string): {title: string; why: string}[] | null => {
      let s = String(raw || '').trim();
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const data = JSON.parse(m[0]); // 실패하면 바깥 catch가 잡아 다음 시도로
      return (Array.isArray(data.topics) ? data.topics : []).slice(0, 8)
        .map((t: any) => ({title: clean(t.title), why: clean(t.why)}))
        .filter((t: any) => t.title);
    };
    let lastErr = '빈 응답';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let raw = '';
        if (k.gemini.length) {
          try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 1024, temperature: attempt === 0 ? 1.1 : 0.7}); }
          catch (e: any) { lastErr = e?.message || '생성 실패'; }
        }
        if (!raw && k.openai) raw = await openaiJson(k.openai, prompt, 1024);
        const topics = extractTopics(raw);
        if (topics && topics.length) return json(res, 200, {topics});
        lastErr = raw ? 'JSON 파싱 실패' : lastErr;
      } catch (e: any) { lastErr = e?.message || 'JSON 파싱 실패'; }
    }
    return json(res, 502, {error: '주제 추천 실패(재시도 후): ' + lastErr});
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
        anime: x.anime || false,
        recommendStyle: RECOMMEND_STYLE[x.id] || 'real',
      })),
      styles: STYLES.map((s) => ({id: s.id, name: s.name, emoji: s.emoji, desc: s.desc, group: s.group})),
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
        runpod: !!e.RUNPOD_API_KEY,
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
      RUNPOD_API_KEY: maskKey(e.RUNPOD_API_KEY),
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    saveEnv(b);
    return json(res, 200, {ok: true});
  }

  // ── RunPod 현황(움직이는 영상 GPU) — 잔액 + 실행 중 팟. 설정 화면에서 조회. ──
  if (p === '/api/runpod/status' && req.method === 'GET') {
    const e = loadEnv();
    if (!e.RUNPOD_API_KEY) return json(res, 200, {configured: false});
    const st = await runpodStatus(e.RUNPOD_API_KEY);
    return json(res, 200, {configured: true, balance: st.balance, pods: st.pods});
  }
  // 수동 "지금 끄기" — 실행 중인 모든 움직이는-영상 팟 종료(과금 중단).
  if (p === '/api/runpod/stop' && req.method === 'POST') {
    const e = loadEnv();
    if (!e.RUNPOD_API_KEY) return json(res, 400, {error: 'RunPod 키가 없습니다.'});
    try { const ids = await stopAllWanPods(e.RUNPOD_API_KEY); return json(res, 200, {stopped: ids}); }
    catch (err: any) { return json(res, 502, {error: err?.message || '종료 실패'}); }
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
      anime: '옛날 옛날, 깊은 숲속에 호기심 많은 아기 여우가 살았어요. 어느 날, 반짝이는 별님이 하늘에서 뚝 떨어졌지 뭐예요!',
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
    currentGenJob = id;

    // 백그라운드 실행
    (async () => {
      try {
        const r = await makeVideo([url], k, {
          duration: Number(b.duration) || 30,
          presetId: b.presetId || undefined,
          voice: b.voice || undefined,
          quality: b.quality === 'fast' ? 'fast' : 'high',
          // ★전체 스타일 허용(실사·애니·고전 등 15종). 예전엔 real/anime로 뭉개 다른 스타일이 안 먹었음.
          imageStyle: STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real',
          aiClips: Number(b.aiClips) || 0,
          autoShutdown: b.autoShutdown !== false, // 기본 자동 종료(과금 방지)
          log: (m) => jlog(job, m),
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
        job.done = true; job.doneAt = Date.now();
        jlog(job, `[완료] 바탕화면에도 저장됨: ${folder}`);
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
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
    currentGenJob = id;

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
          log: (m) => jlog(job, m),
        });
        const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
        const today = new Date().toLocaleDateString('sv-SE');
        const folder = path.join(os.homedir(), 'Desktop', `온비디오 ${today}`, safe);
        fs.mkdirSync(folder, {recursive: true});
        fs.copyFileSync(r.out, path.join(folder, `${safe}.mp4`));
        job.file = path.basename(r.out);
        job.title = r.title;
        job.done = true; job.doneAt = Date.now();
        jlog(job, `[완료] 바탕화면에도 저장됨: ${folder}`);
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    })();

    return json(res, 202, {id});
  }

  // ── 카드뉴스 생성 ──
  // ── 카드 대본만 생성(편집용) — 렌더 전에 문구를 고칠 수 있게 텍스트만 빠르게 반환 ──
  if (p === '/api/card-plan' && req.method === 'POST') {
    const b = await readBody(req);
    const topic = String(b.topic || '').trim();
    if (!topic) return json(res, 400, {error: '주제를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const style = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';
    try {
      const sb = await generateCardStoryboard(
        {gemini: k.gemini, openai: k.openai},
        topic,
        Number(b.count) || 7,
        b.presetId ? getPreset(String(b.presetId)) : undefined,
        style,
      );
      return json(res, 200, {storyboard: sb});
    } catch (e: any) {
      return json(res, 502, {error: '카드 대본 생성 실패: ' + e.message});
    }
  }

  if (p === '/api/generate-cards' && req.method === 'POST') {
    const b = await readBody(req);
    const topic = String(b.topic || '').trim();
    if (!topic) return json(res, 400, {error: '주제를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const output = b.output === 'post' ? 'post' : 'video';
    const bg = ['ai', 'solid', 'upload'].includes(b.bg) ? b.bg : 'solid';
    const narration = output === 'video' && b.narration === true;
    const bgm = output === 'video' && b.bgm === true;
    if ((narration || bgm) && !k.elevenlabs) return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다.'});
    if (bg === 'ai' && !k.replicate) return json(res, 400, {error: 'AI 배경을 쓰려면 Replicate 키가 필요합니다.'});

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);
    currentGenJob = id;
    (async () => {
      try {
        // 업로드 배경(dataURL) 저장.
        let uploads: string[] | undefined;
        if (bg === 'upload' && Array.isArray(b.images) && b.images.length) {
          const upDir = path.join(ROOT, 'public', 'uploads', 'card-' + id);
          fs.mkdirSync(upDir, {recursive: true});
          uploads = [];
          b.images.slice(0, 12).forEach((durl: string, i: number) => {
            const m = String(durl).match(/^data:(image\/\w+);base64,(.+)$/);
            if (!m) return;
            const ext = m[1] === 'image/png' ? 'png' : 'jpg';
            fs.writeFileSync(path.join(upDir, `u-${i}.${ext}`), Buffer.from(m[2], 'base64'));
            uploads!.push(`uploads/card-${id}/u-${i}.${ext}`);
          });
        }
        const r = await makeCardVideo(k, {
          topic,
          count: Number(b.count) || 7,
          presetId: b.presetId || undefined,
          output, bg, uploads,
          narration, bgm,
          voice: b.voice || undefined,
          imageStyle: STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real',
          cardTheme: b.cardTheme === 'dark' ? 'dark' : 'light',
          motion: ['pop', 'slide', 'type', 'zoom', 'flip'].includes(b.motion) ? b.motion : 'auto',
          // 대본편집: 사용자가 고친 대본이 오면 그대로 제작(검증 후).
          storyboard: sanitizeCardStoryboard(b.storyboard),
          log: (m) => jlog(job, m),
        });
        // 바탕화면 저장은 선택(로컬에서만, 실패해도 무시 — Railway엔 Desktop 없음).
        try {
          const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
          const today = new Date().toLocaleDateString('sv-SE');
          const folder = path.join(os.homedir(), 'Desktop', `온비디오 카드 ${today}`, safe);
          fs.mkdirSync(folder, {recursive: true});
          fs.copyFileSync(r.out, path.join(folder, path.basename(r.out)));
          jlog(job, `[완료] 바탕화면에도 저장됨: ${folder}`);
        } catch { /* Railway 등 Desktop 없는 환경 — 무시 */ }
        job.kind = r.kind;
        if (r.kind === 'post') { job.zip = path.basename(r.out); job.images = r.images; }
        else job.file = path.basename(r.out);
        job.title = r.title;
        job.projectId = r.projectId; // 포트폴리오 등록 id(카드 작업내역·업로드에 사용)
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    })();
    return json(res, 202, {id});
  }

  // ── 현재 진행 중 작업(모바일↔PC 공유) — 어느 기기든 이걸 받아 같은 SSE에 붙어 실시간으로 같이 본다 ──
  if (p === '/api/jobs/current' && req.method === 'GET') {
    const j = currentGenJob ? jobs.get(currentGenJob) : undefined;
    if (!j) return json(res, 200, {id: null});
    if (!j.done) return json(res, 200, {id: currentGenJob});
    // ★완료됐으면 최근(30분 내) 결과를 다른 기기도 바로 볼 수 있게 함께 넘긴다(PC↔모바일 완성본 연동).
    const fresh = j.doneAt && Date.now() - j.doneAt < 30 * 60 * 1000;
    return json(res, 200, {
      id: null,
      done: fresh && !j.error ? {id: j.id, file: j.file, title: j.title, projectId: j.projectId, kind: j.kind, images: j.images, zip: j.zip} : null,
    });
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
    let lastWrite = Date.now();
    const timer = setInterval(() => {
      let wrote = false;
      while (sent < job.logs.length) {
        res.write(`data: ${JSON.stringify({log: job.logs[sent]})}\n\n`);
        sent++;
        wrote = true;
      }
      // ★heartbeat — 움직이는 AI 영상(RunPod 팟 부팅) 등으로 새 로그 없이 몇 분씩 조용할 때
      //   연결이 idle로 끊기지 않게 15초마다 주석 핑을 보낸다(EventSource는 ':' 줄 무시).
      if (wrote) lastWrite = Date.now();
      else if (Date.now() - lastWrite > 15000) { res.write(': ping\n\n'); lastWrite = Date.now(); }
      if (job.done) {
        res.write(
          `data: ${JSON.stringify({done: true, file: job.file, title: job.title, error: job.error, kind: job.kind, images: job.images, zip: job.zip, projectId: job.projectId})}\n\n`,
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
  // ── 카드 캐러셀 ZIP 다운로드 ──
  if (p.startsWith('/api/cards-zip/')) {
    const name = path.basename(p);
    if (!/^cards-[\w-]+\.zip$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(OUT_DIR, name);
    if (!fs.existsSync(file)) return json(res, 404, {error: 'not found'});
    const buf = fs.readFileSync(file);
    res.writeHead(200, {'Content-Type': 'application/zip', 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${name}"`});
    return res.end(buf);
  }
  // ── 카드 이미지 미리보기(게시물) — public/jobs/card-*/card-N.png ──
  if (p.startsWith('/api/card-img/')) {
    const rel = decodeURIComponent(p.replace('/api/card-img/', ''));
    if (!/^jobs\/card-[\w-]+\/card-\d+\.png$/.test(rel)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(ROOT, 'public', rel);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(file);
    res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600'});
    return res.end(buf);
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n🎬 OnVideo 웹 → http://localhost:${PORT}\n`);
  // 인스타 토큰 자동 갱신: 부팅 시 1회 + 24시간마다(45일 넘으면 ig_refresh_token으로 연장 → 재발급 불필요).
  const igRefresh = () => maybeRefreshInstagram((m) => console.log(m)).catch(() => {});
  igRefresh();
  setInterval(igRefresh, 24 * 60 * 60 * 1000);
});
