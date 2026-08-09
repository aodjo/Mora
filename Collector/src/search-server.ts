import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { searchYoutube, type YoutubeSearchResult } from "./youtube.js";

export const DEFAULT_SEARCH_PORT = 8710;

export interface SearchServerOptions {
  /** Which console may call in. Anything else is refused by the browser's own check. */
  origin: string;
  port?: number;
  search?: (query: string, limit?: number) => Promise<YoutubeSearchResult[]>;
  onLog?: (message: string) => void;
}

/**
 * A search endpoint the Admin console can reach.
 *
 * The console runs in a browser and the Worker cannot run yt-dlp, so a search there had to go
 * through the YouTube Data API and spend its daily quota — a hundred searches. The Collector
 * already has yt-dlp and is already running, so the console asks it instead.
 *
 * Bound to loopback: nothing off this machine can reach it, and it does nothing but search.
 */
export function startSearchServer(options: SearchServerOptions): Server {
  const search = options.search ?? searchYoutube;
  const server = createServer((request, response) => {
    void handle(request, response, options.origin, search).catch(() => {
      respond(response, 500, { error: "SEARCH_FAILED" }, options.origin);
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    options.onLog?.(
      error.code === "EADDRINUSE"
        ? `검색 서버 포트 ${options.port ?? DEFAULT_SEARCH_PORT}가 이미 사용 중입니다. Admin의 직접 검색은 비활성화됩니다.`
        : `검색 서버 오류: ${error.message}`,
    );
  });
  server.listen(options.port ?? DEFAULT_SEARCH_PORT, "127.0.0.1");
  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  search: (query: string, limit?: number) => Promise<YoutubeSearchResult[]>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "OPTIONS") return respond(response, 204, null, origin);
  if (request.method !== "GET") return respond(response, 405, { error: "METHOD_NOT_ALLOWED" }, origin);
  if (url.pathname === "/health") return respond(response, 200, { ok: true }, origin);
  if (url.pathname !== "/search") return respond(response, 404, { error: "NOT_FOUND" }, origin);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length === 0 || query.length > 200) return respond(response, 400, { error: "INVALID_QUERY" }, origin);
  respond(response, 200, { items: await search(query, Number(url.searchParams.get("limit") ?? 20)) }, origin);
}

function respond(response: ServerResponse, status: number, body: unknown, origin: string): void {
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
  });
  response.end(body === null ? undefined : JSON.stringify(body));
}
