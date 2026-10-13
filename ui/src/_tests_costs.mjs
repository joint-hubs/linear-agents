// Unit tests for the Costs & quality pure helpers (FOC-785).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_cockpit.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: PERIODS, kpiTiles (the four tiles, p20–p80 band sub, definitions,
// null -> "unknown"), attributionBanner (on/off), byDayBars (stacked values,
// max for scaling, the role="img" text summary), modelMixRows (share %),
// expensiveRows (the "why"), qualityCards (share %, count, "n/a — no data").
// Fixtures shaped like the plan's GET /api/costs and GET /api/quality
// payloads — no network, no DOM.

import assert from 'node:assert/strict';

import {
  PERIODS,
  kpiTiles,
  attributionBanner,
  byDayBars,
  modelMixRows,
  expensiveRows,
  qualityCards,
} from './costsModel.js';

// --- Minimal test harness (same shape as _tests_cockpit.mjs) ----------------

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

// --- Fixtures (shaped like GET /api/costs and GET /api/quality payloads) ----

const costs = {
  period: '30d',
  computedAt: '2026-10-13T11:58:00Z',
  stale: false,
  state: 'ok',
  kpis: {
    childrenPerTicket: { p20: 0.15, p50: 0.36, p80: 1.15, n: 41 },
    allInAvgPerTicket: 14.2,
    totalUsd: 568.0,
    childrenUsd: 159.0,
    supervisorUsd: 409.0,
    supervisorShare: 0.72,
  },
  attribution: { attributedShare: 0.64, overheadUsd: 12.3, unattributedUsd: 7.1, target: 0.8, belowTarget: true },
  byDay: [
    { day: '2026-10-01', childrenUsd: 8.1, supervisorUsd: 4.24, overheadUsd: 0.5, unattributedUsd: 0.3 },
    { day: '2026-10-02', childrenUsd: 2.0, supervisorUsd: 1.0, overheadUsd: 0, unattributedUsd: 0 },
  ],
  byModel: [
    { model: 'z-ai/glm-5.3-flash', usd: 210.5, share: 0.63, messages: 1200 },
    { model: 'claude-opus-5-5', usd: null, share: null, messages: 3 },
  ],
  mostExpensive: [
    { taskId: 'FOC-403', totalUsd: 37.83, childrenUsd: 33.73, supervisorUsd: 4.1, why: { rule: 'rounds', text: '3 review rounds' } },
    { taskId: 'FOC-9', totalUsd: null, childrenUsd: null, supervisorUsd: null, why: null },
  ],
  unpricedMessages: 12,
  legacyRows: 0,
  definitions: {
    childrenPerTicket: 'Median children cost per ticket (from the snapshot).',
  },
};

const quality = {
  period: '30d',
  computedAt: '2026-10-13T11:58:00Z',
  stale: false,
  state: 'ok',
  tickets: 41,
  signals: [
    {
      key: 'firstTimeRight',
      value: 0.72,
      numerator: 29,
      denominator: 41,
      unit: 'share',
      definition: 'Share of tickets whose round-1 review verdict is PASS.',
      evidence: ['FOC-403', 'FOC-9'],
    },
    {
      key: 'interventionsPerTicket',
      value: 1.4,
      numerator: 57,
      denominator: 41,
      unit: 'count',
      definition: 'Gate / hold / ask answers recorded for the ticket.',
      evidence: [],
    },
    {
      key: 'landingYield',
      value: null,
      numerator: 0,
      denominator: 0,
      unit: 'share',
      definition: 'Landed tickets / tickets with at least one dev child.',
      evidence: [],
    },
  ],
};

// --- PERIODS ------------------------------------------------------------------

await test('PERIODS are 7d / 30d / All in order', () => {
  eq(PERIODS, [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All' },
  ]);
});

// --- kpiTiles -------------------------------------------------------------------

await test('kpiTiles returns the four tiles with the payload keys in order', () => {
  eq(
    kpiTiles(costs).map((t) => t.key),
    ['childrenPerTicket', 'allInAvgPerTicket', 'totalUsd', 'supervisorShare'],
  );
});

await test('kpiTiles children per ticket: p50 value with the p20–p80 band sub', () => {
  const t = kpiTiles(costs)[0];
  eq(t.value, '$0.36');
  eq(t.sub, 'p20–p80 $0.15–$1.15');
  eq(t.label, 'Children cost per ticket');
});

await test('kpiTiles all-in average, total spend, Supervisor share', () => {
  eq(kpiTiles(costs)[1].value, '$14.20');
  eq(kpiTiles(costs)[2].value, '$568.00');
  eq(kpiTiles(costs)[3].value, '72 %');
});

await test('kpiTiles definitions: the payload map wins, defaults fill the rest', () => {
  const tiles = kpiTiles(costs);
  eq(tiles[0].definition, 'Median children cost per ticket (from the snapshot).');
  eq(tiles[1].definition, 'Total spend in the period divided by the number of tickets.');
  eq(tiles[2].definition, 'All spend attributed in the period: children, Supervisor share, overhead and unattributed.');
  eq(tiles[3].definition, 'Supervisor cost as a share of the total spend in the period.');
});

await test('kpiTiles missing kpis -> "unknown", never a fake zero', () => {
  const tiles = kpiTiles({});
  eq(tiles.map((t) => t.value), ['unknown', 'unknown', 'unknown', 'unknown']);
  eq(tiles[0].sub, null);
  eq(kpiTiles(null)[3].value, 'unknown');
});

