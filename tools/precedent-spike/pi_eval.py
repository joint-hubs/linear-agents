"""Shared evaluation helpers for the precedent-index F0 spike (T0.3-T0.5).

* load_cases()      in-scope cases as a DataFrame with parsed times
* load_vec(name)    L2-normalised embedding matrix + ids from .spike-precedent/vec
* bm25_scores()     BM25 over ticket text (Polish diacritics folded, incl. l-stroke)
* build_labels()    proxy relevance between cases: shared non-hub files, same epic, explicit relation
* evaluate()        time-split retrieval metrics (Hit@k, Recall@k, capped Recall@k, MRR, nDCG@10)

Time split: a query (ticket A, at A.created) may only retrieve cases that were CLOSED (Done) before A was
created - the situation of a new ticket arriving. No case ever sees its own future.
Leakage rule: a retriever is never scored against a label derived from its own input signal.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

from common import DATA, read_jsonl

VEC = DATA / "vec"
KS = (1, 3, 5, 10)


# --------------------------------------------------------------------------- data
def load_cases(scope_only: bool = True) -> pd.DataFrame:
    rows = []
    for c in read_jsonl(DATA / "corpus.jsonl"):
        if scope_only and not c["scope"]["in_scope"]:
            continue
        g = c.get("git") or {}
        rows.append(dict(
            id=c["id"], team=c["team"], project=c.get("project"), title=c.get("title") or "",
            desc=c.get("description") or "", state_type=c.get("state_type"), labels=c.get("labels") or [],
            parent=c.get("parent"), relations=c.get("relations") or [], created=c.get("created"),
            completed=c.get("completed"), v0=c["quality"]["v0"], v1=c["quality"]["v1"], v2=c["quality"]["v2"],
            files=g.get("files") or [], funcs=g.get("funcs") or [], repos=g.get("repos") or {},
            n_commits=g.get("n_commits") or 0, effort=c.get("effort") or {}, tel=c.get("tel"),
            era=(c.get("tel") or {}).get("era"), settled=(c.get("tel") or {}).get("settled"),
            reopened=c.get("reopened", False), estimate=c.get("estimate"), n_comments=len(c.get("comments") or []),
        ))
    df = pd.DataFrame(rows)
    df["created_ts"] = pd.to_datetime(df["created"], utc=True)
    df["completed_ts"] = pd.to_datetime(df["completed"], utc=True)
    return df.sort_values("created_ts").reset_index(drop=True)


def load_vec(name: str):
    meta = json.loads((VEC / f"{name}.json").read_text(encoding="utf8"))
    d = meta["dims"]
    m = np.fromfile(VEC / f"{name}.f32", dtype="<f4").reshape(-1, d).astype(np.float64)
    m /= np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-12)
    return meta["ids"], m, meta


# --------------------------------------------------------------------------- lexical baseline
_FOLD = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "đ": "d"})


def fold(s: str) -> str:
    s = s.translate(_FOLD)
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch)).lower()


TOK = re.compile(r"[a-z0-9_]{2,}")


def tokens(text: str) -> list[str]:
    return TOK.findall(fold(text))


def bm25_matrix(texts: list[str], k1: float = 1.2, b: float = 0.75):
    """Return (scores_fn, W) with W = doc x term BM25 weights; score(q, d) = sum over q terms of W[d, t]."""
    from scipy import sparse
    from sklearn.feature_extraction.text import CountVectorizer

    cv = CountVectorizer(tokenizer=tokens, lowercase=False, token_pattern=None)
    X = cv.fit_transform(texts).tocsr().astype(np.float64)
    N = X.shape[0]
    df = np.asarray((X > 0).sum(axis=0)).ravel()
    idf = np.log(1 + (N - df + 0.5) / (df + 0.5))
    dl = np.asarray(X.sum(axis=1)).ravel()
    avg = dl.mean()
    W = X.copy()
    W.data = W.data * (k1 + 1) / (W.data + k1 * (1 - b + b * np.repeat(dl / avg, np.diff(W.indptr))))
    W = W.multiply(idf[None, :]).tocsr()
    Q = (X > 0).astype(np.float64)  # binary query terms
    return (Q @ W.T).toarray()


# --------------------------------------------------------------------------- proxy labels
HUB_DF = 0.10          # a file touched by > 10% of cases-with-files is a hub (package.json, STATE.md, ...)
MIN_SHARED = 2         # shared non-hub files needed for a positive
LOCK = re.compile(r"(package-lock\.json|\.lock$|\.codegraph/|node_modules/|\.min\.)")


def build_labels(df: pd.DataFrame):
    """Return dict of boolean matrices: files, epic, relation, any (row = query, col = candidate)."""
    n = len(df)
    idx = {i: k for k, i in enumerate(df["id"])}
    with_files = [k for k in range(n) if df.at[k, "files"]]
    dfreq = Counter(f for k in with_files for f in set(df.at[k, "files"]) if not LOCK.search(f))
    hubs = {f for f, c in dfreq.items() if c > HUB_DF * max(len(with_files), 1)}
    fsets = [set(f for f in df.at[k, "files"] if not LOCK.search(f) and f not in hubs) for k in range(n)]
    F = np.zeros((n, n), dtype=bool)
    for a in range(n):
        if not fsets[a]:
            continue
        for b in range(a + 1, n):
            if len(fsets[a] & fsets[b]) >= MIN_SHARED:
                F[a, b] = F[b, a] = True
    E = np.zeros((n, n), dtype=bool)
    par = df["parent"].fillna("").to_numpy()
    for a in range(n):
        if par[a]:
            E[a] = (par == par[a])
            E[a, a] = False
    R = np.zeros((n, n), dtype=bool)
    for a in range(n):
        for r in df.at[a, "relations"]:
            o = r.get("other")
            if o in idx:
                R[a, idx[o]] = R[idx[o], a] = True
    np.fill_diagonal(F, False)
    np.fill_diagonal(R, False)
    return dict(files=F, epic=E, relation=R, any=F | E | R), dict(hubs=sorted(hubs), n_with_files=len(with_files))


# --------------------------------------------------------------------------- metrics
def candidate_mask(df: pd.DataFrame, i: int) -> np.ndarray:
    """Cases closed (Done) strictly before query i was created, excluding i."""
    m = (df["v0"].to_numpy()) & (df["completed_ts"] < df.at[i, "created_ts"]).to_numpy()
    m[i] = False
    return m


def query_metrics(order: np.ndarray, pos: np.ndarray) -> dict:
    """order = candidate indices best->worst; pos = boolean over ALL cases (positives)."""
    rel = pos[order]
    P = int(rel.sum())
    out = {"P": P}
    for k in KS:
        top = rel[:k]
        out[f"hit@{k}"] = float(top.any())
        out[f"rec@{k}"] = float(top.sum() / P) if P else np.nan
        out[f"recc@{k}"] = float(top.sum() / min(P, k)) if P else np.nan
    ranks = np.flatnonzero(rel)
    out["mrr"] = float(1.0 / (ranks[0] + 1)) if len(ranks) else 0.0
    gains = rel[:10].astype(float)
    dcg = float((gains / np.log2(np.arange(2, len(gains) + 2))).sum())
    ideal = np.sort(rel.astype(float))[::-1][:10]
    idcg = float((ideal / np.log2(np.arange(2, len(ideal) + 2))).sum())
    out["ndcg@10"] = dcg / idcg if idcg > 0 else np.nan
    return out


def evaluate(df: pd.DataFrame, score: np.ndarray | None, labels: np.ndarray, query_ok: np.ndarray, *,
             rng: np.random.Generator | None = None, mode: str = "score", exclude: np.ndarray | None = None) -> pd.DataFrame:
    """Per-query metrics. mode: 'score' (use score matrix), 'random', 'recency'. Queries without a positive
    candidate are skipped (the D14 threshold is defined on cases with >= 1 positive)."""
    rows = []
    comp = np.array([t.timestamp() if pd.notna(t) else 0.0 for t in df["completed_ts"]])
    for i in np.flatnonzero(query_ok):
        cm = candidate_mask(df, i)
        if exclude is not None:
            cm = cm & ~exclude[i]
        cand = np.flatnonzero(cm)
        if len(cand) == 0 or not labels[i, cand].any():
            continue
        if mode == "random":
            order = cand[rng.permutation(len(cand))]
        elif mode == "recency":
            order = cand[np.argsort(-comp[cand], kind="stable")]
        else:
            order = cand[np.argsort(-score[i, cand], kind="stable")]
        m = query_metrics(order, labels[i])
        m["i"] = int(i)
        m["n_cand"] = int(len(cand))
        rows.append(m)
    return pd.DataFrame(rows)


def summarize(m: pd.DataFrame, n_boot: int = 2000, seed: int = 7) -> dict:
    """Mean of each metric with a percentile bootstrap CI over queries."""
    rng = np.random.default_rng(seed)
    cols = [f"{p}@{k}" for p in ("hit", "rec", "recc") for k in KS] + ["mrr", "ndcg@10"]
    out = {"n_queries": int(len(m))}
    if not len(m):
        return out
    for c in cols:
        x = m[c].to_numpy(dtype=float)
        x = x[~np.isnan(x)]
        if not len(x):
            continue
        boots = rng.choice(x, size=(n_boot, len(x)), replace=True).mean(axis=1)
        out[c] = (float(x.mean()), float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5)))
    return out


def rrf(*scores: np.ndarray, k: int = 60, weights: list[float] | None = None) -> np.ndarray:
    """Reciprocal Rank Fusion over score matrices (rank computed per row over all columns)."""
    weights = weights or [1.0] * len(scores)
    out = np.zeros_like(scores[0], dtype=float)
    for s, w in zip(scores, weights):
        ranks = np.argsort(np.argsort(-s, axis=1, kind="stable"), axis=1, kind="stable") + 1
        out += w / (k + ranks)
    return out
