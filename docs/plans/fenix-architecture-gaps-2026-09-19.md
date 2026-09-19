# Fenix — od monolitycznych squadów do pipeline'u: luki w analizach z 2026-09-19 i rekomendacje

> **Data:** 2026-09-19
> **Autor:** Claude (sesja audytowa), na prośbę Mateusza
> **Rodzaj:** recenzja dwóch analiz + propozycja architektury docelowej (nie PRD, nie task)
> **Wejście:** `docs/plans/mcp-pipeline-vision-analysis-2026-09-19.md` (dalej **MCP-doc**),
> `docs/plans/jev-mechanics-fenix-analysis-2026-09-19.md` (dalej **Jev-doc**)
> **Postawa:** każde twierdzenie, na którym stoi decyzja, sprawdzone w kodzie, w danych albo na żywym API.

## TL;DR

1. **Oba dokumenty dobrze diagnozują problem, ale żaden nie definiuje architektury docelowej.** Pytanie
   „drafter zastępuje sub-rolę czy cały squad" (MCP-doc §4.3) zostaje otwarte, a od niego zależy reszta.
   Rekomenduję trzecią odpowiedź: **squad jako workflow w kodzie**, LLM tylko w liściach (§4).
2. **MCP-doc myli frontmana z leadem squadu.** 43,5% kosztu to supervisor (frontman), nie leady squadów —
   dzieci razem to $543. Zastąpienie leadów drafterami nie dotyka tych 43,5% (§2.1).
3. **Mechanizm pewności ze „Ścieżki A" (Jev-doc §4) nie działa tak, jak opisano.** Sprawdziłem na żywo:
   Claude nie zwraca logprobs w ogóle; przy wywołaniu narzędzia logprobs nie obejmują argumentów;
   glm-5.3-flash ma obowiązkowe rozumowanie — **910 tokenów i 11 s na jedno tak/nie** (§2.2).
4. **MCP to interfejs, nie architektura.** Drafter za MCP wołany przez frontmana zostawia frontmana
   w każdej tranzycji, czyli zostawia główny koszt. Dźwignią jest przeniesienie przepływu sterowania
   z promptów do kodu (§3.2).
5. **Repo ma już deklaratywny pipeline** — `config/graph.json` (kontrakty węzłów, typowane krawędzie,
   9 konsumentów). Rozdrobnić go do poziomu kroków zamiast budować nową warstwę (§3.3).
6. **Pierwszy węzeł decyzyjny wybierać po dostępności etykiet.** 179 rekordów werdyktów z 943 findings
   (severity + evidence) to gotowy zbiór; gate pre-screener, który Jev-doc stawia na #1, ma go najmniej (§2.8).
7. **Jev przez OpenRouter to realny szczebel decyzyjny** — przez Decisions API (alpha), nie
   chat/completions: 0,3–0,5 s i ~$0,02 za tysiąc decyzji. Pierwsze pomiary pokazują jednak słabo
   rozdzielone tak/nie, więc progi dopiero po kalibracji (§2.3).
8. **Optymalizator promptów (GEPA) ma sens na krokach [J], nie na monolitycznych promptach** — jest
   nagrodą za rozdrobnienie, nie jego zamiennikiem (§3.10).

---

## 1. Co sprawdziłem i jak

| Twierdzenie | Metoda | Wynik |
|---|---|---|
| „43,5% to koszt leadu" | `docs/research/telemetry-analysis-2026-09.md` §F2 | to koszt **frontmana** (supervisor); dzieci = $543 |
| „Anthropic zwraca top_logprobs" | katalog OpenRouter (`/api/v1/models`, `supported_parameters`) + dokumentacja Claude API | **fałsz** — `logprobs=false` dla wszystkich `anthropic/*` |
| Logprobs na enumie w `tool_use` | żywa sonda, glm-5.3-flash, wymuszone wywołanie narzędzia | **brak logprobs** dla argumentów narzędzia |
| Logprobs na enumie w structured output | żywa sonda, 4 modele | działa, ale patrz koszt/latencja w §2.2 |
| „Jev przez OpenRouter `typesafe/jev-1.13`" | `/api/v1/models/typesafe/jev-1.13/endpoints` + 3 żywe wywołania | **jest**, ale tylko przez `POST /api/alpha/decisions` (alpha) — nie przez chat/completions i nie w publicznej liście `/models` |
| „Dwa równoległe runtime'y" | ADR-0011, `~/.claude/CLAUDE.md`, Atlas `ops/agent-bridge` | orchestrator w repo wycofany; Atlas to MCP nad tym samym `claude -p --resume` |
| „Exit-state nie istnieje" | `scripts/supervisor-verdict.mjs:716-733` | istnieje dla REVIEW/TEST (rekord werdyktu); brakuje dla DEV/PLAN |
| „Share'y kosztu odporne na over-count" | własny skan 1,3 GB transkryptów per squad/model | współczynnik 1,98–2,97× zależnie od squadu — **nie** jednorodny |
| Dostępne etykiety | `.state/supervisor/*/verdicts`, `*/gates` | 179 werdyktów (112 pass / 67 fail), 943 findings, 155 z `acMapping`; 326 gate'ów, w tym 56 `question` |

