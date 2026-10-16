#!/usr/bin/env node
/**
 * scripts/linear-client.mjs — Reusable Linear GraphQL client.
 *
 * Zero npm deps, Node 18+ global fetch. Exports shared helpers for
 * Linear API access: env loading, raw graphql(), team resolution,
 * and issue resolution (by identifier with search fallback).
 *
 * ADR context: per Mateusz approval "Rób wszystko przez API" — all Linear
 * operations go through the GraphQL API directly, not through MCP tools.
 *
 * Usage (standalone):
 *   node scripts/linear-client.mjs team [TEAM_KEY]
 *   node scripts/linear-client.mjs issue FEN-12
 *
 * Dependencies: Node 18+ (global fetch). No npm install required.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
// FOC-772: the optional-integrations switch gates the pisi workspace before
// any key lookup — the reading lives in fenix-integrations.mjs, the overlay
// path in fenix-paths/fenix-settings (no import cycles: none of them imports
// back into linear-client).
import { settingsPath } from "./fenix-paths.mjs";
import { readSettings } from "./fenix-settings.mjs";
import { integrationEnabled } from "./fenix-integrations.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers (mirrors linear-push.mjs / bootstrap-linear.mjs convention)
// ---------------------------------------------------------------------------

/** Manual .env parser — zero deps, mirrors cost-report.mjs convention.
 * FOC-355: LA_LINEAR_NO_ENV_FILE=1 skips the .env read so the supervisor
 * test suite can strip credentials hermetically even on a checkout that
 * carries .env — loadEnv() would otherwise backfill the stripped keys. */
export function loadEnv() {
  if (process.env.LA_LINEAR_NO_ENV_FILE) return;
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // .env missing — user may have set env vars directly
  }
}

export const ENDPOINT = "https://api.linear.app/graphql";

// ---------------------------------------------------------------------------
// Workspace availability (FOC-772)
// ---------------------------------------------------------------------------

/**
 * The operator-facing refusal for a disabled workspace. One definition — the
 * board error rows, the queue degrade payload and the publisher's exit all
 * surface this string verbatim, so the fix is stated the same way everywhere.
 * @param {string} workspace
 * @returns {string}
 */
export function integrationOffMessage(workspace) {
  return workspace === "pisi"
    ? `the pisi workspace is off — enable it with: node scripts/fenix-settings.mjs set integrations '{"pisi":true}'`
    : `the ${workspace} workspace is off`;
}

/**
 * Typed refusal for a request that names a workspace whose integration switch
 * is off. Callers match on `code` (never on the message text); `workspace`
 * says which switch to turn on. Thrown BEFORE any key lookup or network call.
 */
export class IntegrationOffError extends Error {
  constructor(workspace) {
    super(integrationOffMessage(workspace));
    this.name = "IntegrationOffError";
    this.code = "integration-off";
    this.workspace = workspace;
  }
}

/**
 * Whether a workspace may be talked to at all (FOC-772). The default
 * workspace (jointhubs) is always on — it is core, not an integration. pisi
 * reads the `integrations.pisi` overlay flag, which defaults to false.
 * Fail-closed: an invalid overlay reads as off (readIntegrationsSafe, one
 * warn per process) — this never throws for a corrupt settings file, so the
 * per-request callers (work routes, board, findIssueProject) cannot be taken
 * down by a bad overlay.
 *
 * @param {string} workspace  "jointhubs" | "pisi" (unknown names follow the
 *   default-workspace rule: always on, key selection stays chooseApiKey's job).
 * @param {object} [opts]
 * @param {object} [opts.env] - environment map (default: process.env); its
 *   LA_SETTINGS_FILE / LA_PROJECTS_FILE pick the overlay path.
 * @param {object} [opts.settings] - pre-read settings overlay; when omitted
 *   the overlay is read through the memoized cachedIntegrations read (5 s TTL
 *   keyed by the settings path + mtime).
 * @returns {boolean}
 */
export function workspaceEnabled(workspace, { env = process.env, settings } = {}) {
  if (workspace !== "pisi") return true;
  return integrationEnabled("pisi", {
    env,
    settings: settings !== undefined ? settings : readSettings({ path: settingsPath(env) }),
  });
}

