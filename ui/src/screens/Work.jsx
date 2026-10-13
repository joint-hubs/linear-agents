// Work board (FOC-784, dashboard-v2-spec §4.2) — where is each ticket, what
// did it cost. Handles both /work and /work/:ticket: the board polls
// /api/work/tickets every 15 s (usePoll aborts in-flight requests and keeps
// the last data on a failed fetch — a bad poll never blanks the board), the
// ticket detail opens as a side panel (TicketPanel) when :ticket is set.
// Filters (milestone / priority) live in the URL via filtersFromQuery /
// queryFromFilters, so a refresh or a shared link keeps the view.

import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import './work.css';
import { getWorkTickets } from '../api';
import { usePoll } from '../hooks/usePoll';
import {
  STAGES,
  groupByStage,
  cardModel,
  staleLabel,
  filtersFromQuery,
  queryFromFilters,
} from '../workModel';
import PanelBoundary from '../components/cockpit/PanelBoundary';
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

function TicketCard({ ticket, now, onOpen }) {
  const m = cardModel(ticket, now);
  if (!m.id) return null;
  return (
    <button type="button" className="wk-card" onClick={() => onOpen(m.id)}>
      <span className="wk-card-id">{m.id}</span>
      {m.title && <span className="wk-card-title">{m.title}</span>}
      {m.flags.length > 0 && (
        <span className="wk-card-flags">
          {m.flags.map((f, i) => (
            <span key={i} className={`ck-chip ck-tone-${f.tone}`}>
              {f.text}
            </span>
          ))}
        </span>
      )}
      <span className="wk-card-meta">
        {m.rounds && <span>{m.rounds}</span>}
        {m.cost && <span>{m.cost}</span>}
        {m.age && <span className="muted">{m.age}</span>}
      </span>
    </button>
  );
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

  // Filters navigate to /work + the query — a change while the detail panel is
  // open returns to the board with the filters kept in the URL.
  const setFilter = (key, value) => {
    navigate('/work' + queryFromFilters({ ...filters, [key]: value || null }));
  };
  const closePanel = () => navigate('/work' + filtersKey);
  const openTicket = (id) => navigate('/work/' + encodeURIComponent(id));
  const askSupervisor = (id) =>
    navigate('/?prompt=' + encodeURIComponent('About ' + id + ': '));

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
          <TicketPanel id={ticketId} onClose={closePanel} onAskSupervisor={askSupervisor} />
        </PanelBoundary>
      )}
    </div>
  );
}