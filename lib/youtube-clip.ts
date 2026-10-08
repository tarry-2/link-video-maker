// 재사용 가능(CC) 유튜브 영상 → 바이럴 하이라이트 숏폼 소재 추출.
// 1) yt-dlp로 영상+자동자막 다운로드  2) 자막 텍스트를 Gemini에 줘서 바이럴 구간 N개 선정
// 3) ffmpeg로 그 구간을 9:16 세로로 크롭해 클립 mp4로 잘라낸다.
// ★GPU·유료 생성 없음(남의 CC 영상을 자르는 것). 비용 = Gemini 호출 몇 원뿐.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {geminiGenerate} from './gemini';
import {reframeClip} from './reframe';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

export type Highlight = {start: number; end: number; hookTop: string; hookAccent: string; reason: string; score: number};
export type ClipResult = {file: string; start: number; end: number; hookTop: string; hookAccent: string; transcript?: string; score: number; reason?: string};

function run(cmd: string, args: string[], log: (m: string) => void, timeoutMs = 300000, onLine?: (line: string) => void, cancelled?: () => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '', killedByCancel = false;
    const t = setTimeout(() => { ps.kill('SIGKILL'); reject(new Error(`${cmd} 시간 초과`)); }, timeoutMs);
    // ★중단 즉시 반영 — 돌아가는 yt-dlp/ffmpeg 자식 프로세스를 바로 죽인다(플래그만 세우면 이 긴 작업이 안 멈춤).
    const ca = cancelled ? setInterval(() => { if (cancelled()) { killedByCancel = true; try { ps.kill('SIGKILL'); } catch {} } }, 400) : null;
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; if (onLine) String(d).split(/[\r\n]+/).forEach((l) => l && onLine(l)); });
    ps.on('error', (e) => { clearTimeout(t); if (ca) clearInterval(ca); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(t); if (ca) clearInterval(ca);
      if (killedByCancel) return reject(new Error('사용자가 중단했습니다.'));
      code === 0 ? resolve(out) : reject(new Error((err || out).slice(-400)));
    });
  });
}

// yt-dlp가 서버에 있는지(없으면 친절한 안내).
export async function ytdlpAvailable(): Promise<boolean> {
  try { await run(YTDLP, ['--version'], () => {}, 10000); return true; } catch { return false; }
}

// 유튜브 다운로드 시도 클라이언트 순서(쿠키/프록시 환경에 맞는 순).
const CLIENTS = ['web_embedded', 'default', 'android', 'ios', 'web_safari'];

// 공통 yt-dlp 인자 + 쿠키/프록시/PO토큰 상태 로그(작업당 1회). 반환 {common, cookieUsed}.
async function buildCommon(log: (m: string) => void): Promise<{common: string[]; cookieUsed: boolean}> {
  // -4=IPv4 강제(데이터센터 IPv6가 더 자주 차단됨), --sleep-requests=레이트리밋 완화.
  const common = ['--no-playlist', '--no-warnings', '--retries', '5', '--socket-timeout', '30', '--sleep-requests', '1', '-4'];
  const ckFile = process.env.YT_COOKIES_FILE;
  const cookieUsed = !!(ckFile && fs.existsSync(ckFile));
  if (cookieUsed) {
    let age = '';
    try { const days = (Date.now() - fs.statSync(ckFile!).mtimeMs) / 86400000;
      age = days < 1 ? `${Math.round(days * 24)}시간 전 등록` : `${Math.floor(days)}일 전 등록`; } catch {}
    common.push('--cookies', ckFile!);
    log(`[하이라이트] 🔑 유튜브 쿠키 사용 (${age}).`);
  } else {
    log('[하이라이트] ⚠️ 유튜브 쿠키 없음 — 설정에서 쿠키를 등록하세요.');
  }
  if (process.env.YT_PROXY) {
    common.push('--proxy', process.env.YT_PROXY);
    const kr = /__cr\.kr|[_.]kr[;:]|country[-_]?kr/i.test(process.env.YT_PROXY) ? '한국 ' : '';
    log(`[하이라이트] 🌐 프록시 사용 중 (${kr}주거용 IP로 우회 — 봇차단 회피).`);
  } else {
    log('[하이라이트] 🌐 프록시 미사용 (데이터센터 IP 직접 — 봇차단 가능).');
  }
  try {
    await fetch('http://127.0.0.1:4416/ping', {signal: AbortSignal.timeout(3000)});
    log('[하이라이트] 🛡 PO토큰 서버 작동중.');
  } catch { log('[하이라이트] ⚠️ PO토큰 서버 응답없음.'); }
  return {common, cookieUsed};
}

