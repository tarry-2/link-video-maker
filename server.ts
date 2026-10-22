// OnVideo 웹 서버 — 브라우저에서 링크→카테고리→영상 생성. 단일 사용자 로컬 앱.
import http from 'node:http';
import {handleStudio, todayProducedCount, studio} from './lib/studio-http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHmac, timingSafeEqual, scryptSync, randomBytes} from 'node:crypto';
import {execFileSync as cpExecFileSync} from 'node:child_process';
import {makeVideo} from './lib/pipeline';
import {generateStoryboard, type Storyboard} from './lib/script';
import {registerVideoToPortfolio} from './lib/video-portfolio';
import {makeVideoManual} from './lib/manual';
import {makeCardVideo, cardEditInfo, reRenderCard} from './lib/card-pipeline';
import {makeHighlights, backfillHighlightProjects, reRenderHighlight, loadHlProject, suggestNarration} from './lib/youtube-highlight';
import {searchArchiveChannel, sampleForAnalysis, fetchSourceTranscript, updateYtdlp, ytdlpVersion} from './lib/youtube-clip';
import {analyzeReframe} from './lib/reframe';
import {getTrends} from './lib/trends';
import {generateCardStoryboard, generateShoppingStoryboard} from './lib/cards';
import {PRESETS, RECOMMEND_STYLE, getPreset} from './lib/presets';
import {STYLES, STYLE_IDS} from './lib/styles';
import {runpodStatus, stopAllWanPods} from './lib/runpod-wan';
import {VOICES, ttsEleven} from './lib/tts';
import {geminiGenerate} from './lib/gemini';
import {openaiJson} from './lib/openai';
import {loadEnv, saveEnv, pipelineKeys, maskKey} from './lib/keys';
import {listPortfolio, removePortfolio, updatePortfolioTitle, addPortfolio, setPortfolioYouTube, setSampleYouTube, loadSampleYouTube, setPortfolioInstagram, setSampleInstagram, loadSampleInstagram, setPortfolioFacebook, setSampleFacebook, loadSampleFacebook, setPortfolioThreads, setSampleThreads, loadSampleThreads, setPortfolioProduct, loadSampleR2, setSampleR2, SAMPLES} from './lib/portfolio';
import {youtubeStatus, saveYouTube, removeYouTube, renameYouTube, authUrl, exchangeCode, generateMeta, uploadVideo, extractVideoId, getVideoStats, getChannelVideos, getUploadActivity as getYtActivity, searchCreativeCommons, getVideoMeta} from './lib/youtube';
import {getStream, presignGet, uploadFile, videoKey, r2Enabled, deleteKey as deleteR2Key, listKeys, head as r2Head} from './lib/storage';
import {listCharacters, characterImagePath, createCharacter, deleteCharacter} from './lib/characters';
import {instagramStatus, addInstagram, removeInstagram, renameInstagram, listInstagram, verifyInstagram, publishVideo, publishCarousel, loadInstagram, generateCaption, maybeRefreshInstagram, getInstaStats, getUploadActivity} from './lib/instagram';
import {facebookStatus, addFacebook, removeFacebook, renameFacebook, listFacebook, verifyFacebook, publishVideo as fbPublishVideo, publishPhotos as fbPublishPhotos, getFbStats, getUploadActivity as getFbActivity} from './lib/facebook';
import {threadsStatus, removeThreads, renameThreads, publishVideo as thPublishVideo, publishText as thPublishText, publishImage as thPublishImage, getThreadsStats, getUploadActivity as getThActivity, maybeRefreshThreads, saveThreadsClient, threadsAuthUrl, exchangeThreadsCode} from './lib/threads';
import {generateImageSmart} from './lib/image';
import {resolveProduct} from './lib/partner';
import {pngToJpeg} from './lib/img-util';

const PORT = Number(process.env.PORT) || 4000;
const ROOT = process.cwd();
const STUDIO_DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(ROOT, 'data');
// 부팅 시 저장해둔 유튜브 쿠키가 있으면 yt-dlp가 쓰도록 경로 지정(재배포해도 볼륨에 유지).
try { const _ck = path.join(STUDIO_DATA_DIR, 'yt-cookies.txt'); if (!process.env.YT_COOKIES_FILE && fs.existsSync(_ck)) process.env.YT_COOKIES_FILE = _ck; } catch {}
// .env의 FFMPEG/FFPROBE 경로를 process.env에 주입 — raw ffmpeg(img-util 등)가 PATH 없이도 쓰게.
try { const _e = loadEnv(); if (_e.FFMPEG_PATH && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = _e.FFMPEG_PATH; if (_e.FFPROBE_PATH && !process.env.FFPROBE_PATH) process.env.FFPROBE_PATH = _e.FFPROBE_PATH; } catch {}
const OUT_DIR = path.join(ROOT, 'out');
const SAMPLE_DIR = path.join(ROOT, 'public', 'voice-samples');

// 사용자가 고를 수 있는 제목 폰트(Scene.tsx TITLE_FONTS·web UI와 동일 목록). 외부 입력 검증용.
const TITLE_FONTS = new Set([
  'Black Han Sans', 'Jua', 'Do Hyeon', 'Gothic A1',
  'Noto Sans KR', 'Noto Serif KR', 'Gowun Batang', 'Gaegu', 'Song Myung',
]);
const pickFont = (v: unknown): string | undefined => (typeof v === 'string' && TITLE_FONTS.has(v) ? v : undefined);

// ── 로그인(비번) ──
// ADMIN_PASSWORD 환경변수 있으면 로그인 필수, 없으면(로컬 개발) 로그인 생략.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.APP_SECRET || 'onvideo-dev-secret-change-me';
const COOKIE = 'onvideo_sess';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30일(초). 긴 제작 중 세션 끊김 방지.
function sign(v: string) {
  return createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
}

// ── 비밀번호 변경 지원 ──
// 비번은 두 소스 중 하나. ①사용자가 '키설정'에서 바꾼 비번 = data 볼륨에 scrypt 해시로 저장(평문 저장 안 함)
//   ②환경변수 ADMIN_PASSWORD = '마스터 복구 비번'으로 항상 유효(바꾼 비번을 까먹어도 이걸로 들어가 재설정).
//   재배포해도(볼륨 유지) 바꾼 비번이 살아있고, 로그인·게이트·세션갱신 전부 '같은 소스(verifyPassword)'를 본다.
const PW_FILE = path.join(STUDIO_DATA_DIR, 'admin-pw.json');
function storedPw(): {salt: string; hash: string} | null {
  try { if (fs.existsSync(PW_FILE)) return JSON.parse(fs.readFileSync(PW_FILE, 'utf8')); } catch {}
  return null;
}
// 비번이 '설정되어 있는가'(저장 비번 or env 초기값). false면 로컬 개발로 보고 로그인 생략.
function passwordSet(): boolean { return !!(storedPw() || ADMIN_PASSWORD); }
// 입력 비번이 맞는지 — ①사용자가 바꾼 저장 비번(scrypt) 또는 ②env ADMIN_PASSWORD(마스터 복구 비번) 중
//   하나라도 맞으면 통과. ★env는 '항상 유효한 복구용'으로 남긴다 — 바꾼 비번을 까먹어도 Railway의
//   ADMIN_PASSWORD로 로그인해 재설정할 수 있어야 하기 때문(비번 영구 분실=서비스 잠김 사고 방지).
//   둘 다 timing-safe 비교. 저장 비번이 없으면 env만으로 판단.
function verifyPassword(input: string): boolean {
  const st = storedPw();
  if (st) {
    try {
      const got = scryptSync(String(input), Buffer.from(st.salt, 'hex'), 32);
      const exp = Buffer.from(st.hash, 'hex');
      if (got.length === exp.length && timingSafeEqual(got, exp)) return true;
    } catch {}
  }
  if (ADMIN_PASSWORD) { // 마스터 복구 비번(저장 비번과 무관하게 항상 허용)
    const a = Buffer.from(String(input)); const exp = Buffer.from(ADMIN_PASSWORD);
    if (a.length === exp.length && timingSafeEqual(a, exp)) return true;
  }
  return false;
}
// 새 비번 저장(scrypt 해시). 저장 후 이 비번으로 로그인되며, env ADMIN_PASSWORD는 복구용으로 계속 유효.
function setPassword(next: string): void {
  const salt = randomBytes(16);
  const hash = scryptSync(String(next), salt, 32);
  try { fs.mkdirSync(STUDIO_DATA_DIR, {recursive: true}); } catch {}
  fs.writeFileSync(PW_FILE, JSON.stringify({salt: salt.toString('hex'), hash: hash.toString('hex')}));
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
  if (!passwordSet()) return true; // 비번 미설정(로컬) = 통과
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
  let proj: any = null;
  try { if (fs.existsSync(pjPath)) proj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch {}
  if (proj && proj.status === 'completed' && proj.output && proj.output === path.basename(proj.output)) {
    const file = path.join(dir, proj.output);
    // 로컬에 없고 R2에만 있으면 r2key로 표시(유튜브 업로드 시 임시 다운로드).
    if (fs.existsSync(file) || proj.outputR2) {
      const narrations = (proj.scenes || []).map((s: any) => s.narration || '');
      const durSec = (proj.scenes || []).reduce((n: number, s: any) => n + (s.voice?.frames || 0), 0) / 30 || proj.input?.duration || 30;
      return {kind: 'mine', file, r2key: fs.existsSync(file) ? undefined : proj.outputR2, title: proj.title, narrations, durSec};
    }
  }
  // ★project.json이 깨졌어도(렌더 중 볼륨 ENOSPC로 쓰기 실패 등) 포트폴리오 항목 + 결정적 R2 키로 복원해
  //   업로드가 가능하게 한다(서빙과 동일 원칙). 파일이 R2에 있으면 '영상을 찾을 수 없다'가 안 난다.
  const item = listPortfolio().find((x) => x.projectId === id && x.kind !== 'card-post');
  if (item && item.output && item.output === path.basename(item.output) && r2Enabled()) {
    const file = path.join(dir, item.output);
    const r2key = videoKey(id, item.output);
    return {kind: 'mine', file, r2key: fs.existsSync(file) ? undefined : r2key, title: item.title, narrations: [], durSec: 30};
  }
  return null;
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
    let proj: any = {};
    try { proj = JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')); } catch {}
    const local = proj.thumb ? path.join(STUDIO_DATA_DIR, 'studio', projectId, proj.thumb) : '';
    if (local && fs.existsSync(local)) return {file: local, cleanup: () => {}};
    // ★project.json이 깨졌어도 R2의 표준 썸네일(thumb.png/cover.jpg)을 결정적으로 찾아 커버로 사용.
    let thumbR2 = proj.thumbR2 || '';
    if (!thumbR2 && r2Enabled()) {
      for (const cand of ['thumb.png', 'cover.jpg']) {
        const k = videoKey(projectId, cand);
        if (await r2Head(k)) { thumbR2 = k; break; }
      }
    }
    if (!thumbR2) return null;
    const tmp = path.join(os.tmpdir(), `thumb-${randomUUID()}.png`);
    const got = await getStream(thumbR2);
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
// ── 페이스북 링크도 동일 방식으로 project.json에 보강(배지 안정화) ──
function saveProjectFacebook(projectId: string, url: string) {
  try {
    const pj = path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json');
    const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    proj.facebookUrl = url;
    fs.writeFileSync(pj, JSON.stringify(proj));
  } catch {}
}
function readProjectFacebook(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).facebookUrl || '';
  } catch { return ''; }
}
// ── 스레드 링크도 동일 방식으로 project.json에 보강(배지 안정화) ──
function saveProjectThreads(projectId: string, url: string) {
  try {
    const pj = path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json');
    const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
    proj.threadsUrl = url;
    fs.writeFileSync(pj, JSON.stringify(proj));
  } catch {}
}
function readProjectThreads(projectId: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_DATA_DIR, 'studio', projectId, 'project.json'), 'utf8')).threadsUrl || '';
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
    // ★project.json이 깨졌어도 resolveVideo가 포트폴리오 output으로 재구성한 결정적 R2 키를 쓴다.
    //   (유튜브는 되는데 인스타만 '파일 못 찾음' 나던 원인 — 인스타 경로가 이 키를 안 썼다.)
    let key = readProjectOutputR2(id) || src.r2key || '';
    if (key && (await r2Head(key))) return key;
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
// 출처에서 원본 도메인(URL)만 제거 — 채널명·CC 표기는 남기고 링크만 뺀다(테리: 원본으로 트래픽 유출 방지).
//   "출처: MBC 음악캠프 — https://youtu.be/xxx (Creative Commons BY)" → "출처: MBC 음악캠프 (Creative Commons BY)".
//   생성부(youtube-highlight)에서 이미 URL을 안 넣지만, 기존 저장값(URL 포함)도 읽을 때 떼어 모든 진입점 통일.
function stripAttrUrl(s: string): string {
  return s.replace(/\s*[—–-]\s*https?:\/\/\S+/gi, '').replace(/[ \t]{2,}/g, ' ').trim();
}
// 쇼핑 쇼츠의 구매 링크 블록 — 발송 캡션/설명 끝에 붙인다(제휴 고지 포함, FTC). 포폴에 저장된 productUrl 사용.
//   도메인(링크)을 '여기선' 일부러 넣는다 — 쇼핑은 링크로 사는 게 목적(출처와 반대).
function readProductCta(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) return '';
  try {
    const it = listPortfolio().find((x) => x.projectId === id);
    if (it?.productUrl) {
      const name = it.productName ? `${it.productName} ` : '';
      return `🛒 ${name}구매하기 👉 ${it.productUrl}\n※ 이 게시물은 제휴 활동의 일환으로 수수료를 받을 수 있습니다.`;
    }
  } catch {}
  return '';
}

// ── 성과 요약 공용 빌더 — 조회/좋아요/댓글 + 플랫폼별 추가 지표(extra: shares·saved·reposts·quotes 등) 합계.
//   items = [{views,likes,comments, voice,category, ...extra}]. extraKeys에 있는 지표만 total*로 합산(대문자 키).
function perfSummary(items: any[], extraKeys: string[] = []) {
  const avgBy = (key: 'voice' | 'category') => {
    const m: Record<string, number[]> = {};
    for (const it of items) { const kk = it[key]; if (!kk) continue; (m[kk] = m[kk] || []).push(it.views || it.likes || 0); }
    return Object.entries(m).map(([name, v]) => ({name, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), count: v.length})).sort((a, b) => b.avg - a.avg);
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const sum: any = {
    total: items.length,
    totalViews: items.reduce((n, x) => n + (x.views || 0), 0),
    totalLikes: items.reduce((n, x) => n + (x.likes || 0), 0),
    totalComments: items.reduce((n, x) => n + (x.comments || 0), 0),
    top3: items.slice(0, 3),
    chart: items.slice(0, 8).map((x) => ({title: x.title, views: x.views || 0, likes: x.likes || 0})), // 막대그래프용 상위 8
    byVoice: avgBy('voice').slice(0, 5),
    byCategory: avgBy('category').slice(0, 5),
  };
  for (const key of extraKeys) sum['total' + cap(key)] = items.reduce((n, x) => n + (x[key] || 0), 0);
  return sum;
}

// 재사용(CC BY) 하이라이트의 출처 문구 — 상세설명·캡션에 반드시 포함(저작권 표기 의무). 도메인은 뺀다(stripAttrUrl).
//   project.json.attribution 우선, 없으면 attribution.txt 폴백. 하이라이트가 아니면 빈 문자열.
function readAttribution(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) return '';
  const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).attribution;
    if (a) return stripAttrUrl(String(a).trim());
  } catch {}
  try {
    const f = path.join(dir, 'attribution.txt');
    if (fs.existsSync(f)) return stripAttrUrl(fs.readFileSync(f, 'utf8').trim());
  } catch {}
  // ★project.json·attribution.txt가 날아가도(ENOSPC) 포트폴리오에 저장해둔 출처로 폴백.
  try { const it = listPortfolio().find((x) => x.projectId === id); if (it?.attribution) return stripAttrUrl(String(it.attribution).trim()); } catch {}
  return '';
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
  let proj: any = {};
  try { proj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch {}
  // ★project.json이 깨졌어도(ENOSPC 등) 결정적 R2 키로 우리 커버를 찾는다.
  //   이게 없으면 인스타가 영상 중간의 흐릿한 레터박스 프레임을 자동 표지로 잡아 미리보기가 뿌옇게 나온다(테리 실측).
  // ★cover.jpg 캐시를 재사용하지 않는다 — 썸네일을 수정(재렌더)했는데 인스타에 옛 커버가 나오던 버그(테리 H.O.T→구피).
  //   인스타 업로드는 빈도가 낮으므로 매번 '현재 thumb.png'에서 새로 만들어 항상 최신 커버가 나가게 한다.
  // PNG 썸네일(로컬 or R2 결정적)에서 JPEG 생성.
  const tmpPng = path.join(os.tmpdir(), `cover-${id}.png`);
  const localPng = proj.thumb ? path.join(dir, proj.thumb) : '';
  let pngR2 = proj.thumbR2 || '';
  if (!pngR2 && !(localPng && fs.existsSync(localPng))) {
    const cand = videoKey(id, 'thumb.png');
    if (await r2Head(cand)) pngR2 = cand;
  }
  if (localPng && fs.existsSync(localPng)) fs.copyFileSync(localPng, tmpPng);
  else if (pngR2) {
    const got = await getStream(pngR2);
    if (!got) return '';
    await new Promise<void>((resolve, reject) => { const w = fs.createWriteStream(tmpPng); got.stream.pipe(w); w.on('finish', () => resolve()); w.on('error', reject); got.stream.on('error', reject); });
  } else return '';
  const tmpJpg = path.join(os.tmpdir(), `cover-${id}.jpg`);
  await pngToJpeg(tmpPng, tmpJpg);
  const key = videoKey(id, 'cover.jpg');
  if (!(await uploadFile(key, tmpJpg, 'image/jpeg'))) { jgSafeUnlink(tmpPng); jgSafeUnlink(tmpJpg); return ''; }
  jgSafeUnlink(tmpPng); jgSafeUnlink(tmpJpg);
  try { proj.thumbJpgR2 = key; fs.writeFileSync(pjPath, JSON.stringify(proj)); } catch {} // 캐시(실패해도 R2 키로 다음에 재사용)
  return (await presignGet(key, 3600)) || '';
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
type Job = {id: string; logs: string[]; done: boolean; doneAt?: number; file?: string; title?: string; error?: string; kind?: 'video' | 'post' | 'highlight' | 'remake' | 'create' | 'scenario' | 'bible' | 'shopping' | 'broadcast'; images?: string[]; zip?: string; projectId?: string; clips?: {projectId: string; file: string; title: string; score?: number}[]; cancelled?: boolean; storyboard?: Storyboard; bible?: any; remaining?: string[]};
// ★영상 로그(studio.ts)와 동일하게 각 줄 앞에 실시간 시각(한국시간 HH:MM:SS)을 붙인다. 프론트는 그대로 출력.
function jlog(job: Job, s: string) {
  const t = new Date().toLocaleTimeString('ko-KR', {hour12: false, timeZone: 'Asia/Seoul'});
  job.logs.push(`[${t}] ${s}`.slice(0, 500));
}
const jobs = new Map<string, Job>();
// ★모바일↔PC 실시간 동기화: 현재 진행 중인 생성 작업 id. 어느 기기든 로드 시 이걸 받아 같은 SSE에 붙는다.
let currentGenJob = '';

// ★작업 큐 — 무거운 제작/렌더(ffmpeg·Remotion·GPU)가 동시에 돌면 7.5GB·스레드 한계를 넘어 전부 멈춘다
//   (회원이 몰리면 바로 터지는 근본 원인, 2026-10-22). 동시 JOB_CONCURRENCY개만 실행하고 나머지는 대기열에
//   줄 세운다 → '막힘' 대신 '대기 N번째'. 기본 1(안전). 메모리 올리면 JOB_CONCURRENCY env로 늘린다.
const JOB_CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY) || 1);
let runningJobs = 0;
const waitQueue: {job: Job; task: () => Promise<void>}[] = [];
function pumpQueue() {
  while (runningJobs < JOB_CONCURRENCY && waitQueue.length) {
    const next = waitQueue.shift()!;
    if (next.job.cancelled) { next.job.done = true; next.job.doneAt = Date.now(); continue; } // 대기 중 취소한 건 건너뜀
    runningJobs++;
    // task 내부가 자체 try/catch로 job.done/error를 세팅한다(여기선 슬롯만 반납하고 다음을 당긴다).
    Promise.resolve().then(next.task).catch(() => {}).finally(() => { runningJobs--; pumpQueue(); });
  }
}
// 무거운 제작 작업을 큐에 넣는다(기존 `(async()=>{…})()` 즉시실행을 대체). 자리 나면 자동 시작.
function enqueueJob(job: Job, task: () => Promise<void>) {
  waitQueue.push({job, task});
  const ahead = runningJobs + waitQueue.length - 1; // 내 앞에서 돌거나 기다리는 작업 수
  if (runningJobs >= JOB_CONCURRENCY) jlog(job, `[대기] 다른 작업이 처리 중이라 대기열에 넣었어요 — 앞에 ${ahead}건. 순서가 되면 자동으로 시작됩니다.`);
  pumpQueue();
}
// 📊 성과(stats) 응답 캐시 — Meta/유튜브 insights는 영상마다 API를 긁어 느리다(수십 초). 플랫폼별 3분 TTL로
//   두 번째 방문부터 성과탭이 즉시 뜬다. debug=1(진단)은 항상 새로 긁어 우회(원인 추적용).
const statsCache = new Map<string, {at: number; body: any}>();
const STATS_TTL = 3 * 60 * 1000;
function cachedStats(plat: string, debug: boolean): any | null {
  if (debug) return null;
  const c = statsCache.get(plat);
  return (c && Date.now() - c.at < STATS_TTL) ? c.body : null;
}
function putStats(plat: string, debug: boolean, body: any) { if (!debug) statsCache.set(plat, {at: Date.now(), body}); }

// 지금 '영화(GPU)'을 쓰는 작업이 실제로 돌고 있는지 — 유휴 팟 자동종료 워치독의 판단 근거.
function anyGpuJobRunning(): boolean {
  for (const j of jobs.values()) if (!j.done && !j.cancelled) return true;
  return false;
}
// ★GPU 유휴 자동종료 워치독 — 작업이 하나도 안 도는데 RunPod 팟이 떠 있으면(자동종료 실패·크래시 잔재) 자동으로
//   끈다. 과금은 '영화 쓸 때만, 그리고 끝나면 반드시 꺼짐'을 서버가 최종 보장(테리 지시). 2분마다.
let gpuIdleSince = 0;
async function gpuIdleWatchdog() {
  try {
    const e = loadEnv();
    if (!e.RUNPOD_API_KEY) return;
    if (anyGpuJobRunning()) { gpuIdleSince = 0; return; } // 작업 중이면 손대지 않음
    const st = await runpodStatus(e.RUNPOD_API_KEY);
    const running = (st.pods || []).filter((p) => p.status === 'RUNNING');
    if (!running.length) { gpuIdleSince = 0; return; }
    // 유휴 상태가 '연속 2회(약 4분)' 확인되면 끈다 — 작업 시작 직전의 찰나 떠 있는 팟을 성급히 죽이지 않게.
    if (!gpuIdleSince) { gpuIdleSince = Date.now(); return; }
    const stopped = await stopAllWanPods(e.RUNPOD_API_KEY);
    console.log(`[GPU워치독] 작업 없는데 팟 ${running.length}대 떠 있어 자동 종료: ${stopped.join(', ')}`);
    gpuIdleSince = 0;
  } catch (err: any) { /* 조회 실패는 다음 주기에 재시도 */ }
}
setInterval(gpuIdleWatchdog, 2 * 60 * 1000); // 2분마다
setTimeout(gpuIdleWatchdog, 30 * 1000);      // 부팅 30초 뒤 1회(크래시 잔재 정리)

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
// 원본 바이너리 본문(파일 업로드용) — 최대 maxBytes 제한.
async function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error('파일이 너무 큽니다.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
// ★업로드 원본은 영구 볼륨이 아니라 /tmp에 둔다(렌더 출력과 동일 원리).
//   본인 업로드 영상은 제작에 쓰고 바로 지우는 '일회성'이라 볼륨에 둘 이유가 없고,
//   볼륨(/app/data)이 꽉 차면 업로드 write가 ENOSPC로 죽는다(테리 실측). /tmp는 볼륨과 별개 공간이라
//   볼륨이 꽉 차도 업로드가 성공한다. 오래된 잔재는 주기 청소(cleanOldUploads)가 치운다.
const HL_UPLOAD_DIR = path.join(os.tmpdir(), 'onvideo-hl-uploads');

// 버려진 업로드 원본 정리 — 올리고 제작 안 한 파일이 /tmp에 쌓이지 않게 maxAgeMs(기본 2시간) 넘은 것 삭제.
function cleanOldUploads(maxAgeMs = 2 * 60 * 60 * 1000): {removed: number; bytes: number} {
  let removed = 0, bytes = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(HL_UPLOAD_DIR)) {
      const fp = path.join(HL_UPLOAD_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs < maxAgeMs) continue;
        bytes += st.size; fs.rmSync(fp, {force: true}); removed++;
      } catch {}
    }
  } catch {}
  return {removed, bytes};
}

