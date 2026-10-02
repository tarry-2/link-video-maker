// ─────────────────────────────────────────────────────────────────────────
// 스킨(디자인 시스템) 레지스트리
// 테리 요구: "주제가 다양하니까 100개 뽑으면 100개가 다 다른 모션그래픽 카드".
// → 덱마다 스킨 하나를 골라(통일감) 폰트·배경·색처리·장식·모션 안무가 통째로 달라진다.
//   스킨이 15종이고 각 스킨 안에서도 카드타입별 레이아웃/강조색이 달라지므로 조합은 수백 가지.
// 데이터 전용 모듈(JSX 없음). 실제 배경/장식 렌더러는 Card.tsx가 id로 분기.
// ─────────────────────────────────────────────────────────────────────────

export type BgType =
  | 'mesh' | 'dots' | 'diagonal' | 'blob' | 'blueprint' | 'spotlight'
  | 'paper' | 'memphis' | 'halftone' | 'wave' | 'grid' | 'rings'
  | 'confetti' | 'gradient';

export type DecoType =
  | 'none' | 'corner-brackets' | 'tape' | 'sticker-dots' | 'star-burst'
  | 'underline-marker' | 'frame' | 'side-bar';

// 단어 등장 안무.
export type Entrance = 'up' | 'fall' | 'pop' | 'flip' | 'rotate' | 'zoomblur';

export type MotionBase = 'pop' | 'slide' | 'type' | 'zoom' | 'flip';

export interface Skin {
  id: string;
  name: string;            // 한국어 표기(로그/UI용)
  headFont: string;        // 헤드라인 폰트 패밀리(Card loadFont와 일치)
  bodyFont?: string;       // 본문 폰트(기본 Noto Sans KR)
  headTracking: string;    // letterSpacing
  headTransform?: 'uppercase' | 'none';
  theme: 'light' | 'dark' | 'auto'; // 덱 톤 바이어스(auto=카드 기본값 유지)
  bg: BgType;
  deco: DecoType;
  motion: MotionBase;      // Reveal 기본 모션
  entrance: Entrance;      // 단어 키네틱 안무
  stagger: number;         // 단어 간 지연(프레임)
  radius: number;          // 패널/칩 모서리(px). 0=샤프(스위스), 큰값=둥근
  moods: string[];         // 어울리는 주제 키워드(자동 매칭용)
}

const NOTO = 'Noto Sans KR';

