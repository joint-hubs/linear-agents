# FOC-807 — the Docker Supervisor gets its run id: waker, guard, briefing, Cockpit

Date: 2026-10-12. Issue: FOC-807 (Urgent, M8). Found on `fenix-vm`: the Supervisor went idle after `test-1` exited
(18:04 UTC), the wake event sat in `wake-queue.jsonl`, and nothing woke it until Mateusz pressed Wake at 18:37.

## Diagnosis (recon, 2026-10-12)

* Windows: `bin/_lib.bat:98-107` makes the id (`run-manifest.mjs gen-id supervisor` → `2026-10-06T15-09-19-713-supervisor-26c7`),
  registers the manifest and exports `RUN_ID` + `LA_RUN_ID`; `bin/supervisor.bat:62` copies it to `LA_SUPERVISOR_RUN`.
* Docker: `docker/entrypoint.sh` `supervisor-run` (123-148) exports `CLAUDE_CONFIG_DIR`, `ANTHROPIC_MODEL`,
  `LA_SUPERVISOR_REPO` and execs `claude --continue` (or `claude` on `--new`). **No run id at all** — not
  `LA_SUPERVISOR_RUN`, not `RUN_ID`/`LA_RUN_ID`.
* Effect, all silent:
  * `supervisor-wake.mjs:209` (Stop, `asyncRewake`) and `supervisor-guard.mjs:121` (Stop) exit 0 without a run → no waker,
    no turn-end guard;
  * `supervisor-status.mjs --briefing` (SessionStart) → "no run to brief";
  * `telemetry-hook.mjs:21-23` (SessionStart) needs `LA_RUN_ID`/`RUN_ID` → the Supervisor session is never linked to a run;
  * the Supervisor's own CLIs (spawn, gate, followup, …) require `--run` — on the VM it found an old id in Linear and
    prefixed 15 commands with `export LA_SUPERVISOR_RUN=…`.
* Cockpit: `waker` comes from the focus-ticket heuristic (newest run with a `triage.json`), `wakeBacklog` sums un-acked
  rows over every run touched in 14 days, the Wake banner shows only when `state === 'idle'`, `waker.state` is never
  rendered, and `model` is `process.env.SUPERVISOR_MODEL` — unset in `fenix-api`, so null.

## Design

### 1. The current-run record — `<dataHome>/supervisor/current-run.json`

`{ "runId", "model", "startedAt", "source": "new" | "pointer" | "adopted" | "launcher" }`, written atomically next to
`session.json` (Docker: `/data/supervisor/`, on the volume, read by both containers). New path helper
`supervisorCurrentRunPath()` in `scripts/fenix-paths.mjs`.

New `scripts/supervisor-current-run.mjs` (library + CLI, tests in `supervisor-current-run.test.mjs`):

* `resolveCurrentRun({ fresh, model, now, … })`:
  * `fresh` (`--new`) → a new id (same format as `run-manifest gen-id supervisor`), `source: "new"`;
  * otherwise a valid record → reuse its id (`source: "pointer"`), model updated;
  * otherwise (first start after this change, e.g. `fenix-vm`) → **adopt the newest run dir touched in the last 14 days**
    (`recentRunIds()`), `source: "adopted"`, so a resumed conversation keeps the run its children live in; none → new.
  * Writes the record; returns it.
* `readCurrentRun()` → the record or null (invalid id shape / unreadable → null, never throws).
* CLI: `resolve [--new] [--model <id>]` prints one line `<runId> <source>` on stdout (the entrypoint needs the source
  to call `run-manifest start` only for a new run; diagnostics on stderr);
  `record <runId> [--model <id>]` (`source: "launcher"`, for `supervisor.bat`); `show --json`.

### 2. Launchers

* `docker/entrypoint.sh supervisor-run`: `LA_SUPERVISOR_RUN="$(node … resolve [--new] --model "$ANTHROPIC_MODEL")"`,
  then `RUN_ID` and `LA_RUN_ID` = the same id (parity with `_lib.bat`). On a **new** id also
  `run-manifest.mjs start <id> supervisor <repo>` (records `run.started` in the shared store); never on resume
  (`start` overwrites a manifest blindly). If the helper fails: one stderr line in the pane, start without the id (today's
  behaviour) — the Cockpit then shows "waker not running".
