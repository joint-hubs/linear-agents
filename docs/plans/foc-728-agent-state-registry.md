# FOC-728 — Agent working state 2/5: base keys per role, deterministic resolvers, unresolved → hold

Parent FOC-470 (M5). PRD `docs/prd/agent-working-state-prd.md` §3, §6–§7. Builds on the FOC-727 store
(`scripts/agent-state.mjs`, PR #85): this branch is stacked on `foc-727-agent-state`.

## Facts (recon 2026-10-16)

- Holds (FOC-612) live in `<run dir>/holds.json`; `supervisor-lib.mjs` exports `readHolds`, `writeHolds`,
  `nextHoldId`, `patchHold`, `openHolds`, `validateHoldStore`; the record is `{ id, origin, question, options[]
  ({ label, costUsd }), recommendation, impact, resolution, state open|answered, createdAt, presentedAt, until,
  answer { text, answeredAt } | null, blocks, history[] }`. Only `supervisor-gate.mjs` wrote holds so far (inline).
- A child sees at runtime: `FENIX_STAGE` (its squad = role), `LA_SUPERVISOR_RUN`, `LA_SUPERVISOR_CHILD`,
  `LA_TASK_ID`; the registry `<run dir>/children.json` (`readRegistry(runId).children[childId]`) carries
  `worktree`, `branch`, `baseRevision`, `taskId`, `squad`. No milestone/epic/project anywhere at spawn.
- `scripts/linear-client.mjs` exports `graphql(query, vars, workspace)`; its issue queries carry `parent` but no
  `project` / `projectMilestone`. `config/projects.json` maps `repo` → `linearProject`, `workspace`, `teamKey`.
- Git helpers: `git(args, cwd)`, `resolveGitRoot(cwd)` in `supervisor-lib.mjs`.
- No machine-readable queue head, known reds, push policy or landing flow exists in `docs/STATE.md` or config.
- ajv is a dependency; `scripts/autonomy-grants.mjs` validates a hand-edited config with an inline schema and
  throws naming the offending path — the pattern for `config/agent-state.json`.

## Design

### Registry — `config/agent-state.json` (Mateusz-owned, validated at load)

```json
{ "version": 1,
  "roles": {
    "all":        { "<key>": "<entry>", "...": "..." },
    "supervisor": { "...": "..." },
    "child":      { "...": "..." } } }
```

`<entry>` = `{ "description": string, "resolvers": [<resolver>...], "askIfMissing": boolean,
"refresh": "once" | "always" }`. Roles: `all` applies to every role; `supervisor`; `child` applies to the squad
roles `plan|dev|review|test`. Keys match the store's key regex. A key present in two role sets is an error.

Resolver kinds (deterministic; each yields `{ value, source, evidence }` or null):

| kind | args | source | evidence |
|---|---|---|---|
| `arg` | `name: "role"` | `spawn` | `resolve --role` |
| `env` | `name` | `spawn` | `env <name>` |
| `current-run` | — | `spawn` | `current-run.json` |
| `registry` | `field` (`worktree` `branch` `baseRevision` `taskId` `squad` `candidate`) | `spawn` | `children.json <childId>.<field>` |
| `git` | `fact` (`root` `branch` `head`) | `git` | `git <command>` |
| `git-basename` | — | `git` | `git rev-parse --show-toplevel` |
| `linear` | `issueKey` (a resolved key holding an identifier), `field` (`title` `project` `projectMilestone` `parent` `team`) | `linear` | `linear issue <id> → <field>` |
| `projects-config` | `field` (`linearProject` `workspace` `teamKey`) — entry matched by the resolved `repo` | `config` | `config/projects.json projects[repo=<repo>].<field>` |
| `state-md` | `label` — first line of `docs/STATE.md` matching `^\s*[-*]?\s*<label>:\s*(.+)$` | `state-md` | `docs/STATE.md:<line>` |
| `const` | `value` | `config` | `config/agent-state.json const` |
| `template` | `value` with `{key}` placeholders over already-resolved keys | `config` | `config/agent-state.json template` |

Starting set (the PRD's §7 list):

- all: `repo` (git root, basename) · `la_root` (env `LA_ROOT`, then git root) · `run_id` (env `LA_SUPERVISOR_RUN`, then
  the current-run pointer) · `role` (arg) · `linear_team` (projects-config `teamKey`, then env `LINEAR_TEAM_KEY_FEN`) ·
  `linear_project` (projects-config `linearProject`).
- supervisor: `active_issue` (state-md `Active issue`, ask) · `active_milestone` (linear projectMilestone of
  `active_issue`, ask) · `active_epic` (linear parent of `active_issue`, ask) · `queue_head` (state-md `Queue head`,
  ask) · `landing_flow` (const `branch → PR → Mateusz merges on GitHub`) · `push_policy` (const `feature branches
  only; never main; no force`) · `cost_basis` (const `priced`) · `known_reds` (state-md `Known reds`, ask).
- child: `issue` (env `LA_TASK_ID`, registry `taskId`) · `issue_title` (linear title, ask) · `milestone` (linear
  projectMilestone, ask) · `epic` (linear parent, ask) · `worktree` (registry, then git root) · `branch` (git
  branch — the live truth, then registry `branch` — the spawn-time value; refresh always) · `base_revision` (registry `baseRevision`) · `candidate` (registry `candidate`,
  no ask — not written by spawn yet) · `acceptance_criteria_ref` (template `linear issue {issue} § Acceptance criteria`).

### Modules

- `scripts/agent-state-registry.mjs`: `registryPath(env)` (`LA_AGENT_STATE_REGISTRY` override, else
  `<laRoot>/config/agent-state.json`), `loadRegistry(path)` → validated object or throws
  `AgentStateError("REGISTRY_INVALID", "<path>: …")` naming the offending key/path (ajv inline schema plus
  duplicate-key and unknown-kind checks; fail closed), `keysForRole(registry, role)` → ordered `[[key, entry]]`
  (`all` first, then the role set; roles `plan|dev|review|test` map to `child`).
- `scripts/agent-state-resolve.mjs`: `resolveRole(store, { registry, role, namespace, env, cwd, now, actor })` →
  `{ resolved: [{ key, value, source, evidence, written }], missing: [{ key, askIfMissing, reason }],
  hold: { id, created } | { id, created: false, state } | null, applied: [{ key, holdId }],
  ignored: [{ holdId, key, reason }] }`;
  `missingForRole(store, { registry, role, namespace, env })` → `{ missing: [...], hold: { id, state } | null }`;
  `applyHoldAnswers(store, { registry, namespace, env, now, actor })` →
  `{ applied: [{ key, holdId }], ignored: [{ holdId, key, reason }] }`;
  `fetchIssueFacts(identifier, { env })` (GraphQL `issue(id) { identifier title team { key } project { name }
  projectMilestone { name } parent { identifier title } }` through `linear-client.mjs graphql`, or the recorded
  fixture `LA_AGENT_STATE_LINEAR_FIXTURE` = JSON `{ "<identifier>": { title, team, project, projectMilestone,
  parent } }`; no key and no fixture → null, i.e. unresolved, never a crash); `runCli(argv, { env, stdout, stderr })`
  for the verbs below. Rules: keys resolve in registry order, resolvers in entry order, first non-null wins; a key
  already active in the store is skipped when `refresh: "once"` and re-resolved when `"always"`; a value is written
  through `setFact` (tier base) only when the value or source differs from the stored one (no version churn); a
  value the secret screen refuses counts as missing with the code in `missing[].reason`; an `"always"` key whose
  resolvers all fail keeps its stored active value — reported in `resolved` with `written: false` and `kept: true`,
  never listed in `missing` (resolve and missing agree). When a `linear` resolver's `issueKey` or a `template`
  placeholder names an unresolved key, the consumer's `missing[].reason` is `depends on <key>`. Before resolving,
  `applyHoldAnswers` runs: answered holds whose `origin` is `agent-state resolve <namespace>` are parsed as
  `key=value` lines — the whole text first, last-wins per key, each key written once; lines without `=`
  (reason `no =`), empty values (reason `empty`) and keys outside the registry (reason `unknown key`) are ignored
  and reported as `{ holdId, key, reason }`, never stored — and stored with `source: "user"`,
  `evidence: "hold <id>"`; re-applying the same hold is idempotent. After resolving, when any missing key has
  `askIfMissing`, the keys already asked by every hold with that origin (open or answered) are subtracted from the
  missing set — the question format is strictly parseable (`Working state (<role>, <namespace>): no deterministic
  source for <k1>, <k2>. Answer with one key=value per line.`) and `askedKeysOf(hold)` returns the comma-separated
  key list. Dependency keys (the `depends on <key>` reasons, even when their own `askIfMissing` is false) join the
  asked set so the question names the root cause. If at least one never-asked key remains, ONE hold is written asking only those keys (`nextHoldId` +
  `writeHolds` into the run dir derived from the namespace: `supervisor:<runId>` → runId;
  `child:<runId>/<childId>` → runId):
  `{ origin, question, options: [{ label: "Provide the values", model: "user", costUsd: 0 }], recommendation, impact: "low", resolution: null,
  state: "open", blocks: null, history: [{ event: "created", at }] }`. When nothing new was asked, the newest hold
  with that origin (open or answered) is reported back as `hold: { id, created: false }` — a partially answered
  hold never spawns a follow-up for keys it already asked. The CLI never blocks on the hold — the
  turn-end guard presents it.
- `scripts/agent-state.mjs`: the verbs `resolve`, `missing`, `registry` are delegated by `runCli` through a dynamic
  `import("./agent-state-resolve.mjs")` (no static cycle); the usage text lists them.

CLI: `node scripts/agent-state.mjs resolve --role <r> --namespace <ns> [--cwd <dir>] [--json]`,
`missing --role <r> --namespace <ns> [--json]`, `registry [--json]` (prints the validated key table per role; exit 1
with the offending path on an invalid file). Exit 0 even when keys are missing (missing is a state, not an error);
exit 1 on registry/store errors; exit 2 usage.

## Tests — `scripts/agent-state-resolve.test.mjs` (parallel lane)

Fixture: temp `LA_SUPERVISOR_STATE_HOME` with `<runId>/children.json` for one dev child (`taskId FOC-9`, worktree =
a temp git repo with one commit on branch `foc-9-x`, `baseRevision`); a temp `LA_ROOT` dir with
`config/projects.json` (one entry whose `repo` is the fixture repo name) and `docs/STATE.md`; the real
`config/agent-state.json` copied as `LA_AGENT_STATE_REGISTRY`; a Linear fixture JSON for FOC-9. Cases:
(1) `resolve --role dev` fills every child base key with source + evidence (spawn/git/linear/config/template);
(2) without the Linear fixture `issue_title`/`milestone`/`epic` are missing → exactly one hold in `holds.json`
naming the three keys; a second `resolve` adds no hold; (3) answering the hold (`patchHold` with
`answer.text = "milestone=M5\nepic=FOC-470"`) then `resolve` stores both with `source: user`, evidence
`hold hold-1`; `missing` lists only `issue_title`; (4) invalid registry (unknown kind / duplicate key / missing
description) → exit 1 naming the key; (5) `refresh`: `once` keeps a user value, `always` re-resolves `branch`
after a checkout; (6) supervisor role: `state-md` labels resolve from the fixture `docs/STATE.md`, consts land with
`source: config`; (7) `--json` shapes and the `registry` verb.

## Docs

This plan; `docs/agent-state.md` gains a "Base keys and resolvers" section (registry format, resolver kinds, the
`Active issue:` / `Queue head:` / `Known reds:` lines the Supervisor may keep in `docs/STATE.md`, the hold
round-trip); checklist count 176 = 141 parallel + 35 serial.

## Out of scope

SessionStart injection and spawn-time seeding (FOC-729), the skill and deny rules (FOC-730), a `candidate`
registry field at spawn (FOC-729 or later), extending `supervisor-spawn` to write milestone/epic.
