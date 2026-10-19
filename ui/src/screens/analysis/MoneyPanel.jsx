import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable } from './common.jsx';
import { HBarChart, StackedBar, KpiTiles } from './charts.jsx';
import { fmtUsd, fmtInt, fmtPct } from './format.js';
import { supervisorSplit, lorenzPath } from './insightsModel.js';

// Money panel — where the money goes (FOC-787 slice B, contract §2
// /api/analysis/money). Definition line, KPI row (total / supervisor cost /
// idle share / Gini), spend by squad, the Supervisor active/adjacent/idle
// split as one 100 % stack, and the Lorenz curve drawn as an inline SVG with
// the top-k shares as a small table. No full-rows table — the payload is
// already aggregate.
// Props: { filters, reloadKey } like CostPanel.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);

const W = 180;
const H = 130;

// Secondary text on a squad bar: the squad's share of total spend.
function shareSecondary(r) {
  return fmtPct(r.share, { fraction: true });
}

export default function MoneyPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('money', filters, reloadKey);
  const d = (!p.loading && !p.error && p.data) || null;

  const bySquad = arr(d && d.bySquad);
  const conc = d && d.concentration && typeof d.concentration === 'object' ? d.concentration : {};
  const topK = arr(conc.top);
  const sup = supervisorSplit(d);

  const kpis = d
    ? [
        { label: 'Total spend', value: fmtUsd(d.total) },
        {
          label: 'Supervisor cost',
          value: fmtUsd(d.supervisor && d.supervisor.costUsd),
          hint: 'allocated active / adjacent / idle below',
        },
        {
          label: 'Supervisor idle share',
          value: fmtPct(d.supervisor && d.supervisor.idleShare, { fraction: true }),
          status: isNum(d.supervisor && d.supervisor.idleShare) && d.supervisor.idleShare > 0.5 ? 'warn' : undefined,
        },
        { label: 'Gini (ticket cost)', value: conc.gini != null ? Number(conc.gini).toFixed(2) : '—' },
      ]
    : [];

  const lorenz = lorenzPath(conc.lorenz, W, H);

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
              <div className="section-h">Spend by squad</div>
              <HBarChart rows={bySquad} valueKey="costUsd" format={fmtUsd} secondaryText={shareSecondary} />
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5, userSelect: 'none' }}>
                  table
                </summary>
                <DataTable title="Spend by squad — all rows" rows={bySquad} exportName="money-by-squad" />
              </details>
            </div>

            <div>
              <div className="section">
                <div className="section-h">Supervisor cost split</div>
                <StackedBar parts={sup} format={fmtUsd} />
              </div>

              <div className="section" style={{ marginTop: 14 }}>
                <div className="section-h">Lorenz curve — ticket cost</div>
                {lorenz ? (
                  <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <svg
                      viewBox={`0 0 ${W} ${H}`}
                      width={W}
                      height={H}
                      role="img"
                      aria-label="Lorenz curve of direct ticket cost"
                      style={{ background: 'var(--raised, rgba(127,127,127,0.06))' }}
                    >
                      <path d={lorenz.diagonal} fill="none" stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
                      <path d={lorenz.curve} fill="none" stroke="var(--accent, #4f7cf7)" strokeWidth="2" />
                    </svg>
                    <table className="table" style={{ width: 'auto', minWidth: 180 }}>
                      <thead>
                        <tr className="th">
                          <th scope="col">top k</th>
                          <th scope="col" style={{ textAlign: 'right' }}>
                            cost share
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {topK.map((r, i) => (
                          <tr key={i}>
                            <td className="td">
                              {isNum(r.k) ? `top ${fmtPct(r.k, { fraction: true })}` : '—'}
                            </td>
                            <td className="td" style={{ textAlign: 'right' }}>
                              {isNum(r.share) ? fmtPct(r.share, { fraction: true }) : <span className="muted">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty">No data.</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}