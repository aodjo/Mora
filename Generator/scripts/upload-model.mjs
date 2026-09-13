#!/usr/bin/env node
/**
 * 워커가 받아 쓸 모델 파일을 Mora 서버(R2)에 올린다 — 노래로 학습한 정렬 무게(mms_sing_b.pt, 1.26 GB) 같은 것.
 *
 * Worker 는 요청 본문을 100 MB 까지만 받으므로 서버가 알려 주는 조각 크기로 나눠 올리고, 끝에 R2 가 하나로
 * 합친다. 올리기 전에 sha256 을 재어 서버에 적어 두면, 워커는 받은 뒤 그 값으로 확인한다.
 *
 *   MORA_ADMIN_TOKEN=… node Generator/scripts/upload-model.mjs ~/mora-train/models/mms_sing_b.pt [이름] [--admin https://mora.junx.dev]
 *
 * 토큰에는 workers.manage 권한이 있어야 한다.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

const args = process.argv.slice(2);
const adminAt = args.indexOf("--admin");
const admin = (adminAt >= 0 ? args.splice(adminAt, 2)[1] : process.env.MORA_ADMIN_URL ?? "https://mora.junx.dev").replace(/\/$/u, "");
const [file, name = file === undefined ? undefined : basename(file)] = args;
const token = process.env.MORA_ADMIN_TOKEN;
if (file === undefined || name === undefined || !token) {
  process.stderr.write("쓰는 법: MORA_ADMIN_TOKEN=… node Generator/scripts/upload-model.mjs <파일> [이름] [--admin URL]\n");
  process.exit(2);
}
// Cloudflare 는 이름 없는 요청을 1010 으로 막는다.
const headers = { authorization: `Bearer ${token}`, "user-agent": "Mora-model-upload/1" };

/**
 * Call the admin API and fail loudly with the path when it refuses.
 *
 * @param {string} path - Path under /admin/api.
 * @param {RequestInit} init - Request options.
 * @returns {Promise<any>} The parsed JSON answer.
 */
async function call(path, init) {
  const response = await fetch(`${admin}/admin/api${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${response.status} ${path} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/**
 * Read a byte range of the file into memory.
 *
 * @param {number} start - First byte.
 * @param {number} end - One past the last byte.
 * @returns {Promise<Buffer>} The bytes.
 */
async function slice(start, end) {
  const pieces = [];
  for await (const piece of createReadStream(file, { start, end: end - 1 })) pieces.push(piece);
  return Buffer.concat(pieces);
}

const size = (await stat(file)).size;
const hash = createHash("sha256");
for await (const piece of createReadStream(file)) hash.update(piece);
const sha256 = hash.digest("hex");
process.stdout.write(`${name} · ${(size / 1e9).toFixed(2)} GB · sha256 ${sha256.slice(0, 16)}…\n`);

const started = await call(`/generator/models/${encodeURIComponent(name)}/uploads`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ byte_size: size, sha256 }),
});
const parts = [];
const count = Math.ceil(size / started.part_bytes);
for (let index = 0; index < count; index += 1) {
  const body = await slice(index * started.part_bytes, Math.min(size, (index + 1) * started.part_bytes));
  let answer;
  // 조각 하나가 끊겨도 처음부터 다시 올리지 않는다 — 같은 번호로 다시 보내면 R2 가 덮어쓴다.
  for (let attempt = 1; ; attempt += 1) {
    try {
      answer = await call(`/generator/models/${encodeURIComponent(name)}/uploads/${encodeURIComponent(started.upload_id)}/parts/${index + 1}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      process.stdout.write(`  조각 ${index + 1} 다시 (${String(error).slice(0, 80)})\n`);
    }
  }
  parts.push(answer);
  process.stdout.write(`  조각 ${index + 1}/${count}\n`);
}
const done = await call(`/generator/models/${encodeURIComponent(name)}/uploads/${encodeURIComponent(started.upload_id)}/complete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ parts }),
});
process.stdout.write(`올림: ${done.name} · ${done.byte_size} bytes\n`);
