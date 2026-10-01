import {z} from 'zod';
import {createHash} from 'node:crypto';

const text = (max: number) => z.string().max(max);
const rate = z.number().finite().min(0).max(1000000).nullable().default(null);
export const ratesSchema = z.object({draft: rate, image: rate, voice: rate, music: rate});
export const productSchema = z.object({
  name: text(60).min(1), price: text(40), benefit: text(100), url: text(200),
}).refine(p => !p.url || /^https?:\/\/[^\s]+$/.test(p.url), '구매 주소는 http 또는 https로 입력하세요.');
export const createSchema = z.object({
  mode: z.enum(['auto', 'manual', 'topic']), url: text(2000).default(''),
  topic: text(500).default(''),
  images: z.array(text(15_000_000)).max(20).default([]),
  keywords: text(1000).default(''), facts: text(4000).default(''),
  duration: z.number().int().min(15).max(180),
  voice: text(60).default(''), presetId: text(80).default(''),
  quality: z.enum(['fast', 'high']).default('high'),
  imageStyle: z.enum(['real', 'anime']).default('real'),
  music: z.boolean().default(false),
  product: productSchema.nullable().default(null),
  rates: ratesSchema.default({draft: null, image: null, voice: null, music: null}),
}).superRefine((v, ctx) => {
  if (v.mode === 'auto' && !/^https?:\/\/[^\s]+$/.test(v.url))
    ctx.addIssue({code: 'custom', message: 'http 또는 https 링크를 입력하세요.'});
  if (v.mode === 'manual' && !v.images.length)
    ctx.addIssue({code: 'custom', message: '이미지를 최소 1장 넣어주세요.'});
  if (v.mode === 'topic' && !v.topic.trim())
    ctx.addIssue({code: 'custom', message: '주제를 선택하거나 입력하세요.'});
  if (v.product && v.mode !== 'manual')
    ctx.addIssue({code: 'custom', message: '상품 정보 고정은 원본 사진을 쓰는 내 이미지 모드에서 사용하세요.'});
});
export const sceneEditSchema = z.object({
  narration: text(1600).min(1), hookTop: text(120), hookAccent: text(120),
  visualPrompt: text(2000).default(''), accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  imageIndex: z.number().int().min(0).max(19).optional(),
});
export const editSchema = z.object({
  revision: z.number().int(), title: text(120).min(1), musicPrompt: text(1000),
  scenes: z.array(sceneEditSchema).min(1).max(12),
});
export type EditScene = z.infer<typeof sceneEditSchema>;
export type Product = z.infer<typeof productSchema>;
export type Rates = z.infer<typeof ratesSchema>;
export type Input = Omit<z.infer<typeof createSchema>, 'images'>;
export type Media = {signature: string; file: string; words?: {t: string; s: number; e: number}[]; frames?: number};
export type Scene = EditScene & {image?: Media; voice?: Media; imageVersion?: number; voiceVersion?: number};
export type Project = {
  id: string; revision: number; createdAt: string; updatedAt: string;
  status: 'planning' | 'draft' | 'running' | 'completed' | 'failed';
  phase: string; error?: string; logs: string[]; input: Input; sources: string[];
  title: string; subject: string; musicPrompt: string; scenes: Scene[];
  bgm?: Media; output?: string; outputRevision?: number; outputR2?: string; // outputR2=R2에 올린 완성영상 키(있으면 볼륨엔 없음)
  characterRef?: string; // 애니 캐릭터 기준 이미지 파일명(작업 폴더 내). 모든 장면·다음 편이 이걸 참조해 같은 주인공 유지
  startedAt?: string; // 현재/마지막 실행 시작 시각(경과시간 타이머용)
};
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function resolveProduct(value: string, product: Product | null): string {
  return value.replace(/\{\{product\.(name|price|benefit|url)\}\}/g, (_, key: keyof Product) => product?.[key] || '');
}
export function assertTokens(value: string, product: Product | null) {
  const stripped = resolveProduct(value, product);
  if (/\{\{|\}\}/.test(stripped)) throw new Error('알 수 없는 상품 변수입니다.');
  if (!product && /\{\{product\./.test(value)) throw new Error('고정할 상품 정보가 없습니다.');
}
export function signatures(p: Project, s: Scene) {
  return {
    image: fingerprint([p.input.mode, p.input.quality, p.input.imageStyle, p.subject, s.visualPrompt, p.sources[s.imageIndex ?? 0], s.imageVersion || 0]),
    voice: fingerprint([resolveProduct(s.narration, p.input.product), p.input.voice, p.input.presetId, s.voiceVersion || 0]),
  };
}
export function estimate(p: Project) {
  const images = p.input.mode === 'manual' ? 0 : p.scenes.filter(s => s.image?.signature !== signatures(p, s).image).length;
  const characters = p.scenes.filter(s => s.voice?.signature !== signatures(p, s).voice)
    .reduce((n, s) => n + resolveProduct(s.narration, p.input.product).length, 0);
  const music = p.input.music && !p.bgm ? Math.max(10, p.input.duration) / 60 : 0;
  const quantities = {draft: p.scenes.length ? 0 : 1, image: images, voice: characters / 1000, music};
  const missing: string[] = [];
  let subtotal = 0;
  for (const key of Object.keys(quantities) as (keyof Rates)[]) {
    if (!quantities[key]) continue;
    if (p.input.rates[key] === null) missing.push(key);
    else subtotal += quantities[key] * p.input.rates[key]!;
  }
  return {images, characters, musicMinutes: music, subtotal: Math.ceil(subtotal), missing, complete: !missing.length};
}
