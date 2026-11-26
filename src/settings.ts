/**
 * Machine-wide settings changed from Settings in the UI (GET/PUT /api/settings), kept in the `settings` table.
 * Unlike env vars they take effect on the next run, without restarting lofiwave.
 */
import { db, now } from "./db";

/**
 * What an interactive run does on this machine's desktop besides its tmux session:
 * - "managed": nothing; it lives in lofiwave (the browser terminal, Chat, `tmux attach -t ac-<run>`). The default.
 * - "window": a new terminal window attached to the session.
 * - "tab": a new tab in the terminal's frontmost window (a new window when there is none, or the terminal can't do tabs).
 */
export const TERMINAL_MODES = ["managed", "window", "tab"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];

export type Settings = { terminal_mode: TerminalMode };
const DEFAULTS: Settings = { terminal_mode: "managed" };

export class SettingsError extends Error {}

export function getSettings(): Settings {
  const out: any = { ...DEFAULTS };
  for (const r of db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all()) {
    if (!(r.key in DEFAULTS)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* keep the default */ }
  }
  if (!TERMINAL_MODES.includes(out.terminal_mode)) out.terminal_mode = DEFAULTS.terminal_mode;
  return out;
}

/** Apply a partial update; unknown keys and bad values are refused, not ignored. */
export function updateSettings(patch: Record<string, unknown>): Settings {
  for (const k of Object.keys(patch)) if (!(k in DEFAULTS)) throw new SettingsError(`unknown setting "${k}"`);
  if ("terminal_mode" in patch && !TERMINAL_MODES.includes(patch.terminal_mode as TerminalMode)) {
    throw new SettingsError(`terminal_mode must be one of ${TERMINAL_MODES.join(", ")}`);
  }
  const put = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  for (const [k, v] of Object.entries(patch)) put.run(k, JSON.stringify(v), now());
  return getSettings();
}
