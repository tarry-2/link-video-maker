import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSchema, editSchema, estimate, signatures, resolveProduct, assertTokens, type Project, type Scene, type Media} from './studio-model';
import {getPreset} from './presets';
import {VOICES} from './tts';

// 제작 시작 시 테리가 고른 설정을 사람이 읽을 수 있게 로그로 남긴다(처음부터 끝까지 전 절차 추적용).
function settingsLines(p: Project): string[] {
  const inp = p.input;
  const modeLabel = inp.mode === 'auto' ? '링크로 자동' : inp.mode === 'topic' ? '주제 추천' : '내 이미지로';
  const source = inp.mode === 'auto' ? inp.url : inp.mode === 'topic' ? inp.topic : `업로드 이미지 ${p.sources.length}장${inp.keywords ? ` · 키워드 "${inp.keywords}"` : ''}`;
  const preset = getPreset(inp.presetId);
  const voiceKey = inp.voice || preset?.voice || 'adam';
  const voiceLabel = VOICES[voiceKey]?.label || voiceKey;
  return [
    '[설정] ───────── 제작 설정 ─────────',
    `[설정] 모드: ${modeLabel}`,
    `[설정] 소재: ${String(source).slice(0, 120) || '(없음)'}`,
    `[설정] 카테고리: ${preset ? `${preset.emoji} ${preset.label}` : '자동/없음'}`,
    `[설정] 길이: ${inp.duration}초`,
    `[설정] 목소리: ${voiceLabel}${inp.voice ? '' : ' (카테고리 추천)'}`,
    `[설정] 이미지: ${inp.quality === 'high' ? '고퀄' : '빠르게'} · ${inp.imageStyle === 'anime' ? '애니' : '실사'}`,
    `[설정] 배경음악: ${inp.music ? 'ON' : 'OFF'}`,
    inp.product ? `[설정] 상품 고정: ${inp.product.name}` : '[설정] 상품 고정: 없음',
    '[설정] ────────────────────────────',
  ];
}

