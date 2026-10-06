#!/usr/bin/env python
"""F0 / T0.2 (part 2) - does truncating dimensions (Matryoshka) or an instruction prefix change retrieval quality?

Compares each variant with the same model's native run under the T0.3 protocol (time split, proxy `any`,
queries = V0). The prefix variant is asymmetric: query = prefixed vector, document = plain vector.
Writes .spike-precedent/results/t02_variants.md
"""
from __future__ import annotations

import json

import numpy as np

from common import DATA, utf8_stdout
from pi_eval import build_labels, evaluate, load_cases, load_vec, summarize

RES = DATA / "results"


def fmt(t):
    return f"{t[0]:.3f} [{t[1]:.3f}-{t[2]:.3f}]"


def main():
    utf8_stdout()
    df_all = load_cases()
    vecs = {}
    for p in sorted(DATA.glob("vec/*__problem__*.json")):
        ids, M, meta = load_vec(p.stem)
        vecs[p.stem] = (dict(zip(ids, range(len(ids)))), M, meta)
    common = set(df_all["id"])
    for ix, _, _ in vecs.values():
        common &= set(ix)
    df = df_all[df_all["id"].isin(common)].reset_index(drop=True)
    n = len(df)
    labels, _ = build_labels(df)
    text_len = (df["title"].str.len() + df["desc"].str.len()).to_numpy()
    query_ok = (text_len >= 200) & df["v0"].to_numpy()

    def emb(stem):
        ix, M, meta = vecs[stem]
        return M[[ix[i] for i in df["id"]]], meta

    def run(S, proxy):
        S = S.copy()
        np.fill_diagonal(S, -1e9)
        return summarize(evaluate(df, S, labels[proxy], query_ok))

    rows = []
    stems = sorted(vecs)
    natives = [s for s in stems if s.endswith("__native")]
    for nat in natives:
        base = nat[: -len("__native")]
        variants = [s for s in stems if s.startswith(base + "__") and not s.endswith("__native") and "__native__q" not in s]
        Eb, mb = emb(nat)
        entry = [(nat, mb["dims"], "native", Eb @ Eb.T, None)]
        for v in variants:
            Ev, mv = emb(v)
            entry.append((v, mv["dims"], f"dims={mv['dims_requested']}", Ev @ Ev.T, None))
        q = base + "__native__q"
        if q in vecs:
            Eq, mq = emb(q)
            entry.append((q, mq["dims"], "instruction prefix (asymmetric)", Eq @ Eb.T, None))
        if len(entry) == 1:
            continue
        for stem, dims, label, S, _ in entry:
            m = mb if stem == nat else vecs[stem][2]
            r_any, r_files = run(S, "any"), run(S, "files")
            rows.append((mb["model"], label, dims, dims * 4, r_any["recc@5"], r_any["rec@5"], r_any["hit@5"], r_any["mrr"],
                         r_files["recc@5"], m["latency_ms"]["median"]))
    md = ["# T0.2 part 2: dimension truncation and instruction prefix", "",
          "| model | variant | dims | bytes/vector | Recall@5 capped (any) | Recall@5 raw (any) | Hit@5 (any) | MRR (any) | Recall@5 capped (files) | batch median ms |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {fmt(r[4])} | {fmt(r[5])} | {fmt(r[6])} | {fmt(r[7])} | {fmt(r[8])} | {r[9]} |")
    (RES / "t02_variants.md").write_text("\n".join(md) + "\n", encoding="utf8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
