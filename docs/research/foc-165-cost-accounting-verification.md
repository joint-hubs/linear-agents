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

TBD

## 5. Item (c) — canonical views drop/recreate atomically inside `migrate`

TBD

## 6. Item (d) — F-05: verification only

TBD

## 7. Item (e) — pass-time removal of `returned-by:review`

TBD

## 8. Item (f) — catalogue reconciliation: verification only

TBD

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
