// 키 로드/저장 — .env.local을 읽고 쓴다(웹 설정 화면에서 저장할 때도 사용).
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), '.env.local');

export type StoredKeys = {
  GEMINI_KEYS?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  REPLICATE_API_TOKEN?: string;
  RUNPOD_API_KEY?: string;
  FAL_KEY?: string; // Seedance(영화) 생성용
  FAL_ADMIN_KEY?: string; // Seedance 잔액 조회용(admin 권한, 선택)
  YOUTUBE_API_KEY?: string; // 유튜브 검색·메타 조회용(계정 토큰과 무관 — 토큰 만료돼도 검색이 안 죽게)
};

const KEY_NAMES = [
  'GEMINI_KEYS',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'REPLICATE_API_TOKEN',
  'RUNPOD_API_KEY',
  'FAL_KEY',
  'FAL_ADMIN_KEY',
  'YOUTUBE_API_KEY',
];

export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // 1) 로컬 .env.local 파일(개발용)
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  // 2) process.env(Railway 등 배포 환경변수) — 파일보다 우선
  for (const k of KEY_NAMES) {
    if (process.env[k]) env[k] = process.env[k] as string;
  }
  return env;
}

export function saveEnv(updates: StoredKeys): void {
  const env = loadEnv();
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== '') {
      env[k] = v;
      process.env[k] = v; // 런타임에도 즉시 반영(배포 환경에서 파일 못 써도 이번 세션은 동작)
    }
  }
  const lines = ['# OnVideo v2 키 (gitignore됨)'];
  for (const k of KEY_NAMES) if (env[k]) lines.push(`${k}=${env[k]}`);
  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  } catch {
    // 배포 환경(읽기전용 등)에서 파일 못 쓰면 process.env만으로 진행
  }
}

// 파이프라인용 키 묶음
export function pipelineKeys() {
  const env = loadEnv();
  return {
    gemini: (env.GEMINI_KEYS || '')
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    openai: env.OPENAI_API_KEY || undefined,
    elevenlabs: env.ELEVENLABS_API_KEY || '',
    replicate: env.REPLICATE_API_TOKEN || '',
    runpod: env.RUNPOD_API_KEY || '',
    fal: env.FAL_KEY || '',
    falAdmin: env.FAL_ADMIN_KEY || '',
  };
}

// 마스킹(있는지만 표시)
export function maskKey(v?: string): string {
  if (!v) return '';
  return v.length > 12 ? v.slice(0, 6) + '••••' + v.slice(-4) : '••••';
}
