# Fenix 1.0 — release-blocking scope decision (FOC-102)

Status: scope approved at GATE 1 on 2026-09-10 (gate record `gate-plan-1-1`; GATE 2 pending). Author: PLAN squad. This file records the confirmed release-blocking scope for Linear epic FOC-102 "Fenix 1.0: stabilize delivery and trustworthy evidence". Linear updates happen only through the Supervisor after GATE 2.

Sources (read in full by PLAN before writing; code citations re-verified in this worktree on 2026-09-11):

- `.state/foc-102-gate1-brief.md` — GATE 1 brief with per-child grounding. Its FOC-114 row is superseded by Decision Q3 (guessed task-graph routing; the confirmed definition is a CodeGraph navigation benchmark). All other rows stand.
- `docs/plans/fenix-stabilization-and-learning.md` — approved roadmap (cited as roadmap L\<n\>).
- `docs/plans/fenix-linear-reconciliation.md` — authoritative FOC↔F\* map + verified blocking relations (cited as reconciliation L\<n\>).
- `docs/research/telemetry-analysis-2026-09.md` — measured cost defects — 2.19×/4.01× inflation, unpriced GLM-5.2-FP8 (cited as telemetry L\<n\>).

## 1. Scope anchor

Roadmap L40 (quote):

> "F0–F4 are the stabilization wave. F5–F8 are a separately grouped learning phase, **not release prerequisites**."

Therefore the release-blocking scope is F3 + F4 (open) plus the contracts needed to prove release acceptance; the learning phase (F5–F8, FOC-216 subtree) is out. Done already (per reconciliation L10–12): F0 = FOC-217, F1 = FOC-218, F2 = FOC-219 (child states verified 2026-09-10 by the Supervisor — see Flag (f)).

## 2. Decisions — confirmed by Mateusz at GATE 1, 2026-09-10 (gate-plan-1-1)

- **Q1 — FOC-165 is the final release-blocking child AND the release-candidate run.** Its full loop with independent REVIEW+TEST on the exact candidate closes the real-issue-through-the-loop proof. Candidate base = `main` after merging PR #25; the merge is executed by the Supervisor, not PLAN.
- **Q2 — FOC-272 runs FIRST in execution order**, with the fix-or-defer rule: findings go through a gate and never auto-extend 1.0 scope.
- **Q3 — FOC-114 defines navigation as a CodeGraph navigation benchmark, NOT task-graph routing.** Issue scope, quoted from FOC-114's issue body — read from Linear by the Supervisor (PLAN has no Linear access) and relayed in the gate-plan-1-1 answer (run 2026-09-10T20-16-00-083-supervisor-3e3a, answered 2026-09-11T01:55Z; gate record at `C:\Users\mateu\Documents\GitHub\linear-agents\.state\supervisor\2026-09-10T20-16-00-083-supervisor-3e3a\gates\gate-plan-1-1.json`, main checkout, outside this worktree): "Evaluate navigation on a small frozen set of real repository questions and affected-symbol changes. Reuse CodeGraph where available; verify stale/pending/missing-index behavior and documented fallback." AC:
  1. fixtures include caller chains, shared-symbol impact, stale edits, pending files, unavailable index;
  2. answers cite correct current code, no false-absence claim based solely on an incomplete index;
  3. compare correctness, tool output volume, elapsed time and cost against bounded direct search on the same tasks; report inconclusive honestly;
  4. prompt changes follow evidence, retain safety/fallback semantics, no redundant graph calls for known facts.

  Blocking slice = that benchmark verification; "measured effectiveness" rides F3/F4 telemetry. The `config/graph.json` vs `config/handoff-rules.json` routing seam stays OUT of FOC-114; FOC-272 may surface it as a finding.
- **Q4 — FOC-117 is non-blocking** (post-1.0 annotation in the epic): detect-and-record + honest state already landed (crashed terminal status, reconcile-runs, FOC-271 direction 1, supervised `--resume`); auto-restart/heartbeat are resilience, not evidence correctness; release acceptance does not require them.

## 3. Per-child verdicts

