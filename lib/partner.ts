// 온파트너(온종일팜 제휴) 상품 연동 — 파트너가 만든 추천 링크(/r/{code})로 상품 정보를 가져온다.
// 온파트너 공개 API(partner.yuanfnb.com/api/product-card, CORS *)를 서버에서 호출(프록시).
//   → OnVideo는 온종일팜 Supabase를 직접 안 씀(별개 시스템). 연결점은 이 공개 API 하나.
// 반환 상품으로 '쇼핑 쇼츠' 영상을 만들고, 발송 캡션에 partnerUrl(/r/{code})을 꽂아 제휴 수익으로 연결한다.
const PARTNER_HOST = 'partner.yuanfnb.com';
const PRODUCT_API = `https://${PARTNER_HOST}/api/product-card`;

export type PartnerProduct = {
  id: string | null;
  name: string;
  image: string; // 상품 대표 이미지(https)
  price: number | null; // 소매가(원). 없으면 null.
  available: boolean;
  partnerUrl: string; // https://partner.yuanfnb.com/r/{code} — 발송 캡션에 꽂을 제휴 링크(전환 추적됨)
  shopUrl: string; // 온종일팜 상품 페이지(참고용)
  code: string; // 파트너 링크 코드
};

const FARM_HOST = 'app.yuanfnb.com';

// 입력에서 파트너 코드만 뽑는다 — raw code(abcd1234) 또는 /r/{code} 전체 URL 모두 허용.
export function extractPartnerCode(value: string): string {
  const raw = String(value || '').trim();
  if (/^[a-z0-9-]{4,64}$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const m = url.pathname.match(/\/r\/([a-z0-9-]{4,64})\/?$/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

// 온종일팜 다이렉트 상품페이지 URL(app.yuanfnb.com/shop/product/{uuid})에서 상품 UUID 추출.
export function extractFarmProductId(value: string): string {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    if (url.hostname !== FARM_HOST) return '';
    const m = url.pathname.match(/\/shop\/product\/([0-9a-f-]{36})\/?$/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

function normFarmImage(v: string): string {
  const s = String(v || '').trim();
  if (/^https:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return 'https://' + FARM_HOST + s;
  return '';
}

// 다이렉트 상품페이지(SSR HTML)에서 상품 정보를 파싱한다 — 온종일팜 Supabase가 anon 막혀있어 공개 API가 없으므로
//   페이지에 서버 렌더된 상품 JSON(name·retail_price·image_url·is_active)을 긁는다. 발송 링크=상품페이지 그대로.
export async function fetchFarmProductDirect(pageUrl: string): Promise<PartnerProduct> {
  const id = extractFarmProductId(pageUrl);
  if (!id) throw new Error('온종일팜 상품페이지 주소(.../shop/product/...)를 입력하세요.');
  let html = '';
  try {
    const r = await fetch(`https://${FARM_HOST}/shop/product/${id}`, {cache: 'no-store', headers: {'User-Agent': 'Mozilla/5.0'}});
    if (!r.ok) throw new Error(`상품페이지 응답 오류(HTTP ${r.status})`);
    html = await r.text();
  } catch (e: any) { throw new Error('상품페이지 연결 실패: ' + (e?.message || e)); }
  const unesc = (s: string) => s.replace(/\\\\(.)/g, '$1').replace(/\\u([0-9a-f]{4})/gi, (_s, h) => String.fromCharCode(parseInt(h, 16)));
  const pickNum = (key: string): number | null => {
    const m = html.match(new RegExp('\\\\"' + key + '\\\\":([0-9]+)'));
    return m ? Number(m[1]) : null;
  };
  // ★상품명은 'retail_price 바로 앞의 name'이 진짜 상품명(그냥 첫 name은 메타태그 viewport가 먼저 걸림).
  //   상품 객체 JSON은 \"name\":\"영광굴비…\",...,\"retail_price\":35000 순서 → name~retail_price 사이를 통째로 잡아 그 안 name을 쓴다.
  let name = '온종일팜 상품';
  const blockM = html.match(/\\"name\\":\\"((?:[^\\"]|\\.)*?)\\"[\s\S]{0,400}?\\"retail_price\\":[0-9]+/);
  if (blockM) name = unesc(blockM[1]);
  const price = pickNum('retail_price');
  const imgM = html.match(new RegExp('products/[0-9]+\\.(?:jpg|jpeg|png|webp)', 'i'));
  const image = imgM ? normFarmImage('https://vkdczkxeiidffdgnebjs.supabase.co/storage/v1/object/public/' + imgM[0]) : '';
  const active = !/\\"is_active\\":false/.test(html);
  return {
    id, name, image, price: typeof price === 'number' && price > 0 ? price : null,
    available: active,
    partnerUrl: '', // 다이렉트는 제휴링크 없음
    shopUrl: `https://${FARM_HOST}/shop/product/${id}`,
    code: '',
  };
}

// 파트너 링크(/r/{code} 또는 code)로 상품 정보 조회. 실패 시 throw(사유 포함).
export async function fetchPartnerProduct(codeOrUrl: string): Promise<PartnerProduct> {
  const code = extractPartnerCode(codeOrUrl);
  if (!code) throw new Error('올바른 온파트너 링크(.../r/코드)나 코드를 입력하세요.');
  let d: any;
  try {
    const r = await fetch(`${PRODUCT_API}?code=${encodeURIComponent(code)}`, {cache: 'no-store'});
    d = await r.json();
    if (!r.ok || !d || d.ok === false) {
      const err = (d && d.error) || `조회 실패(HTTP ${r.status})`;
      const msg = err === 'link_not_found' ? '그 링크의 상품을 찾을 수 없어요(삭제됐거나 잘못된 링크).'
        : err === 'invalid_partner_link' ? '온파트너 링크 형식이 아니에요.'
        : err === 'service_unavailable' ? '온파트너 서버가 일시적으로 응답하지 않아요.'
        : '상품 조회 실패: ' + err;
      throw new Error(msg);
    }
  } catch (e: any) {
    if (/상품 조회 실패|찾을 수 없|형식이 아니|응답하지/.test(e?.message || '')) throw e;
    throw new Error('온파트너 서버 연결 실패: ' + (e?.message || e));
  }
  const p = d.product || {};
  return {
    id: p.id ?? null,
    name: String(p.name || '온종일팜 상품'),
    image: String(p.image || ''),
    price: typeof p.price === 'number' ? p.price : null,
    available: p.available !== false,
    partnerUrl: String(p.partnerUrl || `https://${PARTNER_HOST}/r/${code}`),
    shopUrl: String(p.shopUrl || ''),
    code,
  };
}

// 입력 한 줄로 자동 판별 — 제휴링크(/r/{code})면 온파트너 API, 다이렉트 상품페이지면 HTML 파싱.
//   둘 다 상품 이름·이미지·가격을 돌려준다. 발송 링크는 호출부에서 partnerUrl/shopUrl 중 토글로 고른다.
export async function resolveProduct(input: string): Promise<PartnerProduct> {
  const raw = String(input || '').trim();
  if (extractFarmProductId(raw)) return fetchFarmProductDirect(raw);
  return fetchPartnerProduct(raw); // code 또는 /r/{code}
}
