// Pure adapters: /api/squad-config payload -> manager board model (FOC-225).
// Everything the board shows comes from the payload or is an explicit
// unknown — no invented agent identities, none inferred from model names.
// These functions are the tested identity contract; UI code must not
// reshape the payload itself.

// The coordinator card key. Underscore keys are the repo-wide metadata
// convention, so `_lead` cannot collide with a real role file.
export const COORDINATOR_KEY = '_lead';

// Stable installation fingerprint: sorted squad keys only. Role/model edits
// do NOT change it (layouts survive config edits); adding or removing a
// squad is a reconfiguration and starts a fresh layout. Short hash is fine —
// this only namespaces localStorage keys.
export function installFingerprint(config) {
  const names = Object.keys(config?.squads || {})
    .sort()
    .join(',');
  let h = 0;
  for (let i = 0; i < names.length; i++) h = (Math.imul(31, h) + names.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Model catalogue for a provider profile: explicit `models` entries plus the
// `tiers` map (both its tier names and the model ids they resolve to are
// legitimate configured values).
function modelCatalog(providerProfile) {
  const ids = new Set();
  const tiers = providerProfile?.tiers;
  if (Array.isArray(providerProfile?.models)) {
    for (const m of providerProfile.models) if (typeof m === 'string') ids.add(m);
  }
  if (tiers && typeof tiers === 'object') {
    for (const [tier, resolved] of Object.entries(tiers)) {
      if (typeof tier === 'string') ids.add(tier);
      if (typeof resolved === 'string') ids.add(resolved);
    }
  }
  return ids;
}

// 'unconfigured' — no model assigned. 'unknown' — a catalogue exists and does
// not list this model. 'configured' — assigned, and listed when a catalogue
// is available to check. No catalogue → the board never claims unknown.
export function resolveModelState(model, providerProfile) {
  if (!model) return 'unconfigured';
  const catalog = modelCatalog(providerProfile);
  if (catalog.size === 0) return 'configured';
  return catalog.has(model) ? 'configured' : 'unknown';
}

// "3 tools: Edit, Bash, +1" / "no tools configured" — pure for tests. The
// list is sanitized here too, so the label never counts non-string junk.
export function toolSummary(tools) {
  const clean = Array.isArray(tools)
    ? tools.filter((t) => typeof t === 'string' && t.trim() !== '')
    : [];
  if (clean.length === 0) {
    return { count: 0, label: 'no tools configured' };
  }
  const shown = clean.slice(0, 2).join(', ');
  const rest = clean.length - 2;
  return {
    count: clean.length,
    label: `${clean.length} tool${clean.length === 1 ? '' : 's'}: ${shown}${rest > 0 ? ` +${rest}` : ''}`,
  };
}

function resolveRole(roleKey, role, providerProfile) {
  const tools = Array.isArray(role?.tools)
    ? role.tools.filter((t) => typeof t === 'string' && t.trim() !== '')
    : [];
  return {
    key: roleKey,
    model: typeof role?.model === 'string' && role.model.trim() !== '' ? role.model : null,
    modelState: resolveModelState(role?.model, providerProfile),
    tools,
    toolSummary: toolSummary(tools),
  };
}

// Board model: squads sorted by key; roles sorted by key with the coordinator
// card first. `coordinatorOnly` marks a squad with no specialist roles (the
// supervisor) — the UI renders that honestly, never with placeholder roles.
export function buildBoardModel(config) {
  const squads = config?.squads || {};
  const providers = config?.providers || {};
  return Object.keys(squads)
    .sort()
    .map((key) => {
      const squad = squads[key] || {};
      const providerProfile = squad.provider ? providers[squad.provider] : undefined;
      const roles = Object.keys(squad.agents || {})
        .sort()
        .map((rk) => resolveRole(rk, squad.agents[rk], providerProfile));
      return {
        key,
        provider: squad.provider || 'unknown',
        lead: typeof squad.lead === 'string' ? squad.lead : null,
        leadFiles: Array.isArray(squad.leadFiles) ? squad.leadFiles : [],
        coordinatorOnly: roles.length === 0,
        cards: [resolveRole(COORDINATOR_KEY, { model: squad.lead }, providerProfile), ...roles],
      };
    });
}

// Squad list counts. The rail shows "N roles + lead" so the number matches
// what the roster lists minus the coordinator — "N roles" alone read as if
// the roster should have N entries, but it also lists the lead (FOC-225
// review finding). Malformed squads degrade to honest zeros.
export function squadRoleCounts(squadModel) {
  const cards = Array.isArray(squadModel?.cards) ? squadModel.cards : [];
  const specialists = cards.filter((c) => c && c.key !== COORDINATOR_KEY).length;
  return {
    specialists,
    total: cards.length,
    coordinatorOnly: squadModel?.coordinatorOnly === true || (cards.length > 0 && specialists === 0),
  };
}
