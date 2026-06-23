# Fenix — Canonical Workflow

> Single source of truth for how a Fenix squad session runs. Merges the office
> 8-step session schema with the Fenix state model. Applies to all 5
> squads (PLAN, DEV, REVIEW, TEST, CADENCE).

---

## 1. What Fenix Is

Fenix is an **AI orchestration system** that manages software delivery across
multiple repositories through **5 specialized squads** of LLM agents, coordinated
via **Linear** as the async signaling bus.

**Managed repositories** (Fenix does not live in any of these — it orchestrates
them):

| Repo | Squad | Purpose |
|---|---|---|
| `jointhubs-fenix/neo` (joint-flows) | PLAN, DEV, REVIEW, TEST | Neo product |
| `jointhubs-fenix/office` (AU/office) | PLAN, DEV, REVIEW, TEST | Office product |
| `jointhubs-fenix/gantt-pisi` (PISI) | PLAN, DEV, REVIEW, TEST | PISI product |
| `Fenix` (this repo) | — | Fenix config, docs, agent definitions |

**Key properties:**
- **Async HITL** via Linear metadata (labels, comments, emoji reactions) — never
  blocks on interactive chat.
- **5 squads** run in isolation (separate `.bat` launchers, separate
  `CLAUDE_CONFIG_DIR`, separate model routing).
- **CADENCE** is the 5th squad (weekly read-mostly loop) — not a cron job, not
  a human ceremony.
- **Cost-calibrated**: expensive models (Opus) only for high-leverage thinking;
  cheap models (MiniMax, DeepSeek Flash) for volume work.

---

## 2. State Model

### 2.1 Linear Statuses (4 + Canceled)

Fenix uses exactly **4 workflow statuses**. Sub-states like "Ready" and
"Testing" are encoded as labels, not statuses.

| Status | Type | Meaning |
|---|---|---|
| **Todo** | unstarted | Task exists, not yet picked up. May be unprioritized (backlog) or DoR-ready. |
| **In Progress** | started | Actively being worked on by a squad. |
| **In Review** | started | Handed off for review. May be under review or in testing sub-phase. |
| **Done** | completed | All DoD criteria met. |
| **Canceled** | canceled | Abandoned or superseded. |

### 2.2 Label Groups (Single-Select)

| Group | Values | Direction | Meaning |
|---|---|---|---|
| **`type:`** | `feature` · `bug` · `spike` · `tech` | PLAN → all | Routes squad behavior. `spike` → ADR output, no deploy, timebox 1–2d. `tech` → technical success criteria, no user-journey check. |
| **`needs:`** | `answer` · `approval` · `decision` · `access` | **agent → human** | "Waiting on Mateusz." This is the HITL queue. |
| **`risk:`** | `high` | agent → human | Risky change → deeper review (GLM-5.2 deep pass). |
| **`ai:`** | `planned` · `coded` · `reviewed` | provenance | AI-touched → higher review sampling. Non-exclusive (multi). |

### 2.3 Boolean Flags

| Flag | When | Meaning |
|---|---|---|
| `dor-ok` | Todo | Definition of Ready met (Why, AC, scope-out, deps present). |
| `dod-ok` | In Review → Done | Definition of Done met. |
| `escalated` | any | Loop-limit exceeded → human attention needed. |
| `over-budget` | any | Cost guardrail exceeded → stop. |
| `blocked` | any | Blocked by external dependency (+ `blocked by` relation). |
| `stage:testing` | In Review | Sub-phase: deploy + tests running. |
| `transcript-uncertain` | PLAN | Voice transcription uncertain — confirm before decomposing. |

### 2.4 Native Fields (preferred over labels)

| Field | Use |
|---|---|
| **Priority** | DEV pick order (Urgent > High > Med > Low). |
| **Estimate** | T-shirt scale (XS/S/M/L/XL). XL → re-decompose before DEV. |
| **Relations** | `blocked by` → dependency-aware pick. |
| **Assignee** | Bot `@flow` vs Mateusz — handoff signal. |
| **Initiative** | Outcome/theme linkage. |
| **Project** | Repo mapping. |
| **Parent / sub-issue** | Parent = full context, sub-issue = delta + link (never copy parent). |

