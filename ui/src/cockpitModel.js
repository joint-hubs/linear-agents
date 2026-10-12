// Cockpit pure helpers (FOC-783). No React, no env access — everything takes
// what it needs as arguments so the plain-node tests (_tests_cockpit.mjs) can
// pin the behavior outside Vite. Status vocabulary: dashboard-v2-spec §5;
// colours live in screens/cockpit.css as the --ck-* tokens.

// statusChip(child) -> { label, tone } with tone in running|waiting|ok|danger|
// neutral. The label never relies on colour alone (spec §7 accessibility).
export function statusChip(child) {
  const s = child && child.status;
  switch (s) {
    case 'running':
      return { label: 'running', tone: 'running' };
    case 'waiting-gate':
      return { label: 'waiting · gate', tone: 'waiting' };
    case 'stalled':
      return { label: 'stalled', tone: 'waiting' };
    case 'exited': {
      const ec = child && child.exitCode;
      return {
        label: 'exited ' + (typeof ec === 'number' ? ec : '?'),
        tone: ec === 0 ? 'ok' : 'danger',
      };
    }
    case 'stopped':
      return { label: 'stopped', tone: 'neutral' };
    default:
      // 'unknown' and anything unrecognised — shown as unknown, never as
      // running (spec §5).
      return { label: 'unknown', tone: 'neutral' };
  }
}

// formatAge(ms) -> "42s" | "3m 05s" | "2h 07m" | "5d 03h" | "—" when not a
// finite non-negative number. Minute/second and hour/minute pairs are zero
// padded so column values line up.
export function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return d + 'd ' + String(h).padStart(2, '0') + 'h';
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m > 0) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

// mergeConversation(prevEntries, page, { reset }) -> merged entries.
// page.entries are appended by uuid (first occurrence wins — the transcript is
// append-only, a re-read page may overlap the previous one); reset replaces
// everything (new session); the result is capped to the newest 1000 entries.
export function mergeConversation(prevEntries, page, { reset } = {}) {
  const prev = reset ? [] : prevEntries || [];
  const pageEntries = (page && page.entries) || [];
  const byUuid = new Map();
  const order = [];
  for (const e of prev) {
    const key = e && e.uuid;
    if (key == null) continue; // defensive: never merge unkeyed entries
    if (!byUuid.has(key)) {
      byUuid.set(key, e);
      order.push(key);
    }
  }
  for (const e of pageEntries) {
    const key = e && e.uuid;
    if (key == null) continue;
    if (!byUuid.has(key)) {
      byUuid.set(key, e);
      order.push(key);
    }
  }
  const CAP = 1000;
  return (order.length > CAP ? order.slice(order.length - CAP) : order).map((k) => byUuid.get(k));
}

// inboxPrimaryAction(item) -> { kind, label }. kind drives which control the
// inbox item renders: text (textarea + Answer), yesno (Approve/Reject),
// option (one button per option), ask ("Ask the Supervisor" → chat prefill),
// notify ("Tell the Supervisor" — answered but not delivered), none.
export function inboxPrimaryAction(item) {
  if (!item) return { kind: 'none', label: '' };
  if (item.state === 'awaiting-delivery') return { kind: 'notify', label: 'Tell the Supervisor' };
  switch (item.answerKind) {
    case 'text':
      return { kind: 'text', label: 'Answer' };
    case 'yesno':
      return { kind: 'yesno', label: 'Approve / Reject' };
    case 'option':
      return { kind: 'option', label: 'Choose an option' };
    // Supervisor interactivity (FOC-810): an AskUserQuestion (answerKind ask)
    // and a TUI dialog (answerKind dialog) are answered in place with their
    // own card — distinct kinds so the read-only "ask the Supervisor" path
    // below keeps its meaning.
    case 'ask':
      return { kind: 'ask-card', label: 'Answer the question' };
    case 'dialog':
      return { kind: 'dialog-card', label: 'Answer the dialog' };
    default:
      // answerKind null: a problem is read-only — the human asks the
      // Supervisor about it; anything else answerable falls back to ask too.
      return item.answerable ? { kind: 'ask', label: 'Ask the Supervisor' } : { kind: 'none', label: '' };
  }
}

// inboxQuestionLines(item) -> the generic questions list as plain strings for
// the inbox <li> render. A category "ask" item (a pending AskUserQuestion)
// carries question objects ({ question, header, multiSelect, options }) that
// AskCard renders — the generic list shows nothing for it (a bare object child
// is React error #31, the blank-Cockpit crash). Elsewhere a string passes
// through as is; an object contributes its `question` field when that is a
// string; anything else is skipped.
export function inboxQuestionLines(item) {
  if (!item || item.category === 'ask') return [];
  return textLines(item && item.questions, 'question');
}

