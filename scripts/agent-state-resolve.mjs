// agent-state-resolve.mjs — deterministic base-key resolvers + the hold round-trip (FOC-728).
//
// resolveRole walks the registry in order, asks each resolver in turn and
// writes the first non-null answer as a base fact (no version churn when the
// stored value and source already match). Keys no resolver can produce become
// `missing`; askable missing keys are asked through holds — a new hold is
// written only when at least one never-asked key remains (askedKeysOf parses
// every hold's question text), so a partially answered hold never spawns a
// follow-up for keys it already asked. Answered holds are parsed back as
// key=value lines by applyHoldAnswers before the next resolve. "Not available" is null,
// never a throw: a missing env var, git repo, fixture or API key just leaves
// the key unresolved.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { AgentStateError, agentStatePath, listFacts, openAgentState, setFact } from "./agent-state.mjs";
import { keysForRole, laRoot, loadRegistry, registryPath } from "./agent-state-registry.mjs";
import { HOLDS_SCHEMA_VERSION, git, nextHoldId, readHolds, readRegistry, writeHolds } from "./supervisor-lib.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";
import { graphql } from "./linear-client.mjs";

export const HOLD_ORIGIN_PREFIX = "agent-state resolve ";

const SUPERVISOR_NS = /^supervisor:([A-Za-z0-9._-]+)$/;
const CHILD_NS = /^child:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export const holdOrigin = (namespace) => `${HOLD_ORIGIN_PREFIX}${namespace}`;

export function runIdOfNamespace(namespace) {
  const supervisor = SUPERVISOR_NS.exec(namespace);
  if (supervisor) return supervisor[1];
  const child = CHILD_NS.exec(namespace);
  if (child) return child[1];
  return null; // session:<id> — no run dir, so no holds possible.
}

export function childIdOfNamespace(namespace) {
  const child = CHILD_NS.exec(namespace);
  return child ? child[2] : null;
}

const ISSUE_QUERY =
  "query($id: String!) { issue(id: $id) { identifier title team { key } project { name } " +
  "projectMilestone { name } parent { identifier title } } }";

/**
 * Linear facts for one issue — { title, team, project, projectMilestone,
 * parent } where parent is { identifier, title }. Fixture first
 * (LA_AGENT_STATE_LINEAR_FIXTURE), then the live API when a key is present;
 * anything unavailable (no key, no fixture, network error, unknown issue) is
 * null, never a throw. The key/workspace decision reads only the injected env
 * (pisi → LINEAR_API_KEY_PISI, else LINEAR_API_KEY); no .env loading here.
 */
export async function fetchIssueFacts(identifier, { env = process.env } = {}) {
  if (!identifier) return null;
  if (env.LA_AGENT_STATE_LINEAR_FIXTURE) {
    try {
      const fixture = JSON.parse(readFileSync(env.LA_AGENT_STATE_LINEAR_FIXTURE, "utf8"));
      return fixture[identifier] ?? null;
    } catch {
      return null;
    }
  }
  const workspace = env.LINEAR_WORKSPACE === "pisi" ? "pisi" : undefined;
  const apiKey = workspace === "pisi" ? env.LINEAR_API_KEY_PISI : env.LINEAR_API_KEY;
  if (!apiKey) return null;
  try {
    const data = await graphql(ISSUE_QUERY, { id: identifier }, workspace);
    const issue = data?.issue;
    if (!issue) return null;
    return {
      title: issue.title ?? null,
      team: issue.team?.key ?? null,
      project: issue.project?.name ?? null,
      projectMilestone: issue.projectMilestone?.name ?? null,
      parent: issue.parent ? { identifier: issue.parent.identifier, title: issue.parent.title } : null,
    };
  } catch {
    return null;
  }
}

// ── resolvers ────────────────────────────────────────────────────────────────

