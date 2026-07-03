---
type: spec
status: draft
audience: Mateusz (approval) → GLM (build)
tags: [type/spec, area/ui, topic/monitoring, topic/linear, topic/telemetry]
created: 2026-06-26
maturity: spec-v1
---

# Spec — Agent monitoring + Linear collaboration (kokpit)

> Doprecyzowuje części **Dashboard / Agents / Costs** z `docs/ui/ux-design.md` o **konkretny kontrakt
> telemetrii**. Rozszerza `0_linear` (Next.js). Gantt = osobny, niższy priorytet (`../prd/gantt-panel-prd.md`).
> Dwa filary: **(A) monitoring agentów**, **(B) współpraca z Linearem**. Fundament obu = telemetria runów.

## 0. Najważniejsze (czytaj najpierw)
Dziś agenci biegną jako lokalne sesje Claude Code z `bin\*.bat` i **nie emitują ustrukturyzowanych zdarzeń**.
`agents/*/settings.json` nie ma `hooks`. Więc **nie da się nic monitorować, dopóki nie powstanie telemetria**.
To jest M1 i fundament całej reszty. Wzorzec: **file-based, jak snapshot** (zero serwera) — UI tail-uje pliki.

## 1. Fundament — telemetria runów agentów (M1)
**Mechanizm: Claude Code `hooks` → append JSONL do `.state/runs/<run-id>.jsonl`.**
- `bin\_lib.bat` generuje `RUN_ID` (np. `<area>-<ts>`) i eksportuje + zna `AREA/ROLE/MODEL/PROJECT/BASIS`.
- W `agents/<area>/settings.json` dodać `hooks`:
  - `SessionStart` → zapis zdarzenia `run_start` (run-id, area, role, model, project, basis, ts).
  - `PreToolUse`/`PostToolUse` → `step` (tool, krótki target, ts) — to jest „co agent teraz robi".
  - `SubagentStop` → `subagent_done` (name, model).
  - `Stop` → `run_end` (status, ts).
- Hook = jednolinijkowy skrypt `scripts/telemetry.mjs --event …` (append atomic do pliku run-a).
- **Status runa** wnioskowany: ostatnie `run_end`; brak zdarzeń > N min = `stuck`; `.state/over-budget.json` = `over-budget`; Linear label `escalated` = `escalated`.

**Schemat zdarzenia (JSONL):**
```json
{"run":"plan-1719400000","ts":"…","ev":"step","area":"plan","role":"decomposer","model":"minimax/minimax-m3","tool":"Write","target":"planning/briefs/plan_roast-app.json"}
```

**Cost per-agent (otwarta decyzja — patrz §6):** albo OpenRouter `X-Title`/app-name per agent (activity API grupuje per app), albo lokalny licznik tokenów w hooku `Stop`. Dziś `cost-report.mjs` daje koszt **per-model** (nie per-agent).

## 2. Filar A — Monitoring agentów
- **Live agents** *(home monitoringu)*: kto biegnie TERAZ — area/role · model · aktualny krok (ostatni tool) · elapsed · tokeny/koszt (jeśli dostępne) · peek do logu · `Stop`.
- **Run history / timeline**: przeszłe runy — outcome (done / escalated / over-budget / stuck / fail), czas trwania, koszt, link do issue Linear + briefu/artefaktu.
- **Drilldown runa**: pełny strumień zdarzeń (tool-by-tool), artefakty (brief JSON, branch, ADR, FEN-x), rozbicie kosztu, model per subagent.
- **Alerty/health**: over-budget (`.state/over-budget.json`), escalated (Linear), stuck (brak zdarzeń), failed. Badge na nawigacji gdy >0.
- **Fleet overview**: 5 eskadr — status (idle/running) + dziś: liczba runów, tokeny, koszt, success rate.

