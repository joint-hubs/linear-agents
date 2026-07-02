# JOI-51 — Observability & Control-plane — dekompozycja (children JOI-51)

## Context
Squady dowiozły realny task end-to-end, ale operacja jest ręczna i rozsypana po terminalach.
JOI-51 domyka **jedno miejsce** do obserwacji agentów + kosztów oraz warstwę control-plane
(klik na taska → agent startuje z gotowym promptem). Backend telemetrii (`telemetry-server` :7331,
`ledger.mjs`) i scaffold `ui/` **już istnieją** — rozszerzamy, nie przebudowujemy.

Kontrakt budowy jest gotowy i autorytatywny:
- `docs/ui/observability-platform-plan.md` — plan/fazy P1–P5.
- `docs/ui/ux-design-v3.md` — **build contract** (F1–F5 + gap B1–B3, §6 = build order z AC).
- `docs/ui/control-plane-plan.md` — L1 (buildujemy), L2–L4 (parked/blocked).
- Mockup: `docs/ui/mockups/observability-v3.html`.

To zadanie = **dekompozycja na children JOI-51**, nie nowy design. Bez tworzenia epica.

## Decyzje Mateusza (GATE 1 ✅)
- **Q1 — workspace:** jeden workspace **jointhubs**; JOI i FEN w nim, ten sam `LINEAR_API_KEY`.
  Prefix JOI = `https://linear.app/jointhubs/issue/`. Regex `inferTaskIdFromBranch` → `(fen|pisi|joi)`.