// ── 아카이브 긁기 — 특정 유튜브 채널(KBS 아카이브 등) 안에서 주제(키워드)로 영상 목록을 가져온다. ──
//   다운로드 아니라 '목록 메타'만(--flat-playlist) 긁으므로 가볍다. 실제 제작은 기존 하이라이트 엔진 재사용.
export type ArchiveVideo = {id: string; title: string; duration: number; viewCount: number; thumbnail: string; url: string};

export async function searchArchiveChannel(
  channel: string, query: string, max: number, log: (m: string) => void,
): Promise<ArchiveVideo[]> {
  const {common} = await buildCommon(log);
  const flat = common.filter((a) => a !== '--no-playlist'); // 채널 검색은 플레이리스트라 --no-playlist 제거
  const url = `https://www.youtube.com/@${channel}/search?query=${encodeURIComponent(query)}`;
  log(`[아카이브] "${channel}" 채널에서 "${query}" 검색…`);
  const out = await run(YTDLP, [...flat, '--flat-playlist', '--playlist-end', String(Math.max(1, Math.min(40, max))), '-J', url], log, 60000);
  let data: any;
  try { data = JSON.parse(out); } catch { throw new Error('목록을 읽지 못했습니다(응답 형식 오류).'); }
  const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
  const list = entries.filter((e) => e && e.id).map((e): ArchiveVideo => ({
    id: e.id,
    title: e.title || '(제목 없음)',
    duration: Math.round(e.duration || 0),
    viewCount: e.view_count || 0,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, // flat 응답엔 썸네일이 불완전 → 안정적인 고정 URL
    url: `https://www.youtube.com/watch?v=${e.id}`,
  }));
  log(`[아카이브] ${list.length}개 영상 확보.`);
  return list;
}

