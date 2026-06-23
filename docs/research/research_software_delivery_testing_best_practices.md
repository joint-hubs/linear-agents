---
type: research-note
status: active
tags: [type/research, area/methodology, topic/engineering, topic/testing, topic/quality, topic/ci-cd, topic/delivery, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_engineering_task_description_best_practices.md, research_task_decomposition_invest_spidr_vertical_slicing.md, research_reducing_developer_cognitive_load.md, research_software_delivery_review_best_practices.md, research_software_project_planning_best_practices.md]
---

# Software delivery testing — deep research

> Piąta notatka z serii o planowaniu i dowozie w software (po planowaniu
> projektu, anatomii tasków, dekompozycji, cognitive load, review).
> Ta odpowiada na pytanie: **jak kompleksowo testować kod i delivery
> przed wdrożeniem na produkcję** — żeby maksymalnie odciążyć developerów,
> wykrywać błędy w najtańszym możliwym miejscu, i jednocześnie zachować
> szybkość delivery.
>
> Nacisk na **delivery kodu przed produkcją** — nie tylko "unit testy",
> ale pełen łańcuch: od commita, przez CI/CD, po canary release i
> monitoring w produkcji.
>
> Źródła: Mike Cohn (Testing Pyramid, 2009), Kent C. Dodds (Testing
> Trophy, 2018), Martin Fowler (TestPyramid, Continuous Delivery),
> Charity Majors (Observability Engineering, testing in production),
> Gene Kim/Jez Humble/Patrick Debois (DevOps Handbook, The Visible Ops
> Handbook), Nicole Forsgren (Accelerate, DORA), Google Engineering
> Practices (code review, testing at scale), Spotify (QA in a CI/CD
> world), Netflix (chaos engineering, canary), Basecamp (Shape Up),
> Pact/contract testing docs, OWASP (security testing), MDN/WCAG
> (accessibility testing), ThoughtWorks Tech Radar (2025), Stripe
> (testing at scale), CircleCI / GitHub Actions / GitLab CI docs,
> Grafana / Datadog / Honeycomb docs, Harness / LaunchDarkly /
> Split.io (progressive delivery), Stryker / PIT (mutation testing),
> k6 / Gatling (performance), Playwright / Cypress (e2e), Pact
> (contract), Trunk.io / CodeRabbit / Qodo (AI-assisted testing).

---

## TL;DR

1. **Testowanie delivery to nie unit testy. To łańcuch decyzji i bramek** od commita do produkcji, które minimalizują ryzyko w najtańszym możliwym miejscu. Cel: każda warstwa łapie to, co potrafi najlepiej, i przekazuje wyżej tylko to, czego nie umie sama zweryfikować.

2. **Testing Pyramid vs Testing Trophy — w 2026 nie ma jednej odpowiedzi.** Pyramid (Cohn, 2009) → dużo unit, mniej integracji, mało E2E. Trophy (Dodds, 2018) → mało unit, dużo integracji (sweet spot), trochę E2E i statycznej analizy. Trophy wygrywa w aplikacjach frontendowych i systemach z realnym I/O. Pyramid wygrywa w bibliotekach, algorytmach, mikroserwisach bez UI. **Dobierz do kontekstu — nie kopiuj.**

3. **Shift-left + shift-right to continuum, nie opozycja.** Shift-left = testuj wcześnie (static analysis, unit, contract). Shift-right = testuj w produkcji (canary, chaos, observability, RUM). Najlepsze zespoły łączą oba. **Pre-produkcja to 70-80% budżetu testów, produkcja to 20-30%, ale ten 20-30% łapie 50-70% realnych bugów** (szacunki z Capgemini WQR i Honeycomb case studies).

4. **Nowoczesny CI/CD pipeline (2026) ma 5-7 quality gates:**
   - pre-commit (lint, format, secrets scan)
   - PR-level (unit, integration, contract, mutation na krytycznych ścieżkach)
   - merge to main (full test suite + SAST/SCA + preview environment)
   - staging deploy (E2E + perf smoke + DAST)
   - canary (5% ruchu, obserwacja metryk, auto-rollback)
   - 100% rollout (continuous validation w produkcji)
   - post-incident (chaos testing + retro)

5. **Trzy filary nowoczesnego quality engineering:**
   - **Specjalizowane testy** (contract, mutation, perf, security, accessibility, visual regression) — każdy łapie klasę błędów, której inne nie złapią
   - **Progressive delivery** (feature flags, canary, blue/green, dark launches) — deploy ≠ release, mierzenie przed pełnym rolloutem
   - **Observability-driven testing** (SLO/error budgets, RUM, distributed tracing) — testowanie staje się ciągłą walidacją hipotez w produkcji

6. **AI-augmented testing (2025-2026) daje 30-50% przyspieszenia** generowania test cases i code review, ale nie zastępuje ludzkiej decyzji architektonicznej. AI jest **first-line filter** (łapie trywialne błędy, sugeruje edge cases, generuje boilerplate), nie **gatekeeper** (ostateczna decyzja = człowiek + obserwacja produkcji).

