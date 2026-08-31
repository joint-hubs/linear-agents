#!/usr/bin/env python3
"""Replay a captured body with Claude Code's REAL wire headers.

The earlier replays (nebul_ratelimit_repro.py) resent the rejected bytes and got
HTTP 200 ten times out of ten -- but they sent our own minimal header set. Claude
Code sends this instead:

    anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,
                    thinking-token-count-2026-05-13,context-management-2025-06-27,
                    prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,
                    advisor-tool-2026-03-01,effort-2025-11

Two of those betas correspond exactly to the odd parts of the rejected bodies:

  * context-management-2025-06-27  activates "context_management":
        {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}
    -- a SERVER-SIDE rewrite of the message history before inference.
  * mid-conversation-system-2026-04-07 permits role:"system" entries inside the
    `messages` array, which all four rejected bodies contain.

Without those headers a server is entitled to ignore both features, taking a
different code path -- which is very likely why the replays passed. This script
sends the identical bytes under different beta sets and reports which set flips
the response from 200 to 400.

Cost control: the experiment only needs the STATUS CODE, so the connection is
closed as soon as the response headers arrive. Nothing is generated, so only
input tokens are billed, and every request after the first is served from
nebul's prefix cache. A 12-variant matrix costs well under a dollar.

The API key is read from .env and is never printed or written to disk.
"""

import argparse
import hashlib
import http.client
import json
import os
import re
import ssl
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))

# Exactly what claude-cli/2.1.247 put on the wire, captured 2026-08-28 with
# nebul-capture-headers.mjs. Order preserved.
CLAUDE_BETAS = [
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "mid-conversation-system-2026-04-07",
    "advisor-tool-2026-03-01",
    "effort-2025-11",
]

# Non-credential headers Claude Code sends, minus the ones the transport owns
# (host, content-length, connection, accept-encoding).
CLAUDE_HEADERS = {
    "accept": "application/json",
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.247 (external, claude-desktop, agent-sdk/0.3.246)",
    "x-stainless-arch": "x64",
    "x-stainless-lang": "js",
    "x-stainless-os": "Windows",
    "x-stainless-package-version": "0.112.1",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-timeout": "900",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
}

SHED = "failed to extract prompt from request body"


