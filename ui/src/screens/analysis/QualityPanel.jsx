import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable } from './common.jsx';
import { HBarChart, StackedBar, KpiTiles } from './charts.jsx';
import { fmtInt, fmtPct } from './format.js';

// Quality panel — tailored pass over the generic skeleton. Layout: KPI row
// (unpriced / contested / line-collapsed / canon coverage / outcome unknown),
// caveats right under it, unpriced-by-model bars, attribution-confidence
// stacked bar, open data-quality issues. Every chart keeps its full data one
// click away in a <details> "table" with CSV/JSON export.
// Props: { filters, reloadKey } — both stable; filters -> query params,
// reloadKey bumped by the screen after a cache rebuild.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// in_window is the only attribution the operator can trust at face value;
// the rest keep their raw keys so the panel stays greppable against the API.
const ATTR_LABELS = { in_window: 'in window (trusted)' };

export default function QualityPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('quality', filters, reloadKey);
  const data = p.data;

  const unpricedRows = Array.isArray(data?.unpricedByModel) ? data.unpricedByModel : [];
  const unpriced = unpricedRows.reduce((s, r) => s + num(r?.turns), 0);

  const contested = data?.contested || {};
  const lineCollapsed = data?.lineCollapsed || {};
  const canonCoverage = data?.canonCoverage || {};
  const outcomeUnknown = data?.outcomeUnknown || {};

  // Unpriced is not free — any unpriced turn undercounts every cost total,
  // so a single one makes the tile critical. Line-collapsed is degraded but
  // known shape (FOC-381 legacy) — warning, with the reason in the hint.
  const kpis = [
    {
      label: 'Unpriced turns',
      value: fmtInt(unpriced),
      status: unpriced > 0 ? 'crit' : undefined,
      hint: unpriced > 0 ? `${unpricedRows.length} model${unpricedRows.length === 1 ? '' : 's'} without a price row (cost_usd NULL)` : undefined,
    },
    {
      label: 'Contested calls',
      value: fmtPct(contested.share),
      hint: contested.rows != null ? `${fmtInt(contested.rows)} rows claimed by more than one run — view keeps one representative` : undefined,
    },
    {
      label: 'Line-collapsed turns',
      value: fmtPct(lineCollapsed.share),
      status: num(lineCollapsed.share) > 0 ? 'warn' : undefined,
      hint: 'per-line history the view still de-duplicates heuristically (FOC-381 legacy)',
    },
    {
      label: 'Canon coverage',
      value: fmtPct(canonCoverage.pct),
      hint: canonCoverage.nullCanon != null ? `null canon: ${fmtInt(canonCoverage.nullCanon)} of ${fmtInt(canonCoverage.rows)} rows` : undefined,
    },
    {
      label: 'Outcome unknown',
      value: fmtPct(outcomeUnknown.share),
      hint: outcomeUnknown.rows != null ? `${fmtInt(outcomeUnknown.rows)} rows with no verifiable tool_result` : 'no verifiable tool_result',
    },
  ];

  const unpricedBars = unpricedRows.map((r) => ({ label: r?.model, turns: num(r?.turns) }));
  const attrRows = Array.isArray(data?.attributionMix) ? data.attributionMix : [];
  const attrParts = attrRows.map((r) => ({
    label: ATTR_LABELS[r?.attribution] || r?.attribution || '—',
    value: num(r?.turns),
  }));
  const issues = [...(Array.isArray(data?.openIssues) ? data.openIssues : [])].sort(
    (a, b) => num(b?.n) - num(a?.n),
  );

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {!p.loading && !p.error && data != null && (
        <>
          <KpiTiles items={kpis} />
          <Caveats caveats={p.caveats} />
          <div className="section" style={{ marginTop: 14 }}>
            <div className="section-h">Unpriced turns by model</div>
            <HBarChart rows={unpricedBars} valueKey="turns" format={fmtInt} />
            <details>
              <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>table</summary>
              <DataTable
                title="Unpriced turns by model"
                rows={unpricedRows}
                columns={['model', 'turns']}
                exportName="quality-unpricedByModel"
              />
            </details>
          </div>
          <div className="section">
            <div className="section-h">Attribution confidence</div>
            <StackedBar parts={attrParts} />
            <details>
              <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>table</summary>
              <DataTable
                title="Attribution confidence"
                rows={attrRows}
                columns={['attribution', 'turns']}
                exportName="quality-attributionMix"
              />
            </details>
          </div>
          <DataTable
            title="Open data-quality issues"
            rows={issues}
            columns={['issue_type', 'n']}
            exportName="quality-openIssues"
          />
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
