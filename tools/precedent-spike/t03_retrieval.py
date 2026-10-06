#!/usr/bin/env python
"""F0 / T0.3 - retrieval evaluation with a time split, baselines and every embedded model.

Usage: python t03_retrieval.py [--facet problem] [--queries v0|all] [--min-desc 200]
Writes .spike-precedent/results/t03_retrieval.{json,md}
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from common import DATA, utf8_stdout
from pi_eval import (KS, bm25_matrix, build_labels, evaluate, load_cases, load_vec, rrf, summarize)

RES = DATA / "results"
RES.mkdir(exist_ok=True)


def fmt(t):
    return f"{t[0]:.3f} [{t[1]:.3f}-{t[2]:.3f}]" if isinstance(t, tuple) else str(t)


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--facet", default="problem")
    ap.add_argument("--queries", default="v0")
    ap.add_argument("--min-desc", type=int, default=200)
    args = ap.parse_args()

    df_all = load_cases()
    # vectors per model (native dims, no tag), aligned on the common id set
    metas = sorted(DATA.glob(f"vec/*__{args.facet}__native.json"))
    models = {}
    for p in metas:
        ids, M, meta = load_vec(p.stem)
        models[meta["model"]] = (dict(zip(ids, range(len(ids)))), M, meta)
    common = set(df_all["id"])
    for _, (ix, _, _) in models.items():
        common &= set(ix)
    df = df_all[df_all["id"].isin(common)].reset_index(drop=True)
    n = len(df)
    print(f"cases in common id set: {n} (models: {len(models)})", file=sys.stderr)

    labels, lab_info = build_labels(df)
    text_len = (df["title"].str.len() + df["desc"].str.len()).to_numpy()
    query_ok = (text_len >= args.min_desc)
    if args.queries == "v0":
        query_ok &= df["v0"].to_numpy()

    texts = [f"{t}\n\n{d}" for t, d in zip(df["title"], df["desc"])]
    bm = bm25_matrix(texts)
    np.fill_diagonal(bm, -1e9)

    scores = {"bm25": bm}
    for name, (ix, M, meta) in models.items():
        order = [ix[i] for i in df["id"]]
        E = M[order]
        S = E @ E.T
        np.fill_diagonal(S, -1e9)
        scores[name] = S
    # hybrid: RRF of bm25 with each dense model
    for name in list(models):
        scores[f"hybrid[bm25+{name}]"] = rrf(bm, scores[name])

    comp_rank = df["completed_ts"].rank(method="first").fillna(0).to_numpy()
    same_proj = (df["project"].fillna("(none)").to_numpy()[:, None] == df["project"].fillna("(none)").to_numpy()[None, :]).astype(float)
    scores["same_project_recency"] = same_proj * 10 + comp_rank[None, :] / (n + 1)

    out = {"n_cases": n, "n_query_candidates": int(query_ok.sum()), "label_info": {k: (v if k != "hubs" else v[:20]) for k, v in lab_info.items()},
           "proxies": {}}
    rng = np.random.default_rng(7)
    tables = []
    for proxy in ("any", "files", "epic", "relation"):
        lab = labels[proxy]
        res = {}
        rnd = pd.concat([evaluate(df, None, lab, query_ok, rng=rng, mode="random") for _ in range(30)]).groupby("i").mean().reset_index()
        res["random"] = summarize(rnd)
        res["recency"] = summarize(evaluate(df, None, lab, query_ok, mode="recency"))
        for name, S in scores.items():
            res[name] = summarize(evaluate(df, S, lab, query_ok))
        out["proxies"][proxy] = res
        nq = res["recency"]["n_queries"]
        rows = []
        for name, r in res.items():
            if not nq or "hit@5" not in r:
                continue
            rows.append((name, r["hit@5"], r["rec@5"], r["recc@5"], r["mrr"], r["ndcg@10"]))
        rows.sort(key=lambda x: -x[3][0])
        tables.append((proxy, nq, rows))

    md = [f"# T0.3 retrieval ({args.facet}, queries={args.queries}, time split)", ""]
    md.append(f"cases={n}; query candidates={int(query_ok.sum())}; hub files={len(lab_info['hubs'])}")
    for proxy, nq, rows in tables:
        md += ["", f"## proxy = {proxy} (queries with >=1 positive candidate: {nq})", "",
               "| method | Hit@5 | Recall@5 | Recall@5 capped | MRR | nDCG@10 |", "|---|---|---|---|---|---|"]
        for name, h, r, rc, mrr, nd in rows:
            md.append(f"| {name} | {fmt(h)} | {fmt(r)} | {fmt(rc)} | {fmt(mrr)} | {fmt(nd)} |")
    (RES / "t03_retrieval.md").write_text("\n".join(md) + "\n", encoding="utf8")
    (RES / "t03_retrieval.json").write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str), encoding="utf8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
