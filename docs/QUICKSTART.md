# Fenix quick start (Docker)

Fenix runs as two Docker containers: `fenix-api` (dashboard + telemetry API)
and `fenix-supervisor` (the Supervisor, running permanently in a tmux session
inside the container).
Everything needed at runtime is inside the image `fenix:dev` (~2 GB on disk):
Node 22, git, Claude Code 2.1.296, CodeGraph 1.6.0, semgrep 1.172.0, uv,
Python 3.11. The container runs as the non-root user `node`.

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
- All mutable state (telemetry, Supervisor state, workspaces) lives in the
  `fenix_fenix-data` volume, so the image itself is stateless and replaceable.

Status (1.0.0): the Supervisor works in the container end to end — it clones
your repositories (`fenix repo add`), resumes its session after a restart, and
transcripts survive `fenix down` and `fenix update` (they are on the data
volume). If the supervisor container stops mid-turn, the interrupted child is
marked `crashed` (reason `container-restart`) on the next start, so the
Supervisor can resume it with a follow-up. CodeGraph MCP is approved for every
squad on the volume. The Supervisor chat and terminal in the dashboard (the
Cockpit) work in Docker. Known gaps: model-routing edits from the dashboard are
not kept across `fenix update` (FOC-786).

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

## Daily use

| Command | What it does |
|---|---|
| `fenix up` | preflight, keys if needed, build and start the stack |
| `fenix stop` | stop the stack |
| `fenix down` | stop and remove containers (the data volume is kept) |
| `fenix logs [service]` | follow logs (default: all services) |
| `fenix doctor` | host preflight plus in-container diagnostics |
| `fenix keys` | key wizard: enter or replace keys |
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
starts a fresh one. `fenix down` removes the containers but keeps the data
volume, so telemetry and Supervisor state survive a recreate; a later
`fenix up` reattaches them.

## Where things live

- Keys: `.fenix/secrets/{openrouter_api_key,linear_api_key,github_token}` —
  gitignored, owner-only, never baked into the image, never printed; mounted
  as Compose secrets under `/run/secrets/`.
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

   Check `id -u` first: until FOC-803 the host user must be uid 1000 (the
   container user), or the container cannot read the keys the wizard writes.

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
