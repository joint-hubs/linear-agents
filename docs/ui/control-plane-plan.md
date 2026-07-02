---
type: implementation-plan
status: draft
audience: Mateusz (approval) → GLM (build)
tags: [type/plan, area/ui, area/devops, topic/launch, topic/vm, topic/tmux, topic/meta-agent]
created: 2026-07-02
maturity: plan-v1
depends: [observability-platform-plan.md, ux-design-v3.md, ../remote-agent-execution.md, ../HOW-TO-RUN-AGENTS.md]
---

# Control plane — uruchamianie agentów z platformy + zdalne sesje + (później) meta-agent

> Wymaganie: z dashboardu kliknąć taska → zobaczyć **który agent powinien go teraz przejąć** → klik
> = agent startuje (lokalnie albo przez GitHub Actions na VM). Sesja na VM ma być **widoczna jak
> lokalny terminal** (SSH → pytania agenta widzę i odpowiadam). W przyszłości: **meta-agent**, który
> widzi wszystkie terminale, odpowiada za Mateusza i odpala taski.

## 0. Na czym budujemy (już istnieje / już zaprojektowane)
- **Reguły handoffu** = [HOW-TO-RUN-AGENTS §6](../HOW-TO-RUN-AGENTS.md): `Todo+dor-ok→dev`,
  `In Review+ai:coded→review`, `stage:testing→test`, `needs:*→człowiek`. To jest gotowa logika
  „który agent powinien przejąć taska" — wystarczy ją zakodować w config.
- **Spawn z Actions na VM** = [remote-agent-execution.md](../remote-agent-execution.md):
  `spawn-agent.yml` (workflow_dispatch: stack/project/linear_issue/mode), self-hosted runner na GCP VM,
  `bin/run-agent.sh`, szkic już odpala sesję **w tmux**. Faza G backlogu (T-G1…T-G5) zostaje w mocy.
- **Linear read/write** = `scripts/linear-query.mjs` / `linear-ops.mjs` (obowiązkowe toole squadów).
- **Telemetria runów** = manifesty + `telemetry-server` (:7331) + dashboard (ux-design-v3, F1–F5 w budowie).
- **Tagowanie taska**: `run-manifest.mjs start` czyta `LA_TASK_ID` z env — launcher z platformy ustawia go i run od razu jest przypisany do taska.

## 1. Nowość vs stary design: TRZY tryby uruchomienia (nie dwa)
| Tryb | Gdzie | TUI/pytania | HITL | Provider |
|---|---|---|---|---|
| **A. Local interactive** (dziś) | okno na Windows, `bin\*.bat` | tak, na żywo | plan-mode + Linear | OR lub subskrypcja (NATIVE=1) |
| **B. Remote interactive w tmux** (NOWY — to prosi Mateusz) | VM, sesja tmux `la-<runId>` | tak — pełne TUI żyje w tmux; `ssh -t vm tmux attach -t la-<runId>` pokazuje DOKŁADNIE to co lokalnie | terminal (attach) **+** Linear `needs:*` | OpenRouter (ADR-0001: subskrypcja nie działa headless/VM) |
| **C. Remote headless** (`claude -p`, stary design) | VM, detached | nie | wyłącznie async Linear | OpenRouter |

Tryb B rozwiązuje „twardą konsekwencję #1" z remote-agent-execution.md połowicznie: interaktywny
plan-mode NA VM staje się możliwy (tmux trzyma pty), ale **async-HITL przez Linear pozostaje ścieżką
podstawową** — attach jest do podglądania i awarii, nie do skalowania (10 sesji ≠ 10 okien SSH).

## 2. Architektura (przepływ)
```
Dashboard (Tasks view)
  │  klik „Launch dev @ PISI-98"
  ▼
telemetry-server  POST /api/launch {taskId, squad, target}
  ├─ target=local → spawn okna:  set LA_TASK_ID=… && bin\<squad>.bat
  │                (+ kickoff prompt z HOW-TO §4 do schowka)
  └─ target=vm    → GitHub API: workflow_dispatch spawn-agent.yml
                       └→ runner na VM → tmux new-session -s la-<runId>
                            └→ bin/run-agent.sh --interactive  (pełne `claude`, nie `-p`)
                                 kickoff wstrzyknięty przez tmux send-keys
Widoczność:  manifest (.state/runs) ← jak dotąd → dashboard Live/Timeline
             + pole manifestu: {host, tmuxSession}  → przycisk „attach" (kopiuje komendę SSH)
             + (L3) session-bridge.mjs na VM: tail panelu read-only w RunDetail
Meta-agent (L4, przyszłość): sesja Claude na VM z toolami tmux list/capture-pane/send-keys
             — czyta wszystkie sesje, odpowiada wg polityki, eskaluje do Mateusza (Discord).
```
Zakład architektoniczny: **tmux jako adresowalna warstwa sesji**. Attach dla człowieka,
`capture-pane` dla dashboardu, `send-keys` dla przyszłego meta-agenta — jedna inwestycja, trzy zwroty.

