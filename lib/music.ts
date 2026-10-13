// BGM 생성 — ElevenLabs music/compose. 대본 무드(musicPrompt)에 맞는 곡을 영상 길이만큼 생성.
import {writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ★Remotion은 헤더/duration이 비정상인 mp3(스트리밍형 등)를 "Could not play audio(MediaError)"로 거부한다.
//   ElevenLabs 원본을 그대로 쓰면 가끔 그런 파일이 와 렌더가 통째로 실패 → ffmpeg로 표준 CBR mp3(Xing 헤더)로
//   재인코딩해 항상 디코딩되게 정상화한다.
function reencodeMp3(src: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-i', src, '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-write_xing', '1', out]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
  });
}

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
    // ★크레딧 부족 판정은 '엄격하게' — 흔한 단어("limit"·"exceed")만으로 단정하면, 길이제한·기능미지원 등
    //   다른 실패를 "크레딧 없음"으로 오판한다(테리: 6만 크레딧 있는데 크레딧 없다고 나옴). 명확한 신호만 인정.
    const lowCredit = r.status === 402
      || /quota_exceeded|insufficient|not enough credit|credit.{0,12}(exceed|insufficient|run out|depleted)|balance.{0,12}(low|insufficient|zero)/i.test(detail);
    log?.(`[BGM] 생성 실패(HTTP ${r.status}) ${detail}`);
    // 진짜 사유(HTTP·본문)를 항상 붙여 보여준다 — 오판 없이 원인이 바로 드러나게.
    throw new Error(lowCredit
      ? `ElevenLabs 크레딧(할당량) 부족으로 보입니다. 충전 후 다시 시도하세요. (HTTP ${r.status}: ${detail || '본문 없음'})`
      : `배경음악 생성 실패 (HTTP ${r.status}): ${detail || '응답 본문 없음'}`);
  }
  const raw = Buffer.from(await r.arrayBuffer());
  const tmpRaw = outPath + '.raw.mp3';
  await writeFile(tmpRaw, raw);
  // ffmpeg로 표준 mp3 재인코딩(Remotion 디코딩 보장). 실패하면 원본으로 폴백.
  try {
    await reencodeMp3(tmpRaw, outPath);
    await rm(tmpRaw).catch(() => {});
  } catch (e: any) {
    log?.('[BGM] 재인코딩 건너뜀(원본 사용): ' + (e?.message || '').slice(0, 120));
    await writeFile(outPath, raw);
    await rm(tmpRaw).catch(() => {});
  }
  log?.('[BGM] 배경음악 생성 완료');
}
