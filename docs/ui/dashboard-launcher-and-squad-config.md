# PRD — Desktop launcher + zakładka „Konfiguracja składów"

> Status: **draft do akceptacji** · Autor: Mateusz (dyktat) + Claude · Data: 2026-07-26
> Repo: `linear-agents` · Platforma: dashboard Agent Observability (`ui/` + `scripts/telemetry-server.mjs`)
>
> Dwa niezależne usprawnienia platformy, spięte jednym PRD bo oba dotykają
> tego samego stacku (serwer `:7331` + UI React/Vite).

---

## Feature 1 — ikonka na pulpicie „otwórz dashboard"

### Problem / Cel
Dziś, żeby zobaczyć dashboard, trzeba ręcznie odpalić dwa procesy (API `:7331`
+ UI Vite `:5173`) z terminala. To się gubi i zniechęca. Cel: **jeden dwuklik
na pulpicie → dashboard w przeglądarce**, niezależnie od tego, czy serwer już
działa.

### User journey
1. Mateusz klika dwukrotnie ikonę **„Fenix Dashboard"** na pulpicie.
2. Jeśli serwer nie działa → startuje w tle (bez migającego okna konsoli),
   launcher czeka aż `:7331` odpowie.
3. Otwiera się domyślna przeglądarka na `http://localhost:7331` z dashboardem.
4. Jeśli serwer już działał → od razu otwiera przeglądarkę (bez drugiego procesu).

### Zakres
**In:**
- Serwer `:7331` (`telemetry-server.mjs`) **serwuje zbudowane UI** (`ui/dist`)
  jako statyczne pliki + SPA-fallback na `index.html`. Koniec z osobnym portem
  `:5173` w codziennym użyciu (Vite zostaje tylko do developmentu UI).
- `bin/dashboard.bat` — launcher: health-check `:7331` → start serwera jeśli
  trzeba → poczekaj na gotowość → otwórz przeglądarkę.
- `bin/dashboard-stop.bat` — zatrzymanie serwera (bo działa w tle).
- `scripts/install-desktop-shortcut.ps1` — jednorazowo tworzy skrót `.lnk` na
  pulpicie: cel = `dashboard.bat` uruchamiany ukryciem konsoli, własna ikona.
- Ikona `.ico` (prosty, rozpoznawalny znaczek — patrz Otwarte).

**Out:**
- Autostart z Windowsem (można dodać później — skrót w `shell:startup`).
- Tray icon / mini-aplikacja natywna (over-engineering na teraz).
- Docker — **świadomie odrzucone**: narzędzie żyje z plików i procesów hosta
  (czyta `.state/`, transkrypty, **zapisuje** `bin/*.bat` i `.md`, **odpala**
  windowsowe `.bat` przez launch). Kontener Linux nie odpali `.bat`,
  bind-mounty psują `birthtime` (na którym stoi dopasowanie kosztów w ledgerze).
  Natywny node jest lżejszy i nie łamie integracji z hostem.

### Architektura / zmiany techniczne
- **`scripts/telemetry-server.mjs`**: dodać handler statyczny — dla ścieżek
  spoza `/api/*` serwuj plik z `ui/dist/`, a gdy nie istnieje → zwróć
  `index.html` (SPA routing). MIME po rozszerzeniu. Zero nowych zależności.
- **`bin/dashboard.bat`** (host-side):
  - health-check: PowerShell `Test-NetConnection -Port 7331` (lub node one-liner
    na `http://localhost:7331/api/summary`).
  - jeśli down: `if not exist ui\dist\index.html` → `npm --prefix ui run build`
    (jednorazowo); potem start serwera **odpiętego** (`start "" /b node scripts\telemetry-server.mjs`)
    lub przez VBS `Run(...,0)` dla pełnego ukrycia okna.
  - poll `:7331` aż odpowie (timeout ~15 s), potem `start "" http://localhost:7331`.
- **Ukrycie konsoli**: skrót `.lnk` uruchamia `wscript` na malutkim
  `bin/dashboard-hidden.vbs`, który woła `dashboard.bat` z oknem `0` (hidden).
  `dashboard-stop.bat` zostaje widoczny do ręcznego stopu.
- **Skrót**: `install-desktop-shortcut.ps1` przez `WScript.Shell.CreateShortcut`
  ustawia `TargetPath`, `IconLocation`, `WorkingDirectory`.

### Kryteria akceptacji (F1)
- [ ] Po `git clone` + `npm --prefix ui install` wystarczy odpalić
      `install-desktop-shortcut.ps1` raz → ikona jest na pulpicie.
