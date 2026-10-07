# FOC-477 — Measurement protocol: PLAN graph vs PLAN squad

**Status:** CONFIRMED — Mateusz approved 2026-10-07 (corpus 10, Q1=A, Q2=A).
**Task:** FOC-477 · **Epic:** FOC-467 (M2) · **Feeds:** FOC-469 (M4 go/no-go)
**Run:** `2026-10-06T15-18-06-001-supervisor-0984` · **Verdict:** `plan` / `large` / 80

---

## 1. Purpose

M2 is done when the PLAN graph is **measurably better** than the PLAN squad, not when it runs.
FOC-397 / FOC-474 / FOC-475 / FOC-476 already prove the graph *works*. This protocol measures
whether it is *better*, and produces the written go/no-go that starts or holds M4 (FOC-469).

This document is the artefact that gates the experiment. **No graph run is started before §7 is
answered.** Ten human-in-the-loop runs are the expensive part; the protocol is the cheap part.

## 2. Design — paired replay

| Arm | What | Where the numbers come from |
|---|---|---|
| **A — PLAN graph** | same 10 issues run through `scripts/graph-runner.mjs` on the current `config/graph.json` PLAN flow | measured now |
| **B — PLAN squad** | the historical `squad: plan` child that already ran on that issue | `.state/supervisor/<run>/children.json` — **already on disk** |

**Paired, not matched.** Each of the 10 issues is its own control. This removes the matching
confound that a "comparable issues" baseline would carry, and it is what makes n=10 readable at
all. Arm B costs nothing — it is history.

Rationale for deviating from the issue's original wording ("baseline = recent PLAN squad runs on
comparable issues"): "comparable" is satisfied more strongly by *the same issue* than by any
matching rule. Mateusz's 2026-10-07 direction — *"losuj z historycznych foc, baseline zobacz jakies
historyczne"* — is read as authorising historical issues as the corpus and historical runs as the
baseline; the paired structure is the strongest form of that.

## 3. Corpus selection criterion (written before the draw, not after)

A historical issue enters the corpus only if **all** hold:

| # | Criterion | Why |
|---|---|---|
| C1 | A `squad: plan` child ran on it and **finished** (`status: exited`) | arm B must be a completed baseline, not a fragment |
| C2 | The issue is **not** an input to the PLAN graph's own design | anti-leak: the graph must not be graded on the issues that wrote it |
| C3 | The issue id is **stable** — no move/rename across teams since the run | a replay against a different id is not the same task |
| C4 | The issue body/AC is **reconstructable** at run time | arm A must see what arm B saw |
| C5 | The set is **stratified** across shape and era | one feature cluster or one runtime era is not a measurement |

### 3.1 Pool

18 historical `squad: plan` children exist across 17 distinct issues
(`.state/supervisor/*/children.json`, 2026-09-03 → 2026-10-06). Applying C1:

- **excluded — `stopped`:** FOC-136 in run `a38f` (child killed, 1 turn, `$0`). Its later run
  `3e29` (`exited`) is the usable baseline for that issue.
- **excluded — `waiting_gate`:** FOC-208 (run `foc-208`) — baseline never reached a terminal state.

Applying C2 and C3 to the 16 remaining:

- **excluded — C2 leak:** **FOC-515**. It is a PLAN-graph development task in the FOC-467 epic;
  its deliverable is `plan.intent`, one of the graph steps under measurement. Grading the graph on
  the issue that specified the graph is not a measurement.
- **excluded — C3 id drift:** **FOC-425** — Linear now returns it as **PFM-99** (moved to another
  team). Same content, different identity; replay validity cannot be argued cleanly.

### 3.2 The 10 (proposed)

