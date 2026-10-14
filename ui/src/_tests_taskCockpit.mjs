// Unit tests for the task cockpit pure helpers (task workspaces, PRD §3–5).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_cockpit.mjs. Invoke via: `node src/_tests_taskCockpit.mjs`.
//
// Covers: sessionChip (the honest lifecycle vocabulary, PRD §4),
// sessionTitle, sessionErrorBanner (the lastError banner — never fabricated),
// resolveTaskSession (route taskKey → session, with the
// ambiguity guard — never silently pick), snapDataFor (the snapshot/session
// join — the blank-cockpit crash guard), switcherModel(ForPayload) (queued
// visible, cap passthrough), the scoped URL builders (conversation path,
// supervisor action path, terminal socket) and cockpitUrl. Fixtures only —
// no network, no DOM.

import assert from 'node:assert/strict';

import {
  sessionChip,
  sessionTitle,
  sessionErrorBanner,
  resolveTaskSession,
  snapDataFor,
  switcherModel,
  switcherModelForPayload,
  buildTaskSupervisorPath,
  buildTaskConversationPath,
  buildTaskTerminalSocketUrl,
  cockpitUrl,
} from './taskCockpitModel.js';

// --- Minimal test harness (same shape as _tests_cockpit.mjs) ----------------

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`√ ${name}`);
  } catch (err) {
    fail++;
    console.log(`× ${name} — ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
}

// --- sessionChip (lifecycle vocabulary, PRD §4) -----------------------------

await test('sessionChip running -> running/running', () => {
  eq(sessionChip({ status: 'running' }), { label: 'running', tone: 'running' });
});

await test('sessionChip starting -> starting/running', () => {
  eq(sessionChip({ status: 'starting' }), { label: 'starting', tone: 'running' });
});

await test('sessionChip needs-you -> "needs you"/waiting', () => {
  eq(sessionChip({ status: 'needs-you' }), { label: 'needs you', tone: 'waiting' });
});

await test('sessionChip waiting -> waiting/waiting', () => {
  eq(sessionChip({ status: 'waiting' }), { label: 'waiting', tone: 'waiting' });
});

await test('sessionChip queued -> queued/neutral (visible status, not an error, AC-3)', () => {
  eq(sessionChip({ status: 'queued' }), { label: 'queued', tone: 'neutral' });
});

await test('sessionChip failed -> failed/danger', () => {
  eq(sessionChip({ status: 'failed' }), { label: 'failed', tone: 'danger' });
});

await test('sessionChip completed -> completed/ok', () => {
  eq(sessionChip({ status: 'completed' }), { label: 'completed', tone: 'ok' });
});

await test('sessionChip stopped -> stopped/neutral', () => {
  eq(sessionChip({ status: 'stopped' }), { label: 'stopped', tone: 'neutral' });
});

await test('sessionChip unrecognized -> unknown/neutral (never running)', () => {
  eq(sessionChip({ status: 'flying' }), { label: 'unknown', tone: 'neutral' });
  eq(sessionChip(null), { label: 'unknown', tone: 'neutral' });
  eq(sessionChip({}), { label: 'unknown', tone: 'neutral' });
});

// --- sessionTitle ------------------------------------------------------------

await test('sessionTitle prefers the session title', () => {
  eq(sessionTitle({ title: 'Fix key rotation', taskKey: 'jointhubs:12' }), 'Fix key rotation');
});

await test('sessionTitle falls back to the taskKey (never an invented identifier)', () => {
  eq(sessionTitle({ taskKey: 'jointhubs:12' }), 'jointhubs:12');
  eq(sessionTitle({ title: '   ', taskKey: 'pisi:9' }), 'pisi:9');
});

await test('sessionTitle empty input -> ""', () => {
  eq(sessionTitle(null), '');
  eq(sessionTitle({}), '');
});

// --- resolveTaskSession --------------------------------------------------------

const PAYLOAD = {
  maxActive: 2,
  sessions: [
    {
      sessionId: 'sup-a1',
      taskKey: 'jointhubs:12',
      taskId: 'LA-12',
      workspace: 'jointhubs',
      issueId: '12',
      title: 'Fix key rotation',
      status: 'running',
      runId: 'run-1',
      pid: 100,
      processStartedAt: '2026-10-14T10:00:00Z',
      createdAt: '2026-10-14T09:59:00Z',
      updatedAt: '2026-10-14T10:01:00Z',
      lastError: null,
    },
    { sessionId: 'sup-b2', taskKey: 'pisi:7', title: 'Other task', status: 'queued' },
  ],
};

await test('resolveTaskSession finds the session by route taskKey', () => {
  const r = resolveTaskSession(PAYLOAD, 'jointhubs:12');
  eq(r.ready, true);
  eq(r.ambiguous, false);
  eq(r.session.sessionId, 'sup-a1');
  eq(r.session.runId, 'run-1');
});

await test('resolveTaskSession: no match -> null session, explicit ready', () => {
  const r = resolveTaskSession(PAYLOAD, 'jointhubs:999');
  eq(r.ready, true);
  eq(r.ambiguous, false);
  eq(r.session, null);
});

await test('resolveTaskSession: two matching taskKeys -> ambiguous (never silently pick)', () => {
  const dup = {
    sessions: [
      { sessionId: 'sup-1', taskKey: 'pisi:7' },
      { sessionId: 'sup-2', taskKey: 'pisi:7' },
    ],
  };
  const r = resolveTaskSession(dup, 'pisi:7');
  eq(r.ready, true);
  eq(r.ambiguous, true);
  eq(r.session, null);
});

await test('resolveTaskSession: absent payload -> not ready, no session', () => {
  eq(resolveTaskSession(null, 'pisi:7'), { session: null, ambiguous: false, ready: false });
  eq(resolveTaskSession({}, 'pisi:7'), { session: null, ambiguous: false, ready: true });
});

// --- switcherModel / switcherModelForPayload ---------------------------------

await test('switcherModel lists every session (queued visible), flags the current one', () => {
  const m = switcherModel(PAYLOAD.sessions, 'pisi:7');
  eq(m.items.length, 2);
  eq(m.items[0].current, false);
  eq(m.items[1].current, true);
  eq(m.items.map((i) => i.status), ['running', 'queued']);
  eq(m.items[1].chip, { label: 'queued', tone: 'neutral' });
  eq(m.items[0].title, 'Fix key rotation');
});

await test('switcherModel tolerates junk input', () => {
  eq(switcherModel(null, 'x'), { items: [], cap: null });
  eq(switcherModel([null], 'x').items.length, 1);
  eq(switcherModel([null], 'x').items[0].status, 'unknown');
});

await test('switcherModelForPayload passes maxActive through as cap', () => {
  eq(switcherModelForPayload(PAYLOAD, 'jointhubs:12').cap, 2);
  eq(switcherModelForPayload({ sessions: [] }, 'x').cap, null);
  eq(switcherModelForPayload(null, 'x'), { items: [], cap: null });
});

// --- buildTaskSupervisorPath ---------------------------------------------------

await test('buildTaskSupervisorPath builds the scoped route and encodes the id', () => {
  eq(buildTaskSupervisorPath('sup-a1', 'message'), '/api/supervisor/sessions/sup-a1/message');
  eq(buildTaskSupervisorPath('a/b', 'stop'), '/api/supervisor/sessions/a%2Fb/stop');
});

// --- buildTaskConversationPath --------------------------------------------------

await test('buildTaskConversationPath: after + limit + taskKey', () => {
  eq(
    buildTaskConversationPath('sup-a1', { after: 1024, limit: 200, taskKey: 'jointhubs:12' }),
    '/api/supervisor/sessions/sup-a1/conversation?after=1024&limit=200&taskKey=jointhubs%3A12',
  );
});

await test('buildTaskConversationPath: no options -> bare scoped path (tail mode)', () => {
  eq(buildTaskConversationPath('sup-a1'), '/api/supervisor/sessions/sup-a1/conversation');
  eq(
    buildTaskConversationPath('sup-a1', { limit: 200 }),
    '/api/supervisor/sessions/sup-a1/conversation?limit=200',
  );
});

// --- buildTaskTerminalSocketUrl ---------------------------------------------------

await test('buildTaskTerminalSocketUrl: same origin, cols/rows, taskKey query', () => {
  const loc = { protocol: 'http:', host: 'localhost:4600' };
  eq(
    buildTaskTerminalSocketUrl('', loc, { sessionId: 'sup-a1', taskKey: 'jointhubs:12' }, 80, 24),
    'ws://localhost:4600/api/supervisor/sessions/sup-a1/terminal?cols=80&rows=24&taskKey=jointhubs%3A12',
  );
});

await test('buildTaskTerminalSocketUrl: https location -> wss', () => {
  const loc = { protocol: 'https:', host: 'fenix.example' };
  eq(
    buildTaskTerminalSocketUrl('', loc, { sessionId: 'sup-a1' }, 80, 24),
    'wss://fenix.example/api/supervisor/sessions/sup-a1/terminal?cols=80&rows=24',
  );
});

await test('buildTaskTerminalSocketUrl: absolute base switches origin and keeps its path', () => {
  const loc = { protocol: 'https:', host: 'elsewhere' };
  eq(
    buildTaskTerminalSocketUrl(
      'http://127.0.0.1:7332/host',
      loc,
      { sessionId: 'sup-a1', taskKey: 'pisi:7' },
      100,
      30,
    ),
    'ws://127.0.0.1:7332/host/api/supervisor/sessions/sup-a1/terminal?cols=100&rows=30&taskKey=pisi%3A7',
  );
});

await test('buildTaskTerminalSocketUrl: no taskKey -> no taskKey query param', () => {
  const loc = { protocol: 'http:', host: 'localhost:4600' };
  const url = buildTaskTerminalSocketUrl('', loc, { sessionId: 'sup-a1' }, 80, 24);
  assert(!url.includes('taskKey'), 'url must not carry a taskKey: ' + url);
});

// --- cockpitUrl ---------------------------------------------------------------------

await test('cockpitUrl builds /work/:taskKey/cockpit with the key encoded', () => {
  eq(cockpitUrl('jointhubs:12'), '/work/jointhubs%3A12/cockpit');
});

await test('cockpitUrl attaches the prompt prefill (never auto-sent)', () => {
  eq(
    cockpitUrl('jointhubs:12', 'About LA-12: '),
    '/work/jointhubs%3A12/cockpit?prompt=About%20LA-12%3A%20',
  );
});

await test('cockpitUrl: blank prompt -> no query', () => {
  eq(cockpitUrl('pisi:7', '   '), '/work/pisi%3A7/cockpit');
  eq(cockpitUrl('pisi:7', null), '/work/pisi%3A7/cockpit');
});

await test('active generation wins over normal historical records', () => {
  const active = { sessionId: 'active', taskKey: 'pisi:7', status: 'waiting' };
  const old = { sessionId: 'old', taskKey: 'pisi:7', status: 'stopped', createdAt: '2026-01-01' };
  const newer = { sessionId: 'newer', taskKey: 'pisi:7', status: 'completed', createdAt: '2026-02-01' };
  eq(resolveTaskSession({ sessions: [old, active, newer] }, 'pisi:7').session, active);
  eq(resolveTaskSession({ sessions: [old, newer] }, 'pisi:7').session, newer);
  eq(resolveTaskSession({ sessions: [old, active] }, 'pisi:7', 'old').session, old);
  eq(resolveTaskSession({ sessions: [old, active] }, 'other:7', 'old').session, null);
  eq(switcherModel([old, active, newer], 'pisi:7').items.length, 1);
});

// --- snapDataFor (the blank-cockpit crash guard) --------------------------------

await test('snapDataFor: both sides absent -> null, never a throw', () => {
  eq(snapDataFor(null, null), null);
  eq(snapDataFor(undefined, undefined), null);
});

await test('snapDataFor: envelope without a session -> null', () => {
  eq(snapDataFor({ sessionId: 'sup-a', data: { counts: { running: 1 } } }, null), null);
});

await test('snapDataFor: session without an envelope -> null', () => {
  eq(snapDataFor(null, { sessionId: 'sup-a' }), null);
});

await test('snapDataFor: matching sessionId -> the body', () => {
  const body = { counts: { running: 1 }, supervisor: { model: 'm' } };
  eq(snapDataFor({ sessionId: 'sup-a', data: body }, { sessionId: 'sup-a' }), body);
});

await test('snapDataFor: envelope for another session -> null', () => {
  eq(snapDataFor({ sessionId: 'sup-a', data: { ok: 1 } }, { sessionId: 'sup-b' }), null);
});

await test('snapDataFor: envelope with no body -> null, not undefined', () => {
  eq(snapDataFor({ sessionId: 'sup-a' }, { sessionId: 'sup-a' }), null);
});

// --- sessionErrorBanner (the lastError banner — the gap behind "Terminal
// disconnected" looking like a dead terminal) --------------------------------

await test('sessionErrorBanner: no error anywhere -> null, never a fabricated banner', () => {
  eq(sessionErrorBanner(null), null);
  eq(sessionErrorBanner({}), null);
  eq(sessionErrorBanner({ lastError: null }), null);
  eq(sessionErrorBanner({ lastError: '   ' }), null);
  eq(sessionErrorBanner({ lastError: 42 }), null);
});

await test('sessionErrorBanner: the restart quarantine -> verbatim text + the stop/resume path', () => {
  const q = sessionErrorBanner({
    lastError: 'process identity unproven after restart; capacity reserved; use scoped stop',
  });
  eq(q.text, 'process identity unproven after restart; capacity reserved; use scoped stop');
  eq(q.hint, 'Stop this task, then Resume this history.');
});

await test('sessionErrorBanner: a delivery failure -> the deliver-manually path', () => {
  const d = sessionErrorBanner({
    lastError: 'initial delivery failed (502); prompt NOT resent — deliver manually',
  });
  eq(d.hint, 'Send the prompt again in Chat.');
});

await test('sessionErrorBanner: an unknown error -> text alone, no invented way out', () => {
  const u = sessionErrorBanner({ lastError: '  something nobody classified  ' });
  eq(u.text, 'something nobody classified');
  eq(u.hint, null);
});

// --- Summary ------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);