# Delivery Plan — FOC-917 Child sweep on resumed turns (the follow-up spawn path)

Linear: **FOC-917** (M8, parent FOC-768, Medium, bug). Found on `fenix-vm` 2026-10-19 during the FOC-809 run,
written the same day by the delivery owner under the 2026-10-15 autonomy rule.

## 0. The defect

FOC-808 slice B gave every child a teardown identity — `LA_CHILD_MARK=<runId>/<childId>/<attemptId>` in its
environment and a per-child `TMPDIR=<tmp>/fenix-child/<childId>` — but only in `scripts/supervisor-spawn.mjs`
(turn 0). A follow-up turn (`scripts/supervisor-followup.mjs`, `supervisor-watch.mjs --session <id>`) builds its
own watcher env without either, and never writes `mark` / `tmpDir` into the registry. On the VM the resumed
`dev-2` (FOC-680) ran 52 min, exited 0 with `sweptPids: []`, and the `pgserver` Postgres it started survived
(6 processes as `fenix-child`, PPID 1) — finding 1 of FOC-808, unchanged for every turn after the first.

A second subtlety: the mark carries the attempt id, which changes per turn, so the registry's `mark` must be the
CURRENT turn's mark — `finalizeTurn` prefers `entry.mark` over the env.

## 1. Contract

- `scripts/supervisor-lib.mjs`: one shared helper for the identity — `childTeardownIdentity({ runId, childId,
  attemptId, tmpRoot })` → `{ mark, tmpDir }` and `ensureChildTmpDir(tmpDir)` (0700; 2770 inside the container,
  the mode spawn used). Both spawn paths call it; the inline block in `supervisor-spawn.mjs` goes.
- `scripts/supervisor-followup.mjs`: computes the identity for the NEW turn (`attemptIdFor(childId, turnIndex)`),
  creates the tmp dir, passes `LA_CHILD_MARK` + `TMPDIR` in the watcher env (next to `LA_TASK_ID`), and writes
  `mark` / `tmpDir` into the registry entry together with the turn's other fields — overwriting an older mark, and
  giving a pre-FOC-808 entry its first one.
- Tests: `supervisor-followup.test.mjs` asserts the follow-up env carries both variables with the right values
  and that the registry entry has `mark` / `tmpDir` afterwards (a fixture entry without them gains them);
  `supervisor-spawn.test.mjs` keeps passing (behaviour unchanged, only shared).
- Docs: one bullet in `docs/plans/foc-808-vm-hygiene.md` naming the second spawn path.

## 2. Verification

Lanes `supervisor-followup`, `supervisor-spawn`, `supervisor-watch`, `supervisor-orphans`; lint; Flash review of
the production diff. On the VM after the merge: a resumed turn's strays are swept (the FOC-809 run continues
there — the next follow-up turn is the check; the existing VM stray from 2026-10-19 has no mark and is stopped by
hand).
