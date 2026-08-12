---
type: prd
status: active
maturity: v2
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/development]
---

# PRD — Development squad

<goal>
Linear issue → reviewed, committed change. Squad orchestrates via lead (pick + delegate + hand-off), 
with recon, implementer, refactorer, debugger. One WIP at a time (enforced).
</goal>

<squad_table>
| Sub-agent | Model | Routing | Responsibility |
|---|---|---|---|
| **lead** | — | orchestrator | Pick (Backlog+dor-ok), delegate phases, hand-off to In Review |
| **recon** | minimax-m3 | context packet | Analyze task + code → files, patterns, risks |
| **implementer** | glm-5.2 | standard code | ENTIRE edit→build→test→commit cycle (one delegation) |
| **refactorer** | kimi-k2.7-code | multi-file / MCP | Multi-file, complex refactoring, tool-intensive |
| **debugger** | deepseek-v4-pro | hard / arch decision | Failed builds, architecture issues, escalations |
| **worker** | minimax-m3 | simple | Single-file, boilerplate (fallback for simple changes) |
| **flash** | deepseek-v4-flash | mechanical | Extraction, formatting, checklists (fallback) |
</squad_table>

<runtime>
Full loop spec: [`agents/dev/CLAUDE.md`](../../agents/dev/CLAUDE.md) (runtime source of truth).
Readable spec: [`docs/agents/agent-2-dev.md`](../agents/agent-2-dev.md) (for humans/LLMs).
This PRD governs build steps, acceptance criteria, and launchers only. Do NOT re-explain the full loop here.
</runtime>

<build>
**Paths:**
- `agents/dev/CLAUDE.md` — full loop (source of truth)
- `agents/dev/agents/{recon,implementer,refactorer,debugger,worker,flash}.md` — role definitions
- `bin/dev.bat` — launcher (live)
- `bin/dev-dry.bat` — launcher (DRY-RUN fixture mode)
- `scripts/dev-branch.mjs` — branch orchestration
- `scripts/linear-query.mjs` — Linear read (fixture-aware)
- `scripts/linear-ops.mjs` — Linear write (dry-run-aware)
- `scripts/publish-linear-comment.mjs` — hand-off comment

**Smoke test:**
```bash
bin\dev-dry.bat
```
Runs full loop on fixture `.state/mock/dev-task.json`; no API, no real branches, no git push.
Expected: completes cleanly, logs "DRY-RUN" markers, exits.
</build>

<acceptance_criteria>

**Workflow:**
- [ ] WIP=1: never pick while one is In Progress. Resume via `.state/dev-wip.json` when blocked (needs:answer/approval).
- [ ] Pick: `dor-ok` label + Backlog status only. Skip unfinished blockers. Smallest estimate.
- [ ] Start: transition to In Progress, label ai:coded, branch off main.
- [ ] Phases delegated in full: 3a recon → 3b ONE implementer (edit+build+test+commit in one call) → 3c debugger once if red → escalate if still red.
- [ ] Implementer returns: summary, file list, test tail (≤15 lines), commit hash, open questions. Do NOT require you to re-run tests.
- [ ] Debugger (if needed): reproduces failure, fixes, commits. If still red: escalate + needs:answer + WIP exit.
- [ ] Lead spot-check: max 2 cheap commands (e.g., `git log -1 --stat`). Budget drains apply — see agent-2-dev.md.
- [ ] Hand-off: summary markdown → commit on branch → publish-linear-comment.mjs → transition to In Review. Keep ai:coded label.
- [ ] NEVER git push without explicit Mateusz consent.
- [ ] NEVER attach secrets/tokens/passwords to Linear comments.
- [ ] DRY-RUN mode (`DEV_DRY_RUN=1`): fixture only, no API, no real state changes, no branches, exits cleanly.

**Safety:**
- [ ] Tool-call fail → retry → escalate. 2 failures → escalated + needs:answer (step 3c).
- [ ] Linear API only via `node $LA_ROOT/scripts/linear-*.mjs`; no `mcp__linear__*` tools (headless failure).
- [ ] Hand-off must include "how to test" for REVIEW phase.

</acceptance_criteria>

<launchers>

### Live (Backlog → In Review)
```bat
bin\dev.bat
```
Picks ONE task from Backlog (dor-ok), creates branch, delegates to recon→implementer→debugger (if needed),
commits on branch, publishes hand-off comment, transitions to In Review. No git push.

### Dry-run (fixture mode)
```bat
bin\dev-dry.bat
```
Environment: `DEV_DRY_RUN=1`.
Runs full loop on fixture `.state/mock/dev-task.json`. No API calls, no real branches, no state changes in Linear.
Verify: log output includes "DRY-RUN", exits cleanly.

### Single role (debug/targeted)
```bat
bin\agent.bat dev <role>
```
Examples:
```bat
bin\agent.bat dev recon
bin\agent.bat dev implementer
bin\agent.bat dev debugger
```
Runs single role in session. Use for testing/debug only.

</launchers>

<rationale>

**Why delegation-first?**
Lead turn (~90k context) is 3–20× more expensive than fresh subagent. Recon+implementer+debugger cycles
are designed to minimize lead involvement to 2–3 cheap commands (spot-check).

**Why ONE implementer call?**
Implementer runs edit→build→test→commit in one delegation. This avoids context thrashing: you do not wait
for partial results, re-read code, re-run commands. Implementer owns the cycle and returns pass/fail + commit hash.

**Why WIP=1?**
Enforces serial execution: pick, execute, hand-off, then pick next. Prevents interleaving, simplifies
state tracking via `.state/dev-wip.json`. Resume on blocker (needs:answer) instead of polling.

**Why no Linear MCP?**
Headless failures with `mcp__linear__*` tools. Node scripts are reliable, deterministic, and dry-run-aware.

**Why DRY-RUN?**
Smoke test the entire loop (pick→recon→implementer→hand-off) without touching Linear or git.
Fixture-driven: all queries hit `.state/mock/dev-task.json` instead of API. Safe to run repeatedly.

</rationale>
