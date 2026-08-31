#!/usr/bin/env python3
"""Hunt for a bad backend replica by sampling the pool with many cheap requests.

Everything content-shaped has now been ruled out with evidence: the exact bytes,
Claude Code's exact anthropic-beta set, five transports, and max_tokens up to
400000 were all accepted. What is left is the shape of the failures in TIME.

They cluster:

    2026-08-25  14:21:10, 14:22:37, 14:24:22   then 14:38:07
    2026-08-27  15:59:18                       then 17:09:53, 17:13:58, 17:13:59

Bursts inside a few minutes, separated by hours of clean traffic. That is what
one unhealthy replica in a load-balanced pool looks like, and it explains every
other observation at once: the same bytes succeed on the next attempt (a
different replica answers), the refusal is faster than a normal round trip (the
broken replica fails without doing work), the proxy's blind retry recovers, and
no x-ratelimit-* header is ever involved.

If that is the mechanism, body size should be irrelevant - so this samples the
pool with MANY TINY requests instead of a few large ones. 400 five-token requests
cost about a cent, where 400 replays of a real 196 KB body would cost about $15.

The API key is read from .env and is never printed or written to disk.
"""

import argparse
import json
import os
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nebul_transport_repro import (  # noqa: E402
    HERE, SHED, load_env, send_once,
)


def tiny_body(model, max_tokens, i):
    """Small but unique, so nothing is answered from cache and every request
    genuinely reaches a backend."""
    return json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": "probe %d: reply with the word ok" % i}],
    }, separators=(",", ":")).encode("utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--key-var", default="NEBUL_API_KEY")
    ap.add_argument("--url", default="https://api.inference.nebul.io/v1/messages?beta=true")
    ap.add_argument("--model", default="zai-org/GLM-5.2-FP8")
    ap.add_argument("--count", type=int, default=400, help="Total probes to send.")
    ap.add_argument("--concurrency", type=int, default=10)
    ap.add_argument("--max-tokens", type=int, default=5)
    ap.add_argument("--big-body", default=None,
                    help="Optional: also send this captured body once every "
                         "--big-every probes, to test whether size matters.")
    ap.add_argument("--big-every", type=int, default=50)
    ap.add_argument("--stop-on-shed", action="store_true",
                    help="Stop as soon as the shed 400 appears.")
    ap.add_argument("--out", default=os.path.join(HERE, "nebul_replica_hunt.json"))
    args = ap.parse_args()

    env = load_env(args.env_file)
    key = env.get(args.key_var) or os.environ.get(args.key_var)
    if not key:
        print("No %s in %s or the environment." % (args.key_var, args.env_file))
        return 2

    big = open(args.big_body, "rb").read() if args.big_body else None

    print("target   : %s" % args.url)
    print("plan     : %d probes at concurrency %d, max_tokens=%d"
          % (args.count, args.concurrency, args.max_tokens))
    if big:
        print("           plus the %d-byte capture every %d probes"
              % (len(big), args.big_every))
    print("cost est : ~$%.3f for the probes%s"
          % (args.count * 30 * 1.91 / 1_000_000,
             " (the big body dominates: ~$%.2f)"
             % (args.count / args.big_every * len(big) / 4 * 0.76 / 1_000_000)
             if big else ""))
    print()

    results = []
    lock = threading.Lock()
    stop = threading.Event()
    counter = {"n": 0}
    started = time.time()

    def worker():
        while not stop.is_set():
            with lock:
                counter["n"] += 1
                i = counter["n"]
            if i > args.count:
                return
            use_big = big is not None and i % args.big_every == 0
            body = big if use_big else tiny_body(args.model, args.max_tokens, i)
            r = send_once(args.url, body, key)
            r["probe"] = i
            r["big"] = bool(use_big)
            with lock:
                results.append(r)
                if r["shed"] or (r["status"] not in (200, None)):
                    print("  probe %-5d %-9s %6.2fs  %s  %s" % (
                        i, "SHED 400" if r["shed"] else r["status"], r["elapsed"],
                        r.get("request_id") or "", r["body"][:70].replace("\n", " ")))
                    if r["shed"] and args.stop_on_shed:
                        stop.set()
                elif i % 50 == 0:
                    ok = sum(1 for x in results if x.get("status") == 200)
                    print("  ... %d sent, %d ok, %.1fs elapsed"
                          % (len(results), ok, time.time() - started))

    threads = [threading.Thread(target=worker) for _ in range(args.concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    print("\n" + "=" * 92)
    print("VERDICT")
    print("=" * 92)
    codes = Counter(r.get("status") for r in results)
    shed = [r for r in results if r.get("shed")]
    print("%d probes in %.1fs: %s" % (
        len(results), time.time() - started,
        ", ".join("%s x%d" % (k, v) for k, v in sorted(codes.items(), key=lambda x: str(x[0])))))
    print("shed 400 ('%s'): %d" % (SHED, len(shed)))
    if shed:
        print("\nREPRODUCED. Request ids for nebul:")
        for r in shed:
            print("  %s  probe %d  %s body  %.0fms"
                  % (r.get("request_id"), r["probe"],
                     "big" if r["big"] else "tiny", r["elapsed"] * 1000))
        big_shed = sum(1 for r in shed if r["big"])
        print("\n%d of %d shed responses were the large body -> size %s the trigger."
              % (big_shed, len(shed),
                 "IS likely" if big_shed == len(shed) else "is NOT"))
    else:
        print("\nNot seen in this sample. Either no unhealthy replica is in the pool")
        print("right now, or the trigger needs conditions this sample did not create.")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"at": datetime.now(timezone.utc).isoformat(),
                   "url": args.url, "count": args.count,
                   "concurrency": args.concurrency,
                   "results": [{k: v for k, v in r.items() if k != "headers"}
                               for r in results]}, fh, indent=1)
    print("\nEvidence written: %s  (the API key appears nowhere in it)" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
