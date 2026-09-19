# Wizja MCP pipeline — analiza obecnej implementacji, promptów, telemetrii i lessons FOC-359

> **Data:** 2026-09-19
> **Autor:** supervisor (frontman), na prośbę Mateusza
> **Rodzaj:** analiza / ocena kierunku (nie task, nie PRD)
> **Źródło wizji:** `docs/plans/fenix-backlog-triage-2026-09-19.md` sekcja „Wizja"
> **Postawa:** sceptyczna i skrupulatna — dokument ma policzyć napięcia, nie reklamować kierunek.

## 1. Cel i zakres

Mateusz poprosił o analizę obecnej implementacji, promptów i zachowań agentów (w tym danych telemetrycznych) pod kątem wizji z 2026-09-19: *supervisor wywołuje MCP, za którym stoi osobny agent robiący izolowane akcje; więcej akcji, mniejsze izolowane modele, każdy robi jedną rzecz*.

Zakres zbadany na trzech równoległych rekonesansach + dokumentach źródłowych:

| Obszar | Źródło | Co zbadano |
|---|---|---|
| Prompty squad | 7× `agents/*/CLAUDE.md` | role, gate behavior, supervised mode, routing, handoff, caps, rozkładalność |
| Telemetria | `telemetry.sqlite` (708 MB, 689 sesji), `telemetry-store.mjs`, `context-attribution.mjs`, `delegation-outcomes.mjs` | cost per role, context-call share, pary handoff, tool patterns, quality |
| Core impl | `supervisor-{spawn,gate,verdict,merge,triage,followup,lib}.mjs`, `config/graph.json` | kontrakt supervisor↔child, gate seam, deny-list, schema, pinned-state |
| FOC-359 | abandon report, explainer, PRD, memory | root cause, salvageable Stage A, extractive vs generative |
| ADR-y | ADR-0009 (frontman runtime), brainstorm-graph-engineering | co zostało odrzucone, dlaczego |

## 2. Wizja (przypomnienie)

```
supervisor (frontman)
  ├─ MCP: handoff-compressor    (FOC-283 — extractive)
  ├─ MCP: dod-drafter
  ├─ MCP: ac-drafter
  ├─ MCP: verdict-drafter        (Stage A z FOC-359 — xgrammar + API model)
  ├─ MCP: ...
  └─ supervisor zatwierdza każdy (HITL — ten sam kontrakt co gates)
```

Cztery zasady zadeklarowane w triage-doc:

1. **Extractive, nie generative** (lesson FOC-359: 4B generuje własne treści, findings_f1=0.04).
2. **Schema-gated** (xgrammar constrained decoding — Stage A z FOC-359, reusable).
3. **Izolowane, jedna akcja** (każdy model jedną rzecz; nie multi-task w jednym adapterze).
4. **HITL** (supervisor zatwierdza każdy draft — ten sam kontrakt co gates).

Kolejność deklarowana: stabilizacja (done) → FOC-278 → FOC-283 → kolejne draftery → FOC-103.

## 3. Aktualna implementacja — kontrakt supervisor↔child

### 3.1 Wejście child (spawn)

- **Worktree** — własny checkout git, branch `foc-<id>-<squad>`. Każde dziecko osobne drzewo (ADR-0009, FOC-172).
- **Pinned-state prologue** (FOC-286) — 10-polowy machine-templated tekst prepended do kickoffu: repo, worktree, branch, base-revision, clean-at-spawn, issue, run/child/LA_RUN_ID, spawn-verified checks, pre-authorized, known-quirks. `verifyPinnedState` weryfikuje fakty PRZED spawnem (worktree-exists, branch-match, base-revision-match, tree-state). Odmowa = brak prologue, brak child.
- **Kickoff** — `--prompt` lub `--prompt-file`, czytany przez spawn (caller-cwd).
- **Deny-list** (`SUPERVISOR_DENY`, FOC-213) — `git push`, `gh pr create/merge`, `gh release`, `gh api`, `git worktree remove/prune`, `linear-ops.mjs`, `publish-linear-comment.mjs`, `linear-query.mjs`. Folded do `child-settings.json` per-child (deny-only merge — można tylko dokręcić).
- **Env** — `LA_SUPERVISOR=1`, `LA_SUPERVISOR_RUN`, `LA_SUPERVISOR_CHILD`, `LA_TASK_ID`, `CLAUDE_CONFIG_DIR=agents/<squad>`.
- **Model** — `--model` lub inherited `ANTHROPIC_MODEL`.

