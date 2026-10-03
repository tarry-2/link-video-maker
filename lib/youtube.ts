// 유튜브 자동 업로드 — OAuth(설치형/웹) + videos.insert + Gemini 메타 생성.
// 설정(client id/secret/refresh token)은 data 볼륨의 youtube.json에 저장(재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'youtube.json');

export type YouTubeConfig = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string; // 연결 완료되면 저장(채널 업로드 권한)
  channelTitle?: string; // 연결된 채널 이름(표시용)
};

export function loadYouTube(): YouTubeConfig {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
export function saveYouTube(patch: Partial<YouTubeConfig>) {
  const cur = loadYouTube();
  const next = {...cur, ...patch};
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next));
  fs.renameSync(FILE + '.tmp', FILE);
  return next;
}
export function youtubeStatus() {
  const c = loadYouTube();
  return {
    hasClient: !!(c.clientId && c.clientSecret),
    connected: !!c.refreshToken,
    channelTitle: c.channelTitle || '',
  };
}

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';

// 1) 구글 동의 화면 URL — 사용자가 여기서 채널 접근을 허용한다.
export function authUrl(redirectUri: string): string {
  const c = loadYouTube();
  if (!c.clientId) throw new Error('먼저 Google Client ID/Secret을 저장하세요.');
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // refresh token 받기
    prompt: 'consent', // 매번 refresh token 확실히 받기
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

// 2) 동의 후 받은 code를 refresh token으로 교환해 저장.
export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const c = loadYouTube();
  if (!c.clientId || !c.clientSecret) throw new Error('Client ID/Secret이 없습니다.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code, client_id: c.clientId, client_secret: c.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const d: any = await r.json();
  if (!r.ok || !d.refresh_token) throw new Error('토큰 교환 실패: ' + (d.error_description || d.error || JSON.stringify(d)));
  saveYouTube({refreshToken: d.refresh_token});
  // 채널 이름도 받아 저장(표시용)
  try {
    const title = await fetchChannelTitle(d.access_token);
    if (title) saveYouTube({channelTitle: title});
  } catch {}
}

// refresh token → 단기 access token
async function accessToken(): Promise<string> {
  const c = loadYouTube();
  if (!c.refreshToken || !c.clientId || !c.clientSecret) throw new Error('유튜브가 연결되지 않았습니다.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      client_id: c.clientId, client_secret: c.clientSecret,
      refresh_token: c.refreshToken, grant_type: 'refresh_token',
    }),
  });
  const d: any = await r.json();
  if (!r.ok || !d.access_token) throw new Error('액세스 토큰 갱신 실패: ' + (d.error_description || d.error || ''));
  return d.access_token;
}

// 유튜브 URL에서 video id 추출(youtu.be/ID · watch?v=ID).
export function extractVideoId(url: string): string {
  if (!url) return '';
  const m = url.match(/(?:youtu\.be\/|[?&]v=|shorts\/)([\w-]{11})/);
  return m ? m[1] : '';
}

