#!/usr/bin/env node
// scripts/agent-tools.mjs — visibility into and validated edits of agent
// permission settings (FOC-900, P1-B of FOC-898; FOC-906 for the edit verbs).
// Verbs over <agent>/settings.json plus the repo's .mcp.json. The agents root
// is the effective config root by default ($LA_SQUAD_HOME when set, else
// <repo>/agents); `docs` always renders the repository tree so the committed
// file documents the image baseline.
//
//   show   <agent>                  one agent's effective settings (permissions,
//                                   MCP reachability, skills) — JSON with --json
//   diff   <agent> --against <ref>  permission lists vs a git ref (git show only)
//   check                           validate every settings.json against the
//                                   Claude Code permission-rule shapes
//   docs   [--write] [--out <p>]    render the generated reference doc
//   allow|ask|deny <agent> "<rule>" append the rule to that list (validated
//                                   first; --dry-run prints without writing)
//   remove <agent> "<rule>"         delete the rule from whichever list holds it
//
// show/diff/check/docs never write. The edit verbs DO write the agent's
// settings.json — validated before the write, atomic, key order preserved —
// and an edit to the repository tree regenerates docs/agent-tools.md in the
// same step. Nothing is staged or committed by the tool. The `check` rule-shape facts come from the Claude Code permission
// docs (2026-10-16):
//   1. precedence is deny > ask > allow: a matching ask rule prompts even when a
//      more specific allow rule also matches the same call;
//   2. compound commands are split on `&&`, `||`, `;`, `|`, `|&`, `&`, newline
//      and a rule must match each subcommand independently (ask/deny apply to
//      any subcommand incl. subshells and command substitutions);
//   3. a Bash rule matches the command text only — it is not a security boundary
//      around the program (code run through node/python is not covered by
//      ask/deny on other commands);
//   4. rule syntax: `Tool` or `Tool(pattern)`; Bash/PowerShell patterns match
//      the whole command with `*` as wildcard (legacy `prefix:*` equals
//      `prefix *`); MCP tools are `mcp__<server>__<tool>` with the
//      `mcp__<server>__*` wildcard; `Tool(param:value)` is NOT valid for the
//      primary content field.
//
// Run: node scripts/agent-tools.mjs <show|diff|check|docs|allow|ask|deny|remove> [...]

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SUPERVISOR_DENY } from "./supervisor-lib.mjs";
import { squadConfigRoot } from "./fenix-paths.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The repository's own agents/ tree — what the committed docs/agent-tools.md
// documents (the image baseline). The effective root for show/diff/check is
// squadConfigRoot(env): $LA_SQUAD_HOME when set, <repo>/agents otherwise.
const REPO_AGENTS_DIR = join(REPO_ROOT, "agents");
const DEFAULT_MCP_PATH = join(REPO_ROOT, ".mcp.json");
const LISTS = ["allow", "ask", "deny"];

// Verbatim copy of SUPERVISOR_DENY (scripts/supervisor-lib.mjs) as of FOC-900.
// `check` compares the live export against this snapshot: a shrunk baseline
// means children silently lost a deny they used to have, so it is an error.
// Deliberately widening SUPERVISOR_DENY is fine — edit this list in the same
// commit to re-pin the new baseline.
export const DENY_BASELINE = [
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr merge:*)",
  "Bash(gh release create:*)",
  "Bash(gh api:*)",
  "Bash(git worktree remove:*)",
  "Bash(git worktree prune:*)",
  "Bash(node $LA_ROOT/scripts/linear-ops.mjs:*)",
  "Bash(node $LA_ROOT/scripts/publish-linear-comment.mjs:*)",
  "Bash(node $LA_ROOT/scripts/linear-query.mjs:*)",
];

// ── rule shapes ──────────────────────────────────────────────────────────────

// Tool(param:value) is not valid for the primary content field — only these
// four parameter names are flagged, exactly as the docs name them.
const PRIMARY_FIELD_FORMS = /^(command|file_path|path|url):/;

/**
 * Parse one permission rule. Returns { ok, tool, pattern, reason }:
 *  - ok:true, pattern:null  → bare tool name (`Read`, `WebFetch`)
 *  - ok:true, pattern:"..." → `Tool(pattern)` with balanced parentheses
 *  - ok:false               → reason: not-a-string | empty | empty-pattern |
 *                             primary-field | shape
 */
export function parseRule(rule) {
  if (typeof rule !== "string") return { ok: false, reason: "not-a-string" };
  if (rule.trim() === "") return { ok: false, reason: "empty" };
  const open = rule.indexOf("(");
  if (open === -1) return { ok: true, tool: rule.trim(), pattern: null };
  if (!rule.endsWith(")")) return { ok: false, reason: "shape" };
  const tool = rule.slice(0, open);
  const inner = rule.slice(open + 1, -1);
  if (!/^[A-Za-z0-9_-]+$/.test(tool)) return { ok: false, reason: "shape" };
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return { ok: false, reason: "shape" };
    }
  }
  if (depth !== 0) return { ok: false, reason: "shape" };
  if (inner.trim() === "") return { ok: false, reason: "empty-pattern" };
  if (PRIMARY_FIELD_FORMS.test(inner.trim())) return { ok: false, reason: "primary-field" };
  return { ok: true, tool, pattern: inner };
}

