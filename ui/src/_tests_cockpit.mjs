// Unit tests for the Cockpit pure helpers (FOC-783).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_test_utils.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: statusChip (honest status vocabulary, spec §5), formatAge,
// mergeConversation (append by uuid, reset, 1000-entry cap),
// conversation paging (tail-mode first request, burst follow, per-tick cap),
// inboxPrimaryAction (the per-item primary action), chatDisabledReason,
// terminalDisabledReason, buildTerminalSocketUrl, cockpitPrefill (the
// Start-in-Cockpit ?prompt= parsing, FOC-804) and wakeBanner (the wake-backlog
// banner, FOC-807). Fixtures only — no network, no DOM.

import assert from 'node:assert/strict';

import {
  statusChip,
  formatAge,
  mergeConversation,
  buildConversationQuery,
  shouldFollowBurst,
  CONVERSATION_LIMIT,
  CONVERSATION_MAX_PAGES_PER_TICK,
  inboxPrimaryAction,
  chatDisabledReason,
  terminalDisabledReason,
  buildTerminalSocketUrl,
  cockpitPrefill,
  wakeBanner,
} from './cockpitModel.js';

// --- Minimal test harness (same shape as _test_utils.mjs) -------------------

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

// --- statusChip -------------------------------------------------------------

await test('statusChip running -> running/running', () => {
  eq(statusChip({ status: 'running' }), { label: 'running', tone: 'running' });
});

await test('statusChip waiting-gate -> "waiting · gate"/waiting', () => {
  eq(statusChip({ status: 'waiting-gate' }), { label: 'waiting · gate', tone: 'waiting' });
});

await test('statusChip stalled -> stalled/waiting', () => {
  eq(statusChip({ status: 'stalled' }), { label: 'stalled', tone: 'waiting' });
});

await test('statusChip exited 0 -> "exited 0"/ok', () => {
  eq(statusChip({ status: 'exited', exitCode: 0 }), { label: 'exited 0', tone: 'ok' });
});

await test('statusChip exited 1 -> "exited 1"/danger', () => {
  eq(statusChip({ status: 'exited', exitCode: 1 }), { label: 'exited 1', tone: 'danger' });
});

await test('statusChip exited without exitCode -> "exited ?"/danger', () => {
  eq(statusChip({ status: 'exited' }), { label: 'exited ?', tone: 'danger' });
});

await test('statusChip stopped -> stopped/neutral', () => {
  eq(statusChip({ status: 'stopped' }), { label: 'stopped', tone: 'neutral' });
});

await test('statusChip unknown -> unknown/neutral', () => {
  eq(statusChip({ status: 'unknown' }), { label: 'unknown', tone: 'neutral' });
});

await test('statusChip unrecognized status -> unknown/neutral (never running)', () => {
  eq(statusChip({ status: 'whatever' }), { label: 'unknown', tone: 'neutral' });
});

await test('statusChip(null) -> unknown/neutral', () => {
  eq(statusChip(null), { label: 'unknown', tone: 'neutral' });
});

// --- formatAge --------------------------------------------------------------

await test('formatAge(0) -> "0s"', () => {
  eq(formatAge(0), '0s');
});

await test('formatAge(42000) -> "42s"', () => {
  eq(formatAge(42000), '42s');
});

await test('formatAge(65_000) -> "1m 05s" (zero-padded seconds)', () => {
  eq(formatAge(65000), '1m 05s');
});

await test('formatAge(3_670_000) -> "1h 01m"', () => {
  eq(formatAge(3670000), '1h 01m');
});

await test('formatAge(5d 3h) -> "5d 03h"', () => {
  eq(formatAge(5 * 86400_000 + 3 * 3600_000), '5d 03h');
});

await test('formatAge(-1) -> "—" (negative is not an age)', () => {
  eq(formatAge(-1), '—');
});

await test('formatAge(NaN) -> "—"', () => {
  eq(formatAge(NaN), '—');
});

await test('formatAge(null) -> "—"', () => {
  eq(formatAge(null), '—');
});

await test('formatAge("42") -> "—" (non-number rejected)', () => {
  eq(formatAge('42'), '—');
});

// --- mergeConversation ------------------------------------------------------

const e = (uuid, text) => ({ uuid, role: 'assistant', text });

await test('mergeConversation appends new entries in page order', () => {
  const out = mergeConversation([e(1, 'a')], { entries: [e(2, 'b'), e(3, 'c')] }, {});
  eq(out.map((x) => x.uuid), [1, 2, 3]);
});

await test('mergeConversation dedupes by uuid, first position wins', () => {
  const out = mergeConversation(
    [e(1, 'a'), e(2, 'b')],
    { entries: [e(2, 'b-changed'), e(3, 'c')] },
    {},
  );
  eq(out.map((x) => x.uuid), [1, 2, 3]);
  eq(out[1].text, 'b'); // the already-shown copy is kept
});

