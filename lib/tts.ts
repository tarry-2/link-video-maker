// 음성 — ElevenLabs eleven_v4(최신·최고 자연스러움) with-timestamps. 글자별 타이밍 → 단어별 자막 타이밍(Remotion words).
import {writeFile} from 'node:fs/promises';
import {getStyle} from './styles';

// 목소리 목록 — 실제 ElevenLabs 한국어 보이스를 용도별로 큐레이션.
// use: 어떤 콘텐츠에 어울리는지(issue=이슈/경고/미스터리 진중, info=정보/건강 신뢰,
//      sell=판매/리뷰 밝음, heal=힐링/음식/여행 따뜻, anime=애니/동화/키즈 밝고 명랑). gender: 남/여.
export type VoiceInfo = {
  label: string;
  id: string;
  note: string;
  tip: string; // 이럴 때 쓰세요(사용자 가이드)
  gender: '남' | '여';
  use: ('issue' | 'info' | 'sell' | 'heal' | 'anime')[];
  anime?: boolean; // 애니/동화/키즈 전용 목소리(밝고 명랑, 성인 나레이션과 분리 표시)
  cat: string; // ★콘텐츠 카테고리(목소리 선택을 용도별로 묶어 보여줌 — 스릴러·시사·힐링 등, 테리 지시)
};
export const VOICES: Record<string, VoiceInfo> = {
  // ── 남성 진중(이슈·경고·미스터리) — 무게감·긴장감 ──
  shin: {label: 'Shin · 깊고 묵직', id: 'GNmgFU0yNiLKxTCw3OT9', note: '깊고 묵직한 저음', tip: '🎬 미스터리·사건·다큐에. 긴장감과 몰입을 줄 때', gender: '남', use: ['issue', 'info'], cat: '🎬 스릴러·미스터리'},
  juan: {label: 'Juan · 깊고 프로', id: 'hjCvGtSCRPyjYwe2lDf1', note: '깊고 또렷한 전문 나레이터', tip: '📰 시사·이슈·경고성 콘텐츠에. 신뢰감 있게', gender: '남', use: ['issue', 'info'], cat: '📰 시사·뉴스'},
  mirae: {label: 'Mirae · 차분 중년', id: 'TdWVmpJ5ISmH5crnLTIJ', note: '차분한 중년 남성', tip: '💰 재테크·창업·전문 정보에. 믿음직하게', gender: '남', use: ['issue', 'info'], cat: '💰 재테크·전문'},
  // ── 남성 자연(정보·건강) — 로봇소리 없는 자연스러움 ──
  jaewon: {label: 'Jaewon · 가장 자연', id: 'CcEnHvRQWqsfDDMt24RK', note: '로봇소리 0, 가장 사람같은', tip: '✅ AI 티 안 나게 하고 싶을 때 1순위. 어떤 정보든 무난', gender: '남', use: ['info', 'issue'], cat: '✅ 자연·무난(만능)'},
  hocho: {label: 'HoCho · 차분 신뢰', id: 'ZXhi0czBiSzyk3bQNu5W', note: '차분하고 신뢰가는', tip: '💊 건강·상식 정보에. 안정감 있게 설명', gender: '남', use: ['info'], cat: '💊 건강·정보'},
  mj: {label: 'MJ · 또렷 차분', id: 'jctVgUrrEJoJjGpfN5Ef', note: '또렷하고 자연스러운', tip: '💻 IT·리뷰에. 깔끔하고 명확하게', gender: '남', use: ['info', 'sell'], cat: '💻 IT·리뷰'},
  // ── 남성 밝음(판매·리뷰) — 에너지 ──
  clamon: {label: 'Clamon · 에너지', id: 'WXwRayfQq3D3Kys5yMx9', note: '밝고 에너지 넘치는', tip: '🛍️ 상품 홍보·광고에. 텐션 올려 구매 자극', gender: '남', use: ['sell'], cat: '🛍️ 광고·판매'},
  // ── 여성 따뜻(힐링·음식·여행) ──
  kyung: {label: 'Kyung · 따뜻 여성', id: 'JQaWvPoEUkcuOTfxFYpJ', note: '따뜻하고 차분한 여성 나레이터', tip: '🐾 반려동물·여행·힐링에. 포근하게', gender: '여', use: ['heal', 'info'], cat: '🌿 힐링·감성'},
  luna: {label: 'Luna · 다정 여성', id: 'kZJ3sOVD7WvNyF75aJZW', note: '다정하고 부드러운', tip: '🍳 음식·감성 콘텐츠에. 사랑스럽게', gender: '여', use: ['heal', 'sell'], cat: '🌿 힐링·감성'},
  suzie: {label: 'Suzie · 차분 30대', id: 'UqW1DivwFt1NwUMSGnTn', note: '차분한 30대 여성', tip: '🌿 건강·힐링·정보에. 편안하고 신뢰감', gender: '여', use: ['info', 'heal'], cat: '🌿 힐링·감성'},
  // ── 여성 밝음(판매·리뷰) ──
  yuna: {label: 'Yuna · 밝은 여성', id: 'ajfBUI2mmJMjvf2H6Yw7', note: '밝고 발랄한', tip: '✨ 꿀팁·리뷰·판매에. 발랄하고 친근하게', gender: '여', use: ['sell', 'heal'], cat: '🛍️ 광고·판매'},

  // ── 🎨 애니/동화/키즈 전용 — 밝고 명랑, 아이가 봐도 재밌는 톤(성인 나레이션과 분리) ──
  sujin: {label: 'Sujin · 명랑 애니', id: '9cino9hfS3ougiPeFvp1', note: '명랑하고 친근한 여성', tip: '🎨 애니·동화·키즈에. 밝고 사랑스럽게 들려줄 때', gender: '여', use: ['anime', 'heal'], anime: true, cat: '🎨 애니·동화'},
  juwon: {label: 'Juwon · 활기 애니', id: 'oZLQ9kHPMuIyd7Ja0YNU', note: '활기차고 표현력 풍부한 여성', tip: '🎨 애니·동화에. 리액션 크고 생동감 있게 읽어줄 때', gender: '여', use: ['anime', 'sell'], anime: true, cat: '🎨 애니·동화'},
  bokdeok: {label: 'Bokdeok · 맑은 누나', id: 'PjmtdeplRoyIlaqlTeS3', note: '맑고 밝은 누나 톤', tip: '🎨 애니·키즈에. 깨끗하고 또렷하게 동화 읽어줄 때', gender: '여', use: ['anime', 'heal'], anime: true, cat: '🎨 애니·동화'},
  taek: {label: 'Taek · 친근 소년', id: 'rCm09Tf1yMYbOyCRLDyB', note: '친근하고 동적인 소년 톤', tip: '🎨 애니·모험·동화에. 주인공 소년처럼 신나게', gender: '남', use: ['anime', 'info'], anime: true, cat: '🎨 애니·동화'},
  deoksu: {label: 'Deoksu · 귀여운 캐릭', id: 'IAETYMYM3nJvjnlkVTKI', note: '통통하고 귀여운 캐릭터 남성', tip: '🎨 애니·코믹에. 엉뚱하고 귀여운 캐릭터로', gender: '남', use: ['anime', 'sell'], anime: true, cat: '🎨 애니·동화'},
};

