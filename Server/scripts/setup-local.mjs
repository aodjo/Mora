import { generateKeyPairSync, randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const varsPath = join(root, "Server/.dev.vars");
const publicKeyPath = join(root, "Generator/artifact-public.local.pem");

try {
  await access(varsPath);
  process.stdout.write("Local secrets already exist in Server/.dev.vars.\n");
  process.exit(0);
} catch { /* create below */ }

const pair = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const bootstrapToken = randomBytes(32).toString("hex");
const encryptionKey = randomBytes(32).toString("base64");
const vars = [
  `BOOTSTRAP_TOKEN=${bootstrapToken}`,
  `SECRET_ENCRYPTION_KEY=${encryptionKey}`,
  `ARTIFACT_PRIVATE_KEY=${JSON.stringify(pair.privateKey)}`,
  "ADMIN_RP_ID=localhost",
  "ADMIN_ORIGIN=http://localhost:5173",
  "",
].join("\n");

await writeFile(varsPath, vars, { mode: 0o600 });
await writeFile(publicKeyPath, pair.publicKey, { mode: 0o600 });
await Promise.all([chmod(varsPath, 0o600), chmod(publicKeyPath, 0o600)]);
process.stdout.write("Created local Worker secrets and artifact key.\n");
process.stdout.write("Bootstrap token is stored in Server/.dev.vars.\n");
