---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/agent, topic/cadence, topic/roadmap]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Agent 0 — CADENCE (pętla cykliczna)

> 5. element, którego brakowało: zamyka **pętlę** wokół liniowego plan→dev→review→test.
> Bez niego taski się robią, ale nikt nie pyta „czy idziemy w dobrą stronę" (`roadmapping` §10,
> `template` §cyclicality). Lekko — solo profile. Launcher: `bin/cadence.bat`
> (`CLAUDE_CONFIG_DIR=configs/cadence`) lub cron. Diagram: [05_cadence_loop](diagrams/05_cadence_loop.puml).

## Trigger
Cron **weekly** (np. niedziela/poniedziałek rano). Może wpiąć się w istniejący `morning_planner.py` / Hermes.

## Routing modeli
| Krok | Model |
|---|---|
| Digest (czytanie 100+ issues, throughput) | **MiniMax M3** |
| Retro / wnioski / drift analysis | **GLM-5.2**  |
| Polski tekst digestu do Mateusza | **DeepSeek V4 Pro** |

## Kroki
1. **Zbierz stan (MiniMax).** Z Linear: co zamknięte (throughput tygodnia), co `In Progress`/`In Review`, co `blocked`, co `escalated`/`over-budget`/`risk:high`, aging WIP (`estimation` §4.4).
2. **Wykryj drift.** Taski bez Initiative (brak powiązania z outcome, M3); zaległe `needs:*` (czekają na Mateusza > X dni); stare otwarte taski; nadmiar WIP.
3. **Roadmap refresh.** Now/Next/Later: co przesunąć, co domknąć (`roadmapping` §2, §10). Aktualizacja Initiatives.
4. **Retro (GLM-5.2, krótko).** Co poszło dobrze / źle / co zaskoczyło / 1–3 action items (`review` §4). Blameless.
5. **Digest (DeepSeek V4 Pro, PL).** Komentarz/notatka: top priorytety na tydzień, blockery, decyzje do podjęcia, link do widoków. @Mateusz.
6. **(Opcjonalnie) outcome/throughput.** Po ~50 taskach: prosty throughput-based forecast „80% do daty X" (`estimation` §2.5).

## Metadane Linear (czyta, prawie nie pisze)
Czyta: statusy, labelki (`needs/escalated/over-budget/risk`), Estimate, Initiative, relations, daty.
Pisze: digest (komentarz/notatka), ewentualne re-priorytety / aktualizacja Initiative (po akceptacji).

## Safeguards
- **Read-mostly** — nie zmienia scope bez Mateusza (zmiany priorytetów = propozycja w digeście).
- Lekko: 1 digest/tydzień, nie codzienny spam (`cognitive_load` §7 async-first).

## Output
Tygodniowy **digest** (PL) + odświeżony Now/Next/Later + lista action items. Nowy input → może trafić do PLAN.

## Czego NIE robi (na teraz)
Formalne OKR/RICE/Monte-Carlo, portfolio review — dodamy przy skali (`design-review` §5).
