---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/agent, topic/planning]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Agent 1 — PLAN (planowanie)

> Zamienia **notatkę głosową + artefakty** w **parent epic + sub-issues w Linear**, gotowe do
> developmentu. Sceptyczny, szuka dziur. Wieloetapowy, z 2 bramkami HITL. Launcher: `bin/plan.bat`
> (`CLAUDE_CONFIG_DIR=configs/plan`). Diagram: [02_planning_pipeline](diagrams/02_planning_pipeline.puml).

## Trigger
Wrzucenie pliku do `planning/inbox/<temat>.md` (transkrypt głosu + ścieżki artefaktów) — z UI lub ręcznie.

## Routing modeli
| Stage | Model | Provider env |
|---|---|---|
| Discovery synthesis | **MiniMax M3** | `ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3` |
| Spec / design draft | **GLM-5.2** | `ANTHROPIC_MODEL=z-ai/glm-5.2` |
| Spec review (skeptic) | **MiniMax M3** | `ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3` |
| Decompose + enrich | **MiniMax M3** | `ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3` |
| Linear push | **DeepSeek V4 Flash** | `deepseek/deepseek-v4-flash` |
| Polskie pytania do Mateusza | **MiniMax M3** | `ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3` |

## Inputs
- Transkrypt głosu (Wispr/Whisper — możliwe błędy PL terminów).
- Artefakty: `.md/.txt/.docx`-export, screenshoty, linki.
- `STATE.md` projektu (jeśli istnieje w mapowanym repo) — wciąga stan obecny.

## Kroki
1. **Discovery synthesis (MiniMax).** Ekstrakcja jobs-to-be-done; porównanie **stan obecny (STATE.md + recon kodu) ↔ stan pożądany**; top-5 ryzyk; corner-case'y; lista pytań. **Echo-back** rozumienia; oznacz niepewne terminy → flaga `transcript-uncertain` (C5). Output: **brief ≤1 strona** w `planning/briefs/`.
2. **DoR-gate (auto, DeepSeek).** Walidacja: Why / AC-szkic / scope-out / dependencies / outcome obecne? Niekompletne → `needs:answer`. (M4)
3. **GATE 1 — HITL (async).** Agent ustawia `needs:approval` + @Mateusz; **czeka na ✅ / odpowiedzi** (nie blokuje). Decyzja: approve / uzupełnij / **defer-to-spike** (→ tworzy `type:spike`).
4. **Spec / design (GLM).** Szczegóły techniczne, scenariusze testowe, plan wdrożenia prod. Nietrywialne decyzje → **ADR** w `docs/adr/NNNN-*.md` (M5).
5. **Spec review — skeptic (MiniMax).** Szuka dziur/corner-case; pętla z krokiem 4 (≤2 iteracje).
6. **Decompose + estimate (MiniMax).** Vertical slices (INVEST), 3–15 sub-issues; **estimate t-shirt**, XL → re-decompose (C11); `slice:N`; relacje `blocked by`; typ per task.
7. **Enrich (MiniMax, równolegle).** Każdy subtask: Title / Context(**link do parenta, nie kopia** — W8) / AC (Given-When-Then) / scope in-out / tech notes / DoD-checklist. Task bez AC = odrzucony (M4).
8. **GATE 2 — HITL (async).** Sample 2–3 subtaski → `needs:approval`. ✅ = approve batch.
9. **Push do Linear (DeepSeek, idempotent).** parent (Initiative=outcome, M3) + N sub-issues w `Todo`; labelki `ai:planned`, `type:*`, `slice:N`; atomic — przy >1 fail rollback (C6).

## Metadane Linear (zapis)
Status `Todo` · Initiative (outcome) · Project (repo) · Estimate (t-shirt) · Priority · Relations `blocked by` · labelki `type:*`, `ai:planned`, `dor-ok`, `transcript-uncertain`.

## Safeguards
- Pusty/wątły input → **nie planuje**, prosi o uzupełnienie (C7).
- Brief ≤1 strona (szybki review, W3). Wersjonowany (zmiana scope → re-loop, C13).
- Cost guardrail; idempotent push.

## Output
parent epic + 3–15 sub-issues (Todo, samowystarczalne) · brief w vault · ADR (jeśli były decyzje).

## Failure handling
Output generyczny → eskalacja Opus xhigh / GPT-5.5. Push fail → rollback + `escalated` + @Mateusz.
