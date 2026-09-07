# Agent Intelligence — Python analysis pipeline

CLI tool that reads telemetry data from the local SQLite database (`telemetry.sqlite`),
aggregates usage and cost per agent and per squad, and produces a self-contained
interactive HTML report with filtering and drill-down.

## Install

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# POSIX (Linux / macOS / WSL):
source .venv/bin/activate
pip install -r requirements.txt
```

> **Note:** `sentence-transformers` downloads a ~400 MB model on first use
> (cached in `~/.cache/huggingface/`; total disk footprint ~2 GB).

## Run

The report reads the **canonical views**, not the raw fact tables. Create them
once (they are cheap to recreate, and re-running is safe):

```bash
node scripts/telemetry-canonical.mjs --ensure
python notebooks/agent_intelligence.py --squad dev --days 30
```

Without the views the report refuses to run rather than falling back. That is
deliberate: `usage_facts` is run-scoped (ADR-0008), so several runs sharing a
transcript each hold a copy of the same call, and every total taken from the
raw table is inflated — measured at 14,4% of rows and roughly 2x on cost. A
report that is quietly twice too big is worse than one that will not start.

> `--days` defaults to 30. The fleet has ~72 days of history, so use
> `--days 90` for a full picture.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--db PATH` | auto-detect | Path to `telemetry.sqlite` |
| `--squad NAME` | (all) | Filter to one squad |
| `--agent NAME` | (all) | Filter to one agent key |
| `--days N` | 30 | Lookback window |
| `--out PATH` | `./report` | Output directory |
| `--skip-ngrams` | off | Skip n-gram analysis (faster, avoids reading transcripts) |
| `--skip-embeddings` | off | Skip embedding/clustering (faster, avoids model download) |

## Output

- **`report/index.html`** — self-contained interactive HTML report with:
  - Fleet Overview (KPI cards: cost, tokens, runs, agents, tool calls, delegations)
  - Squad Breakdown table
  - Agent Breakdown table
  - Tool Calls (canonical + raw unmatched)
  - Delegation Handovers (aggregated + per-delegation sample)
  - Task Linkage (Linear tasks connected to runs)
  - NLP Analysis (top 20 1-2-grams per agent from transcripts)
  - Embedding Clusters (HDBSCAN clusters of assistant text, if `sentence-transformers` installed)
  - Interactive filters: squad, agent, model, date range
- **`report/data.json`** — raw data consumable by other tools

## Report sections

| Section | Data source | Notes |
|---------|-------------|-------|
| Fleet Overview | `canonical_usage` | KPI cards; cost counts each call once |
| Squad Breakdown | `canonical_usage` + `runs` | Aggregated by squad |
| Agent Breakdown | `canonical_usage` | Aggregated by agent_key |
| Tool Calls | `canonical_tool_facts` | **Full aggregate**, not a sample, with error counts per tool |
| Delegation Handovers | `delegation_links` | Graph + per-delegation sample; `child_cost_usd` is NULL for every row today |
| Task Linkage | `run_task_links` + `runs` + `usage_facts` | Per-task cost/tokens/runs |
| N-grams | Transcript JSONL files | Top 20 1-2-grams per agent, from **that agent's own** transcript; cached in `.ngrams-cache.pkl` |

Two columns carry the honesty of the numbers and are worth reading before
drawing conclusions:

- **`attribution`** (`in_window` / `after_end` / `before_start`) — how confident
  the run attribution is. Filter to `in_window` when a claim needs to be solid.
- **cost `null`** — the model was missing from the price snapshot. It means
  *unknown*, never $0.00; ~3 200 rows are in this state.
| Embedding Clusters | Transcript assistant text | HDBSCAN; requires `sentence-transformers` + `hdbscan` + `scikit-learn` |

## Caching

N-gram results are cached in `report/.ngrams-cache.pkl` keyed on filter parameters
and a hash of transcript file mtimes. Delete this file to force a full re-compute.

## If you hit `ModuleNotFoundError: agent_intelligence`

The notebook needs `notebooks/` on the Python path. Either:

- Run the notebook from the repo root (not from inside `notebooks/`), or
- Add the path explicitly:
  ```python
  import sys
  sys.path.insert(0, "notebooks")
  from agent_intelligence import load_usage_facts
  ```
