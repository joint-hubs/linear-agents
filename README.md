# Fenix

Fenix is a multi-agent workflow that connects Linear to Claude Code: specialized agents process Linear tickets in a loop, with minimal human intervention. Each agent boots from an isolated `.bat` launcher — with its own provider/model and its own `CLAUDE_CONFIG_DIR` — and human-in-the-loop runs **asynchronously** through Linear metadata (labels, states, comments). The goal is maximum delegation at minimum cost, all visible in a central telemetry dashboard (SQLite, port 7331).

There are **two ways to run it**. *Standalone*, you launch each squad yourself and the handoffs travel through Linear. *Supervised*, you launch only `bin/supervisor.bat`: one agent triages the issue, spawns the squads as headless child processes in isolated git worktrees, and relays every decision back to you — you never open a child terminal.

> **Note:** This is the English README. The Polish version ([README.pl.md](README.pl.md)) is the authoritative one for the maintainer's team. The project itself is bilingual; this file is provided for external contributors.

## End-to-end pipeline

```
PLAN ──▶ DEV ──▶ REVIEW ──▶ TEST ──▶ CADENCE
                                    (weekly)

SUPERVISOR ──drives──▶ PLAN · DEV · REVIEW · TEST      (supervised mode)
```

- **PLAN** — discovery: an entry from `planning/inbox/` (e.g. a voice memo) → spec → Linear ticket.
- **DEV** — picks up a `Todo` task, creates a branch, implements, moves it to `In Review`.
- **REVIEW** — first-pass + security + deep review (max 2 rounds standalone; the supervised cap works differently — see below); task comes back or moves forward.
- **TEST** — deploys to a staging VM, runs synthetic tests, closes as `Done`.
- **CADENCE** — recurring (weekly): digest, retrospective, roadmap refresh.

## Seven components (5 squads + orchestrator + supervisor)

| # | Agent | Launcher | Trigger | Role |
|---|---|---|---|---|
| 0 | CADENCE | `bin/cadence.bat` | cron, weekly | digest + retro + roadmap refresh |
| 1 | PLAN | `bin/plan.bat` | voice memo + `planning/inbox/` | discovery → spec → pushed |
| 2 | DEV | `bin/dev.bat` | task in `Todo` | pick → branch → code → In Review |
| 3 | REVIEW | `bin/review.bat` | task in `In Review` | first-pass + security + deep |
| 4 | TEST | `bin/test.bat` | task in `stage:testing` | deploy → synthetic → Done |
| — | SUPERVISOR | `bin/supervisor.bat` | manual, one Linear issue | frontman: triage → spawn children → relay every gate |
| — | ORCHESTRATOR | `bin/orchestrate.bat` | manual | strategist (Atlas MCP), delegates to launchers |

## Supervised mode

`bin/supervisor.bat` is the only user-facing launcher of the supervised pipeline. The Supervisor triages one Linear issue, then drives PLAN/DEV/REVIEW/TEST as **headless `claude -p` child processes**, each in its own `git worktree`. It has no subagents of its own — children are OS processes, so their context is never billed to the Supervisor's session.

What it adds over the standalone pipeline:

- **Isolated worktrees** — one checkout per child, so two agents can never commit into each other's tree. Pass `--repo <path>` to `supervisor-spawn.mjs` when the issue belongs to a repo other than this one.
- **Per-node concurrency + backpressure** — limits come from `nodes.<name>.concurrency` in `config/graph.json`. A spawn that cannot start is *held* on disk and released later, never dropped.
- **Per-stage budgets** — `supervisor-budget.mjs` splits an issue budget across discovery/verification/synthesis. Stages do not borrow from each other: the money reserved for checking the work is what stops a run ending with code nobody verified.
- **Evidence-backed verdicts** — every REVIEW finding must cite an artefact. A dev↔review round is refused when it *repeats* (same diff, same failing tests), not when a counter runs out, so a run that keeps moving is not cut short at two.
- **File-based HITL** — a child that needs a human writes a gate record and exits cleanly; the Supervisor relays the question and records the answer before delivering it.
- **Two-key worktree cleanup** — a worktree is reclaimed only when TEST has passed **and** you have said yes, and only while the tree still matches the fingerprint you approved.

Rationale and rejected alternatives: [ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md). Manual walkthrough: [supervisor-e2e-checklist.md](docs/supervisor-e2e-checklist.md).

## Quickstart

```bat
copy .env.example .env   :: fill in keys (OpenRouter, Anthropic, Linear)
:: edit config/projects.json (repo<->project, GCP VM, team IDs)
node scripts/bootstrap-linear.mjs   :: creates labels/states/templates in Linear
bin\dashboard.bat        :: telemetry dashboard on :7331
bin\plan.bat             :: start the planning agent (standalone)
bin\supervisor.bat       :: or start the supervised pipeline instead
```

The launchers read `.env` and `config/projects.json` at startup. The first run
will auto-render `config/atlas-mcp.json` from `config/atlas-mcp.json.template`
using the `ATLAS_VENV_PYTHON` and `ATLAS_ROOT` env vars you set in `.env`.

## Stack

