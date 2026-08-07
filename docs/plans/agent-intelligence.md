# Agent Intelligence — PRD

> Status: Draft v2 — approved by user, integration in progress
> Owner: Mateusz (with assistant as planner/delegator)
> Horizon: 1–2 weeks

**User decisions baked into this version:**
- Q1: Transcript archiving deferred to Phase 2 (retention-check first)
- Q2: Embeddings stored as SQLite BLOB
- Q3: Test-fixture filter = `runs.native = 0` + configurable name pattern
- Q4: Report is a **directory** (not single file) — `report/index.html` + `data.json` + assets
- Q5: Delegation-link reconstruction from tool_use stream first; sidechain expected-vs-actual in Phase 2
- R2: Heuristics A-D are **exploratory signals** for drill-down, not a ranked "top-5 miss" output
- R3: Heuristic D (subagent absence) is a metric shown for exploration, no flagging threshold until validated on data

## 1. Problem

- Agents pick the wrong tool for the job — `Bash` for file reads, `Read` for directory listing, or a tool the squad playbook already bans. No one knows how often this happens because tool calls are extracted but never normalized or counted (see `ledger.mjs:1078-1091` — `contentToolUses()` captures name + truncated input, no normalization, no results).
- Agents do work themselves that a subagent should do — the lead writes 200 lines of analysis inline instead of delegating to a role whose entire purpose is that analysis. The delegation-outcomes script (`delegation-outcomes.mjs`) can tell you a review bounced, but cannot tell you *which role caused the return* or whether delegation would have prevented it.
- Prompt authors (Mateusz editing `agents/<squad>/agents/*.md`) have no data-driven feedback loop. They edit prompts based on intuition and one-off observations, not on aggregate patterns across 200+ runs. The prompt library (`prompt-library.mjs`) resolves refs at the file level only — no paragraph-level traceability.
- Transcripts are the richest source of natural-language behavior data, but they are auto-cleaned by Claude Code. When a transcript is gone, the NL text and tool-call sequences are lost forever, while token counts survive in SQLite. No one monitors this gap.
- Cost is tracked precisely (29k records, 0 discrepancy — see `docs/decisions/telemetry-data-audit-2026-08-03.md`), but quality is tracked nowhere except the review-round counter. The north-star goal — increase quality AND decrease cost — has no measurement baseline for the "quality" half.

## 2. Goals & Non-goals

**Goals (measurable):**
1. A single CLI command produces a self-contained HTML report showing, per squad and per agent: top tool-call patterns, top n-grams in agent text, delegation-rate proxy, and cost-per-pattern.
2. The report includes interactive drill-down: filter by squad, agent, date range, and run; click a pattern to see the source turns that produced it.
3. A per-squad "prompt edit checklist" markdown file is generated from each report run, listing concrete prompt changes ranked by estimated impact on quality and cost.
4. A retention-check script (`scripts/check-transcript-retention.mjs`) runs in <5 seconds and reports the percentage of usage_facts rows whose source transcript still exists on disk.

**Non-goals (explicit cuts):**
- No LLM-as-judge essays in this phase. The C→A path means we ship the notebook + report pipeline first; LLM commentary is Phase 3.
- No real-time monitoring or alerting. Reports are generated on demand, not streamed.
- No automatic prompt editing. The output is a checklist for a human to apply, not a patch.
- No paragraph-level prompt ref resolution. File-level is the current ceiling; paragraph-level is a separate project.
- No agent-behavior enforcement at runtime. This is an analysis layer, not a guardrail.

## 3. Personas

**Researcher Mateusz** — explores the data to understand *what is actually happening*. Opens the HTML report, filters to a specific squad, drills into a run where the lead wrote 300 lines of code itself, and asks: "was this a delegation miss or was it justified?" Wants to see the raw turns that produced the pattern, not just aggregate numbers.

**Prompt Author Mateusz** — reads the per-squad checklist, picks the top item ("add 'prefer Grep over Bash for content search' to implementer.md"), edits the file, and runs the next squad to see if the pattern shifts. Wants the checklist to be concrete ("change line X in file Y to say Z") not abstract ("improve tool selection").

## 4. User Stories

