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

```bash
node scripts/codegraph-benchmark.mjs                     # graph arm only
node scripts/codegraph-benchmark.mjs --direct <results.json>   # + combined AC3 table
node scripts/code-intel.test.mjs                         # AC2 safety-semantics assertions
```

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
