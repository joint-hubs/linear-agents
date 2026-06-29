# STATE — linear-agents (pilotaż orkiestratora)

> Stan długiej pracy. Sesje wypadają z kontekstu — ten plik to tani start. Aktualizuj po każdej fazie.
> Orkiestrator: GLM-5.2. Plan wykonawczy: `docs/BUILD-BACKLOG.md`. Polityka: `~/.claude/memory/orchestration.md`.

## Ostatnia aktualizacja: 2026-06-25 — Faza E foundation DONE (telemetry ledger + cost panel MVP e2e verified + data-quality fix T-E0e + UI polish), Faza D T-D1 DONE, Faza C zamknięta

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
  dla interaktywnego REPL i `-p`, nie psują bramek. PRD: `docs/telemetry-panel-prd.md`.
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

### Blokady (czeka na Mateusza)
- Faza D T-D4 / Faza G: **GCP VM** (nazwa/projekt/zone).
- Odblokowane: OPENROUTER_API_KEY ✅, LINEAR_API_KEY ✅, team FEN + projekt „Linear Agents" ✅ (Faza C gotowa do integracji z Fazą D).

## Jak uruchomić
- Squad launchery (DZIAŁAJĄ po fixach): `bin\plan.bat` (lead Opus), `bin\dev.bat`, `bin\review.bat`,
  `bin\test.bat`, `bin\cadence.bat`, `bin\all.bat`, `bin\agent.bat <area> <role>`. Wszystkie wołają `bin\_lib.bat`.
- Spike T-A1 (re-runnable): `.spike-a1\run-spike.ps1`, `.spike-a1\run-clean.ps1`, `.spike-a2\run-spike.ps1`.

## Git checkpoint (2026-06-24)
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