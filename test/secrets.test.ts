/**
 * Keys (src/secrets.ts): values encrypted at rest, hints, the .env scan, imports; the `lw keys` file writer; and the
 * lines a run is started with (src/lw.ts).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "lw-secrets-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.LOFIWAVE_KEYS_KEY_FILE = join(tmp, "cfg", "keys.key");
process.env.KEYS_SCAN_ROOTS = join(tmp, "root");
const S = await import("../src/secrets");
const { db } = await import("../src/db");
const { setInEnvFile } = await import("../scripts/lw-keys");
const { agentContext } = await import("../src/lw");
const who = { actor: "tester", run: 7 };

test("values are encrypted at rest; the master key is a 0600 file outside the database", () => {
  const k = S.createSecret({ name: "openai-personal", value: "sk-proj-abcdefghijklmnopqrstuvwxyz1234", env: "OPENAI_API_KEY", service: "openai", note: "personal", fields: { account: "me" } }, who);
  expect(k.hint).toBe("sk-proj-…1234");
  const row = db.query<{ value_enc: string }, []>("SELECT value_enc FROM secrets WHERE name = 'openai-personal'").get()!;
  expect(row.value_enc).not.toContain("abcdefghij");
  expect(statSync(process.env.LOFIWAVE_KEYS_KEY_FILE!).mode & 0o777).toBe(0o600);
  expect(S.readValue("openai-personal", "env", who, "npm test").value).toBe("sk-proj-abcdefghijklmnopqrstuvwxyz1234");
  const d = S.secretDetail("openai-personal");
  expect(d.events.map((e) => [e.action, e.actor, e.run_id])).toEqual([["env", "tester", 7], ["created", "tester", 7]]);
});

test("hints: a type prefix only on long values, a URL's password hidden", () => {
  expect(S.hintOf("short")).toBe("•••••");
  expect(S.hintOf("dupe-value-test1")).toBe("…est1");
  expect(S.hintOf("ghp_DDDDDDDDDDDDDDDDDDDD4444")).toBe("ghp_…4444");
  expect(S.hintOf("postgres://app:s3cret@db.example.com:5432/x")).toBe("postgres://app:•••@db.example.com:5432");
});

test("names, duplicates, update, rename, fields merge and delete", () => {
  expect(() => S.createSecret({ name: "scan", value: "x" }, who)).toThrow("reserved");
  expect(() => S.createSecret({ name: "OPENAI-personal", value: "x" }, who)).toThrow("already exists");
  expect(() => S.createSecret({ name: "bad name", value: "x" }, who)).toThrow("may only have");
  const twin = S.createSecret({ name: "twin", value: "sk-proj-abcdefghijklmnopqrstuvwxyz1234" }, who);
  expect(twin.same_value_as).toBe("openai-personal");
  S.updateSecret("twin", { rename: "twin2", fields: { a: "1", b: "2" }, value: "new-value-0000000000" }, who);
  S.updateSecret("twin2", { fields: { a: "" } }, who);
  const t = S.secretDetail("twin2");
  expect(t.fields).toEqual({ b: "2" });
  expect(S.readValue("twin2", "reveal", who).value).toBe("new-value-0000000000");
  expect(S.listSecrets("personal").map((k) => k.name)).toEqual(["openai-personal"]);
  S.deleteSecret("twin2");
  expect(() => S.getSecret("twin2")).toThrow("no key called");
});

test("parseEnvText keeps secret-looking values, not placeholders or plain settings", () => {
  const found = S.parseEnvText([
    "export STRIPE_SECRET_KEY=\"sk_live_BBBBBBBBBBBBBBBB\" # live",
    "DEBUG=true",
    "API_KEY=your-api-key",
    "DATABASE_URL=postgres://u:pa55word@db/app",
    "PUBLIC_URL=https://example.com",
    "GITHUB_TOKEN=${GH}",
  ].join("\n"));
  expect(found.map((f) => [f.var, f.value, f.line])).toEqual([["STRIPE_SECRET_KEY", "sk_live_BBBBBBBBBBBBBBBB", 1], ["DATABASE_URL", "postgres://u:pa55word@db/app", 4]]);
});

test("scan groups a value found in several files, skips node_modules and examples, and import reads it from the file", async () => {
  const root = join(tmp, "root");
  for (const d of ["a", "b", "b/node_modules/x"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "a", ".env"), "REPLICATE_API_TOKEN=r8_CCCCCCCCCCCCCCCCCCCC3333\n");
  writeFileSync(join(root, "b", ".env.local"), "REPLICATE_API_TOKEN=r8_CCCCCCCCCCCCCCCCCCCC3333\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234\n");
  writeFileSync(join(root, "b", "node_modules", "x", ".env"), "OTHER_KEY=zzzzzzzzzzzzzzzzzzzz\n");
  writeFileSync(join(root, "a", ".env.example"), "EXAMPLE_KEY=zzzzzzzzzzzzzzzzzzzz\n");
  const s = await S.scanOut(true);
  expect(s.files).toBe(2);
  const rep = s.groups.find((g) => g.vars.includes("REPLICATE_API_TOKEN"))!;
  expect(rep.files.length).toBe(2);
  expect(rep.stored).toBeNull();
  expect(s.groups.find((g) => g.vars.includes("OPENAI_API_KEY"))!.stored).toBe("openai-personal");
  const k = await S.importFound({ file: join(root, "a", ".env"), var: "REPLICATE_API_TOKEN" }, who);
  expect(k.name).toBe("replicate-api-token");
  expect(k.env).toBe("REPLICATE_API_TOKEN");
  expect(k.files).toBe(2);
  expect(S.suggestName("REPLICATE_API_TOKEN", join(root, "b", ".env"))).toBe("replicate-api-token-b");
});

test("lw keys write: replaces the line (keeping export), adds missing ones, quotes what needs it", () => {
  const t = "export OPENAI_API_KEY=old\nOTHER=1";
  expect(setInEnvFile(t, "OPENAI_API_KEY", "sk-new")).toBe("export OPENAI_API_KEY=sk-new\nOTHER=1");
  expect(setInEnvFile(t, "NEW_KEY", "a b\"c")).toBe('export OPENAI_API_KEY=old\nOTHER=1\nNEW_KEY="a b\\"c"\n');
});

test("an agent run is told it is under lofiwave, about lw keys and (when installed) ccx", () => {
  const c = agentContext();
  expect(c).toContain("running inside lofiwave");
  expect(c).toContain("lw keys env <name> -- <command>");
});
