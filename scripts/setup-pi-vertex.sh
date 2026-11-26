#!/usr/bin/env bash
# Point the pi coding agent (https://pi.dev) at Gemini on Google Cloud's Vertex AI, so the console's `pi` type runs
# Gemini 4 Neon (or another Gemini) billed to your Google Cloud project, with no API key.
#
#   GOOGLE_CLOUD_PROJECT=my-project GOOGLE_CLOUD_LOCATION=global scripts/setup-pi-vertex.sh
#
# Both variables can also come from lofiwave's .env. pi authenticates with Application Default Credentials
# (`gcloud auth application-default login`). The script adds google-vertex/$PI_VERTEX_MODEL (default gemini-4-neon) to
# ~/.pi/agent/models.json (or $PI_CODING_AGENT_DIR), since pi's catalog may not list it yet, and makes it pi's default
# model in settings.json. Other providers and settings in those files are kept. pi runs need both variables in their
# environment: put them in lofiwave's .env, or in the pi type's env (Types), which also reaches a tmux server started
# before the change.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT (the Google Cloud project with Vertex AI enabled)}"
LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
MODEL="${PI_VERTEX_MODEL:-gemini-4-neon}"
DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$DIR"
command -v pi >/dev/null || echo "note: pi is not on PATH yet: bun add -g @earendil-works/pi-coding-agent" >&2
if command -v gcloud >/dev/null && ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "note: no working Application Default Credentials; run: gcloud auth application-default login" >&2
fi

DIR="$DIR" MODEL="$MODEL" bun -e '
const { DIR, MODEL } = process.env;
const fs = require("node:fs"), path = require("node:path");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`${f} is not valid JSON: ${e.message}`); } };
const write = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
const name = MODEL.replace(/^gemini-/, "Gemini ").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const mf = path.join(DIR, "models.json");
const m = read(mf);
m.providers ??= {};
const p = (m.providers["google-vertex"] ??= {});
p.models = (p.models ?? []).filter((x) => x.id !== MODEL);
// Limits as Gemini 4 Argon in pi`s catalog; cost (USD per million tokens) copied from it too, so treat it as an estimate.
p.models.push({ id: MODEL, name, reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } });
write(mf, m);
const sf = path.join(DIR, "settings.json");
const s = read(sf);
s.defaultProvider = "google-vertex";
s.defaultModel = MODEL;
write(sf, s);
console.log(`pi: google-vertex/${MODEL} in ${mf}; default model in ${sf}`);
'
echo "pi runs need GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION=$LOCATION in their environment."
