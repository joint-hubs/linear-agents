# FOC-219 — Design: unify Supervisor and legacy verdict evidence with round lineage

- **Issue:** FOC-219 (roadmap F2, parent FOC-102) — verbatim scope inlined by the Supervisor; no Linear access in this run.
- **Status:** DRAFT → ready for supervisor validation / DEV handoff after review. Corpus evidence (§3) grounded in a read-only survey of the main checkout's `.state/` (no file there was read for writing; every number below is reproducible from the cited commands).
- **Date:** 2026-09-07. **Author:** PLAN child (supervisor run `2026-09-05T22-16-33-119-supervisor-dd5b`).
- **Target:** new `scripts/verdict-evidence.mjs` (+ `scripts/verdict-evidence.test.mjs`), composed with the F1 module (`scripts/delegation-outcomes.mjs`, landed `313589a`). **No code in this run — design only.**
- **Out of scope:** new telemetry DB tables, parsing TEST free-text reports into verdicts, changing any legacy field of `delegation-outcomes.mjs`, touching `.state/` anywhere.

## 0. TL;DR

Structured supervisor verdicts (`.state/supervisor/<runId>/verdicts/*.json`, 74 files / 37 tasks) and legacy review reports (`.state/reviews/*-roundN.md`, 58 files / 42 tasks) are two evidence stores with **exactly 9 tasks in both**. FOC-219 adds one **pure, stateless projection module** that normalizes both into rows keyed by issue / stage / attempt / round / source, rolls them into logical verdicts (same verdict in two sources = one row with dual provenance), separates REVIEW pass from final TEST pass from human acceptance, and exposes `matched / unmatched / ambiguous` coverage that sums to the logical-verdict count. Idempotency is by construction: the projection is a pure function of file contents — no ingestion state, no DB writes; re-runs over the same inputs are asserted byte-identical in tests. Consumers see only additive change: a new module, a new `/api/verdict-evidence` route; `delegation-outcomes.mjs` is imported from, not modified (one `export` keyword added to reuse an existing internal join). The one decision left to Mateusz: the **conflict-resolution rule** when the two sources disagree on the same (issue, round) — §4.3 presents three options, recommends supervisor-precedence with surfaced ambiguity, and §9 flags it as the open question.

## 1. Verified facts (with paths) and corrections

Verified by direct read or read-only command in this run (worktree `foc-219-plan`, base = current branch head `313589a`):

