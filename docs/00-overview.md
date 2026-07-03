---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/workflow, topic/claude-code, topic/orchestration]
created: 2026-06-22
updated: 2026-06-22
source: synthesis of model-comparison + design-review-and-gaps + linear-signaling-protocol + 13 research notes
maturity: design-v2
---

# Linear AI Workflow — master overview (v2)

> System wieloagentowy oparty na **Linear + Claude Code**, uruchamiany z izolowanych
> plików `.bat` (każdy agent = własny provider/model + własna konfiguracja). Cel: maksymalne
> **odciążenie** Mateusza przy **minimalnym koszcie**, z human-in-the-loop tylko w krytycznych
> punktach. Ten plik spina wszystko — szczegóły w plikach per agent + dokumentach pomocniczych.

**Dokumenty powiązane:**
[model-comparison-and-routing.md](decisions/model-comparison-and-routing.md) ·
[design-review-and-gaps.md](decisions/design-review-and-gaps.md) ·
[linear-signaling-protocol.md](decisions/linear-signaling-protocol.md) ·
agenci: [0-cadence](agents/agent-0-cadence.md) · [1-planner](agents/agent-1-planner.md) · [2-dev](agents/agent-2-dev.md) · [3-review](agents/agent-3-review.md) · [4-test](agents/agent-4-test.md) ·
diagramy: [`diagrams/`](diagrams/)

---

## 1. Zasady naczelne (z researchu)

1. **Kalibruj do solo.** Lekko, nie po enterprise. Wartość = odciążenie, nie ceremonia (`review` §2, `testing` §10.1).
2. **Discovery drożeje, delivery tanieje.** Najmocniejszy model (Opus) idzie tam, gdzie myślenie ma dźwignię; resztę robią tanie modele (`planning` §8.1).
3. **Task samowystarczalny.** Agent bierze, rozumie w „10 min", zamyka — nie zgaduje (`cognitive_load` §15). Parent = kontekst, subtask = delta + link.
4. **Linear ≠ Jira.** Minimalizm: 4 statusy, ~5 grup labelek, pola natywne > labelki (`planning_tools` §11.4 + docs Lineara).
5. **Pole natywne > labelka > komentarz.** Metadane Lineara to magistrala sygnałów człowiek↔agent ([protokół](decisions/linear-signaling-protocol.md)).
6. **HITL async i batchowane.** Agent nigdy nie blokuje interaktywnie — sygnalizuje `needs:*` i idzie spać; Mateusz odpowiada zbiorczo (reakcja ✅ / `@flow`).

---

## 2. Pięć elementów (CADENCE + 4 launchery)

| # | Element | Trigger | Główne modele | Co robi |
|---|---|---|---|---|
| 0 | **CADENCE** | cron (weekly) | MiniMax M3 (lead/collector) + GLM-5.2 (retro) + DeepSeek V4 Pro (digest) | digest, refresh Now/Next/Later, retro, wykrywanie driftu |
| 1 | **PLAN** | voice memo + artefakty (UI inbox) | Opus 4.8 (lead) + GLM-5.2 (spec) + MiniMax M3 (discovery/spec-review/decompose) + DeepSeek V4 Flash (push) | discovery → DoR → spec(+ADR) → decompose+estimate → DoD → push do Linear |
| 2 | **DEV** | task w `Todo` (dep-aware) | GLM-5.2 (lead/implementer) + MiniMax M3 (recon) + Kimi K2.7 Code (refactorer) + DeepSeek V4 Pro (debugger) | pick → recon → env-check → plan → kod → `In Review` |
| 3 | **REVIEW** | task w `In Review` | GLM-5.2 (lead/deep) + DeepSeek V4 Pro (first-pass) + Kimi K2.7 Code (security) | first-pass+security ∥ deep; max 2 rundy |
| 4 | **TEST** | task po approve review | MiniMax M3 (lead/runner) + DeepSeek V4 Pro (deployer) + DeepSeek V4 Flash (scenarios) + GLM-5.2 (root-cause) + GPT-5.5 (terminal) | deploy(GCP)+health/rollback → synthetic tests → `Done` |

Każdy launcher = **osobny `.bat`** ustawiający izolowany `CLAUDE_CONFIG_DIR` + providera (§6).

---

## 3. Linear: statusy, typy, metadane (skrót — pełnia w [protokole](decisions/linear-signaling-protocol.md))

**Statusy (4):** `Todo → In Progress → In Review → Done` (+ `Canceled`).
- „Ready" = flaga `dor-ok` (nie osobny status). „Testing" = label `stage:testing` w obrębie `In Review`.

**Typy tasków** (grupa `type:`): `feature` · `bug` · `spike` · `tech` — routują zachowanie:
- `spike` → output ADR/decyzja, **bez deploy**, timebox 1–2 dni.
- `tech` → technical success criteria (testy/benchmark), bez user-journey check.
- `feature`/`bug` → pełny flow.

**Pola natywne:** Priority (sort dev) · Estimate **t-shirt** (XL→re-decompose) · Relations `blocked by` (zależności) · Assignee = bot `@flow` / Mateusz · Initiative (outcome) · Project (repo) · parent/sub-issue.

**Sygnały (labelki/flagi):** `needs:{answer|approval|decision|access}` · `risk:high` · `ai:{planned|coded|reviewed}` · `dor-ok`/`dod-ok` · `escalated` · `over-budget` · `transcript-uncertain` · `blocked`.

**Mikro-dialog (emoji na komentarzu agenta):** 👀 agent „działam" · ✅ człowiek „leć" · 🚫 „zmiany" · 🔁 „przerób".

---

## 4. Przepływ end-to-end (happy path + pętle)

