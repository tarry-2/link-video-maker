// BGM 생성 — ElevenLabs music/compose. 대본 무드(musicPrompt)에 맞는 곡을 영상 길이만큼 생성.
import {writeFile} from 'node:fs/promises';

// BGM은 영상의 핵심 요소 — 실패하면 조용히 넘기지 않고 "왜 실패했는지"를 담아 throw한다.
// (BGM ON으로 만든 영상에서 음악이 빠지면 못 쓴다 → 제작을 멈추고 사유를 보여주는 게 맞다.)
export async function generateBgm(
  key: string,
  prompt: string,
  ms: number,
  outPath: string,
  log?: (m: string) => void,
): Promise<void> {
  let r: Response;
  try {
    r = await fetch('https://api.elevenlabs.io/v1/music/compose', {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        prompt: prompt || 'subtle cinematic background music, calm and modern',
        music_length_ms: Math.max(10000, Math.min(300000, Math.round(ms))),
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e: any) {
    log?.(`[BGM] 요청 실패: ${e.message}`);
    throw new Error(`배경음악 생성 요청이 실패했습니다(네트워크/타임아웃): ${e.message}`);
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch {}
    // 402/할당량·크레딧 부족을 식별해 "충전하라"는 명확한 안내로 바꿔준다. 그 외는 사유 그대로.
    const lowCredit = r.status === 402 || /quota|credit|insufficient|exceed|limit|balance|not enough/i.test(detail);
    log?.(`[BGM] 생성 실패(HTTP ${r.status}) ${detail}`);
    throw new Error(lowCredit
      ? `ElevenLabs 크레딧(할당량)이 부족하거나 한도를 초과했습니다. 충전 후 다시 시도하세요. (HTTP ${r.status})`
      : `배경음악 생성 실패 (HTTP ${r.status}): ${detail || '응답 본문 없음'}`);
  }
  await writeFile(outPath, Buffer.from(await r.arrayBuffer()));
  log?.('[BGM] 배경음악 생성 완료');
}
