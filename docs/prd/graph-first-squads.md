# PRD — Graf wiedzy w pętli składów + porządki w promptach

> Status: **draft do akceptacji** · Data: 2026-07-27 · Repo: `linear-agents`
> Powiązane: `docs/FENIX_WORKFLOW.md`, `config/prompts.json`, `agents/*/CLAUDE.md`

---

## 1. Czego chce Mateusz

1. PLAN **zaczyna** od grafu: zbuduj, jeśli nie ma; zaktualizuj, jeśli jest. Dopiero potem analiza problemu.
2. DEV aktualizuje graf.
3. REVIEW aktualizuje graf.
4. Prompt engineering dla wszystkich składów, żeby to faktycznie *egzekwować*, nie tylko poprosić.
5. Analiza obecnych promptów pod kątem optymalizacji.

## 2. Blokery — stan faktyczny (zweryfikowany)

### 2.1 Składy fizycznie nie mają `/graphify`

Każdy launcher ustawia `CLAUDE_CONFIG_DIR=%ROOT%\agents\<squad>` (`bin/dev.bat` i reszta).
Skill `/graphify` mieszka w `~/.claude/skills/graphify/` — **poza** tym katalogiem.
Żaden `agents/<squad>/skills/` nie istnieje.

⇒ Wpisanie „zacznij od `/graphify`" do promptu daje agenta, który woła nieistniejącą komendę.
Cicha porażka, nie błąd.

### 2.2 Pełny pipeline per-run to regres kosztowy

Semantyczna ekstrakcja graphify rozsyła subagentów LLM (`ceil(pliki/22)`).
Graf `office` powstał z **432 plików** ⇒ ~20 subagentów na pełny przebieg.
Każdy `CLAUDE.md` składu jest zdominowany przez guardraile kosztowe
(„Jesteś NAJDROŻSZYM modelem", „≥40% kosztu runa u subagentów").
Doklejenie 20-subagentowej ekstrakcji na start każdego runa PLAN przeczy całemu projektowi systemu.

### 2.3 Ale graphify ma tanie ścieżki, i to one pasują

| Ścieżka | Koszt LLM | Do czego |
|---|---|---|
| zmiany **tylko w kodzie** → ekstrakcja AST | **zero** | utrzymanie grafu |
| `graphify hook install` (post-commit) | **zero** | automatyczna aktualizacja po commicie |
| `--update` (inkrementalny) | tylko zmienione pliki | okresowe odświeżenie docs |
| `query` / `path` / `explain` | odczyt małego podgrafu | **wartość dla PLAN/REVIEW** |
| `--mcp` (serwer stdio) | odczyt | narzędzia dla agenta bez skilla |

⇒ Właściwy podział to **nie** „każdy skład uruchamia graphify", tylko:
**utrzymanie = automatyczne i darmowe · składy tylko czytają.**

### 2.4 Stan grafów

| repo | graf | wiek |
|---|---|---|
| `office` | 2914 węzłów / 8196 krawędzi | zbudowany 2026-06-15 — **6 tygodni nieaktualny** |
| `linear-agents` | brak | — |
| `joint-flows` | brak | — |
| `gantt-pisi` | brak | — |

### 2.5 Zainstalowany graphify nie widzi `.mjs` ani `.jsx`

Wersja lokalna: **0.3.15**. Jej `_DISPATCH` mapuje na parser JS tylko `.js`, `.ts`, `.tsx`.
Kod `linear-agents` to 38 × `.mjs` + 11 × `.jsx` + 4 × `.js`.

⇒ Graf zbudowany obecną wersją zobaczyłby **4 z 53 plików źródłowych (7%)**.
Bezużyteczny dokładnie tam, gdzie ma dawać wartość: recon DEV i blast-radius REVIEW.