// 애니 스타일 기본 목소리(사용자가 목소리 직접 안 고르면 이걸로 추천).
export const ANIME_DEFAULT_VOICE = 'sujin';
// ★최후 기본 목소리 — 반드시 VOICES에 실존하는 키여야 한다. (예전 'adam'은 VOICES에 없어서
//   VOICES.adam.id가 undefined.id로 터졌다 → 가장 자연스러운 jaewon으로.)
export const DEFAULT_VOICE = 'jaewon';

// 목소리 키 결정 — 단일 소스. 사용자가 고른 게 있으면 그걸, 없으면 애니면 애니 목소리, 아니면 카테고리 추천,
// 최후엔 DEFAULT_VOICE. ★항상 VOICES에 존재하는 키를 반환(없는 키면 DEFAULT로 보정). 모든 경로가 이걸 써야 일관.
export function pickVoice(voice: string | undefined, presetVoice: string | undefined, imageStyle?: string): string {
  // 스타일이 애니 보이스 계열(키즈 동화)일 때만 애니 기본 목소리로. 칠판·인포 등 신규 일러스트는 카테고리 추천 유지.
  const animeVoice = getStyle(imageStyle).animeVoice;
  const pick = voice || (animeVoice ? ANIME_DEFAULT_VOICE : (presetVoice || DEFAULT_VOICE));
  return VOICES[pick] ? pick : DEFAULT_VOICE;
}

export type CharAlign = {ch: string; start: number; end: number}[];
export type Word = {t: string; s: number; e: number}; // s,e = 프레임

