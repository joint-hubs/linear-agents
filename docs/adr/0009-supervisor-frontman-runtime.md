# ADR-009: Frontman supervisor runtime — internal bus, headless Claude children, file-based HITL relay

**Status:** Proposed

**Date:** 2026-08-18 (spec_review loop 1 folds: single resume path, amend-not-append squad rules, watcher/liveness, script-level settings merge, post-hoc cost cap, deny≠sandbox)

## Context

FOC-116 introduces a **frontman supervisor**: Mateusz talks only to the Supervisor agent; the Supervisor triages one Linear issue, launches PLAN/DEV/REVIEW/TEST children, watches them, and relays all HITL. GATE 1 (2026-08-18, `planning/briefs/gate1-foc-116-answers.md`) locked: children are **second Claude OS processes** running the existing squad configs; the Orchestrator stays beside, untouched; MVP is a full e2e on one issue; push/PR only after Mateusz says yes.

Three runtime questions remained open and were researched (`planning/briefs/research-foc-116-a2a-and-spawn.md`):

- **Protocol:** Google A2A is an open peer-to-peer protocol for *opaque remote agents* (Agent Card discovery, Task lifecycle over HTTP/JSON-RPC/SSE/gRPC). It does not specify process spawn, TTY/PTY, or stdio, and its own guidance says not to use it when the callee is a local capability with a well-defined invoke. A local `claude` child shares filesystem, env, and lifecycle with the Supervisor.
- **Process model:** Claude Code headless (`claude -p`, `--output-format stream-json`, `--resume <session_id>`, `--permission-mode`, `--settings`) covers spawn, live output, and follow-ups. Alternatives (Agent Teams experimental flag, Managed Agents hosted, `claude agents` TUI) either are experimental/hosted or put Mateusz back into a child-facing UI.
- **HITL:** today squad gates (PLAN GATE 1/2, DEV questions) assume a human in *that* REPL. Frontman forbids that; unattended children must not block on a TTY nobody watches.

## Decision

**A — Protocol: internal thin bus, no A2A on the wire in MVP.** Communication between Supervisor and children is (1) the child's `stream-json` NDJSON event stream teed to `.state/supervisor/<run>/children/<childId>.jsonl`, (2) a JSON child registry, and (3) file-based gate records. Records keep Task/Artifact-shaped fields (`id`, `status`, `artifacts[]`, `session_id`, `ts`) so an A2A adapter can be added later without touching squads. No A2A HTTP/JSON-RPC server or client is built.

**B — Process model: existing squad configs driven headless.** Children are spawned by in-repo scripts (`scripts/supervisor-*.mjs`) as:

```
CLAUDE_CONFIG_DIR=agents/{plan,dev,review,test} \
LA_SUPERVISOR=1 LA_SUPERVISOR_RUN=<run> LA_SUPERVISOR_CHILD=<id> LA_TASK_ID=<issue> \
claude -p "<kickoff>" --output-format stream-json --verbose \
       --permission-mode bypassPermissions --settings <generated child-settings.json>
```

Follow-ups re-invoke with `claude -p "<message>" --resume <session_id>` (one process per turn; the `session_id` from the `system/init` event is the child's durable identity). The generated `child-settings.json` carries `permissions.deny` for `git push` / `gh pr create` / `gh pr merge` / `gh release create` / `gh api`, so the push gate is harness-enforced; after Mateusz approves, the Supervisor executes the push itself. The spawn script merges the squad's own `settings.json` denies into the generated file itself (union, deny wins) — we do not rely on undocumented precedence between `CLAUDE_CONFIG_DIR`-provided settings and `--settings`.

Liveness is owned by a **detached watcher process** per spawned turn: it waits on the child pid and on exit updates the registry (`exited`/`crashed`, `exitCode`, `endedAt`) and ends the telemetry run. Status tooling reads the registry and tee only — it never probes or invents liveness. Stop is graceful-then-force; on win32 always a process-tree kill (`taskkill /PID <pid> /T [/F]`). Children run with cwd = the issue's project repo root (as today's squad bats); no worktree isolation in MVP, and spawn refuses a second issueId while another child is running on the same cwd. BAT launchers are not used for children (scripts are the spawn path); `bin/supervisor.bat` exists only for the interactive frontman session.

**C — HITL relay: structured gate records, file is source of truth.** A child running with `LA_SUPERVISOR=1` never waits for a human in its own REPL and never uses async `needs:*` walk-away. It writes a gate record (`.state/supervisor/<run>/gates/<gateId>.json` via `scripts/supervisor-gate.mjs emit`, kinds `plan.gate1|plan.gate2|question|push-approval|pr-approval`, validated — unknown kinds rejected) and **ends its turn**. The Supervisor presents the gate; Mateusz answers the Supervisor; the Supervisor delivers the answer via `supervisor-followup.mjs --resume`. A Linear `needs:*` mirror is explicitly out of MVP.

