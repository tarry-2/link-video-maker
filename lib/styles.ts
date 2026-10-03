// ─────────────────────────────────────────────────────────────────────────
// 아트스타일 레지스트리 — 제작할 때 "느낌"을 골라 쓴다(기존 real/anime 2택 → 다양화).
// image.ts가 getStyle(id)로 프롬프트 레시피를 받아 Flux에 주입한다.
// ★기존 'real'/'anime'는 레시피를 그대로 보존(호환) + 뒤에 스타일을 "순서대로" 추가.
// 데이터 전용(JSX 없음). UI는 /api/categories가 내보내는 styles로 갤러리를 그린다.
// ─────────────────────────────────────────────────────────────────────────

export interface ArtStyle {
  id: string;
  name: string;            // 한국어 이름(UI)
  emoji: string;
  desc: string;            // 느낌 설명(선택화면 기능설명 — 어떤 느낌/언제 쓰나)
  group: string;           // 갤러리 그룹
  promptAdd: string;       // Flux 프롬프트 뒤에 붙는 영어 스타일
  peopleAdd: string;       // 사람/캐릭터 정책(실사=절제 / 일러스트=허용)
  guidance: number;        // flux-dev guidance(실사=낮게 밸런스, 일러스트=조금 높여 스타일 강조)
  illustration: boolean;   // 일러스트 계열(사진 아님)
  peopleWelcome?: boolean;  // 사람·캐릭터 장면 허용 여부(생략 시 illustration 값 사용). 대본 visualPrompt가 이걸로 사람 묘사 허용/절제.
  animeVoice?: boolean;    // 기본 목소리를 애니 보이스로(키즈 동화 전용)
  characterRef?: boolean;  // nano-banana 캐릭터 참조 사용(주인공 일관)
}

// 이 스타일이 사람/캐릭터를 장면에 넣길 원하는가 — 생략 시 일러스트 계열이면 허용. (실사=절제, UGC=사람 필요)
export function stylePeopleWelcome(s: ArtStyle): boolean {
  return s.peopleWelcome ?? s.illustration;
}

// 기존 image.ts와 100% 동일한 레시피(회귀 방지).
const REAL_STYLE =
  ', ultra-realistic photograph, shot on DSLR, sharp focus, high detail, 8k, professional photography, authentic real-world scene, natural available light, photojournalism, 35mm, realistic skin and textures, natural depth of field, subtle cinematic color grade, indistinguishable from a real photo, no illustration, no CGI, no 3D render, no AI look';
const REAL_NO_PEOPLE =
  ', avoid people, no crowds, no close-up faces, no portraits — focus on objects, places, environments and meaningful details; if a person is unavoidable show only hands, silhouette or back view, small in frame';
const ANIME_STYLE =
  ', charming 2D anime illustration, soft cel shading, clean crisp linework, vibrant pastel color palette, modern Korean webtoon and Studio Ghibli inspired, wholesome and cute, expressive, warm soft lighting, high quality digital art, no photorealism, no 3D render';
const ANIME_PEOPLE =
  ', cute characters and mascots are welcome, appealing and friendly';

