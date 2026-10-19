// scripts/team-routes.mjs — GET /api/team (FOC-791 slice A): the transport
// adapter in front of the pure model in team-model.mjs, in the
// runtime-statistics-routes.mjs style.
//
// TRANSPORT ONLY: guard order, query validation, the reads (telemetry DB
// read-only, squad config, config/projects.json repo map, registry children for
// the ticket scope) and the payload passthrough — every number is derived in
// team-model.mjs, never here.
//
// Errors:
//   400 { error: "bad-request", reason }     — a bad scope/period/ticket/filter value
//   503 { error: "store-unreadable" }        — the telemetry store cannot be opened read-only
//
// Group filters: `repo` is derivable offline — the task-key prefix (the team
// prefix of the display id) mapped through config/projects.json, the same file
// the deploy map documents per Linear project (the team prefixes are named in
// each project's note, e.g. "team FOC (e.g. FOC-104)"). FOC-914: the other
// four (milestone, type = label name, epic = parent identifier, size =
// estimate) come from the Work board's Linear states lookup — the same
// `linearStatesFor` seam (fixture under the test env, fetchLinearStates's
// 60 s cache in production), reached through the server's linearQueue
// discipline. When the lookup fails (no Linear key, offline) the facts carry
// none of the four and team-model lists them under filters.unsupported WITH
// the reason — never a guess, never a silent ignore (plan §2).
//
// TEST-ONLY seam, the runtime-statistics convention: ctx may inject
// loadTurns / loadLinks / squadConfig / registryChildren / ticketFacts /
// linearStatesFor to replace the store/config/Linear reads in unit tests.
// Without them the defaults read the real seams (LA_TELEMETRY_DB /
// LA_SUPERVISOR_STATE_HOME / repo root / the fake-file-or-Linear lookup).

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { telemetryDbPath, projectsConfigPath } from "./fenix-paths.mjs";
import { readSquadConfig as defaultSquadConfig } from "./squad-config.mjs";
import { loadPrimaryTaskLinks } from "./delegation-outcomes.mjs";
import { collectChildren, recentRunIds } from "./cockpit.mjs";
import { repoRefName } from "./fenix-projects.mjs";
import { buildTeam, periodWindow, TICKET_ID_RE } from "./team-model.mjs";
import { linearStatesFor as defaultLinearStatesFor } from "./work-routes.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

const SCOPES = new Set(["overall", "group", "ticket"]);
const PERIODS = new Set(["7d", "30d", "90d", "all"]);
// Bounded filter values: letters/digits/space and the punctuation repo and
// milestone names actually contain. Anything else is a 400, never a guess.
const FILTER_VALUE_RE = /^[\w .\/-]{1,120}$/;

/**
 * Team prefixes → repo name, from config/projects.json. A project's
 * `ticketPrefix` field is the structured source; rows without one fall back to
 * the per-project note ("team FOC (e.g. FOC-104)": the only unstructured
 * mention of the prefix). A row with neither contributes no prefix.
 * Returns { "FOC": "linear-agents", ... }.
 */
export function repoPrefixMap(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const map = {};
  for (const row of Array.isArray(data.projects) ? data.projects : []) {
    const repo = repoRefName(row?.repo);
    if (!repo) continue;
    if (typeof row?.ticketPrefix === "string" && /^[A-Z][A-Z0-9]+$/.test(row.ticketPrefix)) {
      map[row.ticketPrefix] = repo;
      continue;
    }
    const notes = `${row?.note ?? ""}`;
    for (const m of notes.matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g)) map[m[1]] = repo;
  }
  return map;
}

/** Ticket facts for every linked task, as far as they are derivable offline. */
function ticketFactsFor(taskIds, prefixMap) {
  const facts = [];
  for (const taskId of taskIds) {
    const prefix = String(taskId).split("-")[0];
    facts.push({ taskId, repo: prefixMap[prefix] ?? null });
  }
  return facts;
}

/** Per-message priced turns from the canonical view (FOC-760/761 dedup, rn = 1). */
export function loadTeamTurns(db) {
  return db.prepare(`
    SELECT run_id AS runId, session_id AS sessionId, agent_key AS agentKey, model AS model,
           observed_at AS observedAt, squad AS squad, COALESCE(cost_usd, 0) AS costUsd
    FROM canonical_usage
    WHERE agent_key IS NOT NULL
  `).all();
}

async function defaultLoaders() {
  let db;
  try {
    db = new DatabaseSync(telemetryDbPath(), { readOnly: true });
  } catch {
    return null; // caller turns this into the 503
  }
  try {
    const turns = loadTeamTurns(db);
    const links = loadPrimaryTaskLinks(db);
    return { turns, links };
  } finally {
    db.close(); // never accumulate open DB handles across requests
  }
}

/**
 * Handle GET /api/team. Returns true when the request was handled (the caller
 * returns immediately), false when it is not ours.
 */