// 영상 통계(조회·좋아요·댓글·공유). 본인 채널, OAuth 토큰.
// ★정확도: 공개 Data API 통계는 유튜브 스튜디오보다 지연·반올림되고 '공유수'가 아예 없다.
//   → Analytics API(스튜디오와 동일 집계 + shares)로 덮어쓴다. 스코프 미승인/실패 시 Data API 값 유지(무회귀).
export async function getVideoStats(ids: string[], diag?: string[]): Promise<Record<string, {views: number; likes: number; comments: number; shares: number}>> {
  type Stat = {views: number; likes: number; comments: number; shares: number};
  const out: Record<string, Stat> = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const uniqSet = new Set(uniq);
  const token = await accessToken();
  // 1) Data API — 존재 보장(조회·좋아요·댓글). 공유수는 없음(0).
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.join(',')}`, {
      headers: {Authorization: `Bearer ${token}`}, cache: 'no-store',
    });
    const d: any = await r.json();
    if (!r.ok) throw new Error('유튜브 통계 조회 실패: ' + (d?.error?.message || ''));
    for (const it of (d.items || [])) {
      const s = it.statistics || {};
      out[it.id] = {views: Number(s.viewCount || 0), likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0), shares: 0};
    }
  }
  diag?.push(`Data API ${Object.keys(out).length}개 조회`);
  // 2) Analytics API — 스튜디오와 동일 집계로 덮어쓰기 + 공유수. 필터 없이 전체 영상 집계(콤마필터 미사용).
  try {
    const today = new Date().toISOString().slice(0, 10);
    let start = 1, overlaid = 0;
    for (let page = 0; page < 10; page++) {
      const u = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=2005-02-14&endDate=${today}&metrics=views,likes,comments,shares&dimensions=video&maxResults=200&startIndex=${start}&sort=-views`;
      const r = await fetch(u, {headers: {Authorization: `Bearer ${token}`}, cache: 'no-store'});
      const d: any = await r.json();
      if (!r.ok) { diag?.push('⚠️ Analytics 실패(재연결 필요?): ' + (d?.error?.message || r.status)); break; }
      const cols: string[] = (d.columnHeaders || []).map((c: any) => c.name);
      const ci = (n: string) => cols.indexOf(n);
      const rows: any[] = d.rows || [];
      for (const row of rows) {
        const id = row[ci('video')];
        if (!id || !uniqSet.has(id)) continue; // 내가 추적하는 영상만 덮어쓰기
        const prev = out[id] || {views: 0, likes: 0, comments: 0, shares: 0};
        out[id] = {
          views: ci('views') >= 0 ? Number(row[ci('views')]) : prev.views,
          likes: ci('likes') >= 0 ? Number(row[ci('likes')]) : prev.likes,
          comments: ci('comments') >= 0 ? Number(row[ci('comments')]) : prev.comments,
          shares: ci('shares') >= 0 ? Number(row[ci('shares')]) : prev.shares,
        };
        overlaid++;
      }
      if (rows.length < 200) { diag?.push(`✅ Analytics 적용 ${overlaid}개(스튜디오 집계·공유수 포함)`); break; }
      start += 200;
    }
  } catch (e: any) { diag?.push('⚠️ Analytics 예외: ' + (e?.message || e)); }
  return out;
}

