// TaskMap model tests (P4) — plain-node harness, same style as the other
// _tests_*.mjs files: no framework, a check() counter, process.exit(1) on the
// first failure list. Everything here is pure (taskMapModel.js) — no DOM, no
// fetch, no Vite.
//
// Run: node ui/src/_tests_taskMap.mjs

import {
  REBUILD_WARNING,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_UNKNOWN,
  STAGE_ORDER,
  cockpitHref,
  corpusSummary,
  formatDuration,
  formatMoney,
  isPolygonShape,
  jobStatusText,
  neighborsModel,
  pointRadius,
  polygonPoints,
  projectionSummary,
  radiusDomain,
  radiusModeLabel,
  scatterLayout,
  stageColorVar,
  stageLabel,
  stageMarker,
  taskMapFiltersFromQuery,
  taskMapNeighborsUrl,
  taskMapQuery,
  unembeddedText,
} from './taskMapModel.js';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

// ── taskMapQuery ─────────────────────────────────────────────────────────────

eq('query: empty filters -> empty string', taskMapQuery({}), '');
eq('query: null filters -> empty string', taskMapQuery(null), '');
eq('query: stage only', taskMapQuery({ stage: 'dev' }), '?stage=dev');
eq('query: cost radius omitted (default)', taskMapQuery({ radius: 'cost' }), '');
eq(
  'query: all fields',
  taskMapQuery({ stage: 'dev', label: 'bug', radius: 'time' }),
  '?stage=dev&label=bug&radius=time',
);
eq('query: null fields skipped', taskMapQuery({ stage: null, label: null, radius: null }), '');

// ── taskMapFiltersFromQuery ──────────────────────────────────────────────────

eq(
  'fromQuery: empty string -> defaults',
  taskMapFiltersFromQuery(''),
  { stage: null, label: null, radius: 'cost' },
);
eq('fromQuery: null-safe on the whole query', taskMapFiltersFromQuery(null), {
  stage: null,
  label: null,
  radius: 'cost',
});
eq(
  'fromQuery: parses stage and radius',
  taskMapFiltersFromQuery('?stage=dev&radius=time'),
  { stage: 'dev', label: null, radius: 'time' },
);
eq(
  'fromQuery: unknown radius falls back to cost',
  taskMapFiltersFromQuery('?radius=banana').radius,
  'cost',
);
eq('fromQuery: blank value -> null', taskMapFiltersFromQuery('?stage=%20').stage, null);

// Round-trip: filters -> query -> filters is the identity.
for (const f of [
  { stage: 'dev', label: 'bug', radius: 'time' },
  { stage: null, label: 'x', radius: 'cost' },
  { stage: 'landed', label: null, radius: 'cost' },
]) {
  eq(
    `round-trip ${JSON.stringify(f)}`,
    taskMapFiltersFromQuery(taskMapQuery(f)),
    { stage: f.stage ?? null, label: f.label ?? null, radius: f.radius },
  );
}

// ── URLs ─────────────────────────────────────────────────────────────────────

eq(
  'neighborsUrl: encodes the taskKey once',
  taskMapNeighborsUrl('jointhubs:WORK 1'),
  '/api/task-map/neighbors?taskKey=jointhubs%3AWORK%201',
);
eq(
  'neighborsUrl: limit appended when an integer >= 1',
  taskMapNeighborsUrl('a:B', 5),
  '/api/task-map/neighbors?taskKey=a%3AB&limit=5',
);
eq(
  'neighborsUrl: no limit when absent/invalid',
  taskMapNeighborsUrl('a:B', 0),
  '/api/task-map/neighbors?taskKey=a%3AB',
);
eq(
  'neighborsUrl: null taskKey still a valid query',
  taskMapNeighborsUrl(null),
  '/api/task-map/neighbors?taskKey=',
);
eq(
  'cockpitHref: the exact encoded cockpit path',
  cockpitHref('jointhubs:WORK-1'),
  '/work/jointhubs%3AWORK-1/cockpit',
);

// ── radius ───────────────────────────────────────────────────────────────────

