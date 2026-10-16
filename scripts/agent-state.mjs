// agent-state.mjs — the Agent working-state fact store (FOC-727, task 1/5).
//
// One SQLite database of small, dated facts the Supervisor and its children
// write for each other: namespace + key → value. Tier 'base' facts are the
// registry (evidence + source required, agents may never retire or overwrite
// them); tier 'agent' facts are working state (reason required, capped per
// namespace, pruned by TTL/scope). Every change lands in facts_history.
//
// CLI:
//   node scripts/agent-state.mjs <get|set|list|retire|prune|render|history>
//     --namespace <ns> [--key k] [--value v] [--tier base|agent] [--source s]
//     [--evidence e] [--reason r] [--scope run|task|turn] [--ttl <seconds>]
//     [--expires-at <iso>] [--include-retired] [--status active|retired|all]
//     [--limit n] [--actor a] [--db <path>] [--json]

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { stateRoot } from "./fenix-paths.mjs";
import { assertEgressClean, EgressBlockedError } from "./egress-screen.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const AGENT_KEY_CAP = 50;
export const VALUE_MAX_BYTES = 2048;
export const RENDER_MAX_LINES = 60;
export const RENDER_MAX_BYTES = 6144;

const NAMESPACES = /^(supervisor:[A-Za-z0-9._-]+|child:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|session:[A-Za-z0-9._-]+)$/;
const KEYS = /^[a-z][a-z0-9_]{0,63}$/;
const TIERS = ["base", "agent"];
const SOURCES = ["spawn", "git", "linear", "config", "state-md", "user", "agent"];
const SCOPES = ["run", "task", "turn"];
const STATUSES = ["active", "retired", "all"];

// Codes that mean "the caller's request was malformed" rather than "the store
// refused a valid request" — the CLI maps these to exit 2 (usage), everything
// else to exit 1.
const USAGE_CODES = new Set(["NAMESPACE_INVALID", "KEY_INVALID", "FIELD_INVALID", "USAGE"]);

export class AgentStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentStateError";
    this.code = code;
    this.exitCode = USAGE_CODES.has(code) ? 2 : 1;
  }
}

export function agentStatePath(env = process.env) {
  if (env.LA_AGENT_STATE_DB) return resolve(env.LA_AGENT_STATE_DB);
  return join(stateRoot(env), "agent-state", "agent-state.sqlite");
}

const SCHEMA = `
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
`;

export function openAgentState(path = agentStatePath()) {
  if (!DatabaseSync) {
    throw new Error(`node:sqlite is required for agent state (current: ${process.version})`);
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return { db, path, close: () => db.close() };
}

// ── validation ───────────────────────────────────────────────────────────────

function validateNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACES.test(namespace)) {
    throw new AgentStateError(
      "NAMESPACE_INVALID",
      `namespace must match supervisor:<id> | child:<id>/<id> | session:<id>, got ${JSON.stringify(namespace)}`,
    );
  }
  return namespace;
}

function validateKey(key) {
  if (typeof key !== "string" || !KEYS.test(key)) {
    throw new AgentStateError("KEY_INVALID", `key must match ${KEYS.source}, got ${JSON.stringify(key)}`);
  }
  return key;
}

function validateValue(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > VALUE_MAX_BYTES) {
    throw new AgentStateError("VALUE_TOO_LONG", `value must be a string of at most ${VALUE_MAX_BYTES} UTF-8 bytes`);
  }
  try {
    assertEgressClean(value, "agent-state value");
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      throw new AgentStateError("VALUE_SECRET_SHAPED", error.message);
    }
    throw error;
  }
  return value;
}

