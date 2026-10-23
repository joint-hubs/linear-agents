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
# FOC-1000: the oldest gh the image accepts — scripts/fenix-doctor.mjs
# GH_MIN_VERSION is the same number (a test pins the pair).
ARG GH_MIN_VERSION=2.89.0

# System deps: git/curl for tooling, procps for `ps` (stability tests), tini as init, python3 for semgrep, tmux for the Supervisor session host (FOC-783), passwd for usermod/groupmod (FOC-803 uid match), sudo for the child-spawn helper (FOC-802), util-linux for setpriv (FOC-802 — present in Debian's required set, kept explicit) — not in bookworm-slim.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tini procps tmux passwd sudo util-linux python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*

# FOC-1000: gh (squads call it) comes from GitHub's own apt repo, verified by
# its signed keyring, not from Debian. Bookworm's package is 2.23: its
# `gh pr edit` queries the sunset Projects (classic) GraphQL API and fails on
# every PR, so fenix-github pr_edit never worked in the image. The repo carries
# only its current release, so the version cannot be pinned in apt; the floor is
# checked right after the install (the build fails if Debian's gh slipped in)
# and again by `fenix doctor` at run time.
RUN apt-get update \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && gh_version="$(gh --version | sed -n '1s/^gh version \([0-9][0-9.]*\).*/\1/p')" \
    && echo "gh ${gh_version} (floor ${GH_MIN_VERSION})" \
    && dpkg --compare-versions "${gh_version}" ge "${GH_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

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
COPY docker/set-uid.sh /usr/local/sbin/fenix-set-uid
ARG FENIX_UID=1000
ARG FENIX_GID=1000
ARG FENIX_CHILD_UID

# FOC-802: an unprivileged child identity so spawned agents do not run as the
# Supervisor's user. `fenix` is the shared group: children and the Supervisor
# (node joins as a supplementary member) cooperate through setgid + g+rwX on
# the shared /data trees only. Group `fenix` gets gid $FENIX_GID when that gid
# is free — normally it is NOT, because FOC-803 already gave it to node's
# primary group, so groupadd assigns the next free gid; that is fine, nothing
# keys on the fenix gid itself. Children keep a supplementary-group-free
# identity of their own.
RUN sh /usr/local/sbin/fenix-set-uid
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
# FOC-808: the root-side child sweep (same trust path, same rules as above).
COPY docker/fenix-child-sweep.sh /usr/local/sbin/fenix-child-sweep
# FOC-980: the transcript share, run as the child user — the transcripts are
# fenix-child-owned and the owner may chmod its own files, so root rights are
# neither needed nor granted (root-owned 0755: the child must not edit it).
COPY docker/fenix-child-share.sh /usr/local/sbin/fenix-child-share
COPY docker/sudoers-fenix-child /etc/sudoers.d/fenix-child
RUN chown root:root /usr/local/sbin/fenix-spawn-as-child /usr/local/sbin/fenix-child-sweep /usr/local/sbin/fenix-child-share /etc/sudoers.d/fenix-child \
    && chmod 0755 /usr/local/sbin/fenix-spawn-as-child /usr/local/sbin/fenix-child-sweep /usr/local/sbin/fenix-child-share \
    && chmod 0440 /etc/sudoers.d/fenix-child \
    && visudo -cf /etc/sudoers.d/fenix-child

# FOC-808: the cache volume (compose `fenix-cache` at /home/node/.cache) takes
# this directory's ownership when Docker creates the volume on first mount —
# the entrypoint runs as node and cannot repair a root-owned mount point.
# node:fenix + setgid so the Supervisor, its squads and the children (group
# fenix) share it; the per-tool subdirs match the ENV block below.
RUN mkdir -p /home/node/.cache/npm /home/node/.cache/pip /home/node/.cache/uv /home/node/.cache/ms-playwright \
    && chown -R node:fenix /home/node/.cache \
    && chmod 2775 /home/node/.cache /home/node/.cache/npm /home/node/.cache/pip /home/node/.cache/uv /home/node/.cache/ms-playwright

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

# FOC-988: a manifest of SHA-256 sums of this image's own code, for the drift
# check in `fenix doctor` (scripts/fenix-manifest.mjs). The Supervisor patched
# /opt/fenix four times on the FOC-789 run; the tree stays writable by design
# (Edit/Write are denied and the Bash guard asks), so the evidence is kept where
# the runtime user cannot rewrite it: root-owned, outside /opt/fenix, read-only.
# It hashes content only, so the uid layer (docker/Dockerfile.uid) leaves it valid.
USER root
RUN mkdir -p /usr/local/share/fenix \
    && node /opt/fenix/scripts/fenix-manifest.mjs write --root /opt/fenix --out /usr/local/share/fenix/manifest.json \
    && chmod 0444 /usr/local/share/fenix/manifest.json
USER node

# FOC-808: package caches live on the fenix-cache volume (/home/node/.cache,
# mounted by compose) so they survive `fenix update` instead of sitting in the
# container layer. entrypoint.sh creates the subdirs; `fenix prune` sizes and
# prunes them.
ENV LA_ROOT=/opt/fenix \
    XDG_CACHE_HOME=/home/node/.cache \
    npm_config_cache=/home/node/.cache/npm \
    PIP_CACHE_DIR=/home/node/.cache/pip \
    UV_CACHE_DIR=/home/node/.cache/uv \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
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