import { useMemo, useState } from 'react';
import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable, ExportButtons } from './common.jsx';
import { HBarChart, KpiTiles, ShareBar } from './charts.jsx';
import { fmtInt, fmtPct } from './format.js';

// Tools panel (FOC-220 tool outcomes) — tailored pass over the generic
// skeleton. Layout: KPI row, caveats right under it, repeat-category bars,
// then one dense table switchable across the three dimensions (tool / model /
// squad). Every chart keeps its full data one click away in a <details>
// "table" with CSV/JSON export.
// Props: { filters, reloadKey } — both stable; filters -> query params,
// reloadKey bumped by the screen after a cache rebuild.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const DIMENSIONS = [
  ['byTool', 'tool'],
  ['byModel', 'model'],
  ['bySquad', 'squad'],
];

// Export columns must match what the table renders — repeatPct/errorPct are
// the server's 0–100 percentages, same numbers the ShareBar metering uses.
const DIM_COLUMNS = ['label', 'calls', 'repeats', 'repeatPct', 'errors', 'errorPct'];

// DataTable cannot render custom cells, so the dimension tables render their
// own rows (inline ShareBar next to each %); export stays on ExportButtons.
function DimensionTables({ data }) {
  const [dim, setDim] = useState('byTool');
  const raw = Array.isArray(data?.[dim]) ? data[dim] : [];
  const sorted = useMemo(
    () => [...raw].sort((a, b) => num(b?.calls) - num(a?.calls)),
    [raw],
  );

  const th = { textAlign: 'right' };
  return (
    <div className="section">
      <div className="section-h" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {DIMENSIONS.map(([key, label]) => (
          <button
            key={key}
            className="copy-btn"
            style={{ fontSize: 11, padding: '1px 8px', fontWeight: key === dim ? 700 : 400 }}
            aria-pressed={key === dim}
            onClick={() => setDim(key)}
          >
            by {label}
          </button>
        ))}
        <span
          className="muted"
          style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 11 }}
        >
          {sorted.length} row{sorted.length === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <ExportButtons name={`tools-${dim}`} rows={sorted} columns={DIM_COLUMNS} />
        </span>
      </div>
      {sorted.length === 0 ? (
        <div className="empty">No rows.</div>
      ) : (
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr className="th">
              <th scope="col">label</th>
              <th scope="col" style={th}>calls</th>
              <th scope="col" style={th}>repeats</th>
              <th scope="col" style={th}>repeat %</th>
              <th scope="col" style={th}>errors</th>
              <th scope="col" style={th}>error %</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i}>
                <td className="td">{r?.label != null ? String(r.label) : <span className="muted">—</span>}</td>
                <td className="td" style={th}>{fmtInt(r?.calls)}</td>
                <td className="td" style={th}>{fmtInt(r?.repeats)}</td>
                <td className="td" style={th}>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(r?.repeatPct)}</span>{' '}
                  <ShareBar value={num(r?.repeatPct) / 100} />
                </td>
                <td className="td" style={th}>{fmtInt(r?.errors)}</td>
                <td className="td" style={th}>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(r?.errorPct)}</span>{' '}
                  <ShareBar value={num(r?.errorPct) / 100} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ToolsPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('tools', filters, reloadKey);
  const data = p.data;

  const totals = data?.totals || {};
  const calls = num(totals.calls);
  const repeats = num(totals.repeats);
  const errors = num(totals.errors);
  const outcomeUnknown = num(totals.outcomeUnknown);
  const repeatRate = calls > 0 ? (repeats / calls) * 100 : null;
  const errorRate = calls > 0 ? (errors / calls) * 100 : null;
  const unknownShare = calls > 0 ? (outcomeUnknown / calls) * 100 : null;

  // "unknown is never ok" — when more than 5% of calls have no verifiable
  // outcome the tile carries a warn status (colour + text label, never
  // colour alone).
  const kpis = [
    { label: 'Calls', value: fmtInt(calls) },
    { label: 'Repeat rate', value: fmtPct(repeatRate) },
    { label: 'Error rate', value: fmtPct(errorRate) },
    {
      label: 'Outcome unknown',
      value: fmtPct(unknownShare),
      status: unknownShare > 5 ? 'warn' : undefined,
      hint: 'no verifiable tool_result',
    },
  ];

  const catRows = Array.isArray(data?.repeatCategories) ? data.repeatCategories : [];
  const catBars = catRows.map((c) => ({ label: c?.category, n: num(c?.n) }));

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {!p.loading && !p.error && data != null && (
        <>
          <KpiTiles items={kpis} />
          <Caveats caveats={p.caveats} />
          <div className="section" style={{ marginTop: 14 }}>
            <div className="section-h">Repeat categories</div>
            <HBarChart rows={catBars} valueKey="n" format={fmtInt} />
            <div className="muted" style={{ fontSize: 11.5, margin: '2px 0 8px' }}>
              unchanged = the same call returned the same result — pure waste;
              result_changed / rerun_after_change / reread_after_edit are usually legitimate
            </div>
            <details>
              <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>table</summary>
              <DataTable
                title="Repeat categories"
                rows={catRows}
                columns={['category', 'n']}
                exportName="tools-repeatCategories"
              />
            </details>
          </div>
          <DimensionTables data={data} />
        </>
      )}
      {!p.loading && !p.error && data == null && (
        <>
          <Caveats caveats={p.caveats} />
          <div className="empty">No data.</div>
        </>
      )}
    </div>
  );
}
