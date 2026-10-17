# agent-state — CLI reference (FOC-727, task 1/5)

`scripts/agent-state.mjs` is a per-agent working-state store: one SQLite database of small, dated facts
the Supervisor and its children write for each other, addressed as namespace + key — one namespace per
Supervisor run, child, and interactive session. Tier `base` keys form the registry: they require evidence
plus a source, and agents may never retire or overwrite them. Tier `agent` keys are self-managed working
state: each write needs a reason plus a scope or TTL, at most 50 active per namespace, and `prune` retires
expired or scope-ended keys. Every change lands in the append-only `facts_history`.

Values are strings of at most 2048 UTF-8 bytes, screened by the local egress secret screen (FOC-450) before
storage because the rendered block is sent to model providers. The file lives at `agent-state/agent-state.sqlite`
(WAL, gitignored, never inside a task worktree) under the first of: `LA_AGENT_STATE_DB` (the whole path),
`LA_SUPERVISOR_STATE_HOME` (the Supervisor state home — the one directory that follows the deployment, e.g. the
`/data` volume in Docker), or `<stateRoot>`, where `<stateRoot>` is `$LA_STATE_ROOT` or `<repo>/.state`.

## Synopsis

```
node scripts/agent-state.mjs <get|set|list|retire|prune|drop|render|history|resolve|missing|registry> [options]
```