def load_env(path):
    """Minimal .env reader. The value never leaves this process except as a header."""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*)", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def send(url, body, betas, key, extra_headers=None, read_body_limit=600,
         timeout=120, drop_headers=()):
    """POST `body`, read only the status line + headers, then hang up.

    Returns a dict. Closing early is what keeps this cheap: the server has not
    generated anything yet, so output tokens are ~0 even though the captured
    body asks for max_tokens=32000.
    """
    u = urlparse(url)
    conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    kw = {"timeout": timeout}
    if u.scheme == "https":
        kw["context"] = ssl.create_default_context()
    conn = conn_cls(u.hostname, u.port or (443 if u.scheme == "https" else 80), **kw)

    headers = dict(CLAUDE_HEADERS)
    for h in drop_headers:
        headers.pop(h, None)
    if betas:
        headers["anthropic-beta"] = ",".join(betas)
    if extra_headers:
        headers.update(extra_headers)
    headers["authorization"] = "Bearer " + key
    headers["content-length"] = str(len(body))

    path = u.path or "/"
    if u.query:
        path += "?" + u.query

    started = time.time()
    try:
        conn.putrequest("POST", path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("host", u.netloc)
        conn.putheader("accept-encoding", "gzip, deflate, br, zstd")
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders()
        conn.send(body)
        resp = conn.getresponse()
        elapsed = time.time() - started
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        # Only drain the body for errors; a 200 is a live SSE stream we abandon.
        payload = ""
        if resp.status != 200:
            payload = resp.read(read_body_limit).decode("utf-8", "replace")
        return {
            "status": resp.status,
            "elapsed": elapsed,
            "request_id": resp_headers.get("x-request-id"),
            "headers": resp_headers,
            "body": payload,
            "shed": SHED in payload,
        }
    except Exception as exc:  # noqa: BLE001 - any transport failure is a datapoint
        return {"status": None, "elapsed": time.time() - started,
                "error": "%s: %s" % (type(exc).__name__, exc),
                "request_id": None, "headers": {}, "body": "", "shed": False}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def strip_system_messages(raw):
    """Remove role:"system" entries from `messages` (the mid-conversation-system feature)."""
    doc = json.loads(raw.decode("utf-8"))
    doc["messages"] = [m for m in doc.get("messages", []) if m.get("role") != "system"]
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def strip_context_management(raw):
    doc = json.loads(raw.decode("utf-8"))
    doc.pop("context_management", None)
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def build_matrix(full):
    """Ordered so the two decisive rows come first and the bisect follows."""
    rows = [
        ("no-beta (old replay)", []),
        ("FULL claude code set", list(full)),
    ]
    for b in full:
        rows.append(("full minus %s" % b, [x for x in full if x != b]))
    rows.append(("only context-management", ["context-management-2025-06-27"]))
    rows.append(("only mid-conversation-system", ["mid-conversation-system-2026-04-07"]))
    rows.append(("context-mgmt + mid-conv-system",
                 ["context-management-2025-06-27", "mid-conversation-system-2026-04-07"]))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--key-var", default="NEBUL_API_KEY")
    ap.add_argument("--url", default="https://api.inference.nebul.io/v1/messages?beta=true")
    ap.add_argument("--body", default=os.path.join(HERE, "nebul-fail-30.bin"),
                    help="Captured raw request body to replay.")
    ap.add_argument("--repeat", type=int, default=1,
                    help="Send each variant this many times (the 400 may be intermittent).")
    ap.add_argument("--only", default=None,
                    help="Run just the variants whose label contains this substring.")
    ap.add_argument("--body-variants", action="store_true",
                    help="Also replay with system-messages / context_management stripped, "
                         "to separate a header cause from a body cause.")
    ap.add_argument("--input-usd-per-mtok", type=float, default=1.91)
    ap.add_argument("--cache-usd-per-mtok", type=float, default=0.76)
    ap.add_argument("--max-requests", type=int, default=40,
                    help="Hard stop. Each request bills the input once (mostly cached).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "nebul_wire_matrix.json"))
    args = ap.parse_args()

    raw = open(args.body, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    doc = json.loads(raw.decode("utf-8"))
    sysmsgs = sum(1 for m in doc.get("messages", []) if m.get("role") == "system")

    print("body     : %s" % args.body)
    print("           %d bytes  sha256=%s" % (len(raw), sha))
    print("           model=%s stream=%s max_tokens=%s" % (
        doc.get("model"), doc.get("stream"), doc.get("max_tokens")))
    print("           context_management=%s" % json.dumps(doc.get("context_management")))
    print("           output_config=%s thinking=%s" % (
        json.dumps(doc.get("output_config")), json.dumps(doc.get("thinking"))))
    print("           %d messages, of which %d have role=system" % (
        len(doc.get("messages", [])), sysmsgs))
    print("target   : %s" % args.url)

    variants = build_matrix(CLAUDE_BETAS)
    jobs = []
    for label, betas in variants:
        jobs.append({"label": label, "betas": betas, "body": raw, "body_note": "verbatim"})
    if args.body_variants:
        jobs.append({"label": "FULL beta, system-messages stripped",
                     "betas": list(CLAUDE_BETAS), "body": strip_system_messages(raw),
                     "body_note": "messages[] role=system removed"})
        jobs.append({"label": "FULL beta, context_management stripped",
                     "betas": list(CLAUDE_BETAS), "body": strip_context_management(raw),
                     "body_note": "context_management removed"})
    if args.only:
        jobs = [j for j in jobs if args.only.lower() in j["label"].lower()]

    jobs = [j for j in jobs for _ in range(args.repeat)]
    if len(jobs) > args.max_requests:
        print("\nREFUSING: %d requests exceeds --max-requests %d." % (len(jobs), args.max_requests))
        return 3

    approx_tok = len(raw) / 4.0
    est = (approx_tok * args.input_usd_per_mtok
           + approx_tok * args.cache_usd_per_mtok * (len(jobs) - 1)) / 1_000_000
    print("plan     : %d requests, ~%.0f input tokens each" % (len(jobs), approx_tok))
    print("cost est : ~$%.2f (first fresh, rest from prefix cache; output ~0 because"
          " the stream is closed at the header)" % est)

    if args.dry_run:
        print("\n--dry-run: nothing sent. Variants:")
        for j in jobs:
            print("  %-38s beta=%s" % (j["label"], ",".join(j["betas"]) or "(none)"))
        return 0

    env = load_env(args.env_file)
    key = env.get(args.key_var) or os.environ.get(args.key_var)
    if not key:
        print("\nNo %s in %s or the environment." % (args.key_var, args.env_file))
        return 2

    print("\n%-38s %-6s %-8s %s" % ("variant", "status", "time", "x-request-id / detail"))
    print("-" * 100)

    results = []
    shed_hits = []
    for j in jobs:
        r = send(args.url, j["body"], j["betas"], key)
        note = r.get("request_id") or r.get("error") or ""
        if r["shed"]:
            note = "SHED 400  " + (r.get("request_id") or "")
            shed_hits.append(j["label"])
        elif r["status"] not in (200, None):
            note = "%s  %s" % (r.get("request_id") or "", r["body"][:80].replace("\n", " "))
        print("%-38s %-6s %7.2fs  %s" % (
            j["label"][:38], r["status"], r["elapsed"], note))
        results.append({
            "label": j["label"], "betas": j["betas"], "body_note": j["body_note"],
            "body_sha256": hashlib.sha256(j["body"]).hexdigest(),
            "body_bytes": len(j["body"]),
            "at": datetime.now(timezone.utc).isoformat(),
            "status": r["status"], "elapsed_s": round(r["elapsed"], 3),
            "request_id": r.get("request_id"), "shed": r["shed"],
            "response_headers": r.get("headers"), "response_body": r.get("body"),
            "error": r.get("error"),
        })

    print("\n" + "=" * 100)
    print("VERDICT")
    print("=" * 100)
    ok = [r for r in results if r["status"] == 200]
    shed = [r for r in results if r["shed"]]
    other = [r for r in results if r["status"] not in (200, None) and not r["shed"]]
    print("%d requests: %d x 200, %d x 400 '%s', %d other."
          % (len(results), len(ok), len(shed), SHED, len(other)))
    if shed:
        print("\nREPRODUCED. The shed 400 appeared for these header sets:")
        for label in sorted(set(shed_hits)):
            print("  - %s" % label)
        print("\nThe body bytes are identical across every row above, so the request")
        print("content cannot be the cause: the response depends on anthropic-beta.")
    else:
        print("\nNOT reproduced with these header sets on this body.")
        print("Next: --repeat 3 (it is intermittent), a different capture via --body,")
        print("or --body-variants to test the body side.")

    seen = sorted({k for r in results for k in (r["response_headers"] or {})
                   if k.startswith("x-ratelimit")})
    print("\nx-ratelimit-* headers seen: %s" % (", ".join(seen) if seen else "NONE"))

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"body_file": args.body, "body_sha256": sha, "url": args.url,
                   "claude_betas": CLAUDE_BETAS, "results": results}, fh, indent=1)
    print("\nEvidence written: %s  (the API key appears nowhere in it)" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
