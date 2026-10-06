#!/usr/bin/env python
"""F0 / T0.6 - score the Jev pilot against reference labels and against the retrieval baselines.

relevance    AUROC of Jev P(true) vs proxy label, compared with dense cosine / BM25 / hybrid on the SAME pairs;
             rerank of the top-5 (Hit@1, precision@3, MRR) and a simple fusion; calibration bins.
problem_type accuracy / macro-F1 vs Linear labels, against a leave-one-out kNN vote on the embeddings and the
             majority-class rate. The reference labels are the user's own Linear labels (noisy by construction).
Writes .spike-precedent/results/t06_jev.{md,json}
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
from sklearn.metrics import f1_score, roc_auc_score

from common import DATA, read_jsonl, utf8_stdout
from pi_eval import load_cases, load_vec
from t04_predict import case_type

RES = DATA / "results"
RNG = np.random.default_rng(7)


def boot(fn, n_items, n=3000):
    vals = []
    for _ in range(n):
        idx = RNG.integers(0, n_items, n_items)
        vals.append(fn(idx))
    return float(np.mean(vals)), float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def main():
    utf8_stdout()
    ref = json.loads((DATA / "jev_reference.json").read_text(encoding="utf8"))
    res = {r["id"]: r for r in read_jsonl(DATA / "jev_results.jsonl")}
    out, md = {}, ["# T0.6 Jev pilot", ""]

    ok = [r for r in res.values() if r["ok"]]
    cost = sum(r["cost_usd"] or 0 for r in ok)
    lat = np.median([r["ms"] for r in ok])
    md.append(f"calls ok {len(ok)}/{len(res)}; cost ${cost:.4f}; median latency {lat:.0f} ms per request "
              f"(up to 5 decisions per request); model {Counter(r['model'] for r in ok).most_common(1)[0][0]}")

    # ---------------- relevance
    rows = []
    for t in ref["relevance"]:
        a = res.get(t["task"])
        if not a or not a["ok"]:
            continue
        for x in t["rows"]:
            p = a["answers"][x["qid"]]["noul"]
            rows.append({**x, "task": t["task"], "jev": float(p)})
    y = np.array([r["label"] for r in rows])
    S = {k: np.array([r[k] for r in rows]) for k in ("jev", "dense", "bm25", "hyb")}
    md += ["", "## relevance (noul), pairs = %d, positive under the proxy = %d" % (len(y), y.sum()), "",
           "| score | AUROC on all pairs |", "|---|---|"]
    aucs = {}
    for k, v in S.items():
        aucs[k] = float(roc_auc_score(y, v))
        md.append(f"| {k} | {aucs[k]:.3f} |")
    # rerank per query
    tasks = sorted({r["task"] for r in rows})
    by_task = {t: [r for r in rows if r["task"] == t] for t in tasks}

    def rerank_metrics(order_key, idx=None):
        h1, p3, mrr = [], [], []
        sel = tasks if idx is None else [tasks[i] for i in idx]
        for t in sel:
            rr = by_task[t]
            order = sorted(rr, key=order_key)
            lab = [1 if o["label"] else 0 for o in order]
            h1.append(lab[0])
            p3.append(sum(lab[:3]) / 3)
            first = next((i for i, l in enumerate(lab) if l), None)
            mrr.append(1 / (first + 1) if first is not None else 0)
        return np.mean(h1), np.mean(p3), np.mean(mrr)

    def z(k):
        v = S[k]
        return (v - v.mean()) / (v.std() + 1e-9)

    zj, zh = z("jev"), z("hyb")
    for i, r in enumerate(rows):
        r["fusion"] = float(zj[i] + zh[i])
    md += ["", f"rerank of the retriever's top-5 for {len(tasks)} queries (bootstrap over queries):", "",
           "| ordering | Hit@1 | precision@3 | MRR |", "|---|---|---|---|"]
    orders = {"hybrid (original order)": lambda r: r["hyb_rank"], "dense cosine": lambda r: -r["dense"],
              "Jev P(true)": lambda r: -r["jev"], "Jev + hybrid (z-score sum)": lambda r: -r["fusion"]}
    out["rerank"] = {}
    for name, key in orders.items():
        cells = []
        for m in range(3):
            mean, lo, hi = boot(lambda idx, m=m, key=key: rerank_metrics(key, idx)[m], len(tasks), n=1500)
            cells.append(f"{mean:.3f} [{lo:.3f}-{hi:.3f}]")
        out["rerank"][name] = cells
        md.append(f"| {name} | " + " | ".join(cells) + " |")
    bins = [(0, .3), (.3, .6), (.6, .8), (.8, 1.01)]
    md += ["", "calibration of Jev P(true) against the proxy label:", "", "| P(true) bin | pairs | positive rate |", "|---|---|---|"]
    for lo, hi in bins:
        m = (S["jev"] >= lo) & (S["jev"] < hi)
        md.append(f"| {lo:.1f}-{min(hi,1):.1f} | {int(m.sum())} | {(y[m].mean() if m.sum() else float('nan')):.2f} |")
    out["relevance"] = dict(pairs=len(y), positives=int(y.sum()), auroc=aucs)

    # ---------------- problem_type
    pt = []
    for t in ref["problem_type"]:
        a = res.get(t["task"])
        if a and a["ok"]:
            ans = a["answers"]["q0"]
            pt.append(dict(case=t["case"], label=t["label"], pred=ans.get("choice"), conf=ans.get("confidence"),
                           probs=ans.get("probabilities")))
    yt = np.array([r["label"] for r in pt])
    yp = np.array([r["pred"] for r in pt])
    acc = float((yt == yp).mean())
    f1 = float(f1_score(yt, yp, average="macro"))
    # baselines
    df = load_cases()
    ix = M = None
    for p in DATA.glob("vec/*__problem__native.json"):
        ids, MM, meta = load_vec(p.stem)
        if meta["model"] == "voyageai/voyage-code-4":
            ix, M = dict(zip(ids, range(len(ids)))), MM
    types = np.array([case_type(l) for l in df["labels"]], dtype=object)
    lab_ok = np.flatnonzero((types != "(none)") & df["id"].isin(ix).to_numpy())
    E = M[[ix[df.at[i, "id"]] for i in lab_ok]]
    S_all = E @ E.T
    np.fill_diagonal(S_all, -1)
    tlab = types[lab_ok]
    pos = {df.at[i, "id"]: k for k, i in enumerate(lab_ok)}
    knn_pred = []
    for r in pt:
        k = pos[r["case"]]
        top = np.argsort(-S_all[k])[:7]
        knn_pred.append(Counter(tlab[top]).most_common(1)[0][0])
    knn_acc = float((np.array(knn_pred) == yt).mean())
    maj = Counter(tlab).most_common(1)[0]
    cm = Counter(zip(yt, yp))
    classes = sorted(set(yt))
    md += ["", f"## problem_type (choice, {len(classes)} classes), n = {len(pt)}", "",
           f"| method | accuracy | macro-F1 |", "|---|---|---|",
           f"| Jev | {acc:.3f} | {f1:.3f} |",
           f"| leave-one-out kNN vote (k=7, voyage-code-4) | {knn_acc:.3f} | - |",
           f"| majority class in the labelled corpus ({maj[0]}) | {maj[1] / len(tlab):.3f} | - |", "",
           "confusion (rows = Linear label, columns = Jev):", "",
           "| label \\ Jev | " + " | ".join(classes) + " |", "|---|" + "---|" * len(classes)]
    for a in classes:
        md.append(f"| {a} | " + " | ".join(str(cm.get((a, b), 0)) for b in classes) + " |")
    conf = np.array([r["conf"] for r in pt if r["conf"] is not None], dtype=float)
    correct = np.array([r["label"] == r["pred"] for r in pt if r["conf"] is not None])
    if len(conf):
        hi = conf >= np.median(conf)
        md.append("")
        md.append(f"mean confidence {conf.mean():.2f}; accuracy of the more-confident half {correct[hi].mean():.2f} vs the less-confident half {correct[~hi].mean():.2f}")
    out["problem_type"] = dict(n=len(pt), accuracy=acc, macro_f1=f1, knn_accuracy=knn_acc, majority_rate=maj[1] / len(tlab))
    (RES / "t06_jev.md").write_text("\n".join(md) + "\n", encoding="utf8")
    (RES / "t06_jev.json").write_text(json.dumps(out, indent=1), encoding="utf8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
