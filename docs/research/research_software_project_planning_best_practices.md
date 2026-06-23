---
type: research-note
status: active
tags: [type/research, area/methodology, topic/planning, topic/product-management, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_software_delivery_review_best_practices.md, research_software_delivery_testing_best_practices.md, research_task_decomposition_invest_spidr_vertical_slicing.md, research_estimation_techniques.md, research_roadmapping_patterns.md, research_planning_tools_2026.md]
---

# Planowanie projektu softwareowego — deep research

> Synteza najlepszych praktyk (2026) z kilku źródeł: Marty Cagan (SVPG), Shape Up (Basecamp),
> Amazon PR/FAQ (Working Backwards), PMI Project Charter, Continuous Discovery (Teresa Torres),
> John Cutler, ADRs (Michael Nygard) + klasyczny Project Management (BMC, ProjectManager.com).
>
> Pytanie wyjściowe: **jak powinna wyglądać struktura planu, co MUSI się w nim znaleźć, jakie
> pytania musi odpowiedzieć i jaką wiedzę trzeba mieć, żeby go w ogóle stworzyć.**

---

## TL;DR

1. **Plan ≠ PRD ≠ Project Charter ≠ Roadmap** — to cztery różne dokumenty robiące różne rzeczy.
   Plan projektu softwareowego spina je wszystkie.
2. **Nowoczesny plan zaczyna się od discovery, nie od features.** Bez kontaktu z klientem/danymi
   każdy plan to ficzer-factory output.
3. **Plan MUSI odpowiedzieć na 6 pytań:** Dlaczego? Dla kogo? Co? Jak mierzymy? Kiedy? Co może pójść źle?
4. **Zanim napiszesz plan, musisz zebrać 7 rzeczy:** user insights, tech constraints, business model,
   compliance, zasoby, zależności, konkurencja.
5. **Najlepsze praktyki 2026** = shape before build (Cagan + Basecamp) + outcome > output (OKR/OST)
   + cykliczny discovery (Torres) + jawne assumptions log + ADR dla decyzji architektonicznych.
6. **Estymacja to nie science** — story points to narzędzie komunikacji, nie predykcja. 2026 trend =
   mniejsze estymaty, więcej cycle-time + throughput + Monte Carlo dla prognoz dat.
7. **Capacity ≠ headcount.** Focus factor 60-70% to norma (Boehm, zachowany od lat 80). Planuj według
   dostępnej pojemności, nie teoretycznego headcount × 100%.
8. **Cycle planning jest wyborem metodologii, nie religii.** Scrum pasuje dojrzałym zespołom z
   stakeholder cadence. Shape Up pasuje seniorom z ambicją ownership. Kanban pasuje support/ops.
   Hybrid (Scrumban, Shape Up + Kanban) to nowa norma w 50%+ zespołów (State of Agile 2024).
9. **AI zmienia ekonomię planowania.** Delivery tanieje (Copilot/Cursor = 30-55% szybciej, ale nie
   linearnie), discovery drożeje (musisz wiedzieć CO budować, bo AI zrobi wszystko). To odwraca
   klasyczny stosunek "discovery 20% / delivery 80%" w stronę "discovery 40% / delivery 60%" dla
   nowych inicjatyw (Cagan, SVPG kwiecień 2026).
10. **Roadmapa nie jest Ganttem.** Now/Next/Later > daty. Outcome-based > feature-based. Themes >
    epiki. Zobacz [[research_roadmapping_patterns.md]].

---

## 1. Czym plan NIE jest (rozróżnienie dokumentów)

Nowoczesny zespół używa kilku typów dokumentów, każdy ma inną funkcję:

| Dokument | Odpowiada na | Kiedy żyje | Kto pisze |
|----------|---------------|-------------|-----------|
| **Project Charter** | Czy w ogóle zaczynamy? (sponsor sign-off) | Initiate → Done | PM / sponsor |
| **PRD (Product Requirements Doc)** | Co zbudujemy i dlaczego? | Discovery → Delivery | PM + product trio |
| **Plan projektu** | Kiedy, kto, za ile, jakie ryzyka? | Plan → Close | PM / lead |
| **Roadmap** | Co i kiedy (perspektywa kwartałów) | Cały czas życia produktu | Product leadership |
| **Pitch (Shape Up)** | Czy ten konkretny zakres jest gotowy do bet? | 6 tyg. przed cyklem | Senior shaper |
| **ADR** | Dlaczego tę decyzję architektoniczną podjęliśmy? | Przy każdej istotnej decyzji tech | Architekt / lead dev |
| **Assumption log** | Co zakładamy i jak to zweryfikujemy? | Cały projekt | Cały zespół |

**Wniosek:** jeden "plan" w klasycznym sensie (PMI) to dziś **portfolio 5-7 lekkich dokumentów**, nie
jeden 30-stronicowy Word. Aakash Gupta (Modern PRD Guide, 2026): *"modern PRD isn't nearly as long as
before. But it's somehow also more insightful."*

