#!/usr/bin/env bash
# Claude Code SessionStart / SessionEnd hook.
# When the Claude process descends from an agent-console run (the console puts AGENT_CONSOLE_RUN_ID,
# AGENT_CONSOLE_URL and AGENT_CONSOLE_TOKEN in the environment), report the session id back so the run
# is linked to its transcript. For every other Claude session this exits immediately and does nothing.
#
# Install (global, ~/.claude/settings.json):
#   "hooks": { "SessionStart": [{"hooks":[{"type":"command","command":"<abs path>/scripts/claude-session-hook.sh","timeout":5}]}],
#              "SessionEnd":   [{"hooks":[{"type":"command","command":"<abs path>/scripts/claude-session-hook.sh","timeout":5}]}] }
[ -n "${AGENT_CONSOLE_RUN_ID:-}" ] && [ -n "${AGENT_CONSOLE_URL:-}" ] || exit 0
BUN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || exit 0
exec "$BUN" "$(cd "$(dirname "$0")" && pwd)/claude-session-hook.ts"
