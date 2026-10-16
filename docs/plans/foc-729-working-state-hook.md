# FOC-729 — Agent working state 3/5: the WORKING STATE block survives compaction

Parent FOC-470 (M5). PRD `docs/prd/agent-working-state-prd.md` §3, §8. Builds on FOC-727 (store, PR #85) and
FOC-728 (registry + resolvers, PR #86); this branch is stacked on `foc-728-agent-state-registry`.

## Facts (recon 2026-10-16)

- Claude Code fires `SessionStart` hooks on startup, resume, clear and compact; the payload on stdin carries
  `hook_event_name`, `session_id`, `source` (`startup|resume|clear|compact`). Nothing in `scripts/` parses `source`
  yet; `telemetry-hook.mjs` / `supervisor-session-hook.mjs` read stdin tolerantly (`readFileSync(0)`, JSON.parse in
  try/catch) and never exit non-zero.
- Supervisor: `agents/supervisor/settings.json` `hooks.SessionStart` = one entry with three commands
  (`telemetry-hook.mjs`, `supervisor-status.mjs --briefing`, `supervisor-session-hook.mjs SessionStart`), hand-maintained;
  no test pins that list. The briefing finds its run through `LA_SUPERVISOR_RUN` only and exits 0 when there is none.
- Children: every turn `prepareAgentLaunch` copies `agents/<squad>/settings.json` (one SessionStart hook:
  `telemetry-hook.mjs`) into the per-turn `CLAUDE_CONFIG_DIR`; a second, deny-only layer
  `childSettingsPath(runId, childId)` is built by `buildChildSettings(squadSettings, extraSettings)`
  (`supervisor-lib.mjs:1516`) and passed as `--settings`; it deliberately carries no hooks today
  (`supervisor-spawn.test.mjs` "the generated file is deny-only — no allow, no hooks").
- The child env is inherited by hooks: `LA_SUPERVISOR_RUN`, `LA_SUPERVISOR_CHILD`, `FENIX_STAGE` (= role),
  `LA_TASK_ID`, `LA_ROOT`.
- Spawn builds the PINNED STATE from `gitRoot`, `process.env.LA_ROOT`, `worktree.{worktree,branch,baseRevision}`,
  `taskId`, `runId`, `childId` (`supervisor-spawn.mjs:952-968`) and records `pinnedStateVerification` in the registry.
  Test seams: `LA_CLAUDE_BIN=scripts/mock-claude.mjs`, `LA_SUPERVISOR_NO_TELEMETRY=1`, `LA_SUPERVISOR_NO_CODEGRAPH=1`,
  `LA_SUPERVISOR_STATE_HOME`; fixture env in `scripts/supervisor-test-fixtures.mjs` `baseEnv()`.
- Record-own-invocation precedents: JSONL under the run dir (`wake-queue.jsonl`).

## Design

### Store location

The store path follows a three-level precedence: `LA_AGENT_STATE_DB` > `LA_SUPERVISOR_STATE_HOME/agent-state/agent-state.sqlite` >
`<stateRoot>/agent-state/agent-state.sqlite`. The Supervisor's state home is the one directory that follows the
deployment (the `/data` volume in Docker, a temp dir in every test that redirects the Supervisor), so the store
must live next to it — tests that redirect `LA_SUPERVISOR_STATE_HOME` are then isolated automatically; eight
spawn-invoking test files with their own env builders would otherwise write `<repo>/.state/agent-state/`.

### `scripts/agent-state-hook.mjs` (new) — the SessionStart hook

`node "$LA_ROOT/scripts/agent-state-hook.mjs" SessionStart`, reads the payload from stdin (tolerant; `source`
is taken verbatim only when it is a non-empty string, else `startup`), and:

1. Picks the namespace and role from the env: `LA_SUPERVISOR_CHILD` set → `child:<LA_SUPERVISOR_RUN>/<child>`, role
   `FENIX_STAGE` (must be a squad role, else `unavailable`); otherwise the Supervisor: run id = `LA_SUPERVISOR_RUN`,
   else the current-run pointer (`readCurrentRun()` from `supervisor-current-run.mjs`); no run id →
   `WORKING STATE unavailable: no run id`.
2. Opens the store (`agentStatePath(env)`), loads the registry, runs `resolveRole` OFFLINE — the env handed to the
   resolvers has `LINEAR_API_KEY`, `LINEAR_API_KEY_PISI` and `LINEAR_WORKSPACE` removed and no fixture, so a hook
   never touches the network (Linear facts arrive through spawn seeding, an explicit `resolve`, or a hold answer).
   This refreshes `refresh: always` keys and fills newly resolvable ones; holds follow the FOC-728 dedup rule.
3. Renders `renderFacts` (default caps) and prints the block to stdout — that is what Claude Code adds to the
   context. When the namespace has no facts at all the block is still printed (header only) so the agent learns the
   store exists.
4. Appends one row to `<runDir>/agent-state-renders.jsonl` (run dir of the namespace's run; skipped for `session:`
   namespaces or when the dir is missing): `{ at, namespace, role, source, lines, omitted, bytes, resolved, missing }`
   where `resolved`/`missing` are counts — the measurement input for FOC-731.
5. Any failure anywhere (bad registry, unreadable store, resolver crash, write error) → prints exactly one line
   `WORKING STATE unavailable: <reason>` to stdout and exits 0. The hook never exits non-zero and never prints to
   stderr except the `node:sqlite` warning.

Exports for tests: `runHook({ argv, env, stdin, stdout, now })` → `{ code: 0, text, record | null }`; the main guard
calls it with the real streams. `LA_AGENT_STATE_NOW` is honoured like the other CLIs.

### Supervisor wiring

`agents/supervisor/settings.json` `hooks.SessionStart[0].hooks` gets a fourth command after the briefing:
`{ "type": "command", "command": "node \"$LA_ROOT/scripts/agent-state-hook.mjs\" SessionStart", "timeout": 10 }`.
(The ticket scopes this edit; it is called out in the PR.)

### Child wiring

`buildChildSettings(squadSettings, extraSettings)` adds `hooks.SessionStart = [{ hooks: [ <the same command> ] }]` to
the deny-only file — the squad file's own telemetry hook is NOT repeated (double registration), and this command is
unique to the child-settings layer, so it registers once. The child's namespace and role come from the inherited env;
the command carries no arguments beyond the event name. The spawn test "deny-only — no allow, no hooks" becomes
"deny list plus exactly the working-state SessionStart hook".

### Spawn seeding — `scripts/agent-state-seed.mjs` (new) + a small `supervisor-spawn.mjs` edit

`seedPinnedState(store, { namespace, registry, values, now, actor = "supervisor-spawn" })` writes tier-base facts
with `source: "spawn"`, evidence `supervisor-spawn PINNED STATE`, for every key of `values` that the registry declares
for the `child` set or `all` (undeclared keys are skipped and reported), through `setFact` (unchanged values are not
rewritten). Returns `{ seeded: [keys], skipped: [keys] }`.

`supervisor-spawn.mjs`, right after the PINNED STATE prologue is built (~:968): `values = { repo: basename(gitRoot),
la_root: process.env.LA_ROOT || null, run_id: runId, role: squad, issue: taskId, worktree, branch, base_revision }`
→ open the store at `agentStatePath(process.env)`, `seedPinnedState`, close; wrapped in try/catch — a failure writes
one stderr line `agent-state: seeding skipped (<reason>)` and spawn continues (the store must never block a spawn).
The registry record gets `workingStateSeeded: { at, keys }` through the existing `updateChild` call (or
`{ at, keys: null, error }` on failure). `baseEnv()` in `scripts/supervisor-test-fixtures.mjs` gains `LA_AGENT_STATE_DB`
under the fixture's temp dir so no test writes the real `.state/agent-state/` (isolation audit).

### Kickoff prologue

Stays as is: the prologue is built from the same spawn variables that are seeded, and both sides read `LA_ROOT`
only (the prologue already renders `laRoot = process.env.LA_ROOT || null` as "(unset)"; the seed carries the same
rule — an unset `LA_ROOT` seeds nothing, no gitRoot fallback), so the store and the prologue agree by construction;
rendering the prologue FROM the store is not needed for this task.

## Tests

- `scripts/agent-state-hook.test.mjs` (new, parallel lane): (1) child namespace with seeded base keys, payload
  `{ "hook_event_name": "SessionStart", "source": "compact" }` → stdout starts with `=== WORKING STATE ===`, every
  base key of the namespace is present, exit 0, one `agent-state-renders.jsonl` row with `source: "compact"` and
  `lines`/`bytes` matching the text; (2) Supervisor namespace from `LA_SUPERVISOR_RUN` with a fixture `docs/STATE.md`
  → `state-md` keys appear with source `state-md`; (3) no run id → `WORKING STATE unavailable: no run id`, exit 0,
  no record; (4) an unreadable store (a directory where the file should be) → `WORKING STATE unavailable: …`, exit 0;
  (5) malformed stdin → block printed, `source` recorded as `startup`; (6) over-cap store (3 base + 60 agent keys) →
  all base lines present, tail line, record `omitted > 0`; (7) `LINEAR_API_KEY=dummy` in the env, no fixture → exit 0,
  no `issue_title`, the hook finishes in under 5 s (offline); (8) `FENIX_STAGE=bogus` with a child id → unavailable.
- `scripts/supervisor-spawn.test.mjs`: the deny-only case updated; new case "spawn seeds the child's base keys from
  PINNED STATE" (after a mock-claude spawn, the store at `LA_AGENT_STATE_DB` holds `repo`, `la_root`, `run_id`,
  `role`, `issue`, `worktree`, `branch`, `base_revision` for `child:<run>/<childId>` with source `spawn`, and the
  registry record carries `workingStateSeeded.keys`); new case "a broken store never blocks a spawn"
  (`LA_AGENT_STATE_DB` pointing into a directory path → spawn still succeeds, record has
  `workingStateSeeded: { at, keys: null, error }`).
- `scripts/agent-state-seed.test.mjs` is NOT needed: `seedPinnedState` is covered through the spawn cases plus one
  direct case inside `agent-state-hook.test.mjs` (undeclared keys skipped).

## Docs

This plan; `docs/agent-state.md` section "SessionStart injection" (what the hook does, offline rule, the renders
JSONL, the Supervisor and child wiring, the `unavailable` line); checklist count 177 = 142 parallel + 35 serial.

## Out of scope

The skill, deny rules for raw store writes and task-close prune (FOC-730); measurement (FOC-731); rendering the
kickoff prologue from the store; interactive non-Fenix sessions.
