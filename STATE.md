# STATE — stan budowy Fenix

> Reguła globalna #7. Następna sesja startuje stąd.

_Aktualizacja: 2026-06-23 (Fala A — backend bez wejść zewn.)_

## Zrobione (Fala A — backend, bez zewnętrznych wejść)
- ✅ Pełna dokumentacja koncepcji v2 w `docs/` (overview, 5 agentów, model-routing, design-review, signaling-protocol, REPO-STRUCTURE).
- ✅ 7 diagramów PlantUML (`docs/diagrams/`, `.puml` + zweryfikowane `.png`).
- ✅ 13 notatek research (`docs/research/`, snapshot z vault).
- ✅ Szkielet repo: README, ACCESS.md, STATE.md, .gitignore, .env.example, struktura katalogów.
- ✅ `config/` (projects/models/linear) — TEMPLATES z placeholderami.
- ✅ `bin/` launchery (.bat) — TEMPLATES.
- ✅ `agents/` (CLAUDE.md + settings.json ×5) — TEMPLATES.
- ✅ `scripts/render-diagrams.sh`, `scripts/bootstrap-linear.mjs` (skeleton), `ui/README.md`.
- ✅ `config/linear/templates/` — 4 issue templates (feature/bug/spike/tech) + README. Konsumowane przez bootstrap-linear.mjs.
- ✅ `scripts/cost-report.mjs` — w pełni zaimplementowany (zero-dep). Pull z OpenRouter `/api/v1/activity`, agregacja tokenów/kosztów per model, flagowanie >10% divergence. Flagi: `--since`, `--json`, `--dry-run`. Pro-review + 2 fixy.
- ✅ `config/models.json` — dodane `pricing` (USD/1M in/out) dla wszystkich 8 modeli.
- ✅ `config/projects.json` — zrestrukturyzowane: każdy projekt ma `workspace` (joi|pisi) + `repo` + `deploy:{type:gcp-vm, vm:TODO-vm-name}`. Fenix NIE mapuje na lambda. Dodane `platforms.lambda-gpu` (status deferred). Workspaces: Neo/AU/Fenix→joi, PISI→pisi (guess, do potwierdzenia).
- ✅ `bin/agent.bat` — refaktoryzacja: hardcoded role→model loops zastąpione czytaniem `config/models.map` (single source of truth). Utworzony `scripts/gen-model-map.mjs` (generuje models.map z config/models.json, 27 entries). Routing: review.security→kimi w models.json.
- ✅ `docs/adr/` — utworzone README.md + adr-template.md.
- ✅ `docs/ui/ux-design.md` — UX design v1 dla control-panel UI (Flash). Obejmuje: workspace switcher, agent launch+terminal-spawn, agent CONFIG editor (model pickers/projects/labels/states), token/cost dashboard, keys UI, signal views. **Sonnet refine** — zablokowany na Anthropic spend limit.

## W toku
- 🔄 `scripts/bootstrap-linear.mjs` — implementacja w trakcie (zero-dep Linear GraphQL, idempotentne provision labels/states/templates, `--dry-run`). **Kod gotowy, ale do uruchomienia potrzebuje klucza Linear API.**
- 🔄 **P0 safeguards** — do zrobienia w 5 CLAUDE.md (cost guardrail, idempotency, deploy rollback).

## Zablokowane na wejścia od Mateusza
1. **Linear workspace**: potwierdzenie JOI+PISI (projekty.json już workspace-keyed, ale guess na PISI→pisi).
2. **Bot `@flow`**: OAuth app + webhook endpoint (cloud/tunel).
3. **GCP VM**: nazwy VM/projekt/zone dla deploy.
4. **Klucze API (5)**: OpenRouter, Anthropic, Linear JOI, Linear PISI, bot OAuth → `.env`.
5. **UI**: decyzja potwierdzona — rozszerzyć `Desktop/experiments/0_linear` (z UX design v1).

## Następne kroki
1. **P0 safeguards** w 5 CLAUDE.md (możliwe bez kluczy — config + kod).
2. **Fala B** (potrzebuje kluczy + workspace): bootstrap-linear na żywo, smoke launcherów, pilot plan→dev.
3. Gdy klucze dostępne: wypełnić `.env` → `node scripts/bootstrap-linear.mjs --dry-run` → na żywo.

## Jak uruchomić (po konfiguracji)
`copy .env.example .env` → uzupełnij → `bin\plan.bat` (lub inny agent). Render diagramów: `bash scripts/render-diagrams.sh`.
