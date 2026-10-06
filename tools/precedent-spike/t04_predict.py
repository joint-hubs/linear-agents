#!/usr/bin/env python
"""F0 / T0.4 - predict effort from similar earlier cases, and test the stability of the efficiency ranking.

Part A  Prediction. For every V0 case with telemetry, predict its effort (LLM turns, loaded cost, active
        minutes, child turns, review rounds) from the k most similar EARLIER closed cases (time split) and
        compare with baselines: global median, per-type median (label bug/feature/tech/chore/spike),
        per-estimate median, per-project median, median of the 10 most recently closed cases.
        Metrics: MAPE (the D14 metric), median APE, mean |log ratio|; bootstrap CI of the improvement.
Part B  Ranking stability (D9). Efficiency = -sum_m w_m * log((actual_m+1)/(expected_m+1)) over the V2 cases,
        expected from earlier neighbours. The ranking is recomputed under (i) random weight perturbations
        around the defaults, (ii) alternative meanings of "turns" (LLM only, child only, rounds only),
        (iii) each single metric; agreement with the default ranking is reported (Spearman, top-10 overlap).

Usage: python t04_predict.py [--model <id>] [--k 7] [--facet problem]
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from common import DATA, utf8_stdout
from pi_eval import candidate_mask, load_cases, load_vec

RES = DATA / "results"
RES.mkdir(exist_ok=True)
METRICS = ["llm_turns", "cost_loaded", "active_min", "child_turns", "review_rounds"]
TYPE_PRIORITY = ["bug", "feature", "tech", "chore", "spike", "docs", "test"]
DEFAULT_W = {"llm_turns": 0.35, "child_turns": 0.15, "review_rounds": 0.10, "cost_loaded": 0.20, "active_min": 0.20}
K_MIN = 3


def case_type(labels):
    for t in TYPE_PRIORITY:
        if t in labels:
            return t
    return "(none)"


def geo_mean(vals, w):
    return float(np.expm1(np.sum(w * np.log1p(vals)) / np.sum(w)))


def expected_knn(S_row, cand, values, k):
    ok = cand[~np.isnan(values[cand])]
    if len(ok) < K_MIN:
        return np.nan
    top = ok[np.argsort(-S_row[ok], kind="stable")[:k]]
    w = np.maximum(S_row[top], 1e-6)
    return geo_mean(values[top], w)


def baseline_preds(df, i, cand, values, types, ests, projs, comp):
    ok = cand[~np.isnan(values[cand])]
    out = {}
    if len(ok) < K_MIN:
        return out
    out["global_median"] = float(np.median(values[ok]))
    for name, arr in (("type_median", types), ("estimate_median", ests), ("project_median", projs)):
        same = ok[arr[ok] == arr[i]] if arr[i] not in (None, "(none)") and not (isinstance(arr[i], float) and np.isnan(arr[i])) else np.array([], dtype=int)
        out[name] = float(np.median(values[same])) if len(same) >= K_MIN else out["global_median"]
    recent = ok[np.argsort(-comp[ok])[:10]]
    out["recent10_median"] = float(np.median(values[recent]))
    return out


FLOOR = {"llm_turns": 1.0, "child_turns": 1.0, "review_rounds": 1.0, "active_min": 1.0, "cost_loaded": 0.01}


def ape(pred, actual, floor=1e-9):
    """Absolute percentage error with a floor on the denominator (a task with 0 turns / 0 minutes would divide by ~0)."""
    return abs(pred - actual) / max(abs(actual), floor)


def boot_ci(x, n=2000, seed=7):
    rng = np.random.default_rng(seed)
    x = np.asarray(x, dtype=float)
    b = rng.choice(x, size=(n, len(x)), replace=True).mean(axis=1)
    return float(x.mean()), float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None, help="model id (default: every embedded model)")
    ap.add_argument("--k", type=int, default=7)
    ap.add_argument("--facet", default="problem")
    args = ap.parse_args()

    df_all = load_cases()
    models = {}
    for p in sorted(DATA.glob(f"vec/*__{args.facet}__native.json")):
        ids, M, meta = load_vec(p.stem)
        models[meta["model"]] = (dict(zip(ids, range(len(ids)))), M)
    if args.model:
        models = {args.model: models[args.model]}
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
    is_q = df["v0"].to_numpy() & df["settled"].fillna(False).to_numpy(dtype=bool) & df["tel"].notna().to_numpy()
    print(f"cases={n}; query cases (V0 & telemetry & settled)={int(is_q.sum())}", file=sys.stderr)

    out = {"k": args.k, "n_cases": n, "n_queries": int(is_q.sum()), "prediction": {}, "stability": {}}
    for mname, (ix, M) in models.items():
        E = M[[ix[i] for i in df["id"]]]
        S = E @ E.T
        np.fill_diagonal(S, -1.0)
        res = {}
        for met in METRICS:
            rows = []
            for i in np.flatnonzero(is_q):
                if np.isnan(vals[met][i]):
                    continue
                cand = np.flatnonzero(candidate_mask(df, i))
                pred_knn = expected_knn(S[i], cand, vals[met], args.k)
                base = baseline_preds(df, i, cand, vals[met], types, ests, projs, comp)
                if np.isnan(pred_knn) or not base:
                    continue
                a = vals[met][i]
                r = {"i": int(i), "actual": a, "knn": pred_knn, **base}
                rows.append(r)
            if not rows:
                continue
            R = pd.DataFrame(rows)
            entry = {"n": len(R)}
            for meth in ["knn", "global_median", "type_median", "estimate_median", "project_median", "recent10_median"]:
                apes = np.array([ape(p, a, FLOOR[met]) for p, a in zip(R[meth], R["actual"])])
                lr = np.abs(np.log1p(R[meth].to_numpy()) - np.log1p(R["actual"].to_numpy()))
                entry[meth] = dict(mape=float(apes.mean()), mdape=float(np.median(apes)), male=float(lr.mean()),
                                   spearman=float(spearmanr(R[meth], R["actual"]).statistic) if R[meth].nunique() > 1 else None)
            best_base = min(("global_median", "type_median", "estimate_median", "project_median", "recent10_median"),
                            key=lambda b: entry[b]["mape"])
            entry["best_baseline"] = best_base
            apes_k = np.array([ape(p, a, FLOOR[met]) for p, a in zip(R["knn"], R["actual"])])
            apes_b = np.array([ape(p, a, FLOOR[met]) for p, a in zip(R[best_base], R["actual"])])
            apes_t = np.array([ape(p, a, FLOOR[met]) for p, a in zip(R["type_median"], R["actual"])])
            # improvement of the mean (ratio of MAPEs) with a paired bootstrap over queries
            rng = np.random.default_rng(7)
            idx = rng.integers(0, len(R), size=(2000, len(R)))
            imp_b = 1 - apes_k[idx].mean(axis=1) / apes_b[idx].mean(axis=1)
            imp_t = 1 - apes_k[idx].mean(axis=1) / apes_t[idx].mean(axis=1)
            entry["improvement_vs_best_baseline"] = (float(1 - apes_k.mean() / apes_b.mean()), float(np.percentile(imp_b, 2.5)), float(np.percentile(imp_b, 97.5)))
            entry["improvement_vs_type_median"] = (float(1 - apes_k.mean() / apes_t.mean()), float(np.percentile(imp_t, 2.5)), float(np.percentile(imp_t, 97.5)))
            res[met] = entry
        out["prediction"][mname] = res

    # ---------------- Part B: efficiency ranking stability on V2 cases (uses the model with best cost improvement)
    def pick_model():
        best, bv = None, -9
        for mname, res in out["prediction"].items():
            v = res.get("cost_loaded", {}).get("improvement_vs_type_median", (None,))[0]
            if v is not None and v > bv:
                best, bv = mname, v
        return best or next(iter(models))

    bm = pick_model()
    ix, M = models[bm]
    E = M[[ix[i] for i in df["id"]]]
    S = E @ E.T
    np.fill_diagonal(S, -1.0)
    v2 = np.flatnonzero(df["v2"].to_numpy())
    resid = {m: np.full(n, np.nan) for m in METRICS}
    for i in v2:
        cand = np.flatnonzero(candidate_mask(df, i))
        for m in METRICS:
            if np.isnan(vals[m][i]):
                continue
            ex = expected_knn(S[i], cand, vals[m], args.k)
            if not np.isnan(ex):
                resid[m][i] = np.log1p(vals[m][i]) - np.log1p(ex)

    def eff_score(weights):
        sc = np.full(n, np.nan)
        for i in v2:
            tot, ws = 0.0, 0.0
            for m, w in weights.items():
                if w > 0 and not np.isnan(resid[m][i]):
                    tot += w * resid[m][i]
                    ws += w
            if ws > 0:
                sc[i] = -tot / ws
        return sc

    base_sc = eff_score(DEFAULT_W)
    valid = v2[~np.isnan(base_sc[v2])]
    out["stability"]["model_used"] = bm
    out["stability"]["n_v2"] = int(len(v2))
    out["stability"]["n_scored"] = int(len(valid))
    if len(valid) >= 8:
        base_rank_top = set(valid[np.argsort(-base_sc[valid])[:10]])
        rng = np.random.default_rng(11)
        alt = {"llm_turns_only": {"llm_turns": 1}, "child_turns_only": {"child_turns": 1}, "rounds_only": {"review_rounds": 1},
               "cost_only": {"cost_loaded": 1}, "time_only": {"active_min": 1},
               "turns_family_only": {"llm_turns": .35, "child_turns": .15, "review_rounds": .10},
               "equal_weights": {m: 1 / 5 for m in METRICS}}
        rows = {}
        for name, w in alt.items():
            sc = eff_score(w)
            ok = valid[~np.isnan(sc[valid])]
            if len(ok) >= 8:
                rows[name] = dict(n=int(len(ok)), spearman=float(spearmanr(base_sc[ok], sc[ok]).statistic),
                                  top10_overlap=len(base_rank_top & set(ok[np.argsort(-sc[ok])[:10]])) / 10)
        pert_sp, pert_ov = [], []
        keys = list(DEFAULT_W)
        for _ in range(500):
            w = np.array([DEFAULT_W[k] for k in keys]) + rng.uniform(-0.15, 0.15, len(keys))
            w = np.clip(w, 0, None)
            if w.sum() == 0:
                continue
            sc = eff_score(dict(zip(keys, w / w.sum())))
            ok = valid[~np.isnan(sc[valid])]
            pert_sp.append(spearmanr(base_sc[ok], sc[ok]).statistic)
            pert_ov.append(len(base_rank_top & set(ok[np.argsort(-sc[ok])[:10]])) / 10)
        out["stability"]["alternatives"] = rows
        out["stability"]["perturbation_plus_minus_0.15"] = dict(
            spearman_median=float(np.median(pert_sp)), spearman_p5=float(np.percentile(pert_sp, 5)),
            top10_overlap_median=float(np.median(pert_ov)), top10_overlap_p5=float(np.percentile(pert_ov, 5)), draws=len(pert_sp))
        # is the fastest list dominated by trivially small tasks? correlation of efficiency with raw cost
        out["stability"]["corr_eff_vs_raw_cost_spearman"] = float(spearmanr(base_sc[valid], vals["cost_loaded"][valid]).statistic)
        top = valid[np.argsort(-base_sc[valid])[:10]]
        out["stability"]["top10_ids"] = [df.at[i, "id"] for i in top]

    (RES / "t04_predict.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf8")
    lines = ["# T0.4 prediction from neighbours (time split)", "", f"k={args.k}; queries={out['n_queries']}", ""]
    for mname, res in out["prediction"].items():
        for met, e in res.items():
            if met != "cost_loaded":
                continue
            lines.append(f"- **{mname}** cost_loaded n={e['n']}: kNN MAPE={e['knn']['mape']:.2f} | type_median={e['type_median']['mape']:.2f} "
                         f"| estimate={e['estimate_median']['mape']:.2f} | project={e['project_median']['mape']:.2f} | global={e['global_median']['mape']:.2f} "
                         f"| recent10={e['recent10_median']['mape']:.2f}; improvement vs type median {e['improvement_vs_type_median'][0]:+.1%} "
                         f"[{e['improvement_vs_type_median'][1]:+.1%}, {e['improvement_vs_type_median'][2]:+.1%}]; vs best baseline ({e['best_baseline']}) "
                         f"{e['improvement_vs_best_baseline'][0]:+.1%}")
    (RES / "t04_predict.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print("\n".join(lines))
    print(json.dumps(out["stability"], indent=1, default=str))


if __name__ == "__main__":
    main()
