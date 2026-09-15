# FOC-165 — cost accounting: verification report

| | |
|---|---|
| Issue | FOC-165 — *Cost is measured, not reported* |
| Branch | `foc-165-dev` |
| Base | `f887fb9` |
| Head at time of writing | `b055340` |
| Report written | 2026-09-15 |
| Telemetry store used | **copy** `.state/foc-165/telemetry-copy.sqlite` via `LA_TELEMETRY_DB` — the live `telemetry.sqlite` was never written (see §12) |
| Grading source | the issue's own Acceptance Criteria / Definition of Done, reproduced verbatim below and graded item by item |

**How to read this report.** Every grade carries either a `file:line` or a command that can be re-run.
`inconclusive` is used where the repo does not settle the question, and the report says what *would*
settle it. No number in this document was copied from another agent's summary; §10's divergence was
re-derived here from the committed fixture, and §11's row counts come from the `canonical_*` views.

**On the issue body.** The FOC-165 description is stale in one specific place, noted in §13: the
"no runtime reads the cap" claim in it is a 2026-08-26 grep, and both defects it describes as open had
already been fixed before this run started. The ACs below are graded against the tree at `b055340`,
not against the issue's prose.

---

## 1. Acceptance Criteria — grading

| AC | Statement (abridged) | Grade | Evidence |
|---|---|---|---|
| AC1 | `children[].costUsd` from token counts priced through `config/models.json`, not `total_cost_usd` | **met** | §1.1 |
| AC2 | `total_cost_usd` still recorded, under a separate field | **met** | §1.2 |
| AC3 | No price row → `null`, never `0` | **met** | §1.3 |
| AC4 | `LA_SUPERVISOR_MAX_COST_USD` trips at a turn boundary, overshoot stated, no further child spawned | **met** | §1.4 |
| AC5 | Cap unset → no cap, no behaviour change | **met** | §1.5 |
| AC6 | `config-drift.test.mjs` fails if `agents/*/CLAUDE.md` presents an env var no script reads | **met** | §1.6 |
| AC7 | `scripts/price-check.mjs` reports drifting committed prices and exits non-zero | **met** | §1.7 |

### 1.1 AC1 — cost is computed from token counts, not taken from the stream

`scripts/supervisor-watch.mjs:167` calls `costFromResult(event, initModel, priceOne)` on every `result`
event and accumulates the returned `computed` value (`:168`, `addCost`). `priceOne` is bound to
`calculateCost` × `pricingSnapshot()` from `telemetry-store.mjs` — the same price table and the same
function the dashboard's ingest uses. The stream's own figure is not read on that path; it is captured
separately at `:169`.

`costFromResult` (`scripts/supervisor-lib.mjs:150`) prices **per model** from `modelUsage`, falling back
to the `system/init` model when the per-model breakdown is absent (`:164`–`:169`). Pricing per model
rather than from the summed `usage` matters: a turn that touches the main model *and* the small/fast
model has two different rates, and `usage` has already merged them.

### 1.2 AC2 — the reported figure survives, under its own field

`costUsdReported` is a distinct accumulator (`supervisor-watch.mjs:97`), fed only from
`cost.reported` (`:169`, i.e. `event.total_cost_usd`) and written to the registry beside the computed
value (`:228`–`:229`). Both are in the same `updateChild` payload, so a reader can compare them without
either having overwritten the other. §10 measures the gap between them.

### 1.3 AC3 — an unpriced model is `null`, not `0`

Two places, both required:

- `supervisor-lib.mjs:180`–`:182` — a model whose tokens exist but whose price is `null` is pushed to
  `unpriced`, and `:201` returns `computed: unpriced.length ? null : computed`. `addCost`
  (`:206`–`:209`) keeps `null` absorbing, so one unpriced model makes the child total unknown rather
  than quietly cheaper.
- `supervisor-lib.mjs:190`–`:199` — the *zero-token* case returns `0`, not `null`. This is the (g)
  distinction: $0 is a known answer for a turn that spent nothing; `null` is reserved for tokens nobody
  could price. Conflating them in either direction was the bug.

Covered by `scripts/supervisor-cost.test.mjs` — the four shapes at the `(FOC-165 g)` block, notably
`PASS tokens present and unpriceable stay null — unknown is not folded into $0` (29 passed, 0 failed).

### 1.4 AC4 — the cap trips at a turn boundary, overshoot stated

`budgetStatus` (`supervisor-lib.mjs:221`) reads `LA_SUPERVISOR_MAX_COST_USD`, sums `children[].costUsd`
and sets `exceeded: capValid && spent !== null && spent >= cap` (`:256`). `assertWithinBudget`
(`:292`) is called at exactly the two points where a new turn begins — `supervisor-spawn.mjs:214` and
`supervisor-followup.mjs:137` — which is what makes the check post-hoc by construction: the turn that
crosses the line is allowed to finish, and the *next* one is refused.

The overshoot is not rounded away. The refusal (`:308`) prints the actual spend to four decimals
against the cap — `budget spent: $X of $Y — no new turn until Mateusz decides` — plus the sentence
`The cap is checked at turn boundaries, so the last turn may have carried it past the limit.` A cap
that cannot be evaluated is itself a refusal (`:297`–`:303`), naming the child and the unpriced model
rather than proceeding.

### 1.5 AC5 — unset means no cap

