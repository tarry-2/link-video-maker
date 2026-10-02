import React from 'react';
import {z} from 'zod';
import {
  AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring,
} from 'remotion';
import {loadFont} from '@remotion/fonts';

// 카드뉴스 전용 폰트.
const blackFont = 'Black Han Sans';
const notoFont = 'Noto Sans KR';
loadFont({family: blackFont, url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: notoFont, url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});

// ★카드 8종 — 역할별 레이아웃이 완전히 달라야 "다양함"이 된다(레퍼런스 @web._moment 기준).
// cover/closing = 배경사진 풀블리드 + 시선폭탄 타이포. 본문 = 밝은 매거진 레이아웃(라이트/다크 테마).
export type MotionStyle = 'auto' | 'pop' | 'slide' | 'type' | 'zoom' | 'flip';

export const cardSchema = z.object({
  type: z.enum(['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing', 'checklist', 'step', 'qa', 'stat']),
  bg: z.string().optional(),       // 배경 이미지(public 상대경로).
  bgColor: z.string().optional(),  // 다크 테마 배경 기준색.
  accent: z.string(),              // 강조색.
  theme: z.enum(['light', 'dark']).optional(),      // 본문 카드 톤(기본 light=매거진).
  motion: z.enum(['auto', 'pop', 'slide', 'type', 'zoom', 'flip']).optional(), // 등장 효과.
  kicker: z.string().optional(),   // 상단 작은 섹션 라벨(영문/한글).
  brand: z.string().optional(),    // 하단 워터마크.
  badge: z.string().optional(),    // 상단 뱃지(cover 충격뱃지 등).
  big: z.string().optional(),      // cover 시선폭탄 초대형 훅.
  small: z.string().optional(),    // cover 윗줄 보조.
  title: z.string().optional(),
  body: z.string().optional(),
  number: z.string().optional(),
  unit: z.string().optional(),
  items: z.array(z.string()).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  wrong: z.string().optional(),
  right: z.string().optional(),
  durationInFrames: z.number(),
  index: z.number(),
  total: z.number(),
});
export type CardData = z.infer<typeof cardSchema>;

// ── 색 유틸 ──
function shade(hex: string, pct: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct < 0 ? 0 : 255; const p = Math.abs(pct) / 100;
  r = Math.round((f - r) * p) + r; g = Math.round((f - g) * p) + g; b = Math.round((f - b) * p) + b;
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
const outline = (px: number, c = '#000') =>
  `${px}px ${px}px 0 ${c}, -${px}px ${px}px 0 ${c}, ${px}px -${px}px 0 ${c}, -${px}px -${px}px 0 ${c}, 0 ${px}px 0 ${c}, 0 -${px}px 0 ${c}, ${px}px 0 0 ${c}, -${px}px 0 0 ${c}, ${px * 2}px 0 0 ${c}, -${px * 2}px 0 0 ${c}`;

// ── 타입별 기본 모션(auto일 때) ──
const AUTO_MOTION: Record<CardData['type'], Exclude<MotionStyle, 'auto'>> = {
  cover: 'pop', number: 'zoom', list: 'slide', quote: 'pop',
  compare: 'slide', fix: 'slide', body: 'type', closing: 'pop',
  checklist: 'slide', step: 'slide', qa: 'pop', stat: 'zoom',
};

// 요소 등장 reveal — delay(프레임) 뒤에 motion 스타일대로 나타남.
function useReveal(delay: number, style: Exclude<MotionStyle, 'auto'>) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const f = Math.max(0, frame - delay);
  const s = spring({frame: f, fps, config: {damping: 16, mass: 0.6}});
  const op = interpolate(f, [0, 7], [0, 1], {extrapolateRight: 'clamp'});
  let transform = '';
  switch (style) {
    case 'pop': transform = `scale(${interpolate(s, [0, 1], [0.62, 1])})`; break;
    case 'slide': transform = `translateX(${interpolate(s, [0, 1], [-70, 0])}px)`; break;
    case 'zoom': transform = `scale(${interpolate(s, [0, 1], [1.35, 1])})`; break;
    case 'flip': transform = `perspective(900px) rotateX(${interpolate(s, [0, 1], [85, 0])}deg)`; break;
    case 'type': transform = `translateY(${interpolate(s, [0, 1], [22, 0])}px)`; break;
    default: transform = `translateY(${interpolate(s, [0, 1], [42, 0])}px)`;
  }
  return {opacity: op, transform, display: 'inline-block' as const};
}

