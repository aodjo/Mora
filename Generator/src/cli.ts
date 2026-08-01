import { createGeneratorHttpServer } from "./http.js";
import { GeneratorService } from "./service.js";

const host = process.env.GENERATOR_HOST ?? "127.0.0.1";
const port = Number(process.env.GENERATOR_PORT ?? "3100");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("GENERATOR_PORT must be an integer from 1 to 65535");
}

const service = new GeneratorService({
  ...(process.env.SERVICE_PUBLISH_URL === undefined
    ? {}
    : { publishUrl: process.env.SERVICE_PUBLISH_URL }),
  ...(process.env.SERVICE_PUBLISH_TOKEN === undefined
    ? {}
    : { publishToken: process.env.SERVICE_PUBLISH_TOKEN }),
});
const server = createGeneratorHttpServer(service);
server.listen(port, host, () => {
  process.stdout.write(`generator listening on http://${host}:${port}\n`);
});

function shutdown(): void {
  server.close(() => {
    process.exitCode = 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
