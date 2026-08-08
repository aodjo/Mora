import type { WorkerEnv } from "../env.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";

interface ArtifactRow {
  r2_key: string;
  content_type: string;
  byte_size: number;
  wrapped_key: string;
  chunk_size: number;
  encryption: string;
}
interface Header {
  v: number;
  chunk_size: number;
  plain_size: number;
}

function base64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}
function pem(value: string): ArrayBuffer {
  const data = value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, "");
  return base64(data).buffer;
}
async function privateKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pem(value), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
}
async function range(bucket: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (object === null) throw new ServiceError(404, "NOT_FOUND");
  return new Uint8Array(await object.arrayBuffer());
}

async function metadata(env: WorkerEnv, row: ArtifactRow): Promise<{ header: Header; headerEnd: number; key: CryptoKey }> {
  if (env.ARTIFACT_PRIVATE_KEY === undefined) throw new ServiceError(503, "MISCONFIGURED");
  const prefix = await range(env.ADMIN_ARTIFACTS, row.r2_key, 0, 12);
  if (new TextDecoder().decode(prefix.slice(0, 8)) !== "MORAENC1") throw new ServiceError(500, "BAD_ARTIFACT");
  const headerLength = new DataView(prefix.buffer, prefix.byteOffset + 8, 4).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(await range(env.ADMIN_ARTIFACTS, row.r2_key, 12, headerLength))) as Header;
  const wrappingKey = await privateKey(env.ARTIFACT_PRIVATE_KEY);
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, wrappingKey, base64(row.wrapped_key));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  return { header, headerEnd: 12 + headerLength, key };
}

async function chunk(
  env: WorkerEnv,
  row: ArtifactRow,
  meta: { header: Header; headerEnd: number; key: CryptoKey },
  index: number,
): Promise<Uint8Array> {
  const plainLength = Math.min(meta.header.chunk_size, meta.header.plain_size - index * meta.header.chunk_size);
  const recordLength = 12 + 4 + plainLength + 16;
  const offset = meta.headerEnd + index * (meta.header.chunk_size + 32);
  const record = await range(env.ADMIN_ARTIFACTS, row.r2_key, offset, recordLength);
  const nonce = record.slice(0, 12);
  const cipherLength = new DataView(record.buffer, record.byteOffset + 12, 4).getUint32(0);
  const encrypted = record.slice(16, 16 + cipherLength + 16);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, meta.key, encrypted));
  } catch {
    throw new ServiceError(500, "ARTIFACT_AUTH_FAILED");
  }
}

function requestedRange(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (match === null) throw new ServiceError(416, "INVALID_RANGE");
  if (match[1] === "" && match[2] !== "") {
    const suffix = Math.min(size, Number(match[2]));
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size)
    throw new ServiceError(416, "INVALID_RANGE");
  return { start, end };
}

export async function serveArtifact(request: Request, env: WorkerEnv, row: ArtifactRow): Promise<Response> {
  if (row.encryption !== "mora-aes-256-gcm-chunked-v1") throw new ServiceError(500, "UNSUPPORTED_ARTIFACT");
  const meta = await metadata(env, row);
  const requested = requestedRange(request.headers.get("range"), meta.header.plain_size);
  const start = requested?.start ?? 0;
  const end = requested?.end ?? meta.header.plain_size - 1;
  let current = Math.floor(start / meta.header.chunk_size);
  const final = Math.floor(end / meta.header.chunk_size);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (current > final) {
        controller.close();
        return;
      }
      const index = current++;
      const plain = await chunk(env, row, meta, index);
      const chunkStart = index * meta.header.chunk_size;
      const left = Math.max(0, start - chunkStart);
      const right = Math.min(plain.length, end - chunkStart + 1);
      controller.enqueue(plain.slice(left, right));
    },
  });
  const headers = new Headers({
    "Content-Type": row.content_type,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  });
  if (requested !== null) headers.set("Content-Range", `bytes ${start}-${end}/${meta.header.plain_size}`);
  return new Response(stream, { status: requested === null ? 200 : 206, headers });
}
