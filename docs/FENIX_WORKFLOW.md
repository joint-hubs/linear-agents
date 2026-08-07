
<fenix_canonical_workflow_file_description>
Single source of truth for how a Fenix squad session runs. 
</fenix_canonical_workflow_file_description>

<fenix_definition>
Fenix is an **AI orchestration system** that manages software delivery across
multiple repositories through **5 specialized squads** of LLM agents, coordinated
via **Linear** as the async signaling bus.

**Key properties:**
- **Async HITL** via Linear metadata (labels, comments, emoji reactions) — never
  blocks on interactive chat.
- **5 squads** run in isolation (separate `.bat` launchers, separate
  `CLAUDE_CONFIG_DIR`, separate model routing).
</fenix_definition>

<linear_statuses>
Fenix uses exactly **4 workflow statuses**. Sub-states like "Ready" and
"Testing" are encoded as labels, not statuses.

| Status          | Type      | Meaning                                                                      |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| **Todo**        | unstarted | Task exists, not yet picked up. May be unprioritized (backlog) or DoR-ready. |
| **In Progress** | started   | Actively being worked on by a squad.                                         |
| **In Review**   | started   | Handed off for review. May be under review or in testing sub-phase.          |
| **Done**        | completed | All DoD criteria met.                                                        |
| **Canceled**    | canceled  | Abandoned or superseded.                                                     |

</linear_statuses>

<linear_labels>

| Group        | Values                                        | Direction         | Meaning                                                                                                                           |
| ------------ | --------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`type:`**  | `feature` · `bug` · `spike` · `tech`          | PLAN → all        | Routes squad behavior. `spike` → ADR output, no deploy, timebox 1–2d. `tech` → technical success criteria, no user-journey check. |
| **`needs:`** | `answer` · `approval` · `decision` · `access` | **agent → human** | "Waiting on Mateusz." This is the HITL queue.                                                                                     |
| **`risk:`**  | `high`                                        | agent → human     | Risky change → deeper review (GLM-5.2 deep pass).                                                                                 |
| **`ai:`**    | `planned` · `coded` · `reviewed`              | provenance        | AI-touched → higher review sampling. Non-exclusive (multi).                                                                       |
</linear_labels>


<git_convention>
### Commit Message Format

```
<prefix>(<area>): <short description> [<uuid-first-8>] [<linear-id>]

- Bullet point of what changed
- Bullet point of second change
- Bullet point of third change
```

**Prefixes** (match task type):

| Prefix        | When                             |
| ------------- | -------------------------------- |
| `feat(area):` | New feature (type:feature)       |
| `fix(area):`  | Bug fix (type:bug)               |
| `refactor:`   | Refactor / tech debt (type:tech) |
| `test:`       | Tests only                       |
| `chore:`      | Config, deps, release bump       |
| `docs:`       | Documentation                    |
</git_convention>


<lead_action_deliver_task>

`deliver_task` is the **canonical handoff action** that moves a task from
active development to review. Every squad lead calls it when their work on a
task is complete.

### Signature

```
deliver_task(
  task_id: string,
  actual_hours: float,
  delivery_summary: string
) → void
```

### Behavior

1. **Validates DoD**: checks that the task's DoD checklist items are met. If
   not, logs a warning but does not block (the REVIEW squad will catch gaps).
2. **Records effort**: writes `actual_hours` to the task (estimate field or
   comment).
3. **Sets status**: moves task to **In Review**.
4. **Sets labels**: adds `ai:coded` (DEV), or `ai:reviewed` (REVIEW), or
   appropriate provenance label.
5. **Posts summary**: adds a comment with the `delivery_summary` in Polish
   (for Mateusz) and English (for record).
6. **Clears `needs:*`**: if the squad lead was waiting on input, clears the
   needs label.

### Per-Squad Notes

| Squad | When to call | `actual_hours` source | `delivery_summary` includes |
|---|---|---|---|
| **PLAN** | After push to Linear | Time spent on discovery→decompose | Brief quality, # sub-issues created, estimates, open questions |
| **DEV** | After commit + self-test | Coding + debugging time | What was implemented, test results, how to test |
| **REVIEW** | After approve verdict | Review time | Findings count, severity, what passed/failed |
| **TEST** | After deploy + tests pass | Deploy + test time | Deploy URL, test results, health-check status |
| **CADENCE** | N/A (read-only) | — | — |

</lead_action_deliver_task>

