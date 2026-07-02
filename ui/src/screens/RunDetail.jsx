import { useState, useEffect } from 'react';
import { useParams, NavLink } from 'react-router-dom';
import { getRun } from '../api';
import { fmtUSD, fmtTokens, taskLabel, statusLabel, modelMix } from '../utils';

export default function RunDetail() {
  const { id } = useParams();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRun(id)
      .then((data) => {
        setRun(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || String(err));
        setLoading(false);
      });
  }, [id]);

  return (
    <div className="page">
      <NavLink to="/runs" className="link">
        ← Runs
      </NavLink>

      {loading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Not found: {error}</div>}

      {!loading && !error && run && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '1.2em', fontWeight: 600 }}>
              {run.squad} · {taskLabel(run)}
            </div>
            <div className="muted">{run.runId}</div>
            <div style={{ marginTop: 8 }}>
              {(() => {
                const s = statusLabel(run);
                if (s === 'done') return <span className="badge badge-ok">done</span>;
                if (s === 'running') return <span className="badge badge-ok">running</span>;
                if (s === 'failed') return <span className="badge badge-fail">failed</span>;
                return null;
              })()}
              {run.ambiguous && (
                <span className="badge badge-warn" style={{ marginLeft: 4 }}>
                  ambiguous
                </span>
              )}
              {run.missing && (
                <span className="badge badge-warn" style={{ marginLeft: 4 }}>
                  no transcript
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-4">
            <div className="card stat">
              <div className="stat-label">Cost</div>
              <div className="stat-value">{fmtUSD(run.totals?.costUSD || 0)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Input</div>
              <div className="stat-value">{fmtTokens(run.totals?.inputTokens)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Output</div>
              <div className="stat-value">{fmtTokens(run.totals?.outputTokens)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Cache read</div>
              <div className="stat-value">{fmtTokens(run.totals?.cacheReadTokens)}</div>
            </div>
          </div>

          {/* By model */}
          <div className="section">
            <div className="section-h">By model</div>
            <table className="table">
              <thead>
                <tr className="th">
                  <td>Model</td>
                  <td>Cost</td>
                  <td>Tokens</td>
                  <td>Bar</td>
                </tr>
              </thead>
              <tbody>
                {modelMix(run.byModel || {}).map((m) => (
                  <tr key={m.slug} className="row">
                    <td className="td">{m.slug}</td>
                    <td className="td">{fmtUSD(m.costUSD)}</td>
                    <td className="td">{fmtTokens((m.inputTokens || 0) + (m.outputTokens || 0))}</td>
                    <td className="td">
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${m.pct}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {(!run.byModel || Object.keys(run.byModel).length === 0) && (
                  <tr className="row">
                    <td className="td" colSpan={4}>
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* By agent */}
          <div className="section">
            <div className="section-h">By agent</div>
            <table className="table">
              <thead>
                <tr className="th">
                  <td>Agent</td>
                  <td>Cost</td>
                  <td>Tokens</td>
                  <td>Bar</td>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const byAgent = run.byAgent || {};
                  const entries = Object.entries(byAgent);
                  if (entries.length === 0) {
                    return (
                      <tr className="row">
                        <td className="td" colSpan={4}>
                          —
                        </td>
                      </tr>
                    );
                  }
                  const sum = entries.reduce((acc, [, v]) => acc + (v.costUSD || 0), 0);
                  const sorted = entries
                    .map(([name, v]) => ({
                      name,
                      ...v,
                      pct: sum > 0 ? ((v.costUSD || 0) / sum) * 100 : 0,
                    }))
                    .sort((a, b) => (b.costUSD || 0) - (a.costUSD || 0));

                  return sorted.map((a) => (
                    <tr key={a.name} className="row">
                      <td className="td">{a.name}</td>
                      <td className="td">{fmtUSD(a.costUSD)}</td>
                      <td className="td">
                        {fmtTokens((a.inputTokens || 0) + (a.outputTokens || 0))}
                      </td>
                      <td className="td">
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${a.pct}%` }} />
                        </div>
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
