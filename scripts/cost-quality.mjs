// Costs & quality derivations for the dashboard v2 /costs screen (FOC-785).
// Pure library over plain objects — no fs, no store, no network. Inputs:
//  - snapshot: the CostSnapshot JSON from scripts/cost-snapshot.mjs
//    ({ computedAt, windows: { all, "30d", "7d" }, runs }), or null while the
//    first snapshot has not landed yet (→ "computing" state, null numbers).
//  - facts: TicketFacts[] from scripts/work-board.mjs collectTicketFacts.
//  - linearStates: { <taskId>: { name, type } } from the batched Linear lookup.
// Payload shapes are the contract in docs/plans/dashboard-v2-work-costs.md.

// ── percentile ───────────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile: the values sorted ascending, then the
 * `Math.ceil(p / 100 * n) - 1` index (clamped into the array) — the same rule
 * as decision-analytics.mjs's `percentile`. Empty input → null.
 */
export function percentileNearestRank(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

// ── definitions ──────────────────────────────────────────────────────────────

/** One plain-English sentence per metric key, rendered under every number. */
export const DEFINITIONS = {
  childrenPerTicket:
    "Children's cost per ticket that had any child cost in the period: p50, with the p20–p80 band (nearest rank).",
  allInAvgPerTicket:
    "Mean all-in cost per ticket (children's cost plus the Supervisor cost attributed to the ticket), over tickets with any cost in the period.",
  totalUsd:
    "Total spend in the period: children's cost on tickets plus untagged children plus all Supervisor cost.",
  supervisorShare:
    "Supervisor cost (including overhead and unattributed) divided by the total spend in the period.",
  attribution:
    "Share of Supervisor cost attributed to a ticket or to declared overhead; the banner shows while the share is below 0.8.",
  firstTimeRight:
    "Share of tickets whose round-1 review verdict is PASS, among tickets with a round-1 verdict.",
  reworkShare:
    "Children's cost of turns ≥ 2 divided by children's cost, over children with a known turn-2 start and priced telemetry.",
  interventionsPerTicket:
    "Gate, hold and question answers recorded for the ticket, per ticket with any child.",
  landingYield:
    "Tickets whose Linear issue is Done, divided by tickets with at least one dev child.",
  mostExpensive:
    "First matching rule: 3 or more review rounds, rework share ≥ 50 %, 3 or more interventions, Supervisor share ≥ 50 %, otherwise unexplained.",
  unknown:
    "unknown = no priced telemetry for the messages, so the cost cannot be computed (never shown as 0). unattributed = Supervisor cost with no declared focus, so no ticket owns it.",
};

// ── shared helpers ───────────────────────────────────────────────────────────

const ATTRIBUTION_TARGET = 0.8;
const EVIDENCE_CAP = 20;
const DEV_SQUAD = "dev";
const PERIOD_MS = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };
const SIGNAL_UNITS = {
  firstTimeRight: "share",
  reworkShare: "share",
  interventionsPerTicket: "count",
  landingYield: "share",
};

/** Epoch ms from a number or ISO string; null when unparseable. */
const msOf = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

const pctText = (share) => `${Math.round(share * 100)} %`;

function requirePeriodMs(period) {
  const ms = PERIOD_MS[period];
  if (ms === undefined) throw new Error(`unknown period: ${period} (expected "7d", "30d" or "all")`);
  return ms;
}

/** "computing"/"error" pass through from the snapshot; a real snapshot is "ok". */
function payloadState(snapshot) {
  if (snapshot == null) return "computing";
  if (snapshot.state === "computing" || snapshot.state === "error") return snapshot.state;
  return "ok";
}

const staleOf = (snapshot, now, staleAfterMs) => {
  const computedMs = msOf(snapshot?.computedAt);
  return computedMs == null ? true : now - computedMs > staleAfterMs;
};

/** The round-1 verdict of a TicketFacts entry, or null when there is none. */
const round1VerdictOf = (fact) =>
  (Array.isArray(fact.verdicts) ? fact.verdicts : []).find((v) => v.round === 1)?.verdict ?? null;

/**
 * "Why" for a most-expensive ticket: the FIRST matching rule — rounds ≥ 3,
 * rework share ≥ 50 %, interventions ≥ 3, Supervisor share ≥ 50 %, else
 * "unexplained". The text carries the numbers behind the rule.
 */
function mostExpensiveWhy(ticket, fact, runs) {
  const rounds = fact.rounds ?? 0;
  if (rounds >= 3) return { rule: "rounds", text: `${rounds} review rounds` };
  let reworkUsd = 0;
  let runUsd = 0;
  for (const child of Array.isArray(fact.children) ? fact.children : []) {
    const run = child.telemetryRunId != null ? runs[child.telemetryRunId] : null;
    if (!run) continue;
    reworkUsd += run.reworkUsd ?? 0;
    runUsd += run.usd ?? 0;
  }
  if (runUsd > 0 && reworkUsd / runUsd >= 0.5) {
    return { rule: "rework", text: `${pctText(reworkUsd / runUsd)} of children's cost after turn 1` };
  }
  const interventions = fact.interventions ?? 0;
  if (interventions >= 3) return { rule: "interventions", text: `${interventions} human answers` };
  const totalUsd = ticket.totalUsd ?? 0;
  const supervisorUsd = ticket.supervisorUsd ?? 0;
  if (totalUsd > 0 && supervisorUsd / totalUsd >= 0.5) {
    return { rule: "supervisor", text: `${pctText(supervisorUsd / totalUsd)} of the ticket cost is Supervisor` };
  }
  return { rule: "unexplained", text: "no matching rule" };
}

