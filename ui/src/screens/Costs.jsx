import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRuns, getSummary } from '../api';
import { linearUrl } from '../config';
import { fmtUSD, fmtUSD0, fmtTokens, fmtNum, fmtDate, topByCost } from '../utils';

// ux-design-v3 §3.4 — Costs upgrade.
// Period toggle (7d / 30d / All) recomputes the KPI strip, byDay chart and
// byAgent list client-side from /api/runs (the summary endpoint stays untouched,
// per §3.4 pt 1). bySquad / byModel / byTask come from /api/summary (all-time).
const PERIODS = [
  { key: '7d', ms: 7 * 24 * 60 * 60 * 1000, label: '7d' },
  { key: '30d', ms: 30 * 24 * 60 * 60 * 1000, label: '30d' },
  { key: 'all', ms: null, label: 'All' },
];

// Recompute the byDay map from a set of runs (mirrors telemetry-server.buildSummary
// — YYYY-MM-DD is the first 10 chars of startedAt).
function computeByDay(runs) {
  const out = {};
  for (const r of runs) {
    const day = (r.startedAt || '').slice(0, 10);
    if (!day) continue;
    if (!out[day]) out[day] = { runs: 0, costUSD: 0 };
    out[day].runs += 1;
    out[day].costUSD += (r.totals && r.totals.costUSD) || 0;
  }
  return out;
}

// Sum run.byAgent across runs → { agent: { costUSD, inputTokens, outputTokens, cacheReadInputTokens } }.
function sumByAgent(runs) {
  const out = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.byAgent || {})) {
      if (!out[k]) out[k] = { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
      out[k].costUSD += v.costUSD || 0;
      out[k].inputTokens += v.inputTokens || 0;
      out[k].outputTokens += v.outputTokens || 0;
      out[k].cacheReadInputTokens += v.cacheReadInputTokens || 0;
    }
  }
  return out;
}

