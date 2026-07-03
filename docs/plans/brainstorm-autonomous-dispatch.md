---
type: brainstorm
status: draft-v1 (po 1. rundzie odpowiedzi Mateusza, 2026-07-03)
audience: Mateusz (iteracja) → potem PLAN squad (dekompozycja jako Draft w Linear)
topic: autonomiczny dispatcher — squady startują same wg stanu Lineara, z bramkami-labelkami i budżetami per task
related: ../ui/control-plane-plan.md (L1 zbudowane: handoff-rules, /api/launch, queue), ../ops/remote-agent-execution.md (tryb headless C), ../ROADMAP.md
---

# Brainstorm A — autonomiczny dispatcher (Fenix v3 kandydat)

## Wizja (słowami Mateusza, uporządkowana)
Taski w Linearze same przyciągają squady: Draft → PLAN (nowy epic+subtaski, draft zamknięty
z komentarzem-linkiem) → dev bierze odblokowane subtaski (i zwroty z review) → review z werdyktem
(może dodawać taski długu, cofać do deva) → test decyduje zamknij-vs-UAT. Człowiek nie klika
launcherów — tylko podejmuje decyzje.

## Decyzje z 1. rundy (WIĄŻĄCE)
1. **Bramki = ZAWSZE akceptacja użytkownika, mechanizm = labelka.** Dispatcher przetwarza
   wyłącznie taski z labelką-bramką nadaną przez Mateusza. Żadnego full-auto na bramkach.
2. **Budżet per task, konfigurowany z UI.** Przy **80% budżetu**: nie wolno wystawić kolejnego
   query — czekamy na bieżącą odpowiedź modelu i STOP. Użytkownik wraca i decyduje:
   **wznów** (podnosi budżet / zatwierdza dalej, sesja kontynuuje) albo **odrzuć**
   (wyniki dotychczasowe zostają, sesja nie idzie dalej).
3. **Discord: później** (nieistotny teraz) — uwaga idzie przez dashboard (attention) + Linear.
4. **UAT oznacza PLAN przy dekompozycji** (labelki `uat:*`); TEST wykonuje.
5. **TEST ma dwa tryby** (zależnie od użytkownika):
   - `uat:user` — system **wdraża najnowszą wersję** (CI/CD) i użytkownik sam używa aplikacji;
     task czeka na jego werdykt.
   - `uat:proof` — squad **udowadnia, że dowieziono dokładnie to, czego użytkownik pierwotnie
     oczekiwał** (dowód AC-po-AC vs pierwotny opis/draft) **i odpowiada na jego pytania o całą
     aplikację** (Q&A w komentarzach).
   - brak labelki → auto-close po approve review; UAT zbiorcze przygotowywane przy parencie.

## Założenia przyjęte (Mateusz nie oponował)
- Pilotaż stopniowy: najpierw DEV+REVIEW autonomicznie, PLAN i TEST ręcznie 1–2 tyg.
- Dispatcher = pętla w telemetry-serverze (`--dispatch`), nie osobny cron systemowy — reuse
  `handoff-rules.json` + `/api/linear/queue` + `/api/launch` + `/api/live` (wszystko istnieje po L1).
- Skan co ~5 min; częstotliwość jest drugorzędna wobec budżetów (patrz niżej).

## Architektura (szkic)
```
telemetry-server --dispatch (pętla co N min)
  → queue (linear-query, cache) → dla każdego taska: handoff-rules + BRAMKI-LABELKI
  → kandydat? → guardy: WIP=1/squad (z /api/live) · budżet taska <80% · brak needs:* · backoff po failu
  → /api/launch (tryb headless `claude -p`, kickoff z szablonu roli)
  → wynik jak dziś: statusy/labelki/komentarze w Linear + manifest/telemetria
```

