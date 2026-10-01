// 인스타그램 자동 업로드 — 릴스/피드 영상 게시(Content Publishing API).
// 인스타는 파일 업로드가 아니라 "공개 URL"을 주면 거기서 영상을 가져간다 → R2 presigned URL 사용.
// 설정(IG User ID·access token)은 data 볼륨 instagram.json에 저장(재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'instagram.json');
const API = 'v21.0';

export type InstagramConfig = {
  igUserId?: string; // 인스타 비즈니스/크리에이터 계정 ID(숫자)
  accessToken?: string; // 긴 수명 액세스 토큰(instagram_content_publish 권한)
  base?: 'instagram' | 'facebook'; // graph.instagram.com(IG 로그인) / graph.facebook.com(FB 로그인)
  username?: string; // 표시용
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
