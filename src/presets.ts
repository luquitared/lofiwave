/**
 * Presets: named prompts that shape how an agent works ("PR mode", "Vibecode for non-coders", …). A run can have
 * several; their prompts are joined, in the order picked, and go in with the rest of its instructions (claude and pi
 * `--append-system-prompt`, codex `developer_instructions`, see src/configs.ts). A run's presets are kept in its meta,
 * so a restart or resume keeps them.
 *
 * Where presets come from, later ones winning on a name:
 * - built in (BUILTIN below),
 * - LOFIWAVE_PRESETS_DIR: a folder of `<name>.md` files, for a machine set up by a script. A first line
 *   `<!-- description -->` is the description; the rest is the prompt. Read on every listing; not editable here.
 * - the database: made in Settings → Presets, or with `lw presets add`. Saving a built-in one keeps your version;
 *   deleting it goes back to the built-in text.
 *
 * Every new session on this machine starts with the machine's default presets, unless it picks its own: the
 * `default_presets` setting (Settings, `lw presets default`), else LOFIWAVE_DEFAULT_PRESETS (comma-separated).
 * Workflow runs and swarm workers don't get them: they bring their own instructions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "./db";

export class PresetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Preset = { name: string; description: string; prompt: string; source: "builtin" | "file" | "custom"; edited: boolean; builtin_prompt?: string };

export const PRESET_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

const BUILTIN: Omit<Preset, "source" | "edited">[] = [
  {
    name: "autonomous",
    description: "Works to the finish on its own; the person trusts its decisions.",
    prompt: `## Mode: autonomous
The person who started this session trusts your judgment and wants the work finished, not a conversation about it.
- Keep going until the goal is done: plan, build, run it, test it, fix what breaks, and check the result yourself.
- Make reasonable decisions on your own instead of asking. Ask only when you're blocked on something only the person can decide (a credential, a choice that is hard to undo, something that costs money), and then ask once, with your recommendation.
- Don't stop at a partial result or hand work back that you could finish. If something can't be done, say exactly what's left and why.
- When you're done, give a short summary: what you did, how you checked it, and anything the person should know.`,
  },
  {
    name: "pr",
    description: "Every change is pushed as a pull request, and nothing lives only on this machine.",
    prompt: `## Mode: PR
Work so that nothing is lost when this machine or session goes away.
- Do the work on a branch (never commit straight to main). When a piece of work is done, commit only the files you changed, push, and open a pull request with a clear title and description. Update the same PR for follow-up changes.
- If the work depends on files that aren't in the repo (generated assets, uploads, data, a built site), save them somewhere durable too: commit them, or put them where the project keeps such files, and say where in the PR.
- If the folder isn't a git repo or has no remote, say so and ask where the work should be saved before you finish.
- End with the PR's link.`,
  },
  {
    name: "vibecode",
    description: "For people who don't code: plain language, live previews, work saved and shared for them.",
    prompt: `## Mode: building for someone who doesn't code
The person you're working with is not a programmer. They describe what they want; you build it and show it to them.
- Talk in plain language. No jargon, no code in your replies unless they ask, no terminal instructions for them to follow. Do every technical step yourself.
- Show, don't tell: as soon as there is something to see, start it (a dev server, or open the file) and give them the link to the live preview. Keep it running and say when it has updated. Use a port that's free and an address they can open from their browser.
- Work in small steps they can see, and check each one works before you say it's done. If something breaks, fix it rather than explaining it.
- When it's time to make a choice, offer two or three options in plain words with your recommendation.
- Save their work for them: keep it in git, push it, and open a pull request when a piece is done (they won't know to ask). If teammates are working in the same project, pull their changes first, and mention who else changed what.
- Never ask them to paste secrets into the chat. If something needs an API key, look in \`lw keys\` first, and if it isn't there, tell them who to ask.`,
  },
];

/** LOFIWAVE_PRESETS_DIR's presets. Bad files are skipped with a warning (once per file and change). */
const warned = new Set<string>();
function filePresets(): Omit<Preset, "source" | "edited">[] {
  const dir = process.env.LOFIWAVE_PRESETS_DIR?.trim();
  if (!dir) return [];
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    if (!warned.has(root)) { warned.add(root); console.warn(`LOFIWAVE_PRESETS_DIR: ${root} is not a folder; no presets read from it`); }
    return [];
  }
  const out: Omit<Preset, "source" | "edited">[] = [];
  for (const f of readdirSync(root).sort()) {
    if (!f.endsWith(".md")) continue;
    const name = f.slice(0, -3).toLowerCase();
    if (!PRESET_NAME.test(name)) {
      if (!warned.has(f)) { warned.add(f); console.warn(`LOFIWAVE_PRESETS_DIR: ${f}: a preset name is lowercase letters, digits, - and _; skipped`); }
      continue;
    }
    let text = "";
    try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    const m = /^\s*<!--\s*([\s\S]*?)\s*-->\s*\n?/.exec(text);
    out.push({ name, description: m ? m[1].replace(/\s+/g, " ") : "", prompt: (m ? text.slice(m[0].length) : text).trim() });
  }
  return out;
}

type PresetRow = { name: string; description: string; prompt: string; created_at: number; updated_at: number };

