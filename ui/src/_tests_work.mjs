// Unit tests for the Work board pure helpers (FOC-784).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_cockpit.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: STAGES order, groupByStage (empty stages kept), cardModel (rounds,
// no-cost-yet / cost unknown, flag tone+text, age), formatMoney (the
// ticket-cost.mjs rule incl. sub-cent 2 significant digits), staleLabel
// (computing / stale / updated / refresh-failed / unavailable), timelineRows,
// evidenceRows (path-without-href -> copyable), reconciliationText, the
// filters round-trip and the Start dialog states. Fixtures shaped like the
// plan's API payloads — no network, no DOM.

import assert from 'node:assert/strict';

import {
  STAGES,
  groupByStage,
  cardModel,
  costLabel,
  panelCostLabel,
  formatMoney,
  staleLabel,
  timelineRows,
  evidenceRows,
  reconciliationText,
  filtersFromQuery,
  queryFromFilters,
  startDialogModel,
  publishDialogModel,
  claimTag,
  ticketLabels,
  labelNames,
} from './workModel.js';

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

// --- Fixtures (shaped like GET /api/work/tickets payloads) ------------------

const NOW = new Date(2026, 9, 13, 12, 0, 0); // local 2026-10-13 12:00
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const ticketDev = {
  taskId: 'FOC-403',
  title: 'Telemetry usage duplicates',
  url: 'https://linear.example/issue/FOC-403',
  stage: 'dev',
  linearState: { name: 'In Progress', type: 'started' },
  priority: { value: 2, name: 'High' },
  milestone: 'Dashboard v2',
  labels: [
    { id: 'lab-1', name: 'bug', color: '#d4c5f9' },
    { id: 'lab-2', name: 'dashboard-v2', color: null },
  ],
  rounds: 2,
  lastVerdict: 'PASS',
  flags: [
    { kind: 'live', text: 'child c-7 running', childId: 'c-7' },
    { kind: 'gate', text: 'waiting on gate g-2', childId: 'c-7' },
  ],
  cost: { childrenUsd: 33.73, supervisorUsd: 4.1, totalUsd: 37.83 },
  lastActivityAt: ago(5 * 60_000),
  childCount: 3,
};

const ticketReady = {
  taskId: 'FOC-788',
  title: 'Push / Open PR actions',
  url: 'https://linear.example/issue/FOC-788',
  stage: 'ready',
  linearState: null,
  priority: null,
  milestone: null,
  labels: [],
  rounds: 0,
  lastVerdict: null,
  flags: [],
  cost: null,
  lastActivityAt: ago(30_000),
  childCount: 0,
};

// --- STAGES ------------------------------------------------------------------

await test('STAGES lists the six board columns in order with labels', () => {
  eq(
    STAGES.map((s) => s.key),
    ['ready', 'plan', 'dev', 'review', 'test', 'landed'],
  );
  eq(
    STAGES.map((s) => s.label),
    ['Ready', 'Plan', 'Dev', 'Review', 'Test', 'Landed'],
  );
});

// --- groupByStage ------------------------------------------------------------

await test('groupByStage([]) keeps every stage as an empty array', () => {
  eq(groupByStage([]), { ready: [], plan: [], dev: [], review: [], test: [], landed: [] });
});

await test('groupByStage(null/undefined) keeps every stage as an empty array', () => {
  eq(groupByStage(null), { ready: [], plan: [], dev: [], review: [], test: [], landed: [] });
});

await test('groupByStage groups tickets and keeps empty stages', () => {
  const out = groupByStage([ticketDev, ticketReady, { ...ticketDev, taskId: 'FOC-9' }]);
  eq(out.ready, [ticketReady]);
  eq(out.dev, [ticketDev, { ...ticketDev, taskId: 'FOC-9' }]);
  eq(out.plan, []);
  eq(out.review, []);
  eq(out.test, []);
  eq(out.landed, []);
});

await test('groupByStage drops a ticket with a missing/unknown stage', () => {
  const out = groupByStage([{ taskId: 'X' }, { taskId: 'Y', stage: 'elsewhere' }]);
  eq(out.ready, []);
  eq(Object.values(out).flat().length, 0);
});

// --- cardModel ----------------------------------------------------------------

