# Fenix Self-Development Audit — 2026-09-23

**Scope:** Fenix self-development at main `3c1ec662e3d8ef580f96f63078b415bfcce3ead2` (FOC-452), plus active `foc-474-dev` at `fb614e2`. Main and pending work are distinguished below. This is a point-in-time audit of an actively changing repository.
**Evidence:** [dependencies](2026-09-23-fenix-dependencies.json), git, local run records, read-only telemetry aggregates and targeted source verification. Local evidence, outside the repo (cited below as *issue-contracts* and *Linear snapshot*, kept out of this public repository): the Linear snapshot (all 111 issues, 6 milestones, observed **2026-09-23 06:42:31 UTC / 08:42:31 CEST**) and the raw issue-contracts dump, both stored locally under `.state/reviews/`.
**Method:** GLM-5.3-Flash reconnaissance, independent GLM-5.3 review, root source checks and three offline test files. Run-record and benchmark results are distinguished from tests re-executed by this audit. No provider experiment was re-run. Unless labelled **candidate**, code line numbers refer to main. Issue links use `https://linear.app/jointhubs/issue/<identifier>`.

## Verdict

The direction is good; the architecture has a useful foundation:

- **Modular graph runner.** `scripts/graph-runner.mjs` separates deterministic execution from generation, judgment and human decisions using typed steps in `config/graph.json` v2.
- **Typed, fail-closed records.** Unexpected states stop the run and hand it to the frontman with the record that triggered it (`scripts/graph-runner.mjs:497`, `:610-614`).
- **A0 = annotation, never auto-act.** [J] steps record an annotation and hand off ("never auto-acted; threshold null", `scripts/graph-runner.mjs:500-505`, `:616-624`).
- **Registry authority.** Decisions are config entries, not new code — FOC-448 Done; `plan-gates` serves gates through the seam's own contract (`scripts/plan-gates.mjs:73-82`).
- **Candidate-SHA checks.** The TEST candidate matches the DEV candidate in the sampled recent runs; FOC-406's fix is already merged despite its In Review status.
- **Proven review loops.** FOC-451 and FOC-452 both failed review despite green suites and were fixed before pass.

The **M2 migration is incomplete**. Fenix is already delivering changes through its existing supervisor, but the new graph is not a demonstrated end-to-end PLAN replacement. FOC-474 has a real, provider-metered DoD experiment; it does **not** establish a before/after whole-pipeline efficiency gain. Historical transcript-derived cost comparisons remain compromised by FOC-381. Small integration refactors are justified; a repository rewrite is not.

## Milestones and dependencies

Rollups re-derived from the snapshot:

| Milestone | Children | Breakdown |
|---|---|---|
| M1 Foundations (lane B) | 5 | 4 Backlog, 1 In Review (FOC-406), 0 Done |
| M2 Graph engine + PLAN (lane A) | 11 | 4 Backlog, 2 Done (448, 473), 3 In Progress (396, 452, 474), 2 In Review (397, 449) |

FOC-466's description: M1 "runs as **lane B**, in parallel with M2 (lane A); **never blocks it**" (issue-contracts FOC-466). Linear blocking edges nonetheless show **FOC-381 → blocks FOC-397 + FOC-477** and **FOC-450 → blocks FOC-476** (dependencies.json).

