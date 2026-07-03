---
type: prd
status: active
area: planning
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/planning]
created: 2026-06-23
maturity: prd-v1
---

# PRD — PLANNING squad

> Obszar PLANOWANIA jako **zestaw agentów** (lead + 5 subagentów). Zamienia notatkę głosową +
> artefakty w parent epic + sub-issues w Linear. Spec koncepcyjny: [agent-1-planner](../agents/agent-1-planner.md).
> Launchery (funkcjonalne) — na końcu.

## 1. Cel
Z `planning/inbox/<temat>.md` (transkrypt + artefakty) wytworzyć w Linear: parent (Initiative=outcome)
+ 3–15 sub-issues (Todo, `type:*`, estimate t-shirt, AC/DoD, relacje), sceptycznie i idempotentnie,
z 2 bramkami HITL (async).

## 2. Zestaw agentów
| Sub-agent | Model | Odpowiedzialność | I/O |
|---|---|---|---|
| **lead** (`plan`) | Opus | orkiestracja, bramki HITL, idempotencja | inbox → Linear |
| **discovery** | MiniMax M3 | jobs-to-be-done, stan obecny↔pożądany, ryzyka, corner-case, echo-back, pytania | transkrypt → brief ≤1 str. |
| **spec** | GLM-5.2 | tech design, scenariusze testowe, plan prod, **ADR** | brief → spec + `docs/adr/` |
| **spec-review** | MiniMax M3 | skeptic: dziury/corner-case (≤2 pętle) | spec → uwagi |
| **decomposer** | MiniMax M3 | vertical slices (INVEST), estimate t-shirt, AC/DoD (**link do parenta**), `type:*`, relacje | spec → sub-issues |
| **push** | DeepSeek V4 Flash | idempotentny zapis do Linear (sprawdź istniejące, rollback) | sub-issues → Linear |

## 3. Jak zbudować (per subagent)
- Pliki: `agents/plan/agents/{discovery,spec,spec-review,decomposer,push}.md` (frontmatter: `name`, `description`, `model`, `tools`) + lead `agents/plan/CLAUDE.md` (orkiestracja).
- **discovery**: system-prompt wymusza echo-back + flagę `transcript-uncertain`; brief ≤1 strona; lista pytań.
- **spec**: emit ADR przy nietrywialnych decyzjach; spec ≤ kontrakt, nie design-dump.
- **spec-review**: adversarial; zwraca konkretne dziury; max 2 pętle z `spec`.
- **decomposer**: INVEST; XL → re-split; AC w Given/When/Then; DoD-checklist; **nie kopiuj** parenta (link).
- **push**: przed create sprawdź po `slice:N`/external-id; przy >1 fail → rollback; labelki `ai:planned`, `type:*`.
- **DoR-gate** (lead, tani model): odrzuć brief bez Why/AC/scope-out/deps → `needs:answer`.

## 4. Bramki HITL (async, przez metadane)
- **GATE 1** (po discovery): lead ustawia `needs:approval` + @Mateusz; czeka na ✅ (lub defer-to-spike).
- **GATE 2** (po decompose): sample 2–3 sub-issues → `needs:approval` → ✅.
Patrz [signaling-protocol](../decisions/linear-signaling-protocol.md).

## 5. Safeguards (P0)
Pusty input → nie planuj. Task bez AC → nie twórz. Push idempotentny + rollback. Cost guardrail (`over-budget`). HITL nie blokuje (sleep).

## 6. Acceptance criteria
- [ ] Realna notatka → brief ≤1 str. + pytania, z `transcript-uncertain` gdy trzeba.
- [ ] Po ✅: parent (Initiative) + 3–15 sub-issues w Todo, każdy z `type:*`, Estimate, AC/DoD, relacje.
- [ ] Ponowne uruchomienie nie duplikuje (idempotencja).
- [ ] Tekst do Mateusza po polsku; ADR/spec po angielsku.

## 7. Build steps
1. Utwórz subagentów `agents/plan/agents/*.md` + lead CLAUDE.md.
2. Wepnij Linear MCP (`agents/plan/settings.json`) + `config/linear` (labelki/statusy).
3. Smoke: `bin\agent.bat plan discovery` na przykładowej notatce.
4. Cały squad: `bin\plan.bat` end-to-end → Linear.

## 8. Launchery (funkcjonalne)
```bat
:: cały zestaw planowania (lead orkiestruje discovery→spec→spec-review→decomposer→push)
bin\plan.bat

:: pojedynczy sub-agent (debug/targeted) — agent.bat <area> <role>
bin\agent.bat plan discovery
bin\agent.bat plan spec
bin\agent.bat plan spec-review
bin\agent.bat plan decomposer
bin\agent.bat plan push
```
Pliki: [`bin/plan.bat`](../../bin/plan.bat) (zestaw) · [`bin/agent.bat`](../../bin/agent.bat) (pojedynczy).
