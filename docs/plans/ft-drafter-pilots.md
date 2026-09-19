# PRD — AC-drafter + DoD-drafter FT pilots

> Status: DRAFT 2026-09-17 — not signed off.
> **Precondition:** the verdict-parse pilot (FOC-359) resolves its §5 bar first (met, or explicitly
> failed-and-rescoped). This document follows the verdict-parse PRD template
> (`docs/plans/verdict-parse-ft-pilot.md`); process lessons from pilot run 1 are baked in and
> not re-argued here.

## 0. Why two models, one plan

Both drafters live in the same seam: the PLAN decomposer (`agents/plan/agents/decomposer.md`),
which today runs `z-ai/glm-5.3-flash` and emits the brief JSON
(`planning/briefs/plan_*.json`) with `ac[]` and `dod[]` per subtask. Shared dataset source,
shared schema consumer (`push.mjs` imports the brief), shared eval protocol (blind A/B),
shared deployment seam (draft-then-review). One PRD, two task prefixes, one adapter
(telemetry §5.2 multi-task design) — split into two adapters only if the bar says so.

## 1. Problem

- **House-format drift.** The issue templates (`config/linear/templates/*.md`) prescribe
  Given/When/Then ACs and a DoD checklist, but the recorded briefs show the real house style
  is far richer than the template: `BLOCKING:` sequencing rows, decision-recording rows,
  file:line references, links to prior decisions (`plan_landing-pl-locale.json` s4, s5, s12).
  A generic flash model re-derives this style every call and drifts.
- **Weak ACs are a measured upstream cause of review leakage.** B3/F5 error classes —
  A (claims contradicted by artifacts, 11.4%), T (missing/weak tests, 7.8%), D (stale docs,
  8.6%) — are symptoms of ACs/DoD rows that never pinned the boundary. 54% of consecutive
  round-pairs re-present the same error class (telemetry F5).
- **DoR/DoD gate friction.** The workflow's M4 gate rejects tasks without AC/DoD; R8 found
  the triage parser skips `## acceptance` in some issue formats (×3). Drafting at the source
  (decomposer) reduces downstream repair.
- **Cost is NOT the primary lever here** (honest framing): plan squad is 8.9–11.2% of corpus
  cost, unlike the frontman's 43.5%. The win is **consistency by construction** + free local
  inference + a recorded correction signal.

## 2. Goal & non-goals

**Goal:** a Qwen3-1.7B QLoRA adapter that, given parent description + subtask
title/type/slice (+ `ac[]` as context for the DoD task), drafts
(a) `ac[]` — Given/When/Then triples, and (b) `dod[]` — house-style checklist rows, such that:
1. schema-valid 100% (constrained decoding — verified in eval, not hoped for),
2. house-format compliance ≥90% (§5.2),
3. in blind A/B against the current flash-decomposer output, plan-lead preference ≥50%
   (a tie IS the win: free, local, consistent).

**Non-goals:**
- **Not** replacing the decomposer loop — spec-review, estimates, `blockedBy`, `rejected[]`
  stay with the flash model. The FT model drafts `ac[]`/`dod[]` only.
- **Not** generating ACs without spec context. No free generation — input must contain the
  parent description (verdict-parse lesson: extractive beats generative on 1.7B).
- **Not** writing to Linear. `push.mjs` unchanged.
- **Not** a DoD *compliance checker* — that is a different candidate (see
  `ft-candidate-map.md`), needs its own labels.

## 3. Schema — frozen from the decomposer brief schema

Source of truth: `agents/plan/agents/decomposer.md` output contract + `push.mjs` importer.

```json
{
  "ac":  [ { "given": "...", "when": "...", "then": "..." } ],
  "dod": [ "string (>=8 chars)" ]
}
```

Constraints (mechanically checkable — the runtime/eval fills the same role
`supervisor-verdict.mjs` guards fill for verdict-parse):
- `ac[].given|when|then`: non-empty strings.
- `dod[]`: non-empty strings, ≥8 chars, ≤400 chars each.
- House prefixes (`BLOCKING:`, `Decision recorded`, `NOTE:`, `WHY:`) are **learned content**,
  not schema. The schema does not enforce them; the A/B and format checks observe them.

**Input contract:**
```
ac-draft:  parent description (<=4k chars) + subtask title + type + slice
dod-draft: same, plus the final ac[] of that subtask
```
No repo access, no Linear access. Language: EN-dominant, some PL (Qwen3 handles both).

## 4. Dataset

### 4.1 Verified today (thin — stated plainly)

9 briefs (`planning/briefs/plan_*.json`). Fully counted reference: `plan_landing-pl-locale.json`
= 15 subtasks / 35 AC items / 56 DoD items. Estimated total across 9 briefs: **~60–100
subtask pairs** (some briefs are small; exact count is W0). That is the same borderline class
as verdict-parse at 87 pairs — below the "hundreds ideal" bar.

### 4.2 W0 census (blocking, ~0.5 day)