Under supervision there is exactly ONE resume path per child: Supervisor `--resume <session_id>`. DEV's existing `needs:*` + `.state/dev-wip.json` + next-`dev.bat` resume is disabled (no Linear labels set, no next bat); the wip file survives only as a local crash checkpoint. Squad CLAUDE.md files are **amended, not just appended to**: rules that mandate a synchronous human in the TTY (PLAN `<plan_hard_rules>`, `<plan_loop>` GATE 1/2; DEV `needs:*` resume) gain an "unless `LA_SUPERVISOR=1`" rider so no rule contradicts supervised mode.

## Consequences

- **Positive:**
  - Zero new runtime infrastructure: spawn/tail/resume are thin wrappers over documented `claude` headless flags; state is plain JSON/NDJSON under `.state/supervisor/`, resumable after a Supervisor crash.
  - Squads keep their configs, scripts, and loops; the child-side change is one appended "Supervised mode" section plus explicit "unless supervised" riders on contradictory rules in four CLAUDE.md files.
  - Mateusz has exactly one window; P9 (push/PR approval) is enforced by harness deny-rules, not prompt discipline.
  - Concurrent children are trivial (independent processes, per-child session ids); a finished DEV stays resumable while REVIEW runs.
  - Task/Artifact-shaped records keep the A2A migration path open without paying for a server now.
- **Negative:**
  - Follow-up = full process re-invocation with `--resume` (context reload cost per turn); no persistent stdin chat into a live child — mid-turn steering is not possible, only turn-boundary steering.
  - `bypassPermissions` for children is a wide grant on Mateusz's machine; mitigations (deny-rules, push gate, tee audit) reduce but do not eliminate the risk. Deny-rules are Claude-settings enforcement, not a sandbox — `cmd /c`, `powershell`, `git -C <path>`, or wrapper scripts bypass them; the human push-approval gate is the real control. Must be revisited before any non-local/multi-machine use.
  - Polling/reading tees instead of a true event bus; fine at one-Supervisor scale. The lead waits via `supervisor-status.mjs --wait --timeout-ms` (default 120 s, `LA_SUPERVISOR_POLL_MS`); the tee-inactivity ("stalled") threshold IS that same timeout — 5 consecutive silent waits count against **wall-clock** (5 × 120 s = 600 s ≈ 10 min) regardless of backoff multipliers, so the kill SLA is invariant under backoff.
  - The cost cap (`LA_SUPERVISOR_MAX_COST_USD`, one number including the Supervisor lead's own cost) is post-hoc: it trips on `result` events at turn boundaries, so one turn can overshoot before the cap fires (accepted residual).
- **Risks:**
  - `--resume` semantics or stream-json shape changes in future Claude Code versions → pin behavior via the mock-binary tests (`scripts/supervisor-*.test.mjs`); fallback is respawn-with-summary.
  - Children that ignore the supervised-mode section and block on a prompt appear as stalled turns → Supervisor detects via tee inactivity (threshold = the `status --wait` timeout, one shared number) and stops/escalates.
  - A squad CLAUDE.md rule that contradicts supervised mode is missed in the amendment sweep → child behavior undefined at gates; mitigated by listing every touched rule in the PR and by the e2e gate-relay check (AC-5).
  - Gate file as sole source of truth means no Linear-visible audit of gates in MVP → accepted; mirror can be added later without schema change.

## Alternatives Considered

1. **A2A HTTP/JSON-RPC between local agents** — rejected: designed for opaque remote peers; specifies no process spawn/TTY semantics; Agent Card discovery adds nothing on one machine; official guidance routes local capabilities to tool/MCP-style invocation instead.
2. **Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) as the only path** — rejected for MVP: experimental flag; unverified that it loads `CLAUDE_CONFIG_DIR=agents/<squad>` the way our launchers rely on; couples MVP to a moving target. Re-evaluate when stable.
3. **Managed Agents (hosted multiagent)** — rejected: hosted sandbox threads, not our local squad CLAUDE.md files, Linear scripts, or telemetry.
4. **`claude --bg` + `claude agents` TUI** — rejected: puts Mateusz into a child-facing TUI, violating the sole-interlocutor GATE 1 decision.
5. **Extend the Orchestrator / Atlas MCP bridge (`agent_spawn`)** — rejected: GATE 1 keeps the Orchestrator beside as a generic worker; the bridge is fire-and-collect with no live tail and no turn-boundary follow-up into a child session.
6. **In-process Task subagents only** — rejected: violates the locked "second Claude OS process" decision and bills child context into the Supervisor's session.