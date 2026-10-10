// 로컬 페이지 실제 렌더 스크린샷 — 내 눈으로 디자인 확인용.
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const url = process.argv[2] || 'http://localhost:4000/create';
  const outName = process.argv[3] || 'create';
  const clickGen = process.argv[4] === 'gen';
  const b = await puppeteer.launch({executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1280,2200']});
  const errs = [];
  const p = await b.newPage();
  await p.setViewport({width: 1280, height: 1600, deviceScaleFactor: 1});
  p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto(url, {waitUntil: 'networkidle2', timeout: 30000});
  await new Promise((r) => setTimeout(r, 1500));
  if (clickGen) {
    // 시나리오 만들기 눌러서 표까지 렌더
    await p.evaluate(() => document.getElementById('cr-gen')?.click());
    await new Promise((r) => setTimeout(r, 25000)); // LLM 대기
  }
  const path1 = `/tmp/shot-${outName}.png`;
  await p.screenshot({path: path1, fullPage: true});
  console.log('SHOT:', path1);
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none');
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
