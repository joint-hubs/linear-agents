# syntax=docker/dockerfile:1.7

# Fenix 1.0.0 runtime image: Node 22 app with the telemetry dashboard (ui/dist),
# plus the agent toolchain (Claude Code, CodeGraph, semgrep in a Python venv).
# API keys are never baked into the image - they are injected at runtime only
# via Compose secrets / environment variables.
# All mutable state (telemetry, supervisor) lives in the /data volume,
# so the image itself is stateless and freely replaceable.

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEGRAPH_VERSION=1.6.0
ARG SEMGREP_VERSION=1.172.0

# System deps: git/curl for tooling, tini as init, python3 for semgrep.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tini python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*

# Python tools (semgrep, uv) in an isolated venv, on PATH ahead of system python.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" uv
ENV PATH=/opt/venv/bin:$PATH

# Global npm tools used by the agents.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" && npm cache clean --force

# App owned by `node` from the start, so no `chown -R` layer is needed
# (a chown -R would copy the whole tree into a new layer).
RUN mkdir -p /opt/fenix /data && chown node:node /opt/fenix /data
WORKDIR /opt/fenix
USER node

# Layer-cached dependency install (all deps: devDeps include runtime tools).
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci

# Full source, then build the dashboard; drop build-time node_modules, keep ui/dist.
COPY --chown=node:node . .
RUN cd ui && npm run build && rm -rf node_modules && chmod +x /opt/fenix/docker/entrypoint.sh

ENV LA_ROOT=/opt/fenix \
    LA_TELEMETRY_HOME=/data/telemetry \
    LA_SUPERVISOR_STATE_HOME=/data/state/supervisor \
    TELEMETRY_HOST=0.0.0.0 \
    TELEMETRY_PORT=7331 \
    LA_PROVIDER=openrouter \
    FENIX_IN_CONTAINER=1

EXPOSE 7331

VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD node -e "fetch('http://127.0.0.1:7331/api/telemetry/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/fenix/docker/entrypoint.sh"]
CMD ["api"]

LABEL org.opencontainers.image.title="fenix" \
      org.opencontainers.image.source="https://github.com/joint-hubs/linear-agents" \
      org.opencontainers.image.version="1.0.0-dev"