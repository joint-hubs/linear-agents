// Pure model for the tool-profiles UI (P2 backend slice — scripts/tool-routes.mjs).
//
// One user-owned registry decides which MCP servers and lead tool lists a
// squad gets: config fields version/revision, mcp.thoughtmap
// {enabled, baseUrl, ollamaBaseUrl, embeddingModel, clustersPath} and
// leadTools {<squad>: array|null}. Worker role tools stay authoritative in
// agents/<squad>/agents/<role>.md frontmatter — roleOverrides are NOT touched
// from this UI (the worker frontmatter remains canonical; the worker-role
// ToolsEditor stages through the shared squad-config working copy).
//
// Semantics pinned here:
//   - null  = inherit (the lead keeps whatever the CLI grants by default; the
//             registry entry is ABSENT after apply — the backend's deep merge
//             deletes a null value)
//   - []    = explicit none (the entry exists and grants nothing)
//   - [..]  = explicit list; names the catalog does not know are preserved but
//             reported unavailable, never granted
//   - globalTools / squadTools (the inheritance layers ABOVE leadTools) share
//     the same value shape and semantics; the backend schema already holds
//     them. The lead resolves leadTools.<squad> ?? squadTools.<squad> ??
//     globalTools ?? null; worker frontmatter stays canonical and the upper
//     layers fill in only when it names no tools.
//
// Pure functions only: no React, no DOM. Fetch helpers use the same-origin
// path like ui/src/api.js but live here — api.js is not extended by this
// slice, and the Node test suite imports this file directly.

// ─── Schema constants (mirror scripts/tool-profiles.mjs) ────────────────────

export const THOUGHTMAP_FIELDS = ['enabled', 'baseUrl', 'ollamaBaseUrl', 'embeddingModel', 'clustersPath'];
export const CONNECTION_FIELDS = ['baseUrl', 'ollamaBaseUrl', 'embeddingModel', 'clustersPath'];
export const MCP_SERVER = 'thoughtmap';

// Anything shaped like a real credential — the backend refuses these outright;
// the UI additionally never RENDERS one (defense in depth: the display path
// scrubs, it does not trust the schema).
const SECRET_VALUE_RE = /sk-or-|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|lin_api_/;
// Field names that must never reach the screen even if a future schema grew
// one by mistake.
const SECRET_KEY_RE = /secret|token|password|passphrase|api[-_]?key|private[-_]?key|credential/i;

export const REDACTED = '[redacted]';

// ─── Secret scrubbing (display only — never mutates what is sent) ───────────

export function isSecretLike(value) {
  return typeof value === 'string' && SECRET_VALUE_RE.test(value);
}

export function isSecretShapedKey(key) {
  return typeof key === 'string' && SECRET_KEY_RE.test(key);
}

/** Deep clone with every secret-shaped string or secret-named field masked. */
export function redactDeep(node) {
  if (Array.isArray(node)) return node.map(redactDeep);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = isSecretShapedKey(key) ? REDACTED : redactDeep(value);
    }
    return out;
  }
  return isSecretLike(node) ? REDACTED : node;
}

/** Change rows (dotted path + before/after) scrubbed for display. */
export function redactChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map((c) => redactDeep(c));
}

// ─── Stable JSON (sorted keys — fingerprints and deep equality) ─────────────

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// ─── The staged working copy (separate from the squad-config working copy) ──

function defaultForField(field) {
  return field === 'enabled' ? false : '';
}

/**
 * The local profile working copy, seeded from the last server read. This is a
 * DIFFERENT object from the squad-config working copy the Manager's edit bar
 * stages — clearly labelled "tool profiles" in the UI, written through a
 * different endpoint, never mixed into the frontmatter payload.
 */
export function stagedFromConfig(config) {
  const tm = config?.mcp?.thoughtmap || {};
  const staged = { thoughtmap: {}, globalTools: null, squadTools: {}, leadTools: {} };
  for (const field of THOUGHTMAP_FIELDS) {
    staged.thoughtmap[field] = tm[field] ?? defaultForField(field);
  }
  staged.globalTools = config?.globalTools ?? null;
  staged.squadTools = JSON.parse(JSON.stringify(config?.squadTools || {}));
  staged.leadTools = JSON.parse(JSON.stringify(config?.leadTools || {}));
  return staged;
}

