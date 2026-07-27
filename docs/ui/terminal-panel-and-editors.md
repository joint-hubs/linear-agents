# PRD — Panel terminali + edytor promptów + edytor narzędzi

> Status: **draft do akceptacji** · Data: 2026-07-27 · Repo: `linear-agents`
> Powiązane: `docs/ui/control-plane-plan.md` (architektura uruchamiania),
> `docs/ui/prompt-library.md`, `docs/ui/dashboard-launcher-and-squad-config.md`

---

## 0. Zasada nadrzędna: zero nowych zakładek

Dashboard ma już 8 zakładek. Ten PRD **nie dodaje żadnej**:

| Co | Gdzie ląduje |
|---|---|
| Panel terminali | rozbudowa istniejącej zakładki **Tasks** |
| Edytor promptów | modal w zakładce **Prompty** |
| Edytor narzędzi roli | modal w zakładce **Konfiguracja** |

**Obserwacja na później (poza zakresem):** `Live`, `Timeline` i `Runs` to trzy widoki na ten sam
zbiór przebiegów. Naturalny kandydat na scalenie w jeden ekran z przełącznikiem (8 → 6 zakładek).
Osobna decyzja, nie mieszamy jej z tym PRD.

---

## 1. Panel terminali (rozbudowa zakładki Tasks)

### Co już działa (nie budujemy od nowa)
- `GET /api/linear/queue` — kolejka zadań z Linear + `suggestedSquad` z reguł handoffu.
- `POST /api/launch` — walidacja, ochrona localhost, złożenie kickoffu, wrapper `.bat`,
  otwarcie okna, `LA_TASK_ID` → automatyczne przypisanie przebiegu do zadania.
- Zakładka Tasks: lista zadań + przyciski uruchomienia dla `dev|review|test`.

### Czego brakuje
1. Okna nie mają nazw — `spawnLauncher` woła `start ""` (pusty tytuł).
2. Nie widać w jednym miejscu, **które agenty żyją teraz** i nad czym pracują.
3. Nie da się wrócić do działającej sesji.

### Nazywanie okien
`spawnLauncher` dostaje tytuł i woła `start "fenix · <squad> · <taskId>" cmd /k <wrapper>`.
Tytuł trafia też do manifestu (`windowTitle`), żeby panel wiedział, czego szukać.

### Przywracanie okna — i jego granice
- **Uruchomione z dashboardu** → osobne okno konsoli z własnym tytułem → da się uaktywnić
  (`WScript.Shell.AppActivate`, bez dodatkowych zależności). Przycisk **„Pokaż okno"**.
- **Uruchomione ręcznie** (np. terminal zintegrowany VS Code) → to pseudo-terminal wewnątrz
  innej aplikacji, **nie osobne okno**. Nie da się uaktywnić konkretnej karty z zewnątrz.
  Panel pokazuje wtedy etykietę „uruchomiony ręcznie" + `cwd` + `runId` do rozpoznania,
  i **nie pokazuje przycisku, który by nie zadziałał**.

Rozróżnienie zapisuje manifest: wrapper `.bat` ustawia `LA_LAUNCHED_BY=dashboard` i
`LA_WINDOW_TITLE`, `run-manifest start` je utrwala. Brak tych zmiennych = uruchomienie ręczne.

### Wykrywanie żywych terminali (i dlaczego to nie obciąży systemu)
- Manifest ma `endedAt=null` dopóki launcher nie zakończy przebiegu → kandydaci na „żywe".
- Weryfikacja: **jedno** zapytanie o istnienie procesu (po tytule okna / PID) na żądanie,
  przy odświeżeniu panelu. Bez demonów, bez obserwatorów w tle, bez subskrypcji.
- Zakończone przebiegi **nie są dodatkowym kosztem** — czyta się je z SQLite, które i tak jest
  źródłem dla Runs/Costs.
- Panel odświeża się tym samym pollingiem co dziś Tasks (10 s), nie częściej.

