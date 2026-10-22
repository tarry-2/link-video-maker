// 인스타그램 자동 업로드 — 릴스/피드 영상 게시(Content Publishing API).
// 인스타는 파일 업로드가 아니라 "공개 URL"을 주면 거기서 영상을 가져간다 → R2 presigned URL 사용.
// 설정(IG User ID·access token)은 data 볼륨 instagram.json에 저장(재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'instagram.json');
const API = 'v21.0';

// media_publish 재시도 — 컨테이너가 FINISHED여도 인스타가 간헐적으로 "미디어 준비 안됨"(code 9007 등)을
//   내고 잠시 뒤 재시도하면 성공한다(유튜브엔 없는 인스타 특유 현상 — 테리: 재시도하면 됨). 최대 5회·4초 간격.
async function publishWithRetry(base: string, igUserId: string, creationId: string, token: string, log?: (m: string) => void): Promise<any> {
  let last = '';
  for (let a = 0; a < 5; a++) {
    if (a > 0) { await new Promise((r) => setTimeout(r, 4000)); log?.(`[인스타] 게시 재시도 ${a + 1}/5…`); }
    try {
      const pub = await fetch(`${base}/${API}/${igUserId}/media_publish`, {
        method: 'POST', body: new URLSearchParams({creation_id: creationId, access_token: token}),
      });
      const pd: any = await pub.json();
      if (pub.ok && pd.id) return pd;
      const e = pd?.error || {};
      last = [e.message, e.error_subcode && ('subcode ' + e.error_subcode)].filter(Boolean).join(' | ') || JSON.stringify(pd).slice(0, 200);
      // 영구 에러(권한·토큰 만료)면 재시도 무의미 → 즉시 중단. 그 외(준비안됨·일시)는 재시도.
      if (/OAuth|permission|토큰|권한|expired|190|again later is not/i.test(last)) throw new Error('게시 실패: ' + last);
    } catch (e: any) {
      last = e?.message || String(e);
      if (/^게시 실패:/.test(last)) throw e;
    }
  }
  throw new Error('게시 실패(재시도 소진, 잠시 후 다시): ' + last);
}

export type InstagramConfig = {
  igUserId?: string; // 인스타 비즈니스/크리에이터 계정 ID(숫자)
  accessToken?: string; // 긴 수명 액세스 토큰(instagram_content_publish 권한)
  base?: 'instagram' | 'facebook'; // graph.instagram.com(IG 로그인) / graph.facebook.com(FB 로그인)
  username?: string; // 표시용
  tokenSavedAt?: number; // 토큰 발급/갱신 시각(ms). 자동 갱신 판단용.
};
// ★멀티계정: 여러 사람의 인스타 계정을 등록해두고 골라 보낸다. 각 계정 = 독립 igUserId+토큰.
export type InstagramAccount = InstagramConfig & {id: string; label?: string; addedAt?: number};
type InstagramStore = {accounts: InstagramAccount[]};

