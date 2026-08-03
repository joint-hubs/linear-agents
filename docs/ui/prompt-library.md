# PRD — Biblioteka promptów (drzewo decyzyjne) + czytanie konwersacji

> Status: **draft do akceptacji** · Data: 2026-07-26 · Repo: `linear-agents`
> Powiązane: `docs/ui/dashboard-launcher-and-squad-config.md`, `docs/ui/control-plane-plan.md`,
> `docs/HOW-TO-RUN-AGENTS.md` (§4 prompty, §6 handoffy)

---

## 1. Problem / Cel

Prompty do składów są dziś rozsypane po trzech miejscach i żadne z nich nie jest widoczne
z dashboardu:

| Co | Gdzie leży dziś |
|---|---|
| Prompt kickoff (to, co wklejasz na starcie) | `scripts/launch.mjs` → `KICKOFF_TEMPLATES` (w kodzie) |
| Ten sam prompt prozą + wariant pojedynczej roli | `docs/HOW-TO-RUN-AGENTS.md` §4 |
| Instrukcja roli (co subagent ma „w głowie") | `agents/<squad>/agents/<rola>.md` |
| Instrukcja leada | `agents/<squad>/CLAUDE.md` |

Efekt: żeby uruchomić skład, trzeba pamiętać albo szukać w plikach. A żeby zrozumieć, **dlaczego
agent zrobił to, co zrobił**, trzeba ręcznie kopać w transkryptach.

**Cel:** jedno miejsce w dashboardzie, gdzie przez klikanie („co chcesz zrobić?") dochodzi się do
właściwego promptu, można go skopiować lub od razu uruchomić, a obok widać **prawdziwe przebiegi,
które tego promptu użyły**, wraz z pełną konwersacją.

Biblioteka ma uczyć systemu, nie być ściągą.

---

## 2. Jak działa uruchamianie — kto co robi

> Ta sekcja trafia też do pomocy w aplikacji (rozwijane „Jak to działa?").

### Co robisz Ty
1. Przeklikujesz drzewo do liścia (np. *Zakodować zadanie* → **DEV**).
2. Wpisujesz identyfikator zadania (np. `JOI-53`).
3. Widzisz **finalny prompt** — już z podstawionym numerem zadania.
4. Wybierasz: **Kopiuj** (wklejasz sam do okna agenta) albo **Uruchom**.

### Co robi system po kliknięciu „Uruchom"
1. Przeglądarka wysyła `POST /api/launch` z `{squad, taskId}`.
2. **Walidacja:** skład musi być z listy (`plan|dev|review|test|cadence`), zadanie musi pasować do
   wzorca `^[A-Z]+-\d+$`. Cokolwiek innego → odmowa.
3. **Ochrona:** żądanie musi przyjść z pętli lokalnej (`127.0.0.1`/`::1`), a jeśli przeglądarka
   przysłała nagłówek `Origin` — musi on też być lokalny. To zabezpieczenie przed tym, żeby obca
   strona otwarta w Twojej przeglądarce mogła po cichu uruchomić agenta.
4. **Złożenie promptu:** `kickoffPrompt(squad, taskId)` bierze szablon i podstawia numer zadania.
   Linie łączone są znakiem ` | ` (nie nowymi liniami), bo całość musi zmieścić się jako **jeden
   argument** wiersza poleceń.
5. **Wrapper:** serwer zapisuje tymczasowy plik `.bat` w `.state/`, który ustawia `LA_TASK_ID`
   i woła `bin/<squad>.bat "<prompt>"`. Prompt siedzi w środku pliku jako jeden cudzysłowowany
   argument — dzięki temu znaki `< > & |` są traktowane dosłownie. Ewentualne cudzysłowy w
   prompcie zamieniane są na apostrofy, żeby nie dało się z argumentu „wyjść".
6. **Nowe okno:** serwer odpala `start "" cmd /k <wrapper>` — otwiera się **prawdziwe okno konsoli**
   na Twoim komputerze. `cmd /k` zostawia je otwarte po zakończeniu, żeby błąd nie zniknął.
   Proces jest odłączony (`detached`), więc żyje niezależnie od serwera.
7. **Dalej to już normalny bieg składu:** `bin/<squad>.bat` → `_lib.bat` (nadaje `RUN_ID`, zapisuje
   manifest, ustawia model i `CLAUDE_CONFIG_DIR`) → `claude "<prompt>"`.
8. **Telemetria:** dzięki `LA_TASK_ID` przebieg od razu jest przypisany do zadania i pojawia się
   na dashboardzie (Live → Runs → Flow).

### Czego system NIE robi
- **Nie hostuje agenta.** Dashboard tylko otwiera okno; agent działa lokalnie, w swoim terminalu.
- **Nie odpowiada agentowi.** Bramki HITL (np. GATE 1/2 w PLAN) obsługujesz Ty w tym oknie.
- **Nie działa zdalnie.** Uruchamianie jest wyłącznie lokalne — z założenia.

**Tryb próbny:** `dryRun` zwraca gotowy prompt i podgląd pliku `.bat` **bez** otwierania okna.
Biblioteka używa go do pokazania „co dokładnie się stanie", zanim klikniesz naprawdę.

---

## 3. Drzewo decyzyjne — struktura

Korzeń pyta o **intencję**, nie o strukturę techniczną. Struktura (skład → rola) pojawia się
dopiero głębiej, gdy jest już potrzebna.

```
Co chcesz zrobić?
├─ Zaplanować nowy feature ..................... → PLAN
├─ Zakodować gotowe zadanie .................... → DEV
├─ Zrecenzować kod ............................. → REVIEW
├─ Przetestować i wdrożyć ...................... → TEST
├─ Podsumować tydzień .......................... → CADENCE
└─ Uruchomić pojedynczą rolę (debug)
   └─ [skład] → [rola] ......................... → bin\agent.bat <area> <rola>
```

> Kontekst promptu (jakie pliki skład realnie zaciąga przez `CLAUDE.md` i dalej) opisuje
> osobny dokument: `docs/ui/prompt-context-tracing.md`.

**Liść składu** pokazuje:
- **Prompt do wklejenia** — szablon z podstawionym `{taskId}`, przycisk *Kopiuj*, przycisk *Uruchom*.
- **Warunek wejścia** — co musi być prawdą, żeby ten skład miał co robić (np. DEV: zadanie w `Todo`
  z etykietą `dor-ok`). Źródło: tabela handoffów z `HOW-TO-RUN-AGENTS.md` §6.
- **Skład osobowy** — lead + subagenci z aktualnymi modelami (te same dane co zakładka Konfiguracja).
- **Instrukcja leada** — treść `agents/<squad>/CLAUDE.md` (podgląd, zwijalny).
- **Ostatnie przebiegi tego składu** — lista z kosztem i statusem; klik → konwersacja.

**Liść roli** pokazuje:
- **Komendę** `bin\agent.bat <area> <rola>` + przykładowy prompt.
- **Instrukcja roli** — treść `agents/<squad>/agents/<rola>.md` (bez frontmatteru).
- **Model i uprawnienia** — z frontmatteru (`model:`, `tools:`), czyli co ta rola *może* zrobić.

---

## 4. Czytanie konwersacji — co trzeba dołożyć

Dziś `/api/flow/log` zwraca **wyłącznie tury asystenta** (`extractAgentTurns` filtruje
`line.type === "assistant"`) i ucina tekst na 8000 znaków. To znaczy, że **nie widać promptów,
które poszły do agenta** — czyli połowy rozmowy.

Do zrobienia:
- `extractAgentTurns` dostaje opcje `includeUser` (dołóż tury użytkownika) i `maxTextLen: null`
  (bez ucinania). Domyślne zachowanie **bez zmian** — istniejący Flow ma działać jak dotąd.
- Tury użytkownika oznaczone rolą (`role: 'user' | 'assistant'`), żeby UI mógł je odróżnić.
- Pierwsza tura użytkownika w przebiegu = **prompt kickoff, który realnie poszedł** → biblioteka
  pokazuje go obok szablonu (widać, czy ktoś go zmodyfikował).
- W UI: długie tury zwinięte z przyciskiem **„pokaż pełny tekst"** zamiast twardego ucięcia.

---

## 5. Zakres

**In:**
- Zakładka „Prompty" z drzewem decyzyjnym (intencja → skład/rola → liść).
- Liść: prompt z podstawianym `taskId`, *Kopiuj*, *Uruchom* (z `dryRun` jako podglądem), warunek
  wejścia, skład + modele, instrukcja (leada/roli), lista ostatnich przebiegów.
- Rozwijana pomoc w aplikacji z treścią sekcji 2 (kto co robi).
- Rozszerzenie `extractAgentTurns` + `/api/flow/log` o tury użytkownika i pełny tekst.
- Pełny tekst tury w `LogDrawer` (rozwijanie zamiast ucięcia).

**Out (faza 2):**
- **Edycja promptów z UI** — na start read-only. Wymagałaby wyniesienia `KICKOFF_TEMPLATES` z kodu
  do `config/prompts.json`; osobna zmiana, osobne ryzyko.
- **Własne/ulubione prompty** Mateusza.
- Wersjonowanie i historia zmian promptów.
- Wyszukiwarka pełnotekstowa po wszystkich konwersacjach.

---

## 6. Architektura

**Nowy moduł `scripts/prompt-library.mjs`** (czysty, testowalny, zero zależności):
- `buildPromptTree(root)` → drzewo intencji + liście, składane z:
  - `KICKOFF_TEMPLATES` (import z `launch.mjs` — jedno źródło, zero duplikatu),
  - frontmatter + treść `agents/<squad>/agents/*.md` (pomijając `plugins/**`),
  - `agents/<squad>/CLAUDE.md`,
  - warunków wejścia (stała tabela w module, zgodna z `HOW-TO-RUN-AGENTS.md` §6).
- `readRoleDoc(squad, role, root)` → `{ model, tools, body }`.

**Endpointy** (cienka warstwa w `telemetry-server.mjs`):
- `GET /api/prompts` → całe drzewo (statyczne, tanie).
- `GET /api/prompts/role?squad=&role=` → instrukcja roli (leniwie, żeby nie ładować wszystkiego).
- `GET /api/prompts/runs?squad=` → ostatnie przebiegi składu (`runId`, `taskId`, koszt, status, czas)
  do listy „ostatnie przebiegi" i skoku do konwersacji.
- `GET /api/flow/log?...&includeUser=1&full=1` → rozszerzenie istniejącego.

**UI:** nowy ekran `ui/src/screens/Prompts.jsx` + trasa `/prompts` + pozycja w menu.
Wykorzystuje istniejący `POST /api/launch` (nic nowego po stronie uruchamiania).

---

## 7. Fazy

1. `scripts/prompt-library.mjs` + testy na fiksturach.
2. `extractAgentTurns`: `includeUser` + `maxTextLen: null` + rola tury; testy (w tym brak regresji
   domyślnego zachowania).
3. Endpointy `/api/prompts*` + rozszerzenie `/api/flow/log`.
4. UI: ekran `Prompts.jsx` (drzewo + liść + uruchamianie + pomoc).
5. UI: `LogDrawer` — tury użytkownika + „pokaż pełny tekst".
6. Weryfikacja e2e + `STATE.md`/`ACCESS.md`.

---

## 8. Kryteria akceptacji

- [ ] Drzewo startuje od intencji; w ≤3 kliknięciach dochodzę do promptu dowolnego z 5 składów.
- [ ] Liść składu pokazuje prompt z podstawionym `taskId` po wpisaniu numeru zadania.
- [ ] *Kopiuj* wstawia do schowka dokładnie ten tekst, który poszedłby do agenta.
- [ ] *Uruchom* w trybie podglądu pokazuje finalny prompt i planowany `.bat`, **nie** otwierając okna.
- [ ] *Uruchom* naprawdę otwiera okno agenta, a przebieg pojawia się w Live z właściwym `taskId`.
- [ ] Liść roli pokazuje model, uprawnienia (`tools`) i pełną instrukcję z pliku roli.
- [ ] Liść składu listuje ostatnie przebiegi; klik prowadzi do konwersacji.
- [ ] Log konwersacji pokazuje **tury użytkownika i asystenta**, a długie tury da się rozwinąć.
- [ ] Domyślne wywołanie `extractAgentTurns` (bez nowych opcji) zwraca to samo co przed zmianą —
      istniejący Flow działa bez modyfikacji.
- [ ] Wszystkie istniejące testy przechodzą (zero regresji na Telemetry v2).
