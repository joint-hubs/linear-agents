# ADR-0001: Provider routing — Anthropic subskrypcja-first + OpenRouter fallback

## Status
**Accepted** (2026-06-23, Mateusz) — patrz „Decyzja" na końcu

## Context
Cel: minimalizacja kosztów. Mateusz chce:
- **Opus/Sonnet** uruchamiane przez **subskrypcję Anthropic (Claude Code login)** — primary;
- **fallback na OpenRouter** dopiero gdy skończą się kredyty subskrypcji;
- tanie modele (GLM/MiniMax/DeepSeek/Kimi) zawsze przez OpenRouter;
- łatwy **swap modelu per czynność** + **monitoring** (tokeny/agent/koszt/czas) z UI.

**Twarde ograniczenia Claude Code (zweryfikowane):**
1. **Jedna sesja = jeden provider.** `ANTHROPIC_BASE_URL` jest globalny dla sesji. Nie da się w jednej sesji puścić Opusa natywnie, a GLM przez OpenRouter.
2. **Subskrypcja Max działa TYLKO natywnie.** Subskrypcja jest konsumowana, gdy Claude Code łączy się **bezpośrednio z Anthropic (login OAuth, bez `ANTHROPIC_BASE_URL`)**. Ustawienie base_url na OpenRouter/router = utrata subskrypcji (płacisz per-token API).
3. **Wniosek:** sesja na subskrypcji może używać **wyłącznie modeli Anthropic**. Agent mieszający Anthropic + tanie modele (np. obecny PLAN: lead Opus + subagenci MiniMax/GLM) **nie może** korzystać z subskrypcji — musi iść przez OpenRouter (Opus też per-token).
4. **Router/proxy** (claude-code-router / LiteLLM) daje per-model routing + auto-fallback + logowanie per-agent, **ale używa klucza API Anthropic (pay-per-token), nie subskrypcji.**

## Options
- **A — Native-per-agent (subskrypcja):** agent czysto-Anthropic → natywnie (subskrypcja); fallback OpenRouter przez relaunch. Plus: tania subskrypcja. Minus: brak mixu tanich modeli w tej sesji; fallback nie w pełni automatyczny.
- **B — Router/proxy:** jeden endpoint, per-model provider + auto-fallback + monitoring per-agent/per-task. Plus: pełna elastyczność, najlepszy monitoring, automatyczny fallback. Minus: **traci subskrypcję** (klucz API), dodatkowy komponent.
- **C — All-OpenRouter (obecne):** Opus/Sonnet przez slug OpenRoutera. Plus: najprościej, 1 klucz. Minus: nie używa subskrypcji.

## Decision (rekomendacja, do potwierdzenia)
**Hybryda dwóch torów:**
- **Tor domyślny = OpenRouter** (obecne squady; tani; działa od zaraz). Opus przez OpenRouter tylko gdy świadomie potrzebny.
- **Tor „native" = subskrypcja** dla lane'ów **czysto-Anthropic** (deep planning / hard review / hard debug, gdy chcesz top jakość za subskrypcję). Mechanizm w `bin/_lib.bat`: flaga `NATIVE=1` → **pomija** `ANTHROPIC_BASE_URL`/AUTH (login subskrypcyjny); brak flagi → OpenRouter. Fallback: na błąd auth/limit → relaunch w trybie OpenRouter.
- **Router/proxy = Phase 3**, gdy zechcesz automatyczny per-model fallback + monitoring per-agent (świadomie rezygnując z subskrypcji na rzecz API key).

Konsekwencja dla routingu: jeśli jakaś rola ma realnie korzystać z subskrypcji, jej **cała sesja** musi być Anthropic-only. Obecnie jedyny Anthropic to **plan-lead (Opus)** — decyzja poniżej.

## Consequences
- (+) Subskrypcja wykorzystana tam, gdzie ma sens (heavy-Anthropic), reszta tanio przez OpenRouter.
- (−) Nie ma „subskrypcja dla Opusa + tani subagent" w jednej sesji — to fizyczne ograniczenie CC.
- (−) Monitoring per-agent: OpenRouter Activity API jest **per-model**, nie per-agent. Pełne per-agent/per-task wymaga lokalnego token-logu (router albo SQLite) — patrz `docs/ui/ux-improvements.md`.
- UI (Config › Model Routing): dodać kolumnę **Provider** (anthropic-sub / openrouter) + **Fallback** per rola; Keys screen: subskrypcja = primary dla Anthropic, OpenRouter = fallback.

## Decyzja (2026-06-23, Mateusz)
**Hybryda native + OpenRouter.** plan-lead = **Opus na subskrypcji (native) jeśli dostępny, inaczej fallback OpenRouter**. Router (opcja B) = Phase 3.

### Mechanizm
- `bin/_lib.bat`: `NATIVE=1` ⇒ **pomiń** `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (login subskrypcyjny Claude Code); brak flagi ⇒ OpenRouter (jak teraz).
- **PLAN ma 2 profile routingu** (sesja native = TYLKO modele Anthropic — nie można mixować MiniMax/GLM w tej samej sesji):

  | rola | profil **native** (subskrypcja) | profil **openrouter** (fallback) |
  |---|---|---|
  | lead | opus | opus (OR) |
  | discovery | sonnet | minimax |
  | spec | sonnet | glm |
  | spec-review | opus | minimax |
  | decompose | sonnet | minimax |
  | push | haiku | deepseek-flash |

- `bin/plan.bat`: próbuj **native** (subskrypcja); na błąd auth/limit (401/429 z Anthropic) ⇒ relaunch z OpenRouter + profil openrouter. MVP: jeśli auto-detekcja trudna — flaga `plan.bat` (native) vs `plan.bat --or`, lub przełącznik z UI.
- **DEV/REVIEW/TEST/CADENCE: bez zmian** — OpenRouter (zero Anthropic).

### Konsekwencja (ważne!)
Native-PLAN = **wszystkie kroki na Anthropic** (Opus/Sonnet/Haiku), bo sesja subskrypcyjna nie może użyć MiniMax/GLM. To droższe modele, ale **subskrypcja = koszt flat** (do limitu) ⇒ krańcowo tanio. Po wyczerpaniu limitu → OpenRouter z tanim routingiem (MiniMax/GLM/DeepSeek). Czyli: dopóki masz subskrypcję — PLAN jedzie na jakości Anthropic za flat; gdy limit się skończy — przełącza się na tani OpenRouter.

### Build tasks
1. `bin/_lib.bat`: tryb `NATIVE` (pomiń override) + detekcja fallbacku (401/429).
2. `config/models.native.map` (profil Anthropic dla PLAN) + wybór profilu w `bin/plan.bat`.
3. UI (Config): kolumna **Provider** + **Fallback** per rola (patrz `docs/ui/ux-improvements.md` §1).