export const SKINS: Skin[] = [
  {
    id: 'editorial-bold', name: '에디토리얼 볼드',
    headFont: 'Black Han Sans', headTracking: '-1.2px', theme: 'light',
    bg: 'mesh', deco: 'none', motion: 'slide', entrance: 'up', stagger: 2.5, radius: 22,
    moods: ['뉴스', '이슈', '정보', '일반'],
  },
  {
    id: 'soft-rounded', name: '소프트 라운드',
    headFont: 'Jua', headTracking: '-0.5px', theme: 'light',
    bg: 'dots', deco: 'sticker-dots', motion: 'pop', entrance: 'pop', stagger: 2.2, radius: 30,
    moods: ['반려동물', '힐링', '일상', '육아', '꿀팁'],
  },
  {
    id: 'neon-tech', name: '네온 테크',
    headFont: 'Gothic A1', headTracking: '-0.5px', headTransform: 'none', theme: 'dark',
    bg: 'blueprint', deco: 'corner-brackets', motion: 'slide', entrance: 'zoomblur', stagger: 2, radius: 10,
    moods: ['IT', '테크', '과학', '신기한사실', 'AI'],
  },
  {
    id: 'luxury-serif', name: '럭셔리 세리프',
    headFont: 'Noto Serif KR', headTracking: '-1px', theme: 'dark',
    bg: 'spotlight', deco: 'frame', motion: 'type', entrance: 'zoomblur', stagger: 3, radius: 4,
    moods: ['럭셔리', '뷰티', '재테크', '부동산', '브랜드'],
  },
  {
    id: 'magazine-serif', name: '매거진 세리프',
    headFont: 'Gowun Batang', headTracking: '-0.5px', theme: 'light',
    bg: 'paper', deco: 'underline-marker', motion: 'type', entrance: 'up', stagger: 2.6, radius: 6,
    moods: ['여행', '에세이', '건강', '음식', '문화'],
  },
  {
    id: 'memphis-pop', name: '멤피스 팝',
    headFont: 'Do Hyeon', headTracking: '-0.5px', theme: 'light',
    bg: 'memphis', deco: 'star-burst', motion: 'pop', entrance: 'pop', stagger: 2, radius: 24,
    moods: ['재미', '밈', '트렌드', '엔터', '쇼핑'],
  },
  {
    id: 'hand-note', name: '손글씨 노트',
    headFont: 'Gaegu', headTracking: '0px', theme: 'light',
    bg: 'grid', deco: 'tape', motion: 'type', entrance: 'fall', stagger: 2.4, radius: 14,
    moods: ['공부', '정리', '꿀팁', '일상', '다이어리'],
  },
  {
    id: 'gradient-vivid', name: '그라데이션 비비드',
    headFont: 'Black Han Sans', headTracking: '-1.2px', theme: 'dark',
    bg: 'gradient', deco: 'none', motion: 'zoom', entrance: 'rotate', stagger: 2.2, radius: 20,
    moods: ['동기부여', '성공', '창업', '마케팅', '자극'],
  },
  {
    id: 'halftone-retro', name: '하프톤 레트로',
    headFont: 'Do Hyeon', headTracking: '-0.5px', theme: 'light',
    bg: 'halftone', deco: 'corner-brackets', motion: 'slide', entrance: 'up', stagger: 2.4, radius: 8,
    moods: ['레트로', '복고', '만화', '썰', '미스터리'],
  },
  {
    id: 'wave-calm', name: '웨이브 캄',
    headFont: 'Gowun Batang', headTracking: '-0.5px', theme: 'light',
    bg: 'wave', deco: 'none', motion: 'type', entrance: 'up', stagger: 2.8, radius: 18,
    moods: ['힐링', '명상', '수면', '감성', '바다'],
  },
  {
    id: 'radar-data', name: '레이더 데이터',
    headFont: 'Gothic A1', headTracking: '-0.5px', theme: 'dark',
    bg: 'rings', deco: 'frame', motion: 'slide', entrance: 'up', stagger: 2, radius: 10,
    moods: ['경제', '재테크', '통계', '주식', '데이터'],
  },
  {
    id: 'mono-swiss', name: '모노 스위스',
    headFont: 'Gothic A1', headTracking: '-1.5px', headTransform: 'none', theme: 'light',
    bg: 'grid', deco: 'side-bar', motion: 'slide', entrance: 'up', stagger: 2.2, radius: 0,
    moods: ['미니멀', '디자인', '건축', '비즈니스', '정보'],
  },
  {
    id: 'confetti-celebrate', name: '컨페티 셀러브레이트',
    headFont: 'Jua', headTracking: '-0.5px', theme: 'dark',
    bg: 'confetti', deco: 'star-burst', motion: 'pop', entrance: 'pop', stagger: 2, radius: 28,
    moods: ['축하', '이벤트', '기념일', '파티', '선물'],
  },
  {
    id: 'blur-cinema', name: '블러 시네마',
    headFont: 'Song Myung', headTracking: '0px', theme: 'dark',
    bg: 'spotlight', deco: 'none', motion: 'type', entrance: 'zoomblur', stagger: 3.2, radius: 4,
    moods: ['감성', '영화', '스토리', '밤', '시'],
  },
  {
    id: 'blob-fresh', name: '블롭 프레시',
    headFont: 'Do Hyeon', headTracking: '-0.5px', theme: 'light',
    bg: 'blob', deco: 'sticker-dots', motion: 'pop', entrance: 'pop', stagger: 2.2, radius: 26,
    moods: ['음식', '레시피', '다이어트', '운동', '건강'],
  },
];

export type SkinId = (typeof SKINS)[number]['id'];

export function getSkin(id?: string): Skin {
  return SKINS.find((s) => s.id === id) || SKINS[0];
}

// 문자열 → 안정적 해시(주제로 스킨 선택 시 결정적).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 주제/카테고리로 어울리는 스킨 자동 선택(테리 "제목 자동인식→모션그래픽").
// moods 키워드가 주제에 걸리면 그 후보들 중 해시로 하나, 없으면 전체에서 해시로.
export function pickSkin(topic: string, category?: string): Skin {
  const hay = `${topic} ${category || ''}`;
  const matches = SKINS.filter((s) => s.moods.some((m) => hay.includes(m)));
  const pool = matches.length ? matches : SKINS;
  return pool[hashStr(hay) % pool.length];
}
