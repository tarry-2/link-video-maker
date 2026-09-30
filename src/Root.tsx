import React from 'react';
import {Composition} from 'remotion';
import {Video, videoSchema} from './Video';
import type {SceneData} from './Scene';

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

export const RemotionRoot: React.FC = () => {
  const transitionFrames = 15;
  return (
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
  );
};
