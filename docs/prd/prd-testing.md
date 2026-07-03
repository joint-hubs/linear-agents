---
type: prd
status: active
area: testing
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/testing, topic/deploy]
created: 2026-06-23
maturity: prd-v1
---

# PRD — TESTING squad

> Obszar TESTÓW/DEPLOY jako zestaw agentów (lead + 3 subagentów). Deployuje i testuje
> **działającą aplikację**. Spec: [agent-4-test](../agents/agent-4-test.md). Launchery — na końcu.

## 1. Cel
Task `stage:testing` → deploy (OpenRouter build → GCP VM, **health-check + rollback**) → testy na
zdeployowanej apce (smoke + critical-path + security-lite, synthetic data) → `Done` lub zwrot do `In Progress`.

## 2. Zestaw agentów
| Sub-agent | Model | Odpowiedzialność |
|---|---|---|
| **lead** (`test`) | MiniMax M3 | orkiestracja deploy→test→verdykt |
| **deployer** | DeepSeek V4 Pro | build + deploy GCP VM + **health-check + auto-rollback** |
| **scenario-gen** | DeepSeek V4 Flash | scenariusze (happy + 3–5 edge) z AC, **synthetic data** |
| **runner** | MiniMax M3 (multimodal) | run E2E smoke/critical-path + observability (zrzuty UI) |
| **root-cause** | GLM-5.2 | diagnoza failów |

## 3. Jak zbudować
- Pliki: `agents/test/agents/{deployer,scenario-gen,runner,root-cause}.md` + lead `CLAUDE.md`.
- **deployer**: cel z `config/projects.json` (GCP VM; Ollama/GPU → Lambda); health-check endpoint; fail → rollback do poprzedniej wersji + komentarz.
- **scenario-gen**: **nigdy prod PII** — synthetic/factory data (RODO).
- **runner**: asercje na **wartości** (nie `toBeDefined`); flaky → fix, nie retry; sprawdza observability (logi/metryki po deployu).
- **root-cause**: GLM-5.2 dla hard-debug failów → komentarz → `In Progress`.
- Profil solo: smoke + critical-path + security-lite (NIE pełna piramida).

## 4. Safeguards (P0)
**Health-check + rollback** obowiązkowe. Synthetic data. Wspólny loop-limit z DEV → `escalated`. Cost guardrail. Deploy fail → rollback + `escalated`.

## 5. Acceptance criteria
- [ ] Deploy OpenRouter build na GCP VM; przy fail health-check → auto-rollback.
- [ ] Testy na zdeployowanej apce z synthetic data; asercje wartościowe.
- [ ] Pass → `Done` (+ URL deployu); fail → root-cause (GLM-5.2) → `In Progress`.
- [ ] Ollama/GPU build → ścieżka Lambda.

## 6. Build steps
1. Subagenci `agents/test/agents/*.md` + lead CLAUDE.md.
2. settings.json: Bash(docker,gcloud,ssh,curl,playwright) + Write + Linear MCP; deny `rm -rf`,`git push`.
3. `config/projects.json` z nazwą GCP VM + Lambda.
4. Smoke: `bin\agent.bat test deployer` (dry-run); cały squad: `bin\test.bat`.

## 7. Launchery (funkcjonalne)
```bat
bin\test.bat                     :: cały zestaw test (deployer→scenario-gen→runner→root-cause)
bin\agent.bat test deployer
bin\agent.bat test scenario-gen
bin\agent.bat test runner
bin\agent.bat test root-cause
```
Pliki: [`bin/test.bat`](../../bin/test.bat) · [`bin/agent.bat`](../../bin/agent.bat).