### Układ zakładki Tasks po zmianie
```
[ Terminale ]  ← NOWA sekcja, na górze
  ● dev · JOI-53 · 12m · $1.84        [Pokaż okno]  [Zatrzymaj]
  ● plan · FOC-15 · 3m · $0.42        [uruchomiony ręcznie · office]
  (gdy pusto: „Żaden agent nie działa.")

[ Do wzięcia ]  ← istniejąca kolejka Linear, bez zmian
  JOI-61  dev   [Uruchom]
  ...

[ Czeka na Ciebie ]  ← istniejące needs:*, bez zmian

[ ▸ Ostatnio zakończone ]  ← ZWINIĘTE domyślnie (żeby nie zaśmiecać)
  dev · JOI-53 · done · $1.84   [Uruchom ponownie z tym zadaniem]
```
Sekcja zakończonych jest **domyślnie zwinięta** i ograniczona do ostatnich ~15 pozycji.

### Endpointy
- `GET /api/terminals` → `[{ runId, squad, taskId, startedAt, windowTitle, launchedBy,
  cwd, alive, costUSD, partialCostUSD, unpricedUsageCount }]` — żywe + ostatnie zakończone.
- `POST /api/terminals/focus` `{runId}` → uaktywnia okno; `409` gdy `launchedBy != dashboard`
  albo okna już nie ma (z czytelnym komunikatem, nie cichą porażką). Localhost-only.
- `POST /api/terminals/stop` `{runId}` → zamyka okno agenta. Localhost-only, **wymaga
  potwierdzenia w UI** (przerywa pracę agenta).

---

## 2. Edytor promptów (modal w zakładce Prompty)

### Problem
Prompty kickoff są **w kodzie** (`scripts/launch.mjs` → `KICKOFF_TEMPLATES`). Nie da się ich
edytować z UI, a gdyby UI trzymało własną kopię, uruchomienie i biblioteka by się rozjechały.

### Rozwiązanie: jedno źródło w `config/prompts.json`
```json
{
  "_doc": "Szablony kickoff per skład. {taskId} podstawiane przy uruchomieniu.",
  "kickoff": {
    "dev": ["Weź task {taskId} (Todo, dor-ok). Krok po kroku wg FENIX_WORKFLOW §5:", "..."],
    "plan": ["..."], "review": ["..."], "test": ["..."], "cadence": ["..."]
  }
}
```
- `launch.mjs` czyta plik zamiast trzymać stałą. **Eksport `KICKOFF_TEMPLATES` zostaje**
  (czyta z pliku), żeby `prompt-library.mjs` i testy nie wymagały zmian.
- Brak pliku / uszkodzony JSON → **fallback na wbudowane wartości** + ostrzeżenie w logu.
  Uruchamianie agentów nie może paść przez literówkę w JSON-ie.
- Klucze `_*` traktowane jak w `models.json` (filtrowane przy odczycie, zachowywane przy zapisie).

### UI
- W liściu składu przycisk **„Edytuj prompt"** → modal z polem tekstowym (jedna linia szablonu
  = jedna linia w polu), podglądem z podstawionym `{taskId}`, przyciskami *Zapisz* / *Anuluj* /
  *Przywróć domyślny*.
- Ostrzeżenie, gdy w szablonie brakuje `{taskId}` (nie blokuje — cadence go nie używa).
- Zapis: `POST /api/prompts/kickoff` `{squad, lines[]}`, localhost-only, z podglądem diffa.
- Po zapisie komunikat: zmiana obowiązuje **od następnego uruchomienia**.

---

## 3. Edytor narzędzi roli (modal w zakładce Konfiguracja)

### Problem
`tools:` we frontmatterze roli decyduje, **co agent fizycznie może zrobić** (to była przyczyna
F0: subagenci bez `Bash` nie mogli budować ani commitować). Dziś edytuje się to ręcznie w pliku.

### Katalog narzędzi — `config/tools.json` (nowy)
W rolach używanych jest dziś sześć narzędzi. Katalog opisuje je po polsku i oznacza ryzyko:

| Narzędzie | Co robi | Ryzyko |
|---|---|---|
| `Read` | czyta zawartość pliku | bezpieczne |
| `Grep` | szuka tekstu/wzorca w plikach | bezpieczne |
| `Glob` | znajduje pliki po wzorcu nazwy | bezpieczne |
| `Edit` | **zmienia** istniejący plik | zmienia kod |
| `Write` | **tworzy/nadpisuje** plik | zmienia kod |
| `Bash` | uruchamia komendy (build, testy, git) | zmienia system |
| `Task` | **zleca pracę kolejnemu subagentowi** | zagnieżdża delegację |
| `WebFetch`, `WebSearch` | pobiera/szuka w sieci | wychodzi na zewnątrz |

