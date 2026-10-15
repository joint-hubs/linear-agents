import './task-map.css';
// TaskMap (P4, semantic task map) — the /insights/map screen.
//
// A local inline-SVG scatter of the persisted projection: one marker per task
// point, colored AND shaped by board stage (identity never rides colour
// alone), radius on a square-root scale encoding cost or agent time. Hover
// shows the fixed info strip (aria-live); click SELECTS — the cockpit is
// opened only through the explicit "Open cockpit" button. The full point list
// below the plot is the accessible alternative (and the palette's relief
// rule: three light-mode stage colors sit below 3:1 on the light surface, so
// every point's identity is always readable as text).
//
// Transport discipline mirrors the API contract: GET NEVER builds or embeds —
// it serves the persisted projection only; the two buttons POST
// /api/task-map/build (rebuild:false = update embeddings, rebuild:true =
// refit the projection, warned in place). Filters and the radius mode ride
// the URL and NEVER trigger a build. The background job is followed through
// the same poll (status/build ride the /api/task-map payload).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { usePoll } from '../hooks/usePoll.js';
import { formatMoney } from '../workModel.js';
import {
  RADIUS_UNKNOWN,
  REBUILD_WARNING,
  STAGE_ORDER,
  cockpitHref,
  corpusSummary,
  formatDuration,
  isPolygonShape,
  jobStatusText,
  neighborsModel,
  pointRadius,
  polygonPoints,
  projectionSummary,
  radiusDomain,
  radiusModeLabel,
  scatterLayout,
  stageColorVar,
  stageLabel,
  stageMarker,
  taskMapFiltersFromQuery,
  taskMapNeighborsUrl,
  taskMapQuery,
  unembeddedText,
} from '../taskMapModel.js';

const API_BASE = import.meta.env.VITE_API_BASE || '';

// Same contract as api.js's helpers (api.js is not this slice's file): a
// non-OK response throws an Error carrying .status and the parsed body
// (.data) so the 409 "already building" can be told apart from a failure.
async function apiGet(path, signal) {
  const r = await fetch(API_BASE + path, { signal });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((data && data.error) || 'API ' + r.status);
    err.status = r.status;
    if (data) err.data = data;
    throw err;
  }
  return data;
}

async function apiPost(path, payload) {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || 'API ' + r.status);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

const UNEMBEDDED_LIST_CAP = 20;
const PLOT_WIDTH = 1000;
const PLOT_HEIGHT = 640;
const PLOT_PADDING = 28;

