// 인스타그램 자동 업로드 — 릴스/피드 영상 게시(Content Publishing API).
// 인스타는 파일 업로드가 아니라 "공개 URL"을 주면 거기서 영상을 가져간다 → R2 presigned URL 사용.
// 설정(IG User ID·access token)은 data 볼륨 instagram.json에 저장(재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'instagram.json');
const API = 'v21.0';

export type InstagramConfig = {
  igUserId?: string; // 인스타 비즈니스/크리에이터 계정 ID(숫자)
  accessToken?: string; // 긴 수명 액세스 토큰(instagram_content_publish 권한)
  base?: 'instagram' | 'facebook'; // graph.instagram.com(IG 로그인) / graph.facebook.com(FB 로그인)
  username?: string; // 표시용
  tokenSavedAt?: number; // 토큰 발급/갱신 시각(ms). 자동 갱신 판단용.
};

export function loadInstagram(): InstagramConfig {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export function saveInstagram(patch: Partial<InstagramConfig>) {
  const next = {...loadInstagram(), ...patch};
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next));
  fs.renameSync(FILE + '.tmp', FILE);
  return next;
}
export function instagramStatus() {
  const c = loadInstagram();
  return {connected: !!(c.igUserId && c.accessToken), username: c.username || '', igUserId: c.igUserId || ''};
}

function host(c: InstagramConfig) {
  return c.base === 'facebook' ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
}

// 연결 확인 + 계정명 조회(토큰·ID 유효성 검증).
export async function verifyInstagram(cfg: {igUserId: string; accessToken: string; base?: 'instagram' | 'facebook'}): Promise<string> {
  const c = {...cfg, base: cfg.base || 'instagram' as const};
  const r = await fetch(`${host(c)}/${API}/${c.igUserId}?fields=username&access_token=${encodeURIComponent(c.accessToken)}`, {cache: 'no-store'});
  const d: any = await r.json();
  if (!r.ok || !d.username) throw new Error('인스타 연결 확인 실패: ' + (d?.error?.message || JSON.stringify(d).slice(0, 200)));
  return d.username;
}

