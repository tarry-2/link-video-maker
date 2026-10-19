// 스레드(Threads) 봇 — 키워드로 공개 글을 찾아 AI 공감댓글을 단다.
//   naver-kin.ts(로그인/검색/답변) 구조를 스레드로 포팅. ★headed 실제 창 + 영구 프로필(세션 유지).
//
// 🔴🔴 DOM 셀렉터는 "실측 교정 필요"(TODO 표시). naver-kin도 실계정으로 교정했듯,
//   테리 맥에서 스레드 로그인 창을 실제로 띄워 로그인칸·검색결과·reply 버튼 셀렉터를 눈으로 보며 맞춘다.
//   아래는 2026 현재 threads.com 웹 구조 기준 1차 추정 — 실측 전엔 '추정'임을 전제로 둔다.
import { BrowserContext, Page } from "playwright";
import { launchProfile, humanType, currentIp, rd, sleep, ProxyOpt } from "./browser";
import { writeSession, hasSession } from "./session-store";

const HOST = "https://www.threads.com";
type Log = (m: string) => void;

export type ThreadsPost = { author: string; text: string; url: string };
export type CommentResult = { ok: boolean; reason?: string; url?: string; steps: string[]; shot?: string };

function sessionName(account: string) { return `threads__${account}`; }
export function threadsSessionExists(account: string): boolean { return hasSession(sessionName(account)); }

// 현재 페이지가 로그인된 상태인지 — 작성(새 스레드) 버튼/프로필 메뉴가 보이면 로그인.
//   🔴 TODO(실측): 로그인/비로그인 구분 셀렉터 확정. 지금은 '로그인' 링크 유무로 추정.
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const loginLink = await page.$('a[href*="/login"], a[href*="instagram.com/accounts/login"]');
    const composer = await page.$('[aria-label*="글"], [aria-label*="Post"], svg[aria-label*="New"]');
    return !loginLink || !!composer;
  } catch { return false; }
}