Sondy API kosztowały łącznie poniżej $0,01. Klucz czytany z `.env` wewnątrz skryptu, nigdzie niewypisany.

---

## 2. Błędy faktograficzne (poprawić przed jakąkolwiek decyzją)

### 2.1 Frontman ≠ lead squadu (MCP-doc §4.3, §5.2; Jev-doc §5.2)

MCP-doc §4.3(B): „drafter zastępuje squad lead entirely — likwiduje 4 squady, **eliminuje lead cost
(43,5%)**". Źródło tej liczby mówi co innego: *„The supervisor (frontman) consumed $1,339 of the $3,081
(43.5%) — 2.5× all children combined ($543)"*. W trybie nadzorowanym leady squadów **są** dziećmi.
Zastąpienie ich drafterami atakuje pulę $543, nie $1,339.

To zmienia rachunek całej wizji: jeśli celem jest 43,5%, trzeba zmniejszyć to, co robi i niesie
**frontman**, a nie to, co robią squady. Jev-doc §5.2 („frontman hand-pisze verdict — 43,5% cost")
powiela ten sam skrót — werdykt jest jedną z wielu rzeczy, które frontman robi, i nikt nie zmierzył,
jaką część jego kosztu stanowi.

### 2.2 Ścieżka A: pewność z logprobs (Jev-doc §4, §6.1)

Jev-doc: *„Anthropic zwraca `top_logprobs`"* i *„jedno `tool_use` z wieloma enum params = wszystkie
pytania w jednym call"* z pewnością z logprobs. Sprawdzone:

| Wariant | Model | Wynik | Latencja | Tokeny wyjścia |
|---|---|---|---|---|
| wymuszone `tool_use`, enum | glm-5.3-flash | odpowiedź OK, **`logprobs: null`** | 0,7 s | 10 |
| structured output (`json_schema`, enum) | glm-5.3-flash | p(yes)=0,963 | **11,0 s** | 922 (**910 reasoning**) |
| jw., `reasoning: {enabled:false}` | glm-5.3-flash | **400: „Reasoning is mandatory"** | — | — |
| structured output | deepseek-v4.1-flash | p(yes)=0,976 | 7,4 s | 894 (880 reasoning) |
| structured output | qwen3.8-flash | p(yes)=0,947 | 4,7 s | 213 (202 reasoning) |
| structured output | qwen3-30b-a3b-instruct (bez myślenia) | **p(yes)=1,0000** | 0,9 s | 14 |
| dowolny | `anthropic/*` | brak parametru `logprobs` w ogóle | — | — |

Wnioski:

- **Claude odpada jako źródło pewności** — nie ma logprobs. Ścieżka A na Claude daje typowane
  wyjście (`strict: true` / `output_config.format`), ale bez żadnej miary pewności.
- **Wywołanie narzędzia odpada jako nośnik pewności** — logprobs obejmują treść, nie argumenty narzędzia.
  Trzeba użyć structured output w treści odpowiedzi.
- **Modele, na których Fenix dziś stoi, mają obowiązkowe albo domyślne rozumowanie.** Jedno tak/nie
  kosztuje 200–900 tokenów rozumowania i 5–11 s. To nie jest „System One"; to System Two przebrany
  w enum. Prawdopodobieństwo liczone po łańcuchu rozumowania jest z natury przeostre.
- **Model bez myślenia jest szybki, ale nasycony** (p=1,0000 na łatwym przypadku). Jeden przykład nie
  mierzy kalibracji — ale pokazuje, że „margin z logprobs" bez zmierzonej kalibracji (reliability
  diagram, ECE, Brier na etykietowanym zbiorze) to liczba bez znaczenia. Progi z Jev-doc §6.3
  (0,95 / 0,5 / 0,7) nie mają dziś podstawy.

