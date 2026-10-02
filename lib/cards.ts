// 카드뉴스 대본 생성 — 주제를 받아 AI가 카드별 "타입 + 문구"를 자동 배정한다.
// 다양성의 핵심: 그냥 글만 바뀌는 게 아니라 cover/number/list/quote/compare/fix/body/closing을 섞는다.
import {geminiGenerate} from './gemini';
import {openaiJson} from './openai';
import type {Preset} from './presets';

export type CardType = 'cover' | 'number' | 'list' | 'quote' | 'compare' | 'fix' | 'body' | 'closing';
export type CardPlan = {
  type: CardType;
  accent?: string;
  badge?: string;
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

const TYPE_GUIDE = `카드 타입(각 역할이 달라야 다채롭다. 내용에 맞는 타입을 섞어 써라):
- cover: 첫 장. 스크롤 멈추는 강한 훅 제목(title) + 짧은 미끼(body) + 뱃지(badge: 꿀팁/충격/실화 등 2~4자).
- number: 큰 숫자 하나로 임팩트. number(숫자만), unit(%·명·배 등), title(숫자 위 설명), body(숫자 아래 보충).
- list: 번호 목록. title(제목) + items(3~5개, 각 항목 한 줄).
- quote: 한 문장 임팩트/명언. title(따옴표 안 들어갈 핵심 한 문장) + body(출처/화자).
- compare: 전후 대조. title + before(전) + after(후).
- fix: 실수 vs 해결. title + wrong(흔한 실수) + right(올바른 법).
- body: 일반 설명. title + body.
- closing: 마지막 장. title(여운 한마디) + body(저장/실천 유도).`;

function buildPrompt(topic: string, count: number, preset?: Preset) {
  const tone = preset ? preset.toneGuide : '친근하고 쉽게, 전문용어 피하고 일상어로.';
  const palette = preset?.accentColors?.join(', ') || '#FFD84D, #4FE0D0, #FF8ABf';
  const cat = preset ? `[카테고리] ${preset.label} (${preset.group})` : '';
  return `너는 인스타·유튜브에서 수십만 저장을 부르는 카드뉴스 기획자다. 아래 주제로 ${count}장짜리 카드뉴스를 만들어라.
주제: ${topic}
${cat}
[톤] ${tone}

${TYPE_GUIDE}

규칙:
- 첫 카드는 반드시 cover(강한 훅), 마지막 카드는 반드시 closing.
- 중간 카드들은 내용에 가장 어울리는 타입을 다양하게 섞어라(같은 타입 연속 지양). number·list·compare·fix를 적극 활용해 지루하지 않게.
- 각 문구는 모바일에서 한눈에 읽히게 짧게. 제목은 12자 내외, 본문은 한 줄.
- accent는 카드마다 이 팔레트 중 하나: ${palette}
- 과장 낚시·허위 금지. 하지만 임팩트는 최대.

JSON만 출력:
{"title":"영상 제목","musicPrompt":"BGM 무드 영어 한 줄","cards":[{"type":"cover","accent":"#..","badge":"..","title":"..","body":".."}, ...]}`;
}

function normalize(j: Record<string, unknown>, count: number, palette: string[]): CardStoryboard {
  const rawCards = Array.isArray(j.cards) ? j.cards : [];
  const types: CardType[] = ['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing'];
  const cards: CardPlan[] = rawCards.slice(0, count).map((raw, i): CardPlan => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const type = types.includes(c.type as CardType) ? (c.type as CardType) : 'body';
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
    return {
      type,
      accent: str(c.accent) && /^#[0-9a-f]{6}$/i.test(String(c.accent)) ? String(c.accent) : palette[i % palette.length],
      badge: str(c.badge), title: str(c.title), body: str(c.body),
      number: str(c.number), unit: str(c.unit),
      items: Array.isArray(c.items) ? c.items.map(x => String(x).trim()).filter(Boolean).slice(0, 5) : undefined,
      before: str(c.before), after: str(c.after), wrong: str(c.wrong), right: str(c.right),
    };
  });
  // 안전장치: 첫=cover, 끝=closing 강제.
  if (cards.length) { cards[0].type = 'cover'; cards[cards.length - 1].type = 'closing'; }
  return {title: String(j.title || '카드뉴스').slice(0, 80), musicPrompt: String(j.musicPrompt || 'calm modern background music'), cards};
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
