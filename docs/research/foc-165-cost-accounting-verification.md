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

TBD

## 10. The divergence: computed vs reported

TBD

## 11. Pricing coverage

TBD

## 12. Telemetry copy path

TBD

## 13. Findings beyond (a)–(g)

TBD

## 14. Commands run

TBD
