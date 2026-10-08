// 디자인 템플릿 "미리보기" 스틸(renderStill 전용 1프레임).
// UI의 템플릿 선택 버튼에 "이런 느낌이구나"를 보여주려고, 실제 영상 프레임(샘플 이미지) 위에
// 그 템플릿의 후킹(박스/바/버블/그라데이션/글자만) + 자막(띠/박스/글자만)을 Scene.tsx fullBleed와
// '똑같은 디자인'으로 얹어 뽑는다. 템플릿은 고정 6종이라 개발 때 한 번 뽑아 web/tpl-preview/에 커밋한다.
import React from 'react';
import {z} from 'zod';
import {AbsoluteFill, Img, staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {getHlTemplate} from './highlight-templates';

loadFont({family: 'Black Han Sans', url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: 'Noto Sans KR', url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});
loadFont({family: 'Gothic A1', url: staticFile('fonts/GothicA1-Black.ttf'), weight: '900'});
loadFont({family: 'Song Myung', url: staticFile('fonts/SongMyung.ttf')});
loadFont({family: 'Gowun Batang', url: staticFile('fonts/GowunBatang-Bold.ttf'), weight: '700'});
loadFont({family: 'Jua', url: staticFile('fonts/Jua.ttf')});
loadFont({family: 'Do Hyeon', url: staticFile('fonts/DoHyeon.ttf')});
loadFont({family: 'Noto Serif KR', url: staticFile('fonts/NotoSerifKR.ttf'), weight: '900'});

export const templatePreviewSchema = z.object({
  template: z.string(),
  image: z.string(),                          // 배경 샘플 이미지(public 경로)
  hookTop: z.string(),
  hookAccent: z.string(),
  subWords: z.array(z.string()),              // 샘플 자막 단어들
  subActiveIndex: z.number(),                 // 강조(현재 말하는) 단어 인덱스
});
export type TemplatePreviewData = z.infer<typeof templatePreviewSchema>;

const outline = (px: number) =>
  `${px}px ${px}px 0 #000, -${px}px ${px}px 0 #000, ${px}px -${px}px 0 #000, -${px}px -${px}px 0 #000, 0 ${px}px 0 #000, 0 -${px}px 0 #000, ${px}px 0 0 #000, -${px}px 0 0 #000`;

export const TemplatePreview: React.FC<TemplatePreviewData> = ({template, image, hookTop, hookAccent, subWords, subActiveIndex}) => {
  const T = getHlTemplate(template);
  // Scene.tsx fullBleed 세로 상수와 동일.
  const L = {
    hookTop: 110, hookPad: '0 70px', fsHookTop: 88, fsHookAccent: 104, hookBoxPad: '22px 42px',
    hlSubTop: 1090, hlSubH: 290, subPad: '0 70px', subGap: '14px 20px', fsSub: 62,
  };

  const hookGlow = T.glow ? `, 0 0 40px ${T.accentColor}66` : '';
  const boxCommon: React.CSSProperties = {
    display: 'inline-block', textAlign: 'center', maxWidth: '94%',
    borderRadius: T.hookRadius, padding: L.hookBoxPad,
    boxShadow: `0 12px 44px rgba(0,0,0,0.55)${hookGlow}`,
  };
  const hookContainerStyle: React.CSSProperties =
    T.hookStyle === 'none'
      ? {display: 'inline-block', textAlign: 'center', maxWidth: '94%'}
      : T.hookStyle === 'bar'
        ? {...boxCommon, background: T.hookBg, padding: '14px 40px', maxWidth: '100%', width: '100%'}
        : {...boxCommon, background: T.hookBg, backdropFilter: 'blur(6px)',
           border: T.hookBorder === 'none' ? undefined : `3px solid ${T.hookBorder}`};
  const lightBg = T.hookStyle === 'bubble';
  const olTop = lightBg ? 0 : 3;

  // ★Scene.tsx와 동일: 띠·박스 제거(영상 안 가림). 가독성은 외곽선+소프트 섀도로. 시네마(plain)는 외곽선만.
  const plain = T.subStyle === 'plain';

  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      <Img src={staticFile(image)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      {/* 글자 가독성용 아주 옅은 어둡게(템플릿 자체 박스가 대부분 가리므로 약하게) */}
      <AbsoluteFill style={{background: 'linear-gradient(to bottom, rgba(0,0,0,0.22) 0%, rgba(0,0,0,0) 32%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.28) 100%)'}} />

      {/* 상단 후킹 — 템플릿별 컨테이너 */}
      {(hookTop || hookAccent) && (
        <div style={{position: 'absolute', top: L.hookTop, left: 0, right: 0, padding: L.hookPad, display: 'flex', justifyContent: 'center'}}>
          <div style={hookContainerStyle}>
            {hookTop && <div style={{fontFamily: T.headFont, fontSize: L.fsHookTop, color: T.textColor,
              lineHeight: 1.08, textShadow: olTop ? outline(olTop) : 'none', letterSpacing: -1,
              wordBreak: 'keep-all', overflowWrap: 'anywhere'}}>{hookTop}</div>}
            {hookAccent && <div style={{fontFamily: T.headFont, fontSize: L.fsHookAccent, color: T.accentColor,
              lineHeight: 1.12, marginTop: 4,
              textShadow: lightBg ? 'none' : `0 3px 14px ${T.accentColor}66, ${outline(olTop)}`,
              letterSpacing: -1, wordBreak: 'keep-all', overflowWrap: 'anywhere'}}>{hookAccent}</div>}
          </div>
        </div>
      )}

      {/* 해설 카라오케 자막 — 템플릿 subStyle별(bar=그라데이션 띠/box=각 단어 박스/plain=글자만) */}
      {subWords.length > 0 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: L.hlSubTop, height: L.hlSubH,
          display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center',
          gap: L.subGap, padding: L.subPad, boxSizing: 'border-box', background: 'transparent',
        }}>
          {subWords.map((t, i) => {
            const active = i === subActiveIndex;
            return (
              <span key={i} style={{
                fontFamily: T.subFont, fontWeight: 800, fontSize: L.fsSub,
                color: active ? T.subActive : '#fff',
                textShadow: plain ? outline(active ? 5 : 4) : `${outline(active ? 5 : 4)}, 0 2px 12px rgba(0,0,0,0.95)`,
                transform: active ? 'scale(1.14)' : 'scale(1)', display: 'inline-block',
              }}>{t}</span>
            );
          })}
        </div>
      )}
    </AbsoluteFill>
  );
};
