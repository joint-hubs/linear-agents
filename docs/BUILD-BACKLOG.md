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

- [ ] **T-A1 · SPIKE: subagent model-pinning** *(rób PIERWSZE; orchestrator/interaktywnie)*
  - Cel: ustalić, czy Claude Code honoruje `model: <openrouter-id>` we frontmatter subagenta (cała architektura „model per subagent" na tym stoi).
  - Kroki: odpal `bin\agent.bat plan discovery` lub `bin\plan.bat`; niech lead spawnuje subagenta z `model: minimax/minimax-m3`; sprawdź `/status`/logi który model realnie poszedł.
  - AC: notatka `docs/adr/0002-subagent-model-mechanism.md` z wynikiem. Jeśli NIE działa → zaproponuj mechanizm: osobny `CLAUDE_CONFIG_DIR` per subagent **lub** mapowanie na sloty opus/sonnet/haiku.
  - Verify: notatka istnieje + decyzja. **Blokuje D (squady e2e), nie blokuje A2-A6.**

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

- [ ] **T-B1 · `_lib.bat` tryb NATIVE** *(DeepSeek)* — `NATIVE=1` ⇒ pomiń `ANTHROPIC_BASE_URL`/`AUTH` (subskrypcja); brak ⇒ OpenRouter. Verify: echo env w obu trybach.
- [ ] **T-B2 · `config/models.native.map` + profil w `plan.bat`** *(DeepSeek)* — profil Anthropic dla PLAN wg tabeli ADR-0001 (lead=opus, discovery/spec/decompose=sonnet, push=haiku, spec-review=opus). `plan.bat` wybiera profil native vs openrouter. Verify: oba profile ładują właściwe modele.
- [ ] **T-B3 · fallback native→OpenRouter w `plan.bat`** *(orchestrator)* — na 401/429 z Anthropic relaunch z OR + profil openrouter. MVP: jeśli auto-detekcja trudna, flaga `--or` + przełącznik z UI. Verify: symulowany fail → relaunch.

---

## FAZA C — Linear live  ⛔ BLOCKED (czeka na Mateusza: workspace/team, bot @flow OAuth, klucz Linear)

- [ ] **T-C1 · `bootstrap-linear.mjs` live** — utwórz grupy/labelki/flagi/statusy/templates z `config/linear/`. AC: idempotentne (re-run bez dup). Verify: `--dry-run` → live → sprawdź w Linear.
- [ ] **T-C2 · Linear MCP verify** — potwierdź endpoint/auth w `agents/*/settings.json` (transport, OAuth/token). Verify: agent czyta/komentuje issue.
- [ ] **T-C3 · PLAN push live** — podmień mock (T-A4) na realny Linear MCP; 1 realny epik. = **Milestone M3**. Verify: epik+subtaski w Linear z metadanymi.

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
- [ ] **T-E1** top bar + nav · **T-E2** workspace switch (JOI/PISI) · **T-E3** Keys (.env r/w + Test) · **T-E4** signal views (5 filtrów + akcje emoji) · **T-E5** agent launch + terminal spawn · **T-E6** Config Model Routing **+ kolumna Provider/Fallback** (ux-improvements §1) · **T-E7** Cost dashboard **+ token-log per-agent/per-task** (ux-improvements §2, przesunięte do Phase 2).

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
