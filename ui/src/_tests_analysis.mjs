// Unit tests for the Analysis screen's pure helpers (FOC-397 analysis
// dashboard). Self-contained Node ESM script — NO test framework, NO deps.
// Runs on Node >= 18. Invoke via: `npm --prefix ui test`.
//
// Scope: analysis/export.js (toCsv) and analysis/query.js (the query-string
// builder behind getAnalysisPanel) are pure JS and import fully. The React
// components and api.js are NOT importable under plain node (JSX /
// import.meta.env) — those stay covered by the Vite build.

import assert from 'node:assert/strict';

import { toCsv, toJson } from './screens/analysis/export.js';
import { buildAnalysisQuery } from './screens/analysis/query.js';
import { rowsToObjects } from './screens/analysis/rows.js';

// --- Minimal test harness (same shape as _tests_rewards.mjs) ------------------

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

// --- toCsv: quoting -------------------------------------------------------------

await test('toCsv quotes fields containing comma, quote, CR or LF (RFC 4180)', () => {
  eq(
    toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2', d: 'cr\r' }]),
    'a,b,c,d\r\n"x,y","he said ""hi""","line1\nline2","cr\r"',
  );
});

await test('toCsv leaves plain fields unquoted', () => {
  eq(toCsv([{ a: 'plain', b: 12, c: true }]), 'a,b,c\r\nplain,12,true');
});

await test('toCsv: null and undefined become empty cells', () => {
  eq(toCsv([{ a: null, b: undefined, c: 1 }], ['a', 'b', 'c']), 'a,b,c\r\n,,1');
  // Keys with null/undefined values still exist on the row, so the key-union
  // header keeps them (first-seen order) with empty cells below.
  eq(toCsv([{ a: null, b: undefined, c: 1 }]), 'a,b,c\r\n,,1');
  // A key absent from every row never appears in the union.
  eq(toCsv([{ a: 1 }]), 'a\r\n1');
});

await test('toCsv: objects serialize to their JSON string (then get quoted)', () => {
  eq(toCsv([{ a: { x: 1 } }, { a: [1, 2] }]), 'a\r\n"{""x"":1}"\r\n"[1,2]"');
});

await test('toCsv: column union of ragged rows in first-seen order', () => {
  eq(
    toCsv([{ a: 1, b: 2 }, { c: 3, a: 4 }]),
    'a,b,c\r\n1,2,\r\n4,,3',
  );
});

await test('toCsv: explicit columns take precedence over the key union', () => {
  eq(toCsv([{ a: 1, b: 2, c: 3 }], ['b', 'a']), 'b,a\r\n2,1');
});

await test('toCsv: missing cells under explicit columns are empty, not undefined', () => {
  eq(toCsv([{ a: 1 }], ['a', 'zzz']), 'a,zzz\r\n1,');
});

await test('toCsv: empty / non-array rows degrade to a header-only (or bare) document', () => {
  eq(toCsv([]), '');
  eq(toCsv(null), '');
});

await test('toCsv: CRLF line breaks regardless of platform', () => {
  eq(toCsv([{ a: 1 }, { a: 2 }]), 'a\r\n1\r\n2');
});

// --- toJson ----------------------------------------------------------------------