export async function handleTeamRoute(req, res, url, ctx) {
  if (req.method !== "GET" || url.pathname !== "/api/team") return false;
  const { json, log } = ctx;

  // ── validate the query before touching any store ───────────────────────────
  const scope = url.searchParams.get("scope") ?? "overall";
  const period = url.searchParams.get("period") ?? "30d";
  const ticket = url.searchParams.get("ticket");
  const bad = (reason) => {
    json(res, 400, { error: "bad-request", reason });
    return true;
  };

  if (!SCOPES.has(scope)) return bad(`unknown scope '${scope}' — expected overall|group|ticket`);
  if (!PERIODS.has(period)) return bad(`unknown period '${period}' — expected 7d|30d|90d|all`);
  if (scope === "ticket") {
    if (!ticket) return bad("scope=ticket requires a ticket=<display id> parameter");
    if (!TICKET_ID_RE.test(ticket)) return bad(`malformed ticket id '${ticket}'`);
  }
  const filters = {};
  for (const name of ["repo", "milestone", "type", "epic", "size"]) {
    const value = url.searchParams.get(name);
    if (value == null) continue;
    if (!FILTER_VALUE_RE.test(value)) return bad(`malformed ${name} filter`);
    filters[name] = value;
  }

  // Honest filter contract: `repo` is only supported when config/projects.json
  // actually mapped at least one ticket prefix to a repo (the default loader
  // derives this; ctx-injected facts carry the caller's answer, set below).
  let repoFilterAvailable = false;

  // ── the reads ───────────────────────────────────────────────────────────────
  const loaded = ctx.loadTurns ? { turns: ctx.loadTurns(), links: ctx.loadLinks?.() ?? [] } : await defaultLoaders();
  if (!loaded) {
    json(res, 503, { error: "store-unreadable" });
    return true;
  }
  const squadConfig = ctx.squadConfig ? ctx.squadConfig : defaultSquadConfig();

  let registryChildren = ctx.registryChildren ?? [];
  if (scope === "ticket" && !ctx.registryChildren) {
    try {
      registryChildren = await collectChildren({ runIds: recentRunIds({}) });
    } catch {
      registryChildren = []; // the board degrades to link-derived runs, never invents children
    }
  }

  let ticketFacts = ctx.ticketFacts;
  if (!ticketFacts) {
    const taskIds = new Set(loaded.links.map((l) => l.taskId));
    const prefixMap = repoPrefixMap(projectsConfigPath());
    ticketFacts = ticketFactsFor(taskIds, prefixMap);
    repoFilterAvailable = Object.keys(prefixMap).length > 0;
  } else {
    repoFilterAvailable = ticketFacts.some((f) => f.repo != null);
  }

  // FOC-914: enrich the facts with the Linear-backed fields. Only the group
  // scope reads Linear — the overall scope never filters and the ticket scope
  // pins one id. The group scope asks the lookup EVEN with no filter values:
  // filters.supported must reflect what the installation can really answer
  // (the ticket says: "Linear key present, cache warm" — the payload reports
  // it before the user fills an input). A lookup that failed leaves the facts
  // untouched: team-model lists the four under unsupported with the reason
  // ("Linear unavailable"), and a passed value is never applied on a guess.
  let linearError = null;
  let linearAvailable = false;
  if (scope === "group") {
    const lookup = ctx.linearStatesFor
      ? await ctx.linearStatesFor(ticketFacts.map((f) => f.taskId))
      : await defaultLinearStatesFor(ticketFacts.map((f) => f.taskId));
    linearError = lookup?.meta?.error ?? null;
    linearAvailable = Boolean(lookup?.meta?.ok) && lookup.meta.error == null;
    if (linearAvailable) {
      const states = lookup.states ?? {};
      ticketFacts = ticketFacts.map((f) => {
        const s = states[f.taskId];
        return s
          ? {
              ...f,
              milestone: s.milestone ?? null,
              // Labels arrive as name strings (the fixture seam) or
              // { id, name, color } rows (the real lookup) — both normalize
              // to the name list the model's type filter matches against.
              type: Array.isArray(s.labels) && s.labels.length
                ? s.labels.map((l) => (typeof l === "string" ? l : l?.name)).filter((n) => typeof n === "string" && n)
                : null,
              epic: s.parent ?? null,
              estimate: s.estimate ?? null,
            }
          : f; // a miss (the id is not in this workspace) carries no facts — the unknown-value rule applies in the model
      });
    }
  }

  const payload = buildTeam({
    turns: loaded.turns,
    links: loaded.links,
    squadConfig,
    period,
    scope,
    filters,
    ticket,
    registryChildren,
    ticketFacts,
    now: Date.now(),
    repoFilterAvailable,
    // FOC-914: what the Linear lookup could answer rides to the model —
    // supported/unsupported must reflect the real capability, and the
    // failure reason travels into the payload for the UI.
    linearAvailable,
    linearError,
  });

  // Live telemetry: a cached payload would lie about who is on the ticket right
  // now. setHeader survives json()'s writeHead (its headers object carries no
  // Cache-Control), and the guard keeps stub res objects unit tests may pass.
  if (typeof res.setHeader === "function") res.setHeader("Cache-Control", "no-store");
  json(res, 200, payload);
  log("GET", "/api/team", 200);
  return true;
}

// Re-exported for the tests and the dashboard spec: one place names the
// window maths. (Re-export, not duplication — team-model stays the owner.)
export { periodWindow };