/**
 * Choose the Linear API key based on workspace.
 * @param {string} [workspace]  Explicit workspace ("jointhubs" | "pisi").
 *   When passed, selects the key for THAT workspace regardless of env — this
 *   is what lets /api/linear/queue?workspace=pisi actually query pisi instead
 *   of falling back to the LINEAR_WORKSPACE env default (JOI-68 review round 1:
 *   the env-only path silently returned jointhubs data for ?workspace=pisi).
 *   When omitted/undefined, falls back to LINEAR_WORKSPACE env (jointhubs by
 *   default) — preserves the behavior linear-query.mjs / linear-ops.mjs rely on.
 * @param {object} [opts] - forwarded to workspaceEnabled ({ env, settings })
 *   so callers with a pre-read overlay can skip the file read.
 * @returns {string|undefined}
 * @throws {IntegrationOffError} when the resolved workspace is pisi and the
 *   integration is off (FOC-772) — a misconfiguration the operator must see,
 *   thrown BEFORE the key is looked at, never a silent jointhubs fallback.
 */
export function chooseApiKey(workspace, opts = {}) {
  const ws = workspace || process.env.LINEAR_WORKSPACE;
  if (ws === "pisi") {
    if (!workspaceEnabled("pisi", opts)) throw new IntegrationOffError("pisi");
    return process.env.LINEAR_API_KEY_PISI;
  }
  return process.env.LINEAR_API_KEY;
}

/**
 * The workspaces an issue lookup may query, in order. A taskId's workspace is
 * not derivable from the identifier (unlike an explicit ?workspace= param),
 * so the lookup tries the default workspace first, then pisi.
 *
 * FOC-772: the pisi leg exists only while the integration switch is on. With
 * it off the lookup is default-workspace-only — and the default leg must NOT
 * inherit a LINEAR_WORKSPACE=pisi value: chooseApiKey would refuse it and,
 * caught by the caller, poison the WHOLE lookup (the jointhubs leg never
 * ran). The leg then runs as jointhubs explicitly and `warnPisiEnvIgnored`
 * tells the caller to warn once that LINEAR_WORKSPACE=pisi is ignored.
 *
 * Exported (and unit-tested in linear-client.test.mjs) because the telemetry
 * server's findIssueProject has no test seam of its own.
 *
 * @param {object} [opts] - forwarded to workspaceEnabled ({ env, settings })
 * @returns {{ legs: Array<string|undefined>, warnPisiEnvIgnored: boolean }}
 *   legs entries are graphql()/chooseApiKey workspace args: undefined follows
 *   the LINEAR_WORKSPACE env default.
 */
export function issueLookupLegs({ env = process.env, settings } = {}) {
  if (workspaceEnabled("pisi", { env, settings })) {
    return { legs: [undefined, "pisi"], warnPisiEnvIgnored: false };
  }
  return env.LINEAR_WORKSPACE === "pisi"
    ? { legs: ["jointhubs"], warnPisiEnvIgnored: true }
    : { legs: [undefined], warnPisiEnvIgnored: false };
}

/**
 * Whether a queue request targets the pisi workspace: an explicit `pisi`
 * workspace arg, or the LINEAR_WORKSPACE env default when the arg is absent.
 * Exported for the same reason as issueLookupLegs — fetchLinearQueue's
 * pre-check has no test seam in the telemetry server.
 *
 * @param {string|undefined} workspace - the caller's explicit workspace
 * @param {object} [env] - environment map (default: process.env)
 * @returns {boolean}
 */
export function queueTargetsPisi(workspace, env = process.env) {
  return (workspace || env.LINEAR_WORKSPACE) === "pisi";
}

/**
 * Execute a GraphQL query/mutation against the Linear API.
 * Validates the chosen API key before making any network call.
 * @param {string} query      The GraphQL operation string.
 * @param {object} [vars]     Variables object (default {}).
 * @param {string} [workspace] Optional explicit workspace ("jointhubs"|"pisi")
 *   — selects the API key for that workspace, overriding LINEAR_WORKSPACE env.
 *   Callers that loop over both workspaces (e.g. /api/linear/queue) pass this
 *   so the request authenticates against the right workspace.
 * @returns {object}          The `data` portion of the response.
 * @throws {Error}            If key missing, on network error, auth failure, or GraphQL errors.
 */
