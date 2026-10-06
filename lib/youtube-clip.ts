// 재사용 가능(CC) 유튜브 영상 → 바이럴 하이라이트 숏폼 소재 추출.
// 1) yt-dlp로 영상+자동자막 다운로드  2) 자막 텍스트를 Gemini에 줘서 바이럴 구간 N개 선정
// 3) ffmpeg로 그 구간을 9:16 세로로 크롭해 클립 mp4로 잘라낸다.
// ★GPU·유료 생성 없음(남의 CC 영상을 자르는 것). 비용 = Gemini 호출 몇 원뿐.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {geminiGenerate} from './gemini';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

export type Highlight = {start: number; end: number; hookTop: string; hookAccent: string; reason: string};
export type ClipResult = {file: string; start: number; end: number; hookTop: string; hookAccent: string};

function run(cmd: string, args: string[], log: (m: string) => void, timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    const t = setTimeout(() => { ps.kill('SIGKILL'); reject(new Error(`${cmd} 시간 초과`)); }, timeoutMs);
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => { clearTimeout(t); reject(e); });
    ps.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err || out).slice(-400))); });
  });
}

// yt-dlp가 서버에 있는지(없으면 친절한 안내).
export async function ytdlpAvailable(): Promise<boolean> {
  try { await run(YTDLP, ['--version'], () => {}, 10000); return true; } catch { return false; }
}

// 영상 + 자막 다운로드. 반환: {videoPath, subText(초단위 타임스탬프 포함)}.
// ★Railway 같은 데이터센터 IP는 유튜브 봇차단이 잦다 → 쿠키(YT_COOKIES_FILE) 있으면 사용, 속도 제한도 건다.
async function download(videoId: string, dir: string, log: (m: string) => void): Promise<{videoPath: string; subText: string}> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const base = path.join(dir, 'src');
  // -4=IPv4 강제(데이터센터 IPv6가 더 자주 차단됨), --sleep-requests=레이트리밋 완화.
  const common = ['--no-playlist', '--no-warnings', '--retries', '5', '--socket-timeout', '30', '--sleep-requests', '1', '-4'];
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) common.push('--cookies', process.env.YT_COOKIES_FILE);
  if (process.env.YT_PROXY) common.push('--proxy', process.env.YT_PROXY);
  // ★다운로드 뚫기(2026-10 기준): 쿠키 인증 환경에선 tv_downgraded가 "page needs to be reloaded"를 내므로 제외.
  //   web_embedded/default가 쿠키와 가장 잘 맞고, android/ios는 쿠키 없을 때 봇차단 우회용. 순서대로 시도.
  const CLIENTS = ['web_embedded', 'default', 'android', 'ios', 'web_safari'];
  // 1) 영상 먼저 — 720p 이하. https(dash) 우선, 코덱 안 가리고 관대하게. 최종 ffmpeg mp4 머지.
  log('[하이라이트] 영상 다운로드…(용량에 따라 수 분)');
  let ok = false, lastErr = '';
  for (const client of CLIENTS) {
    const ca = client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`];
    try {
      await run(YTDLP, [...common, ...ca, '-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
        '--merge-output-format', 'mp4', '-o', base + '.%(ext)s', url], log, 420000);
      ok = true; log(`[하이라이트] 다운로드 성공(${client})`); break;
    } catch (e: any) {
      lastErr = (e?.message || '').slice(0, 160);
      log(`[하이라이트] ${client} 실패 → 다음 방식 시도`);
    }
  }
  if (!ok) {
    const botBlocked = /not a bot|Sign in to confirm/i.test(lastErr);
    if (botBlocked) throw new Error('유튜브가 이 서버를 "봇"으로 보고 다운로드를 막았어요(클라우드 IP 특성). 해결하려면 유튜브 로그인 쿠키가 필요합니다 — 설정에 쿠키를 등록하면 뚫립니다. (쿠키 없이도 되는 영상/시간대가 있어 다른 영상으로 재시도해볼 수도 있어요.)');
    throw new Error('영상 다운로드 실패. ' + lastErr);
  }
  // 2) 자막(자동 생성 포함) — vtt. 영어 우선. 실패해도 영상은 받았으니 균등분할로 진행(여러 클라이언트 시도).
  log('[하이라이트] 자막 다운로드…');
  for (const client of CLIENTS) {
    const ca = client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`];
    try {
      await run(YTDLP, [...common, ...ca, '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en,ko', '--sub-format', 'vtt', '-o', base + '.%(ext)s', url], log, 120000);
      if (fs.readdirSync(dir).some(f => /\.vtt$/.test(f))) break;
    } catch { /* 다음 클라이언트 */ }
  }
  if (!fs.readdirSync(dir).some(f => /\.vtt$/.test(f))) log('[하이라이트] 자막 없음(균등 분할로 진행)');
  const videoPath = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => /src\.(mp4|mkv|webm)$/.test(f));
  if (!videoPath) throw new Error('영상 파일을 찾지 못했습니다(다운로드 실패).');
  // 자막 vtt → 초단위 텍스트로 합치기(있으면).
  let subText = '';
  const vtt = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => /\.vtt$/.test(f));
  if (vtt) subText = vttToTimedText(fs.readFileSync(vtt, 'utf8'));
  return {videoPath, subText};
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

