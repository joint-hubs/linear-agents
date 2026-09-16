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

- **Round 4 (wrapper freshness guard) — re-measured 2026-09-14.** The guard sits INSIDE the
  wrapper, so graph-arm elapsed time changed while volume did not: same verdicts (6 pass /
  0 fail / 1 manual, exit 0), identical bytes/lines per row, **9570 ms total vs 2399–3186 ms
  pre-guard** (clean path: one `codegraph status --json` spawn per query; a dirty index
  additionally syncs mid-run). AC4's "no redundant graph calls" constrains the advice given
  to agents — squads make no extra call — not the wrapper's internal guard.

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

## AC2 status (round 4 — fixed at the wrapper layer, decided 2026-09-14)

**AC2 is satisfied on the wrapper path — the layer this benchmark measures.** Decision
(2026-09-14, superseding the Position B dead end of gate-review-2-1): fix it in this repo, at
the layer the documented workflow actually uses. The raw captures (`evidence/raw/pending-*`,
`raw/stale-*`) show `codegraph status --json` deterministically reports `pendingChanges` in
both bad cases, so `scripts/code-intel.mjs` now proves index freshness before every query
verb (`explore`, `symbol`, `find`, `callers`, `callees`, `impact`, `affected`, `files`):

- clean (`pendingChanges` all 0, with a provable git baseline — round 5) → the query runs;
- pending → `codegraph sync <root>` (positional — the CLI rejects `--path`), then re-check;
  only at zero pending changes does the query run;
- no git baseline (no `.git`, or HEAD unresolvable), sync failed, still pending after sync, or
  state unprovable (unreadable/malformed status — a corrupt index dir answers
  `{"initialized":false}` with exit 0 and no `pendingChanges`) → **exit 3 UNKNOWN**, same
  semantics as the missing-index refusal; the message names the fix and never the queried
  symbol. (Without the baseline the CLI's pending signal reports false zeros — see round 5
  below and evidence §7.)

Hard-asserted through the wrapper in `scripts/code-intel.test.mjs` (round 4;
mutation-verified: guard disabled → exactly the guarded assertions go red while the raw-CLI
tripwires stay green; guard restored → green): pending → found at the real location; stale →
current `file:line`; unprovable state → exit 3; CLI unrunnable → exit 3.

The split stays visible and factual:

- **Wrapper — guarded.** Pending/stale queries can no longer answer silently from an outdated
  index: the wrapper syncs first, or refuses with exit 3.
- **Raw one-shot CLI — still dangerous, tripwired, not fixed here.** `codegraph
  symbol/find/...` invoked directly still reports confident "not found" for a pending symbol
  (exit 0, no marker) and cites an outdated `file:line` for a stale edit. That is upstream's
  answer layer; cases 4/5 pin it as tripwires (they spawn the raw CLI) and evidence §5–6
  documents it. Squads query through the wrapper (`docs/tools/code-intel.md`).
- **Concurrent invocations.** Two wrappers syncing at once surface as one failed sync
  (SQLite lock) → that wrapper exits 3 — a refusal, never a false answer. The deterministic
  parts are asserted (unprovable state → exit 3, case 8; CLI unrunnable → exit 3, case 2); a
  real two-process lock collision is timing-dependent and is deliberately NOT shipped as a
  test — it would be flaky, and a flaky guard test is noise, not evidence.

**Round 5 — the claim, narrowed to what the guard actually proves.** Review round 4 falsified
the round-4 wording end-to-end: `pendingChanges` is computed **against a git baseline**, and in
two reachable configurations the CLI reports a false zero with a file pending — a git repo
before its first commit (CLI 1.5.0, the binary cmd's PATH resolves on win32) and any tree with
no own `.git` nested where an enclosing repo ignores it (both CLI versions) — so the wrapper
answered a confident "not found" with exit 0, exactly the AC2-forbidden outcome. The measured
matrix is in evidence §7; round 4's fixtures had all committed a baseline, which is why the
suite could not see it. The guard now requires, before trusting *any* `pendingChanges` value
(including zero) and before any sync: a readable status, `.git` at the project root, and a
resolvable `git HEAD`. Where freshness cannot be proven it refuses with **exit 3**, naming the
git fix and never the queried symbol. Hard-asserted (cases 9/10/11/12) and mutation-verified
both directions: baseline check removed → exactly the blind-spot assertions go red (59 pass /
8 fail); guard removed entirely → every guarded assertion red, raw-CLI tripwires green
(49 pass / 18 fail); restored → 67 pass / 0 fail.

The guarantee this states — and no wider: **the wrapper never answers from an index whose
freshness it cannot prove, and it refuses (exit 3) wherever freshness cannot be proven; the
git baseline is a precondition of proof.** Accepted bounds, documented and deliberately not
chased: a TOCTOU window one spawn wide (an edit between the last status read and the query
spawn); a hypothetical corrupt status carrying a well-formed zero (the corrupt shape that
actually occurs omits the field and fails closed); "still pending after sync" has no
deterministic trigger, so its refusal is reviewed by construction while the sync-failed
sibling is pinned by test (case 11). The resolved CLI version is surfaced on the guard's
diagnostic stderr as a measurement, not a refusal — the documented 1.5.0-queries-1.6.0-built
path must not fail on version mismatch alone.

- **Round 5 re-measure (guard + baseline check):** 6 pass / 0 fail / 1 manual, exit 0,
  per-row bytes/lines identical, **6701 ms total** (round-4 runs 8110–9570 ms; pre-guard
  2399–3186 ms) — spawn overhead dominates and varies by machine load; the structural cost is
  one `status --json` spawn plus one `git rev-parse --verify HEAD` per query verb, and one
  `sync` when dirty.

AC2 in Linear is NOT rewritten — the fix satisfies it as written, on the wrapper surface.

## What this benchmark cannot decide

- **Cost** — no token metering (see above); any cost column would be invented.
- **Prompt/policy superiority** — it measures the current tool path on seven questions,
  not which prompting strategy an agent should use; AC4 conclusions here are limited to
  what the evidence contradicts or supports directly.
- **MCP-server behavior** — watcher, debounce and the documented `⚠️` staleness banner
  belong to a connected MCP server; this benchmark exercises one-shot CLI invocations only
  (see the evidence doc's coverage note).
- **CLI versions beyond 1.5.0/1.6.0** — the two installed on the measurement machine.
- **Staleness under a live watcher** — the raw one-shot CLI neither auto-syncs nor flags
  staleness (tripwired); the wrapper now syncs on pending changes and refuses otherwise
  (round 4); the live-watcher path is untested here.