export default function Costs() {
  const [summary, setSummary] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Stable "now" — period windows are relative to page load. Costs is a history
  // dashboard, not a live feed, so we don't tick.
  const [now] = useState(() => new Date());
  const [period, setPeriod] = useState('all');
  const navigate = useNavigate();

  // Fetch both endpoints. On error, KEEP the last good summary/runs visible and
  // surface a banner — a transient network blip must not wipe the dashboard.
  // (Review cross-ref from JOI-65: error-state = banner over last known state.)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getSummary(), getRuns()])
      .then(([s, r]) => {
        if (cancelled) return;
        setSummary(s);
        setRuns(r);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const periodMs = PERIODS.find((p) => p.key === period)?.ms ?? null;
  const periodRuns = useMemo(() => {
    if (periodMs == null) return runs;
    const cutoff = now.getTime() - periodMs;
    return runs.filter((r) => r.startedAt && new Date(r.startedAt).getTime() >= cutoff);
  }, [runs, periodMs, now]);

  // KPI strip — recomputed from period-filtered runs (§3.4 pt 1).
  const kpi = useMemo(() => {
    const a = { costUSD: 0, runs: 0, inputTokens: 0, outputTokens: 0 };
    for (const r of periodRuns) {
      const t = r.totals || {};
      a.costUSD += t.costUSD || 0;
      a.inputTokens += t.inputTokens || 0;
      a.outputTokens += t.outputTokens || 0;
      a.runs += 1;
    }
    return a;
  }, [periodRuns]);

  const byDay = useMemo(() => computeByDay(periodRuns), [periodRuns]);
  const byAgent = useMemo(() => sumByAgent(periodRuns), [periodRuns]);

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

  const hasData = !loading && !error && summary;

  return (
    <div className="page">
      <div className="page-title">Costs</div>
      <div className="page-sub">Totals · per squad / model / day / task</div>

      {/* Period toggle (§3.4 pt 1) — reuses Timeline .zbtn styles */}
      <div className="tl-controls" style={{ marginBottom: 16 }}>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            className={'zbtn' + (period === p.key ? ' on' : '')}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {period === 'all' ? 'all-time' : `last ${period}`} · {periodRuns.length} run
          {periodRuns.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Error banner over last known state (review cross-ref). */}
      {error && (summary || runs.length > 0) && (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          <strong>⚠ Telemetry fetch failed</strong> — showing last known data. {error}
        </div>
      )}

      {loading && <div className="empty">Loading…</div>}
      {error && !summary && runs.length === 0 && <div className="card">Error: {error}</div>}
      {!loading && !error && !summary && <div className="empty">No data.</div>}

      {hasData && (
        <>
          <div className="grid grid-4">
            <div className="card stat">
              <div className="stat-label">Total cost</div>
              <div className="stat-value">{fmtUSD0(kpi.costUSD)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Runs</div>
              <div className="stat-value">{fmtNum(kpi.runs)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Input</div>
              <div className="stat-value">{fmtTokens(kpi.inputTokens)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Output</div>
              <div className="stat-value">{fmtTokens(kpi.outputTokens)}</div>
            </div>
          </div>

          {/* By agent — NEW (§3.4 pt 2): sum run.byAgent across period-filtered runs. */}
          {Object.keys(byAgent).length > 0 && (
            <div className="section">
              <div className="section-h">Cost by agent</div>
              {(() => {
                const entries = topByCost(byAgent);
                const max = maxCost(entries);
                return entries.map(([k, v]) => barRow(k, v, max, k));
              })()}
            </div>
          )}

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

          {/* byDay — recomputed from period-filtered runs (§3.4 pt 1). */}
          {Object.keys(byDay).length > 0 && (
            <div className="section">
              <div className="section-h">Cost by day</div>
              {(() => {
                const days = Object.keys(byDay).sort();
                const max = maxCost(days.map((d) => [d, byDay[d]]));
                return days.map((d) => barRow(d, byDay[d], max, fmtDate(d)));
              })()}
            </div>
          )}

          {/* byTask — Squads chips + Span + Linear ↗ + row click → /runs?task=X (§3.4 pt 3). */}
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
                        <td>Squads</td>
                        <td>Runs</td>
                        <td>Span</td>
                        <td>Cost</td>
                        <td>Bar</td>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(([key, v]) => {
                        const untagged = key === '__untagged__';
                        const pct = max ? ((v.costUSD || 0) / max) * 100 : 0;
                        const url = untagged ? null : linearUrl(key);
                        const squads = v.squads ? Object.keys(v.squads).sort() : [];
                        return (
                          <tr
                            key={key}
                            className="row"
                            style={{ cursor: untagged ? 'default' : 'pointer' }}
                            onClick={() => {
                              if (untagged) return;
                              navigate(`/runs?task=${encodeURIComponent(key)}`);
                            }}
                          >
                            <td className="td">
                              {untagged ? (
                                <span className="muted">(untagged)</span>
                              ) : (
                                <>
                                  {key}
                                  {url && (
                                    <>
                                      {' '}
                                      <a
                                        className="link"
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        ↗
                                      </a>
                                    </>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="td">
                              {squads.length === 0 ? (
                                <span className="muted">—</span>
                              ) : (
                                squads.map((s) => (
                                  <span key={s} className="pill" style={{ marginRight: 4 }}>
                                    {s}
                                  </span>
                                ))
                              )}
                            </td>
                            <td className="td">{v.runs}</td>
                            <td className="td">
                              {v.firstStartedAt ? (
                                <span className="muted">
                                  {fmtDate(v.firstStartedAt)}
                                  {v.lastEndedAt ? ' → ' + fmtDate(v.lastEndedAt) : ' → running'}
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
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

          {/* Footer note (§3.4 pt 4). */}
          <div className="muted" style={{ fontSize: 12, marginTop: 24 }}>
            Costs computed from transcripts × config/models.json pricing. Cross-check billed $:{' '}
            <code className="path-mono">node scripts/cost-report.mjs</code> (OpenRouter Activity).
          </div>
        </>
      )}
    </div>
  );
}