await test('cardModel dev ticket -> id, title, stage label, labels, rounds, money, age', () => {
  eq(cardModel(ticketDev, NOW), {
    id: 'FOC-403',
    title: 'Telemetry usage duplicates',
    stageLabel: 'Dev',
    labels: [
      { id: 'lab-1', name: 'bug', color: '#d4c5f9' },
      { id: 'lab-2', name: 'dashboard-v2', color: null },
    ],
    rounds: '2 rounds',
    cost: '$37.83',
    flags: [
      { text: 'child c-7 running', tone: 'running' },
      { text: 'waiting on gate g-2', tone: 'waiting' },
    ],
    age: 'updated 5 min ago',
  });
});

await test('cardModel rounds 1 -> "1 round", 0/null -> null', () => {
  eq(cardModel({ stage: 'dev', rounds: 1 }, NOW).rounds, '1 round');
  eq(cardModel({ stage: 'dev', rounds: 0 }, NOW).rounds, null);
  eq(cardModel({ stage: 'dev', rounds: null }, NOW).rounds, null);
  eq(cardModel({ stage: 'dev' }, NOW).rounds, null);
});

await test('cardModel Ready -> "no cost yet" (nothing priced, no fake zero)', () => {
  eq(cardModel(ticketReady, NOW).cost, 'no cost yet');
});

await test('cardModel no children -> "no cost yet" (not "unknown", not "$0")', () => {
  eq(cardModel({ stage: 'dev', childCount: 0, cost: null }, NOW).cost, 'no cost yet');
  eq(cardModel({ stage: 'dev', childCount: 0, cost: { childrenUsd: null, supervisorUsd: null, totalUsd: 0 } }, NOW).cost, 'no cost yet');
});

await test('cardModel spend without children (supervisor-only) -> money, not "no cost yet"', () => {
  eq(cardModel({ stage: 'dev', childCount: 0, cost: { totalUsd: 2.5 } }, NOW).cost, '$2.50');
});

await test('cardModel non-Ready without cost -> "cost unknown"', () => {
  eq(cardModel({ stage: 'dev', cost: null }, NOW).cost, 'cost unknown');
  eq(cardModel({ stage: 'dev', cost: { childrenUsd: null, supervisorUsd: null, totalUsd: null } }, NOW).cost, 'cost unknown');
  eq(cardModel({ stage: 'dev' }, NOW).cost, 'cost unknown');
});

// --- costLabel / panelCostLabel --------------------------------------------------

await test('costLabel: priced money, honest $0 with children', () => {
  eq(costLabel({ totalUsd: 37.83 }, 3), '$37.83');
  eq(costLabel({ totalUsd: 0 }, 2), '$0');
  eq(costLabel(null, 5), 'cost unknown');
  eq(costLabel({ totalUsd: null }, 5), 'cost unknown');
  eq(costLabel(null, undefined), 'cost unknown');
});

await test('costLabel nothing spent yet -> "no cost yet"', () => {
  eq(costLabel(null, 0), 'no cost yet');
  eq(costLabel({ totalUsd: null }, 0), 'no cost yet');
  eq(costLabel({ totalUsd: 0 }, 0), 'no cost yet');
});

await test('panelCostLabel: ready -> "no cost yet", no children array -> "no cost yet", priced -> money', () => {
  eq(panelCostLabel({ ticket: { stage: 'ready' }, cost: null, children: [] }), 'no cost yet');
  eq(panelCostLabel({ ticket: { stage: 'dev' }, cost: null, children: [] }), 'no cost yet');
  eq(panelCostLabel({ ticket: { stage: 'dev' }, cost: { totalUsd: 0 }, children: [] }), 'no cost yet');
  eq(
    panelCostLabel({ ticket: { stage: 'dev' }, cost: { childrenUsd: 33.73, supervisorUsd: 4.1, totalUsd: 37.83 }, children: [{ childId: 'c-7' }] }),
    '$37.83',
  );
  eq(panelCostLabel({ ticket: { stage: 'dev' }, cost: null, children: [{ childId: 'c-7' }] }), 'cost unknown');
  eq(panelCostLabel(null), 'cost unknown'); // no ticket loaded — the section is hidden anyway
});

await test('cardModel flag tones: live->running, gate->waiting, needs-you->waiting, crashed->danger', () => {
  const flags = [
    { kind: 'live', text: 'child a live', childId: 'a' },
    { kind: 'gate', text: 'gate open', childId: 'a' },
    { kind: 'needs-you', text: 'answer needed', childId: 'a' },
    { kind: 'crashed', text: 'child exited 1', childId: 'a' },
  ];
  eq(cardModel({ stage: 'dev', flags }, NOW).flags, [
    { text: 'child a live', tone: 'running' },
    { text: 'gate open', tone: 'waiting' },
    { text: 'answer needed', tone: 'waiting' },
    { text: 'child exited 1', tone: 'danger' },
  ]);
});