// ★메타(영상 길이)+자막만 가볍게 받는다. 통짜 영상은 안 받음 — 프록시(주거용 IP)로 39분 1GB는 느려서 타임아웃.
//   하이라이트 구간을 정한 뒤 그 구간만 받는다(downloadSection) → 데이터·시간 ~10배↓.
async function fetchMetaAndSubs(
  videoId: string, dir: string, log: (m: string) => void, common: string[], cookieUsed: boolean, cancelled?: () => boolean,
): Promise<{subText: string; duration: number}> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const base = path.join(dir, 'src');
  log('[하이라이트] 자막·정보 가져오는 중…(가볍게, 영상은 구간만 나중에)');
  let ok = false, lastErr = '', duration = 0;
  for (const client of CLIENTS) {
    if (cancelled?.()) throw new Error('사용자가 중단했습니다.');
    const ca = client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`];
    try {
      const out = await run(YTDLP, [...common, ...ca, '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en,ko', '--sub-format', 'vtt', '--print', '%(duration)s', '-o', base + '.%(ext)s', url], log, 120000, undefined, cancelled);
      const d = parseInt(String(out).trim().split(/\s+/).pop() || '', 10);
      if (Number.isFinite(d) && d > 0) duration = d;
      ok = true; break;
    } catch (e: any) {
      lastErr = (e?.message || '').slice(0, 200);
      if (/사용자가 중단/.test(lastErr)) throw new Error('사용자가 중단했습니다.');
      log(`[하이라이트] ${client} 실패: ${lastErr.replace(/\s+/g, ' ').slice(0, 120)} → 다음 방식 시도`);
    }
  }
  if (!ok) {
    const botBlocked = /not a bot|Sign in to confirm|cookies|consent/i.test(lastErr);
    if (botBlocked && cookieUsed)
      throw new Error('쿠키를 등록했는데도 유튜브가 막았어요 — 쿠키가 만료됐을 가능성이 커요. 크롬에서 유튜브 로그인 상태로 쿠키를 "새로" 내보내 다시 등록해 주세요. (마지막 사유: ' + lastErr.slice(0, 100) + ')');
    if (botBlocked)
      throw new Error('유튜브가 이 서버를 "봇"으로 보고 막았어요. 쿠키/프록시 설정이 필요합니다. (' + lastErr.slice(0, 100) + ')');
    throw new Error('영상 정보 가져오기 실패. ' + lastErr);
  }
  let subText = '';
  const vtt = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => /\.vtt$/.test(f));
  if (vtt) subText = vttToTimedText(fs.readFileSync(vtt, 'utf8'));
  else log('[하이라이트] 자막 없음(균등 분할로 진행)');
  return {subText, duration};
}

// ★한 구간만 다운로드(--download-sections) — 그 구간 바이트만 받아 프록시 데이터·시간 대폭 절약.
//   반환=섹션 파일 경로(섹션은 0초부터 시작하므로 이후 크롭은 파일 전체 대상).
async function downloadSection(
  videoId: string, dir: string, idx: number, start: number, end: number,
  log: (m: string) => void, common: string[], cancelled?: () => boolean,
): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outBase = path.join(dir, `sec-${idx}`);
  const section = `*${Math.max(0, Math.floor(start))}-${Math.ceil(end)}`;
  const findFile = () => fs.readdirSync(dir).map(x => path.join(dir, x)).find(x => new RegExp(`sec-${idx}\\.(mp4|mkv|webm)$`).test(x));
  let lastErr = '';
  for (const client of CLIENTS) {
    if (cancelled?.()) throw new Error('사용자가 중단했습니다.');
    // 이전 클라 시도가 남긴 (깨졌을 수 있는) 파일 제거 — 다음 시도 결과와 섞여 오인되지 않게.
    const prev = findFile(); if (prev) { try { fs.rmSync(prev, {force: true}); } catch {} }
    const ca = client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`];
    try {
      await run(YTDLP, [...common, ...ca, '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
        '--download-sections', section, '--merge-output-format', 'mp4', '-o', outBase + '.%(ext)s', url], log, 300000, undefined, cancelled);
    } catch (e: any) {
      lastErr = (e?.message || '').slice(0, 200);
      if (/사용자가 중단/.test(lastErr)) throw new Error('사용자가 중단했습니다.');
      log(`[하이라이트] ${client} 구간 실패 → 다음 방식 시도`);
      continue;
    }
    // ★다운로드 성공(exit 0)이어도 '영상 트랙이 실제로 있는지' 검증 — 없으면(오디오만/깨짐) 크롭·렌더까지
    //   끌고 가면 "No video stream"으로 터지므로, 여기서 걸러 다음 클라로 재시도한다.
    const f = findFile();
    if (!f) { lastErr = '다운로드 파일을 찾지 못함'; log(`[하이라이트] ${client} 구간: 파일 없음 → 다음 방식 시도`); continue; }
    if (!(await hasVideoStream(f))) {
      lastErr = '받은 파일에 영상 트랙이 없음(오디오만/깨짐)';
      log(`[하이라이트] ${client} 구간: 받은 파일에 영상이 없어요(깨짐) → 다음 방식 시도`);
      try { fs.rmSync(f, {force: true}); } catch {}
      continue;
    }
    return f; // 영상 트랙이 확인된 유효 파일
  }
  throw new Error('구간 다운로드 실패(유효한 영상을 못 받음): ' + lastErr);
}

// VTT 자막 → "[초] 텍스트" 줄들로. (하이라이트 선정용 — 어디서 무슨 말 하는지)
function vttToTimedText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let curSec = -1, seen = new Set<string>();
  for (const ln of lines) {
    const m = /^(\d{2}):(\d{2}):(\d{2})\.\d+\s+-->/.exec(ln);
    if (m) { curSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]); continue; }
    const t = ln.replace(/<[^>]+>/g, '').trim();
    if (t && curSec >= 0 && !/^(WEBVTT|Kind:|Language:)/.test(t) && !seen.has(curSec + t)) {
      seen.add(curSec + t); out.push(`[${curSec}s] ${t}`);
    }
  }
  return out.join('\n').slice(0, 12000); // 토큰 절약(앞부분 위주)
}

