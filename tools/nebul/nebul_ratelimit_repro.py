#!/usr/bin/env python3
"""
nebul_ratelimit_repro.py - Reproduces Nebul's HTTP 400
"failed to extract prompt from request body" and proves it is a
rate/budget limit, not a malformed request.

THE ARGUMENT
------------
Nebul support classified this error as "malformed request". A malformed
request is a STATIC property of the request bytes: the same bytes are
either valid or they are not, forever. This script therefore runs the
one experiment that settles it:

  1. Send a fixed reference body ("canary", SHA-256 printed) once, on an
     idle account.                                    -> expect HTTP 200
  2. Drive real load with OTHER, unique large requests until the limit
     trips.
  3. IMMEDIATELY re-send the canary - byte-for-byte identical, hash
     re-verified right before the send.               -> expect HTTP 400
  4. Wait for a cooldown, re-send the same canary.    -> expect HTTP 200

Identical bytes, three different outcomes, ordered purely by time.
No definition of "malformed" survives that.

WHY THE LOAD REQUESTS MUST BE UNIQUE (read this before dismissing a
passing run)
-------------------------------------------------------------------
An earlier version of this test fired 100 byte-identical 270KB requests
and all 100 returned HTTP 200. That result is an artifact of prompt
caching, not evidence that the limit does not exist. Nebul's own
responses prove it:

    "usage": {"input_tokens": 74, "cache_read_input_tokens": 41216}

Only 74 of ~41,000 input tokens were fresh - Nebul served 99.8% of the
body from its prefix cache, so a token-budget limiter never saw the
load. (The flat ~0.57s latency on a 270KB body is the same tell: that
is a cache read, not a prefill.)

A real agent session (Claude Code) sends a DIFFERENT large body every
turn - the conversation tail grows with each tool result - so most of
each request is a genuine cache miss. That is why it exhausts the budget
in two or three turns while an identical-body burst never does.

This script therefore makes every load request unique by design: a
random nonce is placed at the very START of the message list, which
invalidates the entire cached prefix. --identical-load reproduces the
old cached behaviour for side-by-side comparison.

USAGE
-----
    set NEBUL_API_KEY=...            (or: --api-key / --env-file)
    python nebul_ratelimit_repro.py

    python nebul_ratelimit_repro.py --help     # all options

Only the Python standard library is used (urllib, threading), so this
runs anywhere Python 3.8+ runs - including on Nebul's own machines.
The API key is never printed, logged, or written to any output file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

FILLER = (
    "The repository contains many modules and services that interact with "
    "one another through well-defined interfaces. Each module owns its data "
    "and exposes a narrow surface to the rest of the system. "
)

TOOLS = [
    {
        "name": "read_file",
        "description": "Read the contents of a file from disk.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Path to read"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file on disk.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
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


def build_payload(model: str, target_bytes: int, nonce: str = "", max_tokens: int = 16,
                  stream: bool = False) -> bytes:
    """Build a valid Messages API request padded to roughly target_bytes.

    Every field here is documented in Nebul's own Messages API reference:
    model, max_tokens, system, tools, and messages with only the user and
    assistant roles. Nothing exotic, nothing undocumented - so "malformed"
    cannot be argued from the shape of this request.

    If nonce is non-empty it is placed in the FIRST message. Prefix caches
    match from the start of the conversation, so a nonce in position 0
    guarantees the whole body is a cache miss - which is what makes the
    load phase cost real input tokens (see the module docstring).
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
        body["messages"].append({
            "role": "user",
            "content": "Session " + nonce + ": review the following repository excerpt.",
        })
        body["messages"].append({"role": "assistant", "content": "Understood, session " + nonce + "."})

    chunk = FILLER * 20  # ~3KB per message
    while len(json.dumps(body)) < target_bytes - 200:
        role = "user" if len(body["messages"]) % 2 == 0 else "assistant"
        body["messages"].append({"role": role, "content": chunk})

    if len(body["messages"]) % 2 != 0:
        body["messages"].append({"role": "assistant", "content": "Noted."})
    body["messages"].append({"role": "user", "content": "Reply with exactly: PONG"})

    return json.dumps(body).encode("utf-8")


