// Explicit local smoke test. Uses fixtures only, no paid provider calls.
import fs from 'node:fs';
import path from 'node:path';
import {Studio} from '../lib/studio';
import {studioProviders} from '../lib/studio-providers';

async function main() {
  const root = process.env.STUDIO_SMOKE_DIR;
  if (!root) throw new Error('Set STUDIO_SMOKE_DIR to an isolated test directory.');
  fs.mkdirSync(root, {recursive: true});
  const audio = path.join(root, 'fixture.mp3');
  fs.copyFileSync('public/sfx/whoosh.mp3', audio);
  const studio = new Studio(path.join(root, 'studio'), {
    ...studioProviders,
    async plan() { return {title:'검증용 샘플 — 원본 사진과 고정 상품 정보',subject:'',musicPrompt:'',scenes:[0,1].map(i => ({narration:`샘플 장면 ${i+1}입니다.`,hookTop:'검증용 영상',hookAccent:'장면별 수정',accentColor:'#FFE24B',visualPrompt:'',imageIndex:0}))}; },
    async voice(_,__,file) { fs.copyFileSync(audio,file);return {frames:30,words:[{t:'검증용 샘플',s:0,e:28}]}; },
  });
  let p = studio.create({mode:'manual',duration:15,images:['data:image/jpeg;base64,'+fs.readFileSync('public/bg1.jpg').toString('base64')],
    product:{name:'샘플 상품',price:'29,900원',benefit:'무료 배송',url:'https://example.com/product'},rates:{draft:10,image:0,voice:100,music:0}});
  await studio.settled(p.id);
  studio.render(p.id,p.revision);
  const result=await studio.settled(p.id);
  console.log(JSON.stringify({id:result.id,status:result.status,error:result.error,output:result.output,logs:result.logs.slice(-8)},null,2));
  if (result.status!=='completed') process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
