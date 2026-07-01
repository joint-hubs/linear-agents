import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRuns } from '../api';
import { fmtUSD, fmtTokens, fmtDateTime, taskLabel, statusLabel, modelMix } from '../utils';

export default function Runs() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    getRuns()
      .then((data) => {
        setRuns(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || String(err));
        setLoading(false);
      });
  }, []);

  const filtered = runs.filter((run) => {
    if (!q) return true;
    const lower = q.toLowerCase();
    return (
      (run.squad && run.squad.toLowerCase().includes(lower)) ||
      (run.taskId && run.taskId.toLowerCase().includes(lower)) ||
      (run.runId && run.runId.toLowerCase().includes(lower))
    );
  });

  return (
    <div className="page">
      <div className="page-title">Runs</div>
      <div className="page-sub">History</div>

      <input
        style={{
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          font: 'inherit',
          marginBottom: '16px',
        }}
        placeholder="Search by squad, task, or run ID…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {loading && <div className="empty">Loading…</div>}
      {error && <div className="card">Error: {error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="empty">No runs.</div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <table className="table">
          <thead>
            <tr className="th">
              <td>Started</td>
              <td>Squad</td>
              <td>Task</td>
              <td>Status</td>
              <td>Cost</td>
              <td>Tokens</td>
              <td>Models</td>
            </tr>
          </thead>
          <tbody>
            {filtered.map((run) => {
              const status = statusLabel(run);
              const mix = modelMix(run.byModel || {});
              const totalTokens =
                (run.totals?.inputTokens || 0) + (run.totals?.outputTokens || 0);

              let modelsCell = '—';
              if (mix.length > 0) {
                const top = mix.slice(0, 2);
                if (mix.length > 2) {
                  modelsCell = `${top[0].slug} (+${mix.length - 1})`;
                } else {
                  modelsCell = top.map((m) => m.slug).join(', ');
                }
              }

              return (
                <tr
                  key={run.runId}
                  className="row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/runs/${run.runId}`)}
                >
                  <td className="td">{fmtDateTime(run.startedAt)}</td>
                  <td className="td">{run.squad}</td>
                  <td className="td">{taskLabel(run)}</td>
                  <td className="td">
                    {status === 'done' && <span className="badge badge-ok">done</span>}
                    {status === 'running' && <span className="badge badge-ok">running</span>}
                    {status === 'stale' && <span className="badge badge-warn">stale</span>}
                    {run.ambiguous && (
                      <span className="badge badge-warn" style={{ marginLeft: 4 }}>
                        amb
                      </span>
                    )}
                  </td>
                  <td className="td">{fmtUSD(run.totals?.costUSD || 0)}</td>
                  <td className="td">{fmtTokens(totalTokens)}</td>
                  <td className="td">{modelsCell}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
