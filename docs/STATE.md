# STATE — linear-agents (pilotaż orkiestratora)

> Stan długiej pracy. Sesje wypadają z kontekstu — ten plik to tani start. Aktualizuj po każdej fazie.
> Orkiestrator: GLM-5.2. Plan wykonawczy: `docs/BUILD-BACKLOG.md`. Polityka: `~/.claude/memory/orchestration.md`.

## Ostatnia aktualizacja: 2026-08-08 — Prompt optimization (FOC-72): DEV + Fala A (4 mózgi) done

**Linear:** FOC-72 "[ FENIX ] prompt optimization" (In Progress). Cel: pisać prompty pod kątem modelu
językowego (GLM-5.2 / MiniMax / DeepSeek / Kimi), nie człowieka.

### Co zrobione
- **`cbc98e5`** — `agents/dev/CLAUDE.md` template (XML, hybryda EN/PL, few-shot, doubt_defaults,
  precedence_policy, budget drains). + FENIX_WORKFLOW / models pricing / gitignore freetext.
- **`6c4477c`** — `agents/dev/agents/*.md` (6 subagentów) lean EN/XML + routing ids z `config/models.json`;
  bin/dev*.bat `z-ai/glm-5.2`.
- **Fala A (ten commit)** — `agents/{review,cadence,plan,test}/CLAUDE.md` przepisane wg template DEV:
  | squad | lines | key semantics kept |
  |-------|------:|--------------------|
  | review | 174 | 3-pass parallel NEVER serialize; merge deep>security>first-pass; only `issue:` blocks; max 2 rounds |
  | cadence | 164 | lead `flow-db ingest` step0; bounces==2 vs >2; subagent-share <40% action item; 1 digest/week PL |
  | plan | 178 | HITL = interactive REPL (NOT async needs:*); GATE1/GATE2 sync; DRAFT JSON path; DRY-RUN |
  | test | 125 | health-check+auto-rollback mandatory; synthetic data; PASS→Done / FAIL→root-cause→In Progress |
- **Decyzja shared ≥40% bloku:** **inline-verbatim** (ten sam EN budget-drains + target ≥40% w każdym mózgu;
  tag XML squad-prefixed). Zamknięte.

### 7 zasad pisania promptów (Z1–Z7)
Z1 EN = logic-carrier, PL = output/runbook | Z2 XML-tags | Z3 reguły warunkowe + stop-conditions;
persona = 1 linia | Z4 negacja → pozytyw + trade-off; `NEVER` tylko guardraile | Z5 lean, merguj duplikaty |
Z6 few-shot w `<examples>` | Z7 `<doubt_defaults>` + precedence/rationale gdzie trzeba.

### Kontekst do wznowienia (NASTĘPNY KROK)
**DEV + Fala A — KOMPLETNE.** Dalej:

- **Fala B (P2, ~22 subprompty)** — `agents/{review,cadence,plan,test}/agents/*.md` (+ inne poza dev).
  Template = `agents/dev/agents/*.md` (już lean EN/XML). **Skip `agents/dev/agents/*`.**
- **Fala C (P3)** — `~/.claude/memory/orchestration.md`, `~/.claude/skills/refine`,
  `skills/git-checkpoint`, `~/.claude/CLAUDE.md` — reframe+EN (XML często już jest).
- **Fala D (P3)** — `docs/prd/*`, `docs/agents/agent-{0,1,3,4}` — tylko przy rework squada.

**Luki:** `~/.claude/skills/graphify/SKILL.md` pusty (dangling). Root `CLAUDE.md` = GitNexus auto — nie dotykać.

### Jak wrócić
1. Ten plik (`docs/STATE.md`) — start.
2. Template mózg: `agents/dev/CLAUDE.md`. Template subagent: `agents/dev/agents/implementer.md`.
3. Commity: `cbc98e5` (DEV brain), `6c4477c` (DEV subagents), ten (Fala A).
4. FOC-72 Linear comment — pointer sesji.

---

## (wcześniej) 2026-07-26 — Desktop launcher + zakładka „Konfiguracja składów" (dowiezione, zweryfikowane e2e).

## Biblioteka promptów + czytanie konwersacji (2026-07-26)

PRD: `docs/ui/prompt-library.md`.

**Dowiezione:**
- `scripts/prompt-library.mjs` — drzewo (6 intencji × 5 składów), instrukcje ról i leadów,
  warunki wejścia; kickoff bierze z `KICKOFF_TEMPLATES` (jedno źródło, zero duplikatu),
  modele z `readSquadConfig`. Walidacja squad/role chroni przed path traversal.
- Endpointy: `/api/prompts`, `/api/prompts/role`, `/api/prompts/lead`, `/api/prompts/runs`.
- `extractAgentTurns`: opcje `includeUser` i `maxTextLen:null` + pole `role` na każdej turze.
  Domyślne wywołanie bez zmian (Flow i flow-db działają jak dotąd).
- Zakładka **Prompty** — drzewo, liść składu (prompt + Kopiuj + dry-run + Uruchom + warunek
  wejścia + skład + ostatnie przebiegi), liść roli (model, uprawnienia, instrukcja).
  `LogDrawer` wyeksportowany z `Flow.jsx` i użyty ponownie — bez duplikacji komponentu.

**Znalezione i naprawione przy weryfikacji:** `extractAgentTurns` z `includeUser` zwracał tury
`user` bez tekstu — na realnym przebiegu **48 z 56** to puste koperty `tool_result`, które
renderowałyby się jako puste wiersze rozmowy. Dodany filtr + test.

**Weryfikacja e2e:** drzewo → DEV → wpisanie `JOI-53` → prompt podstawiony → dry-run zwrócił
finalny prompt (sklejony `' | '` jak przy realnym starcie) bez otwierania okna → szuflada
konwersacji z etykietami TY (8) / AGENT (101).

**Testy:** prompt-library 47 · flow-turns 11 · squad-config 76 · telemetry-store 11 ·
telemetry-ingest 2 · telemetry-concurrency 1 · _test_flow 13 · ui/_test_utils 47 — zielone.

**Znane szlify (nieblokujące):** `<task-notification>` (powiadomienie o powrocie subagenta)
renderuje się jako wypowiedź „TY" — do odróżnienia osobną etykietą. Podgląd uruchomienia pokazuje
prompt, ale nie planowany `.bat`.

### Poprawki kosztów (2026-07-26, zgłoszone przez Mateusza ze zrzutów)