// ${VAR} templates (projects.json style): one unresolved placeholder makes the
// whole value unresolved.
function expandEnvTemplate(value, env) {
  if (typeof value !== "string") return null;
  let unresolved = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const found = env[name];
    if (typeof found !== "string" || found === "") {
      unresolved = true;
      return whole;
    }
    return found;
  });
  return unresolved ? null : out;
}

// {key} templates over already-resolved facts.
function expandFactsTemplate(value, facts) {
  if (typeof value !== "string") return null;
  let unresolved = false;
  const out = value.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, key) => {
    const found = facts.get(key);
    if (typeof found !== "string" || found === "") {
      unresolved = true;
      return whole;
    }
    return found;
  });
  return unresolved ? null : out;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const GIT_COMMANDS = {
  root: ["rev-parse", "--show-toplevel"],
  branch: ["rev-parse", "--abbrev-ref", "HEAD"],
  head: ["rev-parse", "HEAD"],
};

function runGit(args, cwd) {
  try {
    const value = git(args, cwd);
    return value ? value : null;
  } catch {
    return null;
  }
}

const RESOLVER_IMPLS = {
  arg(resolver, ctx) {
    if (resolver.name !== "role" || !ctx.role) return null;
    return { value: ctx.role, source: "spawn", evidence: "resolve --role" };
  },
  env(resolver, ctx) {
    const value = ctx.env[resolver.name];
    if (typeof value !== "string" || value === "") return null;
    return { value, source: "spawn", evidence: `env ${resolver.name}` };
  },
  "current-run"() {
    const record = readCurrentRun();
    if (!record) return null;
    return { value: record.runId, source: "spawn", evidence: "current-run.json" };
  },
  registry(resolver, ctx) {
    const row = ctx.registryRow;
    if (!row) return null;
    const value = row[resolver.field];
    if (typeof value !== "string" || value === "") return null;
    const childId = row.childId || ctx.childId || "?";
    return { value, source: "spawn", evidence: `children.json ${childId}.${resolver.field}` };
  },
  git(resolver, ctx) {
    const args = GIT_COMMANDS[resolver.fact];
    if (!args) return null;
    const value = runGit(args, ctx.cwd);
    if (!value) return null;
    return { value, source: "git", evidence: `git ${args.join(" ")}` };
  },
  "git-basename"(_resolver, ctx) {
    const root = runGit(GIT_COMMANDS.root, ctx.cwd);
    if (!root) return null;
    return { value: basename(root), source: "git", evidence: "git rev-parse --show-toplevel" };
  },
  async linear(resolver, ctx) {
    const identifier = ctx.facts.get(resolver.issueKey);
    if (!identifier) {
      // An unresolved issueKey is a dependency on that key, not plain unavailability.
      ctx.dependsOn = resolver.issueKey;
      return null;
    }
    const facts = await fetchIssueFacts(identifier, { env: ctx.env });
    if (!facts) return null;
    const value = resolver.field === "parent" ? facts.parent?.identifier : facts[resolver.field];
    if (typeof value !== "string" || value === "") return null;
    return { value, source: "linear", evidence: `linear issue ${identifier} → ${resolver.field}` };
  },
  "projects-config"(resolver, ctx) {
    const repo = ctx.facts.get("repo");
    if (!repo) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(ctx.laRoot, "config", "projects.json"), "utf8"));
    } catch {
      return null;
    }
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    for (const entry of projects) {
      const repoPath = expandEnvTemplate(entry?.repo, ctx.env);
      if (repoPath == null || basename(repoPath) !== repo) continue;
      const value = expandEnvTemplate(entry?.[resolver.field], ctx.env);
      if (value == null || value === "") return null;
      return { value, source: "config", evidence: `config/projects.json projects[repo=${repo}].${resolver.field}` };
    }
    return null;
  },
  "state-md"(resolver, ctx) {
    let text;
    try {
      text = readFileSync(join(ctx.laRoot, "docs", "STATE.md"), "utf8");
    } catch {
      return null;
    }
    const pattern = new RegExp(`^\\s*[-*]?\\s*${escapeRegex(resolver.label)}:\\s*(.+)$`);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(pattern);
      if (match) return { value: match[1].trim(), source: "state-md", evidence: `docs/STATE.md:${i + 1}` };
    }
    return null;
  },
  const(resolver) {
    return { value: resolver.value, source: "config", evidence: "config/agent-state.json const" };
  },
  template(resolver, ctx) {
    const value = expandFactsTemplate(resolver.value, ctx.facts);
    if (value == null) {
      // An unresolved {key} placeholder is a dependency, not plain unavailability.
      for (const match of String(resolver.value).matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
        const found = ctx.facts.get(match[1]);
        if (typeof found !== "string" || found === "") {
          ctx.dependsOn = match[1];
          break;
        }
      }
      return null;
    }
    return { value, source: "config", evidence: "config/agent-state.json template" };
  },
};

