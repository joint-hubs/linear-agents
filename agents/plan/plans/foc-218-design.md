# FOC-218 — Design: explicit legacy review outcomes (PASS / FAIL / UNKNOWN)

- **Issue:** FOC-218 (roadmap F1, parent FOC-102) — verbatim scope inlined by the Supervisor; no Linear access in this run.
- **Status:** COMPLETE — ready for supervisor validation / DEV handoff. Corpus evidence (§3) grounded in a read-only survey of all 58 round files.
- **Date:** 2026-09-07. **Author:** PLAN child (supervisor run `2026-09-05T22-16-33-119-supervisor-dd5b`).
- **Target file:** `scripts/delegation-outcomes.mjs` (537 lines, zero external deps, `node:sqlite` read-only).
- **Out of scope:** structured Supervisor-verdict ingestion (F2 / FOC-219), `scripts/telemetry-canonical.mjs` views, relabeling or rewriting anything under `.state/reviews/`.
- **Hard constraint:** `.state/reviews/` is read-only, always. No production raw evidence is mutated (AC #5).

## 0. TL;DR

Replace word-sniffing (`/🔴|\bblocker\b/i`, `/RETURN to DEV/i` over the first 2000 chars) with an **anchored, allowlisted verdict extraction**: REVIEW's round files always carry an explicit verdict on a `Verdict`-keyword line/heading (or the later `**Status:**` header — 12+ distinct shapes, incl. Polish §3.1); anything the parser cannot anchor becomes **UNKNOWN with a reason and a verbatim evidence line** — never PASS-by-default. Task outcome becomes a pure function of the current file set (+ round counter), so adding a round file later recomputes the outcome deterministically. All output changes are additive; legacy fields (`firstPassClean`, `clean`, CSV columns) keep their names with documented, tightened semantics.

## 1. Problem — verified defects

From reading `scripts/delegation-outcomes.mjs` in full (this worktree, base `2b3ea3d`):

1. **Negation false-POSITIVE (blocker):** `parseReview()` L70: `const blocker = /🔴|\bblocker\b/i.test(head)` — matches the word "blocker" anywhere in the first 2000 chars. The real PASS review `FOC-211-round1.md` contains "No blocker" → counted as a blocker. Quoted policy examples (REVIEW quoting the format legend) hit the same regex.
2. **Negation false-POSITIVE (returned):** L69: `const returned = /RETURN to DEV/i.test(head)` — any mention of "RETURN to DEV" (legend, prose, quoted template) counts as a return; absence of RETURN in a file with no verdict counts as clean.
3. **Missing RETURN treated as PASS:** L111: `t.firstPassClean = t.rounds === 1 && t.returned === 0` — a single round file that never says RETURN is "clean" even when the file contains no verdict at all (truncated, malformed, or prose-only).
4. **Rounds-only records treated as success:** L193: tasks known only from `.state/review-rounds.json` (no round file at all) get `firstPassClean: rounds === 1` — a fabricated PASS from a counter. The real counter contains mock ids (`task-a`, `task-b`) and tasks whose round files were cleaned up, so these fabrications are in production data today.
5. **Malformed input silently vanishes:** L92-93: `catch { /* an unreadable round is not worth failing the whole report */ }` — an unreadable round file is dropped with no trace; the report then *under-counts* evidence instead of surfacing it.
6. **No contradiction surfacing:** L99-113 aggregates with `+=`/`Math.max` only; nothing detects a later round contradicting an earlier one, or a Clean status coexisting with `issue:` findings.
7. **Untestable as written:** `REVIEWS`, `ROUNDS`, `DB_PATH` are module constants (L42-47); `computeOutcomes()` takes only `dbPath`. There is no way to point the aggregator at a fixture directory — the reason this script is the one 536-line file with **no test** (`docs/decisions/code-review-2026-08-03.md` L139: "536 | brak").

## 2. Current behavior map (what we must stay compatible with)

Call-graph of the existing script, with the exact seams the design touches:

| Piece | Lines | Role today |
|---|---|---|
| `parseReview(path, taskId, round)` | 64-83 | reads file, slices `head = text.slice(0, 2000)`, regexes `returned` / `blocker`, counts Conventional Comments markers (`issue:`/`nitpick:`/`suggestion:` via `\b<marker>\s*(\(|:)`), extracts `**Run:**` id |
| `loadReviews()` | 85-96 | globs `.state/reviews/*`, keeps files matching `^(.+)-round(\d+)\.md$` (helper files `_prompt-*.txt`, `_run-pass.sh` already excluded by the regex), sorts by task then round; **swallows read errors** |
| `outcomesByTask(reviews)` | 99-113 | folds per-round rows: `rounds = max`, `blockers/issues/returned +=`, then `firstPassClean = rounds === 1 && returned === 0` |
| `computeOutcomes({dbPath})` | 182-235 | exported; loads reviews, folds `.state/review-rounds.json` (L189-198: injects rounds-only tasks with fabricated `firstPassClean`), joins telemetry `usage_facts`×`run_task_links` (DEV squads only), builds `byPair` (`clean`, `rounds`, `blockers`, `usd`) |
| `buildCsvExports(dir)` | 403-471 | 4 CSVs: `outcomes_by_task.csv` (…, `first_pass_clean`, `has_delegation_match`), `outcomes_by_pair.csv` (`clean_pct`, `avg_rounds`, `blocker_rate`, `cost_per_clean_task`, `sample_size_flag`), `usage_by_role_model.csv`, `task_delegations.csv` |
| `main()` CLI | 473-529 | Polish-text report; `--json`, `--by-task`, `--csv <dir>` |

**Exported surface (the compatibility boundary):** `computeOutcomes()` → `{ tasksWithVerdict, matched, unmatched, byTask[], byPair[] }`.

## 3. Evidence from the legacy corpus

Corpus location: **`C:/Users/mateu/Documents/GitHub/linear-agents/.state/reviews/`** (main checkout) — **this worktree's `.state/reviews/` is empty** (`.state/` is gitignored; worktrees start clean; no `.state/review-rounds.json` here either). 89 files: **58 round files** (FEN 2 / FOC 32 / JOI 24), 13 non-round `.md` files a naive `*.md` glob would swallow (`JOI-*-crossref-*.md`, `JOI-71-desc.md`, `review-squad-audit.md`, …), 11 `.patch`, helpers `_prompt-{deep,firstpass,security}.txt`, `_run-pass.sh`. The current `^(.+)-round(\d+)\.md$` regex already excludes all of them. Round counter includes `task-a`/`task-b` mock ids and `FOC-79/87/89: 3`.

Findings below come from a read-only survey subagent (all 58 files inspected; verbatim lines quoted there — representative shapes repeated here). Design-load-bearing facts:

1. **No `**Status:**` template in 54/58 files.** Only FOC-41-r1, JOI-261-r1, JOI-262-r1, JOI-263-r1 use `**Status:**` headers (`- **Round:** 1 of 2 · **Status:** 🔴 blocker → RETURN to DEV` / `… 🟢 clean → hand to TEST`). Everyone else carries the verdict on a `Verdict`-keyword line/heading: `**Verdict:** …`, `## VERDICT: PASS`, `- **VERDICT PROPOSAL: APPROVE**`, table row `| Verdict | **issues(9)** — no 🔴 blocker → sent back to DEV … |` (FOC-147), title `# REVIEW — FOC-211 … — VERDICT: PASS` (FOC-211), `## Merge & verdict` + Polish body `**Blokerów (🔴 \`issue:\`): 0.**` (JOI-54..67, 11 files), `## Verdict` heading + prose (FOC-154, FOC-91).
2. **The 2000-char window is wrong in both directions.** 11+ files have their verdict **beyond** 2k (all 11 Polish JOI files: first 🔴 at 4933–11650; FOC-154 line 48; FOC-91 line 66; JOI-68-r1 🔴@4205; JOI-264-r1). Meanwhile 16/27 of the first-2k `blocker|🔴` hits are **negations in PASS files**. Scan must be whole-file, anchor-driven.
3. **`RETURN to DEV` is near-dead:** exactly 2/58 files contain it (both real returns). Real return wording: "Send/sent/sending back to DEV", "Back to DEV — round 1", "returns to DEV", "REQUEST CHANGES", "Requires changes", "changes requested", "request-changes", "Changes required", `issues(9)`, `Findings require changes`, `VERDICT PROPOSAL: FAIL`. **5 real returns have zero signal in the first 2k** (FOC-73-r1, FOC-91-r1, JOI-68-r1, JOI-69-r1, JOI-264-r1) — today they count as "not returned".
4. **Negation census (16 PASS files trip the current blocker rule):** "No `🔴 blocker`." (FOC-211, the issue's named case — its verdict is in the title `VERDICT: PASS`, body line 3 is the negation); "No blocker; …" (FOC-171); "…none is a blocker." (FOC-173); "0 blockers, 0 majors" (FOC-151-r1/r3/r4); "Round-1 blocker closed." (FOC-73-r2); "blocker fixed correctly" (FOC-91-r2); past-round recap "Round-1 verdict: FAIL on artifact integrity (4 blockers)." (FOC-177-r2 body, while its real verdict is `- **Verdict: PASS**`); "**Blockers:** none" (FOC-77-r2, FOC-78, FOC-79-r3, JOI-260); "No blockers, no …" (JOI-262/263); "**No blocker 🔴.**" (emoji AFTER the word); "Zero 🔴 blocker" (JOI-71); "0 🔴 blocker." (JOI-69-r2); "### D-Q2a (🔴 blocker → FIXED + verified live)" (JOI-68-r2, file is APPROVE); Polish "**Blokerów (🔴 \`issue:\`): 0.**" (count-zero, 11 files).
5. **Legend false-trigger: none in the wild.** The literal legend occurs only as the real verdict header in 2 files. But process-state text does appear: FOC-79-r3 quotes counter JSON `{round:3,status:escalated}` inside a CLEAN file; FOC-73..79 have CRLF/list-join artifacts gluing `- Status: **In Review**` into prose lines; FOC-147-r1/r2 line 92 "intermediate round without 🔴 blocker". Verdict wording varies wildly (12+ distinct shapes, incl. Polish and a verdict buried in a `praise:` line — JOI-57).
6. **Malformed/truncated: none in the corpus.** No 0-byte round files (smallest 2277 B), nothing cut mid-sentence. The UNKNOWN classes are still required (AC #2/4) — they guard the future, not this corpus. Read-error handling remains necessary for robustness.
7. **Multi-round ground truth (13 tasks):** FOC-73/74/77/91/142/156, JOI-56/68/69/264 = FAIL-then-PASS (normal rework); FOC-79 r1/r2 fail → r3 clean **while the quoted counter said `{round:3,status:escalated}`** (verdict overrides process state); FOC-147 r1→r2 consistent failing; **FOC-151 r1 APPROVE → r2 FAIL → r3/r4 APPROVE** — a real later-round contradiction the reviewers themselves flagged. Orphan round: FOC-177-r2 without round1. JOI-71 has round-2 artifacts but **no `round2.md`**.
8. **Format contract defines no template.** `agents/review/CLAUDE.md` §4 mandates only the path (`.state/reviews/<identifier>-round<N>.md`) and Conventional Comments; §5 mandates `VERDICT: PASS` recording and `VERDICT: UNKNOWN` for insufficient evidence. The `**Status:**` headers are an ad-hoc later convention. Conventional-comments markers in ~51/58 files (counts kept as-is per §4.1.5).
9. **No credentials in any surveyed file** (`_run-pass.sh` only *references* `$OPENROUTER_API_KEY`); no secrets-avoidance exception needed for fixture-derived content.

**Corpus-diff acceptance baseline (for the optional §7.3 validation):** expected outcome changes are — FOC-211, FOC-171, FOC-173, FOC-199, FOC-151-r1/r3/r4 tasks, FOC-73-r2, FOC-91-r2, FOC-77-r2, FOC-78, FOC-79-r3, JOI-260/262/263, JOI-54..67, FOC-154: blocker-word hits stop counting (PASS stays PASS); FOC-73-r1, FOC-91-r1, JOI-68-r1, JOI-69-r1, JOI-264-r1: real returns become FAIL (today silently "not returned"); FOC-79: counter-injected fabrication ends. **Zero ground-truth verdict flips (PASS↔FAIL) is the hard acceptance bar; new UNKNOWNs are expected and must be enumerable** (e.g. FOC-91-r2's prose-only verdict, JOI-57's praise-buried verdict).

## 4. Design

### 4.1 Verdict parsing (replaces `parseReview` internals)

**Principle: anchored allowlist over the WHOLE file, evidence always, never PASS-by-default.** Grounded in the §3 census: the verdict line exists in every corpus file but moves around (bullet, heading, title, table row, Polish section body) and sits beyond 2k in ~15 files.

1. Normalize line endings (`\r\n` → `\n`); split into lines once. **Evidence = verbatim line + 1-based line number** (byte/char offsets are a trap: emoji are 4-byte UTF-8).
2. **Anchor candidate = any line that contains a verdict keyword** — `/verdict/i` (covers `**Verdict:**`, `## VERDICT: PASS`, `- **VERDICT PROPOSAL: APPROVE**`, the FOC-211 title, `## Round 1 verdict:`) — **or** `/^\s*-?\s*\*\*Status:\*\*/` (the 4-file later convention) — **or** a line inside a *verdict section*: after a heading containing `/verdict/i` (`## Merge & verdict`, `## Verdict`) until the next markdown heading (carries the Polish `**Blokerów (🔴 \`issue:\`): 0.**` bodies and FOC-154/91 prose verdicts).
3. **Ignore rules (checked before classification)** — grounded in census surprises #8-9 and the FOC-177 recap:
   - lines inside fenced code blocks (``` fences) — counter JSON, command output;
   - **process-state tokens** with no PASS/FAIL token on the line: `escalated`, `In Review`, `In Progress` (FOC-79-r3's quoted `{round:3,status:escalated}`, the list-joined `- Status: **In Review**` lines);
   - **recap lines**: `/round\s*-?\s*\d+\s+verdict|verdict[^.]*round\s*-?\s*\d+/i` — "Round-1 verdict: FAIL …" (FOC-177-r2) describes a *previous* round whose own file carries the verdict; ignoring recaps prevents a self-inflicted `contradictory-in-file`.
   - JSON-shaped lines (`/^\s*[{"]/`) — counter JSON prose.
4. **Keyword inventory per anchor line** (whole-line scan, case-insensitive; from §3 census):

   | Class | Tokens |
   |---|---|
   | FAIL | 🔴 🔶 🟠 · `FAIL` · `blocker`/`bloker` (non-negated) · `blocking` (FOC-91-r1) · `request changes` / `changes requested` / `request-changes` / `changes required` / `requires changes` (FEN-30, FOC-142/156/77/79, JOI-261) · `back to dev` (covers send/sent/sending/returns) · `RETURN to DEV` · `issues(\d+)` (FOC-147 table row) · `findings require changes` · Polish count ≥1: `bloker…: 1` |
   | PASS | ✅ 🟢 · `clean` · `pass` · `approve` · `hand to test` / `proceed to test` · Polish count-zero: `blokerów…0` / `bloker…0` |
   | UNKNOWN | `verdict: unknown` / `unknown` as the verdict value (REVIEW §5 contract) |
   | ignore | `escalated`, `In Review`, `In Progress` (with no PASS/FAIL token) |

5. **Negation removal runs before classification**, inside the anchor line only. Families (each maps to a regex; all were observed in §3.4):
   1. direct negator within 2 tokens left of `blocker(s)`/`bloker`/`issue`: `no`, `none`, `zero`, `without`, `nie ma`, `brak`;
   2. **count-zero on either side** (≤40 chars): `0 blockers`, `Blokerów (🔴 \`issue:\`): 0`, `Zero 🔴 blocker`, `0 🔴 blocker`;
   3. `Blockers:** none` / `blocker… none`;
   4. **resolved**: `blocker closed`, `BLOCKER CLOSED`, `blocker fixed` (FOC-73-r2, FOC-91-r2, FOC-151-r3, JOI-68-r2);
   5. recap lines — handled at step 3, not here.
   Body text outside anchors is never evaluated — that alone removes the FOC-211/FOC-171/FOC-173/FOC-199 false-blocker class.
6. **Classification precedence within one anchor line:** after negation removal — (1) explicit UNKNOWN token → UNKNOWN; (2) any FAIL token → FAIL (FAIL dominates: every corpus line carrying both classes is a real return with a parenthetical "no blocker", e.g. FOC-142-r1, FOC-147-r1, JOI-261 — a return is terminal); (3) any PASS token → PASS; (4) neither → unrecognized → UNKNOWN (`unrecognized-verdict`, evidence quoted).
7. **Verdict resolution per file:** exactly one classified anchor → its verdict; ≥2 anchors same verdict → that verdict, first as evidence; ≥2 anchors conflicting → UNKNOWN (`contradictory-in-file`) with **all** anchor lines as evidence (earliest-wins would bury a contradiction — AC #1/3 forbid that); no anchor at all → UNKNOWN (`no-verdict-anchor`).
8. **Counts stay as-is:** `issues`/`nitpicks`/`suggestions` marker counting (whole file, `\b<marker>\s*(\(|:)`) and `reviewRunId` extraction unchanged — advisory quantities, not verdicts. Note: FOC-79-r1/r2 are returns whose `issue:` findings are explicitly non-blocking — `issues` counts and FAIL verdict are independent numbers, as today.
9. **Read failures become evidence:** replace the L92-93 swallow with `{ file, reason: "read-error", detail }` in top-level `parseAnomalies`; the file contributes nothing (its task rounds UNKNOWN unless another round file carries the verdict).
10. New per-round record shape (additive; legacy fields keep names, semantics tightened):

```js
{
  taskId, round,
  verdict: "PASS" | "FAIL" | "UNKNOWN",
  evidence: { line: "<verbatim>", lineNo: <int>, anchor: "verdict-line" | "status-header" | "verdict-section" } | null,
  unknownReasons: ["no-verdict-anchor" | "contradictory-in-file" | "unrecognized-verdict" | "read-error"],
  // legacy fields, tightened (§4.4):
  returned,      // now: verdict === "FAIL"  (was: literal "RETURN to DEV" in first 2k — matched 2/17 real returns)
  blocker,       // now: verdict === "FAIL"  (was: /🔴|\bblocker\b/ in first 2k — 16/27 hits were PASS files)
  issues, nitpicks, suggestions, reviewRunId,     // unchanged
}
```

### 4.2 UNKNOWN taxonomy (detection → surfacing)

File-level (per round file):

| Code | Detection | Surfacing |
|---|---|---|
| `no-verdict-anchor` | anchor scan found nothing in the whole file | `unknownReasons` on the round + top-level `parseAnomalies` |
| `unrecognized-verdict` | anchor line matched but no keyword rule fired | round + `parseAnomalies`, with the verbatim line |
| `contradictory-in-file` | ≥2 anchors, conflicting verdicts | round + `parseAnomalies`, all lines listed |
| `read-error` / `malformed` | exception in read/parse (0-byte parses empty → `no-verdict-anchor` instead) | `parseAnomalies` (today: silently dropped) |

Task-level (aggregation):

| Code | Detection | Rule |
|---|---|---|
| `rounds-only` | in `.state/review-rounds.json`, zero round files | outcome UNKNOWN — never fabricated PASS (kills defect #4, mock ids included) |
| `rounds-missing-verdicts` | counter says N rounds, files exist for fewer than N | effective rounds = max(counter, files) for display; **outcome taken from the file set only** → if the highest file round is not the highest known round, outcome UNKNOWN (the missing round's verdict is unknowable) |
| `round-1-missing` | round files start at N>1 (real case: `FOC-177-round2.md` w/o round1) | `firstPassClean = null`; outcome = highest-round verdict with `unknownReasons += round-1-missing` |
| `contradictory-rounds` | round N verdict PASS but round N+1 file exists (PASS is terminal per REVIEW §5 — a next round implies a return REVIEW recorded) | outcome stays derived from the highest round; anomaly surfaced, never silently overwritten (AC #3) |
| `status-vs-issues-contradiction` | round verdict PASS/`Clean` but the same file counts ≥1 `issue:` marker (REVIEW §5: any non-praise `issue:` blocks clean) | surfaced in anomalies; outcome unchanged |

Everything above is **surfaced, not decided**: UNKNOWN carries reasons; contradictions carry both sides. No heuristic silently overwrites.

### 4.3 Aggregation (replaces `outcomesByTask` + the L189-198 counter fold)

1. **Pure function of the current file set + counter.** `aggregateOutcomes(roundReviews, roundsCounter)` → per task:
   - `roundVerdicts[]` = per-round verdicts sorted by round,
   - `outcome` = verdict of the **highest round present in the file set**; UNKNOWN if that verdict is UNKNOWN or the file set is incomplete vs the counter (`rounds-missing-verdicts`) or absent entirely (`rounds-only`),
   - `firstPassClean` = `round1.verdict === "PASS"`; `false` when round1 verdict is FAIL; **`null` when unknown** (round-1 file missing or UNKNOWN),
   - `rounds` (effective) = `Math.max(counter[taskId] || 0, maxFileRound)` — display-only, as today.
   Adding a round file later changes only what the file set implies — recompute is a rerun of the same pure derivation (the dashboard already recomputes per request, `telemetry-server.mjs` L1448-1451, so no cache invalidation exists or is needed).
2. **Pair aggregation** (`byPair`, DEV-only join unchanged): `clean` counts `firstPassClean === true` only; new additive `unknown` counts tasks whose outcome is UNKNOWN; `clean_pct` keeps its legacy denominator (`tasks`), new `clean_pct_known = clean / (tasks - unknown)` for honest rates. `blockers` counts tasks with outcome FAIL (was: any blocker-word file).
3. **Top-level report additions (additive):** `tasksPass`, `tasksFail`, `tasksUnknown`, `parseAnomalies[]`. `tasksWithVerdict` keeps its meaning (tasks with any parsed evidence, incl. rounds-only).

### 4.4 Output-shape change matrix (compat by construction)

| Output | Unchanged (byte-compat) | Additive | Semantics tightened (documented in-place) |
|---|---|---|---|
| JSON `computeOutcomes()` | top-level keys, `matched`/`unmatched`, byPair fields, byTask legacy fields | `outcome`, `unknownReasons`, `roundVerdicts`, `evidence`, `tasksPass/Fail/Unknown`, `parseAnomalies`, byPair `unknown`, `clean_pct_known` | `firstPassClean`: `null` when UNKNOWN (was: `true` for missing-RETURN and rounds-only rounds===1); `blockers`/`returned` per §4.1.7 |
| GET `/api/delegation-outcomes` | route, 200-on-null empty shape | passes new JSON fields through untouched | — |
| UI `Costs.jsx` "Jakość wg roli DEV" | reads `byPair[].clean/tasks`, `matched`, `tasksWithVerdict` — all kept | optional: UNKNOWN count column (can defer to F2) | numbers move toward honesty: fabricated PASSes disappear from `clean` |
| `outcomes_by_task.csv` | all existing columns incl. `first_pass_clean` (null → empty cell, `toCsvValue` already handles) | `outcome`, `unknown_reasons`, `round_verdicts` (`1:PASS|2:FAIL`) | `first_pass_clean` blank when unknown |
| `outcomes_by_pair.csv` | all existing columns | `unknown_tasks`, `clean_pct_known` | `clean_pct` legacy denominator kept |
| `usage_by_role_model.csv`, `task_delegations.csv` | untouched | — | — |
| CLI text | flags, Polish labels | verdict column in `--by-task`; UNKNOWN section in the summary | footer explains the tightened rule |

### 4.5 Testability refactor (enables the whole test plan)

- Hoist module constants into injectable parameters with today's values as defaults: `computeOutcomes({ dbPath, reviewsDir = REVIEWS, roundsPath = ROUNDS } = {})`; thread `reviewsDir`/`roundsPath` into `loadReviews`/counter fold; export `aggregateOutcomes` and (for direct unit tests) `parseReview(text, taskId, round)` **taking text** instead of a path — parsing becomes I/O-free.
- The telemetry join keeps its own signature; aggregate tests need no DB at all. One optional DB-join test uses `openTelemetryDb` on a `mkdtemp` fixture, mirroring `scripts/telemetry-canonical.test.mjs`.

## 5. Fixture plan

Synthetic **inline-string fixtures written to a `mkdtempSync` dir at test time** (repo convention: `scripts/telemetry-canonical.test.mjs` builds fixtures in temp dirs; `supervisor-test-fixtures.mjs` shows committed fixture modules are also acceptable if the inline set grows). No real corpus content is committed; `.state/` never exists in a fresh worktree.

Fixture set (name → asserts), mapped 1:1 to AC #4:

| Fixture | Content sketch (real-shape provenance in parens) | Asserts |
|---|---|---|
| `status-pass` | `- **Round:** 1 of 2 · **Status:** 🟢 clean → hand to TEST` (JOI-262/263) | PASS, evidence line+lineNo, `firstPassClean === true` |
| `status-fail` | `- **Round:** 1 of 2 · **Status:** 🔴 blocker → RETURN to DEV` + `issue:` marker (FOC-41) | FAIL, `blockers`/`returned` counted |
| `status-lowsev-fail` | `**Status:** 🟠 low-severity issue → RETURN to DEV` (JOI-261) | FAIL — 🟠 is not PASS despite "low-severity" |
| `verdict-title-pass` | title `# REVIEW — X — round 1 — VERDICT: PASS` + body "No `🔴 blocker`." (FOC-211 — the named defect) | PASS; body negation never evaluated |
| `verdict-pass-variants` | `## VERDICT: PASS` (FOC-171); `- **Verdict:** ✅ **Clean — no actionable issues.**` (FOC-142-r2); `- **Verdict: APPROVE**` (JOI-70); `**Verdict:** clean` (FOC-75); table row `| **Verdict** | **Clean** … |` (FOC-76) | all PASS via one keyword set |
| `verdict-fail-variants` | `**Verdict:** 🔴 Changes required — sending back to DEV` (FEN-30); `**Verdict:** **Send back to DEV** — 1× issue:` (FOC-73-r1); `**Verdict:** request-changes` (FOC-77-r1); `| Verdict | **issues(9)** — no 🔴 blocker → sent back to DEV …` (FOC-147-r1); `**Verdict:** **Findings require changes** — 1 blocking issue:` (FOC-91-r1, verdict beyond 2k) | all FAIL incl. negated-"no blocker" inside the line (FAIL dominates) |
| `proposal-fail` | `- **VERDICT PROPOSAL: FAIL** — one platform-conditional blocker…` (FOC-151-r2) | FAIL |
| `polish-merge-verdict` | `## Merge & verdict` + `**Blokerów (🔴 \`issue:\`): 0.**` beyond 2k (JOI-54..67, 11 files) | PASS via heading-scope + count-zero negation |
| `polish-blocker-1` | `## Merge & verdict` + `**Bloker 🔴 \`issue:\`: 1**` (JOI-68-r1) | FAIL |
| `negation-families` | "…none is a blocker." (FOC-173); "**Blockers:** none" (FOC-78); "Round-1 blocker closed." (FOC-73-r2); "blocker fixed correctly" (FOC-91-r2); "0 blockers, 0 majors" (FOC-151-r1) | PASS — every negation family removed from FAIL pool |
| `recap-line` | PASS verdict + body "Round-1 verdict: FAIL on artifact integrity (4 blockers)." (FOC-177-r2) | PASS — recap ignored, not `contradictory-in-file` |
| `process-status` | CLEAN verdict + quoted `{round:3,status:escalated}` (FOC-79-r3) + list-joined `- Status: **In Review**` (FOC-73..79 artifact) | PASS — process states ignored |
| `no-verdict` | prose-only review, no keyword (JOI-57 shape) | UNKNOWN `no-verdict-anchor`, `firstPassClean === null` |
| `rounds-only` | counter `{T:1}` / `{T:2}` / `{T:1}` mock ids, no files | outcome UNKNOWN, **not** firstPassClean (kills defect #4) |
| `multi-round` | r1 FAIL → r2 PASS (FOC-73 shape) | outcome PASS (highest round), firstPassClean false, `returned` 1 |
| `multi-round-unknown-tail` | r1 FAIL, r2 no-anchor | outcome UNKNOWN with reason, r1 verdict preserved in `roundVerdicts` |
| `counter-ahead` | counter 3, files r1-r2 (FOC-79 w/o r3 shape) | outcome UNKNOWN `rounds-missing-verdicts`, effective rounds 3 |
| `round-gap` | files r2 only (FOC-177 shape) | firstPassClean null, `round-1-missing` |
| `contradictory-in-file` | conflicting classified anchors in one file (synthetic; corpus has none — recap/process rules must prevent the two near-misses) | UNKNOWN, both lines in evidence |
| `contradictory-rounds` | r1 PASS, r2 FAIL (FOC-151 r1→r2 real case) | anomaly surfaced, outcome from r2 = FAIL |
| `clean-with-issues` | Clean verdict + `issue:` marker | anomaly `status-vs-issues-contradiction` |
| `truncated` | file cut mid-verdict-line | UNKNOWN (anchor incomplete → unrecognized), never PASS |
| `malformed-read` | 0-byte file → UNKNOWN `no-verdict-anchor` (empty parses, no anchor); unreadable-mode case → `parseAnomalies` `read-error`; other files unaffected |
| `helper-files` | `_prompt-x.txt`, `_run-pass.sh`, `x-round1.md`, `JOI-71-r2-brief.md`-style decoys | only `x-round1.md` parsed |
| `crlf-joined` | CRLF + list-join artifact line (FOC-73..79 shape) | verdict unaffected |

Optional (not committed): a `--corpus <dir>` passthrough (falls out of §4.5 injection) letting DEV run the analyzer over the real main-checkout corpus **read-only** and diff before/after task outcomes — the semantic-change acceptance check.

## 6. Consumer-compatibility inventory (AC #5)

Verified by Grep over this worktree (`delegation-outcomes`, `computeOutcomes`, `outcomes_by_*`):

| # | Consumer | How it reads output | Compat requirement | Migration coverage |
|---|---|---|---|---|
| 1 | `scripts/telemetry-server.mjs` L53 import, L1448-1463 route, L1902 smoke path | imports `computeOutcomes()`, serves JSON as-is; null → `{tasksWithVerdict:0, matched:0, unmatched:0, byTask:[], byPair:[]}` | keep top-level keys + byTask/byPair field names; additive fields pass through | additive-only ⇒ none needed; smoke path stays 200 |
| 2 | `ui/src/api.js` L28-30 `getDelegationOutcomes()` | `apiFetch('/api/delegation-outcomes')` | same as #1 | none |
| 3 | `ui/src/screens/Costs.jsx` L381-407 "Jakość wg roli DEV" | `outcomes.byPair[].{agent,model,tasks,clean}`, `outcomes.matched`, `outcomes.tasksWithVerdict`; `clean` renders as % | keep `clean` (counts `firstPassClean===true` only now); numbers shift toward honesty — fabricated PASSes vanish | visible count change is the *intended* fix; note in panel copy optional, F2 may add UNKNOWN column |
| 4 | CSV exports → **external 01_LLM_EVAL repo** (R analysis; `01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md` §5/§7 — not in this repo, not verifiable here) | column-name based (`first_pass_clean`, `clean_pct`, `blocker_rate`, …) | all existing columns keep names/positions; new columns appended; `first_pass_clean` empty (not 0/1-swap) when UNKNOWN | in-repo: CSV-section comment + handoff note; out-of-repo: explicit handoff item — R side must treat blank as UNKNOWN, or re-run analysis |
| 5 | CLI (humans) | Polish text report | flags unchanged | footer text updated |
| 6 | Docs mentioning the script: `docs/README.md` L76 (one-liner), `docs/plans/agent-intelligence.md` L19+L291 (heuristic C uses rounds>1 — verdict-independent), `docs/decisions/code-review-2026-08-03.md` L139 ("536 lines, no tests" — will become stale), `docs/decisions/code-audit-2026-07-30.md` L28-36 (route-table example), `docs/adr/0008-run-scoped-usage-identity.md` L50 (join-site inventory) | narrative only | no behavioral contract embedded | one-line doc touches where stale (README still accurate; code-review decision doc optionally annotated) |
| 7 | `.state/review-rounds.json` producer (`scripts/review-round.mjs`, REVIEW squad) | input source, not output consumer | format unchanged | none |
| 8 | `scripts/test-all.mjs` suite | runs `scripts/*.test.mjs` | new test file must be green in the suite | included in test plan |

Non-consumers verified: `scripts/telemetry-canonical.mjs` (FOC-217) does **not** import `computeOutcomes` — no coupling to FOC-219's target.

## 7. Test plan

1. **New `scripts/delegation-outcomes.test.mjs`** (colocated, hand-rolled `check()` + `mkdtempSync`, run via `node --test scripts/delegation-outcomes.test.mjs` and `node scripts/test-all.mjs`):
   - §5 fixture table, each row 1+ `check()`s;
   - pure-`aggregateOutcomes` cases (no FS): recompute determinism — same inputs ⇒ same outcome; add-r2-later ⇒ outcome flips deterministically per §4.3.1; counter-ahead ⇒ UNKNOWN;
   - legacy-compat checks: JSON top-level keys present; `byPair` shape fields present; `toCsvValue(null) === ""` so `first_pass_clean` blanks;
   - optional DB-join test on a `mkdtemp` sqlite via `openTelemetryDb` (pattern: `telemetry-canonical.test.mjs`).
2. **Affected consumers on the exact candidate:**
   - `node --test scripts/telemetry-canonical.test.mjs` (adjacent, proves no accidental coupling);
   - `node scripts/test-all.mjs` (full suite, CONTRIBUTING.md L69);
   - telemetry-server smoke: boot server and curl `/api/delegation-outcomes` → 200 + shape (or run the smokePaths boot check);
   - UI: `getDelegationOutcomes` renders (panel tolerant to additive fields — verify in `ui/` build or manual smoke);
   - CSV: run `--csv` into a temp dir, diff **column headers only** against a pre-change export; row-level diffs are expected (that's the fix).
3. **Real-corpus validation (read-only, main checkout path, optional but recommended):** run before/after JSON over `C:/Users/mateu/Documents/GitHub/linear-agents/.state/reviews/` via `--corpus`; expected diff class: tasks with fabricated PASS (rounds-only, missing-RETURN) → UNKNOWN; FOC-211 blocker → PASS. Any PASS→FAIL flip needs an explanation before merge.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Allowlist too strict → mass UNKNOWN on legacy corpus | Low-Medium (quantified) | every §3 shape is allowlisted + fixture-covered; expected-UNKNOWN set is enumerated in advance (prose-only FOC-91-r2, praise-buried JOI-57); UNKNOWN-with-reason is the *desired* failure direction (AC #2); corpus diff is the acceptance check |
| A wrong verdict flip (PASS↔FAIL) on real corpus | Low | hard acceptance bar: **zero** ground-truth flips (§3 baseline); recap/process-status/ignore rules built from observed near-misses |
| Negation rule over-fires (real blocker escaped as negation) | Low | negation families are closed (5 enumerated); count-zero requires an explicit 0/none token, "no … because" hypotheticals outside anchors are not evaluated |
| `clean`/`first_pass_clean` semantics shift moves dashboard + external R numbers | High (intended) | additive fields + documented tightened semantics; external repo flagged in handoff as explicit migration item |
| `.state/` absent in DEV/TEST worktrees breaks "run on exact candidate" | Certain (already true) | fixtures committed; corpus runs optional via injection; telemetry DB lives outside the worktree (LOCALAPPDATA) — unaffected |
| `roundVerdicts`/`evidence` bloat JSON for 89-file corpus | Low | 58 round files — bounded; evidence lines capped to anchor lines only |
| Regex perf on `new RegExp(marker)` per file × markers | Negligible | unchanged from today's behavior |

## 9. Open questions

1. **[Needs Mateusz / external repo]** 01_LLM_EVAL R side: is blank-`first_pass_clean`-on-UNKNOWN acceptable, or must the CSV keep legacy boolean semantics for one transition release? (Design assumes acceptable; flagged for handoff.)
2. **[Decision recorded, reversible]** Contradictory-rounds (r1 PASS, r2 exists — real case FOC-151 r1→r2) surfaced only, outcome from highest round — alternative would be outcome UNKNOWN; chose surfacing because the reviewers themselves flagged the contradiction and a legit re-review must not mask the final verdict.
3. **[Decision recorded]** Two legacy files will legitimately land UNKNOWN (`no-verdict-anchor`): FOC-91-r2 (prose-only verdict) and JOI-57 (verdict buried in a `praise:` line). Accepting: anchor-driven parsing cannot read prose without re-opening the negation-NLP problem; both are enumerated in §3 baseline, so the drop is visible, not silent.
4. **[Resolved by census — no longer open]** Anchor inventory (§3.1-3.2: 12+ shapes incl. Polish, whole-file scan required); legend-before-status (does not occur in the wild; the two near-misses are recap and process-status lines, handled by §4.1.3 ignores).

## 10. Handoff

**Verified by me (read directly):** full `scripts/delegation-outcomes.mjs` (537 lines, this worktree); `agents/review/CLAUDE.md` §4-5 excerpt (round-file contract, `VERDICT: PASS|UNKNOWN`, Clean criteria, round counter via `review-round.mjs`); `scripts/telemetry-canonical.test.mjs` (fixture/test conventions); `scripts/telemetry-server.mjs` consumer excerpt (L53, L1448-1463, L1902); `ui/src/screens/Costs.jsx` consumer excerpt (L378-407); docs mentions (5 files, all narrative); `.gitignore` L34; corpus listing + `review-rounds.json` head in the **main checkout**; CONTRIBUTING test command.

**Verified via read-only survey subagent (verbatim quotes received, all 58 round files):** status-shape census, negation census (16 files incl. FOC-211's title-verdict + body "No `🔴 blocker`."), missing-RETURN census (2/58; 5 real returns parser-blind), malformed/truncated census (none), multi-round verdict matrix (13 tasks; FOC-151 r1→r2 contradiction), format contract quote (no Status template mandated), Conventional-Comments counts (~51/58), no credentials in any surveyed file.

**Path deviation note:** brief said `agents/plans/foc-218-design.md`; commit `875b5c6` convention is `agents/<squad>/plans/<name>.md` (FOC-225 → `agents/supervisor/plans/greedy-popping-wilkes.md`), so this doc lives at `agents/plan/plans/foc-218-design.md`. Both paths are gitignored (`.gitignore` L34); supervisor force-commits approved designs.

**Not read / unknown:** the 01_LLM_EVAL external repo (CSV consumer) — not on disk, R-side column handling unverifiable here. Individual corpus file bodies beyond the subagent's verbatim quotes (FOC-211 status section was quoted verbatim by the survey; other files summarized with file:line cites).

**Confidence:** §4.1 parsing mechanics — high (every pattern grounded in a quoted corpus line; the two accepted UNKNOWNs enumerated). §4.2/4.3 aggregation — high. §4.5, §5, §6, §7, §8 — high. Residual risk concentrated in: Polish-token edge variants beyond the 11-file family (low), and the external CSV consumer (unverifiable here). Design is buildable as-is by DEV; the corpus-diff run (§7.3) is the recommended pre-merge gate.