| Child | Blocks 1.0? | Ground (one line) |
| --- | --- | --- |
| FOC-220 (F3) | **YES** | 3/4 F3 ACs unmet; "waste" evidence partly wrong by construction (§3.1) |
| FOC-221 (F4) | **YES** | deduped cost still 2.19× high; heuristic task links (§3.2) |
| FOC-165 | **YES** — release-candidate run | scope = verify existing cap/accounting (§3.3) |
| FOC-272 | **YES** — review, runs first | architecture review with fix-or-defer gate (§3.4) |
| FOC-114 | **YES** — slice | CodeGraph navigation benchmark per Q3 (§3.5) |
| FOC-164 | no (post-1.0) | env-override ergonomics only (§7) |
| FOC-117 | no (post-1.0) | resilience, not evidence correctness (Q4) (§7) |
| FOC-255 | no (post-1.0) | parity harness hardening (§7) |
| FOC-256 | no (post-1.0) | test-env hygiene (§7) |
| FOC-257 | no (post-1.0) | test-quality hardening (§7) |

### 3.1 FOC-220 — Correct tool behavior measurements (F3; roadmap L33) — BLOCKING

3 of 4 F3 ACs unmet (roadmap L33: "Hash complete input before preview truncation; output sizes; deterministic ordering; Read→Edit→Read and justified reruns not labeled waste solely by matching arguments"):

- Hash before truncation: UNMET — `tool_input` is serialized then cut to 1000 chars at `scripts/telemetry-tool-extract.mjs:136` (comment "Serialize input, truncated to 1000 chars" at :129); no `input_hash`/`inputHash` anywhere in the repo (Grep 2026-09-11).
- Result sizes: UNMET — no output/result-size recording in tool facts.
- Waste exemption: BROKEN BY CONSTRUCTION — `scripts/agent-behavior.mjs:89` counts every identical repeat after the first as waste (`isRepeat = index > 0`) with no justified-rerun / Read→Edit→Read exemption.
- Deterministic ordering (4th AC): no checkable criterion recorded at GATE 1 — verify-or-fix within the slice; verification = a stable total ordering over tool facts for identical inputs, asserted by a named test artifact in the FOC-220 slice (aligned with §4 step 2).

### 3.2 FOC-221 — Qualified canonical usage and task attribution (F4; roadmap L34) — BLOCKING

- `canonical_usage` is real and tested, but deduplicated cost is still 2.19× inflated (per-message usage lines repeat ~2.57×; raw sums 4.01×) — telemetry L8, L22.
- Task links are heuristic only, without validation.
- Kickoff backfill regex `TASK_RE = /\b(FEN|PISI|JOI)-(\d{1,5})\b/i` at `scripts/backfill-task-ids.mjs:34` lacks the FOC- prefix, while branch inference covers FOC (`scripts/ledger.mjs:115-127`) — asymmetric coverage.

### 3.3 FOC-165 — Budget cap / accounting verification — BLOCKING, release-candidate run (Q1)

Scope = verify-existing, per roadmap L10 "No additional budget cap was requested. Existing caps remain enforced; unknown prices remain unknown" and reconciliation L45 "not a premature Done". No new cap is built.

Already fixed by design: cost is computed from tokens × config prices; the stream figure is retained as `costUsdReported` because a discrepancy is evidence; `assertWithinBudget` refuses spawn when spend is exceeded AND when spend is UNKNOWN/unpriced (`scripts/supervisor-lib.mjs:242-265`).

Remaining gaps: kill-switch `scripts/cost-guard.mjs` is wired only into the `cost-report` CLI (`scripts/cost-report.mjs:12`), not the launchers; GLM-5.2-FP8 has 2,732 historical rows at $0 as of the 2026-09-10 telemetry snapshot (telemetry L22, L211 — "never priced" at snapshot time), while `config/models.json:276-283` now carries a nebul pricing row for `zai-org/GLM-5.2-FP8` (input 1.91 / output 9.57 / cacheRead 0.76) — the open verification is whether that existing row is actually applied at ingest/budget time (candidate fix (b) below); `costUsdReported` is 61.6× too high for glm-5.3-flash (telemetry L22).