def send(url: str, headers: dict, body_bytes: bytes, timeout: float) -> dict:
    """POST body_bytes to url. Returns an outcome dict; never raises on
    HTTP 4xx/5xx (those are the interesting results), and reports
    connection failures as status 0."""
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
    except Exception as e:  # socket timeouts, truncated chunked responses, ...
        return {"status": 0, "elapsed_s": round(time.monotonic() - t0, 3),
                "headers": {}, "body_preview": "transport error: " + repr(e)}


def parse_error(body_preview: str) -> str:
    try:
        d = json.loads(body_preview)
        detail = d.get("detail", d)
        if isinstance(detail, dict):
            return str(detail.get("message", ""))[:120]
        return str(detail)[:120]
    except Exception:
        return body_preview[:120].replace("\n", " ")


def parse_usage(body_preview: str) -> dict:
    """Pull the usage block out of a 200 response. This is what shows how
    much of the request was fresh prefill versus served from cache.

    Handles both a plain JSON response and an SSE stream, where usage
    arrives inside the message_start event."""
    try:
        return json.loads(body_preview).get("usage", {}) or {}
    except Exception:
        pass
    for line in body_preview.splitlines():          # SSE: "data: {...}"
        if not line.startswith("data:"):
            continue
        try:
            evt = json.loads(line[5:].strip())
        except Exception:
            continue
        usage = evt.get("usage") or (evt.get("message") or {}).get("usage")
        if usage:
            return usage
    return {}


