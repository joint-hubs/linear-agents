// Work board (FOC-784 + task workspaces, PRD §3–4) — where is each ticket,
// what did it cost. The board is home (/ and /work alias). The board polls
// /api/work/tickets every 15 s (usePoll aborts in-flight requests and keeps
// the last data on a failed fetch — a bad poll never blanks the board), the
// ticket detail opens as a side panel (TicketPanel) when :ticket is set, and
// a task with a known canonical key opens its own cockpit at
// /work/:taskKey/cockpit. Filters (milestone / priority / label) live in the
// URL via filtersFromQuery / queryFromFilters, so a refresh or a shared link
// keeps the view. A ticket without a canonical key never gets a cockpit link
// invented from its identifier (PRD §3) — the detail's Start/resolve flow
// covers it.

import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import './work.css';
import { getWorkTickets } from '../api';
import { usePoll } from '../hooks/usePoll';
import {
  STAGES,
  groupByStage,
  staleLabel,
  labelNames,
  filtersFromQuery,
  queryFromFilters,
} from '../workModel';
import { cockpitUrl } from '../taskCockpitModel';
import PanelBoundary from '../components/cockpit/PanelBoundary';
import TicketCard from '../components/work/TicketCard';
import TicketPanel from '../components/work/TicketPanel';

// Distinct, sorted filter values from the tickets on the board (the Ready
// column's Linear issues are what the server filters; the board offers what it
// can actually see).
function distinctValues(tickets, pick) {
  const out = new Set();
  for (const t of tickets || []) {
    const v = pick(t);
    if (v) out.add(v);
  }
  return [...out].sort();
}

export default function Work() {
  const { ticket: ticketId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const filters = filtersFromQuery(searchParams.toString());
  // deps key: a filter change re-arms the poll (immediate fetch + fresh
  // interval); the fetcher itself always sees the latest filters.
  const filtersKey = queryFromFilters(filters);

  const { data, error, loading, refresh } = usePoll(
    (signal) => getWorkTickets(filters, signal),
    15000,
    [filtersKey],
  );

  const tickets = data?.tickets || [];
  const columns = groupByStage(tickets);
  const now = new Date();
  const milestones = distinctValues(tickets, (t) => t && t.milestone);
  const priorities = distinctValues(tickets, (t) => t && t.priority && t.priority.name);

  // The label filter's options must not disappear once a label filter is
  // applied — the filtered payload only carries the tickets (and labels) that
  // matched. The catalog is a running union of every label name seen this
  // screen life: it grows, it never shrinks (a stale option that no longer
  // matches anything is harmless — the board just shows fewer tickets).
  const [labelCatalog, setLabelCatalog] = useState([]);
  useEffect(() => {
    const names = labelNames(tickets);
    if (names.length === 0) return;
    setLabelCatalog((prev) => {
      const set = new Set(prev);
      let added = false;
      for (const n of names) {
        if (!set.has(n)) {
          set.add(n);
          added = true;
        }
      }
      return added ? [...set].sort() : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Filters navigate to /work + the query — a change while the detail panel is
  // open returns to the board with the filters kept in the URL.
  const setFilter = (key, value) => {
    navigate('/work' + queryFromFilters({ ...filters, [key]: value || null }));
  };
  const closePanel = () => navigate('/work' + filtersKey);
  const openTicket = (id) => navigate('/work/' + encodeURIComponent(id));
  // Ask about a ticket: with a known canonical key the question belongs to
  // that task's cockpit — the global Supervisor is never prefilled with a
  // task's business. Unknown identity stays in the ticket detail for resolution.
  const askSupervisor = (id) => {
    const t = tickets.find((x) => x && x.taskId === id);
    if (t && t.taskKey) {
      navigate(cockpitUrl(t.taskKey, 'About ' + id + ': '));
      return;
    }
    openTicket(id);
  };

  // The detail panel's canonical key, when the board payload enriched the
  // ticket with one (historical tickets may not carry it — PRD §3).
  const panelTaskKey = (tickets.find((x) => x && x.taskId === ticketId) || {}).taskKey || null;

  return (
    <div className="work">
      <div className="wk-head">
        <div className="section-h" style={{ marginBottom: 2 }}>Work</div>
        {data && (
          <span className="muted" style={{ fontSize: 12 }}>
            costs {staleLabel(data.cost, now)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={refresh}
        >
          Refresh
        </button>
      </div>

      {data && data.linear && data.linear.ok === false && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          Linear unavailable: {data.linear.error || 'no reason given'} — stages come from Fenix
          data only.
        </div>
      )}

      {error && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          Work board unavailable: {error.data?.error || error.message} — showing the last data.
        </div>
      )}

      <div className="wk-filters">
        <select
          className="filter-sel"
          value={filters.milestone || ''}
          onChange={(e) => setFilter('milestone', e.target.value)}
          aria-label="Filter by milestone"
        >
          <option value="">milestone: all</option>
          {milestones.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          className="filter-sel"
          value={filters.priority || ''}
          onChange={(e) => setFilter('priority', e.target.value)}
          aria-label="Filter by priority"
        >
          <option value="">priority: all</option>
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="filter-sel"
          value={filters.label || ''}
          onChange={(e) => setFilter('label', e.target.value)}
          aria-label="Filter by label"
        >
          <option value="">label: all</option>
          {labelCatalog.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <PanelBoundary label="Work board">
        {loading && !data ? (
          <div className="muted" style={{ padding: '20px 0' }}>Loading tickets…</div>
        ) : (
          <div className="wk-board">
            {STAGES.map((s) => (
              <div key={s.key} className="wk-col">
                <div className="wk-col-h">
                  <span>{s.label}</span>
                  <span className="wk-col-count">{columns[s.key].length}</span>
                </div>
                <div className="wk-col-body">
                  {columns[s.key].length === 0 ? (
                    <div className="wk-empty">No tickets</div>
                  ) : (
                    columns[s.key].map((t, i) => (
                      <TicketCard key={t.taskId || i} ticket={t} now={now} onOpen={openTicket} />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelBoundary>

      {ticketId && (
        <PanelBoundary label="Ticket detail">
          <TicketPanel
            id={ticketId}
            taskKey={panelTaskKey}
            onClose={closePanel}
            onAskSupervisor={askSupervisor}
          />
        </PanelBoundary>
      )}
    </div>
  );
}