import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState } from './common.jsx';
import { KpiTiles } from './charts.jsx';
import { fmtUsd, fmtInt } from './format.js';
import { fmtDirection, consensusRows } from './insightsModel.js';
import { LinkTable } from './TicketsPanel.jsx';

// Outliers panel — the ledger (FOC-787 slice B, contract §2
// /api/analysis/outliers). Definition line, KPI row, the sensitivity tiles
// (the same stats recomputed without the consensus outliers), the consensus
// table with /work/<taskId> links and detector / direction chips, and the
// FULL payload rows behind "table". The payload's rows hold every task; the
// panel inherits the model's ordering — consensus first, then |madZ| desc.
// Props: { filters, reloadKey } like CostPanel.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const CONSENSUS_COLUMNS = ['taskId', 'era', 'costUsd', 'madZ', 'flags', 'direction'];
const ALL_COLUMNS = [
  'taskId',
  'era',
  'costUsd',
  'logCost',
  'madZ',
  'consensus',
  'flagMad',
  'flagTukeyMild',
  'flagTukeyFar',
  'nFlags',
  'direction',
  'msgs',
];

// Detector flags rendered as chips (the shared text cells cannot). Mild and
// far Tukey both mean the tukey detector flagged — far n Flags lighter.
function flagsCell(_, row) {
  const chips = [];
  if (row.flagMad) chips.push('mad');
  if (row.flagTukeyFar) chips.push('tukey far');
  else if (row.flagTukeyMild) chips.push('tukey mild');
  if (chips.length === 0) return null;
  return chips.map((c) => (
    <span key={c} className="chip" style={{ marginRight: 6 }}>
      {c}
    </span>
  ));
}

function directionCell(v) {
  const d = fmtDirection(v);
  if (d === '—') return null;
  return (
    <span className="chip" style={{ whiteSpace: 'nowrap' }}>
      {d}
    </span>
  );
}

// Chips in a cell render as an array of elements; a task with no flag and no
// direction (nothing drawn) still needs a coherent empty cell.
function withDash(node) {
  return node || <span className="muted">—</span>;
}

const RENDERS = {
  flags: (v, r) => withDash(flagsCell(v, r)),
  direction: (v) => withDash(directionCell(v)),
};

export default function OutliersPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('outliers', filters, reloadKey);
  const d = (!p.loading && !p.error && p.data) || null;

  const ordered = d ? consensusRows(d) : [];
  const consensus = ordered.filter((r) => r.consensus === true);
  const detectors = d && Array.isArray(d.detectors) ? d.detectors : [];
  const consMin = d && isNum(d.consensusMin) ? d.consensusMin : null;

  const kpis = d
    ? [
        { label: 'Tickets', value: fmtInt(d.tasks) },
        {
          label: 'Flagged',
          value: fmtInt(d.flagged),
          status: isNum(d.flagged) && d.flagged > 0 ? 'warn' : undefined,
        },
        { label: 'Detectors', value: detectors.length > 0 ? detectors.join(' + ') : '—' },
        {
          label: 'Consensus outliers',
          value: fmtInt(consensus.length),
          hint: consMin != null ? `both detectors at play (n_flags ≥ ${consMin})` : 'n_flags ≥ 2',
          status: consensus.length > 0 ? 'crit' : undefined,
        },
      ]
    : [];

  const sens = d && d.sensitivity && typeof d.sensitivity === 'object' ? d.sensitivity : {};
  const sensKpis = [
    { label: 'Median (all)', value: fmtUsd(sens.medianAll) },
    { label: 'Median (without outliers)', value: fmtUsd(sens.medianWithout) },
    { label: 'Total (all)', value: fmtUsd(sens.totalAll) },
    { label: 'Total (without outliers)', value: fmtUsd(sens.totalWithout) },
  ];

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
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            {sensKpis.map((it, i) => (
              <div
                key={i}
                className="muted"
                style={{
                  flex: '1 1 160px',
                  maxWidth: 240,
                  background: 'var(--raised, rgba(127,127,127,0.08))',
                  padding: '8px 10px',
                  fontSize: 12,
                }}
              >
                <div>{it.label}</div>
                <div style={{ fontSize: 15, color: 'var(--text)', marginTop: 2 }}>{it.value}</div>
              </div>
            ))}
          </div>
          <Caveats caveats={p.caveats} />

          <div className="section" style={{ marginTop: 14 }}>
            <div className="section-h">Consensus outliers</div>
            <LinkTable
              title="Consensus outliers"
              rows={consensus}
              columns={CONSENSUS_COLUMNS}
              exportName="outliers-consensus"
              renders={RENDERS}
              taskIdKey="taskId"
            />
          </div>

          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5, userSelect: 'none' }}>
              table
            </summary>
            <LinkTable title="Outliers — all rows" rows={ordered} columns={ALL_COLUMNS} exportName="outliers-all" renders={RENDERS} taskIdKey="taskId" />
          </details>
        </>
      )}
    </div>
  );
}