---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/agent, topic/code-review]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Agent 3 — REVIEW (code review)

> Recenzuje zmiany w taskach `In Review`: tani first-pass + narzędzia security **równolegle**
> z głębokim review na GLM-5.2. Conventional Comments, risk-tiered, limit rund.
> Launcher: `bin/review.bat` (`CLAUDE_CONFIG_DIR=configs/review`). Diagram: [04_review_test](diagrams/04_review_test.puml).

## Trigger
Task wchodzi w `In Review` (ręczne odpalenie lub webhook). Bierze taski z `In Review` bez `escalated`.

## Routing modeli
| Pass | Model | Łapie |
|---|---|---|
| First-pass | **DeepSeek V4 Pro** | lint/style/oczywiste bugi, brakujące testy |
| Security tooling | SAST/SCA/secret-scan (Semgrep/Snyk/Trivy/GitGuardian) | podatności, sekrety, CVE |
| Deep review | **GLM-5.2** | correctness, architektura, edge cases, biznes |
| Komentarze PL | **MiniMax M3** | wyjaśnienia do Mateusza (gdy trzeba) |

Dlaczego GLM-5.2 na deep: correctness / architektura / edge cases / logika biznesowa — wymaga najgłębszego rozumienia kodu.

## Kroki
1. **Load.** Diff + opis + AC + DoD + context packet. Rozmiar PR > 400 LOC → flaga + sugeruj split (`review` §3A).
2. **Risk-tiering.** `risk:high` / `type:tech`(security) / ścieżki auth-payments → głębszy rygor (`review` §3C).
3. **Parallel pass:** first-pass (DeepSeek) **∥** security tooling **∥** deep (GLM-5.2). 
4. **Merge findings → Conventional Comments** (`praise:`/`nitpick:`/`suggestion:`/`issue:`/`question:`) — tylko `issue:` blokuje.
5. **Verdykt:**
   - **Issues** → komentarz (PL gdy do Mateusza, MiniMax M3) → `In Progress`, **licznik rundy++**.
   - **Clean** → approve → label `ai:reviewed`, `stage:testing` (oddaje do TEST).
6. **DoD check:** testy/AC pokryte? Brak → traktuj jak issue.

## Metadane Linear
Status `In Review→In Progress|stage:testing` · `ai:reviewed` · `risk:high` · komentarze Conventional · `escalated` (przy limicie).

## Safeguards (P0)
- **Max 2 rundy** dev↔review → potem `escalated` + @Mateusz (W4). Licznik w metadanych/komentarzu.
- Security to nie tylko model — **zawsze SAST/secret-scan** (W9; model łapie 60–80%).
- Cost guardrail.

## Output
Approve → TEST, albo lista `issue:` → DEV. Zawsze action-oriented (zero „LGTM bez czytania", `review` §3).

## Failure handling
Niepewność architektoniczna → `needs:decision` + @Mateusz. Po 2 rundach bez zbieżności → `escalated`.
