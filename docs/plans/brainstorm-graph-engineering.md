---
type: brainstorm
status: approved-v1 (decyzje wiążące 2026-08-25; dekompozycja wykonana tego samego dnia)
audience: Mateusz (zatwierdzone) → wykonanie w FOC-116 / FOC-159
topic: graph engineering — topologia jako artefakt, izolacja równoległych agentów, ugruntowany ewaluator; Supervisor jako runtime grafu
related:
  - ./brainstorm-autonomous-dispatch.md      # A — dispatcher (bramki-labelki, budżety per task)
  - ./brainstorm-specialization-learning.md  # B — uczenie specjalizacji (kontrakt mikro-planu = DAG)
  - ./brainstorm-graphify-thoughtmap-integration.md  # C — mapy kontekstu
  - ../adr/0009-supervisor-frontman-runtime.md       # poprawiony 2026-08-25 (worktree do MVP)
  - ../ROADMAP.md
---

# Brainstorm D — graph engineering w Fenixie

## 0. Skąd to się wzięło (i co jest nieprawdą)

Punktem wyjścia był krążący po LinkedInie materiał „Andrej Karpathy: from 1 loop to 1000 agents".
**Research 2026-08-25 rozdzielił fakty od opakowania** — to rozróżnienie jest częścią decyzji, bo
inaczej cytowalibyśmy nieistniejący autorytet.

### Prawda — `karpathy/autoresearch`

