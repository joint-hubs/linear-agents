# FOC-730 — Agent working state 4/5: agents know how (skill, contract lines, prune at task close, no raw writes)

Parent FOC-470 (M5). PRD `docs/prd/agent-working-state-prd.md` §3 rules 2–5, §8. Builds on FOC-727/728/729 (PRs #85–#87;
this branch is stacked on `foc-729-working-state-hook`) and on the shared-skills mechanism of FOC-899 (branch
`grilling-skill`, merged into this branch so the skill reaches children at launch and the Supervisor through the tracked
copy). Mateusz's OK for the `agents/**` edits: PRD acceptance 2026-10-16 (Q8 "FOC-730 now") on top of the 2026-10-08 consent.

## Facts (recon 2026-10-16)

- CLI `scripts/agent-state.mjs`: verbs `get|set|list|retire|prune|render|history` (+ `resolve|missing|registry` delegated);
  `--namespace/-n` is mandatory today; `--actor` defaults to `$LA_TASK_OWNER` or `cli`; `prune --namespace --scope
  run|task|turn` → `pruneFacts` retires agent-tier rows whose `expires_at <= now` or whose `scope` equals the given one,
  base keys never. Namespace grammar lives in the hook only (`agent-state-hook.mjs:58-77`): `child:<run>/<child>` from
  `LA_SUPERVISOR_RUN` + `LA_SUPERVISOR_CHILD`, else `supervisor:<run>`.
- Task close (Supervisor side) = `supervisor-cleanup.mjs cmdRemove` (:709): refuses unless the Linear issue is completed,
  then `archiveWorkProduct` (FOC-649, `<stateHome>/<run>/test-artifacts/<childId>`, :606/:653) → `performRemoval`
  (:788 grant path, :875 gated path) → `updateChild(... worktreeRemovedAt ...)` (:734). Run-dir retention = `cmdPrune`
  (:1002, keep 20 runs ∩ 14 days, :964-965).
- Child exit = `supervisor-watch.mjs` `child.on("exit")` (:384): status at :406-407, `updateChild(... status, exitCode
  ...)` at :438-445, then `wake({ event: "exit" })` :456. A child exits at the end of EVERY turn (gates included), so exit
  ≠ task close.
- Deny: `SUPERVISOR_DENY` (`supervisor-lib.mjs:1472-1492`, merged into child settings at :153) uses the shape
  `Bash(node $LA_ROOT/scripts/linear-ops.mjs:*)`; `agent-records.mjs:382-391` lets child deny lists only grow (adding
  entries to `SUPERVISOR_DENY` passes). Supervisor deny list: `agents/supervisor/settings.json` `permissions.deny`.
- `config-drift.test.mjs` pins the contracts: commands mandated in a `CLAUDE.md` must have an allow rule (:104-113),
  `LA_*` variables mentioned must be read somewhere (:130-147), tools referenced must not be denied (:426-430).
- Contract anchors: supervisor Hard rules (:166-170), plan end of "## Tools" (:74-78), dev `<brief_contract>` standing
  reminder (:96), review "## Pętla" verify step (:110), test "## Pętla" (:79) / Hard rules (:106).
- `docs/agent-state.md` headings: Synopsis, Verbs, Rules (:118), Base keys and resolvers, SessionStart injection,
  Exit codes (:342), Environment, What comes next (:371, names FOC-730).

## Design

### 1. Namespace and actor from the environment (small CLI change)

`--namespace` becomes optional for every verb: when omitted, `namespaceFromEnv(env)` applies the hook's rule
(`LA_SUPERVISOR_CHILD` + `LA_SUPERVISOR_RUN` → `child:<run>/<child>`; `LA_SUPERVISOR_RUN` alone → `supervisor:<run>`;
neither → exit 2 `namespace required: pass --namespace or run inside a Supervisor/child session`). `--actor` defaults
to `FENIX_STAGE` (child role) or `supervisor` when `LA_SUPERVISOR_RUN` is set and `LA_SUPERVISOR_CHILD` is not, else the
existing `$LA_TASK_OWNER` / `cli`. The hook keeps its own derivation but calls the same exported helper
(`agent-state-hook.mjs` imports `namespaceFromEnv`). This is what lets the skill show one-line commands.

### 2. New verb `drop`

`drop --namespace <ns> [--yes]` deletes every `facts` and `facts_history` row of the namespace (base keys included —
this is the run-retention lifecycle, not a retire). Refuses without `--yes`; `--json` → `{ namespace, facts, history }`
counts. Used only by `supervisor-cleanup cmdPrune` when a run dir is dropped; documented as operator/cleanup only.

### 3. Skill `agents/_shared/skills/working-state/SKILL.md` (+ tracked Supervisor copy via `shared-skills sync`)

