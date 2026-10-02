import React from 'react';
import {Composition} from 'remotion';
import {Video, videoSchema} from './Video';
import {Thumbnail, thumbnailSchema} from './Thumbnail';
import {CardVideo, cardVideoSchema} from './CardVideo';
import {Card, cardSchema} from './Card';
import type {SceneData} from './Scene';
import type {CardData} from './Card';

const w = (parts: [string, number, number][]) =>
  parts.map(([t, s, e]) => ({t, s, e}));

// 데모 4장면(퀄 검증용). 실제로는 파이프라인이 대본→장면으로 주입.
const demoScenes: SceneData[] = [
  {
    image: 'news1.jpg',
    hookTop: '무제한 데이터에 월 3만 원',
    hookAccent: '지원금?',
    accentColor: '#FFE24B',
    punch: true,
    durationInFrames: 90,
    words: w([
      ['월', 6, 18],
      ['7만 원', 18, 34],
      ['요금이', 34, 50],
      ['정말', 50, 64],
      ['공짜가', 64, 80],
      ['된다고?', 80, 90],
    ]),
  },
  {
    image: 'news2.jpg',
    hookTop: '정부가 챙겨주는',
    hookAccent: '숨은 통신 지원금',
    accentColor: '#4FE0D0',
    durationInFrames: 90,
    words: w([
      ['조건만', 6, 20],
      ['맞으면', 20, 34],
      ['매달', 34, 48],
      ['최대', 48, 60],
      ['3만 원을', 60, 76],
      ['돌려받아요', 76, 90],
    ]),
  },
  {
    image: 'news3.jpg',
    hookTop: '하지만 놓치면',
    hookAccent: '오히려 손해',
    accentColor: '#FF6B5E',
    durationInFrames: 90,
    words: w([
      ['소득', 8, 22],
      ['기준을', 22, 38],
      ['넘으면', 38, 54],
      ['회수될', 54, 70],
      ['수도', 70, 82],
    ]),
    comment: {user: '김민수', text: '이거 몰라서 3년 손해봤네요 ㅠㅠ', likes: '4.2천'},
  },
  {
    image: 'news4.jpg',
    hookTop: '결론부터 말하면',
    hookAccent: '지금 바로 신청',
    accentColor: '#FFE24B',
    durationInFrames: 90,
    words: w([
      ['3분이면', 8, 24],
      ['끝나니까', 24, 40],
      ['오늘', 40, 54],
      ['꼭', 54, 64],
      ['확인하세요', 64, 88],
    ]),
  },
];

// 카드뉴스 데모(8종 타입 전부 — 렌더 검증용).
const demoCards: CardData[] = [
  {type: 'cover', accent: '#FFD84D', bg: 'news1.jpg', badge: '꿀팁', small: '매일 아침 붓는 당신께', big: '아침 부기 3분 컷', body: '딱 3가지만 바꾸면 끝', durationInFrames: 75, index: 0, total: 8},
  {type: 'number', accent: '#12A998', theme: 'light', kicker: '건강 꿀팁', title: '아침 부기, 사실은', number: '87', unit: '%', body: '잘못된 수면 자세와 야식 때문이에요.', durationInFrames: 75, index: 1, total: 8},
  {type: 'list', accent: '#E8609A', theme: 'light', kicker: '건강 꿀팁', title: '부기 빼는 3단계', items: ['일어나자마자 미지근한 물 한 컵', '귀 뒤에서 쇄골로 쓸어내리기 10번', '찬물 세수 30초로 혈관 수축'], durationInFrames: 90, index: 2, total: 8},
  {type: 'quote', accent: '#12A998', theme: 'light', title: '부기는 습관이\n만든다', body: '피부과 전문의', durationInFrames: 75, index: 3, total: 8},
  {type: 'compare', accent: '#2Bb673', theme: 'light', title: '자기 전 이것만 바꿔도', before: '라면·짠 음식 야식 → 다음날 얼굴 땡땡', after: '물 한 컵 + 종아리 스트레칭 → 아침 개운', durationInFrames: 90, index: 4, total: 8},
  {type: 'fix', accent: '#12A998', theme: 'light', title: '흔한 실수', wrong: '아침에 뜨거운 물로 세수한다', right: '찬물로 혈관을 수축시킨다', durationInFrames: 85, index: 5, total: 8},
  {type: 'body', accent: '#E8609A', theme: 'light', kicker: '건강 꿀팁', title: '꾸준함이 핵심', body: '하루 딱 3분. 2주만 지나면 몸이 기억해서 아침마다 반복할 필요도 없어요.', durationInFrames: 75, index: 6, total: 8},
  {type: 'closing', accent: '#FFD84D', bg: 'news4.jpg', title: '오늘부터 시작해요', body: '내일 아침이 달라집니다', durationInFrames: 85, index: 7, total: 8},
];

export const RemotionRoot: React.FC = () => {
  const transitionFrames = 15;
  return (
    <>
    <Composition
      id="Video"
      component={Video}
      fps={30}
      width={1080}
      height={1920}
      schema={videoSchema}
      defaultProps={{scenes: demoScenes, transitionFrames}}
      calculateMetadata={({props}) => {
        const total = props.scenes.reduce(
          (a, s) => a + s.durationInFrames,
          0,
        );
        const overlap =
          props.transitionFrames * Math.max(0, props.scenes.length - 1);
        // ★화면비: 롱폼=가로(1920×1080) / 그 외=세로(1080×1920). orientation 미지정=세로(무회귀).
        const landscape = props.orientation === 'landscape';
        return {
          durationInFrames: total - overlap,
          width: landscape ? 1920 : 1080,
          height: landscape ? 1080 : 1920,
        };
      }}
    />
    {/* 카드뉴스 영상 — 카드 8종 슬라이드 + 나레이션/BGM 토글 */}
    <Composition
      id="CardVideo"
      component={CardVideo}
      fps={30}
      width={1080}
      height={1920}
      schema={cardVideoSchema}
      defaultProps={{cards: demoCards, transitionFrames}}
      calculateMetadata={({props}) => {
        const total = props.cards.reduce((a, c) => a + c.durationInFrames, 0);
        const overlap = props.transitionFrames * Math.max(0, props.cards.length - 1);
        const landscape = props.orientation === 'landscape';
        return {durationInFrames: total - overlap, width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920};
      }}
    />
    {/* 카드 1장 스틸(게시물/캐러셀용) — 인스타 피드 비율 4:5(1080×1350). 애니 정착 프레임에서 렌더. */}
    <Composition
      id="CardStill"
      component={Card}
      durationInFrames={60}
      fps={30}
      width={1080}
      height={1350}
      schema={cardSchema}
      defaultProps={demoCards[1]}
    />
    {/* 전용 썸네일(커버) — renderStill 전용 1프레임 컴포지션 */}
    <Composition
      id="Thumbnail"
      component={Thumbnail}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      schema={thumbnailSchema}
      defaultProps={{image: 'news1.jpg', big: '월 3만원 공짜', small: '정부가 챙겨주는', badge: '실화?', accentColor: '#FFE24B', orientation: 'portrait' as const}}
      calculateMetadata={({props}) => {
        const landscape = props.orientation === 'landscape';
        return {width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920};
      }}
    />
    </>
  );
};