/**
 * Literal prefix of a Bash/PowerShell rule: the text before the first `*`,
 * with a trailing `:` normalised to a space (so `Bash(git branch:*)` has the
 * prefix "git branch " and `Bash(git branch -D:*)` — "git branch -D " — starts
 * with it). Non-Bash/PowerShell rules have no prefix (null).
 */
export function rulePrefix(rule) {
  const parsed = parseRule(rule);
  if (!parsed.ok || parsed.pattern === null) return null;
  if (parsed.tool !== "Bash" && parsed.tool !== "PowerShell") return null;
  const star = parsed.pattern.indexOf("*");
  let prefix = star === -1 ? parsed.pattern : parsed.pattern.slice(0, star);
  if (prefix.endsWith(":")) prefix = prefix.slice(0, -1) + " ";
  return prefix;
}

const INTERPRETER_RULES = new Set([
  "Bash(node:*)",
  "Bash(node *)",
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(py:*)",
  "PowerShell(node *)",
  "PowerShell(python *)",
]);

const COMPOUND_HELPER_RULES = new Set([
  "Bash(cd:*)",
  "Bash(export:*)",
  "Bash(set:*)",
]);

function isInterpreterRule(rule) {
  if (INTERPRETER_RULES.has(rule)) return true;
  const parsed = parseRule(rule);
  if (!parsed.ok || parsed.pattern === null) return false;
  if (parsed.tool !== "Bash" && parsed.tool !== "PowerShell") return false;
  // `Bash(*/Scripts/python.exe*)` and friends: a trailing wildcard stripped,
  // the stem ends with the interpreter binary.
  return parsed.pattern.replace(/\*+$/, "").endsWith("python.exe");
}

function isCompoundHelper(rule) {
  return COMPOUND_HELPER_RULES.has(rule);
}

// ── shared readers ───────────────────────────────────────────────────────────

/** Agent dirs under agentsDir that have a settings.json, sorted. */
export function listAgents(agentsDir) {
  let entries;
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      if (name.startsWith("_") || name === "") return false;
      const settings = join(agentsDir, name, "settings.json");
      return existsSync(settings) && statSync(join(agentsDir, name)).isDirectory();
    })
    .sort();
}

function readJsonOrThrow(path, what) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = new Error(`${what} is not valid JSON: ${err.message}`);
    e.code = "BAD_JSON";
    throw e;
  }
}

/** Skill dirs: own = agents/<agent>/skills/<name>, shared = agents/_shared/skills/<name>. */
export function collectSkills(agent, agentsDir) {
  const own = new Set(listDirNames(join(agentsDir, agent, "skills")));
  const shared = new Set(listDirNames(join(agentsDir, "_shared", "skills")));
  const names = [...new Set([...own, ...shared])].sort();
  return names.map((name) => ({
    name,
    source: own.has(name) && shared.has(name) ? "both" : own.has(name) ? "own" : "shared",
  }));
}

function listDirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Command-hook count per event (nested `{ matcher, hooks: [...] }` or flat). */
export function hookCounts(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const counts = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    let n = 0;
    for (const entry of entries) {
      if (Array.isArray(entry?.hooks)) {
        for (const hook of entry.hooks) {
          if (!hook?.type || hook.type === "command") n++;
        }
      } else if (!entry?.type || entry.type === "command") {
        n++;
      }
    }
    counts[event] = n;
  }
  return counts;
}

/**
 * MCP visibility for one server against one agent's rules. Reachable = an allow
 * rule covers the server (`mcp__<server>__*`, any `mcp__<server>__<tool>`,
 * `mcp__*` or `*`) and no server-wildcard deny covers it (`mcp__<server>__*`,
 * `mcp__*` or `*` — deny on the server wildcard wins, kept simple on purpose).
 */
export function mcpEntry(server, allow, deny) {
  const toolPrefix = `mcp__${server}__`;
  const via =
    allow.find(
      (r) =>
        r === toolPrefix + "*" ||
        (r.startsWith(toolPrefix) && r.length > toolPrefix.length) ||
        r === "mcp__*" ||
        r === "*",
    ) || null;
  const deniedBy =
    deny.find((r) => r === toolPrefix + "*" || r === "mcp__*" || r === "*") || null;
  return { server, reachable: via !== null && deniedBy === null, via, deniedBy };
}

// ── show ─────────────────────────────────────────────────────────────────────