// ── /api/costs ───────────────────────────────────────────────────────────────

/**
 * The GET /api/costs?period=7d|30d|all payload. `snapshot` null (or carrying
 * state "computing"/"error") → that state with null numbers — never zeros,
 * never invented values.
 */
export function buildCostsPayload({
  snapshot,
  facts,
  period,
  now = Date.now(),
  staleAfterMs = 5 * 60_000,
}) {
  requirePeriodMs(period);
  const state = payloadState(snapshot);
  if (state !== "ok") {
    return {
      period,
      computedAt: snapshot?.computedAt ?? null,
      stale: false,
      state,
      kpis: {
        childrenPerTicket: { p20: null, p50: null, p80: null, n: null },
        allInAvgPerTicket: null,
        totalUsd: null,
        childrenUsd: null,
        supervisorUsd: null,
        supervisorShare: null,
      },
      attribution: {
        attributedShare: null,
        overheadUsd: null,
        unattributedUsd: null,
        target: ATTRIBUTION_TARGET,
        belowTarget: null,
      },
      byDay: [],
      byModel: [],
      mostExpensive: [],
      unpricedMessages: null,
      legacyRows: null,
      definitions: DEFINITIONS,
    };
  }

  const report = snapshot.windows?.[period];
  if (report == null) throw new Error(`cost snapshot has no window for period ${period}`);
  const tickets = Array.isArray(report.tickets) ? report.tickets : [];
  const factsByTask = new Map((Array.isArray(facts) ? facts : []).map((f) => [f.taskId, f]));

  const childCosts = tickets.filter((t) => (t.childrenUsd ?? 0) > 0).map((t) => t.childrenUsd);
  const withTotal = tickets.filter((t) => (t.totalUsd ?? 0) > 0);
  const childrenUsd =
    tickets.reduce((sum, t) => sum + (t.childrenUsd ?? 0), 0) + (report.untaggedChildrenUsd ?? 0);
  const supervisor = report.supervisor ?? {};
  const supervisorUsd = supervisor.totalUsd ?? 0;
  const totalUsd = childrenUsd + supervisorUsd;

  const attributedShare = supervisor.attributedShare ?? null;
  // Null share → the banner shows whenever there IS Supervisor cost to attribute.
  const belowTarget =
    attributedShare == null ? (supervisor.totalUsd ?? 0) > 0 : attributedShare < ATTRIBUTION_TARGET;

  const byModelRaw = Array.isArray(report.byModel) ? report.byModel : [];
  const byModelTotal = byModelRaw.reduce((sum, m) => sum + (m.usd ?? 0), 0);

  const mostExpensive = [...tickets]
    .sort((a, b) => (b.totalUsd ?? 0) - (a.totalUsd ?? 0))
    .slice(0, 10)
    .map((ticket) => {
      const fact = factsByTask.get(ticket.taskId) ?? {};
      return {
        taskId: ticket.taskId,
        totalUsd: ticket.totalUsd ?? 0,
        childrenUsd: ticket.childrenUsd ?? 0,
        supervisorUsd: ticket.supervisorUsd ?? 0,
        why: mostExpensiveWhy(ticket, fact, snapshot.runs ?? {}),
      };
    });

  return {
    period,
    computedAt: snapshot.computedAt ?? null,
    stale: staleOf(snapshot, now, staleAfterMs),
    state: "ok",
    kpis: {
      childrenPerTicket: {
        p20: percentileNearestRank(childCosts, 20),
        p50: percentileNearestRank(childCosts, 50),
        p80: percentileNearestRank(childCosts, 80),
        n: childCosts.length,
      },
      allInAvgPerTicket: withTotal.length
        ? withTotal.reduce((sum, t) => sum + (t.totalUsd ?? 0), 0) / withTotal.length
        : null,
      totalUsd,
      childrenUsd,
      supervisorUsd,
      supervisorShare: totalUsd > 0 ? supervisorUsd / totalUsd : null,
    },
    attribution: {
      attributedShare,
      overheadUsd: supervisor.overheadUsd ?? null,
      unattributedUsd: supervisor.unattributedUsd ?? null,
      target: ATTRIBUTION_TARGET,
      belowTarget,
    },
    byDay: Array.isArray(report.byDay) ? report.byDay : [],
    byModel: byModelRaw.map((m) => ({
      model: m.model,
      usd: m.usd ?? 0,
      messages: m.messages ?? 0,
      share: byModelTotal > 0 ? (m.usd ?? 0) / byModelTotal : null,
    })),
    mostExpensive,
    unpricedMessages: report.unpricedMessages ?? 0,
    legacyRows: report.legacyRows ?? 0,
    definitions: DEFINITIONS,
  };
}

