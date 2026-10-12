# FOC-783 — Cockpit: Supervisor chat + web terminal + Needs-you inbox

Date: 2026-10-12. Spec: `docs/ui/dashboard-v2-spec.md` §4.1, §5, §6. Builds on FOC-776 (Supervisor in Docker),
FOC-795 (records API), FOC-800 (writes from the dashboard in Docker).

## What exists today (recon)

- The `fenix-supervisor` container runs `sleep infinity`. The Supervisor lives only while `fenix attach` is open:
  `docker compose exec … entrypoint.sh supervisor` → `exec claude --continue` on the TTY Docker hands out. Closing the
  terminal ends the process. No tmux, no PTY library, no WebSocket anywhere (`ajv` is the only runtime dependency).
- Waking is a harness feature of the **interactive** session: `supervisor-wake.mjs` is a Stop hook with `asyncRewake`;
  it exits 2 on a fresh wake-queue / edits row and Claude Code wakes the idle session. A headless `claude -p` turn
  cannot be woken this way.
- Two `claude` processes on one session id interleave (documented for children in `supervisor-followup.mjs:88-97`).
  The Supervisor session id is not persisted anywhere; resume is implicit (`--continue`).
- Gates: `supervisor-gate.mjs emit|answer` (`pending` → `answered`, answered once); delivery to the child is a separate
  `supervisor-followup.mjs --gate` that only the Supervisor runs. Holds live in `<run>/holds.json`. Push/PR approvals are
  gates of kind `push-approval` / `pr-approval`; the push itself stays the Supervisor's act (FOC-788 adds a human push).
- There is no "STOP report" file. A decision for Mateusz is a pending gate, an open hold, or a failure the Supervisor
  escalates (crash, stall, held spawn, `partial-status.json`).
- The API container cannot see the supervisor container's processes (separate PID namespaces), so it cannot probe a
  child's pid itself.
- No gate, hold or "needs you" endpoint exists. The UI polls with `setInterval`, there is no SSE.

## Design

### 1. Session host — one Supervisor process, many views

The Supervisor runs in a **tmux session** inside `fenix-supervisor`, owned by a small host process that replaces
`sleep infinity`. Every view attaches to that one process:

| view | how |
|---|---|
| `fenix attach [--new]` | `tmux attach` to the session (Ctrl-b d detaches, the Supervisor keeps running) |
| dashboard Terminal | another tmux client of the same session, over a WebSocket |
| dashboard Chat | the message is pasted into the same session (bracketed paste + Enter); the reply is read from the session transcript |

One process means no competing turns and nothing to corrupt; the waker keeps working because the session is interactive
and stays alive with nobody attached. While a turn runs, a chat message is queued by Claude Code like typed input. When the
Supervisor shows a dialog (permission prompt, elicitation), chat refuses with 409 and the UI says "answer it in the
Terminal" — keystrokes must never answer a dialog.

`scripts/supervisor-host.mjs` (container main process, `entrypoint.sh host`; `idle` stays as an alias). The `host` case
runs what the old cases ran at start — `resolve_provider`, `configure_git`, `mark_orphans` (FOC-799) — before tmux.
- tmux on its own socket (`-L fenix`), session `supervisor`, options `window-size latest`, `default-size 200x50`,
  `history-limit 50000`. `ensureSession({ fresh })` starts `entrypoint.sh supervisor-run [--new]` inside it (the current
  `supervisor` case, renamed; `supervisor` becomes an alias of `attach` so no path starts a second claude) and returns
  ready only after the new session's SessionStart hook has written `session.json` (30 s, else 503 "starting").
