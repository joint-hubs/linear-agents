---
type: research-note
status: active
tags: [type/research, area/methodology, topic/engineering, topic/task-management, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
---

# Engineering tasks — anatomia dobrego opisu

> Pierwsza z trzech notatek o tym, jak kompleksowo opisywać pracę dla inżynierów.
> Ta: **anatomia** — co MUSI być w tasku, żeby developer mógł go podjąć bez domyślania się.
> Druga: dekompozycja (INVEST, SPIDR, vertical slicing).
> Trzecia: jak odciążać cognitive load developerów.
>
> Źródła: Mountain Goat Software (Mike Cohn — INVEST, SPIDR, job stories),
> Atlassian (Jira ticket template, AC vs DoD), Plane.so (DoD checklist),
> AltexSoft (acceptance criteria), Ryan Singer / Basecamp (Shape Up — pitch),
> Heily Hindrea (10 must-have sections), Alex Young (user story structure),
> GitHub Docs (issue templates), Michael Nygard (ADR), Hyperdrive Agile (DoR).

---

## TL;DR

1. **Task = kontrakt między piszącym a wykonawcą.** Dobry task odpowiada na 7 pytań: **Co? Dlaczego? Dla kogo? Jak zmierzyć sukces? Jakie są granice? Co jest potrzebne na wejściu? Jak to zamknąć?**
2. **Trzy różne dokumenty, nie jeden:**
   - **Acceptance Criteria (AC)** = specyficzne dla tego taska (Given/When/Then lub checklist)
   - **Definition of Done (DoD)** = wspólne dla całego projektu/zespołu (jakość, testy, review)
   - **Definition of Ready (DoR)** = warunek wejścia do sprintu (task nie wchodzi, dopóki...)
3. **User story ("As a / I want / so that") NIE WYSTARCZA** — to nagłówek, nie opis. Pod spodem muszą być: kontekst, scope in/out, AC, DoD, kryteria techniczne, ryzyka, linki.
4. **Template > wolna forma.** Bez wzorca każdy task jest inny i developer traci czas na parsowanie. Template musi być krótki (8-12 sekcji max) i narzucać myślenie.
5. **Anty-pattern #1**: task jako jedno zdanie "dodaj X". Anty-pattern #2: kopia wymagań biznesowych bez tłumaczenia na język implementacji. Anty-pattern #3: brak informacji "kiedy NIE zaczynamy".

---

## 1. Hierarchia: Epic → Feature → Story → Task

Zanim napiszesz task, upewnij się, że wiesz na jakim poziomie hierarchii jesteś. Inne pola, inny rozmiar, inny odbiorca.

| Poziom | Co opisuje | Rozmiar | Odbiorca | Przykład |
|--------|------------|---------|----------|----------|
| **Epic** | duży blok wartości biznesowej, trwający kwartały | tygodnie–miesiące | stakeholder, product lead | "Wdrożyć onboarding płatności" |
| **Feature** | funkcjonalność dająca się wydać | dni–tygodnie | product owner + dev team | "Stripe Checkout w onboardingu" |
| **User Story** | jedna wartość dla jednego użytkownika, vertical slice | dni | zespół implementujący | "Jako nowy user mogę zapłacić kartą" |
| **Task (engineering)** | atomowa jednostka pracy technicznej | godziny–1-2 dni | jeden developer | "Dodać pole `card_token` do tabeli `users`" |
| **Sub-task** | jeszcze mniejszy krok w ramach taska | godziny | ten sam developer | "Napisać migrację dla `card_token`" |

**Zasada praktyczna:**
- Jeśli task nie mieści się w **2 dniach kalendarzowych** jednego developera → za duży, rozbij (notatka 2).
- Jeśli task nie da się **zademonstrować** jako działającej zmiany (choćby w stagingu) → to nie story, tylko technical task.
- Jeśli task wymaga **więcej niż 3 osób** do zamknięcia → za szeroki, albo to feature.

---

## 2. Anatomia taska (template kanoniczny)

Poniższy template jest złożeniem praktyk Atlassian (Jira), Shape Up (Basecamp), Heily Hindrea (10 must-have sections) i Alex Young (user story structure). Skrócony do minimum, które działa.

### Sekcje obowiązkowe

```markdown
# [Tytuł — imperative, konkretny, nie "improvements"]

## Why (Kontekst / Dlaczego)
- Jaki problem biznesowy adresujemy?
- Dlaczego teraz? (z czym to się łączy?)
- Co się stanie, jeśli tego NIE zrobimy?
- 1-3 zdania. Linki do: roadmapy, ADR, dyskusji, badań.

## Who (Dla kogo)
- Primary user/persona (z imienia — nie "użytkownik")
- Secondary user (kto jeszcze dotknie tej zmiany)
- Jak często? W jakim kontekście?

## What (Scope)
### In scope
- Konkretne capabilities / user actions / API surface

### Out of scope (BARDZO ważne)
- Czego NIE robimy w tym tasku
- Anti-goals — czego nie obiecujemy

## Acceptance Criteria
- Given [context]
- When [action]
- Then [observable outcome]

Lub jako checklist:
- [ ] User może wykonać akcję X
- [ ] Edge case Y zwraca Z
- [ ] UI renderuje się poprawnie na mobile

## Definition of Done (per project)
- [ ] Code reviewed (min 1 reviewer)
- [ ] Unit tests / integration tests napisane
- [ ] E2E test (jeśli user-facing)
- [ ] Doku w `/docs` zaktualizowana (jeśli dotyczy API/UX)
- [ ] CHANGELOG / release notes
- [ ] Deployed na staging, smoke test przeszedł

## Technical notes
- Stack, biblioteki, linki do design docs, ADR-y
- Performance / security / observability oczekiwania
- Migracje danych (jeśli dotyczy)
- Feature flag (jeśli dotyczy) — nazwa, domyślny stan

## Dependencies
- Blokuje na: [inne taski / decyzje / osoby]
- Blokowany przez: [to samo, w drugą stronę]
- External: API X, vendor Y, design od Z

## Risks / Open questions
- Co może wybuchnąć?
- Co nie jest jeszcze jasne?
- Kogo pytać w razie wątpliwości?

## Links
- Figma: ...
- ADR-0012: ...
- Slack thread: ...
- Linear issue (jeśli subdopisek): ...
```

### Dlaczego akurat tyle

| Sekcja | Odpowiada na pytanie | Co się dzieje bez niej |
|--------|----------------------|------------------------|
| Why | Dlaczego to robimy | Developer robi złą rzecz "bo mi się wydawało" |
| Who | Dla kogo | Genericowa implementacja, brak empatii |
| What/Scope | Co konkretnie | Scope creep, zrobimy "to i jeszcze X" |
| What/Out of scope | Granice | Godziny stracone na "a może dorzucimy Y" |
| AC | Jak zweryfikować | "U mnie działa" vs "nie działa dla klienta" |
| DoD | Jakie minimum jakości | Niespójna jakość między taskami |
| Tech notes | Jak technicznie | Developer musi zgadywać stack/pattern |
| Dependencies | Co musi być gotowe | Zaczęte, zablokowane, potem wyrzucone |
| Risks | Co może wybuchnąć | Brak planu B |
| Links | Gdzie szukać więcej | Godziny na archeologię w dokumentacji |

---

## 3. Acceptance Criteria (AC) vs Definition of Done (DoD) vs Definition of Ready (DoR)

Trzy różne rzeczy, często mylone. Pomieszanie = niespójna jakość.

### Acceptance Criteria — specyficzne dla tego taska

**Co to jest**: warunki, które MUSZĄ być spełnione, żeby user uznał tę zmianę za wartościową.

**Format**: Given/When/Then (BDD) lub czysta checklist.

**Przykład** (task: "Eksport faktury do PDF"):
```
Given użytkownik ma fakturę w statusie "issued"
When klika "Pobierz PDF"
Then plik PDF się pobiera z nazwą "faktura_<numer>_<data>.pdf"
And PDF zawiera: logo, NIP sprzedawcy, pozycje, kwotę netto/VAT/brutto, IBAN
And jeśli faktura ma pozycje w wielu walutach, Then przeliczenie po kursie z dnia wystawienia
```

**Przykład anty-patternu AC**:
- ❌ "System działa poprawnie" (zero weryfikowalności)
- ❌ "User jest zadowolony" (subiektywne, nie do testowania)
- ❌ "Wszystko jest przetestowane" (testy którego poziomu? co pokrywają?)

**Skąd wziąć AC**:
1. Rozmowa z product owner / klientem (cel → konkretne zachowanie)
2. Istniejące bug reports / support tickets (to co się psuło = wstęp do AC)
3. Dla API: contract-first (OpenAPI / GraphQL schema)
4. Dla UI: design review z designerem (które interakcje są krytyczne)

### Definition of Done — wspólne dla wszystkich tasków w projekcie

**Co to jest**: minimalny standard jakości, który KAŻDY task musi spełnić, zanim uznamy go za ukończony.

**Przykładowy DoD dla projektu webowego**:
```
- [ ] Kod przeszedł code review (min 1 senior)
- [ ] Unit tests: pokrycie ≥80% nowego kodu
- [ ] Integration test dla nowego API endpoint
- [ ] E2E test dla nowego user flow (Playwright/Cypress)
- [ ] Brak nowych warningów w buildzie
- [ ] Linter przeszedł (ESLint/Ruff)
- [ ] Doku w /docs zaktualizowana (jeśli public API / UX)
- [ ] Feature flag ustawiony (jeśli dotyczy) z domyślnym stanem
- [ ] Manual smoke test na stagingu
- [ ] Telemetria / logi dodane (jeśli user-facing)
```

**Różnica kluczowa**: DoD jest **per projekt** i zmienia się rzadko. AC są **per task** i zmieniają się w zależności od scope.

### Definition of Ready — task NIE WCHODZI do sprintu bez...

**Co to jest**: minimalny warunek, żeby task uznać za "do zrobienia" — nie za "zrobiony" (to DoD), ale za możliwy do podjęcia bez domyślania się.

**Przykładowy DoR**:
```
- [ ] Tytuł jasny, akcyjny, w stylu imperative
- [ ] Sekcja "Why" wypełniona, link do większego kontekstu
- [ ] AC są testowalne (każde ma Given/When/Then lub checklist)
- [ ] Out-of-scope jest wymieniony (nawet jeśli pusty: "nic, scope jest minimalny")
- [ ] Dependencies zidentyfikowane i rozwiązane (albo blocker jest explicit)
- [ ] Estymata jest realistyczna (1-2 dni dla pojedynczego deva)
- [ ] Reviewer / owner znany (kto podejmie decyzje w razie wątpliwości)
```

**Uwaga**: DoR jest kontrowersyjny — może sparaliżować zespół, jeśli jest zbyt surowy (Mike Cohn: "Definition of Ready: What It Is and Why It's Dangerous"). Traktuj jako checklist refleksyjny, nie bramkę biurokratyczną.

---

## 4. Format: User Story vs Job Story vs Brief

Trzy formaty, różne zastosowania. Pick one per task.

### User Story (najpopularniejszy)
```
As a [persona]
I want to [action]
So that [outcome/value]
```
**Kiedy**: wiesz kim jest user, masz personę, flow jest prosty.
**Plusy**: empatia, ownership product ownera.
**Minusy**: udaje, że znasz personę. W B2B/enterprise persony są płytkie.

### Job Story (Alan Klement, Intercom)
```
When [situation/context],
I want to [motivation],
So I can [expected outcome].
```
**Kiedy**: kontekst jest ważniejszy niż persona (np. nowy user, edge case).
**Plusy**: opisuje sytuację, nie fikcyjną personę.
**Minusy**: trudniejsze do estymacji "ile userów to dotyczy".

### Brief (Shape Up, Basecamp)
**Struktura**: Problem → Appetite → Solution sketch → Rabbit holes
**Kiedy**: feature jest duży, dotyczy całego zespołu na 6 tygodni.
**Plusy**: zostawia pole do interpretacji developerowi.
**Minusy**: za luźne do codziennego task management.

### Rekomendacja praktyczna
- Dla daily engineering tasks: **User Story + rozbudowany opis** (template z sekcji 2).
- Dla średnich feature'ów: **Job Story** w discovery, **User Story** w implementacji.
- Dla dużych betów (Shape Up): **Brief** z hill chartem.

---

## 5. Tytuł taska — jak pisać

Tytuł to pierwsza rzecz, którą developer czyta. Zły tytuł = nieprzeczytany task.

### Dobre praktyki

| ✅ Dobrze | ❌ Źle |
|----------|--------|
| "Dodać endpoint POST /payments dla Stripe Checkout" | "Integracja płatności" |
| "Naprawić race condition w WebSocket reconnect" | "WebSocket bug" |
| "Wyświetlić błąd walidacji pod polem email" | "Poprawić formularz" |
| "Zmigrować users.id z INT na UUID v7" | "Migration" |

### Wzorzec
```
<Imperative verb> <object> [<qualifier>]
```

**Czasowniki imperatywne** (pick one):
- Dodaj / Remove / Replace / Migrate / Refactor / Extract / Split
- Napraw / Fix (głównie bug fix)
- Zmień / Update (głównie modify)
- Zaimplementuj / Build (gdy tworzysz nowe)

**Unikaj**:
- "Investigate" bez kontekstu ("Investigate performance issue")
- "Look at" / "Check out" / "See if..."
- "Improve" / "Optimize" (co konkretnie?)
- Nazwy własne bez wyjaśnienia ("FB integration")

---

## 6. Anty-patterny (i co je zastąpić)

### 1. Task jako jedno zdanie
❌ "Dodaj SSO"
✅ Cały template z sekcji 2 — min. Why, AC, Out of scope.

### 2. Kopia wymagań bez translacji
❌ "Jako klient chcę bezpiecznie zalogować się do systemu"
✅ To jest nagłówek, nie opis. Pod spodem: "Endpoint POST /auth/login z rate-limit 5/min/IP, hashowanie bcrypt cost 12, lockout po 5 próbach, MFA przez TOTP dla ról admin/operator."

### 3. Brak Out of Scope
❌ Sekcja "Scope" ma 20 punktów "in", zero "out".
✅ Even a single line "Out of scope: nic, minimal change" zmusza autora do myślenia.

### 4. AC = powtórzenie scope
❌ AC: "User może się zalogować. System wyświetla błąd gdy złe hasło."
✅ AC muszą być testowalne i konkretne: "Given user podał błędne hasło 5x, When klika Login, Then wyświetla się captcha + licznik 'Spróbuj ponownie za 30s'."

### 5. Zero linków do kontekstu
❌ "Zrób to jak w innych projektach"
✅ Link do ADR, design doc, Slack thread, Figma — cokolwiek.

### 6. "Just figure it out"
❌ "Dodaj cache do API. Powodzenia."
✅ "Cache Redis z TTL 60s dla GET /products/{id}, invalidacja przy POST/PUT/DELETE na /products. Biblioteka: django-redis (5.x). Dlaczego: response time 400ms → plan 50ms."

### 7. Hidden dependencies
❌ "Zrób feature flag dla nowego flow" (nie mówi, że potrzebuje narzędzia, konta w LaunchDarkly, konfiguracji w 3 miejscach)
✅ "Feature flag `new-checkout-v2` w LaunchDarkly — potrzebne: konto dev (mam, dałem dostęp), default off w produkcji, on w stagingu. Env var: `LAUNCHDARKLY_SDK_KEY` jest już w vault."

### 8. Brak owner / reviewer
❌ Task nie ma przypisanego nikogo.
✅ Pole "Owner" (kto odpowiada) + "Reviewer" (kto sprawdza wynik). Jasne: owner pisze kod, reviewer odpowiada za jakość.

### 9. "ASAP" / "URGENT" bez kontekstu
❌ Priority = Urgent, bez wyjaśnienia.
✅ Priority + reason: "Urgent, bo client X ma demo w piątek i musi zobaczyć feature Y. Jeśli się nie uda, wracamy do fallback Z."

### 10. Task, który jest spotkaniem
❌ "Przegadać z teamem design nowego flow"
✅ To jest spotkanie, nie task. Stwórz calendar event + decision log. Task = wykonanie decyzji ze spotkania.

---

## 7. Jak wygląda dobry task — przykład kompletny

**Tytuł**: Dodać rate-limit 100 req/min dla POST /auth/login per IP

```markdown
## Why
Aktualnie POST /auth/login nie ma rate-limitu. Wykryliśmy próbę brute-force
w nocy z 12.06 → 13.06 (2.4k requestów z 3 IP). Chcemy zabezpieczyć endpoint
zanim wdrożymy nowe flow logowania (Epic AUTH-12).

Link: ADR-0042 (rate-limiting strategy), Slack #sec-incidents thread z 14.06.

## Who
- Primary: atakujący bot próbujący brute-force (z perspektywy systemu)
- Secondary: legit user, który zapomniał hasła (nie może zostać zablokowany
  na stałe)

## What
### In scope
- Rate-limit 100 req/min per IP dla POST /auth/login
- Po przekroczeniu: HTTP 429 z `Retry-After` header
- Licznik w Redis (key: `ratelimit:login:<ip>`, TTL 60s)
- Dla IP zaufanych (whitelist w config): brak limitu

### Out of scope
- Rate-limit na inne endpointy (osobny task AUTH-45)
- CAPTCHA (osobny task AUTH-46)
- Blokada konta po N próbach (osobny task AUTH-47)

## Acceptance Criteria
Given IP 1.2.3.4 wysłał 99 requestów w ciągu 60s
When wysyła 100. request
Then zwraca HTTP 429 z `Retry-After: <seconds-to-window-end>`
And licznik nie rośnie powyżej 100

Given IP 1.2.3.4 wysłał 100 requestów w ciągu 60s i czeka 61s
When wysyła następny request
Then request się powodzi (HTTP 401, bo złe hasło, ale NIE 429)

Given IP jest w `RATELIMIT_WHITELIST` env var
When wysyła 200 requestów w ciągu 60s
Then żaden nie zwraca 429

## Definition of Done
- [ ] Code review przez @senior-dev
- [ ] Testy jednostkowe: 100% pokrycia logiki rate-limit
- [ ] Test integracyjny: symulacja 100 req, weryfikacja 429
- [ ] Doku /docs/security/rate-limiting.md zaktualizowana
- [ ] Metryka Prometheus: `auth_login_rate_limited_total` dodana
- [ ] Deployed na staging, manual test przeszedł

## Technical notes
- Biblioteka: `slowapi` (FastAPI) lub `flask-limiter` (Flask) — wybierz zgodnie ze stackiem
- Redis: używamy istniejącej instancji (REDIS_URL w vault)
- Konfiguracja: `RATELIMIT_LOGIN_PER_MIN=100`, `RATELIMIT_WHITELIST=10.0.0.0/8,...`
- Logging: loguj WSZYSTKIE 429 z IP, user-agent, timestamp (do SIEM)

## Dependencies
- Brak blokad zewnętrznych. Redis dostępny w każdym env.

## Risks / Open questions
- Co jeśli Redis padnie? (Decyzja: fail open, loguj warning. ADR-0042 sekcja 3.)
- Czy 100/min to dużo dla mobile app z retry? (Do weryfikacji z QA, owner: @qa-lead)

## Links
- ADR-0042: Rate-limiting strategy
- Figma: nie dotyczy (backend only)
- Slack: #sec-incidents 14.06
- Linear: AUTH-44 (parent), AUTH-12 (epic)
```

**Zasoby**: ten task to ~2 dni pracy seniora + 0.5 dnia review. Bez tych wszystkich sekcji byłby 5 dni (bo developer musiałby zgadywać, pytać, przerabiać).

---

## 8. Checklist pre-commit (dla autora taska)

Zanim klikniesz "Create" w Linear/Jira/GitHub, przejdź przez:

- [ ] Tytuł jasny, imperatywny, konkretny
- [ ] Why wypełnione — ktoś, kto nie był na spotkaniu, rozumie kontekst
- [ ] Who wskazane (persona albo system)
- [ ] In scope + Out of scope (oba)
- [ ] AC w formie testowalnej (Given/When/Then lub checklist)
- [ ] DoD dołączony (lub wskazanie na team-wide DoD)
- [ ] Tech notes: stack, biblioteki, linki
- [ ] Dependencies zidentyfikowane (w tym blokady)
- [ ] Risks / Open questions wymienione
- [ ] Owner + Reviewer przypisani
- [ ] Estymata: 1-2 dni jednego deva (jeśli więcej → rozbij, notatka 2)
- [ ] Priority + uzasadnienie
- [ ] Labels / tags (np. `bug`, `tech-debt`, `security`, `breaking-change`)

**Jeśli > 3 checkboxy odznaczone** → task nie jest gotowy do wzięcia. Zostaje w Backlog/Todo do uzupełnienia.

---

## 9. Narzędzia — co wspiera dobrą anatomię

| Narzędzie | Co daje | Kiedy użyć |
|-----------|---------|------------|
| **Issue templates** (GitHub, GitLab) | wymuszone sekcje | projekty open-source, niewielki zespół |
| **Linear cycles + projects** | parent/child, dependencies, blokery | mały/średni zespół, szybki flow |
| **Jira + schemes** | custom fields, workflows, screens | duże organizacje, compliance |
| **Notion / Confluence + Linear link** | dłuższe PRD obok tasków | skomplikowane features wymagające dużo kontekstu |
| **Shortcut (Clubhouse)** | Iterations, epics, stories | zespoły produktowe, planowanie kwartalne |
| **GitHub Projects v2** | custom fields, views, automation | zespoły blisko kodu, code-first |

**Klucz**: narzędzie ma **wymuszać** anatomię, nie tylko **pozwalać** na nią. Jeśli twój template pozwala na pustą sekcję AC — developer wypełni ją byle jak albo w ogóle.

---

## 10. Podsumowanie jednolinijkowe

> Task powinien być na tyle kompletny, żeby **obcy developer, bez kontekstu, mógł go zamknąć w 1-2 dni bez zadawania pytań** — i żeby wiedzieć, kiedy ma przestać.

To jest miara. Wszystko inne to optymalizacja pod konkretny kontekst (zespół, domena, skala).
