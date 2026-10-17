// scripts/task-ownership.mjs — who owns which Linear ticket (FOC-848).
//
// Two actors (the native Supervisor and the orchestrator session) deliver from
// the same checkout, and nothing in the toolchain knew who owns which ticket —
// a ticket taken by the wrong owner means two actors on one branch and one
// Linear issue. This module is the typed place the answer lives in, and the
// enforcement points (supervisor-triage, supervisor-spawn, linear-ops) consult
// it where the decision is enforced, the same split autonomy-grants.mjs draws.
//
// The config carries owners → Linear projects and a policy for unlisted
// projects:
//
//   { "version": 1,
//     "owners": { "orchestrator": { "linearProjects": ["<project id or exact name>"] } },
//     "unlisted": "allow" | "ask" }
//
// Precedence: LA_TASK_OWNERSHIP_CONFIG (a JSON file — tests and one-off
// overrides) > the settings overlay key `ownership` (.fenix/config/settings.json,
// which survives `fenix update`) > the shipped config/task-ownership.json,
// resolved from this module's location — never from cwd.
//
// Fail-closed, same pattern as autonomy-grants.mjs: inline JSON Schema + Ajv,
// compiled once. A config that does not parse or does not match the schema is
// a thrown OwnershipConfigError, never a guessed lookup and never a fallback
// to the shipped default — a BROKEN config must not silently widen what an
// actor may take. The shipped default (`owners: {}`) is unrestricted: a fresh
// install with one Supervisor behaves exactly as before this module existed.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { readSettings } from "./fenix-settings.mjs";
import { settingsPath } from "./fenix-paths.mjs";
import {
  HOLDS_SCHEMA_VERSION,
  failJson,
  nextHoldId,
  parseArgs,
  readHolds,
  writeHolds,
} from "./supervisor-lib.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// The acting owner when nothing says otherwise; the orchestrator sets
// LA_TASK_OWNER=orchestrator when it drives the Supervisor toolchain.
export const DEFAULT_OWNER = "supervisor";
export const OWNER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// Named, coded errors — the CLI layer turns them into failJson, callers that
// catch can branch on `code`.
export class OwnershipConfigError extends Error {
  constructor(message, { code, path } = {}) {
    super(message);
    this.name = "OwnershipConfigError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

const OWNERSHIP_SCHEMA = {
  type: "object",
  required: ["owners"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    owners: {
      type: "object",
      propertyNames: { pattern: "^[a-z][a-z0-9-]{0,31}$" },
      additionalProperties: {
        type: "object",
        required: ["linearProjects"],
        additionalProperties: false,
        properties: {
          linearProjects: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    // Absent means "allow" — the same default a fresh install ships with.
    unlisted: { enum: ["allow", "ask"], default: "allow" },
  },
};

let compiled = null;
function validator() {
  if (!compiled) compiled = new Ajv({ allErrors: false, useDefaults: true }).compile(OWNERSHIP_SCHEMA);
  return compiled;
}

/**
 * Validate an ownership config in memory. Throws OwnershipConfigError
 * (config-invalid) on any schema violation. `requireVersion` is true for the
 * standalone files (env file, shipped config) and false for the settings
 * overlay, where `version` is optional.
 */
function validateOwnership(data, where, requireVersion) {
  const check = validator();
  if (!check(data)) {
    const detail = (check.errors ?? [])
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new OwnershipConfigError(`${where} does not match the task-ownership schema: ${detail}`, {
      code: "config-invalid",
      path: where,
    });
  }
  if (data.version === undefined && requireVersion) {
    throw new OwnershipConfigError(`${where} carries no version — expected 1`, {
      code: "config-invalid",
      path: where,
    });
  }
  return data;
}

function normalize(data, source) {
  // Incoming project names are trimmed at normalizeProject; the config's own
  // entries get the same treatment here — a "Fenix " entry must not miss the
  // "Fenix" payload, and an entry that is empty after trimming is a broken
  // config, not a silently unmatchable one.
  const owners = {};
  for (const [ownerId, entry] of Object.entries(data.owners)) {
    const linearProjects = entry.linearProjects.map((project) => project.trim());
    if (linearProjects.some((project) => !project)) {
      throw new OwnershipConfigError(
        `${source}: owner "${ownerId}" lists an empty linearProjects entry — remove it or name the project`,
        { code: "config-invalid", path: source },
      );
    }
    owners[ownerId] = { ...entry, linearProjects };
  }
  return {
    version: data.version ?? 1,
    owners,
    unlisted: data.unlisted ?? "allow",
    source,
    restricted: Object.keys(owners).length > 0,
  };
}

function loadOwnershipFile(path, source) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new OwnershipConfigError(`cannot read task-ownership config ${path}: ${err.message.split("\n")[0]}`, {
      code: "config-unreadable",
      path,
    });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new OwnershipConfigError(`task-ownership config ${path} is not valid JSON: ${err.message.split("\n")[0]}`, {
      code: "config-invalid",
      path,
    });
  }
  return normalize(validateOwnership(data, path, true), source);
}

/**
 * Read + validate the ownership config, resolving the precedence ladder:
 * LA_TASK_OWNERSHIP_CONFIG file > settings overlay key `ownership` > shipped
 * config. Fail-closed at every rung: an unreadable or invalid config is a
 * thrown OwnershipConfigError, never a fallback to the shipped default.
 */
export function loadOwnership({ env = process.env } = {}) {
  if (env.LA_TASK_OWNERSHIP_CONFIG) {
    return loadOwnershipFile(env.LA_TASK_OWNERSHIP_CONFIG, "env");
  }
  // The overlay rung: a settings file that cannot be read is fail-closed
  // material too — it may be the rung that RESTRICTS this install.
  let overlay;
  try {
    overlay = readSettings();
  } catch (err) {
    throw new OwnershipConfigError(
      `the settings overlay (${settingsPath()}) could not be read: ${err.message.split("\n")[0]}`,
      { code: "config-unreadable", path: settingsPath() },
    );
  }
  if (overlay && typeof overlay === "object" && !Array.isArray(overlay) && overlay.ownership !== undefined) {
    const where = `the ownership key in the settings overlay (${settingsPath()})`;
    return normalize(validateOwnership(overlay.ownership, where, false), "overlay");
  }
  // The shipped rung, resolved from this module's location — never from cwd,
  // so a CLI child run from any directory resolves the same config.
  return loadOwnershipFile(join(__dir, "..", "config", "task-ownership.json"), "shipped");
}

/** The acting owner: LA_TASK_OWNER when set, DEFAULT_OWNER otherwise. */
export function currentOwner(env = process.env) {
  const raw = env.LA_TASK_OWNER;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_OWNER;
  const owner = String(raw).trim();
  if (!OWNER_ID_RE.test(owner)) {
    throw new OwnershipConfigError(
      `LA_TASK_OWNER "${owner}" does not match ${OWNER_ID_RE} — refusing a malformed acting owner`,
      { code: "owner-id-invalid" },
    );
  }
  return owner;
}

// The issue's project arrives in three shapes across the callers: the Linear
// payload's { id, name }, a bare string, or nothing at all.
function normalizeProject(project) {
  if (project === null || project === undefined) return null;
  if (typeof project === "string") {
    const name = project.trim();
    return name ? { id: null, name } : null;
  }
  if (typeof project === "object" && !Array.isArray(project)) {
    const id = typeof project.id === "string" && project.id.trim() ? project.id : null;
    const name = typeof project.name === "string" && project.name.trim() ? project.name : null;
    return id || name ? { id, name } : null;
  }
  return null;
}

const describeProject = (project) =>
  project?.name || project?.id ? `"${project.name || project.id}"` : "(no project)";

// Which owners list this project (by exact id or exact name)? A project listed
// under two owners is a config error, not a coin flip.
function ownersClaiming(owners, project) {
  const claiming = [];
  for (const [ownerId, entry] of Object.entries(owners)) {
    const listed = entry.linearProjects ?? [];
    const matches =
      (project.id && listed.includes(project.id)) || (project.name && listed.includes(project.name));
    if (matches) claiming.push(ownerId);
  }
  return claiming;
}

const unlistedVerdict = (owner, project, config) => ({
  verdict: "unlisted",
  allowed: config.unlisted === "allow",
  owner,
  project,
  policy: config.unlisted,
});

/**
 * The one verdict function every enforcement point shares.
 *
 * `issue.project` may be the Linear shape { id, name }, a bare string, or
 * null/absent. Returns { verdict, allowed, owner, project, ... } with:
 *   unrestricted — no owners configured, the install behaves as before;
 *   owned        — the project is listed under the acting owner (by id or name);
 *   foreign      — listed under ANOTHER owner; never allowed (ownedBy names it);
 *   unlisted     — nobody lists it; allowed iff the policy is "allow" (policy
 *                  carries the config value; a missing project on a restricted
 *                  install lands here too).
 * A project listed under two owners throws (code project-ambiguous).
 */
export function checkOwnership(issue, { owner = currentOwner(), config = loadOwnership() } = {}) {
  // Accept both the loader's normalized shape and a raw config object: the
  // derived fields (restricted, unlisted default) are recomputed when absent,
  // never trusted blindly.
  const cfg = config && typeof config === "object" && !Array.isArray(config)
    ? {
        owners: config.owners ?? {},
        unlisted: config.unlisted ?? "allow",
        restricted: config.restricted ?? Object.keys(config.owners ?? {}).length > 0,
      }
    : { owners: {}, unlisted: "allow", restricted: false };
  const project = normalizeProject(issue?.project);
  if (!cfg.restricted) {
    return { verdict: "unrestricted", allowed: true, owner, project };
  }
  if (!project) return unlistedVerdict(owner, null, cfg);
  const claiming = ownersClaiming(cfg.owners, project);
  if (claiming.length > 1) {
    throw new OwnershipConfigError(
      `project ${describeProject(project)} is listed under ${claiming.length} owners (${claiming.join(", ")}) — a project has exactly one owner`,
      { code: "project-ambiguous" },
    );
  }
  if (claiming.length === 1) {
    if (claiming[0] === owner) return { verdict: "owned", allowed: true, owner, project };
    return { verdict: "foreign", allowed: false, owner, project, ownedBy: claiming[0] };
  }
  return unlistedVerdict(owner, project, cfg);
}

/**
 * The refusal record the enforcement points turn into their exit contracts.
 * English on purpose — it is read by the Supervisor's contract and by Mateusz.
 * Only callable on a refused verdict; an allowed one is a caller bug.
 */
export function ownershipRefusal(result, issueId) {
  if (result.allowed) {
    throw new Error(
      `ownershipRefusal: ${issueId} carries verdict ${result.verdict}, which is allowed — there is nothing to refuse`,
    );
  }
  // "unverified" is not a project verdict — it is supervisor-spawn's shape for
  // "triage.json carries no ownership stamp (or one from another owner)". It
  // has no project and no policy to name, and the fix is a triage run, not a
  // settings edit.
  if (result.verdict === "unverified") {
    return {
      code: "ownership-unverified",
      message:
        `${issueId} carries no ownership stamp for acting owner ${result.owner} — ` +
        `triage was not recorded, or was recorded by another owner; the spawn is refused`,
    };
  }
  const where = ` (project ${describeProject(result.project)})`;
  const message =
    result.verdict === "foreign"
      ? `${issueId}${where} is owned by ${result.ownedBy} — acting owner ${result.owner} must not take it; ask Mateusz or reassign ownership in .fenix/config/settings.json`
      : `${issueId}${where} is not listed under owner ${result.owner} (unlisted policy: ${result.policy}) — ask Mateusz or reassign ownership in .fenix/config/settings.json`;
  return { code: `ownership-${result.verdict}`, message };
}

// The hold's options: a refusal is a DECISION for Mateusz, not a model run, so
// both options are zero-cost. costUsd: 0 is a priced figure at the store
// validator (a number >= 0, not null); the model field is mandatory there and
// names what the cost is priced against — here, nothing.
const HOLD_OPTION_MODEL = "n/a — a decision, no model run";
const HOLD_OPTIONS = [
  { label: "Leave the ticket to its owner (skip)", model: HOLD_OPTION_MODEL, costUsd: 0 },
  { label: "Reassign the project in .fenix/config/settings.json (Mateusz)", model: HOLD_OPTION_MODEL, costUsd: 0 },
];
// An unverified spawn refusal is fixed by running the triage, not by a
// settings edit — the options name what actually unblocks it.
const HOLD_OPTIONS_UNVERIFIED = [
  { label: "Record the triage for this task as the acting owner, then respawn", model: HOLD_OPTION_MODEL, costUsd: 0 },
  { label: "Leave the ticket to its owner (skip)", model: HOLD_OPTION_MODEL, costUsd: 0 },
];

/**
 * Record the ownership hold the way `supervisor-gate.mjs hold` writes one —
 * the same record shape, the same store helpers (readHolds/nextHoldId/
 * writeHolds from supervisor-lib). cmdHold itself is a CLI-layer function, so
 * the record is built here and validated by the same fail-closed
 * validateHoldStore on write. Idempotent per run+issue: an open hold with this
 * origin whose issueId matches is returned as-is, so a retried triage does not
 * pile up duplicates. A falsy runId returns null — the
 * caller refuses the ticket anyway; there is just no run to owe the decision
 * to.
 */
export function recordOwnershipHold({ runId, issueId, result, origin = "ownership" }) {
  if (!runId) return null;
  const refusal = ownershipRefusal(result, issueId);
  const store = readHolds(runId);
  const existing = store.holds.find(
    (hold) => hold.state === "open" && hold.origin === origin && hold.issueId === issueId,
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  const unverified = result.verdict === "unverified";
  const hold = {
    id: nextHoldId(runId),
    origin,
    issueId,
    question: refusal.message,
    options: unverified ? HOLD_OPTIONS_UNVERIFIED : HOLD_OPTIONS,
    recommendation: unverified
      ? "Record the triage for this task as the acting owner — the refusal means the stamp was missing or another owner recorded it."
      : "Leave the ticket to its owner unless Mateusz reassigns the project.",
    impact: "medium",
    resolution: null,
    state: "open",
    createdAt: now,
    presentedAt: null,
    until: null,
    answer: null,
    blocks: null,
    history: [{ event: "created", at: now }],
  };
  writeHolds(runId, { version: HOLDS_SCHEMA_VERSION, holds: [...store.holds, hold] });
  return hold;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//   node scripts/task-ownership.mjs show
//   node scripts/task-ownership.mjs check --issue <ID> [--owner <id>] [--issue-file <path>]
//
// `show` prints the resolved config, its source and the acting owner. `check`
// loads the issue like supervisor-triage's loadIssue (--issue-file is the
// offline seam) and prints the verdict; exit 0 when allowed, 1 when not.

function loadIssue(args) {
  if (args["issue-file"]) {
    const path = args["issue-file"];
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      failJson(`--issue-file ${path} is not readable: ${err.message}`);
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed.issue ?? parsed;
    } catch (err) {
      failJson(`--issue-file ${path} is not readable JSON: ${err.message}`);
    }
  }
  if (!args.issue) failJson("--issue <id> is required (or pass --issue-file <path>)");
  // Same shape as supervisor-triage's loadIssue: the real Linear payload
  // through linear-query.mjs, or a saved fixture through --issue-file.
  try {
    const out = execFileSync(
      process.execPath,
      [join(__dir, "linear-query.mjs"), "issue", args.issue, "--json"],
      { cwd: join(__dir, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out);
  } catch (err) {
    failJson(`could not read issue ${args.issue} from Linear: ${err.message.split("\n")[0]}`, {
      hint: "pass --issue-file <path> to check from a saved payload",
    });
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "show" && rest.length === 0) {
    try {
      const config = loadOwnership();
      console.log(JSON.stringify({ ok: true, actingOwner: currentOwner(), config }, null, 2));
    } catch (err) {
      failJson(err?.message || String(err), { code: err.code });
    }
    return;
  }
  if (cmd === "check") {
    const args = parseArgs(rest);
    if (args.owner === true) failJson("--owner requires a value (the acting owner id)");
    if (args.owner !== undefined && !OWNER_ID_RE.test(args.owner)) {
      failJson(`--owner must match ${OWNER_ID_RE}, got "${args.owner}"`);
    }
    const issue = loadIssue(args);
    try {
      const result = checkOwnership(issue, { owner: args.owner ?? undefined });
      const refusal = result.allowed ? null : ownershipRefusal(result, issue.identifier || args.issue);
      console.log(JSON.stringify({ ok: result.allowed, ...result, ...(refusal ? { refusal } : {}) }, null, 2));
      process.exit(result.allowed ? 0 : 1);
    } catch (err) {
      failJson(err?.message || String(err), { code: err.code });
    }
    return;
  }
  console.error("Usage: node scripts/task-ownership.mjs show");
  console.error("       node scripts/task-ownership.mjs check --issue <ID> [--owner <id>] [--issue-file <path>]");
  process.exit(2);
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
