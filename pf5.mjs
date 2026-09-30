import puppeteer from 'puppeteer-core';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox'],defaultViewport:{width:1200,height:1000}});
const p=await b.newPage();
await p.goto('http://localhost:4000/voices',{waitUntil:'networkidle2',timeout:20000});
await new Promise(r=>setTimeout(r,2500));
const info=await p.evaluate(()=>({cards:document.querySelectorAll('.pf-card').length, vids:[...document.querySelectorAll('.pf-video')].filter(v=>v.videoWidth>0).length}));
console.log('포트폴리오 카드:',info.cards,'| 재생가능 영상:',info.vids);
await b.close();
