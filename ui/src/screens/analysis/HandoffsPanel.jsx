import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable } from './common.jsx';
import { HBarChart, KpiTiles } from './charts.jsx';
import { fmtUsd, fmtInt, fmtPct } from './format.js';

// Handoffs panel — tailored pass. Dense operator view: KPI row (unresolved
// links get status "warning" with their share), caveats right under it,
// delegated spend by squad, then the full parent → child table. The chart
// keeps its full data one click away in a collapsed <details> "table" with
// CSV/JSON export. The pair table carries derived columns (pair label,
// usd per link) and is sorted by child spend, desc.
// Props: { filters, reloadKey } — both stable; filters -> query params,
// reloadKey bumped by the screen after a cache rebuild.

// --- local layout helpers (panel-local; shared files are off-limits) ------

function ChartCard({ title, children }) {
  return (
    <div className="section">
      <div className="section-h">{title}</div>
      {children}
    </div>
  );
}

// Full data behind a chart: collapsed by default, one click to ALL rows.
function DetailsTable({ title, rows, columns, exportName }) {
  return (
    <details style={{ marginTop: 8 }}>
      <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5, userSelect: 'none' }}>
        table
      </summary>
      <DataTable title={title} rows={rows} columns={columns} exportName={exportName} />
    </details>
  );
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);

// Pair rows for the parent → child table. usd figures are rounded for
// display (cents; per-link to 4 decimals) so the sortable numeric columns
// scan cleanly — the export carries the same rounded values.
function toPairRows(byPair) {
  return byPair
    .map((r) => {
      const perLink = isNum(r.childUsd) && isNum(r.links) && r.links > 0 ? r.childUsd / r.links : null;
      return {
        pair: `${r.parent} → ${r.child}`,
        childModel: r.childModel != null ? String(r.childModel) : '—',
        links: isNum(r.links) ? r.links : null,
        childTurns: isNum(r.childTurns) ? r.childTurns : null,
        childUsd: isNum(r.childUsd) ? Math.round(r.childUsd * 100) / 100 : null,
        childTokens: isNum(r.childTokens) ? r.childTokens : null,
        usdPerLink: perLink != null ? Math.round(perLink * 10000) / 10000 : null,
      };
    })
    .sort((a, b) => (isNum(b.childUsd) ? b.childUsd : -Infinity) - (isNum(a.childUsd) ? a.childUsd : -Infinity));
}

export default function HandoffsPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('handoffs', filters, reloadKey);
  const d = (!p.loading && !p.error && p.data) || null;
  const t = (d && d.totals) || {};

  const byPair = arr(d && d.byPair);
  const bySquad = arr(d && d.bySquad);
  const pairRows = toPairRows(byPair);

  // Share of links that never resolved — undefined when it cannot be computed.
  const unresolvedShare =
    isNum(t.unresolved) && isNum(t.links) && t.links > 0 ? (t.unresolved / t.links) * 100 : undefined;

  const kpis = [
    { label: 'Delegations', value: fmtInt(t.links) },
    { label: 'Resolved', value: fmtInt(t.resolved) },
    {
      label: 'Unresolved',
      value: fmtInt(t.unresolved),
      status: isNum(t.unresolved) && t.unresolved > 0 ? 'warn' : undefined,
      hint: `${unresolvedShare != null ? `${fmtPct(unresolvedShare)} of links · ` : ''}child transcript not in canonical views`,
    },
  ];

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {d && (
        <>
          <KpiTiles items={kpis} />
          <Caveats caveats={p.caveats} />

          <div style={{ marginTop: 14 }}>
            <ChartCard title="Delegated spend by squad">
              <HBarChart
                rows={bySquad}
                valueKey="childUsd"
                format={fmtUsd}
                secondaryText={(r) => `${fmtInt(r.links)} links`}
              />
              <DetailsTable
                title="Delegated spend by squad — all rows"
                rows={bySquad}
                exportName="handoffs-by-squad"
              />
            </ChartCard>
          </div>

          <DataTable
            title="Parent → child"
            rows={pairRows}
            columns={['pair', 'childModel', 'links', 'childTurns', 'childUsd', 'childTokens', 'usdPerLink']}
            exportName="handoffs-by-pair"
          />
        </>
      )}
    </div>
  );
}
