// 완성 영상 포트폴리오 — 렌더 완료 시 자동 등록되고 voices.html에 카드로 표시된다.
// data/portfolio.json에 목록을 저장(Railway 볼륨에 마운트되어 재배포해도 유지).
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'portfolio.json');

export type PortfolioItem = {
  projectId: string;
  title: string;
  output: string; // data/studio/{projectId}/{output} 파일명
  voice: string; // 목소리 라벨(예: "Luna · 다정 여성")
  category: string; // 카테고리 라벨(예: "💊 건강/의학")
  goal: 'issue' | 'info' | 'sell' | 'heal'; // 뱃지 색상 분류
  createdAt: string;
  youtubeUrl?: string; // 유튜브 업로드 완료 시 링크
};

// 특정 항목에 유튜브 링크 기록(업로드 완료 후).
export function setPortfolioYouTube(projectId: string, youtubeUrl: string) {
  const items = listPortfolio();
  const it = items.find((x) => x.projectId === projectId);
  if (it) { it.youtubeUrl = youtubeUrl; save(items); }
}

// 샘플 영상의 유튜브 링크는 별도 파일에 기록(샘플은 portfolio.json에 없으므로).
const SAMPLE_YT_FILE = path.join(DATA_DIR, 'sample-youtube.json');
export function loadSampleYouTube(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(SAMPLE_YT_FILE, 'utf8')); } catch { return {}; }
}
export function setSampleYouTube(file: string, youtubeUrl: string) {
  const m = loadSampleYouTube();
  m[file] = youtubeUrl;
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(SAMPLE_YT_FILE + '.tmp', JSON.stringify(m));
  fs.renameSync(SAMPLE_YT_FILE + '.tmp', SAMPLE_YT_FILE);
}

export function listPortfolio(): PortfolioItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(items: PortfolioItem[]) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(items));
  fs.renameSync(FILE + '.tmp', FILE);
}

// 같은 작업의 이전 등록은 교체(최종 제작을 여러 번 해도 최신 1개만). 최신이 맨 앞.
export function addPortfolio(item: PortfolioItem) {
  const items = listPortfolio().filter((x) => x.projectId !== item.projectId);
  items.unshift(item);
  save(items);
}

export function removePortfolio(projectId: string) {
  save(listPortfolio().filter((x) => x.projectId !== projectId));
}

// 기본 샘플(데모) 영상 — public/portfolio/에 고정 존재. 포트폴리오 목록에 항상 포함(삭제 불가).
export type SampleItem = {file: string; title: string; voice: string; category: string; goal: 'issue' | 'info' | 'sell' | 'heal'};
export const SAMPLES: SampleItem[] = [
  {file: 'gulbi-luna.mp4', title: '영광 법성포 굴비 (온종일팜)', voice: 'Luna · 다정 여성', category: '🛍️ 판매·음식', goal: 'sell'},
  {file: 'city-shin.mp4', title: '사라진 도시, 인구 절벽의 미래', voice: 'Shin · 깊고 묵직', category: '📰 이슈·미스터리', goal: 'issue'},
  {file: 'greentea-suzie.mp4', title: '녹차 카페인, 이렇게 마시면 꿀팁', voice: 'Suzie · 차분 30대', category: '💡 정보·건강', goal: 'info'},
  {file: 'kidney-suzie.mp4', title: '물 마실 때 신장 망가지는 습관', voice: 'Suzie · 차분 30대', category: '💡 정보·건강', goal: 'info'},
  {file: 'ocean-anime.mp4', title: '바다에서 절대 하면 안 되는 행동', voice: 'Jaewon · 자연스러운', category: '🎨 애니 스타일', goal: 'issue'},
];
