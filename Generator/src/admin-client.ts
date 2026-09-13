import { createHash, publicEncrypt, randomBytes, constants } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type {
  GeneratorCandidateSubmission,
  GeneratorJobInput,
  StageEvent,
  WorkerCapabilities,
} from "../../packages/contracts/src/index.js";
import type { LeasedMessage } from "./queue.js";

export class AdminClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/u, "")}/admin/api${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    // The path is in the message because a failure that names no endpoint cannot be chased.
    if (!response.ok) throw new Error(`ADMIN_${response.status}_${path}_${(await response.text()).slice(0, 100)}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  job(id: string): Promise<GeneratorJobInput> {
    return this.request(`/generator/jobs/${encodeURIComponent(id)}`);
  }
  event(value: StageEvent): Promise<{ accepted: boolean }> {
    return this.request("/generator/events", { method: "POST", body: JSON.stringify(value) });
  }
  candidates(value: GeneratorCandidateSubmission): Promise<{ candidate_ids: string[] }> {
    return this.request("/generator/candidates", { method: "POST", body: JSON.stringify(value) });
  }
  heartbeat(value: { worker_id: string; version: string }): Promise<{ desired_state: string }> {
    return this.request("/generator/heartbeat", { method: "POST", body: JSON.stringify(value) });
  }
  async pullJob(): Promise<LeasedMessage | null> {
    return (await this.request<LeasedMessage | undefined>("/generator/queue/pull", { method: "POST", body: "{}" })) ?? null;
  }
  ackJob(leaseId: string): Promise<void> {
    return this.request("/generator/queue/ack", { method: "POST", body: JSON.stringify({ lease_id: leaseId }) });
  }
  retryJob(leaseId: string, delaySeconds: number): Promise<void> {
    return this.request("/generator/queue/retry", {
      method: "POST",
      body: JSON.stringify({ lease_id: leaseId, delay_seconds: delaySeconds }),
    });
  }
  /**
   * Fetch a model file the pipeline needs from the server, once, into `destination`.
   *
   * The server states the file's size and SHA-256. A copy already on disk whose size matches and
   * whose recorded hash is the server's is used as is; a partial download resumes from where it
   * stopped; the finished file is hashed before it takes the final name, so a truncated or wrong
   * file never reaches the aligner.
   *
   * @param {string} name - The model's name on the server, e.g. `mms_sing_b.pt`.
   * @param {string} destination - Where the file should end up.
   * @returns {Promise<string>} `destination`, once it holds the checked file.
   * @throws {Error} `MODEL_<status>_<name>` when the server will not hand it over, `MODEL_SHA_MISMATCH` when the bytes are wrong.
   */
  async fetchModel(name: string, destination: string): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/u, "")}/admin/api/generator/models/${encodeURIComponent(name)}`;
    const authorization = `Bearer ${this.token}`;
    const head = await this.fetcher(url, { method: "HEAD", headers: { authorization } });
    if (!head.ok) throw new Error(`MODEL_${head.status}_${name}`);
    const size = Number(head.headers.get("content-length") ?? "0");
    const digest = head.headers.get("x-mora-sha256") ?? "";
    const marker = `${destination}.sha256`;
    const known = await fs.readFile(marker, "utf8").catch(() => "");
    const kept = await fs.stat(destination).catch(() => null);
    if (kept !== null && kept.size === size && known.trim() === digest) return destination;

    const partial = `${destination}.part`;
    let have = (await fs.stat(partial).catch(() => null))?.size ?? 0;
    if (have > size) {
      await fs.rm(partial, { force: true });
      have = 0;
    }
    if (have < size) {
      const response = await this.fetcher(url, { headers: { authorization, ...(have > 0 ? { range: `bytes=${have}-` } : {}) } });
      if (response.status !== 200 && response.status !== 206) throw new Error(`MODEL_${response.status}_${name}`);
      if (response.body === null) throw new Error(`MODEL_EMPTY_${name}`);
      // 200 이면 서버가 이어받기를 무시하고 처음부터 보낸 것이다 — 이어 붙이면 앞머리가 두 번 들어간다.
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(partial, { flags: response.status === 206 ? "a" : "w" }),
      );
    }
    const hash = createHash("sha256");
    await pipeline(createReadStream(partial), hash);
    if (hash.digest("hex") !== digest) {
      await fs.rm(partial, { force: true });
      throw new Error("MODEL_SHA_MISMATCH");
    }
    await fs.rename(partial, destination);
    await fs.writeFile(marker, digest, "utf8");
    return destination;
  }
  static async enroll(
    baseUrl: string,
    enrollmentToken: string,
    name: string,
    capabilities: WorkerCapabilities,
  ): Promise<{ worker_id: string; api_key: string }> {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/admin/api/generator/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: enrollmentToken, name, capabilities }),
    });
    if (!response.ok) throw new Error(`ENROLL_${response.status}`);
    return response.json() as Promise<{ worker_id: string; api_key: string }>;
  }
  async uploadArtifact(input: {
    jobId: string;
    kind: string;
    speakerId?: number;
    path: string;
    contentType: string;
    publicKey: string;
    chunkSize?: number;
  }): Promise<string> {
    const encrypted = await encryptFile(input.path, input.publicKey, input.chunkSize ?? 4 * 1024 * 1024);
    const registered = await this.request<{ artifact_id: string; upload_path: string }>("/generator/artifacts", {
      method: "POST",
      body: JSON.stringify({
        job_id: input.jobId,
        kind: input.kind,
        ...(input.speakerId === undefined ? {} : { speaker_id: input.speakerId }),
        content_type: input.contentType,
        byte_size: encrypted.plainSize,
        sha256: encrypted.sha256,
        encryption: "mora-aes-256-gcm-chunked-v1",
        wrapped_key: encrypted.wrappedKey,
        chunk_size: encrypted.chunkSize,
        filename: basename(input.path),
      }),
    });
    const stream = createReadStream(encrypted.path) as unknown as BodyInit;
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/u, "")}${registered.upload_path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: string });
    await fs.rm(encrypted.path, { force: true });
    if (!response.ok) throw new Error(`ARTIFACT_UPLOAD_${response.status}`);
    return registered.artifact_id;
  }
}

