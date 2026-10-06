# plan.intent [G] — interpretation-map eval (FOC-515)

What the `plan.intent` generator node produces when it rides its registry prompt over the decided
input partition, measured against the 12 Fenix issues whose DoD/AC Mateusz already approved
(`scripts/plan-intent-eval-fixture.json`, descriptions copied verbatim from the plan.dod eval's
`scripts/plan-dod-eval-fixture.json`). Everything in the Results section was **run and captured**,
not recalled: raw outputs, event lines, usage and cost live under `.state/foc-515/eval/<run>/`
(gitignored).

- Harness: `scripts/plan-intent-eval.mjs` (committed); fixture: `scripts/plan-intent-eval-fixture.json`.
- Transport under test: the runner's own `createDefaultGenerator` driving the REAL node loop
  (`runPlanIntentNode`, including the one-regeneration-then-stop policy) — the exact composition a
  live graph run uses, without standing up a run.
- Model: `z-ai/glm-5.3-flash` (`config/models.json` `routing.plan.discovery`, the cheap tier);
  strict `response_format: json_schema` with the step's output schema; `usage: {include: true}` so
  cost is the provider's own meter, not an estimate.
- Re-run: `node scripts/plan-intent-eval.mjs` (exit 0 = completed, 3 = no `OPENROUTER_API_KEY`).
  Artifacts per run: `outputs.jsonl` (per-case inputs as built, output, the [D] check results, the
  AJV errors where a map was refused, usage, cost), `summary.json`, `table.txt`, and the FOC-449
  event lines under `<run-id>/decisions.jsonl`.

> **Read this first — the two numbers Mateusz asked for.** p90 latency is **600 s** (the abort
> budget itself, so the true value is *at least* that); cost is **$0.00156 per call**. The latency
> threshold is blown by a factor of 20, so the numbers are spelled out below rather than summarised.
> **No model, tier or routing was changed** to obtain them.

## Input partition (mirroring the plan.ac eval's decided point 4)

`plan.intent.reads = ["inbox.entry", "plan.dor.gaps", "intake.taskType"]` (plus the two gate fields
from round 2). The runtime payload the CALLER deterministically extracts carries:

- `inbox.entry` = `{issueId, title, scopeSummary}` — the scope summary is the description with
  (a) the **ground-truth sections stripped**, *both* the Acceptance-criteria and the
  Definition-of-done section in their heading and inline-marker shapes, and (b) the terminal
  `<!-- fenix-roadmap-… -->` metadata block stripped. Both strips are documented in the harness and
  pinned by `scripts/plan-intent.test.mjs`: no ground-truth marker and no roadmap metadata appears
  in any scope summary. The key is stripped because the rubric grades whether a known scope or
  boundary miss comes back as an `inferred`/`unknown` item — it can only do that if the miss is
  **not** in the model's input.
- `plan.dor.gaps` and `intake.taskType` come from the fixture's two eval-only columns, standing in
  for the upstream reads FOC-397 wires. They are **evaluation inputs, not ground truth**: authored
  from each issue's own Context + Scope/Deliverable text alone. The AC/DoD sections were not
  consulted when writing them, and a pin test asserts that no gap string occurs in the stripped key
  — otherwise a gap would leak the answer back through `covers`.
- The round-2 reads (`gate.plan.gate1.answers` / `.corrections`) are **not fed**: FOC-517 owns the
  gate's write side and there is no conversation to fold in an eval. Every case runs round 1. The
  fold is covered by `scripts/plan-intent.test.mjs` instead.

FOC-406 carries `taskType: "unknown"` on purpose — its type was never set — which exercises the
fail-closed all-eight-perspectives path. It has neither an AC nor a DoD section, so its coverage is
reported **UNKNOWN** and it is excluded from the coverage aggregate (never scored a fake pass).

No tools, no repo access, one structured call per attempt. (Design refs: graph-json-v2-design §3.12.)

## Where the [G] answers land (the FOC-474 settlement, inherited)

Identical to the plan.dod eval: a [G] call persists as a **FOC-449 event line** in the run's
`decisions.jsonl` — full input as sent (mask-only scrub), parsed output as `answers`, usage/cost,
latency, `decisionId = plan.intent` — written by the fixed default generator through
`decision-call.mjs`'s own `appendShadow`. It is **not** an outcome label; ADR-0012 D7: only
[J]/[D]/[H] decide gates. A failed or unparseable call appends **nothing**, so the typed failure
record in the run store is the only trace.

