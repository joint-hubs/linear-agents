// Shared working-copy logic for squad configuration editing (FOC-225).
//
// Extracted from screens/SquadConfig.jsx so that the Manager inspector stages
// the SAME configuration change through the SAME payload shape — one writer,
// one semantics. SquadConfig keeps owning its route; Manager only borrows the
// mechanics. Pure functions only: no React, no fetch, no import.meta — the
// plain-Node test suite exercises them directly.

export const DEFAULT_PROVIDER = 'openrouter';

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Normalize agents from old shape (string) to new shape ({model, tools}). */
export function normalizeAgents(agents) {
  if (!agents) return agents;
  const out = {};
  for (const [role, val] of Object.entries(agents)) {
    if (typeof val === 'object' && val !== null) {
      out[role] = { model: val.model || '', tools: val.tools || [] };
    } else {
      out[role] = { model: val || '', tools: [] };
    }
  }
  return out;
}

// Server payload → working copy {squads, pricing, providers} with agents
// normalized. Also used for "discard": rebuilding from the last server read.
export function buildWorkingCopy(data) {
  const squads = deepClone(data?.squads || {});
  for (const s of Object.keys(squads)) {
    if (squads[s]?.agents) squads[s].agents = normalizeAgents(squads[s].agents);
  }
  return {
    squads,
    pricing: deepClone(data?.pricing || {}),
    providers: deepClone(data?.providers || {}),
  };
}

function samePrice(a, b) {
  return (a?.input ?? 0) === (b?.input ?? 0)
    && (a?.output ?? 0) === (b?.output ?? 0)
    && (a?.cacheRead ?? 0) === (b?.cacheRead ?? 0)
    && (a?.cacheWrite ?? 0) === (b?.cacheWrite ?? 0);
}

// Number of changed fields between the server state and the working copy —
// the "N unsaved changes" badge. Counts squads (lead, provider, agent
// model/tools), provider profiles and pricing rows.
export function countDirty(orig, edit) {
  if (!orig || !edit) return 0;
  let n = 0;

  // Squads: lead, provider, agent models/tools
  for (const s of Object.keys(orig.squads || {})) {
    const o = orig.squads?.[s];
    const e = edit.squads?.[s];
    if (!o || !e) continue;
    if (o.lead !== e.lead) n++;
    if ((o.provider || DEFAULT_PROVIDER) !== (e.provider || DEFAULT_PROVIDER)) n++;
    if (o.agents) {
      for (const [role, agent] of Object.entries(o.agents)) {
        const ea = e.agents?.[role];
        if (!ea) { n++; continue; }
        if (agent.model !== ea.model) n++;
        const ot = JSON.stringify([...(agent.tools || [])].sort());
        const et = JSON.stringify([...(ea.tools || [])].sort());
        if (ot !== et) n++;
      }
    }
  }

  // Providers: add/edit/remove
  const providerNames = new Set([
    ...Object.keys(orig.providers || {}),
    ...Object.keys(edit.providers || {}),
  ]);
  for (const p of providerNames) {
    const o = orig.providers?.[p];
    const e = edit.providers?.[p];
    if (JSON.stringify(o ?? null) !== JSON.stringify(e ?? null)) n++;
  }

  // Pricing: nested per provider
  const pricingProviders = new Set([
    ...Object.keys(orig.pricing || {}),
    ...Object.keys(edit.pricing || {}),
  ]);
  for (const p of pricingProviders) {
    const slugs = new Set([
      ...Object.keys(orig.pricing?.[p] || {}),
      ...Object.keys(edit.pricing?.[p] || {}),
    ]);
    for (const slug of slugs) {
      const o = orig.pricing?.[p]?.[slug];
      const e = edit.pricing?.[p]?.[slug];
      if ((o === undefined) !== (e === undefined)) { n++; continue; }
      if (o && e && !samePrice(o, e)) n++;
    }
  }
  return n;
}

// Stage a lead (coordinator) model change. Returns a NEW copy; unknown squad
// → unchanged copy. Tools and other squad fields are preserved.
export function setLeadModel(copy, squad, model) {
  const entry = copy?.squads?.[squad];
  if (!entry) return copy;
  return {
    ...copy,
    squads: { ...copy.squads, [squad]: { ...entry, lead: model } },
  };
}

// Stage a role model change (the same change the SquadConfig editor stages).
// Preserves the role's tools; creates the agent entry when missing; unknown
// squad → unchanged copy.
export function setAgentModel(copy, squad, role, model) {
  const entry = copy?.squads?.[squad];
  if (!entry) return copy;
  const agents = entry.agents || {};
  const existing = agents[role];
  const tools = (existing && typeof existing === 'object') ? (existing.tools || []) : [];
  return {
    ...copy,
    squads: {
      ...copy.squads,
      [squad]: { ...entry, agents: { ...agents, [role]: { model, tools } } },
    },
  };
}

// The POST body for preview (dryRun: true) and apply (dryRun: false) — the
// exact shape /api/squad-config expects: the full working copy plus the flag.
export function buildSavePayload(copy, dryRun) {
  return {
    squads: copy?.squads || {},
    pricing: copy?.pricing || {},
    providers: copy?.providers || {},
    dryRun,
  };
}

// Failed preview/apply → {message, details[]} for the error banner. The API
// layer attaches the response body to err.data; validation details live at
// err.data.details. Non-array details are dropped, never guessed.
export function normalizeSaveError(err) {
  const details = err?.data?.details;
  return {
    message: err?.message || String(err),
    details: Array.isArray(details) ? details : [],
  };
}
