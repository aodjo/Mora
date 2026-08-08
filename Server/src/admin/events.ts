// A subscriber that went away never drains its stream, and writing to it blocks forever
// instead of throwing. Delivery is therefore best-effort: a stalled subscriber is dropped
// rather than allowed to wedge the admin request that published the event.
const DELIVERY_TIMEOUT_MS = 1000;

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
      request.signal.addEventListener("abort", () => {
        this.#drop(writer);
      });
      void this.#deliver(writer, this.#encoder.encode(": connected\n\n"));
      return new Response(stream.readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
      });
    }
    if (path === "/publish" && request.method === "POST") {
      const payload = await request.text();
      const encoded = this.#encoder.encode(`event: update\ndata: ${payload}\n\n`);
      await Promise.all([...this.#writers].map((writer) => this.#deliver(writer, encoded)));
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  #drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    if (!this.#writers.delete(writer)) return;
    void writer.abort().catch(() => undefined);
  }

  async #deliver(writer: WritableStreamDefaultWriter<Uint8Array>, chunk: Uint8Array): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        writer.write(chunk),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("SLOW_SUBSCRIBER"));
          }, DELIVERY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this.#drop(writer);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export async function publishAdminEvent(namespace: DurableObjectNamespace, value: unknown): Promise<void> {
  const id = namespace.idFromName("global");
  await namespace.get(id).fetch("https://events.internal/publish", { method: "POST", body: JSON.stringify(value) });
}
