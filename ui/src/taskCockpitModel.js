// Task cockpit pure helpers (task workspaces, PRD §3–5). No React, no env
// access — everything takes what it needs as arguments so the plain-node
// tests (_tests_taskCockpit.mjs) can pin the behavior outside Vite. The
// lifecycle status vocabulary is PRD §4: waiting / queued / running /
// needs-you / failed / completed (+ the store's starting / stopped).
//
// A taskKey is "workspace:issueId" — the stable workspace identifier plus the
// immutable Linear issue id (PRD §3). It is display-safe but travels through
// route paths and URLs, so every URL builder here encodes it.

// sessionChip(session) -> { label, tone } with tone in running|waiting|ok|
// danger|neutral. The label never relies on colour alone. Queued is its own
// visible status (AC-3: queued excess is shown, never dropped) — neutral tone,
// not an error and not "running".
export function sessionChip(session) {
  const s = session && session.status;
  switch (s) {
    case 'running':
      return { label: 'running', tone: 'running' };
    case 'starting':
      return { label: 'starting', tone: 'running' };
    case 'needs-you':
      return { label: 'needs you', tone: 'waiting' };
    case 'waiting':
      return { label: 'waiting', tone: 'waiting' };
    case 'queued':
      return { label: 'queued', tone: 'neutral' };
    case 'failed':
      return { label: 'failed', tone: 'danger' };
    case 'completed':
      return { label: 'completed', tone: 'ok' };
    case 'stopped':
      return { label: 'stopped', tone: 'neutral' };
    default:
      return { label: 'unknown', tone: 'neutral' };
  }
}

// sessionTitle(session) -> the display title: the session's own title, falling
// back to its taskKey, never an invented identifier.
export function sessionTitle(session) {
  if (!session) return '';
  const t = typeof session.title === 'string' ? session.title.trim() : '';
  return t || (typeof session.taskKey === 'string' ? session.taskKey : '');
}

// sessionErrorBanner(session) -> { text, hint } | null. The session's own
// lastError, verbatim — the host wrote it to be actionable ("use scoped stop",
// "deliver manually") and paraphrasing it would lose the instruction. A hint
// (the UI click-path) is added ONLY when the message names a recovery the UI
// can spell out; otherwise hint is null and the text stands alone — never
// invent a way out of a message we do not understand. null when there is no
// error: this never fabricates a banner (the blank-cockpit class of bug).
export function sessionErrorBanner(session) {
  const raw = session && session.lastError;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  const hint = /scoped stop|capacity reserved/i.test(text)
    ? 'Stop this task, then Resume this history.'
    : /deliver manually/i.test(text)
      ? 'Send the prompt again in Chat.'
      : null;
  return { text, hint };
}

// resolveTaskSession(payload, taskKey) -> { session, ambiguous, ready }.
// payload is the GET /api/supervisor/sessions body { sessions, maxActive }.
// ready:true once the payload arrived (lets the caller distinguish "still
// loading" from "no such session"). session is the one whose taskKey matches,
// null when none does. ambiguous:true when more than one matches — the UI
// must show an explicit ambiguity screen, never silently pick (PRD §3).
export function resolveTaskSession(payload, taskKey, selectedSessionId = null) {
  const ready = !!payload; // a truthy payload means the list endpoint answered
  const sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  const matches = sessions.filter(
    (s) => s && typeof s.taskKey === 'string' && s.taskKey === taskKey,
  );
  if (selectedSessionId) {
    return { session: matches.find(s => s.sessionId === selectedSessionId) || null, ambiguous: false, ready };
  }
  const owners = matches.filter(s => !['completed', 'stopped', 'failed'].includes(s.status));
  if (owners.length > 1) return { session: null, ambiguous: true, ready };
  const history = [...matches].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.sessionId).localeCompare(String(a.sessionId)));
  return { session: owners[0] || history[0] || null, ambiguous: false, ready };
}

// snapDataFor(envelope, session) -> the scoped cockpit body, only when the
// envelope belongs to the session on screen. Both sides are absent on first
// paint (both polls start empty) and the envelope is absent while no session
// is resolved — comparing two absent sessionIds as equal would dereference a
// null envelope and unmount the whole screen (the blank-task-cockpit crash).
// Never returns undefined; an envelope without a body yields null.
export function snapDataFor(envelope, session) {
  if (!envelope || !session) return null;
  return envelope.sessionId === session.sessionId ? envelope.data ?? null : null;
}

