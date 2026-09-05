// Manager right inspector (FOC-225): Profile / Instructions / History /
// Achievements. Read-only this slice — editing (staged changes, preview/
// apply) arrives with slice 1 part 2; the tab bar already reserves the
// unsaved-edit indicator slot so that contract does not change shape later.

import { useEffect, useState } from 'react';
import { getPromptRole, getPromptLead, getPromptRuns } from '../../api';
import { fmtCost, fmtDateTime, statusLabel } from '../../utils.js';
import { COORDINATOR_KEY } from '../../manager/identity.js';
import { StateChip } from './RoleCard.jsx';

const TABS = [
  ['profile', 'Profile'],
  ['instructions', 'Instructions'],
  ['history', 'History'],
  ['achievements', 'Achievements'],
];

const RUN_STATE_META = {
  running: { cls: 'mgr-chip-run', glyph: '▶' },
  failed: { cls: 'mgr-chip-fail', glyph: '✕' },
  done: { cls: 'mgr-chip-ok', glyph: '✓' },
};

function RunStateChip({ label }) {
  const meta = RUN_STATE_META[label] || { cls: 'mgr-chip-neutral', glyph: '·' };
  return (
    <span className={`mgr-chip ${meta.cls}`}>
      <span aria-hidden="true">{meta.glyph}</span> {label}
    </span>
  );
}

function Profile({ squad, card }) {
  const isCoordinator = card.key === COORDINATOR_KEY;
  return (
    <dl className="mgr-profile">
      <dt>Role</dt>
      <dd>{isCoordinator ? 'lead (coordinator)' : card.key}</dd>
      <dt>Squad</dt>
      <dd>{squad.key}</dd>
      <dt>Configured model</dt>
      <dd>
        <span className="mgr-cell-mono">{card.model || '—'}</span>{' '}
        <StateChip state={card.modelState} />
      </dd>
      <dt>Provider</dt>
      <dd>{squad.provider}</dd>
      <dt>Tools</dt>
      <dd>
        {card.tools.length > 0 ? (
          <span className="mgr-tool-list">{card.tools.join(', ')}</span>
        ) : (
          <span className="mgr-muted">no tools configured</span>
        )}
      </dd>
      <dt>Observed runtime model</dt>
      <dd className="mgr-muted">
        not shown yet — telemetry integration arrives in slice 2. Configured and observed stay
        separate fields by design.
      </dd>
      {isCoordinator && (
        <>
          <dt>Launcher</dt>
          <dd className="mgr-cell-mono">
            {squad.leadFiles.length > 0 ? squad.leadFiles.join(', ') : '—'}
          </dd>
        </>
      )}
    </dl>
  );
}

function Instructions({ squad, card }) {
  const isCoordinator = card.key === COORDINATOR_KEY;
  const [state, setState] = useState({ loading: false, doc: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, doc: null, error: null });
    const fetcher = isCoordinator ? getPromptLead(squad.key) : getPromptRole(squad.key, card.key);
    fetcher
      .then((doc) => {
        if (!cancelled) setState({ loading: false, doc, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, doc: null, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [squad.key, card.key, isCoordinator]);

  return (
    <div>
      <p className="mgr-inspector-note">
        Read-only here. Edits happen in Prompty (/prompts) — prompt changes apply on the next
        launch of the role, never retroactively.
      </p>
      {state.loading && <p className="mgr-muted">loading prompt…</p>}
      {state.error && (
        <p className="mgr-empty-note">
          no prompt document found for this role ({state.error.message})
        </p>
      )}
      {state.doc && (
        <pre className="mgr-prompt">{state.doc.body ?? '(empty document)'}</pre>
      )}
    </div>
  );
}

function History({ squad }) {
  const [state, setState] = useState({ loading: false, runs: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, runs: null, error: null });
    getPromptRuns(squad.key, 10)
      .then((runs) => {
        if (!cancelled) setState({ loading: false, runs, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, runs: null, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [squad.key]);

  return (
    <div>
      <p className="mgr-inspector-note">
        Squad-level run history. Per-role attribution arrives with the slice 2 telemetry adapter —
        nothing is inferred here.
      </p>
      {state.loading && <p className="mgr-muted">loading runs…</p>}
      {state.error && (
        <p className="mgr-empty-note">
          run history unavailable ({state.error.message}). This does not affect configuration
          data.
        </p>
      )}
      {state.runs && state.runs.length === 0 && (
        <p className="mgr-empty-note">no runs recorded for this squad yet</p>
      )}
      {state.runs && state.runs.length > 0 && (
        <table className="mgr-table mgr-table-tight">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Task</th>
              <th scope="col">Status</th>
              <th scope="col">Started</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {state.runs.map((r) => (
              <tr key={r.runId}>
                <td className="mgr-cell-mono">{r.runId}</td>
                <td>{r.taskId || '—'}</td>
                <td>
                  <RunStateChip label={statusLabel(r)} />
                </td>
                <td>{fmtDateTime(r.startedAt)}</td>
                <td>{fmtCost(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Rewards stay honestly pending until the slice 3 ledger exists (see
// docs/ui/fenix-manager-rewards.md). Never rendered as zeroed records.
function Achievements() {
  return (
    <div className="mgr-pending">
      <p className="mgr-pending-title">Rewards arrive in a later slice</p>
      <p className="mgr-muted">
        XP and manager ratings need a durable evidence ledger (slice 3). Nothing is recorded yet —
        and nothing is guessed from runs, costs or exit codes.
      </p>
    </div>
  );
}

export default function Inspector({ squad, card, tab, onTab }) {
  if (!card) {
    return (
      <div className="mgr-inspector">
        <p className="mgr-empty-note">select a role on the board or in the roster</p>
      </div>
    );
  }
  return (
    <div className="mgr-inspector">
      <div className="mgr-tabs" role="tablist" aria-label="Role inspector">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`mgr-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="mgr-tabpanel"
            tabIndex={tab === id ? 0 : -1}
            className={`mgr-tab${tab === id ? ' mgr-tab-active' : ''}`}
            onClick={() => onTab(id)}
          >
            {label}
            <span className="mgr-tab-unsaved-slot" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div
        className="mgr-tabpanel"
        id="mgr-tabpanel"
        role="tabpanel"
        aria-labelledby={`mgr-tab-${tab}`}
      >
        {tab === 'profile' && <Profile squad={squad} card={card} />}
        {tab === 'instructions' && <Instructions squad={squad} card={card} />}
        {tab === 'history' && <History squad={squad} />}
        {tab === 'achievements' && <Achievements />}
      </div>
    </div>
  );
}