// 팝업/다이얼로그 자동 닫기(퍼블리 dismissDialogs 패턴) — "정보 저장"·"알림 켜기" 등이 폼을 가리는 것 방지.
async function dismissDialogs(page: Page) {
  const labels = ["나중에 하기", "Not Now", "저장 안 함", "Save Info", "허용 안 함", "닫기", "취소", "Cancel"];
  for (const t of labels) {
    try {
      const btn = page.locator(`button:has-text("${t}"), div[role="button"]:has-text("${t}")`).first();
      if (await btn.isVisible({ timeout: 700 }).catch(() => false)) { await btn.click({ timeout: 1000 }).catch(() => {}); await page.waitForTimeout(400); }
    } catch {}
  }
}
// 여러 셀렉터 폴백 + 사람 타이핑으로 입력(값 직접주입 금지).
async function typeInto(page: Page, selectors: string, value: string): Promise<boolean> {
  const el = page.locator(selectors).first();
  if (!(await el.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  await el.click().catch(() => {});
  for (const ch of value) await page.keyboard.type(ch, { delay: rd(70, 160) });
  await sleep(rd(300, 700));
  return true;
}

// 로그인 — 저장된 아이디/비번으로 봇이 '자동' 로그인(page 자동 입력, 퍼블리 saveInstaSession 패턴).
//   2FA/캡차가 뜨면 창에서 사용자가 통과(최대 120초). 비번이 없으면 창에서 직접 로그인으로 폴백.
//   세션은 영구 프로필 + 쿠키 파일로 유지 → 다음부턴 skip(재로그인 안 함).
//   🔴 TODO(실측): threads.com 로그인 폼 셀렉터(username/password/submit)·2FA 화면 확정.
export async function threadsLogin(account: string, opts: { id?: string; pw?: string; visible?: boolean; proxy?: ProxyOpt; log?: Log } = {}): Promise<{ ok: boolean; reason?: string; already?: boolean }> {
  const log = opts.log || (() => {});
  const context = await launchProfile(account, opts.visible !== false, opts.proxy);
  try {
    const page = await context.newPage();
    if (opts.visible !== false) await page.bringToFront().catch(() => {});
    await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(rd(800, 1400));
    log(`[스레드] 외부 IP: ${await currentIp(page)}`);
    if (await isLoggedIn(page)) {
      await persist(context, account);
      log("[스레드] 이미 로그인됨 — 세션 유지(재로그인 안 함).");
      return { ok: true, already: true };
    }
    await page.goto(`${HOST}/login`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(rd(1000, 1800));
    await dismissDialogs(page);

    if (opts.id && opts.pw) {
      // 자동 로그인(퍼블리 패턴) — 스레드는 인스타 계정으로 로그인하므로 인스타 로그인 폼 셀렉터를 우선 시도.
      log("[스레드] 저장된 계정으로 자동 로그인 시도…");
      const okId = await typeInto(page, 'input[name="username"], input[autocomplete="username"], input[name="email"]', opts.id);
      const okPw = await typeInto(page, 'input[name="password"], input[type="password"]', opts.pw);
      if (okId && okPw) { await page.keyboard.press("Enter").catch(() => {}); log("[스레드] 로그인 제출 — 2단계 인증/캡차가 뜨면 창에서 통과해 주세요(최대 120초)."); }
      else log("[스레드] ⚠️ 로그인칸을 못 찾았어요(DOM 실측 필요) — 창에서 직접 로그인해 주세요.");
    } else {
      log("[스레드] 저장된 비번이 없어요 — 창에서 직접 로그인해 주세요(최대 120초).");
    }
    // 로그인 완료 또는 2FA/캡차 수동 처리 대기(비번칸이 사라지고 /login 벗어나면 완료).
    try { await page.waitForFunction(() => !/\/login/.test(location.pathname) && !document.querySelector('input[type="password"]'), undefined, { timeout: 120000 }); }
    catch { return { ok: false, reason: "로그인 미완료(2단계 인증/캡차 필요 또는 아이디·비번 오류)" }; }
    await sleep(1500); await dismissDialogs(page);
    if (!(await isLoggedIn(page))) return { ok: false, reason: "로그인 확인 실패(세션 쿠키 없음)" };
    await persist(context, account);
    log("[스레드] 로그인 성공 — 세션 저장 완료.");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  } finally { await context.close().catch(() => {}); }
}

async function persist(context: BrowserContext, account: string) {
  try { const cookies = await context.cookies(); writeSession(sessionName(account), { cookies, at: Date.now() }); } catch {}
}

// 키워드로 공개 글 검색 → 글 목록(작성자·본문·URL). 읽기 전용이라 로그인 없이도 되지만 영구 프로필로 자연스럽게.
//   🔴 TODO(실측): threads.com/search 결과 DOM(글 카드·작성자·permalink) 셀렉터 확정.
export async function threadsSearch(account: string, keyword: string, opts: { limit?: number; proxy?: ProxyOpt; visible?: boolean; log?: Log } = {}): Promise<{ ok: boolean; items: ThreadsPost[]; reason?: string }> {
  const log = opts.log || (() => {});
  const limit = opts.limit || 20;
  const context = await launchProfile(account, !!opts.visible, opts.proxy);
  try {
    const page = await context.newPage();
    const url = `${HOST}/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
    log(`[스레드] "${keyword}" 검색 중…`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(rd(1500, 2500));
    // 스크롤로 더 로드(무한 스크롤) — best effort.
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1400); await sleep(rd(700, 1200)); }
    const items = await page.evaluate((max: number) => {
      const out: { author: string; text: string; url: string }[] = [];
      const seen = new Set<string>();
      // 🔴 TODO(실측): 글 카드 루트 셀렉터. 지금은 permalink(/@user/post/) 링크를 기준으로 수집(추정).
      const links = Array.from(document.querySelectorAll('a[href*="/post/"]')) as HTMLAnchorElement[];
      for (const a of links) {
        const href = a.href;
        if (!/\/post\//.test(href) || seen.has(href)) continue;
        const card = a.closest('[data-pressable-container], article, div[role="article"]') || a.parentElement;
        const text = (card?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
        const am = href.match(/\/@([^/]+)\//); const author = am ? am[1] : "";
        if (!text) continue;
        seen.add(href);
        out.push({ author, text, url: href });
        if (out.length >= max) break;
      }
      return out;
    }, limit as number);
    log(`[스레드] ${items.length}개 글 확보.`);
    return { ok: true, items };
  } catch (e: any) {
    return { ok: false, items: [], reason: e?.message || String(e) };
  } finally { await context.close().catch(() => {}); }
}

// 글에 공감 댓글(답글) 등록. 단계별 steps 기록(테리 "1~100 다 보여야") + 등록 직후 스샷.
//   🔴 TODO(실측): reply 버튼·댓글 입력창·게시 버튼 셀렉터 확정.
export async function threadsComment(opts: { account: string; postUrl: string; text: string; visible?: boolean; proxy?: ProxyOpt; log?: Log }): Promise<CommentResult> {
  const log = opts.log || (() => {});
  const steps: string[] = [];
  const context = await launchProfile(opts.account, opts.visible !== false, opts.proxy);
  try {
    const page = await context.newPage();
    if (opts.visible !== false) await page.bringToFront().catch(() => {});
    await page.goto(opts.postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    steps.push("글 페이지 열기✅"); await sleep(rd(1200, 2200));
    if (!(await isLoggedIn(page))) { return { ok: false, reason: "세션 만료 — 재로그인 필요", steps, shot: await shot(page) }; }
    // 1) reply 버튼
    const replyBtn = await page.$('svg[aria-label*="답글"], svg[aria-label*="Reply"], [aria-label*="Reply"]');
    if (!replyBtn) { return { ok: false, reason: "답글 버튼을 못 찾음(DOM 실측 필요)", steps, shot: await shot(page) }; }
    await replyBtn.click().catch(() => {}); steps.push("답글 열기✅"); await sleep(rd(600, 1100));
    // 2) 댓글 입력(사람 타이핑)
    const editor = await page.$('[contenteditable="true"], textarea');
    if (!editor) { return { ok: false, reason: "댓글 입력창을 못 찾음(DOM 실측 필요)", steps, shot: await shot(page) }; }
    await editor.click().catch(() => {});
    for (const ch of opts.text) await page.keyboard.type(ch, { delay: rd(30, 90) });
    steps.push("댓글 입력✅"); await sleep(rd(500, 900));
    // 3) 게시
    const postBtn = await page.$('[aria-label*="게시"], div[role="button"]:has-text("게시"), div[role="button"]:has-text("Post")');
    if (!postBtn) { return { ok: false, reason: "게시 버튼을 못 찾음(DOM 실측 필요)", steps, shot: await shot(page) }; }
    await postBtn.click().catch(() => {}); steps.push("게시 클릭✅"); await sleep(rd(1500, 2500));
    const s = await shot(page);
    log(`[스레드] ✅ 댓글 등록: ${opts.postUrl}`);
    return { ok: true, url: opts.postUrl, steps, shot: s };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e), steps };
  } finally { await context.close().catch(() => {}); }
}

// 페이지 스크린샷 → base64 data URL(로그 안 캡처 이미지용).
async function shot(page: Page): Promise<string | undefined> {
  try { const b = await page.screenshot({ type: "jpeg", quality: 60 }); return `data:image/jpeg;base64,${b.toString("base64")}`; }
  catch { return undefined; }
}
