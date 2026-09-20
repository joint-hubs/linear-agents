# FOC-283 — Handoff compressor, Stage 1 (eval only)

**Date:** 2026-09-20 · **Branch:** `foc-283-dev` · **Mode:** supervised, eval-only (no training, no GPU, no model downloads)
**Question:** can a model draft the pinned-state handoff well enough that the NEXT stage does less re-derivation?

Metric (identical across all arms): **B2 first-turn context-call share** — in the first 15 tool calls
of the child's first turn (or fewer if the turn ends earlier), the share classified as context
re-derivation (reads of files the kickoff already describes, git inspection, fs inspection, grep/glob,
linear reads, codegraph). Same extractor as the baseline re-measure (AC-1); classification logic
copied verbatim.

## AC-1 — Baseline anchor (frozen archive, re-measured 2026-09-20)

Fresh re-run of the B2 extractor over the frozen transcript archive reproduces the earlier
measurement exactly (183 sessions):

| squad | n | ctxPct median | substantive median |
|---|---|---|---|
| dev | 56 | 33.3% | 50.0% |
| review | 64 | 26.7% | 33.3% |
| test | 44 | 26.7% | 37.5% |
| plan | 19 | 50.0% | 59.1% |

Relevant stage anchors for the two pair directions: **dev→review ≈ 26.7%** (review children) and
**review→test ≈ 26.7%** (test children).

## AC-2 — Pair corpus and split

- **86 pairs** built from per-run `children.json` registries joined to archived transcripts:
  46 dev→review + 42 review→test (FOC-288 earlier counted 88 constructible; 2 excluded for short
  prev text: FOC-225 dev-3→review-4 at 155 chars, FOC-100 review-2→test-3 at 120 chars).
- **Split** grouped by task (no task on both sides, leakage check passed): train 22 tasks / 44 pairs
  (21 dr + 23 rt), eval 23 tasks / 42 pairs (24 dr + 18 rt).

## AC-3 — Template arm (zero model involvement)

Mechanical 9-slot FOC-278 pinned-state fill from the same children.json input, for all 42 eval pairs.
`template-drafts.json` manifest: 42/42.

## AC-4 — API arm (OpenRouter flash class)

Model `z-ai/glm-5.3-flash` (config/models.json row), extractive-only prompt (FOC-359: a generating
model scored F1 = 0.04 on this task), temperature 0, max_tokens 4000, `reasoning: {effort: low}`
(reasoning is mandatory for this model; with default effort it burned the entire max_tokens budget
and returned empty content), `usage: {include: true}` for metering.

- Drafts: 42/42 eval pairs drafted.
- **Metering (tokens × config pricing rows, never API-reported cost):** 52 metered calls,
  129,015 input / 71,807 output tokens → **$0.0276**.
- Bookkeeping: 74 records total (52 metered + 22 early failures from before the two fixes, unmetered
  because OpenRouter omitted usage on those).

## AC-5 — Downstream probe (real headless child turns)

Design: 8 eval pairs (4 dev→review + 4 review→test), **the same pairs in both arms** (paired
design), identical framing text, identical worktree/permissions/config-dir conditions — the ONLY
difference is the handoff text (template vs API draft). Flash-class model via
`ANTHROPIC_MODEL=z-ai/glm-5.3-flash`, headless `claude -p`, deny-only settings, dedicated
CLAUDE_CONFIG_DIR per arm.

**Limitation (stated per plan):** the baseline anchor comes from historical archived runs under
different conditions; template-vs-API is the same-conditions comparison. The baseline is an anchor,
not a competitor arm.

### Results — B2 metric, first-15 window, ctx% per pair and cell median

| cell | pairs (ctx%) | median |
|---|---|---|
| template dev→review | 005=12.5, 007=58.3, 012=50.0, 014=71.4 | **54.2%** |
| template review→test | 006=45.5, 013=70.0, 015=50.0, 017=33.3 | **47.8%** |
| api dev→review | 005=57.1, 007=44.4, 012=25.0, 014=30.0 | **37.2%** |
| api review→test | 006=15.4, 013=58.3, 015=40.0, 017=33.3 | **36.7%** |

