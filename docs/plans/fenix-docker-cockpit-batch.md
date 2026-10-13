# FOC-810 + FOC-803 + FOC-811 — Cockpit without the terminal, any host uid, run data on the volume

Date: 2026-10-12. One PR for three lane-O tasks (Mateusz: "zrób kilka tasków do jednego PR"). All three come from running
Fenix on `fenix-vm`.

## FOC-810 — the Cockpit answers the Supervisor's dialogs

**Found on the VM:** the Supervisor asked 6 questions through Claude Code's `AskUserQuestion` (a TUI dialog — no gate or
hold record, so Needs-you stayed empty and the chat answered 409); permission prompts and `/compact` needed the Terminal;
a fresh volume shows "Make auto mode your default permission mode?" before the first message, which the pane check did
not even recognise (`not-ready`).

**Evidence for the design (acceptance stack, real Claude Code 2.1.296 + fake Messages API, 2026-10-12):**

* `AskUserQuestion`: the tool_use input (questions, headers, options with descriptions, `multiSelect`) is in the
  transcript before it is answered. In the TUI a digit picks an option (single question: picks and submits; several
  questions: picks and moves on), in multiSelect a digit toggles and `→` moves on, then a review screen takes `1`
  ("Submit answers"); the "Type something." option takes literal text + Enter; Esc cancels.
* Permission dialog: `1. Yes`, `2. Yes, and don’t ask again for: <pattern>`, `3. Yes, and switch to auto mode`, `4. No`,
  Esc cancels.
* `/context` pasted into the prompt works; its output appears only on screen (not in the transcript). `/cost` opens a
  modal panel that Esc closes.
* The auto-mode nudge is answered "no" by `hasSeenAutoDefaultNudge: true` in `.claude.json`; nothing else changes.
* Claude Code 2.1.296 also has a `PermissionRequest` hook (`decision.behavior` allow/deny). Not used here: a hook that
  waits for the dashboard would hide the dialog from the Terminal; the pane keeps both in sync.

**Design.** Pane fixtures pin the parser (`scripts/fixtures/session-dialogs/`).

1. `scripts/session-dialog.mjs` (pure): `parseDialog(pane)` → `{ id, kind: permission|ask|ask-review|select, title,
   lines, command, question, tabs, options[{key,label,description,focused,checked,choice}], footer }`;
   `askKeyPlan(questions, answers)`; `pendingAskFromTranscript` / `readPendingAsk`; `slashCommandPolicy`;
   `extractCommandOutput`.
2. Session host (`supervisor-host.mjs`):
   * `GET /dialog` → `{ dialog }` (parsed, or null).
   * `POST /dialog/answer { id, choice: "allow-once"|"allow-always"|"deny", note? }` — permission dialogs only; the
     current dialog's `id` must match (else 409 `dialog-changed`); `allow-once` / `allow-always` press the option whose
     `choice` matches; `deny` presses Esc and, with a note, pastes the note as the next message once the prompt is
     back. An option whose choice is `auto-mode` is never pressed. For a `select` dialog only `deny` (Esc) is accepted.
   * `POST /dialog/ask { questions, answers }` — the pane must show an `ask` dialog whose question matches
     `questions[0].question`; runs `askKeyPlan`, re-capturing the pane before every step (409 `dialog-changed` with the
     step on mismatch); 200 `{ answered: true }` once the dialog is gone.
   * `POST /message` with a slash command: `slashCommandPolicy` — `/compact [focus]`, `/context`, `/cost` are pasted;
     for `/context` / `/cost` the host captures the scrollback, returns `{ sent, output }` (and presses Esc after a modal
     `/cost`); anything else stays 400 with the allowed list.
   * The pane check uses `parseDialog` (any dialog → `needs-input`), so the auto-mode nudge and select lists count.
3. `fenix-claude-prefs.mjs` writes `hasSeenAutoDefaultNudge` / `hasSeenAutoDefaultNotice` (the "keep manual mode"
   answer; `permissions.defaultMode` is never touched).
4. Cockpit API (`cockpit-routes.mjs`):
   * snapshot: `supervisor.dialog` (host `/dialog` when the state is `needs-input`, else null) and `supervisor.pendingAsk`
     (`readPendingAsk` on the session transcript — `{ toolUseId, questions }` or null);
   * Needs-you gains `category: "ask"` (answerKind `ask`, from `pendingAsk`) and `category: "dialog"` (answerKind
     `dialog`, a permission or select dialog with no pending ask) — counted in the badge;
   * `POST /api/supervisor/ask { toolUseId, answers }` — re-reads `pendingAsk`, 409 `ask-changed` if the id differs,
     forwards `{ questions, answers }` to the host, records an `ask-answer` row (who: dashboard) in the current run's
     edits when a run is known;
   * `POST /api/supervisor/dialog { id, choice, note? }` → host `/dialog/answer`;
   * same write guards as `/api/supervisor/message`.
5. UI: `AskCard` (questions with radio / checkbox options, descriptions, a free-text field for single-select, Submit)
   and `DialogCard` (permission: tool + command, "Allow once", "Always allow <pattern>", "Deny" with an optional note;
   select: its text + "Dismiss (Esc)" + "Open Terminal"). Shown above the chat composer and in Needs-you. The chat's
   disabled reason points to the card, not to the Terminal. Slash command output shows as a command bubble.

## FOC-803 — any host uid

The image is built for the host user: `ARG FENIX_UID/FENIX_GID` (default 1000) re-number `node` with
`usermod`/`groupmod` at build time; Compose passes the args; `./fenix` exports `id -u` / `id -g` on Linux (uid 0 refused,
macOS / Windows untouched). No root at runtime. `fenix doctor` (in the container) fails readable-secret and writable
`/fenix-config` checks with the fix. GHCR (FOC-775) needs a thin local rebuild for uid ≠ 1000 — noted there.

## FOC-811 — run data on the volume

`fenix-paths.mjs` `stateRoot()` / `runsDir()` (`LA_STATE_ROOT` or `<repo>/.state`) used by `run-manifest`, `ledger`,
`telemetry-server`, decision-log / decision-call / graph-runner / backfill; `Dockerfile` `LA_STATE_ROOT=/data/state`.
The Supervisor's own transcript is ingested through the SessionStart session link (FOC-807 exports `LA_RUN_ID`), so no
`end` is needed.

## Verification

Unit tests per slice; Windows `test-all` + Linux lane; acceptance on an isolated stack (fresh volume, fake API):
first message without the Terminal; an `AskUserQuestion` (single, two questions with multiSelect, free text) answered from
Needs-you and from the chat card; a permission prompt allowed once, denied with a note; `/compact`, `/context`, `/cost`
from the chat; a child-style manifest written under `/data/state/runs` and seen by `fenix-api`; the Supervisor's turns in
telemetry; an image built for uid 1001 reading 0600 secrets owned by 1001.