1. **Prompty pokazywały `$0.00`** przy każdym przebiegu. API zwracało poprawne wartości —
   `Prompts.jsx` czytał `costValue(r.totals)`, a `/api/prompts/runs` zwraca kształt PŁASKI.
   Fix: endpoint dokłada `partialCostUSD` + `unpricedUsageCount`, UI używa `fmtCost(r)`
   (ten sam prefiks „≥" co w Costs). Po fixie: `$21.64` / `$14.45` / `$27.60`.
2. **`CACHE SAVED $0.00`** przy 89.9% hit rate i 1,114,359,842 tokenach z cache.
   Przyczyna: `telemetry-store.mjs` miał **zahardkodowane `cacheSavingsUSD: 0`** — przy przejściu
   odczytu na SQLite zgubiono wyliczenie, które stara ścieżka (`ledger.mjs`) robiła poprawnie.
   Fix: liczone per model z `model_prices` danego `price_set_id` przez istniejące `resolvePrice()`,
   sumowane w `querySummary`, przeliczane przy repricingu. Po fixie: **$1641.64**
   (sanity check: $1.473 na 1M tokenów — GLM daje $1.26, Opus $4.50, miks się zgadza).
   Test dopisany do `telemetry-store.test.mjs` (12 testów).

## Dashboard launcher + konfiguracja składów (2026-07-26)

PRD: `docs/ui/dashboard-launcher-and-squad-config.md`.

**Dowiezione:**
- **Single-process dashboard:** `telemetry-server.mjs` serwuje `ui/dist` (statyka + SPA fallback +
  MIME + ochrona path traversal + 503 z instrukcją gdy brak builda). Ścieżki `/api/*` nigdy nie
  trafiają do statyki. Koniec z osobnym Vite w codziennym użyciu.
- **Ikona na pulpicie:** „Fenix Dashboard" → `wscript` → `bin/dashboard-hidden.vbs` →
  `bin/dashboard.bat` (health-check → start w tle bez konsoli → poll → otwórz przeglądarkę).
  Stop: `bin/dashboard-stop.bat` (ubija po porcie, nie po nazwie procesu).
  Ikona generowana bez zależności: `scripts/gen-icon.mjs` (czysty zlib+PNG+ICO, 4 rozmiary).
- **Zakładka „Konfiguracja"** (`/squad-config`): edycja modelu leada i wszystkich subagentów per
  skład + panel cennika, dry-run podgląd diffa, potem zapis. Zapis idzie do plików repo
  (`bin/*.bat`, frontmatter ról, `config/models.json`), działa od następnego uruchomienia składu.
- **`scripts/squad-config.mjs`** — read/write/validate, zapis atomowy, zachowuje CRLF i całą
  resztę frontmatteru; dla `plan.bat` rusza tylko gałąź OpenRouter, nie NATIVE.

**Błędy złapane przy weryfikacji (nie przez testy jednostkowe):**
1. Skrót wskazywał poziom nad repo (`Split-Path -Parent` ×2) — martwy skrót.
2. `dashboard.bat` używał `pushd/popd`, więc procesy dziedziczyły zły CWD.
3. `pricing._doc` (klucz opisowy w `models.json`) trafiał do UI jako wiersz cennika i wracał w
   POST → walidacja odrzucała każdy zapis (400). Fix: klucze `_*` filtrowane przy odczycie,
   zachowywane przy zapisie; zapis `models.json` jest merge'em, nie nadpisaniem.

**Weryfikacja e2e:** uruchomienie przez skrót z pulpitu → `:7331` (tylko ten port) → zakładka
Konfiguracja → zmiana `dev/implementer` → podgląd → Zastosuj → `agents/dev/agents/implementer.md`
zmieniony (dokładnie 1 linia, frontmatter i treść nietknięte), `models.json` zachował `_doc`,
`ids`, `routing`, `providers`, `fallback`. Zmiana testowa cofnięta.

**Testy:** squad-config 76 · telemetry-store 11 · telemetry-ingest 2 · telemetry-concurrency 1 ·
ui/_test_utils 47 — wszystkie zielone, zero regresji na Telemetry v2.

## Telemetry v2 — centralny tracing run/task/worktree (implemented, 2026-07-24)

PRD: `docs/prd/telemetry-v2-central-tracing-prd.md`.

**Zweryfikowana diagnoza:**
- `run-manifest start` zapisuje `cwd` z katalogu uruchomienia, ale Git odpytuje zawsze w root `linear-agents`; `cwd` i `gitBranch` mogą opisywać dwa różne repo.
- Manifest nie aktualizuje workspace/ref/HEAD po `EnterWorktree`. Transkrypt ma poprawne eventy `relocated`/`worktree-state`, lecz dashboard ich nie modeluje.
- Realny run FOC-36: manifest `cwd=office`, `gitBranch=main`, potem sesja pracuje w `office/.claude/worktrees/foc-36-design-system` na branchu `foc-36-design-system`.
- FOC-36 zrobił cold start ~236 s po starcie manifestu, poza limitem 120 s dla aktywnego late discovery; Live może pokazywać `$0.00` do końca/reconcile.
- Jawny `run-manifest tag` poprawnie zapisał `FOC-36`; branch ma zostać tylko niepewnym fallbackiem legacy.
- Istniejący `.state/flowdb/flow.db` jest ręcznie zasilaną, niepełną projekcją. Główne API nadal wykonuje `ledger.scanRuns()` i skanuje pliki na żądanie.
- Brak ceny modelu daje dziś cichy koszt `0`, zamiast `pricing_missing`.

**Decyzje Mateusza:**
- jedna baza użytkownika na komputerze: `%LOCALAPPDATA%/linear-agents/telemetry/telemetry.sqlite`;
- surowe eventy/transkrypty zostają audytem, SQLite jest centralnym indeksem/projekcją;
- domyślny koszt historyczny według snapshotu cen z runa + opcjonalny reprice aktualnymi cenami;
- explicit task link z launch/pick jest autorytatywny; kickoff/branch tylko fallback legacy z confidence;
- immutable spool + idempotentny ingest + rotacja; eksport JSONL/CSV/SQLite.

**Wdrożone:**
- `scripts/telemetry-store.mjs`: user-level SQLite (WAL), immutable event spool, idempotentne source offsets, run/session/worktree/task/usage/cost projections, snapshot cen, reprice `current`, health i eksport.
- `scripts/telemetry-hook.mjs` + `SessionStart` hook w 5 squadach: exact `LA_RUN_ID -> CLAUDE_CODE_SESSION_ID`, bez dopasowania po czasie.
- `run-manifest.mjs`: Git branch pobierany z obserwowanego `cwd`, dual-write manifestu i task linku do centralnego store.
- `scripts/telemetry-ingest.mjs`: backfill legacy, incrementalny parser transkryptów, eventy `relocated`/`worktree-state`, lead/subagent usage; discovery legacy preferuje bezpośredni ślad `runId` w transkrypcie.
- `telemetry-server.mjs`: `/api/runs`, `/api/summary`, `/api/cost-per-task`, `/api/live`, `/api/budget` i `/api/flow` czytają wyłącznie SQLite; serwer odmawia startu bez `node:sqlite`. `LA_TELEMETRY_READ_SOURCE=files` (legacy files-fallback, `buildSummary()`, flow-db.mjs jako runtime lane) usunięte 2026-07-30 — zero użytkowników, zero testów, patrz `docs/decisions/code-audit-2026-07-30.md`. `/api/telemetry/health`; startup backfill pustej bazy + spool/incremental ingest co 15 s.

**Weryfikacja:** centralny backfill zaimportował 99 manifestów, 333 pliki transkryptów i 23k+ usage events. FOC-36 został odzyskany z exact `sessionId`, worktree `office/.claude/worktrees/foc-36-design-system`, branch `foc-36-design-system`, task `FOC-36` i kosztem `$5.19782782`. Health raportuje 0 pending eventów; brakujące transkrypty oraz modele bez ceny są jawne jako quality issues, nie `$0.00`.

**Self-review hardening (2026-07-24):** schema v2 przypina price set przy `run.started`; `byTask`/Flow trace liczą każdą turę według task linku aktywnego w jej timestampie (pre-pick pozostaje untagged); legacy `taskIdAuto` odzyskuje czas komendy `run-manifest tag`; repo grupuje wszystkie worktree po `git-common-dir`; detached HEAD jest osobnym ref type. Ingest jednego pliku jest transakcyjny, usage używa `INSERT OR IGNORE`, cursor jest monotoniczny, replay ma cross-process lock, a eksport SQLite używa `VACUUM INTO` (WAL-safe). Flow trace/patterns czytają centralną bazę zamiast ręcznie zasilanego FlowDB. UI pokazuje niepełny koszt jako `≥$known`, nie `$0.00`.

Final review: wieloprocesowy test potwierdził 1× event, 1× usage i 1× replay przy równoległych procesach; ujawnił i domknął lock przy równoczesnym pierwszym `openTelemetryDb` (busy timeout przed WAL). Częściowy bootstrap jest automatycznie dokańczany przez porównanie liczby manifestów/runów (`LA_TELEMETRY_FORCE_BACKFILL=1` wymusza pełny reindex). Awaryjny `files` mode ma tę samą semantykę `costUSD:null + partialCostUSD`; legacy ambiguity jest trwałym quality issue.

**Operator:** baza i komendy są w `docs/ACCESS.md`. Wymagany Node `22.5+`. Przy pierwszym starcie pustej bazy server robi automatyczny backfill; ręcznie: `node scripts/telemetry-ingest.mjs backfill --json`.

## Faza G — Platforma v1 (JOI-51) dowieziona (2026-07-03)

**Pierwsza wersja platformy obserwowalności + control-plane dowieziona na branchu `feat/observability`.** Branch wypchnięty do `origin` i otwarty **PR #1** → `main`: https://github.com/joint-hubs/linear-agents/pull/1 (80 commitów, 118 plików, ~16.9k LOC). Komentarz podsumowujący opublikowany na **JOI-51** (tag `pr:joi-51-delivery`, comment id `3483c935`). Stan taska NIE ruszony — per konwencje statuty przesuwa Mateusz; po merge'u → Under Review / Done.

Budowano na istniejącym backendzie telemetrycznym (Faza E) — **rozszerzono, nie przebudowano**. Kontrakty źródłowe: `docs/ui/observability-platform-plan.md`, `docs/ui/ux-design-v3.md` (F1–F5 + gapy B1–B3), `docs/ui/control-plane-plan.md` (L1), mockup `docs/ui/mockups/observability-v3.html`.

### Co wjechało
- **Telemetry backend** (`scripts/`): `run-manifest.mjs` (manifest + sessionId/transcript discovery) · `ledger.mjs` (cost per model/agent/task, cache_read/cache_creation aware) · `telemetry-server.mjs` (`:7331` — `/api/runs`, `/api/runs/:id`, `/api/summary` w/ `byTask`, `/api/cost-per-task`, `/api/live`, `/api/budget`, `/api/linear/queue`) · `cost-per-task.mjs`/`cost-guard.mjs`/`cost-report.mjs`/`backfill-task-ids.mjs`/`reconcile-runs.mjs` · headless Linear layer (`linear-client`/`linear-query`/`linear-ops`/`linear-push`/`bootstrap-linear`/`publish-linear-comment`/`mock-linear`) · `dev-branch.mjs`/`launch.mjs`/`review-round.mjs`/`check.mjs` (linter).
- **Dashboard** (`ui/`, Vite+React, standalone): 6 ekranów na żywym API — **Live** (KPI strip + active cards) · **Timeline** (gantt aktywności agentów, multi-repo) · **Runs + RunDetail** (filtry, URL params, per-agent/model breakdown, `ambiguous` badge) · **Costs** (period toggle, by-agent/by-model/by-day, byTask links) · **Budget** (over-budget + per-task alerts) · **Tasks** (5. tab, 3 sekcje, launch modal).
- **Control-plane**: `POST /api/launch` (local auto-spawn squadu + ready prompt) · `handoff-rules.json` + matcher + workspace routing · CSRF Origin check + spawn hardening (injection-resistant `taskId`).
- **Squady**: delegation policy P0 + worker/flash cheap subagents we wszystkich squadach.
- **Docs**: `HOW-TO-RUN-AGENTS.md` (operator runbook), ADRy 0002–0005, `decisions/cost-optimization.md` (93% lead cost analysis), PRDy (`telemetry-panel-prd`, `gantt-panel-prd`), kontrakty UX + mockup.

### Subtaski dowiezione w tej fali
JOI-52 (dekompozycja) · JOI-62 (B1 manifest passthrough + failed status + JOI branch regex) · JOI-63 (Live rework) · JOI-64 (Timeline gantt) · JOI-65 (Runs filtry + RunDetail meta) · JOI-66 (Costs period toggle) · JOI-67 (Budget panel + `/api/budget`) · JOI-68 (`handoff-rules.json` + `/api/linear/queue`) · JOI-69 (`/api/launch` + CSRF + spawn hardening + tests) · JOI-70 (Tasks screen) · JOI-71 (UI hardening: noopener + error-banner + utils tests).

### Weryfikacja
- **E2E**: pipeline udowodniony na realnym tasku **PISI-98** (22+ runów w `.state/runs/`).
- **Testy zielone**: `ledger` 32/32 · `linear-push` 24/24 · `utils` 25/25 · `launch` 37/37.
- `node scripts/check.mjs` czysty.
- Dashboard czyta live dane z `.state/runs/` przez API.

### Jak uruchomić
```bash
node scripts/telemetry-server.mjs   # :7331
cd ui && npm install && npm run dev # http://localhost:5173
```

### Po stronie Mateusza
- **Review + merge PR #1**.
- **Stan JOI-51** — przesunięcie po merge'u (Under Review / Done).
- **Niezatwierdzona zmiana `agents/test/settings.json`** w working tree (czysta reformatyzacja JSON, zero zmiany semantycznej) — nie weszła do PR; do decyzji: zostawić / zcommitować osobno / odrzucić (`git checkout -- agents/test/settings.json`).

### Otwarte na v2 (poza scopem v1)
- Control-plane **L2+**: remote-interactive w tmux / GCP VM (`control-plane-plan.md`).
- Retencja `.state/runs/` (rotacja po N dni/runów).
- Reconcile `cache_read` vs `cost-report.mjs` (OpenRouter Activity) w Costs.

### Zrobione
- **T-A1 SPIKE — DONE.** Architektura „model per subagent" **DZIAŁA**: explicit OpenRouter slug we
  frontmatter `model:` honorowany (pass-through do API); aliasy `opus/sonnet/haiku` mapują przez
  `ANTHROPIC_DEFAULT_*_MODEL`. Warunek: `CLAUDE_CODE_SUBAGENT_MODEL` nie ustawiony. ADR:
  `docs/adr/0002-subagent-model-mechanism.md` (Accepted). Dowód: `.spike-a1`/`.spike-a2` (Test 3a/3b).
- **T-A1-fix (bug #1) — DONE+verified:** `bin/_lib.bat` base URL `…/api/v1`→`…/api` (było 404 we
  wszystkich squadach; SDK dopisuje `/v1/messages`). Weryfikacja: `set ANTHROPIC_BASE_URL` = `https://openrouter.ai/api`.
- **T-A1-fix (bug #2) — DONE+verified:** `set "CLAUDE_CODE_SUBAGENT_MODEL="` w `_lib.bat` (dziedziczony
  override nadpisywał frontmatter). Weryfikacja: var `not defined` po `call _lib.bat`.
- **T-A1-fixb (bug #3) — DONE+verified:** wszystkie `bin/*.bat` miały LF-ending → cmd nie parsował
  (`setlocal`→`etlocal`). Skonwertowane LF→CRLF + `.gitattributes` (`*.bat/*.cmd text eol=crlf`).
  Weryfikacja end-to-end: `bin\dev.bat -p "Reply OK"` → model replied `OK`, zero błędów (OpenRouter 200).
- **BACKLOG/STATE** zaktualizowane; T-A1 odhaczony; T-A1-fix/T-A1-fixb dopisane.

### Zrobione (cd. — Faza A, równolegle DeepSeek Flash, verified + Pro review)
- **T-A2** `scripts/check.mjs` — consistency linter. `node scripts/check.mjs` → `OK: 4 checks, 0 violations`;
  negative-test (zły model) → `DRIFT` (łapie drift). Pro review: frontmatter quote-stripping fix applied.
- **T-A3** `planning/inbox/sample.md` — WIP-age tracking w CADENCE digest, ~4 subtaski, realne artefakty.
- **T-A5** `scripts/cost-guard.mjs` + wire do `cost-report.mjs` (pre-flight + loop check, marker `.state/over-budget.json`).
  5/5 testów + `--dry-run` bez regresji.
- **T-A6** `scripts/utils.mjs` — `idempotentCreate` (store `.state/created-keys.json`, atomic write) + `reviewRound` (escalation).
  25/25 testów. Pro review: input-validation fix (TypeError brak key/existsFn) + race TODO.
- **T-A6b** (follow-up, post-pilot): race-condition hardening (lock/CAS) — task #9, odroczone.

### Zrobione (cd.)
- **T-A4 PLAN dry-run — DONE+verified (2026-06-24).** Realny squad `bin\plan-dry.bat` (lead Opus, OpenRouter)
  na `planning/inbox/sample.md`: discovery(minimax)→spec(glm-5.2, 18KB tech design + ADR-0003)→spec-review→
  decomposer(minimax, draft JSON 14.4KB). Mock `scripts/mock-linear.mjs` waliduje + idempotentny ingest (reużywa T-A6).
  **AC spełnione:** 9 subtasków (≥3) z type/estimate(t-shirt)/AC(Given/When/Then)/slice; DoR (rejected=0, <3→fail);
  idempotencja (re-ingest → `idempotent_skip=1`, 1 brief, 1 store entry, 0 duplikatów); check.mjs zielony.
  Tryb normalny squadu nietknięty (push zostaje realny dla Fazy C).
- **Bug-fixy w locie (T-A4):** (1) `plan-dry.bat` KICKOFF — multiline `^` continuation rozbijał prompt → cmd wykonywał
  `Read`/`Run…` jako komendy + `>` redirect; naprawione na 1 linię (literał `<>` w cudzysłowach). (2) `decomposer.md`
  `tools:` brak `Write` → nie mógł zapisać draft JSON; dodano `Write`.

### Zrobione (cd. — Faza B, provider mechanism / native profil, równolegle DeepSeek Flash, verified)
- **T-B1** `bin/_lib.bat` NATIVE branch — `if defined NATIVE` ⇒ jawnie czyści `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`API_KEY`
  (hardening: env sesji orkiestratora niesie Ollama `127.0.0.1:11434` — bez czyszczenia native cicho trafiłoby do Ollamy);
  `else` ⇒ istniejący OpenRouter (BASE_URL=openrouter.ai/api, AUTH=OPENROUTER_API_KEY, walidacja .env). `CLAUDE_CODE_SUBAGENT_MODEL`
  czyszczony + `API_TIMEOUT_MS` w obu trybach. Verify: NATIVE ⇒ BASE_URL not defined (cleared); no-NATIVE ⇒ openrouter.ai/api.
- **T-B2** `config/models.native.map` (PLAN 6 ról = bare slot aliasy `opus`/`sonnet`/`haiku`) + `bin/plan.bat` conditional
  (`NATIVE`→`ANTHROPIC_MODEL=opus`, `DEFAULT_SONNET=sonnet`, `SMALL_FAST=haiku`; else→OR slugi nietknięte) + nowy `bin/plan-native.bat`
  wrapper (`set NATIVE=1` → `call plan.bat %*`). `scripts/check.mjs` rozszerzony o lint `models.native.map` (check 5).
  Verify: `check.mjs` → `OK: 5 checks, 0 violations`; native `main=opus small_fast=haiku`, OR slugs unchanged; negative-test łapie.
- **T-B3** fallback = **komunikat, nie auto-relaunch** (per Mateusz: dwie osobne wersje, user sam wybiera). Po `claude %*` w `plan.bat`:
  `if defined NATIVE if errorlevel 1 echo Native (Anthropic subscription) run failed. Re-run with OpenRouter: bin\plan.bat %*`.
  Verify: smoke `plan-native.bat -p "Reply OK"` → hint wyświetlony — PASS.
- **T-B1-fix / T-B2-fix (bugfixy po smoke diagnozie):** env orkiestratora wyciekał do squad subprocess — `ANTHROPIC_DEFAULT_*_MODEL=glm-5.2:cloud`,
  `ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-pro:cloud`. `_lib.bat` czyścił tylko BASE_URL/AUTH/API_KEY/SUBAGENT_MODEL. Fix #1: `_lib.bat` NATIVE czyści WSZYSTKIE
  `ANTHROPIC_*_MODEL`. Fix #2: `plan.bat` NATIVE ustawia **realne Anthropic ID** (NIE bare aliasy — claude nie rozwiązuje `opus`/`sonnet`/`haiku` jako main model;
  real ID tak): `ANTHROPIC_MODEL=claude-opus-4-8`, `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8`, `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001`, `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001`. `models.native.map` = real ID; `check.mjs` allowed = real ID. `check.mjs` 5/0.
- **Realny smoke native — GREEN (Opus 4.8):** `bin\plan-native.bat -p "Reply with exactly: OK"` → `OK`, EXIT=0, `main=claude-opus-4-8`. Wymagany jednorazowy setup:
  skopiować `~/.claude/.credentials.json` → `agents/plan/.credentials.json` (squad używa izolowanego `CLAUDE_CONFIG_DIR=agents/plan`, nie widzi domyślnego loginu;
  plik gitignored). Mateusz = **Claude Pro** (`oauthAccount.organizationType=claude_pro`), ale **Opus 4.8 działa na Pro Claude Code z real ID** (bare alias nie).
- **Ograniczenie native squad (follow-up T-B4):** subagent `agents/plan/agents/*.md` mają frontmatter `model:` = OR slugs (minimax/glm/deepseek) → w native
  Anthropic ich nie ma → realny squad native (z subagentami) wymaga migracji frontmatter na aliasy/real ID (T-B4). Smoke `-p` (lead only) green; pełny squad native = Faza C+/T-B4.

### Zrobione (cd. — Faza C, Linear live)
- **T-C1 bootstrap Linear live — DONE+verified (2026-06-24).** Team `FEN` (id `08722f3a-3bc3-4d91-a748-cb109348a231`, workspace jointhubs), projekt docelowy `linear-agents` (id `eecedf9f68d4`).
  - `.env`: `LINEAR_API_KEY` (reuse z hermes `.env`) + `LINEAR_TEAM_KEY=FEN`. Bot `@flow` odłożony (MVP: push jako user).
  - **Schema drift fix:** `bootstrap-linear.mjs` (Faza A, nigdy live) był na starym GraphQL schema — `labelGroups`/`labelGroupCreate`/`labelCreate`/`issueTemplateCreate` NIE istnieją. Przepisany do current schema: grupy label = `issueLabelCreate` z `isGroup:true`, child labels = `parentId`, stany = `workflowStateCreate` (✓), szablony = `templateCreate` (**deferred** — `templateData` JSON shape nieznany, 0 przykładów w workspace; push tworzy description ręcznie, nie blokuje).
  - **Live run:** utworzono 4 grupy label (type/needs/risk/ai) + 15 child labels + 7 flag (dor-ok/dod-ok/escalated/over-budget/transcript-uncertain/blocked/stage:testing) + stan „In Review" (Todo/In Progress/Done/Canceled istniały default → skipped). Hard-delete default Linear labels `Feature`+`Bug` (konflikt case-insensitive z `type:feature`/`type:bug`); `Improvement` zostaje (nie konfliktuje).
  - **Idempotency verified:** re-run → 0 created, all skipped (⏭️), no duplicates.

### Zrobione (cd. — Faza C, PLAN push live = M3)
- **T-C3 / T-C3a–d — DONE+verified (2026-06-24) = Milestone M3.** Push do Linear headless przez **GraphQL + LINEAR_API_KEY** (NIE MCP — patrz T-C2).
  - **Decyzja T-C2 (reframe):** MCP linear (`mcp.linear.app/sse`) wymaga interaktywnego OAuth Linear (browser) → NIE ładuje się w headless `claude -p` (ładowały się tylko claude.ai cloud connectors Canva/Figma/Gmail/Calendar/Spotify; OR mode blokuje connectors w ogóle). Mateusz zgodził się na **opcję B: GraphQL przez API key** (headless). MCP linear ścieżka zarzucona dla MVP. Zgoda Mateusza: „zezwalam na external write", „Rób wszystko przez API".
  - **T-C3a** `config/projects.json` — wpis `linear-agents` (workspace joi, teamKey FEN, projectId pełny UUID `c2670973-2ce0-43c7-9d91-0ba3ec427850` rozwiązany live po nazwie „Linear Agents"; short-id `eecedf9f68d4` z URL = tylko prefix/shortcode, NIE pełny UUID — przyczyna pierwotnego `projectId must be a UUID`).
  - **T-C3b** `scripts/linear-push.mjs` (nowy, ESM, zero deps) — ingest brief JSON → `issueCreate` (GraphQL): parent epic + N subtask sub-issues (parentId), resolve live team FEN + project „Linear Agents" + stan „Backlog" + labelki (`ai:planned`, `type:*` przez alias feat→feature/fix→bug/spike/tech; `slice:*` auto-create jako flat labels). Estimate S/M/L→2/3/5. Idempotentny przez `utils.mjs idempotentCreate` z kluczami `linear:<externalId>` (prefix zapobiega kolizji z mock dry-run `plan:sample`→ścieżka pliku). `--dry-run` (READ-ONLY, zero mutacji), `--brief`, `--team-key`, `--project-name`, `--project-id` (walidacja 36-char UUID). Błędy Linear z `extensions` (pole) widoczne.
  - **T-C3c** `agents/plan/agents/push.md` — `tools:` zmienione z `mcp__linear__*, Read` → `Bash, Read`; instrukcje push wołają `node scripts/linear-push.mjs --brief` (+ `--dry-run` podgląd). MCP linear usunięte z agenta.
  - **T-C3d verify:** live push `planning/briefs/plan_sample_69f948e9.json` → **parent epic FEN-1 + 9 subtask sub-issues FEN-2…FEN-10** w projekcie „Linear Agents", z `ai:planned` + `type:feature` (feat) + 9 auto-created `slice:*` label, parent–child parentId. Idempotencja verified: re-run → **dokładnie 10 issues w projekcie**, highest FEN-10, brak duplikatów (probe `scripts/_test_count.mjs`, read-only). `check.mjs` 5/0. URL-e: `https://linear.app/jointhubs/issue/FEN-1/…` … `FEN-10`.
  - **Known cosmetic:** drugi run drukuje cached identifiers jako „✅" zamiast „[skip]" (log nie odróżnia skip/create) — functional idempotent (verified via probe). Follow-up: skip-aware logging.

### Zrobione (cd. — Faza D T-D1, interaktywny pilotaż PLAN squad)
- **T-D1a — DONE.** Naprawa handoffu decomposer→push (tryb normalny zapisuje brief JSON `planning/briefs/plan_<slug>.json`, `dryRun:false`) + doprecyzowanie bramek w `agents/plan/CLAUDE.md` jako **synchonicznych inline REPL** (GATE 1 po discovery, GATE 2 po decompose przed push — prezentuj, zapytaj, CZEKAJ na ✅; `needs:*`+emoji = tryb async/@flow, Faza G, odłożone). check.mjs 5/0; dry-run nienaruszony.
- **T-D1b — DONE+verified (2026-06-25).** Interaktywny pilotaż squadu PLAN na `planning/inbox/roast-app.md` (pomysł Mateusza: apk roastująca pomysł biznesowy). Mateusz odpalił `bin\plan.bat` (OR, lead Opus 4.8) i aprobował bramki inline. Pipeline przeszedł end-to-end: discovery → spec (+ADR-0004) → spec-review (1 pętla, 6 hardeningów K1-K6) → decompose (13 slice'ów) → GATE 2 → push → **realny epik FEN-11** + subtaski w projekcie „Linear Agents" (team FEN).
  - **Weryfikacja orkiestratora (probe read-only):** epik FEN-11 + subtaski FEN-12…FEN-25 istnieją, parent-child połączone, `type:feature` na feat-subtaskach, `ai:planned` na wszystkich.
  - **Ujawnione defekty narzędzia (naprawione w T-D1c):** (1) slice labelki nie tworzone dla bare slice (brief roast używa "corpus" bez prefixu); (2) duplikat s13 (FEN-24==FEN-25) — Linear zwrócił błąd po udanym create → brak klucza idempotencji → re-run zrobił dup (Mateusz: dup zostawić, narzędzie dopracować).
- **T-D1c — DONE+verified (2026-06-25).** Dopracowanie narzędzia push (bez zapisu do Linear): `utils.idempotentCreate` + opcjonalny `onSkip` (non-breaking, _test_utils 25/25); `linear-push.mjs` + `normalizeSlice` (bare→`slice:corpus`, dry-run pokazuje auto-create), `isValidationError` + `reconcileAfterTransient` (po błędzie sieci/transient — query team issues po tytule+5min, 1 match → zwróć istniejący id → idempotencja rejestruje → brak dup przy re-run; 0/>1 → null bezpiecznie), `createIssue` z uporządkowaną obsługą validation/estimate/transient, skip-aware logging (`✅` create vs `⏭️` skip); `decomposer.md` slice format `slice:<name>`; `.gitignore` + runtime artefakty claude (`cache/`, `history.jsonl`, `plugins/`, `.last-update-result.json`). Self-test `_test_linear-push.mjs` 18/18; dry-run na `plan_roast-app.json` pokazuje slice auto-create; check.mjs 5/0. Recenzja reconcile logic (orkiestrator) — konserwatywna, poprawna.

### W toku
- (nic aktywnego — Faza D T-D1 zamknięta; kolejny krok zależny od decyzji Mateusza o dalszym „dobudowaniu" stacku)

### Zrobione (cd. — Faza E foundation, telemetry + cost panel MVP, równolegle DeepSeek Flash, e2e verified)
- **T-E0a — DONE.** `scripts/ledger.mjs` (ESM, zero deps): `parseTranscript` czyta transkrypty claude code
  (`~/.claude/projects/C--Users-mateu-.../*.jsonl`, NDJSON) — każda linia `assistant` ma realny `message.usage`
  (input/output/cache) + `message.model`; subagenty (`<session>/subagents/agent-*.jsonl`) mają `attributionAgent`.
  `costTokens` × pricing `config/models.json` (match cost-report.mjs). `aggregateRun`/`scanRuns`/`liveRuns`.
  Self-test `scripts/_test_ledger.mjs` 20/20 (gitignored). **Wybór źródła:** transkrypty, NIE stream-json — działają
  dla interaktywnego REPL i `-p`, nie psują bramek. PRD: `docs/prd/telemetry-panel-prd.md`.
- **T-E0b — DONE.** `scripts/run-manifest.mjs` (`gen-id`/`start`/`end`, atomic) + wire `bin/_lib.bat` (start =
  single chokepoint; każdy launcher nadpisuje `SQUAD_SLUG`/`SOURCE_PATH` przed `call _lib.bat`) + `end`-call w każdym
  launcherze (plan/dev/review/test/cadence/agent) po `claude %*`. Manifest `.state/runs/<runId>.json` (runId = ISO+squad).
  CRLF preserved (LF psuł .bat wcześniej — weryfikacja `file` → CRLF). `all.bat` nietknięty (sub-procesy = osobne runy).
- **T-E0c — DONE.** `scripts/telemetry-server.mjs` — Node `http`, zero deps, `localhost:7331` (env `TELEMETRY_PORT`),
  GET `/api/runs` `/api/runs/:runId` `/api/summary` `/api/live`, CORS `*`, OPTIONS 204, log per-request, `--smoke`
  (auto-close 10s). Dynamiczny `import('./ledger.mjs')`.
- **T-E0a-fix — DONE.** Bug: `byAgent.<agent>.costUSD` był 0 (kosztowano klucz agenta zamiast modelu turna).
  Fix: per-turn `costTokens(usage, turn.model)` dodawany do OBU kubełków (byModel+byAgent). Test 20/20; live re-verify
  `byAgent._lead.costUSD = byModel... = totals = $0.237` ✓.
- **T-E1d — DONE.** `0_linear` `app/api/agents-cost/route.ts` — Next, `force-dynamic`, server-side proxy do
  `localhost:7331` (env `AGENTS_COST_URL`). `?view=runs|live|summary` / `?runId=`. Same-origin (frontend woła `/api/...`,
  nigdy cross-origin — brak CORS w przeglądarce). 502 + hint gdy serwer nie działa. tsc czysty.
- **T-E7a — DONE.** `0_linear` `components/AgentsCostView.tsx` (560 linii, `'use client'`) + tab „Agents & Cost"
  w `Dashboard.tsx` (Tab union + TABS + JSX branch). Sekcje: live strip (aktywne runy) + summary (total cost/runs/tokens)
  + runs table (klik → drill-down) + drill-down (recharts: cost&tokens by model, tokens by agent; `_lead`→„lead").
  Cost „$ (est.)" wszędzie. Poll live co 5s. tsc czysty.
- **T-E0d — DONE+verified (orkiestrator, final approval).** E2E: `bin/plan.bat -p "Reply with exactly: OK"`
  → manifest `.state/runs/2026-06-25T11-35-29-plan.json` → transkrypt → ledger → telemetry-server (`:7331`)
  → 0_linear proxy (`localhost:3000/api/agents-cost`) → JSON. Real run, `costUSD>0`, `byAgent._lead.costUSD>0`.
  Wszystkie 4 endpointy proxy realne dane (bez 502/500). **Znane ograniczenie (T-E0e/Phase 2):** `aggregateRun`
  dopasowuje transkrypty po oknie `cwd`+`gitBranch`+czas — długa sesja orkiestratora w tym samym cwd wpada w okno
  i nadpuchla liczniki (proxy $0.123 vs direct $0.067). Fix = exact `sessionId` w manifeście (łapać z runu claude).
- **T-E0e + T-E0e-fix2 — DONE+verified.** Exact `sessionId` w manifeście: `run-manifest end` odkrywa sesję squadu po `birthtime` szukając w OBU korzeniach — `<CLAUDE_CONFIG_DIR>/projects/<hash>/` (gdzie squad pisze transkrypt, bo launchery ustawiają `CLAUDE_CONFIG_DIR=agents/<squad>`) i `~/.claude/projects/<hash>/`; wybiera najbliższy `startedAt`; zapisuje `sessionId`+`transcriptPath`+`claudeConfigDir`. `aggregateRun` przy `sessionId` parsuje TYLKO ten transkrypt (exact) zamiast okna. **Wyciek usunięty:** realny `plan.bat -p` run: 1.49M leaked input tok → **6 genuine**, $0.21 → **$0.0214**. Fix po drodze: `cwdToHashName` (`:`→`-`, było `:`→`` → `C-Users` zamiast `C--Users`, hash nigdy nie pasował); pricing `anthropic/claude-4.8-opus-20260528` w `config/models.json`. Tests 23/23. Known minor: `cache_read` nie kosztowane (konwencja cost-report) → genuine ~$0.05 vs raport ~$0.02 (T-E0f/Phase 2).
- **T-E7a-polish — DONE.** `AgentsCostView`: null-safe formatters (był Runtime TypeError — `costUSD` undefined), nazwy pól wyrównane do API (`costUsd`→`costUSD` 14×, `totalRuns`→`totals.runs`, usunięto `calls`), relative time (date-fns), status pills z kolorem, sticky header, zebra, empty states, responsywność, inline error banner. tsc czysto.
- **T-E0f + T-E7a-fix2 — DONE+verified.** Kosztowanie `cache_read`/`cache_creation` (były ignorowane → panel mylnie pokazywał input=6/$0.02 dla squadu; real ctx=158k/$0.31). `costTokens`: cacheRead × `pricing.cacheRead` (default 0.1×input, konwencja Anthropic) + cacheCreation × input. `byModel`/`byAgent` eksponują `cacheReadInputTokens`+`cacheCreationInputTokens`. `config/models.json`: cacheRead dla Anthropic (Opus $0.50, Sonnet $0.30 /M). UI: kolumna „Context"=fresh+cacheRead+cacheCreation z tooltip-breakdown, tabele byModel/byAgent z rozbiciem Fresh/Cache read/Cache write, wykres po total context, legenda. Realny run `17-38`: ctx=157,737, out=855, **$0.3095** (cacheCreation $0.232 dominuje — zimny run tworzy cache). Tests 26/26.
- **Jak uruchomić panel:** (1) `node scripts/telemetry-server.mjs` (linear-agents, port 7331); (2) `cd Desktop/experiments/0_linear && npm run dev`;
  (3) otwórz `http://localhost:3000`, tab „Agents & Cost". Dane pojawiają się po squad runie (launchery piszą manifesty automatycznie).

### Następne
- **Faza D — T-D1 PLAN e2e** (następny kamień): pełny przepływ squadu PLAN z bramkami HITL (needs:*+emoji) → realny epik (M3 udowodnił push; T-D1 spiña całość z gates). Wymaga ustalenia czy push idzie interaktywnie (squad REPL) czy headless przez skrypt (T-C3) — obecnie headless GraphQL = domyślny MVP.
- **Decyzja Mateusza (Faza B):** native launcher **Opus 4.8** działa (Pro, rate-limited, $0/token w subskrypcji) vs **OpenRouter** (Opus 4.8 per-token, bez dziennego limitu, $). Mechanizm dostarcza oba launchery — wybór day-to-day. Dla intensywnych runów OR (scalable), dla lekkich native (free).
- **T-B4** (follow-up, jeśli native day-to-day): migracja frontmatter subagentów `agents/plan/agents/*.md` z OR slugs na real ID — pełny squad native. Task #13.
- **T-A6b** (post-pilot): idempotency race-condition hardening — task #9, odroczone.
- **Bot `@flow`** (OAuth actor=app) — nadal odłożony; MVP push działa jako user (LINEAR_API_KEY). Headless autonomous push (@flow) = przyszłość.

## Faza F — finish DEV/REVIEW/CADENCE squads (plan: docs/plans/finish-squads-plan.md)

**F0 — DONE + verified (2026-06-29).** Shared headless Linear access layer (unblocks DEV/REVIEW/CADENCE; MCP mcp__linear__* does not work headless per T-C2):
- scripts/linear-client.mjs — shared GraphQL client (loadEnv, graphql, resolveTeam, resolveIssue via issue(id:) + searchIssues fallback; validates LINEAR_API_KEY before fetch).
- scripts/linear-query.mjs — read CLI (team/issues/issue/comments/search); server-side state+label filters via GraphQL vars; <SQUAD>_DRY_RUN=1 -> serves .state/mock/<squad>-task.json fixture (mechanical dry-run safety, no API call).
- scripts/linear-ops.mjs — write mutations on existing issues (transition/label/comment/estimate); --dry-run; comment --dedup-tag (dedup marker scan); label resolve via group:child map (ai:coded); TOCTOU note on labelIds.
- scripts/check.mjs — +2 lint checks (dry-run launcher sets *_DRY_RUN=1; linear scripts CLI surface). 7 checks total.
- Fixtures .state/mock/{dev,review,cadence}-task.json (gitignored — .state/).
- Sonnet review adopted (C1 dry-run safety, C2 forbid mcp__linear_*, C3 issue(id:) first, C4 --dedup-tag, C6 prompt-file, C7 needs:answer resume). Pro review of scripts: 5 MAJOR + 8 minor fixed.
- Commits: 23bf28b, a5be642, db14995.
- KNOWN FINDING: live team FEN unstarted state is "Backlog" (not "Todo" as config/linear/states.json claims). Code queries live states so works with any name; squad prompts aligned to "Backlog". No FEN issue has the dor-ok label yet (only "planned") — live DEV pilot must add dor-ok to a chosen task as setup.

**F1 (DEV squad) — wiring DONE + dry-run verified (2026-06-29); LIVE PILOT DEFERRED.**
- agents/dev/CLAUDE.md rewritten: Step 0 resume check (.state/dev-wip.json, WIP=1), Backlog+dor-ok pick, linear-ops transition/label, dev-branch.mjs, self-verify, hand-off (comment --dedup-tag + In Review), needs:answer -> WIP + exit + resume, DRY-RUN. Subagents: no-mcp note.
- scripts/dev-branch.mjs — branch naming + checkout (no push, rebase if exists, --dry-run).
- bin/dev-dry.bat — mirrors plan-dry.bat (SQUAD_SLUG=dev, DEV_DRY_RUN=1, run-manifest end).
- Pro review: 4 MAJOR + 8 minor fixed (Step 0, slug/placeholder clarification, dry-run dev-branch, misleading check.mjs flags).
- Dry-run pilot VERIFIED (run 2026-06-29T17-43-31-dev): agent ran full loop on fixture FEN-30 (pick -> dev-branch --dry-run -> wrote lib/*.mjs in .state/runs workspace -> self-verify 6 pass/2 skip/0 fail -> hand-off artifact), 0 mcp__linear, 0 git push. Finding: Bash was permission-gated in `claude -p --permission-mode default` (non-interactive) -> agent delegated self-verify to subagent; live bin\dev.bat is interactive so Mateusz approves Bash inline (not an issue live). Optional launcher tweak: dry-run could use --permission-mode acceptEdits.
- Commits: c9fcfa2, c791463 (chore gitignore .agent-io).
- NEXT: F1 live pilot on a real FEN task (pick smallest Backlog+planned, e.g. FEN-2; add dor-ok; run bin\dev.bat interactively). TEST deferred until GCP VM.

**F2 (REVIEW squad) — wiring DONE + dry-run verified (2026-06-29); live pilot deferred.**
- agents/review/CLAUDE.md: MANDATORY no-mcp; Pick In Review (prefer ai:coded); load diff from DEV hand-off comment branch (regex + fallback + dynamic base, no fetch/push/force); 3 parallel passes (first-pass/security/deep via Agent tool); merge -> Conventional Comments .state/reviews/<id>-roundN.md (dedup/severity rules); round via review-round.mjs; verdict: issues->In Progress+risk:high, escalated(round>2)->escalated+stop, clean->ai:reviewed+dod-ok+stage:testing (keep In Review, hand to TEST). DRY-RUN: REVIEW_DRY_RUN=1.
- scripts/review-round.mjs (CLI wrapper over utils.reviewRound: next/peek/reset, escalate at round 3 with max 2).
- bin/review-dry.bat (mirrors dev-dry.bat).
- agents/review/settings.json: Write allowed (review artifacts), Edit denied (no code mod), mcp__linear__* allow->deny + mcpServers.linear removed.
- Pro review: 4 MAJOR + minors fixed (round comment off-by-one, diff robustness, Write scope, merge rules).
- Dry-run pilot VERIFIED (run 2026-06-29T18-55-18-review): pick -> context -> 3 subagents -> Conventional Comments artifact -> review-round -> linear-ops comment --dry-run attempted (offline); 0 mcp__linear, 0 git push.
- Commit: c5a3b4d.

**F3 (CADENCE squad) — wiring DONE + dry-run verified (2026-06-29).**
- agents/cadence/CLAUDE.md: MANDATORY no-mcp; Trigger note (manual launch starts immediately, no waiting for Hermes/cron); collector wired to linear-query (throughput Done-this-week, In Progress/In Review counts, blocked/escalated/over-budget via --label, aging WIP via startedAt, no-Initiative via parent==null, stale needs:*); retro (drift + blameless + action items + Now/Next/Later PROPOSAL); digest = PL markdown to .state/cadence/<ISOweek>.md + optional linear-ops comment --dedup-tag. Read-mostly: NO status/label/scope changes. DRY-RUN: CADENCE_DRY_RUN=1.
- bin/cadence-dry.bat (mirrors review-dry.bat).
- agents/cadence/agents/*.md: no-mcp note + mcp__linear__* removed from tool frontmatter.
- agents/cadence/settings.json + agents/dev/settings.json: mcp__linear__* allow->deny + mcpServers.linear removed (mechanical no-mcp; closes hygiene task #5).
- Dry-run pilot VERIFIED (run 2026-06-29T18-55-18-cadence): collector -> retro -> PL digest .state/cadence/2026-W26.md produced from fixture; 3 subagents; 0 mcp__linear, 0 git push, 0 status/label/scope changes.
- Commits: 6287216 (cadence), 2308d5d (dev settings MCP strip), dee9074 (linear-ops dry-run offline fix + dev-dry kickoff).

**Shared fix (2026-06-29).** linear-ops.mjs: <SQUAD>_DRY_RUN=1 now forces fully-offline dry-run (issue from fixture, ops preview by name, labels validated vs labels.json, env forces no-write even without --dry-run). Closes the dry-run gap where linear-ops --dry-run hit live Linear and failed on fictional fixture ids. Commit dee9074.

**KNOWN dry-run limitation.** Dry-run launchers use `claude -p --permission-mode default`; in non-interactive -p mode some Bash(node) calls are HITL-gated (no one to approve) -> agents adapt (Read fixture directly, delegate to subagents). Does NOT affect live runs (bin/<squad>.bat is interactive; Mateusz approves inline). An attempt to switch dry-run to --permission-mode bypassPermissions was BLOCKED by the safety classifier (correctly — bypass is unauthorized); dry-run stays default mode.

## F4 — pilot E2E LIVE (2026-06-30): PLAN → DEV → REVIEW → CADENCE

**Pierwszy pełny pilot end-to-end w real mode (nie dry-run) na gałęzi `feat/phase-a-offline-foundation`.** Pipeline przeszedł całościowo; CADENCE retro odkrył realne red flagi systemowe. Wszystkie 4 squady interaktywne (REPL, Mateusz aprobuje inline); CLAUDE.md auto-ładowane przez `CLAUDE_CONFIG_DIR=agents/<squad>`; launchery NIE auto-startują — wymagają kickoffu w REPL (patrz tabela prompty poniżej).

**Przepływ:**
- **PLAN** (`bin\plan.bat`, kickoff: "Przeczytaj planning/inbox/dummy-ui.md i wykonaj pełną pętlę PLAN") → GATE 1 (discovery ✅) → spec + ADR-0005 → spec-review → decompose → GATE 2 (✅) → push → **epic FEN-27 "Dummy UI — deployability proof" + 6 subtasków FEN-28..33** (Backlog, `ai:planned`+`slice:*`+`type:*`, AC Given/When/Then + DoD w opisie, relacje `blockedBy`: s3,s4→s1; s5→s2,s3,s4; s6→s5). Artefakty: `planning/briefs/{discovery,spec,plan}-dummy-ui.*` (gitignored), `docs/adr/0005-dummy-ui-deploy.md` (commit pending).
- **DEV** (`bin\dev.bat`, kickoff: "Wykonaj pełną pętlę DEV dla FEN-28 — zacznij od start") → pick FEN-28 (s1, Backlog+dor-ok) → transition In Progress + `ai:coded` → `dev-branch.mjs start` (branch `fen-28-scaffold-dummy-ui`, base=feat tip — defekt #1 naprawiony zadziałał) → implementer: `apps/dummy-ui/` 7 plików (server.js zero-dep, Dockerfile node:22-alpine, compose, .dockerignore, .gitattributes LF, .env.example, README stub) → self-verify live (docker build/up, curl /health `/`/404, LF, SIGTERM graceful) → hand-off comment `dev-handoff-FEN-28` + transition In Review. **Commit `2df3919` na `fen-28`** (po interwencji — defekt #3).
- **REVIEW** (`bin\review.bat`, kickoff: "Wykonaj pełną pętlę REVIEW — zacznij od pick In Review task") → pick FEN-28 (`coded`) → diff `fen-28...feat` (7 plików, +100) → 3 passes równoległe (first-pass∥security∥deep) → merge → Conventional Comments do `.state/reviews/FEN-28-round1.md` → werdykt **CLEAN** (AC1-4 + każde DoD pass, zero blokujących `issue:`) → `reviewed` (zastąpił `coded`) + `dod-ok` + `stage:testing`, status In Review (hand to TEST, bez transition). Nieblokujące: `suggestion:` USER node, `suggestion:` log-injection CRLF, `nitpick:` route matching.
- **CADENCE** (`bin\cadence.bat`, kickoff: "START IMMEDIATELY — wykonaj pełną pętlę CADENCE — zacznij od collector") → collector (real mode, 6 issues: 1 In Review, 5 Backlog/Epic, 0 throughput, 0 blockerzy) → retro (3 red flagi + 3 action items + Now/Next/Later) → digest `.state/cadence/2026-W27.md` (109 linii, gitignored). Read-mostly — 0 zmian w Linear. Digest push do FEN-27 (comment `cadence-2026-W27`).

**Defekty pilota (6, #6 split into #6a+#6b):**
- **#1 `scripts/dev-branch.mjs` hardcoded base `main`** → squad na branch z `main` traci F0–F3 scripts (linear-*.mjs znikają) → hand-off pada. **NAPRAWIONE (commit pending):** base = aktualny HEAD (`git rev-parse HEAD`) + opcjonalny `--base <ref>` (walidacja `git rev-parse --verify`); 4 hardcoded `main` zastąpione; 22/22 tests.
- **#2 `scripts/linear-push.mjs` `dor-ok` tylko w dry-run path (linia 731)**, live path (linia 818) pominięty → pushed subtaski bez `dor-ok` → DEV "No Ready tasks". **NAPRAWIONE (commit pending):** `dor-ok` dodane do live label-list (subtask only, parent nietknięty); flat-label resolve OK; 24/24 tests. (Błąd weryfikacji orkiestratora — spot-check testował helper/dry-run, nie live path.)
- **#3 DEV no auto-commit → FIXED: agents/dev/CLAUDE.md hand-off now commits on branch before comment/transition (commit pending).**
- **#4 settings.json runtime noise → FIXED: .gitignore extended to cover file-history/ and paste-cache/; theme:dark handled via config (commit pending).**
- **#5 file-history/ + paste-cache/ not gitignored → FIXED: .gitignore extended (commit pending).**
- **#6a `type:docs/test/chore` labels nie istnieją w workspace** → **DONE (2026-06-30):** `config/linear/labels.json` rozszerzony o `type:docs/test/chore`; `scripts/bootstrap-linear.mjs` zyskał `--check` + `--emit-checklist` + marker `.state/teams/<KEY>.provisioned`; `scripts/linear-push.mjs` fail-fast (throw na brak `type:*`/`ai:*`) + pre-flight `checkRequiredLabels` (live path, exit 3); `bin/_lib.bat` auto-detect unprovisioned workspace (marker check + y/N prompt); `docs/ACCESS.md` stworzony (workspace onboarding story). FEN provisioned: `type:docs/test/chore` created, `--check` exits 0, marker `FEN.provisioned` written. `linear-push` tests 24/24 green.
- **#6b shipped (2026-06-30):** helper `publish-linear-comment.mjs` + 41 tests; 5 squads wired (plan/dev/review/cadence/test CLAUDE.md) to helper with per-squad tags + state-change triggers + pisi-guard; hard secrets rule added to each squad CLAUDE.md. Live posting exercised on next real squad run.

**Follow-ups pending (2026-06-30):**
- #6b live posting — exercised on next real squad run (not spam-verified here)
- Branch `fen-28-scaffold-dummy-ui` deletion — pending Mateusz OK

**#6a implemented (2026-06-30):** bootstrap `--check`/`--emit-checklist` + marker, linear-push fail-fast + pre-flight, `_lib.bat` auto-detect, `docs/ACCESS.md` onboarding. FEN provisioned (`type:docs/test/chore`). 24/24 tests. **#6b PRD** at `docs/prd/prd-docs-to-linear-comments.md` (impl pending).

**CADENCE retro — red flagi + action items (do decyzji Mateusza):**
- 🔴 A1 (WYSOKI, do pt): zdefiniuj merge-gate + zamknij FEN-28 (ma pełen dor-ok/dod-ok/reviewed/stage:testing, a wisi w In Review — nikt nie klika merge & Done).
- 🟡 A2 (WYSOKI, do pt): start FEN-30 zaraz po FEN-28 (flow gap = 0 In Progress).
- 🟡 A3 (ŚREDNI, W27–W28): dodaj estimate + assignee do FEN-30..33 (Backlog niegotowy do wzięcia).
- 🟡 Single-epic concentration: 100% pracy pod FEN-27.

**.bat launchers recon (2026-06-30):** production launchers use `claude %*` with no `--permission-mode` flag; `defaultMode:'default'` is initial state, not a lock — shift+tab auto-accept works. Dry-run launchers use `-p` (non-interactive, no REPL) — that is the likely source of the "cannot enable auto mode" perception.

**Launchery — prompty do REPL (interaktywne, NIE auto-startują):**
| Launcher | Kickoff w REPL |
|---|---|
| `bin\plan.bat` | `Przeczytaj planning/inbox/<plik>.md i wykonaj pełną pętlę PLAN zgodnie z CLAUDE.md` |
| `bin\dev.bat` | `Wykonaj pełną pętlę DEV zgodnie z CLAUDE.md — zacznij od resume check i pick` (lub `dla FEN-XX — pomiń pick, zacznij od start`) |
| `bin\review.bat` | `Wykonaj pełną pętlę REVIEW zgodnie z CLAUDE.md — zacznij od pick In Review task` |
| `bin\cadence.bat` | `START IMMEDIATELY — wykonaj pełną pętlę CADENCE zgodnie z CLAUDE.md, zacznij od collector` |

**Git po pilocie:** `feat/phase-a-offline-foundation` — 2 batche commitów pending (naprawy scripts #1#2 + ADR-0005). Branch `fen-28-scaffold-dummy-ui` (DEV commit `2df3919`, apps/dummy-ui) zostaje osobno. `planning/`, `.state/`, `scripts/_test_*.mjs` gitignored.

**dummy-ui scaffold exported (2026-06-30):** standalone repo at `C:\Users\mateu\Desktop\dummy-ui-deploy-proof\` (commit c9ead75); branch `fen-28-scaffold-dummy-ui` kept locally pending deletion decision.

### Blokady (czeka na Mateusza)
- Faza D T-D4 / Faza G: **GCP VM** (nazwa/projekt/zone).
- Odblokowane: OPENROUTER_API_KEY ✅, LINEAR_API_KEY ✅, team FEN + projekt „Linear Agents" ✅ (Faza C gotowa do integracji z Fazą D).

## Jak uruchomić
- Squad launchery (DZIAŁAJĄ po fixach): `bin\plan.bat` (lead Opus), `bin\dev.bat`, `bin\review.bat`,
  `bin\test.bat`, `bin\cadence.bat`, `bin\all.bat`, `bin\agent.bat <area> <role>`. Wszystkie wołają `bin\_lib.bat`.
- Spike T-A1 (re-runnable): `.spike-a1\run-spike.ps1`, `.spike-a1\run-clean.ps1`, `.spike-a2\run-spike.ps1`.

## Git checkpoint (2026-06-24 — historyczny, Faza A–C)

> Stan bieżący: patrz **Faza G** na górze. Branch `feat/observability` (80 commitów ahead of `main`) — **WYPCHNĘTY** do `origin`, **PR #1** otwarty (https://github.com/joint-hubs/linear-agents/pull/1), czeka na review/merge. Poniższe dotyczy zamkniętej Fazy A–C na `feat/phase-a-offline-foundation`.

Branch `feat/phase-a-offline-foundation` (12 commitów ahead of `main`; NIE zmergowany, NIE pushowany — czeka na Mateusza).
Faza A (offline foundation):
- `b3fc4f3` fix(bin): base URL + clear SUBAGENT_MODEL + .gitattributes (CRLF)
- `5efc05d` feat(scripts): check.mjs + cost-guard.mjs + utils.mjs + cost-report.mjs wire + .gitignore
- `e0491dc` docs(adr): ADR-0002 + BUILD-BACKLOG + STATE
- `2862972` feat(planning): inbox/sample.md
Faza B (provider mechanism / native):
- `545eeec` feat(bin): NATIVE provider profile — Opus 4.8 on Pro, fallback hint (T-B1/B2/B3)
- `b04286f` docs: Faza B done — native Opus 4.8 smoke green, T-B1..B3 odhaczone + STATE
Faza C (Linear live):
- `6aaa25d` fix(scripts): bootstrap-linear.mjs current Linear GraphQL schema (T-C1 live)
- `eba770c` feat(phase-c): live PLAN push to Linear via GraphQL = M3 (T-C3)

Working tree: czyste poza STATE.md (living-doc). Scratch `.spike-a1/`/`.spike-a2/`,
`scripts/_test_*.mjs` (throwaway probes, m.in. `_test_count.mjs` — idempotency verify FEN),
`.state/`, `agents/plan/.credentials.json` — gitignored. Commit messages: **bez trailera
Co-Authored-By** (preferencja Mateusza).

## Notatki
- Orkiestrator (GLM) biegnie przez **Ollama** (`ANTHROPIC_BASE_URL=127.0.0.1:11434`), NIE OpenRouter.
  Squad launchery celowo na OpenRouter. Nie mylić env sesji orkiestratora z env squadu.
- Claude Code: 2.1.187. Przy upgrade CC — re-run spike'a T-A1 (ryzyko zmiany pass-through `model:`).
- `CLAUDE_CODE_SUBAGENT_MODEL` ustawiony w env orkiestratora (=glm-5.2:cloud) — dlatego squady muszą
  go czyścić (zrobione w `_lib.bat`); bez tego subagenty spłaszczają się na jeden model.