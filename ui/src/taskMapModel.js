// Task map pure helpers (P4, semantic task map). No React, no env access, no
// fetch — everything takes its data as arguments so the plain-node tests
// (_tests_taskMap.mjs) can pin the behavior outside Vite.
//
// The scatter is an inline SVG: one marker per task point, colored AND shaped
// by the board stage (identity never rides colour alone — six categorical
// stages cannot clear all-pairs CVD floors on colour, so each stage also owns
// a marker shape), radius encoding cost or duration on a square-root scale
// (area ∝ value), and a full list alternative below the plot for keyboard and
// screen-reader users (also the contrast relief the palette asks for).
//
// A taskKey is "workspace:issueId" and travels through URLs — every URL
// builder here encodes it exactly once, like taskCockpitModel does.

import { formatMoney } from './workModel.js';
import { cockpitUrl } from './taskCockpitModel.js';

// The board's stage order and labels (the same six columns the Work board
// uses; an unknown stage renders with the unknown style, never a crash).
export const STAGE_ORDER = ['ready', 'plan', 'dev', 'review', 'test', 'landed'];
export const STAGE_LABELS = {
  ready: 'Ready',
  plan: 'Plan',
  dev: 'Dev',
  review: 'Review',
  test: 'Test',
  landed: 'Landed',
};

// Marker shape per stage — the secondary (colour-independent) identity
// channel. Colours live in task-map.css as --tm-stage-* custom properties
// (light and dark steps of the validated reference palette, fixed order).
export const STAGE_MARKERS = {
  ready: 'circle',
  plan: 'square',
  dev: 'triangle-up',
  review: 'diamond',
  test: 'triangle-down',
  landed: 'ring',
};
export const UNKNOWN_MARKER = 'circle';

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? (typeof stage === 'string' && stage ? stage : 'Unknown');
}

export function stageMarker(stage) {
  return STAGE_MARKERS[stage] ?? UNKNOWN_MARKER;
}

export function stageColorVar(stage) {
  return STAGE_MARKERS[stage] ? 'var(--tm-stage-' + stage + ')' : 'var(--tm-stage-unknown)';
}

// polygonPoints(shape, cx, cy, r) — the polygon shapes' vertex lists; circle
// and ring render as <circle> elements (isPolygonShape says which is which).
export function isPolygonShape(shape) {
  return shape === 'square' || shape === 'triangle-up' || shape === 'triangle-down' || shape === 'diamond';
}

export function polygonPoints(shape, cx, cy, r) {
  const x = Number(cx);
  const y = Number(cy);
  const rad = Number(r);
  if (![x, y, rad].every(Number.isFinite)) return null;
  switch (shape) {
    case 'square':
      return [
        [x - rad, y - rad], [x + rad, y - rad], [x + rad, y + rad], [x - rad, y + rad],
      ];
    case 'triangle-up':
      return [
        [x, y - rad * 1.15], [x + rad, y + rad * 0.75], [x - rad, y + rad * 0.75],
      ];
    case 'triangle-down':
      return [
        [x, y + rad * 1.15], [x + rad, y - rad * 0.75], [x - rad, y - rad * 0.75],
      ];
    case 'diamond':
      return [
        [x, y - rad * 1.25], [x + rad * 1.25, y], [x, y + rad * 1.25], [x - rad * 1.25, y],
      ];
    default:
      return null;
  }
}

// ===== Radius (cost / time) ==================================================

// The radius band, in px: unknown shrinks to the floor and is also labelled
// "unknown" in the tooltip/legend note — size is never read as a small value.
export const RADIUS_MIN = 4;
export const RADIUS_MAX = 13;
export const RADIUS_UNKNOWN = 3;

