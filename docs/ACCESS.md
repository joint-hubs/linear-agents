# ACCESS — linear-agents

> Dostępy, sekrety, onboarding workspace'ów i porty. Aktualizuj przy każdej zmianie konfiguracji.
> Linear access: headless GraphQL przez `LINEAR_API_KEY` (NIE MCP — patrz STATE.md T-C2).

---

## Workspaces i teamy

| Workspace slug | LINEAR_TEAM_KEY (env var) | Access level | Notes |
|---|---|---|---|
| `jointhubs` | `LINEAR_TEAM_KEY` | full automation (read+write) | Team **FEN**, projekt "Linear Agents". Wszystkie squady (PLAN/DEV/REVIEW/CADENCE) pushują i odczytują issues. |
| `pisi` | `LINEAR_TEAM_KEY` (browse) | browse-only | Tylko odczyt. **Nie** twórz issues, labelek ani komentarzy bez zgody Mateusza. |

**Zasada:** `LINEAR_TEAM_KEY` w `.env` wskazuje aktywny workspace. Dla `pisi` ustaw wartość ręcznie przed uruchomieniem skryptów read-only; dla `jointhubs` wartość domyślna = `FEN`.

---

## Sekrety

Wszystkie klucze w **`.env`** (gitignored — nigdy nie commitować). Wzór: `.env.example`.