await test('toJson is pretty-printed with 2-space indent', () => {
  eq(toJson({ a: [1, 2] }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
});

// --- buildAnalysisQuery -----------------------------------------------------------

await test('buildAnalysisQuery: no filters -> empty string (no bare "?")', () => {
  eq(buildAnalysisQuery(), '');
  eq(buildAnalysisQuery({}), '');
  eq(buildAnalysisQuery(null), '');
});

await test('buildAnalysisQuery: empty values are omitted', () => {
  eq(
    buildAnalysisQuery({ from: '', to: null, squad: undefined, model: '', era: 'post', eraBoundary: '' }),
    '?era=post',
  );
  // An empty eraBoundary is the "use the server's default" state — it must
  // never serialize as a literal empty param.
  eq(buildAnalysisQuery({ era: 'pre', eraBoundary: '' }), '?era=pre');
});

await test('buildAnalysisQuery: known keys serialize in from,to,squad,model,era,eraBoundary order', () => {
  eq(
    buildAnalysisQuery({ era: 'all', model: 'm', squad: 's', to: '2026-09-26', from: '2026-08-27', eraBoundary: '2026-03-01' }),
    '?from=2026-08-27&to=2026-09-26&squad=s&model=m&era=all&eraBoundary=2026-03-01',
  );
});

await test('buildAnalysisQuery: eraBoundary override passes through to the panels', () => {
  eq(buildAnalysisQuery({ eraBoundary: '2026-03-01' }), '?eraBoundary=2026-03-01');
});

await test('buildAnalysisQuery: values are URL-encoded (slash in model ids)', () => {
  eq(
    buildAnalysisQuery({ model: 'z-ai/glm-5.3', squad: 'orch openrouter' }),
    '?squad=orch%20openrouter&model=z-ai%2Fglm-5.3',
  );
});

await test('buildAnalysisQuery: unknown keys are dropped, not forwarded', () => {
  eq(buildAnalysisQuery({ tab: 'cost', era: 'pre' }), '?era=pre');
});

// --- rows.js: rowsToObjects -----------------------------------------------------

await test('rowsToObjects: plain mapping — positional rows become keyed objects', () => {
  // The exact shape POST /api/analysis/sql answers with.
  eq(
    rowsToObjects(['squad', 'n'], [['dev', 44157], ['supervisor', 27865]]),
    { columns: ['squad', 'n'], rows: [{ squad: 'dev', n: 44157 }, { squad: 'supervisor', n: 27865 }] },
  );
});

await test('rowsToObjects: duplicate column names get unique keys (x, x_2, x_3)', () => {
  // SELECT a.id, b.id — SQLite names both columns "id"; as object keys one
  // would silently overwrite the other.
  const out = rowsToObjects(['id', 'id', 'id'], [[1, 2, 3]]);
  eq(out.columns, ['id', 'id_2', 'id_3']);
  eq(out.rows, [{ id: 1, id_2: 2, id_3: 3 }]);
  // A real x_2 column never collides with a synthesized one: the dup of x
  // takes the first free key (x_2), so the real x_2 shifts to x_2_2 — keys
  // stay unique and every cell lands under its own header.
  const clash = rowsToObjects(['x', 'x', 'x_2'], [[1, 2, 3]]);
  eq(clash.columns, ['x', 'x_2', 'x_2_2']);
  eq(clash.rows, [{ x: 1, x_2: 2, x_2_2: 3 }]);
});

await test('rowsToObjects: empty result keeps the header, rows empty', () => {
  eq(rowsToObjects(['a', 'b'], []), { columns: ['a', 'b'], rows: [] });
  eq(rowsToObjects([], []), { columns: [], rows: [] });
  // Malformed payloads degrade to an empty table instead of crashing the console.
  eq(rowsToObjects(null, null), { columns: [], rows: [] });
});

await test('rowsToObjects: null cells survive as null, keys never dropped', () => {
  // A null cell is a genuine SQL NULL — the key must stay on the row so the
  // header/CSV keep the column and DataTable renders its em dash.
  eq(rowsToObjects(['a', 'b'], [[null, 1]]).rows, [{ a: null, b: 1 }]);
  // Short rows fill missing cells with undefined rather than shifting keys.
  eq(rowsToObjects(['a', 'b'], [['only']]).rows, [{ a: 'only', b: undefined }]);
});

// --- format.js: fmtUsd ---------------------------------------------------------

import { fmtUsd, fmtInt, fmtCompact, fmtPct, fmtMs, topN } from './screens/analysis/format.js';

await test('fmtUsd: >= $100 drops cents and groups thousands', () => {
  eq(fmtUsd(1234.56), '$1,235');
  eq(fmtUsd(1234567.89), '$1,234,568');
  eq(fmtUsd(100), '$100');
});

await test('fmtUsd: < $100 keeps two decimals', () => {
  eq(fmtUsd(84.567), '$84.57');
  eq(fmtUsd(0.01), '$0.01');
  eq(fmtUsd(0), '$0.00');
});

await test('fmtUsd: sub-cent renders as <$0.01, unpriced as em dash', () => {
  eq(fmtUsd(0.001), '<$0.01');
  eq(fmtUsd(null), '—');
  eq(fmtUsd(undefined), '—');
  eq(fmtUsd(Number.NaN), '—');
});

// --- fmtInt / fmtCompact ---------------------------------------------------------

await test('fmtInt: thousands separators, unpriced as em dash', () => {
  eq(fmtInt(1234567), '1,234,567');
  eq(fmtInt(950), '950');
  eq(fmtInt(null), '—');
});

await test('fmtCompact: B / M / k magnitudes with trimmed zeros', () => {
  eq(fmtCompact(6.88e9), '6.88 B');
  eq(fmtCompact(85.3e6), '85.3 M');
  eq(fmtCompact(12400), '12.4 k');
  eq(fmtCompact(950), '950');
  eq(fmtCompact(1e6), '1 M');
  eq(fmtCompact(null), '—');
});

// --- fmtPct / fmtMs ---------------------------------------------------------

await test('fmtPct: 0-100 input by default, 0-1 fraction opt-in', () => {
  eq(fmtPct(84.9), '84.9%');
  eq(fmtPct(0.849, { fraction: true }), '84.9%');
  eq(fmtPct(84), '84%');
  eq(fmtPct(100), '100%');
  eq(fmtPct(null), '—');
});

await test('fmtMs: ms / s / min buckets', () => {
  eq(fmtMs(330), '330 ms');
  eq(fmtMs(4200), '4.2 s');
  eq(fmtMs(186000), '3.1 min');
  eq(fmtMs(null), '—');
});

// --- topN ------------------------------------------------------------------

await test('topN: keeps first n rows desc by key, aggregates the rest as other (k)', () => {
  const rows = [
    { label: 'a', cost: 5 },
    { label: 'b', cost: 3 },
    { label: 'c', cost: 1 },
    { label: 'd', cost: 2 },
  ];
  const out = topN(rows, 'cost', 2);
  eq(out.length, 3);
  eq(out[0].label, 'a');
  eq(out[1].label, 'b');
  eq(out[2].label, 'other (2)');
  eq(out[2].cost, 3); // 1 + 2
});

await test('topN: sums every numeric field present on all remaining rows', () => {
  const rows = [
    { label: 'a', cost: 10, calls: 1 },
    { label: 'b', cost: 8, calls: 2 },
    { label: 'c', cost: 6, calls: 3 },
  ];
  const out = topN(rows, 'cost', 1);
  eq(out.length, 2);
  eq(out[1].label, 'other (2)');
  eq(out[1].cost, 14);
  eq(out[1].calls, 5);
});

await test('topN: no aggregation when n covers all rows; non-finite keys sort last', () => {
  const rows = [
    { label: 'a', v: 1 },
    { label: 'b', v: 9 },
  ];
  eq(topN(rows, 'v', 5).map((r) => r.label), ['b', 'a']);
  eq(topN([{ label: 'a', v: 1 }, { label: 'b' }], 'v', 5).map((r) => r.label), ['a', 'b']);
  eq(topN(null, 'v', 3), []);
});

// --- Summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