// 음성용 텍스트 정제 — TTS가 느낌표에 인위적으로 억양을 확 올려(로봇처럼) 끊는 걸 방지.
// 자막(화면)에는 원문 그대로 두고, ★음성으로 보낼 때만 부호를 부드럽게 바꾼다.
function speakable(text: string): string {
  return text
    .replace(/[!]+/g, ',') // 느낌표 → 쉼표(자연스러운 짧은 쉼, 억양 안 튐)
    .replace(/[?]{2,}/g, '?') // 물음표 연발 정리
    .replace(/~+/g, '') // 물결은 음성에선 무의미 → 제거
    .replace(/\.{2,}/g, ',') // 말줄임표 → 쉼표
    .replace(/([가-힣])\1{2,}/g, '$1$1') // 같은 글자 3번 이상 반복 축소(휘휘휘휘→휘휘)
    .replace(/,\s*,+/g, ',') // 쉼표 중복 정리
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ElevenLabs 음성 생성 + 글자별 타이밍 반환
export async function ttsEleven(
  key: string,
  text: string,
  outPath: string,
  voiceId: string,
): Promise<CharAlign | null> {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: 'POST',
      headers: {'xi-api-key': key, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        text: speakable(text).slice(0, 2500),
        // ★eleven_v4 = 최신·가장 자연스럽고 감정 풍부(테리 청취 확정 2026-09-30). 한국어+타임스탬프 지원.
        model_id: 'eleven_v4',
        voice_settings: {
          // ★감정 살아있게: style 0=관심없는 낭독 → 0.35로 올려 몰입감. stability 0.4(너무 높으면 로봇).
          stability: 0.4,
          similarity_boost: 0.8,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!r.ok)
    throw new Error(
      `ElevenLabs 실패 ${r.status}: ${(await r.text()).slice(0, 150)}`,
    );
  const d: any = await r.json();
  await writeFile(outPath, Buffer.from(d.audio_base64, 'base64'));
  const al = d.alignment || d.normalized_alignment;
  if (!al?.characters) return null;
  return al.characters.map((ch: string, i: number) => ({
    ch,
    start: al.character_start_times_seconds[i],
    end: al.character_end_times_seconds[i],
  }));
}

// ★통짜 나레이션: 여러 장면 대사를 한 번에 TTS 생성 → 억양이 자연스럽게 이어짐(조각내면 억양이 반대로 노는 문제 해결).
// 반환: 통짜 오디오 파일 + 글자별 align + 각 장면의 [시작초, 끝초] 구간.
export async function ttsElevenJoined(
  key: string,
  narrations: string[],
  outPath: string,
  voiceId: string,
): Promise<{align: CharAlign | null; sceneRanges: [number, number][]}> {
  // 장면 사이에 자연스러운 쉼(마침표+공백)을 넣어 한 문단으로 읽게 한다.
  const speakables = narrations.map((n) => speakable(n));
  const joined = speakables.join(' ');
  const align = await ttsEleven(key, joined, outPath, voiceId);
  if (!align) return {align: null, sceneRanges: narrations.map(() => [0, 0])};

  // 공백 제거한 연속 글자열에서 각 장면 텍스트가 차지하는 구간을 찾는다.
  // ★장면 경계를 글자 개수가 아니라 '한글/숫자 글자 매칭'으로 잡는다.
  //   (ElevenLabs가 89→"팔십구"로 풀어읽어 글자수가 안 맞는 문제 방지)
  //   각 장면 텍스트의 핵심 글자를 align에서 순차 소비하며 끝 위치를 찾는다.
  const audioEnd = align[align.length - 1].end;
  const sceneRanges: [number, number][] = [];
  let ci = 0; // align 커서
  for (let si = 0; si < speakables.length; si++) {
    const isLast = si === speakables.length - 1;
    // 이 장면에서 소비할 '한글' 글자들(숫자·영문·기호는 매칭 불안정하니 한글만 기준)
    const targetHangul = speakables[si].replace(/[^가-힣]/g, '');
    const startT = align[Math.min(ci, align.length - 1)]?.start ?? 0;
    let matched = 0;
    let lastEnd = startT;
    if (isLast) {
      // 마지막 장면은 무조건 오디오 끝까지
      lastEnd = audioEnd;
      ci = align.length;
    } else {
      const need = targetHangul.length;
      while (ci < align.length && matched < need) {
        const ch = align[ci].ch;
        if (/[가-힣]/.test(ch)) {
          // 다음 기대 글자와 같으면 매칭(달라도 진행 — 숫자 풀어읽기 흡수)
          matched++;
          lastEnd = align[ci].end;
        }
        ci++;
      }
      // 다음 장면 시작 전 공백/기호는 이번 장면 끝에 포함(자연스러운 컷)
      while (ci < align.length && !/[가-힣0-9A-Za-z]/.test(align[ci].ch)) {
        lastEnd = align[ci].end;
        ci++;
      }
    }
    sceneRanges.push([startT, lastEnd]);
  }
  return {align, sceneRanges};
}

// 글자별 타이밍 → 단어별 {t, s(프레임), e(프레임)}.
// baseSec=이 장면이 통짜 오디오에서 시작하는 시각(자막 프레임을 장면 로컬로 맞춤).
// clip=이 장면 구간 [시작초,끝초]가 주어지면 그 구간의 글자만 사용(통짜 오디오 공유용).
export function alignToWords(
  align: CharAlign | null,
  fps: number,
  baseSec = 0,
  clip?: [number, number],
): Word[] {
  if (!align?.length) return [];
  const words: Word[] = [];
  let cur = '';
  let startT = 0;
  let lastEnd = 0;
  const flush = () => {
    if (cur.trim()) {
      words.push({
        t: cur.trim(),
        s: Math.round((startT - baseSec) * fps),
        e: Math.round((lastEnd - baseSec) * fps),
      });
    }
    cur = '';
  };
  for (const c of align) {
    if (clip && (c.start < clip[0] - 0.05 || c.end > clip[1] + 0.05)) continue;
    if (/\s/.test(c.ch)) {
      flush();
    } else {
      if (!cur) startT = c.start;
      cur += c.ch;
      lastEnd = c.end;
    }
  }
  flush();
  return words;
}

// 오디오 길이(초) — 단어 타이밍 마지막 값으로 근사(정확한 값은 렌더 시 ffprobe로 보정 가능)
export function audioDurationFromAlign(align: CharAlign | null): number {
  if (!align?.length) return 0;
  return align[align.length - 1].end;
}
