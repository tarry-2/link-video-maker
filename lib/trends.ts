// 실시간 급상승 트렌드 — "지금 뭘 만들면 조회수 터지나"의 핵심(골든 윈도우).
// Google Trends 공개 RSS(키 불필요)에서 지금 뜨는 검색어 + 대략 트래픽 + 관련 뉴스 헤드라인을 가져온다.
//   공식 API는 alpha gated, 네이버 실시간 급상승 API는 폐지됨 → 공개 RSS가 가장 확실·무료.
// geo=KR(한국)/US(해외 등). 트렌드는 자주 안 바뀌므로 10분 캐시(소스 과부하·레이트 방지).

export type Trend = {keyword: string; traffic: string; trafficNum: number; news?: string; newsUrl?: string};

const cache = new Map<string, {at: number; items: Trend[]}>();
const TTL = 10 * 60 * 1000;

function decodeEntities(s: string): string {
  return (s || '')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}
function pick(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeEntities(m[1]) : '';
}
// "1000+" → 1000, "500+" → 500 (정렬·필터용)
function trafficToNum(s: string): number {
  const m = /([\d,]+)/.exec(s || '');
  return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0;
}

export async function getTrends(geo = 'KR'): Promise<Trend[]> {
  const g = /^[A-Za-z]{2}$/.test(geo) ? geo.toUpperCase() : 'KR';
  const c = cache.get(g);
  if (c && Date.now() - c.at < TTL) return c.items;
  const url = `https://trends.google.com/trending/rss?geo=${g}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let xml = '';
  try {
    const r = await fetch(url, {signal: ctrl.signal, headers: {'User-Agent': 'Mozilla/5.0 (compatible; OnVideo/1.0)'}});
    if (!r.ok) throw new Error('trends ' + r.status);
    xml = await r.text();
  } finally { clearTimeout(t); }
  const items: Trend[] = [];
  for (const block of xml.split('<item>').slice(1)) {
    const keyword = pick(block, 'title');
    if (!keyword) continue;
    const traffic = pick(block, 'ht:approx_traffic') || '';
    const news = pick(block, 'ht:news_item_title');
    const newsUrl = pick(block, 'ht:news_item_url');
    items.push({keyword, traffic, trafficNum: trafficToNum(traffic), news: news || undefined, newsUrl: newsUrl || undefined});
  }
  // 트래픽 높은 순(기본적으로 RSS가 순위대로지만 안전하게 정렬).
  items.sort((a, b) => b.trafficNum - a.trafficNum);
  if (items.length) cache.set(g, {at: Date.now(), items});
  return items;
}
