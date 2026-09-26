// CSV / JSON export helpers for the Analysis screen — pure JS, no React, so
// toCsv is unit-testable under plain node (see _tests_analysis.mjs).
// CSV follows RFC 4180: fields containing comma, quote, CR or LF are quoted
// with inner quotes doubled; CRLF line breaks.

// RFC 4180 field encoder. null/undefined become empty; objects become their
// JSON string (arrays, nested objects — anything a table cell can hold).
function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// rows -> CSV text. columns default to the union of row keys in first-seen
// order, so ragged rows (a key missing on some rows) export consistently.
export function toCsv(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  let cols = columns;
  if (!cols) {
    const seen = new Set();
    cols = [];
    for (const row of list) {
      if (row == null || typeof row !== 'object') continue;
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
  }
  const lines = [cols.map(csvCell).join(',')];
  for (const row of list) {
    lines.push(cols.map((c) => csvCell(row == null ? null : row[c])).join(','));
  }
  return lines.join('\r\n');
}

export function toJson(value) {
  return JSON.stringify(value, null, 2);
}

// Browser-only sink: Blob + temporary anchor. Guarded so a node import of
// this module never crashes on the missing document global.
export function downloadText(filename, text, mime = 'text/plain') {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// analysis-<name>-<YYYYMMDD-HHMM>.csv|json — local time, no separators.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

export function exportCsv(name, rows, columns) {
  downloadText(`analysis-${name}-${stamp()}.csv`, toCsv(rows, columns), 'text/csv');
}

export function exportJson(name, value) {
  downloadText(`analysis-${name}-${stamp()}.json`, toJson(value), 'application/json');
}
