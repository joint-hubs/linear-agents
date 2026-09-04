#!/usr/bin/env python3
"""Refresh the benchmark payload embedded in model-explorer.html.

Reads OpenRouter and rewrites the JSON literal between the DATA:BEGIN / DATA:END
markers in the HTML. Nothing else in the file is touched, so hand edits to the
layout, the role presets or the copy survive a refresh.

    python docs/ui/refresh-model-data.py --out docs/ui/model-explorer.html

Sources
  /api/v1/models
      listed pricing (prompt, completion, input_cache_read), context length and
      release date. Public, unauthenticated.
  /api/frontend/v1/catalog/models
      permaslug and display name per model. A slug can appear twice when a
      ":batch" twin exists; the plain entry wins.
  /api/frontend/v1/private/artificial-analysis-benchmarks?slug=<permaslug>
      the Artificial Analysis evaluation set. One model can return several rows,
      one per reasoning effort — they are kept as separate variants because they
      score differently and bill differently.

"private" in that last path is OpenRouter's own route naming, not an access
level: it needs no key and serves the numbers the public model page renders.
"""

import argparse
import concurrent.futures as cf
import datetime
import json
import re
import sys
import time
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
BASE = "https://openrouter.ai"
AA = BASE + "/api/frontend/v1/private/artificial-analysis-benchmarks?slug="

# (key used in the page, key in the AA payload, multiplier to reach percent)
EVALUATIONS = [
    ("intel", "artificial_analysis_intelligence_index", 1),
    ("code",  "artificial_analysis_coding_index", 1),
    ("agent", "artificial_analysis_agentic_index", 1),
    ("py",    "scicode", 100),
    ("term",  "terminalbench_hard", 100),
    ("gpqa",  "gpqa", 100),
    ("hle",   "hle", 100),
    ("ifb",   "ifbench", 100),
    ("tau2",  "tau2", 100),
    ("lctx",  "lcr", 100),
    ("econ",  "gdpval_aa", 100),
    ("phys",  "critpt", 100),
    ("know",  "aa_omniscience_accuracy", 100),
    ("hon",   "aa_omniscience_non_hallucination_rate", 100),
]

# Hand-entered snapshot of 2026-07-27, kept as the baseline for the "what changed"
# table. Move it forward deliberately when you want a newer comparison point —
# it is a fixed historical record, not something to recompute on every refresh.
PREV = {
    "deepseek/deepseek-v4-pro":  {"inp": 0.435,  "out": 0.87,  "intel": 44.3},
    "z-ai/glm-5.2":              {"inp": 0.7504, "out": 2.358, "intel": 51.1},
    "anthropic/claude-sonnet-5": {"inp": 2.0,    "out": 10.0,  "intel": 53.4},
    "minimax/minimax-m3":        {"inp": 0.24,   "out": 0.96,  "intel": 44.4},
    "x-ai/grok-4.5":             {"inp": 2.0,    "out": 6.0,   "intel": 53.8},
    "moonshotai/kimi-k2.5":      {"inp": 0.375,  "out": 2.025, "intel": 35.4},
    "moonshotai/kimi-k3":        {"inp": 3.0,    "out": 15.0,  "intel": 57.1},
    "qwen/qwen3.6-plus":         {"inp": 0.325,  "out": 1.95,  "intel": 39.6},
    "qwen/qwen3.7-max":          {"inp": 1.475,  "out": 4.425, "intel": 46.0},
    "qwen/qwen3.7-plus":         {"inp": 0.32,   "out": 1.28,  "intel": 39.0},
    "nvidia/nemotron-3-super-120b-a12b": {"inp": 0.0, "out": 0.0, "intel": 25.4},
}

EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "on", "default"]


