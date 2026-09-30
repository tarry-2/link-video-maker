import React from 'react';
import {z} from 'zod';
import {Audio, Series, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {Scene, sceneSchema} from './Scene';

export const videoSchema = z.object({
  scenes: z.array(sceneSchema),
  transitionFrames: z.number(),
  bgmSrc: z.string().optional(), // 자동 생성된 배경음악(public 상대경로)
  voiceSrc: z.string().optional(), // ★통짜 나레이션(전체에 한 번, 자연스러운 억양)
  // ★화면비: 쇼츠=세로(portrait 1080×1920) / 롱폼=가로(landscape 1920×1080).
  //   Root.tsx의 calculateMetadata가 이 값으로 Composition width/height를 정한다.
  //   Scene.tsx는 useVideoConfig()의 width/height로 세로·가로 레이아웃을 분기한다.
  orientation: z.enum(['portrait', 'landscape']).optional(),
});

export type VideoData = z.infer<typeof videoSchema>;

export const Video: React.FC<VideoData> = ({
  scenes,
  transitionFrames,
  bgmSrc,
  voiceSrc,
}) => {
  return (
    <>
      {/* 통짜 나레이션 — 전체에 한 번(장면별로 안 쪼개서 억양이 자연스럽게 흐름) */}
      {voiceSrc ? <Audio src={staticFile(voiceSrc)} /> : null}
      {/* 배경음악 — 나레이션 안 묻히게 볼륨 낮게, 길면 반복 */}
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={0.16} loop /> : null}

      {transitionFrames > 0 ? (
        <TransitionSeries>
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
