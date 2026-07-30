# Audyt kodu linear-agents — przejrzystość i utrzymanie

> Data: 2026-07-30 · Metoda: graf graphify (1436 węzłów, 2641 krawędzi, 146 społeczności) + pomiar bezpośredni
> Zakres: 75 plików kodu, 26 734 linie

---

## Podsumowanie

Kod nie jest zaniedbany — testy są, moduły mają jasne role, a nazwy niosą znaczenie. Problemy są **strukturalne, nie kosmetyczne**: kilka miejsc urosło ponad rozmiar, w którym da się je bezpiecznie zmieniać, i jedno z nich jest dokładnie tym, które dotyka się najczęściej.

Kolejność wg kosztu utrzymania, nie wg rozmiaru.

---

## 1. Jeden handler HTTP na 1023 linie — najdroższe miejsce w repo

`scripts/telemetry-server.mjs` ma 1607 linii, z czego **linie 504–1526 to jedna funkcja**: callback `createServer`. W środku **21 gałęzi `if (path === ...)`** ułożonych liniowo.

Powtarzalny boilerplate wewnątrz:

| wzorzec | powtórzeń |
|---|---:|
| `log(method, path, 200)` | 39 |
| `json(res, 200, ...)` | 38 |
| kontrola origin / localhost-only | 15 |

**Dlaczego to boli:** dodanie endpointu polega na znalezieniu właściwego miejsca w tysiąclinijkowym łańcuchu i skopiowaniu trzech linii obrzeża. Robiłem to dziś dwa razy (`/api/runs/task`, `/api/delegation-outcomes`) — za każdym razem przez dopasowanie stringa do sąsiedniego route'a, bo nie ma innego punktu zaczepienia. Przy 21 gałęziach kolejność ma znaczenie i nic tego nie pilnuje.

**Kierunek:** tablica routingu zamiast łańcucha `if`.

```js
const ROUTES = [
  ['GET',  '/api/summary',             handleSummary],
  ['POST', '/api/runs/task',           handleRunTask,   { localOnly: true }],
  ['GET',  '/api/delegation-outcomes', handleOutcomes],
];
```

Logowanie, `json()`, kontrola origin i obsługa błędów przechodzą do jednego opakowania. Zysk: handler kurczy się do ~50 linii, każdy endpoint staje się osobną testowalną funkcją, a `localOnly` przestaje być czymś, o czym trzeba pamiętać przy kopiowaniu.

Nie trzeba tego robić za jednym zamachem — tablica może współistnieć z resztą łańcucha i przejmować route'y po jednym.

## 2. Dwie równoległe ścieżki odczytu telemetrii

Po migracji na SQLite stara ścieżka plikowa **nie zniknęła** — została jako fallback pod `LA_TELEMETRY_READ_SOURCE=files`:

- **8 rozgałęzień** `if (!useCentralStore())` w serwerze
- `buildSummary(runs)` — **120 linii wołane z dokładnie jednego miejsca**: tego fallbacku (linia 167)
- `scripts/ledger.mjs` — **1265 linii**, w serwerze używane `scanRuns` (4×), `aggregateByTask` (2×), `aggregateRun`, `extractAgentTurns`

**Dlaczego to boli:** każda zmiana w liczeniu kosztów potencjalnie musi być zrobiona dwa razy, a wersja plikowa jest w praktyce nieuruchamiana — więc rozjeżdża się po cichu. Dokładnie ta klasa błędu, którą łapie `config-drift.test.mjs`, tylko że w kodzie.

**Ważne zastrzeżenie:** `ledger.mjs` **nie jest martwy**. Poza fallbackiem używają go `cost-per-task.mjs`, `backfill-task-ids.mjs`, `flow-db.mjs` i trzy pliki testowe. Usunięcie go to osobna decyzja, nie sprzątanie.

**Kierunek:** zdecydować, czy fallback plikowy jest jeszcze potrzebny. Jeśli nie — znika 8 rozgałęzień i 120 linii `buildSummary`, a `ledger.mjs` zostaje wyłącznie jako biblioteka dla narzędzi offline. Jeśli tak — powinien mieć test, który go faktycznie uruchamia, bo dziś nie ma.

## 3. Funkcje powyżej 100 linii

| funkcja | linii | plik |
|---|---:|---|
| `migrate(db)` | 185 | `telemetry-store.mjs` |
| `aggregateRun(...)` | 162 | `ledger.mjs` |
| `parseTranscript(absPath)` | 137 | `ledger.mjs` |
| `buildSummary(runs)` | 120 | `telemetry-server.mjs` |
| `makeRunProjection(...)` | 107 | `telemetry-store.mjs` |

