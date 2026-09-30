import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Studio, StudioError, type StudioDependencies} from '../lib/studio';
import {estimate, resolveProduct, signatures} from '../lib/studio-model';

function setup(t: any, overrides: Partial<StudioDependencies> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onvideo-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const calls = {plan:0, image:0, voice:0, music:0, render:0};
  const deps: StudioDependencies = {
    async plan() { calls.plan++; return {title:'테스트', subject:'rice', musicPrompt:'calm', scenes:[0,1].map(i => ({narration:`장면 ${i}입니다.`, hookTop:'제목', hookAccent:'강조', accentColor:'#FFE24B', visualPrompt:`rice ${i}`, imageIndex:i}))}; },
    async image(_, __, file) { calls.image++; fs.writeFileSync(file, 'image'); },
    async voice(_, __, file) { calls.voice++; fs.writeFileSync(file, 'voice'); return {frames:60, words:[{t:'장면',s:0,e:50}]}; },
    async music(_, file) { calls.music++; fs.writeFileSync(file, 'music'); },
    async render(_, __, file) { calls.render++; fs.writeFileSync(file, 'video'); },
    ...overrides,
  };
  return {studio:new Studio(root, deps), root, calls, deps};
}
const input = {mode:'auto', url:'https://example.com/article', duration:30, rates:{draft:10, image:5, voice:100, music:20}};
async function draft(s: Studio, body: any = input) { const p = s.create(body); return s.settled(p.id); }
function editBody(p: any) { return {revision:p.revision,title:p.title,musicPrompt:p.musicPrompt,scenes:structuredClone(p.scenes)}; }

