// 카드뉴스 대본 생성 — 주제를 받아 AI가 카드별 "타입 + 문구"를 자동 배정한다.
// ★핵심 2가지: (1) 본문이 알차야 한다(구체적 수치·행동·예시). (2) 첫 장(cover)은 시선폭탄 후킹.
// 다양성: cover/number/list/quote/compare/fix/body/closing을 섞어 지루하지 않게.
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';
import type {Preset} from './presets';

export type CardType = 'cover' | 'number' | 'list' | 'quote' | 'compare' | 'fix' | 'body' | 'closing' | 'checklist' | 'step' | 'qa' | 'stat';
export type CardPlan = {
  type: CardType;
  accent?: string;
  badge?: string;
  // cover 후킹(시선폭탄) 전용.
  big?: string;    // 초대형 훅 — 2~5단어. 스크롤 멈추는 한 방.
  small?: string;  // 윗줄 보조(작게).
  title?: string;
  body?: string;
  number?: string;
  unit?: string;
  items?: string[];
  before?: string;
  after?: string;
  wrong?: string;
  right?: string;
};
export type CardStoryboard = {title: string; musicPrompt: string; cards: CardPlan[]};

const TYPE_GUIDE = `카드 타입(역할이 달라야 다채롭다. 내용에 맞는 타입을 섞어라):
- cover: 첫 장. ★시선폭탄 후킹. big(초대형 훅 2~5단어, 스크롤 멈추는 한 방), small(윗줄 보조 한 줄), badge(충격 뱃지 2~4자: 충격/실화?/꿀팁/경악/소름 등), body(짧은 미끼 한 줄). title은 비워도 됨.
- number: 큰 숫자 하나로 임팩트. number(숫자만), unit(%·명·배·분 등), title(숫자 위 설명), body(숫자 아래 보충 1~2문장).
- list: 번호 목록. title(제목) + items(3~5개). ★각 항목은 '명사 나열'이 아니라 실제로 써먹을 구체적 행동/정보 한 줄.
- quote: 한 문장 임팩트. title(핵심 한 문장) + body(출처/화자/부연).
- compare: 전후 대조. title + before(흔한/잘못된 쪽, 구체적으로) + after(올바른/좋은 쪽, 구체적으로).
- fix: 실수 vs 해결. title + wrong(흔한 실수, 구체적) + right(올바른 법, 바로 따라할 수 있게).
- body: 핵심 설명. title(소제목) + body(★2~3문장, 구체적 수치·방법·이유를 담아 알차게. 이 카드가 본문의 핵심).
- checklist: 꼭 지킬/챙길 체크리스트. title + items(3~5개, 각 항목 체크할 행동 한 줄).
- step: 순서대로 따라하는 단계. title + items(3~5개, STEP 순서대로 실제 행동).
- qa: 자주 묻는 질문. title(질문, 물음표로 끝남) + body(명확한 답 1~2문장).
- stat: 수치 비교 막대. title + items(2~4개, 반드시 '라벨|숫자' 형식. 예: "단백질|30","지방|12"). 숫자는 순수 숫자만.
- closing: 마지막 장. title(여운 한마디) + body(저장/실천 유도).`;

