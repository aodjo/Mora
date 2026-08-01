import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "mora-dump-"));
const exported = join(directory, "public.sql");
const sanitized = join(directory, "mora-public.sqlite");
const config = new URL("../wrangler.jsonc", import.meta.url).pathname;
try {
  await run("npx", ["wrangler", "d1", "export", "mora-public", "--remote", `--output=${exported}`, `--config=${config}`], { maxBuffer: 20 * 1024 * 1024 });
  const source = await readFile(exported, "utf8");
  const cleanup = `
DELETE FROM public_alignment WHERE active = 0;
DROP TABLE IF EXISTS recording;
DROP TABLE IF EXISTS alignment;
DROP TABLE IF EXISTS d1_migrations;
VACUUM;
`;
  await writeFile(join(directory, "sanitized.sql"), `${source}\n${cleanup}`);
  await run("sqlite3", [sanitized, `.read ${join(directory, "sanitized.sql")}`]);
  await run("npx", ["wrangler", "r2", "object", "put", "mora-public-dumps/mora-public.sqlite", `--file=${sanitized}`, "--remote", `--config=${config}`]);
  process.stdout.write("published active-only mora-public.sqlite\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
