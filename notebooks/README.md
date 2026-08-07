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

```bash
python notebooks/agent_intelligence.py --squad dev --days 30
```

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
| Fleet Overview | `usage_facts` + `cost_facts` | KPI cards |
| Squad Breakdown | `usage_facts` + `runs` | Aggregated by squad |
| Agent Breakdown | `usage_facts` | Aggregated by agent_key |
| Tool Calls | `tool_facts` | Canonical + raw names; empty if table not populated yet |
| Delegation Handovers | `delegation_links` | Graph + per-delegation sample; empty if table not populated yet |
| Task Linkage | `run_task_links` + `runs` + `usage_facts` | Per-task cost/tokens/runs |
| N-grams | Transcript JSONL files | Top 20 1-2-grams per agent; cached in `.ngrams-cache.pkl` |
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