await test('cardModel flag without text -> kind fallback (text always present)', () => {
  eq(cardModel({ stage: 'dev', flags: [{ kind: 'crashed' }, { kind: 'needs-you' }] }, NOW).flags, [
    { text: 'child crashed', tone: 'danger' },
    { text: 'needs you', tone: 'waiting' },
  ]);
  eq(cardModel({ stage: 'dev', flags: [{ kind: 'mystery' }] }, NOW).flags, [
    { text: 'flag', tone: 'neutral' },
  ]);
});

await test('cardModel age: just now, hours, days; missing/bad date -> null', () => {
  eq(cardModel({ stage: 'dev', lastActivityAt: ago(30_000) }, NOW).age, 'updated just now');
  eq(cardModel({ stage: 'dev', lastActivityAt: ago(3 * 3600_000) }, NOW).age, 'updated 3 h ago');
  eq(cardModel({ stage: 'dev', lastActivityAt: ago(2 * 86400_000) }, NOW).age, 'updated 2 d ago');
  eq(cardModel({ stage: 'dev', lastActivityAt: null }, NOW).age, null);
  eq(cardModel({ stage: 'dev', lastActivityAt: 'not-a-date' }, NOW).age, null);
});

await test('cardModel(null) -> empty id/title, no stage label, cost null', () => {
  eq(cardModel(null, NOW), {
    id: null,
    title: '',
    stageLabel: null,
    labels: [],
    rounds: null,
    cost: null,
    flags: [],
    age: null,
  });
});

// --- ticketLabels / cardModel labels --------------------------------------------

await test('cardModel labels: absent/malformed -> [], nameless dropped, strings normalized', () => {
  eq(cardModel({ stage: 'dev' }, NOW).labels, []);
  eq(cardModel({ stage: 'dev', labels: null }, NOW).labels, []);
  eq(cardModel({ stage: 'dev', labels: 'bug' }, NOW).labels, []);
  eq(cardModel({ stage: 'dev', labels: [{ name: '  ' }, 42, { color: '#fff' }] }, NOW).labels, []);
  eq(cardModel({ stage: 'dev', labels: ['queue-name', { id: 'l', name: ' x ', color: 'red' }] }, NOW).labels, [
    { id: null, name: 'queue-name', color: null },
    { id: 'l', name: 'x', color: null },
  ]);
});

await test('cardModel labels: only hex colors survive client-side validation', () => {
  const labels = [
    { id: 'a', name: 'ok', color: '#00ccff' },
    { id: 'b', name: 'short', color: '#ab' },
    { id: 'c', name: 'word', color: 'rebeccapurple' },
    { id: 'd', name: 'url', color: 'url(#x)' },
  ];
  eq(cardModel({ stage: 'dev', labels }, NOW).labels, [
    { id: 'a', name: 'ok', color: '#00ccff' },
    { id: 'b', name: 'short', color: null },
    { id: 'c', name: 'word', color: null },
    { id: 'd', name: 'url', color: null },
  ]);
});

await test('ticketLabels caps at 20 (the payload\'s own cap)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: 'l' + i }));
  eq(ticketLabels(many).length, 20);
  eq(ticketLabels(many)[19].name, 'l19');
});

// --- labelNames ------------------------------------------------------------------

await test('labelNames: distinct, sorted across the board; empty board -> []', () => {
  const tickets = [
    { labels: [{ name: 'tech' }, { name: 'bug' }] },
    { labels: ['bug'] },
    { labels: [] },
    { labels: null },
    {},
    null,
    { labels: [{ name: 'access' }] },
  ];
  eq(labelNames(tickets), ['access', 'bug', 'tech']);
  eq(labelNames([]), []);
  eq(labelNames(null), []);
});

// --- formatMoney (the scripts/ticket-cost.mjs usd() rule) ---------------------

await test('formatMoney null/NaN/non-number -> "unknown"', () => {
  eq(formatMoney(null), 'unknown');
  eq(formatMoney(undefined), 'unknown');
  eq(formatMoney(NaN), 'unknown');
  eq(formatMoney('12.34'), 'unknown');
});

