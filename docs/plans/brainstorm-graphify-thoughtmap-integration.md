---
type: brainstorm
status: approved-v1 (decyzje wiążące 2026-07-21; spike MCP-under-OR zaliczony)
audience: Mateusz (zatwierdzone) → PLAN squad (dekompozycja pod JOI-73)
topic: graphify (mapa codebase) + thoughtmap (kontekst projektu) jako integralna część Fenixa — składy budują, konsumują i utrzymują mapy
related:
  - ./brainstorm-autonomous-dispatch.md      # A — dispatcher
  - ./brainstorm-specialization-learning.md  # B — uczenie specjalizacji
  - ../ROADMAP.md                            # master plan index
  - ../decisions/cost-optimization.md
memory: [[fenix-mcp-under-openrouter]]
---

# Brainstorm C — graphify + thoughtmap jako warstwa kontekstu składów

## Wizja
Składy nie zaczynają każdego taska od zera. **graphify** daje mapę codebase (AST + semantyka),
**thoughtmap** daje kontekst projektu z notatek/myśli Mateusza. PLAN buduje mapy przy `discovery`,
kolejne składy je konsumują, a w razie potrzeby aktualizują. Mocne modele „dysponują porządkiem" —
mapa zastępuje ślepe czytanie plików (bije też podatek cache z [[cost-optimization]]).

## Decyzje wiążące (Mateusz 2026-07-21)
1. **Własność: PLAN buduje przy `discovery`, reszta konsumuje i aktualizuje w razie potrzeby.**
2. **Dostęp przez MCP** (lokalne serwery stdio) — SPRAWDZONE, że ładują się pod OpenRouterem
   (spike: 14 narzędzi `mcp__fs__*` w evencie init pod OR/dev-squad; `[[fenix-mcp-under-openrouter]]`).
   Notatka T-C2 „OR blokuje connectors" dotyczyła chmurowych connectorów OAuth, nie lokalnego stdio.
   **Fallback:** odczyt `graphify-out/graph.json` z dysku (zawsze działa) gdyby model kiedyś nie
   emitował `mcp__` calls.
3. **Linear zostaje na skryptach** (`linear-query`/`linear-ops`) do zapisu — headless-safe pod
   dispatcher (A), audytowalne. Martwy config MCP-linear w plan/test do sprzątnięcia.
4. **Atlas: NIE wpinać** w składy (mój most, ta sama ściana OAuth, kolizja nazw „Fenix"=projekt
   kliencki). Jednorazowo wyciągnąć pułapki Linear do `docs/linear-conventions.md`.
5. **Handoff wspomina mapy** — zwięzła „pałeczka" w komentarzu (ostatnia mila, niżej).

## Asymetria (fundament designu)
- **graphify = świeży graf PER REPO** w którym pracuje skład (`graphify-out/` w repo taska).
  PLAN buduje/`--update`; utrzymanie tanie: git post-commit hook (AST, zero LLM) między falami.
- **thoughtmap = JEDNA globalna mapa** myśli Mateusza (Obsidian + Wispr). Składy ją **odpytują**
  (read-only sensor, spójnie z [[thoughtmap-linear-hermes]]), NIE odpalają nowego przebiegu.
  Jeśli notatki projektu brak → PLAN tworzy stub, żeby najbliższy nocny run thoughtmap ją podchwycił.

## Integracja per skład
| Krok | graphify | thoughtmap |
|---|---|---|
| PLAN `discovery` | jeśli brak `graphify-out/graph.json` dla repo → `/graphify <repo>`; jest → `--update`. God nodes + surprising connections do briefu. | `search_thoughts` / `get_cluster` po nazwie projektu → kontekst do briefu. Brak notatki projektu → utwórz stub w Obsidianie. |
| DEV `recon` | `query_graph`/`get_neighbors` zamiast ślepego czytania; po zmianach `--update` (albo hook robi to sam). | odpytanie kontekstu decyzji/wcześniejszych przemyśleń o feature. |
| REVIEW `deep`/`first-pass` | `shortest_path`/`god_nodes` do oceny wpływu zmiany (blast radius). | — |
| CADENCE | — | trend tematów (co realnie robione) do digestu. |

## Mechanika dostępu
- Serwery MCP w `agents/<squad>/settings.json` → `mcpServers`: graphify (`python -m graphify.serve
  <repo>/graphify-out/graph.json`) i thoughtmap (`python -m thoughtmap.mcp_server`). Toole
  whitelisted w `permissions.allow` (`mcp__graphify__*`, `mcp__thoughtmap__*`).
- thoughtmap MCP wymaga działającego serwera (Docker albo `python -m thoughtmap static` na wygenerowanych
  artefaktach) — read-only, nic nie odpala.
- Indeks w CLAUDE.md leada (1 linia): „przed czytaniem kodu odpytaj graphify; kontekst projektu z thoughtmap".

## Handoff — pałeczka (ostatnia mila)
`scripts/publish-linear-comment.mjs` + `--context-file` → zwięzła sekcja „Context maps" (2 linie):
```
🗺 Code map (graphify): 142 nodes · god: telemetry-server, ledger · fresh
🧠 Project context (thoughtmap): cluster "equity-split" (37 thoughts)
```
Cel: recon następnego składu widzi, że mapy są świeże → odpytuje zamiast budować. Degradacja: brak map → brak linii.

## Fazy + acceptance
| Faza | Zakres | AC |
|---|---|---|
| **C1 — graphify w DEV recon** | serwer MCP graphify w `agents/dev/settings.json`; recon odpytuje graf; post-commit hook utrzymuje | realny dev-run woła narzędzie `mcp__graphify__*` i cytuje graf w reconie; hook aktualizuje `graph.json` po commicie |
| **C2 — PLAN własność map** | PLAN discovery buduje/`--update` graphify + odpytuje thoughtmap; tworzy stub notatki gdy brak | plan-run na nowym repo → `graphify-out/` powstaje; brief zawiera god nodes + kontekst thoughtmap |
| **C3 — thoughtmap MCP w składach** | serwer thoughtmap MCP w plan/dev/cadence; whitelisting; indeks w CLAUDE.md | skład woła `mcp__thoughtmap__search_thoughts` i używa wyniku |
| **C4 — handoff context-pack** | `--context-file` w publish-linear-comment; leady piszą pack po odpytaniu map | komentarz dev→review zawiera linię „Context maps" z realnymi liczbami; brak map → brak linii |
| **C0 — higiena (równolegle)** | sprzątnąć martwy MCP-linear w plan/test settings; `docs/linear-conventions.md` z pułapkami z Atlasa | check-suite zielony; plan/test bez nieużywanego `mcpServers.linear` |

## Zależności
- C1 niezależne (można robić od razu, świetny wkład w PILOT/JOI-83).
- C3 wymaga uruchomionego serwera thoughtmap (Docker/static) w środowisku składu.
- Fallback plikowy zdejmuje ryzyko z całości — jeśli MCP-call zawiedzie u jakiegoś modelu, składy czytają `graph.json`.

## Poza zakresem
Budowa własnego serwera MCP dla Fenixa; wpięcie Atlasa; auto-tworzenie notatek thoughtmap poza stubem (pełne ThoughtAtom = projekt thoughtmap, nie Fenix).