`Task` jest w katalogu celowo: dziś **żadna rola go nie ma**, co gwarantuje płaską hierarchię
(lead → subagent, bez schodzenia głębiej). Nadanie go zmienia architekturę, więc checklista musi
to jasno komunikować, a nie traktować jak zwykły ptaszek.

### UI
- Przy każdej roli w karcie składu przycisk **„Narzędzia"** → modal z **tabelą-checklistą**:
  kolumny `[✓] · Narzędzie · Co robi · Ryzyko`.
- Narzędzia oznaczone jako zmieniające kod/system wyróżnione wizualnie.
- Zaznaczenie `Task` → wyraźne ostrzeżenie o skutku architektonicznym.
- Zapis przez istniejący `POST /api/squad-config` — rozszerzony o `agents.<rola>.tools: []`.
- `squad-config.mjs` uczy się zapisywać linię `tools:` we frontmatterze (dziś umie tylko `model:`),
  zachowując resztę pliku bez zmian.

---

## 4. Poprawka: kickoff wypada z konwersacji (bug)

`extractAgentTurns` odrzuca tury spoza okna `[startedAt, endedAt+60s]`. Zmierzone na przebiegu
FOC-38: kickoff ma znacznik `08:19:00`, a przebieg startuje `08:19:20` — **prompt otwierający
rozmowę jest wycinany**, czyli konwersację widać bez jej początku.

Poprawka: przy `includeUser` **pierwsza tura użytkownika w transkrypcie jest zawsze dołączana**,
niezależnie od okna (to samo, co robi już `parseTranscript.firstUserText` przy wykrywaniu zadania),
oraz okno dla tur użytkownika jest poszerzone wstecz o 5 minut. Tury asystenta bez zmian.

---

## 5. Zakres

**In:** wszystko z sekcji 1–4.

**Out (świadomie):**
- Uruchamianie zdalne / tmux — jest w `control-plane-plan.md`, osobny temat.
- Przywracanie karty terminala w VS Code — technicznie niewykonalne z zewnątrz.
- Własne/ulubione prompty operatora, wersjonowanie promptów.
- Scalenie Live/Timeline/Runs — osobna decyzja.

## 6. Fazy
1. Poprawka kickoffu (sekcja 4) + test.
2. `config/prompts.json` + czytanie w `launch.mjs` z fallbackiem + testy.
3. `config/tools.json` + zapis `tools:` w `squad-config.mjs` + testy.
4. Nazywanie okien + `launchedBy`/`windowTitle` w manifeście + endpointy `/api/terminals*`.
5. UI: sekcja Terminale w Tasks.
6. UI: modal edytora promptów + modal edytora narzędzi.
7. Weryfikacja e2e + `STATE.md`/`ACCESS.md`.

## 7. Kryteria akceptacji
- [ ] Okno agenta uruchomionego z dashboardu ma tytuł `fenix · <squad> · <taskId>`.
- [ ] Sekcja Terminale pokazuje żywe agenty z zadaniem, czasem i kosztem.
- [ ] „Pokaż okno" podnosi właściwe okno; dla uruchomionych ręcznie przycisku nie ma,
      jest za to etykieta i `cwd`.
- [ ] Zakończone przebiegi są domyślnie zwinięte i nie spowalniają odświeżania panelu.
- [ ] Edycja promptu z UI zmienia `config/prompts.json`, a kolejne uruchomienie używa nowej treści.
- [ ] Uszkodzony `config/prompts.json` **nie blokuje** uruchamiania agentów (fallback + ostrzeżenie).
- [ ] Checklista narzędzi zapisuje `tools:` w pliku roli, nie ruszając reszty frontmatteru.
- [ ] Zaznaczenie `Task` ostrzega o zmianie architektury na zagnieżdżoną delegację.
- [ ] Konwersacja zaczyna się od realnego kickoffu.
- [ ] Liczba zakładek: 8 przed, 8 po.
- [ ] Wszystkie istniejące testy przechodzą.