// ★볼륨이 다시는 꽉 차지 않도록 주기적으로 도는 유지보수.
//   studio.cleanup(오래된 작업·R2 오프로드분 정리) + 버려진 업로드 정리. 부팅 1회 + 30분마다 + 작업 끝날 때마다.
let maintTs = 0;
function runMaintenance(reason: string) {
  maintTs = Date.now();
  try { studio.cleanup({log: (s) => console.log('[유지보수:' + reason + '] ' + s)}); } catch {}
  const u = cleanOldUploads();
  if (u.removed) console.log(`[유지보수:${reason}] 버려진 업로드 ${u.removed}개 삭제`);
}

// 볼륨 사용량 + 큰 폴더 Top N (디스크 꽉참 진단용). 어느 폴더가 볼륨을 먹는지 한눈에.
function diskReport(topN = 20): {volume: string; usedMB: number | null; dirs: {path: string; mb: number}[]} {
  const out: {path: string; mb: number}[] = [];
  const walk = (dir: string) => {
    let total = 0;
    try {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) total += walk(fp);
        else { try { total += fs.statSync(fp).size; } catch {} }
      }
    } catch {}
    return total;
  };
  // studio/{id} 폴더별 크기 + hl-uploads + 기타 최상위
  const roots = [path.join(STUDIO_DATA_DIR, 'studio'), HL_UPLOAD_DIR, STUDIO_DATA_DIR];
  try {
    const studioDir = path.join(STUDIO_DATA_DIR, 'studio');
    if (fs.existsSync(studioDir)) {
      for (const id of fs.readdirSync(studioDir)) {
        const fp = path.join(studioDir, id);
        try { if (fs.statSync(fp).isDirectory()) out.push({path: 'studio/' + id, mb: Math.round(walk(fp) / 1048576 * 10) / 10}); } catch {}
      }
    }
    // 최상위 볼륨 파일/폴더(studio 제외)
    for (const e of fs.readdirSync(STUDIO_DATA_DIR, {withFileTypes: true})) {
      if (e.name === 'studio') continue;
      const fp = path.join(STUDIO_DATA_DIR, e.name);
      try { const sz = e.isDirectory() ? walk(fp) : fs.statSync(fp).size; out.push({path: e.name, mb: Math.round(sz / 1048576 * 10) / 10}); } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mb - a.mb);
  let usedMB: number | null = null;
  try { usedMB = Math.round(out.reduce((a, x) => a + x.mb, 0)); } catch {}
  return {volume: STUDIO_DATA_DIR, usedMB, dirs: out.slice(0, topN)};
}

