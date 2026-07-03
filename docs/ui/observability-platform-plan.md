---
type: implementation-plan
status: draft
audience: Mateusz (approval) → GLM (build)
tags: [type/plan, area/ui, topic/observability, topic/cost, topic/telemetry]
created: 2026-07-01
maturity: plan-v1
---

# Observability & Cost Platform — plan implementacji

> Kamień milowy: squady dowiozły realny task end-to-end (**PISI-98**) w osobnych terminalach/sesjach.
> Ból: wszystko klikane ręcznie, rozsypane po terminalach. Platforma = **jedno miejsce** do obserwacji
> agentów + kosztów. **Dobra wiadomość: backend telemetryczny już istnieje — brakuje głównie UI.**

## 0. Stan obecny (co JUŻ działa — budujemy na tym, nie ruszamy)
- **`bin/_lib.bat`** generuje `RUN_ID` (+`LA_RUN_ID`) i woła `run-manifest.mjs start` → zapis `.state/runs/<runId>.json`.
- **`scripts/run-manifest.mjs`** — manifest runa (squad, taskId, startedAt/endedAt, cwd, gitBranch, native, exitCode) + na `end` **odkrywa transkrypt sesji Claude Code** (`sessionId`/`transcriptPath`) po oknie czasu.
- **`scripts/ledger.mjs`** — parsuje transkrypt (`.jsonl`, per-turn usage: input/output/cache, model, `attributionAgent`), liczy koszt z `config/models.json` pricing i agreguje: `totals`, `byModel`, **`byAgent`**, `aggregateByTask` (taskId z brancha, np. PISI-98). `scanRuns()` / `liveRuns()`. → **rozwiązuje koszt per-agent I per-task** (to był mój „hard unknown").
- **`scripts/telemetry-server.mjs`** — HTTP API (port 7331): `/api/runs`, `/api/runs/:id`, `/api/summary` (totals · bySquad · byModel · byDay), `/api/live`. CORS.
- Plus: `cost-report.mjs` (OpenRouter Activity — koszt per-model, autorytatywny $), `cost-guard.mjs` + `.state/over-budget.json`, `publish-linear-comment.mjs` (tagowane run-id), `linear-query/ops`.
- **File-based ⇒ działa cross-terminal/sesja** — dokładnie leczy Twój ból.

**Wniosek: brakuje (a) FRONTENDU (dashboard) i (b) kilku małych endpointów. Reszta jest.**

## 1. Cel platformy
Dashboard konsumujący `telemetry-server`: **obserwacja** runów (live + historia + drilldown) i **koszty**
(per squad / model / agent / task / dzień) + budżet/alerty. Potem warstwa Linear-collab.

## 2. Architektura — decyzja
- **A) Standalone dashboard** (lekki Vite+React w `ui/`, fetch z `:7331`) — izolowany, spójny z file-based, szybki MVP. **Rekomendacja.**
- **B) Zakładka w `0_linear`** (Next.js) — więcej integracji z widokami Linear, ale sprzęga dwa światy.
→ **A na MVP** (port do 0_linear później, gdy dojdzie warstwa Linear-collab).

Komentarz: Tutaj chodzi o to że mamy już część czegoś zrobione w Linearze ale też bardzo mi się podoba wizualizacja Gantt Chartu w innej aplikacji która też ma zastosowane jakieś fajne inne funkcje które pozwalają na data persistence. Fajna jest integracja z Linearem. Fajne jest też klastrowanie i tak dalej jest dużo ciekawych Feature'ów w obydwóch więc można je obydwa wziąć pod uwagę. Wybierając robiąc design takiego jednego konkretnego nowego UX w którym jest jeden Gantt Chart. Do tego chcę mieć monitoring agentów. No jakiś taki panel główny w którym widzę które taski obecnie są na rozpatrywane przez różnych agentów który agent nad czym pracuje No i też ważne jest to że ci agenci mogą pracować z zupełnie różnych repo więc to też trzeba wziąć pod uwage 

## 3. Gaps do dobudowania w backendzie (małe — ledger już to umie)
> **Update 2026-07-02:** `byTask` w `/api/summary` i `/api/cost-per-task` JUŻ SĄ w telemetry-server —
> nie budować drugi raz. Sumaryczne `byAgent` liczy się client-side z `/api/runs`.
> Aktualna lista gapów: **B1/B2/B3 w [ux-design-v3.md](ux-design-v3.md) §4** (B1 = passthrough
> `cwd/repo/gitBranch/exitCode/native/transcriptPath` w `aggregateRun` — wymagane dla multi-repo i statusu `failed`).
- ~~**`/api/tasks`** — wystaw `aggregateByTask(scanRuns())`~~ ✅ jest jako `/api/cost-per-task` + `byTask` w summary.
- ~~**`/api/summary` +`byAgent`**~~ → client-side z `/api/runs` (zero backendu).
- **`/api/budget`** — over-budget z `.state/over-budget.json` + taski > `COST_BUDGET_USD_PER_TASK` (z aggregateByTask). *(= B2)*
- **`/api/live` +krok** — dla aktywnych runów dołóż „ostatni tool/model" (ogon transkryptu) → „co agent robi TERAZ". *(= B3, P3)*
- (opcja) npm script / launcher startujący `telemetry-server` razem z dashboardem.

