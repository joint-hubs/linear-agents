# How to Run the Agents (Operator Runbook)

> Praktyczna ściąga: **czym odpalić każdego agenta, w jakiej kolejności, i co
> dokładnie wkleić w prompt** po starcie danego pliku `.bat`. Model teoretyczny
> (statusy, labelki, DoR/DoD, eskalacja) → [`FENIX_WORKFLOW.md`](FENIX_WORKFLOW.md).

---

## 1. TL;DR — pełny cykl jednego feature'a

```
approved feature (Linear)
   │
   ├─ 1. PLAN     bin\plan.bat        → epic + subtaski w Todo (dor-ok)
   │
   ├─ 2. DEV      bin\dev.bat         → kod + commit → In Review  (loop z REVIEW ≤2)
   │        ↑↓ feedback
   ├─ 3. REVIEW   bin\review.bat      → verdykt approve/return; przy approve nadaje WERSJĘ
   │
   └─ 4. TEST     bin\test.bat        → deploy nowej wersji + testy → Done / return
```

Każdy krok to **osobne okno terminala** (osobny `CLAUDE_CONFIG_DIR`, osobny
model, osobny RUN_ID do telemetrii). Handoff między krokami idzie **przez
Linear** (status + labelka + komentarz), nie przez czat.

Wszystkie naraz: `bin\all.bat` (otwiera 5 okien: cadence, plan, dev, review, test).

---

## 2. Zanim odpalisz cokolwiek (jednorazowo)

1. `.env` uzupełniony (klucze: `OPENROUTER_API_KEY`, `LINEAR_API_KEY`,
   opcjonalnie `LINEAR_API_KEY_PISI`). Plik jest **gitignored** — nie commituj.
2. `LINEAR_TEAM_KEY` = zespół docelowy (`FEN` = jointhubs, `JOI` = jointhubs, `PISI` = pisi).
   Per-okno możesz nadpisać wartość z `.env`: `set LINEAR_TEAM_KEY=JOI&& bin\plan.bat`
   (window-level env wygrywa z `.env` dla `LINEAR_TEAM_KEY` i `LINEAR_WORKSPACE`).
3. `LINEAR_WORKSPACE` = `jointhubs` (domyślnie) albo `pisi`. Pusta wartość NIE
   działa jak „domyślne" — parser `.env` traktuje pustą jako ustawioną. Wpisz
   konkretną nazwę.
4. Pierwszy start na nowym zespole → `_lib.bat` zapyta o provisioning labelek
   (`bootstrap-linear.mjs`). Zatwierdź `y`, inaczej push może paść na brakującej
   labelce.

**Native vs OpenRouter:** domyślnie leci OpenRouter (`ANTHROPIC_AUTH_TOKEN` =
klucz OR). Subskrypcja Anthropic (Opus/Sonnet natywnie) → ustaw `NATIVE=1` przed
launcherem: `set NATIVE=1 && bin\plan.bat`.

---

## 3. Który plik `.bat` = który agent

| Launcher | Squad | Model lead | small_fast (subagenci) | Trigger (kiedy odpalasz) |
|---|---|---|---|---|
| `bin\plan.bat`    | PLAN    | Opus 4.8      | MiniMax M3        | Masz approved feature → chcesz taski |
| `bin\dev.bat`     | DEV     | GLM-5.2       | MiniMax M3        | Jest task w `Todo` + `dor-ok` |
| `bin\review.bat`  | REVIEW  | GLM-5.2       | DeepSeek V4 Pro   | Task w `In Review` |
| `bin\test.bat`    | TEST    | MiniMax M3    | DeepSeek V4 Flash | Task `stage:testing` (po approve review) |
| `bin\cadence.bat` | CADENCE | MiniMax M3    | DeepSeek V4 Flash | Cotygodniowo (retro/digest) |

Pojedynczy sub-agent (debug jednej roli): `bin\agent.bat <area> <role>`
np. `bin\agent.bat dev implementer`, `bin\agent.bat review security`.
Role: patrz `bin\agent.bat` bez argumentów. Modele ról: `config/models.map`.

Dry-run (bez zapisu do Linear): `bin\plan-dry.bat`, `dev-dry.bat`,
`review-dry.bat`, `cadence-dry.bat`.

---

## 4. Prompty do wklejenia — per launcher

> Po starcie `.bat` otwiera się interaktywna sesja Claude Code z załadowanym
> `CLAUDE.md` danego squadu. Wklej **jeden** z poniższych promptów. Podmień
> `FEN-NN` / ścieżki na swoje.

### 4.1 PLAN — `bin\plan.bat`

Wejście: approved feature na tablicy albo notatka głosowa w `planning/inbox/`.

```
Feature approved do zaplanowania: FEN-NN (albo: planning/inbox/<plik>.md).
Przejdź pełny cykl PLAN: discovery → spec (+ADR jeśli decyzja architektoniczna)
→ spec-review → decompose na vertical slices z AC/DoD/estimate(t-shirt).
GATE 1: pokaż brief (≤1 str.) + pytania, czekaj na moje ✅.
GATE 2: pokaż 2–3 przykładowe subtaski z AC, zapytaj "tworzę w Linear?", czekaj ✅.
Po ✅ pushnij do Linear (team FEN) jako epic + subtaski w Todo z dor-ok.
```

Dry-run (walidacja bez zapisu): odpal `bin\plan-dry.bat` i wklej to samo — GATE-y
się auto-akceptują, push pomijany, decomposer zapisuje draft JSON do
`planning/briefs/.draft.*.json`.