const PTS = [
  { taskKey: 'w:A', costUsd: 1, durationMs: 1000 },
  { taskKey: 'w:B', costUsd: 100, durationMs: 64000 },
  { taskKey: 'w:C', costUsd: null, durationMs: null },
  { taskKey: 'w:D', costUsd: -5, durationMs: 0 }, // never counted
];
eq('radiusDomain(cost): min/max over positive values', radiusDomain(PTS, 'cost'), { min: 1, max: 100 });
eq('radiusDomain(time): reads durationMs', radiusDomain(PTS, 'time'), { min: 1000, max: 64000 });
eq('radiusDomain: null with nothing known', radiusDomain([{ costUsd: null }], 'cost'), null);
eq('radiusDomain: null-safe on a non-array', radiusDomain(null, 'cost'), null);

const DOM = { min: 1, max: 100 };
eq('pointRadius: min value -> RADIUS_MIN', pointRadius(PTS[0], 'cost', DOM), RADIUS_MIN);
eq('pointRadius: max value -> RADIUS_MAX', pointRadius(PTS[1], 'cost', DOM), RADIUS_MAX);
eq('pointRadius: unknown -> RADIUS_UNKNOWN', pointRadius(PTS[2], 'cost', DOM), RADIUS_UNKNOWN);
eq('pointRadius: null point -> RADIUS_UNKNOWN', pointRadius(null, 'cost', DOM), RADIUS_UNKNOWN);
check(
  'pointRadius: sqrt scale — the sqrt-midpoint value lands at the radius midpoint',
  Math.abs(pointRadius({ costUsd: 30.25 }, 'cost', DOM) - (RADIUS_MIN + RADIUS_MAX) / 2) < 0.01,
);
eq(
  'pointRadius: a single known value IS the maximum',
  pointRadius({ costUsd: 42 }, 'cost', { min: 42, max: 42 }),
  RADIUS_MAX,
);
eq('radiusModeLabel(cost)', radiusModeLabel('cost'), 'size = cost');
eq('radiusModeLabel(time)', radiusModeLabel('time'), 'size = agent time');

// ── scatterLayout ────────────────────────────────────────────────────────────

const flat = scatterLayout([{ x: 2, y: 3 }], { width: 100, height: 100, padding: 10 });
eq('layout: a single point centres on both axes', [flat.items[0].cx, flat.items[0].cy], [50, 50]);

const two = scatterLayout(
  [
    { taskKey: 'a', x: 0, y: 0 },
    { taskKey: 'b', x: 10, y: 10 },
  ],
  { width: 120, height: 120, padding: 10 },
);
eq('layout: minX maps to the left padding', two.items[0].cx, 10);
eq('layout: maxX maps to width - padding', two.items[1].cx, 110);
check(
  'layout: the y axis is inverted (a larger y lands higher on screen)',
  two.items[1].cy < two.items[0].cy,
);
check(
  'layout: every point stays inside the padded viewport',
  two.items.every((i) => i.cx >= 10 && i.cx <= 110 && i.cy >= 10 && i.cy <= 110),
);
eq('layout: flat y axis centres', scatterLayout([{ x: 0, y: 5 }, { x: 10, y: 5 }], { width: 100, height: 100, padding: 10 }).items[0].cy, 50);
eq(
  'layout: points without finite x/y are skipped (nothing invented)',
  scatterLayout([{ x: 0, y: 0 }, { x: null, y: 1 }, { x: 1, y: 'NaN' }], {}).items.length,
  1,
);
eq('layout: empty/null input', scatterLayout(null, {}).items.length, 0);
const order = scatterLayout(
  [
    { taskKey: 'z', x: 1, y: 1 },
    { taskKey: 'a', x: 2, y: 2 },
  ],
  {},
);
eq('layout: deterministic, input order preserved', order.items.map((i) => i.taskKey), ['z', 'a']);

// ── shapes ───────────────────────────────────────────────────────────────────

eq('markers: fixed stage order covers six stages', STAGE_ORDER.length, 6);
eq('marker: ready is a circle', stageMarker('ready'), 'circle');
eq('marker: landed is a ring', stageMarker('landed'), 'ring');
eq('marker: unknown stage falls back safely', stageMarker('nope'), 'circle');
eq('label: unknown stage passes the raw value through (honest, never a crash)', stageLabel('nope'), 'nope');
eq('label: null -> Unknown', stageLabel(null), 'Unknown');
eq('color var: known stage', stageColorVar('dev'), 'var(--tm-stage-dev)');
eq('color var: unknown stage', stageColorVar('nope'), 'var(--tm-stage-unknown)');
check('isPolygonShape: circle is not a polygon', !isPolygonShape('circle'));
check('isPolygonShape: diamond is', isPolygonShape('diamond'));