await test('formatMoney 0 -> "$0"', () => {
  eq(formatMoney(0), '$0');
});

await test('formatMoney >= 0.01 -> two decimals', () => {
  eq(formatMoney(12.34), '$12.34');
  eq(formatMoney(0.01), '$0.01');
  eq(formatMoney(568), '$568.00');
  eq(formatMoney(4.1), '$4.10');
});

await test('formatMoney sub-cent -> 2 significant digits (same rule as the CLI)', () => {
  eq(formatMoney(0.000021), '$0.000021');
  eq(formatMoney(0.00045), '$0.00045');
  eq(formatMoney(0.00000045), '$0.00000045');
  eq(formatMoney(0.0042), '$0.0042');
});

// --- staleLabel ----------------------------------------------------------------

await test('staleLabel state computing -> "computing…"', () => {
  eq(staleLabel({ computedAt: null, stale: false, state: 'computing' }, NOW), 'computing…');
  eq(staleLabel({ state: 'computing' }, NOW), 'computing…');
});

await test('staleLabel stale -> "stale — 12 min old"', () => {
  eq(staleLabel({ computedAt: ago(12 * 60_000), stale: true, state: 'ok' }, NOW), 'stale — 12 min old');
  eq(staleLabel({ computedAt: ago(7 * 60_000), stale: true, state: 'ok' }, NOW), 'stale — 7 min old');
});

await test('staleLabel fresh -> "updated 2 min ago" / just now', () => {
  eq(staleLabel({ computedAt: ago(2 * 60_000), stale: false, state: 'ok' }, NOW), 'updated 2 min ago');
  eq(staleLabel({ computedAt: ago(30_000), stale: false, state: 'ok' }, NOW), 'updated just now');
});

await test('staleLabel error state with a last good computedAt -> "stale — N min old (refresh failed)"', () => {
  eq(
    staleLabel({ computedAt: ago(12 * 60_000), stale: false, state: 'error' }, NOW),
    'stale — 12 min old (refresh failed)',
  );
  eq(
    staleLabel({ computedAt: ago(3 * 60_000), stale: true, state: 'error' }, NOW),
    'stale — 3 min old (refresh failed)',
  );
});

await test('staleLabel error state and missing computedAt -> "unavailable"', () => {
  eq(staleLabel({ computedAt: null, stale: false, state: 'error' }, NOW), 'unavailable');
  eq(staleLabel({}, NOW), 'unavailable');
  eq(staleLabel(null, NOW), 'unavailable');
});

// --- timelineRows ---------------------------------------------------------------

await test('timelineRows(null/missing timeline) -> []', () => {
  eq(timelineRows(null), []);
  eq(timelineRows({}), []);
  eq(timelineRows({ ticket: {} }), []);
});

await test('timelineRows keeps at/kind/childId/runId and text', () => {
  const detail = {
    timeline: [
      { at: '2026-10-13T10:00:00Z', kind: 'spawn', text: 'dev child c-7 spawned', childId: 'c-7', runId: 'run-9' },
      { at: '2026-10-13T11:00:00Z', kind: 'verdict', text: 'round 1 PASS', childId: null, runId: 'run-9' },
    ],
  };
  eq(timelineRows(detail), [
    { at: '2026-10-13T10:00:00Z', kind: 'spawn', text: 'dev child c-7 spawned', childId: 'c-7', runId: 'run-9' },
    { at: '2026-10-13T11:00:00Z', kind: 'verdict', text: 'round 1 PASS', childId: null, runId: 'run-9' },
  ]);
});

await test('timelineRows entry without text -> kind fallback, never an empty row', () => {
  eq(timelineRows({ timeline: [{ at: '2026-10-13T10:00:00Z', kind: 'exit' }, { kind: 'answer' }] }), [
    { at: '2026-10-13T10:00:00Z', kind: 'exit', text: 'child exited', childId: null, runId: null },
    { at: null, kind: 'answer', text: 'answer', childId: null, runId: null },
  ]);
});

// --- evidenceRows -----------------------------------------------------------------

await test('evidenceRows href row -> link (no path, not copyable)', () => {
  const detail = {
    evidence: [{ kind: 'run', label: 'Run run-9', href: '/runs/run-9', path: null }],
  };
  eq(evidenceRows(detail), [
    { kind: 'run', label: 'Run run-9', href: '/runs/run-9', path: null, copyable: false },
  ]);
});