async function runResolver(resolver, ctx) {
  const impl = RESOLVER_IMPLS[resolver.kind];
  if (!impl) return null; // unreachable for a validated registry
  return impl(resolver, ctx);
}

// ── hold round-trip ──────────────────────────────────────────────────────────

/**
 * Parse answered holds for this namespace back into base facts. The whole
 * answer text is parsed first, last-wins per key (one `key=value` per line,
 * split at the FIRST `=`), then every key is written once; keys must exist in
 * SOME role set of the registry. Unusable lines are reported in `ignored` as
 * `{ holdId, key, reason }` and never stored — reason "no =" (no equals sign,
 * the line itself as the key), "empty" (`key=`), "unknown key". Re-applying
 * the same hold is idempotent: a stored row with the same value and
 * `hold <id>` evidence is left alone.
 */
export function applyHoldAnswers(store, { namespace, env = process.env, now, actor, registry = null }) {
  const applied = [];
  const ignored = [];
  const runId = runIdOfNamespace(namespace);
  if (!runId) return { applied, ignored };
  const reg = registry ?? loadRegistry(registryPath(env));
  const known = new Map();
  for (const set of ["all", "supervisor", "child"]) {
    for (const [key, entry] of Object.entries(reg.roles[set] ?? {})) {
      if (!known.has(key)) known.set(key, entry);
    }
  }
  const active = new Map(listFacts(store, { namespace, status: "active" }).rows.map((row) => [row.key, row]));
  const origin = holdOrigin(namespace);
  for (const hold of readHolds(runId).holds) {
    if (hold.origin !== origin || hold.state !== "answered" || !hold.answer?.text) continue;
    // Parse the whole answer first: last-wins per key, so a repeated key is
    // applied once (no duplicate writes, no version churn).
    const answers = new Map();
    for (const line of String(hold.answer.text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) {
        ignored.push({ holdId: hold.id, key: trimmed, reason: "no =" });
        continue;
      }
      answers.set(trimmed.slice(0, eq).trim(), {
        value: trimmed.slice(eq + 1).trim(),
        holdId: hold.id,
      });
    }
    for (const [key, answer] of answers) {
      if (!known.has(key)) {
        ignored.push({ holdId: answer.holdId, key, reason: "unknown key" });
        continue;
      }
      if (answer.value === "") {
        ignored.push({ holdId: answer.holdId, key, reason: "empty" });
        continue;
      }
      const evidence = `hold ${answer.holdId}`;
      const stored = active.get(key);
      if (stored && stored.evidence === evidence && stored.value === answer.value) continue;
      setFact(store, { namespace, key, value: answer.value, tier: "base", source: "user", evidence, scope: "run", actor, now });
      active.set(key, { ...stored, value: answer.value, source: "user", evidence });
      applied.push({ key, holdId: answer.holdId });
    }
  }
  return { applied, ignored };
}

