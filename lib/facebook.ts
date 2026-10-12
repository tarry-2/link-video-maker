// 페이스북 페이지 자동 게시 — 완성 영상/카드를 페이스북 페이지에 올린다(Graph API).
// 인스타와 같은 Meta Graph API지만 대상이 '페이지'다. 영상은 공개 URL(file_url)을 주면 FB가 가져간다 → R2 presigned URL.
// 설정(페이지 ID·페이지 액세스 토큰)은 data 볼륨 facebook.json에 저장(재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'facebook.json');
const API = 'v21.0';
const BASE = 'https://graph.facebook.com';

export type FacebookConfig = {
  pageId?: string; // 페이스북 페이지 ID(숫자)
  pageAccessToken?: string; // 페이지 액세스 토큰(pages_manage_posts, pages_read_engagement 권한)
  pageName?: string; // 표시용
  tokenSavedAt?: number; // 토큰 발급 시각(ms)
};

export function loadFacebook(): FacebookConfig {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export function saveFacebook(patch: Partial<FacebookConfig>) {
  const next = {...loadFacebook(), ...patch};
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next));
  fs.renameSync(FILE + '.tmp', FILE);
  return next;
}
export function facebookStatus() {
  const c = loadFacebook();
  return {connected: !!(c.pageId && c.pageAccessToken), pageName: c.pageName || '', pageId: c.pageId || ''};
}

// 연결 확인 + 페이지명 조회(토큰·ID 유효성 검증).
export async function verifyFacebook(cfg: {pageId: string; pageAccessToken: string}): Promise<string> {
  const r = await fetch(`${BASE}/${API}/${cfg.pageId}?fields=name&access_token=${encodeURIComponent(cfg.pageAccessToken)}`, {cache: 'no-store'});
  const d: any = await r.json();
  if (!r.ok || !d.name) throw new Error('페이스북 연결 확인 실패: ' + (d?.error?.message || JSON.stringify(d).slice(0, 200)));
  return d.name;
}