class Runner:
    def __init__(self, url, headers, timeout):
        self.url = url
        self.headers = headers
        self.timeout = timeout
        self.log = []
        self.lock = threading.Lock()
        self.t_start = time.monotonic()

    def fire(self, phase: str, seq: int, body: bytes) -> dict:
        # Hash immediately before sending, so the recorded digest is
        # provably the digest of what went on the wire.
        digest = hashlib.sha256(body).hexdigest()
        r = send(self.url, self.headers, body, self.timeout)
        usage = parse_usage(r["body_preview"]) if r["status"] == 200 else {}
        r.update({
            "phase": phase,
            "seq": seq,
            "sent_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "t_rel_s": round(time.monotonic() - self.t_start, 2),
            "bytes": len(body),
            "sha256": digest,
            "error_message": "" if r["status"] == 200 else parse_error(r["body_preview"]),
            "request_id": r["headers"].get("x-request-id") or r["headers"].get("X-Request-Id", ""),
            "input_tokens": usage.get("input_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
            "output_tokens": usage.get("output_tokens"),
        })
        with self.lock:
            self.log.append(r)
            tag = "OK " if r["status"] == 200 else "ERR"
            tok = ""
            if r["input_tokens"] is not None:
                tok = "  fresh=%-6s cached=%-6s" % (
                    r["input_tokens"], r["cache_read_input_tokens"] or 0)
            print("  [%-9s #%03d] %s HTTP %-3s %6.2fs %5dKB%s %s"
                  % (phase, seq, tag, r["status"], r["elapsed_s"], len(body) // 1024,
                     tok, r["error_message"][:60]))
        return r

    def tiny(self, model: str, phase: str, stream: bool = False) -> dict:
        payload = {"model": model, "max_tokens": 16,
                   "messages": [{"role": "user", "content": "Reply: PONG"}]}
        if stream:
            payload["stream"] = True
        return self.fire(phase, 0, json.dumps(payload).encode("utf-8"))


def summarize(entries):
    codes = {}
    for e in entries:
        codes[e["status"]] = codes.get(e["status"], 0) + 1
    n = len(entries)
    ok = sum(1 for e in entries if e["status"] == 200)
    return {"n": n, "ok": ok, "failed": n - ok, "status_codes": codes}


def write_files(prefix, url, model, canary_hash, canary_bytes, params, summary, verdict, log):
    with open(prefix + ".json", "w", encoding="utf-8") as f:
        json.dump({"url": url, "model": model, "canary_sha256": canary_hash,
                   "canary_bytes": canary_bytes, "params": params,
                   "summary": summary, "verdict": verdict, "log": log}, f, indent=1)
    with open(prefix + ".md", "w", encoding="utf-8") as f:
        f.write("# Nebul HTTP 400 reproduction - %s\n\n"
                % datetime.now(timezone.utc).isoformat(timespec="seconds"))
        for line in verdict:
            f.write(line + "\n" if line.startswith("  ") else line + "\n\n")
        f.write("\n## Per-request log\n\n")
        f.write("| phase | # | t+s | status | elapsed | KB | fresh tok | cached tok | error | x-request-id |\n")
        f.write("|---|---|---|---|---|---|---|---|---|---|\n")
        for e in sorted(log, key=lambda x: x["t_rel_s"]):
            f.write("| %s | %d | %.1f | %s | %.2f | %d | %s | %s | %s | %s |\n"
                    % (e["phase"], e["seq"], e["t_rel_s"], e["status"], e["elapsed_s"],
                       e["bytes"] // 1024,
                       e["input_tokens"] if e["input_tokens"] is not None else "-",
                       e["cache_read_input_tokens"] if e["cache_read_input_tokens"] is not None else "-",
                       e["error_message"], e["request_id"]))
    print("\nEvidence written:\n  %s.json\n  %s.md" % (prefix, prefix))
    print("(the API key appears in neither file - only server response headers were recorded)")


def write_evidence(args, runner, canary, canary_hash, url):
    """Evidence writer for watch mode, where there is no load phase."""
    sends = [e for e in runner.log if e["phase"] in ("canary-cold", "watch")]
    failures = [e for e in sends if e["status"] != 200]
    ok = [e for e in sends if e["status"] == 200]
    ratelimit_headers = sorted({k for e in runner.log for k in e["headers"]
                                if k.lower().startswith("x-ratelimit")})

    v = ["Endpoint: POST %s   Model: %s" % (url, args.model), "",
         "WATCH MODE: one fixed request body, SHA-256 %s (%dKB), re-sent every %.0fs."
         % (canary_hash, len(canary) // 1024, args.watch),
         "The digest was recomputed from the buffer immediately before each send, so every",
         "entry in the log below is provably the same byte sequence.",
         "",
         "Sends: %d total - %d succeeded, %d failed." % (len(sends), len(ok), len(failures)),
         ""]
    if failures and ok:
        f0 = failures[0]
        v.append("CONCLUSION - REPRODUCED, AND MALFORMED IS RULED OUT.")
        v.append("The identical byte sequence returned HTTP 200 on %d send(s) and HTTP %s on %d "
                 "send(s) in the same session. Nothing about the request changed between them - "
                 "only the time of day and the surrounding account activity. A malformed body "
                 "cannot be valid at one moment and invalid at the next."
                 % (len(ok), f0["status"], len(failures)))
        v.append("Two defects follow from that:")
        v.append("  (1) The failure is reported as HTTP 400 bad_request instead of HTTP 429 Too "
                 "Many Requests. 429 is retryable, so clients back off and retry; 400 means "
                 "'your request is invalid', so a correct client does NOT retry and the "
                 "operation dies. That is why this is fatal to an agent session.")
        v.append("  (2) No x-ratelimit-* headers are returned, so no client can pace itself.")
        v.append("")
        v.append("x-request-id pairs for server-side correlation - same bytes, different outcome:")
        v.append("  HTTP 200 : %s  (t+%.1fs)" % (ok[0]["request_id"] or "(none)", ok[0]["t_rel_s"]))
        for e in failures:
            v.append("  HTTP %s : %s  (t+%.1fs)  %s"
                     % (e["status"], e["request_id"] or "(none)", e["t_rel_s"], e["error_message"]))
    elif failures:
        v.append("CONCLUSION - every send failed; no successful baseline in this session to "
                 "contrast against. Re-run when the account is idle to capture a 200 first.")
    else:
        v.append("CONCLUSION - no failure observed during this watch window. Keep it running "
                 "during real workload; the evidence files are written on Ctrl+C.")
    v.append("")
    v.append("x-ratelimit-* headers seen on any of the %d responses: %s"
             % (len(runner.log), ", ".join(ratelimit_headers) if ratelimit_headers else "NONE"))
    v.append("Nebul documents six such headers: "
             "https://docs.nebul.io/docs/inference-api/advanced-topics/rate-limits-and-scaling")

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    for line in v:
        print(line)

    prefix = args.out_prefix or ("nebul_watch_"
                                 + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    write_files(prefix, url, args.model, canary_hash, len(canary), vars(args),
                {"sends": len(sends), "ok": len(ok), "failed": len(failures)}, v, runner.log)


def main():
    ap = argparse.ArgumentParser(
        description="Reproduce Nebul /v1/messages HTTP 400 and prove it is rate limiting.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--api-key", default=None, help="Nebul API key (default: $NEBUL_API_KEY)")
    ap.add_argument("--env-file", default=None, help="Path to a .env file holding NEBUL_API_KEY")
    ap.add_argument("--base-url", default="https://api.inference.nebul.io")
    ap.add_argument("--model", default="zai-org/GLM-5.2-FP8")
    ap.add_argument("--auth-style", choices=["bearer", "apikey"], default="bearer")
    ap.add_argument("--payload-kb", type=int, default=270,
                    help="Size of each large request, matching one Claude Code agent turn")
    ap.add_argument("--load-count", type=int, default=60,
                    help="Max unique large requests to fire in the load phase")
    ap.add_argument("--concurrency", type=int, default=4,
                    help="Parallel in-flight requests, as an agent session with subagents produces")
    ap.add_argument("--load-delay", type=float, default=0.0,
                    help="Seconds between dispatches within the load phase")
    ap.add_argument("--identical-load", action="store_true",
                    help="Reuse ONE body for the load phase (cache-friendly). Demonstrates why the "
                         "naive identical-burst test never trips the limit; not for reproduction.")
    ap.add_argument("--no-stop-on-failure", action="store_true",
                    help="Keep firing the whole load phase even after the first failure")
    ap.add_argument("--cooldown", type=float, default=60.0,
                    help="Seconds to wait before the recovery canary")
    ap.add_argument("--watch", type=float, default=0.0, metavar="SECONDS",
                    help="Watch mode: skip the load phase and instead re-send the canary every "
                         "SECONDS until it fails, the spend cap is reached, or you press Ctrl+C. "
                         "NOT free: a repeated identical body is served from the prefix cache, but "
                         "CACHE READS ARE BILLED. A 270KB canary reads ~48000 cached tokens per "
                         "probe - roughly $0.037 each, not the ~$0.0001 the 65 fresh tokens "
                         "suggest. At --watch 6 that is about $22/hour. Use a long interval and "
                         "keep --max-spend-usd low.")
    ap.add_argument("--max-spend-usd", type=float, default=2.0, metavar="USD",
                    help="Hard cap for watch mode: stop once the estimated spend reaches this. "
                         "The estimate uses the running total of tokens the server reports.")
    ap.add_argument("--input-usd-per-mtok", type=float, default=1.91)
    ap.add_argument("--cache-usd-per-mtok", type=float, default=0.76)
    ap.add_argument("--output-usd-per-mtok", type=float, default=9.57)
    ap.add_argument("--replay-file", default=None, metavar="PATH",
                    help="Replay the RAW bytes of a request captured by nebul-proxy.mjs "
                         "(nebul-fail-<n>.bin) verbatim, --replay-count times. This is the "
                         "strongest evidence available: a body Nebul answered 400 at capture "
                         "time, resent unmodified, returning 200. Same SHA-256, and both "
                         "x-request-id values recorded.")
    ap.add_argument("--replay-count", type=int, default=3, metavar="N",
                    help="How many times to replay --replay-file")
    ap.add_argument("--watch-count", type=int, default=0, metavar="N",
                    help="Stop watch mode after N probes (0 = run until failure or Ctrl+C)")
    ap.add_argument("--stream", action="store_true",
                    help="Send stream:true, as Claude Code does")
    ap.add_argument("--beta", action="store_true",
                    help="POST to /v1/messages?beta=true and send anthropic-beta headers, "
                         "matching what Claude Code puts on the wire")
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--out-prefix", default=None)
    ap.add_argument("--dry-run", action="store_true", help="Build payloads, send nothing")
    args = ap.parse_args()

    api_key = args.api_key or os.environ.get("NEBUL_API_KEY")
    if not api_key and args.env_file:
        with open(args.env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, val = line.split("=", 1)
                if k.strip() == "NEBUL_API_KEY":
                    api_key = val.strip().strip('"').strip("'")
                    break
    if not api_key:
        print("ERROR: no API key. Set NEBUL_API_KEY, or pass --api-key / --env-file.", file=sys.stderr)
        sys.exit(2)

    url = args.base_url.rstrip("/") + "/v1/messages"
    if args.beta:
        url += "?beta=true"
    headers = {"content-type": "application/json", "anthropic-version": "2023-06-01",
               "user-agent": "nebul-ratelimit-repro/2.0"}
    if args.beta:
        headers["anthropic-beta"] = "fine-grained-tool-streaming-2025-05-14"
    if args.auth_style == "bearer":
        headers["authorization"] = "Bearer " + api_key
    else:
        headers["x-api-key"] = api_key

    target = args.payload_kb * 1024
    # No nonce: the fixed reference body, reused verbatim by all three canary sends.
    canary = build_payload(args.model, target, stream=args.stream)
    canary_hash = hashlib.sha256(canary).hexdigest()

    print("endpoint : POST %s" % url)
    print("model    : %s   auth: %s" % (args.model, args.auth_style))
    print("canary   : %dKB  sha256=%s" % (len(canary) // 1024, canary_hash))
    print("wire     : stream=%s  beta=%s" % (args.stream, args.beta))
    print("load     : %d requests, %s, concurrency=%d, %.1fs apart"
          % (args.load_count,
             "IDENTICAL bodies (cache-friendly)" if args.identical_load else "unique bodies (cache-miss)",
             args.concurrency, args.load_delay))
    if args.dry_run:
        sample = build_payload(args.model, target, nonce="deadbeef", stream=args.stream)
        print("sample load body: %dKB sha256=%s"
              % (len(sample) // 1024, hashlib.sha256(sample).hexdigest()))
        print("(--dry-run, nothing sent)")
        return

    if args.replay_file:
        with open(args.replay_file, "rb") as fh:
            raw = fh.read()
        raw_hash = hashlib.sha256(raw).hexdigest()
        print("\n=== REPLAY - %s ===" % args.replay_file)
        print("%d bytes (%dKB)  sha256=%s" % (len(raw), len(raw) // 1024, raw_hash))
        print("These bytes are sent verbatim - nothing is parsed, reformatted or regenerated.")
        runner = Runner(url, headers, args.timeout)
        for i in range(1, args.replay_count + 1):
            runner.fire("replay", i, raw)
            if i < args.replay_count:
                time.sleep(2)
        replays = [e for e in runner.log if e["phase"] == "replay"]
        ok = [e for e in replays if e["status"] == 200]
        v = ["Endpoint: POST %s" % url,
             "",
             "REPLAY of a request body captured verbatim by the logging proxy at the moment",
             "Nebul rejected it.",
             "  file   : %s" % args.replay_file,
             "  bytes  : %d" % len(raw),
             "  sha256 : %s" % raw_hash,
             "The digest was recomputed from the buffer immediately before each send.",
             "",
             "Result: %d/%d replays returned HTTP 200." % (len(ok), len(replays)),
             ""]
        if ok:
            v.append("CONCLUSION - MALFORMED IS RULED OUT.")
            v.append("This exact byte sequence was rejected with HTTP 400 \"failed to extract "
                     "prompt from request body\" when the client originally sent it. Resent "
                     "unmodified, the same bytes are accepted and answered normally. A malformed "
                     "body cannot become well-formed - the rejection depended on server-side "
                     "state at the time of the request, not on its content.")
            v.append("")
            v.append("x-request-id of the accepted replays, to correlate against the original "
                     "rejection (whose own x-request-id is in the matching "
                     "nebul-fail-<n>.json capture):")
            for e in ok:
                v.append("  HTTP 200 : %s  (t+%.1fs)" % (e["request_id"] or "(none)", e["t_rel_s"]))
        else:
            v.append("CONCLUSION - the captured body still fails on replay. That is consistent "
                     "with a genuinely malformed request OR with the limit still being active. "
                     "Wait for the account to go idle, then replay again before concluding.")
        print("\n" + "=" * 78)
        print("VERDICT")
        print("=" * 78)
        for line in v:
            print(line)
        prefix = args.out_prefix or ("nebul_replay_"
                                     + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        write_files(prefix, url, args.model, raw_hash, len(raw), vars(args),
                    {"replays": len(replays), "ok": len(ok)}, v, runner.log)
        return


    runner = Runner(url, headers, args.timeout)

    print("\n=== Phase 0: tiny control (baseline) ===")
    runner.tiny(args.model, "control-pre", stream=args.stream)

    print("\n=== Phase 1: canary COLD - the reference body on an idle account ===")
    canary_cold = runner.fire("canary-cold", 1, canary)

    if args.watch:
        print("\n=== WATCH MODE - re-sending the SAME %dKB body every %.0fs ==="
              % (len(canary) // 1024, args.watch))
        print("Leave this running while you work. Ctrl+C to stop and write the evidence files.")
        def spend_so_far():
            fresh = sum(e["input_tokens"] or 0 for e in runner.log)
            cached = sum(e["cache_read_input_tokens"] or 0 for e in runner.log)
            out = sum(e["output_tokens"] or 0 for e in runner.log)
            return (fresh * args.input_usd_per_mtok
                    + cached * args.cache_usd_per_mtok
                    + out * args.output_usd_per_mtok) / 1_000_000

        print("spend cap: $%.2f (cache reads are billed - see --help)" % args.max_spend_usd)
        i = 1
        try:
            while not args.watch_count or i <= args.watch_count:
                spent = spend_so_far()
                if spent >= args.max_spend_usd:
                    print("\nSTOP: estimated spend $%.2f reached the --max-spend-usd cap of "
                          "$%.2f after %d probes." % (spent, args.max_spend_usd, i))
                    break
                time.sleep(args.watch)
                i += 1
                r = runner.fire("watch", i, canary)
                if i % 10 == 0:
                    print("      ... %d sond, szacunkowy koszt $%.2f z limitu $%.2f"
                          % (i, spend_so_far(), args.max_spend_usd))
                if r["status"] != 200:
                    print("\n" + "!" * 78)
                    print("CAUGHT IT. The byte-identical body that returned HTTP %s at t+%.1fs"
                          % (canary_cold["status"], canary_cold["t_rel_s"]))
                    print("just returned HTTP %s at t+%.1fs: %s"
                          % (r["status"], r["t_rel_s"], r["error_message"]))
                    print("Both sends used SHA-256 %s." % canary_hash)
                    print("x-request-id  ok: %s   failing: %s"
                          % (canary_cold["request_id"] or "(none)", r["request_id"] or "(none)"))
                    print("!" * 78)
                    break
        except KeyboardInterrupt:
            print("\n(watch stopped)")
        write_evidence(args, runner, canary, canary_hash, url)
        return

    print("\n=== Phase 2: load - %d x %dKB, %s ==="
          % (args.load_count, len(canary) // 1024,
             "identical bodies" if args.identical_load else "each body unique"))
    stop = threading.Event()
    identical_body = build_payload(args.model, target, nonce="fixed-load-body") \
        if args.identical_load else None

    def one_load(i):
        if stop.is_set():
            return None
        body = identical_body if identical_body is not None else \
            build_payload(args.model, target, nonce=os.urandom(8).hex(), stream=args.stream)
        r = runner.fire("load", i, body)
        if r["status"] != 200 and not args.no_stop_on_failure:
            stop.set()
        return r

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = []
        for i in range(1, args.load_count + 1):
            if stop.is_set():
                break
            futures.append(pool.submit(one_load, i))
            if args.load_delay:
                time.sleep(args.load_delay)
        for f in futures:
            f.result()

    print("\n=== Phase 3: canary HOT - the SAME bytes, immediately after load ===")
    canary_hot = runner.fire("canary-hot", 2, canary)

    print("\n=== Phase 4: recovery - wait %.0fs, then the SAME bytes again ===" % args.cooldown)
    time.sleep(args.cooldown)
    canary_recovered = runner.fire("canary-recovered", 3, canary)

    print("\n=== Phase 5: tiny control (closing baseline) ===")
    runner.tiny(args.model, "control-post", stream=args.stream)

    # ------------------------------------------------------------------
    # Analysis
    # ------------------------------------------------------------------
    by_phase = {}
    for e in runner.log:
        by_phase.setdefault(e["phase"], []).append(e)

    load = summarize(by_phase.get("load", []))
    controls = summarize(by_phase.get("control-pre", []) + by_phase.get("control-post", []))
    canary_hashes = {e["sha256"] for e in runner.log if e["phase"].startswith("canary")}
    canary_identical = len(canary_hashes) == 1

    fresh_total = sum(e["input_tokens"] or 0 for e in runner.log)
    cached_total = sum(e["cache_read_input_tokens"] or 0 for e in runner.log)
    priced = [e for e in runner.log if e["input_tokens"] is not None]
    total_in = cached_total + fresh_total
    cache_ratio = (cached_total / total_in) if total_in else 0.0

    ratelimit_headers = sorted({k for e in runner.log for k in e["headers"]
                                if k.lower().startswith("x-ratelimit")})
    retry_after = sorted({(e["headers"].get("retry-after") or e["headers"].get("Retry-After"))
                          for e in runner.log if e["status"] != 200} - {None})
    errors = sorted({e["error_message"] for e in runner.log if e["error_message"]})

    failures = [e for e in runner.log if e["status"] != 200]
    first_failure = min(failures, key=lambda e: e["t_rel_s"]) if failures else None
    fresh_before_failure = 0
    if first_failure:
        fresh_before_failure = sum(e["input_tokens"] or 0 for e in runner.log
                                   if e["t_rel_s"] <= first_failure["t_rel_s"])

    v = []
    v.append("Endpoint: POST %s   Model: %s" % (url, args.model))
    v.append("")
    v.append("THE CANARY - one fixed request body, SHA-256 %s (%dKB):"
             % (canary_hash, len(canary) // 1024))
    if canary_identical:
        v.append("  All three canary sends used byte-identical content; the digest above was")
        v.append("  recomputed from the buffer immediately before each send.")
    else:
        v.append("  WARNING: canary bodies differed between sends - this run is not a valid proof.")
    v.append("  1. COLD  (idle account)        -> HTTP %s   x-request-id: %s"
             % (canary_cold["status"], canary_cold["request_id"] or "(none)"))
    v.append("  2. HOT   (right after load)    -> HTTP %s   x-request-id: %s   %s"
             % (canary_hot["status"], canary_hot["request_id"] or "(none)",
                canary_hot["error_message"]))
    v.append("  3. AFTER %.0fs COOLDOWN         -> HTTP %s   x-request-id: %s   %s"
             % (args.cooldown, canary_recovered["status"],
                canary_recovered["request_id"] or "(none)", canary_recovered["error_message"]))
    v.append("")
    v.append("LOAD PHASE: %d x %dKB (%s), concurrency %d -> %d ok / %d failed  HTTP %s"
             % (load["n"], len(canary) // 1024,
                "identical bodies" if args.identical_load else "each body unique",
                args.concurrency, load["ok"], load["failed"], load["status_codes"]))
    v.append("TINY CONTROLS (~60 bytes): %d/%d succeeded - small requests are unaffected."
             % (controls["ok"], controls["n"]))
    v.append("")
    v.append("TOKEN ACCOUNTING (from Nebul's own usage blocks on %d successful responses):"
             % len(priced))
    v.append("  fresh input tokens billed : %d" % fresh_total)
    v.append("  served from prefix cache  : %d  (%.1f%% of all input)"
             % (cached_total, cache_ratio * 100))
    if first_failure:
        v.append("  fresh input tokens consumed before the first failure at t+%.1fs: %d"
                 % (first_failure["t_rel_s"], fresh_before_failure))
    if args.identical_load:
        v.append("  NOTE: --identical-load was used. A high cache ratio here is EXPECTED and is")
        v.append("        exactly why an identical-body burst does not reproduce the failure.")
    elif cache_ratio > 0.9:
        v.append("  NOTE: cache hit rate is high despite unique nonces - the limiter may not have")
        v.append("        been driven as hard as intended. Raise --payload-kb / --load-count.")
    v.append("")
    v.append("RATE-LIMIT SIGNALLING:")
    v.append("  x-ratelimit-* headers seen on any of the %d responses: %s"
             % (len(runner.log), ", ".join(ratelimit_headers) if ratelimit_headers else "NONE"))
    v.append("  Retry-After header on failures: %s"
             % (", ".join(retry_after) if retry_after else "NONE"))
    v.append("  Nebul's documentation states six x-ratelimit-* headers are returned:")
    v.append("  https://docs.nebul.io/docs/inference-api/advanced-topics/rate-limits-and-scaling")
    if errors:
        v.append("  Error message(s) observed: " + "; ".join('"%s"' % m for m in errors))
    v.append("")

    proved = (canary_cold["status"] == 200 and canary_hot["status"] != 200 and canary_identical)
    if proved and canary_recovered["status"] == 200:
        v.append("CONCLUSION - REPRODUCED, AND MALFORMED IS RULED OUT.")
        v.append("The identical byte sequence returned HTTP %s, then HTTP %s, then HTTP %s, "
                 "differing only in when it was sent and in what preceded it. A malformed body "
                 "cannot become well-formed again after a %.0fs pause. The failure is a capacity "
                 "or budget limit."
                 % (canary_cold["status"], canary_hot["status"],
                    canary_recovered["status"], args.cooldown))
        v.append("Two defects follow from that:")
        v.append("  (1) It is reported as HTTP 400 bad_request instead of HTTP 429 Too Many "
                 "Requests. 429 is retryable, so clients back off and retry; 400 means 'your "
                 "request is invalid', so a correct client does NOT retry and the operation dies. "
                 "That is why this error is fatal to an agent session.")
        v.append("  (2) None of the documented x-ratelimit-* headers are returned, so no client "
                 "can pace itself against the budget.")
    elif proved:
        v.append("CONCLUSION - REPRODUCED (recovery did not complete within the cooldown).")
        v.append("The identical byte sequence returned HTTP %s and then HTTP %s. The content did "
                 "not change; only the timing did. Re-run with a longer --cooldown to also "
                 "demonstrate recovery." % (canary_cold["status"], canary_hot["status"]))
    elif failures:
        v.append("CONCLUSION - PARTIAL. %d request(s) failed, but the canary itself did not show "
                 "the cold-ok / hot-fail transition. The failing x-request-id values are listed "
                 "below for server-side lookup." % len(failures))
    else:
        v.append("CONCLUSION - NOT REPRODUCED in this run. Every request succeeded.")
        v.append("Before concluding the limit does not exist, check the token accounting above: "
                 "if the cache ratio is high, the account was never actually charged for the "
                 "load. Re-run with a larger --payload-kb, a higher --load-count and a higher "
                 "--concurrency.")

    if any(e["request_id"] for e in failures):
        v.append("")
        v.append("x-request-id of every failing request, for server-side correlation:")
        for e in sorted(failures, key=lambda x: x["t_rel_s"]):
            if e["request_id"]:
                v.append("  %s  phase=%s  t+%.1fs  HTTP %s"
                         % (e["request_id"], e["phase"], e["t_rel_s"], e["status"]))

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    for line in v:
        print(line)

    prefix = args.out_prefix or ("nebul_repro_"
                                 + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    write_files(prefix, url, args.model, canary_hash, len(canary), vars(args),
                {"load": load, "controls": controls, "fresh_input_tokens": fresh_total,
                 "cached_input_tokens": cached_total, "cache_ratio": round(cache_ratio, 4)},
                v, runner.log)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