export function stagedFingerprint(staged) {
  return stableStringify(staged);
}

/** Identity of the connection inputs ONLY — toggling `enabled` does not
 *  invalidate a connectivity test (the probe ignores the enabled flag). */
export function connectionFingerprint(thoughtmap) {
  const form = {};
  for (const field of CONNECTION_FIELDS) form[field] = thoughtmap?.[field] ?? '';
  return stableStringify(form);
}

/** A dry-run preview may only produce an Apply for the staged snapshot it
 *  actually described (same rule as the squad-config edit bar). */
export function previewIsValid(previewFp, currentFp) {
  return !!previewFp && previewFp === currentFp;
}

/** Did the connection inputs change since this verification ran? */
export function connectionInputsChanged(thoughtmap, verifiedForm) {
  if (!verifiedForm) return false;
  return connectionFingerprint(thoughtmap) !== connectionFingerprint(verifiedForm);
}

// ─── The three tool-list layers: globalTools → squadTools → leadTools ───────
//
// All three hold the SAME value shape — null (inherit), [] (explicit none),
// [names] (explicit list) — and share toolMode / toolValueForMode. A lead
// resolves leadTools.<squad> ?? squadTools.<squad> ?? globalTools ?? null
// (resolveToolProfile in scripts/tool-profiles.mjs); a worker's frontmatter
// tools stay canonical and squadTools/globalTools fill in only when the
// frontmatter names no tools. roleOverrides are NOT staged here.

/** Absent entry reads as null (inherit) — for every layer. */
export function listEntry(value) {
  return value === undefined ? null : value;
}

/** The configured globalTools scalar; absent behaves as null. */
export function globalValue(config) {
  return listEntry(config?.globalTools);
}

/** The configured squadTools entry for one squad; absent behaves as null. */
export function squadValue(config, squad) {
  return listEntry(config?.squadTools?.[squad]);
}

/** The configured leadTools entry for one squad; absent behaves as null. */
export function leadValue(config, squad) {
  return listEntry(config?.leadTools?.[squad]);
}

/** 'inherit' | 'none' | 'explicit' — never blended; the UI shows which one. */
export function toolMode(value) {
  if (value === null || value === undefined) return 'inherit';
  if (Array.isArray(value) && value.length === 0) return 'none';
  return 'explicit';
}

/** Staged value for a chosen mode. inherit → null (the merge deletes the
 *  entry), none → [], explicit → the checked list as-is. */
export function toolValueForMode(mode, list) {
  if (mode === 'inherit') return null;
  if (mode === 'none') return [];
  return Array.isArray(list) ? [...list] : [];
}

/** Which layer decides a lead's tools right now — the resolution chain
 *  (first explicit layer wins, 'native' = whatever the CLI grants by default). */
export function effectiveLead(config, squad) {
  const lead = config?.leadTools?.[squad];
  if (lead !== undefined) return { value: lead, source: 'leadTools' };
  const squadEntry = config?.squadTools?.[squad];
  if (squadEntry !== undefined) return { value: squadEntry, source: 'squadTools' };
  if (config?.globalTools !== undefined) return { value: config.globalTools, source: 'globalTools' };
  return { value: null, source: 'native' };
}

/** Squad-key shape pre-screen for the squadTools editor — the backend still
 *  validates membership against the configured squads (plus supervisor). */
export const SQUAD_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ─── Diff + patch (sparse — the backend deep-merges and CASes revisions) ────

/**
 * Dotted paths where the staged copy differs from the server state:
 * `mcp.thoughtmap.<field>`, `globalTools`, `squadTools.<squad>` and
 * `leadTools.<squad>`. Absent server entries count as null (inherit).
 */
