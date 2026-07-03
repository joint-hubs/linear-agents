// Unit tests for pure UI functions (JOI-71 UI hygiene).
// Self-contained Node ESM script — NO test framework, NO deps.
// Runs on Node >= 18. Invoke via: `npm --prefix ui run test`.
//
// Covers: statusLabel, isStale, todayTotals, attentionList (utils.js)
// and linearUrl (config.js). The source logic IS the spec — these tests
// pin current behavior; if a test fails we fix the TEST, not the source.

import assert from 'node:assert/strict';

import { statusLabel, isStale, todayTotals, attentionList } from './utils.js';
import { linearUrl } from './config.js';

// --- Minimal test harness -------------------------------------------------

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

// --- statusLabel ----------------------------------------------------------

await test('statusLabel(null) -> "done"', () => {
  eq(statusLabel(null), 'done');
});

await test('statusLabel(undefined) -> "done"', () => {
  eq(statusLabel(undefined), 'done');
});

await test('statusLabel({status:"running"}) -> "running"', () => {
  eq(statusLabel({ status: 'running' }), 'running');
});

await test('statusLabel({status:"failed"}) -> "failed"', () => {
  eq(statusLabel({ status: 'failed' }), 'failed');
});

await test('statusLabel({status:"completed"}) -> "done" (normalized)', () => {
  eq(statusLabel({ status: 'completed' }), 'done');
});

await test('statusLabel({status:"done"}) -> "done"', () => {
  eq(statusLabel({ status: 'done' }), 'done');
});

await test('statusLabel({}) legacy no endedAt -> "running"', () => {
  eq(statusLabel({}), 'running');
});

await test('statusLabel legacy endedAt+exitCode 0 -> "done"', () => {
  eq(statusLabel({ endedAt: '2026-07-01T10:00:00Z', exitCode: 0 }), 'done');
});

await test('statusLabel legacy endedAt+exitCode 1 -> "failed"', () => {
  eq(statusLabel({ endedAt: '2026-07-01T10:00:00Z', exitCode: 1 }), 'failed');
});

await test('statusLabel legacy exitCode as string "2" -> "failed"', () => {
  eq(statusLabel({ endedAt: '2026-07-01T10:00:00Z', exitCode: '2' }), 'failed');
});

await test('statusLabel legacy endedAt without exitCode -> "done"', () => {
  eq(statusLabel({ endedAt: '2026-07-01T10:00:00Z' }), 'done');
});

// --- isStale --------------------------------------------------------------

await test('isStale(null) -> false', () => {
  eq(isStale(null), false);
});

await test('isStale({}) no startedAt -> false', () => {
  eq(isStale({}), false);
});

await test('isStale ended run -> false', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  eq(
    isStale({ startedAt: '2026-07-01T00:00:00Z', endedAt: '2026-07-01T01:00:00Z' }, now),
    false,
  );
});

await test('isStale active started >2h ago -> true', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  // started 3h before now, no endedAt
  eq(isStale({ startedAt: '2026-07-01T02:00:00Z' }, now), true);
});

await test('isStale active started <2h ago -> false', () => {
  const now = new Date('2026-07-01T03:30:00Z');
  // started 1.5h before now
  eq(isStale({ startedAt: '2026-07-01T02:00:00Z' }, now), false);
});

await test('isStale boundary: now-2h-1s -> true (strict <)', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  const started = new Date(now.getTime() - 2 * 60 * 60 * 1000 - 1000).toISOString();
  eq(isStale({ startedAt: started }, now), true);
});

await test('isStale boundary: now-1h -> false', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  const started = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
  eq(isStale({ startedAt: started }, now), false);
});

// --- linearUrl ------------------------------------------------------------

await test('linearUrl("PISI-98") -> pisi issue url', () => {
  eq(linearUrl('PISI-98'), 'https://linear.app/pisi/issue/PISI-98');
});

await test('linearUrl("FEN-10") -> jointhubs issue url', () => {
  eq(linearUrl('FEN-10'), 'https://linear.app/jointhubs/issue/FEN-10');
});

await test('linearUrl("JOI-71") -> jointhubs issue url', () => {
  eq(linearUrl('JOI-71'), 'https://linear.app/jointhubs/issue/JOI-71');
});

await test('linearUrl("XXX-99") -> null (unknown prefix)', () => {
  eq(linearUrl('XXX-99'), null);
});

await test('linearUrl("lowercase-1") -> null (regex requires uppercase)', () => {
  eq(linearUrl('lowercase-1'), null);
});

await test('linearUrl("FEN-abc") -> null (non-numeric suffix)', () => {
  eq(linearUrl('FEN-abc'), null);
});

await test('linearUrl("FEN10") -> null (no hyphen)', () => {
  eq(linearUrl('FEN10'), null);
});

await test('linearUrl(null) -> null', () => {
  eq(linearUrl(null), null);
});

await test('linearUrl("") -> null', () => {
  eq(linearUrl(''), null);
});

await test('linearUrl(123) -> null (non-string)', () => {
  eq(linearUrl(123), null);
});

await test('linearUrl(undefined) -> null', () => {
  eq(linearUrl(undefined), null);
});

// --- todayTotals ----------------------------------------------------------
// Uses LOCAL date comparison (getFullYear/getMonth/getDate). Construct
// startedAt values that resolve to the same local day as `now`.

