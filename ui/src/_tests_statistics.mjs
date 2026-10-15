// Unit tests for the runtime statistics pure helpers (P3).
// Self-contained Node ESM script — NO test framework, NO deps, NO DOM, NO
// network. Same harness pattern as src/_tests_work.mjs. Invoke directly:
// `node src/_tests_statistics.mjs` (registration in ui/package.json's test
// chain and scripts/test-lanes.json belongs to the parent wiring slice).
//
// Covers: the timeframe/filter URL round-trip (defaults, unknown values,
// non-canonical taskKeys), formatDuration/formatPct/formatCount (null -> null,
// 0 is a value, never "Unavailable" for a real zero), textOr, barPercent
// (null -> 0 track, clamped 100), the row builders (actors/roles/team,
// metrics fields, missing fields -> null), the workflow row groups (planned
// vs completed vs in-progress separation, zero pct bar), the rework rows
// (all enum buckets incl. zeros, exclusions, drilldown rows with cockpit
// links only for canonical taskKeys) and coverageWarnings (nonzero counters
// only, unknown-coverage warning).

import assert from 'node:assert/strict';

import {
  TIMEFRAMES,
  isCanonicalTaskKey,
  filtersFromQuery,
  queryFromFilters,
  getRuntimeStatistics,
  formatDuration,
  formatPct,
  formatCount,
  textOr,
  barPercent,
  actorRows,
  roleRows,
  teamRow,
  plannedRows,
  completedRouteRows,
  inProgressRouteRows,
  revisionRows,
  reworkSummary,
  reworkReasonRows,
  reworkSourceRows,
  reworkEventRows,
  coverageWarnings,
} from './statisticsModel.js';

