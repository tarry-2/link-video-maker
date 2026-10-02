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

// ★레이아웃 원칙(레퍼런스 @web._moment): 본문 카드는 "좌측=텍스트(완전히 깨끗한 여백) / 우측=이미지"로
//   명확히 분리한다. 텍스트는 절대 이미지 위에 겹치지 않는다. cover/closing만 이미지 풀블리드+시선폭탄.
//   ★이모지 금지: Remotion 렌더에 컬러 이모지 폰트가 없어 네모로 깨진다 → 텍스트/색으로만 표현.
export type MotionStyle = 'auto' | 'pop' | 'slide' | 'type' | 'zoom' | 'flip';

export const cardSchema = z.object({
  type: z.enum(['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing', 'checklist', 'step', 'qa', 'stat']),
  bg: z.string().optional(),       // 배경 이미지(public 상대경로).
  bgColor: z.string().optional(),  // 다크 테마 배경 기준색.
  accent: z.string(),              // 강조색.
  theme: z.enum(['light', 'dark']).optional(),      // 본문 카드 톤(기본 light=매거진).
  motion: z.enum(['auto', 'pop', 'slide', 'type', 'zoom', 'flip']).optional(),
  kicker: z.string().optional(),   // 상단 작은 섹션 라벨.
  brand: z.string().optional(),    // 하단 워터마크.
  badge: z.string().optional(),    // cover 충격 뱃지.
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

const AUTO_MOTION: Record<CardData['type'], Exclude<MotionStyle, 'auto'>> = {
  cover: 'pop', number: 'zoom', list: 'slide', quote: 'pop',
  compare: 'slide', fix: 'slide', body: 'type', closing: 'pop',
  checklist: 'slide', step: 'slide', qa: 'pop', stat: 'zoom',
};

function useReveal(delay: number, style: Exclude<MotionStyle, 'auto'>) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const f = Math.max(0, frame - delay);
  const s = spring({frame: f, fps, config: {damping: 16, mass: 0.6}});
  const op = interpolate(f, [0, 7], [0, 1], {extrapolateRight: 'clamp'});
  let transform = '';
  switch (style) {
    case 'pop': transform = `scale(${interpolate(s, [0, 1], [0.62, 1])})`; break;
    case 'slide': transform = `translateX(${interpolate(s, [0, 1], [-60, 0])}px)`; break;
    case 'zoom': transform = `scale(${interpolate(s, [0, 1], [1.3, 1])})`; break;
    case 'flip': transform = `perspective(900px) rotateX(${interpolate(s, [0, 1], [85, 0])}deg)`; break;
    case 'type': transform = `translateY(${interpolate(s, [0, 1], [22, 0])}px)`; break;
    default: transform = `translateY(${interpolate(s, [0, 1], [42, 0])}px)`;
  }
  return {opacity: op, transform, display: 'inline-block' as const};
}

export const Card: React.FC<CardData> = (c) => {
  const {width} = useVideoConfig();
  const theme = c.theme || (c.type === 'cover' || c.type === 'closing' ? 'dark' : 'light');
  const motion: Exclude<MotionStyle, 'auto'> = !c.motion || c.motion === 'auto' ? AUTO_MOTION[c.type] : c.motion;
  const pad = Math.round(width * 0.072);
  const isHero = c.type === 'cover' || c.type === 'closing';
  const hasImg = !!c.bg;
  // 본문(비히어로)에서 이미지가 있으면 텍스트는 좌측 56%만 사용(이미지와 절대 안 겹침).
  const imgCol = !isHero && hasImg;

  // ★가독성: light 테마에선 강조색이 밝으면 글자가 배경에 묻힌다 → 텍스트/칩 배경엔 어둡게 보정.
  const ta = theme === 'light' ? shade(c.accent, -50) : c.accent;      // 텍스트 강조색
  const bgAccent = theme === 'light' ? shade(c.accent, -34) : c.accent; // 칩/번호 배경색
  const P: Palette = theme === 'light'
    ? {base: '#F6F0E3', base2: '#ECE3D2', text: '#1b1713', sub: '#443d34', line: '#0000001a', numText: '#fff', chipText: '#fff', ta, bgAccent}
    : {base: c.bgColor || '#17171d', base2: shade(c.bgColor || '#17171d', -22), text: '#ffffff', sub: '#ffffffd8', line: '#ffffff22', numText: '#0c0c0c', chipText: '#fff', ta, bgAccent};

  const frame = useCurrentFrame();
  const bgZoom = 1.03 + interpolate(frame, [0, c.durationInFrames || 90], [0, 0.05]);
  // 떠다니는 장식(모션그래픽 디테일) — 느리게 순환 이동.
  const blobX = interpolate(frame % 300, [0, 150, 300], [0, 36, 0]);
  const blobY = interpolate(frame % 360, [0, 180, 360], [0, -28, 0]);
  const ringSpin = (frame % 1200) / 1200 * 360;

  return (
    <AbsoluteFill style={{fontFamily: notoFont, overflow: 'hidden', background: `linear-gradient(155deg, ${P.base} 0%, ${P.base2} 100%)`}}>
      {/* ── 배경 ── */}
      {isHero && hasImg ? (
        <>
          <Img src={staticFile(c.bg!)} style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`, filter: 'saturate(1.2) contrast(1.06)'}} />
          <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.30) 0%, rgba(0,0,0,.05) 36%, rgba(0,0,0,.74) 100%)'}} />
        </>
      ) : isHero ? (
        <>
          <div style={{position: 'absolute', width, height: width, borderRadius: '50%', top: -width * 0.3, right: -width * 0.3, background: c.accent, opacity: 0.22, filter: 'blur(90px)'}} />
          <div style={{position: 'absolute', width: width * 0.8, height: width * 0.8, borderRadius: '50%', bottom: -width * 0.25, left: -width * 0.3, background: c.accent, opacity: 0.12, filter: 'blur(80px)'}} />
        </>
      ) : imgCol ? (
        // ★본문 2단: 우측 42%만 이미지, 좌측 경계는 base로 페이드 → 텍스트 영역 깨끗.
        <>
          <Img src={staticFile(c.bg!)} style={{position: 'absolute', right: 0, top: 0, width: '44%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`}} />
          <div style={{position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', background: `linear-gradient(90deg, ${P.base} 0%, ${P.base}f2 14%, ${P.base}00 40%)`}} />
          <div style={{position: 'absolute', right: 0, bottom: 0, width: '44%', height: '30%', background: `linear-gradient(0deg, ${P.base}cc 0%, transparent 100%)`}} />
        </>
      ) : !isHero ? (
        // ★본문(이미지 없음): 떠다니는 액센트 블롭 + 회전 링 장식(디자이너 디테일 + 모션).
        <>
          <div style={{position: 'absolute', width: width * 0.72, height: width * 0.72, borderRadius: '50%', top: -width * 0.22 + blobY, right: -width * 0.16 + blobX, background: c.accent, opacity: theme === 'light' ? 0.10 : 0.18, filter: 'blur(75px)'}} />
          <div style={{position: 'absolute', width: width * 0.5, height: width * 0.5, borderRadius: '50%', bottom: -width * 0.14 - blobY, left: -width * 0.1 - blobX, background: c.accent, opacity: theme === 'light' ? 0.07 : 0.12, filter: 'blur(65px)'}} />
          <div style={{position: 'absolute', top: width * 0.5, right: width * 0.08, width: width * 0.22, height: width * 0.22, borderRadius: '50%', border: `${Math.max(2, Math.round(width * 0.004))}px solid ${bgAccent}`, opacity: 0.16, transform: `rotate(${ringSpin}deg)`, borderStyle: 'dashed'}} />
        </>
      ) : null}

      {/* 상단 진행 바 */}
      <div style={{position: 'absolute', top: pad * 0.7, left: pad, right: pad, display: 'flex', gap: 7, justifyContent: 'center', zIndex: 3}}>
        {Array.from({length: c.total}).map((_, i) => (
          <div key={i} style={{height: 5, flex: 1, maxWidth: 44, borderRadius: 3, background: i <= c.index ? bgAccent : (isHero ? '#ffffff4d' : '#00000018')}} />
        ))}
      </div>

      {/* 본문(텍스트). 이미지 있으면 좌측 56%만 사용. */}
      <AbsoluteFill style={{padding: pad, paddingTop: pad * 1.7, paddingBottom: pad * 1.5, zIndex: 2, width: imgCol ? '58%' : '100%'}}>
        <Body {...c} width={width} theme={theme} motion={motion} palette={P} />
      </AbsoluteFill>

      {/* 하단 워터마크 */}
      <div style={{position: 'absolute', bottom: pad * 0.6, left: pad, right: pad, display: 'flex', justifyContent: 'space-between', color: isHero ? '#ffffffcc' : P.sub, fontSize: Math.round(width * 0.028), fontWeight: 700, zIndex: 3}}>
        <span>{c.index + 1} / {c.total}</span>
        <span style={{opacity: 0.85}}>{c.brand || '@onvideo'}</span>
      </div>
    </AbsoluteFill>
  );
};

type Palette = {base: string; base2: string; text: string; sub: string; line: string; numText: string; chipText: string; ta: string; bgAccent: string};

const Body: React.FC<CardData & {width: number; theme: 'light' | 'dark'; motion: Exclude<MotionStyle, 'auto'>; palette: Palette}> = (c) => {
  const w = c.width;
  const P = c.palette;
  const big = (px: number, color?: string): React.CSSProperties => ({fontFamily: blackFont, fontSize: Math.round(w * px), lineHeight: 1.08, color: color || P.text, letterSpacing: '-1px'});
  const sub = (px: number, color?: string): React.CSSProperties => ({fontFamily: notoFont, fontWeight: 700, fontSize: Math.round(w * px), lineHeight: 1.45, color: color || P.sub});
  const chip = (bg: string, color = P.chipText): React.CSSProperties => ({display: 'inline-block', padding: '11px 24px', borderRadius: 999, background: bg, color, fontFamily: notoFont, fontWeight: 800, fontSize: Math.round(w * 0.04), whiteSpace: 'nowrap', lineHeight: 1});
  const center: React.CSSProperties = {height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.03)};
  const numCircle = (sz: number): React.CSSProperties => ({fontFamily: blackFont, fontSize: Math.round(w * sz), color: P.numText, background: P.bgAccent, width: Math.round(w * 0.1), height: Math.round(w * 0.1), borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1});

  const Kicker = c.kicker ? (
    <div style={{display: 'flex', alignItems: 'center', gap: Math.round(w * 0.018), marginBottom: Math.round(w * 0.014)}}>
      <span style={{width: Math.round(w * 0.055), height: Math.max(3, Math.round(w * 0.007)), borderRadius: 3, background: P.bgAccent, display: 'inline-block'}} />
      <span style={{...sub(0.03, P.ta), fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase'}}>{c.kicker}</span>
    </div>
  ) : null;

  switch (c.type) {
    // ── 커버: 배경사진 풀 + 시선폭탄 ──
    case 'cover': {
      const words = (c.big || c.title || '').split(/\s+/).filter(Boolean);
      const bigSize = w * 0.15;
      const ol = Math.max(5, Math.round(bigSize * 0.05));
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.028), paddingBottom: w * 0.04}}>
          {c.badge ? <Reveal delay={2} motion="pop"><span style={{...chip('linear-gradient(160deg,#FF3A3A,#D40000)'), transform: 'rotate(-4deg)', fontSize: Math.round(w * 0.05), border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,.5)'}}>{c.badge}</span></Reveal> : null}
          {c.small ? <Reveal delay={6} motion="slide"><div style={{...sub(0.05, '#fff'), fontWeight: 800, textShadow: outline(Math.max(2, Math.round(w * 0.004)))}}>{c.small}</div></Reveal> : null}
          <div style={{display: 'flex', flexWrap: 'wrap', gap: `${bigSize * 0.04}px ${bigSize * 0.12}px`}}>
            {words.map((wd, i) => (
              <Reveal key={i} delay={10 + i * 4} motion="pop">
                <span style={{fontFamily: blackFont, fontSize: bigSize, lineHeight: 1.0, color: i % 2 === 1 ? c.accent : '#fff', textShadow: outline(ol), WebkitTextStroke: `${Math.round(ol * 0.28)}px #000`}}>{wd}</span>
              </Reveal>
            ))}
          </div>
          {c.body ? <Reveal delay={16 + words.length * 4} motion="slide"><div style={{...sub(0.046, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={22 + words.length * 4} motion="type"><div style={{...sub(0.04, c.accent), fontWeight: 800, marginTop: w * 0.01}}>넘겨서 보기 →</div></Reveal>
        </div>
      );
    }

    case 'number':
      return <NumberBody c={c} w={w} P={P} Kicker={Kicker} big={big} sub={sub} center={center} />;

    // ── 번호 리스트 ──
    case 'list':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.078), marginBottom: w * 0.012}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'center', padding: `${Math.round(w * 0.011)}px 0`, borderBottom: `2px solid ${P.line}`}}>
                <span style={numCircle(0.05)}>{i + 1}</span>
                <span style={sub(0.048)}>{it}</span>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── 체크리스트 ──
    case 'checklist':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.078), marginBottom: w * 0.012}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'center', padding: `${Math.round(w * 0.011)}px 0`, borderBottom: `2px solid ${P.line}`}}>
                <span style={{...numCircle(0.05), borderRadius: Math.round(w * 0.02)}}>✓</span>
                <span style={sub(0.048)}>{it}</span>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── 단계 플로우 ──
    case 'step':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.022)}}>
          {Kicker}
          {c.title ? <Reveal delay={2} motion={c.motion}><div style={{...big(0.076), marginBottom: w * 0.01}}>{c.title}</div></Reveal> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={8 + i * 5} motion={c.motion}>
              <div style={{display: 'flex', gap: Math.round(w * 0.026), alignItems: 'flex-start'}}>
                <span style={numCircle(0.042)}>{i + 1}</span>
                <div style={{paddingTop: w * 0.004}}>
                  <div style={{...sub(0.026, P.ta), fontWeight: 800, letterSpacing: '1px'}}>STEP {i + 1}</div>
                  <div style={sub(0.046)}>{it}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      );

    // ── 인용 ──
    case 'quote':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion="zoom"><div style={{...big(0.2, P.ta), lineHeight: 0.7}}>&ldquo;</div></Reveal>
          <Reveal delay={6} motion={c.motion}><div style={big(0.088)}>{c.title}</div></Reveal>
          {c.body ? <Reveal delay={12} motion="slide"><div style={{...sub(0.042), opacity: 0.9}}>— {c.body}</div></Reveal> : null}
        </div>
      );

    // ── 전후 비교 ──
    case 'compare':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.066)}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.022)}}>
            <Reveal delay={8} motion="slide">
              <div style={{background: c.theme === 'light' ? '#00000008' : '#ffffff10', border: `2px solid ${c.theme === 'light' ? '#c0392b55' : '#ff8a8a55'}`, borderRadius: 20, padding: Math.round(w * 0.04)}}>
                <div style={{...sub(0.034, c.theme === 'light' ? '#c0392b' : '#ff8a8a'), fontWeight: 800, marginBottom: 6}}>BEFORE</div>
                <div style={sub(0.048)}>{c.before}</div>
              </div>
            </Reveal>
            <Reveal delay={16} motion="slide">
              <div style={{background: `${P.bgAccent}1a`, border: `2px solid ${P.ta}`, borderRadius: 20, padding: Math.round(w * 0.04)}}>
                <div style={{...sub(0.034, P.ta), fontWeight: 800, marginBottom: 6}}>AFTER</div>
                <div style={{...sub(0.048), color: P.text}}>{c.after}</div>
              </div>
            </Reveal>
          </div>
        </div>
      );

    // ── 실수 vs 해결(이모지 없이 라벨로) ──
    case 'fix':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.066)}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.022)}}>
            <Reveal delay={8} motion="slide">
              <div style={{background: c.theme === 'light' ? '#00000008' : '#ffffff10', border: `2px solid ${c.theme === 'light' ? '#c0392b55' : '#ff8a8a55'}`, borderRadius: 20, padding: Math.round(w * 0.04)}}>
                <div style={{...sub(0.034, c.theme === 'light' ? '#c0392b' : '#ff8a8a'), fontWeight: 800, marginBottom: 6}}>흔한 실수</div>
                <div style={sub(0.048)}>{c.wrong}</div>
              </div>
            </Reveal>
            <Reveal delay={16} motion="slide">
              <div style={{background: `${P.bgAccent}1a`, border: `2px solid ${P.ta}`, borderRadius: 20, padding: Math.round(w * 0.04)}}>
                <div style={{...sub(0.034, P.ta), fontWeight: 800, marginBottom: 6}}>이렇게 하세요</div>
                <div style={{...sub(0.05), color: P.text}}>{c.right}</div>
              </div>
            </Reveal>
          </div>
        </div>
      );

    // ── Q&A ──
    case 'qa':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion={c.motion}>
            <div style={{display: 'flex', gap: Math.round(w * 0.02), alignItems: 'flex-start'}}>
              <span style={big(0.1, P.ta)}>Q.</span>
              <div style={big(0.07)}>{c.title}</div>
            </div>
          </Reveal>
          {c.body ? (
            <Reveal delay={8} motion="slide">
              <div style={{display: 'flex', gap: Math.round(w * 0.02), alignItems: 'flex-start', background: c.theme === 'light' ? '#00000008' : '#ffffff10', border: `2px solid ${P.ta}55`, borderRadius: 20, padding: Math.round(w * 0.04)}}>
                <span style={big(0.08, P.ta)}>A.</span>
                <div style={sub(0.05)}>{c.body}</div>
              </div>
            </Reveal>
          ) : null}
        </div>
      );

    // ── 막대 그래프 ──
    case 'stat': {
      const rows = (c.items || []).map((it) => {
        const [label, val] = it.split('|');
        return {label: (label || '').trim(), val: parseFloat((val || '').replace(/[^0-9.]/g, '')) || 0};
      });
      const max = Math.max(1, ...rows.map((r) => r.val));
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={{...big(0.07), marginBottom: w * 0.008}}>{c.title}</div></Reveal> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.026)}}>
            {rows.map((r, i) => (
              <Reveal key={i} delay={8 + i * 5} motion="slide">
                <div>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: w * 0.008}}>
                    <span style={sub(0.044)}>{r.label}</span>
                    <span style={big(0.052, P.ta)}>{r.val}</span>
                  </div>
                  <StatBar pct={r.val / max} accent={P.bgAccent} line={P.line} h={Math.round(w * 0.028)} delay={10 + i * 5} />
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      );
    }

    // ── 마무리: 배경사진 풀 + CTA(이모지 없이) ──
    case 'closing':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.028), paddingBottom: w * 0.04}}>
          <Reveal delay={2} motion="pop"><div style={{...big(0.1, '#fff'), textShadow: outline(Math.max(3, Math.round(w * 0.004)))}}>{c.title}</div></Reveal>
          {c.body ? <Reveal delay={8} motion="slide"><div style={{...sub(0.048, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={14} motion="type">
            <div style={{display: 'flex', gap: 14, marginTop: w * 0.01, flexWrap: 'wrap'}}>
              <span style={chip(c.accent)}>저장하기</span>
              <span style={chip('#ffffff28')}>공유하기</span>
            </div>
          </Reveal>
        </div>
      );

    // ── 일반 본문 ──
    case 'body':
    default:
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <Reveal delay={0} motion={c.motion}><div style={big(0.084)}>{c.title}</div></Reveal> : null}
          {c.body ? <Reveal delay={8} motion={c.motion}><div style={sub(0.054)}>{c.body}</div></Reveal> : null}
        </div>
      );
  }
};

