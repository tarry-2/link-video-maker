// 대본 생성 — 링크 본문 → 기승전결 서사 쇼츠 대본(JSON). Gemini 우선, 없거나 실패 시 OpenAI 폴백.
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';
import type {Preset} from './presets';
import {getStyle, stylePeopleWelcome} from './styles';

export type StoryScene = {
  narration: string; // 나레이션(음성으로 읽힘)
  hookTop: string; // 상단 후킹 1줄(흰색, 셋업)
  hookAccent: string; // 상단 후킹 2줄(강조색, 펀치)
  accentColor: string; // 이 장면 강조색 hex
  visualPrompt: string; // 이미지 생성용(영어)
  characters?: string[]; // ★이 장면에 등장하는 cast 이름들(서사형). 캐릭터 시트 참조·일관성에 쓰인다. 없으면 빈 배열.
  shot?: string; // ★카메라 샷(wide establishing / medium / close-up / dramatic low-angle 등) — 짜깁기 방지·연출 다양화
  comment?: {user: string; text: string; likes: string}; // 인기 쇼츠식 가짜 댓글(선택)
};

// ★등장인물(cast) — 서사형(동화·드라마·사건 등 사람·캐릭터가 반복 등장)일 때만 채운다. 단일 소재(음식·제품·장소)면 빈 배열.
//   look=영어 외형 묘사(얼굴·머리·의상·색). '모든 장면에서 똑같은 단어로' 재사용해 캐릭터가 장면마다 딴사람이 되는 것(짜깁기 느낌)을 막는다.
export type CastMember = {name: string; look: string};

// ★나레이션 끝맺음 정규화: 끝의 쉼표/세미콜론/공백을 정리하고 종결부호가 없으면 마침표를 붙인다.
// 여운 마무리가 "챙겨보세요," 처럼 쉼표로 끊기던 버그 방지(TTS·자막 둘 다 이 텍스트에서 나오므로 여기서 고침).
export function normalizeEnding(text: string): string {
  let t = (text || '').trim();
  if (!t) return t;
  t = t.replace(/[,，;；\s]+$/g, ''); // 끝의 쉼표(반각/전각)·세미콜론·공백 제거
  if (!/[.!?…~。！？]$/.test(t)) t += '.'; // 종결부호 없으면 마침표
  return t;
}

// ★화면 지문·효과음 제거 — narration은 '귀로 들려줄 말(대사·나레이션)'만 담아야 한다.
//   "(문이 천천히 열린다)", "[효과음: 쾅]", "효과음: ~", "지문: ~" 같은 게 섞이면 TTS가 그대로 읽어
//   "대사 아닌 효과·상황까지 읽는" 문제가 된다(테리 핵심 지적). 음성·자막 둘 다 narration을 쓰므로 여기서 정제.
//   ※괄호 없는 상황 서술("문이 열린다")은 여기서 못 잡으니 대본 프롬프트에서 막는다(상호 보완).
export function stripStageDirections(text: string): string {
  return (text || '')
    .replace(/\([^)]*\)/g, ' ')      // (지문)
    .replace(/\[[^\]]*\]/g, ' ')     // [지문]
    .replace(/（[^）]*）/g, ' ')      // 전각 ( )
    .replace(/【[^】]*】/g, ' ')      // 전각 [ ]
    // 줄머리 지문 레이블(효과음:/지문:/나레이션:/해설: 등) 제거
    .replace(/^\s*(효과음|음향|음악|배경음|BGM|SFX|지문|나레이션|내레이션|해설|자막|대사|장면|컷|씬|scene|sfx)\s*[:：]\s*/gim, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ★★행동 중계 '수식어' 결정적 필터(테리: 프롬프트 부탁 말고 코드 로직으로 확실히) — 서사형 narration에서
//   영상이 이미 보여주는 '동작 수식 부사·관용구'를 잘라낸다. 문장 뼈대·핵심 정보·대사는 보존(안전).
//   예: "노인이 조용히 종이를 내민다. 나는 순간 멈칫, 조심스럽게 받는다" → "노인이 종이를 내민다. 받는다"
//   ※ "노인이 종이를 내민다" 같은 문장 전체 제거는 자연어라 100% 불가(스토리 깨질 위험) → 수식어만 결정적으로.
const ACTION_MODIFIERS = new RegExp(
  '(' + [
    '순간\\s*멈칫[,\\s]*', '멈칫[,\\s]*', '조심스럽게\\s*', '조심스레\\s*', '천천히\\s*', '조용히\\s*',
    '가만히\\s*', '슬그머니\\s*', '슬쩍\\s*', '살며시\\s*', '살짝\\s*', '힐끗\\s*', '힐끔\\s*',
    '황급히\\s*', '재빨리\\s*', '지그시\\s*', '가늘게\\s*', '물끄러미\\s*', '멍하니\\s*',
    '숨을?\\s*(삼키며|죽이며|죽이고|멈추고|고르며)\\s*', '숨죽여\\s*', '숨죽이며\\s*',
    '고개를\\s*(끄덕이며|저으며|떨구며|들며|숙이며)\\s*', '눈을\\s*(감고|크게\\s*뜨고|질끈\\s*감고)\\s*',
    '손을\\s*(뻗어|떨며|모으고)\\s*', '입술을\\s*(깨물며|떨며)\\s*', '어깨를\\s*(움츠리며|들썩이며)\\s*',
  ].join('|') + ')', 'g');
export function stripActionModifiers(text: string): string {
  let t = (text || '').replace(ACTION_MODIFIERS, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?…])/g, '$1').replace(/([,.])\s*\1+/g, '$1').replace(/^[\s,.]+/, '').trim();
  return t;
}

