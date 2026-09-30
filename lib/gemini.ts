// Gemini 호출 — 퍼블리(neighbor-bot/naver.ts) 방식 그대로 이식.
// ★모델 폴백(GEMINI_MODELS 순서대로) + ★키 폴백(한 키 소진되면 다음 키).
// 2.5계열은 thinkingBudget:0(생각 토큰 끄고 출력 넉넉히), 429/한도 포함 어떤 실패든 다음으로.

export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
];

export type GeminiImage = {mimeType: string; dataB64: string};

export type GeminiOpts = {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  images?: GeminiImage[]; // ★비전: 이미지 첨부(수동 모드에서 이미지 분석용)
  log?: (m: string) => void;
};

export async function geminiGenerate(
  keys: string[],
  prompt: string,
  opts: GeminiOpts = {},
): Promise<string> {
  const log = opts.log || (() => {});
  const maxOutputTokens = opts.maxTokens ?? 2048;
  const temperature = opts.temperature ?? 1.0;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const cleanKeys = keys.map((k) => k.trim()).filter(Boolean);
  if (!cleanKeys.length) throw new Error('Gemini 키가 없습니다.');

  let sawQuota = false;
  // ★키 폴백: 키 하나가 모든 모델에서 실패(한도 등)하면 다음 키로 넘어간다.
  for (let ki = 0; ki < cleanKeys.length; ki++) {
    const key = cleanKeys[ki];
    // ★모델 폴백: 퍼블리와 동일하게 모델을 순서대로 시도.
    for (const model of GEMINI_MODELS) {
      try {
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens,
          temperature,
        };
        // ★2.5계열: thinking 토큰을 먼저 소비 → 출력이 잘림. thinking 끄고 토큰 넉넉히.
        if (model.startsWith('gemini-2.5'))
          generationConfig.thinkingConfig = {thinkingBudget: 0};
        if (opts.json) generationConfig.responseMimeType = 'application/json';

        // 이미지가 있으면 parts에 inline_data로 첨부(비전)
        const parts: any[] = [{text: prompt}];
        if (opts.images?.length)
          for (const img of opts.images)
            parts.push({inlineData: {mimeType: img.mimeType, data: img.dataB64}});

        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              contents: [{parts}],
              generationConfig,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const d: any = await r.json();
        // ★어떤 실패든(429 한도 포함) 다음 모델/키로 폴백. 한 모델 429여도 다른 건 한도 남아있음.
        if (!r.ok) {
          if (
            r.status === 429 ||
            /quota|exceeded|rate.?limit/i.test(d?.error?.message || '')
          ) {
            sawQuota = true;
            log(`[Gemini] 키${ki + 1} ${model} 한도(${r.status}) → 다음`);
          } else {
            log(`[Gemini] 키${ki + 1} ${model} 실패(${r.status}) → 다음`);
          }
          continue;
        }
        const cand = d?.candidates?.[0];
        const raw = cand?.content?.parts?.[0]?.text?.trim();
        const finish = cand?.finishReason;
        if (!raw) {
          log(`[Gemini] 키${ki + 1} ${model} 빈 응답(${finish || '?'}) → 다음`);
          continue;
        }
        if (finish === 'MAX_TOKENS') {
          log(`[Gemini] 키${ki + 1} ${model} 잘림(MAX_TOKENS) → 다음`);
          continue;
        }
        return raw;
      } catch (e: any) {
        log(`[Gemini] 키${ki + 1} ${model} 오류(${e.message}) → 다음`);
      }
    }
  }
  throw new Error(
    sawQuota
      ? '모든 Gemini 키/모델 한도 소진'
      : '모든 Gemini 키/모델 생성 실패',
  );
}