await test('kpiTiles childrenPerTicket null -> unknown tile without a band sub', () => {
  const tiles = kpiTiles({ kpis: { childrenPerTicket: null } });
  eq(tiles[0].value, 'unknown');
  eq(tiles[0].sub, null);
});

await test('kpiTiles band without p20 -> no sub, p50 still shown', () => {
  const tiles = kpiTiles({ kpis: { childrenPerTicket: { p50: 0.36, p20: null, p80: null, n: 41 } } });
  eq(tiles[0].value, '$0.36');
  eq(tiles[0].sub, null);
});

// --- attributionBanner ------------------------------------------------------------

await test('attributionBanner belowTarget -> the honest sentence', () => {
  eq(attributionBanner(costs), {
    text: 'Supervisor attribution 64 % — $12.30 overhead, $7.10 unattributed',
    definition:
      'Shown while the Supervisor-attributed share is below 80 % (FOC-769): overhead plus unattributed Supervisor cost.',
  });
});

await test('attributionBanner at target -> null (nothing to report)', () => {
  eq(
    attributionBanner({ ...costs, attribution: { ...costs.attribution, belowTarget: false } }),
    null,
  );
});

await test('attributionBanner no attribution block -> null', () => {
  eq(attributionBanner({}), null);
  eq(attributionBanner(null), null);
});

// --- byDayBars -----------------------------------------------------------------------

await test('byDayBars stacks children vs ALL Supervisor cost (supervisor + overhead + unattributed)', () => {
  const r = byDayBars(costs.byDay);
  eq(r.bars, [
    { day: '2026-10-01', children: 8.1, supervisor: 5.04, total: 13.14 },
    { day: '2026-10-02', children: 2.0, supervisor: 1.0, total: 3.0 },
  ]);
  eq(r.max, 13.14);
});

await test('byDayBars summary names the count, total and highest day (role="img" label)', () => {
  eq(
    byDayBars(costs.byDay).summary,
    'Spend by day over 2 days: total $16.14, highest 2026-10-01 at $13.14 (children $8.10, Supervisor $5.04 incl. overhead and unattributed).',
  );
});

await test('byDayBars empty -> no bars, max 0, honest summary', () => {
  eq(byDayBars([]), { bars: [], max: 0, summary: 'No spend recorded in this period.' });
  eq(byDayBars(null).max, 0);
});

await test('byDayBars null amounts count as 0 for the scaling', () => {
  const r = byDayBars([{ day: '2026-10-03', childrenUsd: null, supervisorUsd: 2.5 }]);
  eq(r.bars, [{ day: '2026-10-03', children: 0, supervisor: 2.5, total: 2.5 }]);
  eq(r.max, 2.5);
});

// --- modelMixRows -----------------------------------------------------------------------

await test('modelMixRows share as % and cost money text', () => {
  eq(modelMixRows(costs.byModel), [
    { model: 'z-ai/glm-5.3-flash', cost: '$210.50', share: '63 %', messages: 1200 },
    { model: 'claude-opus-5-5', cost: 'unknown', share: 'unknown', messages: 3 },
  ]);
});

await test('modelMixRows empty/null -> []', () => {
  eq(modelMixRows([]), []);
  eq(modelMixRows(null), []);
});

// --- expensiveRows ------------------------------------------------------------------------

await test('expensiveRows money texts and the payload "why" text', () => {
  eq(expensiveRows(costs.mostExpensive), [
    { taskId: 'FOC-403', total: '$37.83', children: '$33.73', supervisor: '$4.10', why: '3 review rounds' },
    { taskId: 'FOC-9', total: 'unknown', children: 'unknown', supervisor: 'unknown', why: 'unexplained' },
  ]);
});

await test('expensiveRows falls back to the why rule, then "unexplained"', () => {
  eq(expensiveRows([{ taskId: 'X', why: { rule: 'rework', text: null } }])[0].why, 'rework');
  eq(expensiveRows([{ taskId: 'X' }])[0].why, 'unexplained');
});

await test('expensiveRows "no matching rule" placeholder reads "unexplained" (spec §4.4)', () => {
  eq(expensiveRows([{ taskId: 'X', why: { rule: 'none', text: 'no matching rule' } }])[0].why, 'unexplained');
  eq(expensiveRows([{ taskId: 'X', why: { rule: 'No Matching Rule', text: null } }])[0].why, 'unexplained');
  eq(expensiveRows([{ taskId: 'X', why: { rule: 'rework', text: '2 rework rounds' } }])[0].why, '2 rework rounds');
});

// --- qualityCards -----------------------------------------------------------------------------

await test('qualityCards share -> %, count -> count text, null -> "n/a — no data"', () => {
  eq(qualityCards(quality), [
    {
      key: 'firstTimeRight',
      value: '72 %',
      definition: 'Share of tickets whose round-1 review verdict is PASS.',
      evidenceCount: 2,
    },
    {
      key: 'interventionsPerTicket',
      value: '1.4',
      definition: 'Gate / hold / ask answers recorded for the ticket.',
      evidenceCount: 0,
    },
    {
      key: 'landingYield',
      value: 'n/a — no data',
      definition: 'Landed tickets / tickets with at least one dev child.',
      evidenceCount: 0,
    },
  ]);
});

await test('qualityCards null/empty quality -> []', () => {
  eq(qualityCards(null), []);
  eq(qualityCards({}), []);
  eq(qualityCards({ signals: [] }), []);
});

// --- Summary -----------------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);