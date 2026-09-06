// Manager left rail (squad list + compact roster) and the accessible roster
// table fallback (FOC-225). The table is the screen-reader/keyboard source of
// truth; the board is decorative layout on top of the same data.

import { COORDINATOR_KEY, squadRoleCounts } from '../../manager/identity.js';
import { LIVE_STATE_META } from '../../manager/live.js';
import { StateChip } from './RoleCard.jsx';

export function SquadRail({ squads, selectedSquad, onSelectSquad, selectedRole, onSelectRole, liveStates }) {
  const selected = squads.find((s) => s.key === selectedSquad);
  return (
    <>
      <div className="mgr-rail-section">
        <div className="mgr-rail-title">Squads</div>
        <ul className="mgr-squad-list" role="list">
          {squads.map((s) => {
            const counts = squadRoleCounts(s);
            const live = liveStates?.[s.key];
            const liveMeta = live?.state ? LIVE_STATE_META[live.state] : null;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={`mgr-squad-item${s.key === selectedSquad ? ' mgr-squad-item-active' : ''}`}
                  onClick={() => onSelectSquad(s.key)}
                  aria-current={s.key === selectedSquad ? 'true' : undefined}
                >
                  <span className={`mgr-squad-dot mgr-squad-${s.key}`} aria-hidden="true" />
                  <span className="mgr-squad-name">{s.key}</span>
                  {liveMeta && (
                    <span className={`mgr-chip mgr-chip-sm ${liveMeta.cls}`} title={`live: ${liveMeta.label}`}>
                      <span aria-hidden="true">{liveMeta.glyph}</span> {liveMeta.label}
                    </span>
                  )}
                  <span
                    className="mgr-squad-count"
                    title={
                      counts.coordinatorOnly
                        ? 'coordinator only — no specialist roles'
                        : `${counts.specialists} specialist role${counts.specialists === 1 ? '' : 's'}; the roster below lists ${counts.total} including the lead`
                    }
                  >
                    {counts.coordinatorOnly
                      ? 'coordinator only'
                      : `${counts.specialists} role${counts.specialists === 1 ? '' : 's'} + lead`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {selected && (
        <div className="mgr-rail-section">
          <div className="mgr-rail-title">Roster · {selected.key}</div>
          {selected.coordinatorOnly ? (
            <p className="mgr-empty-note">coordinator only — no specialist roles configured</p>
          ) : (
            <ul className="mgr-roster" role="list">
              {selected.cards.map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    className={`mgr-roster-item${c.key === selectedRole ? ' mgr-roster-item-active' : ''}`}
                    onClick={() => onSelectRole(c.key)}
                  >
                    <span className="mgr-roster-name">
                      {c.key === COORDINATOR_KEY ? 'lead' : c.key}
                    </span>
                    <span className={`mgr-dot mgr-dot-${c.modelState}`} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

// Semantic roster table — same data as the board, accessible by default.
export function RosterTable({ cards, selectedRole, onSelectRole }) {
  return (
    <div className="mgr-table-wrap">
      <table className="mgr-table">
        <caption className="mgr-table-caption">
          Roster — accessible fallback for the tactical board
        </caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Configured model</th>
            <th scope="col">State</th>
            <th scope="col">Tools</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr
              key={c.key}
              className={c.key === selectedRole ? 'mgr-row-selected' : ''}
              tabIndex={0}
              aria-selected={c.key === selectedRole}
              onClick={() => onSelectRole(c.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectRole(c.key);
                }
              }}
            >
              <th scope="row">{c.key === COORDINATOR_KEY ? 'lead (coordinator)' : c.key}</th>
              <td className="mgr-cell-mono">{c.model || '—'}</td>
              <td>
                <StateChip state={c.modelState} />
              </td>
              <td>{c.toolSummary.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
