// 스마트 리프레임(화자/인물 추적) — 가로 영상을 세로 9:16로 바꿀 때 블러레터박스 대신
//   "인물을 따라다니며 화면을 꽉 채운다"(OpusClip·Vizard식). 세계 1위권 툴들의 품질 결정타.
// 흐름: ①opencv(python)로 섹션 클립의 얼굴 중심 x를 ~3fps로 감지 → ②TS에서 스무딩(튐 제거)
//       → ③ffmpeg sendcmd로 크롭 x를 시간따라 움직이며 9:16 크롭·스케일.
// ★실패(감지 부족·python 없음·opencv 없음 등) 시 false 반환 → 호출부가 기존 블러레터박스로 폴백(무회귀).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const PYTHON = process.env.PYTHON_PATH || 'python3';

function run(cmd: string, args: string[], timeoutMs: number, onLine?: (l: string) => void, cancelled?: () => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '', killed = false;
    const t = setTimeout(() => { ps.kill('SIGKILL'); reject(new Error(`${cmd} 시간 초과`)); }, timeoutMs);
    const ca = cancelled ? setInterval(() => { if (cancelled()) { killed = true; try { ps.kill('SIGKILL'); } catch {} } }, 400) : null;
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; if (onLine) String(d).split(/[\r\n]+/).forEach((l) => l && onLine(l)); });
    ps.on('error', (e) => { clearTimeout(t); if (ca) clearInterval(ca); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(t); if (ca) clearInterval(ca);
      if (killed) return reject(new Error('사용자가 중단했습니다.'));
      code === 0 ? resolve(out) : reject(new Error((err || out).slice(-300)));
    });
  });
}

async function dimsOf(file: string): Promise<{w: number; h: number} | null> {
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], 20000);
    const m = out.trim().split('x');
    const w = parseInt(m[0], 10), h = parseInt(m[1], 10);
    if (w > 0 && h > 0) return {w, h};
  } catch {}
  return null;
}

// opencv 얼굴 감지 스크립트(런타임에 tmp로 씀 — Docker COPY 불필요). YuNet 우선, 없으면 Haar(번들) 폴백.
const PY_DETECT = `
import sys, json, os
try:
    import cv2
except Exception as e:
    print(json.dumps({"err":"no-cv2:"+str(e)})); sys.exit(0)
inp, outp = sys.argv[1], sys.argv[2]
cap = cv2.VideoCapture(inp)
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
step = max(1, int(round(fps*0.33)))  # 약 3회/초 샘플
det = None
ym = os.environ.get("YUNET_MODEL","")
if ym and os.path.exists(ym):
    try: det = cv2.FaceDetectorYN_create(ym, "", (320,320), 0.6, 0.3, 5000)
    except Exception: det = None
haar = None
if det is None:
    try: haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    except Exception: haar = None
keys=[]; nseen=0; nface=0; i=0
while True:
    if not cap.grab(): break
    if i % step == 0:
        ok, frame = cap.retrieve()
        if not ok: break
        nseen += 1; cx=None; best=0
        try:
            if det is not None:
                det.setInputSize((frame.shape[1], frame.shape[0]))
                _, faces = det.detect(frame)
                if faces is not None:
                    for f in faces:
                        w=float(f[2]); h=float(f[3])
                        if w*h>best: best=w*h; cx=float(f[0])+w/2
            elif haar is not None:
                g=cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                for (x,y,w,h) in haar.detectMultiScale(g,1.2,5,minSize=(60,60)):
                    if w*h>best: best=w*h; cx=float(x)+w/2.0
        except Exception: pass
        if cx is not None: nface+=1; keys.append([round(i/fps,2), round(cx,1)])
    i += 1
cap.release()
json.dump({"w":W,"h":H,"fps":fps,"coverage":(nface/nseen if nseen else 0),"keys":keys}, open(outp,"w"))
`;

type DetectResult = {w: number; h: number; fps: number; coverage: number; keys: [number, number][]; err?: string};

// 감지된 얼굴 중심 x들을 스무딩 → 시간별 크롭 x(픽셀) 경로. 튐·급가속 제거.
function smoothPath(keys: [number, number][], W: number, cropW: number, durSec: number): {t: number; x: number}[] {
  const center = (W - cropW) / 2;
  if (!keys.length) return [{t: 0, x: center}];
  // 1) 결측 구간은 직전 값 유지(carry). 등간격(0.4s) 샘플 그리드로 재배치.
  const dt = 0.4;
  const n = Math.max(1, Math.ceil(durSec / dt));
  const grid: {t: number; x: number}[] = [];
  let ki = 0, lastCx = keys[0][1];
  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    while (ki < keys.length && keys[ki][0] <= t) { lastCx = keys[ki][1]; ki++; }
    grid.push({t, x: lastCx}); // 여기선 아직 얼굴중심(cx). 아래서 crop x로 변환.
  }
  // 2) 이동평균(window 5)로 부드럽게.
  const win = 5, half = (win - 1) / 2;
  const sm = grid.map((g, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(grid.length - 1, i + half); j++) { s += grid[j].x; c++; }
    return {t: g.t, x: s / c};
  });
  // 3) cx → crop x(좌상단), 화면 경계로 클램프. 그리고 최대 속도 제한(px/프레임 환산).
  const maxVel = Math.max(6, cropW * 0.018); // 프레임당 과도한 점프 방지(dt=0.4s 기준)
  const pathX: {t: number; x: number}[] = [];
  let prev = Math.min(Math.max(sm[0].x - cropW / 2, 0), W - cropW);
  for (const g of sm) {
    let x = Math.min(Math.max(g.x - cropW / 2, 0), W - cropW);
    const d = x - prev;
    if (Math.abs(d) > maxVel) x = prev + Math.sign(d) * maxVel;
    prev = x;
    pathX.push({t: g.t, x: Math.round(x)});
  }
  return pathX;
}

