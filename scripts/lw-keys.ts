/**
 * `lw keys`: this machine's API keys and secrets, kept encrypted by lofiwave (src/secrets.ts). Made for agents:
 * `env`, `write` and `copy` hand a key to a command, a file or the clipboard without printing it, so it stays out of
 * the conversation's transcript. `reveal` prints it, for when nothing else will do.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { resolve } from "node:path";

const URL_ = (process.env.AGENT_CONSOLE_URL || process.env.LW_DEFAULT_URL || "http://127.0.0.1:7770").replace(/\/+$/, "");
const RUN = process.env.AGENT_CONSOLE_RUN_ID || "";

/** The run's token, or (in your own terminal, through the DATA_DIR/bin/lw shim) the console's token file. */
function token(): string {
  const t = process.env.AGENT_CONSOLE_TOKEN?.trim();
  if (t) return t;
  const f = process.env.LW_TOKEN_FILE;
  if (f && existsSync(f)) { try { return readFileSync(f, "utf8").trim(); } catch { /* not readable by this user */ } }
  return die("no lofiwave token: run this inside a lofiwave session, or set AGENT_CONSOLE_TOKEN (and AGENT_CONSOLE_URL)");
}

export const KEYS_HELP = `Keys (API keys and secrets on this machine, encrypted by lofiwave)
  lw keys [list] [--json]          every key: name, env var, service, a hint of the value
  lw keys search <words>           by name, env var, service, note, fields or tags
  lw keys show <name>              everything but the value: note, fields, where it's written on disk, recent uses
  lw keys env <name>[=VAR]... -- <command> [args]
                                   run a command with keys in its environment (VAR defaults to the key's env var)
  lw keys write <name>[=VAR]... --to <file>
                                   set VAR=<value> in a .env-style file (replaced if there, added if not)
  lw keys copy <name>              onto this machine's clipboard
  lw keys reveal <name>            print the value. It ends up in your transcript: prefer env, write or copy
  lw keys add <name> --env VAR [--service s] [--note "…"] [--field k=v]... [--tag t]...
         value from: --from-env VAR | --value-file <path> | --value - (stdin) | --value <v> (lands in the transcript)
  lw keys import <file> <VAR> [--name n] [--service s] [--note "…"]
                                   store a value from a .env file or shell profile, read by lofiwave, not printed
  lw keys set <name> [--rename n] [--env VAR] [--service s] [--note "…"] [--field k=v]... [--field k=] [--tag t]...
         and a new value with the same flags as add
  lw keys note <name> "<text>"     add a line to its note
  lw keys rm <name>                delete it
  lw keys scan [--refresh]         keys found in .env files and shell profiles here that lofiwave doesn't hold yet
  lw keys where <name>             the files that have this key's value
`;

function die(msg: string, code = 1): never { console.error(`lw: ${msg}`); process.exit(code); }

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${URL_}/api${path}`, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...(RUN ? { "x-lofiwave-run": RUN } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) { die(`can't reach lofiwave at ${URL_}: ${e?.message ?? e}`); }
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  if (!res.ok) die(typeof data === "object" && data?.error ? data.error : `${res.status} ${text.slice(0, 300)}`);
  return data;
}

/** Positionals and --flags; `multi` flags may repeat, `bools` take no value. Everything after `--` is kept apart. */
function parse(argv: string[], bools: string[] = [], multi: string[] = []) {
  const pos: string[] = [], flags: Record<string, string> = {}, lists: Record<string, string[]> = {};
  let after: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { after = argv.slice(i + 1); break; }
    if (!a.startsWith("--") || a === "-") { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = (eq > 0 ? a.slice(0, eq) : a).slice(2);
    if (bools.includes(name)) { flags[name] = "1"; continue; }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) die(`--${name} needs a value`);
    if (multi.includes(name)) (lists[name] ??= []).push(value); else flags[name] = value;
  }
  return { pos, flags, lists, after };
}

const enc = encodeURIComponent;
const ago = (ms: number | null) => { if (!ms) return "never"; const m = Math.round((Date.now() - ms) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^(\d)/, "_$1");

/** --field k=v pairs. `k=` (empty) removes the field on set. */
function fieldsOf(list: string[] | undefined): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  const out: Record<string, string> = {};
  for (const f of list) { const i = f.indexOf("="); if (i < 1) die(`--field wants key=value, not "${f}"`); out[f.slice(0, i).trim()] = f.slice(i + 1); }
  return out;
}

/** The new value from --from-env, --value-file or --value (- = stdin); undefined when none was given. */
async function valueOf(flags: Record<string, string>): Promise<string | undefined> {
  if (flags["from-env"]) {
    const v = process.env[flags["from-env"]];
    if (!v) die(`$${flags["from-env"]} is not set in this environment`);
    return v;
  }
  if (flags["value-file"]) {
    const p = resolve(flags["value-file"]);
    if (!existsSync(p) || !statSync(p).isFile()) die(`no file at ${p}`);
    return readFileSync(p, "utf8").replace(/\r?\n$/, "");
  }
  if (flags.value === "-") return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  return flags.value;
}