export const Card: React.FC<CardData> = (c) => {
  const {width, height} = useVideoConfig();
  const theme = c.theme || (c.type === 'cover' || c.type === 'closing' ? 'dark' : 'light');
  const motion: Exclude<MotionStyle, 'auto'> = !c.motion || c.motion === 'auto' ? AUTO_MOTION[c.type] : c.motion;
  const pad = Math.round(width * 0.075);
  const isHero = c.type === 'cover' || c.type === 'closing';

  // 팔레트
  const P = theme === 'light'
    ? {base: '#F6F0E3', base2: '#ECE3D2', text: '#1b1713', sub: '#4a433a', line: '#00000014', numText: '#fff', chipText: '#fff'}
    : {base: c.bgColor || '#17171d', base2: shade(c.bgColor || '#17171d', -22), text: '#ffffff', sub: '#ffffffd8', line: '#ffffff1f', numText: '#0c0c0c', chipText: '#fff'};

  const frame = useCurrentFrame();
  // 배경 미세 줌(살아있는 느낌).
  const bgZoom = 1.04 + interpolate(frame, [0, c.durationInFrames || 90], [0, 0.05]);

  return (
    <AbsoluteFill style={{fontFamily: notoFont, overflow: 'hidden', background: `linear-gradient(155deg, ${P.base} 0%, ${P.base2} 100%)`}}>
      {/* 배경 이미지 */}
      {c.bg ? (
        isHero ? (
          <>
            <Img src={staticFile(c.bg)} style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`, filter: 'saturate(1.25) contrast(1.08)'}} />
            {/* 히어로: 하단으로 갈수록 어둡게(시선폭탄 가독성) */}
            <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.28) 0%, rgba(0,0,0,.05) 38%, rgba(0,0,0,.72) 100%)'}} />
          </>
        ) : (
          // 본문: 이미지를 우측에 은은하게 걸침(레퍼런스 톤).
          <>
            <Img src={staticFile(c.bg)} style={{position: 'absolute', right: 0, top: 0, width: '55%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`, opacity: theme === 'light' ? 0.9 : 0.5}} />
            <AbsoluteFill style={{background: theme === 'light'
              ? `linear-gradient(90deg, ${P.base} 46%, ${P.base}cc 60%, transparent 100%)`
              : `linear-gradient(90deg, ${P.base} 46%, ${P.base}dd 62%, ${P.base}55 100%)`}} />
          </>
        )
      ) : (!isHero ? null : (
        // 히어로 + 이미지 없을 때: 강조색 블롭.
        <>
          <div style={{position: 'absolute', width: width, height: width, borderRadius: '50%', top: -width * 0.3, right: -width * 0.3, background: c.accent, opacity: 0.22, filter: 'blur(90px)'}} />
          <div style={{position: 'absolute', width: width * 0.8, height: width * 0.8, borderRadius: '50%', bottom: -width * 0.25, left: -width * 0.3, background: c.accent, opacity: 0.12, filter: 'blur(80px)'}} />
        </>
      ))}

      {/* 상단 진행 바 */}
      <div style={{position: 'absolute', top: pad * 0.7, left: pad, right: pad, display: 'flex', gap: 7, justifyContent: 'center', zIndex: 3}}>
        {Array.from({length: c.total}).map((_, i) => (
          <div key={i} style={{height: 5, flex: 1, maxWidth: 44, borderRadius: 3, background: i <= c.index ? c.accent : (isHero ? '#ffffff4d' : '#00000018')}} />
        ))}
      </div>

      {/* 본문 */}
      <AbsoluteFill style={{padding: pad, paddingTop: pad * 1.7, paddingBottom: pad * 1.5, zIndex: 2}}>
        <Body {...c} width={width} height={height} theme={theme} motion={motion} palette={P} />
      </AbsoluteFill>

      {/* 하단 워터마크/페이지 */}
      <div style={{position: 'absolute', bottom: pad * 0.6, left: pad, right: pad, display: 'flex', justifyContent: 'space-between', color: isHero ? '#ffffffcc' : P.sub, fontSize: Math.round(width * 0.028), fontWeight: 700, zIndex: 3}}>
        <span>{c.index + 1} / {c.total}</span>
        <span style={{opacity: 0.85}}>{c.brand || '@onvideo'}</span>
      </div>
    </AbsoluteFill>
  );
};

