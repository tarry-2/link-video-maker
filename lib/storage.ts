// R2(S3 호환) 저장소 — 완성 영상을 Railway 볼륨 대신 Cloudflare R2에 보관한다.
// 볼륨은 작지만(500MB) R2는 사실상 무제한+다운로드 전송료 0 → 영상이 아무리 쌓여도 디스크 안 참.
// env(R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET)가 없으면 비활성 → 기존 로컬 방식 폴백.
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

const {R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET} = process.env;
const enabled = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY!},
  });
  return client;
}

export function r2Enabled(): boolean { return enabled; }

// 완성 영상의 R2 키. 작업ID로 네임스페이싱해 충돌 방지.
export function videoKey(projectId: string, name: string): string {
  return `studio/${projectId}/${name}`;
}

// 로컬 파일을 R2로 업로드. 성공하면 true.
export async function uploadFile(key: string, localPath: string, contentType = 'video/mp4'): Promise<boolean> {
  if (!enabled) return false;
  const body = fs.readFileSync(localPath);
  await s3().send(new PutObjectCommand({Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType}));
  return true;
}

// 임시 공개 다운로드 URL(기본 1시간). 인스타 등 외부 서비스가 R2 영상을 가져갈 때 사용.
export async function presignGet(key: string, expiresIn = 3600): Promise<string | null> {
  if (!enabled) return null;
  try { return await getSignedUrl(s3(), new GetObjectCommand({Bucket: R2_BUCKET, Key: key}), {expiresIn}); }
  catch { return null; }
}

export async function deleteKey(key: string): Promise<void> {
  if (!enabled) return;
  try { await s3().send(new DeleteObjectCommand({Bucket: R2_BUCKET, Key: key})); } catch {}
}

// R2에 객체 존재 여부 + 크기. 없으면 null.
export async function head(key: string): Promise<{size: number} | null> {
  if (!enabled) return null;
  try {
    const r = await s3().send(new HeadObjectCommand({Bucket: R2_BUCKET, Key: key}));
    return {size: r.ContentLength ?? 0};
  } catch { return null; }
}

// R2에서 스트림으로 가져온다(Range 지원). 영상 재생/다운로드 서빙용.
export async function getStream(key: string, range?: {start: number; end: number}): Promise<{stream: Readable; size: number; contentRange?: string} | null> {
  if (!enabled) return null;
  try {
    const r = await s3().send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined,
    }));
    return {
      stream: r.Body as Readable,
      size: r.ContentLength ?? 0,
      contentRange: r.ContentRange,
    };
  } catch { return null; }
}