### Bramki-labelki (propozycja do iteracji)
| Przejście | Warunek stanu (już istnieje) | Bramka użytkownika (NOWA) |
|---|---|---|
| Draft → PLAN | stan `Draft` | `go` na drafcie |
| subtaski → DEV | `Todo` + `dor-ok` (stawia PLAN) | `go:build` na EPICU (1 klik = cała fala) |
| In Review → REVIEW | `ai:coded` | — (bez bramki; review jest read-only i tani) |
| stage:testing → TEST | `ai:reviewed` | wg `uat:*` (PLAN oznaczył; `uat:user` czeka na Ciebie z definicji) |
Zwroty z review (In Progress + runda>0) → DEV bez bramki (kontynuacja zatwierdzonej pracy).
Otwarte: czy `go:build` na epicu wystarcza, czy chcesz bramkę per subtask?

### Budżety per task (serce mechanizmu)
- **Źródło**: `.state/budgets.json` `{taskId: usd}` edytowane z dashboardu (Tasks tab / task detail);
  default z `COST_BUDGET_USD_PER_TASK`. (Linear nie ma u nas custom fields — plik + UI wystarczy.)
- **Egzekucja dwupoziomowa**:
  1. *Pre-launch* (dispatcher): koszt taska do tej pory (ledger `byTask`, liczy się live) ≥80% budżetu
     → nie startuj; attention w dashboardzie.
  2. *Mid-run* (hook): Claude Code hook (PreToolUse/Stop w `agents/<squad>/settings.json`) woła
     `scripts/budget-check.mjs` → koszt taska ≥80% → **blokuje kolejny krok**; bieżąca odpowiedź
     się kończy, agent (instrukcja P0 w CLAUDE.md) pisze WIP-komentarz i wychodzi czysto.
     Manifest: `pausedBy: "budget"`; Linear: label `over-budget` (istnieje) + `needs:decision`.
- **Wznów / odrzuć** (dashboard, karta attention):
  - **Wznów** = podnieś budżet w budgets.json + relaunch `claude --resume <sessionId>` (sessionId
    jest w manifeście) z kickoffem „kontynuuj od WIP".
  - **Odrzuć** = run zamknięty (`endedBy: "rejected"`), wyniki (branch/commity/komentarze) zostają,
    task dostaje komentarz i czeka na Twoją ręczną decyzję.

### Draft → PLAN (domknięcie pętli)
- Nowy stan `Draft` w `config/linear/states.json` (typ backlog).
- PLAN w trybie autonomicznym: bramki GATE 1/2 **nie są inline** — brief ląduje jako komentarz na
  drafcie + `needs:approval`; dispatcher wznawia PLAN po Twojej labelce `go` (spójnie z decyzją #1).
- Po pushu epica+subtasków: draft → `Canceled/Done` z komentarzem „zaplanowane → <link do epica>".

## Bezpieczniki (P0)
WIP=1 per squad (z /api/live) · budżet 80% (wyżej) · dzienny sufit $ globalny (kill-switch
cost-guard) · backoff: 2 faile z rzędu na tasku → `escalated`, dispatcher go pomija · dispatcher
NIE dotyka tasków z `needs:*` · pełny log decyzji dispatchera do `.state/dispatch.log` (audyt).

## Zależności twarde
- **Fenix v2 poz. 1–2 NAJPIERW** (worktree per run + domknięty lifecycle) — autonomia na wspólnym
  working tree to gwarantowana katastrofa; bez `end`-hooka dispatcher nie wie, że squad skończył.
- Tryb headless (`claude -p`) — szkic w `docs/ops/remote-agent-execution.md`; lokalnie działa tak samo.

## Fazy (propozycja)
| Faza | Zakres | AC |
|---|---|---|
| D1 | dispatcher **read-only** (proponuje: „odpaliłbym dev na JOI-81", log + attention, nic nie startuje) + bramki-labelki w handoff-rules | tydzień logów bez fałszywych startów |
| D2 | auto-launch DEV+REVIEW (pilotaż) + WIP/backoff | 3 subtaski przechodzą dev→review bez klikania |
| D3 | budżety: budgets.json + UI + budget-check hook + wznów/odrzuć | run staje na 80%, wznowienie działa (`--resume`) |
| D4 | PLAN na Draftach (async GATE przez `go`) + TEST dual-mode (`uat:user`/`uat:proof`) | draft→epic bez terminala; uat:proof generuje dowód AC-po-AC |
| D5 | Discord (ODŁOŻONE) | — |
