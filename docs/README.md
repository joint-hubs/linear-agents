---
type: index
status: active
tags: [type/index, area/ai, topic/linear, topic/workflow]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Linear AI Workflow — index

Wieloagentowy workflow oparty na **Linear + Claude Code**, uruchamiany z izolowanych `.bat`
(każdy agent = własny provider/model + własny `CLAUDE_CONFIG_DIR`). Cel: maksymalne odciążenie
przy minimalnym koszcie, HITL async przez metadane Lineara.

## Start tutaj
1. **[00-overview.md](00-overview.md)** — master: 5 elementów (CADENCE + 4 launchery), 4 statusy, task typing, P0 safeguards, escalation, izolacja `.bat`, otwarte wejścia konfiguracyjne.

## Agenci (specyfikacje)
- **[agent-0-cadence.md](agent-0-cadence.md)** — weekly digest + roadmap refresh + retro (pętla).
- **[agent-1-planner.md](agent-1-planner.md)** — voice+artefakty → discovery → DoR → spec(+ADR) → decompose+estimate → push.
- **[agent-2-dev.md](agent-2-dev.md)** — pick(dep-aware,WIP=1) → recon → env-check → plan → kod → In Review.
- **[agent-3-review.md](agent-3-review.md)** — first-pass+security ∥ deep(GLM-5.2), max 2 rundy.
- **[agent-4-test.md](agent-4-test.md)** — deploy GCP (health+rollback) → synthetic tests → Done.

## Decyzje i konwencje
- **[model-comparison-and-routing.md](model-comparison-and-routing.md)** — zweryfikowane benchmarki (≥5 źródeł/model) + routing kosztowy + mechanika providerów w `.bat`.
- **[design-review-and-gaps.md](design-review-and-gaps.md)** — sceptyczna krytyka: weak points / corner cases / braki + priorytety P0/P1/P2.
- **[linear-signaling-protocol.md](linear-signaling-protocol.md)** — komunikacja człowiek↔agent przez labelki/metadane/emoji/webhooki.

## Diagramy (PlantUML — `.puml` ładowalne, `.png` wyrenderowane i zweryfikowane)
| Plik | Co pokazuje |
|---|---|
| [00_overview](diagrams/00_overview.puml) | całość: 4 launchery, bramki, task typing, fork review, deploy+rollback |
| [01_linear_state_machine](diagrams/01_linear_state_machine.puml) | 4 statusy + zagnieżdżony In Review{Reviewing→Testing} + sygnały |
| [02_planning_pipeline](diagrams/02_planning_pipeline.puml) | PLAN: discovery→DoR→spec+ADR→estimate→idempotent push, 2 bramki HITL |
| [03_dev_agent](diagrams/03_dev_agent.puml) | DEV: dep-aware pick, type routing, async clarify, checkpoint, escalation |
| [04_review_test](diagrams/04_review_test.puml) | REVIEW (potrójny par, max 2 rundy) + TEST (deploy health+rollback, synthetic) |
| [05_cadence_loop](diagrams/05_cadence_loop.puml) | CADENCE: tygodniowa pętla domykająca linię w cykl |
| [06_signaling_protocol](diagrams/06_signaling_protocol.puml) | async human↔agent: needs:* + emoji + webhook (fix W3) |

**Render lokalny:** `java -jar ~/plantuml.jar -tpng diagrams/*.puml` (Java 21; diagramy state używają `!pragma layout smetana` — bez instalacji Graphviz).

## Status / następne kroki
Koncepcja v2 — gotowa. Do zrobienia przy budowie: `configs/*` (izolowane CLAUDE_CONFIG_DIR), `bin/*.bat`, `config/projects.json` (repo↔projekt, GCP VM, Lambda), bot `@flow` (OAuth+webhooks), control-panel UI (rozszerzenie `Desktop/experiments/0_linear`). Otwarte wejścia: patrz [00-overview §8](00-overview.md).
