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
  const prompt = `너는 인스타그램 릴스로 수십만 조회를 터뜨리는 바이럴 카피라이터다. 아래 영상에 어울리는, 사람들이 "이거 봐봐" 하고 친구 태그하고 댓글 달고 공유하고 싶어지는 가십성·화제성 릴스 캡션을 만들어라.
영상 제목(초안): ${title}
영상 내용: ${body}

인스타 릴스 캡션 규칙(유튜브 설명과 완전히 다르게 — 더 가볍고 떡밥·공감 중심):
- hook: 첫 줄은 스크롤을 멈추게 하는 강한 떡밥/반전/공감 한 문장. "헉" 하거나 궁금해서 끝까지 보게. 이모지 1~2개 자연스럽게. (거짓 낚시는 금지, 하지만 자극적이고 화제성 있게)
- body: 2~4줄. 짧은 문장 + 줄바꿈으로 가독성. 친구한테 썰 푸는 말투(딱딱한 설명체 금지). 공감·호기심을 증폭시키고, 끝에 댓글을 부르는 질문 1개 + 저장/공유를 부르는 한마디.
- hashtags: 인스타에서 실제 잘 노출되는 화제성 해시태그 12~15개. 한국어 중심 + 핵심 영어 2~3개. 초대형 트렌드 태그(릴스추천/탐색탭 류) 1~2개 + 주제 핵심 + 틈새를 믹스. # 없이 배열로, 공백 없는 단어.
JSON만 출력: {"hook":"...","body":"...","hashtags":["...","..."]}`;
  let raw = '';
  if (keys.gemini.length) {
    try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 1024, temperature: 1.0}); } catch {}
  }
  if (!raw && keys.openai) raw = await openaiJson(keys.openai, prompt, 1024);
  const m = raw.match(/\{[\s\S]*\}/);
  const d: any = m ? JSON.parse(m[0]) : {};
  const hook = String(d.hook || title).trim();
  const bodyText = String(d.body || '').trim();
  const tags = Array.isArray(d.hashtags)
    ? [...new Set(d.hashtags.map((x: any) => '#' + String(x).replace(/^#+/, '').replace(/\s+/g, '')).filter((t: string) => t.length > 1))].slice(0, 15)
    : [];
  // 인스타식 레이아웃: 훅 / 빈 줄 / 본문 / 빈 줄 / 해시태그 한 줄
  return [hook, bodyText, tags.join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
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