## 3. Elementy do zbudowania
### 3.1 Backend (telemetry-server + config)
- **`config/handoff-rules.json`** — deklaratywnie §6: `[{when:{state:"Todo",labels:["dor-ok"]}, next:"dev"}, …]`
  + reguła `needs:*` → `next:"human"` (bez przycisku Launch; link „odpowiedz w Linear").
- **`GET /api/linear/queue?workspace=`** — lista tasków z Linear (linear-query.mjs), wzbogacona o
  `suggestedSquad` z reguł; cache 60 s (rate limits). Read-only.
- **`POST /api/launch`** `{taskId, squad, target:"local"|"vm", mode}` —
  local: `child_process` → nowe okno terminala z env (`LA_TASK_ID`, squad launcher); vm: dispatch
  `spawn-agent.yml` przez GitHub API (fine-grained PAT z `.env`, scope `actions:write` tylko to repo).
  **Bind 127.0.0.1**, allowlist squadów, walidacja `taskId` regexem `^[A-Z]+-\d+$`.
- Manifest: nowe pola `host` (`local`/nazwa VM) i `tmuxSession` (dla trybu B) — dopisywane przez run-agent.sh.

### 3.2 Workflow / VM (rozszerzenie Fazy G — NIE nowa faza)
- `spawn-agent.yml`: + input `session: interactive-tmux | headless` (tryb B vs C); interactive-tmux
  odpala pełne `claude` w tmux z `default-size 220x50`, kickoff przez `send-keys`.
- `bin/run-agent.sh`: obsługa obu trybów; zapis manifestu z `host`+`tmuxSession` (parytet z `_lib.bat`).
- Prereq bez zmian: T-G1 provisioning VM (**nadal nie ma VM — blocker L2**), cost-guard, idempotency.

### 3.3 Dashboard (rozszerzenie ux-design-v3 — nowy ekran **Tasks**, 5. zakładka)
```
[ Live ] [ Timeline ] [ Runs ] [ Costs ] [ Tasks ]           workspace: FEN ▾
──────────────────────────────────────────────────────────────────────────────
NEXT UP (wg handoff-rules)
┌ PISI-98  Todo · dor-ok            → DEV     [▶ Launch local] [▶ Launch VM ▾]
│ similarity search…     $7.00 dotąd · 7 runów · ostatnio: review 07/01
┌ FEN-12   In Review · ai:coded     → REVIEW  [▶ Launch local] [▶ Launch VM ▾]
CZEKA NA CIEBIE (needs:*)
┌ FEN-13   needs:answer  „którą bazę embeddingów…"   [otwórz w Linear ↗]
W TOKU (agent pracuje — z Live)
┌ PISI-98  dev · running 15m · [attach: ssh -t vm tmux attach -t la-… 📋]
```
- Klik Launch → potwierdzenie (squad, task, target, prompt preview) → POST /api/launch → toast
  + task pojawia się w Live po starcie manifestu. Local: kickoff prompt (HOW-TO §4 z podstawionym
  ID) **kopiowany do schowka** — wklejasz w nowe okno (świadomy start, zero magii).
- RunDetail (tryb B): wiersz `session` z komendą attach + copy; (L3) panel „terminal — read only,
  ostatnie 40 linii" + auto-alert w Live, gdy w ogonie pojawi się pytanie/`needs input`.

### 3.4 Meta-agent (L4 — osobny PRD, tu tylko fundamenty)
- Wymaga: L2 (sesje w tmux) + L3 (czytanie paneli) + **protokół markera pytań** (agent, pytając w TUI,
  drukuje też linię `##NEEDS-INPUT <krótki opis>` — trywialna zmiana w CLAUDE.md squadów, do zrobienia w L3).
- Meta-agent = sesja Claude na VM z toolami: `tmux list-sessions / capture-pane / send-keys` +
  **policy file** (co wolno odpowiedzieć samemu: potwierdzenia rutynowe; co ZAWSZE eskaluje:
  git push, destrukcje, zmiany scope, koszty) + **audit log każdego send-keys** + eskalacja Discord.
- Nie projektujemy go teraz głębiej — ale L2/L3 buduje się tak, żeby L4 było dopisaniem, nie przebudową.

## 4. Fazy + acceptance
| Faza | Zakres | AC | Zależności |
|---|---|---|---|
| **L1 — Local launch + Tasks view** | handoff-rules.json, `/api/linear/queue`, `/api/launch` (local), ekran Tasks, kickoff→schowek, LA_TASK_ID | Klik na PISI-98 (Todo+dor-ok) → otwiera się okno dev-squada z otagowanym runem widocznym w Live ≤5 s; task `needs:*` NIE ma przycisku Launch | żadnych — działa bez VM |
| **L2 — Remote spawn (VM, tryb B)** | T-G1 provisioning, spawn-agent.yml `interactive-tmux`, run-agent.sh, manifest host/tmuxSession, target-picker + attach-copy w UI | Dispatch z dashboardu → sesja tmux na VM; `ssh -t … attach` pokazuje TUI z pytaniem plan-mode; run w Live z host=vm | **GCP VM** (blocker), PAT |
| **L3 — Widoczność terminala** | session-bridge.mjs (VM, read-only tail), panel w RunDetail, marker `##NEEDS-INPUT` w CLAUde.md squadów, alert w Live | RunDetail pokazuje ogon sesji VM; pytanie agenta = alert „needs input" w Live ≤15 s | L2 |
| **L4 — Meta-agent** | osobny PRD: policy, audit, send-keys, Discord | — (spike po L3) | L2+L3 |

## 5. Bezpieczeństwo (launch = zdalne wykonanie kodu z definicji)
- `/api/launch`: tylko 127.0.0.1, squad z allowlisty, taskId walidowany, żadnych dowolnych argumentów.
- PAT do dispatch: fine-grained, jedno repo, tylko `actions:write`, w `.env` (nigdy w UI/manifestach).
- session-bridge: read-only (`capture-pane`), port prywatny/tunel SSH; **send-keys NIE jest wystawiane
  przez HTTP** — to zdolność wyłącznie przyszłego meta-agenta na samej VM, za polityką + auditem.
- Sekrety na VM tylko z GitHub Secrets → env joba (jak w remote-agent-execution §7).

## 6. Ryzyka / uczciwe uwagi
- **VM wciąż nie istnieje** — L2/L3/L4 stoją za provisioningiem (T-G1). Dlatego L1 jest cięte tak,
  żeby dowieźć wartość bez VM (lokalny ból „ręcznego klikania" znika od razu).
- Attach nie skaluje: podstawowym HITL pozostaje Linear `needs:*` (+ Discord); terminal = podgląd/awarie.
- Dwa źródła prawdy „co działa" (tmux vs manifesty) → **manifest jest kanoniczny**, bridge tylko dokleja widok.
- Subskrypcja Anthropic na VM: nie (ADR-0001) — dashboard pokazuje provider per target, żeby brak
  Opusa-sub na VM nie zaskakiwał.
- Kickoff przez schowek (local) to świadomy trade-off: +1 wklejenie, ale zero niespodziewanych startów.

## 7. Otwarte decyzje (Mateusz, zbiorczo)
1. GCP VM — jest już konkretna maszyna (nazwa/projekt), czy L2 czeka na provisioning?
2. Kolejność: L1 najpierw (rekomendacja — bez zależności), czy równolegle przygotować L2?
3. Terminal w dashboardzie: wystarczy attach-copy + read-only tail (L3), czy chcesz kiedyś pełny
   interaktywny terminal w przeglądarce (xterm.js/ttyd — istotnie większa budowa; odkładam)?
4. Dispatch z dashboardu przez PAT w `.env` — ok? (alternatywa: dashboard tylko linkuje do formularza
   Actions w GitHub UI — zero sekretów, +2 kliki).

## 8. Następny krok
Po akceptacji: dopisać L1 jako zadania dla GLM (kontrakt w stylu F1–F5 do ux-design-v3 §6) —
`handoff-rules.json` + 2 endpointy + ekran Tasks; L2 czeka na decyzję VM.