export const STYLES: ArtStyle[] = [
  // ── 실사·시네마틱 ──
  {
    id: 'real', name: '실사', emoji: '📷',
    desc: '사진 같은 현실감. 신뢰감 있게 정보를 전달 — 건강·재테크·뉴스·상품에.',
    group: '실사·시네마틱',
    promptAdd: REAL_STYLE, peopleAdd: REAL_NO_PEOPLE, guidance: 3, illustration: false,
  },
  // ── 일러스트·교육 ──
  {
    id: 'anime', name: '애니(웹툰·지브리)', emoji: '🎨',
    desc: '따뜻한 2D 셀 애니. 귀엽고 다정 — 동화·일상·힐링·육아에.',
    group: '일러스트·교육',
    promptAdd: ANIME_STYLE, peopleAdd: ANIME_PEOPLE, guidance: 3.5, illustration: true,
    animeVoice: true, characterRef: true,
  },

  // ── 1차 추가(순서대로) ──
  {
    id: 'chalkboard', name: '칠판 손그림', emoji: '🏫',
    desc: '초록 칠판에 분필로 쓱쓱 그린 교육형. 사람 손맛·진정성, 복잡한 걸 쉽게 — 건강·의학·과학·원리 설명에 최강.',
    group: '일러스트·교육',
    promptAdd:
      ', hand-drawn white chalk illustration on a dark green chalkboard, textured chalk strokes and smudges, educational diagram look, expressive chalk line shading, occasional soft colored-chalk accents, classroom blackboard aesthetic, high quality',
    peopleAdd: ', a clear hand-drawn subject or character rendered in chalk is welcome, friendly and expressive',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'whiteboard', name: '화이트보드 스케치', emoji: '📋',
    desc: '흰 보드에 검정 마커 라인 + 포인트색. 깔끔한 교육 — 꿀팁·비즈니스·How-to에.',
    group: '일러스트·교육',
    promptAdd:
      ', clean whiteboard marker illustration, bold black outline doodle style, minimal flat line art on a pure white background, a few bright marker color accents, explainer sketch look, crisp and tidy',
    peopleAdd: ', simple friendly doodle characters are welcome',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'infographic', name: '플랫 인포그래픽', emoji: '📊',
    desc: '벡터 아이콘·도표·숫자 느낌. Vox 영상에세이 톤 — 통계·경제·시사 정리에.',
    group: '일러스트·교육',
    promptAdd:
      ', modern flat vector infographic illustration, bold simple geometric shapes, clean icon style, limited harmonious color palette, generous negative space, editorial data-visual aesthetic, crisp and professional',
    peopleAdd: ', simple flat vector people and icons are welcome',
    guidance: 3.5, illustration: true,
  },
  // ── 3D·입체 ──
  {
    id: 'clay', name: '클레이메이션', emoji: '🧱',
    desc: '점토 공작 스톱모션. 월레스앤그로밋 향수·공유율↑ — 재미·가족·밈에.',
    group: '3D·입체',
    promptAdd:
      ', claymation stop-motion aesthetic, handmade plasticine clay models, soft studio lighting, tactile fingerprints and sculpt marks, charming miniature set, shallow depth of field, Aardman-inspired',
    peopleAdd: ', cute chunky clay characters are welcome, expressive',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'pixar3d', name: 'Pixar 3D', emoji: '🧸',
    desc: '둥글둥글 3D 캐릭터, 큰 눈·표정. 공감 가고 사랑스러움 — 캐릭터·반려동물·스토리에.',
    group: '3D·입체',
    promptAdd:
      ', Pixar-style 3D render, expressive big eyes, soft global illumination, subsurface scattering, polished rounded shapes, Disney Pixar animated movie aesthetic, high quality 3D',
    peopleAdd: ', charming 3D characters and mascots are welcome, appealing and friendly',
    guidance: 3.5, illustration: true,
  },

  // ── 레트로·텍스처 ──
  {
    id: 'riso', name: '리소그래프', emoji: '🟠',
    desc: '거친 잉크·형광 스팟컬러·오프셋 어긋남. 힙한 인디 감성 — 문화·디자인·전시에.',
    group: '레트로·텍스처',
    promptAdd:
      ', risograph print aesthetic, grainy ink texture, bold fluorescent spot colors, offset misregistration layers, limited two or three color palette, visible halftone grain, indie zine printmaking look',
    peopleAdd: ', simple stylized figures are welcome',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'halftone', name: '하프톤 만화', emoji: '💥',
    desc: '옛 만화책 점묘·굵은 라인·팝아트 음영. 복고 임팩트 — 썰·미스터리·레트로에.',
    group: '레트로·텍스처',
    promptAdd:
      ', vintage comic book illustration, bold black ink outlines, Ben-Day halftone dots shading, retro pop-art color palette, dramatic graphic contrast, 1960s comic print look',
    peopleAdd: ', bold comic-style characters are welcome, expressive',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'collage', name: '콜라주 믹스미디어', emoji: '✂️',
    desc: '사진+종이질감+손글씨 오려붙인 아날로그. 감각적·큐레이션 — 트렌드·에세이에.',
    group: '레트로·텍스처',
    promptAdd:
      ', mixed-media collage illustration, cut-out paper textures with torn edges, layered scraps and scanned objects, handwritten marks and tape, analog scrapbook aesthetic, tactile and artistic',
    peopleAdd: ', cut-out figures and hand-drawn elements are welcome',
    guidance: 3.5, illustration: true,
  },

  // ── 실사·시네마틱(추가) ──
  {
    id: 'ugc', name: 'UGC 리뷰', emoji: '🤳',
    desc: '손에 든 폰으로 찍은 ‘진짜 후기’ 느낌. 자연스럽고 솔직 — 상품 광고·뷰티·체험에.',
    group: '실사·시네마틱',
    promptAdd:
      ', authentic user-generated content photo, handheld smartphone camera look, natural indoor lighting, casual candid everyday realism, slightly imperfect framing, relatable and trustworthy',
    peopleAdd: ', a natural everyday person using or showing the product is welcome, candid and genuine',
    guidance: 3, illustration: false, peopleWelcome: true,
  },
  {
    id: 'cinema', name: '시네마 무드', emoji: '🎞️',
    desc: '얕은 심도·영화 색감·분위기 조명. 몰입감 있는 감성 — 감성 스토리·브랜드·여행에.',
    group: '실사·시네마틱',
    promptAdd:
      ', cinematic film still, shallow depth of field, anamorphic lens look, moody cinematic color grade, atmospheric volumetric lighting, movie-like composition, filmic grain',
    peopleAdd: ', if a person appears keep them cinematic and atmospheric, often silhouette or back view',
    guidance: 3, illustration: false,
  },

  // ── 3D·입체 / 재미·감성(3차) ──
  {
    id: 'papercut', name: '페이퍼컷', emoji: '📄',
    desc: '겹친 종이·부드러운 그림자, 수공예 입체. 아기자기 — 동화·브랜드·명절에.',
    group: '3D·입체',
    promptAdd:
      ', layered papercut craft illustration, cut paper shapes with soft drop shadows, handmade paper texture, sense of depth from stacked layers, tactile paper-art diorama',
    peopleAdd: ', cute papercut characters are welcome',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'meme', name: '밈·브레인롯', emoji: '😂',
    desc: '과장·강렬한 색·중독성. B급 유머 — 엔터·트렌드·바이럴에.',
    group: '재미·감성',
    promptAdd:
      ', absurdist internet meme aesthetic, over-the-top exaggerated expression, bold saturated colors, chaotic playful energy, deep-fried comic punch, highly shareable',
    peopleAdd: ', exaggerated goofy characters are welcome',
    guidance: 3.5, illustration: true,
  },
  {
    id: 'watercolor', name: '수채 감성', emoji: '🎨',
    desc: '번지는 물감·파스텔·종이결. 잔잔하고 따뜻 — 명상·수면·시·감성에.',
    group: '재미·감성',
    promptAdd:
      ', soft watercolor painting, bleeding pigment washes, delicate pastel palette, visible paper grain, dreamy and gentle, hand-painted illustration',
    peopleAdd: ', soft painterly figures are welcome, gentle',
    guidance: 3.5, illustration: true,
  },
];

export type ImageStyle = string; // 스타일 id(레지스트리 키). 과거 'real'|'anime' 호환.
export const STYLE_IDS = STYLES.map((s) => s.id);

export function getStyle(id?: string): ArtStyle {
  return STYLES.find((s) => s.id === id) || STYLES[0];
}
