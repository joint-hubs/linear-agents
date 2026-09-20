# FOC-283 — Handoff compressor, Stage 1 (eval only)

**Date:** 2026-09-20 (round 2 revised same day) · **Branch:** `foc-283-dev` · **Mode:** supervised, eval-only (no training, no GPU, no model downloads)
**Question:** can a model draft the pinned-state handoff well enough that the NEXT stage does less re-derivation?

**Revision history.** Round 1 (commit 46a8309) reported a 4-pair, 2-arm probe and a kill-criterion
verdict of "not demonstrated". REVIEW round 1 returned a **pass** verdict with 13 findings; Mateusz
approved the full follow-up: fix the record (§A findings below) AND run the de-confounding
experiment (fresh-baseline arm). This document is the round-2 revision: all corrections are applied
in place, the 3-arm n=16-pair experiment is added (§AC-5), and the verdict is re-derived under the
de-confounded comparison (§Kill-criterion). Numbers reviewers recomputed from raw artifacts
reproduce exactly (§Spend accounting).

Metric (identical across all arms): **B2 first-turn context-call share** — in the first 15 tool calls
of the child's first turn (or fewer if the turn ends earlier), the share classified as context
re-derivation (reads of files the kickoff already describes, git inspection, fs inspection, grep/glob,
linear reads, codegraph). Same extractor as the baseline re-measure (AC-1); classification logic
copied verbatim. Windows shorter than 15 calls are used as-is — the same treatment as the 111 of 183
archived sessions whose first turns are shorter than 15 calls (`b2-firstturns.fresh.json`).

## AC-1 — Baseline anchor (frozen archive, re-measured 2026-09-20)

Fresh re-run of the B2 extractor over the frozen transcript archive reproduces the earlier
measurement exactly (183 sessions → `b2-firstturns.fresh.json`, aggregates in
`b2-aggregates.fresh.json`):

| squad | n | ctxPct median | substantive median |
|---|---|---|---|
| dev | 56 | 33.3% | 50.0% |
| review | 64 | 26.7% | 33.3% |
| test | 44 | 26.7% | 37.5% |
| plan | 19 | 50.0% | 59.1% |

Historical stage anchors for the two pair directions: **dev→review ≈ 26.7%** (review children) and
**review→test ≈ 26.7%** (test children). **Round-2 caveat resolved below (§AC-5):** these anchors
come from historical long-running sessions under different conditions; the fresh-baseline arm
measures what the SAME conditions do to the ORIGINAL kickoff — and shows the 26.7% anchor is a
conditions artifact, not a drafting benchmark.

## AC-2 — Pair corpus and split

- **86 pairs** built from per-run `children.json` registries joined to archived transcripts:
  **45 dev→review + 41 review→test** (round 1 said "46+42", which sums to 88 — the correct counts
  from `pairs.json` are 45+41). FOC-288 earlier counted 88 constructible; 2 excluded for short prev
  text (FOC-225 dev-3→review-4 at 155 chars, FOC-100 review-2→test-3 at 120 chars).
- **Split** grouped by task, no task on both sides (leakage check passed, `split.json`):
  train 22 tasks / 44 pairs (21 dr + 23 rt), eval 23 tasks / 42 pairs (24 dr + 18 rt).

## AC-3 — Template arm (zero model involvement)

Mechanical 9-slot FOC-278 pinned-state fill from the same children.json input, for all 42 eval pairs.
`template-drafts.json` manifest: 42/42.

## AC-4 — API arm (OpenRouter flash class)

Model `z-ai/glm-5.3-flash` (config/models.json row), extractive-only prompt (FOC-359: a generating
model scored F1 = 0.04 on this task), temperature 0, max_tokens 4000, `reasoning: {effort: low}`
(reasoning is mandatory for this model; with default effort it burned the entire max_tokens budget
and returned empty content), `usage: {include: true}` for metering.

- Drafts: 42/42 eval pairs drafted.
- **Metering (tokens × config pricing rows, never API-reported cost):** 52 metered calls — **10 of
  the 52 are `ok:false` failed attempts** (retried after the two prompt fixes; their tokens are
  included in the cost) — 129,015 input / 71,807 output tokens → **$0.0276** (`api-metering.json`).
