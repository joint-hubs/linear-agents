<tool name="code-intel">

# code-intel — pytania o strukturę kodu bez czytania kodu

Opakowuje graf **CodeGraph** (`.codegraph/`). Odpowiada na pytania strukturalne **jednym
wywołaniem**, zamiast wyprawy Grep + Read po kilkunastu plikach.

<when_to_use>

Zanim zaczniesz przeszukiwać repo, zadaj sobie pytanie: czy szukam **struktury** czy **treści**?

- struktura (gdzie to jest, co to woła, co od tego zależy) → **code-intel** / `codegraph_explore`
- treść (jaki dokładnie tekst jest w linii 40) → Grep/Read

Rola `recon` powinna zaczynać stąd. Przeczytanie piętnastu plików, żeby odpowiedzieć „gdzie
leży obsługa X", to najdroższy wzorzec w tym repo.

</when_to_use>

<two_layers>

Są dwie drogi do tego samego grafu i warto wiedzieć, kiedy która.

**MCP — `mcp__codegraph__codegraph_explore`.** Pierwszy wybór, gdy masz go w narzędziach.
Jedno wywołanie zwraca dosłowne źródło odpowiednich symboli pogrupowane po plikach, ścieżki
wywołań między nimi (łącznie ze skokami przez dynamiczny dispatch, których Grep nie przejdzie)
i podsumowanie promienia rażenia. Nie deleguj eksploracji do subagenta czytającego pliki —
subagent bez tych narzędzi i tak otworzy pliki, a CodeGraph staje się wtedy czystym narzutem.