// 인스타 릴스 전용 캡션 자동 생성(유튜브 메타와 다르게 — 가십성·화제성·댓글 유발 톤).
// 반환 = 바로 붙여 쓸 수 있는 완성 캡션(훅 / 빈줄 / 본문 / 빈줄 / 해시태그 한 줄).
export async function generateCaption(
  keys: {gemini: string[]; openai?: string},
  title: string,
  narrations: string[],
): Promise<string> {
  const body = narrations.join(' ').slice(0, 1500);
  const prompt = `너는 인스타그램 릴스로 수십만 조회를 터뜨리는 바이럴 카피라이터다. 아래 영상에 어울리는, 사람들이 "헉 완전 내 얘기", "이거 저장!" 하며 공감하고 댓글 달고 친구 태그하는 릴스 캡션을 만들어라.
영상 제목(초안): ${title}
영상 내용: ${body}

★가장 중요: 인스타는 모바일로 본다. 글이 한 눈에 '술술' 읽혀야 한다. 긴 문단 금지. 짧은 문장 하나하나를 "블록"으로 쪼개고, 블록 사이는 빈 줄로 숨 쉬게 한다. 그리고 정보보다 '공감'을 먼저 친다(읽는 사람이 자기 얘기처럼 느끼게).

규칙:
- hook: 첫 줄. 스크롤을 멈추게 하는 강한 공감+떡밥 한 문장("아침마다 얼굴 붓는 사람 꼭 보세요" 처럼 대상을 콕 집어 공감 유발). 이모지 1~2개. 거짓 낚시 금지, 하지만 임팩트 최대.
- blocks: 2~4개의 짧은 블록(배열). 각 블록은 1~2줄로 아주 짧게.
   · 1번 블록 = 강한 공감(구체적 일상 상황·감정으로 "나도 그런데" 유발).
   · 중간 블록 = 반전/핵심 가치/궁금증 증폭.
   · 마지막 블록 = 댓글 부르는 질문 1개 + "저장해두고 써먹어요" 류 저장/공유 유도.
   친구한테 썰 푸는 말투. 딱딱한 설명체·정보 나열 금지.
- hashtags: 인스타에서 실제 잘 노출되는 화제성 해시태그 12~15개. 한국어 중심 + 핵심 영어 2~3개. 초대형 트렌드 태그(릴스추천/탐색탭 류) 1~2개 + 주제 핵심 + 틈새 믹스. # 없이 배열, 공백 없는 단어.
JSON만 출력: {"hook":"...","blocks":["...","...","..."],"hashtags":["...","..."]}`;
  let raw = '';
  if (keys.gemini.length) {
    try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 1024, temperature: 1.0}); } catch {}
  }
  if (!raw && keys.openai) raw = await openaiJson(keys.openai, prompt, 1024);
  const m = raw.match(/\{[\s\S]*\}/);
  const d: any = m ? JSON.parse(m[0]) : {};
  const hook = String(d.hook || title).trim();
  // blocks(신규) 우선, 없으면 body(구) 호환. 각 블록을 빈 줄로 띄워 모바일 가독성 확보.
  const blocks = Array.isArray(d.blocks)
    ? d.blocks.map((x: any) => String(x).trim()).filter(Boolean)
    : (d.body ? [String(d.body).trim()] : []);
  const tags = Array.isArray(d.hashtags)
    ? [...new Set(d.hashtags.map((x: any) => '#' + String(x).replace(/^#+/, '').replace(/\s+/g, '')).filter((t: string) => t.length > 1))].slice(0, 15)
    : [];
  // 인스타식 레이아웃: 훅 / 빈 줄 / (블록마다 빈 줄) / 빈 줄 / 해시태그 한 줄
  return [hook, ...blocks, tags.join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
}

// 릴스/피드 영상 게시. kind: 'reels'(세로 쇼츠) | 'feed'(일반 게시물 영상).
// videoUrl = 공개 접근 가능한 영상 URL(R2 presigned). caption = 글.
export async function publishVideo(
  videoUrl: string, caption: string, kind: 'reels' | 'feed', log?: (m: string) => void,
): Promise<{permalink: string; id: string}> {
  const c = loadInstagram();
  if (!c.igUserId || !c.accessToken) throw new Error('인스타가 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const base = host(c);
  const token = c.accessToken;

  // 1) 미디어 컨테이너 생성(릴스=REELS, 피드 영상도 현재는 REELS 처리가 표준).
  log?.('[인스타] 업로드 컨테이너 생성 중…');
  const createBody = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption.slice(0, 2200),
    share_to_feed: kind === 'feed' ? 'true' : 'true', // 릴스를 피드에도 노출
    access_token: token,
  });
  const cr = await fetch(`${base}/${API}/${c.igUserId}/media`, {method: 'POST', body: createBody});
  const cd: any = await cr.json();
  if (!cr.ok || !cd.id) throw new Error('컨테이너 생성 실패: ' + (cd?.error?.message || JSON.stringify(cd).slice(0, 200)));
  const creationId = cd.id;

  // 2) 영상 처리 대기(릴스는 인코딩 시간 필요). status_code=FINISHED까지 폴링(최대 5분).
  log?.('[인스타] 영상 처리 대기 중… (릴스 인코딩)');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sr = await fetch(`${base}/${API}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const sd: any = await sr.json();
    if (sd.status_code === 'FINISHED') break;
    if (sd.status_code === 'ERROR') throw new Error('인스타 영상 처리 실패: ' + (sd.status || ''));
    if (i % 4 === 0) log?.(`[인스타] 처리 중… (${sd.status_code || '대기'})`);
    if (i === 59) throw new Error('인스타 영상 처리가 너무 오래 걸립니다. 잠시 후 다시 시도하세요.');
  }

  // 3) 게시.
  log?.('[인스타] 게시 중…');
  const pub = await fetch(`${base}/${API}/${c.igUserId}/media_publish`, {
    method: 'POST', body: new URLSearchParams({creation_id: creationId, access_token: token}),
  });
  const pd: any = await pub.json();
  if (!pub.ok || !pd.id) throw new Error('게시 실패: ' + (pd?.error?.message || JSON.stringify(pd).slice(0, 200)));

  // 4) 퍼머링크 조회(실패해도 게시는 성공).
  let permalink = '';
  try {
    const lr = await fetch(`${base}/${API}/${pd.id}?fields=permalink&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const ld: any = await lr.json();
    permalink = ld.permalink || '';
  } catch {}
  log?.('[인스타] 게시 완료!');
  return {permalink, id: pd.id};
}

// 60일 long-lived 토큰을 ig_refresh_token으로 갱신(또 60일 연장). Instagram 로그인(graph.instagram.com) 토큰만 가능.
export async function refreshInstagram(log?: (m: string) => void): Promise<boolean> {
  const c = loadInstagram();
  if (!c.accessToken || c.base === 'facebook') return false;
  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.accessToken)}`,
      {cache: 'no-store'},
    );
    const d: any = await r.json();
    if (r.ok && d.access_token) {
      saveInstagram({accessToken: d.access_token, tokenSavedAt: Date.now()});
      log?.(`[인스타] 토큰 자동 갱신 완료 (+${Math.round((d.expires_in || 0) / 86400)}일)`);
      return true;
    }
    log?.('[인스타] 토큰 갱신 건너뜀: ' + (d?.error?.message || JSON.stringify(d).slice(0, 150)));
  } catch (e: any) { log?.('[인스타] 토큰 갱신 오류: ' + e.message); }
  return false;
}

// 토큰 나이를 보고 필요할 때만 갱신(45일↑). 연결 안 됐거나 FB방식이면 무시. 기준시각 없으면 지금으로 기록만.
export async function maybeRefreshInstagram(log?: (m: string) => void): Promise<void> {
  const c = loadInstagram();
  if (!c.accessToken || !c.igUserId || c.base === 'facebook') return;
  if (!c.tokenSavedAt) { saveInstagram({tokenSavedAt: Date.now()}); return; }
  const ageDays = (Date.now() - c.tokenSavedAt) / 86400000;
  if (ageDays >= 45) await refreshInstagram(log);
}

// 업로드 현황: 인스타에 실제로 올라간 시각(media timestamp) 기준으로
// "오늘(한국시간) 몇 개 · 마지막 게시 시각 · 총 개수"를 반환. 업로드 페이스 모니터용.
export async function getUploadActivity(): Promise<{today: number; lastAt: string | null; total: number; error?: string}> {
  const c = loadInstagram();
  if (!c.igUserId || !c.accessToken) return {today: 0, lastAt: null, total: 0, error: '연결 안 됨'};
  const base = host(c), token = c.accessToken;
  try {
    const r = await fetch(`${base}/${API}/${c.igUserId}/media?fields=id,timestamp&limit=100&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const d: any = await r.json();
    if (!r.ok) return {today: 0, lastAt: null, total: 0, error: d?.error?.message || `API 오류(${r.status})`};
    const times: string[] = (d.data || []).map((m: any) => m.timestamp).filter(Boolean).sort().reverse();
    const kstDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'}); // YYYY-MM-DD
    const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const today = times.filter((t) => kstDay(t) === todayKst).length;
    return {today, lastAt: times[0] || null, total: times.length};
  } catch (e: any) { return {today: 0, lastAt: null, total: 0, error: e.message}; }
}

