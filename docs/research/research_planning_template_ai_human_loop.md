---
type: design-doc
status: draft
tags: [type/design-doc, area/methodology, topic/planning, topic/ai, topic/human-in-the-loop, topic/linear]
created: 2026-06-19
updated: 2026-06-19
source: synthesis-from-research
maturity: design-v1
companion_to:
  - research_software_project_planning_best_practices.md
  - research_roadmapping_patterns.md
  - research_task_decomposition_invest_spidr_vertical_slicing.md
  - research_engineering_task_description_best_practices.md
  - research_reducing_developer_cognitive_load.md
  - research_estimation_techniques.md
  - research_llm_models_for_planning.md
related:
  - research_planning_tools_2026.md
  - research_llm_models_for_software_development.md
---

# Planning Template — AI-executed z human-in-the-loop (v1)

> Synteza 7 notatek researchowych z 2026-06-19 + review pomysłu Mateusz:
> "Linear = bridge między plannerem (AI) a developerem (AI agent / ja),
> subtasks = najmniejsze możliwe taski z pełnym kontekstem,
> input = notatka głosowa + artefakty (md, txt, docx export)".
>
> Ten dokument: design systemu, który to egzekwuje. Powtarzalny,
> skalowalny, z HITL.

---

## Część 1 — Review pomysłu Mateusz

### Co jest mocne
1. **Linear jako bridge** — naturalny wybór (już w stacku, ma Cycles/Initiatives/Roadmap 2025+, subtasks). To nie jest nowe narzędzie do nauki.
2. **Subtask hierarchy** — pasuje do drabinki Epic → Story → Task z research. Parent = kontekst, subtasks = konkretne kroki.
3. **"Smallest possible tasks"** — zgadza się z INVEST (Bill Wake) i vertical slicing (Singer/Patton).
4. **Voice + artifacts** — voice = discovery (jobs-to-be-done), artifacts = reference material (ADRs, code snippets, requirements). Dobre pokrycie spectrum inputów.
5. **AI as planner, human as approver** — to jest właściwy podział pracy. AI świetnie radzi sobie z decomposition, človek z kontekstem strategicznym.

### Co jest słabe / ryzykowne (i jak to naprawić)

**Problem 1: "Smallest possible" bez dolnej granicy = overhead.**
Jeśli task = 30 min, masz 50-100 subtasków/epic. Developer traci kontekst między nimi. Review jest dłuższe niż implementacja.
→ **Naprawa**: sweet spot to **0.5-2 dni kalendarzowe jednego developera**. Poniżej 4h = overhead, powyżej 3 dni = za duży. To jest granica z research (Wake, Cohn).

**Problem 2: "Pełen kontekst w każdym tasku" = rot.**
Kopiujesz brief do każdego subtaska → 50 kopii tego samego tekstu. Zmiana w parent = ręczna aktualizacja 50 tasków. To się rozjedzie w 2 tygodnie.
→ **Naprawa**: parent = pełen kontekst (Why, scope, outcomes, journey). Subtask = **delta + link do parenta + 1-2 zdania co ten task wnosi**. Nigdy nie kopiuj — zawsze linkuj. (Patrz `research_reducing_developer_cognitive_load.md` §3: pre-loaded context.)

**Problem 3: Brama discovery nie istnieje.**
Co się dzieje, jeśli AI nie ma wystarczającego kontekstu do zaplanowania (np. brak access do repo, brak decyzji architektonicznej)? Kto blokuje, kiedy pyta?
→ **Naprawa**: explicit **discovery gate** po STAGE 1. AI generuje brief + listę pytań. **Mateusz decyduje: approve / supply missing context / defer**. Bez approve — żadne taski nie powstają.

**Problem 4: Brak wyraźnej roli AI planisty vs. executora.**
"AI planuje" to za szerokie. Czy AI tylko dekomponuje? Czy też estymuje, priorytetyzuje, risk-identifiuje?
→ **Naprawa**: explicitna maszyna stanów (STAGE 1-6 w części 3), z ownership AI vs. human per etap.