```
[voice memo + artefakty] → PLAN
   discovery → (DoR-gate) → spec (+ADR) → spec-review (MiniMax M3, ≤loop)
   → decompose + estimate(t-shirt) → DoD-checklist → push (idempotent)
   → Linear: parent(Initiative) + sub-issues w Todo, type:*, ai:planned
        │  [GATE 1/2 HITL: brief + sample — reakcja ✅ / needs:approval]
        ▼
DEV  pick(Todo, priority/deadline, dep-aware, WIP=1) → recon(context packet)
   → env-check → [type routing] → (niejasne? needs:answer + @flow, sleep)
   → plan → [approve: ✅] → In Progress → kod (checkpoint co slice → STATE.md)
   → DoD → In Review, ai:coded
        ▼
REVIEW  first-pass + SAST/secret-scan  ∥  deep(GLM-5.2, risk-tiered)
   → issues? Conventional Comments → In Progress  (max 2 rundy → escalated)
   → clean → approve, ai:reviewed, stage:testing
        ▼
TEST  deploy OpenRouter build → GCP VM (health-check + rollback)
   → synthetic tests + observability check
   → pass → Done   |   fail → komentarz + In Progress (root-cause GLM-5.2)
        ▼
CADENCE (weekly)  digest + roadmap refresh + retro  → nowy input do PLAN
```

Diagramy: [00_overview](diagrams/00_overview.puml) (całość), [01_state_machine](diagrams/01_linear_state_machine.puml),
[02_planning](diagrams/02_planning_pipeline.puml), [03_dev](diagrams/03_dev_agent.puml),
[04_review_test](diagrams/04_review_test.puml), [05_cadence](diagrams/05_cadence_loop.puml),
[06_signaling](diagrams/06_signaling_protocol.puml).

---

## 5. P0 — twarde wymogi PRZED autonomią (bezpieczeństwo/koszt/poprawność)

Z [design-review](decisions/design-review-and-gaps.md) §6. Bez tych mechanizmów agenci NIE działają autonomicznie:

1. **Loop-limit + escalation ladder** — max 2 rundy review / N follow-upów → eskalacja (poniżej). (W4)
2. **Cost guardrail** — budżet $/task + kill-switch; przekroczenie → flaga `over-budget` + stop. (W6)
3. **Tool-call fallback** — fail Edit/Bash/MCP → retry → fallback GLM→Kimi/Opus dla kroków MCP/multi-file. (W5)
4. **Idempotency + resume** — sprawdź istniejące przed create; atomic push z rollbackiem; resume z `STATE.md`. (C6)
5. **Deploy safety** — health-check + auto-rollback; synthetic data (nie prod PII). (C8, C9)
6. **HITL async batch** — `needs:*` + widok 🔔; bez blokowania interaktywnego. (W3)
7. **DoR/DoD gate** — task bez Why/AC/scope-out/deps = nieprzyjęty; bez DoD = niezamknięty. (M4)

### Escalation ladder (model + człowiek)
```
krok agenta zawodzi / niepewność / >limit
  → retry (ten sam model)
  → escalate model: GLM-5.2 → Kimi K2.7 (MCP/multi-file) / Opus 4.8 (reasoning/hard)
  → needs:* + @Mateusz (komentarz PL, MiniMax M3) + flaga escalated
  → STOP (czeka na człowieka)
```

---

## 6. Izolacja i launchery `.bat`

Każdy agent = **izolowany `CLAUDE_CONFIG_DIR`** (własne settings/agents/skills/MCP/credentials — zero mieszania z „freestyle" ani między agentami). Provider przez env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=` pusty + `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_OPUS|SONNET|HAIKU_MODEL`).

```
linear-workflow/
  configs/
    cadence/   (CLAUDE.md, settings.json [env: model routing], agents/, skills/, .mcp.json → Linear)
    plan/
    dev/
    review/
    test/
  bin/
    cadence.bat  plan.bat  dev.bat  review.bat  test.bat
  config/
    projects.json   (Linear project → repo path, deploy target GCP VM / Lambda)
```

Szczegóły mechaniki w [model-comparison §4](decisions/model-comparison-and-routing.md) i w plikach per agent.

---

## 7. Routing modeli (skrót — pełnia w [porównaniu](decisions/model-comparison-and-routing.md))

Baza **GLM-5.2** (review/deep, dev lead, test root-cause, cadence retro); **Opus 4.8** tylko na leadzie PLAN; **MiniMax M3** (discovery/spec-review/decompose, recon, cadence); **DeepSeek V4 Pro** (debugger/first-pass/deployer/digest) + **Flash** (push/scenariusze); **Kimi K2.7 Code** (refaktor/security); **GPT-5.5** (terminal).

---

## 8. Otwarte wejścia konfiguracyjne (placeholdery do uzupełnienia)

| Co | Gdzie | Status |
|---|---|---|
| Workspace/team Linear + bot user `@flow` (OAuth app, webhooks) | `configs/*/.mcp.json` + Linear settings | do podania |
| Mapa `Linear project → repo path` | `config/projects.json` | do uzupełnienia |
| Deploy target per projekt: **GCP VM** (OpenRouter build) / **Lambda AI** (Ollama/GPU) | `config/projects.json` | do podania |
| Klucze: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, klucze providerów | env / vault (ACCESS.md) | do podania |
| Control-panel UI (rozszerzenie `Desktop/experiments/0_linear`) | osobny krok | do zrobienia |

---

## 9. Co świadomie pominięte na teraz (anty-over-engineering)
Pełna piramida testów (mutation/contract/chaos), formalne OKR/RICE/Monte-Carlo, release/portfolio review, 7 statusów, custom fields (Linear ich nie ma), Productboard/Aha!. Dodajemy, gdy zaboli (skala/historia). Patrz [design-review §5](decisions/design-review-and-gaps.md).
