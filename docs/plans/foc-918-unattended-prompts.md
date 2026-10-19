# Delivery Plan — FOC-918 Unattended Supervisor: prompts become visible, aged and answerable

Linear: **FOC-918** (M8, parent FOC-768, High, bug). Seen on `fenix-vm` 2026-10-19 during the FOC-809 sizing run;
written the same day by the delivery owner. Recon in §0 is against main f78f619.

## 0. What happened, and what the code did

Three times during the FOC-809 run the Supervisor (auto mode, GLM flash) stopped on a `Do you want to proceed?`
prompt and stayed there until a person noticed and answered in tmux:

- `Ask rule Bash(rm -rf:*) overrides auto mode for this command. /permissions to let auto mode decide` — the
  Supervisor's own `ask` list (`agents/supervisor/settings.json:127-135`: `git push`, `gh pr merge`,
  `git reset --hard`, `git clean`, `git branch -D`, `rm -rf`, `WebFetch`) overriding auto mode on a scratch
  `rm -rf`; twice.
- `Auto mode classifier requires confirmation for this command. 3 consecutive actions were blocked. … Latest
  blocked action: [External System Writes]` — the classifier after three blocked actions; once.

While parked, the dashboard counters said *0 running / nothing needs you*: the Needs-you inbox only lists the
LIVE Supervisor session's prompts when `parseDialog()` (`scripts/session-dialog.mjs:61`) recognises the pane
(`supervisorSessionItems`, `scripts/cockpit-routes.mjs:604-634`); a prompt the parser misses yields no item, and
`cockpitCounts` (`scripts/cockpit.mjs:625`) counts answerable items and problems only. Both prompts do contain
"Do you want to proceed?" and a numbered list, so the parser classifies them as `permission` — but nothing carried
the *why* (which rule, which classifier verdict), neither prompt had a fixture, and nothing aged: the host's
effective `needs-input` state (`scripts/supervisor-host.mjs:411-423`) is recomputed per poll and never
timestamped, the stall machinery (`stallSilenceMs()`, 10 min of tee silence) is child-only, and `fenix doctor` had
no line for it.

Two things the first draft of this plan wanted and this version drops, with the reason:

- *A wake-queue row and a `supervisor-status --wait` outcome `parked`.* The Supervisor is the process that runs
  `--wait`; a parked Supervisor runs nothing, and a wake row would try to `/message` a session that answers 409
  `needs-input`. The in-band channels cannot reach a parked session by construction — visibility and
  answerability from outside are the contract.
- *Auto-deny after a timeout.* A denied `git push` or `gh pr merge` loses the turn's work silently; the policy
  (`taskSessions.parkedPrompt: "wait" | "deny-after"`) stays designed but unimplemented, and the `ask` list stays
  pinned verbatim (`config-drift.test.mjs:294-322`) — the scratch `rm -rf` cases are the Supervisor's own hygiene
  to fix in its prompt, not a reason to weaken the list.

## 1. Contract

A. **Recognised, with a reason.** Two fixtures captured from the VM panes (`scripts/fixtures/session-dialogs/
   ask-rule-override.txt`, `classifier-blocked.txt`). `parseDialog` classifies both as `permission` with options
   `Yes / No` (`allow-once` / `deny`) and a new `reason` field: `{ type: "ask-rule", detail: "Bash(rm -rf:*)" }`
   or `{ type: "classifier", detail: "External System Writes" }`; `null` on every other dialog. The existing
   answer path (`POST /api/supervisor/dialog` → host `/dialog/answer`) answers them unchanged.
B. **Never invisible.** The host's GET `/state` carries `needsInputSince` (the hook's `updatedAt` when the hook
   itself says `needs-input`, else the first poll that saw the prompt on the pane; null otherwise). The cockpit
   snapshot carries `supervisor.needsInputSince` and, when the session is `needs-input` and no ask/dialog item was
   produced, a Needs-you item `problem:supervisor:unrecognised-prompt` (category `problem`, `answerable: false`) —
   so the counter stops saying nothing needs you even when the parser cannot read the pane.
C. **Bounded in time.** Past `stallSilenceMs()` (10 min) the snapshot adds `problem:supervisor:parked` (kind
   `supervisor-parked`, with the age and the reason or title of the prompt) and `supervisor.parkedSince`.