// switcherModel(sessions, currentTaskKey) -> { items, cap }. items is every
// session (queued included — visible status, AC-3) shaped for the Tasks
// switcher: { taskKey, sessionId, title, status, chip, current }. current is
// true for the route's own task. cap mirrors the payload's maxActive so the
// UI can say "cap 2" without guessing a default.
export function switcherModel(sessions, currentTaskKey) {
  const all = Array.isArray(sessions) ? sessions : [];
  const keys = [...new Set(all.map(s => s?.taskKey))];
  const list = keys.map(key => key ? resolveTaskSession({ sessions: all }, key).session : null);
  const items = list.map((s) => ({
    taskKey: (s && s.taskKey) || null,
    sessionId: (s && s.sessionId) || null,
    title: sessionTitle(s),
    status: (s && s.status) || 'unknown',
    chip: sessionChip(s),
    current: !!currentTaskKey && s && s.taskKey === currentTaskKey,
  }));
  return { items, cap: null };
}

// switcherModelForPayload(payload, currentTaskKey) — the same, reading the
// sessions payload shape ({ sessions, maxActive }) so the screen passes the
// poll result straight through.
export function switcherModelForPayload(payload, currentTaskKey) {
  const m = switcherModel(payload && payload.sessions, currentTaskKey);
  const cap =
    payload && typeof payload.maxActive === 'number' && Number.isFinite(payload.maxActive)
      ? payload.maxActive
      : null;
  return { ...m, cap };
}

// ===== Scoped URL builders ==================================================

// buildTaskSupervisorPath(sessionId, action) -> "/api/supervisor/sessions/:sid/<action>".
// action is one of the scoped POST verbs (message | ask | dialog | session |
// wake | stop | conversation GET). sessionId is opaque and server-validated;
// it is still encoded here so a malformed value can never change the path.
export function buildTaskSupervisorPath(sessionId, action) {
  return (
    '/api/supervisor/sessions/' +
    encodeURIComponent(String(sessionId)) +
    '/' +
    encodeURIComponent(String(action))
  );
}

// buildTaskConversationPath(sessionId, { after, limit, taskKey }) -> the
// scoped transcript GET path with its query (after/limit as the legacy one,
// taskKey as the routing context the API worker checks).
export function buildTaskConversationPath(sessionId, { after, limit, taskKey } = {}) {
  const q = new URLSearchParams();
  if (after != null) q.set('after', String(after));
  if (limit != null) q.set('limit', String(limit));
  if (taskKey) q.set('taskKey', taskKey);
  const qs = q.toString();
  return buildTaskSupervisorPath(sessionId, 'conversation') + (qs ? '?' + qs : '');
}

// buildTaskTerminalSocketUrl(base, loc, { sessionId, taskKey }, cols, rows) —
// the scoped terminal WebSocket URL. Same origin rules as the legacy
// buildTerminalSocketUrl (cockpitModel.js): base '' = same origin, an absolute
// URL switches origin and keeps its path, a relative prefix is appended.
// The taskKey rides the query as routing context.
export function buildTaskTerminalSocketUrl(base, loc, scope, cols, rows) {
  const sessionId = scope && scope.sessionId;
  const taskKey = scope && scope.taskKey;
  const abs = /^https?:\/\//i.test(base) ? new URL(base) : null;
  const wsProto = abs
    ? abs.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
    : loc && loc.protocol === 'https:'
      ? 'wss:'
      : 'ws:';
  const host = abs ? abs.host : loc ? loc.host : '';
  const prefix = abs ? abs.pathname.replace(/\/+$/, '') : (base || '').replace(/\/+$/, '');
  let url =
    wsProto +
    '//' +
    host +
    prefix +
    buildTaskSupervisorPath(sessionId, 'terminal') +
    '?cols=' +
    cols +
    '&rows=' +
    rows;
  if (taskKey) url += '&taskKey=' + encodeURIComponent(taskKey);
  return url;
}

// ===== Route helpers ========================================================

// cockpitUrl(taskKey, prompt) -> "/work/:taskKey/cockpit" with an optional
// ?prompt= prefill. The taskKey is encoded for the path (it carries ':');
// react-router decodes the param, so the screen sees the raw key again.
export function cockpitUrl(taskKey, prompt) {
  let url = '/work/' + encodeURIComponent(taskKey) + '/cockpit';
  if (prompt && String(prompt).trim()) {
    url += '?prompt=' + encodeURIComponent(String(prompt));
  }
  return url;
}