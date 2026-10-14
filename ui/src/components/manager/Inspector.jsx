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
//
// Tools editing (same slice family, FOC-773 Settings work): a worker role's
// tools are editable with the merged catalog — native /api/tools PLUS the
// /api/tool-profiles/catalog MCP half when the Thoughtmap server is enabled
// in the registry — and the SAME role-frontmatter payload the /squad-config
// ToolEditorModal writes, but staged through the shared working copy instead
// of a direct write, so the edit bar's preview (dry run) → apply → discard
// owns it. Names the merged catalog does not know are preserved, never
// silently dropped. The coordinator (lead) has NO tool contract in
// /api/squad-config (lead is a model string from bin/<squad>.bat) — its tools
// are edited through the tool-profiles registry instead (shared
// LeadToolsEditor below, staged copy + apply owned by the Tool profiles
// panel).

import { useEffect, useMemo, useState } from 'react';
import { getTools } from '../../api';
import { getToolProfilesCatalog, mergeCatalogs } from '../../toolProfilesModel.js';
import { LeadToolsEditor } from './ToolProfiles.jsx';
import PromptContext from '../PromptContext.jsx';
import MarkdownEditor from '../MarkdownEditor.jsx';
import Modal from '../Modal.jsx';
import { fmtDateTime, fmtUSD } from '../../utils.js';
import { COORDINATOR_KEY } from '../../manager/identity.js';
import { promptPathFor, stagedModelSummary, nextTabIndex } from '../../manager/editing.js';
import { ratingForRun } from '../../manager/rewards.js';
import {
  hasPriceEntry,
  modelSuggestions,
  splitKnownTools,
  stagedToolsSummary,
} from '../../squadConfig/workingCopy.js';
import { GateBadge, LiveStateChip } from './LiveStrip.jsx';
import { StateChip } from './RoleCard.jsx';
import { AchievementsPanel, RatingControl, RatingDisplay, rateableRun } from './Rewards.jsx';

const TABS = [
  ['profile', 'Profile'],
  ['instructions', 'Instructions'],
  ['history', 'History'],
  ['achievements', 'Achievements'],
];

