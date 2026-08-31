#!/usr/bin/env python3
"""Reproduce nebul's HTTP 400 by varying HOW the body is sent, not what is in it.

Ruled out so far, each with evidence:

  * the body content    - the rejected bytes replay to 200 (10/10, sha256 verified)
  * the beta headers    - the same bytes under 13 different anthropic-beta sets,
                          including Claude Code's exact one, returned 200 13/13
  * a token rate limit  - 5.45M fresh input tokens at concurrency 32, zero failures
  * the project budget  - that returns a correct 429 with X-Usage-Limit

What has never been tested is the transport. Two measurements point straight at it:

  1. The rejection arrives in 173-196 ms. A trivial 5-token request to the same
     endpoint takes 510-560 ms. The refusal is therefore FASTER than a normal
     round trip, so it comes from an edge component in front of the model, not
     from anything that read a 196 KB body.
  2. Every replay is answered in ~1.0 s versus 2.9 s for the first - the prefix
     cache is serving them. A replay exercises the cache-hit path; the original
     failures happened on live traffic that was frequently a cache miss.

So this script sends the captured body the way a real client does: over a slow
upload, in chunked encoding, on a reused connection, concurrently, and with a
cache-defeating nonce - and reports which transport flips 200 to 400.

Only the status line is read, so nothing is generated and only input is billed.
The API key is read from .env and never printed or written to disk.
"""

import argparse
import hashlib
import json
import os
import random
import re
import socket
import ssl
import string
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SHED = "failed to extract prompt from request body"

CLAUDE_BETAS = (
    "claude-code-20250219,interleaved-thinking-2025-05-14,"
    "thinking-token-count-2026-05-13,context-management-2025-06-27,"
    "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,"
    "advisor-tool-2026-03-01,effort-2025-11"
)

BASE_HEADERS = [
    ("accept", "application/json"),
    ("content-type", "application/json"),
    ("user-agent", "claude-cli/2.1.247 (external, claude-desktop, agent-sdk/0.3.246)"),
    ("x-stainless-arch", "x64"),
    ("x-stainless-lang", "js"),
    ("x-stainless-os", "Windows"),
    ("x-stainless-package-version", "0.112.1"),
    ("x-stainless-retry-count", "0"),
    ("x-stainless-runtime", "node"),
    ("x-stainless-runtime-version", "v26.3.0"),
    ("x-stainless-timeout", "900"),
    ("anthropic-beta", CLAUDE_BETAS),
    ("anthropic-dangerous-direct-browser-access", "true"),
    ("anthropic-version", "2023-06-01"),
    ("x-app", "cli"),
]


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*)", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def make_unique(raw):
    """Defeat the prefix cache while preserving the exact request shape.

    The nonce goes into the FIRST message: caches match from the start of the
    conversation, so a nonce anywhere later leaves the prefix hit intact and the
    request measures nothing.
    """
    doc = json.loads(raw.decode("utf-8"))
    nonce = "".join(random.choices(string.ascii_letters + string.digits, k=24))
    msgs = doc.get("messages") or []
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str):
            m["content"] = "[run %s] %s" % (nonce, c)
            break
        if isinstance(c, list):
            for b in c:
                if b.get("type") == "text":
                    b["text"] = "[run %s] %s" % (nonce, b.get("text", ""))
                    break
            break
    return json.dumps(doc, separators=(",", ":")).encode("utf-8"), nonce


