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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers (mirrors linear-push.mjs / bootstrap-linear.mjs convention)
// ---------------------------------------------------------------------------

/** Manual .env parser — zero deps, mirrors cost-report.mjs convention. */
export function loadEnv() {
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

/**
 * Choose the Linear API key based on workspace.
 * When LINEAR_WORKSPACE === "pisi", uses LINEAR_API_KEY_PISI (full-write per Mateusz 2026-07).
 * Otherwise uses LINEAR_API_KEY (jointhubs, default).
 * @returns {string|undefined}
 */
export function chooseApiKey() {
  if (process.env.LINEAR_WORKSPACE === "pisi") {
    return process.env.LINEAR_API_KEY_PISI;
  }
  return process.env.LINEAR_API_KEY;
}

/**
 * Execute a GraphQL query/mutation against the Linear API.
 * Validates the chosen API key before making any network call.
 * @param {string} query  The GraphQL operation string.
 * @param {object} vars   Variables object (default {}).
 * @returns {object}      The `data` portion of the response.
 * @throws {Error}        If key missing, on network error, auth failure, or GraphQL errors.
 */
export async function graphql(query, vars = {}) {
  const key = chooseApiKey();
  if (!key) {
    throw new Error("LINEAR_API_KEY not set (check .env)");
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
    throw new Error("GraphQL error: " + JSON.stringify(body.errors[0]));
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Team resolution (mirrors linear-push.mjs)
// ---------------------------------------------------------------------------

/**
 * Resolve a Linear team by its key (case-insensitive).
 * @param {string} teamKey  Team key, e.g. "FEN" or "fen".
 * @returns {Promise<{id:string, name:string, key:string}>}
 * @throws {Error} If team not found.
 */
export async function resolveTeam(teamKey) {
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