- HTTP on `:7332`, compose network only (not published). Two gates on every request: the peer address must be the
  `fenix-api` container's (DNS lookup, cached briefly) — children run in this container as the same user and connect
  from loopback or this container's address — and `x-fenix-host-token` must equal `/data/run/host.token` (random,
  0600, rewritten at start; the API re-reads it per request because a supervisor restart rotates it). `GET /healthz`
  (loopback only, no token, no side effects) serves the compose healthcheck.
  - `GET /state` → tmux session present, pane pid, attached clients, hook state, waker lease state. Precedence: a dead
    or missing pane means `absent` whatever `session.json` says (no SessionEnd after a kill or OOM).
  - `POST /session {fresh}` → ensure (fresh = kill and start `--new`)
  - `POST /message {text}` → refuses: `needs-input` state (409), a leading `/` (slash commands go through the
    Terminal: `/exit`, `/clear`), text over 8 KB. Strips C0/C1 control characters except `\n` and `\t`. Then ensure,
    `load-buffer` + `paste-buffer -p -d` + `Enter`, and waits up to 5 s for proof: `session.json` turned `busy` after
    the send, or the transcript gained the user line. Returns `{ sent, confirmed, queued }`; nothing is retried blind.
  - `POST /alive {pids}` → `{ pid: bool }` (`processAlive` in the container that owns the children)
  - `WS /terminal?cols&rows` (integers, bounded) → node-pty runs `tmux -L fenix attach -t supervisor`; text frames are
    input/output, a JSON `{type:"resize",cols,rows}` frame resizes; closing the socket detaches that client only.
- Image: `tmux` (Debian 3.3a), `ws` and `node-pty` from npm; node-pty is compiled in a builder stage, the runtime stage
  stays slim. `LA_TMUX_BIN` is a test seam like `LA_CLAUDE_BIN`.
- Pane check (found in live acceptance): hooks alone are not enough — SessionStart fires before the input box accepts
  input, and a dialog cancelled with Esc ends the turn with no Stop hook, leaving `needs-input` behind. The host reads the
  visible screen (`capture-pane`) before every paste: a dialog on screen → 409 whatever the hook says; a stale
  `needs-input` with an empty prompt on screen → proceed; readiness waits for the empty prompt after SessionStart.
- Healthcheck adds `/healthz`, so a wedged host restarts the container (`unless-stopped`).
- Known limit, not widened here: children run in the Supervisor's container as the same user. They can already edit the
  Supervisor's settings and records on the volume, and they can reach its tmux socket. Isolating children (own uid or
  sandbox) is a follow-up ticket.

### 2. Session state — hooks tell the dashboard what the Supervisor is doing

`scripts/supervisor-session-hook.mjs <event>` on SessionStart, UserPromptSubmit, Notification, PostToolUse, Stop and
SessionEnd in `agents/supervisor/settings.json` writes `supervisorSessionPath()` (new in `fenix-paths.mjs`:
`<dataHome>/supervisor/session.json`) atomically and only on change:
`{ sessionId, transcriptPath, cwd, state: idle|busy|needs-input|ended, notification, updatedAt }`.
SessionStart/Stop → idle, UserPromptSubmit/PostToolUse → busy, Notification `permission_prompt` or
`elicitation_dialog` → needs-input, SessionEnd → ended. Always exits 0, prints nothing. This also persists the
Supervisor's session id for the first time. The `notification_type` field is checked against a real payload of the
pinned Claude Code before acceptance, with the message text as the fallback. idle/busy is best effort (a Stop the guard
blocks still writes idle; a woken turn has no UserPromptSubmit) — only `needs-input` gates anything, and a dialog
cannot be open across a Stop.

### 3. API (fenix-api)

Library `scripts/cockpit.mjs` (pure, fixture-tested):
- `collectNeedsYou({ stateHome, now })` over run dirs touched in the last 14 days:
  - `gate` — pending gates of kind `question`, `plan.gate1`, `plan.gate2`; free-text answer.
  - `approval` — pending `push-approval`, `pr-approval`, `cleanup-approval`, `draft-approval`; Approve / Reject + note.
  - `hold` — open holds from `holds.json` with options, recommendation, impact; pick an option or write an answer. The
    dashboard reads `holds.json` directly; it never calls `list --open` (that stamps `presentedAt`).
  - `problem` — crashed child (exit ≠ 0, not stopped, no later turn), stalled child, held spawn request,
    `partial-status.json`; read-only with "Ask the Supervisor" (pre-fills chat) and "Open evidence".
  - an unreadable gate counts as pending and shows as such; a `waiting_gate` child and its gate are one item; an
    answered but not yet delivered gate shows as "answered — waiting for delivery".
