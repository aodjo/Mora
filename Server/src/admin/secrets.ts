import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../env.js";

function secretBytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const raw = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch {
    throw new ServiceError(503, "MISCONFIGURED");
  }
}

async function secretKey(env: WorkerEnv): Promise<CryptoKey> {
  if (env.SECRET_ENCRYPTION_KEY === undefined) throw new ServiceError(503, "MISCONFIGURED");
  const raw = secretBytes(env.SECRET_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new ServiceError(503, "MISCONFIGURED");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output);
}

export async function sealSecret(env: WorkerEnv, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await secretKey(env), new TextEncoder().encode(value));
  return `v1:${toBase64(nonce)}:${toBase64(encrypted)}`;
}

export async function openSecret(env: WorkerEnv, value: string): Promise<string> {
  if (!value.startsWith("v1:")) return value;
  const [, nonce, cipher] = value.split(":");
  if (nonce === undefined || cipher === undefined) throw new ServiceError(500, "INTERNAL");
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: secretBytes(nonce) }, await secretKey(env), secretBytes(cipher));
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(500, "SECRET_DECRYPT_FAILED");
  }
}
