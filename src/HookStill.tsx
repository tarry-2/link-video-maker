// 하이라이트 빠른 렌더용 '후킹만' 투명 PNG 스틸.
// ffmpeg 합성 경로(highlight-fast)가 이 PNG를 원본 영상 위에 오버레이한다.
// Scene.tsx fullBleed 후킹과 '똑같은 디자인'(템플릿별 박스·색·외곽선)을 그대로 재현 — 화질/디자인 무손실.
import React from 'react';
import {z} from 'zod';
import {AbsoluteFill, staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {getHlTemplate} from './highlight-templates';

const blackFont = 'Black Han Sans';
loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: 'Gothic A1', url: staticFile('fonts/GothicA1-Black.ttf'), weight: '900'});
loadFont({family: 'Song Myung', url: staticFile('fonts/SongMyung.ttf')});
loadFont({family: 'Gowun Batang', url: staticFile('fonts/GowunBatang-Bold.ttf'), weight: '700'});
loadFont({family: 'Jua', url: staticFile('fonts/Jua.ttf')});
loadFont({family: 'Do Hyeon', url: staticFile('fonts/DoHyeon.ttf')});
loadFont({family: 'Noto Serif KR', url: staticFile('fonts/NotoSerifKR.ttf'), weight: '900'});

export const hookStillSchema = z.object({
  hookTop: z.string(),
  hookAccent: z.string(),
  template: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
});
export type HookStillData = z.infer<typeof hookStillSchema>;

const outline = (px: number) =>
  `${px}px ${px}px 0 #000, -${px}px ${px}px 0 #000, ${px}px -${px}px 0 #000, -${px}px -${px}px 0 #000, 0 ${px}px 0 #000, 0 -${px}px 0 #000, ${px}px 0 0 #000, -${px}px 0 0 #000`;

export const HookStill: React.FC<HookStillData> = ({hookTop, hookAccent, template, orientation}) => {
  const land = orientation === 'landscape';
  const T = getHlTemplate(template);
  // Scene.tsx fullBleed와 동일 상수(세로/가로).
  const L = land
    ? {top: 40, pad: '0 90px', fsTop: 80, fsAcc: 96, boxPad: '18px 46px'}
    : {top: 110, pad: '0 70px', fsTop: 88, fsAcc: 104, boxPad: '22px 42px'};

  const hookGlow = T.glow ? `, 0 0 40px ${T.accentColor}66` : '';
  const boxCommon: React.CSSProperties = {
    display: 'inline-block', textAlign: 'center', maxWidth: '94%',
    borderRadius: T.hookRadius, padding: L.boxPad,
    boxShadow: `0 12px 44px rgba(0,0,0,0.55)${hookGlow}`,
  };
  const container: React.CSSProperties =
    T.hookStyle === 'none'
      ? {display: 'inline-block', textAlign: 'center', maxWidth: '94%'}
      : T.hookStyle === 'bar'
        ? {...boxCommon, background: T.hookBg, padding: '14px 40px', maxWidth: '100%', width: '100%'}
        : {...boxCommon, background: T.hookBg, backdropFilter: 'blur(6px)',
           border: T.hookBorder === 'none' ? undefined : `3px solid ${T.hookBorder}`};
  const lightBg = T.hookStyle === 'bubble';
  const ol = lightBg ? 0 : 3;

  return (
    <AbsoluteFill style={{backgroundColor: 'transparent'}}>
      <div style={{position: 'absolute', top: L.top, left: 0, right: 0, padding: L.pad, display: 'flex', justifyContent: 'center'}}>
        <div style={container}>
          {hookTop && <div style={{fontFamily: T.headFont, fontSize: L.fsTop, color: T.textColor,
            lineHeight: 1.08, textShadow: ol ? outline(ol) : 'none', letterSpacing: -1,
            wordBreak: 'keep-all', overflowWrap: 'anywhere'}}>{hookTop}</div>}
          {hookAccent && <div style={{fontFamily: T.headFont, fontSize: L.fsAcc, color: T.accentColor,
            lineHeight: 1.12, marginTop: 4,
            textShadow: lightBg ? 'none' : `0 3px 14px ${T.accentColor}66, ${outline(ol)}`,
            letterSpacing: -1, wordBreak: 'keep-all', overflowWrap: 'anywhere'}}>{hookAccent}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
};
