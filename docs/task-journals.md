# Task journals — `docs/state/<TASK-ID>.md` (FOC-904)

## Why per task

`docs/STATE.md` was one shared, hand-written journal: two Supervisors working the same
repo collided on it by construction (the 2026-10-16 merge refusal during a 36-commit
replay is the precedent). A journal PER TASK removes the shared writable surface: every
session appends only to its own file. STATE.md keeps standing rules, global decisions
and historical entries, hand-written as today. (The `state-md` resolver reading
`docs/state/<issue>.md` first is a follow-up, parent FOC-898 — not part of FOC-904.)

## The three CLI verbs

```
node scripts/state-journal.mjs init [--task <id>]
node scripts/state-journal.mjs add --text "<entry>" [--task <id>]
node scripts/state-journal.mjs set --field Status=<value> [--field PR=<value>] [--task <id>]
```

The journal file is created by `init` from the session env (`LA_TASK_ID`,
`FENIX_SUPERVISOR_SESSION_ID`, `LA_SUPERVISOR_RUN`); a second `init` is a no-op.
Entries (`## <YYYY-MM-DD HH:MM> — <title>`) are append-only — `add` never rewrites
bytes above the new heading. `set` updates metadata lines in the header block only,
any of the six keys: Task, Session, Run, Branch, PR, Status. No task id from `--task`
or the env → exit 2.

## The generated index in STATE.md

`scripts/state-index.mjs` maintains ONE fenced block in `docs/STATE.md`, between the
markers `<!-- state-index:start -->` / `<!-- state-index:end -->` — one line per
journal, newest entry first, id breaking ties, rows shaped like
`- FOC-904 — in progress — last entry 2026-10-16 14:20 — foc-904-journal-per-task — -`.
`render` prints the block; `--write` splices it in (everything outside the markers is
untouched, EOL style preserved, inserted after the header block when the markers are
missing, malformed markers refused with exit 2); `--check` exits 1 when the committed
block differs from what the journals say. Never edit the block by hand.

## The merge rule

`supervisor-merge.mjs` regenerates the block after every successful child replay and
commits it when it changed (`docs(state): regenerate task journal index`). When a
replay conflicts on `docs/STATE.md` and EVERY conflict hunk lies inside the markers,
the conflict is machine-owned by construction: the tool takes ours, regenerates and
continues; a regen failure on an accepted integration is a report `note`, not a
rejection. A hunk outside the markers stays a hard textual conflict — abort, report,
reject.
