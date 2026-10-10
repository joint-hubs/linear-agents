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
- **Attribution of the Supervisor's own turns — decided 2026-10-08 (§7 Q4 = A).** Arm B's
  `costUsd` covers a whole plan child, including the turns that authored its spec. Arm A has no
  such child, so the symmetric cost is **not** "graph nodes only". In force for all 10 runs:
  - **Main number:** `usage.cost` of every node event in the run's `decisions.jsonl`, **plus** the
    Supervisor's turns whose work arm B's `costUsd` contains — `plan.spec` authoring and the
    `[J] A0` resolutions — priced from the telemetry window through `config/models.json`.
  - **`plan.spec` is booked as a separate PLAN child** (`costUsd` in
    `.state/supervisor/<armA-runId>/children.json`), not as a session turn — §7 Q5. A0 resolutions
    stay on the frontman-turn line: they are interleaved annotations, not separable work products.
  - **Sensitivity line ("nodes only"):** `usage.cost` alone. Reported alongside the main number,
    never instead of it.
  - **Separate line, outside the main number in both arms:** turns that only relay a gate to
    Mateusz and carry his answer back. HITL cost is real, but it is not plan-production cost and
    arm B's `costUsd` does not contain it either.
  - **Every turn is counted exactly once, in exactly one bucket.** A turn priced to arm A is
    priced **wholly** to arm A even if it also transcribed a measurement record — the
    conservative direction, the one that cannot produce a false GO.
  - **Lane discipline:** no Lane-B work in a turn that carries arm-A work (Mateusz, 2026-10-08:
    *"w aktywnym oknie runu A nie mieszaj w tych samych turach pracy toru B"*). A turn is
    single-lane.