**Problem 5: Voice input jest potężne, ale ma błędy.**
Wispr Flow = Whisper transcription. Polskie terminy techniczne (Linear API, KSeF, endpoint) bywają rozjechane. Brakuje feedback loop gdy AI źle zrozumiał intencję.
→ **Naprawa**: STAGE 2 (decomposition) ZAWSZE zaczyna od "co zrozumiałem z Twojej notatki: [parafrase]. Czy o to Ci chodziło?" — zanim wygeneruje taski.

**Problem 6: Brak enforcement w Linear.**
Linear sam w sobie nie wymusza template'u. Bez `description template` albo custom fields (AC, DoD, vertical_slice), ludzie wypełnią sekcje byle jak albo wcale.
→ **Naprawa**: 
- W Linear: Issue templates (per team/project) wymuszające sekcje
- Albo: Linear custom fields (AC, vertical_slice_id, slice_number, parent_brief_link)
- W AI workflow: validation step — task bez AC = odrzucony, nie utworzony

**Problem 7: HITL bottleneck risk.**
Jeśli Mateusz reviewuje każdy task = bottleneck. Jeśli AI tworzy 50 tasków bez review = chaos.
→ **Naprawa**: 3-poziomowy HITL (część 3, STAGE 2/5/6) — review tylko w krytycznych punktach, nie co task.

**Problem 8: Tool stack (języki/biblioteki) nie jest częścią scenariusza.**
Różnica między Python/ML task a React/Frontend task = inna architektura subtasków. ML = experiment-heavy (spike), Frontend = UI-heavy (vertical slice). Musi być explicit.
→ **Naprawa**: 3. wymiar scenariuszy (część 4) = tool profile. Wpływa na kształt subtasków.

---

## Część 2 — Esencja z research (7 zasad)

Z 7 notatek z 2026-06-19, wyciągam 7 zasad, które tworzą ten template:

### Z1. Plan = odpowiedź na 6 pytań (Cagan, PMI, Marty Cagan)
Każdy plan (parent epic) musi odpowiedzieć: **Why? Who? What (in/out)? How measured? When? What can go wrong?** Jeśli choć jedno brakuje — plan jest dziurawy.

### Z2. Decomposition = vertical slicing, nie horizontal
Nigdy nie rozbijaj na "FE task / BE task / DB task". Zamiast tego: **"user może wykonać jedną akcję end-to-end, choćby minimalnie"**. Każdy slice przecina WSZYSTKIE warstwy. To jest zasada #3 z `research_task_decomposition_invest_spidr_vertical_slicing.md`.

### Z3. Dobry task = 0.5-2 dni, nie "najmniejszy możliwy"
Sweet spot: 1-2 dni kalendarzowe. Poniżej 4h = overhead (context switching > wartość). Powyżej 3 dni = rozbijaj (SPIDR: Spike/Paths/Interface/Data/Rules).

### Z4. Context = parent + delta
Parent = pełen kontekst (Why, scope, outcome, journey). Subtask = **delta do parenta + link + AC**. Nigdy nie kopiuj pełnego kontekstu — zawsze linkuj.

### Z5. AC + DoD + DoR = trójwarstwowa definicja
- **Acceptance Criteria (AC)** — specyficzne dla taska (Given/When/Then).
- **Definition of Done (DoD)** — wspólne dla projektu (code review, testy, deploy).
- **Definition of Ready (DoR)** — task NIE WCHODZI bez pełnego kontekstu (Why, scope out, AC, dependencies).

To są trzy RÓŻNE dokumenty, pomylenie = niespójna jakość.

### Z6. Planowanie to nie prediction, to rozkład prawdopodobieństwa
Żadna estymata nie daje daty ±10%. Forecast = rozkład (80% szans na Q3). T-shirt + cycle time = taniej i uczciwiej niż story points.

### Z7. AI planowanie ma krytyczny podział: discovery vs delivery
- **Discovery** (40-60% czasu) = co budujemy i dlaczego → wymaga reasoning (Opus 4.8 max).
- **Delivery** (40-60%) = jak budujemy → Sonnet 4.6 / MiniMax wystarczy.

Discovery drożeje (bo AI może zrobić wszystko, trzeba wiedzieć CO). Delivery tanieje (AI pisze kod szybciej). Pattern odwrócony w stosunku do pre-AI.

---

