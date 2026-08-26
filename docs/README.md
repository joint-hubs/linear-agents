---
type: index
status: active
tags: [type/index, area/ai, topic/linear, topic/workflow]
created: 2026-06-22
updated: 2026-08-07
maturity: design-v3
---

# Linear AI Workflow — index

Wieloagentowy workflow oparty na **Linear + Claude Code**, uruchamiany z izolowanych `.bat`
(każdy agent = własny provider/model + własny `CLAUDE_CONFIG_DIR`). Cel: maksymalne odciążenie
przy minimalnym koszcie, HITL async przez metadane Lineara.

## Start tutaj

- **Nowy dev:** [README.md](../README.md) — root wizytówka (5 elementów, quickstart, nowości Q3)
- **1st read:** [00-overview.md](00-overview.md) — master: 5 elementów, statusy, task typing, escalation, izolacja `.bat`
- **Run book:** [HOW-TO-RUN-AGENTS.md](HOW-TO-RUN-AGENTS.md) — operator runbook: który `.bat`, jaki kickoff wkleić
- **Stan pracy:** [STATE.md](STATE.md) — long-work diary, najnowsza aktualizacja 2026-07-26

## Agenci (specyfikacje)

- [agent-0-cadence.md](agents/agent-0-cadence.md) — CADENCE weekly digest + retro + roadmap refresh
- [agent-1-planner.md](agents/agent-1-planner.md) — voice+artefakty → discovery → DoR → spec+ADR → decompose → push
- [agent-2-dev.md](agents/agent-2-dev.md) — pick(dep-aware, WIP=1) → recon → env-check → plan → kod → In Review
- [agent-3-review.md](agents/agent-3-review.md) — first-pass + security ∥ deep(GLM-5.2), max 2 rundy
- [agent-4-test.md](agents/agent-4-test.md) — deploy GCP (health+rollback) → synthetic tests → Done
- [Orchestrator](../agents/orchestrator/CLAUDE.md) — strategista (Atlas MCP), deleguje do squadów, eskalacja Flash→Pro→Sonnet→Opus

## Decyzje i konwencje

- [model-comparison-and-routing.md](decisions/model-comparison-and-routing.md) — zweryfikowane benchmarki + routing kosztowy
- [linear-signaling-protocol.md](decisions/linear-signaling-protocol.md) — async komunikacja człowiek↔agent
- [design-review-and-gaps.md](decisions/design-review-and-gaps.md) — sceptyczna krytyka: weak points / corner cases
- [squad-review-2026-07-27.md](decisions/squad-review-2026-07-27.md) — analiza 5 squadów (works/asymmetries/handoff gaps)
- [code-review-2026-08-03.md](decisions/code-review-2026-08-03.md) — code audit (T-A1 evidence)
- [telemetry-data-audit-2026-08-03.md](decisions/telemetry-data-audit-2026-08-03.md) — dane telemetryczne: source + cache math
- [cost-optimization.md](decisions/cost-optimization.md) — model routing a realne rachunki

## Diagramy (PlantUML — .puml edytowalne, .png wyrenderowane)

| Plik | Co pokazuje |
|---|---|
| [00_overview](diagrams/00_overview.puml) | całość: 4 launchery, bramki, task typing, fork review, deploy+rollback |
| [01_linear_state_machine](diagrams/01_linear_state_machine.puml) | 4 statusy + In Review{Reviewing→Testing} + sygnały |
| [02_planning_pipeline](diagrams/02_planning_pipeline.puml) | PLAN: discovery→DoR→spec+ADR→estimate→idempotent push |
| [03_dev_agent](diagrams/03_dev_agent.puml) | DEV: dep-aware pick, type routing, async clarify, checkpoint |
| [04_review_test](diagrams/04_review_test.puml) | REVIEW (potrójny par, max 2 rundy) + TEST (deploy health+rollback) |
| [05_cadence_loop](diagrams/05_cadence_loop.puml) | CADENCE: tygodniowa pętla domykająca linię w cykl |
| [06_signaling_protocol](diagrams/06_signaling_protocol.puml) | async human↔agent: needs:* + emoji + webhook |
| [07_squad_graph](diagrams/07_squad_graph.puml) | **generowany** z `config/graph.json` — węzły + typowane krawędzie (handoff/return/escalate/gate). NIE edytować ręcznie: `node scripts/graph-validate.mjs --emit-puml > docs/diagrams/07_squad_graph.puml` |
| [squad-graph](diagrams/squad-graph.html) | interaktywna mapa zależności squadów |
| [slides](diagrams/slides/README.md) | PlantUML→PNG pipeline (render commands) |

