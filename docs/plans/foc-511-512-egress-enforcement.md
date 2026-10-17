# FOC-511 + FOC-512 — advisory to enforced: Linear helper denies and the PR-body egress screen

Owner: delivery owner (orchestrator), 2026-10-15. Branch `foc-511-deny-gap`, cut from `main` at #71.

## Problem

Two guards on the same axis are prose or prefix-only today:

- **FOC-511** — `SUPERVISOR_DENY` (`scripts/supervisor-lib.mjs:1472-1492`) cuts the Linear helpers only in launcher form (`Bash(node $LA_ROOT/scripts/linear-ops.mjs:*)`). A relative (`node scripts/linear-ops.mjs`), absolute (`node C:/…/linear-ops.mjs`), `cd … && node …` or `PowerShell(node …)` invocation walks past it; `PowerShell(node *)` is allow-listed in every squad; `scripts/linear-push.mjs` (the `createIssue` funnel) has no rule at all; `agents/test/settings.json:25` allows `mcp__linear__*` while dev and review deny it. Incident 2026-09-23: a test child made live mutations on FOC-450.
- **FOC-512** — the Supervisor's own `gh pr create` (`agents/supervisor/CLAUDE.md:175`) sends a title and body that only a convention-level CLI check (`docs/egress-screen.md:29-39`) screens. No hook, no wrapper, no test. The dashboard path (`scripts/publish-exec.mjs:177`) and every Linear chokepoint are already enforced in code — that is the pattern to mirror.

## Facts (recon 2026-10-15, Claude Code permissions doc read the same day)

- Bash rules match the whole command text; `*` matches any text at any position; `:*` is a trailing ` *`. Compound commands split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines; a deny applies when any subcommand matches, including subshells, substitutions and loop bodies. PowerShell rules have the same shape, are case-insensitive and canonicalise aliases. A rule does not match a different invocation form (`sh -c '…'`, `/usr/bin/curl`, `git -C . push`) — a documented residual; sandboxing or a PreToolUse hook is the real boundary.
- `buildChildSettings` (`supervisor-lib.mjs:1516-1524`) unions deny arrays only and writes a deny-only `child-settings-<id>.json`; P9 tests (`supervisor-spawn.test.mjs:570-667`) assert list membership, never matching.
- No rule matcher exists in the repo.
- `scripts/egress-screen.mjs` exports `scanEgress`, `assertEgressClean(text, label)` (throws `EgressBlockedError`, `code: EGRESS_BLOCKED`, message ends with `Blocked (first hit): <shape>`), CLI `check --body|--body-file` with exit 0/1/2.
- The Supervisor's `settings.json` allows `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`, `Bash(git push:*)` (`:126-128`) and read-only `gh pr view|list|checks|diff` (`:70-73`). No `gh` wrapper exists; `gh` is found on PATH.

## Design

### FOC-511 — deny every invocation form

1. `SUPERVISOR_DENY` grows, for each of `linear-ops.mjs`, `publish-linear-comment.mjs`, `linear-query.mjs`, `linear-push.mjs` and the new `gh-screened.mjs`:
   `Bash(node *<script>*)` and `PowerShell(node *<script>*)`. The launcher forms stay (provenance, harmless). The `node ` prefix keeps `cat`, `git diff`, `node --test scripts/<x>.test.mjs` and `node scripts/test-run.mjs <x>` out of the rule. The block comment names FOC-511 and the documented residual (`sh -c`, `node.exe`, wrappers).
2. `agents/test/settings.json`: the `mcp__linear__*` allow goes, a `mcp__linear__*` deny comes (TEST never talks to Linear; the Supervisor relays). `plan` keeps its allow — its push role goes through `linear-push.mjs`, and cutting MCP reads for PLAN is a separate decision (out of scope, noted for Mateusz).
3. `scripts/permission-rules.mjs` — a model of the documented matcher, used by tests and future drift checks, never as enforcement: `splitSubcommands(command)`, `matchesBashRule(rule, command)`, `matchesPowerShellRule(rule, command)`, `isDenied(denyList, tool, command)` (`tool` is `Bash` or `PowerShell`). The header links the doc and states that Claude Code is the enforcer.
4. Tests: `permission-rules.test.mjs` pins the doc's table rows and compound splitting; `supervisor-deny.test.mjs` runs `SUPERVISOR_DENY` through the model — for every helper the launcher, relative, absolute POSIX, absolute Windows, `cd x && …` and PowerShell (mixed case) forms are denied, while `node --test scripts/linear-ops.test.mjs`, `node scripts/test-run.mjs linear-ops`, `cat scripts/linear-ops.mjs` and `git diff -- scripts/linear-ops.mjs` are not. P9 grows a membership check for the new forms and a cross-file check that dev, review and test deny `mcp__linear__*`.