// subText("[N초] 텍스트" 줄들)에서 [start,end]초 구간의 대사만 뽑아 한 덩어리로(해설 대본 근거용).
function sliceTranscript(subText: string, start: number, end: number): string {
  if (!subText) return '';
  const out: string[] = [];
  for (const ln of subText.split('\n')) {
    const m = /^\[(\d+)s\]\s*(.*)$/.exec(ln);
    if (!m) continue;
    const sec = Number(m[1]);
    if (sec >= start - 1 && sec <= end + 1 && m[2].trim()) out.push(m[2].trim());
  }
  return out.join(' ').slice(0, 1200);
}

// 영상 길이(초) — ffprobe.
async function durationOf(file: string): Promise<number> {
  const probe = (process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg$/, 'ffprobe'));
  try {
    const out = await run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], () => {}, 20000);
    return Math.floor(Number(out.trim()) || 0);
  } catch { return 0; }
}

// 파일에 실제 비디오(영상) 트랙이 있는지 — ffprobe. 다운로드가 오디오만/깨진 조각을 받으면 false.
//   (yt-dlp exit 0이어도 클라이언트에 따라 영상 없는 파일을 뱉는 경우가 있어, 크롭·렌더 전에 거른다.)
async function hasVideoStream(file: string): Promise<boolean> {
  const probe = (process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg$/, 'ffprobe'));
  try {
    const out = await run(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', file], () => {}, 20000);
    return /video/.test(out);
  } catch { return false; }
}

// 영상을 앞에서부터 N개 구간으로 나눈다(순차 분할). 하이라이트 모음 영상처럼 "이미 전체가 하이라이트"면
//   굳이 베스트를 또 못 고르므로, 그냥 순서대로 N개를 쓴다. 후킹은 자막으로 나중에 붙인다.
function splitEvenly(durationSec: number, n: number, clipSec: number): Highlight[] {
  const hs: Highlight[] = [];
  const usable = Math.max(0, durationSec - 2);
  const gap = Math.max(clipSec, Math.floor(usable / n)); // 겹치지 않게 간격
  for (let i = 0; i < n; i++) {
    const start = Math.min(usable - clipSec, i * gap);
    if (start < 0) break;
    hs.push({start: Math.max(0, start), end: Math.min(durationSec, start + clipSec), hookTop: '', hookAccent: '', reason: '', score: 60});
  }
  return hs;
}