// 숫자 카운트업.
const NumberBody: React.FC<{c: CardData & {theme: 'light' | 'dark'; motion: Exclude<MotionStyle, 'auto'>}; w: number; P: Palette; Kicker: React.ReactNode; big: (px: number, color?: string) => React.CSSProperties; sub: (px: number, color?: string) => React.CSSProperties; center: React.CSSProperties}> = ({c, w, P, Kicker, big, sub, center}) => {
  const frame = useCurrentFrame();
  const raw = c.number || '';
  const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
  const prefix = raw.match(/^[^0-9.]+/)?.[0] || '';
  const suffix = raw.match(/[^0-9.]+$/)?.[0] || '';
  const shown = isNaN(num) ? raw : prefix + Math.round(interpolate(frame, [0, 22], [0, num], {extrapolateRight: 'clamp'})).toLocaleString() + suffix;
  return (
    <div style={center}>
      {Kicker}
      {c.title ? <Reveal delay={0} motion="slide"><div style={sub(0.052)}>{c.title}</div></Reveal> : null}
      <Reveal delay={4} motion="zoom">
        <div style={{display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap'}}>
          <span style={big(0.26, P.ta)}>{shown}</span>
          {c.unit ? <span style={big(0.09)}>{c.unit}</span> : null}
        </div>
      </Reveal>
      {c.body ? <Reveal delay={14} motion="slide"><div style={sub(0.048)}>{c.body}</div></Reveal> : null}
    </div>
  );
};

const Reveal: React.FC<{delay: number; motion: Exclude<MotionStyle, 'auto'>; children: React.ReactNode}> = ({delay, motion, children}) => {
  const st = useReveal(delay, motion);
  return <div style={st}>{children}</div>;
};

const StatBar: React.FC<{pct: number; accent: string; line: string; h: number; delay: number}> = ({pct, accent, line, h, delay}) => {
  const frame = useCurrentFrame();
  const fill = interpolate(frame, [delay, delay + 18], [0, Math.min(1, pct) * 100], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{background: line, borderRadius: h, height: h, overflow: 'hidden'}}>
      <div style={{width: `${fill}%`, height: '100%', background: accent, borderRadius: h}} />
    </div>
  );
};
