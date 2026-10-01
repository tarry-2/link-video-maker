// 캐릭터 풀 — 애니 영상에 쓸 주인공 캐릭터 저장소.
// 기본 캐릭터는 레포(public/characters)에 포함, 사용자가 만든 캐릭터는 볼륨(data/characters)에 저장.
// 영상 만들 때 캐릭터를 고르면 그 기준 이미지를 작업에 참조로 넣어(nano-banana) 같은 주인공을 유지한다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {generateImageNano} from './image';

const ROOT = process.cwd();
const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(ROOT, 'data');
const USER_DIR = path.join(DATA_DIR, 'characters'); // 사용자 캐릭터 이미지
const META_FILE = path.join(DATA_DIR, 'characters.json'); // 사용자 캐릭터 메타

export type Character = {id: string; name: string; emoji: string; builtin: boolean; file?: string; createdAt?: string};

// 기본 캐릭터(레포 public/characters/{id}.jpg). 남녀·동물 균형.
export const BASE_CHARACTERS: Character[] = [
  {id: 'lumi', name: '루미 · 빨간모자 여아', emoji: '🙋‍♀️', builtin: true},
  {id: 'byeoli', name: '별이 · 단정한 여아', emoji: '🌟', builtin: true},
  {id: 'tori', name: '토리 · 멜빵 남아', emoji: '🙋‍♂️', builtin: true},
  {id: 'haru', name: '하루 · 활발한 남아', emoji: '⚡', builtin: true},
  {id: 'mongi', name: '몽이 · 분홍 토끼', emoji: '🐰', builtin: true},
  {id: 'kkomi', name: '꼬미 · 아기 여우', emoji: '🦊', builtin: true},
];

function loadUser(): Character[] {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return []; }
}
function saveUser(list: Character[]) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(META_FILE + '.tmp', JSON.stringify(list));
  fs.renameSync(META_FILE + '.tmp', META_FILE);
}

// 전체 목록(기본 + 사용자). 사용자 캐릭터 이미지가 실제 있는 것만.
export function listCharacters(): Character[] {
  const users = loadUser().filter(c => c.file && fs.existsSync(path.join(USER_DIR, c.file)));
  return [...BASE_CHARACTERS, ...users];
}

export function getCharacter(id: string): Character | undefined {
  return listCharacters().find(c => c.id === id);
}

// 캐릭터 기준 이미지의 실제 경로(기본=public, 사용자=볼륨). 없으면 null.
export function characterImagePath(id: string): string | null {
  const c = getCharacter(id);
  if (!c) return null;
  const p = c.builtin ? path.join(ROOT, 'public', 'characters', `${id}.jpg`) : path.join(USER_DIR, c.file!);
  return fs.existsSync(p) ? p : null;
}

// 새 캐릭터 생성: 묘사 → nano-banana로 기준 이미지 생성 → 저장.
export async function createCharacter(replicateKey: string, name: string, description: string): Promise<Character> {
  fs.mkdirSync(USER_DIR, {recursive: true});
  const id = 'u_' + randomUUID().slice(0, 8);
  const file = `${id}.jpg`;
  const prompt = `A single character for a kids story: ${description}. Full body, centered, simple soft background, friendly and cute.`;
  await generateImageNano(replicateKey, prompt, path.join(USER_DIR, file), undefined, [], false);
  const list = loadUser();
  const c: Character = {id, name: name.slice(0, 40) || '내 캐릭터', emoji: '🎨', builtin: false, file, createdAt: new Date().toISOString()};
  list.push(c); saveUser(list);
  return c;
}

export function deleteCharacter(id: string): boolean {
  const list = loadUser();
  const c = list.find(x => x.id === id);
  if (!c) return false; // 기본 캐릭터는 삭제 불가(목록에 없음)
  try { if (c.file) fs.rmSync(path.join(USER_DIR, c.file), {force: true}); } catch {}
  saveUser(list.filter(x => x.id !== id));
  return true;
}