## Część 3 — Template (8 stages, AI-executable z HITL)

### Maszyna stanów

```
INPUT (voice memo + artifacts)
    │
    ▼
STAGE 1: Discovery Synthesis (AI, reasoning) ─── opus max
    │ Output: Brief (max 1 strona), Open Questions, Risks
    ▼
STAGE 2: HITL Gate 1 — Brief Review
    │ Decyzja: APPROVE / SUPPLY MISSING CONTEXT / DEFER / DEFER TO SPIKE
    ▼
STAGE 3: Decomposition into Vertical Slices (AI, structured) ─── sonnet
    │ Output: parent epic + 3-15 subtasks (vertical slices)
    ▼
STAGE 4: AC & DoD Enrichment per Subtask (AI, structured) ─── sonnet
    │ Output: każdy subtask ma pełen template (Why/Who/Scope in-out/AC/Tech/Dependencies/Risks/Links)
    ▼
STAGE 5: HITL Gate 2 — Sanity Check (sample 2-3 subtasks, approve batch)
    │ Decyzja: APPROVE BATCH / FIX & RE-LOOP / SPIKE FIRST
    ▼
STAGE 6: Linear Push (automated) ─── sonnet / hermes-m3
    │ Output: parent issue + N subtasks w Linear
    ▼
STAGE 7: HITL Gate 3 — Calendar Sync (optional)
    │ Output: Calendar events w "Linear" calendar (per `morning_planner.py` model)
    ▼
STAGE 8: Ready for execution
    │
    ▼
[Cyklicznie: weekly review → STAGE 1 z nowym inputem lub update istniejącego parenta]
```

### Szczegółowy opis stages

**STAGE 1: Discovery Synthesis** (AI: Claude Opus 4.8, max reasoning)
- Input: voice transcript + lista artifactów
- Action: 
  1. Ekstrakcja jobs-to-be-done z voice (nie features!)
  2. Synteza artifacts → jednolity brief
  3. Identyfikacja unknowns (questions list)
  4. Initial risk register (top 5)
  5. Propozycja vertical slices (3-10 slices)
- Output: Brief (markdown, max 1 strona) + Questions + Initial Slices
- Time budget: 2-5 min (AI)
- Failure mode: output jest generyczny → escalate to GPT-5.5 xhigh for comparison

**STAGE 2: HITL Gate 1 — Brief Review** (Mateusz, 5-15 min)
- Output brief jest KRÓTKI (max 1 strona) — żeby review trwał 5-15 min, nie godzinę
- Decyzja:
  - **APPROVE** → STAGE 3
  - **SUPPLY MISSING CONTEXT** → Mateusz odpowiada na questions list, wraca do STAGE 1
  - **DEFER** → zapisuje się jako "Backlog idea", wraca kiedyś
  - **DEFER TO SPIKE** → robi research task (1-2 dni), potem wraca
- Critical: **bez approve — żadne taski nie powstają**

**STAGE 3: Decomposition into Vertical Slices** (AI: Claude Sonnet 4.6)
- Input: approved brief + slice list from STAGE 1
- Action:
  1. Dla każdego slice'a: rozwiń w 1-5 subtasków (vertical, end-to-end)
  2. Sprawdź INVEST (Independent/Negotiable/Valuable/Estimable/Small/Testable)
  3. Zidentyfikuj dependencies między subtaskami
  4. Oznacz scope out per subtask
  5. Dodaj `slice_number` (1, 2, 3...) dla kolejności
- Output: parent issue skeleton + N subtask skeletons
- Constraint: **3-15 subtasków total**. Mniej = za mało scope'u, więcej = za szeroki epic.

**STAGE 4: AC & DoD Enrichment** (AI: Claude Sonnet 4.6, batch)
- Input: subtask skeletons z STAGE 3
- Action: dla każdego subtasku, wypełnij template:
  - **Title** (imperative, konkretny)
  - **Context** (1-2 zdania, link do parenta)
  - **Acceptance Criteria** (Given/When/Then, max 5)
  - **Scope in/out** (3-5 in, 2-3 out)
  - **Tech notes** (stack, biblioteki, ADR refs)
  - **Dependencies** (na co czeka, co blokuje)
  - **Risks / Open questions**
  - **Links** (do briefu, ADR, designu, repo)
  - **Definition of Done** (project-level DoD, nie per-task)
