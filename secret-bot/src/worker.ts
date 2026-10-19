// 폴링 워커 — 온비디오(클라우드) 작업큐를 폴링해 스레드 공감댓글을 실행한다.
//   poll(할 일) → 로그인 확인 → 키워드 검색 → 글마다 AI 공감댓글 생성 요청 → 댓글 등록 → report(로그·스샷·카운트).
//   사람처럼: 글 사이 랜덤 텀, 하루 한도, 정지/일시정지 즉시 반영. (control-tower poll-worker 패턴)
import { threadsLogin, threadsSearch, threadsEngage, threadsSessionExists } from "./threads";
import { sleep, ProxyOpt } from "./browser";

const BASE = (process.env.OVBOT_BASE || "https://video.xn--zk5biyyw.com").replace(/\/$/, "");
const TOKEN = process.env.OVBOT_TOKEN || "onvideo-secret-bot";

type Job = {
  status: "idle" | "running" | "paused" | "stopped";
  keyword: string; account: string; dailyLimit: number; termSec: number;
  proxyOn: boolean; visible: boolean; count: number;
  doLike?: boolean; doComment?: boolean; doFollow?: boolean;
  commentMode?: "ai" | "fixed"; fixedComments?: string[];
  accounts?: { label: string; username: string; loggedIn: boolean }[];
  pendingLogin?: { label: string; id: string; pw: string } | null;
  commentedUrls?: string[]; // 이미 댓글 단 글(영구, 서버에서 받음) — 중복 방지
};