export default function TaskMap() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = taskMapFiltersFromQuery(searchParams.toString());
  const { stage, label, radius } = filters;

  // Filters go through the URL (shareable, back-button friendly); the radius
  // mode is a pure rendering switch and never refetches.
  const setFilters = useCallback(
    (next) => {
      setSearchParams(taskMapQuery(next) ? taskMapQuery(next).slice(1) : '');
    },
    [setSearchParams],
  );

  const fetcher = useCallback(
    (signal) => apiGet('/api/task-map' + taskMapQuery({ stage, label }), signal),
    [stage, label],
  );
  const { data, error, loading, refresh } = usePoll(fetcher, 5000, [stage, label]);

  const points = useMemo(() => (Array.isArray(data?.points) ? data.points : []), [data]);
  const unembedded = useMemo(() => (Array.isArray(data?.unembedded) ? data.unembedded : []), [data]);
  const status = data?.status ?? null;
  const projection = data?.projection ?? status?.projection ?? null;
  const job = data?.build ?? null;
  const corpus = data?.corpus ?? null;
  const destination = data?.destination ?? null;

  // The radius domain is computed over the CURRENT points; a filter change
  // rescales the sizes (documented in the legend note), never refits.
  const domain = useMemo(() => radiusDomain(points, radius), [points, radius]);

  const layout = useMemo(
    () => scatterLayout(points, { width: PLOT_WIDTH, height: PLOT_HEIGHT, padding: PLOT_PADDING }),
    [points],
  );

  const labels = useMemo(() => {
    const set = new Set();
    for (const p of points) for (const l of p.labels ?? []) if (l) set.add(l);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [points]);

  // ── selection + neighbors ────────────────────────────────────────────────
  const [selectedKey, setSelectedKey] = useState(null);
  const [neighbors, setNeighbors] = useState(null); // { taskKey, rows } | null
  const [neighborsError, setNeighborsError] = useState(null);
  const selected = useMemo(
    () => points.find((p) => p.taskKey === selectedKey) ?? null,
    [points, selectedKey],
  );

  const selectPoint = useCallback((taskKey) => {
    setSelectedKey(taskKey);
    setNeighbors(null);
    setNeighborsError(null);
  }, []);

  useEffect(() => {
    if (!selectedKey) return undefined;
    const controller = new AbortController();
    apiGet(taskMapNeighborsUrl(selectedKey, 5), controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setNeighbors(neighborsModel(res));
          setNeighborsError(null);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        setNeighbors(null);
        setNeighborsError(err?.message || 'the neighbors lookup failed');
      });
    return () => controller.abort();
  }, [selectedKey]);

  // Deselect when the filter hides the selected point (never a stale panel).
  useEffect(() => {
    if (selectedKey && !selected) {
      setSelectedKey(null);
      setNeighbors(null);
      setNeighborsError(null);
    }
  }, [selectedKey, selected]);

  // ── build actions ────────────────────────────────────────────────────────
  const [actionError, setActionError] = useState(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const building = job?.state === 'running';

  async function startBuild(rebuild) {
    setActionError(null);
    if (rebuild) {
      if (!confirmRebuild) {
        setConfirmRebuild(true);
        return;
      }
      setConfirmRebuild(false);
    }
    try {
      await apiPost('/api/task-map/build', { rebuild });
      refresh();
    } catch (err) {
      // 409 = a build is already running — not a failure; the poll shows it.
      if (err.status !== 409) setActionError(err.message);
      refresh();
    }
  }

  // ── hover ────────────────────────────────────────────────────────────────
  const [hoverKey, setHoverKey] = useState(null);
  const infoPoint = points.find((p) => p.taskKey === hoverKey) ?? selected ?? null;

  const jobStatus = jobStatusText(job);
  const projSummary = projectionSummary(projection, status?.counts ?? null);

  return (
    <div className="screen task-map">
      <div className="tm-head">
        <h2 className="section-h">Task map</h2>
        <p className="muted">
          Semantic map of the board's tickets: similar titles/descriptions land near each other.
          2D is visual only — neighbors are computed on the original embeddings.
        </p>
      </div>

      {error && <div className="banner banner-error">the task map could not be loaded: {error.message}</div>}
      {actionError && <div className="banner banner-error">{actionError}</div>}
      {corpus?.warning && <div className="banner banner-warn">{corpus.warning}</div>}

      <div className="tm-toolbar">
        <label className="tm-filter">
          Stage
          <select
            className="filter-sel"
            value={stage ?? ''}
            onChange={(e) => setFilters({ ...filters, stage: e.target.value || null })}
          >
            <option value="">all stages</option>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>{stageLabel(s)}</option>
            ))}
          </select>
        </label>
        <label className="tm-filter">
          Label
          <select
            className="filter-sel"
            value={label ?? ''}
            onChange={(e) => setFilters({ ...filters, label: e.target.value || null })}
          >
            <option value="">all labels</option>
            {labels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <fieldset className="tm-radios">
          <legend className="muted">Marker size</legend>
          <label>
            <input
              type="radio"
              name="tm-radius"
              checked={radius !== 'time'}
              onChange={() => setFilters({ ...filters, radius: 'cost' })}
            />
            cost
          </label>
          <label>
            <input
              type="radio"
              name="tm-radius"
              checked={radius === 'time'}
              onChange={() => setFilters({ ...filters, radius: 'time' })}
            />
            agent time
          </label>
        </fieldset>
        <div className="tm-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={building}
            onClick={() => startBuild(false)}
          >
            Build / update embeddings
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={building}
            onClick={() => startBuild(true)}
          >
            Rebuild projection…
          </button>
        </div>
      </div>

      {confirmRebuild && (
        <div className="banner banner-warn" role="alert">
          <p>{REBUILD_WARNING}</p>
          <div className="tm-confirm-row">
            <button type="button" className="btn-secondary" onClick={() => startBuild(true)}>
              Confirm rebuild
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmRebuild(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="tm-statusline" aria-live="polite">
        <span className={`tm-job tm-job-${jobStatus.tone}`}>{jobStatus.text}</span>
        <span className="muted">{projSummary.text}</span>
        {corpusSummary(corpus) && <span className="muted">{corpusSummary(corpus)}</span>}
        {destination?.cacheDir && (
          <span className="muted">cache: local ({destination.embedding?.model ?? 'local embedder'})</span>
        )}
      </div>

      {loading && !data && <p className="muted">loading…</p>}

      {!loading && !error && points.length === 0 && (
        <div className="tm-empty">
          <p className="muted">
            {unembedded.length > 0
              ? 'No points yet — the tickets are known but not embedded.'
              : 'No points yet. Run "Build / update embeddings" to embed the board.'}
          </p>
          {projSummary.tiny && <p className="muted">{projSummary.detail}</p>}
        </div>
      )}

      {points.length > 0 && (
        <>
          <div className="tm-infostrip" aria-live="polite">
            {infoPoint ? (
              <PointSummary point={infoPoint} />
            ) : (
              <span className="muted">
                Hover a point for details; click to select. {radiusModeLabel(radius)}
                {domain ? ` (${formatMoney(domain.min)}–${formatMoney(domain.max)} or ms)` : ' — nothing measurable on this filter yet'}.
              </span>
            )}
          </div>

          <div className="tm-legend" aria-label="stage legend">
            {STAGE_ORDER.map((s) => (
              <LegendItem key={s} stage={s} />
            ))}
          </div>

          <div className="tm-plot" role="img" aria-label={`Task map scatter, ${points.length} points`}>
            <svg
              viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
              width={PLOT_WIDTH}
              height={PLOT_HEIGHT}
              className="tm-svg"
            >
              <rect
                x="0"
                y="0"
                width={PLOT_WIDTH}
                height={PLOT_HEIGHT}
                className="tm-plot-bg"
                rx="8"
                onMouseEnter={() => setHoverKey(null)}
              />
              {layout.items.map((item) => {
                const r = pointRadius(item, radius, domain);
                const shape = stageMarker(item.stage);
                const fill = stageColorVar(item.stage);
                const isSelected = item.taskKey === selectedKey;
                const common = {
                  fill,
                  stroke: isSelected ? 'var(--accent)' : 'var(--surface)',
                  strokeWidth: 2,
                  className: 'tm-point' + (isSelected ? ' tm-point-selected' : ''),
                  onMouseEnter: () => setHoverKey(item.taskKey),
                  onMouseLeave: () => setHoverKey(null),
                  onClick: () => selectPoint(item.taskKey),
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': `${item.taskKey} ${item.title}`,
                  onKeyUp: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectPoint(item.taskKey);
                    }
                  },
                };
                const title = (
                  <title>
                    {`${item.taskKey} — ${item.title} · ${stageLabel(item.stage)} · ${
                      item.costUsd != null ? formatMoney(item.costUsd) : 'cost unknown'
                    } · ${formatDuration(item.durationMs) ?? 'time unknown'}`}
                  </title>
                );
                if (!isPolygonShape(shape)) {
                  return (
                    <g key={item.taskKey}>
                      {shape === 'ring' ? (
                        <circle
                          cx={item.cx}
                          cy={item.cy}
                          r={r}
                          {...common}
                          fill="none"
                          stroke={isSelected ? 'var(--accent)' : fill}
                          strokeWidth={3}
                        >
                          {title}
                        </circle>
                      ) : (
                        <circle cx={item.cx} cy={item.cy} r={r} {...common}>{title}</circle>
                      )}
                    </g>
                  );
                }
                const pts = polygonPoints(shape, item.cx, item.cy, r);
                return (
                  <g key={item.taskKey}>
                    <polygon points={pts.map((p) => p.join(',')).join(' ')} {...common}>{title}</polygon>
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="muted tm-plotnote">
            {radiusModeLabel(radius)}; points without a known value render at the small "unknown" size
            ({RADIUS_UNKNOWN} px). Filtering rescales the sizes — it never refits the layout.
          </p>

          {selected && (
            <div className="tm-selected">
              <h3 className="section-h">Selected: {selected.taskKey}</h3>
              <PointSummary point={selected} />
              <a className="btn-secondary tm-open" href={cockpitHref(selected.taskKey)}>
                Open cockpit
              </a>
              <div className="tm-neighbors">
                <h4 className="section-h">Nearest neighbors (original embeddings, cosine)</h4>
                {neighborsError && <p className="muted">{neighborsError}</p>}
                {!neighborsError && !neighbors && <p className="muted">loading neighbors…</p>}
                {neighbors && neighbors.rows.length === 0 && (
                  <p className="muted">no neighbors yet — the other tickets are not embedded</p>
                )}
                {neighbors && neighbors.rows.length > 0 && (
                  <ul className="tm-neighbor-list">
                    {neighbors.rows.map((n) => (
                      <li key={n.taskKey}>
                        <button type="button" className="tm-neighbor-btn" onClick={() => selectPoint(n.taskKey)}>
                          <span className="tm-neighbor-key">{n.taskKey}</span>
                          <span className="tm-neighbor-title">{n.title || n.taskKey}</span>
                          <span className="muted">{n.similarityPct != null ? `${n.similarityPct}%` : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <div className="tm-alternatives">
            <label className="tm-filter">
              Jump to a point
              <select
                className="filter-sel"
                value={selectedKey ?? ''}
                onChange={(e) => selectPoint(e.target.value || null)}
              >
                <option value="">— select —</option>
                {points.map((p) => (
                  <option key={p.taskKey} value={p.taskKey}>
                    {`${p.taskKey} — ${p.title} (${stageLabel(p.stage)})`}
                  </option>
                ))}
              </select>
            </label>
            <div className="tm-list">
              <h4 className="section-h">All points ({points.length})</h4>
              <ul className="tm-pointlist">
                {points.map((p) => (
                  <li key={p.taskKey}>
                    <button
                      type="button"
                      className={'tm-pointlist-btn' + (p.taskKey === selectedKey ? ' tm-selected-row' : '')}
                      onClick={() => selectPoint(p.taskKey)}
                      onMouseEnter={() => setHoverKey(p.taskKey)}
                      onMouseLeave={() => setHoverKey(null)}
                    >
                      <svg width="16" height="16" aria-hidden="true" className="tm-swatch">
                        <ListSwatch stage={p.stage} />
                      </svg>
                      <span className="tm-neighbor-key">{p.taskKey}</span>
                      <span className="tm-neighbor-title">{p.title}</span>
                      <span className="muted">
                        {stageLabel(p.stage)}
                        {p.costUsd != null ? ` · ${formatMoney(p.costUsd)}` : ''}
                        {p.durationMs != null ? ` · ${formatDuration(p.durationMs)}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}

      {unembedded.length > 0 && (
        <div className="tm-unembedded">
          <h4 className="section-h">
            Not on the map ({unembedded.length}
            {unembedded.length > UNEMBEDDED_LIST_CAP ? `, first ${UNEMBEDDED_LIST_CAP} shown` : ''})
          </h4>
          <ul className="tm-unembedded-list">
            {unembedded.slice(0, UNEMBEDDED_LIST_CAP).map((u) => (
              <li key={u.taskKey ?? u.taskId ?? Math.random()}>
                <span className="tm-neighbor-key">{u.taskKey ?? u.taskId ?? '?'}</span>
                <span className="muted">{unembeddedText(u.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// PointSummary — the hover/select strip and the selected panel share it.
function PointSummary({ point }) {
  return (
    <span className="tm-pointsummary">
      <strong>{point.taskKey}</strong> {point.title}
      {' · '}
      {stageLabel(point.stage)}
      {(point.labels ?? []).length > 0 && ` · ${point.labels.join(', ')}`}
      {` · ${point.costUsd != null ? formatMoney(point.costUsd) : 'cost unknown'}`}
      {` · ${formatDuration(point.durationMs) ?? 'time unknown'}`}
    </span>
  );
}

// LegendItem — shape + color for one stage (identity shown, not just told).
function LegendItem({ stage }) {
  const shape = stageMarker(stage);
  const fill = stageColorVar(stage);
  return (
    <span className="tm-legend-item">
      <svg width="18" height="18" aria-hidden="true" className="tm-swatch">
        {shape === 'ring' ? (
          <circle cx="9" cy="9" r="5" fill="none" stroke={fill} strokeWidth="3" />
        ) : isPolygonShape(shape) ? (
          <polygon points={polygonPoints(shape, 9, 9, 5).map((p) => p.join(',')).join(' ')} fill={fill} />
        ) : (
          <circle cx="9" cy="9" r="5" fill={fill} />
        )}
      </svg>
      {stageLabel(stage)}
    </span>
  );
}

// ListSwatch — the same marker at list scale.
function ListSwatch({ stage }) {
  const shape = stageMarker(stage);
  const fill = stageColorVar(stage);
  if (shape === 'ring') return <circle cx="8" cy="8" r="4" fill="none" stroke={fill} strokeWidth="3" />;
  if (isPolygonShape(shape)) {
    return <polygon points={polygonPoints(shape, 8, 8, 4).map((p) => p.join(',')).join(' ')} fill={fill} />;
  }
  return <circle cx="8" cy="8" r="4" fill={fill} />;
}