- `collectChildren({ stateHome, now, probe })` — §5 status per child (live ones + those ended in the last 24 h, max 30):

  | status | rule |
  |---|---|
  | running | registry live, process alive, tee grew within `stallSilenceMs()` |
  | stalled | registry live, process alive, tee silent longer |
  | waiting · gate | a pending gate for the child |
  | exited N / stopped | terminal registry status with its exit code |
  | unknown | probe unavailable, no pid or no tee — or the process is gone with no exit recorded (detail says which) |

  Every child carries `checkedAt`. `probe` = the host's `/alive` in Docker, local `processAlive` natively.
- `supervisorSummary()` — host reachable / unreachable / not in Docker, hook state, session id, model
  (`SUPERVISOR_MODEL`), focus ticket = `triage.json` issue of the most recently active run (until FOC-769), waker lease
  state and un-acked wake rows. After a container restart the resumed Supervisor sits idle with no waker; the Cockpit
  shows "N events waiting" with a **Wake** button that sends the usual drain prompt — the Supervisor is never prompted
  without a human click.
- `readConversation({ transcriptPath, after, limit })` — incremental read of the transcript by byte offset: user text,
  assistant text, tool calls as one line (`Bash: node scripts/…`), hook context and tool results left out.

Routes (writes before the GET-only guard, all behind `isLocalOrigin` + `isAllowedOrigin`):

| method | path | does |
|---|---|---|
| GET | `/api/cockpit` | `{ supervisor, needsYou, children, counts, checkedAt }` |
| GET | `/api/supervisor/conversation?after=&limit=` | transcript entries since a byte offset + session state |
| POST | `/api/supervisor/message` | `{ text }` → host; 503 host unavailable or starting, 409 needs-input, 400 slash command / too long |
| POST | `/api/supervisor/session` | `{ fresh, confirm: "new-session" }` → host ensure |
| POST | `/api/gates/answer` | `{ runId, gateId, text, note? }` — (1) records the answer verbatim with `answeredBy: "dashboard"` through the gate library (answered once, yes/no for cleanup); (2) sends the Supervisor `[dashboard] Mateusz answered <gateId> for <childId> (<taskId>); the answer is in the gate — deliver it.`; (3) appends an `edits.jsonl` row `gate-answer` through `agent-records.mjs` (its single writer) with `notified` = whether (2) went through. A notified row is audit only; an un-notified one is shown by the waker and the next-prompt hook. Returns `{ recorded, notified }`; the UI says plainly when the Supervisor was not told and offers "Tell the Supervisor" (also on every "answered — waiting for delivery" item) |
| POST | `/api/holds/answer` | `{ runId, holdId, text }` — same pattern through the hold library |
| WS | `/api/supervisor/terminal` | upgrade only with a loopback/gateway peer, a `Host` of `localhost` / `127.0.0.1` / `[::1]` (DNS rebinding) and an `Origin` that is present and equals that same host and port — stricter than `isAllowedOrigin`, which accepts any localhost port, so a page from another local dev server cannot open the terminal; raw proxy to the host with the token added |

`answerGate` / `answerHold` are lifted out of `supervisor-gate.mjs` into exported functions so the CLI and the API share
one rule set, and "answered once" becomes atomic: an exclusive lock file (`open(…, "wx")`) around read-check-write, so the
dashboard and the Supervisor answering the same gate at once cannot both win. compose: `fenix-api` gets
`FENIX_SUPERVISOR_HOST=http://fenix-supervisor:7332`; the telemetry server gains an `upgrade` listener.

### 4. Supervisor instructions