### 3.2 Wyjście child

- **Tee** — JSONL w `.state/supervisor/<run>/children/<childId>.jsonl`. Pełny transcript. Detached watcher (`supervisor-watch.mjs`) owns liveness.
- **sessionId** — durable identity, `--resume` w followup. Bez tego child nie-resumable.
- **Gate record** — child emituje (`supervisor-gate.mjs emit`), kończy turn (`waiting_gate` = clean exit z otwartym pytaniem). Supervisor odpowiada (`answer` → `followup --gate`).
- **Status lifecycle** — starting → running → {exited, waiting_gate, crashed, stalled}.

### 3.3 Ocena: kontrakt jest mocno OS-process-bound

Worktree, tee (JSONL na dysku), detached watcher process, session resume (`--resume <sessionId>`), telemetry run-manifest — wszystko zakłada **żywy proces Claude Code z własnym stanem sesji**. To nie jest neutralny transport; to jest runtime z lifecycle, liveness, i crash-recovery opartym o procesy i pliki.

## 4. Prompty squad — monolityczność vs rozkładalność

### 4.1 Rozkład akcji per squad (z rekonesansu promptów)

| Squad | Ile akcji w jednym leadzie | Mix typów | Rozkładalność |
|---|---|---|---|
| **PLAN** | 7 (discovery + DoR + AC + spec + ADR + decompose + push) | extractive + generative + routing | ★★★★★ (AC/DoD extraction uwięzione w monolicie) |
| **REVIEW** | 4 (merge 3 passes + Conventional Comments + lint + AC mapping) | extractive + deterministyczna logika | ★★★★ (verdict drafting = naturalny drafter) |
| **TEST** | 3 (scenario-gen + runner + root-cause) | extractive + deterministyczna + comprehension | ★★★ (scenario-gen naturalny; root-cause nie) |
| **DEV** | 4 (recon → implement → commit → handoff) | extractive + agentic loop | ★★ (czysty, ale to full agent loop nie drafter) |
| **CADENCE** | 3 (collector → retro → digest) | deterministyczna + extractive + **generative** | ★ (digest jest generative z definicji) |
| **ORCHESTRATOR** | — | inny runtime (Atlas MCP) | n/a |

### 4.2 Kluczowe obserwacje

- **PLAN jest najbardziej monolityczny** — 7 akcji w jednym leadzie. AC extraction i DoR gate to **czyste extractive akcje** uwięzione w monolicie; to najsilniejszy kandydat na wydzielenie.
- **REVIEW verdict drafting** jest najbardziej rozkładalny, ale **merge-authority to logika 3 linii** (deep > security > first-pass), nie comprehension. MCP drafter dla merge-logiki to over-engineering; zwykły JS wystarczy. AC-to-evidence mapping = extractive. Fingerprint computation = czysto mechaniczne (już w `supervisor-verdict.mjs`).
- **CADENCE digest jest generative** — Polish prose z retro output. „Extractive digest" to oxymoron. To się nie nadaje na extractive MCP drafter.
- **DEV nie jest drafterem** — pisze kod w worktree, odpala testy, commituje. Pełna agent loop. Wizja poprawnie nie wymienia DEV jako kandydata MCP.

### 4.3 Napięcie: replace squad lead vs sub-role wewnątrz leadu

Wizja mówi „supervisor wywołuje MCP, za którym stoi osobny agent robiący izolowane akcje", ale **nie precyzuje relacji do squad leadów**. Dwie możliwe interpretacje, radykalnie różne:

- **(A) Drafter zastępuje sub-role wewnątrz leadu** — lead pozostaje, drafter = tańszy sub-agent. Ale delegacja wewnątrz leadu już działa (Task tool / `routing.<squad>.worker|flash`), jest 3-20× tańsza od leadu. Marginalny zysk.
- **(B) Drafter zastępuje squad lead entirely** — supervisor → MCP drafter bez pośrednictwa leadu. Radykalne: likwiduje 4 squady, eliminuje lead cost (43.5% — patrz §5). Ale wymaga przeniesienia całej logiki leadu (triage, routing, gate relay, loop) do supervisora lub MCP.

**Wizja tego nie rozstrzyga, a to zmienia wszystko.** Jeśli (A), zysk jest marginalny i FOC-283 (handoff compressor) pozostaje jedynym realnym leverem. Jeśli (B), to jest rewrite architektury, nie „pipeline za MCP".

### 4.4 Architectural conflict: dwa runtime'y orkiestracji

Repo ma **dwa równoległe systemy orkiestracji**:

1. **Supervisor frontman** — OS processes (`claude -p`), no subagents, file-based gates, worktree per child (ADR-0009).
2. **Orchestrator** — Atlas MCP bridge (`agent_spawn`×N, `agent_collect`), Flash→Pro→Sonnet→Opus drabina, inny runtime.

CLAUDE.md (project, sekcja `working_mode`) mówi „PLANUJESZ i delegujesz — sam NIE kodujesz ... Flash→Pro→Sonnet→Opus" — to jest **orchestrator-mode**, nie supervisor-mode. Te dwa runtime'y współistnieją i wizja MCP drafterów jest **bliżej orchestrator-pattern** (MCP bridge) niż supervisor-pattern (OS processes).

**Sceptyczna uwaga:** zanim buduje się MCP draftery, trzeba rozstrzygnąć, na którym runtime'u. Budowa na supervisor-spawn zachowuje gate/worktree/cleanup kontrakt. Budowa na Atlas-bridge używa istniejącego MCP mechanizmu ale traci file-based HITL. Wizja nie adresuje tego wyboru.

## 5. Dane telemetryczne — co mówią (i czego nie)

### 5.1 Skala i schema

Baza: `telemetry.sqlite` **708 MB**, 689 sesji, 227 036 usage_facts, 227 036 cost_facts, 102 106 tool_facts, 1451 delegation_links, 245 work_items, 15 repo. Runs by squad: dev 248, review 216, test 105, supervisor 81, plan 52, orch-ollama 15.

### 5.2 Cost per role — LEVER jest realny

| Miara | Wartość | Źródło |
|---|---|---|
| Lead (frontman) cost share | **43.5%** ($1,339 z $3,081 deduplikowanego corpusu) | `docs/research/telemetry-analysis-2026-09.md` §F2 |
| Lead vs dzieci | 2.5× wszystkie dzieci razem ($543) | j.t. |
| Pojedynczy line item | 5 turns na claude-opus-5 = $805 (26% corpusu) | j.t. |
| True corpus cost | ~$1,400 (figury $ są 2.19× wysokie, ale *share* proporcjonalne) | §F2 caveat |

Frontman = 43.5% kosztu, 2.5× wszystkie dzieci. **Lever jest realny** i zgodny z tym, co triage-doc i PRD FOC-359 deklarowały. Największy line item to Opus-5 (model routing, nie drafting — patrz §5.6). To wzmacnia uzasadnienie inwestycji, ale znaczy też, że MCP draftery muszą *redukować* lead cost, nie tylko *przenosić* go.

> **Uwaga metodyczna:** w rekonesansie telemetrycznym pojawiła się liczba „90.1% lead cost" — to był błąd: 90.1% to **exit-0 rate** (F1), nie cost share. Cost share frontmana to 43.5% (F2). Obie liczby pochodzą z tego samego raportu; tu skorygowane.

### 5.3 Context-call share — baseline REAL, ale volume NIE jest leverem

