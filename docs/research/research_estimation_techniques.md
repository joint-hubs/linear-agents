---
type: research-note
status: active
tags: [type/research, area/methodology, topic/planning, topic/estimation, topic/agile, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
related: [research_software_project_planning_best_practices.md, research_software_delivery_review_best_practices.md, research_task_decomposition_invest_spidr_vertical_slicing.md]
---

# Estymacja w planowaniu software — deep research

> Pierwsza z trzech notatek szczegółowych do
> [[research_software_project_planning_best_practices.md]]. Ta odpowiada na
> pytanie **"ile to zajmie i skąd to wiemy"** — od najprostszych technik (t-shirt)
> przez story points i planning poker, po #NoEstimates, Monte Carlo i focus factor.
>
> Źródła: Mike Cohn (Agile Estimating and Planning, Mountain Goat Software),
> Woody Zuill (#NoEstimates), Dimitar Bakardzhiev (Monte Carlo for software),
> Barry Boehm (focus factor baseline), Daniel Vacanti / Actionable Agile
> (throughput-based forecasting), J. Sutherland (Scrum Guide 2020),
> Ryan Singer (Shape Up), Kent Beck (estimate vs commitment), State of Agile
> (Digital.ai 2024-2025), Focus Factor Survey 2022, Troy Magennis (flow metrics).

---

## TL;DR

1. **Estymacja to nie predykcja.** Żadna technika nie daje dokładnej daty. Najlepsze co mamy to **rozkład prawdopodobieństwa** ("80% szans na Q3, ±6 tygodni").
2. **Trzy legalne cele estymacji:** komunikacja zespołowa, triaging, bid/buy. Dwa anty-cele: predykcja daty z dokładnością ±10%, performance review developera.
3. **Pięć dominujących technik:** story points (Fibonacci), t-shirt sizes, planning poker, #NoEstimates, Monte Carlo. Każda pasuje do innego kontekstu (skala, dojrzałość, kultura).
4. **Velocity ≠ productivity.** Velocity to narzędzie capacity planning, nie KPI. Porównywanie velocity zespołów to klasyczny błąd (różny scope mix, różne DoD).
5. **Focus factor 60-70% to norma.** Planuj według dostępnej pojemności (`team_size × hours × 0.65`), nie headcount × 100%.
6. **2026 trend: throughput > velocity.** Throughput (ile tasków/tydzień) jest bardziej uczciwy niż velocity, bo nie zależy od scope-mix i DoD. Forecast = throughput × remaining work (probabilistycznie).
7. **Capacity buffer = 30%.** Nigdy nie commituj > 70% capacity. Bufor na: scope clarification, code review rework, on-call incidents, discovery overflow.
8. **Estymacja AI-generowanego kodu ma inny rozkład.** Codegen może być 2-5x szybszy na zadaniach znanych, ale 0x szybszy na zadaniach wymagających decyzji projektowej. Rozkład prawdopodobieństwa jest bardziej skośny.

---

## 1. Po co estymujemy (a po co nie)

### 1.1 Trzy legalne cele

| Cel | Przykład | Metryka sukcesu |
|-----|---------|-----------------|
| **Komunikacja zespołowa** | "Task A jest 2x większy niż task B" | Zespół zgadza się na relatywne porównanie |
| **Triaging** | "Czy to jest 1 sprint czy kwartał?" | Scope łatwo bucketuje się w S/M/L/XL |
| **Decyzja bid/buy** | "Czy budujemy czy kupujemy?" | Order-of-magnitude estymata wystarczy |

### 1.2 Dwa nie-legalne (ale częste) cele

| Cel | Dlaczego nie-legalny | Skutek uboczny |
|-----|----------------------|----------------|
| **Predykcja daty ±10%** | Historyczny rozrzut estymat to 2-3x (Cohn, Vacanti) | Fałszywa precyzja → utrata zaufania, gdy data nie wchodzi |
| **Performance review** | Estymaty są zbyt zależne od scope, definicji done, luck | Ludzie zaniżają estymaty → chronic overcommitment |

### 1.3 Prawdziwy koszt błędnej estymacji

Cohn i inni (2010-2024) wielokrotnie pokazali:

- **Niedoszacowanie 20-30% jest typowe.** Ale **planowanie pod niedoszacowanie = chronic overflow + team burnout**.
- **Nadmierna precyzja = anti-pattern.** "2.5 sprint days" brzmi precyzyjnie, ale jest mniej wartościowe niż "małe, 1 dzień".
- **Najgorszy scenariusz:** nie zła estymata, tylko **brak aktualizacji estymaty w miarę uczenia się**.

**Złota zasada:** estymata to hipoteza, nie kontrakt. Aktualizuj ją co tydzień w oparciu o nowe dane.

---

## 2. Pięć technik estymacji — deep dive

### 2.1 Story Points (Fibonacci)

**Mechanizm:** zespół szacuje relatywnie w skali Fibonacciego (1, 2, 3, 5, 8, 13, 21, ?). Velocity = suma story points zamkniętych w sprincie.

**Zasady kanoniczne (Cohn):**
- **Relatywne, nie absolutne.** "Task A jest 2x większy niż task B" — nie "task A = 5 dni".
- **Fibonacci, nie liniowe.** Rozdzielczość (1,2,3,5,8,13,?) zmusza do dyskusji, gdy jest niepewność.
- **Nie sumuj, uśredniaj.** Story points nie są addytywne (klasyczny błąd: "5+5+8 = 18").
- **Nie konwertuj na dni.** "Story point = 1 idealny dzień" to pułapka (Velocity ≠ effort w dniach).

**Velocity — co NAPRAWDĘ mierzy:**

| Mierzy | Nie mierzy |
|--------|------------|
| Capacity zespołu (ile zmieścimy w sprincie) | Wysiłek poszczególnych ludzi |
| Trend (rośnie / spada / stabilny) | Wartość biznesowa |
| Stabilność (niskie odchylenie = przewidywalność) | Jakość kodu |

**Anty-patterny:**
- Velocity jako KPI zespołu → "team A ma 45, team B ma 30, A jest lepszy" = bzdura (różny scope mix).
- Velocity do porównań między zespołami → nigdy nie rób tego (różne DoD, różne kryteria).
- Velocity do ustalania dat delivery → używaj do capacity, daty z Monte Carlo / throughput.

### 2.2 T-shirt Sizes (S/M/L/XL)

**Mechanizm:** zamiast precyzyjnych punktów, buckets:
- **S** = ≤ 1 dzień (1 developer)
- **M** = 1-3 dni (potencjalnie 2 osoby, ale 1-2 dni kalendarzowe)
- **L** = 1-2 tygodnie (1-2 osoby, krytyczny path)
- **XL** = > 2 tygodni (ZA DUŻY, rozbij przed estymacją)

**Kiedy pasuje:**
- Discovery, wstępny triage, cross-team alignment
- Pre-Shape Up appetite setting ("chcemy wydać na to 2 tygodnie")
- Szybkie planowanie, gdy nie ma czasu na pełny planning poker
- Pre-sale / szacowanie oferty (gdy klient pyta "ile to będzie kosztować")

**Kiedy nie pasuje:**
- Gdy potrzebujesz velocity do capacity planning (t-shirt nie daje liczb)
- Gdy zespół chce porównywać się do historycznych danych (t-shirt nie ma ciągłości)
- Gdy stakeholder potrzebuje bardziej precyzyjnej estymaty niż "L" (choć często "L" jest wystarczające)

**Zasady kanoniczne:**
- **Nigdy nie zostawiaj XL.** Każdy task XL musi być rozbity przed wejściem do sprintu.
- **Kalibruj regularnie.** Zespół musi kalibrować "co znaczy S dla nas" — inaczej dryfuje.
- **T-shirt + relative ordering** = dobry pattern: "to jest S albo M, ale na pewno mniejsze niż tamto L".

### 2.3 Planning Poker

**Mechanizm:** zespół gra kartami (z Fibonacci). Wszyscy pokazują jednocześnie. Rozbieżności → dyskusja, ponowna runda.

**Kanoniczny proces (Cohn / Mountain Goat Software):**
1. PM/product owner czyta user story.
2. Zespół dyskutuje pytania, kryteria, scope.
3. Każdy wybiera kartę.
4. Wszyscy pokazują jednocześnie.
5. **Wysoki / niski wyjaśniają swoje rozumowanie** (to jest klucz — uczenie się).
6. Ponowna runda.
7. Consensus lub średnia (ale consensus preferowany).

**Kiedy pasuje:**
- Rozproszone wiedzą zespoły (senior + junior + tester)
- Backlog refinement (grooming)
- Gdy potrzebujesz alignment przed sprint planning

**Kiedy nie pasuje:**
- Codziennie (za ciężkie)
- > 20 osób (niemożliwe do moderowania)
- Rozproszone strefy czasowe (zbyt kosztowne spotkanie)
- Discovery / wczesne szacowanie (za dużo niewiadomych, lepsze t-shirt)

**Anty-patterny:**
- **Planning poker bez wyjaśnień** = zgadywanki zamiast learningu.
- **Planning poker z boss pressure** = "musimy mieć niższe estymaty" → fałszywe consensus.
- **Planning poker dla wszystkiego** = overhead. Tygodniowo max, dla pre-selected stories.

### 2.4 #NoEstimates (Woody Zuill)

**Mechanizm:** zamiast estymować każdy task, bucketuj na Small/Medium/Big/Large i mierz **cycle time** historyczny.

**Kanoniczna propozycja (Zuill, 2014-2024):**
- **Nie estymuj** (nie pytaj "ile to zajmie").
- **Bucketuj** na 4 rozmiary (S/M/B/L).
- **Mierz cycle time** każdego rozmiaru (percentyle: 50%, 85%, 95%).
- **Limit WIP** (Work In Progress) — max 2-3 taski na developera.
- **Forecast = cycle time × remaining tasks**.

**Kiedy pasuje:**
- Discovery-heavy, high-variance (nie wiesz co dokładnie budujesz)
- Continuous flow (support, ops, content)
- Zespół doświadczony (potrafi sam priorytetyzować bez PM-owej estymaty)
- Gdy velocity-based forecasting jest zbyt kruchy

**Kiedy nie pasuje:**
- Gdy commitment do daty jest krytyczny (board commitment, customer deadline)
- Gdy scope się drastycznie zmienia co sprint
- Gdy zespół jest juniorski (potrzebuje guidance estymat)

**Kluczowy insight Zuill:** estymata jest **ekonomicznym wyborem**, nie techniczną koniecznością.
Jeśli koszt estymacji (czas PM + zespół) > jej wartość (lepsze decyzje), to nie warto estymować.

### 2.5 Monte Carlo Forecasting

**Mechanizm:** symulacja daty delivery z rozkładu historycznego (cycle time × remaining work, symulowane 10,000 razy).

**Algorytm (Bakardzhiev / Vacanti):**
1. Zbierz historyczne cycle times (z 6-10+ poprzednich sprintów/iteracji).
2. Dla każdego taska w remaining backlog, wylosuj z rozkładu historycznego.
3. Sumuj do osiągnięcia remaining scope.
4. Powtórz 10,000 razy.
5. Wynik: rozkład dat ("80% prawdopodobieństwa delivery do daty X").

**Kiedy pasuje:**
- Forecasting dla boardu / stakeholderów / klienta
- Decyzja bid/buy z commitment
- Gdy masz wystarczającą historię (min. 50-100 tasków)

**Kiedy nie pasuje:**
- Bez historii (cold start) → wróć do t-shirt
- Scope drastycznie inny niż historia → prognozy bezwartościowe
- Pojedynczy task (to nie jest forecasting, to estymata)

**Narzędzia:** Actionable Agile Metrics (Vacanti), Throughput Forecast (custom), Linear Insights, Jellyfish.

**Przykład output:** "Dla 47 remaining tasków: 50% szans na delivery do 2026-08-15, 80% do 2026-09-12, 95% do 2026-10-05."

### 2.6 Porównanie technik

| Technika | Precyzja | Koszt | Kiedy używać |
|----------|----------|-------|--------------|
| Story points | Średnia (relatywna) | Średni (planning poker co tydzień) | Scrum, dojrzały zespół, commitment |
| T-shirt sizes | Niska (4 buckets) | Niski (5 min / task) | Discovery, triage, pre-sale |
| Planning poker | Średnia-wysoka | Wysoki (sesja 1-2h) | Backlog refinement, cross-functional |
| #NoEstimates | Niska (4 buckets) | Niski (zero planning ceremony) | Continuous flow, support, ops |
| Monte Carlo | Wysoka (rozkład) | Niski (po zebraniu historii) | Forecasting dat, board reporting |

---

## 3. Capacity planning — focus factor i WIP

### 3.1 Skąd się bierze focus factor

Barry Boehm (1987, Software Engineering Economics) — pierwotna obserwacja:
programiści spędzają ~60% czasu na development, ~40% na admin / spotkania / overhead.

Nowsze dane (Cohn 2009, Focus Factor Survey 2022, State of Agile 2024):

| Składnik | Typowy udział | Uwagi |
|----------|---------------|-------|
| Kodowanie (deep work) | 30-40% | Różnica: seniorzy vs juniorzy (~45% vs ~25%) |
| Code review | 10-15% | Rośnie z code review culture |
| Spotkania (sync + async) | 15-25% | Distributed teams +10% |
| Operacje (incident, support, on-call) | 5-15% | Rośnie w erze "you build it you run it" |
| Admin / overhead | 5-10% | Narzędzia, dokumentacja, statusy |
| Nauka / improvement | 5-10% | Spada w crunch time |
| **Effective focus factor** | **60-70%** | Stabilna norma dla produktywnego developera |

### 3.2 Wzór na capacity

```
Team capacity (h/sprint) = team_size × sprint_hours × focus_factor
Sprint hours = dni_pracy × 6h  (nie 8h — 2h na overhead dziennie)
Focus factor = 0.60-0.70
```

**Przykład:** zespół 5 osób, sprint 10 dni roboczych, focus factor 0.65:

```
= 5 × (10 × 6) × 0.65
= 5 × 60 × 0.65
= 195 h/sprint   (nie 300 h, nie 400 h)
```

**Reguła praktyczna:** jeśli planujesz `team × 8h × dni` bez focus factor, planujesz 30-40% zawyżone.

### 3.3 Kiedy focus factor spada (czerwone flagi)

| Sygnał | Może oznaczać |
|--------|---------------|
| Focus factor < 50% | Zbyt wiele spotkań, nadmierny context switching |
| Focus factor > 80% | Nadchodzi burnout w 2-3 kwartałach |
| Focus factor niestabilny (30-80% w sprincie) | Nieprzewidywalny on-call, brak spokoju |
| Focus factor per osoba > 30 pkt proc. różnicy | Różne role (lead vs IC) — to normalne, ale kalibruj |

### 3.4 WIP limits (Kanban)

**WIP limit** = max liczba tasków jednocześnie w "doing" przez zespół (lub osobę).

Dlaczego WIP limit > throughput > velocity?

- **WIP limit wymusza focus** — mniej context switching, wyższa jakość.
- **Throughput rośnie** bo ludzie faktycznie kończą zamiast przełączać się.
- **Cycle time spada** bo mniej zatorów.

Kanban rule of thumb:
- **WIP per osoba** = 1.5-2 (nie więcej niż 2 taski jednocześnie)
- **WIP per zespół** = team_size × 1.5
- **WIP limit musi być bolesny** — jeśli nigdy nie wkurza, jest za wysoki.

---

## 4. Velocity vs Throughput vs Cycle Time

### 4.1 Definicje

| Metryka | Co mierzy | Kiedy używać |
|---------|-----------|--------------|
| **Velocity** | Ile story points zamkniętych w sprincie | Capacity planning, sprint planning |
| **Throughput** | Ile tasków zamkniętych w tygodniu/sprincie | Forecasting, throughput-based predictions |
| **Cycle time** | Czas od "start" do "done" jednego taska | Diagnostyka flow, identyfikacja zatorów |
| **Lead time** | Czas od "utworzony" do "done" | Customer-facing SLA |

### 4.2 Dlaczego throughput > velocity (2024-2026 trend)

Vacanti i inni (2020-2024) argumentują, że throughput ma 3 przewagi:

1. **Niezależny od scope-mix.** Story point "5" dla jednego taska to inny effort niż "5" dla innego.
2. **Niezależny od Definition of Done.** Zmiana DoD zmienia velocity, nie zmienia throughput.
3. **Bardziej uczciwy dla zespołu.** "Zrobiliśmy 18 tasków" vs "zrobiliśmy 47 punktów" — pierwsze jest konkretne.

**Forecast z throughput:**
```
Remaining scope (count) → podziel przez median throughput (count/week) → expected delivery date
Dodaj: range (50%, 85%, 95%) z rozkładu historycznego
```

### 4.3 Kiedy velocity nadal ma sens

- Gdy zespół jest Scrum-owy i ma DoD stabilny od lat
- Gdy priorytet to **internal** capacity planning, nie external forecasting
- Gdy historyczne velocity jest stabilne (low std deviation)

### 4.4 Flow metrics w praktyce (Actionable Agile / Troy Magennis)

Kanban flow metrics, które mówią więcej niż velocity:

| Metryka | Co Ci mówi |
|---------|-----------|
| **WIP** | Ile pracy w toku (za dużo = bottleneck) |
| **Cycle time P50 / P85 / P95** | Ile czasu zajmuje typowa sprawa vs najgorszy przypadek |
| **Throughput (count/week)** | Ile zamykamy regularnie |
| **Aging WIP** | Ile czasu najstarszy task wisi w "doing" |
| **Blocked time** | Ile czasu taski są zablokowane (czekanie) |

---

## 5. Forecast vs Commitment (ważne rozróżnienie)

### 5.1 Trzy tryby

| Tryb | Audience | Pewność | Język |
|------|----------|---------|-------|
| **Forecast** | Board, stakeholderzy, marketing | ±20-30% (confidence interval) | "Prawdopodobnie Q3, 80% confidence" |
| **Commitment** | Zespół, na dany sprint | Wysoka (ale z buforem) | "Te 8 tasków zamkniemy w tym sprincie" |
| **Stretch** | Sam zespół | Aspirational | "8 tasków + 2 stretch goals" |

### 5.2 Dlaczego to rozróżnienie jest kluczowe

Cagan (SVPG) i Will Larson (An Elegant Puzzle, 2019): **większość zespołów myli forecast z commitment**.

Skutki:
- "Forecast zrobiliśmy, więc to jest commitment" → chronic overcommitment.
- "Commitment zrobiliśmy, ale z buforem 30%" → stakeholders myślą, że bufor to safety net, a to jest commitment.

**Reguła:** w rozmowie ze stakeholderami zawsze mów "forecast z confidence interval", nie "delivery date".

### 5.3 Jak mówić daty z Monte Carlo

**Źle:** "Dostarczymy 2026-09-15."

**Lepiej:** "Dla 47 remaining tasków: 50% szans na 2026-08-15, 80% na 2026-09-12, 95% na 2026-10-05. Rekomenduję targetować 2026-09-12."

**Dlaczego to działa:** uczciwie mówi o niepewności, daje stakeholderom wybór (priorytet szybkości vs pewności), buduje zaufanie długoterminowo.

---

## 6. AI-era estymacja (nowe wyzwania 2025-2026)

### 6.1 Jak AI zmienia rozkład estymat

Tradycyjny rozkład estymat jest ~log-normal (Cohn 2009): prawdopodobieństwo niedoszacowania > przeszacowania, mediana < średnia.

AI-generowany kod zmienia to:

| Typ taska | Tradycyjny rozkład | AI-rozkład |
|-----------|--------------------|----------- |
| **Znany pattern (CRUD, REST endpoint)** | log-normal, ~5 pkt proc. variance | Bardziej spójny (AI robi szybko) |
| **Nowy pattern (np. architektura)** | log-normal, duży variance | Podobny (AI nie wymyśli nowego wzorca) |
| **Debug / incident** | Bardzo gruby ogon (długie debug sesje) | Bez zmiany (AI nie pomaga w diagnostyce złożonych bugów) |
| **Integration (zewnętrzne API)** | Zależy od API | Zależy od API + od AI hallucinations |

**Praktyczny efekt:** estymaty dla **znanych zadań** są bardziej spójne (mniej variance). Ale **ogon rozkładu** (złożone / nowe zadania) jest nadal tak samo nieprzewidywalny.

### 6.2 Nowy model: estymuj zadania osobno dla AI i dla ludzi

**Pattern (Stripe Engineering Blog Q4 2025):**
- Każdy task dostaje tag: `ai-friendly` / `human-only` / `hybrid`.
- `ai-friendly` — estymata mniejsza (2-5x), ale z mandatory review time.
- `human-only` — tradycyjna estymata.
- `hybrid` — split estymata (AI: X h, human review + integration: Y h).

### 6.3 AI risk w estymacji

Trzy pułapki:

1. **AI hallucination cost.** Wygląda zrobione, ale nie działa. Dodaj +30-50% review time dla AI-generated code.
2. **Context drift cost.** Agent traci kontekst po X godzinach. Sesje powinny być 2-4h, nie "zrób mi cały moduł".
3. **Over-confidence.** "Cursor zrobił to w 30 min" staje się baseline, ale nie uwzględnia review / testing / integration.

### 6.4 Jak aktualizować estymaty w erze AI

| Tradycyjnie | Er AI |
|------------|-------|
| Estymata na początku, aktualizacja co tydzień | Estymata + confidence level na początku, codzienna aktualizacja |
| Sprint goal = scope | Sprint goal = scope + AI cost budget |
| Velocity tracking | Velocity + LLM cost per PR |

---

## 7. Capacity buffer — ile bufora potrzebujesz

### 7.1 Dlaczego bufor to nie "luz"

Buffer to **planowana rezerwa** na nieprzewidziane. Nie to samo co "luz" (= mniej roboty).

Buffer absorbuje:
- Scope clarification (mid-sprint discovery)
- Code review rework
- On-call incidents
- Bug fixes z produkcji
- Tooling issues (CI breaks, env issues)
- Sick leave / urlopy

### 7.2 Ile bufora

| Źródło | Rekomendacja |
|--------|--------------|
| Boehm (1987) | 20-30% |
| Cohn (2005) | 30% |
| Cagan (SVPG, 2026) | 30% (nawet w sprincie commitment) |
| State of Agile (2024) | Mediana zespołów = 25-35% |
| Stripe (2024, high-velocity teams) | 40-50% (z powodu on-call + incidenty) |

**Rekomendacja praktyczna:**
- **30% buffer dla standardowego zespołu** (feature dev, mało on-call).
- **40-50% buffer dla zespołu z on-call** (SRE, infra, high-availability).
- **20% buffer tylko wtedy, gdy masz dojrzały throughput forecasting** i znasz swoje rozkłady.

### 7.3 Kiedy bufor się "zjada"

Buffer jest OK do zjedzenia, ale NIE do planowania. Jeśli bufor zjadany co sprint:
- Re-evaluate estymaty (są za niskie)
- Re-evaluate scope (za duży na zespół)
- Re-evaluate capacity (za mało ludzi lub focus factor spadł)

---

## 8. Anti-patterns estymacji

| # | Anty-pattern | Dlaczego szkodliwy |
|---|--------------|--------------------|
| 1 | **Velocity jako KPI** | Różny scope mix i DoD → fałszywe porównania |
| 2 | **"Story point = ideal day"** | To dwie różne metryki, konwersja to pułapka |
| 3 | **Estymata "idealnie"** | Planowanie 100% capacity bez bufora = failure |
| 4 | **Niedoszacowanie dla "wygrania"** | Reward system → chronic overcommitment |
| 5 | **Brak aktualizacji estymaty** | Estymata to hipoteza, nie kontrakt |
| 6 | **Planning poker dla wszystkiego** | Overhead, lepiej t-shirt dla triage |
| 7 | **Monte Carlo bez historii** | Wyniki bezwartościowe, gorsze niż t-shirt |
| 8 | **Capacity bez focus factor** | Zawyżasz realną pojemność o 30-40% |
| 9 | **AI estymata = human estymata / 2** | AI pomaga w generowaniu, nie w integration / review |
| 10 | **Forecast bez confidence interval** | Mówisz datę, której nie dotrzymasz |
| 11 | **Sumowanie story points** | "5+5+8 = 18" — punkty nie są addytywne |
| 12 | **WIP bez limitu** | Brutalny context switching, spada throughput |

---

## 9. Rekomendacje praktyczne (dla różnych kontekstów)

### Solo developer

- **T-shirt sizes** dla własnego triaging.
- **Cycle time tracking** (ile dni od "start" do "done" per task).
- **Throughput per tydzień** (średnia z ostatnich 8 tygodni).
- **Nie estymuj pojedynczych tasków precyzyjnie** — szkoda czasu.

### Mały zespół (3-6)

- **T-shirt + story points** dla commitment (planning poker co 2 tyg.).
- **Velocity tracking** dla capacity (rolling 3-sprint avg).
- **Focus factor 0.65** jako baseline.
- **30% buffer** w każdym sprincie.

### Średni zespół (7-15)

- **Story points + Monte Carlo** dla board-level forecast.
- **Throughput + cycle time** dla ops dashboard.
- **Focus factor 0.60** (więcej spotkań, cross-team sync).
- **WIP limit per team + per osoba** (Kanban element).
- **Capacity buffer 35-40%** (więcej on-call, więcej stakeholderów).

### Duży zespół (15+)

- **Monte Carlo + flow metrics** (Actionable Agile).
- **Multiple teams → cross-team dependencies** (critical path).
- **Capacity buffer 40-50%** (SRE, infra, customer-facing).
- **Program increment planning** (PI planning, 8-12 tygodni).

### AI-heavy team (wszystkie sizes, 2025-2026)

- **Tagowanie tasków**: `ai-friendly` / `human-only` / `hybrid`.
- **AI cost budget** per sprint (LLM spend cap).
- **Mandatory review time** dla AI-generated code (+30-50% do estymaty).
- **Throughput tracking per typ taska** (AI throughput vs human throughput).

---

## 10. Jak to wygląda w Jointhubs

| Obszar | Co mamy | Co brakuje | Rekomendacja |
|--------|---------|------------|--------------|
| **Estymacja** | Brak formalnej techniki w Linear | Wybór techniki + kalibracja | T-shirt dla discovery, story points dla commitment |
| **Capacity** | Liczymy mentalnie | Jawne focus factor | 65% baseline w planach |
| **Velocity** | Linear cycles (2 tyg.) | Velocity tracking | 3-sprint rolling avg, do capacity planning |
| **Throughput** | Brak metryki | Dashboard | Throughput per week per project |
| **Monte Carlo** | Brak | Forecasting dat | Actionable Agile lub custom skrypt |
| **Buffer** | Brak | 30% rule | Dodać do plan_template |
| **AI risk** | Brak | Policy + budget | Tagowanie tasków, LLM cost tracking |

**Pierwszy krok:** stworzyć prosty "estimation policy" w `Second Brain/Operations/Docs/estimation_policy.md` (lekki, 1-2 strony):
- Jakie scope level = jaka technika estymacji
- Focus factor do użycia
- Buffer do użycia
- Kiedy Monte Carlo vs kiedy forecast bez

---

## 11. Źródła

### Klasyka estymacji

- Mike Cohn — *Agile Estimating and Planning* (Mountain Goat Software, 2005 + updates 2024)
- Barry Boehm — *Software Engineering Economics* (1987, focus factor baseline)
- Kent Beck — *Extreme Programming Explained* (1999 + 2004, estimation philosophy)
- Tom DeMarco — *Waltzing with Bears* (risk management w planowaniu, 2003)

### Nowoczesne techniki

- Woody Zuill — *#NoEstimates* (2014-2026, blog series, case studies)
- Dimitar Bakardzhiev — *Monte Carlo simulation for software delivery forecasting* (2018-2024)
- Daniel Vacanti — *Actionable Agile Metrics* (2014 + updates 2024)
- Troy Magennis — *Flow Metrics for Scrum* (2019 + 2024)
- Janna Bastow — *Now-Next-Later Roadmap* (ProdPad, 2018-2024)

### Cycle / Velocity / Throughput

- Jeff Sutherland — *Scrum Guide* (2020 revision)
- Ryan Singer — *Shape Up* (Basecamp, 2019 + updates 2024)
- David Anderson — *Kanban* (2010 + 2023 update)
- Corey Ladas — *Scrumban and Other Hybrid Approaches* (2008)

### State of Agile / industry reports

- Digital.ai — *State of Agile Report* (2024, 2025) — 80% hybrid teams
- Linear — *Engineering benchmarks 2024-2025* — cycles, velocity, cycle time
- GitHub — *Octoverse 2025* — Copilot productivity stats
- Stripe Engineering Blog — *AI productivity in practice* (Q4 2025)

### AI-era estimation

- Marty Cagan — *Build To Learn FAQ* (SVPG, kwiecień 2026)
- Charity Majors — *Observability Engineering* (2nd ed. 2026, AI ops)
- ThoughtWorks Tech Radar 2024-2025 — AI tooling trends
- Stack Overflow Developer Survey 2024-2025 — AI tool adoption

### Planowanie w Jointhubs (kontekst)

- `Second Brain/Projects/fenix/202601 rekrutacja/FENIX_ROADMAP_2026.md`
- `Second Brain/Operations/Docs/research_software_project_planning_best_practices.md` (companion)