1. **AS A** Researcher Mateusz **I WANT** to see the top 20 tool calls made by each agent, normalized to canonical names, with frequency and cost **SO THAT** I can identify which tools are overused, underused, or misused across the fleet.

2. **AS A** Researcher Mateusz **I WANT** to filter the report by squad, agent, date range, and individual run **SO THAT** I can isolate whether a pattern is fleet-wide or specific to one squad's configuration.

3. **AS A** Researcher Mateusz **I WANT** to see a "delegation score" per run — what percentage of work (lines written, tool calls, tokens) stayed on the lead vs. went to subagents **SO THAT** I can spot runs where the lead hoarded work and investigate why.

4. **AS A** Prompt Author Mateusz **I WANT** a per-squad checklist of concrete prompt edits, ranked by estimated impact, generated from the report data **SO THAT** I can improve agent instructions without manually cross-referencing 5 files and 200 runs.

5. **AS A** Prompt Author Mateusz **I WANT** to click a tool-call pattern in the report and see the exact turns (NL text + tool_use) that produced it **SO THAT** I can read the agent's reasoning at the moment it made the wrong choice and write a better prompt.

6. **AS A** Researcher Mateusz **I WANT** a retention-check script that tells me what percentage of my telemetry data still has live transcripts **SO THAT** I know whether my NL analysis is working with 90% of the data or 30%.

## 5. Success Criteria

1. **Rich exploratory view in <10 minutes.** User opens the HTML report, filters by squad + agent + date range, and can independently filter/sort by delegation-score and review-bounce count. Both metrics are exploratory signals — the report does **not** auto-rank "top missed delegations." The user decides what to investigate, drills into source turns, and forms their own hypothesis. The view supports comparison across runs to spot patterns the user names, not patterns the system asserts.
2. **Prompt-edit checklist from a single report run in <30 minutes.** User runs `python notebooks/agent-intelligence.py --squad dev`, opens the generated `agents/dev/memory/intelligence-checklist.md`, and has a ranked list of concrete edits ready to apply.
3. **Retention-check completes in <5 seconds** and produces a single-line summary ("72% of last-30-days usage_facts have live transcripts — WARNING: below 70% threshold") plus a per-run breakdown.
4. **Tool-call normalization covers >95% of all tool_use events.** The normalization map (Section 10) resolves the top-15 canonical tools; everything else buckets into `other_*` categories. The report shows the coverage percentage.
5. **Zero new runtime dependencies for the Node ingest path.** The Python analysis side adds dependencies (pandas, scikit-learn, sentence-transformers, hdbscan), but the Node ingest that writes `tool_facts` and `delegation_links` uses only `node:sqlite` — already available.

## 6. Architecture

```
                    ┌──────────────────────────┐
                    │   Claude Code transcripts │
                    │   .jsonl (lead + subagents)│
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Node ingest              │
                    │  telemetry-ingest.mjs     │
                    │  + NEW: tool extraction   │
                    │  + NEW: delegation link    │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │        SQLite             │
                    │  telemetry.sqlite         │
                    │  + tool_facts (NEW)       │
                    │  + delegation_links (NEW) │
                    │  + usage_facts (existing) │
                    │  + cost_facts (existing)  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Python notebook/CLI       │
                    │  notebooks/                │
                    │  agent-intelligence.py     │
                    │  ├─ sqlite3 read           │
                    │  ├─ pandas aggregation     │
                    │  ├─ sentence-transformers  │
                    │  │  + HDBSCAN clustering   │
                    │  ├─ n-gram / frequency      │
                    │  └─ HTML report generation │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Output artifacts          │
                    │  ├─ report.html (drill-down)│
                    │  ├─ checklist.md (per-squad)│
                    │  └─ notebook.ipynb (template)│
                    └──────────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Human feedback loop       │
                    │  Edit agents/<s>/agents/*.md│
                    │  Re-run squad → observe   │
                    │  shift in next report      │
                    └──────────────────────────┘
```

The Node side stays thin: it extracts structured facts from transcripts and writes them to SQLite. Python owns all analysis and rendering. The boundary is the SQLite file — both sides read/write it, but only Node writes `tool_facts` and `delegation_links`; only Python reads them for analysis.

## 7. Data Model

### 7.1 `tool_facts`