## 4. Dashboard — ekrany (główna praca = frontend)
1. **Live** *(home)* — aktywne runy: squad · task · model · ostatni krok · elapsed · koszt-do-teraz. Auto-poll 3–5 s z `/api/live`.
2. **Runs** *(historia)* — tabela: czas · squad · task · status · koszt · tokeny · model-mix (`/api/runs`); klik → **drilldown** (`/api/runs/:id`): breakdown per-agent/model, link do transkryptu, artefakty z `.state/runs/<id>/`, `ambiguous` badge gdy `sessionAmbiguous`.
3. **Costs** — `/api/summary`: totals + wykresy koszt per squad / per model / per dzień; **top tasks per koszt** (`/api/tasks`).
4. **Budget & alerts** — over-budget, taski > budżet, stuck (endedAt null > N min), escalated (z Linear label).
5. *(Faza 2)* **Linear** — HITL inbox + issue views przez `linear-query/ops` (write-back approve/answer).

## 5. Fazy + Acceptance
- **P1 — Dashboard MVP (Live + Runs + Costs)** na ISTNIEJĄCYM API. AC: `node scripts/telemetry-server.mjs` + dashboard pokazuje realne runy z `.state/runs` (masz już kilkanaście), koszt per squad/model/dzień, drilldown per run. **Zero zmian w backendzie poza uruchomieniem.**
- **P2 — Backend gaps** (`/api/tasks`, `byAgent`, `/api/budget`). AC: widok kosztu per-task (PISI-98) + alerty budżetu.
- **P3 — Live step feed** (tail transkryptu live). AC: Live pokazuje bieżący tool/model aktywnego agenta.
- **P4 — Linear collab layer** (HITL inbox + write-back). AC: approve/answer z dashboardu → mutacja w Linear (FEN/PISI), zalogowana.
- **P5 — UX polish** (estetyka Apple-minimal, auto-start serwera, retencja `.state/runs`).

## 6. Otwarte decyzje (małe)
1. **Standalone (A) vs 0_linear tab (B)?** → rekomendacja A.
2. **Stack:** Vite+React (lekko, standalone) vs Next (jak 0_linear)? → Vite dla MVP.
3. **Live:** poll (prosto) vs SSE/file-watch (płynnie)? → poll MVP.
4. **Retencja** run-manifestów/transkryptów (rotacja po N dni/runów)?
5. **Koszt:** ledger (transcript, per-agent) jako primary; `cost-report.mjs` (OpenRouter Activity) jako **reconciliation** (czy nasz liczony $ zgadza się z billowanym) — czy dodajemy cross-check w Costs?

## 7. Ryzyka / uwagi (rola planisty — nazywam)
- **Transcript discovery jest heurystyczne** (birthtime/content window) — flaga `sessionAmbiguous` istnieje; UI MUSI ją pokazywać, bo inaczej koszt może być przypisany do złego runa.
- **Pricing statyczny** (`config/models.json`) → dryf vs realny OpenRouter; stąd reconcile z `cost-report` (decyzja §6.5).
- **Live „step"** wymaga tailowania rosnącego pliku transkryptu — wykonalne, ale to P3, nie MVP.
- **Bez sekretów w UI** — dashboard tylko czyta `.state`/API lokalnie; klucze zostają w `.env`.

## 8. Następny krok
~~Rozbić **P1 (Dashboard MVP)** na taski dla GLM~~ ✅ **P1 scaffold DOWIEZIONY** (commit `e849ff0`:
Vite+React w `ui/`, ekrany Live/Runs/RunDetail/Costs na żywym API) — decyzja §2 = **A (standalone)**, przesądzona.

**Aktualny kontrakt budowy: [ux-design-v3.md](ux-design-v3.md)** — user journeys, wireframe per ekran,
nowy ekran **Timeline (gantt aktywności agentów)**, wymiar multi-repo, backend gap B1/B2/B3,
kolejność F1→F5 z acceptance criteria. Mockup klikalny: `mockups/observability-v3.html`.

**Warstwa 2 (launch z UI, VM/tmux, meta-agent): [control-plane-plan.md](control-plane-plan.md)** —
ekran Tasks z „suggested next agent" + `/api/launch`, tryb remote-interactive w tmux, fazy L1–L4.
