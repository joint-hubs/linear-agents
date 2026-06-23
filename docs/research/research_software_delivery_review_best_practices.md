---
type: research-note
status: active
tags: [type/research, area/methodology, topic/engineering, topic/delivery, topic/review, topic/quality, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_engineering_task_description_best_practices.md, research_task_decomposition_invest_spidr_vertical_slicing.md, research_reducing_developer_cognitive_load.md, research_software_project_planning_best_practices.md]
---

# Software delivery review — deep research

> Czwarta notatka z serii o planowaniu i dowozie w software (po planowaniu
> projektu, anatomii tasków, dekompozycji i cognitive load).
> Ta odpowiada na pytanie: **co, kiedy i jak review'ować** — od pojedynczego
> taska po cały portfel projektów — żeby maksymalnie odciążyć developerów
> i jednocześnie zachować jakość oraz uczenie się zespołu.
>
> Źródła: Accelerate (Forsgren/Humble/Kim — DORA), SPACE (Microsoft Research),
> Shape Up (Basecamp — hill chart, cool-down), conventionalcomments.org,
> Charity Majors (observability + blameless post-mortems), Will Larson
> (An Elegant Puzzle — staff engineering), Michael Nygard (ADR), Google
> Engineering Practices (code review), GitHub Docs (PR templates,
> CODEOWNERS), Linear docs (cycles), incident.io (incident review),
> Jason Yip (anti-patterns of agile), John Cutler (product reviews).

---

## TL;DR

1. **Review to pętla feedbacku, nie bramka.** Jego celem jest **walidacja + uczenie się + redukcja ryzyka** — nie kontrola ani biurokracja. Każdy review musi odpowiedzieć na pytanie "co zmienimy po jego wyniku?", inaczej jest ceremonią.
2. **Istnieje 5 poziomów agregacji review, każdy z innym celem i rygorem:**
   - **Task (PR/code review)** — correctness, security, fit
   - **Cycle/sprint** — demo + adaptacja
   - **Release** — go/no-go + post-release retro
   - **Project** — outcome vs. goals + lessons learned
   - **Portfolio** — strategic alignment + alokacja zasobów
3. **Nie każdy team potrzebuje każdego poziomu.** Solo / mały zespół = PR + miesięczna retro. Duży org = wszystkie pięć. Dobór rytuału do skali to klucz do uniknięcia "death by meetings".
4. **Nowoczesny PR review (2025-2026)** jest: mały (<400 LOC), async-first, z Conventional Comments, tierowany wg ryzyka, z AI jako pierwszą linią obrony (Copilot/CodeRabbit/Sourcery), z CODEOWNERS, z SLA na pierwszy response (<4h), z soft approvals (auto-merge po SLA bez blokerów). Cel: <24h od push do merge dla standardowych zmian.
5. **Największy anty-pattern to "review jako gatekeeping"** — kultura, w której approval staje się narzędziem władzy, a nie jakości. Drugi: "LGTM bez czytania" (rubber stamping). Trzeci: review zbyt wysokiego rygoru na wszystko (sprint review dla każdej mikro-zmiany). Czwarty: retro bez follow-through.

---

## 1. Czym jest review (a czym nie jest)

### Definicja robocza

**Software delivery review** = ustrukturyzowana ocena dostarczonej pracy, której celem jest:
- **Walidacja** — czy to, co dostarczyliśmy, spełnia kryteria (jakość, bezpieczeństwo, AC, dopasowanie do potrzeb)?
- **Uczenie się** — co nas zaskoczyło, co byśmy zrobili inaczej, jakie decyzje podjąć następnym razem?
- **Redukcja ryzyka** — jakie sygnały o problemach (technicznych, produktowych, operacyjnych) widzimy i co z nimi zrobimy?

### Czym review NIE jest

| Mylenie | Dlaczego to szkodliwe |
|---------|----------------------|
| Review = kontrola | Robi z review bramkę; ludzie zaczynają optymalizować pod "przejście review", nie pod jakość |
| Review = spotkanie statusowe | Wymiana info ≠ feedback; zero learningu |
| Review = QA | QA to walidacja pre-merge; review to nauka i decyzja |
| Review = kara za błędy | Zabija psychological safety; ludzie ukrywają problemy |
| Review = formalność | "Musimy mieć retro bo tak jest w Scrum guide" → puste rytuały |

### Dlaczego review w ogóle

Najsilniejsze argumenty (z badań i książek):

- **Accelerate** (Nicole Forsgren, Jez Humble, Gene Kim) — korelacja między jakością review (szczególnie code review i incident review) a wynikami delivery: deployment frequency, lead time, change failure rate, MTTR. To NIE korelacja między "ilością review" a wynikami — a między **jakością feedbacku i szybkością cyklu**.
- **Google's code review research** (Sadowski et al.) — code review w Google'u to mechanizm **transferu wiedzy** między autorem a reviewerem, nie tylko bug-finding. Średnio review w Google'u dodaje 60-90 min do cyklu, ale 30-40% review comments to teaching, nie bug reports.
- **Charity Majors (observability + blameless post-mortems)** — review (szczególnie incident review) jest nauką tylko wtedy, gdy jest blameless i action-oriented. "Blamestorming" niszczy trust i powoduje, że ludzie nie zgłaszają problemów.
- **Will Larson (An Elegant Puzzle)** — review na różnych poziomach agregacji służy różnym celom; pomieszanie poziomów (np. robienie "sprint review" dla każdego taska) to najczęstszy błąd.

