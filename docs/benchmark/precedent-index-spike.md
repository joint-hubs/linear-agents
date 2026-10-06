# Precedent index — F0 evidence spike (T0.1–T0.8)

**Date:** 2026-09-29 · **Status:** results in, **decision pending (T0.8, Mateusz)** · **PRD:** [prd-precedent-index.md](../prd/prd-precedent-index.md) · **ADR:** [0014](../adr/0014-precedent-index-two-layer.md) · **Code:** [tools/precedent-spike/](../../tools/precedent-spike/README.md)

Question F0 answers: is a two-layer, embedding-backed index of closed FOC/JOI work worth building, on our own data, before any infrastructure exists? Everything below was **run**, read-only, on the local telemetry cache (built 2026-09-29 17:29 UTC), a Linear snapshot of the same day, the git history of 11 local repos, `.state/supervisor` and the transcript files. Total API spend for the whole spike: **≈ $0.60 embeddings + $0.006 Jev**.

## 0. Verdict against the accepted thresholds (D14)

| # | Threshold (accepted 2026-09-29) | Result | Verdict |
|---|---|---|---|
| 1 | Recall@5 ≥ 0.35 on cases with ≥ 1 positive | best hybrid (BM25 + dense, RRF) **0.43 raw / 0.57 capped** [95% CI 0.38–0.49 / 0.51–0.63]; BM25 alone 0.36 / 0.49; recency 0.26 / 0.31; random 0.04 / 0.06 | **Met** |
| 2 | Cost prediction from neighbours: MAPE ≥ 15% better than the per-type median | median over 12 embedding models **−0.9%** (2 of 12 reach +15%, every interval spans zero); worse than a "last 10 closed tasks" median | **Not met** |
| 3 | ≥ 60% of clusters coherent (manual review) | ≈ 85–90% of 45 HDBSCAN clusters coherent or themed on **my** first-pass reading of the titles; needs Mateusz's own review | **Provisionally met** |

**Recommendation: go, with a narrower claim.** Build the retrieval, clustering and chain layers. Do **not** ship "expected cost from similar tasks" as a predictive number: the accepted gate says a miss means stop or narrow, and the honest reading is *narrow the promise, not the index* — retrieval clears its own bar with margin and its advantage over BM25 is largest exactly where it matters (precedents from another epic or project). Details in §8; the decision block is §10.

## 1. Corpus (T0.1)

| Stage | Cases |
|---|---|
| Linear issues in teams FOC + JOI (snapshot, incl. archived) | 1 001 (FOC 579, JOI 422) |
| + telemetry tickets since moved to other Linear teams (old `FOC-n` ids) | +35 → 1 036 |
| − automated intake alerts (`[ThoughtMap] …`, project *ThoughtMap Intake*) | −308 |
| − tickets no longer in FOC/JOI (moved or deleted) | −35 |
| − personal-life projects (`PERSONAL`, `personal`) | −40 |
| − runs that happened in personal-finance / tax / hobby working directories | −27 |
| **In scope** | **626** |

Of the 626: **V0 368** (Done in Linear), **V1 126** (V0 + test evidence), **V2 64** (V1 + human `cleanup-approval`/`push-approval` "tak"; supervisor era 28, graph-v2 era 36, none from the standalone era); telemetry effort metrics for 178; ≥ 1 tagged commit for 255. Alternative V2 definitions barely change the count (64 → 64 with review pass instead of test pass).

