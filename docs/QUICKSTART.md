# Fenix quick start (Docker)

Fenix runs as two Docker containers: `fenix-api` (dashboard + telemetry API)
and `fenix-supervisor` (the Supervisor, running permanently in a tmux session
inside the container).
Everything needed at runtime is inside the image `fenix:dev` (~2 GB on disk):
Node 22, git, Claude Code 2.1.296, CodeGraph 1.6.0, semgrep 1.172.0, uv,
Python 3.11. The container runs as the non-root user `node`.
Children spawned by the Supervisor run as a separate user (`fenix-child`) inside the container, so
they cannot touch the Supervisor's settings, token or tmux socket; `FENIX_CHILD_ISOLATION=off` in
the compose environment turns it off (debugging only).

## What you get

- A dashboard at http://localhost:4600 — the home page is the **Cockpit**
  (FOC-783): the Supervisor panel with **Chat** (default) and **Terminal** on
  the same tmux session, the Needs-you inbox (pending gates, approvals, holds,
  problems) and the live children. Chat refuses slash commands (send them
  through the Terminal) and refuses while the Supervisor shows a dialog —
  answer the dialog in the Terminal. Chat and Terminal are Docker-only;
  natively (without Docker) the Cockpit shows the inbox and children only.
- The telemetry API on the same port, published on the host's 127.0.0.1 only.
- The Supervisor (Claude Code) running permanently in the `fenix-supervisor`
  container; `fenix attach` attaches to it, Ctrl-b d detaches — it keeps
  running.
- The API keys stay on the host in `.fenix/secrets/` and are mounted into the
  containers as Compose secrets — never baked into the image, never printed.
- A **Settings** area in the dashboard: validate and rotate keys, switch the
  provider and per-squad routing, add repositories, inspect retention — its
  overlay (`.fenix/config/settings.json`) survives `fenix update`. See
  "Settings" below.
- All mutable state (telemetry, Supervisor state, workspaces) lives in the
  `fenix_fenix-data` volume, so the image itself is stateless and replaceable.

Status (1.0.0): the Supervisor works in the container end to end — it clones
your repositories (`fenix repo add`), resumes its session after a restart, and
transcripts survive `fenix down` and `fenix update` (they are on the data
volume). If the supervisor container stops mid-turn, the interrupted child is
marked `crashed` (reason `container-restart`) on the next start, so the
Supervisor can resume it with a follow-up. CodeGraph MCP is approved for every
squad on the volume. The Supervisor chat and terminal in the dashboard (the
Cockpit) work in Docker. Known gap: the v1 SquadConfig screen edits repo files
inside the image, which do not survive `fenix update` — provider, routing and
keys now live in the Settings overlay instead, which does (see "Settings").

## Before you start

Host prerequisites:

- Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux)
- Docker memory >= 4 GB (Docker Desktop: Settings > Resources)
- >= 10 GB free disk
- git
- (curl is no longer needed: key validation runs inside the `fenix-api`
  image through `scripts/key-check.mjs`)
- Windows only: Git for Windows — the `fenix.cmd` / `fenix.ps1` shims run the
  `fenix` script with Git Bash. WSL users run `./fenix` inside WSL instead.

On Linux hosts, `./fenix` builds the image for your user's uid/gid
automatically (FOC-803), so the bind-mounted host files — `.fenix/secrets/`
and `.fenix/config/` — stay readable and writable inside the container. Run
`./fenix` as your normal user, not root: as root the container keeps uid 1000
and cannot read your keys. If your user (or uid) changes, rebuild once:
`./fenix up`.

A rebuild does not touch the `fenix_fenix-data` volume, though: it keeps the
uid it was first created with, so after a uid change `/data` stays unwritable
and the supervisor's health checks and the telemetry store fail. Re-own the
volume once:

```bash
docker run --rm -u 0 -v fenix_fenix-data:/data --entrypoint chown fenix:dev -R $(id -u):$(id -g) /data
```

`fenix doctor` names this fix on every failing `/data` check.

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
at entry time, not at first use. The checks are the shared
`scripts/key-check.mjs` run inside the `fenix-api` image — the key travels
only through stdin, never a command line, environment variable or log.

The wizard first asks for the **provider** (the configured ones plus
`custom` — your own Anthropic-compatible endpoint, with base URL, auth style
`token` (Bearer) or `apikey` (x-api-key) and a default model). OpenRouter
keeps its own key file; every other provider shares `provider_api_key`. The
choice is saved in the settings overlay `.fenix/config/settings.json` (see
"Where things live"), not in the image.

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