Parallel construction is reasonable, but the blanket "never blocks" wording and actual blocking edges need reconciliation. **Transcript-based comparative measurement needs [FOC-381](https://linear.app/jointhubs/issue/FOC-381)**: its historical sample reports nonuniform duplication (about 1.98–2.97× per squad), so dividing every result by 2.19 is not a valid repair. Independent provider-metered calls are a different data source. **FOC-476 publishing depends on [FOC-450](https://linear.app/jointhubs/issue/FOC-450)**, the local secret-egress screen. Do not stop all M2 construction; assign explicit completion gates and keep M1 from being indefinitely postponed.

**Status hygiene — do not close on merge alone:**

- FOC-451 is **Backlog** on Linear while its merge `d200ba0` ("Merge FOC-451", verified via `git log`) is already an ancestor of main.
- FOC-396 / FOC-452 are **In Progress** while merged (baseline `3c1ec66` is FOC-452's merge).
- FOC-397 (In Review) has an **unmet measured AC**: frontman token share before/after comparable runs (issue-contracts FOC-397). The latest Hermes comment, read directly from Linear (2026-09-23), itself acknowledges the AC/status ambiguity. Closing on merge alone would drop an explicit measurement requirement; FOC-477 remains the broader go/no-go for M4.

## Delivery metadata — 7 sampled runs: 406, 449, 397, 451, 396, 452, 474

Six completed landings plus FOC-474 active *(reported from run records)*:

- **The review loop is load-bearing.** FOC-451 and FOC-452 failed review **despite green suites**; fix passes followed. FOC-451 had **2 merge rejections** before pass; FOC-396 had **1 conflict rejection**. All final combined verifies exited 0 per records.
- **FOC-474 (dev)** had **five premature turns with no artifacts**, recorded in the supervisor's follow-up, then recovered. The branch contains **four** commits over main; the TEST worktree was pinned to candidate `fb614e2`. Its review worktree starts from the base and examines the diff. A heartbeat was observed at 08:43 CEST — age alone is not evidence of a stuck process.
- **FOC-397's second review produced an identical fingerprint** — reason unknown. Flag as suspected redundancy needing investigation; not proven waste (a confirmatory re-review is legitimate).
- Transcript-derived spending comparisons from this period cannot establish the cost of these recoveries until FOC-381 is fixed.

## Code findings (root-verified this audit)

1. **Main's [G] transport defects are already being fixed in FOC-474.** Main lacks timeout and usage logging (`scripts/graph-runner.mjs:317`), and destructures `state` although the caller supplies `reads`. Candidate `fb614e2` fixes the input mismatch, uses the registry prompt and declared reads, adds an abort deadline and logs successful calls. These are pending changes, **not newly overlooked work**. Candidate anchors: `scripts/graph-runner.mjs:332`, `:347`, `:362`, `:379`, `:381`, `:855`.
2. **Inconsistent decision-record mapping.** `runJStep` (`scripts/graph-runner.mjs:499-505`) omits `eventId`, while `decideEdge` (`:622`) preserves it (`eventId: envelope.eventId ?? null`). Unify the mapping — the event id is the join key for FOC-449 labelling.
3. **Implicit CLI run context, still open on the candidate.** `createLiveCaller` (`scripts/graph-runner.mjs:729`) passes only the apiKey. With no `LA_RUN_ID`, the seam has no default log target; with a different launcher run id, its events use that id instead of the graph CLI's `--run-id`. Candidate FOC-474 fixes this for [G], but not [J]. Unify decision-record mapping and pass run context explicitly. Candidate anchors: `:595` versus `:725` for eventId; `:832` for the caller.
4. **Gate resolution is intentionally agent-written.** FOC-397 explicitly assigns this responsibility to the deciding agent; absence of an automatic writer is not itself a defect. Before end-to-end rollout, test the real answer/resume path and show the exact `gate.<step>.resolution` key in the handoff.
5. **Node input schema missing** (some steps accept undeclared input shapes). An **improvement, not a rewrite** — the typed-record spine is right.
6. **Silent truncation affects annotation quality.** `scripts/plan-gates.mjs:148` slices state at 16,000 characters without a truncation warning, while the runner rejects oversized composed state. Use selected fields and explicit truncation metadata. Current A0 annotations do not automatically execute decisions, which limits the immediate consequence.
7. **Export splits do not isolate tasks.** `scripts/decision-log.mjs:197` hashes `eventId|decisionId`, while `taskKey` is merely exported (`:232`). Repeated or different decisions over the same issue can enter both training and evaluation partitions. Before training/calibration, introduce a versioned split grouped by stable task identity across all its events; keep unidentifiable rows out of the held-out evaluation set. This is a future evaluation-validity risk, not evidence that a trained model has already leaked data. Track explicitly with FOC-387 / evaluation work rather than assuming the current split is task-independent.

## Active FOC-474: measured progress and remaining release conditions

Candidate benchmark: `docs/benchmark/plan-dod-eval.md` at **fb614e2**, with committed harness/fixtures and local raw artifacts. The audit inspected the report and implementation; it did not repeat paid calls.

- With the runtime's **120 s** budget: **5/12 calls succeeded, 7 timed out**. With an eval-only **300 s** budget: **12/12 returned schema-valid output**, latency **25.4–299.2 s**. The runtime default remains 120 s (`graph-runner.mjs:338` on the candidate). Correct error classification is fixed; runtime latency policy is not.
- Semantic rubric: **2 pass / 9 partial / 0 fail** among 11 cases with approved reference DoD; one case has no reference and is excluded. This is a documented qualitative rubric, not an independently re-scored accuracy metric. Valid JSON does not prove completeness.
- Some misses are input-contract issues: no own `issue.id`, references to other issue ids, and project conventions absent from declared inputs. Other misses include scope/boundary details. Supply necessary identity/policy context, and add diff-dependent checks at the appropriate later stage; do not feed the approved answer into the generation prompt.
- Successful-call cost is provider-metered (**$0.0844 for the second run**, per report), independent of the transcript duplication defect. This proves a small call-level experiment, not a pipeline saving. Output-token volume and latency vary substantially despite the short inputs.
- `plan.dod` still has no downstream consumer: candidate `config/graph.json:123` reads `plan.ac.definitionOfDone`; FOC-475/476 own the split and integration. This is planned incompleteness, not an accidental omission.
- Documentation also needs reconciliation: the generator still claims an unmeasured posture, and the benchmark calls `e31d971` a merged `plan.ac` change although git identifies it as a pending FOC-474 `plan.dod` commit.

Accept FOC-474 against its declared draft-generation scope; require explicit quality and latency criteria before routing live PLAN through it. Preserve the human/A0 checks while these conditions remain open.

## CodeGraph adoption

Live SQLite aggregates, read-only, window 2026-09-21T00Z–09-24T00Z (latest event 06:41:41Z, before this audit) *(reported)*: **9 271 tool rows across 119 runs** — the window spans multiple projects, **not all Fenix**; **23 MCP calls (16 `explore`, 7 `node`) in 5 runs**; **6 CLI candidate invocations** identified from shell text; Read/Grep/Glob **3 195** calls. No `codegraph_impact` call appears in the window — but `explore` can report blast radius, so **"no impact checks at all" cannot be inferred**.

**Root finding: `.codegraph/` is missing in all 12 checked Fenix worktrees** (397/451/452/474 × dev/review/test). Instructions disagree: `.claude/CLAUDE.md:9` says to **skip CodeGraph entirely** without an index, while root `CLAUDE.md` says graph-first and suggests initialization. This is a credible explanation consistent with observed nonuse, not a proved causal trace of each child. Missing index alone also does not prove MCP incapability. Make worktree bootstrap and prompts agree; verify readiness against the worktree's own revision rather than silently using main's index. Measure useful navigation outcomes, not a tool-call quota.

**Benchmark:** `docs/benchmark/codegraph-navigation.md` — 6 pass, 1 manual, on a small fixture; **cost unmeasured** (FOC-114's AC requires the cost comparison) and the bounded-arm method is a stated limitation.

## Prompt / startup floor

The launch path sets `CLAUDE_CONFIG_DIR` to the selected role (`supervisor-spawn.mjs:612`); role instructions plus target-repository instructions form the intended memory context. Sizes below are file measurements; tokens ≈ bytes ÷ 4 are estimates, not an exact runtime token census:

| Role file | Bytes | ~Tokens |
|---|---|---|
| `agents/supervisor/CLAUDE.md` | 20 313 | ~5.1k |
| `agents/dev/CLAUDE.md` | 21 742 | ~5.4k |
| `agents/plan/CLAUDE.md` | 17 440 | ~4.4k |
| `agents/review/CLAUDE.md` | 20 053 | ~5.0k |
| `agents/test/CLAUDE.md` | 16 644 | ~4.2k |
| `agents/cadence/CLAUDE.md` | 12 796 | ~3.2k |

Plus Fenix repo instructions: root `CLAUDE.md` 3,504 B + `.claude/CLAUDE.md` 806 B ≈ 1.1k estimated tokens. Do not add all role files to one session. MCP schema footprint is unmeasured; skills/role bodies are loaded on demand. No current wiring shows the marketplace cache automatically injected; deleting cache files is not an evidenced token optimization. AGENTS.md's existence does not establish that Claude CLI loads it; actual launch behaviour must govern the inventory.

**Additional instructed startup reads:** DEV `CLAUDE.md:8` and PLAN/REVIEW/TEST `CLAUDE.md:5` mandate their PRD and role document before answering. Those pairs total **DEV 13,998 B (~3.5k tokens), PLAN 6,297 B (~1.6k), REVIEW 5,962 B (~1.5k), TEST 8,171 B (~2.0k)**. This is instructed load, not proof each session complies. DEV's role + repo + these reads alone approach **10k estimated tokens**, before system/tool schemas, kickoff, task content and history.

Optimization order: (1) keep a concise mandatory behaviour contract and select relevant spec sections on demand; (2) use structured state/handoffs with evidence references, preserving candidate SHA, unresolved findings and human decisions; (3) make node inputs explicit and complete, with visible truncation; (4) remove repeated budget prose and move examples to optional references. Preserve A0, verification, permission and secret-handling rules. Compare outcomes on the same task set, not just prompt length.

## Cost — what may and may not be claimed

- **No savings estimates from undeduplicated historical usage.** FOC-381 compromises transcript-derived totals and weighted averages. Large individual inputs (164–170k tokens) are a diagnostic signal; provider-metered experiment records are a separate source.
- **`--resume` history** accumulates and may be compacted — never claim "full history in context forever".
- **Cached tokens are not free**, and bytes → tokens is ≈ ÷4: trimming 1 kB saves ~250 tokens, not 1000. Cross-role text dedup is a **maintenance** win, not a token win (FOC-166: each session loads only its own file).
- Worth building: a tighter **progress brief** with structured handoff/evidence references; a safe **checkpoint → fresh-session** path **behind a flag**, compared on quality with corrected token metrics.
- FOC-474's registry prompt plus declared reads is a useful context improvement already in progress. The next step is completing the input contract, not indiscriminately shortening it.

## Action priority table

| # | Action | Type | Ref |
|---|---|---|---|
| 1 | Land FOC-381 dedup (one cost truth) — unblocks honest 397/477 measurement | Existing task (M1) | FOC-381 |
| 2 | Land FOC-450 before FOC-476 publication; keep an explicit lane-B owner/slot | Existing task (M1) | FOC-450 |
| 3 | Finish FOC-474 review; decide runtime deadline and input/semantic criteria before live routing | Existing work, not a duplicate transport task | FOC-474/475/476 |
| 4 | Unify decision-record mapping (`eventId`) + explicit CLI run context | **New fix** | scripts/graph-runner.mjs:499-505, :622, :729-731 |
| 5 | Align CodeGraph bootstrap/prompts and verify readiness in a fresh worktree | **New fix** | .claude/CLAUDE.md:9 |
| 6 | Reconcile Linear statuses against every AC, merge and outstanding measurement; record reasons | Existing hygiene | FOC-451, FOC-396, FOC-452 |
| 7 | Resolve FOC-397 AC/status ambiguity and measure comparable before/after runs | Existing task | FOC-397 |
| 8 | Split mandatory behaviour from optional specs; trial structured handoffs on corrected metrics | **New improvement** | role CLAUDE.md startup refs |
| 9 | Investigate FOC-397 duplicate-fingerprint second review | **New fix** (small) | run records *(reported)* |
| 10 | Make truncation explicit and validate node input contracts | Small context-contract improvement | scripts/plan-gates.mjs:148 |
| 11 | Run FOC-477 measurement → written go/no-go for M4 | Existing task (M2) | FOC-477 |
| 12 | Add measured navigation cost/quality comparison once worktree usage works | Follow-up to completed benchmark task | FOC-114 |
| 13 | Version task-grouped dataset splits before learning/calibration | New evaluation safeguard | scripts/decision-log.mjs:197; coordinate FOC-387 |

## Completed checklist

- [x] All three evidence JSONs read (111 issues, 6 milestones, observed 2026-09-23T06:42:31Z)
- [x] M1/M2 rollups and blocking edges re-derived from snapshot + dependencies
- [x] Code lines verified: graph-runner `:317-328`, `:340`, `:499-505`, `:622`, `:729-731`; plan-gates `:78-82`
- [x] Instruction lines verified: `.claude/CLAUDE.md:9`, `agents/dev/CLAUDE.md:8`
- [x] Role byte sizes measured (table above); repo instructions 3 504 B + 806 B
- [x] `.codegraph` absence re-verified in all 12 worktrees; `d200ba0` = Merge FOC-451; baseline `3c1ec66` = Merge FOC-452
- [x] Active FOC-474 delta and benchmark checked separately from main; no duplicate transport fixes proposed
- [x] Three offline test files re-run on main — **78 checks PASS, 0 failed** (19+21+38 in 3 files, not 78 suite files; isolated local fixtures)
- [x] No live provider or Linear write test; no source-code, STATE, git commit or runtime configuration changes made by this audit