7. **Największe anty-patterny w testowaniu delivery:**
   - **Test theatre** — testy istnieją, ale niczego nie walidują (assertions na typ zwracany zamiast na wartość, snapshoty na markup zamiast na zachowanie)
   - **Coverage jako KPI** — 80% coverage ≠ jakość; lepsza miara to mutation score
   - **E2E-heavy** — poleganie na kruchych testach browserowych zamiast na tanich integracjach
   - **LGTM na merge** bez smoke w stagingu
   - **Brak observability = testowanie w ciemno** — nie wiesz, które ścieżki są realnie używane przez userów

---

## 1. Czym jest testowanie delivery (a czym nie jest)

### Definicja robocza

**Software delivery testing** = **kompletny łańcunek walidacji**, który sprawdza, że kod dostarczony do użytkownika:
- **Działa poprawnie** — spełnia specyfikację, AC, edge cases
- **Jest bezpieczny** — nie wprowadza podatności ani wycieków danych
- **Jest performantny** — nie łamie SLO pod obciążeniem
- **Jest dostępny** — dla użytkowników z niepełnosprawnościami
- **Nie łamie istniejących ścieżek** — regresja, contract drift, data corruption
- **Jest obserwowalny** — wiemy co się dzieje gdy user go używa

To nie jest to samo co "QA" ani "unit testy". To **system**, w którym każda warstwa ma swoją odpowiedzialność i swoje ograniczenia.

### Czym testowanie delivery NIE jest

| Mylenie | Dlaczego to szkodliwe |
|---------|----------------------|
| Testing = pisanie testów | Testy to tylko jeden element; ważniejsze są bramki, środowisko, dane, obserwacja |
| Testing = QA team | W nowoczesnym delivery QA towarzyszy developerowi, nie jest osobnym silosem |
| Testing = coverage % | Coverage mierzy ile linijek jest dotykanych, nie czy są poprawnie walidowane |
| Testing = pre-merge | Po merge też testujemy (canary, chaos, RUM); produkcja to nie koniec, to początek |
| Testing = pewność 100% | Niemożliwe i niepożądane; testy dają **confidence level**, nie certainty |
| Testing = automatyzacja | Automatyzujemy powtarzalne, ale eksploracja i heurystyka dalej są ludzkie |

### Dlaczego testowanie delivery w ogóle

- **Accelerate (DORA)** — deployment frequency, lead time, change failure rate, MTTR są skorelowane z **jakością testów**, nie z ich ilością. Zespoły "Elite" mają krótszy change lead time i niższy change failure rate właśnie dlatego, że testują mądrzej, nie więcej.
- **Google's testing research** — w Google'u stosunek unit : integration : E2E wynosi **80:15:5** dla typowej aplikacji. Nie dlatego, że unit testy są najlepsze, ale dlatego, że są najszybsze i najtańsze w utrzymaniu.
- **Charity Majors (observability + testing in production)** — **jedynym sposobem na pewność jest obserwacja w produkcji**. Testy pre-prod dają confidence, ale prawda jest w metrykach z realnych użytkowników.
- **Capgemini World Quality Report 2024-2025** — **>50% QA leaderów** uważa, że tradycyjne testowanie missuje kluczowe ryzyka produkcyjne. To jest główny driver shift-right.

---

## 2. Testing Pyramid vs Testing Trophy — wybór frameworku

To jest **decyzja architektoniczna**, nie dogmat. Wybór wpływa na koszty utrzymania, szybkość feedbacku i klasę wykrywanych błędów.

### Pyramid (Mike Cohn, 2009)

```
        /\
       /  \
      / E2E\        ← mało, wolne, kruche
     /------\
    /  Integ \
   /----------\
  /    Unit    \    ← dużo, szybkie, tanie
 /--------------\
```

**Założenia**: dużo unit testów (60-80%), mniej integracyjnych (15-25%), mało E2E (5-10%). Fundament: **speed + cost of maintenance**.

**Kiedy wygrywa**:
- Biblioteki, frameworki, algorytmy (logika biznesowa jest w funkcjach, nie w integracjach)
- Mikroserwisy bez UI (HTTP contract testing dominuje)
- Systemy embedded / real-time (pełna kontrola środowiska)
- Kod bez zewnętrznych zależności (pure functions, deterministic)

**Kiedy przegrywa**:
- Aplikacje z realnym I/O (DB, HTTP, kolejki, pliki)
- Frontend z dużą liczbą komponentów (mockowanie propsów = fałszywa pewność)
- Systemy z wieloma integracjami (mikroserwisy, third-party APIs)

### Trophy (Kent C. Dodds, 2018)

```
       🏆
      /  \
     / E2E\        ← trochę, smoke + happy paths
    /------\
   /Integration\   ← dużo, sweet spot
  /------------\
 /  Unit (mniej) \  ← mniej niż pyramid mówi
/------------------\
   Static (lint,    ← najniższa warstwa: typy, format, security
   types, format)
```

**Założenia**: integracja (w rozumieniu "testy z realnymi modułami, ale bez pełnego stacka") to sweet spot — daje confidence i niski koszt. Statyczna analiza na samym dole.

**Kiedy wygrywa**:
- Frontend (React/Vue/Svelte) — komponenty mają dużo interakcji
- Backend z DB / cache / queue — testy powinny ruszać prawdziwe (lub testcontainers) komponenty
- Aplikacje z logiką biznesową rozproszoną między warstwami

**Kiedy przegrywa**:
- Performance-critical systems (unit + microbenchmarks ważniejsze niż integracja)
- Algorithmic code (sorting, parsowanie, kompresja)

### Praktyczny wybór