`supervisor-lib.mjs:222`–`:223` maps unset *and* empty-string to `cap = null`; `:296` returns the
status unchanged, before any of the three refusal branches. So with the variable unset,
`assertWithinBudget` is a pure read. Test: `scripts/supervisor-cost.test.mjs:285` deletes the variable
and re-runs the same spawn that is refused with it set at `:277` — the pair is the AC.

### 1.6 AC6 — config drift covers gating env vars

`scripts/config-drift.test.mjs:130` — `test("każda zmienna LA_* opisana w CLAUDE.md jest przez coś
czytana", ...)` — fails when `agents/*/CLAUDE.md` presents an `LA_*` variable that no script reads.
Run: `node scripts/config-drift.test.mjs` → **26 passed, 0 failed, exit 0**. The suite is offline
(no catalogue access), which is why AC7's checker is a separate script rather than a test in it.

### 1.7 AC7 — the live price checker

`scripts/price-check.mjs` exists; `:22` is the catalogue URL `https://openrouter.ai/api/v1/models` and
`:5`–`:7` states in the file itself that it is network-using and deliberately outside
`config-drift.test.mjs`. Run by hand:

```
$ node scripts/price-check.mjs --json ; echo "EXIT=$?"
EXIT=1
```

It reported **7** drifting prices and **4** unlisted models, and exited non-zero — both halves of AC7.
The drift list is in §1.8 and §13; note that a model absent from the live catalogue is reported as
unlisted, not as an error, so pinned dated snapshots do not produce false failures.

### 1.8 DoD — the committed price table

Read from `config/models.json` → `pricing.openrouter`:

| model | committed | DoD says | verdict |
|---|---|---|---|
| `stealth/ox-alpha` | `0 / 0 / 0` | leave at $0, do not "fix" | **met — left alone** |
| `openai/gpt-6-astra` | `10 / 50 / 1 / 12.5` | cache rates filled from the 2026-09-05 catalogue check | **met** |
| `deepseek/deepseek-v4-pro` | `0.66 / 1.98 / 0.022` | correct to `0.87 / 1.74 / 0.0725` | **not met** |
| `deepseek/deepseek-v4-pro-0813` | `0.66 / 1.98 / 0.022` | — (not named in the DoD) | same value as above |

The `stealth/ox-alpha` row is the one the issue warns about by name, and it is correct as it stands:
the live catalogue does not list the model at all (§1.7 lists it under *unlisted*), so pricing it at
zero is a deliberate pinned-snapshot choice, not a missing row.

The `deepseek/deepseek-v4-pro` correction the DoD requires **is not on this branch at `b055340`**.
It is graded *not met* §13 as finding F1, with the proposed disposition. Two honest caveats on that
finding: (i) this is turn 2 of 5, so the correction may land in a later turn — but a later commit does
not un-write this report, and the DoD is graded against the tree that exists; (ii) `price-check.mjs`
run at 2026-09-15 now disagrees with the DoD's own target figures as well as with the committed ones,
which is itself evidence about how fast this catalogue moves.

`openai/gpt-6-astra` was verified against the issue's quoted 2026-09-05 check rather than against the
network, per the run's constraints.

## 2. Definition of Done — grading

| DoD item | Grade | Evidence |
|---|---|---|
| `supervisor-watch.mjs` prices from token counts | **met** | §1.1 |
| `total_cost_usd` kept as `costUsdReported` | **met** | §1.2 |
| unpriced → `null`, never `0` | **met** | §1.3 |
| `LA_SUPERVISOR_MAX_COST_USD` at turn boundaries, post-hoc, overshoot reported not rounded away | **met** | §1.4 |
| `config-drift.test.mjs` covers every gating env var | **met, with a stated limit** | §1.6 + §2.1 |
| `scripts/price-check.mjs` exists | **met** | §1.7 |
| `deepseek/deepseek-v4-pro` corrected to 0.87 / 1.74 / 0.0725 | **not met** | §1.8, finding F1 in §13 |
| `stealth/ox-alpha` left at $0 (do not "fix") | **met** | §1.8 |
| tests: fabricated-vs-computed divergence | **met** | §10.3 |
| tests: unpriced → null | **met** | §1.3 |
| tests: cap trips at a boundary | **met** | §1.4 |
| tests: cap absent → no change | **met** | §1.5 |

### 2.1 AC6 coverage — what the test actually sees

