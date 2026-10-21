# PRD — Model experiments: per-ticket model arms for the Supervisor and the squad leads

Status: **draft, awaiting Mateusz's acceptance** (2026-10-21). Linear: FOC-967 (mechanism), FOC-965 (the campaign it serves). Overview page: `docs/ui/model-routing.html`. Analysis: `docs/research/model-routing-2026-10-21.md`.

## 1. Problem / goal

FOC-965 compares models on real tickets: 6 arms for the Supervisor, 3 for each of the PLAN / DEV / REVIEW / TEST leads, 5 tickets per arm. Today the only switch is the Settings overlay (`routing.supervisor.lead`, `routing.<squad>.lead`): a human must flip it after every 5 tickets, remember which ticket ran on what, and a flip in the middle of a ticket's life splits that ticket across two arms. The comparison is only as good as that bookkeeping.

**Goal:** an experiment is declared once in Settings; Fenix assigns an arm to each new ticket at the moment it already resolves the model, keeps that arm for the whole ticket, shows progress, stops by itself and produces the per-arm report from telemetry. No mid-session model changes — ever.

## 2. User journey (Mateusz)

1. Dashboard → Settings → **Experiments** → "New experiment": slot `supervisor`, arms `mimo-v2.6-pro, glm-5.3-flash, muse-spark-1.3, gemini-4-argon, gpt-6.1-sol, claude-sonnet-5.5`, 5 tickets per arm, cost cap $300 → Start.
2. He keeps working normally: picks tickets on the Work board. Each new ticket shows a badge `exp: supervisor · gemini-4-argon`. The ticket's Supervisor session starts on that model.
3. The Experiments card shows `gemini-4-argon 3/5 · $31 · first-time-right 2/3`. He can pause, stop, or exclude a ticket (e.g. a trivial one) — the excluded ticket's slot is re-issued.
4. When every arm has 5 tickets (or the cap is hit), the experiment completes, new tickets go back to the default model, and the report is ready: per arm p20/p50/p80 of $ per ticket, time to landed branch, interventions, rounds.
5. In parallel he runs `plan.lead` (mimo / gemini-4-argon / sonnet-5.5) and `dev.lead` (glm-5.3-flash / mimo / muse-spark-1.3) experiments.

## 3. Scope

**In**
- Slots: `supervisor`, `plan.lead`, `dev.lead`, `review.lead`, `test.lead`, `cadence.lead`.
- Settings overlay `experiments[]` with validation (arms must be priced models of the active provider).
- Assignment at the two existing resolution points, sticky per ticket, persisted.
- Run manifest + telemetry tag `{ experimentId, slot, arm }` so baseline-arm tickets are distinguishable from ordinary tickets on the same model.
- CLI `node scripts/model-experiment.mjs status|resolve|exclude|report <id>`; dashboard card; Work board badge.
- Cost cap per experiment (stop assigning when reached).

**Out (v1)**
- Subagent roles (`agents/<squad>/agents/*.md`) and Claude Code tiers — they are image/repo files, changed by commit (`tiers.sonnet` is the auto-mode classifier — never part of an experiment).
- Changing a model mid-session or mid-turn.
- Statistical significance tests (n = 5 per arm is a signal, not proof — the report says so).
- Automatic promotion of the winner to the default (a human decision, by editing routing).

## 4. UX

- **Settings → Experiments** card: list of experiments (state: running / paused / completed / stopped), per arm `n/target · $ · median time`, buttons Pause / Stop / Exclude ticket, "New experiment" form (slot, arms picked from the priced-model list with price per ticket estimated from the last 30 days, tickets per arm, cost cap).
- **Work board**: badge on a ticket card `exp · <slot> · <arm>`; tooltip with the experiment name.
- **Cockpit**: the Supervisor panel shows the session's model and, when assigned, "experiment arm".
- Polish copy like the rest of the dashboard; numbers as in Costs & quality.

## 5. Architecture

### 5.1 Data

Settings overlay (`.fenix/config/settings.json`, survives `fenix update`):

```json
"experiments": [
  { "id": "sup-2026-10", "slot": "supervisor", "arms": ["xiaomi/mimo-v2.6-pro", "google/gemini-4-argon", "..."],
    "ticketsPerArm": 5, "maxUsd": 300, "state": "running", "createdAt": "2026-10-21T10:00:00Z" }
]
```

Assignment store (state volume, one writer: the resolver under a file lock): `<dataHome>/experiments/<id>/assignments.jsonl` — `{ taskKey, arm, assignedAt, excluded?, reason? }`. The ticket key is the canonical `resolveTaskKey({ workspace, issueId })` used everywhere else (task sessions, work board).

