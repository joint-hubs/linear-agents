import { useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, ExportButtons } from './common.jsx';
import { ColumnChart, KpiTiles } from './charts.jsx';
import { fmtUsd, fmtInt } from './format.js';
import { eraColumns, workLink } from './insightsModel.js';

// Tickets panel — the price of a ticket (FOC-787 slice B, contract §2
// /api/analysis/tickets). Definition line, KPI row, per-era p50 column charts
// (p20/p80 + the median CI as the secondary text under each), the "all eras"
// toggle when the echoed filter is a single era, caveats, and the full task
// table behind "table" with export. Rows render the taskId as a /work/<id>
// link — that link is the "evidence one click away" promise.
// Props: { filters, reloadKey } like CostPanel.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function cell(v) {
  if (v == null) return <span className="muted">—</span>;
  if (isNum(v)) return v.toLocaleString('en-US');
  return String(v);
}

// DataTable's sort + export machinery with per-column custom renderers
// (`renders[col](value, row)`): the taskId column draws as a /work/<taskId>
// Link and the outliers chips need their own cells, which the shared
// DataTable's text-only cells cannot express. Exports always carry the plain
// underlying rows.
export function LinkTable({ title, rows, columns, exportName, renders = {}, taskIdKey }) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const [sort, setSort] = useState(null);

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

  function toggleSort(col) {
    setSort((s) => (s && s.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  }

  // The taskId column is never sortable itself — a Link element is not a
  // value — so sorting falls back to the raw string when the renderer is used.
  const value = (row, c) => {
    if (renders[c]) return renders[c](row[c], row);
    if (taskIdKey && c === taskIdKey) {
      const href = workLink(row[taskIdKey]);
      return href ? <Link to={href}>{String(row[taskIdKey])}</Link> : cell(row[taskIdKey]);
    }
    return cell(row[c]);
  };

  return (
    <div className="section">
      <div className="section-h" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{title}</span>
        <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
          {`${list.length} row${list.length === 1 ? '' : 's'}`}
        </span>
        {exportName && (
          <span style={{ marginLeft: 'auto' }}>
            <ExportButtons name={exportName} rows={sorted} columns={columns} />
          </span>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="empty">No rows.</div>
      ) : (
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr className="th">
              {columns.map((c) => {
                // Render-only columns (a `renders` renderer with no raw value
                // on the rows, e.g. flags chips) sort on undefined — no sort
                // affordance for them.
                const canSort = list.some((r) => r && r[c] != null);
                return (
                  <th
                    key={c}
                    scope="col"
                    style={canSort ? { cursor: 'pointer', userSelect: 'none' } : undefined}
                    onClick={canSort ? () => toggleSort(c) : undefined}
                    title={canSort ? 'click to sort' : undefined}
                  >
                    {c}
                    {sort && sort.col === c ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className="td" style={isNum(row[c]) ? { textAlign: 'right' } : undefined}>
                    {value(row, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TICKET_COLUMNS = [
  'taskId',
  'era',
  'firstTs',
  'msgs',
  'costUsd',
  'costLoaded',
  'supActive',
  'supAdjacent',
  'unpricedShare',
  'partial',
];

// Secondary text under a percentile column chart: the p20–p80 band and the
// median CI, per era. These mirror the ColumnChart rows one to one.
function bandSecondary(rows) {
  return rows.map((r) => `${r.label}: p20 ${fmtUsd(r.p20)} · p80 ${fmtUsd(r.p80)} · CI ${r.ci}`);
}

export default function TicketsPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('tickets', filters, reloadKey);
  const d = (!p.loading && !p.error && p.data) || null;
  const [searchParams] = useSearchParams();

  const direct = d ? eraColumns(d, 'direct') : [];
  const loaded = d ? eraColumns(d, 'loaded') : [];

  const kpis = d
    ? [
        { label: 'Tickets', value: fmtInt(d.tasks) },
        { label: 'Priced', value: fmtInt(d.priced) },
        {
          label: 'Unpriced tickets',
          value: fmtInt(d.unpriced),
          status: isNum(d.unpriced) && d.unpriced > 0 ? 'crit' : undefined,
          hint: 'no priced message — not $0',
        },
        {
          label: 'Partial tickets',
          value: fmtInt(erasPartial(d)),
          hint: 'tickets with an unpriced share in an era',
        },
      ]
    : [];

  function erasPartial(payload) {
    const eras = payload && Array.isArray(payload.eras) ? payload.eras : [];
    return eras.reduce((s, e) => s + (e && isNum(e.partial) ? e.partial : 0), 0);
  }

  // "all eras" toggle: the era filter lives in the URL search params, so the
  // note is a plain link to the same URL with era=all. Shown whenever the
  // echoed filter restricts to a single era.
  const echoedEra = (p.echoedFilters && p.echoedFilters.era) || filters.era;
  const allParams = new URLSearchParams(searchParams);
  allParams.set('era', 'all');

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {d && (
        <>
          {d.definition && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              {d.definition}
            </div>
          )}
          <KpiTiles items={kpis} />
          <Caveats caveats={p.caveats} />

          {echoedEra !== 'all' && (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Showing one era only —{' '}
              <Link to={{ search: allParams.toString() }}>show all eras</Link>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 14,
              alignItems: 'start',
              marginTop: 14,
            }}
          >
            <div className="section">
              <div className="section-h">Median direct cost per era</div>
              <ColumnChart rows={direct} valueKey="p50" format={fmtUsd} />
              {direct.map((r) => (
                <div key={r.label} className="muted" style={{ fontSize: 11.5 }}>
                  {r.label} — p20 {fmtUsd(r.p20)} · p50 {fmtUsd(r.p50)} · p80 {fmtUsd(r.p80)} · median CI {r.ci}
                  {isNum(r.tasks) ? ` · ${fmtInt(r.tasks)} tickets` : ''}
                </div>
              ))}
            </div>

            <div className="section">
              <div className="section-h">Median loaded cost per era</div>
              <ColumnChart rows={loaded} valueKey="p50" format={fmtUsd} />
              {loaded.map((r) => (
                <div key={r.label} className="muted" style={{ fontSize: 11.5 }}>
                  {r.label} — p20 {fmtUsd(r.p20)} · p50 {fmtUsd(r.p50)} · p80 {fmtUsd(r.p80)} · median CI {r.ci}
                  {isNum(r.tasks) ? ` · ${fmtInt(r.tasks)} tickets` : ''}
                </div>
              ))}
            </div>
          </div>

          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5, userSelect: 'none' }}>
              table
            </summary>
            <LinkTable title="Tickets — all rows" rows={d.rows} columns={TICKET_COLUMNS} exportName="tickets-tasks" />
          </details>
        </>
      )}
    </div>
  );
}