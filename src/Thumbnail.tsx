import React from 'react';
import {z} from 'zod';
import {AbsoluteFill, Img, staticFile, useVideoConfig} from 'remotion';
import {loadFont} from '@remotion/fonts';

// 전용 썸네일(커버) — "시선폭탄" 스타일. 영상 프레임 재활용 X.
// 충격 뱃지 + 초대형 3단어 + 두꺼운 외곽선 + 삐딱한 각도 + 강조링 + 채도 폭발로 "우와 뭐야" 유발.
const blackFont = 'Black Han Sans';
const notoFont = 'Noto Sans KR';
loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: notoFont, url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});

export const thumbnailSchema = z.object({
  image: z.string(),
  big: z.string(), // 초대형 메인(3단어 이하가 최고). 강조색/흰색 번갈아.
  small: z.string().default(''), // 윗줄 보조(작게)
  badge: z.string().default(''), // 충격 뱃지 문구(실화?·경악·충격·소름 등)
  accentColor: z.string().default('#FFE24B'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
});
export type ThumbnailData = z.infer<typeof thumbnailSchema>;

const outline = (px: number, c = '#000') =>
  `${px}px ${px}px 0 ${c}, -${px}px ${px}px 0 ${c}, ${px}px -${px}px 0 ${c}, -${px}px -${px}px 0 ${c}, 0 ${px}px 0 ${c}, 0 -${px}px 0 ${c}, ${px}px 0 0 ${c}, -${px}px 0 0 ${c}, ${px * 2}px 0 0 ${c}, -${px * 2}px 0 0 ${c}, 0 ${px * 2}px 0 ${c}, 0 -${px * 2}px 0 ${c}`;

export const Thumbnail: React.FC<ThumbnailData> = ({image, big, small, badge, accentColor}) => {
  const {width, height} = useVideoConfig();
  const land = width > height;
  // 단어별로 쪼개서 번갈아 색칠(흰/강조) → 리듬감. 아주 큰 폰트.
  const words = big.split(/\s+/).filter(Boolean);
  const bigSize = Math.round(width * (land ? 0.095 : 0.165));
  // 윗줄은 한 줄 유지라, 글자 수가 많으면 폰트를 줄여 화면폭을 안 넘게(대략 글자폭=폰트*1.05).
  const smallBase = width * (land ? 0.042 : 0.072);
  const smallFit = small ? Math.min(smallBase, (width * 0.9) / (small.length * 1.05)) : smallBase;
  const smallSize = Math.round(smallFit);
  const badgeSize = Math.round(width * (land ? 0.075 : 0.125));
  const ol = Math.max(5, Math.round(bigSize * 0.055));

  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {/* 배경 이미지 — 채도·대비 확 올리고 살짝 어둡게 */}
      <Img
        src={image.startsWith('http') || image.startsWith('data:') ? image : staticFile(image)}
        style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'saturate(1.45) contrast(1.18) brightness(0.82)'}}
      />
      {/* 비네트 + 하단/상단 암부(글자 대비) */}
      <AbsoluteFill style={{background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,.55) 100%)'}} />
      <AbsoluteFill
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.12) 30%, rgba(0,0,0,.12) 60%, rgba(0,0,0,.78) 100%)',
        }}
      />

      {/* 충격 뱃지 — 우상단, 크고 삐딱하게. 흰 테두리 + 외곽 글로우로 확 튐 */}
      {badge ? (
        <div
          style={{
            position: 'absolute',
            top: height * 0.04,
            right: width * 0.045,
            transform: 'rotate(-7deg)',
            background: 'linear-gradient(160deg, #FF3A3A, #D40000)',
            color: '#fff',
            fontFamily: blackFont,
            fontSize: badgeSize,
            lineHeight: 1,
            padding: `${badgeSize * 0.2}px ${badgeSize * 0.4}px`,
            borderRadius: badgeSize * 0.2,
            border: `${Math.round(badgeSize * 0.1)}px solid #fff`,
            boxShadow: '0 10px 36px rgba(0,0,0,.65), 0 0 0 ' + Math.round(badgeSize * 0.16) + 'px rgba(255,226,75,.9)',
            textShadow: outline(Math.max(2, Math.round(badgeSize * 0.04))),
            letterSpacing: '-2px',
          }}
        >
          {badge}
        </div>
      ) : null}

      {/* 메인 문구 블록 — ★유튜브 썸네일은 하단이 재생시간·제목에 가리므로 세로는 상단(뱃지 아래)에 둔다.
          가로(16:9)는 세로 중앙-좌측(여기도 하단 UI 회피). */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 'auto',
          top: land ? '50%' : height * 0.17,
          transform: land ? 'translateY(-50%) rotate(-2deg)' : 'rotate(-2deg)',
          width: land ? '58%' : '100%',
          padding: land ? '0 4% 0 5%' : '0 5%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: height * 0.012,
          textAlign: 'center',
        }}
      >
        {small ? (
          <div
            style={{
              fontFamily: notoFont,
              fontWeight: 700,
              fontSize: smallSize,
              color: '#fff',
              background: 'rgba(0,0,0,.6)',
              padding: `${smallSize * 0.12}px ${smallSize * 0.5}px`,
              borderRadius: smallSize * 0.35,
              textShadow: outline(Math.max(2, Math.round(smallSize * 0.06))),
              lineHeight: 1.1,
              whiteSpace: 'nowrap', // 윗줄은 한 줄 유지(어정쩡하게 안 잘리게)
              maxWidth: '96%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {small}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: blackFont,
            fontSize: bigSize,
            lineHeight: 1.0,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: `${bigSize * 0.06}px ${bigSize * 0.14}px`,
          }}
        >
          {words.map((wd, i) => (
            <span
              key={i}
              style={{
                color: i % 2 === 1 ? accentColor : '#fff',
                textShadow: outline(ol),
                WebkitTextStroke: `${Math.round(ol * 0.3)}px #000`,
              }}
            >
              {wd}
            </span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