One consequence matters for the numbers below: **an aborted call writes no event line**, so its
tokens and cost are absent from the totals even though the provider generated for the whole budget.
The totals understate real spend, and the report says so rather than reporting a clean $0.0218.

## Rubric (human-graded — the harness ships outputs, not grades)

Per case, against the fixture's stripped ground truth:

- **gap coverage** — each declared `plan.dor.gaps` entry is covered by at least one interpretation's
  `covers` field (check (a) enforces this mechanically; the rubric checks the cover is *substantive*,
  not a verbatim repeat that adds nothing).
- **known scope/boundary misses** — where the stripped AC/DoD names a boundary the entry leaves open,
  does the map surface it as an `inferred`/`unknown` item?
- **no-noise (pointless)** — no interpretation that adds nothing beyond another. Extra perspectives
  beyond what the task type requires are permitted by the contract ("smallest sufficient set") but
  counted here as mild noise.
- **no-invented** — nothing the entry does not support. Every `quote` is *mechanically* verified
  verbatim in the anchor text by check (c), so invention can only enter through a claim that
  over-reads its quote — which is what this column grades.
- Verdict: **pass / partial / fail**. A FAIL verdict is a measurement, not an error
  (codegraph-benchmark posture).

## Results

**Run 2** (2026-09-26T12:33–14:04Z, `--timeout 600000`): 12/12 cases attempted, **4 ok /
8 rejected** — 3 aborted at the 600 s budget, 5 rejected as `schema_invalid` after one retry. 14 real
calls, 5 retries, 23,421 in / **105,936 out** tokens, **$0.021834 total** (provider-metered).

> **Budget deviation, named.** The contract specifies **300 s/call**. That budget is insufficient for
> this node and was measured, not assumed: the 300 s smoke run on FOC-406 aborted
> (`provider_error "request timed out after 300000ms"`). Run 2 therefore uses 600 s and the headline
> numbers are from that budget. Derived from run 2's *measured* per-case wall times (arithmetic on
> measurements, not a second run): at 300 s, **6 of 12** cases would abort — the 3 that abort at
> 600 s plus FOC-417 (414.6 s), FOC-416 (442.1 s) and FOC-441 (489.4 s). Only FOC-443 (217.8 s) and
> the five 17–39 s schema-rejects fit inside 300 s.

Mechanical facts from `table.txt` (latency = node wall-clock, aborts included):

| id | items | stated/inf/un | latency | in/out tok | cost USD | retries | errors |
|---|---|---|---|---|---|---|---|
| FOC-406 | – | – | 600.1s | – | – | 0 | `provider_error` (aborted at 600s) |
| FOC-416 | 11 | 3/5/3 | 442.1s | 1080/25113 | 0.003564 | 0 | – |
| FOC-417 | 12 | 6/3/3 | 414.6s | 1248/26073 | 0.003706 | 0 | – |
| FOC-441 | 10 | 4/2/4 | 489.4s | 1112/26039 | 0.003696 | 0 | – |
| FOC-443 | 10 | 5/2/3 | 217.8s | 1309/15277 | 0.002198 | 0 | – |
| FOC-473 | – | – | 600.0s | – | – | 0 | `provider_error` (aborted at 600s) |
| FOC-448 | – | – | 600.0s | – | – | 0 | `provider_error` (aborted at 600s) |
| FOC-449 | – | – | 39.0s | 3768/3255 | 0.002159 | 1 | `schema_invalid` |
| FOC-397 | – | – | 22.4s | 3760/2945 | 0.002029 | 1 | `schema_invalid` |
| FOC-451 | – | – | 18.1s | 3720/2242 | 0.001399 | 1 | `[D] checks` — 5 problems (schema passed) |
| FOC-452 | – | – | 20.9s | 3650/2897 | 0.001756 | 1 | `schema_invalid` |
| FOC-396 | – | – | 17.3s | 3774/2095 | 0.001327 | 1 | `schema_invalid` |