function api(path: string, init?: any): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${BASE}${path}${sep}token=${encodeURIComponent(TOKEN)}`, init);
}
async function poll(): Promise<Job | null> {
  try { return await (await api("/api/secret/poll")).json(); } catch { return null; }
}
async function report(body: { logs?: { m: string; shot?: string }[]; count?: number; status?: string; loginDone?: { label: string; ok: boolean; username: string; reason?: string }; activity?: { author: string; url: string; comment?: string; liked?: boolean; followed?: boolean; commented?: boolean } }): Promise<void> {
  try { await api("/api/secret/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); } catch {}
}
const log = (m: string, shot?: string) => report({ logs: [{ m, shot }] });
async function genComment(postText: string): Promise<string> {
  try {
    const r = await api("/api/secret/gen-comment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postText }) });
    return (await r.json()).comment || "";
  } catch { return ""; }
}

const done = new Set<string>(); // 이번 가동에서 이미 댓글 단 글(중복 방지)
let kwIdx = 0; // 여러 키워드 라운드로빈 인덱스
let fixedIdx = 0; // 정해진 문구 로테이션 인덱스
let noNewStreak = 0; // 연속으로 '새 글 없음'인 횟수(모든 키워드 소진 시 자동 멈춤)

// 세션 확인만 — 자동 로그인은 '계정 추가(pendingLogin)' 경로가 담당한다(퍼블리식).
async function ensureLogin(account: string): Promise<boolean> {
  if (threadsSessionExists(account)) return true;
  await report({ logs: [{ m: `⚠️ "${account}" 로그인 안 됨 — 콘솔에서 계정(아이디·비번)을 추가하세요.` }], status: "paused" });
  return false;
}

export async function loop(): Promise<void> {
  await log("🟢 로컬 봇 가동 — 온비디오 작업을 기다립니다.");
  for (;;) {
    const job = await poll();
    if (!job) { await sleep(5000); continue; }

    // 계정 추가(자동 로그인 요청) — 아이디/비번으로 봇이 자동 로그인(2단계 인증은 창에서). 퍼블리식.
    if (job.pendingLogin && job.pendingLogin.id) {
      const { label, id, pw } = job.pendingLogin;
      await log(`🔑 계정 "${label}" 자동 로그인 시작…`);
      const r = await threadsLogin(label, { id, pw, visible: job.visible !== false, proxy: { on: job.proxyOn, seed: label }, log });
      await report({ loginDone: { label, ok: r.ok, username: id, reason: r.reason }, logs: [{ m: r.ok ? `✅ "${label}" 연결 성공 — 세션 유지됩니다` : `❌ "${label}" 연결 실패: ${r.reason || ""}` }] });
      continue;
    }

    if (job.status !== "running") { await sleep(4000); continue; }
    const proxy: ProxyOpt = { on: job.proxyOn, seed: job.account };
    if (!(await ensureLogin(job.account))) { await sleep(8000); continue; }

    if (job.count >= job.dailyLimit) {
      await report({ logs: [{ m: `✅ 오늘 목표(${job.dailyLimit}개) 달성 — 쉬는 중` }], status: "paused" });
      await sleep(10000); continue;
    }

    // 서버가 준 '이미 댓글 단 글'(영구)을 로컬 done에 병합 → 봇 재시작해도 중복 안 함.
    for (const u2 of job.commentedUrls || []) done.add(u2);

    // 여러 키워드(쉼표/줄바꿈/중점으로 구분) → 돌아가며 하나씩 검색.
    const kws = job.keyword.split(/[,\n·]+/).map((k) => k.trim()).filter(Boolean);
    const kw = kws.length ? kws[kwIdx % kws.length] : job.keyword;
    kwIdx++;
    await log(`🔍 "${kw}" 글 찾는 중…${kws.length > 1 ? ` (키워드 ${kws.length}개 순환)` : ""}`);
    const s = await threadsSearch(job.account, kw, { limit: 15, proxy, log });
    if (!s.ok || !s.items.length) { await log(`"${kw}" — 더 이상 없습니다(검색 결과 없음). 다음 검색까지 대기…`); await sleep(20000); continue; }

    // 아직 활동 안 한 '새 글'만 추림 — 다 했으면 "더 이상 없습니다".
    const fresh = s.items.filter((p) => !done.has(p.url));
    if (!fresh.length) {
      noNewStreak++;
      await log(`"${kw}" — 더 이상 없습니다(${s.items.length}개 모두 이미 작업함).`);
      // 모든 키워드가 연속으로 새 글이 없으면 자동 멈춤(무한 재검색 방지).
      if (noNewStreak >= Math.max(1, kws.length || 1)) {
        await report({ logs: [{ m: "✅ 모든 키워드에서 더 이상 새 글이 없습니다 — 작업을 멈춥니다." }], status: "paused" });
        noNewStreak = 0; await sleep(10000);
      } else { await sleep(8000); }
      continue;
    }
    noNewStreak = 0;

    let count = job.count;
    for (const post of fresh) {
      const cur = await poll(); // 정지/일시정지 즉시 반영
      if (!cur || cur.status !== "running") break;
      if (count >= job.dailyLimit) break;
      if (done.has(post.url)) continue;
      done.add(post.url);

      await log(`📄 글 발견 @${post.author}: "${post.text.slice(0, 40)}…"`);

      // 댓글 내용 결정(토글): AI 자동 or 정해진 문구 로테이션.
      let comment: string | null = null;
      if (job.doComment !== false) {
        if (job.commentMode === "fixed") {
          const fc = job.fixedComments || [];
          if (fc.length) { comment = fc[fixedIdx % fc.length]; fixedIdx++; }
        } else {
          comment = await genComment(post.text);
          if (!comment) await log("   (AI 댓글 생성 실패 — 댓글 없이 진행)");
        }
        if (comment) await log(`   💬 "${comment}"`);
      }
      // 활동 아무것도 안 하면 건너뜀.
      if (!job.doLike && !job.doFollow && !comment) { await log("   (할 활동 없음 — 건너뜀)"); continue; }

      const r = await threadsEngage({ account: job.account, postUrl: post.url, visible: job.visible, proxy, log,
        doLike: job.doLike !== false, doFollow: !!job.doFollow, comment });
      if (r.ok) {
        count++;
        const did = [r.liked && "👍", r.followed && "➕", r.commented && "💬"].filter(Boolean).join("");
        // 활동 영구 저장(중복방지+내역) — 댓글/좋아요/팔로우 중 하나라도 했으면 기록.
        await report({ logs: [{ m: `   ✅ 완료 ${did} (${count}/${job.dailyLimit})`, shot: r.shot }], count,
          activity: { author: post.author, url: post.url, comment: comment || undefined, liked: !!r.liked, followed: !!r.followed, commented: !!r.commented } });
      } else { await report({ logs: [{ m: `   ⚠️ 실패: ${r.reason || ""}`, shot: r.shot }] }); }

      // 사람처럼 랜덤 텀(기본 termSec ~ 1.5배)
      const wait = job.termSec * 1000 + Math.floor(Math.random() * job.termSec * 500);
      await log(`   ⏳ ${Math.round(wait / 1000)}초 대기(사람처럼)`);
      await sleep(wait);
    }
  }
}