- **Q2 — L1:** buildujemy TERAZ (to jest właśnie „klik→agent z promptem"). `blocked` tylko L2+.
- **Q3 — launch:** pełny **auto-inject** — spawn okna + gotowy prompt, ZERO wklejania.
  Nadpisuje trade-off „kickoff do schowka" z control-plane §3.3.
- **Q4 — granularność:** L1 rozbite na 3 slices.
- **Q5 — F5+budżet:** razem, w tym samym batchu.

## Metadane wspólne (każdy subtask)
Parent: **JOI-51** · team **JOI** · status **Todo** · label **dor-ok**, **ai:planned** ·
`type:*` per task · Estimate (t-shirt) · Initiative: obserwowalność+control-plane.
DoD wspólny (z ux-v3 §6): działa na **realnych** `.state/runs` (nie fixtures),
`npm run build` czysty, screenshot w PR, zero błędów w konsoli; zmiany backendu additive + `--smoke` przechodzi.

---

## Slices (9 children)

### Warstwa obserwowalności (F1–F5)

**s1 · F1-backend: B1 passthrough + status `failed` + regex JOI** — `type:feat` · **S**
- Pliki: `scripts/ledger.mjs` (`aggregateRun` ~L347, `inferTaskIdFromBranch` L116), `--smoke`.
- Zakres: do wyniku `aggregateRun` dołóż passthrough `cwd`, `repo` (last segment `cwd`),
  `gitBranch`, `exitCode`, `native`, `sessionId`, `transcriptPath`, `claudeConfigDir`;
  rozszerz `status` o `"failed"` (`endedAt && exitCode >= 1`). Regex → `(fen|pisi|joi)`.
- AC:
  - given manifest z `exitCode:1` i `endedAt`, when `aggregateRun`, then `status="failed"`.
  - given branch `feat/joi-51`, when `inferTaskIdFromBranch`, then `"JOI-51"` (FEN/PISI bez regresji).
  - given dowolny manifest, when `aggregateRun`, then wynik zawiera `repo`+`gitBranch`+`transcriptPath` (additive, brak breakage kształtu API).
  - `node scripts/telemetry-server.mjs --smoke` przechodzi.
- DoD: unit/smoke zielone; brak zmian w kształcie istniejących pól.

**s2 · F1-ui: Live rework (agent monitor)** — `type:feat` · **M** · blockedBy s1
- Pliki: `ui/src/screens/Live.jsx`, `ui/src/utils.js`, `ui/src/api.js` (single `getRuns()` poll 5s).
- Zakres (ux-v3 §3.1): KPI strip (active/cost today/tokens today/attention), active cards
  (repo+branch chips, model-mix, elapsed, koszt jako `…` gdy running — NIGDY `$0.00`),
  recent-10 z kolumną repo, attention list (ambiguous 24h + stale >2h), badge failed/ambiguous.
  Derywacje w `utils.js`: `active`, `today cost/tokens`, `stale`, `status`.
- AC:
  - server + 22 realne manifesty → Live pokazuje KPI, active cards, recent-10 z repo, attention.
  - running run pokazuje `…` (tooltip „cost appears after run ends"), nie `$0.00`.
  - failed run = czerwony badge; ambiguous run = amber badge + w attention.
  - empty active → hint `No agents running. Start one: bin\dev.bat`.

**s3 · F2: Timeline (gantt aktywności)** — `type:feat` · **L** · blockedBy s1
- Pliki: nowy `ui/src/screens/Timeline.jsx`, route `/timeline` w `App.jsx`, CSS w `theme.css`.
- Zakres (ux-v3 §3.2): rows=taskId (`null`→`(untagged)` na dole), bars=run (`startedAt→endedAt`,
  running→now pulse), kolor=squad (paleta stała), failed=czerwona krawędź, min-width 4px;
  zoom Day/3d/Week + pan ◀▶ + now-line (auto-window do now); tooltip (runId·squad·dur·cost·model·status);
  klik→`/runs/:id`; checkboxy squadów (client-side). **Bez lib** — absolutnie pozycjonowane divy `left/width=f(t)`.
- AC:
  - realne runy renderują się jako bary grupowane po tasku; zoom + pan + now-line działają.
  - hover→tooltip; klik→RunDetail; filtr squadów ukrywa bary; poll 5s odświeża.

**s4 · F3: Runs filters + RunDetail meta + Linear links** — `type:feat` · **L** · blockedBy s1
- Pliki: `ui/src/screens/Runs.jsx`, `ui/src/screens/RunDetail.jsx`, **nowy** `ui/src/config.js`.
- Zakres (ux-v3 §3.3, §5): Runs — filtry search/squad/status/repo/task + „only ambiguous",
  URL query via `useSearchParams` (deep-link z Costs/Live), kolumny repo/status(failed)/models.
  RunDetail — meta grid (repo·branch·started→ended·exit·provider·config·source), transcript path
  + copy 📋, ambiguous banner (amber), kolumny token in/out/cache w byModel/byAgent,
  „View all runs of this task"→`/runs?task=X`. `config.js` prefix map: **PISI + FEN + JOI (jointhubs)**.
- AC:
  - `/runs?task=PISI-98` pre-filtruje; chip PISI-98 otwiera linear.app/pisi; chip JOI-51 → linear.app/jointhubs.
  - copy button kopiuje `transcriptPath`; ambiguous manifest → banner w RunDetail.
  - filtr `status=failed` pokazuje tylko failed (wymaga s1).

**s5 · F4: Costs upgrades** — `type:feat` · **M** · blockedBy s4
- Pliki: `ui/src/screens/Costs.jsx` (reuse `config.js` z s4 dla Linear↗).
- Zakres (ux-v3 §3.4 pkt 1–4): period toggle 7d/30d/All (client-side na `byDay`+recompute KPI z `/api/runs`),
  sekcja **By agent** (suma `run.byAgent` client-side), byTask + kolumny Squads/Span + Linear↗ + klik→`/runs?task=X`,
  footer note o cross-check `cost-report.mjs`.
- AC:
  - period toggle zmienia byDay + KPI; By-agent sumuje się poprawnie (spot-check vs 1 RunDetail).
  - byTask row click → Runs przefiltrowane po tasku; Squads chips z `byTask[x].squads`.

**s6 · F5 (P2): B2 `/api/budget` + Budget panel** — `type:feat` · **M** · blockedBy s1, s5
- Pliki: `scripts/telemetry-server.mjs` (+`GET /api/budget`), `scripts/ledger.mjs` (reuse `aggregateByTask`),
  `ui/src/screens/Costs.jsx` (panel), `ui/src/api.js`.
- Zakres (ux-v3 B2 + §3.4 pkt5): endpoint `{ budgetPerTaskUSD: env COST_BUDGET_USD_PER_TASK|null,
  overBudget: .state/over-budget.json|[], tasksOverBudget: [taskId…] z aggregateByTask }`;
  panel per-task bar vs budżet; over-budget task → czerwony bar + wpis w Live attention (s2).
- AC:
  - `GET /api/budget` zwraca kontrakt; task > budżet renderuje czerwony bar i pojawia się w Live attention.
  - brak `COST_BUDGET_USD_PER_TASK` → `budgetPerTaskUSD:null`, panel degraduje się gracefully.

### Warstwa control-plane (L1 — 3 slices)

**s7 · L1a: `handoff-rules.json` + `GET /api/linear/queue`** — `type:feat` · **M**
- Pliki: **nowy** `config/handoff-rules.json`, `scripts/telemetry-server.mjs`, reuse `scripts/linear-query.mjs`.
- Zakres (control-plane §3.1): deklaratywne reguły z HOW-TO §6 (`Todo+dor-ok→dev`, `In Review+ai:coded→review`,
  `stage:testing→test`, `needs:*→human`); endpoint read-only `?workspace=` → taski z Linear wzbogacone
  o `suggestedSquad`, cache 60s.
- AC:
  - `GET /api/linear/queue?workspace=jointhubs` zwraca taski + `suggestedSquad` wg reguł.
  - task `Todo+dor-ok`→`suggestedSquad:"dev"`; task `needs:answer`→`suggestedSquad:"human"`.
  - drugie wywołanie w <60s serwuje z cache (bez drugiego hitu Linear).

**s8 · L1b: `POST /api/launch` (local auto-spawn + gotowy prompt)** — `type:feat` · **M**
- Pliki: `scripts/telemetry-server.mjs`, reuse launchery `bin\*.bat` (`claude %*`), template promptu z HOW-TO §4.
- Zakres (control-plane §3.2, §5 + decyzja Q3): `{taskId, squad, target:"local", mode}` →
  spawn nowego okna `start "..." cmd /k "set LA_TASK_ID=<id>&& bin\<squad>.bat "<kickoff>""`;
  kickoff **budowany server-side** z template §4 + podstawiony taskId (zero wklejania).
  Bezpieczeństwo: **bind 127.0.0.1**, allowlist squadów (plan/dev/review/test/cadence),
  walidacja `taskId` regexem `^[A-Z]+-\d+$`, żadnych dowolnych argumentów.
- AC:
  - `POST /api/launch {taskId:"JOI-51",squad:"dev",target:"local"}` → otwiera okno dev z otagowanym
    runem (`LA_TASK_ID=JOI-51`) widocznym w Live ≤5s, agent startuje z gotowym promptem (bez ręcznego wklejania).
  - taskId niepasujący do regexu / squad spoza allowlisty → 400, brak spawnu.
  - serwer odrzuca żądania spoza 127.0.0.1.

**s9 · L1c: ekran Tasks (5. zakładka)** — `type:feat` · **M** · blockedBy s7, s8
- Pliki: nowy `ui/src/screens/Tasks.jsx`, route `/tasks` + nav w `App.jsx`, reuse `config.js` (Linear↗).
- Zakres (control-plane §3.3): sekcje **NEXT UP** (wg handoff-rules, przyciski Launch local),
  **CZEKA NA CIEBIE** (`needs:*` → link „otwórz w Linear ↗", bez Launch),
  **W TOKU** (z Live/manifestów). Klik Launch → potwierdzenie (squad/task/target/preview promptu) → POST /api/launch → toast.
- AC:
  - Tasks pokazuje 3 sekcje z `/api/linear/queue`; PISI-98/JOI-51 (Todo+dor-ok) mają [▶ Launch local].
  - task `needs:*` NIE ma przycisku Launch, tylko link do Linear.
  - klik Launch → potwierdzenie z preview promptu → task pojawia się w Live po starcie manifestu.

## Kolejność / zależności
```
s1 ─┬─ s2 (Live)
    ├─ s3 (Timeline)
    ├─ s4 (Runs+RunDetail+config.js) ── s5 (Costs) ─┐
    └────────────────────────────────────────────── s6 (Budget)
s7 (rules+queue) ─┐
s8 (launch) ──────┴─ s9 (Tasks)
```
s1 i s7/s8 są niezależne (można równolegle). s6 blockedBy s1+s5. s9 blockedBy s7+s8.

## Poza scope JOI-51 (parked / blocked)
- **L2–L4** (VM/tmux remote spawn, session-bridge, meta-agent) → control-plane §4, czekają na
  provisioning GCP VM + decyzje §7. NIE tworzymy jako children (label `blocked` gdyby padły osobno).
- B3 live step feed (P3), planned-vs-actual overlay, Linear-collab HITL inbox (P4) → parked (ux-v3 §7).

## Weryfikacja (jak Mateusz sprawdzi po buildzie)
1. `node scripts/telemetry-server.mjs --smoke` → zielone (s1, s6, s7, s8).
2. `node scripts/telemetry-server.mjs` + `cd ui && npm run dev` → przejść J1–J5 z ux-v3 §2 w UI.
3. `POST /api/launch` (s8): klik w Tasks na JOI-51 → nowe okno dev startuje z promptem, run w Live ≤5s.
4. Per subtask: DoD (real data, `npm run build` czysty, screenshot, zero console errors).

## Po zatwierdzeniu (wyjście z plan mode)
Push do Linear jako **children JOI-51** (team JOI), status **Todo** + label **dor-ok** + **ai:planned**.
Bez tworzenia epica. Idempotentnie (`push` subagent / `linear-ops`), relacje `blocked by` wg grafu wyżej.