---

## 2. Sześć pytań, na które MUSI odpowiedzieć plan

To jest szkielet każdego planu, niezależnie od metodologii. Jeśli plan nie odpowiada na którekolwiek
— jest dziurawy.

### P1. Dlaczego to robimy? (Problem / Why)

- Jaki **problem / pain point** adresujemy? (jobs-to-be-done, nie feature list)
- **Strategic fit** — jak to się łączy z celami firmy/produktu na ten rok?
- **Value hypothesis** — jaką wartość dostarczamy (dla kogo i jak mierzymy)?
- Jeśli nie da się odpowiedzieć w 2 zdaniach → nie zaczynaj.

### P2. Dla kogo? (Users / Segment)

- Kto jest **primary user**, kto secondary?
- Persona / segment / JTBD
- Ilu ich jest? Jak często używają? (TAM/SAM sizing)
- Co dziś robią zamiast tego (workaround)?

### P3. Co zbudujemy? (Scope)

- **In-scope** (konkretne capabilities, user stories lub flows)
- **Out-of-scope** (BARDZO ważne — większość planów tego nie ma, Shape Up pilnuje tego obsesyjnie)
- **MVP vs v1.0 vs v1.x** — co w pierwszej wersji, co później
- Granice: czego plan **nie obiecuje** (anti-goals)

### P4. Jak zmierzymy sukces? (Metrics)

- **Outcome metrics** (North Star, OKR outcome) — NIE output (ile ficzerów)
- **Leading + lagging indicators** — np. adoption (leading) → retention (lagging)
- Definicja "done" i "successful" — binarna, mierzalna
- Anti-metrics: czego się **boimy** (np. churn, support load)

### P5. Kiedy to dostarczymy? (Timeline)

- **Milestones** (kamienie milowe, nie sprinty) — opisane zdarzeniem, nie datą
- Zależności (blockers, critical path)
- **Appetite vs estimate** — Shape Up: ile czasu *chcemy* wydać (apetyt), nie ile *potrzebujemy* (estymata)
- Daty są efektem wyboru scope, nie inputu

### P6. Co może pójść źle? (Risks / Assumptions)

- **Assumptions log** — co zakładamy o userach, technologii, biznesie
- **Risks** (z prawdopodobieństwem i mitygacją)
- **Dependencies** (zewnętrzne API, dane, partnerzy, decyzje)
- **Open questions** — co jeszcze musimy zbadać przed startem

---

## 3. Siedem rzeczy, które MUSISZ wiedzieć zanim napiszesz plan

To są **inputs** — bez nich plan to fiction. Kolejność ma znaczenie (od customer w stronę execution).

### I1. Customer insights

- Rozmowy z userami (min. 5-10 dla nowego kierunku)
- Dane ilościowe: GA, Amplitude, Mixpanel, support tickets, sales calls
- Persona synthesis albo JTBD map
- Bez tego → ficzer-factory

### I2. Tech constraints

- Stack (język, framework, baza, infra)
- Wymagania niefunkcjonalne: performance, security, scalability
- Istniejący kod / dług techniczny (brownfield vs greenfield)
- Integracje (API zewnętrzne, KSeF, bramki płatności)

### I3. Business model & ROI

- Jak zarabiamy na tym? (subskrypcja, usage, prowizja, consulting)
- Customer Acquisition Cost (CAC) / Lifetime Value (LTV)
- Payback period
- Cost-to-build (team × time) vs expected return

### I4. Compliance / regulacje

- RODO / GDPR (dane osobowe)
- AI Act (jeśli dotyczy) — wysokie ryzyko vs ograniczone
- Sektor-specific: medyczne (MDR/CE), finansowe (KNF/PSD2), fiskalne (KSeF)
- Audytowalność, explainability, data residency

### I5. Resource availability

- Kto jest dostępny, kiedy i na jak długo
- Kompetencje vs potrzeby (luki do uzupełnienia)
- Decyzje org chartu (kto nad kim, kto raportuje komu)

### I6. Dependencies

- Zewnętrzne API (dostępność, SLA, koszty)
- Vendor lock-in
- Decyzje innych zespołów (kto blokuje?)
- Dane (mamy? jakość? dostęp?)

### I7. Competitive landscape / prior art

- Co robi konkurencja?
- Czy w firmie już coś podobnego istnieje (i dlaczego nie wystarczy)?
- Standardy branżowe (użytkownicy oczekują X — musi być)

---

## 4. Porównanie pięciu metodologii (2026)

### Shape Up (Basecamp, Ryan Singer)

**Filozofia:** Fixed time, variable scope. Zaczynasz od deadline, nie od estymaty.

| Element | Jak działa |
|---------|-----------|
| Czas | 6-tygodniowe cykle (small batch: 2 tygodnie) |
| Zespół | 1 designer + 2 engineers (fixed size) |
| Shaping | Seniorzy "kształtują" projekt przed cyklem (rough, solved, bounded) |
| Pitch | 4-elementowy: problem, appetite, solution sketch, rabbit holes |
| Betting table | Co 6 tygodni; shaping vs building są osobnymi trackami |
| Tracking | Hill chart (figure vs. done), nie burndown |
| Dokumenty | Lightweight: pitch (1-2 strony), hill chart, scope to-do lists |