export function showAgent(agent, { agentsDir = squadConfigRoot(), mcpPath = DEFAULT_MCP_PATH } = {}) {
  const dir = join(agentsDir, agent);
  const settingsPath = join(dir, "settings.json");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const known = listAgents(agentsDir);
    const err = new Error(
      `unknown agent: ${agent} — agents with a settings.json: ${known.join(", ") || "(none)"}`,
    );
    err.code = "UNKNOWN_AGENT";
    throw err;
  }
  const settings = readJsonOrThrow(settingsPath, settingsPath) ?? {};
  const perms = settings?.permissions ?? {};
  const allow = perms.allow ?? [];
  const ask = perms.ask ?? [];
  const deny = perms.deny ?? [];
  const mcpServers = readJsonOrThrow(mcpPath, ".mcp.json");
  const mcp = Object.keys(mcpServers?.mcpServers ?? {}).map((server) =>
    mcpEntry(server, allow, deny),
  );
  return {
    agent,
    settingsPath,
    permissions: { allow, ask, deny },
    additionalDirectories: perms.additionalDirectories ?? [],
    defaultMode: perms.defaultMode ?? null,
    hooks: hookCounts(settings),
    mcp,
    skills: collectSkills(agent, agentsDir),
  };
}

function showText(data) {
  const out = [];
  out.push(`agent: ${data.agent}`);
  out.push(`settings: ${data.settingsPath}`);
  out.push("");
  for (const list of LISTS) {
    const rules = data.permissions[list];
    out.push(`${list} (${rules.length})`);
    for (const rule of rules) out.push(`  ${rule}`);
  }
  out.push("");
  out.push(`defaultMode: ${data.defaultMode ?? "(unset)"}`);
  out.push(`additionalDirectories (${data.additionalDirectories.length})`);
  for (const d of data.additionalDirectories) out.push(`  ${d}`);
  const events = Object.entries(data.hooks);
  out.push(`hooks (${events.length} event${events.length === 1 ? "" : "s"})`);
  for (const [event, count] of events) out.push(`  ${event}: ${count}`);
  out.push(`mcp (${data.mcp.length} server${data.mcp.length === 1 ? "" : "s"})`);
  for (const { server, reachable, via, deniedBy } of data.mcp) {
    if (deniedBy) out.push(`  ${server} — denied by ${deniedBy}`);
    else if (reachable) out.push(`  ${server} — reachable via ${via}`);
    else out.push(`  ${server} — not reachable (no allow rule)`);
  }
  out.push(`skills (${data.skills.length})`);
  for (const { name, source } of data.skills) out.push(`  ${name} — ${source}`);
  return out.join("\n") + "\n";
}

// ── diff ─────────────────────────────────────────────────────────────────────

/** Pure list diff, file order preserved: added = in current not in previous. */
export function diffLists(current, previous) {
  return {
    added: current.filter((r) => !previous.includes(r)),
    removed: previous.filter((r) => !current.includes(r)),
  };
}

function gitRun(args, cwd, env) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env });
}

/**
 * Diff one agent's permission lists against `<ref>:<agent>/settings.json`.
 * Runs real git (read-only `rev-parse` + `show`) with cwd = repo root. Throws
 * with code DIFF_UNAVAILABLE when the agents dir is outside a git repository,
 * DIFF_GIT when git itself fails (bad ref etc.). A settings file that did not
 * exist at the ref is an empty base (everything counts as added).
 */
export function diffAgent(
  agent,
  against,
  { agentsDir = squadConfigRoot(), env = process.env } = {},
) {
  const dir = join(agentsDir, agent);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const known = listAgents(agentsDir);
    const err = new Error(
      `unknown agent: ${agent} — agents with a settings.json: ${known.join(", ") || "(none)"}`,
    );
    err.code = "UNKNOWN_AGENT";
    throw err;
  }
  const settingsPath = join(dir, "settings.json");
  const root = gitRun(["rev-parse", "--show-toplevel"], agentsDir, env);
  if (root.status !== 0 || !root.stdout.trim()) {
    const err = new Error(
      `diff unavailable: ${agentsDir} is not inside a git repository`,
    );
    err.code = "DIFF_UNAVAILABLE";
    throw err;
  }
  const repoRoot = root.stdout.trim();
  const relPath = relative(repoRoot, settingsPath).split("\\").join("/");
  const shown = gitRun(["show", `${against}:${relPath}`], repoRoot, env);
  let previous = {};
  if (shown.status !== 0) {
    const notInRef = /does not exist|exists on disk, but not in/.test(shown.stderr);
    if (!notInRef) {
      const err = new Error(
        `git show ${against}:${relPath} failed: ${(shown.stderr || "").trim()}`,
      );
      err.code = "DIFF_GIT";
      throw err;
    }
  } else {
    try {
      previous = JSON.parse(shown.stdout);
    } catch (err) {
      const e = new Error(`${against}:${relPath} is not valid JSON: ${err.message}`);
      e.code = "BAD_JSON";
      throw e;
    }
  }
  const current = readJsonOrThrow(settingsPath, settingsPath) ?? {};
  const prevPerms = previous?.permissions ?? {};
  const curPerms = current?.permissions ?? {};
  const result = { agent, against };
  for (const list of LISTS) {
    result[list] = diffLists(curPerms[list] ?? [], prevPerms[list] ?? []);
  }
  return result;
}