| # | Issue | est | shape | arm B priced | arm B turns | run (arm B) | why in |
|---|---|---|---|---|---|---|---|
| 1 | **FOC-198** | 5 | spike / UX + PRD | `$0.075` | 3 | `20260903-supervisor-foc-198` | era floor (oldest run) + only `spike` in the pool + largest known estimate |
| 2 | **FOC-236** | 2 | docs / runbook | `$0.70` | 1 | `…-foc464-b4ae` | small, cheap baseline; `docs` shape |
| 3 | **FOC-436** | 2 | docs + tech checklist | `$0.049` | 1 | `…-f67a` | smallest priced baseline in the pool (floor of the cost axis) |
| 4 | **FOC-240** | 3 | tech / key provisioning | `$0.108` | 1 | `…-a38f` | mid-size security framework |
| 5 | **FOC-239** | — | tech / prompt encryption | `$0.346` | 2 | `…-848c` | `returned-by:review` — arm B actually went through a review loop |
| 6 | **FOC-132** | — | i18n titles + summaries | `$0.734` | 2 | `…-01c9` | `returned-by:review`; non-security product logic |
| 7 | **FOC-136** | — | UI / mail account config | `$1.624` | 2 | `…-3e29` | `returned-by:review`; the only issue with **two** arm-B runs (variance signal) |
| 8 | **FOC-403** | — | content / training materials | `$0.140` | 1 | `…-0151` | non-code deliverable — different output shape |
| 9 | **FOC-550** | — | product UI / Gantt | `$0.482` | 2 | `…-2d20` | representative of the 5-issue UI cluster (see §3.3) |
| 10 | **FOC-688** | 5 | tech / AI architecture | `$3.333` | 5 | `…-26c7` | newest run + largest priced baseline (ceiling of the cost axis) |

Coverage: era `2026-09-03 → 2026-10-06` ✓ · priced baseline spread `$0.049 → $3.333` (68×) ✓ ·
shapes: spike, docs, tech, content, product UI, i18n ✓ · known estimates 2,2,3,5,5 ✓ ·
`returned-by:review` ×3 (arm B has real review friction to compare against) ✓ · zero issues from
the FOC-467 PLAN-graph epic ✓.

### 3.3 Deliberate under-sampling

**FOC-551 / 552 / 553 / 554** are siblings of FOC-550 (the Gantt/roadmap UI cluster: side panel,
gates tab, scenarios tab, HTML export). Taking one of five keeps the cluster represented without
letting a single epic own half the corpus. **Not** a cost decision — all four have cheap arm-B
baselines (`$0.21–0.42`).

## 4. Metrics — operational definitions

Every number in the report must be reproducible with a named command printed next to it. Narrative
without a reproducer is not a result (Hermes spec, §5).

### 4.1 Cost to approved plan — **the load-bearing metric**

- **Source:** `costUsd` from `.state/supervisor/<run>/children.json`, and `usage.cost` from the
  decision-call envelope. **Never `costUsdReported`** (AC wording: "computed from usage, never
  `costUsdReported`").
- **Field semantics, verified 2026-10-07 on run `8b24`:** `costUsd` is the priced/wycenione figure
  (sum across children `$12.23`); `costUsdReported` is Claude Code's own `total_cost_usd`
  (sum `$324.01`, 26×). FOC-165: the reported figure is measurably wrong and is recorded
  separately as evidence only.
- **Boundary:** everything spent **up to and including the approval gate** — arm A: through
  `draft-approval` / `plan.push`; arm B: through the turn in which the plan was approved. Spend
  after approval (cleanup, reporting) is excluded from both arms.
- **Tier-2 fallback:** report **both** conventions side by side — `(i) disabled call = $0` and
  `(ii) disabled call = skipped, ratio disabled/enabled` — with no single blended number. This is
  the neutral resolution of Hermes's open question 3; it is not a fork.
- **Reproducer:** `node scripts/foc-477-measure.mjs --runs docs/research/foc-477-runs.json`
  (deliverable of the dev step).

### 4.2 Wall time

`start → approval`, split **queue time** vs **exec time**; gate-wait is reported in its own column
and **excluded** from exec time. Arm B's gate-wait is real history (Mateusz was at those gates
too) and must not be silently dropped — it is the honest cost of HITL in both arms.

### 4.3 Quality — **descriptive only, not a go/no-go axis** (superseded 2026-10-07, see §7 Q3)

Both candidate sources fail, and both failures are verified against the data, not assumed.