def connect(url, timeout):
    u = urlparse(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    sock = socket.create_connection((u.hostname, port), timeout=timeout)
    if u.scheme == "https":
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(sock, server_hostname=u.hostname)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    return sock, u.netloc, path


def build_head(netloc, path, body_len, key, chunked=False, expect_100=False):
    lines = ["POST %s HTTP/1.1" % path, "host: %s" % netloc]
    for k, v in BASE_HEADERS:
        lines.append("%s: %s" % (k, v))
    lines.append("authorization: Bearer " + key)
    if chunked:
        lines.append("transfer-encoding: chunked")
    else:
        lines.append("content-length: %d" % body_len)
    if expect_100:
        lines.append("expect: 100-continue")
    lines.append("connection: keep-alive")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


def read_status(sock, limit=2048):
    """Read just enough for the status line and the error body, if any."""
    sock.settimeout(180)
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < 65536:
        try:
            c = sock.recv(4096)
        except socket.timeout:
            return None, {}, "<timeout waiting for response>"
        if not c:
            break
        buf += c
    if not buf:
        return None, {}, "<connection closed with no response>"
    head, _, rest = buf.partition(b"\r\n\r\n")
    text = head.decode("latin-1")
    first = text.split("\r\n")[0]
    try:
        status = int(first.split()[1])
    except (IndexError, ValueError):
        return None, {}, first
    headers = {}
    for line in text.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    payload = rest
    if status != 200:
        while len(payload) < limit:
            try:
                c = sock.recv(4096)
            except (socket.timeout, OSError):
                break
            if not c:
                break
            payload += c
    return status, headers, payload[:limit].decode("utf-8", "replace")


def send_once(url, body, key, transport="normal", chunk_kb=8, delay_ms=0,
              sock=None, netloc=None, path=None, timeout=180):
    """One request. Returns a result dict; never raises for network problems."""
    own = sock is None
    started = time.time()
    try:
        if own:
            sock, netloc, path = connect(url, timeout)
        chunked = transport == "chunked"
        head = build_head(netloc, path, len(body), key,
                          chunked=chunked, expect_100=(transport == "expect100"))
        sock.sendall(head)

        if transport == "expect100":
            sock.settimeout(10)
            try:
                sock.recv(256)  # the 100 Continue (or an early refusal)
            except (socket.timeout, OSError):
                pass

        if chunked:
            step = chunk_kb * 1024
            for i in range(0, len(body), step):
                part = body[i:i + step]
                sock.sendall(b"%x\r\n%s\r\n" % (len(part), part))
                if delay_ms:
                    time.sleep(delay_ms / 1000.0)
            sock.sendall(b"0\r\n\r\n")
        elif transport == "slow":
            step = chunk_kb * 1024
            for i in range(0, len(body), step):
                sock.sendall(body[i:i + step])
                if delay_ms:
                    time.sleep(delay_ms / 1000.0)
        else:
            sock.sendall(body)

        status, headers, payload = read_status(sock)
        return {
            "status": status, "elapsed": time.time() - started,
            "request_id": headers.get("x-request-id"),
            "headers": headers, "body": payload,
            "shed": SHED in (payload or ""),
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": None, "elapsed": time.time() - started,
                "error": "%s: %s" % (type(exc).__name__, exc),
                "request_id": None, "headers": {}, "body": "", "shed": False}
    finally:
        if own and sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def run_burst(url, bodies, key, n, results, lock, label):
    threads = []

    def worker(b, idx):
        r = send_once(url, b, key)
        r["label"] = "%s #%d" % (label, idx)
        with lock:
            results.append(r)
            mark = "SHED 400" if r["shed"] else (r["status"] or r.get("error", "?"))
            print("  %-36s %-9s %6.2fs  %s" % (
                r["label"][:36], mark, r["elapsed"], r.get("request_id") or ""))

    for i in range(n):
        t = threading.Thread(target=worker, args=(bodies[i % len(bodies)], i + 1))
        threads.append(t)
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--key-var", default="NEBUL_API_KEY")
    ap.add_argument("--url", default="https://api.inference.nebul.io/v1/messages?beta=true")
    ap.add_argument("--body", default=os.path.join(HERE, "nebul-fail-30.bin"))
    ap.add_argument("--phases", default="cachemiss,slow,chunked,keepalive,burst",
                    help="Comma-separated subset to run.")
    ap.add_argument("--burst", type=int, default=8, help="Concurrency for the burst phase.")
    ap.add_argument("--slow-chunk-kb", type=int, default=8)
    ap.add_argument("--slow-delay-ms", type=int, default=120,
                    help="Gap between chunks. 8KB every 120ms is ~66KB/s, a realistic "
                         "bad uplink for a 200KB body (~3s upload).")
    ap.add_argument("--repeat", type=int, default=2)
    ap.add_argument("--input-usd-per-mtok", type=float, default=1.91)
    ap.add_argument("--cache-usd-per-mtok", type=float, default=0.76)
    ap.add_argument("--budget-usd", type=float, default=3.0)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "nebul_transport_matrix.json"))
    args = ap.parse_args()

    raw = open(args.body, "rb").read()
    doc = json.loads(raw.decode("utf-8"))
    phases = [p.strip() for p in args.phases.split(",") if p.strip()]
    approx_tok = len(raw) / 4.0

    fresh = args.repeat * (1 if "cachemiss" in phases else 0) + (
        args.burst if "burst" in phases else 0)
    cached = args.repeat * sum(1 for p in phases if p in ("slow", "chunked")) + (
        args.repeat if "keepalive" in phases else 0)
    est = (fresh * approx_tok * args.input_usd_per_mtok
           + cached * approx_tok * args.cache_usd_per_mtok) / 1_000_000

    print("body     : %s  (%d bytes)" % (os.path.basename(args.body), len(raw)))
    print("           model=%s stream=%s max_tokens=%s  %d messages"
          % (doc.get("model"), doc.get("stream"), doc.get("max_tokens"),
             len(doc.get("messages", []))))
    print("phases   : %s" % ", ".join(phases))
    print("plan     : %d cache-miss requests (fresh), %d cache-hit requests"
          % (fresh, cached))
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
    lock = threading.Lock()

    def record(r, label):
        r["label"] = label
        results.append(r)
        mark = "SHED 400" if r["shed"] else (r["status"] or r.get("error", "?"))
        detail = r.get("request_id") or ""
        if r["status"] not in (200, None) and not r["shed"]:
            detail += "  " + r["body"][:70].replace("\n", " ")
        print("  %-36s %-9s %6.2fs  %s" % (label[:36], mark, r["elapsed"], detail))

    if "cachemiss" in phases:
        print("\n=== cache miss: unique body, full Claude Code headers ===")
        for i in range(args.repeat):
            body, nonce = make_unique(raw)
            record(send_once(args.url, body, key), "cachemiss #%d (%s)" % (i + 1, nonce[:8]))

    if "slow" in phases:
        print("\n=== slow upload: %dKB every %dms (~%.0f KB/s) ==="
              % (args.slow_chunk_kb, args.slow_delay_ms,
                 args.slow_chunk_kb * 1000.0 / max(args.slow_delay_ms, 1)))
        for i in range(args.repeat):
            record(send_once(args.url, raw, key, transport="slow",
                             chunk_kb=args.slow_chunk_kb, delay_ms=args.slow_delay_ms),
                   "slow #%d" % (i + 1))

    if "chunked" in phases:
        print("\n=== transfer-encoding: chunked ===")
        for i in range(args.repeat):
            record(send_once(args.url, raw, key, transport="chunked",
                             chunk_kb=args.slow_chunk_kb, delay_ms=0),
                   "chunked #%d" % (i + 1))

    if "keepalive" in phases:
        print("\n=== connection reuse: %d requests down one socket ===" % args.repeat)
        sock = netloc = path = None
        try:
            sock, netloc, path = connect(args.url, 180)
            for i in range(args.repeat):
                record(send_once(args.url, raw, key, sock=sock, netloc=netloc, path=path),
                       "keepalive #%d" % (i + 1))
        except Exception as exc:  # noqa: BLE001
            print("  keepalive setup failed: %s" % exc)
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

    if "burst" in phases:
        print("\n=== burst: %d concurrent unique bodies ===" % args.burst)
        bodies = [make_unique(raw)[0] for _ in range(args.burst)]
        run_burst(args.url, bodies, key, args.burst, results, lock, "burst")

    print("\n" + "=" * 96)
    print("VERDICT")
    print("=" * 96)
    shed = [r for r in results if r.get("shed")]
    ok = [r for r in results if r.get("status") == 200]
    err = [r for r in results if r.get("status") is None]
    other = [r for r in results if r.get("status") not in (200, None) and not r.get("shed")]
    print("%d requests: %d x 200, %d x 400 '%s', %d other, %d transport errors."
          % (len(results), len(ok), len(shed), SHED, len(other), len(err)))
    if shed:
        print("\nREPRODUCED. Transports that produced the shed 400:")
        for label in sorted({r["label"].rsplit(" #", 1)[0] for r in shed}):
            print("  - %s" % label)
        print("\nRequest ids to hand to nebul:")
        for r in shed:
            print("  %s  %s" % (r.get("request_id"), r["label"]))
    else:
        print("\nNOT reproduced. Every transport variant was accepted.")

    seen = sorted({k for r in results for k in (r.get("headers") or {})
                   if k.startswith("x-ratelimit")})
    print("\nx-ratelimit-* headers seen: %s" % (", ".join(seen) if seen else "NONE"))

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"body_file": args.body,
                   "body_sha256": hashlib.sha256(raw).hexdigest(),
                   "url": args.url, "phases": phases,
                   "at": datetime.now(timezone.utc).isoformat(),
                   "results": results}, fh, indent=1)
    print("\nEvidence written: %s  (the API key appears nowhere in it)" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