One row per tool invocation extracted from a transcript message. Written during ingest (or backfill), not queried at runtime.

```sql
CREATE TABLE IF NOT EXISTS tool_facts (
    tool_fact_id   TEXT PRIMARY KEY,                  -- hash(source_path, source_offset, tool_index)
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    agent_key      TEXT NOT NULL,                     -- 'lead' | 'implementer' | 'first-pass' | ...
    model          TEXT,                               -- model used for this turn (from usage_facts)
    observed_at    TEXT,                               -- timestamp from the transcript line
    tool_name_raw  TEXT NOT NULL,                      -- original name from JSONL (e.g. 'mcp__atlas__read')
    tool_name_canon TEXT,                              -- normalized name (e.g. 'mcp_read') — NULL until normalization pass
    tool_input     TEXT,                               -- JSON input, truncated to 1000 chars
    tool_has_error INTEGER NOT NULL DEFAULT 0,         -- 1 if the next assistant message contains 'error' or 'is_error'
    turn_index    INTEGER NOT NULL,                    -- 0-based turn within the agent's transcript
    source_path   TEXT NOT NULL,                       -- transcript .jsonl path
    source_offset INTEGER NOT NULL,                    -- byte offset in transcript
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_facts_run ON tool_facts(run_id, agent_key);
CREATE INDEX IF NOT EXISTS idx_tool_facts_canon ON tool_facts(tool_name_canon);
```

**Design choices:**
- `tool_name_raw` and `tool_name_canon` are separate columns so normalization can be backfilled without re-parsing transcripts.
- `tool_has_error` is a cheap heuristic (grep the next assistant message for error markers) — not a semantic judgment.
- `turn_index` enables reconstruction of tool-call sequences within a turn (e.g., "agent called Read then Bash then Read").
- `tool_input` is truncated to 1000 chars (vs. 300 in `contentToolUses()`) because tool inputs carry the *intent* — e.g., the regex in a Grep call tells you what the agent was looking for.

### 7.2 `delegation_links`

One row per subagent spawned during a run. Reconstructed from subagent transcript paths + the `agent_key` of the spawner.

```sql
CREATE TABLE IF NOT EXISTS delegation_links (
    delegation_id   TEXT PRIMARY KEY,                  -- hash(parent_run_id, parent_agent, child_agent, observed_at)
    parent_run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    parent_agent    TEXT NOT NULL,                      -- 'lead' | 'implementer' (the spawner)
    child_agent     TEXT NOT NULL,                      -- 'first-pass' | 'deep' | 'security' | ...
    child_model     TEXT,                               -- model used by the child (from its usage_facts)
    child_transcript TEXT,                              -- path to child's .jsonl transcript
    observed_at     TEXT,                               -- timestamp of the spawn event
    child_tokens    INTEGER,                            -- total tokens consumed by child (sum of usage_facts for child_agent in this run)
    child_cost_usd  REAL,                               -- total cost of child (sum of cost_facts)
    child_turns     INTEGER,                            -- number of assistant turns in child transcript
    source          TEXT NOT NULL,                      -- 'transcript' | 'sidechain' | 'heuristic'
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_links_parent ON delegation_links(parent_run_id, parent_agent);
CREATE INDEX IF NOT EXISTS idx_delegation_links_child ON delegation_links(child_agent);
```

**Design choices:**
- `child_tokens` and `child_cost_usd` are denormalized summaries — they avoid a JOIN through `usage_facts` for every delegation query.
- `source` tracks how the link was discovered: `transcript` = found in the lead's tool_use stream (spawn event), `sidechain` = found via subagent directory scan, `heuristic` = inferred from agent_key patterns.
- `child_transcript` is a path, not a foreign key to `transcript_sources`, because subagent transcripts are not always registered there.
- Delegation links are reconstructed at ingest time by scanning `subagentPaths()` (see `telemetry-ingest.mjs:111-125`) and matching child agent_keys to the parent run.

## 8. Pipeline Stages

### Stage 1: Ingest (Node — extends existing `telemetry-ingest.mjs`)

Extract `tool_facts` and `delegation_links` during transcript ingest. The existing `contentToolUses()` in `ledger.mjs:1078-1091` already extracts tool names and inputs — this stage adds normalization (Stage 1b) and persistence. Backfill path: a one-shot script that re-processes all `transcript_sources` rows where `parse_status = 'parsed'` and the transcript still exists.

