import React from 'react';
import {z} from 'zod';
import {
  AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring,
} from 'remotion';
import {loadFont} from '@remotion/fonts';

// 카드뉴스 전용 폰트(Scene과 동일 로컬 로드).
const blackFont = 'Black Han Sans';
const notoFont = 'Noto Sans KR';
loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: notoFont, url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});

// ★카드 8종 — 역할별 레이아웃이 달라야 "다양함"이 된다(글자만 바뀌는 게 아니라).
export const cardSchema = z.object({
  type: z.enum(['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing']),
  bg: z.string().optional(),       // 배경 이미지(public 상대경로). 없으면 그라데이션 배경.
  bgColor: z.string().optional(),  // 그라데이션/단색 배경 기준색.
  accent: z.string(),              // 강조색.
  badge: z.string().optional(),    // 상단 뱃지(표지/숫자).
  title: z.string().optional(),    // 큰 제목/훅/본문 제목.
  body: z.string().optional(),     // 부가 설명.
  number: z.string().optional(),   // 큰 숫자(number).
  unit: z.string().optional(),     // 숫자 단위(%, 명 등).
  items: z.array(z.string()).optional(), // 리스트 항목.
  before: z.string().optional(),   // 비교 전.
  after: z.string().optional(),    // 비교 후.
  wrong: z.string().optional(),    // 실수.
  right: z.string().optional(),    // 해결.
  durationInFrames: z.number(),
  index: z.number(),
  total: z.number(),
});
export type CardData = z.infer<typeof cardSchema>;

// 색 유틸: 배경 그라데이션(이미지 없을 때).
const grad = (c: string) => `linear-gradient(150deg, ${c} 0%, ${shade(c, -28)} 100%)`;
function shade(hex: string, pct: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct < 0 ? 0 : 255; const p = Math.abs(pct) / 100;
  r = Math.round((f - r) * p) + r; g = Math.round((f - g) * p) + g; b = Math.round((f - b) * p) + b;
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export const Card: React.FC<CardData> = (c) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  // 등장 애니메이션(공통): 아래서 올라오며 페이드.
  const ent = spring({frame, fps, config: {damping: 18, mass: 0.7}});
  const up = interpolate(ent, [0, 1], [48, 0]);
  const op = interpolate(frame, [0, 8], [0, 1], {extrapolateRight: 'clamp'});

  const pad = Math.round(width * 0.085);
  const baseColor = c.bgColor || '#1b1b22';

  return (
    <AbsoluteFill style={{background: grad(baseColor), fontFamily: notoFont}}>
      {/* 배경 이미지 모드 — 이미지 위에 어둠 오버레이(글자 가독성). */}
      {c.bg ? (
        <>
          <Img src={staticFile(c.bg)} style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover'}} />
          <AbsoluteFill style={{background: 'linear-gradient(180deg, #00000070 0%, #00000030 40%, #000000aa 100%)'}} />
        </>
      ) : null}

      {/* 상단 진행 점(페이지네이션) */}
      <div style={{position: 'absolute', top: pad * 0.7, left: pad, right: pad, display: 'flex', gap: 8, justifyContent: 'center'}}>
        {Array.from({length: c.total}).map((_, i) => (
          <div key={i} style={{height: 6, flex: 1, maxWidth: 46, borderRadius: 3, background: i <= c.index ? c.accent : '#ffffff40'}} />
        ))}
      </div>

      <AbsoluteFill style={{padding: pad, paddingTop: pad * 1.8, opacity: op, transform: `translateY(${up}px)`}}>
        <Body {...c} width={width} />
      </AbsoluteFill>

      {/* 하단 브랜드/페이지 번호 */}
      <div style={{position: 'absolute', bottom: pad * 0.7, left: pad, right: pad, display: 'flex', justifyContent: 'space-between', color: '#ffffffcc', fontSize: Math.round(width * 0.03), fontWeight: 700}}>
        <span>{c.index + 1} / {c.total}</span>
        <span style={{opacity: 0.8}}>@onvideo</span>
      </div>
    </AbsoluteFill>
  );
};

