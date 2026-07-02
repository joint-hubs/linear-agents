# PLAN — JOI-52 Home Finances: Panel analityczny (dekompozycja)

## Context

JOI-52 ("Home Finances", team JOI, obecnie In Progress) wskazuje na PRD
`home/docs/PRD-panel-analityczny.md`. Cel: lokalny, **offline'owy panel HTML**
(`home/panel/`) do porównywania okresów finansowych — ciągła oś 2024-01→dziś
(dwa eksporty ING zmergowane), porównanie A vs B, limity per kategoria, heatmapa
dni tygodnia i raport tekstowy. Transfery wewnętrzne wykluczone z wydatków i
przychodów. Domyślna grupa kont: **Dom**.

**Ten cykl PLAN NIE pisze kodu** — dekomponuje PRD na vertical slices z AC/DoD/
estimate i (po akceptacji) tworzy je jako **children JOI-52** w Linear (team JOI,
status Todo, label `dor-ok`). Bez tworzenia nowego epica.

### Ustalenia z reconu (stan faktyczny vs PRD)

- **`panel/build_master.py` JUŻ ISTNIEJE i jest solidny** (245 linii): master +
  kategoryzacja starych danych + detekcja transferów + reguła Revolut + overrides
  + sanity report. To zmienia Fazę 1 PRD z "budowy od zera" w **fix + weryfikację**.
- **BUG blokujący**: w `OLD_SOURCES` ścieżka personal to `..._0233176520_...`,
  realny plik to `..._0233176771_...` → `load_old()` rzuca `FileNotFoundError` na
  starcie. Jednoznakowa poprawka.
- Moduły do reużycia (import, nie kopiowanie) istnieją i mają czyste kontrakty:
  `analiza_20260701/{parse,accounts,pair,categorize}.py`.
  - `parse.read_ing_csv(path) -> list[dict]`, `categorize.categorize(rec) -> str`,
    `accounts.detect_self_account/looks_like_internal`, `pair.dedupe/pair_internal_transfers`.
- Wszystkie 4 źródła danych realnie istnieją: dom stare (`analiza_20260305/…050326.csv`,
  299 w.), osobiste stare (`personal/20260310/…6771…`, 2705 w.), firma stare
  (`jointhubs/finances/20260310/`, 595 w.), nowe okno `analiza_20260701/merged/*.csv`
  (~526 tx).
- **Brak** lokalnej `plotly.min.js`, `aggregate.py`, `render.py`, `template.html`,
  `overrides.csv`, `data.json`, `master.csv` — do stworzenia.
- **Źródło prawdy do sanity-check** (AC subtaska 1/8): `analiza_20260701/comparison_summary.md`
  (per konto, per miesiąc bez transferów, top kategorie) + `monthly_pnl.csv`.
- **Pułapki**: `is_internal_transfer` przełącza się str↔bool między CSV a `categorize()`;
  `pair_internal_transfers` mutuje wejście; zduplikowana kolumna `category` w
  `merged_firma.csv` (panel liczy kategorię w locie, nie ufa kolumnie w CSV).

## Decyzje planistyczne (best-judgment — pytania GATE 1 bez odpowiedzi)

- **Granularność**: 8 vertical slices (1 slice ≈ 1 zakładka/warstwa danych) —
  najlepsze do równoległej pracy i śledzenia postępu.
- **Offline Plotly**: pobrać `plotly.min.js` raz z CDN do `panel/`, template linkuje
  lokalnie (zgodne z literą PRD: "jeden plik + lokalny plotly.min.js"). Część
  subtaska render (S3).
- **Fix personal 6520→6771**: część subtaska S1 (fix+test), nie osobny mikro-task.

*(Jeśli Mateusz zdecyduje inaczej — mniej/więcej tasków, inline plotly — korekta
przed pushem.)*

## Dekompozycja — 8 children JOI-52

Kolejność = łańcuch `blocked by`. Estimate t-shirt. Typy: feat/fix/test/docs.
Parent = kontekst (JOI-52 + PRD). Subtask = delta + link do PRD.

| # | Slice | Typ | Est | Blocked by |
|---|-------|-----|-----|-----------|
| S1 | Master dataset działa + sanity | fix | S | — |
| S2 | Agregaty → data.json | feat | M | S1 |
| S3 | Render pipeline + zakładka Przegląd (offline plotly) | feat | L | S2 |
| S4 | Zakładka Porównanie A vs B (presety, delty, werdykt) | feat | L | S3 |
| S5 | Zakładka Limity (mediana+10%, status, trend) | feat | M | S3 |
| S6 | Zakładka Dni tygodnia (heatmapa A\|B) | feat | M | S3 |
| S7 | Zakładka Raport + Revolut/overrides | feat | M | S4 |
| S8 | Weryfikacja end-to-end + README panelu | docs | S | S5,S6,S7 |

