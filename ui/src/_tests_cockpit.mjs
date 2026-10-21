// Unit tests for the Cockpit pure helpers (FOC-783).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_test_utils.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: statusChip (honest status vocabulary, spec §5), formatAge,
// mergeConversation (append by uuid, reset, 1000-entry cap),
// conversation paging (tail-mode first request, burst follow, per-tick cap),
// inboxPrimaryAction (the per-item primary action), chatDisabledReason,
// terminalDisabledReason, buildTerminalSocketUrl, cockpitPrefill (the
// Start-in-Cockpit ?prompt= parsing, FOC-804), wakeBanner (the wake-backlog
// banner, FOC-807) and the Supervisor ask/dialog helpers (dialogActions,
// dialogTextLines, askAnswers, the card-aware chatDisabledReason and
// inboxPrimaryAction,
// FOC-810), the inbox list shapers (inboxQuestionLines / inboxFactLines —
// the generic lists render strings only; the ask category never leaks its
// question objects into a <li>, React error #31). Fixtures only — no network,
// no DOM.

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
  inboxQuestionLines,
  inboxFactLines,
  chatDisabledReason,
  terminalDisabledReason,
  buildTerminalSocketUrl,
  cockpitPrefill,
  wakeBanner,
  focusChip,
  dialogActions,
  dialogTextLines,
  askAnswers,
  answerResultText,
  childCostLabel,
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

// --- childCostLabel (FOC-980: never a fabricated "$0.00 est.") ---------------

await test('childCostLabel running child without costSource -> pending, muted, turn-end title', () => {
  eq(childCostLabel({ status: 'running', costUsd: null, costSource: null }), {
    text: 'pending', chip: null, muted: true, title: 'cost is recorded at turn end',
  });
  // Even a stale costUsd is not shown for a turn that has not ended.
  eq(childCostLabel({ status: 'running', costUsd: 0.42, costSource: null }).text, 'pending');
});

await test('childCostLabel live statuses (starting/stalled/waiting-gate) without costSource -> pending', () => {
  for (const status of ['starting', 'running', 'stalled', 'waiting-gate']) {
    eq(childCostLabel({ status, costUsd: null, costSource: null }).text, 'pending', status);
  }
});

await test('childCostLabel ended child without costUsd -> unknown, muted, cost-source title', () => {
  eq(childCostLabel({ status: 'exited', costUsd: null, costSource: null }), {
    text: 'unknown', chip: null, muted: true, title: 'no readable cost source',
  });
  eq(childCostLabel({ status: 'stopped', costUsd: null, costSource: 'transcript' }).text, 'unknown');
  // A crashed/unknown-status child must not read as running either.
  eq(childCostLabel({ status: 'unknown', costUsd: null, costSource: null }).text, 'unknown');
});

await test('childCostLabel with a cost -> the current $x.xx est. cell', () => {
  eq(childCostLabel({ status: 'running', costUsd: 1.5, costSource: 'transcript' }), {
    text: '$1.50', chip: 'est.', muted: false, title: null,
  });
  // An ended child with a cost but no recorded source keeps the estimate.
  eq(childCostLabel({ status: 'exited', costUsd: 0, costSource: null }).text, '$0.00');
});

