---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/workflow, topic/critique, topic/risk]
created: 2026-06-22
updated: 2026-06-22
source: critical-review vs 13 research notes in Operations/Docs
maturity: review-v1
---

# Design review & gaps — Linear AI Workflow (iteracja 2, sceptyczna)

> Druga iteracja: szukam dziur, corner-case'ów i brakujących obszarów, weryfikując
> z **całością** researchu w `Second Brain/Operations/Docs`. Każde znalezisko ma:
> **co**, **dlaczego (cytat z researchu)**, **fix**, **priorytet** (P0 must / P1 should / P2 nice).

---

## 0. Trzy obserwacje meta (ramują wszystko poniżej)

**META-1 — Kalibruj rygor do skali SOLO.** Cały research powtarza: dobierz poziom do skali.
Review note §2: *„Solo lub 1-2 osoby = PR review + miesięczna retro"*. Testing §10.1: solo must-have =
pre-commit + 1 smoke E2E + manual smoke, reszta nice-to-have. → **Ryzyko mojego designu to
przeinżynierowanie** (7 statusów, 3 bramki HITL, pełny pipeline testowy). Dla Ciebie + agentów AI
wartość = **odciążenie**, nie ceremonia. Tnijmy proces tam, gdzie nie dowozi.

**META-2 — Brakuje PĘTLI, mamy tylko LINIĘ.** Obecny workflow jest liniowy: plan → dev → review →
test → done. Ale research (`roadmapping_patterns` §10 cadency, `template` §cyclicality, `review` 5 poziomów)
mówi, że planowanie to **cykl**: weekly review → roadmap refresh → retro → nowy input. **Nie ma 5.
elementu: cadence/review loop.** Bez niego taski się robią, ale nikt nie pyta „czy idziemy w dobrą stronę".

**META-3 — Estymacja, discovery i outcome są całkowicie pominięte.** Trzy duże notatki
(`estimation_techniques`, `software_project_planning`, `roadmapping`) — a w designie zero estymacji,
zero discovery-buffer, zero powiązania task→outcome/OKR. To nie detal — to fundament „po co" planujemy.

---

## 1. Weak points (błędy w obecnym designie)