`errors` is the *cause*, read off `checks.schemaExternal` / `schemaErrors`, not the node's error code —
the node codes every map rejection `schema_invalid`, including the ones the schema passed (FOC-451).
`schemaErrors` carries the raw AJV list per attempt; `checks` carries the three [D] results.

**Aggregates (12 cases, 14 calls):** latency min 17.3 s · p50 217.8 s · **p90 600.0 s** · max 600.1 s;
tokens 23,421 in / 105,936 out; cost **$0.021834 total**, **$0.001560 per call**; items 43 across the
4 accepted maps (10–12 each); source mix **stated 18 / inferred 12 / unknown 13**; retries 5;
aborted 3 (FOC-406, FOC-473, FOC-448).

Human rubric on the 4 accepted maps (the 8 rejected cases produced no map and are graded
`fail` as a measurement — the node stopped fail-closed, which is the designed behaviour):

| id | gap coverage | known misses surfaced | pointless | invented | verdict |
|---|---|---|---|---|---|
| FOC-416 | 3/3 | partial — the `scripts/mcp/**` diff boundary (DoD) is not surfaced | IN-8 (`user`, not required for `tech`) | none | **pass** |
| FOC-417 | 3/3 | partial — "docs in sync" (AC-6) not surfaced | IN-12 (`priority`, not required) | none | **pass** |
| FOC-441 | 3/3 | pass — the "executable copy" invariant lands as IN-7 `unknown` | IN-9 (`user`, not required for `docs`) | none | **pass** |
| FOC-443 | 3/3 | pass — both wording/interactions land as IN-5, IN-8 `unknown` | IN-10 (`priority`, not required) | **flagged** — IN-2 adds "nie obejmuje innych ścieżek błędów", an exclusion the entry never states | **partial** |
| FOC-406 | – | **UNKNOWN** (no ground truth) | – | – | excluded |
| FOC-473 / FOC-448 | no map | – | – | – | **fail** (aborted) |
| FOC-449 / FOC-397 / FOC-452 / FOC-396 | no map | – | – | – | **fail** (refused by the output schema) |
| FOC-451 | no map (refused) | – | – | – | **fail** (refused by the [D] checks) |

Per-target rubric — the input-arising targets are the fixture's declared DoR gaps (3 per case);
`covers` matches the gap text verbatim (check (a) rejects anything else):

| id | input-arising target | covered by | pointless | invented | verdict |
|---|---|---|---|---|---|
| FOC-416 | which tests pin the silent `--mode` fallback | IN-10 `unknown` | no | no | pass |
| FOC-416 | what the valid `--mode` values are | IN-11 `unknown` | no | no | pass |
| FOC-416 | dead enum kinds: remove or implement | IN-3 `unknown` | no | no | pass |
| FOC-417 | the truncation cap value | IN-7 `unknown` | no | no | pass |
| FOC-417 | the scrub helper's return shape | IN-8 `unknown` | no | no | pass |
| FOC-417 | which further sites echo provider text | IN-4 `unknown` | no | no | pass |
| FOC-441 | which other catalog values drifted | IN-3 `unknown` | no | no | pass |
| FOC-441 | how the "executable copy" invariant is checked | IN-7 `unknown` | no | no | pass |
| FOC-441 | no test surface for a docs-only change | IN-4 `unknown` | no | no | pass |
| FOC-443 | the replacement wording for the Security note | IN-5 `unknown` | no | no | pass |
| FOC-443 | whether a test-shadow file exists | IN-3 `unknown` | no | no | pass |
| FOC-443 | `MAX_ERROR_TEXT` vs the 120-char parse cap | IN-8 `unknown` | no | no | pass |

**Aggregate (4 accepted maps):** gap coverage **12/12** targets, every one covered by a dedicated
`unknown` item whose `options` offer 2–4 ways to close it · no-noise 1/4 clean (3 mild
extra-perspective items) · no-invented 3/4 clean (1 over-read) · **verdicts 3 pass / 1 partial /
0 fail**. FOC-406 coverage **UNKNOWN**, excluded. The 8 rejected cases are `fail` — a map that
survived none of the three checks is not gradeable and is never scored as partial.

## Findings

1. **`response_format: json_schema, strict: true` is NOT enforced on this tier.** Run 1 proved it:
   against a schema naming `claim`/`quote`/`alternatives`/`IN-N`, the model returned
   `reading`/`quotes`/`alternative`/`I1` and the map was refused as `schema_invalid`. The schema is
   *advisory* through this transport, so every field name has to be taught in the prompt as well.
   Any node built on `createDefaultGenerator` inherits this: a passing `validate()` is a real gate,
   not a formality.
