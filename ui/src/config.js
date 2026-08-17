// Cross-cutting UI configuration (ux-design-v3 §5).

// Linear workspace slugs. The two visible in this UI are "pisi" and
// "jointhubs" — overridable at build time via VITE_LINEAR_WORKSPACE_PISI
// / VITE_LINEAR_WORKSPACE_JOINTHUBS for forks that use different workspaces.
// Falls back to the project defaults so existing setups keep working.
const WORKSPACE_PISI = import.meta.env.VITE_LINEAR_WORKSPACE_PISI || 'pisi';
const WORKSPACE_JOINTHUBS = import.meta.env.VITE_LINEAR_WORKSPACE_JOINTHUBS || 'jointhubs';

// Linear issue URL prefix map. A task chip renders as an ↗ link when its
// prefix is known here, otherwise plain text.
export const LINEAR_PREFIXES = {
  PISI: `https://linear.app/${WORKSPACE_PISI}/issue/`,
  FEN: `https://linear.app/${WORKSPACE_JOINTHUBS}/issue/`,
  JOI: `https://linear.app/${WORKSPACE_JOINTHUBS}/issue/`,
  FOC: `https://linear.app/${WORKSPACE_JOINTHUBS}/issue/`,
};

// Resolve a Linear task ID (e.g. "PISI-98") to its issue URL, or null when
// the prefix is unknown / the id is malformed.
export function linearUrl(taskId) {
  if (!taskId || typeof taskId !== 'string') return null;
  const m = taskId.match(/^([A-Z]+)-(\d+)$/);
  if (!m) return null;
  const base = LINEAR_PREFIXES[m[1]];
  return base ? base + taskId : null;
}

// Linear workspaces the queue endpoint (JOI-68) accepts via ?workspace=.
// The picker on the Tasks screen (JOI-70) switches between them — each resolves
// to its own API key server-side (linear-client.chooseApiKey). The first entry
// is the default. See control-plane-plan §3.3 (workspace: FEN ▾).
export const WORKSPACES = [
  { id: WORKSPACE_JOINTHUBS, label: 'FEN' },
  { id: WORKSPACE_PISI, label: 'PISI' },
];
export const DEFAULT_WORKSPACE = WORKSPACES[0].id;
