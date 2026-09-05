// Fenix Manager — tactical board (FOC-225 slice 1).
// Board, roster and inspector over /api/squad-config. Layout positions are
// presentation preferences persisted per installation + squad; moving a card
// never issues a request or changes execution semantics.
//
// Slice 1 part 2 adds editing through the SHARED writer: model assignments
// stage into the same working copy /squad-config uses, go through the same
// /api/squad-config endpoint (dry-run preview, then explicit apply), and
// prompt documents edit through the same guarded MarkdownEditor flow the
// Prompts screen uses. There is no second writer and no silent start of
// work — every write is a visible staged change first.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getSquadConfig, postSquadConfig } from '../api';
import { fmtTime } from '../utils.js';
import { buildBoardModel, installFingerprint, COORDINATOR_KEY } from '../manager/identity.js';
import {
  loadLayout,
  saveLayout,
  defaultPositions,
  clampPosition,
} from '../manager/layout.js';
import { editingGuardActive } from '../manager/editing.js';
import {
  buildSavePayload,
  buildWorkingCopy,
  countDirty,
  normalizeSaveError,
  setAgentModel,
  setLeadModel,
} from '../squadConfig/workingCopy';
import RoleCard from '../components/manager/RoleCard.jsx';
import { SquadRail, RosterTable } from '../components/manager/Roster.jsx';
import Inspector from '../components/manager/Inspector.jsx';
import './manager.css';

const MOVE_STEP = 2; // % per arrow press
const MOVE_STEP_LARGE = 8; // % with Shift held
const ARROW_MOVES = {
  ArrowLeft: [-MOVE_STEP, 0],
  ArrowRight: [MOVE_STEP, 0],
  ArrowUp: [0, -MOVE_STEP],
  ArrowDown: [0, MOVE_STEP],
};

const LEAVE_MESSAGE =
  'Leave with unsaved work? Staged configuration changes and unsaved prompt edits exist only '
  + 'while this screen is open — leaving now discards them.';

const PROMPT_SWITCH_MESSAGE =
  'The prompt draft is not saved. Switching role or squad now discards it. Continue?';

function pct(v) {
  return `${Math.round(v)}%`;
}