export function dirtyPaths(staged, config) {
  if (!staged || !config) return [];
  const out = [];
  for (const field of THOUGHTMAP_FIELDS) {
    const server = config.mcp?.thoughtmap?.[field] ?? defaultForField(field);
    if (staged.thoughtmap?.[field] !== server) out.push(`mcp.thoughtmap.${field}`);
  }
  if (!sameValue(staged.globalTools ?? null, config.globalTools ?? null)) out.push('globalTools');
  const squadKeys = new Set([
    ...Object.keys(staged.squadTools || {}),
    ...Object.keys(config.squadTools || {}),
  ]);
  for (const squad of squadKeys) {
    const stagedV = staged.squadTools?.[squad] ?? null;
    const serverV = config.squadTools?.[squad] ?? null;
    if (!sameValue(stagedV, serverV)) out.push(`squadTools.${squad}`);
  }
  const keys = new Set([
    ...Object.keys(staged.leadTools || {}),
    ...Object.keys(config.leadTools || {}),
  ]);
  for (const squad of keys) {
    const stagedV = staged.leadTools?.[squad] ?? null;
    const serverV = config.leadTools?.[squad] ?? null;
    if (!sameValue(stagedV, serverV)) out.push(`leadTools.${squad}`);
  }
  return out;
}

