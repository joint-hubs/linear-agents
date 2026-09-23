# plan.dod [G] — DoD-generation eval (FOC-474)

What the plan.dod generator node produces when it rides its registry prompt over the decided
input partition, measured against the 12 Fenix issues whose DoD Mateusz already approved
(`scripts/plan-dod-eval-fixture.json`, copied verbatim from the supervisor run
`2026-09-23T03-41-05-046-supervisor-adb3/fixture-dods.json`). Everything in the Results section
was **run and captured**, not recalled: raw outputs, event lines, usage and cost live under
`.state/foc-474/eval/<timestamp>/` (gitignored).

- Harness: `scripts/plan-dod-eval.mjs` (committed); fixture: `scripts/plan-dod-eval-fixture.json`.
- Transport under test: the runner's own `createDefaultGenerator` — the exact transport a live
  graph run uses, driven one call per issue without standing up a run.
- Model: `z-ai/glm-5.3-flash` (config/models.json `routing.plan.discovery`, the cheap tier);
  strict `response_format: json_schema` with the step's output schema; `usage: {include: true}`
  so cost is the provider's own meter, not an estimate.
- Re-run: `node scripts/plan-dod-eval.mjs` (exit 0 = completed, 3 = no `OPENROUTER_API_KEY`).
  Artifacts per run: `outputs.jsonl` (per-issue inputs as built, output, usage, cost),
  `summary.json`, `table.txt`, and the FOC-449 event lines under `<run-id>/decisions.jsonl`.

## Input partition (the decided contract, FOC-474 point 1)

`plan.dod.reads = ["inbox.entry"]` — one declared read. The runtime payload the CALLER
deterministically extracts carries:

- the issue title, and
- the accepted scope summary — the description with (a) the **approved DoD section stripped**
  (from the `## Definition of [Dd]one` heading, or the inline `**Definition of done:**` /
  `**DoD:**` marker, to the next `## ` heading or end of text) and (b) the terminal
  `<!-- fenix-roadmap-… -->` metadata block stripped. Both strips are documented in the harness
  and pinned by `scripts/plan-dod.test.mjs`: no ground-truth line and no roadmap metadata
  appears in any scope summary.

The repo's DoD conventions (suite green, lint exit 0, the docs state file updated, one commit
carrying the issue id) live in the registry prompt — never in the per-issue payload. The
approved DoD section is **ground truth** and never enters the inputs. No tools, no repo access,
one structured call. (Design refs: graph-json-v2-design §3.2 "every node declares its minimal
input fields — context size is a design output, not an accident", the plan.dod contract block,
and §4's one-[G]-step walkthrough.)

## Where the [G] answers land (the carried FOC-452 question, settled)

The I/O-log settlement (FOC-474 points 2–3): a [G] call persists as a **FOC-449 event line** in
the run's `decisions.jsonl` — full input as sent (mask-only scrub), parsed output as `answers`,
usage/cost, latency, `decisionId = <stepId>`, `criteriaVersion` — written by the fixed default
generator through `decision-call.mjs`'s own writer (`appendShadow`), never a forked append. It
is **not** an outcome label: `outcomeFor` / `LABEL_FIELD` / `autoLabel` stay [J]/gate-only
(`type`-suffix `"feature"`), and plan.dod never produces an outcome label — ADR-0012 D7: only
[J]/[D]/[H] decide gates. The step record lands in `graph-steps.jsonl` as before (the done
record holds the schema-validated output); the event line is the second, I/O ledger. A failed or
unparseable call appends **nothing** — the typed failure record in the run store is the only
trace, and no fabricated answers are ever written.

## Rubric (human-graded — the harness ships outputs, not grades)

Per issue, against the fixture's ground truth:

- **complete** — every ground-truth item's substance appears as a DoD item (paraphrase is fine).
  FOC-406 has no approved DoD in the fixture → reported **UNKNOWN**, excluded from the
  completeness aggregate (never scored a fake pass).
- **verifiable** — items are checkable statements (a named test or suite, a lint/static exit,
  a concrete manual step, a Linear-side fact); vague wishes lose the point.
- **no-invented-scope** — nothing the issue does not name. Repo-convention items (suite green,
  lint, STATE.md, one commit with the issue id) are legitimate substance per the registry prompt;
  an item derived from the scope but *wrong on its face* (e.g. naming the wrong issue id) is
  flagged here.
- Verdict: **pass / partial / fail**, one-line reason per issue. A FAIL verdict is a
  measurement, not an error (codegraph-benchmark posture).

## Results

Two recorded runs, same prompt (registry `criteriaVersion 1`), same fixture, real cheap-tier
calls. **Run 1** (2026-09-23T05:15Z, runner-default 120s budget): **5/12 ok, 7 failed** — every
failure the same transport defect (`provider_error … timed out` mid-generation at 120s; fixed in
09c6521, see Findings). **Run 2** (2026-09-23T05:48Z, 300s budget): **12/12 ok, 12/12
schema-valid, 0 failed** — 9,405 in / 166,278 out tokens, **$0.0844 total (~$0.007/issue,
provider-metered)**. Both runs' artifacts under `.state/foc-474/eval/` (run 1
`2026-09-23T04-58-31`, run 2 `2026-09-23T05-17-35`); combined eval spend **$0.0908**.