await test('mergeConversation reset replaces everything', () => {
  const out = mergeConversation([e(1, 'old')], { entries: [e(9, 'new')] }, { reset: true });
  eq(out.map((x) => x.uuid), [9]);
});

await test('mergeConversation caps at 1000 keeping the newest', () => {
  const prev = Array.from({ length: 1000 }, (_, i) => e(i + 1, 'p'));
  const page = { entries: [e(1001, 'n'), e(1002, 'n')] };
  const out = mergeConversation(prev, page, {});
  eq(out.length, 1000);
  eq(out[0].uuid, 3); // oldest two dropped
  eq(out[999].uuid, 1002);
});

await test('mergeConversation(null, page) works on first load', () => {
  const out = mergeConversation(null, { entries: [e(1, 'a')] }, {});
  eq(out.map((x) => x.uuid), [1]);
});

await test('mergeConversation skips entries without a uuid', () => {
  const out = mergeConversation([{ role: 'assistant', text: 'unkeyed' }], {
    entries: [e(1, 'a')],
  }, {});
  eq(out.map((x) => x.uuid), [1]);
});

await test('mergeConversation page without entries -> prev unchanged', () => {
  const prev = [e(1, 'a')];
  eq(mergeConversation(prev, {}, {}), prev);
});

// --- conversation paging (chat tail-mode contract) ---------------------------

const fullPage = (n = 200) => ({ entries: Array.from({ length: n }, (_, i) => e(i, 'x')), offset: 9 });

await test('CONVERSATION_LIMIT is the server default page size', () => {
  eq(CONVERSATION_LIMIT, 200);
  eq(CONVERSATION_MAX_PAGES_PER_TICK, 5);
});

await test('buildConversationQuery first load -> tail mode (no after)', () => {
  eq(buildConversationQuery({ started: false, offset: 0, limit: 200 }), { limit: 200 });
});

await test('buildConversationQuery after the first page -> forward from the offset', () => {
  eq(buildConversationQuery({ started: true, offset: 12345, limit: 200 }), {
    limit: 200,
    after: 12345,
  });
});

await test('buildConversationQuery defaults limit to CONVERSATION_LIMIT', () => {
  eq(buildConversationQuery({ started: false, offset: 7 }), { limit: 200 });
});

await test('shouldFollowBurst tail-mode page -> false (tail is at the end)', () => {
  eq(shouldFollowBurst(fullPage(), { forward: false, limit: 200, pagesFetched: 1 }), false);
});

await test('shouldFollowBurst forward page that came back full -> true (a burst)', () => {
  eq(shouldFollowBurst(fullPage(), { forward: true, limit: 200, pagesFetched: 1 }), true);
});

await test('shouldFollowBurst forward page short of the limit -> false', () => {
  eq(shouldFollowBurst(fullPage(199), { forward: true, limit: 200, pagesFetched: 1 }), false);
});

await test('shouldFollowBurst stops after 5 pages per tick', () => {
  eq(shouldFollowBurst(fullPage(), { forward: true, limit: 200, pagesFetched: 4 }), true);
  eq(shouldFollowBurst(fullPage(), { forward: true, limit: 200, pagesFetched: 5 }), false);
});

await test('shouldFollowBurst page without entries -> false', () => {
  eq(shouldFollowBurst({}, { forward: true, limit: 200, pagesFetched: 1 }), false);
  eq(shouldFollowBurst(null, { forward: true, limit: 200, pagesFetched: 1 }), false);
});

// --- inboxPrimaryAction -----------------------------------------------------

await test('inboxPrimaryAction awaiting-delivery -> notify (delivery first)', () => {
  eq(inboxPrimaryAction({ state: 'awaiting-delivery', answerKind: 'text' }), {
    kind: 'notify',
    label: 'Tell the Supervisor',
  });
});

await test('inboxPrimaryAction answerKind text -> text/Answer', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: 'text', answerable: true }), {
    kind: 'text',
    label: 'Answer',
  });
});

await test('inboxPrimaryAction answerKind yesno -> yesno/Approve / Reject', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: 'yesno', answerable: true }), {
    kind: 'yesno',
    label: 'Approve / Reject',
  });
});

await test('inboxPrimaryAction answerKind option -> option/Choose an option', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: 'option', answerable: true }), {
    kind: 'option',
    label: 'Choose an option',
  });
});

await test('inboxPrimaryAction answerKind null + answerable -> ask', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: null, answerable: true, category: 'problem' }), {
    kind: 'ask',
    label: 'Ask the Supervisor',
  });
});

await test('inboxPrimaryAction not answerable -> none', () => {
  eq(inboxPrimaryAction({ state: 'unreadable', answerKind: null, answerable: false }), {
    kind: 'none',
    label: '',
  });
});

