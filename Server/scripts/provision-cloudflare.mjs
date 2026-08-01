import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const configPath = join(root, "Server/wrangler.jsonc");
const wrangler = join(root, "node_modules/.bin/wrangler");
const secretBackupPath = join(root, "Server/.mora-infra-secrets.json");
const publicKeyPath = join(root, "Generator/artifact-public.pem");

async function command(file, args, options = {}) {
  try {
    return await exec(file, args, { cwd: root, maxBuffer: 20 * 1024 * 1024, ...options });
  } catch (error) {
    const message = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    throw new Error(message);
  }
}

async function cf(args) {
  return command(wrangler, [...args, "--config", configPath]);
}

async function assertAuthenticated() {
  const result = await cf(["whoami"]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not authenticated/iu.test(output)) {
    throw new Error("Cloudflare authentication required. Run: corepack pnpm infra:login");
  }
}

async function d1Databases() {
  const result = await cf(["d1", "list", "--json"]);
  return JSON.parse(result.stdout);
}

async function ensureD1(name) {
  let database = (await d1Databases()).find((item) => item.name === name);
  if (database === undefined) {
    process.stdout.write(`creating D1 ${name}\n`);
    await cf(["d1", "create", name, "--location", "apac"]);
    database = (await d1Databases()).find((item) => item.name === name);
  }
  if (database === undefined || typeof database.uuid !== "string") throw new Error(`Unable to resolve D1 ${name}`);
  return database.uuid;
}

async function ensureNamedResource(listArgs, createArgs, name, label) {
  const listed = await cf(listArgs);
  if (`${listed.stdout}\n${listed.stderr}`.includes(name)) return;
  process.stdout.write(`creating ${label} ${name}\n`);
  await cf(createArgs);
}

async function ensureHttpPull(queue) {
  const listed = await cf(["queues", "consumer", "http", "list", queue]);
  const output = `${listed.stdout}\n${listed.stderr}`;
  if (!/no http pull|0 consumers|\[\s*\]/iu.test(output)) return;
  process.stdout.write(`enabling HTTP pull consumer for ${queue}\n`);
  await cf(["queues", "consumer", "http", "add", queue, "--batch-size", "1", "--visibility-timeout-secs", "43200"]);
}

async function updateD1Bindings(ids) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (const binding of config.d1_databases ?? []) {
    const id = ids[binding.database_name];
    if (id !== undefined) binding.database_id = id;
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function generatedSecrets() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    BOOTSTRAP_TOKEN: randomBytes(32).toString("hex"),
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ARTIFACT_PRIVATE_KEY: pair.privateKey,
    ARTIFACT_PUBLIC_KEY: pair.publicKey,
    created_at: new Date().toISOString(),
  };
}

async function loadOrCreateSecrets() {
  try { return JSON.parse(await readFile(secretBackupPath, "utf8")); }
  catch {
    const secrets = generatedSecrets();
    await writeFile(secretBackupPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    return secrets;
  }
}

async function deploy(secrets) {
  const directory = await mkdtemp(join(tmpdir(), "mora-deploy-"));
  const secretFile = join(directory, "secrets.json");
  try {
    await writeFile(secretFile, JSON.stringify({
      BOOTSTRAP_TOKEN: secrets.BOOTSTRAP_TOKEN,
      SECRET_ENCRYPTION_KEY: secrets.SECRET_ENCRYPTION_KEY,
      ARTIFACT_PRIVATE_KEY: secrets.ARTIFACT_PRIVATE_KEY,
    }), { mode: 0o600 });
    const result = await cf(["deploy", "--secrets-file", secretFile, "--keep-vars"]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  await assertAuthenticated();
  const [publicId, adminId] = await Promise.all([ensureD1("mora-public"), ensureD1("mora-admin")]);
  await updateD1Bindings({ "mora-public": publicId, "mora-admin": adminId });
  await ensureNamedResource(["r2", "bucket", "list"], ["r2", "bucket", "create", "mora-admin-artifacts", "--location", "apac"], "mora-admin-artifacts", "R2 bucket");
  await ensureNamedResource(["r2", "bucket", "list"], ["r2", "bucket", "create", "mora-public-dumps", "--location", "apac"], "mora-public-dumps", "R2 bucket");
  await ensureNamedResource(["queues", "list"], ["queues", "create", "mora-generation", "--message-retention-period-secs", "86400"], "mora-generation", "Queue");
  await ensureHttpPull("mora-generation");

  process.stdout.write("building Mora\n");
  await command("corepack", ["pnpm", "build"]);
  process.stdout.write("applying D1 migrations\n");
  await cf(["d1", "migrations", "apply", "mora-public", "--remote"]);
  await cf(["d1", "migrations", "apply", "mora-admin", "--remote"]);

  const secrets = await loadOrCreateSecrets();
  await writeFile(publicKeyPath, secrets.ARTIFACT_PUBLIC_KEY, { mode: 0o600 });
  await chmod(secretBackupPath, 0o600);
  await deploy(secrets);
  try {
    await command("corepack", ["pnpm", "dump:publish"]);
    process.stdout.write("published initial public dump\n");
  } catch {
    process.stdout.write("initial dump skipped; run `corepack pnpm dump:publish` after installing sqlite3\n");
  }

  process.stdout.write("\nprovisioned Mora Cloudflare infrastructure\n");
  process.stdout.write(`bootstrap credentials: ${secretBackupPath}\n`);
  process.stdout.write(`generator public key: ${publicKeyPath}\n`);
  process.stdout.write("Create a Cloudflare API token with Account/Queues Edit for each Generator, then copy the Queue ID from `wrangler queues list`.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
