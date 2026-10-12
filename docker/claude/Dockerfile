# Claude Code for a lofiwave cloud-run target: `claude` on PATH, plus git and the tools the transcript hand-back uses
# (sh, find, base64, fold, awk, gzip, sha256sum: coreutils/findutils/gawk in Debian).
#
#   gcloud builds submit docker/claude --tag <region>-docker.pkg.dev/<project>/<repo>/claude:latest
#
# Pass the API key as a target secret (ANTHROPIC_API_KEY=<secret name>). It runs as a normal user: claude refuses
# --dangerously-skip-permissions as root, and an agent has no reason to be root anyway.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client gawk \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

RUN useradd --create-home --shell /bin/bash agent \
 && mkdir /workspace && chown agent:agent /workspace
USER agent
WORKDIR /workspace
ENV HOME=/home/agent DISABLE_AUTOUPDATER=1

CMD ["claude", "--version"]
