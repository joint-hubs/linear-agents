# Fenix 1.0 — release close-out evidence pack (FOC-102, Order 6)

Status: assembled 2026-09-16 by the Supervisor, closing the release-blocking scope of epic FOC-102.
This is the R1–R7 evidence pack required by `docs/plans/fenix-1.0-release-scope.md` §5 / §4 step 6.
It is evidence, not a plan: every line points at a landed artifact (SHA, run record, gate, verdict
file, or command you can re-run). The FOC↔F\* ledger completion record lives in
`docs/plans/fenix-linear-reconciliation.md` (Order 6, "Completion record").

The release-blocking scope landed on `main` via **PR #27** (`chore/foc-102-baseline` → `main`),
merge commit **`3f2ff87`**, merged **2026-09-16T07:53:11Z**. PR #27 superseded the earlier PR #26
(FOC-284) which was folded into the wave line during the rebase.

## R1 — Preserved work accounted for

PR #25 merged into `main` by the Supervisor (per gate-plan-1-1 Q1), and the reconciliation ledger
holds a completion record for F0–F2.

| Roadmap key | Linear | PR | Merge SHA | Merged |
| --- | --- | --- | --- | --- |
| F0 | FOC-217 | #23 | `2b3ea3d` | 2026-09-07 |
| F1 | FOC-218 | #24 | `313589a` | 2026-09-07 |
| F2 | FOC-219 | #25 | `967fc1a` | 2026-09-11 |

Re-verify: `gh pr view 23 --json mergeCommit.mergedAt` (and 24, 25). The completion record is
appended to `docs/plans/fenix-linear-reconciliation.md`. The full release-blocking scope (orders 1–5)
reached `main` through PR #27 `3f2ff87`.

## R2 — A real issue completes through independent REVIEW and TEST on the exact candidate

The release-candidate run is FOC-165, run `2026-09-15-supervisor-foc-165`.

- **Candidate:** `d725788` on `foc-165-dev` (35 commits over base `f887fb9`). Base = `main` lineage
  after PR #25 (per Q1). RE-VERIFY: `git log --oneline f887fb9..d725788`.
- **Loop:** 4 dev↔review rounds, all fingerprints distinct — r1 `47f2…` (early), r2 `be5858eb…`
  pass, r3 `983abbca…` **fail** (5 remaining runtime-pinned rate literals + threshold), r4
  `a60c9444…` **pass**. r3 found a real gap (7 derivations closed the red assertions but 5 of the same
  class stayed as literals); r4 derived all 5 + the `272_000`/`271_999` threshold from
  `promptTokenThreshold.minPromptTokens`.
- **REVIEW r4 = approve** (review-11, deepseek-v4.1-flash): 7/7 claims MET, 0 blocking; 2
  non-blocking nits (pre-existing tolerances; async-test pair out of delta); verdict recorded with
  AC-by-AC mapping. File: `.state/supervisor/2026-09-15-supervisor-foc-165/verdicts/foc-165-round4.json`.
- **TEST r2 = PASS** (test-12): full suite **64/64 exit 0** (382 s) on `d725788`; both formerly-red
  files green (`supervisor-cost` 34/0, `telemetry-store` 55/0); both-scope rate-swap → green; 5
  mutations M9–M13 → exit 1. Independent session (test-12 ≠ dev-7 ≠ review-11).
- **Deliverable:** the verification report `docs/research/foc-165-cost-accounting-verification.md`
  (the DEV delta) PLUS the scoped code/config fixes the verification proved necessary.

REVIEW was read-only on the exact candidate (base/head SHA + diff in the handoff); REVIEW could not
approve an unavailable diff (roadmap L47). TEST ran on the same SHA.

## R3 — Human gates and budget controls enforced

Gate records for the candidate run, all `answered`, no auto-advance. The r3 FAIL was disposed
through a gate (not a dry run, not auto-advanced):

| Gate | Kind | Child | Disposition |
| --- | --- | --- | --- |
| `gate-dev-7-1` | cleanup-approval | dev-7 | answered "tak" |
| `gate-review-6-1` | question | review-6 | answered — route r3 fail back to DEV (no round cap) |
| `gate-review-11-1` | cleanup-approval | review-11 | answered "tak" |
| `gate-test-12-1` | cleanup-approval | test-12 | answered "tak" |

