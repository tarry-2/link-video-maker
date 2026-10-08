// 디자인 템플릿 미리보기 PNG 6장 생성 → web/tpl-preview/<id>.png
// 템플릿은 고정이라 개발 때 한 번만 뽑아 커밋한다(런타임 비용 0). 템플릿 디자인 바뀌면 다시 실행.
// 실행: npx tsx scripts/gen-previews.ts   (맥은 ffmpeg-full 불필요 — 렌더는 Remotion 자체)
import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {bundle} from '@remotion/bundler';
import {selectComposition, renderStill} from '@remotion/renderer';
import {HL_TEMPLATES} from '../src/highlight-templates';

// 모든 템플릿에 '같은' 샘플 문구/배경을 써서 디자인 차이만 도드라지게 한다.
const SAMPLE = {
  image: 'news2.jpg',
  hookTop: '아무도 몰랐던',
  hookAccent: '이 장면',
  subWords: ['이', '부분', '진짜', '소름', '돋아요'],
  subActiveIndex: 3,
};

async function main() {
  const outDir = path.join(process.cwd(), 'web', 'tpl-preview');
  mkdirSync(outDir, {recursive: true});

  console.log('[미리보기] 번들 중…');
  const serveUrl = await bundle({entryPoint: path.join(process.cwd(), 'src/index.ts')});

  for (const t of HL_TEMPLATES) {
    const inputProps = {template: t.id, ...SAMPLE};
    const composition = await selectComposition({serveUrl, id: 'TemplatePreview', inputProps});
    const out = path.join(outDir, `${t.id}.png`);
    await renderStill({
      composition, serveUrl, output: out, inputProps,
      frame: 0, imageFormat: 'png',
      chromiumOptions: {gl: 'swiftshader', enableMultiProcessOnLinux: true},
      scale: 0.5, // 1080×1920 → 540×960 (버튼 썸네일로 충분, 용량↓)
    });
    console.log(`[미리보기] ✓ ${t.name} → ${out}`);
  }
  console.log('[미리보기] 완료 — web/tpl-preview/ 6장');
}

main().catch((e) => { console.error(e); process.exit(1); });
