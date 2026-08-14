#!/usr/bin/env python3
"""Agent Intelligence — analysis pipeline for telemetry data.

CLI entry point and importable module.  Run from the repo root:

    python notebooks/agent_intelligence.py --squad dev --days 30

Or import from a Jupyter notebook:

    import sys; sys.path.insert(0, "notebooks")
    from agent_intelligence import load_usage_facts
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STOPWORDS: set[str] = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
    "for", "of", "with", "by", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "should", "could", "may", "might", "can", "this", "that", "these",
    "those", "i", "you", "he", "she", "it", "we", "they", "what", "which",
    "who", "when", "where", "why", "how", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "no", "nor", "not",
    "only", "own", "same", "so", "than", "too", "very", "just", "also",
    "if", "then", "because", "while", "here", "there", "now", "us",
    "my", "your", "our", "their", "about", "into", "over", "after", "before",
}

TOOL_NAME_MAP: dict[str, str] = {
    "Read": "read_file",
    "Write": "write_file",
    "Edit": "edit_file",
    "Bash": "bash",
    "Grep": "grep",
    "Glob": "glob",
    "Agent": "agent_spawn",
    "Task": "agent_spawn",
    "agent_spawn": "agent_spawn",
    "WebSearch": "web_search",
    "WebFetch": "web_fetch",
    "TodoWrite": "todo_update",
    "ReadMcpResource": "mcp_read",
    "mcp__atlas__read": "mcp_read",
}


def normalize_tool_name(raw: str) -> str:
    """Map a raw tool name to its canonical form.

    Falls through the hardcoded map, then checks for ``mcp__`` prefix,
    then falls back to ``other_<first_word>``.
    """
    if not raw:
        return "other_unknown"
    canonical = TOOL_NAME_MAP.get(raw)
    if canonical:
        return canonical
    if raw.startswith("mcp__"):
        return "mcp_other"
    first_word = raw.split("_")[0].split("-")[0].lower()
    return f"other_{first_word}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def resolve_db_path(args: argparse.Namespace) -> str:
    """Return the SQLite database path, respecting env overrides and OS."""
    if args.db:
        return args.db

    env_db = os.environ.get("LA_TELEMETRY_DB")
    if env_db:
        return env_db

    env_home = os.environ.get("LA_TELEMETRY_HOME")
    if env_home:
        return str(Path(env_home) / "telemetry.sqlite")

    # Windows default
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return str(Path(local_app_data) / "linear-agents" / "telemetry" / "telemetry.sqlite")

    # POSIX fallback: ~/.local/share/linear-agents/telemetry/telemetry.sqlite
    return str(
        Path.home() / ".local" / "share" / "linear-agents" / "telemetry" / "telemetry.sqlite"
    )


def _build_date_filter(days: int) -> tuple[str, str]:
    """Return (cutoff_iso, label) for the date filter."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    return cutoff.isoformat(), f"last {days} days"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_usage_facts(db_path: str, args: argparse.Namespace) -> tuple:
    """Query usage_facts joined with cost_facts and runs.

    Returns
    -------
    (df, warnings)
        df : pandas.DataFrame
        warnings : list[str]  — non-fatal messages (missing tables, etc.)
    """
    import pandas as pd  # noqa: F811 — delayed import so module loads without pandas

    warnings: list[str] = []
    cutoff_iso, _ = _build_date_filter(args.days)

    query = """
        SELECT
            u.run_id,
            u.session_id,
            u.agent_key,
            u.model,
            u.observed_at,
            u.input_tokens,
            u.output_tokens,
            u.cache_read_tokens,
            u.cache_creation_tokens,
            u.source_path,
            u.source_offset,
            c.cost_usd,
            r.squad,
            r.source       AS run_source,
            r.started_at,
            r.ended_at,
            r.status,
            r.native,
            r.interactive,
            r.launched_by
        FROM usage_facts u
        LEFT JOIN cost_facts c ON u.run_id = c.run_id AND u.usage_id = c.usage_id
        LEFT JOIN runs r       ON u.run_id = r.run_id
        WHERE u.observed_at >= ?
    """
    params: list = [cutoff_iso]

    if args.squad:
        query += " AND r.squad = ?"
        params.append(args.squad)
    if args.agent:
        query += " AND u.agent_key = ?"
        params.append(args.agent)

    try:
        conn = sqlite3.connect(db_path)
        df = pd.read_sql_query(query, conn, params=params)
        conn.close()
    except sqlite3.OperationalError as exc:
        warnings.append(f"Database query failed — table may not exist yet: {exc}")
        return pd.DataFrame(), warnings

    if df.empty:
        warnings.append("Query returned 0 rows (no data in range or filters too narrow).")
        return df, warnings

    # Filter out test fixtures
    before = len(df)
    df = df[df["run_source"] != "echo test"]
    df = df[df["native"] != 1]
    dropped = before - len(df)
    if dropped:
        warnings.append(f"Filtered out {dropped} test-fixture rows (run_source='echo test' or native=1).")

    return df, warnings


def _sanitize(obj):
    """Recursively replace NaN / inf with None so JSON output stays valid.

    pandas / numpy can produce ``nan`` / ``inf`` in numeric columns. Without
    this, ``json.dump`` emits the invalid tokens ``NaN`` / ``Infinity`` which
    are NOT valid JSON — opening ``report/index.html`` would crash at
    ``JSON.parse(...)``. Synthetic-model rows in this DB have 0-token runs
    that surface exactly this case.
    """
    import math

    if obj is None or isinstance(obj, (int, str, bool)):
        return obj
    if isinstance(obj, float):
        return None if math.isnan(obj) or math.isinf(obj) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    # pandas / numpy scalars — coerce to python native, then re-check.
    try:
        if hasattr(obj, "item"):
            v = obj.item()
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
            return v
    except Exception:
        pass
    return obj


def load_tool_facts(db_path: str, args: argparse.Namespace) -> tuple:
    """Query tool_facts joined with runs for squad.

    Returns
    -------
    (df, warnings)
        df : pandas.DataFrame — empty if table missing or empty
        warnings : list[str]
    """
    import pandas as pd

    warnings: list[str] = []
    cutoff_iso, _ = _build_date_filter(args.days)

    query = """
        SELECT
            t.run_id,
            t.agent_key,
            t.model,
            t.observed_at,
            t.tool_name_raw,
            t.tool_name_canon,
            t.tool_has_error,
            t.turn_index,
            r.squad
        FROM tool_facts t
        LEFT JOIN runs r ON t.run_id = r.run_id
        WHERE t.observed_at >= ?
    """
    params: list = [cutoff_iso]

    if args.squad:
        query += " AND r.squad = ?"
        params.append(args.squad)
    if args.agent:
        query += " AND t.agent_key = ?"
        params.append(args.agent)

    try:
        conn = sqlite3.connect(db_path)
        df = pd.read_sql_query(query, conn, params=params)
        conn.close()
    except sqlite3.OperationalError as exc:
        warnings.append(f"tool_facts query failed — table may not exist yet: {exc}")
        return pd.DataFrame(), warnings

    if df.empty:
        warnings.append("tool_facts returned 0 rows (table empty or no data in range).")
        return df, warnings

    return df, warnings