- **Template vs API (same pairs, same conditions):** API arm median is lower in BOTH directions
  (−16.9 pp dev→review, −11.1 pp review→test). Paired per-pair: API lower in 6/8 pairs, tied 1,
  higher 1 (template 012.5% outlier pair 005: template 12.5% vs api 57.1%).
- **vs baseline anchor (26.7%):** NO arm reaches the historical anchor. Both fresh-turn arms sit
  ABOVE it (template 47.8–54.2%, api 36.7–37.2%).

### Reliability notes (from per-call audit of the probe windows)

- Windows are short in the template arm (6–14 calls; the child answers quickly from the kickoff
  text) — the metric uses the window as-is, same as B2's 111 short historical sessions.
- 5/16 probe turns hit the 420 s harness timeout; 4 had a complete first-15 window in the
  transcript (censored-but-usable, the metric window is complete); 1 (api-006 first attempt, 10
  calls) was discarded and retried.
- Sensitive to classification breadth: with fs-inspection matched anywhere in the Bash command (not
  only anchored at start), both arms rise (template 77.6–79.5%, api 83.4–89.8%) — the API advantage
  flips sign under the loosest reading, though most of the added "context" in both arms is
  `git log/diff/show`-style verification, which the strict reading already splits honestly. The
  strict extractor numbers are the primary result; the loose sweep is recorded as an uncertainty
  band in `probe-results.json`.
- Dominant probe behavior in BOTH arms: git/fs inspection of the named worktrees and SHAs (the
  kickoff text tells them exactly what to verify — they verify instead of trusting). Productive
  test-runs appear in only 2/16 windows. The historical children (baseline 26.7%) face the same
  work, so the gap is conditions (fresh single-turn vs long-running child), not drafting quality.

## Kill-criterion verdict

**Pre-registered criterion:** the model-drafted arm must beat BOTH the baseline anchor AND the
template control on the downstream metric; otherwise the lever is not reachable at current model
quality and Stage 2 (training) does not start.

**Verdict: the lever is NOT demonstrated at current model quality.**

- vs baseline anchor: **fail** — both arms (36.7–54.2%) are above the 26.7% anchor in both
  directions; fresh single-turn probes re-derive more context than the historical long-running
  children did, regardless of draft quality.
- vs template control: **pass** — API drafts beat the template control in both directions (paired,
  same pairs, same conditions), 6/8 pairs individually.

Interpretation: the extractive flash-class draft does help the next stage vs a mechanical template,
but the dominant context cost in a fresh first turn is verification of the pinned state itself
(git/fs inspection of the named worktrees and SHAs), not re-derivation the draft failed to prevent.
Under the pre-registered criterion (must beat BOTH), Stage 2 should not start on this evidence.
The conditions gap (fresh probe vs historical anchor) is the main confound and is recorded as such;
a same-conditions baseline arm (fresh probe against the original archived kickoff) would be the
clean way to separate the two effects before any training decision.

## Spend accounting (tokens × config/models.json rows; no API-reported cost trusted)

| item | tokens | cost |
|---|---|---|
| API drafts (52 metered calls) | 129,015 in / 71,807 out | $0.0276 |
| Probes (16 child turns, priced same rows) | from result events where present; censored turns unmetered | $0.0891 |
| Diagnostics | — | ~$0.005 |
| **Total** | | **≈ $0.12 of the $2 bound** |

## Artifacts

- Working scripts + metering (LOCAL-ONLY, `.state/research-scratch/foc-283/`): `b2-list.fresh.js`,
  `b2-extract.fresh.js`, `b2-aggregate.fresh.js`, `build-pairs.mjs`, `make-split.mjs`,
  `template-drafts.mjs`, `api-arm.mjs`, `probe-run.mjs`, `probe-extract.mjs`, plus
  `pairs.json`, `split.json`, `template-drafts.json`, `api-metering.json`, `probe-sample.json`,
  `probe-metering.json`, `probe-results.json`, `probe-tees/`, `probe-config/`.
- Committed: this report + `docs/STATE.md` entry (branch `foc-283-dev`).