await test('evidenceRows path without href -> copyable text', () => {
  const detail = {
    evidence: [{ kind: 'tee', label: 'Child tee c-7', href: null, path: '/state/run-9/tee/c-7.log' }],
  };
  eq(evidenceRows(detail), [
    { kind: 'tee', label: 'Child tee c-7', href: null, path: '/state/run-9/tee/c-7.log', copyable: true },
  ]);
});

await test('evidenceRows missing label -> kind fallback; null detail -> []', () => {
  eq(evidenceRows({ evidence: [{ kind: 'branch', href: null, path: null }] }), [
    { kind: 'branch', label: 'branch', href: null, path: null, copyable: false },
  ]);
  eq(evidenceRows(null), []);
});

// --- reconciliationText -------------------------------------------------------------

await test('reconciliationText full -> "Children: transcripts $1.20 · telemetry $1.19 (0.99×)"', () => {
  eq(
    reconciliationText({ transcriptUsd: 1.2, telemetryUsd: 1.19, registryUsd: 2.4, ratio: 0.99, note: null }),
    'Children: transcripts $1.20 · telemetry $1.19 (0.99×)',
  );
});

await test('reconciliationText null/empty -> "not reconciled yet"', () => {
  eq(reconciliationText(null), 'not reconciled yet');
  eq(reconciliationText(undefined), 'not reconciled yet');
  eq(reconciliationText({}), 'not reconciled yet');
  eq(reconciliationText({ transcriptUsd: null, telemetryUsd: null, ratio: null }), 'not reconciled yet');
});

await test('reconciliationText without ratio -> no (…×) part', () => {
  eq(
    reconciliationText({ transcriptUsd: 2.0, telemetryUsd: null, registryUsd: null, ratio: null }),
    'Children: transcripts $2.00 · telemetry unknown',
  );
});

await test('reconciliationText note -> appended after an em dash', () => {
  eq(
    reconciliationText({ transcriptUsd: 1.2, telemetryUsd: 1.2, ratio: 1, note: 'legacy rows present' }),
    'Children: transcripts $1.20 · telemetry $1.20 (1.00×) — legacy rows present',
  );
});

// --- filters round-trip --------------------------------------------------------------

await test('filtersFromQuery reads milestone, priority and label', () => {
  eq(filtersFromQuery('?milestone=Dashboard+v2&priority=high&label=bug'), {
    milestone: 'Dashboard v2',
    priority: 'high',
    label: 'bug',
  });
});

await test('filtersFromQuery absent/empty values -> null', () => {
  eq(filtersFromQuery(''), { milestone: null, priority: null, label: null });
  eq(filtersFromQuery('?other=1'), { milestone: null, priority: null, label: null });
  eq(filtersFromQuery('?milestone=&priority=&label='), { milestone: null, priority: null, label: null });
  eq(filtersFromQuery(null), { milestone: null, priority: null, label: null });
});

await test('queryFromFilters writes milestone then priority then label, omits nulls', () => {
  eq(queryFromFilters({ milestone: 'M1', priority: 'high', label: 'bug' }), '?milestone=M1&priority=high&label=bug');
  eq(queryFromFilters({ milestone: 'M1', priority: null }), '?milestone=M1');
  eq(queryFromFilters({ priority: 'high', label: 'bug' }), '?priority=high&label=bug');
  eq(queryFromFilters({ label: 'needs:answer' }), '?label=needs%3Aanswer');
  eq(queryFromFilters({}), '');
  eq(queryFromFilters(null), '');
});

await test('filters round-trip: queryFromFilters(filtersFromQuery(q)) -> q', () => {
  for (const q of ['?milestone=M1&priority=high', '?priority=2', '?milestone=Sprint+1', '?label=bug', '?milestone=M1&label=tech']) {
    eq(queryFromFilters(filtersFromQuery(q)), q);
  }
});

// --- startDialogModel -----------------------------------------------------------------

const preview = {
  text: 'Start ticket FOC-123: Fix the widget\n\nIssue body…',
  issue: { identifier: 'FOC-123', title: 'Fix the widget', url: 'https://linear.example/issue/FOC-123' },
  delivery: 'supervisor',
};

await test('startDialogModel supervisor preview -> Send to the Supervisor, enabled', () => {
  eq(startDialogModel(preview, {}), {
    title: 'Start FOC-123',
    text: preview.text,
    primaryLabel: 'Send to the Supervisor',
    disabled: false,
    disabledReason: null,
    resultText: null,
  });
});

