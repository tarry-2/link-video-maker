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
    if (/\/login/.test(page.url())) return false;
    // 로그인 폼(비번칸)이 보이면 = 안 됨.
    if (await page.$('input[autocomplete="current-password"], input[type="password"]')) return false;
    // ★로그인 안내 모달/버튼이 보이면 = 비로그인(검색 페이지에 "Instagram으로 계속하기" 오버레이가 뜨는 거짓양성 차단).
    const hasLoginPrompt = await page.evaluate(() => {
      const t = document.body.innerText || "";
      if (/로그인 또는 가입하기|Instagram으로 계속하기|사용자 이름으로 로그인|Log in or sign up/i.test(t)) return true;
      return false;
    });
    if (hasLoginPrompt) return false;
    // 로그인된 신호: 새 글 작성 버튼 등.
    const composer = await page.$('[aria-label="새로운 스레드 게시물"], svg[aria-label*="새 글"], a[href="/compose"], [aria-label*="프로필"]');
    return !!composer;
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

// 인스타 로그인 에러 추출 — "비번 틀림 / 아이디 없음"을 구분해 사용자에게 명확히 알려준다(테리 요구).
async function extractLoginError(page: Page): Promise<string> {
  try {
    const txt = await page.evaluate(() => {
      const el = document.querySelector('#slfErrorAlert, [role="alert"], ._ab2z');
      const direct = el && el.textContent ? el.textContent.trim() : "";
      if (direct) return direct;
      const m = (document.body.innerText || "").match(/(비밀번호[^\n]{0,60}|password[^\n]{0,60}|사용자 이름[^\n]{0,60}|username[^\n]{0,60}|잘못[^\n]{0,40}|incorrect[^\n]{0,40}|doesn.t belong[^\n]{0,40}|찾을 수 없[^\n]{0,40})/i);
      return m ? m[0] : "";
    });
    const t = (txt || "").trim();
    if (/incorrect|잘못된 비밀번호|비밀번호가 올바르지|password was incorrect/i.test(t)) return "비밀번호가 틀렸어요";
    if (/doesn.t belong|찾을 수 없|사용자 이름|username you entered/i.test(t)) return "아이디(사용자 이름)를 찾을 수 없어요";
    return t.slice(0, 90);
  } catch { return ""; }
}

