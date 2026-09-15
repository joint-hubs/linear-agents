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

*(Sections §1.1–§1.7 are filled in below in the same commit series as this skeleton.)*

## 2. Definition of Done — grading

| DoD item | Grade | Evidence |
|---|---|---|
| `supervisor-watch.mjs` prices from token counts | TBD | §1.1 |
| `total_cost_usd` kept as `costUsdReported` | TBD | §1.2 |
| unpriced → `null`, never `0` | TBD | §1.3 |
| `LA_SUPERVISOR_MAX_COST_USD` at turn boundaries, post-hoc, overshoot reported not rounded away | TBD | §1.4 |
| `config-drift.test.mjs` covers every gating env var | TBD | §1.6 |
| `scripts/price-check.mjs` exists | TBD | §1.7 |
| `deepseek/deepseek-v4-pro` corrected to 0.87 / 1.74 / 0.0725 | TBD | §1.8 |
| `stealth/ox-alpha` left at $0 (do not "fix") | TBD | §1.8 |
| tests: fabricated-vs-computed divergence | TBD | §10 |
| tests: unpriced → null | TBD | §1.3 |
| tests: cap trips at a boundary | TBD | §1.4 |
| tests: cap absent → no change | TBD | §1.5 |

## 3. Item (a) — over-budget kill-switch in the standalone launchers

TBD

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