2. **The schema-conformance rate is 5/12 even after the contract is spelled out.** Of the 9 cases
   that returned a parseable map, 5 passed the output schema and 4 were refused by it. The four
   refusals are small and specific — an invented `claim_alt` property (FOC-449), a 150-char `quote`
   overflow plus a `then`-clause miss (FOC-397), three out-of-enum `perspective` values (FOC-452),
   `options` missing on an `unknown` item and then `recommended` missing inside the option objects it
   did emit (FOC-396, 4 errors on attempt 1 and 4 on attempt 2). This is generation variance against
   a contract the provider does not enforce, not a defect in the schema: every accepted map validated
   exactly. The 5th non-aborted reject (FOC-451) passed the schema and was refused by the [D] checks.
3. **Latency is dominated by mandatory reasoning, and it is bimodal.** The provider returns
   `reasoning` alongside `content`; one measured call carried **90,091 chars of reasoning** against
   9,788 chars of map (23,669 of 27,604 completion tokens were reasoning). That is why the four
   successes take 218–489 s while the five rejects return in 17–39 s with 2–3k tokens — a *small*
   fast answer is the one that fails the schema. Wall-clock for a [G] step is therefore a budget
   question for FOC-476, not a constant, and 300 s is below this node's floor.
4. **FOC-451 is the fail-closed design working, in production.** It is the only case that passed the
   schema and reached the three [D] checks — and all three fired: two `plan.dor.gaps` entries
   uncovered by any COUNTING interpretation (check a), required perspectives `user` and `priority`
   absent (check b), and one `quote` that was a *paraphrase* of the anchor text (check c). The map
   was refused, retried once with those five reasons, and stopped with one typed failure record.
   Nothing partial was persisted. That is exactly the §3.12 contract.
5. **The accepted maps are substantively good.** First-person Polish readings, correct perspective
   attribution (`stated`/`inferred`/`unknown` split 18/12/13), all 12 gaps covered with 2–4 closing
   options on every `unknown` item, and **every quote mechanically verified verbatim** by check (c).
   The single invention found is one over-read clause, not a fabricated requirement.
6. **Cost honesty.** $0.021834 covers 14 completed calls ($0.001560/call, comfortably under the
   $0.01 threshold). The three aborted cases are **not in that total** — an abort writes no FOC-449
   event line, so the ~27k completion tokens the provider generated for each within the 600 s budget
   are invisible to our ledger. Real spend for the run is higher than $0.0218 and cannot be
   reconstructed from our own records.
7. **Prompt change: one, and it is not tuning.** Run 1's rejection was a prompt↔schema vocabulary
   mismatch, fixed in `e3962e7` by naming the exact per-item shape, the `IN-1`…`IN-12` id form and the
   field caps. That is a schema-contract repair: it references no ground-truth line and
   `criteriaVersion` stays **1**. Further prompt iteration to lift the 4/12 conformance rate was
   deliberately **not** done — at that point the prompt would be being fitted to the answer key.

## Notes for FOC-476 (live PLAN wire-up)

- **Do not plan around a 300 s [G] step.** Measure the budget at 600 s+ and expect three outcomes
  (accepted map, schema-invalid stop, abort). The step's `failure: "stop"` means an abort is a run
  stop, not a retry — the budget has to be right the first time.
- **Cheaper/faster tier candidates are the obvious lever**, and the reasoning volume is the reason.
  This report changes no model, tier or routing — `config/models.json` is untouched and the call
  rides `routing.plan.discovery` → `ids.glm53flash`. Swapping the tier is a decision for Mateusz,
  with these numbers as the comparison baseline.
- **A schema-rejection loop is worth more than a bigger budget.** The five non-aborted rejects were
  cheap (17–39 s, $0.0013–0.0022) and failed on trivia a validator could name precisely — the
  harness now captures the AJV detail the node discards, and folding that detail into the retry note
  is a small, high-value change for a later task.
- **Cost accounting for aborts needs a policy.** A failed call appends no event line by design (no
  fabricated answers), so aborted spend is unobservable. FOC-449 may want a failure-line variant that
  records usage without answers.

