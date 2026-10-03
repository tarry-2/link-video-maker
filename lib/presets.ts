// 카테고리 프리셋 엔진 — 목적 × 종류 × 형식을 고르면 그 바닥에 맞는 최적 세팅(대본 톤·이미지 느낌·목소리·BGM·마무리)을 자동 제공.
// 사용자는 카테고리만 선택하면 되고, 나머지는 트렌드/클릭률 기준으로 여기서 결정된다.

export type Goal = 'info' | 'sell'; // 정보성 / 판매성
export type Format = 'short' | 'long'; // 쇼츠 / 롱폼

export type Preset = {
  id: string;
  label: string; // 화면 표시명
  emoji: string;
  goal: Goal;
  group: '정보성' | '유익재미' | '판매성' | '애니';
  anime?: boolean; // 애니 전용 카테고리(이미지=애니 자동, 애니 목소리, 동화·모험 주제 추천)
  // 대본 프롬프트에 주입되는 지침
  toneGuide: string; // 전체 톤·화법
  hookStyle: string; // 후킹(첫 장면) 스타일
  topicGuide: string; // ★주제추천 도메인(이 카테고리에 '딱 맞는' 주제가 뭔지 + 좋은예/나쁜예). /api/topics가 이걸로 주제를 생성해 제작 톤과 추천이 어긋나지 않게.
  endingStyle: string; // 마무리 스타일
  // 비주얼/오디오 자동 세팅
  imageStyle: string; // Flux 프롬프트에 덧붙일 이미지 느낌(영어)
  voice: string; // tts VOICES 키
  musicMood: string; // BGM 무드(영어), 대본 musicPrompt 없을 때 폴백
  accentColors: string[]; // 후킹 강조색 팔레트
};