// 타입별 본문 레이아웃.
const Body: React.FC<CardData & {width: number}> = (c) => {
  const w = c.width;
  const big = (px: number): React.CSSProperties => ({fontFamily: blackFont, fontSize: Math.round(w * px), lineHeight: 1.12, color: '#fff', letterSpacing: '-1px'});
  const sub = (px: number): React.CSSProperties => ({fontFamily: notoFont, fontWeight: 700, fontSize: Math.round(w * px), lineHeight: 1.5, color: '#ffffffe6'});
  const chip = (bg: string): React.CSSProperties => ({display: 'inline-block', padding: '12px 26px', borderRadius: 999, background: bg, color: '#fff', fontFamily: notoFont, fontWeight: 700, fontSize: Math.round(w * 0.042), whiteSpace: 'nowrap', lineHeight: 1});
  const center: React.CSSProperties = {height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28};

  switch (c.type) {
    case 'cover':
      return (
        <div style={center}>
          {c.badge ? <div><span style={chip(c.accent)}>{c.badge}</span></div> : null}
          <div style={big(0.115)}>{c.title}</div>
          {c.body ? <div style={sub(0.05)}>{c.body}</div> : null}
          <div style={{...sub(0.038), color: c.accent, marginTop: 10}}>→ 넘겨서 보기</div>
        </div>
      );
    case 'number':
      return (
        <div style={center}>
          {c.title ? <div style={sub(0.055)}>{c.title}</div> : null}
          <div style={{display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap'}}>
            <span style={{...big(0.26), color: c.accent}}>{c.number}</span>
            {c.unit ? <span style={big(0.09)}>{c.unit}</span> : null}
          </div>
          {c.body ? <div style={sub(0.05)}>{c.body}</div> : null}
        </div>
      );
    case 'list':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 24}}>
          {c.title ? <div style={{...big(0.075), marginBottom: 10}}>{c.title}</div> : null}
          {(c.items || []).map((it, i) => (
            <div key={i} style={{display: 'flex', gap: 18, alignItems: 'flex-start'}}>
              <span style={{...big(0.06), color: c.accent, minWidth: Math.round(w * 0.1)}}>{String(i + 1).padStart(2, '0')}</span>
              <span style={sub(0.05)}>{it}</span>
            </div>
          ))}
        </div>
      );
    case 'quote':
      return (
        <div style={center}>
          <div style={{...big(0.2), color: c.accent, lineHeight: 0.8}}>&ldquo;</div>
          <div style={big(0.09)}>{c.title}</div>
          {c.body ? <div style={{...sub(0.042), opacity: 0.85}}>— {c.body}</div> : null}
        </div>
      );
    case 'compare':
      return (
        <div style={center}>
          {c.title ? <div style={big(0.065)}>{c.title}</div> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
            <div style={{background: '#ffffff14', border: '2px solid #ffffff33', borderRadius: 22, padding: 26}}>
              <div style={{...sub(0.038), color: '#ff8a8a'}}>BEFORE</div>
              <div style={sub(0.052)}>{c.before}</div>
            </div>
            <div style={{background: c.accent + '22', border: `2px solid ${c.accent}`, borderRadius: 22, padding: 26}}>
              <div style={{...sub(0.038), color: c.accent}}>AFTER</div>
              <div style={sub(0.052)}>{c.after}</div>
            </div>
          </div>
        </div>
      );
    case 'fix':
      return (
        <div style={center}>
          {c.title ? <div style={big(0.065)}>{c.title}</div> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
            <div style={{display: 'flex', gap: 16, alignItems: 'flex-start'}}>
              <span style={big(0.07)}>❌</span><span style={{...sub(0.05), textDecoration: 'line-through', opacity: 0.7}}>{c.wrong}</span>
            </div>
            <div style={{display: 'flex', gap: 16, alignItems: 'flex-start'}}>
              <span style={big(0.07)}>✅</span><span style={{...sub(0.055), color: c.accent}}>{c.right}</span>
            </div>
          </div>
        </div>
      );
    case 'closing':
      return (
        <div style={center}>
          <div style={big(0.1)}>{c.title}</div>
          {c.body ? <div style={sub(0.05)}>{c.body}</div> : null}
          <div style={{display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap'}}>
            <span style={chip(c.accent)}>💾 저장</span>
            <span style={chip('#ffffff22')}>↗ 공유</span>
          </div>
        </div>
      );
    case 'body':
    default:
      return (
        <div style={center}>
          {c.title ? <div style={big(0.08)}>{c.title}</div> : null}
          {c.body ? <div style={sub(0.055)}>{c.body}</div> : null}
        </div>
      );
  }
};