// 페이스북 영상 게시 — 공개 영상 URL(R2 presigned)을 file_url로 주면 FB가 가져가 처리한다.
// 가로/세로 상관없이 페이지 피드에 올라간다. 반환 = {permalink, id}.
export async function publishVideo(
  videoUrl: string, description: string, log?: (m: string) => void,
): Promise<{permalink: string; id: string}> {
  const c = loadFacebook();
  if (!c.pageId || !c.pageAccessToken) throw new Error('페이스북이 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const token = c.pageAccessToken;

  // 1) 영상 업로드(비동기) — file_url로 FB가 원격에서 가져감.
  log?.('[페북] 영상 업로드 요청 중…');
  const cr = await fetch(`${BASE}/${API}/${c.pageId}/videos`, {
    method: 'POST',
    body: new URLSearchParams({file_url: videoUrl, description: description.slice(0, 5000), access_token: token}),
  });
  const cd: any = await cr.json();
  if (!cr.ok || !cd.id) {
    const e = cd?.error || {};
    const detail = [e.message, e.error_user_title, e.error_user_msg, e.error_subcode && ('subcode ' + e.error_subcode)]
      .filter(Boolean).join(' | ') || JSON.stringify(cd).slice(0, 300);
    throw new Error('페북 영상 게시 실패: ' + detail);
  }
  const videoId = cd.id;

  // 2) 처리 대기 — status.video_status=ready까지 폴링(최대 5분). 일시 오류엔 안 죽고 계속.
  log?.('[페북] 영상 처리 대기 중…');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const sr = await fetch(`${BASE}/${API}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const sd: any = await sr.json();
      const vs = sd?.status?.video_status;
      if (vs === 'ready') break;
      if (vs === 'error') throw new Error('페북 영상 처리 실패: ' + (sd?.status?.processing_phase?.error?.message || ''));
      if (i % 4 === 0) log?.(`[페북] 처리 중… (${vs || '대기'})`);
    } catch (e: any) {
      if (/처리 실패/.test(e?.message || '')) throw e;
      if (i % 4 === 0) log?.('[페북] 상태 확인 일시 오류 — 재시도');
    }
    if (i === 59) log?.('[페북] 처리가 오래 걸려요 — 게시는 계속 진행됩니다(페북에서 곧 공개).');
  }

  // 3) 퍼머링크 조회(실패해도 게시는 성공).
  let permalink = '';
  try {
    const lr = await fetch(`${BASE}/${API}/${videoId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const ld: any = await lr.json();
    if (ld.permalink_url) permalink = ld.permalink_url.startsWith('http') ? ld.permalink_url : ('https://www.facebook.com' + ld.permalink_url);
  } catch {}
  log?.('[페북] 게시 완료!');
  return {permalink, id: videoId};
}

// 카드 게시물(여러 장 사진) 페이스북 게시 — 사진을 published=false로 각각 올린 뒤
// feed 글에 attached_media로 묶어 한 게시물로 공개한다. imageUrls = 공개 JPEG URL(R2 presigned).
export async function publishPhotos(
  imageUrls: string[], message: string, log?: (m: string) => void,
): Promise<{permalink: string; id: string}> {
  const c = loadFacebook();
  if (!c.pageId || !c.pageAccessToken) throw new Error('페이스북이 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const token = c.pageAccessToken;
  const urls = imageUrls.filter(Boolean).slice(0, 10);
  if (!urls.length) throw new Error('올릴 이미지가 없습니다.');

  // 1) 사진별 미공개 업로드(published=false) → media fbid 수집.
  const fbids: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    log?.(`[페북] 사진 ${i + 1}/${urls.length} 업로드 중…`);
    const pr = await fetch(`${BASE}/${API}/${c.pageId}/photos`, {
      method: 'POST',
      body: new URLSearchParams({url: urls[i], published: 'false', access_token: token}),
    });
    const pd: any = await pr.json();
    if (!pr.ok || !pd.id) throw new Error(`사진 ${i + 1} 업로드 실패: ` + (pd?.error?.message || JSON.stringify(pd).slice(0, 160)));
    fbids.push(pd.id);
  }

  // 2) feed 글로 묶어 공개.
  log?.('[페북] 게시물로 묶는 중…');
  const body = new URLSearchParams({message: message.slice(0, 5000), access_token: token});
  fbids.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({media_fbid: id})));
  const fr = await fetch(`${BASE}/${API}/${c.pageId}/feed`, {method: 'POST', body});
  const fd: any = await fr.json();
  if (!fr.ok || !fd.id) throw new Error('페북 게시물 묶기 실패: ' + (fd?.error?.message || JSON.stringify(fd).slice(0, 200)));

  // 3) 퍼머링크 조회.
  let permalink = '';
  try {
    const lr = await fetch(`${BASE}/${API}/${fd.id}?fields=permalink_url&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const ld: any = await lr.json();
    if (ld.permalink_url) permalink = ld.permalink_url.startsWith('http') ? ld.permalink_url : ('https://www.facebook.com' + ld.permalink_url);
  } catch {}
  if (!permalink) permalink = `https://www.facebook.com/${fd.id}`;
  log?.('[페북] 게시물 공개 완료!');
  return {permalink, id: fd.id};
}

// 업로드 현황: 페이지에 올라간 영상 기준 "오늘(한국시간) 몇 개 · 마지막 게시 시각 · 총 개수".
export async function getUploadActivity(): Promise<{today: number; lastAt: string | null; total: number; followers?: number; error?: string}> {
  const c = loadFacebook();
  if (!c.pageId || !c.pageAccessToken) return {today: 0, lastAt: null, total: 0, error: '연결 안 됨'};
  const token = c.pageAccessToken;
  // 페이지 팔로워 수 — 영상 목록과 별개로 조회.
  let followers: number | undefined;
  try {
    const fr = await fetch(`${BASE}/${API}/${c.pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const fd: any = await fr.json();
    if (fr.ok) followers = Number(fd?.followers_count ?? fd?.fan_count ?? 0);
  } catch {}
  try {
    const r = await fetch(`${BASE}/${API}/${c.pageId}/videos?fields=id,created_time&limit=100&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const d: any = await r.json();
    if (!r.ok) return {today: 0, lastAt: null, total: 0, followers, error: d?.error?.message || `API 오류(${r.status})`};
    const times: string[] = (d.data || []).map((m: any) => m.created_time).filter(Boolean).sort().reverse();
    const kstDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const today = times.filter((t) => kstDay(t) === todayKst).length;
    return {today, lastAt: times[0] || null, total: times.length, followers};
  } catch (e: any) { return {today: 0, lastAt: null, total: 0, followers, error: e.message}; }
}

// 성과 추적: 내 페이지 영상의 조회수·좋아요·댓글·공유를 permalink 키로 반환.
export async function getFbStats(diag?: string[]): Promise<Record<string, {views: number; likes: number; comments: number; shares: number}>> {
  const c = loadFacebook();
  const byPermalink: Record<string, {views: number; likes: number; comments: number; shares: number}> = {};
  if (!c.pageId || !c.pageAccessToken) { diag?.push('연결 안 됨: pageId 또는 pageAccessToken 없음'); return byPermalink; }
  const token = c.pageAccessToken;
  let url = `${BASE}/${API}/${c.pageId}/videos?fields=id,permalink_url,views,likes.summary(true),comments.summary(true)&limit=100&access_token=${encodeURIComponent(token)}`;
  for (let pg = 0; pg < 3 && url; pg++) {
    try {
      const r = await fetch(url, {cache: 'no-store'});
      const d: any = await r.json();
      if (!r.ok) { diag?.push(`❌ videos 호출 실패 HTTP ${r.status}: ${String(d?.error?.message || JSON.stringify(d)).slice(0, 300)}`); break; }
      diag?.push(`videos 페이지${pg + 1}: ${(d.data || []).length}개`);
      for (const m of (d.data || [])) {
        let permalink = m.permalink_url || '';
        if (permalink && !permalink.startsWith('http')) permalink = 'https://www.facebook.com' + permalink;
        if (!permalink) continue;
        byPermalink[permalink] = {
          views: Number(m.views || 0),
          likes: Number(m.likes?.summary?.total_count || 0),
          comments: Number(m.comments?.summary?.total_count || 0),
          shares: 0,
        };
      }
      url = d.paging?.next || '';
    } catch (e: any) { diag?.push(`❌ videos fetch 예외: ${e.message}`); break; }
  }
  return byPermalink;
}
