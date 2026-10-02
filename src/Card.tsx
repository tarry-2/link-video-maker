import React from 'react';
import {z} from 'zod';
import {
  AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring,
} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {getSkin, type Skin, type Entrance, type BgType, type DecoType} from './skins';

// ── 폰트 전체 등록(헤드라인 다양성) ──
const notoFont = 'Noto Sans KR';
loadFont({family: 'Black Han Sans', url: staticFile('fonts/BlackHanSans.ttf')});
loadFont({family: notoFont, url: staticFile('fonts/NotoSansKR-Bold.otf'), weight: '700'});
loadFont({family: 'Jua', url: staticFile('fonts/Jua.ttf')});
loadFont({family: 'Do Hyeon', url: staticFile('fonts/DoHyeon.ttf')});
loadFont({family: 'Gothic A1', url: staticFile('fonts/GothicA1-Black.ttf'), weight: '900'});
loadFont({family: 'Gowun Batang', url: staticFile('fonts/GowunBatang-Bold.ttf'), weight: '700'});
loadFont({family: 'Gaegu', url: staticFile('fonts/Gaegu-Bold.ttf'), weight: '700'});
loadFont({family: 'Song Myung', url: staticFile('fonts/SongMyung.ttf')});
loadFont({family: 'Noto Serif KR', url: staticFile('fonts/NotoSerifKR.ttf'), weight: '900'});

// 헤드 폰트별 적정 weight(해당 파일이 가진 굵기와 맞춤).
const HEAD_WEIGHT: Record<string, number | undefined> = {
  'Gothic A1': 900, 'Gowun Batang': 700, 'Gaegu': 700, 'Noto Serif KR': 900,
};

// ★레이아웃 원칙(레퍼런스 @web._moment): 본문 카드는 좌측=텍스트(깨끗한 여백)/우측=이미지로 분리, 텍스트는
//   이미지 위에 안 겹침. cover/closing만 풀블리드+시선폭탄. 이모지 금지(렌더 깨짐). 모든 등장 모션은
//   frame 40까지 정착(게시물 CardStill은 frame 45 렌더). 지속 모션(배경 드리프트·호흡)만 루프.
//   ★스킨 시스템: 덱마다 skin 하나로 폰트/배경/색/장식/안무가 통째로 달라져 100개면 100개가 다른 룩.
export type MotionStyle = 'auto' | 'pop' | 'slide' | 'type' | 'zoom' | 'flip';

export const cardSchema = z.object({
  type: z.enum(['cover', 'number', 'list', 'quote', 'compare', 'fix', 'body', 'closing', 'checklist', 'step', 'qa', 'stat']),
  bg: z.string().optional(),
  bgColor: z.string().optional(),
  accent: z.string(),
  theme: z.enum(['light', 'dark']).optional(),
  motion: z.enum(['auto', 'pop', 'slide', 'type', 'zoom', 'flip']).optional(),
  skin: z.string().optional(),     // ★덱 디자인 시스템 id(skins.ts). 없으면 기본 스킨.
  kicker: z.string().optional(),
  brand: z.string().optional(),
  badge: z.string().optional(),
  big: z.string().optional(),
  small: z.string().optional(),
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
function rotateHue(hex: string, deg: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16); let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0; const l = (max + min) / 2;
  const d = max - min; let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360) % 1; if (h < 0) h += 1;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let R, G, B;
  if (s === 0) { R = G = B = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
    R = hue2rgb(p, q, h + 1 / 3); G = hue2rgb(p, q, h); B = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (x: number) => Math.round(x * 255);
  return `#${((1 << 24) + (to(R) << 16) + (to(G) << 8) + to(B)).toString(16).slice(1)}`;
}
const outline = (px: number, c = '#000') =>
  `${px}px ${px}px 0 ${c}, -${px}px ${px}px 0 ${c}, ${px}px -${px}px 0 ${c}, -${px}px -${px}px 0 ${c}, 0 ${px}px 0 ${c}, 0 -${px}px 0 ${c}, ${px}px 0 0 ${c}, -${px}px 0 0 ${c}, ${px * 2}px 0 0 ${c}, -${px * 2}px 0 0 ${c}`;
const hexA = (o: number) => Math.round(Math.max(0, Math.min(1, o)) * 255).toString(16).padStart(2, '0');

const AUTO_MOTION: Record<CardData['type'], Exclude<MotionStyle, 'auto'>> = {
  cover: 'pop', number: 'zoom', list: 'slide', quote: 'pop',
  compare: 'slide', fix: 'slide', body: 'type', closing: 'pop',
  checklist: 'slide', step: 'slide', qa: 'pop', stat: 'zoom',
};

// ── 모션 프리미티브 ──
function useReveal(delay: number, style: Exclude<MotionStyle, 'auto'>) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const f = Math.max(0, frame - delay);
  const s = spring({frame: f, fps, config: {damping: 15, mass: 0.55, stiffness: 120}});
  const op = interpolate(f, [0, 6], [0, 1], {extrapolateRight: 'clamp'});
  const blur = interpolate(s, [0, 1], [7, 0], {extrapolateRight: 'clamp'});
  let transform = '';
  switch (style) {
    case 'pop': transform = `scale(${interpolate(s, [0, 1], [0.6, 1])})`; break;
    case 'slide': transform = `translateX(${interpolate(s, [0, 1], [-54, 0])}px)`; break;
    case 'zoom': transform = `scale(${interpolate(s, [0, 1], [1.32, 1])})`; break;
    case 'flip': transform = `perspective(900px) rotateX(${interpolate(s, [0, 1], [82, 0])}deg)`; break;
    case 'type': transform = `translateY(${interpolate(s, [0, 1], [20, 0])}px)`; break;
    default: transform = `translateY(${interpolate(s, [0, 1], [40, 0])}px)`;
  }
  return {opacity: op, transform, filter: blur > 0.15 ? `blur(${blur}px)` : 'none', willChange: 'transform, opacity, filter'};
}