// 영상 길이(초) — ffprobe.
async function durationOf(file: string): Promise<number> {
  const probe = (process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg$/, 'ffprobe'));
  try {
    const out = await run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], () => {}, 20000);
    return Math.floor(Number(out.trim()) || 0);
  } catch { return 0; }
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
    hs.push({start: Math.max(0, start), end: Math.min(durationSec, start + clipSec), hookTop: '', hookAccent: '', reason: ''});
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

자막:
${subText}

JSON만 출력: {"highlights":[{"start":0,"end":${clipSec},"hookTop":"...","hookAccent":"...","reason":"..."}]}`;
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
    })).filter((h: Highlight) => h.end > h.start + 2);
  } catch (e: any) {
    log('[하이라이트] 자막 분석 실패 → 순서대로 나눕니다: ' + (e?.message || '').slice(0, 80));
  }

  // 부족하면(또는 0개면) 순차 분할로 N개까지 채운다(겹치지 않는 구간만 추가).
  if (hs.length < n) {
    const need = n - hs.length;
    if (hs.length) log(`[하이라이트] AI가 ${hs.length}개 골랐고, ${need}개는 순서대로 채웁니다.`);
    const extra = splitEvenly(durationSec, n, clipSec).filter((e) =>
      !hs.some((h) => Math.abs(h.start - e.start) < clipSec)); // 기존 구간과 안 겹치는 것만
    hs = hs.concat(extra).slice(0, n);
  }
  hs.sort((a, b) => a.start - b.start);
  log(`[하이라이트] 구간 ${hs.length}개 확정`);
  hs.forEach((h, i) => log(`[하이라이트]   ${i + 1}. ${h.start}~${h.end}초${h.reason ? ' · ' + h.reason : ''}`));
  return hs;
}

// 한 구간을 9:16 세로로 크롭해 잘라낸다(중앙 크롭). 반환 파일 경로.
async function cutVertical(videoPath: string, h: Highlight, outPath: string, log: (m: string) => void): Promise<void> {
  // scale→crop로 9:16(1080x1920) 중앙. -ss/-to로 구간. 오디오 포함.
  // ★가로 영상을 세로로 강제 크롭하면 양옆(자막 포함)이 잘린다 → 블러 배경 + 레터박스.
  //   원본을 안 자르고 세로 화면(1080x1920) 중앙에 통째로 넣고, 위아래 빈 곳은 같은 영상을 크게 블러처리해 채운다.
  //   세로 원본이면 자동으로 꽉 차고(배경 거의 안 보임), 가로 원본이면 위아래 블러띠가 생겨 자막이 안 잘린다.
  const vf = [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:2,eq=brightness=-0.12[bg]',
    '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2',
  ].join(';');
  await run(FFMPEG, ['-y', '-ss', String(h.start), '-to', String(h.end), '-i', videoPath,
    '-filter_complex', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath], log, 240000);
}

// 전체: videoId → N개 세로 하이라이트 클립 생성. dir는 작업 폴더.
export async function extractHighlights(
  videoId: string, dir: string, geminiKeys: string[],
  opts: {count?: number; clipSec?: number; log?: (m: string) => void; isCancelled?: () => boolean} = {},
): Promise<ClipResult[]> {
  const log = opts.log || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const stop = () => { if (cancelled()) throw new Error('사용자가 중단했습니다.'); };
  const count = Math.max(1, Math.min(10, opts.count || 3));
  const clipSec = Math.max(15, Math.min(60, opts.clipSec || 30));
  await fsp.mkdir(dir, {recursive: true});
  if (!(await ytdlpAvailable())) throw new Error('서버에 yt-dlp가 없습니다(배포 환경 확인 필요).');
  stop();
  const {videoPath, subText} = await download(videoId, dir, log);
  stop();
  // 자막 상태 로그(왜 구간을 못 찾았는지 바로 보이게).
  if (subText) log(`[하이라이트] 자막 확보: ${subText.length}자 — 내용 기반으로 터질 구간을 고릅니다.`);
  else log('[하이라이트] ⚠️ 자막이 없습니다. 자막(대사)이 있는 영상이라야 하이라이트를 고를 수 있어요.');
  const dur = await durationOf(videoPath);
  if (!dur) throw new Error('영상 길이를 읽지 못했습니다.');
  const highlights = await pickHighlights(geminiKeys, subText, dur, count, clipSec, log);
  if (!highlights.length) throw new Error('하이라이트 구간을 찾지 못했습니다.');
  const results: ClipResult[] = [];
  for (let i = 0; i < highlights.length; i++) {
    stop();
    const h = highlights[i];
    const file = path.join(dir, `clip-${i}.mp4`);
    log(`[하이라이트] ${i + 1}/${highlights.length} 자르는 중 (${h.start}s~${h.end}s)…`);
    try {
      await cutVertical(videoPath, h, file, log);
      results.push({file, start: h.start, end: h.end, hookTop: h.hookTop, hookAccent: h.hookAccent});
    } catch (e: any) { log(`[하이라이트] ${i + 1}번 컷 실패(건너뜀): ` + (e?.message || '').slice(0, 120)); }
  }
  if (!results.length) throw new Error('클립을 하나도 만들지 못했습니다.');
  // 원본 영상 삭제(용량 절약) — 클립만 남긴다.
  try { fs.rmSync(videoPath, {force: true}); } catch {}
  return results;
}
