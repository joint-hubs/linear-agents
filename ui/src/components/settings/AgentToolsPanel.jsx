// Agent tools panel (FOC-906, spec §3) — read-only view of every agent's
// permission lists, MCP servers, skills and hooks, plus the check findings.
// Editing lives in the CLI (`fenix agent-tools allow|ask|deny|remove`); this
// panel writes nothing.

import { useEffect, useState } from 'react';
import { getAgentTools } from '../../api';
import { agentToolsView, findingCounts } from '../../settingsModel';

const LIST_ORDER = ['allow', 'ask', 'deny'];
const LEVEL_CLASS = { error: 'at-badge-error', warning: 'at-badge-warning', info: 'at-badge-info' };

// One chip per level with a count ("1 warning", "12 infos"), zero levels
// omitted, error > warning > info — the per-finding details stay in the
// findings list below, so the header stays readable with 12 infos.
function FindingChips({ findings }) {
  return Object.entries(findingCounts(findings))
    .filter(([, n]) => n > 0)
    .map(([level, n]) => (
      <span key={level} className={`at-badge ${LEVEL_CLASS[level]}`}>
        {n} {level}
        {n === 1 ? '' : 's'}
      </span>
    ));
}

function RuleList({ kind, rules }) {
  if (!rules.length) return null;
  return (
    <details className="at-list">
      <summary>
        {kind} ({rules.length})
      </summary>
      <ul>
        {rules.map((rule) => (
          <li key={rule} className="st-mono">
            {rule}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AgentCard({ row }) {
  return (
    <div className="at-card">
      <div className="at-card-head">
        <span className="at-agent">{row.agent}</span>
        {row.error ? (
          <span className="at-badge at-badge-error">unreadable</span>
        ) : (
          <>
            <span className="st-chip">{row.counts.allow} allow</span>
            <span className="st-chip">{row.counts.ask} ask</span>
            <span className="st-chip">{row.counts.deny} deny</span>
            <FindingChips findings={row.findings} />
          </>
        )}
      </div>
      {row.error && <div className="banner banner-warn">unreadable: {row.error}</div>}
      {row.settingsPath && <div className="at-path st-mono">{row.settingsPath}</div>}
      <div className="at-lists">
        {LIST_ORDER.map((kind) => (
          <RuleList key={kind} kind={kind} rules={row.lists[kind]} />
        ))}
      </div>
      {row.defaultMode && <div className="at-kv">default mode: {row.defaultMode}</div>}
      {row.additionalDirectories.length > 0 && (
        <div className="at-kv">
          additional directories: <span className="st-mono">{row.additionalDirectories.join(', ')}</span>
        </div>
      )}
      {row.mcp.length > 0 && (
        <div className="at-kv">
          MCP servers:
          <ul className="at-sub">
            {row.mcp.map((s, i) => (
              <li key={i}>
                <span className={s.reachable ? 'st-tone-ok' : 'st-tone-danger'}>
                  {s.reachable ? '✓' : '✗'}
                </span>{' '}
                {s.server}
                {s.via ? ` · via ${s.via}` : ''}
                {s.deniedBy ? ` · denied by ${s.deniedBy}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.skills.length > 0 && (
        <div className="at-kv">
          Skills:
          <ul className="at-sub">
            {row.skills.map((s, i) => (
              <li key={i} className="st-mono">
                {s.name} · {s.source || '—'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.hooks.length > 0 && (
        <div className="at-kv">
          Hooks:
          <ul className="at-sub">
            {row.hooks.map((h) => (
              <li key={h.event}>
                {h.event} → {h.count}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.findings.length > 0 && (
        <ul className="at-findings">
          {row.findings.map((f, i) => (
            <li key={i}>
              <span className={`at-badge ${LEVEL_CLASS[f.level] || 'at-badge-info'}`}>{f.level}</span>{' '}
              {f.list} {f.rule} — {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AgentToolsPanel() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getAgentTools(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setView(agentToolsView(d));
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setError(e);
      });
    return () => ctrl.abort();
  }, []);

  if (error) {
    return (
      <div className="banner banner-warn">
        Agent tools unavailable: {(error.data && error.data.error) || error.message}
      </div>
    );
  }
  if (!view) return <div className="muted" style={{ padding: '12px 0' }}>Loading agent tools…</div>;

  return (
    <div className="st-form">
      <div className="at-top">
        Root: <span className="st-mono">{view.root || 'unknown'}</span>
        {view.summaryText && <span className="st-label"> · check: {view.summaryText}</span>}
      </div>
      {view.agents.length === 0 ? (
        <div className="muted" style={{ padding: '12px 0' }}>
          No agents found under this root.
        </div>
      ) : (
        view.agents.map((row) => <AgentCard key={row.agent} row={row} />)
      )}
      <div className="muted" style={{ fontSize: 11.5 }}>
        read-only here — edits go through the CLI (`fenix agent-tools allow|ask|deny|remove`)
      </div>
    </div>
  );
}