await test('startDialogModel cockpit delivery -> Open in Cockpit', () => {
  eq(startDialogModel({ ...preview, delivery: 'cockpit' }, {}).primaryLabel, 'Open in Cockpit');
  // A missing delivery defaults to the supervisor path.
  eq(startDialogModel({ text: 'x', issue: preview.issue }, {}).primaryLabel, 'Send to the Supervisor');
});

await test('startDialogModel while sending -> disabled with reason', () => {
  eq(startDialogModel(preview, { sending: true }).disabled, true);
  eq(startDialogModel(preview, { sending: true }).disabledReason, 'Sending…');
});

await test('startDialogModel sent -> "Sent — the Supervisor has it", button stays off', () => {
  const m = startDialogModel(preview, { result: { sent: true, confirmed: true, queued: false } });
  eq(m.resultText, 'Sent — the Supervisor has it');
  eq(m.disabled, true);
  eq(m.disabledReason, 'Already sent.');
});

await test('startDialogModel queued -> "Queued"', () => {
  eq(startDialogModel(preview, { result: { sent: false, confirmed: false, queued: true } }).resultText, 'Queued');
  eq(startDialogModel(preview, { result: { sent: false, confirmed: false, queued: true } }).disabledReason, 'Already sent.');
});

await test('startDialogModel error -> the error text is the result text, retry allowed', () => {
  const m = startDialogModel(preview, { error: 'The session host is not reachable.' });
  eq(m.resultText, 'The session host is not reachable.');
  eq(m.disabled, false);
  eq(m.disabledReason, null);
});

await test('startDialogModel no preview -> disabled, no button label', () => {
  eq(startDialogModel(null, {}), {
    title: 'Start a ticket',
    text: null,
    primaryLabel: '',
    disabled: true,
    disabledReason: 'No ticket selected.',
    resultText: null,
  });
});

await test('startDialogModel no preview while loading -> "Loading…", not "No ticket selected."', () => {
  const m = startDialogModel(null, { loading: true });
  eq(m.disabled, true);
  eq(m.disabledReason, 'Loading…');
  eq(m.primaryLabel, '');
  eq(m.text, null);
});

// --- publishDialogModel (FOC-788: Push branch / Open PR confirm) -----------

const publishPreviewPush = {
  ticket: 'FOC-788',
  action: 'push',
  checkout: {
    branch: 'foc-788-push-pr-from-dashboard-1a2b3c4d5e6f',
    remote: 'origin',
    remoteUrl: 'https://github.com/joint-hubs/linear-agents',
    base: 'main',
    head: '9f458fb0123456789012345678901234567890ab',
  },
  diff: { commits: 18, files: 12, insertions: 101, deletions: 2, commitSubjects: ['work'], dirty: false },
  checks: { latest: 'PASS', failing: [], verdicts: [{ round: 1, verdict: 'PASS' }], children: [] },
  confirmToken: 'a'.repeat(64),
};

// An error shaped like api.js throws it: message + .data carrying the
// server's error name (and the scrubbed detail when there is one).
function apiError(error, detail) {
  const e = new Error(detail ? `${error}: ${detail}` : error);
  e.data = detail ? { error, detail } : { error };
  return e;
}

await test('publishDialogModel push preview -> Push branch to origin, diff summary, You', () => {
  const m = publishDialogModel(publishPreviewPush, 'push', {});
  eq(m.primaryLabel, 'Push branch');
  eq(m.title, 'Push the task branch');
  eq(m.branchText, 'foc-788-push-pr-from-dashboard-1a2b3c4d5e6f');
  eq(m.targetText, 'origin');
  eq(m.diffText, '18 commit(s), 12 file(s), +101/-2');
  eq(m.checksFailed, false);
  eq(m.actorText, 'You');
  eq(m.disabled, false);
});

await test('publishDialogModel pr preview -> Open PR into main', () => {
  const m = publishDialogModel(publishPreviewPush, 'pr', {});
  eq(m.primaryLabel, 'Open PR');
  eq(m.title, 'Open a pull request');
  eq(m.targetText, 'main');
});

await test('publishDialogModel dirty worktree -> the diff line says the changes are not pushed', () => {
  const m = publishDialogModel(
    { ...publishPreviewPush, diff: { ...publishPreviewPush.diff, dirty: true } }, 'push', {},
  );
  eq(m.diffText.includes('uncommitted changes in the worktree (not pushed)'), true);
});