* **V2 is small.** 64 cases is enough to rank *within* a neighbourhood but thin for anything statistical; every V2 number below carries an interval or an "n".
* **"TEST pass" needs a definition.** Only 13 test-squad verdict records exist (6 tasks with a passing one), but a completed test-squad run exists for 154 tasks. F0 used *either* signal. F1 must decide which is canonical (proposal: completed test run, verdict when present).
* **Human approval is well recorded** for the supervisor era: 261 `cleanup-approval` gates (200 "tak", 22 "yes", 26 "nie", 5 unanswered), 294 gates and 135 verdicts across 91 sessions (`.state/supervisor` reaches back only to 2026-09-17).
* **Git**: 1 289 commits name a FOC/JOI ticket in the subject, in **11 repos** (linear-agents 499, post-fraud-model 240, joint-flows 223, office 71, others 256). The repo allowlist in `config/projects.json` covers only 3 of them; the index needs a real allowlist (R33).
* **Transcripts**: of 2 786 ticket-linked files, 1 821 are on disk, **386 more sit in `.state/transcript-archive-20260910`** (the 2026-09-10 retention archive) and 579 are gone → **79% reachable, not the 65% assumed earlier**. After scope filters: 1 796 file links (1 795 distinct files, 1 145 MB) over 169 tickets, including all 64 V2 tickets.
* **Egress screen** (repo detector, fail-closed): of 648 ticket texts, 2 were blocked outright (an env-style assignment, a JWT shape) and 54 needed masking. Without masking the detector would have dropped **56 (8.6%)** — almost all "high-entropy" hits are long hyphenated slugs and branch names. F1 should ship *mask-and-rescreen*, not skip-on-hit.
* **Scope policy applied by default** (privacy-preserving, all reversible in `common.py`): personal projects and personal-finance/tax/hobby working directories are out. Residual: ~18 in-scope tickets still concern personal finance/tax tooling because they carry no distinguishing project or transcript — F1 needs an explicit ticket denylist.

## 2. Embedding bake-off (T0.2)

12 models through `POST /api/v1/embeddings`, facet `problem` (title + description, ≤ 8 000 chars), 646 texts (embedded before the last scope rule; all analyses use the 619 in-scope cases), ≈ 340k tokens each. Retrieval columns: proxy `any`, time split, 143 queries (§3).

| Model | Dims | $/1M | Run cost | Batch median | Recall@5 capped (dense alone) | Recall@5 capped (hybrid with BM25) |
|---|---|---|---|---|---|---|
| mistralai/codestral-embed-2505 | 1536 | 0.15 | $0.052 | 0.8 s | **0.558** | **0.573** |
| google/gemini-embedding-2 | 3072 | 0.20 | $0.070 | 1.0 s | 0.519 | 0.555 |
| voyageai/voyage-code-4 | 1024 | 0.12 | $0.041 | 0.5 s | 0.479 | 0.542 |
| voyageai/voyage-4-large | 1024 | 0.12 | $0.041 | 0.6 s | 0.473 | 0.535 |
| perplexity/pplx-embed-v1-4b | 2560 | 0.03 | $0.010 | 0.4 s | 0.469 | 0.545 |
| voyageai/voyage-4 | 1024 | 0.06 | $0.021 | 0.6 s | 0.467 | — |
| openai/text-embedding-3-small | 1536 | 0.02 | $0.007 | 1.2 s | 0.450 | — |
| openai/text-embedding-3-large | 3072 | 0.13 | $0.043 | 1.6 s | 0.447 | — |
| google/gemini-embedding-001 | 3072 | 0.15 | $0.052 | 2.1 s | 0.435 | — |
| qwen/qwen3-embedding-4b | 2560 | 0.02 | $0.007 | 5.1 s | 0.430 | — |
| qwen/qwen3-embedding-8b | 4096 | 0.01 | $0.004 | 3.0 s | 0.429 | 0.513 |
| baai/bge-m3 | 1024 | 0.01 | $0.004 | 1.2 s | 0.421 | — |
| *BM25 (baseline)* | | | | | *0.489* | |