type Palette = {base: string; base2: string; text: string; sub: string; line: string; numText: string; chipText: string};

// ── 타입별 본문 레이아웃 ──
const Body: React.FC<CardData & {width: number; height: number; theme: 'light' | 'dark'; motion: Exclude<MotionStyle, 'auto'>; palette: Palette}> = (c) => {
  const w = c.width;
  const P = c.palette;
  const isHero = c.type === 'cover' || c.type === 'closing';
  const big = (px: number, color?: string): React.CSSProperties => ({fontFamily: blackFont, fontSize: Math.round(w * px), lineHeight: 1.08, color: color || P.text, letterSpacing: '-1px'});
  const sub = (px: number, color?: string): React.CSSProperties => ({fontFamily: notoFont, fontWeight: 700, fontSize: Math.round(w * px), lineHeight: 1.45, color: color || P.sub});
  const chip = (bg: string, color = P.chipText): React.CSSProperties => ({display: 'inline-block', padding: '11px 24px', borderRadius: 999, background: bg, color, fontFamily: notoFont, fontWeight: 800, fontSize: Math.round(w * 0.04), whiteSpace: 'nowrap', lineHeight: 1});
  const center: React.CSSProperties = {height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.03)};

  // 상단 kicker 라벨(레퍼런스의 "CHATGPT COMMANDS" 느낌).
  const Kicker = c.kicker ? (
    <div style={{...sub(0.03, isHero ? '#ffffffcc' : c.accent), fontWeight: 800, letterSpacing: '3px', textTransform: 'uppercase', marginBottom: Math.round(w * 0.01)}}>{c.kicker}</div>
  ) : null;

  switch (c.type) {
    // ── 커버: 배경사진 + 시선폭탄 ──
    case 'cover': {
      const words = (c.big || c.title || '').split(/\s+/).filter(Boolean);
      const bigSize = w * 0.155;
      const ol = Math.max(5, Math.round(bigSize * 0.05));
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.028), paddingBottom: w * 0.04}}>
          {c.badge ? <Reveal delay={2} motion="pop"><span style={{...chip('linear-gradient(160deg,#FF3A3A,#D40000)'), transform: 'rotate(-4deg)', fontSize: Math.round(w * 0.052), border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,.5)'}}>{c.badge}</span></Reveal> : null}
          {c.small ? <Reveal delay={6} motion="slide"><div style={{...sub(0.05, '#fff'), fontWeight: 800, textShadow: outline(Math.max(2, Math.round(w * 0.004)))}}>{c.small}</div></Reveal> : null}
          <div style={{display: 'flex', flexWrap: 'wrap', gap: `${bigSize * 0.04}px ${bigSize * 0.12}px`}}>
            {words.map((wd, i) => (
              <Reveal key={i} delay={10 + i * 4} motion="pop">
                <span style={{fontFamily: blackFont, fontSize: bigSize, lineHeight: 1.0, color: i % 2 === 1 ? c.accent : '#fff', textShadow: outline(ol), WebkitTextStroke: `${Math.round(ol * 0.28)}px #000`}}>{wd}</span>
              </Reveal>
            ))}
          </div>
          {c.body ? <Reveal delay={16 + words.length * 4} motion="slide"><div style={{...sub(0.046, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={22 + words.length * 4} motion="type"><div style={{...sub(0.038, c.accent), fontWeight: 800, marginTop: w * 0.01}}>→ 넘겨서 보기</div></Reveal>
        </div>
      );
    }

    // ── 숫자: 카운트업 ──
    case 'number':
      return <NumberBody c={c} w={w} P={P} Kicker={Kicker} big={big} sub={sub} center={center} />;

    // ── 리스트: 번호 동그라미 순차(레퍼런스 핵심) ──
    case 'list':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.082), marginBottom: w * 0.015}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.03), alignItems: 'center', padding: `${Math.round(w * 0.012)}px 0`, borderBottom: `2px solid ${P.line}`, width: '100%'}}>
                <span style={{fontFamily: blackFont, fontSize: Math.round(w * 0.055), color: P.numText, background: c.accent, width: Math.round(w * 0.1), height: Math.round(w * 0.1), borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1}}>{i + 1}</span>
                <span style={sub(0.05)}>{it}</span>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── 체크리스트(✓) ──
    case 'checklist':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.082), marginBottom: w * 0.015}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'center', padding: `${Math.round(w * 0.012)}px 0`, borderBottom: `2px solid ${P.line}`}}>
                <span style={{fontFamily: blackFont, fontSize: Math.round(w * 0.05), color: P.numText, background: c.accent, width: Math.round(w * 0.09), height: Math.round(w * 0.09), borderRadius: Math.round(w * 0.022), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1}}>✓</span>
                <span style={sub(0.05)}>{it}</span>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── 단계 플로우(STEP) ──
    case 'step':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.08), marginBottom: w * 0.012}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'flex-start'}}>
                <span style={{fontFamily: blackFont, fontSize: Math.round(w * 0.044), color: P.numText, background: c.accent, width: Math.round(w * 0.1), height: Math.round(w * 0.1), borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1}}>{i + 1}</span>
                <div style={{paddingTop: w * 0.006}}>
                  <div style={{...sub(0.028, c.accent), fontWeight: 800, letterSpacing: '1px'}}>STEP {i + 1}</div>
                  <div style={sub(0.048)}>{it}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── Q&A ──
    case 'qa':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion={c.motion}>
            <div style={{display: 'flex', gap: Math.round(w * 0.022), alignItems: 'flex-start'}}>
              <span style={big(0.1, c.accent)}>Q.</span>
              <div style={big(0.072)}>{c.title}</div>
            </div>
          </Reveal>
          {c.body ? (
            <Reveal delay={8} motion="slide">
              <div style={{display: 'flex', gap: Math.round(w * 0.022), alignItems: 'flex-start', background: c.theme === 'light' ? '#00000008' : '#ffffff12', border: `2px solid ${c.accent}55`, borderRadius: 22, padding: Math.round(w * 0.04)}}>
                <span style={big(0.08, c.accent)}>A.</span>
                <div style={sub(0.05)}>{c.body}</div>
              </div>
            </Reveal>
          ) : null}
        </div>
      );

    // ── 막대 그래프(수치 비교) ──
    case 'stat': {
      const rows = (c.items || []).map((it) => {
        const [label, val] = it.split('|');
        return {label: (label || '').trim(), val: parseFloat((val || '').replace(/[^0-9.]/g, '')) || 0};
      });
      const max = Math.max(1, ...rows.map((r) => r.val));
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={{...big(0.075), marginBottom: w * 0.01}}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.028)}}>
            {rows.map((r, i) => (
              <Reveal key={i} delay={8 + i * 5} motion="slide">
                <div>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: w * 0.008}}>
                    <span style={sub(0.046)}>{r.label}</span>
                    <span style={{...big(0.055, c.accent)}}>{r.val}</span>
                  </div>
                  <StatBar pct={r.val / max} accent={c.accent} line={P.line} h={Math.round(w * 0.03)} delay={10 + i * 5} />
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      );
    }

    // ── 인용 ──
    case 'quote':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion="zoom"><div style={{...big(0.22, c.accent), lineHeight: 0.7}}>&ldquo;</div></Reveal>
          <Reveal delay={6} motion={c.motion}><div style={big(0.092)}>{c.title}</div></Reveal>
          {c.body ? <Reveal delay={12} motion="slide"><div style={{...sub(0.042), opacity: 0.85}}>— {c.body}</div></Reveal> : null}
        </div>
      );

    // ── 전후 비교 ──
    case 'compare':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.07)}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.025)}}>
            <Reveal delay={8} motion="slide">
              <div style={{background: c.theme === 'light' ? '#00000008' : '#ffffff12', border: `2px solid ${c.theme === 'light' ? '#00000018' : '#ffffff33'}`, borderRadius: 22, padding: Math.round(w * 0.045)}}>
                <div style={{...sub(0.036, '#ff6b6b'), fontWeight: 800}}>BEFORE</div>
                <div style={sub(0.05)}>{c.before}</div>
              </div>
            </Reveal>
            <Reveal delay={16} motion="slide">
              <div style={{background: c.accent + '22', border: `2px solid ${c.accent}`, borderRadius: 22, padding: Math.round(w * 0.045)}}>
                <div style={{...sub(0.036, c.accent), fontWeight: 800}}>AFTER</div>
                <div style={sub(0.05)}>{c.after}</div>
              </div>
            </Reveal>
          </div>
        </div>
      );

    // ── 실수 vs 해결 ──
    case 'fix':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.07)}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.028)}}>
            <Reveal delay={8} motion="slide">
              <div style={{display: 'flex', gap: Math.round(w * 0.025), alignItems: 'flex-start'}}>
                <span style={big(0.065)}>❌</span><span style={{...sub(0.05), textDecoration: 'line-through', opacity: 0.6}}>{c.wrong}</span>
              </div>
            </Reveal>
            <Reveal delay={16} motion="slide">
              <div style={{display: 'flex', gap: Math.round(w * 0.025), alignItems: 'flex-start'}}>
                <span style={big(0.065)}>✅</span><span style={{...sub(0.055, c.accent), fontWeight: 800}}>{c.right}</span>
              </div>
            </Reveal>
          </div>
        </div>
      );

    // ── 마무리: 배경사진 + CTA ──
    case 'closing':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.028), paddingBottom: w * 0.04}}>
          <Reveal delay={2} motion="pop"><div style={{...big(0.105, '#fff'), textShadow: outline(Math.max(3, Math.round(w * 0.004)))}}>{c.title}</div></Reveal>
          {c.body ? <Reveal delay={8} motion="slide"><div style={{...sub(0.05, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={14} motion="type">
            <div style={{display: 'flex', gap: 14, marginTop: w * 0.01, flexWrap: 'wrap'}}>
              <span style={chip(c.accent)}>💾 저장</span>
              <span style={chip('#ffffff28')}>↗ 공유</span>
            </div>
          </Reveal>
        </div>
      );

    // ── 일반 본문(핵심 설명) ──
    case 'body':
    default:
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.088)}>{c.title}</div></Reveal> : null}
          {c.body ? <Reveal delay={8} motion={c.motion}><div style={sub(0.056)}>{c.body}</div></Reveal> : null}
        </div>
      );
  }
};

