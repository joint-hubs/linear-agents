---
type: analysis
status: review
audience: Mateusz (decyzje) → PLAN squad (dekompozycja)
tags: [type/analysis, area/agents, topic/squads, topic/handoff, topic/delegation]
created: 2026-07-27
data: agents/*/CLAUDE.md + agents/*/agents/*.md + settings.json, config/handoff-rules.json, .state/review-rounds.json, docs/decisions/cost-optimization.md (v2.1)
---

# Review składów (5 squadów) — stan na 2026-07-27

Kontekst: po falach F0 (Bash dla subagentów) i F1 (phase-delegation) squady są znacznie
spójniejsze niż w czerwcu. Ten review patrzy na to, co ZOSTAŁO — asymetrie między squadami,
drift między źródłami prawdy i luki w handoffach.

## Co działa (i warto pokazać)

1. **Jednolita polityka delegacji.** Wszystkie 5 leadów ma sekcję „Polityka delegacji (koszty) — P0"
   z tym samym mierzalnym celem (≥40% kosztu runa u subagentów) i tą samą regułą stopu
   („>30 linii analizy → STOP, deleguj"). To rzadkość — zwykle takie zasady rozjeżdżają się per plik.
2. **F0 był prawdziwą przyczyną, nie polityką.** Diagnoza „żaden wykonawczy subagent nie miał Bash"
   tłumaczy 93% kosztu na leadach lepiej niż „leady się nie słuchają". Naprawa mechaniczna
   (grant + phase-delegation) > naprawa promptowa.
3. **Handoff jest danymi, nie czatem.** `config/handoff-rules.json` to 4 reguły, które czytają
   statusy+labelki i zwracają następny squad. Ta sama tabela steruje dashboardem (`suggestedSquad`,
   przycisk launch) i człowiekiem. Jedno źródło prawdy dla maszyny i dla operatora.
4. **Bezpieczeństwo egzekwowane mechanicznie.** `deny` w settings.json (git push, rm -rf, Edit dla
   review/cadence) wiąże też subagentów — polityka nie zależy od tego, czy model ją przeczytał.
5. **Telemetria v2** trzyma tożsamość runa w centralnym SQLite zamiast zgadywać po oknie czasowym —
   to warunek wstępny dla jakiejkolwiek analizy patternów.

## Findings

### 🔴 F-1. TEST to najsłabsze ogniwo — a jest ostatnią milą

| Squad | Linie CLAUDE.md | Ponumerowany pipeline z komendami | „Linear tools (MANDATORY)" | Dry-run | `deny mcp__linear__*` |
|---|---|---|---|---|---|
| dev | 148 | ✅ (6 kroków) | ✅ | ✅ | ✅ |
| review | 131 | ✅ (6 kroków) | ✅ | ✅ | ✅ |
| plan | 116 | ✅ (pętla + bramki) | ⚠️ tylko wzmianka | ✅ | ❌ |
| cadence | 113 | ✅ | ✅ | — | ✅ |
| **test** | **53** | ❌ (jednoakapitowa „Pętla") | ❌ **brak** | ❌ **brak** | ❌ |

Konsekwencje: TEST nie ma komendy „jak znaleźć task `stage:testing`", nie ma jawnego
`linear-ops transition --status Done`, nie ma trybu dry-run (więc nie da się go bezpiecznie
zademonstrować) i jako jedyny nie ma ani mandatu „tylko przez skrypty", ani mechanicznego
`deny mcp__linear__*` — czyli może pójść w MCP, który headless nie działa. W danych kosztowych
delegacja TEST = **0%**. Rekomendacja: przepisać `agents/test/CLAUDE.md` wg szablonu dev/review
(pick → deploy → scenariusze → run → werdykt → dry-run), dodać deny.

### 🟠 F-2. Trzy źródła prawdy o tym, skąd DEV bierze task

- `agents/dev/CLAUDE.md` §1: `linear-query issues --status Backlog --label dor-ok`
- `config/handoff-rules.json`: `{ state: "Todo", labels: ["dor-ok"] } → dev`
- `docs/FENIX_WORKFLOW.md` §2.1: statusy to `Todo → In Progress → In Review → Done`

Jeżeli w Linearze „Backlog" i „Todo" to dwa różne stany, dashboard zaproponuje DEV-a dla tasków,
których DEV sam nigdy nie wybierze (i odwrotnie). To cichy rozjazd — nie wywala błędu, tylko
sprawia, że kolejka wygląda inaczej w UI niż w agencie. Rekomendacja: jeden stan wejściowy,
podmieniony we wszystkich trzech miejscach + test w `check.mjs` (linter już istnieje).

### 🟠 F-3. Escalacje nie są rzadkie — a nie ma dla nich procesu

`.state/review-rounds.json` (licznik rund dev↔review, limit 2):

```
JOI-53: 3   JOI-173: 3   FOC-48: 3     ← przekroczony limit → escalated
JOI-174: 2  JOI-175: 2   task-a/b: 2   ← na granicy
FOC-23: 1   FOC-29: 1    FOC-41: 1
```

3 z 10 tasków wyczerpały limit rund, kolejne 4 siedziały na granicy. Czyli **~30% tasków
kończy się eskalacją do Ciebie** — to nie jest awaria, to normalny tryb pracy systemu, ale
nigdzie nie jest tak opisany: nie ma widoku „escalated" w dashboardzie ani reguły w
`handoff-rules.json` (`escalated → human`). Rekomendacja: dodać regułę + filtr w UI; przy okazji
to najlepszy kandydat na pierwszą regułę uczącą (patrz `docs/plans/flowdb-learning-loop.md`).

### 🟡 F-4. WIP=1 i resume ma tylko DEV

DEV ma `.state/dev-wip.json` + „Resume check" jako krok 0. REVIEW/TEST/PLAN nie mają nic —
przerwany run REVIEW zaczyna od nowa od `pick`, co przy 3 równoległych passach kosztuje.
Rekomendacja: wynieść resume do wspólnego helpera (`scripts/wip.mjs`) i wpiąć w 4 squady.

### 🟡 F-5. Dwie bazy telemetrii żyją równolegle

`/api/flow/trace|patterns` czyta centralny store (v2), a `scripts/flow-db.mjs` został jako
fallback — ale **nic go nie woła** (`ingest` trzeba odpalić ręcznie), więc ścieżka fallback
jest w praktyce martwa i myląca. Rekomendacja: albo wpiąć `flow-db ingest` w CADENCE jako
kopię zapasową, albo usunąć fallback i zostawić jedno źródło.

### 🟡 F-6. Komentarze do Lineara: dobra dyscyplina, brak kontraktu

`publish-linear-comment.mjs` (tagi `run:<squad>-<what>:<id>`, tiery T1/T2/T3, dedup po markerze)
jest wołany przez dev/review/test — ale format „co musi znaleźć się w handoffie" żyje w prozie
każdego CLAUDE.md osobno. REVIEW parsuje branch DEV-a **regexem z komentarza**
(`/Branch:\s*.../i`) — to najkruchsze miejsce całego pipeline'u: literówka w komentarzu DEV-a
kończy się review „description-only". Rekomendacja: handoff jako **strukturalny blok**
(np. `<!--fenix:handoff {"branch":"...","commit":"...","files":n}-->`) — parsowanie zamiast zgadywania.

## Priorytety

1. **F-1** (TEST do standardu dev/review) — bez tego ostatnia mila jest niedeterministyczna.
2. **F-2** (jeden stan wejściowy) — 20 minut roboty, kończy klasę cichych rozjazdów.
3. **F-6** (strukturalny handoff) — usuwa najkruchszy element (regex na komentarzu).
4. F-3 → reguła `escalated → human` + widok; F-4 → wspólny resume; F-5 → decyzja o fallbacku.
