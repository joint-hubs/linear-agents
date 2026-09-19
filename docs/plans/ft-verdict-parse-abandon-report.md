# FOC-359 — Verdict-parser FT pilot: ABANDON report

> Decision: **ABANDON per PRD §11** — Mateusz approved 2026-09-19.
> The §5 bar (schema 100% AND field-level macro F1 ≥ 0.80) was NOT met.
> The schema layer is deployable as a Stage-A constrained-decoding harness; the
> findings-reconstruction layer is not trainable at this corpus size / approach.

## 1. What was attempted

A QLoRA-tuned small open-weights model (Qwen3-4B, 4-bit nf4 + LoRA) that parses a
code-review child's final "odprawa" text into the supervisor verdict JSON
(verdict / findings[] / acMapping[] / fingerprint). Evaluated against the PRD §5
bar on a held-out split, with **xgrammar constrained decoding** enforcing the
JSON schema at generation time (no enum hallucination, no missing fields).

Four full training iterations over the session; the last three added xgrammar
constrained decoding + progressively shorter finding text (180 → 40 chars).

## 2. Final results (best run)

Run: `ft/verdict-parse/runs/2026-09-17T16-11-17-653Z/eval-xgrammar-40char-full.json`
Adapter trained on 370 pairs, 180-char finding text. Eval on 34 held-out pairs
with 40-char gold text + xgrammar + gc.collect (full 34-pair run, no OOM).

| Metric | Value | Bar | Pass? |
|---|---|---|---|
| schema_validity | 91.18% | 100% | ❌ (3/34 truncation) |
| verdict_accuracy | 82.35% | — | — |
| findings_f1 | 0.0363 | — | ❌ |
| acMapping_f1 | 0.0462 | — | ❌ |
| **field_level_macro_f1** | **0.302** | **≥ 0.80** | **❌** |

`passed: false` (both `schema_100` and `f1_080` false).

### Cross-run table

| Run | Pairs | Schema | Verdict acc | findings_f1 | macro | Notes |
|---|---|---|---|---|---|---|
| Diag A (old adapter, 180-char eval) | 27 | 92.59% | — | — | 0.254 | first xgrammar run |
| Old adapter, 40-char eval (20 pairs) | 20 | 95.00% | 90.00% | 0.0125 | 0.3147 | short gold text |
| **Old adapter, 40-char eval (34 pairs)** | **34** | **91.18%** | **82.35%** | **0.0363** | **0.302** | **FINAL, best** |
| New adapter (40-char train), max_new=512 | 34 | 20.59% | 20.59% | 0.0000 | 0.0686 | truncation at 512 |

## 3. Which dimension missed (PRD §11 asks for this)

- **Schema:** 91% — close but not 100%. The 3 remaining invalids are
  **truncation** (model emits long JSON, runs past `max_new_tokens`), NOT enum
  hallucination. xgrammar eliminated the severity-enum hallucination that sank
  the earlier unconstrained runs (41% → 91%). Truncation is mechanically
  fixable (larger `max_new`, or shorter finding text); it is not the reason we
  abandon.
- **Verdict (pass/fail):** 82% — the model reads the review's verdict signal
  reasonably well. This is the one field that genuinely works.
- **Findings[] F1: 0.04** — the failure. The model generates the correct
  **number** of findings (157 predicted vs 164 gold) but **different content**.
  TP = 11 / 164. The model does not *extract* the supervisor's findings; it
  *interprets the review its own way* and produces its own findings. Shortening
  the gold text to 40 chars did NOT help lemma-overlap — the model generates
  its own text regardless of gold length.
- **acMapping[] F1: 0.05** — same root cause. The model does not map AC labels
  from the review text; it invents its own mapping.
- **Pass-verdict pairs with empty findings[]:** 10 pairs where gold has findings
  but the model emits `findings: []` — a comprehension gap, not a length gap.

## 4. Root cause

This is a **comprehension/extraction problem, not a decoding or text-length
problem.** Three layers:

1. **Severity enum hallucination** — xgrammar constrained decoding **fixes this**
   (41% → 91% schema). This layer is solved and deployable.
2. **Finding text non-reproduction** — xgrammar does **not** fix this. The model
   generates semantically-different findings than the recorded gold, because it
   reads the review as a reader and writes its own summary, not as an extractor
   pulling the supervisor's exact findings. Constrained decoding guarantees the
   *shape*; it cannot guarantee the *content*.
3. **Empty findings for pass verdicts** — the model learns "pass ⇒ no findings"
   from a subset of training data where pass verdicts had empty findings, and
   over-applies it. A training-data curation issue.

Layer 1 is a real win. Layers 2–3 are not closed by constrained decoding, by
shorter text, or by 370 pairs. Scaling to 1000+ pairs (option B) was estimated to
reach findings_f1 ≈ 0.20–0.30 — still far below 0.80. The §5 bar requires
field-level reconstruction of the *recorded* verdict, and a 4B reader-model
fundamentally generates rather than extracts.

## 5. What is salvageable (Stage A)

The xgrammar constrained-decoding harness is independently valuable and
deployable, independent of the FT model:

- `ft/verdict-parse/eval.py` — xgrammar integration (torch_native backend patch
  for Windows/no-triton, vocab_size-from-config, per-call LogitsProcessor,
  gc.collect OOM fix).
- `ft/verdict-parse/prompt.py` — shared SYSTEM_PROMPT (single source of truth
  for train + eval).
- `ft/verdict-parse/export-dataset.mjs` — 40-char finding text condenser.
- `docs/plans/ft-verdict-parse-explainer.md` — full pipeline explainer for a
  non-ML reader.

A future verdict-drafter that calls a frontier API model (not a 4B FT) can reuse
this schema + constrained-decoding harness to guarantee schema validity while
the API model supplies the comprehension. The constraint layer is the reusable
asset; the 4B adapter is not.

## 6. Decision

**Abandon the FT approach at this corpus size.** Keep the frontman hand-writing
verdicts (`supervisor-verdict.mjs record`), as today. Do NOT wire the 4B adapter
into the supervisor loop — its findings_f1 = 0.04 would inject wrong findings
into recorded verdicts, which is worse than the hand-written status quo.

Options A (retrain 370 pairs, 40-char) and B (1000+ pairs + augment gating) were
presented and rejected: A does not change the comprehension root cause; B's
estimated ceiling (0.20–0.30 F1) is still below the 0.80 bar and costs 1–2 days.

## 7. Follow-ups (not filed in Linear per wind-down directive)

If verdict-drafting automation is revisited:
- **Stage A (deployable now):** xgrammar schema-constrained harness wrapping an
  API model drafter. Schema validity is the solved layer; the API model handles
  comprehension. Keep supervisor approval as the gate (PRD §7 contract).
- **Stage B (research):** findings-reconstruction needs an extraction framing
  (span/pointer extraction over the review text), not a generation framing —
  or a much larger model. 4B-at-370-pairs generation is not the path.

## 8. FOC-359 Linear status

**In Progress** (NOT Done — the bar did not pass). This report is the §11
"report which dimension missed" deliverable. Close-out of the Linear issue is
Mateusz's call.