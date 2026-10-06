#!/usr/bin/env python
"""F0 / T0.6 - prepare the Jev pilot tasks (relevance pairs, problem_type) and their reference labels.

relevance    24 queries x 5 candidates. Candidates = top-5 of the hybrid retriever (BM25 + dense, RRF) among cases
             closed before the query was created, on queries whose top-5 contains at least one positive AND one
             negative under the proxy label (files | epic | relation) - otherwise there is nothing to rerank.
problem_type 80 closed tickets (16 per class where available) labelled bug / feature / tech / chore / spike in Linear.
Writes .spike-precedent/jev_tasks.jsonl and jev_reference.json (local, git-ignored).
Usage: python t06_prepare.py [--model voyageai/voyage-code-4] [--queries 24] [--per-class 16]
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from common import DATA, utf8_stdout, write_jsonl
from pi_eval import bm25_matrix, build_labels, candidate_mask, load_cases, load_vec, rrf
from t04_predict import case_type

SEED = 7
STATE_CHARS = 2500
CAND_CHARS = 900
TYPES = {
    "bug": "Something that used to work is broken or behaves incorrectly; the work restores intended behaviour",
    "feature": "A new capability or behaviour that did not exist before",
    "tech": "Technical, refactoring, infrastructure or tooling work with no new user-visible behaviour",
    "chore": "Routine maintenance, clean-up, configuration or housekeeping",
    "spike": "Time-boxed research or investigation whose output is knowledge or a decision, not shipped behaviour",
}


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="voyageai/voyage-code-4")
    ap.add_argument("--queries", type=int, default=24)
    ap.add_argument("--per-class", type=int, default=16)
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)

    df_all = load_cases()
    ix = M = None
    for p in DATA.glob("vec/*__problem__native.json"):
        ids, MM, meta = load_vec(p.stem)
        if meta["model"] == args.model:
            ix, M = dict(zip(ids, range(len(ids)))), MM
    df = df_all[df_all["id"].isin(ix)].reset_index(drop=True)
    E = M[[ix[i] for i in df["id"]]]
    dense = E @ E.T
    np.fill_diagonal(dense, -1e9)
    bm = bm25_matrix([f"{t}\n\n{d}" for t, d in zip(df["title"], df["desc"])])
    np.fill_diagonal(bm, -1e9)
    hyb = rrf(bm, dense)
    labels, _ = build_labels(df)
    lab = labels["any"]
    text_len = (df["title"].str.len() + df["desc"].str.len()).to_numpy()
    qok = np.flatnonzero((text_len >= 300) & df["v0"].to_numpy())

    picks = []
    for i in rng.permutation(qok):
        cand = np.flatnonzero(candidate_mask(df, i))
        if len(cand) < 5:
            continue
        top = cand[np.argsort(-hyb[i, cand], kind="stable")[:5]]
        pos = lab[i, top]
        if pos.any() and not pos.all():
            picks.append((int(i), top))
        if len(picks) >= args.queries:
            break

    tasks, ref = [], {"relevance": [], "problem_type": []}
    for i, top in picks:
        state = f"NEW TICKET\n{df.at[i, 'title']}\n\n{df.at[i, 'desc'][:STATE_CHARS]}"
        questions, rows = {}, []
        for r, j in enumerate(top):
            qid = f"q{r}"
            questions[qid] = dict(
                type="noul",
                instructions=(f"EARLIER CLOSED TICKET: {df.at[j, 'title']}\n{df.at[j, 'desc'][:CAND_CHARS]}\n\n"
                              "Does this earlier ticket concern the same underlying problem, cause or component as the new ticket "
                              "in the state, so that how it was solved would help with the new ticket?"),
                criteria={"true": "Same underlying problem, cause or component; the earlier solution is relevant",
                          "false": "A different problem or component; the earlier solution would not help"})
            rows.append(dict(qid=qid, query=df.at[i, "id"], cand=df.at[j, "id"], label=bool(lab[i, j]),
                             hyb_rank=r + 1, dense=float(dense[i, j]), bm25=float(bm[i, j]), hyb=float(hyb[i, j])))
        tasks.append(dict(id=f"rel:{df.at[i, 'id']}", kind="relevance", state=state, questions=questions))
        ref["relevance"].append(dict(task=f"rel:{df.at[i, 'id']}", rows=rows))

    types = np.array([case_type(l) for l in df["labels"]], dtype=object)
    v0 = df["v0"].to_numpy() & (text_len >= 300)
    for t in TYPES:
        pool = np.flatnonzero(v0 & (types == t))
        take = rng.permutation(pool)[: args.per_class]
        for i in take:
            tasks.append(dict(id=f"type:{df.at[i, 'id']}", kind="problem_type",
                              state=f"TICKET\n{df.at[i, 'title']}\n\n{df.at[i, 'desc'][:STATE_CHARS]}",
                              questions={"q0": dict(type="choice", instructions="What kind of work is this ticket?", criteria=TYPES)}))
            ref["problem_type"].append(dict(task=f"type:{df.at[i, 'id']}", case=df.at[i, "id"], label=t))
    n = write_jsonl(DATA / "jev_tasks.jsonl", tasks)
    (DATA / "jev_reference.json").write_text(json.dumps(ref, ensure_ascii=False, indent=1), encoding="utf8")
    kinds = {}
    for t in tasks:
        kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
    pairs = sum(len(r["rows"]) for r in ref["relevance"])
    pos = sum(x["label"] for r in ref["relevance"] for x in r["rows"])
    print(dict(tasks=n, kinds=kinds, relevance_pairs=pairs, relevance_positive=pos, problem_type=len(ref["problem_type"])))


if __name__ == "__main__":
    main()