- Validation: każdy subtask bez AC = **odrzucony** (nie utworzony)
- Output: enriched subtasks gotowe do review

**STAGE 5: HITL Gate 2 — Sanity Check** (Mateusz, 5-15 min)
- Nie review wszystkich — sample 2-3 (losowo lub najważniejsze)
- Decyzja:
  - **APPROVE BATCH** → STAGE 6
  - **FIX & RE-LOOP** → Mateusz wskazuje 1-2 taski do poprawy, AI poprawia cały batch
  - **SPIKE FIRST** → 1-2 taski zbyt niepewne → utwórz je jako SPIKE (max 1-2 dni research) zamiast implementacyjnych
- Critical: **Mateusz NIE pisze tasków ręcznie** (chyba że override). To jest feature, nie bug.

**STAGE 6: Linear Push** (Hermes-M3 / DeepSeek V4 Pro — tani)
- Linear API: `create_issue` (parent, Initiative/Project level)
- Linear API: dla każdy subtask → `create_issue` z `parentId = parent.id`
- Linear API: labels: `from-hermes`, `auto-created`, `ai-planned`, `vertical-slice-N`
- Linear API: assign to Mateusz (default)
- Output: parent + N subtasks widoczne w Linear
- Error handling: jeśli którykolwiek subtask failuje → rollback wszystkich (atomic)

**STAGE 7: HITL Gate 3 — Calendar Sync** (opcjonalny)
- Jeśli Mateusz chce time-blocking: dla każdego subtaska, calendar event w "Linear" calendar
- Per `morning_planner.py` (Jointhubs już to ma)
- Duration: priority-based (Urgent=60min, High=30min, Medium=30min, Low=15min)
- Title format: `[H] JOI-X | Title` (bez godziny — drag-proof)

**STAGE 8: Ready for execution**
- Mateusz (lub AI agent) bierze subtaski z Linear
- Każdy subtask = samowystarczalny (parent kontekst + delta + AC + tech notes)
- Context switching między subtaskami = minimal (bo scope jest mały, parent jasny)

### Cykliczność

Weekly review (niedziela/pierwszy dzień kwartału):
- Otwórz parent epic → sprawdź progress
- Subtaski zamknięte? Nowe unknowns? Zmiana scope'u?
- Jeśli nowy input → nowy STAGE 1-8 (albo update istniejącego parenta)
- Mid-quarter check-in (2× per Q) = review outcome metrics vs OKR

---

## Część 4 — Scenariusze (5 archetypów)

Dobór scenariusza zależy od 3 wymiarów: **Volume × Method × Tool Profile**.

### Scenariusz A: Quick Win

| Wymiar | Wartość |
|--------|---------|
| **Volume** | 1 voice memo, 0-1 artifact, <2h pracy |
| **Method** | T-shirt (S/M/L), brak cycles |
| **Tool Profile** | Dowolny |
| **Linear shape** | 1 issue, BEZ subtasków (parent = task) |
| **AI plan time** | 2-3 min |
| **HITL touchpoints** | 1 (gate 1, brief review) |
| **Subtaski** | 0 |

**Kiedy używać:** bug fix, mała zmiana konfiguracyjna, "coś mi nie działa", szybki experiment.

**Przykład:** "Zmień timeout na /auth/login z 30s na 10s. Bo widzę, że wiszą 30s na staging."
→ Brief: 3 zdania (why, what, expected outcome). 1 Linear issue. Bez subtasków.

### Scenariusz B: Standard Feature

| Wymiar | Wartość |
|--------|---------|
| **Volume** | 1-3 voice memos, 2-5 artifacts, 3-15 dni pracy |
| **Method** | Scrum cycle (2 tyg) lub Kanban, vertical slicing |
| **Tool Profile** | Dowolny |
| **Linear shape** | 1 parent issue + 3-10 subtasków |
| **AI plan time** | 5-10 min |
| **HITL touchpoints** | 2 (gate 1 brief, gate 2 sanity check) |
| **Subtaski** | 3-10 |

**Kiedy używać:** typowa funkcjonalność produktowa (vertical slice, user journey).