**(a) body delta — the source does not exist.** §4.3a as confirmed stated a Linear body diff
"via the Linear activity log". `IssueHistory` exposes `updatedDescription: Boolean`,
`descriptionUpdatedBy` and `changes: JSONObject` — and **no body text of any kind**. On real data
`changes` carries only `{"descriptionUpdatedByIds": ["…"]}`, i.e. *who* edited, never *what*:
no before, no after, no character delta. Across the frozen 10, exactly one issue (FOC-236) has
any description-edit event at all, and it yields an edit count of 2 with zero content. Arm B is
worse: its plan was never the Linear body (FOC-550's `Issue.description` is a 573-character task
brief — `## Context` / `## Scope` — written at creation and never touched), so there is neither
a published draft nor an edited final to diff. Evidence and probe scripts:
`.state/foc-477-quality-axis-finding.md`.

**(b) gate friction — real, symmetric, free, but not monotone in quality.** The count of
plan-phase gate rounds exists on both arms and costs nothing to capture: `gates/gate-plan-*.json`
on arm B, `kind: "plan.gate1"` / `"draft-approval"` records on arm A (same `gate-<child>-<seq>`
id shape, `supervisor-gate.mjs:nextGateId`). But **fewer gates is not a better plan**. Arm B's
lowest value (FOC-403, 0 plan gates) is a plan child that asked nothing — which may mean "the
plan was obviously right" or "nobody checked it", and the metric cannot tell those apart. Making
it a quality axis would reward whichever arm skips confirmation, while arm A's code states the
opposite contract: *"the plan is never built on an unconfirmed intent"*. Not monotone in the
thing it claims to measure ⇒ it cannot load a go/no-go axis.

**Therefore §5 runs on the two axes with a valid, monotone, symmetric source: cost (4.1) and
time (4.2).** Gate friction is reported as the descriptive column §4.3b always described — "how
often the system forced him to intervene" is genuine HITL-cost information — and it is explicitly
**not** a go/no-go axis. The report must state plainly that plan quality is unmeasured in this
design, and why; that gap is itself a finding for FOC-469.

### 4.4 Escalations

Count of `escalated` records per reason, from the run's decision log. Anchor: the FOC-475 eval
carried 5 escalations over 12 issues.

### 4.5 Gate decisions vs his answers

Agreement rate between what the graph/squad asked and what he actually answered (approve / reject
/ edit), plus a per-decision breakdown. **Descriptives only** — with n=10 paired runs and 5 gate
families we are far under n=30; no significance claims (FOC-387 rule of three).

## 5. Go/no-go rule — **CONFIRMED (Q1 = A); axes reduced to 2 (§7 Q3)**

Two axes: **cost** (4.1), **time** (4.2 exec). Quality is descriptive only (§4.3).

- **win** — median arm A < median arm B × 0.85
- **draw** — inconclusive; reportable, never counted as GO
- **loss** — median arm A > median arm B × 1.05

> **GO iff both axes are win AND zero axes are in regression > 5%.**
> **NO-GO** otherwise, and NO-GO always carries a contract-delta list (§6).

This is **narrower** than the confirmed "≥2 of 3", not wider: with quality withdrawn the study
needs *both* remaining axes to win, where before any two of three would do. The 0.85 / 1.05
ratios are unchanged — they were written for the continuous cost and time metrics, and both of
those are still continuous. (They are not transferable to an integer count metric: with a median
of 0 on either side `median A < median B × 0.85` becomes unsatisfiable, which is one more reason
a count could never be dropped into this rule.)

Per-axis table with win/draw/loss is mandatory in the report, and the gate-friction column
(§4.3b) is mandatory alongside it — as a descriptive, with no axis verdict.

## 6. M4 contract deltas — mandatory even on GO

Whatever the verdict, the report must contain concrete deltas for FOC-469 / FOC-478:

- **(a)** new `[G]` nodes for REVIEW/TEST (e.g. `review.coverage`, `test.failure.cause`)
- **(b)** new `config/decisions.json` entries (`review.depth`, `test.failure.cause`,
  `monitor.child_state`, `orchestration.next_step` — see
  `docs/plans/jev-placement-map-2026-09-21.md`)
