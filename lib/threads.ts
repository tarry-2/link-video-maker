// 스레드(Threads) 자동 게시 — 영상/텍스트 게시(Threads Content Publishing API).
// 인스타와 동일한 2단계: 컨테이너 생성(media_type VIDEO + video_url 공개 URL) → status 폴링(FINISHED) → threads_publish.
// ★스레드 핵심: media_type TEXT로 '링크만 있는 글'도 올릴 수 있고, 모든 글에 link_attachment(링크 1개)를 붙일 수 있다
//   → 온파트너 제휴링크(/r/{code})를 조건 없이 글에 꽂을 수 있는 유일한 플랫폼(인스타·유튜브는 링크 조건 까다로움).
// 설정(토큰)은 data 볼륨 threads.json에 저장(재배포해도 유지). 멀티계정(여러 사람 계정 등록) 지원.
// 공식: developers.facebook.com/docs/threads/posts — host=graph.threads.net, version=v1.0.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'threads.json');
const HOST = 'https://graph.threads.net';
const API = 'v1.0';

export type ThreadsConfig = {
  userId?: string; // 스레드 유저 ID(숫자). 토큰으로 /me 조회해 자동 채움.
  accessToken?: string; // 긴 수명 액세스 토큰(threads_content_publish 권한)
  username?: string; // 표시용
  tokenSavedAt?: number; // 토큰 발급/갱신 시각(ms). 자동 갱신 판단용.
};
// ★멀티계정: 여러 사람의 스레드 계정을 등록해두고 골라 보낸다. 각 계정 = 독립 userId+토큰.
export type ThreadsAccount = ThreadsConfig & {id: string; label?: string; addedAt?: number};
// appId/appSecret = OAuth 앱 자격(스레드 앱 공용, 계정 공통). accounts = 연결된 계정들.
type ThreadsStore = {accounts: ThreadsAccount[]; appId?: string; appSecret?: string};

function loadStore(): ThreadsStore {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {accounts: []}; }
  if (raw && Array.isArray(raw.accounts)) return {accounts: raw.accounts.filter((a: any) => a && a.id && a.userId && a.accessToken), appId: raw.appId, appSecret: raw.appSecret};
  if (raw && raw.userId && raw.accessToken) { // 구버전 단일 → 배열 마이그레이션(혹시 모를 하위호환)
    return {accounts: [{id: 'legacy', label: raw.username || '내 계정', userId: raw.userId, accessToken: raw.accessToken, username: raw.username, tokenSavedAt: raw.tokenSavedAt, addedAt: raw.tokenSavedAt}]};
  }
  return {accounts: []};
}
function saveStore(store: ThreadsStore) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(store));
  fs.renameSync(FILE + '.tmp', FILE);
}
export function listThreads(): ThreadsAccount[] { return loadStore().accounts; }
export function getThreads(id?: string): ThreadsAccount | undefined {
  const a = loadStore().accounts;
  return id ? a.find((x) => x.id === id) : a[0];
}
export function addThreads(acc: {userId: string; accessToken: string; username?: string; label?: string}): ThreadsAccount {
  const store = loadStore();
  const exist = store.accounts.find((x) => x.userId === acc.userId);
  if (exist) {
    exist.accessToken = acc.accessToken;
    if (acc.username) exist.username = acc.username;
    if (acc.label) exist.label = acc.label;
    exist.tokenSavedAt = Date.now();
    saveStore(store);
    return exist;
  }
  const account: ThreadsAccount = {
    id: randomUUID(), label: acc.label || acc.username || '계정',
    userId: acc.userId, accessToken: acc.accessToken, username: acc.username,
    tokenSavedAt: Date.now(), addedAt: Date.now(),
  };
  store.accounts.push(account);
  saveStore(store);
  return account;
}
export function removeThreads(id: string) {
  const store = loadStore();
  store.accounts = store.accounts.filter((x) => x.id !== id);
  saveStore(store);
}
export function renameThreads(id: string, label: string) {
  const store = loadStore();
  const a = store.accounts.find((x) => x.id === id);
  if (a) { a.label = label; saveStore(store); }
}
function patchThreads(id: string, patch: Partial<ThreadsAccount>) {
  const store = loadStore();
  const a = store.accounts.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  saveStore(store);
}
export function threadsStatus() {
  const store = loadStore();
  const accounts = store.accounts;
  const first = accounts[0];
  return {
    hasClient: !!(store.appId && store.appSecret), // OAuth 앱 자격 저장됨 = '계정 연결' 버튼 활성화
    connected: accounts.length > 0,
    accounts: accounts.map((a) => ({id: a.id, label: a.label || a.username || '', username: a.username || '', userId: a.userId || ''})),
    username: first?.username || '', userId: first?.userId || '', // 하위호환
  };
}