- **Run-input conventions — written before any counted run exists (2026-10-08).** Arm A's `inputs`
  JSON has three keys, built by one code path (`.state/foc-477-armA/build-inputs.mjs`) and never
  retyped — a transcribed issue body would silently change the message the model sees.
  - `inbox.entry` — the Linear issue's `description` field **verbatim**. Verified byte-identical on
    FOC-198 (2015 chars, `description === inbox.entry`). The title is **not** prepended; production
    never sent it.
  - `repoState.pinned` — `{branch, head}` of the **orchestrator** checkout (linear-agents) at run
    start. Same convention as excluded attempts 1–2. Arm A's plans are not anchored to the issue's
    own target repo (FOC-198 is trading_assist work, FOC-236 is joint-flows work, and both pin
    linear-agents). **Named rather than changed mid-campaign** — it is not on a go/no-go axis, and a
    convention that shifts between runs costs more than the wrong pin does.
  - `features.list` — the extracted **candidate files** (`plan-ac.mjs:69`: *"the candidate-files
    array the caller retrieved"*; the `plan.ac` prompt: *"the extracted candidate files"*). Kept as
    `{name, text}` — the only wire shape that exists — with `name` = path and `text` = why it is a
    candidate; the files are the ones the issue text names. **Attempts 1–2 put ACs here**, which the
    model was explicitly told were files. Both attempts are `excluded (C1)`, so no counted run is
    contaminated; the convention is fixed now so that all 10 counted runs share it.
- **Implementation status at run 2 (2026-10-08) — the rules above are decided; the tabulator does
  not yet implement them.** Named now so none of it is decided after a number exists.
  `scripts/foc-477-measure.mjs` reads `costUsd` from `children.json` only (its own header says
  *"Cost is `costUsd` only"*) and wall time from `childWallTime(child.turns)`. Three gaps follow:
  **(i)** no `usage.cost` from `decisions.jsonl` ⇒ Q4's main cost number is unimplemented and the
  cost axis currently understates arm A; **(ii)** arm A's graph walk lives in
  `.state/runs/<runId>/graph-steps.jsonl`, not in a child's `turns[]` ⇒ `timeExec` for arm A would
  measure only the `plan.spec` child (Q5) and not the walk; **(iii)** `childWallTime` lumps every
  inter-turn gap into `gateWaitSec` and excludes it from `execSec` ⇒ Q7's stall-inclusion is
  unimplemented and the time axis currently flatters arm A. **All three are report-side, not
  instrument-side:** every run still records the raw data each rule needs — node timestamps in
  `graph-steps.jsonl`, `usage.cost` per event in `decisions.jsonl`, gate records for gate-wait, and
  the frontman-stall intervals as gaps that carry no gate. **No counted run is wasted by this gap,
  and no counted run's treatment is decided by it.** Implementing (i)–(iii) is a change to
  `scripts/foc-477-measure.mjs` and takes the full track (branch → REVIEW → TEST → PR → merge),
  before the report is produced. It does not touch `graph-runner.mjs`, so Q9's instrument boundary
  is unaffected.
- **Instrument identity.** The blob sha of `scripts/graph-runner.mjs` is recorded per arm-A run in
  `docs/research/foc-477-runs.json` (`armARuns[].runnerSha`). The `[G]` observability patch lands
  **after the 10th run** (§7 Q6), never inside a run, so all 10 runs share one instrument.
- **Instrument findings at run 2 (2026-10-08) — two findings, both DECIDED by Mateusz the same
  day.** Full evidence in `docs/research/foc-477-runs.json` (`egressScreenScan20261008`,
  `egressScreenFix20261008`, `inboxEntryEmpty20261008`, `inboxEntryRecovery20261008`).
  1. **The egress screen refused 3 of the 10 corpus entries** (`EGRESS_BLOCKED` at `plan.dor`,
     tier-3 handed-off). Family E (high-entropy, relaxed branch: `len ≥ 32`, `≥ 3.9 bits/char`,
     `≥ 3` char classes) flagged **Linear URL slugs** — `foc-143-r5-…-protected-stack` and three
     siblings, 58–69 chars, lowercase + digits + hyphen = 3 classes. **No secret value is present
     in any corpus input**; the slugs contain words like "key" because the issues are *about* key
     provisioning. Hits: FOC-236 ×2, FOC-240 ×6, FOC-239 ×4; the other seven were clean.
     **DECIDED (Mateusz, 2026-10-08) — variant A, in a narrow scope.** An exception for the
     `<slug>` segment of a Linear issue URL only
     (`https://linear.app/<workspace>/issue/<KLUCZ-N>/<slug>`, the slug derived from the issue
     title and not a secret). The same string outside such a URL is still caught exactly as today.
     **No general loosening of family E.** Required tests: the 4 real corpus slugs pass; and three
     negatives stay blocked — a secret of the same shape outside a Linear URL, a secret appended to
     a Linear URL (`?token=…`), a key in the path of a URL on another domain. Full track
     (branch → REVIEW → TEST → PR → merge), outside an active run window.
     *Side observation, routed out of FOC-477 by the same decision:* `composeState`
     (`graph-runner.mjs:765`) `JSON.stringify`s the read map into a single line, which blinds the
     line-anchored family-C env-assignment detector for `[J]` states — the screen is currently
     **under**-firing on `[J]` inputs. Separate task, child of FOC-466, bug, High. It must not
     change the instrument mid-campaign, and it does not.
  2. **`inbox.entry` is empty for FOC-132 and FOC-136** (Linear `description` is `""`; the only
     prose is historical arm-B run writeback). `composeIntentInputs` throws `invalid_input` on an
     empty anchor set (`plan-intent.mjs:235-240`), so `plan.intent` cannot run on those two —
     they fail before any model call. **DECIDED (Mateusz, 2026-10-08) — variant D: arm A sees what
     arm B saw (criterion C4).** For those two, `inbox.entry` is the hand-written brief arm B's
     PLAN child was spawned with, reproduced **verbatim** from the run record. Recovered literally
     from disk, so the `{issueId, title, scopeSummary}` fallback is not needed and was not used.
     Only the launcher's PINNED-STATE prologue is excluded (it is harness chrome whose content arm A
     models separately as `repoState.pinned`); the whole hand-written kickoff file is reproduced
     byte-for-byte, **including** its squad-role framing. That framing is meaningless for a graph
     node and the excerpted-brief variant is the **sensitivity** line — keeping the extra tokens can
     only make arm A worse on both axes, never better, so the whole file is the conservative main
     number, exactly as with the §4.2 stall rule. Brief bodies are not copied into the repo; the
     record carries source path + `sha256` + byte counts instead.
  - **Instrument boundary (supersedes the earlier freeze note).** No counted run existed when either
    change was decided, so nothing had to be re-run. The **fix's `sha` is the instrument boundary**:
    run 2 (FOC-236) restarts from scratch on that version and nothing before it counts — the two
    `excluded (C1)` attempts and run 2's `EGRESS_BLOCKED` stop all sit before the boundary and stay
    excluded. Every counted arm-A run therefore shares one runner **and** one screen version. This
    replaces "no instrument change before the 10th run", which assumed none would be needed.