/** The sparse PUT patch, or null when the staged copy matches the server. */
export function buildPatch(staged, config) {
  if (!staged || !config) return null;
  const patch = {};
  const tmPatch = {};
  for (const field of THOUGHTMAP_FIELDS) {
    const server = config.mcp?.thoughtmap?.[field] ?? defaultForField(field);
    if (staged.thoughtmap?.[field] !== server) tmPatch[field] = staged.thoughtmap?.[field];
  }
  if (Object.keys(tmPatch).length > 0) patch.mcp = { thoughtmap: tmPatch };
  const stagedG = staged.globalTools ?? null;
  const serverG = config.globalTools ?? null;
  if (!sameValue(stagedG, serverG)) patch.globalTools = stagedG; // null deletes → inherit
  const stPatch = {};
  const squadKeys = new Set([
    ...Object.keys(staged.squadTools || {}),
    ...Object.keys(config.squadTools || {}),
  ]);
  for (const squad of squadKeys) {
    const stagedV = staged.squadTools?.[squad] ?? null;
    const serverV = config.squadTools?.[squad] ?? null;
    if (!sameValue(stagedV, serverV)) stPatch[squad] = stagedV; // null deletes → inherit
  }
  if (Object.keys(stPatch).length > 0) patch.squadTools = stPatch;
  const ltPatch = {};
  const keys = new Set([
    ...Object.keys(staged.leadTools || {}),
    ...Object.keys(config.leadTools || {}),
  ]);
  for (const squad of keys) {
    const stagedV = staged.leadTools?.[squad] ?? null;
    const serverV = config.leadTools?.[squad] ?? null;
    if (!sameValue(stagedV, serverV)) ltPatch[squad] = stagedV; // null deletes → inherit
  }
  if (Object.keys(ltPatch).length > 0) patch.leadTools = ltPatch;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The PUT body — revision/version are never patched (backend-managed); the
 *  compare-and-swap expectedRevision comes from the LAST server read. */
export function buildProfilePayload(staged, config, dryRun) {
  const patch = buildPatch(staged, config);
  if (!patch) return null;
  return {
    patch,
    dryRun: !!dryRun,
    expectedRevision: Number.isInteger(config?.revision) ? config.revision : 0,
  };
}

// ─── Catalog merge (native /api/tools + MCP half of tool-profiles) ──────────

/**
 * Merge the native catalog (GET /api/tools: builtin tools + risk levels) with
 * GET /api/tool-profiles/catalog. MCP tools enter the editable set ONLY when
 * the Thoughtmap server counts as enabled. `opts.mcpEnabled`, when a boolean,
 * is the STAGED enabled flag and wins: a checkbox staged in this session must
 * make the mcp__thoughtmap__* tools selectable in the SAME Apply — the
 * catalog's serverEnabled describes the last server read, not the pending
 * change. Without the option (two-arg callers, staged copy not loaded yet) the
 * catalog's own serverEnabled decides, as before. A disabled server's names
 * stay out of the editable set, and configured names the merged catalog does
 * not know are preserved (never dropped, never granted) by splitKnownTools.
 * Availability is never faked: only POST /api/tool-profiles/test verifies a
 * live server.
 */
export function mergeCatalogs(native, tpCatalog, { mcpEnabled } = {}) {
  const tools = {};
  for (const [name, entry] of Object.entries(native?.tools || {})) {
    tools[name] = { ...entry, source: entry?.source || 'builtin' };
  }
  const mcpTools = [];
  for (const [name, entry] of Object.entries(tpCatalog?.tools || {})) {
    if (entry?.source !== 'mcp') continue; // the native catalog already owns builtin entries
    const available = typeof mcpEnabled === 'boolean' ? mcpEnabled : entry.serverEnabled === true;
    mcpTools.push({ name, ...entry, available });
    if (available) tools[name] = { ...entry, source: 'mcp' };
  }
  return {
    tools,
    riskLevels: { ...(tpCatalog?.riskLevels || {}), ...(native?.riskLevels || {}) },
    servers: tpCatalog?.servers || {},
    mcpTools,
    mcpAvailable: mcpTools.some((t) => t.available),
  };
}

export function catalogNames(catalog) {
  return catalog ? Object.keys(catalog.tools || {}).sort() : null;
}

// ─── Connection probe (POST /api/tool-profiles/test — read-only) ────────────

/** Body for the explicit Test connection click: the four connection overrides
 *  only (non-empty strings; the backend fills the rest from the registry).
 *  `enabled` is deliberately not carried — probing connectivity is independent
 *  of the registry's enabled flag. */
export function buildProbeBody(thoughtmap) {
  const body = {};
  for (const field of CONNECTION_FIELDS) {
    const v = thoughtmap?.[field];
    if (typeof v === 'string' && v.trim() !== '') body[field] = v;
  }
  return body;
}

/**
 * An honest check summary: ok is true ONLY when all three MCP handshake
 * stages passed (initialize → tools/list → one read-only search roundtrip);
 * failures carry the code, the server's error line and — for
 * python-unavailable — the dependency hint, so the UI can say "configured but
 * unverifiable" instead of faking a green light.
 */
export function describeCheck(check) {
  if (!check) return null;
  const stages = check.stages || {};
  const stageList = ['initialize', 'toolsList', 'searchRoundtrip'].map((id) => ({
    id,
    passed: stages[id] === true,
  }));
  const ok = check.ok === true;
  return {
    ok,
    stages: stageList,
    passedCount: stageList.filter((s) => s.passed).length,
    tools: Array.isArray(check.tools) ? check.tools.filter((n) => typeof n === 'string') : [],
    ms: Number.isFinite(check.ms) ? check.ms : null,
    failure: ok
      ? null
      : {
          code: check.code ?? null,
          error: check.error ?? null,
          hint: check.hint ?? null,
        },
  };
}

// ─── Same-origin fetch helpers (small local pair — api.js untouched) ────────

/**
 * JSON in, JSON out, same origin as the rest of the dashboard API. Non-OK
 * responses throw an Error carrying .status, the body's `error` text as the
 * message and the parsed body on .data (the 400 `errors` array of the test
 * endpoint and the 400 revision-conflict text both reach the caller verbatim).
 */
export async function tpFetch(path, { method = 'GET', body, signal, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(path, {
    method,
    signal,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(data?.error || `API ${r.status}`);
    err.status = r.status;
    if (data) err.data = data;
    throw err;
  }
  return data;
}

export function getToolProfiles(signal, fetchImpl) {
  return tpFetch('/api/tool-profiles', { signal, fetchImpl });
}

export function getToolProfilesCatalog(signal, fetchImpl) {
  return tpFetch('/api/tool-profiles/catalog', { signal, fetchImpl });
}

export function putToolProfiles(payload, fetchImpl) {
  return tpFetch('/api/tool-profiles', { method: 'PUT', body: payload, fetchImpl });
}

export function postToolProfilesTest(body, fetchImpl) {
  return tpFetch('/api/tool-profiles/test', { method: 'POST', body, fetchImpl });
}

/** Failed preview/apply/test → {message, details[]} for the error banner. */
export function normalizeTpError(err) {
  const details = err?.data?.errors;
  return {
    message: err?.message || String(err),
    details: Array.isArray(details) ? details : [],
  };
}