| Squad | Context-call share (re-derivation) | Źródło |
|---|---|---|
| plan | **50%** (najgorszy) | `context-attribution.mjs` |
| dev | 33% | j.t. |
| review | 27% (37% z git-diff) | j.t. |
| test | 27% | j.t. |

Triagedokument FOC-283 mówi baseline 27-33% — **potwierdzone w danych**. Źródła marnotrawstwa: 37% re-derive git state, 22% re-query Linear, 17% czyta pliki już nazwane w kickoffu.

**Krytyczna observacja:** Spearman kickoff-length vs re-derivation = **−0.01**. Objętość kickoffu **NIE jest leverem**. To znaczy:

- Handoff compressor, który tylko *skraca* handoff, **nie naprawi** re-derivation — bo długość nie koreluje z problemem.
- To, co naprawia, to **machine-templated pinned-state** (entry: FOC-286 shipped; exit: FOC-278b nie) — structured carried state, nie krótszy tekst.
- FOC-286 (entry prologue) już istnieje i usuwa ~30% first-turn context calls. **Exit-state schema (FOC-278b) jest blokerem dla FOC-283** — bo bez niej handoff-compressor kompresuje free-text (STATUS/ARTIFACTS/NEXT), nie structured state.

### 5.4 Pary handoff — danych więcej niż potrzeba

FOC-283 mówi „86 real pairs" (dev→review, review→test). Telemetria ma **157 par dev+review** i **114 par review+test** (zrekonstruowane przez JOIN `run_task_links` × `work_items` × `runs.squad`). 180 tasków ma runy w >1 squadzie. **Danych wystarczy na pilot z naddatkiem.**

### 5.5 Quality — mierzone nigdzie

> „System measures cost everywhere and quality nowhere."

- `delegation-outcomes.mjs` istnieje, łączy verdicty review z delegacjami, ale sygnał jest **sparse, większość UNKNOWN**.
- `delegation_links` ma `child_tokens`/`child_cost_usd` = **NULL** — delegacje są strukturalnie zapisane, ale **nie kostowane indywidualnie**.
- 17 subagent transcriptów re-readuje jeden plik >10× (max **703×**) — patologia delegacji, niewidoczna w main-session metrics.
- **Brak metryki extractive-vs-generative quality** — FOC-359 próbował (findings_f1=0.04), porażka.
- **Brak MCP-layer telemetry** — żaden `agent_key` nie jest „drafter", brak pomiaru round-trip MCP.
- **Brak metryki „czy izolowany model za MCP pomógł"** — bo MCP nie istnieje.

**Wniozek:** zanim zbuduje się draftera, trzeba zdefiniować §5 bar per drafter (jak FOC-359 miał schema 100% AND macro F1 ≥ 0.80). Bez tego „czy MCP pomogło" mierzymy tylko cost + context-call share — a cost można przenieść bez poprawy.

### 5.6 Failures — infrastructure-first, nie prompt-first

Telemetry pokazuje że **22/38 bad turns = provider-side** (API 402, model outage, rate limit). Tylko ~16/38 to prompt/behavior. **Więcej izolowanych modeli za MCP = więcej integration points = więcej failure modes** tam gdzie problem jest już dziś infrastructuralny.

## 6. Lessons z FOC-359

### 6.1 Co zawiodło (3 warstwy)

| Warstwa | Problem | xgrammar fix? |
|---|---|---|
| 1. Severity enum | halucynacja `blocker`/`blocking`/`nitpick` | ✅ **Tak** (41% → 91% schema) |
| 2. Finding text | nie reprodukuje gold (TP=11/164), generuje własne | ❌ **Nie** — gwarantuje shape, nie content |
| 3. Empty findings dla pass | over-applies „pass ⇒ no findings" | ❌ Nie — pusta lista jest poprawna |

**Root cause:** comprehension/extraction, nie decoding. 4B reader-model **fundamentalnie generuje, nie ekstraktuje**. Skalowanie do 1000+ par → estymowane findings_f1 ≈ 0.20-0.30, nadal < 0.80. 40-char gold nie pomógł — model generuje własny tekst regardless of gold length.