await test('inboxPrimaryAction(null) -> none', () => {
  eq(inboxPrimaryAction(null), { kind: 'none', label: '' });
});

// --- chatDisabledReason -----------------------------------------------------

await test('chatDisabledReason not-docker -> the Docker sentence', () => {
  eq(chatDisabledReason({ host: 'not-docker', state: 'idle' }), 'Chat and Terminal run in Docker (fenix up).');
});

await test('chatDisabledReason unreachable -> the host sentence', () => {
  eq(chatDisabledReason({ host: 'unreachable', state: 'idle' }), 'The Supervisor host is not reachable.');
});

await test('chatDisabledReason needs-input -> the Terminal sentence', () => {
  eq(chatDisabledReason({ host: 'reachable', state: 'needs-input' }), 'The Supervisor is asking for input — answer it in the Terminal.');
});

await test('chatDisabledReason reachable+idle -> null', () => {
  eq(chatDisabledReason({ host: 'reachable', state: 'idle' }), null);
});

await test('chatDisabledReason(null) -> null (chat attempts fail on their own)', () => {
  eq(chatDisabledReason(null), null);
});

// --- terminalDisabledReason --------------------------------------------------

await test('terminalDisabledReason not-docker -> the Docker sentence', () => {
  eq(terminalDisabledReason({ host: 'not-docker', state: 'idle' }), 'Chat and Terminal run in Docker (fenix up).');
});

await test('terminalDisabledReason unreachable -> the host sentence', () => {
  eq(terminalDisabledReason({ host: 'unreachable', state: 'busy' }), 'The Supervisor host is not reachable.');
});

await test('terminalDisabledReason needs-input -> null (the terminal answers the dialog)', () => {
  eq(terminalDisabledReason({ host: 'reachable', state: 'needs-input' }), null);
});

await test('terminalDisabledReason idle/busy/absent/unknown -> null', () => {
  eq(terminalDisabledReason({ host: 'reachable', state: 'idle' }), null);
  eq(terminalDisabledReason({ host: 'reachable', state: 'busy' }), null);
  eq(terminalDisabledReason({ host: 'reachable', state: 'absent' }), null);
  eq(terminalDisabledReason({ host: 'reachable', state: 'unknown' }), null);
});

await test('terminalDisabledReason(null) -> null (host starts the session on connect)', () => {
  eq(terminalDisabledReason(null), null);
});

// --- buildTerminalSocketUrl -------------------------------------------------

const LOC_HTTP = { protocol: 'http:', host: 'localhost:5173' };
const LOC_HTTPS = { protocol: 'https:', host: 'fenix.example' };

await test('buildTerminalSocketUrl same-origin http -> ws + query', () => {
  eq(buildTerminalSocketUrl('', LOC_HTTP, 120, 40), 'ws://localhost:5173/api/supervisor/terminal?cols=120&rows=40');
});

await test('buildTerminalSocketUrl same-origin https -> wss', () => {
  eq(buildTerminalSocketUrl('', LOC_HTTPS, 80, 24), 'wss://fenix.example/api/supervisor/terminal?cols=80&rows=24');
});

await test('buildTerminalSocketUrl absolute http base switches origin', () => {
  eq(
    buildTerminalSocketUrl('http://localhost:7331', LOC_HTTP, 120, 40),
    'ws://localhost:7331/api/supervisor/terminal?cols=120&rows=40',
  );
});

await test('buildTerminalSocketUrl absolute https base -> wss, keeps path prefix', () => {
  eq(
    buildTerminalSocketUrl('https://host/api-base/', LOC_HTTP, 120, 40),
    'wss://host/api-base/api/supervisor/terminal?cols=120&rows=40',
  );
});

await test('buildTerminalSocketUrl relative base is prefixed', () => {
  eq(
    buildTerminalSocketUrl('/dashboard', LOC_HTTP, 120, 40),
    'ws://localhost:5173/dashboard/api/supervisor/terminal?cols=120&rows=40',
  );
});

// --- cockpitPrefill (FOC-804 start-in-Cockpit) --------------------------------

await test('cockpitPrefill decodes the prompt param verbatim', () => {
  eq(
    cockpitPrefill('?prompt=Start%20ticket%20FOC-123%3A%20Fix%20the%20widget'),
    'Start ticket FOC-123: Fix the widget',
  );
});

await test('cockpitPrefill keeps a multi-word prompt intact (a + is a space)', () => {
  eq(cockpitPrefill('?prompt=Start+ticket+FOC-1'), 'Start ticket FOC-1');
});

await test('cockpitPrefill no prompt param -> null', () => {
  eq(cockpitPrefill(''), null);
  eq(cockpitPrefill('?other=1'), null);
});

await test('cockpitPrefill empty or whitespace-only prompt -> null', () => {
  eq(cockpitPrefill('?prompt='), null);
  eq(cockpitPrefill('?prompt=%20%20'), null);
});

