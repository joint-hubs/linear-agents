# Fenix

Fenix to wieloagentowy workflow, który łączy Linear z Claude Code: wyspecjalizowani agenci przerabiają tickety Linear w pętli, z minimalną ingerencją człowieka. Każdy agent startuje z izolowanego `.bat` — z własnym providerem/modelem i własnym `CLAUDE_CONFIG_DIR` — a human-in-the-loop działa **async** przez metadane Lineara (labelki, statusy, komentarze). Cel: maksymalne odciążenie przy minimalnym koszcie, całość widoczna na centralnej telemetrii (SQLite, port 7331).

Są **dwa tryby pracy**. *Standalone* — sam odpalasz każdy skład, a przekazania idą przez Lineara. *Nadzorowany* — odpalasz wyłącznie `bin/supervisor.bat`: jeden agent robi triage issue, uruchamia składy jako headlessowe procesy potomne w izolowanych worktree'ach i przekazuje Ci każdą decyzję. Nie otwierasz terminala dziecka.

## Pipeline e2e

```
PLAN ──▶ DEV ──▶ REVIEW ──▶ TEST ──▶ CADENCE
                                    (co tydzień)

SUPERVISOR ──steruje──▶ PLAN · DEV · REVIEW · TEST     (tryb nadzorowany)
```

- **PLAN** — discovery: wpis z `planning/inbox/` (np. voice memo) → spec → ticket w Linearze.
- **DEV** — podbiera task z `Todo`, robi branch, implementuje, wystawia na `In Review`.
- **REVIEW** — first-pass + security + deep review (max 2 rundy w standalone; w trybie nadzorowanym limit działa inaczej — patrz niżej); task wraca albo idzie dalej.
- **TEST** — deploy na stage, testy syntetyczne, zamknięcie jako `Done`.
- **CADENCE** — cykliczny (co tydzień): digest, retrospektywa, refresh roadmapy.

## 7 elementów (5 składów + orchestrator + supervisor)

| # | Agent | Launcher | Trigger | Rola |
|---|---|---|---|---|
| 0 | CADENCE | `bin/cadence.bat` | cron weekly | digest + retro + roadmap refresh |
| 1 | PLAN | `bin/plan.bat` | voice memo + `planning/inbox/` | discovery → spec → pushed |
| 2 | DEV | `bin/dev.bat` | task w `Todo` | pick → branch → kod → In Review |
| 3 | REVIEW | `bin/review.bat` | task w `In Review` | first-pass + security + deep |
| 4 | TEST | `bin/test.bat` | task `stage:testing` | deploy → synthetic → Done |
| — | SUPERVISOR | `bin/supervisor.bat` | ręcznie, jedno issue | frontman: triage → spawn dzieci → relay każdego gate'a |
| — | ORCHESTRATOR | `bin/orchestrate.bat` | ręcznie | strategista (Atlas MCP), deleguje do launcherów |

## Tryb nadzorowany

`bin/supervisor.bat` to jedyny launcher trybu nadzorowanego, z którym rozmawia człowiek. Supervisor robi triage jednego issue, a potem prowadzi PLAN/DEV/REVIEW/TEST jako **headlessowe procesy `claude -p`**, każdy w osobnym `git worktree`. Sam nie ma subagentów — dzieci są procesami systemowymi, więc ich kontekst nigdy nie obciąża sesji Supervisora.

Co dokłada ponad tryb standalone:

- **Izolowane worktree** — jeden checkout na dziecko, więc dwa agenty nie mogą sobie nawzajem wejść w drzewo. Gdy issue należy do innego repo niż to, podaj `--repo <ścieżka>` do `supervisor-spawn.mjs`.
- **Concurrency per węzeł + backpressure** — limity z `nodes.<name>.concurrency` w `config/graph.json`. Spawn, który nie może wystartować, jest *wstrzymany* na dysku i zwalniany później, nigdy porzucany.
- **Budżety per etap** — `supervisor-budget.mjs` dzieli budżet issue na discovery/verification/synthesis. Etapy nie pożyczają od siebie: pieniądze zarezerwowane na sprawdzenie pracy są tym, co powstrzymuje przebieg przed zakończeniem z kodem, którego nikt nie zweryfikował.
- **Werdykty poparte dowodem** — każde znalezisko REVIEW musi wskazać artefakt. Runda dev↔review jest odrzucana, gdy się *powtarza* (ten sam diff, te same failujące testy), a nie gdy skończy się licznik — więc przebieg, który realnie posuwa się do przodu, nie jest ucinany na dwóch.
- **HITL przez pliki** — dziecko, które potrzebuje człowieka, zapisuje gate i kończy turę czysto; Supervisor przekazuje pytanie i **zapisuje odpowiedź, zanim ją dostarczy**.
- **Sprzątanie worktree na dwa klucze** — worktree jest odzyskiwane tylko wtedy, gdy TEST przeszedł **i** Ty powiedziałeś tak, i tylko dopóki drzewo zgadza się z odciskiem, który zatwierdziłeś.

Uzasadnienie i odrzucone warianty: [ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md). Przejście ręczne: [supervisor-e2e-checklist.md](docs/supervisor-e2e-checklist.md).

## Quickstart

