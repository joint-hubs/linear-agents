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
    "Review first-time-right: share of tickets whose round-1 review verdict is PASS, among tickets with a round-1 review verdict.",
  deliveryFirstTimeRight:
    "Share of tickets whose first delivery verdict is PASS, among tickets with any delivery verdict.",
  reviewFalsePass:
    "Share of REVIEW PASS rounds followed by a delivery FAIL on the same work tree (the fingerprint's diff axis), among REVIEW PASS rounds that have a later delivery verdict — or one that names the round explicitly (a backfilled record's fingerprint source \"round-N\", or a live record's contradicts block when a merge of the base branch was the only change since the pass — FOC-1210; the round reference, not the backdated clock, is the link). Counted in rounds, not tickets. The declared failing-test axis is excluded from the match — it is a per-verdict declaration (a delivery fail always declares one, so the combined hashes could never compare equal), not part of work identity.",
  ciRedAfterReady:
    "Share of tickets with a delivery FAIL citing reason \"ci\" (a CI red after READY TO PUSH), among tickets with any delivery verdict.",
  reworkShare:
    "Children's cost of turns ≥ 2 divided by children's cost, over children with a known turn-2 start and priced telemetry.",
  interventionsPerTicket:
    "Gate, hold and question answers recorded for the ticket, per ticket with any child.",
  landingYield:
    "Tickets whose Linear issue is Done, divided by tickets with at least one dev child.",
  mostExpensive:
    "First matching rule: 3 or more review rounds, rework share ≥ 50 %, 3 or more interventions, Supervisor share ≥ 50 %, otherwise unexplained.",
  // FOC-1071: the two new metrics. Triage size comes from the run's
  // triage.json; the PR open time from the publish-actions record.
  costPerTicketBySize:
    "All-in cost per ticket (children's cost plus Supervisor cost attributed to the ticket), split by the run's triage size (small / medium / large from triage.json): p50 with the p20–p80 band (nearest rank) per size. Tickets whose run carries no triage size, and zero-cost tickets, are in no bucket.",
  wallTimeToPr:
    "Wall time from a ticket's first recorded activity to its first successful PR open, over tickets that reached a PR in the period: p50 with the p20–p80 band (nearest rank), in hours.",
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
  deliveryFirstTimeRight: "share",
  reviewFalsePass: "share",
  ciRedAfterReady: "share",
  reworkShare: "share",
  interventionsPerTicket: "count",
  landingYield: "share",
  wallTimeToPr: "hours",
};

// FOC-1071: the triage sizes the cost-per-size metric splits into, and the
// hour — the wall-time signal's unit.
const TRIAGE_SIZES = ["small", "medium", "large"];
const HOUR_MS = 3_600_000;

/**
 * FOC-1071: the red/green state a target line gives a value. A missing target
 * or a missing value is NO state — never a false green. Direction "higher":
 * value at or above target is good (firstTimeRight). Direction "lower": value
 * at or below target is good (costs, interventions, wall time).
 */
export function targetState(value, target, direction) {
  if (typeof target !== "number" || !Number.isFinite(target)) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return direction === "higher" ? (value >= target ? "good" : "bad") : value <= target ? "good" : "bad";
}