// ── OAuth(유튜브처럼 버튼 한 번으로 연결) ──
const OAUTH_SCOPE = 'threads_basic,threads_content_publish';
export function saveThreadsClient(appId?: string, appSecret?: string) {
  const store = loadStore();
  if (appId) store.appId = appId.trim();
  if (appSecret) store.appSecret = appSecret.trim();
  saveStore(store);
}
// 1) 동의 창 URL — 사용자가 여기서 스레드 계정 접근을 허용한다.
export function threadsAuthUrl(redirectUri: string): string {
  const s = loadStore();
  if (!s.appId) throw new Error('먼저 스레드 앱 ID/시크릿을 저장하세요.');
  const p = new URLSearchParams({client_id: s.appId, redirect_uri: redirectUri, scope: OAUTH_SCOPE, response_type: 'code'});
  return 'https://threads.net/oauth/authorize?' + p.toString();
}
// 2) 동의 후 받은 code → 단기토큰 → 장기(60일)토큰 교환 → 계정 저장(append, 멀티계정).
export async function exchangeThreadsCode(code: string, redirectUri: string, label?: string): Promise<ThreadsAccount> {
  const s = loadStore();
  if (!s.appId || !s.appSecret) throw new Error('앱 ID/시크릿이 없습니다.');
  const clean = code.split('#')[0]; // Threads는 code 뒤에 '#_'를 붙여줌 → 제거
  // 단기 토큰
  const r = await fetch('https://graph.threads.net/oauth/access_token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: s.appId, client_secret: s.appSecret, code: clean, grant_type: 'authorization_code', redirect_uri: redirectUri}),
  });
  const d: any = await r.json();
  if (!r.ok || !d.access_token) throw new Error('토큰 교환 실패: ' + (d?.error_message || d?.error?.message || d?.error || JSON.stringify(d).slice(0, 200)));
  const shortTok = d.access_token; const userId = String(d.user_id || '');
  // 장기(60일) 토큰 교환 — 실패해도 단기로 폴백.
  let longTok = shortTok;
  try {
    const lr = await fetch(`${HOST}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(s.appSecret)}&access_token=${encodeURIComponent(shortTok)}`, {cache: 'no-store'});
    const ld: any = await lr.json();
    if (lr.ok && ld.access_token) longTok = ld.access_token;
  } catch {}
  // username 조회(실패해도 저장은 진행).
  let username = '';
  try { username = (await verifyThreads(longTok)).username; } catch {}
  return addThreads({userId, accessToken: longTok, username, label});
}

// 연결 확인 + userId·username 조회(토큰 유효성 검증). ★스레드는 /me로 자동 조회 → 토큰만 입력받으면 됨.
export async function verifyThreads(accessToken: string): Promise<{userId: string; username: string}> {
  const r = await fetch(`${HOST}/${API}/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`, {cache: 'no-store'});
  const d: any = await r.json();
  if (!r.ok || !d.id) throw new Error('스레드 연결 확인 실패: ' + (d?.error?.message || JSON.stringify(d).slice(0, 200)));
  return {userId: String(d.id), username: d.username || ''};
}