function buildPrompt(topic: string, count: number, preset?: Preset) {
  const tone = preset ? preset.toneGuide : '친근하고 쉽게, 전문용어는 풀어서, 일상어로.';
  const palette = preset?.accentColors?.join(', ') || '#FFD84D, #4FE0D0, #FF8ABf';
  const cat = preset ? `[카테고리] ${preset.label} (${preset.group})` : '';
  return `너는 인스타·유튜브에서 수십만 저장을 부르는 카드뉴스 기획자다. 아래 주제로 ${count}장짜리 카드뉴스를 만들어라.
주제: ${topic}
${cat}
[톤] ${tone}

${TYPE_GUIDE}

★★가장 중요한 원칙 — 본문(내용)이 생명이다:
- 뻔한 일반론·공자님 말씀 금지("건강이 중요합니다" 따위). 읽는 사람이 "오 이건 몰랐네 저장해야지" 할 구체적 정보를 담아라.
- 숫자, 비율, 시간, 순서, 실제 방법, 이유를 구체적으로. 추상어("적절히","꾸준히")보다 실측치("30분","3번","2배").
- 각 카드는 하나의 알맹이를 깊게. 여러 개를 얕게 나열하지 마라.

규칙:
- 첫 카드는 반드시 cover(시선폭탄 후킹), 마지막 카드는 반드시 closing.
- 중간 카드는 내용에 가장 맞는 타입을 다양하게(같은 타입 연속 지양). number·list·compare·fix를 적극 활용.
- cover의 big은 짧고 강하게(2~5단어). 그 외 제목은 모바일에서 한눈에 읽히게.
- 과장 낚시·허위 금지. 하지만 임팩트는 최대.
- accent는 카드마다 이 팔레트 중 하나: ${palette}

[BGM 무드] musicPrompt는 반드시 밝고 경쾌하게(upbeat, bright, cheerful, positive). 카드뉴스는 나레이션 없이 음악만 깔릴 때가 많으니 분위기가 중요하다. 어둡거나 무섭거나 긴장되는 무드(dark, horror, suspense, sad)는 절대 쓰지 마라.

JSON만 출력:
{"title":"콘텐츠 제목","musicPrompt":"upbeat bright cheerful background music","cards":[{"type":"cover","accent":"#..","badge":"충격","big":"육즙 팡! 삼겹살 혁명","small":"냉동실에 쟁여둔 삼겹살","body":"딱 3가지만 바꾸면 끝"}, {"type":"body","accent":"#..","title":"..","body":".."}, ...]}`;
}

function normalize(j: Record<string, unknown>, count: number, palette: string[]): CardStoryboard {
  const rawCards = Array.isArray(j.cards) ? j.cards : [];
  const types: CardType[] = ['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing', 'checklist', 'step', 'qa', 'stat'];
  const cards: CardPlan[] = rawCards.slice(0, count).map((raw, i): CardPlan => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const type = types.includes(c.type as CardType) ? (c.type as CardType) : 'body';
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
    return {
      type,
      accent: str(c.accent) && /^#[0-9a-f]{6}$/i.test(String(c.accent)) ? String(c.accent) : palette[i % palette.length],
      badge: str(c.badge), big: str(c.big), small: str(c.small), title: str(c.title), body: str(c.body),
      number: str(c.number), unit: str(c.unit),
      items: Array.isArray(c.items) ? c.items.map(x => String(x).trim()).filter(Boolean).slice(0, 5) : undefined,
      before: str(c.before), after: str(c.after), wrong: str(c.wrong), right: str(c.right),
    };
  });
  // 안전장치: 첫=cover, 끝=closing 강제.
  if (cards.length) {
    cards[0].type = 'cover';
    // cover에 big이 없으면 title/body에서 끌어와 후킹을 비우지 않는다(회귀 방지).
    if (!cards[0].big) cards[0].big = cards[0].title || cards[0].body || String(j.title || '');
    cards[cards.length - 1].type = 'closing';
  }
  return {title: String(j.title || '카드뉴스').slice(0, 80), musicPrompt: String(j.musicPrompt || 'upbeat bright cheerful light background music'), cards};
}

export async function generateCardStoryboard(
  keys: {gemini: string[]; openai?: string},
  topic: string,
  count = 7,
  preset?: Preset,
): Promise<CardStoryboard> {
  const n = Math.max(3, Math.min(12, count));
  const palette = preset?.accentColors?.length ? preset.accentColors : ['#FFD84D', '#4FE0D0', '#FF8ABf'];
  const prompt = buildPrompt(topic, n, preset);
  let raw = '';
  if (keys.gemini?.length) {
    try { raw = await geminiGenerate(keys.gemini, prompt, {json: true, maxTokens: 2048, temperature: 0.95}); } catch { /* openai 폴백 */ }
  }
  if (!raw && keys.openai) raw = await openaiJson(keys.openai, prompt, 2048);
  if (!raw) throw new Error('카드 대본 생성 실패: AI 키를 확인하세요.');
  const m = raw.match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : {};
  const sb = normalize(j, n, palette);
  if (!sb.cards.length) throw new Error('카드 대본이 비었습니다. 다시 시도하세요.');
  return sb;
}