### 5.2 Resolution points (unchanged places, one new step)

- **Squad lead** — `childModelFor({ squad, ... })` in `scripts/child-model.mjs`, called by `supervisor-spawn.mjs` at each child spawn. New step before the overlay `lead`: `experimentArmFor({ slot: "<squad>.lead", taskKey })`.
- **Supervisor** — in task-workspace mode each task has its own Supervisor session; the model is resolved in `docker/entrypoint.sh` `supervisor-run` (`SUPERVISOR_MODEL` → overlay `routing.supervisor.lead` → provider default). New step: `node scripts/model-experiment.mjs resolve --slot supervisor --task <taskKey>` before the overlay read; the session's bound task key comes from the task-session host.
- **Legacy single Supervisor** (one session for many tickets): a per-ticket Supervisor arm is impossible without restarting the session per ticket → the `supervisor` slot is **only available in task-workspace mode**; the form says so.

Precedence (top wins): explicit env (`SUPERVISOR_MODEL`, `LA_*_MODEL`) → **experiment arm** → overlay `routing.<slot>.lead` → `config/models.json` routing → provider default.

### 5.3 Assignment rule

- First resolution for a ticket in a running experiment assigns the arm with the fewest assigned non-excluded tickets (ties: arm order) → round-robin that self-balances after exclusions.
- Later resolutions for the same ticket (resumed turns, next rounds, follow-ups) read the stored arm — never reassign.
- A ticket that started before the experiment keeps its model (no assignment).
- Stop conditions: every arm at `ticketsPerArm`, or experiment cost (telemetry sum over its tagged tickets and slot) ≥ `maxUsd`, or human stop.

### 5.4 Telemetry and report

- The resolver writes `{ experimentId, slot, arm }` into the run manifest; telemetry ingest carries it onto the run (new nullable columns on `runs` or a side table `run_experiments(run_id, experiment_id, slot, arm)`).
- `report <id>`: per arm — tickets, $ per ticket for the slot and for the whole ticket (p20/p50/p80 — the house standard), time to landed branch, rounds (REVIEW/TEST verdicts), Needs-you interventions / parked prompts / auto-denials, plus a list of tickets for the manual honesty check (Linear completion comment vs reality).

## 6. Phases and tasks

**A — core (no wiring)**
- [ ] A1 settings schema + validation for `experiments[]` (fenix-settings.mjs), tests
- [ ] A2 `scripts/model-experiment.mjs`: `experimentArmFor`, assignment store with lock, stop conditions, CLI `status|resolve|exclude`; tests (balancing, stickiness, exclusion, cap, concurrent resolves)

**B — wiring**
- [ ] B1 `childModelFor` step for `<squad>.lead` (ticket key threaded from supervisor-spawn); tests
- [ ] B2 Supervisor task-session start: entrypoint/task-session-host resolve step; legacy-mode refusal; tests
- [ ] B3 run manifest + telemetry tag; migration; tests

**C — dashboard**
- [ ] C1 Settings → Experiments card (list, new, pause/stop, exclude)
- [ ] C2 Work board badge + Cockpit model line
- [ ] C3 browser check (memory: Fenix UI needs a real browser check before PR)

**D — report**
- [ ] D1 `report <id>` from telemetry (p20/p50/p80) + Insights panel
- [ ] D2 QUICKSTART "Model experiments"

## 7. Acceptance

- An experiment with 3 arms × 2 tickets on a test stack assigns 2/2/2, keeps each ticket on its arm across a resumed turn and a second round, and completes by itself; the 7th ticket runs on the default model.
- An excluded ticket frees its slot; the cap stops assignment and says why.
- The report shows per-arm $ per ticket matching a manual telemetry query within rounding.
- `supervisor` slot is refused in legacy single-session mode with a clear message.
- Default behaviour with no experiments is unchanged (config-drift, child-model, squad-start suites green).

## 8. Open questions (proposed defaults)

1. **Precedence** — experiment arm above the overlay `lead`, below explicit env. *Default: yes.*
2. **Supervisor slot only in task-workspace mode.** *Default: yes* (the FOC-789 run will show whether task sessions are the normal mode on the VM).
3. **Concurrency** — one running experiment per slot; Supervisor and lead experiments may run at the same time, the report flags tickets that were in two experiments. *Default: allowed, flagged.*
4. **Cost cap** default per experiment: *$100* unless set (money guard).
5. **Manual campaign before this ships** — FOC-965 can start by hand (Settings flips + a ticket list in the FOC-965 comments) with the FOC-789 run as the first baseline ticket. *Default: yes, start now, switch to the mechanism when it lands.*