- Bookkeeping: 74 records total (52 metered + 22 early failures from before the two fixes, unmetered
  because OpenRouter omitted usage on those).

## AC-5 — Downstream probe, round 2: three-arm paired design (n=16 pairs)

Design: **16 eval pairs** (8 dev→review + 8 review→test, `probe-sample-16.json` — the first 8 eval
pairs per direction, same pairs in ALL arms), **three arms**:

| arm | handoff text the probe child receives |
|---|---|
| **baseline** | the ORIGINAL archived kickoff the historical next-stage child received, verbatim from `pairs.json` (`next.kickoffText`) |
| **template** | mechanical 9-slot template draft (AC-3) |
| **api** | extractive model draft (AC-4) |

Everything else identical across arms: same framing suffix appended to the handoff text, same
worktree (landed repo state), same permissions (deny-only), same dedicated CLAUDE_CONFIG_DIR per
arm, same flash-class model (`ANTHROPIC_MODEL=z-ai/glm-5.3-flash`, headless `claude -p`), same
metric and extractor. The ONLY variable is the handoff text. This closes round 1's n=4 caveat and,
with the baseline arm, removes the conditions confound: the historical anchor is no longer used as a
comparator.

### Results — B2 metric, first-15 window, ctx% cell medians

| cell (n=8 each) | baseline (orig. kickoff) | template | api |
|---|---|---|---|
| dev→review | **55.2%** | 54.2% | **42.2%** |
| review→test | **42.8%** | 50.0% | **40.0%** |
| all 16 pairs (median) | **49.4%** | 50.0% | **40.0%** |

**Paired per-pair deltas (same pair, all three arms), all 16 triples complete:**

- **api − baseline:** api lower in **10/16** pairs, higher in 5, tied 1; per-pair median delta **−9.0 pp**
  (dev→review: lower 5/8, median −10.9; review→test: lower 5/8, median −8.8).
- **api − template:** api lower in **11/16** pairs, higher in 3, tied 2; per-pair median delta **−10.0 pp**
  (dev→review: lower 5/8, median −10.3; review→test: lower 6/8, median −10.0).
- **template − baseline:** lower in 8, higher in 8 (exact split), median −0.4 pp — the mechanical
  template neither helps nor hurts vs the original kickoff; the API arm is the only arm below both.

Full per-pair values, per-cell values, and the extraction provenance are in `probe-results.json`
(`cells`, `paired`, `probes`).

### De-confounding result (the experiment's primary question)

**The fresh-baseline arm sits at 49.4% — nowhere near the historical 26.7% anchor.** The historical
anchor is confirmed to be a **conditions artifact**: a fresh single-turn probe child re-derives far
more context than the historical long-running children did, regardless of which handoff text it
receives (original, template, or model draft). The honest lever question is therefore
**api vs original kickoff under identical conditions** — and on that question the model-drafted
handoff is lower in 10/16 pairs with median −9 pp, in both directions, and lowest of all three arms
in all four cells.

### Sensitivity band (REVIEW r1 finding A2 — now actually recorded)

The loose-sweep band (fs-inspection matched anywhere in a Bash command, not only anchored at the
start) is **recorded in `probe-results.json` under `looseSweep`** (round 1 wrongly claimed it was
recorded there). Medians under the loose reading:

| cell | baseline | template | api |
|---|---|---|---|
| dev→review | 93.4% | 77.4% | **60.0%** |
| review→test | 80.0% | 75.7% | **74.2%** |

The API arm stays lowest in both directions under BOTH readings — round 1's sign-flip-under-loose
observation does not reproduce at n=8 per cell.

### Reliability notes

- **Timeout censoring is heavily arm-dependent:** 13/16 usable baseline-arm turns, 5/16 api turns
  and 1/16 template turns hit the 420 s harness ceiling (all with complete observed windows; the 4
  baseline attempts that timed out BELOW the 15-call window were rejected and re-run — see §retry
  accounting). Censoring concentrates in the baseline arm because the original kickoff names no
  worktree state to verify, so the child keeps searching longer; this makes the baseline arm's
  number conservative (its window stops early, mid-search).