### 4.2 Wall time

`start → approval`, split **queue time** vs **exec time**; gate-wait is reported in its own column
and **excluded** from exec time. Arm B's gate-wait is real history (Mateusz was at those gates
too) and must not be silently dropped — it is the honest cost of HITL in both arms.

**Frontman-tooling stall — third column, rule settled before it can matter (2026-10-08, §7 Q7).** Time the
run spends parked because the Supervisor's own tooling refused (permission denials, harness
restarts) is neither exec time nor gate-wait: it is an artefact of the measurement harness and has
no counterpart in arm B. It is reported in its own column **and counted in the go/no-go exec
figure**. That is the **conservative** direction — the stall makes arm A slower, so including it
can only cost arm A the axis, never buy it a false GO — and it is the **same rule as cost (§7
Q4)**: the main number is the variant that cannot flatter the measured arm. The exclusion is
printed alongside as an explicit sensitivity line ("frontman stall excluded"), never instead of the
main figure and never silently. Both numbers are mandatory in the report.

First occurrence: run `arma-01r2`, 35 min between the `plan.dor` resolution (`13:39:45Z`) and the
resume (`14:14:27Z`) — an auto-mode permission deadlock, in an attempt that is excluded anyway
(§3). The rule is written now so that no counted run ever has its stall treatment decided after
the fact.

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

### Q4 — attribution of the Supervisor's own turns → **A (Mateusz, 2026-10-08)**

*"Koszt ramienia A — decyzja: A."* The conservative variant stands as the main number:
`usage.cost` of nodes **plus** the Supervisor's turns doing work that arm B's `costUsd` contains
(`plan.spec`, `[J] A0` resolutions), priced from the telemetry window. "Nodes only" is an explicit
sensitivity line. Gate-relay turns are a separate line, outside the main number in **both** arms.
Operational definition in §4.1.

### Q5 — `plan.spec` as a separate PLAN child → **yes (Supervisor's call, 2026-10-08, delegated)**

Mateusz: *"Rozważ plan.spec jako osobne dziecko PLAN (wyceniony costUsd, symetria z B) — wybierz
teraz, zapisz w protokole i trzymaj dla wszystkich 10 runów."* Booked as `costUsd` of a PLAN child
in the run's `children.json`, held identically for all 10.

Basis: arm B's number **is** a plan child's `costUsd`, and it covers spec authoring. Booking
`plan.spec` the same way makes the comparison one quantity of one kind — a plan child's priced
`costUsd`, arm A against arm B. The alternative prices `plan.spec` as a session turn and arm B's
equivalent work as a child, i.e. it compares two pricing mechanisms for the same work.

### Q6 — where the `[G]` observability patch lands → **after the 10th run (Supervisor's call, 2026-10-08)**

Two windows were offered: before continuing run `arma-01r2`, or after the 10th run. Chosen:
**after run 10.**

- The standing rule is that run A never waits on a Lane-B child (sync 2026-10-08, item 3), and
  landing the patch first parks run `arma-01r2` across the whole dev → REVIEW → TEST → merge-gate
  → PR → merge chain.
- The argument for landing early does not survive the runner's own logic. It runs: a `[G]` failure
  with no event line understates arm A and biases toward a **false GO**. But `[G]` has no retry
  and `failed` is terminal on resume (`graph-runner.mjs:141`, `TERMINAL_STATUSES`) — so any run
  carrying an unrecorded failed `[G]` **dies and enters the §3 exclusions bucket**, which is never
  in a median. A completed run cannot hide one. The patch's cost-accounting value for the
  go/no-go is therefore nil; its value is diagnostic (provider error body, serving provider) and
  it lands for future campaigns.
- Neither change touches a go/no-go axis (patch contract AC4: request body and returned output
  byte-identical), so the window choice is about instrument uniformity, not about the numbers.
- Net: all 10 runs share one instrument and one runner sha, with no straddle across a patch.

### Q7 — frontman-tooling stall attribution → **A (Mateusz, 2026-10-08)**

*"liczba główna = wariant ostrożny, czyli postój WLICZONY w czas ramienia A. Wariant z wyłączeniem
idzie jako jawna linia wrażliwości. Ta sama zasada co przy koszcie."*