export async function graphql(query, vars = {}, workspace) {
  const key = chooseApiKey(workspace);
  if (!key) {
    throw new Error(
      workspace
        ? `LINEAR_API_KEY not set for workspace '${workspace}' (check .env)`
        : "LINEAR_API_KEY not set (check .env)",
    );
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: key,
    },
    body: JSON.stringify({ query, variables: vars }),
  });

  const body = await res.json();

  if (!res.ok) {
    const msg = body?.error || body?.errors?.[0]?.message || `${res.status} ${res.statusText}`;
    throw new Error(`Linear API ${res.status}: ${msg}`);
  }

  if (body.errors?.length) {
    // Join the human-readable messages; fall back to the raw shape only for
    // errors that carry no `message`. bootstrap-linear.mjs had this readable
    // form while linear-push.mjs stringified the raw object — consolidating on
    // the worse one would have made diagnostics harder on the push path
    // (code-review-2026-08-03 §2).
    const msgs = body.errors.map((e) => e?.message).filter(Boolean).join("; ");
    const error = new Error(`GraphQL error: ${msgs || JSON.stringify(body.errors[0])}`);
    // The raw per-error shapes ride the thrown error (FOC-815): a batched
    // caller (work-board's fetchLinearStates) needs `path` to see WHICH alias
    // failed and `message` to tell an issue miss from an outage — Linear
    // answers a batch containing one unknown id by nulling `data` for the
    // whole operation. Additive: the message text is unchanged.
    error.graphqlErrors = body.errors;
    throw error;
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Team resolution (mirrors linear-push.mjs)
// ---------------------------------------------------------------------------

/**
 * Resolve a Linear team by its key (case-insensitive).
 * @param {string} teamKey  Team key, e.g. "FEN" or "fen".
 * @param {string} [workspace]  Optional explicit workspace, forwarded to
 *   graphql(). bootstrap-linear.mjs pins "jointhubs" because it has always
 *   authenticated with LINEAR_API_KEY regardless of LINEAR_WORKSPACE.
 * @returns {Promise<{id:string, name:string, key:string}>}
 * @throws {Error} If team not found.
 */
export async function resolveTeam(teamKey, workspace) {
  const data = await graphql(
    `query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }`,
    {},
    workspace,
  );

  const teams = data.teams?.nodes || [];
  const team = teams.find((t) => t.key.toUpperCase() === teamKey.toUpperCase());
  if (!team) {
    const available = teams.map((t) => `${t.key} (${t.name})`).join(", ");
    throw new Error(
      `Linear team not found: ${teamKey}. Available teams: ${available || "(none — check API key permissions)"}`,
    );
  }
  return team;
}

// ---------------------------------------------------------------------------
// Issue resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Linear issue by its identifier (e.g. "FEN-12").
 *
 * Strategy:
 * 1. Try direct `issue(id:)` lookup by identifier string.
 * 2. If null/throws, fall back to `searchIssues(term:)` and exact-match
 *    on identifier (case-insensitive). Never use search as primary.
 *
 * @param {string} identifier  Issue identifier, e.g. "FEN-12".
 * @returns {Promise<{id:string, identifier:string, title:string, url:string, state:{id:string,name:string,type:string}}>}
 * @throws {Error} If issue not found.
 */
export async function resolveIssue(identifier) {
  // Primary: direct lookup by identifier
  try {
    const data = await graphql(
      `query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          url
          state {
            id
            name
            type
          }
        }
      }`,
      { id: identifier },
    );

    if (data?.issue) {
      return data.issue;
    }
  } catch {
    // Fall through to searchIssues
  }

  // Fallback: searchIssues with exact match
  const data = await graphql(
    `query($term: String!, $first: Int) {
      searchIssues(term: $term, first: $first) {
        nodes {
          id
          identifier
          title
          url
          state {
            id
            name
            type
          }
          team {
            id
            key
            name
          }
        }
      }
    }`,
    { term: identifier, first: 5 },
  );

  const nodes = data?.searchIssues?.nodes || [];
  const match = nodes.find(
    (n) => n.identifier.toUpperCase() === identifier.toUpperCase(),
  );

  if (!match) {
    throw new Error(`Linear issue not found: ${identifier}`);
  }

  return match;
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const cmd = process.argv[2];

  if (cmd === "team") {
    const teamKey = process.argv[3] || process.env.LINEAR_TEAM_KEY;
    if (!teamKey) {
      console.error("Usage: node scripts/linear-client.mjs team [TEAM_KEY]");
      process.exit(2);
    }
    const team = await resolveTeam(teamKey);
    console.log(JSON.stringify(team, null, 2));
  } else if (cmd === "issue") {
    const identifier = process.argv[3];
    if (!identifier) {
      console.error("Usage: node scripts/linear-client.mjs issue <IDENTIFIER>");
      process.exit(2);
    }
    const issue = await resolveIssue(identifier);
    console.log(JSON.stringify(issue, null, 2));
  } else {
    console.error("Usage:");
    console.error("  node scripts/linear-client.mjs team [TEAM_KEY]");
    console.error("  node scripts/linear-client.mjs issue <IDENTIFIER>");
    process.exit(2);
  }
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