- **Metric source:** extraction reads the runner's verbatim stream-json tee
  (`probe-tees/<arm>/<pairId>.jsonl`, sessionId-matched segment), not the per-session file under
  `probe-config/`: SIGKILL truncates that sync copy mid-write, so for censored turns its EOF is not
  the real turn end (verified: baseline-013 cfg copy shows 2 calls where the tee shows the complete
  window). The tee does not echo the `-p` prompt, so the exact kickoff text is re-injected as a
  synthetic user line before extraction (same code path as the runner). Cell medians are identical
  under both sources; individual censored pairs move by at most one call's worth of classification.
- **Dominant probe behavior in ALL arms** is git/fs inspection of the named worktrees and SHAs: the
  probe child verifies the pinned state instead of trusting it (context labels across arms: baseline
  fs-inspect 18 + read-fresh 18 + glob 9 + git-inspect 8; template fs-inspect 28 + glob 15 +
  read-kickoff-described 12; api fs-inspect 33 + read-kickoff-described 10 + git-inspect 9). The
  original kickoff induces the MOST verification (18 read-fresh — files it fails to describe), the
  API draft the least re-reading of described files. Productive test-runs appear in 9/11/3 windows
  (baseline/template/api).

### Retry accounting (REVIEW r1 finding A3 — all spawn attempts, both rounds)

- **Round 1: 21 spawn sessions for 16 usable probes** — 16 usable + 1 recorded rejected attempt
  (api-006 first attempt, 10 calls, `ok:false` in metering) + **4 additional ghost-runs** (spawn
  attempts that died before any metering record existed; tee sizes 231–373 KB each; their token
  spend is UNMEASURABLE because no usage was captured and the tees were overwritten by round-2
  reruns). Round 1 reported "1 rejected" — the correct statement is 5 rejected attempts, 4 of them
  unrecorded ghosts.
- **Round 2: 36 spawn sessions for 32 usable + 4 rejected** — the 4 rejections are baseline-arm
  timeouts below the 15-call threshold (F283-020: 13 calls, F283-006: 14, F283-015: 11, F283-030:
  14), all recorded `ok:false` in `probe-metering.json` with their token spend ($0.052 total) —
  nothing unrecorded this round.
- Metering now holds **53 records total (21 recorded r1 + 36 r2), every one priced**, including the
  5 rejected (tokens were really spent). 48 of 53 are the usable grid probes (16 per arm).

## Kill-criterion verdict (round 2)

**Pre-registration status (REVIEW r1 question C1, answered):** the criterion is **self-attested** —
the stage-1 plan doc registers the B2 metric and the beat-both rule as design intent at experiment
build time, but no externally timestamped pre-registration exists. Stated plainly; treat the
criterion as a design decision, not a registered prediction.

**Round-1 criterion** ("model-drafted arm must beat BOTH the historical baseline anchor AND the
template control"): **superseded** — the baseline anchor is a conditions artifact (fresh-baseline arm
measures 49.4% vs the historical 26.7% under identical probe conditions), so beating 26.7% was never
the right test for a fresh-turn setting.

**Round-2 criterion (de-confounded, same pairs, same conditions): the model-drafted arm must beat
BOTH the fresh-baseline arm (original kickoff) AND the template arm.**

> **Verdict: the lever IS demonstrated — modestly.** The API-drafted handoff beats the original
> kickoff (10/16 pairs lower, median −9.0 pp) and the template control (11/16, median −10.0 pp) in
> both directions, in all four cells, and under both strict and loose classification readings. This
> REVERSES the round-1 kill verdict, which was driven by the conditions confound rather than by
> draft quality.

Honest caveats attached to the pass:

1. **Margins are modest and n=16.** Sign tests: api-vs-template 11/14 non-tied (two-sided p ≈ 0.06),
   api-vs-baseline 10/15 (p ≈ 0.30) — the direction is consistent everywhere, but neither reaches
   conventional significance alone at this n. The pass rests on the pre-registered beat-both rule
   (medians + paired counts), not on statistical significance.
