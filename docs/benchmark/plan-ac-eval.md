# plan.ac [G] — AC-generation eval (FOC-475)

What the plan.ac generator node produces — the generation call PLUS its node-internal
`plan.ac.testable` gate loop — measured against the 12 Fenix issues whose acceptance criteria
Mateusz already approved (in-repo twin `scripts/plan-dod-eval-fixture.json`, deep-equal to the
supervisor run's `fixture-acs.json`). Everything in the Results section was **run and captured**,
not recalled: raw outputs, event lines, usage and cost live under
`.state/foc-475/eval/<timestamp>/` (gitignored).

- Harness: `scripts/plan-ac-eval.mjs` (committed); fixture: `scripts/plan-dod-eval-fixture.json`.
- Node under test: `runPlanAcNode` from `scripts/plan-ac.mjs` — the REAL node loop (generate →
  score every criterion through the `plan.ac.testable` seam gate → at most one regeneration
  carrying the failing criteria + gate reasons → re-score → escalate), driven with the runner's
  own `createDefaultGenerator` and the real decision-call seam caller — the exact composition a
  live graph run uses.
- Models: `z-ai/glm-5.3-flash` ([G] generator, config/models.json `routing.plan.discovery`) and
  `typesafe/jev-1.13-20260917` (the `plan.ac.testable` noul scorer). Strict
  `response_format: json_schema` with the step's output schema; `usage: {include: true}` so cost
  is the provider's own meter.
- Re-run: `node scripts/plan-ac-eval.mjs --out-dir .state/foc-475/eval/<ts>` (exit 0 = completed,
  3 = no `OPENROUTER_API_KEY`). Artifacts per run: `outputs.jsonl` (per-issue inputs as built,
  output, attempts, gate calls, escalation detail), `summary.json`, `table.txt`, and the FOC-449
  event lines under `<run-id>/decisions.jsonl` ([G] calls and gate calls both ledger here).

## Input partition (the decided contract, FOC-475)

`plan.ac.reads = ["inbox.entry", "features.list"]` — the two declared reads are unchanged from
the design doc (§3.3:139, §3.11:299); the four AC1 ingredients ride INSIDE them as structured
payload fields composed by the CALLER (474's `{title, scopeSummary}` precedent, extended):

- `inbox.entry` = `{issueId, title, scopeSummary, dorFacts}` —
  `issueId` is the fixture id (the FOC-474 wrong-id partition amendment, landed as a payload
  field — identity metadata, not a content input);
  the scope summary is the description with (a) the **AC ground-truth section stripped** (from
  the `## Acceptance [Cc]riteria` heading or the inline `**Acceptance criteria:**` / `**AC:**`
  marker to the next `## ` heading or the next line-start `**Key:**` bold marker — or EOF) and
  (b) the terminal `<!-- fenix-roadmap-… -->` block stripped — the DoD section STAYS: it is the
  issue's own dictated text (plan.dod's ground truth, not plan.ac's answer key) and a real
  dictated entry would carry it;
  `dorFacts` are the line-start `**Key:**` fact lines of the stripped text (Source/Scope/
  Deliverable-style constraint lines — the deterministic stand-in for the FOC-452 `plan.dor.*`
  gate answers, which no fixture carries), capped at 200 chars each, max 8, none → null.
- `features.list` = `candidateFiles[]` — the backticked repo-ish paths in the stripped text
  (trailing `:line[,line]` reference suffix removed), deduped in first-appearance order, capped
  at 12: deterministic retrieval output, input DATA the node sees (the node has no tools and no
  repo access).

Ground truth never enters the inputs — pinned by `scripts/plan-ac.test.mjs` (no AC line
>25 chars from any fixture issue appears in any composed payload; malformed fixture rows throw
TypeError). Over-length posture: **fail-closed** — the serialized reads payload is capped at the
seam's 16000-char state cap and over-cap composition throws BEFORE any provider call (no
truncation; pinned by test).

## The AC3 loop as landed (node-internal, not a graph edge)

Generate → every criterion scored through `plan.ac.testable` (instances channel
`{state, decisionId, instances:[{id,text}…]}`, noul per criterion, verdict p ≥ 0.5) → any
criterion below ⇒ EXACTLY ONE regeneration whose payload carries the failing criteria, their
measured verdicts and the gate's reasons, then ALL criteria re-scored → still below ⇒ the step
fails closed with a typed `escalated` record (per-criterion verdicts, reasons, attempt count)
that lands in `graph-steps.jsonl` for the frontman/Mateusz. Success-only event-line discipline
holds: every successful [G] call and gate call writes its FOC-449 event line; failures and the
escalation itself append nothing (the escalation is not a provider call — it IS the typed record).
No graph retry edge exists — that is FOC-476's, deliberately not built here.

## Rubric (human-graded — the harness ships outputs, not grades)

Per issue, against the fixture's approved AC section:

- **testable** — each generated criterion is individually checkable (a named test/command, a
  file-state assertion, a concrete manual/human step). The gate's own verdicts are the
  mechanical half of this axis; the human grade judges the substance.
- **covers scope** — every ground-truth item's substance appears as a criterion (paraphrase
  fine). FOC-406 has no approved AC section → **UNKNOWN**, excluded from the coverage aggregate.