**Przykład:** "Dodaj możliwość uploadu plików PDF do dokumentów klienta w Neo, max 50MB, z podglądem pierwszej strony."
→ Brief: 1 strona. Parent = feature. 5-8 subtasków (slice 1: upload, slice 2: podgląd, slice 3: error handling).

### Scenariusz C: Epic / Quarter Initiative

| Wymiar | Wartość |
|--------|---------|
| **Volume** | Wiele voice memos, 5-20 artifacts, 4-12 tygodni |
| **Method** | Shape Up (6 tyg cycle) lub OKR-driven quarterly |
| **Tool Profile** | Multi-stack (BE+FE+DB+DevOps) |
| **Linear shape** | 1 Initiative + 2-4 Projects + 10-30 issues + subtasks |
| **AI plan time** | 20-40 min (z iteracjami) |
| **HITL touchpoints** | 3 (gate 1 brief, gate 2 sanity check, gate 3 calendar) |
| **Subtaski** | 10-30 (z nestingiem) |

**Kiedy używać:** duża inicjatywa kwartalna, multi-team, multi-component.

**Przykład:** "Wdróż system onboardingu płatności Stripe w PISI z 3DS i obsługą subskrypcji."
→ Brief: 1-2 strony. Initiative = outcome (np. "Konwersja trial→paid +25%"). Projects = sub-epics (Auth, Payment flow, Subscriptions). Issues = stories. Subtasks = AC.

### Scenariusz D: Cross-Project / Multi-Team

| Wymiar | Wartość |
|--------|---------|
| **Volume** | Initiative affecting 2+ projects/teams |
| **Method** | OKR cascade + WSJF (cross-team priorytetyzacja) |
| **Tool Profile** | Multi-stack, cross-stack dependencies |
| **Linear shape** | Initiative (cross-project) + sub-initiatives per project + issues |
| **AI plan time** | 30-60 min |
| **HITL touchpoints** | 3-4 (incl. cross-team alignment) |
| **Subtaski** | 20-50 (cross-linked) |

**Kiedy używać:** inicjatywy z dependencies między zespołami (np. nowa integracja, compliance, duży refactor).

**Przykład:** "Dodaj SSO (Google + Microsoft) do wszystkich produktów Jointhubs."
→ Cross-project dependencies (Neo auth, Fenix auth, PISI auth, Office AI auth). WSJF scoring do priorytetyzacji.

### Scenariusz E: Tech Debt / Refactor / Spike

| Wymiar | Wartość |
|--------|---------|
| **Volume** | 1 voice memo (często), 1-3 artifacts, dowolny czas |
| **Method** | Spike-driven (1-2 dni) lub tech-debt backlog |
| **Tool Profile** | Specific (np. tylko DB, albo tylko BE) |
| **Linear shape** | 1 epic + 3-8 sub-spikes/sub-refactors |
| **AI plan time** | 5-15 min |
| **HITL touchpoints** | 2 (gate 1, gate 2) |
| **Subtaski** | 3-8 (każdy = spike lub mały refactor) |

**Kiedy używać:** brak user journey, brak "valuable for user". Techniczne zadania.

**Specjalny kształt:** brak AC (bo to nie user-facing). Zamiast tego: **technical success criteria** (np. "test suite passes", "performance benchmark X", "code coverage ≥80%").

**Przykład:** "Zmigruj bazę Neo z Postgres 14 na Postgres 16."
→ Subtaski: spike (sprawdź breaking changes), spike (test migration na stagingu), spike (zaplanuj rollback), task (utwórz migrację), task (deploy na staging), task (smoke test).

---

## Część 5 — Dobór scenariusza (decision tree)