// ── /api/quality ─────────────────────────────────────────────────────────────

/**
 * The GET /api/quality?period= payload. Tickets in the period are the facts
 * whose lastActivityAt is at or after the period start ("all" → every fact).
 * Every signal carries numerator, denominator, unit, its written definition
 * and the taskIds counted in the numerator (≤ 20). Denominator 0 → value null.
 */
export function buildQualityPayload({
  snapshot,
  facts,
  linearStates,
  period,
  now = Date.now(),
  staleAfterMs = 5 * 60_000,
}) {
  const windowMs = requirePeriodMs(period);
  const state = payloadState(snapshot);
  const allFacts = Array.isArray(facts) ? facts : [];
  const periodStart = windowMs == null ? -Infinity : now - windowMs;
  const periodTickets = allFacts.filter((fact) => {
    if (windowMs == null) return true;
    const at = msOf(fact.lastActivityAt);
    return at != null && at >= periodStart;
  });

  if (state !== "ok") {
    return {
      period,
      computedAt: snapshot?.computedAt ?? null,
      stale: false,
      state,
      tickets: null,
      signals: Object.keys(SIGNAL_UNITS).map((key) => ({
        key,
        value: null,
        numerator: null,
        denominator: null,
        unit: SIGNAL_UNITS[key],
        definition: DEFINITIONS[key],
        evidence: [],
      })),
    };
  }

  const runs = snapshot.runs ?? {};
  const linearTypeOf = (taskId) => {
    const raw = linearStates?.[taskId];
    if (raw == null) return null;
    return typeof raw === "string" ? raw : (raw.type ?? null);
  };
  const cap = (taskIds) => taskIds.slice(0, EVIDENCE_CAP);

  // firstTimeRight — round-1 verdict PASS among tickets with a round-1 verdict.
  const withRound1 = periodTickets.filter((f) => round1VerdictOf(f) != null);
  const firstTimePass = withRound1.filter((f) => round1VerdictOf(f) === "PASS");

  // reworkShare — Σ reworkUsd / Σ usd over the period tickets' children runs
  // present in snapshot.runs (children without priced telemetry are excluded).
  let reworkUsdSum = 0;
  let runUsdSum = 0;
  const reworkTasks = [];
  for (const fact of periodTickets) {
    let contributed = false;
    for (const child of Array.isArray(fact.children) ? fact.children : []) {
      const run = child.telemetryRunId != null ? runs[child.telemetryRunId] : null;
      if (!run) continue;
      runUsdSum += run.usd ?? 0;
      reworkUsdSum += run.reworkUsd ?? 0;
      if ((run.reworkUsd ?? 0) > 0) contributed = true;
    }
    if (contributed) reworkTasks.push(fact.taskId);
  }

  // interventionsPerTicket — answers recorded for the ticket, per ticket with
  // any child.
  const withChildren = periodTickets.filter((f) => (Array.isArray(f.children) ? f.children.length : 0) > 0);
  const interventionsSum = withChildren.reduce((sum, f) => sum + (f.interventions ?? 0), 0);
  const interventionTasks = withChildren
    .filter((f) => (f.interventions ?? 0) > 0)
    .map((f) => f.taskId);

  // landingYield — Linear Done among tickets with at least one dev child.
  const withDevChild = periodTickets.filter((f) =>
    (Array.isArray(f.children) ? f.children : []).some((c) => c.squad === DEV_SQUAD),
  );
  const landed = withDevChild.filter((f) => linearTypeOf(f.taskId) === "completed");

  const signals = [
    {
      key: "firstTimeRight",
      value: withRound1.length > 0 ? firstTimePass.length / withRound1.length : null,
      numerator: firstTimePass.length,
      denominator: withRound1.length,
      unit: "share",
      definition: DEFINITIONS.firstTimeRight,
      evidence: cap(firstTimePass.map((f) => f.taskId)),
    },
    {
      key: "reworkShare",
      value: runUsdSum > 0 ? reworkUsdSum / runUsdSum : null,
      numerator: reworkUsdSum,
      denominator: runUsdSum,
      unit: "share",
      definition: DEFINITIONS.reworkShare,
      evidence: cap(reworkTasks),
    },
    {
      key: "interventionsPerTicket",
      value: withChildren.length > 0 ? interventionsSum / withChildren.length : null,
      numerator: interventionsSum,
      denominator: withChildren.length,
      unit: "count",
      definition: DEFINITIONS.interventionsPerTicket,
      evidence: cap(interventionTasks),
    },
    {
      key: "landingYield",
      value: withDevChild.length > 0 ? landed.length / withDevChild.length : null,
      numerator: landed.length,
      denominator: withDevChild.length,
      unit: "share",
      definition: DEFINITIONS.landingYield,
      evidence: cap(landed.map((f) => f.taskId)),
    },
  ];

  return {
    period,
    computedAt: snapshot.computedAt ?? null,
    stale: staleOf(snapshot, now, staleAfterMs),
    state: "ok",
    tickets: periodTickets.length,
    signals,
  };
}