### 2.5 Office Status Mapping

The office repo's 6-status workflow maps onto the 4-status + labels model:

| Office status | Fenix equivalent | Notes |
|---|---|---|
| `backlog` | Todo (unprioritized) | No DoR check yet. |
| `listed` | Todo + `dor-ok` | DoR-ready, visible for picking. |
| `assigned` | Todo + claimed (assignee set) | Assignee = `@flow` or Mateusz. No separate status needed. |
| `in_delivery` | In Progress + `ai:coded` | Active development. |
| `review` | In Review (+ `ai:reviewed` when passed) | Review sub-phase. |
| `completed` | Done | Terminal. |

**Why labels > statuses (3 lines):**

1. **Richer async HITL**: `needs:answer`, `needs:approval`, `needs:decision`,
   `needs:access` encode *what kind* of human input is needed — a status can
   only say "blocked," not why.
2. **Provenance tracking**: `ai:planned → ai:coded → ai:reviewed` traces AI
   involvement through the lifecycle. Statuses can't encode multi-dimensional
   state (a task can be In Progress AND ai:coded AND risk:high simultaneously).
3. **Human queue filtering**: The `needs:*` label group creates a single
   filterable view (`🔔 My input`) across all tasks regardless of status. With
   statuses alone, Mateusz would have to check every "blocked" or "in review"
   task individually.

---

## 3. Commit Convention

### One Task = One Commit

Every task produces **exactly one commit**. Never bundle multiple tasks in a
single commit.

### Commit Message Format

```
<prefix>(<area>): <short description> [<uuid-first-8>] [<linear-id>]

- Bullet point of what changed
- Bullet point of second change
- Bullet point of third change
```

**Prefixes** (match task type):

| Prefix | When |
|---|---|
| `feat(area):` | New feature (type:feature) |
| `fix(area):` | Bug fix (type:bug) |
| `refactor:` | Refactor / tech debt (type:tech) |
| `test:` | Tests only |
| `chore:` | Config, deps, release bump |
| `docs:` | Documentation |

**Area** (in parentheses): `api`, `frontend`, `sharing`, `deploy`, `models`,
`security`, `db`, `infra`, `tests`, `config`, etc.

**Task ID**: First 8 characters of the task's UUID (from Fenix/Linear),
optionally followed by the Linear short identifier in brackets.

**Examples:**

```
feat(api): CORS whitelist instead of wildcard [ee3262bc] [PISI-107]

- Replaced wildcard CORS policy with explicit origin whitelist
- Added config/env variable for allowed origins
- Updated integration tests
```

```
fix(deploy): keep existing secrets on bootstrap re-run [a1b2c3d4]

- Added if-exists guard to bootstrap-local-secrets.sh
- Prevents encryption key overwrite on redeploy
```

### Rules