| Typ systemu | Rekomendowany framework |
|-------------|-------------------------|
| Biblioteka / SDK / algorytm | Pyramid (heavy unit) |
| Frontend SPA | Trophy (heavy integration) |
| Backend API z DB | Trophy (unit na domenie + integration na reszcie) |
| Mikroserwisy (HTTP) | Pyramid + Contract testing (Pact) |
| Mobile app | Trophy (testy UI na ViewModels, E2E smoke) |
| Real-time / embedded | Pyramid + hardware-in-loop tests |
| ML pipeline | Trophy (integration na data flow, unit na model components) |

**Nie bój się hybrydy.** Realne systemy mają kilka komponentów — każdy może mieć inny framework.

---

## 3. CI/CD Quality Gates — łańcunek bramek

Nowoczesny pipeline to **sekwencja bramek**, nie jedno "testy przed mergem". Każda bramka ma swój czas, koszt i decyzję do podjęcia.

### Standardowy pipeline (2026)

```
┌──────────────┐
│ local commit │ ← pre-commit hook: lint, format, secrets
└──────┬───────┘
       ▼
┌──────────────┐
│  push to PR  │ ← unit + integration + contract + coverage gate
└──────┬───────┘
       ▼
┌──────────────┐
│ PR review    │ ← AI-assisted review (Copilot/CodeRabbit) + human
└──────┬───────┘
       ▼
┌──────────────┐
│ merge main   │ ← full test suite + SAST + SCA + mutation (nightly)
└──────┬───────┘
       ▼
┌──────────────┐
│ ephemeral env│ ← preview environment per PR / branch
└──────┬───────┘
       ▼
┌──────────────┐
│ staging      │ ← E2E + perf smoke + DAST + accessibility
└──────┬───────┘
       ▼
┌──────────────┐
│ canary       │ ← 1-5% ruchu, observability SLO, auto-rollback
└──────┬───────┘
       ▼
┌──────────────┐
│ 100% rollout │ ← continuous validation, chaos testing, RUM
└──────────────┘
```

### Co na której bramce

| Bramka | Czas | Co się robi | Co NIE powinno tu być |
|--------|------|-------------|------------------------|
| **pre-commit** | <5s | Lint, format, secret scan, type check | Testy runtime |
| **PR-level** | <5min | Unit, integration (testcontainers), contract (Pact), coverage diff | E2E browserowe |
| **merge main** | <15min | Full test suite + SAST (SonarQube/Snyk) + SCA (Snyk/Dependabot) | Mutation (za wolne, przenieś do nightly) |
| **staging deploy** | <30min | E2E smoke + perf smoke (k6/Gatling) + DAST (OWASP ZAP) + a11y (axe-core) + visual regression (Percy/Chromatic) | Pełna macierz E2E (za długo) |
| **canary** | 1-24h | 1-5% ruchu, obserwacja error rate / latency / sat, auto-rollback jeśli SLO breach | Testy (tu już nie testujemy, tu obserwujemy) |
| **nightly** | ~1h | Mutation testing (Stryker/PIT), pełna macierz E2E, perf load tests, fuzz testing | Codzienny deploy (zbyt długo) |
| **weekly** | ~24h | Security scan (pełny OWASP), dependency audit, chaos engineering game day, contract drift report | - |

### Kluczowa zasada: **każda bramka ma być szybka**

Jeśli PR-level trwa 30min, developerzy omijają ją, robią force push, ignorują wyniki. **Cel: PR feedback <5min, merge feedback <15min, staging feedback <30min.** Reszta to nightly/weekly.

---

## 4. Specjalizowane typy testów — każdy łapie inną klasę błędów

Nie ma jednego "testu". Są testy wyspecjalizowane do konkretnych klas problemów.

### 4.1 Unit + Mutation testing

**Unit testy** sprawdzają, że funkcja zwraca oczekiwany wynik dla danego inputu. **Mutation testing** sprawdza, czy test faktycznie waliduje zachowanie — bo inaczej testy zielone nie znaczą nic.

Przykład: masz `function add(a, b) { return a + b; }` i test `expect(add(2,3)).toBe(5)`. Coverage 100%, ale mutation testing wprowadza `return a - b` i test dalej przechodzi? Nie (bo 2-3 ≠ 5). Ale jeśli masz `function isAdult(age) { return age >= 18; }` i test `expect(isAdult(25)).toBe(true)`, mutation `return age > 18` → test dalej zielony, ale edge case (age = 18) przejdzie błędnie.

**Mutation score** = % mutantów zabitych przez testy. Cel: **70-85%** na krytycznych ścieżkach (auth, payments, security).

| Tool | Język | Szybkość |
|------|-------|----------|
| Stryker | JS/TS, .NET, Scala | Średnia (5-30min) |
| PIT | Java | Średnia |
| mutmut | Python | Szybka |
| cosmic-ray | Python | Wolna |

**Kiedy stosować**: na krytycznych ścieżkach (auth, payments, data integrity). Nie na UI ani na CRUD.

### 4.2 Integration + Contract testing

**Integration testy** sprawdzają, że moduły ze sobą współpracują (DB + serwis, HTTP + auth, kolejka + consumer).

**Contract testing** sprawdza, że **kontrakt między dwoma serwisami jest spełniony** bez odpalania obu naraz. Provider zobowiązuje się do kontraktu (np. "POST /users zwraca 201 z body {id, email}"), consumer deklaruje oczekiwania ("potrzebuję pola email"). Pact broker weryfikuje, czy obie strony są zgodne.