<lead_action_run_session>
## 5. Canonical Squad Session Loop (8 Steps)

Every Fenix squad follows this loop. Steps 1–7 are sequential; step 8 loops
back or stops.

```
┌─────────────────────────────────────────────────────────┐
│  1. get_initiative_board()     — load board, cycles, WIP │
│  2. pick_next_task()           — dep-aware, WIP=1        │
│  3. update_status(In Progress) — claim the task          │
│  4. read_context(recon)        — code + context packet   │
│  5. implement()                — squad-specific work     │
│  6. commit(one-task)           — single commit per task  │
│  7. deliver_task()             — handoff to In Review    │
│  8. → next task or stop        — loop or exit            │
└─────────────────────────────────────────────────────────┘
```

</lead_action_run_session>

<lead_action_run_session_step_1>
**Step 1 — get_initiative_board()**
- Load the initiative's kanban board from Linear.
- Read issue (task) and analyze its parents if available.
- Identify tasks in Todo (candidates), In Progress (active), In Review (blockers).
</lead_action_run_session_step_1>

<lead_action_run_session_step_2>
**Step 2 — pick_next_task()**
- Filter to Todo tasks with `dor-ok` (DoR-ready).
- Sort by Priority (Urgent → High → Med → Low), then by deadline.
- **Dependency-aware**: skip tasks whose `blocked by` relations are not
  resolved. Skip tasks with `blocked` flag.
- **WIP=1**: pick exactly one task. Do not start a second until the first is
  delivered.
- **Size gate**: if estimate is XL (>2 days), flag for re-decomposition before
  starting.
</lead_action_run_session_step_2>

<lead_action_run_session_step_3>
**Step 3 — update_status(In Progress)**
- Set status to In Progress.
- Add `ai:coded` label (or appropriate provenance).
- Write a 👀 reaction comment: "Taking this task."
</lead_action_run_session_step_3>

<lead_action_run_session_step_4>
**Step 4 — read_context(recon)**
- Read the task description, AC, and linked resources.
- Read the relevant code files (never modify unread code).
- Build a **context packet**: key files, patterns, env state, test structure.
- Check env readiness (docker compose, seed data, dependencies).
- If anything is unclear → post `needs:answer` + @Mateusz in Polish → **sleep**
  (do not guess).
</lead_action_run_session_step_4>

<lead_action_run_session_step_5>
**Step 5 — implement()**
- Squad-specific work (see §5.1 below).
- Checkpoint progress to `STATE.md` every ~4 hours or per logical slice.
- For unclear decisions → `needs:decision` + sleep.
- For risky changes → add `risk:high` label.
</lead_action_run_session_step_5>

<lead_action_run_session_step_6>
**Step 6 — commit(one-task)**
- `git add` only the files changed for this task.
- Commit with the format from §3.
- **Never `git push` without explicit approval** (safety rule).
</lead_action_run_session_step_6>

<lead_action_run_session_step_7>
**Step 7 — deliver_task()**
- Call `deliver_task(actual_hours, delivery_summary)` as defined in §4.
- Task moves to In Review.
</lead_action_run_session_step_7>

<lead_action_run_session_step_8>
**Step 8 — next or stop**
- If more tasks are available and within session budget → go to step 1.
- If session time limit reached, cost budget exceeded, or no suitable tasks →
  stop. Write final STATE.md update.
</lead_action_run_session_step_8>

<lead_action_run_variations>

| Aspect                   | PLAN                                          | DEV                         | REVIEW                          | TEST                              | CADENCE                         |
| ------------------------ | --------------------------------------------- | --------------------------- | ------------------------------- | --------------------------------- | ------------------------------- |
| **Cadence**              | On demand (voice memo)                        | On demand (task ready)      | On demand (task in review)      | On demand (task approved)         | Weekly (cron)                   |
| **Step 5 = implement()** | Discovery → spec → decompose → push to Linear | Code the feature/fix        | Review code (3 parallel passes) | Deploy + run tests                | Collect state → retro → digest  |
| **Input**                | Voice memo + artifacts                        | Task in Todo with `dor-ok`  | Task in In Review               | Task with `stage:testing`         | Linear board state              |
| **Output**               | Parent epic + sub-issues in Todo              | Branch + commit + In Review | Verdict: approve or return      | Done or return to In Progress     | Digest (PL) to Mateusz          |
| **Read-only?**           | No                                            | No                          | **Yes** (no Edit/Write)         | Mostly no                         | **Yes** (no scope changes)      |
| **HITL gates**           | 2 (brief approve, sample approve)             | 1 (plan approve)            | 0 (async if escalated)          | 0 (auto-rollback on fail)         | 0 (proposal only)               |
| **Key model**            | Opus (lead), MiniMax (discovery)              | GLM-5.2 (lead/impl)         | GLM-5.2 (deep), Kimi (security) | MiniMax (lead), DeepSeek (deploy) | MiniMax (lead), GLM-5.2 (retro) |
</lead_action_run_variations>