- **no duplicates** — no two criteria assert the same check (granular splits of one GT item are
  noted, verbatim twins lose the point).
- Verdict: **pass / partial / fail**, one-line reason per issue. An escalated issue is a
  **fail** (no output flowed) — the escalation is the measurement, not an error.

## Results

Three harness runs, **same prompt throughout** (registry `criteriaVersion 1`, no tuning — the
first two died in harness plumbing, not generation):

- Run A `2026-09-23T09-56-45` — killed by a session end ~3 min in (2 event lines; partial dir
  kept as evidence). Provider spend not attributed (no artifacts).
- Run B `2026-09-23T10-10-58` — 38 event lines, then the harness crashed in its usage-join
  (`withGateUsage`: a local `const` shadowed the helper function of the same name) before any
  artifact was written. Calls were real; spend not attributed; fix is harness-only.
- **Run C `2026-09-23T10-19-26` — the recorded run**: **7/12 ok · 5 escalated · all ok rows
  schema-valid**; [G] 8,972 in / 5,893 out tokens; gate 31,485 in / 2,805 out; **$0.0068 total**;
  per-issue loop latency 7.9–69.8 s (well under the 300 s budget).

Run-C mechanical table (`table.txt`):

| id | ok | attempts | gateCalls | min p | latency | regen |
|---|---|---|---|---|---|---|
| FOC-406 | true | 1 | 1 | 0.64 | 7.9s | — |
| FOC-416 | ESCALATED | 2 | 2 | 0.47 | 38.1s | ran* |
| FOC-417 | ESCALATED | 2 | 2 | 0.24 | 29.6s | ran* |
| FOC-441 | true | 1 | 1 | 0.60 | 9.7s | — |
| FOC-443 | true | 1 | 1 | 0.72 | 10.9s | — |
| FOC-473 | ESCALATED | 2 | 2 | 0.33 | 59.3s | ran* |
| FOC-448 | true | 2 | 2 | 0.54 | 28.5s | yes |
| FOC-449 | true | 2 | 2 | 0.50 | 34.1s | yes |
| FOC-397 | true | 2 | 2 | 0.62 | 47.6s | yes |
| FOC-451 | ESCALATED | 2 | 2 | 0.39 | 54.7s | ran* |
| FOC-452 | ESCALATED | 2 | 2 | 0.46 | 56.2s | ran* |
| FOC-396 | true | 2 | 2 | 0.71 | 69.8s | yes |

\* `gateCalls=2` on an escalated row IS the one-regeneration proof; the table's `regen` flag is
only set on ok rows (summary counts `okRows` with `attempts=2`) — display quirk, see Finding 5.

Human rubric on the run-C outputs (per-issue one-line reason; testable / covers scope /
no duplicates):

| id | testable | covers scope | no duplicates | verdict |
|---|---|---|---|---|
| FOC-406 | pass | UNKNOWN | pass | **pass** — no approved AC section; every criterion concrete (spawn `--candidate`, fail-closed resolution, stated revision); evidence typing sensible |
| FOC-416 | — | — | — | **fail (escalated)** — 2 of 8 criteria below 0.5 after the regen (min p 0.47, near-miss); no output flowed |
| FOC-417 | — | — | — | **fail (escalated)** — 3 of 7 below after the regen (min p 0.24); GT's compound invariants (one-scrub-helper, fail-closed semantics) never reached testable form |
| FOC-441 | pass | partial | pass | **partial** — enum match + sweep + docs-only boundary covered; the GT's "executable-copy invariant" item missing; commit-title and lint items promoted into ACs (GT keeps them in the DoD section — Finding 4) |
| FOC-443 | pass | pass | partial | **pass** — all three GT items covered more granularly; AC-1/AC-2 (two call sites) and AC-3/AC-4 (behaviour + its test) are near-twins, not verbatim dupes |
| FOC-473 | — | — | — | **fail (escalated)** — 1 of 9 below after the regen (min p 0.33); design-level GT (node-contract taxonomy) resists one-shot AC-ification |
| FOC-448 | pass | partial | pass | **partial** — registry file, registry-driven calls, missing/malformed fail-closed lookups, catalog cross-check covered; A0-enforcement, the FOC-401 migration and the seed-entry list missing |
| FOC-449 | pass | partial | pass | **partial** — event-fields substance deep (full input, output, cost+confidence, outcome, error-on-incomplete); the outcome-labelling CLI, export splits, retention policy and labels-are-outcomes items missing |
| FOC-397 | pass | partial | partial | **partial** — decision-call path, three transition fixtures, low-confidence and provider-error cascades, token share covered; four transition fixtures are pattern-twins; the GT's runner-wide framing narrows to decision-call |
| FOC-451 | — | — | — | **fail (escalated)** — 1 of 10 below after the regen (min p 0.39); triage/gate-composition GT items never reached per-criterion testable form |
| FOC-452 | — | — | — | **fail (escalated)** — 2 of 8 below after the regen (min p 0.46, near-miss); the registry-entry list GT is a data spec, not criteria |
| FOC-396 | pass | partial | pass | **partial** — decide-edge bindings for the five transitions, [D]-stays-unbound boundary, merged-doc and epic-comment items covered; decomposition breadth, per-step contracts, the 9-consumer migration path and the frontman-share estimate missing |

