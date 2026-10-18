// scripts/team-model.mjs — the pure model behind GET /api/team (FOC-791 slice A,
// plan docs/plans/foc-791-team-lineups.md §2/§3-A). Who delegates to whom, how
// often, at what cost: You → Supervisor → four leads → each lead's line-up and
// bench, in three scopes (overall / group by filters / one ticket live).
//
// PURE by contract: no fs, no network, no clocks — every input arrives as a
// parameter and `now` is explicit, so the route owns the reads and the tests
// own the fixtures. The numbers come from the per-message priced telemetry
// (`canonical_usage` through loadTeamTurns in team-routes.mjs, FOC-760/761);
// the payload carries `groundTruth` so no consumer has to guess that.
//
// Definitions (plan §2 D1, binding):
//   pick        = one distinct subagent session (`session_id`) of a non-lead
//                 `agent_key` inside a squad run of the scope; a turn with no
//                 session id is its own pick (nothing to merge into).
//   lead row    = agent_key `_lead`; its sessions count as picks in the roles
//                 table but are EXCLUDED from the pick shares (the lead is the
//                 picker, not a pick).
//   pickShare   = picks / squad picks (non-lead sessions).
//   costShare   = costUsd / squad costUsd (the squad total INCLUDING the lead).
//   placement   = "lineup" when pickShare >= 0.05, else "bench".
//   insight     = deterministic: the top pick, then the first role whose
//                 costShare > 2 × pickShare ("rare but expensive"), then the
//                 lead share when it exceeds 0.5.
//   ran=false   = a squad with no run in scope keeps its config roles with
//                 zeros (the architecture is still visible, the numbers are
//                 honestly empty).
//
// Squads on the screen are plan, dev, review, test in that order; the
// Supervisor is the separate `supervisor` block (squad "supervisor" in
// telemetry), never a line-up card.

// Round to 4 decimals without float dust: 0.30000000000000004 → 0.3.
function round4(n) {
  return n == null || !Number.isFinite(n) ? 0 : Math.round(n * 10_000) / 10_000;
}

const DAY_MS = 86_400_000;
export const SQUAD_KEYS = ["plan", "dev", "review", "test"];
export const TICKET_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * The query window for `period` (`7d|30d|90d|all`), ISO strings UTC.
 * `all` has no lower bound: from=null means "do not prefilter".
 */
export function periodWindow(period, now) {
  const days = { "7d": 7, "30d": 30, "90d": 90 }[period] ?? null;
  const to = new Date(now).toISOString();
  return days == null ? { from: null, to, days: null } : { from: new Date(now - days * DAY_MS).toISOString(), to, days };
}

/** D1: `lineup` at 5 % of the squad's picks, bench below. */
export function lineupPlacement(pickShare) {
  return pickShare >= 0.05 ? "lineup" : "bench";
}

/** "50 %" style percentages — the same shape the spec's example insight uses. */
const pct = (share) => `${Math.round(share * 100)} %`;

/**
 * The deterministic insight line (plan D1), from a built squad object:
 *   1. the top pick — "<role> is N % of picks";
 *   2. the first role (pick order) whose costShare > 2 × pickShare —
 *      "<role> is N % of picks but M % of cost";
 *   3. the lead share when it exceeds 0.5 — "lead is N % of cost".
 * Parts that do not fire are omitted; an empty squad line is "".
 */
export function insightLine(squad) {
  if (!squad || !squad.ran) return "";
  const parts = [];
  const roles = (squad.roles || []).filter((r) => r.role !== "lead" && r.picks > 0);
  if (roles.length) parts.push(`${roles[0].role} is ${pct(roles[0].pickShare)} of picks`);
  const expensive = roles.find((r) => r.costShare > 2 * r.pickShare && r.costShare > 0);
  if (expensive) parts.push(`${expensive.role} is ${pct(expensive.pickShare)} of picks but ${pct(expensive.costShare)} of cost`);
  const lead = (squad.roles || []).find((r) => r.role === "lead");
  if (lead && lead.costShare > 0.5) parts.push(`lead is ${pct(lead.costShare)} of cost`);
  return parts.join("; ");
}

// ── aggregation core ─────────────────────────────────────────────────────────

/** Stable identity for a pick when the turn carries no session_id. */
function sessionKeyOf(turn, i) {
  return turn.sessionId ?? `${turn.runId}|${turn.observedAt}|${turn.agentKey}|${turn.model}|${i}`;
}

