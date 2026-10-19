// 봇 브라우저 인프라 — control-tower-bot/naver-kin.ts의 검증된 탐지 회피·영구 프로필·사람 타이핑·프록시를
//   범용(스레드/인스타 공용)으로 추출. ★headed(실제 창)만 쓴다 — headless는 리스크 엔진이 봇으로 잡음.
import { chromium, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// ── 봇 탐지 우회(모카/관제탑 검증본 그대로) ──
const ANTI_DETECTION_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) { window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }; }
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5].map(() => ({ name: 'Chrome PDF Plugin' })) });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR','ko','en-US','en'] });
  const origQuery = window.navigator.permissions?.query;
  if (origQuery) { window.navigator.permissions.query = (params) => params.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(params); }
`;

// 봇 창은 작게(전체창 금지). 창보기 OFF면 화면 밖으로 밀어 안 거슬리게(그래도 실제 창=사람처럼).
const WINDOW_W = 980, WINDOW_H = 760;
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-first-run",
  "--no-default-browser-check",
  `--window-size=${WINDOW_W},${WINDOW_H}`,
  "--window-position=40,40",
];
// UA는 실제 playwright 크로미움 major와 맞춘다(불일치=봇신호). playwright 업그레이드 시 올릴 것.
const CHROME_MAJOR = 148;
const UA = `Mozilla/5.0 (${process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

export const rd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 프록시(토글) ──
//   기본 OFF = 네 집 IP(메인 1계정엔 이게 제일 깨끗). ON = 그 계정에 sticky 고정 IP 배정(계정별 분리, 다계정 확장용).
//   크레덴셜은 env로 넣고(없으면 관제탑 검증값 폴백). seed(계정)별로 같은 IP가 24h 고정된다.
const PROXY_HOST = process.env.OVBOT_PROXY_HOST || "gw.dataimpulse.com";
const PROXY_PORT = process.env.OVBOT_PROXY_PORT || "10000";
const PROXY_USER = process.env.OVBOT_PROXY_USER || "";   // ★비어있으면 프록시 사용 안 함(안전 기본값)
const PROXY_PASS = process.env.OVBOT_PROXY_PASS || "";

export type ProxyOpt = { on: boolean; seed?: string };
function stickyId(seed?: string): string {
  const s = seed || "default";
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `ov${h.toString(36)}`;
}
function proxyConfig(proxy?: ProxyOpt) {
  if (!proxy?.on || !PROXY_USER) return {}; // OFF거나 크레덴셜 없음 → 집 IP
  return {
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username: `${PROXY_USER};sessid.${stickyId(proxy.seed)};sessttl.1440`, // 계정별 고정 IP 24h
      password: PROXY_PASS,
    },
  };
}

// ★계정별 영구 브라우저 프로필(userDataDir) — 세션 유지의 핵심.
//   매번 새 브라우저(=새 기기)로 접속하면 "세션 탈취"로 보여 재로그인 유도 → 프로필 고정으로 "같은 기기" 인식.
const PROFILE_BASE = path.join(os.homedir(), ".onvideo-bot", "profiles");
function profileDir(account: string): string {
  const d = path.join(PROFILE_BASE, (account || "default").replace(/[^a-zA-Z0-9]/g, "_"));
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

// 로그인·댓글용 영구 컨텍스트(세션 유지). visible=창을 앞으로 가져올지. headless는 절대 안 씀.
export async function launchProfile(account: string, visible: boolean, proxy?: ProxyOpt): Promise<BrowserContext> {
  const args = [...LAUNCH_ARGS];
  if (!visible) args.push("--window-position=-2400,-2400"); // 창보기 OFF: 화면 밖(그래도 실제 창)
  const context = await chromium.launchPersistentContext(profileDir(account), {
    headless: false, args, slowMo: 40,
    userAgent: UA, viewport: { width: 1280, height: 800 }, locale: "ko-KR", timezoneId: "Asia/Seoul",
    ...proxyConfig(proxy),
  });
  await context.addInitScript(ANTI_DETECTION_SCRIPT);
  return context;
}

// 값 직접주입 금지 — 사람같은 키보드 타이핑(글자별 랜덤 딜레이).
export async function humanType(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector).catch(async () => {
    await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLInputElement | null; el?.focus(); }, selector);
  });
  await page.press(selector, process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.press(selector, "Backspace").catch(() => {});
  for (const ch of value) await page.type(selector, ch, { delay: rd(80, 180) });
  await sleep(rd(200, 500));
}

// 현재 컨텍스트의 외부 IP(진단용 — 프록시 토글 ON/OFF 실제 적용 확인).
export async function currentIp(page: Page): Promise<string> {
  try {
    return await page.evaluate(async () => {
      try { const r = await fetch("https://api.ipify.org?format=json"); return (await r.json()).ip as string; } catch { return "?"; }
    }) || "?";
  } catch { return "?"; }
}
