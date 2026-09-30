// OpenAI 폴백 — Gemini 키가 없거나 실패할 때 대본 생성용(테리: OpenAI는 보관, 쓸 때 씀).
export async function openaiJson(
  key: string,
  prompt: string,
  maxTokens = 4096,
): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{role: 'user', content: prompt}],
      response_format: {type: 'json_object'},
      max_tokens: maxTokens,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(90000),
  });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`OpenAI 실패(${r.status}): ${d?.error?.message || ''}`);
  return d.choices?.[0]?.message?.content || '';
}