`agents/supervisor/CLAUDE.md`, a short "Dashboard" note: a `[dashboard]` gate or hold notice carries Mateusz's verbatim
answer, already recorded — deliver it (`supervisor-followup.mjs --gate` for a gate; act on the hold), do not ask again.
A hold answered before it was presented counts as presented. Chat messages are Mateusz typing; nothing else changes.

### 5. UI

- `Cockpit.jsx` becomes `/`; v1 Live moves to `/live` until the Work board (FOC-784) absorbs it. Navigation: Cockpit
  first with the Needs-you count.
- Supervisor panel: header (state chip, focus ticket, model), tabs **Chat** (default) | **Terminal**, quick prompts
  ("Start a ticket…", "Status of all children", "What is blocked?") that pre-fill the composer. Chat polls the
  conversation every 2 s while visible; Enter sends, Shift+Enter is a new line; disabled with the reason when the host is
  down or a permission prompt is open. Terminal: `@xterm/xterm` + `@xterm/addon-fit`.
- Needs-you inbox: per item ticket, age, one-line context, the questions/facts or options, the primary action, "Open
  evidence" (run detail with the Records panel).
- Live children: id, ticket, squad label + colour, status chip, age, cost (token-priced, labelled), "checked N s ago".
- Header strip: needs you, running, stalled, waiting on a gate, unknown. Spend and "landed this week" stay out until
  there is one proven source (reconciled cost FOC-760/761/769 and FOC-785; landing is not tracked yet) — principle 1.
- Chat and Terminal typing into the composer at the same moment is undefined (one person, two keyboards) — documented.
- Natively on Windows (no tmux): the Supervisor panel says "Chat and Terminal run in Docker (`fenix up`)"; inbox and
  children work.

## Slices

| # | slice | depends |
|---|---|---|
| S1 | `supervisor-session-hook.mjs` + `supervisorSessionPath()` + settings hooks + tests | — |
| S2 | `cockpit.mjs`: needs-you, children status, summary + fixture tests | — |
| S3 | `readConversation` + tests on a real transcript shape | — |
| S4 | lift `gateAnswer` / `holdAnswer` into exported functions (CLI unchanged) + `gate-answer` row type in `agent-records.mjs` + tests | — |
| S5 | `supervisor-host.mjs` (tmux, token, HTTP, WS + node-pty) + unit tests with the tmux seam | — |
| S6 | Dockerfile (tmux, builder stage for node-pty), compose, entrypoint `host` / `attach` / `supervisor-run`, `fenix attach` | S5 |
| S7 | telemetry-server routes + WS proxy + guards + tests | S2–S5 |
| S8 | UI: Cockpit screen, chat, terminal, inbox, children, nav, `/live` | S7 |
| S9 | Supervisor CLAUDE.md note, docs (QUICKSTART attach/detach, ACCESS ports), test lanes, checklist count; `fenix doctor` warns when a kept user-edited `agents/supervisor/settings.json` lacks the FOC-795/783 hooks (seeding keeps edited files) and QUICKSTART's upgrade note says how to merge them | S1–S8 |

## Acceptance

Isolated compose project, Supervisor on `z-ai/glm-5.3-flash` (a few cents), children on the mock claude:
1. `fenix attach` → Supervisor in tmux; detach; it keeps running; the dashboard Terminal shows the same screen and typing
   in either shows in both.
2. A chat message appears in the terminal as a user prompt and the reply appears in Chat; a message sent mid-turn is
   queued and answered after; a multi-line message arrives as one prompt; with a permission prompt open, chat is refused
   and says why (checked against the real Notification payload).
3. A gate answered in the inbox: the record shows the verbatim answer with `answeredBy: dashboard`, the Supervisor gets
   the notice and delivers it (a follow-up turn starts).
4. Killing a child process shows within one refresh (5 s).
5. Foreign `Origin` on the WebSocket → 403; the host port without the token → 401; the Linux host cannot reach the host
   port's actions without the token.
6. Linux and Windows suites green; UI build; the Cockpit verified in the browser.

## Out of scope

Autonomous ticket pickup; human push / PR (FOC-788); spend in the header (FOC-785); Work board (FOC-784); dark theme.
