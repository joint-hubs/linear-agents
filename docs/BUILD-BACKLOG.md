---
type: build-backlog
status: active
audience: GLM-5.2 (orchestrator) → DeepSeek workers
tags: [type/backlog, area/ai, topic/build, topic/orchestration]
created: 2026-06-23
maturity: backlog-v1
---

# BUILD BACKLOG — linear-agents (handoff dla orkiestratora GLM-5.2)

> **To jest plan wykonawczy dla CIEBIE, GLM-5.2.** Mateusz = product owner (HITL). Ty orkiestrujesz,
> delegujesz najmniejsze chunki do workerów DeepSeek (Pro = trudniejszy kod, Flash = proste/bulk),
> integrujesz i weryfikujesz. Nie koduj sam dużych rzeczy — tnij i deleguj. Eskalacja: DeepSeek → (Kimi multi-file) → pytaj Mateusza.

## 0. Kontrakt orkiestratora (przeczytaj raz)
- **Najpierw przeczytaj (tanio, nie cały repo):** `docs/dev-readiness.md`, `docs/adr/0001-provider-routing-and-fallback.md`, `docs/00-build-plan.md`, `config/models.map`, oraz PRD obszaru którego dotyczy task (`docs/prd/prd-*.md`). UI: `docs/ui/ux-design.md` + `ux-improvements.md`.
- **Język:** kod / commity / docs techniczne = EN. Komentarze/raporty do Mateusza = PL.
- **Git:** pracuj na branchach; **NIGDY `git push` ani merge bez zgody Mateusza**. Commity proponuj, nie wykonuj automatycznie poza branchem roboczym.
- **Higiena:** odhaczaj taski w tym pliku (`[ ]`→`[x]`) i aktualizuj `STATE.md` po każdej fazie.
- **STOP i pytaj Mateusza** gdy: brak klucza/sekretu, brak workspace/bota Linear, brak GCP VM, operacja nieodwracalna (live Linear bulk, deploy), albo niejasny scope.
- **Każdy task ma `Verify:`** — nie zamykaj bez przejścia weryfikacji. Po implementacji uruchom `node scripts/check.mjs` (gdy powstanie) — musi być zielone.
- **Routing modeli** bierz z `config/models.map` (+ ADR-0001 dla profilu native PLAN). Slugi Anthropic na OpenRouterze = z **kropką** (`claude-opus-4.8`).

## 1. Definition of Done (pilot v1)
1. `scripts/check.mjs` zielony. 2. Spike T-A1 rozstrzygnięty (mechanizm subagentów potwierdzony lub poprawiony). 3. PLAN dry-run (offline) tworzy poprawny parent+subtaski JSON, idempotentnie. 4. P0 safeguards działają (cost stop, idempotency, loop-limit). 5. Po wejściach Mateusza: 1 realny epik w Linear przez `plan.bat`.

---

## FAZA A — Offline foundation (start TERAZ; tylko OPENROUTER_API_KEY)

