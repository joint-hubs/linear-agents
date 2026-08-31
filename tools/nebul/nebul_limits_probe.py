#!/usr/bin/env python3
"""Find the size/limit boundary at which nebul answers HTTP 400.

Motivation. The refusal ("failed to extract prompt from request body") arrives in
173-196 ms, while a trivial 5-token request to the same endpoint takes 510-560 ms.
The server is therefore refusing BEFORE it does any real work - which is what a
pre-inference validation step looks like. The commonest such check is

    prompt_tokens + max_tokens > context_window

and every rejected body carried "max_tokens": 32000.

This also re-examines a claim that was made too quickly. "Larger requests
succeeded right after smaller ones were rejected" compared BYTES, not TOKENS. A
252 KB body full of code and indentation can tokenize to fewer tokens than a
196 KB body of dense prose, so that observation never ruled a size limit out.

Phase A sweeps max_tokens with the message list untouched (cheap - the prefix
cache serves it). Phase B grows the input itself and is billed as fresh tokens,
so it is opt-in and capped.

Only the status line is read; nothing is generated. The API key is read from
.env and is never printed or written to disk.
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nebul_transport_repro import (  # noqa: E402
    HERE, SHED, load_env, send_once,
)


def with_max_tokens(raw, n):
    doc = json.loads(raw.decode("utf-8"))
    doc["max_tokens"] = n
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def grown(raw, factor):
    """Repeat the middle assistant/user pairs to enlarge the conversation.

    Only whole turns are duplicated, so the result stays a structurally valid
    conversation rather than a blob the server would reject for another reason.
    """
    doc = json.loads(raw.decode("utf-8"))
    msgs = doc.get("messages", [])
    if len(msgs) < 4:
        return None
    head, middle, tail = msgs[:2], msgs[2:-1], msgs[-1:]
    doc["messages"] = head + middle * factor + tail
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def approx_tokens(body):
    return len(body) / 4.0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--key-var", default="NEBUL_API_KEY")
    ap.add_argument("--url", default="https://api.inference.nebul.io/v1/messages?beta=true")
    ap.add_argument("--body", default=os.path.join(HERE, "nebul-fail-30.bin"))
    ap.add_argument("--max-tokens-sweep", default="32000,64000,96000,128000,200000,400000")
    ap.add_argument("--grow", default="", help="Comma-separated repeat factors, e.g. 2,3,4. "
                                               "These are billed as FRESH tokens.")
    ap.add_argument("--input-usd-per-mtok", type=float, default=1.91)
    ap.add_argument("--cache-usd-per-mtok", type=float, default=0.76)
    ap.add_argument("--budget-usd", type=float, default=3.0)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "nebul_limits_matrix.json"))
    args = ap.parse_args()

    raw = open(args.body, "rb").read()
    doc = json.loads(raw.decode("utf-8"))
    sweep = [int(x) for x in args.max_tokens_sweep.split(",") if x.strip()]
    grow = [int(x) for x in args.grow.split(",") if x.strip()]

    base_tok = approx_tokens(raw)
    est_a = len(sweep) * base_tok * args.cache_usd_per_mtok / 1_000_000
    est_b = sum(approx_tokens(grown(raw, f) or b"") for f in grow) \
        * args.input_usd_per_mtok / 1_000_000
    est = est_a + est_b

    print("body     : %s (%d bytes, ~%.0f tokens)" % (
        os.path.basename(args.body), len(raw), base_tok))
    print("           original max_tokens=%s" % doc.get("max_tokens"))
    print("phase A  : max_tokens sweep %s  (cache hits, ~$%.2f)" % (sweep, est_a))
    if grow:
        for f in grow:
            g = grown(raw, f)
            print("phase B  : grow x%d -> %d bytes (~%.0f tokens)" % (
                f, len(g), approx_tokens(g)))
        print("           phase B is FRESH input, ~$%.2f" % est_b)
    print("cost est : ~$%.2f   budget $%.2f" % (est, args.budget_usd))

    if args.dry_run:
        print("\n--dry-run: nothing sent.")
        return 0
    if est > args.budget_usd and not args.yes:
        print("\nREFUSING TO START: estimate exceeds --budget-usd. Pass --yes to override.")
        return 3

    env = load_env(args.env_file)
    key = env.get(args.key_var) or os.environ.get(args.key_var)
    if not key:
        print("\nNo %s in %s or the environment." % (args.key_var, args.env_file))
        return 2

    results = []

    def run(body, label):
        r = send_once(args.url, body, key)
        r["label"] = label
        r["body_bytes"] = len(body)
        results.append(r)
        mark = "SHED 400" if r["shed"] else (r["status"] or r.get("error", "?"))
        detail = r.get("request_id") or ""
        if r["status"] not in (200, None) and not r["shed"]:
            detail += "  " + r["body"][:90].replace("\n", " ")
        print("  %-34s %-9s %6.2fs  %s" % (label[:34], mark, r["elapsed"], detail))
        return r

    print("\n=== phase A: max_tokens sweep (messages untouched) ===")
    for n in sweep:
        run(with_max_tokens(raw, n), "max_tokens=%d" % n)

    if grow:
        print("\n=== phase B: grow the conversation (fresh tokens) ===")
        for f in grow:
            g = grown(raw, f)
            if g is None:
                continue
            run(g, "grow x%d (~%.0fk tok)" % (f, approx_tokens(g) / 1000))

    print("\n" + "=" * 92)
    print("VERDICT")
    print("=" * 92)
    shed = [r for r in results if r.get("shed")]
    other = [r for r in results if r.get("status") not in (200, None) and not r.get("shed")]
    print("%d requests: %d x 200, %d x 400 '%s', %d other."
          % (len(results), sum(1 for r in results if r.get("status") == 200),
             len(shed), SHED, len(other)))
    if shed:
        print("\nREPRODUCED at:")
        for r in shed:
            print("  %-34s %d bytes  request-id %s"
                  % (r["label"], r["body_bytes"], r.get("request_id")))
        oks = [r for r in results if r.get("status") == 200]
        if oks:
            print("\nLargest accepted: %s (%d bytes)"
                  % (oks[-1]["label"], oks[-1]["body_bytes"]))
    elif other:
        print("\nNo shed 400, but other refusals appeared - read them above; a limit")
        print("reported with a DIFFERENT message is still the boundary we are after.")
    else:
        print("\nNo limit found in this range.")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"body_file": args.body, "url": args.url,
                   "sweep": sweep, "grow": grow, "results": results}, fh, indent=1)
    print("\nEvidence written: %s  (the API key appears nowhere in it)" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
