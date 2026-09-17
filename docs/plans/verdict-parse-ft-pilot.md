# PRD — Verdict-parser fine-tune pilot (FOC-359)

> Status: SIGNED OFF 2026-09-17 — Mateusz approved §3 (schema), §5 (eval bar), and resolved §10 (5 open questions → decisions). W1 (dataset export) is unblocked.

## 1. Problem

The supervisor's REVIEW→verdict step is prose→structured-JSON, done today by the frontman reading the review child's final assistant text and hand-writing a `supervisor-verdict.mjs record` call (`--finding '{"text","evidence"}'`, `--ac '{"ac","evidence"}'`, `--verdict pass|fail`). This is:
- **Fragile** — a misread severity or missed evidence citation produces a verdict that fails the tool's own guard (`isEvidence`, `supervisor-verdict.mjs:99`) or, worse, passes with a silent gap.
- **Costly** — the frontman is 43.5% of corpus cost (telemetry §F2); drafting verdicts is a measurable slice of that.
- **Inconsistent** — `declaredAcs` is 0 in 59/89 verdicts (tool quirk, §F7.4) and `fingerprint.failingTests` is empty in 86/89 (§F7.4) — the frontman skips fields the tool does not enforce.

A small open-weights model trained to parse the reviewer's final text into the exact verdict JSON would remove the prose→JSON seam, enforce the schema by construction, and draft the verdict for the frontman to review+approve (same contract as gates — human stays in the loop).

## 2. Goal & non-goals

**Goal:** a QLoRA-tuned 1–3B model that, given a review child's final assistant text (+ diff stats), outputs a verdict JSON that (a) is schema-valid 100%, (b) reconstructs the recorded verdict on held-out pairs at ≥80% field-level F1.

**Non-goals:**
- **Not** a gate pre-screener (deferred — 21 labels, no negative class, §5.5 of telemetry report).
- **Not** a handoff compressor (second FT pilot — depends on H1 format, separate PRD).
- **Not** replacing the frontman's approval. The model drafts; the supervisor reviews + records (or corrects). Same HITL contract as gates.
- **Not** a loop-restart classifier or DoD generator as separate models — both are the verdict parser re-purposed (pass/fail is the verdict field; DoD maps to acMapping). One adapter, three read-outs.

## 3. Schema — the output contract (frozen from `supervisor-verdict.mjs`)

The model output MUST match the recorded verdict shape exactly. Source of truth: `scripts/supervisor-verdict.mjs:90-105` and the 89 recorded verdicts in `.state/supervisor/*/verdicts/`.

### 3.1 Top-level

```json
{
  "verdict": "pass" | "fail",
  "findings": [ {severity, text, evidence} ],
  "acMapping": [ {ac, evidence} ],
  "declaredAcs": number,
  "fingerprint": {diff, tests, combined, changedFiles, failingTests, error}
}
```

### 3.2 Fields (from the tool's own validation)

| Field | Type | Constraint | Source |
|---|---|---|---|
| `verdict` | enum | `"pass"` \| `"fail"` (lowercase) | VERDICTS `:90` |
| `findings[].severity` | enum | `"issue"` \| `"todo"` \| `"nit"` \| `"question"` \| `"praise"` | SEVERITIES `:91` |
| `findings[].text` | string | non-empty | required by record |
| `findings[].evidence` | string | **≥4 chars**, not in NON_EVIDENCE list (`["", "-", "--", "n/a", "na", "none", "todo", "tbd", "?", "see above", "obvious"]`) | isEvidence `:99-105` |
| `acMapping[].ac` | string | non-empty AC label | record `--ac` flag |
| `acMapping[].evidence` | string | ≥4 chars, not NON_EVIDENCE | isEvidence (same guard) |
| `declaredAcs` | number | count of ACs the issue declared | parsed from issue body |
| `fingerprint.diff` | string\|null | 12-char hex, or null if unreadable | progressFingerprint |
| `fingerprint.tests` | string | 12-char hex (sha of empty-list hash allowed) | progressFingerprint |
| `fingerprint.combined` | string\|null | 16-char hex, or null | progressFingerprint |
| `fingerprint.changedFiles` | number\|null | porcelain count, or null | progressFingerprint |
| `fingerprint.failingTests` | string[] | sorted, deduped, trimmed | normalizeFailingTests `:1153` |
| `fingerprint.error` | string\|null | error message or null | progressFingerprint |