---

## Addendum 2026-10-01 — FOC-596: latency re-measurement, output-shape pre-commitment (lever 2), contract budget (lever 4)

Same 12-case fixture, same transport (`createDefaultGenerator` driving the real `runPlanIntentNode`,
one-regeneration-then-stop), runs serial on one machine. Artifacts under
`.state/foc-596/eval/<run>/` (gitignored), one directory per run.

**Explicitly named — what changed and what did not:**

- **Model: unchanged.** `z-ai/glm-5.3-flash`, `config/models.json` untouched, call rides
  `routing.plan.discovery` → `ids.glm53flash`. **No tier change. No routing change.**
- **Prompt: one change (lever 2 only)** in `config/decisions.json` (the `plan.intent` registry
  entry's `prompt` field): output-shape pre-commitment prepended to the map instructions —
  *"Decide the map's shape before you draft anything: fix how many interpretations there will be
  and each one's perspective and source first, then fill every field once within the caps below —
  never write a long draft and cut it down."* No reasoning-length instruction was added (that is
  lever 1 — the model-policy decision, Mateusz's), and `criteriaVersion` stays **1** (the output
  contract is unchanged; precedent `e3962e7`). One lever per change, so the delta stays legible.
- **Harness budget: named per run** (lever 4). 600 000 ms per call for the lever-2 delta runs (same
  headroom as the FOC-515 baseline), 300 000 ms = the decided eval contract budget for the
  lever-4 run.
- **Lever 3 stays unavailable:** `response_format: json_schema, strict: true` is not enforced by
  `z-ai/glm-5.3-flash` through OpenRouter, so the schema-retry path cannot be cut at the transport.

### Run matrix (2026-10-01)

| run | prompt | timeout | ok/12 | rejected | aborted | p50 | p90 | max | calls | cost (priced) |
|---|---|---|---|---|---|---|---|---|---|---|
| `before-600s` | pre-change | 600 s | 3 | 7 | 2 | 56.6 s | 600.0 s | 600.1 s | 17 | $0.016203 |
| `after-600s` | lever 2 | 600 s | 1 | 11 | 0 | 32.7 s | 47.9 s | 47.9 s | 24 | $0.019731 |
| `after-300s` | lever 2 | 300 s | 1 | 11 | 0 | 25.7 s | 38.7 s | 40.5 s | 24 | $0.020989 |
| `after-600s-rep` | lever 2 | 600 s | 0 | 12 | 0 | 26.3 s | 33.2 s | 564.3 s | 22 | $0.020303 |
| `before-600s-rep` | pre-change | 600 s | 6 | 6 | 0 | 222.8 s | 545.9 s | 900.4 s | 10 | $0.147735 |

Every rejected case got at most one regeneration, per the node's policy; `retries` = 12/12, 12/12 and
11/12 in the lever-2 runs vs 7/12 and 3/12 on the pre-change prompt (aborts and fast transport
failures never reached a retry). Per-case wall-clock spans that regeneration when one happened, so
`max` can exceed the 600 s call budget — `before-600s-rep`'s FOC-396: 900.4 s over two calls.

### Reading the numbers

1. **Day drift is now sized (n=2 per prompt at 600 s), and it is larger than the effect under
   test.** The pre-change prompt ran p50 56.6 s / p90 600.0 s (3/12 accepted) in the morning and
   p50 222.8 s / p90 545.9 s (6/12) two hours later — same prompt, fixture, model and routing. The
   mechanism is visible in the output tokens: every lever-2 call returns 3–5k out-tokens, while the
   pre-change replicate's accepted maps ran 24–68k out-tokens each (run total $0.147735 — 9× the
   morning run's $0.016203) and its wall-clock sits in the 2026-09-26 baseline's 218–489 s regime,
   while the morning run sat in the 33–44 s regime. Day drift here is a provider-side output-length
   regime flip. Lever 2 pins output length and therefore latency (p50 25.7–32.7 s, p90 33.2–47.9 s,
   zero aborts across three runs) — but that is enforced shortness, not a faster model.