// The question format is strictly parseable so hold dedup can recover which
// keys a hold asked: the comma-separated tokens between "no deterministic
// source for " and ". Answer" are the key list.
export function askedKeysOf(hold) {
  const question = String(hold?.question ?? "");
  const marker = "no deterministic source for ";
  const start = question.indexOf(marker);
  if (start < 0) return [];
  const from = start + marker.length;
  const end = question.indexOf(". Answer", from);
  if (end < 0) return [];
  return question
    .slice(from, end)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Read-only counterpart: which of the role's base keys have no active stored
 * value, plus the newest hold for this namespace (open or answered) if any.
 * Never writes — not to the store, not to holds.json.
 */
export function missingForRole(store, { registry, role, namespace, env = process.env }) {
  const activeKeys = new Set(listFacts(store, { namespace, status: "active" }).rows.map((row) => row.key));
  const missing = keysForRole(registry, role)
    .filter(([key]) => !activeKeys.has(key))
    .map(([key, entry]) => ({ key, askIfMissing: entry.askIfMissing, reason: "unresolved" }));
  let hold = null;
  const runId = runIdOfNamespace(namespace);
  if (runId) {
    const origin = holdOrigin(namespace);
    const matches = readHolds(runId).holds.filter((h) => h.origin === origin);
    const newest = matches[matches.length - 1];
    if (newest) hold = { id: newest.id, state: newest.state };
  }
  return { missing, hold };
}

/**
 * Resolve every base key of `role` for `namespace`. Stored `once` keys are
 * skipped; `always` keys re-resolve. Returns { resolved, missing, hold,
 * applied, ignored }; the hold (never blocking here — the turn-end guard
 * presents it) is written exactly like supervisor-gate writes its records.
 * One hold per missing-key set: a new hold is written only when a missing
 * askable key was never asked by an earlier hold with this origin.
 */
export async function resolveRole(store, { registry, role, namespace, env = process.env, cwd = process.cwd(), now, actor }) {
  const at = now ?? new Date().toISOString();
  const { applied, ignored } = await applyHoldAnswers(store, { namespace, env, now: at, actor, registry });

  const runId = runIdOfNamespace(namespace) || env.LA_SUPERVISOR_RUN || null;
  const childId = childIdOfNamespace(namespace) || env.LA_SUPERVISOR_CHILD || null;
  let registryRow = null;
  if (runId && childId) {
    try {
      registryRow = readRegistry(runId).children[childId] ?? null;
    } catch {
      registryRow = null;
    }
  }

  const ctx = { role, namespace, env, cwd, facts: new Map(), registryRow, childId, laRoot: laRoot(env), now: at };
  const rows = listFacts(store, { namespace, status: "active" }).rows;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  for (const row of rows) ctx.facts.set(row.key, row.value);

  const resolved = [];
  const missing = [];
  const unresolved = new Set();
  for (const [key, entry] of keysForRole(registry, role)) {
    const stored = rowByKey.get(key);
    if (stored && entry.refresh === "once") continue;
    let hit = null;
    for (const resolver of entry.resolvers) {
      ctx.dependsOn = null;
      hit = await runResolver(resolver, ctx);
      if (hit) break;
    }
    if (!hit) {
      if (stored && entry.refresh === "always") {
        // An always key whose resolvers all fail keeps its stored active value
        // (reported with kept: true) so resolve and missing stay in agreement.
        ctx.facts.set(key, stored.value);
        resolved.push({
          key,
          value: stored.value,
          source: stored.source,
          evidence: stored.evidence,
          written: false,
          kept: true,
        });
      } else if (ctx.dependsOn && unresolved.has(ctx.dependsOn)) {
        // The resolver depends on a key this run could not resolve — name it.
        missing.push({ key, askIfMissing: entry.askIfMissing, reason: `depends on ${ctx.dependsOn}` });
        unresolved.add(key);
      } else {
        missing.push({ key, askIfMissing: entry.askIfMissing, reason: "unresolved" });
        unresolved.add(key);
      }
      continue;
    }
    let written = false;
    if (!(stored && stored.value === hit.value && stored.source === hit.source)) {
      try {
        setFact(store, {
          namespace,
          key,
          value: hit.value,
          tier: "base",
          source: hit.source,
          evidence: hit.evidence,
          scope: "run",
          actor,
          now: at,
        });
        written = true;
      } catch (error) {
        if (error instanceof AgentStateError) {
          missing.push({ key, askIfMissing: entry.askIfMissing, reason: error.code });
          unresolved.add(key);
          continue;
        }
        throw error;
      }
    }
    ctx.facts.set(key, hit.value);
    resolved.push({ key, value: hit.value, source: hit.source, evidence: hit.evidence, written });
  }

  let hold = null;
  const nsRunId = runIdOfNamespace(namespace);
  const askMissing = missing.filter((m) => m.askIfMissing);
  if (nsRunId && askMissing.length > 0) {
    const holdsStore = readHolds(nsRunId);
    const origin = holdOrigin(namespace);
    const matches = holdsStore.holds.filter((h) => h.origin === origin);
    const asked = new Set(matches.flatMap((h) => askedKeysOf(h)));
    // A dependency key is named in the question too — even when its own
    // askIfMissing is false — so the answer can fix the root cause.
    const askKeys = askMissing.map((m) => m.key);
    for (const m of missing) {
      const dep = /^depends on (.+)$/.exec(m.reason);
      if (dep && !askKeys.includes(dep[1])) askKeys.push(dep[1]);
    }
    const neverAsked = askKeys.filter((key) => !asked.has(key));
    if (neverAsked.length > 0) {
      const id = nextHoldId(nsRunId);
      const record = {
        id,
        origin,
        question: `Working state (${role}, ${namespace}): no deterministic source for ` +
          `${neverAsked.join(", ")}. Answer with one key=value per line.`,
        options: [{ label: "Provide the values", model: "user", costUsd: 0 }],
        recommendation: "Add the values to docs/STATE.md or answer here; agent keys stay unaffected.",
        impact: "low",
        resolution: null,
        state: "open",
        createdAt: at,
        presentedAt: null,
        until: null,
        answer: null,
        blocks: null,
        history: [{ event: "created", at }],
      };
      writeHolds(nsRunId, { version: HOLDS_SCHEMA_VERSION, holds: [...holdsStore.holds, record] });
      hold = { id, created: true };
    } else {
      const newest = matches[matches.length - 1];
      if (newest) hold = { id: newest.id, created: false, state: newest.state };
    }
  }

  return { resolved, missing, hold, applied, ignored };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const OPTIONS = {
  role: { type: "string" },
  namespace: { type: "string", short: "n" },
  cwd: { type: "string" },
  db: { type: "string" },
  actor: { type: "string" },
  json: { type: "boolean" },
};

const VERBS = new Set(["resolve", "missing", "registry"]);

const USAGE_TEXT = `usage: node scripts/agent-state.mjs <resolve|missing|registry> [options]

verbs:
  resolve    resolve the role's base keys, write new values, open a hold when askable keys are missing
  missing    read-only: which base keys have no active stored value (+ newest hold for the namespace)
  registry   print the validated base-key registry, per role set

options:
  --role <r>             supervisor | plan | dev | review | test (resolve, missing)
  --namespace, -n <ns>   supervisor:<id> | child:<id>/<id> | session:<id> (resolve, missing)
  --cwd <dir>            working directory for the git resolvers (default: process cwd)
  --db <path>            store path (default $LA_AGENT_STATE_DB or <state>/agent-state/agent-state.sqlite)
  --actor <a>            history actor (default $LA_TASK_OWNER or cli)
  --json                 machine-readable output
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

const missingLine = (missing) =>
  missing.length === 0
    ? "missing: none"
    : `missing: ${missing.map((m) => (m.askIfMissing ? `${m.key} (ask)` : m.key)).join(", ")}`;

const resolverLabel = (resolver) => {
  const detail = resolver.name ?? resolver.field ?? resolver.fact ?? resolver.label;
  return detail != null ? `${resolver.kind} ${detail}` : resolver.kind;
};

const roleSummary = (set) =>
  Object.entries(set).map(([key, entry]) => ({
    key,
    description: entry.description,
    resolvers: entry.resolvers.map(resolverLabel),
    askIfMissing: entry.askIfMissing,
    refresh: entry.refresh,
  }));

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

  const json = args.json === true;
  const now = env.LA_AGENT_STATE_NOW || undefined;
  if (now != null && !Number.isFinite(Date.parse(now))) {
    return failUsage(stderr, "LA_AGENT_STATE_NOW must be an ISO date");
  }

  const path = registryPath(env);
  let registry;
  try {
    registry = loadRegistry(path);
  } catch (error) {
    if (json) {
      stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? "REGISTRY_INVALID", message: error.message }, null, 2)}\n`);
    } else {
      stderr.write(`agent-state: ${error.message} (${error.code ?? "REGISTRY_INVALID"})\n`);
    }
    return 1;
  }

  if (verb === "registry") {
    if (json) {
      stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            verb: "registry",
            path,
            roles: {
              all: roleSummary(registry.roles.all),
              supervisor: roleSummary(registry.roles.supervisor),
              child: roleSummary(registry.roles.child),
            },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stdout.write(`registry ${path}\n`);
      for (const set of ["all", "supervisor", "child"]) {
        stdout.write(`${set}:\n`);
        for (const [key, entry] of Object.entries(registry.roles[set])) {
          stdout.write(`  ${key} — ${entry.description} [${entry.resolvers.map(resolverLabel).join(", ")}]\n`);
        }
      }
    }
    return 0;
  }

  if (args.role == null) return failUsage(stderr, `${verb} requires --role`);
  if (args.namespace == null) return failUsage(stderr, `${verb} requires --namespace`);

  const actor = args.actor || env.LA_TASK_OWNER || "cli";
  const cwd = args.cwd || process.cwd();
  const db = args.db || env.LA_AGENT_STATE_DB || agentStatePath(env);

  try {
    const store = openAgentState(db);
    let result;
    try {
      result = verb === "resolve"
        ? await resolveRole(store, { registry, role: args.role, namespace: args.namespace, env, cwd, now, actor })
        : missingForRole(store, { registry, role: args.role, namespace: args.namespace, env });
    } finally {
      store.close();
    }
    if (json) {
      stdout.write(
        `${JSON.stringify({ ok: true, verb, role: args.role, namespace: args.namespace, ...result }, null, 2)}\n`,
      );
    } else if (verb === "resolve") {
      for (const row of result.resolved) {
        stdout.write(`${row.written ? "*" : ""}${row.key} = ${row.value}  (${row.source}, ${row.evidence})\n`);
      }
      stdout.write(`${missingLine(result.missing)}\n`);
      if (result.applied.length > 0) {
        stdout.write(`applied: ${result.applied.map((a) => `${a.key} (${a.holdId})`).join(", ")}\n`);
      }
      if (result.ignored.length > 0) {
        stdout.write(`ignored: ${result.ignored.map((i) => `${i.key} (${i.holdId})`).join(", ")}\n`);
      }
      if (result.hold) {
        stdout.write(`hold ${result.hold.id} ${result.hold.created ? "created" : result.hold.state}\n`);
      }
    } else {
      stdout.write(`${missingLine(result.missing)}\n`);
      if (result.hold) stdout.write(`hold ${result.hold.id} ${result.hold.state}\n`);
    }
    return 0;
  } catch (error) {
    return reportError(error, { json, stderr });
  }
}