### FOC-512 — one screened path for PR text

5. `scripts/gh-screened.mjs <gh args…>`: for `pr create`, `pr edit`, `pr comment` it collects `--title/-t`, `--body/-b`, `--body-file/-F` (and `--flag=value` forms; a body file is read), runs `assertEgressClean(text, "gh <verb> title+body")` and only then spawns `gh` with the untouched argv (stdio inherited, exit code passed through). A hit prints the screen's message and exits 1 — `gh` is never started. `gh api`, `gh release`, `gh pr merge` (its `--subject/--body` is commit text, and merging is Mateusz's call; the raw verb keeps its ask gate) and unknown verbs exit 2 with a one-line reason; read-only `pr view|list|checks|diff|status` pass through unscreened. Short flags are parsed the way gh's pflag does (`-b X`, `-b=X`, `-bX`); a text flag the parser does not recognise fails closed. The `gh` command comes from `LA_GH_COMMAND` (JSON argv, default `["gh"]`) — the seam the test uses.
6. `agents/supervisor/settings.json`: allow `Bash(node *gh-screened.mjs*)`; the `Bash(gh pr create:*)` allow goes; deny `Bash(gh pr create*)`, `Bash(gh pr edit*)`, `Bash(gh pr comment*)`, `Bash(gh api*)` and the PowerShell twins. `gh pr merge` and `git push` stay as they are (no text content).
7. `agents/supervisor/CLAUDE.md` §push/PR: PR text leaves only through `node $LA_ROOT/scripts/gh-screened.mjs pr create …`; raw `gh pr create` is deny-listed; a refusal names the hit by shape — fix the body, never bypass. `docs/egress-screen.md:29-39` records that the chokepoint now exists; `docs/supervisor-e2e-checklist.md` AC-7 gains the screened-PR item and the FOC-511 note.
8. Children: `SUPERVISOR_DENY` denies the wrapper too (step 1), so a child cannot open a PR through it.
9. The FOC-733 residual deferred to FOC-512 (`docs/egress-screen.md`): the Linear issue-URL slug terminator class gains end of line and trailing `,` `.` `:` `;` so a slug closing a sentence or a line is no longer a false positive. The fail-closed gates stay: the full `linear.app/<ws>/issue/<KEY>/` prefix on the same line, the slug-shape gate (lowercase, digits, single hyphens), whitespace not a terminator. Accepted reach: a lowercase-alphanumeric run that rides a fabricated Linear URL in the slug position is exempt — accidental leakage never takes that shape.
10. Squad prose: `agents/{test,dev,review,plan}/CLAUDE.md` say that under a Supervisor every invocation form of the Linear helpers is denied and the Supervisor relays the write; standalone runs keep `--dry-run`.

## Acceptance

- `supervisor-deny.test.mjs`: every invocation form above is denied for all five scripts under the documented semantics; the negatives stay allowed.
- `gh-screened.test.mjs` (fake `gh` through `LA_GH_COMMAND`): a secret-shaped body never reaches `gh` — in `--body`, `--body-file`, `-b=…`, `-b…` and `-F=…` forms alike; a clean body reaches it with the exact argv; exit code passthrough; refused verbs (`api`, `pr merge`, `pr create --fill`) exit 2; read verbs pass through.
- Generated child settings carry the new forms (P9); `config-drift` stays green (no rule in both allow and deny of one file).
- Full Windows suite and the Linux lane green modulo the failures already fixed in #75.

## Out of scope

`mcp__linear__*` in `SUPERVISOR_DENY` (would cut PLAN children's MCP reads — Mateusz's call), wrapper forms (`sh -c`, `cmd /c`, `node.exe`), the orchestrator's `gh api` recipes in `agents/orchestrator/memory/` (prose for a generic worker outside the runtime), sandboxing.