The stall (§4.2) is **in** the go/no-go exec figure. The exclusion is a reported sensitivity line.
This is the conservative direction and it is deliberately the same shape as Q4's cost rule: **the
main number is whichever variant cannot flatter arm A.** Cost books the Supervisor's arm-B-shaped
turns *in*; time books the harness's arm-B-absent stalls *in*. A metric that credited arm A for the
measurement harness's own failures would compare arm A plus a free lunch against arm B's real
history.

### Q8 — provider pinning is routing, not a model change → **named explicitly (FOC-691)**

FOC-691 stands untouched: **no model and no tier change for `plan.intent`.** Pinning an OpenRouter
upstream (provider order + `allow_fallbacks: false`) is a **routing** change — the model id
(`z-ai/glm-5.3-flash` via `routing.plan.discovery`) and the tier are byte-identical before and
after. It is nonetheless a change to what serves the request, so it is named explicitly here and in
`docs/STATE.md`, and it is subject to Q9's instrument boundary exactly like any other runner edit.

### Q9 — FOC-198 deferral and the provider-pinning trigger → **Supervisor's call, ordered by Mateusz (2026-10-08)**

Sequence **1 → 3 → 2**, not 1 → 2 → 3:

- **(1) one diagnostic `plan.intent` call** through `createDefaultGenerator` with a capturing
  `fetchImpl`, writing to no run — done 2026-10-08T15:30Z, see `docs/STATE.md`.
- **(3) corpus entry 2 (FOC-236) is next.** FOC-198 is **not** dropped and **not** swapped: its
  `armARuns` status becomes `deferred: infra (provider routing)` and it returns at the end of the
  campaign — **already on the pinned route** (Mateusz, 2026-10-10: *"FOC-198 zostaje na końcu
  kampanii, jak w Q9 — już na przypiętej trasie"*).
- **(2) provider pinning is the response to a repeated failure only** — it is armed if and only if
  FOC-236 fails the same way (the same `provider_error` HTTP 400 on `plan.intent`).

  **TRIGGER FIRED 2026-10-10 — decision: Mateusz.** Q9 is recorded as Mateusz dictated it:
  *"trigger odpalony 2026-10-10 na dowodzie z probe C (1× HTTP 400 jak FOC-198 + 2× inne awarie
  providera na 5 wywołań)"*. Five diagnostic generator probes on the
  attempt 3/4 reads (probe-C: `composeIntentInputs` → `createDefaultGenerator` with a capturing
  `fetchImpl`, bodies outside the repo) returned **1 × HTTP 400 `provider_error` on `plan.intent`**
  — exactly the FOC-198 failure class, now on the FOC-236 entry — plus **2 further provider-side
  failures out of 5** (one call whose response body never arrived and timed out at 420 000 ms; one
  OpenInference `finish_reason: error` with an upstream 502 and empty content). 0 of 5 produced a
  schema-valid map. The trigger fires **on its own terms, not widened**: the rule keyed on a
  repeated `provider_error` HTTP 400 on `plan.intent`, and probe 1 is that class verbatim.
  Mateusz, 2026-10-10: *"pierwotny trigger Q9 jest de facto spełniony, nie poszerzony."*
  The rejected alternative — a latency-spread threshold (> 10×) — measured the wrong thing and is
  retired: the identified providers sat at 1103 / 1775 / 3797 ms (3.4×), while the actual spread
  was in reliability.

  **Pinned route — same change as FOC-758, same instrument boundary.** Provider order
  `["wafer", "fireworks"]` with `allow_fallbacks: false`, recorded in `config/models.json` against
  `routing.plan.discovery`. Slugs are the exact OpenRouter identifiers (Wafer → `wafer`, Fireworks
  → `fireworks`; the second Fireworks endpoint `fireworks/us` exists and is deliberately **not**
  pinned). Model and tier are byte-identical before and after (Q8). The runner must actually send
  it — the `[G]` request body carries no `provider` field today — and the test asserts the request
  body (`order` + `allow_fallbacks: false`); the FOC-758 event line records which provider served.
  Acceptance is extended accordingly: 5/5 `runPlanIntentNode` → `done` in ≤ 1 regeneration **on the
  pinned route**, every serving provider ∈ {Wafer, Fireworks}. Otherwise the numbers are reported
  and **nothing lands**.

**If FOC-198 still will not start at the end of the campaign:** the main number counts it as an
**arm-A failure** (the conservative variant — a run that cannot start is not a cheap win), and the
result computed without it is reported as an explicit sensitivity line. **No corpus swap.** The
corpus was frozen before any arm-A run (§3) and is not reopened on outcome.