await test('publishDialogModel failing checks (AC-2) -> shown first and prominent, never blocking', () => {
  const m = publishDialogModel({
    ...publishPreviewPush,
    checks: {
      latest: 'FAIL',
      failing: [{ round: 1, verdict: 'FAIL' }, { round: 2, verdict: 'FAIL' }],
      verdicts: [],
      children: [],
    },
  }, 'push', {});
  eq(m.checksFailed, true);
  eq(m.checksLines, ['round 1: FAIL', 'round 2: FAIL']);
  eq(m.checksLatest, 'FAIL');
  eq(m.disabled, false, 'a failing check is shown, not hard-blocking (the AC says shown)');
});

await test('publishDialogModel while sending -> disabled with the action word', () => {
  eq(publishDialogModel(publishPreviewPush, 'push', { sending: true }).disabledReason, 'Pushing…');
  eq(publishDialogModel(publishPreviewPush, 'pr', { sending: true }).disabledReason, 'Opening…');
});

await test('publishDialogModel pushed -> "Pushed <head7>", button stays off', () => {
  const m = publishDialogModel(publishPreviewPush, 'push', {
    result: { ok: true, action: 'push', actor: 'human', head: '9f458fb0123456789012345678901234567890ab' },
  });
  eq(m.resultText, 'Pushed 9f458fb');
  eq(m.disabled, true);
  eq(m.disabledReason, 'Already done.');
});

await test('publishDialogModel pr opened -> the PR URL is the result text', () => {
  const m = publishDialogModel(publishPreviewPush, 'pr', {
    result: { ok: true, action: 'pr', actor: 'human', head: 'x', prUrl: 'https://github.com/joint-hubs/linear-agents/pull/7' },
  });
  eq(m.resultText, 'PR opened: https://github.com/joint-hubs/linear-agents/pull/7');
});

await test('publishDialogModel stale-preview -> spelled out with a refresh offered', () => {
  const m = publishDialogModel(publishPreviewPush, 'push', {
    error: apiError('stale-preview', 'the confirm does not match the current checkout state — preview again'),
  });
  eq(m.resultText, 'The checkout changed since the preview — preview again.');
  eq(m.stale, true);
});

await test('publishDialogModel push-refused / pr-failed -> named with the scrubbed detail', () => {
  const refused = publishDialogModel(publishPreviewPush, 'push', {
    error: apiError('push-refused', 'non-fast-forward'),
  });
  eq(refused.resultText, 'Push refused: non-fast-forward');
  const prFailed = publishDialogModel(publishPreviewPush, 'pr', {
    error: apiError('pr-failed', 'GitHub 422: Validation Failed'),
  });
  eq(prFailed.resultText, 'Could not open the PR: GitHub 422: Validation Failed');
});

await test('publishDialogModel no-checkout error -> nothing to publish', () => {
  const m = publishDialogModel(publishPreviewPush, 'push', { error: apiError('no-checkout') });
  eq(m.resultText, 'No checkout for this ticket — nothing to publish.');
});

await test('publishDialogModel no preview -> disabled; loading says Loading…, not the no-checkout text', () => {
  eq(publishDialogModel(null, 'push', {}).disabledReason, 'No checkout — nothing to publish.');
  const loading = publishDialogModel(null, 'push', { loading: true });
  eq(loading.disabled, true);
  eq(loading.disabledReason, 'Loading…');
});

// --- claimTag (FOC-902 §E: the claimed-by tag) -------------------------------

await test('claimTag: present -> 12-char short and the full hover title with the status', () => {
  const tag = claimTag({ claimedBy: { sessionId: 'sup-abcdef1234567890', status: 'running', live: true } });
  eq(tag.short, 'sup-abcdef12');
  eq(tag.title, 'claimed by sup-abcdef1234567890 (running)');
});

await test('claimTag: missing status still names the session; malformed or absent -> null', () => {
  eq(claimTag({ claimedBy: { sessionId: 'sup-abcdef1234567890' } }).title, 'claimed by sup-abcdef1234567890');
  eq(claimTag({ claimedBy: { sessionId: '', status: 'running' } }), null);
  eq(claimTag({ claimedBy: null }), null);
  eq(claimTag({}), null);
  eq(claimTag(null), null);
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);