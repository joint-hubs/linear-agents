// Fenix Manager — tactical board (FOC-225 slice 1 part 1).
// Read-only view over /api/squad-config: board, roster, inspector. Layout
// positions are presentation preferences persisted per installation + squad;
// moving a card never issues a request or changes execution semantics.
// Configuration editing (staged changes, preview/apply) arrives with
// slice 1 part 2 — the header reserves the unsaved-change slot.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getSquadConfig } from '../api';
import { fmtTime } from '../utils.js';
import { buildBoardModel, installFingerprint, COORDINATOR_KEY } from '../manager/identity.js';
import {
  loadLayout,
  saveLayout,
  defaultPositions,
  clampPosition,
} from '../manager/layout.js';
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
      setConfig(cfg);
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
        setSelectedRole(card.key);
      }
    },
    [persistLayout]
  );

  const onCardKeyDown = useCallback(
    (e, card) => {
      const step = e.shiftKey ? MOVE_STEP_LARGE : MOVE_STEP;
      if (ARROW_MOVES[e.key]) {
        e.preventDefault();
        moveCard(card.key, ARROW_MOVES[e.key][0], ARROW_MOVES[e.key][1]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setSelectedRole(card.key);
      }
    },
    [moveCard]
  );

  const resetLayout = useCallback(() => {
    if (!squad) return;
    const def = defaultPositions(roleKeys);
    positionsRef.current = def;
    setPositions(def);
    persistLayout(def);
    setAnnounce('layout reset to defaults');
  }, [squad, roleKeys, persistLayout]);

  const onSelectSquad = useCallback((key) => {
    setSearchParams({ squad: key });
  }, [setSearchParams]);

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
              onChange={(e) => onSelectSquad(e.target.value)}
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
          <span className="mgr-readonly-badge" title="configuration editing arrives with slice 1 part 2">
            read-only view
          </span>
          <span className="mgr-freshness">
            {readAt ? `config read ${fmtTime(readAt.toISOString())}` : ''}
          </span>
        </div>
      </header>

      <div className="mgr-body">
        <aside className="mgr-rail">
          <SquadRail
            squads={boardModel}
            selectedSquad={selectedSquad}
            onSelectSquad={onSelectSquad}
            selectedRole={selectedRole}
            onSelectRole={setSelectedRole}
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
            onSelectRole={setSelectedRole}
          />

          <p className="mgr-board-note">
            <span aria-hidden="true">ⓘ</span> Board positions are presentation only — they never
            change execution order, squad membership, autonomy or permissions. Keyboard: focus a
            card, arrow keys move it (Shift = larger step), Enter selects.
          </p>
        </section>

        <aside className="mgr-inspector-panel">
          <Inspector squad={squad} card={selectedCard} tab={tab} onTab={setTab} />
        </aside>
      </div>

      <div className="mgr-sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
