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
