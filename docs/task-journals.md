# Task journals — `docs/state/<TASK-ID>.md` (FOC-904)

## Why per task

`docs/STATE.md` was one shared, hand-written journal: two Supervisors working the same
repo collided on it by construction (the 2026-10-16 merge refusal during a 36-commit
replay is the precedent). A journal PER TASK removes the shared writable surface: every
session appends only to its own file. STATE.md keeps standing rules, global decisions
and historical entries, hand-written as today. (The `state-md` resolver reading
`docs/state/<issue>.md` first is a follow-up, parent FOC-898 — not part of FOC-904.)

## The four CLI verbs

```
node scripts/state-journal.mjs init [--task <id>]
node scripts/state-journal.mjs add --text "<entry>" [--task <id>]
node scripts/state-journal.mjs set --field Status=<value> [--field PR=<value>] [--task <id>]
node scripts/state-journal.mjs close --pr "<#N>" [--date "<YYYY-MM-DD HH:MM>"] [--task <id>]
```
Every verb accepts `--root <path>` to override the journal root (see below).

## Which root wins

`resolveRoot` picks the tree whose `docs/state/` receives the journal, in order:

1. `--root <path>` — an explicit override on any verb.
2. The git repository of the current working directory
   (`git rev-parse --show-toplevel` of cwd).
3. `LA_ROOT` — only when cwd is not a git repository (a bare tooling checkout).
4. The repository `scripts/state-journal.mjs` itself lives in.

Why cwd-first: a Supervisor child runs inside its own worktree while `LA_ROOT`
still points at the operator's main checkout — the old LA_ROOT-first resolution
appended the child's journal to the main checkout's *untracked* `docs/state/`,
outside the candidate branch (FOC-1100 … FOC-1207; FOC-1155 r4 needed its
merge-round entry re-recorded by hand). Journaling into the cwd's repository
keeps the journal in the candidate tree it belongs to. Running from the main
checkout itself is unchanged there (cwd's repo = LA_ROOT).

`resolveRoot` lives in `scripts/state-root.mjs` and is shared by BOTH state
tools — `state-index.mjs` resolves the same way (cwd's git repository first,
then `LA_ROOT`, then its own repo) and accepts the same `--root <path>`
override. Before FOC-1224 `state-index` resolved `LA_ROOT`-first, so a
`--write` run from a worktree rewrote the MAIN checkout's `docs/STATE.md`;
now a run only ever touches the tree it runs from.

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

## Closing a journal after the merge

A journal is born open (`init`) and must be CLOSED once the ticket's PR merges —
otherwise the index shows an open status forever (the FOC-1224 drift: 33+ journals
of merged tickets still read "in progress"/"in review" with no PR number). The
delivery owner runs ONE command right after `gh pr merge`:

```
node scripts/state-journal.mjs close --pr "#N" --date "<YYYY-MM-DD HH:MM>"
```

- `--pr` — the merged PR number, read from `git log` on main
  (`Merge pull request #N from joint-hubs/<branch>`), never guessed.
- `--date` — the merge commit's date, same `git log` line; stamps the close entry
  (`## <date> — closed: merged in #N`), so the index's "last entry" ordering
  reflects when the work actually landed. Omit it only for a just-merged PR run
  interactively.
- The task id comes from `--task`/`LA_TASK_ID` like everywhere else; the root from
  `--root`/cwd like everywhere else — run it from the checkout whose journal you
  are closing.

`close` sets `Status: done` and `PR: <value>` in the header block, appends the close
entry, then regenerates the index block in the same root — one command, no separate
`state-index --write`. If the regen fails (e.g. malformed markers), the journal edits
stay and the tool says so; rerun `state-index.mjs --write` afterwards.

Commit shape for the closure itself:

```
chore(state): close <TASK> journal
```

After the close, `node scripts/state-index.mjs --check` must exit 0 — the CI lint
job gates on it, so a journal that lands without its close fails the build.

## The merge rule

`supervisor-merge.mjs` regenerates the block after every successful child replay and
commits it when it changed (`docs(state): regenerate task journal index`). When a
replay conflicts on `docs/STATE.md` and EVERY conflict hunk lies inside the markers,
the conflict is machine-owned by construction: the tool takes ours, regenerates and
continues; a regen failure on an accepted integration is a report `note`, not a
rejection. A hunk outside the markers stays a hard textual conflict — abort, report,
reject.