await test('todayTotals sums same-local-day runs only', () => {
  const now = new Date('2026-07-03T12:00:00');
  const runs = [
    { startedAt: '2026-07-03T08:00:00', totals: { costUSD: 1.5, inputTokens: 100, outputTokens: 50 } },
    { startedAt: '2026-07-03T11:00:00', totals: { costUSD: 2.0, inputTokens: 200, outputTokens: 75 } },
    // previous local day — must be excluded even with large cost
    { startedAt: '2026-07-02T23:00:00', totals: { costUSD: 100.0, inputTokens: 9999, outputTokens: 9999 } },
  ];
  eq(todayTotals(runs, now), { costUSD: 3.5, inputTokens: 300, outputTokens: 125 });
});

await test('todayTotals([]) -> zeros', () => {
  const now = new Date('2026-07-03T12:00:00');
  eq(todayTotals([], now), { costUSD: 0, inputTokens: 0, outputTokens: 0 });
});

await test('todayTotals(null) -> zeros (for..of guards runs||[])', () => {
  eq(todayTotals(null), { costUSD: 0, inputTokens: 0, outputTokens: 0 });
});

await test('todayTotals(undefined, now) -> zeros', () => {
  const now = new Date('2026-07-03T12:00:00');
  eq(todayTotals(undefined, now), { costUSD: 0, inputTokens: 0, outputTokens: 0 });
});

await test('todayTotals run with missing totals contributes 0', () => {
  const now = new Date('2026-07-03T12:00:00');
  const runs = [
    { startedAt: '2026-07-03T08:00:00' }, // no totals
    { startedAt: '2026-07-03T09:00:00', totals: { costUSD: 1.0, inputTokens: 10, outputTokens: 5 } },
  ];
  eq(todayTotals(runs, now), { costUSD: 1.0, inputTokens: 10, outputTokens: 5 });
});

// --- attentionList --------------------------------------------------------

await test('attentionList stale branch: running >2h -> reason "stale"', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  const runs = [{ runId: 'r1', startedAt: '2026-07-01T02:00:00Z' }]; // 3h, no endedAt
  const out = attentionList(runs, now);
  eq(out.length, 1);
  eq(out[0].reason, 'stale');
  eq(out[0].run.runId, 'r1');
});

await test('attentionList ambiguous within 24h -> "ambiguous"', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  // Started 1h ago: within 24h ambiguous window AND <2h so NOT stale
  // (isolates the ambiguous branch from the stale branch).
  const runs = [{ runId: 'r1', ambiguous: true, startedAt: '2026-07-01T11:00:00Z' }];
  const out = attentionList(runs, now);
  eq(out.length, 1);
  eq(out[0].reason, 'ambiguous');
});

await test('attentionList ambiguous older than 24h -> NOT included', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  // 30h ago — beyond 24h cutoff. endedAt set so isStale()=false, isolating
  // the ambiguous-cutoff branch (an active run >2h would also be stale).
  const old = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
  const runs = [{ runId: 'r1', ambiguous: true, startedAt: old, endedAt: old }];
  const out = attentionList(runs, now);
  eq(out, []);
});

await test('attentionList over-budget: latest run for task chosen', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  const runs = [
    { runId: 'a', taskId: 'FEN-99', startedAt: '2026-07-01T02:00:00Z' },
    { runId: 'b', taskId: 'FEN-99', startedAt: '2026-07-01T05:00:00Z' }, // later
  ];
  const out = attentionList(runs, now, ['FEN-99']);
  const ob = out.filter((i) => i.reason === 'over-budget');
  eq(ob.length, 1);
  eq(ob[0].run.runId, 'b');
});

await test('attentionList over-budget skipped when overBudgetTasks empty', () => {
  // A run that is neither stale (<2h) nor ambiguous: with empty overBudgetTasks
  // the over-budget pass is skipped, so nothing is emitted.
  const now = new Date('2026-07-01T02:30:00Z');
  const runs = [{ runId: 'a', taskId: 'FEN-99', startedAt: '2026-07-01T02:00:00Z' }];
  eq(attentionList(runs, now, []), []);
});

await test('attentionList([]) -> []', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  eq(attentionList([], now), []);
});

await test('attentionList(null) -> []', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  eq(attentionList(null, now), []);
});

await test('attentionList de-dup: same runId+reason first-wins', () => {
  // A run that is BOTH ambiguous AND stale gets TWO entries (one per reason),
  // because the dedup key is runId:reason. This is intentional — the test
  // pins that cross-reason entries are NOT deduped.
  const now = new Date('2026-07-01T05:00:00Z');
  const runs = [
    { runId: 'r1', ambiguous: true, startedAt: '2026-07-01T02:00:00Z' }, // 3h, ambiguous+stale
  ];
  const out = attentionList(runs, now);
  const reasons = out.map((i) => i.reason).sort();
  eq(reasons, ['ambiguous', 'stale']);
});

// D-OB1 edge (JOI-71 comment): a run that is BOTH stale (or ambiguous) AND
// the latest run for an over-budget task. Pass 1 pushes a 'stale' entry;
// pass 2 pushes an 'over-budget' entry for the SAME runId. The dedup key
// is `runId:reason`, so these are NOT deduped cross-reason → BOTH entries
// survive. This test PINS the current (known-edge) behavior so that a
// future fix is a deliberate, visible change.
await test('D-OB1 edge: stale + over-budget same run -> BOTH survive', () => {
  const now = new Date('2026-07-01T05:00:00Z');
  const runs = [
    { runId: 'r1', taskId: 'FEN-99', startedAt: '2026-07-01T02:00:00Z' }, // 3h stale + latest for FEN-99
  ];
  const out = attentionList(runs, now, ['FEN-99']);
  const reasons = out.map((i) => i.reason).sort();
  eq(reasons, ['over-budget', 'stale']);
  // both entries reference the same run
  eq(out.every((i) => i.run.runId === 'r1'), true);
});

// --- Summary --------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
