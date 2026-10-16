# PRD — Multi-Supervisor isolation: N autonomous Supervisors on one repository

Status: **DRAFT 2026-10-16** — written by the delivery owner from Mateusz's voice prompt of 2026-10-16 (evening).
Open questions in §2.3 carry proposed defaults; the plan executes on those defaults unless Mateusz changes them.

## 1. Problem & Goal

Mateusz wants to run several very autonomous Supervisors against one repository at the same time ("kilka
Supervisorów, żeby mogło pracować nad jednym repo, żeby się nie mieszali"). The 2026-10-14 delivery of
`docs/prd/task-workspace-supervisors-prd.md` already gives one active Supervisor per task, a session multiplexer,
a durable SQLite coordinator, per-session state paths, worktree claims and a repo-wide integration lock. What is still
shared, and therefore still collides (recon 2026-10-16, `scripts/`, `docs/STATE.md:1724-1763`):

1. **Ticket selection has no lease.** The queue is a prose section of `docs/STATE.md`; two Supervisors pick the same
   ticket and only the workspace claim at spawn time refuses the second — after both ran intake and triage.
2. **Legacy run identity.** An unscoped Supervisor session silently adopts the newest run directory
   (`scripts/supervisor-current-run.mjs`, `source: "adopted"`), hijacking a live run's guard, waker, budget and
   cockpit. SCOPED mode (`FENIX_SUPERVISOR_SESSION_ID`) prevents it, but nothing enforces SCOPED mode.
3. **Scratch outside run directories.** `.state/reviews/`, `.state/review-rounds.json`, `.state/krok0-*/` and the
   legacy `session.json` are shared between sessions; a parallel session is the leading hypothesis for the
   unrecoverable deletion of eight verdict files (`docs/STATE.md:1724`).
4. **One global journal.** `docs/STATE.md` is written by every Supervisor by contract; entries interleave, the queue
   head is fought over, and a text conflict already blocked `supervisor-merge` once (`docs/STATE.md:2595`).
5. **Stack-global config and identity.** `/fenix-config/settings.json` (routing, model policy), `agents/` squad config,
   the single host token and port 7332, and `supervisor-orphans` scanning every run at container start.

Two side asks from the same prompt belong here because they are about the Supervisor's autonomy:

6. **Editable, visible tool sets per agent.** Mateusz hand-edited `agents/supervisor/settings.json` once and cannot
   tell what he added; he wants to see and edit which tools each agent has (permissions, MCP servers, skills) and to
   consider new tools.
7. **The "grill me" skill** (Matt Pocock's `grilling` interview, MIT) as a planning tool of the Supervisor and of the
   PLAN lead: it surfaces inconsistencies before a plan is approved.

Goal: N Supervisors (N configurable, default 2, target 4) run on one repository without touching each other's
tickets, runs, worktrees, scratch or journal; every tool an agent has is declared in one place, validated, and
editable without hand-editing JSON.

## 2. Requirements, separated by certainty

### 2.1 Confirmed (said outright on 2026-10-16)

- Several autonomous Supervisors on one repo, isolated from each other, is the priority.
- Check what was hand-added to `agents/supervisor/settings.json` (result: no uncommitted edits; the committed allow
  list is wide — see §6.6).
- The tools agents have must be reviewable and editable; new tools may be added.
- "grill me" becomes a planning tool of the Supervisor or the PLAN lead.
- The decisions taken alone on 2026-10-16 (STATE.md labelled lines, registry consts, store path, hold dedup) stand.

### 2.2 Assumptions (the delivery owner's reading — flag if wrong)

- "Many Supervisors" means managed task sessions inside ONE container/stack (the delivered multiplexer), not several
  containers on one `/data` volume.
- A Supervisor owns a ticket end to end (intake → children → landing); Supervisors never share a ticket.
- Linear stays the source of truth for tickets; `docs/STATE.md`'s queue becomes advisory.
- Tool editing happens through a validated CLI first; a Settings-UI panel follows (read-only first).
- `agents/**` edits for skills and contract one-liners are covered by the consent recorded in
  `docs/STATE.md` (2026-10-08, point 4: `agents/**` for FOC-621 remainder + FOC-730); new contract lines for
  grilling and the journal split are asked below.

### 2.3 Open questions with proposed defaults

| # | Question | Default |
|---|---|---|
| Q1 | How many Supervisors at once? | cap configurable (`taskSessions.maxActive` overlay key), default 2, raise to 4 after the resource spike |
| Q2 | One container with N sessions, or N containers? | one container, N managed sessions; N containers on one `/data` is out of scope (documented) |
| Q3 | Who assigns tickets? | each Supervisor claims the next unclaimed ticket of its owner scope through the task-sessions lease; Linear gets a short "claimed by `sup-…`" comment; nothing in STATE.md |
| Q4 | Split the journal? | yes: per-task files `docs/state/<TASK>.md` + `docs/STATE.md` as index and global decisions; needs one contract line |
| Q5 | Where does grilling run? | both: Supervisor before approving any plan or answering a `plan.gate1`, PLAN lead before `plan.ready`; one trigger line each |
| Q6 | Tool editing UX? | CLI `fenix agent-tools` (show/diff/check/allow/deny) now, Settings panel read-only next, editable later |
| Q7 | Narrow the Supervisor allow list? | the delivery owner produces the diff + a proposal; removals only with Mateusz's OK |
| Q8 | FOC-730 (skill + contract lines + task-close prune + deny rules) now? | yes, it shares the skill mechanism with P7 |

## 3. User journey

Mateusz starts a second Supervisor (`fenix supervisor --new` or the cockpit "Start session"). It gets its own
session id, state home, claude config dir and tmux socket (already delivered). It asks Linear for the next ticket of
its owner scope, takes a lease on it (atomic, visible in Linear), runs intake and triage, spawns children into
worktrees it owns, and journals into `docs/state/<TASK>.md`. The first Supervisor never sees that ticket as free,
never adopts the second's run, never prunes its trees, and `docs/STATE.md` stays mergeable. Mateusz opens
`fenix agent-tools show supervisor` and sees allow/ask/deny rules, MCP servers and skills in one table; he adds the
`grilling` skill to PLAN with one command and the next PLAN child has it.

## 4. Scope

**In:** ticket lease; scoped-only autonomy with a configurable cap; scratch moved under run dirs; per-task journal
files with an append-only rule; orphan scan limited to this container's own processes; a per-agent tool registry with
CLI, drift test and docs; vendored `grilling`/`grill-me` skills provisioned to Supervisor and PLAN; the Supervisor
permissions audit report.

**Out:** several containers on one `/data`; per-Supervisor routing overrides (the session claude-dir mechanism
exists if needed later); the Settings-UI editor for tools (read-only panel only); FOC-802/878 uid isolation (own
tickets); rewriting the Supervisor contract beyond the two one-liners.

## 5. UX

Personas: Mateusz as Manager (cockpit + `fenix` CLI), the Supervisor and the PLAN lead as agents. The cockpit already
lists managed sessions; this PRD adds: a "claimed by" marker on Work cards (from the lease), a read-only "Agent tools"
panel in Settings (table per agent: allow / ask / deny / MCP / skills, with the source file), and `fenix doctor` lines
for active sessions vs cap and for journal files without an index entry. CLI output is plain tables, `--json` everywhere.

## 6. Architecture and technical changes

### 6.1 Ticket lease (collision 1)
- `scripts/supervisor-triage.mjs` (and the pickup path the Supervisor contract uses) call
  `task-sessions.ensure(taskKey)` BEFORE intake; an already-owned task returns `held: owned by <sessionId>` and the
  Supervisor moves to the next ticket. The lease row carries `sessionId`, `claimedAt`, `taskKey`.
- `linear-ops.mjs` gets a deterministic, egress-screened comment `claimed by sup-<id> at <iso>` (one per claim; idempotent).
- `supervisor-status.mjs --briefing` prints the owned task and the lease age.

### 6.2 Scoped-only autonomy (collision 2)
- `resolveCurrentRun`: adoption (`source: "adopted"`) is refused when any managed session exists for the stack
  (`task-sessions.sqlite` has rows) unless `LA_SUPERVISOR_ALLOW_LEGACY=1`; a clear message names the scoped path.
- `taskSessions.maxActive` becomes an overlay key (`fenix-settings.mjs` validation, Settings form field, `fenix doctor`
  line "active sessions N / cap M").
- Docker: the entrypoint exports no legacy run id; `fenix supervisor` without `--session` starts a managed session.

### 6.3 Scratch under run dirs (collision 3)
- `.state/reviews/`, `.state/review-rounds.json`, `.state/krok0-*/` move to `<runDir>/reviews/`, `<runDir>/review-rounds.json`,
  `<runDir>/krok0/`; readers (`supervisor-verdict`, `supervisor-followup`, cockpit) follow; a one-shot migration moves
  existing files into the run they belong to (by run id in the file name or mtime window) and reports the rest.
- FOC-602 folds in here (fixtures never touch the live corpus).

### 6.4 Journal per task (collision 4)
- `docs/state/<TASK-ID>.md` per task, appended by the owning Supervisor; `docs/STATE.md` keeps the header rules, the
  index (one line per task file, generated by `scripts/state-index.mjs`), and Mateusz's global decisions.
- Merge rule: a task file is append-only; `supervisor-merge` treats `docs/state/*.md` as "ours + theirs concatenated"
  on conflict. One contract line in `agents/supervisor/CLAUDE.md` (Q4).

### 6.5 Container identity (collision 5, partial)
- `supervisor-orphans.mjs` marks as crashed only children whose recorded process identity (PID + boot id) belongs to
  this container; foreign identities are listed, never touched.
- The host token and port stay per stack (documented as the boundary of this PRD).

### 6.6 Agent tool registry (ask 6)
- `scripts/agent-tools.mjs`: `show <agent>` (allow / ask / deny from `agents/<agent>/settings.json`, MCP servers from
  `.mcp.json` filtered by `mcp__*` allow rules, skills from `agents/<agent>/skills/` + `agents/_shared/skills/`),
  `diff <agent> --against <git-ref>`, `check` (every allow rule matches the documented vocabulary; `SUPERVISOR_DENY`
  is never shrunk; compound-command rules like `Bash(cd:*)`, `Bash(export:*)`, `Bash(set:*)` are flagged until the
  spike in §8 proves they cannot bypass `ask`), `allow|ask|deny <agent> "<rule>"` (validated edits, sorted, one commit
  per edit suggested).
- `scripts/config-drift.test.mjs` gains a case that pins the Supervisor's `ask` list and the deny baseline.
- `docs/agent-tools.md`: the per-agent table rendered by the CLI, regenerated by a test so it never drifts.
- Audit deliverable for Q7: the diff of today's Supervisor allow list against the 2026-09-22 baseline (commit
  `3e7e099`) with a narrowing proposal.

### 6.7 Skills (ask 7)
- Vendor `grilling` + `grill-me` (MIT, attribution header) into `agents/_shared/skills/`; `fenix-seed-agents` already
  seeds `_shared` into every agent; the Supervisor's own skills dir gets them through the same seed.
- One trigger line in `agents/supervisor/CLAUDE.md` and `agents/plan/CLAUDE.md` (Q5).

## 7. Phases (smallest verticals first)

| Phase | Deliverable | Ticket |
|---|---|---|
| P0 | this PRD + Linear tickets | docs PR |
| P1 | grilling/grill-me vendored + provisioned; `agent-tools show/check` read-only + `docs/agent-tools.md` + drift test; Supervisor permissions audit report | new ticket A (skills) + ticket B (tool registry) |
| P2 | scoped-only autonomy + `taskSessions.maxActive` overlay + doctor line | ticket C |
| P3 | ticket lease before intake + Linear "claimed by" + briefing line | ticket D |
| P4 | scratch under run dirs + migration (folds FOC-602) | ticket E |
| P5 | journal per task + index generator + merge rule + contract line | ticket F |
| P6 | orphan scan by container identity | ticket G |
| P7 | `agent-tools allow/ask/deny` edits + Settings read-only panel | ticket H |
| — | FOC-730 (skill + contract lines + task-close prune + deny rules) runs alongside P1 | existing |

## 8. Acceptance criteria (evidence-based)

1. Two managed Supervisors started against one repo with three Backlog tickets: each claims a different ticket within
   one poll; the third stays unclaimed; Linear shows two "claimed by" comments; no `.state/` write outside the two run
   dirs during the run (watched by a test harness).
2. An unscoped session started while a managed session exists refuses to adopt and prints the scoped command.
3. `supervisor-merge` of two task journals from two sessions produces no conflict.
4. `fenix agent-tools show supervisor --json` lists every allow/ask/deny rule, every MCP server reachable through the
   allow list, and every skill directory; `check` exits 1 on an undocumented rule or a shrunk deny baseline.
5. A PLAN child spawned after P1 has `grilling` in its skills dir; the Supervisor's SessionStart shows it too.
6. Tests green beyond known reds, lint 0, Windows suite + Linux lane for every PR.

## 9. Risks

- Contract edits (`agents/**/CLAUDE.md`) are Mateusz-owned: only the lines named in Q4/Q5 are touched, each called out
  in its PR.
- Moving scratch changes paths the cockpit reads: the migration keeps a redirect map for one release.
- The lease adds a Linear write per claim: deterministic text, screened, idempotent.