1. **Home repo is `linear-agents` — confirmed.** The `fenix-plan:F2` marker, parent FOC-102 and roadmap `docs/plans/fenix-stabilization-and-learning.md` (F2 row at L32) live here; F1 (FOC-218) landed here on main (`313589a` merge, design commit `bdc1499`). The kickoff comment's speculation about `fenix`/`fenix-platform` repos does **not** match the facts — the corpus, the scripts and the roadmap are all in this repo.
2. **Structured source.** `.state/supervisor/` holds **45 run dirs** (`ls | wc -l`; 3 are `test-*` scaffolds); **28 contain `verdicts/`** with **74 JSON files covering 37 distinct taskIds** (largest: FOC-225 with 9 rounds, FOC-151 with 7). Record schema from `scripts/supervisor-verdict.mjs` L329-341: `{taskId, runId, childId, squad, round, verdict: "pass"|"fail", findings[], acMapping[], declaredAcs, fingerprint{diff,tests,combined,changedFiles,failingTests,error}, recordedAt}`; filename `verdicts/<taskId-lowercase>-round<N>.json` (`verdictPath`). A verdict is recorded **once** per (task, round) unless `--force` (L344-348) — the source is append-dominant. Round number is per (run, task), monotonic via `latestVerdict(...)?.round + 1` (L326-327) — **not** per recording child.
3. **Legacy source.** `.state/reviews/` holds **89 entries: 58 round files across 42 taskIds** (FEN 2 / FOC 32 / JOI 33 files), 24 non-round artifacts (`*.patch`, `*-crossref-*.md`, `JOI-71-desc.md`, `review-squad-audit.md`, …) and 4 helpers (`_prompt-*.txt`, `_run-pass.sh`). The FOC-218 parser's `^(.+)-round(\d+)\.md$` regex already selects exactly the 58. `.state/review-rounds.json` has **37 keys** including mocks `task-a`/`task-b` and tasks whose files no longer exist.
4. **Overlap between the two sources (computed, `comm` of sorted taskId sets):** **9 tasks in both** (FOC-142, 151, 156, 171, 172, 173, 177, 199, 211), **28 structured-only** (every supervisor-era task from FOC-176 onward incl. FOC-218/225/226/227/243), **33 legacy-only** (all FEN-*, all JOI-*, and pre-supervisor FOC-41/73-79/91/147/154). Round-level overlap is partial: FOC-151 has legacy rounds 1-4 vs structured 1-7; FOC-156 legacy 1-2 vs structured 1-3; FOC-177 legacy has **only round2** (the known orphan) vs structured 1-2.
5. **CORRECTION to the kickoff ground facts.** "The legacy reports that have no supervisor run at all (the 14 unmatched)" conflates two different axes. Verified by running `node scripts/delegation-outcomes.mjs --json` read-only on the main checkout: top-level `matched: 44, unmatched: 14` counts tasks **matched to telemetry delegations** (`run_task_links` join), not to supervisor verdicts. The legacy-without-structured-verdict set is **33 tasks** (fact #4). Both axes are real; the projection reports source-coverage, and the telemetry-delegation match stays where F1 put it (§4.7).
6. **CORRECTION (nuance) to "TEST verdicts are NOT recorded via supervisor-verdict".** Mostly true as policy, but the structured corpus **contains verdicts recorded by `test-*` children**: FOC-151 rounds 2/5/7 carry `childId: "test-4"` (verified by reading the three JSONs). Therefore **stage must be derived per record from `squad`/`childId`, never assumed from the source or the flow** (§4.4).
7. **Real cross-source conflicts exist in the corpus** (the AC #1/#2 core, not hypothetical): **FOC-156 round 1** — legacy `FOC-156-round1.md` says `🔴 REQUEST CHANGES` (FAIL) vs structured `foc-156-round1.json` `verdict: "pass"`; **FOC-151 round 2** — legacy FAIL (`VERDICT PROPOSAL: FAIL`, per FOC-218 census §3.7) vs structured `verdict: "pass"` recorded by `test-4`. The other 7 dual-source tasks agree (FOC-142 r1 fail/r2 pass, FOC-171/172/173/199/211 pass, FOC-177 r2 pass).
8. **TEST-stage evidence today** (none of it in `verdicts/*.json` as policy): free-text reports written into the run dir, e.g. `2026-09-05T22-16-33-119-supervisor-dd5b/test-18-slice3-verdict.txt` (Polish per-check suite results); **structured** `gates/*.json` records carrying `facts.testState: "Done"` (e.g. `gate-test-25-2.json`-adjacent cleanup gate `gate-review-24-2.json`, summary "TEST approved: FOC-218 is Done"); `merge.json` with per-candidate `accepted` flags. Human acceptance exists today only as **prose inside gate answers** (e.g. gate-review-24-1.json answer quoting Mateusz's approval) and Linear state — no structured record.
9. **Work lineage backbone exists.** `<runId>/children.json` holds per child: `squad, taskId, sessionId, telemetryRunId, worktree, branch, baseRevision, turns[] (pid/startedAt/endedAt/gateId/reviewLoop), costUsd`. A resumed DEV is the **same childId with a new turn** (observed: `plan-2` with 3 turns); the verdict fingerprint (`progressFingerprint`, `supervisor-lib.mjs` L914+) fingerprints the **work child's** tree vs `baseRevision` (supervisor-verdict.mjs L307-324). Legacy round files carry `**Run:** \`<telemetry run id>\`` in their header (e.g. FOC-211-round1.md L~3), already extracted as `reviewRunId` (delegation-outcomes.mjs L255) — the legacy→telemetry linkage.
10. **Telemetry reuse surface.** `scripts/telemetry-canonical.mjs` counts **physical model calls / cost** (canonical_usage, canonical_tool_facts views) — nothing verdict-shaped; `docs/TELEMETRY-EXPLAINED.md` is narrative (no verdict counters). Verdict-shaped counting exists in exactly one place: F1's `delegation-outcomes.mjs` (`aggregateOutcomes` L302-385, `computeOutcomes` L454-541). The telemetry DB tables involved: `runs`, `usage_facts`, `run_task_links`, `cost_facts` (queried by `delegationsByTask` L395-419). There is **no verdict table in the DB** — nothing to deduplicate against there, and (per §4.7) this design adds none.
11. **Consumers verified by grep this run:** `scripts/telemetry-server.mjs` L53 (import), L1448-1452 (route), L1902 (smoke); `ui/src/api.js` L28-29; `ui/src/screens/Costs.jsx` L381-427 (renders `matched`/`tasksWithVerdict`/`unmatched`/`byPair`); CSV exports (external 01_LLM_EVAL R repo — out of reach, carried from FOC-218 §6); docs narrative only. `.gitignore` L34 = `agents/*/plans/` (hence the forced scoped commit).

## 2. Behavior map — what each source actually provides

| | Structured verdict (`verdicts/*.json`) | Legacy round file (`reviews/*-roundN.md`) | Run-dir lineage (`children.json`, `gates/`, `*-verdict.txt`, `merge.json`) |
|---|---|---|---|
| identity | `taskId`, `runId`, `childId`, `round` (per run+task) | filename `<ID>-round<N>.md`; `**Run:**` telemetry id in header | `childId` → `taskId`, `squad`, worktree/branch/base, `telemetryRunId` |
| verdict | `verdict: pass\|fail` (schema-enforced) | extracted by F1 `parseReview` → `PASS\|FAIL\|UNKNOWN` + `unknownReasons` + evidence line | `facts.testState` ("Done") in gates; free text in `test-*-verdict.txt`; `accepted` in `merge.json` |
| stage | `squad`/`childId` of the **recording** child (review-* but also test-*, fact #6) | review (by contract, `agents/review/CLAUDE.md` §4-5) | test (gate/testState), human (gate answer prose) |
| evidence | `acMapping[]` (per-AC citations), `findings[]`, `fingerprint.combined` | verdict line + lineNo + anchor (F1), marker counts, `reviewRunId` | gate facts (head, dirty, commitsAhead), test report text |
| work under review | `fingerprint` over the work child's diff vs `baseRevision`; `changedFiles` | sometimes a diff range in prose (`15b3da4..7a3cee2`, FOC-151 r2); usually none | `children.json` worktree/branch/base; `merge.json` candidates |
| time | `recordedAt` ISO | `**Date:**` prose; file mtime is NOT trusted (mutable, not content) | gate `createdAt`/`proposedAt`; turn timestamps |
| mutability | append-dominant; `--force` overwrite possible (fact #2) | static corpus (read-only for us) | append-ish; gates get `status: answered` |

What must NOT be equated: legacy round N and structured round N are counts taken by **different flows at different times** — FOC-156 r1 shows they can disagree, FOC-177 shows legacy can skip round 1 entirely. Round numbers are source-scoped facts; joining them is a corroboration decision (§4.3), not a key equality.

## 3. Corpus evidence (read-only survey, reproducible)

Commands behind every number (run in the **main checkout**, read-only): `ls .state/supervisor/`, `find .state/supervisor -path "*verdicts*" -name "*.json"`, `ls .state/reviews/`, `node scripts/delegation-outcomes.mjs --json`, per-JSON `node -e` reads, `grep` of verdict lines in the 9 dual-source tasks.

1. **Population:** 45 run dirs / 28 with verdicts / 74 verdict JSONs / 37 tasks · 58 legacy round files / 42 tasks · counter 37 keys. Telemetry-delegation axis (F1 report, live): 58 tasksWithVerdict → 44 matched / 14 unmatched; outcomes PASS 38 / FAIL 3 / UNKNOWN 17.
2. **Source overlap:** 9 both · 28 structured-only · 33 legacy-only (fact #4). Round-level: FOC-151 4 legacy vs 7 structured; FOC-156 2 vs 3; FOC-177 1 (round2 only) vs 2.
3. **Agreement census on the 9 dual-source tasks:** 7 agree (incl. the FOC-142 fail→pass arc); 2 conflict (fact #7) — **FOC-156 r1** and **FOC-151 r2** (the latter also a stage mismatch: recorded by `test-4`).
4. **Stage anomalies inside the structured corpus:** FOC-151's 7 rounds alternate recording children `review-3` / `test-4` (rounds 2/5/7 by test-4) — round numbering is task-scoped and monotonic across children, so `(childId, round)` is **not** a valid key component; `(runId, taskId, round)` is (unique per the record-once rule, fact #2).
5. **TEST evidence shape:** run-dir free-text (`test-18-slice3-verdict.txt`: per-check PASS/FAIL list in Polish) — parseable only with the same anchored-allowlist approach F1 built, which is **out of scope** here (§9); structured gate `facts.testState: "Done"` (FOC-218's closure); `merge.json` `candidates[].accepted` (the merge gate, currently `false` on the observed record — a stopped candidate, not a verdict).
6. **Legacy-only quality:** the 33 legacy-only tasks include the whole JOI/FEN era; F1 already classifies their verdicts (incl. the 17 UNKNOWNs with reasons). The projection must **reuse** those classifications verbatim — re-parsing them differently would fork the truth F1 just established.
7. **No credentials** surfaced in any file read for this design (verdict JSONs, gate records, review headers); gate answer prose quotes human approval messages but no secrets.

## 4. Design

### 4.1 Module surface and composition (reuse, no fork)

New `scripts/verdict-evidence.mjs` (zero deps beyond `node:` builtins; `node:sqlite` opened read-only and only for the optional delegation axis). It **imports the F1 parse/aggregate layer** rather than re-implementing any of it:

- `parseReview(text, taskId, round)` — already exported (delegation-outcomes.mjs L175);
- `loadReviews(reviewsDir)` — currently module-internal (L259): **add `export`** (additive keyword, zero behavior change);
- `aggregateOutcomes(roundReviews, roundsCounter)` — already exported (L302): reuses F1's legacy task-level outcomes, `unknownReasons` taxonomy and anomalies verbatim;
- `delegationsByTask(db)` — module-internal (L395): **add `export`** for the optional telemetry axis (same temporal `run_task_links` join F1 uses — one definition of "which delegation worked on this task").

Exports: `projectVerdictEvidence({ supervisorRoot = ROOT/.state/supervisor, reviewsDir = REVIEWS, roundsPath = ROUNDS, dbPath? } = {})` → report object; `buildLogicalVerdicts(evidenceRows)` (pure, unit-testable). CLI: `--json`, `--supervisor-root <dir>`, `--reviews-dir <dir>` (injection = testability, same pattern F1 landed in §4.5 of its design).

`delegation-outcomes.mjs` semantics are otherwise untouched; its 123-check test suite must pass **unmodified** (composition, not fork — the kickoff ground fact "your projection must compose with this, not fork it").

### 4.2 Identity key space

Two layers, because the DoD tuple `(issue, attempt, round, work_id, artifact_id)` describes a *merged* verdict while sources describe *records*:

**Evidence row** (source-scoped, one per source record) — unique at `(issue, stage, source, attempt, round)`:

| Component | Structured verdict | Legacy round file | Gate / test-record |
|---|---|---|---|
| `issue` | `record.taskId` (authoritative) | filename prefix, uppercased | `gate.taskId` |
| `stage` | `record.squad` (`review`/`test`/`dev`/`plan` — per record; fact #6 forbids assuming) | `review` (corpus contract) | `test` (from `facts.testState`) / `human-trace` |
| `source` | `"structured"` | `"legacy"` | `"structured"` |
| `attempt` | `record.runId` | **exact join**: file's `**Run:**` telemetry id (`reviewRunId`, F1 L255) matched against every `children.json` `telemetryRunId` → that run's id; fallback `"unsupervised:<issue>"` when absent/unmatched | the gate's `runId` |
| `round` | `record.round` (numeric sort) | filename `N` | `null` |
| `work` | `workId: "fp:<fingerprint.combined>"` when present (subset of records — FOC-151 r1/r3-r7 and FOC-177 have none), else `null`; `baseRevision` from `children.json` work child when resolvable | `null` (no fingerprint; diff ranges in prose are not parsed — 1 file in 58) | `gate.facts.fingerprint`/`head` |
| `artifacts` | `{kind: "verdict-json", path: "supervisor/<runId>/verdicts/<file>", sha256: 12-hex}` | `{kind: "review-md", path: "reviews/<file>", sha256}` | `{kind: "gate-json"/"test-report-txt", path, sha256}` |

`attempt` resolution is the load-bearing join and it is **exact, not heuristic**: verified this run — `FOC-142-round1.md` carries `**Run:** 2026-08-27T08-08-45-487-review-63bc` and run `2d75`'s `children.json` contains a child whose `telemetryRunId` is exactly that string. FOC-211's round file has **no** `Run:` line (verified) → `unsupervised:FOC-211`. Paths in artifacts are stored relative to `.state/` — machine-independent (children.json `worktree` absolute paths are normalized to `branch` + `baseRevision`, which are portable).

**Logical verdict** (the DoD tuple, after resolution) — unique at `(issue, stage, round)`; carries `attempt` (of the deciding/structured side), `work_id`, and `artifact_id[]` covering **every** source side (AC #4: nothing is collapsed away silently).

Non-Linear ids (`task-a`, `task-b` in the counter) remain rows with `qualityFlags: ["non-linear-id"]` — evidence honesty beats tidy data; they are never dropped (F1's precedent: `rounds-only` UNKNOWN).

### 4.3 Logical-verdict rollup and the conflict rule

Deterministic algorithm (groups built from sorted rows; no wall-clock, no randomness):

1. Group evidence rows by `(issue, stage, round)`.
2. One row → logical verdict = that row's verdict; coverage class **`unmatched`**.
3. Multiple rows, all verdicts equal → that verdict; **`matched`**.
4. Mixed decided + UNKNOWN → the decided verdict; **`matched`** with `resolution: "evidence-asymmetry"` (the UNKNOWN side stays in provenance and artifacts).
5. Multiple *decided* verdicts in conflict → **`ambiguous`**; `resolvedVerdict` set by the policy below; `conflict: {resolvedBy, sides}`; anomaly pushed; **both** artifact sets retained.

**No cross-round merging.** FOC-177 proves legacy can lack round 1; FOC-156 proves the two flows can number rounds differently; FOC-151 proves rounds can be recorded by different children (r2 by `test-4`). Same-event-different-number stays two `unmatched` logical verdicts, plus a surfaced `corroborationHints` entry when the exact attempt join (§4.2) places both rows in one attempt with equal verdicts. Under-merge inflates `unmatched` honestly; over-merge would silently delete records.

**Conflict rule — options with costs** (decision belongs to Mateusz → §9.1; observed conflict population: **3 of 14** merged cells, all self-verified in §3.3):

| Option | Rule | Cost |
|---|---|---|
| **A. Supervisor-precedence (recommended)** | `resolvedVerdict` = structured side's verdict; legacy side retained in `conflict.sides` + artifacts + `ambiguous` counter | A wrong structured `pass` decides the resolved field (real case: FOC-156 r1). But the conflict stays triply visible: `coverage.ambiguous`, anomaly, both artifacts — never silent. Rationale: structured records are schema-validated, evidence-cited (uncited findings are *refused*, supervisor-verdict.mjs L224-242) and fingerprinted; legacy is regex-parsed prose that produced 17 corpus UNKNOWNs. Deterministic by source class, not by time. |
| B. Conflict → UNKNOWN | `resolvedVerdict` = UNKNOWN(`source-conflict`) | Most conservative, but real corpus cost: FOC-151's 11 rounds (5 agreeing PASS + 2 agreeing arcs) would collapse to UNKNOWN in unified reports — a *regression* against F1's outcome for that task; downgrades usable signal on exactly the tasks with the richest history. |
| C. Newest-source wins | max(`recordedAt`) / mtime | Rejected: legacy files have no content-defined timestamp (mtime is mutable — breaks bit-identical re-runs across checkouts), and clocks across sources are not comparable. Nondeterministic by construction. |

All three options retain both records and artifacts; the choice changes only `resolvedVerdict` on 3 cells today.

### 4.4 Stage distinction — REVIEW ≠ final TEST ≠ human acceptance

Per issue, aggregated over attempts (attempts ordered by runId; rounds numerically):

- `review.finalVerdict` — resolved verdict of the **highest round** among review-stage logical verdicts; `review.firstPassClean` — round-1 resolved verdict (`null` when unknown), keeping F1's field semantics.
- `testAcceptance` — `pass` when a test-stage logical verdict resolves PASS **or** a gate record of the issue carries `facts.testState === "Done"` (structured, artifact-linked — verified shape, gate-review-24-2.json); `fail` when a test-stage FAIL resolves; **`unknown` otherwise** (the FOC-151-shaped test-child verdicts and the gate record are the only structured TEST evidence that exists; free-text `test-*-verdict.txt` is linked as artifact, never parsed — §9.4).
- `humanAcceptance` — **`unknown` by design today**: no structured human-acceptance record exists (gate answer prose quoting Mateusz is a *trace*, not a verdict; Linear state is unreadable in this environment). The field and `humanAcceptanceTraces[]` (artifact links) exist so a future structured record slots in without schema change.
- The three fields are never coalesced; no derived "done" field exists anywhere in the report (AC #3 — and the delivery contract's "dry-run/exit-zero is not Done").
- Stage anomaly: a test-squad record carrying a review-shaped body (`acMapping.length > 0`, the FOC-151 r2 case) gets `qualityFlags: ["cross-stage-recording"]` — surfaced, stage still as recorded.

### 4.5 Idempotency mechanics

- The projection is a **pure function of file contents**. There is no ingestion state, no cache, no DB write: "repeated ingestion" = re-running the projection over the same corpus, which is bit-identical by construction. (If a future incremental cache is ever needed, it must be content-addressed — hash of the sorted source-file digest list — not mtime-based; explicitly out of scope.)
- Determinism contract, asserted in tests: (1) every directory listing sorted before iteration; (2) rounds sorted numerically, never lexicographically; (3) every output object is built with literal key order — parsed JSON is **never** spread raw into output; (4) no wall-clock, mtime or env-derived value in output (`recordedAt`/gate timestamps are input data, allowed); (5) integer-only arithmetic in rows — cost stays out of rows entirely (telemetry's canonical views own cost; a row never carries a float).
- Artifact `sha256` makes the `--force`-overwrite case (supervisor-verdict.mjs L344-348) detectable: a changed input legitimately changes the output; same-inputs-same-output is the idempotency contract, not history-blindness.
- **No DB materialization** (rejected alternative): upsert dedup burden, schema migration, cross-process locking — and no consumer needs persisted rows, since the server recomputes per request (telemetry-server.mjs L1448-1451 pattern F1 documented).

### 4.6 Coverage and attribution schema

```js
coverage: {
  logicalVerdicts: 118,   // = matched + unmatched + ambiguous  (invariant asserted everywhere)
  matched:   11,          // both sources, agreeing (incl. evidence-asymmetry) — §3 baseline
  unmatched: 104,         // single-source cells: 60 structured-only + 44 legacy-only
  ambiguous: 3,           // decided conflicts: FOC-151 r2, FOC-151 r3, FOC-156 r1
}
```

```js
// evidence row (one per source record)
{
  issue: "FOC-156", stage: "review", source: "legacy",
  attempt: "2026-09-02T08-16-23-514-supervisor-de06",   // or "unsupervised:FOC-211"
  round: 1,
  verdict: "FAIL", unknownReasons: [], qualityFlags: [],
  work: { workId: null, fingerprint: null, reviewRunId: "2026-09-02T…-review-…" },
  artifacts: [{ kind: "review-md", path: "reviews/FOC-156-round1.md", sha256: "9f2c…" }],
  recordedAt: null, evidenceLine: { line: "…verbatim…", lineNo: 12 },   // F1 passthrough
}
// logical verdict (DoD tuple)
{
  issue: "FOC-151", stage: "review", round: 2,
  attempt: "2026-09-05T22-16-33-119-supervisor-dd5b",
  resolvedVerdict: "PASS",              // per §4.3 policy on conflict
  coverageClass: "ambiguous",
  conflict: { resolvedBy: "supervisor-precedence", sides: { structured: "pass", legacy: "FAIL" } },
  work: { workId: "fp:0136d67e402a8513" },              // null when no fingerprint — explicit UNKNOWN
  artifacts: [ /* structured side */ , /* legacy side */ ],
}
```

- **`attribution: "weak"`** — every role/model correlation surface this module emits carries the literal field plus `attributionNote` ("correlation, not causal credit"). Correlations are reported only, never fed into any verdict computation; `model`/`role` are `null` when unknown — no imputation, ever (AC #3). The byPair table itself remains F1's; this module adds no new correlation aggregate (that keeps the weak-attribution surface minimal and honestly labeled).
- Every logical verdict links **all** its retained artifacts (both sides on conflicts), paths stable across machines (§4.2).

### 4.7 Integration plan (additive-only, F1's compatibility bar)

| Surface | Change |
|---|---|
| `scripts/delegation-outcomes.mjs` | two `export` keywords (`loadReviews`, `delegationsByTask`); nothing else. F1 test suite must pass **unmodified** |
| `scripts/telemetry-server.mjs` | new additive route `GET /api/verdict-evidence` (same `compute→serve` pattern as L1448-1452); existing route + smoke list untouched except the additive entry |
| `ui/` | none required (no consumer yet); `Costs.jsx` untouched |
| CSV exports | none in scope — the 4 F1 CSVs are untouched; a unified CSV is deferred (§9.3) |
| telemetry DB | read-only reuse of `runs`/`run_task_links` via the shared join; **no new tables**; canonical views untouched |
| counters | the DB counts calls/cost/tokens (§1.10) — nothing counts verdicts, so the module's `coverage` counters duplicate nothing; cost/token counting is not replicated anywhere |

## 5. Fixture plan

Synthetic minimal trees built in `mkdtempSync` dirs at test time (repo convention: `telemetry-canonical.test.mjs`; F1 §5 precedent). No real corpus content committed; `.state/` does not exist in fresh worktrees. Shapes copied from real records with values anonymized; goldens are **inline expected objects** in the test (one file to maintain, diffable in review).

| Fixture | Content sketch (real-shape provenance) | Golden asserts |
|---|---|---|
| `duplicate_import` | one review round in BOTH sources, agreeing: legacy `**Verdict:** ✅ **Clean…**` + structured `{round:2, verdict:"pass", fingerprint{…}}` (FOC-142 r2 shape); legacy file carries `**Run:**` matching the run's `children.json` child | `logicalVerdicts === 1`; `coverageClass === "matched"`; `artifacts.length === 2`; counters sum: `matched+unmatched+ambiguous === logicalVerdicts`; attempt resolved via reviewRunId join (not `unsupervised:`) |
| `conflicting` | same (issue, round) in both sources: legacy `🔴 REQUEST CHANGES` (FAIL) vs structured `verdict:"pass"` (FOC-156 r1 shape) | `coverageClass === "ambiguous"`; `resolvedVerdict === "PASS"` (policy A); `conflict.sides = {structured:"pass", legacy:"FAIL"}`; anomaly `source-conflict` pushed; both artifacts linked; `ambiguous` counter = 1 |
| `resumed_dev` | `children.json` child `dev-3` with `turns[2]` (second turn `reviewLoop:true`, new `startedAt`); review rounds r1 FAIL (pre-resume) → r2 PASS (FOC-142 arc) | one attempt (same runId); exactly 2 logical verdicts — **no duplicate rows** despite repeated `childId`; lineage exposes `turns: 2`; `firstPassClean === false`; final review verdict PASS |
| `multi_round` | structured r1 `fail` + r2 `pass`; legacy r1 FAIL + r2 PASS, both rounds round-number-aligned (FOC-142) | 2 logical verdicts, both `matched`; `review.finalVerdict === "PASS"`; `rounds === 2` |
| `absent_test` | review PASS in both sources; **no** test-stage record, no gate | `testAcceptance === "unknown"`; `humanAcceptance === "unknown"`; no derived "done"; both unknowns explicit in report, not inferred |
| `stable_rerun` | any fixture corpus, files created in two different orders in two temp dirs (decoy names sorting before/after real ones) | two child processes, `sha256(JSON.stringify(report))` identical across (a) same dir twice, (b) the two order-variants; every row's `artifacts[].sha256` stable |

Optional validation (not a fixture): run `projectVerdictEvidence` over the **main checkout's** real `.state/` read-only and diff against the §3/§4.6 baseline — the semantic acceptance check (§7.3).

## 6. Consumer-compatibility inventory (AC #5 bar)

Verified by grep this run (line numbers current at base `313589a`):

| # | Consumer | How it reads today | Requirement on FOC-219 |
|---|---|---|---|
| 1 | `scripts/telemetry-server.mjs` L53 import, L1448-1452 route, L1902 smoke | imports `computeOutcomes`, serves JSON as-is, `null` → empty shape | **untouched**; new sibling route added additively; smoke list + one path |
| 2 | `ui/src/api.js` L28-29 `getDelegationOutcomes()` | `apiFetch('/api/delegation-outcomes')` | untouched |
| 3 | `ui/src/screens/Costs.jsx` L381-427 | renders `matched`, `tasksWithVerdict`, `unmatched`, `byPair[]` | untouched; no UI change in scope |
| 4 | 4 CSV exports → external 01_LLM_EVAL R repo (out of reach, per FOC-218 §6) | column-name based | untouched (no CSV change at all — stronger than F1's additive bar) |
| 5 | CLI humans (`delegation-outcomes.mjs` Polish report) | flags/labels | untouched |
| 6 | Docs narrative: `docs/README.md` L76, `docs/plans/agent-intelligence.md`, `docs/decisions/code-{review,audit}-*.md`, `docs/adr/0008-*.md`, `docs/TELEMETRY-EXPLAINED.md` | prose only | one-line README mention of the new script when it lands; nothing else |
| 7 | `.state/review-rounds.json` producer (`scripts/review-round.mjs`) | input, not output consumer | format unchanged |
| 8 | `scripts/test-all.mjs` suite | runs `scripts/*.test.mjs` | new test file must be green in the suite |
| 9 | NEW: `/api/verdict-evidence` | additive JSON only | must degrade to empty-but-valid shape when `.state/` absent (worktree-safe, same contract as #1) |

## 7. Test plan

1. **New `scripts/verdict-evidence.test.mjs`** (colocated, hand-rolled `check()`, `mkdtempSync`, run via `node --test` and picked up by `scripts/test-all.mjs`):
   - all six §5 fixtures with inline goldens;
   - pure `buildLogicalVerdicts` unit cases: rollup determinism, conflict classification, evidence-asymmetry, cross-round non-merge (+ corroboration hint), coverage-sum invariant;
   - idempotency, enforced not assumed: `sha256(JSON.stringify(project(inputs)))` equal across **two separate child processes** (`spawnSync(process.execPath, …)`), and across the two creation-order variants of `stable_rerun`;
   - key-order/determinism guard: report deep-equals a snapshot re-built key-by-key (catches accidental raw-JSON spread).
2. **Real-corpus read-only A/B** (runs only when the main checkout's `.state/` exists — `existsSync` guard keeps fresh worktrees green): pass the main-checkout paths via the injectable params and assert the §3/§4.6 baseline: `logicalVerdicts 118, matched 11, ambiguous 3` (FOC-151 r2/r3, FOC-156 r1 — each with both sides named), `unmatched 104`; FOC-142's legacy rows resolve to attempt `2026-08-27T06-45-08-262-supervisor-2d75` via the reviewRunId join; FOC-211's legacy row is `unsupervised:FOC-211`; FOC-151 r2 carries `cross-stage-recording` (squad `test`, acMapping 4). **Any deviation is explained by DEV in the handoff, never absorbed by loosening the test** (the F1 zero-flip discipline).
3. **Affected analytics on the exact candidate:** `node --test scripts/delegation-outcomes.test.mjs` **unmodified** (123 checks — proves composition didn't fork F1); `node --test scripts/telemetry-canonical.test.mjs` (adjacent); `node scripts/test-all.mjs` (full suite); telemetry-server boot smoke: old route 200 **and** new route 200 (+ valid empty shape when pointed at a dir without `.state/`).

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Round numbers mean different things in the two flows (FOC-156/177/151 evidence) → wrong merges | Medium if merged naively | merging only on equal round numbers; cross-round same-event stays separate + `corroborationHints`; under-merge is the designed failure direction (visible, honest) |
| Supervisor-precedence resolves a real legacy FAIL into `PASS` (FOC-156 r1 shape) | Certain on 1 cell, possible on future ones | conflict is triply visible (`coverage.ambiguous`, anomaly, both artifacts); Mateusz picks the policy (§9.1) — option B available at zero structural cost |
| Stage misread from `squad` (test-4 recorded review-shaped verdicts, fact #6) | Low | stage always from the record, never assumed; `cross-stage-recording` quality flag when shape contradicts squad |
| Baseline drift as `.state/` grows (append-only corpus) | Medium over time | §7.2 baseline pins today's numbers with named expectations; DEV explains deltas, never loosens tests; sum-invariants hold regardless of drift |
| Bit-identity across node versions (object key order) | Very low | key order is insertion-ordered for string keys on the supported runtime (node 22); the two-process hash test exists precisely to catch this class |
| Per-request recompute cost (45 run dirs, 74 JSONs, 58 md files, children.json per run) | Low | corpus is small (<1 s expected); server recomputes per request already for F1; a content-addressed cache is named as the future lever, deliberately not built |
| Fixture corpus copied from real `.state/` | None by design | fixtures are synthetic anonymized shapes in `mkdtemp` dirs; main checkout `.state/` only ever read; no committed corpus content |

## 9. Open questions

1. **[Needs Mateusz — decision] Conflict rule (§4.3).** A supervisor-precedence (design default), B conflict→UNKNOWN, C newest-source (rejected). Design assumes **A**; switching to B later changes only `resolvedVerdict` on conflict cells and the fixture golden — no structural rework.
2. **[Needs Mateusz — scope] Does `facts.testState === "Done"` in gate records count as final TEST acceptance?** Design assumes yes (structured, artifact-linked, supervisor-written). Alternative: TEST acceptance stays `unknown` until TEST reports become structured — stricter, but then no issue in the corpus can ever show TEST pass.
3. **[Needs Mateusz — scope] CSV for the unified report now or later?** Deferred by design (DoD names reports, not CSVs; F1's four CSVs untouched). The JSON report is the contract; CSV is mechanical to add later.
4. **[Recorded decision] Free-text TEST reports (`test-*-verdict.txt`) are not parsed into verdicts in scope** — doing so re-opens F1's negation/anchor problem on a new Polish prose corpus; they are linked as artifacts, and the parsing is enumerable future work once its own anchored-allowlist design exists.
5. **[Recorded decision] Cross-round same-event dedup not performed** (under-merge + hint). Revisitable if the `reviewRunId` join proves reliable enough to align rounds across sources on more of the corpus than today's 9-task overlap.

## 10. Handoff

**Verified by me (read directly this run):** `scripts/supervisor-verdict.mjs` in full (record schema L329-341, record-once L344-348, round derivation L326-327, work-child fingerprint L307-324); `scripts/delegation-outcomes.mjs` — `aggregateOutcomes` (L302-385), `delegationsByTask` (L395-419), `computeOutcomes` (L454-541), export map, `reviewRunId` extraction (L255); `scripts/telemetry-canonical.mjs` in full (usage/tool canonical views — nothing verdict-shaped); verdict JSONs of the 9 overlap tasks + FOC-218 r1/r2 (schema, squads, fingerprints); legacy verdict lines of FOC-151 r1-r4, FOC-156 r1-r2, FOC-142 r1-r2, FOC-171/172/173/177/199/211 (first anchor line each); `children.json` + `gates/*.json` + `merge.json` + `test-18-slice3-verdict.txt` excerpts from run `dd5b`; `children.json` telemetryRunId spot-match for run `2d75`; consumers (`telemetry-server.mjs`, `ui/src/api.js`, `ui/src/screens/Costs.jsx`); `docs/plans/fenix-stabilization-and-learning.md` F2 row; `.gitignore` L34.

**Computed (reproducible commands in §3):** source-population counts (45/28/74/37 · 58/42), 9/28/33 overlap split, 3-cell conflict census, F1 live report numbers (58/44/14 · 38/3/17).

**Corrections to the kickoff ground facts (§1):** the "14 unmatched" are telemetry-delegation-unmatched, not legacy-without-supervisor-verdict (33 tasks — different axis); TEST-stage verdicts *do* appear in structured records when recorded by `test-*` children (FOC-151 r2/r5/r7), so stage must be derived per record; home-repo confirmation stated explicitly against the kickoff comment's repo speculation.

**Not read / unknown:** the external 01_LLM_EVAL R consumer (out of repo, carried from FOC-218 §6); full bodies of the 58 legacy round files (first anchor lines + FOC-218's census were sufficient for every design decision taken here); whether every supervisor run dir's `children.json` uses the current schema (spot-checks passed on the two runs cited; the projection treats a missing/unparseable `children.json` as attempt-resolution fallback, not failure); Linear-side state (no access in this run, by design).

**Path and process notes:** design lives at `agents/plan/plans/foc-219-design.md` (gitignored `agents/*/plans/`, L34 → scoped forced commit, FOC-218 precedent `bdc1499`). This run wrote **nothing** outside this file and this commit; the main checkout's `.state/` was read-only throughout; no Linear calls, no push, no subagents (per the kickoff's hard rules).

**Confidence:** §4.2 key mapping and the exact `reviewRunId` join — high (verified against real files both directions). §4.3 conflict handling — high on mechanism, medium on policy choice (deliberately left open, §9.1). §4.4 stage/acceptance — high on REVIEW, medium on TEST-evidence interpretation (open question §9.2). §4.5 idempotency, §4.6 schema, §5-§7 — high. Baseline numbers (118/11/3/104) are design-time computations from verified inputs; DEV's §7.2 run is their acceptance gate.

**Deliverable status:** design only — no projection code was written in this run (DEV implements per this document; REVIEW/TEST verify against §5 fixtures and the §7 plan).