### 2.3 Jev przez OpenRouter — działa, ale innym API niż zakłada Jev-doc

Jev **jest** dostępny przez OpenRouter jako `typesafe/jev-1.13` (dostawca TypeSafe, kontekst 32k,
$0,042/M wejścia, $0 wyjścia). Nie ma go w publicznej liście `/api/v1/models`, a wywołanie przez
`chat/completions` zwraca 400: *„is a decisions model … Use the /api/alpha/decisions endpoint"*.
Alias `~typesafe/jev-latest` nie ma dziś żadnego endpointu — trzeba przypiąć wersję. Klucz
OpenRouter z `.env` wystarcza; osobne konto TypeSafe nie jest potrzebne.

Format jest inny niż w Jev-doc (tam: Pydantic `BaseModel` / tool-use): `POST /api/alpha/decisions`
z `{model, state, questions}`, gdzie każde pytanie ma `type` (`noul` = tak/nie, `choice`, `score`),
`instructions` i `criteria` (opis każdej odpowiedzi). Odpowiedź: `answers` z prawdopodobieństwem dla
`noul`, rozkładem `probabilities` + `confidence` dla `choice`, oraz `usage.cost`.

Zmierzone na trzech pytaniach gate'ów (trzy pytania typowane na wywołanie):

| Przypadek | Latencja | Koszt | `answerable_from_docs` | `needs_human_decision` | `gate_type` |
|---|---:|---:|---:|---:|---|
| logowanie do Lineara (docs odpowiadają) | 487 ms | $0,000023 | 0,61 | 0,08 | access (1,00) |
| usunięcie gałęzi review (decyzja Mateusza) | 306 ms | $0,000023 | 0,73 | **0,74** | irreversible (0,98) |
| koszt liczony vs raportowany | 286 ms | $0,000024 | 0,66 | 0,11 | ambiguity (1,00) |

To jest realna ekonomia „System One": **~0,3–0,5 s i ~$0,02 za tysiąc decyzji** wobec 5–11 s
i setek tokenów rozumowania na GLM/DeepSeek (§2.2). Klasyfikacja (`gate_type`) i
`needs_human_decision` rozdzielone czysto. **Ale** `answerable_from_docs` wyszło 0,61–0,73 we
wszystkich trzech — najniżej na najłatwiejszym przypadku. Przy progu 0,95 z planu żadna odpowiedź
nie byłaby automatyczna. Trzy przykłady to anegdota, nie pomiar — ale dokładnie dlatego próg musi
wynikać ze zmierzonej kalibracji na etykietach, a nie z liczby wybranej z góry.

Ryzyka: endpoint jest **alpha** (format i trasa mogą się zmienić), treść gate'ów trafia do
kolejnego dostawcy (TypeSafe), a odpowiedzi mogą się zmienić przy nowej wersji modelu — wersję
przypinać i trzymać w rekordzie decyzji.

Warto przenieść z dokumentacji TypeSafe/Pydantic dwie rzeczy, których Jev-doc nie ma:

- **Słabości deklarowane przez samego producenta:** arytmetyka, liczenie i daty; kilka osądów w jednym
  pytaniu; pośredniość („właściwość właściwości"); **nadmiarowy kontekst** — *„accuracy falls as the
  state grows with detail unrelated to the question, so filter before you send"*. To ostatnie jest wprost
  sprzeczne z pomysłem podawania węzłowi decyzyjnemu całego review czy całego issue.
- **Wzorzec kaskady:** `FallbackModel` przechodzi na LLM, gdy pewność < 0,8 — tani model odpowiada,
  na co umie, drogi tylko na resztę. To jest dokładnie drabina Flash→Pro→Sonnet→Opus, tylko sterowana
  pewnością zamiast ręcznie.

### 2.4 „Dwa runtime'y" (MCP-doc §4.4, §9.4)

- `working_mode` z drabiną Flash→Pro→Sonnet→Opus to **Twój globalny** `~/.claude/CLAUDE.md`, nie
  projektowy — opisuje, jak ja pracuję z Tobą, nie jak działa Fenix.
- Orchestrator w repo jest **wycofany** (ADR-0011, Accepted, 2026-09-14).
- Atlas `agent_spawn` to MCP nad **tym samym** mechanizmem co supervisor: `claude -p`, `--resume`,
  proces na turę (`ops/agent-bridge`). Wybór „supervisor-spawn czy Atlas-bridge" jest więc fałszywą
  dychotomią: MCP to interfejs wywołania, a runtime pod spodem jest ten sam.
- Różnica, która naprawdę istnieje: Atlas uruchamia dzieci z `--dangerously-skip-permissions`, bez
  deny-listy, worktree i gate'ów. Budowanie wizji na Atlasie oznacza **porzucenie kontraktu
  bezpieczeństwa supervisora**, a nie zmianę transportu.

### 2.5 „Exit-state nie istnieje" (MCP-doc §7.4)

Istnieje dla REVIEW i TEST: rekord werdyktu (`supervisor-verdict.mjs:716-733`) ma `taskId`, `round`,
`verdict`, `findings[]` (tekst + wymuszone evidence + severity z enuma), `acMapping`, `declaredAcs`,
`fingerprint`, `noFailingTests`. To pełnoprawny, walidowany kontrakt wyjścia z odmową przy braku
ugruntowania. **Brakuje go dla DEV i PLAN** — tam koniec tury to wolny tekst STATUS/ARTIFACTS/NEXT.

Praktyczna konsekwencja: FOC-278b nie jest projektem od zera, tylko **powtórzeniem wzorca rekordu
werdyktu** dla tury DEV (zmienione pliki, SHA commitu, ogon testów, otwarte pytania).

### 2.6 Ekstrakcja findings regexem (Jev-doc §3.1, §6.2)

Jev-doc proponuje `extract-findings.mjs` — regex po Conventional Comments z przebiegów review — żeby
dopiero potem weryfikować findings modelem. Ten problem jest już rozwiązany strukturalnie: dziecko
REVIEW oddaje findings jako JSON przez `supervisor-verdict.mjs record --finding`, a skrypt **odmawia**
findings bez evidence i z severity spoza enuma. Parser tekstu byłby krokiem wstecz — i sam Jev-doc
przyznaje, że jakość ekstraktora to sufit weryfikatora.

### 2.7 Lint gate jako rubryka LLM (Jev-doc §5.4)

18% findings to nity stylistyczne — to argument za **deterministycznym linterem** przed review, nie za
modelem oceniającym styl w skali 0–2. Repo ma już `scripts/lint.mjs`. LLM w tej roli to zły kształt
narzędzia: droższy, wolniejszy i mniej powtarzalny niż reguła.

### 2.8 Gate pre-screener jako priorytet #1 (Jev-doc §5.1, §8.1)

Po liczbach z samego Jev-doc: ~31% z 26 gate'ów pytających to ~8 zdarzeń, a 5 z nich to problem
widoczności kickoffu, który leczy już pinned-state (FOC-286). Dziś jest 56 gate'ów `question` — nadal
najmniej danych ze wszystkich kandydatów, zero klasy negatywnej, a do tego najbardziej wrażliwy
kontrakt (twarda reguła „nie odpowiadaj za Mateusza"). Najlepszy kandydat po stronie danych to
**findings z rekordów werdyktów**: 943 etykietowane przykłady z severity i evidence.

### 2.9 Over-count nie jest proporcjonalny (telemetria, na której stoją oba dokumenty)

`telemetry-analysis-2026-09.md` twierdzi, że nadliczenie wieloliniowych wiadomości (2,19×) jest
proporcjonalne między squadami, więc udziały są wiarygodne. Zmierzyłem per squad (max usage per
`message.id` vs suma po liniach):

| Squad | linie / wiadomość | współczynnik | udział w tokenach (surowy → poprawiony) |
|---|---:|---:|---:|
| supervisor | 2,34 | 2,05× | 38,5% → **39,7%** |
| dev | 2,50 | 1,98× | 35,4% → **38,1%** |
| review | 2,90 | 2,42× | 13,0% → 11,4% |
| test | 2,76 | 2,49× | 10,7% → 9,1% |
| plan | 3,59 | 2,97× | 2,4% → **1,7%** |

Twierdzenie jest fałszywe co do zasady, ale dla frontmana skutek jest mały (+1,2 pp) — kierunek
wniosku „frontman to centrum kosztu" stoi. Dwie rzeczy z tego wynikają: **R7b (dedup po `message.id`
przy ingest) nadal nie wylądował**, więc każda kwota w obu dokumentach jest ~2,19× za wysoka; a PLAN —
najbardziej monolityczny prompt — to **1,7% wolumenu**.

---

## 3. Luki koncepcyjne (czego żaden dokument nie adresuje)

### 3.1 Brak architektury docelowej

Oba dokumenty katalogują draftery i ich ryzyka. Żaden nie mówi, **czym zastępujemy monolit**: kto
trzyma przepływ sterowania, gdzie żyje stan między krokami, jak kroki się składają, kto decyduje o
przejściu. MCP-doc stawia pytanie (A) vs (B) i zostawia je otwarte; Jev-doc go nie podejmuje.
Odpowiedź proponuję w §4.

### 3.2 MCP nie redukuje kosztu frontmana — przeniesienie sterowania do kodu tak

Wizja: „supervisor wywołuje MCP, za którym stoi agent". Jeśli frontman (LLM) wywołuje każde narzędzie,
to frontman nadal czyta każde wejście, każde wyjście i decyduje o każdej tranzycji — czyli nadal niesie
kontekst, który jest źródłem 43,5% (MCP-doc sam to mówi w §7.2 pkt 2). Draftery za MCP przenoszą
pracę, ale nie wyjmują frontmana z pętli.

Rutynowe tranzycje (DoR spełniony → DEV; werdykt pass → TEST; fingerprint powtórzony → eskalacja;
TEST done + drzewo czyste → cleanup) są dziś **deterministyczne co do treści**, a mimo to wykonuje je
LLM. Wyjęcie ich do kodu to największa dźwignia kosztowa w tej architekturze. MCP ma sens dokładnie
tam, gdzie LLM musi **wybrać** narzędzie — czyli w wyjątkach, nie w ścieżce szczęśliwej.

### 3.3 `config/graph.json` to już deklaratywny pipeline — tylko na złej granulacji

`graph.json` (FOC-158) ma kontrakty węzłów (`input`, `output`, `completion`, `failure`, `gates`,
`autonomy`, `budget`, `concurrency`), typowane krawędzie z warunkami (`handoff`, `return`, `escalate`,
`gate`) i 9 konsumentów (`graph-route`, `graph-validate`, `supervisor-{triage,spawn,verdict,budget,
cleanup,lib}`, `telemetry-viz-export`). Ma też politykę promocji autonomii „tylko ręcznie, na dowodach
z telemetrii".

To gotowy nośnik rozdrobnienia: węzeł `plan` staje się podgrafem (`plan.dor → plan.ac → plan.spec →
plan.decompose → plan.push`), każdy z własnym kontraktem i rodzajem wykonawcy. Żaden z dokumentów tego
nie proponuje — oba wymyślają nową warstwę obok.

### 3.4 Typowane kontrakty kroków i log zdarzeń runu

Uogólnienie FOC-278b: **każdy krok** kończy się typowanym rekordem (jak werdykt), a nie tekstem.
Katalog `.state/supervisor/<run>/` już ma `children.json`, `gates/`, `verdicts/`, `merge.json` —
to zaczątek logu zdarzeń. Uczynić go jedynym źródłem prawdy: krok czyta typowane rekordy
poprzedników i dopisuje swój. Wtedy:

- sesja przestaje być nośnikiem stanu (MCP-doc §7.2 pkt 1 — problem `--resume` znika dla kroków
  bezstanowych; zostaje tylko dla pętli agentowych, gdzie ma sens);
- handoff-compressor (FOC-283) kompresuje rekordy, nie prozę;
- każdy krok da się odtworzyć offline na historycznych rekordach — co jest warunkiem §3.5.

### 3.5 Ewaluacja przed wymianą: shadow mode, replay, kalibracja

Oba dokumenty słusznie mówią „jakość nie jest mierzona", ale nie podają mechanizmu wymiany komponentu.
Proponuję trzy warstwy:

1. **Replay offline** na zarejestrowanych danych: 179 rekordów werdyktów, 943 findings, 155 mapowań AC,
   157 par dev→review. Nowy węzeł musi pobić bieżące zachowanie na tych danych, zanim zobaczy ruch.
2. **Shadow mode** w runach: nowy węzeł liczy się obok starej ścieżki, loguje decyzję i pewność, ale
   niczego nie zmienia. Porównanie z tym, co faktycznie się stało.
3. **Kalibracja jako kryterium promocji**: dla węzłów z pewnością — reliability diagram i ECE/Brier na
   etykietach, zanim jakikolwiek próg z §6.3 Jev-doc wejdzie do konfiguracji.

Promocja węzła = ta sama polityka co `_autonomy` w `graph.json`: ręczna edycja przez Ciebie,
na dowodach.

### 3.6 Niezawodność: każdy nowy węzeł to nowy punkt awarii

22/38 złych tur to awarie dostawcy (telemetria F1). Rozdrobnienie mnoży punkty integracji. Każdy węzeł
potrzebuje: **fail-closed z fallbackiem** do obecnej ścieżki albo do HITL, retry na granicy tury,
budżetu per węzeł i wyłącznika przy serii błędów dostawcy. Kaskada sterowana pewnością (§2.3)
jest tu naturalnym wzorcem: niska pewność albo błąd → wyższy szczebel, na końcu Ty.

### 3.7 Bezpieczeństwo zmienia kształt

- Deny-lista jest obchodzalna i checklista e2e przyznaje to wprost (`cmd /c git push`,
  `powershell -c`, `git -C <path> push`). Klasa decyzji „czy ta komenda niszczy dane lub wycieka
  sekret" to idealny węzeł decyzyjny **przed wykonaniem** narzędzia — wzorzec „judge a tool call before
  it runs" z dokumentacji Jev, w Claude Code realizowalny hookiem `PreToolUse`. To realniejszy pierwszy
  zysk z decyzji typowanych niż gate pre-screener.
- Wyjście enum ogranicza zasięg prompt injection: treść issue czy review może przesunąć wybór, ale nie
  może „napisać" polecenia.
- Reużycie Atlasa zrzuca deny-listę, worktree i gate'y (§2.4).

### 3.8 Ekonomia węzłów decyzyjnych na obecnych modelach

Z sond (§2.2): na modelach, których Fenix używa, decyzja tak/nie kosztuje 5–11 s i setki tokenów
rozumowania. Fenix potrzebuje osobnego **szczebla decyzyjnego**. Kandydaci, w kolejności:

1. **Jev przez OpenRouter Decisions API** (§2.3) — 0,3–0,5 s, ~$0,00002 za wywołanie z trzema
   pytaniami, prawdopodobieństwa i `confidence` w odpowiedzi natywnie, ten sam klucz co reszta
   Fenixa. Minusy: endpoint alpha, jeden dostawca, pierwsze `noul` słabo rozdzielone.
2. **Model bez myślenia z logprobs** przez `chat/completions` + structured output (np.
   qwen3-30b-a3b-instruct: 0,9 s, 14 tokenów) — rezerwa, gdyby Decisions API zniknęło; pierwsza
   próba dała nasycone p=1,0000.

W obu przypadkach kalibrację mierzymy sami na etykietach, zanim jakikolwiek próg trafi do konfiguracji.

### 3.9 Priorytet wg wolumenu i kosztu, nie wg „monolityczności" promptu

MCP-doc ocenia rozkładalność od strony promptów (PLAN ★★★★★). Od strony danych kolejność jest inna:
frontman ~40% tokenów, DEV ~38%, REVIEW ~11%, TEST ~9%, **PLAN ~2%**. Rozbicie PLAN jest dobre dla
jakości i czytelności, ale nie ruszy rachunku. Rachunek ruszają: frontman poza rutynowymi
tranzycjami (§3.2) i DEV bez re-derywacji stanu (pinned-state wejścia już jest, wyjścia — FOC-278b).

### 3.10 Optymalizacja promptów (DSPy / GEPA) — tak, ale na krokach, nie na squadach

Optymalizator promptów potrzebuje trzech rzeczy: **ograniczonego modułu z typowanym wejściem i
wyjściem, metryki i etykietowanego zbioru**. Monolityczne `agents/*/CLAUDE.md` nie spełniają żadnej:
jedna ewaluacja to pełny run (godziny, dolary), a metryka „czy task dobrze zrobiony" jest rzadka
i zaszumiona. Dlatego optymalizacja jest **konsekwencją** rozdrobnienia, nie alternatywą dla niego.

Po rozdrobnieniu cele są naturalne:

- **Kroki [J]:** w Jev „promptem" są `instructions` i `criteria` każdego pytania. To krótkie teksty,
  wywołanie kosztuje ~$0,00002, a etykiety już są (943 findings, 179 werdyktów, gate'y). Tysiąc
  wywołań optymalizacji to kilka centów.
- **Ograniczone podprompty [A]** (np. deep pass REVIEW) — później, gdy istnieje dla nich metryka.

Narzędzie: **GEPA** (Agrawal i in., ICLR 2026) — w DSPy jako `dspy.GEPA`, a także samodzielnie
(`pip install gepa`) z adapterem, który optymalizuje dowolny tekst, nie tylko programy DSPy.
Ewoluuje instrukcje przez refleksję nad śladami wykonania i przyjmuje **tekstową informację zwrotną**
z metryki (np. „finding oznaczony jako blocking dostał nit"), dzięki czemu działa na małych zbiorach
— praktycy raportują 20–100 przykładów jako optimum. MIPROv2 potrzebuje więcej danych.

Architektonicznie: optymalizacja to **proces offline** (Python), którego wynikiem jest wersjonowany
artefakt — plik z `instructions`/`criteria` w repo, z wynikiem ewaluacji w commicie. Runtime zostaje
w Node i tylko czyta ten plik. Portu DSPy do TypeScript nie potrzeba.

Pułapki: przeuczenie na małym zbiorze (twardy podział train/val/test, test oglądany tylko raz na
kandydata końcowego), „granie pod metrykę" (metryka musi karać też spadek kalibracji, nie tylko
trafność) i dryf przy zmianie wersji modelu (ponowna optymalizacja przy każdej zmianie przypiętej
wersji).

---

## 4. Architektura docelowa — propozycja

```
Linear issue
   │
   ▼
graph runner (kod, deterministyczny)  ◀── config/graph.json v2: kroki, krawędzie, progi, autonomia
   │   czyta i dopisuje typowane rekordy do .state/supervisor/<run>/ (log zdarzeń)
   │
   ├─ [D] kroki deterministyczne   DoR-check, lint, test runner, fingerprint, merge-authority,
   │                               routing po krawędziach, cleanup, pinned-state
   │
   ├─ [J] kroki decyzyjne          typowane wyjście (bool/enum/rubryka), pewność tam, gdzie mierzalna;
   │                               np. severity findingu, AC zmapowane?, ta sama klasa błędu co runda N-1?,
   │                               czy komenda jest nieodwracalna?
   │        └─ niska pewność / błąd ──▶ wyższy szczebel ──▶ frontman ──▶ Ty
   │
   ├─ [A] kroki agentowe           pełna pętla Claude Code w worktree: DEV implement, REVIEW deep pass,
   │                               PLAN spec — jedyne miejsce na długi kontekst i --resume
   │
   └─ [H] bramki HITL              istniejący kontrakt gate (emit → answer → followup)

frontman (LLM): wyjątki, eskalacje, rozmowa z Tobą — nie każda tranzycja
MCP: interfejs dla kroków [J]/[A], gdy wywołuje je LLM; runner woła je bezpośrednio
```

Na pytanie (A) vs (B) z MCP-doc: **żadne z dwóch w czystej postaci.** Efekt jest bliższy (B), bo LLM
znika ze sterowania, ale droga jest przyrostowa: węzeł po węźle, każdy za bramką replay → shadow →
promocja, zamiast przepisania architektury naraz.

Czego **nie** ruszać: kontraktu gate'ów, deny-listy (dopóki węzeł „judge before run" jej nie
uzupełni), worktree per dziecko, polityki autonomii z `graph.json`.

---

## 5. Kolejność z kryteriami wyjścia

| Faza | Co | Kryterium wyjścia |
|---|---|---|
| **0. Higiena danych** | R7b (dedup po `message.id` przy ingest, ADR); klucz telemetrii per węzeł | kwoty w raportach bez współczynnika 2,19×; koszt per węzeł widoczny |
| **1. Kontrakt wyjścia DEV** | FOC-278b jako kopia wzorca rekordu werdyktu | każda tura DEV kończy się walidowanym rekordem; odmowa przy braku pól |
| **2. `graph.json` v2** | kroki zamiast squadów; runner wykonujący kroki [D]; bez zmian w LLM | rutynowe tranzycje bez frontmana; udział tokenów frontmana spada |
| **3. Szczebel decyzyjny** | `decision-call.mjs` na Jev Decisions API (rezerwa: structured output z logprobs, nie tool-use); harness ewaluacji + kalibracji na rekordach | pierwszy węzeł [J] pobija status quo w replay; zmierzone ECE |
| **3b. Optymalizacja** | GEPA offline na `instructions`/`criteria` kroków [J]; wynik jako wersjonowany plik w repo | kandydat pobija ręczną wersję na zbiorze testowym bez pogorszenia kalibracji |
| **4. Promocja** | shadow mode → promocja węzeł po węźle | edycja `_autonomy` przez Ciebie, na dowodach |
| **5. Handoff compressor** | FOC-283 na rekordach z fazy 1 | spadek context-call share poniżej bazowych 27–33% bez regresji werdyktów |

Pierwsi kandydaci na [J], w kolejności danych: **severity/ugruntowanie findingu** (943 etykiety),
**mapowanie AC** (155), **powtórzenie klasy błędu między rundami** (179 rekordów w rundach 1–10),
**„czy komenda jest nieodwracalna"** (bezpieczeństwo, mały zbiór, ale wysoka stawka). Gate
pre-screener — dopiero gdy etykiet przybędzie.

---

## 6. Decyzje dla Ciebie (z moją rekomendacją)

1. **Architektura docelowa:** workflow w kodzie z LLM w liściach (§4) zamiast „draftery za MCP
   wołane przez frontmana"? — *rekomenduję tak.*
2. **Nośnik:** rozdrobnienie `config/graph.json` zamiast nowej warstwy MCP? — *tak.*
3. **Kolejność:** R7b i kontrakt wyjścia DEV przed jakimkolwiek modelem? — *tak; bez nich każdy pomiar
   jest zawyżony albo nieporównywalny.*
4. **Szczebel decyzyjny:** Jev przez OpenRouter Decisions API jako pierwszy kandydat, model bez
   myślenia z logprobs jako rezerwa, Claude tylko dla typowanego wyjścia bez pewności? — *tak.*
5. **Optymalizacja promptów:** GEPA offline na krokach [J], po zbudowaniu harnessu ewaluacji — *tak;
   nie na monolitycznych promptach squadów.*
6. **Pierwszy węzeł [J]:** findings z werdyktów zamiast gate pre-screenera? — *tak.*
7. **Korekty w obu dokumentach** (§2.1–§2.9) — nanieść, zanim posłużą za podstawę PRD? — *tak.*

---

## Aneks — reprodukcja

- **Sondy logprobs:** OpenRouter `/api/v1/chat/completions`, `logprobs: true`, `top_logprobs: 5`,
  `provider.require_parameters: true`; stan: pytanie gate'u o logowanie + zdanie z ACCESS.md; schemat
  `{answerable_from_docs: "yes"|"no"}`; warianty `response_format: json_schema` i wymuszony `tool_choice`.
- **Katalog:** `GET https://openrouter.ai/api/v1/models`, pole `supported_parameters`.
- **Jev:** `GET /api/v1/models/typesafe/jev-1.13/endpoints`; wywołania `POST
  https://openrouter.ai/api/alpha/decisions` z `{model: "typesafe/jev-1.13", state, questions}`,
  pytania `answerable_from_docs` (`noul`), `needs_human_decision` (`noul`), `gate_type` (`choice`).
- **Over-count per squad:** wszystkie `agents/<squad>/projects/**/*.jsonl`; dla linii `assistant`
  z `usage`: suma po liniach vs maksimum per `message.id`; tokeny = input + output + cache read + cache
  creation.
- **Etykiety:** `.state/supervisor/*/verdicts/*.json` i `*/gates/*.json`.

Skrypty sond leżą w scratchpadzie tej sesji; na prośbę mogę je przenieść do `scripts/` jako narzędzia
diagnostyczne.
