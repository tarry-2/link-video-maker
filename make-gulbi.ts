import {makeVideoManual} from './lib/manual';
import {pipelineKeys} from './lib/keys';
import fs from 'fs';
import path from 'path';

const W = path.join(process.cwd(), 'work-gulbi');

// 밥도둑 먹방 쇼츠 대본 지침 — 테리 전략(식욕자극 + 추억 한 스푼, 허위효능 금지)
const sellRule = `상품: 영광 법성포 굴비 (20미 한 두름)
가격: 35,000원

🔴 밥도둑 먹방 쇼츠 규칙(꼭 지켜라):
- 첫 3초 = 강한 후킹. "밥도둑의 끝판왕이 나타났다" "이 가격 실화?" 처럼 멈칫하게. 밍밍한 "상품을 소개합니다" 금지.
- 중간 = 보는 사람 입에 침 고이게. 노릇하게 구운 굴비, 밥에 통통한 굴비살 척 얹는 순간, 김 나는 흑미밥. 생생하게 묘사해 "지금 먹고 싶다"가 들게.
- 추억 한 스푼: "어머니가 명절에 구워주시던 그 굴비" 같은 따뜻한 정서를 한 번 녹여라(과하지 않게).
- 사실만: 영광 법성포 직송·100% 국내산·20미 35,000원. 없는 효능·수치(살 빠짐/건강/몇 %) 절대 지어내지 마라. 신선식품에 의학적 효능 단정 금지.
- 마지막 = 가격 매력 콕 + "집에서 이 밥상" 같이 가볍게 구매욕 자극. 과한 광고톤 금지.
- 한국어. 쉽고 군침 돌게. 다정한 존댓말(여성 나레이터 luna).`;

(async () => {
  const k = pipelineKeys();
  console.log('[키] gemini', k.gemini.length, '· openai', !!k.openai, '· eleven', !!k.elevenlabs);
  const r = await makeVideoManual(k, {
    imagePaths: [`${W}/f1.jpg`, `${W}/f3.jpg`, `${W}/f2.jpg`, `${W}/f4.jpg`], // 구운굴비→밥에얹기→조림→한상
    videoPaths: [],
    keywords: '영광 법성포 굴비',
    facts: sellRule,
    duration: 30,
    voice: 'luna',
    log: (m) => console.log(m),
  });
  console.log('\n[완성] out =', r.out, '| title =', r.title);
  const dest = '/Users/apple/Desktop/굴비_밥도둑_쇼츠.mp4';
  fs.copyFileSync(r.out, dest);
  console.log('[바탕화면] →', dest);
})().catch((e) => {
  console.error('[실패]', e?.stack || e?.message || e);
  process.exit(1);
});
