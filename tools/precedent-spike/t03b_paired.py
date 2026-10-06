#!/usr/bin/env python
"""F0 / T0.3b - (1) paired bootstrap: does dense / hybrid retrieval beat BM25? (2) cross-epic retrieval.

Cross-epic: candidates that share the query's parent epic are REMOVED (siblings are the easy case), and positives
are shared-file / explicit-relation precedents from other epics or projects. This is the hard, useful case:
"has anything like this been solved before, elsewhere?"
Usage: python t03b_paired.py
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from common import DATA, utf8_stdout
from pi_eval import bm25_matrix, build_labels, evaluate, load_cases, load_vec, rrf, summarize

RES = DATA / "results"
TOP = ["google/gemini-embedding-2", "mistralai/codestral-embed-2505", "voyageai/voyage-code-4", "voyageai/voyage-4-large",
       "perplexity/pplx-embed-v1-4b", "qwen/qwen3-embedding-8b"]


def paired(a: pd.DataFrame, b: pd.DataFrame, col: str, n_boot=4000, seed=7):
    m = a[["i", col]].merge(b[["i", col]], on="i", suffixes=("_a", "_b")).dropna()
    d = (m[f"{col}_a"] - m[f"{col}_b"]).to_numpy()
    rng = np.random.default_rng(seed)
    boots = rng.choice(d, size=(n_boot, len(d)), replace=True).mean(axis=1)
    return float(d.mean()), float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5)), float((d > 0).mean()), float((d < 0).mean()), len(d)


def main():
    utf8_stdout()
    df_all = load_cases()
    models = {}
    for p in sorted(DATA.glob("vec/*__problem__native.json")):
        ids, M, meta = load_vec(p.stem)
        models[meta["model"]] = (dict(zip(ids, range(len(ids)))), M)
    common = set(df_all["id"])
    for ix, _ in models.values():
        common &= set(ix)
    df = df_all[df_all["id"].isin(common)].reset_index(drop=True)
    n = len(df)
    labels, _ = build_labels(df)
    text_len = (df["title"].str.len() + df["desc"].str.len()).to_numpy()
    query_ok = (text_len >= 200) & df["v0"].to_numpy()
    par = df["parent"].fillna("").to_numpy()
    same_par = (par[:, None] == par[None, :]) & (par[:, None] != "")
    same_proj = (df["project"].fillna("(none)").to_numpy()[:, None] == df["project"].fillna("(none)").to_numpy()[None, :])
    bm = bm25_matrix([f"{t}\n\n{d}" for t, d in zip(df["title"], df["desc"])])
    np.fill_diagonal(bm, -1e9)
    S = {"bm25": bm}
    for name, (ix, M) in models.items():
        E = M[[ix[i] for i in df["id"]]]
        X = E @ E.T
        np.fill_diagonal(X, -1e9)
        S[name] = X
        S[f"hybrid[{name}]"] = rrf(bm, X)

    out = {}
    lines = ["# T0.3b paired comparison and cross-epic retrieval", ""]
    settings = {
        "all pairs (proxy any)": (labels["any"], None),
        "cross-epic (same-parent candidates removed; proxy = files|relation)": (labels["files"] | labels["relation"], same_par),
        "cross-project (same-project candidates removed; proxy = files|relation)": (labels["files"] | labels["relation"], same_proj),
    }
    for sname, (lab, excl) in settings.items():
        res = {k: evaluate(df, v, lab, query_ok, exclude=excl) for k, v in S.items()}
        base = res["bm25"]
        lines += [f"## {sname}", "", f"queries with >=1 positive: {len(base)}", "",
                  "| method | Recall@5 capped [95% CI] | Hit@5 | MRR | delta vs BM25 (capped recall@5) [95% CI] | queries better / worse |", "|---|---|---|---|---|---|"]
        for name in ["bm25"] + [m for m in TOP if m in models] + [f"hybrid[{m}]" for m in TOP if m in models]:
            r = res[name]
            s = summarize(r)
            if not len(r):
                continue
            if name == "bm25":
                lines.append(f"| bm25 | {s['recc@5'][0]:.3f} [{s['recc@5'][1]:.3f}-{s['recc@5'][2]:.3f}] | {s['hit@5'][0]:.3f} | {s['mrr'][0]:.3f} | - | - |")
            else:
                d = paired(r, base, "recc@5")
                lines.append(f"| {name} | {s['recc@5'][0]:.3f} [{s['recc@5'][1]:.3f}-{s['recc@5'][2]:.3f}] | {s['hit@5'][0]:.3f} | {s['mrr'][0]:.3f} | "
                             f"{d[0]:+.3f} [{d[1]:+.3f}, {d[2]:+.3f}] | {d[3]:.2f} / {d[4]:.2f} |")
        lines.append("")
        out[sname] = {k: summarize(v) for k, v in res.items()}
    (RES / "t03b_paired.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    (RES / "t03b_paired.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
