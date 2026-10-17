# syntax=docker/dockerfile:1.7

# Fenix 1.0.0 runtime image: Node 22 app with the telemetry dashboard (ui/dist),
# plus the agent toolchain (Claude Code, CodeGraph, semgrep in a Python venv).
# API keys are never baked into the image - they are injected at runtime only
# via Compose secrets / environment variables.
# All mutable state (telemetry, supervisor) lives in the /data volume,
# so the image itself is stateless and freely replaceable.

# Builder stage for the native optional dependency node-pty (FOC-783): it is
# compiled with node-gyp, which needs python3/make/g++ — the slim runtime has
# none of them, the full bookworm image has all three. Same npm command the
# runtime stage used (npm ci, all deps: devDeps include runtime tools).
FROM node:22-bookworm AS deps
WORKDIR /opt/fenix
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEGRAPH_VERSION=1.6.0
ARG SEMGREP_VERSION=1.172.0

# System deps: git/gh/curl for tooling (squads call `gh`), procps for `ps` (stability tests), tini as init, python3 for semgrep, tmux for the Supervisor session host (FOC-783), passwd for usermod/groupmod (FOC-803 uid match), sudo for the child-spawn helper (FOC-802), util-linux for setpriv (FOC-802 — present in Debian's required set, kept explicit) — not in bookworm-slim.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates curl tini procps tmux passwd sudo util-linux python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*

# Python tools (semgrep, uv) in an isolated venv, on PATH ahead of system python.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" uv
ENV PATH=/opt/venv/bin:$PATH

# Global npm tools used by the agents.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" && npm cache clean --force

# Runtime dependencies for Thoughtmap and the local task-map projection.
COPY docker/requirements-task-workspace.txt /tmp/task-workspace-requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/task-workspace-requirements.txt

# App owned by `node` from the start, so no `chown -R` layer is needed
# (a chown -R would copy the whole tree into a new layer).
RUN mkdir -p /opt/fenix /data && chown node:node /opt/fenix /data

# FOC-803: build the image for the host user's uid/gid (default: the image's
# node user, 1000:1000). On a Linux host with another uid the bind-mounted host
# files (.fenix/secrets, .fenix/config at /fenix-config) would otherwise be
# unreadable/unwritable inside the container. Kept as late as possible so a
# different uid only rebuilds from here — but it must run BEFORE the
# COPY --chown=node:node steps below, which resolve `node` against /etc/passwd.
ARG FENIX_UID=1000
ARG FENIX_GID=1000
RUN if [ "${FENIX_UID}:${FENIX_GID}" != "$(id -u node):$(id -g node)" ]; then \
      if [ "$FENIX_UID" = "0" ]; then \
        echo "FENIX_UID=0 refused — Fenix never runs as root; run ./fenix as your normal user" >&2; \
        exit 1; \
      fi; \
      if [ "$FENIX_GID" = "0" ]; then \
        echo "FENIX_GID=0 refused — Fenix never runs as root; run ./fenix as your normal user" >&2; \
        exit 1; \
      fi; \
      groupmod -o -g "$FENIX_GID" node \
      && usermod -o -u "$FENIX_UID" -g "$FENIX_GID" node \
      && chown -R node:node /home/node /opt/fenix /data; \
    fi