// 정치·종교·사회갈등·자극 등 민감 주제는 카테고리에 없음 + 대본 프롬프트에서 회피 가드레일 적용.
export const PRESETS: Preset[] = [
  // ── 정보성(배우려고 보는) ──
  {
    id: 'health',
    label: '건강/의학',
    emoji: '💊',
    goal: 'info',
    group: '정보성',
    toneGuide: '신뢰감 있고 차분한 정보 전달. 과장 없이 근거 있게, 그러나 지루하지 않게.',
    hookStyle: '"이거 모르면 손해" 식 경각심 + 의외의 사실 예고.',
    topicGuide:
      '몸·건강·질병 예방·증상 신호·영양·수면·운동 습관 등 "내 몸에 바로 적용하는 건강 정보"만. 좋은 예: "자기 전 이 자세 하나, 허리 디스크 예방". 나쁜 예: 돈·여행·요리 같은 다른 분야 주제.',
    endingStyle:
      '시청자를 향한 건강 응원 한마디로 맺어라(예: "작은 습관 하나가 내일의 나를 바꿉니다", "오늘부터 몸이 고마워할 선택을 해보세요").',
    imageStyle: 'clean realistic lifestyle and medical documentary photography, soft natural light',
    voice: 'suzie',
    musicMood: 'calm hopeful cinematic background, gentle and trustworthy',
    accentColors: ['#4FE0D0', '#B6FF3C', '#FFE24B'],
  },
  {
    id: 'money',
    label: '재테크/돈',
    emoji: '💰',
    goal: 'info',
    group: '정보성',
    toneGuide: '똑똑하고 실용적인 화법. 숫자와 구체적 이득을 또렷하게.',
    hookStyle: '"월 O만원 차이" 같은 구체적 숫자 충격으로 시작.',
    topicGuide:
      '저축·투자·소비 습관·세금·연금·부수입 등 "돈이 불거나 새는 걸 막는 정보"만. 좋은 예: "통장 3개로 쪼갰더니 1년에 400만원 모였다". 나쁜 예: 건강·요리 같은 돈과 무관한 주제.',
    endingStyle:
      '시청자를 향한 돈 관리 응원 한마디로 맺어라(예: "작은 차이가 통장을 바꿉니다", "오늘의 이 선택이 미래의 여유가 됩니다").',
    imageStyle: 'sleek modern finance and everyday-money scenes, clean minimal realistic photography',
    voice: 'mirae',
    musicMood: 'modern confident background, subtle motivating groove',
    accentColors: ['#FFE24B', '#4FE0D0', '#FF7EB6'],
  },
  {
    id: 'tip',
    label: '꿀팁/생활상식',
    emoji: '🧠',
    goal: 'info',
    group: '정보성',
    toneGuide: '밝고 친근한 화법. "왜 아무도 안 알려줬지?" 하는 발견의 재미.',
    hookStyle: '당연히 알던 걸 뒤집는 반전 사실로 시작.',
    topicGuide:
      '살림·정리·생활 속 몰랐던 상식 등 "오늘 바로 써먹는 생활 꿀팁"만. 좋은 예: "세탁기 이 버튼 하나, 전기세가 확 줄어요". 나쁜 예: 투자·미스터리처럼 생활 꿀팁이 아닌 주제.',
    endingStyle:
      '시청자를 향한 산뜻한 제안 한마디로 맺어라(예: "오늘 한 번 써보면 왜 진작 몰랐나 싶을 거예요", "이 작은 팁이 하루를 편하게 만들어 줍니다").',
    imageStyle: 'bright friendly everyday-life realistic photography, warm tones',
    voice: 'yuna',
    musicMood: 'upbeat light background, playful and clean',
    accentColors: ['#B6FF3C', '#FFE24B', '#4FE0D0'],
  },
  {
    id: 'tech',
    label: 'IT/신기술',
    emoji: '💻',
    goal: 'info',
    group: '정보성',
    toneGuide: '스마트하고 트렌디한 화법. 미래를 앞서 보는 느낌.',
    hookStyle: '"곧 세상이 이렇게 바뀐다" 식 미래 예고.',
    topicGuide:
      'AI·앱·가젯·신기술·IT 서비스·미래 변화 등 "앞서가는 테크 정보"만. 좋은 예: "이 무료 AI 앱 하나면 영상 편집 10분 끝". 나쁜 예: 요리·동물처럼 기술과 무관한 주제.',
    endingStyle:
      '시청자를 향한 미래 전망 한마디로 맺어라(예: "이 변화를 먼저 아는 사람이 앞서갑니다", "곧 우리 일상이 이렇게 달라질 거예요").',
    imageStyle: 'futuristic sleek technology and gadget photography, cinematic tech aesthetic',
    voice: 'jaewon',
    musicMood: 'modern electronic ambient, sleek and futuristic',
    accentColors: ['#4FE0D0', '#7C5CFF', '#FFE24B'],
  },
  // ── 유익+재미(멍때리며 보는) ──
  {
    id: 'fact',
    label: '신기한 사실/잡학',
    emoji: '✨',
    goal: 'info',
    group: '유익재미',
    toneGuide: '흥미진진한 스토리텔링. 계속 다음이 궁금하게.',
    hookStyle: '"믿기지 않겠지만" 식 놀라운 사실로 훅.',
    topicGuide:
      '세상의 놀라운 사실·과학 상식·역사 뒷이야기·몰랐던 잡학 등 "안 믿기는데 진짜인 지식". 좋은 예: "바나나가 사실 베리류라고?". 나쁜 예: 상품 홍보나 생활 꿀팁처럼 실용 정보에 치우친 주제.',
    endingStyle:
      '마지막에 소름 돋는 반전 사실 하나 + 시청자에게 남기는 여운 한마디로 맺어라(예: "세상은 우리가 아는 것보다 훨씬 신기합니다").',
    imageStyle: 'striking cinematic realistic photography, dramatic lighting, sense of wonder',
    voice: 'juan',
    musicMood: 'mysterious intriguing cinematic background, building curiosity',
    accentColors: ['#FF6B5E', '#FFE24B', '#7C5CFF'],
  },
  {
    id: 'food',
    label: '음식/레시피',
    emoji: '🍳',
    goal: 'info',
    group: '유익재미',
    toneGuide: '군침 도는 감각적 묘사. 따라 하고 싶게.',
    hookStyle: '"이 조합 미쳤다" 식 맛의 유혹으로 시작.',
    topicGuide:
      '요리·레시피·식재료 조합·간단한 한 끼 등 "따라 만들고 싶은 음식"만. 좋은 예: "계란 1개로 만드는 10분 폭탄 김밥". 나쁜 예: 미스터리·재테크처럼 음식과 무관한 주제.',
    endingStyle:
      '요리 완성 서술로 끝내지 말고, 시청자를 향한 따뜻한 권유 한마디로 맺어라(예: "오늘 이 한 그릇으로 맛도 건강도 챙겨보세요", "간단한 한 끼가 하루의 행복이 됩니다").',
    imageStyle: 'delicious appetizing food photography, close-up, warm inviting light, high detail',
    voice: 'luna',
    musicMood: 'warm cozy background music, appetizing and pleasant',
    accentColors: ['#FFE24B', '#FF6B5E', '#B6FF3C'],
  },
  {
    id: 'animal',
    label: '반려동물/동물',
    emoji: '🐾',
    goal: 'info',
    group: '유익재미',
    toneGuide: '따뜻하고 사랑스러운 화법. 힐링과 미소.',
    hookStyle: '"이 아이가 한 행동이" 식 귀여운 호기심 훅.',
    topicGuide:
      '반려동물 행동 해석·돌봄 꿀팁·동물의 놀라운 사실 등 "반려·동물 이야기"만. 좋은 예: "강아지가 이 행동하면 보내는 신호예요". 나쁜 예: 돈·여행처럼 동물과 무관한 주제.',
    endingStyle:
      '시청자 마음이 따뜻해지는 한마디로 맺어라(예: "이런 순간들이 우리를 웃게 하죠", "오늘 하루도 반려동물과 행복하세요").',
    imageStyle: 'adorable heartwarming animal photography, soft natural light, cute realistic',
    voice: 'kyung',
    musicMood: 'cute warm playful background, heartwarming',
    accentColors: ['#B6FF3C', '#FF7EB6', '#FFE24B'],
  },
  {
    id: 'travel',
    label: '여행/명소',
    emoji: '🌍',
    goal: 'info',
    group: '유익재미',
    toneGuide: '설레는 여행 감성. 지금 떠나고 싶게.',
    hookStyle: '"여기 진짜 지구 맞아?" 식 절경 훅.',
    topicGuide:
      '실제 여행지·명소·숨은 장소 등 "가보고 싶은 곳"만. ★제목에 실제 지명·고유명사 필수. 좋은 예: "포르투갈 신트라, 동화 속 이 성". 나쁜 예: "숨겨진 여행 명소"처럼 막연히 끝나는 주제.',
    endingStyle:
      '시청자를 향한 여행 권유 한마디로 맺어라(예: "다음 여행지는 여기로 정해보는 건 어떨까요", "언젠가 이곳에서 당신만의 순간을 만나보세요").',
    imageStyle: 'breathtaking travel landscape and cityscape photography, golden hour, cinematic',
    voice: 'kyung',
    musicMood: 'uplifting cinematic travel background, adventurous and warm',
    accentColors: ['#4FE0D0', '#FFE24B', '#FF7EB6'],
  },
  {
    id: 'mystery',
    label: '흥미로운 썰/미스터리',
    emoji: '😲',
    goal: 'info',
    group: '유익재미',
    toneGuide: '긴장감 있는 이야기꾼 화법. 몰입시켜 끝까지.',
    hookStyle: '"그날 벌어진 일은" 식 미스터리 예고.',
    topicGuide:
      '미제사건·도시전설·역사 미스터리·소름 돋는 썰·반전 실화 등 "끝까지 몰입하게 하는 이야기"만. 좋은 예: "60년째 아무도 못 푼 이 암호". 나쁜 예: 건강법·요리·생활 꿀팁 같은 실용 정보(미스터리가 전혀 아님).',
    endingStyle:
      '반전 결말 + 시청자에게 남기는 여운 한마디로 맺어라(예: "진실은 아직도 우리를 궁금하게 합니다", "당신은 어떻게 생각하시나요").',
    imageStyle: 'moody cinematic mysterious photography, dramatic shadows, film-like',
    voice: 'shin',
    musicMood: 'suspenseful dark ambient background, tension building',
    accentColors: ['#FF6B5E', '#7C5CFF', '#FFE24B'],
  },
  {
    id: 'healing',
    label: '힐링/만족',
    emoji: '🌿',
    goal: 'info',
    group: '유익재미',
    toneGuide: '잔잔하고 편안한 화법. 보는 것만으로 힐링.',
    hookStyle: '"잠시 멈추고 보세요" 식 편안한 초대.',
    topicGuide:
      '보기만 해도 편안한 힐링·만족·마음챙김·잔잔한 풍경이나 순간 등 "쉬어가게 하는 소재"만. 좋은 예: "비 오는 창가, 딱 3분만 멍때리기". 나쁜 예: 자극적 이슈나 실용 꿀팁처럼 마음이 바빠지는 주제.',
    endingStyle:
      '시청자 마음이 차분해지는 한마디로 맺어라(예: "오늘 하루도 수고했어요, 잠시 쉬어가세요", "이런 여유가 우리에게 필요합니다").',
    imageStyle: 'serene calming nature and cozy scenes, soft dreamy light, aesthetic',
    voice: 'suzie',
    musicMood: 'peaceful ambient background, soothing and slow',
    accentColors: ['#B6FF3C', '#4FE0D0', '#FF7EB6'],
  },
  // ── 판매성 ──
  {
    id: 'product',
    label: '상품 리뷰/홍보',
    emoji: '🛍️',
    goal: 'sell',
    group: '판매성',
    toneGuide: '경쾌하고 설득력 있는 화법. 갖고 싶게 만든다.',
    hookStyle:
      '첫 3초에 시선을 꽂는 초강력 후킹. 침이 고이게 하거나("이 육즙 실화?"), 손해를 자극하거나("이거 모르고 사면 호구"), 반전을 예고하라("남들 다 속는 이것"). 평범한 소개 절대 금지.',
    topicGuide:
      '특정 상품의 매력·비교·사용 포인트를 파는 소재. 좋은 예: "만원대인데 백화점급, 이 핸드크림". 나쁜 예: 제품과 무관한 일반 상식·잡학.',
    endingStyle:
      '지금 사야 하는 이유 + 구매를 부르는 한마디로 맺어라(예: "이 가격은 지금뿐, 놓치면 후회합니다", "오늘의 나에게 이 정도 선물은 괜찮잖아요").',
    imageStyle: 'attractive product photography, clean studio and lifestyle shots, appealing',
    voice: 'clamon',
    musicMood: 'energetic upbeat commercial background, exciting',
    accentColors: ['#FFE24B', '#FF6B5E', '#4FE0D0'],
  },
  {
    id: 'business',
    label: '창업/서비스',
    emoji: '🏢',
    goal: 'sell',
    group: '판매성',
    toneGuide: '신뢰감 있는 전문가 화법. 기회를 놓치기 아깝게.',
    hookStyle: '"지금 안 하면 손해" 식 기회·이득 강조.',
    topicGuide:
      '창업·부업·서비스·비즈니스 기회 소재. 좋은 예: "무자본으로 월 50 버는 부업 3가지". 나쁜 예: 단순 생활 꿀팁처럼 사업 기회와 무관한 주제.',
    endingStyle:
      '기회를 잡으라는 권유 + 신청/상담을 부르는 한마디로 맺어라(예: "기회는 준비된 사람의 것입니다", "지금 이 순간이 시작하기 가장 좋은 때예요").',
    imageStyle: 'professional trustworthy business and service photography, modern clean',
    voice: 'mirae',
    musicMood: 'confident corporate background, motivating and trustworthy',
    accentColors: ['#4FE0D0', '#FFE24B', '#7C5CFF'],
  },

  // ── 🎨 애니메이션(아이+어른 함께, 캐릭터 일관 유지) ──
  {
    id: 'kids_story',
    label: '동화·모험 이야기',
    emoji: '🧚',
    goal: 'info',
    group: '애니',
    anime: true,
    toneGuide: '따뜻하고 상상력 넘치는 동화 구연 화법. 아이도 어른도 빠져드는 이야기. 다음이 궁금하게, 마음이 몽글몽글하게.',
    hookStyle: '"어느 날 ~에게 신기한 일이 일어났어요" 식, 바로 이야기 속으로 끌어들이는 훅.',
    topicGuide:
      '상상력 넘치는 모험·우정·성장 동화. 다음이 궁금하고 마음이 따뜻해지는, 아이도 어른도 빠져드는 이야기 소재.',
    endingStyle:
      '이야기의 따뜻한 여운 + 작은 교훈/감동 한마디로 맺어라(예: "용기는 작은 마음에서 시작돼요", "오늘도 좋은 꿈 꾸세요").',
    imageStyle: 'whimsical storybook anime illustration, magical and heartwarming, consistent main character, Studio Ghibli inspired',
    voice: 'sora',
    musicMood: 'gentle magical storybook music, warm and whimsical, orchestral lullaby',
    accentColors: ['#FFB3D9', '#A78BFA', '#FFD93D', '#7DD3FC'],
  },
  {
    id: 'kids_safety',
    label: '안전·생활 지킴이',
    emoji: '🛟',
    goal: 'info',
    group: '애니',
    anime: true,
    toneGuide: '아이가 쉽게 이해하는 다정하지만 또렷한 화법. 겁주지 않되 꼭 기억하게. 실제 상황에서 바로 쓸 수 있는 구체적 행동 요령 중심.',
    hookStyle: '"이런 일이 생기면 어떻게 해야 할까요?" 식, 아이가 상황을 떠올리게 하는 질문 훅.',
    topicGuide:
      '아이가 실제로 마주칠 수 있는 안전 상황(낯선 사람이 따라오거나 말 걸 때, 차에 타라 할 때, 교통·불·물·전기 안전, 길 잃었을 때, 위험하면 도움 요청하는 법). 제목에 상황이 드러나고(예: "모르는 사람이 사탕 주며 따라오라 하면?") 올바른 행동을 알려주는 이야기.',
    endingStyle:
      '꼭 기억할 핵심 행동을 한 번 더 또렷하게 + 아이를 안심시키는 한마디로 맺어라(예: "이것만 기억하면 너는 너를 지킬 수 있어요", "무서우면 꼭 어른에게 말해요").',
    imageStyle: 'friendly educational anime illustration for children safety, clear simple scenes, warm and reassuring, consistent child character',
    voice: 'bokdeok',
    musicMood: 'gentle friendly educational music, safe and warm, light and clear',
    accentColors: ['#4FE0D0', '#FFD93D', '#FF9EC4', '#8BE28B'],
  },
  {
    id: 'kids_wisdom',
    label: '지혜·인성 우화',
    emoji: '🦉',
    goal: 'info',
    group: '애니',
    anime: true,
    toneGuide: '이솝우화처럼 짧은 이야기 속에 교훈을 담는 화법. 아이에겐 쉽게, 어른에겐 울림 있게. 억지 교훈 설교 금지, 이야기로 스며들게.',
    hookStyle: '"옛날 옛날, 욕심 많은 ~가 살았어요" 식 우화 도입 훅.',
    topicGuide:
      '정직·배려·우정·용기·욕심 같은 가치를 짧은 이솝우화풍 이야기로. 억지 설교 말고 이야기로 스며들게, 어른도 다시 생각하게 되는 울림.',
    endingStyle:
      '이야기가 주는 교훈을 짧고 울림 있게 한 문장으로 맺어라(예: "진짜 부자는 마음이 넉넉한 사람이에요", "작은 친절이 가장 멀리 갑니다").',
    imageStyle: 'classic fable anime illustration, animals and nature characters, timeless and warm, consistent character design',
    voice: 'taek',
    musicMood: 'warm folk fable music, gentle and wise, acoustic storytelling',
    accentColors: ['#F59E0B', '#8BE28B', '#A78BFA', '#FFD93D'],
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

// 카테고리 → 어울리는 아트스타일 추천(lib/styles.ts의 id). 카테고리 고르면 이미지 스타일이 이걸로 자동 세팅되고
// 갤러리에 ✨추천 배지가 뜬다. "고르면 톤·이미지·목소리·BGM이 자동으로 맞춰져요" 약속을 스타일에도 적용.
export const RECOMMEND_STYLE: Record<string, string> = {
  health: 'chalkboard',   // 교육 설명 최강
  money: 'infographic',   // 숫자·도표
  tip: 'whiteboard',      // How-to 깔끔
  tech: 'cinema',         // 세련·미래
  fact: 'cinema',         // 놀라움·몰입
  food: 'real',           // 군침 도는 실사
  animal: 'real',         // 귀여운 실사
  travel: 'cinema',       // 절경 시네마틱
  mystery: 'cinema',      // 무드·긴장
  healing: 'watercolor',  // 잔잔 감성
  product: 'ugc',         // 진짜 후기 톤
  business: 'infographic',// 전문·데이터
  kids_story: 'anime', kids_safety: 'anime', kids_wisdom: 'anime', // 애니 전용
};

// 화면 그룹핑용(UI에서 그룹별로 카테고리 나열)
export const PRESET_GROUPS = ['정보성', '유익재미', '판매성'] as const;