// inboxFactLines(item) -> the generic facts list as plain strings. Gate facts
// (collectNeedsYou only forwards non-array objects) are an object map —
// rendered as "key: value" lines for primitive values, objects and arrays
// skipped; an array of facts keeps the entry-as-string rule (an object entry
// has no meaningful field to extract, so it is skipped). Anything else is no
// list at all.
export function inboxFactLines(item) {
  const facts = item ? item.facts : null;
  if (Array.isArray(facts)) return textLines(facts, null);
  if (facts && typeof facts === 'object') {
    const lines = [];
    for (const [key, value] of Object.entries(facts)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        lines.push(key + ': ' + value);
      }
    }
    return lines;
  }
  return [];
}

// textLines(entries, objectField) -> the entries as renderable strings: a
// string passes through as is; an object contributes entries[objectField] when
// objectField is set and that field is a string; anything else is skipped.
function textLines(entries, objectField) {
  if (!Array.isArray(entries)) return [];
  const lines = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      lines.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && objectField) {
      const field = entry[objectField];
      if (typeof field === 'string') lines.push(field);
    }
  }
  return lines;
}

// hostDisabledReason(supervisor) -> the sentence for a host-level blocker
// (natively on Windows, host down), or null. Shared by chat and terminal.
function hostDisabledReason(supervisor) {
  if (supervisor.host === 'not-docker') {
    return 'Chat and Terminal run in Docker (fenix up).';
  }
  if (supervisor.host === 'unreachable') {
    return 'The Supervisor host is not reachable.';
  }
  return null;
}

// chatDisabledReason(supervisor) -> null when chat may send, otherwise the
// sentence explaining why (host problem, or an open dialog — keystrokes must
// never answer a permission prompt, plan §1). With a pendingAsk or a dialog in
// the snapshot the card above the chat answers it; a bare needs-input state
// (the snapshot could not parse what is on screen) still points at Terminal.
export function chatDisabledReason(supervisor) {
  if (!supervisor) return null;
  return (
    hostDisabledReason(supervisor) ||
    (supervisor.pendingAsk
      ? 'The Supervisor is asking you — answer the question above the chat.'
      : supervisor.dialog
        ? 'The Supervisor is waiting on a dialog — answer it in the card above the chat.'
        : supervisor.state === 'needs-input'
          ? 'The Supervisor is asking for input — answer it in the Terminal.'
          : null)
  );
}

// terminalDisabledReason(supervisor) -> null when the Terminal tab may open,
// otherwise the sentence explaining why. Only host problems block it: a
// needs-input dialog is answered in the terminal, and an absent session is
// started by the host on connect.
export function terminalDisabledReason(supervisor) {
  if (!supervisor) return null;
  return hostDisabledReason(supervisor);
}

// ===== Conversation paging (FOC-783 chat view) =====

// The transcript can be tens of MB, so the first request is TAIL mode: no
// `after` — the server returns the LAST `limit` entries plus the end offset
// (truncated:true when older history exists). Every later request pages
// forward from that offset. The helpers keep that contract pure so the node
// tests can pin it.

// Entries requested per transcript page (matches the server default).
export const CONVERSATION_LIMIT = 200;

// buildConversationQuery({ started, offset, limit }) -> { limit, after? }.
// `after` is present only once the first page has arrived (started) — omitting
// it selects tail mode.
export function buildConversationQuery({ started, offset, limit = CONVERSATION_LIMIT }) {
  const q = { limit };
  if (started) q.after = offset;
  return q;
}

// A burst (a forward page that came back full) is followed immediately instead
// of waiting for the next 2 s tick — but one tick can never fetch forever.
export const CONVERSATION_MAX_PAGES_PER_TICK = 5;

// shouldFollowBurst(page, { forward, limit, pagesFetched }) -> fetch the next
// page right now? Only a forward page that came back with `limit` entries is
// followed; a tail page is by definition at the end of the transcript.
export function shouldFollowBurst(page, { forward, limit, pagesFetched }) {
  if (!forward) return false;
  if (pagesFetched >= CONVERSATION_MAX_PAGES_PER_TICK) return false;
  const n = page && Array.isArray(page.entries) ? page.entries.length : 0;
  return n >= limit;
}