// ── 시크릿 봇(스레드 자동 공감댓글) 상태 ──
//   로컬 맥 봇(secret-bot/)이 /api/secret/poll로 할 일을 받아 실행하고, /api/secret/report로 로그·스샷·카운트를 올린다.
//   시크릿 탭 UI는 /api/secret/state를 폴링해 그대로 보여준다. 봇↔서버는 OVBOT_TOKEN으로만 통신(숨김 유지).
type SecretLog = {t: number; m: string; shot?: string};
type SecretAcct = {label: string; username: string; loggedIn: boolean; lastError?: string};
// 활동 내역 1건(영구 저장) — 재배포해도 안 날아가게 파일에 적재. 테리: "실제 확인해볼 수 있게" 글 링크 포함.
type SecretActivity = {t: number; author: string; url: string; comment?: string; liked?: boolean; followed?: boolean; commented?: boolean};
type SecretState = {
  status: 'idle' | 'running' | 'paused' | 'stopped';
  platform: 'threads';
  keyword: string; account: string;
  accounts: SecretAcct[];
  dailyLimit: number; termSec: number; proxyOn: boolean; visible: boolean;
  // 공감 활동 토글(테리: 체크한 대로만) — 좋아요·댓글·팔로우 + 댓글 소스(AI/정해진 문구 로테이션).
  doLike: boolean; doComment: boolean; doFollow: boolean;
  commentMode: 'ai' | 'fixed'; fixedComments: string[];
  logs: SecretLog[]; count: number; startedAt: number; lastAt: number;
};
const SECRET_FILE = path.join(STUDIO_DATA_DIR, 'secret-bot.json');
const OVBOT_TOKEN = process.env.OVBOT_TOKEN || 'onvideo-secret-bot';
// ★비번은 '디스크에 저장하지 않는다' — UI가 계정 추가하면 여기(메모리)에 담아 봇이 poll로 1회 가져가고 즉시 지운다.
let secretPendingLogin: {label: string; id: string; pw: string} | null = null;
function defaultSecret(): SecretState {
  return {status: 'idle', platform: 'threads', keyword: '', account: 'main', accounts: [], dailyLimit: 20, termSec: 180, proxyOn: false, visible: true,
    doLike: true, doComment: true, doFollow: false, commentMode: 'ai', fixedComments: [], logs: [], count: 0, startedAt: 0, lastAt: 0};
}
const secretState: SecretState = (() => {
  try { return {...defaultSecret(), ...JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'))}; } catch { return defaultSecret(); }
})();
function saveSecret() { try { fs.writeFileSync(SECRET_FILE, JSON.stringify(secretState)); } catch {} }

// ── 활동 내역(영구 저장) — 재배포·봇 재시작해도 유지. 중복 댓글 방지 + "실제 확인" 링크 목록 둘 다 해결.
const SECRET_ACT_FILE = path.join(STUDIO_DATA_DIR, 'secret-activity.json');
const secretActs: SecretActivity[] = (() => {
  try { const a = JSON.parse(fs.readFileSync(SECRET_ACT_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
})();
function saveSecretActs() { try { fs.writeFileSync(SECRET_ACT_FILE, JSON.stringify(secretActs.slice(-2000))); } catch {} }
// 이미 댓글 단 글 URL 집합(중복 방지) — 댓글을 '실제로 단' 것만(commented).
function commentedUrlSet(): string[] {
  const s = new Set<string>();
  for (const a of secretActs) if (a.commented && a.url) s.add(a.url);
  return [...s];
}
function addSecretAct(a: SecretActivity) { secretActs.push(a); if (secretActs.length > 2000) secretActs.splice(0, secretActs.length - 2000); saveSecretActs(); }
function secretLog(m: string, shot?: string) {
  secretState.logs.push({t: Date.now(), m, shot});
  if (secretState.logs.length > 400) secretState.logs = secretState.logs.slice(-400); // 스샷 많으면 무거워져 상한
  secretState.lastAt = Date.now(); saveSecret();
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
  // ── 시크릿 봇 API ──
  //   UI용(로그인 세션 필요): state 조회 + control(시작/정지/일시정지/이어/취소/로그비우기).
  if (p === '/api/secret/state' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    return json(res, 200, secretState);
  }
  if (p === '/api/secret/control' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    const b = await readBody(req);
    const act = String(b.action || '');
    if (act === 'start') {
      secretState.keyword = String(b.keyword || '').trim();
      if (!secretState.keyword) return json(res, 400, {error: '키워드를 입력하세요'});
      secretState.dailyLimit = Math.max(1, Math.min(500, Number(b.dailyLimit) || 20));
      secretState.termSec = Math.max(30, Math.min(3600, Number(b.termSec) || 180));
      secretState.proxyOn = !!b.proxyOn;
      secretState.visible = b.visible !== false;
      secretState.account = String(b.account || 'main').slice(0, 40) || 'main';
      secretState.doLike = b.doLike !== false;
      secretState.doComment = b.doComment !== false;
      secretState.doFollow = !!b.doFollow;
      secretState.commentMode = b.commentMode === 'fixed' ? 'fixed' : 'ai';
      secretState.fixedComments = Array.isArray(b.fixedComments)
        ? b.fixedComments.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 50)
        : String(b.fixedComments || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
      if (secretState.doComment && secretState.commentMode === 'fixed' && !secretState.fixedComments.length)
        return json(res, 400, {error: '정해진 문구를 한 줄에 하나씩 입력하세요'});
      secretState.status = 'running'; secretState.count = 0; secretState.startedAt = Date.now();
      const acts = [secretState.doLike && '좋아요', secretState.doComment && `댓글(${secretState.commentMode === 'ai' ? 'AI' : '정해진문구'})`, secretState.doFollow && '팔로우'].filter(Boolean).join('+') || '없음';
      secretLog(`▶ 시작 — "${secretState.keyword}" · 활동 ${acts} (하루 ${secretState.dailyLimit}개 · 텀 ${secretState.termSec}초 · 프록시 ${secretState.proxyOn ? 'ON' : 'OFF(집 IP)'} · 창보기 ${secretState.visible ? 'ON' : 'OFF'})`);
    } else if (act === 'pause') { secretState.status = 'paused'; secretLog('⏸ 일시정지'); }
    else if (act === 'resume') { secretState.status = 'running'; secretLog('▶ 이어하기'); }
    else if (act === 'stop') { secretState.status = 'stopped'; secretLog('■ 정지'); }
    else if (act === 'cancel') { secretState.status = 'stopped'; secretState.count = 0; secretLog('✕ 취소'); }
    else if (act === 'clear') { secretState.logs = []; }
    else return json(res, 400, {error: '알 수 없는 동작'});
    saveSecret();
    return json(res, 200, secretState);
  }
  //   계정 관리(로그인 필요) — 추가(아이디/비번)·선택·삭제. ★비번은 디스크 저장 안 하고 봇에 1회 전달.
  if (p === '/api/secret/account/add' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    const b = await readBody(req);
    const label = (String(b.label || '').trim().slice(0, 40)) || 'main';
    const id = String(b.id || '').trim(); const pw = String(b.pw || '');
    if (!id || !pw) return json(res, 400, {error: '아이디와 비밀번호를 입력하세요'});
    secretPendingLogin = {label, id, pw};
    if (!secretState.accounts.some((a) => a.label === label)) secretState.accounts.push({label, username: id, loggedIn: false});
    else secretState.accounts = secretState.accounts.map((a) => a.label === label ? {...a, username: id, loggedIn: false} : a);
    secretState.account = label;
    secretLog(`🔑 계정 "${label}" 로그인 요청 — 봇이 자동 로그인합니다(2단계 인증은 창에서).`);
    saveSecret();
    return json(res, 200, {accounts: secretState.accounts, account: secretState.account});
  }
  if (p === '/api/secret/account/select' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    const b = await readBody(req);
    secretState.account = (String(b.label || 'main').slice(0, 40)) || 'main';
    saveSecret();
    return json(res, 200, {account: secretState.account, accounts: secretState.accounts});
  }
  if (p === '/api/secret/account/remove' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    const b = await readBody(req);
    const label = String(b.label || '');
    secretState.accounts = secretState.accounts.filter((a) => a.label !== label);
    if (secretState.account === label) secretState.account = secretState.accounts[0]?.label || 'main';
    saveSecret();
    return json(res, 200, {accounts: secretState.accounts, account: secretState.account});
  }
  //   봇용(OVBOT_TOKEN 필요): poll(할 일 받기) · report(진행 보고) · gen-comment(AI 공감댓글).
  if (p === '/api/secret/poll' && req.method === 'GET') {
    if (u.searchParams.get('token') !== OVBOT_TOKEN) return json(res, 403, {error: 'forbidden'});
    const pend = secretPendingLogin; secretPendingLogin = null; // 1회 전달(소비) — 봇이 받아 자동 로그인
    return json(res, 200, {
      status: secretState.status, keyword: secretState.keyword, account: secretState.account,
      dailyLimit: secretState.dailyLimit, termSec: secretState.termSec, proxyOn: secretState.proxyOn,
      visible: secretState.visible, count: secretState.count,
      doLike: secretState.doLike, doComment: secretState.doComment, doFollow: secretState.doFollow,
      commentMode: secretState.commentMode, fixedComments: secretState.fixedComments,
      accounts: secretState.accounts, pendingLogin: pend,
      commentedUrls: commentedUrlSet(), // ★봇이 중복 댓글 안 달게 — 이미 댓글 단 글 목록(영구)
    });
  }
  if (p === '/api/secret/activities' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    // 최근 활동(최신순). 오늘 것 카운트도 함께.
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = secretActs.filter((a) => a.t >= todayStart.getTime());
    return json(res, 200, {
      activities: secretActs.slice(-300).reverse(),
      todayCount: today.length,
      todayLiked: today.filter((a) => a.liked).length,
      todayCommented: today.filter((a) => a.commented).length,
      todayFollowed: today.filter((a) => a.followed).length,
    });
  }
  if (p === '/api/secret/report' && req.method === 'POST') {
    if (u.searchParams.get('token') !== OVBOT_TOKEN) return json(res, 403, {error: 'forbidden'});
    const b = await readBody(req);
    if (Array.isArray(b.logs)) for (const l of b.logs) secretLog(String(l.m ?? l), l.shot);
    else if (b.m) secretLog(String(b.m), b.shot);
    if (typeof b.count === 'number') { secretState.count = b.count; saveSecret(); }
    if (b.status && ['running', 'paused', 'stopped', 'idle'].includes(b.status)) { secretState.status = b.status; saveSecret(); }
    if (b.loginDone && b.loginDone.label) { // 봇이 연결(로그인) 끝냄 → 계정 상태+실패사유 갱신
      const ld = b.loginDone;
      secretState.accounts = secretState.accounts.map((a) => a.label === ld.label ? {...a, loggedIn: !!ld.ok, username: ld.username || a.username, lastError: ld.ok ? '' : (ld.reason || '로그인 실패')} : a);
      saveSecret();
    }
    if (b.activity && b.activity.url) { // 봇이 활동 1건 완료 → 영구 저장(중복방지+내역)
      const a = b.activity;
      addSecretAct({t: Date.now(), author: String(a.author || ''), url: String(a.url), comment: a.comment ? String(a.comment) : undefined, liked: !!a.liked, followed: !!a.followed, commented: !!a.commented});
    }
    return json(res, 200, {status: secretState.status});
  }
  if (p === '/api/secret/gen-comment' && req.method === 'POST') {
    if (u.searchParams.get('token') !== OVBOT_TOKEN) return json(res, 403, {error: 'forbidden'});
    const b = await readBody(req);
    const postText = String(b.postText || '').slice(0, 1000);
    const k = pipelineKeys();
    if (!k.gemini.length || !postText) return json(res, 200, {comment: ''});
    const prompt = `너는 스레드(Threads) 유저다. 아래 '남이 쓴 글'에 달 짧고 자연스러운 '공감 댓글' 하나를 만들어라.
글: "${postText}"
[규칙]
- 진짜 사람이 공감해서 다는 말투. 1~2문장, 40자 안팎으로 짧게.
- 그 글만의 '구체적 디테일'에 반응(영혼 없는 "공감돼요" 금지).
- 홍보·링크·해시태그·이모지 범벅·복붙티 금지. 글 톤(반말/존댓말)에 맞춰.
JSON만: {"comment":"..."}`;
    let comment = '';
    try {
      const raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 300, temperature: 0.9});
      comment = String(JSON.parse(raw.replace(/```json|```/g, '').trim()).comment || '').slice(0, 200);
    } catch {}
    return json(res, 200, {comment});
  }

  // ── 로그인 상태 확인 ──
  if (p === '/api/auth') return json(res, 200, {required: passwordSet(), ok: authed(req)});
  // ── 로그인 ──
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const ok = passwordSet() && verifyPassword(String(b.password || ''));
    if (!ok) return json(res, 401, {error: '비밀번호를 확인하세요.'});
    const secure = (req.headers['x-forwarded-proto'] === 'https') ? ' Secure;' : '';
    // 세션 30일 — 긴 제작(수십 분~시간) 중 자리 비워도 안 끊기게. 아래 인증 통과 요청마다 자동 갱신(rolling)도 함.
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE};${secure}`,
    );
    return json(res, 200, {ok: true});
  }

  // ── 🔒 기능 페이지 진입 차단 — 비번(세션) 없으면 랜딩으로. 대시보드·기능·관리 화면은 로그인 필수. ──
  //   랜딩(/)·로그인/버전 API·정적 자산·포트폴리오 쇼케이스(랜딩 캐러셀용)는 공개로 남긴다.
  const GATED_PAGES = new Set(['/app', '/app.html', '/index.html', '/voices', '/monetize', '/monetize.html', '/highlight', '/highlight.html', '/create', '/create.html', '/shop', '/shop.html', '/secret', '/secret.html', '/social', '/social.html']);
  if (GATED_PAGES.has(p) && !authed(req)) {
    res.writeHead(302, {Location: '/?login=1'});
    return res.end();
  }

  // ── 목소리 샘플 페이지 ──
  if (p === '/voices')
    return serveFile(res, path.join(ROOT, 'web', 'voices.html'), 'text/html; charset=utf-8');

  // ── 수익화 가이드(저작권·클레임·전략 정리) ──
  if (p === '/monetize' || p === '/monetize.html')
    return serveFile(res, path.join(ROOT, 'web', 'monetize.html'), 'text/html; charset=utf-8');

  // ── 유튜브 하이라이트 전용 페이지(영상 만들기와 완전 분리) ──
  if (p === '/highlight' || p === '/highlight.html')
    return serveFile(res, path.join(ROOT, 'web', 'highlight.html'), 'text/html; charset=utf-8');
  if (p === '/create' || p === '/create.html')
    return serveFile(res, path.join(ROOT, 'web', 'create.html'), 'text/html; charset=utf-8');
  // ── 🛍 쇼핑 쇼츠 전용 페이지(독립 탭) ──
  if (p === '/shop' || p === '/shop.html')
    return serveFile(res, path.join(ROOT, 'web', 'shop.html'), 'text/html; charset=utf-8');
  if (p === '/shop.js')
    return serveFile(res, path.join(ROOT, 'web', 'shop.js'), 'application/javascript; charset=utf-8');
  if (p === '/ppurio' || p === '/ppurio.html')
    return serveFile(res, path.join(ROOT, 'web', 'ppurio-v.html'), 'text/html; charset=utf-8');
  if (p === '/ppurio-manifest.json')
    return serveFile(res, path.join(ROOT, 'web', 'ppurio-manifest.json'), 'application/manifest+json; charset=utf-8');
  if (p.startsWith('/ppurio-assets/')) {
    const f = p.slice('/ppurio-assets/'.length);
    if (/^[\w.-]+\.(png|jpe?g|webp|svg)$/.test(f)) {
      const ct = f.endsWith('.png') ? 'image/png' : f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return serveFile(res, path.join(ROOT, 'web', 'ppurio-assets', f), ct);
    }
  }
  if (p === '/social' || p === '/social.html')
    return serveFile(res, path.join(ROOT, 'web', 'social.html'), 'text/html; charset=utf-8');
  if (p === '/social.js')
    return serveFile(res, path.join(ROOT, 'web', 'social.js'), 'application/javascript; charset=utf-8');
  // 🔒 시크릿 콘솔(숨김) — 로그인(GATED) + UI 345678 이중 게이트. 메뉴에 노출 안 함.
  if (p === '/secret' || p === '/secret.html')
    return serveFile(res, path.join(ROOT, 'web', 'secret.html'), 'text/html; charset=utf-8');
  if (p === '/secret.js')
    return serveFile(res, path.join(ROOT, 'web', 'secret.js'), 'application/javascript; charset=utf-8');
  if (p === '/highlight.js')
    return serveFile(res, path.join(ROOT, 'web', 'highlight.js'), 'application/javascript; charset=utf-8');
  if (p === '/create.js')
    return serveFile(res, path.join(ROOT, 'web', 'create.js'), 'application/javascript; charset=utf-8');
  if (p === '/wake.js') // 통합 화면 꺼짐 방지 매니저(모든 페이지 공통)
    return serveFile(res, path.join(ROOT, 'web', 'wake.js'), 'application/javascript; charset=utf-8');

  // ── 정적 ──
  // 루트(/) = 마케팅 랜딩페이지. 앱(대시보드)은 /app 으로. "시작하기"가 /app 으로 보낸다.
  if (p === '/' || p === '/landing' || p === '/landing.html')
    return serveFile(res, path.join(ROOT, 'web', 'landing.html'), 'text/html; charset=utf-8');
  if (p === '/app' || p === '/app.html' || p === '/index.html')
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
  if (p === '/font-preview.js')
    return serveFile(res, path.join(ROOT, 'web', 'font-preview.js'), 'text/javascript; charset=utf-8');
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
  // 랜딩 폰 목업 데모 이미지(공개) — public 루트의 샘플 사진. 화이트리스트만(경로우회 방지).
  if (p.startsWith('/landing-img/')) {
    const name = path.basename(p);
    const allow = new Set(['news1.jpg', 'news2.jpg', 'news3.jpg', 'news4.jpg', 'bg1.jpg', 'bg2.jpg']);
    if (!allow.has(name)) { res.writeHead(404); return res.end('not found'); }
    return serveFile(res, path.join(ROOT, 'public', name), 'image/jpeg');
  }

  // 랜딩 쇼케이스 영상(공개) — web/showcase/s{n}.mp4. 실제 완성작 미리보기(마퀴). 화이트리스트만.
  if (p.startsWith('/showcase/')) {
    const m = p.match(/^\/showcase\/(s[1-9])\.mp4$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    return fs.readFile(path.join(ROOT, 'web', 'showcase', `${m[1]}.mp4`), (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); }
      else { res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400'}); res.end(buf); }
    });
  }

  // 폰트 파일(공개) — public/fonts/{file}. 랜딩·폰트 미리보기 @font-face용. 파일명만 허용(경로우회 방지).
  if (p.startsWith('/fonts/')) {
    const name = path.basename(p);
    if (!/^[\w.-]+\.(ttf|otf|woff2?)$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const ext = name.split('.').pop();
    const ct = ext === 'otf' ? 'font/otf' : ext === 'woff' ? 'font/woff' : ext === 'woff2' ? 'font/woff2' : 'font/ttf';
    return serveFile(res, path.join(ROOT, 'public', 'fonts', name), ct);
  }

  // 디자인 템플릿 미리보기 이미지(공개) — web/tpl-preview/{id}.png. id는 알려진 템플릿만 허용(경로우회 방지).
  if (p.startsWith('/tpl-preview/')) {
    const m = p.match(/^\/tpl-preview\/([a-z]+)\.png$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    return serveFile(res, path.join(ROOT, 'web', 'tpl-preview', `${m[1]}.png`), 'image/png');
  }
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
        facebookUrl: it.facebookUrl || readProjectFacebook(it.projectId),
        threadsUrl: it.threadsUrl || readProjectThreads(it.projectId),
        orientation: it.orientation || 'portrait', // 레거시(없음)=세로 폴백
        video: isPost ? '' : `/portfolio-item/${it.projectId}.mp4`,
        images: isPost ? (it.images || []).map((_, i) => `/portfolio-card/${it.projectId}/${i + 1}.png`) : undefined,
        // ★영상 항목은 항상 썸네일 URL 발급(서빙이 R2에서 결정적으로 찾음). <video poster>라 404여도 깨짐 없음.
        //   ?v=editV — 수정(재렌더)하면 값이 바뀌어 브라우저 캐시(하루)를 무효화 → 새 썸네일이 바로 보임(테리: 썸네일 그대로 버그).
        thumb: isPost ? '' : `/portfolio-thumb/${it.projectId}.png${it.editV ? `?v=${it.editV}` : ''}`,
        score: typeof it.score === 'number' ? it.score : undefined, // 하이라이트 바이럴 점수
        source: it.source, // 하이라이트 소재 출처(작업내역 탭별 이원화): search/url/upload/archive
        // ★작업내역 탭별 이원화: origin(video/remake/create). 레거시(없음)는 category로 폴백.
        origin: it.origin || (it.category === '🎭 재창작' ? 'remake' : it.category === '✍️ 창작' ? 'create' : 'video'),
        motion: !!it.motion, // 영화(Wan)이면 '🎬 영상' 배지
      };
    });
    const sampleYt = loadSampleYouTube();
    const sampleIg = loadSampleInstagram();
    const sampleFb = loadSampleFacebook();
    const sampleTh = loadSampleThreads();
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
      facebookUrl: sampleFb[s.file] || '', // 샘플도 페북 업로드 시 배지 기록
      threadsUrl: sampleTh[s.file] || '', // 샘플도 스레드 게시 시 배지 기록
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
    let {thumb, thumbR2} = readProjectThumb(m[1]);
    // ★project.json이 깨졌어도 R2의 표준 썸네일(studio/{id}/thumb.png or cover.jpg)을 결정적으로 시도.
    //   영상 서빙과 같은 원칙 — 파일만 R2에 있으면 썸네일도 항상 뜬다(까만 썸네일 재발 차단).
    if (!thumbR2 && r2Enabled()) {
      for (const cand of ['thumb.png', 'cover.jpg']) {
        const k = videoKey(m[1], cand);
        if (await r2Head(k)) { thumbR2 = k; thumb = cand; break; }
      }
    }
    if (!thumb && !thumbR2) { res.writeHead(404); return res.end('not found'); }
    if (thumbR2) {
      // ★R2 직접(presign 302) — 서버가 썸네일을 하나씩 중계하면 포폴 136개가 순차로 느려진다.
      //   브라우저가 R2에서 직접(병렬) 받게 리다이렉트. presign 실패 시에만 기존 중계로 폴백.
      try {
        const url = await presignGet(thumbR2, 21600);
        if (url) { res.writeHead(302, {Location: url, 'Cache-Control': 'public, max-age=3600'}); return res.end(); }
      } catch {}
      const got = await getStream(thumbR2);
      if (!got) { res.writeHead(404); return res.end('not found'); }
      const ct = /\.jpg$|\.jpeg$/i.test(thumbR2) ? 'image/jpeg' : 'image/png';
      res.writeHead(200, {'Content-Type': ct, 'Content-Length': got.size, 'Cache-Control': 'public, max-age=86400'});
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
    // ★R2 키를 '결정적으로' 구한다: project.json에 기록된 키 우선, 없으면 포트폴리오 output 파일명으로 재구성.
    //   R2 키는 항상 studio/{id}/{output}로 정해져 있으므로, project.json이 깨져도(쓰기 실패 등)
    //   R2에 파일만 있으면 무조건 서빙된다 → '파일은 있는데 404' 재발을 구조적으로 차단(2026-10-09).
    let r2key = readProjectOutputR2(m[1]);
    if (!r2key && r2Enabled() && item.output) r2key = videoKey(m[1], item.output);
    if (r2key && (await r2Head(r2key))) return streamR2Video(req, res, r2key);
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
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#231e18;color:#efe9e0;text-align:center;padding:60px"><h2>${ok ? '✅ 유튜브 연결 완료' : '❌ 연결 실패'}</h2><p>${msg}</p><p><a style="color:#4fe0d0" href="/app">← 돌아가기</a> (이 창은 닫아도 됩니다)</p></body>`);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    if (err) return done('구글에서 취소됨: ' + err, false);
    if (!code) return done('인증 코드가 없습니다.', false);
    try { await exchangeCode(code, redirectUri); return done('이제 완성 영상을 유튜브에 올릴 수 있어요.', true); }
    catch (e: any) { return done(e.message, false); }
  }

  // ── 스레드 OAuth 콜백(공개: 스레드가 로그인 쿠키 없이 여기로 리다이렉트) ──
  if (p === '/api/threads/callback' && req.method === 'GET') {
    const code = u.searchParams.get('code') || '';
    const err = u.searchParams.get('error') || u.searchParams.get('error_description') || '';
    const redirectUri = `${ytProto(req)}://${req.headers.host}/api/threads/callback`;
    const done = (msg: string, ok: boolean) =>
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#231e18;color:#efe9e0;text-align:center;padding:60px"><h2>${ok ? '✅ 스레드 연결 완료' : '❌ 연결 실패'}</h2><p>${msg}</p><p><a style="color:#4fe0d0" href="/app">← 돌아가기</a> (이 창은 닫아도 됩니다)</p></body>`);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    if (err) return done('스레드에서 취소됨: ' + err, false);
    if (!code) return done('인증 코드가 없습니다.', false);
    try { const acc = await exchangeThreadsCode(code, redirectUri); return done(`이제 완성 영상을 스레드(@${acc.username || acc.label})에 올릴 수 있어요.`, true); }
    catch (e: any) { return done(e.message, false); }
  }

  // ── 이 아래 모든 /api 는 로그인 필요(비번 설정 시) ──
  if (p.startsWith('/api/') && !authed(req))
    return json(res, 401, {error: '로그인이 필요합니다.'});
  // ★세션 자동 갱신(rolling) — 로그인된 상태로 API를 쓸 때마다 쿠키 만료를 30일 뒤로 밀어준다.
  //   긴 제작 중 주기 폴링(jobs/current)이 계속 요청하므로, 자리 비워도 세션이 안 끊긴다.
  if (p.startsWith('/api/') && passwordSet() && authed(req)) {
    const secure = (req.headers['x-forwarded-proto'] === 'https') ? ' Secure;' : '';
    const ck = (req.headers.cookie || '').match(new RegExp(COOKIE + '=([^;]+)'));
    if (ck) res.setHeader('Set-Cookie', `${COOKIE}=${ck[1]}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE};${secure}`);
  }

  // ── 유튜브: 연결 상태 ──
  if (p === '/api/youtube/status' && req.method === 'GET')
    return json(res, 200, youtubeStatus());
  // 유튜브 채널 삭제/이름변경(멀티채널)
  if (p.startsWith('/api/youtube/accounts/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/youtube/accounts/'.length));
    removeYouTube(id);
    return json(res, 200, {ok: true, accounts: youtubeStatus().accounts});
  }
  if (p.startsWith('/api/youtube/accounts/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/youtube/accounts/'.length));
    const b = await readBody(req);
    renameYouTube(id, String(b.label || '').trim());
    return json(res, 200, {ok: true, accounts: youtubeStatus().accounts});
  }
  // ── 성과 추적: 올린 유튜브 영상의 조회수·좋아요·댓글 집계(공개, voices.html이 로드) ──
  if (p === '/api/youtube/stats' && req.method === 'GET') {
    const debug = u.searchParams.get('debug') === '1';
    if (!youtubeStatus().connected) return json(res, 200, {connected: false, items: [], summary: null});
    const yc = cachedStats('youtube', debug); if (yc) return json(res, 200, yc);
    const sampleYt = loadSampleYouTube();
    const all = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.youtubeUrl || readProjectYouTube(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleYt[s.file] || ''})),
    ];
    const withId = all.map((x) => ({...x, videoId: extractVideoId(x.url)})).filter((x) => x.videoId);
    const diag: string[] | undefined = debug ? [] : undefined;
    // ★채널에 실제로 올라간 모든 영상을 합집합으로 추가(포트폴리오에 URL이 안 저장됐거나 앱 밖에서 올린 것도
    //   포함 → "67 vs 70" 개수·합계 불일치 해소). 채널 조회 실패해도 기존 포트폴리오 기준으로는 동작(무회귀).
    try {
      const have = new Set(withId.map((x) => x.videoId));
      const chan = await getChannelVideos();
      for (const v of chan) if (!have.has(v.id)) { withId.push({id: 'yt:' + v.id, title: v.title, voice: undefined, category: undefined, goal: undefined, url: 'https://youtu.be/' + v.id, videoId: v.id} as any); have.add(v.id); }
      diag?.push(`채널 업로드 ${chan.length}개 병합 → 추적 ${withId.length}개`);
    } catch (e: any) { diag?.push('⚠️ 채널 목록 병합 실패(포트폴리오 기준 유지): ' + (e?.message || e)); }
    if (!withId.length) return json(res, 200, {connected: true, items: [], summary: null});
    let stats: Record<string, {views: number; likes: number; comments: number; shares: number}> = {};
    // ★성과(조회수) 조회가 실패(계정 토큰 만료 등)해도 화면을 에러로 덮지 않는다 — 영상 목록은 그대로 보여주고
    //   성과 숫자만 0으로 둔다(검색·제작은 API 키라 무관). 토큰 만료 하나로 포폴 전체가 막히던 문제 해결.
    try { stats = await getVideoStats(withId.map((x) => x.videoId), diag); }
    catch (e: any) { diag?.push('성과 조회 실패(목록만 표시): ' + (e?.message || e)); stats = {}; }
    const items = withId
      .map((x) => ({...x, ...(stats[x.videoId] || {views: 0, likes: 0, comments: 0, shares: 0})}))
      .sort((a, b) => b.views - a.views);
    // 유튜브 공유수(shares)는 Analytics API로 긁어와 집계·표시한다. 저장(saved)은 Data API가 공개하지 않아 불가.
    const ytBody = {connected: true, items, summary: perfSummary(items, ['shares']), ...(diag ? {debug: diag} : {})};
    putStats('youtube', debug, ytBody);
    return json(res, 200, ytBody);
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
    const accountId = String(b.accountId || '').trim() || undefined;
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
      }, thumb?.file, accountId);
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
    // 가로 영상이면 #Shorts 안 붙게 orientation 전달(포폴에서 조회).
    const pf = src.kind === 'mine' ? listPortfolio().find((x) => x.projectId === id) : null;
    const orientation = pf?.orientation === 'landscape' ? 'landscape' : 'portrait';
    try {
      const meta = await generateMeta({gemini: k.gemini, openai: k.openai}, src.title, src.narrations, src.durSec, orientation);
      // CC BY 하이라이트는 출처를 설명 끝에 반드시 붙인다(저작권 표기 의무).
      const attr = readAttribution(id);
      if (attr && !meta.description.includes(attr)) meta.description = (meta.description + '\n\n' + attr).slice(0, 4900);
      // 쇼핑 쇼츠는 구매 링크(+제휴 고지)를 설명 끝에.
      const cta = readProductCta(id);
      if (cta && !meta.description.includes(cta)) meta.description = (meta.description + '\n\n' + cta).slice(0, 4900);
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
    // ★allSettled — 한 플랫폼 활동 조회가 실패(토큰 만료 등)해도 나머지는 그대로 보여준다(화면이 에러로 안 막힘).
    const r = await Promise.allSettled([getYtActivity(ytIds), getUploadActivity(), getFbActivity(), getThActivity()]);
    const [youtube, instagram, facebook, threads] = r.map((x) => x.status === 'fulfilled' ? x.value : null);
    return json(res, 200, {produced: todayProducedCount(), youtube, instagram, facebook, threads});
  }
  // ── 성과 추적: 올린 인스타 영상의 조회수·좋아요·댓글 집계(공개, voices.html이 로드) ──
  if (p === '/api/instagram/stats' && req.method === 'GET') {
    const debug = u.searchParams.get('debug') === '1';
    const diag: string[] | undefined = debug ? [] : undefined;
    if (!instagramStatus().connected) return json(res, 200, {connected: false, items: [], summary: null, ...(debug ? {debug: ['연결 안 됨(status)']} : {})});
    const ic = cachedStats('instagram', debug); if (ic) return json(res, 200, ic);
    const sampleIg = loadSampleInstagram();
    const all = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.instagramUrl || readProjectInstagram(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleIg[s.file] || ''})),
    ];
    const withUrl = all.filter((x) => x.url);
    if (!withUrl.length) return json(res, 200, {connected: true, items: [], summary: null, ...(debug ? {debug: ['올린 영상 중 instagramUrl(permalink) 저장된 게 없음']} : {})});
    let byPermalink: Record<string, {views: number; likes: number; comments: number; saved?: number; shares?: number; reposts?: number; reach?: number; totalInteractions?: number}> = {};
    // ★인스타도 유튜브와 동일 — 성과 조회 실패(토큰 만료 등)해도 목록은 보여주고 성과만 0으로(화면 안 덮음).
    try { byPermalink = await getInstaStats(diag); }
    catch (e: any) { diag?.push('인스타 성과 조회 실패(목록만 표시): ' + (e?.message || e)); byPermalink = {}; }
    if (diag) {
      const apiKeys = Object.keys(byPermalink);
      diag.push(`우리가 저장한 permalink ${withUrl.length}개: ${withUrl.map((x) => x.url).slice(0, 5).join(' , ')}`);
      diag.push(`Meta가 돌려준 permalink ${apiKeys.length}개: ${apiKeys.slice(0, 5).join(' , ')}`);
      const matched = withUrl.filter((x) => byPermalink[x.url]).length;
      diag.push(`permalink 매칭 성공 ${matched}/${withUrl.length}개 (0이면 키 불일치)`);
    }
    const items = withUrl
      .map((x) => ({...x, ...{views: 0, likes: 0, comments: 0, saved: 0, shares: 0, reposts: 0, reach: 0, interactions: 0}, ...(byPermalink[x.url] || {})}))
      .sort((a, b) => b.views - a.views || b.likes - a.likes);
    const igBody = {connected: true, items, summary: perfSummary(items, ['saved', 'shares', 'reposts', 'reach', 'interactions']), ...(debug ? {debug: diag} : {})};
    putStats('instagram', debug, igBody);
    return json(res, 200, igBody);
  }
  // 인스타 연결(계정 추가 — 여러 개 등록 가능. 같은 계정이면 토큰 갱신)
  if (p === '/api/instagram/connect' && req.method === 'POST') {
    const b = await readBody(req);
    const igUserId = String(b.igUserId || '').trim();
    const accessToken = String(b.accessToken || '').trim();
    const base = b.base === 'facebook' ? 'facebook' : 'instagram';
    const label = String(b.label || '').trim() || undefined;
    if (!igUserId || !accessToken) return json(res, 400, {error: '인스타 계정 ID와 액세스 토큰을 입력하세요.'});
    try {
      const username = await verifyInstagram({igUserId, accessToken, base});
      const acc = addInstagram({igUserId, accessToken, base, username, label});
      return json(res, 200, {connected: true, username, id: acc.id, label: acc.label});
    } catch (e: any) { return json(res, 400, {error: e.message}); }
  }
  // 인스타 계정 삭제/이름변경(멀티계정)
  if (p.startsWith('/api/instagram/accounts/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/instagram/accounts/'.length));
    removeInstagram(id);
    return json(res, 200, {ok: true, accounts: instagramStatus().accounts});
  }
  if (p.startsWith('/api/instagram/accounts/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/instagram/accounts/'.length));
    const b = await readBody(req);
    renameInstagram(id, String(b.label || '').trim());
    return json(res, 200, {ok: true, accounts: instagramStatus().accounts});
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
    const accountId = String(b.accountId || '').trim() || undefined;
    try {
      const urls = await ensureCarouselJpegUrls(id, () => {});
      const r = await publishCarousel(urls, caption, undefined, accountId);
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
    // 플랫폼별 글: ?platform=threads|facebook|instagram (기본 instagram). 같은 영상도 플랫폼마다 글이 달라야 먹힌다.
    const pfRaw = (u.searchParams.get('platform') || 'instagram').toLowerCase();
    const platform = (pfRaw === 'threads' || pfRaw === 'facebook' ? pfRaw : 'instagram') as 'instagram' | 'threads' | 'facebook';
    try {
      const caption = await generateCaption({gemini: k.gemini, openai: k.openai}, meta.title, meta.narrations, platform);
      // CC BY 하이라이트는 캡션에도 출처를 붙인다(저작권 표기 의무).
      const attr = readAttribution(id);
      let finalCaption = attr && !caption.includes(attr) ? (caption + '\n\n' + attr) : caption;
      // 쇼핑 쇼츠는 구매 링크(+제휴 고지)를 캡션 끝에 — 인스타·페북·스레드 공용.
      const cta = readProductCta(id);
      if (cta && !finalCaption.includes(cta)) finalCaption = finalCaption + '\n\n' + cta;
      return json(res, 200, {caption: finalCaption, productUrl: (listPortfolio().find((x) => x.projectId === id)?.productUrl || '')});
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
    const accountId = String(b.accountId || '').trim() || undefined;
    try {
      const url = await presignGet(r2key, 3600);
      if (!url) return json(res, 502, {error: '영상 임시 링크 생성 실패.'});
      // ★커버 지정(내 완성작만) — 빈 썸네일 방지. 실패해도 업로드는 진행.
      let coverUrl: string | undefined;
      if (!isSample) { try { coverUrl = (await ensureThumbJpegUrl(id)) || undefined; } catch {} }
      const r = await publishVideo(url, caption, kind as 'reels' | 'feed', undefined, coverUrl, accountId);
      // ★배지: 게시 성공 시 permalink 기록(어느 경로든 IG 배지 뜨게). 샘플/내작품 분기.
      if (r.permalink) {
        if (isSample) setSampleInstagram(path.basename(id.slice('sample:'.length)), r.permalink);
        else { setPortfolioInstagram(id, r.permalink); saveProjectInstagram(id, r.permalink); }
      }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }

  // ── 페이스북 페이지 발송 (인스타·유튜브와 동일 플로우) ──
  if (p === '/api/facebook/status' && req.method === 'GET') return json(res, 200, facebookStatus());
  if (p === '/api/facebook/activity' && req.method === 'GET') return json(res, 200, await getFbActivity());
  if (p === '/api/facebook/stats' && req.method === 'GET') {
    const debug = u.searchParams.get('debug') === '1';
    if (!facebookStatus().connected) return json(res, 200, {connected: false, items: [], summary: null, ...(debug ? {debug: ['연결 안 됨(status)']} : {})});
    const fc = cachedStats('facebook', debug); if (fc) return json(res, 200, fc);
    const sampleFb = loadSampleFacebook();
    const withUrl = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.facebookUrl || readProjectFacebook(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleFb[s.file] || ''})),
    ].filter((x) => x.url);
    if (!withUrl.length) return json(res, 200, {connected: true, items: [], summary: null, ...(debug ? {debug: ['올린 영상 중 facebookUrl 저장된 게 없음']} : {})});
    const diag: string[] = [];
    let stats: Record<string, any> = {};
    try { stats = await getFbStats(debug ? diag : undefined); }
    catch (e: any) { diag.push('페북 성과 조회 실패(목록만 표시): ' + (e?.message || e)); }
    if (debug) {
      const keys = Object.keys(stats);
      diag.push(`우리가 저장한 facebookUrl ${withUrl.length}개: ${withUrl.map((x) => x.url).slice(0, 5).join(' , ')}`);
      diag.push(`Meta가 돌려준 permalink ${keys.length}개: ${keys.slice(0, 5).join(' , ')}`);
      diag.push(`permalink 매칭 성공 ${withUrl.filter((x) => stats[x.url]).length}/${withUrl.length}개 (0이면 키 불일치 / videos 0개면 권한·릴스 문제)`);
    }
    const items = withUrl.map((x) => ({...x, ...{views: 0, likes: 0, comments: 0, shares: 0, reactions: 0}, ...(stats[x.url] || {})}))
      .sort((a: any, b: any) => b.views - a.views || b.likes - a.likes);
    const fbBody = {connected: true, items, summary: perfSummary(items, ['shares', 'reactions']), ...(debug ? {debug: diag} : {})};
    putStats('facebook', debug, fbBody);
    return json(res, 200, fbBody);
  }
  if (p === '/api/facebook/connect' && req.method === 'POST') {
    const b = await readBody(req);
    const pageId = String(b.pageId || '').trim();
    const pageAccessToken = String(b.pageAccessToken || '').trim();
    const label = String(b.label || '').trim() || undefined;
    if (!pageId || !pageAccessToken) return json(res, 400, {error: '페이지 ID와 페이지 액세스 토큰을 입력하세요.'});
    try {
      const pageName = await verifyFacebook({pageId, pageAccessToken});
      const acc = addFacebook({pageId, pageAccessToken, pageName, label});
      return json(res, 200, {connected: true, pageName, id: acc.id, label: acc.label});
    } catch (e: any) { return json(res, 400, {error: e.message}); }
  }
  // 페북 계정(페이지) 삭제/이름변경(멀티계정)
  if (p.startsWith('/api/facebook/accounts/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/facebook/accounts/'.length));
    removeFacebook(id);
    return json(res, 200, {ok: true, accounts: facebookStatus().accounts});
  }
  if (p.startsWith('/api/facebook/accounts/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/facebook/accounts/'.length));
    const b = await readBody(req);
    renameFacebook(id, String(b.label || '').trim());
    return json(res, 200, {ok: true, accounts: facebookStatus().accounts});
  }
  // 카드 게시물(여러 장 사진) 페북 업로드 — JPEG 변환 후 publishPhotos.
  if (p.startsWith('/api/facebook/upload-photos/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/facebook/upload-photos/'.length));
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '올릴 수 없는 항목입니다.'});
    const item = listPortfolio().find((x) => x.projectId === id && x.kind === 'card-post');
    if (!item) return json(res, 404, {error: '카드 게시물을 찾을 수 없습니다.'});
    if (!facebookStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 페이스북 페이지를 연결하세요.'});
    const b = await readBody(req);
    const caption = String(b.caption || '').trim();
    const accountId = String(b.accountId || '').trim() || undefined;
    try {
      const urls = await ensureCarouselJpegUrls(id, () => {});
      const r = await fbPublishPhotos(urls, caption, undefined, accountId);
      if (r.permalink) { setPortfolioFacebook(id, r.permalink); saveProjectFacebook(id, r.permalink); }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }
  // 페북 영상 업로드 — 완성 영상이 R2에 있어야 함(공개 presigned URL 필요).
  if (p.startsWith('/api/facebook/upload/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/facebook/upload/'.length));
    const isSample = id.startsWith('sample:');
    if (!isSample && !/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '올릴 수 없는 영상입니다.'});
    if (!facebookStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 페이스북 페이지를 연결하세요.'});
    const r2key = await ensureInstaVideoR2(id); // 인스타와 같은 R2 백필 재사용
    if (!r2key) return json(res, 400, {error: '영상 파일을 찾을 수 없어요. 너무 오래돼 정리됐을 수 있어요 — 다시 제작해 주세요.'});
    const b = await readBody(req);
    const caption = String(b.caption || '').trim();
    const accountId = String(b.accountId || '').trim() || undefined;
    try {
      const url = await presignGet(r2key, 3600);
      if (!url) return json(res, 502, {error: '영상 임시 링크 생성 실패.'});
      const r = await fbPublishVideo(url, caption, undefined, accountId);
      if (r.permalink) {
        if (isSample) setSampleFacebook(path.basename(id.slice('sample:'.length)), r.permalink);
        else { setPortfolioFacebook(id, r.permalink); saveProjectFacebook(id, r.permalink); }
      }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }

  // ── 스레드(Threads) 발송 (인스타·페북과 동일 플로우, 링크 자유롭게 붙음) ──
  if (p === '/api/threads/status' && req.method === 'GET') return json(res, 200, threadsStatus());
  if (p === '/api/threads/activity' && req.method === 'GET') return json(res, 200, await getThActivity());
  if (p === '/api/threads/stats' && req.method === 'GET') {
    const debug = u.searchParams.get('debug') === '1';
    if (!threadsStatus().connected) return json(res, 200, {connected: false, items: [], summary: null, ...(debug ? {debug: ['연결 안 됨(status)']} : {})});
    const tc = cachedStats('threads', debug); if (tc) return json(res, 200, tc);
    const sampleTh = loadSampleThreads();
    const withUrl = [
      ...listPortfolio().map((it) => ({id: it.projectId, title: it.title, voice: it.voice, category: it.category, goal: it.goal, url: it.threadsUrl || readProjectThreads(it.projectId)})),
      ...SAMPLES.map((s) => ({id: 'sample:' + s.file, title: s.title, voice: s.voice, category: s.category, goal: s.goal, url: sampleTh[s.file] || ''})),
    ].filter((x) => x.url);
    if (!withUrl.length) return json(res, 200, {connected: true, items: [], summary: null, ...(debug ? {debug: ['올린 영상 중 threadsUrl 저장된 게 없음']} : {})});
    const diag: string[] = [];
    let stats: Record<string, any> = {};
    try { stats = await getThreadsStats(debug ? diag : undefined); }
    catch (e: any) { diag.push('스레드 성과 조회 실패(목록만 표시): ' + (e?.message || e)); }
    const items = withUrl.map((x) => ({...x, ...{views: 0, likes: 0, comments: 0, shares: 0, reposts: 0, quotes: 0}, ...(stats[x.url] || {})}))
      .sort((a: any, b: any) => b.views - a.views || b.likes - a.likes);
    const thBody = {connected: true, items, summary: perfSummary(items, ['shares', 'reposts', 'quotes']), ...(debug ? {debug: diag} : {})};
    putStats('threads', debug, thBody);
    return json(res, 200, thBody);
  }
  // 스레드 앱 자격(App ID/Secret) 저장 — 유튜브 config와 동일(한 번만).
  if (p === '/api/threads/config' && req.method === 'POST') {
    const b = await readBody(req);
    const appId = String(b.appId || '').trim();
    const appSecret = String(b.appSecret || '').trim();
    if (!appId && !appSecret) return json(res, 400, {error: '앱 ID/시크릿을 입력하세요.'});
    saveThreadsClient(appId, appSecret);
    return json(res, 200, {ok: true, hasClient: threadsStatus().hasClient});
  }
  // 스레드 동의 창 URL(유튜브 auth와 동일) — 버튼 누르면 로그인·허용 → 콜백에서 자동 저장.
  if (p === '/api/threads/auth' && req.method === 'GET') {
    try {
      const redirectUri = `${ytProto(req)}://${req.headers.host}/api/threads/callback`;
      return json(res, 200, {url: threadsAuthUrl(redirectUri)});
    } catch (e: any) { return json(res, 400, {error: e.message}); }
  }
  if (p.startsWith('/api/threads/accounts/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/threads/accounts/'.length));
    removeThreads(id);
    return json(res, 200, {ok: true, accounts: threadsStatus().accounts});
  }
  if (p.startsWith('/api/threads/accounts/') && req.method === 'PATCH') {
    const id = decodeURIComponent(p.slice('/api/threads/accounts/'.length));
    const b = await readBody(req);
    renameThreads(id, String(b.label || '').trim());
    return json(res, 200, {ok: true, accounts: threadsStatus().accounts});
  }
  // 스레드 영상 게시 — 완성 영상이 R2에 있어야 함(공개 presigned URL). text=글(500자), link=붙일 링크(온파트너 등).
  if (p.startsWith('/api/threads/upload/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/threads/upload/'.length));
    const isSample = id.startsWith('sample:');
    if (!isSample && !/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '올릴 수 없는 영상입니다.'});
    if (!threadsStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 스레드 계정을 연결하세요.'});
    const r2key = await ensureInstaVideoR2(id); // 인스타·페북과 같은 R2 백필 재사용
    if (!r2key) return json(res, 400, {error: '영상 파일을 찾을 수 없어요. 너무 오래돼 정리됐을 수 있어요 — 다시 제작해 주세요.'});
    const b = await readBody(req);
    const caption = String(b.caption || b.text || '').trim();
    // 링크: 사용자가 입력하면 그걸, 없으면 쇼핑 쇼츠 구매링크(포폴 productUrl)를 자동으로 붙인다.
    const autoProd = !isSample ? (listPortfolio().find((x) => x.projectId === id)?.productUrl || '') : '';
    const link = (String(b.link || '').trim() || autoProd) || undefined;
    const accountId = String(b.accountId || '').trim() || undefined;
    try {
      const url = await presignGet(r2key, 3600);
      if (!url) return json(res, 502, {error: '영상 임시 링크 생성 실패.'});
      const r = await thPublishVideo(url, caption, undefined, accountId, link);
      if (r.permalink) {
        if (isSample) setSampleThreads(path.basename(id.slice('sample:'.length)), r.permalink);
        else { setPortfolioThreads(id, r.permalink); saveProjectThreads(id, r.permalink); }
      }
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }
  // 스레드 글(텍스트+링크) 게시 — 영상 없이 글만(쇼핑 글 등).
  if (p === '/api/threads/post-text' && req.method === 'POST') {
    if (!threadsStatus().connected) return json(res, 400, {error: '먼저 키 설정에서 스레드 계정을 연결하세요.'});
    const b = await readBody(req);
    const text = String(b.text || b.caption || '').trim();
    const link = String(b.link || '').trim() || undefined;
    const accountId = String(b.accountId || '').trim() || undefined;
    if (!text && !link) return json(res, 400, {error: '글 내용이나 링크를 입력하세요.'});
    try {
      const r = await thPublishText(text, undefined, accountId, link);
      return json(res, 200, r);
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }

  // ───────── 🧵 스레드 스튜디오(다계정): 주제→글 / 이미지 생성 / 선택 계정 일괄 발행 ─────────
  // 주제·느낌 또는 직접 글감 → 스레드 전용 글 생성(generateCaption platform=threads 재사용).
  if (p === '/api/social/compose' && req.method === 'POST') {
    const b = await readBody(req);
    const topic = String(b.topic || '').trim();
    const pfRaw = String(b.platform || 'threads').toLowerCase();
    const platform = (pfRaw === 'instagram' || pfRaw === 'facebook' ? pfRaw : 'threads') as 'instagram' | 'threads' | 'facebook';
    if (!topic) return json(res, 400, {error: '주제나 내용을 입력하세요.'});
    const k = pipelineKeys();
    try {
      const text = await generateCaption({gemini: k.gemini, openai: k.openai}, topic, [], platform);
      return json(res, 200, {text});
    } catch (e: any) { return json(res, 502, {error: '글 생성 실패: ' + e.message}); }
  }
  // 글에 어울리는 이미지 생성 → R2 저장 → 공개 URL 반환. imageKey로 발행 때 다시 presign.
  if (p === '/api/social/image' && req.method === 'POST') {
    const b = await readBody(req);
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return json(res, 400, {error: '이미지 설명을 입력하세요.'});
    if (!r2Enabled()) return json(res, 400, {error: '이미지 저장(R2)이 설정되지 않았습니다.'});
    const k = pipelineKeys();
    const tmp = path.join(os.tmpdir(), `social-${randomUUID()}.jpg`);
    try {
      await generateImageSmart({fal: k.fal, replicate: k.replicate}, prompt, tmp, undefined, 'high', 'real', false);
      const key = `social/${randomUUID()}.jpg`;
      const ok = await uploadFile(key, tmp, 'image/jpeg');
      if (!ok) return json(res, 502, {error: '이미지 업로드 실패'});
      const url = await presignGet(key, 3600);
      return json(res, 200, {url, key});
    } catch (e: any) { return json(res, 502, {error: '이미지 생성 실패: ' + e.message}); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  // 선택한 여러 계정에 같은 글(+이미지/링크)을 순차 발행. 계정별 성공/실패를 모아 돌려준다.
  if (p === '/api/social/publish' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    const link = String(b.link || '').trim() || undefined;
    const imageKey = String(b.imageKey || '').trim();
    const accountIds: string[] = Array.isArray(b.accountIds) ? b.accountIds.map((x: any) => String(x)).filter(Boolean) : [];
    if (!accountIds.length) return json(res, 400, {error: '올릴 계정을 하나 이상 선택하세요.'});
    if (!text && !imageKey) return json(res, 400, {error: '글이나 이미지를 넣으세요.'});
    let imageUrl: string | undefined;
    if (imageKey) {
      imageUrl = (await presignGet(imageKey, 3600)) || undefined;
      if (!imageUrl) return json(res, 502, {error: '이미지 링크 생성 실패'});
    }
    const results: {accountId: string; ok: boolean; permalink?: string; error?: string}[] = [];
    for (const aid of accountIds) {
      try {
        const r = imageUrl
          ? await thPublishImage(imageUrl, text, undefined, aid, link)
          : await thPublishText(text, undefined, aid, link);
        results.push({accountId: aid, ok: true, permalink: r.permalink});
      } catch (e: any) { results.push({accountId: aid, ok: false, error: e.message}); }
    }
    return json(res, 200, {results});
  }

  // ── 🎛 방송콘솔 배치 송출 — 선택한 영상 N개를 선택한 계정(스레드·인스타·페북) 전부에 순차 발행.
  //    job+SSE(/api/progress)로 계정별 실시간 로그, /api/generate/cancel로 정지/취소(재사용),
  //    skip(이미 성공한 작업 키)으로 '이어하기'(취소 후 미발행분만). 각 플랫폼 발행은 기존
  //    업로드 핸들러(인스타/페북/스레드)와 '똑같은' 경로(ensureInstaVideoR2→presignGet→publish)를 재사용. ──
  if (p === '/api/social/broadcast' && req.method === 'POST') {
    const b = await readBody(req);
    const videoIds: string[] = (Array.isArray(b.videoIds) ? b.videoIds : []).map((x: any) => String(x)).filter(Boolean);
    const T = b.targets || {};
    const tg = {
      instagram: (Array.isArray(T.instagram) ? T.instagram : []).map((x: any) => String(x)).filter(Boolean),
      facebook: (Array.isArray(T.facebook) ? T.facebook : []).map((x: any) => String(x)).filter(Boolean),
      threads: (Array.isArray(T.threads) ? T.threads : []).map((x: any) => String(x)).filter(Boolean),
    };
    const nAcc = tg.instagram.length + tg.facebook.length + tg.threads.length;
    if (!videoIds.length) return json(res, 400, {error: '송출할 영상을 하나 이상 선택하세요.'});
    if (!nAcc) return json(res, 400, {error: '올릴 계정을 하나 이상 선택하세요.'});
    const skip = new Set<string>((Array.isArray(b.skip) ? b.skip : []).map((x: any) => String(x))); // 이어하기: 이미 성공한 작업 키

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'broadcast'};
    jobs.set(id, job);
    currentGenJob = id;

    (async () => { // 방송콘솔 발행은 ffmpeg·크로뮴을 안 쓰므로 제작 큐에 넣지 않는다(즉시 발행).
      const k = pipelineKeys();
      const igNames: Record<string, string> = {}; for (const a of listInstagram()) igNames[a.id] = a.label || a.username || a.id;
      const fbNames: Record<string, string> = {}; for (const a of listFacebook()) fbNames[a.id] = a.label || a.pageName || a.id;
      const thNames: Record<string, string> = {}; for (const a of ((threadsStatus() as any).accounts || [])) thNames[a.id] = a.label || a.username || a.id;
      const icon = (pl: string) => pl === 'instagram' ? '📷' : pl === 'facebook' ? '👍' : '🧵';
      const nameOf = (pl: string, aid: string) => (pl === 'instagram' ? igNames[aid] : pl === 'facebook' ? fbNames[aid] : thNames[aid]) || aid;
      // 실행 계획: 영상 × (계정 플랫폼별). 취소/이어하기의 단위가 되는 'key'로 식별.
      const plans: {vid: string; platform: 'instagram' | 'facebook' | 'threads'; aid: string}[] = [];
      for (const vid of videoIds) {
        for (const aid of tg.instagram) plans.push({vid, platform: 'instagram', aid});
        for (const aid of tg.facebook) plans.push({vid, platform: 'facebook', aid});
        for (const aid of tg.threads) plans.push({vid, platform: 'threads', aid});
      }
      const total = plans.length;
      let done = 0, ok = 0, fail = 0;
      const remaining: string[] = []; // 취소/실패로 안 된 작업 키(이어하기용)
      // 영상당 1회만 계산(공개 URL·커버), 영상×플랫폼당 1회만 캡션 생성.
      const urlCache = new Map<string, string>();
      const coverCache = new Map<string, string | undefined>();
      const capCache = new Map<string, string>();
      const videoTitle = (vid: string) => (resolveVideo(vid)?.title || listPortfolio().find((x) => x.projectId === vid)?.title || vid);
      jlog(job, '──────── 방송콘솔 송출 시작 ────────');
      jlog(job, `• 영상 ${videoIds.length}개 × 계정 ${nAcc}개 = 총 ${total}건`);
      jlog(job, `• 대상: 📷 인스타 ${tg.instagram.length} · 👍 페북 ${tg.facebook.length} · 🧵 스레드 ${tg.threads.length}`);
      try {
        for (const plan of plans) {
          const key = `${plan.vid}|${plan.platform}|${plan.aid}`;
          const nm = nameOf(plan.platform, plan.aid);
          if (job.cancelled) { remaining.push(key); continue; }
          if (skip.has(key)) { done++; ok++; jlog(job, `${icon(plan.platform)} ${nm} ⏭ 이미 완료 — 건너뜀 (${done}/${total})`); continue; }
          done++;
          const pct = Math.round((done / total) * 100);
          jlog(job, `${icon(plan.platform)} ${nm} ⏳ 발행 중… · "${videoTitle(plan.vid).slice(0, 24)}" (${done}/${total} · ${pct}%)`);
          try {
            // 1) 영상 공개 URL(영상당 1회) — 기존 업로드 핸들러와 동일 경로.
            let url = urlCache.get(plan.vid);
            if (!url) {
              const r2key = await ensureInstaVideoR2(plan.vid);
              if (!r2key) throw new Error('영상 파일을 찾을 수 없어요(오래돼 정리됐을 수 있음) — 다시 제작해 주세요.');
              url = (await presignGet(r2key, 3600)) || '';
              if (!url) throw new Error('영상 임시 링크 생성 실패.');
              urlCache.set(plan.vid, url);
            }
            // 2) 캡션(영상×플랫폼당 1회) — 플랫폼마다 다른 글 + 출처/구매링크.
            const capKey = `${plan.vid}|${plan.platform}`;
            let caption = capCache.get(capKey);
            if (caption === undefined) {
              const src = resolveVideo(plan.vid);
              try { caption = src ? await generateCaption({gemini: k.gemini, openai: k.openai}, src.title, src.narrations, plan.platform) : (videoTitle(plan.vid)); }
              catch { caption = videoTitle(plan.vid); }
              const attr = readAttribution(plan.vid);
              if (attr && !caption.includes(attr)) caption += '\n\n' + attr;
              const cta = readProductCta(plan.vid);
              if (cta && !caption.includes(cta)) caption += '\n\n' + cta;
              capCache.set(capKey, caption);
            }
            // 3) 발행(플랫폼별) — 기존 핸들러와 같은 함수·배지 기록.
            let r: {permalink: string; id: string};
            if (plan.platform === 'instagram') {
              let cover = coverCache.get(plan.vid);
              if (cover === undefined) { try { cover = (await ensureThumbJpegUrl(plan.vid)) || undefined; } catch { cover = undefined; } coverCache.set(plan.vid, cover); }
              r = await publishVideo(url, caption, 'reels', undefined, cover, plan.aid);
              if (r.permalink) { setPortfolioInstagram(plan.vid, r.permalink); saveProjectInstagram(plan.vid, r.permalink); }
            } else if (plan.platform === 'facebook') {
              r = await fbPublishVideo(url, caption, undefined, plan.aid);
              if (r.permalink) { setPortfolioFacebook(plan.vid, r.permalink); saveProjectFacebook(plan.vid, r.permalink); }
            } else {
              const link = (listPortfolio().find((x) => x.projectId === plan.vid)?.productUrl) || undefined;
              r = await thPublishVideo(url, caption, undefined, plan.aid, link);
              if (r.permalink) { setPortfolioThreads(plan.vid, r.permalink); saveProjectThreads(plan.vid, r.permalink); }
            }
            ok++;
            jlog(job, `${icon(plan.platform)} ${nm} ✅ 완료 ${r.permalink || ''}`);
          } catch (e: any) {
            fail++; remaining.push(key);
            // Meta subcode·원문 그대로(뭉개기 금지, 테리 규칙).
            jlog(job, `${icon(plan.platform)} ${nm} ❌ 실패 — ${(e?.message || String(e)).slice(0, 400)}`);
          }
        }
        job.remaining = remaining;
        if (job.cancelled) {
          jlog(job, '──────── ⏹ 취소됨 ────────');
          jlog(job, `총 ${total}건 중 ✅ ${ok}건 발행 · ${remaining.length}건 미발행. '이어하기'를 누르면 미발행분부터 다시 보냅니다.`);
        } else {
          jlog(job, '──────── 🎉 송출 완료 ────────');
          jlog(job, `총 ${total}건: ✅ ${ok}건 · ❌ ${fail}건${fail ? " (실패분은 '이어하기'로 재시도)" : ''}`);
        }
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.remaining = remaining; job.error = e.message; job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + (e?.message || e));
      }
    })();

    return json(res, 202, {id});
  }
  // 방송콘솔 '이어하기'용 — 취소/실패로 안 된 작업 키 목록(끝난 job에서 조회).
  if (p.startsWith('/api/social/broadcast/remaining/') && req.method === 'GET') {
    const jid = decodeURIComponent(p.slice('/api/social/broadcast/remaining/'.length));
    const j = jobs.get(jid);
    if (!j) return json(res, 404, {error: '작업을 찾을 수 없습니다(서버 재시작 시 사라질 수 있어요).'});
    return json(res, 200, {remaining: j.remaining || [], done: j.done});
  }

  // ── 상품 조회(쇼핑 쇼츠용) — 온파트너 제휴링크(/r/{code}) 또는 온종일팜 다이렉트 상품페이지 둘 다 자동판별 ──
  if (p === '/api/partner/product' && req.method === 'GET') {
    const input = (u.searchParams.get('code') || u.searchParams.get('url') || '').trim();
    if (!input) return json(res, 400, {error: '온파트너 링크(.../r/코드) 또는 온종일팜 상품페이지 주소를 입력하세요.'});
    try {
      const product = await resolveProduct(input);
      return json(res, 200, {ok: true, product});
    } catch (e: any) { return json(res, 502, {error: e.message}); }
  }

  // ── 포트폴리오 삭제(관리, 로그인 필요) ──
  if (p.startsWith('/api/portfolio/') && req.method === 'PATCH') {
    const id = p.slice('/api/portfolio/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    if (!title) return json(res, 400, {error: '제목을 입력하세요.'});
    const ok = updatePortfolioTitle(id, title);
    if (!ok) return json(res, 404, {error: '영상을 찾을 수 없습니다.'});
    return json(res, 200, {ok: true, title: title.slice(0, 200)});
  }
  if (p.startsWith('/api/portfolio/') && req.method === 'DELETE') {
    const id = p.slice('/api/portfolio/'.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, {error: '잘못된 요청'});
    // ★진짜로 삭제 — 목록만 지우면 R2 영상·썸네일·볼륨 폴더가 남아 '저장료·볼륨 꽉참'의 원인이 됐다(테리 지적).
    //   ① project.json에서 R2 키를 읽어 ② R2 영상·썸네일 삭제 ③ 볼륨 작업폴더 통째 삭제 ④ 목록에서 제거.
    try {
      const pj = path.join(STUDIO_DATA_DIR, 'studio', id, 'project.json');
      if (fs.existsSync(pj)) {
        const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const keys = [proj.outputR2, proj.thumbR2, proj.sourceR2, proj.narrationR2, ...(Array.isArray(proj.imagesR2) ? proj.imagesR2 : [])].filter(Boolean);
        for (const k of keys) { try { await deleteR2Key(k); } catch {} }
      }
      try { fs.rmSync(path.join(STUDIO_DATA_DIR, 'studio', id), {recursive: true, force: true}); } catch {}
    } catch {}
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
  // 재사용 가능한(크리에이티브 커먼즈) 유튜브 영상 검색 — 하이라이트 숏폼 소재용.
  if (p === '/api/yt-search' && req.method === 'GET') {
    const q = u.searchParams.get('q') || '';
    if (!q.trim()) return json(res, 400, {error: '검색어를 입력하세요.'});
    // 지역: 한국(KR/ko) / 해외(US/en). 기본 한국.
    const region = u.searchParams.get('region') === 'global' ? 'US' : 'KR';
    const language = region === 'US' ? 'en' : 'ko';
    const order = u.searchParams.get('order') || 'viewCount'; // 조회수순 기본(잘나가는 것 위로)
    const pageToken = u.searchParams.get('pageToken') || undefined; // 더보기(다음 페이지)
    // 라이선스 범위: all=전체 영상(풀 넓음·저작권 주의) / 그 외=CC(기본·안전=원작자가 재사용 허락한 것만).
    const license = u.searchParams.get('license') === 'all' ? 'any' : 'cc';
    try {
      // 하이라이트 소재로 적합한 길이만(2분~60분). 쇼츠·장편 제외. 한 페이지 40개씩.
      const r = await searchCreativeCommons(q, {max: 40, minSec: 120, maxSec: 3600, region, language, order, pageToken, license});
      return json(res, 200, {videos: r.videos, nextPageToken: r.nextPageToken});
    } catch (e: any) {
      return json(res, 502, {error: e?.message || '검색 실패'});
    }
  }
  // ── 아카이브 긁기(📼 아카이브 탭) — 특정 방송 아카이브 채널에서 주제로 영상 목록을 가져온다. ──
  //   소스는 화이트리스트로만(임의 채널 긁기 방지). 실제 숏폼/롱폼 제작은 기존 하이라이트 엔진 재사용.
  // ── 이미 하이라이트로 쓴 소재(sourceKey) 목록 — 검색결과에 '✓ 사용함' 배지용(중복 방지) ──
  if (p === '/api/archive/used' && req.method === 'GET') {
    const sourceKeys = Array.from(new Set(listPortfolio().map((x) => x.sourceKey).filter(Boolean)));
    return json(res, 200, {sourceKeys});
  }
  if (p === '/api/archive-search' && req.method === 'GET') {
    // 소스 화이트리스트(임의 채널 긁기 방지). label=짧게, search=채널내 검색 지원 여부(안되면 /videos 전체).
    const ARCHIVE_CHANNELS: Record<string, {channel: string; label: string; search: boolean}> = {
      kbs: {channel: 'KBSArchive', label: '옛날티비', search: true},
      // ★KBS 교양(인간극장·아침마당·토크·충격실화) — 말 위주라 유튜브 음원 ContentID가 안 걸리는 '안전 금광'(테리 지시, 로컬 yt-dlp 실측 OK).
      //   한글 핸들이라 @검색이 안 먹혀 채널ID로 지정.
      kbscult: {channel: 'id:UCHlSeJxRIXZWMARC2oMwmcQ', label: 'KBS 교양', search: true},
      kbsdrama: {channel: 'KBSdrama', label: 'KBS 드라마', search: true},
      kbsnews: {channel: 'newskbs', label: 'KBS 뉴스', search: true},
      ktvarchive: {channel: 'KTV_archive', label: 'KTV 근현대사', search: true}, // 한국정책방송원 공개 아카이브(근현대사·추억) 300+편.
      // ★한국군 액션 — 국군 공식 채널. 정부 제작물은 공공누리(출처표시로 상업·변형 OK). 한국어라 재창작 없이 바로 사용.
      //   해병대=상륙·강하·산악전 액션 금광. 로컬 yt-dlp 실측 OK(테리 지시). 육군훈련소는 한글핸들이라 채널ID로.
      rokmc: {channel: 'rokmchq', label: '대한민국 해병대', search: true},
      katc: {channel: 'id:UC_FGopKf5IVUpGs4EFb-pSQ', label: '육군훈련소', search: true},
      kfn: {channel: 'id:UCXNMgSZqmfX1_K8Uf4l4sog', label: '국방부 전쟁다큐(KFN)', search: true},
      mnd: {channel: 'id:UCoreZRRtVpu521wZNJWfUqQ', label: '국방부', search: true},
      // ★경찰·소방·해경 — 실화 추격·구조 액션. 공공누리(출처표시로 상업 OK). 300+편 실측.
      police: {channel: 'id:UC7-PyZbi_QIthI3WFtopzLw', label: '경찰청', search: true},
      fire: {channel: 'id:UCbPBCZhgG_kX_1Wb0cdu5lw', label: '소방청', search: true},
      coastguard: {channel: 'id:UCl6GW0nhB6UIL05h2oF3vRA', label: '해양경찰청', search: true},
      // ★해외 액션(퍼블릭 도메인) — 미군/미정부 제작물은 세금으로 만든 '퍼블릭 도메인'이라 저작권 0(전투·훈련·미사일·상륙).
      //   영어 영상이라 '재창작'으로 한국어 나레이션 얹어 쓰는 걸 추천. 로컬 yt-dlp 실측 OK(테리 지시).
      dvids: {channel: 'id:UC7oc5q7BkRIlfgsDzwJQnCw', label: '미군 종합(DVIDS)', search: true}, // user/dvidshub 본채널(300+편). @DVIDSVIDEO는 8편뿐 서브라 폐기.
      usmc: {channel: 'marines', label: '미 해병대', search: true},
      usarmy: {channel: 'USArmy', label: '미 육군', search: true},
      ebs: {channel: 'EBSDocumentary', label: 'EBS 다큐', search: true},
      mbc: {channel: 'MBCentertainment', label: 'MBC 예능', search: true}, // MBC 예능(구해줘홈즈 등) — 모던코리아는 공개영상 1개뿐이라 제외
      // ★MBC 미스터리(공식, 101만 구독) = 신비한TV 서프라이즈 + 심야괴담회. '진짜 미스터리'(실제 미제사건·
      //   초자연·심령·외계인·실화 괴담)가 가득 — KBS 아카이브엔 없는 장르라 전용 소스로 추가(테리 지시).
      mbcmystery: {channel: 'mbcmystery', label: 'MBC 미스터리', search: true},
      // ★옛날 가요(90~2000년대 아이돌) — KBS 옛날티비엔 적다. 방송사 공식 K-pop 채널 추가(테리 지시, 로컬 실측).
      //   MBCkpop(음악캠프/음악중심)이 신화·핑클·god 등 '원본 무대'가 제일 많다. 채널 내 가수명 검색이 잘 먹힘.
      mbckpop: {channel: 'MBCkpop', label: 'MBC 음악캠프(옛날가요)', search: true},
      kbskpop: {channel: 'KBSKpop', label: 'KBS 뮤직뱅크', search: true},
      sbskpop: {channel: 'SBSKPOP', label: 'SBS 인기가요', search: true},
    };
    const src = u.searchParams.get('src') || 'kbs';
    const q = (u.searchParams.get('q') || '').trim();
    const offset = Math.max(0, Math.min(5000, Number(u.searchParams.get('offset')) || 0)); // 더 보기 페이지네이션
    const batch = 60; // 한 번에 60개(flat 긁기는 빨라서 체감 즉시)
    const srcInfo = ARCHIVE_CHANNELS[src];
    if (!srcInfo) return json(res, 400, {error: '알 수 없는 아카이브 소스입니다.'});
    // ★빈 쿼리도 허용 — searchArchiveChannel이 /videos(채널 최신 전체목록)로 폴백한다.
    //   단일 장르 채널(뉴스·드라마·다큐·예능)은 탭만 눌러도 바로 영상이 뜨게 한다(테리 지시).
    try {
      const videos = await searchArchiveChannel(srcInfo.channel, q, batch, () => {}, offset);
      // 받은 개수가 요청(batch)만큼이면 더 있을 가능성 → hasMore + nextOffset.
      const hasMore = videos.length >= batch;
      return json(res, 200, {videos, source: srcInfo.label, offset, nextOffset: offset + videos.length, hasMore});
    } catch (e: any) {
      return json(res, 502, {error: e?.message || '아카이브 긁기 실패'});
    }
  }

  // ── 영상 1개 메타 조회(URL 붙여넣기 모드) — 붙여넣은 롱폼의 제목·길이·CC여부를 확인 ──
  if (p === '/api/yt-video' && req.method === 'GET') {
    const raw = (u.searchParams.get('url') || u.searchParams.get('id') || '').trim();
    const id = /^[\w-]{11}$/.test(raw) ? raw : extractVideoId(raw);
    if (!id) return json(res, 400, {error: '유튜브 영상 URL을 확인하세요. (예: youtube.com/watch?v=… 또는 youtu.be/…)'});
    try {
      const m = await getVideoMeta(id);
      return json(res, 200, m);
    } catch (e: any) {
      return json(res, 502, {error: e?.message || '조회 실패'});
    }
  }
  // ── 세로변환 방식 추천 — 영상을 파악해 '꽉채움(track) vs 전체보존(letterbox)' 중 어울리는 쪽 추천 ──
  //   업로드 영상은 로컬 파일로, 유튜브/아카이브는 가벼운 360p 샘플을 받아 얼굴 분석. 실패 시 추천 생략(null).
  if (p === '/api/highlight/reframe-advice' && req.method === 'GET') {
    const videoId = (u.searchParams.get('videoId') || '').trim();
    const uploadId = (u.searchParams.get('uploadId') || '').trim();
    const tmpDir = path.join(os.tmpdir(), 'rfa-' + randomUUID().slice(0, 8));
    try {
      fs.mkdirSync(tmpDir, {recursive: true});
      let file: string | null = null, cleanup = false;
      if (uploadId && /^[\w-]{12}$/.test(uploadId)) {
        const found = fs.existsSync(HL_UPLOAD_DIR) ? fs.readdirSync(HL_UPLOAD_DIR).find((f) => f.startsWith(uploadId + '.')) : undefined;
        if (found) {
          // ★전체(수십 분)를 분석하면 느리다 → 중간 15초만 360p로 떠서 분석(대표성 충분·빠름).
          const src = path.join(HL_UPLOAD_DIR, found);
          const sample = path.join(tmpDir, 'sample.mp4');
          const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
          const ffprobe = process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg$/, 'ffprobe');
          // 영상 길이 파악 → 중앙부(여러 장면이 섞인 대표 구간)에서 25초를 샘플. 짧으면 처음부터.
          let dur = 0;
          try { dur = Math.floor(Number(cpExecFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], {timeout: 15000}).toString().trim()) || 0); } catch {}
          const ss = dur > 60 ? Math.floor(dur * 0.4) : 5;
          try {
            cpExecFileSync(ffmpeg, ['-y', '-ss', String(ss), '-t', '25', '-i', src, '-vf', 'scale=640:-2', '-an',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', sample], {timeout: 60000});
            file = fs.existsSync(sample) ? sample : src; cleanup = true;
          } catch { file = src; } // 샘플 실패 시 원본(느려도 동작)
        }
      } else if (/^[\w-]{11}$/.test(videoId)) {
        file = await sampleForAnalysis(videoId, tmpDir, () => {}); cleanup = true;
      }
      if (!file) return json(res, 200, {advice: null}); // 샘플 못 받으면 추천 생략(기본값 그대로)
      const advice = await analyzeReframe(file);
      if (cleanup) { try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {} }
      return json(res, 200, {advice});
    } catch (e: any) {
      try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
      return json(res, 200, {advice: null, error: (e?.message || '').slice(0, 80)});
    }
  }
  // ── 디스크 진단 — 볼륨에 뭐가 쌓였는지(어느 폴더가 큰지) 한눈에. 꽉참 원인 파악용. ──
  if (p === '/api/disk' && req.method === 'GET') {
    const force = u.searchParams.get('clean') === '1';
    if (force) runMaintenance('수동');
    return json(res, 200, diskReport(30));
  }
  // ── 🛟 R2 복구 — R2에 영상 파일은 살아있는데 포트폴리오·project.json이 끊긴 것을 되살린다. ──
  //   (삭제 오판·연결끊김으로 목록에서 사라진 영상을 R2 실제 파일로 복원. ?dry=1 미리보기.)
  if (p === '/api/portfolio-recover' && req.method === 'GET') {
    try {
      const dry = u.searchParams.get('dry') === '1';
      // ?only=8자리 로 특정 영상 하나만(재복구)도 가능.
      const only = (u.searchParams.get('only') || '').trim().toLowerCase();
      const all = await listKeys('studio/'); // R2 전체 키 + 크기
      // id별 파일 모으기
      const byId: Record<string, {key: string; size: number; name: string}[]> = {};
      for (const o of all) { const m = o.key.match(/^studio\/([0-9a-f-]{36})\/(.+)$/); if (m) (byId[m[1]] ||= []).push({key: o.key, size: o.size, name: m[2]}); }
      const livePf = listPortfolio();
      const liveIds = new Set(livePf.map((x) => x.projectId));
      // 과거 '쓰레기 복구본'(제목·설명 없이 등록된 것)은 다시 Vision으로 제목을 복원한다.
      const garbageRecoveredIds = new Set(livePf.filter((x) => x.category === '🛟 복구된 영상' || /^\(복구된 영상\)/.test(x.title || '')).map((x) => x.projectId));
      const k = pipelineKeys();
      // R2 키 → base64(썸네일 읽기용). 작은 이미지만.
      const r2Bytes = async (key: string): Promise<{mimeType: string; dataB64: string} | null> => {
        try {
          const got = await getStream(key); if (!got) return null;
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => { got.stream.on('data', (c) => chunks.push(c as Buffer)); got.stream.on('end', () => resolve()); got.stream.on('error', reject); });
          const buf = Buffer.concat(chunks);
          return {mimeType: /\.jpg$|\.jpeg$/i.test(key) ? 'image/jpeg' : 'image/png', dataB64: buf.toString('base64')};
        } catch { return null; }
      };
      let recovered = 0; const details: string[] = []; const titles: string[] = [];
      for (const [id, files] of Object.entries(byId)) {
        if (only) { if (!id.startsWith(only)) continue; } // 특정 1개 재복구 모드
        else if (liveIds.has(id) && !garbageRecoveredIds.has(id)) continue; // 정상 항목만 스킵(쓰레기 복구본은 재처리)
        // 완성 영상 파일 찾기(highlight-*.mp4 or video*.mp4). 없으면 복구 불가(소재만 남음).
        const vid = files.find((f) => /\.mp4$/.test(f.name) && !/source/.test(f.name));
        if (!vid) continue;
        const thumb = files.find((f) => /thumb.*\.png$/.test(f.name) || /cover\.jpg$/.test(f.name));
        const kind: 'highlight' | 'video' = /highlight/.test(vid.name) ? 'highlight' : 'video';
        if (dry) { recovered++; details.push(id.slice(0, 8) + ' ← ' + vid.name); continue; }
        // ★썸네일에 박힌 제목 글자를 Gemini Vision으로 읽어 '진짜 제목 + 한 줄 설명'을 복원한다.
        //   이게 있어야 업로드 때 AI가 제목·설명을 제대로 생성한다(복구본이 쓰레기가 안 됨).
        let title = ''; let desc = ''; let category = kind === 'highlight' ? '🎬 하이라이트' : '🎬 영상';
        if (thumb && k.gemini.length) {
          const img = await r2Bytes(thumb.key);
          if (img) {
            try {
              const raw = await geminiGenerate(k.gemini,
                `이 영상 썸네일/표지 이미지다. 화면 상단·중앙에 박힌 한국어 제목 글자를 '그대로, 전부' 읽어라. ` +
                `제목이 여러 줄에 걸쳐 있으면 모든 줄을 순서대로 이어서 하나의 제목으로 합쳐라(한 줄만 읽고 끊지 마라). ` +
                `"N화"처럼 편수가 보이면 제목에 포함해라. 그리고 이 영상이 뭘 담았는지 자연스러운 한 줄 설명을 만들어라. ` +
                `글자가 안 보이면 이미지 내용으로 추측한 제목을 써라. JSON만: {"title":"...","desc":"...","category":"뉴스|드라마|예능|만화|다큐|스포츠|음악|기타 중 하나"}`,
                {images: [img], json: true, maxTokens: 400, temperature: 0.4});
              const m = raw.match(/\{[\s\S]*\}/); const d = m ? JSON.parse(m[0]) : {};
              if (d.title) title = String(d.title).slice(0, 90).trim();
              if (d.desc) desc = String(d.desc).slice(0, 300).trim();
              if (d.category) category = (kind === 'highlight' ? '🎬 ' : '🎬 ') + String(d.category).trim();
            } catch {}
          }
        }
        if (!title) title = (kind === 'highlight' ? '하이라이트 영상 ' : '영상 ') + id.slice(0, 8);
        // project.json 재생성 — scenes에 복원 설명을 넣어 업로드 메타 생성이 재료를 갖게 한다.
        const dir = path.join(STUDIO_DATA_DIR, 'studio', id);
        try { fs.mkdirSync(dir, {recursive: true}); } catch {}
        const nowIso = new Date().toISOString();
        const proj: any = {
          id, title, output: vid.name, outputR2: vid.key,
          thumb: thumb ? thumb.name : undefined, thumbR2: thumb ? thumb.key : undefined,
          scenes: desc ? [{narration: desc}] : [], sources: [], status: 'completed', orientation: 'portrait', recovered: true, kind,
          createdAt: nowIso, updatedAt: nowIso,
        };
        try { fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(proj)); } catch {}
        // 이미 목록에 있으면(재복구·쓰레기복구본) 먼저 치운 뒤 다시 등록(제목 갱신).
        if (liveIds.has(id)) { try { removePortfolio(id); } catch {} }
        const createdAt = livePf.find((x) => x.projectId === id)?.createdAt || new Date().toISOString();
        try { addPortfolio({projectId: id, title, output: vid.name, voice: '복구됨', category, goal: 'info', createdAt, orientation: 'portrait', kind}); recovered++; titles.push(title); } catch {}
      }
      return json(res, 200, {dry, foldersInR2: Object.keys(byId).length, recoverable: dry ? recovered : undefined, recovered: dry ? 0 : recovered, sample: dry ? details.slice(0, 15) : titles.slice(0, 30)});
    } catch (e: any) { return json(res, 500, {error: '복구 실패: ' + (e?.message || e)}); }
  }
  // ── 죽은(재생 불가) 영상 정리 — R2에서 파일이 사라진 포트폴리오 항목을 '목록에서만' 제거한다. ──
  //   ★R2는 절대 건드리지 않는다(이미 없는 파일이므로). ?dry=1이면 몇 개인지 미리보기만.
  if (p === '/api/portfolio-prune-dead' && req.method === 'GET') {
    try {
      const dry = u.searchParams.get('dry') === '1';
      const items = listPortfolio();
      const dead: string[] = [];
      const {head} = await import('./lib/storage');
      for (const it of items) {
        if (it.kind === 'card-post') continue; // 캐러셀은 영상 아님 — 건너뜀
        // project.json에서 R2 키를 읽어 R2 head로 생존 확인. 없으면 로컬 파일로.
        let alive = false;
        try {
          const r2key = readProjectOutputR2(it.projectId); // project.json의 outputR2
          if (r2key) { alive = !!(await head(r2key)); }
          else { alive = fs.existsSync(path.join(STUDIO_DATA_DIR, 'studio', it.projectId, it.output || '')); }
        } catch { alive = false; }
        if (!alive) dead.push(it.projectId);
      }
      if (!dry) for (const id of dead) removePortfolio(id); // 목록에서만 제거(R2 미접촉)
      return json(res, 200, {dry, total: items.length, dead: dead.length, removed: dry ? 0 : dead.length});
    } catch (e: any) { return json(res, 500, {error: '정리 실패: ' + (e?.message || e)}); }
  }
  // ── R2 고아 청소 기능은 영구 제거됨(2026-10-09). ──
  //   ★이 기능이 '목록에 없는 R2 파일을 자동 삭제'하다 살아있는 사용자 영상까지 지운 사고가 있었다.
  //   R2 영상은 '온비디오에서 사용자가 직접 삭제 버튼을 누른 것'만 지운다. 자동 대량삭제는 다시 만들지 않는다.
  if (p === '/api/r2-orphans') {
    return json(res, 410, {error: '안전을 위해 비활성화된 기능입니다. R2 영상은 온비디오에서 직접 삭제한 것만 지워집니다.'});
  }
  // ── 실시간 급상승 트렌드(지금 뜨는 주제) — Google Trends 공개 RSS. 조회수 '골든 윈도우'. ──
  if (p === '/api/trends' && req.method === 'GET') {
    const geo = (u.searchParams.get('geo') || 'KR').toUpperCase();
    try {
      const items = await getTrends(geo);
      return json(res, 200, {trends: items.slice(0, 20), geo});
    } catch (e: any) {
      return json(res, 502, {error: '트렌드를 불러오지 못했어요: ' + (e?.message || e)});
    }
  }
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

  // ── ✍️ 창작 전용 주제 추천: 장르(미스터리·복수·사랑 등)에 맞는 '지금 조회수 터지는 숏드라마·썰' 주제 ──
  if (p === '/api/create-topics' && req.method === 'GET') {
    const genres = (u.searchParams.get('genres') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '키 설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const genreLine = genres.length ? genres.join('·') : '미스터리·반전·사랑·복수·감동';
    const prompt = `너는 전 세계 세로 숏드라마(ReelShort·DramaBox)와 한국 '썰' 쇼츠에서 조회수·완주율 최상위를 뽑는 기획자다.
지금 사람들이 끝까지 보고 공유하는 '${genreLine}' 결의 **오리지널 창작 이야기 주제** 8개를 제안하라(실제 뉴스·실화 아님, 지어낼 이야기의 '씨앗').
[원칙]
- 첫 3초에 스크롤을 멈추는 강한 후킹이 제목에 담겨야 한다(궁금증 갭·반전 예고·충격 설정·금지된 비밀).
- 한 줄로 '누가 어떤 위기·비밀·반전에 빠지는지'가 그려지는 구체적인 설정. 막연·뻔한 클리셰(흔한 삼각관계·단순 복수) 금지, 신선한 훅.
- 60~120초 세로 영상 1편으로 기승전결이 완결되는 규모.
- 정치·종교·과한 선정성·혐오 제외.
JSON만 출력: {"topics":[{"title":"당장 만들고 싶은 이야기 제목·설정 한 줄","why":"왜 터지는지 10자 이내"}]}`;
    const clean = (s: any) => String(s || '').replace(/\*+/g, '').replace(/^\s*[-#>]+\s*/, '').replace(/`/g, '').trim();
    const extract = (raw: string): {title: string; why: string}[] | null => {
      let s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const m = s.match(/\{[\s\S]*\}/); if (!m) return null;
      const data = JSON.parse(m[0]);
      return (Array.isArray(data.topics) ? data.topics : []).slice(0, 8).map((t: any) => ({title: clean(t.title), why: clean(t.why)})).filter((t: any) => t.title);
    };
    let lastErr = '빈 응답';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let raw = '';
        if (k.gemini.length) { try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 1024, temperature: attempt === 0 ? 1.15 : 0.8}); } catch (e: any) { lastErr = e?.message || '생성 실패'; } }
        if (!raw && k.openai) raw = await openaiJson(k.openai, prompt, 1024);
        const topics = extract(raw);
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
        cat: v.cat, // 콘텐츠 카테고리(스릴러·시사·힐링 등) — 목소리 선택 그룹핑
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
        fal: !!e.FAL_KEY,
        falAdmin: !!e.FAL_ADMIN_KEY,
        youtubeApi: !!e.YOUTUBE_API_KEY,
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
      FAL_KEY: maskKey(e.FAL_KEY),
      FAL_ADMIN_KEY: maskKey(e.FAL_ADMIN_KEY),
      YOUTUBE_API_KEY: maskKey(e.YOUTUBE_API_KEY),
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    saveEnv(b);
    return json(res, 200, {ok: true});
  }
  // ── 비밀번호 변경(로그인 필요 구역) — 현재 비번 확인 후 새 비번을 해시로 저장. ──
  //   이 블록은 '로그인 필요' 게이트(위 917줄) 아래라, 세션 없는 외부(anon)는 여기 닿기 전에 401로 막힌다.
  if (p === '/api/password' && req.method === 'POST') {
    const b = await readBody(req);
    const cur = String(b.current || ''), next = String(b.next || '');
    // 비번이 이미 설정돼 있으면 현재 비번이 맞아야 변경 가능(세션 탈취 상황에서도 비번 교체 막음).
    if (passwordSet() && !verifyPassword(cur)) return json(res, 401, {error: '현재 비밀번호가 올바르지 않습니다.'});
    if (next.length < 6) return json(res, 400, {error: '새 비밀번호는 6자 이상이어야 합니다.'});
    try { setPassword(next); } catch (e: any) { return json(res, 500, {error: '저장 실패: ' + (e?.message || '')}); }
    return json(res, 200, {ok: true});
  }

  // ── RunPod 현황(영화 GPU) — 잔액 + 실행 중 팟. 설정 화면에서 조회. ──
  if (p === '/api/runpod/status' && req.method === 'GET') {
    const e = loadEnv();
    if (!e.RUNPOD_API_KEY) return json(res, 200, {configured: false});
    const st = await runpodStatus(e.RUNPOD_API_KEY);
    return json(res, 200, {configured: true, balance: st.balance, pods: st.pods});
  }
  // ── Seedance(fal) 잔액 조회 — 설정 화면 '잔액확인' 버튼. admin 키가 있으면 그걸로, 없으면 일반 키로 시도. ──
  if (p === '/api/fal/balance' && req.method === 'GET') {
    const e = loadEnv();
    const key = e.FAL_ADMIN_KEY || e.FAL_KEY;
    if (!key) return json(res, 200, {configured: false});
    const {falBalance} = await import('./lib/seedance');
    const r = await falBalance(key);
    return json(res, 200, {configured: true, ...r, usedAdmin: !!e.FAL_ADMIN_KEY});
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
    if (!k.gemini.length && !k.openai)
      return json(res, 400, {error: '설정에서 대본 키(Gemini 또는 OpenAI)를 저장하세요.'});
    // ElevenLabs는 나레이션·배경음악 중 하나라도 켰을 때만 필요(둘 다 끄면 음성·음악 없이 영상만).
    const needsEleven = b.narration !== false || b.bgm !== false;
    if (needsEleven && !k.elevenlabs)
      return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다(둘 다 끄면 키 없이 가능).'});

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'video'};
    jobs.set(id, job);
    currentGenJob = id;

    // 백그라운드 실행
    enqueueJob(job, async () => {
      try {
        const r = await makeVideo([url], k, {
          duration: Number(b.duration) || 30,
          presetId: b.presetId || undefined,
          voice: b.voice || undefined,
          quality: b.quality === 'fast' ? 'fast' : 'high',
          // ★전체 스타일 허용(실사·애니·고전 등 15종). 예전엔 real/anime로 뭉개 다른 스타일이 안 먹었음.
          imageStyle: STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real',
          ethnicity: b.ethnicity, // 인물 인종(auto/korean/western)
          sceneCount: Number(b.sceneCount) || 0, // 0=길이로 자동, 2~12=직접 지정
          aiClips: Number(b.aiClips) || 0,
          autoShutdown: b.autoShutdown !== false, // 기본 자동 종료(과금 방지)
          narration: b.narration !== false, // 나레이션 토글(기본 ON)
          bgm: b.bgm !== false,              // 배경음악 토글(기본 ON)
          font: pickFont(b.font),            // 제목·후킹 폰트(화이트리스트 통과분만, 없으면 기본)
          log: (m) => jlog(job, m),
          isCancelled: () => !!job.cancelled, // ★중단 — 파이프라인이 단계마다 확인
        });
        // ★포트폴리오 등록(영상 만들기 탭) — 이게 있어야 작업내역에 뜨고 유튜브·인스타 업로드·다운로드가 된다
        //   (다른 탭은 다 등록하는데 '영상 만들기'만 빠져 있었음 — 반쪽. 테리 지적). origin:'video'로 탭 분리.
        let pid = '';
        try {
          pid = await registerVideoToPortfolio({
            out: r.out, title: r.title, thumb: r.thumb, imageDir: r.imageDir,
            voice: String(b.voice || '기본'), category: '🎬 영상', goal: 'issue', origin: 'video',
            orientation: b.orientation === 'landscape' ? 'landscape' : 'portrait',
            durSec: Number(b.duration) || 30, source: 'url',
            motion: (Number(b.aiClips) || 0) > 0, log: (m) => jlog(job, m),
          });
        } catch (e: any) { jlog(job, '[포트폴리오] 등록 실패(영상은 완성됨): ' + (e?.message || e)); }
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
        if (pid) job.projectId = pid;
        job.done = true; job.doneAt = Date.now();
        jlog(job, `[완료] 바탕화면에도 저장됨: ${folder}`);
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    });

    return json(res, 202, {id});
  }

  // ── 🛍 쇼핑 쇼츠 — 나레이션형: 상품(온파트너/온종일팜 링크) → 리뷰 나레이션 영상.
  //    재창작과 동일 구조(makeVideo sourceText 주입) + 상품 사진을 '기준 참조 이미지'(faceRef)로 넘겨
  //    전 장면에 상품이 등장. 대본 규칙=허위 효능·수치 금지, 가격만 사실, 끝에 FTC 제휴 고지.
  //    카드형은 기존 /api/generate-cards(productLink)로. origin='shopping'(setPortfolioProduct가 세팅)으로 작업내역 이원화. ──
  if (p === '/api/generate-shopping-video' && req.method === 'POST') {
    const b = await readBody(req);
    const productLink = String(b.productLink || '').trim();
    if (!productLink) return json(res, 400, {error: '상품 링크를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 대본 키(Gemini 또는 OpenAI)를 저장하세요.'});
    const needsEleven = b.narration !== false || b.bgm !== false;
    if (needsEleven && !k.elevenlabs) return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다(둘 다 끄면 키 없이 가능).'});
    const linkMode = b.linkMode === 'direct' ? 'direct' : 'partner';
    const durSec = Number(b.duration) || 30;
    const imageStyle = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';

    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'shopping'};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        jlog(job, '[쇼핑] 상품 정보를 불러오는 중…');
        const product = await resolveProduct(productLink);
        const shopUrl = linkMode === 'direct'
          ? (product.shopUrl || product.partnerUrl)
          : (product.partnerUrl || product.shopUrl);
        jlog(job, `[쇼핑] "${product.name}"${product.price ? ' · ' + product.price.toLocaleString('ko-KR') + '원' : ''} — 발송 링크: ${shopUrl}`);
        // 상품 사진 다운로드 → 전 장면 기준 참조 이미지(상품이 모든 컷에 등장).
        let productRef: string | undefined;
        if (product.image) {
          try {
            const ir = await fetch(product.image, {cache: 'no-store'});
            if (ir.ok) {
              const ab = Buffer.from(await ir.arrayBuffer());
              const ext = /png/i.test(ir.headers.get('content-type') || '') || /\.png/i.test(product.image) ? 'png' : 'jpg';
              const refDir = path.join(ROOT, 'public', 'uploads', 'shop-' + id);
              fs.mkdirSync(refDir, {recursive: true});
              productRef = path.join(refDir, `ref.${ext}`);
              fs.writeFileSync(productRef, ab);
              jlog(job, '[쇼핑] 상품 사진을 기준 이미지로 사용 — 전 장면에 상품이 등장합니다.');
            }
          } catch (e: any) { jlog(job, '[쇼핑] 상품 사진 다운로드 실패(AI 장면으로 진행): ' + (e?.message || e)); }
        }
        const priceLine = product.price ? `${product.price.toLocaleString('ko-KR')}원` : '(가격 정보 없음)';
        // ★판매 대본 지침 — 실제 잘 나가는 상품 숏폼 구조(훅→침 넘어가는/탐나는 장면→사회적 증거→구매유도+제휴고지).
        const sellRule = `상품명: ${product.name}
가격: ${priceLine}

🔴 판매 영상 규칙(꼭 지켜라):
- 첫 장면(3초 안)=강한 후킹. "이 가격 실화?" "밥도둑 등장" 같이 멈칫하게. 밍밍한 "상품 소개합니다" 금지.
- 중간=보는 사람이 "먹고 싶다/사고 싶다" 느끼게. 먹음직스러운/탐나는 장면, 쓰는 순간, 상황을 생생하게 묘사. 가격의 매력도 콕.
- 없는 효능·수치·원산지·인증을 지어내지 마라(살 빠짐/병 나음/몇 % 금지). 아는 사실은 상품명·가격뿐. 신선식품이면 의학적 효능 단정 금지.
- 마지막=구매 유도("지금 주문하세요") + "유료 광고예요(제휴 수수료를 받을 수 있어요)" 제휴 고지(FTC).
- 한국어, 쉽고 군침 돌게.
- ★배경음악(musicPrompt)=상품 성격에 맞는 밝은 분위기(영어·instrumental). 음식·먹방=즐겁고 식욕 돋우는 경쾌함(warm upbeat mouth-watering cheerful), 생활용품·가전=쓰고 싶어지는 산뜻·세련(bright clean satisfying modern lifestyle), 추억·레트로=따뜻한 노스탤지어(warm nostalgic). 어둡거나 긴장되는 영화풍 금지 — 판매 영상은 끝까지 기분 좋게.`;

        // ── 미디어 모드: 사용자가 올린 사진·영상으로 '진짜' 판매 영상(후킹·나레이션·길이·자막 자동) ──
        //    AI가 어설픈 장면 만드는 대신, 실제 먹음직한 사진/요리 영상/언박싱을 쓴다(테리: "먹고싶게 안 됨").
        const upImages: string[] = Array.isArray(b.images) ? b.images : [];
        const upVideos: string[] = Array.isArray(b.videos) ? b.videos : [];
        const useMedia = upImages.length > 0 || upVideos.length > 0;
        let r: {out: string; title: string; imageDir: string; thumb?: string};
        if (useMedia) {
          jlog(job, `[쇼핑] 올린 미디어(사진 ${upImages.length}·영상 ${upVideos.length})로 판매 영상 제작 — 후킹·나레이션·자막 자동.`);
          const upDir = path.join(ROOT, 'public', 'uploads', 'shop-media-' + id);
          fs.mkdirSync(upDir, {recursive: true});
          const imgPaths: string[] = [];
          upImages.slice(0, 20).forEach((durl, i) => {
            const m = String(durl).match(/^data:(image\/\w+);base64,(.+)$/); if (!m) return;
            const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
            const f = path.join(upDir, `img-${i}.${ext}`); fs.writeFileSync(f, Buffer.from(m[2], 'base64')); imgPaths.push(f);
          });
          const vidPaths: string[] = [];
          upVideos.slice(0, 10).forEach((durl, i) => {
            const m = String(durl).match(/^data:(video\/\w+);base64,(.+)$/); if (!m) return;
            const ext = m[1].includes('quicktime') ? 'mov' : (m[1].split('/')[1] || 'mp4');
            const f = path.join(upDir, `vid-${i}.${ext}`); fs.writeFileSync(f, Buffer.from(m[2], 'base64')); vidPaths.push(f);
          });
          r = await makeVideoManual(k, {
            imagePaths: imgPaths, videoPaths: vidPaths,
            keywords: product.name,
            facts: sellRule,
            duration: durSec,
            presetId: b.presetId || undefined,
            voice: b.voice || undefined,
            font: pickFont(b.font),
            log: (m) => jlog(job, m),
            isCancelled: () => !!job.cancelled,
          });
        } else {
          // AI 장면 모드: 상품 사진을 기준 참조로 전 장면에 상품 등장.
          const sourceText = `[상품 리뷰 쇼츠 대본 — ${durSec}초 세로 영상]\n${sellRule}`;
          r = await makeVideo([], k, {
            sourceText,
            faceRef: productRef,
            duration: durSec,
            orientation: 'portrait',
            presetId: b.presetId || undefined,
            voice: b.voice || undefined,
            quality: 'high',
            imageStyle,
            ethnicity: b.ethnicity, // 인물 인종(auto/korean/western)
            sceneCount: Number(b.sceneCount) || 0,
            narration: b.narration !== false,
            bgm: b.bgm !== false,
            font: pickFont(b.font),
            log: (m) => jlog(job, m),
            isCancelled: () => !!job.cancelled,
          });
        }
        let pid = '';
        try {
          pid = await registerVideoToPortfolio({
            out: r.out, title: r.title, thumb: r.thumb, imageDir: r.imageDir,
            voice: String(b.voice || '쇼핑'), category: '🛍 쇼핑', goal: 'sell', origin: 'shopping',
            orientation: 'portrait', durSec, source: 'url', log: (m) => jlog(job, m),
          });
        } catch (e: any) { jlog(job, '[포트폴리오] 등록 실패(영상은 완성됨): ' + (e?.message || e)); }
        // 구매 링크·상품명 기록(발송 캡션에 자동) + origin='shopping' 세팅(작업내역 이원화).
        if (pid) { try { setPortfolioProduct(pid, shopUrl, product.name); } catch {} job.projectId = pid; }
        job.file = path.basename(r.out);
        job.title = r.title;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[완료] 쇼핑 영상 제작 완료');
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    });
    return json(res, 202, {id});
  }

  // ── 🛍 쇼핑 이미지 라이브러리 — 사진을 올려두고(영속) 쇼핑쇼츠 만들 때 골라 쓴다.
  //    번호는 목록 응답 때 createdAt 순으로 재계산(저장 안 함) → 중간을 지우면 자동으로 당겨진다. ──
  if (p === '/api/shop/library' && req.method === 'GET') {
    const dir = path.join(STUDIO_DATA_DIR, 'shop-lib');
    let idx: any[] = [];
    try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch {}
    idx.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return json(res, 200, {items: idx.map((it, i) => ({id: it.id, num: i + 1, kind: it.kind || 'image', url: `/api/shop/library/img?id=${it.id}`}))});
  }
  if (p === '/api/shop/library/img' && req.method === 'GET') {
    const id = String(u.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '');
    const dir = path.join(STUDIO_DATA_DIR, 'shop-lib');
    let idx: any[] = [];
    try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch {}
    const it = idx.find((x) => x.id === id);
    const ext = it?.ext || 'jpg';
    const f = path.join(dir, id + '.' + ext);
    if (!id || !fs.existsSync(f)) return json(res, 404, {error: '없음'});
    const cts: Record<string, string> = {png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v'};
    return serveFile(res, f, cts[ext] || 'application/octet-stream');
  }
  if (p === '/api/shop/library/upload' && req.method === 'POST') {
    const b = await readBody(req);
    // images·videos 둘 다 받음(한 라이브러리에 사진·영상 함께). 구버전 호환으로 images만 와도 됨.
    const items: string[] = [...(Array.isArray(b.images) ? b.images : []), ...(Array.isArray(b.videos) ? b.videos : [])];
    if (!items.length) return json(res, 400, {error: '올릴 파일이 없습니다.'});
    const dir = path.join(STUDIO_DATA_DIR, 'shop-lib');
    fs.mkdirSync(dir, {recursive: true});
    let idx: any[] = [];
    try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch {}
    let added = 0; const errs: string[] = [];
    for (const durl of items) {
      const m = String(durl).match(/^data:(image|video)\/([\w.+-]+);base64,([\s\S]+)$/);
      if (!m) { errs.push('형식불일치'); continue; }
      const kind = m[1]; const sub = m[2].toLowerCase();
      const ext = kind === 'video'
        ? (/quicktime/.test(sub) ? 'mov' : /webm/.test(sub) ? 'webm' : /m4v|x-m4v/.test(sub) ? 'm4v' : 'mp4')
        : (/png/.test(sub) ? 'png' : /webp/.test(sub) ? 'webp' : 'jpg');
      const id = randomUUID().slice(0, 8);
      try {
        // 영상만들기와 동일 — 원본 그대로 저장(리사이즈·변환 없음).
        fs.writeFileSync(path.join(dir, id + '.' + ext), Buffer.from(m[3], 'base64'));
        idx.push({id, ext, kind, createdAt: Date.now() + added});
        added++;
      } catch (e: any) { errs.push(String(e?.message || e).slice(0, 120)); }
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx));
    return json(res, 200, {ok: true, added, errs: errs.slice(0, 3)});
  }
  if (p === '/api/shop/library/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const dir = path.join(STUDIO_DATA_DIR, 'shop-lib');
    let idx: any[] = [];
    try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch {}
    const rm = (it: any) => { try { fs.unlinkSync(path.join(dir, it.id + '.' + (it.ext || 'jpg'))); } catch {} };
    if (b.all) {
      for (const it of idx) rm(it);
      idx = [];
    } else {
      const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : (b.id ? [String(b.id)] : []);
      for (const it of idx) if (ids.includes(it.id)) rm(it);
      idx = idx.filter((it) => !ids.includes(it.id));
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx));
    return json(res, 200, {ok: true, count: idx.length});
  }

  // ── 🎭 재창작(리메이크): 인기 영상(서프라이즈 등)의 제목·자막을 '내용 소스'로 받아 우리 이미지·목소리·자막으로
  //    완전 새 영상을 만든다. 원본 미디어·로고를 안 쓰므로 Content ID/상표에 안 걸린다. /api/generate와 동일 구조 +
  //    URL 대신 sourceText 주입. 출력=이미지영상(기본) 또는 영화(aiClips>0). ──
  if (p === '/api/generate-remake' && req.method === 'POST') {
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    const transcript = String(b.transcript || '').trim();
    if (!title && transcript.length < 40) return json(res, 400, {error: '재창작할 영상(제목 또는 내용)이 필요합니다.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 대본 키(Gemini 또는 OpenAI)를 저장하세요.'});
    const needsEleven = b.narration !== false || b.bgm !== false;
    if (needsEleven && !k.elevenlabs) return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다(둘 다 끄면 키 없이 가능).'});

    const videoId = String(b.videoId || '').trim();
    const orientation: 'portrait' | 'landscape' = b.orientation === 'landscape' ? 'landscape' : 'portrait';

    const id = randomUUID().slice(0, 8);
    // ★kind='remake' — 재창작 UI(하이라이트 페이지)가 기기간 실시간 연동에서 이 작업을 붙잡게 하는 핵심.
    //   예전엔 'video'라서 highlight.js syncCurrentJob('highlight'만 수신)이 통째로 무시 → 재창작만 PC↔모바일 연동 안 됐다(테리 지적).
    const job: Job = {id, logs: [], done: false, kind: 'remake'};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        jlog(job, `[재창작] "${title.slice(0, 40)}" 내용을 우리 영상으로 새로 만듭니다(원본 미디어·로고 미사용 → 저작권 free).`);
        // ★원본 실제 내용 확보 — 프론트가 자막을 줬으면 그걸, 아니면 서버가 videoId로 자막→음성STT 전사한다.
        //   이게 있어야 '제목만 보고 지어내기'(팩트X·카피X·재미X, 테리 지적)가 아니라 원본 실제 전개를 각색한다.
        let realContent = transcript;
        if (realContent.length < 40 && videoId && /^[\w-]{11}$/.test(videoId)) {
          try {
            const tmpDir = path.join(ROOT, 'public', 'jobs', 'remake-src-' + id);
            realContent = await fetchSourceTranscript(videoId, tmpDir, k.elevenlabs, (m) => jlog(job, m),
              {maxSec: 360, isCancelled: () => !!job.cancelled});
            try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
          } catch (e: any) { if (/사용자가 중단/.test(e?.message || '')) throw e; jlog(job, '[재창작] 원본 전사 실패 → 제목으로 진행: ' + (e?.message || '').slice(0, 60)); }
        }
        // 대본 지시(seed) — 원본 실제 내용이 있으면 '충실히 각색'(흥미 포인트·반전·팩트 유지), 없으면 제목 기반 집필.
        //   ★서프라이즈 톤: 긴장감 있게, 사실에 기반, 반전·여운. 원문 문장 복붙 금지(표현 저작권 회피)·내용은 유지.
        const sourceText = realContent.length >= 40
          ? `아래는 인기 미스터리 영상(서프라이즈류)의 실제 내용이다. 이 '내용 그대로'를 우리 영상으로 충실히 재현하라 — 사건의 사실·전개 순서·반전·흥미 포인트를 하나도 빠뜨리지 말고 살려라. 단 문장은 우리 말로 새로 써라(그대로 베끼지 말 것). 밋밋하게 요약하지 말고, 원본처럼 긴장감 있게 이야기하듯 풀어라.\n\n[원본 제목] ${title}\n\n[원본 실제 내용]\n${realContent}`
          : `"${title}" — 이 제목의 실제 미스터리/사건을 소재로, 시청자를 처음부터 끝까지 몰입시키는 콘텐츠를 집필하라. 실제 사건·전설이면 사실에 기반해 긴장감 있게 전개하고, 충격 포인트·반전·여운으로 맺어라. 밋밋한 설명 금지.`;
        jlog(job, realContent.length >= 40 ? `[재창작] 원본 실제 내용(${realContent.length}자)을 충실히 각색합니다.` : '[재창작] 원본 내용을 못 받아 제목 기반으로 집필합니다(품질↓ — 자막 있는 영상이 더 좋아요).');
        const durSec = Number(b.duration) || 30;
        const count = Math.max(1, Math.min(5, Number(b.count) || 1)); // 같은 소재로 서로 다른 N편
        const aiClips = Number(b.aiClips) || 0;
        const imageStyle = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';
        job.clips = [];
        // ★본인 얼굴: 업로드 사진(base64) → faceRef(전 장면을 그 얼굴로). 창작과 동일 패턴.
        let faceRef: string | undefined;
        if (b.faceImage) {
          try {
            const fdir = path.join(os.tmpdir(), 'onvideo-face-' + id);
            fs.mkdirSync(fdir, {recursive: true});
            faceRef = path.join(fdir, 'face.jpg');
            fs.writeFileSync(faceRef, Buffer.from(String(b.faceImage).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
            jlog(job, '[이미지] 🧑 올린 얼굴을 받았어요 — 전 장면을 이 얼굴로 만듭니다.');
          } catch { faceRef = undefined; }
        }
        // ★N편 연속 시리즈 설계 — 같은 소재를 독립 N번(다 비슷·궁금증만 쌓이고 해소 없음, 테리 지적) 만들던 것을
        //   "1편 떡밥 → 2편 회수+새 떡밥 → … → 마지막 편 매듭" 연속 서사로. count>1일 때만.
        let seriesBible = '';
        let episodeLoglines: string[] = [];
        if (count > 1) {
          try {
            jlog(job, `[시리즈] ${count}부작 설계 중 — 편마다 다른 국면으로, 궁금증을 다음 편에서 풀어주는 연속 구성…`);
            const bibleRaw = await geminiGenerate(k.gemini, `아래 원본 이야기를 유튜브 쇼츠 '${count}부작 연속 시리즈'로 나눠라.
★★가장 중요: 원본 이야기를 "전개(시간) 순서대로 ${count}구간으로 분할"해 각 편이 서로 다른 구간을 맡는다(1편=발단·도입, 중간 편=전개·위기, 마지막 ${count}편=절정·결말). 절대 매 편이 원본 전체를 처음부터 요약하게 하지 마라 — 그러면 ${count}편이 전부 똑같아진다(이게 지금 가장 큰 문제다). 각 편은 '자기가 맡은 구간'만 깊게 다룬다.
★이어지는 맛: 중간·마지막 편은 앞 편 끝의 궁금증을 "실제로 풀어주며" 시작하고, 중간 편은 끝에만 다음 편 궁금증(클리프행어)을 남긴다.
★★마지막 ${count}편은 원본의 '결말'까지 담아 모든 궁금증에 확실한 결론을 내고 완전히 끝낸다 — 우리는 뒤편을 이어 만들지 않으므로 의문·클리프행어·열린 결말로 끝내면 절대 안 된다.
[원본 제목] ${title}
[원본 내용] ${(realContent || title).slice(0, 8000)}
JSON만: {"bible":"세계관·인물·전체 줄거리를 한 문단으로(인물 이름·설정 고정)","episodes":["1편이 다룰 원본 구간(발단) + 끝에 남길 궁금증","2편이 다룰 원본 구간(앞 궁금증 해소 + 새 궁금증)", ... 정확히 ${count}개 — 마지막 편은 '결말까지 담아 완전 매듭(클리프행어 금지)']}`,
              {json: true, maxTokens: 1600, temperature: 0.9, log: (m) => jlog(job, m)});
            const bd = JSON.parse(bibleRaw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)?.[0] || '{}');
            seriesBible = String(bd.bible || '').trim();
            episodeLoglines = Array.isArray(bd.episodes) ? bd.episodes.map((e: any) => String(e || '').trim()) : [];
            if (seriesBible && episodeLoglines.length >= count) jlog(job, `[시리즈] 설계 완료 — ${episodeLoglines.length}편 로그라인 확보(편마다 다른 주제로 이어집니다)`);
            else { jlog(job, '[시리즈] 설계가 부족해 각 편 독립 제작으로 진행합니다.'); seriesBible = ''; episodeLoglines = []; }
          } catch (e: any) { jlog(job, '[시리즈] 설계 실패 → 각 편 독립 제작으로 진행: ' + (e?.message || '').slice(0, 60)); seriesBible = ''; episodeLoglines = []; }
        }
        const useSeries = count > 1 && !!seriesBible && episodeLoglines.length >= count;
        for (let i = 0; i < count; i++) {
          if (job.cancelled) break;
          if (count > 1) jlog(job, `──── ${i + 1}/${count}편 제작 ────`);
          if (useSeries && episodeLoglines[i]) jlog(job, `[이 편] ${episodeLoglines[i].slice(0, 80)}`);
          // ★시리즈면 각 편에 '원본 전체'를 통째로 주지 않는다(그러면 다 같은 내용이 됨, 테리 지적).
          //   원본은 '맥락 참고용'으로만 주고, 이 편이 맡은 구간(episodeLogline)만 깊게 다루라고 못박는다.
          //   마지막 편은 결말까지 완결(의문·클리프행어 금지), 중간 편은 끝에 다음 편 떡밥.
          const epSource = useSeries
            ? `아래는 인기 영상의 '원본 전체 내용'이다. 지금은 이 이야기를 ${count}부작으로 나눈 ${i + 1}편이다.
★원본 전체를 처음부터 다 재현하지 마라(그러면 다른 편과 똑같아진다). 아래 '이 편이 맡은 구간'에 해당하는 부분만 골라, 원본처럼 긴장감 있게 깊이 풀어라. 다른 편이 맡은 구간의 내용은 미리 말하지 마라.
${i > 0 ? `★시작: 앞 편(${i}편) 끝의 궁금증을 실제로 풀어주며 자연스럽게 이어가라(처음부터 똑같이 다시 시작 금지).\n` : ''}${i + 1 < count ? '★끝: 이 편 구간의 사건은 매듭짓되, 맨 끝에만 다음 편이 궁금해질 지점을 남겨라.' : '★★끝: 이 편은 마지막 편이다 — 원본의 결말까지 담아 모든 궁금증에 확실한 결론을 내고 완전히 끝내라(다음 편이 없으니 의문·클리프행어·열린 결말 절대 금지).'}
[이 편(${i + 1}/${count})이 맡은 구간] ${episodeLoglines[i]}
[원본 제목] ${title}
[원본 전체 내용 — 맥락 참고용(이 편 구간만 쓰라)]
${(realContent || title).slice(0, 8000)}`
            : sourceText;
          const r = await makeVideo([], k, {
            sourceText: epSource,
            faceRef, // ★본인 얼굴(있으면 전 장면 그 얼굴로)
            // ★시리즈면 바이블·이 편 로그라인을 넘겨 연속 서사로(안 넘기면 기존처럼 독립 단편).
            seriesBible: useSeries ? seriesBible : undefined,
            episode: useSeries ? i + 1 : undefined,
            episodesTotal: useSeries ? count : undefined,
            episodeLogline: useSeries ? episodeLoglines[i] : undefined,
            duration: durSec,
            orientation, // ★내가 고른 방향 그대로(세로면 길이 길어도 세로)
            presetId: b.presetId || 'mystery', // 재창작 기본 결=미스터리(서프라이즈 톤). UI에서 바꿀 수 있음.
            voice: b.voice || undefined,
            quality: 'high', // 재창작은 항상 고퀄 이미지(테리 지적: 이미지 퀄 약함)
            imageStyle,
            ethnicity: b.ethnicity, // 인물 인종(auto/korean/western)
            sceneCount: Number(b.sceneCount) || 0,
            aiClips, // >0 = 영화(Wan), 0 = 이미지영상
            autoShutdown: b.autoShutdown !== false,
            narration: b.narration !== false,
            bgm: b.bgm !== false,
            font: pickFont(b.font),
            log: (m) => jlog(job, m),
            isCancelled: () => !!job.cancelled,
          });
          // 포트폴리오 등록 — 유튜브·인스타 업로드·다운로드·삭제 스택이 project.json을 읽으므로 등록 필수(업로드 가능).
          let pid = '';
          try {
            pid = await registerVideoToPortfolio({
              out: r.out, title: r.title, thumb: r.thumb, imageDir: r.imageDir,
              voice: String(b.voice || '재창작'),
              category: '🎭 재창작', goal: 'issue', origin: 'remake',
              orientation, // ★고른 방향 그대로(세로/가로 버그 수정)
              durSec,
              attribution: title ? `원 소재: ${title}` : undefined,
              source: 'archive',
              motion: aiClips > 0, // 영화(Wan)이면 작업내역 '🎬 영상' 배지
              log: (m) => jlog(job, m),
            });
          } catch (e: any) { jlog(job, '[포트폴리오] 등록 실패(영상은 완성됨): ' + (e?.message || e)); }
          job.clips.push({projectId: pid, file: path.basename(r.out), title: r.title});
          job.file = path.basename(r.out); job.title = r.title; if (pid) job.projectId = pid;
          try {
            const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
            const today = new Date().toLocaleDateString('sv-SE');
            const folder = path.join(os.homedir(), 'Desktop', `온비디오 재창작 ${today}`, safe);
            fs.mkdirSync(folder, {recursive: true});
            fs.copyFileSync(r.out, path.join(folder, `${safe}.mp4`));
          } catch { /* Desktop 없는 환경 무시 */ }
        }
        if (!job.clips.length) throw new Error('재창작 영상을 만들지 못했습니다.');
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = e.message;
        job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    });
    return json(res, 202, {id});
  }

  // ── ✍️ 창작: 장르·키워드로 오리지널 '시나리오(표)'를 집필한다(영상 생성 X). 사용자가 표에서 고친 뒤 /api/create-produce로 제작. ──
  if (p === '/api/create-scenario' && req.method === 'POST') {
    const b = await readBody(req);
    const genre = String(b.genre || '').trim();
    const keywords: string[] = Array.isArray(b.keywords) ? b.keywords.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 12) : [];
    const extra = String(b.brief || '').trim(); // 자유 입력(선택)
    if (!genre && !keywords.length && !extra) return json(res, 400, {error: '장르나 키워드를 하나 이상 골라주세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 대본 키(Gemini 또는 OpenAI)를 저장하세요.'});
    const duration = Math.max(15, Math.min(180, Number(b.duration) || 60));
    const orientation: 'portrait' | 'landscape' = b.orientation === 'landscape' ? 'landscape' : 'portrait';
    const imageStyle = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';
    const sceneCount = Math.max(0, Math.min(12, Number(b.sceneCount) || 0));
    const seriesBible = String(b.seriesBible || '').trim() || undefined; // 시리즈면 바이블 전달(연속성)
    const episode = Number(b.episode) || undefined;
    const episodesTotal = Number(b.episodesTotal) || undefined;
    const episodeLogline = String(b.episodeLogline || '').trim() || undefined;
    const preferOpenAI = !!b.premiumScript && !!k.openai; // ★고급 대본 토글(GPT). 키 없으면 자동으로 무료 Gemini.
    // ★사용자가 직접 쓴 주제(extra)가 있으면 그게 '이야기의 중심 소재'다 — 장르·키워드는 톤일 뿐.
    //   예전엔 extra를 "추가 요구"로 뒤에 흘려 넣어 AI가 무시 → 주제와 무관한 복수·배신 막장만 나왔다(테리 지적:
    //   "미지의 세계"를 넣었는데 "그녀의 복수"가 나옴). 주제를 맨 앞·대문자로 못박아 반드시 지키게 한다.
    const kw = keywords.filter((x) => x && x !== genre); // keywords=genres라 장르와 중복되면 빼고(사용자가 따로 준 키워드만)
    const brief = extra
      ? `[★이 영상의 핵심 주제·소재 — 반드시 이걸 중심으로 이야기를 지어내라]
${extra}

[장르·분위기] ${genre || '미스터리'}${kw.length ? `\n[키워드] ${kw.join(', ')}` : ''}

위 "핵심 주제·소재"가 이 이야기의 중심이자 뼈대다. 장르·분위기는 그 주제를 '어떤 톤으로' 풀지에 대한 것일 뿐, 주제 자체를 바꾸지 마라. 절대 주제를 버리고 흔한 복수·배신·불륜·출생의 비밀 같은 막장 숏드라마 클리셰로 흐르지 마라 — 반드시 위 주제가 그대로 이야기의 소재가 되어야 한다. 이 주제로 시청자의 감정을 뒤흔들고 끝까지 몰입시키는 오리지널 창작 스토리를 만들어라.`
      : `[장르·분위기] ${genre || '미스터리'}${kw.length ? `\n[키워드] ${kw.join(', ')}` : ''}

이 장르·분위기로 시청자의 감정을 뒤흔들고 끝까지 몰입시키는 오리지널 창작 스토리를 만들어라.`;
    // ★비동기 작업으로: 시나리오 집필도 '모든 단계'가 로그에 찍히고(주제·장르·설정·집필·완성) 프론트가 에너지바로
    //   진행을 보여준다(테리: "얼마나 걸리는지 몰라 답답"). 결과 storyboard는 job.done 때 SSE로 전달.
    const isEp = !!(episode && episodesTotal);
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'scenario'};
    jobs.set(id, job);
    enqueueJob(job, async () => {
      try {
        jlog(job, `[주제] ${extra ? `"${extra}"` : '(자유 주제 없음 — 장르/키워드로 집필)'}`);
        jlog(job, `[장르] ${genre || '미스터리'}${kw.length ? ` · 키워드: ${kw.join(', ')}` : ''}`);
        jlog(job, `[설정] ${orientation === 'landscape' ? '가로' : '세로'} · ${duration}초 · 스타일 ${imageStyle}${sceneCount ? ` · 장면 ${sceneCount}개 지정` : ' · 장면수 자동'}${isEp ? ` · 시리즈 ${episode}/${episodesTotal}편` : ''}`);
        if (episodeLogline) jlog(job, `[이 편] ${episodeLogline}`);
        jlog(job, preferOpenAI ? '[집필] 🤖 GPT(고급·유료)로 시나리오를 쓰고 있어요…(보통 20~40초)' : '[집필] AI가 시나리오를 쓰고 있어요…(보통 10~20초, 무료)');
        const sb = await generateStoryboard(k.gemini, brief, {
          duration, orientation, imageStyle, sceneCount, creative: true, seriesBible, episode, episodesTotal, episodeLogline, openaiKey: k.openai, preferOpenAI,
          log: (m) => jlog(job, m),
        });
        jlog(job, `[완성] "${sb.title || '오리지널'}" · ${sb.scenes.length}장면`);
        job.storyboard = sb; job.title = sb.title; job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = '시나리오 생성 실패: ' + (e?.message || e); job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + job.error);
      }
    });
    return json(res, 202, {id});
  }

  // ── 📖 시리즈 스토리 바이블: 장르·키워드·편수 → 세계관·인물·편별 로그라인(각 편 시나리오가 이걸 참조해 연속성 유지). ──
  if (p === '/api/create-bible' && req.method === 'POST') {
    const b = await readBody(req);
    const genre = String(b.genre || '').trim();
    const keywords: string[] = Array.isArray(b.keywords) ? b.keywords.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 12) : [];
    const extra = String(b.brief || '').trim();
    const episodes = Math.max(2, Math.min(20, Number(b.episodes) || 3));
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 대본 키(Gemini 또는 OpenAI)를 저장하세요.'});
    const preferOpenAI = !!b.premiumScript && !!k.openai; // ★고급 대본 토글(GPT)
    const bibleKw = keywords.filter((x) => x && x !== genre); // keywords=genres라 장르와 중복이면 제거(사용자 지정 키워드만)
    const prompt = `너는 수백만 조회수를 내는 한국 장편 시리즈 기획자다(장르 불문 — 드라마·미스터리·SF·판타지·역사 다 쓴다). 아래 의뢰로 '${episodes}부작' 오리지널 시리즈의 스토리 바이블을 설계하라. 매 편이 60~120초이고, 하나의 큰 이야기를 편마다 다른 국면으로 '이어서' 전개한다(절대 매 편이 같은 이야기를 반복하지 않는다). 중간 편(1~${episodes - 1}편) 끝은 다음 편이 미치도록 궁금한 클리프행어로 끊되, ★★마지막 ${episodes}편은 지금까지의 모든 떡밥·갈등을 확실히 매듭짓는 '완결'로 끝낸다(우리는 뒤편을 이어 만들지 않으므로, 마지막 편을 클리프행어·의문·열린 결말로 끝내면 시청자가 배신감에 떠난다 — 반드시 결론을 또렷이 보여줄 것). 감정·몰입이 핵심.
${extra ? `[★이 시리즈의 핵심 주제·소재 — 반드시 이걸 중심으로 전체 줄거리를 지어내라]\n${extra}\n★주제를 버리고 흔한 복수·배신·불륜 막장 클리셰로 흐르지 마라. 위 주제가 그대로 시리즈의 소재·세계관이 되어야 한다.\n` : ''}[장르·분위기] ${genre || '미스터리'}
${bibleKw.length ? `[키워드] ${bibleKw.join(', ')}\n` : ''}반드시 아래 JSON만 출력(설명 금지):
{"seriesTitle":"시리즈 제목(한국어, 자극적)","world":"세계관·배경 설정 2~3문장","cast":[{"name":"한국어 이름","look":"영어 외형 묘사(얼굴·머리·의상·색, 모든 편에서 똑같이 재사용)","desc":"성격·역할 한국어 한 줄"}],"episodes":[{"n":1,"logline":"이 편에서 벌어지는 핵심 사건 한 줄 — 중간 편은 끝에 클리프행어, 마지막 편은 '확실한 결말·완전 매듭(클리프행어 금지)'"}]}
cast는 3~5명, episodes는 정확히 ${episodes}개(n=1..${episodes}). 전체가 하나의 큰 줄거리(기승전결)로 이어지되 편마다 국면이 뚜렷이 다르고 긴장이 고조되다가 ★마지막 편에서 완전히 해소·매듭된다.`;
    // ★시나리오와 동일하게 비동기 작업 — 바이블 설계도 전 단계가 로그에 찍히고 에너지바로 진행이 보인다.
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'bible'};
    jobs.set(id, job);
    enqueueJob(job, async () => {
      try {
        jlog(job, `[시리즈] ${episodes}부작 설계`);
        jlog(job, `[주제] ${extra ? `"${extra}"` : '(자유 주제 없음 — 장르/키워드로 설계)'}`);
        jlog(job, `[장르] ${genre || '미스터리'}${bibleKw.length ? ` · 키워드: ${bibleKw.join(', ')}` : ''}`);
        jlog(job, preferOpenAI ? '[바이블] 🤖 GPT(고급·유료)로 세계관·인물·줄거리 설계 중…' : '[바이블] 세계관·인물·편별 줄거리를 설계 중이에요…(보통 15~25초, 무료)');
        let raw = '';
        if (preferOpenAI) {
          try { const {openaiJson} = await import('./lib/openai'); raw = await openaiJson(k.openai!, prompt, 2048, 'gpt-4.1'); }
          catch (e: any) { jlog(job, '[바이블] GPT 실패' + (k.gemini.length ? ' → Gemini 폴백' : '') + ': ' + (e?.message || '').slice(0, 60)); }
          if (!raw && k.gemini.length) { try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 2048, temperature: 0.95}); } catch (e: any) { jlog(job, '[바이블] Gemini 실패: ' + (e?.message || '').slice(0, 60)); } }
        } else {
          if (k.gemini.length) { try { raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 2048, temperature: 0.95}); } catch (e: any) { jlog(job, '[바이블] Gemini 실패' + (k.openai ? ' → OpenAI 폴백' : '') + ': ' + (e?.message || '').slice(0, 60)); } }
          if (!raw && k.openai) { jlog(job, '[바이블] OpenAI로 생성'); const {openaiJson} = await import('./lib/openai'); raw = await openaiJson(k.openai, prompt, 2048); }
        }
        const m = raw.match(/\{[\s\S]*\}/); const d = m ? JSON.parse(m[0]) : null;
        if (!d || !Array.isArray(d.episodes) || !d.episodes.length) throw new Error('바이블 생성 결과가 비었습니다.');
        jlog(job, `[완성] "${d.seriesTitle || '시리즈'}" · 인물 ${(d.cast || []).length}명 · ${(d.episodes || []).length}편`);
        job.bible = d; job.title = d.seriesTitle; job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = '스토리 바이블 생성 실패: ' + (e?.message || e); job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + job.error);
      }
    });
    return json(res, 202, {id});
  }

  // ── ✍️ 창작 제작: 사용자가 표에서 편집을 끝낸 시나리오로 영상을 만든다(대본 재생성 안 함). 재창작과 동일 등록(YT/IG·썸네일). ──
  if (p === '/api/create-produce' && req.method === 'POST') {
    const b = await readBody(req);
    const storyboard = b.storyboard as Storyboard | undefined;
    if (!storyboard || !Array.isArray(storyboard.scenes) || !storyboard.scenes.length) return json(res, 400, {error: '제작할 시나리오가 없습니다. 먼저 시나리오를 만들어 주세요.'});
    const k = pipelineKeys();
    const needsEleven = b.narration !== false || b.bgm !== false;
    if (needsEleven && !k.elevenlabs) return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다(둘 다 끄면 키 없이 가능).'});
    const orientation: 'portrait' | 'landscape' = b.orientation === 'landscape' ? 'landscape' : 'portrait';
    const durSec = Math.max(15, Math.min(180, Number(b.duration) || 60));
    const aiClips = Math.max(0, Math.min(20, Number(b.aiClips) || 0)); // 0=이미지영상 / N=영화(앞 N장면)
    const imageStyle = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false, kind: 'create'}; // 창작 전용 kind — create 페이지만 이 작업에 연동(다른 탭이 안 가로채게)
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        jlog(job, `[창작] "${storyboard.title || '오리지널'}" 시나리오로 영상을 제작합니다(${aiClips > 0 ? '영화' : '이미지 영상'}).`);
        // ★본인 얼굴: 업로드한 사진(base64)을 파일로 저장 → faceRef로 넘기면 전 장면을 그 얼굴로.
        let faceRef: string | undefined;
        if (b.faceImage) {
          try {
            const fdir = path.join(os.tmpdir(), 'onvideo-face-' + id);
            fs.mkdirSync(fdir, {recursive: true});
            faceRef = path.join(fdir, 'face.jpg');
            fs.writeFileSync(faceRef, Buffer.from(String(b.faceImage).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
            jlog(job, '[이미지] 🧑 올린 얼굴을 받았어요 — 전 장면을 이 얼굴로 만듭니다.');
          } catch { faceRef = undefined; }
        }
        const r = await makeVideo([], k, {
          storyboard, duration: durSec, orientation, imageStyle, ethnicity: b.ethnicity, aiClips, faceRef,
          autoShutdown: b.autoShutdown !== false, narration: b.narration !== false, bgm: b.bgm !== false,
          voice: b.voice || undefined, font: pickFont(b.font),
          log: (m) => jlog(job, m), isCancelled: () => !!job.cancelled,
        });
        let pid = '';
        try {
          pid = await registerVideoToPortfolio({
            out: r.out, title: r.title, thumb: r.thumb, imageDir: r.imageDir,
            voice: String(b.voice || '창작'), category: '✍️ 창작', goal: 'issue', origin: 'create',
            orientation, durSec, source: 'archive', motion: aiClips > 0, log: (m) => jlog(job, m),
          });
        } catch (e: any) { jlog(job, '[포트폴리오] 등록 실패(영상은 완성됨): ' + (e?.message || e)); }
        job.clips = [{projectId: pid, file: path.basename(r.out), title: r.title}];
        job.file = path.basename(r.out); job.title = r.title; if (pid) job.projectId = pid;
        try {
          const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
          const today = new Date().toLocaleDateString('sv-SE');
          const folder = path.join(os.homedir(), 'Desktop', `온비디오 창작 ${today}`, safe);
          fs.mkdirSync(folder, {recursive: true});
          fs.copyFileSync(r.out, path.join(folder, `${safe}.mp4`));
        } catch { /* Desktop 없는 환경 무시 */ }
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = e.message; job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      }
    });
    return json(res, 202, {id});
  }

  // ── 📥 완성 영상 가져오기: 외부/로컬에서 만든 mp4(+썸네일)를 포트폴리오에 등록. 유튜브·인스타·다운로드 재활용. ──
  if (p === '/api/portfolio/import' && req.method === 'POST') {
    const b = await readBody(req);
    const title = String(b.title || '').trim() || '가져온 영상';
    const mp4 = String(b.mp4 || ''); // base64(프리픽스 없음)
    if (!mp4) return json(res, 400, {error: 'mp4(base64)가 필요합니다.'});
    const origin: 'video' | 'remake' | 'create' = ['video', 'remake', 'create'].includes(b.origin) ? b.origin : 'video';
    const orientation: 'portrait' | 'landscape' = b.orientation === 'landscape' ? 'landscape' : 'portrait';
    const tmp = path.join(os.tmpdir(), 'imp-' + randomUUID().slice(0, 8));
    try {
      fs.mkdirSync(tmp, {recursive: true});
      const outPath = path.join(tmp, 'v.mp4');
      fs.writeFileSync(outPath, Buffer.from(mp4, 'base64'));
      let thumbPath: string | undefined;
      if (b.thumb) { thumbPath = path.join(tmp, 't.png'); fs.writeFileSync(thumbPath, Buffer.from(String(b.thumb), 'base64')); }
      else {
        // 썸네일 미제공 → 영상 첫 프레임을 ffmpeg로 뽑아 커버로(최소한 미리보기는 뜨게).
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const ff = process.env.FFMPEG_PATH || 'ffmpeg';
          const tp = path.join(tmp, 't.png');
          await promisify(execFile)(ff, ['-y', '-ss', '1', '-i', outPath, '-frames:v', '1', tp], {timeout: 60000});
          if (fs.existsSync(tp)) thumbPath = tp;
        } catch { /* 썸네일 추출 실패 시 무시(첫프레임 폴백 없이 등록) */ }
      }
      const cat = String(b.category || (origin === 'remake' ? '🎭 재창작' : origin === 'create' ? '✍️ 창작' : '🎬 영상'));
      const pid = await registerVideoToPortfolio({
        out: outPath, thumb: thumbPath, title, voice: String(b.voice || '가져옴'),
        category: cat, goal: 'issue', origin, orientation, durSec: Number(b.durSec) || 30,
        source: 'upload', motion: !!b.motion,
      });
      return json(res, 200, {ok: true, projectId: pid});
    } catch (e: any) { return json(res, 500, {error: '가져오기 실패: ' + (e?.message || e)}); }
    finally { try { fs.rmSync(tmp, {recursive: true, force: true}); } catch {} }
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

    enqueueJob(job, async () => {
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
          font: pickFont(b.font), // 제목·후킹 폰트(화이트리스트 통과분만, 없으면 기본)
          log: (m) => jlog(job, m),
          isCancelled: () => !!job.cancelled, // ★중단 — 파이프라인이 단계마다 확인
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
    });

    return json(res, 202, {id});
  }

  // ── 카드뉴스 생성 ──
  // ── 카드 대본만 생성(편집용) — 렌더 전에 문구를 고칠 수 있게 텍스트만 빠르게 반환 ──
  if (p === '/api/card-plan' && req.method === 'POST') {
    const b = await readBody(req);
    const topic = String(b.topic || '').trim();
    const productLink = String(b.productLink || '').trim();
    if (!topic && !productLink) return json(res, 400, {error: '주제나 상품 링크를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const style = STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real';
    try {
      // ── 쇼핑 모드: 상품 조회 → 쇼핑 대본 + 상품 정보(프론트 미리보기용) 반환 ──
      if (productLink) {
        const product = await resolveProduct(productLink);
        const sb = await generateShoppingStoryboard(
          {gemini: k.gemini, openai: k.openai},
          {name: product.name, price: product.price, image: product.image},
          Number(b.count) || 6,
          b.presetId ? getPreset(String(b.presetId)) : undefined,
        );
        return json(res, 200, {storyboard: sb, product});
      }
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
    // ★쇼핑 쇼츠 모드: productLink(온파트너 /r/code 또는 온종일팜 다이렉트 상품페이지)가 오면 상품 기반으로 만든다.
    const productLink = String(b.productLink || '').trim();
    const isShopping = !!productLink;
    if (!topic && !isShopping) return json(res, 400, {error: '주제나 상품 링크를 입력하세요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const output = b.output === 'post' ? 'post' : 'video';
    // 쇼핑은 상품 사진을 배경으로 쓰므로 bg=upload 고정(상품 사진을 서버가 받아 깐다).
    const bg = isShopping ? 'upload' : (['ai', 'solid', 'upload'].includes(b.bg) ? b.bg : 'solid');
    const narration = output === 'video' && b.narration === true;
    const bgm = output === 'video' && b.bgm === true;
    if ((narration || bgm) && !k.elevenlabs) return json(res, 400, {error: '나레이션·배경음악을 쓰려면 ElevenLabs 키가 필요합니다.'});
    if (bg === 'ai' && !k.replicate) return json(res, 400, {error: 'AI 배경을 쓰려면 Replicate 키가 필요합니다.'});
    // 발송 링크 토글: 'direct'=온종일팜 상품페이지, 그 외=온파트너 제휴링크(기본, 수수료).
    const linkMode = b.linkMode === 'direct' ? 'direct' : 'partner';

    const id = randomUUID().slice(0, 8);
    // 쇼핑 카드는 kind='shopping' — 쇼핑 쇼츠 탭이 기기 연동(syncCurrentJob)에서 이 작업을 붙잡게.
    const job: Job = {id, logs: [], done: false, ...(isShopping ? {kind: 'shopping' as const} : {})};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      let shopUrlToSave = '', shopNameToSave = '';
      try {
        // 업로드 배경(dataURL) 저장.
        let uploads: string[] | undefined;
        let storyboard = sanitizeCardStoryboard(b.storyboard);
        let cardTopic = topic;
        // ── 쇼핑 모드: 상품 조회 → 사진 다운로드(배경) → 쇼핑 대본 생성 ──
        if (isShopping) {
          jlog(job, '[쇼핑] 상품 정보를 불러오는 중…');
          const product = await resolveProduct(productLink);
          cardTopic = product.name;
          shopNameToSave = product.name;
          shopUrlToSave = linkMode === 'direct'
            ? (product.shopUrl || product.partnerUrl)
            : (product.partnerUrl || product.shopUrl);
          jlog(job, `[쇼핑] "${product.name}"${product.price ? ' · ' + product.price.toLocaleString('ko-KR') + '원' : ''} — 발송 링크: ${shopUrlToSave}`);
          // 상품 사진 다운로드 → 배경으로(모든 카드에 상품 사진이 깔린다).
          if (product.image) {
            try {
              const ir = await fetch(product.image, {cache: 'no-store'});
              if (ir.ok) {
                const ab = Buffer.from(await ir.arrayBuffer());
                const ext = /png/i.test(ir.headers.get('content-type') || '') || /\.png/i.test(product.image) ? 'png' : 'jpg';
                const upDir = path.join(ROOT, 'public', 'uploads', 'card-' + id);
                fs.mkdirSync(upDir, {recursive: true});
                fs.writeFileSync(path.join(upDir, `u-0.${ext}`), ab);
                uploads = [`uploads/card-${id}/u-0.${ext}`];
              }
            } catch (e: any) { jlog(job, '[쇼핑] 상품 사진 다운로드 실패(단색 배경으로 진행): ' + (e?.message || e)); }
          }
          // 대본이 편집본으로 안 왔으면 쇼핑 대본 생성.
          if (!storyboard) storyboard = await generateShoppingStoryboard({gemini: k.gemini, openai: k.openai}, {name: product.name, price: product.price, image: product.image}, Number(b.count) || 6);
        } else if (bg === 'upload' && Array.isArray(b.images) && b.images.length) {
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
        // 쇼핑 모드인데 상품 사진이 없으면 단색으로 폴백(배경 비면 제작 실패 방지).
        const effBg = (isShopping && (!uploads || !uploads.length)) ? 'solid' : bg;
        const r = await makeCardVideo(k, {
          topic: cardTopic,
          count: Number(b.count) || (isShopping ? 6 : 7),
          presetId: b.presetId || undefined,
          output, bg: effBg, uploads,
          narration, bgm,
          voice: b.voice || undefined,
          imageStyle: STYLE_IDS.includes(String(b.imageStyle)) ? String(b.imageStyle) : 'real',
          cardTheme: b.cardTheme === 'dark' ? 'dark' : 'light',
          motion: ['pop', 'slide', 'type', 'zoom', 'flip'].includes(b.motion) ? b.motion : 'auto',
          font: pickFont(b.font), // 제목 폰트(모든 탭 공통). 자동이면 undefined→스킨 폰트.
          // 대본편집: 사용자가 고친 대본이 오면 그대로 제작(검증 후). 쇼핑은 위에서 만든 대본.
          storyboard,
          log: (m) => jlog(job, m),
          isCancelled: () => !!job.cancelled, // ★중단 — 파이프라인이 단계마다 확인
        });
        // ★쇼핑: 포폴에 구매 링크·상품명 저장 → 발송 시 캡션/링크에 자동.
        if (isShopping && r.projectId && shopUrlToSave) setPortfolioProduct(r.projectId, shopUrlToSave, shopNameToSave);
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
    });
    return json(res, 202, {id});
  }
  // ── 카드 수정: 저장된 대본 불러오기 ──
  if (p.startsWith('/api/card/edit-info/') && req.method === 'GET') {
    const projectId = p.slice('/api/card/edit-info/'.length);
    try { return json(res, 200, await cardEditInfo(projectId)); }
    catch (e: any) { return json(res, 500, {error: (e?.message || 'edit-info 실패')}); }
  }
  // ── 카드 수정: 수정한 대본으로 다시 만들기(job+SSE, 하이라이트 re-render와 동일 구조) ──
  if (p === '/api/card/re-render' && req.method === 'POST') {
    const b = await readBody(req);
    const projectId = String(b.projectId || '').trim();
    if (!projectId) return json(res, 400, {error: '수정할 카드를 찾을 수 없어요.'});
    const k = pipelineKeys();
    if (!k.gemini.length && !k.openai) return json(res, 400, {error: '설정에서 Gemini 또는 OpenAI 키를 저장하세요.'});
    const sanitized = sanitizeCardStoryboard({cards: b.cards});
    const editedCards = sanitized && Array.isArray(sanitized.cards) ? sanitized.cards : undefined;
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        const r = await reRenderCard(k, projectId, editedCards, (m) => jlog(job, m));
        job.kind = r.kind === 'post' ? 'post' : undefined;
        if (r.kind === 'post') job.zip = path.basename(r.out); else job.file = path.basename(r.out);
        job.projectId = r.projectId;
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) { job.error = e.message; job.done = true; job.doneAt = Date.now(); jlog(job, '[실패] ' + e.message); }
    });
    return json(res, 202, {id});
  }

  // ── 재사용(CC) 유튜브 영상 → 하이라이트 숏폼 여러 편 ──
  // ── 본인 영상 업로드(하이라이트 소재) — raw 바이너리 PUT. 파일명은 X-Filename 헤더. 반환 {uploadId, duration, title} ──
  if (p === '/api/highlight/upload' && req.method === 'POST') {
    cleanOldUploads(); // 새 업로드 전에 버려진 옛 업로드부터 치워 /tmp 공간 확보(ENOSPC 예방)
    const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'upload.mp4'));
    const ext = (rawName.match(/\.(mp4|mov|m4v|webm|mkv|avi)$/i) || ['', 'mp4'])[1].toLowerCase();
    fs.mkdirSync(HL_UPLOAD_DIR, {recursive: true});
    const uploadId = randomUUID().slice(0, 12);
    const dest = path.join(HL_UPLOAD_DIR, `${uploadId}.${ext}`);
    // ★큰 영상(수백 MB)을 메모리에 통째로 담으면 Railway 컨테이너가 OOM으로 죽어 "업로드 실패"가 난다.
    //   → 받는 즉시 디스크로 스트리밍(메모리 일정). 300MB짜리도 메모리 몇 MB만 쓴다.
    try {
      const MAX = 600 * 1024 * 1024;
      let total = 0, aborted = '';
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        req.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX && !aborted) { aborted = '파일이 너무 커요(최대 600MB).'; req.destroy(); ws.destroy(); }
        });
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        req.pipe(ws);
      });
      if (aborted) { try { fs.rmSync(dest, {force: true}); } catch {} return json(res, 400, {error: aborted}); }
      if (total < 1000) { try { fs.rmSync(dest, {force: true}); } catch {} return json(res, 400, {error: '영상 파일이 비어있어요.'}); }
      // 길이 측정(ffprobe). 실패하면 0(프론트에서 안내).
      let duration = 0;
      try {
        const probe = (process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH || 'ffmpeg').replace(/ffmpeg$/, 'ffprobe'));
        const out = cpExecFileSync(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', dest], {timeout: 20000}).toString();
        duration = Math.floor(Number(out.trim()) || 0);
      } catch {}
      const title = rawName.replace(/\.[^.]+$/, '').slice(0, 120) || '내 영상';
      return json(res, 200, {uploadId, duration, title, sizeMB: Math.round(total / 1048576)});
    } catch (e: any) { try { fs.rmSync(dest, {force: true}); } catch {} return json(res, 400, {error: '업로드 실패: ' + (e?.message || e)}); }
  }

  if (p === '/api/generate-highlights' && req.method === 'POST') {
    const b = await readBody(req);
    const videoId = String(b.videoId || '').trim();
    // 본인 업로드 영상이면 uploadId로, 아니면 videoId(유튜브 11자)로.
    const uploadId = String(b.uploadId || '').trim();
    let localFile: string | undefined;
    if (uploadId) {
      if (!/^[\w-]{12}$/.test(uploadId)) return json(res, 400, {error: '업로드를 다시 해주세요.'});
      const found = fs.existsSync(HL_UPLOAD_DIR) ? fs.readdirSync(HL_UPLOAD_DIR).find((f) => f.startsWith(uploadId + '.')) : undefined;
      if (!found) return json(res, 400, {error: '업로드한 영상을 찾을 수 없어요. 다시 올려주세요.'});
      localFile = path.join(HL_UPLOAD_DIR, found);
    } else if (!/^[\w-]{11}$/.test(videoId)) {
      return json(res, 400, {error: '영상을 선택하세요.'});
    }
    const title = String(b.title || '').slice(0, 200);
    const channel = String(b.channel || '').slice(0, 120);
    const count = Math.max(1, Math.min(10, Number(b.count) || 3));
    const clipSec = Math.max(15, Math.min(600, Number(b.clipSec) || 30)); // 최대 10분(커스텀)
    const orientation = b.orientation === 'landscape' ? 'landscape' : 'portrait';
    const commentary = !!b.commentary; // 해설 나레이션 입히기(수익화 변형 가치)
    const narrationCoverage = [1, 0.8, 0.6].includes(Number(b.narrationCoverage)) ? Number(b.narrationCoverage) : 1; // 해설 커버리지(끝까지/80/60%)
    const voice = typeof b.voice === 'string' ? b.voice : undefined;
    const reframe = b.reframe === 'letterbox' ? 'letterbox' : 'track'; // 세로 변환 방식(기본=인물 추적)
    const muteOriginal = !!b.muteOriginal; // 원본 소리 완전 제거(저작권 소리지문 회피)
    const template = typeof b.template === 'string' ? b.template : 'auto'; // 디자인 템플릿(auto=편마다 자동)
    const font = pickFont(b.font); // 제목 폰트(모든 탭 공통). 자동이면 undefined→템플릿 폰트.
    const removeSilence = !!b.removeSilence; // 무음 구간 자동 제거(템포 UP)
    const broll = !!b.broll; // AI b-roll 팝업(이미지 생성 비용 발생)
    const captionEn = !!b.captionEn; // 영어 번역 자막(한국어 아래 함께) — 해설 켤 때만 의미
    const isCc = b.isCc !== false; // 기본 CC(안전). URL 모드에서 비-CC 영상이면 false로 와서 출처에 CC BY를 거짓표기하지 않는다.
    const source = ['search', 'url', 'upload', 'archive'].includes(b.source) ? b.source : undefined; // 작업내역 탭별 이원화용 소재 출처
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        job.kind = 'highlight';
        job.clips = []; // 완성되는 편마다 누적(먼저 끝난 편을 SSE로 바로 흘림)
        const clips = await makeHighlights(videoId, {title, channel, isCc}, {count, clipSec, orientation, commentary, narrationCoverage, voice, reframe, muteOriginal, localFile, template, font, removeSilence, broll, captionEn, source, log: (m) => jlog(job, m), isCancelled: () => !!job.cancelled,
          onClip: (c) => { if (!job.clips!.some((x) => x.projectId === c.projectId)) job.clips!.push(c); }});
        if (localFile) { try { fs.rmSync(localFile, {force: true}); } catch {} } // 업로드 원본은 작업 끝나면 정리
        if (clips[0]) { job.file = clips[0].file; job.title = clips[0].title; job.projectId = clips[0].projectId; }
        jlog(job, `[진단] 완성 ${clips.length}편 · SSE 전송목록 ${job.clips?.length || 0}편`); // 6개인데 5개만 보이는 문제 추적
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) {
        job.error = e.message; job.done = true; job.doneAt = Date.now();
        jlog(job, '[실패] ' + e.message);
      } finally {
        // ★작업 끝날 때마다 디스크 청소 — 완성분은 R2로 가고 볼륨 잔재를 즉시 비워 ENOSPC 재발 방지.
        runMaintenance('하이라이트완료');
      }
    });
    return json(res, 202, {id});
  }

  // 유튜브 쿠키 등록(봇차단 뚫기) — 로그인한 브라우저에서 뽑은 cookies.txt 내용을 data 볼륨에 저장.
  //   yt-dlp가 YT_COOKIES_FILE 경로를 읽는다(youtube-clip.ts). Railway 콘솔 안 건드리고 앱에서 바로.
  if (p === '/api/youtube-cookies' && req.method === 'POST') {
    const b = await readBody(req);
    const txt = String(b.cookies || '').trim();
    if (!txt || !/# Netscape HTTP Cookie File|\.youtube\.com\t/.test(txt))
      return json(res, 400, {error: 'cookies.txt 형식이 아니에요. 크롬 확장프로그램 "Get cookies.txt"로 youtube.com 쿠키를 내보내 그 내용을 통째로 붙여넣으세요.'});
    try {
      const dir = path.join(STUDIO_DATA_DIR); fs.mkdirSync(dir, {recursive: true});
      const file = path.join(dir, 'yt-cookies.txt');
      fs.writeFileSync(file, txt, 'utf8');
      process.env.YT_COOKIES_FILE = file; // 즉시 적용(재배포 불필요)
      return json(res, 200, {ok: true, lines: txt.split('\n').filter(l => l.includes('.youtube.com')).length});
    } catch (e: any) { return json(res, 500, {error: '쿠키 저장 실패: ' + e.message}); }
  }
  if (p === '/api/youtube-cookies' && req.method === 'GET') {
    const file = path.join(STUDIO_DATA_DIR, 'yt-cookies.txt');
    const exists = fs.existsSync(file);
    return json(res, 200, {saved: exists, when: exists ? fs.statSync(file).mtime.toISOString() : null});
  }

  // yt-dlp를 '지금 즉시' 최신 nightly로 교체(재배포 없이 — 폰/태블릿에서 버튼 한 번).
  //   유튜브가 전 클라이언트를 봇차단할 때 가장 흔한 원인 = yt-dlp가 옛 버전. 이걸 앱에서 바로 풀 수 있게.
  if (p === '/api/youtube/update-ytdlp' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, {error: '인증 필요'});
    try {
      const r = await updateYtdlp((m) => console.log(m));
      return json(res, 200, {ok: true, before: r.before, after: r.after, changed: r.changed});
    } catch (e: any) {
      return json(res, 500, {error: 'yt-dlp 최신화 실패: ' + (e?.message || e)});
    }
  }
  if (p === '/api/youtube/update-ytdlp' && req.method === 'GET') {
    return json(res, 200, {version: await ytdlpVersion()});
  }

  // 하이라이트 작업 중단(잘못 골랐을 때) — cancelled 플래그만 세우면 makeHighlights가 다음 단계에서 멈춘다.
  if (p === '/api/generate-highlights/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    const job = jobs.get(String(b.id || ''));
    if (!job) return json(res, 404, {error: '작업을 찾을 수 없습니다(이미 끝났을 수 있어요).'});
    job.cancelled = true;
    jlog(job, '[중단] 사용자가 중단을 눌렀습니다. 진행 중인 단계가 끝나는 대로 멈춥니다…');
    return json(res, 200, {ok: true});
  }

  // 영상·카드 등 제작 작업 중단(범용) — cancelled 플래그만 세우면 파이프라인이 다음 단계 경계에서 멈춘다.
  //   (하이라이트와 동일한 방식. 렌더처럼 통짜 단계는 끝난 뒤 경계에서 멈춤.)
  if (p === '/api/generate/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    const job = jobs.get(String(b.id || ''));
    if (!job) return json(res, 404, {error: '작업을 찾을 수 없습니다(이미 끝났을 수 있어요).'});
    job.cancelled = true;
    jlog(job, '[중단] 사용자가 중단을 눌렀습니다. 진행 중인 단계가 끝나는 대로 멈춥니다…');
    return json(res, 200, {ok: true});
  }

  // ── 하이라이트 한 편 편집 재렌더('✏️ 편집' 저장) — 후킹·디자인 바꿔 그 클립만 다시 렌더(job+SSE) ──
  if (p === '/api/highlight/re-render' && req.method === 'POST') {
    const b = await readBody(req);
    const projectId = String(b.projectId || '').trim();
    if (!projectId) return json(res, 400, {error: '편집할 영상을 찾을 수 없어요.'});
    const overrides = {
      hookTop: typeof b.hookTop === 'string' ? b.hookTop : undefined,
      hookAccent: typeof b.hookAccent === 'string' ? b.hookAccent : undefined,
      template: typeof b.template === 'string' ? b.template : undefined,
      narration: typeof b.narration === 'string' ? b.narration : undefined, // ★나레이션 직접 수정(TTS 재생성)
      voice: typeof b.voice === 'string' ? b.voice : undefined,
      thumbBig: typeof b.thumbBig === 'string' ? b.thumbBig : undefined, // ★썸네일 큰 글자 직접 수정
      thumbBadge: typeof b.thumbBadge === 'string' ? b.thumbBadge : undefined, // ★썸네일 뱃지
      narrationOff: b.narrationOff === true, // ★나레이션 끄기(해설 없이 원본 소리만)
    };
    const id = randomUUID().slice(0, 8);
    const job: Job = {id, logs: [], done: false};
    jobs.set(id, job);
    currentGenJob = id;
    enqueueJob(job, async () => {
      try {
        job.kind = 'highlight';
        const r = await reRenderHighlight(projectId, overrides, (m) => jlog(job, m));
        job.clips = [{projectId, file: r.output, title: ''}];
        job.projectId = projectId; job.file = r.output;
        job.done = true; job.doneAt = Date.now();
      } catch (e: any) { job.error = e.message; job.done = true; job.doneAt = Date.now(); jlog(job, '[실패] ' + e.message); }
    });
    return json(res, 202, {id});
  }
  // 편집 화면이 쓸 정보(저장된 후킹·템플릿 + 템플릿 목록).
  if (p.startsWith('/api/highlight/edit-info/') && req.method === 'GET') {
    const projectId = p.slice('/api/highlight/edit-info/'.length);
    try {
      // ★project.json이 날아갔어도 R2/포폴+source로 복구(테리 H.O.T 영상 빈 모달 사고 근본 수정).
      const loaded = await loadHlProject(projectId);
      if (!loaded) return json(res, 200, {editable: false, reason: '이 영상은 원본이 없어 수정할 수 없어요 — 다시 만들어 주세요.'});
      const proj = loaded.proj;
      const e = proj.hlEdit;
      if (!e) return json(res, 200, {editable: false, reason: '이 영상은 창작/재창작이거나 옛 버전이라 아직 수정을 지원하지 않아요.'});
      // 후킹이 비어 저장됐으면(옛 버전 등) 제목에서 복원 — 모달에 '현재 후킹'이 반드시 채워지게(테리: 빈칸이면 안 됨).
      const titleHook = String(proj.title || '').replace(/\s\d+편\s*$/, '').trim();
      const narration = (proj.scenes && proj.scenes[0] && typeof proj.scenes[0].narration === 'string') ? proj.scenes[0].narration : '';
      return json(res, 200, {editable: true, hookTop: e.hookTop || titleHook, hookAccent: e.hookAccent || '', template: e.template || 'variety', narration, hasNarration: !!e.hasNarration, thumbBig: e.thumbBig || '', thumbBadge: e.thumbBadge || ''});
    } catch { return json(res, 500, {error: 'edit-info 실패'}); }
  }
  // AI 후킹 재추천(편집 모달 ✨) — 제목·현재 후킹 기반으로 더 터지는 후킹 제안.
  if (p.startsWith('/api/highlight/hook-suggest/') && req.method === 'GET') {
    const projectId = p.slice('/api/highlight/hook-suggest/'.length);
    try {
      // project.json이 날아갔어도 R2/포폴+source로 복구(H.O.T 영상도 추천 가능).
      const loaded = await loadHlProject(projectId);
      if (!loaded) return json(res, 404, {error: 'not found'});
      const proj = loaded.proj;
      const e = proj.hlEdit || {};
      const k = pipelineKeys();
      if (!k.gemini?.length) return json(res, 200, {hookTop: '', hookAccent: ''});
      // ★영상 '내용'을 보고 뽑는다 — 이 클립의 실제 대사(transcript)를 근거로. 대사가 있으면 그 장면에 딱 맞는
      //   후킹을, 없으면(자막 없는 영상) 제목으로 추론. (사람이 영상을 안 보고도 알 수 있게 — 테리 요구)
      const transcript = (e.transcript || '').slice(0, 1000).trim();
      const prompt = `너는 쇼츠 편집자다. 아래 '이 장면의 실제 대사'를 읽고, 그 내용에 딱 맞는 상단 후킹 자막을 뽑아라.
스크롤을 멈추게 하는 궁금증·반전·감정·핵심을 담되, 장면과 동떨어진 낚시는 금지(내용 기반).

영상 제목: ${e.baseTitle || proj.title || ''}
${transcript ? `이 장면의 실제 대사:\n"""${transcript}"""` : '(이 장면은 대사가 없어요 — 제목으로 맥락을 추론해서 뽑아요.)'}
지금 후킹(참고, 다른 각도로): ${e.hookTop || ''} / ${e.hookAccent || ''}

규칙: hookTop=한국어 12자 내외(장면 내용과 맞게), hookAccent=강조 단어 6자 내.
JSON만: {"hookTop":"...","hookAccent":"..."}`;
      const raw = await geminiGenerate(k.gemini, prompt, {json: true, maxTokens: 256, temperature: 0.9});
      const m = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      return json(res, 200, {hookTop: String(j.hookTop || '').slice(0, 24), hookAccent: String(j.hookAccent || '').slice(0, 12), basedOn: transcript ? 'transcript' : 'title'});
    } catch (e: any) { return json(res, 500, {error: 'hook-suggest 실패: ' + (e?.message || e)}); }
  }
  // ★AI가 영상 화면을 보고 나레이션(해설)을 직접 작성 — 나레이션이 날아간 영상도 빈칸 대신 채워준다(테리 요구).
  if (p.startsWith('/api/highlight/narration-suggest/') && req.method === 'GET') {
    const projectId = p.slice('/api/highlight/narration-suggest/'.length);
    try {
      const text = await suggestNarration(projectId, () => {});
      return json(res, 200, {narration: text});
    } catch (e: any) { return json(res, 500, {error: (e?.message || 'narration-suggest 실패')}); }
  }

  // ── 현재 진행 중 작업(모바일↔PC 공유) — 어느 기기든 이걸 받아 같은 SSE에 붙어 실시간으로 같이 본다 ──
  if (p === '/api/jobs/current' && req.method === 'GET') {
    const j = currentGenJob ? jobs.get(currentGenJob) : undefined;
    if (!j) return json(res, 200, {id: null});
    // ★진행 중이면 어느 기기든 그 작업에 붙을 수 있게 kind도 함께 넘긴다(실시간 기기간 연동의 핵심).
    if (!j.done) return json(res, 200, {id: currentGenJob, kind: j.kind});
    // ★완료됐으면 최근(30분 내) 결과를 다른 기기도 바로 볼 수 있게 함께 넘긴다(PC↔모바일 완성본 연동).
    const fresh = j.doneAt && Date.now() - j.doneAt < 30 * 60 * 1000;
    return json(res, 200, {
      id: null,
      done: fresh && !j.error ? {id: j.id, file: j.file, title: j.title, projectId: j.projectId, kind: j.kind, images: j.images, zip: j.zip} : null,
      doneId: fresh ? j.id : undefined, // ★완료돼도 이 작업 로그를 /api/job-logs/{doneId}로 다시 볼 수 있게(로그 사라짐 버그 해결)
    });
  }
  // ── 작업 로그 조회(완료된 작업도 메모리에 남아 있어 '제작 끝나면 로그 사라짐'을 해결) ──
  if (p.startsWith('/api/job-logs/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/job-logs/'.length));
    const j = jobs.get(id);
    if (!j) return json(res, 404, {error: '작업 로그를 찾을 수 없습니다(서버 재시작 시 사라질 수 있어요).'});
    return json(res, 200, {logs: j.logs || [], done: j.done, error: j.error || null, title: j.title || ''});
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
    let sentClips = 0;
    let lastWrite = Date.now();
    const timer = setInterval(() => {
      let wrote = false;
      while (sent < job.logs.length) {
        res.write(`data: ${JSON.stringify({log: job.logs[sent]})}\n\n`);
        sent++;
        wrote = true;
      }
      // ★먼저 완성된 편을 즉시 흘린다(하이라이트) — 3편 다 안 끝나도 끝난 편부터 바로 쓸 수 있게.
      while (job.clips && sentClips < job.clips.length) {
        res.write(`data: ${JSON.stringify({clip: job.clips[sentClips]})}\n\n`);
        sentClips++;
        wrote = true;
      }
      // ★heartbeat — 영화(RunPod 팟 부팅) 등으로 새 로그 없이 몇 분씩 조용할 때
      //   연결이 idle로 끊기지 않게 15초마다 주석 핑을 보낸다(EventSource는 ':' 줄 무시).
      if (wrote) lastWrite = Date.now();
      else if (Date.now() - lastWrite > 15000) { res.write(': ping\n\n'); lastWrite = Date.now(); }
      if (job.done) {
        res.write(
          `data: ${JSON.stringify({done: true, file: job.file, title: job.title, error: job.error, kind: job.kind, images: job.images, zip: job.zip, projectId: job.projectId, clips: job.clips, storyboard: job.storyboard, bible: job.bible})}\n\n`,
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
  const igRefresh = () => {
    maybeRefreshInstagram((m) => console.log(m)).catch(() => {});
    maybeRefreshThreads((m) => console.log(m)).catch(() => {}); // 스레드 토큰도 45일↑면 th_refresh_token 연장
  };
  igRefresh();
  setInterval(igRefresh, 24 * 60 * 60 * 1000);
  // ★yt-dlp 하루 1회 자동 최신화 — Railway 서버는 잘 재시작을 안 해(=부팅 최신화가 안 돎) 유튜브 변경에 뒤처진다.
  //   하루 한 번 최신 nightly를 당겨 '방치해도 알아서 따라붙게'(테리 지시 2026-10-20). 부팅 1시간 뒤 1회 + 24시간마다.
  const ytdlpAutoUpdate = () => updateYtdlp((m) => console.log(m))
    .then((r) => console.log(`[yt-dlp 자동최신화] ${r.before} → ${r.after}${r.changed ? ' (갱신됨)' : ' (이미 최신)'}`))
    .catch((e) => console.log('[yt-dlp 자동최신화] 실패(기존 버전 유지): ' + (e?.message || e)));
  setTimeout(ytdlpAutoUpdate, 60 * 60 * 1000);
  setInterval(ytdlpAutoUpdate, 24 * 60 * 60 * 1000);
  // ★디스크 유지보수: 30분마다 오래된 작업·버려진 업로드 정리 → 볼륨이 꽉 차 ENOSPC 나는 걸 원천 차단.
  // 레거시: 예전엔 업로드를 볼륨(data/hl-uploads)에 뒀다 → 이제 /tmp. 볼륨의 옛 업로드 폴더는 통째로 비운다(볼륨 공간 회수).
  try { fs.rmSync(path.join(STUDIO_DATA_DIR, 'hl-uploads'), {recursive: true, force: true}); } catch {}
  runMaintenance('부팅'); // 부팅 즉시 1회(현재 꽉 찬 볼륨도 비움)
  setInterval(() => runMaintenance('주기'), 30 * 60 * 1000);
  // 구버전 하이라이트(project.json 없음) 복구 → 기존 것도 유튜브·인스타 업로드 가능.
  backfillHighlightProjects((m) => console.log(m)).catch(() => {});
});