2. **Conformance: pre-change 3/12 and 6/12 accepted vs lever-2 1/12, 1/12, 0/12 — and the failure
   modes differ by prompt.** Lever 2 fails structurally: `covers` (required field) omitted — 5/179
   items (2.8%) in `before-600s`, 10/247 (4.0%) in `after-600s`, 23/239 (9.6%) in `after-300s` —
   plus the [D] checks doing their job (uncovered `plan.dor.gaps`, missing `user`/`priority`
   perspectives, one paraphrased quote). The pre-change replicate fails differently: 4×
   `unparseable_output` (two at ~2 s, two at 222–258 s), 1× schema-invalid, 1× provider error —
   and its six accepted maps are complete (64 items, 8–12 per case). "Fill every field once"
   plausibly reads as "hurry": the shape gets pre-committed and the fields do not.
3. **Neither prompt meets the bar; lever 2 as written does not earn its place.** Pre-change
   conformance (25–50%) is better, but its latency and cost are uncontrolled (p50 56.6 → 222.8 s,
   run cost 9×, p90 at the mercy of the provider regime). Lever 2 buys a bounded p90 (≤ 48 s, no
   aborts) at conformance 0–8%. Named options are in the FOC-596 close report: (a) revert the
   sentence, (b) a second named iteration — an explicit `covers: [...]` never-omit rule, still no
   reasoning-length instruction (that is lever 1, Mateusz's), (c) keep the sentence and land the
   structural fix as follow-up. Lever 3 (strict `json_schema`) remains provider-blocked.
4. **Cost honesty:** $0.016–$0.148 per run. Accepted pre-change maps are long and expensive
   (24–68k out-tokens each); lever-2 calls are short ($0.0008–0.0025 per call). As in the base
   report, an aborted or unparseable call writes no FOC-449 event line and often no usage line, so
   failed-call spend is invisible to the ledger and real spend is higher than the run totals.

### Caveats on the comparison

- **n = 2 per prompt at 600 s** (`after-300s` n = 1), same 12 cases — a paired comparison, not a
  distributional claim. The pre-change pair's own spread (3/12 → 6/12 accepted, p50 ×4, cost ×9)
  exceeds every between-prompt difference claimed here, and is reported for exactly that reason.
- **Prompt provenance is by construction:** `before-600s-rep` was launched with the lever-2 sentence
  edited out of the working tree, and the sentence was restored only after the run finished. The
  harness loads `plan.intent` once at `runEval` start, so a mid-run edit cannot leak into a running
  process. The FOC-449 `hash` field is a per-case input hash (identical across runs) and does not
  encode the prompt version.
- Per-case wall-clock includes the one regeneration when it happened (see the note under the
  matrix), so `max` can exceed the call budget.
- Latency is node wall-clock of the model call only (no [D] checks, no IO), as in the base report.
- Same model, tier and routing in every run — **no model/tier/routing change is claimed anywhere in
  this addendum.**

---

## plan.intent.select eval (FOC-516) — [J] scores + [D] policy on the same eval set

The select eval drives the FULL live pipeline per fixture case — the same two node calls a live
graph run executes: `runPlanIntentNode` (the [G] map, runner default generator) then
`runPlanIntentSelectNode` (the ONE `plan.intent.select.score` [J] call per map, two noul verdicts —
impact + grounded — per interpretation, via the real seam caller), both against the real transports
(`scripts/plan-intent-select-eval.mjs`). A case whose map fails closed has nothing to select from —
the skip IS the measurement, never a faked row.

**Run** (2026-10-01T17:34–17:45Z, contract budget 300 s/call both stages — no deviation): 12/12
cases attempted → **2 selection ok / 10 skipped** (no map), 0 failed. Both accepted selections were
schema-valid. Live provider: `z-ai/glm-5.3-flash` (maps) + `typesafe/jev-1.13-20260917` (scores).

Where the 10 skips come from — the map stage, not the selection:

| map failure | cases | detail |
|---|---|---|
| `provider_error` (fast) | FOC-416 (0.6 s), FOC-449 (1.1 s), FOC-397 (1.3 s), FOC-451 (1.5 s), FOC-396 (0.9 s) | HTTP 400 within seconds of the call |
| `provider_error` (budget) | FOC-452 | aborted at the 300 s budget |
| `unparseable_output` (fast) | FOC-417 (1.3 s), FOC-441 (1.8 s), FOC-473 (1.3 s), FOC-448 (2.7 s) | empty content — "Unexpected end of JSON input" |

This is provider-side variance, measured, not a budget story like run 2's: run 2 (600 s) rejected 8
with schema/abortion causes after 17–600 s; today's provider refused or returned empty on 9 maps
within 0.6–2.7 s and burned the budget once. The selection itself was never the failure point.

Mechanical facts on the 2 accepted maps (routes q/c/u/a = questions/confirmations/understood/
assumptions; latency = pipeline wall-clock):

| id | items | st/inf/un | q/c/u/a | cap overflow | alternatives override | latency | notes |
|---|---|---|---|---|---|---|---|
| FOC-406 | 11 | 4/1/6 | 4/0/0/7 | 3 overflowed → assumptions, listed | yes — every question carries "the map's current reading" as the recommended option | 225.0 s | ground truth UNKNOWN (as in FOC-515 — excluded from rubric) |
| FOC-443 | 9 | 3/3/3 | 4/0/0/5 | 5 overflowed → assumptions, listed | yes | 260.7 s | – |

- **Questions per case: 4 + 4 — the cap binds on every accepted map.** Ordering by impact
  probability held: FOC-406 asked IN-1 (0.9), IN-7 (0.88), IN-3 (0.78), IN-4 (0.71); FOC-443 asked
  IN-3 (0.78), IN-4 (0.73), IN-6 (0.72), IN-1 (0.69).
- **Confirmations/understood: 0 — via the cap, not via hiding.** On FOC-443 the inferred/stated
  confirmation candidates (impacts 0.72 and below) all lost the cap race to higher-impact
  option-carrying unknown items and landed in the assumptions list as "below the 4-question cap".
  Nothing was dropped: all 5 overflow items are listed with their impact probabilities (A0 honesty).
- **Dedupe (round-0):** no `gate.plan.gate1` record exists before gate1's first approval, so both
  selections ran with an empty answered-set (`dedupedIds` `[]`) — the check is exercised by tests
  (`plan-intent-select.test.mjs`), not by this run.
- **Cost honesty:** $0.037978 ledger total covers the 4 completed calls (maps 2,375 in / 62,566 out;
  scores 8,054 in / 750 out). The 10 failed map calls append no event line — their spend is invisible
  to our ledger (same caveat as FOC-515 finding 6). Fast failures bound it: a refused call costs one
  round trip, not a reasoning budget.
- **Latency is bimodal, same shape as run 2:** p50 1.3 s (fast refusals) · p90 260.7 s · max 300.1 s;
  real map generation took 225–261 s — inside the 300 s contract budget this time, unlike run 2.
- **Annotation fix during this run:** the measured rows carry a pre-fix overflow `rank` in the
  assumption reason that named the item's MAP-ORDER position, not its impact standing (e.g. FOC-443
  IN-2, impact 0.47, 8th by impact, labelled "rank 2"). Fixed in this change set and regression-pinned
  (`plan-intent-select.test.mjs`, FOC-443 regression test); every count in this report is unaffected —
  the rank string is an annotation, the routing and cap arithmetic were already correct.

**Coverage of the known misses (AC7)** — against the FOC-515 rubric targets:

- **FOC-443** (the graded case): all three input-arising targets are SURFACED, none hidden —
  IN-3 (test-shadow file) impact 0.78 → **question with closing options**; IN-8 (MAX_ERROR_TEXT vs
  the 120-char parse cap) impact 0.53 and IN-5 (Security-note replacement wording) impact 0.48 →
  below-cap assumptions, listed with claims and impact probabilities. 1/3 known misses **earned a
  question**, 3/3 **surfaced**. The policy's job is routing, not scoring accuracy — a missed question
  costs a misplaced display, never a lost interpretation (A0).
- **FOC-406**: coverage UNKNOWN (no ground truth; excluded in FOC-515, excluded here).
- The other 10 cases: no map — no interpretations to score or route; skips recorded verbatim above.

Artifacts: `.state/foc-516/select-eval/foc-516-run/` (gitignored) — `outputs.jsonl` (per-case maps,
selections, scores, usage), `summary.json` (aggregates above), `table.txt`, `foc-516-select-eval/
decisions.jsonl` (the FOC-449 event lines). Scoring of selection substance stays human; the graded
read-out above is limited to what the mechanical facts support.
