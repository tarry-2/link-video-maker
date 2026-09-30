// 음성 파일 → 단어별 타이밍(STT). 클로바처럼 타임스탬프 안 주는 TTS의 자막 싱크용.
// ElevenLabs STT(scribe_v1)가 단어별 타임스탬프를 준다(이미 결제된 키 재사용).
import {readFile} from 'node:fs/promises';
import type {Word} from './tts';

// STT로 음성에서 단어 타이밍 추출. 각 장면 구간별로 나눠 반환.
// sceneTexts=장면별 나레이션(구간 나누기용), fps, audioPath=통짜 음성.
export async function sttWords(
  key: string,
  audioPath: string,
  fps: number,
): Promise<{words: {t: string; startSec: number; endSec: number}[]}> {
  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buf]), 'audio.mp3');
  form.append('model_id', 'scribe_v1');
  form.append('timestamps_granularity', 'word');
  form.append('language_code', 'kor');

  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {'xi-api-key': key},
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`STT 실패 ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d: any = await r.json();
  const words = (d.words || [])
    .filter((w: any) => w.type !== 'spacing' && (w.text || '').trim())
    .map((w: any) => ({
      t: (w.text || '').trim(),
      startSec: w.start ?? 0,
      endSec: w.end ?? 0,
    }));
  return {words};
}

// STT 단어들을 장면별 구간으로 분배 + Remotion Word(프레임)로 변환.
// 장면 경계는 나레이션 글자 비율로 근사(클로바는 문장 순서대로 읽으므로 순차 매칭).
export function splitWordsByScene(
  sttWordsArr: {t: string; startSec: number; endSec: number}[],
  sceneTexts: string[],
  fps: number,
): {words: Word[]; startSec: number; endSec: number}[] {
  // 각 장면의 한글 글자수 비율로 STT 단어를 순차 배분
  const totalHangul = sceneTexts.map((s) => s.replace(/[^가-힣]/g, '').length);
  const grandTotal = totalHangul.reduce((a, b) => a + b, 0) || 1;
  const totalWords = sttWordsArr.length;
  const out: {words: Word[]; startSec: number; endSec: number}[] = [];
  let wi = 0;
  for (let si = 0; si < sceneTexts.length; si++) {
    const isLast = si === sceneTexts.length - 1;
    const share = Math.round((totalHangul[si] / grandTotal) * totalWords);
    const take = isLast ? sttWordsArr.length - wi : Math.max(1, share);
    const chunk = sttWordsArr.slice(wi, wi + take);
    wi += take;
    if (!chunk.length) {
      out.push({words: [], startSec: 0, endSec: 0});
      continue;
    }
    const startSec = chunk[0].startSec;
    const endSec = chunk[chunk.length - 1].endSec;
    const words: Word[] = chunk.map((w) => ({
      t: w.t,
      s: Math.round((w.startSec - startSec) * fps),
      e: Math.round((w.endSec - startSec) * fps),
    }));
    out.push({words, startSec, endSec});
  }
  return out;
}
