// 하이라이트 '빠른 렌더' — Remotion으로 프레임마다 다시 그리지 않고(2분=3600프레임, 서버서 6분),
//   원본 영상에 후킹(투명 PNG)+자막(ASS 카라오케)만 ffmpeg로 '한 번' 합성(~1분). 화질(crf20)·디자인 무손실.
// 흐름: ①renderHookStill로 후킹 투명 PNG(Scene와 동일 디자인) ②words→ASS 카라오케 파일
//       ③ffmpeg: 클립 + 후킹 오버레이(페이드인) + 자막 + 오디오(나레이션 믹스/더킹/뮤트) → mp4
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {renderHookStill} from './render';
import {getHlTemplate} from '../src/highlight-templates';
import type {Word} from './tts';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts');
const FPS = 30;

function run(args: string[], log: (m: string) => void, onLine?: (l: string) => void, cancelled?: () => boolean, timeoutMs = 420000): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn(FFMPEG, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '', killed = false;
    const t = setTimeout(() => { ps.kill('SIGKILL'); reject(new Error('ffmpeg 시간 초과')); }, timeoutMs);
    const ca = cancelled ? setInterval(() => { if (cancelled()) { killed = true; try { ps.kill('SIGKILL'); } catch {} } }, 400) : null;
    ps.stderr.on('data', (d) => { err += d; if (onLine) String(d).split(/[\r\n]+/).forEach((l) => l && onLine(l)); });
    ps.on('error', (e) => { clearTimeout(t); if (ca) clearInterval(ca); reject(e); });
    ps.on('close', (code) => { clearTimeout(t); if (ca) clearInterval(ca); if (killed) return reject(new Error('사용자가 중단했습니다.')); code === 0 ? resolve() : reject(new Error(err.slice(-300))); });
  });
}