## Your repositories

The Supervisor works from `/data/workspaces` inside the container. Clone a
repository with:

```bash
./fenix repo add your-org/your-repo --project "Your Linear project"
```

`repo add` accepts a full git URL or `owner/name` (short for
`https://github.com/owner/name.git`) and clones it into the workspaces volume
(`/data/workspaces/<name>`) inside the container. Git authenticates to GitHub
with `GITHUB_TOKEN` from memory through a credential helper — the token is
never written to disk — so a private repository needs a token that has access
to it. With `--project` it also writes an entry into the project map (below).
If the repository is already cloned, `repo add` exits with code 3.

`./fenix repo list` prints every cloned repository (name, branch, origin) and
the project map.

The project map lives on the host at `.fenix/config/projects.json` (the
directory is mounted into the containers at `/fenix-config`; `fenix up` creates
it) and wins over the repository's own `config/projects.json`. The Supervisor
maps a Linear issue's project to a repository through it:

```json
{
  "projects": [
    {
      "linearProject": "Your Linear project",
      "workspace": "joi",
      "repo": "${GITHUB_ROOT}/your-repo",
      "deploy": { "type": "none" }
    }
  ]
}
```

`${GITHUB_ROOT}` is the workspaces root inside the container
(`/data/workspaces`).

## Settings (the dashboard)

The Settings area in the left navigation covers what used to require a
`fenix` command or an image rebuild, and its overlay survives `fenix update`:

- **Keys** (`/settings/keys`, the default tab): each key's presence and its
  last live check — never the value. Rotating a key runs the same live check
  as `fenix keys` first; a rejected key is refused with the reason and
  nothing is written. A rotated key is used by new children at once; the
  Supervisor picks it up on its next fresh session (`fenix attach --new`).
  Mounted key files are re-read for each child; an empty mounted file refuses
  the spawn even when the parent still holds an old key in memory.
- **Provider & routing** (`/settings/provider`): switch the active provider —
  OpenRouter, a configured one, or a custom Anthropic-compatible endpoint
  (base URL, auth style, default model) — with a live test before saving.
  The optional password field can supply the first key for a new provider;
  leave it empty to use the stored key. A refused validation changes nothing,
  and a failed settings save restores the previous key. Set the lead model
  per squad in the routing table. Model candidates come
  from the active provider's pricing scope; a model without a price row is
  allowed and labelled "unpriced". The benchmark column uses the recorded AA
  Intelligence Index snapshot in `config/model-benchmarks.json` (currently
  2026-09-03); unknown models and other provider scopes show a dash.
  A provider or routing change takes effect on the next spawn: each child
  resolves the current overlay and mounted key, while a resumed turn pins the
  provider name recorded at its first turn. An explicit `LA_PROVIDER` still
  wins; launcher-derived values do not mask later Settings changes. The v1
  SquadConfig screen stays as the "Advanced routing (v1)" tab (subagent
  roles, tools, pricing editor).
- **Repositories** (`/settings/repos`): repositories with origin, HEAD,
  branch, CodeGraph index state, worktree count and mapped Linear project;
  adding a repository by URL starts a background clone with progress (a local
  bare repo URL works for tests); removing a project mapping keeps the files.
- **Retention** (`/settings/retention`): the panel sets the policy — keep
  everything by default, or apply a limit to every squad's
  `cleanupPeriodDays` at once — and shows the transcript / telemetry /
  workspace disk usage, free disk and the prunable estimate. Nothing is
  deleted until `fenix retention prune` runs; the CLI still does the apply
  and prune: `fenix retention show|apply|prune [--dry-run]` (prune is
  refused while retention keeps everything).
- **Optional integrations** (FOC-772, no dashboard tab): Atlas, the second
  (pisi) Linear workspace and the personal memory index are **off by
  default** — a stock install has none of them. Turn one on with
  `fenix integrations enable <name>` (`atlas` | `pisi` | `memory`) or the
  overlay key `integrations`; plain `fenix integrations` shows what is on
  and what each enabled one still needs. Nebul is not a flag — it is chosen
  through the provider (see **Provider & routing** above).
- **Squads & prompts** is the v1 Prompts screen as a tab (`/prompts`): role
  edits land on the `/data/agents` volume and take effect at the next spawn.
- **Artifacts** (`/settings/artifacts`): the repo's generated artifacts (model
  map, UI build, atlas config, diagram PNGs, the CodeGraph index) with state,
  age and source revision; stale watched ones regenerate on start and within
  60 s natively — `node scripts/artifact-registry.mjs status` shows the same
  from the shell.

