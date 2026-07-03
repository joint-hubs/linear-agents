---
type: build-plan
status: active
tags: [type/build-plan, area/ai, topic/linear, topic/agents]
created: 2026-06-23
updated: 2026-06-23 (Fala A — backend bez wejść zewn.)
maturity: plan-v1
---

# Build plan — co i jak zbudować (Fenix)

> Plan wykonawczy. Architektura wzbogacona o kluczową decyzję: **każdy obszar = ZESTAW agentów
> (squad)**, nie pojedynczy agent. Launchery odpalają **pojedynczego agenta** albo **cały zestaw**.
> PRD per obszar: [`docs/prd/`](prd/). Koncepcja: [`00-overview.md`](00-overview.md).

---

## 1. Architektura: squad per obszar

Każdy obszar ma **lead-agenta (orkiestrator)** + **sub-agentów** (Claude Code subagents w
`agents/<area>/agents/*.md`, każdy przypięty do modelu). Lead prowadzi przepływ i bramki HITL,
sub-agenci robią wyspecjalizowane kroki (różne modele, równoległość).

| Obszar (lead) | Sub-agenci (model) | Launcher zestawu | Launcher pojedynczego |
|---|---|---|---|
| **PLANNING** (`plan`) | discovery (MiniMax M3) · spec (GLM) · spec-review (MiniMax M3) · decomposer (MiniMax) · push (DeepSeek V4 Flash) | `bin\plan.bat` | `bin\agent.bat plan discovery` |
| **DEVELOPMENT** (`dev`) | recon (MiniMax) · implementer (GLM-5.2, DeepSeek V4 Pro, DeepSeek V4 Flash (w zależności od klasyfikacji taska)) · refactorer (Kimi K2.7 Code) · debugger (DeepSeek V4 Pro) | `bin\dev.bat` | `bin\agent.bat dev implementer` |
| **REVIEW** (`review`) | first-pass (DeepSeek V4 Pro) · security (Kimi K2.7 Code+tools) · deep (GLM-5.2) | `bin\review.bat` | `bin\agent.bat review deep` |
| **TESTING** (`test`) | deployer (DeepSeek V4 Pro) · scenario-gen (DeepSeek V4 Flash) · runner (MiniMax) · root-cause (GLM-5.2) | `bin\test.bat` | `bin\agent.bat test deployer` |
| **CADENCE** (`cadence`) | collector (MiniMax) · retro (GLM-5.2) · digest (DeepSeek V4 Pro) | `bin\cadence.bat` | `bin\agent.bat cadence retro` |

- **Launcher zestawu** (`bin\<area>.bat`) → odpala lead-agenta, który orkiestruje swój squad (subagenci przez Task tool, model per subagent).
- **Launcher pojedynczego** (`bin\agent.bat <area> <role>`) → odpala jednego sub-agenta standalone z jego dokładnym modelem (debug/targeted).
- **Cały pipeline** (`bin\all.bat`) → otwiera lead-agentów wszystkich obszarów (osobne okna).
- Routing modeli: [`config/models.json`](../config/models.json). Mechanika: provider OpenRouter, slot opus/sonnet/haiku + `ANTHROPIC_MODEL` per launcher.

---

## 2. Milestones (dokładnie co zrobić, w kolejności)

### M0 — Scaffold ✅ (zrobione)
Repo, docs (v2 + diagramy + research), config templates, bin launchery (set), agents skeleton, .gitignore/.env.example/ACCESS/STATE.

### M1 — Fundament Linear  ⟵ NEXT (częściowo gotowy kodowo)
- [ ] Potwierdzić **workspace/team** (JOI? PISI? oba?) → `.env LINEAR_TEAM_KEY`. *(czeka na Mateusza)*
- [ ] Utworzyć bota **`@flow`**: Linear → API → New OAuth app (`actor=app`), scope `app:assignable`+`app:mentionable`, webhooks (mention/assign/reaction/comment). Token → `.env`. *(czeka na Mateusza)*
- [x] `config/linear/templates/` — 4 issue templates (feature/bug/spike/tech) + README. ✅
- [x] `config/projects.json` — zrestrukturyzowane: workspace-keyed (joi|pisi), deploy target GCP VM, Lambda-GPU deferred. ✅
- [x] `config/models.json` — dodane `pricing` (USD/1M) dla wszystkich 8 modeli. ✅
- [x] `bin/agent.bat` — refaktoryzacja: czyta `config/models.map` zamiast hardcoded loops. `scripts/gen-model-map.mjs` utworzony. ✅
- [x] `scripts/cost-report.mjs` — w pełni zaimplementowany (zero-dep, OpenRouter activity, cost aggregation, divergence flag). ✅
- [x] `docs/adr/` — README + template. ✅
- [x] `docs/ui/ux-design.md` — UX design v1 dla control-panel UI. ✅
- [ ] `node scripts/bootstrap-linear.mjs` → utworzyć grupy/labelki + statusy + issue-templates z `config/linear/`. *(kod gotowy, czeka na klucz Linear API do uruchomienia na żywo)*
- **Acceptance:** labelki/statusy istnieją w Linear; `@flow` potrafi komentować i reagować emoji. *(blokowane na klucze + workspace)*

