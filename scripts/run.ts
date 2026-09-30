// 실행: npx tsx scripts/run.ts "<뉴스 URL>" [초] [voice]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeVideo} from '../lib/pipeline';
import {PRESETS} from '../lib/presets';

// 카테고리 목록 보기: npx tsx scripts/run.ts --list
if (process.argv[2] === '--list') {
  console.log('사용 가능한 카테고리(id):');
  for (const p of PRESETS)
    console.log(`  ${p.emoji} ${p.id.padEnd(10)} ${p.label} [${p.group}]`);
  process.exit(0);
}

// .env.local 로드(의존성 없이)
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// 사용: npx tsx scripts/run.ts "<URL>" [초] [카테고리id] [voice]
const url = process.argv[2];
const duration = Number(process.argv[3]) || 30;
const presetId = process.argv[4] || undefined; // 카테고리 id (예: health, food, money)
const voice = process.argv[5] || undefined; // 지정 안 하면 프리셋 추천 목소리
if (!url) {
  console.error('사용: npx tsx scripts/run.ts "<URL>" [초] [voice]');
  process.exit(1);
}

const keys = {
  gemini: (process.env.GEMINI_KEYS || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean),
  openai: process.env.OPENAI_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  replicate: process.env.REPLICATE_API_TOKEN || '',
};

console.log(
  `키 상태 — gemini:${keys.gemini.length}개, openai:${keys.openai ? 'O' : 'X'}, elevenlabs:${keys.elevenlabs ? 'O' : 'X'}, replicate:${keys.replicate ? 'O' : 'X'}`,
);

makeVideo([url], keys, {duration, voice, presetId, log: (m) => console.log(m)})
  .then((r) => {
    // ★바탕화면/온비디오 <오늘날짜>/<제목>/ 폴더에 영상 + 생성한 이미지 전부 내보내기
    const safe = r.title.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD(로컬)
    const dayFolder = path.join(os.homedir(), 'Desktop', `온비디오 ${today}`);
    const workFolder = path.join(dayFolder, safe);
    fs.mkdirSync(workFolder, {recursive: true});
    // 영상
    fs.copyFileSync(r.out, path.join(workFolder, `${safe}.mp4`));
    // 생성한 이미지들(버리기 아까우니 함께 보관)
    let imgN = 0;
    for (const f of fs.readdirSync(r.imageDir)) {
      if (/img-\d+\.(jpg|png)$/.test(f)) {
        fs.copyFileSync(path.join(r.imageDir, f), path.join(workFolder, f));
        imgN++;
      }
    }
    console.log('\n✅ 완료:', r.title, `\n→ ${workFolder}\n   (영상 1 + 이미지 ${imgN}장)`);
  })
  .catch((e) => {
    console.error('\n❌ 실패:', e);
    process.exit(1);
  });
