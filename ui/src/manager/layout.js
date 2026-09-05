// Versioned board layout preferences (FOC-225). Positions are presentation
// only — they never touch execution order, membership, autonomy or
// permissions. Stored per installation + squad in localStorage under a
// versioned key; migration and recovery are pure functions so tests pin them.
//
// v2 record:  { version: 2, installKey, squad, positions, updatedAt }
// v1 legacy:  { positions } — no version field (pre-release shape).
// Anything else: corrupt or from a future version → defaults, never a guess.

import { COORDINATOR_KEY } from './identity.js';

export const LAYOUT_VERSION = 2;
export const STORAGE_PREFIX = 'fenix:manager:layout';

export function storageKey(installKey, squad) {
  return `${STORAGE_PREFIX}:v${LAYOUT_VERSION}:${installKey}:${squad}`;
}

export function clampPosition(pos) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    x: Math.min(100, Math.max(0, num(pos?.x))),
    y: Math.min(100, Math.max(0, num(pos?.y))),
  };
}

// Coordinator top-center, specialists in a grid below. The grouping is a
// visual convention, NOT an execution edge — no arrows, no implied order.
export function defaultPositions(roleKeys) {
  const positions = {};
  const specialists = roleKeys.filter((k) => k !== COORDINATOR_KEY);
  if (roleKeys.includes(COORDINATOR_KEY)) {
    positions[COORDINATOR_KEY] = { x: 38, y: 6 };
  }
  const perRow = 3;
  const rowY = [36, 66];
  specialists.forEach((k, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    positions[k] = { x: 6 + col * 32, y: rowY[Math.min(row, rowY.length - 1)] };
  });
  return positions;
}

// v1 → v2 migration; v2 passes through; unknown version → null (defaults).
export function migrateLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const positions = raw.positions;
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) return null;
  if (raw.version === LAYOUT_VERSION) {
    return {
      version: LAYOUT_VERSION,
      installKey: typeof raw.installKey === 'string' ? raw.installKey : null,
      squad: typeof raw.squad === 'string' ? raw.squad : null,
      positions,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  }
  if (raw.version == null) {
    return {
      version: LAYOUT_VERSION,
      installKey: null,
      squad: null,
      positions,
      updatedAt: null,
      migratedFromVersion: 1,
    };
  }
  return null;
}

// Keep only known roles, clamp every position, fill defaults for roles that
// have none. Unknown role keys (config changed since save) are dropped.
export function normalizePositions(positions, roleKeys) {
  const defaults = defaultPositions(roleKeys);
  const known = new Set(roleKeys);
  const out = {};
  for (const k of roleKeys) {
    const pos = positions?.[k];
    out[k] = known.has(k) && pos ? clampPosition(pos) : defaults[k];
  }
  return out;
}

// Returns { positions, migratedFromVersion }. Corrupt storage, unreadable
// storage or an unknown schema all yield defaults — the board must never
// crash because a preference record is bad.
export function loadLayout(storage, installKey, squad, roleKeys) {
  const fallback = defaultPositions(roleKeys);
  let raw = null;
  try {
    raw = storage.getItem(storageKey(installKey, squad));
  } catch {
    return { positions: fallback, migratedFromVersion: null };
  }
  if (!raw) return { positions: fallback, migratedFromVersion: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { positions: fallback, migratedFromVersion: null };
  }
  const migrated = migrateLayout(parsed);
  if (!migrated) return { positions: fallback, migratedFromVersion: null };
  return {
    positions: normalizePositions(migrated.positions, roleKeys),
    migratedFromVersion: migrated.migratedFromVersion ?? null,
  };
}

// Save returns the stored record (or null when storage is unavailable —
// e.g. private mode); layout persistence must never break the board.
export function saveLayout(storage, installKey, squad, positions) {
  const clamped = {};
  for (const [k, pos] of Object.entries(positions || {})) clamped[k] = clampPosition(pos);
  const record = {
    version: LAYOUT_VERSION,
    installKey,
    squad,
    positions: clamped,
    updatedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(storageKey(installKey, squad), JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}
