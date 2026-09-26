import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable } from './common.jsx';
import { HBarChart, ColumnChart, StackedBar, KpiTiles } from './charts.jsx';
import { fmtUsd, fmtInt, fmtCompact, fmtPct } from './format.js';

// Cost panel — tailored pass. Dense operator view: KPI row, caveats right
// under it, a full-width token-mix line, then a responsive chart grid.
// Every chart keeps its full data one click away: a collapsed <details>
// "table" with a DataTable (CSV/JSON export) of ALL rows, not just the
// charted top N. Unpriced turns are NEVER folded into spend — they get
// their own KPI (status "critical" when > 0) and ride next to money as
// counts in chart secondary text.
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

// HBarChart secondary text for a spend row: the unpriced count (when any)
// next to the money, plus compact tokens.
function spendSecondary(r) {
  const unpriced = isNum(r.unpriced) && r.unpriced > 0 ? `${fmtInt(r.unpriced)} unpriced · ` : '';
  return `${unpriced}${fmtCompact(r.tokens)} tok`;
}

export default function CostPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('cost', filters, reloadKey);
  const d = (!p.loading && !p.error && p.data) || null;
  const t = (d && d.totals) || {};

  const bySquad = arr(d && d.bySquad);
  const byModel = arr(d && d.byModel);
  const byRole = arr(d && d.byRole);
  const byWeek = arr(d && d.byWeek);
  const leadVsSubagent = arr(d && d.leadVsSubagent);

  const lead = leadVsSubagent.find((r) => r && r.label === 'lead');
  const sub = leadVsSubagent.find((r) => r && r.label === 'subagent');
  const hasLeadSub = Boolean(lead || sub);

  const kpis = [
    { label: 'Spend', value: fmtUsd(t.usd) },
    {
      label: 'Unpriced turns',
      value: fmtInt(t.unpriced),
      status: isNum(t.unpriced) && t.unpriced > 0 ? 'crit' : undefined,
      hint: 'excluded from spend — not $0',
    },
    { label: 'Turns', value: fmtInt(t.turns) },
    { label: 'Tokens', value: fmtCompact(t.tokens) },
    { label: 'Cache hit', value: fmtPct(t.cacheHitPct) },
    {
      label: 'Subagent share of spend',
      value: fmtPct(sub && sub.usdShare, { fraction: true }),
      hint: hasLeadSub ? `lead ${fmtUsd(lead && lead.usd)} · subagent ${fmtUsd(sub && sub.usd)}` : undefined,
    },
  ];

  // Token mix: one 100% line, input / output / cache read / cache creation.
  const tokenParts = [
    { label: 'input', value: isNum(t.inputTokens) ? t.inputTokens : 0 },
    { label: 'output', value: isNum(t.outputTokens) ? t.outputTokens : 0 },
    { label: 'cache read', value: isNum(t.cacheReadTokens) ? t.cacheReadTokens : 0 },
    { label: 'cache creation', value: isNum(t.cacheCreationTokens) ? t.cacheCreationTokens : 0 },
  ];

  const totalsRows = Object.entries(t).map(([k, v]) => ({ key: k, value: v }));

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {d && (
        <>
          <KpiTiles items={kpis} />
          <Caveats caveats={p.caveats} />
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5, userSelect: 'none' }}>
              totals
            </summary>
            <DataTable title="Totals" rows={totalsRows} columns={['key', 'value']} exportName="cost-totals" />
          </details>

          <div className="section" style={{ marginTop: 14 }}>
            <div className="section-h">Token mix</div>
            <StackedBar parts={tokenParts} />
            <DetailsTable
              title="Token mix — all rows"
              rows={tokenParts}
              columns={['label', 'value']}
              exportName="cost-token-mix"
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 14,
              alignItems: 'start',
              marginTop: 14,
            }}
          >
            <ChartCard title="Spend by squad">
              <HBarChart rows={bySquad} valueKey="usd" format={fmtUsd} secondaryText={spendSecondary} />
              <DetailsTable title="Spend by squad — all rows" rows={bySquad} exportName="cost-by-squad" />
            </ChartCard>

            <ChartCard title="Spend by model">
              <HBarChart rows={byModel} valueKey="usd" maxBars={12} format={fmtUsd} secondaryText={spendSecondary} />
              <DetailsTable title="Spend by model — all rows" rows={byModel} exportName="cost-by-model" />
            </ChartCard>

            <ChartCard title="Spend by role">
              <HBarChart rows={byRole} valueKey="usd" maxBars={12} format={fmtUsd} secondaryText={spendSecondary} />
              <DetailsTable title="Spend by role — all rows" rows={byRole} exportName="cost-by-role" />
            </ChartCard>

            <ChartCard title="Spend by ISO week">
              <ColumnChart rows={byWeek} valueKey="usd" format={fmtUsd} />
              <DetailsTable title="Spend by ISO week — all rows" rows={byWeek} exportName="cost-by-week" />
            </ChartCard>

            <ChartCard title="Lead vs subagent">
              <StackedBar parts={leadVsSubagent.map((r) => ({ label: r.label, value: r.usd }))} />
              <DetailsTable
                title="Lead vs subagent — all rows"
                rows={leadVsSubagent}
                exportName="cost-lead-vs-subagent"
              />
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
