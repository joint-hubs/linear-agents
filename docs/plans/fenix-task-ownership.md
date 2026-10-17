# Task ownership — a Supervisor acts only on tickets its installation owns (FOC-848)

Status: in progress (2026-10-15). Owner: orchestrator session. Linear: FOC-848 (parent FOC-768).

## Problem

Since 2026-10-15 the Fenix project is delivered by the orchestrator session while the
native Supervisor keeps serving other products (JW, WSKM) from the same checkout. The
Supervisor's queue is prose (`docs/STATE.md`, `docs/ROADMAP.md`) and its contract says
"go down the queue"; nothing in the toolchain knows *who owns which ticket*. A ticket
taken by the wrong owner means two actors on one branch and one Linear issue.
Mateusz: "każde dziecko powinno być sterowane przez swojego supervisora i nie powinno
być problemu z braniem cudzych tasków — musimy to teraz naprawić."

Recon (2026-10-15): no Linear `project` field is fetched anywhere (`linear-query.mjs`
`ISSUE_DETAIL_QUERY`, `linear-client.mjs resolveIssue`); `supervisor-triage record`
never re-reads the issue; `supervisor-spawn` validates only the `--task` shape and the
*existence* of `triage.json`; `linear-ops` write verbs resolve the issue first and have
no gate; holds (`holds.json`, FOC-612) reach Mateusz via `supervisor-gate list --open`,
the turn-end guard and the Cockpit, but `supervisor-status --briefing` does not list them.

## Design

**Ownership config** (fail-closed loader, same pattern as `autonomy-grants.mjs`):

```json
{ "version": 1,
  "owners": { "orchestrator": { "linearProjects": ["<project id or exact name>"] },
              "supervisor":   { "linearProjects": ["…"] } },
  "unlisted": "allow" | "ask" }
```

Precedence: `LA_TASK_OWNERSHIP_CONFIG` (file, tests) > settings overlay key `ownership`
(`.fenix/config/settings.json`, survives `fenix update`) > shipped
`config/task-ownership.json` (`owners: {}`, `unlisted: "allow"` — a fresh install has one
Supervisor and behaves exactly as today). Malformed config → named error, no action.

**Acting owner**: `LA_TASK_OWNER` (`/^[a-z][a-z0-9-]{0,31}$/`), default `supervisor`.
The orchestrator sets `LA_TASK_OWNER=orchestrator` when it uses the Supervisor
toolchain (e.g. the FOC-477 arm-A launcher). Children inherit the value from spawn.

**Verdicts** (`scripts/task-ownership.mjs checkOwnership(issue, {owner, config})`):
`unrestricted` (no owners configured) · `owned` · `foreign` (project listed under another
owner — never allowed) · `unlisted` (no owner lists it — `allow` passes, `ask` holds).
A missing project on a restricted install is treated as `unlisted`.

**Enforcement points**
1. `supervisor-triage propose|record` — `record` loads the issue (or `--issue-file`),
   refuses `foreign`/`unlisted+ask` with `ownership-<verdict>`, writes **no** triage.json,
   and records a hold (origin `ownership`, idempotent per run+issue). An allowed verdict
   is stamped into triage.json as `ownership: {owner, verdict, project}`.
2. `supervisor-spawn` — on a restricted install it requires triage.json to carry an
   ownership stamp for the same `--task` and the same owner; otherwise
   `ownership-unverified` (no child). Unrestricted installs keep today's behaviour.
3. `linear-ops` write verbs (transition, label, comment, comment-replace,
   update-description, estimate, priority, due-date, placement, create-child) — after the
   issue is resolved, `foreign`/`unlisted+ask` refuse with the same error unless
   `--owner-override` (Mateusz, by hand). `publish-linear-comment` inherits the gate.
4. The issue payloads the gate reads gain `project { id name }` — `linear-query issue`
   (`ISSUE_DETAIL_QUERY`, which also gains `team { id key name }`) and
   `linear-client resolveIssue` (direct and search fallback). The `issues`/`search`
   listings are unchanged: no enforcement point reads them.
5. `supervisor-status --briefing` lists open `holds.json` holds (count, id, origin,
   question) so an ownership refusal is visible next to pending gates.
6. `agents/supervisor/CLAUDE.md`: one contract line — a refused ticket is not yours;
   present the hold and continue with the next ticket of your own projects.

**Mateusz's install**: Fenix project → `orchestrator`; JW and WSKM → `supervisor`;
`unlisted: "ask"`. Applied with `node scripts/fenix-settings.mjs set ownership …` on the
main checkout (and on the VM after `fenix update`). The running Supervisor picks the rule
up on its next `supervisor-triage`/`spawn` call — no restart, nothing killed.

## Acceptance (tests)

AC1 foreign ticket: `record` exits 1 with `ownership-foreign`, writes a hold, no
triage.json; `spawn` refuses. AC2 owned ticket passes unchanged; unlisted project held
with `ask`, passes with `allow`. AC3 fresh install (no overlay) — every existing test
unchanged. AC4 the hold appears in `--briefing` and the Cockpit Needs-you.

## Out of scope

Per-ticket assignment (Linear assignee), multi-user auth, moving the queue out of prose.