eq('polygon: square has 4 vertices', polygonPoints('square', 10, 10, 5).length, 4);
eq('polygon: triangle-up has 3', polygonPoints('triangle-up', 0, 0, 4).length, 3);
eq('polygon: circle -> null (renders as <circle>)', polygonPoints('circle', 0, 0, 4), null);
eq('polygon: non-finite center -> null', polygonPoints('square', NaN, 0, 4), null);

// ── projection / job / corpus summaries ─────────────────────────────────────

eq('projection: null -> not available', projectionSummary(null).text, 'no projection yet');
eq(
  'projection: unavailable keeps the last error',
  projectionSummary({ available: false, lastError: 'boom' }).detail,
  'the last build could not fit a projection: boom',
);
const pca = projectionSummary({ available: true, kind: 'pca', version: 1 }, { ready: 3 });
check('projection: PCA is labelled tiny', pca.tiny === true && /PCA/.test(pca.text));
const listy = projectionSummary({ available: true, kind: 'list', version: 1 }, { ready: 1 });
check('projection: list fallback is labelled tiny', listy.tiny === true && /list/.test(listy.text));
const umap = projectionSummary(
  { available: true, kind: 'umap', version: 7, params: { seed: 42, nNeighbors: 15 } },
  { ready: 120 },
);
check('projection: UMAP names the version and seed', /UMAP v7/.test(umap.text) && /seed 42/.test(umap.detail));
eq('projection: UMAP is not tiny', umap.tiny, false);

check('unembedded: known reason maps to its text', unembeddedText('not_embedded').includes('Build / update embeddings'));
check('unembedded: known reason is informative', unembeddedText('embed_failed').length > 10);
check('unembedded: unknown reason is quoted, never dropped', unembeddedText('weird').includes('weird'));
eq('unembedded: null reason -> plain unavailable', unembeddedText(null), 'unavailable');

eq('job: null -> never built', jobStatusText(null).text, 'never built');
eq('job: running tone', jobStatusText({ state: 'running' }).tone, 'building');
eq(
  'job: error carries the sanitized message',
  jobStatusText({ state: 'error', error: { message: 'embed_failed' } }).text,
  'last build failed — embed_failed',
);
check(
  'job: done shows a trimmed timestamp',
  jobStatusText({ state: 'done', finishedAt: '2026-10-14T10:11:12.000Z' }).text.includes('2026-10-14 10:11:12'),
);

eq('corpus: null -> null', corpusSummary(null), null);
check('corpus: names the workspace and count', /corpus: 3 tickets from jointhubs/.test(corpusSummary({ workspace: 'jointhubs', included: 3 })));
check('corpus: truncated mentions the cap', corpusSummary({ workspace: 'w', included: 200, truncated: true, cap: 200 }).includes('capped at 200'));
check('corpus: unavailable counted', corpusSummary({ workspace: 'w', included: 1, unavailable: 2 }).includes('2 unavailable'));

check('REBUILD_WARNING says coordinates change', /NEW coordinates/.test(REBUILD_WARNING));
check('REBUILD_WARNING says filters never refit', /Filters never refit/.test(REBUILD_WARNING));

// ── durations / money / neighbors ────────────────────────────────────────────

eq('duration: 45 s', formatDuration(45000), '45 s');
eq('duration: 12 min', formatDuration(720000), '12 min');
eq('duration: 1 h 05 min', formatDuration(3900000), '1 h 05 min');
eq('duration: exact hour', formatDuration(3600000), '1 h');
eq('duration: null -> null', formatDuration(null), null);
eq('duration: zero -> null', formatDuration(0), null);

eq('money re-export: null -> unknown', formatMoney(null), 'unknown');
eq('money re-export: dollars', formatMoney(1.5), '$1.50');

eq(
  'neighbors: passthrough with rounded similarity',
  neighborsModel({ taskKey: 'w:A', neighbors: [{ taskKey: 'w:B', similarity: 0.8765, title: 'T' }, { nope: 1 }] }),
  { taskKey: 'w:A', rows: [{ taskKey: 'w:B', taskId: null, title: 'T', similarityPct: 87.7 }] },
);
eq('neighbors: null-safe', neighborsModel(null), { taskKey: null, rows: [] });
eq('neighbors: missing array -> empty rows', neighborsModel({}).rows, []);

// ── done ─────────────────────────────────────────────────────────────────────

console.log(`taskMapModel: ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('FAIL: ' + f);
  process.exit(1);
}