* **A public leaderboard is not a guide here.** The strongest general model on MTEB-style rankings (Qwen3-Embedding-8B) is among the weakest on our tickets; the two **code-oriented** models (Codestral Embed, Voyage Code 4) are at or near the top. Tickets are full of identifiers, paths and error strings.
* **Differences inside the top group are not statistically separable** at 143 queries (intervals overlap). Choose on operations, not on the third decimal.
* **Dimensions**: truncating costs little — Gemini-2 3072→768 −0.008, Voyage-4-large 1024→256 −0.018, Voyage-Code-4 1024→256 −0.018, OpenAI-3-large 3072→1024 −0.010 (→256: −0.064), Qwen3-8B 4096→1024 +0.004. Codestral rejects `dimensions`. The corpus is tiny, so storage is irrelevant now (646 × 12 KB = 8 MB at 3072 dims).
* **Instruction prefix** (Qwen3, asymmetric query/document): no gain (0.428 vs 0.429).
* **Latency**: Qwen3 batches take 3–5 s (8 s cold); Voyage/Codestral/Perplexity ≤ 1 s. Ingest must be asynchronous either way.

## 3. Retrieval quality (T0.3)

**Protocol.** Query = a V0 ticket; candidates = V0 cases **closed before the query was created** (time split; nothing sees its future). Ground truth is a **proxy** because no human relevance labels exist: *files* (≥ 2 shared non-hub files, hub = touched by > 10% of cases), *epic* (same Linear parent), *relation* (explicit Linear relation); `any` is their union. A retriever is never scored against a label derived from its own input signal. Only queries with ≥ 1 positive candidate count. Recall@5 is reported **raw** (positives found / all positives) and **capped** (denominator min(P, 5)), because the accepted threshold does not say which one; both clear 0.35 for the best methods. Intervals: percentile bootstrap over queries.

| Setting (queries) | BM25 | best dense alone | best hybrid | Hybrid − BM25 (paired, 95% CI) |
|---|---|---|---|---|
| all pairs, proxy `any` (143) | 0.489 | codestral 0.558 | codestral 0.573 | +0.084 [+0.046, +0.124] |
| **cross-epic** — same-parent candidates removed (101) | 0.389 | gemini-2 0.488 | gemini-2 0.486 | +0.096 [+0.045, +0.152] |
| **cross-project** — same-project candidates removed (83) | 0.387 | voyage-code-4 0.502 | voyage-code-4 0.501 | +0.115 [+0.049, +0.186] |

(capped Recall@5; hybrid = Reciprocal Rank Fusion k = 60 of BM25 and the dense score.)

* **Dense + BM25 hybrid beats BM25 in all three settings for four of six shortlisted models**, and the gain is *largest in the hard cases* (cross-epic and cross-project) — the case the index exists for. Within one epic, plain BM25 is already good (siblings share vocabulary).
* Dense alone is not reliably better than BM25 (Qwen3-8B is significantly worse: −0.060 [−0.118, −0.001]). **Use the hybrid.**
* Baselines: random 0.055, recency 0.313, same-project-recency 0.403 (capped, `any`).
* **Most consistent model across the three settings: `voyageai/voyage-code-4` hybrid** (0.542 / 0.478 / 0.501, every paired interval above zero), also cheap and fast, 32k context. Gemini-Embedding-2, Codestral Embed and Perplexity-4B hybrids are statistically indistinguishable.
* **Caveat.** Positives are proxies. A precedent can be genuinely relevant without shared files, and sibling tickets inflate every method. The right next measurement is a small human-labelled set (F1 collects it through the `##PRECEDENT` markers).

## 4. Effort prediction and the efficiency ranking (T0.4)

**Prediction (cost, LLM turns, active minutes) from the k = 7 most similar *earlier* closed cases** vs global / per-type / per-estimate / per-project medians and the median of the 10 most recently closed cases; 129–135 settled queries.

