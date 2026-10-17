# agent-state — CLI reference (FOC-727, task 1/5)

`scripts/agent-state.mjs` is a per-agent working-state store: one SQLite database of small, dated facts
the Supervisor and its children write for each other, addressed as namespace + key — one namespace per
Supervisor run, child, and interactive session. Tier `base` keys form the registry: they require evidence
plus a source, and agents may never retire or overwrite them. Tier `agent` keys are self-managed working
state: each write needs a reason plus a scope or TTL, at most 50 active per namespace, and `prune` retires
expired or scope-ended keys. Every change lands in the append-only `facts_history`.

Values are strings of at most 2048 UTF-8 bytes, screened by the local egress secret screen (FOC-450) before
storage because the rendered block is sent to model providers. The file lives at
`<stateRoot>/agent-state/agent-state.sqlite` (WAL, gitignored, never inside a task worktree), where
`<stateRoot>` is `$LA_STATE_ROOT` or `<repo>/.state`; `LA_AGENT_STATE_DB` overrides the path.

## Synopsis

```
node scripts/agent-state.mjs <get|set|list|retire|prune|render|history> --namespace <ns> [options]
```

| Flag | Applies to | Meaning | Default |
|---|---|---|---|
| `--namespace`, `-n` | all | `supervisor:<id>` \| `child:<id>/<id>` \| `session:<id>` | required |
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
| `--actor` | set, retire, prune | attributed in `facts_history` | `$LA_TASK_OWNER`, else `cli` |
| `--db` | all | store path | `$LA_AGENT_STATE_DB`, else the default path above |
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

## Exit codes and error codes

- **0** — success.
- **1** — the store refused a valid request or a runtime error: `REASON_REQUIRED`, `EVIDENCE_REQUIRED`,
  `BASE_KEY_PROTECTED`, `AGENT_KEY_CAP`, `VALUE_TOO_LONG`, `VALUE_SECRET_SHAPED`, `NOT_FOUND`.
- **2** — malformed caller request (usage): `NAMESPACE_INVALID`, `KEY_INVALID`, `FIELD_INVALID`, `USAGE`
  (unknown verb/flag, missing `--namespace`/`--key`/`--value`, extra positional, invalid `--ttl`/`--limit`,
  non-ISO `--expires-at` or `LA_AGENT_STATE_NOW`, dash-form value).

With `--json`, errors go to stderr as `{ "ok": false, "code": "...", "message": "..." }`. Human errors go
to stderr as `agent-state: <message> (<CODE>)`, followed by the usage text on exit 2. The
`node:sqlite` `ExperimentalWarning` on stderr is expected noise, not a failure.

## Environment

| Variable | Meaning |
|---|---|
| `LA_AGENT_STATE_DB` | store path override (the `--db` flag wins over it) |
| `LA_AGENT_STATE_NOW` | pins the clock (ISO date; anything else exits 2) so expiry and ordering are testable without sleeping |
| `LA_TASK_OWNER` | default `--actor` attributed in `facts_history` |
| `LA_STATE_ROOT` | state root override; the default store path is `<LA_STATE_ROOT>/agent-state/agent-state.sqlite` |

## What comes next

- **FOC-728** — base-key registry + resolvers (`resolve` / `missing`); deterministic sources only, no LLM.
- **FOC-729** — SessionStart injection of the `render` block + spawn seeding from PINNED STATE.
- **FOC-730** — skill + task-close `prune` + deny rules for raw DB writes.

Only this CLI writes the store; raw writes to the database file are denied in Supervisor and child
permission lists.
