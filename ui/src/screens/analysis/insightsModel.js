// Pure helpers for the three Insights panels (FOC-787 slice B). Node-importable
// (no JSX, no React) like format.js, so _tests_analysis.mjs covers them
// directly. Every helper is null-safe: the panel contracts in
// docs/plans/foc-787-insights-panels.md §2 degrade to '—' / empty arrays,
// never a throw.

import { fmtUsd } from './format.js';

const DASH = '—';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : {});

// /work/<taskId> link target for the taskId cells; null/empty stays null so
// the table cell falls back to the em dash.
export function workLink(taskId) {
  if (taskId == null || taskId === '') return null;
  return `/work/${String(taskId)}`;
}

// Direction chip text ('high'/'low'/'unpriced' in the contract); anything
// else — including a missing field — is the em dash.
export function fmtDirection(d) {
  if (d === 'high') return 'high ▲';
  if (d === 'low') return 'low ▼';
  if (d === 'unpriced') return 'unpriced';
  return DASH;
}

// Column-chart rows from the Tickets panel payload: one row per era with the
// p20/p50/p80 band of `kind` ('direct' | 'loaded'), the bootstrap median CI
// ("$3.90–$5.10") as the secondary text, and the era's task count. Rows keep
// the payload's era order (the server sends pre before post when era=all).
export function eraColumns(payload, kind = 'direct') {
  const eras = (payload && Array.isArray(payload.eras) ? payload.eras : []).filter(
    (e) => e && typeof e === 'object',
  );
  return eras.map((e) => {
    const dist = e[kind] && typeof e[kind] === 'object' ? e[kind] : {};
    const ci =
      isNum(dist.medianCi && dist.medianCi[0]) && isNum(dist.medianCi && dist.medianCi[1])
        ? `${fmtUsd(dist.medianCi[0])}–${fmtUsd(dist.medianCi[1])}`
        : DASH;
    return {
      label: e.era != null ? String(e.era) : DASH,
      p20: num(dist.p20),
      p50: num(dist.p50),
      p80: num(dist.p80),
      ci,
      tasks: num(e.tasks),
    };
  });
}

// StackedBar parts from the Money payload's supervisor allocation: one part
// each for active / adjacent / idle. Missing fields stay null so the chart
// drops them instead of drawing $0 (unpriced is not zero, same as the cost panel).
export function supervisorSplit(money) {
  const s = money && money.supervisor && typeof money.supervisor === 'object' ? money.supervisor : {};
  return [
    { label: 'active', value: num(s.active) },
    { label: 'adjacent', value: num(s.adjacent) },
    { label: 'idle', value: num(s.idle) },
  ];
}

// SVG path strings for the Lorenz curve and the equality diagonal, given
// cumulative [x, y] points in 0..1 and a pixel box. y is flipped (SVG grows
// downward). Points with non-numeric coordinates are dropped; no usable
// points or a degenerate box → null (the panel renders NoData instead).
export function lorenzPath(points, width, height) {
  if (!isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  const pts = (Array.isArray(points) ? points : []).filter(
    (p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]),
  );
  if (pts.length === 0) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const toSvg = ([x, y]) => [r1(width * clamp(x)), r1(height * (1 - clamp(y)))];
  const curve = pts
    .map((p, i) => {
      const [x, y] = toSvg(p);
      return `${i === 0 ? 'M' : ' L'} ${x} ${y}`;
    })
    .join('');
  return { curve, diagonal: `M 0 ${height} L ${width} 0` };
}

// Outlier rows ordered for display: consensus rows first, then the rest, each
// group by |madZ| descending (a missing madZ sorts last). The panel filters
// the same array for its consensus table and shows all of it behind "table".
export function consensusRows(payload) {
  const rows = (payload && Array.isArray(payload.rows) ? payload.rows : []).filter(
    (r) => r && typeof r === 'object',
  );
  const z = (r) => (isNum(r.madZ) ? Math.abs(r.madZ) : -Infinity);
  const byAbsDesc = (a, b) => z(b) - z(a);
  return [...rows.filter((r) => r.consensus === true).sort(byAbsDesc), ...rows.filter((r) => r.consensus !== true).sort(byAbsDesc)];
}