* **Cost**: kNN MAPE 3.5–5.2 across models vs 4.19 for the per-type median (MdAPE 0.8–0.9 for every predictor: the typical error is ~80%). Median improvement over the type median **−0.9%**; 2 of 12 models reach +15%, all intervals span zero. In log-error the neighbour predictor is 1% better than the recent-10 median, 3% better than the global median and 4% better than the type median — negligible. **LLM turns and active minutes: kNN is *worse* than the global median in log-error** (0.80 vs 0.76, 0.82 vs 0.77).
* The direct cost of a settled task fell ~16× across the three eras (median $4.36 → $0.26; routing and model mix), so a task's *era* explains more than its topic; recent-window or time-decayed neighbours do not fix it.
* **Conclusion: neighbours do not carry usable effort information here.** Use them for "how was it solved", not for "what will it cost".

**Efficiency ranking of the 64 V2 cases** (residual against neighbour expectation, weights from D9):

* Stable under weight perturbation: ±0.15 on every weight → Spearman ρ median **0.985** (5th pct 0.962), top-10 overlap median 0.9 (5th pct 0.7).
* **Not stable under the meaning of "turns"** (the open question from D9): LLM-turns-only vs default ρ = 0.87 (top-10 overlap 0.5); active-time-only ρ = 0.82 (0.9); cost-only ρ = 0.63; **child-turns-only ρ = 0.30 (top-10 overlap 0.1)** and rounds-only ρ = 0.34. A "fastest" list built on supervisor child turns or review rounds is nearly unrelated to one built on model calls. The card must state which it ranks by.
* Sanity of the top-10: small fixes and documentation tasks (estimates 1–3) plus a few mid-size tasks that are efficient relative to neighbours; efficiency correlates −0.69 with raw cost, so cheap tasks still dominate. Because neighbour expectations are weak (above), the residual is mostly the raw effort — **rank within the retrieved neighbourhood by era-aware raw effort, and show n**.

## 5. Clustering (T0.5)

619 in-scope `problem` embeddings (voyage-code-4), PCA-50 for HDBSCAN.

| Method | Clusters (≥ 3 members) | Noise | Silhouette | Stability (ARI, 15 × 80% subsamples) | NMI vs project / epic |
|---|---|---|---|---|---|
| **HDBSCAN, min size 3** | **45** | 45% | 0.21 | **0.86** | 0.58 / **0.76** |
| HDBSCAN, min size 8 | 8 | 59% | 0.21 | 0.89 | 0.69 / 0.64 |
| Agglomerative (average, cosine ≤ 0.45) | 64 (341 total, mostly singletons) | 0% | 0.15 | 0.90 | 0.50 / 0.75 |
| kNN graph + Louvain (k 8, res. 1.0) | 9 (median size 79) | 0% | 0.09 | 0.73 | 0.49 / 0.52 |

* **HDBSCAN gives the best-defined and stable clusters** but leaves ~45% of tickets unassigned — consistent with "assign online to pinned centroids or say unassigned". Louvain covers everything but as ~10 coarse areas with weak separation (also the only pure-JS option: it is a fallback, not the choice). This supports D13 (Python sidecar).
* **Provisional coherence review** (`cluster-review.md`, titles only, my reading): most clusters are one topic; a handful are themed groupings (UI debt, Linear integrations, Fenix meta-planning); none is junk. **Caveat that matters:** many clusters are *decompositions of one epic* (NMI vs epic 0.76), so coherence is partly "siblings look alike". A minority are genuine cross-epic problem families — test-harness hardening, telemetry ingest bugs, supervisor spawn/cleanup bugs, MCP error scrubbing, CodeGraph measurement — which is what playbooks (brainstorm B) want.
* Cluster identity will drift between runs (ARI 0.86), so L2 pinning and naming (D2) is required, as designed.

## 6. Jev pilot (T0.6)

100 requests (24 relevance queries × 5 candidates = 120 pairs; 76 problem-type items), 196 decisions, all succeeded; **median 0.31 s per request, $0.0058 in total** (`typesafe/jev-1.13-20260917`). Laya is not part of F0 (D12).

