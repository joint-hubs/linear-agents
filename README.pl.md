# Fenix

Fenix to wieloagentowy workflow, który łączy Linear z Claude Code: pięć wyspecjalizowanych agentów przerabia tickety Linear w pętli, z minimalną ingerencją człowieka. Każdy agent startuje z izolowanego `.bat` — z własnym providerem/modelem i własnym `CLAUDE_CONFIG_DIR` — a human-in-the-loop działa **async** przez metadane Lineara (labelki, statusy, komentarze). Cel: maksymalne odciążenie przy minimalnym koszcie, całość widoczna na centralnej telemetrii (SQLite, port 7331).

## Pipeline e2e

```
PLAN ──▶ DEV ──▶ REVIEW ──▶ TEST ──▶ CADENCE
                                    (co tydzień)
```

- **PLAN** — discovery: wpis z `planning/inbox/` (np. voice memo) → spec → ticket w Linearze.
- **DEV** — podbiera task z `Todo`, robi branch, implementuje, wystawia na `In Review`.
- **REVIEW** — first-pass + security + deep review (max 2 rundy); task wraca albo idzie dalej.
- **TEST** — deploy na stage, testy syntetyczne, zamknięcie jako `Done`.
- **CADENCE** — cykliczny (co tydzień): digest, retrospektywa, refresh roadmapy.

## 6 elementów (5 agentów + orchestrator)

| # | Agent | Launcher | Trigger | Rola |
|---|---|---|---|---|
| 0 | CADENCE | `bin/cadence.bat` | cron weekly | digest + retro + roadmap refresh |
| 1 | PLAN | `bin/plan.bat` | voice memo + `planning/inbox/` | discovery → spec → pushed |
| 2 | DEV | `bin/dev.bat` | task w `Todo` | pick → branch → kod → In Review |
| 3 | REVIEW | `bin/review.bat` | task w `In Review` | first-pass + security + deep (max 2 rundy) |
| 4 | TEST | `bin/test.bat` | task `stage:testing` | deploy → synthetic → Done |
| — | ORCHESTRATOR | `bin/orchestrate.bat` | ręcznie | strategista (Atlas MCP), deleguje do launcherów |

## Quickstart

```bat
copy .env.example .env   :: uzupełnij klucze (OpenRouter, Anthropic, Linear)
:: uzupełnij config/projects.json (repo↔projekt, GCP VM)
node scripts/bootstrap-linear.mjs   :: tworzy labelki/statusy/templates w Linear
bin\dashboard.bat        :: dashboard telemetryczny na :7331
bin\plan.bat             :: odpal agenta planowania
```

## Stack

- **Claude Code** — każdy agent = izolowany `CLAUDE_CONFIG_DIR` + własny provider/model
- **Modele** — DeepSeek V4 Flash / Pro, GLM-5.2, Sonnet 4.6, Kimi K2.7 (routing w `config/models.json`; decyzja: [model-comparison-and-routing.md](docs/decisions/model-comparison-and-routing.md))
- **Telemetria** — SQLite schema v3 (`tool_facts` + `delegation_links` + `usage_facts`) → dashboard API na :7331 ([TELEMETRY-EXPLAINED.md](docs/TELEMETRY-EXPLAINED.md))
- **Linear** — 2 workspace (joi | pisi), sygnały przez labels + emoji + webhooki ([linear-signaling-protocol.md](docs/decisions/linear-signaling-protocol.md))

## Nowości 2026-Q3

- **Orchestrator w repo** — `agents/orchestrator/` (strategist + 8 skills, Atlas MCP); config przeniesiony z `%LOCALAPPDATA%\hermes` do repo
- **Telemetria v3** — `tool_facts` + `delegation_links` + `usage_facts` w SQLite. Trace: transkrypty → sqlite → dashboard. Retencja: [check-transcript-retention.mjs](scripts/check-transcript-retention.mjs)
- **In-place prompt editor** — edycja promptów/agentów z UI dashboard, w tym zewnętrznych orchestrator root'ów (allowlist + symlink-safe; [prompt-editing.md](docs/ui/prompt-editing.md))
- **Agent intelligence** — [agent_intelligence.py](notebooks/agent_intelligence.py) czyta telemetrię SQL → self-contained HTML (n-gramy, embedding clusters, per-squad break-down)
- **CodeGraph code-intelligence** — serwer MCP per skład (`agents/*/settings.json`) + nakładka CLI `scripts/code-intel.mjs`; patrz [AGENTS.md](AGENTS.md). Indeks sam się synchronizuje, bez hooka pre-commit

## Dokumentacja

- Koncept: [00-overview.md](docs/00-overview.md) · [FENIX_WORKFLOW.md](docs/FENIX_WORKFLOW.md)
- Jak uruchomić: [HOW-TO-RUN-AGENTS.md](docs/HOW-TO-RUN-AGENTS.md) · [STATE.md](docs/STATE.md)
- Decyzje: [model routing](docs/decisions/model-comparison-and-routing.md) · [squad-review](docs/decisions/squad-review-2026-07-27.md) · [code review](docs/decisions/code-review-2026-08-03.md) · [telemetry audit](docs/decisions/telemetry-data-audit-2026-08-03.md)
- Intelligence: [agent-intelligence.md](docs/plans/agent-intelligence.md)
- Pełny indeks: [docs/README.md](docs/README.md)

## Wymagania

Windows · Claude Code · Node 22.5+ (centralna telemetria używa `node:sqlite`) · Java 21 (render diagramów) · klucze: OpenRouter, Anthropic, Linear.

## Testy

```bat
node scripts\test-all.mjs
:: albo jeden plik:
node scripts\test-all.mjs linear-client
:: albo ręcznie:
node scripts\<plik>.test.mjs
```

Wrapper uruchamia wszystkie `scripts/*.test.mjs` w kolejności i raportuje ile mineło. Każdy plik jest samodzielny (wystarczy `node`).

## Contributing

Zgłoszenia i PR-y — patrz [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencja

[MIT](LICENSE).
