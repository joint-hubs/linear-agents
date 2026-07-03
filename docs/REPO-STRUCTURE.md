---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/repo-structure]
created: 2026-06-23
updated: 2026-06-23
maturity: design-v2
---

# Struktura repozytorium `Fenix`

> Repo: `github.com/joint-hubs/linear-agents` (product name: Fenix). Implementacja + dokumentacja wieloagentowego
> workflow Linear×Claude Code. Ten plik = dokładny plan struktury, konwencje, co commitujemy,
> kolejność budowy.

## Drzewo
```
Fenix/
├── README.md                  # wejście: czym jest, quickstart, linki
├── ACCESS.md                  # loginy/porty/URL/gdzie sekrety (rule #6): bot @flow, GCP VM, Lambda
├── STATE.md                   # stan budowy: zrobione / w toku / jak uruchomić (rule #7)
├── .gitignore                 # .env, sekrety, settings.local.json, planning/*, node_modules
├── .env.example               # szablon kluczy (OPENROUTER/ANTHROPIC/LINEAR/GCP/LAMBDA)
│
├── docs/                      # cała koncepcja (źródło prawdy projektu)
│   ├── README.md              # indeks docs
│   ├── 00-overview.md         # master workflow
│   ├── REPO-STRUCTURE.md      # ten plik
│   ├── ACCESS.md              # loginy/porty/URL/sekrety (rule #6)
│   ├── STATE.md               # stan budowy: zrobione / w toku / jak uruchomić (rule #7)
│   ├── FENIX_WORKFLOW.md      # model workflowu (stany/labelki/DoR/DoD/escalation)
│   ├── HOW-TO-RUN-AGENTS.md   # operator runbook (kolejność launcherów + prompty)
│   ├── BUILD-BACKLOG.md       # plan wykonawczy (backlog zadań)
│   ├── agents/                # specyfikacje 5 agentów + dev-readiness
│   │   ├── agent-0-cadence.md … agent-4-test.md
│   │   └── dev-readiness.md
│   ├── decisions/             # decyzje/konwencje/krytyka
│   │   ├── model-comparison-and-routing.md
│   │   ├── design-review-and-gaps.md
│   │   ├── linear-signaling-protocol.md
│   │   └── cost-optimization.md
│   ├── ops/                   # devops: deploy + remote execution
│   │   ├── ci-cd.md
│   │   └── remote-agent-execution.md
│   ├── prd/                   # PRDy per squad + panel (prd-planning/development/review/testing/cadence, gantt-panel-prd, telemetry-panel-prd, prd-docs-to-linear-comments)
│   ├── plans/                 # plany implementacji (00-build-plan, dry-run-launcher-pattern, finish-squads-plan)
│   ├── adr/                   # Architecture Decision Records (0001–0005 + template)
│   ├── backlog/               # pozycje backlogu (model-candidates, pr-review-loop-release-versioning)
│   ├── ui/                    # kontrakty UI + mockup (ux-design-v3, observability-platform-plan, control-plane-plan, monitoring-collab-spec, mockups/)
│   ├── diagrams/              # *.puml (źródło) + *.png (render, zweryfikowane)
│   └── research/              # 13 notatek research (snapshot; kanon w Second Brain vault)
│
├── agents/                    # IZOLOWANE CLAUDE_CONFIG_DIR per agent (sedno izolacji)
│   ├── cadence/  plan/  dev/  review/  test/
│   │   ├── CLAUDE.md          # rola agenta (instrukcje; linkuje do docs/agent-*.md)
│   │   ├── settings.json      # permissions + mcpServers(Linear) + model defaults (BEZ sekretów)
│   │   ├── agents/            # subagenci (np. spec-review, retro)
│   │   └── skills/            # skille per agent (np. delivery-loop, refine)
│   └── (każdy = własny ~/.claude — zero mieszania z freestyle ani między sobą)
│
├── bin/                       # launchery Windows (.bat)
│   ├── _lib.bat               # wspólne: load .env, walidacja kluczy, launch claude
│   ├── cadence.bat plan.bat dev.bat review.bat test.bat
│
├── config/
│   ├── projects.json          # Linear project → repo path + deploy target (GCP VM / Lambda)
│   ├── models.json            # routing modeli per rola (źródło prawdy dla .bat/settings)
│   └── linear/
│       ├── labels.json        # grupy/labelki: type/ needs/ risk/ ai/ + flagi
│       ├── states.json        # 4 statusy + mapowanie
│       └── templates/         # Linear issue templates (parent epic, subtask) z DoR/DoD
│
├── scripts/
│   ├── render-diagrams.sh     # java -jar plantuml -tpng docs/diagrams/*.puml
│   ├── bootstrap-linear.mjs   # idempotentnie tworzy labelki/states/templates w Linear (API)
│   └── cost-report.mjs        # OpenRouter activity → koszt per task/agent (guardrail W6)
│
├── ui/                        # control-panel (later) — rozszerzenie Desktop/experiments/0_linear
│   └── README.md              # plan UI: workspace switch, agent launch, inbox artefaktów
│
└── planning/                  # runtime I/O (treść gitignored, .gitkeep zostaje)
    ├── inbox/                 # wejście PLAN: voice memo + artefakty
    └── briefs/                # wygenerowane briefy
```

## Konwencje
- **Izolacja:** każdy `.bat` ustawia `CLAUDE_CONFIG_DIR=agents/<agent>` → własne settings/agents/skills/MCP. Nigdy nie dziedziczy `~/.claude` (freestyle).
- **Sekrety poza gitem:** `.bat` czyta klucze z `.env` (gitignored) / zmiennych środowiskowych. `settings.json` zawiera tylko nie-sekretne: model ids, mcpServers, permissions.
- **Routing modeli:** źródło prawdy = `config/models.json`; odzwierciedlone w `.bat` (ANTHROPIC_MODEL + DEFAULT_OPUS/SONNET/HAIKU) i `settings.json`.
- **Linear metadane:** definicje w `config/linear/` (labelki/statusy/templates); bootstrap przez skrypt. Patrz [signaling-protocol](decisions/linear-signaling-protocol.md).
- **Język:** kod/commity/docs techniczne EN; treści user-facing do Mateusza PL (przez MiniMax M3).
- **Diagramy:** `.puml` to źródło; `.png` render lokalny (`scripts/render-diagrams.sh`, Java 21 + smetana).

## Co jest w gicie / poza
| W repo (commit) | Poza repo (.gitignore) |
|---|---|
| docs/, agents/*/CLAUDE.md+settings.json, bin/, config/*.json, scripts/, ui/ | `.env`, `agents/*/settings.local.json`, `planning/inbox/*`, `planning/briefs/*`, `node_modules/`, credentials |

## Kolejność budowy
1. **Teraz (szkielet):** docs (✓ przeniesione), struktura, README/ACCESS/STATE, config/*, bin/*, agents/* (templates), scripts/render-diagrams.
2. **Po podaniu 5 wejść** (workspace+bot `@flow`, projects.json, GCP VM, Lambda, klucze): wypełnić sekrety/configi, `bootstrap-linear.mjs`, P0 safeguards (cost/idempotency/rollback).
3. **Pilot:** 1 agent end-to-end (PLAN→Linear) ręcznie, potem DEV.
4. **UI:** control-panel (rozszerzenie 0_linear).
5. **Autonomia:** dopiero gdy P0 spełnione (patrz [design-review §6](decisions/design-review-and-gaps.md)).
