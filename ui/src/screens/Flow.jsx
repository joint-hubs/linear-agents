import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getFlow, getFlowLog } from '../api';
import { fmtUSD, fmtTokens, fmtDateTime, fmtTime, taskLabel } from '../utils';

// ---------------------------------------------------------------------------
// Static pipeline config — mirrors docs/diagrams/00_overview.puml (v2.2).
// `key` = attributionAgent in transcripts ("_lead" = squad lead). Agent keys
// that show up in /api/flow but aren't listed here are appended per squad, so
// new subagents appear without a UI change.
// ---------------------------------------------------------------------------
const PIPELINE = [
  {
    squad: 'plan',
    label: '1 · PLAN',
    lead: 'Opus 4.8',
    nodes: [
      { key: '_lead', label: 'Lead (orchestration)' },
      { key: 'discovery', label: 'Discovery' },
      { key: 'spec', label: 'Spec (+ADR)' },
      { key: 'spec-review', label: 'Spec review' },
      { key: 'decomposer', label: 'Decompose + estimate' },
      { key: 'push', label: 'Push to Linear' },
      { key: 'worker', label: 'worker' },
      { key: 'flash', label: 'flash' },
    ],
  },
  {
    squad: 'dev',
    label: '2 · DEV',
    lead: 'GLM-5.2',
    nodes: [
      { key: '_lead', label: 'Lead (orchestration)' },
      { key: 'recon', label: 'Recon (context packet)' },
      { key: 'implementer', label: 'Implement' },
      { key: 'refactorer', label: 'Refactor (multi-file)' },
      { key: 'debugger', label: 'Debug (hard)' },
      { key: 'worker', label: 'worker' },
      { key: 'flash', label: 'flash' },
    ],
  },
  {
    squad: 'review',
    label: '3 · REVIEW',
    lead: 'GLM-5.2',
    nodes: [
      { key: '_lead', label: 'Lead (orchestration)' },
      { key: 'first-pass', label: 'First-pass' },
      { key: 'security', label: 'Security (SAST)' },
      { key: 'deep', label: 'Deep review' },
      { key: 'worker', label: 'worker' },
      { key: 'flash', label: 'flash' },
    ],
  },
  {
    squad: 'test',
    label: '4 · TEST',
    lead: 'MiniMax M3',
    nodes: [
      { key: '_lead', label: 'Lead (orchestration)' },
      { key: 'deployer', label: 'Deploy (GCP)' },
      { key: 'scenario-gen', label: 'Scenarios' },
      { key: 'runner', label: 'Run tests' },
      { key: 'root-cause', label: 'Root-cause' },
      { key: 'worker', label: 'worker' },
      { key: 'flash', label: 'flash' },
    ],
  },
  {
    squad: 'cadence',
    label: '0 · CADENCE',
    lead: 'MiniMax M3',
    nodes: [
      { key: '_lead', label: 'Lead (orchestration)' },
      { key: 'collector', label: 'Collect' },
      { key: 'retro', label: 'Retro' },
      { key: 'digest', label: 'Digest (PL)' },
      { key: 'worker', label: 'worker' },
      { key: 'flash', label: 'flash' },
    ],
  },
];

/** Short model name: "z-ai/glm-5.2-20260616" -> "glm-5.2". */
function modelShort(slug) {
  if (!slug) return '?';
  return slug.split('/').pop().replace(/-\d{8}$/, '');
}