- [ ] Dwuklik przy wyłączonym serwerze: dashboard otwiera się w ≤20 s, bez
      widocznego okna konsoli.
- [ ] Dwuklik przy działającym serwerze: otwiera przeglądarkę natychmiast, nie
      startuje drugiego procesu (brak konfliktu portu).
- [ ] `dashboard-stop.bat` ubija serwer; kolejny dwuklik znów go wstaje.
- [ ] Skrót jest tylko wskaźnikiem — realne skrypty są w repo (`bin/`), więc
      są wersjonowane i „nie gubią się".

---

## Feature 2 — zakładka „Konfiguracja składów" (edycja modeli + cennik)

### Problem / Cel
Modele per skład są dziś **zaszyte w plikach** i rozrzucone po trzech miejscach
(patrz niżej). Zmiana modelu = ręczna edycja `.bat`/`.md`, łatwo o pomyłkę i
rozjazd. Cel: **edytować modele składów z dashboardu** (provider zawsze
OpenRouter, zmienia się sam slug), plus **panel cennika**, żeby telemetria
znała stawki wklejonych modeli.

### ⚠️ Realny stan konfiguracji modeli (fundament tego feature'a)
| Co | Gdzie NAPRAWDĘ zaszyte | `models.json` to zmienia? |
|---|---|---|
| Model **leada** składu | `bin/<squad>.bat` → `set "ANTHROPIC_MODEL=…"` (+ `bin/<squad>-dry.bat`) | **NIE** |
| Model **subagenta** | nagłówek `model:` w `agents/<squad>/agents/<role>.md` | **NIE** |
| Model `bin/agent.bat` (pojedynczy run) | `config/models.map` (generowany z `models.json`) | tak |
| **Cennik** (ledger → USD) | `config/models.json` → `pricing` | tak |

Wniosek: **pliki, które realnie się uruchamiają, to `.bat` (lead) i `.md`
(subagenci)** — one są kanonicznym źródłem. `models.json` rządzi tylko cennikiem
i ścieżką `agent.bat`. Dlatego dashboard edytuje **bezpośrednio te pliki**, a
cennik osobno w `models.json`.

> **Zgodność z zasadą „konfiguracja przez pliki, nie panel admina":** honorujemy
> ją — kanonicznym źródłem **zostają pliki w repo (git-tracked)**. UI jest tylko
> **edytorem nad plikami**, nie ukrytą bazą. Świadomy wyjątek dla narzędzia
> jednego operatora (Mateusz = DevOps tego systemu).

### User journey
1. Zakładka **„Konfiguracja składów"** na dashboardzie.
2. Widok: 5 kart składów (plan/dev/review/test/cadence). Każda karta:
   - **Lead** (wyróżniony) — pole z aktualnym slugiem, edytowalne.
   - **Subagenci** — lista ról (recon, implementer…) z ich slugami, każdy edytowalny.
3. Mateusz wkleja nowy slug (np. `z-ai/glm-6`). Jeśli slug nie pasuje do wzorca
   `provider/model` → **żółte ostrzeżenie** (nie blokuje).
4. Osobny panel **„Cennik modeli"**: tabela `slug → input / output / cacheRead`
   (USD za 1M). Można dodać wiersz lub zaktualizować istniejący. Jeśli w
   konfiguracji jest slug bez ceny → wiersz podświetlony „brak ceny → koszt $0".
5. Przycisk **„Zastosuj"** → podgląd zmian (diff plików) → potwierdzenie →
   zapis. Komunikat: *„Zapisano. Zmiany zadziałają przy następnym uruchomieniu
   składu."*

### Zakres
**In:**
- **Odczyt** aktualnej konfiguracji: parsowanie `bin/*.bat` (lead) + frontmatteru
  `agents/*/agents/*.md` (subagenci) + `models.json` (cennik).
- **Edycja** leada i wszystkich subagentów per skład (free-text slug).
- **Panel cennika**: dodaj/aktualizuj wiersz w `models.json.pricing`.
- **Zapis (Apply)**: przepisz linię `ANTHROPIC_MODEL` w `bin/<squad>.bat`
  **i** `bin/<squad>-dry.bat`; przepisz `model:` we frontmatterze roli; zapisz
  cennik do `models.json`. Zmiana działa **od następnego uruchomienia** składu.
- **Ostrzeżenie walidacyjne** dla slugów spoza wzorca `provider/model`.
- **Backend**: nowe endpointy w `telemetry-server.mjs`
  (`GET /api/squad-config`, `POST /api/squad-config`, `GET/POST /api/pricing`).
  Logika parsowania/zapisu w osobnym, testowalnym module `scripts/squad-config.mjs`.

