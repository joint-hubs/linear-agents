import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getRuns } from '../api';
import { linearUrl } from '../config';
import {
  fmtUSD,
  fmtTokens,
  fmtTime,
  elapsed,
  taskLabel,
  statusLabel,
  modelMix,
  todayTotals,
  attentionList,
} from '../utils';

const POLL_MS = 5000;

// Cost cell: while a run is active, cost is usually 0 (the transcript is
// discovered at run end) → show "…" with a tooltip, never "$0.00".
function CostCell({ run }) {
  if (!run.endedAt) {
    return (
      <span className="muted" title="cost appears after the run ends">
        …
      </span>
    );
  }
  return <span>{fmtUSD(run.totals?.costUSD || 0)}</span>;
}

// Task chip: ↗ link to Linear when the prefix is known, plain text otherwise.
function TaskChip({ run }) {
  const id = taskLabel(run);
  const url = linearUrl(id);
  if (url) {
    return (
      <a className="link" href={url} target="_blank" rel="noreferrer">
        {id} ↗
      </a>
    );
  }
  return <span>{id}</span>;
}

function StatusBadge({ run }) {
  const s = statusLabel(run);
  if (s === 'running') return <span className="badge badge-ok">running</span>;
  if (s === 'failed') return <span className="badge badge-fail">failed</span>;
  return <span className="badge badge-ok">done</span>;
}

function ModelBars({ run }) {
  const mix = modelMix(run.byModel || {});
  if (mix.length === 0) return <span className="muted">—</span>;
  return (
    <div className="modelbars">
      {mix.slice(0, 2).map((m) => (
        <div className="modelbar" key={m.slug}>
          <span className="modelbar-label">{m.slug}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${m.pct}%` }} />
          </div>
          <span className="modelbar-pct">{m.pct.toFixed(0)}%</span>
        </div>
      ))}
      {mix.length > 2 && <span className="muted">+{mix.length - 2} more</span>}
    </div>
  );
}

export default function Live() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(new Date());
  const retryRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getRuns()
        .then((data) => {
          if (!alive) return;
          setRuns(data);
          setError(null);
          setLastUpdated(new Date());
          retryRef.current = 0;
        })
        .catch((err) => {
          if (!alive) return;
          setError(err.message || String(err));
          retryRef.current += 1;
        });
    };
    tick();
    const id = setInterval(() => {
      setNow(new Date());
      tick();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const active = runs.filter((r) => !r.endedAt);
  // Recently finished = ended runs, newest first (scanRuns is already newest-first).
  const recent = runs.filter((r) => r.endedAt).slice(0, 10);
  const today = todayTotals(runs, now);
  const attention = attentionList(runs, now);
  const todayTokens = today.inputTokens + today.outputTokens;

  return (
    <div className="page">
      <div className="page-title">Live</div>
      <div className="page-sub">Active runs · poll {POLL_MS / 1000}s</div>

      {error && (
        <div className="card api-down">
          <div className="card-h">Telemetry server unreachable</div>
          <div>
            Start it: <code>node scripts/telemetry-server.mjs</code>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Retrying in {POLL_MS / 1000}s (attempt {retryRef.current})…
          </div>
        </div>
      )}

      {!error && (
        <>
          {/* KPI strip */}
          <div className="kpi-strip">
            <div className="kpi">
              <div className="kpi-label">Active</div>
              <div className="kpi-value">{active.length}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Cost today</div>
              <div className="kpi-value">{fmtUSD(today.costUSD)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Tokens today</div>
              <div className="kpi-value">{fmtTokens(todayTokens)}</div>
            </div>
            <div className={'kpi' + (attention.length > 0 ? ' kpi-warn' : '')}>
              <div className="kpi-label">⚠ Attention</div>
              <div className="kpi-value">{attention.length}</div>
            </div>
          </div>

          {/* Active runs */}
          <div className="section">
            <div className="section-h">Active runs</div>
            {active.length === 0 && (
              <div className="card empty">
                No agents running. Start one:{' '}
                <code>bin\dev.bat</code>
              </div>
            )}
            {active.length > 0 && (
              <div className="run-cards">
                {active.map((run) => (
                  <div className="run-card" key={run.runId}>
                    <div className="run-card-h">
                      <span className="dot dot-ok" />
                      <span className="run-card-squad">{run.squad || '—'}</span>
                      <TaskChip run={run} />
                      <span className="pill">{run.repo || '—'}</span>
                    </div>
                    <div className="run-card-meta muted">
                      {run.gitBranch ? `branch: ${run.gitBranch}` : 'no branch'}
                    </div>
                    <ModelBars run={run} />
                    <div className="run-card-foot">
                      <span>elapsed {elapsed(run.startedAt, run.endedAt)}</span>
                      <span>
                        cost <CostCell run={run} />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recently finished (last 10) */}
          <div className="section">
            <div className="section-h">Recently finished (last 10)</div>
            {recent.length === 0 && <div className="empty">No finished runs yet.</div>}
            {recent.length > 0 && (
              <table className="table">
                <thead>
                  <tr className="th">
                    <td>Time</td>
                    <td>Squad</td>
                    <td>Task</td>
                    <td>Repo</td>
                    <td>Elapsed</td>
                    <td>Cost</td>
                    <td>Status</td>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run) => (
                    <tr key={run.runId} style={{ cursor: 'pointer' }}>
                      <td className="td">{fmtTime(run.startedAt)}</td>
                      <td className="td">{run.squad || '—'}</td>
                      <td className="td">
                        <TaskChip run={run} />
                      </td>
                      <td className="td">{run.repo || '—'}</td>
                      <td className="td">{elapsed(run.startedAt, run.endedAt)}</td>
                      <td className="td">
                        <CostCell run={run} />
                      </td>
                      <td className="td">
                        <StatusBadge run={run} />
                        {run.ambiguous && (
                          <span className="badge badge-warn" style={{ marginLeft: 4 }}>
                            ambiguous
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Needs attention */}
          <div className="section">
            <div className="section-h">⚠ Needs attention</div>
            {attention.length === 0 && (
              <div className="empty">Nothing needs attention.</div>
            )}
            {attention.length > 0 && (
              <ul className="att-list">
                {attention.map((it) => {
                  const run = it.run;
                  const msg =
                    it.reason === 'stale'
                      ? `running > 2 h — stale?`
                      : `transcript match ambiguous → verify cost`;
                  return (
                    <li className="att-item" key={run.runId + ':' + it.reason}>
                      <span className="badge badge-warn">{it.reason}</span>
                      <span className="muted">{fmtTime(run.startedAt)}</span>
                      <span>{run.squad || '—'}</span>
                      <TaskChip run={run} />
                      <span className="muted att-msg">{msg}</span>
                      <Link className="link" to={`/runs/${run.runId}`}>
                        open
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="muted" style={{ marginTop: 16 }}>
            updated {lastUpdated ? fmtTime(lastUpdated.toISOString()) : '—'}
          </div>
        </>
      )}
    </div>
  );
}