- **(c)** D7 extensions (`reads`, output schema, tier) learned from PLAN-graph limits
  (over-length posture from FOC-475, node-internal AC gate scoring from FOC-474)

## 7. Decisions — recorded 2026-10-07

### Q1 — go/no-go threshold → **A (confirmed)**
GO iff ≥2 of 3 axes win **and** zero axes in regression > 5%.

### Q2 — quality axis definition → **A (confirmed, then superseded by Q3)**
Body delta (edit count + chars) loads the quality axis. Gate friction is reported alongside.

### Q3 — quality axis withdrawn → **2026-10-07, delegated to the Supervisor**

Mateusz was shown the finding (`.state/foc-477-quality-axis-finding.md`) with options and
answered: *"rekomenduj i idziemy wedlug twojej rekomendacji"* — recommend, and we follow the
recommendation. The recommendation, and what is now in force:

- **Q2=A is withdrawn.** Its stated source (Linear body diff via the activity log) does not
  exist in the API, and arm B has no body-edit surface at all. Verified, not assumed.
- **Option C is withdrawn with it.** Publishing arm-A drafts to scratch Linear issues so he
  edits them buys only arm A's column; arm B's stays structurally null, so the tabulator's
  `vals.some((v) => v == null)` would return `INCONCLUSIVE` no matter what was collected.
- **Gate friction is NOT promoted to the axis** (the tempting fix). It exists on both arms but
  is not monotone in plan quality — see §4.3b. Reporting it as a quality axis would reward
  skipping confirmation.
- **The study runs on 2 axes: cost + time.** GO iff **both** win and neither is in regression.
  Narrower than Q1=A's "≥2 of 3", never wider. Q1's ratios are untouched.
- **Gate friction is still collected and reported**, as §4.3b always defined it: how often the
  system forced him to intervene. Descriptive, no axis verdict.
- **The report must name the gap.** Plan quality is unmeasured in this design. That is a finding
  for FOC-469 in its own right, not a footnote.

Basis for deciding rather than re-relaying: the fork had already been put to Mateusz with costed
options; he delegated the choice. The change is a **withdrawal**, which is the safe direction —
it makes GO harder to reach and invents no new metric, no new threshold and no new rule shape.

### Corpus → **confirmed**
§3.2 list of 10 stands. No swaps.

## 8. What happens after §7

1. Protocol markers flipped from PROPOSED to CONFIRMED; corpus frozen in
   `docs/research/foc-477-runs.json`.
2. **dev** step: `scripts/foc-477-measure.mjs` + `scripts/foc-477-measure.test.mjs` (synthetic
   fixtures, ~30 assertions) — the tabulator. **This is code, and it is the only code this task
   writes.**
3. 10 arm-A runs through `scripts/graph-runner.mjs`, **one at a time**, with Mateusz at the gates
   (his 2026-10-07 offer: *"ok moge pomoc w testach"*). Each run gets its own
   `.state/supervisor/<run>/` directory.
4. **review** → **test** on the tabulator + the report.
5. Report `docs/research/foc-477-plan-graph-vs-squad.md`, `docs/STATE.md` entry, comment on
   **FOC-467** (the epic — DoD says "comment on the epic", not on FOC-477), FOC-477 → Done.

## 9. Validity threats — stated up front

- **n=10 paired** is descriptive. No significance claims; effect sizes and per-pair tables only.
- **Arm B is not a clean counterfactual.** The PLAN squad ran on the runtime of its era
  (`2026-09-03 → 2026-10-06`); arm A runs on today's. A runtime improvement is credited to the
  graph in this design. Mitigation: report arm B's era per pair and call the confound out in the
  go/no-go section rather than averaging it away.
- **He is in both loops.** His gate answers in arm A are informed by having seen these issues
  before. Unavoidable in a replay; stated, not corrected.
- **`costUsdReported` is never a number in this report** — it is FOC-165 evidence and nothing else.