The API behind it lives under `/api/settings/*` — the same write guards as the
Cockpit, bodies capped at 8 KB, and no response ever carries a key value.

## Daily use

| Command | What it does |
|---|---|
| `fenix up` | preflight, keys if needed, build and start the stack |
| `fenix stop` | stop the stack |
| `fenix down` | stop and remove containers (the data volume is kept) |
| `fenix logs [service]` | follow logs (default: all services) |
| `fenix doctor` | host preflight plus in-container diagnostics |
| `fenix keys` | key wizard: provider choice, enter or replace keys (validated live in the container through `scripts/key-check.mjs`) |
| `fenix keys <openrouter\|provider\|linear\|github>` | rotate one key; `provider` means the active provider's key |
| `fenix repo add <url\|owner/name> [--project <Linear project>]` | clone a repository into the workspaces volume (optionally map a Linear project) |
| `fenix repo list` | repositories in the workspaces volume and the project map |
| `fenix attach [--new]` | attach to the Supervisor (Claude Code) running in tmux in `fenix-supervisor`; Ctrl-b d detaches and the Supervisor keeps running, `--new` starts a fresh session (kills the current one) |
| `fenix shell [service]` | shell in a service (default: `fenix-supervisor`) |
| `fenix update` | `git pull --ff-only`, rebuild with fresh base images, restart |
| `fenix test [pattern]` | lint and the test suite on Linux, inside the image, on a throwaway copy of this checkout (uncommitted changes included) — the same job CI runs on every PR |

The Supervisor runs permanently inside the container, in a tmux session.
`fenix attach` attaches your terminal to it — Ctrl-b d detaches and you are
back on the host while the Supervisor keeps running (the Cockpit's Chat and
Terminal stay with it). `fenix attach --new` kills the current session and
starts a fresh one — with a new run (its own children, gates and waker); a
resumed session or a container restart keeps the current run, recorded in
`/data/supervisor/current-run.json`. `fenix down` removes the containers but keeps the data
volume, so telemetry and Supervisor state survive a recreate; a later
`fenix up` reattaches them.

Outside Docker (native), standalone squads launch on any OS with
`node scripts/squad-start.mjs <plan|dev|review|test|cadence|supervisor>` — on
Windows `bin\<squad>.bat` is a thin wrapper for the same.

## Where things live

- Keys: `.fenix/secrets/{openrouter_api_key,provider_api_key,linear_api_key,github_token}` —
  gitignored, owner-only, never baked into the image, never printed; mounted
  as Compose secrets under `/run/secrets/` (read-only for the supervisor) and
  read-write into `fenix-api` at `/fenix-secrets` (dashboard key rotation).
- Settings overlay: `.fenix/config/settings.json` on the host (the
  `.fenix/config/` directory is mounted at `/fenix-config`) — the active
  provider (+ the custom provider's base URL, auth style, tiers, default
  model) and the per-squad lead models. Survives `fenix update`;
  `config/models.json` stays the shipped baseline. Never contains key values.
- Last key checks: `/data/settings/key-checks.json` on the data volume
  (timestamps and results only, no values).
- Config: `.fenix/fenix.env` (contains `LINEAR_TEAM_KEY`).
- Data volume `fenix_fenix-data`, mounted at `/data` in both containers:
  - telemetry DB: `/data/telemetry/telemetry.sqlite`
  - Supervisor state: `/data/state/supervisor`
  - squad config and transcripts: `/data/agents` — at every start the API
    container seeds squad config from the image with the dpkg rule: a file you
    never edited follows the image, a file you edited is kept
  - repositories: `/data/workspaces`; child worktrees:
    `/data/workspaces/la-wt/<repo>/<branch>`
- Project map: `.fenix/config/projects.json` on the host, mounted at
  `/fenix-config` (see "Your repositories").
- Logs and transcripts are kept by default: retention is asked once on the
  first `fenix up` (keeping everything is the default) and can be changed
  later in Settings → Retention or with `fenix retention`.

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
- **Key rotation** — Settings → Keys in the dashboard, or `fenix keys <name>`.
  A rotated key is used by new children at once and the Supervisor picks it up
  on its next fresh session. Use `fenix attach --new` when the Supervisor
  itself should adopt the new key; running children keep their existing turn.
- **`fenix up` exits 4 / the supervisor is unhealthy after your uid changed** —
  the image was rebuilt for the new uid, but the data volume still belongs to
  the old one, so `/data` stays unwritable. Re-own the volume once (see
  "Before you start"), then `./fenix up` again.
