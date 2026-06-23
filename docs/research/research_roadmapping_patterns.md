---
type: research-note
status: active
tags: [type/research, area/methodology, topic/planning, topic/roadmapping, topic/product-management, topic/okr, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
related: [research_software_project_planning_best_practices.md, research_estimation_techniques.md, research_planning_tools_2026.md, research_software_delivery_review_best_practices.md]
---

# Roadmapping i planowanie portfolio — deep research

> Druga z trzech notatek szczegółowych do
> [[research_software_project_planning_best_practices.md]]. Ta odpowiada na
> pytanie **"co budujemy w perspektywie kwartałów / roku i dlaczego akurat to"**
> — od klasycznego Gantta, przez outcome-based roadmapy (Now/Next/Later, Themes),
> po OKR, GIST, RICE, ICE i portfolio planning na poziomie firmy.
>
> Źródła: Jeff Patton (User Story Mapping), Christina Wodtke (Radical Focus,
> OKR practice), John Doerr (Measure What Matters), Marty Cagan (SVPG —
> Outcomes over Output, Mission → Strategy → OKR → Big initiatives),
> Janna Bastow (Now-Next-Later, ProdPad), Itamar Gilad (GIST framework),
> Sean Ellis (ICE scoring, growth), Intercom (RICE prioritization),
> Cagan/Fitzpatrick (Product Mindset, The Startup CEO),
> Boris Evelson (Forrester — portfolio management),
> ThoughtWorks Tech Radar 2024-2025 (roadmapping trends).

---

## TL;DR

1. **Roadmapa NIE jest Ganttem.** Gantt = commitment na daty. Roadmapa = komunikacja kierunku. Pomylenie tego = chronic overcommitment.
2. **Są 4 domeny planowania, każda ma swoją road mapę:** strategy (lata), portfolio (kwartały), product (miesiące), sprint (tygodnie). Roadmapa produktu ≠ roadmapa firmy.
3. **Now/Next/Later > dates** (Bastow, ProductPlan). Outcome-based > feature-based. Themes > epics. To są trzy najważniejsze przejścia mentalne.
4. **OKR ≠ roadmap.** OKR = outcome metrics (cele kwartalne). Roadmapa = środki do osiągnięcia OKR-ów. Mylenie = "dostarczyliśmy 47 ficzerów, ale nie osiągnęliśmy celu".
5. **Portfolio planning to trade-off.** Macierz Eisenhower (pilne/ważne) × effort/impact × risk. Nie da się zrobić wszystkiego — i nie powinno.
6. **RICE / ICE / WSJF** to narzędzia priorytetyzacji, nie roadmapping. Służą do rankowania backlogu, nie do komunikacji strategii.
7. **GIST framework** (Gilad, 2024) = Goals, Ideas, Step-projects, Tasks. Łączy outcome (Goals) z execution (Tasks). Dobry pattern dla małych zespołów.
8. **2026 trend: outcome-based portfolio** zamiast feature-based. Productboard, Linear, Height ułatwiają outcome tracking. "Co zrobiliśmy" (output) mniej ważne niż "czy osiągnęliśmy cel" (outcome).
9. **Roadmapa musi umrzeć.** Living doc, nie wiki. Aktualizuj co miesiąc (lub co sprint w dynamicznych zespołach). Stara, nieaktualna roadmapa = pułapka.

---

## 1. Roadmapa nie jest Ganttem (rozróżnienie podstawowe)

### 1.1 Cztery domeny planowania

| Domena | Horyzont | Odpowiada na | Output |
|--------|----------|--------------|--------|
| **Strategy** | 3-5 lat | "Gdzie chcemy być?" | Vision, mission, strategic pillars |
| **Portfolio** | 1 rok / 4 kwartały | "Co inwestujemy, czego nie robimy?" | Portfolio roadmap, OKR roczny |
| **Product** | 1-4 kwartały | "Co budujemy w product area?" | Product roadmap (themes, outcomes) |
| **Sprint / cycle** | 1-4 tygodnie | "Co zamykamy w tej iteracji?" | Sprint backlog, scope to-do |

**Roadmapa to domyślnie product-level.** Firmy często mylą ją z portfolio lub strategy.

### 1.2 Dlaczego data-driven roadmap jest anty-patternem

| Mit | Rzeczywistość |
|-----|---------------|
| "Roadmapa z datami daje commitment" | Stakeholderzy traktują daty jako commitment → chronic overcommitment |
| "Roadmapa z datami pomaga w planowaniu" | Zmienia się scope 30-50% co kwartał; daty szybko się dewalują |
| "Roadmapa z datami komunikuje kierunek" | Komunikuje, ale każdy czyta ją inaczej (PM widzi scope, board widzi commitment) |

**Bastow (ProdPad):** data-driven roadmapa jest OK dla portfolio (commitment na rok), ale NIE dla product roadmap (output 1-2 kwartałów).

### 1.3 Trzy formaty roadmap (poziom abstrakcji)

```
Strategy level:    Vision statement + 3-5 strategic pillars
Portfolio level:   Outcomes (OKR / KPI) + initiatives per outcome
Product level:     Now / Next / Later (lub Themes) + outcome metrics
Sprint level:      Sprint backlog + capacity plan
```

---

## 2. Now / Next / Later (Bastow, ProdPad)

### 2.1 Mechanizm

Trzy kolumny (zamiast dat):

| Kolumna | Commitment | Audience | Update frequency |
|---------|-----------|----------|------------------|
| **Now** | Wysoki — robimy teraz | Zespół + stakeholderzy | Co sprint (co 2 tyg.) |
| **Next** | Średni — prawdopodobnie następny | Zespół | Co miesiąc |
| **Later** | Niski — może kiedyś | Stakeholderzy + zespoły sąsiednie | Co kwartał |

**Zasady kanoniczne:**
- **Now jest krótki.** Max 1 kwartał scope'u. Konkretne ficzery lub capabilities.
- **Next jest kierunkowy.** Konkretne tematy, ale scope może się zmienić.
- **Later jest tematyczny.** Outcomes / problems, nie features.
- **Nie ma dat.** Daty są w sprint backlogu, nie w roadmapie.

### 2.2 Kiedy pasuje

- Produkt z 1-3 product area (nie 20)
- Zespół 5-15 osób
- Stakeholderzy akceptują "będzie ale nie wiem kiedy"
- Scope volatility jest wysoka (nowy produkt, szybka iteracja)

### 2.3 Kiedy nie pasuje

- Board wymaga commitment rocznego (wtedy portfolio-level roadmap)
- Klienci enterprise wymagają dat (wtedy feature list z quarter estimate)
- Strategiczne inwestycje kapitałowe wymagają timeline (wtedy Gantt dla tej inicjatywy)

### 2.4 Warianty

- **Now / Soon / Later** (Stripe, GitLab) — Soon zamiast Next, mniej precise.
- **Now / Next / Never** (anty-pattern) — Never to "backlog", ukrywa scope.
- **Now / Next / Future / Out** (Microsoft) — bardziej granularny, dobry dla dużych orgów.

---

## 3. Outcome-based roadmapping

### 3.1 Output vs Outcome (Cagan, SVPG)

| Output (zrobiliśmy) | Outcome (osiągnęliśmy) |
|----------------------|-------------------------|
| 47 endpointów | 30% wzrost adopcji |
| 12 ficzerów | 25% redukcja support tickets |
| Nowa integracja z X | 15% wzrost retention |
| Redesign onboardingu | Zmniejszony time-to-value z 14 do 5 dni |

**Output jest efektem pracy. Outcome jest wartością biznesową.**

Roadmapa powinna mierzyć outcome. Output pojawia się w sprint backlogu, nie w roadmapie.

### 3.2 Theme vs Epic vs Feature

| Poziom | Definicja | Przykład | Kto zarządza |
|--------|-----------|----------|--------------|
| **Theme** | Outcome group, trwający kwartały | "Zwiększenie adopcji mobile" | Product leadership |
| **Epic** | Duży blok scope, trwający tygodnie-miesiące | "Onboarding flow dla mobile" | Product trio |
| **Feature** | Konkretna funkcjonalność, tygodnie | "Login z biometrią" | Zespół implementujący |
| **Story** | Vertical slice, dni | "User może zalogować się Face ID po pierwszym setupie" | Developer |
| **Task** | Atomowa jednostka, godziny-dni | "Dodać pole `biometric_enabled` do users table" | Developer |

**Roadmapa mieszka na poziomie Theme.** Epic jest w product backlogu. Feature w sprint backlogu.

### 3.3 Kiedy outcome-based, kiedy output-based

**Outcome-based roadmap (preferowane):**
- Nowy produkt / nowy product area (musisz wiedzieć czy idziesz w dobrą stronę)
- Stakeholderzy to board / execs (chcą wiedzieć jaki efekt)
- Długi horyzont (kwartał+) — feature list byłby niestabilny

**Output-based roadmap (kiedyś OK):**
- Maintenance / bug fixes (z definicji output)
- Compliance / regulacje (konkretne ficzery wymagane przez prawo)
- Migracje techniczne (konkretny efekt techniczny)

**Nigdy:**
- Roadmapa "ficzerów bez kontekstu" — to jest ficzer factory.

---

## 4. OKR — Objective and Key Results

### 4.1 Mechanizm (Doerr, Wodtke)

| Element | Co to jest | Kto pisze | Przykład |
|---------|-----------|-----------|----------|
| **Objective** | Jakościowy, ambitny, inspirujący cel | Leadership | "Stać się domyślnym wyborem dla małych zespołów w PL" |
| **Key Results** | 3-5 mierzalnych wyników | Zespół / leadership | "1000 aktywnych zespołów do końca Q4", "NPS 60+", "30% organic acquisition" |

### 4.2 OKR ≠ KPI

| OKR | KPI |
|-----|-----|
| Ambitny (70% completion = sukces) | Baseline (100% = norma) |
| Kwartalny | Ciągły |
| Zmienia się co kwartał | Stabilny przez lata |
| Outcome-focused | Może być output-focused |
| Owned by leadership + team | Owned by ops |

### 4.3 OKR cycle (Wodtke)

```
Q-start (1-2h):
  - Define 1-3 Objectives
  - Define 3-5 KRs per Objective
  - Alignment z firmą / innymi teamami

Mid-quarter check-in (2-4×):
  - Confidence score (0.3-1.0)
  - Now / Next / Later review
  - Re-prioritize jeśli confidence < 0.5

Q-end retro (1h):
  - Co osiągnęliśmy?
  - Co nas zaskoczyło?
  - Co przenosimy do następnego Q?
```

### 4.4 Kiedy OKR nie działa

| Anty-pattern | Dlaczego nie działa |
|--------------|---------------------|
| **OKR bez outcome metrics** | "Zrobimy 47 ficzerów" to nie OKR |
| **OKR jako performance review** | Ludzie sandbagują (niskie targets) |
| **OKR bez regular check-ins** | Drift w 3-4 tygodniu, Q-end surprise |
| **OKR bez ownership** | "Wszyscy odpowiadają" = nikt nie odpowiada |
| **OKR > 3 Objectives** | Za dużo, brak focus |

---

## 5. GIST — Goals, Ideas, Step-projects, Tasks (Gilad, 2024)

### 5.1 Mechanizm

```
Goals (cele, kwartalne)
  ↓ decomposed into
Ideas (koncepcje rozwiązań, niezobowiązujące)
  ↓ validated by
Step-projects (małe projekty walidacyjne, 2-6 tygodni)
  ↓ converted to
Tasks (wykonalna praca w sprintach)
```

### 5.2 Dlaczego GIST działa

- **Goals = outcome** (jak OKR, ale bez "key results" — sam goal)
- **Ideas = backlog pomysłów** (bez commitment)
- **Step-projects = bet sizing** (Shape Up mindset — ile czasu chcemy wydać?)
- **Tasks = sprint backlog** (wykonalne)

To łączy **strategy execution** (goals) z **continuous discovery** (ideas) z **delivery rhythm** (tasks).

### 5.3 Kiedy pasuje

- Mały zespół (3-10 osób)
- Produkt z discovery-heavy
- Zespół doświadczony (potrafi sam zarządzać trade-offami)
- Scope volatility wysoka

### 5.4 Kiedy nie pasuje

- Duży org (za mało structure)
- Stakeholderzy wymagają formalnych OKR/KPI
- Compliance / regulacje (za mało rygoru)

---

## 6. Portfolio planning — alokacja zasobów

### 6.1 Czym jest portfolio planning

Portfolio = zbiór inicjatyw (projektów, produktów, programów) konkurujących o zasoby (ludzie, czas, budżet).

**Kluczowe pytanie:** które inicjatywy zasługują na inwestycję, a które uśmiercić?

### 6.2 Trzy frameworki priorytetyzacji portfolio

#### RICE (Intercom)

```
RICE score = (Reach × Impact × Confidence) / Effort

Reach = ile osób / eventów dotyczy (per quarter)
Impact = massive (3) / high (2) / medium (1) / low (0.5) / minimal (0.25)
Confidence = 100% / 80% / 50%
Effort = person-months (estimate)
```

**Przykład:** "Mobile onboarding redesign"
- Reach: 5000 users/quarter
- Impact: 2 (high)
- Confidence: 80%
- Effort: 3 person-months
- RICE = (5000 × 2 × 0.8) / 3 = **2667**

#### ICE (Sean Ellis, growth)

```
ICE score = Impact × Confidence × Ease (każde 1-10)

Impact = jak bardzo wpływa na wzrost?
Confidence = jak bardzo jesteśmy pewni?
Ease = jak łatwe do wdrożenia?
```

**Szybsze niż RICE** (3 pytania zamiast 4), ale mniej rigorous.

#### WSJF (Weighted Shortest Job First, SAFe)

```
WSJF = Cost of Delay / Job Size

Cost of Delay = User-Business Value + Time Criticality + Risk Reduction
Job Size = effort estimate
```

**SAFe pattern** — dobry dla dużych programów z wieloma zależnymi inicjatywami.

### 6.3 Porównanie frameworków

| Framework | Kiedy używać | Zalety | Wady |
|-----------|--------------|--------|------|
| **RICE** | Discovery / growth | Quantified, porównywalny | Wymaga danych (Reach) |
| **ICE** | Szybkie triaging | Szybki, prosty | Subiektywny |
| **WSJF** | Duże programy | Uwzględnia urgency | Cięższy w utrzymaniu |
| **Eisenhower matrix** | Codzienne decyzje | Wizualny, prosty | Za prosty dla portfolio |
| **Kano model** | Customer satisfaction | Wyróżnia delighters vs basic | Nie dla trade-off między projektami |

### 6.4 Eisenhower matrix (codzienny use)

| | Pilne | Niepilne |
|---|-------|----------|
| **Ważne** | Zrób teraz (crisis, deadline) | Zaplanuj (strategiczne) |
| **Nieważne** | Deleguj (interruptions) | Odrzuć (noise) |

Dobra do daily triage, za prosta do portfolio planning.

---

## 7. Strategic alignment (od strategii do taska)

### 7.1 Łańcuch powiązań (Cagan, SVPG)

```
Vision (3-5 lat)
  ↓ decomposed into
Mission (1-2 lata, konkretniej)
  ↓ decomposed into
Strategy (jak wygrać)
  ↓ decomposed into
OKR / Big initiatives (rok)
  ↓ decomposed into
Themes (kwartał, product area)
  ↓ decomposed into
Epics (miesiące, cross-team)
  ↓ decomposed into
Features (tygodnie, single team)
  ↓ decomposed into
Stories (dni, vertical slice)
  ↓ executed as
Tasks (godziny-dni)
```

### 7.2 Alignment check

Każdy task MUSI dać się podłączyć do:
1. **Epic** (1-2 miesiące scope)
2. **Feature** (tydzień)
3. **Theme** (kwartał outcome)

Jeśli nie da się podłączyć — task jest utility / housekeeping. Może być ważny (security patch), ale nie jest częścią strategii.

### 7.3 Portfolio vs Product alignment

- **Portfolio** = decyzja: który product area zasługuje na inwestycję?
- **Product** = decyzja: który theme w tym product area?
- **Sprint** = decyzja: które feature w tym theme?

Każdy poziom ma inny audience i rytm decyzyjny.

---

## 8. Narzędzia roadmap (Productboard, Linear, Height, Aha!)

### 8.1 Porównanie 2026

| Narzędzie | Mocna strona | Słaba strona | Kiedy wybrać |
|-----------|--------------|---------------|--------------|
| **Productboard** | Customer-driven prioritization, integrations | Cięższy w setupie | Product-led growth, B2B SaaS |
| **Linear** | Cycles (sprint), projects, simplicity | Brak native roadmap view | Engineering-heavy teams, startup |
| **Height** | Spreadsheet + database hybrid | Mniejszy ecosystem | Custom workflows, ops-heavy |
| **Aha!** | Strategy → roadmap → delivery w jednym | Overkill dla małych | Enterprise, multi-product orgs |
| **Notion** | Flexibility, docs + database | Brak PM-specific features | Docs-first teams, content |
| **Asana** | Multi-team, portfolio view | Za generyczny | Marketing + ops mix |
| **Jira Align** | Enterprise alignment z Jira | Heavy, kosztowny | Fortune 500, multi-team |

### 8.2 Linear specifics (Jointhubs aktualnie używa)

**Linear way:**
- **Projects** = product area / initiative
- **Cycles** = sprint (2 tyg. default)
- **Initiatives** = strategic themes (grupa projects pod outcome)
- **Roadmap view** (2025+) = native Now/Next/Later visualization

**Wniosek:** Linear ma już wsparcie dla outcome-based roadmap, ale Jointhubs tego nie używa (albo używa w ograniczonym zakresie).

### 8.3 Integracje planistyczne (2026)

- **Linear ↔ Productboard** — sync product feedback z delivery
- **Linear ↔ Height** — syncing engineering tasks z product ops
- **Linear ↔ Notion** — docs (PRDs) linkowane do issues
- **Jira ↔ Linear** — migracja jednokierunkowa (zwykle Jira → Linear)

Pełny porównanie narzędzi w [[research_planning_tools_2026.md]] (planowane).

---

## 9. Roadmap anti-patterns

| # | Anty-pattern | Dlaczego szkodliwy |
|---|--------------|--------------------|
| 1 | **Roadmapa = Gantt z datami** | Commitment na nierealistyczne daty → chronic overcommitment |
| 2 | **Output-based bez outcome** | "Zrobiliśmy 47 ficzerów" — ale co z tego? |
| 3 | **Roadmapa bez themes** | Lista ficzerów bez kontekstu strategicznego |
| 4 | **Roadmapa bez ownera** | Wszyscy odpowiadają = nikt |
| 5 | **Roadmapa z > 3 objectives** | Brak focus |
| 6 | **Roadmapa bez check-in cycle** | Drift w Q-end, brak adaptacji |
| 7 | **Roadmapa "jedna dla wszystkich"** | Różne audience, różne potrzeby |
| 8 | **Roadmapa bez customer insights** | Ficzer factory bez ground truth |
| 9 | **Roadmapa bez out-of-scope** | Scope creep nieograniczony |
| 10 | **Roadmapa bez dependencies** | "X zrobimy w Q2" ale X zależy od Y które nie jest w roadmapie |
| 11 | **Roadmapa jako wiki** | Pisana raz, nigdy nie aktualizowana |
| 12 | **OKR jako performance review** | Sandbagging, fałszywe niskie targets |
| 13 | **RICE bez danych (Reach)** | Reach = zgadywanka, niski sygnał |
| 14 | **RICE porównywalny między zespołami** | Różny scope mix, różna kalibracja — nie porównuj |
| 15 | **Portfolio planning = "kto głośniej krzyczy"** | Loudest voice ≠ highest value |

---

## 10. Roadmap cadency i rytuały

### 10.1 Trzy rytuały roadmap

| Rytuał | Częstotliwość | Audience | Output |
|--------|---------------|----------|--------|
| **Strategic review** | Co kwartał | Board / leadership | OKR + portfolio adjustment |
| **Roadmap sync** | Co miesiąc | Product + eng leadership | Now/Next/Later refresh |
| **Sprint planning** | Co 2 tygodnie | Engineering team | Sprint backlog |

### 10.2 Aktualizacja roadmapy

Roadmapa musi być **living document**, nie wiki.

**Rekomendowana kadencja aktualizacji:**
- **Now column** — co sprint (po retrospektywie)
- **Next column** — co miesiąc
- **Later column** — co kwartał (lub po strategic review)

**Kiedy nie aktualizować:**
- Codziennie (overhead)
- Po każdym spotkaniu (brak stabilności)
- Przez każdego (brak ownera)

### 10.3 Living doc patterns

- **Publiczne edytowanie** (np. Notion, Productboard) — każdy może zgłosić zmianę.
- **Owner per section** — ktoś odpowiada za aktualność.
- **Version history** — kiedy i dlaczego zmieniono (szczególnie przy scope removal).
- **Comments + discussion** — wątpliwości inline.

---

## 11. Customer-driven roadmapping (opcjonalny layer)

### 11.1 Kiedy dodać customer feedback layer

Dla produktów z:
- Duża baza użytkowników (1000+)
- Feedback z wielu źródeł (support, sales, in-app, social)
- Discovery-heavy product discovery

### 11.2 Trzy źródła insights

| Źródło | Typ | Częstotliwość |
|--------|-----|---------------|
| **Quantitative** (analytics) | Zachowanie userów, adoption, churn | Continuous |
| **Qualitative** (rozmowy) | Jobs-to-be-done, pain points | Weekly (Torres) |
| **Reactive** (support tickets) | Failure modes, missing features | Daily (sieved) |

### 11.3 Productboard pattern

Productboard łączy wszystkie trzy źródła:
1. Zbiera feedback z Intercom, Salesforce, Zendesk, in-app.
2. Priorytetyzuje wg impact (RICE / custom).
3. Mapuje na strategic objectives.
4. Push do delivery (Linear, Jira).

Alternatywa open-source: **Dovetail** (research) + **Linear** (delivery) + **Notion** (docs).

---

## 12. Rekomendacje praktyczne (dla różnych kontekstów)

### Solo founder / startup

- **OKR z 1 Objective** per kwartał, max 3 KRs.
- **Now/Next/Later w Notion** lub **Linear Initiatives** (2025+).
- **Co miesiąc review** z 1-2 kluczowymi ludźmi.
- **Bez Productboard** (overkill, lepiej Notion + rozmowy).

### Mały zespół (3-10)

- **2-3 Objectives** per kwartał.
- **Now/Next/Later + Themes**.
- **Linear Initiatives** do theme tracking.
- **Co miesiąc roadmap sync** (30 min).
- **Mid-quarter check-in** (2× per Q).

### Średni zespół / scaleup (15-50)

- **3-5 Objectives** per kwartał (per product area).
- **Portfolio view** (Productboard / Linear Portfolio / Notion).
- **Co miesiąc portfolio sync** (1h, cross-team).
- **RICE scoring** dla nowych inicjatyw.
- **Customer-driven layer** (Productboard lub Dovetail).

### Duży org (100+)

- **Cascading OKR** (firma → division → team → IC).
- **Strategic portfolio review** (quarterly + ad-hoc).
- **Multiple roadmaps** (per product area).
- **WSJF** dla cross-team dependencies.
- **Dedicated PMO** (program management office).

---

## 13. Jak to wygląda w Jointhubs

| Obszar | Co mamy | Co brakuje | Rekomendacja |
|--------|---------|------------|--------------|
| **Roadmapa Fenix** | FENIX_ROADMAP_2026 (kwartały) | Outcome metrics (teraz są features) | Dodać 1 outcome metric per kwartał |
| **Roadmapa Office AI** | Taksonomia 12 klastrów | Themes + epics | Mapować 12 klastrów → 3-4 themes |
| **Roadmapa Neo** | Brak | Wszystko | Stworzyć Now/Next/Later |
| **Roadmapa PISI** | 100 tasków w Linear | Brak themes, brak outcomes | Dodać Initiatives per outcome |
| **OKR** | Brak formalnego | Wdrożyć Q3 2026 | Top 2 OKR per product area |
| **Portfolio view** | Brak | Cross-project view | Linear Initiatives (cross-project) |
| **Strategic review** | Ad-hoc | Co kwartał | Setup Q-review template |
| **RICE scoring** | Brak | Dla nowych inicjatyw | Prosty template w Notion / Linear |

**Pierwsze kroki (Q3 2026):**
1. **Miesiąc 1:** zdefiniować 1 Objective per aktywny project (Fenix, Neo, Office AI, PISI).
2. **Miesiąc 2:** ustawić Now/Next/Later w Linear (Initiatives 2025+ feature).
3. **Miesiąc 3:** pierwszy Q-review z outcomes analysis.

---

## 14. Źródła

### Klasyka product discovery i planning

- Jeff Patton — *User Story Mapping* (2014, nadal kanoniczny)
- Marty Cagan — *Inspired: How to Create Tech Products Customers Love* (SVPG, 2017 + 2024)
- Marty Cagan — *Outcomes over Output* (SVPG, 2024)
- Marty Cagan / Chris Jones — *Product Operations* (2017 + 2024)
- Marty Cagan / Marilyn Ferguson — *The Product Mindset* (2024)

### OKR

- John Doerr — *Measure What Matters* (2018)
- Christina Wodtke — *Radical Focus* (2016 + 2024)
- Felipe Castro / Ben Lamorte — *Objectives and Key Results* (OKR Institute, 2024)

### Roadmapping formats

- Janna Bastow — *Now-Next-Later Roadmap* (ProdPad blog, 2018-2024)
- Itamar Gilad — *GIST: Great Ideas Start Here* (2024)
- ProductPlan — *12 Roadmap formats compared* (2024)
- C. Todd Lombardo / J. Carey / M. McAllister — *Design Sprint Kit* (Intercom, 2018)

### Priorytetyzacja

- Sean Ellis / Morgan Brown — *Hacking Growth* (2017, ICE scoring)
- Intercom — *RICE prioritization* (2016 + 2024 updates)
- SAFe — *WSJF* (Scaled Agile Framework docs)
- Boris Evelson (Forrester) — *Portfolio Management for Product Managers* (2023)

### Strategy i alignment

- Roger Martin — *Playing to Win* (2013, strategy cascades)
- Richard Rumelt — *Good Strategy Bad Strategy* (2011)
- Andy Grove — *High Output Management* (1983 + 2015, OKR precursor)

### Industry reports

- ThoughtWorks Tech Radar 2024 + 2025 (roadmapping trends)
- State of Agile 2024 (Digital.ai)
- ProductBoard *State of Product Management 2024*
- Linear *Engineering benchmarks 2024-2025*

### Planowanie w Jointhubs (kontekst)

- `Second Brain/Projects/fenix/202601 rekrutacja/FENIX_ROADMAP_2026.md`
- `Second Brain/Projects/office_ai/CONTEXT.md`
- `Second Brain/Operations/Docs/research_software_project_planning_best_practices.md` (companion)
- `Second Brain/Operations/Docs/research_estimation_techniques.md`