// ★영상 자막·후킹·나레이션의 이모지 제거 — Remotion 폰트(Noto Sans KR/Black Han Sans)엔
//   이모지 글리프가 없어 두부(네모 ⊠)로 깨진다. 자막엔 이모지 금지(제목은 유튜브용이라 유지).
export function stripEmoji(text: string): string {
  return (text || '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')  // 이모지(그림문자) 전반
    .replace(/[\u{2600}-\u{27BF}]/gu, '')    // 기타 기호·딩뱃(날씨·체크 등)
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')    // 화살표·별 등
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')  // 국기
    .replace(/[︀-️‍⃣]/gu, '') // variation selector·ZWJ·keycap
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 후킹 윗줄(top)과 아랫줄(accent)이 같은 말을 반복하면 촌스럽다 → 겹치면 accent를 비운다.
export function dedupAccent(top: string, accent: string): string {
  const norm = (s: string) => (s || '').replace(/[\s.,!?~·…"'()\[\]]/g, '');
  const t = norm(top), a = norm(accent);
  if (!a) return '';
  if (a.length >= 2 && (t.includes(a) || a.includes(t))) return '';
  const toks = (accent || '').split(/\s+/).filter((w) => w.replace(/[^가-힣A-Za-z0-9]/g, '').length >= 2);
  if (toks.length && toks.every((w) => t.includes(norm(w)))) return '';
  return accent;
}

// ★후킹 강화 게이트 — 후킹이 '밋밋/보통'으로 나오는 걸 막고 "항상 90점 이상"으로 완전 고정(테리 지시).
//   후킹만 따로 재작성 + self-score(0~100). 90점 미만이면 "이건 N점이다, 더 세게" 피드백 주며 다시 쓰기(최대 3회).
//   3회 후에도 90 미만이면 '그때까지 제일 센 버전'을 박는다(완전 찍어놓기 = 최선 고정). 각 후킹은 장면 '내용'에 근거.
export async function intensifyHooks(
  geminiKeys: string[],
  items: {hookTop: string; hookAccent: string; context: string}[],
  log?: (m: string) => void,
): Promise<{hookTop: string; hookAccent: string}[]> {
  const best = items.map((i) => ({hookTop: i.hookTop, hookAccent: i.hookAccent, score: 0}));
  if (!geminiKeys.length || !items.length) return best.map((b) => ({hookTop: b.hookTop, hookAccent: b.hookAccent}));
  const TARGET = 90;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const weak = best.map((b, i) => (b.score < TARGET ? i : -1)).filter((i) => i >= 0);
    if (!weak.length) break; // 전부 90+면 종료
    const payload = weak.map((i) => ({i, 현재후킹: `${best[i].hookTop} / ${best[i].hookAccent}`, 현재점수: best[i].score, 내용: (items[i].context || '').slice(0, 140)}));
    const prompt = `너는 조회수가 터지는 한국 유튜브·릴스 쇼츠의 '후킹' 심사관이자 작가다. 아래 후킹들은 ${TARGET}점 미만(밋밋/평범)이라 탈락이다.
각각을 '첫 1초에 스크롤을 멈추게 하는 ${TARGET}점 이상 후킹'으로 다시 쓰고, 네가 쓴 결과에 냉정하게 점수(0~100)를 매겨라.
조회수의 90%가 이 후킹에서 갈린다. 지금보다 무조건 더 세게.

[강한 후킹 공식 — 가장 꽂히는 하나를 골라 세게]
① 충격 숫자·구체("단 3일 만에","99%가 모르는") ② 반전·의외("알고 보니 정반대") ③ 금지·경고("절대 하지 마세요") ④ 정보격차("아무도 안 알려준") ⑤ 직격 질문("왜 당신만 안 될까?")

[점수 기준 — 냉정하게]
90+ = 나도 모르게 멈추고 끝까지 보게 됨(진짜 강한 것만). 70~89 = 괜찮지만 평범. 70 미만 = 밋밋/탈락.

[규칙]
- 각 후킹의 '내용'에 근거(없는 사실 지어내기 금지, 과장 OK·거짓 금지).
- hookTop=긴장 셋업(10~16자), hookAccent=다른 단어의 펀치(6~12자). ★두 줄에 같은 단어 반복 금지.
- '대박·레전드·충격·실화ㄷㄷ' 상투어 남발 금지 — 소재에 꽂히는 구체적인 말로.
- 한국어로만.

입력(JSON): ${JSON.stringify(payload)}
출력 JSON만: {"hooks":[{"i":0,"hookTop":"...","hookAccent":"...","score":92}]}`;
    try {
      const raw = await geminiGenerate(geminiKeys, prompt, {json: true, maxTokens: 1200, temperature: attempt === 1 ? 1.0 : 1.15, log});
      const m = raw.match(/\{[\s\S]*\}/);
      const d: any = m ? JSON.parse(m[0]) : {};
      const arr: any[] = Array.isArray(d.hooks) ? d.hooks : [];
      for (const r of arr) {
        const idx = Number(r.i);
        if (!(idx >= 0 && idx < best.length)) continue;
        const top = stripEmoji(String(r.hookTop || '')).trim();
        if (!top || !/[가-힣]/.test(top)) continue; // 한글 후킹만 채택
        const acc = dedupAccent(top, stripEmoji(String(r.hookAccent || '')).trim());
        const score = Math.max(0, Math.min(100, Number(r.score) || 0));
        if (score >= best[idx].score) best[idx] = {hookTop: top, hookAccent: acc, score}; // 더 센 버전만 채택
      }
    } catch (e: any) {
      log?.('[후킹강화] 시도 ' + attempt + ' 실패: ' + (e?.message || '').slice(0, 50));
      break;
    }
  }
  log?.('[후킹강화] 최종 점수: ' + best.map((b) => b.score).join('/') + ' (목표 90+)');
  return best.map((b) => ({hookTop: b.hookTop, hookAccent: b.hookAccent}));
}

export type ThumbText = {big: string; small: string; badge: string};
export type Storyboard = {
  title: string;
  subject: string; // ★단일 소재형 핵심 소재(영어) — 음식·제품·장소처럼 캐릭터 없는 영상에서 모든 장면에 일관 반영(예: "soy sauce fried rice with egg"). 서사형이면 "".
  cast?: CastMember[]; // ★서사형 등장인물(없으면 단일 소재형). 난쟁이·새어머니 같은 조연까지 전부 담겨 장면 이미지에 등장한다.
  musicPrompt: string; // BGM 무드(영어)
  thumb?: ThumbText; // 썸네일 전용 시선폭탄 문구(없으면 후킹에서 폴백)
  scenes: StoryScene[];
};

const PALETTE = '노랑 #FFE24B, 청록 #4FE0D0, 코랄 #FF6B5E, 라임 #B6FF3C, 핑크 #FF7EB6';

export async function generateStoryboard(
  geminiKeys: string[],
  source: string,
  opts: {
    duration: number;
    purpose?: string;
    preset?: Preset; // ★카테고리 프리셋(있으면 톤·후킹·마무리를 이걸로)
    imageStyle?: string; // ★사용자가 고른 아트스타일 id(visualPrompt를 이 스타일에 맞게 생성)
    sceneCount?: number; // ★사용자가 장면(이미지) 수를 직접 지정(0/미지정=길이로 자동). 2~12.
    orientation?: 'portrait' | 'landscape'; // ★방향 강제(지정되면 길이 무관). 없으면 길이로 자동.
    creative?: boolean; // ★창작 탭: source를 '사실 자료'가 아니라 '창작 의뢰(장르·키워드)'로 보고 오리지널 픽션 시나리오를 쓴다.
    seriesBible?: string; // ★시리즈: 세계관·인물·전체 아크(스토리 바이블). 있으면 이 편이 그 설정을 지키며 이어지게.
    episode?: number; // ★시리즈: 지금 몇 편(1부터).
    episodesTotal?: number; // ★시리즈: 전체 편 수.
    episodeLogline?: string; // ★시리즈: 이 편에서 벌어질 일(바이블의 해당 편 로그라인).
    openaiKey?: string;
    preferOpenAI?: boolean; // ★고급 대본 토글: 유료 GPT(gpt-4.1)를 '주 집필자'로. 끄면 무료 Gemini.
    log?: (m: string) => void;
  },
): Promise<Storyboard> {
  const duration = opts.duration;
  // ★화면비: orientation이 명시되면 그대로(세로 120초도 세로). 없으면 길이로 자동(롱폼≥90초=가로). 테리: 내가 세로 고르면 길이와 무관히 세로.
  const landscape = opts.orientation ? opts.orientation === 'landscape' : duration >= 90;
  const format = landscape ? '롱폼' : '쇼츠';
  const orient = landscape ? '가로(16:9, wide)' : '세로(9:16)';
  // 장면 수: 사용자가 직접 지정했으면(2~12) 그걸 쓰고, 아니면 길이로 자동 결정.
  const n = (opts.sceneCount && opts.sceneCount >= 2)
    ? Math.min(12, Math.max(2, Math.floor(opts.sceneCount)))
    : (duration <= 30 ? 4 : duration <= 60 ? 6 : Math.min(10, Math.ceil(duration / 12)));
  const perScene = Math.round((duration * 5.6) / n); // ★실측보정 5.6: dry-run으로 목표길이에 중심 맞춤(v4 통짜 rate 6.0자/초). "약 N자"만 지시(문장수 지시 금지=폭주). Gemini가 ±25% 널뛰어도 평균은 목표에 근접.

  // ★★길이 구간별 '이야기 구조 로직'(테리 지시 + 2026 쇼츠 리서치: 길이는 랭킹요소 아님, 완주율이 전부).
  //   → 길이에 맞는 '이야기 복잡도'를 써야 완주율이 산다. 복잡한 다단계 반전을 30초에 욱여넣으면 전개가 급해 망함(테리 실측).
  const storyMode: 'micro' | 'standard' | 'long' =
    duration <= 35 ? 'micro' : duration <= 60 ? 'standard' : 'long';
  // 각 구간 = 서사형(창작) 이야기 설계에 쓰는 '구조 지시'. 완주율 목표도 명시.
  const STORY_LOGIC: Record<typeof storyMode, string> = {
    // ~30초: 완주율 65%+ 필요. 마이크로스토리 = '반전 한 방'. 다단계·복잡 금지.
    micro: `[이야기 구조 — ${duration}초 초단편(마이크로스토리). ★완주율 65%+가 생명]
- 구조는 '기승전결'을 다 펼치지 마라. 딱 '세팅(2초) → 긴장 하나 → 반전 한 방(payoff)'으로 압축하라.
- ★반전은 '단 하나'만. 납치·10년·복수 같은 복잡한 다단계 전개를 30초에 욱여넣지 마라(전개가 급해 다 망한다). 단순하지만 강렬한 훅 하나를 끝까지 밀어라.
- 설명·여운을 길게 빼지 마라. 마지막은 충격·반전으로 '탁' 끊어 끝내라(완주 후 "뭐야?!" 하고 다시 보게).
- 첫 1~2초에 가장 센 떡밥. 뜸 들이는 도입 절대 금지.`,
    // 30~60초: 완주율 50%+. 기승전결 기본형 + 반전 1개 + 가벼운 복선.
    standard: `[이야기 구조 — ${duration}초 표준 쇼츠. ★완주율 50%+가 생명]
- 기-승-전-결 기본형. 반전은 '1개', 앞에 '가벼운 복선 하나'를 깔아 납득되게(갑툭 금지).
- 전개는 또렷하게, 매 장면 새 진전. 중간에 늘어지면 이탈한다 — 군더더기 0.
- 마지막은 반전의 여파 + 1번 질문에 답하며 그 장르 톤으로 닫는다.`,
    // 60초+: 완주율 50%+(더 어려움). 복잡한 다단계 반전·복선 여러 개 허용.
    long: `[이야기 구조 — ${duration}초 롱폼/숏드라마. ★몰입 설계가 생명]
- 복잡한 다단계 전개 가능(복선 여러 개, 반전 1~2개). 단 모든 장면은 하나의 로그라인에서 벗어나지 마라.
- 감정을 계단처럼 쌓아 후반에 정점, 복선을 회수해 "그래서 그랬구나"가 터지게.
- 길어도 늘어지면 죽는다 — 매 장면 끝을 다음이 궁금하게 끊어 완주율을 끌어라.`,
  };
  const storyLogic = STORY_LOGIC[storyMode];

  // ★★0패스(창작 전용) — 재창작은 '완성된 줄거리(실제 인기영상 자막)'를 소스로 받아 기승전결이 탄탄한데,
  //   창작은 장르·키워드 한 줄뿐이라 LLM이 맨땅에서 지어내다 '주제를 못 끌고 가고 기승전결이 무너진다'(테리 지적).
  //   → 창작도 재창작처럼 되게: 장면을 쓰기 전에 '완성된 줄거리(로그라인+기승전결 비트)'를 먼저 설계해 소스로 박는다.
  let workSource = source;
  const gk0 = geminiKeys.filter(Boolean);
  if (opts.creative && !opts.seriesBible && (gk0.length || (opts.preferOpenAI && opts.openaiKey))) {
    try {
      opts.log?.('[대본] 0패스 — 기승전결 줄거리부터 설계…');
      const outlinePrompt = `너는 한국 쇼츠 이야기 작가다. 아래 '창작 의뢰(장르·키워드)'로 ${duration}초 분량 ${n}장면짜리 영상의 '완성된 줄거리'를 설계하라. 지금은 대사·장면이 아니라 '뼈대'만 쓴다.

${storyLogic}

[반드시]
- 로그라인 1줄: "누가(주인공 1명) + 무엇을 원하는데 + 무슨 장애물로 + 어떤 위기"
- 그 로그라인 하나로 끝까지 간다. 의뢰의 핵심 주제·소재를 절대 벗어나지 마라.
- ★★위 '이야기 구조'를 이 길이(${duration}초)에 맞게 반드시 지켜라 — 30초인데 복잡한 다단계 반전을 넣으면 실패다.
- 장면 ${n}개 각각은 '앞 장면의 결과'로 이어지고(인과), 매 장면 새 진전이 있어야 한다(같은 상황 반복 금지).
- 마지막은 1번 장면에서 던진 질문·수수께끼에 답하며 '그 장르의 톤 그대로' 닫는다(공포·스릴러=서늘·충격 / 감동=뭉클). ★억지 희망·힐링 엔딩으로 분위기 뒤집기 금지, 뜬금없는 새 떡밥으로 끝내기 금지.
출력 JSON만: {"logline":"...","beats":["1장면: 한 줄","2장면: 한 줄", ... 정확히 ${n}개]}

[창작 의뢰]
${source.slice(0, 2000)}`;
      let raw0 = '';
      if (opts.preferOpenAI && opts.openaiKey) { try { raw0 = await openaiJson(opts.openaiKey, outlinePrompt, 1200, 'gpt-4.1'); } catch {} }
      if (!raw0 && gk0.length) raw0 = await geminiGenerate(gk0, outlinePrompt, {json: true, maxTokens: 1200, temperature: 0.9, log: opts.log});
      const m0 = raw0.match(/\{[\s\S]*\}/);
      const d0: any = m0 ? JSON.parse(m0[0]) : null;
      if (d0?.logline && Array.isArray(d0.beats) && d0.beats.length) {
        workSource = `${source}\n\n[이 줄거리를 '그대로' 따라 시나리오를 써라 — 로그라인과 장면 비트를 벗어나지 마라]\n로그라인: ${d0.logline}\n${d0.beats.map((b: any, i: number) => `${i + 1}. ${String(b).replace(/^\d+\s*장면\s*[:.]?\s*/, '')}`).join('\n')}`;
        opts.log?.('[대본] 0패스 완성 — 이 줄거리로 집필합니다.');
      }
    } catch (e: any) { opts.log?.('[대본] 0패스 건너뜀: ' + (e?.message || '').slice(0, 50)); }
  }

  const preset = opts.preset;
  const style = getStyle(opts.imageStyle); // 사용자가 고른 아트스타일(visualPrompt를 여기에 맞춤)
  const wantsPeople = stylePeopleWelcome(style); // 실사·시네마=절제 / 애니·칠판·UGC 등=사람·캐릭터 허용
  const isSell = preset
    ? preset.goal === 'sell'
    : /판매|세일|구매|홍보|광고|프로모/.test(opts.purpose || '');

  // ★프리셋 있으면 그 바닥 최적 톤/후킹/마무리, 없으면 목적별 기본.
  const toneGuide = preset
    ? preset.toneGuide
    : '몰입감 있고 자연스러운 구어체.';
  const hookRule = preset
    ? preset.hookStyle
    : isSell
      ? '후킹은 혜택·이득·손해를 찔러 욕구를 자극.'
      : '후킹은 호기심·의외의 사실을 예고.';
  const ctaGuard = `\n🚫 금지: "확인하세요", "찾아보세요", "알아보세요", "신청하세요", "검색해보세요" 처럼 시청자를 앱·링크·바깥으로 보내 무언가를 확인/검색하게 만드는 문구. 영상이 이미 정보를 다 줬으니 밖에서 확인하라고 미루지 마라.`;
  // ★마지막 장면은 '정보 끝'이 아니라 반드시 시청자를 향한 여운/감성 맺음말로 끝내야 한다(테리 강조).
  const closingLine = isSell
    ? ''
    : opts.creative
      // ★서사형 창작(드라마·공포·미스터리 등): '따뜻한 여운' 강제 금지 — 그 장르의 톤으로 닫아라.
      //   (예전엔 공포·스릴러도 억지로 "희망적·따뜻한" 엔딩이 돼 반전의 긴장이 김빠졌다, 테리 지적)
      ? `\n★★마지막 장면은 '이 이야기 장르의 톤 그대로' 닫아라. 공포·스릴러·미스터리면 끝까지 서늘하고 긴장되게(여운=소름·충격·불길함), 감동이면 뭉클하게, 복수극이면 통쾌·비장하게. ★억지로 "희망적·따뜻한·평화로운" 엔딩으로 분위기를 뒤집지 마라(공포로 달려놓고 마지막에 밝게 웃으며 끝내는 건 최악). 앞에서 쌓은 감정을 '배신하지 말고' 그 결로 마무리하라.`
      : `\n★★마지막 장면 narration은 절대 "~완성!", "~입니다" 같은 정보 서술로 끝내지 마라. 반드시 시청자를 향한 따뜻한 한 문장(여운/응원/권유)으로 맺어라.
   예) 음식→"오늘 이 한 그릇으로 맛도 건강도 챙겨보세요", 건강→"작은 습관 하나가 내일의 나를 바꿉니다", 여행→"다음 여행지는 여기로 정해보는 건 어떨까요".
   즉 마지막 문장은 정보가 아니라 '시청자에게 건네는 말'이어야 한다.`;
  // ★★★마무리가 영상 성패를 가른다(테리 최우선). 뜬금없는 엔딩 금지 — 앞 내용과 반드시 이어지게.
  const endingGuard = `\n★★★마무리는 이 영상에서 가장 중요하다. 반드시 앞에서 다룬 내용을 자연스럽게 매듭지어라. 앞에 안 나온 뜬금없는 새 소재·엉뚱한 말·주제와 동떨어진 문장으로 끝내면 절대 안 된다(가장 흔한 실패). 흐름상 앞 장면들과 자연스럽게 연결되고, 영상 전체의 핵심을 한 번 짚어준 뒤 여운으로 닫아라.
★★루프(매우 중요 — 쇼츠는 자동 반복된다): 마지막 narration은 '맨 처음 장면(hookTop)의 궁금증으로 자연스럽게 되돌아가게' 닫아라. 끝이 1번 장면 첫 마디와 매끄럽게 이어져 시청자가 자기도 모르게 다시 처음부터 보게 만들어라(시청 지속·반복이 조회수의 핵심). '끝·구독·좋아요' 같은 영상 밖 멘트로 끊지 마라(몰입·루프가 깨진다).`;
  const endingRule = (isSell
    ? '마지막 장면 = 구매·신청으로 이어지는 행동 유도 + 혜택 강조. 구매 욕구를 자극하며 맺는다.'
    : (preset?.endingStyle || '마지막 장면 = 주제의 핵심 메시지나 긍정적 실천 독려로 맺는다.') +
      closingLine +
      ctaGuard) + endingGuard;

  const catLine = preset ? `[카테고리] ${preset.label} (${preset.group})` : '';

  const intro = opts.creative
    ? `너는 수백만 조회수를 내는 한국의 이야기 작가다(장르 불문 — 드라마·미스터리·SF·판타지·다큐·역사 다 쓴다). 아래 '창작 의뢰'로 실제 자료 없이 완전히 새로운 '오리지널 픽션 시나리오'를 창작한다. 지어내도 된다(픽션). '한 편의 영화처럼 기승전결이 살아있고 끝까지 보게 되는' 한국어 ${orient} ${format} 시나리오를 JSON으로 쓴다.
★★★가장 중요: 아래 의뢰의 '핵심 주제·소재'를 반드시 그대로 지켜라. 주제가 미지의 세계·장소·현상·우주·자연이면 그 세계를 탐험·발견·파헤치는 이야기로, 인물 드라마면 인물 중심으로 써라. 의뢰 주제를 무시하고 틀에 박힌 복수·배신 막장극으로 흐르는 것은 최악의 실패다(제목·줄거리가 주제와 동떨어지면 안 된다).`
    : `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자이자 대본 작가다. 아래 자료로 '한 편의 영화처럼 기승전결이 있어 끝까지 보게 되는' 한국어 ${orient} ${format} 대본을 JSON으로 쓴다.`;
  const epLine = opts.episode && opts.episodesTotal
    ? `\n★지금은 전체 ${opts.episodesTotal}편 중 ${opts.episode}편이다.${opts.episode > 1 ? ' 앞 편들의 전개를 자연스럽게 이어받아라(1편부터 본 사람이 "그래서 이렇게 됐구나" 싶게).' : ' 1편이므로 세계관과 인물을 자연스럽게 소개하되, 초반 3초에 강한 훅으로 시작하라.'}${opts.episode < opts.episodesTotal ? ' 이 편은 반드시 다음 편이 미치도록 궁금한 클리프행어(결정적 순간/충격 폭로/위기)로 끊어라 — 절대 깔끔하게 마무리하지 마라.' : ' 마지막 편이므로 전체 시리즈를 감정적으로 매듭지어 큰 여운을 남겨라.'}${opts.episodeLogline ? `\n이 편에서 벌어질 일: ${opts.episodeLogline}` : ''}`
    : '';
  const prompt = `${intro}${opts.seriesBible ? `\n\n[시리즈 설정 — 반드시 지켜라(스토리 바이블)]\n이 영상은 시리즈의 한 편이다. 아래 세계관·인물·전체 줄거리를 '그대로' 지키며(인물 이름·성격·외형·관계·설정 유지), 이 편의 분량을 써라.${epLine}\n${opts.seriesBible.slice(0, 4000)}` : ''}

${catLine}
[화법·톤] ${toneGuide}
[목표] 총 ${duration}초, 장면 정확히 ${n}개.
🚫 정치·선거·종교·사회갈등·혐오·성적/폭력적 자극 등 민감한 주제·표현은 절대 쓰지 마라(안전한 콘텐츠만).
[★★★감성·몰입 — 모든 영상의 최우선 원칙(테리 못박음)]
이 영상은 '멍하게 시간 때우는 영상'이 아니라 '한 편을 끝까지 감상하는 작품'이어야 한다. 시청자가 스스로 주인공이 된 듯 동조·몰입하게, 영화·뮤지컬 한 편처럼 감정의 곡선(기대→긴장→고조→벅참/여운)을 설계하라.
- narration은 정보 나열이 아니라 '감정을 건드리는 이야기'로. 장면이 넘어갈수록 감정이 쌓이고, 중반에 울림(공감·놀라움·뭉클), 후반에 벅차오름이나 깊은 여운이 오게.
- 오감·심상을 자극하는 구체적 묘사와 '너/당신'을 향한 2인칭 호명으로 시청자를 장면 안으로 끌어들여라(관찰자가 아니라 당사자로).
- 주제와 분위기에 따라 톤을 바꿔라: 미스터리=서늘하고 신비롭게 심장 쫄깃, 감동=따뜻하게 벅차게, 정보=경쾌하고 똑부러지게. 소재에 맞는 '분위기'를 끝까지 유지하라.
${opts.creative ? `${storyLogic}

[★★★이야기 설계 — 가장 중요: '하나의 일관된 이야기'를 위 길이 구조에 맞게 짜라]
① 먼저 딱 한 줄 로그라인을 정하라: "누가(주인공 1명) + 무엇을 원하는데 + 무슨 장애물 때문에 + 어떤 위기에 빠진다". 모든 장면은 이 한 줄에서 절대 벗어나지 마라.
② 장르를 여러 개 받았어도 '각각 다른 이야기'로 쪼개지 마라 — 하나의 이야기에 섞는 '분위기 양념'일 뿐이다(예: 공포+반전+복수 → "반전 있는 공포 복수극" 하나). 여러 사건을 어거지로 욱여넣지 마라.
③ 장면 ${n}개를 기-승-전-결로 배치하라:
   · 기(발단, 1번 장면): 주인공과 상황을 0.5초에 세우고, '이상한 사건/신호'로 훅. 질문을 던진다.
   · 승(전개, 중반): 주인공이 파고들수록 단서·위기가 '쌓인다'. 매 장면이 앞 장면의 결과로 이어진다(원인→결과).
   · 전(반전·절정): ★여기서 반드시 예상을 뒤집는 '반전' 하나를 터뜨려라(믿었던 게 거짓/진짜 정체 폭로/상황이 정반대였음). 감정·긴장 최고조.
   · 결(해소, 마지막): 반전 뒤의 결말과 여운. 1번 장면의 질문에 답하며 닫되(루프), 설명이 아니라 감정의 잔상으로.
④ ★시청자가 "무슨 말인지 모르겠다"가 되면 완전한 실패다. 사건이 또렷하고(누가 뭘 왜 했는지) 인과가 분명해야 한다. 서로 무관한 장면 나열, 분위기만 잡고 사건이 없는 장면, 설명만 하는 장면 금지.

[대본 문장 규칙 — 이게 품질을 가른다. 반드시 지켜라]
- ★무엇보다 '쉽고 또렷하게': 한 번 듣고 바로 이해되는 문장만 써라. 어려운 말·추상어·빙빙 돌리기·현학적 표현 금지. 쉬우면서도 유치하지 않게. 시청자가 "무슨 말이지?" 하는 순간 그 장면은 실패다(네가 제일 경계할 것).
- 보여주되 '귀로 들을 말'로: "그는 무서웠다"(밋밋한 설명) 대신 느낌이 드러나게("목소리가 떨렸어"). 단 이건 화면 지문이 아니라 소리내어 읽을 대사·나레이션이어야 한다.
- 구체로: "신비로운 일이 생겼다"(추상) 금지. 눈·귀에 잡히는 구체로("녹슨 문이 삐걱 열렸어").
- 간결·리듬: 한 문장도 버릴 것 없이. 상투어('대박·레전드·충격 실화')·뻔한 교훈·같은 말 반복·군더더기 0.
- 막장 클리셰(출생의 비밀·불륜·흔한 복수극) 금지.
` : ''}[서사 구조 — 반드시 지켜라]
- 1번 장면 = 스크롤을 멈추게 하는 강렬한 훅. ${hookRule} 절대 평범하게 시작하지 마.
  ★★★첫 1초가 생사다(얼굴 안 나오는 영상은 더). 쇼츠 알고리즘은 '첫 1초에 스와이프하느냐'로 확산 여부를 1차 결정한다. 그래서:
   · 1번 장면 narration '첫 문장'은 인사·배경설명·"오늘은~"류 뜸들이기 절대 금지. 바로 가장 센 결론·충격·질문부터 때려라(패턴 인터럽트). 예 방식: 숫자 충격 / "왜 ○○는 ~할까?" / "이거 하나로 ~가 바뀝니다".
   · 1번 장면 narration은 다른 장면보다 더 짧고 빠르게 — 0.5초 안에 핵심 떡밥이 꽂혀야 한다.
   · 1번 장면의 visualPrompt도 가장 임팩트 강한 장면으로(정적인 설명 컷 금지). 첫 프레임부터 시선이 멈추게.
  ★★후킹 만드는 법(매우 중요, 조회수의 90%가 첫 3초에서 결정된다): 먼저 머릿속으로 서로 다른 후킹 후보를 3개 떠올려라 — (A)궁금증 갭("아무도 몰랐던 이것") (B)손해 회피("이거 모르면 손해") (C)숫자·반전 충격("단 3초면 끝"). 그중 이 소재에 가장 강력하게 꽂히는 하나만 골라 hookTop/hookAccent에 써라. 밋밋하면 실패다.
- ★★제목·주제의 약속을 반드시 지켜라(매우 중요): 제목/주제에 "N가지·N개·N단계"처럼 개수가 있으면 본문 narration에서 그 개수를 전부 다뤄라. '꿀팁 7개'라 해놓고 2~3개만 주고 끝내면 시청자를 배신하는 것이다. 장면(${n}개)이 모자라면 한 장면에 2~3개씩 묶어서라도 약속한 개수를 전부 담아라.
- ★★고유명사(실제 이름)를 반드시 밝혀라(매우 중요): 영상의 핵심 대상이 특정 장소·도시·나라·명소·인물·제품·작품이라면, 그 "실제 이름(고유명사)"을 hookTop 또는 늦어도 1~2번째 장면 narration에서 반드시 명시하라. "이곳·여기·그곳·이것"으로만 가리키고 정작 이름을 끝까지 안 밝히는 것은 최악이다(여행 영상인데 어느 도시인지 안 나오고, 맛집 영상인데 가게 이름이 없는 식). 시청자가 "그래서 어디?"라고 되묻게 만들지 마라. 장소라면 가능한 한 구체적으로(나라+도시+명소 이름까지).
- 중간 장면 = 정보를 쌓다가 '하지만/그런데' 같은 반전으로 긴장을 준다. 다음이 궁금하게 끊어라.
- ${endingRule}

[각 장면 필드]
- narration: 나레이션 한국어. ★★★절대규칙(가장 중요): narration엔 '소리내어 읽을 말(대사·나레이션)'만 써라. 괄호()·대괄호[]로 효과음·상황·동작·지문을 절대 넣지 마라("(문이 천천히 열린다)"·"[효과음: 쾅]"·"효과음:"·"지문:" 류 전부 금지). narration은 글자 그대로 TTS로 읽히므로, 지문을 넣으면 그 글자까지 전부 읽어버려 영상이 망가진다. ★장면당 약 ${perScene}자(공백 포함, 이 글자수를 꼭 지켜라 — 영상이 목표 ${duration}초에 맞아야 한다. 훨씬 짧거나 길면 안 됨). 정보를 빠르게 착착 밀어붙이는 다큐 나레이션 톤(지루할 틈 없이). 구어체, 몰입감. 숫자·핵심은 또렷하게.
  ★★내용의 질(매우 중요): 매 문장에 알맹이가 있어야 한다. 뻔한 말·빈말·같은 말 반복·당연한 소리 금지. 구체적인 숫자·방법·근거·실제 예시로 "오 이건 몰랐네" 싶게 만들어라. 두루뭉술("건강에 좋아요")하지 말고 구체적("하루 10분, 2주면 혈압이 눈에 띄게 떨어집니다")으로. 각 장면 끝은 다음이 궁금하게 끊어 완주율을 높여라.
  ★자연스럽게 이어 읽히게 써라(TTS가 로봇처럼 끊지 않도록): 느낌표(!)를 남발하지 마라(장면당 최대 1개). 짧은 단어를 "휘!휘!"처럼 느낌표로 뚝뚝 끊지 말고, "휘휘 돌려주면" 또는 "휘~ 휘~ 돌려주면"처럼 자연스러운 흐름으로. 의성어·의태어는 물결(~)이나 쉼표로 부드럽게 잇고, 딱딱한 감탄사 나열 금지.
  ★★★★인물 행동·동작 '중계' 절대 금지(서사/드라마형에서 가장 중요 — 테리가 5번 지적한 핵심 문제):
   나레이션에 '인물이 무엇을 하는지(동작·행동·표정·몸짓)'를 서술하지 마라. 그건 영상이 이미 보여주므로 말로 또 하면 자막만 넘치고 싸구려 해설이 된다.
   ★다음 같은 '행동 서술 문장'을 쓰지 마라(전부 금지):
    (❌)"노인이 조용히 종이 한 장을 내민다" (❌)"숨을 삼키며 노인을 힐끗 쳐다본다" (❌)"순간 멈칫한다" (❌)"조심스럽게 받는다" (❌)"목소리가 떨린다" (❌)"그녀가 뒤돌아본다" (❌)"문이 천천히 열린다" (❌)"창밖 구름을 보다가"
   → '~한다/~본다/~내민다/~받는다/~떨린다' 처럼 동작·행동을 묘사하는 문장으로 narration을 채우지 마라.
   ★대신 narration엔 '화면이 못 보여주는 것'만 담아라: ①인물이 소리내어 하는 대사("…") ②그 순간의 속마음·감정·결심 ③꼭 필요한 핵심 정보/반전. 그 외엔 넣지 마라(짧을수록 좋다).
   예: (❌)"노인이 종이를 내민다. 나는 멈칫, 조심스럽게 받는다. 무슨 종이지?" → (⭕)"낯선 노인이 건넨 종이 한 장. 그런데, 내 글씨였다."
   예: (❌)"숨을 삼키며 노인을 힐끗 본다. 목소리가 떨린다. '어디서 찾으셨어요?'" → (⭕)"어디서… 이걸 찾으셨어요?"
   (단, 음식·정보 같은 단일 소재형은 정보 전달 나레이션이 맞으니 이 규칙은 서사/드라마형에만 적용.)
- hookTop: 상단 후킹 첫 줄(흰색, 맥락/셋업). 공백 포함 12자 이내.
- hookAccent: 상단 후킹 둘째 줄(강조색, 펀치라인). 10자 이내. 임팩트 있게. ★hookTop에 이미 쓴 단어·표현을 '절대 반복하지 마라'(같은 말을 두 줄에 또 쓰면 촌스럽다). 윗줄이 셋업이면 아랫줄은 '다른 단어'로 결과·반전·감정을 터뜨려라(윗줄=상황, 아랫줄=그 결과/반전). ※이건 형식 규칙일 뿐이니 예시 소재를 실제 주제로 쓰지 말고, 반드시 이 영상 소재로 만들어라.
- accentColor: 이 장면 강조색 hex 하나. 장면마다 다르게 골라라(${preset ? preset.accentColors.join(', ') : PALETTE}) — 내용 분위기에 맞게.
- visualPrompt: 이미지 생성용 영어 프롬프트. ${landscape ? '16:9 landscape wide shot(가로 와이드 구도: 풍경·전경·넓은 현장을 담되 핵심 피사체는 중앙~좌우 3분할점에)' : '9:16 세로'}. 나레이션의 핵심 사물·장소·상황·행동을 구체적으로 묘사하라(피사체·구도·배경·조명 분위기). ★★화풍·매체 단어 절대 금지 — 'photo, photograph, realistic, illustration, anime, 3D, render, painting, cartoon, style' 같은 단어를 쓰지 마라. 비주얼 스타일은 렌더 단계에서 사용자가 고른 스타일("${style.name}")이 자동 적용된다. visualPrompt엔 "무엇이 어떻게 보이는지"(내용)만 담아라.
  ★★★스펙타클·몰입(매우 중요 — 조회수·체류시간의 핵심): 밋밋한 설명 컷을 그리지 마라. 매 장면이 '한 장만 봐도 멈칫'하는 영화 같은 한 컷이어야 한다. 반드시 (a) 극적인 조명(역광·황금빛·달빛·불빛 등 분위기), (b) 깊이감 있는 구도(전경-중경-배경, 원근), (c) 움직임·긴장이 느껴지는 '순간'(정지된 설명이 아니라 행동 한가운데 — 쫓기는 순간, 사과를 건네는 순간, 문이 열리는 순간)을 담아라. 스케일이 큰 장면(성·숲·군중·폭풍 등)은 광활하게.
  - shot 필드로 카메라를 장면마다 '다르게' 지정하라(연속 장면이 똑같은 구도면 짜깁기처럼 보인다): "wide establishing shot", "medium shot", "dramatic close-up on face", "low-angle hero shot", "over-the-shoulder" 중 장면 감정에 맞는 것. 1번 장면은 가장 임팩트 강한 샷으로.
${(wantsPeople || true) ? `  ★★등장인물 일관성(서사형에서 매우 중요): [등장인물 cast]가 있으면, 각 장면 visualPrompt 안에 '그 장면에 나오는 인물'을 cast에 적은 look(외형 묘사)을 '토씨까지 똑같이' 넣어 그려라. 예: 백설공주 이야기면 공주가 나오는 장면엔 매번 "a young princess with pale skin, short black hair, red lips, blue-and-yellow dress"를 반복해 넣어 장면마다 같은 사람으로 보이게. 조연(난쟁이들·새어머니·사냥꾼 등)도 등장하는 장면엔 반드시 그려 넣어라 — 나레이션에서만 언급하고 그림엔 안 나오면 안 된다(테리 지적: 난쟁이가 말로만 나옴). 그 장면에 나온 인물 이름을 characters 배열에 적어라.` : ''}
  ★단일 소재형(음식·제품·장소처럼 cast가 비어 있는 경우): 모든 장면 visualPrompt에 [핵심 소재 subject]를 영어로 명시해 같은 대상을 보여줘라(간장계란볶음밥이면 매 장면 볶음밥, 다른 음식 금지).
  ${wantsPeople
    ? '★주제에 어울리는 사람·캐릭터를 장면의 주인공으로 적극 등장시켜라(표정·행동이 드러나게).'
    : '★단일 소재형에서 사람(특히 얼굴·군중)은 절제하고 사물·장소·현장 위주. 단, 위 cast가 있는 서사형이면 인물을 적극 등장시켜라(이 절제 규칙보다 cast가 우선).'} ★글자·문서·표가 주요 피사체인 장면 금지. no text.
- characters(서사형): 이 장면에 등장하는 cast 이름 배열(예 ["백설공주","난쟁이들"]). 없으면 [].
- shot: 이 장면 카메라 샷(위 목록에서 하나, 영어).
- comment(선택): 4~6개 장면 중 딱 1개 장면에만, 인기 쇼츠에 흔한 가짜 시청자 댓글 {"user":"한국이름","text":"공감/놀람 한마디","likes":"4.2천"}.

[전체]
- title: 클릭하고 싶은 한국어 영상 제목.
- ★★먼저 이 영상이 '서사형'인지 '단일 소재형'인지 판단하라:
  · 서사형 = 동화·이야기·드라마·역사·사건처럼 사람/캐릭터가 반복 등장(예: 백설공주, 흥부놀부, 실화 사건). → cast를 채우고 subject는 "".
  · 단일 소재형 = 음식·제품·장소·정보처럼 반복 캐릭터가 없음. → subject를 채우고 cast는 [].
- cast: 서사형일 때 이 영상에 나오는 '모든' 주요·조연 인물의 목록. 각 {"name":"한국어 이름(예: 백설공주, 난쟁이들, 새어머니)","look":"영어 외형 묘사(얼굴·머리·의상·색·분위기, 장면마다 똑같이 재사용할 고정 묘사)"}. ★주인공만 넣지 말고 이야기에 중요한 조연(난쟁이·사냥꾼 등)을 빠짐없이 — 이들이 장면 그림에 실제로 등장해야 한다.
- subject: 단일 소재형의 핵심 소재를 영어로(예: "soy sauce fried rice with fried egg"). 서사형이면 "".
- musicPrompt: 이 영상의 '영화 사운드트랙'을 영어 한 줄로. 단순 장르가 아니라 감정 곡선·악기·분위기·전개를 담아라(시청자를 몰입시키는 BGM이 조회수·체류의 핵심 — 테리 강조). 예: 미스터리="cinematic mysterious orchestral score, soft eerie piano and pulsing low strings, building suspense with a haunting melody, emotional and immersive", 감동="warm uplifting orchestral and piano, gentle build to a soaring emotional swell, heartfelt and cinematic". 주제·분위기에 정확히 맞춰 매번 다르게. ★BGM 톤도 이야기 장르를 끝까지 지켜라 — 공포·스릴러면 끝까지 불안·긴장(마지막을 "hopeful/soothing/warm/uplifting"으로 풀어버리지 마라), 그 장르의 결로 닫아라.
- thumb: 썸네일(커버) 전용 문구. 영상 제목보다 훨씬 더 자극적이고 궁금해 미치게 만드는 "시선폭탄" 카피. 반드시 아래 3개:
   · big: 초대형으로 박을 핵심 한 방. 6~10자, 띄어쓰기로 2~3덩어리(예: "이거 먹지 마세요", "월 3만원 공짜", "90%가 모름"). 문장부호 최소, 완성문장 금지. 스크롤을 멈추게 할 가장 센 말.
   · small: big 위에 작게 깔 미끼 한 줄(10~16자). 대상을 콕 집어 공감·긴장(예: "의사들이 절대 안 먹는", "아침마다 붓는 사람").
   · badge: 충격 뱃지 한 단어(실화?/충격/경악/소름/대박 중 분위기 맞는 것). 판매성이면 "초특가", 아이용 애니면 빈 문자열.

반드시 아래 JSON만 출력(설명·마크다운 금지):
{"title":"...","subject":"...","cast":[{"name":"...","look":"..."}],"musicPrompt":"...","thumb":{"big":"...","small":"...","badge":"..."},"scenes":[{"narration":"...","hookTop":"...","hookAccent":"...","accentColor":"#FFE24B","visualPrompt":"...","characters":["..."],"shot":"...","comment":{"user":"...","text":"...","likes":"..."}}]}

[${opts.creative ? '창작 의뢰(이 장르·키워드로 오리지널 스토리를 지어내라)' : '자료'}]
${workSource.slice(0, 12000)}`;

  // ★우선순위 Gemini(키 폴백+모델 폴백), 없거나 전부 실패하면 OpenAI 폴백.
  //   ★LLM이 고온도에서 가끔 깨진 JSON을 뱉으면 영상 제작 '전체'가 실패하던 문제 → 파싱 실패 시 조용히
  //   재생성(최대 3회, 재시도는 저온도로 JSON 안정화). 코드펜스(```json)도 벗겨낸다.
  const gk = geminiKeys.filter(Boolean);
  if (!gk.length && !opts.openaiKey) throw new Error('Gemini/OpenAI 키가 모두 없습니다.');
  // ★고급 대본 토글: 유료 GPT 키가 있고 preferOpenAI면 GPT(gpt-4.1 풀)를 주 집필자로, 실패 시 무료 Gemini 폴백.
  //   끄면(기본) 무료 Gemini 우선, 실패 시 OpenAI(mini) 폴백 — 기존 동작.
  const preferGpt = !!opts.preferOpenAI && !!opts.openaiKey;
  let sb: Storyboard | null = null;
  let lastErr = '대본 생성 실패';
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw = '';
    if (preferGpt) {
      try { opts.log?.('[대본] 🤖 GPT(고급·유료)로 집필'); raw = await openaiJson(opts.openaiKey!, prompt, 4096, 'gpt-4.1'); }
      catch (e: any) { lastErr = e?.message || '생성 실패'; opts.log?.(`[대본] GPT 실패${gk.length ? ' → Gemini 폴백' : ''}: ${lastErr}`); }
      if (!raw && gk.length) {
        try { raw = await geminiGenerate(gk, prompt, {json: true, maxTokens: 4096, temperature: attempt === 0 ? 0.9 : 0.6, log: opts.log}); }
        catch (e: any) { lastErr = e?.message || '생성 실패'; }
      }
    } else {
      if (gk.length) {
        try { raw = await geminiGenerate(gk, prompt, {json: true, maxTokens: 4096, temperature: attempt === 0 ? 0.9 : 0.6, log: opts.log}); }
        catch (e: any) { lastErr = e?.message || '생성 실패'; opts.log?.(`[대본] Gemini 실패${opts.openaiKey ? ' → OpenAI 폴백' : ''}: ${lastErr}`); }
      }
      if (!raw && opts.openaiKey) {
        try { opts.log?.('[대본] OpenAI로 생성'); raw = await openaiJson(opts.openaiKey, prompt, 4096); }
        catch (e: any) { lastErr = e?.message || '생성 실패'; }
      }
    }
    if (!raw) continue;
    try {
      const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(s.startsWith('{') ? s : (s.match(/\{[\s\S]*\}/)?.[0] || s));
      if (parsed?.scenes?.length) { sb = parsed; break; }
      lastErr = '대본에 장면이 없음';
    } catch (e: any) { lastErr = e?.message || '대본 JSON 파싱 실패'; opts.log?.(`[대본] JSON 파싱 실패 → 재생성(${attempt + 1}/3)`); }
  }
  if (!sb) throw new Error('대본 생성 실패(재시도 후): ' + lastErr);

  // ★★2패스 재집필(창작 전용, 무료 flash) — 초고를 '극작 심사관'이 냉정히 까고 방송국·뮤지컬 수준으로 다시 쓴다.
  //   스토리 본체(narration·후킹)만 고쳐 쓰고 장면 수·구조·visualPrompt·cast는 그대로 → 하류(파이프라인) 안전.
  //   유료 pro 모델이 아니라 같은 flash를 한 번 더 부르는 것뿐이라 비용 없음. 실패해도 초고로 진행(try/catch).
  if (opts.creative && (gk.length || preferGpt)) {
    try {
      opts.log?.(preferGpt ? '[대본] 2패스 — 🤖 GPT 극작 심사관이 다듬는 중…' : '[대본] 2패스 — 초고를 극작 심사관이 다듬는 중…');
      const draftJson = JSON.stringify({title: sb.title, scenes: sb.scenes.map((s) => ({narration: s.narration, hookTop: s.hookTop, hookAccent: s.hookAccent}))});
      const critic = `너는 조회수 잘 나오는 한국 쇼츠 대본을 고쳐 쓰는 작가다. 아래 초고를 '한 번 들으면 바로 이해되고 끝까지 보게' 다시 써라. ★최우선은 '쉽고 또렷함' — 어려운 말·추상어·빙빙 돌리기를 걷어내고, 한 번 듣고 이해되는 쉬운 문장으로(유치하지 않게).
[심사 기준 — 하나라도 걸리면 고친다]
① 기승전결이 또렷한가(발단-전개-반전-해소). ② 전(轉)에 '예상을 뒤집는 반전'이 있고, 그 반전이 앞 장면에 깔아둔 복선으로 납득되는가(갑툭튀 금지). ③ 설명(telling)이 아니라 장면·행동·대사로 보여주는가(showing). ④ 매 장면이 앞 장면의 결과로 인과가 이어지는가. ⑤ 추상어·상투어·뻔한 교훈·막장 클리셰(출생의 비밀·불륜)가 없는가. ⑥ 1번 장면 첫 문장이 0.5초에 꽂히는가. ⑦ 마지막이 첫 장면으로 되돌아가는 여운(루프)인가. ⑧ 오감·구체적 디테일로 생생한가.
[재집필 지시]
- ★★★narration은 '귀로 들을 말'만 + '인물 행동·동작 중계 제거'(가장 중요): 초고에 '노인이 종이를 내민다'·'숨을 삼키며 쳐다본다'·'순간 멈칫한다'·'목소리가 떨린다'·'창밖을 보다가' 같은 동작·행동·표정 서술('~한다/~본다/~내민다/~받는다' 류), 괄호 지문, 효과음 표기가 있으면 전부 빼라(영상이 보여주므로 자막만 넘친다). 대신 ①대사("…") ②속마음·감정 ③핵심 정보/반전만 남겨 '짧게' 다시 써라. 각 장면 narration이 지금보다 짧고 깔끔해져야 한다.
- 장면 수(${sb.scenes.length}개)와 순서는 '그대로' 유지한다. 각 장면 narration을 장면당 약 ${perScene}자로 다시 써라 — 간결하고 리듬감 있게, 버릴 문장이 하나도 없게.
- hookTop(공백 포함 12자 이내)·hookAccent(10자 이내)도 더 세게 다시 써라. ★두 줄에 같은 단어 반복 금지.
- 전체가 '하나의 일관된 이야기'여야 한다. 초고가 횡설수설이거나 주제에서 샜으면 사건을 또렷하게 바로잡아라.
- 안전: 정치·종교·성/폭력 자극 표현 금지.
반드시 아래 JSON만 출력(장면 수 정확히 ${sb.scenes.length}개):
{"scenes":[{"narration":"...","hookTop":"...","hookAccent":"..."}]}

[초고]
${draftJson}`;
      const raw2 = preferGpt
        ? await openaiJson(opts.openaiKey!, critic, 4096, 'gpt-4.1')
        : await geminiGenerate(gk, critic, {json: true, maxTokens: 4096, temperature: 0.85, log: opts.log});
      const s2 = raw2.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      const ref = JSON.parse(s2.startsWith('{') ? s2 : (s2.match(/\{[\s\S]*\}/)?.[0] || s2));
      if (Array.isArray(ref?.scenes) && ref.scenes.length === sb.scenes.length) {
        ref.scenes.forEach((r: any, i: number) => {
          if (r?.narration && String(r.narration).trim()) sb!.scenes[i].narration = String(r.narration).trim();
          if (r?.hookTop && String(r.hookTop).trim()) sb!.scenes[i].hookTop = String(r.hookTop).trim();
          if (r?.hookAccent && String(r.hookAccent).trim()) sb!.scenes[i].hookAccent = String(r.hookAccent).trim();
        });
        opts.log?.('[대본] 2패스 완성 — 재집필본 반영(방송국·뮤지컬 수준 목표)');
      } else {
        opts.log?.('[대본] 2패스 장면수 불일치 → 초고 유지');
      }
    } catch (e: any) { opts.log?.('[대본] 2패스 건너뜀: ' + (e?.message || '').slice(0, 50)); }
  }

  // ★cast 정규화(서사형) — {name,look} 배열만 남긴다. 없으면 undefined(단일 소재형).
  if (Array.isArray((sb as any).cast)) {
    const cast = (sb as any).cast
      .map((c: any) => ({name: String(c?.name || '').trim(), look: String(c?.look || '').trim()}))
      .filter((c: CastMember) => c.name && c.look)
      .slice(0, 8);
    sb.cast = cast.length ? cast : undefined;
  } else sb.cast = undefined;
  // 서사형(cast 있음)이면 subject를 비워 pipeline이 단일-소재 강제를 걸지 않게 한다(난쟁이·조연이 장면에서 사라지던 원인).
  if (sb.cast && sb.cast.length) sb.subject = '';
  // 장면별 characters/shot 정규화 + 빈 comment 제거(LLM이 comment:{} 를 뱉으면 Scene 렌더가 comment.user.slice에서 터진다).
  for (const s of sb.scenes) {
    s.characters = Array.isArray(s.characters) ? s.characters.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6) : [];
    s.shot = typeof s.shot === 'string' ? s.shot.trim().slice(0, 60) : '';
    if (s.comment && !(s.comment.user && String(s.comment.user).trim() && s.comment.text && String(s.comment.text).trim())) delete s.comment;
  }
  // 자막·후킹·나레이션 이모지 제거(폰트에 없어 깨짐). title은 유튜브용이라 유지.
  for (const s of sb.scenes) { s.hookTop = stripEmoji(s.hookTop || ''); s.hookAccent = stripEmoji(s.hookAccent || ''); s.narration = stripEmoji(s.narration || ''); }
  // ★후킹 중복 가드 — 아랫줄(accent)이 윗줄(top)과 같은 말이면 비운다("했던 말을 또 하는" 꼴 방지, 테리 지적).
  for (const s of sb.scenes) s.hookAccent = dedupAccent(s.hookTop, s.hookAccent);
  // ★후킹 강화 게이트 — 후킹을 "항상 90점 이상"으로 재작성해 밋밋하게 안 나오게 완전 고정(테리 지시).
  try {
    const strong = await intensifyHooks(geminiKeys, sb.scenes.map((s) => ({hookTop: s.hookTop, hookAccent: s.hookAccent, context: s.narration || ''})), opts.log);
    sb.scenes.forEach((s, i) => { if (strong[i]) { s.hookTop = strong[i].hookTop; s.hookAccent = strong[i].hookAccent; } });
  } catch (e: any) { opts.log?.('[후킹강화] 건너뜀: ' + (e?.message || '').slice(0, 50)); }
  // ★화면 지문·효과음 제거(대사 아닌 걸 TTS가 읽는 문제) → 끝맺음 정규화. 음성·자막 둘 다 반영.
  // ★서사형(창작·cast 있음)만 행동 수식어 결정적 필터 적용(정보형은 행동 서술이 없어 불필요·부작용 방지).
  const isNarrative = !!opts.creative || !!(sb.cast && sb.cast.length);
  for (const s of sb.scenes) {
    let nar = stripStageDirections(s.narration);
    if (isNarrative) nar = stripActionModifiers(nar);
    s.narration = normalizeEnding(nar);
  }
  // 썸네일 전용 문구 이모지 제거(폰트 깨짐 방지).
  if (sb.thumb) sb.thumb = {big: stripEmoji(String(sb.thumb.big || '')), small: stripEmoji(String(sb.thumb.small || '')), badge: stripEmoji(String(sb.thumb.badge || ''))};
  return sb;
}