**Out (faza 2+):**
- Walidacja online przez API OpenRoutera (że model istnieje). Na teraz free-text.
- Edycja `ANTHROPIC_SMALL_FAST_MODEL` — to model wewnętrzny Claude Code, nie
  „specjalista składu"; celowo poza gridem.
- Regeneracja `models.map` / sekcji `routing` w `models.json` (ścieżka
  `agent.bat`). Pasted-slug używa pełnych nazw, a routing chodzi po krótkich
  kluczach — synchronizację odkładamy; `agent.bat` to tryb debugowy, nie główny.
- Zmiana providera (zawsze OpenRouter).

### Architektura / zmiany techniczne
- **`scripts/squad-config.mjs`** (nowy, czysty, z testami `_test_squad-config.mjs`):
  - `readSquadConfig()` → `{ squads: { plan: { lead, agents: {role: slug} }, … }, pricing }`.
    - lead: regex na `set "ANTHROPIC_MODEL=<slug>"` w `bin/<squad>.bat`.
    - agents: parse frontmatter `model:` w każdym `agents/<squad>/agents/*.md`.
    - pricing: z `models.json`.
  - `writeSquadConfig(patch)` → in-place replace w tych samych plikach,
    atomowo (temp + rename, jak `run-manifest.mjs`). Zwraca listę zmienionych
    plików + diff do podglądu.
  - `validateSlug(slug)` → `{ ok, warning }` (wzorzec `^[a-z0-9-]+/[A-Za-z0-9._-]+$`).
- **`scripts/telemetry-server.mjs`**: 4 endpointy cienką warstwą nad
  `squad-config.mjs` (bez logiki w serwerze). Zapisy tylko z origin localhost
  (już jest `isLocalOrigin`).
- **UI** (`ui/src/`): nowa trasa/zakładka `Konfiguracja składów`; komponenty
  kart składów + panel cennika; krok podglądu diff przed zapisem; rozwijana
  pomoc „co to robi / kiedy zadziała" (zgodnie ze stałą: każdy nowy feature UI
  ma pomoc in-app).

### Kryteria akceptacji (F2)
- [ ] Zakładka pokazuje **realne** aktualne modele (odczytane z `.bat` + `.md`),
      zgodne z tym, co odpala się dziś.
- [ ] Zmiana leada plan → `bin/plan.bat` **i** `bin/plan-dry.bat` mają nowy slug
      po „Zastosuj".
- [ ] Zmiana subagenta (np. dev/implementer) → frontmatter `model:` w
      `agents/dev/agents/implementer.md` zmieniony, reszta pliku nietknięta.
- [ ] Wklejenie slugu bez ceny → panel cennika oznacza go „brak ceny"; po
      wpisaniu ceny telemetria liczy dla niego koszt (nie $0).
- [ ] Slug spoza wzorca → ostrzeżenie, ale zapis możliwy.
- [ ] Przed zapisem widać **diff** dotykanych plików; po zapisie komunikat o
      „następnym uruchomieniu".
- [ ] `node scripts/_test_squad-config.mjs` zielony (odczyt+zapis na fixturach,
      brak uszkodzenia frontmatteru/`.bat`).
- [ ] Pliki pozostają git-tracked — po zmianie `git diff` pokazuje edycje do
      commita.

---

## Fazy implementacji

**F1 — launcher (mniejsze, niezależne):**
1. `telemetry-server.mjs`: statyczne serwowanie `ui/dist` + SPA fallback.
2. `bin/dashboard.bat` + `dashboard-hidden.vbs` + `dashboard-stop.bat`.
3. `scripts/install-desktop-shortcut.ps1` + ikona `.ico`.
4. Test manualny: 3 scenariusze (serwer down / up / stop→restart).

**F2 — konfiguracja składów:**
5. `scripts/squad-config.mjs` (read/write/validate) + testy na fixturach.
6. Endpointy w `telemetry-server.mjs` (localhost-only).
7. UI: zakładka, karty składów, panel cennika, podgląd diff, pomoc in-app.
8. Weryfikacja e2e: zmiana modelu w UI → sprawdzenie plików → uruchomienie
   składu na nowym modelu (dry-run) → widoczne w telemetrii.

## Otwarte (drobne, nieblokujące)
- Ikona `.ico`: wygeneruję prosty znaczek (np. litera „F" / wykres) albo użyjesz
  własnego pliku — wskaż, jeśli masz preferencję.
- Ukrycie konsoli serwera całkowicie (VBS `Run 0`) vs zminimalizowane okno do
  łatwego stopu — proponuję ukryte + `dashboard-stop.bat`.
