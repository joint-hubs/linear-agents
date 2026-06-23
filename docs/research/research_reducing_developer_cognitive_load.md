---
type: research-note
status: active
tags: [type/research, area/methodology, topic/engineering, topic/developer-experience, topic/cognitive-load, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
related: [research_engineering_task_description_best_practices.md, research_task_decomposition_invest_spidr_vertical_slicing.md]
---

# Engineering tasks — odciążanie cognitive load developerów

> Trzecia z trzech notatek o tym, jak kompleksowo opisywać pracę dla inżynierów.
> Ta: **jak minimalizować mentalny koszt** każdego tasku — żeby developer
> spędzał czas na ROZWIĄZYWANIU problemu, a nie na DOMYŚLANIU SIĘ co ma robić.
>
> Pierwsza notatka (anatomia) + druga (dekompozycja) = warunek wstępny.
>
> Źródła: John Sweller (Cognitive Load Theory, 1988), Bas de Groot
> (Devoxx UK 2025 — Balancing Cognitive Load), Trunk.io (Context Switching
> in Software Engineering), Mark Schwartz (war & peace w IT), Michael Nygard
> (ADR), Charley Park / Mountain Goat Software (DoR), GitHub Docs (issue
> templates), Basecamp (Shape Up — calm company, no standups), Will Larson
> (An Elegant Puzzle, staff engineering), Charity Majors (observability),
> Kelsey Hightower (boring tech), PMC/NIH (task switching meta-analysis).

---

## TL;DR

1. **Cognitive load theory ma 3 rodzaje:** intrinsic (złożoność problemu — nieunikniona),
   extraneous (wszystko co niepotrzebne — to redukujemy), germane (uczenie się — wzmacniamy).
   **Większość narzędzi zespołowych atakuje extraneous load.**
2. **Koszt context switchingu jest realny i mierzalny** — 15-25 min na przeładowanie kontekstu
   po przerwie (Mark Schwartz "war & peace", APA "Multitasking"). 4 przerwy dziennie = godzina stracona.
3. **Największe źródła extraneous load w task management:**
   - Niejasny scope (co MAM zrobić?)
   - Brak kontekstu (dlaczego? dla kogo?)
   - Brak środowiska (jak lokalnie odtworzyć?)
   - Brak decyzji architektonicznych (czytać godzinami Slack)
   - Niespójny template (każdy task jest inny)
   - Ciągłe przerwy (stand-upy, Slack, "szybkie pytania")
4. **Developer Experience (DevEx) to nie luksus** — to inwestycja, która się zwraca wielokrotnie.
   Każda godzina zaoszczędzona na przeładowaniu kontekstu = godzina prawdziwej pracy.
5. **Zasada naczelna:** task powinien być **samowystarczalny**. Developer bierze go, zamyka,
   raportuje. Nie pyta, nie czeka, nie zgaduje.

---

## 1. Trzy rodzaje cognitive load (Sweller, 1988)

Zanim zaczniemy redukować — zrozummy, CO redukujemy.

| Typ | Definicja | Przykład | Co z tym robić |
|-----|-----------|----------|----------------|
| **Intrinsic** | Złożoność SAMEGO problemu | Implementacja distributed consensus | **Nie redukuj** — to jest istota pracy. Można podzielić (dekompozycja), ale nie usunąć. |
| **Extraneous** | Wszystko, co NIE pomaga w rozwiązaniu | Szukanie jaki endpoint wywołać, ogarnianie środowiska, czytanie 10 Slack threadów | **Redukuj maksymalnie** — to jest twój główny cel |
| **Germane** | Wysiłek włożony w naukę / budowanie mentalnego modelu | "Aha, ten serwis robi X, teraz rozumiem architekturę" | **Wzmacniaj** — to jest właśnie value engineerskie |

### Praktyczna interpretacja

Większość narzędzi i praktyk, które omawiamy dalej, atakuje **extraneous load**:

- Jasny scope → mniej "co ja właściwie robię"
- ADR → mniej "jak my to zrobiliśmy w 2023"
- Lokalne środowisko w 5 min → mniej "jak odpalić to gówno"
- Spokój w kalendarzu → mniej "co to za przerwanie"
- Spójny template → mniej "jak ten task jest zbudowany"

---

## 2. Koszt context switchingu (twarde dane)

### Ile kosztuje przełączenie

| Źródło | Pomiar |
|--------|--------|
| **APA, "Multitasking: Switching costs"** | Przełączenie = 40% wolniejsza praca, 50% więcej błędów |
| **Mark Schwartz, "War & Peace"** | 15-25 min na przeładowanie kontekstu po przerwie |
| **Trunk.io study (2024)** | Średni developer: 10-12 przełączeń dziennie |
| **Gloria Mark (UC Irvine, 2008)** | Stres wraca do baseline'u dopiero po ~23 min po przerwaniu |
| **PMC Task Switching (2023)** | Wpływ na working memory jest statystycznie istotny |

### Matematyka pragmatyczna

Załóżmy:
- Developer: 1 przerwanie co 1.5h (dobre warunki)
- Koszt przeładowania: 20 min
- Dziennie: 5 przerwań × 20 min = **100 min utraconej produktywności**
- Tygodniowo: **~8h utraconej pracy** (pełny dzień!)
- Rocznie: **~6 tygodni** utraconej pracy

### Skąd się biorą przerwania

| Źródło | Typowy % | Jak redukować |
|--------|----------|---------------|
| Slack / Discord pytania | 35-40% | Async-first, status "Do not disturb" |
| Spotkania (zwłaszcza "szybkie" 15min) | 25-30% | Konsolidacja, batch, "nie mniej niż 30 min bloku" |
| Code review innych | 15-20% | Dedykowane bloki "review time", nie ad-hoc |
| Niejasne zadania (trzeba pytać) | 10-15% | Lepszy scope + ADR + DoR |
| CI/CD failures, alerty | 5-10% | Stable pipelines, paging tylko krytyczne |

### Zasada "minimum 2h bloku"

Każdy developer potrzebuje **minimum 2h nieprzerwanego bloku** dziennie na deep work.
Reszta dnia to overhead (meetings, review, komunikacja). Kto tego nie ma — robi 30% mniej.

---

## 3. Pre-loaded context — developer bierze task i leci

Najważniejsza praktyka. Każda sekcja task template (notatka 1) istnieje po to, żeby developer **nie musiał pytać**.

### Checklist "czy developer może wystartować bez pytań"

- [ ] **Cel biznesowy** jasny (Why)
- [ ] **Persona / user journey** wskazany (Who)
- [ ] **Scope in/out** wymieniony (What)
- [ ] **Acceptance Criteria** testowalne (AC)
- [ ] **Link do designu** (Figma / FigJam / Excalidraw)
- [ ] **Link do ADR** (jeśli są decyzje architektoniczne)
- [ ] **Stack** jasny (biblioteki, wersje)
- [ ] **Lokalne środowisko** działa (lub: instrukcja "jak postawić w 5 min")
- [ ] **Test data / fixtures** gotowe (albo: skrypt `seed_local.sh`)
- [ ] **Existing patterns** wskazane ("zobacz jak to jest zrobione w module X")
- [ ] **Owner + Reviewer** przypisani
- [ ] **Slack channel** do pytań (jeśli wątpliwości)
- [ ] **Definition of Done** dla projektu dołączony

### Co się dzieje, gdy brakuje któregoś

| Brak | Konsekwencja |
|------|--------------|
| Brak designu | "Zrobię to po swojemu" → redesign w review |
| Brak ADR | "Którą bibliotekę wziąć?" → 2 godziny research |
| Brak test data | "Jak przetestować edge case?" → ręczne klikanie, nie testy |
| Brak patterns | "Jak to się robi w tym codebase?" → grepowanie, czytanie kodu |
| Brak scope out | "A może dorzucę X?" → scope creep |

### Szacunkowy koszt braków

| Brak | Czas stracony (per task) |
|------|--------------------------|
| Brak designu | 1-2h (pogaduszki + redesign) |
| Brak ADR | 1-2h (research decyzji) |
| Brak env setup | 2-4h (debug środowiska) |
| Brak test data | 0.5-1h |
| Brak patterns | 1-3h (czytanie kodu) |
| Brak scope out | 1-4h (over-implementation) |

**Średnio**: źle przygotowany task = **8-16h dodatkowej pracy** developera.

---

## 4. ADR (Architecture Decision Records) — Michael Nygard

Najważniejsze narzędzie offloadingu pamięci zespołu.

### Czym jest ADR

Lekki dokument (zwykle 1 strona), który:
- opisuje **jaką decyzję podjęliśmy** (Context + Decision)
- wyjaśnia **dlaczego** (Rationale)
- wymienia **co to odrzuca / implikuje** (Consequences)

### Format (Nygard)

```markdown
# ADR-0042: Rate-limiting strategy

## Status
Accepted (2026-05-12)

## Context
Aktualnie POST /auth/login nie ma rate-limitu.
12-13.06 wykryto brute-force 2.4k requestów z 3 IP.
Chcemy zabezpieczyć endpoint.

## Decision
Stosujemy rate-limit per IP w warstwie aplikacji,
korzystając z biblioteki `slowapi` (FastAPI).
Domyślnie 100 req/min per IP dla POST /auth/login.
Whitelist dla IP wewnętrznych przez `RATELIMIT_WHITELIST`.

## Consequences
**Pozytywne:**
+ Ochrona przed brute-force
+ Prosta implementacja
+ Konfigurowalne bez redeploy

**Negatywne:**
- Single point of failure: jeśli Redis padnie,
  logika fail-open (requesty przechodzą)
- Brak ochrony per-user (per-IP tylko)

**Anulowane opcje:**
- Cloudflare rate-limit: odrzucone (compliance wymaga on-prem)
- WAF: odrzucone (za drogie)
```

### Jak ADR redukuje cognitive load

| Bez ADR | Z ADR |
|---------|-------|
| "Który rate-limiter wybraliśmy?" → 2h research | "Czytam ADR-0042" → 5 min |
| "Dlaczego tak?" → pytanie na Slacku, czekanie | Decyzja udokumentowana, można dyskutować |
| Każdy nowy dev pyta o to samo | Wiki + search załatwia sprawę |

### Kiedy pisać ADR

- Wybór technologii / biblioteki
- Wybór architektury (microservices vs modular monolith)
- Decyzja o danych (schema, storage)
- Decyzja niestandardowa (coś co wymaga uzasadnienia)

### Kiedy NIE pisać ADR

- Drobne implementacje (use the framework default)
- Bug fix (nie wymaga decyzji)
- Proste taski (nie wymagają dyskusji)

### Lokalizacja

Standard: `docs/adr/NNNN-title.md` w repozytorium kodu.
Narzędzia: `adr-tools` (CLI), `log4brains` (web UI), zwykły markdown.

---

## 5. Definicja Ready z perspektywy cognitive load

(Notatka 1 opisuje DoR mechanicznie. Tu — dlaczego DoR chroni load developera.)

### Task niegotowy = obciążenie

Task bez jasnego AC, scope, kontekstu to **przerywacz** — developer musi przerwać pracę, żeby pytać. Nawet jeśli odpowiedź przyjdzie w 10 min, **koszt przeładowania kontekstu (20 min)** przewyższa zysk.

### Koszt złego DoR

| Sytuacja | Koszt |
|----------|-------|
| Task trafia do sprintu z pustym AC | Developer blokuje, pyta, czeka (1-4h) |
| Task bez scope out → scope creep | 2-4h dodatkowej pracy |
| Task z niejasną decyzją architektoniczną | Developer decyduje sam → 30% szansa na złą decyzję |

### Złota reguła DoR

> **Task, który nie spełnia DoR, jest obciążeniem dla developera, nie dla product ownera.**
> Product owner cierpi, bo task nie "idzie". Developer cierpi, bo musi robić czyjąś robotę myślenia.

Dlatego DoR jest filtrem WEJŚCIA do sprintu — nie biurokracją.

---

## 6. Środowisko lokalne — największy extraneous load w historii

Według anegdotycznych badań (Stack Overflow Developer Survey 2024, JetBrains State of DevOps), **środowisko lokalne** to najczęstsza bolączka developerów. Nowy dev w zespole: **1-3 dni na postawienie środowiska** = utracony sprint.

### Symptomy złego środowiska

- README ma 10 kroków do odpalenia
- Wymaga bibliotek systemowych specyficznych dla OS
- Zależy od zewnętrznych API bez mocków
- Setup jest inny dla każdej gałęzi
- Brak `seed` data
- Brak `.env.example`

### Rozwiązania

| Praktyka | Co daje |
|----------|---------|
| **Docker Compose dla dev** | `docker compose up` → pełne środowisko w 5 min |
| **Seed script** (`bin/seed.sh`) | Deterministic data, identyczna dla każdego deva |
| **`.env.example`** | Jasna lista zmiennych, bez sekretów |
| **Makefile / Taskfile** | `make dev`, `make test`, `make seed` — zero mentalnego wysiłku |
| **Mockowane API zewnętrzne** (`nock`, `msw`, `wiremock`) | Nie zależysz od zewnętrznych serwisów |
| **Devcontainer** (VS Code) | Pełne IDE z preinstalowanymi deps w kontenerze |
| **GitHub Codespaces / Gitpod** | "Open in GitHub" → pełne IDE w przeglądarce |

### Koszt vs zysk

Inwestycja: **2-5 dni** seniora na postawienie pełnego dev env.
Zysk: **każdy nowy dev oszczędza 1-3 dni onboarding**. Przy 5 nowych devach rocznie = 5-15 dni odzyskane. ROI w pierwszym roku.

---

## 7. Stand-upy vs async-first

### Dlaczego tradycyjny stand-up jest extraneous load

Tradycyjny daily stand-up (15 min × 7 osób):
- 3 osoby mówią coś, co dotyczy tylko ich (noise dla reszty)
- Wymaga 100% zespołu o tej samej porze (context switch dla wszystkich)
- Powstaje "niewinne" pytanie "a możesz mi szybko wyjaśnić X?" → godzinna dyskusja
- Wytwarza presję "muszę mieć coś do powiedzenia"

Basecamp / GitLab / Shopify (po zmianie) zrezygnowały z daily stand-upów na rzecz async.

### Async-first zamienniki

| Tradycja | Async |
|----------|-------|
| Daily stand-up 15min | Wpis w `#standup` Slack (3 zdania: co zrobiłem / co robię / blocker) |
| Demo w piątek | "Friday demo" video na Loom (5-7 min) |
| Sprint planning (4h spotkanie) | Notion doc z epikami → async comments → spotkanie tylko do decyzji |
| Retrospective (1h) | Anonimowy form + spotkanie 30 min tylko nad konkretnymi zmianami |

### Koszt spotkania vs wpis

| Forma | Koszt dla zespołu 7 osób |
|-------|--------------------------|
| Stand-up 15 min | 105 min osobominut |
| Async wpis | 21 min osobominut (3 min × 7) |

**5× mniej loadu** przy tej samej (lub lepszej) widoczności.

### Spotkania, które są potrzebne

Nie chodzi o to, żeby NIE spotykać się wcale. Chodzi o to, żeby:
- Spotkanie miało **konkretny output** (decyzja, plan, demo)
- Było **przygotowane** (agenda wysłana 24h wcześniej)
- Było **krótkie** (max 30-45 min, często 15)
- Było **asynchroniczne** gdzie to możliwe (szczególnie: status, planning, retrospective)
- Było **synchroniczne** tylko gdy potrzebne (decyzje, dyskusje, design review)

---

## 8. Pytania w stylu "szybkie 5 min" — jak najgorzej można przerwać developera

### Dlaczego to jest tak szkodliwe

"Szybkie pytanko, zajmie Ci 5 minut" to najczęstszy zabójca deep work. Dlaczego?

- Przeładowanie kontekstu: 20 min
- Odpowiedź: 5 min
- Powrót do głębokiej pracy: kolejne 15-20 min
- **Realny koszt: 40-45 min za "szybkie 5 min"**

### Co robić zamiast tego

| Zamiast | Rób |
|---------|-----|
| "Szybkie 5 min na Slacku" | Wiadomość z konkretnym pytaniem + deadline ("potrzebuję odpowiedzi do 16:00") |
| Slack ping "hej masz sekundę?" | Issue z tagiem `question` + context |
| Pytanie w trakcie deep work | Kolejka pytań — odpowiedź o ustalonej godzinie ("daily Q&A 14:00") |
| Spotkanie "omówimy to" | Decyzja przez ADR + async review |

### Stack Overflow / Notion culture

Drużyny takie jak GitLab mają **kulturę pisania pytań** (issue, MR comment, doc)
zamiast **pytania na żywo**. Zalety:
- Pytanie jest zapisane (nie powtórzone 10× przez 10 osób)
- Odpowiedź jest przeszukiwalna
- Async = mniej przerwań
- Nowy dev widzi historię pytań

---

## 9. Documentation as load reduction

### Prawo Atwooda: "Any code of your own that you haven't looked at for six months might as well have been written by someone else."

Bez dokumentacji **każdy developer odkrywa koło na nowo**.

### Co dokumentować (priorytet)

| Dokument | Kto czyta | Koszt napisania | Oszczędność |
|----------|-----------|-----------------|-------------|
| **README** nowego deva | Każdy nowy dev | 4-8h | 1-3 dni onboarding × każdy nowy |
| **ADR** przy każdej istotnej decyzji | Zespół | 1-2h | Wielogodzinne dyskusje × każde spotkanie |
| **Architecture diagram** (C4 model) | Nowi dev, ops | 8-16h | 1-2 tygodnie onboardingu × każdy nowy |
| **Runbook** dla operacji | DevOps, on-call | 2-4h per runbook | Panika o 3 w nocy zamiast rozwiązania |
| **Glossary domenowy** | Zespół + product | 2-4h | Nieporozumienia w taskach |

### Dokumentacja minimalna, która odciąża

- **README** z 5 krokami "od zera do działającego kodu"
- **CONTEXT.md** w każdym dużym module ("co tu jest i dlaczego")
- **ADR/** w `docs/adr/` dla każdej niestandardowej decyzji
- **Inline comments** tylko dla WHY (nie WHAT — to widać z kodu)

### Co NIE dokumentować

- Implementacja (to jest kod)
- Tutoriale (aktualizują się same, lepiej link do prawdziwych źródeł)
- API (generuje się z OpenAPI/GraphQL schema)

---

## 10. Wzorzec "codebase health" — małe bety redukujące przyszły load

### Co to znaczy

Niektóre taski **same w sobie nie dostarczają wartości biznesowej**, ale **redukują przyszły cognitive load zespołu**.

### Przykłady

| Tech-debt task | Redukuje |
|----------------|----------|
| Refactor: wyciągnij X z monolitu do modułu | Złożoność onboarding nowego deva |
| Dodaj testy integracyjne dla Y | Niepewność przy refactorze Y |
| Ustandaryzuj error handling | Mniej "jak obsłużyć błąd" decyzji × każdy task |
| Dodaj type hints / type strict | Mniej "co to za zmienna" × każdy task |
| Dodaj OpenAPI doc do endpointów | Mniej pytań FE do BE |
| Zmigruj z X na Y (gorsza technologia) | Mniej "dlaczego to takie dziwne" × każdy task |

### Jak sprzedawać tech-debt product ownerowi

Frame nie jako "czystość kodu" ale jako **"ile razy w tygodniu musisz pytać o X"**:
- "Każdy nowy dev pyta o ten sam wzorzec error handlingu → standaryzacja to 2 dni pracy, oszczędza 0.5h × każdy nowy dev × każde pytanie"
- "Każdy feature w module X wymaga refactoru auth → 1 dzień na wydzielenie auth warstwy, oszczędza 4h × każdy feature w module X"

Product owner rozumie ROI. Inżynierowie rozumieją czystość. Obie perspektywy się spinają.

---

## 11. Roaming in pair programming (jako anti-load strategy)

### Kiedy pair programming REDUKUJE cognitive load

| Scenariusz | Efekt |
|------------|-------|
| Junior + senior, złożony task | Senior uczy, junior się uczy, mniej błędów |
| Dwa seniorów, krytyczny task (security, migration) | Wzajemna walidacja, szybsze edge-case discovery |
| Onboarding nowego deva | Nowy dev uczy się codebase, stary dev uczy się wyjaśniać |

### Kiedy pair programming ZWIĘKSZA cognitive load

| Scenariusz | Efekt |
|------------|-------|
| Dwa juniorów bez code review seniora | Obaj się uczą, nikt nie waliduje |
| Senior + senior, trywialny task | Overhead nie jest wart efektu |
| Kiedykolwiek "na siłę" | Frustracja obu stron |

### Reguła

Pair programming nie jest uniwersalnym rozwiązaniem. Jest narzędziem na konkretne sytuacje:
- Onboarding
- Krytyczne / high-risk tasks
- Uczenie się nowego języka / frameworka

Dla reszty: **async review** (PR/MR review) jest tańsze cognitywnie.

---

## 12. Metryki: jak mierzyć cognitive load (proxy)

### Metryki, które nie są bullshit

| Metryka | Co mierzy | Jak zbierać |
|---------|-----------|-------------|
| **Time to first commit (nowy dev)** | Onboarding efficiency | Git log + hiring date |
| **Time from PR open to merge** | Review bottleneck | GitHub/GitLab analytics |
| **Rework rate (% PR-ów z follow-up fixami)** | Jakość AC | Manual sampling |
| **Bug rate per task** | Jakość scope / AC | Bug tracker |
| **Question rate per task** (ile pytań musi zadać developer) | DoR quality | Slack / issue comments |
| **Context switch count per dev per day** | Interruptions | Calendar + Slack analytics |
| **% dnia w spotkaniach** | Meeting load | Calendar analytics |
| **Flow time (% tygodnia w bloku 2h+)** | Deep work available | Time tracking / manual sampling |

### Metryki, które SĄ bullshit

- Lines of code
- Velocity (story points per sprint) bez kontekstu
- "Hours worked"
- Commit count

---

## 13. Checklist: minimal cognitive load per task

**Przed oddaniem tasku do developera** (autor tasku / PM):

- [ ] Why wypełnione (2-3 zdania, link do kontekstu)
- [ ] Who wskazany (persona / system)
- [ ] Scope in + out (nawet jeśli out jest pusty, zapisz to)
- [ ] AC testowalne (Given/When/Then lub checklist)
- [ ] Link do designu (Figma / FigJam / Excalidraw)
- [ ] Link do ADR (jeśli dotyczy decyzji)
- [ ] Stack + biblioteki wymienione
- [ ] Wzorce istniejące w codebase wskazane ("zobacz moduł X")
- [ ] Seed / test data gotowe (lub skrypt)
- [ ] Lokalne środowisko działa dla tego taska (lub instrukcja)
- [ ] Reviewer przypisany
- [ ] Slack channel / osoba do pytań wskazane
- [ ] DoD dla projektu dołączony

**Jeśli > 3 braki** → task nie jest gotowy, zwrot do autora.

---

## 14. Checklist: minimal cognitive load per sprint (dla zespołu)

- [ ] Max 2 spotkania dziennie per developer
- [ ] Min 2h nieprzerwanego bloku dziennie per developer
- [ ] "Szybkie pytania" mają swój slot (np. daily Q&A 14:00)
- [ ] Stand-up async (wpis + komentarze, nie spotkanie)
- [ ] Sprint planning ma pre-read (dokument wysłany 24h wcześniej)
- [ ] ADR dla każdej istotnej decyzji w tym sprincie
- [ ] Retro ma konkretne akcje (nie "powinniśmy lepiej")
- [ ] On-call rotation jasna, bez niespodzianek

---

## 15. Podsumowanie jednolinijkowe

> **Developer powinien móc wziąć task, zrozumieć go w 10 minut, zamknąć w 1-2 dni i nigdy nie zapytać "a co miałeś na myśli?" — a wszystko dookoła (środowisko, dokumentacja, kultura) powinno to umożliwiać bez wysiłku.**

Cała reszta (template, ADR, DoR, środowisko, kultura async) to **instrumenty** pod tę zasadę.