// 로그인/계정 연결 — ★스레드 '직접 로그인'은 "예기치 못한 오류"가 남(테리 실측) → "Instagram으로 로그인"을 눌러
//   인스타 로그인 폼에서 아이디/비번 입력(퍼블리 insta-bot 검증 셀렉터). 각 단계·결과를 로그로 남겨 뭐가 문제인지(비번/아이디/2단계) 바로 보이게.
//   세션은 영구 프로필 + 쿠키로 유지 → 다음부턴 skip.
//   🔴 TODO(실측): "Instagram으로 로그인" 버튼 셀렉터·인스타 폼·2FA 화면 확정.
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

    if (!(opts.id && opts.pw)) {
      log("[연결] 저장된 비번이 없어요 — 창에서 직접 로그인해 주세요(최대 120초).");
    } else {
      // ★스레드 로그인 폼은 /login에 바로 있다(실측 2026-10-19): 아이디=autocomplete="username"(ph "사용자 이름, 전화번호 또는 이메일"),
      //   비번=autocomplete="current-password", 제출=input[type=submit]/"로그인" 버튼. 인스타 경유 안 함(그건 "Instagram으로 계속하기" 별도 옵션).
      let idField = page.locator('input[autocomplete="username"], input[placeholder*="사용자 이름"], input[name="username"]').first();
      // 폼이 바로 안 보이면 "사용자 이름으로 로그인" 버튼을 눌러 폼을 띄운다(모달 형태 대응).
      if (!(await idField.isVisible({ timeout: 4000 }).catch(() => false))) {
        const unBtn = page.locator('div[role="button"]:has-text("사용자 이름으로 로그인"), button:has-text("사용자 이름으로 로그인"), :has-text("사용자 이름으로 로그인")').first();
        if (await unBtn.isVisible({ timeout: 3000 }).catch(() => false)) { log("[연결] '사용자 이름으로 로그인' 클릭…"); await unBtn.click().catch(() => {}); await sleep(rd(1200, 2000)); }
        idField = page.locator('input[autocomplete="username"], input[placeholder*="사용자 이름"], input[name="username"]').first();
      }
      if (!(await idField.isVisible({ timeout: 10000 }).catch(() => false))) {
        log("[연결] ⚠️ 아이디 입력칸이 안 보여요 — 창에서 직접 로그인해 주세요(최대 120초). 로그인하면 자동 저장됩니다.");
      } else {
        log("[연결] 아이디 입력 중…");
        await idField.click().catch(() => {});
        for (const ch of opts.id) await page.keyboard.type(ch, { delay: rd(70, 160) });
        await sleep(rd(300, 600));
        log("[연결] 비밀번호 입력 중…");
        const pwField = page.locator('input[autocomplete="current-password"], input[type="password"]').first();
        await pwField.click().catch(() => {});
        for (const ch of opts.pw) await page.keyboard.type(ch, { delay: rd(70, 160) });
        await sleep(rd(300, 600));
        log("[연결] 로그인 제출…");
        // "로그인" 버튼 클릭(없으면 Enter).
        const loginBtn = page.locator('div[role="button"]:has-text("로그인"), button:has-text("로그인"), input[type="submit"]').first();
        if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) await loginBtn.click().catch(() => {});
        else await page.keyboard.press("Enter").catch(() => {});
        await sleep(3500);
        // 에러 메시지 즉시 확인 — 비번 틀림/아이디 없음 구분(테리 요구).
        const err = await extractLoginError(page);
        if (err) { log(`[연결] ❌ 로그인 실패: ${err}`); return { ok: false, reason: err }; }
        log("[연결] 아이디·비번 통과 — 2단계 인증·보안 확인이 뜨면 창에서 통과해 주세요…");
      }
    }
    // 완료 또는 2FA 수동 처리 대기(비번칸 사라지고 로그인 벗어나면 완료).
    try { await page.waitForFunction(() => !/\/(login|accounts\/login)/.test(location.pathname) && !document.querySelector('input[type="password"]'), undefined, { timeout: 120000 }); }
    catch {
      const err2 = await extractLoginError(page);
      return { ok: false, reason: err2 || "로그인 미완료(2단계 인증/보안 확인 필요 또는 아이디·비번 오류 — 창을 확인하세요)" };
    }
    await sleep(1500); await dismissDialogs(page);
    if (!(await isLoggedIn(page))) return { ok: false, reason: "로그인 확인 실패(세션이 생기지 않음)" };
    await persist(context, account);
    log("[연결] ✅ 로그인 성공 — 세션 저장 완료. 이제 재로그인 없이 계속 쓸 수 있어요.");
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

