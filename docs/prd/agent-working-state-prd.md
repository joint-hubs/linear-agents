---
type: prd
status: accepted for planning (2026-10-08) — open points in §10 have recommended defaults
milestone: M5 Slim DEV and Supervisor
epic: FOC-470
tasks: FOC-727, FOC-728, FOC-729, FOC-730, FOC-731
created: 2026-10-08
---

# PRD — Agent working state (a fact store that survives compaction)

## 1. Problem

Mateusz (2026-10-08, dictated): an agent working from a given state should not have to search its whole
context to find a parameter such as the milestone or project name. Key facts should live in a small SQLite
store it reads and writes, and they must not be lost or paraphrased when the context is compacted.

What exists today and why it is not enough:

| Mechanism | What it does | Gap |
|---|---|---|
| `=== PINNED STATE ===` kickoff prologue (FOC-286, `pinnedStatePrologue` in `scripts/supervisor-lib.mjs`) | Ten spawn-verified fields in the first message of every squad child | Static, not writable by the agent, no project/milestone/epic, can be summarised away by compaction |
| Supervisor SessionStart briefing (FOC-609, `supervisor-status.mjs --briefing`) | Run digest from disk at session start, also after compaction (hook has no matcher) | Run state only; no planning facts; the agent cannot add to it |
| `docs/STATE.md` | Long-lived log | 3,183 lines; finding one value means reading a lot |
| Claude Code memory files | Cross-session long-term memory | Different purpose; not per run, not structured, not cleaned up |

Observed cost: Supervisors and children re-query Linear and git for facts they already had, and after a
compaction ask Mateusz things that were settled earlier in the same run.

## 2. Goal

Each agent has a **working state**: a namespaced set of key → value facts in SQLite that it reads instead of
searching, that is re-injected verbatim after every compaction, with:

- **base keys** — a must-have set per role, resolved deterministically where possible, asked from Mateusz when
  not, **never deletable by the agent**;
- **agent keys** — added by the agent when it decides a value matters, each with a reason and a lifetime, and
  **retired when used up**.

## 3. User journey

- **Supervisor run starts** → `agent-state resolve --role supervisor` fills `linear_project = FENIX`,
  `active_milestone = M7 Release discipline and living docs`, `active_epic = FOC-714`, `active_issue`,
  `landing_flow`, `push_policy`, `cost_basis = priced`, `known_reds` … from Linear, git, config and the queue
  line in `STATE.md`. One value cannot be found → one non-blocking hold for Mateusz; work continues.
- **During work** the Supervisor learns "FOC-598 waits for the AC1b decision" → `agent-state set
  --key foc598_blocker --value "AC1b fork, Mateusz" --reason "do not re-spawn" --scope task`.
- **Compaction happens** → the SessionStart hook prints `=== WORKING STATE ===` with every base key and the
  active agent keys; the summary may be lossy, the block is not.
- **Task lands** → `prune --scope task` retires the task's agent keys; base keys stay; history keeps everything.
- **Squad child** gets the same: spawn seeds its base keys (the PINNED STATE values + issue, milestone, epic),
  its SessionStart hook renders its own namespace.

## 4. Scope

### In

- Store + CLI with tiers, history, protections, secret screen, caps (FOC-727).
- Base-key registry per role, deterministic resolvers, missing → hold record (FOC-728).
- Re-injection at SessionStart (startup / resume / compact) for the Supervisor and children; PINNED STATE seeded
  into the store (FOC-729).
- Skill + contract trigger lines, auto-prune at task close, archive with the run, deny raw DB writes (FOC-730).
- Measurement before/after (FOC-731).

### Out