// 업로드 현황: 주어진 영상 id들의 실제 게시 시각(snippet.publishedAt) 기준으로
// "오늘(한국시간) 몇 개 · 마지막 게시 시각 · 총 개수" 반환. 업로드 페이스 모니터용.
export async function getUploadActivity(ids: string[]): Promise<{today: number; lastAt: string | null; total: number; error?: string}> {
  if (!youtubeStatus().connected) return {today: 0, lastAt: null, total: 0, error: '연결 안 됨'};
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {today: 0, lastAt: null, total: 0};
  try {
    const token = await accessToken();
    const times: string[] = [];
    for (let i = 0; i < uniq.length; i += 50) {
      const batch = uniq.slice(i, i + 50);
      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${batch.join(',')}`, {
        headers: {Authorization: `Bearer ${token}`}, cache: 'no-store',
      });
      const d: any = await r.json();
      if (!r.ok) return {today: 0, lastAt: null, total: 0, error: d?.error?.message || `API 오류(${r.status})`};
      for (const it of (d.items || [])) if (it.snippet?.publishedAt) times.push(it.snippet.publishedAt);
    }
    times.sort().reverse();
    const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const today = times.filter((t) => new Date(t).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'}) === todayKst).length;
    return {today, lastAt: times[0] || null, total: times.length};
  } catch (e: any) { return {today: 0, lastAt: null, total: 0, error: e.message}; }
}

async function fetchChannelTitle(token: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: {Authorization: 'Bearer ' + token},
  });
  const d: any = await r.json();
  return d?.items?.[0]?.snippet?.title || '';
}

export type UploadMeta = {title: string; description: string; tags: string[]; privacy: 'public' | 'unlisted' | 'private'};

// 3) Gemini(폴백 OpenAI)로 클릭 유도 제목·설명·태그 자동 생성. 쇼츠면 #Shorts 포함.
export async function generateMeta(
  keys: {gemini: string[]; openai?: string},
  title: string,
  narrations: string[],
  durationSec: number,
): Promise<{title: string; description: string; tags: string[]}> {
  const isShort = durationSec <= 60;
  const body = narrations.join(' ').slice(0, 1500);
  const prompt = `너는 한국 유튜브 조회수 최적화 전문가다. 아래 영상의 유튜브 업로드용 메타데이터를 만들어라.
영상 제목(초안): ${title}
영상 내용: ${body}
길이: ${durationSec}초 ${isShort ? '(쇼츠)' : '(롱폼)'}

요구사항:
- title: 클릭하고 싶은 후킹 제목(한국어, 45자 이내, 낚시성 과장 금지)${isShort ? ', 끝에 #Shorts 포함' : ''}
- description: 읽기 쉽게 "빈 줄"로 숨 쉬게 구성. 반드시 이 레이아웃을 지켜라 →
  (1) 첫 줄: 강한 후킹 한 문장
  (2) 빈 줄
  (3) 본문: 내용 요약 + 시청 유도를 짧은 문장 2~4줄로(문단 사이 빈 줄 OK)
  (4) 빈 줄
  (5) 마지막 줄: 핵심 해시태그 8~10개를 한 줄로(# 붙여서, 중복 없이)
  한 덩어리로 다닥다닥 붙이지 말 것. 줄바꿈은 실제 개행문자(\\n)로 넣어라.
- tags: 유튜브 검색 노출용 키워드 12~15개(배열, 한국어 위주, # 없이). description의 해시태그와 겹쳐도 됨(이건 숨은 검색 태그).
JSON만 출력: {"title":"...","description":"...","tags":["..."]}`;
  let raw = '';
  if (keys.gemini.length) {
    try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 1024, temperature: 0.9}); } catch {}
  }
  if (!raw && keys.openai) raw = await openaiJson(keys.openai, prompt, 1024);
  const m = raw.match(/\{[\s\S]*\}/);
  const d = m ? JSON.parse(m[0]) : {};
  let t = String(d.title || title).slice(0, 100);
  if (isShort && !/#shorts/i.test(t)) t += ' #Shorts';
  return {
    title: t,
    description: String(d.description || title).slice(0, 4900),
    tags: Array.isArray(d.tags) ? d.tags.map((x: any) => String(x).replace(/^#/, '').slice(0, 30)).slice(0, 15) : [],
  };
}

// 4) 실제 업로드 — resumable 아닌 멀티파트(단순). 완성 mp4 경로와 메타를 받는다.
export async function uploadVideo(filePath: string, meta: UploadMeta, thumbPath?: string): Promise<{id: string; url: string}> {
  const token = await accessToken();
  const stat = fs.statSync(filePath);
  const snippet = {
    snippet: {title: meta.title, description: meta.description, tags: meta.tags, categoryId: '22'},
    status: {privacyStatus: meta.privacy, selfDeclaredMadeForKids: false},
  };
  // 1단계: resumable 업로드 세션 시작
  const init = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(stat.size),
      },
      body: JSON.stringify(snippet),
    },
  );
  if (!init.ok) throw new Error('업로드 세션 시작 실패: ' + (await init.text()).slice(0, 300));
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Error('업로드 URL을 받지 못했습니다.');
  // 2단계: 파일 본문 업로드(한 번에 — 쇼츠/짧은 영상이라 크기 작음)
  const buf = fs.readFileSync(filePath);
  const up = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {'Content-Type': 'video/mp4', 'Content-Length': String(stat.size)},
    body: buf,
  });
  const d: any = await up.json();
  if (!up.ok || !d.id) throw new Error('업로드 실패: ' + (d.error?.message || JSON.stringify(d)).slice(0, 300));
  // 3단계: 커스텀 썸네일 지정(있으면). 실패해도 업로드 자체는 성공으로 둔다.
  if (thumbPath) {
    try {
      const img = fs.readFileSync(thumbPath);
      await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${d.id}`, {
        method: 'POST',
        headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'image/png', 'Content-Length': String(img.length)},
        body: img,
      });
    } catch {}
  }
  return {id: d.id, url: 'https://youtu.be/' + d.id};
}