function validateVocabulary(field, value, allowed) {
  if (!allowed.includes(value)) {
    throw new AgentStateError("FIELD_INVALID", `${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function isoNow(params) {
  const now = params.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) {
    throw new AgentStateError("FIELD_INVALID", "now must be an ISO date");
  }
  return now;
}

function actorOf(params) {
  return params.actor ?? "cli";
}

function expiresAtOf(params, now) {
  if (params.expiresAt != null) {
    if (!Number.isFinite(Date.parse(params.expiresAt))) {
      throw new AgentStateError("FIELD_INVALID", "expiresAt must be an ISO date");
    }
    // Normalised so the lexicographic comparison in prune stays sound.
    return new Date(params.expiresAt).toISOString();
  }
  if (params.ttlSeconds != null) {
    return new Date(Date.parse(now) + params.ttlSeconds * 1000).toISOString();
  }
  return null;
}

// Every mutating verb runs its read-check-write inside one BEGIN IMMEDIATE
// transaction so the cap check and the write are atomic across processes
// (two writers racing on the 51st key must not both pass the check).
function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already rolled back (or never opened) — the
      // original error is the one worth surfacing.
    }
    throw error;
  }
}

function insertHistory(db, namespace, key, op, before, after, actor, at) {
  db.prepare(
    "INSERT INTO facts_history (namespace, key, op, before, after, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(namespace, key, op, before, after, actor, at);
}

function rowJson(row) {
  return row == null ? null : JSON.stringify(row);
}

// ── verbs ────────────────────────────────────────────────────────────────────

export function setFact(store, params = {}) {
  const now = isoNow(params);
  const actor = actorOf(params);
  const namespace = validateNamespace(params.namespace);
  const key = validateKey(params.key);
  const tier = params.tier ?? "agent";
  validateVocabulary("tier", tier, TIERS);
  const value = validateValue(params.value);

  let source;
  let reason = params.reason ?? null;
  let evidence = params.evidence ?? null;
  let scope;
  if (tier === "agent") {
    if (typeof params.reason !== "string" || params.reason === "") {
      throw new AgentStateError("REASON_REQUIRED", "agent-tier facts require a non-empty reason");
    }
    source = params.source ?? "agent";
    scope = params.scope ?? "task";
  } else {
    if (typeof params.evidence !== "string" || params.evidence === "") {
      throw new AgentStateError("EVIDENCE_REQUIRED", "base-tier facts require non-empty evidence");
    }
    if (params.source == null) {
      throw new AgentStateError("FIELD_INVALID", "base-tier facts require a source");
    }
    source = params.source;
    scope = params.scope ?? "run";
  }
  validateVocabulary("source", source, SOURCES);
  validateVocabulary("scope", scope, SCOPES);
  const expiresAt = expiresAtOf(params, now);

  const db = store.db;
  return withTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, key);
    if (existing && existing.tier === "base" && tier === "agent") {
      throw new AgentStateError(
        "BASE_KEY_PROTECTED",
        `base key ${namespace}/${key} cannot be re-set as agent tier`,
      );
    }
    // The cap guards NEW agent rows and re-activations of retired ones; an
    // update of a live agent row (or any base row) is never counted against it.
    if (tier === "agent" && (!existing || existing.status === "retired")) {
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM facts WHERE namespace = ? AND tier = 'agent' AND status = 'active'")
        .get(namespace);
      if (n >= AGENT_KEY_CAP) {
        throw new AgentStateError(
          "AGENT_KEY_CAP",
          `agent key cap of ${AGENT_KEY_CAP} reached in ${namespace}; retire or prune keys first`,
        );
      }
    }

    let row;
    if (!existing) {
      db.prepare(
        `INSERT INTO facts
           (namespace, key, value, tier, status, source, evidence, reason, scope,
            expires_at, created_at, updated_at, last_read_at, read_count, version)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1)`,
      ).run(namespace, key, value, tier, source, evidence, reason, scope, expiresAt, now, now);
    } else {
      // Update keeps created_at (and the read bookkeeping), bumps version and
      // re-activates: a retired agent key can be set again.
      db.prepare(
        `UPDATE facts
         SET value = ?, tier = ?, status = 'active', source = ?, evidence = ?, reason = ?,
             scope = ?, expires_at = ?, updated_at = ?, version = version + 1
         WHERE namespace = ? AND key = ?`,
      ).run(value, tier, source, evidence, reason, scope, expiresAt, now, namespace, key);
    }
    row = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, key);
    const op = existing ? "update" : "set";
    insertHistory(db, namespace, key, op, rowJson(existing), rowJson(row), actor, now);
    return { row, op };
  });
}

export function getFact(store, params = {}) {
  const now = isoNow(params);
  const namespace = validateNamespace(params.namespace);
  const key = validateKey(params.key);
  const db = store.db;
  return withTransaction(db, () => {
    const row = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, key);
    if (!row || (row.status === "retired" && params.includeRetired !== true)) {
      throw new AgentStateError("NOT_FOUND", `no fact ${namespace}/${key}`);
    }
    // Read bookkeeping only — no history row for a read.
    db.prepare("UPDATE facts SET read_count = read_count + 1, last_read_at = ? WHERE namespace = ? AND key = ?").run(
      now,
      namespace,
      key,
    );
    return { row: { ...row, read_count: row.read_count + 1, last_read_at: now } };
  });
}

export function listFacts(store, params = {}) {
  const namespace = validateNamespace(params.namespace);
  const status = params.status ?? "active";
  validateVocabulary("status", status, STATUSES);
  if (params.tier != null) validateVocabulary("tier", params.tier, TIERS);
  if (params.scope != null) validateVocabulary("scope", params.scope, SCOPES);

  let sql = "SELECT * FROM facts WHERE namespace = ?";
  const args = [namespace];
  if (status !== "all") {
    sql += " AND status = ?";
    args.push(status);
  }
  if (params.tier != null) {
    sql += " AND tier = ?";
    args.push(params.tier);
  }
  if (params.scope != null) {
    sql += " AND scope = ?";
    args.push(params.scope);
  }
  // Base tier first (the registry order lands in task 2/5), then key order.
  sql += " ORDER BY CASE tier WHEN 'base' THEN 0 ELSE 1 END, key ASC";
  return { rows: store.db.prepare(sql).all(...args) };
}

export function retireFact(store, params = {}) {
  const now = isoNow(params);
  const actor = actorOf(params);
  const namespace = validateNamespace(params.namespace);
  const key = validateKey(params.key);
  const db = store.db;
  return withTransaction(db, () => {
    const row = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, key);
    if (!row) throw new AgentStateError("NOT_FOUND", `no fact ${namespace}/${key}`);
    if (row.tier === "base") {
      throw new AgentStateError("BASE_KEY_PROTECTED", `base key ${namespace}/${key} cannot be retired`);
    }
    if (row.status === "retired") return { row, changed: false };
    const reason = params.reason ?? row.reason;
    db.prepare("UPDATE facts SET status = 'retired', updated_at = ?, reason = ? WHERE namespace = ? AND key = ?").run(
      now,
      reason,
      namespace,
      key,
    );
    const after = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, key);
    insertHistory(db, namespace, key, "retire", rowJson(row), rowJson(after), actor, now);
    return { row: after, changed: true };
  });
}

export function pruneFacts(store, params = {}) {
  const now = isoNow(params);
  const actor = actorOf(params);
  const namespace = validateNamespace(params.namespace);
  if (params.scope != null) validateVocabulary("scope", params.scope, SCOPES);
  const db = store.db;
  return withTransaction(db, () => {
    const rows = db
      .prepare(
        "SELECT * FROM facts WHERE namespace = ? AND tier = 'agent' AND status = 'active' ORDER BY key ASC",
      )
      .all(namespace);
    const retired = [];
    for (const row of rows) {
      // ISO strings compare lexicographically the same as chronologically.
      const expired = row.expires_at != null && row.expires_at <= now;
      const scoped = params.scope != null && row.scope === params.scope;
      if (!expired && !scoped) continue;
      db.prepare("UPDATE facts SET status = 'retired', updated_at = ? WHERE namespace = ? AND key = ?").run(
        now,
        namespace,
        row.key,
      );
      const after = db.prepare("SELECT * FROM facts WHERE namespace = ? AND key = ?").get(namespace, row.key);
      insertHistory(db, namespace, row.key, "prune", rowJson(row), rowJson(after), actor, now);
      retired.push(row.key);
    }
    return { retired };
  });
}

export function historyFacts(store, params = {}) {
  const namespace = validateNamespace(params.namespace);
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new AgentStateError("FIELD_INVALID", `limit must be a non-negative integer, got ${JSON.stringify(limit)}`);
  }
  let sql = "SELECT * FROM facts_history WHERE namespace = ?";
  const args = [namespace];
  if (params.key != null) {
    sql += " AND key = ?";
    args.push(validateKey(params.key));
  }
  // The most recent `limit` rows, delivered ascending: take the tail by id
  // DESC, then reverse.
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(limit);
  const rows = store.db.prepare(sql).all(...args);
  rows.reverse();
  return { rows };
}

// ── render ───────────────────────────────────────────────────────────────────

function escapeNewlines(value) {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function factLine(row) {
  return `${row.key}: ${escapeNewlines(row.value)}  (${row.source}, updated ${row.updated_at})`;
}

export function renderFacts(store, params = {}) {
  validateNamespace(params.namespace);
  const maxLines = params.maxLines ?? RENDER_MAX_LINES;
  const maxBytes = params.maxBytes ?? RENDER_MAX_BYTES;
  const db = store.db;
  const base = db
    .prepare(
      "SELECT * FROM facts WHERE namespace = ? AND tier = 'base' AND status = 'active' ORDER BY key ASC",
    )
    .all(params.namespace);
  const agent = db
    .prepare(
      `SELECT * FROM facts WHERE namespace = ? AND tier = 'agent' AND status = 'active'
       ORDER BY (last_read_at IS NULL) ASC, last_read_at DESC, updated_at DESC, key ASC`,
    )
    .all(params.namespace);

  const out = ["=== WORKING STATE ==="];
  let lines = 1;
  let bytes = Buffer.byteLength(out[0], "utf8");
  // Base lines are the registry — always rendered, never counted against the
  // caps. Only agent lines are dropped.
  for (const row of base) {
    const line = factLine(row);
    out.push(line);
    bytes += Buffer.byteLength(`\n${line}`, "utf8");
    lines += 1;
  }
  // The tail line ("N more — use agent-state get") is part of the block, so
  // while deciding whether the next agent line fits we reserve its worst-case
  // size (every agent row omitted) from both the byte and the line budget —
  // the final text stays within the caps whenever the base lines alone fit.
  const tailBytes = Buffer.byteLength(`\n${agent.length} more — use agent-state get`, "utf8");
  let omitted = 0;
  for (let i = 0; i < agent.length; i++) {
    const line = factLine(agent[i]);
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
    if (lines + 2 > maxLines || bytes + tailBytes + lineBytes > maxBytes) {
      omitted = agent.length - i;
      break;
    }
    out.push(line);
    bytes += lineBytes;
    lines += 1;
  }
  // A base section that already eats the whole byte budget leaves no room for
  // the tail; the omitted count is still returned (and printed with --json).
  if (omitted > 0 && bytes + tailBytes <= maxBytes) {
    out.push(`${omitted} more — use agent-state get`);
  }
  return { text: out.join("\n"), lines: out.length, omitted };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const OPTIONS = {
  namespace: { type: "string", short: "n" },
  key: { type: "string", short: "k" },
  value: { type: "string", short: "v" },
  tier: { type: "string" },
  source: { type: "string" },
  evidence: { type: "string" },
  reason: { type: "string" },
  scope: { type: "string" },
  ttl: { type: "string" },
  "expires-at": { type: "string" },
  "include-retired": { type: "boolean" },
  status: { type: "string" },
  limit: { type: "string" },
  actor: { type: "string" },
  db: { type: "string" },
  json: { type: "boolean" },
};

const VERBS = new Set(["get", "set", "list", "retire", "prune", "render", "history"]);
const VERBS_NEEDING_KEY = new Set(["get", "set", "retire"]);
const VERBS_NEEDING_VALUE = new Set(["set"]);
const INTEGER = /^\d+$/;

const USAGE_TEXT = `usage: node scripts/agent-state.mjs <verb> [options]

verbs: get | set | list | retire | prune | render | history

options:
  --namespace, -n <ns>     supervisor:<id> | child:<id>/<id> | session:<id>
  --key, -k <key>          ^[a-z][a-z0-9_]{0,63}$
  --value, -v <value>      <= 2048 UTF-8 bytes (set)
  --tier <base|agent>      default agent (set)
  --source <s>             spawn|git|linear|config|state-md|user|agent
  --evidence <e>           required for base tier (set)
  --reason <r>             required for agent tier (set)
  --scope <run|task|turn>  default task (agent) / run (base)
  --ttl <seconds>          expires_at = now + ttl (set)
  --expires-at <iso>       explicit expiry (set)
  --include-retired        get: return a retired row too
  --status <s>             active | retired | all (list, default active)
  --limit <n>              history rows (default 100)
  --actor <a>              history actor (default $LA_TASK_OWNER or cli)
  --db <path>              store path (default $LA_AGENT_STATE_DB or <state>/agent-state/agent-state.sqlite)
  --json                   machine-readable output

  values that start with '-' must use the = form, e.g. --value=-foo
`;

function failUsage(stderr, message) {
  if (message) stderr.write(`agent-state: ${message}\n`);
  stderr.write(USAGE_TEXT);
  return 2;
}

function reportError(error, { json, stderr }) {
  if (error instanceof AgentStateError) {
    if (json) {
      stderr.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
    } else {
      stderr.write(`agent-state: ${error.message} (${error.code})\n`);
    }
    return error.exitCode;
  }
  stderr.write(`${error.message}\n`);
  return 1;
}

function printJson(stdout, verb, result) {
  stdout.write(`${JSON.stringify({ ok: true, verb, ...result }, null, 2)}\n`);
}

export async function runCli(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
  } catch {
    return failUsage(stderr);
  }
  const args = parsed.values;
  const verb = parsed.positionals[0];
  if (!verb || !VERBS.has(verb)) return failUsage(stderr, verb ? `unknown verb '${verb}'` : "missing verb");
  if (parsed.positionals.length > 1) {
    return failUsage(stderr, `unexpected positional argument: ${parsed.positionals[1]}`);
  }
  if (args.namespace == null) return failUsage(stderr, "missing --namespace");
  if (VERBS_NEEDING_KEY.has(verb) && args.key == null) return failUsage(stderr, `${verb} requires --key`);
  if (VERBS_NEEDING_VALUE.has(verb) && args.value == null) return failUsage(stderr, "set requires --value");

  const json = args.json === true;
  // LA_AGENT_STATE_NOW pins the clock so tests can exercise expiry without
  // sleeping; unset, the API calls stamp the real current time.
  const now = env.LA_AGENT_STATE_NOW || undefined;
  if (now != null && !Number.isFinite(Date.parse(now))) {
    return failUsage(stderr, "LA_AGENT_STATE_NOW must be an ISO date");
  }

  let ttlSeconds;
  if (args.ttl != null) {
    if (!INTEGER.test(args.ttl)) return failUsage(stderr, "--ttl must be a non-negative integer (seconds)");
    ttlSeconds = Number(args.ttl);
  }
  let limit;
  if (args.limit != null) {
    if (!INTEGER.test(args.limit)) return failUsage(stderr, "--limit must be a non-negative integer");
    limit = Number(args.limit);
  }

  const actor = args.actor || env.LA_TASK_OWNER || "cli";
  const namespace = args.namespace;
  const key = args.key;

  try {
    const store = openAgentState(args.db || agentStatePath(env));
    try {
      if (verb === "get") {
        const result = getFact(store, { namespace, key, includeRetired: args["include-retired"] === true, now });
        if (json) printJson(stdout, verb, result);
        else {
          stdout.write(`${key}=${result.row.value}\n`);
          stdout.write(`(${result.row.tier}, ${result.row.source}, ${result.row.scope}, version ${result.row.version})\n`);
        }
      } else if (verb === "set") {
        const result = setFact(store, {
          namespace,
          key,
          value: args.value,
          tier: args.tier,
          source: args.source,
          evidence: args.evidence,
          reason: args.reason,
          scope: args.scope,
          ttlSeconds,
          expiresAt: args["expires-at"],
          actor,
          now,
        });
        if (json) printJson(stdout, verb, result);
        else stdout.write(`set ${result.row.key} (v${result.row.version}, ${result.op})\n`);
      } else if (verb === "list") {
        const result = listFacts(store, { namespace, status: args.status, tier: args.tier, scope: args.scope });
        if (json) printJson(stdout, verb, result);
        else {
          for (const row of result.rows) {
            stdout.write(`${row.key}: ${row.value}  [${row.tier}/${row.scope}/${row.status}]\n`);
          }
        }
      } else if (verb === "retire") {
        const result = retireFact(store, { namespace, key, reason: args.reason, actor, now });
        if (json) printJson(stdout, verb, result);
        else stdout.write(`${result.changed ? "retired" : "already retired"} ${key}\n`);
      } else if (verb === "prune") {
        const result = pruneFacts(store, { namespace, scope: args.scope, actor, now });
        if (json) printJson(stdout, verb, result);
        else if (result.retired.length === 0) stdout.write("pruned 0 key(s)\n");
        else stdout.write(`pruned ${result.retired.length} key(s): ${result.retired.join(", ")}\n`);
      } else if (verb === "render") {
        const result = renderFacts(store, { namespace });
        if (json) printJson(stdout, verb, result);
        else stdout.write(`${result.text}\n`);
      } else if (verb === "history") {
        const result = historyFacts(store, { namespace, key: args.key, limit });
        if (json) printJson(stdout, verb, result);
        else {
          for (const row of result.rows) {
            stdout.write(`${row.id} ${row.at} ${row.op} ${row.key} by ${row.actor}\n`);
          }
        }
      }
    } finally {
      store.close();
    }
    return 0;
  } catch (error) {
    return reportError(error, { json, stderr });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