* `bin/supervisor.bat`: one line after `:62` — `supervisor-current-run.mjs record "%LA_SUPERVISOR_RUN%" --model …`, so the
  native dashboard gets the same truth. No other `.bat` change (FOC-771 replaces them).

`--new` keeps one meaning for the human — a fresh conversation — and now also a fresh run, as on Windows.

### 3. Cockpit API (`scripts/cockpit-routes.mjs`)

* `supervisor.runId` = `readCurrentRun()?.runId`, else the focus-ticket run (today's heuristic) as a fallback.
* `waker`, the Wake prompt and `wakeBacklog` use that run; the 14-day sum stays only when no run is known.
* New `supervisor.wakeOldestAt` (oldest un-acked row's `ts`).
* `supervisor.model` = the record's model, else `SUPERVISOR_MODEL`, else null.

### 4. Cockpit UI — "something waits" (FOC-807 AC 4)

Pure `wakeBanner(supervisor)` in `ui/src/cockpitModel.js` → `{ count, since, waker, canWake, text }` or null; rendered in
`SupervisorPanel.jsx` in the existing banner slot:

* shown whenever `wakeBacklog > 0`, in any state (today: only `idle`);
* text: "N event(s) waiting for the Supervisor since HH:MM" + the waker: alive → "the waker delivers them when the turn
  ends"; absent / stale / ended → "waker not running";
* the Wake button when the Supervisor is not busy and not on a dialog (`idle`, `ended`, `absent`, null) and the host is
  reachable — waking an ended session starts it (FOC-783 `ensure`).

### 5. Supervisor contract (needs Mateusz's OK — `agents/**`)

One line in `agents/supervisor/CLAUDE.md`: the launcher sets `LA_SUPERVISOR_RUN`; never take a run id from Linear, notes or
another machine.

## Slices

| # | What | Worker |
|---|---|---|
| S1 | `fenix-paths` helper + `supervisor-current-run.mjs` + tests + `test-lanes.json` | glm-5.3-flash |
| S2 | `entrypoint.sh supervisor-run` + `supervisor.bat` record line | glm-5.3-flash (after S1's CLI contract) |
| S3 | `cockpit-routes.mjs` run/waker/backlog/model + `cockpit-routes.test.mjs` | glm-5.3-flash |
| S4 | `wakeBanner` + `SupervisorPanel` banner + `_tests_cockpit.mjs` | glm-5.3-flash |
| S5 | ACCESS.md (`current-run.json`), QUICKSTART note, contract line (if OK) | orchestrator |

S1–S4 run in parallel against the contracts above; glm-5.3 reviews the combined diff.

## Verification

1. Unit: `supervisor-current-run.test.mjs` (new / pointer / adopt / invalid / record), `cockpit-routes.test.mjs`,
   `ui` `npm test`; Windows `test-all` and the Linux lane (`docker/test-in-container.sh`); lint 0.
2. Acceptance on the FOC-783 mock-API stack (rebuilt image, dummy secrets, no cost):
   * the Supervisor pane has `LA_SUPERVISOR_RUN` = `LA_RUN_ID`; `current-run.json` written; SessionStart briefing names the run;
   * after the first turn `waker.json` heartbeat is alive (Cockpit shows it);
   * a wake row appended for the run → the idle Supervisor is woken (`asyncRewake` reminder in the transcript), the banner
     appears and clears after the ack;
   * container restart → same run id (`source: "pointer"`); `fenix attach --new` → new id; a state home with an old run and
     no record → `adopted`;
   * the Cockpit shows the real model.
3. On `fenix-vm` after merge (`./fenix update`): the record adopts `…-supervisor-26c7`; the next child exit wakes the
   Supervisor without a click.

## Out of scope (follow-ups)

* Run manifests in Docker live in each container's image layer (`run-manifest.mjs` → `<LA_ROOT>/.state/runs`;
  `LA_STATE_ROOT` unset), so `fenix-api` ingest never sees the Supervisor container's manifests — new task: put
  `LA_STATE_ROOT` on the volume.
* Supervisor questions / permission prompts in the dashboard — FOC-810.