DEV deliverable (named so R2 is executable): the candidate's DEV delta = the FOC-165 verification report with its evidence — a real repo diff (`docs/` + any config change) — PLUS the scoped code/config fixes the verification proves necessary. Two fixes are pre-identified from the measured gaps: (a) wiring `cost-guard` into the standalone launchers (today only `scripts/cost-report.mjs:12` imports it); (b) verifying the nebul price row for `zai-org/GLM-5.2-FP8` (`config/models.json:276-283`) is actually applied at ingest/budget time. Anything beyond those, found during verification, follows the same fix-or-defer rule as FOC-272 — it never silently extends the candidate. Minimum candidate = report diff; expected = report + proven fixes.

### 3.4 FOC-272 — Architecture/handoff topology review — BLOCKING as review, runs FIRST (Q2)

Pure review; every input exists (verified 2026-09-11): `config/graph.json` + `config/handoff-rules.json` with `scripts/graph-validate.mjs`/`graph-validate.test.mjs`; ADRs 0001/0002/0008/0009/0010; `agents/*/CLAUDE.md` (7 squads); `bin/*.bat` launchers; `docs/TELEMETRY-EXPLAINED.md`. Cheap, and may reshape F3/F4 execution mechanics. Fix-or-defer: findings go through a gate (Q2) and never auto-extend 1.0 scope.

### 3.5 FOC-114 — Navigation — BLOCKING slice = CodeGraph navigation benchmark (Q3)

The benchmark per Q3 AC 1–4 is the release-blocking slice; "measured effectiveness" rides F3/F4 telemetry. Note: this worktree currently has NO `.codegraph/` index (Glob 2026-09-11) — the missing-index/fallback path is itself part of the AC, and index availability is an open question routed to GATE 2 (Flag (g)). The routing seam stays out of FOC-114 (Q3).

## 4. Execution order 0–6

