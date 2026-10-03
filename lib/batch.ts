// 배치 생성 — 주제 여러 개를 큐에 넣으면 studio가 idle일 때마다 하나씩 자동 제작(대본→영상)한다.
// studio는 한 번에 한 작업만(active 락) 돌므로, 큐는 폴링으로 "idle이면 다음 주제 투입"만 한다(studio 내부 불변).
// 상태는 data/batch.json에 영속(재배포/재시작해도 큐 유지). 실패한 항목은 멈추지 않고 다음으로 넘어간다.
import fs from 'node:fs';
import path from 'node:path';
import type {Studio} from './studio';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'batch.json');

export type BatchItem = {
  topic: string;
  status: 'queued' | 'creating' | 'rendering' | 'done' | 'failed';
  projectId?: string; // create 후 연결된 작업 id
  error?: string;
};
// 큐에 공유되는 제작 설정(한 번 정하면 모든 주제에 동일 적용).
export type BatchConfig = {
  presetId: string; duration: number; voice: string;
  quality: 'fast' | 'high'; imageStyle: string; music: boolean; // 스타일 id(레지스트리)
  characterId?: string;
};
type BatchState = {items: BatchItem[]; config: BatchConfig | null; running: boolean};

function load(): BatchState {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {items: [], config: null, running: false}; }
}
function save(s: BatchState) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(s));
  fs.renameSync(FILE + '.tmp', FILE);
}

export class BatchQueue {
  private ticking = false;
  constructor(private studio: Studio) {}

  status() {
    const s = load();
    const done = s.items.filter(i => i.status === 'done').length;
    const failed = s.items.filter(i => i.status === 'failed').length;
    const pending = s.items.filter(i => i.status === 'queued' || i.status === 'creating' || i.status === 'rendering').length;
    return {items: s.items, config: s.config, running: s.running, done, failed, pending, total: s.items.length};
  }

  // 주제 목록 + 공통 설정을 큐에 추가(기존 큐에 이어붙임). 빈 줄·중복 제거.
  enqueue(topics: string[], config: BatchConfig) {
    const s = load();
    const clean = [...new Set(topics.map(t => t.trim()).filter(Boolean))].slice(0, 50);
    for (const topic of clean) s.items.push({topic, status: 'queued'});
    s.config = config;
    s.running = true;
    save(s);
    this.tick();
    return this.status();
  }

  // 큐 비우기(진행 중인 studio 작업은 그대로 끝남 — 큐만 중단).
  clear() {
    const s = load();
    s.items = s.items.filter(i => i.status === 'rendering' || i.status === 'creating'); // 진행 중인 건 남겨 완료되게
    s.running = false;
    save(s);
    return this.status();
  }

  // 큐를 한 칸 전진. studio가 idle이고 대기 주제가 있으면 다음을 투입. 상태 변화를 폴링으로 추적.
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = load();
      if (!s.running || !s.config) return;

      // 1) 진행 중 항목(creating/rendering)의 완료 여부를 studio 상태로 확인.
      for (const it of s.items) {
        if ((it.status === 'creating' || it.status === 'rendering') && it.projectId) {
          const st = this.projectStatus(it.projectId);
          if (it.status === 'creating') {
            if (st === 'draft') { // 대본 완료 → 렌더 시작
              try { this.studio.render(it.projectId, this.revisionOf(it.projectId)); it.status = 'rendering'; }
              catch { /* studio 바쁨 → 다음 tick에 재시도 */ }
            } else if (st === 'failed' || st === 'missing') { it.status = 'failed'; it.error = '대본 생성 실패'; }
          } else if (it.status === 'rendering') {
            if (st === 'completed') it.status = 'done';
            else if (st === 'failed' || st === 'missing') { it.status = 'failed'; it.error = '영상 제작 실패'; }
          }
        }
      }
      save(s);

      // 2) studio가 idle이고 대기 주제가 있으면 다음 투입(create → 자동 대본).
      const anyActive = s.items.some(i => i.status === 'creating' || i.status === 'rendering');
      if (!anyActive) {
        const next = s.items.find(i => i.status === 'queued');
        if (next) {
          try {
            const r = this.studio.create({
              mode: 'topic', topic: next.topic,
              presetId: s.config.presetId, duration: s.config.duration, voice: s.config.voice,
              quality: s.config.quality, imageStyle: s.config.imageStyle, music: s.config.music,
              characterId: s.config.characterId || '',
            });
            next.projectId = (r as any).id; next.status = 'creating';
          } catch { /* studio 바쁨 → 다음 tick */ }
        }
      }
      save(s);

      // 3) 아직 할 일 남았으면 계속 폴링. 다 끝났으면 running 종료.
      const left = s.items.some(i => i.status === 'queued' || i.status === 'creating' || i.status === 'rendering');
      if (left) setTimeout(() => this.tick(), 6000);
      else { const f = load(); f.running = false; save(f); }
    } finally {
      this.ticking = false;
    }
  }

  private projectStatus(id: string): 'draft' | 'planning' | 'running' | 'completed' | 'failed' | 'missing' {
    try { return this.studio.view(id).status as any; } catch { return 'missing'; }
  }
  private revisionOf(id: string): number {
    try { return this.studio.view(id).revision; } catch { return 1; }
  }
}
