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
    openaiKey?: string;
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
    ? `너는 수백만 조회수를 내는 한국 숏드라마·웹드라마 작가이자 뮤지컬 극작가다. 아래 '창작 의뢰(장르·키워드)'로 실제 자료 없이 완전히 새로운 '오리지널 픽션 시나리오'를 창작한다. 지어내도 된다(픽션). '한 편의 영화·뮤지컬처럼 기승전결이 살아있고 끝까지 보게 되는' 한국어 ${orient} ${format} 시나리오를 JSON으로 쓴다.`
    : `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자이자 대본 작가다. 아래 자료로 '한 편의 영화처럼 기승전결이 있어 끝까지 보게 되는' 한국어 ${orient} ${format} 대본을 JSON으로 쓴다.`;
  const prompt = `${intro}${opts.seriesBible ? `\n\n[시리즈 설정 — 반드시 지켜라(스토리 바이블)]\n이 영상은 시리즈의 한 편이다. 아래 세계관·인물·전체 줄거리를 '그대로' 지키며(인물 이름·성격·외형·관계·설정 유지), 이 편의 분량을 이어서 써라. 이 편의 마지막은 다음 편이 궁금해 미치게 만드는 클리프행어로 끊어라.\n${opts.seriesBible.slice(0, 4000)}` : ''}

${catLine}
[화법·톤] ${toneGuide}
[목표] 총 ${duration}초, 장면 정확히 ${n}개.
🚫 정치·선거·종교·사회갈등·혐오·성적/폭력적 자극 등 민감한 주제·표현은 절대 쓰지 마라(안전한 콘텐츠만).
[★★★감성·몰입 — 모든 영상의 최우선 원칙(테리 못박음)]
이 영상은 '멍하게 시간 때우는 영상'이 아니라 '한 편을 끝까지 감상하는 작품'이어야 한다. 시청자가 스스로 주인공이 된 듯 동조·몰입하게, 영화·뮤지컬 한 편처럼 감정의 곡선(기대→긴장→고조→벅참/여운)을 설계하라.
- narration은 정보 나열이 아니라 '감정을 건드리는 이야기'로. 장면이 넘어갈수록 감정이 쌓이고, 중반에 울림(공감·놀라움·뭉클), 후반에 벅차오름이나 깊은 여운이 오게.
- 오감·심상을 자극하는 구체적 묘사와 '너/당신'을 향한 2인칭 호명으로 시청자를 장면 안으로 끌어들여라(관찰자가 아니라 당사자로).
- 주제와 분위기에 따라 톤을 바꿔라: 미스터리=서늘하고 신비롭게 심장 쫄깃, 감동=따뜻하게 벅차게, 정보=경쾌하고 똑부러지게. 소재에 맞는 '분위기'를 끝까지 유지하라.
[서사 구조 — 반드시 지켜라]
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
- narration: 나레이션 한국어. ★장면당 약 ${perScene}자(공백 포함, 이 글자수를 꼭 지켜라 — 영상이 목표 ${duration}초에 맞아야 한다. 훨씬 짧거나 길면 안 됨). 정보를 빠르게 착착 밀어붙이는 다큐 나레이션 톤(지루할 틈 없이). 구어체, 몰입감. 숫자·핵심은 또렷하게.
  ★★내용의 질(매우 중요): 매 문장에 알맹이가 있어야 한다. 뻔한 말·빈말·같은 말 반복·당연한 소리 금지. 구체적인 숫자·방법·근거·실제 예시로 "오 이건 몰랐네" 싶게 만들어라. 두루뭉술("건강에 좋아요")하지 말고 구체적("하루 10분, 2주면 혈압이 눈에 띄게 떨어집니다")으로. 각 장면 끝은 다음이 궁금하게 끊어 완주율을 높여라.
  ★자연스럽게 이어 읽히게 써라(TTS가 로봇처럼 끊지 않도록): 느낌표(!)를 남발하지 마라(장면당 최대 1개). 짧은 단어를 "휘!휘!"처럼 느낌표로 뚝뚝 끊지 말고, "휘휘 돌려주면" 또는 "휘~ 휘~ 돌려주면"처럼 자연스러운 흐름으로. 의성어·의태어는 물결(~)이나 쉼표로 부드럽게 잇고, 딱딱한 감탄사 나열 금지.
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
- musicPrompt: 이 영상의 '영화 사운드트랙'을 영어 한 줄로. 단순 장르가 아니라 감정 곡선·악기·분위기·전개를 담아라(시청자를 몰입시키는 BGM이 조회수·체류의 핵심 — 테리 강조). 예: 미스터리="cinematic mysterious orchestral score, soft eerie piano and pulsing low strings, building suspense with a haunting melody, emotional and immersive", 감동="warm uplifting orchestral and piano, gentle build to a soaring emotional swell, heartfelt and cinematic". 주제·분위기에 정확히 맞춰 매번 다르게.
- thumb: 썸네일(커버) 전용 문구. 영상 제목보다 훨씬 더 자극적이고 궁금해 미치게 만드는 "시선폭탄" 카피. 반드시 아래 3개:
   · big: 초대형으로 박을 핵심 한 방. 6~10자, 띄어쓰기로 2~3덩어리(예: "이거 먹지 마세요", "월 3만원 공짜", "90%가 모름"). 문장부호 최소, 완성문장 금지. 스크롤을 멈추게 할 가장 센 말.
   · small: big 위에 작게 깔 미끼 한 줄(10~16자). 대상을 콕 집어 공감·긴장(예: "의사들이 절대 안 먹는", "아침마다 붓는 사람").
   · badge: 충격 뱃지 한 단어(실화?/충격/경악/소름/대박 중 분위기 맞는 것). 판매성이면 "초특가", 아이용 애니면 빈 문자열.

반드시 아래 JSON만 출력(설명·마크다운 금지):
{"title":"...","subject":"...","cast":[{"name":"...","look":"..."}],"musicPrompt":"...","thumb":{"big":"...","small":"...","badge":"..."},"scenes":[{"narration":"...","hookTop":"...","hookAccent":"...","accentColor":"#FFE24B","visualPrompt":"...","characters":["..."],"shot":"...","comment":{"user":"...","text":"...","likes":"..."}}]}

[${opts.creative ? '창작 의뢰(이 장르·키워드로 오리지널 스토리를 지어내라)' : '자료'}]
${source.slice(0, 12000)}`;

  // ★우선순위 Gemini(키 폴백+모델 폴백), 없거나 전부 실패하면 OpenAI 폴백.
  //   ★LLM이 고온도에서 가끔 깨진 JSON을 뱉으면 영상 제작 '전체'가 실패하던 문제 → 파싱 실패 시 조용히
  //   재생성(최대 3회, 재시도는 저온도로 JSON 안정화). 코드펜스(```json)도 벗겨낸다.
  const gk = geminiKeys.filter(Boolean);
  if (!gk.length && !opts.openaiKey) throw new Error('Gemini/OpenAI 키가 모두 없습니다.');
  let sb: Storyboard | null = null;
  let lastErr = '대본 생성 실패';
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw = '';
    if (gk.length) {
      try { raw = await geminiGenerate(gk, prompt, {json: true, maxTokens: 4096, temperature: attempt === 0 ? 0.9 : 0.6, log: opts.log}); }
      catch (e: any) { lastErr = e?.message || '생성 실패'; opts.log?.(`[대본] Gemini 실패${opts.openaiKey ? ' → OpenAI 폴백' : ''}: ${lastErr}`); }
    }
    if (!raw && opts.openaiKey) {
      try { opts.log?.('[대본] OpenAI로 생성'); raw = await openaiJson(opts.openaiKey, prompt, 4096); }
      catch (e: any) { lastErr = e?.message || '생성 실패'; }
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
  // ★모든 장면 나레이션 끝맺음 정규화(쉼표로 끊기는 버그 방지 — 음성·자막 둘 다 반영)
  for (const s of sb.scenes) s.narration = normalizeEnding(s.narration);
  // 썸네일 전용 문구 이모지 제거(폰트 깨짐 방지).
  if (sb.thumb) sb.thumb = {big: stripEmoji(String(sb.thumb.big || '')), small: stripEmoji(String(sb.thumb.small || '')), badge: stripEmoji(String(sb.thumb.badge || ''))};
  return sb;
}