def load_delegation_links(db_path: str, args: argparse.Namespace) -> tuple:
    """Query delegation_links.

    Returns
    -------
    (df, warnings)
        df : pandas.DataFrame — empty if table missing or empty
        warnings : list[str]
    """
    import pandas as pd

    warnings: list[str] = []
    cutoff_iso, _ = _build_date_filter(args.days)

    query = """
        SELECT
            d.delegation_id,
            d.parent_run_id,
            d.parent_agent,
            d.child_agent,
            d.child_model,
            d.observed_at,
            d.child_tokens,
            d.child_cost_usd,
            d.child_turns,
            d.source
        FROM delegation_links d
        WHERE d.observed_at >= ?
    """
    params: list = [cutoff_iso]

    if args.agent:
        query += " AND (d.parent_agent = ? OR d.child_agent = ?)"
        params.extend([args.agent, args.agent])

    try:
        conn = sqlite3.connect(db_path)
        df = pd.read_sql_query(query, conn, params=params)
        conn.close()
    except sqlite3.OperationalError as exc:
        warnings.append(f"delegation_links query failed — table may not exist yet: {exc}")
        return pd.DataFrame(), warnings

    if df.empty:
        warnings.append("delegation_links returned 0 rows (table empty or no data in range).")
        return df, warnings

    return df, warnings


def load_ngrams(db_path: str, args: argparse.Namespace) -> tuple:
    """Compute top 20 1-2-grams per agent from transcript assistant text.

    Reads transcripts referenced by usage_facts, finds assistant text blocks,
    tokenizes (whitespace + lowercase + strip punctuation), and counts n-grams.

    Results are cached in ``report/.ngrams-cache.pkl`` keyed on
    ``(args.filters, hash-of-source-mtimes)``.

    Returns
    -------
    (ngram_dict, warnings)
        ngram_dict : dict[str, list[tuple[str, int]]]
            Keys are agent_key or '__all__' or '__squad__<squad>'.
        warnings : list[str]
    """
    import pandas as pd

    warnings: list[str] = []
    cutoff_iso, _ = _build_date_filter(args.days)
    out_dir = Path(args.out)
    cache_path = out_dir / ".ngrams-cache.pkl"

    # Build filter key for cache
    filter_key = json.dumps({"squad": args.squad, "agent": args.agent, "days": args.days}, sort_keys=True)

    # Get source_paths from usage_facts joined with transcript_sources
    query = """
        SELECT DISTINCT u.agent_key, u.run_id, u.observed_at, ts.source_path
        FROM usage_facts u
        LEFT JOIN transcript_sources ts ON u.run_id = ts.run_id
        WHERE u.observed_at >= ?
    """
    params: list = [cutoff_iso]
    if args.squad:
        query += " AND u.run_id IN (SELECT run_id FROM runs WHERE squad = ?)"
        params.append(args.squad)
    if args.agent:
        query += " AND u.agent_key = ?"
        params.append(args.agent)

    try:
        conn = sqlite3.connect(db_path)
        source_df = pd.read_sql_query(query, conn, params=params)
        conn.close()
    except sqlite3.OperationalError as exc:
        warnings.append(f"ngrams query failed: {exc}")
        return {}, warnings

    if source_df.empty:
        warnings.append("No transcript sources found for n-gram analysis.")
        return {}, warnings

    # Compute hash of source file mtimes for cache invalidation
    mtimes_hash = hashlib.md5()
    seen_paths = set()
    for sp in source_df["source_path"].dropna().unique():
        if sp not in seen_paths:
            seen_paths.add(sp)
            p = Path(sp)
            if p.exists():
                mtimes_hash.update(str(p.stat().st_mtime_ns).encode())
            else:
                mtimes_hash.update(b"missing")
    mtimes_digest = mtimes_hash.hexdigest()

    cache_key = (filter_key, mtimes_digest)

    # Try loading from cache
    if cache_path.exists():
        try:
            with open(cache_path, "rb") as f:
                cached = pickle.load(f)
            if cached.get("_cache_key") == cache_key:
                cached.pop("_cache_key", None)
                print(f"  [cache] n-gram cache hit ({len(cached)} agent keys)")
                return cached, warnings
            else:
                print("  [cache] n-gram cache miss (filters or transcripts changed)")
        except Exception as exc:
            warnings.append(f"Failed to load n-gram cache: {exc}")

    # Group source paths by agent_key
    agent_sources: dict[str, set[str]] = {}
    all_sources: set[str] = set()
    squad_sources: dict[str, set[str]] = {}

    for _, row in source_df.iterrows():
        agent = row["agent_key"]
        sp = row["source_path"]
        if not sp or not Path(sp).exists():
            continue
        agent_sources.setdefault(agent, set()).add(sp)
        all_sources.add(sp)
        # Get squad from run_id
        squad = None
        if args.squad:
            squad = args.squad
        elif "squad" in source_df.columns:
            squad = row.get("squad")
        if squad:
            squad_sources.setdefault(squad, set()).add(sp)

    # Tokenize helper
    _PUNCT_RE = re.compile(r'[^\w\s]')
    _WHITESPACE_RE = re.compile(r'\s+')

    def tokenize(text: str) -> list[str]:
        text = text.lower()
        text = _PUNCT_RE.sub(' ', text)
        tokens = _WHITESPACE_RE.split(text.strip())
        return [t for t in tokens if len(t) >= 2 and t not in STOPWORDS]

    def compute_ngrams_for_sources(source_set: set[str], max_turns: int = 500) -> list[tuple[str, int]]:
        """Read transcripts, extract assistant text, compute top 1-2-grams."""
        unigrams: Counter = Counter()
        bigrams: Counter = Counter()
        turn_count = 0

        for sp in sorted(source_set):
            if turn_count >= max_turns:
                break
            try:
                with open(sp, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if turn_count >= max_turns:
                            break
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if obj.get("type") != "assistant":
                            continue
                        msg = obj.get("message", {})
                        content_blocks = msg.get("content", [])
                        text_parts = []
                        if isinstance(content_blocks, list):
                            for block in content_blocks:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text_parts.append(block.get("text", ""))
                        elif isinstance(content_blocks, str):
                            text_parts.append(content_blocks)
                        full_text = " ".join(text_parts)
                        tokens = tokenize(full_text)
                        if len(tokens) < 2:
                            continue
                        turn_count += 1
                        unigrams.update(tokens)
                        bigrams.update(zip(tokens, tokens[1:]))
            except (OSError, json.JSONDecodeError) as exc:
                warnings.append(f"  [skip] Could not read transcript {sp}: {exc}")
                continue

        # Merge and sort: top 20 by combined unigram+bigram count
        combined: Counter = Counter()
        for gram, count in unigrams.most_common(40):
            combined[gram] += count
        for (w1, w2), count in bigrams.most_common(40):
            combined[f"{w1} {w2}"] += count

        return combined.most_common(20)

    print("  [ngrams] Reading transcripts for n-gram analysis...")
    result: dict[str, list[tuple[str, int]]] = {}

    # Per-agent n-grams
    for agent, sources in agent_sources.items():
        ngrams = compute_ngrams_for_sources(sources, max_turns=100)
        if ngrams:
            result[agent] = ngrams

    # All agents combined
    all_ngrams = compute_ngrams_for_sources(all_sources, max_turns=500)
    if all_ngrams:
        result["__all__"] = all_ngrams

    # Per-squad n-grams
    for squad, sources in squad_sources.items():
        squad_ngrams = compute_ngrams_for_sources(sources, max_turns=200)
        if squad_ngrams:
            result[f"__squad__{squad}"] = squad_ngrams

    # Write cache
    try:
        cache_data = dict(result)
        cache_data["_cache_key"] = cache_key
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "wb") as f:
            pickle.dump(cache_data, f)
        print(f"  [cache] n-gram cache written ({len(result)} agent keys)")
    except Exception as exc:
        warnings.append(f"Failed to write n-gram cache: {exc}")

    return result, warnings