**Dlaczego contract testing > integracja w mikroserwisach**:
- Tradycyjna integracja: odpal cały stack → kosztowne, wolne, kruche
- Contract: provider testuje swój kontrakt (szybkie), consumer testuje swój konsumer (szybkie), Pact broker zapewnia kompatybilność (centralnie)
- **Redukuje 60-80% testów integracyjnych** przy zachowaniu pewności (Tweag, 2025)

Przykłady:
- **Pact** (JS, JVM, Python, Go, .NET) — najpopularniejszy
- **Schema-based** (OpenAPI/Spectral, GraphQL schema) — lżejszy, tylko kształt
- **Spring Cloud Contract** (JVM) — alternatywa dla Pact

### 4.3 E2E + Ephemeral environments

**E2E testy** sprawdzają pełną ścieżkę użytkownika. Są **najdroższe i najkruchsze**, ale dają najwyższą pewność dla krytycznych flow.

**Ephemeral environments** (preview environments) = **izolowane środowisko per PR/branch**, produkcyjne pod każdym względem (DB, cache, external services), żyje godziny-dni, potem znika.

Workflow:
1. PR otwarty → CI tworzy ephemeral env
2. URL env dostępny dla QA / PM / design
3. Testy E2E odpalane na tym env
4. Po merge env zniszczony

Narzędzia: Qovery, Shipyard, Bunnyshell, Render (preview), Vercel (preview), Kubernetes + ArgoCD.

**Reguła**: E2E tylko na **happy paths + smoke critical paths**. Nie na pełną macierz kombinatoryczną (za wolne, za kruche). Edge cases → integration + unit.

### 4.4 Performance testing

| Typ | Co mierzy | Kiedy |
|-----|-----------|--------|
| **Smoke** | Czy w ogóle działa pod minimalnym obciążeniem | Każdy deploy do staging |
| **Load** | Czy spełnia SLO przy nominalnym ruchu | Każdy release |
| **Stress** | Gdzie się łamie | Pre-black-friday, pre-major-launch |
| **Spike** | Jak reaguje na nagły wzrost | Konkretne scenariusze (Black Friday, kampania) |
| **Soak** | Czy wycieki pamięci / degradacja po 24h+ | Tygodniowo na staging |

**Narzędzia**: k6 (JS, lekkie, skryptowalne), Gatling (JVM/Scala, scenariusze), Locust (Python), JMeter (Java, klasyk), Artillery (Node).

**Output**: percentyle (p50, p95, p99), error rate, throughput. **NIE średnia** — średnia ukrywa outliers.

### 4.5 Security testing

| Typ | Co łapie | Kiedy |
|-----|----------|--------|
| **SAST** (Static Application Security Testing) | SQL injection, XSS, hardcoded secrets w kodzie | Każdy PR + nightly |
| **SCA** (Software Composition Analysis) | Znane podatności w dependencies | Każdy PR + weekly |
| **DAST** (Dynamic Application Security Testing) | Runtime vulnerabilities (auth bypass, injection) | Staging per release |
| **Secret scan** | Klucze API, hasła w kodzie/git history | Pre-commit + commit history |
| **Container scan** | Podatności w Docker images | Każdy build |
| **IaC scan** | Błędna konfiguracja Terraform/CloudFormation | Każdy PR infra |

**Narzędzia**: Snyk, Semgrep, Trivy, OWASP ZAP, SonarQube, GitGuardian, Checkov.

### 4.6 Accessibility testing

WCAG 2.2 AA to standard. Testy a11y dzielą się na:
- **Automated** (axe-core, Lighthouse, Pa11y) — łapie 30-50% problemów (color contrast, ARIA, alt text)
- **Manual** (screen reader users, keyboard navigation) — łapie resztę

**Reguła**: każdy release musi przejść axe-core scan z 0 critical violations. Manual test raz na sprint na kluczowych flow.

### 4.7 Visual regression testing

**Pixel-perfect comparison** screenshotów UI. Narzędzia: Percy, Chromatic (Storybook), Applitools, BackstopJS.

**Kiedy**: duże redesigny, design system changes, komponenty UI library. **NIE co PR** — za dużo szumu.

### 4.8 Fuzz testing

Generowanie losowych / malformed inputs do API i obserwacja, czy się crashuje. Narzędzia: AFL, libFuzzer, boofuzz, RESTler.

**Kiedy**: parsery, API publiczne, security-critical components.

---

## 5. Progressive Delivery — deploy ≠ release

Nowoczesny model: **deployment (kod trafia na produkcję) i release (użytkownicy go widzą) to dwie osobne rzeczy**. Dzięki temu możemy:
- Deployować często (CI/CD wymaga)
- Release'ować ostrożnie (zgodnie z gotowością biznesową / confidence)

### 5.1 Feature flags

**Feature flag** = if/else w kodzie sterowany zdalnie. Pozwala na:
- **Toggle on/off** bez deployu
- **Targeted rollout** (% userów, konkretne kraje, internal users, beta testers)
- **A/B testing** (random assignment + metryki)
- **Kill switch** (szybkie wyłączenie problematycznej funkcji)

Narzędzia: LaunchDarkly, Split.io, Flagsmith, Unleash, Statsig, open-source: Unleash, Flagsmith.