/** Every preset, built-in ones first, then by name. */
export function listPresets(): Preset[] {
  const byName = new Map<string, Preset>();
  for (const b of BUILTIN) byName.set(b.name, { ...b, source: "builtin", edited: false });
  for (const f of filePresets()) byName.set(f.name, { ...f, source: "file", edited: false });
  for (const r of db.query<PresetRow, []>("SELECT * FROM presets").all()) {
    const base = byName.get(r.name);
    byName.set(r.name, base && base.source !== "custom"
      ? { ...base, description: r.description, prompt: r.prompt, edited: true, builtin_prompt: base.prompt }
      : { name: r.name, description: r.description, prompt: r.prompt, source: "custom", edited: false });
  }
  const order = (p: Preset) => (p.source === "builtin" ? BUILTIN.findIndex((b) => b.name === p.name) : 100);
  return [...byName.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export function getPreset(name: string): Preset {
  const p = listPresets().find((x) => x.name === name);
  if (!p) throw new PresetError(404, `unknown preset "${name}"`);
  return p;
}

/** Create or replace a preset. For a built-in (or file) one this saves your version over it. */
export function savePreset(name: string, b: { description?: unknown; prompt?: unknown }, { create = false } = {}) {
  if (!PRESET_NAME.test(name)) throw new PresetError(400, "a preset name is lowercase letters, digits, - and _ (up to 41), starting with a letter or digit");
  const cur = listPresets().find((x) => x.name === name);
  if (create && cur) throw new PresetError(409, `preset "${name}" already exists`);
  if (!create && !cur) throw new PresetError(404, `unknown preset "${name}"`);
  const description = b.description === undefined || b.description === null ? cur?.description ?? "" : String(b.description).trim();
  const prompt = b.prompt === undefined || b.prompt === null ? cur?.prompt ?? "" : String(b.prompt).trim();
  if (!prompt) throw new PresetError(400, "prompt is required");
  if (prompt.length > 20_000) throw new PresetError(400, "prompt: at most 20,000 characters");
  const t = Date.now();
  db.prepare(`INSERT INTO presets (name, description, prompt, created_at, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET description = excluded.description, prompt = excluded.prompt, updated_at = excluded.updated_at`)
    .run(name, description, prompt, t, t);
  return getPreset(name);
}

/** Delete a preset made here; for a built-in or file one, drop your version (back to theirs). */
export function deletePreset(name: string): { reset: boolean } {
  const cur = getPreset(name);
  if (cur.source !== "custom" && !cur.edited) throw new PresetError(400, `"${name}" is a ${cur.source === "builtin" ? "built-in" : "LOFIWAVE_PRESETS_DIR"} preset and can't be deleted; nothing of yours to reset`);
  db.prepare("DELETE FROM presets WHERE name = ?").run(name);
  const reset = cur.source !== "custom";
  if (!reset) {
    // Leave no dangling name in the machine's default.
    const s = getSetting("default_presets");
    if (s !== null) setSetting("default_presets", parseNames(s).filter((n) => n !== name).join(","));
  }
  return { reset };
}

// ---------------------------------------------------------------- settings (one row per key)

export function getSetting(key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}
export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, Date.now());
}

export const parseNames = (v: string) => [...new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];

/** Preset names from a request: an array or "a,b". Each must exist. undefined/null = not given. */
export function presetNames(v: unknown, field = "presets"): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const names = typeof v === "string" ? parseNames(v) : Array.isArray(v) && v.every((x) => typeof x === "string") ? parseNames(v.join(",")) : null;
  if (!names) throw new PresetError(400, `${field} must be an array of preset names or "a,b"`);
  const known = new Set(listPresets().map((p) => p.name));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length) throw new PresetError(400, `${field}: unknown preset${missing.length > 1 ? "s" : ""} ${missing.map((n) => `"${n}"`).join(", ")}`);
  return names;
}

/** The presets every new session on this machine starts with, and where that comes from. Unknown names are dropped. */
export function defaultPresets(): { names: string[]; from: "settings" | "env" | "none" } {
  const s = getSetting("default_presets");
  const env = process.env.LOFIWAVE_DEFAULT_PRESETS?.trim() ?? "";
  const raw = s !== null ? s : env;
  const known = new Set(listPresets().map((p) => p.name));
  return { names: parseNames(raw).filter((n) => known.has(n)), from: s !== null ? "settings" : env ? "env" : "none" };
}

export type View = "chat" | "terminal";
/** How the browser opens a session that can be shown as a chat: the `default_view` setting, else LOFIWAVE_DEFAULT_VIEW, else chat. */
export function defaultView(): { view: View; from: "settings" | "env" | "none" } {
  const s = getSetting("default_view");
  if (s === "chat" || s === "terminal") return { view: s, from: "settings" };
  const env = process.env.LOFIWAVE_DEFAULT_VIEW?.trim().toLowerCase();
  if (env === "chat" || env === "terminal") return { view: env, from: "env" };
  return { view: "chat", from: "none" };
}

/** The joined prompt of these presets, in this order (unknown names skipped: a preset deleted since the run started). */
export function presetInstructions(names: string[]): string {
  const all = new Map(listPresets().map((p) => [p.name, p]));
  return names.map((n) => all.get(n)?.prompt ?? "").filter((x) => x.trim()).join("\n\n");
}