def load_task_links(db_path: str, args: argparse.Namespace) -> tuple:
    """Query run_task_links joined with runs, usage_facts, cost_facts.

    Returns
    -------
    (df, warnings)
        df : pandas.DataFrame with columns:
            task_id, squad, runs, cost_usd, tokens, distinct_agents,
            first_started, last_ended
        warnings : list[str]
    """
    import pandas as pd

    warnings: list[str] = []
    cutoff_iso, _ = _build_date_filter(args.days)

    query = """
        SELECT
            rtl.task_id,
            r.squad,
            COUNT(DISTINCT rtl.run_id) AS runs,
            SUM(c.cost_usd) AS cost_usd,
            SUM(u.input_tokens + u.output_tokens) AS tokens,
            COUNT(DISTINCT u.agent_key) AS distinct_agents,
            MIN(r.started_at) AS first_started,
            MAX(r.ended_at) AS last_ended
        FROM run_task_links rtl
        JOIN runs r ON rtl.run_id = r.run_id
        LEFT JOIN usage_facts u ON rtl.run_id = u.run_id
        LEFT JOIN cost_facts c ON u.run_id = c.run_id AND u.usage_id = c.usage_id
        WHERE r.started_at >= ?
    """
    params: list = [cutoff_iso]

    if args.squad:
        query += " AND r.squad = ?"
        params.append(args.squad)
    if args.agent:
        query += " AND u.agent_key = ?"
        params.append(args.agent)

    query += " GROUP BY rtl.task_id, r.squad ORDER BY cost_usd DESC"

    try:
        conn = sqlite3.connect(db_path)
        df = pd.read_sql_query(query, conn, params=params)
        conn.close()
    except sqlite3.OperationalError as exc:
        warnings.append(f"run_task_links query failed — table may not exist yet: {exc}")
        return pd.DataFrame(), warnings

    if df.empty:
        warnings.append("run_task_links returned 0 rows (no data in range).")
        return df, warnings

    return df, warnings


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------

def summarize_per_agent(df) -> "pd.DataFrame":
    """Aggregate usage facts by agent_key.

    Returns a DataFrame indexed by ``agent_key`` with columns:
        turns, total_tokens, cost_usd, runs
    """
    import pandas as pd

    if df.empty:
        return pd.DataFrame(
            index=pd.Index([], name="agent_key"),
            columns=["turns", "total_tokens", "cost_usd", "runs"],
        ).astype({"turns": int, "total_tokens": int, "cost_usd": float, "runs": int})

    grouped = df.groupby("agent_key")
    per_agent = grouped.agg(
        turns=("run_id", "count"),
        total_tokens=("output_tokens", "sum"),
        cost_usd=("cost_usd", "sum"),
        runs=("run_id", "nunique"),
    )
    per_agent["total_tokens"] += grouped["input_tokens"].sum()
    per_agent["cost_usd"] = per_agent["cost_usd"].round(6)
    per_agent.sort_values("cost_usd", ascending=False, inplace=True)
    return per_agent


def summarize_per_squad(df) -> "pd.DataFrame":
    """Aggregate usage facts by squad.

    Same shape as ``summarize_per_agent``, indexed by ``squad``.
    """
    import pandas as pd

    if df.empty:
        return pd.DataFrame(
            index=pd.Index([], name="squad"),
            columns=["turns", "total_tokens", "cost_usd", "runs"],
        ).astype({"turns": int, "total_tokens": int, "cost_usd": float, "runs": int})

    grouped = df.groupby("squad")
    per_squad = grouped.agg(
        turns=("run_id", "count"),
        total_tokens=("output_tokens", "sum"),
        cost_usd=("cost_usd", "sum"),
        runs=("run_id", "nunique"),
    )
    per_squad["total_tokens"] += grouped["input_tokens"].sum()
    per_squad["cost_usd"] = per_squad["cost_usd"].round(6)
    per_squad.sort_values("cost_usd", ascending=False, inplace=True)
    return per_squad


# ---------------------------------------------------------------------------
# Handover graph
# ---------------------------------------------------------------------------

def compute_handover_graph(delegation_df: "pd.DataFrame") -> dict:
    """Build nested handover graph from delegation_links.

    Returns
    -------
    dict
        ``handover_graph["squad|agent"]["from_agent"]["to_agent"]``
        = list of ``{"child_cost_usd": float, "observed_at": str}``
        Plus a default entry ``"|"`` with all data.
        Also ``"dev|"`` (all delegations in squad dev),
        ``"dev|implementer"`` (delegations from implementer in squad dev), etc.
    """
    if delegation_df.empty:
        return {"|": {}}

    import pandas as pd

    graph: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))

    for _, row in delegation_df.iterrows():
        from_agent = str(row.get("parent_agent", ""))
        to_agent = str(row.get("child_agent", ""))
        cost = float(row.get("child_cost_usd", 0) or 0)
        observed = str(row.get("observed_at", ""))
        squad = str(row.get("squad", "")) if "squad" in delegation_df.columns else ""

        if not from_agent or not to_agent:
            continue

        edge_info = {"child_cost_usd": cost, "observed_at": observed}

        # Always add to the all-data key
        graph["|"][from_agent][to_agent].append(edge_info)

        # Add to squad-level key
        if squad:
            squad_key = f"{squad}|"
            graph[squad_key][from_agent][to_agent].append(edge_info)

            # Add to squad+agent-level key
            squad_agent_key = f"{squad}|{from_agent}"
            graph[squad_agent_key][from_agent][to_agent].append(edge_info)

        # Add to agent-level key (across all squads)
        agent_key = f"|{from_agent}"
        graph[agent_key][from_agent][to_agent].append(edge_info)

    return dict(graph)


