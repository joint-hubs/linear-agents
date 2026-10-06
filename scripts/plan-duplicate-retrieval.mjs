// scripts/plan-duplicate-retrieval.mjs — duplicate-candidate retrieval for
// the PLAN squad's plan.duplicate_of gate (FOC-519).
//
// Searches Linear for the issues most likely to duplicate a given issue: the
// issue's own title as the search term, scoped to the issue's team, Done and
// Canceled states excluded, the issue itself excluded, top-5 returned in a
// deterministic order. The caller hands the result to buildPlanGates
// (plan-gates.mjs) as the plan.duplicate_of candidates — after mapping the
// records to the seam's {key, title} shape, which stays the consumer's job.
// FOC-519 wires nothing: no gate, squad or flow calls this yet.
//
// Fail-closed discipline (the plan-gates posture): a retrieval failure is
// never a guessed or partially fabricated list.
//   · caller bugs — a missing identity, team or title, or a non-function
//     transport — throw before any call, the buildPlanGates precedent
//     (malformed input is a caller bug, not a decision to swallow);
//   · everything else — a transport throw, an auth error, an unexpected or
//     PARTIALLY broken payload — resolves to []. An empty list makes
//     buildPlanGates skip plan.duplicate_of with its existing no_candidates
//     record, which is exactly the visible, honest outcome.
// Payload strictness: ONE schema-invalid node empties the WHOLE result. A
// search payload carrying garbage is contract drift (the endpoint returns
// well-formed nodes for this selection), and silently dropping the broken
// ones could hide a half-real candidate list from the duplicate gate.
// Business filtering (Done/Canceled, other teams, self) is not failure —
// schema-valid nodes that fail those filters are dropped one by one.
//
// Done and Canceled are excluded by Linear's state TYPE, not its name: Done
// states carry type "completed", and name-based matching would miss renamed
// or localized done states.
//
// Order: ascending numeric identifier part (FEN-3 before FEN-10 — plain
// lexicographic order would invert that pair), identifier ascending as the
// tie-break. The same candidate set always yields the same output order,
// regardless of the order the endpoint returned it in.
//
// Window: the search endpoint takes no team or state filter, so both are
// post-filters here; the fetch window is 5× the cap so the post-filters
// cannot starve the top-5.
//
// All suites that exercise this module are offline: the transport is either
// an injected fetchPage stub or the real client with the key seam scrubbed
// and fetch severed — no network, no key, ever.

import { loadEnv, graphql } from "./linear-client.mjs";

const CANDIDATE_CAP = 5;
const SEARCH_WINDOW = CANDIDATE_CAP * 5;
const EXCLUDED_STATE_TYPES = new Set(["completed", "canceled"]);
// Linear identifiers are TEAM-NUMBER; the number is the sort key.
const IDENTIFIER_RE = /^[A-Za-z]+-\d+$/;

// Shaped like linear-query.mjs's search verb, with a minimal selection: only
// the fields the candidate contract reads or filters on.
const SEARCH_QUERY = `
  query($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        id
        identifier
        title
        state { id name type }
        team { key }
      }
    }
  }
`;

// The default transport, through the same shared Linear client every other
// sanctioned reader uses. Never reached by the test suite — the tests either
// inject fetchPage or scrub the key seam so this throws before any fetch.
async function defaultFetchPage(term, first) {
  loadEnv();
  return graphql(SEARCH_QUERY, { term, first });
}

// A node is trusted only when it carries every field the contract returns or
// filters on, well-formed. Anything less is an unexpected payload.
function isWellFormedNode(n) {
  return !!n && typeof n === "object" && !Array.isArray(n)
    && typeof n.id === "string" && n.id.trim()
    && typeof n.identifier === "string" && IDENTIFIER_RE.test(n.identifier)
    && typeof n.title === "string" && n.title.trim()
    && !!n.state && typeof n.state === "object" && !Array.isArray(n.state)
    && typeof n.state.id === "string" && n.state.id.trim()
    && typeof n.state.name === "string" && n.state.name.trim()
    && typeof n.state.type === "string" && n.state.type.trim()
    && !!n.team && typeof n.team === "object" && !Array.isArray(n.team)
    && typeof n.team.key === "string" && n.team.key.trim();
}

function numericPartOf(identifier) {
  return Number(identifier.slice(identifier.indexOf("-") + 1));
}

// Deterministic order: numeric identifier part ascending, identifier
// ascending as the tie-break.
function compareCandidates(a, b) {
  const numDiff = numericPartOf(a.identifier) - numericPartOf(b.identifier);
  if (numDiff !== 0) return numDiff;
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

/**
 * Retrieve the duplicate candidates Linear holds for one issue: the issue's
 * title as the search term, scoped to the issue's team, Done/Canceled states
 * and the issue itself excluded, at most 5 returned in a deterministic order
 * (numeric identifier part ascending, identifier ascending as tie-break).
 *
 * Resolves to records of exactly {id, identifier, title, state:{id, name,
 * type}} — no extra fields, no missing fields — ready to be mapped to
 * buildPlanGates' {key, title} candidate shape by the (future) consumer.
 *
 * Fails closed: a transport throw, an auth error, or an unexpected or
 * partially broken payload resolves to [] — which makes buildPlanGates skip
 * plan.duplicate_of with its existing no_candidates record. Caller bugs (a
 * missing identity, team or title, or a non-function transport) throw before
 * any call, never swallowed into an empty list.
 *
 * @param {object}  args
 * @param {string}  args.issue     the issue's own identifier (e.g. "FEN-519") — excluded from its own candidates
 * @param {string}  args.teamKey   the issue's team key (e.g. "FEN") — the scope
 * @param {string}  args.title     the issue's title — the search term
 * @param {(term: string, first: number) => Promise<object>} [args.fetchPage]
 *     the transport seam, resolving to the GraphQL `data` for the search;
 *     the default queries Linear through scripts/linear-client.mjs
 * @returns {Promise<Array<{id: string, identifier: string, title: string, state: {id: string, name: string, type: string}}>>}
 */
export async function findDuplicateCandidates({ issue, teamKey, title, fetchPage = defaultFetchPage } = {}) {
  for (const [name, value] of [["issue", issue], ["teamKey", teamKey], ["title", title]]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`findDuplicateCandidates needs a non-empty ${name}`);
    }
  }
  if (typeof fetchPage !== "function") {
    throw new Error("findDuplicateCandidates needs the fetchPage transport (or the default)");
  }

  try {
    const data = await fetchPage(title.trim(), SEARCH_WINDOW);
    const nodes = data?.searchIssues?.nodes;
    if (!Array.isArray(nodes) || !nodes.every(isWellFormedNode)) return [];

    return nodes
      .filter((n) => !EXCLUDED_STATE_TYPES.has(n.state.type))
      .filter((n) => n.team.key.toUpperCase() === teamKey.trim().toUpperCase())
      .filter((n) => n.identifier.toUpperCase() !== issue.trim().toUpperCase())
      .sort(compareCandidates)
      .slice(0, CANDIDATE_CAP)
      .map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        state: { id: n.state.id, name: n.state.name, type: n.state.type },
      }));
  } catch {
    return [];
  }
}