test('draft review does not trigger image, voice or rendering', async t => {
  const {studio, calls} = setup(t); const p = await draft(studio);
  assert.equal(p.status, 'draft'); assert.deepEqual(calls, {plan:1,image:0,voice:0,music:0,render:0});
  assert.equal(p.scenes.length, 2); assert.equal(estimate(p).images, 2);
});
test('render caches assets; caption-only edit does not regenerate paid media', async t => {
  const {studio, calls} = setup(t); let p = await draft(studio);
  studio.render(p.id,p.revision); p = await studio.settled(p.id);
  const e = editBody(p); e.scenes[0].hookTop = '수정 자막'; studio.edit(p.id,e);
  studio.render(p.id,p.revision + 1); p = await studio.settled(p.id);
  assert.equal(p.status,'completed'); assert.equal(calls.image,2); assert.equal(calls.voice,2); assert.equal(calls.render,2);
  assert.equal(estimate(p).subtotal,0);
});
test('changing one narration regenerates only that voice', async t => {
  const {studio,calls} = setup(t); let p = await draft(studio);
  studio.render(p.id,p.revision); p = await studio.settled(p.id);
  const e = editBody(p); e.scenes[1].narration = '이 문장만 수정합니다.'; studio.edit(p.id,e);
  studio.render(p.id,p.revision + 1); await studio.settled(p.id);
  assert.equal(calls.voice,3); assert.equal(calls.image,2); assert.equal(calls.plan,1);
});
test('explicit image retry invalidates one image and keeps old completed video', async t => {
  const {studio,calls} = setup(t); let p = await draft(studio);
  studio.render(p.id,p.revision); p = await studio.settled(p.id); const oldOutput=p.output;
  studio.regenerate(p.id,0,'image',p.revision); p = await studio.settled(p.id);
  assert.equal(calls.image,3); assert.equal(calls.voice,2); assert.equal(p.output,oldOutput); assert.notEqual(p.revision,p.outputRevision);
  studio.render(p.id,p.revision); await studio.settled(p.id); assert.equal(calls.image,3);
});
test('failure checkpoint survives restart and skips completed steps', async t => {
  let attempt=0;
  const {studio,root,deps,calls} = setup(t, {async voice(_,__,file) {
    attempt++; if (attempt===2) throw new Error('provider unavailable');
    fs.writeFileSync(file,'voice'); return {frames:60,words:[]};
  }});
  let p=await draft(studio); studio.render(p.id,p.revision); p=await studio.settled(p.id);
  assert.equal(p.status,'failed'); assert.ok(p.scenes[0].voice); assert.equal(p.scenes[1].voice,undefined);
  const restarted=new Studio(root,deps); restarted.render(p.id,p.revision); p=await restarted.settled(p.id);
  assert.equal(p.status,'completed'); assert.equal(attempt,3); assert.equal(calls.image,2);
});
test('running job recovered as resumable failure on startup', async t => {
  const {studio,root,deps}=setup(t); const p=await draft(studio);
  p.status='running'; fs.writeFileSync(path.join(root,p.id,'project.json'),JSON.stringify(p));
  const recovered=new Studio(root,deps).get(p.id); assert.equal(recovered.status,'failed'); assert.match(recovered.error!,/재시작/);
});
test('concurrent submissions and stale writes are rejected', async t => {
  let finish!: () => void; const gate=new Promise<void>(r => {finish=r;});
  const {studio}=setup(t,{async image(_,__,file) {await gate;fs.writeFileSync(file,'image');}});
  let p=await draft(studio); studio.render(p.id,p.revision);
  assert.throws(()=>studio.render(p.id,p.revision), /진행 중/);
  assert.throws(()=>studio.edit(p.id,editBody(p)), /진행 중/);
  finish(); p=await studio.settled(p.id); const e=editBody(p); studio.edit(p.id,e);
  assert.throws(()=>studio.edit(p.id,e), /다른 창/);
});
test('locked product facts use exact values and original photo; cannot be patched', async t => {
  const {studio,calls}=setup(t);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  let p=await draft(studio,{...input,mode:'manual',images:[png],product:{name:'우리 상품',price:'29,900원',benefit:'무료 배송',url:'https://example.com/buy'}});
  assert.match(resolveProduct(p.scenes[1].narration,p.input.product),/29,900원/);
  const e={...editBody(p),product:{price:'1원'}}; studio.edit(p.id,e);
  p=studio.get(p.id); assert.equal(p.input.product!.price,'29,900원');
  studio.render(p.id,p.revision); p=await studio.settled(p.id);
  assert.equal(calls.image,0); assert.equal(p.scenes[0].image!.file,p.sources[0]);
  assert.throws(()=>studio.regenerate(p.id,0,'image',p.revision),/원본 사진/);
});
test('unknown tokens and invalid image references are rejected', async t => {
  const {studio}=setup(t); const p=await draft(studio); const e=editBody(p);
  e.scenes[0].narration='{{product.unexpected}}'; assert.throws(()=>studio.edit(p.id,e),/상품 변수/);
  e.scenes[0].narration='{{product.name}}'; assert.throws(()=>studio.edit(p.id,e),/상품 정보|나레이션/);
});
test('history and files persist without API keys; traversal and project metadata unavailable', async t => {
  const {studio,root,deps}=setup(t); const p=await draft(studio);
  const restarted=new Studio(root,deps); assert.equal(restarted.list()[0].id,p.id);
  assert.throws(()=>studio.asset(p.id,'project.json'),/파일이 없습니다/);
  assert.throws(()=>studio.asset(p.id,'../../.env.local'),/파일이 없습니다/);
  assert.throws(()=>studio.get('../secret'),/작업을 찾을 수 없습니다/);
  assert.ok(!fs.readFileSync(path.join(root,p.id,'project.json'),'utf8').includes('API_KEY'));
});
test('unknown rates produce partial estimate, never a fake zero total', async t => {
  const {studio}=setup(t); const p=await draft(studio,{...input,rates:{draft:null,image:5,voice:null,music:null}});
  const e=estimate(p); assert.equal(e.subtotal,10); assert.equal(e.complete,false); assert.deepEqual(e.missing,['voice']);
});
test('BGM prompt edits regenerate music but reuse images and voice', async t => {
  const {studio,calls}=setup(t); let p=await draft(studio,{...input,music:true});
  studio.render(p.id,p.revision);p=await studio.settled(p.id);
  const e=editBody(p); e.musicPrompt='bright';studio.edit(p.id,e);
  studio.render(p.id,p.revision+1);await studio.settled(p.id);
  assert.equal(calls.music,2);assert.equal(calls.voice,2);assert.equal(calls.image,2);
});
test('changing source prompt invalidates only image signature', async t => {
  const {studio}=setup(t);const p=await draft(studio);const s=p.scenes[0];const old=signatures(p,s);
  s.visualPrompt='a new scene';const changed=signatures(p,s);
  assert.notEqual(old.image,changed.image);assert.equal(old.voice,changed.voice);
});
test('empty and excessive inputs rejected before paid calls', async t => {
  const {studio,calls}=setup(t);
  assert.throws(()=>studio.create({...input,duration:9999}));
  assert.throws(()=>studio.create({...input,mode:'manual',images:[]}));
  assert.throws(()=>studio.create({...input,url:'file:///etc/passwd'}));
  assert.throws(()=>studio.create({...input,mode:'manual',images:['data:image/png;base64,YQ==']}));
  assert.equal(calls.plan,0);assert.equal(studio.list().length,0);
});
test('render failure retries composition without regenerating paid assets', async t => {
  let attempts=0;
  const {studio,calls}=setup(t,{async render(_,__,file){attempts++;if(attempts===1)throw new Error('encoder unavailable');fs.writeFileSync(file,'video');}});
  let p=await draft(studio);studio.render(p.id,p.revision);p=await studio.settled(p.id);
  assert.equal(p.status,'failed');studio.render(p.id,p.revision);p=await studio.settled(p.id);
  assert.equal(p.status,'completed');assert.equal(calls.image,2);assert.equal(calls.voice,2);assert.equal(attempts,2);
});
test('missing cached asset is included in estimate and regenerated on retry', async t => {
  const {studio,calls}=setup(t);let p=await draft(studio);studio.render(p.id,p.revision);p=await studio.settled(p.id);
  fs.unlinkSync(path.join(studio.directory(p.id),p.scenes[0].image!.file));
  assert.equal(studio.view(p.id).estimate.images,1);
  studio.render(p.id,p.revision);await studio.settled(p.id);
  assert.equal(calls.image,3);assert.equal(calls.voice,2);
});
