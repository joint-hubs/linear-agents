# Fenix quick start (Docker)

Fenix runs as two Docker containers: `fenix-api` (dashboard + telemetry API)
and `fenix-supervisor` (the Supervisor, idle until you attach to it).
Everything needed at runtime is inside the image `fenix:dev` (~2 GB on disk):
Node 22, git, Claude Code 2.1.296, CodeGraph 1.6.0, semgrep 1.172.0, uv,
Python 3.11. The container runs as the non-root user `node`.

## What you get

- A dashboard at http://localhost:4600 — telemetry, runs, prompts, configuration.
- The telemetry API on the same port, published on the host's 127.0.0.1 only.
- The Supervisor (Claude Code) running in the `fenix-supervisor` container;
  `fenix attach` starts a session with it. Supervisor chat in the dashboard is
  not yet in 1.0 (FOC-783) — until then `fenix attach` is the way to talk to it.
- The API keys stay on the host in `.fenix/secrets/` and are mounted into the
  containers as Compose secrets — never baked into the image, never printed.
- All mutable state (telemetry, Supervisor state, workspaces) lives in the
  `fenix_fenix-data` volume, so the image itself is stateless and replaceable.

Status (1.0.0 in progress): the stack, keys and diagnostics work end to end.
Pointing the Supervisor at your own repositories (cloned into
`/data/workspaces`) and resuming its session after a restart arrive with
FOC-776; until then `fenix attach` opens the Supervisor in the image's own
checkout.

## Before you start

Host prerequisites:

- Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux)
- Docker memory >= 4 GB (Docker Desktop: Settings > Resources)
- >= 10 GB free disk
- git
- curl (used to validate keys live)
- Windows only: Git for Windows — the `fenix.cmd` / `fenix.ps1` shims run the
  `fenix` script with Git Bash. WSL users run `./fenix` inside WSL instead.

Keys (the wizard asks once, validates each key live, and stores it owner-only
under `.fenix/secrets/`):

| Key | Where to get it |
|---|---|
| OpenRouter API key | https://openrouter.ai/settings/keys |
| Linear personal API key | Linear: Settings > Security & access > Personal API keys |
| GitHub fine-grained token | GitHub: Settings > Developer settings > Fine-grained tokens; grant the repositories Fenix works on Contents and Pull requests (read and write) |
| Linear team key | the team's key, e.g. `FOC` |

The wizard validates each key against its provider (OpenRouter `/api/v1/key`,
Linear `viewer` query, GitHub `/user`), so a wrong or mistyped key is caught
at entry time, not at first use.

## Start

```bash
git clone https://github.com/joint-hubs/linear-agents.git
cd linear-agents
./fenix up
```

Windows: `fenix up` in cmd, `.\fenix.cmd up` in PowerShell.

What `fenix up` does:

1. Preflight: docker on PATH, daemon running, compose available, free disk
   >= 10 GB, Docker memory >= 4 GB (memory below 4 GB is a warning, not a stop).
2. Key wizard, if any key file is missing or empty: hidden input, each key
   validated live, max 3 tries per key. Then it asks for the Linear team key,
   saved as `LINEAR_TEAM_KEY` in `.fenix/fenix.env`.
3. `docker compose up -d --build` — the first build takes several minutes;
   later runs reuse the layers and start in seconds.
4. Waits up to 180 s for `fenix-api` to become healthy.
5. Prints and opens http://localhost:4600.

## Daily use

| Command | What it does |
|---|---|
| `fenix up` | preflight, keys if needed, build and start the stack |
| `fenix stop` | stop the stack |
| `fenix down` | stop and remove containers (the data volume is kept) |
| `fenix logs [service]` | follow logs (default: all services) |
| `fenix doctor` | host preflight plus in-container diagnostics |
| `fenix keys` | key wizard: enter or replace keys |
| `fenix attach` | start the Supervisor (Claude Code) in `fenix-supervisor` |
| `fenix shell [service]` | shell in a service (default: `fenix-supervisor`) |
| `fenix update` | `git pull --ff-only`, rebuild with fresh base images, restart |

`fenix attach` runs Claude Code inside `fenix-supervisor` in your terminal —
exit the session and you are back on the host; the container keeps idling.
`fenix down` removes the containers but keeps the data volume, so telemetry
and Supervisor state survive a recreate; a later `fenix up` reattaches them.

## Where things live

- Keys: `.fenix/secrets/{openrouter_api_key,linear_api_key,github_token}` —
  gitignored, owner-only, never baked into the image, never printed; mounted
  as Compose secrets under `/run/secrets/`.
- Config: `.fenix/fenix.env` (contains `LINEAR_TEAM_KEY`).
- Data volume `fenix_fenix-data`, mounted at `/data` in both containers:
  - telemetry DB: `/data/telemetry/telemetry.sqlite`
  - Supervisor state: `/data/state/supervisor`
  - workspaces: `/data/workspaces`
- Logs and transcripts are kept by default (retention is configurable later,
  FOC-780).

## Troubleshooting

Exit codes of `fenix`:

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | — |
| 2 | usage error; on Windows also: no Git Bash found | check the command; install Git for Windows |
| 3 | preflight failed | fix the check it printed, run `fenix doctor` |
| 4 | fenix-api not healthy after 180 s | `fenix logs fenix-api` |
| 5 | a key was rejected 3 times | check the key and its scopes, run `fenix keys` |

`fenix doctor` prints one line per check, in the format
`OK|WARN|FAIL <check> — <detail> — fix: <hint>`, and exits 1 if any check fails.

Common cases:

- **Port 4600 busy** — pick another host port: `FENIX_PORT=4601 ./fenix up`
  (Windows: set `FENIX_PORT` in the environment before running `fenix.cmd`).
- **Windows: `execvpe(/bin/bash) failed`** — the WSL bash was used instead of
  Git Bash. Install Git for Windows and use `fenix.cmd`.
- **Docker Desktop not running** — start it, wait until it is running, then
  `fenix doctor`.
- **First build seems to hang** — it downloads the base image and installs
  npm and Python dependencies; several minutes on the first run is normal.
  `fenix logs fenix-api` shows the current state once the containers start.
- **Key rejected at entry** — HTTP 401 usually means a wrong key, HTTP 403 a
  missing scope. Fix the key (or its scopes) and re-enter it, or run
  `fenix keys` later.
- **Key rotation** — `fenix keys`, then `fenix stop` and `fenix up` (secrets
  are read at container start).

## Upgrade

```bash
./fenix update
```

Runs `git pull --ff-only`, rebuilds the image with fresh base images
(`docker compose build --pull`) and restarts the stack. Keys and the data
volume are untouched.

## Uninstall

```bash
./fenix down                 # stop and remove containers (the volume is kept)
docker image rm fenix:dev    # remove the image (~2 GB)
# optional, irreversible (telemetry, state, transcripts):
docker volume rm fenix_fenix-data
```

The `.fenix/` directory with your keys and config stays in the repo checkout;
delete it separately if you want the keys gone from disk.