function diffText(data) {
  const out = [`agent: ${data.agent}`, `against: ${data.against}`, ""];
  for (const list of LISTS) {
    const { added, removed } = data[list];
    if (!added.length && !removed.length) {
      out.push(`${list}: no changes`);
      continue;
    }
    out.push(`${list} (${added.length} added, ${removed.length} removed)`);
    for (const rule of added) out.push(`  + ${rule}`);
    for (const rule of removed) out.push(`  - ${rule}`);
  }
  return out.join("\n") + "\n";
}

// ── check ────────────────────────────────────────────────────────────────────

/**
 * Findings for ONE agent from an ALREADY-PARSED settings object — the shared
 * core of `check` and of the FOC-906 edit validation (a would-be settings
 * object is validated with exactly the rules `check` applies to the file).
 */
function agentFindings(agent, settings) {
  const findings = [];
  const perms =
    settings?.permissions && typeof settings.permissions === "object"
      ? settings.permissions
      : {};
  const lists = {};
  for (const list of LISTS) {
    const value = perms[list];
    if (value === undefined) {
      lists[list] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      findings.push({
        level: "error",
        agent,
        list,
        rule: "",
        message: `permissions.${list} is not an array`,
      });
      lists[list] = [];
      continue;
    }
    lists[list] = value;
  }
  // shape errors, per rule in file order
  for (const list of LISTS) {
    for (const rule of lists[list]) {
      const parsed = parseRule(rule);
      if (parsed.ok) continue;
      const message =
        parsed.reason === "not-a-string"
          ? "rule is not a string"
          : parsed.reason === "empty"
            ? "rule is empty"
            : parsed.reason === "empty-pattern"
              ? "invalid rule shape: empty pattern — Tool() matches nothing"
              : parsed.reason === "primary-field"
                ? "invalid rule shape: Tool(param:value) is not valid for the primary content field (e.g. Bash(command:...))"
                : "invalid rule shape: expected Tool or Tool(pattern) with balanced parentheses";
      findings.push({ level: "error", agent, list, rule: String(rule), message });
    }
  }
  // duplicates: within one list, then across allow/ask/deny
  for (const list of LISTS) {
    const seen = new Map();
    lists[list].forEach((rule, index) => {
      if (typeof rule !== "string") return;
      if (seen.has(rule)) {
        findings.push({
          level: "error",
          agent,
          list,
          rule,
          message: `duplicate rule in ${list} (same rule at position ${seen.get(rule)})`,
        });
      } else {
        seen.set(rule, index);
      }
    });
  }
  // duplicates across lists: each list against the union of all earlier
  // lists (allow, ask, deny in order) — comparing adjacent pairs only would
  // never flag a rule present in both allow and deny.
  const crossDups = new Set(); // `${list}\u0000${rule}` already reported as an error
  for (let i = 1; i < LISTS.length; i++) {
    const earlierLists = LISTS.slice(0, i);
    const earlier = new Set(
      earlierLists.flatMap((l) => lists[l]).filter((r) => typeof r === "string"),
    );
    for (const rule of lists[LISTS[i]]) {
      if (typeof rule !== "string" || !earlier.has(rule)) continue;
      const firstList = earlierLists.find((l) => lists[l].includes(rule));
      crossDups.add(`${LISTS[i]}\u0000${rule}`);
      findings.push({
        level: "error",
        agent,
        list: LISTS[i],
        rule,
        message: `duplicate rule: also in ${firstList} — the same rule in allow and ask/deny is contradictory`,
      });
    }
  }
  // overlap: an ask/deny prefix extending an allow prefix (warning only)
  const allowPrefixes = [];
  for (const rule of lists.allow) {
    const prefix = rulePrefix(rule);
    if (prefix !== null && prefix.trim() !== "") allowPrefixes.push({ rule, prefix });
  }
  for (const list of ["ask", "deny"]) {
    for (const rule of lists[list]) {
      const prefix = rulePrefix(rule);
      if (prefix === null || prefix.trim() === "") continue;
      if (crossDups.has(`${list}\u0000${rule}`)) continue; // exact duplicate → already an error
      const hit = allowPrefixes.find((a) => prefix.startsWith(a.prefix));
      if (hit) {
        findings.push({
          level: "warning",
          agent,
          list,
          rule,
          message: `overlap with allow rule ${hit.rule}: Claude Code applies deny > ask > allow, the ask/deny rule wins`,
        });
      }
    }
  }
  // documented blind spots in the allow list (info)
  for (const rule of lists.allow) {
    if (typeof rule !== "string") continue;
    if (isInterpreterRule(rule)) {
      findings.push({
        level: "info",
        agent,
        list: "allow",
        rule,
        message:
          "interpreter rule: ask/deny rules match command text only, code run through this interpreter is not covered",
      });
    } else if (isCompoundHelper(rule)) {
      findings.push({
        level: "info",
        agent,
        list: "allow",
        rule,
        message:
          "compound helper: Claude Code splits compound commands, every subcommand must match an allow rule on its own",
      });
    }
  }
  return findings;
}

