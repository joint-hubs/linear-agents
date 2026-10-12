// Live children table (FOC-783) — the honest status from spec §5: "running"
// only when the process is alive AND the tee grew recently, everything else
// labelled. Squad colour is always paired with a text label (spec §7).

import { statusChip, formatAge } from '../../cockpitModel';
import { fmtUSD } from '../../utils';

// Squad ids seen in the registry; anything else renders uncoloured. Existing
// --sq-* tokens from theme.css — colour never the only signal.
const SQUAD_VAR = {
  plan: 'var(--sq-plan)',
  dev: 'var(--sq-dev)',
  review: 'var(--sq-review)',
  test: 'var(--sq-test)',
  cadence: 'var(--sq-cadence)',
  supervisor: 'var(--sq-supervisor)',
};

function SquadTag({ squad }) {
  if (!squad) return <span className="muted">—</span>;
  const varRef = SQUAD_VAR[squad];
  return (
    <span className="ck-squad">
      {varRef && <span className="dot" style={{ background: varRef }} />}
      <span>{squad}</span>
    </span>
  );
}

function StatusChip({ child }) {
  const { label, tone } = statusChip(child);
  return <span className={`ck-chip ck-tone-${tone}`}>{label}</span>;
}

// "checked 4 s ago" — the age of the check itself, recomputed per render. The
// table re-renders on every cockpit poll (5 s) so this stays fresh enough.
function checkedAgo(checkedAt) {
  if (!checkedAt) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(checkedAt).getTime()) / 1000));
  return 'checked ' + (s === 1 ? '1 s' : s + ' s') + ' ago';
}

export default function LiveChildren({ items }) {
  const rows = items || [];
  return (
    <div className="section">
      <div className="section-h">Live children</div>
      {rows.length === 0 ? (
        <div className="empty">No child runs in the last 24 h.</div>
      ) : (
        <div className="card ck-scroll">
          <table className="ck-table">
            <thead>
              <tr>
                <th>Child</th>
                <th>Ticket</th>
                <th>Squad</th>
                <th>Status</th>
                <th>Age</th>
                <th>Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.runId + ':' + c.childId}>
                  <td>
                    <code className="ck-mono">{c.childId}</code>
                  </td>
                  <td>
                    <code className="ck-mono">{c.taskId || 'untagged'}</code>
                  </td>
                  <td>
                    <SquadTag squad={c.squad} />
                  </td>
                  <td>
                    <StatusChip child={c} />
                  </td>
                  <td className="ck-num">{formatAge(c.ageMs)}</td>
                  <td className="ck-num">
                    {c.costUsd != null ? (
                      <>
                        {fmtUSD(c.costUsd)} <span className="chip">est.</span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted ck-checked">{checkedAgo(c.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