export default function Manager() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [readAt, setReadAt] = useState(null);

  const [selectedRole, setSelectedRole] = useState(null);
  const [tab, setTab] = useState('profile');
  const [viewMode, setViewMode] = useState('board');
  const [positions, setPositions] = useState({});
  const [draggingKey, setDraggingKey] = useState(null);
  const [announce, setAnnounce] = useState('');

  // --- editing state (slice 1 part 2) ---------------------------------------
  // working: the shared squad-config working copy (staging). preview: the
  // dry-run result from /api/squad-config. configSave: per-endpoint outcome —
  // prompt-file saves are a separate endpoint and report separately (there is
  // no combined atomic save to claim).
  const [working, setWorking] = useState(null);
  const [preview, setPreview] = useState(null);
  const [configSave, setConfigSave] = useState({ phase: 'idle', op: null, result: null, error: null });
  const [promptDirty, setPromptDirty] = useState(false);

  const positionsRef = useRef(positions);
  const boardRef = useRef(null);
  const dragRef = useRef(null);

  const boardModel = useMemo(() => buildBoardModel(config), [config]);
  const installKey = useMemo(() => installFingerprint(config), [config]);

  const requested = searchParams.get('squad');
  const selectedSquad = boardModel.some((s) => s.key === requested)
    ? requested
    : boardModel[0]?.key || null;
  const squad = boardModel.find((s) => s.key === selectedSquad) || null;
  const squadKey = squad?.key || null;

  const roleKeys = useMemo(() => (squad ? squad.cards.map((c) => c.key) : []), [squad]);
  const roleKeysSig = roleKeys.join('|');
  const selectedCard = squad?.cards.find((c) => c.key === selectedRole) || null;

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const cfg = await getSquadConfig();
      // Normalize agents to {model, tools} (same as /squad-config) so the
      // working copy and countDirty see one canonical shape.
      const squads = buildWorkingCopy(cfg).squads;
      setConfig({ ...cfg, squads });
      setReadAt(new Date());
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Rebuild the staging working copy whenever a fresh server read lands
  // (initial load and after a successful apply — applied changes ARE server
  // state, so staging resets; a successful outcome banner stays visible).
  useEffect(() => {
    setWorking(config ? buildWorkingCopy(config) : null);
    setPreview(null);
    setConfigSave((prev) =>
      prev.phase === 'ok' ? prev : { phase: 'idle', op: null, result: null, error: null }
    );
  }, [config]);

  // Reflect the effective squad selection in the URL (invalid ?squad= falls
  // back to the first squad, and the selector shows exactly that).
  useEffect(() => {
    if (selectedSquad && requested !== selectedSquad) {
      setSearchParams({ squad: selectedSquad }, { replace: true });
    }
  }, [selectedSquad, requested, setSearchParams]);

  // Selection is per squad — a role from the previous squad means nothing here.
  useEffect(() => {
    setSelectedRole(null);
  }, [squadKey]);

  // Load layout for this installation + squad; a migrated v1 record is
  // re-saved under the v2 key immediately so the migration is durable.
  useEffect(() => {
    if (!squadKey || !installKey) return;
    const { positions: loaded, migratedFromVersion } = loadLayout(
      window.localStorage,
      installKey,
      squadKey,
      roleKeys
    );
    positionsRef.current = loaded;
    setPositions(loaded);
    if (migratedFromVersion) saveLayout(window.localStorage, installKey, squadKey, loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roleKeysSig covers roleKeys
  }, [squadKey, installKey, roleKeysSig]);

  const persistLayout = useCallback(
    (next) => {
      if (!squadKey || !installKey) return;
      saveLayout(window.localStorage, installKey, squadKey, next);
    },
    [squadKey, installKey]
  );

  const moveCard = useCallback(
    (key, dx, dy) => {
      const cur = positionsRef.current[key];
      if (!cur) return;
      const next = { ...positionsRef.current, [key]: clampPosition({ x: cur.x + dx, y: cur.y + dy }) };
      positionsRef.current = next;
      setPositions(next);
      persistLayout(next);
      setAnnounce(`${key} moved to ${pct(next[key].x)}, ${pct(next[key].y)}`);
    },
    [persistLayout]
  );

  const onCardPointerDown = useCallback((e, card) => {
    if (e.button !== 0) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      key: card.key,
      px: e.clientX,
      py: e.clientY,
      pos: { ...(positionsRef.current[card.key] || { x: 0, y: 0 }) },
      rect,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onCardPointerMove = useCallback((e, card) => {
    const d = dragRef.current;
    if (!d || d.key !== card.key) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) < 4) return;
      d.moved = true;
      setDraggingKey(card.key);
    }
    const next = {
      ...positionsRef.current,
      [card.key]: clampPosition({
        x: d.pos.x + ((e.clientX - d.px) / d.rect.width) * 100,
        y: d.pos.y + ((e.clientY - d.py) / d.rect.height) * 100,
      }),
    };
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const onCardPointerUp = useCallback(
    (e, card) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingKey(null);
      if (!d || d.key !== card.key) return;
      if (d.moved) {
        persistLayout(positionsRef.current);
        const p = positionsRef.current[card.key];
        setAnnounce(`${card.key} moved to ${pct(p.x)}, ${pct(p.y)}`);
      } else {
        selectRole(card.key);
      }
    },
    [persistLayout, selectRole]
  );

  const onCardKeyDown = useCallback(
    (e, card) => {
      const step = e.shiftKey ? MOVE_STEP_LARGE : MOVE_STEP;
      if (ARROW_MOVES[e.key]) {
        e.preventDefault();
        moveCard(card.key, ARROW_MOVES[e.key][0], ARROW_MOVES[e.key][1]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectRole(card.key);
      }
    },
    [moveCard, selectRole]
  );

  const resetLayout = useCallback(() => {
    if (!squad) return;
    const def = defaultPositions(roleKeys);
    positionsRef.current = def;
    setPositions(def);
    persistLayout(def);
    setAnnounce('layout reset to defaults');
  }, [squad, roleKeys, persistLayout]);

  // --- staging + save (same endpoint and payload as /squad-config) ----------

  const dirtyCount = useMemo(
    () => (config && working ? countDirty(config, working) : 0),
    [config, working]
  );

  const stageAgentModel = useCallback((squadKey, role, value) => {
    setWorking((prev) => setAgentModel(prev, squadKey, role, value));
    setPreview(null); // any new edit invalidates a previous dry run
    setConfigSave({ phase: 'idle', op: null, result: null, error: null });
  }, []);

  const stageLeadModel = useCallback((squadKey, value) => {
    setWorking((prev) => setLeadModel(prev, squadKey, value));
    setPreview(null);
    setConfigSave({ phase: 'idle', op: null, result: null, error: null });
  }, []);

  const previewChanges = useCallback(async () => {
    if (!working) return;
    setConfigSave({ phase: 'busy', op: 'preview', result: null, error: null });
    try {
      const result = await postSquadConfig(buildSavePayload(working, true));
      setPreview(result);
      setConfigSave({ phase: 'idle', op: null, result: null, error: null });
    } catch (e) {
      setPreview(null);
      setConfigSave({ phase: 'error', op: 'preview', result: null, error: normalizeSaveError(e) });
    }
  }, [working]);

  const applyChanges = useCallback(async () => {
    // Apply is only reachable after a successful dry run — the same rule the
    // /squad-config screen enforces.
    if (!working || !preview) return;
    setConfigSave({ phase: 'busy', op: 'apply', result: null, error: null });
    try {
      const result = await postSquadConfig(buildSavePayload(working, false));
      setPreview(null);
      setConfigSave({ phase: 'ok', op: 'apply', result, error: null });
      await fetchConfig(); // re-read: the applied state is now server truth
    } catch (e) {
      setConfigSave({ phase: 'error', op: 'apply', result: null, error: normalizeSaveError(e) });
    }
  }, [working, preview, fetchConfig]);

  const discardChanges = useCallback(() => {
    if (!config) return;
    setWorking(buildWorkingCopy(config));
    setPreview(null);
    setConfigSave({ phase: 'idle', op: null, result: null, error: null });
  }, [config]);

  // --- unsaved-edit protection ----------------------------------------------

  const guardActive = editingGuardActive(dirtyCount, promptDirty);
  const promptDirtyRef = useRef(false);
  promptDirtyRef.current = promptDirty;

  // Closing/reloading the tab with unsaved work asks first.
  useEffect(() => {
    if (!guardActive) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [guardActive]);

  // In-app navigation while the guard is active: intercept anchor clicks in
  // the capture phase and ask. BrowserRouter exposes no data-router blocker,
  // so the anchor is the interception point.
  useEffect(() => {
    if (!guardActive) return undefined;
    const onDocClick = (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      if (href === `${window.location.pathname}${window.location.search}`) return;
      if (!window.confirm(LEAVE_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [guardActive]);

  // Switching role/squad while a prompt draft is open would silently drop it
  // (MarkdownEditor resets on path change) — ask first.
  const selectRole = useCallback((key) => {
    if (promptDirtyRef.current && !window.confirm(PROMPT_SWITCH_MESSAGE)) return;
    setSelectedRole(key);
  }, []);

  const selectSquad = useCallback(
    (key) => {
      if (promptDirtyRef.current && !window.confirm(PROMPT_SWITCH_MESSAGE)) return;
      setSearchParams({ squad: key });
    },
    [setSearchParams]
  );

  // --- Render states -------------------------------------------------------

  if (loading) {
    return (
      <div className="mgr">
        <div className="mgr-loading" role="status">
          <div className="mgr-skeleton mgr-skeleton-wide" />
          <div className="mgr-skeleton" />
          <div className="mgr-skeleton" />
          <div className="mgr-skeleton" />
          <p className="mgr-muted">loading squads…</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mgr">
        <div className="mgr-error" role="alert">
          <p className="mgr-error-title">Cannot reach the configuration API</p>
          <p>
            GET <code>/api/squad-config</code> failed ({loadError.message}). Squad data is
            read from the telemetry backend, so nothing else on this screen can load.
          </p>
          <p className="mgr-muted">
            Backend start: <code>node scripts/telemetry-server.mjs</code>
          </p>
          <button type="button" className="mgr-btn" onClick={fetchConfig}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (boardModel.length === 0) {
    return (
      <div className="mgr">
        <div className="mgr-empty" role="status">
          <p>No squads configured in this installation.</p>
          <p className="mgr-muted">
            Squads come from <code>config/models.json</code> routing and <code>agents/</code>{' '}
            directories — nothing is invented here.
          </p>
        </div>
      </div>
    );
  }

  // --- Main layout ---------------------------------------------------------

  return (
    <div className="mgr">
      <header className="mgr-header">
        <div className="mgr-header-row">
          <h1 className="mgr-title">Manager</h1>
          <label className="mgr-squad-label">
            <span className="mgr-squad-label-text">Squad</span>
            <select
              className="mgr-select"
              value={selectedSquad || ''}
              onChange={(e) => selectSquad(e.target.value)}
            >
              {boardModel.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key}
                </option>
              ))}
            </select>
          </label>
          <div className="mgr-mode" role="group" aria-label="View mode">
            <button type="button" className="mgr-mode-btn mgr-mode-active" aria-pressed="true">
              Setup
            </button>
            <button
              type="button"
              className="mgr-mode-btn"
              aria-pressed="false"
              disabled
              title="live overlay arrives with telemetry integration (slice 2)"
            >
              Live
            </button>
          </div>
          {dirtyCount > 0 ? (
            <span
              className="mgr-readonly-badge mgr-badge-dirty"
              title="staged configuration changes — preview (dry run), then apply to write"
            >
              {dirtyCount} staged
            </span>
          ) : (
            <span
              className="mgr-readonly-badge"
              title="changes stage locally; preview (dry run), then apply writes configuration"
            >
              setup · staged editing
            </span>
          )}
          <span className="mgr-freshness">
            {readAt ? `config read ${fmtTime(readAt.toISOString())}` : ''}
            {promptDirty ? ' · prompt draft unsaved' : ''}
          </span>
        </div>
      </header>

      {(dirtyCount > 0 || preview || configSave.phase !== 'idle') && (
        <section className="mgr-editbar" aria-label="Staged configuration changes">
          <div className="mgr-editbar-row">
            {dirtyCount > 0 ? (
              <span className="mgr-chip mgr-chip-warn">
                <span aria-hidden="true">✎</span> {dirtyCount} staged change
                {dirtyCount === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="mgr-muted">no staged changes</span>
            )}
            <span className="mgr-editbar-note">
              installation-global — applies on the next launch · config and prompt saves are
              separate endpoints, each confirms on its own · provider, pricing and tool edits stay
              in <code>/squad-config</code>
            </span>
            <div className="mgr-editbar-actions">
              <button
                type="button"
                className="mgr-btn mgr-btn-sm"
                onClick={previewChanges}
                disabled={dirtyCount === 0 || configSave.phase === 'busy'}
              >
                {configSave.phase === 'busy' && configSave.op === 'preview'
                  ? 'Checking…'
                  : 'Preview changes'}
              </button>
              <button
                type="button"
                className="mgr-btn mgr-btn-sm mgr-btn-primary"
                onClick={applyChanges}
                disabled={!preview || configSave.phase === 'busy'}
                title="apply is enabled after a successful dry-run preview"
              >
                {configSave.phase === 'busy' && configSave.op === 'apply' ? 'Applying…' : 'Apply'}
              </button>
              <button
                type="button"
                className="mgr-btn mgr-btn-sm"
                onClick={discardChanges}
                disabled={dirtyCount === 0 || configSave.phase === 'busy'}
              >
                Discard
              </button>
            </div>
          </div>

          {configSave.error && (
            <div className="mgr-save-error" role="alert">
              <p className="mgr-error-title">
                {configSave.op === 'apply'
                  ? 'Apply failed — nothing was written; your staged changes are still here.'
                  : 'Preview failed — nothing was written.'}
              </p>
              <p>{configSave.error.message}</p>
              {configSave.error.details.length > 0 && (
                <ul>
                  {configSave.error.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {configSave.phase === 'ok' && configSave.result && (
            <div className="mgr-save-ok" role="status">
              <p className="mgr-save-ok-title">
                ✓ Configuration saved — applies on the next launch of each squad.
              </p>
              {configSave.result.changed?.length > 0 && (
                <p className="mgr-muted">
                  Changed files:{' '}
                  {configSave.result.changed.map((c) => (
                    <code key={c.file}>{c.file}</code>
                  ))}
                </p>
              )}
            </div>
          )}

          {preview && (
            <div className="mgr-preview">
              <p className="mgr-preview-title">
                Preview (dry run — nothing has been written yet)
              </p>
              {preview.warnings?.length > 0 && (
                <div className="mgr-warn-note" role="note">
                  {preview.warnings.map((w, i) => (
                    <div key={i}>
                      <span aria-hidden="true">⚠</span> {w}
                    </div>
                  ))}
                </div>
              )}
              {preview.changed?.length > 0 ? (
                <table className="mgr-table mgr-table-tight">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changed.map((c) => (
                      <tr key={c.file}>
                        <td className="mgr-cell-mono">{c.file}</td>
                        <td className="mgr-cell-mono mgr-diff-before">{c.before}</td>
                        <td className="mgr-cell-mono mgr-diff-after">{c.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mgr-empty-note">
                  No changes to apply — the staged copy matches the server state.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <div className="mgr-body">
        <aside className="mgr-rail">
          <SquadRail
            squads={boardModel}
            selectedSquad={selectedSquad}
            onSelectSquad={selectSquad}
            selectedRole={selectedRole}
            onSelectRole={selectRole}
          />
        </aside>

        <section className={`mgr-center${viewMode === 'list' ? ' mgr-view-list' : ''}`}>
          <div className="mgr-boardbar">
            <div className="mgr-viewtoggle" role="group" aria-label="Board or list view">
              <button
                type="button"
                className="mgr-btn mgr-btn-sm"
                aria-pressed={viewMode === 'board'}
                onClick={() => setViewMode('board')}
              >
                Board
              </button>
              <button
                type="button"
                className="mgr-btn mgr-btn-sm"
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                List
              </button>
            </div>
            <button type="button" className="mgr-btn mgr-btn-sm" onClick={resetLayout}>
              Reset layout
            </button>
          </div>

          <div className="mgr-board" ref={boardRef}>
            {squad.cards.map((card) => (
              <RoleCard
                key={card.key}
                card={card}
                isCoordinator={card.key === COORDINATOR_KEY}
                selected={card.key === selectedRole}
                dragging={card.key === draggingKey}
                position={positions[card.key] || { x: 0, y: 0 }}
                onPointerDown={(e) => onCardPointerDown(e, card)}
                onPointerMove={(e) => onCardPointerMove(e, card)}
                onPointerUp={(e) => onCardPointerUp(e, card)}
                onKeyDown={(e) => onCardKeyDown(e, card)}
              />
            ))}
          </div>

          <RosterTable
            cards={squad.cards}
            selectedRole={selectedRole}
            onSelectRole={selectRole}
          />

          <p className="mgr-board-note">
            <span aria-hidden="true">ⓘ</span> Board positions are presentation only — they never
            change execution order, squad membership, autonomy or permissions. Keyboard: focus a
            card, arrow keys move it (Shift = larger step), Enter selects.
          </p>
        </section>

        <aside className="mgr-inspector-panel">
          <Inspector
            squad={squad}
            card={selectedCard}
            tab={tab}
            onTab={setTab}
            editing={{
              working,
              onStageLead: stageLeadModel,
              onStageModel: stageAgentModel,
              onPromptDirty: setPromptDirty,
            }}
            promptDirty={promptDirty}
          />
        </aside>
      </div>

      <div className="mgr-sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