### 6.2 Salvageable (Stage A)

xgrammar constrained-decoding harness (`eval.py`, `prompt.py`, `export-dataset.mjs`) — **deployable niezależnie od 4B adaptera**. Future verdict-drafter z API modelem reuse'uje schema + harness: API model supplies comprehension, xgrammar gwarantuje schema.

### 6.3 Sprzeczność: PRD FOC-359 vs wizja

PRD FOC-359 §2 non-goals mówi: **„one adapter, three read-outs"** (verdict / DoD / loop-restart classifier — pass/fail to verdict field, DoD maps to acMapping). Wizja mówi: **„każdy model jedną rzecz, nie multi-task w jednym adapterze"**. To są **sprzeczne zasady**. PRD uzasadniał jeden adapter trzema read-outami ekonomicznością; wizja odrzuca to po lessons. **Napięcie do rozstrzygnięcia zanim powstanie pierwszy drafter.**

### 6.4 Napięcie nierozwiązane: API model vs FT model

Wizja: „API model supplies comprehension, xgrammar gwarantuje schema." Ale:

- **Frontier API modeli (Claude, GPT) mają native tool-use / structured output** — czy *potrzebują* xgrammar? xgrammar jest dla modeli **BEZ** native structured output (open-weights).
- Dla API modela, tool-use już daje schema validity. xgrammar harness jest **wartościowy dla open-weights** (taniej), ale wtedy wracasz do **comprehension gap** (FOC-359).
- **Dwa różne światy:** drogi API z native structured output (xgrammar niepotrzebny, comprehension OK) vs tanie open-weights z xgrammar (schema OK, comprehension gap). Wizja ich nie rozróżnia.

## 7. Ocena MCP-readiness

### 7.1 Co REALNIE pasuje do MCP

| Element | Dlaczego | Status |
|---|---|---|
| Draftery (DoD, AC, verdict, handoff) | extractive single-action, structured input→output, nie potrzebuje worktree/tee/session | perfeito MCP tool call |
| Schema-gated output | xgrammar proven (FOC-359 Stage A) | reusable harness |
| HITL gate | już structured record (emit/answer), separacja child/supervisor istnieje | MCP-friendly |
| Permission surface | MCP exposes exactly declared tools — nie deny-list | real win dla drafterów |

### 7.2 Co jest TRUDNE (nie „inny transport")

1. **Session resume / review loop.** dev↔review loop zależy od `--resume <sessionId>` — tej samej sesji Claude z findings. MCP drafter jest **stateless** — każde wywołanie fresh context. Progress fingerprint chroni przed repeated rounds, ale **LOOP sam w sobie** potrzebuje session continuity ALBO handoffu niosącego wystarczająco stanu. **To jest dokładnie FOC-283 — i jest blocked.**
2. **Frontman cost = kontekst, nie drafting.** MCP drafter biorący pełny run context jako input = **move cost, nie reduce**. Handoff compressor (FOC-283) jest actual cost lever — shrinks what frontman carries. Bez niego draftery tylko przenoszą.
3. **xgrammar = Python; supervisor = Node.** FOC-359 harness to Python (peft/trl/xgrammar). MCP server wrap API + xgrammar = Python MCP server ALBO Node calling Python constrained-decoding service. `.mcp.json` ma dziś stdio `codegraph`. Cross-language OK, ale **constrained-decoding service = nowy runtime component** z własnym failure mode.
4. **Telemetry metering.** Per-child telemetry runs z manifest, telemetry-hook. MCP tool calls nie niosą tego naturalnie. Cost ledger musiałby meterować MCP osobno — a dzisiaj `delegation_links` ma NULL cost nawet dla istniejącej delegacji.
5. **API vs FT napięcie** (§6.4) — nierozwiązane.

### 7.3 Co jest „inny transport" (mechaniczne)