### Stage 2: Enrich (Python — `notebooks/agent-intelligence.py`)

For each `tool_fact` row, compute:
- `tool_name_canon` via the normalization map (Section 10) — applied as a SQL UPDATE, not recomputed per query.
- Embedding vector (384-dim via `all-MiniLM-L6-v2`) of the concatenated `tool_input` + surrounding NL text from the same turn. Stored in a new `tool_embeddings` table (or a parquet sidecar — decision deferred to implementation; SQLite BLOB is simpler for a single-file artifact).
- N-gram frequencies (1–3 grams) on the NL text per agent per run, stored in a `text_ngrams` table for the frequency view.

### Stage 3: Analyze (Python — 3-layer NLP)

**Layer 1 — Frequencies (always runs):**
- Top-N tool calls per agent/squad/fleet, normalized.
- Top-N n-grams in agent NL text (exclude stopwords, keep 1–3 grams).
- Delegation rate: `SUM(child_tokens) / SUM(total_tokens)` per run, per squad.
- Cost-per-tool: `SUM(cost_facts.cost_usd) GROUP BY tool_name_canon`.
- Sentiment-lite: ratio of negative-to-positive words in agent text (simple lexicon, not a model).

**Layer 2 — Embeddings + clustering (configurable on/off):**
- Cluster tool-call sequences (turn-level) using embeddings of `[tool_name_canon, tool_input]` → HDBSCAN.
- Cluster NL text by agent role using sentence-transformers → HDBSCAN. Label clusters with top TF-IDF terms.
- Output: "Cluster 3 (implementer, 47 occurrences): 'reading file, checking imports, validating schema' — cost $12.40 total."

**Layer 3 — LLM-as-judge (deferred to Phase 3):**
- Stubbed in the report as a placeholder section: "LLM commentary — coming in Phase 3."
- When built: feed top clusters + representative turns to a cheap model (Haiku) for a 3-sentence essay per cluster.

### Stage 4: Report (Python → HTML)

Single `report.html` file with:
- **Fleet overview:** total runs, total cost, delegation rate, top-5 tools fleet-wide.
- **Squad/agent switcher:** dropdown or tab bar to filter.
- **Time-scope switcher:** single run / last N runs / date range / all.
- **Tool-call panel:** bar chart of top-20 canonical tools, clickable — clicking a bar filters the turn-log panel below.
- **Delegation panel:** scatter plot (delegation rate vs. cost, one point per run), with a table of low-delegation runs.
- **N-gram panel:** word cloud or ranked list of top n-grams per agent.
- **Turn-log panel:** when a pattern is clicked, show the source turns (NL text + tool_use) that produced it. Pulled from `tool_facts` + `usage_facts`, not from live transcript reads (transcripts may be gone).
- **Cluster panel (Layer 2):** cluster labels + sizes + representative turns.
- **Checklist export button:** generates the per-squad checklist markdown.

All charts use the project's existing dataviz conventions (see `docs/ui/prompt-library.md` for the UI style). The HTML is self-contained (inline CSS/JS, no CDN) so it can be opened from disk or shared.

### Stage 5: Feedback (Human)

The per-squad checklist (`agents/<squad>/memory/intelligence-checklist.md`) contains:
1. **Top-3 tool-selection issues:** "Agent X used Bash for file reads 47 times. Add to agent X's prompt: 'Prefer Read over Bash for reading files.'"
2. **Top-3 delegation misses:** "Run Y: lead wrote 340 lines of analysis. Squad has a 'deep' reviewer role. Consider adding: 'If analysis exceeds 30 lines, delegate to deep-review.'"
3. **Top-3 cost anomalies:** "Agent Z used Opus for 12 turns of file reading. Consider model-tier constraint."
4. **Link back to the report:** "See report.html?filter=squad:dev&run=Y for source turns."

The human edits the prompt files, re-runs the squad, and the next report shows the shift.

## 9. Artifacts

**a. Interactive HTML report (`report.html`):** Self-contained, no server required. Drill-down from fleet → squad → agent → run → turn. All data embedded as JSON in a `<script>` tag (for reports up to ~50 MB of raw data; larger reports use a sidecar JSON file). The report is the primary artifact — everything else supports it.

