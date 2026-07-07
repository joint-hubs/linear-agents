---
type: design-doc
status: spec-v1 (warstwy 1–2 zbudowane 2026-07-05; warstwa 3 = ten spec)
audience: Mateusz (review) → PLAN squad (dekompozycja jako Draft w Linear)
topic: FlowDB learning loop — historyczne odpowiedzi kroków jako pamięć doświadczenia dla agentów
related: ../../scripts/flow-db.mjs (warstwa 1–2), ../../ui/README.md (ekran Flow), ../FENIX_WORKFLOW.md, ROADMAP.md
---

# FlowDB Learning Loop (warstwa 3)

> Warstwy 1–2 są ZBUDOWANE: `scripts/flow-db.mjs` (SQLite w `.state/flowdb/flow.db`,
> node:sqlite, Node ≥ 22.5) persystuje każdą odpowiedź modelu per krok pipeline'u
> (run × subagent × tura) i odpowiada na pytania procesowe: `trace <taskId>`
> (pełny łańcuch PLAN→DEV→REVIEW→TEST + bounce'y REVIEW→DEV), `patterns`
> (powtórzenia kroków, odbicia per task, fail-rate per squad), `search` (przeszukiwanie
> historycznych odpowiedzi). Endpointy: `/api/flow/trace`, `/api/flow/patterns`.
> Ingest: `node scripts/flow-db.mjs ingest` (idempotentny; wpiąć w koniec każdego
> runa launchera LUB w tygodniowy CADENCE).

Warstwa 3 = wykorzystanie tej bazy tak, żeby **agent na danym kroku był mądrzejszy,
bo krok był już kiedyś wykonywany**.

## 1. Experience packets (retrieval przy kickoffie kroku)

Mechanizm: squad-lead (lub subagent) przed rozpoczęciem kroku woła:

```
node $LA_ROOT/scripts/flow-db.mjs experience --squad dev --agent implementer \
  --task JOI-99 --context "CORS, origin validation, api server" --k 3 --json
```

Zwraca pakiet (limit ~2–4k tokenów, twardy budżet):
1. **Podobne przypadki** — top-k historycznych odpowiedzi tego kroku (ranking:
   BM25-lite po tekście, zero-dep; boost dla tego samego repo/projektu i świeżości).
2. **Znane pułapki** — odpowiedzi first-pass/deep review, które ODESŁAŁY taski
   o podobnym kontekście (join: bounce w `trace` + tekst review z odbitych rund).
3. **Priors kroku** — z `patterns`: średnia liczba tur, śr. koszt, częstość powtórek
   (kalibracja: „ten typ zadania zwykle wraca 1×, sprawdź walidację wejść").

Integracja: sekcja w `agents/<squad>/CLAUDE.md` („Przed implement(): pobierz
experience packet i potraktuj jako kontekst doradczy, nie rozkaz") + wpis w
recon/context-packet DEV-a. Zero nowych zależności — to komenda CLI + prompt.

## 2. Destylacja lekcji (CADENCE)

Co tydzień CADENCE (retro, GLM-5.2) robi przebieg po nowych wierszach FlowDB:
- klastruje przyczyny odbić review (Conventional Comments) i failów TEST,
- generuje/aktualizuje `agents/<squad>/memory/<role>.md` — max ~40 linii
  skondensowanych reguł („w tym repo CORS zawsze whitelist, nie wildcard"),
- plik jest wczytywany przez subagenta przy starcie (dopisek w jego .md).

Różnica vs experience packets: packets = surowe przypadki on-demand;
memory = trwałe, ludzko-czytelne reguły, wersjonowane w gicie (audytowalne, tanie).

## 3. Feature log → predyktor odbić (później, po ~50 taskach)

Przy każdym `deliver_task()` DEV-a logować cechy do tabeli `features`:
estymata, typ, liczba plików, liczba tur implementera, koszt, czy spec miał ADR,
liczba pytań needs:answer. Target: `bounced ∈ {0,1}` (z heurystyki trace).
Model: regresja logistyczna liczona skryptem zero-dep (to 30 linii JS) —
wynik: „ryzyko odbicia 0.72 → risk:high + głębszy deep-pass PRZED wysłaniem
do review". Nie trenujemy LLM-a; uczymy się na metadanych procesu.

## 4. Guardrails

- **Prywatność**: FlowDB zostaje lokalna (`.state/` jest gitignored); packets
  nie zawierają sekretów — filtr na wzorce kluczy przed insertem (TODO ingest).
- **Świeżość**: decay wagi wyników > 90 dni; `--since` w experience.
- **Budżet**: packet ≤ 4k tokenów; experience wywoływane 1× per krok (nie per tura).
- **Nie-samowzmocnienie**: memory/*.md przechodzi przez review Mateusza (PR),
  żeby zła lekcja nie utrwaliła się automatycznie.

## 5. Fazowanie (propozycja tasków dla PLAN)

| # | Task | Zakres | Est. |
|---|---|---|---|
| 1 | `flow-db experience` (CLI + BM25-lite + testy) | pkt 1 bez integracji promptów | M |
| 2 | Integracja packets w CLAUDE.md (dev → reszta) | pkt 1 integracja + pomiar kosztu | S |
| 3 | CADENCE distillation → agents/*/memory/ | pkt 2 | M |
| 4 | Feature log w deliver_task() | pkt 3 (sam zapis) | S |
| 5 | Bounce predictor + risk:high hook | pkt 3 (model) — po ~50 taskach | M |
| 6 | UI: zakładka trace/patterns w ekranie Flow | wizualizacja warstwy 2 | S |

Kolejność 1→2 daje najszybszy zwrot; 3 wymaga tylko CADENCE; 4–5 czekają na dane.