0. **PR #25 merge** via Supervisor gate — candidate base = `main` (Q1); the merge SHA is recorded in the FOC-102 delta per §5 R1.
1. **FOC-272** — architecture review; findings disposed fix-or-defer through a gate (Q2).
2. **FOC-220** (F3) — hash full input before truncation; record result sizes; justified-rerun / Read→Edit→Read exemption; deterministic ordering — verify-or-fix: stable total ordering over tool facts for identical inputs, asserted by a named test artifact in the slice (§3.1).
3. **FOC-221** (F4) — per-message dedup killing the 2.19× inflation; task-link validation; FOC- prefix in the backfill regex; uncertain coverage visible.
4. **FOC-114 slice** — CodeGraph navigation benchmark per Q3 AC 1–4.
5. **FOC-165** — verification report = release-candidate run through the full loop with independent REVIEW+TEST on the exact candidate (DEV deliverable per §3.3).
6. **Close-out** — ledger completion record for F0–F2 + FOC↔F\* map per roadmap L3/L53; delta applied to FOC-102 (also records the PR #25 merge SHA per §5 R1); BRIEF comment via Supervisor; R1–R7 evidence pack (§5).

**Relations note (mandatory):** verified Linear blockedBy relations come ONLY from the reconciliation doc ("Verified blocking relations", L23–30). Within 1.0 scope these are FOC-217 → FOC-218/FOC-220/FOC-221 and FOC-218 → FOC-219; their source issues (FOC-217, FOC-218) are Done, so these relations no longer block. The remaining verified edges (reconciliation L27–30: FOC-219/220/221 → FOC-110 and the three learning-phase edges) point into the FOC-216 learning subtree only — out of 1.0 scope — so no verified blockedBy edge gates FOC-220/221/165/272/114. The 0–6 order above is operational sequencing under "one issue / one live child" (roadmap L11), NOT new Linear relations.

## 5. Release acceptance → verifiable evidence (R1–R7)

- **R1 — preserved work accounted for:** PR #25 merged into `main` — the FOC-102 delta (applied by the Supervisor) records the PR #25 merge SHA as the R1 evidence — plus the reconciliation ledger completion record for F0–F2.
- **R2 — real issue completes through independent REVIEW and TEST on the exact candidate:** the FOC-165 run — PLAN kickoff → DEV scoped change (minimum = the verification-report diff; expected = report + proven fixes, §3.3) → REVIEW read-only on the exact candidate (base/head SHA + diff in the handoff; REVIEW cannot approve an unavailable diff — roadmap L47) → TEST on the same SHA (real local CLI/server per L47); independent sessions; evidence-backed verdicts (F2 semantics).
- **R3 — human gates + budget controls enforced:** gate records for the candidate run; no auto-advance; dry runs never close real issues (roadmap L45).
- **R4 — budget cap enforced on the candidate run:** supervisor-path enforcement (`assertWithinBudget` refuses on exceeded AND unknown — `scripts/supervisor-lib.mjs:242-265`); supervisor-budget reconcile vs telemetry; UNKNOWN never passes.
- **R5 — telemetry + verdict artifacts traceable:** verdict-evidence rows (source, round, work fingerprint, artifact) + per-agent/per-task attribution visible for the candidate run SHA in manifests/dashboard.
- **R6 — unknown evidence/costs never labeled success/free:** the FOC-165 report itself — pricing coverage including GLM-5.2-FP8 shown as unknown with a row count, never $0; rate-drift evidence; unpriced is never folded into cost — every cost series carries its own `unpriced` count (telemetry §8, L369); UNKNOWN verdicts stay UNKNOWN.
- **R7 — a passing mock or exit code alone cannot close:** FOC-218/219 verdict semantics enforced in REVIEW/TEST (missing RETURN ≠ PASS; rounds-only ≠ PASS); every test result recorded, not only the last command (roadmap L58); pre-existing failures separated from regressions.

## 6. Flags and residuals

- **(a) Branch naming:** roadmap L8 says scoped commits on `chore/fenix-stabilization-learning`; reality is `chore/foc-102-baseline` + worktree `foc-102-plan`. Candidate base = `main` after PR #25 per Q1.
- **(b) Completion records:** roadmap L3 ("pending unless explicitly recorded below") has no completion-record mechanism → close-out applies the ledger update per L53; otherwise "recorded" covers nothing.
- **(c) Title verbs:** FOC-220/221 titles say measurement/attribution; roadmap L33–34 says Correct/Qualify — the work is repair of existing measurements, not greenfield. The FOC-102 delta pins AC to L33–34.
- **(d) FOC-165 title "budget cap" vs roadmap L10:** scope is verify-existing; no new cap.
- **(e) FOC-271 direction 2 (outside the epic):** open seam — `stalled` requires a first tee write (`scripts/supervisor-status.mjs:155-163`: `silentMs` is null without a tee mtime, so a child silent from start is never stalled); `STALL_SILENCE_MS` at :47-48. Disposition pending GATE 2; must not silently extend 1.0.
- **(f) Child states** were verified by the Supervisor on 2026-09-10, not independently re-verified by PLAN — recorded assumption.
- **(g) CodeGraph index availability** for the FOC-114 benchmark — open question routed to GATE 2 (no `.codegraph/` in this worktree).

## 7. Non-blocking children (stay in the epic, annotated post-1.0 / non-blocking)

- **FOC-164 — provider base-URL env override.** Every provider block already carries a `baseUrl` (`config/models.json:5,16,27,42` — `zai_anthropic` → `https://api.z.ai/api/anthropic` at :27); the gap is only env-override ergonomics without editing committed config. Promote if a provider's base URL must change per environment without a config commit.
- **FOC-117 — interrupted-run recovery.** Non-blocking per Q4: detect-and-record + honest state landed (crashed terminal status `scripts/supervisor-lib.mjs:782`, reconcile-runs, FOC-271 direction 1, supervised `--resume`); auto-restart/heartbeat are resilience, not evidence correctness. Promotion trigger: evidence that a crashed child invalidates release evidence.
- **FOC-255 — CLI/projection parity harness.** Parity is checked by a single fixture (`scripts/verdict-evidence.test.mjs:516-520`); residual is a shared harness. Promotion trigger: a parity drift bug found in the field.
- **FOC-256 — test spawn env hygiene.** `baseEnv` spreads the full `process.env` and strips nothing (`scripts/supervisor-test-fixtures.mjs:183-189`). Promotion trigger: a test that leaks env and flips a verdict.
- **FOC-257 — verdict-evidence test quality.** The module already enforces evidence-backed rows and honest UNKNOWN; hardening is test quality only. Promotion trigger: a semantics-relevant gap discovered during hardening.

None of the above gates closure of FOC-102.