---

## 2. Poziomy agregacji review — główna oś tej notatki

To jest klucz do odpowiedzi na pytanie "czy robić zbiorcze review, na jakim poziomie".

| Poziom | Co obejmuje | Kadencja | Główny cel | Kto uczestniczy |
|--------|------------|----------|------------|------------------|
| **Task (PR/code review)** | Pojedynczy commit/PR | per change | correctness, fit, security | autor + 1-2 reviewerów |
| **Cycle (sprint/iteration)** | 1-2 tygodnie pracy | tygodniowo/bi-weekly | demo, learning, adaptacja planu | zespół + (opcjonalnie) stakeholders |
| **Release** | Wersja idąca do użytkowników | per release | go/no-go, observability, comms | team + product + ops + security |
| **Project** | Cała inicjatywa (epic, duży feature) | koniec projektu | outcome vs goals, lessons learned | team + product + leadership |
| **Portfolio** | Wiele projektów / programów | kwartalnie/rocznie | strategic alignment, alokacja zasobów | leadership + PMs |

### Zasada doboru poziomów

**Dobierasz poziomy do skali i rytmu, nie kopiujesz wszystkich 5 jak Scrum guide każe.**

| Wielkość zespołu / organizacji | Zalecane warstwy review |
|-------------------------------|------------------------|
| Solo lub 1-2 osoby | PR review + miesięczna retro (siebie) |
| Mały zespół (3-6) | PR + bi-weekly cycle review + release review |
| Średni zespół (7-15) | PR + weekly cycle + release + project retro |
| Duży zespół (15-30) | + program-level review (cross-team dependencies) |
| Organizacja (30+) | + portfolio review (QBR + OKR + DORA trend) |

**Kryterium "kiedy potrzebuję nowego poziomu w górę"**: kiedy obecny review nie odpowiada na pytania, które się pojawiają. Np. zaczynasz widzieć, że cycle review to za nisko — bo pytania dotyczą cross-team dependencies. To sygnał, że potrzebujesz program-level.

### Kryterium "kiedy mogę zrezygnować z poziomu"

Kiedy review przestaje generować action items albo ludzie go traktują jak formalność. Nie każdy zespół potrzebuje np. release review, jeśli deploy = merge do main + auto-deploy + auto-rollback na błąd. Wtedy release review = code review na wyższym poziomie abstrakcji.

---

## 3. Task-level review — PR / code review (najczęstszy, najważniejszy)

### Cele PR review

1. **Correctness** — czy kod robi to, co powinien?
2. **Security** — czy nie wprowadzamy podatności?
3. **Fit** — czy pasuje do architektury, konwencji, wzorców?
4. **Test quality** — czy testy faktycznie pokrywają ryzyko?
5. **Knowledge transfer** — reviewer uczy się kodu, autor dostaje perspektywę

### Best practices (2025-2026)

#### A. Mały PR (<400 LOC, idealnie <200)

| Rozmiar PR | Czas review | Defect rate | Czy warto? |
|------------|-------------|-------------|------------|
| <100 LOC | 15-30 min | niska | tak |
| 100-400 LOC | 30-60 min | średnia | tak, jeśli clear scope |
| 400-1000 LOC | 1-2h | wysoka | lepiej rozbić |
| 1000+ LOC | 2h+ lub skip | bardzo wysoka | prawie nigdy nie warto |

**Dlaczego rozmiar ma znaczenie:**
- Powyżej 400 LOC reviewerzy zaczynają tracić fokus (cognitive load — patrz notatka 3)
- Reviewerzy robią "LGTM bez czytania" bo fizycznie nie są w stanie ogarnąć
- Większe PRy = więcej konfliktów merge, dłuższy cycle time

**Technika:** jeśli PR wychodzi duży, autor robi **self-review + stack of small PRs** zamiast jednego monolitu. Feature flags pozwalają dowozić duże features jako serię małych PRów.

#### B. Conventional Comments