- Gate record → MCP tool schema (mechaniczne mapowanie)
- Pinned-state entry prologue → structured tool arguments (mechaniczne; exit-state FOC-278b wymaga designu)
- Deny-list → MCP permission surface (dla drafterów)
- Verdict schema guards → formal JSON Schema (mechaniczne, ale pracy jest — dzisiaj to code guards w `supervisor-verdict.mjs:90-105`, nie formalny JSON Schema)

### 7.4 Pinned-state: entry (FOC-278/FOC-286) istnieje, exit-state NIE

- **FOC-278 (entry pinned-state) = FOC-286 = SHIPPED** (2026-09-11, main 3859c86). FOC-272 review §6 zdefiniowało go jako „mandatory machine-templated kickoff prologue" (9 pól: repo, worktree, branch, baseRevision, clean-at-spawn, issue, run, spawn-verified, pre-authorized, known-quirks). `supervisor-pinned-state.test.mjs` testuje `pinnedStatePrologue()` + `verifyPinnedState()` (4 checks at spawn, refuse = no partial spawn) + byte-identical rebuild. Usuwa ~30% first-turn context calls (telemetry: 37% sesji re-derives git state). **Triage-doc linia „schema FOC-278 nie istnieje" jest w tym sensie stale** — entry-state istnieje i jest verify-at-spawn.
- **ALE: FOC-283 (handoff compressor) potrzebuje EXIT-state schema, nie entry-state.** Entry = co dziecko dostaje na starcie (FOC-286, istnieje). Exit = co dziecko zwraca na końcu turnu (changed files, commit SHA, test tail, open questions, artifacts). **Exit-state NIE istnieje jako schema** — jest free-text w bloku STATUS/ARTIFACTS/NEXT, który lead pisze prose'em.
- **To jest rzeczywisty bloker dla FOC-283**, nie entry-state. Handoff-compressor musi skompresować *co dziecko zwraca* (exit), nie *co dostało* (entry). Bez exit-state schema, compressor kompresuje free-text → wracamy do problemu FOC-359 (generuje zamiast ekstraktować z ustrukturyzowanego wejścia).
- **Konkluzja:** triage-doc ma rację że FOC-283 jest blocked, ale bloker to **exit-state schema** (nazwijmy FOC-278b — symetryczna do entry prologue FOC-286), nie entry-state. Entry jest done; exit nie.

## 8. Rozkładalność per drafter (sceptyczna tabela)

| Proponowany drafter | Źródło | Typ | Naturalność | Sceptyczna uwaga |
|---|---|---|---|---|
| **ac-drafter** | PLAN: DoR/AC extraction | extractive | ★★★★★ | Czysta ekstrakcja z issue body → JSON. Najmniej ryzykowny. Schema trywialna. |
| **scenario-drafter** | TEST: scenario-gen | extractive | ★★★★ | AC → observable scenarios. Schema-gated. |
| **dod-drafter** | PLAN: spec/DoD | extractive+light-gen | ★★★★ | DoD z briefu — częściowo generative. Schema-gated możliwe. |
| **verdict-drafter** | REVIEW: verdict step | extractive | ★★★★ | Merge 3 passes + AC mapping = extractive. **Ale:** merge-authority to reguła, nie LLM; over-engineering jeśli passes już zwracają structured findings. FOC-359 pokazał comprehension gap. |
| **handoff-compressor** | DEV/REVIEW: handoff | extractive | ★★★★ | FOC-283. **Ale:** dzisiejszy handoff to 3-bullet deterministic summary. Compresja ma sens tylko jeśli context-call ból jest realny (jest: 27-50%) — ale **volume nie koreluje** (Spearman −0.01), więc musi compressować *structured exit-state* (FOC-278b), nie tekst. |
| **spec-drafter** | PLAN: spec role | generative | ★★ | Spec = generative z briefu. Nie extractive. Ryzykowne (FOC-359 lesson). |
| **root-cause-drafter** | TEST: root_cause | comprehension | ★★ | Wymaga reasoning, nie extraction. API-model, nie 4B. Nie „drafter" — diagnosta. |
| **digest-drafter** | CADENCE: digest | generative | ★ | Polish prose = generative. Nie nadaje się na extractive MCP. |