# ---------------------------------------------------------------------------
# Embeddings & clustering (optional)
# ---------------------------------------------------------------------------

def embed_and_cluster(
    per_agent_text_corpus: dict[str, list[str]],
    out_dir: Path | None = None,
) -> dict:
    """Embed per-agent text corpus and cluster via HDBSCAN.

    Results are cached in ``report/.embeddings-cache.pkl`` keyed on
    a hash of the concatenated input texts so re-runs are fast.

    Parameters
    ----------
    per_agent_text_corpus : dict[str, list[str]]
        agent_key -> list of text strings (turns)
    out_dir : Path or None
        Output directory for the cache file.

    Returns
    -------
    dict
        ``{"engine": "HDBSCAN", "note": "...", agent_key: [cluster_dicts]}``
        or ``{"engine": None, "note": "skipped: ..."}`` if unavailable.
    """
    result: dict = {"engine": None, "note": ""}

    # --- Cache check ---
    cache_path = None
    if out_dir is not None:
        cache_path = out_dir / ".embeddings-cache.pkl"
        # Build a cache key from the concatenated text
        all_text_parts: list[str] = []
        for texts in per_agent_text_corpus.values():
            all_text_parts.extend(texts[:200])
        cache_key = hashlib.md5(
            "|".join(sorted(all_text_parts)).encode()
        ).hexdigest()

        if cache_path and cache_path.exists():
            try:
                with open(cache_path, "rb") as f:
                    cached = pickle.load(f)
                if cached.get("_cache_key") == cache_key:
                    cached.pop("_cache_key", None)
                    print(f"  [cache] embedding cache hit ({len(cached)} agent keys)")
                    return cached
                else:
                    print("  [cache] embedding cache miss (texts changed)")
            except Exception as exc:
                print(f"  [cache] failed to load embedding cache: {exc}")

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        result["note"] = "skipped: sentence-transformers not installed"
        print("  [skip] embeddings skipped — install sentence-transformers for this feature")
        return result

    try:
        import hdbscan
        from sklearn.decomposition import PCA
    except ImportError:
        result["note"] = "skipped: hdbscan or scikit-learn not installed"
        print("  [skip] embeddings skipped — install hdbscan and scikit-learn for this feature")
        return result

    if not per_agent_text_corpus:
        result["note"] = "skipped: no text corpus provided"
        return result

    print("  [embed] Loading sentence-transformer model (all-MiniLM-L6-v2)...")
    try:
        model = SentenceTransformer("all-MiniLM-L6-v2")
    except Exception as exc:
        result["note"] = f"skipped: model load failed — {exc}"
        return result

    result["engine"] = "HDBSCAN"

    for agent_key, texts in per_agent_text_corpus.items():
        if not texts:
            continue

        # Sample up to 200 turns per agent (rotate to keep cache diverse)
        sample = texts[:200]
        if len(sample) < 5:
            continue

        print(f"  [embed] Embedding {len(sample)} turns for {agent_key}...")
        try:
            embeddings = model.encode(sample, show_progress_bar=False)
        except Exception as exc:
            print(f"    [skip] embedding failed for {agent_key}: {exc}")
            continue

        # PCA to 50 dims
        n_components = min(50, len(sample) - 1, embeddings.shape[1])
        if n_components < 2:
            continue
        pca = PCA(n_components=n_components)
        reduced = pca.fit_transform(embeddings)

        # HDBSCAN clustering
        min_cluster = min(5, len(sample) // 2)
        if min_cluster < 2:
            continue
        clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster, min_samples=1)
        labels = clusterer.fit_predict(reduced)

        # Build cluster info
        clusters: list[dict] = []
        for label_id in set(labels):
            if label_id == -1:
                continue  # noise
            indices = [i for i, l in enumerate(labels) if l == label_id]
            cluster_texts = [sample[i] for i in indices]

            # Top terms by simple TF
            word_counts: Counter = Counter()
            for t in cluster_texts:
                words = re.findall(r'\w{3,}', t.lower())
                word_counts.update(words)
            top_terms = " ".join(w for w, _ in word_counts.most_common(5))

            clusters.append({
                "id": int(label_id),
                "count": len(indices),
                "top_terms": top_terms,
                "sample_turn_indices": indices[:5],
            })

        if clusters:
            result[agent_key] = clusters

    # Also cluster all texts together
    all_texts = []
    for texts in per_agent_text_corpus.values():
        all_texts.extend(texts[:20])  # sample per agent
    if len(all_texts) >= 10:
        print(f"  [embed] Embedding {len(all_texts)} combined turns...")
        try:
            all_embeddings = model.encode(all_texts, show_progress_bar=False)
            n_components = min(50, len(all_texts) - 1, all_embeddings.shape[1])
            if n_components >= 2:
                pca = PCA(n_components=n_components)
                reduced = pca.fit_transform(all_embeddings)
                min_cluster = min(5, len(all_texts) // 2)
                if min_cluster >= 2:
                    clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster, min_samples=1)
                    labels = clusterer.fit_predict(reduced)
                    clusters = []
                    for label_id in set(labels):
                        if label_id == -1:
                            continue
                        indices = [i for i, l in enumerate(labels) if l == label_id]
                        cluster_texts = [all_texts[i] for i in indices]
                        word_counts = Counter()
                        for t in cluster_texts:
                            words = re.findall(r'\w{3,}', t.lower())
                            word_counts.update(words)
                        top_terms = " ".join(w for w, _ in word_counts.most_common(5))
                        clusters.append({
                            "id": int(label_id),
                            "count": len(indices),
                            "top_terms": top_terms,
                            "sample_turn_indices": indices[:5],
                        })
                    if clusters:
                        result["__all__"] = clusters
        except Exception as exc:
            print(f"    [skip] combined clustering failed: {exc}")

    if not any(k for k in result if k not in ("engine", "note")):
        result["note"] = (result.get("note", "") + "; no clusters formed (too few samples per agent)").strip("; ")

    # Write cache
    if cache_path is not None:
        try:
            cache_data = dict(result)
            cache_data["_cache_key"] = cache_key
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cache_path, "wb") as f:
                pickle.dump(cache_data, f)
            print(f"  [cache] embedding cache written ({len(result)} agent keys)")
        except Exception as exc:
            print(f"  [cache] failed to write embedding cache: {exc}")

    return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_summary(per_agent: "pd.DataFrame", per_squad: "pd.DataFrame") -> None:
    """Print readable summary tables to stdout."""
    print("=" * 60)
    print("  Agent Intelligence — Summary")
    print("=" * 60)

    if per_agent.empty:
        print("\n  [No agent data to report.]")
    else:
        print("\n  Per-agent summary:")
        print(f"  {'Agent':<20} {'Turns':>8} {'Tokens':>12} {'Cost $':>10} {'Runs':>6}")
        print("  " + "-" * 58)
        for agent_key, row in per_agent.iterrows():
            print(
                f"  {agent_key:<20} {int(row['turns']):>8} "
                f"{int(row['total_tokens']):>12} {row['cost_usd']:>10.6f} {int(row['runs']):>6}"
            )

    if per_squad.empty:
        print("\n  [No squad data to report.]")
    else:
        print("\n  Per-squad summary:")
        print(f"  {'Squad':<20} {'Turns':>8} {'Tokens':>12} {'Cost $':>10} {'Runs':>6}")
        print("  " + "-" * 58)
        for squad, row in per_squad.iterrows():
            print(
                f"  {squad:<20} {int(row['turns']):>8} "
                f"{int(row['total_tokens']):>12} {row['cost_usd']:>10.6f} {int(row['runs']):>6}"
            )

    print()