Zamiast pisać "to mi się nie podoba", używasz standaryzowanych prefixów (https://conventionalcomments.org):

| Prefix | Znaczenie | Czy blokuje merge |
|--------|-----------|---------------------|
| `praise:` | docenienie czegoś dobrze zrobionego | nie |
| `nitpick:` | drobna preferencja stylistyczna | nie |
| `suggestion:` | propozycja zmiany, ale author decyduje | nie |
| `issue:` | konkretny problem do naprawienia | zwykle tak |
| `question:` | nie rozumiem, wyjaśnij | zależy |
| `thought:` | refleksja, niekoniecznie do zmiany | nie |
| `chore:` | drobna rzecz do ogarnięcia (np. literówka) | nie |

**Dlaczego to działa:** decouples **ton** from **intent**. "To jest słabe" brzmi inaczej niż "issue: to nie pokrywa edge case X". Upraszcza decyzję "czy blokuję merge czy nie".

#### C. Risk-tiered review depth

Nie każda zmiana wymaga tego samego rygoru.

| Typ zmiany | Required reviewers | Co sprawdzają | SLA |
|------------|---------------------|----------------|-----|
| Hotfix / security patch | 1 + security owner | poprawność, exploit | <2h |
| Refactor (no behavior change) | 1 senior + 1 zwykły | pokrycie testami, regres | <24h |
| New feature | 1 + CODEOWNERS | design, AC, testy | <24h |
| Breaking change / API | + architekt + product owner | ADR, migracja, comms | <48h |
| Infra / deploy | + SRE / DevOps | rollback, observability | <24h |

#### D. AI-assisted first pass

Nowoczesny stack (2025-2026):
- **GitHub Copilot Code Review** — generyczny komentarz do PR
- **CodeRabbit** — line-by-line review z kontekstem repo
- **Sourcery** — Python-focused, code quality
- **Graphite Reviewer** — incremental review na stackach
- **Cursor Bugbot** — bug hunting na PR

**AI review NIE zastępuje ludzkiego review.** Odciąża jednak od:
- Code style / formatting (już robione przez lintery)
- Naming conventions
- Prostych bugów (null check, off-by-one)
- Brakujące testy dla oczywistych ścieżek
- Hardcoded secrets / dependency issues

**Co zostaje człowiekowi:**
- Architectural fit
- Business logic correctness
- Edge cases specyficzne dla domeny
- "Czy to w ogóle powinniśmy tak zrobić?" (design critique)
- Knowledge transfer

#### E. Reviewer SLAs i soft approvals

**Twarda zasada: pierwszy response <4h business hours.** Jeśli reviewer nie odpowiedział w 4h → eskalacja do innego reviewera albo auto-notification.

**Soft approval pattern:**
- Reviewer ma 24h na zgłoszenie blocking comments
- Po 24h bez blockerów → autor może sam mergować
- Pilnuje reviewera, żeby nie trzymał PRów "na potem"
- Pilnuje autora, żeby nie czekał biernie

#### F. CODEOWNERS i automatyczny routing

Plik `.github/CODEOWNERS` (lub ekwiwalent) przypisuje review na podstawie ścieżek. Przykład:

```
# Security-sensitive
/secrets/         @security-team
/auth/            @security-team @platform-team

# Frontend
/web/             @frontend-leads
/mobile/          @mobile-leads

# Data
/migrations/      @data-team @platform-team
```

Efekt: PR automatycznie trafia do właściwych osób. Reviewer nie jest losowy — jest właścicielem tego kawałka systemu.

### Anty-patterny task-level review

| Anty-pattern | Sygnał | Fix |
|--------------|--------|-----|
| LGTM bez czytania | review time <2 min dla dużego PRa | skill review; pilnować rozmiaru PRów |
| Bikeshedding | 20 komentarzy o nazewnictwie, 0 o logice | Conventional Comments; review checklist |
| Nitpick-only reviewer | wszystko "nitpick:", zero "issue:" | feedback loop z reviewerem |
| Approval-junkie | author potrzebuje 4 LGTM zanim cokolwiek | risk-tiered depth; soft approvals |
| Stale PR | PR siedzi 2 tygodnie, potem mega-conflict | SLA na re-review, rebase lub close |
| Review as punishment | niechciane PRy dostają 100 komentarzy | review to teaching, nie broń |

---

## 4. Cycle / Sprint review

### Stara wersja (Scrum guide)

- Demo dla stakeholderów pod koniec sprintu
- Prezentacja co zrobiliśmy
- Feedback od product ownera
- Planning następnego sprintu

### Nowoczesne warianty

#### A. Shape Up cool-down (Basecamp)

**Brak formalnego review.** Ostatnie 2 tygodnie 6-tygodniowego cyklu to "cool-down":
- Zespół kończy co zaczęło
- Fix bugi, które wyszły
- Wewnętrzna retro (nie dla stakeholderów)
- Pitch dla następnego cyklu (wewnętrzny, "shaping")

**Kiedy stosować:** małe zespoły, szybki flow, brak zewnętrznych stakeholderów wymagających demo.

#### B. Show-and-tell async

Zamiast spotkania — nagranie (Loom) lub demo środowiska + pisemna notka. Ludzie oglądają / czytają async, komentarze w komentarzach.

**Kiedy:** rozproszone zespoły, stakeholdrzy którzy nie chcą / nie mogą być na spotkaniach.

#### C. Lightweight retro + demo (≤45 min)

Struktura:
- 15 min: demo działającego softu (nie slajdy — działający feature)
- 15 min: co poszło dobrze / co źle / co zmieniamy
- 15 min: planning następnego cyklu (jeśli trzeba)

**Kiedy:** standardowy zespół produktowy, regularni stakeholdrzy.

#### D. Outcome-focused review

Zamiast "co zrobiliśmy" (output), pytanie "czy osiągnęliśmy outcome?":
- Jakie metryki się zmieniły?
- Co się nauczyliśmy o użytkownikach?
- Co zaskoczyło?
- Czy potrzebujemy pivot?

**Kiedy:** discovery-heavy produkty, ciągłe eksperymentowanie.

### Anty-patterny cycle review

| Anty-pattern | Sygnał | Fix |
|--------------|--------|-----|
| Slajdy zamiast demo | "tutaj widać wykres" (nie widać) | demo działającego softu albo nie ma review |
| Performance theater | prezentujemy co zrobiliśmy, nie co się nauczyliśmy | pytanie "co zaskoczyło?" zamiast "co zrobiliśmy?" |
| Stakeholder overload | 12 osób na review, 3 mówią, 9 się nudzi | zapraszać wg potrzeby, nie zawsze wszystkich |
| Retro bez zmian | 3 sprinty te same problemy | follow-through na action items, owner dla każdego |
| Planning w review | cycle review przeradza się w planning | osobne spotkanie albo koniec cyklu = scope freeze |

---

## 5. Release review

### Dwa podtypy

#### A. Release readiness review (pre-release)

Spotkanie decyzyjne: czy wypuszczamy tę wersję?

**Checklist:**

| Kategoria | Co sprawdzamy |
|-----------|----------------|
| **Scope** | zamrożony, znany, wszystko przetestowane |
| **Quality** | testy przeszły, brak krytycznych bugów, code review skończone |
| **Security** | skan zależności, secret scan, threat model dla istotnych zmian |
| **Observability** | metryki, logi, alerty dla nowego kodu są na miejscu |
| **Rollback** | jak wracamy? ile to trwa? kto decyduje? |
| **Feature flags** | dark launch / progressive rollout / kill switch |
| **Dokumentacja** | release notes, API docs, runbook dla supportu |
| **Comms** | kto wie? (support, marketing, klienci)? co powiemy jeśli coś pójdzie nie tak? |
| **Compliance** | jeśli regulowane: DPIA / audit log / data residency |
| **Load testing** | dla zmian infra / API: test wydajności |

**Kto:** tech lead + product owner + SRE/DevOps + security (jeśli istotne) + support lead.

**Format:** decyzja go/no-go w 30-60 min. Każdy uczestnik deklaruje status dla swojej kategorii (green/yellow/red).

#### B. Post-release review

Robiony **1-2 tygodnie po release**, gdy mamy już dane z produkcji:

- **Co poszło dobrze** — process, communication, technical decisions
- **Co poszło źle** — bugi które wyszły, problemy operacyjne
- **Co zaskoczyło** — user behavior, performance, integracje
- **Metryki** — adoption, errors, perf vs. baseline
- **Action items** — co zmienimy przed następnym release

**Kiedy pominąć:** jeśli release był trywialny (minor patch, library bump) i nie ma nic do omówienia.

### Anty-patterny release review

| Anty-pattern | Fix |
|--------------|-----|
| Release review jako formalność ("i tak wypuszczamy") | jeśli zawsze tak jest, albo nie robimy review, albo nie mamy realnego procesu release |
| 3-godzinna telenowela o każdym PR | risk-tiered — pełen review tylko dla risky changes |
| Brak rollback planu | bez tego nie ma release review, kropka |
| Comms jako afterthought | comms plan jest częścią checklisty, nie "ogarniemy to potem" |

---

## 6. Post-incident review (blameless post-mortem)

### Kiedy

- Każdy incydent SEV-1 lub SEV-2
- Bliski miss (near miss) — coś prawie się stało
- Pożądane: co X tygodni aggregated review trendów incydentów (mniej formalnie)

### Struktura (incident.io, Atlassian, Google SRE)

1. **Summary** — co się stało, jak długo trwało, jaki wpływ (users, $, reputacja)
2. **Timeline** — rekonstrukcja chronologiczna z timestampami
3. **Root cause** — 5 whys albo fault tree analysis; **system, nie ludzie**
4. **Contributing factors** — co sprawiło, że to było możliwe (process, tooling, training, architecture)
5. **What went well** — co zadziałało dobrze (np. alert się odpalił w 30s)
6. **What went wrong** — gdzie system zawiódł
7. **Action items** — concrete changes z ownerami i datami
8. **Lessons learned** — szersza refleksja (1-3 bullet pointy)

### Kluczowa zasada: blameless

**Nie pytamy "kto to zrobił?". Pytamy "co sprawiło, że to było możliwe do zrobienia?"**

- "Adam źle napisał migrację" → "Jakie braki w naszym review process sprawiły, że ta migracja przeszła bez wykrycia?"
- "Operator kliknął zły przycisk" → "Dlaczego ten przycisk był dostępny dla operatora w tym momencie?"

**Dlaczego blameless:**
- Ukrywanie błędów (ludzie nie zgłaszają problemów)
- Degradacja trustu (ludzie nie chcą być w on-call)
- Mylenie symptomu z przyczyną (ludzie to symptom, system to przyczyna)

### Action items z ownerami

Każdy action item musi mieć:
- **Konkretna zmiana** — nie "poprawić monitoring" tylko "dodać alert na latency >500ms w user-api"
- **Owner** — jedna osoba, nie "team"
- **Deadline** — data albo sprint
- **Priority** — P0/P1/P2

**Post-mortem bez action items to dokument historyczny.** Może być wartościowy (np. dla compliance), ale nie zmienia systemu.

### Anty-patterny post-mortem

| Anty-pattern | Fix |
|--------------|-----|
| Blame storming | facilitator + ground rule "no names" |
| 30-stronicowy dokument nikt nie czyta | max 2 strony, format timeline |
| Action items bez ownera | owner albo nie ma itemu |
| "naprawimy to" bez daty | data albo item umiera |
| Tylko SEV-1 review | aggregated trend review SEV-3/4 co kwartał |

---

## 7. Project retrospective (koniec inicjatywy)

### Różnica vs. cycle retro

| Cecha | Cycle retro | Project retro |
|-------|-------------|---------------|
| Scope | 1-2 tygodnie | tygodnie-miesiące |
| Pytanie | co zmieniamy w następnym cyklu | co zostawiamy, co zmieniamy na poziomie organizacji |
| Uczestnicy | zespół | zespół + product + leadership |
| Częstotliwość | co cycle | raz na inicjatywę |

### Struktura

1. **Outcome vs. goals** — co sobie obiecaliśmy, co dostarczyliśmy, dlaczego różnica?
2. **Decyzje architektoniczne** — które ADRs się sprawdziły, które chcielibyśmy zmienić
3. **Co nas zaskoczyło** — użytkownicy, technologia, organizacja, rynek
4. **Co zostawiamy** — patterns, narzędzia, dokumentacja godna ponownego użycia
5. **Co zabieramy** — anty-patterns, decyzje do odwrócenia, narzędzia do zastąpienia
6. **Hand-off** — co przechodzi do ongoing operations, kto to przejmuje
7. **Lessons learned (1 strona)** — dla przyszłych projektów

### Kiedy robić

- **Zawsze** dla projektów > 3 miesiące lub > 5 osób
- **Czasem** dla mniejszych (jeśli czujesz że było dużo learningu)
- **Nigdy** dla inicjatyw < 2 tygodnie — to overkill, cycle retro wystarczy

### Kto prowadzi

Najlepiej **facilitator spoza zespołu** (żeby uniknąć "my wiemy co poszło źle, ale nie chcemy mówić wobec kolegów"). W małych zespołach — rotacja wewnętrzna.

---

## 8. Portfolio / strategic review

### Poziomy strategiczne

#### A. OKR review (kwartalny)

- Czy osiągnęliśmy Objectives?
- Które Key Results są zagrożone?
- Co przenosimy do następnego kwartału?
- Które bety się nie sprawdziły — co z tego wynika?

#### B. QBR (Quarterly Business Review)

- Przegląd projektów z perspektywy biznesowej
- ROI / impact poszczególnych inicjatyw
- Alokacja zasobów (ludzie, budżet) na następny kwartał
- Pipeline nowych inicjatyw

#### C. Annual strategic review

- Długoterminowe trendy (DORA metrics year-over-year)
- Architektura: czy nasza strategia technologiczna działa?
- People: rozwój zespołu, retention, rekrutacje
- Market: czy nasz kierunek produktowy ma sens?

### Kto bierze udział

Leadership (CTO, CPO, CEO) + senior engineers / staff+ + product leads + finance.

### Anty-patterny strategic review

| Anty-pattern | Fix |
|--------------|-----|
| Slajdy bez danych | DORA / SPACE / metryki biznesowe, nie narracja |
| "Wszystko super" reviews | brak trustu, ludzie nie mówią o problemach | psychological safety starts at top |
| Raz w roku, potem 11 miesięcy ciszy | krótkie monthly/quarterly + retro na końcu |
| Decyzje bez ownera | każda decyzja strategiczna = konkretny action |

---

## 9. Nowoczesne frameworki i metryki

### DORA metrics (Accelerate)

Cztery metryki delivery performance:

| Metryka | Co mierzy | Elite performer |
|---------|-----------|----------------|
| **Deployment Frequency** | jak często wypuszczamy | on-demand (wiele razy dziennie) |
| **Lead Time for Changes** | od commit do production | <1h |
| **Change Failure Rate** | % deployów powodujących incydenty | 0-15% |
| **MTTR (Mean Time to Recovery)** | jak szybko naprawiamy | <1h |

**Ważne:** DORA mierzy **team-level** performance. Nie da się ich "zoptymalizować" bez poprawy review process, automation i culture.

**Wykorzystanie w review:**
- DORA trend w quarterly/annual review
- Regresja którejś metryki = sygnał do root cause analysis
- Benchmarking (DORA report co rok) — czy jesteśmy elite / high / medium / low

### SPACE framework (Microsoft Research)

Pięć wymiarów developer productivity (bo "productivity" nie jest jednowymiarowa):

| Wymiar | Co mierzy | Przykładowe metryki |
|--------|-----------|----------------------|
| **Satisfaction & well-being** | jak ludzie się czują | ankiety, retention, eNPS |
| **Performance** | outcome biznesowy | metryki produktowe związane z kodem |
| **Activity** | volume output | LOC, commits, PRs (z ostrożnością) |
| **Communication & collaboration** | jakość współpracy | review SLA, knowledge sharing, mtg density |
| **Efficiency & flow** | jak płynnie pracują | focus time, interruption rate, cycle time |

**SPACE w review:**
- NIE używać activity metrics (LOC/commits) do oceny ludzi
- Używać jako dyskusja systemowa: "mamy niskie satisfaction mimo że activity wysokie — dlaczego?"
- Kontekst > numer

### Shape Up hill chart

Wizualizacja kształtu pracy:
- **Uphill** — figuring out (research, design, niewiadome)
- **Downhill** — implementing (well-defined, wiadomo co robić)

**Wykorzystanie:** w cycle review zamiast burndown. Pokazuje **gdzie naprawdę jest praca** — nie ile % zostało.

**Kiedy warto użyć:** projekty z dużą niepewnością, R&D, eksploracja produktowa.

### Conventional Comments (conventionalcomments.org)

Omówione w sekcji 3.B.

### Trunk-based development (implicit review)

Kiedy wszyscy commitują do maina krótko żyjącymi branchami:
- PR review staje się codzienną rutyną
- Mniejsze PRy z natury (bo krótko żyją)
- Mniej konfliktów merge
- Wymaga silnej automatyzacji (CI, testy, auto-deploy)

**Trade-off:** mniej "control", więcej zaufania i automatyzacji. Działa dla zespołów z mature engineering practices.

---

## 10. Jak wybrać właściwy poziom review (decision tree)

```
Czy dostarczamy nowy kod do użytkowników?
├── NIE (wewnętrzne narzędzie / R&D) → code review wystarczy
└── TAK
    ├── Czy to trywialna zmiana (1-2 pliki, <100 LOC, niski risk)?
    │   ├── TAK → code review + auto-merge po SLA
    │   └── NIE
    │       ├── Czy zmienia API / breaking change?
    │       │   ├── TAK → code review + architekt + product + ADR
    │       │   └── NIE
    │       │       ├── Czy zmienia infra / deployment?
    │       │       │   ├── TAK → + SRE + observability review
    │       │       │   └── NIE → code review standard
    │       │       └── (po merge)
    │       │           ├── Czy zmiana jest user-facing?
    │       │           │   ├── TAK → release readiness review
    │       │           │   └── NIE → release opsjonalnie
    │       │           └── (po release)
    │       │               └── Post-release review (1-2 tyg. później)

Czy to koniec iteracji / cyklu?
├── TAK → cycle review (demo + retro)
└── NIE → kontynuuj

Czy to koniec inicjatywy (epic / duży feature)?
├── TAK → project retrospective
└── NIE → kontynuuj

Czy to koniec kwartału / roku?
├── TAK → portfolio review (OKR / QBR)
└── NIE → czekaj
```

**Klucz:** nie każda zmiana przechodzi przez wszystkie review. Większość = tylko task-level. Im wyżej, tym rzadziej.

---

## 11. Checklisty per poziom

### Checklist: PR review (autor PR)

- [ ] PR ma <400 LOC (jeśli więcej → rozbić lub feature flag)
- [ ] Tytuł jasny, opisuje CO + DLACZEGO
- [ ] Self-review zrobiony przed assignem
- [ ] Testy dodane / zaktualizowane
- [ ] CI zielone (lint, type, testy, security scan)
- [ ] Screenshots / recording jeśli UI
- [ ] Breaking changes oznaczone + ADR link
- [ ] Reviewer przypisany (CODEOWNERS / ręcznie)
- [ ] Conventional commits format

### Checklist: PR review (reviewer)

- [ ] Pierwszy response <4h business hours
- [ ] Używam Conventional Comments
- [ ] Sprawdzam: correctness, security, test quality, fit, naming
- [ ] Nie bikesheduję — pytam o istotne rzeczy
- [ ] Approve albo konkretne blocking comments
- [ ] Jeśli nie jestem pewny — mówię wprost ("nie czuję się kompetentny w tym obszarze")

### Checklist: cycle review (facilitator)

- [ ] Demo działającego softu (nie slajdy)
- [ ] Pytanie "co zaskoczyło?" + "co zmieniamy?"
- [ ] Action items z ownerami
- [ ] Czas trwania ≤ 45 min
- [ ] Zaproszeni wg potrzeby (nie "wszyscy bo tak")
- [ ] Notatka dostępna dla nieobecnych

### Checklist: release readiness

- [ ] Scope zamrożony
- [ ] Wszystkie PRy zmergowane + reviewed
- [ ] Testy przeszły (unit + integration + e2e)
- [ ] Security scan clean
- [ ] Observability w miejscu (metryki, logi, alerty)
- [ ] Rollback plan udokumentowany + przetestowany
- [ ] Feature flags / kill switch gotowe
- [ ] Comms plan (support, marketing, customers)
- [ ] Release notes gotowe
- [ ] Runbook dla supportu
- [ ] Go / no-go: każdy uczestnik deklaruje status

### Checklist: post-incident review

- [ ] Blameless (zero nazwisk w sekcji "root cause")
- [ ] Timeline z timestampami
- [ ] 5 whys (albo fault tree)
- [ ] Action items: konkretne + owner + deadline
- [ ] Co poszło dobrze (nie tylko co poszło źle)
- [ ] Notatka publicznie dostępna (wewnętrznie)
- [ ] Follow-up na action items z poprzednich post-mortemów

---

## 12. Jak odciążać developerów od review burden

### Automatyzacja mechanicznych checków

| Check | Narzędzie | Co odciąża |
|-------|-----------|------------|
| Format / lint | ESLint, Prettier, Black, gofmt | nitpicki stylistyczne |
| Type check | TypeScript, mypy, Go | proste bugi typów |
| Security scan | Snyk, Dependabot, CodeQL | dependency vulns |
| Secret scan | GitGuardian, TruffleHog | hardcoded keys |
| Test coverage | Codecov, Coveralls | brakujące testy (ale nie jakość) |
| Complexity | CodeClimate, SonarQube | over-complex code |

### AI first-pass

- Copilot Code Review, CodeRabbit, Sourcery — odciążają od "łatwych" uwag
- Człowiek focusuje się na: design, business logic, edge cases, knowledge transfer
- AI nie uczestniczy w approval — to zawsze człowiek

### Time-boxing

- Max 30-60 min na jedną sesję review
- Jeśli PR wymaga więcej → spotkanie 1:1 z autorem zamiast async ping-pong
- Reviewer ma prawo powiedzieć "potrzebuję X minut, wrócę do tego"

### Author quality

Najlepsza inwestycja w redukcję review burden to **lepsze PRy od strony autora**:
- Małe, jasne PRy
- Opis z kontekstem (link do taska, AC)
- Self-review PR przed assignem (autor często sam znajduje bugi)
- Testy + CI zielone przed review
- Draft PR dla wczesnego feedbacku zamiast gotowego PR

### Reviewer rotation

- Unikaj single point of failure ("jedyny senior który review'uje security")
- CODEOWNERS dla automatycznego routingu
- Pair review dla krytycznych zmian
- Reviewer nie jest bottleneckiem — jeśli 4h SLA nie działa, dodaj reviewera

### Bundle reviews

- 3 małe PRy w 30 min > 1 duży PR w 90 min
- Reviewer trenuje pattern recognition
- Lepszy sygnał o trendach (jeśli 5 PRów ma ten sam problem → systemic)

---

## 13. Narzędzia wspierające review

### Code review

| Narzędzie | Mocne strony |
|-----------|--------------|
| **GitHub PR + CODEOWNERS** | standaryzowane, darmowe, dobra integracja z Actions |
| **GitLab MR + approval rules** | lepsze dla self-hosted, regulacje |
| **Phabricator / Differential** | historycznie najlepszy stack-based review, mniej popularny |
| **Graphite** | stack-based PR, reviewer experience |
| **Gerrit** | open source, cięższy, dobry dla dużych orgów |
| **Cursor / Copilot Workspaces** | AI-assisted, inline review |

### Incident review

| Narzędzie | Mocne strony |
|-----------|--------------|
| **incident.io** | workflow, timelines, action items |
| **FireHydrant** | retrospectives + status pages |
| **Rootly** | modern incident management + retro |
| **Jeli / Notion templates** | lekkie, darmowe, do manual use |

### Engineering intelligence (DORA / SPACE)

| Narzędzie | Mocne strony |
|-----------|--------------|
| **LinearB** | DORA + workflow automation |
| **Swarmia** | DORA + productivity insights |
| **Waydev** | engineering analytics |
| **Sleuth** | DORA + deployment tracking |
| **Jellyfish** | portfolio-level engineering metrics |
| **Faros AI** | open source engineering intelligence |

### Cycle / project reviews

| Narzędzie | Mocne strony |
|-----------|--------------|
| **Linear cycles** | lekkie, wbudowane, dobre dla małych zespołów |
| **Jira + schemes** | customizowalne, dojrzałe, enterprise |
| **Shortcut (Clubhouse)** | iteracje, epiki, stories |
| **Notion + Linear** | dłuższe dokumenty + krótkie taski |
| **Retrium** | dedykowane retrospectives |

---

## 14. Anty-patterny — pełna lista

### Task-level

- **LGTM bez czytania** — reviewer nie ma czasu / kompetencji, klika approve
- **Bikeshedding** — 20 komentarzy o nazewnictwie, 0 o logice
- **Nitpick-only reviewer** — tylko drobiazgi, zero "issue:"
- **Mega-PR** — 1500 LOC, nikt tego nie przeczyta
- **Stale PR** — siedzi tygodnie, potem konflikt
- **Approval-junkie** — author potrzebuje 4 LGTM zanim cokolwiek
- **Review as gatekeeping** — reviewer używa approval jako władzy

### Cycle-level

- **Slajdy zamiast demo** — nikt nie widzi działającego softu
- **Performance theater** — prezentacja, nie nauka
- **Stakeholder overload** — 12 osób na review, 3 mówią
- **Retro bez follow-through** — te same problemy co kwartał
- **Planning w review** — review przeradza się w planning

### Release-level

- **Release review jako formalność** — i tak wypuszczamy
- **Brak rollback plan** — bez tego nie ma release
- **Comms as afterthought** — "ogarniemy to potem"
- **3-godzinna telenowela** — dla każdej zmiany pełen review

### Incident-level

- **Blame storming** — "to wina Adama"
- **30-stronicowy dokument** — nikt nie czyta
- **Action items bez ownera** — "team to ogarnie" = nikt
- **Tylko SEV-1 review** — brak aggregated trends
- **"Naprawimy to" bez daty** — item umiera

### Strategic-level

- **Slajdy bez danych** — narracja, nie metryki
- **"Wszystko super"** — brak trustu
- **Raz w roku** — 11 miesięcy ciszy
- **Decyzje bez ownera** — abstrakcyjne action items

---

## 15. Wybór review stack dla twojego zespołu

### Decision matrix

| Wielkość | Review layers | Rygor | Narzędzia |
|----------|---------------|-------|-----------|
| Solo | self-review + monthly retro | niski | GitHub PR, Notion retro |
| 2-5 osób | PR + bi-weekly retro | niski-średni | GitHub + Linear + Loom |
| 6-15 | PR + cycle + release + project retro | średni | GitHub + Linear + incident.io |
| 16-30 | + program-level review | średni-wysoki | + Confluence + DORA tooling |
| 30+ | + portfolio + QBR | wysoki | + Jellyfish/LinearB + strategic docs |

### Sygnały, że potrzebujesz nowego poziomu

- Cycle review zaczyna dotykać cross-team dependencies → potrzebujesz program review
- Incydenty powtarzają się mimo retros → potrzebujesz aggregated trend review
- Decyzje strategiczne są oderwane od delivery reality → potrzebujesz portfolio review z danymi DORA
- Code review staje się bottleneckiem → automatyzacja + AI + reviewer rotation

### Sygnały, że masz za dużo review

- Spotkania reviewowe nikt nie traktuje poważnie
- Action items nie są realizowane
- Ludzie pracują nad "przygotowaniem do review" zamiast nad kodem
- "Mamy release review co tydzień i nic z niego nie wynika"

---

## 16. Metryki jakości review

### Task-level

- **Time to first review** — <4h business hours (SLA)
- **Time to merge** — <24h dla standardowych, <48h dla ryzykownych
- **Review iterations** — ile rund review przed merge (cel: <2 dla prostych, <3 dla złożonych)
- **PR size** — median <400 LOC

### Cycle-level

- **Action item completion rate** — % action items zamkniętych w następnym cyklu (cel: >70%)
- **Retro attendance** — kto naprawdę jest i mówi
- **Outcome vs. goals** — czy osiągnęliśmy cel iteracji

### Release-level

- **Change failure rate** — % deployów wymagających rollback/fix (cel: <15% dla elite)
- **MTTR** — ile trwa naprawa (cel: <1h dla elite)
- **Rollback plan coverage** — % releasów z udokumentowanym rollback

### Incident-level

- **Time to post-mortem** — <5 dni roboczych od incydentu
- **Action item completion** — % zamkniętych w ustalonym terminie
- **Repeat incidents** — czy ten sam root cause się powtarza (powinno maleć)

### Portfolio-level

- **DORA trend** — czy metryki się poprawiają k/k i r/r
- **SPACE pulse** — czy satisfaction rośnie
- **OKR completion** — % osiągniętych Objectives

---

## 17. Podsumowanie jednolinijkowe

> Review jest jak pętla feedbacku w systemie sterowania — za mało feedbacku = dryfujesz bez kierunku, za dużo = controller overload i spowolnienie. Kluczem jest **review na właściwym poziomie agregacji, z właściwym rygorem, dla właściwej osoby, automatyzując resztę** — i pamiętając, że **każdy review bez action itemów to formalność**.

---

## 18. Źródła

- **Accelerate** (Nicole Forsgren, Jez Humble, Gene Kim) — DORA, research behind high-performing teams
- **An Elegant Puzzle** (Will Larson) — staff engineering perspective on review
- **Shape Up** (Ryan Singer, Basecamp) — hill chart, cool-down, cycles
- **SPACE** (Microsoft Research — Storey et al.) — developer productivity framework
- **conventionalcomments.org** — standard for review comments
- **Charity Majors** — blameless post-mortems, observability-first
- **Michael Nygard** — ADR (Architecture Decision Records)
- **GitHub Docs** — PR templates, CODEOWNERS, branch protection
- **incident.io blog** — modern incident review process
- **Linear docs** — cycles, project structure
- **Google Engineering Practices** — code review at scale (Sadowski et al.)
- **John Cutler** — product reviews, outcome vs. output
- **Jason Yip** — anti-patterns of agile at scale
- **Trunk Based Development** (https://trunkbaseddevelopment.com/) — review as part of trunk flow
- **Atlassian incident handbook** — post-mortem templates
- **Kelsey Hightower** — boring tech, review of infra changes
- **Charity Majors, Honeycomb** — observability before review

---

*Notatka powiązana z:*
- *[[research_software_project_planning_best_practices]] — jak planować*
- *[[research_engineering_task_description_best_practices]] — anatomia taska*
- *[[research_task_decomposition_invest_spidr_vertical_slicing]] — jak rozkładać*
- *[[research_reducing_developer_cognitive_load]] — jak odciążać*
- *Ta: jak review'ować*