- [x] **T-A1 · SPIKE: subagent model-pinning** *(orchestrator/interaktywnie; DONE 2026-06-24)*
  - Cel: ustalić, czy Claude Code honoruje `model: <openrouter-id>` we frontmatter subagenta (cała architektura „model per subagent" na tym stoi).
  - Kroki: odpal `bin\agent.bat plan discovery` lub `bin\plan.bat`; niech lead spawnuje subagenta z `model: minimax/minimax-m3`; sprawdź `/status`/logi który model realnie poszedł.
  - AC: notatka `docs/adr/0002-subagent-model-mechanism.md` z wynikiem. Jeśli NIE działa → zaproponuj mechanizm: osobny `CLAUDE_CONFIG_DIR` per subagent **lub** mapowanie na sloty opus/sonnet/haiku.
  - Verify: notatka istnieje + decyzja. **Blokuje D (squady e2e), nie blokuje A2-A6.**
  - **RESULT:** architektura DZIAŁA — explicit OR slug we frontmatter honorowany (pass-through do API); aliasy mapują przez `ANTHROPIC_DEFAULT_*_MODEL`; warunek: `CLAUDE_CODE_SUBAGENT_MODEL` nie ustawiony. Dowód: `.spike-a1`/`.spike-a2` Test 3a/3b (subagent `model:`=`minimax/minimax-m3`, HTTP 200). ADR: `docs/adr/0002-subagent-model-mechanism.md` (Accepted).
  - **Wykryto 2 bugi P0** → **T-A1-fix**: (1) `bin/_lib.bat:17` base URL `…/api/v1` → podwójne `/v1/v1/` → 404 we wszystkich squadach (fix `/api`); (2) dziedziczony `CLAUDE_CODE_SUBAGENT_MODEL` nadpisuje frontmatter (fix: czyścić w `_lib.bat`).

- [ ] **T-A1-fix · `_lib.bat` base URL + clear SUBAGENT_MODEL** *(DeepSeek Flash; BLOCKS D)*
  - Cel: naprawić P0 z T-A1, odblokować squady. (1) `ANTHROPIC_BASE_URL=https://openrouter.ai/api` (bez `/v1`); (2) `set "CLAUDE_CODE_SUBAGENT_MODEL="` w `_lib.bat`.
  - Verify: smoke `bin\plan.bat -p "spawn discovery subagent, ask it to print PING"` z debug → subagent request `model:`=`minimax/minimax-m3`, HTTP 200. Patrz ADR-0002.

- [ ] **T-A2 · `scripts/check.mjs` (consistency linter)** *(DeepSeek; parallel)*
  - Cel: zielony/czerwony sygnał spójności repo (zapobiega driftowi z czasów współedycji).
  - AC: exit≠0 gdy: subagent `model:` spoza `models.map`; rola w `models.map` bez pliku subagenta; labelka użyta w prompcie agenta spoza `config/linear/labels.json`; niepoprawny JSON w `config/`. Czytelny raport.
  - Verify: `node scripts/check.mjs` na obecnym repo → przechodzi albo listuje realny drift.

- [ ] **T-A3 · `planning/inbox/sample.md`** *(DeepSeek Flash; parallel)*
  - Cel: realistyczny przykład (transkrypt głosu + artefakty) do testów PLAN dry-run (np. mały feature dla Neo).
  - AC: plik istnieje, realistyczny, 1 strona. Verify: czytelny.

- [ ] **T-A4 · PLAN dry-run (mock Linear)** *(orchestrator + DeepSeek; po A1)*
  - Cel: cały przepływ PLAN offline: `sample.md` → discovery→spec→decompose → parent+subtaski jako JSON do `planning/briefs/` + mock-linear JSON. Tanie kroki mogą realnie wołać OpenRouter wg `models.map`.
  - AC: ≥3 subtaski z `type`, estimate (t-shirt), AC (Given/When/Then); **DoR/DoD walidacja** (task bez AC odrzucony); **idempotencja** (re-run → brak duplikatów). 
  - Verify: uruchom dwa razy, zdiffuj output — identyczny. Deps: T-A1 (mechanizm), T-A3.

- [ ] **T-A5 · P0: cost guardrail** *(DeepSeek)*
  - Cel: kill-switch budżetu. AC: sesja przekraczająca `COST_BUDGET_USD_PER_TASK` → labelka/flaga `over-budget` + STOP. Wepnij w `cost-report.mjs` (pre-flight/loop check). Verify: test z niskim budżetem zatrzymuje.

- [ ] **T-A6 · P0: idempotency + loop-limit helpers** *(DeepSeek)*
  - Cel: wspólne utilsy: idempotentny create (klucz: slice/external-id) + licznik rund review (persystencja: labelka Linear lub lokalny plik).
  - AC: udokumentowane + test offline (re-run nie dubluje; po 2 rundach → `escalated`). Verify: testy.

---

## FAZA B — Mechanizm providera (ADR-0001; po A)

- [x] **T-B1 · `_lib.bat` tryb NATIVE** *(DeepSeek)* — `NATIVE=1` ⇒ pomiń `ANTHROPIC_BASE_URL`/`AUTH` (subskrypcja) + jawnie wyczyść dziedziczone `ANTHROPIC_*` (env Ollama/.env leak — bez tego native cicho trafia do Ollamy); brak ⇒ OpenRouter. Verify: echo env w obu trybach — PASS.
- [x] **T-B2 · `config/models.native.map` + profil w `plan.bat`** *(DeepSeek)* — profil Anthropic dla PLAN wg tabeli ADR-0001 (lead=opus, discovery/spec/decompose=sonnet, push=haiku, spec-review=opus), wartości = **realne Anthropic ID** (`claude-opus-4-8`/`claude-sonnet-4-6`/`claude-haiku-4-5-20251001` — bare aliasy NIE rozwiązywane jako main model). `plan.bat` conditional (`NATIVE`→native real ID, else→OR slugi) + `bin/plan-native.bat` wrapper. `check.mjs` lint `models.native.map` (check 5, allowed=real ID). Verify: native `main=claude-opus-4-8`, OR unchanged; `check.mjs` 5/0; smoke `plan-native.bat -p "Reply OK"` → `OK`.
- [x] **T-B3 · fallback native→OpenRouter w `plan.bat`** *(orchestrator)* — **zmiana per Mateusz:** brak auto-relaunch; dwie osobne wersje (launchery), user sam wybiera. Po `claude %*`: `if defined NATIVE if errorlevel 1 echo Native (subscription) failed — re-run: bin\plan.bat %*`. Verify: smoke native (not-logged-in fail) ⇒ hint wyświetlony — PASS. Realny "Reply OK" wymaga jednorazowego interaktywnego `/login` (OAuth claude.ai, po stronie Mateusza).

---

## FAZA C — Linear live  ✅ DONE (2026-06-24) — workspace jointhubs / team FEN / projekt „Linear Agents" / klucz LINEAR_API_KEY; bot @flow odłożony (MVP push jako user)

- [x] **T-C1 · `bootstrap-linear.mjs` live** *(DONE 2026-06-24)* — utworzono grupy/labelki/flagi/statusy z `config/linear/` w teamie FEN (schema drift fix: `issueLabelCreate` isGroup/parentId, `workflowStateCreate`; templates deferred). Idempotentne (re-run 0 created).
- [x] **T-C2 · Reframe: push via `LINEAR_API_KEY` GraphQL (headless), NIE MCP linear** *(decyzja 2026-06-24)* — MCP linear (claude.ai connector) wymaga interaktywnego OAuth Linear → nie ładuje się w headless `claude -p` (OR mode blokuje connectors w ogóle). Mateusz: opcja B (GraphQL). Ścieżka MCP zarzucona dla MVP. Verify: pokryte przez T-C3.
- [x] **T-C3 · PLAN push live = Milestone M3** *(DONE 2026-06-24)* — push przez `scripts/linear-push.mjs` (GraphQL, nie mock/MCP): 1 parent epic (FEN-1) + 9 subtask sub-issues (FEN-2…FEN-10) w projekcie „Linear Agents", labelki `ai:planned`+`type:feature`+9 `slice:*` (auto-create), estimate, stan Backlog, parentId. Idempotent (re-run → 10 issues, no dupes). `config/projects.json` wpis linear-agents; `agents/plan/agents/push.md` wired do skryptu.

---

## FAZA D — Squady end-to-end (po C i T-A1; build-plan M3–M6)

- [ ] **T-D1 · PLAN e2e** (bramki HITL przez `needs:*`+emoji) → realny epik.
- [ ] **T-D2 · DEV squad** — pick(dep-aware,WIP=1)→plan-mode(✅)→kod→In Review; safeguards (checkpoint→STATE.md, fallback, escalation).
- [ ] **T-D3 · REVIEW squad** — first-pass+security ∥ deep; max 2 rundy→escalated; Conventional Comments.
- [ ] **T-D4 · TEST squad** ⛔ (czeka na GCP VM) — deployer **przygotowuje + prosi Mateusza o ręczny trigger CI/CD** (nie deployuje sam po SSH); runner testuje zdeployowaną apkę (synthetic data) → Done. Patrz `docs/ci-cd.md`.
- [ ] **T-D4a · CI/CD workflows** *(DeepSeek)* — `.github/workflows/deploy-vm.yml` + `deploy-lambda.yml` (manual `workflow_dispatch`; inputy; **Lambda `instance_ip` required**) + `scripts/notify-linear.mjs`. Szkielety w `docs/ci-cd.md`. ⛔ secrets od Mateusza. Verify: `gh workflow run` z parametrami → deploy + health-check.
- [ ] **T-D4b · TEST reconcile** *(DeepSeek)* — zaktualizuj `prd-testing.md` / `agent-4-test.md` / `agents/test/agents/deployer.md`: deployer = prepare + prompt(trigger CI/CD) + verify, nie SSH-deploy.
- [ ] **T-D5 · CADENCE** — weekly digest + roadmap refresh (cron/morning_planner).

---

## FAZA E — Control-panel UI (wg `ux-design.md` §11 + `ux-improvements.md`)
Rozszerz `Desktop/experiments/0_linear` (Next.js). MVP→Phase2→Phase3 jak w ux-design.
- [x] **T-E0a** `scripts/ledger.mjs` — parser transkryptów claude (`~/.claude/projects/<hash>/*.jsonl`) → per-turn tokens+model+`attributionAgent`; `costTokens` × `config/models.json`; `aggregateRun`/`scanRuns`/`liveRuns`. PRD: `docs/telemetry-panel-prd.md`. Self-test 20/20. *(DeepSeek Flash)*
- [x] **T-E0b** `scripts/run-manifest.mjs` (gen-id/start/end) + wire `bin/_lib.bat` (start, single chokepoint) + end-call w każdym launcherze. Manifest `.state/runs/<runId>.json`. CRLF preserved. *(DeepSeek Flash)*
- [x] **T-E0c** `scripts/telemetry-server.mjs` — HTTP `localhost:7331` (`/api/runs`, `/runs/:id`, `/summary`, `/live`), zero deps, CORS. *(DeepSeek Flash)*
- [x] **T-E0a-fix** `byAgent.<agent>.costUSD` — per-turn model cost do obu kubełków (byModel+byAgent); był 0. *(DeepSeek Flash)*
- [x] **T-E1d** `0_linear` `app/api/agents-cost/route.ts` — server-side proxy do `localhost:7331` (same-origin, bez CORS w przeglądarce). `?view=runs|live|summary` / `?runId=`. tsc czysty. *(DeepSeek Flash)*
- [x] **T-E7a** `0_linear` `components/AgentsCostView.tsx` + tab „Agents & Cost" w Dashboard — live strip + summary + runs table + drill-down (recharts by-model/by-agent). Cost „$ (est.)". tsc czysty. *(DeepSeek Flash)*
- [x] **T-E0d** E2E verified: `plan.bat -p` → manifest → transcript → ledger → telemetry-server → 0_linear proxy → JSON. Real run `2026-06-25T11-35-29-plan`, $0.067, byAgent cost>0. *(orkiestrator — final approval)*
- [ ] **T-E0e (Phase 2)** exact `sessionId` w manifeście (łapać z runu claude) zamiast dopasowania po oknie `cwd`+`gitBranch`+czas — obecnie okno nadpuchla liczniki gdy sesja orkiestratora w tym samym cwd (PRD §7.1).
- [ ] **T-E7b (Phase 2)** Live runtime panel „co pracuje teraz" (obecnie live = lista zakończonych <10min temu) + code-production stream (git/commity) + link run→Linear issue + budget bar (cost-guard).
- [ ] **T-E1** top bar + nav · **T-E2** workspace switch (JOI/PISI) · **T-E3** Keys (.env r/w + Test) · **T-E4** signal views (5 filtrów + akcje emoji) · **T-E5** agent launch + terminal spawn · **T-E6** Config Model Routing **+ kolumna Provider/Fallback** (ux-improvements §1).

---

## FAZA F — Backlog features (później; po pilocie)
- [ ] **T-F1** PR-driven review + Copilot loop + wersjonowanie/UAT — patrz `docs/backlog/pr-review-loop-release-versioning.md` (zacznij od wyciągnięcia realnych PR-ów z fenixa).
- [ ] **T-F2** Eval `sakana/fugu-ultra` (cena/benchmark) → ew. dodać do `models.json` — `docs/backlog/model-candidates.md`.
- [ ] **T-F3** Router/proxy (ADR-0001 opcja B) — auto per-model fallback + monitoring per-agent, jeśli subskrypcja przestanie być priorytetem.

---

## FAZA G — Remote/headless execution: spawn agentów z Actions na VM (`docs/remote-agent-execution.md`)
**Prereq: T-A5 (cost kill-switch) + T-A6 (idempotency) — bo agent na VM działa bez nadzoru.**
- [ ] **T-G1 · VM agent-runner (provisioning)** ⛔ (GCP VM) — Claude Code CLI + Node + Docker + git + repo clones + **self-hosted GitHub runner**; klucze z Secrets do env joba. Verify: runner widoczny w repo, `claude` na PATH.
- [ ] **T-G2 · `bin/run-agent.sh`** *(DeepSeek)* — headless launcher (Linux), parytet z `.bat`: `CLAUDE_CONFIG_DIR`, provider OpenRouter, `LINEAR_WORKSPACE`/`PROJECT`/`BASIS`, odpala `claude -p`/Agent SDK detached. Verify: dry-run spawn loguje właściwy model+config.
- [ ] **T-G3 · `.github/workflows/spawn-agent.yml`** *(DeepSeek)* — `workflow_dispatch` inputs: stack, project, linear_issue, feature, ref, mode; runner self-hosted; szkielet w `docs/remote-agent-execution.md`. Verify: `gh workflow run` startuje agenta na VM.
- [ ] **T-G4 · async-HITL headless** *(orchestrator)* — w trybie headless plan-mode zastąp bramką Linear (`needs:approval` + komentarz planu + checkpoint/resume). Dotyczy gł. DEV. Verify: agent czeka na ✅ bez TUI.
- [ ] **T-G5 · SPIKE: `claude -p` vs Agent SDK** *(orchestrator)* — który lepszy do headless multi-turn pętli agenta. Verify: notatka + decyzja.

---

## 2. Risk register (pilnuj)
| Ryzyko | Mitygacja |
|---|---|
| Subagent `model:` nie honoruje OR-id | T-A1 spike PIERWSZE; fallback: config-dir per subagent / sloty |
| Linear MCP endpoint/auth | T-C2 zanim D; potwierdź na żywo |
| plan-mode na non-Anthropic (GLM) | zweryfikuj przy T-D2; escalate do Anthropic gdy plan-mode kluczowy |
| Cost runaway (agent w pętli) | T-A5 kill-switch zanim cokolwiek autonomiczne |
| Drift config↔subagenci | T-A2 linter jako bramka CI/lokalna |

## 3. Wejścia od Mateusza (odblokowują C/D)
OPENROUTER_API_KEY ✅ (w `.env`) · Linear: workspace/team + bot `@flow` (OAuth) + klucz · GCP VM (nazwa/projekt/zone). Lambda — deferred.