// --- Minimal test harness (same shape as _tests_work.mjs) --------------------

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`√ ${name}`);
  } catch (err) {
    fail++;
    console.log(`× ${name} — ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
}

// --- fixtures (shaped like GET /api/runtime-statistics payloads) -------------

const STATISTICS = {
  window: { from: 1_000, to: 2_000 },
  actors: [
    {
      actorId: 'actor-1', role: 'supervisor',
      eligibleMs: 3_600_000, knownMs: 1_800_000, unknownMs: 1_800_000,
      busyMs: 900_000, waitingOnChildMs: 300_000, waitingOnHumanMs: 600_000,
      activePct: 50, coveragePct: 50,
    },
    {
      actorId: 'actor-2', role: 'dev',
      eligibleMs: null, knownMs: 0, unknownMs: null,
      busyMs: 0, waitingOnChildMs: 0, waitingOnHumanMs: 0,
      activePct: null, coveragePct: null,
    },
  ],
  roles: [
    {
      role: 'supervisor', actors: 1,
      eligibleMs: 3_600_000, knownMs: 1_800_000, unknownMs: 1_800_000,
      busyMs: 900_000, waitingOnChildMs: 300_000, waitingOnHumanMs: 600_000,
      activePct: 50, coveragePct: 50,
    },
  ],
  team: {
    actors: 2,
    eligibleMs: 3_600_000, knownMs: 1_800_000, unknownMs: 1_800_000,
    busyMs: 900_000, waitingOnChildMs: 300_000, waitingOnHumanMs: 600_000,
    activePct: 50, coveragePct: 50,
  },
  workflows: {
    initialChoice: {
      runsTotal: 4, runsKnown: 3, runsUnknownChoice: 1,
      proportions: [
        { stages: ['plan', 'dev', 'review'], runs: 2, pct: 66.67 },
        { stages: ['plan', 'dev'], runs: 1, pct: 33.33 },
      ],
    },
    revisions: {
      count: 2,
      byTarget: [{ stages: ['plan', 'dev', 'review', 'test'], count: 2 }],
    },
    observedRoutes: {
      completedRuns: 2,
      completed: [
        { route: 'plan|dev > review', runs: 1, pct: 50 },
        { route: 'plan > dev|review', runs: 1, pct: 0 },
      ],
      inProgress: [{ route: 'plan|dev', runs: 1 }],
      unattributedRuns: 1,
    },
  },
  rework: {
    count: 3,
    byReason: { review: 2, test: 1, human: 0, other: 0, unknown: 0 },
    bySource: { direct: 3, inferred: 0, other: 0 },
    completedTasks: 4,
    completedTasksAffected: 1,
    affectedPct: 25,
    excluded: { infrastructureRetry: 1, sameAttempt: 1, incomplete: 2, unattributed: 1 },
    events: [
      {
        taskKey: 'fenix:TEST-9', workflowRunId: 'run-9',
        fromAttemptId: 'a-1', toAttemptId: 'a-2',
        reason: 'rejected', source: 'direct', evidenceRef: 'ev-1',
      },
      {
        taskKey: 'not-canonical', workflowRunId: 'run-8',
        fromAttemptId: null, toAttemptId: 'a-3',
        reason: 'failed', source: 'inferred', evidenceRef: 'ev-2',
      },
    ],
  },
  coverage: {
    eligibleMs: 3_600_000, knownMs: 1_800_000, unknownMs: 1_800_000, coveragePct: 50,
    duplicateEventIds: 1, duplicateSpanIds: 0, invalidEvents: 2, openSpansDropped: 1,
    spansWithoutActor: 0, attemptEventsWithoutId: 3, actorsWithoutEligible: 1,
    unknownEventTypes: [{ type: 'mystery', count: 5 }],
    unknownSpanNames: [{ name: 'weird.span', count: 2 }],
  },
};

// --- filters round-trip ------------------------------------------------------

await test('timeframes are 24h/7d/all', () => {
  eq(TIMEFRAMES.map((t) => t.key), ['24h', '7d', 'all']);
});

await test('filters default to 24h with no taskKey', () => {
  eq(filtersFromQuery(''), { timeframe: '24h', taskKey: null });
});

await test('unknown timeframe falls back to default', () => {
  eq(filtersFromQuery('?timeframe=90d').timeframe, '24h');
});

await test('taskKey accepted only canonical', () => {
  eq(filtersFromQuery('?taskKey=fenix:TEST-1').taskKey, 'fenix:TEST-1');
  eq(filtersFromQuery('?taskKey=TEST-1').taskKey, null);
  eq(filtersFromQuery('?taskKey=%20fenix%3ATEST-1%20').taskKey, 'fenix:TEST-1'); // trimmed
  eq(filtersFromQuery('?taskKey=fenix%3ATE%20ST').taskKey, null); // space inside
});

await test('query round-trip keeps canonical filters only', () => {
  const f = { timeframe: '7d', taskKey: 'fenix:TEST-1' };
  eq(queryFromFilters(f), '?timeframe=7d&taskKey=fenix%3ATEST-1');
  eq(filtersFromQuery(queryFromFilters(f)), f);
});

await test('query round-trip drops non-canonical taskKey', () => {
  eq(queryFromFilters({ timeframe: 'all', taskKey: 'junk' }), '?timeframe=all');
  eq(queryFromFilters({ timeframe: '24h', taskKey: null }), '');
});

await test('isCanonicalTaskKey pin', () => {
  eq(isCanonicalTaskKey('fenix:TEST-1'), true);
  eq(isCanonicalTaskKey('jointhubs:FOC-123'), true);
  eq(isCanonicalTaskKey('TEST-1'), false);
  eq(isCanonicalTaskKey(':x'), false);
  eq(isCanonicalTaskKey('fenix:'), false);
  eq(isCanonicalTaskKey('fenix:has space'), false);
  eq(isCanonicalTaskKey(42), false);
});

// --- formatting: null vs 0 ----------------------------------------------------

await test('formatDuration: null/invalid -> null', () => {
  eq(formatDuration(null), null);
  eq(formatDuration(undefined), null);
  eq(formatDuration(NaN), null);
  eq(formatDuration(-5), null);
  eq(formatDuration('x'), null);
});

await test('formatDuration: 0 is a value, units ladder', () => {
  eq(formatDuration(0), '0 ms');
  eq(formatDuration(850), '850 ms');
  eq(formatDuration(12_500), '12.5 s');
  eq(formatDuration(195_000), '3.25 min');
  eq(formatDuration(8_640_000), '2.4 h');
  eq(formatDuration(129_600_000), '1.5 d');
});

await test('formatPct: null -> null, 0 is 0%, trailing zeros trimmed', () => {
  eq(formatPct(null), null);
  eq(formatPct(NaN), null);
  eq(formatPct(0), '0%');
  eq(formatPct(100), '100%');
  eq(formatPct(42.3), '42.3%');
  eq(formatPct(42.33), '42.33%');
  eq(formatPct(50.0), '50%');
});

await test('formatCount: null -> null, 0 is 0', () => {
  eq(formatCount(null), null);
  eq(formatCount(0), '0');
  eq(formatCount(12), '12');
  eq(formatCount(1.5), '2'); // display rounding; the payload never sends fractions
});

await test('textOr: missing reads Unavailable, never 0', () => {
  eq(textOr(null), 'Unavailable');
  eq(textOr(undefined), 'Unavailable');
  eq(textOr(null, 'unattributed'), 'unattributed');
  eq(textOr('0%'), '0%'); // a real zero already formatted stays
});

await test('barPercent: null -> 0 track, clamped, zero route bar stays 0', () => {
  eq(barPercent(null), 0);
  eq(barPercent(NaN), 0);
  eq(barPercent(-3), 0);
  eq(barPercent(0), 0); // zero pct: empty track + text, never a missing bar
  eq(barPercent(150), 100);
  eq(barPercent(33.33), 33.33);
});

// --- row builders -------------------------------------------------------------

await test('actorRows: metrics verbatim, missing -> null', () => {
  const rows = actorRows(STATISTICS);
  eq(rows.length, 2);
  eq(rows[0].actorId, 'actor-1');
  eq(rows[0].role, 'supervisor');
  eq(rows[0].activeText, '50%');
  eq(rows[0].activeBarPct, 50);
  eq(rows[0].coverageText, '50%');
  eq(rows[0].knownText, '30 min');
  eq(rows[0].unknownText, '30 min');
  eq(rows[1].actorId, 'actor-2');
  eq(rows[1].activeText, null); // null pct, never "0%"
  eq(rows[1].activeBarPct, 0); // but the bar track exists
  eq(rows[1].coverageText, null);
  eq(rows[1].knownText, '0 ms'); // real zero formats as zero
  eq(rows[1].unknownText, null);
  eq(rows[1].eligibleText, null);
});

await test('actorRows: empty/missing payload -> []', () => {
  eq(actorRows(null), []);
  eq(actorRows({}), []);
  eq(actorRows({ actors: [] }), []);
});

await test('roleRows and teamRow carry the pooled block', () => {
  const roles = roleRows(STATISTICS);
  eq(roles.length, 1);
  eq(roles[0].role, 'supervisor');
  eq(roles[0].actorsCount, 1);
  eq(roles[0].waitingOnChildText, '5 min');
  eq(roles[0].waitingOnHumanText, '10 min');
  const team = teamRow(STATISTICS);
  eq(team.actorsCount, 2);
  eq(team.activeText, '50%');
  eq(teamRow(null), null);
});

// --- workflow row groups -------------------------------------------------------

await test('plannedRows: proportions of runsKnown, denominator carried', () => {
  const planned = plannedRows(STATISTICS);
  eq(planned.runsTotal, 4);
  eq(planned.runsKnown, 3);
  eq(planned.runsUnknownChoice, 1);
  eq(planned.rows.length, 2);
  eq(planned.rows[0].stagesText, 'plan > dev > review');
  eq(planned.rows[0].pctText, '66.67%');
  eq(planned.rows[0].runsText, '2');
  eq(plannedRows(null).rows, []);
});

await test('completedRouteRows separate from inProgress; zero pct bar exists', () => {
  const completed = completedRouteRows(STATISTICS);
  eq(completed.completedRuns, 2);
  eq(completed.rows.length, 2);
  eq(completed.rows[0].pctText, '50%');
  eq(completed.rows[1].pctText, '0%'); // real zero, not null
  eq(completed.rows[1].barPct, 0);

  const inProgress = inProgressRouteRows(STATISTICS);
  eq(inProgress.rows.length, 1);
  eq(inProgress.rows[0].runsText, '1');
  eq(inProgress.rows[0].pctText, null); // counts only — no invented denominator
  eq(inProgress.unattributedRuns, 1);
});

await test('revisionRows: count + byTarget', () => {
  const revisions = revisionRows(STATISTICS);
  eq(revisions.count, 2);
  eq(revisions.rows.length, 1);
  eq(revisions.rows[0].stagesText, 'plan > dev > review > test');
  eq(revisions.rows[0].countText, '2');
  eq(revisionRows(null).count, null);
});

// --- rework --------------------------------------------------------------------

await test('reworkSummary: headline, affected pct, exclusions visible', () => {
  const r = reworkSummary(STATISTICS.rework);
  eq(r.countText, '3');
  eq(r.completedTasksText, '4');
  eq(r.completedTasksAffectedText, '1');
  eq(r.affectedPctText, '25%');
  eq(r.excluded, { infrastructureRetry: 1, sameAttempt: 1, incomplete: 2, unattributed: 1 });
  eq(reworkSummary(null), null);
});

await test('reworkReasonRows/SourceRows: every bucket, zeros included', () => {
  eq(reworkReasonRows(STATISTICS.rework).map((r) => `${r.reason}:${r.count}`),
    ['review:2', 'test:1', 'human:0', 'other:0', 'unknown:0']);
  eq(reworkSourceRows(STATISTICS.rework).map((r) => `${r.source}:${r.count}`),
    ['direct:3', 'inferred:0', 'other:0']);
  eq(reworkReasonRows({}).map((r) => r.count), [0, 0, 0, 0, 0]); // absent -> honest zeros
});

await test('reworkEventRows: payload fields verbatim, cockpit link only canonical', () => {
  const rows = reworkEventRows(STATISTICS.rework);
  eq(rows.length, 2);
  eq(rows[0].taskKey, 'fenix:TEST-9');
  eq(rows[0].taskKeyHref, '/work/fenix%3ATEST-9/cockpit');
  eq(rows[0].fromAttemptId, 'a-1');
  eq(rows[0].toAttemptId, 'a-2');
  eq(rows[0].evidenceRef, 'ev-1');
  eq(rows[1].taskKeyHref, null); // non-canonical: no invented link
  eq(rows[1].fromAttemptId, null);
  eq(reworkEventRows({}), []);
  eq(reworkEventRows(null), []);
});

// --- coverage warnings ----------------------------------------------------------

await test('coverageWarnings: nonzero counters only, one sentence each', () => {
  const warnings = coverageWarnings(STATISTICS);
  eq(warnings.includes('1 duplicate event records ignored (idempotent replay)'), true);
  eq(warnings.includes('2 event records dropped as malformed'), true);
  eq(warnings.includes('1 open or invalid spans dropped (never extended)'), true);
  eq(warnings.includes('3 stage attempt events without an attemptId ignored'), true);
  eq(warnings.includes('1 actors with an unknown eligible lifetime (missing supervisor lifecycle)'), true);
  eq(warnings.includes('5 events of an unknown type "mystery" ignored'), true);
  eq(warnings.includes('2 spans of an unknown name "weird.span" ignored'), true);
  // zero counters never appear
  eq(warnings.some((w) => w.includes('duplicate span')), false);
  eq(warnings.some((w) => w.includes('without an actor')), false);
  // coverage is known here -> no unknown-coverage warning
  eq(warnings.some((w) => w.includes('coverage is unknown')), false);
});

await test('coverageWarnings: unknown coverage warns; clean payload stays quiet', () => {
  const unknown = coverageWarnings({ coverage: { coveragePct: null, duplicateEventIds: 0 } });
  eq(unknown, ['team coverage is unknown (no bounded eligible lifetime in this window)']);
  eq(coverageWarnings(null), []);
  eq(coverageWarnings({ coverage: { coveragePct: 50, duplicateEventIds: 0, invalidEvents: 0 } }), []);
});

// --- fetch helper (mocked global fetch — no network) -----------------------------

await test('getRuntimeStatistics: window shorthand + canonical taskKey on the query', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    await getRuntimeStatistics({ timeframe: '7d', taskKey: 'fenix:TEST-1' });
    eq(calls[0].path, '/api/runtime-statistics?window=7d&taskKey=fenix%3ATEST-1');
    await getRuntimeStatistics({ timeframe: 'all', taskKey: null });
    eq(calls[1].path, '/api/runtime-statistics');
    eq(calls[1].init.signal, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('getRuntimeStatistics: error body -> Error with .status and .data', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'bad window: expected 24h|7d|30d' }),
  });
  try {
    await assert.rejects(
      () => getRuntimeStatistics({ timeframe: '90d' }),
      (err) => err.status === 400 && err.data.error.includes('bad window'),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- report ----------------------------------------------------------------------

console.log(`\nstatisticsModel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);