/**
 * Validate every agent dir with a settings.json. Findings are
 * { level, agent, list, rule, message }; levels:
 *   error   — unusable rule (not a string / empty / invalid shape / empty
 *             pattern / primary-field form), duplicate rule within one list or
 *             across allow/ask/deny, or SUPERVISOR_DENY missing a DENY_BASELINE
 *             entry (child deny baseline shrank)
 *   warning — an ask/deny Bash/PowerShell rule whose prefix extends an allow
 *             rule's prefix (deny > ask > allow wins, so the allow is a lie)
 *   info    — interpreter / compound-helper allow rules (documented blind spots)
 * `supervisorDeny` is a test seam; production uses the SUPERVISOR_DENY import.
 */
export function checkFindings({ agentsDir = squadConfigRoot(), supervisorDeny = SUPERVISOR_DENY } = {}) {
  const findings = [];
  for (const agent of listAgents(agentsDir)) {
    const settingsPath = join(agentsDir, agent, "settings.json");
    let settings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      findings.push({
        level: "error",
        agent,
        list: "settings",
        rule: "",
        message: `settings.json is not valid JSON: ${err.message}`,
      });
      continue;
    }
    findings.push(...agentFindings(agent, settings));
  }
  // child deny baseline: the live SUPERVISOR_DENY must still contain every
  // pinned entry — a shrink silently loosens every child spawned afterwards.
  const denyNow = supervisorDeny ?? [];
  for (const rule of DENY_BASELINE) {
    if (!denyNow.includes(rule)) {
      findings.push({
        level: "error",
        agent: "supervisor-lib",
        list: "deny",
        rule,
        message:
          "SUPERVISOR_DENY is missing this baseline entry — the child deny baseline shrank (re-pin DENY_BASELINE in scripts/agent-tools.mjs if the shrink was deliberate)",
      });
    }
  }
  const summary = {
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    infos: findings.filter((f) => f.level === "info").length,
  };
  return { findings, summary, ok: summary.errors === 0 };
}

// ── edit (FOC-906) ───────────────────────────────────────────────────────────

const PROTECTED_DENY_MESSAGE =
  "protected deny rule — edit SUPERVISOR_DENY in supervisor-lib.mjs with a ticket";

// Canonical key order of the permissions object (mirrors the committed
// supervisor file): allow → deny → ask. A missing list is created in this
// position; existing keys keep their original file order.
const PERMISSION_KEY_ORDER = ["allow", "deny", "ask"];

/**
 * The protected deny rules: DENY_BASELINE ∪ the live SUPERVISOR_DENY, matched
 * by exact string and by rulePrefix equality. `supervisorDeny` is a test seam;
 * production uses the SUPERVISOR_DENY import.
 */
export function protectedDeny({ supervisorDeny = SUPERVISOR_DENY } = {}) {
  const rules = new Set([...DENY_BASELINE, ...(supervisorDeny ?? [])]);
  const prefixes = new Set(
    [...rules].map(rulePrefix).filter((p) => p !== null && p.trim() !== ""),
  );
  return { rules, prefixes };
}

function isProtectedDeny(rule, { rules, prefixes }) {
  if (rules.has(rule)) return true;
  const prefix = rulePrefix(rule);
  return prefix !== null && prefix.trim() !== "" && prefixes.has(prefix);
}

/**
 * Insert a missing permissions list in its canonical position (after `allow`,
 * then after `deny`), keeping every existing key in its original order.
 */
function insertPermissionList(perms, list, value) {
  const entries = Object.entries(perms);
  const predecessors = PERMISSION_KEY_ORDER.slice(0, PERMISSION_KEY_ORDER.indexOf(list));
  let at = -1;
  entries.forEach(([key], i) => {
    if (predecessors.includes(key)) at = i;
  });
  entries.splice(at + 1, 0, [list, value]);
  return Object.fromEntries(entries);
}

/**
 * Edit one agent's permission lists. verb: "allow" | "ask" | "deny" (append
 * the rule to that list) or "remove" (delete the exact string from whichever
 * list holds it).
 *
 * Validates the WOULD-BE settings BEFORE writing anything — rule shape,
 * duplicates (already in the same list → no-op, in another list → refusal),
 * the full `check` finding set on the edited agent, and, for `remove`, the
 * protected deny rules (DENY_BASELINE ∪ live SUPERVISOR_DENY, exact string or
 * rulePrefix). Any error refuses the edit and writes nothing. The write itself
 * is atomic (atomicWriteJSON), appends without re-sorting, and preserves the
 * file's key order.
 *
 * After a successful write to the REPOSITORY tree (`agentsDir ===
 * repoAgentsDir`; production REPO_AGENTS_DIR, a test seam otherwise) the
 * generated reference doc is regenerated into `docsOut`.
 *
 * Returns { ok, agent, verb, rule, list, settingsPath, noop, dryRun, docs,
 * check: { summary, findings } } on success (noop: the rule was already in
 * that list), or { ok: false, errors: [...] } on a refusal.
 */