**Anty-pattern: DIY feature flags** (if'y w kodzie z env vars) — działa na początku, ale:
- Brak centralnego audytu (kto co włączył, kiedy)
- Brak gradual rollout (tylko binary)
- Brak A/B testing
- Brak cleanup (martwy kod się akumuluje)

Harness research (2025): zespoły z DIY flagami mają **3x więcej martwego kodu** po 12 miesiącach niż te z dedykowaną platformą.

### 5.2 Canary release

**Canary** = wdrożenie nowej wersji na **1-5% ruchu** z automatyczną obserwacją metryk i rollback jeśli SLO zostanie naruszone.

Workflow:
1. Nowa wersja wdrożona, ruch kierowany w 1-5%
2. Metryki porównywane (error rate, latency, throughput, sat signals)
3. Jeśli OK → 10% → 25% → 50% → 100%
4. Jeśli degradation → auto-rollback do starej wersji

Narzędzia: Argo Rollouts, Flagger, Spinnaker, Harness CD, Kubernetes-native.

**Kluczowe SLO do obserwacji**:
- Error rate (5xx, application errors)
- Latency (p95, p99)
- Throughput (RPS)
- Saturation (CPU, memory, queue depth)
- Business metrics (conversion, retention) — bardziej advanced

### 5.3 Blue/Green deployment

**Blue/Green** = dwa identyczne środowiska (blue = obecna wersja, green = nowa). Load balancer przełącza ruch atomowo.

**Zalety**: zero downtime, instant rollback.
**Wady**: 2x koszt infrastruktury, schema migrations trudne, database rollback problem.

**Kiedy**: systemy o wysokim SLO (99.99%+), bazy danych są łatwe do koordynacji.

### 5.4 Dark launch

**Dark launch** = nowa wersja dostaje ruch produkcyjny, ale **zwraca starą odpowiedź** do użytkownika. Pozwala załadować nowy kod, sprawdzić performance, zebrać metryki — bez ryzyka dla usera.

**Kiedy**: migracje (np. nowy ML model), expensive computations, third-party API replacements.

### 5.5 Porównanie strategii

| Strategia | Rollout | Rollback | Koszt infra | Kiedy |
|----------|---------|----------|-------------|-------|
| **Feature flag** | Sub-second | Sub-second | Niski | Drobne zmiany, A/B testy |
| **Canary** | Minuty-godziny | Sekundy | Średni (2 wersje) | Refactor, performance changes |
| **Blue/Green** | Atomowy | Atomowy | Wysoki (2x infra) | Schema migrations, big releases |
| **Dark launch** | N/A (nowa wersja nieaktywna) | N/A | Średni | Performance validation |

**Nie wybieraj jednej strategii — mieszaj**. Feature flags dla user-facing toggles, canary dla infra/refactor, blue/green dla database migrations.

---

## 6. Observability-driven testing — testowanie w produkcji

Cytat Charity Majors: **"Testing in production is not YOLO. It's the highest form of rigor."**

### 6.1 Filary observability

Trzy (a właściwie cztery, po rewizji Majors 2025) sygnały:
- **Metrics** — agregaty (counters, gauges, histograms)
- **Logs** — zdarzenia z kontekstem
- **Traces** — przepływ przez system (distributed tracing)
- **Wide structured events** — high-cardinality, kontekstowe (Honeycomb model, 2025)

**Tradycyjne "trzy filary" (metrics/logs/traces) są niewystarczające**, bo ukrywają high-cardinality data. Nowe podejście (Majors, OpenTelemetry): **wide events** z pełnym kontekstem (user_id, request_id, build_sha, feature_flag_state, db_query, etc.) — pozwalają na debugowanie konkretnych ścieżek w konkretnych warunkach.

### 6.2 Real User Monitoring (RUM)

**RUM** = metryki z realnej sesji użytkownika w przeglądarce/mobile. Obejmuje:
- Core Web Vitals (LCP, FID/INP, CLS)
- JavaScript errors (uncaught exceptions)
- API calls (success rate, latency)
- User flows (konwersja, drop-off)

Narzędzia: Datadog RUM, New Relic Browser, Sentry, Honeycomb, OpenTelemetry + własna wizualizacja.

### 6.3 Synthetic monitoring

**Synthetic** = bot odpala krytyczne flow co X minut z różnych lokalizacji. Pozwala wykryć awarię zanim user ją zobaczy.

**Różnica vs RUM**:
- RUM = prawdziwi userzy (ale nie widzisz problemów, dopóki user nie trafi na ścieżkę)
- Synthetic = symulowane flow (widzisz awarię natychmiast, ale nie pokrywasz 100% ścieżek)

**Oba potrzebne**. Synthetic dla krytycznych flow, RUM dla wszystkiego innego.

### 6.4 SLO / Error budgets

**SLO** (Service Level Objective) = cel, np. "99.9% requestów zakończonych w <500ms w ciągu 30 dni".
**Error budget** = (1 - SLO) × total requests = ile możesz sobie pozwolić na awarię.

**Zastosowanie w testowaniu**: jeśli error budget się wyczerpuje, **zwalniasz deploy** i priorytetyzujesz stabilizację. To daje obiektywną granicę "ile ryzyka możemy podjąć".

### 6.5 Chaos engineering

**Chaos engineering** = kontrolowane wprowadzanie awarii (kill servera, latency na DB, network partition) do testowania, czy system się broni.

Narzędzia: Chaos Monkey (Netflix), Gremlin, Litmus (K8s), AWS Fault Injection Service.

**Zasady**:
- Zaczynaj w staging, nie w produkcji
- Małe blast radius (1% ruchu / 1 region)
- Stop the experiment jeśli wpływ wykracza poza hipotezę
- **Game day** raz na kwartał: zespół symuluje scenariusz i uczy się reagować

---

## 7. AI-augmented testing — co działa, co nie

### 7.1 Klasy narzędzi

| Kategoria | Przykłady | Co robi | Skuteczność |
|-----------|-----------|---------|-------------|
| **Test generation** | Qodo/CodiumAI, CodiumAI TestGPT, Meticulous | Generuje test cases z kodu / AC | 30-50% przyspieszenie pisania |
| **Code review** | CodeRabbit, Sourcery, Copilot Code Review, Qodo Merge | Komentuje PR, łapie proste błędy | Łapie 42-48% real bugs (AST analysis) |
| **E2E maintenance** | Mabl, Testim, Reflect | Self-healing selectors | Redukuje 60-80% maintenance |
| **Visual regression** | Applitools Eyes (AI-powered) | Ignoruje prawdziwe zmiany, łapie anomalie | Redukuje false positives 70%+ |
| **Mutation testing** | StrykerAI, AI-assisted | Wybiera ważne mutanty | 2-3x szybsze niż brute-force |
| **Test triage** | Datadog Test Optimisation, Launchable | Priorytetyzuje które testy odpalić na danym PR | Skraca pipeline 40-70% |

### 7.2 Gdzie AI wygrywa

- **Bulk test generation** — boilerplate, happy paths, edge cases z list
- **First-pass PR review** — wyłapuje proste błędy zanim człowiek spojrzy
- **Test prioritization** — wybiera 10% testów, które łapią 80% bugów (impact analysis + history)
- **Self-healing E2E** — nie łamie się na zmianie CSS / selektora
- **Log analysis** — korelacja błędów z deployments, anomaly detection

### 7.3 Gdzie AI przegrywa (jeszcze)

- **Architektural decisions** — czy ten serwis powinien istnieć, czy to jest prawidłowy contract
- **Business logic validation** — czy ten warunek pokrywa realne wymagania biznesowe
| **Exploratory testing** — heurystyczne szukanie dziur, których nikt nie pomyślał
- **UX failures** — "ten przycisk jest niewidoczny na telefonie" wymaga ludzkiego oka

### 7.4 AI jako first-line filter (nie gatekeeper)

Najlepsze praktyki 2026:
- AI review → łapie 40-50% trywialnych błędów, developer ma mniej do poprawiania
- Human review → skupia się na architekturze, biznesie, security
- **Nigdy**: AI auto-merge bez ludzkiej weryfikacji na krytycznych ścieżkach

---

## 8. Anti-patterns w testowaniu delivery

8 anty-patternów, z których każdy zabija kulturę inaczej:

### 8.1 Test theatre (testy istnieją, niczego nie walidują)

Symptomy:
- `expect(result).toBeDefined()` zamiast `expect(result.value).toBe(42)`
- Snapshot test na całym komponencie (przy każdej zmianie kosmetycznej trzeba aktualizować)
- 100% coverage, ale testy asertują tylko wywołanie funkcji, nie wynik
- Mocki na wszystko, włącznie z logiką biznesową (test nic nie testuje poza wiringiem)

**Fix**: mutation testing na krytycznych ścieżkach. Jeśli mutation score <70%, testy nie walidują.

### 8.2 Coverage jako KPI

Symptomy:
- "Mamy 80% coverage" → zielony badge w dashboardzie
- Ale testy są trywialne, mutation score = 30%
- Nowe linie obniżają coverage → developer dodaje trywialny test `expect(x).toBe(x)`

**Fix**: coverage jako **trend**, nie **target**. Mutation score jako quality KPI. Code review patrzy na testy, nie na liczby.

### 8.3 E2E-heavy

Symptomy:
- 500 testów E2E, 50 testów unit
- Pipeline trwa 2h
- 30% testów flaky (losowo failują)
- Developerzy ufają tylko E2E, bo integracja jest "zbyt skomplikowana"

**Fix**: Trophy/Integration approach. E2E tylko na krytyczne happy paths (10-30 testów). Reszta = unit + integration + contract.

### 8.4 Brak obserwowalności = testowanie w ciemno

Symptomy:
- "Nie wiemy czy ten endpoint jest w ogóle używany"
- "Nie wiemy który feature ma największy wpływ na konwersję"
- Po deploy trzeba czekać na user complaints, żeby wiedzieć czy działa

**Fix**: RUM + SLO + feature flag exposure metrics + business metrics w observability.

### 8.5 "Musimy mieć 100% coverage"

Symptomy:
- Każda linijka musi być przetestowana
- Trivialny kod (gettery, settery) ma testy dla testów
- Developerzy piszą testy po to, żeby pipeline przeszedł, nie żeby walidować

**Fix**: rygor selektywny. Krytyczne ścieżki (auth, payments, data integrity) → wysoki standard. Reszta → pragmatyczne pokrycie.

### 8.6 Brak środowiska testowego bliskiego produkcji

Symptomy:
- Testy przechodzą na dev/staging, ale w produkcji się psują
- "Bo na produkcji mamy X, a u nas nie mamy"
- Konfiguracja trzymana w głowach, nie w kodzie

**Fix**: infrastructure as code (Terraform/Pulumi), testcontainers, ephemeral environments, parity prod/staging.

### 8.7 Testing = manual QA team

Symptomy:
- QA team testuje ręcznie każdy release
- Developerzy nie piszą testów ("QA przetestuje")
- Cykl: dev → QA → bugi → dev → QA → release (tygodnie)

**Fix**: QA embedded w teamie (shift-left), automatyzacja powtarzalnych, QA skupiony na exploratory + UX.

### 8.8 Brak test data strategy

Symptomy:
- Testy korzystają z danych produkcyjnych (RODO violation)
- Każdy developer ma inną paczkę danych
- Testy są niedeterministyczne (race condition na danych)

**Fix**: synthetic test data, factories (FactoryBoy, Bogus), data seeding scripts, testcontainers.

---

## 9. DORA metrics jako proxy dla jakości testów

DORA nie mierzy bezpośrednio testów, ale korelacja jest silna:

| Metryka | Co mierzy | Wpływ testów |
|---------|-----------|--------------|
| **Deployment Frequency** | Jak często deployujemy | Dobra automatyzacja = częstsze deploy |
| **Lead Time for Changes** | Commit → production | Szybki feedback z CI/CD |
| **Change Failure Rate** | % deployów powodujących awarię | Dobra jakość testów = niższa |
| **Failed Deployment Recovery Time** | Jak szybko rollback/fix | Canary + monitoring = szybki rollback |
| **Reliability** | Czas działania | Chaos testing + SLO discipline |

**Elite performers** (DORA 2024):
- Deploy frequency: on-demand (wiele razy dziennie)
- Lead time: <1h
- Change failure rate: 0-15%
- Recovery time: <1h

**Low performers**:
- Deploy frequency: monthly
- Lead time: 1-6 months
- Change failure rate: 46-60%
- Recovery time: >1 month

**Lekcja**: inwestycja w jakość testów = krótsze lead time + niższy failure rate. To się zwraca wielokrotnie.

---

## 10. Praktyczny framework wdrożenia (solo / mały / duży team)

### 10.1 Solo developer (1 osoba, mały projekt)

Must-have:
- Pre-commit: lint, format, type check
- PR (sam do siebie): unit + 1 smoke E2E
- Local: pełna test suite przed push
- Manual smoke w staging przed release

Nice-to-have:
- Mutation testing na krytycznych
- Feature flags dla eksperymentów
- Canary dla zmian infra

### 10.2 Mały team (3-6 osób)

Must-have:
- Pre-commit: lint, format, type, secret scan
- PR-level: unit + integration + contract (jeśli mikroserwisy)
- AI code review (Copilot/CodeRabbit) + 1 human reviewer
- Staging: E2E smoke + perf smoke
- Production: feature flags + observability (RUM + traces)

Nice-to-have:
- Mutation testing (nightly)
- Chaos engineering (game day co kwartał)
- Preview environments per PR

### 10.3 Średni team (7-15 osób)

Must-have: wszystko z małego +:
- SAST + SCA w pipeline
- Mutation testing na modułach krytycznych
- Preview environments per PR
- Canary deployment z auto-rollback
- SLO + error budget discipline
- Visual regression dla UI
- Accessibility (axe-core + manual)

Nice-to-have:
- Dedicated chaos engineering
- Synthetic monitoring
- AI-assisted test maintenance

### 10.4 Duży team (15+)

Must-have: wszystko ze średniego +:
- Centralna platforma feature flags (nie DIY)
- Pact broker dla cross-team contracts
- Chaos engineering as a platform (Gremlin/Litmus)
- Dedicated QA team skupiony na exploratory + UX + accessibility manual
- Test data platform (synthetic data + factories)
- SRE team ownership observability

---

## 11. Checklista dla nowego projektu

Gdy startujesz nowy projekt, **od razu** ustaw:

**Setup (dzień 1)**:
- [ ] Lint + format + type check w pre-commit
- [ ] CI/CD z testami (unit + integration)
- [ ] Coverage gate (80% na krytycznych, nic na reszcie)
- [ ] Staging environment z danymi zbliżonymi do produkcji
- [ ] Secret management (nie .env w repo)
- [ ] Observability: metrics + logs + traces (OpenTelemetry)

**W ciągu miesiąca**:
- [ ] Feature flag platform (nawet open-source Unleash)
- [ ] Contract testing jeśli mikroserwisy
- [ ] E2E smoke dla krytycznych flow
- [ ] SAST + SCA w pipeline
- [ ] DORA metrics dashboard

**W ciągu kwartału**:
- [ ] Mutation testing na krytycznych
- [ ] Canary deployment
- [ ] SLO definition dla top 3 user flows
- [ ] Accessibility automated scan w pipeline
- [ ] Perf smoke w staging

**Po roku**:
- [ ] Chaos engineering game day (kwartalnie)
- [ ] Synthetic monitoring
- [ ] AI-assisted test maintenance
- [ ] Test data platform

**Nie próbuj robić wszystkiego naraz.** Zaczynaj od must-have dla swojej skali, dodawaj nice-to-have gdy będziesz odczuwał ból, który rozwiązuje.

---

## 12. Kluczowe pułapki i jak ich unikać

### Pułapka 1: "Więcej testów = lepiej"

Bzdura. Więcej testów = więcej maintenance. **Mądrzejsze testy** (mutation, contract, ephemeral) > **więcej testów** (coverage bez jakości).

### Pułapka 2: Testy E2E jako siatka bezpieczeństwa

E2E są kruche, wolne i drogie. Mają sens na **happy paths**, nie na pełną macierz. 70-80% testów to unit + integration + contract. E2E = 5-10%.

### Pułapka 3: Poleganie na mockach

Mocki to niezbędne narzędzie, ale **zbyt dużo mocków = test nic nie testuje**. Reguła: mockuj granice (external API, time), NIE mockuj logiki biznesowej.

### Pułapka 4: Brak cleanup test data

Każdy test zostawia śmieci w DB → następny test ma race condition → flaky. **Factories + cleanup after each test** (lub testcontainers z fresh DB per test).

### Pułapka 5: Testy pisane po kodzie, nie przed

TDD vs test-after to stary spór. **Praktyczna zasada**: testy pisane PRZED review (przed merge), nie po deploy. Czyli: napisz test razem z kodem, nie po tygodniu "żeby coverage był zielony".

### Pułapka 6: Ignorowanie flaky tests

"Ten test czasami failuje, odpal jeszcze raz" → po 6 miesiącach 30% pipeline'ów to flaky. **Reguła**: każdy flaky test = bug do naprawienia w ciągu 1 sprintu. Nie wyciszaj, nie retryj w nieskończoność.

### Pułapka 7: Brak owner'a testów

"Kto to pisał? Kto to utrzymuje?" → nikt → test umiera → robi się bezużyteczny → ludzie przestają ufać testom. **Reguła**: każdy test ma ownera (zazwyczaj autora), każdy PR aktualizuje istniejące testy których dotyka.

### Pułapka 8: Testowanie tylko happy path

"Najważniejsze że działa dla happy path" → produkcja się psuje na edge case. **Reguła**: dla każdej ścieżki krytycznej — happy + 3-5 edge cases (null, empty, boundary, concurrent, error).

---

## 13. Companion notes i dalsze kierunki

Ta notatka jest piątą z serii o planowaniu i dowozie w software:

| # | Temat | Status |
|---|-------|--------|
| 1 | Planowanie projektu software | ✅ gotowe |
| 2 | Anatomia tasków dla inżynierów | ✅ gotowe |
| 3 | Dekompozycja tasków (INVEST, SPIDR, vertical slicing) | ✅ gotowe |
| 4 | Odciążanie cognitive load developerów | ✅ gotowe |
| 5 | Software delivery review | ✅ gotowe |
| 6 | **Software delivery testing (ta notatka)** | ✅ gotowe |
| 7 | Incident response i on-call | ⏳ do zrobienia |
| 8 | Observability i monitoring produkcyjny | ⏳ do zrobienia |
| 9 | Documentation as code (ADRs, runbooki, post-mortems) | ⏳ do zrobienia |

---

## 14. Źródła i dalsze lektury

**Klasyki**:
- Mike Cohn, *Succeeding with Agile* (2009) — Testing Pyramid
- Kent C. Dodds, *The Testing Trophy and Testing Classifications* (2018) — alternative framework
- Martin Fowler, *TestPyramid* (2012), *Practical Test Pyramid* (2018)
- Charity Majors, *Observability Engineering* (2022, 2nd ed. 2026)
- Gene Kim, Jez Humble, Patrick Debois, John Willis, *The DevOps Handbook*
- Nicole Forsgren, Jez Humble, Gene Kim, *Accelerate* (2018)
- Michael Nygard, *Release It!* (2nd ed. 2018) — stability patterns
- Will Larson, *An Elegant Puzzle* (2019) — systems of engineering

**Nowoczesne**:
- ThoughtWorks Technology Radar (2024, 2025)
- Capgemini World Quality Report 2024-2025
- DORA State of DevOps Report 2024
- Stripe Engineering Blog (testing at scale)
- Honeycomb blog (observability-driven development)
- Charity Majors, *Production is where the rigor goes* (LinkedIn, 2025)

**Narzędzia (dokumentacja)**:
- Pact / Pactflow (contract testing)
- Stryker (mutation testing)
- Playwright / Cypress (E2E)
- k6 / Gatling (performance)
- Argo Rollouts / Flagger (canary)
- LaunchDarkly / Split / Unleash (feature flags)
- Snyk / Semgrep (security)
- OpenTelemetry (observability)
- Datadog / Honeycomb / Grafana (observability platforms)

**Discord citations**:
- Akshay Shah, "Shift left vs shift right testing in 2025" (LinkedIn)
- Tweag, "Contract Testing: Shifting Left with Confidence" (Jan 2025)
- Bunnyshell, "Best Practices for E2E Testing in 2026"
- Harness, "Canary Releases and Feature Flags Explained"
- Qovery, "Ephemeral Environments Explained"
- Tweag / Pact community discussion on r/QualityAssurance

---

*Notatka zakończona 2026-06-19. Jeśli coś jest nieaktualne lub brakuje istotnego
tematu — patch w tym samym pliku. Cykl rewizji: co kwartał (zgodnie z
ThoughtWorks Tech Radar i DORA State of DevOps).*