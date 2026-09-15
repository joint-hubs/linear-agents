# FOC-165 — cost accounting: verification report

| | |
|---|---|
| Issue | FOC-165 — *Cost is measured, not reported* |
| Branch | `foc-165-dev` |
| Base | `f887fb9` |
| Code under review | **`6edebf1`** — the five reviewed commits plus this turn's fixture/test additions. This report's own commits follow it and change no code |
| Report written | 2026-09-15, turn 2 of 5 |
| Telemetry store used | **copy**, `.state/foc-165/telemetry-copy.sqlite`, addressed by explicit path — **not** via `LA_TELEMETRY_DB`, which is unset; see §12 for the correction and for why the live store was never written |
| Grading source | the issue's own Acceptance Criteria / Definition of Done, reproduced verbatim below and graded item by item |

## Verdict

**AC: 7 met, 0 not met, 0 inconclusive.** **DoD: 11 met, 1 not met** — `deepseek/deepseek-v4-pro` is
not at the figure the DoD names (F1, §1.8), and the correction is not a mechanical one because the live
catalogue has since moved past the DoD's own target. **Items (d) and (f) are decided** — (d) a written
defer with the corpus measured (§6), (f) explicit unsupported-above-threshold handling with boundary
fixtures (§8). **The full suite was run this turn** (`npm ci && node scripts/test-all.mjs`): 62/63
files pass, exit 1 in both runs — the single red in each run is a hermetic `supervisor-*` test failing
on its environment or timing budget, not on the candidate, and each passes solo (F9, §14.6);
`telemetry-concurrency.test.mjs` (item (c)) passed in both runs.

Four corrections to the material this report was written from, all found by checking rather than
trusting, all recorded in place rather than smoothed over: the divergence is **58.8×**, not the 169.9×
the fixture yields (§10.3); the run does **not** reach the store via `LA_TELEMETRY_DB` (§12); fixture
**(i) is a constructed shape**, not a tee capture — no such event exists in this run's tees (§9.2); and
the `flash`/`worker` gap in `config/models.map` is **10 keys, not 5** (F2).

**How to read this report.** Every grade carries either a `file:line` or a command that can be re-run.
`inconclusive` is used where the repo does not settle the question, and the report says what *would*
settle it. No number in this document was copied from another agent's summary: §10's divergence was
re-derived here from the committed fixture **and** from this run's real tees, and §11's row counts come
from the `canonical_*` views.

**On the issue body.** The FOC-165 description is stale in one specific place, noted in §13 (F7): the
"no runtime reads the cap" claim in it is a 2026-08-26 grep, and both defects it describes as open had
already been fixed before this run started. The ACs below are graded against the tree at `6edebf1`, not
against the issue's prose.

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
| tests: fabricated-vs-computed divergence | **met** | §10.4 |
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

## 6. Item (d) — F-05: written defer, with the corpus measured