// buildTerminalSocketUrl(base, loc, cols, rows) — pure so the tests can pass a
// fake location. base is the API base ('' = same origin, an absolute URL
// switches origin and keeps its path, a relative prefix is appended).
export function buildTerminalSocketUrl(base, loc, cols, rows) {
  const abs = /^https?:\/\//i.test(base) ? new URL(base) : null;
  const wsProto = abs
    ? abs.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
    : loc && loc.protocol === 'https:'
      ? 'wss:'
      : 'ws:';
  const host = abs ? abs.host : loc ? loc.host : '';
  const prefix = abs
    ? abs.pathname.replace(/\/+$/, '')
    : (base || '').replace(/\/+$/, '');
  return (
    wsProto + '//' + host + prefix + '/api/supervisor/terminal?cols=' + cols + '&rows=' + rows
  );
}

// ===== Start-in-Cockpit prefill (FOC-804) =====

// cockpitPrefill(search) -> the text of the `prompt` query parameter, or null.
// Tasks hands a ticket over with /?prompt=Start ticket FOC-…: <title>; the
// Cockpit puts that text into the chat composer draft — it never sends it, the
// human still presses Send. Takes the raw location.search string so the plain
// node tests can pin the parsing; an absent, empty or whitespace-only prompt
// is no prefill at all.
export function cockpitPrefill(search) {
  if (!search) return null;
  const text = new URLSearchParams(search).get('prompt');
  return text && text.trim() ? text : null;
}

// ===== Wake backlog banner (FOC-807) =====

// wakeBanner(sup) -> null when there is nothing to report (no supervisor, or
// wakeBacklog is not > 0), otherwise { count, since, sinceLabel, waker,
// wakerAlive, canWake, text, detail } for the Supervisor panel banner.
// `since` is the raw wakeOldestAt (oldest undelivered event, may be null);
// sinceLabel is its local HH:MM or null when absent/invalid. waker mirrors
// sup.waker?.state ('absent' when the waker block is missing); canWake follows
// the wake endpoint's own rules — POST /api/supervisor/wake only works through
// the Docker session host (natively, host: 'not-docker', it answers 503
// docker-only), and unknown states must not offer Wake: so only host
// 'reachable' with state idle/ended/absent/null may be woken (waking an ended
// session starts a new one). detail tells the human who delivers the
// backlog: the waker when it is alive, otherwise the Wake button.
export function wakeBanner(sup) {
  if (!sup || !(sup.wakeBacklog > 0)) return null;
  const count = sup.wakeBacklog;
  const since = sup.wakeOldestAt ?? null;
  const sinceDate = since ? new Date(since) : null;
  const sinceLabel =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? String(sinceDate.getHours()).padStart(2, '0') + ':' + String(sinceDate.getMinutes()).padStart(2, '0')
      : null;
  const waker = (sup.waker && sup.waker.state) || 'absent';
  const wakerAlive = waker === 'alive';
  const canWake =
    sup.host === 'reachable' && ['idle', 'ended', 'absent', null].includes(sup.state ?? null);
  const text =
    count + ' event' + (count === 1 ? '' : 's') + ' waiting for the Supervisor' + (sinceLabel ? ' since ' + sinceLabel : '');
  const detail = wakerAlive
    ? 'Waker on duty — it delivers them when the current turn ends.'
    : canWake
      ? 'Waker not running — press Wake to deliver them.'
      : 'Waker not running.';
  return { count, since, sinceLabel, waker, wakerAlive, canWake, text, detail };
}

// ===== Supervisor dialogs and asks (FOC-810) =====

// dialogActions(dialog) -> [{ choice, label }] — the buttons DialogCard
// renders. A permission dialog offers Allow once / Always allow / Deny, but
// only the choices an option on screen actually carries (deny is always
// present — Esc works even when the list changed under us); an auto-mode
// option is NEVER pressed from the dashboard (that is a deliberate policy
// switch, plan FOC-810). "Always allow" is titled with the pattern after
// "for:" in the option's label, falling back to the whole label. Any other
// kind (select lists, anything unrecognised) only dismisses with Esc.
export function dialogActions(dialog) {
  if (!dialog || dialog.kind !== 'permission') {
    return [{ choice: 'deny', label: 'Dismiss (Esc)' }];
  }
  const options = Array.isArray(dialog.options) ? dialog.options : [];
  const actions = [];
  const allowOnce = options.find((o) => o && o.choice === 'allow-once');
  if (allowOnce) actions.push({ choice: 'allow-once', label: 'Allow once' });
  const allowAlways = options.find((o) => o && o.choice === 'allow-always');
  if (allowAlways) {
    const label = allowAlways.label || '';
    const m = /for:\s*(.+)$/.exec(label);
    actions.push({ choice: 'allow-always', label: 'Always allow: ' + (m ? m[1].trim() : label) });
  }
  actions.push({ choice: 'deny', label: 'Deny' });
  return actions;
}

