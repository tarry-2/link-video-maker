// BGM 생성 — ElevenLabs music/compose. 대본 무드(musicPrompt)에 맞는 곡을 영상 길이만큼 생성.
import {writeFile} from 'node:fs/promises';

export async function generateBgm(
  key: string,
  prompt: string,
  ms: number,
  outPath: string,
  log?: (m: string) => void,
): Promise<boolean> {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/music/compose', {
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
    if (!r.ok) {
      log?.(`[BGM] 생성 실패(${r.status}) → 음악 없이 진행`);
      return false;
    }
    await writeFile(outPath, Buffer.from(await r.arrayBuffer()));
    log?.('[BGM] 배경음악 생성 완료');
    return true;
  } catch (e: any) {
    log?.(`[BGM] 생성 오류(${e.message}) → 음악 없이 진행`);
    return false;
  }
}
