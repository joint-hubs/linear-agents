---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/agent, topic/development]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Agent 2 — DEV (development)

> Bierze taski z `Todo`, rozumie je (pytając gdy trzeba), planuje, koduje, oddaje do review.
> Launcher: `bin/dev.bat` (`CLAUDE_CONFIG_DIR=configs/dev`). Diagram: [03_dev_agent](diagrams/03_dev_agent.puml).

## Trigger
Ręczne odpalenie `.bat` (lub webhook na assign `@flow`). Agent sam wybiera task z `Todo`.

## Routing modeli
| Krok | Model |
|---|---|
| Recon (analiza task+kod) | **MiniMax M3** |
| Implementacja (baza) | **GLM-5.2** |
| Multi-file / MCP-heavy | **Kimi K2.7 Code** (escalate) |
| Hard bug / decyzja arch | **DeepSeek V4 Pro** (escalate) |
| Komentarze PL do Mateusza | **MiniMax M3** |

## Kroki
1. **Pick (dep-aware, WIP=1).** Query `Todo`, sort po Priority/Due date; **pomiń `blocked by` niezamknięte** (C4); weź 1 task (WIP=1, M10). Repo z `config/projects.json`.
2. **Recon (MiniMax).** Czyta opis + komentarze + checklist; skan kodu → **context packet** (kluczowe pliki, wzorce, luki) (M7).
3. **Env-check (delivery-loop).** `docker compose up` / seed; env działa? Nie → `needs:access` + @Mateusz (M6).
4. **Type routing.** `spike` → research → **ADR**, bez kodu prod, timebox (C1). `tech` → technical criteria, bez user-journey (C2). `feature`/`bug` → dalej.
5. **Clarify (jeśli niejasne).** Komentarz @Mateusz **po polsku, nietechnicznie** (MiniMax M3) + `needs:answer` → **idzie spać** (async). Wraca po ✅/odpowiedzi.
6. **Plan.** Plan-mode (Claude Code): weryfikacja opisu ↔ stan faktyczny kodu. Prezentuje plan w komentarzu. Złożone → escalate Opus (C14).
7. **GATE — approve (HITL).** `needs:approval`; Mateusz reaguje **✅** (lub 🚫/🔁) → agent wychodzi z plan-mode.
8. **Implement (GLM).** Branch per task; **pull/rebase przed startem** (C12); `In Progress`; kod. **Checkpoint co slice → `STATE.md`** (W7). Multi-file → Kimi; hard → DeepSeek V4 Pro.
9. **Self-verify (delivery-loop).** Build/test/rebuild+redeploy lokalnie; DoD-checklist.
10. **Hand-off.** Komentarz-podsumowanie (co zrobione, jak testować) + odhacza checklist → status `In Review`, label `ai:coded`. Ryzykowne → `risk:high`.

## Metadane Linear
Status `Todo→In Progress→In Review` · Assignee `@flow` · `ai:coded` · `risk:high` (gdy) · `needs:*` · relations.

## Safeguards (P0)
- WIP=1; dep-aware pick. Loop-limit follow-upów → `escalated`.
- Tool-call fail → retry → fallback Kimi/Opus (W5). Cost guardrail → `over-budget`+stop (W6).
- Idempotency: nie dubluje commitów/komentarzy po restarcie; resume z `STATE.md` (C6).
- Język: kod/commit/docs **EN**; komentarze do Mateusza **PL** (W10).

## Output
Branch z kodem + self-test + komentarz „jak przetestować" · task w `In Review`. ADR dla spike/decyzji.

## Failure handling
Niejasność → `needs:*`. Blokada zewn. → `blocked` + relacja. Po 2 nieudanych próbach → `escalated` + @Mateusz.
