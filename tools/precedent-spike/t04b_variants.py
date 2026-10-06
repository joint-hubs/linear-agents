#!/usr/bin/env python
"""F0 / T0.4b - is the weak neighbour signal a TIME effect? Sensitivity variants of the neighbour predictor.

Cost per task fell ~16x across the three eras (routing / model mix), so "similar" tasks from another era mislead.
Variants (all use only EARLIER closed cases): plain kNN; kNN over the W most recently closed cases; kNN with an
exponential recency decay (half-life h days); and the baselines (global / type / estimate / recent-10 median).
Reported per metric as the MEDIAN over embedding models (spread = IQR), so no single model is cherry-picked.
Error metrics: MAPE (the D14 metric), median APE, mean |log1p ratio| ("MALE", robust to the heavy tail).

Usage: python t04b_variants.py [--k 7]
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from common import DATA, utf8_stdout
from pi_eval import candidate_mask, load_cases, load_vec
from t04_predict import FLOOR, METRICS, baseline_preds, case_type, geo_mean

RES = DATA / "results"
DAY = 86400.0


def knn_variant(S_row, cand, values, comp, now, k, window=None, half_life=None):
    ok = cand[~np.isnan(values[cand])]
    if window:
        ok = ok[np.argsort(-comp[ok])[:window]]
    if len(ok) < 3:
        return np.nan
    sims = np.maximum(S_row[ok], 1e-6)
    if half_life:
        sims = sims * np.exp2(-(now - comp[ok]) / (half_life * DAY))
    top = ok[np.argsort(-sims, kind="stable")[:k]]
    return geo_mean(values[top], np.maximum(sims[np.argsort(-sims, kind="stable")[:k]], 1e-9))


def errs(pred, act, floor):
    pred, act = np.asarray(pred, float), np.asarray(act, float)
    ape = np.abs(pred - act) / np.maximum(np.abs(act), floor)
    male = np.abs(np.log1p(pred) - np.log1p(act))
    return float(ape.mean()), float(np.median(ape)), float(male.mean())


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=7)
    args = ap.parse_args()
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
    eff = pd.DataFrame(list(df["effort"]))
    vals = {m: eff[m].to_numpy(dtype=float) if m in eff else np.full(n, np.nan) for m in METRICS}
    types = np.array([case_type(l) for l in df["labels"]], dtype=object)
    ests = df["estimate"].to_numpy(dtype=float)
    projs = df["project"].fillna("(none)").to_numpy(dtype=object)
    comp = np.array([t.timestamp() if pd.notna(t) else 0.0 for t in df["completed_ts"]])
    created = np.array([t.timestamp() for t in df["created_ts"]])
    is_q = df["v0"].to_numpy() & df["settled"].fillna(False).to_numpy(dtype=bool) & df["tel"].notna().to_numpy()

    variants = {"knn": dict(), "knn_recent40": dict(window=40), "knn_recent80": dict(window=80),
                "knn_decay14d": dict(half_life=14), "knn_decay30d": dict(half_life=30)}
    base_names = ["global_median", "type_median", "estimate_median", "project_median", "recent10_median"]
    out = {}
    for met in ("cost_loaded", "llm_turns", "active_min"):
        per_model = {v: [] for v in list(variants) + base_names}
        n_used = None
        for mname, (ix, M) in models.items():
            E = M[[ix[i] for i in df["id"]]]
            S = E @ E.T
            np.fill_diagonal(S, -1.0)
            preds = {v: [] for v in list(variants) + base_names}
            acts = []
            for i in np.flatnonzero(is_q):
                if np.isnan(vals[met][i]):
                    continue
                cand = np.flatnonzero(candidate_mask(df, i))
                base = baseline_preds(df, i, cand, vals[met], types, ests, projs, comp)
                if not base:
                    continue
                row = {}
                bad = False
                for v, kw in variants.items():
                    p = knn_variant(S[i], cand, vals[met], comp, created[i], args.k, **kw)
                    if np.isnan(p):
                        bad = True
                        break
                    row[v] = p
                if bad:
                    continue
                for b in base_names:
                    row[b] = base[b]
                for v in row:
                    preds[v].append(row[v])
                acts.append(vals[met][i])
            n_used = len(acts)
            for v in preds:
                per_model[v].append(errs(preds[v], acts, FLOOR[met]))
        summ = {}
        for v, lst in per_model.items():
            a = np.array(lst)  # models x (mape, mdape, male)
            summ[v] = dict(mape_median=float(np.median(a[:, 0])), mape_iqr=[float(np.percentile(a[:, 0], 25)), float(np.percentile(a[:, 0], 75))],
                           mdape_median=float(np.median(a[:, 1])), male_median=float(np.median(a[:, 2])),
                           male_iqr=[float(np.percentile(a[:, 2], 25)), float(np.percentile(a[:, 2], 75))])
        out[met] = dict(n=n_used, models=len(models), results=summ)

    (RES / "t04b_variants.json").write_text(json.dumps(out, indent=1), encoding="utf8")
    lines = ["# T0.4b neighbour predictor vs time-aware baselines (median over models)", ""]
    for met, e in out.items():
        lines += [f"## {met} (n={e['n']}, models={e['models']})", "", "| predictor | MAPE (median over models) | MdAPE | MALE (log error) | MALE IQR |", "|---|---|---|---|---|"]
        for v, r in sorted(e["results"].items(), key=lambda kv: kv[1]["male_median"]):
            lines.append(f"| {v} | {r['mape_median']:.2f} | {r['mdape_median']:.2f} | {r['male_median']:.3f} | {r['male_iqr'][0]:.3f}-{r['male_iqr'][1]:.3f} |")
        lines.append("")
    (RES / "t04b_variants.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
