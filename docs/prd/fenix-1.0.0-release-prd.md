# PRD — Fenix 1.0.0: portable release (quick start in Docker, dashboard v2, one cost truth)

Status: **approved scope, 2026-10-11** — decisions in §10. Linear: milestone **M8 Fenix 1.0.0 — portable
release**, epic **FOC-768**, tasks in §8.

## 1. Problem

1. **Fenix only runs on Mateusz's machine.** No Dockerfile or compose file exists. 22 Windows `.bat`
   launchers start everything; runtime code hardcodes `LOCALAPPDATA` (16 files), PowerShell (14),
   `C:/Users/mateu` (7), Atlas (10), the `la-wt` worktree root (5). Smart App Control blocks scanners
   intermittently. A developer on another machine cannot start it.
2. **Cost is not trustworthy.** Review 2026-10-10 (`docs/research/2026-10-10-model-cost-telemetry-review.md`):
   registry child cost is 5× ground truth (FOC-760), telemetry drops resumed child turns (FOC-761).
   And the Supervisor itself — the largest cost — is not attributed to tickets (§3).
3. **The dashboard grew by trial and error.** 12 screens, several untouched since July/August, two
   cancelled UI tasks (FOC-103 task graph, FOC-107 cost panel), and Mateusz's recurring complaints:
   slow, shows a Supervisor as running where none is, and no Supervisor-first view (§6.1).

## 2. Goal and users

**Fenix 1.0.0** = the first tagged release a developer can run on their own machine with one
command, bringing their own keys, and drive from one dashboard.

- ✅ Version **1.0.0** (git tag `v1.0.0`; FOC-102 "Fenix 1.0" stays the internal stabilization scope).
- ✅ Users: **developers who code** — full-stack, data scientists, any role that ships code.
- ✅ Main target: work with the **linear-agents** repository flow (Linear issue → Supervisor → squads →
  landed change). Atlas and `jointhubs.os` knowledge base: **out of 1.0**, a later optional add-on.
- ✅ Headline release metrics: **not now**; the dashboard shows cost and quality data, a headline
  set is chosen later.

## 3. Evidence — what a ticket costs today (transcript ground truth, since 2026-09-10)

| | value |
|---|---|
| tickets with child work | 116 |
| child cost per ticket | p20 $0.15 · p50 $0.36 · p80 $1.15 · max $59.94 |
| child cost, total | $157.45 |
| **Supervisor cost, total** | **$410.37** (telemetry: $446.83 deduplicated — within ~9 %; long Supervisor sessions are not hit by FOC-761) |
| all-in average per ticket | ≈ **$4.90** (Supervisor = 72 % of spend) |
| Supervisor cost attributable to a ticket today | $48.34 (12 %) — by child-activity windows only |
| tickets with follow-up turns / >1 REVIEW child | 79/116 (68 %) / 23/116 (20 %) |

Supervisor cost by model: glm-5.3 $237, mimo-v2.6-pro $71, glm-5.2 $60, deepseek-v4.1-flash $17,
glm-5.3-flash $12, gpt-6-astra $11. Consequence: "what a ticket costs" is dominated by orchestration
that is not attributed. 1.0 needs the Supervisor to **declare which ticket it is working on**, so
its turns can be charged to that ticket (§8, task P0.3).

## 4. User journey (target)

1. `git clone …/linear-agents && cd linear-agents`
2. `./fenix up` (Windows: `fenix up` via `fenix.cmd`) — the only command the user has to know.
3. Preflight: Docker running, Compose v2, RAM/disk/ports; a clear message and stop if not.
4. Key wizard (first run only): OpenRouter key, Linear key + team, GitHub token. Each key is
   **validated live** (OpenRouter: one cheap call; Linear: `viewer`; GitHub: token scopes), never
   echoed, stored as Compose secrets in `./.fenix/secrets/` (gitignored, owner-only permissions).
5. `docker compose up -d` with healthchecks; the browser opens the dashboard on `localhost`.
6. First-run screen: add a repository (URL), pick the Linear team, see the routing (models + prices).
7. The user talks to the Supervisor in the dashboard, picks a Linear issue, follows it through
   plan → dev → review → test → landing, answers gates, and **pushes with an explicit button**.
8. Later: `./fenix stop | update | logs | doctor | keys` — same entry point.

## 5. Quick start — design

### 5.1 One entry point, no host dependencies besides Docker
- `fenix` (POSIX sh) + `fenix.cmd` / `fenix.ps1` thin wrappers. They only check Docker and call
  `docker compose`; everything else runs **inside** the image (the wizard too, as
  `docker compose run --rm fenix init`), so no Node/Python/git is required on the host.
- Subcommands: `up`, `stop`, `update` (pull pinned image), `logs`, `doctor` (preflight + key checks +
  health), `keys` (re-run wizard / rotate), `attach` (terminal into the Supervisor for power users).

