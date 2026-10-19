// 폴링 워커 — 온비디오(클라우드) 작업큐를 폴링해 스레드 공감댓글을 실행한다.
//   poll(할 일) → 로그인 확인 → 키워드 검색 → 글마다 AI 공감댓글 생성 요청 → 댓글 등록 → report(로그·스샷·카운트).
//   사람처럼: 글 사이 랜덤 텀, 하루 한도, 정지/일시정지 즉시 반영. (control-tower poll-worker 패턴)
import { threadsLogin, threadsSearch, threadsComment, threadsSessionExists } from "./threads";
import { sleep, ProxyOpt } from "./browser";

const BASE = (process.env.OVBOT_BASE || "https://video.xn--zk5biyyw.com").replace(/\/$/, "");
const TOKEN = process.env.OVBOT_TOKEN || "onvideo-secret-bot";

type Job = {
  status: "idle" | "running" | "paused" | "stopped";
  keyword: string; account: string; dailyLimit: number; termSec: number;
  proxyOn: boolean; visible: boolean; count: number;
  accounts?: { label: string; username: string; loggedIn: boolean }[];
  pendingLogin?: { label: string; id: string; pw: string } | null;
};

function api(path: string, init?: any): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${BASE}${path}${sep}token=${encodeURIComponent(TOKEN)}`, init);
}
async function poll(): Promise<Job | null> {
  try { return await (await api("/api/secret/poll")).json(); } catch { return null; }
}
async function report(body: { logs?: { m: string; shot?: string }[]; count?: number; status?: string; loginDone?: { label: string; ok: boolean; username: string } }): Promise<void> {
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
      await report({ loginDone: { label, ok: r.ok, username: id }, logs: [{ m: r.ok ? `✅ "${label}" 로그인 성공 — 세션 유지됩니다` : `⚠️ "${label}" 로그인 실패: ${r.reason || ""}` }] });
      continue;
    }

    if (job.status !== "running") { await sleep(4000); continue; }
    const proxy: ProxyOpt = { on: job.proxyOn, seed: job.account };
    if (!(await ensureLogin(job.account))) { await sleep(8000); continue; }

    if (job.count >= job.dailyLimit) {
      await report({ logs: [{ m: `✅ 오늘 목표(${job.dailyLimit}개) 달성 — 쉬는 중` }], status: "paused" });
      await sleep(10000); continue;
    }

    await log(`🔍 "${job.keyword}" 글 찾는 중…`);
    const s = await threadsSearch(job.account, job.keyword, { limit: 15, proxy, log });
    if (!s.ok || !s.items.length) { await log("글을 못 찾음 — 잠시 후 다시 검색"); await sleep(15000); continue; }

    let count = job.count;
    for (const post of s.items) {
      const cur = await poll(); // 정지/일시정지 즉시 반영
      if (!cur || cur.status !== "running") break;
      if (count >= job.dailyLimit) break;
      if (done.has(post.url)) continue;
      done.add(post.url);

      await log(`📄 글 발견 @${post.author}: "${post.text.slice(0, 40)}…"`);
      const comment = await genComment(post.text);
      if (!comment) { await log("   (댓글 생성 실패 — 건너뜀)"); continue; }
      await log(`   💬 "${comment}"`);

      const r = await threadsComment({ account: job.account, postUrl: post.url, text: comment, visible: job.visible, proxy, log });
      if (r.ok) { count++; await report({ logs: [{ m: `   ✅ 등록 완료 (${count}/${job.dailyLimit})`, shot: r.shot }], count }); }
      else { await report({ logs: [{ m: `   ⚠️ 실패: ${r.reason || ""}`, shot: r.shot }] }); }

      // 사람처럼 랜덤 텀(기본 termSec ~ 1.5배)
      const wait = job.termSec * 1000 + Math.floor(Math.random() * job.termSec * 500);
      await log(`   ⏳ ${Math.round(wait / 1000)}초 대기(사람처럼)`);
      await sleep(wait);
    }
  }
}