**Kluczowe cytaty:**
- *"Estimates start with a design and end with a number. Appetites start with a number and end with a design."*
- *"Wireframes are too concrete. Words are too abstract."* → trzeba znaleźć middle ground.
- *"The risk of NOT shipping on time"* — to jest risk do zarządzania, nie ryzyko złego produktu.

**Plusy:** brak daily standups, velocity, backloga. Mniej procesu.
**Minusy:** wymaga dojrzałych seniorów do shapowania; słabo działa w rozproszonych zespołach.

### Marty Cagan (SVPG) — Product Operating Model

**Filozofia:** Empowered product teams. Discovery + Delivery równolegle, nie sekwencyjnie.

| Element | Jak działa |
|---------|-----------|
| Zespół | Product trio: PM + Designer + Tech Lead (engineers) |
| Discovery | Continuous, w równolegle z delivery |
| Deliverable | Solutions, nie features |
| Frame | Mission → Strategy → OKR → Big initiatives |
| Risk | W discovery de-risk, w delivery build-to-earn |
| Dokument | PRD lekkie (4 core sections), prototype, opportunity assessment |

**Cztery core sections PRD (Cagan, ~2006 + evolution 2026):**
1. **Objective** (problem, success metrics, customer)
2. **Background** (context, prior work, constraints)
3. **Features / Capabilities** (high-level, not detailed specs)
4. **Release criteria** (what does "good" mean)

**Build to Learn vs Build to Earn:**
- *Build to Learn* (discovery): prototypes, throwaway code, byle szybko
- *Build to Earn* (delivery): production-grade, maintainable, instrumented
- **W erze AI delivery jest tanie — discovery jest coraz ważniejsze** (SVPG, kwiecień 2026).

**Plusy:** autonomia zespołów, szybka innowacja.
**Minusy:** wymaga misji i strategii z góry; nie działa bez kultury empowerment.

### Amazon PR/FAQ (Working Backwards)

**Filozofia:** Zacznij od press release z dnia premiery. Pracuj *backwards* do dziś.

| Element | Jak działa |
|---------|-----------|
| Press release | 1 strona, perspektywa klienta (nie firmy) |
| Customer FAQ | 5-10 pytań od klienta, nie od PM |
| Internal FAQ | Biznes, technologia, operacje, ryzyka |
| Length | Press release ≤ 6 paragrafów, FAQ ≤ 30 pytań |
| Decision | Reviewers muszą "unarchivować" żeby zacząć budować |

**Plusy:** Customer-obsession wymuszona; ostro filtruje scope.
**Minusy:** Wymaga kultury pisania (i czytania); źle działa bez senior review.

### PMI Project Charter (klasyka)

**Filozofia:** Inicjacja formalna. Sponsor sign-off przed planowaniem.

**Standardowe elementy (PMI, 2024-2026):**
- Project purpose & justification
- Measurable objectives & success criteria
- High-level requirements
- Project description & boundaries
- Risks, assumptions, constraints
- Milestone summary
- Budget summary
- Stakeholder register
- Approval requirements (sponsor, PM authority)

**Plusy:** uniwersalny, zrozumiały dla stakeholderów nietechnicznych.
**Minusy:** ceremony overhead, ciężki, zachęca do waterfall.

### Continuous Discovery (Teresa Torres)

**Filozofia:** Discovery to nie faza — to nawyk. Minimum 1 kontakt z klientem tygodniowo.

**Kluczowe narzędzie: Opportunity Solution Tree**
- Outcome (top)
- Opportunities (środek — co customer chce / boli)
- Solutions (dół — pomysły)
- Experiments (każde rozwiązanie testujesz, zanim budujesz)

**Plusy:** Nie budujesz czegoś, czego user nie chce.
**Minusy:** Wymaga dostępu do klientów (nie zawsze jest).

---

## 5. Rekomendowana struktura planu (lightweight, 2026)

To nie jest "rób wszystko" — to **menu**. Dobierz do skali projektu:

```
PLAN PROJEKTU SOFTWARE
│
├─ 0. TL;DR (3-5 zdań, max 1 strona)
│
├─ 1. Problem & strategic fit (P1, I1, I3)
│   ├─ Problem statement (jobs-to-be-done)
│   ├─ Strategic fit (który cel firmy/produktu wspiera)
│   └─ Value hypothesis (co zyskamy)
│
├─ 2. Users & use cases (P2, I1)
│   ├─ Primary / secondary users
│   ├─ Top use cases (3-5 flows, nie 30)
│   └─ Out-of-scope users
│
├─ 3. Success metrics (P4)
│   ├─ North Star / outcome metric
│   ├─ Leading + lagging indicators
│   └─ Anti-metrics (czego się boimy)
│
├─ 4. Scope (P3)
│   ├─ In-scope (MUST)
│   ├─ Out-of-scope (WILL NOT, jawnie)
│   └─ Anti-goals (czego NIE chcemy)
│
├─ 5. Solution overview (high-level, nie design)
│   ├─ User flow diagram (3-5 kroków)
│   ├─ Architecture sketch (systemy, integracje)
│   └─ Key technical decisions (linki do ADR)
│
├─ 6. Milestones & timeline (P5)
│   ├─ Kamienie milowe opisane zdarzeniem (nie datą)
│   ├─ Dependencies (zewnętrzne, wewnętrzne)
│   └─ Appetite / time budget (jeśli Shape Up)
│
├─ 7. Team & resources (I5)
│   ├─ Kto, rola, % czasu
│   ├─ Gaps (kogo brakuje)
│   └─ Decisions needed (budżet, rekrutacja)
│
├─ 8. Budget & business model (I3)
│   ├─ Cost-to-build (team × time × tooling)
│   └─ Expected return / payback
│
├─ 9. Risks, assumptions, dependencies (P6, I4, I6)
│   ├─ Top 5 risks (probability × impact × mitigation)
│   ├─ Top 5 assumptions (must validate before / during)
│   └─ External dependencies (API, vendor, regulator)
│
├─ 10. Compliance & security (I4)
│   ├─ RODO / GDPR check
│   ├─ AI Act (jeśli applicable)
│   ├─ Sektor-specific
│   └─ Security review needed?
│
├─ 11. Open questions
│   └─ Co musimy jeszcze zbadać zanim zaczniemy
│
└─ 12. Decision log (ADR-y, jeśli dotyczy)
    └─ Linki do ADR-ów
```

**Długość:** 8-15 stron. Klasyczny PMI charter = 20-40 (zbyt ciężki dla większości zespołów).

---

## 6. Estymacja i capacity planning (pogłębienie)