### 5.2 Image and services
- One image `ghcr.io/joint-hubs/fenix:1.0.0` (Linux): Node 22, git, gh, Claude Code CLI (pinned),
  CodeGraph, semgrep, Python 3 + uv, and the generators for derived artifacts.
- **Generated artifacts** (DrawIO architecture pages and others) are gitignored, generated on start
  and regenerated when their source changes; a manifest records the source revision and the
  dashboard shows staleness (FOC-779). DrawIO XML needs no desktop app; the dashboard renders it with
  a bundled viewer, so the image does not need draw.io Desktop unless PNG export is wanted.
- Compose services:
  - `fenix-api` — dashboard (web + API), telemetry ingest, cost reconciliation;
  - `fenix-supervisor` — the Supervisor session + child spawner/watchers + worktrees.
- Volumes: `state` (`.state`, telemetry SQLite), `workspaces` (repo clones + worktrees),
  `claude` (per-squad `CLAUDE_CONFIG_DIR` incl. transcripts). **Retention: keep everything by
  default** (logs are training data); a limit is an opt-in in the wizard / Settings with the disk
  estimate (FOC-780). Immediate stop on Mateusz's machine, 2026-10-11: `cleanupPeriodDays: 36500` in
  every `agents/*/settings.json` (Claude Code's default deleted transcripts after 30 days).
- `restart: unless-stopped`; the Supervisor session resumes on container start.
- Models: Claude Code → OpenRouter (`ANTHROPIC_BASE_URL`), routing from `config/models.json`
  (FOC-762). No Anthropic login needed. **The provider stays pluggable**: switching to another
  compatible endpoint is configuration (base URL, key, tiers, routing, prices), validated live
  (FOC-773).

### 5.3 Keys
- Compose `secrets:` (files), not plain env, so keys do not show in `docker inspect` or logs.
- The egress screen keeps running on everything that leaves the container (FOC-450 / FOC-733).
- Push and PR: the container never pushes on its own; **Push / Open PR** is a dashboard button
  that a human clicks ✅ (current rule kept).

### 5.4 Portability work (prerequisite)
- One `paths` / `config` module for every location (state, telemetry, worktrees, config dirs) —
  no `LOCALAPPDATA`, no user paths in runtime code; Windows host keeps working via the same env.
- Node entry points replace the `.bat` launchers (the `.bat` files become thin wrappers or go).
- Atlas, Nebul, the `pisi` workspace, personal memory: optional, off by default.
- CI on Linux runs the full suite (today it only runs on Windows locally).

## 6. Dashboard v2 — UX

### 6.1 What v1 taught us (sources: `docs/ui/*`, Mateusz's session remarks, git churn, Linear)

**Worked — keep:**
- Model routing per role with price + benchmark (ux-improvements verdict: "ready swap per task").
- Cost monitoring as a concept; the Analysis screen on the telemetry DB (Sept, asked for explicitly).
- Terminal / session spawn and the Keys screen (complete MVP per ux-improvements).
- Manager tactical board — the most iterated screen (9 commits since August); squads and roster as
  the mental model.

**Did not work — fix or drop:**
- **Slow** (2026-09-05: "dashboard działa bardzo powoli") — the ingest loop blocked the server's
  event loop (FOC-547).
- **Wrong live state** (2026-09-05: a Supervisor shown as running in `joint-flows` where none was).
- **Numbers that lie** — registry cost 5×, telemetry missing resumed turns (FOC-760/761).
- **No Supervisor-first view** (2026-08-27: "konfiguracja, prompty, flow i pełny monitoring … dla
  supervisora też").
- **Sprawl** — 12 screens; Tasks, Runs, Costs, Prompts untouched since July/August; task-graph and
  cost-panel tasks cancelled.
- Earlier dashboards: maps not interactive / sliders without meaning (2026-06-07) — every chart must
  say what it measures and be explorable.

### 6.2 Information architecture (6 areas instead of 12 screens — spec: `docs/ui/dashboard-v2-spec.md`)

| area | what the developer does there |
|---|---|
| **Cockpit** (home) | talk to the Supervisor (chat with the full terminal one click away); **"Needs you"** inbox: gates, STOP reports, push/PR approvals; live children with honest status |
| **Work** | tickets from Linear as a board: plan → dev → review → test → landed; per ticket: rounds, cost (children + Supervisor share), evidence links (verdicts, diffs, logs) |
| **Team** | the agent architecture as a high-level diagram: Supervisor → squad leads → the line-up each lead actually picks (roles by share), the bench; per squad cost and the lead's own share (replaces the Manager tactical board, decision 2026-10-11) |
| **Costs & quality** | cost per ticket p20/p50/p80, model mix, rework share, first-time-right, human interventions per ticket — candidates for the later headline set |
| **Insights** | curated analyses from the marimo notebook: Money (cost per ticket, Supervisor overhead, outlier ledger), Behaviour (loop episodes), Human steering (what Mateusz had to do), Flow |
| **Settings** | keys, repositories, routing (models + prices + benchmarks), squads and prompts, budget |

Control from the dashboard (✅ wanted): answer gates, approve push/PR, start/stop/follow-up a child,
message the Supervisor, change routing. Every action that changes something outside the container
goes through an explicit confirm.

### 6.3 UX rules
- One number, one source: every cost shown is reconciled (P0); stale data is labelled with its age.
- p95 API response < 500 ms on the real store; ingest never blocks the server.
- Empty / loading / error / stale states designed for every panel (v1 lacked them on most screens).
- Charts say what they measure, are interactive, and link to the evidence behind a point.

## 7. Scope

**In:** P0–P4 below. **Out of 1.0:** Atlas / `jointhubs.os` integration, multi-user / auth beyond
localhost, managed cloud hosting, providers beyond OpenRouter as shipped defaults (switching stays possible),
autonomous pickup of Linear issues without a human (D2), the FOC-477 go/no-go (1.0 does not wait
for it).

## 8. Phases and tasks

| phase | tasks | exit |
|---|---|---|
| **P0 Cost truth** | FOC-760 registry cost from transcripts (incl. the reconciliation check) · FOC-761 resumed turns in telemetry · FOC-769 Supervisor declares its active ticket; telemetry charges Supervisor turns to it | reconciliation ≤ 1 % on all children; ≥ 80 % of Supervisor cost attributed |
| **P1 Portability** | FOC-770 paths/config module · FOC-771 Node entry points replace `.bat` · FOC-772 Atlas/Nebul/pisi optional · FOC-762 child model from routing · FOC-773 pluggable provider · FOC-774 Linux CI for the full suite | `git grep` finds no user path / `LOCALAPPDATA` in runtime code; suite green on Linux |
| **P2 Docker quick start** | FOC-775 image · FOC-776 compose (2 services, volumes, healthchecks, restart, resume) · FOC-777 `fenix` CLI (up/stop/update/logs/doctor/keys/attach) · FOC-778 key wizard with live validation + Compose secrets · FOC-779 generated artifacts regenerated on start · FOC-780 retention (keep all by default) · FOC-781 Quickstart docs | fresh VM with only Docker: `./fenix up` → dashboard in ≤ 10 min |
| **P3 Dashboard v2** | FOC-782 UX spec + mockups (first) · FOC-783 Cockpit (Supervisor chat + web terminal + Needs-you inbox) · FOC-784 Work board · FOC-785 Costs & quality · FOC-786 Settings · FOC-787 Insights (2–3 notebook analyses) · FOC-788 human push / PR button | journey §4 steps 6–7 done in the browser only |
| **P4 Release** | FOC-724 release dossier for 1.0.0 (retargeted from 1.1) · FOC-789 fresh-machine acceptance run on a real Linear issue · FOC-790 release notes + tag `v1.0.0` | acceptance run green; tag pushed by Mateusz |

Blocking relations in Linear: FOC-782 blocks the P3 screens; FOC-770 → FOC-775 → FOC-776 / FOC-777;
FOC-789 waits for the CLI, the wizard, the Cockpit, the push button, the cost fixes and the docs.

## 9. Acceptance criteria (release)

1. On a machine with only Docker: `./fenix up` → keys validated → dashboard open → one real Linear
   issue processed end-to-end (plan → landed branch) → push done by the human from the dashboard.
2. No runtime reference to `C:/Users/mateu`, `LOCALAPPDATA`, `.bat` or PowerShell on the Linux path.
3. Cost per ticket in the dashboard = transcript ground truth ± 1 %, Supervisor share included.
4. Keys never appear in logs, `docker inspect`, telemetry or Linear (egress screen + secret files).
5. Dashboard p95 < 500 ms on the real store; no screen shows a live state that is not true.
6. `./fenix doctor` explains every failed precondition in one line with the fix.

## 10. Decisions (Mateusz, 2026-10-11)

- **D1** Talking to the Supervisor from the dashboard: **both** — chat backed by headless turns and a
  web terminal.
- **D2** The Supervisor does **not** pick tickets on its own; a human steers it.
- **D3** Provider: **OpenRouter now, switchable to anything else** (pluggable provider, FOC-773).
- **D4** Repositories cloned into a volume; bind-mount from the host as an advanced option.
- **D5** DrawIO and other generated artifacts: **gitignored, generated on a fresh start, freshness
  watched** (FOC-779) — no separate image variant needed for that.
- **D6** Dashboard v2 on the same stack (React + Vite), new information architecture.
- **D7** Logs: **not deleted by default** (training data); a retention limit is an opt-in for users
  who do not want that much data (FOC-780).
- **D8** No deadline, no budget cap.
