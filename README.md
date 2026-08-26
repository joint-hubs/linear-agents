# Fenix

Fenix is a multi-agent workflow that connects Linear to Claude Code: five specialized agents process Linear tickets in a loop, with minimal human intervention. Each agent boots from an isolated `.bat` launcher — with its own provider/model and its own `CLAUDE_CONFIG_DIR` — and human-in-the-loop runs **asynchronously** through Linear metadata (labels, states, comments). The goal is maximum delegation at minimum cost, all visible in a central telemetry dashboard (SQLite, port 7331).

> **Note:** This is the English README. The original Polish version ([README.md](README.md)) is the authoritative one for the maintainer's team. The project itself is bilingual; this file is provided for external contributors.

## End-to-end pipeline

```
PLAN ──▶ DEV ──▶ REVIEW ──▶ TEST ──▶ CADENCE
                                    (weekly)
```

- **PLAN** — discovery: an entry from `planning/inbox/` (e.g. a voice memo) → spec → Linear ticket.
- **DEV** — picks up a `Todo` task, creates a branch, implements, moves it to `In Review`.
- **REVIEW** — first-pass + security + deep review (max 2 rounds); task comes back or moves forward.
- **TEST** — deploys to a staging VM, runs synthetic tests, closes as `Done`.
- **CADENCE** — recurring (weekly): digest, retrospective, roadmap refresh.

## Six components (5 agents + orchestrator)

| # | Agent | Launcher | Trigger | Role |
|---|---|---|---|---|
| 0 | CADENCE | `bin/cadence.bat` | cron, weekly | digest + retro + roadmap refresh |
| 1 | PLAN | `bin/plan.bat` | voice memo + `planning/inbox/` | discovery → spec → pushed |
| 2 | DEV | `bin/dev.bat` | task in `Todo` | pick → branch → code → In Review |
| 3 | REVIEW | `bin/review.bat` | task in `In Review` | first-pass + security + deep (max 2 rounds) |
| 4 | TEST | `bin/test.bat` | task in `stage:testing` | deploy → synthetic → Done |
| — | ORCHESTRATOR | `bin/orchestrate.bat` | manual | strategist (Atlas MCP), delegates to launchers |

## Quickstart

```bat
copy .env.example .env   :: fill in keys (OpenRouter, Anthropic, Linear)
:: edit config/projects.json (repo<->project, GCP VM, team IDs)
node scripts/bootstrap-linear.mjs   :: creates labels/states/templates in Linear
bin\dashboard.bat        :: telemetry dashboard on :7331
bin\plan.bat             :: start the planning agent
```

The launchers read `.env` and `config/projects.json` at startup. The first run
will auto-render `config/atlas-mcp.json` from `config/atlas-mcp.json.template`
using the `ATLAS_VENV_PYTHON` and `ATLAS_ROOT` env vars you set in `.env`.

## Stack

- **Claude Code** — each agent runs in an isolated `CLAUDE_CONFIG_DIR` with its own provider/model.
- **Models** — DeepSeek V4 Flash / Pro, GLM-5.2, Sonnet 4.6, Kimi K2.7 (routing in `config/models.json`; rationale: [model-comparison-and-routing.md](docs/decisions/model-comparison-and-routing.md)).
- **Telemetry** — SQLite schema v3 (`tool_facts` + `delegation_links` + `usage_facts`) → dashboard API on :7331 ([TELEMETRY-EXPLAINED.md](docs/TELEMETRY-EXPLAINED.md)).
- **Linear** — 2 workspaces (`joi` | `pisi`), signals via labels + emoji + webhooks ([linear-signaling-protocol.md](docs/decisions/linear-signaling-protocol.md)).

## What's new in 2026-Q3

- **Orchestrator in the repo** — `agents/orchestrator/` (strategist + 8 skills, Atlas MCP); config moved from `%LOCALAPPDATA%\hermes` to the repo.
- **Telemetry v3** — `tool_facts` + `delegation_links` + `usage_facts` in SQLite. Trace: transcripts → sqlite → dashboard. Retention: [check-transcript-retention.mjs](scripts/check-transcript-retention.mjs).
- **In-place prompt editor** — edit prompts/agents from the dashboard UI, including external orchestrator roots (allowlist + symlink-safe; [prompt-editing.md](docs/ui/prompt-editing.md)).
- **Agent intelligence** — [agent_intelligence.py](notebooks/agent_intelligence.py) reads telemetry SQL → self-contained HTML (n-grams, embedding clusters, per-squad break-down).
- **CodeGraph code-intelligence** — MCP server in `.mcp.json` (approve per squad: `node scripts/mcp-enable.mjs --verify`) + CLI wrapper `scripts/code-intel.mjs`; see [AGENTS.md](AGENTS.md). Auto-syncing index, no pre-commit hook.

## Documentation

- Concept: [00-overview.md](docs/00-overview.md) · [FENIX_WORKFLOW.md](docs/FENIX_WORKFLOW.md)
- How to run: [HOW-TO-RUN-AGENTS.md](docs/HOW-TO-RUN-AGENTS.md) · [STATE.md](docs/STATE.md)
- Decisions: [model routing](docs/decisions/model-comparison-and-routing.md) · [squad review](docs/decisions/squad-review-2026-07-27.md) · [code review](docs/decisions/code-review-2026-08-03.md) · [telemetry audit](docs/decisions/telemetry-data-audit-2026-08-03.md)
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