// 하이라이트 N개 선정. 자막 있으면 Gemini가 "터지는 순간"을 우선 고르고, 부족하면 순차 분할로 채워 N개 보장.
//   자막 없어도 순차 분할로 진행(이미 하이라이트 모음인 영상도 많으니 실패시키지 않는다 — 테리 지시).
async function pickHighlights(geminiKeys: string[], subText: string, durationSec: number, count: number, clipSec: number, log: (m: string) => void): Promise<Highlight[]> {
  const n = Math.max(1, Math.min(10, count));

  // 자막이 없으면 바로 순차 분할(내용을 모르니 베스트를 고를 수 없음 — 그래도 진행).
  if (!subText || !geminiKeys.length) {
    log('[하이라이트] 자막이 없어 영상을 앞에서부터 순서대로 나눕니다(이미 하이라이트인 영상에 적합).');
    return splitEvenly(durationSec, n, clipSec);
  }

  const prompt = `너는 유튜브 영상에서 쇼츠로 쓸 구간을 고르는 편집자다. 아래는 한 영상의 자막(초 단위)이다.
시청자가 좋아할 만한 순간 ${n}개를 각 약 ${clipSec}초 길이로 골라라.

[원칙]
- 명대사/반전/웃긴/감동/충격/핵심 정보처럼 **후킹 자막을 붙일 만한, 그 자체로 말이 되는 구간**을 우선.
- 이 영상이 이미 '하이라이트 모음·명장면 모음'이면, 각 장면이 바뀌는 지점을 구간으로 잡아라.
- 문장 중간에서 끊지 말고, 말이 시작되는 지점부터 완결되는 지점까지.
- 겹치지 마라. 영상 길이 ${durationSec}초를 넘지 마라. 가능하면 ${n}개를 채워라(이 영상은 쇼츠 소재로 쓸 거다).

[각 구간]
- start/end: 초(정수), end-start ≈ ${clipSec}초(±10초).
- hookTop: 상단 후킹(한국어 12자 내외, 그 구간 내용과 맞게, 궁금증·과장 OK).
- hookAccent: 강조 단어(한국어 6자 내).
- reason: 왜 좋은지 15자 내.
- score: 이 구간이 쇼츠로 "터질" 확률 0~100 정수(후킹 세기·감정·반전·정보가치로 냉정하게 차등. 80+는 진짜 강한 것만, 평범하면 50~65).

자막:
${subText}

JSON만 출력: {"highlights":[{"start":0,"end":${clipSec},"hookTop":"...","hookAccent":"...","reason":"...","score":78}]}`;
  let hs: Highlight[] = [];
  try {
    const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 2048, temperature: 0.7, log});
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    hs = (j.highlights || []).slice(0, n).map((h: any) => ({
      start: Math.max(0, Math.floor(h.start || 0)),
      end: Math.min(durationSec, Math.floor(h.end || (h.start + clipSec))),
      hookTop: String(h.hookTop || '').slice(0, 24),
      hookAccent: String(h.hookAccent || '').slice(0, 12),
      reason: String(h.reason || '').slice(0, 24),
      score: Math.max(0, Math.min(100, Math.round(Number(h.score) || 65))),
    })).filter((h: Highlight) => h.end > h.start + 2);
  } catch (e: any) {
    log('[하이라이트] 자막 분석 실패 → 순서대로 나눕니다: ' + (e?.message || '').slice(0, 80));
  }

  // ★겹침 제거(핵심) — Gemini가 "겹치지 마라"를 어기고 겹친 구간을 줄 수 있다(0~60 + 30~90 등).
  //   OpusClip처럼 '절대 안 겹치게' 하려면 실제 시간대가 겹치는 구간을 버려야 한다.
  //   시작 순으로 정렬 후, 직전에 '채택한' 구간의 end 이후(겹침 여유 1초)에 시작하는 것만 남긴다.
  const dropOverlaps = (list: Highlight[]): Highlight[] => {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    const kept: Highlight[] = [];
    for (const h of sorted) {
      const last = kept[kept.length - 1];
      if (!last || h.start >= last.end - 1) kept.push(h); // 직전 구간이 끝난 뒤 시작해야 채택
    }
    return kept;
  };
  hs = dropOverlaps(hs).slice(0, n);

  // 부족하면(또는 0개면) 순차 분할로 N개까지 채운다 — 기존 채택 구간과 '시간대가 겹치지 않는' 것만.
  if (hs.length < n) {
    const need = n - hs.length;
    if (hs.length) log(`[하이라이트] AI가 ${hs.length}개 골랐고, 최대 ${need}개를 겹치지 않게 더 채웁니다.`);
    const extra = splitEvenly(durationSec, n * 2, clipSec).filter((e) =>
      !hs.some((h) => e.start < h.end && e.end > h.start)); // 시간대가 실제로 겹치면 제외
    hs = dropOverlaps(hs.concat(extra)).slice(0, n); // 합친 뒤에도 다시 겹침 제거(추가분끼리도)
  }
  hs.sort((a, b) => a.start - b.start);
  log(`[하이라이트] 구간 ${hs.length}개 확정`);
  hs.forEach((h, i) => log(`[하이라이트]   ${i + 1}. ${h.start}~${h.end}초 · 🔥${h.score}점${h.reason ? ' · ' + h.reason : ''}`));
  return hs;
}