await test('cockpitPrefill ignores other params around the prompt', () => {
  eq(cockpitPrefill('?a=1&prompt=hello&b=2'), 'hello');
});

await test('cockpitPrefill null/undefined search -> null', () => {
  eq(cockpitPrefill(null), null);
  eq(cockpitPrefill(undefined), null);
});

// --- wakeBanner (FOC-807 wake-backlog banner) --------------------------------

await test('wakeBanner(null) and missing backlog -> null', () => {
  eq(wakeBanner(null), null);
  eq(wakeBanner(undefined), null);
  eq(wakeBanner({ host: 'reachable', state: 'idle' }), null);
  eq(wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 0 }), null);
});

await test('wakeBanner 1 event -> singular text without since', () => {
  const w = wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1 });
  eq(w.count, 1);
  eq(w.since, null);
  eq(w.sinceLabel, null);
  eq(w.text, '1 event waiting for the Supervisor');
});

await test('wakeBanner 3 events -> plural text, count mirrored', () => {
  const w = wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 3 });
  eq(w.count, 3);
  eq(w.text, '3 events waiting for the Supervisor');
});

await test('wakeBanner since -> local HH:MM in sinceLabel and text', () => {
  const d = new Date(2026, 9, 12, 9, 7); // local wall clock 09:07
  const w = wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 2, wakeOldestAt: d.toISOString() });
  const expected = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  eq(w.since, d.toISOString());
  eq(w.sinceLabel, expected);
  eq(w.text, '2 events waiting for the Supervisor since ' + expected);
});

await test('wakeBanner invalid since -> sinceLabel null, no " since" in text', () => {
  const w = wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 2, wakeOldestAt: 'not-a-date' });
  eq(w.since, 'not-a-date');
  eq(w.sinceLabel, null);
  eq(w.text.includes(' since'), false);
  eq(w.text, '2 events waiting for the Supervisor');
});

await test('wakeBanner waker alive -> wakerAlive true + on-duty detail', () => {
  const w = wakeBanner({
    host: 'reachable',
    state: 'busy',
    wakeBacklog: 2,
    waker: { state: 'alive', heartbeatAt: '2026-10-12T10:00:00Z' },
  });
  eq(w.waker, 'alive');
  eq(w.wakerAlive, true);
  eq(w.detail, 'Waker on duty — it delivers them when the current turn ends.');
});

await test('wakeBanner waker missing/null -> waker absent', () => {
  eq(wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1 }).waker, 'absent');
  eq(wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1, waker: null }).waker, 'absent');
  eq(wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1, waker: {} }).waker, 'absent');
});

await test('wakeBanner canWake false for busy, needs-input, unreachable host, not-docker host, unknown state and missing host', () => {
  eq(wakeBanner({ host: 'reachable', state: 'busy', wakeBacklog: 1 }).canWake, false);
  eq(wakeBanner({ host: 'reachable', state: 'needs-input', wakeBacklog: 1 }).canWake, false);
  eq(wakeBanner({ host: 'unreachable', state: 'idle', wakeBacklog: 1 }).canWake, false);
  // Native host: POST /api/supervisor/wake answers 503 docker-only there.
  eq(wakeBanner({ host: 'not-docker', state: 'idle', wakeBacklog: 1 }).canWake, false);
  eq(wakeBanner({ host: 'not-docker', state: 'idle', wakeBacklog: 1, waker: { state: 'stale' } }).detail, 'Waker not running.');
  // Unknown states must not offer Wake.
  eq(wakeBanner({ host: 'reachable', state: 'unknown', wakeBacklog: 1 }).canWake, false);
  eq(wakeBanner({ state: 'idle', wakeBacklog: 1 }).canWake, false);
});

await test('wakeBanner canWake true for idle, ended, absent and null state', () => {
  eq(wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1 }).canWake, true);
  eq(wakeBanner({ host: 'reachable', state: 'ended', wakeBacklog: 1 }).canWake, true);
  eq(wakeBanner({ host: 'reachable', state: 'absent', wakeBacklog: 1 }).canWake, true);
  eq(wakeBanner({ host: 'reachable', state: null, wakeBacklog: 1 }).canWake, true);
});

await test('wakeBanner waker not alive + canWake -> press-Wake detail', () => {
  eq(
    wakeBanner({ host: 'reachable', state: 'idle', wakeBacklog: 1, waker: { state: 'stale' } }).detail,
    'Waker not running — press Wake to deliver them.',
  );
});

await test('wakeBanner waker not alive + cannot wake -> bare detail', () => {
  eq(
    wakeBanner({ host: 'unreachable', state: 'idle', wakeBacklog: 1, waker: { state: 'ended' } }).detail,
    'Waker not running.',
  );
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