D. **Doctor and docs.** `fenix doctor` prints `supervisor prompt`. The Supervisor host is the source of truth
   (its GET `/state`: effective `state` + `needsInputSince`, the same facts the dashboard shows); `warn` with the
   since-timestamp and the fix past `stallSilenceMs()`, `warn` "cannot tell" when a configured host does not
   answer, `ok` otherwise. Without a host (native mode) the hook's `session.json` stands in, with a stated caveat:
   the record carries no pid and an Esc-cancelled turn leaves it saying `needs-input` until the next turn — the
   first draft's "dead pid = stale record" branch could never fire (`pidAlive(undefined)` is true) and was
   dropped in review. QUICKSTART "Fenix on a VM" gets a "When nobody is attached" paragraph: what stops an
   unattended Supervisor, where it shows, how to answer (Needs-you card, Terminal tab, `fenix attach`).
E. **Unchanged.** The `ask` list; the UI (problem items already render with the `danger` tone and the summary
   text); the host's dialog detection fallback (`DIALOG_RE`).

## 2. Slices (Flash, literal contracts, run in parallel)

| Slice | Files |
|---|---|
| A parser | `scripts/session-dialog.mjs` (`permissionReason`, `reason` on the result), two fixtures, `scripts/session-dialog.test.mjs` (+3) |
| H host | `scripts/supervisor-host.mjs` (`needsInputSince` closure state + field), `scripts/supervisor-host.test.mjs` (+3) |
| K cockpit | `scripts/cockpit-routes.mjs` (`parkedSinceOf`, the two problem items, two `supervisor` fields), `scripts/cockpit-routes.test.mjs` (+3) |
| D doctor + docs | `scripts/fenix-doctor.mjs` (`checkSupervisorPrompt`), `scripts/fenix-doctor.test.mjs` (+4), `docs/QUICKSTART.md` |

## 3. Verification

Unit lanes per slice (`session-dialog`, `supervisor-host`, `cockpit-routes`, `fenix-doctor`), lint, the Linux lane
in CI. A VM check is deferred to the next VM session (the VM is stopped; the check is: park the Supervisor on a
scratch `rm -rf`, see the Needs-you card with the reason within one poll, answer allow-once from the card, and
leave one unanswered past 10 min to see the parked problem and the doctor line).

## 4. Out of scope

A push channel (Discord/webhook — a later integration), auto-deny policies, changing the `ask` list, the
Supervisor prompt hygiene for scratch `rm -rf` (an FOC-898 note: prefer `git clean`-free, `rm`-free cleanup in
the Supervisor's own tree, or run it through a helper that is not on the ask list).

## 5. Results (2026-10-19)

- Four Flash slices in parallel on one worktree (A parser, H host, K cockpit, D doctor + docs), each with a
  file:line contract; all four finished inside their budgets. Flash review → CHANGES-REQUIRED with eight
  findings: five applied (the doctor's dead-pid branch could never fire because the hook record carries no pid
  → the host is now the doctor's source of truth, `session.json` the native fallback with a caveat; the doctor's
  threshold now defaults to `stallSilenceMs()` instead of a hard-coded 10 min; an unreadable `updatedAt` is a
  `warn`, not "0 min"; an ask whose transcript cannot be read gets its own wording on the unrecognised item;
  the parked-summary assertion tolerates 11/12 min), one noted (in native mode and in the doctor's fallback the
  anchor is the hook's `updatedAt`, which a later notification during the same wait can bump once — the host
  anchor is frozen on first observation), two rejected (the host anchor already freezes via the `=== null`
  guard; the bracket regex captures a nested bracket correctly: lazy `.+?` extends until `\]?\s*$` matches).
- Lanes `session-dialog` (+3), `supervisor-host` (+3), `cockpit-routes` (+4), `fenix-doctor` (+6),
  `config-drift`, `docs-count-guard` green; lint 0; `state-index` clean.
- Offline acceptance (API native mode on :7391, Vite :5191, a `session.json` saying `needs-input` since 11 min):
  `GET /api/cockpit` → `counts.needsYou: 2`, `supervisor.needsInputSince` and `parkedSince` set, both problem
  items with the age; the Cockpit renders "2 needs you", the Supervisor panel "needs input", two read-only cards
  ("Nothing to answer here — read-only", "Open evidence") — no UI change was needed.
- Deferred: the VM check (§3) to the next VM session; the Supervisor prompt hygiene for scratch `rm -rf` (§4).