// 구간 파일(sec-*.mp4, 이미 그 구간만 담겨 0초 시작)을 9:16/16:9로 크롭. totalSec=진행률 계산용 길이.
// orientation='portrait'=세로9:16(블러레터박스) / 'landscape'=가로16:9(원본 그대로).
async function cutClip(videoPath: string, outPath: string, orientation: 'portrait' | 'landscape', log: (m: string) => void, totalSec: number, cancelled?: () => boolean): Promise<void> {
  // ★남 채널 워터마크(보통 모서리) 지우기: 입력을 6% 확대 크롭해 가장자리를 화면 밖으로 밀어낸다.
  //   화질 손상 거의 없음(1080p 기준 ~6%). 중앙 큰 워터마크는 못 지움(드묾).
  const dewm = 'crop=iw/1.12:ih/1.12'; // 12% 확대 크롭 — 모서리 워터마크 대부분 제거(상하좌우 ~6%씩 잘림)
  let args: string[];
  if (orientation === 'landscape') {
    // 가로: 워터마크 크롭 후 16:9(1920x1080)에 맞춤(레터박스). 자막 보존·화질 손실 거의 없음.
    const vf = `${dewm},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black`;
    args = ['-vf', vf];
  } else {
    // 세로: 워터마크 크롭 후 원본 안 자르고 세로 중앙에 통째로 + 위아래 블러배경(자막 안 잘림).
    // ★블러 배경은 저해상도(270x480)에서 만들고 1080x1920으로 키운다. 어차피 흐린 배경이라 체감 화질은
    //   동일한데, 풀해상도(1080x1920)에 boxblur=28을 거는 것보다 픽셀이 ~16배 적어 크롭이 3~5배 빠르고
    //   메모리도 훨씬 덜 쓴다(2분짜리 클립에서 수십 분 걸리던 병목의 주원인이었음).
    const vf = [
      `[0:v]${dewm},split=2[a][b]`,
      '[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:1,eq=brightness=-0.12,scale=1080:1920[bg]',
      '[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2',
    ].join(';');
    args = ['-filter_complex', vf];
  }
  // 진행률 하트비트 — ffmpeg stderr의 time= 을 읽어 "자르는 중 N%"를 주기적으로 찍는다.
  //   (클립당 로그가 1줄뿐이라 몇 분간 멈춘 것처럼 보이던 문제 해결.)
  const total = Math.max(1, totalSec);
  let lastPct = -1, lastAt = 0;
  const onLine = (line: string) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (!m) return;
    const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    const pct = Math.min(99, Math.max(0, Math.round((t / total) * 100)));
    const now = Date.now();
    if (pct >= lastPct + 5 && now - lastAt > 2500) { lastPct = pct; lastAt = now; log(`[하이라이트]   자르는 중… ${pct}%`); }
  };
  // crf 20 = 선명. preset veryfast = 같은 화질(crf 고정)로 인코딩만 대폭 빠르게(파일이 조금 커질 뿐).
  //   2분짜리 클립을 medium으로 뽑으면 클립당 수 분씩 걸려 전체가 40분+ 가 되던 걸 줄인다.
  await run(FFMPEG, ['-y', '-i', videoPath,
    ...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath], log, 420000, onLine, cancelled);
}

