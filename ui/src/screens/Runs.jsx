import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getRuns } from '../api';
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

const STATUSES = ['running', 'failed', 'done'];

// Task chip: ↗ link to Linear when the prefix is known, plain text otherwise.
function TaskChip({ run }) {
  const id = taskLabel(run);
  if (id === 'untagged') return <span className="muted">—</span>;
  const url = linearUrl(id);
  if (url)
    return (
      <a className="link" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {id} ↗
      </a>
    );
  return <span>{id}</span>;
}

function StatusCell({ run, now }) {
  const s = statusLabel(run);
  return (
    <>
      {s === 'done' && <span className="badge badge-ok">done</span>}
      {s === 'running' && <span className="badge badge-ok">running</span>}
      {s === 'failed' && <span className="badge badge-fail">failed</span>}
      {s === 'running' && isStale(run, now) && (
        <span className="badge badge-warn" style={{ marginLeft: 4 }} title="active > 2h — stale?">
          stale
        </span>
      )}
      {run.ambiguous && (
        <span className="badge badge-warn" style={{ marginLeft: 4 }}>
          amb
        </span>
      )}
    </>
  );
}

export default function Runs() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Read filters from URL query (single source of truth).
  const q = params.get('q') || '';
  const squad = params.get('squad') || '';
  const status = params.get('status') || '';
  const repo = params.get('repo') || '';
  const task = params.get('task') || '';
  const amb = params.get('amb') === '1';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

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
    // Refresh `now` so the stale badge stays accurate while the page is open.
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  // Filter option sets derived from loaded runs.
  const squads = useMemo(() => [...new Set(runs.map((r) => r.squad).filter(Boolean))].sort(), [runs]);
  const repos = useMemo(() => [...new Set(runs.map((r) => r.repo).filter(Boolean))].sort(), [runs]);
  const tasks = useMemo(
    () => [...new Set(runs.map((r) => r.taskId).filter(Boolean))].sort(),
    [runs]
  );

  const filtered = runs.filter((run) => {
    if (q) {
      const L = q.toLowerCase();
      if (
        !(run.squad && run.squad.toLowerCase().includes(L)) &&
        !(run.taskId && run.taskId.toLowerCase().includes(L)) &&
        !(run.runId && run.runId.toLowerCase().includes(L))
      )
        return false;
    }
    if (squad && run.squad !== squad) return false;
    if (status && statusLabel(run) !== status) return false;
    if (repo && run.repo !== repo) return false;
    if (task && run.taskId !== task) return false;
    if (amb && !run.ambiguous) return false;
    return true;
  });

  const selectStyle = {
    padding: '5px 8px',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    font: 'inherit',
    fontSize: '12px',
    background: 'var(--surface)',
  };

  return (
    <div className="page">
      <div className="page-title">Runs</div>
      <div className="page-sub">History · {filtered.length} run{filtered.length === 1 ? '' : 's'}</div>

      <div className="filter-row">
        <input
          className="filter-search"
          placeholder="Search squad / task / run ID…"
          value={q}
          onChange={(e) => setParam('q', e.target.value)}
        />
        <select className="filter-sel" value={squad} onChange={(e) => setParam('squad', e.target.value)}>
          <option value="">squad: all</option>
          {squads.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="filter-sel" value={status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">status: all</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="filter-sel" value={repo} onChange={(e) => setParam('repo', e.target.value)}>
          <option value="">repo: all</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          className="filter-sel"
          value={task}
          onChange={(e) => setParam('task', e.target.value)}
          style={{ maxWidth: 160 }}
        >
          <option value="">task: all</option>
          {tasks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="filter-check">
          <input type="checkbox" checked={amb} onChange={(e) => setParam('amb', e.target.checked ? '1' : '')} />
          only ambiguous
        </label>
        {(q || squad || status || repo || task || amb) && (
          <button className="filter-clear" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            clear
          </button>
        )}
      </div>

      {loading && <div className="empty">Loading…</div>}
      {error && <div className="card">Error: {error}</div>}
      {!loading && !error && filtered.length === 0 && <div className="empty">No runs match.</div>}

      {!loading && !error && filtered.length > 0 && (
        <table className="table">
          <thead>
            <tr className="th">
              <td>Started</td>
              <td>Squad</td>
              <td>Task</td>
              <td>Repo</td>
              <td>Dur</td>
              <td>Cost</td>
              <td>Tokens</td>
              <td>Models</td>
              <td>St</td>
            </tr>
          </thead>
          <tbody>
            {filtered.map((run) => {
              const mix = modelMix(run.byModel || {});
              const totalTokens =
                (run.totals?.inputTokens || 0) + (run.totals?.outputTokens || 0);

              let modelsCell = '—';
              if (mix.length > 0) {
                const top = mix.slice(0, 2);
                modelsCell = mix.length > 2 ? `${top[0].slug} (+${mix.length - 1})` : top.map((m) => m.slug).join(', ');
              }

              return (
                <tr
                  key={run.runId}
                  className="row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/runs/${run.runId}`)}
                >
                  <td className="td">{fmtDateTime(run.startedAt)}</td>
                  <td className="td">{run.squad || '—'}</td>
                  <td className="td">
                    <TaskChip run={run} />
                  </td>
                  <td className="td">{run.repo || '—'}</td>
                  <td className="td">{elapsed(run.startedAt, run.endedAt)}</td>
                  <td className="td">{fmtUSD(run.totals?.costUSD || 0)}</td>
                  <td className="td">{fmtTokens(totalTokens)}</td>
                  <td className="td">{modelsCell}</td>
                  <td className="td">
                    <StatusCell run={run} now={now} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