* **Relevance (`noul`)**: AUROC vs the proxy 0.70 (dense 0.68, hybrid 0.67, BM25 0.58). Re-ranking the retriever's top-5: Hit@1 0.415 → 0.537 (Jev) → 0.580 (Jev + hybrid), MRR 0.653 → 0.732 → 0.754 — a plausible gain but **not significant at 24 queries** (Hit@1 intervals 0.21–0.63 vs 0.33–0.75). P(true) is only weakly calibrated (positive rate 0.31 / 0.54 / 0.62 / 0.50 across four bins). **Keep it an A0 annotation, not a filter.**
* **`problem_type` (`choice`, 5 classes)**: accuracy **0.63** (macro-F1 0.60) vs 0.50 for a leave-one-out kNN vote and 0.33 for the majority class, against the user's own Linear labels (noisy). bug / feature / spike are recognised well (13/16, 15/16, 10/12); `chore` is not (2/16). The more-confident half is right 72% of the time vs 54% for the less-confident half, so the native confidence is usable as a threshold.
* `step_kind` was not piloted (needs F2 steps); the labels Jev produces here are saved for later distillation (D12).

## 7. Chains (T0.7)

Deterministic segmentation of **all 1 789 parseable allowlisted transcripts** in 9 s (0 empty/negative-duration/tiling errors; 6 files without assistant steps): **67 400 steps → 11 128 episodes**.

* 60% of steps carry thinking text (non-Claude models), 95% carry tool calls, 3.7% end in an error. Median 20 steps per file, 3 episodes per file, 3 steps per episode. Subagent files (`agent-*.jsonl`) mark every record as sidechain — the parser must not skip them.
* Episode kinds: orient 2 702, reason 1 724 (no tool call), implement 1 510, investigate 1 351, coordinate 1 199, verify 816, reproduce 660, other 828 (7%), **recover 338**. Of the recover episodes, **181 (54%) end resolved** by a clean test/run within 8 steps, 8 stuck (same error ≥ 3×), 149 open; 28 strict *error → edit → same command passes* patterns.
* **Error-signature recall** (normalised first error line; 979 distinct): **46.5%** of signature occurrences recur in a later transcript; excluding the 2 generic ones, **27%** of the recurring cases have an earlier *resolved* recover episode with the same signature — i.e. roughly one later error in four could already carry a known fix by exact match alone. Semantic matching of *different-looking* signatures was not measured.
* Manual sanity of six resolved recover episodes: plausible trajectories (a GraphQL "labelIds not exclusive child labels" error → issue lookups and a code search → retry; a denied `git push` → settings/branch inspection → PR path). The `resolved` label is a heuristic (a later clean run), so F2's agreement target (≥ 70% with manual judgement) is a real test, not a formality.
* Cost: parsing is cheap and local; only the *embedding* of step summaries would cost money (thinking text is on the order of 50M tokens on disk).

## 8. What this changes in the design

| Area | Change | Where |
|---|---|---|
| Retrieval | Always **hybrid** (FTS5/BM25 + dense, RRF). Pin **`voyageai/voyage-code-4`** (default), keep Gemini-Embedding-2 and Perplexity-4B as alternates; re-run the bake-off in F1 on a larger corpus. Store 1024 dims (256 acceptable) | R7, R11 |
| Cards | **Drop "expected cost from neighbours"** as a predictive claim. Show observed effort of the most similar cases with n and an interval, labelled descriptive. `intake.task_size` neighbours become an annotation, not an estimator | R15, R17, R29 |
| Efficiency | Rank inside the retrieved neighbourhood by **era-aware raw effort**; no neighbour-expected normalisation until it beats the baselines. **State the meaning of "turn"** on every ranking; show LLM turns, child turns and rounds as separate columns | R17, R18, D9 |
| Quality gates | V2 has only 64 cases: use V1/V0 for candidate retrieval and V2 as the *flag* "human-approved". Define TEST pass as *completed test run* (verdict when present) | R2 |
| Egress | **Mask-and-rescreen** high-entropy runs, block every other family (implemented in `tools/precedent-spike/egress.mjs`); log counts | R6 |
| Scope | Real repo allowlist (11 repos, not 3), path/workdir denylist, ticket denylist, project exclusions (`config/precedent.json`) | R1, R33 |
| Transcripts | Read the **2026-09-10 archive** as a source (recovers 14 points of coverage); the archive is the only reason the chain layer is 79% reachable | R9 |
| Clustering | HDBSCAN in the Python sidecar, assign online with an "unassigned" outcome; Louvain only as a coarse fallback | R22, D13 |
| Chains | Segmentation ports cleanly (9 s for the corpus). Add a `reason` episode kind, treat `echo/pwd/cd` as explore, keep subagent files, and validate `resolved` against a labelled sample before trusting it | R19–R21 |
| Jev | Rerank stays A0; `problem_type` tagging is usable with a confidence threshold; collect labels for the Path-B student | R13, R23 |

