# ADR-0005: Dummy UI deployability proof — stack, transport, healthcheck

**Status:** Proposed

**Date:** 2026-06-30

## Context

The PLAN squad's first pilot epic is **not a product** — it is a **deployability proof**: build a
minimal containerized app, ship it to an on-prem server, run it, and verify `/health` returns 200
end-to-end. The goal is to validate the deploy path empirically before any real product goes
through it, and to surface unknowns about the on-prem environment (no `docs/ACCESS.md` exists;
SSH-only access; no root; unclear whether Docker requires `sudo`; unclear whether a reverse-proxy
is present; unclear whether the app port is reachable from outside the server).

Three non-trivial architectural decisions were left open by the discovery brief and resolved at
GATE 1 (Mateusz, 2026-06-30): (A) the application stack, (B) the image transport mechanism, and
(C) the healthcheck contract under orchestration. This ADR records the rationale so that the
**second, real deploy** can either reuse the decisions consciously or overturn them with full
context rather than by accident.

Relevant inputs:
- Discovery brief: `planning/briefs/discovery-dummy-ui.md` (section "✅ Decyzje GATE 1").
- Spec: `planning/briefs/spec-dummy-ui.md`.
- Existing ADRs 0001–0004 are unrelated (provider routing, subagent models, RAG pipeline).

## Decision

### A. Stack: Node.js stdlib (`node:alpine` + built-in `http`, zero external dependencies)

The dummy app is a single `server.js` file using Node's built-in `http` module. No `package.json`
dependencies, no Express, no framework. Base image: `node:22-alpine` (tagged, floating — the tag
follows the latest `22-alpine` build; pinning to a sha256 digest is deferred to the second, real
deploy when reproducibility matters more than freshness).

Rationale:
- **Zero deps ⇒ no `npm install` step ⇒ faster, hermetic builds.** The Dockerfile copies one file.
- **Small image.** `node:alpine` is ~180 MB; Python `slim` is comparable but the Python
  `http.server` module has weaker ergonomics for the `{"status":"ok"}` JSON contract and 404
  handling (it serves files from CWD by default, which is the wrong default for a health endpoint).
- **Forward-compat with real backends.** The next real deploy is likely Node-based (matches the
  squad's existing tooling). Reusing the same base image and transport pattern reduces
  second-deploy friction.
- **`wget` available in alpine by default** for the Compose healthcheck — no `apk add curl`
  needed, keeping the image lean.

### B. Image transport: tarball of sources + `scp` + `docker build` on-prem (NOT `save|load`, NOT registry)

The application image is **built on the on-prem server itself**. The flow:
1. `tar -czf` the `apps/dummy-ui/` directory (sources + Dockerfile + compose file) on the laptop.
2. `scp` the tarball to the server's `/tmp/`.
3. `tar -xzf` into `~/dummy-ui/` on the server.
4. `docker compose build` on the server (Compose's `build: .` directive).
5. `docker compose up -d`.

Rationale:
- **No registry needed.** On-prem may have no internet egress to a registry; a private registry
  is unjustified overhead for a pilot.
- **No `docker save | ssh docker load`.** That path ships a built image. It works but: (a) images
  are larger than the source tarball for any non-trivial app (here the source is <5 KB); (b) it
  requires `docker load` permissions which may interact with the `sudo`-docker uncertainty;
  (c) it bakes the laptop's architecture into the image (acceptable per GATE 1.7 — same arch —
  but brittle for the second deploy if arch diverges).
- **Remote build is the simplest happy path** and reuses the same `Dockerfile` that the local
  smoke test uses (single source of truth). If the local build succeeds, the remote build will
  succeed given the same base image availability.
- **Re-evaluation trigger:** when a real app image exceeds ~200 MB, source-tarball + remote build
  remains fine (sources are still small), but if the **build itself** becomes expensive (compilation,
  multi-stage with large intermediate layers), revisit `save|load` or a registry. Recorded in the
  spec §10 and §14.

### C. Healthcheck contract: `GET /health` → HTTP 200 + body `{"status":"ok"}`, wired into Compose

The `/health` endpoint returns exactly `{"status":"ok"}` with `Content-Type: application/json`.
Compose `healthcheck` calls `wget -qO- http://127.0.0.1:8973/health` with `interval=30s,
timeout=3s, start_period=5s, retries=3`. The same `HEALTHCHECK` directive is mirrored in the
Dockerfile (belt and suspenders; Compose is the source of truth for `docker compose ps`).

Rationale:
- **Body, not just status.** A bare 200 is too shallow — a deadlocked event loop can still answer
  TCP. Requiring a body forces the server to actually respond. `wget -qO-` fails on empty/short
  bodies, giving a stricter signal than `wget --spider`.
- **`wget` over `curl`.** Alpine ships `wget` by default; `curl` requires `apk add curl`, bloating
  the image by ~5 MB for no benefit at this scale.
- **Compose-level healthcheck is the orchestrator's view.** `docker compose ps` and
  `docker inspect .State.Health.Status` surface this directly — no external probe needed for MVP.
- **Forward-compat:** adding fields (`version`, `uptime`) later is non-breaking; changing `status`
  to a non-`"ok"` value on failure is the reserved extension path for real liveness vs readiness
  split (out of MVP).

## Consequences

- **Positive:**
  - Single source of truth for the deploy recipe (README + spec §8). The second deploy follows
    the same pattern.
  - No external dependencies on the app — `npm install` cannot break the build.
  - `docs/ACCESS.md` becomes a forced deliverable, closing the discovery-brief risk #1 (unknown
    server) by surfacing unknowns during first deploy rather than during an incident.
  - Healthcheck gives `docker compose ps` a meaningful `healthy` status — restart policy
    (`unless-stopped`) + healthcheck together form the minimum self-healing surface.