def fetch(url, tries=3, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def usd(pricing, key):
    """OpenRouter quotes per token; the page works in dollars per 1M tokens."""
    v = pricing.get(key)
    return None if v in (None, "") else round(float(v) * 1e6, 4)


def effort_of(aa_name):
    """AA labels a variant in a trailing parenthesis: "GPT-5.6 Luna (xhigh)"."""
    m = re.search(r"\((.*)\)\s*$", aa_name or "")
    if not m:
        return "default"
    s = m.group(1).lower()
    if "non-reasoning" in s or "non reasoning" in s:
        return "off"
    for e in ("xhigh", "max", "high", "medium", "low", "minimal"):
        if e in s:
            return e
    return "on" if "reasoning" in s else s[:12]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="model-explorer.html")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    print("- /api/v1/models")
    api = {m["id"]: m for m in fetch(BASE + "/api/v1/models")["data"]}

    print("- /api/frontend/v1/catalog/models")
    catalog = {}
    for c in fetch(BASE + "/api/frontend/v1/catalog/models")["data"]:
        prev = catalog.get(c["slug"])
        # A slug can carry a ":batch" or ":free" twin under the same key; the
        # plain listing is the one whose display name we want.
        if prev is None or re.search(r"\((batch|free)\)", prev.get("short_name") or "", re.I):
            catalog[c["slug"]] = c

    def entry(mid):
        return catalog.get(mid) or catalog.get(mid.split(":")[0]) or {}

    targets = {}
    for mid, m in api.items():
        if mid.startswith("~") or ":batch" in mid:
            continue
        if "text" not in m["architecture"]["output_modalities"]:
            continue
        p = entry(mid).get("permaslug")
        if not p:
            continue
        # One permaslug, one request: prefer the paid id over its ":free" twin.
        if p not in targets or ":free" in targets[p]:
            targets[p] = mid

    print("- benchmarks for %d models" % len(targets))

    def get(item):
        p, mid = item
        try:
            return mid, (fetch(AA + urllib.parse.quote(p, safe="")).get("data") or [])
        except Exception as e:
            print("  ! %s: %s" % (mid, e), file=sys.stderr)
            return mid, []

    results = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (mid, rows) in enumerate(ex.map(get, targets.items()), 1):
            results[mid] = rows
            if i % 50 == 0:
                print("  ... %d/%d" % (i, len(targets)))

    models, unscored = [], []
    for mid, rows in results.items():
        m = api[mid]
        p = m["pricing"]
        c = entry(mid)
        common = {
            "id": mid,
            "name": (c.get("short_name") or m["name"]).replace("‑", "-"),
            "author": c.get("author_display_name") or mid.split("/")[0],
            "inp": usd(p, "prompt"), "out": usd(p, "completion"),
            "cache": usd(p, "input_cache_read"), "ctx": m["context_length"],
            "date": datetime.date.fromtimestamp(m["created"]).isoformat(),
        }
        variants = []
        for r in rows:
            ev = r["benchmark_data"].get("evaluations") or {}
            vals = {k: round(float(ev[a]) * s, 1)
                    for k, a, s in EVALUATIONS if ev.get(a) is not None}
            if not vals:
                continue
            pct = r.get("percentiles") or {}
            variants.append({
                "e": effort_of(r.get("aa_name")),
                "label": r.get("aa_name"),
                "v": vals,
                "pct": {k[:4]: v for k, v in pct.items() if v is not None},
                "ts": r.get("last_updated_at"),
            })
        if variants:
            variants.sort(key=lambda x: EFFORTS.index(x["e"]) if x["e"] in EFFORTS else 99)
            models.append(dict(common, reason=bool(c.get("supports_reasoning")), vars=variants))
        else:
            # Servable but unmeasured. Shown in its own section, never ranked:
            # a guessed score would be worse than an admitted gap.
            unscored.append(common)

    models.sort(key=lambda x: x["date"], reverse=True)
    unscored.sort(key=lambda x: x["date"], reverse=True)
    scored_ids = {m["id"] for m in models}
    payload = {
        "models": models,
        "unscored": unscored,
        "snapshot": datetime.date.today().isoformat(),
        "prev": {k: v for k, v in PREV.items() if k in scored_ids},
    }

    with open(args.out, encoding="utf-8") as fh:
        html = fh.read()
    pat = re.compile(r"(/\* DATA:BEGIN \*/).*?(/\* DATA:END \*/)", re.S)
    if not pat.search(html):
        sys.exit("markers /* DATA:BEGIN */ ... /* DATA:END */ not found in %s" % args.out)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # re.sub would read backslashes in the replacement as group references.
    out = pat.sub(lambda m: m.group(1) + blob.replace("\\", "\\\\") + m.group(2), html, count=1)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(out)

    print("\n%s: %d models, %d variants, %d unscored, snapshot %s" % (
        args.out, len(models), sum(len(m["vars"]) for m in models),
        len(unscored), payload["snapshot"]))


if __name__ == "__main__":
    main()
