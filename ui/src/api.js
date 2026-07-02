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