Run-2 table (mechanical facts from `table.txt`; latency = measured call duration):

| id | items | kinds | latency | in/out tok | cost USD |
|---|---|---|---|---|---|
| FOC-406 | 10 | test,lint,manual,linear | 117.4s | 539/10495 | 0.005328 |
| FOC-416 | 7 | lint,manual,test | 99.2s | 783/8047 | 0.004141 |
| FOC-417 | 12 | test,manual,lint,linear | 25.4s | 1171/609 | 0.000330 |
| FOC-441 | 6 | manual,lint | 191.7s | 808/13418 | 0.006830 |
| FOC-443 | 8 | manual,test,lint,linear | 206.3s | 907/18886 | 0.009579 |
| FOC-473 | 11 | manual,test,lint,linear | 169.2s | 814/18077 | 0.009161 |
| FOC-448 | 12 | test,manual,lint,linear | 185.0s | 797/20381 | 0.010310 |
| FOC-449 | 12 | test,lint,manual,linear | 181.9s | 788/17417 | 0.008827 |
| FOC-397 | 11 | test,lint,manual,linear | 141.2s | 681/14754 | 0.007479 |
| FOC-451 | 8 | manual,test,linear,lint | 102.5s | 722/10550 | 0.005383 |
| FOC-452 | 11 | test,lint,linear,manual | 141.8s | 671/17296 | 0.008749 |
| FOC-396 | 11 | manual,test,lint | 299.2s | 724/16348 | 0.008283 |

Human rubric, run-2 outputs against the fixture's approved DoD (per-issue one-line reason;
complete/verifiable/no-invented-scope as defined above):