- **Negative:**
  - `sudo`-docker uncertainty is not resolved up front — the deploy procedure must carry both
    paths (`docker ...` and `sudo docker ...`) with a discovery step. This is acceptable for a
    pilot but would be intolerable for a repeated real deploy (fix at the second-deploy gate:
    add user to `docker` group or commit to `sudo`).
  - Remote build requires the base image (`node:22-alpine`) to be available on-prem. If the
    server has no internet, a one-time `docker save | ssh sudo docker load` of the **base image**
    is needed (spec §9 S16) — this is a base-image bootstrap, not the app-transport mechanism.
  - Plain HTTP on a high port means no TLS, no domain — fine for a proof, not for anything
    user-facing.
- **Risks:**
  - If the on-prem arch diverges from the laptop (GATE 1.7 assumed same arch), the remote build
    will still succeed (Dockerfile is arch-agnostic; `node:22-alpine` is multi-arch) — so this
    risk is actually **lower** under remote-build than under `save|load`. Recorded for honesty.
  - Port 8973 may collide on the host; mitigated by `HOST_PORT` env override (spec §4, §8.5).
  - Restart policy `unless-stopped` survives daemon restart but **not host reboot** unless the
    Docker service is enabled. Out of MVP; noted in spec §14.

## Alternatives Considered

### A. Stack

1. **Python `http.server` on `python:3-slim`** — Rejected. `http.server` serves files from CWD
   by default; `/health` would require a custom `BaseHTTPRequestHandler` subclass, which is more
   code than Node's `http` for the same result. Image size comparable, but the squad's next
   deploys are Node-leaning, so Node reuses base-image cache.
2. **Express on Node** — Rejected. Adds a dependency, a `package.json`, an `npm install` layer,
   and a lockfile — all unnecessary for two endpoints. Violates "zero deps" goal.

### B. Transport

1. **`docker save | ssh docker load`** — Rejected for the app image. Larger payload than sources;
   bakes laptop-arch into image (under GATE 1.7 assumption this is fine, but brittle for the
   second deploy); requires `docker load` permission which interacts badly with `sudo`-docker
   uncertainty. Retained as a fallback for the **base image** only when on-prem has no internet.
2. **Private registry on the on-prem server** — Rejected. Operational overhead (TLS, auth,
   storage, garbage collection) unjustified for a pilot. Re-evaluate at the second real deploy
   if deploy frequency rises.
3. **Remote registry (GHCR / Docker Hub)** — Rejected. Requires internet egress from on-prem,
   which is unclear; also requires credentials management. Out of MVP scope.
4. **`git clone` + build on-prem** — Partially viable (sources are in git), but the repo contains
   much more than the app (`agents/`, `scripts/`, `docs/`) — cloning the whole repo to deploy one
   app is wasteful and couples deploy to repo access. Tarball is a cleaner boundary. Re-evaluate
   if the app grows to need its own repo.

### C. Healthcheck contract

1. **Bare `200 OK` with empty body, `wget --spider`** — Rejected. Too shallow; a half-dead
   process that still binds the port but cannot respond would pass.
2. **TCP-only healthcheck (`CMD-SHELL`, `nc -z localhost 8973`)** — Rejected. Same shallowness
   problem; also `nc` is not in alpine default.
3. **External probe from the laptop over VPN** — Rejected as primary. GATE 1.6 marks remote curl
   as `transcript-uncertain` (VPN may block it). Primary validation is localhost curl via SSH;
   the Compose healthcheck is the in-process equivalent of that.
4. **No healthcheck (rely on `restart: unless-stopped` only)** — Rejected. Restart policy reacts
   to process exit, not to deadlock; a wedged process that doesn't exit would not restart.
   Healthcheck gives `docker compose ps` a meaningful column and is the forward-compat path to
   real orchestration (k3s probes, etc.).