Measured, not assumed: across the seven squads that carry a `CLAUDE.md`
(`cadence, dev, orchestrator, plan, review, supervisor, test`) the test finds **7 distinct `LA_*`
variables** — `LA_ROOT`, `LA_RUN_ID`, `LA_SUPERVISOR`, `LA_SUPERVISOR_CHILD`,
`LA_SUPERVISOR_MAX_COST_USD`, `LA_SUPERVISOR_REPO`, `LA_SUPERVISOR_RUN` — and each is present in
`scripts/*.mjs`, so none is orphaned. The check is non-vacuous (it fails when a name is absent) but it
is a **substring search over script sources**, so a variable mentioned only in a comment would satisfy
it. That is the limit of the AC6 claim, stated here rather than implied: AC6 as written ("fails if no
script reads that variable") is met at the level of "no script *mentions* it", which is weaker than
"reads". No variable in the current tree sits in that gap.

## 3. Item (a) — over-budget kill-switch in the standalone launchers

**Commit:** `8c8e385` — *feat(cost-guard): wire over-budget kill-switch into standalone launchers*.

**What changed.** `scripts/cost-guard.mjs` already wrote `.state/over-budget.json` on a breach, but the
marker was consulted by exactly one reader (`cost-report.mjs`). A marker nobody blocks on is a log
line, not a kill-switch. Three things changed:

- `bin/_lib.bat:17` runs `node %ROOT%\scripts\cost-guard.mjs check` before `claude` starts and blocks
  on a non-zero exit. The supervisor frontman is excluded on purpose — it is the intervention channel,
  and its children are already guarded by `assertWithinBudget` (§1.4).
- `scripts/launch.mjs:285` adds `assertNoOverBudgetMarker()`, called at `:297` *before*
  `spawnLauncher`, so a dashboard `POST /api/launch` gets the refusal as an error instead of starting a
  process that will refuse itself.
- `cost-guard.mjs` gains an explicit CLI bridge with a stated exit contract (`check` → 0/1,
  `clear` → 0, `usage` → 2) because `.bat` files cannot import ESM, plus a `COST_GUARD_MARKER_PATH`
  override so tests never touch the real marker. Default behaviour for importers is unchanged.

**Evidence that it was necessary.** The defect is the gap between *writing* a marker and *anyone
refusing on it*: before this commit the only consumer was the reporting path, so an over-budget run
launched from `bin/*.bat` or from the dashboard proceeded. The marker's own comment
(`cost-guard.mjs:14`–`:15`) had promised `rm .state/over-budget.json` as the override — a promise that
only means something if something blocks.

**The test.** `scripts/cost-guard.test.mjs`, 8 tests, run here: **8 passed, 0 failed**. The three that
carry the change are the CLI exit contract, `clear` reopening the gate, and
`spawnLauncher refuses before spawning anything when the marker exists` — the last one is the assertion
that matters, since "refuses" and "refuses before spending money" are different claims.

**Verified by reading, not executed:** the `.bat` path itself. This report claims the wiring exists at
`bin/_lib.bat:17`; it does not claim a Windows shell was driven through an over-budget launch, and no
such execution happened in this run.

## 4. Item (b) — pricing nebul-catalogued keys across scopes

**Commit:** `bf9c50a` — *fix(telemetry): price nebul-catalogued keys via exact-key cross-scope
fallback*.

**What changed.** `resolvePrice` / `calculateCost` gained an optional `scoped` parameter.
`scripts/telemetry-store.mjs:1498` keeps flat `openrouter`-only resolution first and unchanged; only
when that fails **and** the caller hands over the provider map does an exact-key cross-scope fallback
fire. Fuzzy matching never crosses providers, and collisions are deterministic: identical rate rows
collapse (alphabetically first provider wins) and differing rows refuse to unpriced rather than picking
one silently. Five call sites were threaded through — `ingest applyUsageRecorded`, the run-projection
cache, `repriceCurrent`, `aggregateUsageByTask` under `priceMode: 'current'`, and the supervisor
watch-side `priceOne` (`supervisor-watch.mjs:113`, which is the one feeding the registry behind
`assertWithinBudget`).

**Evidence that it was necessary** — re-measured on the copy in this run, not taken from the commit
message:

```
canonical_usage WHERE model = 'zai-org/GLM-5.2-FP8'
  excluding this run's synthetic proof row:  rows=1079  priced=0  unpriced=1079  SUM(cost_usd)=NULL
  including it:                              rows=1080  priced=1  unpriced=1079
RAW usage_facts rows for the same key: 4703   →   cost_facts rows with non-null cost: 0
pricing_missing issues naming GLM-5.2-FP8: 19
```

The key sits under `pricing.nebul` in `config/models.json` (`input 1.91 / output 9.57 / cacheRead 0.76
/ cacheWrite 0.76`), and `zai-org/GLM-5.2-FP8` is the **only** key in that scope. So before the fix
every one of those rows was unpriced, and budget accounting was blind on a model with real spend.
*Reconciliation note:* the commit message says "1,080 canonical unpriced"; this run measures 1,079
excluding the one synthetic proof row that `.state/foc-165/foc165-proof.mjs` writes to the copy —
1080 − 1 = 1079, and the two agree once that row is accounted for. The report quotes its own numbers
and shows the arithmetic rather than repeating the rounder one.

**No historical rewrite.** Existing `cost_facts` rows keep their snapshot-time `price_set_id`; only
newly ingested rows price differently. That is the price-sync policy, and it is why this fix does not
restate past costs — see §13 finding F3 for what that leaves on the table.

**The tests.** `node scripts/telemetry-store.test.mjs` → **51 passed, 0 failed**; four are new (FP8
ingest pricing; openrouter keys unchanged with the containment rule pinned for
`z-ai/glm-5.2-20260616`; collision determinism; scoped-fallback vs legacy flat `null`).
`node scripts/supervisor-cost.test.mjs` → **29 passed, 0 failed**, including the watch-side test that a
nebul-catalogued key prices non-zero.

**End-to-end on stored data, not on a unit fixture:** `node .state/foc-165/foc165-proof.mjs` writes a
fresh FP8 row through the real ingest into the **copy** and reads it back priced at `$4.0824`
(1M in / 200k out / 300k cacheRead / 40k cacheWrite at the nebul rates), with `z-ai` keys unchanged and
no `pricing_missing` issue raised. That call is on the copy only — `.state/foc-165/telemetry-copy.sqlite`
— never the live store.

## 5. Item (c) — canonical views drop/recreate atomically inside `migrate`

**Commit:** `48c4ec5` — *fix(telemetry): make canonical view drop/recreate atomic inside migrate*.

**What changed.** `ensureCanonicalViews` dropped `canonical_usage` / `canonical_tool_facts` and then
re-`CREATE`d them as **separate** `db.exec` calls, so two processes opening the same store could
interleave statement-by-statement: B drops, A's `CREATE` slips into the gap, B's own `CREATE` then
fails with `view canonical_usage already exists`. Both recreate paths now run inside the file's
existing `transaction()` helper (`BEGIN IMMEDIATE`) — `migrate()`'s initial `dropCanonicalViews` and
`ensureCanonicalViews`' drop-plus-both-`CREATE`s. The 10 s `busy_timeout` set at open bounds the wait,
and the view SQL itself is unchanged, so this is a concurrency fix and not a semantic one.

**Why it matters for cost.** This is in scope for FOC-165 because it is a **cost-reporting** defect,
not a general one: a failing telemetry hook write under-reports spend. The billing surface *is* the
`canonical_*` views (FOC-221), so a view that transiently cannot be recreated is a view that can miss
rows — and the commit message records the observed rate, roughly **1 in 10** runs of
`telemetry-concurrency.test.mjs`.

**The test.** `scripts/telemetry-canonical-views-atomicity.test.mjs` stages the production interleaving
deterministically rather than by racing: an intruder connection `CREATE`s `canonical_usage` inside the
drop-to-create gap through a `db.exec` wrapper. Run here:

```
$ node scripts/telemetry-canonical-views-atomicity.test.mjs
PASS canonical view recreate survives an interleaved concurrent CREATE
```

**On the red/green claim.** The commit message states the test is deterministically red pre-fix and
green post-fix, shown both ways. This report **does not re-assert the red half**: re-deriving it would
mean reverting a reviewed commit inside a report turn, which is exactly the mutation discipline the
next turn applies to the two new (g) fixtures. The green half is what was executed here, and it is
what is graded.

## 6. Item (d) — F-05: verification only

> **(d): the fix or the fix-or-defer decision lands in a later turn of this run; this section is
> updated in the same commit as that change.**

Nothing in this section is settled, and no part of it should be read as a grade.

**What F-05 is.** From the FOC-272 consolidated topology review (`527bc64`,
`docs/reviews/foc-272-topology-review.md` §9 — *not present on this branch's tree; read from the commit
object*): *"test→dev return edge has no design corpus: 5 test verdicts, ~0 findings"*, disposition
**DEFER — design the label symmetric with review's; validate at the first real test return**, assigned
to *the FOC-165 release-candidate run*.

**Why it lands here at all.** It is the data gap behind item (e). The review's recommendation at §3 (e)
is to emit an exclusive return label (`returned-by:review` / `returned-by:test`, added on the fail
transition, removed on re-handoff) at return time. The review→dev half of that has a corpus to design
against; the test→dev half does not — five verdicts with no findings is not a corpus, and designing a
discriminator against it would be designing against noise.

**What this turn establishes, and what it does not.** This run's (g) work touched only
`supervisor-lib.mjs` and the supervisor cost tests; the return-label surface is item (e) (§7), whose
implementation is `51ce84b` and whose `returned-by:test` half is exactly the deferred part. So at
`b055340` the position of F-05 is unchanged from the review, and the honest grade for (d) this turn is
**inconclusive — pending, by design**, not *met* and not *not met*.

**What would settle it.** Either (i) a real test→dev return with findings lands in the corpus during
this release-candidate run, giving the symmetric label something to be validated against; or (ii) the
run closes with that corpus still empty, in which case the correct outcome is a **written defer with
the reason stated** — not a discriminator invented to close the finding. The later turn that lands (d)
should say which of the two happened rather than choosing the flattering one.

## 7. Item (e) — pass-time removal of `returned-by:review`

**Commit:** `51ce84b` — *feat(linear): pass-time removal of returned-by:review via
publish-linear-comment*.

**What changed.** `scripts/publish-linear-comment.mjs` gains an explicit
`--clear-returned-by-review` flag (`:80`, documented `:13`–`:16`): after a **successful** post it also
spawns `linear-ops label <issue> --remove returned-by:review`. The two results stay independent — a
failed removal cannot un-post the comment but does fail the script, so a stale label is never silently
lost; a failed post skips the removal with a visible note. `--dry-run` prints the would-be removal.
Without the flag, behaviour is unchanged. `returned-by:review` was also added to
`config/linear/labels.json`, because the label exists in Linear since FOC-284 but was missing from the
local vocabulary `linear-ops` validates against — without that row the removal would have exited 1.

**Evidence that it was necessary.** FOC-284 left `returned-by:review` on a real issue *after* the child
passed, because nothing removes it at pass time. A label that is added on failure and never removed on
success is worse than no label: it makes the issue's state lie about where the work is, and that is the
same class of defect as the issue's own subject — a signal that claims something the system no longer
does.

**The tests.** `node scripts/publish-linear-comment.test.mjs` → **7 passed, 0 failed**. The three new
ones pin the contract: dry-run prints the exact removal command; with the comment refused the removal
is skipped *visibly* and the exit is non-zero; with no flag, no label step runs at all.

**The gap this item leaves open — and it is the important part.** The capability is not wired into the
path that would use it. `agents/review/CLAUDE.md:143` is the clean-path hand-off command ("Clean — no
actionable issues … Handing to TEST") and it does **not** pass `--clear-returned-by-review`;
`grep -rn "clear-returned-by-review" agents/` returns nothing. So as of `b055340` the flag exists, is
tested, and is invoked by no documented instruction — the FOC-284 stale label would still occur on the
next review pass. The commit message itself flags this ("wiring the flag into the REVIEW clean path is
Mateusz's call, flagged in the report"), so this is a known, declared boundary rather than an oversight
— but it is also the difference between item (e) being *implemented* and item (e) being *effective*.
Carried forward as **finding F4** in §13.

**Not verified by execution.** The real removal was never run against Linear — by design, this child has
no Linear write access. The evidence above is offline tests plus the file reads, and this report does
not claim otherwise.

## 8. Item (f) — catalogue reconciliation: verification only

> **(f): the fix or the fix-or-defer decision lands in a later turn of this run; this section is
> updated in the same commit as that change.**

No grade is issued here. What follows is what the tree at `b055340` already shows, so the later turn
inherits a measured starting point instead of re-deriving one.

**What (f) covers.** The issue's 2026-09-05 verification update, quoted in the issue body. It is the
run's standing instruction **not** to re-derive that check from the network — the catalogue figures
below are the issue's, and are treated as provenance, not as live truth.

**Already true at `b055340`.**

- The bootstrap fill is present: `config/models.json` → `pricing.openrouter["openai/gpt-6-astra"]` is
  `{input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5}`, matching the catalogue figures quoted in
  the issue including both cache fields, and the frontman model is unchanged.
- The threshold is genuinely inexpressible, and this is verifiable structurally rather than by
  re-reading the issue. `grep -rn "min_prompt_tokens|minPromptTokens|threshold" config/models.json
  scripts/telemetry-store.mjs scripts/price-check.mjs` returns **nothing**, and the price row shape is
  flat by construction — `model_prices` columns are
  `price_set_id, model_key, input_price, output_price, cache_read_price, provider, cache_write_price`.
  There is no column and no key that could carry *"above 272 000 prompt tokens, input is 20 not 10"*.
  So the issue's claim — *"the current flat config cannot express that threshold"* — is **confirmed on
  the tree**, and it is a schema limitation rather than a missing value.
- The consequence is an honest under-count, not a wrong number: above the threshold, a `gpt-6-astra`
  turn is priced at the base rate and the cost is **too low**, silently. Neither `price-check.mjs` nor
  `config-drift.test.mjs` can see it, because both compare the flat row to a flat catalogue row.

**Already true, and moving against the table.** `z-ai/glm-5.3-flash` is the model this run's own
children are routed to, and its committed row (`0.071 / 0.24 / 0.015`) already disagrees with the
catalogue figure quoted in the issue (`0.075 / 0.25 / 0.015`). Run at 2026-09-15, `price-check.mjs`
reports the live catalogue at `0.15 / 0.5 / 0.03` — roughly **2× the committed row** (§1.7, §13).
Whatever (f) decides, the decision is being made about a moving target, and the price-sync policy
(no historical rewrite) is what keeps that from corrupting past costs. This is the case for deciding
(f) on *policy* — threshold-aware pricing: yes or no — rather than on one model's current rate.

**What this section will be updated with.** (i) whether threshold-aware pricing was built, or an
explicit *unsupported-above-threshold* signal was emitted instead — the issue accepts either, and
refusing to claim full correctness is explicitly preferred over the missing-field fix being sold as one;
and (ii) the boundary fixtures that pin whichever choice was made. Until then the honest grade for (f)
is **inconclusive — pending, by design**.

## 9. Item (g) — zero-token results, and the refusal that names the unpriced child

**Commits:** `b055340` (the fix, turn 1) and `6edebf1` (the two fixture additions, this turn).

### 9.1 What changed

`scripts/supervisor-lib.mjs`, `costFromResult`:

- **The empty-`modelUsage` trap.** `byModel` used to be assigned whenever `modelUsage` was *an object*,
  and the result was nulled whenever it had no keys
  (`computed: unpriced.length || !Object.keys(byModel).length ? null : computed`). A real result event
  carries `modelUsage: {}` on a zero-token turn, so the child's whole `costUsd` became `null` — a known
  `$0.xx` spend turned UNKNOWN — and `assertWithinBudget` then refused the next spawn. The fallback is
  now reached for the empty object (`:164`–`:169`).
- **The $0-versus-unknown rule.** `sawTokens` is set inside the per-model loop (`:179`) and drives the
  answer: no tokens anywhere → `computed: 0` (a known free turn, even with no model on record);
  tokens present but unpriceable → `computed: null` (`:190`–`:199`).
- **The refusal names the holder.** `unknownHolders` (`:264`) replaced "no price row for dev" — a
  *squad* where a *model* was the reason — with `child <id> (<squad>): no price row for <model>`, or,
  when no model was recorded at all, `cost not priced and no model recorded to price against`. The
  matching `hint` differs for the two cases (`:274`–`:277`).

### 9.2 The two fixtures added this turn — and what they are honestly worth

Both were added to `scripts/fixtures/foc-165-result-events.json` and pinned in
`scripts/supervisor-cost.test.mjs`, in `6edebf1`. They were requested with the phrase *"From this run's
own tee"*, and the tees **are** readable — the run's child streams live at
`.state/supervisor/2026-09-15-supervisor-foc-165/children/dev-{1,2,3}.jsonl` in the main checkout. So
this report can and does check the claim instead of repeating it. It found one exact match and one
non-match:

| | claimed shape | what this run's tees actually contain |
|---|---|---|
| **(ii)** zero top-level usage, real per-model tokens | "3 163 cache-read tokens" | **`dev-2.jsonl` result #1** is exactly this shape — `usage` all zeros, `modelUsage` `{z-ai/glm-5.3-flash}` with **2876 input, 287 output, 0 cache-read**. It prices to **$0.000273076**, the figure quoted for it, at 2876 × 0.071/M + 287 × 0.24/M. Pinned. |
| **(i)** zero tokens, one all-zero `modelUsage` key | "`muKeys=1`, not the `{}` already covered" | **No such event exists in any of the three tees.** All 11 `modelUsage` occurrences across `dev-1.jsonl` and `dev-2.jsonl` are either `{}` or carry real tokens; `dev-3.jsonl` has no `result` event yet (this child is still running). |

So (ii) is real and its number is reproduced exactly; (i) is a **constructed shape**. It is a
legitimate thing to pin — an all-zero single-key `modelUsage` is what a turn that *did* record a model
looks like when it spent nothing, and nothing covered it — but the report will not call it a tee
capture, because it is not one. The correction is recorded here rather than in a commit message because
the fixture file cannot say it without asserting something untrue.

**Neither new test is a regression proof, and the mutation run says so plainly.** Reverting
`supervisor-lib.mjs` wholesale to `b055340^` reddens **5** tests — the original (g) suite — and
**neither** of the two new ones, because pre-(g) already priced a non-empty `modelUsage` fine. These
two pin *near-misses of the fix*, so the meaningful mutations are targeted:

| mutation applied to a clean tree | observed |
|---|---|
| `supervisor-lib.mjs` reverted to `b055340^` | `26 passed, 5 FAILED` — none of the new two |
| `sawTokens` guard read off top-level `usage` instead of the per-model entries | `29 passed, 2 FAILED` — incl. **`FAIL zero top-level usage with real per-model tokens prices the tokens, not $0`**, plus the pre-existing `FAIL both spellings of the usage fields are read` |
| zero-token result answering `null` instead of the known `0` | `27 passed, 4 FAILED` — incl. **`FAIL an all-zero single-key modelUsage is the known $0, not unknown`** and the three original zero-token tests |

Each mutation was applied to a clean tree and reverted immediately; `git status --porcelain` after the
last one shows only the two files that were then committed.

### 9.3 The near-miss is real, and it is live

The `spentTokens` helper in the aggregate test read the **top-level** `usage`. Adding fixture (ii)
broke it — `costUsd` included the $0.000273076 turn while `expected` excluded it — which is the same
mistake in the test that the production code must not make. It is replaced by `anyTokens`, which
prefers the per-model entries and falls back to `usage` only when there are none.

Worth stating because it is easy to lose: this is not a theoretical trap. `dev-2.jsonl` result #1 is a
real event from this run where the top-level `usage` is all zeros and the real cost is $0.000273076.
Reading the guard one level too high discards it silently, and the child's total is quietly short.

### 9.4 What the run's own supervisor-side context said, checked

The turn brief supplied — as context, not as a task — that the (g) change is *surgical*: old and new
`costFromResult` agree to the digit on every token-bearing event of this run
(`0.000273076`, `0.086135159`, `0.082913526`, `0.002964174`) and differ only on the zero-token `{}`
event (`null` → `0`). **Independently confirmed here** by pricing `dev-2.jsonl` through the watcher's
own path (§10.2): those four figures are `dev-2` results #1–#4, they sum to **$0.172285935**, and that
is the figure the brief quotes as the run's total — two independent derivations agreeing to nine
decimals. The `null` → `0` difference is `dev-2` results #5 and #6, the two `modelUsage: {}` events
that each nulled the child.

## 10. The divergence: computed vs reported

Everything in this section was produced by running the commands below in this worktree. No figure is
copied from the issue, from a commit message, or from another agent's summary.

### 10.1 The re-runnable commands

```bash
# (i) the committed fixture, priced through the watcher's own path
node .state/foc-165/divergence-fixture.mjs

# (ii) this run's real tees, priced the same way — and priced a second time with
#      the fixture's modelUsage normalisation, to show what that normalisation does
node .state/foc-165/divergence-live-tee.mjs
```

Both call `costFromResult` from `scripts/supervisor-lib.mjs` with a `priceOne` built from
`calculateCost` × `pricingSnapshot()` from `scripts/telemetry-store.mjs` — the same pairing
`supervisor-watch.mjs:113` uses. Read-only; no store is opened for writing and no network is touched.

### 10.2 Measured on the real tees, not on the fixture

`.state/supervisor/2026-09-15-supervisor-foc-165/children/dev-{1,2}.jsonl` — the two children of this
run that reached a `result` event (this child, `dev-3`, has none yet).

| event | top-level usage tokens | per-model tokens | computed | reported | ratio |
|---|---|---|---|---|---|
| dev-1 #1 | 132 629 / 23 814 / 229 312 | 498 336 / 146 354 / 2 862 400 | $0.113442816 | $7.581730 | 66.8× |
| dev-1 #2 | 0 (all zeros) | *(none — `{}`)* | $0.000000000 | $0.000000 | n/a |
| dev-1 #3 | 941 514 / 32 927 / 1 992 128 | 1 435 119 / 135 245 / 5 625 088 | $0.218728569 | $13.369264 | 61.1× |
| dev-1 #4 | 0 (all zeros) | *(none — `{}`)* | $0.000000000 | $0.000000 | n/a |
| dev-1 #5 | 131 086 / 2 073 / 382 272 | 131 086 / 2 073 / 382 272 | $0.015538706 | $0.898391 | 57.8× |
| dev-2 #1 | 0 (all zeros) | 2 876 / 287 / 0 | $0.000273076 | $0.021555 | 78.9× |
| dev-2 #2 | 348 769 / 33 111 / 3 561 728 | same | $0.086135159 | $4.352484 | 50.5× |
| dev-2 #3 | 430 026 / 16 229 / 3 232 448 | same | $0.082913526 | $4.172079 | 50.3× |
| dev-2 #4 | 2 754 / 3 368 / 130 688 | same | $0.002964174 | $0.163314 | 55.1× |
| dev-2 #5, #6 | 0 (all zeros) | *(none — `{}`)* | $0.000000000 | $0.000000 | n/a |

| set | computed | reported | ratio |
|---|---|---|---|
| dev-1 (3 token-bearing turns + 2 zero-token turns) | **$0.347710091** | **$21.849385** | **62.8×** |
| dev-2 (4 token-bearing turns + 2 zero-token turns) | **$0.172285935** | **$8.709432** | **50.6×** |
| both children (11 result events) | **$0.519996026** | **$30.558817** | **58.8×** |

**The headline: across this run's two children the stream reported $30.56 for work that prices at
$0.52 — the fabricated figure is 58.8× the measured one.** Per turn the multiple ranges from 50.3× to
78.9×, so it is not a constant that could be calibrated away; it is a figure that is simply unrelated
to the tokens spent. That is the defect the issue exists to fix, and it is why AC1 is not a stylistic
preference.

Two events are worth pointing at because they behave differently from the rest. `dev-1` #5 is the only
turn where the per-model entry equals the top-level `usage` exactly, and it is the only turn whose
*fixture-style* and *real* prices are identical ($0.015538706 both ways). And `dev-2` #1 (§9.2) is the
turn where the top-level `usage` is all zeros while the real cost is $0.000273076 — the one event in
this table whose cost is invisible to anything that reads the top-level usage.

`dev-2`'s computed total, **$0.172285935**, is also the figure the Supervisor reported independently
for this child — two derivations, agreeing to nine decimals. See §9.4.

### 10.3 The committed fixture gives 169.9× — and why that is not the number to quote

```bash
$ node .state/foc-165/divergence-fixture.mjs
success-with-tokens          computed=$0.018571699 reported=$7.5817  ratio=408.2x
success-zero-tokens          computed=$0.000000000 reported=$0.0000  ratio=n/a
error-with-tokens            computed=$0.104631894 reported=$13.3693 ratio=127.8x
error-zero-tokens            computed=$0.000000000 reported=$0.0000  ratio=n/a
zero-tokens-one-zero-key     computed=$0.000000000 reported=$0.0000  ratio=n/a
zero-usage-real-model-tokens computed=$0.000273076 reported=$0.0216  ratio=78.9x
TOTAL computed=$0.123476669  reported=$20.9726  ratio=169.9x
```

Three numbers are now in play and they are not interchangeable. Stated plainly, because a reader who
takes the wrong one will overstate the case by 3×:

| what was priced | computed | reported | ratio |
|---|---|---|---|
| the fixture, all six events (above) | $0.123476669 | $20.9726 | **169.9×** |
| the fixture, the four original events only | $0.123203593 | $20.9510 | 170.1× |
| **dev-1's same four events, real `modelUsage`** | **$0.332171385** | **$20.950994** | **63.1×** |

(The four original fixture events are `dev-1` results #1–#4; `dev-1` also has a fifth result, #5, which
the fixture does not carry. That is why the dev-1 row in §10.2 — all five results, $0.347710091 — is
larger than the four-event row here.)

The gap between rows 1–2 and row 3 is a **fixture-fidelity** issue, and it is worth flagging as a
finding rather than a footnote. The four original fixture events are `dev-1`'s, with one change: their
`modelUsage` was **replaced by the top-level `usage`** shape. Real result events do not look like that —
in `dev-1` #1 the per-model entry carries 498 336 input tokens against a top-level 132 629, because the
per-model breakdown is not the same measurement as the turn's `usage`. Pricing the fixture therefore
prices *smaller* numbers, and produces a *larger* ratio (170× vs 63×) for the same reported total.

**Which figure this report stands behind: 58.8×** (§10.2) — measured on the real tees through the real
path. The fixture's 169.9× is reproducible and correctly computed *for the shape it stores*, and
§1.3/§9 rely on that fixture for behavioural pins, not for magnitude. The fix for the fidelity gap is
to carry a real per-model entry in the fixture; it is **not** done here, because the four events are
reviewed test inputs whose numbers four existing tests assert against, and changing them mid-report
would invalidate the very mutation evidence §9.2 depends on. Carried as **finding F5** in §13.

### 10.4 What the tests do about divergence

`scripts/supervisor-cost.test.mjs` pins the *shape* of the divergence rather than its size: `costUsd`
and `costUsdReported` are both written and neither replaces the other (AC2), and the cap tests assert
on `spent` rather than on `reported`. There is no test that asserts a particular ratio — correctly, since
the ratio is a property of a model's stream pricing and will move.

A note on what is **not** claimed here: nothing in this report says the stream figure is *wrong* as a
stream figure. `total_cost_usd` is Claude Code's own estimate, computed against Anthropic's price list
for a model it does not recognise. What the measurements show is that it does not describe **this**
repo's spend, and that a cost series built on it was off by a factor between 50 and 79.

## 11. Pricing coverage

Row counts come from `canonical_usage` — the billing surface (FOC-221) — never from raw
`usage_facts`. The store holds known duplicate raw rows (`z-ai/glm-5.3-flash`: 56 838 raw vs 27 840
canonical; `zai-org/GLM-5.2-FP8`: 4 703 raw vs 1 079 canonical), so a raw count overstates by roughly
2× for the GLM keys and by 4.4× for FP8. This run's own synthetic proof rows
(`run_id = 'foc165-synthetic-proof'`) are excluded and counted separately where they matter.

```bash
node .state/foc-165/counts.mjs      # raw vs canonical, price-set registry, JOIN mismatch check
```

### 11.1 Coverage, all models

```
canonical_usage, synthetic proof excluded:
  TOTAL   rows 77 859   priced 76 309   unpriced 1 550   SUM(cost_usd) $1 600.6543
  distinct models: 39
```

**Any cost series printed anywhere in this report carries that `unpriced = 1 550` with it.** A total
of `$1 600.65` over 77 859 rows is `$1 600.65` *plus 1 550 rows of unknown cost*, and the two must be
read together or the series implies a completeness it does not have.

### 11.2 Models carrying unpriced rows

| model | canonical rows | unpriced | SUM(cost_usd) | what it is |
|---|---|---|---|---|
| **`zai-org/GLM-5.2-FP8`** | **1 079** | **1 079** | **`NULL`** | **unknown — the whole model** |
| `anthropic/claude-haiku-4.5` | 606 | 206 | $2.4636 | partially priced; historical |
| `<synthetic>` | 192 | 192 | `NULL` | not a model — mock/dry-run events |
| `anthropic/claude-4.5-haiku-20251001` | 63 | 63 | `NULL` | historical |
| `anthropic/claude-fable-5` | 10 | 10 | `NULL` | **live gap — no price row exists** |

`zai-org/GLM-5.2-FP8` is reported **as unknown, with its row count (1 079), and never folded into
`$0`** — `SUM(cost_usd)` is `NULL`, not `0.0`, which is the AC3 property surviving all the way into the
aggregate. That is the point of §4: 1 079 rows of real spend were invisible, and the fix made them
*priced*; had the fix instead defaulted them to zero, this table would have shown a comfortable
`$0.00` and the model would have disappeared from view.

### 11.3 Which gaps are live and which are historical

The unpriced rows are not all the same kind of problem, and the difference is checkable. Comparing each
model against the newest price set in the copy (`9cb7cbf85167`, created 2026-09-12T12:23:27Z, 30 rows):

| model | row in the newest price set? | verdict |
|---|---|---|
| `zai-org/GLM-5.2-FP8` | **yes** — `provider: nebul, input 1.91` | **was a resolution defect, not a missing row** — exactly (b)'s bug: the row existed and the flat `openrouter`-only lookup could not see it |
| `anthropic/claude-haiku-4.5` | yes — `provider: openrouter, input 1` | **historical** — unpriced rows come from older price sets; a fresh ingest prices them |
| `anthropic/claude-4.5-haiku-20251001` | yes — `provider: openrouter, input 1` | **historical** |
| `anthropic/claude-fable-5` | **no row anywhere** | **live gap** — 10 rows that no reprice can fix while the row is absent. Finding F6, §13 |
| `<synthetic>` | no row (correctly) | not a gap — a mock marker that must stay unpriced rather than be priced at some bucket rate |

The FP8 row is the sharpest evidence in this report for why (b) mattered: the rate was **already in the
price table** and had been since at least 2026-09-12. Nothing was missing except the ability to look
outside the `openrouter` scope.

### 11.4 The canonical JOIN is sound

`counts.mjs` also cross-checks `cost_facts.price_set_id` against `runs.price_set_id`, because a
mismatch there would drop priced rows out of the canonical view even when a price exists — a
`priced=N` under-count that would look exactly like a pricing gap. Result: `cost_facts` rows with
`price_set_id IS NULL`: **0**, and no mismatch group reported. So the unpriced counts above are a
pricing fact, not a view artefact.

### 11.5 Reported-vs-computed on stored data

`node .state/foc-165/cost-reported.mjs`, on the copy (median of per-child reported/computed):

```
z-ai/glm-5.3-flash: n=123  median 63.70x  (min 38.64 / max 218.69)
z-ai/glm-5.3:       n=24   median  3.68x  (min  2.69 / max   5.75)
z-ai/glm-5.2:       no usable children found
zai-org/GLM-5.2-FP8: no usable children found
cross-check 70/107 within 5% (registry computed $28.05 vs canonical $16.89)
```

Two things to take from this, and one not to. The **not**: the `63.70×` median agrees with §10.2's
`50–79×` band for the model this run ran on, so the divergence is a property of the model, not of one
child. The two to take: `z-ai/glm-5.3` sits at `3.68×` — the divergent factor is **model-specific and
spans 3.7× to 64×**, which is why no single correction factor could have fixed AC1; and the
`70/107 within 5%` cross-check is a **known-disputed** figure (`disputed-figure: FOC-220`, per the
FOC-272 review §5 — the by-tool series rest on truncating, hash-less input recording). It is reported
here as an observation on the copy, not as a validated agreement rate.

## 12. Telemetry copy path

TBD

## 13. Findings beyond (a)–(g)

TBD

## 14. Commands run

TBD