### 3.3 What the model produces vs. what the runtime fills

The model **drafts** `verdict`, `findings[]`, `acMapping[]`, `fingerprint.failingTests` (from the review text). The runtime **fills** `declaredAcs` (parsed from the issue body — the model cannot reliably count ACs it was not shown) and `fingerprint.{diff,tests,combined,changedFiles,error}` (from the worktree — the model does not see the tree, so it cannot fabricate these). `fingerprint.failingTests` is model-drafted then runtime-validated+normalized via `normalizeFailingTests` — same contract as the other semantic fields. The seam is clean.

### 3.4 Input contract

```
Input: the review child's final assistant text (the "odprawa" STATUS block),
       prefixed with diff stats (changed files, +/− counts) that the runtime
       provides from progressFingerprint. No worktree access, no Linear access.
Output: the JSON above, minus the runtime-filled fingerprint fields and declaredAcs.
```

The runtime passes diff stats as a prefix — they are cheap, already in `progressFingerprint`, and help the model ground evidence citations. The model can later self-check against them; they are advisory context, not fields the model emits.

Language: ~30% Polish in review text (telemetry §FT-probe), English-dominant in verdicts. The model is bilingual by training (Qwen2.5 handles PL/EN); mixed data is a feature, not a bug.

## 4. Dataset

### 4.1 Source pairs (87 verified)

From `FT-probe-training-data.md` §2: 87/89 supervisor verdicts have the review child's tee with non-empty final assistant text (~3.6 KB avg, ~315 KB total). The 2 without assistant text are dropped. Each pair is:

```
input  = review child's final assistant text (from children/review-*.jsonl, last assistant text block)
output = the recorded verdict JSON (from verdicts/<task>-round<n>.json)
```

Extraction scripts exist in `.state/research-scratch/`: `b3-classify.mjs`, `census.mjs`, `verify-kickoff.mjs`. The export step reuses them; no new extraction logic.

### 4.2 Augmentation (schema-checked self-training)

- **71 legacy `.md` reviews** (`.state/reviews/`, round-named) — unstructured, no labels. Used as extra *inputs* only: run the trained model on them, keep only outputs that re-validate against the schema and a big-model cross-check. Not in the supervised set.
- **No free generation.** Augmentation is schema-validation-gated: an output that fails `isEvidence` or the enum checks is discarded, not corrected by hand.

### 4.3 Split

87 pairs → 70 train / 17 eval (stratified by verdict: 62 pass / 27 fail → ~50/20 train, ~12/5 eval). Eval is held out from training and augmentation; it is the §5 bar.

## 5. Evaluation bar

The pilot succeeds if, on the 17 held-out pairs:

1. **Schema validity: 100%.** Every output parses as JSON and satisfies every §3.2 constraint (enum, non-empty, evidence ≥4 chars, not NON_EVIDENCE). A single schema-invalid output fails the pilot.
2. **Field-level reconstruction F1 ≥ 0.80.** Comparing model output to the recorded verdict:
   - `verdict`: exact match (pass/fail).
   - `findings[]`: field-level F1 over `(severity, text-lemma, evidence)` — a finding is a match if severity matches and text is a paraphrase (lemma overlap ≥0.6) and evidence cites the same artifact (path:line prefix match).
   - `acMapping[]`: F1 over `(ac, evidence)` — ac label exact match, evidence same-prefix.
   - `declaredAcs`: within ±1 of recorded.
3. **Round-trip on legacy corpus** (optional, stretch): schema-gated acceptance on the 71 `.md` reviews — the model produces schema-valid output on ≥80%, even if labels aren't checkable.

If the bar fails, the pilot reports "not trainable at 87 pairs" and we do not proceed to handoff-compressor. The bar is a gate, not a target.

## 6. Model & training