<lead_action_escalation>
When an agent hits a problem it cannot resolve:

```
Step 1: Retry (same model, same approach)
  ↓ (fails again)
Step 2: Escalate model
  ├─ MCP/multi-file issues → Kimi K2.7 Code
  └─ Reasoning/hard problems → Opus 5
  ↓ (still fails)
Step 3: needs:* + @Mateusz (comment in Polish) + escalated flag
  ↓
Step 4: STOP — wait for human
```

**Review loop limit:** Max 2 review rounds between DEV and REVIEW. After 2
rounds without convergence → `escalated` + @Mateusz. The REVIEW squad lead
tracks the round counter on the task.

</lead_action_escalation>

<definition_of_ready>
Entry Gate
A task must pass DoR before DEV picks it. The PLAN squad (or a lightweight
validator) checks:

- [ ] **Why**: Business rationale or user need stated.
- [ ] **Acceptance Criteria**: At least 1–3 concrete, testable criteria (Given/
      When/Then preferred).
- [ ] **Scope-out**: What is explicitly NOT in scope.
- [ ] **Dependencies**: `blocked by` relations set, or explicitly "none."
- [ ] **Type**: `type:*` label set (feature/bug/spike/tech).
- [ ] **Estimate**: T-shirt size set. XL → re-decompose.
- [ ] **Parent**: Linked to an Initiative (outcome).

**Pass** → add `dor-ok` flag. Task is pickable by DEV.
**Fail** → add `needs:answer` + @Mateusz with specific gaps. Do not set `dor-ok`.
</definition_of_ready>

<definition_of_done>
Exit Gate

A task must pass DoD before moving to Done. The REVIEW squad (or the squad
closing the task) checks:

- [ ] **AC met**: All acceptance criteria verified (by review or test).
- [ ] **Code committed**: Single commit per task, proper message format.
- [ ] **Tests pass**: Unit + integration tests green (for code tasks).
- [ ] **Lint/type check**: Clean on changed files.
- [ ] **Deploy health**: Health-check passed (for deployable tasks).
- [ ] **No regressions**: Existing tests still pass.
- [ ] **ADR emitted**: If architectural decision was made, `docs/adr/NNNN.md`
      exists.
- [ ] **STATE.md updated**: Session state documented for resume.

**Pass** → add `dod-ok` flag → set status to Done.
**Fail** → return to In Progress with specific gaps listed.

</definition_of_done>

<safeguards>
These are requirements before any squad runs autonomously. Enumerate
here; each squad's CLAUDE.md expands the implementation.

| #   | Safeguard                | Mechanism                                                                    | Squad        |
| --- | ------------------------ | ---------------------------------------------------------------------------- | ------------ |
| 1   | **Async HITL**           | `needs:*` + sleep. Never block interactively.                                | All          |
| 2   | **DoR/DoD gate**         | Task without Why/AC/scope-out/deps = not accepted. Without DoD = not closed. | PLAN, REVIEW |
| 3   | **WIP=1**                | One active task per squad session. No thrashing.                             | DEV, PLAN    |
| 4   | **No silent `git push`** | Commit only. Push requires explicit approval.                                | DEV          |
| 5   | **Context packet**       | Parent = full context, sub-issue = delta + link. Never copy parent.          | PLAN         |

</safeguards>

<squad_launchers>
## Appendix B: Quick Reference — Squad Launchers

```bat
bin\plan.bat     :: PLAN squad   (discovery → spec → decompose → push)
bin\dev.bat      :: DEV squad    (recon → implement → commit → deliver)
bin\review.bat   :: REVIEW squad (first-pass ∥ security ∥ deep)
bin\test.bat     :: TEST squad   (deploy → test → done/return)
bin\cadence.bat  :: CADENCE squad (collect → retro → digest)
bin\agent.bat <area> <role>      :: Single sub-agent (debug)
```
</squad_launchers>