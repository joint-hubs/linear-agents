"""MCP server exposing ThoughtMap to Fenix leads — READ-ONLY, five tools.

Provenance: adapted for Fenix on 2026-10-14 from the registered adapter
    jointhubs-os/infra/mcp-chromadb/server.py
(source tree of the user, read-only reuse). The five tools and their logic
follow the original; this copy changes only the defaults/bounds listed below.
User scope: ThoughtMap ONLY — no Google Workspace, no pipeline control, no
rerun, no write endpoints, no Docker socket.

Dependencies: python with `mcp` and `requests` (probe hint says:
pip install 'mcp' requests). On a missing dependency the import below fails
with a clear stderr message and exit code 3 — the caller (POST
/api/tool-profiles/test) reports that as structured "python-unavailable".

Environment variables (Fenix container defaults — the containers live on the
thoughtmap_default docker network; NEVER point these at localhost, inside the
Fenix container localhost is Fenix itself):
    THOUGHTMAP_API_URL     default http://thoughtmap-app:8585
    THOUGHTMAP_CLUSTERS    default /fenix-integrations/thoughtmap/clusters.json
                           (read-only artifact; later mounted by the parent
                           as a SINGLE FILE — the path is fixed, the mount
                           decision belongs to the lead's compose layer)
    OLLAMA_BASE_URL        default http://thoughtmap-ollama:11434
    OLLAMA_EMBEDDING_MODEL default qwen3-embedding:8b
                           (installed in the container: qwen3-embedding:8b,
                           embeddinggemma:latest, nomic-embed-text:v1.5)
    THOUGHTMAP_TIMEOUT_S   per-request HTTP timeout, default 30, clamped 1..120

Bounds added over the original: base URLs must be absolute http(s) without
embedded credentials; search queries / text inputs are length-capped; result
counts are clamped; clusters.json must be a JSON top-level LIST (clear error
otherwise). Until a real parent mount is verified, tools that depend on
clusters.json/Ollama report clear configured-unavailable errors rather than
pretending success.
"""

from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse

try:
    import requests
    from mcp.server.fastmcp import FastMCP
except ImportError as _exc:  # clear configured-unavailable, not a stack trace
    sys.stderr.write(
        "server-thoughtmap.py requires the 'mcp' and 'requests' packages "
        f"(pip install 'mcp' requests): {_exc}\n"
    )
    sys.exit(3)

# ─── Resolve paths ───────────────────────────────────────────────────────────

THOUGHTMAP_API_URL = os.environ.get("THOUGHTMAP_API_URL", "http://thoughtmap-app:8585")
CLUSTERS_PATH = os.environ.get("THOUGHTMAP_CLUSTERS", "/fenix-integrations/thoughtmap/clusters.json")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://thoughtmap-ollama:11434")
OLLAMA_EMBEDDING_MODEL = os.environ.get("OLLAMA_EMBEDDING_MODEL", "qwen3-embedding:8b")


def _clamp_timeout() -> int:
    try:
        raw = int(os.environ.get("THOUGHTMAP_TIMEOUT_S", "30"))
    except ValueError:
        return 30
    return min(max(raw, 1), 120)


_REQUEST_TIMEOUT_S = _clamp_timeout()

MAX_QUERY_CHARS = 2_000
MAX_TEXT_CHARS = 4_000


