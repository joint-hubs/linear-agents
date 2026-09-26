// Pure formatting helpers for the Analysis screen (FOC-397 dashboard).
// Node-importable (no JSX, no React) so _tests_analysis.mjs covers them
// directly. En-US numerals throughout so columns line up on every machine,
// and tabular-nums-friendly widths (fixed decimal places where it matters).

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Unpriced is NOT zero — null/undefined render as an em dash, never $0.00.
export function fmtUsd(n) {
  if (!isNum(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  // >= $100: cents are noise for an operator scanning totals.
  if (a >= 100) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  if (a > 0 && a < 0.01) return `${sign}<$0.01`;
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtInt(n) {
  if (!isNum(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// 6.88 B / 85.3 M / 12.4 k / 950 — trailing zeros trimmed so magnitudes
// read cleanly ("85.3 M", not "85.30 M").
export function fmtCompact(n) {
  if (!isNum(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (a >= 1e9) return `${sign}${trim((a / 1e9).toFixed(2))} B`;
  if (a >= 1e6) return `${sign}${trim((a / 1e6).toFixed(2))} M`;
  if (a >= 1e3) return `${sign}${trim((a / 1e3).toFixed(2))} k`;
  return `${sign}${Math.round(a)}`;
}

// Default input is a 0–100 percentage; pass { fraction: true } for a 0–1
// share. One decimal, trailing ".0" trimmed ("84.9%", "84%").
export function fmtPct(x, { fraction = false } = {}) {
  if (!isNum(x)) return '—';
  const v = fraction ? x * 100 : x;
  let s = v.toFixed(1);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

export function fmtMs(ms) {
  if (!isNum(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

// First n rows sorted desc by `key`, plus one aggregated "other" row when
// more remain. The other row sums every numeric field present on ALL
// remaining rows (so a cost sum is not polluted by an unpriced count that
// only some rows carry). Non-numeric rows sort last, they are never dropped.
export function topN(rows, key, n, labelKey = 'label') {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const sorted = [...list].sort(
    (a, b) => (isNum(b[key]) ? b[key] : -Infinity) - (isNum(a[key]) ? a[key] : -Infinity),
  );
  const kept = sorted.slice(0, Math.max(0, n));
  const rest = sorted.slice(Math.max(0, n));
  if (rest.length === 0) return kept;

  let common = Object.keys(rest[0]);
  for (const r of rest) common = common.filter((k) => k in r);
  const numericKeys = common.filter((k) => rest.every((r) => isNum(r[k])));
  const other = { [labelKey]: `other (${rest.length})` };
  for (const k of numericKeys) {
    other[k] = rest.reduce((s, r) => s + r[k], 0);
  }
  return [...kept, other];
}