// Which signal reads which `targets.<metric>` setting, and which way is good.
const TARGET_SPECS = {
  firstTimeRight: { direction: "higher", pick: (t) => t?.firstTimeRight },
  interventionsPerTicket: { direction: "lower", pick: (t) => t?.interventionsPerTicket },
  wallTimeToPr: { direction: "lower", pick: (t) => t?.wallTimeToPr },
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

/** The round-1 REVIEW verdict of a TicketFacts entry, or null when there is none.
 *  Exported for the cadence digest's weekly numbers (FOC-1071) — the same rule
 *  the firstTimeRight signal applies, never a second one. */
export const round1VerdictOf = (fact) =>
  (Array.isArray(fact.verdicts) ? fact.verdicts : [])
    // FOC-1169: a delivery verdict never counts as the review opinion, even
    // when it sits at round 1 of the chain. squad null is a legacy record,
    // written before verdicts carried a squad — those were review records.
    .find((v) => v.round === 1 && (v.squad === "review" || v.squad == null))?.verdict ?? null;

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

/**
 * FOC-1071: all-in cost per ticket split by the run's triage size — p20/p50/p80
 * (nearest rank) of totalUsd per size, over snapshot tickets whose joined fact
 * carries that size. A ticket without a size, and a zero-cost ticket, are in no
 * bucket; an empty bucket is null values with n 0 — never a zero.
 */
export function costPerTicketBySize(tickets, factsByTask, targets = null) {
  const rows = Array.isArray(tickets) ? tickets : [];
  const bySize = {};
  for (const size of TRIAGE_SIZES) {
    const values = rows
      .filter((t) => factsByTask?.get(t.taskId)?.size === size && (t.totalUsd ?? 0) > 0)
      .map((t) => t.totalUsd);
    const p50 = percentileNearestRank(values, 50);
    // FOC-1071: the size's target line (lower is better) rides the bucket —
    // a missing target is NO state, never a false green.
    const target = targets?.costPerTicketBySize?.[size] ?? null;
    bySize[size] = {
      p20: percentileNearestRank(values, 20),
      p50,
      p80: percentileNearestRank(values, 80),
      n: values.length,
      target,
      state: targetState(p50, target, "lower"),
    };
  }
  return bySize;
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
  targets = null,
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
        costPerTicketBySize: { small: null, medium: null, large: null },
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
      costPerTicketBySize: costPerTicketBySize(tickets, factsByTask, targets),
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
  targets = null,
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
        // wallTimeToPr is a distribution, not a ratio — its band fields ride
        // every state so the payload shape never depends on the snapshot.
        ...(key === "wallTimeToPr" ? { p20: null, p80: null, n: null } : {}),
        numerator: null,
        denominator: null,
        // FOC-1071: the target line rides every state; with no value it can
        // only be stateless — never a false green while the snapshot computes.
        target: TARGET_SPECS[key]?.pick(targets) ?? null,
        state: null,
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

  // ── delivery verdict signals (FOC-1169) ─────────────────────────────────────
  // The verdict rows carry squad / fingerprint / reason since the delivery
  // labels landed; rows from before that read null there, and null is UNKNOWN
  // — never counted as delivery or review evidence on either side of a signal.
  const orderedVerdicts = (f) =>
    [...(Array.isArray(f.verdicts) ? f.verdicts : [])].sort((a, b) => {
      const atA = String(a.at ?? "");
      const atB = String(b.at ?? "");
      return atA < atB ? -1 : atA > atB ? 1 : 0;
    });
  const deliveryRowsOf = (f) => orderedVerdicts(f).filter((v) => v.squad === "delivery");

  // deliveryFirstTimeRight — tickets whose FIRST delivery verdict is PASS,
  // among tickets with any delivery verdict.
  const withDelivery = periodTickets.filter((f) => deliveryRowsOf(f).length > 0);
  const deliveryFirstPass = withDelivery.filter((f) => deliveryRowsOf(f)[0].verdict === "PASS");

  // reviewFalsePass — REVIEW PASS rounds followed by a delivery FAIL on the
  // same WORK TREE (the fingerprint's diff axis), among REVIEW PASS rounds that
  // have a later delivery verdict — or one that NAMES the round explicitly
  // (fingerprintSource "round-N", FOC-1194 backfill; contradictsRound, FOC-1210
  // live base-merge): a backfilled delivery record's recordedAt is the
  // operator-typed truth of when it happened, so the round reference, not the
  // clock, is the authoritative link to the pass it contradicts. Counted in
  // ROUNDS, not tickets: the unit a review pass is
  // falsified in. NOT the combined hash: it folds the declared failing-test
  // axis into the identity, and a delivery fail always declares one — on
  // combined, the CI red after READY (the signal's motivating case) could never
  // compare equal to the pass it falsifies. A diff that could not be read
  // matches nothing — UNKNOWN is not evidence of a false pass, by position or
  // by name.
  let falsePassRounds = 0;
  let contradictedRounds = 0;
  const falsePassTasks = [];
  for (const f of periodTickets) {
    const rows = orderedVerdicts(f);
    rows.forEach((row, i) => {
      if (row.squad !== "review" || row.verdict !== "PASS") return;
      const named = row.round != null
        ? // r2 nit 9: row.round is always numeric (work-board emits a 0
          // fallback) — the guard documents the contract, it is not a check.
          rows.filter(
            (v) =>
              v.squad === "delivery" &&
              // FOC-1194 backfill (fingerprintSource "round-N") and the
              // FOC-1210 live base-merge route (contradictsRound) both NAME
              // the round — the round reference, not the clock, is the link.
              (v.fingerprintSource === `round-${row.round}` || v.contradictsRound === row.round) &&
              // r2 finding 1: the source names a round WITHIN the record's own
              // run — one task's rows merge across every run in the window, so
              // a bare round number would pair same-numbered review rounds of
              // OTHER runs too. Null runIds (legacy/unreadable) pair
              // positionally only.
              v.runId != null && v.runId === row.runId,
          )
        : [];
      const later = rows.slice(i + 1).filter((v) => v.squad === "delivery");
      // later and named can hold the same row — the union, deduped by identity.
      const contradicted = [...new Set([...later, ...named])];
      if (!contradicted.length) return;
      contradictedRounds += 1;
      // FOC-1210: the diff axis a row pairs on. A contradicts row's OWN
      // fingerprint is the tree as it is NOW (the base merge moved it, which
      // is why the flag exists) — the COPY in `contradicts` is what pairs with
      // the pass. Every other row pairs on its own fingerprintDiff.
      const pairsOn = (v) => (v.contradictsRound === row.round ? v.contradictsDiff : v.fingerprintDiff);
      if (contradicted.some((v) => v.verdict === "FAIL" && pairsOn(v) != null && pairsOn(v) === row.fingerprintDiff)) {
        falsePassRounds += 1;
        falsePassTasks.push(f.taskId);
      }
    });
  }

  // ciRedAfterReady — tickets with a delivery FAIL citing reason "ci", among
  // tickets with any delivery verdict.
  const ciRedTasks = withDelivery
    .filter((f) => deliveryRowsOf(f).some((v) => v.verdict === "FAIL" && v.reason === "ci"))
    .map((f) => f.taskId);

  // wallTimeToPr (FOC-1071) — first recorded activity → first successful PR
  // open, over tickets with both stamps. A PR earlier than the start is a
  // clock-skew record no metric can honestly use — dropped. Nearest-rank
  // p20/p50/p80 in hours; no sample → nulls, never a zero.
  const wallHours = [];
  const wallTasks = [];
  for (const f of periodTickets) {
    const start = msOf(f.firstActivityAt);
    const pr = msOf(f.prOpenAt);
    if (start == null || pr == null || pr < start) continue;
    wallHours.push((pr - start) / HOUR_MS);
    wallTasks.push(f.taskId);
  }

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
      key: "deliveryFirstTimeRight",
      value: withDelivery.length > 0 ? deliveryFirstPass.length / withDelivery.length : null,
      numerator: deliveryFirstPass.length,
      denominator: withDelivery.length,
      unit: "share",
      definition: DEFINITIONS.deliveryFirstTimeRight,
      evidence: cap(deliveryFirstPass.map((f) => f.taskId)),
    },
    {
      key: "reviewFalsePass",
      value: contradictedRounds > 0 ? falsePassRounds / contradictedRounds : null,
      numerator: falsePassRounds,
      denominator: contradictedRounds,
      unit: "share",
      definition: DEFINITIONS.reviewFalsePass,
      // One ticket id once — several falsified rounds on one ticket are one
      // piece of evidence for the reader.
      evidence: cap([...new Set(falsePassTasks)]),
    },
    {
      key: "ciRedAfterReady",
      value: withDelivery.length > 0 ? ciRedTasks.length / withDelivery.length : null,
      numerator: ciRedTasks.length,
      denominator: withDelivery.length,
      unit: "share",
      definition: DEFINITIONS.ciRedAfterReady,
      evidence: cap(ciRedTasks),
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
    {
      // FOC-1071: a distribution, not a ratio — p50 in `value`, the band and
      // the sample size beside it; numerator/denominator stay null honestly.
      key: "wallTimeToPr",
      value: percentileNearestRank(wallHours, 50),
      p20: percentileNearestRank(wallHours, 20),
      p80: percentileNearestRank(wallHours, 80),
      n: wallHours.length,
      numerator: null,
      denominator: null,
      unit: "hours",
      definition: DEFINITIONS.wallTimeToPr,
      evidence: cap(wallTasks),
    },
  ].map((signal) => {
    // FOC-1071: the target line and its red/green state ride the signal —
    // computed here (server-authoritative), rendered verbatim by the screen.
    const spec = TARGET_SPECS[signal.key];
    if (!spec) return { ...signal, target: null, state: null };
    const target = spec.pick(targets) ?? null;
    return { ...signal, target, state: targetState(signal.value, target, spec.direction) };
  });

  return {
    period,
    computedAt: snapshot.computedAt ?? null,
    stale: staleOf(snapshot, now, staleAfterMs),
    state: "ok",
    tickets: periodTickets.length,
    signals,
  };
}