| Zmienna | Przeznaczenie | Skąd wziąć |
|---|---|---|
| `LINEAR_API_KEY` | Linear workspace-scope API key (uprawnienia `api` + `read`) | Linear → Settings → API → Create key |
| `LINEAR_TEAM_KEY` | Klucz teamu w aktywnym workspace (np. `FEN`, `PISI`) | Linear → Team Settings → nazwa teamu |
| `OPENROUTER_API_KEY` | Routing modeli przez OpenRouter (domyślny provider squadów) | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `ANTHROPIC_API_KEY` | Native Anthropic (ścieżka NATIVE, Opus/Sonnet na Pro) | [console.anthropic.com](https://console.anthropic.com) |

**Rotacja klucza:** Linear → Settings → API → revoke stary → new key → zaktualizuj `.env`. Reszta narzędzi (bootstrap, push, query) nie wymaga restartu — czytają `.env` przy każdym uruchomieniu.

---

## Onboarding nowego workspace'a

1. **Utwórz team w Linear** (lub użyj istniejącego) → wygeneruj API key (workspace scope, `api` + `read`) → dodaj `LINEAR_API_KEY` i `LINEAR_TEAM_KEY` do `.env`.

2. **Pełna automatyzacja (jointhubs):** uruchom `node scripts/bootstrap-linear.mjs` — idempotentnie tworzy labelki, grupy i stany z `config/linear/labels.json`. Bezpieczne do wielokrotnego odpalenia. Po sukcesie powstaje marker `.state/teams/<KEY>.provisioned` (kolejne uruchomienia pomijają już istniejące).

3. **Workspace browse-only (pisi):** uruchom `node scripts/bootstrap-linear.mjs --emit-checklist checklist.md` → wyślij wygenerowaną checklistę właścicielowi workspace'a do ręcznego utworzenia w UI Linear. Nie auto-twórz.

4. **Launcher (`bin/_lib.bat`)** auto-wykrywa brak markera `.state/teams/<KEY>.provisioned`: uruchamia `bootstrap --check` (tryb read-only, exit 0 = OK, exit 1 = brakuje) i pyta `y/N` czy provisioningować. Dla browse-only launcher pomija provisioning i wyświetla hint z checklistą.

5. **Weryfikacja:** `node scripts/linear-push.mjs --dry-run` — brak ostrzeżeń "not provisioned" = OK. `linear-push` w trybie live fail-fast (exit 3) jeśli brakuje `type:*` lub `ai:*`.

---

## Porty i URL-e

(brak lokalnych serwisów; squad launchery nie otwierają portów)

Serwery pomocnicze (opcjonalne):
- **Dashboard Fenix (zalecane wejście):** ikona **„Fenix Dashboard"** na pulpicie → `localhost:7331`.
  Jeden proces: `telemetry-server.mjs` serwuje zbudowane UI z `ui/dist` i API pod `/api/*`.
  - Skrót instaluje się raz: `powershell -ExecutionPolicy Bypass -File scripts\install-desktop-shortcut.ps1`
  - Ręcznie: `bin\dashboard.bat` (start, bez okna konsoli) · `bin\dashboard-stop.bat` (stop, ubija po porcie)
  - Po zmianach w `ui/src` trzeba przebudować: `npm --prefix ui run build`
  - Tryb dev UI (Vite + HMR na `:5173`): w `bin\dashboard.bat` ustaw `START_UI=1` i `DASHBOARD_URL=http://localhost:5173`
- **Telemetry API samodzielnie:** `node scripts/telemetry-server.mjs` → `localhost:7331` (env `TELEMETRY_PORT`).
- **0_linear dashboard:** `cd Desktop/experiments/0_linear && npm run dev` → `localhost:3000`. Wymaga działającego telemetry-server.

### Biblioteka promptów (z dashboardu)
Zakładka **Prompty** (`localhost:7331/prompts`) — drzewo decyzyjne „co chcesz zrobić?".
- Liść składu: prompt z podstawionym numerem zadania, *Kopiuj*, *Podgląd uruchomienia* (dry-run,
  nie otwiera okna), *Uruchom* (otwiera prawdziwe okno agenta), warunek wejścia, skład + modele,
  instrukcja leada, lista ostatnich przebiegów z odnośnikiem do konwersacji.
- Liść roli: komenda `bin\agent.bat <squad> <rola>`, model, uprawnienia, pełna instrukcja roli.
- Read-only (prompty edytuje się w plikach; edycja z UI to faza 2).
- Konwersacje: `?includeUser=1&full=1` na `/api/flow/log` — tury użytkownika i pełny tekst bez ucinania.

### Konfiguracja modeli składów (z dashboardu)
Zakładka **Konfiguracja** (`localhost:7331/squad-config`) edytuje modele per skład i cennik.
- Zapisuje **bezpośrednio do plików repo**: `bin/<squad>.bat` (+ `-dry`) dla leada, frontmatter
  `agents/<squad>/agents/<rola>.md` dla subagentów, `config/models.json` dla cennika.
- Zmiana działa **od następnego uruchomienia składu** (nie w trwającej sesji).
- Zapis chroniony localhost-only. Zawsze najpierw „Podgląd zmian" (dry-run pokazuje diff plików).
- Po zmianie pliki są zmodyfikowane w gicie — przejrzyj `git diff` i zacommituj świadomie.

### Centralna telemetria

- **Baza:** `%LOCALAPPDATA%\linear-agents\telemetry\telemetry.sqlite` (override: `LA_TELEMETRY_DB`; katalog: `LA_TELEMETRY_HOME`).
- **Spool awaryjny:** `%LOCALAPPDATA%\linear-agents\telemetry\spool\pending\`; serwer odtwarza go przy starcie i co 15 s wykonuje incrementalny ingest transkryptów.
- **Pierwszy start pustej bazy:** serwer wykonuje backfill automatycznie. Ręcznie: `node scripts/telemetry-ingest.mjs backfill --json`.
- **Naprawa indeksu:** serwer automatycznie dokańcza backfill, gdy liczba runów jest mniejsza od liczby manifestów; pełne wymuszenie: `LA_TELEMETRY_FORCE_BACKFILL=1` przy starcie serwera.
- **Eksport:** `node scripts/telemetry-export.mjs --format jsonl --output telemetry.jsonl` (formaty: `jsonl`, `csv`, `sqlite`).
- **Health:** `http://127.0.0.1:7331/api/telemetry/health` pokazuje pending spool i nierozwiązane problemy jakości danych.
- **Ceny:** API domyślnie zwraca estimate `as-run` według snapshotu cen; `?pricing=current` przelicza wyłącznie odczyt według bieżącego `config/models.json`.
- **Niepełny koszt:** `costUSD:null` oznacza brak ceny co najmniej jednego modelu; `partialCostUSD` jest znanym minimum i UI pokazuje je jako `≥$...`.

---

## Prywatność i ekspozycja danych (JOI-71, pt 4)

**Decyzja: AKCEPTUJEMY** ekspozycję ścieżek FS i nazwy użytkownika OS w `/api/runs` oraz DOM — **bez maskowania**. Dotyczy pól emitowanych przez `scripts/ledger.mjs` (`aggregateRun`): `transcriptPath`, `claudeConfigDir`, `cwd`, `repo`, `gitBranch`. Serwer telemetryczny (`scripts/telemetry-server.mjs`) podaje je bez redakcji do UI.

**Uzasadnienie:**
- Serwer telemetryczny jest **localhost-only** (`localhost:7331`, uruchamiany ręcznie, nie przez launcher — patrz wyżej), jednoużytkownikowy dev (maszyna Mateusza). Brak zewnętrznej ekspozycji.
- `transcriptPath` jest **funkcjonalnie potrzebny** w UI: `RunDetail.jsx` (`CopyPath`) kopiuje pełną ścieżkę do schowka, by Mateusz mógł otworzyć plik transcriptu lokalnie. Maskowanie (`C:\Users\mateu\` → `~/`) łamałoby ten przepływ.
- Pole `title=` na `<code>` (tooltip) oraz `navigator.clipboard.writeText` również potrzebują pełnej ścieżki.

**Twarde ograniczenie (P0):**
- Serwer telemetryczny **NIGDY** nie może być proxy-owany zewnętrznie (ngrok / reverse-proxy / tunnel) bez dodania wcześniej maskowania. W takim przypadku wdrożyć redakcję w warstwie API (`scripts/telemetry-server.mjs` przed `json(res, ...)`) lub env-gate `TELEMETRY_REDACT_PATHS=1`, który maskuje `C:\Users\<user>\` → `~/` w `transcriptPath`/`claudeConfigDir`/`cwd` i wyłącza `CopyPath`.
- Przed ew. external exposure potwierdzić z Mateuszem.

**Status:** decyzja udokumentowana (DoD JOI-71 pt 4). Jeśli polityka się zmieni — zaktualizować ten punkt i wdrożyć maskowanie.

---

## Label signaling

- Definicje labelek/grup: `config/linear/labels.json`
- Protokół: `docs/decisions/linear-signaling-protocol.md`
- Bootstrap: `node scripts/bootstrap-linear.mjs` (idempotentny)
- Push: `node scripts/linear-push.mjs` (GraphQL, zero deps)
