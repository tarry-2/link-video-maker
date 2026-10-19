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

// 로그인 — 1차는 '사용자 직접 로그인'(창을 띄워 테리가 로그인 완료 → 쿠키 저장). 세션은 영구 프로필로 유지돼 다음부턴 skip.
//   (봇이 비번 자동입력하는 것보다, 메인 계정은 1회 수동 로그인이 안전하고 2단계/인스타 OAuth도 자연스럽게 통과.)
export async function threadsLogin(account: string, opts: { visible?: boolean; proxy?: ProxyOpt; log?: Log } = {}): Promise<{ ok: boolean; reason?: string; already?: boolean }> {
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
    // 로그인 페이지로 — 사용자가 창에서 직접 로그인(2단계/OAuth 포함)할 때까지 넉넉히 대기.
    log("[스레드] 로그인 창을 띄웠어요. 창에서 로그인해 주세요(한 번만 하면 이후엔 유지돼요).");
    await page.goto(`${HOST}/login`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    try {
      await page.waitForFunction(() => {
        return !/\/login/.test(location.pathname) && !document.querySelector('a[href*="/login"]');
      }, undefined, { timeout: 180000 });
    } catch { return { ok: false, reason: "로그인 시간 초과(창에서 로그인 미완료)" }; }
    await sleep(1500);
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