```bat
copy .env.example .env   :: uzupełnij klucze (OpenRouter, Anthropic, Linear)
:: uzupełnij config/projects.json (repo↔projekt, GCP VM)
node scripts/bootstrap-linear.mjs   :: tworzy labelki/statusy/templates w Linear
bin\dashboard.bat        :: dashboard telemetryczny na :7331
bin\plan.bat             :: odpal agenta planowania (standalone)
bin\supervisor.bat       :: albo odpal tryb nadzorowany zamiast tego
```

## Stack

- **Claude Code** — każdy agent = izolowany `CLAUDE_CONFIG_DIR` + własny provider/model
- **Modele** — routing per rola w `config/models.json` (decyzja: [model-comparison-and-routing.md](docs/decisions/model-comparison-and-routing.md)). Cztery aliasy tierów, po których Claude Code rozwiązuje modele (`opus`/`sonnet`/`haiku`/`smallFast`), należą do **providera**, nie do launchera — `providers.<name>.tiers`, stosowane przez `scripts/provider-resolve.mjs`. Ma to znaczenie, bo Claude Code zabiera tier `sonnet` na własny klasyfikator uprawnień auto mode, więc slug, którego aktywny provider nie serwuje, psuje **każde** wywołanie narzędzia, a nie jedną rolę.
- **Telemetria** — SQLite schema v5 (`tool_facts` + `delegation_links` + `usage_facts`) → dashboard API na :7331 ([TELEMETRY-EXPLAINED.md](docs/TELEMETRY-EXPLAINED.md))
- **Code intelligence** — serwer MCP CodeGraph (`.mcp.json`) + nakładka CLI `scripts/code-intel.mjs`; patrz [AGENTS.md](AGENTS.md)
- **Linear** — 2 workspace (joi | pisi), sygnały przez labels + emoji + webhooki ([linear-signaling-protocol.md](docs/decisions/linear-signaling-protocol.md))

## Nowości 2026-Q3

- **Tryb nadzorowany** — `bin/supervisor.bat` + `scripts/supervisor-*.mjs`: headlessowe dzieci w izolowanych worktree'ach, concurrency per węzeł z backpressure, budżety per etap, werdykty REVIEW poparte dowodem, gate'y przez pliki, sprzątanie worktree na dwa klucze ([ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md))
- **Tiery modeli per provider** — cztery aliasy wyprowadzone z jedenastu launcherów do `providers.<name>.tiers`, więc przełączenie `LA_PROVIDER` przełącza je razem z nim, zamiast zostawiać wycelowane w modele, których nowy provider nie hostuje
- **Atrybucja kontekstu** — zmierzone, co naprawdę wypełnia okno kontekstu leada. Stała podłoga sesji to **34,6%** rachunku za cache-read, a 8,7k tokenów w niej to schematy czterech narzędzi, których headless dziecko nie może użyć. Przycinanie promptów okazało się złą dźwignią ([context-attribution-2026-08-26.md](docs/decisions/context-attribution-2026-08-26.md))
- **Orchestrator w repo** — `agents/orchestrator/` (strategist + 8 skills, Atlas MCP); config przeniesiony z `%LOCALAPPDATA%\hermes` do repo
- **Telemetria v5** — `tool_facts` + `delegation_links` + `usage_facts` w SQLite. Trace: transkrypty → sqlite → dashboard. Retencja: [check-transcript-retention.mjs](scripts/check-transcript-retention.mjs)
- **In-place prompt editor** — edycja promptów/agentów z UI dashboard, w tym zewnętrznych orchestrator root'ów (allowlist + symlink-safe; [prompt-editing.md](docs/ui/prompt-editing.md))
- **Agent intelligence** — [agent_intelligence.py](notebooks/agent_intelligence.py) czyta telemetrię SQL → self-contained HTML (n-gramy, embedding clusters, per-squad break-down)
- **CodeGraph code-intelligence** — serwer MCP w `.mcp.json` (zatwierdzenie per skład: `node scripts/mcp-enable.mjs --verify`) + nakładka CLI `scripts/code-intel.mjs`; patrz [AGENTS.md](AGENTS.md). Indeks sam się synchronizuje, bez hooka pre-commit

## Dokumentacja

- Koncept: [00-overview.md](docs/00-overview.md) · [FENIX_WORKFLOW.md](docs/FENIX_WORKFLOW.md)
- Jak uruchomić: [HOW-TO-RUN-AGENTS.md](docs/HOW-TO-RUN-AGENTS.md) · [STATE.md](docs/STATE.md)
- Supervisor: [ADR-0009](docs/adr/0009-supervisor-frontman-runtime.md) · [checklista e2e](docs/supervisor-e2e-checklist.md)
- ADR-y: [docs/adr/](docs/adr/README.md)
- Decyzje: [model routing](docs/decisions/model-comparison-and-routing.md) · [atrybucja kontekstu](docs/decisions/context-attribution-2026-08-26.md) · [squad-review](docs/decisions/squad-review-2026-07-27.md) · [code review](docs/decisions/code-review-2026-08-03.md) · [telemetry audit](docs/decisions/telemetry-data-audit-2026-08-03.md)
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

Wrapper uruchamia wszystkie `scripts/*.test.mjs` w kolejności i raportuje ile minęło. Każdy plik jest samodzielny (wystarczy `node`).

## Contributing

Zgłoszenia i PR-y — patrz [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencja

[MIT](LICENSE).
