#!/usr/bin/env bash
# Point the pi coding agent (https://pi.dev) at Gemini through Neon's AI Gateway, so the console's `pi` type
# runs Gemini.
#
#   NEON_AI_GATEWAY_BASE_URL=https://<branch>-api.ai.<cell>.<region>.<cloud>.neon.tech \
#   NEON_AI_GATEWAY_TOKEN=nt_live_… scripts/setup-pi-neon.sh
#
# Both variables can also come from lofiwave's .env (`neon env pull` writes them). It adds a `neon` provider to
# ~/.pi/agent/models.json (or $PI_CODING_AGENT_DIR) using the gateway's OpenAI-compatible /v1 route. It also makes
# neon/$PI_NEON_MODEL (default gemini-4-argon) pi's default model in settings.json. Other providers and settings in
# those files are kept. The token is not written to disk: models.json reads it from $NEON_AI_GATEWAY_TOKEN when pi
# starts. Put it in lofiwave's .env (scripts/start.sh loads it) or in a run config's env, so runs inherit it.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${NEON_AI_GATEWAY_BASE_URL:?set NEON_AI_GATEWAY_BASE_URL (Neon Console → Connect → AI Gateway, or neon env pull)}"
MODEL="${PI_NEON_MODEL:-gemini-4-argon}"
DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$DIR"
command -v pi >/dev/null || echo "note: pi is not on PATH yet: bun add -g @earendil-works/pi-coding-agent" >&2
[ -n "${NEON_AI_GATEWAY_TOKEN:-}" ] || echo "note: NEON_AI_GATEWAY_TOKEN is not set here; pi needs it in its environment to call the gateway" >&2

DIR="$DIR" MODEL="$MODEL" BASE="${NEON_AI_GATEWAY_BASE_URL%/}" bun -e '
const { DIR, MODEL, BASE } = process.env;
const fs = require("node:fs"), path = require("node:path");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`${f} is not valid JSON: ${e.message}`); } };
const write = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
// Neon AI Gateway Gemini models (https://neon.com/docs/ai-gateway/models). Cost in USD per million tokens.
const gemini = (id, name, contextWindow, input, output) => ({
  id, name, reasoning: true, input: ["text", "image"], contextWindow, maxTokens: 65536,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 },
});
const models = [
  gemini("gemini-4-argon", "Gemini 4 Argon (Neon)", 1_000_000, 4, 20),
  gemini("gemini-4-carbon", "Gemini 4 Carbon (Neon)", 1_000_000, 0, 0),
  gemini("gemini-3-5-flash", "Gemini 3.5 Flash (Neon)", 1_000_000, 0, 0),
  gemini("gemini-3-1-pro", "Gemini 3.1 Pro (Neon)", 1_000_000, 0, 0),
];
if (!models.some((m) => m.id === MODEL)) models.push(gemini(MODEL, `${MODEL} (Neon)`, 1_000_000, 0, 0));
const mf = path.join(DIR, "models.json");
const m = read(mf);
m.providers ??= {};
m.providers.neon = {
  name: "Neon AI Gateway",
  baseUrl: `${BASE}/v1`,
  api: "openai-completions",
  apiKey: "$NEON_AI_GATEWAY_TOKEN",
  authHeader: true,
  compat: { supportsStore: false, supportsDeveloperRole: false, requiresNonNullAssistantContent: true, maxTokensField: "max_tokens" },
  models,
};
write(mf, m);
const sf = path.join(DIR, "settings.json");
const s = read(sf);
s.defaultProvider = "neon";
s.defaultModel = MODEL;
write(sf, s);
console.log(`pi: provider "neon" → ${BASE}/v1 in ${mf}; default model neon/${MODEL} in ${sf}`);
'