// 섹션 클립(inPath, 가로)을 인물 추적으로 9:16(1080×1920) 세로 변환. 성공 true / 실패 false(→블러 폴백).
export async function reframeClip(
  inPath: string, outPath: string, log: (m: string) => void, cancelled?: () => boolean,
): Promise<boolean> {
  try {
    const dims = await dimsOf(inPath);
    if (!dims) return false;
    const {w: W, h: H} = dims;
    if (W <= H) return false; // 이미 세로/정사각 → 리프레임 불필요(레터박스 로직이 처리)

    // 1) 얼굴 감지(python+opencv). 실패/부족하면 false.
    const work = path.join(os.tmpdir(), `reframe-${randomUUID().slice(0, 8)}`);
    await fsp.mkdir(work, {recursive: true});
    const pyFile = path.join(work, 'detect.py');
    const jsonFile = path.join(work, 'faces.json');
    await fsp.writeFile(pyFile, PY_DETECT);
    let det: DetectResult | null = null;
    try {
      await run(PYTHON, [pyFile, inPath, jsonFile], 180000, undefined, cancelled);
      det = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
    } catch (e: any) {
      if (/사용자가 중단/.test(e?.message || '')) { await fsp.rm(work, {recursive: true, force: true}); throw e; }
      log('[리프레임] 얼굴 감지 불가(블러로 진행): ' + (e?.message || '').slice(0, 80));
    }
    await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
    if (!det || det.err || !det.keys || det.coverage < 0.3) {
      log(`[리프레임] 인물이 충분히 안 잡힘(coverage ${det ? Math.round((det.coverage || 0) * 100) : 0}%) → 블러레터박스로`);
      return false;
    }

    // 2) 크롭 창 산정: 약간(6%) 세로 줌으로 상/하단 워터마크·채널로고를 밀어낸다. 9:16.
    const cropH = Math.round(H * 0.94 / 2) * 2;
    let cropW = Math.round((cropH * 9 / 16) / 2) * 2;
    if (cropW >= W) cropW = Math.floor(W / 2) * 2; // 원본이 narrow면 가능한 만큼
    const yOff = Math.round((H - cropH) / 2);
    const durSec = det.keys.length ? det.keys[det.keys.length - 1][0] + 0.4 : 0;
    const pathX = smoothPath(det.keys, W, cropW, Math.max(1, durSec));

    // 3) sendcmd 파일(크롭 x를 시간따라). crop 필터가 x 커맨드를 받는다(실측 확인).
    const cmdFile = path.join(os.tmpdir(), `reframe-cmd-${randomUUID().slice(0, 8)}.txt`);
    const cmdText = pathX.map((p) => `${p.t.toFixed(2)} crop x ${p.x};`).join('\n');
    await fsp.writeFile(cmdFile, cmdText);

    // 4) ffmpeg: sendcmd→crop(x 동적)→scale 1080×1920. -vf라 오디오 자동 유지.
    const vf = `sendcmd=f=${cmdFile.replace(/\\/g, '/')},crop=w=${cropW}:h=${cropH}:x=${pathX[0].x}:y=${yOff},scale=1080:1920`;
    let lastPct = -1, lastAt = 0;
    const onLine = (line: string) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (!m) return;
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.max(0, Math.round((t / Math.max(1, durSec)) * 100)));
      const now = Date.now();
      if (pct >= lastPct + 10 && now - lastAt > 2500) { lastPct = pct; lastAt = now; log(`[리프레임] 인물 추적 변환 ${pct}%`); }
    };
    try {
      await run(FFMPEG, ['-y', '-i', inPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath], 420000, onLine, cancelled);
    } finally { await fsp.rm(cmdFile, {force: true}).catch(() => {}); }
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) return false;
    log(`[리프레임] ✅ 인물 꽉채움 완료(coverage ${Math.round(det.coverage * 100)}%)`);
    return true;
  } catch (e: any) {
    if (/사용자가 중단/.test(e?.message || '')) throw e;
    log('[리프레임] 실패(블러레터박스로 폴백): ' + (e?.message || '').slice(0, 80));
    return false;
  }
}