function loadStore(): InstagramStore {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {accounts: []}; }
  if (raw && Array.isArray(raw.accounts)) return {accounts: raw.accounts.filter((a: any) => a && a.id && a.igUserId && a.accessToken)};
  if (raw && raw.igUserId && raw.accessToken) { // 구버전 단일 → 배열 마이그레이션
    return {accounts: [{id: 'legacy', label: raw.username || '내 계정', igUserId: raw.igUserId, accessToken: raw.accessToken, base: raw.base, username: raw.username, tokenSavedAt: raw.tokenSavedAt, addedAt: raw.tokenSavedAt}]};
  }
  return {accounts: []};
}
function saveStore(store: InstagramStore) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(store));
  fs.renameSync(FILE + '.tmp', FILE);
}
export function listInstagram(): InstagramAccount[] { return loadStore().accounts; }
export function getInstagram(id?: string): InstagramAccount | undefined {
  const a = loadStore().accounts;
  return id ? a.find((x) => x.id === id) : a[0];
}
export function loadInstagram(): InstagramConfig { return getInstagram() || {}; } // 하위호환
export function addInstagram(acc: {igUserId: string; accessToken: string; base?: 'instagram' | 'facebook'; username?: string; label?: string}): InstagramAccount {
  const store = loadStore();
  const exist = store.accounts.find((x) => x.igUserId === acc.igUserId);
  if (exist) {
    exist.accessToken = acc.accessToken;
    if (acc.base) exist.base = acc.base;
    if (acc.username) exist.username = acc.username;
    if (acc.label) exist.label = acc.label;
    exist.tokenSavedAt = Date.now();
    saveStore(store);
    return exist;
  }
  const account: InstagramAccount = {
    id: randomUUID(), label: acc.label || acc.username || '계정',
    igUserId: acc.igUserId, accessToken: acc.accessToken, base: acc.base || 'instagram', username: acc.username,
    tokenSavedAt: Date.now(), addedAt: Date.now(),
  };
  store.accounts.push(account);
  saveStore(store);
  return account;
}
export function removeInstagram(id: string) {
  const store = loadStore();
  store.accounts = store.accounts.filter((x) => x.id !== id);
  saveStore(store);
}
export function renameInstagram(id: string, label: string) {
  const store = loadStore();
  const a = store.accounts.find((x) => x.id === id);
  if (a) { a.label = label; saveStore(store); }
}
// 특정 계정 필드 갱신(토큰 자동갱신용). id로 찾아 patch.
function patchInstagram(id: string, patch: Partial<InstagramAccount>) {
  const store = loadStore();
  const a = store.accounts.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  saveStore(store);
}
export function instagramStatus() {
  const accounts = listInstagram();
  const first = accounts[0];
  return {
    connected: accounts.length > 0,
    accounts: accounts.map((a) => ({id: a.id, label: a.label || a.username || '', username: a.username || '', igUserId: a.igUserId || ''})),
    username: first?.username || '', igUserId: first?.igUserId || '', // 하위호환
  };
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
export type CaptionPlatform = 'instagram' | 'threads' | 'facebook';

// 플랫폼별 글 규칙 — 2026 실측 기준. 같은 영상도 플랫폼마다 글이 달라야 먹힌다.
//   instagram: 공감·재미, 해시태그 5개(30개는 구식), 첫 125자가 승부, 블록 레이아웃.
//   threads:   텍스트가 본체인 대화 플랫폼. 500자 이내, 첫 문장에 다 걸고, 해시태그 0~1개(떡칠은 독),
//              끝은 댓글 부르는 질문(댓글이 노출을 결정). 해시태그 떡칠/광고 톤 = 조회수 안 나오는 직접 원인.
//   facebook:  480자 내외 스토리텔링, 해시태그 1~2개(효과 작음), 공유 유도.
function buildCaptionPrompt(platform: CaptionPlatform, title: string, body: string): string {
  const base = `영상 제목: ${title}
영상 내용(자막/해설): ${body || '(내용 정보가 적음 — 제목에 드러난 소재만 근거로 삼아라)'}

🔴🔴절대 규칙 — 반드시 지켜라:
- '위에 주어진 제목·내용에 실제로 나온 소재'로만 써라. 거기 없는 주제를 지어내지 마라.
- '붓기·다이어트·피부·건강 꿀팁' 류는 제목/내용에 그 말이 실제로 있을 때만. 먹방·예능·스포츠 영상을 다이어트/붓기로 비틀지 마라(완전히 다른 영상이 된다).
- 내용 정보가 적으면 억지 각도 금지, 영상에 실제로 보이는 장면·인물·상황을 그대로 공감 포인트로 삼아라.`;

  if (platform === 'threads') {
    return `너는 '스레드(Threads)'에서 수만 조회·수백 댓글을 터뜨리는 카피라이터다. 아래 영상 소재로 스레드 글을 써라.
${base}

★이건 '스레드' 글이다 — 인스타 캡션(해시태그 떡칠)과 완전히 다르다:
- 스레드는 '텍스트가 본체'인 대화 플랫폼. 트위터처럼 솔직하고 대화하듯 써라.
- 전체 500자 이내(짧을수록 좋다). 첫 문장에 핵심·훅을 다 걸어라(첫 문장에서 안 멈추면 끝이다).
- 해시태그 떡칠 절대 금지(스레드에선 독이다). 써도 딱 1개까지, 안 써도 된다.
- 반드시 '댓글 부르는 질문'으로 끝내라(의견 갈리게/경험 묻게). 댓글이 노출을 결정한다.
- 이모지 절제(0~2개). 광고·정보 나열 톤 금지, 진짜 사람 말투.
JSON만 출력: {"hook":"첫 문장(강한 훅)","blocks":["짧은 문장 1~2개(배열)"],"question":"댓글 부르는 질문 한 줄","hashtag":"선택: 태그 1개(# 없이) 또는 빈 문자열"}`;
  }

  if (platform === 'facebook') {
    return `너는 '페이스북'에서 공유·댓글이 터지는 카피라이터다. 아래 영상 소재로 페이스북 글을 써라.
${base}

★이건 '페이스북' 글이다:
- 480자 내외의 '스토리텔링'. 공감 가는 상황·감정으로 이야기하듯. 짧은 문단을 빈 줄로 띄워 읽기 쉽게.
- 첫 줄에 강한 공감·호기심 훅. 끝에 공유·의견을 자연스럽게 유도.
- 해시태그는 1~2개만(페북은 해시태그 효과가 작다). 이모지는 적당히.
JSON만 출력: {"hook":"첫 줄 훅","blocks":["짧은 문단 2~3개(배열)"],"hashtags":["핵심 태그 1~2개(# 없이)"]}`;
  }

  // instagram (기본)
  return `너는 인스타그램 릴스로 수십만 조회를 터뜨리는 바이럴 카피라이터다. 사람들이 "헉 완전 내 얘기", "이거 저장!" 하며 공감·댓글·태그하는 릴스 캡션을 만들어라.
${base}

★이건 '인스타' 캡션이다 — 유튜브처럼 정보 나열 말고, 친구한테 썰 푸는 것처럼 '재미있고 생생하게'. 모바일로 '술술' 읽히게 짧은 "블록"으로 쪼개고 블록 사이는 빈 줄. 이모지로 리듬(과하지 않게).

규칙:
- hook: 첫 줄. 스크롤 멈추는 강한 공감+떡밥 한 문장. '이 영상의 실제 소재'로 콕 집어 "헉 내 얘기" 싶게. 이모지 1~2개. 거짓 낚시 금지.
- blocks: 3~5개 짧은 블록(배열). 1번=강한 공감·몰입(구체적 상황·감정·장면), 중간=반전·웃음·궁금증 증폭(밋밋한 요약 금지), 마지막=댓글 부르는 질문 1개 + "저장각/친구 소환" 유도. 썰 푸는 구어체.
- hashtags: 이 영상 소재에 맞는, 인스타에서 잘 노출되는 '핵심' 해시태그 딱 5개(과거 30개는 구식 — 5개가 노출에 더 좋다). 초대형 트렌드 1개 + 주제 핵심 + 틈새 믹스. # 없이 배열, 공백 없는 단어.
JSON만 출력: {"hook":"...","blocks":["...","..."],"hashtags":["...(핵심 5개)"]}`;
}

export async function generateCaption(
  keys: {gemini: string[]; openai?: string},
  title: string,
  narrations: string[],
  platform: CaptionPlatform = 'instagram',
): Promise<string> {
  const body = narrations.join(' ').slice(0, 1500);
  const prompt = buildCaptionPrompt(platform, title, body);
  // ★AI가 고온도에서 깨진 JSON(문자열 안 잘못된 이스케이프 등)을 뱉으면 JSON.parse가 "Bad escaped character"로
  //   터져 캡션 생성 '전체'가 실패하던 문제 → 재시도(저온도) + 깨진 이스케이프 정리 + 최후 폴백(제목 기반).
  const parseLoose = (s: string): any => {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('JSON 형태 아님');
    let t = m[0];
    try { return JSON.parse(t); } catch {}
    t = t.replace(/\\(?!["\\/bfnrtu])/g, '');
    return JSON.parse(t);
  };
  let d: any = null;
  for (let attempt = 0; attempt < 3 && !d; attempt++) {
    let raw = '';
    if (keys.gemini.length) {
      try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 1024, temperature: attempt === 0 ? 1.0 : 0.5}); } catch {}
    }
    if (!raw && keys.openai) { try { raw = await openaiJson(keys.openai, prompt, 1024); } catch {} }
    if (!raw) continue;
    try { d = parseLoose(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')); } catch {}
  }
  if (!d) d = {}; // 끝까지 실패 → 제목 기반 최소 캡션으로 폴백(발송은 되게)
  const hook = String(d.hook || title).trim();
  const blocks = Array.isArray(d.blocks)
    ? d.blocks.map((x: any) => String(x).trim()).filter(Boolean)
    : (d.body ? [String(d.body).trim()] : []);

  // 스레드: 500자 이내, 끝에 질문, 해시태그 0~1개(떡칠 금지).
  if (platform === 'threads') {
    const q = String(d.question || '').trim();
    const tag = String(d.hashtag || '').replace(/^#+/, '').replace(/\s+/g, '');
    const out = [hook, ...blocks, q].filter(Boolean).join('\n\n');
    return (tag ? `${out}\n\n#${tag}` : out).slice(0, 490);
  }

  // 인스타(해시태그 5)·페북(해시태그 2): 훅 / 블록(빈 줄) / 해시태그 한 줄.
  const maxTags = platform === 'facebook' ? 2 : 5;
  const tags = Array.isArray(d.hashtags)
    ? [...new Set(d.hashtags.map((x: any) => '#' + String(x).replace(/^#+/, '').replace(/\s+/g, '')).filter((t: string) => t.length > 1))].slice(0, maxTags)
    : [];
  const limit = platform === 'facebook' ? 1800 : 2200;
  return [hook, ...blocks, tags.join(' ')].filter(Boolean).join('\n\n').slice(0, limit);
}

// 영상 게시. kind는 과거 호환용(reels/feed)이지만 실제로는 둘 다 REELS로 올린다.
// videoUrl = 공개 접근 가능한 영상 URL(R2 presigned). caption = 글.
//   🔴🔴2026: media_type=VIDEO(피드 영상)는 Meta가 폐기(subcode 2207067 "VIDEO value for media_type is
//     deprecated. Use the REELS media type to publish a video to your Instagram feed."). 가로/세로 상관없이
//     모든 영상은 REELS로 올려야 하며, share_to_feed=true면 피드에도 노출된다(가로 영상도 그대로 올라감).
export async function publishVideo(
  videoUrl: string, caption: string, kind: 'reels' | 'feed', log?: (m: string) => void, coverUrl?: string, accountId?: string,
): Promise<{permalink: string; id: string}> {
  const c = getInstagram(accountId);
  if (!c || !c.igUserId || !c.accessToken) throw new Error('인스타가 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const base = host(c);
  const token = c.accessToken;

  // 1) 미디어 컨테이너 생성 — 가로/세로 모두 REELS(VIDEO 폐기). share_to_feed로 피드에도 노출.
  log?.(`[인스타] 업로드 컨테이너 생성 중…(${kind === 'feed' ? '가로 영상 → 피드(REELS)' : '릴스 세로'})`);
  const createParams: Record<string, string> = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption.slice(0, 2200),
    share_to_feed: 'true', // 릴스를 피드에도 노출(가로 영상도 피드에 게시됨)
    access_token: token,
  };
  // ★커버(썸네일) 지정 — 없으면 IG가 영상 0프레임(어두운 빈 화면)을 집어가 미리보기가 빈다. REELS에서 유효.
  if (coverUrl) createParams.cover_url = coverUrl;
  const createBody = new URLSearchParams(createParams);
  const cr = await fetch(`${base}/${API}/${c.igUserId}/media`, {method: 'POST', body: createBody});
  const cd: any = await cr.json();
  if (!cr.ok || !cd.id) {
    const e = cd?.error || {};
    const detail = [e.message, e.error_user_title, e.error_user_msg, e.error_subcode && ('subcode ' + e.error_subcode)]
      .filter(Boolean).join(' | ') || JSON.stringify(cd).slice(0, 300);
    throw new Error('컨테이너 생성 실패: ' + detail);
  }
  const creationId = cd.id;

  // 2) 영상 처리 대기(릴스는 인코딩 시간 필요). status_code=FINISHED까지 폴링(최대 5분).
  //   ★일시적 네트워크/JSON 에러엔 안 죽고 계속 폴링(간헐 실패 방지).
  log?.('[인스타] 영상 처리 대기 중… (릴스 인코딩)');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const sr = await fetch(`${base}/${API}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const sd: any = await sr.json();
      if (sd.status_code === 'FINISHED') break;
      if (sd.status_code === 'ERROR') throw new Error('인스타 영상 처리 실패: ' + (sd.status || ''));
      if (i % 4 === 0) log?.(`[인스타] 처리 중… (${sd.status_code || '대기'})`);
    } catch (e: any) {
      if (/처리 실패/.test(e?.message || '')) throw e; // 진짜 ERROR는 중단
      if (i % 4 === 0) log?.('[인스타] 상태 확인 일시 오류 — 재시도');
    }
    if (i === 59) throw new Error('인스타 영상 처리가 너무 오래 걸립니다. 잠시 후 다시 시도하세요.');
  }

  // 3) 게시 — ★FINISHED 직후에도 간헐적으로 "아직 준비 안됨"(code 9007 등)이 뜸 → 재시도+백오프.
  log?.('[인스타] 게시 중…');
  const pd: any = await publishWithRetry(base, c.igUserId, creationId, token, log);

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

// 카드 게시물(캐러셀) 게시 — 이미지 2~10장. ★인스타 API는 JPEG만 허용(PNG 거부)하므로 imageUrls는
// 반드시 JPEG 공개 URL(R2 presigned)이어야 한다. 자식 컨테이너(is_carousel_item)→CAROUSEL 부모→publish.
export async function publishCarousel(
  imageUrls: string[], caption: string, log?: (m: string) => void, accountId?: string,
): Promise<{permalink: string; id: string}> {
  const c = getInstagram(accountId);
  if (!c || !c.igUserId || !c.accessToken) throw new Error('인스타가 연결되지 않았습니다. 키 설정에서 연결하세요.');
  const base = host(c); const token = c.accessToken;
  const urls = imageUrls.filter(Boolean).slice(0, 10);
  if (urls.length < 2) throw new Error('캐러셀은 이미지가 2장 이상이어야 합니다.');

  // 1) 이미지별 자식 컨테이너.
  const childIds: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    log?.(`[인스타] 캐러셀 이미지 ${i + 1}/${urls.length} 등록 중…`);
    const cr = await fetch(`${base}/${API}/${c.igUserId}/media`, {
      method: 'POST',
      body: new URLSearchParams({image_url: urls[i], is_carousel_item: 'true', access_token: token}),
    });
    const cd: any = await cr.json();
    if (!cr.ok || !cd.id) throw new Error(`이미지 ${i + 1} 등록 실패: ` + (cd?.error?.message || JSON.stringify(cd).slice(0, 160)));
    childIds.push(cd.id);
  }

  // 2) CAROUSEL 부모 컨테이너(캡션은 부모에만).
  log?.('[인스타] 캐러셀 묶는 중…');
  const pr = await fetch(`${base}/${API}/${c.igUserId}/media`, {
    method: 'POST',
    body: new URLSearchParams({media_type: 'CAROUSEL', children: childIds.join(','), caption: caption.slice(0, 2200), access_token: token}),
  });
  const pd: any = await pr.json();
  if (!pr.ok || !pd.id) throw new Error('캐러셀 묶기 실패: ' + (pd?.error?.message || JSON.stringify(pd).slice(0, 160)));

  // 2.5) 부모 컨테이너 처리 대기(FINISHED). 일시 오류엔 안 죽고 계속.
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const sr = await fetch(`${base}/${API}/${pd.id}?fields=status_code&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
      const sd: any = await sr.json();
      if (sd.status_code === 'FINISHED') break;
      if (sd.status_code === 'ERROR') throw new Error('캐러셀 처리 실패(인스타).');
    } catch (e: any) { if (/처리 실패/.test(e?.message || '')) throw e; }
  }

  // 3) 게시 — 간헐 "준비 안됨" 재시도+백오프.
  log?.('[인스타] 게시 중…');
  const pubd: any = await publishWithRetry(base, c.igUserId, pd.id, token, log);

  let permalink = '';
  try {
    const lr = await fetch(`${base}/${API}/${pubd.id}?fields=permalink&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const ld: any = await lr.json(); permalink = ld.permalink || '';
  } catch {}
  log?.('[인스타] 캐러셀 게시 완료!');
  return {permalink, id: pubd.id};
}

// 60일 long-lived 토큰을 ig_refresh_token으로 갱신(또 60일 연장). Instagram 로그인(graph.instagram.com) 토큰만 가능.
// ★멀티계정: 한 계정만 갱신. accountId 없으면 첫 계정.
export async function refreshInstagram(log?: (m: string) => void, accountId?: string): Promise<boolean> {
  const c = getInstagram(accountId);
  if (!c || !c.accessToken || c.base === 'facebook') return false;
  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.accessToken)}`,
      {cache: 'no-store'},
    );
    const d: any = await r.json();
    if (r.ok && d.access_token) {
      patchInstagram(c.id, {accessToken: d.access_token, tokenSavedAt: Date.now()});
      log?.(`[인스타] 토큰 자동 갱신 완료 (${c.label || c.username || c.id}, +${Math.round((d.expires_in || 0) / 86400)}일)`);
      return true;
    }
    log?.('[인스타] 토큰 갱신 건너뜀: ' + (d?.error?.message || JSON.stringify(d).slice(0, 150)));
  } catch (e: any) { log?.('[인스타] 토큰 갱신 오류: ' + e.message); }
  return false;
}

// 토큰 나이를 보고 필요할 때만 갱신(45일↑) — ★전 계정 루프. FB방식/만료기록 없는 건 건너뜀.
export async function maybeRefreshInstagram(log?: (m: string) => void): Promise<void> {
  for (const c of listInstagram()) {
    if (!c.accessToken || !c.igUserId || c.base === 'facebook') continue;
    if (!c.tokenSavedAt) { patchInstagram(c.id, {tokenSavedAt: Date.now()}); continue; }
    const ageDays = (Date.now() - c.tokenSavedAt) / 86400000;
    if (ageDays >= 45) await refreshInstagram(log, c.id);
  }
}

// 업로드 현황: 인스타에 실제로 올라간 시각(media timestamp) 기준으로
// "오늘(한국시간) 몇 개 · 마지막 게시 시각 · 총 개수"를 반환. 업로드 페이스 모니터용.
export async function getUploadActivity(accountId?: string): Promise<{today: number; lastAt: string | null; total: number; followers?: number; error?: string}> {
  const accounts = accountId ? [getInstagram(accountId)].filter(Boolean) as InstagramAccount[] : listInstagram();
  if (!accounts.length) return {today: 0, lastAt: null, total: 0, error: '연결 안 됨'};
  let today = 0, total = 0, followers = 0; let lastAt: string | null = null; let error: string | undefined;
  for (const c of accounts) {
    const one = await igActivityForAccount(c);
    today += one.today; total += one.total; followers += one.followers || 0;
    if (one.lastAt && (!lastAt || one.lastAt > lastAt)) lastAt = one.lastAt;
    if (one.error && !error) error = one.error;
  }
  return {today, lastAt, total, followers, ...(error ? {error} : {})};
}
async function igActivityForAccount(c: InstagramAccount): Promise<{today: number; lastAt: string | null; total: number; followers?: number; error?: string}> {
  const base = host(c), token = c.accessToken!;
  // 팔로워 수(계정 프로필) — 미디어 목록과 별개로 조회.
  let followers: number | undefined;
  try {
    const fr = await fetch(`${base}/${API}/${c.igUserId}?fields=followers_count&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const fd: any = await fr.json();
    if (fr.ok) followers = Number(fd?.followers_count ?? 0);
  } catch {}
  try {
    const r = await fetch(`${base}/${API}/${c.igUserId}/media?fields=id,timestamp&limit=100&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
    const d: any = await r.json();
    if (!r.ok) return {today: 0, lastAt: null, total: 0, followers, error: d?.error?.message || `API 오류(${r.status})`};
    const times: string[] = (d.data || []).map((m: any) => m.timestamp).filter(Boolean).sort().reverse();
    const kstDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'}); // YYYY-MM-DD
    const todayKst = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'});
    const today = times.filter((t) => kstDay(t) === todayKst).length;
    return {today, lastAt: times[0] || null, total: times.length, followers};
  } catch (e: any) { return {today: 0, lastAt: null, total: 0, followers, error: e.message}; }
}

// 성과 추적: 내 인스타 미디어의 조회수·좋아요·댓글을 permalink 키로 반환.
// 좋아요/댓글은 미디어 목록 fields로 1콜(확실), 조회수(릴스 재생)는 미디어별 insights(views).
// diag(옵션): 진단 로그 배열을 넘기면 Meta API 실제 응답/에러를 담아준다(삼키지 않음). debug=1 용.
export type InstaStat = {views: number; likes: number; comments: number; saved: number; shares: number; reposts: number; reach: number; interactions: number};
export async function getInstaStats(
  diag?: string[],
): Promise<Record<string, InstaStat>> {
  const byPermalink: Record<string, InstaStat> = {};
  const accounts = listInstagram();
  if (!accounts.length) { diag?.push('연결 안 됨: 계정 없음'); return byPermalink; }
  for (const c of accounts) await igStatsForAccount(c, byPermalink, diag);
  return byPermalink;
}
async function igStatsForAccount(c: InstagramAccount, byPermalink: Record<string, InstaStat>, diag?: string[]): Promise<void> {
  const base = host(c), token = c.accessToken!;
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
  // 2) 각 미디어 insights — 공식 media insights 전 지표(조회수·도달·저장·공유·리포스트·총상호작용).
  //    좋아요/댓글은 미디어 목록 fields가 확실해 그걸 쓰고, insights는 나머지를 채운다.
  //    reposts는 2026.9 신설 metric·reach/total_interactions는 미디어 타입에 따라 미지원일 수 있어
  //    큰 세트→중간→views 순으로 단계 폴백(일부 미지원으로 전체 400 나도 나머지는 살림). insights 권한=instagram_business_manage_insights.
  type Ins = {views: number; saved: number; shares: number; reposts: number; reach: number; interactions: number};
  const parseIns = (data: any): Ins => {
    const out: Ins = {views: 0, saved: 0, shares: 0, reposts: 0, reach: 0, interactions: 0};
    for (const row of (data?.data || [])) {
      const v = Number(row?.values?.[0]?.value ?? row?.total_value?.value ?? 0);
      switch (row.name) {
        case 'views': out.views = v; break;
        case 'saved': out.saved = v; break;
        case 'shares': out.shares = v; break;
        case 'reposts': out.reposts = v; break;
        case 'reach': out.reach = v; break;
        case 'total_interactions': out.interactions = v; break;
      }
    }
    return out;
  };
  const METRIC_SETS = ['views,reach,saved,shares,reposts,total_interactions', 'views,saved,shares', 'views'];
  let insightNoted = false;
  for (const m of media) {
    let ins: Ins = {views: 0, saved: 0, shares: 0, reposts: 0, reach: 0, interactions: 0};
    try {
      for (let si = 0; si < METRIC_SETS.length; si++) {
        const ir = await fetch(`${base}/${API}/${m.id}/insights?metric=${METRIC_SETS[si]}&access_token=${encodeURIComponent(token)}`, {cache: 'no-store'});
        const idata: any = await ir.json();
        if (ir.ok) { ins = parseIns(idata); break; }
        if (si === METRIC_SETS.length - 1 && !insightNoted) { const err = idata?.error || idata; diag?.push(`⚠️ insights 실패 HTTP ${ir.status} (code=${err?.code ?? '?'}): ${String(err?.message || JSON.stringify(err)).slice(0, 300)}`); insightNoted = true; }
      }
    } catch (e: any) { if (!insightNoted) { diag?.push(`⚠️ insights 예외: ${e.message}`); insightNoted = true; } }
    if (m.permalink) byPermalink[m.permalink] = {views: ins.views, likes: m.likes, comments: m.comments, saved: ins.saved, shares: ins.shares, reposts: ins.reposts, reach: ins.reach, interactions: ins.interactions};
  }
}