**b. Notebook template (`notebooks/agent-intelligence-template.ipynb`):** A Jupyter notebook that reproduces the analysis pipeline step by step, with markdown explanations between cells. Serves as documentation and as a starting point for ad-hoc queries that the HTML report does not cover.

**c. Per-squad prompt edit checklist (`agents/<squad>/memory/intelligence-checklist.md`):** Generated by the report pipeline, checked into git alongside the prompt files it references. Each run overwrites the previous checklist for that squad. The file is short (<60 lines) and ranked by estimated impact.

## 10. Tool-Call Normalization

The normalization map resolves the chaos of tool names across Claude Code versions, MCP servers, and custom tools. The map is a JSON file (`config/tool-norm.json`) that the ingest step reads. Proposal for the top-15 canonical tools:

```json
{
  "read_file":      ["Read", "read_file", "ReadFile", "fs.readFile", "mcp__atlas__read"],
  "write_file":     ["Write", "write_file", "WriteFile", "fs.writeFile"],
  "edit_file":      ["Edit", "edit_file", "EditFile"],
  "bash":           ["Bash", "bash", "execute_command", "shell"],
  "grep":           ["Grep", "grep", "search_content", "rg", "ripgrep"],
  "glob":           ["Glob", "glob", "find_files", "search_file"],
  "web_search":     ["WebSearch", "web_search", "search"],
  "web_fetch":      ["WebFetch", "web_fetch", "fetch_url"],
  "mcp_read":       ["mcp__atlas__read", "mcp__linear__read", "mcp__gitnexus__read"],
  "mcp_search":     ["mcp__atlas__search", "mcp__linear__search", "mcp__gitnexus__query"],
  "mcp_run":        ["mcp__atlas__run", "mcp__linear__run"],
  "agent_spawn":    ["agent_spawn", "Agent", "task", "delegate"],
  "notebook_edit":  ["NotebookEdit", "notebook_edit"],
  "task_management":["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
  "other_mcp":      ["mcp__*"]  — catch-all for MCP tools not in the top categories
}
```

**Rules:**
- Match is case-insensitive.
- `mcp__*` is a prefix match — any tool starting with `mcp__` that does not match a more specific canonical name lands in `other_mcp`.
- Tools not matching any pattern land in `other_<first_word_lower>` (e.g., `other_powershell`, `other_croncreate`).
- The normalization map is versioned in git. Adding a new canonical tool is a one-line JSON edit.
- Coverage target: >95% of all `tool_facts.tool_name_raw` values resolve to a canonical name in the top-15 list. The report displays the coverage percentage and lists unmatched tools for review.

## 11. "Missed Delegation" Heuristics

Since the system does not record "should have delegated" as a signal, we use proxy heuristics. Each is stated as a hypothesis to validate against manual review of 10–20 runs.

**Heuristic A — Lead code volume (strongest signal):**
If the lead agent wrote >X lines of code/analysis in a single turn (measured by output_tokens in `usage_facts` for `agent_key = 'lead'`), and the squad has a role whose playbook covers that kind of work, flag as potential delegation miss.
- Threshold: >2000 output tokens in a single lead turn (roughly 150 lines of text/code).
- Validation: manually review 10 flagged runs — did the lead do work that a subagent's prompt explicitly covers?

**Heuristic B — Tool-use mismatch (medium signal):**
If the lead used a tool that a subagent's playbook lists as its primary tool, and that subagent was not spawned in this run, flag as potential delegation miss.
- Example: lead calls `Grep` 15 times in a run where the `deep` reviewer (whose playbook says "use Grep for content search") was never spawned.
- Validation: check whether the lead's Grep usage was "orchestration" (finding files to delegate) vs. "doing the work" (analyzing content that a subagent should analyze).

**Heuristic C — Review bounce count (weakest signal, but already measured):**
If a run has >1 review round (`delegation-outcomes.mjs` already tracks this), and the same agent was the implementer in all rounds, flag as "could have delegated the fix to a different role."
- This is already partially measured by `delegation-outcomes.mjs` — the gap is that we cannot tell *which role* caused the return. This heuristic does not fill that gap; it only flags multi-round runs for manual inspection.

