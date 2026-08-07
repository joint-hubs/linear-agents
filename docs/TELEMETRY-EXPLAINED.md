---
type: explainer
status: active
audience: Mateusz (scena + Q&A), kontrybutorzy
tags: [type/explainer, area/telemetry, topic/cost, topic/cache, topic/prompts]
created: 2026-07-29
source: scripts/telemetry-{store,ingest,hook}.mjs, scripts/ledger.mjs, scripts/cost-report.mjs, bin/*.bat, scripts/prompt-library.mjs
---

# Skąd biorą się liczby — telemetria, tokeny, cache, prompty

Odpowiedź na sześć pytań: skąd tokeny, co właściwie mierzymy, czym jest cache i jak go
liczymy, jak to się sumuje, co robią pliki `.bat` i jakie pliki agent naprawdę czyta.

---

## 1. Skąd biorą się tokeny — nie z odpowiedzi OpenRoutera

To jest najczęstsze nieporozumienie. **Nie parsujemy odpowiedzi HTTP z OpenRoutera.**
Źródłem jest **transkrypt sesji Claude Code**, czyli plik `.jsonl`, który Claude Code
zapisuje sam z siebie.

```
Claude Code (proces `claude`)
   │  każda tura asystenta = jedna linia JSON w transkrypcie
   ▼
~/.claude/… albo agents/<squad>/projects/<hash>/<sessionId>.jsonl
   │  (+ podkatalog <sessionId>/subagents/agent-*.jsonl dla subagentów)
   ▼
scripts/telemetry-ingest.mjs   →  zdarzenia `usage.recorded`
   ▼
scripts/telemetry-store.mjs    →  tabela usage_facts (SQLite, user-level)
   ▼
scripts/telemetry-server.mjs   →  /api/runs, /api/flow, /api/cost-per-task
   ▼
dashboard
```

Konkretnie `telemetry-ingest.mjs` bierze tylko linie, które są turą asystenta i mają usage:

```js
if (line.type !== "assistant" || !line.message?.usage) continue;
const usage = line.message.usage;
// inputTokens:          usage.input_tokens
// outputTokens:         usage.output_tokens
// cacheReadTokens:      usage.cache_read_input_tokens
// cacheCreationTokens:  usage.cache_creation_input_tokens
```

**Dlaczego pola mają nazwy Anthropic, skoro płacimy OpenRouterowi?** Bo `_lib.bat`
ustawia `ANTHROPIC_BASE_URL=https://openrouter.ai/api` — OpenRouter serwuje wszystkie
modele (`z-ai/*`, `minimax/*`, `deepseek/*`, `moonshotai/*`, `openai/*`, `x-ai/*`) przez
endpoint zgodny z API Anthropic. Claude Code wysyła żądania jak do Anthropic i dostaje
`usage` w kształcie Anthropic, niezależnie od tego, czyj model faktycznie liczył.

### Dwa niezależne źródła prawdy

| | Transkrypty (telemetry-*) | OpenRouter `/api/v1/activity` (cost-report.mjs) |
|---|---|---|
| Co daje | tokeny per **tura**, z przypisaniem do runu, składu, roli i zadania | zafakturowany koszt per model, per dzień |
| Zalety | pełna atrybucja — wiadomo KTO i NA CO wydał | prawda księgowa, to jest realny rachunek |
| Wady | wycena własna, może się rozjechać z cennikiem | zero atrybucji, nie wie o zadaniach |
| Rola | operacyjna: dashboard, koszt per task | kontrolna: rekoncyliacja |

`cost-report.mjs` porównuje jedno z drugim i **flaguje rozbieżność powyżej 10%**.
To jest odpowiedź na pytanie „skąd wiesz, że Twoje liczby nie kłamią" — z drugiego,
niezależnego źródła.

### Dlaczego nic się nie dubluje

`usage_facts` ma `UNIQUE(source_path, source_offset)` — kluczem jest **pozycja bajtowa
linii w konkretnym pliku**. Ponowny ingest tego samego transkryptu wstawia te same klucze
i wpada w `INSERT OR IGNORE`. Tabela `transcript_sources` trzyma `file_size` +
`parse_status`, więc pliki niezmienione od ostatniego przebiegu są pomijane, a rosnące
doczytywane przyrostowo.

### Jak tura wie, do którego runu należy

Hook `SessionStart` (wpięty w `settings.json` wszystkich pięciu składów) uruchamia
`telemetry-hook.mjs`, który zapisuje **dokładne** powiązanie `LA_RUN_ID → CLAUDE_CODE_SESSION_ID`.
Wcześniej (v1, `ledger.mjs`) run dopasowywało się do transkryptu po oknie czasowym i po
`cwd` + `gitBranch` — stąd brały się runy oznaczone `ambiguous`. Teraz to jest identyfikator,
nie zgadywanka.

Rola (`agent_key`) bierze się z `line.attributionAgent`; dla plików subagentów fallback to
`agent-<agentId>`; brak atrybucji = `_lead`. To jest dokładnie ta wartość, po której
dashboard liczy „ile kosztu poszło na subagentów".

---

## 2. Co właściwie mierzymy

**Jednostką obserwacji jest jedna tura asystenta.** Wszystko inne — run, zadanie, skład,
rola, model, dzień — to wymiary agregacji, nie osobne pomiary.

Na turę zapisujemy cztery liczniki:

| Licznik | Co to jest |
|---|---|
| `input_tokens` | świeży prompt, **bez** części obsłużonej przez cache |
| `output_tokens` | to, co model wygenerował |
| `cache_creation_tokens` | tokeny **zapisane** do cache w tej turze |
| `cache_read_tokens` | tokeny **odczytane** z cache zamiast przeliczone od nowa |

Ważne przy interpretacji: w schemacie Anthropic `input_tokens` **nie zawiera** tokenów
cache'owanych. Pełny rozmiar promptu to `input + cache_read + cache_creation`. Dlatego
„input" w dashboardzie potrafi wyglądać na absurdalnie mały przy gigantycznym `cache_read`.

Czego **nie** mierzymy: czasu ściennego per tura, jakości odpowiedzi, liczby linii kodu.
Czas trwania runu liczymy z manifestu (`startedAt`/`endedAt`), nie z tur.

---

## 3. Cache — mechanizm i wycena

### Mechanizm (po stronie modelu)

Prompt cache działa na **stabilnym prefiksie** rozmowy: system prompt, `CLAUDE.md`,
definicje narzędzi, wcześniejsze tury. Przy każdej kolejnej turze cały ten prefiks jest
wysyłany ponownie — ale zamiast liczyć go od zera, dostawca serwuje go z cache po
ułamku ceny. Pierwsze wysłanie prefiksu to `cache_creation` (zapis), każde następne to
`cache_read` (odczyt).

To wyjaśnia obserwację z analizy kosztów: **stosunek cache-read do świeżego inputu 11:1**.
Długa sesja leada to nie jest jedna wielka rozmowa — to N osobnych żądań, z których każde
niesie cały dotychczasowy kontekst. Stąd zdanie „długa sesja to podatek".

### Wycena (po stronie repo)

Ceny żyją w `config/models.json → pricing.<model_slug>` jako **USD za 1 mln tokenów**:

```json
"z-ai/glm-5.2": { "input": 1.40, "output": 4.40 },
"anthropic/claude-opus-5": { "input": …, "output": …, "cacheRead": … }
```

Wzór (`telemetry-store.mjs → calculateCost`, identycznie w `ledger.mjs → costTokens`):

```
cost = ( input          × input_price
       + output         × output_price
       + cache_read     × cache_read_price
       + cache_creation × input_price      ) / 1 000 000
```

Dwie reguły, które trzeba znać, bo nie są oczywiste:

1. **Brak `cacheRead` w cenniku → domyślnie 10% ceny inputu** (`price.input * 0.1`).
   To konwencja Anthropic. Dla modeli, które mają inną politykę, trzeba wpisać `cacheRead` jawnie.
2. **Zapis do cache wyceniamy po cenie inputu.** U Anthropic zapis kosztuje trochę drożej
   niż zwykły input (ok. 1,25×), więc **nasza wycena lekko zaniża koszt** przy pierwszej
   turze długiego kontekstu. Rozbieżność z fakturą OpenRoutera częściowo stąd.

### Oszczędność z cache

```
cacheSavings = cache_read_tokens / 1e6 × (input_price − cache_read_price)
```

Czyli: ile zapłaciłbyś, gdyby cache nie istniał, minus ile zapłaciłeś. To liczba
marketingowa, nie księgowa — nie pomniejsza rachunku, tylko pokazuje, ile by było bez niej.

> Uwaga historyczna: do commita `c3beec5` ta wartość była zahardkodowana na 0 —
> dashboard pokazywał „$0.00 oszczędności" obok 1,1 mld tokenów odczytanych z cache
> i 89,9% hit rate. Klasyczny przykład, dlaczego liczby trzeba walidować drugim źródłem.

### Czego cache nie obejmuje

Nie każdy dostawca przez OpenRouter raportuje pola cache. Jeśli model ich nie zwraca,
tury mają zera w obu kolumnach — koszt jest wtedy policzony poprawnie (input pełną ceną),
ale „oszczędność" wyjdzie 0 i hit rate będzie zaniżony. Nie interpretuj tego jako braku cache
w systemie, tylko jako brak raportowania.

---

## 4. Jak to się sumuje

### Snapshot cen zamiast ceny „na teraz"

To jest najlepiej przemyślany element całej telemetrii. Ceny nie są mnożone w locie:

- `price_sets` — snapshot cennika, identyfikowany **hashem zawartości** `config/models.json`
- `model_prices` — wiersze cen w danym snapshotcie
- `cost_facts (usage_id, price_set_id) → cost_usd` — koszt tej samej tury **w kilku
  cennikach naraz**

Konsekwencje praktyczne: zmiana cennika nie przepisuje historii; można porównać
„ile ten run kosztował wtedy" z „ile kosztowałby dziś"; a wiersz `usage_fact` bez
odpowiadającego `cost_fact` to jawna dziura w danych, nie ciche zero.

### Poziomy agregacji

```
tura (usage_fact)
  → agent_key (rola)      → „By agent" w RunDetail, udział delegacji
  → model                 → mix modeli, byModel
  → run                   → totals na liście runów
  → task (run_task_links) → /api/cost-per-task, budżet per zadanie
  → squad, dzień          → Costs, Timeline
```

Udział delegacji, czyli metryka, na której opiera się cała optymalizacja kosztu:

```
delegacja % = koszt tur z agent_key ≠ "_lead"  /  koszt wszystkich tur w runie
```

### Jakość danych zamiast cichych zer

`data_quality_issues` łapie przypadki, które kiedyś ginęły: model spoza cennika
(`unpricedUsageCount`), brakujący transkrypt, run bez sesji. Dashboard pokazuje je jako
ostrzeżenia. Zasada: **lepiej pokazać „nie wiem" niż `$0.00`.**

---

## 5. Co robią pliki `.bat`

Podział ról jest czysty: `_lib.bat` to całe środowisko, `<squad>.bat` to tylko modele i konfiguracja składu.

### `bin/_lib.bat` — wspólny prolog

1. Ustala `ROOT` i `LA_ROOT` (ścieżka absolutna repo — używana we wszystkich promptach jako `$LA_ROOT/scripts/…`).
2. Ładuje `.env`, ale **zmienne ustawione w oknie wygrywają** z `.env` dla `LINEAR_TEAM_KEY`
   i `LINEAR_WORKSPACE` (stąd działa `set LINEAR_TEAM_KEY=JOI&& bin\plan.bat` i launch z dashboardu).
3. Sprawdza marker provisioningu zespołu (`.state/teams/<KEY>.provisioned`), w razie potrzeby
   proponuje `bootstrap-linear.mjs`.
4. **Wybiera dostawcę:**
   - domyślnie OpenRouter: `ANTHROPIC_BASE_URL=https://openrouter.ai/api` (bez `/v1` — SDK sam
     dokleja `/v1/messages`), `ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%`, `ANTHROPIC_API_KEY` czyszczone;
   - `NATIVE=1`: czyści **wszystkie** `ANTHROPIC_*`, żeby zadziałała subskrypcja Anthropic.
5. `CLAUDE_CODE_SUBAGENT_MODEL=` — **czyszczone celowo** (ADR-0002). Odziedziczona wartość
   spłaszcza wszystkich subagentów na jeden model i cały routing przestaje istnieć.
6. `API_TIMEOUT_MS=3000000` (50 minut) — długie fazy delegowane nie mogą się wywalić na timeoucie.
7. Generuje `RUN_ID` i woła `run-manifest.mjs start` — **tu zaczyna się telemetria**.
8. Eksportuje wszystko poza `endlocal` (ta jedna długa linia na końcu).

### `bin/<squad>.bat` — konfiguracja składu

```bat
set "SQUAD_SLUG=plan"
call "%~dp0_lib.bat" || exit /b 1
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\plan"     ← izolacja: własny CLAUDE.md, settings, subagenci
set "ANTHROPIC_MODEL=anthropic/claude-opus-5"  ← model leada
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
claude %*
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
```

Kluczowe: **`CLAUDE_CONFIG_DIR` to mechanizm izolacji składów.** Każdy skład ma własny
katalog konfiguracyjny, więc własny prompt, własne uprawnienia, własnych subagentów
i własny katalog transkryptów.

Model leada jest **w `.bat`, nie w `config/models.json`** — i `scripts/squad-config.mjs`
czyta go regexem prosto z `.bat` (i tam też zapisuje przy zmianie z dashboardu).
`config/models.json → ids` obsługuje tylko aliasy dla subagentów i `bin/agent.bat`.
*(Drobny rozjazd do posprzątania: `ids.opus` wskazuje jeszcze `claude-opus-4.8`, podczas gdy
`plan.bat` uruchamia `claude-opus-5`.)*

Warianty: `<squad>-dry.bat` (tryb bez zapisu do Lineara), `plan-native.bat` (subskrypcja
Anthropic), `agent.bat <area> <role>` (jeden subagent do debugowania), `all.bat` (pięć okien),
`dashboard.bat` + `dashboard-hidden.vbs` (serwer telemetrii).

---

## 6. Co agent naprawdę czyta

Trzy warstwy, w kolejności wczytywania:

**Warstwa 1 — automatyczna (Claude Code, z `CLAUDE_CONFIG_DIR`)**

| Plik | Rola | Rozmiar |
|---|---|---|
| `agents/<squad>/CLAUDE.md` | prompt systemowy leada — pętla, polityka delegacji, zasady P0 | 3,3–9,1 kB |
| `agents/<squad>/settings.json` | uprawnienia (`allow`/`deny`), hook `SessionStart` | — |
| `agents/<squad>/agents/*.md` | definicje subagentów: frontmatter `model` + `tools`, potem brief | 4–7 plików/skład |

**Warstwa 2 — kickoff (wklejany przy starcie)**

`config/prompts.json → kickoff.<squad>` (edytowalny z dashboardu, fallback w `scripts/launch.mjs`).
Zasada zapisana wprost w pliku: *kickoff to wyzwalacz, nie druga definicja pętli.*

**Warstwa 3 — dociągana przez agenta w trakcie (linki z `CLAUDE.md`)**

| Ścieżka | Kto to czyta |
|---|---|
| `docs/prd/prd-{planning,development,review,testing,cadence}.md` | wszystkie leady — kontrakt obszaru |
| `docs/agents/agent-{0..4}-*.md` | wszystkie leady — specyfikacja składu |
| `docs/FENIX_WORKFLOW.md` | mapa międzyskładowa (statusy, labelki, DoR/DoD) |
| `config/models.json`, `config/projects.json` | routing modeli, mapowanie repo↔projekt |
| `config/linear/` | definicje labelek i szablonów |
| `scripts/{linear-query,linear-ops,dev-branch,review-round,publish-linear-comment,run-manifest}.mjs` | wywoływane jako komendy |

Wszystkie linki zweryfikowane — po naprawie w `8eec208` nie ma martwych ścieżek
(poza wzorcami typu `docs/adr/NNNN-*.md`, które są szablonami nazw, nie plikami).

---

## 7. Luka: dashboard nie pokazuje warstwy 3

Obecnie backend ma `readLeadDoc()` (zwraca `CLAUDE.md`) i `readRoleDoc()` (zwraca
`agents/<squad>/agents/<role>.md` z modelem i narzędziami) — i tyle. Endpointy:
`/api/prompts`, `/api/prompts/lead`, `/api/prompts/role`, `/api/prompts/kickoff`.

**Czego nie widać:** dokumentów, które agent otworzy w trakcie pracy — PRD, specyfikacji
składu, `FENIX_WORKFLOW.md`, plików konfiguracyjnych. Z perspektywy operatora to jest
połowa kontekstu: prompt systemowy widzisz, ale nie widzisz tego, do czego on odsyła.
A to właśnie tam siedzą reguły, które najczęściej się rozjeżdżają (statusy wejściowe,
formaty handoffu, definicje DoR/DoD).

### Propozycja: `GET /api/prompts/refs?squad=<s>[&path=<p>]`

Bez parametru `path` — lista linków wyciągniętych z `CLAUDE.md` i plików subagentów danego składu:

```json
{ "squad": "dev",
  "refs": [
    { "path": "docs/prd/prd-development.md", "exists": true,  "bytes": 3039, "citedIn": ["CLAUDE.md"] },
    { "path": "docs/agents/agent-2-dev.md",  "exists": true,  "bytes": 3088, "citedIn": ["CLAUDE.md"] },
    { "path": "config/models.json",          "exists": true,  "bytes": 2317, "citedIn": ["agents/recon.md"] }
  ],
  "missing": [] }
```

Z parametrem `path` — treść pliku, **z twardą walidacją** (dokładnie jak `validateSquad`
i `validateRole` w `prompt-library.mjs`): tylko allowlista prefiksów
(`docs/`, `config/`, `agents/<squad>/`), zakaz `..`, ścieżka rozwiązana i sprawdzona, że
nadal leży pod rootem repo. Serwer jest lokalny, ale to jest odczyt dowolnego pliku —
allowlista jest obowiązkowa, nie opcjonalna.

W UI: w ekranie Prompts, pod treścią `CLAUDE.md`, sekcja „Pliki, które agent otworzy" —
lista z rozmiarem, statusem istnienia i rozwijaną treścią. Efekt uboczny, który jest wart
tyle samo co sama funkcja: **brakujący plik staje się widoczny od razu**, zamiast
kosztować agentowi turę na odkrycie, że ścieżka nie istnieje (dokładnie to zdarzyło się
czterem składom przed `8eec208`).

Implementacja to jeden eksport w `prompt-library.mjs` (`buildRefIndex(squad, root)` —
ten sam regex, którym zrobiłem tabelę wyżej), jeden endpoint i jedna sekcja w `Prompts.jsx`.

---

## Ściąga na Q&A

**„Skąd wiesz, ile to kosztowało?"** — Claude Code zapisuje każdą turę do transkryptu
razem z licznikami tokenów. Ingestujemy to do SQLite, wyceniamy własnym cennikiem
i porównujemy z fakturą OpenRoutera; rozbieżność powyżej 10% jest flagowana.

**„Czy to nie jest podwójne liczenie?"** — nie, klucz to pozycja bajtowa linii w pliku;
ponowny ingest wpada w `INSERT OR IGNORE`.

**„Co z cache?"** — odczyt z cache liczymy po 10% ceny inputu (albo po jawnej stawce
z cennika), zapis po cenie inputu. Oszczędność raportujemy osobno, jako różnicę wobec
świata bez cache. Przy 11:1 cache-read do świeżego inputu to jest główny powód, dla którego
długie sesje leada były tak drogie.

**„Skąd wiesz, że to ten run?"** — hook `SessionStart` zapisuje dokładne powiązanie
`RUN_ID → SESSION_ID`. Wcześniej dopasowywaliśmy po oknie czasowym i tak, to się myliło.
