import { useState, useEffect } from 'react';
import { getSummary } from '../api';
import { fmtUSD, fmtUSD0, fmtTokens, fmtNum, fmtDate, topByCost } from '../utils';

export default function Costs() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getSummary()
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || String(err));
        setLoading(false);
      });
  }, []);

  function maxCost(entries) {
    return Math.max(0, ...entries.map(([, v]) => v.costUSD || 0));
  }

  function barRow(key, v, max, labelLeft) {
    const pct = max ? ((v.costUSD || 0) / max) * 100 : 0;
    return (
      <div key={key} style={{ marginBottom: 8 }}>
        <div className="bar-label">
          <span>{labelLeft || key}</span>
          <span>{fmtUSD(v.costUSD || 0)}</span>
        </div>
        <div className="bar-track">
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-title">Costs</div>
      <div className="page-sub">Totals · per squad / model / day / task</div>

      {loading && <div className="empty">Loading…</div>}
      {error && <div className="card">Error: {error}</div>}
      {!loading && !error && !summary && <div className="empty">No data.</div>}

      {!loading && !error && summary && (
        <>
          <div className="grid grid-4">
            <div className="card stat">
              <div className="stat-label">Total cost</div>
              <div className="stat-value">{fmtUSD0(summary.totals.costUSD)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Runs</div>
              <div className="stat-value">{fmtNum(summary.totals.runs)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Input</div>
              <div className="stat-value">{fmtTokens(summary.totals.inputTokens)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Output</div>
              <div className="stat-value">{fmtTokens(summary.totals.outputTokens)}</div>
            </div>
          </div>

          {summary.bySquad && Object.keys(summary.bySquad).length > 0 && (
            <div className="section">
              <div className="section-h">Cost by squad</div>
              {(() => {
                const entries = topByCost(summary.bySquad);
                const max = maxCost(entries);
                return entries.map(([k, v]) => barRow(k, v, max, k));
              })()}
            </div>
          )}

          {summary.byModel && Object.keys(summary.byModel).length > 0 && (
            <div className="section">
              <div className="section-h">Cost by model</div>
              {(() => {
                const entries = topByCost(summary.byModel);
                const max = maxCost(entries);
                return entries.map(([k, v]) => barRow(k, v, max, k));
              })()}
            </div>
          )}

          {summary.byDay && Object.keys(summary.byDay).length > 0 && (
            <div className="section">
              <div className="section-h">Cost by day</div>
              {(() => {
                const days = Object.keys(summary.byDay).sort();
                const max = maxCost(days.map((d) => [d, summary.byDay[d]]));
                return days.map((d) => barRow(d, summary.byDay[d], max, fmtDate(d)));
              })()}
            </div>
          )}

          {summary.byTask && Object.keys(summary.byTask).length > 0 && (
            <div className="section">
              <div className="section-h">Top tasks by cost</div>
              {(() => {
                const entries = topByCost(summary.byTask, 10);
                const max = maxCost(entries);
                return (
                  <table className="table">
                    <thead>
                      <tr className="th">
                        <td>Task</td>
                        <td>Runs</td>
                        <td>Cost</td>
                        <td>Bar</td>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(([key, v]) => {
                        const pct = max ? ((v.costUSD || 0) / max) * 100 : 0;
                        return (
                          <tr key={key} className="row">
                            <td className="td">{key === '__untagged__' ? '(untagged)' : key}</td>
                            <td className="td">{v.runs}</td>
                            <td className="td">{fmtUSD(v.costUSD)}</td>
                            <td className="td">
                              <div className="bar-track">
                                <div className="bar-fill" style={{ width: `${pct}%` }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