export function editAgent(agent, verb, rule, {
  agentsDir = squadConfigRoot(),
  dryRun = false,
  docsOut = join(REPO_ROOT, "docs", "agent-tools.md"),
  repoAgentsDir = REPO_AGENTS_DIR,
  supervisorDeny = SUPERVISOR_DENY,
} = {}) {
  const parsed = parseRule(rule);
  if (!parsed.ok) {
    return { ok: false, errors: [`invalid rule (${parsed.reason}): ${JSON.stringify(rule)}`] };
  }
  const settingsPath = join(agentsDir, agent, "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      ok: false,
      errors: [`no settings.json for ${agent} under ${agentsDir} — known agents: ${listAgents(agentsDir).join(", ") || "(none)"}`],
    };
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`${settingsPath} is not valid JSON: ${err.message}`] };
  }
  const perms =
    settings?.permissions && typeof settings.permissions === "object"
      ? settings.permissions
      : {};
  // A list that is defined but not an array refuses the edit — it must not be
  // silently replaced (the file is broken; fixing it is a separate decision).
  for (const list of LISTS) {
    if (perms[list] !== undefined && !Array.isArray(perms[list])) {
      return { ok: false, errors: [`permissions.${list} is not an array`] };
    }
  }
  const current = {};
  for (const list of LISTS) current[list] = Array.isArray(perms[list]) ? perms[list] : [];

  const result = { agent, verb, rule, settingsPath, noop: false, dryRun, docs: null, warnings: [] };
  let list;
  if (verb === "remove") {
    if (isProtectedDeny(rule, protectedDeny({ supervisorDeny }))) {
      return { ok: false, errors: [`${rule}: ${PROTECTED_DENY_MESSAGE}`] };
    }
    const holders = LISTS.filter((l) => current[l].includes(rule));
    if (!holders.length) {
      return { ok: false, errors: [`rule not found in any list of ${agent}: ${rule}`] };
    }
    // keep removing from the FIRST holder (allow → ask → deny file order) …
    list = holders[0];
    // …and name the others so the caller knows the rule still exists there.
    result.warnings = holders.slice(1).map((l) => `${rule} also present in ${l} — run check`);
  } else {
    list = verb;
    const holder = LISTS.find((l) => current[l].includes(rule));
    if (holder === list) {
      // already in the target list — nothing to change, nothing to write
      return {
        ...result,
        ok: true,
        list,
        noop: true,
        check: checkOf(agent, settings),
      };
    }
    if (holder) {
      return { ok: false, errors: [`duplicate rule: ${rule} is already in ${holder}`] };
    }
  }

  // The would-be settings: existing arrays spliced in place (no re-sorting),
  // a missing list created in the canonical position, key order preserved.
  const nextList = verb === "remove"
    ? current[list].filter((r) => r !== rule)
    : [...current[list], rule];
  const nextPerms = perms[list] !== undefined
    ? { ...perms, [list]: nextList }
    : insertPermissionList(perms, list, nextList);
  const wouldBe = { ...settings, permissions: nextPerms };

  // Validate BEFORE writing: the same findings `check` would report on the
  // file after the write. Any error refuses the edit — nothing is written.
  const { summary, findings } = checkOf(agent, wouldBe);
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length) {
    return {
      ok: false,
      errors: errors.map((f) => `${f.list} ${f.rule}: ${f.message}`),
    };
  }

  if (dryRun) {
    return {
      ...result,
      ok: true,
      list,
      docs: { regenerated: false, path: docsOut, wouldRegenerate: inRepoTree(agentsDir, repoAgentsDir) },
      check: { summary, findings },
    };
  }
  atomicWriteJSON(settingsPath, wouldBe);
  const docs = inRepoTree(agentsDir, repoAgentsDir)
    ? { regenerated: true, path: docsOut }
    : null;
  // Default .mcp.json on purpose — the docs pin test renders the repo tree with it, so the regenerated file must match.
  if (docs) writeFileSync(docs.path, renderDocs({ agentsDir, mcpPath: DEFAULT_MCP_PATH }) + "\n");
  return { ...result, ok: true, list, docs, check: { summary, findings } };
}

function inRepoTree(agentsDir, repoAgentsDir) {
  return resolve(agentsDir) === resolve(repoAgentsDir);
}

/** agentFindings + summary for one agent's settings object. */
function checkOf(agent, settings) {
  const findings = agentFindings(agent, settings);
  const summary = {
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    infos: findings.filter((f) => f.level === "info").length,
  };
  return { summary, findings };
}