**Gdzie prompt miesza akcje (multi-task):** PLAN (7 akcji), REVIEW verdict step (merge + AC + lint + fingerprint), TEST (3 kategorie). Wizja zasada 3 („nie multi-task") jest słuszna, ale **ROPZĄDANIE monolitów wymaga decyzji (A) vs (B)** z §4.3 — bez tego wydzielenie jest sztuczne.

**Gdzie wydzielenie byłoby sztuczne:** DEV brief-contract (już precyzyjny 5-part), REVIEW merge-authority (3 linie reguły), CADENCE digest (generative), ORCHESTRATOR (inny runtime).

## 9. Napięcia i kontrargumenty (sceptyczne)

### 9.1 Wizja zakłada, że izolacja pomoże — dane tego nie potwierdzają

Telemetria pokazuje **lever** (43.5% cost na leadzie, 27-50% context-call share), ale **nie potwierdza, że izolacja pomoże**:

- 27-33% re-derivation jest **niezależne od kickoff length** (Spearman −0.01). Mniejszy model za MCP tego nie naprawi — **machine-templated pinned-state tak** (entry FOC-286 shipped; exit FOC-278b nie).
- Failures są **infrastructure-first** (22/38 bad turns = provider-side). Więcej integration points = więcej failure modes.
- Quality nie jest mierzona. „Czy MCP pomogło" mierzymy tylko cost + context-call share, nie quality downstream.

### 9.2 Bez handoff-compressora draftery tylko przenoszą cost

MCP drafter biorący pełny run context jako input = move cost, nie reduce. **FOC-283 (handoff compressor) jest linchpinem** — shrinks what frontman carries. Bez niego:

- verdict-drafter: frontman i tak czyta review (context), żeby zatwierdzić draft. Zysk = drafting speed, nie context reduction.
- ac-drafter / dod-drafter: tylko PLAN squad (52 runs, 7% corpus). Marginalny lever vs 43.5% lead cost.

**Sekwencja z triage-doc (stabilizacja → FOC-278 → FOC-283 → draftery) jest poprawna** i dane jej nie podważają — wręcz ją wzmacniają (FOC-283 linchpin).

### 9.3 Sprzeczność „one adapter, three read-outs" vs „jeden model jedną rzecz"

PRD FOC-359 (signed off) mówi jeden adapter, trzy read-outy. Wizja mówi jeden model jedną rzecz. **Napięcie do rozstrzygnięcia.** Jeśli wygrywa „jeden model jedną rzecz", każdy drafter to osobny PRD + pilot + §5 bar — to jest 4-6 pilotów, nie jeden. Koszt rośnie.

### 9.4 Dwa runtime'y, jeden wybór nierozstrzygnięty

Supervisor (OS processes) vs orchestrator (Atlas MCP). Wizja MCP jest bliżej orchestrator-pattern, ale ADR-0009 (supervisor) jest status Proposed i nie jest withdrawn. **Zanim buduje się MCP draftery, trzeba zdecydować runtime.**

### 9.5 xgrammar dla API modela — niepotrzebny?

Frontier API modeli mają native structured output. xgrammar jest dla open-weights. Jeśli drafter = API model, xgrammar harness (Stage A z FOC-359) jest **niepotrzebny** — tool-use wystarczy. Jeśli drafter = open-weights, xgrammar jest potrzebny ale wracasz do comprehension gap. **Wizja nie mówi, który.**

## 10. Rekomendacje

### 10.1 Co jest spójne i poprawne

- **Sekwencja** (stabilizacja done → FOC-278 → FOC-283 → draftery → FOC-103) — poprawna, dane wzmacniają.
- **FOC-283 jako linchpin** — poprawne. Bez handoff-compressora draftery nie redukują cost.
- **Extractive framing** — poprawny lesson z FOC-359.
- **HITL (gate kontrakt)** — już MCP-friendly, poprawny.

### 10.2 Co wymaga rozstrzygnięcia przed budową

1. **Interpretacja (A) vs (B)** (§4.3) — drafter zastępuje sub-role czy squad lead? To decyduje czy to inkrementalna zmiana czy rewrite architektury.
2. **Runtime** — supervisor-spawn (OS processes, file gates) czy Atlas-bridge (MCP native)? Wizja nie adresuje.
3. **API model vs open-weights** per drafter — decyduje czy xgrammar jest potrzebny. ac-drafter może być API (comprehension OK, schema trywialna). verdict-drafter był FT (comprehension gap).
4. **„Jeden model jedną rzecz" vs „one adapter, three read-outs"** — rozstrzygnąć sprzeczność §9.3.
5. **§5 bar per drafter** — zanim budowa. FOC-359 miał schema 100% AND macro F1 ≥ 0.80. Każdy drafter potrzebuje własnego baru, inaczej „czy pomogło" jest niemierzalne.

### 10.3 Kolejność sugerowana (konsyserwatywna)

1. **FOC-278b** (exit-state schema) — bloker dla FOC-283. Entry-state (FOC-278/FOC-286) istnieje (verify-at-spawn, 10-field prologue). **Exit-state NIE** — co dziecko zwraca (changed files, commit, test tail, open questions) jest free-text w STATUS/ARTIFACTS/NEXT. Design: symetryczna machine-templated schema do entry prologue.
2. **FOC-283** (handoff compressor, extractive) — pilot na 157 par dev+review. **Metryka: context-call share downstream vs baseline 27-33%, NIE tekstowa.** §5 bar: context-call share redukcja ≥ X% bez quality regression (quality wymaga metryki — patrz §5.5).
3. **ac-drafter** (pierwszy MCP drafter, najmniej ryzykowny) — extractive, schema trywialna, API model wystarczy. Tu rozstrzygnąć (A) vs (B).
4. **verdict-drafter** — tylko po udowodnieniu, że ac-drafter za MCP redukuje cost/przyśpiesza bez quality loss. Stage A xgrammar harness reuse tylko jeśli open-weights; jeśli API, tool-use.
5. **FOC-103** (UI graph) — widoczność całego pipeline'a, ostatni.

### 10.4 Czego NIE robić

- **Nie budować digest-draftera** (generative, nie extractive).
- **Nie budować spec-draftera** jako extractive (jest generative).
- **Nie budować root-cause-draftera** jako drafter (to diagnosta, reasoning).
- **Nie budować merge-authority jako LLM** (to 3 linie JS).
- **Nie podnosić MCP drafterów przed FOC-278b + FOC-283** — przeniosą cost, nie zredukują.
- **Nie mierzyć sukcesu tylko cost + context-call share** — bez quality baru to niemierzalne (§5.5).

## 11. Otwarte pytania do Mateusza

1. **(A) vs (B)?** Drafter zastępuje sub-role w squad leadzie (inkrementalne, marginalny zysk) czy squad lead entirely (radykalne, likwiduje 4 squady)?
2. **Runtime?** Budować na supervisor-spawn (file gates, worktree, ADR-0009) czy Atlas-bridge (MCP native, orchestrator-pattern)?
3. **API vs open-weights per drafter?** ac-drafter API (xgrammar niepotrzebny) czy open-weights (xgrammar + comprehension gap)?
4. **„Jeden model jedną rzecz" vs PRD FOC-359 „one adapter, three read-outs"?** Rozstrzygnąć sprzeczność — to decyduje czy 1 pilot czy 4-6.
5. **Quality bar?** Jak mierzyć „czy drafter pomógł" — cost + context-call share + ? (dzisiaj quality = UNKNOWN).

---

*Analiza oparta na: 3 równoległych rekonesansach (prompty squad, telemetria, core impl), ADR-0009, brainstorm-graph-engineering, FOC-359 abandon report + explainer + PRD, `config/models.json`, `.mcp.json`. Pełne dane telemetryczne w `docs/research/telemetry-analysis-2026-09.md` §B2/F2.*
