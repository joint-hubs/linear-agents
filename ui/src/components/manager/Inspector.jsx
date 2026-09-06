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
//
// Slice 3 adds rewards: the Achievements tab renders the squad's ledger
// aggregates, and the History tab carries the ONE human-authoring surface
// for manager ratings (per ended run with a task) — a stage-then-explicit-
// apply control whose saves go through /api/manager/ratings.

import PromptContext from '../PromptContext.jsx';
import MarkdownEditor from '../MarkdownEditor.jsx';
import { fmtDateTime, fmtUSD } from '../../utils.js';
import { COORDINATOR_KEY } from '../../manager/identity.js';
import { promptPathFor, stagedModelSummary, nextTabIndex } from '../../manager/editing.js';
import { ratingForRun } from '../../manager/rewards.js';
import { hasPriceEntry, modelSuggestions } from '../../squadConfig/workingCopy.js';
import { GateBadge, LiveStateChip } from './LiveStrip.jsx';
import { StateChip } from './RoleCard.jsx';
import { AchievementsPanel, RatingControl, RatingDisplay, rateableRun } from './Rewards.jsx';

const TABS = [
  ['profile', 'Profile'],
  ['instructions', 'Instructions'],
  ['history', 'History'],
  ['achievements', 'Achievements'],
];

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
        not shown in v1 — live state is squad-level only; per-role attribution needs
        manifest/launcher/store work (separate approval). Configured and observed stay separate
        fields by design.
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

// History reads the bounded live snapshot (the same /api/manager/snapshot the
// overlay polls) — the Manager screen never calls /api/runs or
// /api/prompts/runs. Rows arrive decorated with their derived state; active
// runs first, then the most recent ended ones (≤ 5 per squad, server bound).
function History({ live, liveStale, squadKey, rewards, onRate, ratingSave, onRatingDirty }) {
  const runs = live ? [...live.active, ...live.recent] : [];
  const cost = (r) => (r.costPartial ? 'partial' : fmtUSD(r.costUSD ?? 0));
  return (
    <div>
      <p className="mgr-inspector-note">
        Squad-level run history from the bounded live snapshot (5 most recent per squad). Per-role
        attribution is not available in v1 — squad-level binding only; nothing is inferred here.
        The Rating column is the one human-authoring surface for manager ratings: a subjective
        record on the rewards ledger, saved explicitly — it never carries XP.
      </p>
      {liveStale && (
        <p className="mgr-empty-note" role="note">
          <span aria-hidden="true">⏱</span> live update failed — showing last known data
        </p>
      )}
      <GateBadge count={(live?.pendingGates || []).length} />
      {!live && <p className="mgr-muted">loading live snapshot…</p>}
      {live && runs.length === 0 && live.pendingGates.length === 0 && (
        <p className="mgr-empty-note">no runs in the bounded window for this squad</p>
      )}
      {live && runs.length > 0 && (
        <table className="mgr-table mgr-table-tight">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Task</th>
              <th scope="col">State</th>
              <th scope="col">Started</th>
              <th scope="col">Cost</th>
              <th scope="col">Rating</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const rating = ratingForRun(rewards?.data, r);
              return (
                <tr key={r.runId}>
                  <td className="mgr-cell-mono">{r.runId}</td>
                  <td>{r.taskId || '—'}</td>
                  <td>
                    <LiveStateChip state={r.state} />
                  </td>
                  <td>{fmtDateTime(r.startedAt)}</td>
                  <td>{cost(r)}</td>
                  <td>
                    {rateableRun(r) ? (
                      <RatingControl
                        squadKey={squadKey}
                        run={r}
                        saved={rating}
                        onSave={onRate}
                        onDirty={onRatingDirty}
                        busy={ratingSave?.busy}
                        error={ratingSave?.error}
                      />
                    ) : rating ? (
                      <RatingDisplay rating={rating} />
                    ) : (
                      <span className="mgr-muted">—</span>
                    )}
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

// Achievements aggregates live in Rewards.jsx (slice 3): squad XP/level/
// badges from the ledger, awaiting-verified-evidence when nothing is on
// record — never zeroed records. Aggregates only: rating authoring stays in
// the History rows, per the supervisor-resolved design decision.

export default function Inspector({
  squad,
  card,
  tab,
  onTab,
  editing,
  promptDirty,
  live,
  liveStale,
  rewards,
  onRate,
  ratingSave,
}) {
  if (!card) {
    return (
      <div className="mgr-inspector">
        <p className="mgr-empty-note">select a role on the board or in the roster</p>
      </div>
    );
  }
  return (
    <div className="mgr-inspector">
      <div
        className="mgr-tabs"
        role="tablist"
        aria-label="Role inspector"
        onKeyDown={(e) => {
          // APG tabs: arrows move focus and activate (through onTab, which
          // carries the unsaved-draft guard).
          const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const next = nextTabIndex(e.key, tabs.indexOf(document.activeElement), tabs.length);
          if (next === -1) return;
          e.preventDefault();
          tabs[next].focus();
          onTab(TABS[next][0]);
        }}
      >
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
        {tab === 'history' && (
          <History
            live={live}
            liveStale={liveStale}
            squadKey={squad.key}
            rewards={rewards}
            onRate={onRate}
            ratingSave={ratingSave}
            onRatingDirty={editing.onRatingDirty}
          />
        )}
        {tab === 'achievements' && <AchievementsPanel rewards={rewards} squadKey={squad.key} />}
      </div>
    </div>
  );
}
