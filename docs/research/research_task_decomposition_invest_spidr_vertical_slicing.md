---
type: research-note
status: active
tags: [type/research, area/methodology, topic/engineering, topic/task-management, topic/agile, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
related: research_engineering_task_description_best_practices.md
---

# Engineering tasks — dekompozycja (INVEST, SPIDR, vertical slicing)

> Druga z trzech notatek o tym, jak kompleksowo opisywać pracę dla inżynierów.
> Ta: **jak rozkładać** duży scope na małe, dostarczalne taski.
> Pierwsza notatka (anatomia) jest warunkiem wstępnym.
> Trzecia notatka: jak odciążać cognitive load developerów.
>
> Źródła: Bill Wake (INVEST, Wikipedia), Mike Cohn / Mountain Goat Software
> (SPIDR, story splitting), Ryan Singer / Basecamp (Shape Up — hill chart, scope),
> David Parnas (software aging / evolutionary design, 1994),
> r/agile (vertical slicing jako "single most impactful practice"),
> Jeff Patton (User Story Mapping), NextAgile (vertical vs horizontal slicing),
> Visual Paradigm (granularity).

---

## TL;DR

1. **Dobry task = mały (1-2 dni), niezależny, testowalny, dostarczalny** — to jest esencja INVEST (Bill Wake, 2003).
2. **Jeśli task nie mieści się w 2 dniach → rozbij.** Trzy techniki rozbijania: **SPIDR** (5 wzorców), **vertical slicing** (pełna ścieżka przez stack), **story mapping** (wokół user journey).
3. **Vertical slicing > horizontal slicing** — nigdy nie rozbijaj na "frontend task / backend task / DB task". Zamiast tego: "user może wykonać jedną akcję end-to-end, choćby minimalnie".
4. **Scope ≠ effort.** Shape Up uczy: apetyt (ile czasu chcemy poświęcić) jest stały, scope jest zmienny. Jeśli task przerasta apetyt, **ucinamy scope**, nie rozciągamy czasu.
5. **Spike to nie jest story** — spike = research task z konkretnym pytaniem i czasem (max 1-2 dni). Jego wynikiem jest wiedza, nie kod produkcyjny.

---

## 1. Dlaczego rozkładanie jest ważne

### Co się dzieje, gdy task jest za duży

| Problem | Konsekwencja |
|---------|--------------|
| Nie da się estymować | "Będzie 2-3 tygodnie" = zero informacji |
| Nie da się zademonstrować | 0 value delivered przez 2 tygodnie |
| Blokuje review/QA | merge conflict hell |
| Łatwo scope-creep | "a może dorzucimy X" |
| Ryzyko porażki rośnie | im dłużej task żyje, tym więcej kontekst-switchingu |
| Nie da się równoleglić | jeden developer, dwa tygodnie, zero pomocy |

### Reguła kciuka

> **Jeśli task nie mieści się w 1-2 dniach jednego developera — rozbij.**

Wyjątki (kiedy NIE rozbijaj):
- To jest bug fix wymagający debugowania przez 3 dni — wtedy **podziel na debug spike + fix task**
- To jest migration bazy danych, która fizycznie wymaga 3 dni downtime — wtedy **podziel na fazy z rollback planem**

---

## 2. INVEST — sześć kryteriów dobrego Backlog Item

Bill Wake, 2003. Stosowane do każdego PBI (Product Backlog Item), ale idealnie sprawdza się dla engineering tasków.

| Litera | Kryterium | Pytanie kontrolne | Co się dzieje, gdy NIE spełnione |
|--------|-----------|-------------------|--------------------------------|
| **I** | Independent | Czy ten task można zrobić bez czekania na inny (albo można go przenieść w kolejności bez szkody)? | Coupling z innymi taskami → kolejność jest sztywna, nie da się priorytetyzować |
| **N** | Negotiable | Czy szczegóły implementacji są otwarte do dyskusji, czy task dyktuje rozwiązanie? | Sztywny task = brak ownership developera, "zrobiłem dokładnie co kazano" |
| **V** | Valuable | Czy po zakończeniu tasku ktoś (user / biznes) widzi wartość? | "Wartościowe tylko dla developera" = utility task ukryty w większym workum |
| **E** | Estimable | Czy da się podać rozsądną estymatę (1-2 dni, nie "2-3 tygodnie")? | Niestymowalny = za duży albo za mało zrozumiany (→ spike) |
| **S** | Small | Czy mieści się w 1-2 dniach pracy? | Za duży = rozkładaj (SPIDR, vertical slicing) |
| **T** | Testable | Czy da się napisać test/AC, który zweryfikuje ukończenie? | Nietestowalny = nie wiadomo kiedy skończone |

### Szybki test INVEST

Zadaj sobie te 6 pytań. Jeśli > 1 "nie" — masz dziurę:

1. Czy mogę zacząć ten task jutro, nawet jeśli task X się opóźni? (I)
2. Czy AC mówią CO, nie JAK? (N)
3. Czy po deployu zobaczę różnicę w produkcie albo metrykach? (V)
4. Czy wiem, czy to 4h czy 3 dni (±20%)? (E)
5. Czy to mniej niż 16h pracy developera? (S)
6. Czy umiem napisać test, który upadnie PRZED i zostanie GREEN PO? (T)

### Przykład: zły i dobry task

❌ **Źle**: "Zbudować system notyfikacji email dla wszystkich zdarzeń w systemie"
- Niezależny? Nie — wpływa na wszystkie moduły
- Dostarczalny? Nie — nie wiadomo co znaczy "zrobione"
- Mały? Nie — tygodnie pracy
- Testowalny? Nie — co testujemy?

✅ **Dobrze**: "Wysłać email z potwierdzeniem po pierwszym udanym logowaniu użytkownika"
- Niezależny? Tak — endpoint /auth/login istnieje
- Dostarczalny? Tak — user widzi email
- Mały? Tak — kilka godzin (templatka + integracja)
- Testowalny? Tak — mailcatcher/email-spec zweryfikuje

---

## 3. SPIDR — pięć sposobów na rozbicie za dużego story

Mike Cohn, Mountain Goat Software. Gdy user story jest za duży, użyj **jednego z pięciu wzorców**, żeby je podzielić.

| Litera | Wzorzec | Jak działa | Przykład |
|--------|---------|------------|----------|
| **S** | **Spike** | Wytnij research/wallet exploration jako osobny task | "Story: integracja z Allegro API. Spike: zbadać API i stwierdzić, czy sandbox istnieje, jakie limity, jaka autentykacja" |
| **P** | **Paths** | Rozbij po ścieżkach user journey | "Story: użytkownik może zapłacić. Paths: (a) karta, (b) BLIK, (c) przelew tradycyjny, (d) PayPal" |
| **I** | **Interface** | Rozbij po interfejsie | "Story: synchronizacja kalendarza. Interfaces: (a) Google Calendar, (b) Outlook, (c) iCal" |
| **D** | **Data** | Rozbij po typie danych | "Story: walidacja formularza. Data: (a) tylko wymagane pola, (b) + walidacja formatu (email/phone), (c) + walidacja biznesowa (unikalność nazwy)" |
| **R** | **Rules** | Rozbij po regułach biznesowych | "Story: rabaty. Rules: (a) jeden kod rabatowy, (b) wiele kodów stackowane, (c) automatyczne progi (5%, 10% przy 100zł)" |

### Kiedy którego użyć

- **Spike** — nie wiesz czego się nauczysz, zacznij od research (max 1-2 dni)
- **Paths** — user ma różne sposoby na zrobienie tego samego (warianty)
- **Interface** — system musi współpracować z różnymi providerami
- **Data** — walidacja/escalation w zależności od danych wejściowych
- **Rules** — złożone reguły biznesowe, które da się stopniować

### Spike — specjalny przypadek

**Cechy spike'a**:
- Cel: **wiedza**, nie kod (choć może powstać prototype)
- Limit czasowy: max 1-2 dni (po tym musi być decyzja)
- Wynik: dokument / decision log / prototyp w osobnym branchu
- Nigdy nie trafia do produkcji jako gotowy task

**Anty-pattern**: "Spike na cały tydzień" — to nie spike, to research task. Spike ma być krótki i dawać odpowiedź na jedno konkretne pytanie.

---

## 4. Vertical vs Horizontal slicing

### Horizontal slicing (złe)

Rozbicie wzdłuż warstw architektury:

```
Story: "Wdrożyć płatności"

  ├─ Task 1: Frontend — formularz karty
  ├─ Task 2: Backend — endpoint POST /payments
  ├─ Task 3: DB — schemat transakcji
  └─ Task 4: QA — testy integracyjne
```

**Problem**: żaden z tych tasków **nie ma wartości** sam w sobie. Wszystkie muszą być zrobione razem, żeby user mógł zapłacić. Brak wczesnej walidacji, brak feedbacku.

### Vertical slicing (dobre)

Rozbicie wzdłuż user journey — każdy slice przecina WSZYSTKIE warstwy:

```
Story: "Wdrożyć płatności"

  ├─ Slice 1: User może zapłacić kartą (najprostsza ścieżka)
  │   └─ FE: 1 formularz z polami karty
  │   └─ BE: 1 endpoint POST /payments (hardcoded Stripe key)
  │   └─ DB: 1 tabela transactions (id, amount, status)
  │   └─ AC: User wpisuje dane → widzi "Płatność zakończona sukcesem"
  │
  ├─ Slice 2: User może zapłacić BLIK
  │   └─ (analogicznie, dodaje BLIK provider)
  │
  └─ Slice 3: User otrzymuje email z potwierdzeniem
      └─ (dodaje async email queue)
```

**Zalety**:
- Każdy slice jest **deployable i testowalny**
- Po slice 1 user może już płacić (nawet jeśli tylko kartą)
- Feedback loop jest krótszy
- Scope creep jest trudniejszy (bo każdy slice to konkretna wartość)

### Kiedy horizontal NIE jest złe

- Refactor wewnętrzny (przeniesienie modułu z monolitu do mikroserwisu)
- Performance optimization (przebudowa cache layer)
- Tooling / infrastructure (CI/CD, observability)

W tych przypadkach nazwij to wprost "tech task" / "refactor task", nie ukrywaj za user story.

---

## 5. Story Mapping (Jeff Patton)

Story map = rozmieszczenie user stories wzdłuż **user journey** (oś pozioma) i priorytetów (oś pionowa).

### Struktura

```
                    Backbone       Slice 1 (MVP)        Slice 2           Slice 3
                    (aktywności)   (muszę mieć)        (fajnie mieć)     (kiedyś)
                    ════════════   ══════════════════   ════════════════   ════════════
                    ║             ║                   ║                  ║
Discover            ║  Wejście     ║ Rejestracja        ║ SSO              ║ Invitation
                    ║             ║ Email verify       ║                  ║
─────────────────────────────────────────────────────────────────────────────────────────
Explore             ║  Przegląd   ║ Lista produktów    ║ Filtry           ║ Sortowanie
                    ║             ║ Wyszukiwarka       ║                  ║
─────────────────────────────────────────────────────────────────────────────────────────
Decide              ║  Wybór      ║ Koszyk             ║ Porównywarka     ║ Recenzje
                    ║             ║ Checkout           ║                  ║
─────────────────────────────────────────────────────────────────────────────────────────
Act                 ║  Zakup      ║ Płatność kartą     ║ BLIK             ║ PayPo
                    ║             ║ Email potwierdzenie║                  ║
─────────────────────────────────────────────────────────────────────────────────────────
```

### Dlaczego to działa

- **Wizualizacja scope'u** — product owner widzi CAŁĄ mapę i wybiera, co w MVP
- **Vertical slicing naturalny** — każdy slice przecina user journey, nie warstwy
- **MVP staje się konkretny** — zamiast "MVP = rejestracja + koszyk + płatność", masz dokładne story w każdym slice
- **Anti-goals naturalne** — to co NIE jest w slice 1 = out of scope na ten release

### Output story map

Z story map wyciągasz:
1. **MVP** (slice 1) — gotowy do wydania, ma realną wartość
2. **Release 1.1** (slice 2) — ulepszenia
3. **Backlog** (slice 3+) — kiedyś

Każdy slice 1 → epics → user stories → engineering tasks (template z notatki 1).

---

## 6. Shape Up: Appetite vs Scope (Ryan Singer, Basecamp)

Klasyczne podejście: "Ile czasu to zajmie?" → estymata → deadline. Problem: estymaty się mylą, scope się rozrasta.

Shape Up odwraca: **ile czasu CHCESZ poświęcić?** → apetyt (np. 6 tygodni) → scope DOPIERAWTEDY dobierasz.

### Appetite categories (Basecamp)

| Appetite | Czas | Przykład |
|----------|------|----------|
| **Small** | 1-2 tygodnie | bug fix, mały feature |
| **Medium** | ~3 tygodnie | jeden flow |
| **Big** | 6 tygodni (pełen cykl Basecamp) | duży feature, nowa sekcja produktu |

### Kluczowa zasada

> **Scope jest zmienny. Czas (apetyt) jest stały.**

Jeśli task / feature nie mieści się w apetyt — **ucinamy scope**, nie rozciągamy czasu.

### Zastosowanie do engineering tasks

Nawet dla małych tasków: zamiast pytać "ile to zajmie", pytaj **"czy zmieszczę się w 1-2 dniach?"**. Jeśli nie — co mogę wyciąć, żeby zmieścić się w 1-2 dniach i zachować wartość?

Przykład:
- Apetyt: 1 dzień
- Pełna wersja: pełny system cache'owania z Redis, TTL per resource, invalidacja
- Cięcie scope: **tylko cache dla GET /products (najczęstszy endpoint), TTL hardcoded 60s, bez invalidacji (TTL ją wymusi)**

Wersja okrojona jest wciąż wartościowa (przyspiesza najczęstszy endpoint) i mieści się w apetyt.

---

## 7. Praca z Spike'ami (research taski)

### Kiedy spike jest potrzebny

- Nie wiesz czy dane API istnieje / jakie ma limity
- Nie wiesz jaką technologię wybrać (postgres vs mongo dla use case X)
- Nie wiesz jakie metryki są dostępne
- Nie wiesz jaki jest realny performance baseline

### Template spike'a

```markdown
# Spike: [konkretne pytanie]

## Pytanie
[Konkretne pytanie, na które szukamy odpowiedzi. NIE "zbadaj X" — pytanie ma być precyzyjne]

## Dlaczego teraz
[Blokujemy task Y bez tej odpowiedzi. Bez niej nie mogę podjąć decyzji.]

## Co zrobię w ramach spike
[Konkretne aktywności: przeczytać docs, zrobić prototype, zmierzyć wydajność]

## Timebox
[Max 1-2 dni. Po tym czasie MUSI być decyzja.]

## Output
- [ ] Decyzja zapisana w ADR lub decision log
- [ ] Link do prototype (jeśli istnieje)
- [ ] Lista ryzyk/open questions (jeśli zostały)
```

### Anty-patterny spike'ów

- ❌ Spike bez timeboxu ("research na ile trzeba")
- ❌ Spike, którego wynikiem jest "zbadajmy dalej" (brak decyzji)
- ❌ Spike prowadzony równolegle z developmentem (zamiast przed)
- ❌ Spike, który staje się produkcyjnym kodem (powinien być wyrzucony po wyciągnięciu wniosków)

---

## 8. Heurystyki dekompozycji — szybkie reguły

| Sygnał | Akcja |
|--------|-------|
| Estymata > 2 dni | Użyj SPIDR (Spike/Paths/Interface/Data/Rules) |
| Story wymaga 3+ warstw (FE+BE+DB+DevOps) | Sprawdź czy to nie jest za szerokie (vertical slice) |
| Wszystkie AC są podobne ("system X działa") | Brak konkretu — zadaj pytanie "co konkretnie user widzi?" |
| Story nie ma wyraźnego "done" | Brak testowalności — zdefiniuj AC w Given/When/Then |
| Story jest zależne od innego, ale ma własną wartość | Zostaw osobno, ale zaznacz dependency |
| Story to "tech debt" albo "refactor" | Nazwij to wprost, nie ukrywaj za user story |
| Story = konfiguracja/infrastructure | To jest task, nie story. Nazwij "task: skonfigurować X" |
| Story wymaga designu, którego nie ma | Designer needed → zatrzymaj story, poproś o design |
| Story wymaga decyzji architektonicznej | Zatrzymaj story, zrób ADR, potem kontynuuj |

---

## 9. Work Breakdown Structure (tradycyjne podejście)

Dla completeness — klasyczne podejście z project management. Mniej popularne w nowoczesnym Agile, ale przydatne w dużych, linearnych projektach (np. migracja systemu, infrastructure overhaul).

```
1. Migracja bazy danych z MySQL do Postgres
   1.1. Setup nowej instancji Postgres
       1.1.1. Provision VM
       1.1.2. Install Postgres 16
       1.1.3. Configure replication
       1.1.4. Setup backup (pgBackRest)
   1.2. Schema migration
       1.2.1. Zrzut schemy z MySQL
       1.2.2. Konwersja typów (ENUM, JSON)
       1.2.3. Konwersja procedur składowanych
       1.2.4. Walidacja diff (narzędzie: pgquarrel)
   1.3. Data migration
       1.3.1. Strategia: dump + restore + ETL dla brakujących
       1.3.2. Test migracji na próbce 1M rekordów
       1.3.3. Test migracji na pełnym dumpie (staging)
       1.3.4. Walidacja row count + checksum
   ...
```

### Kiedy WBS jest właściwe

- Migration / cutover (Big Bang)
- Infrastructure projects (network, hardware)
- Compliance / regulatory projects (wymagają śladu)
- Projekty z wieloma vendorami, którzy potrzebują jasnego podziału

### Kiedy WBS jest niewłaściwe

- Continuous product development (użyj story mapping)
- Innowacyjne projekty (nie wiadomo co odkryjesz) (użyj spike + vertical slicing)
- Małe zespoły (overhead nie jest warty)

---

## 10. Drabinka hierarchii (pełny obraz)

```
Epic (tygodnie-miesiące)
  └─ Feature (dni-tygodnie)
       └─ User Story (1-2 dni vertical slice)
            ├─ Task 1: schema migration
            ├─ Task 2: API endpoint
            ├─ Task 3: UI form
            └─ Task 4: test e2e
       └─ User Story (kolejna ścieżka user journey)
            └─ ...
       └─ Spike (research, max 1-2 dni)
            └─ Output: ADR + decision
```

**Zasada**: na KAŻDYM poziomie hierarchii pytanie "czy to widać dla użytkownika?" jest filtrem. Jeśli odpowiedź brzmi "nie" na poziomie user story → to tech task, nie story.

---

## 11. Checklista pre-dekompozycja

Przed rozbiciem dużego scope, zadaj:

- [ ] Czy mam pełny obraz user journey? (Jeśli nie → spike "user journey mapping")
- [ ] Czy wiem co jest w MVP? (Jeśli nie → story mapping session z PO)
- [ ] Czy mam design / wireframes? (Jeśli nie → designer needed)
- [ ] Czy zespół zgadza się na apetyt? (Jeśli nie → scope discussion z PO)
- [ ] Czy są zewnętrzne zależności? (Vendor API, compliance, inny team)
- [ ] Czy jest "must-have" część, którą mogę zrobić szybko? (Często to slice 1)

---

## 12. Podsumowanie jednolinijkowe

> **Dobry task jest na tyle mały, że nie wymaga spotkania żeby go zrozumieć, i na tyle duży, że dostarcza jedną konkretną wartość.**