// dialogTextLines(dialog) -> the body lines DialogCard renders between the
// title and the actions. The pane capture repeats what the card shows
// elsewhere, so the raw `lines` are filtered: the title (its own header),
// option lines — numbered ("❯ 1. Yes", "2. No") or equal to an option label
// with or without the leading focus marker (the buttons dialogActions()
// derives stand in for them) — any line mentioning "auto mode" (the
// dashboard never presses it), the footer (rendered separately) and the
// command (its own <pre>; a multi-line command matches line by line).
// Everything else stays in capture order ("Audit dependencies",
// "Do you want to proceed?", …).
export function dialogTextLines(dialog) {
  if (!dialog || !Array.isArray(dialog.lines)) return [];
  const title = typeof dialog.title === 'string' && dialog.title.trim() ? dialog.title.trim() : null;
  const footer = typeof dialog.footer === 'string' && dialog.footer.trim() ? dialog.footer.trim() : null;
  const command = typeof dialog.command === 'string' && dialog.command.trim() ? dialog.command : null;
  const commandLines = command ? command.split('\n').map((l) => l.trim()) : [];
  const labels = (Array.isArray(dialog.options) ? dialog.options : [])
    .map((o) => (o && typeof o.label === 'string' ? o.label.trim() : ''))
    .filter(Boolean);
  const out = [];
  for (const line of dialog.lines) {
    if (typeof line !== 'string' || !line.trim()) continue;
    const t = line.trim();
    if (title !== null && t === title) continue;
    if (footer !== null && t === footer) continue;
    if (command !== null && (t === command.trim() || commandLines.includes(t))) continue;
    const unfocused = t.replace(/^❯\s*/, '');
    if (/^\d+\.\s/.test(unfocused)) continue; // a numbered option line
    if (labels.includes(unfocused)) continue; // an unnumbered (select) option
    if (t.toLowerCase().includes('auto mode')) continue;
    out.push(line);
  }
  return out;
}

// askAnswers(ask, selection) -> { ok: true, answers } | { ok: false, reason }.
// selection is { [questionIndex]: { choices: [optionIndex…], text } } from the
// AskCard state. A single-select question needs exactly one choice or a
// non-empty text (the text wins when both are set — it is sent alone, the
// host's key plan cannot combine a picked option with typed text); a
// multiSelect question needs at least one choice and carries no text.
export function askAnswers(ask, selection) {
  const questions = (ask && ask.questions) || [];
  if (questions.length === 0) return { ok: false, reason: 'The ask has no questions.' };
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const sel = (selection && selection[i]) || {};
    const choices = Array.isArray(sel.choices) ? sel.choices.filter((c) => Number.isInteger(c)) : [];
    const text = typeof sel.text === 'string' ? sel.text.trim() : '';
    const n = i + 1;
    if (q.multiSelect) {
      if (choices.length === 0) return { ok: false, reason: 'Question ' + n + ' needs at least one choice.' };
      answers.push({ choices });
    } else if (text) {
      answers.push({ choices: [], text });
    } else if (choices.length === 1) {
      answers.push({ choices });
    } else if (choices.length === 0) {
      return { ok: false, reason: 'Question ' + n + ' needs a choice or some text.' };
    } else {
      return { ok: false, reason: 'Question ' + n + ' takes exactly one choice.' };
    }
  }
  return { ok: true, answers };
}

// answerResultText(result) -> the honest sentence for the success banner
// (SupervisorPanel + NeedsYouInbox). The host's answer is not always a clean
// yes: answered === false or closed === false means the dialog is still on
// screen, and a resumedFrom > 0 means the first steps had already been
// applied (the re-answer was a no-op for them). A 409 — including
// partial: true — never reaches here: useSupervisorAnswers routes it to the
// error state with its own sentence.
export function answerResultText(result) {
  const r = result || {};
  if (r.answered === false || r.closed === false) {
    return 'The dialog is still on screen — check the Terminal.';
  }
  if (Number.isInteger(r.resumedFrom) && r.resumedFrom > 0) {
    return 'Sent — the first ' + r.resumedFrom + ' answer' + (r.resumedFrom === 1 ? ' was' : 's were') + ' already applied.';
  }
  return 'Answer sent.';
}