// 성과 추적: 내 인스타 미디어의 조회수·좋아요·댓글을 permalink 키로 반환.
// 좋아요/댓글은 미디어 목록 fields로 1콜(확실), 조회수(릴스 재생)는 미디어별 insights(views).
// diag(옵션): 진단 로그 배열을 넘기면 Meta API 실제 응답/에러를 담아준다(삼키지 않음). debug=1 용.
export async function getInstaStats(
  diag?: string[],
): Promise<Record<string, {views: number; likes: number; comments: number}>> {
  const c = loadInstagram();
  const byPermalink: Record<string, {views: number; likes: number; comments: number}> = {};
  if (!c.igUserId || !c.accessToken) { diag?.push('연결 안 됨: igUserId 또는 accessToken 없음'); return byPermalink; }
  const base = host(c), token = c.accessToken;
  const tokAge = c.tokenSavedAt ? Math.round((Date.now() - c.tokenSavedAt) / 86400000) + '일' : '미기록';
  diag?.push(`base=${base} · igUserId=${c.igUserId} · 토큰나이=${tokAge}`);
  // 1) 최근 미디어 목록(permalink + 좋아요/댓글) — 최대 3페이지.
  const media: {id: string; permalink: string; likes: number; comments: number}[] = [];
  let url = `${base}/${API}/${c.igUserId}/media?fields=id,permalink,like_count,comments_count,media_type&limit=100&access_token=${encodeURIComponent(token)}`;
  for (let pg = 0; pg < 3 && url; pg++) {
    try {
      const r = await fetch(url, {cache: 'no-store'});
      const d: any = await r.json();
      if (!r.ok) {
        const err = d?.error || d;
        diag?.push(`❌ media 호출 실패 HTTP ${r.status} (code=${err?.code ?? '?'}): ${String(err?.message || JSON.stringify(err)).slice(0, 300)}`);
        break;
      }
      diag?.push(`media 페이지${pg + 1}: ${(d.data || []).length}개 반환`);
      for (const m of (d.data || [])) media.push({id: m.id, permalink: m.permalink, likes: Number(m.like_count || 0), comments: Number(m.comments_count || 0)});
      url = d.paging?.next || '';
    } catch (e: any) { diag?.push(`❌ media fetch 예외: ${e.message}`); break; }
  }
  diag?.push(`총 미디어 ${media.length}개 · 첫 permalink=${media[0]?.permalink || '(없음)'} · 첫 좋아요=${media[0]?.likes ?? '?'}`);
  // 2) 각 미디어 조회수(insights views) — 실패해도 좋아요/댓글은 유지. 첫 실패만 진단 기록.
  let insightNoted = false;
  for (const m of media) {
    let views = 0;
    try {
      const ir = await fetch(`${base}/${API}/${m.id}/insights?metric=views&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const idata: any = await ir.json();
      if (ir.ok) views = Number(idata.data?.[0]?.values?.[0]?.value ?? idata.data?.[0]?.total_value?.value ?? 0);
      else if (!insightNoted) {
        const err = idata?.error || idata;
        diag?.push(`⚠️ insights(views) 실패 HTTP ${ir.status} (code=${err?.code ?? '?'}): ${String(err?.message || JSON.stringify(err)).slice(0, 300)}`);
        insightNoted = true;
      }
    } catch (e: any) { if (!insightNoted) { diag?.push(`⚠️ insights 예외: ${e.message}`); insightNoted = true; } }
    if (m.permalink) byPermalink[m.permalink] = {views, likes: m.likes, comments: m.comments};
  }
  return byPermalink;
}
