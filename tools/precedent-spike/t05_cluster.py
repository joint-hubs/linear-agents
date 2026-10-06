#!/usr/bin/env python
"""F0 / T0.5 - compare clustering algorithms on the ticket `problem` embeddings.

Methods: HDBSCAN (after PCA to 50 dims), agglomerative (average linkage, cosine distance threshold),
kNN-graph + Louvain (networkx). Metrics: cluster count, noise share, size distribution, silhouette (cosine),
bootstrap stability (ARI on 80% subsamples), agreement with Linear project / type label / epic.
Writes .spike-precedent/results/t05_cluster.{json,md} and cluster-review.md (titles; local only, git-ignored).

Usage: python t05_cluster.py [--model <id>] [--review-method louvain|hdbscan|agglo] [--review-config <key>]
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings

import numpy as np
import pandas as pd
from sklearn.cluster import HDBSCAN, AgglomerativeClustering
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score, silhouette_score

from common import DATA, utf8_stdout
from pi_eval import load_cases, load_vec

warnings.filterwarnings("ignore")
RES = DATA / "results"
RES.mkdir(exist_ok=True)
SEED = 7
TYPE_PRIORITY = ["bug", "feature", "tech", "chore", "spike", "docs", "test"]


def case_type(labels):
    for t in TYPE_PRIORITY:
        if t in labels:
            return t
    return "(none)"


def run_hdbscan(E, mcs):
    Z = PCA(n_components=min(50, E.shape[0] - 1), random_state=SEED).fit_transform(E)
    Z /= np.maximum(np.linalg.norm(Z, axis=1, keepdims=True), 1e-12)
    return HDBSCAN(min_cluster_size=mcs).fit_predict(Z)


def run_agglo(E, thr):
    return AgglomerativeClustering(n_clusters=None, distance_threshold=thr, metric="cosine", linkage="average").fit_predict(E)


def run_louvain(E, k, res):
    import networkx as nx

    S = E @ E.T
    np.fill_diagonal(S, -1)
    n = len(E)
    G = nx.Graph()
    G.add_nodes_from(range(n))
    nn = np.argsort(-S, axis=1)[:, :k]
    for i in range(n):
        for j in nn[i]:
            w = float(S[i, j])
            if w > 0:
                if G.has_edge(i, int(j)):
                    G[i][int(j)]["weight"] = max(G[i][int(j)]["weight"], w)
                else:
                    G.add_edge(i, int(j), weight=w)
    comms = nx.community.louvain_communities(G, weight="weight", resolution=res, seed=SEED)
    lab = np.full(n, -1)
    for c, members in enumerate(comms):
        for m in members:
            lab[m] = c
    return lab


def ari_nonnoise(a, b):
    m = (a >= 0) & (b >= 0)
    return adjusted_rand_score(a[m], b[m]) if m.sum() > 5 and len(set(a[m])) > 1 and len(set(b[m])) > 1 else np.nan


def evaluate_config(name, fn, E, df, types):
    lab = fn(E)
    nz = lab >= 0
    k = len(set(lab[nz]))
    sizes = pd.Series(lab[nz]).value_counts()
    row = dict(config=name, n_clusters=k, noise=float(1 - nz.mean()), size_median=float(sizes.median()) if k else 0,
               size_max=int(sizes.max()) if k else 0, clusters_ge3=int((sizes >= 3).sum()) if k else 0)
    row["silhouette"] = float(silhouette_score(E[nz], lab[nz], metric="cosine")) if k >= 2 and nz.sum() > k else np.nan
    proj = df["project"].fillna("(none)").to_numpy()
    par = df["parent"].fillna("").to_numpy()
    m = nz
    row["nmi_project"] = float(normalized_mutual_info_score(proj[m], lab[m])) if m.sum() > 5 else np.nan
    row["nmi_type"] = float(normalized_mutual_info_score(types[m], lab[m])) if m.sum() > 5 else np.nan
    mp = nz & (par != "")
    row["nmi_epic"] = float(normalized_mutual_info_score(par[mp], lab[mp])) if mp.sum() > 5 else np.nan
    rng = np.random.default_rng(SEED)
    aris = []
    n = len(E)
    for _ in range(15):
        sub = np.sort(rng.choice(n, size=int(0.8 * n), replace=False))
        ls = fn(E[sub])
        aris.append(ari_nonnoise(lab[sub], ls))
    aris = [a for a in aris if not np.isnan(a)]
    row["stability_ari"] = float(np.mean(aris)) if aris else np.nan
    return row, lab


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None)
    ap.add_argument("--facet", default="problem")
    ap.add_argument("--review-config", default=None)
    args = ap.parse_args()

    df_all = load_cases()
    choices = {}
    for p in sorted(DATA.glob(f"vec/*__{args.facet}__native.json")):
        ids, M, meta = load_vec(p.stem)
        choices[meta["model"]] = (ids, M)
    model = args.model or ("voyageai/voyage-4-large" if "voyageai/voyage-4-large" in choices else next(iter(choices)))
    ids, M = choices[model]
    ix = dict(zip(ids, range(len(ids))))
    df = df_all[df_all["id"].isin(ix)].reset_index(drop=True)
    E = M[[ix[i] for i in df["id"]]]
    types = np.array([case_type(l) for l in df["labels"]], dtype=object)
    print(f"model={model} cases={len(df)}", file=sys.stderr)

    configs = {}
    for m in (3, 4, 5, 8):
        configs[f"hdbscan_mcs{m}"] = (lambda X, m=m: run_hdbscan(X, m))
    for t in (0.30, 0.35, 0.40, 0.45, 0.50):
        configs[f"agglo_thr{t:.2f}"] = (lambda X, t=t: run_agglo(X, t))
    for k in (5, 8, 12):
        for r in (0.8, 1.0, 1.5):
            configs[f"louvain_k{k}_r{r}"] = (lambda X, k=k, r=r: run_louvain(X, k, r))

    rows, labs = [], {}
    for name, fn in configs.items():
        row, lab = evaluate_config(name, fn, E, df, types)
        rows.append(row)
        labs[name] = lab
        print(f"  {name}: k={row['n_clusters']} noise={row['noise']:.2f} sil={row['silhouette']:.3f} stab={row['stability_ari']:.2f}", file=sys.stderr)
    R = pd.DataFrame(rows)
    R.to_csv(RES / "t05_cluster.csv", index=False)
    (RES / "t05_cluster.json").write_text(json.dumps(dict(model=model, n=len(df), rows=rows), indent=1, default=str), encoding="utf8")
    md = ["# T0.5 clustering comparison", "", f"model={model}; cases={len(df)}", "",
          "| config | clusters | >=3 members | noise | median size | silhouette | stability ARI | NMI project | NMI type | NMI epic |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r['config']} | {r['n_clusters']} | {r['clusters_ge3']} | {r['noise']:.2f} | {r['size_median']:.0f} | {r['silhouette']:.3f} | "
                  f"{r['stability_ari']:.2f} | {r['nmi_project']:.2f} | {r['nmi_type']:.2f} | {r['nmi_epic']:.2f} |")
    (RES / "t05_cluster.md").write_text("\n".join(md) + "\n", encoding="utf8")
    print("\n".join(md))

    rc = args.review_config
    if rc and rc in labs:
        lab = labs[rc]
        lines = [f"# Cluster review sheet - {rc} ({model})", "", "Titles only. Judge each cluster: coherent (one topic) / mixed / junk.", ""]
        order = pd.Series(lab[lab >= 0]).value_counts().index
        for c in order:
            mem = np.flatnonzero(lab == c)
            if len(mem) < 3:
                continue
            projs = df.iloc[mem]["project"].fillna("(none)").value_counts().head(3).to_dict()
            lines.append(f"## cluster {c} (n={len(mem)}) projects={projs}")
            for i in mem[:14]:
                lines.append(f"- {df.at[i, 'id']}: {df.at[i, 'title'][:110]}")
            lines.append("")
        (DATA / "cluster-review.md").write_text("\n".join(lines) + "\n", encoding="utf8")
        print(f"review sheet -> {DATA / 'cluster-review.md'}", file=sys.stderr)


if __name__ == "__main__":
    main()