function editText(result) {
  const out = [];
  out.push(`agent: ${result.agent}`);
  out.push(`settings: ${result.settingsPath}`);
  if (result.noop) {
    out.push(`= ${result.list} ${result.rule} (already present — no-op)`);
  } else {
    out.push(`${result.verb === "remove" ? "-" : "+"} ${result.list} ${result.rule}`);
  }
  for (const warning of result.warnings) out.push(`warning: ${warning}`);
  if (result.dryRun) {
    out.push(
      result.docs?.wouldRegenerate
        ? "docs: would be regenerated (dry-run — nothing written)"
        : "docs: not regenerated (effective root is not the repository tree)",
    );
    out.push("dry-run: nothing written");
  } else if (result.docs?.regenerated) {
    out.push(`docs: regenerated ${result.docs.path}`);
  } else if (!result.noop) {
    out.push("docs: not regenerated (effective root is not the repository tree)");
  }
  const { summary } = result.check;
  out.push(
    `summary: ${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}, ${plural(summary.infos, "info")}`,
  );
  return out.join("\n") + "\n";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── docs ─────────────────────────────────────────────────────────────────────

/**
 * Render the generated Markdown reference. Deterministic: agents sorted,
 * rules in file order. Notes reuse the check logic (interpreter / compound
 * helper for allow rules, overlap for ask/deny rules).
 */
export function renderDocs({ agentsDir = REPO_AGENTS_DIR, mcpPath = DEFAULT_MCP_PATH } = {}) {
  const out = [];
  out.push("# Agent settings — generated reference");
  out.push("");
  out.push(
    "Generated by `node scripts/agent-tools.mjs docs --write` — do not edit by hand; edit",
  );
  out.push(
    "`agents/<agent>/settings.json` and regenerate. Claude Code permission facts this",
  );
  out.push(
    "reference encodes: precedence is deny > ask > allow (a matching ask/deny rule wins",
  );
  out.push(
    "even when a more specific allow rule also matches the same call), and rules match",
  );
  out.push(
    "command text only — compound commands are split so every subcommand must match a",
  );
  out.push(
    "rule on its own, and code run through an allowed interpreter is not covered by",
  );
  out.push("ask/deny on other commands.");
  out.push("");
  out.push(
    "Rendered from the repository's `agents/` tree — the image baseline; `show`/`check`",
  );
  out.push(
    "read the effective root instead (`LA_SQUAD_HOME` when set, else the same tree).",
  );
  out.push(
    "MCP reachability here honours server-wildcard denies only (`mcp__<server>__*`,",
  );
  out.push(
    "`mcp__*`, `*`); a tool-level deny (`mcp__linear__create_issue`) does not make the",
  );
  out.push("server unreachable in this view.");
  out.push("");
  out.push(
    'Editing: `allow|ask|deny <agent> "<rule>"` append a rule to that list and',
  );
  out.push(
    '`remove <agent> "<rule>"` deletes it from whichever list holds it — every edit',
  );
  out.push(
    "is validated first and written atomically with the file's key order preserved",
  );
  out.push(
    "(`--dry-run` prints without writing). Rules in SUPERVISOR_DENY, or with the same",
  );
  out.push(
    "command prefix, are protected — edit supervisor-lib.mjs with a ticket instead.",
  );
  out.push(
    "Nothing is committed by the tool; an edit to the repository tree regenerates",
  );
  out.push("this file in the same step.");
  out.push("");
  for (const agent of listAgents(agentsDir)) {
    const data = showAgent(agent, { agentsDir, mcpPath });
    out.push(`## ${agent}`);
    out.push("");
    out.push("### Permissions");
    out.push("");
    for (const list of LISTS) {
      out.push(`${list}:`);
      out.push("");
      if (!data.permissions[list].length) {
        out.push("(none)");
        out.push("");
        continue;
      }
      out.push("| rule | note |");
      out.push("|---|---|");
      for (const rule of data.permissions[list]) {
        out.push(`| \`${rule}\` | ${ruleNote(agent, list, rule, data)} |`);
      }
      out.push("");
    }
    out.push("### Other settings");
    out.push("");
    out.push(
      `- additional directories: ${
        data.additionalDirectories.length
          ? data.additionalDirectories.map((d) => `\`${d}\``).join(", ")
          : "(none)"
      }`,
    );
    out.push(`- default mode: \`${data.defaultMode ?? "(unset)"}\``);
    out.push("");
    out.push("### Hooks");
    out.push("");
    const events = Object.entries(data.hooks);
    if (!events.length) {
      out.push("(none)");
    } else {
      out.push("| event | command hooks |");
      out.push("|---|---|");
      for (const [event, count] of events) out.push(`| ${event} | ${count} |`);
    }
    out.push("");
    out.push("### MCP servers");
    out.push("");
    if (!data.mcp.length) {
      out.push("(none)");
    } else {
      out.push("| server | reachable | via |");
      out.push("|---|---|---|");
      for (const { server, reachable, via } of data.mcp) {
        out.push(`| ${server} | ${reachable ? "yes" : "no"} | ${via ? `\`${via}\`` : "—"} |`);
      }
    }
    out.push("");
    out.push("### Skills");
    out.push("");
    if (!data.skills.length) {
      out.push("(none)");
    } else {
      out.push("| name | source |");
      out.push("|---|---|");
      for (const { name, source } of data.skills) out.push(`| ${name} | ${source} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

function ruleNote(agent, list, rule, data) {
  if (list === "allow") {
    if (isInterpreterRule(rule)) return "interpreter";
    if (isCompoundHelper(rule)) return "compound helper";
    return "";
  }
  const prefix = rulePrefix(rule);
  if (prefix === null || prefix.trim() === "" || data.permissions.allow.includes(rule)) {
    return "";
  }
  for (const allowRule of data.permissions.allow) {
    const allowPrefix = rulePrefix(allowRule);
    if (allowPrefix !== null && allowPrefix.trim() !== "" && prefix.startsWith(allowPrefix)) {
      return "overlap";
    }
  }
  return "";
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/agent-tools.mjs <command> [options]

Commands:
  show <agent>            print one agent's settings (permissions, MCP, skills)
  diff <agent> --against <git-ref>
                          diff the permission lists against a git ref
  check                   validate every agents/<agent>/settings.json
  docs [--write] [--out <path>]
                          render the generated reference (docs/agent-tools.md
                          by default; stdout without --write)
  allow|ask|deny <agent> "<rule>"
                          append the rule to that list — validated first,
                          written atomically, key order preserved
  remove <agent> "<rule>"
                          remove the rule from whichever list holds it
                          (protected deny rules (DENY_BASELINE ∪
                          SUPERVISOR_DENY) refuse)

Options:
  --root <agentsDir>      agents directory (default: $LA_SQUAD_HOME when set,
                          else <repo>/agents)
  --mcp <path>            .mcp.json path (default: <repo>/.mcp.json)
  --json                  machine-readable output
  --dry-run               print the edit without writing anything
  --docs-out <path>       where an edit to the repository tree regenerates the
                          generated reference (default docs/agent-tools.md)

Exit codes: 0 ok | 1 errors | 2 usage
`;

export function runCli(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env, repoAgentsDir = REPO_AGENTS_DIR } = {}) {
  const usageError = (message) => {
    if (message) stderr.write(`${message}\n`);
    stderr.write(USAGE);
    return 2;
  };
  if (!argv.length) {
    stderr.write(USAGE);
    return 2;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    stdout.write(USAGE);
    return 0;
  }
  const verb = argv[0];
  const opts = { positional: [], root: null, mcp: null, json: false, against: null, write: false, out: null, dryRun: false, docsOut: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = ["--root", "--mcp", "--against", "--out", "--docs-out"];
    if (needsValue.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) return usageError(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--write") {
      opts.write = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      return usageError(`unknown option: ${arg}`);
    } else {
      opts.positional.push(arg);
    }
  }
  const agentsDir = opts.root ? resolve(cwd, opts.root) : squadConfigRoot(env);
  const mcpPath = opts.mcp ? resolve(cwd, opts.mcp) : DEFAULT_MCP_PATH;
  const io = { stdout, stderr, cwd, env };
  try {
    if (verb === "show") {
      const [agent] = opts.positional;
      if (!agent) return usageError("show needs an agent name");
      const data = showAgent(agent, { agentsDir, mcpPath });
      stdout.write(opts.json ? JSON.stringify(data, null, 2) + "\n" : showText(data));
      return 0;
    }
    if (verb === "diff") {
      const [agent] = opts.positional;
      if (!agent) return usageError("diff needs an agent name");
      if (!opts.against) return usageError("diff needs --against <git-ref>");
      const data = diffAgent(agent, opts.against, { agentsDir, env });
      stdout.write(opts.json ? JSON.stringify(data, null, 2) + "\n" : diffText(data));
      return 0;
    }
    if (verb === "check") {
      if (opts.positional.length) return usageError("check takes no arguments");
      const { findings, summary, ok } = checkFindings({ agentsDir });
      if (opts.json) {
        stdout.write(JSON.stringify({ ok, findings, summary }, null, 2) + "\n");
      } else {
        for (const f of findings) {
          stdout.write(`${f.level.toUpperCase()} ${f.agent} ${f.list} ${f.rule} — ${f.message}\n`);
        }
        stdout.write(
          `summary: ${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}, ${plural(summary.infos, "info")}\n`,
        );
      }
      return ok ? 0 : 1;
    }
    if (verb === "docs") {
      if (opts.positional.length) return usageError("docs takes no arguments");
      const markdown = renderDocs({ agentsDir, mcpPath }) + "\n";
      if (opts.write) {
        const outPath = opts.out ? resolve(cwd, opts.out) : join(REPO_ROOT, "docs", "agent-tools.md");
        writeFileSync(outPath, markdown);
        stderr.write(`docs written: ${outPath}\n`);
      } else {
        stdout.write(markdown);
      }
      return 0;
    }
    if (verb === "allow" || verb === "ask" || verb === "deny" || verb === "remove") {
      const [agent, rule] = opts.positional;
      if (!agent || rule === undefined) {
        return usageError(`${verb} needs an agent and a "rule"`);
      }
      if (opts.positional.length > 2) return usageError(`${verb} takes an agent and a "rule"`);
      const result = editAgent(agent, verb, rule, {
        agentsDir,
        dryRun: opts.dryRun,
        docsOut: opts["docs-out"] ? resolve(cwd, opts["docs-out"]) : undefined,
        repoAgentsDir,
      });
      if (!result.ok) {
        for (const message of result.errors) stderr.write(`error: ${message}\n`);
        return 1;
      }
      stdout.write(opts.json ? JSON.stringify(result, null, 2) + "\n" : editText(result));
      return 0;
    }
    return usageError(`unknown command: ${verb}`);
  } catch (err) {
    if (err.code === "UNKNOWN_AGENT") {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err.code === "DIFF_UNAVAILABLE") {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (not when imported for the helpers).
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