Serwer jest zadeklarowany raz w repo, w **`.mcp.json`** (zakres projektowy) — działa niezależnie
od tego, jaki `CLAUDE_CONFIG_DIR` ma dziecko. **Nie** w `agents/*/settings.json`: Claude Code nie
czyta stamtąd `mcpServers` (zweryfikowane — `claude mcp list` odpowiadał „No MCP servers configured").

Serwer projektowy startuje jako `Pending approval` i jest bezużyteczny, dopóki dany katalog configu
go nie zatwierdzi. Dzieci lecą headless, więc dialog zaufania nie ma jak się pokazać — zatwierdzenie
robi `node scripts/mcp-enable.mjs --verify` (raz na maszynę; sam pyta Claude Code, czy wyszło).

Zestaw narzędzi rozszerza `CODEGRAPH_MCP_TOOLS` w `.mcp.json` — domyślnie MCP wystawia tylko
`explore`. Zweryfikowane na żywym dziecku: 8 narzędzi `mcp__codegraph__*`, serwer `connected`.

**MCP tego repo idzie przez strażnik, nie przez surowy serwer.** `.mcp.json` wystawia
`scripts/mcp/server-codegraph.mjs` — fail-closed proxy nad `codegraph serve --mcp`: handshake
i `tools/list` przechodzą dosłownie, każde zapytanie o indeks ma przed sobą gate świeżości
(współdzielony runtime `scripts/codegraph-runtime.mjs`), a świeżości nieudowodnionej proxy nie
puszcza dalej — wraca typowane UNKNOWN (`isError`, wskazuje sankcjonowany fallback Read/Grep,
nie podaje nazwy odpytywanego symbolu). Uwaga: `codegraph install` **nadpisuje `.mcp.json`**
z powrotem na surowy serwer — po takiej instalacji przywróć wpis proxy i zatwierdź go ponownie
(`node scripts/mcp-enable.mjs --verify`).

**CLI — `scripts/code-intel.mjs`.** Podłoga, nie sufit. Działa bez żadnej konfiguracji MCP,
da się wołać ze skryptu i wystawia każdy werb osobno. Gdy pytanie jest wąskie („kto to woła"),
jest tańsze niż `explore`.

</two_layers>

<commands>

```bash
node $LA_ROOT/scripts/code-intel.mjs explore "obsługa promptów"   # źródło + ścieżki wywołań, jeden strzał
node $LA_ROOT/scripts/code-intel.mjs symbol writeSquadConfig      # jeden symbol: źródło, kto woła, co woła
node $LA_ROOT/scripts/code-intel.mjs impact graphql --depth 2     # co pęknie przy zmianie
node $LA_ROOT/scripts/code-intel.mjs callers resolvePrice         # kto to woła
node $LA_ROOT/scripts/code-intel.mjs callees suggestedSquad       # co to woła
node $LA_ROOT/scripts/code-intel.mjs find "supervisor" --kind function
node $LA_ROOT/scripts/code-intel.mjs files --filter scripts       # struktura plików z indeksu
node $LA_ROOT/scripts/code-intel.mjs affected scripts/foo.mjs     # które testy dotyka ta zmiana
node $LA_ROOT/scripts/code-intel.mjs status                       # czy indeks jest i czy zsynchronizowany
```

Flagi lecą wprost do `codegraph`: `--json`, `--limit N`, `--kind K`, `--depth N`.
`--project-root <root>` wskazuje repo, którego indeks odpytujesz (nowy kod domyślnie katalog
wołający); `$LA_ROOT` to checkout toolingu, nie cel grafu.

</commands>

<critical_limitation>

**Brak indeksu to NIEWIADOMA, nie „nie ma".**

To jest ta sama pułapka co zawsze, tylko przesunięta. Odpowiedź „not found" brzmi pewnie i
bywa fałszem. Dlatego przy braku `.codegraph/` narzędzie **odmawia i wychodzi z kodem 3**,
zamiast odpowiedzieć pustką — pusta odpowiedź wygląda jak „nie istnieje" i wysyła agenta w
złą stronę.

Gdy zobaczysz exit 3: potwierdź Grepem i **nie pisz w raporcie, że czegoś nie ma** — UNKNOWN
nie jest dowodem nieistnienia. Budowa indeksu (`codegraph init`) należy do gotowości launchu,
nie do zadania: nie inicjalizuj indeksu ad hoc w trakcie pracy.

**Świeżość pilnuje strażnik, nie watcher.** Watcher plików z debounce istnieje, ale nie on jest
dowodem świeżości. Dowodem jest strażnik: proxy MCP i wrapper CLI sprawdzają świeżość **przed
każdym zapytaniem** (gate → sync przy pending → dopiero odpowiedź), więc nie ma hooka
post-commit ani niczego, co trzeba odświeżać po edycji. Przez strażnika baner `⚠️` z nazwą
pliku nie dochodzi do klienta: proxy go odbiera, robi bounded re-gate i retry, a gdy świeżości
nie da się udowodnić — odpowiada typowanym UNKNOWN. Surowe CLI (bez strażnika) taki baner
przepuszcza — dlatego nie ufaj mu po edycji. Gdy dostaniesz UNKNOWN: przeczytaj plik wprost
(Grep/Read), zamiast ufać kopii z indeksu.

**Świeżość: strażnik pilnuje (wrapper CLI i proxy MCP), surowe CLI nie** (FOC-114, rundy 4–5). `code-intel.mjs` przed
każdym werbem zapytania sprawdza `status --json` → `pendingChanges`: przy oczekujących
zmianach sam robi `codegraph sync <root>` i odpytuje dopiero przy zerze pending; gdy świeżości
nie da się udowodnić (sync nieudany, stan nieczytelny, **brak bazowej linii gita** — bez
`.git` i rozwiązywalnego `HEAD` sygnał pending potrafi zgłosić fałszywe zero, więc zero liczy
się jako dowód tylko przy zaangażowanym repo) — **odmawia z exit 3**, z tą samą semantyką
UNKNOWN co przy braku indeksu, i nigdy nie podaje nazwy odpytywanego symbolu.
**Surowe jednostrzałowe CLI (`codegraph symbol/find/...` bezpośrednio) nie ma żadnej z tych
osłon** (zmierzone, `docs/benchmark/codegraph-missing-index-evidence.md` §5–6): po edycji
odpowiada ze starej lokalizacji bez ostrzeżenia, a zapytanie o symbol spoza indeksu brzmi
pewnie „not found". **Pytaj przez wrapper, nie przez surowe CLI**; przed zaufaniem negatywowi
z surowego CLI sprawdź `status --json` albo potwierdź Grepem. Zachowanie surowego CLI jest
uwiezione tripwire'ami (cases 4/5 w `scripts/code-intel.test.mjs`).

`.codegraph/` jest gitignorowany, więc po świeżym klonie indeksu nie ma w ogóle.

</critical_limitation>

<retired_verbs>

Trzy werby z czasów GitNexusa nie mają odpowiednika i `code-intel.mjs` **odmawia ich po
nazwie**, zamiast mapować na coś zbliżonego:

| werb | co zamiast |
|---|---|
| `path <a> <b>` | `explore "how does <a> reach <b>"` — ścieżki wywołań przychodzą w odpowiedzi |
| `cycles` | brak — CodeGraph nie sprawdza cykli importów. `npx madge --circular` albo Grep |
| `raw <cypher>` | brak — CodeGraph nie jest bazą Cypher |

Powód odmowy zamiast cichego mapowania: „cycles: nic nie znaleziono" z narzędzia, które
niczego nie sprawdziło, jest gorsze niż brak odpowiedzi.

</retired_verbs>

<example>

Zadanie: „sprawdź, czy da się bezpiecznie zmienić `suggestedSquad`".

```
$ node $LA_ROOT/scripts/code-intel.mjs impact suggestedSquad --json
```

Jedno wywołanie mówi, ilu wywołujących ma symbol i jak głęboko sięga zmiana. Bez tego trzeba
by przeszukać repo i przeczytać kilka plików, żeby dojść do tego samego wniosku.

</example>

</tool>