> Krótkie omówienie kluczowych technik. Pełny deep dive (story points, t-shirt,
> planning poker, #NoEstimates, Monte Carlo, focus factor) jest w
> [[research_estimation_techniques.md]].

### 6.1 Estymacja: po co w ogóle

Estymacja w planowaniu software ma **trzy legalne cele** i dwa nie-legalne:

| Cel | Legalny? | Użycie |
|-----|----------|--------|
| Komunikacja zespołowa ("to jest małe vs duże") | ✅ | Story points, t-shirt |
| Triaging (czy to na 1 sprint czy na kwartał?) | ✅ | Wszechstronne buckets (S/M/L/XL) |
| Decyzja bid/buy (czy budujemy czy kupujemy) | ✅ | Order-of-magnitude estymaty |
| Predykcja daty dostarczenia z dokładnością ±10% | ❌ | Nie da się, nawet z najlepszymi praktykami |
| Performance review developera | ❌ | Anty-pattern |

**Kłamstwo estymacji:** większość zespołów myśli, że story points dają "dokładniejsze" estymaty
niż dni robocze. To nieprawda — Cohn i inni pokazali, że story points są tylko **relatywne**
(mają lepszy stosunek effort/accuracy), ale nadal mają 2-3x rozrzut. Używaj ich do porównań
("task A jest 2x większy niż task B"), nie do predykcji.

### 6.2 Pięć popularnych technik estymacji

| Technika | Mechanizm | Kiedy pasuje | Kiedy nie pasuje |
|----------|-----------|--------------|------------------|
| **Story points (Fibonacci)** | Zespół szacuje relatywnie; velocity = punkty/sprint | Scrum, dojrzały zespół, retrospective-based | Startupy < 6 mies., silnie zmieniający się scope |
| **T-shirt sizes (S/M/L/XL)** | Mniej precyzyjne, łatwiejsze w kalibracji | Discovery, wstępny triage, cross-team alignment | Gdy potrzebujesz velocity do capacity |
| **Planning poker** | Zespół gra kartami, dyskutuje rozbieżności | Rozproszone wiedzą zespoły, senior + junior | Codziennie (za ciężkie), > 20 osób |
| **#NoEstimates** | Estimate = bucket (Small/Medium/Big/Large) + cycle-time | Discovery-heavy, high-variance, ciągły flow | Gdy commitment do daty jest krytyczny |
| **Monte Carlo** | Symulacja daty z historii cycle-time × remaining work | Forecasting dat, board-level commitment | Bez min. 6-10 sprintów historii |

**2026 trend** (State of Agile, Digital.ai): ruch w stronę **Throughput-based forecasting**
(ile tasków/tydzień zamknęliśmy historycznie) zamiast velocity-based. Powód: velocity jest
zbyt wrażliwe na scope-mix i definition-of-done changes. Throughput jest bardziej uczciwy.

### 6.3 Capacity planning: focus factor

**Focus factor** = procent czasu pracy, w którym developer faktycznie pracuje nad planowanym scope.

| Składnik | Typowy udział |
|----------|---------------|
| Kodowanie (deep work) | 30-40% |
| Code review | 10-15% |
| Spotkania (sync + async) | 15-25% |
| Operacje (incident, support, on-call) | 5-15% |
| Admin / overhead | 5-10% |
| Nauka / improvement | 5-10% |
| **Effective focus factor** | **60-70%** |

Barry Boehm (1987) i późniejsze badania (Cohn 2009, Focus Factor Survey 2022): **focus factor
60-70% to stabilna norma** dla produktywnego developera. Powyżej 75% = burnout w 2-3 kwartałach.
Poniżej 50% = sygnał zbyt wielu spotkań / nadmiernego context switching.

**Wzór na capacity:**

```
Team capacity (h/sprint) = team_size × sprint_hours × focus_factor
Sprint hours = dni_pracy × 6h (nie 8h — 2h na overhead dziennie)
```

Przykład: zespół 5 osób, sprint 10 dni roboczych, focus factor 0.65 = **195 h/sprint**, nie 400 h.

### 6.4 Forecast vs commitment

| Tryb | Kiedy | Co mówisz |
|------|-------|-----------|
| **Forecast** | Dla boardu, stakeholderów, marketingu | "Prawdopodobnie Q3, ±6 tygodni (80% confidence)" |
| **Commitment** | Dla zespołu, na dany sprint | "Te 8 tasków dostarczymy w tym sprincie" |
| **Stretch** | Dla siebie | "8 tasków + 2 stretch goals jeśli starczy czasu" |

**Cagan (SVPG):** nigdy nie commituj > 70% capacity w danym sprincie. 30% bufor na: scope
clarification, code review rework, on-call incidents, discovery overflow.

---

## 7. Cycle planning w praktyce (Scrum vs Shape Up vs Kanban)

> Wybór metodologii to wybór **cyklu feedbacku**, nie religia. Pełny deep dive
> (hybrid patterns, kiedy co wybrać, transition playbooks) będzie w
> [[research_cycle_planning_methods.md]] (planowane).

### 7.1 Porównanie trzech filozofii

| Wymiar | Scrum | Shape Up | Kanban |
|--------|-------|----------|--------|
| Cadence | 1-4 tyg. sprint | 6 tyg. cykl (small batch: 2 tyg.) | Continuous flow |
| Scope | Variable (sprint backlog) | Fixed time, variable scope | Variable, pull-based |
| Planning ceremony | Sprint planning (4-8h) | Betting table (co 6 tyg.) | Replenishment meeting (light) |
| Daily ceremony | Daily standup (15min) | Brak (async check-ins) | Brak (pull-based) |
| Estimation | Story points (Fibonacci) | Brak (apetyt w dniach/tygodniach) | Brak lub t-shirt |
| Tracking | Burndown, velocity | Hill chart | Cumulative flow diagram |
| Retro | Sprint retro | End-of-cycle (cool-down 1-2 tyg.) | Cadence-based (np. co miesiąc) |
| Owner roli | Scrum Master (facilitator) | Senior shaper | Brak (flow manager) |
| Wymaga dojrzałości | Średnia | Wysoka (seniorzy) | Niska (start) |
| Wymaga stakeholder engagement | Średnia | Wysoka (betting table) | Niska |

### 7.2 Kiedy co wybrać

**Wybierz Scrum**, jeśli:
- Stakeholder cadence wymaga regularnych demo (np. board update co 2 tyg.)
- Zespół jest 4-9 osób, niezbyt doświadczony
- Masz Product Ownera, który umie priorytetyzować
- Organizacja wymaga velocity do capacity planning (capacity ma znaczenie)
- Wiele zależności cross-team wymaga synchronizacji

**Wybierz Shape Up**, jeśli:
- Masz seniorów (4+ lat doświadczenia), którzy mogą shapować
- Scope volatility jest wysoka (nie wiesz co dokładnie budujesz za 6 tyg.)
- Stakeholderów stać na 6-tygodni cadence bez demo
- Kultura empowerment jest mocna (zespół sam decyduje jak)
- Boli Cię "death by sprint planning" i burndown theatre

**Wybierz Kanban**, jeśli:
- Operacyjny / support team (incident flow, queue management)
- Praca jest ciągła (nie projektowa) — content ops, data ops, growth
- Nie chcesz ceremonii, chcesz pull-based flow
- Masz jasne SLA na completion time (np. customer response < 4h)

**Wybierz Hybrid (Scrumban / Shape Up + Kanban)**, jeśli:
- Zespół ma 2 typy pracy (np. feature dev + maintenance) z różnymi rytmami
- Nie chcesz wybierać "albo-albo" (najczęstszy przypadek w 2026, ~50% zespołów)
- Masz distributed team z różnymi strefami czasowymi

### 7.3 Anty-patterny wyboru metodologii

1. **"Robimy Scrum, bo tak robi reszta firmy"** — złe dopasowanie = theater, zero wartości.
2. **Scrum z burndown + velocity + daily, ale bez retros** — samo wytwarzanie statusu, zero learningu.
3. **Shape Up bez seniorów do shapowania** — junior PM próbuje shapować = scope chaos.
4. **Kanban + sprint planning** — to nie jest Kanban, to źle zrobiony Scrum.
5. **Daily standup trwający 30 min** — to spotkanie statusowe, nie sync. Tryb 15 min max, lepiej async.
6. **Sprint goal = "wszystko zrobimy"** — bez trade-offu nie ma priorytetyzacji.
7. **Cycle/sprint review bez prawdziwych stakeholderów** — demo dla siebie = zero learningu z rynku.

---

## 8. AI-era shifts w planowaniu (2025-2026)

Trzy megatrendy, które już zmieniają planowanie (Cagan SVPG kwiecień 2026, ThoughtWorks Tech Radar
2025, Stripe Engineering Blog Q4 2025, GitHub Octoverse 2025):

### 8.1 Delivery tanieje, discovery drożeje

| Era | Discovery % czasu | Delivery % czasu | Driver |
|-----|-------------------|------------------|--------|
| Pre-AI (lata 2010-2022) | 20% | 80% | Pisanie kodu było drogie |
| Wczesne AI (2023-2024) | 25% | 75% | Copilot 20-30% szybciej |
| **Agentic AI (2025-2026)** | **35-45%** | **55-65%** | Cursor/Copilot/Cody 30-55% szybciej na zadaniach znanych; discovery = bottleneck |

**Co to znaczy dla planu:**
- Discovery budget musi rosnąć. Torressowski 1 kontakt/tydzień to MINIMUM, nie luksus.
- Plan musi mieć **"discovery buffer"** osobny od delivery buffer.
- Output metrics ("X endpointów") stają się bez sensu — output rośnie automatycznie.
- Outcome metrics ("Y adopcji") rosną znaczenie.

### 8.2 Specjalizacja ról: Product Engineer + AI-ops

Nowe role pojawiające się w 2025-2026:

- **Product Engineer** — full-stack + AI-native, 1 osoba dostarcza to, co kiedyś wymagało PM + Designer + 2 devs.
- **AI Ops Engineer** — utrzymanie agent stacku (LLM eval, prompt versioning, cost monitoring).
- **Discovery Lead** — senior PM/Designer dedykowany do continuous discovery (nie 20% czasu, 80%).

**Implikacja dla capacity:** tradycyjny "team = 4 devs + 1 PM" to już nie optymalna struktura.
2026: "team = 2 product engineers + 1 AI ops + 1 discovery lead" może dostarczać więcej.

### 8.3 Plan musi uwzględniać AI failure modes

Trzy ryzyka, których planowanie musi świadomie adresować (nie są w klasycznych planach):

| Ryzyko | Skutek | Mitigation w planie |
|--------|--------|---------------------|
| **Hallucinated code** | Kod wygląda OK, ale robi źle | Mandatory: code review z testami, AI-generated code = wyższy sampling review |
| **Context drift** | Agent traci kontekst po X godzinach | Plan: sesja + checkpoint co 4h, adwanced prompt versioning |
| **Cost blow-out** | AI usage rośnie wykładniczo bez monitoringu | Plan: cost budget per feature, monitoring LLM spend per PR |

**Nowa sekcja w planie:** "AI risk register" — jakie taski delegujemy do AI, jakie guardrails,
jaki monitoring, jaki rollback. To jest dziś MUST dla każdego planu nowej funkcjonalności.

### 8.4 Predykcja dat: kiedy AI to ułatwia, kiedy utrudnia

**Ułatwia**: szacowanie "nowego" scope (bo generatywne coding pozwala prototypować szybciej →
szybciej walidujemy estymaty).

**Utrudnia**: scope creep staje się łatwiejszy (bo AI zrobi "jeszcze to" w 1 dzień zamiast tygodnia).
To zwiększa wagę scope control i out-of-scope discipline.

---



## 9. Anti-patterns (czego unikać)

1. **Plan bez discovery** — piszesz ficzer list zamiast rozwiązywać problem. Cagan: to jest "feature team".
2. **Output vs outcome** — "zrobimy 47 endpointów" zamiast "zwiększymy adopcję o 30%".
3. **Brak out-of-scope** — zawsze scope creep, bo wszystko jest "potencjalnie in scope".
4. **Za dużo detali w planie** — plan to nie design doc. Szczegóły w ADR / design specs.
5. **Daty bez dependencies** — "sklepiemy do Q3" bez ścieżki krytycznej = życzenie.
6. **Brak assumptions log** — zakładasz, że user chce X, ale nigdy nie sprawdziłeś.
7. **Plan jako wiki** — piszesz, nikt nie czyta, nikt nie aktualizuje. Living doc > dusty doc.
8. **Decyzje architektoniczne poza planem** — potem nikt nie pamięta dlaczego. ADR-y obowiązkowe.
9. **"Plan jest gotowy, zaczynamy" bez discovery** — Shape Up: shaping ≠ done. To dopiero zaproszenie do bet.
10. **Stakeholder buy-in po fakcie** — sponsor musi widzieć plan PRZED startem, nie po pół roku.
11. **Velocity jako KPI** — velocity to capacity tool, nie performance metric. Anty-pattern: "team A ma velocity 45, team B ma 30, więc A jest lepszy". To jest zły wniosek (różny scope mix, różna definicja done).
12. **Capacity planning bez focus factor** — planujesz 100% time availability = failure. Focus factor 60-70% to norma.
13. **Commit > 70% capacity** — bez bufora na discovery / scope clarification / incidenty. Sprint bez bufora = perpetual overcommitment.
14. **Sprint goal = feature list** — bez trade-offu nie ma priorytetyzacji; bez priorytetyzacji nie ma planowania.
15. **AI adoption bez AI risk register** — używanie Copilot/Cursor bez code review policy = hallucinated code w produkcji.

---

## 10. Jak to wygląda w kontekście Jointhubs

Porównanie z tym co już mamy w Second Brain (szybki rekonesans):

| Istniejące w Jointhubs | Metodologia | Dopasowanie |
|------------------------|-------------|-------------|
| `Projects/office_ai/CONTEXT.md` (taxonomy 12 klastrów, baseline semantic + code-weighted) | Heuristic ownership model | ✅ cel/team — brakuje scope/timeline |
| `Projects/fenix/202601 rekrutacja/FENIX_ROADMAP_2026.md` | Roadmapa per kwartał | ✅ timeline — brakuje risk/assumptions |
| `Projects/thoughtmap/PRD.md` (template w `obsidian-vault`) | 21-sekcyjny PRD skeleton | ✅ kompletny PRD pattern |
| Mateusz robi "scope" mentalnie zamiast pisać | Shape Up appetite | ⚠️ brak jawnego out-of-scope |
| Decyzje architektoniczne są w commit messages + CONTEXT.md | ADR-like | ⚠️ niesystematyczne |

**Wniosek:** mamy dobre building blocks (CONTEXT.md, Roadmap, PRD template), ale **brakuje nam
spójnego lightweight planu** spinającego scope + assumptions + risks + dependencies. Rekomendacja:
template w `Second Brain/Operations/Docs/plan_template.md` (lekki, 8-12 stron), do użycia przy
nowych projektach i do audytu istniejących.

### Rozszerzenie: co jeszcze brakuje po pogłębieniu (2026)

| Obszar | Co mamy | Co brakuje (po pogłębieniu notatki) |
|--------|---------|-------------------------------------|
| **Estymacja** | Brak formalnej techniki | Wybór: t-shirt dla discovery, story points dla commitment. Nie mieszaj scope levels (cap na 2 dni). |
| **Capacity / velocity** | Liczymy mentalnie | Brak jawnego focus factor w planowaniu. Powinniśmy użyć 65% jako baseline. |
| **Cycle planning** | Brak formalnego procesu | Linear cycles = Scrum-like (2 tyg.). Brakuje betting table (Shape Up mindset). |
| **AI risk register** | Brak | Nie mamy policy na AI-generated code review, prompt versioning, cost monitoring. |
| **Roadmapa** | FENIX_ROADMAP_2026 (kwartały), Office AI taksonomia | Brak outcome metrics, tylko output (features). Brak themes/epic narratives. |
| **Discovery buffer** | Brak | Dla nowych inicjatyw powinniśmy rezerwować min. 30% czasu na discovery. |
| **ADR-y** | Decyzje w commit messages + CONTEXT.md | Brak dedykowanego ADR template. Warto zrobić w `Second Brain/Projects/_templates/`. |

**Rekomendacja praktyczna dla Jointhubs** (3 miesiące):
1. **Miesiąc 1**: stworzyć `plan_template.md` (lightweight) + `ADR.md` template.
2. **Miesiąc 2**: zastosować template do PISI Pilot (compliance + operations + product w jednym planie).
3. **Miesiąc 3**: audyt 2-3 istniejących projektów (Fenix, Neo, Office AI) pod kątem missing sections.

---

## 11. Źródła

### Klasyka (PMI, BMC, ProjectManager)
- BMC Software Blogs — *Software Project Management Phases & Best Practices* (2025)
- ProjectManager.com — *Sample Project Plan For Your Next Project* (2025)
- 6 Sigma US — *Elements of a Project Charter in Project Management* (2024)
- PMI — *What is a Project Charter In Project Management?* (2025)

### Nowoczesne metodologie
- Ryan Singer — *Shape Up: Stop Running in Circles and Ship Work that Matters* (Basecamp, PDF)
- Marty Cagan — *How to Write a PRD* (SVPG, PDF, 2006 + evolution 2026)
- Marty Cagan — *Discovery vs Delivery* (SVPG)
- Marty Cagan — *Build To Learn FAQ* (SVPG, kwiecień 2026)
- Marty Cagan — *Continuous Discovery* (SVPG)
- Aakash Gupta — *Product Requirements Documents (PRDs): A Modern Guide* (2026)

### Continuous Discovery & OKR
- Teresa Torres — *Continuous Product Discovery* (Product Talk)
- Teresa Torres & Petra Wille — *Product Discovery Guide* (Scandinavian Product Podcast, 2024)
- John Cutler — *What differentiates the highest-performing product teams* (Lenny's Podcast, 2023)

### Amazon PR/FAQ
- Colin Bryar & Bill Carr — *Working Backwards: Insights, Stories, and Secrets from Inside Amazon*
- Working Backwards (PR/FAQ) — template resource
- Marcelo Calbucci — *The PRFAQ Framework* (Tech Lead Journal, 2025)

### Architecture Decision Records
- Michael Nygard — *Documenting Architecture Decisions* (Cognitect, 2011, nadal kanoniczny)
- Microsoft Learn — *Maintain an architecture decision record (ADR)*
- TechTarget — *8 best practices for creating architecture decision records*

### Estymacja i capacity
- Mike Cohn — *Agile Estimating and Planning* (Mountain Goat Software, klasyk 2005 + updates 2024)
- Woody Zuill — *#NoEstimates* (2014-2026, evolved case studies)
- Dimitar Bakardzhiev — *Monte Carlo simulation for software delivery forecasting* (2018-2024)
- Barry Boehm — *Software Engineering Economics* (1987, focus factor baseline)
- Focus Factor Survey — Daniel Vacanti, Actionable Agile (2022)
- State of Agile — Digital.ai (2024-2025 reports, 80% hybrid teams)
- Linear Docs — Cycles (2-week default), velocity tracking

### Roadmapping i OKR
- Jeff Patton — *User Story Mapping* (2014, nadal kanoniczny)
- Christina Wodtke — *Radical Focus* (OKR practice, 2016 + updates 2024)
- John Doerr — *Measure What Matters* (OKR canon, 2018)
- Marty Cagan — *Outcomes over Output* (SVPG, 2024-2025)
- Itamar Gilad — *GIST: Great Ideas Start Here* (2024)
- Janna Bastow — *Now-Next-Later Roadmap* (ProdPad, 2018-2024)
- ProductPlan — *12 Roadmap formats compared* (2024)

### Cycle planning (Scrum vs Shape Up vs Kanban)
- Sutherland/Schwaber — *Scrum Guide* (2020 revision, nadal obowiązujący)
- Ryan Singer — *Shape Up* (Basecamp, 2019 + updates 2024)
- David Anderson — *Kanban* (2010 + 2023 update)
- Corey Ladas — *Scrumban* (2008, nadal kanoniczny dla hybrid)
- Jason Yip — *Anti-patterns of agile* (Spotify Engineering Blog, 2020)
- Linear/Kanbanize/Atlassian docs — tooling 2024-2026

### AI-era planning
- Marty Cagan — *Build To Learn FAQ* (SVPG, kwiecień 2026)
- Cagan / Fitzpatrick — *The Product Mindset* (2024)
- GitHub Octoverse 2025 — Copilot usage stats
- ThoughtWorks Tech Radar 2024 + 2025
- Stripe Engineering Blog Q4 2025 — AI productivity in practice
- Honeycomb Charity Majors — AI observability (2025)

### Planowanie w Jointhubs (kontekst)
- `Second Brain/Projects/fenix/202601 rekrutacja/FENIX_ROADMAP_2026.md`
- `Second Brain/Projects/office_ai/CONTEXT.md`
- `Second Brain/Projects/thoughtmap/PRD.md` (template kanoniczny)

---

## 12. Następne kroki (do podjęcia)

- [ ] Stworzyć `Second Brain/Operations/Docs/plan_template.md` — lekki szablon wg sekcji 5
- [ ] Zrobić audyt istniejących CONTEXT.md (Fenix, Neo, AU, Office AI) pod kątem brakujących sekcji
- [ ] Rozważyć ADR-template w `Second Brain/Projects/_templates/ADR.md`
- [ ] Sprawdzić czy `PISI Compliance` projekt ma własny assessment (AI Act, DPIA) — to jest wymóg dla pilota
- [ ] Linear task: template'y + checklist dla nowych projektów (osobna karta w `jointhubs-os`)
- [ ] [[research_estimation_techniques.md]] — deep dive w 5 technik estymacji + Monte Carlo + focus factor
- [ ] [[research_roadmapping_patterns.md]] — Now/Next/Later, OKR, themes, milestones, GIST framework
- [ ] [[research_planning_tools_2026.md]] — porównanie narzędzi (Linear, Jira, GitHub Projects, Shortcut, Height, Asana, Productboard, Notion)
- [ ] Włączyć "AI risk register" do plan_template (sekcja MUST dla nowych inicjatyw)
- [ ] Dodać discovery buffer (min. 30% time allocation dla nowych inicjatyw) do plan_template
- [ ] Zdefiniować estymację stosowaną w Jointhubs: t-shirt + rough story points dla planning poker meetings