// radiusDomain(points, mode) -> { min, max } over the finite positive values
// the mode reads (cost: costUsd, time: durationMs); null when nothing is known.
export function radiusDomain(points, mode) {
  const vals = (Array.isArray(points) ? points : [])
    .map((p) => (mode === 'time' ? p?.durationMs : p?.costUsd))
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// pointRadius(point, mode, domain) -> px. Square-root scale (the circle's
// AREA grows with the value, not with its radius). Unknown/null-safe -> the
// unknown floor.
export function pointRadius(point, mode, domain) {
  const v = mode === 'time' ? point?.durationMs : point?.costUsd;
  if (!domain || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return RADIUS_UNKNOWN;
  const lo = Math.sqrt(domain.min);
  const hi = Math.sqrt(domain.max);
  if (!(hi > lo)) return RADIUS_MAX; // one known value — it IS the maximum
  const t = (Math.sqrt(v) - lo) / (hi - lo);
  return RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * t;
}

export function radiusModeLabel(mode) {
  return mode === 'time' ? 'size = agent time' : 'size = cost';
}

// ===== Scatter layout ========================================================

// scatterLayout(points, opts) — scales the projection coordinates into the
// viewport with even padding; both axes span their own min/max (2D is visual
// only, axes carry no meaning). Flat axes centre their points. Deterministic:
// input order in, items out. Points without finite x/y are skipped — a
// missing coordinate is never invented.
export function scatterLayout(points, { width = 1000, height = 640, padding = 30 } = {}) {
  const list = (Array.isArray(points) ? points : []).filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (!list.length) return { items: [], width, height };
  const xs = list.map((p) => p.x);
  const ys = list.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX > minX ? maxX - minX : 0;
  const spanY = maxY > minY ? maxY - minY : 0;
  const lo = padding;
  const hiX = width - padding;
  const hiY = height - padding;
  const items = list.map((p) => {
    const fx = spanX > 0 ? (p.x - minX) / spanX : 0.5;
    const fy = spanY > 0 ? (p.y - minY) / spanY : 0.5;
    return { ...p, cx: lo + fx * (hiX - lo), cy: hiY - fy * (hiY - lo) };
  });
  return { items, width, height };
}

// ===== Filters / URLs ========================================================

// taskMapQuery(filters) -> '?stage=..&label=..&radius=..'; empty values are
// omitted so the URL stays clean; radius 'cost' is the default and omitted.
// Null-safe on every field.
export function taskMapQuery(filters) {
  const f = filters || {};
  const q = new URLSearchParams();
  if (f.stage) q.set('stage', f.stage);
  if (f.label) q.set('label', f.label);
  if (f.radius && f.radius !== 'cost') q.set('radius', f.radius);
  const s = q.toString();
  return s ? '?' + s : '';
}

// taskMapFiltersFromQuery(query) -> { stage, label, radius } — null-safe on
// the whole query string and on every field (radius falls back to 'cost').
export function taskMapFiltersFromQuery(query) {
  const sp = new URLSearchParams(typeof query === 'string' ? query : '');
  const get = (k) => {
    const v = sp.get(k);
    return v && v.trim() ? v.trim() : null;
  };
  const radius = get('radius');
  return { stage: get('stage'), label: get('label'), radius: radius === 'time' ? 'time' : 'cost' };
}

// taskMapNeighborsUrl(taskKey, limit) — the encoded neighbors GET path.
export function taskMapNeighborsUrl(taskKey, limit) {
  let url = '/api/task-map/neighbors?taskKey=' + encodeURIComponent(String(taskKey ?? ''));
  if (Number.isInteger(limit) && limit >= 1) url += '&limit=' + limit;
  return url;
}

// cockpitHref(taskKey) — the exact encoded task cockpit link.
export function cockpitHref(taskKey) {
  return cockpitUrl(taskKey);
}

// ===== Payload summaries ====================================================

// projectionSummary(projection, counts) -> { text, tiny, detail } — the
// honest state of the projection, tiny-N fallbacks clearly labelled.
export function projectionSummary(projection, counts) {
  if (!projection || projection.available !== true) {
    return {
      text: 'no projection yet',
      tiny: false,
      detail:
        projection && projection.lastError
          ? 'the last build could not fit a projection: ' + projection.lastError
          : 'run a build first',
    };
  }
  const n = typeof counts?.ready === 'number' ? counts.ready : null;
  const points = n == null ? '' : ` — ${n} point${n === 1 ? '' : 's'}`;
  if (projection.kind === 'list') {
    return {
      text: `list view${points} (too few to project)`,
      tiny: true,
      detail: 'a single point gets no geometry — nothing is invented',
    };
  }
  if (projection.kind === 'pca') {
    return {
      text: `deterministic PCA${points} (tiny sample, < 4 points)`,
      tiny: true,
      detail: 'clearly labelled fallback — no invented clusters',
    };
  }
  return {
    text: `UMAP v${projection.version}${points}`,
    tiny: false,
    detail: `seed ${projection.params?.seed ?? '?'}, cosine, n_neighbors ${projection.params?.nNeighbors ?? '?'}`,
  };
}

// unembeddedText(reason) — the human text for a point's absence reason.
const UNEMBEDDED_TEXT = {
  not_embedded: 'not embedded yet — run Build / update embeddings',
  embed_failed: 'embedding failed — the local embedder was unreachable',
  no_text: 'no title/description text to embed',
  not_projected: 'embedded, awaiting projection',
  projection_failed: 'the projection step failed for this build',
  projection_unavailable: 'projection unavailable — python/umap missing on this host',
  incompatible_dims: 'the embedding model changed — rebuild to re-fit',
};

export function unembeddedText(reason) {
  if (reason && UNEMBEDDED_TEXT[reason]) return UNEMBEDDED_TEXT[reason];
  return reason ? `unavailable (${reason})` : 'unavailable';
}

// jobStatusText(job) -> { text, tone } — tone in ok|building|danger|neutral.
export function jobStatusText(job) {
  if (!job) return { text: 'never built', tone: 'neutral' };
  if (job.state === 'running') return { text: 'building…', tone: 'building' };
  if (job.state === 'error') {
    return { text: 'last build failed — ' + (job.error?.message ?? 'unknown error'), tone: 'danger' };
  }
  const at = typeof job.finishedAt === 'string' ? job.finishedAt.replace('T', ' ').slice(0, 19) : '';
  return { text: 'last build finished ' + (at || ''), tone: 'ok' };
}

// corpusSummary(corpus) -> a one-line summary, or null without a corpus.
export function corpusSummary(corpus) {
  if (!corpus) return null;
  const parts = [`corpus: ${corpus.included ?? 0} tickets from ${corpus.workspace ?? '?'}`];
  if (corpus.unavailable) parts.push(`${corpus.unavailable} unavailable`);
  if (corpus.truncated) parts.push(`capped at ${corpus.cap}`);
  return parts.join(', ');
}

// REBUILD_WARNING — the standing explanation next to the Rebuild button:
// coordinates change, similarities do not.
export const REBUILD_WARNING =
  'Rebuild refits the projection (UMAP, seed 42): every existing point gets NEW coordinates — '
  + 'the layout changes, the similarities do not. Filters never refit; use it only after the '
  + 'corpus changed materially.';

// formatDuration(ms) -> '45 s' | '12 min' | '1 h 05 min'; null-safe.
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')} min` : `${h} h`;
}

// neighborsModel(response) -> { taskKey, rows } — null-safe passthrough with
// the similarity rendered as a percentage.
export function neighborsModel(response) {
  const taskKey = response && typeof response.taskKey === 'string' ? response.taskKey : null;
  const rows = (response && Array.isArray(response.neighbors) ? response.neighbors : [])
    .filter((n) => n && typeof n.taskKey === 'string')
    .map((n) => ({
      taskKey: n.taskKey,
      taskId: n.taskId ?? null,
      title: typeof n.title === 'string' ? n.title : '',
      similarityPct:
        typeof n.similarity === 'number' && Number.isFinite(n.similarity)
          ? Math.round(n.similarity * 1000) / 10
          : null,
    }));
  return { taskKey, rows };
}

export { formatMoney };
