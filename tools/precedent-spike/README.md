# Precedent index — F0 evidence spike

Offline, read-only experiments that decide whether the precedent index (PRD `docs/prd/prd-precedent-index.md`,
ADR-0014) is worth building. **Results and the go/no-go table: [docs/benchmark/precedent-index-spike.md](../../docs/benchmark/precedent-index-spike.md).**
Nothing here writes to telemetry, Linear or any repository. Data lands in `.spike-precedent/` (git-ignored by the
repo's `.spike-*/` rule) and contains ticket text and derived vectors — never commit it.

## Pipeline (run from the repo root)

| Step | Command | Output |
|---|---|---|
| Snapshot Linear (FOC + JOI, read-only) | `node tools/precedent-spike/fetch-linear.mjs` | `linear.jsonl` |
| T0.1 corpus (telemetry + Linear + git + `.state` + transcripts) | `python tools/precedent-spike/corpus.py [--reuse-git]` | `corpus.jsonl`, `git_commits.jsonl`, `transcripts.jsonl`, `corpus-summary.json` |
| Texts to embed | `python tools/precedent-spike/texts.py` | `texts.jsonl` |
| T0.2 bake-off (12 models, 4 in parallel) | `bash tools/precedent-spike/bakeoff.sh` then `bakeoff2.sh` (dimension / prefix variants) | `vec/*.f32` + `vec/*.json` |
| T0.2 variants | `python tools/precedent-spike/t02_variants.py` | `results/t02_variants.md` |
| T0.3 retrieval, time split | `python tools/precedent-spike/t03_retrieval.py`, `t03b_paired.py` | `results/t03*.md` |
| T0.4 prediction and ranking stability | `python tools/precedent-spike/t04_predict.py`, `t04b_variants.py` | `results/t04*.md` |
| T0.5 clustering | `python tools/precedent-spike/t05_cluster.py --model voyageai/voyage-code-4 --review-config hdbscan_mcs3` | `results/t05_cluster.md`, `cluster-review.md` |
| T0.6 Jev pilot | `python t06_prepare.py`, `node jev_pilot.mjs`, `python t06_score.py` (all in this folder) | `results/t06_jev.md` |
| T0.7 chains | `python tools/precedent-spike/chains.py [--sample 50]` | `chains/summary.json`, `episodes.jsonl` |

`python` = an interpreter with `requirements.txt` installed. The spike was run in the analysis project's venv
(`C:\Users\mateu\Desktop\experiments\telemetry analysis\.venv`); `common.py` imports that project's `fenix` package for the
canonical telemetry tables (parquet cache, override with `FENIX_ANALYSIS_DIR`). Refresh that cache first if the telemetry moved on.

## Safety properties

* **Egress**: every string sent to OpenRouter (embeddings, Jev) goes through `egress.mjs` → `scripts/egress-screen.mjs`.
  A non-high-entropy hit (key prefix, PEM, env assignment, JWT) blocks the item; a high-entropy run (usually a long slug or
  branch name) is replaced by `<token>` and the text is re-screened. A flagged span is never sent. Tool results are never sent.
* **Scope policy** (`common.py`): FOC/JOI tickets still in those teams, minus automated intake alerts, personal-life projects
  (`PERSONAL`, `personal`) and tickets whose runs happened in personal-finance / tax / hobby working directories. Transcripts are
  used only from allowlisted repos (and their `la-wt-*` worktrees). Change the constants to widen or narrow it.
* **Cost**: the whole spike spent about $0.60 on embeddings and $0.006 on Jev.
* **API key**: read from `.env` inside the scripts, never printed.

## Files

`fetch-linear.mjs` · `corpus.py` · `texts.py` · `embed.mjs` + `egress.mjs` · `pi_eval.py` (shared metrics: time split, proxy labels,
BM25, RRF) · `t02_variants.py` · `t03_retrieval.py` · `t03b_paired.py` · `t04_predict.py` · `t04b_variants.py` · `t05_cluster.py` ·
`t06_prepare.py` · `jev_pilot.mjs` · `t06_score.py` · `chains.py` · `bakeoff*.sh`