- Interactive sessions outside Fenix runs (Mateusz's own Claude Code sessions, other repos) — not tracked yet;
  add a backlog task if wanted after FOC-731 shows an effect.
- Cross-run long-term memory — that is what Claude Code memory and `STATE.md` are for.
- Semantic search over facts — keys are exact; no embeddings.
- Storing secrets, long text, code — refused by design.

## 5. Data model

```text
facts(
  namespace TEXT,            -- supervisor:<runId> | child:<runId>/<childId> | session:<id>
  key TEXT,
  value TEXT,                -- ≤ 2 KB, secret-screened
  tier TEXT,                 -- base | agent
  status TEXT,               -- active | retired
  source TEXT,               -- spawn | git | linear | config | state-md | user | agent
  evidence TEXT,             -- e.g. "linear-query issue FOC-714 → projectMilestone", "hold H-12"
  reason TEXT,               -- required for agent keys
  scope TEXT,                -- run | task | turn
  expires_at TEXT NULL,
  created_at, updated_at, last_read_at TEXT,
  read_count INTEGER,
  version INTEGER,
  PRIMARY KEY (namespace, key)
)
facts_history(id, namespace, key, op, before, after, actor, at)   -- append-only
```

Location: `<LA_ROOT>/.state/agent-state/agent-state.sqlite` (WAL; never inside a task worktree; gitignored).
Lifetime: archived with the run's work product at cleanup (FOC-649 archive), dropped after the
`test-artifacts` retention (20 runs ∩ 14 days).

## 6. Rules

1. **Base keys cannot be deleted** by `retire` or `prune` (exit 1). They can be updated only with evidence; the
   previous value stays in history. Only a change to `config/agent-state.json` (Mateusz) removes a base key.
2. **Agent keys need a reason** and a scope or ttl. At most 50 active per namespace. `prune` retires expired and
   scope-ended keys; task close runs it.
3. **Read before search.** The skill tells agents to `get` a known parameter before searching context, Linear
   or git.
4. **No secrets, no bulk.** Values pass the local egress secret screen (FOC-450) because the rendered block is
   sent to the model provider. Long content belongs in files; store the path.
5. **Only the CLI writes.** Raw writes to the store file are denied in the Supervisor and child permission lists.
6. **Render is deterministic and capped** (≈60 lines / 6 KB); base keys are never cut; over-cap agent keys
   are summarised as "N more — use agent-state get".
7. **A failing hook never blocks a session**: it prints one line `WORKING STATE unavailable: <reason>` and
   exits 0.

## 7. Base keys (starting set, reviewed in FOC-728)

| Role | Keys |
|---|---|
| all | `repo`, `la_root`, `run_id`, `role`, `linear_team`, `linear_project` |
| supervisor | `active_milestone`, `active_epic`, `active_issue`, `queue_head`, `landing_flow`, `push_policy`, `cost_basis`, `known_reds` |
| squad child | `issue`, `issue_title`, `milestone`, `epic`, `worktree`, `branch`, `base_revision`, `candidate`, `acceptance_criteria_ref` |

Resolvers are deterministic only: spawn data (PINNED STATE), git, `scripts/linear-query.mjs`, `config/*.json`,
the queue line in `docs/STATE.md`. No LLM decides a base value.

## 8. Phases

| # | Task | Size | Depends on |
|---|---|---|---|
| 1 | FOC-727 store + CLI | M | — |
| 2 | FOC-728 base keys + resolvers + ask | M | 1 |
| 3 | FOC-729 SessionStart re-injection, PINNED STATE seeding | M | 1 |
| 4 | FOC-730 skill, contracts, prune, deny raw writes | S | 2, 3 — needs Mateusz's OK for `agents/**` |
| 5 | FOC-731 measurement | S | 4 + 10 real tasks |

## 9. Acceptance (feature level)

1. After a compaction in a real Supervisor run, the next turn shows the WORKING STATE block with every base
   key, and the agent answers "which milestone / epic / issue" from it without a Linear or git call.
2. A base key cannot be deleted through any agent-reachable path (CLI refuses; raw writes denied).
3. After task close no `scope: task` agent key is active.
4. FOC-731 reports before/after numbers; a miss is reported as a miss.

## 10. Open points (recommended defaults, change in review)

1. One store for all namespaces (default) vs one file per run — one store keeps lookups and measurement simple;
   WAL handles the Supervisor + one child.
2. Agent keys visible to the Supervisor across namespaces (default: read-only yes; children see only their own).
3. Render cap 60 lines / 6 KB (default) — revisit after FOC-731.
4. Extending to Mateusz's interactive sessions — after FOC-731, only if the effect is measurable.