`migrate` jest najbardziej naturalnym kandydatem: to sekwencja niezależnych kroków `ALTER TABLE`/`CREATE TABLE`, które da się rozbić na listę migracji z numerem wersji. Dziś dopisanie kolumny oznacza wejście w środek 185 linii i dostawienie kolejnego `if (!columns.includes(...))` — robiłem to przy `console_pid`.

Pozostałe są trudniejsze, bo to prawdziwie sekwencyjna logika parsowania. Nie warto ich dzielić na siłę — warto natomiast, żeby miały testy jednostkowe na fragmentach, a nie tylko end-to-end.

## 4. Komponenty UI po 1000+ linii

| plik | linii | komponentów | linii/komponent |
|---|---:|---:|---:|
| `ui/src/screens/Prompts.jsx` | 1112 | 9 | 124 |
| `ui/src/screens/SquadConfig.jsx` | 1017 | 10 | 102 |
| `ui/src/screens/Tasks.jsx` | 639 | 10 | 64 |
| `ui/src/screens/Costs.jsx` | 610 | 6 | 102 |

`RoleLeaf` w Prompts.jsx ma 123 linie, `SquadLeaf` podobnie. To nie jest krytyczne — te ekrany zmieniają się rzadziej niż serwer — ale przekracza próg, przy którym trzeba scrollować, żeby zobaczyć cały komponent.

**Kierunek:** wyciągnąć liście drzewa (`RoleLeaf`, `SquadLeaf`) do `ui/src/components/`. Tam już są `Modal.jsx` i `RunTaskModal.jsx`, więc konwencja istnieje.

## 5. `squad-config.test.mjs` — 1138 linii, 7 symboli

Największy plik testowy, **163 linie na symbol**. Dla porównania `telemetry-store.test.mjs` ma 433 linie przy 117 asercjach.

Nie jest to zły test — jest nieustrukturyzowany. Przy takiej długości znalezienie asercji, która pękła, wymaga przeszukiwania.

**Kierunek:** podział wg obszaru (odczyt konfiguracji / zapis modeli / zapis cennika / narzędzia ról), tak jak zrobione jest w `telemetry-store.test.mjs`.

## 6. Punkty o największym zasięgu zmiany

Symbole osiągalne z największej liczby różnych plików — tu każda zmiana sygnatury promieniuje najszerzej:

| symbol | plików | zdefiniowany w |
|---|---:|---|
| `fmtCost()` | 10 | `ui/src/utils.js` |
| `costValue()` | 8 | `ui/src/utils.js` |
| `linearUrl()` | 8 | `ui/src/config.js` |
| `statusLabel()` | 7 | `ui/src/utils.js` |
| `openTelemetryDb()` | 5 | `scripts/telemetry-store.mjs` |

To **nie jest wada** — tak wygląda zdrowy moduł narzędziowy. Warto natomiast wiedzieć, że `ui/src/utils.js` jest najbardziej sprzęgającym plikiem w UI, i traktować zmiany w nim jako zmiany kontraktu. Graf potwierdził to niezależnie: `fmtCost()` ma 25 krawędzi i jest ósmym najbardziej połączonym węzłem w całym repo — a jego brakujący import wybielił kiedyś całą zakładkę Tasks.

---

## Czego audyt NIE znalazł

Warto powiedzieć wprost, żeby lista wyżej nie brzmiała groźniej, niż jest:

- **brak martwego kodu** na dużą skalę — sprawdzone dla `ledger.mjs` i `flow-db.mjs`, oba mają realnych konsumentów
- **brak duplikacji helperów** między UI a skryptami — `fmtUSD`, `costValue`, `statusLabel` istnieją tylko w `ui/src/utils.js`
- **testy pokrywają rdzeń** — 10 plików testowych, w tym kontraktowe dla store'a i strażnik dryfu konfiguracji
- **nazewnictwo jest spójne** — nie znalazłem miejsc, gdzie ta sama rzecz nazywa się różnie w różnych plikach

## Kolejność, gdyby robić

1. **Tablica routingu** (§1) — największy zysk, da się robić przyrostowo, dotyka miejsca zmienianego najczęściej
2. **Decyzja o fallbacku plikowym** (§2) — nie kod, tylko decyzja; odblokowuje usunięcie ~130 linii i 8 rozgałęzień
3. **Rozbicie `migrate()`** (§3) — mechaniczne, niskie ryzyko
4. **Liście Prompts.jsx do `components/`** (§4) — kosmetyka, ale tania
5. **Podział `squad-config.test.mjs`** (§5) — najniższy priorytet, czysto ergonomiczny
