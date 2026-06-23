# Fenix

Wieloagentowy workflow **Linear × Claude Code**: osobni agenci (planowanie, development,
review, testy) + pętla cykliczna (CADENCE), uruchamiani z **izolowanych plików `.bat`**
(każdy = własny provider/model + własny `CLAUDE_CONFIG_DIR`). Cel: maksymalne odciążenie
przy minimalnym koszcie; human-in-the-loop **async** przez metadane Lineara.

## Mapa
- **Koncepcja:** [`docs/00-overview.md`](docs/00-overview.md) — start tutaj · [`docs/README.md`](docs/README.md) — indeks
- **Struktura repo:** [`docs/REPO-STRUCTURE.md`](docs/REPO-STRUCTURE.md)
- **Agenci:** [`docs/agent-0-cadence.md`](docs/agent-0-cadence.md) … [`agent-4-test.md`](docs/agent-4-test.md)
- **Decyzje:** [model routing](docs/model-comparison-and-routing.md) · [krytyka/luki](docs/design-review-and-gaps.md) · [protokół Linear](docs/linear-signaling-protocol.md)
- **Diagramy:** [`docs/diagrams/`](docs/diagrams/) (PlantUML + PNG)

## 5 elementów
| # | Agent | Launcher | Trigger |
|---|---|---|---|
| 0 | CADENCE | `bin/cadence.bat` | cron weekly |
| 1 | PLAN | `bin/plan.bat` | voice memo + artefakty (`planning/inbox/`) |
| 2 | DEV | `bin/dev.bat` | task w `Todo` |
| 3 | REVIEW | `bin/review.bat` | task w `In Review` |
| 4 | TEST | `bin/test.bat` | task `stage:testing` |

## Quickstart (po skonfigurowaniu)
```bat
copy .env.example .env   :: uzupełnij klucze
:: uzupełnij config/projects.json (repo↔projekt, GCP VM, Lambda)
node scripts/bootstrap-linear.mjs   :: tworzy labelki/statusy/templates w Linear
bin\plan.bat             :: odpal agenta planowania
```

## Status
Szkielet + pełna dokumentacja koncepcji (v2). Do wypełnienia: sekrety, `config/projects.json`,
bot `@flow` (OAuth+webhooks), UI. Patrz [`STATE.md`](STATE.md).

## Wymagania
Windows · Claude Code · Node 20+ · Java 21 (render diagramów) · klucze: OpenRouter, Anthropic, Linear.