# FOC-802: an unprivileged child identity so spawned agents do not run as the
# Supervisor's user. `fenix` is the shared group: children and the Supervisor
# (node joins as a supplementary member) cooperate through setgid + g+rwX on
# the shared /data trees only. Group `fenix` gets gid $FENIX_GID when that gid
# is free — normally it is NOT, because FOC-803 already gave it to node's
# primary group, so groupadd assigns the next free gid; that is fine, nothing
# keys on the fenix gid itself. Children keep a supplementary-group-free
# identity of their own.
ARG FENIX_CHILD_UID
RUN set -eu; \
    CHILD_UID="${FENIX_CHILD_UID:-$((FENIX_UID + 1000))}"; \
    if [ "$CHILD_UID" = "0" ] || [ "$CHILD_UID" = "$FENIX_UID" ]; then \
      echo "FENIX_CHILD_UID=$CHILD_UID refused — the child uid must differ from node's and never be root" >&2; \
      exit 1; \
    fi; \
    if getent passwd "$CHILD_UID" >/dev/null; then \
      echo "FENIX_CHILD_UID=$CHILD_UID is already taken by $(getent passwd "$CHILD_UID" | cut -d: -f1)" >&2; \
      exit 1; \
    fi; \
    if ! getent group fenix >/dev/null; then \
      if getent group "$FENIX_GID" >/dev/null; then \
        groupadd fenix; \
      else \
        groupadd -g "$FENIX_GID" fenix; \
      fi; \
    fi; \
    useradd -u "$CHILD_UID" -g fenix -d /home/fenix-child -m -s /usr/sbin/nologin fenix-child \
    && chmod 0700 /home/fenix-child \
    && usermod -aG fenix node \
    && printf '[safe]\n\tdirectory = *\n' > /home/fenix-child/.gitconfig \
    && chown fenix-child:fenix /home/fenix-child/.gitconfig
# The child commits through gitdirs inside the node-owned main clones
# (.git/worktrees/<name>), so git's dubious-ownership check needs the child's
# own global safe.directory; the handover already scopes what it may touch.
# Children run `claude` with CLAUDE_CONFIG_DIR pointing at their launch dir on
# the volume, so `.claude.json` is created inside that config dir by the first
# run (same as the Supervisor's squads) — nothing to pre-create in the child
# HOME (see entrypoint.sh init_claude_configs, which is a CLI call, not a copy).

# FOC-802: the single privileged path. Installed AFTER the `chown -R` above so
# the helper and the sudoers drop-in are never node-writable; the sudoers file
# is syntax-checked at build time (visudo -cf) so a typo cannot break boot.
COPY docker/fenix-spawn-as-child.sh /usr/local/sbin/fenix-spawn-as-child
COPY docker/sudoers-fenix-child /etc/sudoers.d/fenix-child
RUN chown root:root /usr/local/sbin/fenix-spawn-as-child /etc/sudoers.d/fenix-child \
    && chmod 0755 /usr/local/sbin/fenix-spawn-as-child \
    && chmod 0440 /etc/sudoers.d/fenix-child \
    && visudo -cf /etc/sudoers.d/fenix-child

WORKDIR /opt/fenix
USER node

# Dependencies from the builder stage above (node-pty arrives compiled — the
# runtime stage has no toolchain). Fail the build if it does not load.
COPY --from=deps --chown=node:node /opt/fenix/node_modules ./node_modules
RUN node -e "require('node-pty')"
COPY --chown=node:node ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci

# Full source, then build the dashboard; drop build-time node_modules, keep ui/dist.
COPY --chown=node:node . .
RUN cd ui && npm run build && rm -rf node_modules && chmod +x /opt/fenix/docker/entrypoint.sh

ENV LA_ROOT=/opt/fenix \
    LA_TELEMETRY_HOME=/data/telemetry \
    LA_STATE_ROOT=/data/state \
    LA_SUPERVISOR_STATE_HOME=/data/state/supervisor \
    LA_DATA_HOME=/data \
    LA_SQUAD_HOME=/data/agents \
    GITHUB_ROOT=/data/workspaces \
    LA_WORKTREE_HOME=/data/workspaces/la-wt \
    TELEMETRY_HOST=0.0.0.0 \
    TELEMETRY_PORT=7331 \
    FENIX_IN_CONTAINER=1

EXPOSE 7331

VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD node -e "fetch('http://127.0.0.1:7331/api/telemetry/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/fenix/docker/entrypoint.sh"]
CMD ["api"]

LABEL org.opencontainers.image.title="fenix" \
      org.opencontainers.image.source="https://github.com/joint-hubs/linear-agents" \
      org.opencontainers.image.version="1.0.0-dev"