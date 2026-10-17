# Supervisor permissions audit — 2026-10-16

Ticket FOC-900 (P1-B of epic FOC-898), decision Q7 of `docs/prd/multi-supervisor-isolation-prd.md`: Mateusz widened the
Supervisor's allow list on purpose and does not want it narrowed. This note records what the list is, where it came
from, and the facts worth knowing. It proposes no removals.

## Scope and method

- File: `agents/supervisor/settings.json` (the native `CLAUDE_CONFIG_DIR`; the Docker session claude-dir is seeded from
  the same file).
- Working tree vs HEAD: no uncommitted edits (2026-10-16, `git status` clean).
- Diff against the 2026-09-22 baseline `3e7e099` (`git diff 3e7e099 HEAD -- agents/supervisor/settings.json`): only two
  kinds of change since then — `cleanupPeriodDays: 36500` (FOC-780, `080aca7`) and the hook blocks (`SessionStart`
  briefing + session hook, `Stop` guard + waker + session hook, `UserPromptSubmit`, `Notification`, `PostToolUse`,
  `SessionEnd`; FOC-609 `8fa0b1b`, wake `1b12699`, FOC-795 `f0cb9f7`, FOC-783 `08f5d65`). **No permission rule changed
  after 2026-09-22.**
- The permission lists themselves come from FOC-385 (2026-09-19): `7a6d0e0` "widen squad and supervisor allowlists from
  measured usage" (66 Supervisor sessions, ~76 % of 12 039 shell calls outside the list, 757 prompted edits) and
  `3e9bdab` "allow cd/export/git -C and venv pythons" (chains like `cd <repo> && node …` blocked 2 603 Supervisor calls
  because every subcommand of a chain must match). Both commits are Mateusz's measured decisions, not drift.
- Claude Code behaviour below is quoted from the official permissions documentation (code.claude.com, read 2026-10-16).

## The lists today

| list | count | content |
|---|---|---|
| allow | 122 | `Read`, `Grep`, `Glob`, `Write`, `Edit`; `Bash(node:*)`, python/py/venv interpreters; read-only shell (`ls`, `cat`, `grep`, `rg`, `find`, `jq`, `sed -n`, …); `mkdir`, `tee`; read-only git + `git -C * <read-only>`; `git add/commit/branch/fetch/merge/switch/worktree add`; read-only `gh pr/run/issue` views; read-only `docker`; `cd`, `export`, `set`, `true`; `mcp__codegraph__*`, `mcp__fenix-decision-*`; a small read-only PowerShell set |
| ask | 8 | `git push`, `gh pr create`, `gh pr merge`, `git reset --hard`, `git clean`, `git branch -D`, `rm -rf`, `WebFetch` |
| deny | 8 | `mcp__linear__*`, `mcp__claude_ai_Linear__*`, `Artifact`, `PushNotification`, `ListAgents`, `Monitor`, `git worktree remove`, `git worktree prune` |

`additionalDirectories`: `C:/Users/mateu/Documents/GitHub` (every repo the Supervisor fronts, including the worktrees
root) and `C:/Users/mateu/Desktop/experiments`. `defaultMode: default`.

## Findings (facts, no action required)

1. **Compound helpers are not a bypass.** `Bash(cd:*)`, `Bash(export:*)`, `Bash(set:*)` were suspected of letting
   `cd x && git push` slip past `ask`. The docs: "Claude Code is aware of shell operators … A rule must match each
   subcommand independently", and ask/deny rules "apply when any subcommand matches them, including a command nested
   inside a subshell, a command substitution, or a control-flow body". So `cd … && git push` still asks.
2. **Overlaps resolve in the safe direction.** allow `Bash(git branch:*)` + ask `Bash(git branch -D:*)`: "a matching
   ask rule prompts even when a more specific allow rule also matches the same call" — deny > ask > allow. The
   `agent-tools check` verb reports such pairs as warnings so a future edit cannot flip them unnoticed.
3. **Interpreter rules make `ask` a command-text guard, not a boundary.** `Bash(node:*)`, `Bash(python:*)`,
   `PowerShell(node *)` … are needed for every Fenix script, and the docs are explicit that a Bash rule "isn't a
   security boundary around the program": code run through node or python is not covered by ask/deny rules written for
   other commands, and Read/Edit deny rules "don't apply … to arbitrary subprocesses that read or write files
   indirectly, like a Python or Node script". The real guards for the Supervisor are therefore the contract
   (`agents/supervisor/CLAUDE.md`), the screened wrappers (`linear-ops.mjs`, `gh-screened.mjs` in PR #77) and the
   sandbox, not the `ask` list. This is the same trade-off FOC-385 accepted; nothing changed.
4. **`tee` and redirects are checked by Claude Code itself** against Edit rules, protected paths and the working
   directories (v2.1.257+/v2.1.269+), so `Bash(tee:*)` does not widen writes beyond what `Write`/`Edit` already allow.
5. **Deny list is small by design.** Children get the wide `SUPERVISOR_DENY` (push, PR create/merge/release, worktree
   remove/prune, the Linear CLIs) through `buildChildSettings`; the Supervisor itself keeps push/PR behind `ask`, which
   is the intended human-in-the-loop point. `agent-tools check` pins `SUPERVISOR_DENY` to a baseline so it can only
   grow.
6. **Wide `additionalDirectories` is intentional** (the Supervisor fronts JW and WSKM next to Fenix). In Docker the
   paths do not exist and are inert.

## Verdict

Nothing worrying. The list is the FOC-385 measurement, unchanged since 2026-09-22; the four behaviours above are
documented Claude Code semantics. The one thing to keep in mind when adding rules: an `ask` entry only guards the
literal command form (see finding 3), so anything that must hold against a script goes into a deny on the wrapper plus
the contract, as FOC-511/FOC-512 do.

Regenerate the machine view any time with `node scripts/agent-tools.mjs show supervisor` and `… check`;
`docs/agent-tools.md` is the rendered table.