// 로컬 파일(본인 업로드 영상)에서 [start,end] 구간만 잘라 sec-i.mp4로. YouTube downloadSection의 로컬판.
async function cutSectionLocal(src: string, dir: string, idx: number, start: number, end: number, cancelled?: () => boolean): Promise<string> {
  const out = path.join(dir, `sec-${idx}.mp4`);
  await run(FFMPEG, ['-y', '-ss', String(Math.max(0, Math.floor(start))), '-to', String(Math.ceil(end)), '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
    () => {}, 240000, undefined, cancelled);
  if (!fs.existsSync(out)) throw new Error('구간 추출 실패');
  return out;
}

// 전체: videoId(또는 로컬 업로드 파일) → N개 하이라이트 클립 생성. dir는 작업 폴더.
export async function extractHighlights(
  videoId: string, dir: string, geminiKeys: string[],
  opts: {count?: number; clipSec?: number; log?: (m: string) => void; isCancelled?: () => boolean; orientation?: 'portrait' | 'landscape'; reframe?: 'track' | 'letterbox'; localFile?: string} = {},
): Promise<ClipResult[]> {
  const log = opts.log || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const stop = () => { if (cancelled()) throw new Error('사용자가 중단했습니다.'); };
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const reframe = opts.reframe === 'letterbox' ? 'letterbox' : 'track'; // 세로 변환 방식(기본=인물 추적)
  const count = Math.max(1, Math.min(10, opts.count || 3));
  const clipSec = Math.max(15, Math.min(600, opts.clipSec || 30)); // 최대 10분(길게 커스텀 가능)
  const isLocal = !!opts.localFile; // 본인 업로드 영상(유튜브 다운로드·프록시·쿠키 불필요)
  await fsp.mkdir(dir, {recursive: true});
  stop();
  let subText = '', dur = 0, common: string[] = [];
  if (isLocal) {
    // 본인 영상: 다운로드/자막 없음 → 길이만 측정하고 균등 분할(자막 없는 유튜브와 동일 처리).
    log('[하이라이트] 내 영상에서 구간을 나눕니다(자막 없이 균등 분할).');
    dur = await durationOf(opts.localFile!);
  } else {
    if (!(await ytdlpAvailable())) throw new Error('서버에 yt-dlp가 없습니다(배포 환경 확인 필요).');
    // 1) 쿠키/프록시/PO 준비 + 자막·길이만 가볍게(통짜 다운로드 안 함 — 프록시로 1GB는 타임아웃).
    const built = await buildCommon(log); common = built.common;
    stop();
    const meta = await fetchMetaAndSubs(videoId, dir, log, common, built.cookieUsed, cancelled);
    subText = meta.subText; dur = meta.duration;
    if (subText) log(`[하이라이트] 자막 확보: ${subText.length}자 — 내용 기반으로 터질 구간을 고릅니다.`);
    else log('[하이라이트] ⚠️ 자막이 없습니다. 자막(대사)이 있는 영상이라야 하이라이트를 고를 수 있어요.');
  }
  stop();
  if (!dur) throw new Error('영상 길이를 읽지 못했습니다.');
  const highlights = await pickHighlights(geminiKeys, subText, dur, count, clipSec, log);
  if (!highlights.length) throw new Error('하이라이트 구간을 찾지 못했습니다.');
  const results: ClipResult[] = [];
  for (let i = 0; i < highlights.length; i++) {
    stop();
    const h = highlights[i];
    const file = path.join(dir, `clip-${i}.mp4`);
    try {
      // 2) 구간 추출(본인 영상=로컬 컷 / 유튜브=프록시로 그 구간만 다운) → 3) 9:16/16:9 크롭.
      log(`[하이라이트] ${i + 1}/${highlights.length} 구간 ${isLocal ? '자르는' : '받는'} 중 (${h.start}s~${h.end}s)…`);
      const raw = isLocal
        ? await cutSectionLocal(opts.localFile!, dir, i, h.start, h.end, cancelled)
        : await downloadSection(videoId, dir, i, h.start, h.end, log, common, cancelled);
      stop();
      const secDur = (await durationOf(raw)) || (h.end - h.start);
      // 세로+인물추적 모드면 리프레임(인물 꽉채움) 시도 → 실패 시 블러레터박스로 폴백(무회귀).
      let done = false;
      if (orientation === 'portrait' && reframe === 'track') {
        log(`[하이라이트] ${i + 1}/${highlights.length} 인물 추적으로 세로 변환…`);
        done = await reframeClip(raw, file, log, cancelled);
      }
      if (!done) {
        log(`[하이라이트] ${i + 1}/${highlights.length} 자르는 중 (${orientation === 'landscape' ? '가로' : '세로 블러'})…`);
        await cutClip(raw, file, orientation, log, secDur, cancelled);
      }
      try { fs.rmSync(raw, {force: true}); } catch {} // 섹션 원본은 크롭 후 삭제(용량 절약)
      results.push({file, start: h.start, end: h.end, hookTop: h.hookTop, hookAccent: h.hookAccent, transcript: sliceTranscript(subText, h.start, h.end), score: h.score, reason: h.reason});
    } catch (e: any) {
      if (/사용자가 중단/.test(e?.message || '')) throw new Error('사용자가 중단했습니다.'); // 중단이면 다음 컷 말고 즉시 종료
      log(`[하이라이트] ${i + 1}번 구간 실패(건너뜀): ` + (e?.message || '').slice(0, 120));
    }
  }
  if (!results.length) throw new Error('클립을 하나도 만들지 못했습니다.');
  return results;
}
