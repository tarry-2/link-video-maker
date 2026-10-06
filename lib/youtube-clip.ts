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
  const common = ['--no-playlist', '--no-warnings', '--retries', '5', '--socket-timeout', '30', '--sleep-requests', '1'];
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) common.push('--cookies', process.env.YT_COOKIES_FILE);
  if (process.env.YT_PROXY) common.push('--proxy', process.env.YT_PROXY);
  // ★403/봇차단 뚫기: 유튜브는 web 클라이언트에 PO토큰 핸드셰이크를 요구하지만 android/ios/tv 클라이언트는
  //   그게 없어 데이터센터 IP에서도 잘 뚫린다(2026 공식 권장). 여러 클라이언트를 순서대로 때려 하나라도 되면 성공.
  const CLIENTS = ['android', 'ios', 'tv', 'web_safari', 'default'];
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
  if (!ok) throw new Error('모든 방식으로 영상 다운로드 실패(유튜브 차단). ' + lastErr);
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

// Gemini로 바이럴 하이라이트 N개 선정. 자막 있으면 그 내용 기반, 없으면 길이 기준 균등 분할 폴백.
async function pickHighlights(geminiKeys: string[], subText: string, durationSec: number, count: number, clipSec: number, log: (m: string) => void): Promise<Highlight[]> {
  const n = Math.max(1, Math.min(10, count));
  // 🔴 진짜 하이라이트만 — 자막(내용)이 반드시 있어야 "터질 구간"을 고를 수 있다.
  //   자막이 없으면 시간 균등분할(=그냥 이어붙이기)은 하지 않는다. 테리 지시: 시간 이어맞추기 하이라이트 금지.
  if (!subText || !geminiKeys.length) {
    throw new Error('이 영상은 자막(대사) 정보가 없어 어디가 터지는 구간인지 알 수 없습니다. 자막이 있는 다른 영상을 골라주세요(시간 순서로 그냥 자르는 건 하지 않습니다).');
  }
  const prompt = `너는 유튜브 긴 영상에서 "쇼츠로 터질 순간"만 골라내는 최고의 편집자다. 아래는 한 영상의 자막(초 단위)이다.

[가장 중요한 원칙]
- 영상을 처음부터 순서대로 자르지 마라. 시간을 균등하게 나누지 마라. 그건 하이라이트가 아니다.
- 자막 내용을 읽고, "이 부분은 혼자 떼어내도 사람들이 끝까지 보고 공유하겠다" 싶은 **독립적으로 완결되고 임팩트 있는 순간만** 골라라.
- 반전/폭로/명대사/웃긴 순간/감동/충격 사실/핵심 정보처럼 **후킹 자막을 붙일 만한 구간만** 선택한다.
- 밋밋한 설명·인사·늘어지는 부분·맥락 없는 중간은 절대 고르지 마라.
- ★억지로 ${n}개를 채우지 마라. 진짜 터질 만한 게 ${n}개보다 적으면 적게 줘도 된다(품질 우선). 2~3개뿐이어도 그게 맞으면 그렇게.
- 터질 구간이 하나도 없으면 빈 배열을 줘라.

[형식 규칙]
- start/end는 초(정수), end-start ≈ ${clipSec}초(±10초). 서로 겹치지 마라. 영상 길이 ${durationSec}초를 넘지 마라.
- 구간은 "말이 시작되는 지점"부터 "완결되는 지점"까지 자연스럽게. 문장 중간에서 끊지 마라.
- hookTop: 그 구간 상단에 넣을 궁금증 폭발 후킹(한국어 12자 내외, 과장·낚시톤 OK). 그 구간 내용과 반드시 맞아야 한다.
- hookAccent: 후킹에서 강조할 핵심 단어(한국어 6자 내).
- reason: 왜 터질지 15자 내(구체적으로).

자막:
${subText}

JSON만 출력: {"highlights":[{"start":0,"end":${clipSec},"hookTop":"...","hookAccent":"...","reason":"..."}]}`;
  const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 2048, temperature: 0.7, log});
  let j: any;
  try { j = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { throw new Error('하이라이트 구간 분석에 실패했습니다. 다시 시도해 주세요.'); }
  const hs: Highlight[] = (j.highlights || []).slice(0, n).map((h: any) => ({
    start: Math.max(0, Math.floor(h.start || 0)),
    end: Math.min(durationSec, Math.floor(h.end || (h.start + clipSec))),
    hookTop: String(h.hookTop || '').slice(0, 24),
    hookAccent: String(h.hookAccent || '').slice(0, 12),
    reason: String(h.reason || '').slice(0, 24),
  })).filter((h: Highlight) => h.end > h.start + 2);
  if (!hs.length) {
    throw new Error('이 영상에선 쇼츠로 터질 만한 하이라이트 구간을 찾지 못했어요. 다른 영상을 골라주세요(밋밋한 구간을 억지로 자르지 않습니다).');
  }
  log(`[하이라이트] AI가 진짜 터질 구간 ${hs.length}개 선정${hs.length < n ? ` (요청 ${n}개보다 적음 — 품질 우선)` : ''}`);
  hs.forEach((h, i) => log(`[하이라이트]   ${i + 1}. ${h.start}~${h.end}초 · ${h.reason || h.hookTop}`));
  return hs;
}

// 한 구간을 9:16 세로로 크롭해 잘라낸다(중앙 크롭). 반환 파일 경로.
async function cutVertical(videoPath: string, h: Highlight, outPath: string, log: (m: string) => void): Promise<void> {
  // scale→crop로 9:16(1080x1920) 중앙. -ss/-to로 구간. 오디오 포함.
  const vf = `scale=-2:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
  await run(FFMPEG, ['-y', '-ss', String(h.start), '-to', String(h.end), '-i', videoPath,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
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