**Decision: DEFER (option ii).** The corpus still does not support a `returned-by:test`
discriminator: the structured record set holds **5 test-squad verdicts, 0 findings across all of
them, and exactly 1 test→dev return — itself carrying 0 findings, 0 failing tests, 0 changed files**.
Implementing the symmetric half against that is designing against noise, which is what the review's
own disposition already said (`527bc64`, §9: *"DEFER — design the label symmetric with review's;
validate at the first real test return"*). This section is the deliverable: the decision, its
evidence, and the trigger that reopens it. No code changed for this item.

**What F-05 is.** From the FOC-272 consolidated topology review (`527bc64`,
`docs/reviews/foc-272-topology-review.md` §9 — *not present on this branch's tree; read from the commit
object*): *"test→dev return edge has no design corpus: 5 test verdicts, ~0 findings"*. The review's §3
(e) recommendation is an exclusive return label (`returned-by:review` / `returned-by:test`, added on
the fail transition, removed on re-handoff). The review→dev half has a corpus to design against; the
test→dev half does not. Item (e) implemented the review half (`51ce84b`, §7); this item was to decide
the symmetric half.

### The discriminator, established from the writer — not guessed

A record's stage marker is its `squad` field, and `squad` is set at record time from the run's own
child registry: `scripts/supervisor-verdict.mjs:216` (`const entry = registry.children[childId]`) and
`:371` (`squad: entry.squad ?? null`). So `squad` records *which squad's child actually recorded this
verdict* — precisely "what stage produced the record" — and it is present on all 141 records. This is
the same conclusion FOC-219 reached independently (`agents/plan/plans/foc-219-design.md` §4.4:
*"stage must be derived per record from `squad`/`childId`, never assumed from the source or the
flow"*).

`noFailingTests` is **not** a stage marker, and the caution is confirmed by the writer itself: it is
the FOC-220 declaration "this fail is not test-backed" (`supervisor-verdict.mjs:302-332` — a fail
verdict must either declare `--failing-test` values or declare `--no-failing-tests <reason>`, and the
declaration rides the record out as `noFailingTests`). All 9 records carrying it are `squad:"review"`
— design failures declared by review, not test-stage verdicts. Reproduce:

```bash
node -e "const fs=require('fs');const files=require('child_process').execSync(
  'ls .state/supervisor/*/verdicts/*.json').toString().trim().split('\n');
const recs=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
console.log(recs.filter(r=>r.noFailingTests!==undefined).map(r=>r.squad).join(','))"
```

### The corpus, measured 2026-09-15 — not taken from any brief

```bash
node -e "const fs=require('fs');const files=require('child_process').execSync(
  'ls .state/supervisor/*/verdicts/*.json').toString().trim().split('\n');
const recs=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
const by=(k)=>recs.reduce((m,r)=>{const v=String(r[k]);m[v]=(m[v]||0)+1;return m},{});
console.log('total',recs.length,JSON.stringify(by('squad')),JSON.stringify(by('verdict')));
for(const r of recs.filter(r=>r.squad==='test'))
  console.log(r.taskId,'r'+r.round,r.verdict,'findings='+r.findings.length,r.childId)"
```

| what | count |
|---|---|
| records, total | **141** — 130 `squad:"review"`, 5 `squad:"test"`, 6 `squad:"dev"`; 92 `pass`, 49 `fail` |
| test-stage records | 5 — FOC-151 r2/r5/r7 (pass, `test-4`), FOC-184 r2 (pass, `test-3`), FOC-225 r7 (fail, `test-18`) |
| findings across all 5 test records | **0** |
| test→dev returns on record (test-squad fail verdicts) | **1** — FOC-225 r7 |
| dev-squad fail verdicts | 0 |

The review's premise is **not stale — it is current**. `527bc64` is dated 2026-09-11 and all 5 test
records predate it (recorded 2026-08-31 … 2026-09-07); the structured corpus has grown from the
review's 89 records (F-06's own denominator: *"populated 3/89"*) to 141 and has added **zero** new
test-stage records.

**What the one return says: nothing — and that is the point.** FOC-225 r7 is the no-movement repeat
FOC-272 §3(b) itself cites (`combined: 7e7c3026fea1858d`, run dd5b): its fingerprint is
`{changedFiles: 0, failingTests: [], tests: "e3b0c44298fc…"}` — that `tests` value is the SHA-256 of
the empty string, truncated, i.e. an empty test axis. The return reason was "the work did not move",
not findings dev could act on. Even the single positive example carries an empty axis everywhere a
discriminator would read.

### Why not (i)

The label's semantics, symmetric with (e) (§7), would be "added on the test→dev fail transition,
removed on re-handoff". Designing it needs to know what a real return looks like; the corpus contains
one return with no findings, no failing tests and no changed files. There is nothing to validate
against, and no test could be written whose mutation proof would mean anything, because the positive
case has never occurred. This run cannot add one either: its children registry holds `dev-1`…`dev-4`
only (`.state/supervisor/2026-09-15-supervisor-foc-165/children.json`) and it has recorded 0
verdicts.

Item (e)'s half (`returned-by:review`) is implemented and tested (`51ce84b`, §7); its open gap — the
flag is invoked by no documented instruction — is carried as **F4** (§13). The symmetric half lands
when data exists, not before.

### What reopens it

The first structured test-squad **fail** with a non-empty findings axis (or, once F-06's record-time
enforcement holds, a populated `fingerprint.failingTests`) landing in
`.state/supervisor/*/verdicts/`. Re-run the measurement command above; when it prints a test record
with `findings>0`, design `returned-by:test` symmetric with (e) against that record and prove it by
mutation. Until then, F-05 stays **DEFER** with the counts above as its evidence.

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

## 8. Item (f) — catalogue reconciliation: explicit unsupported-above-threshold, with boundary fixtures

**Decision: (B) — explicit unsupported-above-threshold handling, not threshold-aware (tiered)
pricing.** Tiered pricing failed the issue's own triviality test, and the test is on the tree: the
price row is flat by construction — `model_prices` columns are
`price_set_id, model_key, input_price, output_price, cache_read_price, provider, cache_write_price`
(`scripts/telemetry-store.mjs:242`), rows are written by explicit column list (`:1458`, `ensurePriceSet`)
and read back as exactly four rate fields (`:1479`, `loadPriceSet`). A tier means a schema change plus
a migration plus a pricing-path change plus threshold-aware comparisons in `price-check.mjs` and
`config-drift.test.mjs` — five coupled surfaces for one model's override. The issue explicitly prefers
refusing to claim full correctness over selling the missing-field fix as one; (B) is that refusal,
made executable.

**What changed — all additive, nothing rewritten.**

- `config/models.json:264` — the `openai/gpt-6-astra` row gains a `promptTokenThreshold` object:
  `{minPromptTokens: 272000, above: {input: 20, output: 75, cacheRead: 2, cacheWrite: 25}, provenance: …}`.
  The flat base rates (10 / 50 / 1 / 12.5) are unchanged, and the override rates are **provenance from
  the issue's 2026-09-05 verification update, not live truth** — no network call was made, per the run's
  constraints. The `above` rates are not read by code in this change; they are the documented reason
  the boundary exists, and are the direct input a future tiered-pricing change (option (A)) would consume.
- `scripts/telemetry-store.mjs:1525-1526` — `calculateCost` refuses (returns `null`) when the resolved
  row declares a valid threshold and `usage.inputTokens >= minPromptTokens`. The comparison axis is the
  recorded prompt axis; cache-read tokens are a separate axis and are not folded in. A malformed
  threshold (non-finite, non-positive `minPromptTokens`) is ignored, not half-applied (`:1505`,
  `isPromptThreshold`).
- `scripts/telemetry-store.mjs:1514` — new export `priceThreshold(model, prices, provider, scoped)`,
  so callers can tell "no price row" apart from "row exists but does not cover this usage".
- `scripts/supervisor-watch.mjs:120` — `thresholdOne`, bound to the same snapshot as `priceOne`, passed
  to `costFromResult` (`:171`).
- `scripts/supervisor-lib.mjs:187-190` — `costFromResult` takes an optional 4th argument and, when a
  turn is refused by a threshold, the unpriced entry becomes
  `openai/gpt-6-astra (unsupported above 272000 prompt tokens)` instead of the bare model name — so the
  budget refusal names the real reason instead of sending an operator to add a row that already exists.

**The store never sees the threshold.** `ensurePriceSet` writes only the four rate columns (`:1458`),
`loadPriceSet` reconstructs only the four rate fields (`:1479-1494`), so every price set stored in
`model_prices` keeps billing flat — **historical and stored sets are untouched by this change**. The
threshold exists only in the live config path, exactly where "the committed table is a pinned snapshot"
semantics want it.

**What this changes in practice — measured, not assumed.** In the telemetry copy
(`.state/foc-165/telemetry-copy.sqlite`, `canonical_usage`), `openai/gpt-6-astra` holds **1266 rows
whose maximum `input_tokens` is 3** — no recorded astra turn is anywhere near the boundary, so the
change is **latent**: no stored cost flips, no canonical row moves. Reproduce:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.state/foc-165/telemetry-copy.sqlite',{readOnly:true});
console.log(db.prepare('SELECT COUNT(*) n, MAX(input_tokens) maxIn FROM canonical_usage WHERE model=?').get('openai/gpt-6-astra'))"
```

For completeness: exactly one real (non-synthetic) row in the whole corpus exceeds 272 000 prompt
tokens — `minimax/minimax-m3` at 470 452 (`source_path` a real transcript). That model has **no**
declared threshold, so it bills flat as before; whether the catalogue overrides it too is unknowable
without a catalogue call this run may not make, and is **not asserted either way**. The four rows at
exactly 1 000 000 are this run's own synthetic proof rows (`.state/foc-165/synthetic-proof.jsonl`, §9.2).

**The boundary fixtures.** `scripts/telemetry-store.test.mjs` pins the behaviour on a synthetic
threshold row *and* on the committed astra row: base rate below (`271_999` → `2.71999`), refusal at
exactly the threshold (`272_000` → `null` — `min_prompt_tokens` means the override applies *from* that
prompt size) and above (`500_000` → `null`), `priceThreshold` returning the declared object / `null`
for flat rows / `null` for a malformed one (which then bills flat), and the committed astra row
declaring `minPromptTokens: 272000` and refusing at the line. `scripts/supervisor-cost.test.mjs`
pins the watch-side contract: at/above the threshold the turn is unpriced with the qualified entry;
below it prices at the base rate; without the new binding the entry stays the bare model name
(back-compat for every other `costFromResult` caller).

**Mutation evidence.** Each branch was shown to fail when reverted: (1) the `calculateCost` refusal
disabled (`if (false && …)`) → `telemetry-store.test.mjs` **53 passed, 2 failed** (at-threshold
returns `52.72` instead of `null`; the committed-astra test fails) and `supervisor-cost.test.mjs`
**32 passed, 2 FAILED**; (2) the qualifier dropped in `costFromResult` → `supervisor-cost.test.mjs`
**33 passed, 1 FAILED** (the qualified-entry assertion). Restored, all four affected files are green:
`telemetry-store.test.mjs` **55 passed, 0 failed**, `supervisor-cost.test.mjs` **34 passed, 0 failed**,
`supervisor-budget.test.mjs` **24 passed, 0 failed**, `config-drift.test.mjs` **26 passed, 0 failed**,
plus `telemetry-canonical-views-atomicity.test.mjs` **PASS** and `node scripts/lint.mjs` **exit 0**
(scope: 400 files; `json-parse` covers the edited `config/models.json`).

**What (B) deliberately does not do.** (i) It does not bill the override — a turn above the threshold
is *unknown*, and the cap machinery treats unknown as refusal (the (g) behaviour), which is the honest
state: the alternative number would be an under-count. (ii) The budget refusal's *hint* (`:276`, "add
the model to pricing.openrouter") is not threshold-aware — with the qualifier the holder line already
states the real reason, but the hint line still points at adding a row; left as-is on purpose, it is
one string in a path that (g) owns. (iii) It does not touch the `z-ai/glm-5.3-flash` drift — that is
finding **F8** (§13), a dated price-sync decision for Mateusz, not a mechanical edit: the committed row
stays `0.071 / 0.24 / 0.015`, the issue's 2026-09-05 catalogue figure was `0.075 / 0.25 / 0.015`, and
`price-check.mjs` run 2026-09-15 reported the live catalogue at `0.15 / 0.5 / 0.03` (~2×; §1.7).

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

### 10.4 What the tests do about divergence — the DoD item

The DoD asks for *"tests for fabricated-vs-computed divergence"*. Three exist, and they pin the
divergence rather than a particular ratio — correctly, since the ratio is a property of a model's
stream pricing and moves between 3.7× and 64× across models on stored data (§11.5):

| test | what it pins |
|---|---|
| `a $0 model costs $0 however loudly the stream disagrees` (`supervisor-cost.test.mjs:102`) | the exact case that exposed the defect: OpenRouter serves `stealth/ox-alpha` free, Claude Code billed the turn at `$0.20587`. Asserts `computed === 0` **and** `reported === 0.20587699999999998` — the divergence is asserted as a fact, not smoothed away |
| `budgetStatus sums children and keeps the reported figure apart` (`:314`) | `costUsd` and `costUsdReported` are summed into separate fields (`1.5/9` and `0.5/4` → `reported: 13`), so neither replaces the other (AC2) |
| the cap suite (`:258`–`:291`) | the cap acts on `spent` (computed), never on `reported` — a cap that tripped on the fabricated figure would fire ~59× too early |

A note on what is **not** claimed here: nothing in this report says the stream figure is *wrong* as a
stream figure. `total_cost_usd` is Claude Code's own estimate, computed against a price list for a
model it does not recognise. What the measurements show is that it does not describe **this** repo's
spend, and that a cost series built on it was off by a factor between 50 and 79 — at the committed
rates, which are themselves ~2× stale (F8).

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

**The copy actually used — and a correction to the brief.** The turn brief says to *"state which copy
path you used for the telemetry store (via `LA_TELEMETRY_DB`)"*. That is not how it was done, and the
difference is worth one paragraph rather than a silent substitution:

- `LA_TELEMETRY_DB` is **unset** in this child (`process.env.LA_TELEMETRY_DB === undefined`), and
  **no proof script in `.state/foc-165/` reads or sets it**. Every one of them addresses the copy by
  explicit path — `counts.mjs:4`, `cost-reported.mjs:10`, `proof-resolve.mjs:6`, `foc165-proof.mjs:11`,
  `make-copy.mjs:9` all open `…/.state/foc-165/telemetry-copy.sqlite` directly.
- So the env-var mechanism `telemetry-store.mjs:59` defines (`process.env.LA_TELEMETRY_DB ||
  join(telemetryHome(), "telemetry.sqlite")`) was **not** the mechanism used here. Pointing the scripts
  at the copy by explicit path is the *stricter* form of the same guarantee — it cannot fall back to the
  live store if the variable is misread — but the report should say what happened, not what was asked
  for. Nothing in this report depends on the difference; every number in §4 and §11 comes from the copy.

**The copy.**

| | path | size | mtime |
|---|---|---|---|
| live | `%LOCALAPPDATA%\linear-agents\telemetry\telemetry.sqlite` | 586 670 080 B | 2026-09-15T13:30:48Z |
| **copy (all queries)** | `.state/foc-165/telemetry-copy.sqlite` | 563 294 208 B | 2026-09-15T13:06:08Z |

The copy was made by `node .state/foc-165/make-copy.mjs`, which opens the live store with
`{ readOnly: true }` (`make-copy.mjs:18`), sets `PRAGMA busy_timeout = 30000`, and materialises the copy
with `VACUUM INTO` (`:20`) — the pattern from `scripts/telemetry-prune.mjs:125-135`. It refuses to
overwrite an existing copy (`:10`–`:13`), which is why re-running it is safe and why this run reused the
copy taken at 13:06:08Z rather than replacing it.

**The live store was never written by this report, and the honest form of that claim.** The live file's
mtime is **later** than the copy's (13:30:48Z vs 13:06:08Z) — it was written *during* this session, by
the live supervisor's watcher, not by this child. A read-only open is not proof by itself, so the claim
made here is the checkable one: the five scripts this report used all open the copy path, and this child
executed nothing else against a telemetry database. The one write this run performed anywhere —
`foc165-proof.mjs`'s synthetic FP8 row proving (b) prices — went to the copy (`:3`, `:11`), and those
rows are excluded by `run_id = 'foc165-synthetic-proof'` from every count in §11.

**Not done, and therefore not claimed:** the live store was never opened read-only to confirm the
absence of the synthetic run id, because opening a WAL database read-only alongside its live writer has
its own failure modes and the evidence above does not need it.

## 13. Findings beyond (a)–(g)

Each is a **dated finding with a proposed disposition**. None of them was fixed in this turn: this turn
produces the report, and per the run's constraints a fix-or-defer decision beyond (a)–(g) stops here.

### F1 — `deepseek/deepseek-v4-pro` is not at the DoD's figure (dated 2026-09-15)

**Observed.** `config/models.json` → `pricing.openrouter["deepseek/deepseek-v4-pro"]` is
`{input: 0.66, output: 1.98, cacheRead: 0.022}`. The DoD says it is *"corrected to 0.87 / 1.74 /
0.0725"*. It is not, and neither is `deepseek/deepseek-v4-pro-0813`, which carries the same value.
Reproduce:

```bash
node -e "const p=require('./config/models.json').pricing.openrouter;
  console.log(p['deepseek/deepseek-v4-pro'], p['deepseek/deepseek-v4-pro-0813'])"
```

**Why it matters.** The issue's own justification for `price-check.mjs` names this model by name: it
*"sat ~10% under the real rate with 8.9M input and 53.5M cache-read tokens already spent against it"*.
A DoD item that names an exact number and is not met is the kind of thing a release decision must not
discover later.

**Complication, stated plainly.** Run at 2026-09-15, `price-check.mjs` reports the live catalogue at
`1.6 / 3.2 / 0.135` for this key — which is **neither** the committed value nor the DoD's target. So
"apply the DoD's numbers" is itself now of uncertain value: it would replace one disagreement with the
catalogue by another. The catalogue is a moving target; the DoD's figures are a point-in-time
measurement with a date attached.

**Proposed disposition.** Do not silently write `0.87 / 1.74 / 0.0725` and call the DoD met — the value
would be stale before it landed. Either (i) re-run `price-check.mjs` at landing time and commit the
then-current figure with the check date recorded as provenance, or (ii) amend the DoD to state the
*date* its figures came from and accept them as pinned. (i) is the recommendation; it is the same
"catalogue time/provider as provenance" rule the issue already states for `z-ai/glm-5.3-flash`.

### F2 — `config/models.map` still lacks 10 role keys, and the checker cannot see it (dated 2026-09-15)

**Observed.** Measured against the role files that exist in the tree:

```
dev:    debugger, flash, implementer, recon, refactorer, worker   →  missing: flash, worker
plan:   decomposer, discovery, flash, push, spec, spec-review, worker → missing: flash, worker
review: deep, first-pass, flash, security, worker                 →  missing: flash, worker
test:   deployer, flash, root-cause, runner, scenario-gen, worker →  missing: flash, worker
cadence: collector, digest, flash, retro, worker                  →  missing: flash, worker
```

That is **10 missing `(area, role)` keys — `flash` and `worker` in each of five squads** — not the "5
role keys" F-14 states. `git ls-tree` at the review's own commit `527bc64` gives the same 10, so the
review's figure is a count of *squads*, or of distinct role names; either way the register understates
the gap by half. Reproduce:

```bash
git ls-tree -r --name-only 527bc64 | grep -E '^agents/[a-z]+/agents/[a-z-]+\.md$'
git show 527bc64:config/models.map | grep -v '^_id'
```

**Why it matters, mechanically.** `bin/agent.bat:26` seeds `set "M=z-ai/glm-5.2"` and overwrites it
**only** if `%AREA%.%ROLE%` appears in `config/models.map` (`:27`–`:29`). A role with no key is
therefore not an error — it silently launches a `flash` or `worker` subagent on `glm-5.2`, at a
different price and a different capability from the role's routing. The checker validates the *other*
direction only: `scripts/check.mjs:206` reports a `models.map` key that has no `agents/<area>/agents/
<role>.md`, and nothing reports a role file that has no key. So `node scripts/check.mjs` passes while
the drift is live.

**Proposed disposition.** **Fix now** (F-14's own disposition, and it is a ten-line config change):
add the ten keys, then add the missing reverse check to `scripts/check.mjs` — a key set that cannot
detect its own omissions will re-open the same finding. Note this is *not* done here because it touches
`scripts/check.mjs`, which this turn's authorised paths do not include.

### F3 — `ids.opus`: half the claim is verifiable, half is not (dated 2026-09-15)

**Verified half.** `config/models.json` → `ids.opus` = `anthropic/claude-opus-4.8`;
`config/models.map` → `_id.opus` = `anthropic/claude-opus-4.8`; `config/models.native.map` →
`plan.lead` / `plan.spec-review` = `claude-opus-4-8`. All three agree with each other, and
`pricing.openrouter` carries an `anthropic/claude-opus-5` row that nothing routes to. So *"the price
table knows an opus the routing never selects"* is confirmed.

**Not verified.** F-14's phrasing is *"`ids.opus` → 4.8 vs plan-native opus-5"*. Nothing in the tree
says plan is supposed to be on opus-5: `grep -rn "opus-5|opus5" config/ docs/agents/ agents/*/CLAUDE.md`
returns **only** the price row (`config/models.json:167`). The claim that plan *should* be on 5 came
from somewhere other than this repo.

**Proposed disposition.** **Defer with the question stated** rather than "fix" a drift whose direction
is unestablished: is the intent that `opus` means the newest Opus (→ routing and native map both move
to 5, three files), or that 4.8 is deliberately pinned and the opus-5 price row is the dead entry (→
delete the row)? Both are one-commit changes; guessing between them is not.

### F4 — item (e)'s flag is implemented but wired into nothing (dated 2026-09-15)

**Observed.** `grep -rn "clear-returned-by-review" agents/` returns nothing.
`agents/review/CLAUDE.md:143` — the clean-path hand-off — invokes `publish-linear-comment.mjs` with
seven flags and not this one. So the FOC-284 stale label would recur on the next review pass, exactly
as before `51ce84b`.

**Proposed disposition.** **Fix now, and it is a one-line edit to a file this run may not touch**
(`agents/**` changes go to Mateusz by the repo's own rule). Add `--clear-returned-by-review` to the
clean-path command at `agents/review/CLAUDE.md:143`. Until then item (e) is a capability, not a fix —
see §7.

### F5 — the divergence fixture is not faithful to real `modelUsage`, and overstates the ratio 2.7× (dated 2026-09-15)

**Observed.** The four original fixture events are `dev-1`'s, with `modelUsage` replaced by the
top-level `usage` shape. Real per-model entries are a different measurement: `dev-1` #1 has 498 336
per-model input tokens against a 132 629 top-level. Pricing the fixture therefore yields **169.9×** for
a set whose real ratio is **63.1×** (§10.3).

**Proposed disposition.** **Defer, deliberately.** The fixture is reviewed test input that four existing
tests and §9.2's mutation evidence assert against; changing its numbers now would invalidate the
evidence that justifies the (g) fix. The behavioural pins it carries (zero-token → `$0`, unpriced →
`null`) do not depend on the magnitude. Carry as a follow-up: add one event with a *real* per-model
entry that differs from its top-level `usage`, so the suite prices one honest shape. If anyone quotes a
divergence figure from the fixture in a release decision, §10.3 must travel with it.

### F6 — `anthropic/claude-fable-5` has no price row, so 10 rows can never be repriced (dated 2026-09-15)

**Observed.** `canonical_usage` holds 10 rows for `anthropic/claude-fable-5`, all unpriced
(`SUM(cost_usd) = NULL`), all from one run (`2026-08-09T13-36-24-712-dev-a18b`, squad `dev`, agent
`recon`). The key is absent from `pricing.openrouter` **and** `pricing.nebul`, and absent from the
newest price set in the store. Unlike FP8 (§11.3), no fix to the resolution path helps: there is no row
to resolve.

**Proposed disposition.** **Decide, don't default.** Either add a price row (needs a real rate for a
model this repo may no longer route to) or accept 10 permanently-unknown rows and note it where the
coverage table is read. What must not happen is a `$0` default — `null` is the correct answer today and
that is AC3 working.

### F7 — the issue body is stale in a way that could mislead a reviewer (dated 2026-09-15)

The FOC-165 description presents two defects as open — the missing cap and its unread env var — and
implies the grep behind that claim is current.

**Observed.** The cap *is* read at runtime (`scripts/supervisor-lib.mjs:222`, called from
`supervisor-spawn.mjs:214` and `supervisor-followup.mjs:137`), and the commit that landed it is
`a720b88`, dated **2026-08-26** — three weeks before this run's base `f887fb9`. So the issue's
"no runtime reads the cap" is a 2026-08-26 grep, and both defects it describes had been fixed before
this run started.

**Proposed disposition.** **Fix now, cheaply:** annotate the issue body with the date and the commit
that closed each defect, or the next reader re-derives a resolved problem. This report is the
annotation (§1.4 is the current-state answer).

### F8 — the "measured" costs are measured at rates that now disagree with the catalogue by ~2× (dated 2026-09-15)

**Observed.** `z-ai/glm-5.3-flash` — the model every child of this run was routed to — is committed at
`0.071 / 0.24 / 0.015` (`config/models.json`). `price-check.mjs` run at 2026-09-15 reports the live
catalogue at `0.15 / 0.5 / 0.03`: **2.11× / 2.08× / 2.00×** the committed values, i.e. ~2.07× overall.
The issue's own 2026-09-05 check had it at `0.075 / 0.25 / 0.015` — so this is not the check being
wrong, it is the catalogue moving between 09-05 and 09-15.

**Why it matters more than it looks.** Every "computed" figure in this report is computed *at the
committed rates*. If the live rates are the real ones, then the measured cost of this run is
**~$0.36 rather than $0.17**, and the divergence against the stream's $30.56 is ~24× rather than 58.8×.
The direction of the headline is unchanged and the defect is unchanged — but the magnitude is a
function of a price table that is currently ~2× stale, and no reader should take `$0.17` as money.

**Proposed disposition.** **Do not "fix" silently.** The issue already states the rule — *"treat
catalogue time/provider as provenance and reconcile via the existing price-sync policy rather than
silently rewriting historical costs"*. Reconciling `glm-5.3-flash` at the current catalogue rate is a
deliberate price-sync act with a date attached, and it belongs in the same decision as F1 (the two are
the same question asked about two models). Record in the report — as here — that the computed series
carries a *rate-date* caveat, not just an unpriced count.

### F9 — a supervised full-suite run is red for two environmental reasons, one per run (dated 2026-09-15)

**Observed.** The full suite was run twice this turn at head `39147c5` (§14.6). First run, exactly as
specified — `npm ci` (exit 0) then `node scripts/test-all.mjs` from the worktree root, in this child's
inherited environment: exit 1, **62/63 passed** in 376 197 ms, sole red
`supervisor-cleanup.test.mjs`. Its own output names the cause: 22 of 26 assertions fail with
`refusing: LA_SUPERVISOR_CHILD=dev-5 is set, so this is running inside a spawned child` — the
`LA_SUPERVISOR*` variables the supervisor sets on every spawned child leak into the suite, and this
file asserts it is *not* running inside a spawned child. Re-run of that file alone with the four
`LA_SUPERVISOR*` variables unset: exit 0, **26 passed, 0 failed**. So the red is deterministic in the
inherited environment and deterministic green in a clean one — a property of where the suite was run
from, not of the candidate. `LA_SUPERVISOR_MAX_COST_USD` itself was checked before the run and is
**UNSET** in this shell.

The second full run, same command with only the four `LA_SUPERVISOR*` variables unset, flipped the red
to a different file: `supervisor-semaphore.test.mjs` (exit 1, 80 165 ms; assertion `--release starts a
held request once the slot frees` — the child it spawned produced no `system/init` within the test's
30 000 ms window). That file alone, clean env: exit 0, **19 passed, 0 failed**; in the first full run
it passed at 50 074 ms. Timing-sensitive under full-suite load, not deterministic — the same class of
flake as `telemetry-concurrency.test.mjs` before item (c), but with a timeout budget instead of a race.

**What is clean.** `telemetry-concurrency.test.mjs` — item (c)'s own fix — passed in both full runs
(490 ms, 476 ms). No red anywhere was attributable to any of (a)–(g): in each run the single red file
was a hermetic `supervisor-*` test failing on its environment or its timing budget, and each passes
when run alone.

**Why it matters.** `test-all` exits 1 on both runs, so "the suite is green" is not a claim this report
can make from inside a supervised run — but "the candidate is red" would be equally false. A reader
sees exit 1 and must be able to trace which file and why without re-running anything.

**Proposed disposition.** Do not weaken either test. Two candidate fixes, both outside (a)–(g) scope,
neither applied here: (i) have `test-all.mjs` drop `LA_SUPERVISOR*` from the environment it passes to
each spawned test file (the hermetic files assume a clean env; the runner running *inside* a
supervised child is exactly the leak §14.6 shows); (ii) read the semaphore test's 30 000 ms
`system/init` window from an env override so loaded machines stop eating flaky reds. Until one lands,
a supervised full-suite run reports one environmental red per run, and the honest way to read it is
§14.6: which file, solo re-run, clean-env re-run.

## 14. Commands run

Every command below was run in this worktree
(`C:\Users\mateu\Documents\GitHub\la-wt\linear-agents\foc-165-dev`) at head `6edebf1`, by this child.
Results are the observed ones; a command whose output is red is followed by what was red.

### 14.1 Tests and gates — all executed, all green

| command | result |
|---|---|
| `node scripts/supervisor-cost.test.mjs` | **31 passed, 0 failed** |
| `node scripts/telemetry-store.test.mjs` | **51 passed, 0 failed** |
| `node scripts/cost-guard.test.mjs` | **8 passed, 0 failed** |
| `node scripts/publish-linear-comment.test.mjs` | **7 passed, 0 failed** |
| `node scripts/telemetry-canonical-views-atomicity.test.mjs` | **PASS** |
| `node scripts/config-drift.test.mjs` | **26 passed, 0 failed, exit 0** |
| `node scripts/lint.mjs` | **OK: 400 files checked, 0 violations**, exit 0. Tool-printed scope: `json-parse 30 files`, `conflict-marker 400`, `bom 400`; tool-printed `Not covered: gitignored and machine-generated content in git mode (node_modules/, .state/, agent runtime dirs, tools/nebul wire captures, generated config/atlas-mcp.json, credential files)` |

The lint row is stated in full — command, exit code, scope and `not covered` — because a lint that
covers nothing is false evidence. Beyond the gitignored set the tool declares, `.state/foc-165/*.mjs`
(including the proof scripts this report relies on) is **not linted** by this run.

### 14.2 Evidence scripts — all executed

| command | purpose | where its output appears |
|---|---|---|
| `node .state/foc-165/divergence-fixture.mjs` | the six fixture events through `costFromResult` × `pricingSnapshot` | §10.3 |
| `node .state/foc-165/divergence-live-tee.mjs` | this run's real tees, priced twice (real `modelUsage` vs the fixture's normalisation) | §10.2, §10.3 |
| `node .state/foc-165/counts.mjs` | raw vs canonical counts, price-set registry, JOIN-mismatch check | §4, §11 |
| `node .state/foc-165/cost-reported.mjs` | stored reported/computed medians per model | §11.5 |
| `node .state/foc-165/foc165-proof.mjs` | writes one synthetic FP8 row to the **copy** and reads it back priced | §4 |
| `node .state/foc-165/make-copy.mjs` | (run before this turn) the read-only `VACUUM INTO` copy — **refused to overwrite**, existing copy reused | §12 |

### 14.3 Mutation runs — red before green, then reverted

Each was applied to a clean tree, run, and reverted with `git checkout -- scripts/supervisor-lib.mjs`;
`git status --porcelain` after each showed only the intended files. Full table and interpretation in
§9.2.

| mutation | result |
|---|---|
| `scripts/supervisor-lib.mjs` ← `git show b055340^:…` (whole file reverted) | `26 passed, 5 FAILED` |
| `sawTokens` guard read off top-level `usage` | `29 passed, 2 FAILED` |
| zero-token result answering `null` instead of `0` | `27 passed, 4 FAILED` |

### 14.4 Network-using, deliberately

| command | result |
|---|---|
| `node scripts/price-check.mjs --json` | **exit 1**; 7 drifting prices, 4 unlisted models — §1.7, §1.8 |

This is the only command in the run that touched the network. It is AC7's own acceptance test
(`scripts/price-check.mjs:5`–`:7` documents it as network-using and deliberately outside
`config-drift.test.mjs`), so it was run once and its output recorded. Everything else — every price,
every token count, every row count in this report — came from `config/models.json`, the issue's quoted
2026-09-05 figures, or the copy of the telemetry store. No catalogue figure was re-derived beyond this
one invocation, and the two drift rows it reports are carried into §13 as findings with their date
attached rather than as corrections applied here.

### 14.5 Not run, and therefore not claimed

- **`agents/review/CLAUDE.md` was not edited** and the review clean path was not driven end-to-end
  (F4). Reading it is all this turn did.
- **No Linear write of any kind.** No transition, no label, no comment, no description update.
- **No `git push`, no PR, no merge**, and no command was run in any other worktree or against any other
  branch. `config/models.map`, `config/models.json` and `scripts/check.mjs` were read, not modified
  (F1, F2, F3).
- **No Windows shell was driven through an over-budget launch** (§3), and the `--clear-returned-by-review`
  removal was never executed against Linear (§7, F4).
- **The live telemetry store was never opened by this child** (§12).

### 14.6 Full suite — run this turn, at head `39147c5`

Two full runs, both from the worktree root; logs kept at
`.state/foc-165/test-all-run.log` (run 1) and `.state/foc-165/test-all-clean-env.log` (run 2).
Per-file counts are the runner's own summary lines.

| run | command | exit | summary | red file |
|---|---|---|---|---|
| 1 | `npm ci && node scripts/test-all.mjs` | 0 / **1** | **62/63 passed** in 376 197 ms; `npm ci`: 19 packages, 0 vulnerabilities | `supervisor-cleanup.test.mjs` (9 415 ms) — 4 passed, 22 FAILED |
| 2 | `npm ci` already done; `env -u LA_SUPERVISOR -u LA_SUPERVISOR_CHILD -u LA_SUPERVISOR_REPO -u LA_SUPERVISOR_RUN node scripts/test-all.mjs` | **1** | **62/63 passed** in 396 831 ms | `supervisor-semaphore.test.mjs` (80 165 ms) — 18 passed, 1 FAILED |

Solo re-runs of each red file (clean env, same command, no suite load):

| file | result |
|---|---|
| `node scripts/supervisor-cleanup.test.mjs` | exit 0, **26 passed, 0 failed** |
| `node scripts/supervisor-semaphore.test.mjs` | exit 0, **19 passed, 0 failed** |

Run 1 is the run specified by the issue — the real result is **exit 1, 62/63**, and the red is
environmental, not the candidate: this child is spawned with `LA_SUPERVISOR=1` and
`LA_SUPERVISOR_CHILD=dev-5`, those variables leak into every test file `test-all.mjs` spawns, and
`supervisor-cleanup.test.mjs` asserts it is running *outside* a spawned child (the full trace is F9).
Run 2 isolates the two causes: with the four variables unset, cleanup passes and the red moves to the
semaphore file's timing budget. Both reds are `supervisor-*` hermetic tests; both pass solo; neither
touches (a)–(g). `telemetry-concurrency.test.mjs` (item (c)) passed in both runs. No test, threshold
or skip was adjusted.
