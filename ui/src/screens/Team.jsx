// Team screen (FOC-791) — the high-level picture: who delegates to whom, how
// often, at what cost. Three scopes (overall / group / one ticket live) over
// the same per-message priced telemetry as the cost screens; the diagram reads
// You → Supervisor (coach) → the four leads → each lead's line-up and bench.
// State lives in the URL (teamModel.js); the ticket scope polls every 5 s,
// the other scopes every 30 s — usePoll pauses while the tab is hidden.

import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import './team.css';
import { getTeam } from '../api';
import { usePoll } from '../hooks/usePoll';
import PanelBoundary from '../components/cockpit/PanelBoundary';
import {
  parseTeamQuery,
  teamQueryParams,
  teamQueryString,
  diagramModel,
  lineupTable,
  childrenSummary,
  fmtUsd,
  fmtPct,
} from '../teamModel';

const SCOPES = [
  ['overall', 'Overall'],
  ['group', 'Group'],
  ['ticket', 'Ticket'],
];
const PERIODS = ['7d', '30d', '90d', 'all'];
const TEXT_FILTERS = ['repo', 'milestone', 'type'];

export default function Team() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = parseTeamQuery(location.search);

  // Every control writes back to the URL — a scope/period/filter change is
  // shareable and the poll re-arms off the query string.
  const patch = (next) => {
    navigate('/team?' + teamQueryString({ ...state, ...next }));
  };

  // Draft inputs commit on Apply (or Enter), not on every keystroke — each
  // commit re-arms the poll and hits the server.
  const [draft, setDraft] = useState(() => ({
    repo: state.repo,
    milestone: state.milestone,
    type: state.type,
    epic: state.epic,
    size: state.size,
  }));
  const [ticketDraft, setTicketDraft] = useState(state.ticket);

  const params = teamQueryParams(state);
  const qs = teamQueryString(state);

  // The drafts re-seed from the parsed URL whenever the query string changes
  // (browser back/forward) — the URL stays the single source of truth.
  useEffect(() => {
    setDraft({ repo: state.repo, milestone: state.milestone, type: state.type, epic: state.epic, size: state.size });
    setTicketDraft(state.ticket);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);

  // Ticket scope with no committed ticket id must not poll — the route
  // answers 400 without one. The fetcher returns null (no request) and the
  // screen shows the "enter a ticket id" empty state until Watch commits one.
  const ticketPending = state.scope === 'ticket' && !state.ticket;
  const { data, error, loading, refresh } = usePoll(
    (signal) => (ticketPending ? null : getTeam(params, signal)),
    state.scope === 'ticket' ? 5000 : 30000,
    [qs],
  );

  const diagram = diagramModel(data);
  const unsupported = (data && data.filters && data.filters.unsupported) || [];
  const squads = diagram.leads;
  const allIdle = squads.length > 0 && squads.every((s) => !s.ran);

  // Detail tab: the URL-less squad tab, defaulting to dev, falling back to
  // the first squad the payload actually carries.
  const [tab, setTab] = useState('dev');
  const active = squads.find((s) => s.key === tab) || squads[0] || null;
  const activeRows = active ? lineupTable(data.squads.find((s) => s.key === active.key)) : [];
  const children = active ? childrenSummary(data.squads.find((s) => s.key === active.key)) : [];
  const links = (active && data && data.squads.find((s) => s.key === active.key)?.links) || {};

  const applyFilters = () => {
    patch({
      repo: draft.repo.trim(),
      milestone: draft.milestone.trim(),
      type: draft.type.trim(),
      epic: draft.epic.trim(),
      size: draft.size.trim(),
    });
  };

  const windowLabel =
    data && data.period
      ? (data.period.from || '—') + ' → ' + (data.period.to || '—') + (data.period.days != null ? ' (' + data.period.days + 'd)' : '')
      : '—';

  return (
    <div className="team">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div className="section-h" style={{ marginBottom: 2 }}>Team</div>
        <span className="muted" style={{ fontSize: 12 }}>
          {data?.generatedAt ? 'generated ' + new Date(data.generatedAt).toLocaleTimeString() : loading ? 'loading…' : '—'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={refresh}>
          Refresh
        </button>
      </div>

      {/* Controls row: scope switch, period, per-scope inputs. */}
      <div className="team-controls">
        <div className="team-scope" role="tablist" aria-label="Team scope">
          {SCOPES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={state.scope === id}
              className={state.scope === id ? 'team-scope-btn team-scope-active' : 'team-scope-btn'}
              onClick={() => patch({ scope: id })}
            >
              {label}
            </button>
          ))}
        </div>

        {state.scope !== 'ticket' && (
          <select
            className="team-select"
            aria-label="Period"
            value={state.period}
            onChange={(e) => patch({ period: e.target.value })}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}

        {state.scope === 'group' && (
          <div className="team-filters">
            {TEXT_FILTERS.map((k) => (
              <input
                key={k}
                className="team-input"
                placeholder={k}
                aria-label={'Filter by ' + k}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
              />
            ))}
            {['epic', 'size'].map((k) => (
              <input
                key={k}
                className="team-input"
                placeholder={k}
                aria-label={'Filter by ' + k}
                disabled={unsupported.includes(k)}
                title={unsupported.includes(k) ? 'not supported yet' : undefined}
                value={unsupported.includes(k) ? '' : draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
              />
            ))}
            <button type="button" className="btn-secondary" onClick={applyFilters}>
              Apply
            </button>
          </div>
        )}

        {state.scope === 'ticket' && (
          <div className="team-filters">
            <input
              className="team-input"
              placeholder="ticket id (e.g. FOC-123)"
              aria-label="Ticket display id"
              value={ticketDraft}
              onChange={(e) => setTicketDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') patch({ ticket: ticketDraft.trim() }); }}
            />
            <button type="button" className="btn-secondary" onClick={() => patch({ ticket: ticketDraft.trim() })}>
              Watch
            </button>
            <span className="muted team-note">watching, refresh ≤ 5 s</span>
          </div>
        )}
      </div>

      {error && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          Team unavailable: {error.data?.error || error.message}
        </div>
      )}

      {!error && allIdle && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          no runs in this window
        </div>
      )}

      {ticketPending && (
        <div className="banner" style={{ marginTop: 10 }}>
          Enter a ticket id (e.g. FOC-123) and press Watch to follow it live.
        </div>
      )}

      {/* The diagram — three tiers with CSS-drawn connectors. Hidden while the
          ticket scope waits for a committed id (the poll holds off too). */}
      {!ticketPending && (
      <PanelBoundary label="Team diagram">
        <div className="team-diagram">
          <div className="team-tier">
            <div className="team-card team-card-you">
              <div className="team-card-title">You</div>
            </div>
          </div>
          <div className="team-conn-v" aria-hidden="true" />
          <div className="team-tier">
            <div className="team-card team-card-sup">
              <div className="team-card-title">Supervisor (coach)</div>
              <div className="team-card-model">{diagram.supervisor.model || '—'}</div>
              <div className="team-card-cost">{fmtUsd(diagram.supervisor.costUsd)}</div>
            </div>
          </div>
          <div className="team-conn-v" aria-hidden="true" />
          <div className="team-leads">
            {squads.map((lead) => (
              <div key={lead.key} className={'team-squad-col' + (lead.ran ? '' : ' team-greyed')}>
                <div className="team-drop" aria-hidden="true" />
                <div className="team-card team-card-lead">
                  <div className="team-card-head">
                    <span className="team-card-title">{lead.label}</span>
                    {!lead.ran && <span className="team-notrun">not run</span>}
                  </div>
                  <div className="team-card-model">{lead.model || '—'}</div>
                  <div className="team-card-cost">{fmtUsd(lead.costUsd)}</div>
                </div>
                {lead.ran &&
                  lead.lineup.map((row) => (
                    <div key={row.role} className="team-card team-card-role">
                      <div className="team-card-head">
                        <span className="team-card-title">{row.role}</span>
                        <span className="team-card-pct">{fmtPct(row.pickShare)}</span>
                      </div>
                      <div className="team-card-model">{row.model || '—'}</div>
                      <div
                        className="team-bar"
                        role="img"
                        aria-label={row.role + ' ' + fmtPct(row.pickShare) + ' of picks'}
                      >
                        <div className="team-bar-fill" style={{ width: row.barPct + '%' }} />
                      </div>
                      <div className="team-card-cost">{fmtUsd(row.costUsd)}</div>
                    </div>
                  ))}
                {lead.bench.length > 0 && (
                  <div className="team-card team-card-bench">
                    <div className="team-card-title">Bench</div>
                    {lead.bench.map((b) => (
                      <div key={b.role} className="team-bench-row">
                        <span>{b.role}</span>
                        <span className="muted">{fmtPct(b.pickShare)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </PanelBoundary>
      )}

      {/* Line-up detail — tabs per squad, roles table, insight, links. */}
      {!ticketPending && (
      <PanelBoundary label="Line-up detail">
        {active ? (
          <div className="team-detail">
            <div className="team-tabs" role="tablist" aria-label="Squad line-up">
              {squads.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={active.key === s.key}
                  className={active.key === s.key ? 'team-tab team-tab-active' : 'team-tab'}
                  onClick={() => setTab(s.key)}
                >
                  {s.key}
                  {!s.ran && ' (not run)'}
                </button>
              ))}
            </div>

            <div className="muted team-detail-head">
              lead {active.model || '—'} · squad cost {fmtUsd(active.costUsd)} · lead share{' '}
              {fmtPct(data.squads.find((s) => s.key === active.key)?.lead?.costShare)} · {active.sessions ?? '—'} sessions
            </div>

            {children.length > 0 && (
              <div className="team-children">
                {children.map((c) => (
                  <span key={c.label} className={'team-child' + (c.greyed ? ' team-greyed' : '')}>
                    {c.label}
                  </span>
                ))}
              </div>
            )}

            <div className="team-table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Model</th>
                    <th>Picks</th>
                    <th>Pick share</th>
                    <th>Cost</th>
                    <th>Cost share</th>
                    <th>Placement</th>
                    <th>Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((row) => (
                    <tr key={row.role}>
                      <td>{row.role}</td>
                      <td className="team-mono">{row.model}</td>
                      <td>{row.picks ?? '—'}</td>
                      <td>{row.pickShare}</td>
                      <td>{row.costUsd}</td>
                      <td>{row.costShare}</td>
                      <td>{row.placement}</td>
                      <td>{row.overallPickShare ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="team-insight">{data.squads.find((s) => s.key === active.key)?.insight || '—'}</p>

            <div className="team-links">
              {links.prompts && <Link to={links.prompts}>Prompts</Link>}
              {links.tools && <Link to={links.tools}>Agent tools</Link>}
              {links.models && <Link to={links.models}>Squad models</Link>}
            </div>
          </div>
        ) : (
          <div className="muted" style={{ padding: 8 }}>no squads in the payload</div>
        )}
      </PanelBoundary>
      )}

      {data?.groundTruth && (
        <div className="muted team-foot">
          {data.groundTruth} · window {windowLabel}
        </div>
      )}
    </div>
  );
}