## 9. Limitations and threats to validity

* **Proxy labels** (files / epic / relation) instead of human relevance; sibling tickets inflate all methods. No claim of absolute precision is made — only comparisons on the same proxies.
* **Small n**: 143 / 101 / 83 queries, 64 V2 cases, 24 Jev queries. Intervals are given; several rankings inside the top group are not separable.
* **Model selection on the test set**: choosing "the best of 12" on these queries is optimistic. The recommendation rests on *consistency across settings* and operations, and the effort-prediction verdict deliberately uses the median over all 12 models.
* **Single snapshot** (2026-09-29); costs are estimates from token counts, eras are a decision (`docs/TELEMETRY-EXPLAINED.md`), and effort mixes model eras.
* **Scope defaults are mine** (personal projects, workdir denylist, intake alerts). They are conservative and reversible but change the corpus (−410 cases).
* **Cluster coherence** was read by the author of the spike, from titles only.
* **Chains**: outcome labels are heuristic; native Claude thoughts are redacted, so about 40% of steps have no thought text; exact-signature recall only.
* Jev is an **alpha endpoint** (shape changed once); the pilot used the pinned `typesafe/jev-1.13`.

## 10. Decision (T0.8) — for Mateusz

Pick one; F1 does not start before this is recorded.

- [ ] **Go, narrowed (recommended)** — build F1–F3 with the changes in §8 (hybrid retrieval, no predictive cost claim, explicit "turn" definition); ADR-0014 amended accordingly.
- [ ] **Go as specified** — keep neighbour-expected efficiency and the cost-calibration claim in the PRD (against the evidence in §4).
- [ ] **Narrow to structural** — file → cases index only, no vectors (the D14 fallback).
- [ ] **Stop.**

Also to confirm: (a) the meaning of "turns" for the ranking (LLM turns, child turns, rounds — §4 shows they disagree); (b) the default scope exclusions in §1; (c) who reviews the cluster sheet (`.spike-precedent/cluster-review.md`, local) for criterion 3.

## Reproduce

```bash
node tools/precedent-spike/fetch-linear.mjs && python tools/precedent-spike/corpus.py && python tools/precedent-spike/texts.py
bash tools/precedent-spike/bakeoff.sh && bash tools/precedent-spike/bakeoff2.sh
python tools/precedent-spike/t03_retrieval.py && python tools/precedent-spike/t03b_paired.py && python tools/precedent-spike/t04_predict.py
python tools/precedent-spike/t04b_variants.py && python tools/precedent-spike/t02_variants.py && python tools/precedent-spike/t05_cluster.py --model voyageai/voyage-code-4
python tools/precedent-spike/chains.py
```

Data and vectors stay in `.spike-precedent/` (git-ignored). Numbers in this file come from the runs of 2026-09-29; the tools are deterministic given the same snapshot (bootstrap seeds fixed at 7), while OpenRouter models and Jev builds may change.