// 컨테이너 FINISHED 폴링(공식 권장: 영상 처리 평균 30초). 일시 오류엔 안 죽고 계속.
async function waitFinished(containerId: string, token: string, log?: (m: string) => void): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const sr = await fetch(`${HOST}/${API}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const sd: any = await sr.json();
      if (sd.status === 'FINISHED') return;
      if (sd.status === 'ERROR') throw new Error('스레드 영상 처리 실패: ' + (sd.error_message || ''));
      if (sd.status === 'EXPIRED') throw new Error('스레드 컨테이너 만료(24시간 초과).');
      if (i % 4 === 0) log?.(`[스레드] 처리 중… (${sd.status || '대기'})`);
    } catch (e: any) {
      if (/처리 실패|만료/.test(e?.message || '')) throw e;
      if (i % 4 === 0) log?.('[스레드] 상태 확인 일시 오류 — 재시도');
    }
  }
  throw new Error('스레드 영상 처리가 너무 오래 걸립니다. 잠시 후 다시 시도하세요.');
}

// 게시 — FINISHED 직후에도 간헐적으로 "준비 안됨"이 뜰 수 있어 재시도+백오프(인스타 동일 경험).
async function publishWithRetry(userId: string, creationId: string, token: string, log?: (m: string) => void): Promise<any> {
  let last = '';
  for (let a = 0; a < 5; a++) {
    if (a > 0) { await new Promise((r) => setTimeout(r, 4000)); log?.(`[스레드] 게시 재시도 ${a + 1}/5…`); }
    try {
      const pub = await fetch(`${HOST}/${API}/${userId}/threads_publish`, {
        method: 'POST', body: new URLSearchParams({creation_id: creationId, access_token: token}),
      });
      const pd: any = await pub.json();
      if (pub.ok && pd.id) return pd;
      const e = pd?.error || {};
      last = [e.message, e.error_subcode && ('subcode ' + e.error_subcode)].filter(Boolean).join(' | ') || JSON.stringify(pd).slice(0, 200);
      if (/OAuth|permission|토큰|권한|expired|190/i.test(last)) throw new Error('게시 실패: ' + last);
    } catch (e: any) {
      last = e?.message || String(e);
      if (/^게시 실패:/.test(last)) throw e;
    }
  }
  throw new Error('게시 실패(재시도 소진, 잠시 후 다시): ' + last);
}

async function permalinkOf(mediaId: string, token: string): Promise<string> {
  try {
    const lr = await fetch(`${HOST}/${API}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const ld: any = await lr.json();
    return ld.permalink || '';
  } catch { return ''; }
}

