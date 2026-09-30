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
  comment?: {user: string; text: string; likes: string}; // 이지컷식 가짜 댓글(선택)
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
  const endingRule = isSell
    ? '마지막 장면 = 구매·신청으로 이어지는 행동 유도 + 혜택 강조. 구매 욕구를 자극하며 맺는다.'
    : (preset?.endingStyle || '마지막 장면 = 주제의 핵심 메시지나 긍정적 실천 독려로 맺는다.') +
      closingLine +
      ctaGuard;

  const catLine = preset ? `[카테고리] ${preset.label} (${preset.group})` : '';

  const prompt = `너는 조회수 높은 한국 유튜브 채널의 대본 작가다. 아래 자료로 '한 편의 영화처럼 기승전결이 있어 끝까지 보게 되는' 한국어 ${orient} ${format} 대본을 JSON으로 쓴다.

${catLine}
[화법·톤] ${toneGuide}
[목표] 총 ${duration}초, 장면 정확히 ${n}개.
🚫 정치·선거·종교·사회갈등·혐오·성적/폭력적 자극 등 민감한 주제·표현은 절대 쓰지 마라(안전한 콘텐츠만).
[서사 구조 — 반드시 지켜라]
- 1번 장면 = 스크롤을 멈추게 하는 강렬한 훅. ${hookRule} 절대 평범하게 시작하지 마.
  ★★후킹 만드는 법(매우 중요, 조회수의 90%가 첫 3초에서 결정된다): 먼저 머릿속으로 서로 다른 후킹 후보를 3개 떠올려라 — (A)궁금증 갭("아무도 몰랐던 이것") (B)손해 회피("이거 모르면 손해") (C)숫자·반전 충격("단 3초면 끝"). 그중 이 소재에 가장 강력하게 꽂히는 하나만 골라 hookTop/hookAccent에 써라. 밋밋하면 실패다.
- 중간 장면 = 정보를 쌓다가 '하지만/그런데' 같은 반전으로 긴장을 준다. 다음이 궁금하게 끊어라.
- ${endingRule}

[각 장면 필드]
- narration: 나레이션 한국어. ★장면당 약 ${perScene}자(공백 포함, 이 글자수를 꼭 지켜라 — 영상이 목표 ${duration}초에 맞아야 한다. 훨씬 짧거나 길면 안 됨). 정보를 빠르게 착착 밀어붙이는 다큐 나레이션 톤(지루할 틈 없이). 구어체, 몰입감. 숫자·핵심은 또렷하게.
  ★자연스럽게 이어 읽히게 써라(TTS가 로봇처럼 끊지 않도록): 느낌표(!)를 남발하지 마라(장면당 최대 1개). 짧은 단어를 "휘!휘!"처럼 느낌표로 뚝뚝 끊지 말고, "휘휘 돌려주면" 또는 "휘~ 휘~ 돌려주면"처럼 자연스러운 흐름으로. 의성어·의태어는 물결(~)이나 쉼표로 부드럽게 잇고, 딱딱한 감탄사 나열 금지.
- hookTop: 상단 후킹 첫 줄(흰색, 맥락/셋업). 공백 포함 12자 이내.
- hookAccent: 상단 후킹 둘째 줄(강조색, 펀치라인). 10자 이내. 임팩트 있게.
- accentColor: 이 장면 강조색 hex 하나. 장면마다 다르게 골라라(${preset ? preset.accentColors.join(', ') : PALETTE}) — 내용 분위기에 맞게.
- visualPrompt: 이미지 생성용 영어 프롬프트. ${landscape ? '16:9 landscape wide shot(가로 와이드 구도: 풍경·전경·넓은 현장을 담되 핵심 피사체는 중앙~좌우 3분할점에)' : '9:16 세로'}. ${preset ? `이 카테고리의 비주얼 느낌: "${preset.imageStyle}".` : '"실제 취재 보도사진 리얼리즘"(자연광·실제 질감).'} 나레이션의 핵심 사물·장소·상황을 구체적으로.
  ★★핵심 소재 일관성(매우 중요): 모든 장면의 visualPrompt는 반드시 위 [핵심 소재 subject]와 같은 대상을 보여줘야 한다. 예를 들어 주제가 '간장계란볶음밥'이면 모든 장면이 볶음밥이어야 하고, 절대 파스타·면·다른 음식으로 바뀌면 안 된다. 각 visualPrompt 안에 subject를 영어로 명시적으로 포함시켜라.
  ★사람(특히 얼굴·군중)은 절제하고 사물·장소·현장·상징물 위주. 사람이 꼭 필요하면 손·뒷모습·실루엣만 작게. ★글자·문서·표가 주요 피사체인 장면 금지. no text.
- comment(선택): 4~6개 장면 중 딱 1개 장면에만, 이지컷식 가짜 시청자 댓글 {"user":"한국이름","text":"공감/놀람 한마디","likes":"4.2천"}.

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
  // ★모든 장면 나레이션 끝맺음 정규화(쉼표로 끊기는 버그 방지 — 음성·자막 둘 다 반영)
  for (const s of sb.scenes) s.narration = normalizeEnding(s.narration);
  return sb;
}