**Aggregate:** ok rows 7/12 → **2 pass / 5 partial / 0 fail**; escalated 5/12 → **fail**
(the gate is the quality control and it refused 5/12 after exactly one regeneration each).
FOC-406 (no ground truth): pass, coverage **UNKNOWN**, excluded from the coverage aggregate.
Coverage axis on GT rows: **1/11 full** (FOC-443). Testable axis on produced ACs: high — every
criterion the gate let through is individually checkable.

## Findings

1. **The AC3 loop works and is strict.** 4 issues regenerated once and passed; 5 escalated with
   typed records (`gateCalls=2` proves the single regeneration ran; the escalation message names
   the below-threshold count, the threshold and the frontman hand-off). The run continues past an
   escalation — a measurement, never a crash.
2. **Threshold sensitivity is real.** Two escalations are near-misses (FOC-416 p 0.47, FOC-452
   p 0.46 vs 0.5); FOC-449 passed at exactly 0.50. A ±0.04 verdict delta flips escalation vs
   delivery. Calibration of the 0.5 default belongs to FOC-387/477 — NOT prompt-tuned here
   (criteriaVersion stays 1).
3. **Coverage is the weak axis — same partition property as 474.** Generated ACs lock onto the
   operational, testable slice of an issue; design-policy GT items (decomposition breadth,
   migration paths, seed lists, retention) are systematically missing. They are not derivable
   from the four ingredients + the dictated text alone — the same not-derivable-ground-truth
   finding as plan-dod's Finding 4, now on the AC side.
4. **The DoD/AC boundary leaks through the deliberately-kept DoD section.** The harness keeps the
   issue's DoD section in the scope summary (it is dictated text, not plan.ac's answer key);
   the generator then promotes commit-message/lint conventions into ACs (FOC-441 AC-4/AC-5) —
   repo-split DoD material. Consequence of a decided partition choice, documented rather than
   hidden.
5. **Harness display quirk (left as-measured).** The table's `regen` flag and the summary's
   `regenerated` count only ok rows; an escalated row shows `regen: false` although
   `gateCalls=2` proves the regeneration ran. `outputs.jsonl` carries the truth; the fix is
   display-only and deliberately not applied post-measurement (the committed artifacts must
   match the committed code's output).
6. **Cost honesty.** The recorded run cost **$0.0068** for 12 issues (21 [G] calls + 21 gate
   calls — 42 FOC-449 event lines). Two aborted harness runs (runs A and B, 40 ledgered provider
   calls between them) produced real spend
   that is NOT attributed — the harness died before the usage join both times. The run-B bug
   (a local `const withGateUsage` shadowing the helper function) was harness plumbing only;
   generation, prompt and gate behaviour were identical across all three runs.

## Notes for FOC-476 / FOC-477 / FOC-461

- **Escalation consumer:** the typed `escalated` record exists in `graph-steps.jsonl`; who reads
  it in a live run (frontman relay → Mateusz) is runtime wiring for FOC-476. Do not re-route it
  through a gate — D7: the escalation IS the record.
- **No graph retry edge was added** — plan.ac's one-regeneration is node-internal. FOC-476 owns
  the graph-level retry edge (plan.ready), if any.
- **Threshold calibration (FOC-387/477):** two near-miss escalations at p 0.46–0.47 — the 0.5
  default is uncalibrated. Widen the FOC-449 corpus with these 21 gate calls (31.5k in / 2.8k out
  tokens of noul verdicts) before tuning anything.
- **Wall-clock:** every plan.ac loop completed in ≤69.8 s today (vs plan.dod's 299 s worst call).
  The FOC-476 runtime budget question eases for plan.ac but stays for plan.dod.
- **Coverage gap is partition-structural:** either the caller enriches the payload (more DoR
  context) or the rubric accepts the operational slice; do NOT push GT-shaped items into the
  registry prompt (criteriaVersion 1 stands).