Count real pairs before committing GPU:
- per-brief subtask/AC/DoD counts (local script — extends `export-dataset.mjs` walk);
- Linear issue bodies with `## Acceptance Criteria` + `## DoD` sections across workspaces
  (templates enforce presence; requires GraphQL reads — **explicitly not run yet**;
  prerequisite for this workstream);
- the **175 verdicts now on disk** (census of 2026-09-10 said 89 — the corpus nearly doubled
  in a week): each carries `acMapping[]` = AC labels as accepted + verifying evidence. That
  is AC-quality signal, and it also enables a verdict-parse dataset re-export at ~2x volume.

**Decision gate:** if W0 census < 150 subtask pairs → pilots park; mine passively
(every new decomposer brief adds pairs at zero cost); revisit quarterly.

### 4.3 Split

Task-stratified 80/20. **Intra-brief correlation stays in one side of the split** — subtasks
of the same parent share traps, decisions and style (landing s1–s15 demonstrably do);
splitting them across train/eval leaks style and inflates the bar.

### 4.4 Augmentation

Schema-gated self-training only (no free generation): run the trained model over legacy
specs, keep outputs that pass §3 schema + a big-model cross-check. Same contract as
verdict-parse §4.2.

## 5. Evaluation bar — honest for generative drafting

The recorded brief is **one valid answer among many**; reconstruction F1 against it penalizes
valid alternatives. (This is the verdict-parse lesson that does NOT transfer.) The bar:

1. **Schema validity 100%** — enforced by constrained decoding (GBNF / `guided_json`),
   asserted by the eval harness. Not a training achievement; a decoding choice.
2. **House-format compliance ≥90%**: every `then` contains an observable predicate
   (regex: artifact/test/output/exit/URL token); DoD rows reference named artifacts where the
   input named them (file:line / path prefix match); no template-echo (generic template rows
   like "All AC pass" count as a miss unless input gives nothing to work with).
3. **Blind A/B:** plan lead sees (model draft, flash draft) shuffled per subtask, picks one;
   ≥50% preference over ≥30 judged pairs. A tie adopts the model (consistency + cost).
4. **Degeneration guard:** 0 repeat-loop signatures in outputs (harness check; verdict-parse
   run 1 pathology).

If the bar fails → report which dimension missed, park. Do not productionize a fail.

## 6. Model & training

- Base Qwen3-1.7B, QLoRA (fallback Qwen3-4B), per pilot-1 lessons applied from day 1:
  - `completion_only_loss=True` (pilot run-1's full-sequence loss was the measured error);
  - task prefixes `ac-draft:` / `dod-draft:` in the system prompt;
  - constrained decoding at inference; repetition penalty 1.1; `max_tokens` cap 1200;
  - targets already compact (AC triple + checklist rows) — no condensation pass needed
    (unlike verdict-parse).
- Reuse `ft/verdict-parse/train.py` parametrized by data-dir/run-dir — no new trainer.

## 7. Deployment seam

`decomposer` gets a flag (default off): the FT model drafts `ac[]`/`dod[]`; the decomposer
lead reviews + corrects — same HITL contract as verdict-parse §7. **Correction deltas are
recorded from day 1** (draft vs. corrected, per subtask, under `.state/`): that is the v2
preference dataset (DPO-ready) and the honest adoption metric (corrections per subtask,
tracked over time). `push.mjs` consumes the corrected brief unchanged.

## 8. Sequencing

| # | Workstream | Artifact | Blocked by |
|---|---|---|---|
| W0 | Pair census (briefs + Linear issues + verdict acMapping) | `ft/drafter-pairs/census.md` | GraphQL read consent |
| W1 | Dataset export → JSONL per §3 | `ft/drafter/data/{train,eval}.jsonl` | W0 (≥150 pairs) |
| W2 | Train (reuse train.py) | `ft/drafter/runs/<id>/adapter` | W1 |
| W3 | Eval harness: schema+format checks automated; blind-A/B viewer | `ft/drafter/eval.py` + `ft/drafter/ab/` | W2 |

Order vs. other pilots: **after handoff-compressor** (telemetry §5.5) — drafters are cheaper
to build but lower measured impact (plan 8.9–11.2% of cost vs frontman 43.5%). Exception: if
the GPU is idle while handoff waits on H1 format adoption, W0–W3 can run as the parallel
candidate; the A/B protocol (human judging) is the real bottleneck, not GPU.

## 9. Effort & cost

~3 days total + local GPU time. Inference marginal cost zero. No API cost (open-weights).

## 10. Decisions to resolve before sign-off

1. Adapter: single multi-task (task-prefixed) vs. two adapters — default single per
   telemetry §5.2; split only on bar-miss attribution.
2. A/B rater: Mateusz + decomposer lead? How many pairs each (target ≥30 judged)?
3. W0 scope: FOC workspace only, or all workspaces (FOC/JOI/PISI)?
4. Preference-capture format: extend brief JSON with `acDraft[]`/`dodDraft[]` originals, or
   separate `.state/draft-corrections/` files?