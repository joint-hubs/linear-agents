import { useState, useEffect } from 'react';
import { useParams, NavLink, useNavigate } from 'react-router-dom';
import { getRun } from '../api';
import { linearUrl } from '../config';
import {
  fmtUSD,
  fmtTokens,
  fmtDateTime,
  elapsed,
  taskLabel,
  statusLabel,
  isStale,
  modelMix,
} from '../utils';

// Provider label from the `native` flag (ux-design-v3 §3.3.1).
function providerLabel(run) {
  if (run.native === true) return 'anthropic-sub';
  if (run.native === false) return 'openrouter';
  return '—';
}

// Truncate a long path in the middle: /a/b/.../file.jsonl
function truncatePath(p, max = 64) {
  if (!p) return '';
  if (p.length <= max) return p;
  const head = p.slice(0, Math.floor(max * 0.55));
  const tail = p.slice(p.length - Math.floor(max * 0.35));
  return head + '…' + tail;
}

function MetaCell({ label, children }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 14, fontWeight: 500, wordBreak: 'break-all' }}>
        {children}
      </div>
    </div>
  );
}

function CopyPath({ path }) {
  const [copied, setCopied] = useState(false);
  if (!path) return <span className="muted">—</span>;
  return (
    <>
      <code className="path-mono" title={path}>
        {truncatePath(path)}
      </code>
      <button
        className="copy-btn"
        title="copy transcript path"
        onClick={() => {
          navigator.clipboard?.writeText(path).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {}
          );
        }}
      >
        {copied ? '✓' : '📋'}
      </button>
    </>
  );
}

// One model/agent row with in / out / cache token columns.
function TokenRow({ name, v, pct }) {
  return (
    <tr key={name} className="row">
      <td className="td">{name}</td>
      <td className="td">{fmtUSD(v.costUSD || 0)}</td>
      <td className="td">{fmtTokens(v.inputTokens || 0)}</td>
      <td className="td">{fmtTokens(v.outputTokens || 0)}</td>
      <td className="td">{fmtTokens(v.cacheReadInputTokens || 0)}</td>
      <td className="td">
        <div className="bar-track">
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </td>
    </tr>
  );
}

export default function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setLoading(true);
    setError(null);
    getRun(id)
      .then((data) => {
        setRun(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || String(err));
        setLoading(false);
      });
    const tick = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(tick);
  }, [id]);

  const taskId = run ? taskLabel(run) : null;
  const taskUrl = taskId && taskId !== 'untagged' ? linearUrl(taskId) : null;

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
            <div style={{ fontSize: '1.2em', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {run.squad || '—'} ·{' '}
              {taskUrl ? (
                <a className="link" href={taskUrl} target="_blank" rel="noreferrer">
                  {taskId} ↗
                </a>
              ) : (
                taskId
              )}
            </div>
            <div className="muted" style={{ fontFamily: "'SF Mono', 'Consolas', monospace" }}>
              {run.runId}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {(() => {
                const s = statusLabel(run);
                if (s === 'done') return <span className="badge badge-ok">done</span>;
                if (s === 'running') return <span className="badge badge-ok">running</span>;
                if (s === 'failed') return <span className="badge badge-fail">failed</span>;
                return null;
              })()}
              {statusLabel(run) === 'running' && isStale(run, now) && (
                <span className="badge badge-warn" title="active > 2h — stale?">
                  stale
                </span>
              )}
              {run.ambiguous && (
                <span className="badge badge-warn">ambiguous</span>
              )}
              {run.missing && (
                <span className="badge badge-warn">no transcript</span>
              )}
              {taskUrl && (
                <button className="copy-btn" onClick={() => navigate(`/runs?task=${encodeURIComponent(taskId)}`)}>
                  View all runs of this task
                </button>
              )}
            </div>
          </div>

          {/* Ambiguous banner — above KPIs (ux-design-v3 §5: ambiguous is loud) */}
          {run.ambiguous && (
            <div className="banner banner-warn" style={{ marginBottom: 16 }}>
              <strong>⚠ Transcript match was ambiguous</strong> — cost may belong to another session.
              Verify: <code className="path-mono">{run.transcriptPath || '—'}</code>
            </div>
          )}

          {/* Meta grid (§3.3.1) */}
          <div className="section">
            <div className="section-h">Run metadata</div>
            <div className="grid grid-4">
              <MetaCell label="Repo">{run.repo || '—'}</MetaCell>
              <MetaCell label="Branch">{run.gitBranch || '—'}</MetaCell>
              <MetaCell label="Started → Ended">
                {fmtDateTime(run.startedAt)} → {fmtDateTime(run.endedAt)}{' '}
                <span className="muted">({elapsed(run.startedAt, run.endedAt)})</span>
              </MetaCell>
              <MetaCell label="Exit code">{run.exitCode == null ? '—' : String(run.exitCode)}</MetaCell>
              <MetaCell label="Provider">{providerLabel(run)}</MetaCell>
              <MetaCell label="Config dir">{run.claudeConfigDir || '—'}</MetaCell>
              <MetaCell label="Source">{run.source || '—'}</MetaCell>
              <MetaCell label="Task ID">{taskId === 'untagged' ? '—' : taskId}</MetaCell>
            </div>
          </div>

          {/* Transcript path */}
          <div className="section">
            <div className="section-h">Transcript path</div>
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CopyPath path={run.transcriptPath} />
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

          {/* By model — in / out / cache columns */}
          <div className="section">
            <div className="section-h">By model</div>
            <table className="table">
              <thead>
                <tr className="th">
                  <td>Model</td>
                  <td>Cost</td>
                  <td>In</td>
                  <td>Out</td>
                  <td>Cache</td>
                  <td>Bar</td>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const entries = Object.entries(run.byModel || {});
                  if (entries.length === 0)
                    return (
                      <tr className="row">
                        <td className="td" colSpan={6}>—</td>
                      </tr>
                    );
                  const sum = entries.reduce((acc, [, v]) => acc + (v.costUSD || 0), 0);
                  return entries
                    .map(([name, v]) => ({ name, v, pct: sum > 0 ? ((v.costUSD || 0) / sum) * 100 : 0 }))
                    .sort((a, b) => (b.v.costUSD || 0) - (a.v.costUSD || 0))
                    .map((r) => <TokenRow key={r.name} name={r.name} v={r.v} pct={r.pct} />);
                })()}
              </tbody>
            </table>
          </div>

          {/* By agent — in / out / cache columns */}
          <div className="section">
            <div className="section-h">By agent</div>
            <table className="table">
              <thead>
                <tr className="th">
                  <td>Agent</td>
                  <td>Cost</td>
                  <td>In</td>
                  <td>Out</td>
                  <td>Cache</td>
                  <td>Bar</td>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const entries = Object.entries(run.byAgent || {});
                  if (entries.length === 0)
                    return (
                      <tr className="row">
                        <td className="td" colSpan={6}>—</td>
                      </tr>
                    );
                  const sum = entries.reduce((acc, [, v]) => acc + (v.costUSD || 0), 0);
                  return entries
                    .map(([name, v]) => ({ name, v, pct: sum > 0 ? ((v.costUSD || 0) / sum) * 100 : 0 }))
                    .sort((a, b) => (b.v.costUSD || 0) - (a.v.costUSD || 0))
                    .map((r) => <TokenRow key={r.name} name={r.name} v={r.v} pct={r.pct} />);
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
