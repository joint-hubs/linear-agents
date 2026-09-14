# CodeGraph navigation benchmark (FOC-114)

Measures the CodeGraph **tool path** (index + `scripts/code-intel.mjs` + documented
conventions) on a small frozen set of real repository questions, against a bounded
direct-search baseline. Scope is fixed by `docs/plans/fenix-1.0-release-scope.md` §3.5 +
Decision Q3: navigation = the CodeGraph tool, **not** task-graph routing; the
`config/graph.json` vs `config/handoff-rules.json` seam is out of scope (findings go to
FOC-272).

## The two arms

| arm | tooling | measured |
|---|---|---|
| graph | `node scripts/code-intel.mjs <verb> <args>` per question, against this tree's `.codegraph` index | correctness, output volume (bytes/lines), wall time |
| direct | bounded direct search (grep-class) per question under the budget rule below | correctness, tool-call count, wall time, volume |

**Direct-arm budget rule** (pinned in `scripts/codegraph-benchmark-questions.json` →
`directArmBudgetRule`): one fresh agent per question; Grep/Glob/Read only; **≤12 tool
calls**; flash-tier model; transcript saved. The bound is tool-call count; no line budget
is imposed beyond the harness's per-call output.

**Cost is not measured.** Shell arms have no token metering and pricing an agent arm is
outside this slice — every results file and table carries the manifest's `costStatement`
("inconclusive — shell arm, no token metering; agent-arm pricing out of slice"). No cost
number anywhere in this benchmark is real.

## Running it

**Precondition:** a built index in this worktree — `codegraph init` (Flag (g) of the FOC-114
scope). Without it every question receives the wrapper's exit-3 refusal, every row comes back
`ungraded`, and the run exits **3** with the outputs written for inspection — a refusal is
UNKNOWN, never a graded answer, so an ungraded run is not a measurement.

```bash
codegraph init                                           # precondition, once per worktree
node scripts/codegraph-benchmark.mjs                     # graph arm only
node scripts/codegraph-benchmark.mjs --direct <results.json>   # + combined AC3 table
node scripts/code-intel.test.mjs                         # AC2 safety-semantics assertions
```

Harness exit codes: **0** = completed measurement (a `fail` verdict is a measurement, not an
error); **3** = ≥1 question ungraded (wrapper refusal — UNKNOWN propagated, matching the
wrapper's own exit code); **2** = harness misuse.

A sample raw graph-arm answer is committed for reference:
`evidence/raw/fixturerepo-full.out` (q2 through the wrapper's win32 CLI 1.5.0 path).

### Run record — round 1 (2026-09-14)

- Graph arm: run in the FOC-114 execution worktree with the index present (built by CLI 1.6.0,
  queried by the wrapper's win32-resolved CLI 1.5.0 — see the manifest's `environment` block).
- **Direct arm — deviation from the pinned rule, recorded here deliberately:** the budget rule
  pins "one fresh agent per question; Grep/Glob/Read only; ≤12 tool calls; flash-tier model".
  Round 1 executed the arm **inline in the lead session** (delegation was unavailable during
  the finishing turn), so isolation is weaker than pinned: ground truth was present in-session,
  although each question names its symbol (the grep plan was forced by the question) and
  grading was mechanical needle-matching over saved transcripts. All rows stayed within the
  ≤12-call budget (1–3 calls each). A re-run per the pinned rule requires no harness change —
  the `--direct` input format is the same; only the runner differs.
- Conclusion impact: none recorded by review — the correctness tie and the `inconclusive` cost
  statement are unaffected by the deviation.

- Questions + ground truth: `scripts/codegraph-benchmark-questions.json` (pinned to base
  revision `5b691110fa61e6ab7c0dd97c006c028abbcfb82d`; every ground truth grep-verified at
  that revision, command and observation recorded per question). Questions reference only
  symbols untouched by the benchmark's own additions, so the set stays frozen on this branch.
- Direct-arm results format: JSON array of `{ id, verdict: pass|fail|manual|unanswered,
  toolCalls, transcript, notes? }` — ids must match manifest questions.
- Outputs land in `.state/foc-114/benchmark/` (gitignored): `results.json`, `table.txt`,
  one raw `<id>.out` sidecar per question.
- Re-run reproducibility depends on the CLI versions recorded in the manifest's
  `environment` block: on win32 the wrapper resolves CLI **1.5.0** (cmd PATH) while a
  direct `codegraph` is **1.6.0** — both are recorded because they differ.

## AC1 class coverage

All five classes are frozen and re-runnable; three live as manifest questions, three as
executable assertions (mapping: `ac1Coverage` in the manifest):

- caller chains, shared-symbol impact → questions q1–q6 (machine ground truth);
- judgement-marked question → q7 (never counted pass/fail);
- **stale edit, pending file, unavailable index** → hard assertions + labelled tripwires in
  `scripts/code-intel.test.mjs`, with the observed behavior frozen in
  `docs/benchmark/codegraph-missing-index-evidence.md` §1, §4, §5, §6.

## AC2 status (decided, gate-review-2-1)

**AC2 is NOT met on the current upstream CLI — decision recorded by Mateusz (Position B):
the CLI answer-layer gap blocks FOC-114.** The split the decision rests on:

- **Wrapper refusal layer — holds.** Missing index and CLI-not-on-PATH → exit 3, refusal names
  the fix, never names the queried symbol; hard-asserted in `scripts/code-intel.test.mjs`.
- **CLI answer layer — does not hold.** Pending symbol → confident "not found", exit 0, no
  marker; stale edit → outdated `file:line` with a fresh-disk snippet, no banner. Reproduced
  independently by review at CLI 1.6.0 from this candidate tree; tripwired in cases 4/5.

FOC-114 therefore does not close as satisfied on the current CLI. The two ways out, as facts:
the upstream codegraph CLI fixes the answer layer (outside this repo), or AC2 is rewritten in
Linear. The gap-pinning deliverables (tripwires, evidence §5–6, `status --json →
pendingChanges` signal, the AC4 caveat) remain valid work; they do not satisfy AC2's literal
text.

## What this benchmark cannot decide

- **Cost** — no token metering (see above); any cost column would be invented.
- **Prompt/policy superiority** — it measures the current tool path on seven questions,
  not which prompting strategy an agent should use; AC4 conclusions here are limited to
  what the evidence contradicts or supports directly.
- **MCP-server behavior** — watcher, debounce and the documented `⚠️` staleness banner
  belong to a connected MCP server; this benchmark exercises one-shot CLI invocations only
  (see the evidence doc's coverage note).
- **CLI versions beyond 1.5.0/1.6.0** — the two installed on the measurement machine.
- **Staleness under a live watcher** — one-shot CLI runs neither auto-sync nor flag
  staleness (tripwired); the live-watcher path is untested here.
