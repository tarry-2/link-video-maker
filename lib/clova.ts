// 네이버 클로바보이스(Premium) TTS — 한국어 최강급 자연스러움.
// ★클로바는 글자 타임스탬프를 안 주므로, 생성한 음성을 Whisper STT로 되돌려 단어 타이밍을 얻는다(align.ts).
import {writeFile} from 'node:fs/promises';

// 자연스러운 나레이션용 화자(Pro=최신·감정표현 좋음). use=콘텐츠 매칭용.
export type ClovaVoice = {
  label: string;
  speaker: string;
  gender: '남' | '여';
  tip: string;
  use: ('issue' | 'info' | 'sell' | 'heal')[];
  emotion?: number; // 0평범 1슬픔 2기쁨 3분노(화자별 지원 다름)
};
export const CLOVA_VOICES: Record<string, ClovaVoice> = {
  // 남성
  vdaeseong: {label: '대성 Pro (남·차분)', speaker: 'vdaeseong', gender: '남', tip: '📰 이슈·정보·다큐에. 신뢰가는 중저음', use: ['issue', 'info']},
  jinho: {label: '진호 (남·표준)', speaker: 'jinho', gender: '남', tip: '💡 정보·설명에. 깔끔한 표준 남성', use: ['info']},
  nsangdo: {label: '상도 (남·뉴스)', speaker: 'nsangdo', gender: '남', tip: '📰 뉴스·시사 톤. 아나운서 느낌', use: ['issue', 'info']},
  // 여성
  vgoeun: {label: '고은 Pro (여·따뜻)', speaker: 'vgoeun', gender: '여', tip: '🌿 힐링·음식·여행에. 따뜻하고 자연스러운', use: ['heal', 'info']},
  vara: {label: '아라 Pro (여·밝음)', speaker: 'vara', gender: '여', tip: '🛍️ 리뷰·판매·꿀팁에. 밝고 친근', use: ['sell', 'heal']},
  nara: {label: '아라 (여·표준)', speaker: 'nara', gender: '여', tip: '💡 정보·상식에. 표준 여성', use: ['info']},
};

export async function ttsClova(
  clientId: string,
  clientSecret: string,
  text: string,
  outPath: string,
  speaker: string,
  opts: {speed?: number; pitch?: number; emotion?: number} = {},
): Promise<void> {
  const body = new URLSearchParams({
    speaker,
    text: text.slice(0, 2000),
    format: 'mp3',
    speed: String(opts.speed ?? 0),
    pitch: String(opts.pitch ?? 0),
    'sampling-rate': '24000',
  });
  if (opts.emotion != null) body.set('emotion', String(opts.emotion));

  const r = await fetch('https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts', {
    method: 'POST',
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`클로바 TTS 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  await writeFile(outPath, Buffer.from(await r.arrayBuffer()));
}
