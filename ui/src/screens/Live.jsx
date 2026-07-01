import { useState, useEffect } from 'react';
import { getLive } from '../api';
import { fmtUSD, fmtTime, elapsed, taskLabel, statusLabel, modelMix } from '../utils';

export default function Live() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    const fetch = () => {
      getLive()
        .then((data) => {
          setRuns(data);
          setError(null);
          setLastUpdated(new Date());
        })
        .catch((err) => {
          setError(err.message || String(err));
        });
    };
    fetch();
    const id = setInterval(fetch, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page">
      <div className="page-title">Live</div>
      <div className="page-sub">Active runs · poll 4s</div>

      {error && <div className="card">Error: {error}</div>}

      {!error && runs.length === 0 && (
        <div className="empty">No active runs.</div>
      )}

      {!error && runs.length > 0 && (
        <>
          <table className="table">
            <thead>
              <tr className="th">
                <td>Squad</td>
                <td>Task</td>
                <td>Model</td>
                <td>Elapsed</td>
                <td>Cost</td>
                <td>Status</td>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const status = statusLabel(run);
                const mix = modelMix(run.byModel || {});
                const topModel = mix.length > 0
                  ? `${mix[0].slug} ${mix[0].pct.toFixed(0)}%`
                  : '—';
                const cost = (run.totals && run.totals.costUSD) || 0;

                return (
                  <tr key={run.runId} className="row">
                    <td className="td">{run.squad}</td>
                    <td className="td">{taskLabel(run)}</td>
                    <td className="td">{topModel}</td>
                    <td className="td">{elapsed(run.startedAt, run.endedAt)}</td>
                    <td className="td">{fmtUSD(cost)}</td>
                    <td className="td">
                      {status === 'running' && (
                        <span className="badge badge-ok">running</span>
                      )}
                      {status === 'stale' && (
                        <span className="badge badge-warn">stale</span>
                      )}
                      {run.ambiguous && (
                        <span className="badge badge-warn" style={{ marginLeft: 4 }}>
                          ambiguous
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted" style={{ marginTop: 12 }}>
            updated {fmtTime(lastUpdated?.toISOString())}
          </div>
        </>
      )}
    </div>
  );
}