**Heuristic D — Subagent presence ratio (exploratory signal, no threshold):**
Per run, compute `roles_used / roles_defined` where `roles_defined` is the count of agent definitions in `agents/<squad>/agents/*.md`. The metric is shown as a column in the report. **No flagging threshold is set in advance** — the user examines the distribution after seeing the data and decides whether low-ratio runs warrant attention (trivial tasks may legitimately use few roles). The PRD will be updated with a threshold only after the user has reviewed 10–20 runs and observed the actual distribution.

**Output:** Each heuristic produces a metric value per run (raw numbers, no thresholds, no composite score). The report shows all four metrics as independent sortable/filterable columns. The user explores, forms hypotheses, and validates against source turns. Thresholds may emerge from observed distributions *after* the user has seen the data — not before.

## 12. Retention Check

**Script:** `scripts/check-transcript-retention.mjs`

**Logic:**
1. Query all `usage_facts` rows in the last N days (default: 30).
2. For each unique `source_path`, check `existsSync(source_path)`.
3. Group by `run_id` and `agent_key`.
4. Compute: `coverage = rows_with_live_transcript / total_rows`.
5. Output JSON + human-readable summary.

**Output schema:**
```json
{
  "checked_at": "2026-08-03T...",
  "window_days": 30,
  "total_usage_facts": 38289,
  "live_transcripts": 27600,
  "missing_transcripts": 10689,
  "coverage_pct": 72.1,
  "alarm": "WARNING",
  "by_run": [
    {
      "run_id": "r-abc123",
      "squad": "dev",
      "agent_key": "lead",
      "usage_fact_count": 45,
      "transcript_exists": false,
      "transcript_path": "C:\\Users\\...\\session-xyz.jsonl"
    }
  ]
}
```

**Alarm thresholds:**
- `coverage_pct >= 90%` → OK (green).
- `70% <= coverage_pct < 90%` → WARNING (yellow) — "NL analysis will miss some runs."
- `coverage_pct < 70%` → CRITICAL (red) — "NL analysis is unreliable; consider archiving transcripts."

**Integration:** The retention check runs as a pre-step before the Python analysis pipeline. If coverage is below 70%, the pipeline still runs but the report header displays a red banner: "Transcript retention is at 68% — NL text analysis covers only a subset of runs."

## 13. Phasing

### Phase 1 (Week 1) — Foundation

- [ ] `tool_facts` table + extraction in `telemetry-ingest.mjs` (or a companion script).
- [ ] `delegation_links` table + reconstruction logic.
- [ ] `config/tool-norm.json` + normalization pass.
- [ ] `scripts/check-transcript-retention.mjs`.
- [ ] Backfill script for existing transcripts.
- [ ] First notebook: Layer 1 analysis (frequencies, n-grams, delegation rate, cost-per-tool) → static HTML report (no drill-down yet).

**Deliverable:** A working pipeline that produces a static HTML report with fleet/squad/agent frequency views and delegation scores. Retention check runs and reports coverage.

### Phase 2 (Week 2) — Depth

- [ ] Embedding generation (sentence-transformers) + storage.
- [ ] HDBSCAN clustering of tool-call sequences and NL text.
- [ ] Interactive drill-down in the HTML report (filters, click-to-drill, turn-log panel).
- [ ] Per-squad checklist generation.
- [ ] Cluster panel in the report.
- [ ] Polish: time-scope switcher, export, error handling for missing transcripts.

**Deliverable:** The full interactive HTML report + per-squad checklists. User can explore patterns, drill into turns, and get a concrete edit checklist.

### Phase 3 (Later — stubbed, not in PRD scope)

- [ ] LLM-as-judge: feed top clusters + representative turns to Haiku for 3-sentence essays.
- [ ] Paragraph-level prompt ref resolution.
- [ ] Trend tracking: compare report N vs. report N-1 to measure whether prompt edits had an effect.