interface EncryptedFile {
  path: string;
  plainSize: number;
  sha256: string;
  wrappedKey: string;
  chunkSize: number;
}
async function encryptFile(path: string, publicKey: string, chunkSize: number): Promise<EncryptedFile> {
  const input = await fs.open(path, "r");
  const stat = await input.stat();
  const outputPath = `${path}.moraenc`;
  const output = await fs.open(outputPath, "w");
  const key = randomBytes(32);
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const hash = createHash("sha256");
  const header = Buffer.from(JSON.stringify({ v: 1, chunk_size: chunkSize, plain_size: stat.size }), "utf8");
  const prefix = Buffer.alloc(12);
  prefix.write("MORAENC1", 0, "ascii");
  prefix.writeUInt32BE(header.length, 8);
  await output.write(prefix);
  await output.write(header);
  let position = 0;
  let counter = 0;
  while (position < stat.size) {
    const size = Math.min(chunkSize, stat.size - position);
    const plain = Buffer.alloc(size);
    await input.read(plain, 0, size, position);
    hash.update(plain);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(counter, 8);
    const { createCipheriv } = await import("node:crypto");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record = Buffer.alloc(4);
    record.writeUInt32BE(ciphertext.length, 0);
    await output.write(nonce);
    await output.write(record);
    await output.write(ciphertext);
    await output.write(tag);
    position += size;
    counter += 1;
  }
  await input.close();
  await output.close();
  return { path: outputPath, plainSize: stat.size, sha256: hash.digest("hex"), wrappedKey: wrapped.toString("base64"), chunkSize };
}