// 영상 게시. videoUrl = 공개 접근 가능한 영상 URL(R2 presigned). text = 글(500자 제한).
// linkAttachment = 글에 붙일 링크 1개(온파트너 /r/{code} 제휴링크 등). coverUrl은 스레드 API 미지원이라 무시.
export async function publishVideo(
  videoUrl: string, text: string, log?: (m: string) => void, accountId?: string, linkAttachment?: string,
): Promise<{permalink: string; id: string}> {
  const c = getThreads(accountId);
  if (!c || !c.userId || !c.accessToken) throw new Error('스레드가 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const token = c.accessToken;

  log?.('[스레드] 업로드 컨테이너 생성 중…');
  const createParams: Record<string, string> = {
    media_type: 'VIDEO',
    video_url: videoUrl,
    text: (text || '').slice(0, 500),
    access_token: token,
  };
  if (linkAttachment) createParams.link_attachment = linkAttachment;
  const cr = await fetch(`${HOST}/${API}/${c.userId}/threads`, {method: 'POST', body: new URLSearchParams(createParams)});
  const cd: any = await cr.json();
  if (!cr.ok || !cd.id) {
    const e = cd?.error || {};
    const detail = [e.message, e.error_user_title, e.error_user_msg, e.error_subcode && ('subcode ' + e.error_subcode)]
      .filter(Boolean).join(' | ') || JSON.stringify(cd).slice(0, 300);
    throw new Error('컨테이너 생성 실패: ' + detail);
  }

  log?.('[스레드] 영상 처리 대기 중…');
  await waitFinished(cd.id, token, log);

  log?.('[스레드] 게시 중…');
  const pd: any = await publishWithRetry(c.userId, cd.id, token, log);
  log?.('[스레드] 게시 완료!');
  return {permalink: await permalinkOf(pd.id, token), id: pd.id};
}

// 텍스트(+링크) 전용 게시 — 영상 없이 글만. 쇼핑 글(제휴링크) 등. text 500자 제한.
export async function publishText(
  text: string, log?: (m: string) => void, accountId?: string, linkAttachment?: string,
): Promise<{permalink: string; id: string}> {
  const c = getThreads(accountId);
  if (!c || !c.userId || !c.accessToken) throw new Error('스레드가 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const token = c.accessToken;
  log?.('[스레드] 글 컨테이너 생성 중…');
  const createParams: Record<string, string> = {media_type: 'TEXT', text: (text || '').slice(0, 500), access_token: token};
  if (linkAttachment) createParams.link_attachment = linkAttachment;
  const cr = await fetch(`${HOST}/${API}/${c.userId}/threads`, {method: 'POST', body: new URLSearchParams(createParams)});
  const cd: any = await cr.json();
  if (!cr.ok || !cd.id) throw new Error('글 컨테이너 생성 실패: ' + (cd?.error?.message || JSON.stringify(cd).slice(0, 200)));
  // 텍스트는 즉시 발행 가능하나 공식 권장대로 짧게 대기 후 발행.
  await new Promise((r) => setTimeout(r, 1500));
  log?.('[스레드] 게시 중…');
  const pd: any = await publishWithRetry(c.userId, cd.id, token, log);
  log?.('[스레드] 게시 완료!');
  return {permalink: await permalinkOf(pd.id, token), id: pd.id};
}

// 60일 long-lived 토큰 갱신(또 60일 연장). grant_type=th_refresh_token. 최소 24시간 경과 토큰만 가능.
export async function refreshThreads(log?: (m: string) => void, accountId?: string): Promise<boolean> {
  const c = getThreads(accountId);
  if (!c || !c.accessToken) return false;
  try {
    const r = await fetch(
      `${HOST}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(c.accessToken)}`,
      {cache: 'no-store'},
    );
    const d: any = await r.json();
    if (r.ok && d.access_token) {
      patchThreads(c.id, {accessToken: d.access_token, tokenSavedAt: Date.now()});
      log?.(`[스레드] 토큰 자동 갱신 완료 (${c.label || c.username || c.id}, +${Math.round((d.expires_in || 0) / 86400)}일)`);
      return true;
    }
    log?.('[스레드] 토큰 갱신 건너뜀: ' + (d?.error?.message || JSON.stringify(d).slice(0, 150)));
  } catch (e: any) { log?.('[스레드] 토큰 갱신 오류: ' + e.message); }
  return false;
}
export async function maybeRefreshThreads(log?: (m: string) => void): Promise<void> {
  for (const c of listThreads()) {
    if (!c.accessToken || !c.userId) continue;
    if (!c.tokenSavedAt) { patchThreads(c.id, {tokenSavedAt: Date.now()}); continue; }
    const ageDays = (Date.now() - c.tokenSavedAt) / 86400000;
    if (ageDays >= 45) await refreshThreads(log, c.id);
  }
}

// 업로드 현황: "오늘(한국시간) 몇 개 · 마지막 게시 시각 · 총 개수 · 팔로워". 전 계정 합산.
export async function getUploadActivity(accountId?: string): Promise<{today: number; lastAt: string | null; total: number; followers?: number; error?: string}> {
  const accounts = accountId ? [getThreads(accountId)].filter(Boolean) as ThreadsAccount[] : listThreads();
  if (!accounts.length) return {today: 0, lastAt: null, total: 0, error: '연결 안 됨'};
  let today = 0, total = 0, followers = 0; let lastAt: string | null = null; let error: string | undefined;
  for (const c of accounts) {
    const one = await thActivityForAccount(c);
    today += one.today; total += one.total; followers += one.followers || 0;
    if (one.lastAt && (!lastAt || one.lastAt > lastAt)) lastAt = one.lastAt;
    if (one.error && !error) error = one.error;
  }
  return {today, lastAt, total, followers, ...(error ? {error} : {})};
}
async function thActivityForAccount(c: ThreadsAccount): Promise<{today: number; lastAt: string | null; total: number; followers?: number; error?: string}> {
  const token = c.accessToken!;
  // 팔로워 수(계정 insights). 실패해도 무시.
  let followers: number | undefined;
  try {
    const fr = await fetch(`${HOST}/${API}/${c.userId}/threads_insights?metric=followers_count&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const fd: any = await fr.json();
    if (fr.ok) followers = Number(fd?.data?.[0]?.total_value?.value ?? 0);
  } catch {}
  try {
    const r = await fetch(`${HOST}/${API}/${c.userId}/threads?fields=id,timestamp&limit=100&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const d: any = await r.json();
    if (!r.ok) return {today: 0, lastAt: null, total: 0, followers, error: d?.error?.message || `API 오류(${r.status})`};
    const times: string[] = (d.data || []).map((m: any) => m.timestamp).filter(Boolean).sort().reverse();
    const kstDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const today = times.filter((t) => kstDay(t) === todayKst).length;
    return {today, lastAt: times[0] || null, total: times.length, followers};
  } catch (e: any) { return {today: 0, lastAt: null, total: 0, followers, error: e.message}; }
}

// 성과 추적: 내 스레드 게시물의 조회수·좋아요·댓글(replies)을 permalink 키로 반환.
// 스레드는 좋아요/댓글이 미디어 목록 fields에 없어 insights(views,likes,replies)로 조회한다.
export async function getThreadsStats(diag?: string[]): Promise<Record<string, {views: number; likes: number; comments: number}>> {
  const byPermalink: Record<string, {views: number; likes: number; comments: number}> = {};
  const accounts = listThreads();
  if (!accounts.length) { diag?.push('연결 안 됨: 계정 없음'); return byPermalink; }
  for (const c of accounts) await thStatsForAccount(c, byPermalink, diag);
  return byPermalink;
}
async function thStatsForAccount(c: ThreadsAccount, byPermalink: Record<string, {views: number; likes: number; comments: number}>, diag?: string[]): Promise<void> {
  const token = c.accessToken!;
  const media: {id: string; permalink: string}[] = [];
  let url = `${HOST}/${API}/${c.userId}/threads?fields=id,permalink&limit=100&access_token=${encodeURIComponent(token)}`;
  for (let pg = 0; pg < 3 && url; pg++) {
    try {
      const r = await fetch(url, {cache: 'no-store'});
      const d: any = await r.json();
      if (!r.ok) { diag?.push(`❌ threads 목록 실패 HTTP ${r.status}: ${String(d?.error?.message || '').slice(0, 200)}`); break; }
      for (const m of (d.data || [])) if (m.permalink) media.push({id: m.id, permalink: m.permalink});
      url = d.paging?.next || '';
    } catch (e: any) { diag?.push(`❌ threads 목록 예외: ${e.message}`); break; }
  }
  diag?.push(`총 게시물 ${media.length}개`);
  let noted = false;
  for (const m of media) {
    let views = 0, likes = 0, comments = 0;
    try {
      const ir = await fetch(`${HOST}/${API}/${m.id}/insights?metric=views,likes,replies&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const idata: any = await ir.json();
      if (ir.ok) for (const row of (idata.data || [])) {
        const v = Number(row?.values?.[0]?.value ?? row?.total_value?.value ?? 0);
        if (row.name === 'views') views = v; else if (row.name === 'likes') likes = v; else if (row.name === 'replies') comments = v;
      } else if (!noted) { diag?.push(`⚠️ insights 실패 HTTP ${ir.status}: ${String(idata?.error?.message || '').slice(0, 200)}`); noted = true; }
    } catch (e: any) { if (!noted) { diag?.push(`⚠️ insights 예외: ${e.message}`); noted = true; } }
    byPermalink[m.permalink] = {views, likes, comments};
  }
}
