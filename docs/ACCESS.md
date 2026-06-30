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
- **Telemetry panel:** `node scripts/telemetry-server.mjs` → `localhost:7331` (env `TELEMETRY_PORT`). Uruchamiany ręcznie, nie przez launcher.
- **0_linear dashboard:** `cd Desktop/experiments/0_linear && npm run dev` → `localhost:3000`. Wymaga działającego telemetry-server.

---

## Label signaling

- Definicje labelek/grup: `config/linear/labels.json`
- Protokół: `docs/linear-signaling-protocol.md`
- Bootstrap: `node scripts/bootstrap-linear.mjs` (idempotentny)
- Push: `node scripts/linear-push.mjs` (GraphQL, zero deps)