- **A config file has a `.fenix-new` twin** — you edited the file (e.g. in the
  dashboard prompt editor) and the image ships a new version of it too; the
  fresh image version was written next to your file. Merge the twin's changes
  into your file by hand, then delete the twin — while the image version
  differs from yours, it is written again on the next start.
- **`repo add` says the repository already exists** (exit 3) — it is already
  cloned into the workspaces volume; `fenix repo list` shows what is there.

## Upgrade

```bash
./fenix update
```

Runs `git pull --ff-only`, rebuilds the image with fresh base images
(`docker compose build --pull`) and restarts the stack. Keys and the data
volume are untouched; on start the squad config is re-seeded from the image
with the same dpkg rule as every other start (see "Where things live").

Upgrade note (FOC-783): if `fenix doctor` warns about the **Cockpit hooks** —
your `agents/supervisor/settings.json` was edited locally and the image now
ships a version with them — merge the Cockpit hooks from the
`settings.json.fenix-new` twin parked next to it, then delete the twin.

## Fenix on a VM (GCP)

The same stack runs on a Linux VM. The dashboard stays on the VM's
`127.0.0.1` and you reach it through an SSH tunnel — never publish port 4600:
the dashboard has no login, so anyone who reaches it could read telemetry and
transcripts. Through the tunnel the API sees a local peer, so chat, inbox
answers and the terminal work as on your own machine. Checked on 2026-10-12
with Debian 12 on `e2-standard-4` (4 vCPU / 16 GB) and a 100 GB disk.

1. Create the VM (from your machine):

   ```bash
   gcloud compute instances create fenix-vm --zone=europe-central2-a --machine-type=e2-standard-4 --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=100GB --boot-disk-type=pd-balanced
   ```

2. On the VM (`gcloud compute ssh fenix-vm --zone=europe-central2-a`): install
   Docker Engine and the Compose plugin from Docker's apt repository
   (docs.docker.com → Install Docker Engine on Debian), add yourself to the
   `docker` group, log in again, then:

   ```bash
   git clone https://github.com/joint-hubs/linear-agents.git ~/fenix && cd ~/fenix && ./fenix up
   ```

   Any host user works: `./fenix` builds the image for your uid/gid
   automatically (see "Before you start"). Run it as yourself, not root.

3. The tunnel, from your machine — keep it open while you use the dashboard,
   then open `http://localhost:4600`:

   ```bash
   gcloud compute ssh fenix-vm --zone=europe-central2-a --ssh-flag="-N" --ssh-flag="-L 4600:localhost:4600"
   ```

   In PowerShell, pass SSH options with `--ssh-flag` as above: `gcloud` is a
   PowerShell script there and swallows a bare `--`. On Windows the tunnel runs
   in a PuTTY window — leave it open.

Sizing, measured on `fenix-vm` on 2026-10-12 (one Supervisor, one test-squad
child on a real ticket — a single sample, not a benchmark):

| | CPU (4 vCPU) | memory | disk / network |
|---|---|---|---|
| idle (Supervisor waiting) | ~1 % | ~1.2 GB used (Supervisor `claude` ~380 MB, API ~100 MB) | writes ~3 MB/min |
| one child at work (22 min) | peaks ~38 % (≈1.5 vCPU) | ~2–3 GB above idle, page cache included | ~530 MB downloaded (toolchains), ~2.9 GB written |
| first image build | peaks ~41 % | up to ~10 GB incl. page cache | ~1 GB downloaded |

Disk after the first ticket: 9.7 GB — image 2 GB, Docker build cache 3.8 GB
(`docker builder prune` frees it), agent toolchains in the container 1.8 GB,
data volume 0.3 GB. Recommended: 4 vCPU, 16 GB RAM, 100 GB disk (what the
measurement ran on). One child at a time — Fenix's default — would likely fit
in 2 vCPU / 8 GB / 50 GB; that is not verified yet.

The VM runs (and costs) until you stop it:
`gcloud compute instances stop fenix-vm --zone=europe-central2-a`. Data stays on
the disk; after `start` the stack comes back by itself.

## Uninstall

```bash
./fenix down                 # stop and remove containers (the volume is kept)
docker image rm fenix:dev    # remove the image (~2 GB)
# optional, irreversible (telemetry, state, transcripts):
docker volume rm fenix_fenix-data
```

The `.fenix/` directory with your keys and config stays in the repo checkout;
delete it separately if you want the keys gone from disk.