```
START: masz voice memo + artifacts?
│
├─ NIE → zatrzymaj się, nie planuj (insufficient input)
│
TAK
│
├─ Ile to jest pracy? (rough mental estimate)
│  │
│  ├─ <2h → Scenariusz A (Quick Win)
│  ├─ 0.5-2 tyg → Scenariusz B (Standard Feature)
│  ├─ 2-12 tyg → Scenariusz C (Epic) lub D (Cross-Project)
│  └─ > 12 tyg → rozważ podział na Scenariusz C/D × N
│
Czy dotyczy user-facing functionality?
│
├─ TAK → standard decomposition (vertical slicing)
├─ NIE → Scenariusz E (Tech Debt), pomiń user journey
│
Czy dotyczy >1 projektu/zespołu?
│
├─ TAK → Scenariusz D (Cross-Project), użyj WSJF
├─ NIE → Scenariusz A/B/C/E
│
Czy masz historyczną estymatę podobnego scope?
│
├─ TAK → użyj throughput-based forecast
├─ NIE → t-shirt sizes (S/M/L/XL → rozbij XL!)
│
Czy są jasne dependencies zewnętrzne (API, vendor, regulator)?
│
├─ TAK → Scenariusz C/D, dependencies na poziomie parenta
└─ NIE → Scenariusz A/B/E
```

---

## Część 6 — AI Execution Protocol (per stage)

| Stage | AI Model | Reasoning | Latency | Cost | Failure handling |
|-------|----------|-----------|---------|------|------------------|
| 1. Discovery Synthesis | Claude Opus 4.8 | max | 30-90s | $0.50-2 | If output generyczny → fallback GPT-5.5 xhigh |
| 3. Decomposition | Claude Sonnet 4.6 | low | 10-30s | $0.10-0.30 | If vertical_slice=0 w >50% → re-prompt z naciskiem na user journey |
| 4. AC Enrichment | Claude Sonnet 4.6 | low | 5-15s per task | $0.05-0.20 per task | Validation: odrzuć task bez AC |
| 6. Linear Push | Hermes-M3 / DeepSeek V4 Pro | none | 2-5s per task | $0.001-0.01 per task | Atomic rollback jeśli >1 fail |

**Routing rule:** STAGE 1 = Opus max (jakość > koszt). STAGE 3-4 = Sonnet low (wystarczy). STAGE 6 = bulk, tani model.

---

## Część 7 — Linear API contract (jak to implementować)

### Parent issue template (Issue template w Linear)

```yaml
# Issue template: AI-planned Epic
Title: "[initiative] {Tytuł outcome'u}"
Labels: [from-hermes, ai-planned, initiative-{q}-{yyyy}]
Priority: P1 / P2 / P3 (per OKR)
Project: <Linear project>

Description template:
  ## Outcome (measurable)
  <1-3 zdania, link do OKR/KPI>

  ## User journey
  1. User wchodzi do ...
  2. ...
  3. ...

  ## Vertical slices
  - Slice 1: <najprostsza wartość>
  - Slice 2: ...
  - Slice 3: ...

  ## Out of scope
  - <granice jawne>

  ## Risks
  - ...

  ## Brief link
  <link do briefu w vault lub .md artifact>
```

### Subtask template (Issue template w Linear)

```yaml
# Issue template: AI-planned Subtask
Title: "[slice {N}] {Imperative + obiekt}"
Labels: [from-hermes, ai-planned, slice-{N}, vertical-slice]
Priority: <per parent>
Project: <per parent>
Parent: <parent epic ID>

Description template:
  ## Context
  Link do parenta. 1-2 zdania co ten task wnosi do slice'a.

  ## Acceptance Criteria
  - [ ] Given {context}
  - [ ] When {action}
  - [ ] Then {observable outcome}

  ## Scope in
  - ...

  ## Scope out
  - ...

  ## Tech notes
  Stack, biblioteki, ADR refs, performance/security considerations.

  ## Dependencies
  - Blokuje na: ...
  - Blokowany przez: ...
  - External: ...

  ## Risks / Open questions
  - ...

  ## Links
  Parent epic, brief, ADR, design, repo.
```

### Linear custom fields (opcjonalnie)

- `slice_number` (number, 1-N)
- `vertical_slice` (boolean)
- `parent_brief_link` (text)
- `estimated_size` (S/M/L/XL enum)
- `scenario` (A/B/C/D/E enum)

---

## Część 8 — Anty-patterny tego systemu