### M2 — Provider + klucze + smoke launcherów
- [ ] `.env` z kluczami (OpenRouter min.; Anthropic dla Opus/Sonnet jeśli native).
- [ ] Uzupełnić `config/projects.json` (repo↔projekt, GCP VM, Lambda).
- [ ] Smoke każdego launchera: `bin\plan.bat` → `/status` pokazuje właściwy model; Linear MCP odpowiada.
- **Acceptance:** wszystkie 5 launcherów łączą się z providerem + Linear MCP; `agent.bat` odpala pojedynczego sub-agenta.

### M3 — Squad PLANNING działa end-to-end
- [ ] Wdrożyć subagentów planowania (PRD planning) + bramki HITL przez `needs:*` + emoji.
- [ ] Test: prawdziwa notatka głosowa w `planning/inbox/` → brief → (approve) → parent epic + sub-issues w Linear z metadanymi.
- **Acceptance:** realny epik zdekomponowany do Linear (Todo, type:*, estimate, Initiative, ai:planned), idempotentnie.

### M4 — Squad DEVELOPMENT
- [ ] Subagenci dev + safeguards (WIP=1, dep-aware, checkpoint→STATE.md, tool-call fallback, escalation).
- [ ] Test: task z Todo → plan-mode (approve ✅) → kod na branchu → In Review.
- **Acceptance:** task doprowadzony do In Review z branchem + self-test + komentarzem PL.

### M5 — Squad REVIEW + TESTING
- [ ] Review: równoległy first-pass+security ∥ deep(GLM-5.2), max 2 rundy → escalated.
- [ ] Test: deploy GCP (health-check + **rollback**) → synthetic tests → Done.
- **Acceptance:** task przechodzi review i wraca/idzie do Done po realnym deployu na GCP.

### M6 — CADENCE + P0 hardening + (UI) + autonomia
- [ ] Cadence weekly (cron/morning_planner) → digest + roadmap refresh.
- [ ] P0: cost guardrail (`cost-report.mjs` + kill-switch), idempotency, observability po deployu.
- [ ] (opcjonalnie) Control-panel UI (rozszerzenie `0_linear`).
- **Acceptance:** P0 spełnione → dopiero teraz autonomiczny tryb (patrz [design-review §6](../decisions/design-review-and-gaps.md)).

---

## 3. Zależności / otwarte wejścia (blokują M1-M2)
1. Workspace/team Linear + bot `@flow`. *(JOI+PISI — guess, czeka na potwierdzenie)*
2. GCP VM (nazwa/projekt/zone). *(projects.json struktura gotowa, wartości VM do wpisania)*
3. Klucze API (5) → `.env`. *(OpenRouter, Anthropic, Linear JOI, Linear PISI, bot OAuth)*
4. Lambda AI — **deferred** (wrócić gdy GCP VM działa).
5. UI: decyzja potwierdzona — rozszerzyć `Desktop/experiments/0_linear`. UX design v1 gotowy.

## 4. Zasady przekrojowe (P0, z design-review §6)
loop-limit+escalation · cost guardrail · tool-call fallback · idempotency+resume · deploy health+rollback · HITL async (needs:*+emoji) · DoR/DoD gate. **Bez nich brak autonomii.**

## 5. Jak uruchamiać
```bat
bin\plan.bat                 :: cały squad planowania (lead orkiestruje subagentów)
bin\agent.bat dev implementer:: pojedynczy sub-agent standalone
bin\all.bat                  :: wszystkie obszary (osobne okna)
```
