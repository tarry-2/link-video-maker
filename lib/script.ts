// 대본 생성 — 링크 본문 → 기승전결 서사 쇼츠 대본(JSON). Gemini 우선, 없거나 실패 시 OpenAI 폴백.
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';
import type {Preset} from './presets';

export type StoryScene = {
  narration: string; // 나레이션(음성으로 읽힘)
  hookTop: string; // 상단 후킹 1줄(흰색, 셋업)
  hookAccent: string; // 상단 후킹 2줄(강조색, 펀치)
  accentColor: string; // 이 장면 강조색 hex
  visualPrompt: string; // 이미지 생성용(영어)
  comment?: {user: string; text: string; likes: string}; // 인기 쇼츠식 가짜 댓글(선택)
};

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

export type Storyboard = {
  title: string;
  subject: string; // ★영상 전체의 핵심 소재(영어) — 모든 장면 이미지에 일관 반영(예: "soy sauce fried rice with egg")
  musicPrompt: string; // BGM 무드(영어)
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
    openaiKey?: string;
    log?: (m: string) => void;
  },
): Promise<Storyboard> {
  const duration = opts.duration;
  // ★화면비: 롱폼(≥90초)=가로 16:9 / 쇼츠=세로 9:16. UI "롱폼" optgroup(90/120/180)과 일치(오프바이원 수정).
  const landscape = duration >= 90;
  const format = landscape ? '롱폼' : '쇼츠';
  const orient = landscape ? '가로(16:9, wide)' : '세로(9:16)';
  const n =
    duration <= 30 ? 4 : duration <= 60 ? 6 : Math.min(10, Math.ceil(duration / 12));
  const perScene = Math.round((duration * 5.6) / n); // ★실측보정 5.6: dry-run으로 목표길이에 중심 맞춤(v4 통짜 rate 6.0자/초). "약 N자"만 지시(문장수 지시 금지=폭주). Gemini가 ±25% 널뛰어도 평균은 목표에 근접.

  const preset = opts.preset;
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
  const endingGuard = `\n★★★마무리는 이 영상에서 가장 중요하다. 반드시 앞에서 다룬 내용을 자연스럽게 매듭지어라. 앞에 안 나온 뜬금없는 새 소재·엉뚱한 말·주제와 동떨어진 문장으로 끝내면 절대 안 된다(가장 흔한 실패). 흐름상 앞 장면들과 자연스럽게 연결되고, 영상 전체의 핵심을 한 번 짚어준 뒤 여운으로 닫아라.`;
  const endingRule = (isSell
    ? '마지막 장면 = 구매·신청으로 이어지는 행동 유도 + 혜택 강조. 구매 욕구를 자극하며 맺는다.'
    : (preset?.endingStyle || '마지막 장면 = 주제의 핵심 메시지나 긍정적 실천 독려로 맺는다.') +
      closingLine +
      ctaGuard) + endingGuard;

  const catLine = preset ? `[카테고리] ${preset.label} (${preset.group})` : '';

  const prompt = `너는 구독자 100만 한국 유튜브 쇼츠 채널의 기획자이자 대본 작가다. 아래 자료로 '한 편의 영화처럼 기승전결이 있어 끝까지 보게 되는' 한국어 ${orient} ${format} 대본을 JSON으로 쓴다.

${catLine}
[화법·톤] ${toneGuide}
[목표] 총 ${duration}초, 장면 정확히 ${n}개.
🚫 정치·선거·종교·사회갈등·혐오·성적/폭력적 자극 등 민감한 주제·표현은 절대 쓰지 마라(안전한 콘텐츠만).
[서사 구조 — 반드시 지켜라]
- 1번 장면 = 스크롤을 멈추게 하는 강렬한 훅. ${hookRule} 절대 평범하게 시작하지 마.
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
- hookAccent: 상단 후킹 둘째 줄(강조색, 펀치라인). 10자 이내. 임팩트 있게.
- accentColor: 이 장면 강조색 hex 하나. 장면마다 다르게 골라라(${preset ? preset.accentColors.join(', ') : PALETTE}) — 내용 분위기에 맞게.
- visualPrompt: 이미지 생성용 영어 프롬프트. ${landscape ? '16:9 landscape wide shot(가로 와이드 구도: 풍경·전경·넓은 현장을 담되 핵심 피사체는 중앙~좌우 3분할점에)' : '9:16 세로'}. ${preset ? `이 카테고리의 비주얼 느낌: "${preset.imageStyle}".` : '"실제 취재 보도사진 리얼리즘"(자연광·실제 질감).'} 나레이션의 핵심 사물·장소·상황을 구체적으로.
  ★★핵심 소재 일관성(매우 중요): 모든 장면의 visualPrompt는 반드시 위 [핵심 소재 subject]와 같은 대상을 보여줘야 한다. 예를 들어 주제가 '간장계란볶음밥'이면 모든 장면이 볶음밥이어야 하고, 절대 파스타·면·다른 음식으로 바뀌면 안 된다. 각 visualPrompt 안에 subject를 영어로 명시적으로 포함시켜라.
  ★사람(특히 얼굴·군중)은 절제하고 사물·장소·현장·상징물 위주. 사람이 꼭 필요하면 손·뒷모습·실루엣만 작게. ★글자·문서·표가 주요 피사체인 장면 금지. no text.
- comment(선택): 4~6개 장면 중 딱 1개 장면에만, 인기 쇼츠에 흔한 가짜 시청자 댓글 {"user":"한국이름","text":"공감/놀람 한마디","likes":"4.2천"}.

[전체]
- title: 클릭하고 싶은 한국어 영상 제목.
- subject: 이 영상의 핵심 소재를 영어로 명확히(예: "soy sauce fried rice with fried egg"). 모든 장면 이미지가 이 소재를 벗어나면 안 된다.
- musicPrompt: 영상 분위기에 맞는 BGM 무드(영어 한 줄).

반드시 아래 JSON만 출력(설명·마크다운 금지):
{"title":"...","subject":"...","musicPrompt":"...","scenes":[{"narration":"...","hookTop":"...","hookAccent":"...","accentColor":"#FFE24B","visualPrompt":"...","comment":{"user":"...","text":"...","likes":"..."}}]}

[자료]
${source.slice(0, 12000)}`;

  // ★우선순위 Gemini(키 폴백+모델 폴백), 없거나 전부 실패하면 OpenAI 폴백.
  let raw = '';
  const gk = geminiKeys.filter(Boolean);
  if (gk.length) {
    try {
      raw = await geminiGenerate(gk, prompt, {
        json: true,
        maxTokens: 4096,
        temperature: 0.9,
        log: opts.log,
      });
    } catch (e: any) {
      opts.log?.(`[대본] Gemini 실패 → OpenAI 폴백: ${e.message}`);
    }
  }
  if (!raw) {
    if (!opts.openaiKey) throw new Error('Gemini/OpenAI 키가 모두 없습니다.');
    opts.log?.('[대본] OpenAI로 생성');
    raw = await openaiJson(opts.openaiKey, prompt, 4096);
  }

  let sb: Storyboard;
  try {
    sb = JSON.parse(raw);
  } catch {
    // JSON 앞뒤에 잡텍스트가 붙은 경우 대비: 첫 { ~ 마지막 } 만 추출
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('대본 JSON 파싱 실패');
    sb = JSON.parse(m[0]);
  }
  if (!sb.scenes?.length) throw new Error('대본에 장면이 없습니다.');
  // 자막·후킹·나레이션 이모지 제거(폰트에 없어 깨짐). title은 유튜브용이라 유지.
  for (const s of sb.scenes) { s.hookTop = stripEmoji(s.hookTop || ''); s.hookAccent = stripEmoji(s.hookAccent || ''); s.narration = stripEmoji(s.narration || ''); }
  // ★모든 장면 나레이션 끝맺음 정규화(쉼표로 끊기는 버그 방지 — 음성·자막 둘 다 반영)
  for (const s of sb.scenes) s.narration = normalizeEnding(s.narration);
  return sb;
}