Frontmatter `name: working-state`, `description: Read a known fact from the agent working state before searching
for it; store a fact you will need again in this task; retire it when done.` Body (≤45 lines, English): the WORKING
STATE block at SessionStart is the rendered store; `get` BEFORE searching the context, Linear or git for a known
parameter (issue, branch, worktree, base revision, milestone, epic, run id, role, acceptance criteria ref); `set` an
agent key the moment you learn something you will need again in this task — one-line `--reason`, `--scope task` (default
for task facts) / `--scope turn` (this turn only) or `--ttl <seconds>`; `retire --key` when the value is used and not
needed again; caps 50 agent keys / 2 KB per value; NEVER store secrets (the CLI refuses), long text (store a path),
or anything already in a base key; raw writes to the store file are denied — only the CLI writes; the four commands,
each one line, no `--namespace` (derived from the environment). Example: `node "$LA_ROOT/scripts/agent-state.mjs" get
--key branch`.

### 4. Contract lines (Mateusz-owned files, exactly one line each)

- `agents/supervisor/CLAUDE.md` Hard rules: `Working state: the WORKING STATE block at session start is the agent-state
  store; follow the \`working-state\` skill — \`get\` a known parameter before searching for it, \`set\` what you will need
  again in this task, never write the store file directly.`
- `agents/plan/CLAUDE.md` end of "## Tools", `agents/dev/CLAUDE.md` standing reminder in `<brief_contract>`,
  `agents/review/CLAUDE.md` "## Pętla" verify step, `agents/test/CLAUDE.md` "## Pętla": the same sentence shortened
  to one line (`Working state: follow the \`working-state\` skill — get before searching, set what you need again,
  never write the store file directly.`). The lines name the skill, not the script, so `config-drift` (:104-113)
  has nothing new to match.

### 5. Prune at the right moments

- `supervisor-watch.mjs` after the `updateChild` of the exit block (:445): `prune --scope turn` on
  `child:<run>/<child>` through the library (`openAgentState` + `pruneFacts`), wrapped in try/catch — a store failure
  writes one stderr line and never blocks the wake. Record `{ at, retired }` in the child record field
  `workingStatePruned.turn`.
- `supervisor-cleanup.mjs cmdRemove`, after `performRemoval` on both paths: (1) export the child namespace
  (`listFacts` active + retired, `historyFacts`) to `<archiveDir>/agent-state.json` next to the FOC-649 work product;
  (2) `pruneFacts(scope: "task")` then `pruneFacts(scope: "turn")` on the child namespace; (3) when the registry has no
  child left whose worktree is not removed, `pruneFacts(scope: "task")` on `supervisor:<run>`. Record
  `workingStatePruned.task` on the child.
- `supervisor-cleanup.mjs cmdPrune`: when a run dir is dropped by retention, `drop` the namespaces `supervisor:<run>`
  and every `child:<run>/*` (one SQL `LIKE` per run) — reported in the prune summary as `agentState: { namespaces }`.
- Skipped silently when the store does not exist (`agentStatePath` missing) — old runs predate the store.

### 6. Deny rules for raw writes

Added to `SUPERVISOR_DENY` (children) and to `agents/supervisor/settings.json` `permissions.deny` (Supervisor):
`Bash(sqlite3 *agent-state*)`, `Bash(node -e *agent-state*)`, `Bash(node --eval *agent-state*)`,
`Edit(//**/agent-state.sqlite)`, `Write(//**/agent-state.sqlite)`. Rationale comment next to `SUPERVISOR_DENY` with the
documented caveat (prefix/text match, not a sandbox).

## Tests

- `scripts/agent-state.test.mjs`: namespace from env (child, supervisor, neither → exit 2), actor default, `drop`
  (counts, refuses without `--yes`, base rows gone, other namespaces untouched).
- `scripts/supervisor-watch.test.mjs`: after a mock child exit, turn-scope keys retired, task-scope and base keys kept,
  `workingStatePruned.turn` recorded; a store pointing at a directory → exit still recorded, one stderr line.
- `scripts/supervisor-cleanup.test.mjs`: fixture run + completed Linear fixture → `cmdRemove` archives
  `agent-state.json`, retires task+turn keys of the child, prunes `supervisor:<run>` task keys when it was the last
  child; `cmdPrune` dropping a run deletes its namespaces and reports them.
- `scripts/supervisor-spawn.test.mjs`: the child settings deny list contains the five raw-write rules; `agent-records`
  tighten-only still passes.
- `scripts/shared-skills.test.mjs` real-tree case covers the Supervisor copy of `working-state`;
  `config-drift.test.mjs` passes with the five contract lines.

## Docs

This plan; `docs/agent-state.md` new section "Agents: how to use it (FOC-730)" (skill summary, env-derived namespace,
prune moments table, `drop`, deny rules) + Verbs/Exit codes updated; `docs/agent-skills.md` vendored/own table gains
`working-state`; checklist count unchanged unless a test file is added.

## Out of scope

Measuring the effect (FOC-731); `prune` policies beyond scope/ttl; editing `agents/cadence|orchestrator` contracts
(not Supervisor children).

## Revisions

2026-10-16 review: Edit/Write rules anchored with `//` — a bare `**/` pattern only reaches the current directory.