2. **Absolute re-derivation stays high.** API median 40% means two of every five first-window calls
   are still context re-derivation; the lever trims ~9–10 pp off a ~50% base at flash-class model
   quality, it does not eliminate re-derivation.
3. **Censoring is arm-asymmetric** (13/16 baseline vs 5/16 api turns hit the 420 s ceiling). The
   censored windows are used as observed (shorter windows), which if anything biases AGAINST the
   api-vs-baseline comparison being large — but the asymmetry is itself a finding: the original
   kickoff makes the next stage search longer.
4. **The probe child verifies instead of trusting, in every arm.** The residual 40% is dominated by
   git/fs verification of the pinned state — behavior the historical children (26.7%) did not show at
   fresh-turn intensity. A training decision (Stage 2) should weigh the demonstrated ~10 pp lever at
   flash class against this conditions shift; a cheap scale-up of the same 3-arm probe to more pairs
   would firm up the 10/16 margin before committing to Stage 2. That decision is Mateusz's; the
   pre-registered rule no longer blocks it.

## Spend accounting (tokens × config/models.json rows; no API-reported cost trusted)

Pricing rows: `z-ai/glm-5.3-flash` input $0.075, output $0.25, **cacheRead $0.015** per Mtok
(REVIEW r1 finding A4: round 1 omitted cacheRead from probe pricing). Full accounting in
`probe-cost-revised.json`; per-record in `probe-metering.json` / `api-metering.json`.

| item | tokens | cost |
|---|---|---|
| API drafts (52 metered calls, incl. 10 `ok:false`) | 129,015 in / 71,807 out | $0.0276 |
| Probes r1 (17 records) — as originally reported (12 priced, no cacheRead, censored unmetered) | — | $0.0891 |
| Probes r1 — REVIEW-corrected (12 records + cacheRead; 3,694,208 cache tokens) | — | $0.1445 (reproduced exactly) |
| Probes r1 — full re-price (17 records: + cacheRead + 5 censored/rejected backfilled from transcripts) | — | $0.2085 |
| Probes r2 (36 records incl. 4 rejected at $0.052) | — | $0.5203 |
| **Probes total (53 records, all priced)** | 3,714,254 in / 18,099,520 cacheRead / 714,900 out | **$0.7288** |
| Diagnostics | — | ~$0.005 |
| **Total (known spend)** | | **≈ $0.7614 of the $2 bound** |

- Censored-turn pricing method: timeout-censored turns have no result event, so usage is derived
  from the session transcript by deduplicating assistant messages on `message.id` and summing
  `usage` blocks; the method was validated to match a non-censored result event **exactly**
  (baseline F283-007: input 168,272 / cacheRead 514,304 / output 20,764 — zero difference).
  These backfilled figures are a **floor**: the transcript copy is SIGKILL-truncated, so some
  post-kill token burn is invisible.
- Unmeasurable: the 4 round-1 ghost-runs (no usage captured).
- The runner's in-run cost counter reported $0.3109 — it counted only records priced at run time;
  the backfill above is the honest total.
- $2 bound provenance (REVIEW r1 question C2, answered): the bound comes from the frontman's
  kickoff — staged-scope approval, 2026-09-20.

## Artifacts

- Working scripts + metering (LOCAL-ONLY, `.state/research-scratch/foc-283/`): `b2-list.fresh.js`,
  `b2-extract.fresh.js`, `b2-aggregate.fresh.js`, `build-pairs.mjs`, `make-split.mjs`,
  `template-drafts.mjs`, `api-arm.mjs`, `probe-run.mjs`, `probe-extract.mjs`, plus `pairs.json`,
  `split.json`, `template-drafts.json`, `api-metering.json`, `probe-sample.json` (round 1),
  `probe-sample-16.json` (round 2 grid), `probe-metering.json`, `probe-results.json` (incl.
  `looseSweep`), `probe-cost-revised.json`, `probe-tees/`, `probe-config/`.
- Committed: this report + `docs/STATE.md` entry (branch `foc-283-dev`).