const Reveal: React.FC<{delay: number; motion: Exclude<MotionStyle, 'auto'>; children: React.ReactNode; style?: React.CSSProperties}> = ({delay, motion, children, style}) => {
  const st = useReveal(delay, motion);
  return <div style={{display: 'inline-block', ...st, ...style}}>{children}</div>;
};

// 단어별 키네틱 타이포 — entrance 안무별로 다르게 등장. *강조* 단어는 색+하이라이터 스윕.
const Kinetic: React.FC<{
  text: string; delay: number; stagger?: number; style: React.CSSProperties;
  accent: string; highlight?: string; gap?: string; entrance?: Entrance;
}> = ({text, delay, stagger = 2.5, style, accent, highlight, gap, entrance = 'up'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const lines = text.split('\n');
  let wi = 0;
  return (
    <div style={{display: 'flex', flexDirection: 'column'}}>
      {lines.map((line, li) => (
        <div key={li} style={{display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: gap || '0.26em', rowGap: '0.08em'}}>
          {line.split(/\s+/).filter(Boolean).map((raw) => {
            const emph = raw.includes('*');
            const word = raw.replace(/\*/g, '');
            const d = delay + wi * stagger; wi += 1;
            const f = Math.max(0, frame - d);
            const s = spring({frame: f, fps, config: {damping: 15, mass: 0.5, stiffness: 130}});
            const op = interpolate(f, [0, 6], [0, 1], {extrapolateRight: 'clamp'});
            let tf = ''; let bl = interpolate(s, [0, 1], [7, 0], {extrapolateRight: 'clamp'});
            switch (entrance) {
              case 'fall': tf = `translateY(${interpolate(s, [0, 1], [-30, 0])}px)`; break;
              case 'pop': tf = `scale(${interpolate(s, [0, 1], [0.4, 1])})`; break;
              case 'flip': tf = `perspective(700px) rotateX(${interpolate(s, [0, 1], [80, 0])}deg)`; break;
              case 'rotate': tf = `rotate(${interpolate(s, [0, 1], [-10, 0])}deg) scale(${interpolate(s, [0, 1], [0.7, 1])})`; break;
              case 'zoomblur': tf = `scale(${interpolate(s, [0, 1], [1.5, 1])})`; bl = interpolate(s, [0, 1], [14, 0], {extrapolateRight: 'clamp'}); break;
              default: tf = `translateY(${interpolate(s, [0, 1], [28, 0])}px)`;
            }
            return (
              <span key={wi} style={{position: 'relative', display: 'inline-block', opacity: op, transform: tf, filter: bl > 0.15 ? `blur(${bl}px)` : 'none', willChange: 'transform, opacity, filter'}}>
                {emph ? <Sweep delay={d + 5} color={highlight || accent} /> : null}
                <span style={{...style, color: emph ? accent : (style.color as string), position: 'relative', zIndex: 1}}>{word}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const Sweep: React.FC<{delay: number; color: string}> = ({delay, color}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const sx = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 200, mass: 0.6, stiffness: 90}});
  return <span style={{position: 'absolute', left: '-0.08em', right: '-0.08em', top: '0.18em', bottom: '0.06em', background: color, opacity: 0.32, borderRadius: 4, transformOrigin: 'left center', transform: `scaleX(${sx})`, zIndex: 0}} />;
};

const LineDraw: React.FC<{delay: number; color: string; h?: number; style?: React.CSSProperties}> = ({delay, color, h = 3, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const sx = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 200, mass: 0.5, stiffness: 80}});
  return <div style={{height: h, background: color, borderRadius: h, transformOrigin: 'left', transform: `scaleX(${sx})`, ...style}} />;
};

export const Card: React.FC<CardData> = (c) => {
  const {width, height} = useVideoConfig();
  const skin = getSkin(c.skin);
  const head = skin.headFont;
  const headWeight = HEAD_WEIGHT[head];
  const defaultTheme: 'light' | 'dark' = c.theme || (c.type === 'cover' || c.type === 'closing' ? 'dark' : 'light');
  const isHero = c.type === 'cover' || c.type === 'closing';
  const hasImg = !!c.bg;
  // 스킨 테마 바이어스(히어로는 이미지/시선폭탄이라 항상 dark 취급).
  const theme: 'light' | 'dark' = isHero ? 'dark' : (skin.theme !== 'auto' ? skin.theme : defaultTheme);
  const motion: Exclude<MotionStyle, 'auto'> = c.motion && c.motion !== 'auto' ? c.motion : (skin.motion || AUTO_MOTION[c.type]);
  const pad = Math.round(width * 0.072);
  const imgCol = !isHero && hasImg;

  const ta = theme === 'light' ? shade(c.accent, -50) : shade(c.accent, 16);
  const bgAccent = theme === 'light' ? shade(c.accent, -34) : c.accent;
  const accent2 = rotateHue(c.accent, theme === 'light' ? 34 : 28);
  const P: Palette = theme === 'light'
    ? {base: '#F7F2E7', base2: '#EBE1CF', text: '#1a1611', sub: '#4a4238', line: '#00000014', numText: '#fff', chipText: '#fff', ta, bgAccent}
    : {base: c.bgColor || '#141118', base2: shade(c.bgColor || '#141118', -28), text: '#ffffff', sub: '#ffffffd6', line: '#ffffff20', numText: '#0c0c0c', chipText: '#fff', ta, bgAccent};

  const frame = useCurrentFrame();
  const dur = c.durationInFrames || 90;
  const bgZoom = 1.04 + interpolate(frame, [0, dur], [0, 0.07]);
  const bgPan = interpolate(frame, [0, dur], [0, -width * 0.02]);
  const breathe = 1 + Math.sin(frame / 42) * 0.004;
  const enter = spring({frame, fps: 30, config: {damping: 200, mass: 0.6, stiffness: 70}});
  const enterY = interpolate(enter, [0, 1], [26, 0]);

  return (
    <AbsoluteFill style={{fontFamily: notoFont, overflow: 'hidden', background: `linear-gradient(152deg, ${P.base} 0%, ${P.base2} 100%)`}}>
      {/* ── 배경 레이어 ── */}
      {isHero && hasImg ? (
        <>
          <Img src={staticFile(c.bg!)} style={{position: 'absolute', width: '104%', height: '104%', left: bgPan, top: 0, objectFit: 'cover', transform: `scale(${bgZoom})`, filter: 'saturate(1.18) contrast(1.08)'}} />
          <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.34) 0%, rgba(0,0,0,.04) 34%, rgba(0,0,0,.52) 72%, rgba(0,0,0,.82) 100%)'}} />
          <AbsoluteFill style={{background: `radial-gradient(120% 80% at 20% 108%, ${c.accent}2e 0%, transparent 52%)`}} />
        </>
      ) : imgCol ? (
        <>
          <CardBackground bg={skin.bg} accent={c.accent} accent2={accent2} frame={frame} width={width} height={height} theme={theme} base={P.base} subtle />
          <Img src={staticFile(c.bg!)} style={{position: 'absolute', right: 0, top: 0, width: '46%', height: '100%', objectFit: 'cover', transform: `scale(${bgZoom})`, transformOrigin: 'right center'}} />
          <div style={{position: 'absolute', right: 0, top: 0, width: '54%', height: '100%', background: `linear-gradient(90deg, ${P.base} 0%, ${P.base}f0 16%, ${P.base}00 44%)`}} />
          <div style={{position: 'absolute', right: 0, bottom: 0, width: '46%', height: '34%', background: `linear-gradient(0deg, ${P.base}d0 0%, transparent 100%)`}} />
          <div style={{position: 'absolute', right: '46%', top: '14%', bottom: '14%', width: Math.max(3, Math.round(width * 0.006)), background: `linear-gradient(180deg, transparent, ${bgAccent}, transparent)`, opacity: 0.5}} />
        </>
      ) : (
        <CardBackground bg={skin.bg} accent={c.accent} accent2={accent2} frame={frame} width={width} height={height} theme={theme} base={P.base} />
      )}

      {/* 질감: 그레인 + 비네트 */}
      <Grain />
      <AbsoluteFill style={{background: `radial-gradient(130% 120% at 50% 46%, transparent 58%, ${isHero || theme === 'dark' ? 'rgba(0,0,0,.4)' : 'rgba(80,60,30,.14)'} 100%)`, pointerEvents: 'none'}} />

      {/* 스킨 장식 레이어 */}
      {!isHero ? <CardDeco deco={skin.deco} accent={bgAccent} accent2={accent2} frame={frame} width={width} height={height} pad={pad} theme={theme} /> : null}

      {/* 상단 진행 바 */}
      <div style={{position: 'absolute', top: pad * 0.7, left: pad, right: pad, display: 'flex', gap: 7, justifyContent: 'center', zIndex: 4}}>
        {Array.from({length: c.total}).map((_, i) => {
          const active = i <= c.index;
          const grow = i === c.index ? spring({frame: Math.max(0, frame - 2), fps: 30, config: {damping: 200, stiffness: 60}}) : 1;
          return (
            <div key={i} style={{height: 5, flex: 1, maxWidth: 44, borderRadius: skin.radius === 0 ? 0 : 3, overflow: 'hidden', background: isHero ? '#ffffff33' : '#00000012'}}>
              <div style={{height: '100%', width: active ? `${i === c.index ? grow * 100 : 100}%` : '0%', background: bgAccent, borderRadius: skin.radius === 0 ? 0 : 3}} />
            </div>
          );
        })}
      </div>

      {/* 본문 텍스트 */}
      <AbsoluteFill style={{padding: pad, paddingTop: pad * 1.7, paddingBottom: pad * 1.5, zIndex: 3, width: imgCol ? '58%' : '100%', transform: `translateY(${enterY}px) scale(${breathe})`, transformOrigin: 'center'}}>
        <Body {...c} width={width} height={height} theme={theme} motion={motion} palette={P} accent2={accent2} head={head} headWeight={headWeight} skin={skin} />
      </AbsoluteFill>

      {/* 하단 워터마크 */}
      <div style={{position: 'absolute', bottom: pad * 0.6, left: pad, right: pad, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: isHero ? '#ffffffcc' : P.sub, fontSize: Math.round(width * 0.028), fontWeight: 700, zIndex: 4}}>
        <span>{String(c.index + 1).padStart(2, '0')} / {String(c.total).padStart(2, '0')}</span>
        <span style={{opacity: 0.85, letterSpacing: '0.5px'}}>{c.brand || '@onvideo'}</span>
      </div>
    </AbsoluteFill>
  );
};

type Palette = {base: string; base2: string; text: string; sub: string; line: string; numText: string; chipText: string; ta: string; bgAccent: string};

// ════════════════════ 배경 렌더러(스킨 14종) ════════════════════
const CardBackground: React.FC<{bg: BgType; accent: string; accent2: string; frame: number; width: number; height: number; theme: 'light' | 'dark'; base: string; subtle?: boolean}> = ({bg, accent, accent2, frame, width, height, theme, subtle}) => {
  const dark = theme === 'dark';
  const sub = !!subtle;
  const A = (o: number) => accent + hexA(sub ? o * 0.5 : o);
  const A2 = (o: number) => accent2 + hexA(sub ? o * 0.5 : o);
  switch (bg) {
    case 'mesh': {
      const d1x = 20 + Math.sin(frame / 90) * 12, d1y = 18 + Math.cos(frame / 110) * 10;
      const d2x = 82 + Math.cos(frame / 120) * 12, d2y = 78 + Math.sin(frame / 100) * 10;
      const d3y = 50 + Math.sin(frame / 140) * 14;
      const a = dark ? 0.5 : 0.17, b = dark ? 0.4 : 0.13;
      return <AbsoluteFill style={{background: [
        `radial-gradient(${width * 0.9}px ${width * 0.9}px at ${d1x}% ${d1y}%, ${A(a)} 0%, transparent 60%)`,
        `radial-gradient(${width * 0.8}px ${width * 0.8}px at ${d2x}% ${d2y}%, ${A2(b)} 0%, transparent 58%)`,
        `radial-gradient(${width}px ${width}px at 50% ${d3y}%, ${A2(b * 0.6)} 0%, transparent 62%)`,
      ].join(', ')}} />;
    }
    case 'dots': {
      const gap = Math.round(width * 0.055);
      const shift = (frame * 0.12) % gap;
      return <AbsoluteFill style={{backgroundImage: `radial-gradient(${dark ? accent2 : accent} ${Math.round(width * 0.006)}px, transparent ${Math.round(width * 0.006)}px)`, backgroundSize: `${gap}px ${gap}px`, backgroundPosition: `${shift}px ${shift}px`, opacity: dark ? 0.3 : 0.14}} />;
    }
    case 'diagonal': {
      const w1 = Math.round(width * 0.14);
      const shift = (frame * 0.4) % (w1 * 2);
      return <AbsoluteFill style={{background: `repeating-linear-gradient(45deg, ${A(dark ? 0.16 : 0.08)} 0, ${A(dark ? 0.16 : 0.08)} ${w1}px, transparent ${w1}px, transparent ${w1 * 2}px)`, backgroundPosition: `${shift}px 0`}} />;
    }
    case 'blob':
      return <>
        <div style={{position: 'absolute', width: width * 0.72, height: width * 0.72, borderRadius: '50%', top: -width * 0.22 + Math.sin(frame / 80) * 30, right: -width * 0.16 + Math.cos(frame / 90) * 26, background: accent, opacity: dark ? 0.28 : 0.12, filter: 'blur(75px)'}} />
        <div style={{position: 'absolute', width: width * 0.56, height: width * 0.56, borderRadius: '50%', bottom: -width * 0.14 - Math.sin(frame / 100) * 26, left: -width * 0.1 - Math.cos(frame / 95) * 24, background: accent2, opacity: dark ? 0.22 : 0.1, filter: 'blur(68px)'}} />
      </>;
    case 'blueprint': {
      const gap = Math.round(width * 0.06);
      return <>
        <AbsoluteFill style={{backgroundImage: `linear-gradient(${A(dark ? 0.1 : 0.08)} 1px, transparent 1px), linear-gradient(90deg, ${A(dark ? 0.1 : 0.08)} 1px, transparent 1px)`, backgroundSize: `${gap}px ${gap}px`}} />
        <AbsoluteFill style={{background: `radial-gradient(90% 70% at 70% ${30 + Math.sin(frame / 80) * 8}%, ${A2(dark ? 0.3 : 0.12)} 0%, transparent 55%)`}} />
      </>;
    }
    case 'spotlight': {
      const cx = 50 + Math.sin(frame / 90) * 18, cy = 36 + Math.cos(frame / 110) * 10;
      return <AbsoluteFill style={{background: `radial-gradient(70% 60% at ${cx}% ${cy}%, ${A(dark ? 0.5 : 0.2)} 0%, transparent 55%), radial-gradient(90% 90% at 50% 120%, ${A2(dark ? 0.3 : 0.12)} 0%, transparent 60%)`}} />;
    }
    case 'paper': {
      const lh = Math.round(width * 0.052);
      return <AbsoluteFill style={{backgroundImage: `repeating-linear-gradient(0deg, transparent 0, transparent ${lh - 1}px, ${A(0.06)} ${lh - 1}px, ${A(0.06)} ${lh}px)`}} />;
    }
    case 'memphis': {
      const sh = (o: number) => (dark ? accent2 : accent) + hexA(o);
      const sh2 = (o: number) => accent2 + hexA(o);
      const fl = (sp: number, amp: number) => Math.sin(frame / sp) * amp;
      return <>
        <div style={{position: 'absolute', top: '12%', left: '8%', width: width * 0.14, height: width * 0.14, borderRadius: '50%', border: `${Math.round(width * 0.012)}px solid ${sh(dark ? 0.4 : 0.2)}`, transform: `translateY(${fl(70, 10)}px)`}} />
        <div style={{position: 'absolute', top: '70%', left: '6%', width: 0, height: 0, borderLeft: `${width * 0.05}px solid transparent`, borderRight: `${width * 0.05}px solid transparent`, borderBottom: `${width * 0.09}px solid ${sh2(dark ? 0.35 : 0.18)}`, transform: `rotate(${15 + fl(90, 8)}deg)`}} />
        <div style={{position: 'absolute', top: '22%', right: '9%', width: width * 0.1, height: width * 0.1, background: sh(dark ? 0.3 : 0.16), transform: `rotate(${fl(80, 12)}deg)`, borderRadius: 8}} />
        <svg style={{position: 'absolute', bottom: '12%', right: '10%', width: width * 0.2, height: width * 0.1, opacity: dark ? 0.4 : 0.22}} viewBox="0 0 100 40"><path d="M0 20 Q 12 0 25 20 T 50 20 T 75 20 T 100 20" fill="none" stroke={accent2} strokeWidth="6" /></svg>
      </>;
    }
    case 'halftone': {
      const gap = Math.round(width * 0.04);
      return <AbsoluteFill style={{backgroundImage: `radial-gradient(${dark ? accent : accent} ${Math.round(width * 0.009)}px, transparent ${Math.round(width * 0.0095)}px)`, backgroundSize: `${gap}px ${gap}px`, opacity: dark ? 0.26 : 0.16, maskImage: 'radial-gradient(120% 90% at 80% 20%, #000 0%, transparent 70%)', WebkitMaskImage: 'radial-gradient(120% 90% at 80% 20%, #000 0%, transparent 70%)'}} />;
    }
    case 'wave': {
      const bands = [0.78, 0.86, 0.94];
      return <>
        {bands.map((y, i) => {
          const ph = frame / (40 + i * 14);
          const amp = height * (0.03 - i * 0.004);
          const pts = Array.from({length: 13}).map((_, k) => {
            const x = (k / 12) * width; const yy = y * height + Math.sin(ph + k * 0.7) * amp;
            return `${x},${yy}`;
          }).join(' ');
          return <svg key={i} style={{position: 'absolute', inset: 0, width, height}} preserveAspectRatio="none"><polygon points={`0,${height} ${pts} ${width},${height}`} fill={(i % 2 ? accent2 : accent) + hexA(dark ? 0.3 : 0.14)} /></svg>;
        })}
      </>;
    }
    case 'grid': {
      const gap = Math.round(width * 0.07);
      return <AbsoluteFill style={{backgroundImage: `linear-gradient(${A(dark ? 0.12 : 0.07)} 1.5px, transparent 1.5px), linear-gradient(90deg, ${A(dark ? 0.12 : 0.07)} 1.5px, transparent 1.5px)`, backgroundSize: `${gap}px ${gap}px`}} />;
    }
    case 'rings': {
      const cx = width * 0.5, cy = height * 0.42;
      const pulse = (frame / 60) % 1;
      return <AbsoluteFill>
        {[0.16, 0.3, 0.46, 0.64].map((r, i) => (
          <div key={i} style={{position: 'absolute', left: cx - width * r, top: cy - width * r, width: width * r * 2, height: width * r * 2, borderRadius: '50%', border: `${Math.max(2, Math.round(width * 0.003))}px solid ${A(dark ? 0.26 : 0.12)}`}} />
        ))}
        <div style={{position: 'absolute', left: cx - width * (0.16 + pulse * 0.5), top: cy - width * (0.16 + pulse * 0.5), width: width * (0.16 + pulse * 0.5) * 2, height: width * (0.16 + pulse * 0.5) * 2, borderRadius: '50%', border: `2px solid ${A2(dark ? 0.4 : 0.2)}`, opacity: 1 - pulse}} />
      </AbsoluteFill>;
    }
    case 'confetti': {
      const colors = [accent, accent2, shade(accent, 20), shade(accent2, 20)];
      return <>{Array.from({length: 26}).map((_, i) => {
        const seed = (i * 97) % 100; const x = (seed / 100) * width;
        const fall = ((frame * (0.6 + (i % 5) * 0.2) + i * 40) % (height + 80)) - 40;
        const rot = frame * (2 + (i % 4)) + i * 30;
        const sz = width * (0.012 + (i % 3) * 0.006);
        return <div key={i} style={{position: 'absolute', left: x, top: fall, width: sz, height: sz * 1.8, background: colors[i % colors.length], opacity: dark ? 0.6 : 0.4, transform: `rotate(${rot}deg)`, borderRadius: 2}} />;
      })}</>;
    }
    case 'gradient': {
      const ang = 130 + Math.sin(frame / 120) * 25;
      return <AbsoluteFill style={{background: `linear-gradient(${ang}deg, ${shade(accent, dark ? -40 : 0)} 0%, ${accent} 45%, ${accent2} 100%)`, opacity: dark ? 0.85 : 0.5}} />;
    }
    default:
      return null;
  }
};

// ════════════════════ 장식 레이어(스킨 8종) ════════════════════
const CardDeco: React.FC<{deco: DecoType; accent: string; accent2: string; frame: number; width: number; height: number; pad: number; theme: 'light' | 'dark'}> = ({deco, accent, accent2, frame, width, height, pad, theme}) => {
  const {fps} = useVideoConfig();
  const draw = spring({frame: Math.max(0, frame - 4), fps, config: {damping: 200, stiffness: 60}});
  const z = 2;
  switch (deco) {
    case 'corner-brackets': {
      const len = width * 0.1, th = Math.max(3, Math.round(width * 0.006)), m = pad * 0.5;
      const C = (pos: React.CSSProperties, h: React.CSSProperties, v: React.CSSProperties) => (
        <div style={{position: 'absolute', zIndex: z, ...pos, transform: `scale(${draw})`}}>
          <div style={{position: 'absolute', width: len, height: th, background: accent, ...h}} />
          <div style={{position: 'absolute', width: th, height: len, background: accent, ...v}} />
        </div>
      );
      return <>
        {C({top: m, left: m}, {top: 0, left: 0}, {top: 0, left: 0})}
        {C({top: m, right: m}, {top: 0, right: 0}, {top: 0, right: 0})}
        {C({bottom: m, left: m}, {bottom: 0, left: 0}, {bottom: 0, left: 0})}
        {C({bottom: m, right: m}, {bottom: 0, right: 0}, {bottom: 0, right: 0})}
      </>;
    }
    case 'frame': {
      const m = pad * 0.45;
      return <div style={{position: 'absolute', zIndex: z, top: m, left: m, right: m, bottom: m, border: `${Math.max(2, Math.round(width * 0.004))}px solid ${accent}`, borderRadius: 6, opacity: 0.5 * draw, transform: `scale(${0.98 + draw * 0.02})`}} />;
    }
    case 'side-bar':
      return <div style={{position: 'absolute', zIndex: z, left: 0, top: height * 0.2, width: Math.round(width * 0.02), height: `${draw * 60}%`, background: accent}} />;
    case 'tape': {
      const tw = width * 0.22, thh = width * 0.06;
      return <>
        <div style={{position: 'absolute', zIndex: z, top: pad * 1.0, left: -tw * 0.18, width: tw, height: thh, background: `${accent}44`, transform: 'rotate(-18deg)', opacity: draw, borderLeft: `2px dashed ${accent}66`, borderRight: `2px dashed ${accent}66`}} />
        <div style={{position: 'absolute', zIndex: z, top: pad * 1.3, right: -tw * 0.2, width: tw, height: thh, background: `${accent2}44`, transform: 'rotate(14deg)', opacity: draw, borderLeft: `2px dashed ${accent2}66`, borderRight: `2px dashed ${accent2}66`}} />
      </>;
    }
    case 'sticker-dots': {
      const pts = [[0.12, 0.2], [0.9, 0.3], [0.08, 0.78], [0.92, 0.72], [0.8, 0.9], [0.18, 0.5]];
      return <>{pts.map(([x, y], i) => {
        const fl = Math.sin(frame / (50 + i * 8) + i) * 6;
        return <div key={i} style={{position: 'absolute', zIndex: z, left: x * width, top: y * height + fl, width: width * (0.02 + (i % 3) * 0.008), height: width * (0.02 + (i % 3) * 0.008), borderRadius: '50%', background: i % 2 ? accent2 : accent, opacity: (theme === 'dark' ? 0.7 : 0.5) * draw}} />;
      })}</>;
    }
    case 'star-burst': {
      const x = width * 0.82, y = height * 0.22, s = width * 0.07 * draw;
      const spin = frame * 1.2;
      return <svg style={{position: 'absolute', zIndex: z, left: x, top: y, width: s, height: s, transform: `rotate(${spin}deg)`, overflow: 'visible'}} viewBox="-50 -50 100 100">
        {Array.from({length: 8}).map((_, i) => (
          <line key={i} x1={0} y1={0} x2={0} y2={-44} stroke={i % 2 ? accent2 : accent} strokeWidth={6} strokeLinecap="round" transform={`rotate(${i * 45})`} />
        ))}
      </svg>;
    }
    case 'underline-marker':
      return <div style={{position: 'absolute', zIndex: z, left: pad, top: pad * 1.5, width: width * 0.3 * draw, height: Math.round(width * 0.02), background: `${accent}55`, borderRadius: 4}} />;
    default:
      return null;
  }
};

// 필름 그레인(정적 SVG 노이즈 overlay).
const grainUri =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";
const Grain: React.FC = () => (
  <AbsoluteFill style={{backgroundImage: grainUri, backgroundSize: '160px 160px', opacity: 0.05, mixBlendMode: 'overlay', pointerEvents: 'none'}} />
);

// ════════════════════ 본문(카드 12종) ════════════════════
type BodyProps = Omit<CardData, 'skin'> & {width: number; height: number; theme: 'light' | 'dark'; motion: Exclude<MotionStyle, 'auto'>; palette: Palette; accent2: string; head: string; headWeight?: number; skin: Skin};

const Body: React.FC<BodyProps> = (c) => {
  const w = c.width;
  const P = c.palette;
  const ent: Entrance = c.skin.entrance;
  const stg = c.skin.stagger;
  const rad = c.skin.radius;
  const keepAll = {wordBreak: 'keep-all' as const};
  const big = (px: number, color?: string): React.CSSProperties => ({fontFamily: c.head, fontWeight: c.headWeight, fontSize: Math.round(w * px), lineHeight: 1.08, color: color || P.text, letterSpacing: c.skin.headTracking, ...keepAll});
  const sub = (px: number, color?: string): React.CSSProperties => ({fontFamily: notoFont, fontWeight: 700, fontSize: Math.round(w * px), lineHeight: 1.46, color: color || P.sub, ...keepAll});
  const chip = (bg: string, color = P.chipText): React.CSSProperties => ({display: 'inline-block', padding: '12px 26px', borderRadius: rad === 0 ? 2 : 999, background: bg, color, fontFamily: notoFont, fontWeight: 800, fontSize: Math.round(w * 0.04), whiteSpace: 'nowrap', lineHeight: 1});
  const center: React.CSSProperties = {height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.032)};
  const numCircle = (sz: number): React.CSSProperties => ({fontFamily: c.head, fontWeight: c.headWeight, fontSize: Math.round(w * sz), color: P.numText, background: `linear-gradient(145deg, ${P.bgAccent}, ${shade(P.bgAccent, -18)})`, width: Math.round(w * 0.1), height: Math.round(w * 0.1), borderRadius: rad === 0 ? 4 : '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1, boxShadow: `0 6px 18px ${P.bgAccent}44`});
  const panel = (bg: string, border: string): React.CSSProperties => ({background: bg, border: `2px solid ${border}`, borderRadius: rad === 0 ? 2 : Math.max(10, rad), padding: Math.round(w * 0.042)});
  const K = (text: string, delay: number, px: number, color?: string) => <Kinetic text={text} delay={delay} stagger={stg} entrance={ent} style={big(px, color)} accent={color && color !== P.text ? color : P.ta} highlight={P.bgAccent} />;

  const Kicker = c.kicker ? (
    <div style={{display: 'flex', alignItems: 'center', gap: Math.round(w * 0.016), marginBottom: Math.round(w * 0.016)}}>
      <LineDraw delay={0} color={P.bgAccent} h={Math.max(3, Math.round(w * 0.007))} style={{width: Math.round(w * 0.06)}} />
      <Reveal delay={3} motion="type"><span style={{...sub(0.03, P.ta), fontWeight: 800, letterSpacing: '2.5px', textTransform: c.skin.headTransform === 'none' ? 'none' : 'uppercase'}}>{c.kicker}</span></Reveal>
    </div>
  ) : null;

  switch (c.type) {
    case 'cover': {
      const bigSize = w * 0.155;
      const ol = Math.max(5, Math.round(bigSize * 0.05));
      const words = (c.big || c.title || '').split(/\s+/).filter(Boolean);
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.03), paddingBottom: w * 0.04}}>
          {c.badge ? <Reveal delay={2} motion="pop"><span style={{...chip('linear-gradient(160deg,#FF3A3A,#D40000)'), transform: 'rotate(-4deg)', fontSize: Math.round(w * 0.05), border: '3px solid #fff', boxShadow: '0 8px 26px rgba(0,0,0,.55)'}}>{c.badge}</span></Reveal> : null}
          {c.small ? <Reveal delay={6} motion="slide"><div style={{...sub(0.05, '#fff'), fontWeight: 800, textShadow: outline(Math.max(2, Math.round(w * 0.004)))}}>{c.small}</div></Reveal> : null}
          <div style={{display: 'flex', flexWrap: 'wrap', gap: `${bigSize * 0.04}px ${bigSize * 0.1}px`}}>
            {words.map((wd, i) => (
              <Reveal key={i} delay={10 + i * 3} motion="pop">
                <span style={{fontFamily: c.head, fontWeight: c.headWeight, fontSize: bigSize, lineHeight: 1.0, color: i % 2 === 1 ? c.accent : '#fff', textShadow: outline(ol), WebkitTextStroke: `${Math.round(ol * 0.28)}px #000`, letterSpacing: c.skin.headTracking}}>{wd}</span>
              </Reveal>
            ))}
          </div>
          {c.body ? <Reveal delay={16 + words.length * 3} motion="slide"><div style={{...sub(0.046, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={22 + words.length * 3} motion="type"><div style={{...sub(0.04, c.accent), fontWeight: 800, marginTop: w * 0.01}}>넘겨서 보기 →</div></Reveal>
        </div>
      );
    }

    case 'number':
      return <NumberBody c={c} w={w} P={P} Kicker={Kicker} big={big} sub={sub} center={center} />;

    case 'list':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.024)}}>
          {Kicker}
          {c.title ? <div style={{marginBottom: w * 0.014}}>{K(c.title, 2, 0.08)}</div> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={10 + i * 4} motion={c.motion} style={{display: 'block'}}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'center', padding: `${Math.round(w * 0.013)}px 0`}}>
                <span style={numCircle(0.05)}>{i + 1}</span>
                <span style={sub(0.048)}>{it}</span>
              </div>
              <LineDraw delay={12 + i * 4} color={P.line} h={2} />
            </Reveal>
          ))}
        </div>
      );

    case 'checklist':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.024)}}>
          {Kicker}
          {c.title ? <div style={{marginBottom: w * 0.014}}>{K(c.title, 2, 0.08)}</div> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={10 + i * 4} motion={c.motion} style={{display: 'block'}}>
              <div style={{display: 'flex', gap: Math.round(w * 0.028), alignItems: 'center', padding: `${Math.round(w * 0.013)}px 0`}}>
                <span style={{...numCircle(0.05), borderRadius: Math.round(w * 0.022)}}>✓</span>
                <span style={sub(0.048)}>{it}</span>
              </div>
              <LineDraw delay={12 + i * 4} color={P.line} h={2} />
            </Reveal>
          ))}
        </div>
      );

    case 'step':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: Math.round(w * 0.028)}}>
          {Kicker}
          {c.title ? <div style={{marginBottom: w * 0.004}}>{K(c.title, 2, 0.076)}</div> : null}
          {(c.items || []).map((it, i) => (
            <Reveal key={i} delay={10 + i * 4} motion={c.motion} style={{display: 'block'}}>
              <div style={{display: 'flex', gap: Math.round(w * 0.026), alignItems: 'flex-start'}}>
                <span style={numCircle(0.042)}>{i + 1}</span>
                <div style={{paddingTop: w * 0.004}}>
                  <div style={{...sub(0.026, P.ta), fontWeight: 800, letterSpacing: '1.5px'}}>STEP {i + 1}</div>
                  <div style={sub(0.046)}>{it}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      );

    case 'quote':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion="zoom"><div style={{...big(0.22, P.ta), lineHeight: 0.6}}>&ldquo;</div></Reveal>
          {K(c.title || '', 6, 0.09)}
          {c.body ? <Reveal delay={16} motion="slide"><div style={{display: 'flex', alignItems: 'center', gap: 14}}><LineDraw delay={18} color={P.bgAccent} h={3} style={{width: Math.round(w * 0.05)}} /><span style={{...sub(0.042), opacity: 0.92}}>{c.body}</span></div></Reveal> : null}
        </div>
      );

    case 'compare':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? K(c.title, 0, 0.068) : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.024)}}>
            <Panel delay={10} tone="bad" theme={c.theme} w={w} P={P} label="BEFORE" text={c.before || ''} sub={sub} panel={panel} />
            <Panel delay={18} tone="good" theme={c.theme} w={w} P={P} label="AFTER" text={c.after || ''} sub={sub} panel={panel} />
          </div>
        </div>
      );

    case 'fix':
      return (
        <div style={center}>
          {Kicker}
          {c.title ? K(c.title, 0, 0.068) : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.024)}}>
            <Panel delay={10} tone="bad" theme={c.theme} w={w} P={P} label="흔한 실수" text={c.wrong || ''} sub={sub} panel={panel} />
            <Panel delay={18} tone="good" theme={c.theme} w={w} P={P} label="이렇게 하세요" text={c.right || ''} sub={sub} panel={panel} />
          </div>
        </div>
      );

    case 'qa':
      return (
        <div style={center}>
          {Kicker}
          <Reveal delay={0} motion="pop" style={{display: 'block'}}>
            <div style={{display: 'flex', gap: Math.round(w * 0.02), alignItems: 'flex-start'}}>
              <span style={big(0.1, P.ta)}>Q.</span>
              <div style={big(0.07)}>{c.title}</div>
            </div>
          </Reveal>
          {c.body ? (
            <Reveal delay={10} motion="slide" style={{display: 'block'}}>
              <div style={{display: 'flex', gap: Math.round(w * 0.02), alignItems: 'flex-start', ...panel(c.theme === 'light' ? '#ffffffb0' : '#ffffff10', `${P.ta}44`), boxShadow: c.theme === 'light' ? '0 10px 30px rgba(0,0,0,.06)' : 'none'}}>
                <span style={big(0.08, P.ta)}>A.</span>
                <div style={sub(0.05)}>{c.body}</div>
              </div>
            </Reveal>
          ) : null}
        </div>
      );

    case 'stat': {
      const rows = (c.items || []).map((it) => {
        const [label, val] = it.split('|');
        return {label: (label || '').trim(), val: parseFloat((val || '').replace(/[^0-9.]/g, '')) || 0};
      });
      const max = Math.max(1, ...rows.map((r) => r.val));
      return (
        <div style={center}>
          {Kicker}
          {c.title ? <div style={{marginBottom: w * 0.008}}>{K(c.title, 0, 0.072)}</div> : null}
          <div style={{display: 'flex', flexDirection: 'column', gap: Math.round(w * 0.028)}}>
            {rows.map((r, i) => (
              <Reveal key={i} delay={8 + i * 4} motion={c.motion} style={{display: 'block'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: w * 0.008}}>
                  <span style={sub(0.044)}>{r.label}</span>
                  <StatValue val={r.val} delay={10 + i * 4} style={big(0.054, P.ta)} />
                </div>
                <StatBar pct={r.val / max} accent={P.bgAccent} line={P.line} h={Math.round(w * 0.03)} delay={10 + i * 4} rad={rad} />
              </Reveal>
            ))}
          </div>
        </div>
      );
    }

    case 'closing':
      return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: Math.round(w * 0.03), paddingBottom: w * 0.04}}>
          <Kinetic text={c.title || ''} delay={2} stagger={stg} entrance={ent} style={{...big(0.1, '#fff'), textShadow: outline(Math.max(3, Math.round(w * 0.004)))}} accent={c.accent} highlight={c.accent} />
          {c.body ? <Reveal delay={12} motion="slide"><div style={{...sub(0.048, '#fff'), textShadow: outline(Math.max(2, Math.round(w * 0.0035)))}}>{c.body}</div></Reveal> : null}
          <Reveal delay={18} motion="type" style={{display: 'block'}}>
            <div style={{display: 'flex', gap: 14, marginTop: w * 0.01, flexWrap: 'wrap'}}>
              <span style={chip(c.accent)}>저장하기</span>
              <span style={chip('#ffffff2a')}>공유하기</span>
            </div>
          </Reveal>
        </div>
      );

    case 'body':
    default:
      return (
        <div style={center}>
          {Kicker}
          {c.title ? K(c.title, 0, 0.086) : null}
          {c.title ? <LineDraw delay={6} color={P.bgAccent} h={Math.max(3, Math.round(w * 0.006))} style={{width: Math.round(w * 0.14), marginTop: w * 0.004}} /> : null}
          {c.body ? <Reveal delay={12} motion="type"><div style={sub(0.054)}>{c.body}</div></Reveal> : null}
        </div>
      );
  }
};