function line(k: any) {
  const bits = [k.env && k.env !== k.name ? k.env : "", k.service, k.hint].filter(Boolean).join(" · ");
  const used = k.files ? ` · in ${k.files} file${k.files === 1 ? "" : "s"}` : "";
  return `${k.name}${bits ? `  ${bits}` : ""}${used}${k.note ? `\n    ${k.note.split("\n")[0].slice(0, 110)}` : ""}`;
}

/** name or name=VAR → the key and the env var it goes in. */
async function pairsOf(specs: string[]) {
  if (!specs.length) die("which key? (lw keys list)");
  return Promise.all(specs.map(async (s) => {
    const i = s.indexOf("=");
    const name = i > 0 ? s.slice(0, i) : s;
    return { name, as: i > 0 ? s.slice(i + 1) : "" };
  }));
}
async function valuesFor(specs: string[], use: string, detail: string) {
  const out: { name: string; var: string; value: string }[] = [];
  for (const p of await pairsOf(specs)) {
    const v = await call("POST", `/secrets/${enc(p.name)}/value`, { use, detail });
    out.push({ name: v.name, var: p.as || v.env || envName(v.name), value: v.value });
  }
  return out;
}

/** Set VAR=value in a .env-style file: the existing line is replaced (keeping `export `), or one is added. */
export function setInEnvFile(text: string, varName: string, value: string): string {
  const quoted = /^[A-Za-z0-9_./:@+,=-]*$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${varName}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, (_m, pre) => `${pre}${varName}=${quoted}`);
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${varName}=${quoted}\n`;
}

async function toClipboard(value: string) {
  const tools = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  for (const t of tools) {
    if (!Bun.which(t[0])) continue;
    const p = Bun.spawn(t, { stdin: new TextEncoder().encode(value), stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) === 0) return t[0];
  }
  return die(process.platform === "darwin" ? "pbcopy failed" : "no clipboard here (wl-copy, xclip or xsel): use lw keys env or lw keys write instead");
}

export async function keysCommand(argv: string[]) {
  const [sub = "list", ...rest] = argv;
  switch (sub) {
    case "help": case "--help": case "-h":
      return console.log(KEYS_HELP);

    case "list": case "ls": case "search": case "find": {
      const { pos, flags } = parse(rest, ["json"]);
      const q = sub === "list" || sub === "ls" ? "" : pos.join(" ");
      const list = await call("GET", `/secrets${q ? `?q=${enc(q)}` : ""}`);
      if (flags.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log(q ? `no key matches "${q}"` : "no keys yet (lw keys scan shows the ones on this computer; lw keys add stores one)");
      return console.log(list.map(line).join("\n"));
    }

    case "show": case "info": case "where": {
      const { pos, flags } = parse(rest, ["json"]);
      const k = await call("GET", `/secrets/${enc(pos[0] ?? die(`lw keys ${sub} <name>`))}`);
      if (flags.json) return console.log(JSON.stringify(k, null, 2));
      if (sub === "where") {
        if (!k.where.length) return console.log(k.scanned_at ? `not written in any .env file or profile found here (scanned ${ago(k.scanned_at)})` : "not scanned yet: lw keys scan");
        return console.log(k.where.map((f: any) => `${f.file}:${f.line}  ${f.var}`).join("\n"));
      }
      const out = [
        `${k.name}${k.service ? `  (${k.service})` : ""}`,
        `  env var: ${k.env || "-"}    value: ${k.hint}`,
        ...Object.entries(k.fields).map(([f, v]) => `  ${f}: ${v}`),
        k.tags.length ? `  tags: ${k.tags.join(", ")}` : "",
        k.note ? `  note: ${k.note.replace(/\n/g, "\n        ")}` : "",
        `  added ${ago(k.created_at)}${k.created_by ? ` by ${k.created_by}` : ""}${k.source ? ` from ${k.source}` : ""} · changed ${ago(k.updated_at)} · last used ${ago(k.used_at)}`,
        k.where.length ? `  written in:\n${k.where.slice(0, 20).map((f: any) => `    ${f.file}:${f.line}  ${f.var}`).join("\n")}${k.where.length > 20 ? `\n    … ${k.where.length - 20} more (lw keys where ${k.name})` : ""}` : "",
        k.events.length ? `  recent:\n${k.events.slice(0, 8).map((e: any) => `    ${ago(e.at)}  ${e.action}${e.actor ? ` by ${e.actor}` : ""}${e.run_id ? ` (run ${e.run_id})` : ""}${e.detail ? `: ${e.detail}` : ""}`).join("\n")}` : "",
      ];
      return console.log(out.filter(Boolean).join("\n"));
    }

    case "env": case "run": case "exec": {
      const { pos, after } = parse(rest);
      if (!after?.length) die("lw keys env <name>[=VAR]... -- <command> [args]");
      const vals = await valuesFor(pos, "env", after.join(" ").slice(0, 200));
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const v of vals) env[v.var] = v.value;
      const p = Bun.spawn(after, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await p.exited);
    }

    case "write": {
      const { pos, flags } = parse(rest);
      const to = flags.to || flags.file || die("lw keys write <name>[=VAR]... --to <file>");
      const file = resolve(to);
      const vals = await valuesFor(pos, "write", file);
      const existed = existsSync(file);
      let text = existed ? readFileSync(file, "utf8") : "";
      for (const v of vals) text = setInEnvFile(text, v.var, v.value);
      writeFileSync(file, text, { mode: 0o600 });
      if (!existed) chmodSync(file, 0o600);
      return console.log(`${vals.map((v) => `${v.var} (${v.name})`).join(", ")} written to ${file}${existed ? "" : " (new, mode 600)"}`);
    }

    case "copy": case "cp": {
      const { pos } = parse(rest);
      const [v] = await valuesFor([pos[0] ?? die("lw keys copy <name>")], "copy", "clipboard");
      const tool = await toClipboard(v.value);
      return console.log(`${v.name} is on the clipboard (${tool})`);
    }

    case "reveal": case "get": case "value": {
      const { pos } = parse(rest);
      const [v] = await valuesFor([pos[0] ?? die("lw keys reveal <name>")], "reveal", "printed");
      return process.stdout.write(v.value + (process.stdout.isTTY ? "\n" : ""));
    }

    case "add": case "new": {
      const { pos, flags, lists } = parse(rest, [], ["field", "tag"]);
      const name = pos[0] ?? die("lw keys add <name> --env VAR --from-env VAR | --value-file <path> | --value -");
      const value = (await valueOf(flags)) ?? die("where's the value? --from-env VAR, --value-file <path>, or --value - to read stdin");
      const k = await call("POST", "/secrets", {
        name, value, env: flags.env ?? (/^[A-Z][A-Z0-9_]*$/.test(name) ? name : ""), service: flags.service, note: flags.note,
        fields: fieldsOf(lists.field), tags: lists.tag,
      });
      return console.log(`stored ${k.name} (${k.hint})${k.same_value_as ? `; note: ${k.same_value_as} has the same value` : ""}`);
    }

    case "import": {
      const { pos, flags, lists } = parse(rest, [], ["field", "tag"]);
      const [file, v] = pos;
      if (!file || !v) die("lw keys import <file> <VAR> [--name n]");
      const k = await call("POST", "/secrets/import", { file: resolve(file), var: v, name: flags.name, env: flags.env, service: flags.service, note: flags.note, fields: fieldsOf(lists.field), tags: lists.tag });
      return console.log(`stored ${k.name} (${k.hint}) from ${file}${k.same_value_as ? `; note: ${k.same_value_as} has the same value` : ""}`);
    }

    case "set": case "edit": case "update": {
      const { pos, flags, lists } = parse(rest, [], ["field", "tag"]);
      const name = pos[0] ?? die("lw keys set <name> [--rename n] [--env VAR] [--service s] [--note …] [--field k=v] [--from-env VAR]");
      const value = await valueOf(flags);
      const k = await call("PUT", `/secrets/${enc(name)}`, {
        ...(flags.rename ? { name: flags.rename } : {}), ...(value !== undefined ? { value } : {}),
        ...(flags.env !== undefined ? { env: flags.env } : {}), ...(flags.service !== undefined ? { service: flags.service } : {}),
        ...(flags.note !== undefined ? { note: flags.note } : {}), ...(lists.field ? { fields: fieldsOf(lists.field) } : {}), ...(lists.tag ? { tags: lists.tag } : {}),
      });
      return console.log(`updated ${k.name}${value !== undefined ? ` (value now ${k.hint})` : ""}`);
    }

    case "note": {
      const [name, ...text] = rest;
      const t = text.join(" ").trim();
      if (!name || !t) die('lw keys note <name> "<text>"');
      const cur = await call("GET", `/secrets/${enc(name)}`);
      await call("PUT", `/secrets/${enc(name)}`, { note: [cur.note, t].filter(Boolean).join("\n") });
      return console.log("noted");
    }

    case "rm": case "delete": case "del": {
      const name = rest[0] ?? die("lw keys rm <name>");
      await call("DELETE", `/secrets/${enc(name)}`);
      return console.log(`deleted ${name}`);
    }

    case "scan": {
      const { flags } = parse(rest, ["refresh", "all", "json"]);
      const s = await call("GET", `/secrets/scan${flags.refresh ? "?refresh=1" : ""}`);
      if (flags.json) return console.log(JSON.stringify(s, null, 2));
      const groups = flags.all ? s.groups : s.groups.filter((g: any) => !g.stored);
      console.log(`${s.files} files under ${s.roots.join(", ")}, scanned ${ago(s.scanned_at)}: ${s.groups.length} distinct values, ${s.groups.filter((g: any) => g.stored).length} already stored`);
      for (const g of groups) {
        const f = g.files[0];
        console.log(`${g.vars.join(", ")}  ${g.hint}${g.stored ? `  = ${g.stored}` : ""}\n    ${f.file}${g.files.length > 1 ? ` and ${g.files.length - 1} more` : ""}${g.stored ? "" : `   → lw keys import ${f.file} ${f.var}`}`);
      }
      return;
    }

    default:
      die(`unknown: lw keys ${sub} (lw keys help)`);
  }
}