- **No `Co-Authored-By: Claude`** trailer (Mateusz's standing rule).
- Branch per task. Pull/rebase from target branch before starting.
- Commit message in English. Code in English. Comments to Mateusz in Polish.

---

## 4. `deliver_task()` — Squad-Lead Action

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

---

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

### Step Details

**Step 1 — get_initiative_board()**
- Load the initiative's kanban board from Linear.
- Read cycles (sprints), their goals, and current task distribution.
- Identify tasks in Todo (candidates), In Progress (active), In Review (blockers).

**Step 2 — pick_next_task()**
- Filter to Todo tasks with `dor-ok` (DoR-ready).
- Sort by Priority (Urgent → High → Med → Low), then by deadline.
- **Dependency-aware**: skip tasks whose `blocked by` relations are not
  resolved. Skip tasks with `blocked` flag.
- **WIP=1**: pick exactly one task. Do not start a second until the first is
  delivered.
- **Size gate**: if estimate is XL (>2 days), flag for re-decomposition before
  starting.

**Step 3 — update_status(In Progress)**
- Set status to In Progress.
- Set assignee to `@flow` (the squad bot).
- Add `ai:coded` label (or appropriate provenance).
- Write a 👀 reaction comment: "Taking this task."

**Step 4 — read_context(recon)**
- Read the task description, AC, and linked resources.
- Read the relevant code files (never modify unread code).
- Build a **context packet**: key files, patterns, env state, test structure.
- Check env readiness (docker compose, seed data, dependencies).
- If anything is unclear → post `needs:answer` + @Mateusz in Polish → **sleep**
  (do not guess).

**Step 5 — implement()**
- Squad-specific work (see §5.1 below).
- Checkpoint progress to `STATE.md` every ~4 hours or per logical slice.
- For unclear decisions → `needs:decision` + sleep.
- For risky changes → add `risk:high` label.

**Step 6 — commit(one-task)**
- `git add` only the files changed for this task.
- Commit with the format from §3.
- **Never `git push` without explicit approval** (safety rule).

**Step 7 — deliver_task()**
- Call `deliver_task(actual_hours, delivery_summary)` as defined in §4.
- Task moves to In Review.

**Step 8 — next or stop**
- If more tasks are available and within session budget → go to step 1.
- If session time limit reached, cost budget exceeded, or no suitable tasks →
  stop. Write final STATE.md update.

### 5.1 Per-Squad Variations

| Aspect | PLAN | DEV | REVIEW | TEST | CADENCE |
|---|---|---|---|---|---|
| **Cadence** | On demand (voice memo) | On demand (task ready) | On demand (task in review) | On demand (task approved) | Weekly (cron) |
| **Step 5 = implement()** | Discovery → spec → decompose → push to Linear | Code the feature/fix | Review code (3 parallel passes) | Deploy + run tests | Collect state → retro → digest |
| **Input** | Voice memo + artifacts | Task in Todo with `dor-ok` | Task in In Review | Task with `stage:testing` | Linear board state |
| **Output** | Parent epic + sub-issues in Todo | Branch + commit + In Review | Verdict: approve or return | Done or return to In Progress | Digest (PL) to Mateusz |
| **Read-only?** | No | No | **Yes** (no Edit/Write) | Mostly no | **Yes** (no scope changes) |
| **HITL gates** | 2 (brief approve, sample approve) | 1 (plan approve) | 0 (async if escalated) | 0 (auto-rollback on fail) | 0 (proposal only) |
| **Key model** | Opus (lead), MiniMax (discovery) | GLM-5.2 (lead/impl) | GLM-5.2 (deep), Kimi (security) | MiniMax (lead), DeepSeek (deploy) | MiniMax (lead), GLM-5.2 (retro) |

---

## 6. HITL Gates and Signaling

### 6.1 Emoji Micro-Dialog

All human↔agent communication on Linear comments uses this lightweight protocol:

| Emoji | Who | Meaning |
|---|---|---|
| 👀 | Agent | "Received, working on it" (ack) |
| ✅ / 👍 | Human | "Approved, proceed" |
| 🚫 | Human | "No, changes needed" |
| 🔁 | Human | "Rework and resubmit" |

**Flow:** Agent posts a plan/question → Mateusz reacts ✅ (1 click) → webhook
wakes the agent → agent removes `needs:*` → continues.

### 6.2 `needs:*` Queue

When an agent needs human input, it:

1. Posts a comment in Polish with the question/context.
2. Adds the appropriate `needs:*` label (`answer`, `approval`, `decision`,
   `access`).
3. @mentions Mateusz.
4. **Stops** (does not poll, does not guess).

Mateusz sees all such tasks in the **🔔 My input** saved filter
(`needs:*` OR assignee=me) and processes them in one batch session.

### 6.3 Escalation Ladder

When an agent hits a problem it cannot resolve:

```
Step 1: Retry (same model, same approach)
  ↓ (fails again)
Step 2: Escalate model
  ├─ MCP/multi-file issues → Kimi K2.7 Code
  └─ Reasoning/hard problems → Opus 4.8
  ↓ (still fails)
Step 3: needs:* + @Mateusz (comment in Polish) + escalated flag
  ↓
Step 4: STOP — wait for human
```

**Review loop limit:** Max 2 review rounds between DEV and REVIEW. After 2
rounds without convergence → `escalated` + @Mateusz. The REVIEW squad lead
tracks the round counter on the task.

---

## 7. DoR / DoD Gates

### 7.1 Definition of Ready (DoR) — Entry Gate

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

### 7.2 Definition of Done (DoD) — Exit Gate

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

---

## 8. Safeguards (P0)

These are **hard requirements** before any squad runs autonomously. Enumerate
here; each squad's CLAUDE.md expands the implementation.

| # | Safeguard | Mechanism | Squad |
|---|---|---|---|
| 1 | **Loop-limit + escalation** | Max 2 review rounds → `escalated`. Max N follow-ups per task. | REVIEW, DEV |
| 2 | **Cost guardrail** | Budget $/task + kill-switch. Exceed → `over-budget` + stop. | All |
| 3 | **Tool-call fallback** | Retry → fallback model (Kimi for MCP, Opus for reasoning). | All |
| 4 | **Idempotency + resume** | Check existing before create. Atomic push + rollback. Resume from `STATE.md`. | PLAN, DEV |
| 5 | **Deploy safety** | Health-check + auto-rollback. Synthetic test data (no prod PII). | TEST |
| 6 | **Async HITL** | `needs:*` + sleep. Never block interactively. | All |
| 7 | **DoR/DoD gate** | Task without Why/AC/scope-out/deps = not accepted. Without DoD = not closed. | PLAN, REVIEW |
| 8 | **WIP=1** | One active task per squad session. No thrashing. | DEV, PLAN |
| 9 | **No silent `git push`** | Commit only. Push requires explicit approval. | DEV |
| 10 | **Context packet** | Parent = full context, sub-issue = delta + link. Never copy parent. | PLAN |

---

## 9. Open Conventions (To Finalize)

These are unresolved design points that will be decided as Fenix matures:

| # | Topic | Question | Proposed |
|---|---|---|---|
| 1 | **Linear bot user** | What OAuth app name/scopes for `@flow`? | `app:assignable`, `app:mentionable`, webhooks on mention/assign/react/comment |
| 2 | **Project → repo mapping** | Where to store the map? | `config/projects.json` — Linear project ID → repo path + deploy target |
| 3 | **Deploy targets** | GCP VM vs Lambda AI per project? | Per-project in `projects.json` |
| 4 | **API keys** | Where to store provider keys? | Env / vault, documented in `docs/ACCESS.md` |
| 5 | **Control-panel UI** | Web UI for saved filters + manual override? | Separate step from `Desktop/experiments/0_linear` |
| 6 | **CADENCE trigger** | Cron vs `morning_planner.py` vs Hermes? | Weekly cron, with manual override via `bin\cadence.bat` |
| 7 | **Metrics dashboard** | DORA-lite metrics after ~50 tasks? | Cycle time, throughput, review iterations, $/task |
| 8 | **Cross-repo tasks** | Task spanning multiple repos? | List >1 repo in task; DEV splits or handles sequentially |
| 9 | **Release checklist** | User-facing release ceremony? | Optional: rollback check, observability, release notes |
| 10 | **Forecast** | Monte Carlo throughput forecast? | After ~50 tasks of history |

---

## Appendix A: Saved Linear Filters (Mateusz's Control Plane)

| View | Filter | Purpose |
|---|---|---|
| **🔔 My input** | `needs:*` OR assignee=me | HITL queue (batch process) |
| **🤖 Agent working** | assignee=`@flow` AND status=In Progress | What's happening now |
| **⚠️ Attention** | `risk:high` OR `escalated` OR `over-budget` | Where to look |
| **🚧 Blocked** | `blocked` OR has `blocked by` relation | Unblocking queue |
| **🧪 Review/Test** | status=In Review | Ready for acceptance |

## Appendix B: Quick Reference — Squad Launchers

```bat
bin\plan.bat     :: PLAN squad   (discovery → spec → decompose → push)
bin\dev.bat      :: DEV squad    (recon → implement → commit → deliver)
bin\review.bat   :: REVIEW squad (first-pass ∥ security ∥ deep)
bin\test.bat     :: TEST squad   (deploy → test → done/return)
bin\cadence.bat  :: CADENCE squad (collect → retro → digest)
bin\agent.bat <area> <role>      :: Single sub-agent (debug)
```
