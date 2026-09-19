# FT candidate map — linear-agents (2026-09-17)

Companion to `docs/plans/ft-drafter-pilots.md` and `docs/plans/verdict-parse-ft-pilot.md`.
Method: the three-filter test from the 2026-09-17 research session
(`Second Brain/Research/fenix-finetuning-usecases-linear-agents-2026-09-17.md`),
applied to every squad seam. Every candidate cites its measured motivation from the
telemetry report (`docs/research/telemetry-analysis-2026-09.md`) and its real label source.

The three filters:
1. **Extractive?** Output contained in input (parse/compress/format/cite/classify) → viable
   on 1.7B. Generative (compose new judgments from nothing) → not viable, produces
   confident-sounding garbage that gates dev/review.
2. **Free labels?** Labels must be a byproduct of normal work (verdicts, kickoffs, briefs),
   not a manual annotation project.
3. **Cheaper alternative?** If regex/script/big-model-prompt solves it, that wins by default.

## Where each pipeline stage could host a small FT model

```
PLAN (decomposer) ──> DEV kickoff ──> DEV child ──> REVIEW child ──> verdict ──> TEST child
   [C1 ac/dod-draft]   [C2 handoff-     [C5 stuck-      [C5 stuck-     [C3 verdict-   [C2 cont.]
                        compressor]      watcher]        watcher]       parse ✓]
```

| ID | Candidate | Squad/seam | Input → output | Labels today | Verdict |
|---|---|---|---|---|---|
| C3 | **Verdict parser** | review→supervisor | review final text → verdict JSON | 175 verdicts (2x since census) | **pilot running** (FOC-359) |
| C2 | **Handoff compressor** | supervisor→child kickoff | child result artifacts → pinned-state handoff | 86 pairs + 1143 sessions self-supervised | **pilot 2, planned** — biggest cost lever (frontman 43.5%) |
| C1 | **AC/DoD drafters** | plan decomposer | parent+subtask → ac[]/dod[] | ~60–100 pairs (W0 census pending) | **PRD drafted** (`ft-drafter-pilots.md`) — parked on W0 census |
| C5 | Stuck-child watcher | all supervised children | child tee tail → stuck/looping/ok | self-labeled from repeat-counts (703× re-reads, ec58 91%, gemini-3.8-flash 45.7%) | cheap side-readout; regex baseline first (filter 3) |
| C4 | Gate pre-screener | supervisor gates | question gate → needs-human / answerable-from-docs | 21 labels, zero negatives | **parked** until 50+ real question-gates or H5 lands |
| C6 | Kickoff verifier | supervisor spawn | kickoff-named files vs child tree → exists/missing | spawn-time verification (H2) currently logs this mechanically | not FT — tooling (filter 3) |
| C7 | Findings-class classifier | review | finding text → error class (Y/R/A/D/T…) | b3-classify regex heuristics | **rejected** — regex already exists; FT to lose to own regex |
| C8 | Failure triage | turn boundary | error signature → retry/alert class | 38 examples, deterministic codes | **rejected** — rules not model |
| C9 | Outcome predictor | run level | telemetry features → pass/fail | 47 rows | **rejected** — tabular ML territory, not LLM FT |

## Rejected-by-principle (do not resurrect)

- **Anything generative without pinned input.** "Write DoD from a task summary" (the
  original C1 framing) fails filter 1. The viable reframing: draft from
  parent-description + subtask inputs, and review/correct — never generate from nothing.
- **Anything whose labels need a manual annotation project before a pilot.** If labels
  aren't a work byproduct, the flywheel is broken and the pilot becomes a labeling project.
- **Anything a `grep` can do.** C6, C8. FT is for judgment under format, not detection.

## The passive-mining backlog (labels that accumulate as squads work)

These are zero-cost label sources to instrument **before** their pilots, so datasets grow
while the squads operate:

1. **Verdict corrections** — draft vs. recorded verdict delta once C3 deploys (DPO-ready).
2. **Brief draft corrections** — decomposer draft vs. corrected ac[]/dod[] once C1 deploys.
3. **Gate answers** — structured `facts` (H5) makes every answered gate a labeled pair for C4.
4. **Question-gate negatives** — self-resolved questions in the 1143-session archive
   (child asked in prose, resolved without a gate) mined as the missing negative class.
5. **Handoff re-writes** — frontman edits to compressed kickoffs, once C2 deploys.
6. **DoR rejections** — tasks bounced by the M4 gate (no AC/DoD) are negative examples for C1:
   what "not ready" looks like.

## Ranking with honest caveats

1. **C3 verdict-parse** — finish it. It is the shakeout for the whole program.
2. **C2 handoff compressor** — biggest measured lever, only candidate with real data volume,
   blocked on H1 format adoption, eval harness exists (B2).
3. **C1 AC/DoD drafters** — PRD ready, parked on W0 census; run as gap-filler while C2
   waits on H1. Honest framing: consistency play, not cost play.
4. **C5 stuck-watcher** — build the regex baseline first; FT only if "productive retry vs
   stuck" classification shows up in the tail the regex misses.
5. **C4 gate pre-screener** — wait for labels (H5 + 50 gates).