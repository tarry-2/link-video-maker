// 암호화 세션 저장소 — control-tower-bot/src/session-store.ts 검증본을 온비디오 봇용으로 복제.
//   스레드/인스타 로그인 쿠키(JSON)를 AES-256-GCM으로 맥 로컬에만 저장(클라우드 안 올림, 테리 지시).
//   ★영구 브라우저 프로필(userDataDir)과 별개의 2중 저장 — 프로필이 비어도 이 쿠키로 되살릴 수 있다.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const MAGIC = "OVBOT_SESSION_V1";
export const SESSION_DIR = process.env.OVBOT_SESSION_DIR || path.join(os.homedir(), ".onvideo-bot", "sessions");
const KEY_PATH = path.join(path.dirname(SESSION_DIR), "session.key");

function keyPathFor(dir: string) { return path.join(path.dirname(dir), "session.key"); }

function secureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function keyForDir(dir: string): Buffer {
  const kp = keyPathFor(dir);
  if (fs.existsSync(kp)) return fs.readFileSync(kp);
  return key();
}

function key(): Buffer {
  secureDir(path.dirname(KEY_PATH));
  if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH);
  const value = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_PATH, value, { mode: 0o600, flag: "wx" }); return value; }
  catch { return fs.readFileSync(KEY_PATH); }
}

export function sessionFile(name: string) {
  secureDir(SESSION_DIR);
  return path.join(SESSION_DIR, `${name}.session`);
}

export function writeSession(name: string, value: unknown): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
  const target = sessionFile(name);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${MAGIC}\n${envelope}`, { mode: 0o600 });
  fs.renameSync(temp, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

export function readSession<T>(name: string): T {
  const file = sessionFile(name);
  if (!fs.existsSync(file)) throw new Error("세션 없음");
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.startsWith(`${MAGIC}\n`)) throw new Error("지원하지 않는 세션 파일 형식");
  const env = JSON.parse(raw.slice(MAGIC.length + 1));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyForDir(SESSION_DIR), Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]).toString("utf8"));
}

export function hasSession(name: string): boolean {
  return fs.existsSync(sessionFile(name));
}

export function deleteSession(name: string): void {
  try { const f = sessionFile(name); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}
