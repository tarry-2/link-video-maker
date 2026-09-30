import React from 'react';
import {z} from 'zod';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  Img,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import {loadFont} from '@remotion/fonts';

// ★렌더 속도: 로컬 폰트 파일 직접 로드(네트워크 요청 0번). google-fonts는 한글 subset이 수백 chunk라 느림.
const blackFont = 'Black Han Sans';
const notoFont = 'Noto Sans KR';
loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: notoFont, url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});

export const sceneSchema = z.object({
  image: z.string(),
  voiceSrc: z.string().optional(),
  product: z.object({name: z.string(), price: z.string(), benefit: z.string(), url: z.string()}).optional(),
  video: z.string().optional(), // 배경 영상 클립(있으면 이미지 대신 사용)
  hookTop: z.string(),
  hookAccent: z.string(),
  accentColor: z.string(),
  words: z.array(z.object({t: z.string(), s: z.number(), e: z.number()})),
  durationInFrames: z.number(),
  audioStartSec: z.number().optional(), // 통짜 오디오에서 이 장면 시작 시각(참고용)
  punch: z.boolean().optional(), // 첫 장면 줌펀치(스크롤 멈춤 임팩트)
  motion: z.number().optional(), // 켄번스 패턴 번호(장면마다 다른 움직임)
  comment: z
    .object({user: z.string(), text: z.string(), likes: z.string()})
    .optional(), // 이지컷식 댓글 템플릿
});

export type SceneData = z.infer<typeof sceneSchema>;

const outline = (px: number) =>
  `${px}px ${px}px 0 #000, -${px}px ${px}px 0 #000, ${px}px -${px}px 0 #000, -${px}px -${px}px 0 #000, 0 ${px}px 0 #000, 0 -${px}px 0 #000, ${px}px 0 0 #000, -${px}px 0 0 #000`;