- **Base:** Qwen3-1.7B (April 2025 successor to Qwen2.5-1.5B; thinking-mode, 32K context, PL/EN by training). Fallback Qwen3-4B if 1.7B misses the bar.
- **Method:** QLoRA (4-bit quant, LoRA adapters). VRAM: 1.7B ≈ 8–12 GB, 4B ≈ 12–16 GB. Fits Mateusz's consumer GPU.
- **Task prefix:** single adapter, instruction-prefixed `verdict-parse: <input> → <output>`. No multi-task mixing in this pilot (handoff-compress is a separate adapter later).
- **Framework:** `unsloth` (preferred) or `peft` + `transformers`. Local training, no API cost.
- **Hyperparameters:** default QLoRA recipe (lr 2e-4, 3 epochs, bs 4, seq_len 4096 — review texts are long). Tuned only if the bar is missed.

## 7. Deployment seam

The frontman, after REVIEW child ends:
1. Reads the review child's final assistant text (via `supervisor-status.mjs` tee).
2. Runs the model: `input → verdict JSON draft`.
3. **Reviews the draft** (severity, evidence citations, verdict) — same contract as a gate.
4. Records the (possibly corrected) verdict via `supervisor-verdict.mjs record`. The runtime fills the fingerprint fields.

The model is a drafter, not a recorder. It never writes to Linear, never touches the worktree, never records a verdict. The supervisor's approval is the gate.

## 8. Sequencing (workstreams)

| # | Workstream | Artifact | Blocks / blocked by |
|---|---|---|---|
| W1 | Dataset export — 87 pairs → train/eval JSONL under schema §3 | `ft/verdict-parse/data/{train,eval}.jsonl` | blocked by W2 (this PRD) |
| W2 | Schema freeze — this PRD §3 | `docs/plans/verdict-parse-ft-pilot.md` | **this document** |
| W3 | QLoRA training pipeline | `ft/verdict-parse/train.mjs` (+ config) | blocked by W1 |
| W4 | Eval harness — §5 bar | `ft/verdict-parse/eval.mjs` (reuse B2 extractor logic from research-scratch) | blocked by W3; reuses W1 eval split |

W1 starts after this PRD is signed off. W3/W4 are iterative — train, eval, adjust, retrain until the §5 bar is met or the pilot reports failure.

## 9. Effort & cost

- Dataset export (W1): ~1 day (scripts exist).
- Training pipeline (W3): 1–2 days (unsloth setup + first run).
- Eval harness (W4): ~1 day (reuse B2 extractor).
- Marginal cost: local GPU time only. No API cost (open-weights, local).
- Total: ~3–4 days of work, bounded by the §5 bar.

## 10. Resolved decisions (signed off 2026-09-17)

1. **`declaredAcs`** → **runtime parses from issue body**, model does not predict it. The model cannot reliably count ACs it was not shown.
2. **`fingerprint.failingTests`** → **model drafts from review text, runtime validates+normalizes** via `normalizeFailingTests`. Same contract as the other semantic fields.
3. **Diff stats in input** → **runtime passes them as a prefix.** Cheap, already in `progressFingerprint`, ground evidence citations; the model can self-check against them later.
4. **Paraphrase threshold** → **0.6**, starting point; tuned after the first eval run shows the distribution.
5. **Base model** → **Qwen3-1.7B** (newer than Qwen2.5-1.5B, same size class, thinking-mode). Fallback Qwen3-4B if the bar is missed.

## 11. Success → next

If the §5 bar passes:
- File FOC-359 as Done, proceed to **handoff-compressor** FT pilot (separate PRD — depends on H1 format being adopted; FOC-286 + FOC-357 cover the pinned-state side, so the schema is derivable).
- Wire the model into the supervisor loop as the verdict drafter (§7) behind a flag, default off.

If the §5 bar fails:
- Report which dimension missed (schema / verdict / findings / acMapping).
- Decision: more data (mine the 71 legacy + self-supervised), bigger model (3B), or abandon and keep the frontman hand-writing verdicts.

---

*This PRD is signed off. W1 (dataset export) is unblocked — implementation may begin. No Linear writes, no supervisor loop until the §5 bar is met.*
