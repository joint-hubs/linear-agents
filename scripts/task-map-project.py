#!/usr/bin/env python3
"""scripts/task-map-project.py — out-of-process projection worker for the
semantic task map (PRD §11, P4 slice).

Protocol (controlled child of scripts/task-map.mjs): one JSON request on
stdin, one JSON response on stdout, everything else (logging, errors) on
stderr. The parent runs this file with `python -E -P` (no environment
variables smuggled in, no cwd on sys.path; the user site-packages stays
enabled because that is where the pinned umap-learn stack commonly lives)
and SIGKILLs it on timeout, so a wedged numba/UMAP import can never hang
the build.

Request (either mode):
  {"mode": "fit"|"pca", "vectors": [[...], ...],
   "params": {"seed": 42, "nNeighbors": k, "metric": "cosine", "kind": ...},
   "request": {...}, "outPath": "<cacheDir>/projection-v<N>.pkl"}
  {"mode": "transform", "vectors": [[...], ...], "modelPath": "...",
   "request": {...}}

Response:
  {"mode": ..., "coords": [[x, y], ...], "libraryVersions": {...}}
  or {"error": "dependency_missing"} / {"error": "invalid_request"} /
     {"error": "projection_failed"}

Security contract: the fitted model is pickled ONLY into the task-map cache
dir chosen by the caller, and it is loaded back ONLY from a path that the
parent has already validated against that same cache dir
(`validatedModelPath` in task-map.mjs). A user-supplied pickle path never
reaches this process. The unpickling here is therefore restricted to
artifacts this pipeline itself produced.

Determinism contract (PRD §11): UMAP is fitted with a fixed seed 42, cosine
metric, n_neighbors=min(15, N-1), init="random"; the seed, parameters and
library versions are returned so the parent can persist them with each
projection version. No determinism is claimed across library versions or
hardware — only the saved (seed, version, parameters) tuple plus the cached
artifacts are stable. Tiny corpora (N<4) use a deterministic PCA
(sklearn, full SVD solver) clearly marked via kind="pca"; a single point is
handled by the parent as kind="list" — no fake clusters are ever produced.

Errors are sanitized: messages carry no file contents and no paths beyond
the mode name. `dependency_missing` is distinct from a data failure so the
parent can report "explicitly unavailable" instead of inventing a fallback.
"""

from __future__ import annotations

import hashlib
import json
import pickle
import sys
from typing import Any

SEED = 42
METRIC = "cosine"
MAX_NEIGHBORS = 15


def emit(response: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def fail(code: str) -> None:
    emit({"error": code})


def library_versions() -> dict[str, str]:
    import numpy
    import sklearn

    versions = {"numpy": numpy.__version__, "sklearn": sklearn.__version__}
    try:
        import umap

        versions["umap-learn"] = umap.__version__
    except Exception:  # noqa: BLE001 - version reporting is best effort
        pass
    return versions


def l2_normalize(vectors: list[list[float]]) -> Any:
    import numpy as np

    matrix = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms


def fit_umap(vectors: list[list[float]], n_neighbors: int) -> tuple[Any, Any]:
    import umap

    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        metric=METRIC,
        init="random",
        random_state=SEED,
    )
    embedding = reducer.fit_transform(l2_normalize(vectors))
    return reducer, embedding


def fit_pca(vectors: list[list[float]]) -> tuple[Any, Any]:
    from sklearn.decomposition import PCA

    reducer = PCA(n_components=2, svd_solver="full", random_state=SEED)
    embedding = reducer.fit_transform(l2_normalize(vectors))
    return reducer, embedding


def coords_list(embedding: Any) -> list[list[float]]:
    return [[float(row[0]), float(row[1])] for row in embedding]


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
    except Exception:  # noqa: BLE001 - malformed stdin is a request error
        fail("invalid_request")
        return

    mode = request.get("mode")
    vectors = request.get("vectors")
    out_path = request.get("outPath")
    model_path = request.get("modelPath")
    params = request.get("params") or {}

    if mode not in ("fit", "pca", "transform") or not isinstance(vectors, list) or not vectors:
        fail("invalid_request")
        return

    # Cache-dir confinement: this process only ever writes the pickle to the
    # outPath the parent derived from its own validated cache dir.
    if mode in ("fit", "pca"):
        if not isinstance(out_path, str) or not out_path.endswith(".pkl"):
            fail("invalid_request")
            return

    try:
        if mode == "transform":
            if not isinstance(model_path, str):
                fail("invalid_request")
                return
            with open(model_path, "rb") as handle:
                artifact = pickle.load(handle)
            if not isinstance(artifact, dict) or "reducer" not in artifact:
                fail("invalid_request")
                return
            reducer = artifact["reducer"]
            embedding = reducer.transform(l2_normalize(vectors))
            emit({
                "mode": mode,
                "coords": coords_list(embedding),
                "libraryVersions": library_versions(),
            })
            return

        n = len(vectors)
        n_neighbors = max(1, min(MAX_NEIGHBORS, n - 1))
        if mode == "fit":
            reducer, embedding = fit_umap(vectors, n_neighbors)
        else:
            reducer, embedding = fit_pca(vectors)

        payload = pickle.dumps({
            "kind": mode,
            "reducer": reducer,
            "params": {
                "seed": SEED,
                "nNeighbors": n_neighbors,
                "metric": METRIC,
                "init": "random" if mode == "fit" else "pca-full-svd",
            },
        })
        # sha256 is written next to the pickle so the parent can pin the
        # registry to the exact artifact it loaded.
        digest = hashlib.sha256(payload).hexdigest()
        with open(out_path, "wb") as handle:
            handle.write(payload)
        emit({
            "mode": mode,
            "coords": coords_list(embedding),
            "libraryVersions": library_versions(),
            "modelSha256": digest,
        })
    except ImportError:
        # umap-learn / sklearn / numpy missing: an explicit "unavailable",
        # not a reason to fabricate a projection.
        fail("dependency_missing")
    except Exception:  # noqa: BLE001 - sanitized: details stay in stderr
        import traceback

        traceback.print_exc(file=sys.stderr)
        fail("projection_failed")


if __name__ == "__main__":
    main()