### 4.2 DEV — `bin\dev.bat`

Wejście: subtask w `Todo` z `dor-ok`.

```
Weź task FEN-NN (Todo, dor-ok). Krok po kroku wg FENIX_WORKFLOW §5:
1) update status → In Progress, assignee @flow, label ai:coded, komentarz 👀.
2) recon: przeczytaj task + AC + powiązany kod (nie zgaduj — niejasne → needs:answer + @Mateusz + stop).
3) zaimplementuj NAJMNIEJSZY pełny slice spełniający AC.
4) self-test (logi/curl/UI; docker → rebuild+redeploy).
5) commit (jeden task = jeden commit, format §3, BEZ Co-Authored-By). NIE pushuj bez mojej zgody.
6) deliver_task → In Review + podsumowanie PL: co zrobione, wyniki testów, jak testować.
```

### 4.3 REVIEW — `bin\review.bat`

Wejście: task w `In Review`. To tu **powstaje wersja** przy approve.

```
Zrób review taska FEN-NN (In Review). Trzy przebiegi: first-pass (DeepSeek Pro),
security (Kimi), deep (GLM-5.2). Zwróć verdykt:
- APPROVE → dodaj ai:reviewed + dod-ok, nadaj wersję (label version:<sesja>, patrz §5),
  ustaw stage:testing i przekaż do TEST; komentarz PL z findings (liczba/severity, co przeszło).
- RETURN → wypisz konkretne poprawki, status → In Progress, licznik rundy +1.
Limit 2 rundy DEV↔REVIEW; po 2 bez zbieżności → label escalated + @Mateusz + stop.
```

### 4.4 TEST — `bin\test.bat`

Wejście: task `stage:testing` (approved przez review, z nadaną wersją).

```
Zdeployuj i przetestuj FEN-NN (stage:testing, wersja version:<sesja>).
1) deploy nowej wersji na target z config/projects.json (health-check).
2) uruchom scenariusze testowe wg AC + smoke golden path + edge cases.
3) PASS → status Done + dod-ok + komentarz PL (deploy URL, wyniki, health).
   FAIL → auto-rollback, status → In Progress, opis błędu + jak powtórzyć.
Dane testowe syntetyczne (żadnego prod PII).
```

### 4.5 CADENCE — `bin\cadence.bat`

```
Tygodniowy przebieg CADENCE: zbierz stan tablicy (wszystkie squady),
zrób retro (cycle time, throughput, rundy review, $/task) i wygeneruj
digest po polsku dla Mateusza. Read-only — żadnych zmian scope.
```

### 4.6 Pojedynczy sub-agent — `bin\agent.bat <area> <role>`

```
:: przykład: bin\agent.bat dev debugger
Debuguj wyłącznie w roli 'debugger' obszaru 'dev'. Kontekst: FEN-NN.
Znajdź PRAWDZIWĄ przyczynę (nie objaw), prześledź całą ścieżkę, zaproponuj fix.
```

---

## 5. Wersjonowanie i „używanie nowej wersji"

> Pełny docelowy przepływ PR/Copilot/UAT jest w backlogu
> ([`docs/backlog/pr-review-loop-release-versioning.md`](backlog/pr-review-loop-release-versioning.md)).
> Poniżej minimalny model, który działa dziś.

- **Kto nadaje wersję:** REVIEW przy verdykcie APPROVE (feature „gotowy do QA").
- **Jak:** wspólna labelka `version:<sesja>` (np. `version:2026.07-uat1`) dla
  wszystkich feature'ów wychodzących do tej samej sesji QA/UAT.
- **Nośnik:** TEST deployuje tę wersję; zdeployowany artefakt = ta labelka.
- **„Używanie nowej wersji":** po `Done` + zielonym deployu wersja jest dostępna
  na targecie z `config/projects.json`. Adresy/porty → [`docs/ACCESS.md`](ACCESS.md).
- **Sign-off (docelowo):** `signoff:tech` + `signoff:biz` ⇒ `Released`.

Ręczny release repo (tagi git): `git tag v0.3.7 && git push --tags` — tylko na
Twoją wyraźną zgodę (agenci nie pushują sami).

---

## 6. Handoff między agentami (co wyzwala następny krok)

| Z → Do | Sygnał w Linear |
|---|---|
| PLAN → DEV     | status `Todo` + `dor-ok` |
| DEV → REVIEW   | status `In Review` + `ai:coded` |
| REVIEW → DEV   | status `In Progress` (return, +runda) |
| REVIEW → TEST  | `stage:testing` + `ai:reviewed` + `version:<sesja>` |
| TEST → done    | status `Done` + `dod-ok` |
| dowolny → człowiek | `needs:answer/approval/decision/access` + @Mateusz → **stop** |

Kolejny agent sam wybiera task po tych metadanych (dependency-aware, WIP=1).
Ty odpalasz launcher danego squadu, gdy w jego kolejce jest robota.

---

## 7. Telemetria (co powstaje przy każdym uruchomieniu)

Każdy `.bat` przez `_lib.bat` generuje `RUN_ID` i zapisuje
`.state/runs/<runId>.json` (start/koniec, squad, źródło, exit code). `ledger.mjs`
parsuje transkrypty Claude Code → koszt per model/agent/task; `telemetry-server.mjs`
serwuje API na `:7331`. Dashboard (w budowie) czyta to API — patrz
[`docs/ui/observability-platform-plan.md`](ui/observability-platform-plan.md).

Szybki koszt sesji: `node scripts/cost-report.mjs` · per task: `node scripts/cost-per-task.mjs`.