### Sample subtaski z AC (reprezentatywne — GATE 2)

**S1 — [fix] Master dataset: napraw ścieżkę personal + sanity-check sum**
- Delta: napraw nazwę pliku personal w `OLD_SOURCES` (`6520`→`6771`), uruchom
  `build_master.py`, zweryfikuj sumy vs `comparison_summary.md`, wypisz raport
  niesparowanych transferów.
- AC:
  - Given poprawiona ścieżka personal, When `python build_master.py`, Then kończy
    bez błędu i tworzy `panel/master.csv` z rekordami 2024-01→2026-07.
  - Given wygenerowany master, When porównam sumy miesięczne dom+osobiste
    2026-03..2026-06 z `comparison_summary.md`, Then zgadzają się (± zaokrąglenia).
  - Given detekcja transferów, When build się kończy, Then niesparowane transfery
    wewnętrzne są raportowane osobno (liczba na stdout).
- DoD: skrypt idempotentny; sanity-check w kodzie/logu; brak regresji formatu master.csv.

**S3 — [feat] Render pipeline + zakładka Przegląd (offline)**
- Delta: `render.py` (skleja `template.html` + `data.json` → `panel.html`),
  `template.html` (layout, 5 zakładek — na tym etapie działa Przegląd), lokalna
  `plotly.min.js`, górny selektor grupy kont (domyślnie Dom). Reużyć wzorzec
  Plotly z `analiza_combined.py`.
- AC:
  - Given `data.json`, When `python build.py` (lub `render.py`), Then powstaje
    `panel.html` otwierany z `file://` bez internetu (bez CDN).
  - Given otwarty panel, When zakładka Przegląd, Then widać ciągłą oś
    2024-01→dziś: przychody/wydatki/netto + kategorie, z adnotacją okien
    dostępności danych (dom od 2025-08 itd.).
  - Given selektor grupy kont, When wybiorę Dom/Osobiste/Dom+Osobiste/Firma+Podatki,
    Then wykresy przeliczają się po stronie JS bez regeneracji.
- DoD: panel offline; brak odwołań do CDN; plotly.min.js w repo.

**S4 — [feat] Zakładka Porównanie A vs B**
- Delta: dwa selektory okresów (presety: stary eksport / nowy / kwartały /
  ostatnie 3 mies. / dowolny zakres miesięcy), wykresy w siatce 2-kol (A|B),
  tabela delt per kategoria (PLN/mies. i %), werdykt "w dobrą stronę / uwaga".
- AC:
  - Given preset "Q1 2026 vs Q2 2026", When wybiorę go, Then panel pokazuje delty
    per kategoria posortowane i werdykt lepiej/gorzej.
  - Given dowolny zakres od–do miesiąc dla A i B, When zatwierdzę, Then wykresy A|B
    i tabela delt aktualizują się bez przeładowania danych.
- DoD: presety działają; delty liczone z agregatów JSON; działa offline.

*(S2, S5, S6, S7, S8 — analogiczna struktura AC/DoD; pełne AC generuje decomposer
przed pushem. AC źródłowe = sekcja "Kryteria akceptacji" PRD, rozdzielone per slice.)*

## Critical files

- `home/panel/build_master.py` — fix + weryfikacja (S1).
- `home/panel/{aggregate.py,render.py,template.html,plotly.min.js,overrides.csv}` — nowe (S2–S7).
- `home/panel/build.py` — orkiestracja (master→agregaty→render), nowy.
- Reużycie (import): `home/analiza_20260701/{parse,accounts,pair,categorize}.py`.
- Sanity source: `home/analiza_20260701/comparison_summary.md`, `monthly_pnl.csv`.
- PRD: `home/docs/PRD-panel-analityczny.md`.

## Verification (dla wykonawcy — nie ten cykl)

- Delivery-loop (CLAUDE.md #2): po każdej zmianie kodu uruchom `python build.py`,
  otwórz `panel.html` z `file://`, sprawdź zakładki i dane.
- Ostateczny gate = AC PRD (7 pozycji) + sanity vs `comparison_summary.md`.

## Push do Linear (po akceptacji ExitPlanMode = GATE 2)

- Delegacja: subagent `decomposer` (pełne AC/DoD per slice) → `push` (idempotentny).
- Target: **children JOI-52** (team JOI), status **Todo**, label **`dor-ok`** +
  `ai:planned`, type per subtask, estimate t-shirt, relacje `blocked by` wg tabeli.
- **Bez tworzenia nowego epica** — JOI-52 jest parentem.
- Przed pushem: BRIEF na JOI-52 przez `publish-linear-comment.mjs`
  (`--tag run:plan-brief:JOI-52`).
