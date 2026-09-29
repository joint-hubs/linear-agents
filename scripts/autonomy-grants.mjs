// scripts/autonomy-grants.mjs — the fail-closed loader for config/autonomy.json (FOC-613).
//
// config/autonomy.json is the one typed place where standing operator decisions
// are recorded as GRANTS: each names the actions it covers, the scope it covers
// them in, who granted it, and when it lapses. Consumers consult grants where
// the decision is enforced — today that is supervisor-cleanup.mjs `remove`,
// which accepts the `cleanup-own-worktree` grant as a stand-in for the
// cleanup-approval gate on trees entirely landed in main. The precedence
// ladder that tells the Supervisor how to weigh a grant against a live
// instruction lives in agents/supervisor/CLAUDE.md (<precedence_policy>); this
// module only makes the data trustworthy.
//
// Fail-closed, same pattern as scripts/decision-registry.mjs: inline JSON
// Schema + Ajv, compiled once. A config that does not parse, does not match
// the schema, carries a grant action that is in `neverCovers`, or carries an
// unparseable date is a thrown error, never a guessed lookup. A BROKEN config
// can never unlock anything: consumers treat a load failure as "no grant
// consulted" and fall through to whatever human gate the decision needed
// anyway — the loader exists to make grants safe, not to make them required.
//
// `neverCovers` is pinned to the code's own list (schema `const`), so a config
// that widens or trims it is refused at load: widening would claim a grant can
// cover something the harness denies, trimming would invite one.
//
// This module is DATA ONLY — it reads one file and validates it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const __dir = dirname(fileURLToPath(import.meta.url));

// The actions no grant may ever name. A grant naming one of these is refused
// at load time (validateAutonomy), and no consumer may build a code path that
// performs them via a grant — supervisor-autonomy.test.mjs asserts both, per
// entry.
export const NEVER_COVERS = ["push", "force", "discard", "delete-branch", "secrets"];

// The seam mirrors LA_SUPERVISOR_STATE_HOME / LA_TELEMETRY_DB: tests point it
// at a temp file; unset means the repo's own config, resolved from this
// module's location — never from cwd.
export const autonomyConfigPath = () =>
  process.env.LA_AUTONOMY_CONFIG || join(__dir, "..", "config", "autonomy.json");

const ISO_DATE = "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?)?$";
const NAME = "^[a-z][a-z0-9-]*$";

export const AUTONOMY_SCHEMA = {
  type: "object",
  required: ["neverCovers", "grants"],
  additionalProperties: false,
  properties: {
    _doc: { type: "string" },
    neverCovers: { const: NEVER_COVERS },
    grants: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "actions", "scope", "source", "grantedAt", "expires"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: NAME, minLength: 1, maxLength: 120 },
          actions: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: NAME, minLength: 1, maxLength: 60 },
          },
          scope: {
            type: "object",
            required: ["repo", "branches"],
            additionalProperties: true,
            properties: {
              repo: { type: "string", minLength: 1 },
              branches: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              // Declarative pins for the cleanup grant: the config declares
              // what the consumer enforces, and the consumer's test re-asserts
              // the behaviour. The consumer enforces them for every grant it
              // consults, not because the field says so.
              clean: { const: true },
              landed: { const: true },
              ownership: { const: "supervisor-worktree" },
            },
          },
          source: { type: "string", minLength: 1, maxLength: 2000 },
          grantedAt: { type: "string", pattern: ISO_DATE },
          expires: { type: ["string", "null"], pattern: ISO_DATE },
        },
      },
    },
  },
};

let compiled = null;
function validator() {
  if (!compiled) compiled = new Ajv({ allErrors: false }).compile(AUTONOMY_SCHEMA);
  return compiled;
}

/**
 * Validate an autonomy config in memory. Throws (plain Error — supervisor-lib
 * style, the CLI layer turns it into failJson) on any schema violation, on any
 * grant action that is in `neverCovers`, and on any non-parseable date.
 */
export function validateAutonomy(data, where = "config/autonomy.json") {
  const check = validator();
  if (!check(data)) {
    const detail = (check.errors ?? [])
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new Error(`${where} does not match the autonomy schema: ${detail}`);
  }
  for (const grant of data.grants) {
    for (const action of grant.actions) {
      if (NEVER_COVERS.includes(action)) {
        throw new Error(
          `${where}: grant "${grant.id}" names action "${action}", which is in neverCovers — a grant can never cover it`,
        );
      }
    }
    for (const field of ["grantedAt", "expires"]) {
      if (grant[field] !== null && Number.isNaN(Date.parse(grant[field]))) {
        throw new Error(`${where}: grant "${grant.id}" carries a non-parseable ${field}: ${grant[field]}`);
      }
    }
  }
  return data;
}

/** Read + validate the config. Throws on missing, unreadable or invalid. */
export function loadAutonomyGrants() {
  const path = autonomyConfigPath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read autonomy config ${path}: ${err.message.split("\n")[0]}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`autonomy config ${path} is not valid JSON: ${err.message.split("\n")[0]}`);
  }
  return validateAutonomy(data, path);
}

/** `expires: null` is open-ended; a set expires that has passed kills the grant. */
export function grantIsActive(grant, now = new Date()) {
  if (grant.expires === null || grant.expires === undefined) return true;
  const at = Date.parse(grant.expires);
  return !Number.isNaN(at) && at >= now.getTime();
}

/** `*` glob, case-insensitive — enough for branch and repo-name scope patterns. */
export function globMatch(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  const re = new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    "i",
  );
  return re.test(value);
}