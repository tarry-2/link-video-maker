// render.ts 검증: 더미 scenes를 코드에서 주입해 MP4가 나오는지 확인(키 불필요).
import {renderVideo} from '../lib/render';
import type {SceneData} from '../src/Scene';

const w = (parts: [string, number, number][]) =>
  parts.map(([t, s, e]) => ({t, s, e}));

const scenes: SceneData[] = [
  {
    image: 'news1.jpg',
    hookTop: '프로그래매틱 렌더',
    hookAccent: '코드로 영상 생성',
    accentColor: '#FFE24B',
    punch: true,
    durationInFrames: 90,
    words: w([
      ['이건', 6, 20],
      ['CLI', 20, 34],
      ['없이', 34, 48],
      ['코드에서', 48, 66],
      ['렌더한', 68, 82],
      ['결과', 82, 90],
    ]),
  },
  {
    image: 'news2.jpg',
    hookTop: '파이프라인이',
    hookAccent: '이 함수만 호출',
    accentColor: '#4FE0D0',
    durationInFrames: 90,
    words: w([
      ['대본', 6, 20],
      ['이미지', 20, 36],
      ['음성을', 36, 52],
      ['만들어', 52, 68],
      ['넘기면', 68, 82],
      ['끝', 82, 90],
    ]),
    comment: {user: '테리', text: '오 이제 진짜 되네', likes: '9.9천'},
  },
];

renderVideo(scenes, 15, 'out/prog-test.mp4', (m) => console.log(m))
  .then(() => console.log('✅ 프로그래매틱 렌더 성공'))
  .catch((e) => {
    console.error('❌ 실패:', e);
    process.exit(1);
  });
