const API_BASE = import.meta.env.VITE_API_BASE || '';

async function apiFetch(path) {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

export async function getRuns() {
  return apiFetch('/api/runs');
}

export async function getRun(id) {
  return apiFetch('/api/runs/' + id);
}

export async function getSummary() {
  return apiFetch('/api/summary');
}

export async function getBudget() {
  return apiFetch('/api/budget');
}

// JOI-210: quality signal per delegation — REVIEW's own verdicts joined back onto
// the DEV roles that produced the code. Lives next to cost so the two read
// together: a cheap role that keeps coming back from review is not cheap.
export async function getDelegationOutcomes() {
  return apiFetch('/api/delegation-outcomes');
}

// L1a (JOI-68): Linear task queue enriched with `suggestedSquad` per
// handoff-rules.json. `workspace` selects the Linear key server-side
// (?workspace=jointhubs|pisi). Returns {workspace, tasks[], error, fetchedAt}.
export async function getLinearQueue(workspace) {
  return apiFetch('/api/linear/queue?workspace=' + encodeURIComponent(workspace));
}

// L1b (JOI-69): spawn a local agent window for a squad+task. The server is
// 127.0.0.1 + Origin-checked (§5); a browser at localhost:5173 passes. dryRun
// returns the kickoff prompt + wrapper .bat preview without spawning. A real
// launch (dryRun:false) opens a new console window running bin/<squad>.bat.
export async function postLaunch(payload) {
  const r = await fetch(API_BASE + '/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || ('API ' + r.status));
  return data;
}

// Flow screen — interactive Overview. getFlow() returns squad -> agent(step)
// aggregation across all runs; getFlowLog() returns the full turn log (model
// responses) for one step in one run.
export async function getFlow() {
  return apiFetch('/api/flow');
}

export async function getFlowLog(runId, agent, opts = {}) {
  let url =
    '/api/flow/log?runId=' + encodeURIComponent(runId) + '&agent=' + encodeURIComponent(agent);
  if (opts.includeUser) url += '&includeUser=1';
  if (opts.full) url += '&full=1';
  return apiFetch(url);
}

// Prompts screen — decision tree for launching squads/roles.
export async function getPrompts() {
  return apiFetch('/api/prompts');
}

export async function getPromptRole(squad, role) {
  return apiFetch(
    '/api/prompts/role?squad=' + encodeURIComponent(squad) + '&role=' + encodeURIComponent(role)
  );
}

export async function getPromptLead(squad) {
  return apiFetch('/api/prompts/lead?squad=' + encodeURIComponent(squad));
}

// Context tracing — which files a prompt pulls in (docs/ui/prompt-context-tracing.md).
export async function getPromptRefs(squad, role = null) {
  let url = '/api/prompts/refs?squad=' + encodeURIComponent(squad);
  if (role) url += '&role=' + encodeURIComponent(role);
  return apiFetch(url);
}

export async function getPromptFile(path) {
  return apiFetch('/api/prompts/file?path=' + encodeURIComponent(path));
}

// External prompts (orchestrators + Hermes) — files outside the repo, reached
// via @rootId/rel paths. docs/ui/prompt-editing-external.md §4.
export async function getPromptRoots() {
  return apiFetch('/api/prompts/roots');
}

// Write one prompt document. dryRun validates the guards without touching disk.
export async function postPromptFile({ path, body, dryRun = false }) {
  const r = await fetch(API_BASE + '/api/prompts/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, body, dryRun }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export async function getPromptRuns(squad, limit = 10) {
  return apiFetch(
    '/api/prompts/runs?squad=' + encodeURIComponent(squad) + '&limit=' + encodeURIComponent(limit)
  );
}

// Squad config — read current squad model assignments + pricing table.
export async function getSquadConfig() {
  return apiFetch('/api/squad-config');
}

// Squad config — preview (dryRun:true) or apply (dryRun:false) changes.
// Returns parsed JSON even on 4xx so the UI can surface error details.
export async function postSquadConfig(payload) {
  const r = await fetch(API_BASE + '/api/squad-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.data = data;
    throw err;
  }
  return data;
}

// Terminals — list live + recently finished agent windows.
export async function getTerminals() {
  return apiFetch('/api/terminals');
}

// Focus a terminal window (bring to foreground). Returns {ok:true} or 409.
export async function focusTerminal(runId) {
  const r = await fetch(API_BASE + '/api/terminals/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.data = data;
    throw err;
  }
  return data;
}

// Stop a terminal (kill the agent process). Returns {ok:true} or 409.
export async function stopTerminal(runId) {
  const r = await fetch(API_BASE + '/api/terminals/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.data = data;
    throw err;
  }
  return data;
}

// Tools catalog — returns {tools, riskLevels} for the tool editor modal.
export async function getTools() {
  return apiFetch('/api/tools');
}

// Run task assignment — read current + history.
export async function getRunTask(runId) {
  return apiFetch('/api/runs/task?runId=' + encodeURIComponent(runId));
}

// Run task assignment — set or clear (taskId: null = untag).
// Returns parsed JSON even on 4xx so the UI can surface error details.
export async function postRunTask(payload) {
  const r = await fetch(API_BASE + '/api/runs/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.data = data;
    throw err;
  }
  return data;
}

// Kickoff prompt editor — preview (dryRun:true) or save (dryRun:false).
// Returns parsed JSON even on 4xx so the UI can surface error details.
export async function postKickoff(payload) {
  const r = await fetch(API_BASE + '/api/prompts/kickoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.data = data;
    throw err;
  }
  return data;
}