export const Scene: React.FC<SceneData> = ({
  image,
  voiceSrc,
  product,
  video,
  hookTop,
  hookAccent,
  accentColor,
  words,
  punch,
  motion,
  comment,
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames, width, height} = useVideoConfig();
  // ★세로(9:16)·가로(16:9) 레이아웃 분기. land=가로. 세로 값은 기존 그대로(무회귀), 가로만 튜닝 상수.
  const land = width > height;
  const L = land
    ? {
        // 가로 1920×1080 — 세로 여백이 좁아 폰트·좌표를 줄이고 좌우 여백은 넓게.
        imgW: '94%', imgH: '88%',
        hookTop: 44, hookPad: '0 100px', fsHookTop: 60, fsHookAccent: 72,
        subBottom: 54, subBottomOverlay: 290, subPad: '0 140px', subGap: '10px 18px', fsSub: 44,
        prodBottom: 40, prodSide: 90, fsProdName: 32, fsProdBenefit: 26, fsProdUrl: 20,
        cmtBottom: 90, cmtSide: 90, cmtAvatar: 64, fsCmtName: 30, fsCmtText: 32, fsCmtLikes: 26,
      }
    : {
        // 세로 1080×1920 — 기존 값 그대로.
        imgW: '92%', imgH: 900,
        hookTop: 110, hookPad: '0 70px', fsHookTop: 88, fsHookAccent: 104,
        subBottom: 170, subBottomOverlay: 360, subPad: '0 70px', subGap: '14px 20px', fsSub: 62,
        prodBottom: 45, prodSide: 65, fsProdName: 36, fsProdBenefit: 28, fsProdUrl: 22,
        cmtBottom: 140, cmtSide: 60, cmtAvatar: 76, fsCmtName: 34, fsCmtText: 38, fsCmtLikes: 30,
      };

  const hookIn = spring({frame, fps, config: {damping: 16, mass: 0.6}});
  const hookY = interpolate(hookIn, [0, 1], [40, 0]);

  // ★역동적 켄번스(Veo 없이 공짜 생동감): 장면마다 다른 움직임(줌인/줌아웃/팬) + 미세 흔들림.
  const p = ((motion ?? 0) % 4 + 4) % 4;
  const dur = durationInFrames || 90;
  let zoom: number;
  let panX = 0;
  let panY = 0;
  if (punch) {
    // 첫 장면 = 강한 줌펀치(크게 시작→빠르게 안정, 스크롤 멈춤)
    zoom = interpolate(frame, [0, 10], [1.4, 1.1], {extrapolateRight: 'clamp'});
  } else if (p === 0) {
    zoom = interpolate(frame, [0, dur], [1.05, 1.22]); // 천천히 줌인
  } else if (p === 1) {
    zoom = interpolate(frame, [0, dur], [1.22, 1.05]); // 줌아웃(전경→전체)
  } else if (p === 2) {
    zoom = 1.14;
    panX = interpolate(frame, [0, dur], [-3.5, 3.5]); // 좌→우 팬
  } else {
    zoom = 1.14;
    panY = interpolate(frame, [0, dur], [-3, 3]); // 위→아래 팬
  }
  // 미세 손떨림(handheld) — 모든 장면에 아주 약하게, 살아있는 느낌
  const shakeX = Math.sin(frame / 8) * 0.35;
  const shakeY = Math.cos(frame / 9) * 0.3;
  const imgTransform = `scale(${zoom}) translate(${panX + shakeX}%, ${panY + shakeY}%)`;

  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {voiceSrc ? <Audio src={staticFile(voiceSrc)} /> : null}
      {/* (나레이션은 Video 전체에 통짜로 깔림 — 여기선 재생 안 함) */}

      {/* 효과음(공짜 청각 임팩트): 첫 장면=임팩트, 나머지=전환 whoosh. 장면 시작에 짧게. */}
      <Sequence durationInFrames={20}>
        <Audio src={staticFile(punch ? 'sfx/impact.mp3' : 'sfx/whoosh.mp3')} volume={0.5} />
      </Sequence>

      {/* 블러 백드롭 (영상이면 영상, 아니면 이미지) */}
      <AbsoluteFill>
        {video ? (
          <OffthreadVideo
            src={staticFile(video)}
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(60px) brightness(0.35)',
              transform: 'scale(1.2)',
            }}
          />
        ) : (
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
        )}
      </AbsoluteFill>

      {/* 중앙 이미지 창 */}
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            width: L.imgW,
            height: L.imgH,
            borderRadius: 28,
            overflow: 'hidden',
            boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
          }}
        >
          {video ? (
            <OffthreadVideo
              src={staticFile(video)}
              style={{width: '100%', height: '100%', objectFit: 'cover'}}
            />
          ) : (
            <Img
              src={staticFile(image)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: imgTransform,
              }}
            />
          )}
        </div>
      </AbsoluteFill>

      {/* 상단 투톤 후킹 */}
      <div
        style={{
          position: 'absolute',
          top: L.hookTop,
          width: '100%',
          textAlign: 'center',
          padding: L.hookPad,
          boxSizing: 'border-box',
          transform: `translateY(${hookY}px)`,
          opacity: hookIn,
        }}
      >
        <div
          style={{
            fontFamily: blackFont,
            fontSize: L.fsHookTop,
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
            fontSize: L.fsHookAccent,
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

      {/* 하단 단어별 자막 */}
      <div
        style={{
          position: 'absolute',
          bottom: product || comment ? L.subBottomOverlay : L.subBottom,
          width: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: L.subGap,
          padding: L.subPad,
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
                fontSize: L.fsSub,
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

      {product ? (
        <div style={{position: 'absolute', bottom: L.prodBottom, left: L.prodSide, right: L.prodSide, padding: '18px 24px', borderRadius: 18,
          background: 'rgba(10,10,12,0.92)', color: '#fff', fontFamily: notoFont, lineHeight: 1.35, overflowWrap: 'anywhere'}}>
          <div style={{fontSize: L.fsProdName, fontWeight: 700}}>{product.name} {product.price}</div>
          {product.benefit ? <div style={{fontSize: L.fsProdBenefit, color: '#4FE0D0'}}>{product.benefit}</div> : null}
          {product.url ? <div style={{fontSize: L.fsProdUrl, marginTop: 6}}>{product.url}</div> : null}
        </div>
      ) : null}

      {/* 이지컷식 댓글 템플릿(옵션) */}
      {comment ? (
        <div
          style={{
            position: 'absolute',
            bottom: L.cmtBottom,
            left: L.cmtSide,
            right: L.cmtSide,
            background: 'rgba(20,20,22,0.92)',
            borderRadius: 24,
            padding: '28px 32px',
            display: 'flex',
            gap: 22,
            alignItems: 'center',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          }}
        >
          <div
            style={{
              width: L.cmtAvatar,
              height: L.cmtAvatar,
              borderRadius: '50%',
              background: 'linear-gradient(135deg,#4FE0D0,#7C5CFF)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: notoFont,
              fontWeight: 800,
              fontSize: L.fsCmtName,
              color: '#fff',
            }}
          >
            {comment.user.slice(0, 1)}
          </div>
          <div style={{flex: 1}}>
            <div
              style={{
                fontFamily: notoFont,
                fontWeight: 800,
                fontSize: L.fsCmtName,
                color: '#fff',
                marginBottom: 6,
              }}
            >
              {comment.user}
            </div>
            <div
              style={{
                fontFamily: notoFont,
                fontWeight: 500,
                fontSize: L.fsCmtText,
                color: '#e8e8ea',
                lineHeight: 1.25,
              }}
            >
              {comment.text}
            </div>
            <div
              style={{
                fontFamily: notoFont,
                fontWeight: 600,
                fontSize: L.fsCmtLikes,
                color: '#9a9aa2',
                marginTop: 10,
              }}
            >
              👍 {comment.likes}　답글
            </div>
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
