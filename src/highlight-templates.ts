// 유튜브 하이라이트 전용 디자인 템플릿(프리미엄 프리셋).
// 후킹 글자·박스·자막 스타일을 통째로 바꿔 "알파컷 상위호환"의 다양한 룩을 만든다.
// 데이터 전용(JSX 없음) — Scene.tsx fullBleed가 id로 스타일을 읽어 렌더한다.
// 폰트 패밀리는 Scene.tsx loadFont와 일치해야 함(9종: Black Han Sans/Gothic A1/Song Myung/
//   Gowun Batang/Jua/Do Hyeon/Gaegu/Noto Serif KR/Noto Sans KR).

export type HookStyle = 'box' | 'bar' | 'none' | 'bubble' | 'gradient';
export type SubStyle = 'bar' | 'box' | 'plain';

export interface HighlightTemplate {
  id: string;
  name: string;            // 한국어 표기(UI)
  headFont: string;        // 후킹 폰트
  hookStyle: HookStyle;    // 후킹 컨테이너 처리
  hookBg: string;          // 박스/바/버블 배경(none이면 무시)
  hookBorder: string;      // 테두리 색('none'이면 없음)
  hookRadius: number;      // 모서리(px)
  textColor: string;       // 후킹 메인 글자색
  accentColor: string;     // 강조(hookAccent) 글자색
  glow: boolean;           // accent 글로우(네온)
  subFont: string;         // 자막 폰트
  subStyle: SubStyle;      // 자막 처리(띠/박스/글자만)
  subActive: string;       // 자막 현재 단어 색
  moods: string[];         // 자동 매칭 키워드
}

const BLACK = 'Black Han Sans';
const GOTHIC = 'Gothic A1';
const SONG = 'Song Myung';
const GOWUN = 'Gowun Batang';
const JUA = 'Jua';
const DOHYEON = 'Do Hyeon';
const NOTO = 'Noto Sans KR';
const SERIF = 'Noto Serif KR';

export const HL_TEMPLATES: HighlightTemplate[] = [
  {
    id: 'variety', name: '예능 자막',
    headFont: BLACK, hookStyle: 'box', hookBg: 'rgba(12,12,16,0.6)', hookBorder: '#FFE24B', hookRadius: 22,
    textColor: '#fff', accentColor: '#FFE24B', glow: false,
    subFont: NOTO, subStyle: 'bar', subActive: '#FFE24B',
    moods: ['예능', '웃긴', '밈', '재미', '일반', '토크', '리얼리티'],
  },
  {
    id: 'impact', name: '임팩트 레드',
    headFont: GOTHIC, hookStyle: 'bar', hookBg: 'linear-gradient(90deg,#e11d1d,#ff4d4d)', hookBorder: 'none', hookRadius: 8,
    textColor: '#fff', accentColor: '#FFE24B', glow: false,
    subFont: GOTHIC, subStyle: 'bar', subActive: '#FFE24B',
    moods: ['스포츠', '뉴스', '충격', '속보', '이슈', '경기', '사건'],
  },
  {
    id: 'cinema', name: '감성 시네마',
    headFont: SONG, hookStyle: 'none', hookBg: 'transparent', hookBorder: 'none', hookRadius: 0,
    textColor: '#fff', accentColor: '#F4D58D', glow: false,
    subFont: SERIF, subStyle: 'plain', subActive: '#F4D58D',
    moods: ['감성', '영화', '드라마', '스토리', '명장면', '밤', '사랑', '이별'],
  },
  {
    id: 'neon', name: '네온 힙',
    headFont: BLACK, hookStyle: 'gradient', hookBg: 'linear-gradient(120deg,rgba(124,76,255,0.85),rgba(255,77,141,0.85))', hookBorder: '#38f9e4', hookRadius: 20,
    textColor: '#fff', accentColor: '#38f9e4', glow: true,
    subFont: NOTO, subStyle: 'box', subActive: '#38f9e4',
    moods: ['트렌드', '힙', '음악', '댄스', '아이돌', '패션', 'MV', '무대'],
  },
  {
    id: 'magazine', name: '매거진 다큐',
    headFont: SERIF, hookStyle: 'box', hookBg: 'rgba(18,18,20,0.72)', hookBorder: '#e8dcc0', hookRadius: 6,
    textColor: '#fff', accentColor: '#E8C87A', glow: false,
    subFont: GOWUN, subStyle: 'bar', subActive: '#E8C87A',
    moods: ['정보', '다큐', '교육', '지식', '역사', '과학', '건강', '경제'],
  },
  {
    id: 'pop', name: '버블 팝',
    headFont: JUA, hookStyle: 'bubble', hookBg: 'rgba(255,255,255,0.94)', hookBorder: '#ff7eb6', hookRadius: 34,
    textColor: '#2b2b33', accentColor: '#ff3d87', glow: false,
    subFont: DOHYEON, subStyle: 'box', subActive: '#ff3d87',
    moods: ['동물', '펫', '힐링', '귀여운', '키즈', '요리', '브이로그', '일상'],
  },
];

export function getHlTemplate(id?: string): HighlightTemplate {
  return HL_TEMPLATES.find((t) => t.id === id) || HL_TEMPLATES[0];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 주제/후킹/제목으로 어울리는 템플릿 자동 선택. 키워드 매칭되면 그 중 해시로, 없으면 전체 해시.
export function pickHlTemplate(hint: string): HighlightTemplate {
  const hay = hint || '';
  const matches = HL_TEMPLATES.filter((t) => t.moods.some((m) => hay.includes(m)));
  const pool = matches.length ? matches : HL_TEMPLATES;
  return pool[hashStr(hay) % pool.length];
}