// 글에 공감 활동 — 좋아요·팔로우·댓글을 '토글대로' 한 페이지에서 수행(테리: 체크한 것만).
//   ★실측(2026-10-19): 좋아요=svg[aria-label="좋아요"], 팔로우=버튼 텍스트 "팔로우"(정확, "팔로잉" 구분),
//   댓글="답글" 영역 열고 입력 후 게시 버튼 텍스트 정확히 "게시"("게시물 인용/옵션" 구분).
export async function threadsEngage(opts: {
  account: string; postUrl: string; visible?: boolean; proxy?: ProxyOpt; log?: Log;
  doLike?: boolean; doFollow?: boolean; comment?: string | null; // comment null/빈값=댓글 안 함
}): Promise<CommentResult & { liked?: boolean; followed?: boolean; commented?: boolean }> {
  const log = opts.log || (() => {});
  const steps: string[] = [];
  const context = await launchProfile(opts.account, opts.visible !== false, opts.proxy);
  let liked = false, followed = false, commented = false;
  try {
    const page = await context.newPage();
    if (opts.visible !== false) await page.bringToFront().catch(() => {});
    await page.goto(opts.postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    steps.push("글 페이지 열기✅"); await sleep(rd(1500, 2500));
    if (!(await isLoggedIn(page))) { return { ok: false, reason: "세션 만료 — 재로그인 필요", steps, shot: await shot(page) }; }

    // ★순서 중요(실측): 댓글을 '먼저' — 좋아요를 먼저 누르면 입력창이 사라지는 현상 확인됨(팝업/포커스 전환).
    // 1) 댓글 — 글 상세엔 답글 입력창(contenteditable, aria-placeholder*="답글")이 바로 있다. 그걸 직접 찾아 입력 후 "게시".
    if (opts.comment && opts.comment.trim()) {
      let editor = page.locator('[contenteditable="true"][aria-placeholder*="답글"], [contenteditable="true"][aria-placeholder*="답글 남기기"]').first();
      if (!(await editor.isVisible({ timeout: 4000 }).catch(() => false))) editor = page.locator('[contenteditable="true"]').last();
      if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) {
        return { ok: false, reason: "댓글 입력창을 못 찾음", steps, shot: await shot(page), liked, followed };
      }
      await editor.click().catch(() => {});
      for (const ch of opts.comment) await page.keyboard.type(ch, { delay: rd(30, 90) });
      steps.push("댓글 입력✅"); await sleep(rd(600, 1100));
      // ★실측(2026-10-19): 전송은 ①Cmd+Enter(스레드 데스크톱 단축키) 먼저 → ②실패 시 전송 버튼 클릭.
      //   전송 버튼 = div[role=button]에 svg[aria-label="답글"] 든 것(텍스트 매칭 불가, "답글2" 카운트와 구분).
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter").catch(() => {});
      await sleep(rd(1500, 2500));
      // 입력창이 비었으면(aria-placeholder 상태 복귀) 전송 성공으로 간주.
      let sent = await page.evaluate(() => {
        const ce = document.querySelector('[contenteditable="true"][aria-placeholder*="답글"]') as HTMLElement | null;
        return !ce || (ce.textContent || "").trim().length === 0;
      }).catch(() => false);
      if (!sent) {
        const postBtn = page.locator('div[role="button"]:has(svg[aria-label="답글"])').last();
        if (await postBtn.isVisible({ timeout: 3000 }).catch(() => false)) { await postBtn.click().catch(() => {}); await sleep(rd(1800, 2800)); sent = true; }
      }
      if (!sent) { return { ok: false, reason: "댓글 전송 버튼을 못 찾음", steps, shot: await shot(page), liked, followed }; }
      commented = true; steps.push("댓글 전송✅");
      log("[스레드] 💬 댓글 게시");
    }

    // 2) 좋아요(공감) — ★실측: svg[aria-label="좋아요"]는 <a role="link"> 안에 있다. svg 직접 클릭은 토글 안 됨
    //   → 조상 a(링크)를 클릭해야 실제로 눌린다. 이미 눌렀으면 aria-label이 "좋아요 취소"라 안 잡힘 → 자연 스킵.
    if (opts.doLike) {
      const likeLink = page.locator('a[role="link"]:has(svg[aria-label="좋아요"]), div[role="button"]:has(svg[aria-label="좋아요"])').first();
      const likeSvg = page.locator('svg[aria-label="좋아요"]').first();
      if (await likeLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await likeLink.click().catch(() => {}); liked = true; steps.push("좋아요✅"); await sleep(rd(600, 1100));
        log("[스레드] 👍 좋아요");
      } else if (await likeSvg.isVisible({ timeout: 1500 }).catch(() => false)) {
        await likeSvg.click({ force: true }).catch(() => {}); liked = true; steps.push("좋아요✅"); await sleep(rd(600, 1100));
        log("[스레드] 👍 좋아요");
      } else { log("[스레드] (이미 좋아요했거나 버튼 없음)"); }
    }

    // 3) 팔로우 — "팔로우" 정확 매칭(이미 "팔로잉"이면 스킵). 글 작성자 팔로우.
    if (opts.doFollow) {
      const fb = page.locator('div[role="button"]:text-is("팔로우"), button:text-is("팔로우")').first();
      if (await fb.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fb.click().catch(() => {}); followed = true; steps.push("팔로우✅"); await sleep(rd(600, 1100));
        log("[스레드] ➕ 팔로우");
      } else { log("[스레드] (이미 팔로잉이거나 버튼 없음)"); }
    }

    const s = await shot(page);
    return { ok: true, url: opts.postUrl, steps, shot: s, liked, followed, commented };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e), steps, liked, followed };
  } finally { await context.close().catch(() => {}); }
}

// 페이지 스크린샷 → base64 data URL(로그 안 캡처 이미지용).
async function shot(page: Page): Promise<string | undefined> {
  try { const b = await page.screenshot({ type: "jpeg", quality: 60 }); return `data:image/jpeg;base64,${b.toString("base64")}`; }
  catch { return undefined; }
}
