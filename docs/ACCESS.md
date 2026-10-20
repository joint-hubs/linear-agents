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

**Provider profiles (`config/models.json::providers`):** każdy profil providera (`openrouter`,
`anthropic`, custom) ma pole `authEnv` — nazwę zmiennej env, w której trzymany jest klucz API.
Wartość klucza żyje WYŁĄCZNIE w `.env` (gitignored) — nigdy w `models.json` (git-tracked), nigdy
w komentarzach Linear, nigdy w kodzie ani logach. Domyślny provider `openrouter` wymaga
`OPENROUTER_API_KEY`. Dodanie nowego providera = nowy wpis `authEnv` w `.env` + wpis profilu w
`config/models.json::providers`. PRD: `docs/ui/provider-config.md`, ADR: `docs/adr/0010-provider-profiles.md`.
W Dockerze klucz providera żyje w `.fenix/secrets/` (patrz wyżej); overlay `.fenix/config/settings.json` przechowuje tylko aktywnego providera i jego kształt (baseUrl/authStyle/nazwa zmiennej) — nigdy wartość klucza.

- **Fenix w Dockerze (1.0.0):** klucze w `.fenix/secrets/` (`openrouter_api_key`, `provider_api_key`, `linear_api_key`, `github_token` — owner-only, gitignored, nigdy w obrazie ani w logach). `fenix-supervisor` czyta je read-only jako Compose secrets pod `/run/secrets/`; `fenix-api` dostaje dodatkowo **read-write bind-mount `.fenix/secrets` → `/fenix-secrets`** (rotacja kluczy z dashboardu — decyzja bezpieczeństwa Mateusza 2026-10-13, ograniczona do `fenix-api`). Puste placeholdery tworzy `fenix` przy `up`, żeby Compose nie padał na brakującym pliku sekretu.
- **Rotacja klucza (od FOC-773/786):** dwie drogi — `fenix keys [openrouter|provider|linear|github]` (wizard CLI; `fenix keys provider` obraca klucz **aktywnego** providera) albo **Settings → Keys** w dashboardzie (`PUT /api/settings/keys/:name`: live-check przed zapisem, zapis in-place z trybem 0600, odrzucony klucz → 400 i nic nie zapisane). Walidacja idzie przez **wspólny `scripts/key-check.mjs`** uruchamiany w kontenerze `fenix-api` — klucz przekazywany wyłącznie przez stdin (nigdy argv/env/log). Obrócony klucz biorą od razu nowe dzieci; Supervisor podbiera go przy swojej następnej świeżej sesji (kontrakt hot reload w recenzji — patrz QUICKSTART).
- **Weryfikacja i leak-check:** `node scripts/key-check.mjs provider|linear|github` (klucz na stdin; wynik `{ok, reason, details}` — nigdy wartość klucza; sieciowy błąd nazywa endpoint, nie nagłówek) oraz `node scripts/key-leak-check.mjs --canary-file <plik>` (kanaryjki skanowane po `docker inspect`, logach kontenerów, store'ie telemetrii i spoolu, run tee i records oraz rejestrze; wynik „found / not found" per powierzchnia, wartości kanaryjek tylko z plików, nigdy argv).
- **Overlay ustawień:** `.fenix/config/settings.json` (w kontenerze `/fenix-config/settings.json`) — `provider.active` / `provider.custom` (baseUrl, authStyle `token|apikey`, keyName, tiers, defaultModel) + `routing.<squad>.lead`; przeżywa `fenix update` (`config/models.json` pozostaje baseline z obrazu). `LA_PROVIDER` env nadal wygrywa z overlayem. Overlay walidowany restrykcyjnie — nieznane klucze i wartości wyglądające jak sekret (regexy `sk-or-`/`sk-ant-`/`gh*_`/`github_pat_`/`lin_api_`) są odrzucane przy zapisie.

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
- Liść roli: komenda `bin\agent.bat <squad> <rola>`, model, uprawnienia, pełna instrukcja roli. `bin\agent.bat` still works (a two-line wrapper now); cross-platform form: `node scripts/squad-start.mjs --agent <squad> <rola>`.
- Read-only (prompty edytuje się w plikach; edycja z UI to faza 2).
- Konwersacje: `?includeUser=1&full=1` na `/api/flow/log` — tury użytkownika i pełny tekst bez ucinania.

### Konfiguracja modeli składów (z dashboardu)
Zakładka **Konfiguracja** (`localhost:7331/squad-config`) edytuje modele per skład i cennik.
- Zapisuje **bezpośrednio do plików repo**: `bin/<squad>.bat` (+ `-dry`) dla leada, frontmatter
  `agents/<squad>/agents/<rola>.md` dla subagentów, `config/models.json` dla cennika.
- Zmiana działa **od następnego uruchomienia składu** (nie w trwającej sesji).
- Zapis chroniony localhost-only. Zawsze najpierw „Podgląd zmian" (dry-run pokazuje diff plików).
- Po zmianie pliki są zmodyfikowane w gicie — przejrzyj `git diff` i zacommituj świadomie.

### Ustawienia (Settings, FOC-773/778/786)
Obszar **Settings** w lewej nawigacji: `/settings/keys` (domyślna), `/settings/provider`,
`/settings/repos`, `/settings/retention`; v1 zakładki `/squad-config` („Advanced routing (v1)") i
`/prompts` („Squads & prompts (v1)") są częścią tego obszaru.
- **Keys** — obecność każdego klucza + ostatni live-check (nigdy wartości ani długości); walidacja
  i rotacja z UI (live-check przed zapisem; odrzucony klucz niczego nie zapisuje).
- **Provider & routing** — aktywny provider (OpenRouter / skonfigurowany / custom endpoint
  Anthropic-compatible: baseUrl, authStyle, defaultModel) z live testem przed zapisem; lead model
  per skład z ceną z zakresu aktywnego providera; model bez ceny = „unpriced" (dozwolony, opisany).
- **Repositories** — lista repo (origin, HEAD, branch, stan indeksu CodeGraph, liczba worktree,
  mapowany projekt Linear), dodawanie przez klon w tle (`POST /api/settings/repos` → status joba),
  usuwanie mapowania projektu (pliki repo zostają).
- **Retention** — read-only: `cleanupPeriodDays` w mocy, zużycie dysku (transkrypcje / telemetria /
  workspaces) i wolne miejsce; zarządzanie polityką zostaje w FOC-780.

Edycja providera i rutingu z UI trafia do overlayu `.fenix/config/settings.json` (przeżywa
`fenix update`); zmiana jest skuteczna od następnego spawna (hot reload w recenzji — QUICKSTART).
Sekrety nie edytowane w `models.json` ani w UI poza polem hasła (czyszczone po wysłaniu).

### Centralna telemetria

- **Baza:** `%LOCALAPPDATA%\linear-agents\telemetry\telemetry.sqlite` (override: `LA_TELEMETRY_DB`; katalog: `LA_TELEMETRY_HOME`).
- **Spool awaryjny:** `%LOCALAPPDATA%\linear-agents\telemetry\spool\pending\`; serwer odtwarza go przy starcie i co 15 s wykonuje incrementalny ingest transkryptów.
- **Pierwszy start pustej bazy:** serwer wykonuje backfill automatycznie. Ręcznie: `node scripts/telemetry-ingest.mjs backfill --json`.
- **Naprawa indeksu:** serwer automatycznie dokańcza backfill, gdy liczba runów jest mniejsza od liczby manifestów; pełne wymuszenie: `LA_TELEMETRY_FORCE_BACKFILL=1` przy starcie serwera.
- **Eksport:** `node scripts/telemetry-export.mjs --format jsonl --output telemetry.jsonl` (formaty: `jsonl`, `csv`, `sqlite`).
- **Health:** `http://127.0.0.1:7331/api/telemetry/health` pokazuje pending spool i nierozwiązane problemy jakości danych.
- **Ceny:** API domyślnie zwraca estimate `as-run` według snapshotu cen; `?pricing=current` przelicza wyłącznie odczyt według bieżącego `config/models.json`.
- **Niepełny koszt:** `costUSD:null` oznacza brak ceny co najmniej jednego modelu; `partialCostUSD` jest znanym minimum i UI pokazuje je jako `≥$...`.
- **Nagrody / XP (FOC-225):** osobna baza append-only `%LOCALAPPDATA%\linear-agents\rewards\rewards.sqlite` (override: `LA_REWARDS_DB`; katalog: `LA_REWARDS_HOME`) — nigdy `telemetry.sqlite`. Ingest działa przy odczycie `GET /api/manager/rewards` (cache TTL 30 s obejmuje sam ingest; squad-y/ratingi/held czytane świeżo do każdego payloadu).
- **Koszt per ticket (FOC-769):** `node scripts/ticket-cost.mjs [--since <ISO|Nd>] [--until <ISO>] [--json]` (read-only; okno half-open po `observed_at`; raport: per ticket children/supervisor/total + `overheadUsd`, `unattributedUsd`, `untaggedChildrenUsd` i udział atrybucji Supervisora — target ≥ 80 %, PRD §3).
- **Rekoncyliacja kosztu (FOC-760/761):** `node scripts/cost-reconcile.mjs [--state-home <dir>] [--db <path>] [--run <runId>] [--json] [--strict]` (read-only: registry vs telemetria vs transkrypty per child; `--strict` exit 1 przy odchyłce > 1 % / telemetrii multi-turn < 0.99).
- **Jednorazowy recompute rejestru (FOC-760):** `node scripts/registry-cost-recompute.mjs [--state-home <dir>] [--run <runId>] [--apply] [--json]` — **dry run domyślnie**; `--apply` (tylko za zgodą Mateusza, po przeglądzie dry-runu) przepisuje `children.json`. Dzieci z transkryptem: `costSource: "transcript"` (stara wartość zachowana w `costUsdLegacy`); bez transkryptu: wartość bez zmian, `costSource: "legacy-unverified"` (status wypisuje je przy totalu — nigdy nie traktowane cicho jako sprawdzone); in-flight pomijane. Zastosowane na Windows 2026-10-13: 381 dzieci, $976.80 → $176.51 (35 `legacy-unverified`).
- **Dashboard v2 Work i Costs & quality (FOC-784/785):** `/work` — board Ready → Plan → Dev → Review → Test → Landed (Ready = otwarte, jeszcze nieruszone issue z kolejki Linear workspace `jointhubs`, zmiana: `FENIX_WORK_WORKSPACE`; Landed = stan issue w Linear typu `completed`); `/work/:ticket` — timeline, koszt (dzieci + udział Supervisora) z linią uzgodnienia transkrypt / telemetria / rejestr, dowody, **Start** (podgląd dokładnego tekstu, dopiero potem wysłanie do Supervisora; bez session hosta — „Open in Cockpit” z wypełnionym czatem); `/costs` — 7d / 30d / All, KPI p20/p50/p80, baner atrybucji < 80 %, wydatki per dzień, mix modeli, sygnały jakości z definicjami, najdroższe tickety z „why”. API: `GET /api/work/tickets`, `GET /api/work/tickets/:id`, `GET /api/work/tickets/:id/start-preview`, `POST /api/work/tickets/:id/start` (te same guardy co czat), `GET /api/costs?period=`, `GET /api/quality?period=`. Koszty liczy proces potomny `node scripts/cost-snapshot.mjs --json` (store tylko do odczytu; odświeżanie najwyżej co 2 min, `FENIX_COST_SNAPSHOT_TTL_MS`; fakty ticketów z rejestrów cache 10 s, `FENIX_WORK_FACTS_TTL_MS`); dane starsze niż 5 min mają etykietę „stale”. `fenix-api` używa `LINEAR_API_KEY` (opcjonalnie `LINEAR_API_KEY_PISI`) do kolumny Ready i stanów ticketów. Seam wyłącznie testowy: `NODE_ENV=test` + `FENIX_LINEAR_FAKE_FILE` (fixture zamiast Linear; obraz nie ustawia `NODE_ENV`).

### Analysis screen (branch `feat/telemetry-analysis-dashboard`)

- **Po merge:** `http://127.0.0.1:7331/analysis` — pięć paneli + read-only SQL console; dane z derived analysis cache.
- **Na branchu (dev server, port 7341 — nie koliduje z `:7331`):**

  ```
  TELEMETRY_PORT=7341
  LA_TELEMETRY_HOME=%LOCALAPPDATA%\linear-agents\telemetry-dev-381
  LA_TELEMETRY_DB=%LOCALAPPDATA%\linear-agents\telemetry-dev-381\telemetry.sqlite
  LA_STATE_ROOT=%LOCALAPPDATA%\linear-agents\telemetry-dev-381\state
  LA_DECISION_RUNS_DIR=<repo>\.state\runs
  node scripts/telemetry-server.mjs
  ```

- **Cache:** `%LOCALAPPDATA%\linear-agents\telemetry-dev-381\analysis-cache.sqlite` (override: `LA_ANALYSIS_CACHE`) — dysposylna pochodna store'a; odbudowa przyciskiem **Refresh** w UI (rebuild chodzi jako child process).
- **Zasada twarda:** dev server **nigdy** nie wskazuje na live store (`%LOCALAPPDATA%\linear-agents\telemetry\`) — tylko na kopię dev (`telemetry-dev-381`). Live store otwiera dopiero okno produkcyjne (merge + rewrite `--apply --live`), na wyraźne „go" Mateusza.

### Fenix w Dockerze (1.0.0)

- **Dashboard/API:** `http://localhost:4600` — publikowany tylko na `127.0.0.1` hosta (port kontenera 7331). Inny port hosta: env `FENIX_PORT` (np. `FENIX_PORT=4601 ./fenix up`).
- **Obraz opublikowany (FOC-775, od 2026-10-19):** `ghcr.io/joint-hubs/fenix` — paczka publiczna (decyzja Mateusza 2026-10-19; repo też jest publiczne). Publikuje workflow `.github/workflows/publish-image.yml` tokenem repozytorium (`GITHUB_TOKEN`, `packages: write`): tag `v*` → `:<wersja>` + `:sha-<skrót>` (+ `:latest` dla zwykłego wydania bez `-rc`), ręczne uruchomienie (`gh workflow run publish-image.yml --ref main`) → `:main` + `:sha-<skrót>` jako przebieg próbny. Obraz jest zbudowany dla uid/gid 1000; `fenix up`/`update` dokłada cienką warstwę pod inny uid (FOC-777). Rozmiar i wersje narzędzi: podsumowanie joba. Widoczność paczki: Settings organizacji → Packages (gdyby pierwszy push wylądował jako prywatny).
- **Zapisy z dashboardu w kontenerze:** API ufa loopbackowi i bramce sieci Dockera (ruch z hosta przez port 127.0.0.1:4600); inne kontenery są odrzucane, sprawdzanie `Origin` bez zmian (FOC-800).
- **Kontenery:** `fenix-api` (dashboard + telemetry API) i `fenix-supervisor` (Supervisor — Claude Code — działa w niej stale w sesji tmux; `fenix attach` się do niej podpina, Ctrl-b d odczepia i Supervisor pracuje dalej).
- **Session host (FOC-783):** port `7332` wewnątrz sieci compose — **nigdy publikowany na hoście**; przyjmuje wyłącznie kontener `fenix-api` (sprawdzenie adresu peera) + token. Token: `/data/run/host.token` (0600, losowany na każdym starcie supervisora — API czyta go per request). Stan sesji: `/data/supervisor/session.json` (pisany przez hooki). Bieżący run Supervisora: `/data/supervisor/current-run.json` (`runId`, `model`, `source`; FOC-807 — wznowienie zachowuje run, `fenix attach --new` zaczyna nowy; od FOC-769 też pole `focus` — `{kind, taskId, at, source}` — deklaracja `supervisor-focus.mjs set`, pisana tylko gdy rekord wskazuje na ten run; podgląd: `docker compose exec fenix-supervisor node /opt/fenix/scripts/supervisor-current-run.mjs show --json`). Deklaracje fokusu runu: `<stateHome>/<runId>/focus.jsonl` (FOC-769; jedna linia JSON na zmianę: `at`, `kind` `ticket|overhead`, `taskId`, `note`, `source` `manual|spawn|followup` — append-only, odczyt: `node $LA_ROOT/scripts/supervisor-focus.mjs show`). Terminal dashboardu: WebSocket `/api/supervisor/terminal` — tylko same-origin (Host i Origin muszą być `localhost`/`127.0.0.1`/`[::1]`, ostrzejsze niż ogólne `isAllowedOrigin`).
- **Dane:** wolumen `fenix_fenix-data` zamontowany w `/data` — telemetry DB `/data/telemetry/telemetry.sqlite`, stan Supervisora `/data/state/supervisor`, run manifests i per-run logi decyzyjne `/data/state/runs` (FOC-811), workspaces `/data/workspaces`.
- **Mapa projektów:** `.fenix/config/projects.json` na hoście (katalog montowany jako `/fenix-config`; `fenix up` go tworzy; env `LA_PROJECTS_FILE=/fenix-config/projects.json`). Wygrywa z `config/projects.json` repozytorium; zapisuje ją `fenix repo add --project <projekt Linear>`; kształt: `{"projects":[{"linearProject","workspace":"joi","repo":"${GITHUB_ROOT}/<name>","deploy":{"type":"none"}}]}`.
- **Settings (FOC-773/786):** `fenix-api` montuje dodatkowo `./.fenix/config` → `/fenix-config` (overlay `settings.json`, RW) i `./.fenix/secrets` → `/fenix-secrets` (RW — rotacja kluczy z dashboardu); `fenix-supervisor` sekrety ma wyłącznie read-only (`/run/secrets/`). Wyniki ostatnich walidacji kluczy: `/data/settings/key-checks.json` (statusy, bez wartości). API: `/api/settings/*` (te same guardy co zapisy Cockpita, body ≤ 8 KB, żadna odpowiedź nie zawiera wartości klucza). Kontrakty: `docs/plans/fenix-settings-keys.md`.
- **`/data/agents`** (wolumen): konfiguracja squadów (CLAUDE.md, settings.json, definicje ról, skills, memory) + transkrypty Claude Code + zgody (approvals). Przy każdym starcie API seeduje konfigurację z obrazu regułą dpkg: plik nieedytowany → podąża za obrazem, edytowany → zostaje, a nowa wersja z obrazu ląduje obok jako `<plik>.fenix-new`. Transkrypty przeżywają `fenix down` i `fenix update`.
- **`/data/workspaces`** (wolumen): repozytoria klonowane przez `fenix repo add`; worktree dzieci: `/data/workspaces/la-wt/<repo>/<branch>`.
- **Zmienne środowiskowe w obrazie:** `LA_DATA_HOME=/data`, `LA_SQUAD_HOME=/data/agents`, `GITHUB_ROOT=/data/workspaces`, `LA_WORKTREE_HOME=/data/workspaces/la-wt`, `LA_TELEMETRY_HOME=/data/telemetry`, `LA_STATE_ROOT=/data/state`, `LA_SUPERVISOR_STATE_HOME=/data/state/supervisor`; compose ustawia `LA_PROJECTS_FILE=/fenix-config/projects.json`.
- **Integracje opcjonalne (FOC-772):** domyślnie wszystkie off; overlay Mateusza ustawia `integrations: { atlas: true, pisi: true, memory: true }` po zmergowaniu FOC-772 — `node scripts/fenix-settings.mjs set integrations '{"atlas":true,"pisi":true,"memory":true}'` (albo `./fenix integrations enable <name>`); Nebul nie jest flagą — wybiera się go przez providera (`fenix keys`).

#### Legacy session migration (FOC-839)

The operator step after `fenix update` on a volume that already carried a
legacy single-session Supervisor. Run it by hand first —
`node scripts/supervisor-migrate-legacy.mjs` is a **dry run by default**
(prints what would happen), `--apply` writes:

- a legacy run whose triage/focus names a task that has exactly one
  non-terminal managed session is **attached once** to that session;
- every other legacy run is marked **read-only** (writes refused);
- a run is **never adopted** into a task it does not name.

The session host runs the same migration idempotently at serve start.
Acceptance: `sh scripts/supervisor-migrate-legacy-acceptance.sh <copy-of-volume> [<workspace>]`
— always on a COPY of the VM volume, never the volume itself (the script refuses
`/data`); the optional second argument sets `FENIX_WORK_WORKSPACE` so the task
keys resolve like the container's (default `jointhubs`). Two safety rules worth
knowing: the run named by the global current-run pointer is skipped
(`current-pointer`) unless its pid is known AND dead — a pre-FOC-905 pointer
carries no pid, so stop the legacy Supervisor and re-record its pointer before
expecting that run to be attached; and a run whose `triage.json.issue` is a
Linear uuid (pre-#71 payload fallback) matches no store row and is marked
`no-session-for-task` — re-triage the ticket instead of hand-editing markers.

### Fenix na VM w GCP (`fenix-vm`, od 2026-10-12)

- **Maszyna:** projekt GCP `dochubs`, VM `fenix-vm`, strefa `europe-central2-a` (Warszawa), `e2-standard-2` (2 vCPU / 8 GB) od 2026-10-19 (wcześniej `e2-standard-4`; typ maszyny zmienia się tylko przy zatrzymanej VM: `gcloud compute instances set-machine-type`), Debian 12, dysk 100 GB `pd-balanced`. Zewnętrzny IP efemeryczny (zmienia się po stop/start) — z zewnątrz otwarty tylko SSH (reguła `default-allow-ssh`).
- **SSH:** `gcloud compute ssh fenix-vm --zone=europe-central2-a` — użytkownik `mateu` (uid **1000** — wymagane, dopóki nie ma FOC-803), klucz `~/.ssh/google_compute_engine` w metadanych projektu `dochubs` (OS Login wyłączony). Z Git Bash i ze skryptów: zwykłe OpenSSH — `ssh -i ~/.ssh/google_compute_engine mateu@<IP>` (IP: `gcloud compute instances describe fenix-vm --zone=europe-central2-a --format='value(networkInterfaces[0].accessConfigs[0].natIP)'`); `gcloud compute ssh` na Windows otwiera okno PuTTY.
- **Fenix:** `~/fenix` (klon publicznego `joint-hubs/linear-agents`), Docker CE + Compose z repozytorium apt Dockera. Klucze: `~/fenix/.fenix/secrets/` na VM (wpisane przez `./fenix up` / `./fenix keys`). Aktualizacja: `./fenix update`. Overlay `~/fenix/.fenix/config/settings.json`: `routing.supervisor.lead = z-ai/glm-5.3-flash` (od 2026-10-19 — bez tego Supervisor na VM dostaje domyślny model providera, `xiaomi/mimo-v2.6-pro`; squady i tak idą na GLM flash z `config/models.json`). Repo dla ticketów FOC: klon w wolumenie danych `/data/workspaces/linear-agents` (w kontenerze, `GITHUB_ROOT=/data/workspaces`), założony 2026-10-19.
- **Dashboard:** port 4600 tylko na `127.0.0.1` maszyny — **nie wystawiać**. Dostęp tunelem z laptopa (PowerShell; okno PuTTY = tunel, zostawić otwarte): `gcloud compute ssh fenix-vm --zone=europe-central2-a --ssh-flag="-N" --ssh-flag="-L 4600:localhost:4600"` → `http://localhost:4600`. W PowerShellu `--` przed flagami SSH nie działa (gcloud to skrypt `.ps1`) — tylko `--ssh-flag`.
- **Koszt:** maszyna działa 24/7, dopóki jej nie zatrzymasz: `gcloud compute instances stop fenix-vm --zone=europe-central2-a` (dane na dysku zostają; po `start` stack wstaje sam — `restart: unless-stopped`).

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


### Settings acceptance stack (2026-10-14, local only)

- Worktree: `C:\Users\mateu\Documents\GitHub\la-wt-mateusz\fenix-settings-keys`; branch `fenix-settings-keys`.
- Dashboard: http://127.0.0.1:4601/settings/keys (no login on the loopback-only test stack).
- Compose project: `fenix-settings-acceptance`; generated, ignored config: `.fenix/acceptance/compose.json`.
- Image: `fenix:settings-acceptance`. Volume: `fenix-settings-acceptance_fenix-data`.
- Settings/map: `.fenix/acceptance/config/`; synthetic secrets only: `.fenix/acceptance/secrets/`.
- Mock validation server: http://127.0.0.1:60659; containers reach it through `http://host.docker.internal:60659`.
- Model execution is replaced with a local fixture. This stack is a UI/API acceptance environment, not a production Supervisor.
- Start from this worktree: `docker compose -p fenix-settings-acceptance -f .fenix/acceptance/compose.json up -d --wait`.
- Stop without deleting data: `docker compose -p fenix-settings-acceptance -f .fenix/acceptance/compose.json stop`.
- The existing production VM and its secrets were not modified.

### Task workspace acceptance stack (2026-10-14, local only)

- Dashboard: http://127.0.0.1:4602 (loopback only, no login; board is home at `/`).
- Compose project: `fenix-task-workspace`; generated, ignored config: `.fenix/task-workspace/compose.json`.
- Purpose: P1–P4 browser acceptance — two concurrent task cockpits, restart, stopping one without touching the other; Manager tools, `/insights/runtime`, `/insights/map`.
- Session host: the `:7332` host (see above) now multiplexes managed task sessions — legacy global routes answer only while no task session exists; isolated per-task controllers live under `/sessions/:id`. Ambiguity answers with an explicit error, never a silent guess.
- Start from this worktree: `docker compose -p fenix-task-workspace -f .fenix/task-workspace/compose.json up -d --wait`.
- Stop without deleting data: `docker compose -p fenix-task-workspace -f .fenix/task-workspace/compose.json stop`.
- The existing production VM and its secrets were not modified.