/** Dominant model of a node (most turns). */
function topModel(models) {
  const entries = Object.entries(models || {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

/**
 * Human summary of a tool call. Tool inputs arrive as (possibly truncated)
 * JSON strings — parse known shapes and show WHAT the call did, not raw JSON.
 */
function toolSummary(name, inputStr) {
  let o = null;
  try {
    o = JSON.parse(inputStr);
  } catch {
    return String(inputStr || '').slice(0, 110);
  }
  switch (name) {
    case 'Bash':
      return o.description || String(o.command || '').slice(0, 110);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return baseName(o.file_path);
    case 'Glob':
      return o.pattern;
    case 'Grep':
      return o.pattern + (o.path ? ' · ' + baseName(o.path) : '');
    case 'Task':
      return (
        (o.subagent_type || '') +
        (o.description ? ' — ' + o.description : o.prompt ? ' — ' + String(o.prompt).slice(0, 80) : '')
      );
    case 'TodoWrite':
      return 'update task list';
    case 'WebFetch':
    case 'WebSearch':
      return o.url || o.query || '';
    default: {
      const s = JSON.stringify(o);
      return s.length > 110 ? s.slice(0, 110) + '…' : s;
    }
  }
}

function elapsedMs(a, b) {
  if (!a || !b) return null;
  return new Date(b).getTime() - new Date(a).getTime();
}

function fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function NodeCard({ node, stats, selected, onClick }) {
  const has = stats && stats.executions > 0;
  return (
    <button
      onClick={onClick}
      className={'flow-node' + (has ? '' : ' off') + (selected ? ' sel' : '')}
    >
      <div className="flow-node-t">{node.label}</div>
      <div className="flow-node-m">
        {has ? (
          <>
            {stats.executions}× · {fmtUSD(stats.costUSD)} ·{' '}
            <code style={{ fontSize: 10 }}>{modelShort(topModel(stats.models))}</code>
          </>
        ) : (
          'no runs yet'
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Execution log drawer: analysis strip + tool histogram + filterable stream.
// ---------------------------------------------------------------------------
function LogDrawer({ squad, node, run, onClose }) {
  const [log, setLog] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('all'); // all | text | tools
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setLog(null);
    setError(null);
    getFlowLog(run.runId, node.key)
      .then((d) => alive && setLog(d))
      .catch((e) => alive && setError(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, [run.runId, node.key]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Enrich turns: precomputed tool summaries; drop turns with no content at all
  // (thinking-only turns are pure noise in this view).
  const turns = useMemo(() => {
    const raw = log?.turns || [];
    return raw
      .map((t, i) => ({
        ...t,
        n: i + 1,
        tools: (t.toolUses || []).map((u) => ({ name: u.name, sum: toolSummary(u.name, u.input) })),
      }))
      .filter((t) => (t.text && t.text.trim()) || t.tools.length > 0);
  }, [log]);

  // Analysis: duration, output tokens, tool histogram.
  const stats = useMemo(() => {
    const withTs = turns.filter((t) => t.ts);
    const dur =
      withTs.length >= 2 ? elapsedMs(withTs[0].ts, withTs[withTs.length - 1].ts) : null;
    const out = turns.reduce((s, t) => s + (t.usage?.outputTokens || 0), 0);
    const hist = {};
    for (const t of turns) for (const u of t.tools) hist[u.name] = (hist[u.name] || 0) + 1;
    const histSorted = Object.entries(hist).sort((a, b) => b[1] - a[1]);
    return { dur, out, histSorted, toolCalls: histSorted.reduce((s, [, n]) => s + n, 0) };
  }, [turns]);

  const shown = useMemo(() => {
    const L = q.trim().toLowerCase();
    return turns.filter((t) => {
      if (mode === 'text' && !(t.text && t.text.trim())) return false;
      if (mode === 'tools' && t.tools.length === 0) return false;
      if (!L) return true;
      if (t.text && t.text.toLowerCase().includes(L)) return true;
      return t.tools.some(
        (u) => u.name.toLowerCase().includes(L) || String(u.sum).toLowerCase().includes(L)
      );
    });
  }, [turns, mode, q]);

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="execution log">
        <div className="drawer-h">
          <div>
            <div className="drawer-title">
              {squad.label} → {node.label}
            </div>
            <div className="drawer-sub">
              <Link className="link" to={'/runs/' + run.runId}>
                {run.runId}
              </Link>
              {' · '}
              {taskLabel(run)} · {run.startedAt ? fmtDateTime(run.startedAt) : '—'}
            </div>
          </div>
          <button className="drawer-x" onClick={onClose} title="close (Esc)">
            ✕
          </button>
        </div>

        <div className="drawer-stats">
          <span>
            turns <b>{turns.length}</b>
          </span>
          <span>
            duration <b>{fmtDur(stats.dur)}</b>
          </span>
          <span>
            output <b>{fmtTokens(stats.out)}</b>
          </span>
          <span>
            tool calls <b>{stats.toolCalls}</b>
          </span>
          <span>
            cost <b>{fmtUSD(run.costUSD)}</b>
          </span>
        </div>

        {stats.histSorted.length > 0 && (
          <div className="drawer-filter" style={{ borderBottom: '1px solid var(--border)' }}>
            {stats.histSorted.map(([name, n]) => (
              <span className="hist-chip" key={name}>
                {name} <b>{n}×</b>
              </span>
            ))}
          </div>
        )}

        <div className="drawer-filter">
          {['all', 'text', 'tools'].map((m) => (
            <button key={m} className={'zbtn' + (mode === m ? ' on' : '')} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
          <input
            className="filter-search"
            placeholder="Search in this log…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="drawer-body">
          {error && <div className="banner banner-warn">log error: {error}</div>}
          {!error && !log && <div className="muted" style={{ padding: 16 }}>loading log…</div>}
          {log?.error && <div className="banner banner-warn">{log.error}</div>}
          {log && !log.error && shown.length === 0 && (
            <div className="muted" style={{ padding: 16 }}>
              {turns.length === 0 ? 'no turns recorded for this step in this run' : 'no turns match'}
            </div>
          )}
          {shown.map((t) => (
            <div className="turn" key={t.n}>
              <div className="turn-meta">
                <span className="n">#{t.n}</span>
                <span>{t.ts ? fmtTime(t.ts) : '—'}</span>
                <code style={{ background: 'none', padding: 0 }}>{modelShort(t.model)}</code>
                {t.usage?.outputTokens > 0 && <span>{fmtTokens(t.usage.outputTokens)} out</span>}
                {t.truncated && <span>(truncated)</span>}
              </div>
              {t.text && t.text.trim() && <pre className="turn-text">{t.text}</pre>}
              {t.tools.length > 0 && (
                <div style={{ marginTop: t.text && t.text.trim() ? 8 : 0 }}>
                  {t.tools.map((u, j) => (
                    <span className="tool-chip" key={j} title={u.sum}>
                      <span className="tname">{u.name}</span>
                      <span className="tsum">{u.sum}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

function ExecutionsPanel({ squad, node, stats, onOpenLog }) {
  if (!stats || stats.executions === 0) {
    return <div className="empty">No executions of “{node.label}” recorded yet.</div>;
  }

  return (
    <div>
      <div className="section-h">
        {squad.label} → {node.label}
        <span className="muted" style={{ marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>
          {stats.executions} execution{stats.executions === 1 ? '' : 's'} · {stats.turns} turns ·{' '}
          {fmtUSD(stats.costUSD)} · {fmtTokens(stats.inputTokens + stats.outputTokens)} tokens
        </span>
      </div>

      <table className="table">
        <thead>
          <tr className="th">
            <td>Started</td>
            <td>Run</td>
            <td>Task</td>
            <td>Status</td>
            <td>Models</td>
            <td style={{ textAlign: 'right' }}>Turns</td>
            <td style={{ textAlign: 'right' }}>Cost</td>
            <td></td>
          </tr>
        </thead>
        <tbody>
          {stats.runs.map((r) => (
            <tr key={r.runId}>
              <td className="td" style={{ whiteSpace: 'nowrap' }}>
                {r.startedAt ? fmtDateTime(r.startedAt) : '—'}
              </td>
              <td className="td">
                <Link className="link" to={'/runs/' + r.runId}>
                  <code style={{ fontSize: 11, background: 'none', padding: 0 }}>
                    {r.runId.slice(0, 19)}
                  </code>
                </Link>
              </td>
              <td className="td">{taskLabel(r) || '—'}</td>
              <td className="td">
                <span
                  className={
                    'badge ' +
                    (r.status === 'failed'
                      ? 'badge-fail'
                      : r.status === 'running'
                        ? 'badge-run'
                        : 'badge-ok')
                  }
                >
                  {r.status || '—'}
                </span>
              </td>
              <td className="td" style={{ whiteSpace: 'nowrap' }}>
                {r.models.map((m) => (
                  <code key={m} style={{ fontSize: 10.5, marginRight: 5 }}>
                    {modelShort(m)}
                  </code>
                ))}
              </td>
              <td className="td" style={{ textAlign: 'right' }}>{r.turns}</td>
              <td className="td" style={{ textAlign: 'right' }}>{fmtUSD(r.costUSD)}</td>
              <td className="td" style={{ textAlign: 'right' }}>
                <button className="btn-secondary" onClick={() => onOpenLog(r)}>
                  view log
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Flow() {
  const [flow, setFlow] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null); // { squad, key }
  const [logRun, setLogRun] = useState(null); // run whose log is open in the drawer

  useEffect(() => {
    getFlow()
      .then(setFlow)
      .catch((e) => setError(e.message || String(e)));
  }, []);

  if (error)
    return (
      <div className="page">
        <div className="banner banner-warn">API error: {error}</div>
      </div>
    );
  if (!flow)
    return (
      <div className="page">
        <div className="muted">loading…</div>
      </div>
    );

  // Merge static pipeline with live agent keys (unknown keys appended).
  const columns = PIPELINE.map((col) => {
    const live = flow.squads?.[col.squad]?.agents || {};
    const known = new Set(col.nodes.map((n) => n.key));
    const extra = Object.keys(live)
      .filter((k) => !known.has(k))
      .sort()
      .map((k) => ({ key: k, label: k }));
    return { ...col, nodes: [...col.nodes, ...extra], live };
  });

  const selCol = sel && columns.find((c) => c.squad === sel.squad);
  const selNode = selCol && selCol.nodes.find((n) => n.key === sel.key);
  const selStats = selCol && selCol.live[sel.key];

  return (
    <div className="page">
      <div className="page-title">Flow</div>
      <div className="page-sub">
        Interactive pipeline overview · every step = subagent role · click a step to browse
        executions and model-response logs
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 10 }}>
        {columns.map((col, i) => (
          <React.Fragment key={col.squad}>
            {i > 0 && (
              <div className="muted" style={{ alignSelf: 'center', fontSize: 18, flexShrink: 0 }}>
                →
              </div>
            )}
            <div style={{ minWidth: 200, flexShrink: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 13 }}>{col.label}</div>
              <div className="muted" style={{ fontSize: 11, margin: '2px 0 10px' }}>
                lead: {col.lead}
              </div>
              {col.nodes.map((n) => (
                <NodeCard
                  key={n.key}
                  node={n}
                  stats={col.live[n.key]}
                  selected={sel && sel.squad === col.squad && sel.key === n.key}
                  onClick={() => {
                    setSel({ squad: col.squad, key: n.key });
                    setLogRun(null);
                  }}
                />
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>

      <div className="section">
        {sel ? (
          <ExecutionsPanel squad={selCol} node={selNode} stats={selStats} onOpenLog={setLogRun} />
        ) : (
          <div className="empty">Select a pipeline step above to see its executions and logs.</div>
        )}
      </div>

      {logRun && selCol && selNode && (
        <LogDrawer squad={selCol} node={selNode} run={logRun} onClose={() => setLogRun(null)} />
      )}
    </div>
  );
}