await test('childCostLabel(null) -> unknown (never $0.00)', () => {
  eq(childCostLabel(null), { text: 'unknown', chip: null, muted: true, title: 'no readable cost source' });
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

// --- focusChip (FOC-769 supervisor focus) ------------------------------------

await test('focusChip(null) and no taskId/kind -> null (nothing rendered)', () => {
  eq(focusChip(null), null);
  eq(focusChip(undefined), null);
  eq(focusChip({}), null);
  eq(focusChip({ declared: false }), null);
});

await test('focusChip heuristic ticket -> taskId label, inferred tooltip', () => {
  eq(focusChip({ taskId: 'FOC-123', runId: 'run-1', declared: false }), {
    label: 'FOC-123',
    title: 'inferred from triage',
  });
});

await test('focusChip declared ticket -> declared tooltip', () => {
  eq(focusChip({ taskId: 'FOC-9', kind: 'ticket', declared: true, source: 'spawn' }), {
    label: 'FOC-9',
    title: 'declared by the Supervisor',
  });
});

await test('focusChip overhead -> the word Overhead despite the null taskId', () => {
  eq(focusChip({ kind: 'overhead', taskId: null, declared: true, source: 'manual' }), {
    label: 'Overhead',
    title: 'declared by the Supervisor',
  });
  eq(focusChip({ kind: 'overhead', taskId: null, declared: false }), {
    label: 'Overhead',
    title: 'inferred from triage',
  });
});

// --- dialogActions (FOC-810 supervisor dialogs) ------------------------------

const permissionDialog = (overrides = {}) => ({
  id: 'dlg-1',
  kind: 'permission',
  title: 'Bash command',
  lines: ['The Supervisor wants to run a command'],
  command: 'npm audit --json',
  question: null,
  tabs: null,
  options: [
    { key: '1', label: 'Yes', description: null, focused: true, checked: null, choice: 'allow-once' },
    {
      key: '2',
      label: "Yes, and don't ask again for: npm audit *",
      description: null,
      focused: false,
      checked: null,
      choice: 'allow-always',
    },
    { key: '3', label: 'Yes, and switch to auto mode', description: null, focused: false, checked: null, choice: 'auto-mode' },
    { key: '4', label: 'No', description: null, focused: false, checked: null, choice: 'deny' },
  ],
  footer: 'Esc to cancel',
  ...overrides,
});

await test('dialogActions permission -> allow-once, allow-always (pattern from the label), deny; auto-mode never', () => {
  eq(dialogActions(permissionDialog()), [
    { choice: 'allow-once', label: 'Allow once' },
    { choice: 'allow-always', label: 'Always allow: npm audit *' },
    { choice: 'deny', label: 'Deny' },
  ]);
});

await test('dialogActions permission without allow-once/allow-always options -> deny only', () => {
  eq(dialogActions(permissionDialog({ options: [permissionDialog().options[3]] })), [
    { choice: 'deny', label: 'Deny' },
  ]);
});

await test('dialogActions allow-always without "for:" in the label falls back to the label', () => {
  const d = permissionDialog({
    options: [
      { key: '1', label: 'Yes', description: null, focused: true, checked: null, choice: 'allow-once' },
      { key: '2', label: "Yes, and don't ask again", description: null, focused: false, checked: null, choice: 'allow-always' },
    ],
  });
  eq(dialogActions(d)[1], { choice: 'allow-always', label: "Always allow: Yes, and don't ask again" });
});

await test('dialogActions select -> only Dismiss (Esc)', () => {
  eq(dialogActions({ id: 'dlg-2', kind: 'select', title: 'Pick one', options: [{ key: '1', label: 'A', choice: null }] }), [
    { choice: 'deny', label: 'Dismiss (Esc)' },
  ]);
});

await test('dialogActions(null) and unknown kind -> only Dismiss (Esc)', () => {
  eq(dialogActions(null), [{ choice: 'deny', label: 'Dismiss (Esc)' }]);
  eq(dialogActions({ kind: 'ask' }), [{ choice: 'deny', label: 'Dismiss (Esc)' }]);
});

// --- dialogTextLines (FOC-810 DialogCard body lines) --------------------------

// Shaped like parseDialog over scripts/fixtures/session-dialogs/permission-bash.txt
// (title "Bash command", command "npm audit --json", the four options, footer).
const bashCommandDialog = {
  id: 'abc123def45',
  kind: 'permission',
  title: 'Bash command',
  lines: [
    'Bash command',
    'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    'Audit dependencies',
    'npm audit --json',
    'This command requires approval',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '2. Yes, and don’t ask again for: npm audit *',
    '3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '4. No',
    'Esc to cancel · Tab to amend',
  ],
  command: 'npm audit --json',
  question: null,
  tabs: null,
  options: [
    { key: '1', label: 'Yes', description: null, focused: true, checked: null, choice: 'allow-once' },
    { key: '2', label: 'Yes, and don’t ask again for: npm audit *', description: null, focused: false, checked: null, choice: 'allow-always' },
    { key: '3', label: 'Yes, and switch to auto mode · auto mode handles these prompts for you', description: null, focused: false, checked: null, choice: 'auto-mode' },
    { key: '4', label: 'No', description: null, focused: false, checked: null, choice: 'deny' },
  ],
  footer: 'Esc to cancel · Tab to amend',
};

await test('dialogTextLines permission-bash-shaped dialog -> exactly the kept lines', () => {
  eq(dialogTextLines(bashCommandDialog), [
    'Audit dependencies',
    'This command requires approval',
    'Do you want to proceed?',
  ]);
});

await test('dialogTextLines drops numbered option lines with or without the focus marker', () => {
  eq(
    dialogTextLines({
      title: null,
      footer: null,
      command: null,
      options: [{ key: '1', label: 'Yes' }],
      lines: ['❯ 1. Yes', '2. No', 'keep me'],
    }),
    ['keep me'],
  );
});

await test('dialogTextLines drops unnumbered select options (label equality, ❯ optional)', () => {
  eq(
    dialogTextLines({
      kind: 'select',
      title: 'Pick one',
      footer: 'Esc to cancel',
      command: null,
      options: [
        { key: null, label: 'Option A', description: null, focused: true, checked: null, choice: null },
        { key: null, label: 'Option B', description: null, focused: false, checked: null, choice: null },
      ],
      lines: ['Pick one', '❯ Option A', 'Option B', 'Esc to cancel'],
    }),
    [],
  );
});

await test('dialogTextLines drops any line mentioning auto mode', () => {
  eq(
    dialogTextLines({
      title: null,
      footer: null,
      command: null,
      options: [],
      lines: ['Tip: auto mode handles these prompts for you', 'AUTO MODE is suggested', 'keep me'],
    }),
    ['keep me'],
  );
});

await test('dialogTextLines drops a multi-line command line by line', () => {
  eq(
    dialogTextLines({
      title: 'Bash command',
      footer: null,
      options: [],
      command: 'head -1 file\ntail -1 file',
      lines: ['Bash command', 'head -1 file', 'tail -1 file', 'Do you want to proceed?'],
    }),
    ['Do you want to proceed?'],
  );
});

await test('dialogTextLines keeps the rest in capture order', () => {
  eq(
    dialogTextLines({
      title: 'Bash command',
      footer: 'Esc to cancel',
      command: 'npm audit --json',
      options: bashCommandDialog.options,
      lines: [
        'Esc to cancel',
        'Audit dependencies',
        'Bash command',
        'npm audit --json',
        'This command requires approval',
        'Do you want to proceed?',
      ],
    }),
    ['Audit dependencies', 'This command requires approval', 'Do you want to proceed?'],
  );
});

await test('dialogTextLines null / no lines / blank lines -> []', () => {
  eq(dialogTextLines(null), []);
  eq(dialogTextLines(undefined), []);
  eq(dialogTextLines({}), []);
  eq(dialogTextLines({ lines: ['', '   '] }), []);
});

// --- askAnswers (FOC-810 pending ask) -----------------------------------------

const ask2 = {
  toolUseId: 'tu_1',
  questions: [
    { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Tests' }, { label: 'Docs' }] },
  ],
};

await test('askAnswers single question answered with one choice -> ok', () => {
  const r = askAnswers(ask2, { 0: { choices: [1], text: '' }, 1: { choices: [0], text: '' } });
  eq(r.ok, true);
  eq(r.answers, [{ choices: [1] }, { choices: [0] }]);
});

await test('askAnswers single question answered with text -> ok, text wins over a picked choice', () => {
  eq(askAnswers(ask2, { 0: { choices: [0], text: ' MariaDB ' }, 1: { choices: [1], text: '' } }).answers[0], {
    choices: [],
    text: 'MariaDB',
  });
  eq(askAnswers(ask2, { 0: { choices: [], text: 'MariaDB' }, 1: { choices: [0], text: '' } }).ok, true);
});

await test('askAnswers single question with nothing -> not ok with a reason', () => {
  const r = askAnswers(ask2, { 0: { choices: [], text: '' } });
  eq(r.ok, false);
  eq(typeof r.reason, 'string');
});

await test('askAnswers single question with two choices -> not ok (exactly one)', () => {
  eq(askAnswers(ask2, { 0: { choices: [0, 1], text: '' } }).ok, false);
});

await test('askAnswers multiSelect with choices -> ok, no text field', () => {
  const r = askAnswers(ask2, { 0: { choices: [0], text: '' }, 1: { choices: [0, 1], text: '' } });
  eq(r.ok, true);
  eq(r.answers, [{ choices: [0] }, { choices: [0, 1] }]);
});

await test('askAnswers multiSelect empty -> not ok, and text alone does not save it', () => {
  eq(askAnswers(ask2, { 0: { choices: [0], text: '' }, 1: { choices: [], text: 'nope' } }).ok, false);
  eq(askAnswers(ask2, { 0: { choices: [0], text: '' }, 1: { choices: [], text: '' } }).ok, false);
});

await test('askAnswers(null) / empty selection -> not ok', () => {
  eq(askAnswers(null, {}).ok, false);
  eq(askAnswers(ask2, {}).ok, false);
});

// --- answerResultText (FOC-810 honest success banners) -------------------------

await test('answerResultText clean success -> "Answer sent."', () => {
  eq(answerResultText({ answered: true }), 'Answer sent.');
  eq(answerResultText({ sent: true, closed: true }), 'Answer sent.');
  eq(answerResultText(null), 'Answer sent.');
  eq(answerResultText(undefined), 'Answer sent.');
});

await test('answerResultText answered/closed false -> the dialog is still on screen', () => {
  eq(answerResultText({ answered: false }), 'The dialog is still on screen — check the Terminal.');
  eq(answerResultText({ sent: true, closed: false }), 'The dialog is still on screen — check the Terminal.');
});

await test('answerResultText resumedFrom -> the already-applied sentence (singular and plural)', () => {
  eq(answerResultText({ answered: true, resumedFrom: 1 }), 'Sent — the first 1 answer was already applied.');
  eq(answerResultText({ answered: true, resumedFrom: 2 }), 'Sent — the first 2 answers were already applied.');
  // resumedFrom 0 is no resume at all.
  eq(answerResultText({ answered: true, resumedFrom: 0 }), 'Answer sent.');
});

// --- chatDisabledReason with the card (FOC-810) --------------------------------

await test('chatDisabledReason pendingAsk -> answer the question above the chat', () => {
  eq(
    chatDisabledReason({ host: 'reachable', state: 'needs-input', pendingAsk: { toolUseId: 'tu_1', questions: [] } }),
    'The Supervisor is asking you — answer the question above the chat.',
  );
});

await test('chatDisabledReason dialog -> answer it in the card above the chat', () => {
  eq(
    chatDisabledReason({ host: 'reachable', state: 'needs-input', dialog: { id: 'd', kind: 'permission' } }),
    'The Supervisor is waiting on a dialog — answer it in the card above the chat.',
  );
});

await test('chatDisabledReason plain needs-input (no dialog/ask in the snapshot) -> the Terminal hint', () => {
  eq(chatDisabledReason({ host: 'reachable', state: 'needs-input' }), 'The Supervisor is asking for input — answer it in the Terminal.');
});

await test('chatDisabledReason host problems still come first, pendingAsk or not', () => {
  eq(
    chatDisabledReason({ host: 'unreachable', state: 'needs-input', pendingAsk: { toolUseId: 't', questions: [] } }),
    'The Supervisor host is not reachable.',
  );
});

// --- inboxPrimaryAction ask/dialog (FOC-810) -----------------------------------

await test('inboxPrimaryAction answerKind ask -> ask-card / Answer the question', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: 'ask', answerable: true, category: 'ask' }), {
    kind: 'ask-card',
    label: 'Answer the question',
  });
});