Re-verify: `ls .state/supervisor/2026-09-15-supervisor-foc-165/gates/` (4 files). No stage
auto-advanced; the r3 fail → DEV return is the `review-to-dev-return` edge from `config/graph.json`,
gated on a recorded verdict. Dry runs never closed a real issue (roadmap L45).

## R4 — Budget cap enforced on the candidate run

Budget allocated 2026-09-15T07:05:50Z, total $25, reserve $1.25 (5%), stages discovery $5 /
synthesis $11.25 / verification $7.5. **Zero authorisations** — the cap was not breached and the
reserve was not drawn.

- `assertWithinBudget` refuses spawn on exceeded AND on unknown/unpriced spend
  (`scripts/supervisor-lib.mjs:242-265`); UNKNOWN never passes.
- Spend is computed from tokens × `config/models.json` prices (the supervisor path). The stream's
  own `total_cost_usd` is retained separately as `costUsdReported` and is **not trusted** — it is
  ~30× inflated for non-Claude models (glm-5.3-flash), which is itself R6 evidence.

Re-verify: `cat .state/supervisor/2026-09-15-supervisor-foc-165/budget.json` (note
`authorisations: []`).

## R5 — Telemetry and verdict artifacts traceable

Verdict records carry source, round, work fingerprint, and artifact:

- `.state/supervisor/2026-09-15-supervisor-foc-165/verdicts/foc-165-round2.json`
- `.state/supervisor/2026-09-15-supervisor-foc-165/verdicts/foc-165-round3.json`
- `.state/supervisor/2026-09-15-supervisor-foc-165/verdicts/foc-165-round4.json`

Per-agent/per-task attribution is visible in the central telemetry store (manifests/dashboard) for
the candidate run SHA. The verdict-evidence module (`scripts/verdict-evidence*.mjs`) emits rows of
(source, round, work fingerprint, artifact); F2 (FOC-219) unified Supervisor and legacy verdict
evidence with round lineage.

## R6 — Unknown evidence/costs never labeled success/free

The FOC-165 report itself is the evidence (`docs/research/foc-165-cost-accounting-verification.md`):

- **Grading:** AC 7 met / 0 not met / 0 inconclusive; DoD 11 met / 1 not met as written (a price
  point named figures that matched neither the committed row nor the live catalogue — resolved by
  the authorised dated price-sync).
- **Unpriced ≠ $0:** unpriced GLM-5.2-FP8 is shown as unknown, never $0; null-contagion kept so an
  unpriced row does not fold into cost as zero. Every cost series carries its own `unpriced` count.
- **Rate drift:** measured divergence is **58.8×**, not the 169.9× the fixture yields (a correction
  the report found by checking rather than trusting, §10.3); the 2026-09-15 catalogue was committed
  as a new price set across 8 drifted models.
- **`costUsdReported` untrusted:** retained as evidence but not used as cost — 61.6× high for
  glm-5.3-flash.
- **UNKNOWN stays UNKNOWN:** no verdict, cost or evidence labelled success/free when its basis was
  unknown.

## R7 — A passing mock or an exit code alone cannot close

- FOC-218/219 verdict semantics enforced in REVIEW/TEST: missing RETURN ≠ PASS; rounds-only ≠ PASS;
  malformed reports stay UNKNOWN.
- Every test result recorded, not only the last command (roadmap L58); pre-existing failures
  separated from regressions (the FOC-165 report §14.6 separates environmental reds from the
  candidate, and TEST caught the two non-environmental reds that round 2's targeted gates missed).
- The FOC-165 r1/r3 FAIL were real fails that found real gaps (5 remaining runtime-pinned rate
  literals that the next `price-check.mjs` sync would redden), not exit-code-only signals. A passing
  mock or a clean exit code did not close this release.

## Out of scope (do not gate closure)

Non-blocking children kept in the epic, annotated post-1.0 (per scope file §7): FOC-164, FOC-117,
FOC-255, FOC-256, FOC-257. Standing follow-ups filed during the wave: FOC-294, FOC-295, FOC-296,
FOC-297. Fragile-test suite filed as non-blocking child FOC-351 (3 env-dependent reds + uncounted
async pair). FOC-350 (Opus alias), FOC-297 (label pagination). None of these gate release acceptance;
the epic remains In Progress to carry them.

## Cost of the wave

Priced `costUsd` summed across the 10 wave runs ≈ **$49.66**; the stream's `costUsdReported` sums
≈ $1500 (30× inflated, untrusted — see R6). Trust the priced figure from `config/models.json`.