| # | Anty-pattern | Dlaczego szkodliwy |
|---|--------------|---------------------|
| 1 | **Task < 4h** | Overhead context switching > wartość dostarczona |
| 2 | **Pełen kontekst w każdym subtasku** | Rot, desync, 50 kopii briefu |
| 3 | **Brak Gate 1 (brief review)** | AI planuje "samo", Mateusz dostaje 50 tasków niespodziewanie |
| 4 | **AI tworzy taski bez AC** | Nietestowalne = nie wiadomo kiedy skończone |
| 5 | **Jeden model do wszystkiego** | Opus max do Linear push = 100x za drogo |
| 6 | **HITL na każdym tasku** | Bottleneck = Mateusz reviewuje 50 tasków, nie ma czasu na development |
| 7 | **Brak scope out** | Scope creep, "a może dorzucimy X" |
| 8 | **Linear bez Issue templates** | Sekcje puste byle jak, task bez kontekstu |
| 9 | **Calendar sync bez Gate 3** | Eventy tworzone bez approve = chaos |
| 10 | **Brak weekly review** | Parent epic się rozjeżdża z rzeczywistością |
| 11 | **Spike jako implementacja** | "Spike na cały tydzień" = to jest research task, nie spike |
| 12 | **Cross-project bez WSJF** | Brak priorytetyzacji cross-team, "wszystko urgent" |

---

## Część 9 — Open questions / Iteracje do rozważenia

1. **Czy Discovery Synthesis (STAGE 1) powinien mieć explicit listę known unknowns?** Czy to wystarczy "Questions" w brief? (Rekomendacja: tak, explicit lista pytań jest silniejsza.)

2. **Czy Linear API w Jointhubs ma dostęp do subtask creation atomic?** (Trzeba sprawdzić — jeśli nie, potrzebny jest fallback z rollbackiem ręcznym.)

3. **Czy Hermes-M3 jest wystarczająco dobry do STAGE 6?** (Bulk Linear push wymaga strict JSON adherence — Hermes ma 92-93%, jeśli to za mało, fallback do Sonnet.)

4. **Czy Mateusz chce pełen cykl, czy tylko decomposition?** (Jeśli tylko decomposition, STAGE 1-5, bez 6-7.)

5. **Ile tasków/epic to maksimum?** (Research sugeruje 3-15 subtasków sweet spot. Powyżej → rozbij na dwa epics.)

6. **Czy brief ma być w vault (Second Brain) czy w Linear (description parenta)?** (Rekomendacja: vault = canonical, Linear = link. Vault jest przeszukiwalny, Linear nie.)

---

## Część 10 — Quick start (5 kroków)

Jeśli chcesz to wdrożyć DZIŚ:

1. **Utwórz Issue templates w Linear** (parent epic + subtask) — wklej szablony z części 7.
2. **Utwórz `planning/` folder w vault** (`Second Brain/Operations/planning/`) na briefy.
3. **Pierwszy pilot:** weź 1 voice memo z ostatniego tygodnia → STAGE 1-5 ręcznie (czyli czytasz brief, decydujesz, sam dekomponujesz w Linear).
4. **Po 3 pilotach:** zacznij automatyzować STAGE 1 (Hermes + Opus 4.8 max → brief).
5. **Po 10 pilotach:** automatyzuj STAGE 3-4 (Sonnet → subtasks), STAGE 6 (Hermes-M3 → Linear push).

Nie automatyzuj wszystkiego naraz. **Pilot ręczny → feedback → automatyzuj fragment**.

---

## Źródła (7 notatek researchowych z 2026-06-19)

1. `research_software_project_planning_best_practices.md` (672 linii)
2. `research_roadmapping_patterns.md` (588 linii)
3. `research_task_decomposition_invest_spidr_vertical_slicing.md` (394 linii)
4. `research_engineering_task_description_best_practices.md` (443 linii)
5. `research_reducing_developer_cognitive_load.md` (510 linii)
6. `research_estimation_techniques.md` (550 linii)
7. `research_llm_models_for_planning.md` (769 linii)

Klasyki: Marty Cagan (SVPG), Ryan Singer (Shape Up), Mike Cohn (Mountain Goat), Bill Wake (INVEST), John Doerr (OKR), Janna Bastow (Now/Next/Later), Itamar Gilad (GIST), Michael Nygard (ADR), Teresa Torres (Continuous Discovery), Jeff Patton (Story Mapping), John Sweller (Cognitive Load Theory).
