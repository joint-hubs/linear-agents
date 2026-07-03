---
type: prd
status: active
area: cadence
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/cadence]
created: 2026-06-23
maturity: prd-v1
---

# PRD — CADENCE squad

> Obszar CADENCE jako zestaw agentów (lead + 3 subagentów). Tygodniowa pętla domykająca linię
> w cykl. Spec: [agent-0-cadence](../agents/agent-0-cadence.md). Launchery — na końcu.

## 1. Cel
Raz w tygodniu: zebrać stan z Linear, wykryć drift, odświeżyć Now/Next/Later, zrobić retro,
wysłać **digest (PL)** do Mateusza. Read-mostly.

## 2. Zestaw agentów
| Sub-agent | Model | Odpowiedzialność |
|---|---|---|
| **lead** (`cadence`) | MiniMax M3 | orkiestracja tygodniowa |
| **collector** | MiniMax M3 | zebrać stan (throughput, In Progress/Review, blocked, escalated, over-budget, aging WIP) |
| **retro** | GLM-5.2 | drift + retro (blameless) + 1–3 action items |
| **digest** | DeepSeek V4 Pro | digest po polsku do Mateusza |

## 3. Jak zbudować
- Pliki: `agents/cadence/agents/{collector,retro,digest}.md` + lead `CLAUDE.md`.
- **collector**: czyta Linear (1M context MiniMax — tani); zwraca surowy stan.
- **retro**: GLM-5.2 — drift (taski bez Initiative, zaległe `needs:*`, stare otwarte, nadmiar WIP) + wnioski.
- **digest**: DeepSeek V4 Pro — PL: top priorytety, blockery, decyzje, linki do widoków; @Mateusz.
- **Read-mostly**: re-priorytety = propozycja w digeście (nie zmienia scope bez akceptacji).
- Trigger: cron weekly / `morning_planner.py` / Hermes.

## 4. Safeguards
Nie zmienia scope bez Mateusza. 1 digest/tydzień (bez spamu). Cost guardrail.

## 5. Acceptance criteria
- [ ] Tygodniowy digest (PL) z throughput, blockerami, driftem, action items.
- [ ] Wykrywa taski bez Initiative i zaległe `needs:*`.
- [ ] Proponuje (nie wymusza) zmiany Now/Next/Later.

## 6. Build steps
1. Subagenci `agents/cadence/agents/*.md` + lead CLAUDE.md.
2. settings.json: Read/Write + Linear MCP; deny Edit/push.
3. Cron/morning_planner trigger.
4. Smoke: `bin\agent.bat cadence collector`; cały squad: `bin\cadence.bat`.

## 7. Launchery (funkcjonalne)
```bat
bin\cadence.bat                  :: cały zestaw cadence (collector→retro→digest)
bin\agent.bat cadence collector
bin\agent.bat cadence retro
bin\agent.bat cadence digest
```
Pliki: [`bin/cadence.bat`](../../bin/cadence.bat) · [`bin/agent.bat`](../../bin/agent.bat).
