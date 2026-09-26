import { useState, useMemo } from 'react';
import { exportCsv, exportJson } from './export.js';

// Shared pieces for the Analysis screen panels. Dense and technical, no
// decoration: caveats as labelled banners, tables in the house .table style,
// and a GenericData fallback that renders every array a panel returns so the
// screen is useful before tailored charts exist.

// --- Caveats -------------------------------------------------------------
// Caveat objects: { level: 'crit'|'warn'|'info', code, message, count? }.
// The level always renders as a TEXT label next to its colour — never colour
// alone. Unknown shapes (strings, missing fields) render as plain text; a
// malformed caveat must never crash the panel.
const CAVEAT_LEVELS = {
  crit: { label: 'critical', color: 'var(--danger, #b42318)' },
  warn: { label: 'warning', color: 'var(--warn, #b54708)' },
  info: { label: 'info', color: 'var(--muted)' },
};

export function Caveats({ caveats }) {
  const list = Array.isArray(caveats) ? caveats : [];
  if (list.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      {list.map((c, i) => {
        const lvl = CAVEAT_LEVELS[c && c.level] || CAVEAT_LEVELS.info;
        let text;
        if (typeof c === 'string') text = c;
        else if (c && typeof c === 'object') text = c.message || c.code || JSON.stringify(c);
        else text = String(c);
        const count = c && typeof c === 'object' && c.count != null ? ` · ${c.count}` : '';
        return (
          <div key={i} className="banner banner-warn" style={{ marginBottom: 8, display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ color: lvl.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{lvl.label}</span>
            <span style={{ fontSize: 12.5 }}>{text}<span className="muted">{count}</span></span>
          </div>
        );
      })}
    </div>
  );
}

// --- Shared loading / error state ---------------------------------------
// cache_building gets its own copy because it is the expected first-load
// state of a fresh install, not an error the user must fix.
export function PanelState({ loading, error }) {
  if (loading) return <div className="empty">Loading…</div>;
  if (error) {
    // cache_building is the expected first-load state of a fresh install,
    // not a fault — friendly copy only. views_missing is a real fault in the
    // analysis source: tell the user the two ways to fix it, with the code.
    if (error.code === 'cache_building') {
      return (
        <div className="card">
          Analysis cache is being built — this takes about a minute.
        </div>
      );
    }
    if (error.code === 'views_missing') {
      return (
        <div className="card">
          Canonical views missing in the analysis source — rebuild the cache (Refresh cache) or run{' '}
          <code style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>
            node scripts/telemetry-canonical.mjs --ensure
          </code>
          <span className="muted" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
            code: {error.code}
          </span>
        </div>
      );
    }
    return (
      <div className="card">
        <span style={{ color: 'var(--danger, #b42318)', fontWeight: 600 }}>error</span>{' '}
        {String(error.message || error)}
        {error.code && <span className="muted"> · code: {error.code}</span>}
        {error.status && <span className="muted"> · HTTP {error.status}</span>}
      </div>
    );
  }
  return null;
}

// --- Cell rendering -----------------------------------------------------

// Numbers render with en-US grouping so columns line up the same on every
// machine; null renders as an em dash (muted), objects as their JSON string.
function cellText(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// --- Export buttons -----------------------------------------------------

export function ExportButtons({ name, rows, columns, value }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <button className="copy-btn" style={{ fontSize: 10, padding: '1px 6px' }} disabled={list.length === 0} onClick={() => exportCsv(name, list, columns)}>
        CSV
      </button>
      <button className="copy-btn" style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => exportJson(name, value != null ? value : list)}>
        JSON
      </button>
    </span>
  );
}

// --- DataTable ----------------------------------------------------------

// Dense sortable table. Click a header to sort (toggle asc/desc); numbers are
// right-aligned with tabular numerals; "n rows" + CSV/JSON export sit in the
// header row. maxRows caps RENDERING only — exports always carry full rows.
export function DataTable({ title, rows, columns, exportName, maxRows }) {
  const list = Array.isArray(rows) ? rows : [];
  const [sort, setSort] = useState(null); // { col, dir: 1 | -1 }

  const cols = useMemo(() => {
    if (columns) return columns;
    const seen = new Set();
    const out = [];
    for (const row of list) {
      if (row == null || typeof row !== 'object') continue;
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) { seen.add(k); out.push(k); }
      }
    }
    return out;
  }, [columns, list]);

  const sorted = useMemo(() => {
    if (!sort) return list;
    const { col, dir } = sort;
    return [...list].sort((a, b) => {
      const av = a?.[col];
      const bv = b?.[col];
      if (isNum(av) && isNum(bv)) return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [list, sort]);

  const shown = maxRows ? sorted.slice(0, maxRows) : sorted;

  function toggleSort(col) {
    setSort((s) => (s && s.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  }

  return (
    <div className="section">
      <div className="section-h" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{title}</span>
        <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
          {shown.length === sorted.length
            ? `${sorted.length} row${sorted.length === 1 ? '' : 's'}`
            : `showing ${shown.length} of ${sorted.length} rows`}
        </span>
        {exportName && <span style={{ marginLeft: 'auto' }}><ExportButtons name={exportName} rows={sorted} columns={cols} /></span>}
      </div>
      {sorted.length === 0 ? (
        <div className="empty">No rows.</div>
      ) : (
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr className="th">
              {cols.map((c) => (
                <th
                  key={c}
                  scope="col"
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => toggleSort(c)}
                  title="click to sort"
                >
                  {c}
                  {sort && sort.col === c ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  const v = row == null ? null : row[c];
                  return (
                    <td key={c} className="td" style={isNum(v) ? { textAlign: 'right' } : undefined}>
                      {v == null ? <span className="muted">—</span> : cellText(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- GenericData --------------------------------------------------------

// Fallback renderer: EVERY array in data (data.x, one level deep) becomes a
// DataTable, and object values (totals-like) become a key/value table. This
// is what makes every panel useful before its tailored charts exist — the
// server shape changes, the panel still shows it.
export function GenericData({ name, data }) {
  if (data == null || typeof data !== 'object') {
    return <div className="empty">No data.</div>;
  }
  const sections = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      sections.push(
        <DataTable key={key} title={key} rows={value} exportName={`${name}-${key}`} />
      );
    } else if (value && typeof value === 'object') {
      // Key/value table (totals-like objects): reuse DataTable for the shared
      // sort/export machinery, one row per entry, first-seen key order.
      const rows = Object.entries(value).map(([k, v]) => ({ key: k, value: v }));
      sections.push(
        <DataTable key={key} title={key} rows={rows} columns={['key', 'value']} exportName={`${name}-${key}`} />
      );
    }
    // Primitive top-level values are skipped — panels surface their own KPIs.
  }
  if (sections.length === 0) return <div className="empty">No data.</div>;
  return <>{sections}</>;
}