export type StudioDependencies = {
  plan: (p: Project, directory: string, log: (s: string) => void) => Promise<{title: string; subject: string; musicPrompt: string; scenes: unknown[]}>;
  image: (p: Project, s: Scene, file: string, log: (s: string) => void) => Promise<void>;
  voice: (p: Project, s: Scene, file: string) => Promise<Pick<Media, 'words' | 'frames'>>;
  music: (p: Project, file: string, log: (s: string) => void) => Promise<void>;
  render: (p: Project, directory: string, output: string, log: (s: string) => void) => Promise<void>;
};
export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export class Studio {
  private active: string | null = null;
  private tasks = new Map<string, Promise<void>>();
  constructor(readonly root: string, private deps: StudioDependencies) {
    fs.mkdirSync(root, {recursive: true});
    for (const p of this.list()) {
      if (p.status === 'running' || p.status === 'planning') {
        p.status = 'failed'; p.error = '서버가 재시작됐습니다. 완료된 단계는 유지됩니다. 이어서 재시작하세요.';
        this.save(p);
      }
    }
  }
  directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new StudioError('작업을 찾을 수 없습니다.', 404);
    return path.join(this.root, id);
  }
  get(id: string): Project {
    const file = path.join(this.directory(id), 'project.json');
    if (!fs.existsSync(file)) throw new StudioError('작업을 찾을 수 없습니다.', 404);
    const p: Project = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Missing files (e.g. incomplete volume restore) are never treated as cached.
    for (const scene of p.scenes) for (const kind of ['image', 'voice'] as const) {
      if (scene[kind] && !fs.existsSync(path.join(this.directory(id), scene[kind]!.file))) scene[kind] = undefined;
    }
    if (p.bgm && !fs.existsSync(path.join(this.directory(id), p.bgm.file))) p.bgm = undefined;
    return p;
  }
  list(): Project[] {
    return fs.readdirSync(this.root).filter(id => /^[0-9a-f-]{36}$/.test(id)).flatMap(id => {
      try { return [this.get(id)]; } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  summary(p: Project) {
    return {id: p.id, title: p.title, status: p.status, phase: p.phase, updatedAt: p.updatedAt,
      revision: p.revision, error: p.error, sceneCount: p.scenes.length, output: p.output, startedAt: p.startedAt};
  }
  view(id: string) {
    const p = this.get(id);
    return {...p, scenes: p.scenes.map(s => ({...s,
      imageCurrent: s.image?.signature === signatures(p, s).image,
      voiceCurrent: s.voice?.signature === signatures(p, s).voice,
    })), estimate: estimate(p)};
  }
  private save(p: Project) {
    p.updatedAt = new Date().toISOString();
    const dir = this.directory(p.id);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'project.json.tmp'), JSON.stringify(p));
    fs.renameSync(path.join(dir, 'project.json.tmp'), path.join(dir, 'project.json'));
  }
  private available() {
    if (this.active) throw new StudioError('다른 제작 작업이 진행 중입니다. 완료 후 다시 시도하세요.', 409);
  }
  private editable(id: string, revision: number) {
    const p = this.get(id);
    if (p.status === 'running' || p.status === 'planning') throw new StudioError('작업 진행 중에는 수정할 수 없습니다.', 409);
    if (revision !== p.revision) throw new StudioError('다른 창에서 변경됐습니다. 작업 내역에서 다시 열어주세요.', 409);
    return p;
  }
  private start(p: Project, phase: string, task: (log: (s: string) => void) => Promise<void>) {
    this.available();
    this.active = p.id;
    p.status = phase === '대본 작성' ? 'planning' : 'running';
    p.phase = phase; p.error = undefined;
    p.startedAt = new Date().toISOString(); // 경과시간 타이머 기준
    this.save(p);
    const log = (s: string) => { p.logs.push(s.slice(0, 500)); p.logs = p.logs.slice(-150); this.save(p); };
    const pending = Promise.resolve().then(() => task(log)).catch((e: Error) => {
      p.status = 'failed'; p.error = e.message.slice(0, 500); log('[실패] ' + p.error);
    }).finally(() => { this.active = null; this.tasks.delete(p.id); this.save(p); });
    this.tasks.set(p.id, pending);
    return this.view(p.id);
  }
  async settled(id: string) { await this.tasks.get(id); return this.get(id); }
  create(body: unknown) {
    this.available();
    const {images, ...input} = createSchema.parse(body);
    const id = randomUUID();
    const p: Project = {id, revision: 1, createdAt: new Date().toISOString(), updatedAt: '',
      status: 'draft', phase: '', logs: [], input, sources: [], title: '새 영상', subject: '', musicPrompt: '', scenes: []};
    // Validate all uploads before creating a durable project.
    const uploads = images.map((url, i) => {
      const m = url.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new StudioError('JPG, PNG, WebP 이미지만 지원합니다.');
      const data = Buffer.from(m[2], 'base64');
      const valid = m[1] === 'png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : m[1] === 'jpeg' ? data[0] === 255 && data[1] === 216
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
      if (!valid || data.length > 10 * 1024 * 1024) throw new StudioError('이미지 형식 또는 크기를 확인하세요(장당 최대 10MB).');
      return {name: `source-${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, data};
    });
    fs.mkdirSync(this.directory(id), {recursive: true});
    for (const u of uploads) { fs.writeFileSync(path.join(this.directory(id), u.name), u.data); p.sources.push(u.name); }
    this.save(p);
    return this.plan(p);
  }
  private plan(p: Project) {
    return this.start(p, '대본 작성', async log => {
      settingsLines(p).forEach(log);
      log('[대본] 소재를 읽고 기승전결 대본을 만드는 중…');
      const draft = await this.deps.plan(p, this.directory(p.id), log);
      const valid = editSchema.parse({...draft, revision: p.revision});
      p.title = valid.title; p.subject = String(draft.subject || '').slice(0, 300); p.musicPrompt = valid.musicPrompt;
      p.scenes = valid.scenes;
      if (p.input.mode === 'manual') p.scenes.forEach((s, i) => { s.imageIndex = Math.min(s.imageIndex ?? i, p.sources.length - 1); });
      // Product facts live outside AI output. Narration references immutable values.
      if (p.input.product) {
        p.title = p.input.product.name;
        p.scenes.forEach((s, i) => {
          s.hookTop = '{{product.name}}';
          s.hookAccent = i === p.scenes.length - 1 ? '{{product.price}}' : '';
          s.narration = i === 0 ? '{{product.name}}을 소개합니다. 사진 속 모습을 천천히 살펴보세요. 지금부터 함께 확인해 볼게요.'
            : i === p.scenes.length - 1 ? '{{product.name}}. {{product.price}}. {{product.benefit}}.'
            : '{{product.name}}의 원본 사진입니다. 화면 속 모습을 자세히 살펴보고, 찾으시던 상품인지 확인해 보세요.';
        });
      }
      this.validateScenes(p, p.scenes);
      p.status = 'draft'; p.phase = '대본 검토'; log('[대본] 검토 후 제작 버튼을 누르세요. 이미지·음성은 아직 생성하지 않았습니다.');
    });
  }
  private validateScenes(p: Project, scenes: Scene[]) {
    for (const s of scenes) {
      for (const value of [s.narration, s.hookTop, s.hookAccent]) assertTokens(value, p.input.product);
      if (!resolveProduct(s.narration, p.input.product).trim()) throw new StudioError('나레이션을 입력하세요.');
      if (p.input.mode === 'manual' && (s.imageIndex === undefined || s.imageIndex >= p.sources.length))
        throw new StudioError('올바른 원본 이미지를 선택하세요.');
    }
  }
  edit(id: string, body: unknown) {
    const edit = editSchema.parse(body);
    const p = this.editable(id, edit.revision);
    if (!p.scenes.length || edit.scenes.length !== p.scenes.length) throw new StudioError('현재 작업의 장면 수를 유지하세요.');
    this.validateScenes(p, edit.scenes);
    p.title = edit.title;
    if (p.musicPrompt !== edit.musicPrompt) p.bgm = undefined;
    p.musicPrompt = edit.musicPrompt;
    p.scenes = edit.scenes.map((s, i) => ({...p.scenes[i], ...s}));
    p.revision++; p.status = 'draft'; p.error = undefined; p.phase = '수정 저장됨';
    this.save(p); return this.view(id);
  }
  private async media(p: Project, index: number, kind: 'image' | 'voice', log: (s: string) => void) {
    const s = p.scenes[index]; const signature = signatures(p, s)[kind];
    if (s[kind]?.signature === signature && fs.existsSync(path.join(this.directory(p.id), s[kind]!.file))) return;
    p.phase = `장면 ${index + 1} ${kind === 'image' ? '이미지' : '음성'}`;
    log(`[${p.phase}] 준비 중…`);
    let file = `${kind}-${index}-${signature}.${kind === 'image' ? 'jpg' : 'mp3'}`;
    let extra: Pick<Media, 'words' | 'frames'> = {};
    if (kind === 'image' && p.input.mode === 'manual') {
      file = p.sources[s.imageIndex!];
      if (!fs.existsSync(path.join(this.directory(p.id), file))) throw new StudioError('원본 사진이 없습니다. 새 작업에 다시 올려주세요.');
    } else {
      const target = path.join(this.directory(p.id), file);
      if (kind === 'image') await this.deps.image(p, s, target, log);
      else extra = await this.deps.voice(p, s, target);
      if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error('생성된 파일이 비어 있습니다. 재시작하세요.');
    }
    s[kind] = {signature, file, ...extra}; this.save(p);
  }
  regenerate(id: string, index: number, kind: 'image' | 'voice', revision: number) {
    this.available();
    const p = this.editable(id, revision);
    if (!Number.isInteger(index) || !p.scenes[index]) throw new StudioError('장면이 없습니다.');
    if (kind === 'image' && p.input.mode === 'manual') throw new StudioError('원본 사진은 이미지 선택에서 교체하세요.');
    const field = kind === 'image' ? 'imageVersion' : 'voiceVersion';
    p.scenes[index][field] = (p.scenes[index][field] || 0) + 1; p.revision++;
    return this.start(p, '장면 수정', async log => {
      await this.media(p, index, kind, log); p.status = 'draft'; p.phase = '장면 수정 완료';
      log('[장면] 수정 완료. 최종 제작을 누르면 다른 장면은 재사용합니다.');
    });
  }
  render(id: string, revision: number) {
    this.available();
    const p = this.editable(id, revision);
    if (!p.scenes.length) return this.plan(p);
    this.validateScenes(p, p.scenes);
    return this.start(p, '제작', async log => {
      settingsLines(p).forEach(log);
      log(`[제작] 최종 제작 시작 — 장면 ${p.scenes.length}개의 이미지·음성 준비 후 배경음악·영상 합성으로 진행합니다.`);
      for (let i = 0; i < p.scenes.length; i++) {
        log(`[진행] 장면 ${i + 1}/${p.scenes.length} 준비`);
        await this.media(p, i, 'image', log); await this.media(p, i, 'voice', log);
      }
      log('[진행] 모든 장면 소재 준비 완료.');
      if (p.input.music && !p.bgm) {
        p.phase = '배경음악'; this.save(p);
        const file = `music-${randomUUID()}.mp3`;
        await this.deps.music(p, path.join(this.directory(id), file), log);
        p.bgm = {signature: p.musicPrompt, file}; this.save(p);
      }
      p.phase = '영상 합성'; this.save(p);
      const output = `video-${p.revision}-${randomUUID()}.mp4`;
      await this.deps.render(p, this.directory(id), path.join(this.directory(id), output), log);
      p.output = output; p.outputRevision = p.revision; p.status = 'completed'; p.phase = '완성'; log('[완료] 영상을 다운로드할 수 있습니다.');
    });
  }
  asset(id: string, name: string) {
    const p = this.get(id);
    const allowed = [...p.sources, ...p.scenes.flatMap(s => [s.image?.file, s.voice?.file]), p.bgm?.file, p.output];
    if (!allowed.includes(name) || name !== path.basename(name)) throw new StudioError('파일이 없습니다.', 404);
    const file = path.join(this.directory(id), name);
    if (!fs.existsSync(file)) throw new StudioError('파일이 없습니다.', 404);
    return file;
  }
}