| # | Słaby punkt | Dlaczego (research) | Fix | Prio |
|---|---|---|---|---|
| **W1** | **Brak estymacji/forecastu.** Dev sortuje „po priority/deadline", ale nic nie nadaje rozmiaru ani daty. | `estimation` §1: 3 legalne cele estymacji (komunikacja, triaging, bid/buy). `planning` §6. | Dodać **t-shirt size (S/M/L; XL→rozbij)** na etapie enrich + tag `ai-friendly/human/hybrid` z **+30-50% review time dla AI-code** (`estimation` §6.2). Później throughput forecast. | P1 |
| **W2** | **Za dużo statusów Linear** (Backlog→Todo→Ready→In Progress→In Review→Testing→Done = 7). | `review` §2: dobierz poziom do skali; solo = lekko. Linear natywnie: 4 stany. | Zwęzić do **Todo → In Progress → In Review → Done**. `Ready` = wynik **DoR-gate** (label/check), `Testing` = pod-faza In Review (label `testing`), nie osobny stan. | P1 |
| **W3** | **HITL = bottleneck na jednej osobie.** 3 bramki (brief, sanity, plan-mode) blokują na Tobie; każda to context-switch 20 min. | `cognitive_load` §2 (koszt przełączenia), §8 (slot na pytania). `template` problem 7. | **Batchuj bramki** (jeden „approval slot" dziennie), **soft-approve** low-risk po timeout (`review` §3E soft approval), trzymaj brief ≤1 strona (szybki review). | P0 |
| **W4** | **Pętla dev↔review bez limitu/eskalacji.** Review odbija task, dev poprawia, review odbija… nieskończona pętla (gorsza na tanich modelach). | `review` §16 (review iterations cel <2-3). | **Max 2 rundy** → eskalacja: dev na Opus, potem do Ciebie. Licznik rund w tasku. | P0 |
| **W5** | **Niższa niezawodność tool-callingu tanich modeli.** GLM/MiniMax 88-92% vs Claude 96% — więcej fail Edit/Bash/MCP, zwłaszcza Linear-push i multi-file. | `llm_models_openrouter` §5.3 (Berkeley FC). | Retry + **fallback na Claude/Kimi dla kroków MCP/multi-file** (Kimi K2.7 = MCP 81.1, najlepszy open). | P0 |
| **W6** | **Zero cost-observability/budżetu.** Cel = oszczędność, a nic nie mierzy ani nie limituje wydatku; agent w pętli spali $$$. | `planning` §8.3 (AI risk: cost blow-out, monitoring per PR). `llm_models` §5.1. | **Budżet $/task + tracking** (OpenRouter activity) + kill-switch; w control-panel UI. | P0 |
| **W7** | **Context drift w długich sesjach.** Dev na dużym tasku traci kontekst po godzinach. | `planning` §8.3; `estimation` §6.3 (sesje 2-4h + checkpoint). | **Checkpoint co slice / ~4h → zapis `STATE.md`** (masz już tę konwencję globalnie). Resume z STATE.md. | P1 |
| **W8** | **Ryzyko „pełen kontekst w każdym subtasku" (rot).** Enrich (MiniMax) może kopiować brief do 50 subtasków → desync. | `template` problem 2; `cognitive_load` §3 (parent+delta). | Wymusić **parent = pełen kontekst, subtask = delta + link**. Nigdy nie kopiuj. | P1 |
| **W9** | **Security review niedoprecyzowane.** Model łapie 60-80% security; reszta wymaga SAST/DAST/secret-scan + manual. | `software_delivery_review`; `testing` §4.5. | Dodać **SAST/SCA/secret-scan** do review/test (Snyk/Semgrep/Trivy/GitGuardian); Kimi K2.7 Code threat-model + narzędzia. | P1 |
| **W10** | **Polski na wyjściach user-facing z modeli CN.** Tytuły/opisy tasków i komentarze pisane przez MiniMax/DeepSeek będą słabe po polsku. | `llm_models_planning` §6; GPT MMMLU 83 vs Claude 91. | **Język per artefakt:** kod/docs = EN; komentarze do Ciebie + brief = **PL przez MiniMax M3**. | P1 |

---

## 2. Corner cases (sytuacje, których workflow nie obsługuje)

| # | Corner case | Dlaczego (research) | Fix | Prio |
|---|---|---|---|---|
| **C1** | **Spike / task badawczy** — output to wiedza/ADR, nie kod; timebox. Dev agent próbowałby „implementować". | `task_decomposition` §3 (SPIDR Spike); `template` Scenario E. | **Typ tasku `spike`** → dev produkuje ADR/decyzję, pomija deploy, ma timebox 1-2 dni. | P1 |
| **C2** | **Tech-debt / refactor / infra** — brak user-facing AC; nie „deployable" jako user-visible. | `template` Scenario E; `task_decomposition` §4; `cognitive_load` §10. | **Typ `tech`** → technical success criteria (testy/benchmark), bez user-journey check w review/test. | P1 |
| **C3** | **Task cross-repo / multi-project** — łamie model „jeden task → jedno repo". | `template` Scenario D; `roadmapping` cross-team. | Task może listować >1 repo; dev splituje lub obsługuje sekwencyjnie; relacje dependency. | P2 |
| **C4** | **Zależności / blocked tasks** — dev „sortuje po priority", ignoruje blokady; może wziąć zablokowany. | `engineering_task` §dependencies; INVEST-Independent. | **Dependency-aware selection**: pomiń `blocked by` niezamknięte; użyj relacji Linear. | P1 |
| **C5** | **Błędy transkrypcji głosu** (Whisper, PL terminy techniczne: KSeF, endpoint). | `template` problem 5. | Planner **echo-back + oznacza niepewne terminy** do potwierdzenia przed dekompozycją. | P1 |
| **C6** | **Idempotency / crash recovery** — agent pada po utworzeniu 5/8 subtasków albo po In Progress przed kodem → duplikaty/podwójne akcje. | `template` §STAGE 6 (atomic rollback). | **Idempotency**: sprawdź istniejące (label/extId) przed create; atomic push + rollback; resume z STATE.md. | P0 |
| **C7** | **Pusty/niewystarczający input planera** — vague voice memo → halucynacja planu. | `template` decision tree: „brak inputu → nie planuj". | **Input sufficiency gate**: za mało → poproś o uzupełnienie, nie zgaduj. | P1 |
| **C8** | **Deploy/rollback fail + brak observability** — TEST deployuje na GCP bez health-check/rollback; zepsuty deploy = prod down. | `testing` §5 (canary/rollback/kill-switch), §6 (observability). | Deploy z **health-check + auto-rollback**; dla ryzykownych: canary; sprawdź metryki/logi po deployu. | P0 |
| **C9** | **Dane testowe / RODO** — testowanie zdeployowanej apki na realnych danych osobowych. | `testing` §8.8 (synthetic data, no prod PII). | TEST używa **synthetic data**; nigdy prod PII. | P1 |
| **C10** | **Flaky tests / test theatre** — DeepSeek-bulk generuje trywialne asercje / niestabilne testy. | `testing` §8.1, §12. | Asercje na **wartości** (nie `toBeDefined`); mutation na krytycznych ścieżkach; flaky = fix, nie retry. | P2 |
| **C11** | **XL slice przeszedł dekompozycję** — dev się zatyka na za dużym tasku. | `task_decomposition`/`estimation`: nigdy nie zostawiaj XL. | **Size-gate**: slice > 2 dni → re-decompose przed dev. | P1 |
| **C12** | **Konflikty git / stale branch** — main ruszył (Ty albo inny agent) w trakcie pracy dev. | konwencja `git-checkpoint` (global). | Branch per task; **pull/rebase przed startem**; checkpoint commits. | P1 |
| **C13** | **HITL-odpowiedź zmienia scope po dekompozycji** — Twoja odpowiedź unieważnia utworzone subtaski. | `template` (re-loop). | **Wersjonuj brief**; zmiana scope → re-loop dekompozycji (nie ślepe doklejanie). | P2 |
| **C14** | **Plan-mode na słabszym modelu** — GLM może dać słaby plan / źle obsłużyć ExitPlanMode. | `llm_models_sd` §5.4 (latency/tool-call). | Plan-mode na GLM-5.2 OK dla typowych; **escalate do Opus** dla złożonych/ryzykownych. | P2 |

---

## 3. Brakujące obszary (co workflow MÓGŁBY/POWINIEN pokrywać)

| # | Brak | Dlaczego (research) | Co dodać | Prio |
|---|---|---|---|---|
| **M1** | **Discovery-first / discovery buffer** — planner robi 1-shot brief, brak ciągłego discovery dla nowych inicjatyw. | `planning` §8.1 (discovery 35-45% w erze AI); Torres Continuous Discovery. | Dla NOWYCH inicjatyw: faza discovery + możliwość spawnu spike'a; rezerwa ~30% (`planning` §10). | P1 |
| **M2** | **Cykliczny review/roadmap loop (5. element)** — brak weekly review, retro, refresh Now/Next/Later. | `roadmapping` §10; `template` §cyclicality; `review` 5 poziomów. | **5. launcher/cron „CADENCE"**: weekly digest (co zamknięte / blockery / drift) + roadmap refresh. Wpiąć w istniejący `morning_planner.py`/Hermes. | P1 |
| **M3** | **Powiązanie task → outcome/OKR/theme** — ryzyko „47 ficzerów, zero outcome". | `roadmapping` §3-4, §7; `planning` P4. | Parent epic linkuje do **Theme/Outcome**; planner pyta „jaki outcome to wspiera?". Linear Initiatives. | P1 |
| **M4** | **DoR/DoD jako jawne bramki** — „Ready" jest luźne; brak walidacji wejścia/wyjścia. | `engineering_task` §3; `cognitive_load` §5 (DoR = filtr wejścia). | **DoR-validator** (auto-odrzuć task bez Why/AC/scope-out/deps) + **DoD-checklist** w szablonie Linear (task bez AC = nieutworzony, `template` §STAGE 4). | P0 |
| **M5** | **Generowanie ADR** — decyzje architektoniczne nigdzie nie lądują → przyszły cognitive load. | `cognitive_load` §4; `planning` §1/§12. | Spec-review i dev **emitują ADR** do `docs/adr/NNNN-*.md` przy nietrywialnych decyzjach. | P1 |
| **M6** | **Env-readiness / reprodukowalność** — dev zakłada, że odpali lokalnie; projekty dockerowe. | `cognitive_load` §6 (env = największy extraneous load); `testing` §10. | Dev **weryfikuje env** (`docker compose up`, seed) przed kodem; użyj skilla `delivery-loop`. | P1 |
| **M7** | **Pre-loaded context packet na handoffach** — następny agent nie powinien re-derive. | `cognitive_load` §3 (checklist pre-loaded). | Standardowy **context packet** (parent link, AC, tech notes, patterns, env) przekazywany między agentami. | P1 |
| **M8** | **Metryki (DORA-lite)** — cycle time, throughput, review-iterations, change-failure, rework, $/task. | `review` §16; `testing` §9; `cognitive_load` §12. | Lekki **dashboard metryk** w control-panel UI (nie LOC/velocity — to bullshit metryki). | P2 |
| **M9** | **Knowledge capture / pamięć** — po tasku nic nie utrwala nauki. | `cognitive_load` §9; Atlas memory istnieje. | Post-task: ADR + update `STATE.md` + ewentualnie memory. | P2 |
| **M10** | **WIP limit / focus** — dev może nabrać za dużo; brak ochrony przed thrashingiem. | `estimation` §3.4 (WIP 1.5-2/os); `cognitive_load` §2 (2h blok). | **WIP limit** per agent (1 aktywny task). | P2 |
| **M11** | **Release / post-release review (opcjonalnie)** — wyższy poziom agregacji niż task. | `review` §5 (release readiness + post-release). | Dla user-facing: lekki **release checklist** (rollback, observability, release notes) — opcjonalnie. | P2 |
| **M12** | **Forecast dat (Monte Carlo / throughput)** — gdy zbierzesz historię. | `estimation` §2.5, §4.2. | Po ~50 taskach: throughput-based forecast „80% do daty X" w dashboardzie. | P2 |

---

## 4. Rekomendowane dodatki do workflow (v2)

Konkretnie, co dopiąć do designu (bez przeinżynierowania):

1. **Task typing** — `feature | spike | tech | bug`. Routuje zachowanie: spike→ADR (bez deploy), tech→technical-criteria, feature→pełny flow. (C1, C2)
2. **DoR-gate + DoD-checklist** — tani automat (DeepSeek/MiniMax) waliduje kompletność przy wejściu; szablon Linear z sekcjami AC/DoD. (M4, W2: „Ready" = wynik DoR-gate)
3. **Estymacja t-shirt + AI-tag** — w enrich; XL→re-decompose (size-gate). (W1, C11)
4. **Loop-limits + escalation ladder** — max 2 rundy review, max N follow-up; potem eskalacja modelu/HITL. (W4)
5. **Cost guardrail + metryki** — budżet $/task, kill-switch, dashboard w UI. (W6, M8)
6. **Checkpointing (STATE.md) + idempotency** — resume po crashu, brak duplikatów. (W7, C6)
7. **Deploy safety** — health-check + rollback (+ canary dla ryzykownych); synthetic test data. (C8, C9)
8. **CADENCE loop (5. element)** — weekly digest + roadmap refresh; wpięty w morning_planner/Hermes. (M2)
9. **Outcome linkage** — parent epic ↔ Theme/Outcome (Linear Initiatives). (M3)
10. **ADR capture + context packet** — decyzje do `docs/adr/`, standard handoff. (M5, M7)
11. **Security tooling** — SAST/SCA/secret-scan w review/test. (W9)
12. **Język per artefakt** — kod/docs EN, user-facing PL przez Claude. (W10)

### Zaktualizowana mapa (4 launchery + CADENCE)
```
0. CADENCE (cron/weekly)  → digest, roadmap refresh, retro          [MiniMax + GLM-5.2 (retro) + DeepSeek V4 Pro (digest)]
1. PLAN    → discovery → DoR-validate → spec → spec-review(ADR)
             → decompose+estimate(t-shirt) → DoD-checklist → push   [Opus punktowo, GLM, MiniMax]
2. DEV     → pick(dep-aware, WIP=1) → recon(context packet) → env-check
             → follow-up(PL) → plan-mode → checkpoint → In Review    [GLM base, Kimi (refactorer), DeepSeek V4 Pro (debugger)]
3. REVIEW  → first-pass + SAST/secret-scan ∥ deep(GLM-5.2) → max 2 rundy [DeepSeek V4 Pro (first-pass) + GLM-5.2 (deep) + Kimi K2.7 Code (security)]
4. TEST    → deploy(health-check+rollback) → synthetic tests
             → observability check → Done / back                     [MiniMax + DeepSeek V4 Pro (deployer) + GLM-5.2 (root-cause)]
```

---

## 5. Co ZOSTAWIĆ lekkie (anty-przeinżynierowanie dla solo)

Research wprost: nie kopiuj enterprise. **Na teraz pomiń** (dodasz, gdy zaboli):
- ❌ Pełna piramida testów (mutation/contract/chaos/visual-regression) → tylko **smoke + critical-path E2E + security-scan** (`testing` §10.1 solo).
- ❌ Formalne OKR/RICE/WSJF/Monte Carlo → na start **1 outcome per inicjatywa + t-shirt** (`roadmapping` §12 solo, `estimation` §9 solo).
- ❌ Release/cycle/portfolio review jako stałe ceremonie → **task-level + miesięczna retro** (`review` §2 solo).
- ❌ 7 statusów Linear → **4 stany** (W2).
- ❌ Productboard/Aha! → zostań na **Linear + Notion** (`planning_tools` §11.4: czego nie zmieniać).

---

## 6. Priorytety (kolejność wdrożenia)

**P0 (zanim cokolwiek odpalisz autonomicznie — bezpieczeństwo/koszt/poprawność):**
W3 (batch HITL), W4 (loop-limit+escalation), W5 (tool-call fallback), W6 (cost guardrail),
C6 (idempotency/resume), C8 (deploy rollback+health), M4 (DoR/DoD gate).

**P1 (rdzeń wartości — następna iteracja):**
W1 (estymacja), W2 (4 statusy), W7 (checkpoint), W8 (parent+delta), W9 (security tooling),
W10 (język), C1/C2 (task typing), C4 (deps), C5 (echo-back), C9 (synthetic data), C11 (size-gate),
C12 (git), M1 (discovery), M2 (cadence loop), M3 (outcome), M5 (ADR), M6 (env), M7 (context packet).

**P2 (gdy będzie historia/skala):**
C3 (cross-repo), C10 (flaky/mutation), C13 (brief versioning), C14 (plan-mode escalate),
M8 (metryki), M9 (knowledge capture), M10 (WIP), M11 (release review), M12 (forecast).

---

## 7. Pytanie do Ciebie
Czy zatwierdzasz tę listę jako podstawę **v2 designu** (zwłaszcza: 4 statusy zamiast 7, CADENCE jako 5. element, task typing, P0 jako twarde wymogi przed autonomią)? Po Twoim OK złożę zaktualizowane diagramy + opisy agentów już z tymi poprawkami.
