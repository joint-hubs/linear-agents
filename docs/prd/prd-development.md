---
type: prd
status: active
area: development
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/development]
created: 2026-06-23
maturity: prd-v1
---

# PRD — DEVELOPMENT squad

> Obszar DEVELOPMENTU jako zestaw agentów (lead + 4 subagentów). Bierze task z `Todo`, planuje,
> koduje, oddaje do `In Review`. Spec: [agent-2-dev](../agents/agent-2-dev.md). Launchery — na końcu.

## 1. Cel
Z taska w `Todo` (dep-aware, WIP=1) dowieźć branch z kodem + self-test + komentarz „jak testować",
task w `In Review` (`ai:coded`), z bezpiecznikami.

## 2. Zestaw agentów
| Sub-agent | Model | Odpowiedzialność |
|---|---|---|
| **lead** (`dev`) | GLM-5.2 | pick(dep-aware,WIP=1), plan-mode, checkpoint, handoff |
| **recon** | MiniMax M3 | analiza task+kod → context packet (kluczowe pliki, wzorce, luki) |
| **implementer** | GLM-5.2, DeepSeek V4 Pro, DeepSeek V4 Flash (w zależności od klasyfikacji taska) | implementacja (baza) | 
| **refactorer** | Kimi K2.7 Code | multi-file / MCP-heavy (najlepszy tool-calling) |
| **debugger** | DeepSeek V4 Pro | hard bug / decyzja architektoniczna |

## 3. Jak zbudować
- Pliki: `agents/dev/agents/{recon,implementer,refactorer,debugger}.md` + lead `CLAUDE.md`.
- **lead**: wybiera task (Priority/Due, pomija `blocked by`), env-check (`delivery-loop`), plan-mode (weryfikuj opis↔kod), checkpoint co slice → `STATE.md`, branch per task + pull/rebase.
- **recon**: zwraca zwięzły context packet (nie surowy kod).
- **implementer/refactorer/debugger**: lead deleguje wg typu pracy (multi-file→refactorer, hard→debugger).
- **Typy**: `spike`→ADR (bez deploy), `tech`→technical criteria (bez user-AC).
- Komentarze do Mateusza PL (MiniMax M3); kod/commit EN.

## 4. HITL
Niejasne → komentarz @Mateusz (PL) + `needs:answer` → **sleep**. Plan gotowy → `needs:approval` → **✅ = exit plan-mode**.

## 5. Safeguards (P0)
WIP=1, dep-aware. Tool-call fail → retry → fallback Kimi/Opus. 2 nieudane próby → `escalated`. Cost guardrail. Idempotency (resume z STATE.md). **Nigdy `git push` bez zgody.**

## 6. Acceptance criteria
- [ ] Wybiera niezablokowany task po priorytecie; WIP=1.
- [ ] Plan-mode pokazuje plan; po ✅ koduje na branchu.
- [ ] Checkpoint → STATE.md; self-test (delivery-loop) przed In Review.
- [ ] Task → In Review z `ai:coded` + komentarz „jak testować" (PL).

## 7. Build steps
1. Subagenci `agents/dev/agents/*.md` + lead CLAUDE.md.
2. settings.json: Edit/Write/Bash(git,docker,npm) + Linear MCP; deny `git push`.
3. Smoke: `bin\agent.bat dev recon` na realnym tasku.
4. Cały squad: `bin\dev.bat` → task do In Review.

## 8. Launchery (funkcjonalne)
```bat
bin\dev.bat                      :: cały zestaw dev (lead deleguje recon/implementer/refactorer/debugger)
bin\agent.bat dev recon
bin\agent.bat dev implementer
bin\agent.bat dev refactorer
bin\agent.bat dev debugger
```
Pliki: [`bin/dev.bat`](../../bin/dev.bat) · [`bin/agent.bat`](../../bin/agent.bat).