const Panel: React.FC<{delay: number; tone: 'bad' | 'good'; theme?: 'light' | 'dark'; w: number; P: Palette; label: string; text: string; sub: (px: number, color?: string) => React.CSSProperties; panel: (bg: string, border: string) => React.CSSProperties}> = ({delay, tone, theme, w, P, label, text, sub, panel}) => {
  const bad = tone === 'bad';
  const badColor = theme === 'light' ? '#c0392b' : '#ff8a8a';
  const border = bad ? (theme === 'light' ? '#c0392b55' : '#ff8a8a55') : P.ta;
  const bg = bad ? (theme === 'light' ? '#ffffffa0' : '#ffffff0c') : `${P.bgAccent}16`;
  return (
    <Reveal delay={delay} motion="slide" style={{display: 'block'}}>
      <div style={{...panel(bg, border), boxShadow: theme === 'light' && bad ? '0 10px 30px rgba(0,0,0,.05)' : 'none'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
          <span style={{width: Math.round(w * 0.022), height: Math.round(w * 0.022), borderRadius: 6, background: bad ? badColor : P.bgAccent, flexShrink: 0}} />
          <span style={{...sub(0.034, bad ? badColor : P.ta), fontWeight: 800, letterSpacing: '1px'}}>{label}</span>
        </div>
        <div style={{...sub(0.05), color: bad ? P.sub : P.text}}>{text}</div>
      </div>
    </Reveal>
  );
};

const NumberBody: React.FC<{c: BodyProps; w: number; P: Palette; Kicker: React.ReactNode; big: (px: number, color?: string) => React.CSSProperties; sub: (px: number, color?: string) => React.CSSProperties; center: React.CSSProperties}> = ({c, w, P, Kicker, big, sub, center}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const raw = c.number || '';
  const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
  const prefix = raw.match(/^[^0-9.]+/)?.[0] || '';
  const suffix = raw.match(/[^0-9.]+$/)?.[0] || '';
  const ease = spring({frame: Math.max(0, frame - 4), fps, config: {damping: 200, mass: 0.8, stiffness: 55}});
  const shown = isNaN(num) ? raw : prefix + Math.round(interpolate(ease, [0, 1], [0, num])).toLocaleString() + suffix;
  return (
    <div style={center}>
      {Kicker}
      {c.title ? <Reveal delay={0} motion="slide"><div style={sub(0.052)}>{c.title}</div></Reveal> : null}
      <Reveal delay={4} motion="zoom" style={{display: 'block'}}>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap'}}>
          <span style={{...big(0.28, P.ta), textShadow: c.theme === 'light' ? 'none' : `0 8px 40px ${P.bgAccent}66`}}>{shown}</span>
          {c.unit ? <span style={big(0.1)}>{c.unit}</span> : null}
        </div>
      </Reveal>
      <LineDraw delay={12} color={P.bgAccent} h={Math.max(3, Math.round(w * 0.006))} style={{width: Math.round(w * 0.18)}} />
      {c.body ? <Reveal delay={16} motion="slide"><div style={sub(0.048)}>{c.body}</div></Reveal> : null}
    </div>
  );
};

const StatValue: React.FC<{val: number; delay: number; style: React.CSSProperties}> = ({val, delay, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ease = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 200, mass: 0.7, stiffness: 55}});
  const n = interpolate(ease, [0, 1], [0, val]);
  const shown = Number.isInteger(val) ? Math.round(n).toLocaleString() : n.toFixed(1);
  return <span style={style}>{shown}</span>;
};

const StatBar: React.FC<{pct: number; accent: string; line: string; h: number; delay: number; rad: number}> = ({pct, accent, line, h, delay, rad}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ease = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 200, mass: 0.8, stiffness: 50}});
  const fill = interpolate(ease, [0, 1], [0, Math.min(1, pct) * 100]);
  const br = rad === 0 ? 2 : h;
  return (
    <div style={{background: line, borderRadius: br, height: h, overflow: 'hidden'}}>
      <div style={{width: `${fill}%`, height: '100%', background: `linear-gradient(90deg, ${shade(accent, 12)}, ${accent})`, borderRadius: br, boxShadow: `0 0 16px ${accent}55`}} />
    </div>
  );
};