Repo z 7 marca 2026 ([github.com/karpathy/autoresearch](https://github.com/karpathy/autoresearch)),
~630 linii, jedno GPU, 94k gwiazdek. Trzy pliki i cały pomysł siedzi w ich podziale:

| Plik | Kto iteruje |
|---|---|
| `prepare.py` | nikt — zamrożony (dane, ewaluacja) |
| `train.py` | **agent** (model, optimizer, pętla) |
| `program.md` | **człowiek** (instrukcje) |

Pętla: hipoteza → edytuj `train.py` → trenuj **dokładnie 5 minut** → odczytaj `val_bpb` → lepiej?
`git commit` : `git reset --hard`. ~12 eksperymentów/h, ~100 przez noc.

Trzy decyzje projektowe, które faktycznie niosą wartość:

1. **Sztywny budżet czasu, nie kroków** — eksperymenty są porównywalne niezależnie od tego, co agent
   zmienił, i system optymalizuje pod konkretną platformę.
2. **Jeden plik do modyfikacji** — „keeps the scope manageable and *diffs reviewable*".
3. **Jedna metryka**, dobrana tak, by zmiany architektury były porównywane uczciwie. Git = cała pamięć.

Karpathy sam otwiera kierunek wieloagentowy, ale jako pytanie, nie playbook: programujesz
`program.md`, które „set up your autonomous research org", i „oczywiste jest, jak dodałoby się
więcej agentów do miksu".

### Opakowanie — „graph engineering" przypisywane Karpathy'emu

- Liczba „700 eksperymentów przez 2 dni" jest zawyżona. Zweryfikowany przebieg: **83 eksperymenty
  przez noc, 15 zachowanych, val 0.862 → 0.858**.
- „11-stronicowy PDF Karpathy'ego / dwóch seniorów z Anthropic" — te same posty przypisują go raz
  jednemu, raz drugiemu. Okładka PDF-a mówi wprost: *„Independently compiled, 2026"*. **Karpathy tego
  nie napisał. Nie cytujemy tego jako autorytetu.**

### Realny trend pod hype'em

**Loop engineering** — termin spopularyzowany esejem Addy'ego Osmaniego (7.06.2026). **Graph
engineering** — jego następca z ~lipca 2026; Turingpost pisze o tym sceptycznie („graph znaczy dziś
wszystko"). Konkret od Anthropic: **Claude Code dynamic workflows** — Claude pisze skrypt orkiestracji
w JS koordynujący równoległe subagenty, a **koordynacja kosztuje zero tokenów, bo jest kodem, nie
rozmową**.

Poważne źródło techniczne (nie content marketing):
[aman.ai — Loop and Graph Engineering](https://aman.ai/primers/ai/loop-and-graph-engineering).
Cztery rzeczy stamtąd, które realnie wpłynęły na plan:

- Kryterium: `useGraph = parallelism ∨ specialization ∨ conditionalRouting ∨ multiStageVerification`.
  **„The number of agents is an implementation detail. The topology is the engineering artifact."**
- Drabina autonomii: Manual → Supervised → Bounded unattended → Scheduled → Graph node.
  *„Do not integrate an unreliable loop into a larger graph because graph scale will multiply its defects."*
- Budżet dzielony: `B_graph = B_discovery + B_verification + B_synthesis + B_reserve`.
- Izolacja równoległych agentów: worktree + `allowed_paths` + **węzeł merge**, bo *„two patches can
  pass independently and fail when combined"*. Plus backpressure i detekcja stagnacji
  (liczenie iteracji **nie jest** sygnałem postępu).

## 1. Diagnoza — Fenix już jest grafem, tylko nienazwanym

| Krok playbooka | Stan w Fenixie |
|---|---|
| Pętla generate → critique → revise | ✅ PLAN→DEV→REVIEW→TEST→CADENCE |
| Narzędzia | ✅ MCP, `code-intel`, graphify, GitNexus, linear-* |
| Równoległość / worktree | ❌ WIP=1, wspólne drzewo robocze |
| Typowany graf zamiast transkryptów | 🟡 `delegation_links` to już tabela krawędzi; handoffy to markdown |
| Ugruntowany ewaluator | 🟡 werdykt jest, ale z czytania diffa, nie z cytowania grafu kodu |
| Pamięć przeżywająca sesję | ✅ najmocniejsza strona — Linear + SQLite v3 + `.state/` + STATE.md |

**Wniosek: jesteśmy dalej niż 95% treści pod tym hasłem.** Nie potrzebujemy playbooka, tylko
domknięcia trzech luk. Dodatkowo: **brainstorm B już wymyślił kontrakt graph-engineeringowy** —
mikro-plan JSON ze `steps[].dependsOn` to dosłownie DAG, tylko nienazwany.

## 2. Pomysły (uszeregowane) i ich los

| # | Pomysł | Decyzja 2026-08-25 |
|---|---|---|
| **D1** | `config/graph.json` — kontrakty węzłów + typowane krawędzie; topologia jako artefakt | ✅ **priorytet 1** → FOC-158 |
| **D2** | worktree + węzeł merge + backpressure | ✅ **priorytet 2**, rozdzielone: worktree → FOC-119, reszta → FOC-159 |
| **D3** | ugruntowany werdykt REVIEW (cytat dowodu zamiast „seems off") | ✅ **priorytet 3** → FOC-163 |
| **D4** | dispatch jako kod, nie rozmowa (wzorzec dynamic workflows) | 🟡 odłożone — kandydat po MVP; cel ≥40% delegacji staje się wtedy własnością strukturalną, nie napominaniem w prompcie |
| **D5** | budżet per etap zamiast jednej liczby | ✅ → FOC-162 |
| **D6** | fingerprinty zamiast liczenia rund | ✅ → FOC-163 (razem z D3) |
| **D7** | autoresearch nad samym Fenixem (mutuj prompt → przejedź golden set → commit/reset) | ⏸ **świadomie odłożone** (Mateusz, 2026-08-25) |

### Dlaczego D7 odłożone, mimo że kuszące

Mapowanie jest ładne: `agents/*/CLAUDE.md` **to jest nasz `program.md`**, `config/models.json` to
hiperparametry, a `usage_facts` to `val_bpb`. Mamy nawet to, czego Karpathy nie ma — realny substrat
metryk. Ale jego pętla działa **wyłącznie** dlatego, że eksperyment trwa 5 minut, metryka to jedna
liczba, a revert to `git reset`. U nas eksperyment to realny task na realnym repo, metryka jest
wielowymiarowa i szumiąca, a revert nie jest darmowy. **Naiwny port się wywali.**

Co mogłoby zadziałać, gdy wrócimy: **golden set + replay** na bazie istniejących launcherów DRY-RUN
i fixture'ów (`.state/mock/dev-task.json`). Zamrozić N nagranych tasków, zmutować *jedną* rzecz,
przejechać zestaw, ocenić `koszt × werdykt × rundy`, `commit` albo `reset`. To jest odpowiednik
„sztywnych 5 minut" — chodzi o **porównywalność, nie o szybkość**.

## 3. Granica autonomii — rozstrzygnięcie

Pozorna kolizja: brainstorm A mówi „bramki = ZAWSZE labelka od użytkownika", drabina z aman.ai mówi
o schodzeniu do trybu unattended. **Kolizji nie ma — to dwie różne osie.** A mówi *które decyzje*
wymagają człowieka; drabina mówi *ile dowodów* potrzeba, zanim pętla pobiegnie bez nadzoru.

Rozstrzygamy **przez odwracalność**:

| Klasa | Co | Bramka |
|---|---|---|
| **Nieodwracalne / na zewnątrz** | push, PR, merge, deploy, zapis do Lineara poza własnym taskiem | ✋ zawsze człowiek, **per akcja**, bez wyjątków i bez promocji |
| **Kierunkowe** | GATE 1/2, dekompozycja, wybór ścieżki przy niskim confidence | ✋ człowiek, **per fala** — jedna labelka `go` na epicu |
| **Wykonawcze** | lokalny commit, werdykt review, retry, wybór roli | 🤖 supervisor — ale tylko gdy węzeł zszedł po drabinie |

**Mechanika:** `config/graph.json` niesie per-węzeł `autonomy: supervised | bounded | scheduled`.
Każdy węzeł startuje jako `supervised`. Promocja wymaga dowodu z telemetrii (N kolejnych runów
z czystym werdyktem i w budżecie), ale **sam wpis robi człowiek, w pliku pod gitem**. System nigdy
nie nadaje sobie uprawnień — to trzyma decyzję z brainstormu A dosłownie.

**Twardy warunek:** klasa 3 nie schodzi poniżej `supervised`, dopóki nie ma FOC-163 (ugruntowany
werdykt). Promowanie węzła, którego ewaluator ocenia „na oko", to skalowanie niezweryfikowanej pracy.

## 4. Czego świadomie NIE robimy

- **Nie budujemy piątego grafu.** Mamy Lineara (taski), SQLite (runy), graphify/GitNexus (kod),
  thoughtmap (myśli). Dokładanie „knowledge graph" jako nowego komponentu to podręcznikowy failure
  mode. Typowane handoffy mają lądować w SQLite, który już istnieje.
- **Nie gonimy liczby agentów.** Wąskim gardłem jest przepustowość decyzyjna Mateusza i budżet $,
  nie liczba procesów. 1000 agentów bez ugruntowanego ewaluatora to 1000× więcej niezweryfikowanej
  roboty.
- **Nie cytujemy „PDF-a Karpathy'ego"** — patrz §0.

## 5. Gdzie to wylądowało (2026-08-25)

**ADR-0009 poprawiony** — Decision B mówiła „no worktree isolation in MVP" i kazała spawnowi
*odmawiać* drugiego issueId na tym samym cwd. Odwrócone: każde dziecko dostaje własny worktree,
a spawn go *przydziela*. Powód: wspólne drzewo robocze pod równoległymi dziećmi to awaria już dwa
razy zaobserwowana w tym repo (ROADMAP §NOW.1).

**FOC-116 „SUPERVISOR AGENT" przeplanowany** — z 10 tasków pociętych po plikach `.mjs` (brak
demoable stanu aż do końca) na 11 tasków w falach:

| Fala | Zakres | Kamień milowy |
|---|---|---|
| F0 | FOC-158 — `config/graph.json` + walidator + generator PlantUML | topologia jest plikiem, który da się zdiffować |
| F1 | FOC-124 · FOC-119 (worktree) · FOC-120 · FOC-121 | **jedno dziecko DEV na własnym worktree dowozi commit** |
| F2 | FOC-122 · FOC-123 (triage → węzeł grafu) · FOC-125 · FOC-126 | pełny HITL przez supervisora |
| F3 | FOC-127 · FOC-128 | zielone na win32, e2e przejdzone |

**FOC-159 „SUPERVISOR — PARALLELISM AND GROUNDED VERIFICATION"** (nowy epic siostrzany):
FOC-160 merge node · FOC-161 semafor + backpressure · FOC-162 budżet per etap · FOC-163 ugruntowany
werdykt + fingerprinty.

**Rozdzielenie FOC-116 / FOC-159 jest celowe:** FOC-116 sprawia, że równoległe dzieci są *bezpieczne
do uruchomienia*; FOC-159 — że są *godne zaufania*. To dwa różne problemy stające się realnymi
w różnych momentach. FOC-116 wozi więc jedną stałą („one live child per issue") i FOC-159 jest tym,
co ją usuwa.

**JOI-75 zamknięty jako superseded przez FOC-119** — worktree przestało być sprawą `dev-branch.mjs`;
pod supervisorem tylko spawner wie, które dziecko biegnie gdzie.

## 6. Otwarte

- Linia **JOI-73 „Fenix v2"** ma 16 otwartych tasków. Część jest realnie martwa (JOI-81 zrobione
  przez UI redesign v2, JOI-85 HITL inbox częściowo wchłonięty przez gate relay), część żywa
  i niezwiązana z supervisorem (JOI-167 mapy kontekstu z brainstormu C, JOI-210 sygnał jakości,
  JOI-78/79 koszty). **Do przeglądu jeden po drugim** — nie zamykać hurtem.
- **D4** (dispatch jako kod) — wrócić po MVP; naturalne miejsce to promocja kontraktu mikro-planu
  z brainstormu B do systemowego prymitywu wykonania.
- **D7** — wrócić, gdy będą dane z realnych przebiegów; wtedy zdecydować metrykę.