| Flag | Applies to | Meaning | Default |
|---|---|---|---|
| `--namespace`, `-n` | all, except `registry` | `supervisor:<id>` \| `child:<id>/<id>` \| `session:<id>` | required (resolve, missing); otherwise derived from the session env (FOC-730, see below — exit 2 when the env names no namespace) |
| `--key`, `-k` | get, set, retire, history | `^[a-z][a-z0-9_]{0,63}$`; `history` filters to one key | required for get/set/retire |
| `--value`, `-v` | set | the fact, ≤ 2048 UTF-8 bytes, secret-screened | required for set |
| `--tier` | set | `base` \| `agent` | `agent` |
| `--source` | set | `spawn` \| `git` \| `linear` \| `config` \| `state-md` \| `user` \| `agent` | `agent`; required for base |
| `--evidence` | set | why the fact is true (base tier) | required for base |
| `--reason` | set, retire | why the fact exists / is retired (agent tier) | required for set (agent); falls back to the row's reason on retire |
| `--scope` | set, list, prune | `run` \| `task` \| `turn`; filters `list`, targets `prune` | `task` (agent) / `run` (base) |
| `--ttl` | set | non-negative integer seconds; sets `expires_at = now + ttl` | none |
| `--expires-at` | set | explicit ISO expiry (a non-ISO value exits 2) | none |
| `--include-retired` | get | also return a retired row | off |
| `--status` | list | `active` \| `retired` \| `all` | `active` |
| `--limit` | history | the most recent N rows, ascending by id | 100 |
| `--role` | resolve, missing | `supervisor` \| `plan` \| `dev` \| `review` \| `test` | required |
| `--cwd` | resolve | working directory for the git resolvers | process cwd |
| `--actor` | set, retire, prune, resolve | attributed in `facts_history` (resolve: the resolver's writes) | `FENIX_STAGE` for a child, `supervisor` on a Supervisor run, else `$LA_TASK_OWNER` / `cli` |
| `--yes` | drop | confirm the destructive delete | required for drop — without it drop prints one line and exits 2 |
| `--db` | all, except `registry` | store path | `$LA_AGENT_STATE_DB`, else the default path above |
| `--json` | all | machine-readable output | off |

`parseArgs` rule: a value that starts with `-` must be passed as `--value=<text>`; the space form
(`--value -flag`) is rejected as usage with exit 2, as are positional arguments beyond the verb,
a non-integer `--ttl`/`--limit`, and a non-ISO `LA_AGENT_STATE_NOW` / `--expires-at`.

## Verbs

**get** — returns one fact and bumps its `read_count` / `last_read_at` (reads are not history rows).

```
$ node scripts/agent-state.mjs get --namespace supervisor:run-42 --key active_milestone
active_milestone=M5 agent platform
(base, config, run, version 1)
```

`--json` prints `{ "ok": true, "verb": "get", "row": { "key": ..., "value": ..., "tier": ..., "version": ... } }` — the full facts row.

**set** — inserts or updates a fact (update keeps `created_at`, bumps `version`, re-activates a retired agent key).

```
$ node scripts/agent-state.mjs set --namespace supervisor:run-42 --key current_focus \
    --reason "supervisor picked the next issue from the queue" --scope task --ttl 3600 --value "FOC-727 store"
set current_focus (v1, set)

$ node scripts/agent-state.mjs set --namespace supervisor:run-42 --key active_milestone \
    --tier base --source config --evidence "linear-query issue FOC-714 -> projectMilestone" --value "M5 agent platform"
set active_milestone (v1, set)
```

`--json` prints `{ "ok": true, "verb": "set", "row": { ... }, "op": "set" | "update" }`.

**list** — rows of the namespace, base tier first, then key order.

```
$ node scripts/agent-state.mjs list --namespace supervisor:run-42
active_milestone: M5 agent platform  [base/run/active]
current_focus: FOC-727 store  [agent/task/active]
```

**retire** — marks an agent key retired (agent keys only; a base key is refused and nothing changes —
no history row).

```
$ node scripts/agent-state.mjs retire --namespace supervisor:run-42 --key current_focus --reason "task closed"
retired current_focus
$ node scripts/agent-state.mjs retire --namespace supervisor:run-42 --key active_milestone
agent-state: base key supervisor:run-42/active_milestone cannot be retired (BASE_KEY_PROTECTED)   # exit 1
```

**prune** — retires active agent keys whose `expires_at <= now`, plus all active agent keys of `--scope`
when given; base keys are never touched.

```
$ node scripts/agent-state.mjs prune --namespace supervisor:run-42 --scope task
pruned 1 key(s): current_focus
```

**drop** — deletes every `facts` and `facts_history` row of exactly one namespace, inside one
transaction — tier included: a base key in that namespace dies too, because the namespace itself is
going away (run retention). Refuses without `--yes` (exit 2, one line, nothing deleted).

```
$ node scripts/agent-state.mjs drop --namespace supervisor:run-42 --yes
dropped supervisor:run-42 (3 fact row(s), 5 history row(s))
```

**render** — the `=== WORKING STATE ===` block injected into context. `--json` prints
`{ "ok": true, "verb": "render", "text": ..., "lines": ..., "omitted": ... }`.

```
$ node scripts/agent-state.mjs render --namespace supervisor:run-42
=== WORKING STATE ===
active_milestone: M5 agent platform  (config, updated 2026-10-16T13:03:30.415Z)
current_focus: FOC-727 store  (agent, updated 2026-10-16T13:03:30.503Z)
```

**history** — `facts_history` rows for the namespace (optionally one `--key`); `--limit` returns the
most recent N rows, ascending by id (default 100).

```
$ node scripts/agent-state.mjs history --namespace supervisor:run-42
1 2026-10-16T13:03:30.415Z set active_milestone by cli
2 2026-10-16T13:03:30.503Z set current_focus by cli
```

## Rules

| Rule | Value |
|---|---|
| Namespace regex | `^(supervisor:[A-Za-z0-9._-]+|child:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+|session:[A-Za-z0-9._-]+)$` |
| Key regex | `^[a-z][a-z0-9_]{0,63}$` |
| Value cap | 2048 UTF-8 bytes (`VALUE_TOO_LONG`); secret-screened (`VALUE_SECRET_SHAPED`, nothing stored) |
| Tier | `base` (registry, evidence + source required, protected) \| `agent` (working state, reason required) |
| Source | `spawn` \| `git` \| `linear` \| `config` \| `state-md` \| `user` \| `agent` |
| Scope | `run` \| `task` \| `turn` (default `run` for base, `task` for agent) |
| Agent key cap | 50 active per namespace (`AGENT_KEY_CAP`); guards new keys and re-activations, not updates of live rows |
| `prune` retires | active agent keys with `expires_at <= now`, plus all active agent keys of `--scope` when given |
| `render` guarantees | header line `=== WORKING STATE ===`; base keys first (alphabetical) and never cut; agent lines by `last_read_at` desc (unread last), then `updated_at` desc; `\n` and `\r` in values escaped as literal `\n` / `\r`; caps 60 lines / 6144 bytes with the `N more — use agent-state get` tail counted inside them; deterministic for the same store |

## Agents: how to use it (FOC-730)

The `=== WORKING STATE ===` block at SessionStart is this store, rendered. The `working-state` skill
(`agents/_shared/skills/working-state/SKILL.md`, synced into every launch dir) is the how-to; the
contract lines in each role's CLAUDE.md point at it: **get a known parameter before searching for it,
set what you will need again, never write the store file directly.**

**Namespace and actor come from the session env** — agents do not pass `--namespace`:

| Session env | Namespace | Actor (`--actor` default) |
|---|---|---|
| `LA_SUPERVISOR_CHILD` + `LA_SUPERVISOR_RUN` | `child:<run>/<child>` | `FENIX_STAGE` (the squad role) |
| `LA_SUPERVISOR_RUN` alone | `supervisor:<run>` | `supervisor` |
| neither | the CLI exits 2 rather than guessing | `$LA_TASK_OWNER`, else `cli` |

**Prune moments** — the store prunes itself at the boundaries a working state naturally ends at; the
Supervisor and its scripts drive it, agents do nothing:

| Moment | What happens | Where |
|---|---|---|
| Turn end (child exit) | `prune --scope turn` on the child namespace; recorded as `workingStatePruned.turn` | `supervisor-watch.mjs` |
| Task close (`cleanup remove`) | the child namespace is exported to `<archive>/agent-state.json` (`{ namespace, exportedAt, facts, history }`), then `prune --scope task` + `--scope turn`; when the removed child was the run's last standing worktree, the supervisor namespace's task-scoped keys retire too; recorded as `workingStatePruned.task` | `supervisor-cleanup.mjs` |
| Run retention (`cleanup prune`) | `drop` of `supervisor:<run>` and every `child:<run>/*` namespace | `supervisor-cleanup.mjs` |

**drop** is the only destructive verb and the Supervisor's, not an agent's: it refuses without `--yes`
(exit 2, one line) and deletes every row of the namespace — base keys included, because the namespace
itself is going away.

**The deny rules** — one writer, the CLI. `SUPERVISOR_DENY` (`scripts/supervisor-lib.mjs`) and the
Supervisor's `agents/supervisor/settings.json` carry the same five rules, and `buildChildSettings`
copies them into every child's generated settings: `Bash(sqlite3 *agent-state*)`,
`Bash(node -e *agent-state*)`, `Bash(node --eval *agent-state*)`, `Edit(//**/agent-state.sqlite)`,
`Write(//**/agent-state.sqlite)`. The `//` anchor makes the Edit/Write patterns filesystem-wide — a bare `**/`
pattern only matches paths under the current directory, and the store lives in `LA_SUPERVISOR_STATE_HOME`.
Prefix match, not a sandbox — the real control is that the CLI is the
only code that knows the schema, and every change it makes lands in `facts_history`.

## Base keys and resolvers (FOC-728)

Base keys are declared per role in a registry and filled by deterministic resolvers — env, git, Linear,
`config/projects.json`, `docs/STATE.md` — never an LLM. Three verbs drive them:

```
node scripts/agent-state.mjs <resolve|missing|registry> [options]

  resolve    --role <role> --namespace <ns>   resolve the keys, write new values, hold on askable gaps
  missing    --role <role> --namespace <ns>   read-only: which keys have no active value (+ newest hold)
  registry                                    print the validated key table per role set
```

Options on all three: `--db`, `--actor` (`$LA_TASK_OWNER`, else `cli`), `--json`; `resolve` also takes
`--cwd` (working directory for the git resolvers, default process cwd).

### The registry — `config/agent-state.json`

The registry lives at `<LA_ROOT>/config/agent-state.json`; `LA_AGENT_STATE_REGISTRY` overrides the path.
It is Mateusz-owned and the only source of base keys — a key not listed there cannot become base, and
removing a key from the file is the only way a base key disappears. The file is validated on every load
and fails closed: an invalid file is never half-applied. Every verb reports `REGISTRY_INVALID`, exit 1,
naming the path and the offending entry:

```
config/agent-state.json: roles.child.issue.resolvers[1]: unknown kind "foo"
config/agent-state.json: duplicate key "repo" in roles.all and roles.supervisor
```

Format: `version` (`1`), optional `_doc`, and `roles` with the three sets `all`, `supervisor`, `child`.
Each entry:

```json
{ "description": "Repository name — basename of the git root",
  "resolvers": [{ "kind": "git-basename" }],
  "askIfMissing": false,
  "refresh": "once" }
```

Keys match the store key regex (`^[a-z][a-z0-9_]{0,63}$`); the same key may not appear in two role sets.
The squad roles `plan|dev|review|test` all map to the `child` set; keys resolve in order — `all` first,
then the role's own set.

### Resolver kinds

Each resolver yields `{ value, source, evidence }` or null; the chain stops at the first non-null.

| kind | args | source | evidence |
|---|---|---|---|
| `arg` | `name`: `"role"` | `spawn` | `resolve --role` |
| `env` | `name` | `spawn` | `env <name>` |
| `current-run` | — | `spawn` | `current-run.json` |
| `registry` | `field`: `worktree` `branch` `baseRevision` `taskId` `squad` `candidate` | `spawn` | `children.json <childId>.<field>` |
| `git` | `fact`: `root` `branch` `head` | `git` | the git command, e.g. `git rev-parse --abbrev-ref HEAD` |
| `git-basename` | — | `git` | `git rev-parse --show-toplevel` |
| `linear` | `issueKey`, `field`: `title` `project` `projectMilestone` `parent` `team` | `linear` | `linear issue <id> → <field>` |
| `projects-config` | `field`: `linearProject` `workspace` `teamKey` | `config` | `config/projects.json projects[repo=<repo>].<field>` |
| `state-md` | `label` | `state-md` | `docs/STATE.md:<line>` |
| `const` | `value` | `config` | `config/agent-state.json const` |
| `template` | `value` with `{key}` placeholders over already-resolved facts | `config` | `config/agent-state.json template` |

- `projects-config` finds the `config/projects.json` entry whose `repo` value — with `${VAR}` placeholders
  expanded from the environment — matches the resolved `repo` key; the field value is expanded the same
  way, and one unresolved placeholder leaves the whole value unresolved.
- `linear` runs one GraphQL query for the issue named by `issueKey` (an already-resolved key), covering
  `title`, `team`, `project`, `projectMilestone`, `parent`. `LA_AGENT_STATE_LINEAR_FIXTURE` replaces the
  network in tests: a JSON file mapping `<identifier> → { title, team, project, projectMilestone, parent }`.
- `state-md` returns the first line of `<LA_ROOT>/docs/STATE.md` matching `^\s*[-*]?\s*<label>:\s*(.+)$`
  — the Supervisor may keep `- Active issue: FOC-9`, `- Queue head: …` and `- Known reds: …` lines there.
- Unavailability is null, never an error: a missing env var, git repo, Linear key or fixture file just
  leaves the key unresolved.

### The starting key set

- **all** — `repo` (git root basename), `la_root` (env `LA_ROOT`, then git root), `run_id` (env
  `LA_SUPERVISOR_RUN`, then the current-run pointer), `role` (`--role`), `linear_team` (`config/projects.json`
  `teamKey`, then env `LINEAR_TEAM_KEY_FEN`), `linear_project` (`config/projects.json` `linearProject`).
  None ask.
- **supervisor** — `active_issue` (state-md `Active issue`), `active_milestone` (Linear `projectMilestone`
  of `active_issue`), `active_epic` (Linear `parent` of `active_issue`), `queue_head` (state-md
  `Queue head`), `known_reds` (state-md `Known reds`) — all `askIfMissing` — plus the constants
  `landing_flow` (`branch → PR → Mateusz merges on GitHub`), `push_policy` (`feature branches only;
  never main; no force`), `cost_basis` (`priced`).
- **child** — `issue` (env `LA_TASK_ID`, then registry `taskId`), `issue_title` (Linear `title`, ask),
  `milestone` (Linear `projectMilestone`, ask), `epic` (Linear `parent`, ask), `worktree` (registry,
  then git root), `branch` (git branch — the live truth, then registry `branch`; the only
  `refresh: always` key), `base_revision`
  (registry `baseRevision`), `candidate` (registry `candidate`; not written by spawn yet),
  `acceptance_criteria_ref` (template `linear issue {issue} § Acceptance criteria`).

### resolve, missing, registry

Rules: keys resolve in registry order and resolvers in entry order; first non-null wins. A key already
active in the store is skipped when its `refresh` is `once` and re-resolved when `always`; a resolved
value is stored (tier base) only when the value or the source differs from the stored row — no version
churn. A value the secret screen refuses counts as missing, with that code as the `reason`. An `always`
key whose resolvers all fail keeps its stored active value — it stays in `resolved` (`written: false`,
`kept: true`) and out of `missing`. When a resolver's dependency (`issueKey`, template placeholder) is
itself unresolved, the reason is `depends on <key>`. Missing is a
state, not an error: exit 0. Exit 1 on registry or store errors; exit 2 for usage (unknown verb, missing
`--role`/`--namespace`, an invalid `--role`, a non-ISO `LA_AGENT_STATE_NOW`).

```
$ node scripts/agent-state.mjs resolve --role dev --namespace child:run-42/dev-1
*repo = fenix  (git, git rev-parse --show-toplevel)
*la_root = C:\Users\mateu\Documents\GitHub\la-wt-mateusz  (spawn, env LA_ROOT)
issue = FOC-9  (spawn, env LA_TASK_ID)
missing: issue_title (ask), milestone (ask), epic (ask)
hold hold-1 created
```

`*` marks a fact written by this run (a re-run that resolves to the same values writes nothing). With
missing askable keys the final line is `hold hold-1 created` when a new hold is written, else
`hold hold-1 <state>` for the newest hold with that origin (`open`, or `answered` after an answer).
`missing` prints the same `missing:` line plus `hold <id> <state>`; `registry` prints
`registry <path>` and the key table per role set. `--json` prints the full shapes:
`{ ok, verb, role, namespace, resolved, missing, hold, holdSkipped, applied, ignored }` — `holdSkipped` is
`"no run dir"` when the namespace's run directory does not exist (no hold is written, nothing is created),
else absent.

### The hold round-trip

`resolve` first re-applies answered holds for the namespace — a hold's `origin` is
`agent-state resolve <namespace>` — parsing each `key=value` line of the answer text and storing it as a
base fact with `source: user`, evidence `hold <id>` (idempotent: an already-stored identical row is left
alone; keys outside the registry are reported, never stored). When askable keys are still missing and the
namespace maps to a run dir (`supervisor:<runId>`, `child:<runId>/<childId>`; `session:` namespaces get
no holds), there is one hold per missing key set: a new hold is written only when a missing askable key
was never named in any earlier hold with that origin (open or answered), and its question names only the
keys never asked before — so a partially answered hold does not re-ask its remaining keys, and `resolve`
reports the newest hold with that origin as `created: false`. Nothing blocks: `blocks: null`, and the
turn-end guard presents open holds.
The hold option carries `model: "user"` and `costUsd: 0` because the hold store requires them. Mateusz
answers through the Supervisor:

```
node scripts/supervisor-gate.mjs answer --hold hold-1 --text $'active_issue=FOC-9\nqueue_head=FOC-728'
```

In bash the `$'…'` form turns `\n` into a real newline between the key=value lines; PowerShell users
write the string with a real newline inside double quotes (backtick-n).

The next `resolve` stores the answers (as `source: user`) before resolving, so answered values land ahead
of any resolver.

## SessionStart injection (FOC-729)

Claude Code fires `SessionStart` on startup, resume, clear and compact — exactly the moments a context
loss would otherwise erase the working state. The hook `node "$LA_ROOT/scripts/agent-state-hook.mjs" SessionStart`
(`scripts/agent-state-hook.mjs`) re-renders and re-injects the block at each of them, for the Supervisor and
every squad child. The stdin payload is read tolerantly (unparsable or missing → `{}`); `source` defaults
to `startup` and passed through verbatim into the record; `LA_AGENT_STATE_NOW` pins the clock like in the CLIs.

**Namespace and role come from the env alone.** `LA_SUPERVISOR_CHILD` set → namespace
`child:<LA_SUPERVISOR_RUN>/<child>`, role `FENIX_STAGE` (must be a squad role, else `unknown role "<x>"`).
Otherwise the Supervisor: run id = `LA_SUPERVISOR_RUN`, else the current-run pointer (`readCurrentRun()`) —
a missing or unreadable pointer is "no run id", not a crash; with neither there is no namespace at all. The
pointer is adopted only when that run's directory still exists, and `resolve` never creates a run directory
(a hold is written only into an existing run).

Three steps, then the block on stdout:

1. **Resolve offline.** The env handed to the resolvers has `LINEAR_API_KEY`, `LINEAR_API_KEY_PISI`,
   `LINEAR_WORKSPACE` and `LA_AGENT_STATE_LINEAR_FIXTURE` deleted, so the hook never touches the network —
   a context-loss moment must never wait on one. Linear facts arrive only through spawn seeding, an explicit
   `resolve`, or a hold answer (holds follow the FOC-728 dedup rule); the resolve still refreshes
   `refresh: always` keys and fills newly resolvable ones.
2. **Render** `renderFacts` (default caps) — a namespace with no facts still prints the header-only block,
   so the agent learns the store exists.
3. **Record** the row below.

**Failure rule:** any failure — no run id, unknown role, an unparsable `LA_AGENT_STATE_NOW`, a store or
registry error — prints exactly one line `WORKING STATE unavailable: <reason>` to stdout and exits 0; a hook
that fails must never fail the session it hooks into. Errors carrying a code render as `<message> (<CODE>)`
(e.g. `REGISTRY_INVALID` for a registry that failed validation). The hook itself writes nothing to stderr
(the `node:sqlite` ExperimentalWarning from opening the store is the same expected noise the CLIs produce).

**The record.** One row per render, appended to `<runDir>/agent-state-renders.jsonl` (the run dir of the
namespace's run) — the measurement input for FOC-731:

```json
{"at":"2026-10-16T09:00:00.000Z","namespace":"child:r1a2b3/dev-3","role":"dev","source":"compact","lines":12,"omitted":0,"bytes":734,"resolved":8,"missing":0}
```

`resolved`/`missing` are counts from the resolve. There is no row for `session:` namespaces or when the
namespace's run dir does not exist; a failed append never costs the block (record dropped, block printed).

**Where the hook is wired.** The Supervisor's `agents/supervisor/settings.json` carries it as the third
SessionStart command, right after the briefing (`supervisor-status.mjs --briefing`) and before
`supervisor-session-hook.mjs`. The generated per-child deny-only settings from `buildChildSettings`
(`scripts/supervisor-lib.mjs`) add `hooks.SessionStart: [{ hooks: [WORKING_STATE_SESSION_START_HOOK] }]` —
the same shared object as the Supervisor file (`timeout: 10`); the squad file's telemetry hook is not
repeated there and the command is unique to this layer, so it registers exactly once — namespace and role
come from the child's inherited env, not the command line.

**Spawn seeding.** Before the hook can fire, spawn writes the facts it already renders into the prologue:
`seedPinnedState` (`scripts/agent-state-seed.mjs`) stores tier-base facts with `source: "spawn"`, evidence
`supervisor-spawn PINNED STATE`, for eight keys — `repo`, `la_root`, `run_id`, `role`, `issue`, `worktree`,
`branch`, `base_revision`. Null/empty values are ignored; undeclared keys are reported as skipped, never
invented; an already-stored identical row is left alone (no version churn). `supervisor-spawn.mjs` runs it
right after the prologue is built and records `workingStateSeeded: { at, keys }` on the registry child record —
or `{ at, keys: null, error }` with one stderr line `agent-state: seeding skipped (<reason>)`; a store problem
never blocks a spawn.

**Try it** (as a child in a run):

```bash
echo '{"hook_event_name":"SessionStart","source":"compact"}' | LA_SUPERVISOR_RUN=<run> LA_SUPERVISOR_CHILD=<child> FENIX_STAGE=dev node scripts/agent-state-hook.mjs SessionStart
```

## Exit codes and error codes

- **0** — success.
- **1** — the store refused a valid request or a runtime error: `REASON_REQUIRED`, `EVIDENCE_REQUIRED`,
  `BASE_KEY_PROTECTED`, `AGENT_KEY_CAP`, `VALUE_TOO_LONG`, `VALUE_SECRET_SHAPED`, `NOT_FOUND`,
  `REGISTRY_INVALID` (the registry file failed validation — every verb, including `resolve`/`missing`/`registry`).
- **2** — malformed caller request (usage): `NAMESPACE_INVALID`, `KEY_INVALID`, `FIELD_INVALID`, `USAGE`
  (unknown verb/flag, missing `--namespace`/`--key`/`--value` or a session env that names no namespace,
  extra positional, invalid `--ttl`/`--limit`, non-ISO `--expires-at` or `LA_AGENT_STATE_NOW`,
  dash-form value), and `drop` without `--yes` (one line, no usage text).

With `--json`, errors go to stderr as `{ "ok": false, "code": "...", "message": "..." }`. Human errors go
to stderr as `agent-state: <message> (<CODE>)`, followed by the usage text on exit 2. The
`node:sqlite` `ExperimentalWarning` on stderr is expected noise, not a failure.

## Environment

| Variable | Meaning |
|---|---|
| `LA_AGENT_STATE_DB` | store path override — wins over `LA_SUPERVISOR_STATE_HOME` and `LA_STATE_ROOT` (the `--db` flag wins over it) |
| `LA_AGENT_STATE_NOW` | pins the clock (ISO date; anything else exits 2) so expiry and ordering are testable without sleeping |
| `LA_TASK_OWNER` | default `--actor` attributed in `facts_history` |
| `LA_STATE_ROOT` | state root override; the last-resort store path is `<LA_STATE_ROOT>/agent-state/agent-state.sqlite` |
| `LA_AGENT_STATE_REGISTRY` | registry file override; default `<LA_ROOT>/config/agent-state.json` |
| `LA_AGENT_STATE_LINEAR_FIXTURE` | `resolve`: JSON fixture replacing the Linear network in tests (`<identifier> → issue facts`) |
| `LA_ROOT` | install root of the tooling checkout; anchors the registry, `config/projects.json` and `docs/STATE.md` |
| `LA_SUPERVISOR_STATE_HOME` | Supervisor state home — `<home>/<runId>/children.json` and `<home>/<runId>/holds.json`; when set (and `LA_AGENT_STATE_DB` is not), also anchors the store at `<home>/agent-state/agent-state.sqlite` |
| `LA_SUPERVISOR_RUN` / `LA_SUPERVISOR_CHILD` | env fallbacks for the run/child ids when the registry row is read; on the non-delegated verbs they also derive the default `--namespace` (FOC-730) |
| `FENIX_STAGE` | a child's squad role — the default `--actor` when `LA_SUPERVISOR_CHILD` is set |
| `LA_TASK_ID` | seeded into the child `issue` key by the first resolver of its chain |

## What comes next

- **FOC-728** — landed: the base keys, resolvers and hold round-trip above.
- **FOC-729** — landed: the SessionStart injection above + spawn seeding from PINNED STATE.
- **FOC-730** — landed: the `working-state` skill, the contract lines in each role's CLAUDE.md, env-derived
  namespace/actor, `drop`, the task-close and turn-end prune, and the deny rules for raw DB writes ("Agents:
  how to use it" above).

Only this CLI writes the store; raw writes to the database file are denied in Supervisor and child
permission lists.
