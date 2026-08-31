#!/usr/bin/env python3
"""
nebul_saturation_repro.py - Find the condition under which Nebul's Messages API
returns HTTP 400 "failed to extract prompt from request body".

WHAT IS ALREADY PROVEN, AND WHAT IS NOT
---------------------------------------
Proven (see nebul_ratelimit_proof.py / the replay evidence):

  * The rejected bytes are valid. Four request bodies captured on the wire at
    the moment Nebul rejected them were replayed byte-for-byte, SHA-256
    re-verified before each send, and accepted 10 times out of 10.
  * The rejection is not a parse failure. It comes back in 173-196 ms, while a
    successful response to a body of that size takes 1.4-22 s. The server
    cannot have read the body and failed to find a prompt in it.
  * Neither size nor content explains it. In every captured case the NEXT
    request from the same client succeeded and was LARGER - 252 KB after a
    rejected 192 KB, 345 KB after a rejected 188 KB.

NOT proven: that this is a request-rate or token-budget limit. A previous run
pushed 1 744 815 fresh (uncached) input tokens through in about a minute at
concurrency 8 with zero failures, which argues against a simple per-key token
budget. Nebul support also states it is not a rate limit on their side.

WHAT THIS SCRIPT TESTS INSTEAD
------------------------------
Every captured failure shares a signature the earlier load test did not
reproduce: several LARGE requests in flight at once, while the backend was
already slow. The two responses immediately before one rejection took 4.2 s and
4.1 s; the one immediately after took 22.7 s. That is a saturated queue.

So this ramps CONCURRENCY, not volume. At each level it fires a wave of unique
large requests (a random nonce in the first message defeats the prefix cache, so
each one is a genuine cache miss - see the note at the bottom) and records:

  * the number of requests in flight when each response arrived,
  * the concurrency level at which HTTP 400 first appears,
  * whether the rejection carries the fast-reject signature (< 500 ms),
  * a byte-identical canary sent at the moment of failure, to show once again
    that the content is fine while the server is refusing it.

COST
----
This sends real, uncached tokens and costs real money. The script estimates the
spend for the chosen ramp and refuses to start above --budget-usd without --yes.
Start small and escalate deliberately.

    python nebul_saturation_repro.py --dry-run            # plan + cost, sends nothing
    python nebul_saturation_repro.py --ramp 4,8,16        # a cheap first pass
    python nebul_saturation_repro.py --ramp 8,16,32,48 --yes

Standard library only. The API key is never printed or written to any file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

SHED_MESSAGE = "failed to extract prompt from request body"

FILLER = (
    "The repository contains many modules and services that interact with one "
    "another through well-defined interfaces. Each module owns its data and "
    "exposes a narrow surface to the rest of the system. "
)

TOOLS = [
    {
        "name": "read_file",
        "description": "Read the contents of a file from disk.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "run_command",
        "description": "Execute a shell command and return its output.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
]


def build_payload(model, target_bytes, nonce="", max_tokens=16, stream=False):
    """A plain, fully documented Messages request padded to target_bytes.

    A non-empty nonce goes into the FIRST message. Prefix caches match from the
    start of the conversation, so a nonce in position 0 makes the whole body a
    cache miss - which is what makes this cost real prefill and actually load
    the backend. Without it the server answers from cache and the test measures
    nothing (observed: 74 fresh tokens out of 41 216 on a 270 KB body).
    """
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": "You are a helpful coding assistant working in a large repository.",
        "tools": TOOLS,
        "messages": [],
    }
    if stream:
        body["stream"] = True
    if nonce:
        body["messages"].append({"role": "user", "content": "Session " + nonce + ": review this excerpt."})
        body["messages"].append({"role": "assistant", "content": "Understood, session " + nonce + "."})

    chunk = FILLER * 20
    while len(json.dumps(body)) < target_bytes - 200:
        role = "user" if len(body["messages"]) % 2 == 0 else "assistant"
        body["messages"].append({"role": role, "content": chunk})
    if len(body["messages"]) % 2 != 0:
        body["messages"].append({"role": "assistant", "content": "Noted."})
    body["messages"].append({"role": "user", "content": "Reply with exactly: PONG"})
    return json.dumps(body).encode("utf-8")


def load_seed(path):
    """Read a body captured by nebul-proxy.mjs and return it as a dict.

    Synthetic payloads differ from real agent traffic in shape: the captured
    bodies carry 33-35 tool definitions with full JSON schemas, cache_control
    breakpoints, and tool_result blocks. If the rejection depends on any of
    that, a synthetic load test will never see it.
    """
    with open(path, "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def seed_variant(seed, nonce, max_tokens=None, stream=None):
    """Return the seed body with a unique marker, so it cannot be cache-served.

    The marker goes into the FIRST message, because prefix caches match from
    the start of the conversation. Everything else — tools, system, block
    structure — is left exactly as the real client sent it.
    """
    body = json.loads(json.dumps(seed))  # deep copy, cheap enough at this size
    msgs = body.get("messages") or []
    marker = "[run " + nonce + "] "
    if msgs:
        c = msgs[0].get("content")
        if isinstance(c, str):
            msgs[0]["content"] = marker + c
        elif isinstance(c, list):
            c.insert(0, {"type": "text", "text": marker})
        else:
            msgs.insert(0, {"role": "user", "content": marker})
    else:
        body["messages"] = [{"role": "user", "content": marker}]
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if stream is not None:
        body["stream"] = stream
    return json.dumps(body).encode("utf-8")


def send(url, headers, body_bytes, timeout):
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return {"status": resp.status, "elapsed_s": round(time.monotonic() - t0, 3),
                    "headers": dict(resp.headers.items()), "body_preview": text[:800]}
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return {"status": e.code, "elapsed_s": round(time.monotonic() - t0, 3),
                "headers": dict(e.headers.items()) if e.headers else {}, "body_preview": text[:800]}
    except urllib.error.URLError as e:
        return {"status": 0, "elapsed_s": round(time.monotonic() - t0, 3),
                "headers": {}, "body_preview": "connection error: " + str(e)}
    except Exception as e:
        return {"status": 0, "elapsed_s": round(time.monotonic() - t0, 3),
                "headers": {}, "body_preview": "transport error: " + repr(e)}


def parse_error(preview):
    try:
        d = json.loads(preview)
        detail = d.get("detail", d)
        return str(detail.get("message", ""))[:120] if isinstance(detail, dict) else str(detail)[:120]
    except Exception:
        return preview[:120].replace("\n", " ")


def parse_usage(preview):
    try:
        u = json.loads(preview).get("usage")
        if u:
            return u
    except Exception:
        pass
    for line in preview.splitlines():
        if line.startswith("data:"):
            try:
                evt = json.loads(line[5:].strip())
            except Exception:
                continue
            u = evt.get("usage") or (evt.get("message") or {}).get("usage")
            if u:
                return u
    return {}


class Harness:
    """Tracks in-flight depth so a failure can be attributed to a concurrency
    level rather than merely to elapsed time."""

    def __init__(self, url, headers, timeout):
        self.url, self.headers, self.timeout = url, headers, timeout
        self.log = []
        self.lock = threading.Lock()
        self.inflight = 0
        self.peak_inflight = 0
        self.t0 = time.monotonic()

    def fire(self, level, phase, seq, body):
        digest = hashlib.sha256(body).hexdigest()
        with self.lock:
            self.inflight += 1
            depth_at_send = self.inflight
            self.peak_inflight = max(self.peak_inflight, self.inflight)
        r = send(self.url, self.headers, body, self.timeout)
        with self.lock:
            depth_at_reply = self.inflight
            self.inflight -= 1
        usage = parse_usage(r["body_preview"]) if r["status"] == 200 else {}
        r.update({
            "level": level, "phase": phase, "seq": seq,
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "t_rel_s": round(time.monotonic() - self.t0, 2),
            "bytes": len(body), "sha256": digest,
            "inflight_at_send": depth_at_send, "inflight_at_reply": depth_at_reply,
            "error_message": "" if r["status"] == 200 else parse_error(r["body_preview"]),
            "request_id": r["headers"].get("x-request-id") or r["headers"].get("X-Request-Id", ""),
            "input_tokens": usage.get("input_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "is_shed": r["status"] == 400 and SHED_MESSAGE in r["body_preview"],
        })
        with self.lock:
            self.log.append(r)
            tag = "OK " if r["status"] == 200 else "ERR"
            tok = ""
            if r["input_tokens"] is not None:
                tok = " fresh=%-6s cached=%-5s" % (r["input_tokens"], r["cache_read_input_tokens"] or 0)
            print("  [c=%-3d %-6s #%03d] %s HTTP %-3s %7.2fs %4dKB inflight=%-3d%s %s"
                  % (level, phase, seq, tag, r["status"], r["elapsed_s"], len(body) // 1024,
                     depth_at_send, tok, r["error_message"][:44]))
        return r


def main():
    ap = argparse.ArgumentParser(
        description="Ramp concurrency against Nebul /v1/messages to reproduce the HTTP 400.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--env-file", default=None, help="Path to a .env holding NEBUL_API_KEY")
    ap.add_argument("--base-url", default="https://api.inference.nebul.io")
    ap.add_argument("--model", default="zai-org/GLM-5.2-FP8")
    ap.add_argument("--auth-style", choices=["bearer", "apikey"], default="bearer")
    ap.add_argument("--ramp", default="4,8,16,24",
                    help="Comma-separated concurrency levels to try, in order")
    ap.add_argument("--per-level", type=int, default=0,
                    help="Requests per level (0 = same as the level, i.e. one full wave)")
    ap.add_argument("--seed-body", default=None, metavar="PATH",
                    help="Load a body captured by nebul-proxy.mjs (nebul-fail-<n>.bin) and use "
                         "ITS shape for the load, with a unique marker injected into the first "
                         "message so nothing is cache-served. Use this when a synthetic payload "
                         "fails to reproduce: real agent bodies carry 30+ tool schemas, "
                         "cache_control breakpoints and tool_result blocks that synthetic ones "
                         "do not. Overrides --payload-kb.")
    ap.add_argument("--payload-kb", type=int, default=200,
                    help="Body size; the captured failures were 179-430KB")
    ap.add_argument("--max-tokens", type=int, default=1200,
                    help="Output budget. Higher keeps each request in flight longer, which is "
                         "what builds queue depth - the condition every captured failure shared.")
    ap.add_argument("--stream", action="store_true", default=True)
    ap.add_argument("--no-stream", dest="stream", action="store_false")
    ap.add_argument("--beta", action="store_true", default=True,
                    help="POST to /v1/messages?beta=true, as Claude Code does")
    ap.add_argument("--no-beta", dest="beta", action="store_false")
    ap.add_argument("--continue-after-400", action="store_true",
                    help="Keep ramping after the first rejection instead of stopping")
    ap.add_argument("--settle", type=float, default=5.0, help="Seconds between levels")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--input-usd-per-mtok", type=float, default=1.91)
    ap.add_argument("--output-usd-per-mtok", type=float, default=9.57)
    ap.add_argument("--budget-usd", type=float, default=4.0,
                    help="Refuse to start if the estimate exceeds this, unless --yes")
    ap.add_argument("--yes", action="store_true", help="Proceed past the budget check")
    ap.add_argument("--out-prefix", default=None)
    ap.add_argument("--dry-run", action="store_true", help="Print the plan and cost, send nothing")
    args = ap.parse_args()

    api_key = args.api_key or os.environ.get("NEBUL_API_KEY")
    if not api_key and args.env_file:
        with open(args.env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "NEBUL_API_KEY":
                    api_key = v.strip().strip('"').strip("'")
                    break
    if not api_key and not args.dry_run:
        print("ERROR: no API key. Set NEBUL_API_KEY, or pass --api-key / --env-file.", file=sys.stderr)
        sys.exit(2)

    levels = [int(x) for x in args.ramp.split(",") if x.strip()]
    waves = [(lvl, args.per_level or lvl) for lvl in levels]
    total_requests = sum(n for _, n in waves)

    seed = load_seed(args.seed_body) if args.seed_body else None
    if seed is not None:
        sample = seed_variant(seed, "estimate", args.max_tokens, args.stream)
        print("seed     : %s -> %dKB, %d tools, %d messages, model %s"
              % (args.seed_body, len(sample) // 1024, len(seed.get("tools") or []),
                 len(seed.get("messages") or []), seed.get("model")))
    else:
        sample = build_payload(args.model, args.payload_kb * 1024, nonce="estimate", stream=args.stream)
    approx_in_tok = len(sample) / 4.0        # ~4 bytes per token for this filler
    est = total_requests * (approx_in_tok * args.input_usd_per_mtok
                            + args.max_tokens * args.output_usd_per_mtok) / 1_000_000

    print("plan     : levels %s -> %d requests of ~%dKB (max_tokens=%d)"
          % (levels, total_requests, len(sample) // 1024, args.max_tokens))
    print("wire     : stream=%s beta=%s  model=%s" % (args.stream, args.beta, args.model))
    print("cost est : ~$%.2f  (%.0f fresh input tok/req at $%.2f/M, output at $%.2f/M)"
          % (est, approx_in_tok, args.input_usd_per_mtok, args.output_usd_per_mtok))
    print("           stops at the first HTTP 400 unless --continue-after-400,")
    print("           so a reproduction usually costs far less than the estimate.")
    if args.dry_run:
        print("(--dry-run, nothing sent)")
        return
    if est > args.budget_usd and not args.yes:
        print("\nREFUSING TO START: estimate $%.2f exceeds --budget-usd $%.2f."
              % (est, args.budget_usd), file=sys.stderr)
        print("Lower --ramp / --payload-kb / --max-tokens, raise --budget-usd, or pass --yes.",
              file=sys.stderr)
        sys.exit(3)

    url = args.base_url.rstrip("/") + "/v1/messages" + ("?beta=true" if args.beta else "")
    headers = {"content-type": "application/json", "anthropic-version": "2023-06-01",
               "user-agent": "nebul-saturation-repro/1.0"}
    if args.beta:
        headers["anthropic-beta"] = "fine-grained-tool-streaming-2025-05-14"
    if args.auth_style == "bearer":
        headers["authorization"] = "Bearer " + api_key
    else:
        headers["x-api-key"] = api_key

    # One fixed body, reused whenever the server starts refusing, to show the
    # content is still valid at that exact moment.
    canary = (seed_variant(seed, "canary-fixed", 16, args.stream) if seed is not None
              else build_payload(args.model, args.payload_kb * 1024, max_tokens=16, stream=args.stream))
    canary_hash = hashlib.sha256(canary).hexdigest()
    print("canary   : %dKB sha256=%s\n" % (len(canary) // 1024, canary_hash))

    h = Harness(url, headers, args.timeout)
    stop = threading.Event()
    first_shed = None

    for level, count in waves:
        if stop.is_set():
            break
        print("=== concurrency %d - %d unique requests of %dKB ===" % (level, count, args.payload_kb))

        def one(i, lvl=level):
            if stop.is_set():
                return
            nonce = os.urandom(8).hex()
            body = (seed_variant(seed, nonce, args.max_tokens, args.stream) if seed is not None
                    else build_payload(args.model, args.payload_kb * 1024, nonce=nonce,
                                       max_tokens=args.max_tokens, stream=args.stream))
            r = h.fire(lvl, "load", i, body)
            if r["status"] != 200 and not args.continue_after_400:
                stop.set()

        with ThreadPoolExecutor(max_workers=level) as pool:
            list(pool.map(one, range(1, count + 1)))

        shed_now = [e for e in h.log if e["is_shed"]]
        if shed_now and first_shed is None:
            first_shed = shed_now[0]
            print("\n  --> HTTP 400 first appeared at concurrency %d. Sending the canary now."
                  % first_shed["level"])
            h.fire(first_shed["level"], "canary", 1, canary)
            if not args.continue_after_400:
                break
        if not stop.is_set() and args.settle:
            time.sleep(args.settle)

    # ---------------- report ----------------
    ok = [e for e in h.log if e["status"] == 200]
    shed = [e for e in h.log if e["is_shed"]]
    other_fail = [e for e in h.log if e["status"] != 200 and not e["is_shed"]]
    fresh = sum(e["input_tokens"] or 0 for e in h.log)
    cached = sum(e["cache_read_input_tokens"] or 0 for e in h.log)
    out_tok = sum(e["output_tokens"] or 0 for e in h.log)
    spend = (fresh * args.input_usd_per_mtok + out_tok * args.output_usd_per_mtok) / 1_000_000
    rl_headers = sorted({k for e in h.log for k in e["headers"] if k.lower().startswith("x-ratelimit")})

    v = []
    v.append("Endpoint: POST %s   Model: %s" % (url, args.model))
    v.append("Requests: %d sent - %d ok, %d rejected with \"%s\", %d other failures."
             % (len(h.log), len(ok), len(shed), SHED_MESSAGE, len(other_fail)))
    v.append("Peak in-flight reached: %d" % h.peak_inflight)
    v.append("Token accounting: %d fresh input, %d served from cache (%.1f%%), %d output. "
             "Actual spend this run: ~$%.2f."
             % (fresh, cached, 100.0 * cached / (cached + fresh) if (cached + fresh) else 0.0,
                out_tok, spend))
    if ok:
        lat = sorted(e["elapsed_s"] for e in ok)
        v.append("Successful latency: median %.1fs, p90 %.1fs, max %.1fs"
                 % (statistics.median(lat), lat[int(len(lat) * 0.9)], lat[-1]))
    v.append("")

    if shed:
        f = shed[0]
        fast = [e for e in shed if e["elapsed_s"] < 0.5]
        v.append("REPRODUCED at concurrency %d." % f["level"])
        v.append("  first rejection : %s  after %.2fs  in-flight %d  x-request-id %s"
                 % (f["at"], f["elapsed_s"], f["inflight_at_send"], f["request_id"] or "(none)"))
        v.append("  fast rejections : %d of %d came back in under 500ms - the server did not read "
                 "the body before refusing it." % (len(fast), len(shed)))
        bigger_ok = [e for e in ok if e["t_rel_s"] > f["t_rel_s"] and e["bytes"] > f["bytes"]]
        if bigger_ok:
            b = bigger_ok[0]
            v.append("  after it        : a LARGER body (%d bytes vs %d) succeeded at t+%.1fs - "
                     "size and content cannot explain the rejection."
                     % (b["bytes"], f["bytes"], b["t_rel_s"]))
        canaries = [e for e in h.log if e["phase"] == "canary"]
        for c in canaries:
            v.append("  canary          : the fixed body (sha256 %s) sent while the server was "
                     "refusing returned HTTP %s." % (canary_hash[:16], c["status"]))
        v.append("")
        v.append("This is admission control / load shedding, reported as HTTP 400 bad_request with "
                 "a parse-error message. It should be HTTP 429 with Retry-After: 400 is not a "
                 "retryable status, so a correct client fails the operation instead of backing off.")
    else:
        v.append("NOT REPRODUCED at these levels (peak in-flight %d)." % h.peak_inflight)
        v.append("Raise --ramp, --payload-kb or --max-tokens. Check the cache figure above first: "
                 "if a large share was served from cache, the backend was never actually loaded "
                 "and this run proves nothing.")
    v.append("")
    v.append("x-ratelimit-* headers seen on any of the %d responses: %s"
             % (len(h.log), ", ".join(rl_headers) if rl_headers else "NONE"))

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    for line in v:
        print(line)

    prefix = args.out_prefix or ("nebul_saturation_"
                                 + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    with open(prefix + ".json", "w", encoding="utf-8") as fh:
        json.dump({"url": url, "model": args.model, "params": vars(args),
                   "canary_sha256": canary_hash, "peak_inflight": h.peak_inflight,
                   "verdict": v, "log": h.log}, fh, indent=1)
    with open(prefix + ".md", "w", encoding="utf-8") as fh:
        fh.write("# Nebul saturation test - %s\n\n"
                 % datetime.now(timezone.utc).isoformat(timespec="seconds"))
        for line in v:
            fh.write(line + "\n" if line.startswith("  ") else line + "\n\n")
        fh.write("\n## Per-request log\n\n")
        fh.write("| conc | phase | # | t+s | status | elapsed | KB | in-flight | fresh tok | error | x-request-id |\n")
        fh.write("|---|---|---|---|---|---|---|---|---|---|---|\n")
        for e in sorted(h.log, key=lambda x: x["t_rel_s"]):
            fh.write("| %d | %s | %d | %.1f | %s | %.2f | %d | %d | %s | %s | %s |\n"
                     % (e["level"], e["phase"], e["seq"], e["t_rel_s"], e["status"], e["elapsed_s"],
                        e["bytes"] // 1024, e["inflight_at_send"],
                        e["input_tokens"] if e["input_tokens"] is not None else "-",
                        e["error_message"], e["request_id"]))
    print("\nEvidence written:\n  %s.json\n  %s.md" % (prefix, prefix))
    print("(the API key appears in neither file)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