const emptyBucket = () => ({
  cost: 0,
  sessions: new Set(),
  runIds: new Set(),
  taskIds: new Set(),
  lead: { cost: 0, sessions: new Set(), models: new Map() },
  roles: new Map(), // `${agentKey}|${model}` → { role, model, picks:Set, cost }
});

function addTurn(bucket, turn, sessionKey) {
  const model = turn.model;
  bucket.cost += turn.costUsd || 0;
  if (turn.sessionId) bucket.sessions.add(turn.sessionId);
  if (turn.runId) bucket.runIds.add(turn.runId);
  if (turn.taskId) bucket.taskIds.add(turn.taskId);
  if (turn.agentKey === "_lead") {
    bucket.lead.cost += turn.costUsd || 0;
    bucket.lead.sessions.add(sessionKey);
    bucket.lead.models.set(model, (bucket.lead.models.get(model) || 0) + (turn.costUsd || 0));
    return;
  }
  const key = `${turn.agentKey}|${model}`;
  const role = bucket.roles.get(key) || { role: turn.agentKey, model, picks: new Set(), cost: 0 };
  role.picks.add(sessionKey);
  role.cost += turn.costUsd || 0;
  bucket.roles.set(key, role);
}

/** Roles table for one squad bucket. `overallShares` maps role|model → pickShare in the overall scope. */
function buildRoles(bucket, { squadConfigSquad, overallShares, includeOverall }) {
  const leadPicks = bucket.lead.sessions.size;
  const squadCost = bucket.cost;
  const pickDenominator = [...bucket.roles.values()].reduce((n, r) => n + r.picks.size, 0);

  const rows = [];
  if (leadPicks > 0 || bucket.lead.cost > 0) {
    const leadModel = [...bucket.lead.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? squadConfigSquad?.lead ?? null;
    rows.push({
      role: "lead",
      model: leadModel,
      picks: leadPicks,
      pickShare: null, // excluded from the pick shares (D1)
      costUsd: round4(bucket.lead.cost),
      costShare: squadCost > 0 ? round4(bucket.lead.cost / squadCost) : 0,
      placement: "lead",
    });
  }
  const observed = [...bucket.roles.values()]
    .map((r) => {
      const pickShare = pickDenominator > 0 ? r.picks.size / pickDenominator : 0;
      const row = {
        role: r.role,
        model: r.model,
        picks: r.picks.size,
        pickShare: round4(pickShare),
        costUsd: round4(r.cost),
        costShare: squadCost > 0 ? round4(r.cost / squadCost) : 0,
        placement: lineupPlacement(pickShare),
      };
      if (includeOverall) row.overallPickShare = overallShares.get(`${r.role}|${r.model}`) ?? 0;
      return row;
    })
    .sort((a, b) => b.picks - a.picks || String(a.role).localeCompare(String(b.role)));

  // ran=false: the config roles keep the architecture visible with zeros (D1).
  if (!observed.length && !rows.length && squadConfigSquad) {
    return Object.entries(squadConfigSquad.agents || {}).map(([role, cfg]) => {
      const row = {
        role,
        model: cfg.model ?? null,
        picks: 0,
        pickShare: 0,
        costUsd: 0,
        costShare: 0,
        placement: lineupPlacement(0),
      };
      if (includeOverall) row.overallPickShare = overallShares.get(`${role}|${cfg.model ?? ""}`) ?? 0;
      return row;
    });
  }
  return [...rows, ...observed];
}

/** Aggregate one scope's turns into the totals/supervisor/squad buckets. */
function aggregate(scopeTurns, { squadConfig }) {
  const totals = { costUsd: 0, sessions: new Set(), taskIds: new Set(), runIds: new Set() };
  const supervisor = { cost: 0, models: new Map() };
  const buckets = new Map(SQUAD_KEYS.map((k) => [k, emptyBucket()]));

  scopeTurns.forEach((turn, i) => {
    const sessionKey = sessionKeyOf(turn, i);
    totals.costUsd += turn.costUsd || 0;
    if (turn.sessionId) totals.sessions.add(turn.sessionId);
    if (turn.taskId) totals.taskIds.add(turn.taskId);
    if (turn.runId) totals.runIds.add(turn.runId);

    if (turn.squad === "supervisor") {
      supervisor.cost += turn.costUsd || 0;
      supervisor.models.set(turn.model, (supervisor.models.get(turn.model) || 0) + (turn.costUsd || 0));
      return;
    }
    const bucket = buckets.get(turn.squad);
    if (!bucket) return; // squads off the line-up screen (cadence, ad hoc) are not fabricated
    addTurn(bucket, turn, sessionKey);
  });

  const squadMap = {};
  for (const key of SQUAD_KEYS) {
    const bucket = buckets.get(key);
    const cfg = squadConfig?.squads?.[key];
    const observedLeadModel = [...bucket.lead.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    squadMap[key] = {
      ran: bucket.cost > 0 || bucket.sessions.size > 0,
      costUsd: round4(bucket.cost),
      picks: [...bucket.roles.values()].reduce((n, r) => n + r.picks.size, 0),
      sessions: bucket.sessions.size,
      leadModel: observedLeadModel ?? cfg?.lead ?? null,
      leadCost: bucket.lead.cost,
      bucket,
      cfg,
    };
  }
  return { totals, supervisor, squadMap };
}

const matches = (factValue, filter) => typeof factValue === "string" && factValue.toLowerCase() === String(filter).toLowerCase();

// Local copies of the delegation-outcomes normalisation rules (kept tiny and
// local so this file stays PURE — importing delegation-outcomes would drag in
// the sqlite handle and the state-root seams). The route's loader hands the
// raw store rows in; these are applied once, at the enrichment step.
const normaliseModel = (model) => String(model || "?").replace(/-\d{8}$/, "");
const isNoiseModel = (m) => !m || m === "<synthetic>" || m === "synthetic";
const isNoiseAgent = (a) => !a || /^agent-[0-9a-f]{8,}/i.test(a);

/**
 * Build the /api/team payload (plan §2 verbatim). Parameters:
 *   turns            — priced per-message turns (loadTeamTurns): { runId, sessionId?, agentKey, squad, model, observedAt, costUsd }
 *   links            — run→task links (loadPrimaryTaskLinks)
 *   squadConfig      — readSquadConfig() output ({ squads: { plan: { lead, agents } }, ... })
 *   period           — "7d" | "30d" | "90d" | "all"
 *   scope            — "overall" | "group" | "ticket"
 *   filters          — raw query filters { repo?, milestone?, type?, epic?, size? }
 *   ticket           — display id for scope=ticket (validated upstream)
 *   registryChildren — collectChildren rows ({ runId, childId, taskId, status, ... }), ticket scope only
 *   ticketFacts      — per-task facts derivable offline: { taskId, repo? , milestone?, type?, epic?, estimate? }
 *   now              — ms; the caller's clock (the payload must be reproducible in tests)
 */
export function buildTeam({ turns, links, squadConfig, period, scope, filters, ticket, registryChildren, ticketFacts, now, repoFilterAvailable = true }) {
  const linksByRun = index(links);
  const factsByTask = new Map((ticketFacts || []).map((f) => [f.taskId, f]));
  const enriched = turns
    // Telemetry noise is not a line-up: ephemeral agent-<hash> handles and
    // <synthetic> models are dropped, dated model ids collapse (one model
    // under two ids must not split a small sample).
    .filter((t) => !isNoiseAgent(t.agentKey) && !isNoiseModel(t.model))
    .map((t) => ({ ...t, model: normaliseModel(t.model), taskId: taskIdForTurn(linksByRun, t.runId, t.observedAt) }));
  const win = periodWindow(period, now);
  const inWindow = (t) => t.observedAt != null && (win.from == null || t.observedAt >= win.from) && (win.to == null || t.observedAt < win.to);

  // The overall scope is ALWAYS computed (period-bound, no filters) — group and
  // ticket scopes quote its pick shares as `overallPickShare` (plan D1).
  const overall = aggregate(enriched.filter(inWindow), { squadConfig });
  const overallShares = new Map();
  for (const key of SQUAD_KEYS) {
    const den = overall.squadMap[key].picks;
    for (const r of overall.squadMap[key].bucket.roles.values()) {
      overallShares.set(`${r.role}|${r.model}`, den > 0 ? round4(r.picks.size / den) : 0);
    }
  }

  // ── which filters can be honoured, and which are honestly unsupported ──
  const factsCarry = (field) => (ticketFacts || []).some((f) => f[field] != null);
  // `repo` is listed as supported only when the caller actually derived prefix
  // mappings (repoFilterAvailable); otherwise it belongs with the honestly
  // unsupported — never silently listed as working when it cannot.
  const supported = repoFilterAvailable ? ["repo"] : [];
  const unsupported = repoFilterAvailable ? [] : ["repo"];
  if (factsCarry("milestone")) supported.push("milestone");
  if (factsCarry("type")) supported.push("type");
  for (const f of ["milestone", "type"]) if (!supported.includes(f)) unsupported.push(f);
  // epic/size are unsupported unless the facts actually carry them — listed
  // whether or not the caller passed them, so the UI can say up front what
  // this screen cannot honour (never silently ignored, plan §2).
  for (const [f, factField] of [["epic", "epic"], ["size", "estimate"]]) {
    if (!factsCarry(factField)) unsupported.push(f);
  }

  let scopeTurns;
  let childRows = [];
  let ticketPayload;
  let appliedFilters = {};
  if (scope === "ticket") {
    // The ticket's live children: registry rows for that ticket, newest run
    // first (the per-squad split happens at the squad cards below).
    childRows = (registryChildren || [])
      .filter((c) => c.taskId === ticket)
      .sort((a, b) => String(b.runId).localeCompare(String(a.runId)))
      .map(({ childId, status, runId, squad }) => ({ childId, status, runId, squad }));
    const childRuns = new Set(childRows.map((c) => c.runId));
    // Turns of the runs linked to the ticket — via the task links or via the
    // registry children/triage of that ticket. The period is IGNORED here: the
    // question is "who worked on THIS ticket", not "who worked lately".
    scopeTurns = enriched.filter((t) => t.taskId === ticket || childRuns.has(t.runId));
    ticketPayload = { id: ticket, runs: [...new Set(scopeTurns.map((t) => t.runId))].sort((a, b) => String(b).localeCompare(String(a))) };
  } else if (scope === "group") {
    const applied = {};
    scopeTurns = enriched.filter((t) => {
      if (!inWindow(t)) return false;
      if (!Object.keys(filters || {}).length) return true;
      const fact = t.taskId ? factsByTask.get(t.taskId) : null;
      for (const f of ["repo", "milestone", "type"]) {
        if (filters[f] == null) continue;
        if (!fact || !matches(fact[f], filters[f])) return false;
        applied[f] = filters[f];
      }
      return true;
    });
    appliedFilters = applied;
  } else {
    scopeTurns = enriched.filter(inWindow);
  }

  const agg = scope === "overall" ? overall : aggregate(scopeTurns, { squadConfig });
  const includeOverall = scope !== "overall";

  const squads = SQUAD_KEYS.map((key) => {
    const m = agg.squadMap[key];
    const squad = {
      key,
      ran: m.ran,
      lead: { model: m.leadModel, costUsd: round4(m.leadCost), costShare: m.costUsd > 0 ? round4(m.leadCost / m.costUsd) : 0 },
      costUsd: m.costUsd,
      picks: m.picks,
      sessions: m.sessions,
      roles: buildRoles(m.bucket, { squadConfigSquad: m.cfg, overallShares, includeOverall }),
    };
    squad.insight = insightLine(squad);
    // Children are per-squad: the registry rows for this ticket AND this squad,
    // squashed to the contract's three keys.
    if (scope === "ticket") {
      squad.children = childRows
        .filter((c) => c.squad === key)
        .map(({ childId, status, runId }) => ({ childId, status, runId }));
    }
    squad.links = { prompts: `/prompts?squad=${key}`, tools: "/settings/agent-tools", models: `/squad-config?squad=${key}` };
    return squad;
  });

  const supervisorModel = squadConfig?.squads?.supervisor?.lead
    ?? [...agg.supervisor.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const payload = {
    scope,
    period: win,
    filters: {
      applied: scope === "group" ? appliedFilters : {},
      supported,
      unsupported,
    },
    groundTruth: "per-message priced usage (FOC-760/761)",
    generatedAt: new Date(now).toISOString(),
    totals: {
      costUsd: round4(agg.totals.costUsd),
      sessions: agg.totals.sessions.size,
      tasks: agg.totals.taskIds.size,
      runs: agg.totals.runIds.size,
    },
    supervisor: { model: supervisorModel, costUsd: round4(agg.supervisor.cost) },
    squads,
  };
  if (scope === "ticket") payload.ticket = ticketPayload;
  return payload;
}

// Local copies of the delegation-outcomes helpers: the module keeps its own
// neighbours private-by-default and this file must stay PURE (no import of a
// module whose import graph touches fs). index/taskIdForTurn are 10 lines, and
// duplicating them here keeps the purity contract airtight. The ROUTE uses the
// canonical (now exported) originals — one source of truth for the loader.
function index(links) {
  const byRun = new Map();
  for (const l of links || []) {
    if (!byRun.has(l.runId)) byRun.set(l.runId, []);
    byRun.get(l.runId).push(l);
  }
  return byRun;
}

function taskIdForTurn(linksByRun, runId, observedAt) {
  for (const l of linksByRun.get(runId) || []) {
    if (observedAt >= l.validFrom && (l.validTo == null || observedAt < l.validTo)) return l.taskId;
  }
  return null;
}
