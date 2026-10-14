import { buildAnalysisQuery } from './screens/analysis/query.js';
import { buildTerminalSocketUrl } from './cockpitModel';
import { buildTaskSupervisorPath, buildTaskTerminalSocketUrl } from './taskCockpitModel';

const API_BASE = import.meta.env.VITE_API_BASE || '';

// Non-OK responses throw an Error carrying .status and — when the body is the
// server's { error, code } JSON — the body's error text as the message and
// .code for callers that switch on it (e.g. cache_building). Without a JSON
// body the message stays the legacy 'API <status>' so existing callers render
// the same as before.
async function apiFetch(path, signal) {
  const r = await fetch(API_BASE + path, { signal });
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    const err = new Error((data && data.error) || 'API ' + r.status);
    err.status = r.status;
    if (data && data.code) err.code = data.code;
    // The parsed body rides along (err.data) so callers can read fields beyond
    // `error`/`code` — e.g. the 409 notification from /api/supervisor/message.
    if (data) err.data = data;
    throw err;
  }
  return r.json();
}

// Shared POST helper for the Cockpit endpoints (FOC-783): parses the body even
// on failure so the thrown error carries .status and .data — the UI needs the
// 409 notification and the 400/503 reason verbatim.
async function postJson(path, payload, signal) {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Shared PUT helper (Settings, FOC-786) — same contract as postJson: the body
// is parsed even on failure so the thrown error carries .status and .data (the
// 400 check reason / 503 secrets-not-writable must reach the UI verbatim).
async function putJson(path, payload, signal) {
  const r = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Shared DELETE helper — no request body (the target is always in the path);
// the error contract matches putJson.
async function deleteJson(path, signal) {
  const r = await fetch(API_BASE + path, { method: 'DELETE', signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
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
// Throws with .status and the parsed body (err.data) attached — the 501
// launch-unsupported reason is shown verbatim in Tasks (FOC-804).
export async function postLaunch(payload) {
  const r = await fetch(API_BASE + '/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Host environment (FOC-804) — { inContainer, platform, launchSupported }
// (launchSupported = Windows and not in a container). An older server without
// the endpoint (404) is treated as launch-capable: v1 behavior.
export async function getEnvironment() {
  try {
    return await apiFetch('/api/environment');
  } catch (e) {
    if (e.status === 404) return { launchSupported: true };
    throw e;
  }
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

// Manager live overlay (FOC-225 slice 2) — bounded, cached, read-only view of
// run state across all squads. The ONLY telemetry source the /manager screen
// polls: it never calls /api/runs or /api/prompts/runs. Takes an AbortSignal
// so the poll hook can cancel in-flight requests.
export async function getManagerSnapshot(signal) {
  const r = await fetch(API_BASE + '/api/manager/snapshot', { signal });
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

// Manager rewards (FOC-225 slice 3) — server facts from the append-only
// reward ledger. GET only by design: XP is ingested from verdict evidence,
// there is deliberately NO submission endpoint (AC 2) and this client ships
// no XP submitter either.
export async function getManagerRewards(signal) {
  const r = await fetch(API_BASE + '/api/manager/rewards', { signal });
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

// Manager rating — the one POST in the rewards area: a subjective 1..5
// record on the append-only ledger. Returns parsed JSON even on 4xx so the
// UI can surface the server's error message verbatim.
export async function postManagerRating(payload) {
  const r = await fetch(API_BASE + '/api/manager/ratings', {
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

// ===== FT control plane (FOC-359) =====
export async function getFtDatasets() { return apiFetch('/api/ft/datasets'); }
export async function getFtRuns() { return apiFetch('/api/ft/runs'); }
export async function getFtRun(id) { return apiFetch('/api/ft/runs/' + encodeURIComponent(id)); }

export async function postFtTrain(payload) {
  const r = await fetch(API_BASE + '/api/ft/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data?.error || ('API ' + r.status)); err.data = data; throw err; }
  return data;
}

export async function postFtStop(id) {
  const r = await fetch(API_BASE + '/api/ft/runs/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data?.error || ('API ' + r.status)); err.data = data; throw err; }
  return data;
}

// ===== Analysis screen (FOC-397 analysis dashboard) =====
// Panel GETs are { filters, data, caveats }; errors are { error, code } with
// an HTTP status. The query string skips empty values (buildAnalysisQuery).

export function getAnalysisMeta() {
  return apiFetch('/api/analysis/meta');
}

export function getAnalysisPanel(name, filters = {}, signal) {
  return apiFetch('/api/analysis/' + encodeURIComponent(name) + buildAnalysisQuery(filters), signal);
}

// target: 'cache' (canonical views, fast — default) or 'store' (raw tables,
// read-only). Returns { columns, rows, rowCount, truncated, elapsedMs }.
export async function postAnalysisSql(sql, target = 'cache') {
  const r = await fetch(API_BASE + '/api/analysis/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, target }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    if (data?.code) err.code = data.code;
    throw err;
  }
  return data;
}

// Cache status: { exists, builtAt, buildMs, stale, building, watermark,
// current, lastBuild }.
export function getAnalysisCache() {
  return apiFetch('/api/analysis/cache');
}

// ===== Agent records (FOC-795) =====
// List / read / edit the files a Supervisor run wrote for a task. Same origin
// as the rest of the dashboard API.

export async function getRecords(taskId) {
  return apiFetch('/api/records?task=' + encodeURIComponent(taskId));
}

export async function getRecordFile(runId, path) {
  return apiFetch(
    '/api/records/file?run=' + encodeURIComponent(runId) + '&path=' + encodeURIComponent(path)
  );
}

// PUT /api/records/file — 200 { ok, sha256, seq } | 409 { conflict, sha256,
// content } | 4xx { error, reason }. Every body is parsed and carried on the
// thrown error: the UI needs the 409 content to offer "reload theirs" and the
// 4xx reason to show why the write was refused.
export async function putRecordFile(payload) {
  const r = await fetch(API_BASE + '/api/records/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// POST /api/records/annotate — verdicts only; 4xx carries { error, reason }.
export async function postRecordAnnotate(payload) {
  const r = await fetch(API_BASE + '/api/records/annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// 202 { started:true, startedAt } or 409 { code:'build_in_progress' } — the
// 409 reaches the caller as a thrown Error with .code so the UI can treat
// "already building" as a no-op rather than a failure.
export async function postAnalysisCacheRebuild() {
  const r = await fetch(API_BASE + '/api/analysis/cache/rebuild', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || ('API ' + r.status));
    err.status = r.status;
    if (data?.code) err.code = data.code;
    throw err;
  }
  return data;
}

// ===== Cockpit (FOC-783) + task scoping (task workspaces, PRD §3–5) ========
// One snapshot of the Supervisor session, the needs-you inbox and the live
// children. Poll every 5 s from the Cockpit, every 15 s from the nav badge.
// Errors are { error, ... } with an HTTP status — postJson keeps .status and
// the parsed body (err.data) so the UI can react to 409/400/503 specifically.
//
// Task scoping: every Supervisor endpoint takes an OPTIONAL trailing `scope`
// ({ sessionId, taskKey }). With a scope the call goes to the task-scoped
// route (/api/supervisor/sessions/:sid/…) with the taskKey carried along as
// routing context; without one the legacy global route is used unchanged, so
// old callers and tests behave exactly as before. There is deliberately no
// global mutable context — the scope always travels with the call.

// Task sessions — GET /api/supervisor/sessions → { sessions: [{ sessionId,
// taskKey, taskId, workspace, issueId, title, status, runId, pid,
// processStartedAt, createdAt, updatedAt, lastError }], maxActive }.
export async function getSupervisorSessions(signal) {
  return apiFetch('/api/supervisor/sessions', signal);
}

export async function getCockpit(signal, scope) {
  if (scope && scope.sessionId) {
    const q = new URLSearchParams();
    q.set('sessionId', scope.sessionId);
    if (scope.taskKey) q.set('taskKey', scope.taskKey);
    return apiFetch('/api/cockpit?' + q.toString(), signal);
  }
  return apiFetch('/api/cockpit', signal);
}

// Transcript read since a byte offset — { sessionId, state, offset, entries,
// reset, truncated }. Entries: { uuid, ts, role: user|assistant|tool,
// text?, tool?: { name, summary } }. Scoped ({ sessionId, taskKey } in opts)
// → /api/supervisor/sessions/:sid/conversation.
export async function getConversation({ after, limit, sessionId, taskKey } = {}, signal) {
  const q = new URLSearchParams();
  if (after != null) q.set('after', String(after));
  if (limit != null) q.set('limit', String(limit));
  let path = '/api/supervisor/conversation';
  if (sessionId) {
    path = buildTaskSupervisorPath(sessionId, 'conversation');
    if (taskKey) q.set('taskKey', taskKey);
  }
  const qs = q.toString();
  return apiFetch(path + (qs ? '?' + qs : ''), signal);
}

// 200 { sent, confirmed, queued } | 400 { error } | 409 { error, notification }
// | 503 { error }. err.data carries the body on failure. On success the body
// may carry `output` — the on-screen result of /context or /cost, shown in the
// chat as a command bubble. scope → POST /api/supervisor/sessions/:sid/message.
export function postSupervisorMessage(text, scope) {
  if (scope && scope.sessionId) {
    const body = { text };
    if (scope.taskKey) body.taskKey = scope.taskKey;
    return postJson(buildTaskSupervisorPath(scope.sessionId, 'message'), body);
  }
  return postJson('/api/supervisor/message', { text });
}

// Answer the Supervisor's pending AskUserQuestion (FOC-810): one entry per
// question, { choices: [optionIndex…], text? }. 200 { answered: true } |
// 409 { error: 'ask-changed' | 'dialog-changed', step? } | 503 { error } —
// same write guards and error shape as postSupervisorMessage.
export function postSupervisorAsk(body, scope) {
  if (scope && scope.sessionId) {
    return postJson(buildTaskSupervisorPath(scope.sessionId, 'ask'), {
      ...body,
      ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
    });
  }
  return postJson('/api/supervisor/ask', body);
}

// Answer a TUI permission/select dialog (FOC-810): choice
// 'allow-once' | 'allow-always' | 'deny' with an optional note (deny only).
// 200 { sent, closed } | 409 { error: 'dialog-changed' } | 503 { error }.
export function postSupervisorDialog(body, scope) {
  if (scope && scope.sessionId) {
    return postJson(buildTaskSupervisorPath(scope.sessionId, 'dialog'), {
      ...body,
      ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
    });
  }
  return postJson('/api/supervisor/dialog', body);
}

// Start (or restart fresh) the Supervisor session inside the container.
// scope → POST /api/supervisor/sessions/:sid/session (re)start-resume of that
// task's session only.
export function postSupervisorSession(scope) {
  if (scope && scope.sessionId) {
    return postJson(buildTaskSupervisorPath(scope.sessionId, 'session'), {
      fresh: true,
      confirm: 'new-session',
      ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
    });
  }
  return postJson('/api/supervisor/session', { fresh: true, confirm: 'new-session' });
}

// Same shape as message — drains the wake backlog with the standard prompt.
export function postSupervisorWake(scope) {
  if (scope && scope.sessionId) {
    return postJson(buildTaskSupervisorPath(scope.sessionId, 'wake'), {
      ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
    });
  }
  return postJson('/api/supervisor/wake', {});
}

// Stop ONE task's Supervisor session (scoped cancel, PRD §6 — stopping task A
// never touches task B). Only exists scoped: the legacy global route has no
// unscoped stop to preserve. History and run ids are kept — this stops the
// process, it does not delete anything.
export function postSupervisorStop(scope) {
  if (!scope || !scope.sessionId) {
    return Promise.reject(new Error('postSupervisorStop needs a sessionId scope'));
  }
  return postJson(buildTaskSupervisorPath(scope.sessionId, 'stop'), {
    ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
  });
}

// Record a gate answer (verbatim text, answered once) and tell the Supervisor.
// scope does NOT change the route (gates have no listed scoped verb) — the
// scoped identity rides the body so the API worker can check task + session.
export function postGateAnswer(body, scope) {
  return postJson('/api/gates/answer', scopedBody(body, scope));
}

// Record a hold answer (option label or free text) and tell the Supervisor.
export function postHoldAnswer(body, scope) {
  return postJson('/api/holds/answer', scopedBody(body, scope));
}

// Re-send the "[dashboard] … answered" notice for an answered-but-undelivered
// gate/hold.
export function postGateNotify(body, scope) {
  return postJson('/api/gates/notify', scopedBody(body, scope));
}

// scopedBody(body, scope) — merge the scoped identity { sessionId, taskKey }
// into a request body without altering the original. No scope → the body
// exactly as before (legacy callers).
function scopedBody(body, scope) {
  if (!(scope && scope.sessionId)) return body;
  return {
    ...(body || {}),
    sessionId: scope.sessionId,
    ...(scope.taskKey ? { taskKey: scope.taskKey } : {}),
  };
}

// ===== Work board (FOC-784) =====
// Board + ticket detail poll with an AbortSignal (usePoll cancels in-flight
// requests); filters ride the query (?milestone=&priority=) with empty values
// omitted so the URL stays clean. postStartTicket shares the Cockpit's POST
// guards — the thrown error carries .status and the parsed body (err.data) so
// the Start dialog can show the 400/503 reason verbatim.

export async function getWorkTickets(filters, signal) {
  const f = filters || {};
  const q = new URLSearchParams();
  if (f.milestone) q.set('milestone', f.milestone);
  if (f.priority) q.set('priority', f.priority);
  if (f.label) q.set('label', f.label);
  const qs = q.toString();
  return apiFetch('/api/work/tickets' + (qs ? '?' + qs : ''), signal);
}

export async function getWorkTicket(id, signal) {
  return apiFetch('/api/work/tickets/' + encodeURIComponent(id), signal);
}

export async function getStartPreview(id, signal) {
  return apiFetch('/api/work/tickets/' + encodeURIComponent(id) + '/start-preview', signal);
}

export function postStartTicket(id, text) {
  return postJson('/api/work/tickets/' + encodeURIComponent(id) + '/start', { text });
}

// Costs & quality (FOC-785) — the Costs screen imports these two by name.
export function getCosts(period, signal) {
  return apiFetch('/api/costs?period=' + encodeURIComponent(period ?? ''), signal);
}

export function getQuality(period, signal) {
  return apiFetch('/api/quality?period=' + encodeURIComponent(period ?? ''), signal);
}

// ===== Settings (FOC-786) =====
// Keys, provider & routing, repositories, retention. A key value travels only
// in the PUT body — never the URL, never a GET — and never comes back: the
// server answers with check results only, so err.data cannot carry one either.

export async function getSettingsKeys(signal) {
  return apiFetch('/api/settings/keys', signal);
}

// Checks the key already stored server-side (no value is sent).
export async function validateSettingsKey(name) {
  return postJson('/api/settings/keys/' + encodeURIComponent(name) + '/validate', {});
}

// `value` is dropped by the caller right after this promise settles (resolve
// or reject) — it lives in the uncontrolled input until then, nowhere else.
export function putSettingsKey(name, value, teamKey) {
  const body = { value };
  if (teamKey) body.teamKey = teamKey;
  return putJson('/api/settings/keys/' + encodeURIComponent(name), body);
}

export async function getSettingsProvider(signal) {
  return apiFetch('/api/settings/provider', signal);
}

// Body: { active, custom? } and optionally { key: { value } } — a key
// candidate the server validates against the NEW provider and saves under its
// key file before changing the overlay (the onboarding path; an empty field
// saves with the stored key). As with the keys PUT, the value travels only in
// this body — never the URL, never a GET, never a response.
export function putSettingsProvider(body) {
  return putJson('/api/settings/provider', body ?? {});
}

export function testSettingsProvider(body) {
  return postJson('/api/settings/provider/test', body ?? {});
}

export async function getSettingsRouting(signal) {
  return apiFetch('/api/settings/routing', signal);
}

// lead null = back to the models.json routing for the squad.
export function putSettingsRouting(squad, lead) {
  return putJson('/api/settings/routing', { squad, lead: lead || null });
}

export async function getSettingsRepos(signal) {
  return apiFetch('/api/settings/repos', signal);
}

export function addSettingsRepo(url, project) {
  const body = { url };
  if (project) body.project = project;
  return postJson('/api/settings/repos', body);
}

export function getRepoJob(id) {
  return apiFetch('/api/settings/repos/jobs/' + encodeURIComponent(id));
}

// Removes the Linear project mapping only — the cloned files stay.
export function unmapSettingsRepo(name) {
  return deleteJson('/api/settings/repos/' + encodeURIComponent(name) + '/mapping');
}

export async function getSettingsRetention(signal) {
  return apiFetch('/api/settings/retention', signal);
}

// Terminal WebSocket URL on the same origin (wss behind https). API_BASE as an
// absolute URL switches the origin and keeps its path prefix. The pure builders
// live in cockpitModel.js / taskCockpitModel.js so the node tests can pin them.
// With a scope ({ sessionId, taskKey }) the URL targets that task's session
// stream (/api/supervisor/sessions/:sid/terminal); without one, the legacy
// global socket — old callers unchanged.
export function terminalSocketUrl(cols, rows, scope) {
  if (scope && scope.sessionId) {
    return buildTaskTerminalSocketUrl(API_BASE, window.location, scope, cols, rows);
  }
  return buildTerminalSocketUrl(API_BASE, window.location, cols, rows);
}

export function getSupervisorProfilePreview(scope) { return apiFetch(buildTaskSupervisorPath(scope.sessionId,'profile-preview')); }
export function postSupervisorResume(scope, expectedRevision) { return postJson(buildTaskSupervisorPath(scope.sessionId,'resume'),{confirm:'resume-session',expectedRevision,taskKey:scope.taskKey}); }