## 14. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Transcript loss makes NL analysis impossible for old runs.** Transcripts are auto-cleaned by Claude Code; when gone, the NL text and tool-call sequences are lost. Token counts survive in SQLite, but Layer 2 (embeddings) and the turn-log panel need the source text. | HIGH | Retention-check script runs first and surfaces coverage. The report degrades gracefully: frequency views work from `tool_facts` alone; clustering and turn-log are gated on transcript availability. Long-term: archive transcripts to a controlled location (see Open Questions). |
| **`data_quality_issues` is unreliable as a filter.** The `transcript_missing` issue type has 111 open and 0 closed — the system never resolves issues (see `docs/decisions/telemetry-data-audit-2026-08-03.md` §1). Any query that filters on "clean data" via this table will silently drop valid runs. | MEDIUM | Do not use `data_quality_issues` as a filter in the analysis pipeline. Use the retention-check script instead for transcript availability. Filter test fixtures via `runs.native = 0` or a run-name pattern (see audit finding: ~25% of runs are test fixtures). |
| **Tool-call normalization is a maintenance burden.** New Claude Code versions or MCP servers introduce new tool names. The normalization map rots if not updated. | MEDIUM | The report shows unmatched tool names and their frequency — this is the canary. When `other_*` categories exceed 5% of total tool calls, the map needs an update. The map is a single JSON file, easy to edit. |
| **Delegation heuristics produce false positives.** Heuristic A (lead code volume) will flag runs where the lead *correctly* did the work itself because no subagent role covers it. | MEDIUM | Each heuristic is labeled as a hypothesis in the report. The user validates by reading the source turns. Over time, validated patterns become thresholds; false-positive patterns get documented as exceptions. |
| **Python dependency footprint grows.** `sentence-transformers` alone is ~2 GB with model. HDBSCAN has native compilation requirements on Windows. | LOW | All Python deps are optional per analysis layer. Layer 1 (frequencies) runs with just pandas + sqlite3 (stdlib). Layer 2 (embeddings) is gated behind a `--with-clustering` flag. The notebook documents the exact `pip install` command. |

## 15. Open Questions

1. **Should transcripts be archived to a controlled location to defeat retention risk?** The retention-check script tells us *when* transcripts are gone, but does not prevent the loss. Option: a `scripts/archive-transcripts.mjs` that copies transcripts to `%LOCALAPPDATA%/linear-agents/telemetry/transcripts/` before Claude Code can clean them. Tradeoff: disk space (transcripts can be hundreds of MB) vs. analysis fidelity. Decision needed before Phase 2.

2. **Where do embedding vectors live?** Options: (a) a new `tool_embeddings` table in SQLite (BLOB column, simple, single-file), (b) a parquet sidecar (better for large-scale numpy access, but adds a file format dependency). Recommendation: SQLite BLOB for Phase 2 — keeps the artifact count at 1 file. Revisit if query performance suffers above 100k vectors.

3. **How do we handle the ~25% test-fixture runs?** The audit found that ~25% of runs are test fixtures. Filtering them is necessary for any aggregate query, but the filter criterion is not standardized. Options: (a) `runs.native = 0` (test fixtures are launched differently), (b) run-name pattern match (`*test*`, `*dry*`), (c) a manual `is_test` flag added to `runs`. Recommendation: start with `native = 0` + a configurable name-exclusion pattern in the report filter; add `is_test` column to `runs` if the heuristic proves insufficient.

4. **Should the HTML report be a single file or a directory with assets?** **Decision: directory.** Layout: `report/index.html` (viewer + interactive filters, ~50 KB), `report/data.json` (the full dataset for the current filter scope), and optional `report/assets/` (charts rendered as SVG, no CDN). Rationale: no size limit, easier to git-diff between report runs, easier to cache `data.json` separately from the viewer, easier to share subsets (one squad's data file is small). The viewer fetches `data.json` via `fetch()` — works from `file://` in modern browsers when opened directly.

5. **Does the delegation-link reconstruction need the sidechain refs from the prompt library?** The prompt library (`prompt-library.mjs`) has `resolvePromptRefs()` which resolves FILE-level refs, but subagent spawns are recorded in the lead's tool_use stream (as `agent_spawn` or `Agent` tool calls). The sidechain refs (which roles a lead *could* spawn) are useful for Heuristic D (subagent absence) but not for reconstructing actual delegation events. Recommendation: build `delegation_links` from transcript tool_use streams first; add sidechain-based "expected vs. actual" comparison as a Phase 2 enhancement.