def _require_base_url(url: str, var: str) -> None:
    """Absolute http(s), no embedded credentials — auth never travels here."""
    parsed = urlparse(url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise RuntimeError(
            f"{var} must be an absolute http(s) URL without embedded credentials, got {url!r}"
        )


_require_base_url(THOUGHTMAP_API_URL, "THOUGHTMAP_API_URL")
_require_base_url(OLLAMA_BASE_URL, "OLLAMA_BASE_URL")

# ─── Math helpers ────────────────────────────────────────────────────────────


def _cosine_distance(a: list[float], b: list[float]) -> float:
    """Cosine distance between two vectors (0 = identical, 2 = opposite)."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 1.0
    return 1.0 - dot / (norm_a * norm_b)


# ─── HTTP helpers ────────────────────────────────────────────────────────────


def _api_get(path: str, params: dict | None = None) -> dict:
    """GET request to the ThoughtMap container API."""
    resp = requests.get(f"{THOUGHTMAP_API_URL}{path}", params=params, timeout=_REQUEST_TIMEOUT_S)
    resp.raise_for_status()
    return resp.json()


def _load_clusters() -> list[dict]:
    """Load cluster data from the read-only pipeline artifact.

    The artifact is a JSON top-level LIST of cluster objects — anything else
    is a clear configuration error, never a silent empty result.
    """
    if not os.path.exists(CLUSTERS_PATH):
        return []
    with open(CLUSTERS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(
            f"clusters.json must be a JSON top-level list, got {type(data).__name__}: {CLUSTERS_PATH}"
        )
    return data


def _embed_query(text: str) -> list[float]:
    """Embed a query string via Ollama (same model as the pipeline)."""
    resp = requests.post(
        f"{OLLAMA_BASE_URL}/api/embed",
        json={"model": OLLAMA_EMBEDDING_MODEL, "input": [text]},
        timeout=_REQUEST_TIMEOUT_S,
    )
    resp.raise_for_status()
    return resp.json()["embeddings"][0]


def _embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed multiple texts via Ollama."""
    return [_embed_query(text) for text in texts]


# ─── Cluster centroid cache ──────────────────────────────────────────────────

_cluster_centroids: dict[int, list[float]] | None = None


def _get_cluster_centroids() -> dict[int, list[float]]:
    """Compute HD centroids for all clusters by averaging representative text embeddings.

    Cached after first call. Uses representative_texts from clusters.json.
    """
    global _cluster_centroids
    if _cluster_centroids is not None:
        return _cluster_centroids

    clusters = _load_clusters()
    if not clusters:
        return {}

    _cluster_centroids = {}
    for c in clusters:
        reps = c.get("representative_texts", [])
        if not reps:
            continue
        # Truncate to 500 chars each to keep embedding fast
        reps_trimmed = [t[:500] for t in reps]
        embs = _embed_batch(reps_trimmed)
        # Average to get centroid
        dim = len(embs[0])
        centroid = [0.0] * dim
        for emb in embs:
            for j in range(dim):
                centroid[j] += emb[j]
        n = len(embs)
        centroid = [v / n for v in centroid]
        _cluster_centroids[c["cluster_id"]] = centroid

    return _cluster_centroids


# ─── MCP server ──────────────────────────────────────────────────────────────

mcp = FastMCP(
    "ThoughtMap",
    instructions=(
        "Read-only semantic search over the user's knowledge base — notes, "
        "journal entries, project docs. Use search_thoughts for finding "
        "relevant context. Use list_clusters and get_cluster to explore "
        "discovered topic groups. There is no write capability here."
    ),
)


@mcp.tool()
def search_thoughts(query: str, n_results: int = 10) -> list[dict]:
    """Search the user's personal knowledge base by semantic similarity.

    Returns the most relevant text chunks from notes, journal entries,
    project documents, and voice transcripts.

    Args:
        query: Natural language search query (e.g., "project blockers",
               "investment thesis", "health goals")
        n_results: Number of results to return (default 10, max 50)
    """
    query = query[:MAX_QUERY_CHARS]
    n_results = min(max(1, n_results), 50)

    try:
        data = _api_get("/api/search", params={"q": query, "n": str(n_results)})
    except requests.ConnectionError:
        return [{"error": "ThoughtMap container not reachable via THOUGHTMAP_API_URL (check the thoughtmap_default network)."}]
    except Exception as e:
        return [{"error": f"ThoughtMap API error: {e}"}]

    if "error" in data:
        return [{"error": data["error"]}]

    return data.get("results", [])


@mcp.tool()
def list_clusters(domain: str | None = None) -> list[dict]:
    """List all discovered thought clusters from the knowledge base.

    Each cluster is a group of semantically related notes/thoughts
    discovered by the ThoughtMap pipeline.

    Args:
        domain: Optional — filter by domain keyword (e.g., "fenix", "health").
                Case-insensitive partial match on the cluster label.
    """
    if domain:
        domain = domain[:200]
    try:
        params = {}
        if domain:
            params["domain"] = domain
        data = _api_get("/api/clusters", params=params)
    except requests.ConnectionError:
        return [{"error": "ThoughtMap container not reachable via THOUGHTMAP_API_URL."}]
    except Exception as e:
        return [{"error": f"ThoughtMap API error: {e}"}]

    if "error" in data:
        return [{"error": data["error"]}]

    return data.get("clusters", [])


@mcp.tool()
def get_cluster(cluster_id: int) -> dict:
    """Get details of a specific thought cluster including representative texts.

    Args:
        cluster_id: The cluster ID from list_clusters
    """
    try:
        data = _api_get(f"/api/clusters/{int(cluster_id)}")
    except requests.ConnectionError:
        return {"error": "ThoughtMap container not reachable via THOUGHTMAP_API_URL."}
    except Exception as e:
        return {"error": f"ThoughtMap API error: {e}"}

    return data


@mcp.tool()
def cluster_distances(cluster_id: int, top_n: int = 10) -> dict:
    """Compute cosine distances from one cluster to all others.

    Returns the nearest and farthest clusters, useful for understanding
    how topics relate to each other in the knowledge base.
    Requires THOUGHTMAP_CLUSTERS (clusters.json) and Ollama to be configured.

    Args:
        cluster_id: The cluster to measure from (use list_clusters to find IDs)
        top_n: Number of nearest and farthest clusters to return (default 10)
    """
    top_n = min(max(1, top_n), 50)
    try:
        clusters = _load_clusters()
    except FileNotFoundError:
        return {"error": "clusters.json not found — mount the read-only artifact at THOUGHTMAP_CLUSTERS."}
    except Exception as e:
        return {"error": f"clusters artifact unreadable at THOUGHTMAP_CLUSTERS: {e}"}
    if not clusters:
        return {"error": "No clusters found. The ThoughtMap pipeline has not produced clusters.json yet."}

    # Verify cluster exists
    target = None
    for c in clusters:
        if c["cluster_id"] == cluster_id:
            target = c
            break
    if target is None:
        return {"error": f"Cluster {cluster_id} not found."}

    try:
        centroids = _get_cluster_centroids()
    except Exception as e:
        return {"error": f"Failed to compute centroids (is Ollama reachable at OLLAMA_BASE_URL?): {e}"}

    if cluster_id not in centroids:
        return {"error": f"No centroid for cluster {cluster_id} (no representative texts)."}

    ref = centroids[cluster_id]
    id_to_label = {c["cluster_id"]: c.get("label", "") for c in clusters}
    id_to_size = {c["cluster_id"]: c["size"] for c in clusters}

    distances = []
    for cid, centroid in centroids.items():
        if cid == cluster_id:
            continue
        dist = _cosine_distance(ref, centroid)
        distances.append({
            "cluster_id": cid,
            "label": id_to_label.get(cid, ""),
            "size": id_to_size.get(cid, 0),
            "distance": round(dist, 4),
        })

    distances.sort(key=lambda x: x["distance"])

    return {
        "from_cluster": {
            "cluster_id": cluster_id,
            "label": target.get("label", ""),
            "size": target["size"],
        },
        "nearest": distances[:top_n],
        "farthest": list(reversed(distances[-top_n:])),
    }


@mcp.tool()
def text_distance(text_a: str, text_b: str) -> dict:
    """Compute semantic distance between two pieces of text.

    Embeds both texts using the same model as the knowledge base and
    returns their cosine distance (0 = identical meaning, ~1 = unrelated).
    Requires Ollama to be reachable at OLLAMA_BASE_URL.

    Args:
        text_a: First text to compare
        text_b: Second text to compare
    """
    text_a = text_a[:MAX_TEXT_CHARS]
    text_b = text_b[:MAX_TEXT_CHARS]
    try:
        emb_a = _embed_query(text_a)
        emb_b = _embed_query(text_b)
    except Exception as e:
        return {"error": f"Embedding failed (is Ollama reachable at OLLAMA_BASE_URL?): {e}"}

    dist = _cosine_distance(emb_a, emb_b)
    return {
        "distance": round(dist, 4),
        "similarity": round(1.0 - dist, 4),
        "text_a_preview": text_a[:100],
        "text_b_preview": text_b[:100],
    }


# Filter at the MCP protocol boundary, independently for every process profile.
# An absent filter is the standalone adapter's full five-tool catalog.
_allowed_raw = os.environ.get("THOUGHTMAP_ALLOWED_TOOLS")
if _allowed_raw is not None:
    _allowed = json.loads(_allowed_raw)
    _known = {"search_thoughts", "list_clusters", "get_cluster", "cluster_distances", "text_distance"}
    if not isinstance(_allowed, list) or any(not isinstance(t, str) or t not in _known for t in _allowed):
        raise ValueError("Invalid THOUGHTMAP_ALLOWED_TOOLS profile")
    for _name in _known - set(_allowed):
        mcp.remove_tool(_name)

if __name__ == "__main__":
    mcp.run(transport="stdio")