Wersja **0.9.28** obsługuje `.mjs`, `.jsx`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte`.
Sprawdzone AST-em na sdist: **27 z 27 funkcji API wołanych przez `SKILL.md` jest zgodnych**
(`to_html` i `push_to_neo4j` przeniesiono do `graphify/exporters/`, ale `export.py` je
re-eksportuje pod tą samą ścieżką importu; sygnatura `to_html` wstecznie zgodna).
Upgrade dotyka globalnego skilla Mateusza — **decyzja jego**, nie automat.

### 2.6 Korpus wymaga zawężenia

`agents/<squad>/` to `CLAUDE_CONFIG_DIR`, więc trzyma runtime Claude Code
(vendorowany marketplace pluginów, transkrypty sesji, changelog) obok naszych promptów.
Detekcja bez filtra: **1603 pliki / 3.0M słów**, z czego ~93% to ten runtime
⇒ ~60 subagentów LLM na pełny build, za zero wiedzy.

Dodany `.graphifyignore` zawęża do **173 plików / 196k słów**, zachowując
`agents/*/CLAUDE.md` i `agents/*/agents/*.md` (prompty składów — to JEST wiedza projektowa).

## 3. Analiza promptów — znalezione defekty

### 3.1 Cel delegacji chybiony ~3× (dane z dashboardu, dziś)

| | kwota | udział |
|---|---|---|
| lead | $481.81 | **87.6%** |
| wszyscy subagenci razem | $68.28 | **12.4%** |

Cel zapisany w 5 promptach: **≥40% u subagentów**. Realizacja: 12.4%.
Reguła jest deklarowana i nigdzie nie egzekwowana.

### 3.2 4 z 5 leadów wskazuje nieistniejący plik spec

| skład | wskazuje | stan |
|---|---|---|
| plan | `docs/agents/agent-1-planner.md` | ✅ |
| dev | `docs/agent-2-dev.md` | ❌ (jest `docs/agents/agent-2-dev.md`) |
| review | `docs/agent-3-review.md` | ❌ |
| test | `docs/agent-4-test.md` | ❌ |
| cadence | `docs/agent-0-cadence.md` | ❌ |

Każdy z tych składów spali turę na odkryciu, że pliku nie ma.

### 3.3 Kickoffy sprzeczne z `CLAUDE.md`

Agent dostaje oba źródła naraz i one się nie zgadzają:

- **DEV ma trzy różne pętle.** Kickoff: 6 kroków „wg FENIX_WORKFLOW §5".
  `agents/dev/CLAUDE.md`: własna 7-krokowa pętla (resume → pick → start → fazy → hand-off).
  `docs/FENIX_WORKFLOW.md` §5: kanoniczna pętla 8-krokowa. Trzy wersje jednej rzeczy.
- **Kickoff REVIEW zaszywa modele** („first-pass (DeepSeek Pro), security (Kimi), deep (GLM-5.2)"),
  a prawdziwe modele siedzą w `agents/review/agents/*.md`. Zmiana modelu w zakładce
  Konfiguracja **nie rusza tekstu promptu** — dokładnie ta klasa błędu wystąpiła przy
  zmianie leada PLAN na Opus 5.
- **Kickoff REVIEW odsyła do „§5"** po etykietę wersji; §5 w `review/CLAUDE.md` to „Verdict"
  i nie mówi o wersjach ani słowa.
- **Kickoff PLAN zaszywa „team FEN"**, choć `_lib.bat` obsługuje `LINEAR_TEAM_KEY`
  (JOI/PISI/FOC). Run PLAN dla zadania z `office` (FOC) dostanie polecenie pushu do złego teamu.

### 3.4 TEST odstaje

53 linie wobec 113–142 u reszty. Brak sekcji „Linear tools (MANDATORY)",
brak trybu dry-run w `CLAUDE.md` **i** brak `bin/test-dry.bat` — jedyny skład bez ścieżki dry-run.

### 3.5 Duplikacja ×5

Polityka delegacji, reguła o sekretach i nagłówek `LA_ROOT` są przepisane dosłownie
w pięciu plikach. Zmiana polityki = edycja 5 plików i nadzieja, że żadnego nie pominięto.

## 4. Propozycja

### Faza G1 — infrastruktura grafu (bez ruszania promptów)

1. `graphify hook install` w aktywnych repo → post-commit AST rebuild, darmowy, automatyczny.
   **To samo w sobie realizuje „DEV aktualizuje" i „REVIEW aktualizuje" — bez jednego tokena w runie.**
2. Jednorazowo: `--update` na `office` (6 tygodni luki), pełny build na `linear-agents` i `joint-flows`.
3. Podpiąć serwer MCP graphify do `agents/<squad>/` → składy dostają `query_graph`,
   `get_neighbors`, `god_nodes` jako **narzędzia**, bez potrzeby skilla.
4. **Zweryfikować, że skład realnie widzi te narzędzia** (dry-run + lista toolów) zanim
   napiszemy cokolwiek w promptach.

### Faza G2 — zmiany w promptach, dopiero gdy narzędzia potwierdzone

- **PLAN**: przed discovery — zapytanie do grafu o obszar problemu („co to dotyka").
- **DEV**: `recon` pyta graf zamiast grepować na ślepo; aktualizację robi hook.
- **REVIEW**: blast-radius — `get_neighbors` na zmienionych plikach mówi passom, co jeszcze może pęknąć.
- **Reguła nadrzędna we wszystkich trzech: graf jest akceleratorem, nigdy bramką.**
  Brak grafu / nieaktualny → zanotuj i jedź dalej. Infrastruktura nie ma prawa zatrzymać runa.

### Faza G3 — konsolidacja i naprawa sprzeczności

- wspólne bloki do `agents/_shared/` + `@import`
- naprawa 4 martwych linków do speców
- uzgodnienie kickoff ↔ `CLAUDE.md` ↔ `FENIX_WORKFLOW` (jedna pętla, jedno miejsce)
- usunięcie zaszytych modeli i team-keys z kickoffów
- doprowadzenie TEST do parytetu (Linear tools, dry-run, `bin/test-dry.bat`)

## 5. Kryteria akceptacji

- [ ] Skład uruchomiony dry-run **wypisuje narzędzia grafu** na liście toolów.
- [ ] Commit w repo z hookiem aktualizuje `graph.json` **bez** wywołania LLM.
- [ ] Run PLAN z grafem odpytuje go przed discovery; run bez grafu kończy się normalnie.
- [ ] Żaden lead nie wskazuje nieistniejącego pliku.
- [ ] Kickoff nie zawiera nazwy modelu ani team-key — jedno źródło prawdy.
- [ ] Wspólna polityka delegacji edytowana w JEDNYM miejscu.
- [ ] Wszystkie istniejące testy przechodzą.