// Catalog-backed tools editor for one worker role — the /squad-config
// ToolEditorModal's selection semantics (same /api/tools catalog, same
// risk levels, same Task warning), STAGED instead of written: the footer
// button only stages into the shared working copy; the edit bar's
// preview (dry run) → apply → discard owns the actual write.
//
// `target` is {squad, role, configured} | null. Names the catalog does not
// know are preserved and shown locked — the native-catalog editor never
// silently drops them (MCP tools arrive with the MCP catalog, later phase).
function ToolsEditor({ target, onClose, onStage }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  // null = no user toggle yet — checkboxes then show the configured editable
  // names, so a late catalog load still pre-checks them correctly.
  const [overrides, setOverrides] = useState(null);

  // Lazy-load the catalog on first open; kept for the modal's lifetime. The
  // merged catalog = native /api/tools + the MCP half of
  // /api/tool-profiles/catalog (mcp__thoughtmap__* become selectable when the
  // server is enabled in the registry). The MCP half failing degrades to the
  // native catalog only — the native half failing is a real error.
  useEffect(() => {
    if (!target || catalog) return undefined;
    let alive = true;
    Promise.all([
      getTools(),
      getToolProfilesCatalog().catch(() => null),
    ])
      .then(([native, tp]) => alive && setCatalog(mergeCatalogs(native, tp)))
      .catch((e) => alive && setError(e?.message || String(e)));
    return () => {
      alive = false;
    };
  }, [target, catalog]);

  const catalogNames = useMemo(
    () => (catalog ? Object.keys(catalog.tools || {}).sort() : null),
    [catalog]
  );
  const configured = target?.configured || [];
  const split = useMemo(() => splitKnownTools(configured, catalogNames), [target, catalogNames]);

  // A different role reopens with a clean selection state.
  useEffect(() => {
    setOverrides(null);
  }, [target?.squad, target?.role]);

  const chosen = overrides ?? split.editable;
  const toggle = (name) => {
    const base = overrides ?? split.editable;
    setOverrides(base.includes(name) ? base.filter((t) => t !== name) : [...base, name]);
  };

  const riskLevels = catalog?.riskLevels || {};
  // Deterministic order for the staged list: catalog order, then preserved
  // unknowns in their configured order.
  const effective = catalogNames
    ? [...catalogNames.filter((n) => chosen.includes(n)), ...split.preserved]
    : [];
  const hasTask = effective.includes('Task');

  const stage = () => {
    if (!target || !catalog) return;
    onStage(effective);
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target ? `Tools — ${target.squad} / ${target.role}` : 'Tools'}
    >
      {target && (
        <>
          {error && (
            <p className="mgr-warn-note" role="alert">
              <span aria-hidden="true">⚠</span> tools catalog failed to load ({error}) — nothing
              can be staged; reopen the editor to retry.
            </p>
          )}
          <p className="mgr-inspector-note">
            Staged like model edits: this only writes the staging copy — the edit bar's Preview
            (dry run) then Apply writes the role's <code>tools:</code> frontmatter. MCP tools
            (<code>mcp__thoughtmap__*</code>) appear when the Thoughtmap server is enabled in the Tool
            profiles panel; names the merged catalog does not know ride along untouched and show
            locked (preserved, never granted while unavailable).
          </p>

          {hasTask && (
            <p className="mgr-warn-note" role="note">
              <span aria-hidden="true">⚠</span> granting <code>Task</code>: no role has it today —
              the hierarchy is deliberately flat (lead → subagent). <code>Task</code> turns this
              into nested delegation. Make sure that is intended.
            </p>
          )}

          {!catalog && !error && <p className="mgr-muted">loading tools catalog…</p>}

          {catalog && (
            <table className="mgr-table mgr-table-tight">
              <thead>
                <tr>
                  <th scope="col" aria-label="Selected" />
                  <th scope="col">Tool</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Risk</th>
                </tr>
              </thead>
              <tbody>
                {catalogNames.length === 0 && (
                  <tr>
                    <td colSpan={4} className="mgr-muted">
                      no catalog data
                    </td>
                  </tr>
                )}
                {catalogNames.map((name) => {
                  const t = catalog.tools[name];
                  const risk = t.risk || '';
                  const riskInfo = riskLevels[risk];
                  const isHighRisk = risk === 'writes-code' || risk === 'writes-system';
                  return (
                    <tr
                      key={name}
                      style={isHighRisk ? { background: 'var(--warn-soft)' } : undefined}
                    >
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={chosen.includes(name)}
                          onChange={() => toggle(name)}
                          aria-label={`Tool ${name}`}
                        />
                      </td>
                      <td className="mgr-cell-mono">{name}</td>
                      <td>{t.description || '—'}</td>
                      <td title={riskInfo?.hint || ''}>
                        {riskInfo ? (
                          <span style={isHighRisk ? { fontWeight: 600 } : undefined}>
                            {riskInfo.label || risk}
                            {isHighRisk ? ' ⚠' : ''}
                          </span>
                        ) : (
                          <span className="mgr-muted">{risk || '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {split.preserved.map((name) => (
                  <tr key={`preserved-${name}`}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked disabled aria-label={`Preserved tool ${name}`} />
                    </td>
                    <td className="mgr-cell-mono">{name}</td>
                    <td colSpan={2}>
                      <span className="mgr-muted">
                        not in the enabled catalog — preserved as configured, never granted while
                        unavailable{/^mcp__/.test(name) ? ' (enable the MCP server in Tool profiles)' : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mgr-editbar-actions">
            <button type="button" className="mgr-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="mgr-btn mgr-btn-primary"
              onClick={stage}
              disabled={!catalog || !!error}
            >
              Stage changes
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Profile({ squad, card, editing, toolProfiles, squadKeys }) {
  const isCoordinator = card.key === COORDINATOR_KEY;
  const { working, onStageLead, onStageModel, onStageTools } = editing;
  const [toolsOpen, setToolsOpen] = useState(false);

  // Staged value from the shared working copy; configured value from the
  // board model (server truth). The two are shown together, never blended.
  const squadWorking = working?.squads?.[squad.key];
  const configuredModel = card.model || '';
  const stagedModel = isCoordinator
    ? squadWorking?.lead || ''
    : squadWorking?.agents?.[card.key]?.model || '';
  const summary = stagedModelSummary(configuredModel, stagedModel);

  // Tools: staged list from the shared working copy (starts as the server
  // state, so "as configured" until the user stages a change); the summary
  // compares against the board model's configured list.
  const stagedTools = isCoordinator ? [] : squadWorking?.agents?.[card.key]?.tools || [];
  const toolsSummary = stagedToolsSummary(card.tools, stagedTools);

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
          Provider and pricing edits stay in <code>/squad-config</code>.
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
        {isCoordinator ? (
          toolProfiles ? (
            <LeadToolsEditor store={toolProfiles} squad={squad.key} squadKeys={squadKeys} />
          ) : (
            <p className="mgr-muted">
              the tool-profiles registry is unavailable — the lead's tools (leadTools in{' '}
              <code>/api/tool-profiles</code>, not the lead model from <code>bin/{squad.key}.bat</code>)
              cannot be edited here right now.
            </p>
          )
        ) : (
          <>
            {stagedTools.length > 0 ? (
              <span className="mgr-tool-list">{stagedTools.join(', ')}</span>
            ) : (
              <span className="mgr-muted">no tools configured</span>
            )}
            <div className="mgr-modeledit-meta">
              {toolsSummary.changed ? (
                <span className="mgr-chip mgr-chip-warn">
                  <span aria-hidden="true">✎</span> staged: {toolsSummary.from.length} →{' '}
                  {toolsSummary.to.length} tools
                </span>
              ) : (
                <span className="mgr-muted">as configured</span>
              )}
              <button
                type="button"
                className="mgr-btn mgr-btn-sm"
                onClick={() => setToolsOpen(true)}
              >
                Edit tools
              </button>
            </div>
            <ToolsEditor
              target={toolsOpen ? { squad: squad.key, role: card.key, configured: stagedTools } : null}
              onClose={() => setToolsOpen(false)}
              onStage={(tools) => {
                onStageTools(squad.key, card.key, tools);
                setToolsOpen(false);
              }}
            />
          </>
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
function History({ live, liveFailed, squadKey, rewards, onRate, ratingSave, stagedRatings, onRatingStage }) {
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
      {liveFailed && (
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
            {/* title restores the full header word — the narrow 320px column
                ellipsizes the longer ones (D1 truncation-with-title rule). */}
            <tr>
              <th scope="col" title="Run">Run</th>
              <th scope="col" title="Task">Task</th>
              <th scope="col" title="State">State</th>
              <th scope="col" title="Started">Started</th>
              <th scope="col" title="Cost">Cost</th>
              <th scope="col" title="Rating">Rating</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const rating = ratingForRun(rewards?.data, r);
              // busy/error belong to the run that owns the save — other rows
              // stay independent (a failed save never repeats everywhere).
              const ownSave = ratingSave?.runId === r.runId;
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
                        onStage={onRatingStage}
                        staged={stagedRatings?.[r.runId]}
                        busy={ownSave && ratingSave?.busy}
                        error={ownSave ? ratingSave?.error : null}
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
  toolProfiles,
  squadKeys,
  promptDirty,
  live,
  liveFailed,
  rewards,
  onRate,
  ratingSave,
  stagedRatings,
  onRatingStage,
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
        {tab === 'profile' && (
          <Profile
            squad={squad}
            card={card}
            editing={editing}
            toolProfiles={toolProfiles}
            squadKeys={squadKeys}
          />
        )}
        {tab === 'instructions' && (
          <Instructions squad={squad} card={card} onPromptDirty={editing.onPromptDirty} />
        )}
        {tab === 'history' && (
          <History
            live={live}
            liveFailed={liveFailed}
            squadKey={squad.key}
            rewards={rewards}
            onRate={onRate}
            ratingSave={ratingSave}
            stagedRatings={stagedRatings}
            onRatingStage={onRatingStage}
          />
        )}
        {tab === 'achievements' && <AchievementsPanel rewards={rewards} squadKey={squad.key} />}
      </div>
    </div>
  );
}