| id | complete | verifiable | no-invented-scope | verdict |
|---|---|---|---|---|
| FOC-406 | UNKNOWN | pass | pass | **pass** — no approved DoD exists; every item checkable; the "FOC-400 scenario" name is carried by the payload scope, not invented |
| FOC-416 | partial | pass | flagged | **partial** — all three fixes + suite + lint + one-commit covered; the "diff limited to scripts/mcp/**" boundary item missing; commit item names FOC-401 (in payload, not the issue's own id) |
| FOC-417 | partial | pass | flagged | **partial** — scrub/truncate substance deep (helper, key shapes, 3 reject-path tests); `npm ci` prep and the exact commit-message form missing; wrong id (FOC-401) |
| FOC-441 | pass | pass | pass | **pass** — commit, lint and the docs-only boundary all present ("diff touches no files under scripts/**"); sweep items are in scope |
| FOC-443 | pass | pass | pass | **pass** — commit plus both substance areas (scrub routing, catalog wording) plus STATE.md; nothing invented |
| FOC-473 | partial | pass | pass | **partial** — ADR substance deep (D7, never-decides-gates, honest guarantees) + suite/lint/STATE; "accepted by Mateusz" and "comment on the epic" missing — both GT-only, not in inputs |
| FOC-448 | partial | pass | pass | **partial** — J1 registry substance deep; test-count guard (not derivable), the J2 decision-log item and the sub-epic comment missing |
| FOC-449 | partial | pass | flagged | **partial** — J2 I/O-log substance deep (event fields, scrub, label join, export splits); guard not derivable; wrong id (FOC-386) |
| FOC-397 | partial | pass | flagged | **partial** — runner substance + STATE.md + epic-comment present; guard not derivable; wrong id (FOC-380) |
| FOC-451 | partial | pass | pass | **partial** — triage/task-size substance + the J2 label join; guard (not derivable), STATE.md and the sub-epic comment missing |
| FOC-452 | partial | pass | flagged | **partial** — gate substance deep; guard not derivable; one item contradicts the scope ("candidates … via Linear search" — the contract injects candidates, Linear search is out of scope) |
| FOC-396 | partial | pass | pass | **partial** — all six design-content items in scope + design-only diff + STATE.md; the GT's merge action and epic-comment link absent |

**Aggregate (11 issues with ground truth):** complete 2/11 · verifiable 11/11 ·
no-invented-scope 5/11 clean (4 wrong-id flags, 1 scope inversion) · **verdicts 2 pass / 9
partial / 0 fail.** FOC-406 (no ground truth): pass, completeness **UNKNOWN**, excluded from the
completeness aggregate.

## Findings

1. **Timeout finding (the run-1 defect, fixed).** The runner's 120s default aborted 7/12
   mid-generation; every failure surfaced as `provider_error "[G] plan.dod response is not JSON:
   …aborted"` because the abort fired during the body read and the json() catch mislabeled it.
   Fix (09c6521): an `isAbort` classifier in both catch sites (AbortError/TimeoutError →
   `provider_error … timed out after Nms`), eval budget 300s. Not generosity — run 2's FOC-396
   call took **299.2s**, 0.8s under the cap.
2. **Latency/length variance is extreme for identical inputs.** Same prompt, same payload:
   FOC-406 13s/310tok (run 1) vs 117s/10.5k (run 2); FOC-443 119.9s/11k vs 206s/18.9k; FOC-473
   120s-timeout vs 169s/18k. Per-call latency span in run 2: 25.4s–299.2s; output 609–20,381
   tokens. A [G] step's wall-clock is therefore a budget question for FOC-475/476, not a constant.
3. **The wrong-id pattern (payload finding).** 4/12 outputs pin a related issue's id into the
   commit item (416→FOC-401, 417→FOC-401, 449→FOC-386, 397→FOC-380) — every named id IS in the
   payload scope text (derived, not hallucinated), and the payload carries no field for the
   issue's OWN id, so "one commit carries the issue id" resolves to the most salient id it sees.
   Partition amendment candidate for FOC-475: add `issue.id` to the input. Not changed here.
4. **The not-derivable ground truth (partition finding).** The template item "docs test-count
   guard passes" appears in **0/24 outputs** across both runs — it exists only inside the
   stripped DoD section: never in any scope summary, never in the registry prompt (grep = 0).
   Same for "ADR accepted by Mateusz" and the epic-comment items. The generator correctly refuses
   to invent them. The completeness gap vs the approved-DoD template is therefore a **property of
   the input partition**, not a model or prompt defect — and it is structural: the guard is
   conditional on what the diff touches, which no pre-diff generator can know.
5. **Prompt-tuning decision: NO — criteriaVersion stays 1.** Two reasons. (a) The repeated
   misses are not derivable from the inputs; baking them into the registry prompt would fit the
   generator to the answer key — exactly what the partition forbids. (b) The genuinely derivable
   misses (boundary items, the merge action) flip between runs (e.g. FOC-448's STATE.md item
   absent in run 1, present in run 2) → generation variance, not prompt defect. A criteriaVersion
   bump here would also churn the pins FOC-475 inherits.
6. **Cost honesty.** Combined eval spend **$0.0908** for 17 successful + 7 failed real calls
   (run 1's 5 successes: $0.0064). Cost rides the provider's own meter (`usage.include: true`)
   joined per issue from the FOC-449 event lines — no second meter, no estimate.

## Notes for FOC-475 / FOC-476

- **Transport is done and shared.** `createDefaultGenerator` is step-agnostic: FOC-475's
  `plan.ac` node (merged in e31d971, untouched since) inherits the registry prompt, schema
  enforcement, event-line ledger, timeout classification and 300s-headroom lesson for free — no
  ac-split-specific transport work remains.
- **Partition amendment candidate:** add `issue.id` to the input (Finding 3). That is a
  decided-partition change and belongs to the consumer task, not this one.
- **Conditional conventions (Finding 4):** either the consumer post-fills diff-conditional items
  (guard, manual gates) or the DoD template accepts their absence; do NOT push them into the
  registry prompt as unconditional conventions.
- **Budget:** a cheap-tier [G] call measured up to 299s. Whatever runtime drives steps needs a
  wall-clock policy (async, or a step-level budget wider than the old 120s default) before
  FOC-476 wires plan.dod/plan.ac into live PLAN runs.
