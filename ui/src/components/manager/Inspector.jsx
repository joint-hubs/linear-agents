// Manager right inspector (FOC-225): Profile / Instructions / History /
// Achievements.
//
// Slice 1 part 2 adds editing. The Profile tab STAGES model assignments
// through the shared squad-config working copy (same writer as /squad-config
// — one semantics, one endpoint); the Instructions tab edits the role's
// prompt document through the same guarded MarkdownEditor flow the Prompts
// screen uses. Nothing here applies anything by itself: config changes go
// stage → preview (dry run) → apply in the edit bar; prompt saves are the
// editor's own dry-run/save pair.

import { useEffect, useState } from 'react';
import PromptContext from '../PromptContext.jsx';
import MarkdownEditor from '../MarkdownEditor.jsx';
import { getPromptRuns } from '../../api';
import { fmtCost, fmtDateTime, statusLabel } from '../../utils.js';
import { COORDINATOR_KEY } from '../../manager/identity.js';
import { promptPathFor, stagedModelSummary } from '../../manager/editing.js';
import { hasPriceEntry, modelSuggestions } from '../../squadConfig/workingCopy.js';
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

function Profile({ squad, card, editing }) {
  const isCoordinator = card.key === COORDINATOR_KEY;
  const { working, onStageLead, onStageModel } = editing;

  // Staged value from the shared working copy; configured value from the
  // board model (server truth). The two are shown together, never blended.
  const squadWorking = working?.squads?.[squad.key];
  const configuredModel = card.model || '';
  const stagedModel = isCoordinator
    ? squadWorking?.lead || ''
    : squadWorking?.agents?.[card.key]?.model || '';
  const summary = stagedModelSummary(configuredModel, stagedModel);

  const providerKey = squadWorking?.provider || squad.provider || 'openrouter';
  const suggestions = modelSuggestions(providerKey, working?.providers, working?.pricing);
  const noPrice = !!stagedModel && !hasPriceEntry(stagedModel, providerKey, working?.pricing);
  const datalistId = `mgr-models-${squad.key}-${card.key}`;
  const roleKey = isCoordinator ? 'lead (coordinator)' : card.key;

  const stage = (value) =>
    isCoordinator ? onStageLead(squad.key, value) : onStageModel(squad.key, card.key, value);

  return (
    <dl className="mgr-profile">
      <dt>Role</dt>
      <dd>{roleKey}</dd>
      <dt>Squad</dt>
      <dd>{squad.key}</dd>
      <dt>Provider</dt>
      <dd>{squad.provider}</dd>
      <dt>Model</dt>
      <dd>
        <input
          className="mgr-input mgr-modeledit"
          value={stagedModel}
          list={datalistId}
          onChange={(e) => stage(e.target.value)}
          placeholder="provider/model-slug (empty = not configured)"
          aria-label={`Model for ${roleKey}, staged value — applies on the next squad launch`}
          spellCheck={false}
        />
        <datalist id={datalistId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="mgr-modeledit-meta">
          <StateChip state={card.modelState} />
          {summary.changed ? (
            <span className="mgr-chip mgr-chip-warn">
              <span aria-hidden="true">✎</span> staged: {summary.from || '(none)'} →{' '}
              {summary.to || '(none)'}
            </span>
          ) : (
            <span className="mgr-muted">as configured</span>
          )}
        </div>
        {noPrice && (
          <p className="mgr-warn-note" role="note">
            <span aria-hidden="true">⚠</span> no pricing entry for{' '}
            <code>{stagedModel}</code> under provider <code>{providerKey}</code> — telemetry will
            report $0 for it until one is added in <code>/squad-config</code>.
          </p>
        )}
        <p className="mgr-muted mgr-modeledit-hint">
          Installation-global change (config/models.json + agents/*): applies on the{' '}
          <strong>next launch</strong> of this squad — running agents keep their current model.
          Free text is validated at preview/apply; suggestions come from the provider catalogue.
          Tools stay in <code>/squad-config</code>.
        </p>
      </dd>
      <dt>Observed runtime model</dt>
      <dd className="mgr-muted">
        not shown yet — telemetry integration arrives in slice 2. Configured and observed stay
        separate fields by design.
      </dd>
      <dt>Tools</dt>
      <dd>
        {card.tools.length > 0 ? (
          <span className="mgr-tool-list">{card.tools.join(', ')}</span>
        ) : (
          <span className="mgr-muted">no tools configured</span>
        )}
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

function Instructions({ squad, card, onPromptDirty }) {
  const isCoordinator = card.key === COORDINATOR_KEY;
  const path = promptPathFor(squad.key, card.key);
  return (
    <div>
      <p className="mgr-inspector-note">
        Repository file <code>{path}</code> — this is the instruction the role launches with.
        Preview (dry run) then save; the change applies on the <strong>next launch</strong> of the
        role, never retroactively. Frontmatter (<code>model:</code>, <code>tools:</code>) is
        preserved by the editor.
      </p>
      {path ? (
        <MarkdownEditor
          path={path}
          label={isCoordinator ? 'Lead instruction' : 'Role instruction'}
          onDirtyChange={onPromptDirty}
        />
      ) : (
        <p className="mgr-empty-note">no role selected</p>
      )}
      <PromptContext squad={squad.key} role={isCoordinator ? null : card.key} />
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

export default function Inspector({ squad, card, tab, onTab, editing, promptDirty }) {
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
            {id === 'instructions' && promptDirty && (
              <>
                <span className="mgr-tab-unsaved-slot mgr-unsaved-dot" title="unsaved prompt edits" />
                <span className="mgr-sr-only"> (unsaved edits)</span>
              </>
            )}
            {id !== 'instructions' && <span className="mgr-tab-unsaved-slot" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div
        className="mgr-tabpanel"
        id="mgr-tabpanel"
        role="tabpanel"
        aria-labelledby={`mgr-tab-${tab}`}
      >
        {tab === 'profile' && <Profile squad={squad} card={card} editing={editing} />}
        {tab === 'instructions' && (
          <Instructions squad={squad} card={card} onPromptDirty={editing.onPromptDirty} />
        )}
        {tab === 'history' && <History squad={squad} />}
        {tab === 'achievements' && <Achievements />}
      </div>
    </div>
  );
}
