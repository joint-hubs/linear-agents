#!/usr/bin/env python
"""F0 / T0.2 - write the texts to embed (in-scope cases only) to .spike-precedent/texts.jsonl.

Facets
  problem   ticket title + description (acceptance criteria are inside the description)
  approach  commit subjects + first lines of the commit bodies (no file paths)
Egress screening happens in embed.mjs (fail-closed), not here.
"""
from __future__ import annotations

import re

from common import DATA, read_jsonl, utf8_stdout, write_jsonl

MAX_COMMITS = 12
BODY_HEAD = 300


def problem_text(c: dict) -> str:
    title = (c.get("title") or "").strip()
    desc = (c.get("description") or "").strip()
    return f"{title}\n\n{desc}".strip()


def approach_text(c: dict, commits_by_sha: dict[str, dict]) -> str:
    g = c.get("git")
    if not g:
        return ""
    parts = []
    for sha in g["shas"]:
        cm = commits_by_sha.get(sha)
        if not cm or cm["merge"]:
            continue
        body = re.sub(r"\s+", " ", (cm.get("body") or "")).strip()
        body = re.sub(r"Co-Authored-By:.*$", "", body, flags=re.I).strip()
        parts.append(f"- {cm['subject']}" + (f"\n  {body[:BODY_HEAD]}" if body else ""))
        if len(parts) >= MAX_COMMITS:
            break
    return "\n".join(parts)


def main():
    utf8_stdout()
    cases = read_jsonl(DATA / "corpus.jsonl")
    commits = {c["sha"][:12]: c for c in read_jsonl(DATA / "git_commits.jsonl")}
    rows = []
    for c in cases:
        if not c["scope"]["in_scope"]:
            continue
        p = problem_text(c)
        if len(p) >= 20:
            rows.append(dict(id=c["id"], facet="problem", text=p))
        a = approach_text(c, commits)
        if len(a) >= 20:
            rows.append(dict(id=c["id"], facet="approach", text=a))
    n = write_jsonl(DATA / "texts.jsonl", rows)
    by = {}
    for r in rows:
        by[r["facet"]] = by.get(r["facet"], 0) + 1
    chars = {f: sum(len(r["text"]) for r in rows if r["facet"] == f) for f in by}
    print({"rows": n, "by_facet": by, "chars": chars})


if __name__ == "__main__":
    main()
