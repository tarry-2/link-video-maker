import React from 'react';
import {z} from 'zod';
import {AbsoluteFill, Audio, Sequence, Series, staticFile, useCurrentFrame, interpolate} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {Scene, sceneSchema} from './Scene';
import {Thumbnail} from './Thumbnail';

// 영상 맨 앞 후킹 인트로(시선폭탄) 길이 — 1.5초.
export const INTRO_FRAMES = 45;

// 썸네일 후킹을 영상 인트로로도 쓴다(유튜브 썸네일과 동일 비주얼 → 영상 첫 1.5초).
export const introSchema = z.object({
  image: z.string(),
  big: z.string(),
  small: z.string().default(''),
  badge: z.string().default(''),
  accentColor: z.string().default('#FFE24B'),
});
export type IntroData = z.infer<typeof introSchema>;

export const videoSchema = z.object({
  scenes: z.array(sceneSchema),
  transitionFrames: z.number(),
  bgmSrc: z.string().optional(), // 자동 생성된 배경음악(public 상대경로)
  voiceSrc: z.string().optional(), // ★통짜 나레이션(전체에 한 번, 자연스러운 억양)
  intro: introSchema.optional(), // 롱폼/숏폼 공통 후킹 인트로(없으면 바로 장면 시작)
  // ★화면비: 쇼츠=세로(portrait 1080×1920) / 롱폼=가로(landscape 1920×1080).
  //   Root.tsx의 calculateMetadata가 이 값으로 Composition width/height를 정한다.
  orientation: z.enum(['portrait', 'landscape']).optional(),
});

export type VideoData = z.infer<typeof videoSchema>;

// 인트로 커버 — 썸네일 위에 살짝 등장 모션(줌아웃+페이드) + 임팩트 효과음.
// ★Thumbnail 자체는 안 건드린다(썸네일 PNG는 frame0 완성형이어야 하므로 모션은 여기 래퍼에서만).
const IntroCover: React.FC<IntroData> = ({image, big, small, badge, accentColor}) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 8], [0, 1], {extrapolateRight: 'clamp'});
  const scale = interpolate(frame, [0, INTRO_FRAMES], [1.09, 1.0]);
  return (
    <AbsoluteFill style={{opacity: op, transform: `scale(${scale})`}}>
      <Sequence durationInFrames={14}>
        <Audio src={staticFile('sfx/impact.mp3')} volume={0.6} />
      </Sequence>
      <Thumbnail image={image} big={big} small={small} badge={badge} accentColor={accentColor} orientation="portrait" />
    </AbsoluteFill>
  );
};

export const Video: React.FC<VideoData> = ({
  scenes,
  transitionFrames,
  bgmSrc,
  voiceSrc,
  intro,
}) => {
  const introFrames = intro ? INTRO_FRAMES : 0;
  return (
    <>
      {/* 통짜 나레이션 — 인트로가 있으면 그만큼 뒤로 밀어 장면과 싱크 유지 */}
      {voiceSrc ? (
        <Sequence from={introFrames}>
          <Audio src={staticFile(voiceSrc)} />
        </Sequence>
      ) : null}
      {/* 배경음악 — 인트로부터 전체에 깔림, 나레이션 안 묻히게 볼륨 낮게 */}
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={0.16} loop /> : null}

      {transitionFrames > 0 ? (
        <TransitionSeries>
          {intro ? (
            <TransitionSeries.Sequence durationInFrames={introFrames}>
              <IntroCover {...intro} />
            </TransitionSeries.Sequence>
          ) : null}
          {scenes.map((scene, i) => (
            <React.Fragment key={i}>
              <TransitionSeries.Sequence durationInFrames={scene.durationInFrames}>
                <Scene {...scene} />
              </TransitionSeries.Sequence>
              {i < scenes.length - 1 ? (
                <TransitionSeries.Transition
                  presentation={i % 2 === 0 ? slide() : fade()}
                  timing={linearTiming({durationInFrames: transitionFrames})}
                />
              ) : null}
            </React.Fragment>
          ))}
        </TransitionSeries>
      ) : (
        // 전환 0 = 컷 편집(통짜 오디오와 딱 맞음)
        <Series>
          {intro ? (
            <Series.Sequence durationInFrames={introFrames}>
              <IntroCover {...intro} />
            </Series.Sequence>
          ) : null}
          {scenes.map((scene, i) => (
            <Series.Sequence key={i} durationInFrames={scene.durationInFrames}>
              <Scene {...scene} />
            </Series.Sequence>
          ))}
        </Series>
      )}
    </>
  );
};