// 숫자 카운트업 카드(별도 — 훅 사용).
const NumberBody: React.FC<{c: CardData & {theme: 'light' | 'dark'; motion: Exclude<MotionStyle, 'auto'>}; w: number; P: Palette; Kicker: React.ReactNode; big: (px: number, color?: string) => React.CSSProperties; sub: (px: number, color?: string) => React.CSSProperties; center: React.CSSProperties}> = ({c, w, Kicker, big, sub, center}) => {
  const frame = useCurrentFrame();
  const raw = c.number || '';
  const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
  const prefix = raw.match(/^[^0-9.]+/)?.[0] || '';
  const suffix = raw.match(/[^0-9.]+$/)?.[0] || '';
  const shown = isNaN(num) ? raw : prefix + Math.round(interpolate(frame, [0, 22], [0, num], {extrapolateRight: 'clamp'})).toLocaleString() + suffix;
  return (
    <div style={center}>
      {Kicker}
      {c.title ? <Reveal delay={0} motion="slide"><div style={sub(0.055)}>{c.title}</div></Reveal> : null}
      <Reveal delay={4} motion="zoom">
        <div style={{display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap'}}>
          <span style={{...big(0.27, c.accent)}}>{shown}</span>
          {c.unit ? <span style={big(0.09)}>{c.unit}</span> : null}
        </div>
      </Reveal>
      {c.body ? <Reveal delay={14} motion="slide"><div style={sub(0.05)}>{c.body}</div></Reveal> : null}
    </div>
  );
};

// 등장 래퍼.
const Reveal: React.FC<{delay: number; motion: Exclude<MotionStyle, 'auto'>; children: React.ReactNode}> = ({delay, motion, children}) => {
  const st = useReveal(delay, motion);
  return <div style={st}>{children}</div>;
};

// 막대 그래프 바(width 애니).
const StatBar: React.FC<{pct: number; accent: string; line: string; h: number; delay: number}> = ({pct, accent, line, h, delay}) => {
  const frame = useCurrentFrame();
  const fill = interpolate(frame, [delay, delay + 18], [0, Math.min(1, pct) * 100], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{background: line, borderRadius: h, height: h, overflow: 'hidden'}}>
      <div style={{width: `${fill}%`, height: '100%', background: accent, borderRadius: h}} />
    </div>
  );
};
