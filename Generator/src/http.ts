import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ServiceError } from "../../packages/core/src/shared/errors.js";
import type { GeneratorService } from "./service.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== undefined && contentType !== "application/json") {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ServiceError(400, "BAD_JSON");
  }
}

export function createGeneratorHttpServer(service: GeneratorService): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://generator.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST") throw new ServiceError(404, "NOT_FOUND");
      if (url.pathname === "/v1/build") {
        sendJson(response, 200, service.build(await readJson(request)));
        return;
      }
      if (url.pathname === "/v1/publish") {
        sendJson(response, 201, await service.publish(await readJson(request)));
        return;
      }
      if (url.pathname === "/v1/tokenize") {
        sendJson(response, 200, service.tokenize(await readJson(request)));
        return;
      }
      throw new ServiceError(404, "NOT_FOUND");
    } catch (error) {
      // Never log request bodies, caught values, or stacks: they can retain lyrics.
      if (error instanceof ServiceError) sendJson(response, error.status, { error: error.code });
      else sendJson(response, 500, { error: "INTERNAL" });
    }
  });
}