await test('inboxPrimaryAction answerKind dialog -> dialog-card / Answer the dialog', () => {
  eq(inboxPrimaryAction({ state: 'pending', answerKind: 'dialog', answerable: true, category: 'dialog' }), {
    kind: 'dialog-card',
    label: 'Answer the dialog',
  });
});

// --- inboxQuestionLines / inboxFactLines (the blank-Cockpit crash, React #31)

const askItem = {
  id: 'ask:tu_1',
  category: 'ask',
  answerKind: 'ask',
  questions: [
    { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }] },
    { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Tests' }] },
  ],
};

await test('inboxQuestionLines ask item -> [] (AskCard renders the question objects)', () => {
  eq(inboxQuestionLines(askItem), []);
  eq(inboxQuestionLines({ category: 'ask', questions: ['plain'] }), []);
});

await test('inboxQuestionLines gate item with string questions -> same strings', () => {
  eq(inboxQuestionLines({ category: 'gate', questions: ['Proceed with the migration?', 'Which branch?'] }), [
    'Proceed with the migration?',
    'Which branch?',
  ]);
});

await test('inboxQuestionLines mixed strings/objects -> strings only (object contributes its question field)', () => {
  eq(
    inboxQuestionLines({
      category: 'gate',
      questions: ['plain string', { question: 'from the object', header: 'H' }, { header: 'no question field' }, 42, null],
    }),
    ['plain string', 'from the object'],
  );
});

await test('inboxQuestionLines missing/empty questions -> []', () => {
  eq(inboxQuestionLines({ category: 'gate' }), []);
  eq(inboxQuestionLines({ category: 'gate', questions: [] }), []);
  eq(inboxQuestionLines(null), []);
});

await test('inboxFactLines object map -> "key: value" strings (primitive values only)', () => {
  eq(
    inboxFactLines({ facts: { branch: 'main', commits: 3, clean: true, nested: { a: 1 }, list: [1], nothing: null } }),
    ['branch: main', 'commits: 3', 'clean: true'],
  );
});

await test('inboxFactLines array facts -> entries as strings, object entries skipped', () => {
  eq(inboxFactLines({ facts: ['branch=main', 'clean=yes'] }), ['branch=main', 'clean=yes']);
  eq(inboxFactLines({ facts: ['keep', { note: 'skipped' }] }), ['keep']);
});

await test('inboxFactLines missing facts / other shapes -> []', () => {
  eq(inboxFactLines({}), []);
  eq(inboxFactLines({ facts: 'not-a-list' }), []);
  eq(inboxFactLines({ facts: 42 }), []);
  eq(inboxFactLines(null), []);
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
