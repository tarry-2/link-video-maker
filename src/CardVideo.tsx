import React from 'react';
import {z} from 'zod';
import {Audio, Series, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {slide} from '@remotion/transitions/slide';
import {Card, cardSchema} from './Card';

export const cardVideoSchema = z.object({
  cards: z.array(cardSchema),
  transitionFrames: z.number(),
  bgmSrc: z.string().optional(),   // 배경음악(토글 ON일 때)
  voiceSrc: z.string().optional(), // 나레이션 통짜(토글 ON일 때). 없으면 '카드만' 모드.
  orientation: z.enum(['portrait', 'landscape']).optional(),
});
export type CardVideoData = z.infer<typeof cardVideoSchema>;

// 카드뉴스 영상 — 카드가 슬라이드로 넘어감. 나레이션 OFF면 BGM만(진짜 카드뉴스).
export const CardVideo: React.FC<CardVideoData> = ({cards, transitionFrames, bgmSrc, voiceSrc}) => {
  return (
    <>
      {voiceSrc ? <Audio src={staticFile(voiceSrc)} /> : null}
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={voiceSrc ? 0.16 : 0.32} loop /> : null}
      {transitionFrames > 0 ? (
        <TransitionSeries>
          {cards.map((card, i) => (
            <React.Fragment key={i}>
              <TransitionSeries.Sequence durationInFrames={card.durationInFrames}>
                <Card {...card} />
              </TransitionSeries.Sequence>
              {i < cards.length - 1 ? (
                <TransitionSeries.Transition
                  presentation={slide({direction: 'from-right'})}
                  timing={linearTiming({durationInFrames: transitionFrames})}
                />
              ) : null}
            </React.Fragment>
          ))}
        </TransitionSeries>
      ) : (
        <Series>
          {cards.map((card, i) => (
            <Series.Sequence key={i} durationInFrames={card.durationInFrames}>
              <Card {...card} />
            </Series.Sequence>
          ))}
        </Series>
      )}
    </>
  );
};
