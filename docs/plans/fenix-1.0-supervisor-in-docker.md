# Fenix 1.0 — the Supervisor usable in Docker (FOC-770, FOC-776) and editable agent records

Date: 2026-10-12. Parent: [PRD 1.0.0](../prd/fenix-1.0.0-release-prd.md), epic FOC-768.

## Goal

After `fenix up` and `fenix repo add`, the Supervisor in the container takes a real Linear ticket in the user's repository end to end, and a restart or recreate of the containers loses nothing: transcripts, approvals, registry, telemetry, the Supervisor's own session.

## Findings (recon 2026-10-12)

1. **Seven scripts ignore `LA_TELEMETRY_HOME`.** `supervisor-budget`, `verdict-evidence`, `delegation-outcomes`, `context-attribution`, `telemetry-prune`, `telemetry-usage-rewrite` and `check-transcript-retention` build the store path from `LOCALAPPDATA` themselves (they honour only `LA_TELEMETRY_DB`). In the container that resolves to `/home/node/AppData/Local/...`, so budget checks and verdict evidence read an empty store. `telemetry-spool-prune` and `reward-ledger` do the same for their directories.
2. **Squad config dirs live in the image layer.** `CLAUDE_CONFIG_DIR = <repo>/agents/<squad>` at four call sites (`supervisor-spawn` ×2, `supervisor-followup`, `mcp-enable`). Transcripts, MCP approvals and the Supervisor's session are lost on every recreate (`fenix down`, `fenix update`).
3. **Worktrees** are `../la-wt/<repo>/<branch>` next to the target repo (`supervisor-lib` `worktreeRoot`), the merge integration tree `../la-wt/<branch>` (`supervisor-merge`).
4. **Target repos** come from `config/projects.json` (Linear project → `${GITHUB_ROOT}/<repo>`); `GITHUB_ROOT` is unset in the container and `/opt/fenix` has no `.git`.
5. **Squads call `gh`** (dev, plan, review, supervisor prompts and allow lists); the image has no `gh`.
6. **`fenix attach` starts a fresh session**, and interactive Claude Code shows first-run onboarding and the folder-trust dialog.
7. Fixed separately (PR #56): `.dockerignore` let squad runtime data — including `.credentials.json` — into the build context.

## Phase A — FOC-770: one paths module (no decisions needed)

`scripts/fenix-paths.mjs` resolves every location from env; Windows defaults stay byte-identical to today.

| Function | Env override | Windows default | POSIX default |
|---|---|---|---|
| `dataHome()` | `LA_DATA_HOME` | `%LOCALAPPDATA%\linear-agents` | `$XDG_DATA_HOME/linear-agents` or `~/.local/share/linear-agents` |
| `telemetryHome()` | `LA_TELEMETRY_HOME` | `<data>/telemetry` | same |
| `telemetryDbPath()` | `LA_TELEMETRY_DB` | `<telemetry>/telemetry.sqlite` | same |
| `rewardsHome()` | `LA_REWARDS_HOME` | `<data>/rewards` | same |
| `squadConfigDir(squad)` | `LA_SQUAD_HOME` | `<repo>/agents/<squad>` | same |
| `worktreeRoot(gitRoot)` | `LA_WORKTREE_HOME` | `<gitRoot>/../la-wt/<repo>` | same |
| `integrationTreePath(mainRepo, name)` | `LA_WORKTREE_HOME` | `<mainRepo>/../la-wt/<name>` | same |

All runtime callers migrate; a guard test fails if `LOCALAPPDATA`, `"AppData"` or a `"la-wt"` literal reappears in runtime code outside the module. Acceptance: suite green on Windows and Linux.

## Phase B — FOC-776: the Supervisor at home in the container

Container env: `LA_DATA_HOME=/data`, `LA_SQUAD_HOME=/data/agents`, `GITHUB_ROOT=/data/workspaces`, `LA_WORKTREE_HOME=/data/workspaces/la-wt`.

- **B1 Squad config on the volume** — seeded from the image at every start (rule: D3).
- **B2 Repositories** — `fenix repo add <url|owner/name>`, `fenix repo list` (D1); the project map (D2).
- **B3 Credentials in the container** — a git credential helper that answers from `GITHUB_TOKEN` in memory (never written to disk); `gh` added to the image (`GH_TOKEN` is already exported).
- **B4 Supervisor session** — works from `/data/workspaces` (D4); `fenix attach` resumes the last session (D5); onboarding and folder trust pre-seeded in the Supervisor's `.claude.json`; a real liveness check (data dir writable, API reachable).
- **B5 Acceptance** — both services healthy; `fenix repo add` of a public repo; restart and recreate keep transcripts, registry, telemetry and the session; killing the supervisor container mid-turn loses no registry or telemetry data (FOC-776 AC2); suite green on Linux and Windows.

Implemented in FOC-776; the project map lives in `.fenix/config/projects.json` (a mounted directory — Docker turns a missing single-file mount into a directory, and the container writes the file). Acceptance results and follow-ups: FOC-799.

## Phase C — edit the agent's persisted records while it works (new, Mateusz 2026-10-12)

What agents write and later read lives in the run dir: gates (`gates/*.json`: `summary`, `questions`, `facts`, `artifacts`, `answer`), `triage.json` / `intake.json`, briefs and prompts for children (`*-kickoff.md`, `*-fix-N.md`), per-child settings (`child-settings-*.json`), verdicts (`verdicts/*.json`, evidence).

- The Work ticket detail gets a **Records** panel: every persisted record of the ticket's run, live, with an edit form for the fields that exist.
- Writes go through the API with optimistic concurrency (the file's hash at read time must still match), an audit entry (field, old → new, who, when) kept next to the record, and a notice queued to the Supervisor's wake queue so the agent re-reads instead of acting on its in-context copy.
- Verdicts stay read-only (evidence); an override is a separate, audited annotation.

Ticket: FOC-795 (M8). Open questions are listed there and in the decisions below.

## Decisions (Mateusz, 2026-10-12)

1. **D1 Repos** — `fenix repo add` clones into the volume inside the container, with the token from memory via a credential helper; bind-mounting a host repo is an advanced option later. — decided as recommended
2. **D2 Project map** — a user-owned `.fenix/projects.json` (same shape as `config/projects.json`), mounted read-only and preferred over the repo's file; `fenix repo add --project <Linear project>` writes the entry; Settings (FOC-786) edits it later. — decided as recommended
3. **D3 Squad config seeding** — the dpkg rule: a config file you never edited follows the image on every start; one you edited (e.g. in the dashboard prompt editor) is kept and reported. — decided as recommended *(alternatives considered: always overwrite — loses edits; copy only missing — never gets updates)*
4. **D4** — the Supervisor works from `/data/workspaces`; `linear-agents` itself is cloned there like any repo when Fenix should work on its own tickets. — decided as recommended
5. **D5** — `fenix attach` resumes the last Supervisor session; `fenix attach --new` starts a fresh one. — decided as recommended
6. **C1–C4** (Phase C) — C1 scope in 1.0: as wide as possible — every persisted record type; C2 notice via the wake queue; C3 audit always on; C4 verdicts read-only + audited annotation.

## Out of scope here

Dashboard chat (FOC-783), provider switch UI (FOC-773), optional integrations (FOC-772), generated artifacts (FOC-779), retention settings (FOC-780).
