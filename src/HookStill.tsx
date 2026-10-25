// 하이라이트 빠른 렌더용 '후킹만' 투명 PNG 스틸.
// ffmpeg 합성 경로(highlight-fast)가 이 PNG를 원본 영상 위에 오버레이한다.
// Scene.tsx fullBleed 후킹과 '똑같은 디자인'(템플릿별 박스·색·외곽선)을 그대로 재현 — 화질/디자인 무손실.
import React from 'react';
import {z} from 'zod';
import {AbsoluteFill, staticFile, delayRender, continueRender} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {resolveHook} from './highlight-templates';

const blackFont = 'Black Han Sans';
const EMOJI = ', "Noto Color Emoji"'; // 모든 후킹 글자 fontFamily 끝에 붙여 이모지 폴백
// ★폰트 로딩을 렌더가 '기다리게' 한다 — 이 스틸은 renderStill로 단일 프레임을 즉시 캡처해 ffmpeg로 영상에
//   얹는다(영상 본편의 후킹 띠=제목/소제목). 폰트 로드 전에 찍히면 글자가 폴백/미표시로 깨진다(테리 실측:
//   후킹이 "나왔다 안 나왔다"). delayRender로 로딩 완료까지 블록해 레이스를 제거. 이모지 폴백 포함.
const fontHandle = delayRender('후킹 스틸 폰트 로딩');
Promise.all([
  loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')}),
  loadFont({family: 'Noto Color Emoji', url: staticFile('fonts/NotoColorEmoji.ttf')}),
  loadFont({family: 'Gothic A1', url: staticFile('fonts/GothicA1-Black.ttf'), weight: '900'}),
  loadFont({family: 'Song Myung', url: staticFile('fonts/SongMyung.ttf')}),
  loadFont({family: 'Gowun Batang', url: staticFile('fonts/GowunBatang-Bold.ttf'), weight: '700'}),
  loadFont({family: 'Jua', url: staticFile('fonts/Jua.ttf')}),
  loadFont({family: 'Do Hyeon', url: staticFile('fonts/DoHyeon.ttf')}),
  loadFont({family: 'Noto Serif KR', url: staticFile('fonts/NotoSerifKR.ttf'), weight: '900'}),
]).then(() => continueRender(fontHandle)).catch(() => continueRender(fontHandle));

export const hookStillSchema = z.object({
  hookTop: z.string(),
  hookAccent: z.string(),
  template: z.string().optional(),
  font: z.string().optional(), // 사용자가 고른 제목 폰트(모든 탭 공통). 없으면 템플릿 폰트.
  // ★사용자가 '처음 제작부터' 직접 고르는 띠 디자인(모든 탭 공통). 없으면 템플릿 기본값.
  hookStyle: z.enum(['box', 'bar', 'none', 'bubble', 'gradient']).optional(),
  hookBg: z.string().optional(),     // 띠 바탕색(팔레트 id 또는 CSS)
  textColor: z.string().optional(),
  accentColor: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
});
export type HookStillData = z.infer<typeof hookStillSchema>;

const outline = (px: number) =>
  `${px}px ${px}px 0 #000, -${px}px ${px}px 0 #000, ${px}px -${px}px 0 #000, -${px}px -${px}px 0 #000, 0 ${px}px 0 #000, 0 -${px}px 0 #000, ${px}px 0 0 #000, -${px}px 0 0 #000`;

export const HookStill: React.FC<HookStillData> = ({hookTop, hookAccent, template, font, hookStyle, hookBg, textColor, accentColor, orientation}) => {
  const land = orientation === 'landscape';
  // ★Scene.tsx fullBleed와 '똑같은' 공통 레이어(resolveHook)로 계산 — 두 렌더 경로 디자인 일치(반쪽 패치 방지).
  const R = resolveHook(template, {hookStyle, hookBg, textColor, accentColor, headFont: font});
  const head = R.headFont;
  const L = land
    ? {top: 40, pad: '0 90px', fsTop: 80, fsAcc: 96, boxPad: '18px 46px', thTop: 24, thAcc: 20}
    : {top: 110, pad: '0 70px', fsTop: 88, fsAcc: 104, boxPad: '22px 42px', thTop: 16, thAcc: 14};

  // ★글자 많아지면 크기 축소(테리) — 그래도 2줄 넘으면 clamp로 자른다. "작아지더라도 두 줄로 끝".
  const fit = (text: string, base: number, thresh: number) => {
    const n = (text || '').replace(/\s+/g, '').length;
    return Math.round(base * (n > thresh ? Math.max(0.5, thresh / n) : 1));
  };
  const clamp2: React.CSSProperties = {display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden'};

  const hookGlow = R.glow ? `, 0 0 40px ${R.accentColor}66` : '';
  const boxCommon: React.CSSProperties = {
    display: 'inline-block', textAlign: 'center', maxWidth: '94%',
    borderRadius: R.hookRadius, padding: L.boxPad,
    boxShadow: `0 12px 44px rgba(0,0,0,0.55)${hookGlow}`,
  };
  const container: React.CSSProperties =
    R.hookStyle === 'none'
      ? {display: 'inline-block', textAlign: 'center', maxWidth: '94%'}
      : R.hookStyle === 'bar'
        ? {...boxCommon, background: R.hookBg, padding: '14px 40px', maxWidth: '100%', width: '100%'}
        : {...boxCommon, background: R.hookBg, backdropFilter: 'blur(6px)',
           border: R.hookBorder === 'none' ? undefined : `3px solid ${R.hookBorder}`};
  const ol = R.light ? 0 : 3;

  return (
    <AbsoluteFill style={{backgroundColor: 'transparent'}}>
      <div style={{position: 'absolute', top: L.top, left: 0, right: 0, padding: L.pad, display: 'flex', justifyContent: 'center'}}>
        <div style={container}>
          {hookTop && <div style={{fontFamily: head + EMOJI, fontSize: fit(hookTop, L.fsTop, L.thTop), color: R.textColor,
            lineHeight: 1.08, textShadow: ol ? outline(ol) : 'none', letterSpacing: -1,
            wordBreak: 'keep-all', overflowWrap: 'anywhere', ...clamp2}}>{hookTop}</div>}
          {hookAccent && <div style={{fontFamily: head + EMOJI, fontSize: fit(hookAccent, L.fsAcc, L.thAcc), color: R.accentColor,
            lineHeight: 1.12, marginTop: 4,
            textShadow: R.light ? 'none' : `0 3px 14px ${R.accentColor}66, ${outline(ol)}`,
            letterSpacing: -1, wordBreak: 'keep-all', overflowWrap: 'anywhere', ...clamp2}}>{hookAccent}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
};