# ---------------------------------------------------------------------------
# HTML template (embedded verbatim)
# ---------------------------------------------------------------------------

_REPORT_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Intelligence Report</title>
<style>
:root { --bg:#fafafa; --fg:#222; --muted:#888; --card:#fff; --border:#e0e0e0; --accent:#5b8def; --warn:#e67e22; --crit:#c0392b; --ok:#27ae60; }
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:1280px; margin:1rem auto; padding:0 1rem; background:var(--bg); color:var(--fg); }
h1 { margin: 0.4rem 0; }
h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; margin-top: 2rem; }
.meta { color: var(--muted); font-size: 0.85rem; }
.controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.6rem; background: var(--card); padding: 1rem; border: 1px solid var(--border); border-radius: 6px; margin: 1rem 0; }
.controls label { font-size: 0.8rem; color: var(--muted); display: block; }
.controls select, .controls input { width: 100%; padding: 0.3rem; font-size: 0.9rem; border: 1px solid var(--border); border-radius: 4px; margin-top: 0.2rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin: 0.5rem 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
.kpi { font-size: 1.6rem; font-weight: 600; }
.kpi-label { color: var(--muted); font-size: 0.8rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); text-align: left; }
th { background: #f4f4f4; font-weight: 600; position: sticky; top: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.bar { display: inline-block; height: 0.8rem; background: var(--accent); border-radius: 2px; vertical-align: middle; }
details summary { cursor: pointer; padding: 0.3rem 0; }
.footnote { color: var(--muted); font-size: 0.75rem; margin-top: 2rem; }
.cluster { display: inline-block; padding: 0.2rem 0.5rem; margin: 0.2rem; background: #eef3fb; border-radius: 4px; }
.tabs { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
.tab { padding: 0.3rem 0.6rem; background: var(--card); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
.tab.active { background: var(--accent); color: white; border-color: var(--accent); }
</style>
</head>
<body>
<h1>Agent Intelligence Report</h1>
<p class="meta">Generated: <span id="gen-at"></span> · Filters: <span id="filters-desc"></span></p>

<div class="controls">
<label>Squad <select id="f-squad"><option value="">(all)</option></select></label>
<label>Agent <select id="f-agent"><option value="">(all)</option></select></label>
<label>Model <select id="f-model"><option value="">(all)</option></select></label>
<label>Date from <input type="date" id="f-from"></label>
<label>Date to <input type="date" id="f-to"></label>
</div>

<section id="fleet-overview">
<h2>Fleet Overview</h2>
<div class="grid" id="kpi-cards"></div>
</section>

<section>
<h2>Squad Breakdown</h2>
<div class="card"><table id="tbl-squad"></table></div>
</section>

<section>
<h2>Agent Breakdown</h2>
<div class="card"><table id="tbl-agent"></table></div>
</section>

<section>
<h2>Tool Calls</h2>
<div class="card" id="card-tools">
<p class="meta">Top canonical tools · grouped from <code>tool_facts</code></p>
<table id="tbl-tools"></table>
</div>
<div class="card">
<details><summary>Unnormalized tool names (need a mapping entry)</summary><table id="tbl-tools-raw"></table></details>
</div>
</section>

<section>
<h2>Delegation Handovers</h2>
<div class="card"><table id="tbl-handover"></table></div>
<div class="card">
<details><summary>Per-delegation sample (last 50)</summary><table id="tbl-delegations"></table></details>
</div>
</section>

<section>
<h2>Task Linkage (run_task_links)</h2>
<div class="card"><p class="meta">Linear tasks connected to runs · cost aggregated across the task</p><table id="tbl-tasks"></table></div>
</section>

<section>
<h2>NLP — N-grams</h2>
<div class="card">
<div class="tabs" id="ng-tabs">
<span class="tab active" data-scope="__all__">All agents</span>
</div>
<table id="tbl-ngrams"></table>
</div>
</section>

<section>
<h2>Embedding Clusters</h2>
<div class="card">
<p class="meta" id="clusters-status"></p>
<div id="clusters-list"></div>
</div>
</section>

<p class="footnote">Data: <span id="data-size"></span> · Open this file directly, no server needed.</p>

<script id="intel-data" type="application/json">__DATA_JSON__</script>
<script>
(function(){
  const el = document.getElementById('intel-data');
  if (!el) { console.error('[viewer] no #intel-data element'); return; }
  let D;
  try { D = JSON.parse(el.textContent); }
  catch(e) { console.error('[viewer] JSON parse failed:', e.message); return; }
  const setText = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  setText('gen-at', D.generated_at || '');
  setText('filters-desc', JSON.stringify(D.filters || {}));
  setText('data-size', (JSON.stringify(D).length/1024).toFixed(1) + ' KB');

const uniq = arr => Array.from(new Set(arr)).filter(x => x != null && x !== '').sort();
const fmtUsd = v => '$' + ((v||0).toFixed(2));
const fmtN = v => ((v||0).toLocaleString());
const escHtml = s => String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const inDateRange = iso => {
  const f = document.getElementById('f-from').value;
  const t = document.getElementById('f-to').value;
  if (!iso) return true;
  const d = iso.slice(0,10);
  if (f && d < f) return false;
  if (t && d > t) return false;
  return true;
};

function fillSelect(sel, values) {
  values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
}
fillSelect(document.getElementById('f-squad'), uniq(D.rows.map(r => r.squad)));
fillSelect(document.getElementById('f-agent'), uniq(D.rows.map(r => r.agent_key)));
fillSelect(document.getElementById('f-model'), uniq(D.rows.map(r => r.model)));

let ngScope = '__all__';
function bindTabs() {
  document.querySelectorAll('#ng-tabs .tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('#ng-tabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    ngScope = t.dataset.scope;
    renderNgrams();
  }));
}
bindTabs();

function renderNgrams() {
  const ng = D.ngrams || {};
  const data = ng[ngScope] || ng['__all__'] || [];
  document.getElementById('tbl-ngrams').innerHTML = '<tr><th>N-gram</th><th class="num">Count</th></tr>' +
    (data.length === 0 ? '<tr><td colspan="2" class="meta">No n-grams for this scope (transcripts may have been GC\'d, or n-gram cache empty).</td></tr>' :
    data.slice(0, 50).map(([g,c]) => `<tr><td>${escHtml(g)}</td><td class="num">${c}</td></tr>`).join(''));
}

function render() {
  const squad = document.getElementById('f-squad').value;
  const agent = document.getElementById('f-agent').value;
  const model = document.getElementById('f-model').value;
  const rows = D.rows.filter(r => (!squad || r.squad===squad) && (!agent || r.agent_key===agent) && (!model || r.model===model) && inDateRange(r.observed_at));

  const totalCost = rows.reduce((s,r) => s + (r.cost_usd||0), 0);
  const totalTokens = rows.reduce((s,r) => s + (r.total_tokens||0), 0);
  const totalRuns = new Set(rows.map(r=>r.run_id)).size;
  const totalAgents = new Set(rows.map(r=>r.agent_key)).size;
  const totalTools = (D.tools || []).filter(t => rows.some(r => r.run_id === t.run_id && r.agent_key === t.agent_key)).reduce((s,t)=>s+(t.count||1),0);
  const totalDelegations = (D.delegations || []).filter(d => rows.some(r => r.run_id === d.parent_run_id)).length;
  document.getElementById('kpi-cards').innerHTML = [
    ['Total cost', fmtUsd(totalCost)],
    ['Total tokens', fmtN(totalTokens)],
    ['Runs', totalRuns],
    ['Distinct agents', totalAgents],
    ['Tool calls', totalTools],
    ['Delegations', totalDelegations]
  ].map(([l,v]) => `<div class="card"><div class="kpi-label">${l}</div><div class="kpi">${v}</div></div>`).join('');

  const sq = {};
  rows.forEach(r => { if (!sq[r.squad]) sq[r.squad] = {squad:r.squad,turns:0,tokens:0,cost:0,runs:new Set(),agents:new Set()}; sq[r.squad].turns++; sq[r.squad].tokens += r.total_tokens||0; sq[r.squad].cost += r.cost_usd||0; sq[r.squad].runs.add(r.run_id); sq[r.squad].agents.add(r.agent_key); });
  document.getElementById('tbl-squad').innerHTML = '<tr><th>Squad</th><th>Turns</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Runs</th><th class="num">Agents</th></tr>' +
    Object.values(sq).sort((a,b)=>b.cost-a.cost).map(s => `<tr><td>${escHtml(s.squad)}</td><td>${fmtN(s.turns)}</td><td class="num">${fmtN(s.tokens)}</td><td class="num">${fmtUsd(s.cost)}</td><td class="num">${s.runs.size}</td><td class="num">${s.agents.size}</td></tr>`).join('');

  const ag = {};
  rows.forEach(r => { if (!ag[r.agent_key]) ag[r.agent_key] = {agent_key:r.agent_key,turns:0,tokens:0,cost:0,runs:new Set(),squads:new Set(),models:new Set()}; ag[r.agent_key].turns++; ag[r.agent_key].tokens += r.total_tokens||0; ag[r.agent_key].cost += r.cost_usd||0; ag[r.agent_key].runs.add(r.run_id); ag[r.agent_key].squads.add(r.squad); ag[r.agent_key].models.add(r.model); });
  document.getElementById('tbl-agent').innerHTML = '<tr><th>Agent</th><th>Turns</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Runs</th><th>Squads</th><th>Models</th></tr>' +
    Object.values(ag).sort((a,b)=>b.cost-a.cost).map(a => `<tr><td>${escHtml(a.agent_key)}</td><td>${fmtN(a.turns)}</td><td class="num">${fmtN(a.tokens)}</td><td class="num">${fmtUsd(a.cost)}</td><td class="num">${a.runs.size}</td><td>${[...a.squads].map(escHtml).join(', ')}</td><td>${[...a.models].map(escHtml).join(', ')}</td></tr>`).join('');

  const tools = (D.tools||[]).filter(t => rows.some(r => r.run_id === t.run_id && r.agent_key === t.agent_key));
  const tgrp = {};
  tools.forEach(t => { const k = t.tool_name_canon||'(unknown)'; if (!tgrp[k]) tgrp[k] = {tool:k,count:0,cost:0,agents:new Set()}; tgrp[k].count += (t.count||1); tgrp[k].cost += (t.cost_usd||0); tgrp[k].agents.add(t.agent_key); });
  const maxT = Math.max(1, ...Object.values(tgrp).map(x=>x.count));
  document.getElementById('tbl-tools').innerHTML = '<tr><th>Tool (canonical)</th><th class="num">Calls</th><th></th><th class="num">Cost</th><th>Agents</th></tr>' +
    Object.values(tgrp).sort((a,b)=>b.count-a.count).slice(0,30).map(t => `<tr><td>${escHtml(t.tool)}</td><td class="num">${fmtN(t.count)}</td><td><span class="bar" style="width:' + (t.count/maxT*100).toFixed(1) + '%"></span></td><td class="num">${fmtUsd(t.cost)}</td><td>${t.agents.size}</td></tr>`).join('') ||
    '<tr><td colspan="5" class="meta">tool_facts empty (backfill hasn\'t run yet?)</td></tr>';

  const rawUnmatched = (D.tools_raw||[]).filter(t => !t.tool_name_canon);
  const rgrp = {};
  rawUnmatched.forEach(t => { rgrp[t.tool_name_raw] = (rgrp[t.tool_name_raw]||0) + 1; });
  document.getElementById('tbl-tools-raw').innerHTML = '<tr><th>Raw name</th><th class="num">Count</th></tr>' +
    Object.entries(rgrp).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([n,c]) => `<tr><td>${escHtml(n)}</td><td class="num">${c}</td></tr>`).join('');

  const hgKey = (squad||'') + '|' + (agent||'');
  const hgAll = (D.handover_graph||{})['|'] || {};
  const hg = (D.handover_graph||{})[hgKey] || hgAll || {};
  const hrows = [];
  for (const [from, tos] of Object.entries(hg)) for (const [to, items] of Object.entries(tos)) hrows.push({from, to, count: items.length, total_cost: items.reduce((s,i)=>s+(i.child_cost_usd||0),0)});
  document.getElementById('tbl-handover').innerHTML = '<tr><th>From</th><th>To</th><th class="num">Count</th><th class="num">Total cost</th></tr>' +
    (hrows.length === 0 ? '<tr><td colspan="4" class="meta">No handovers in current filter (delegation_links empty?)</td></tr>' :
    hrows.sort((a,b)=>b.count-a.count).slice(0,30).map(h => `<tr><td>${escHtml(h.from)}</td><td>${escHtml(h.to)}</td><td class="num">${h.count}</td><td class="num">${fmtUsd(h.total_cost)}</td></tr>`).join(''));

  const dels = (D.delegations||[]).filter(d => rows.some(r => r.run_id === d.parent_run_id));
  document.getElementById('tbl-delegations').innerHTML = '<tr><th>Parent</th><th>Child</th><th>Run</th><th>Observed</th><th class="num">Cost</th><th>Source</th></tr>' +
    (dels.length === 0 ? '<tr><td colspan="6" class="meta">No delegations in current filter</td></tr>' :
    dels.slice(0,50).map(d => `<tr><td>${escHtml(d.parent_agent)}</td><td>${escHtml(d.child_agent)}</td><td>${escHtml(d.parent_run_id)}</td><td>${escHtml(d.observed_at)}</td><td class="num">${fmtUsd(d.child_cost_usd)}</td><td>${escHtml(d.source)}</td></tr>`).join(''));

  const tk = D.tasks || [];
  document.getElementById('tbl-tasks').innerHTML = '<tr><th>Task</th><th>Squad</th><th class="num">Runs</th><th class="num">Cost</th><th class="num">Tokens</th><th>First run</th></tr>' +
    (tk.length === 0 ? '<tr><td colspan="6" class="meta">No tasks in window</td></tr>' :
    tk.slice(0,30).map(t => `<tr><td>${escHtml(t.task_id)}</td><td>${escHtml(t.squad)}</td><td class="num">${t.runs}</td><td class="num">${fmtUsd(t.cost_usd)}</td><td class="num">${fmtN(t.tokens)}</td><td>${escHtml(t.first_started)}</td></tr>`).join(''));

  // rebuild ngram tab bar from actual scopes
  const scopes = Object.keys(D.ngrams || {}).filter(s => s !== 'engine' && s !== 'note');
  const tabBar = document.getElementById('ng-tabs');
  if (scopes.length > 0) {
    tabBar.innerHTML = '';
    scopes.slice(0, 8).forEach((s, i) => {
      const t = document.createElement('span');
      t.className = 'tab' + (i === 0 ? ' active' : '');
      t.dataset.scope = s;
      t.textContent = s === '__all__' ? 'All' : s.replace('__squad__','').replace('_',' ');
      tabBar.appendChild(t);
    });
    bindTabs();
  }
  renderNgrams();

  const cl = D.clusters || {};
  document.getElementById('clusters-status').textContent = (cl.engine ? ('Engine: ' + cl.engine + (cl.note ? ' — ' + cl.note : '')) : 'No cluster data');
  const cScope = agent || '__all__';
  const cKey = Object.keys(cl).find(k => k !== 'engine' && k !== 'note' && (k === cScope || k === '__all__'));
  const cData = cKey ? cl[cKey] : null;
  const cArr = Array.isArray(cData) ? cData : [];
  document.getElementById('clusters-list').innerHTML = cArr.length === 0 ? '<p class="meta">No clusters for this filter.</p>' :
    cArr.map(c => `<div class="cluster"><b>cluster_${c.id}</b> (${c.count} turns) — ${escHtml(c.top_terms||'')}</div>`).join('');
}

['f-squad','f-agent','f-model','f-from','f-to'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', render); });
try { render(); } catch(e) { console.error('[viewer] initial render failed:', e.message, e.stack); }
})();
</script>
</body>
</html>"""


def render_html(data: dict, out_dir: Path) -> None:
    """Write self-contained HTML report using the embedded template."""
    html = _REPORT_TEMPLATE.replace(
        "__DATA_JSON__",
        json.dumps(data, default=str)
    )
    html_path = out_dir / "index.html"
    html_path.write_text(html, encoding="utf-8")
    print(f"  - index.html ({len(html)} bytes)")


def write_report(
    per_agent: "pd.DataFrame",
    per_squad: "pd.DataFrame",
    args: argparse.Namespace,
    out_dir: Path,
    usage_df: "pd.DataFrame",
    tool_df: "pd.DataFrame",
    delegation_df: "pd.DataFrame",
    ngram_dict: dict,
    task_df: "pd.DataFrame",
    handover_graph: dict,
    clusters: dict,
) -> None:
    """Write full report artifacts (data.json + index.html)."""
    out_dir.mkdir(parents=True, exist_ok=True)

    # Build rows for the viewer
    rows = []
    if not usage_df.empty:
        for _, r in usage_df.iterrows():
            rows.append({
                "run_id": str(r.get("run_id", "")),
                "squad": str(r.get("squad", "")),
                "agent_key": str(r.get("agent_key", "")),
                "model": str(r.get("model", "")),
                "observed_at": str(r.get("observed_at", "")),
                "total_tokens": int((r.get("input_tokens", 0) or 0) + (r.get("output_tokens", 0) or 0)),
                "cost_usd": float(r.get("cost_usd", 0) or 0),
            })

    # Tools (sample up to 5000)
    tools = []
    tools_raw = []
    if not tool_df.empty:
        for _, r in tool_df.iterrows():
            entry = {
                "run_id": str(r.get("run_id", "")),
                "agent_key": str(r.get("agent_key", "")),
                "tool_name_raw": str(r.get("tool_name_raw", "")),
                "tool_name_canon": r.get("tool_name_canon"),
                "count": 1,
                "cost_usd": 0,
            }
            tools.append(entry)
            if not r.get("tool_name_canon"):
                tools_raw.append({
                    "run_id": str(r.get("run_id", "")),
                    "agent_key": str(r.get("agent_key", "")),
                    "tool_name_raw": str(r.get("tool_name_raw", "")),
                })
        # Cap at 5000
        if len(tools) > 5000:
            tools = tools[:5000]
            tools_raw = [t for t in tools_raw if any(
                t["run_id"] == tt["run_id"] for tt in tools
            )]

    # Delegations
    delegations = []
    if not delegation_df.empty:
        for _, r in delegation_df.iterrows():
            delegations.append({
                "parent_run_id": str(r.get("parent_run_id", "")),
                "parent_agent": str(r.get("parent_agent", "")),
                "child_agent": str(r.get("child_agent", "")),
                "observed_at": str(r.get("observed_at", "")),
                "child_cost_usd": float(r.get("child_cost_usd", 0) or 0),
                "source": str(r.get("source", "")),
            })

    # Tasks
    tasks = []
    if not task_df.empty:
        for _, r in task_df.iterrows():
            tasks.append({
                "task_id": str(r.get("task_id", "")),
                "squad": str(r.get("squad", "")),
                "runs": int(r.get("runs", 0) or 0),
                "cost_usd": float(r.get("cost_usd", 0) or 0),
                "tokens": int(r.get("tokens", 0) or 0),
                "first_started": str(r.get("first_started", "")),
            })

    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "filters": {
            "squad": args.squad,
            "agent": args.agent,
            "days": args.days,
        },
        "rows": rows,
        "tools": tools,
        "tools_raw": tools_raw,
        "delegations": delegations,
        "handover_graph": handover_graph,
        "tasks": tasks,
        "ngrams": ngram_dict,
        "clusters": clusters,
    }

    data_path = out_dir / "data.json"
    data_path.write_text(json.dumps(_sanitize(data), indent=2, default=str, allow_nan=False), encoding="utf-8")
    print(f"  - data.json ({len(json.dumps(_sanitize(data), default=str))} bytes, {len(rows)} rows)")

    render_html(_sanitize(data), out_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Agent Intelligence — analyze telemetry data from Claude Code runs."
    )
    parser.add_argument(
        "--db",
        default=None,
        help="Path to telemetry.sqlite (default: auto-detect via LA_TELEMETRY_DB, "
        "LA_TELEMETRY_HOME, %%LOCALAPPDATA%%, or ~/.local/share)",
    )
    parser.add_argument(
        "--squad",
        default=None,
        help="Filter to a specific squad name (e.g. 'dev', 'review')",
    )
    parser.add_argument(
        "--agent",
        default=None,
        help="Filter to a specific agent key (e.g. 'lead', 'implementer')",
    )
    parser.add_argument(
        "--days",
        default=30,
        type=int,
        help="Lookback window in days (default: 30)",
    )
    parser.add_argument(
        "--out",
        default="./report",
        help="Output directory for report artifacts (default: ./report)",
    )
    parser.add_argument(
        "--skip-ngrams",
        action="store_true",
        help="Skip n-gram analysis (faster, avoids reading transcripts)",
    )
    parser.add_argument(
        "--skip-embeddings",
        action="store_true",
        help="Skip embedding/clustering (faster, avoids model download)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    db_path = resolve_db_path(args)
    out_dir = Path(args.out)

    print(f"DB path: {db_path}")
    print(f"Output:  {out_dir.resolve()}")
    print(f"Filters: squad={args.squad or '(all)'}, agent={args.agent or '(all)'}, days={args.days}")
    print()

    if not Path(db_path).exists():
        print(f"WARNING: Database not found at {db_path}")
        print("Create empty DataFrames and continue with stub report.\n")
        import pandas as pd
        per_agent = pd.DataFrame(
            index=pd.Index([], name="agent_key"),
            columns=["turns", "total_tokens", "cost_usd", "runs"],
        ).astype({"turns": int, "total_tokens": int, "cost_usd": float, "runs": int})
        per_squad = pd.DataFrame(
            index=pd.Index([], name="squad"),
            columns=["turns", "total_tokens", "cost_usd", "runs"],
        ).astype({"turns": int, "total_tokens": int, "cost_usd": float, "runs": int})
        usage_df = pd.DataFrame()
        tool_df = pd.DataFrame()
        delegation_df = pd.DataFrame()
        task_df = pd.DataFrame()
        ngram_dict = {}
        handover_graph = {"|": {}}
        clusters = {"engine": None, "note": "no database"}
        warnings = [f"Database not found at {db_path}"]
    else:
        # Load core usage data
        usage_df, warnings = load_usage_facts(db_path, args)
        per_agent = summarize_per_agent(usage_df)
        per_squad = summarize_per_squad(usage_df)

        # Load tool facts (may be empty)
        tool_df, tw = load_tool_facts(db_path, args)
        warnings.extend(tw)

        # Load delegation links (may be empty)
        delegation_df, dw = load_delegation_links(db_path, args)
        warnings.extend(dw)

        # Load task links
        task_df, tkw = load_task_links(db_path, args)
        warnings.extend(tkw)

        # Compute handover graph
        handover_graph = compute_handover_graph(delegation_df)

        # N-gram analysis (optional, can be skipped)
        if args.skip_ngrams:
            ngram_dict = {}
            print("  [skip] n-gram analysis skipped (--skip-ngrams)")
        else:
            ngram_dict, nw = load_ngrams(db_path, args)
            warnings.extend(nw)

        # Embeddings & clustering (optional, can be skipped)
        if args.skip_embeddings:
            clusters = {"engine": None, "note": "skipped: --skip-embeddings"}
            print("  [skip] embedding/clustering skipped (--skip-embeddings)")
        else:
            # Build per-agent text corpus from usage_df source_paths
            per_agent_texts: dict[str, list[str]] = {}
            if not usage_df.empty:
                for _, row in usage_df.iterrows():
                    agent = row.get("agent_key", "")
                    sp = row.get("source_path", "")
                    if agent and sp and Path(sp).exists():
                        per_agent_texts.setdefault(agent, [])
                        # Sample up to 200 turns per agent
                        if len(per_agent_texts[agent]) < 200:
                            # Read the assistant text from the transcript
                            try:
                                with open(sp, "r", encoding="utf-8", errors="replace") as f:
                                    for line in f:
                                        if len(per_agent_texts[agent]) >= 200:
                                            break
                                        line = line.strip()
                                        if not line:
                                            continue
                                        try:
                                            obj = json.loads(line)
                                        except json.JSONDecodeError:
                                            continue
                                        if obj.get("type") != "assistant":
                                            continue
                                        msg = obj.get("message", {})
                                        content_blocks = msg.get("content", [])
                                        text_parts = []
                                        if isinstance(content_blocks, list):
                                            for block in content_blocks:
                                                if isinstance(block, dict) and block.get("type") == "text":
                                                    text_parts.append(block.get("text", ""))
                                        elif isinstance(content_blocks, str):
                                            text_parts.append(content_blocks)
                                        full_text = " ".join(text_parts)
                                        if len(full_text.strip()) >= 20:
                                            per_agent_texts[agent].append(full_text)
                            except (OSError, json.JSONDecodeError):
                                continue
            clusters = embed_and_cluster(per_agent_texts, out_dir=out_dir)

    for w in warnings:
        print(f"NOTE: {w}")
    print()

    print_summary(per_agent, per_squad)
    write_report(per_agent, per_squad, args, out_dir, usage_df, tool_df, delegation_df, ngram_dict, task_df, handover_graph, clusters)

    print(f"\nReport written to {out_dir.resolve()}/")
    print(f"  - data.json")
    print(f"  - index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