// #RRGGBB → ASS &HBBGGRR (BGR 역순). 실패 시 흰색.
function assColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '&H00FFFFFF';
  const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function assTime(sec: number): string {
  const h = Math.floor(sec / 3600), mi = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(mi).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// words(프레임 단위 타이밍) → ASS 카라오케 자막. 활성 단어는 템플릿 강조색으로 바뀐다(카라오케 \k).
//   단어를 '줄'로 묶어(최대 ~7자*4어 또는 빈틈>0.6s에서 끊음) 표준 쇼츠 자막 느낌.
function buildAss(words: Word[], template: string, orientation: 'portrait' | 'landscape', subLines?: {text: string; s: number; e: number}[]): string {
  const T = getHlTemplate(template);
  const land = orientation === 'landscape';
  const W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  const fontSize = land ? 56 : 64;
  // ★자막을 '유튜브 쇼츠 하단 UI(계정·태그·버튼·시크바)' 위로 올린다 — 하단에 두면 그 UI가 자막을 가린다(테리 지적).
  //   한국어만: 하단 UI 위. 한국어+영어: 둘을 더 위로 올려 둘 다 UI에 안 가리고 서로 안 겹치게.
  const hasEn = !!(subLines && subLines.length);
  const marginV = land ? (hasEn ? 150 : 90) : (hasEn ? 560 : 470); // 세로: UI(하단 ~400px) 위로
  const enFontSize = land ? 40 : 46;
  const enMarginV = land ? 70 : 460; // 한국어 줄 바로 아래(그래도 UI 위)
  // 영어 문장은 길어서 한 줄이면 좌우로 넘친다(WrapStyle 2=자동 줄바꿈 없음) → 단어 단위로 \N 줄바꿈.
  const wrapEn = (s: string, max = 30): string => {
    const words = s.split(/\s+/); const lines: string[] = []; let cur = '';
    for (const w of words) { if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
    if (cur) lines.push(cur);
    return lines.slice(0, 2).join('\\N'); // 최대 2줄(공간 보호)
  };
  // 자막 스타일: BorderStyle 1=외곽선. subStyle='box'면 3=불투명 박스.
  const borderStyle = T.subStyle === 'box' ? 3 : 1;
  const outlineW = T.subStyle === 'box' ? 4 : 5;
  const backColour = T.subStyle === 'box' ? '&H99000000' : '&H00000000'; // box면 반투명 검정 박스
  const primary = '&H00FFFFFF';            // 기본(지나간 단어) = 흰색
  const secondary = assColor(T.subActive); // 아직 안 온 단어 = 강조색(카라오케로 흰→강조 전환 느낌)
  const head =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${T.subFont},${fontSize},${primary},${secondary},&H00000000,${backColour},-1,0,0,0,100,100,0,0,${borderStyle},${outlineW},0,2,80,80,${marginV},1
Style: SubEn,${T.subFont},${enFontSize},&H00E6E6E6,&H00E6E6E6,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,80,80,${enMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // 줄 묶기.
  const lines: {s: number; e: number; words: Word[]}[] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const gap = prev ? (w.s - prev.e) / FPS : 0;
    const curLen = cur.reduce((a, x) => a + x.t.length + 1, 0);
    if (cur.length && (cur.length >= 5 || curLen > 16 || gap > 0.6)) { lines.push({s: cur[0].s, e: cur[cur.length - 1].e, words: cur}); cur = []; }
    cur.push(w);
  }
  if (cur.length) lines.push({s: cur[0].s, e: cur[cur.length - 1].e, words: cur});

  const events = lines.map((ln) => {
    // 카라오케: 각 단어를 \k(센티초)로. 활성화되며 secondary→primary 전환.
    const text = ln.words.map((w) => {
      const cs = Math.max(1, Math.round(((w.e - w.s) / FPS) * 100));
      return `{\\k${cs}}${w.t} `;
    }).join('').trim();
    return `Dialogue: 0,${assTime(ln.s / FPS)},${assTime((ln.e + 6) / FPS)},Sub,,0,0,0,,${text}`;
  }).join('\n');
  // 영어 번역 줄(문장 단위) — 한국어 카라오케 아래에 함께 표시(이중 자막). 특수문자 이스케이프.
  const enEvents = hasEn ? '\n' + subLines!.map((l) => {
    const t = (l.text || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').trim();
    if (!t) return '';
    return `Dialogue: 0,${assTime(l.s / FPS)},${assTime((l.e + 6) / FPS)},SubEn,,0,0,0,,${wrapEn(t)}`;
  }).filter(Boolean).join('\n') : '';
  return head + events + enEvents + '\n';
}

// ffmpeg 경로 이스케이프(filter_complex subtitles용) — 작은따옴표로 감싸고 내부 따옴표/백슬래시 처리.
function esc(p: string): string { return p.replace(/\\/g, '/').replace(/'/g, "\\'"); }

// 빠른 합성 렌더. 성공 true. 실패 false(→호출부가 기존 Remotion renderVideo로 폴백).
export async function renderHighlightFast(opts: {
  clipAbs: string;            // 후킹 없는 깨끗한 세로/가로 클립
  outPath: string;
  hookTop: string; hookAccent: string; template: string; font?: string; // font=사용자가 고른 제목 폰트(모든 탭 공통)
  words: Word[];              // 해설 카라오케(없으면 [])
  narrationAbs?: string;      // 나레이션 mp3(있으면 믹스)
  muteOriginal?: boolean; duckAudio?: boolean;
  durationSec: number;
  orientation: 'portrait' | 'landscape';
  broll?: {path: string; start: number; end: number}[]; // AI b-roll 팝업(관련 이미지가 화면 중앙에 잠깐 떴다 사라짐)
  subLines?: {text: string; s: number; e: number}[];    // 영어 번역 자막(문장 단위, 프레임) — 한국어 카라오케 아래 함께
  log: (m: string) => void;
  isCancelled?: () => boolean;
}): Promise<boolean> {
  const {clipAbs, outPath, hookTop, hookAccent, template, words, narrationAbs, orientation, durationSec, log} = opts;
  const cancelled = opts.isCancelled;
  const land = orientation === 'landscape';
  const W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  const work = path.join(os.tmpdir(), `hl-fast-${randomUUID().slice(0, 8)}`);
  try {
    await fsp.mkdir(work, {recursive: true});
    // 1) 후킹 투명 PNG(Remotion 스틸 — 한 프레임, Scene와 동일 디자인).
    const hookPng = path.join(work, 'hook.png');
    if (hookTop || hookAccent) {
      log('[빠른렌더] 후킹 디자인 생성…');
      // HookStill은 영상 없이 폰트만 쓰므로(public/fonts) 캐시된 기본 번들 사용 — 별도 번들 비용 0.
      await renderHookStill({hookTop, hookAccent, template, font: opts.font, orientation}, hookPng, log);
    }
    if (cancelled?.()) throw new Error('사용자가 중단했습니다.');
    // 2) 자막 ASS(해설 있을 때만).
    let assPath = '';
    if (words.length) { assPath = path.join(work, 'sub.ass'); await fsp.writeFile(assPath, buildAss(words, template, orientation, opts.subLines)); }

    // 3) ffmpeg 합성. 입력: 0=클립, (후킹 있으면)1=hook.png, (나레이션 있으면)다음=narration.
    const inputs: string[] = ['-i', clipAbs];
    let idx = 1; let hookIdx = -1, narrIdx = -1;
    const hasHook = fs.existsSync(hookPng);
    if (hasHook) { inputs.push('-loop', '1', '-i', hookPng); hookIdx = idx++; }
    // b-roll 팝업 이미지들(존재하는 것만) — 각각 -loop 1로 넣고 enable 구간에만 보이게.
    const broll = (opts.broll || []).filter((b) => fs.existsSync(b.path));
    const brollIdx: number[] = [];
    for (const b of broll) { inputs.push('-loop', '1', '-i', b.path); brollIdx.push(idx++); }
    if (narrationAbs && fs.existsSync(narrationAbs)) { inputs.push('-i', narrationAbs); narrIdx = idx++; }

    // 비디오 필터: 클립을 정확히 9:16/16:9로 → ★초반 3초 임팩트(줌펀치+플래시) → 후킹 팝 → 자막.
    const vParts: string[] = [];
    // tpad=clone: 나레이션 '여운'(클립보다 길 때) 동안 마지막 프레임 유지(검은 꼬리 방지). -t로 정확히 자름.
    //   ★초반 줌펀치 — 첫 0.5초 살짝 크게 시작해 빠르게 제자리로(스크롤 멈춤 임팩트, 시청 유지율↑).
    //   zoompan은 전체를 다시 그려 느리므로, scale 확대+crop을 시간식(enable)으로 흉내내지 않고 가벼운 방법 사용:
    //   첫 구간만 1.12배 확대했다가 선형 축소 → overlay로는 어려워 scale2ref 대신 'crop 흔들림'은 과함. 간단·안전하게
    //   전체에 아주 약한 상시 스케일 대신, 첫 0.35초 흰 플래시 + 후킹 바운스로 임팩트를 준다(렌더 비용 거의 0).
    vParts.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},tpad=stop_mode=clone:stop_duration=3,setsar=1[bgc]`);
    // ★초반 흰 플래시 제거 — 시작 프레임이 허옇게 뜨는 '백탁현상'(테리 지적). 임팩트는 후킹 '팝'으로 충분.
    vParts.push(`[bgc]null[bg]`);
    let vlab = '[bg]';
    if (hasHook) {
      // ★후킹 '팝' 등장 — 작게 시작→튕기며 커짐(0.9→1.08→1.0). 부드러운 fade 대신 시선을 확 잡는다.
      //   overlay 위치를 scale과 함께 쓰려면 후킹을 매 프레임 scale해야 하므로, 간단히 0.28초 빠른 페이드+초반 살짝
      //   확대 후 안정(scale 식). hook.png를 시간에 따라 scale: 0~0.12s 1.12배 → 0.28s 1.0배.
      vParts.push(`[${hookIdx}:v]format=rgba,fade=in:st=0:d=0.22:alpha=1,scale=w='iw*if(lt(t,0.12),1.12,if(lt(t,0.28),1.12-0.12*(t-0.12)/0.16,1.0))':h=-1:eval=frame[hk]`);
      // 확대되면 좌상단 기준이 아니라 중앙 정렬이 되게 overlay x/y를 음수 보정.
      vParts.push(`${vlab}[hk]overlay=x='(W-w)/2':y='0':eval=frame[vo]`); vlab = '[vo]';
    }
    // b-roll 팝업 — 관련 이미지를 화면 중앙(후킹 아래·자막 위)에 카드로 잠깐 띄웠다 사라지게(페이드).
    //   원본 영상은 계속 틀면서 핵심 순간에만 '팝'. 흰 테두리 카드 + enable 구간 동안만 표시.
    if (brollIdx.length) {
      const cw = land ? 560 : 680;          // 카드 너비(px)
      const cy = land ? 140 : 520;          // 세로 위치(후킹 아래, 자막 위)
      brollIdx.forEach((bi, k) => {
        const b = broll[k];
        const outStart = Math.max(b.start + 0.1, b.end - 0.3);
        // 스케일 → 흰 테두리(pad) → rgba → 페이드 인/아웃(알파)
        vParts.push(`[${bi}:v]scale=${cw}:-1,pad=iw+16:ih+16:8:8:white,format=rgba,fade=in:st=${b.start.toFixed(2)}:d=0.3:alpha=1,fade=out:st=${outStart.toFixed(2)}:d=0.3:alpha=1[br${k}]`);
        vParts.push(`${vlab}[br${k}]overlay=(W-w)/2:${cy}:enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})'[vbr${k}]`); vlab = `[vbr${k}]`;
      });
    }
    if (assPath) { vParts.push(`${vlab}subtitles='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}'[vout]`); vlab = '[vout]'; }
    else { vParts.push(`${vlab}null[vout]`); vlab = '[vout]'; }

    // 오디오: 나레이션 있으면 (원본 더킹/뮤트)+나레이션 믹스. 없으면 원본(muteOriginal이면 무음).
    const aParts: string[] = [];
    let aMap: string | null = null;
    const origVol = opts.muteOriginal ? 0 : (narrIdx >= 0 ? 0.18 : 1);
    if (narrIdx >= 0) {
      aParts.push(`[0:a]volume=${origVol}[oa]`);
      aParts.push(`[${narrIdx}:a]volume=1.0[na]`);
      aParts.push(`[oa][na]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
      aMap = '[aout]';
    } else if (opts.muteOriginal) {
      aParts.push(`[0:a]volume=0[aout]`); aMap = '[aout]';
    } // else 원본 그대로(아래 -map 0:a?)

    const filter = [...vParts, ...aParts].join(';');
    const args = ['-y', ...inputs, '-filter_complex', filter, '-map', vlab];
    if (aMap) args.push('-map', aMap); else args.push('-map', '0:a?');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-t', String(Math.max(1, Math.ceil(durationSec))), '-movflags', '+faststart', outPath);

    log('[빠른렌더] 합성 중(후킹+자막+오디오)…');
    let lastPct = -1, lastAt = 0;
    await run(args, log, (line) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (!m) return;
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.round((t / Math.max(1, durationSec)) * 100));
      const now = Date.now();
      if (pct >= lastPct + 10 && now - lastAt > 2000) { lastPct = pct; lastAt = now; log(`[빠른렌더] ${pct}%`); }
    }, cancelled);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) return false;
    log('[빠른렌더] ✅ 완료(프레임별 재렌더 없이 합성)');
    return true;
  } catch (e: any) {
    if (/사용자가 중단/.test(e?.message || '')) throw e;
    log('[빠른렌더] 실패 → 기존 방식으로 렌더: ' + (e?.message || '').slice(0, 100));
    return false;
  } finally {
    await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
  }
}