**Render:** `java -jar ~/plantuml.jar -tpng docs/diagrams/*.puml` (Java 21).

## Nowości 2026-Q3

- **Orchestrator w repo** ([a7f59b7](https://github.com/joint-hubs/linear-agents/pull/4)) — strategista + 8 skills przeniesione z `%LOCALAPPDATA%\hermes`
- **Telemetria v3** ([bad3c08, cbdbb5c, 69e8bc1](https://github.com/joint-hubs/linear-agents/pull/4)) — schema v3 (`tool_facts` + `delegation_links` + `usage_facts`), retention check, CSV export
- **In-place prompt editor** ([0663067, c4b119e](https://github.com/joint-hubs/linear-agents/pull/4)) — UI editing prompts własnych + zewnętrznych orchestrator root'ów (allowlist, symlink-safe)
- **Agent intelligence** ([8ff6ae6](https://github.com/joint-hubs/linear-agents/pull/4)) — PRD v2 + notebook `agent_intelligence.py` (HTML report z telemetrii SQL)
- **GitNexus code-intelligence** ([7bd768f](https://github.com/joint-hubs/linear-agents/pull/4)) — 6 skilli + AGENTS.md (impact + detect_changes pre-commit)

## Skrypty CLI (kluczowe)

- `bin/dashboard.bat` — dashboard start (health-check → :7331)
- `bin/orchestrate.bat` / `orchestrate-openrouter.bat` — launchery orkiestratora
- `scripts/telemetry-store.mjs` — centralna SQLite store (schema v3)
- `scripts/telemetry-ingest.mjs` — backfill + incremental ingest transkryptów
- `scripts/telemetry-delegation-recon.mjs` — rekonstrukcja parent→child delegation links
- `scripts/check-transcript-retention.mjs` — audyt: ile usage_facts ma live transcript
- `scripts/delegation-outcomes.mjs` — join review verdicts na delegations (JOI-210)
- `scripts/prompt-library.mjs` — backend biblioteki promptów (drzewo intencji + role/lead docs)
- `notebooks/agent_intelligence.py` — CLI → self-contained HTML z telemetrii SQL
- `scripts/graph-validate.mjs` — walidator `config/graph.json` (topologia składów) + `--emit-puml` / `--emit-handoff-rules`
- `scripts/graph-route.mjs` — jeden matcher `stan + etykiety → następny węzeł`; używa go dashboard (`telemetry-server.mjs`) **i** triage Supervisora, żeby nie mogły się rozjechać
- `scripts/supervisor-triage.mjs` — `propose` / `record`: deterministyczny werdykt wejściowego węzła grafu; zapisany werdykt jest kontraktem dla `supervisor-spawn.mjs`
- `scripts/supervisor-gate.mjs` — `emit` / `answer` / `list`: rekord bramki HITL. Plik jest źródłem prawdy (bez mirrora `needs:*` w Linearze); `answer` zapisuje, dostarcza dopiero `supervisor-followup.mjs --gate`

> **`config/graph.json` jest źródłem prawdy topologii.** `config/handoff-rules.json` to plik, który
> `telemetry-server.mjs` czyta w runtime — jest wycofywany i **generowany** z grafu
> (`--emit-handoff-rules`). `scripts/graph-validate.test.mjs` pilnuje, że zacommitowana wersja jest
> dokładnie tym, co produkuje graf — to jest dowód równoważności dla migracji, nie stały widok.
> Nie edytuj `handoff-rules.json` ręcznie; po przepięciu serwera na graf plik znika razem z emiterem.

## Status / następne kroki

- Koncepcja v3 — gotowa (5 launcherów + orchestrator, isolated .bat, async HITL, central telemetry).
- Skeleton działający: launchery, dashboard, telemetry store, prompt library, squads code-audited 2026-08-03.
- W toku: agent-intelligence integration (notebook → raporty per-squad), external prompt editor wiring.
- Patrz: [STATE.md](STATE.md) — pełna historia faz A→G.
