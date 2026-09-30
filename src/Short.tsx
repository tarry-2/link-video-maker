import React from 'react';
import {z} from 'zod';
import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import {loadFont as loadBlack} from '@remotion/google-fonts/BlackHanSans';
import {loadFont as loadNoto} from '@remotion/google-fonts/NotoSansKR';

const {fontFamily: blackFont} = loadBlack();
const {fontFamily: notoFont} = loadNoto();

export const shortSchema = z.object({
  image: z.string(),
  hookTop: z.string(),
  hookAccent: z.string(),
  accentColor: z.string(),
  words: z.array(z.object({t: z.string(), s: z.number(), e: z.number()})),
});

// 두꺼운 검정 외곽선(자막이 배경과 안 싸우게)
const outline = (px: number) =>
  `${px}px ${px}px 0 #000, -${px}px ${px}px 0 #000, ${px}px -${px}px 0 #000, -${px}px -${px}px 0 #000, 0 ${px}px 0 #000, 0 -${px}px 0 #000, ${px}px 0 0 #000, -${px}px 0 0 #000`;

export const Short: React.FC<z.infer<typeof shortSchema>> = ({
  image,
  hookTop,
  hookAccent,
  accentColor,
  words,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // 후킹 등장: 아래에서 살짝 올라오며 스프링
  const hookIn = spring({frame, fps, config: {damping: 16, mass: 0.6}});
  const hookY = interpolate(hookIn, [0, 1], [40, 0]);

  // 이미지 켄번스(천천히 줌인)
  const zoom = interpolate(frame, [0, 150], [1.06, 1.16]);

  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {/* 1) 블러 백드롭 — 이미지를 확대·블러·어둡게 깔아 빈 공간을 채운다(레터박스 검정 대신) */}
      <AbsoluteFill>
        <Img
          src={staticFile(image)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(60px) brightness(0.35)',
            transform: 'scale(1.2)',
          }}
        />
      </AbsoluteFill>

      {/* 2) 중앙 이미지 창(레터박스) — 원본 비율 유지, 켄번스 줌 */}
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            width: '92%',
            height: 900,
            borderRadius: 28,
            overflow: 'hidden',
            boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
          }}
        >
          <Img
            src={staticFile(image)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `scale(${zoom})`,
            }}
          />
        </div>
      </AbsoluteFill>

      {/* 3) 상단 투톤 후킹 — 흰색(셋업) + 강조색(펀치), 장면마다 색/문구 다르게 */}
      <div
        style={{
          position: 'absolute',
          top: 110,
          width: '100%',
          textAlign: 'center',
          padding: '0 70px',
          boxSizing: 'border-box',
          transform: `translateY(${hookY}px)`,
          opacity: hookIn,
        }}
      >
        <div
          style={{
            fontFamily: blackFont,
            fontSize: 88,
            lineHeight: 1.12,
            color: '#fff',
            textShadow: outline(5),
            letterSpacing: -1,
          }}
        >
          {hookTop}
        </div>
        <div
          style={{
            fontFamily: blackFont,
            fontSize: 104,
            lineHeight: 1.12,
            color: accentColor,
            textShadow: outline(6),
            marginTop: 6,
            letterSpacing: -1,
          }}
        >
          {hookAccent}
        </div>
      </div>

      {/* 4) 하단 단어별 자막 — 현재 말하는 단어를 강조색+확대로 하이라이트 */}
      <div
        style={{
          position: 'absolute',
          bottom: 170,
          width: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '14px 20px',
          padding: '0 70px',
          boxSizing: 'border-box',
        }}
      >
        {words.map((w, i) => {
          const active = frame >= w.s && frame < w.e;
          return (
            <span
              key={i}
              style={{
                fontFamily: notoFont,
                fontWeight: 800,
                fontSize: 62,
                color: active ? accentColor : '#fff',
                textShadow: outline(active ? 5 : 4),
                transform: active ? 'scale(1.14)' : 'scale(1)',
                display: 'inline-block',
              }}
            >
              {w.t}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