**Instrument boundary if (2) fires — hard rule.** Every counted arm-A run executes on the pinned
runner version; its `armARuns[].runnerSha` is recorded. Earlier attempts stay `excluded (C1)`.
**Versions are never mixed inside a counted set.** The change goes the full track — branch →
REVIEW → TEST → PR → merge — and **never lands in the middle of an active run**. The `[G]`
observability patch (old option C) rides the **same** change when (2) fires; standalone it waits
until after the 10th run (Q6).

### Q10 — the arm-A `plan.spec` model is a fixed instrument parameter → **Mateusz, 2026-10-10**

Mateusz: *"dotyczy też dziecka plan.spec w arm A — zapisz w protokole jego model jako stały element
przyrządu (zliczonego runu jeszcze nie ma, więc to nie jest ruch granicy)."*

The arm-A `plan.spec` PLAN child runs on **`z-ai/glm-5.3-flash`** — the model `config/models.json`
routes `plan` to. Held for all 10 runs, exactly as Q5 holds the booking shape. No counted arm-A run
exists yet, so fixing it is **not** a boundary move.

The operational rule that produced it (Mateusz, 2026-10-10, in force until FOC-762): **every spawn
carries an explicit `--model` from routing** — `plan`/`dev`/`review`/`test` = `z-ai/glm-5.3-flash`,
never inherited from `ANTHROPIC_MODEL`. So far 57 % of children inherited it, and 101 of them ran on
`xiaomi/mimo-v2.6-pro` while routing says glm-5.3-flash (review F2). And **never pass a `model`
parameter to `Task`**: the `sonnet` class resolves to `google/gemini-2.5-flash-lite`, the permission
classifier's model — work routed there by class name is a silent quality drop (F3).

`dev-1` (FOC-758) is the recorded exception: it runs on `xiaomi/mimo-v2.6-pro` and **finishes there
as-is** (*"dev-1 FOC-758 na mimo dokończ, jak jest; odnotuj w rekordzie"*). Last mimo child.

**Cost reporting until FOC-760.** Registry `costUsd` is reported annotated *"zawyżone (suma
narastających result)"*, never as "wycenione" — the watcher sums cumulative `result.modelUsage`
snapshots (review F4, 5.05× ground truth). A transcript-priced figure is reported wherever one
exists. The method, and with it the arm-B baseline correction, is FOC-759.

**FOC-759 — arm-B baseline, due before the first counted arm-A run.** The `armB.costUsd` figures are
registry numbers, 3.82× ground truth in sum ($7.51 recorded vs $1.97 transcript-priced over the 9
recoverable entries). They are recomputed from the PLAN children's transcripts (lead + `subagents/`,
dedup `message.id`, `pricingSnapshot()` + `calculateCost()`) into a **new field beside the old** —
the old stays as history, with a note saying why it is not used. **Baseline data, not the
instrument**: the boundary does not move, and FOC-758's landing is not blocked by it. FOC-198's
transcript is deleted and its three cumulative result values are non-monotone (0.023 → 0.045 →
0.009), so it needs a conservative rule; one is proposed and Mateusz decides.

**Q9's acceptance sentence is superseded.** The "5/5 … otherwise nothing lands" wording at the end
of the pinned-route paragraph was replaced **before** the measurement (Mateusz, 2026-10-10) — a map
rejected after one regeneration is a *landable* outcome, not a failure. The operative bar is
`foc758LandingCriterion20261010` in `docs/research/foc-477-runs.json` and the FOC-758 issue
description. Q9 is left as written; it records what was decided on 2026-10-08.

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
- **`z-ai/glm-5.3-flash` is multi-homed, and OpenRouter fails over between upstreams.** Same
  request, same model id, same schema: Fireworks returned 200, while CoreWeave → 429 → failover →
  Sail Research returned 400 `invalid_request_error` (probes 2026-10-08,
  `.state/foc-461-armA-probe-nits.md`, `.state/foc-477-armA/arma-01-attempt-1-failure.md`). Arm
  A's cost and time are therefore conditioned on routing the protocol does not control. All 10
  runs execute on the pre-patch runner (§7 Q6), which records no serving provider, so per-run
  upstream identity is unmeasured; the threat is stated from probe evidence and cannot be
  corrected per pair.
