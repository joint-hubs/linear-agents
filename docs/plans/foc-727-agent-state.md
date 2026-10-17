# FOC-727 — Agent working state 1/5: SQLite fact store + CLI

Parent FOC-470 (M5). PRD: `docs/prd/agent-working-state-prd.md` (accepted 2026-10-08). Tasks 2/5–5/5
(base-key registry + resolvers, SessionStart injection, skill + lifecycle, measurement) build on this store.

## Facts (recon 2026-10-16)

- SQLite driver in the repo is `node:sqlite` `DatabaseSync` (dynamic import + `sqliteAvailable()`), opened
  per script with `busy_timeout = 10000`, `journal_mode = WAL`, `foreign_keys = ON` (`scripts/telemetry-store.mjs`
  `openTelemetryDb`, `scripts/flow-db.mjs` `openDb`). No shared open helper — copy the pattern.
- State root: `stateRoot(env)` in `scripts/fenix-paths.mjs` (`LA_STATE_ROOT` override, else `<repo>/.state`);
  `.state/` is gitignored.
- Secret screen: `scripts/egress-screen.mjs` `assertEgressClean(text, label)` throws `EgressBlockedError`
  (`EGRESS_BLOCKED`); `scanEgress(text)` returns hits.
- CLI idioms: `node:util parseArgs`; exit 0 ok / 1 refused or error / 2 usage; logic exported for tests;
  main guard `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`.
- Tests: `node:test` + `node:assert/strict`, `mkdtempSync` fixtures; every `*.test.mjs` must be listed in
  `scripts/test-lanes.json` (`test-run.mjs` refuses unlisted files); `docs/supervisor-e2e-checklist.md` pins the
  count (174 = 139 parallel + 35 serial at this base).

## Design — `scripts/agent-state.mjs`

**Store.** `agentStatePath(env)` = `LA_AGENT_STATE_DB` or `<stateRoot>/agent-state/agent-state.sqlite`
(parent dir created). `openAgentState(path)` → `{ db, path, close() }`; schema created idempotently:

```sql
CREATE TABLE IF NOT EXISTS facts (
  namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('base','agent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  source TEXT NOT NULL CHECK (source IN ('spawn','git','linear','config','state-md','user','agent')),
  evidence TEXT, reason TEXT,
  scope TEXT NOT NULL DEFAULT 'task' CHECK (scope IN ('run','task','turn')),
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_read_at TEXT, read_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (namespace, key));
CREATE TABLE IF NOT EXISTS facts_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL,
  op TEXT NOT NULL, before TEXT, after TEXT, actor TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS facts_history_key ON facts_history (namespace, key, id);
```

Timestamps are ISO strings; `now` is injectable (API param; CLI/env `LA_AGENT_STATE_NOW`) for fake-clock tests.
`before`/`after` in history are JSON snapshots of the row (null when absent). Every mutating verb runs in one
`BEGIN IMMEDIATE … COMMIT` transaction so the cap check and the write are atomic across processes.

**Validation** (`AgentStateError` with `code`): namespace `supervisor:<id>` | `child:<id>/<id>` | `session:<id>`
(`[A-Za-z0-9._-]+`) → `NAMESPACE_INVALID`; key `^[a-z][a-z0-9_]{0,63}$` → `KEY_INVALID`; value a string ≤ 2048
UTF-8 bytes → `VALUE_TOO_LONG`; value screened with `assertEgressClean` → `VALUE_SECRET_SHAPED` (nothing stored,
no history row); vocabularies for tier/source/scope → `FIELD_INVALID`.

**Verbs (API → CLI).** All API functions take `(store, params)` and return plain objects; the CLI maps them 1:1.

| verb | rules |
|---|---|
| `set` | agent tier (default): `reason` required (`REASON_REQUIRED`), source defaults `agent`, scope defaults `task`; base tier: `evidence` and `source` required (`EVIDENCE_REQUIRED`), scope defaults `run`. An existing **base** key cannot be re-set as agent (`BASE_KEY_PROTECTED`); an agent key may be promoted to base with evidence. Update keeps `created_at`, bumps `version`, sets `status = active`; history op `set` (new) / `update`. Cap: ≥ 50 active agent keys in the namespace (not counting the key being updated) → `AGENT_KEY_CAP`. `ttl` seconds or `expiresAt` set `expires_at`. |
| `get` | active row by (namespace, key); bumps `read_count`, `last_read_at` (no history). Missing → `NOT_FOUND`. `includeRetired` returns a retired row too. |
| `list` | rows of a namespace, base first then key order; `status` filter (default active; `all`), optional `tier`/`scope`. |
| `retire` | agent keys only: base → `BASE_KEY_PROTECTED` and nothing changes (no history row); missing → `NOT_FOUND`; already retired → `{ changed: false }`; else status retired + history op `retire` (reason stored in `after.reason` when given). |
| `prune` | retires active agent keys whose `expires_at <= now`, plus (when `scope` is given) every active agent key with that scope; base keys never; one history op `prune` per key; returns the retired keys. |
| `history` | `facts_history` rows for a namespace (optionally one key): the most recent `limit` rows, ascending by id, default 100. |
| `render` | `=== WORKING STATE ===` block: base keys first (alphabetical until task 2/5 brings the registry order), then active agent keys by `last_read_at` desc, `updated_at` desc; line `key: value  (source, updated <iso>)` with newlines in values escaped (`\n`, `\r`); caps 60 lines / 6144 bytes — base keys are never cut; agent lines stop before the cap and the block ends with `N more — use agent-state get` (the tail counts inside both caps). Deterministic for the same store. |

**CLI.** `node scripts/agent-state.mjs <verb> --namespace <ns> [--key k] [--value v] [--tier base|agent]
[--source s] [--evidence e] [--reason r] [--scope run|task|turn] [--ttl <seconds>] [--expires-at <iso>]
[--include-retired] [--status active|retired|all] [--limit n] [--actor a] [--db <path>] [--json]`.
`--db` > `LA_AGENT_STATE_DB` > default path; `--actor` > `LA_TASK_OWNER` > `cli`. Human output by default;
`--json` prints `{ ok: true, verb, ... }` on stdout and `{ ok: false, code, message }` on stderr for errors.
Exit codes: 0 ok; 1 refused/error (`BASE_KEY_PROTECTED`, `VALUE_SECRET_SHAPED`, `AGENT_KEY_CAP`, `NOT_FOUND`, …);
2 usage (unknown verb/flag, missing `--namespace`, `NAMESPACE_INVALID`, `KEY_INVALID`, `FIELD_INVALID`).

## Tests — `scripts/agent-state.test.mjs` (parallel lane)

set/get/version/read_count; reason/evidence requirements; base-key protection on retire and prune (row and
history byte-identical before/after, exit 1 via the CLI); full history chain (limit = the most recent N,
ascending); prune with a fake clock (ttl expiry, scope task, base keys never); secret-shaped value refused
before storage; the 51st agent key refused; value > 2 KB refused; namespace/key validation → exit 2; two
disjoint writer processes 50 + 50 → 100 facts rows and 100 history rows, `PRAGMA integrity_check = ok`; the
cap race → exactly one of two concurrent 50th keys lands; `render` caps (base keys all present, tail line);
`list` ordering; `--json` shapes.

## Docs

This plan; `docs/agent-state.md` (CLI reference, one page); checklist count 175 (140 parallel + 35 serial).

## Out of scope

Base-key registry and resolvers (2/5), SessionStart injection and spawn seeding (3/5), skill and deny rules (4/5),
measurement (5/5), cleanup archiving of the namespace (FOC-649 hook, with 4/5).