- **Claude Code** — each agent runs in an isolated `CLAUDE_CONFIG_DIR` with its own provider/model.
- **Models** — routing per role lives in `config/models.json` (rationale: [model-comparison-and-routing.md](docs/decisions/model-comparison-and-routing.md)). The four tier aliases Claude Code resolves against (`opus`/`sonnet`/`haiku`/`smallFast`) belong to the **provider**, not to each launcher — `providers.<name>.tiers`, applied by `scripts/provider-resolve.mjs`. That matters because Claude Code claims the sonnet tier for its own auto-mode permission classifier, so a slug the active provider cannot serve breaks every tool call rather than one role.
- **Telemetry** — SQLite schema v5 (`tool_facts` + `delegation_links` + `usage_facts`) → dashboard API on :7331 ([TELEMETRY-EXPLAINED.md](docs/TELEMETRY-EXPLAINED.md)).
- **Code intelligence** — CodeGraph MCP server (`.mcp.json`) + CLI wrapper `scripts/code-intel.mjs`; see [AGENTS.md](AGENTS.md).
- **Linear** — 2 workspaces (`joi` | `pisi`), signals via labels + emoji + webhooks ([linear-signaling-protocol.md](docs/decisions/linear-signaling-protocol.md)).

## What's new in 2026-Q3

- **Supervised mode** — `bin/supervisor.bat` + `scripts/supervisor-*.mjs`: headless children in isolated worktrees, per-node concurrency with backpressure, per-stage budgets, evidence-backed review verdicts, file-based gates, two-key worktree cleanup ([ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md)).
- **Provider model tiers** — the four tier aliases moved out of eleven launchers into `providers.<name>.tiers`, so switching `LA_PROVIDER` switches them with it instead of leaving them pointed at models the new provider does not host.
- **Context attribution** — measured where a lead's context window actually goes. The fixed session floor is **34.6%** of the cache-read bill, and 8.7k tokens of it were schemas for four tools a headless child cannot use. Prompt trimming turns out to be the wrong lever ([context-attribution-2026-08-26.md](docs/decisions/context-attribution-2026-08-26.md)).
- **Orchestrator in the repo** — `agents/orchestrator/` (strategist + 8 skills, Atlas MCP); config moved from `%LOCALAPPDATA%\hermes` to the repo.
- **Telemetry v5** — `tool_facts` + `delegation_links` + `usage_facts` in SQLite. Trace: transcripts → sqlite → dashboard. Retention: [check-transcript-retention.mjs](scripts/check-transcript-retention.mjs).
- **In-place prompt editor** — edit prompts/agents from the dashboard UI, including external orchestrator roots (allowlist + symlink-safe; [prompt-editing.md](docs/ui/prompt-editing.md)).
- **Agent intelligence** — [agent_intelligence.py](notebooks/agent_intelligence.py) reads telemetry SQL → self-contained HTML (n-grams, embedding clusters, per-squad break-down).
- **CodeGraph code-intelligence** — MCP server in `.mcp.json` (approve per squad: `node scripts/mcp-enable.mjs --verify`) + CLI wrapper `scripts/code-intel.mjs`; see [AGENTS.md](AGENTS.md). Auto-syncing index, no pre-commit hook.

## Documentation

- Concept: [00-overview.md](docs/00-overview.md) · [FENIX_WORKFLOW.md](docs/FENIX_WORKFLOW.md)
- How to run: [HOW-TO-RUN-AGENTS.md](docs/HOW-TO-RUN-AGENTS.md) · [STATE.md](docs/STATE.md)
- Supervisor: [ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md) · [e2e checklist](docs/supervisor-e2e-checklist.md)
- ADRs: [docs/adr/](docs/adr/README.md)
- Decisions: [model routing](docs/decisions/model-comparison-and-routing.md) · [context attribution](docs/decisions/context-attribution-2026-08-26.md) · [squad review](docs/decisions/squad-review-2026-07-27.md) · [code review](docs/decisions/code-review-2026-08-03.md) · [telemetry audit](docs/decisions/telemetry-data-audit-2026-08-03.md)
- Intelligence: [agent-intelligence.md](docs/plans/agent-intelligence.md)
- Full index: [docs/README.md](docs/README.md)

## Requirements

- Windows 10/11
- [Claude Code](https://claude.com/claude-code) (CLI)
- Node.js **22.5+** (the central telemetry server uses `node:sqlite`)
- Java 21 (only for rendering PlantUML diagrams)
- API keys: OpenRouter, Anthropic, Linear (see `.env.example`)

Forks running on macOS/Linux will need to translate the `.bat` launchers to `.sh` — the underlying `.mjs` scripts are portable.

## Running tests

```bat
node scripts\test-all.mjs
:: or a single file:
node scripts\test-all.mjs linear-client
:: or run one directly:
node scripts\<file>.test.mjs
```

The wrapper runs every `scripts/*.test.mjs` in order and reports a summary. Each file is self-contained (just `node`).

## License

[MIT](LICENSE) — Copyright (c) 2026 Mateusz Stachowicz.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For significant changes, please open an issue first to discuss what you'd like to change.
