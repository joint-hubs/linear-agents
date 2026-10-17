# FOC-904 — Journal per task: `docs/state/<TASK-ID>.md`, generated index in STATE.md, merge rule, briefing line

Parent FOC-898 (P5-F). PRD `docs/prd/multi-supervisor-isolation-prd.md` §6.4 (collision 4), decision Q4. Branch
`foc-904-journal-per-task` cut from `main` 833f93b.

## Facts (recon 2026-10-16)

- `docs/STATE.md` is a hand-written, append-only journal (3 884 lines, Polish): header (:1-4), the ratified rules
  block `## Stałe zasady — od 2026-09-29` (:5) with `### Uzasadnienia decyzji podjętych samodzielnie` (:21) — this IS
  the global-decisions section; then chronological entries `## <date> — <what>` (FOC ids in the heading text), newest
  at the bottom (last: :3616, :3655, :3738, :3766, :3816). The queue snapshot is a paragraph near :19.
- `agents/supervisor/CLAUDE.md` never mentions STATE.md; the mandate lives in the Supervisor's runtime memory
  (`agents/supervisor/projects/<repo-hash>/memory/standing-decisions-2026-09-29.md:21`: commit that one file alone,
  message `docs(state): … (N)`, N = a running count in commit messages only).
- No script on `main` writes or parses STATE.md; the briefing (`supervisor-status.mjs --briefing`, :287-320) ignores it;
  `supervisor-merge.mjs` (483 lines) replays children with `git merge --no-ff --no-edit` into a scratch tree
  (`la-merge/<runId>`, :202, :284), lists conflicting files on failure (:287-296) and aborts — no STATE.md special
  case. Precedent: `docs/STATE.md:2595` "supervisor-merge hermetic replay odmówił (tekstowy konflikt docs/STATE.md przy
  36-commit replay)".
- The FOC-728 `state-md` resolver (branch `foc-728-agent-state-registry`, `agent-state-resolve.mjs:202-213`) reads
  label lines (`<label>: value`) from `docs/STATE.md`; labels come from `config/agent-state.json`.
- Session identity at write time: `LA_TASK_ID`, `LA_TASK_KEY`, `FENIX_SUPERVISOR_SESSION_ID`, `LA_SUPERVISOR_RUN`
  (`task-session-host.mjs:182-184`, `docker/entrypoint.sh:203`).
- `docs/state/` does not exist. Generator precedent: `agent-tools.mjs renderDocs` + `--write` (branch `agent-tools-cli`).
- `config-drift.test.mjs:61-69` requires every backtick-quoted `docs/….md` path in a contract to exist (placeholders
  with `<…>` excepted — verify the exception regex before wording the contract line).
- Lanes on main: 139 parallel + 35 serial = 174; `docs/supervisor-e2e-checklist.md` states the count twice.

## Design

### 1. Per-task journal files

- `docs/state/<TASK-ID>.md` (TASK-ID = `LA_TASK_ID`, e.g. `FOC-904`), created by `scripts/state-journal.mjs init`
  with a header `# <TASK-ID> — journal` + a metadata block (`Task: <id>`, `Session: <sessionId|->`, `Run: <runId>`,
  `Branch: <branch|->`, `PR: -`, `Status: in progress`) and appended with `scripts/state-journal.mjs add --text
  "<entry>"` (heading `## <YYYY-MM-DD HH:MM> — <first line>`; body = the rest). `set --field PR=… | Status=… |
  Branch=…` updates a metadata line in place. All values derived from the env when omitted (`LA_TASK_ID`,
  `FENIX_SUPERVISOR_SESSION_ID`, `LA_SUPERVISOR_RUN`); no env and no `--task` → exit 2. The file is append-only for
  entries (the CLI never rewrites past headings). Paths: `<laRoot>/docs/state/` (`LA_ROOT`, else the repo root).
- One contract line in `agents/supervisor/CLAUDE.md` (Mateusz-owned): "Journal: task-scoped entries go to the task
  file through `node "$LA_ROOT/scripts/state-journal.mjs" add --text "…"` (`docs/state/<TASK-ID>.md`, append-only);
  `docs/STATE.md` keeps the standing rules and global decisions — its index block is generated, never edited by hand."
  (`config-drift`: the mandated command must have an allow rule — `Bash(node:*)` exists; the quoted path has `<TASK-ID>`.)

### 2. Generated index in STATE.md — `scripts/state-index.mjs`

- Markers `<!-- state-index:start -->` / `<!-- state-index:end -->`; `render` prints the block, `--write` replaces the
  block in `docs/STATE.md` (inserts it right after the header block — before the first `## ` entry heading — when the
  markers are missing); `--check` exits 1 when the committed block differs (CRLF-normalised compare).
- Block content: `## Task journals (generated)` + one line per `docs/state/*.md`: `- <TASK-ID> — <Status> — last
  entry <date> — <Branch> — <PR>` (fields from the metadata block and the last `## ` heading), sorted by last-entry
  date desc, then id. Deterministic. Everything outside the markers is untouched.

### 3. Merge rule — `supervisor-merge.mjs`

Journals are per task, so two sessions never edit the same journal file. After each successful child replay the tool
runs `state-index.mjs --write` in the scratch tree and commits the regenerated block when it changed (`docs(state):
regenerate task journal index`). When a replay fails and the ONLY conflicted file is `docs/STATE.md` and every
conflict hunk lies inside the index markers, the tool resolves it (`git checkout --ours docs/STATE.md`, regenerate,
`git add`, `git commit --no-edit`) and continues; any hunk outside the markers keeps today's behaviour (abort, report).

### 4. Briefing line

`supervisor-status.mjs --briefing`: when `LA_TASK_ID` is set, `journal: docs/state/<id>.md (<n> entries, last
<date>)` or `journal: none yet — node scripts/state-journal.mjs init`; JSON field `journal: { path, entries, lastAt }
| null`. Existing fields and lines untouched.

### 5. Follow-up noted, not done here

After #86 merges, the `state-md` resolver reads `docs/state/<issue>.md` first, then `docs/STATE.md` (same label
rule). Historical STATE.md entries stay where they are.

## Tests

- `scripts/state-journal.test.mjs` (new, parallel): init creates the file with the metadata block (env-derived and
  `--task`), add appends with the heading format and never rewrites earlier content, set updates one field in place,
  no task → exit 2, a second init is a no-op.
- `scripts/state-index.test.mjs` (new, parallel): render deterministic and sorted; `--write` inserts markers after the
  header when missing and leaves every other byte untouched (byte compare of the parts outside the block);
  idempotent; `--check` exit codes.
- `scripts/supervisor-merge.test.mjs`: two children each adding their own journal file and both touching the index
  block → replay succeeds, block regenerated once; a child conflicting in STATE.md outside the block → still fails
  with the file listed.
- `scripts/supervisor-status.test.mjs`: journal line/field present and absent.
- `config-drift` green with the contract line; lanes + checklist 176 = 141 + 35.

## Docs

`docs/task-journals.md` (≤50 lines): why per task, the file format, the three CLI verbs, the generated block and
`--check`, the merge rule, what stays in STATE.md; `docs/supervisor-e2e-checklist.md` one bullet + counts; this plan.

## Out of scope

Migrating historical STATE.md entries; Linear status sync from the journal; the `state-md` resolver change (follow-up).
