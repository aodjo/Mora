export class AdminEventHub implements DurableObject {
  readonly #writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  readonly #encoder = new TextEncoder();

  constructor(readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/subscribe") {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      this.#writers.add(writer);
      await writer.write(this.#encoder.encode(": connected\n\n"));
      return new Response(stream.readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
    }
    if (path === "/publish" && request.method === "POST") {
      const payload = await request.text();
      const encoded = this.#encoder.encode(`event: update\ndata: ${payload}\n\n`);
      await Promise.all([...this.#writers].map(async (writer) => {
        try { await writer.write(encoded); } catch { this.#writers.delete(writer); }
      }));
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }
}

export async function publishAdminEvent(namespace: DurableObjectNamespace, value: unknown): Promise<void> {
  const id = namespace.idFromName("global");
  await namespace.get(id).fetch("https://events.internal/publish", { method: "POST", body: JSON.stringify(value) });
}