## 3. Filar B — Współpraca z Linearem
- **HITL inbox** *(rdzeń współpracy — Ty jako sędzia)*: `needs:answer / needs:approval / needs:decision` → akcje inline z **write-backiem**: ustaw/zdejmij labelkę + komentarz przez GraphQL. (W trybie interaktywnym REPL agent czeka inline; inbox obsługuje tryb async/headless `@flow`.)
- **Issue views**: szybki board/lista ze **snapshotu na dysku** (instant) + detal taska (opis, komentarze, labelki, relacje `blocked by`, parent/sub), „otwórz w Linear".
- **Planning bridge**: podgląd epików utworzonych przez PLAN (FEN-x) z proweniencją (`ai:planned`, link do briefu); ewentualny trigger push (po HITL).
- **Label/state sync**: status `bootstrap-linear.mjs` + **drift** między `config/linear/*` a żywym Linearem (czego brakuje / co nadmiarowe).
- **Bezpieczeństwo write-backu**: domyślnie read-mostly; każda mutacja jawna, potwierdzana, **logowana do `.state/runs`** (audyt kto/co zmienił z UI).

## 4. Architektura danych
Rozszerzenie `0_linear` (Next.js + `@linear/sdk`). API routes (file-based + GraphQL):
| Route | Źródło | Rola |
|---|---|---|
| `GET /api/runs` | tail `.state/runs/*.jsonl` | live + history monitoringu |
| `GET /api/issues` | **snapshot na dysku** + refresh GraphQL | szybkie widoki Linear (wzorzec gantt-pisi) |
| `GET /api/cost` | `node scripts/cost-report.mjs --json` | koszt (per-model dziś, per-agent po §6) |
| `POST /api/linear/mutate` | GraphQL (LINEAR_API_KEY) | write-back (labelki/komentarz/state) |

**Standaryzacja:** Linear przez **GraphQL + LINEAR_API_KEY** (headless-safe). `agents/*/settings.json` wciąż mają `mcpServers.linear` (mcp.linear.app/sse) — niedziałające headless (STATE.md T-C2) → **usunąć/oznaczyć jako local-only** dla spójności.

## 5. Fazy + Acceptance
- **M1 — Telemetria + Live agents** *(fundament; rób pierwsze).* AC: odpalenie `bin\plan.bat` produkuje `.state/runs/<id>.jsonl` ze `step`-ami; UI „Live agents" pokazuje area/role/model/aktualny krok na żywo (poll).
- **M2 — HITL inbox + write-back.** AC: task z `needs:approval` widoczny w inbox; klik „Approve" zdejmuje labelkę + dodaje komentarz w Linear (zweryfikowane na FEN); akcja zalogowana.
- **M3 — Run history + drilldown + alerty.** AC: lista runów z outcome/koszt/czas; drilldown pokazuje strumień zdarzeń + artefakty; badge alertu przy over-budget/escalated/stuck.
- **M4 — Cost per-agent + fleet overview.** AC: koszt rozbity per area/role (mechanizm z §6); kafelki 5 eskadr z dziś-koszt/runy/success.
- **M5 — Issue views + planning bridge + label/state sync.** AC: board/detal ze snapshotu (instant); drift labelek vs Linear; podgląd FEN-x z linkiem do briefu.

## 6. Otwarte decyzje (do potwierdzenia przez Mateusza)
1. **Cost per-agent:** OpenRouter `X-Title` per agent (czy Claude Code to przepuszcza?) vs lokalny licznik tokenów w hooku. Determinuje M4.
2. **Live update:** polling 2–5 s (proste, MVP) vs file-watch/SSE (płynniejsze, więcej kodu). Rekomendacja: polling w MVP.
3. **Czy UI też SPAWNuje** agentów (Faza G), czy na razie tylko **monitoruje + arbitraż** lokalnych runów? Rekomendacja: monitoring+collab najpierw, spawn (VM) potem.
4. **MCP-linear vs GraphQL:** ujednolicić na GraphQL (usunąć MCP z agent settings) — potwierdź.
5. **Retencja `.state/runs`:** ile dni / ile runów trzymać (rotacja).

## 7. P0 / safety
Read-mostly default · write-back jawny + potwierdzany + logowany · zero sekretów w kliencie (klucze z `.env`, czytane przez API route) · cost kill-switch już jest (`cost-guard.mjs`).
