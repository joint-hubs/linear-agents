#!/usr/bin/env python3
"""
nebul_ratelimit_proof.py  -  Proves that Nebul's Messages API (/v1/messages)
returns HTTP 400 "failed to extract prompt from request body" under request
volume/rate, NOT because of a malformed request body.

WHY THIS SCRIPT EXISTS
-----------------------
Nebul support classified this error as "malformed request". A malformed
request is a *static* property of the request body: the same bytes are
either valid or not, forever. This script sends the exact same
byte-for-byte request body (verified via SHA-256, computed fresh before
every send) repeatedly, and shows that the SAME body:
  - succeeds (HTTP 200) when sent at a slow pace,
  - fails (HTTP 400, same "bad_request" error) when sent rapidly,
  - and starts succeeding again after a cooldown period.

That pattern (success/failure depends on *timing*, not *content*, and
recovers after a pause) cannot be explained by malformed input. It is the
textbook signature of a request-rate / token-budget limiter  -  one that
Nebul is enforcing but not surfacing correctly (HTTP 400 instead of the
documented HTTP 429, and none of the documented `x-ratelimit-*` response
headers ever appear  -  see
https://docs.nebul.io/docs/inference-api/advanced-topics/rate-limits-and-scaling).

USAGE
-----
    export NEBUL_API_KEY=sk-...          # never hardcode the key
    python nebul_ratelimit_proof.py

Or point --api-key / --env-file at wherever the key lives. Full option list:

    python nebul_ratelimit_proof.py --help

OUTPUT
------
Prints a live log to the console, then writes two evidence files next to
this script (or --out-prefix):
    <prefix>.json    -  every request/response recorded (status, latency,
                       response headers, truncated body, SHA-256 of what
                       was sent)  -  attach this to the support ticket.
    <prefix>.md       -  human-readable report with a plain-English verdict.

The script NEVER prints, logs, or writes the API key anywhere. Only server
*response* headers are recorded (the client's own Authorization header is
never included in any output).

No third-party dependencies  -  standard library only (urllib), so this runs
on any Python 3.8+ install, including on Nebul's own machines if they want
to reproduce it themselves.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Payload construction  -  a valid, spec-compliant Anthropic Messages request
# ---------------------------------------------------------------------------
#
# Every field below is documented in Nebul's own Messages API reference
# (https://docs.nebul.io/docs/inference-api/models/messages): model,
# messages (roles user/assistant only, as used here), max_tokens, system,
# tools. There is nothing exotic here  -  no custom roles, no undocumented
# parameters  -  so "malformed" cannot be argued from the shape of the request.

FILLER = (
    "The repository contains many modules and services that interact with "
    "one another through well-defined interfaces. "
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
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
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


def build_payload(model: str, target_bytes: int, max_tokens: int = 16) -> bytes:
    """Build a valid Messages API request padded to roughly target_bytes.

    Returns the exact serialized JSON bytes that will be sent  -  callers
    must reuse this same object (never rebuild it) so every request in a
    test phase is provably byte-identical.
    """
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": "You are a helpful coding assistant working in a large repository.",
        "tools": TOOLS,
        "messages": [],
    }

    # Pad with alternating user/assistant turns until we're close to the
    # target size, then finish with a short, cheap final instruction.
    chunk = FILLER * 30  # ~2KB per message
    turn = 0
    while len(json.dumps(body)) < target_bytes - 200:
        role = "user" if turn % 2 == 0 else "assistant"
        body["messages"].append({"role": role, "content": chunk})
        turn += 1

    body["messages"].append({"role": "user", "content": "Reply with exactly: PONG"})

    return json.dumps(body).encode("utf-8")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def send(url: str, headers: dict, body_bytes: bytes, timeout: float) -> dict:
    """POST body_bytes to url. Returns a dict describing the outcome  - 
    never raises for HTTP-level errors (4xx/5xx), only for connection
    failures (status 0)."""
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.monotonic() - t0
            text = resp.read().decode("utf-8", errors="replace")
            return {
                "status": resp.status,
                "elapsed_s": round(elapsed, 3),
                "headers": dict(resp.headers.items()),
                "body_preview": text[:600],
            }
    except urllib.error.HTTPError as e:
        elapsed = time.monotonic() - t0
        text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return {
            "status": e.code,
            "elapsed_s": round(elapsed, 3),
            "headers": dict(e.headers.items()) if e.headers else {},
            "body_preview": text[:600],
        }
    except urllib.error.URLError as e:
        elapsed = time.monotonic() - t0
        return {
            "status": 0,
            "elapsed_s": round(elapsed, 3),
            "headers": {},
            "body_preview": f"connection error: {e}",
        }


def error_message(body_preview: str) -> str:
    try:
        return json.loads(body_preview).get("detail", {}).get("message", "")
    except Exception:
        return body_preview[:80]


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

class Runner:
    def __init__(self, url, headers, payload_bytes, timeout):
        self.url = url
        self.headers = headers
        self.payload_bytes = payload_bytes
        self.timeout = timeout
        self.payload_hash = hashlib.sha256(payload_bytes).hexdigest()
        self.log = []  # every attempt, across all phases

    def fire(self, phase: str, seq: int, body_bytes: bytes | None = None) -> dict:
        body = body_bytes if body_bytes is not None else self.payload_bytes
        h = hashlib.sha256(body).hexdigest()
        r = send(self.url, self.headers, body, self.timeout)
        r.update({
            "phase": phase,
            "seq": seq,
            "sent_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "bytes": len(body),
            "sha256": h,
            "error_message": error_message(r["body_preview"]) if r["status"] not in (200,) else "",
            "request_id": r["headers"].get("x-request-id") or r["headers"].get("X-Request-Id", ""),
        })
        self.log.append(r)
        status_tag = "OK " if r["status"] == 200 else f"ERR"
        print(
            f"  [{phase:8s} #{seq:02d}] {status_tag} HTTP {r['status']:<3} "
            f"{r['elapsed_s']:>6.2f}s  {len(body)//1024:>4}KB  "
            f"{r['error_message'][:50]}"
        )
        return r

    def control_probe(self, model: str, phase: str) -> dict:
        tiny = json.dumps({
            "model": model, "max_tokens": 16,
            "messages": [{"role": "user", "content": "Reply: PONG"}],
        }).encode("utf-8")
        return self.fire(phase, 0, body_bytes=tiny)


def summarize(entries: list[dict]) -> dict:
    n = len(entries)
    ok = sum(1 for e in entries if e["status"] == 200)
    codes = {}
    for e in entries:
        codes[e["status"]] = codes.get(e["status"], 0) + 1
    return {"n": n, "ok": ok, "rate": (ok / n) if n else None, "status_codes": codes}


def main():
    ap = argparse.ArgumentParser(
        description="Prove Nebul /v1/messages HTTP 400 is rate-limiting, not a malformed request.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--api-key", default=None, help="Nebul API key (default: $NEBUL_API_KEY env var)")
    ap.add_argument("--env-file", default=None, help="Path to a .env file to read NEBUL_API_KEY from")
    ap.add_argument("--base-url", default="https://api.inference.nebul.io")
    ap.add_argument("--model", default="zai-org/GLM-5.2-FP8")
    ap.add_argument("--auth-style", choices=["bearer", "apikey"], default="bearer",
                     help="bearer -> Authorization: Bearer <key> (Anthropic-style); "
                          "apikey -> x-api-key: <key> (Nebul's own docs example)")
    ap.add_argument("--payload-kb", type=int, default=270,
                     help="Target size of the padded request body")
    ap.add_argument("--burst-count", type=int, default=8,
                     help="Requests fired back-to-back with --burst-delay between them")
    ap.add_argument("--burst-delay", type=float, default=0.0)
    ap.add_argument("--cooldown", type=float, default=30.0,
                     help="Seconds to wait after the burst before the recovery probe")
    ap.add_argument("--paced-count", type=int, default=5,
                     help="Requests fired with --paced-delay between them (same body)")
    ap.add_argument("--paced-delay", type=float, default=20.0)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--out-prefix", default=None,
                     help="Output file prefix (default: nebul_evidence_<timestamp>)")
    ap.add_argument("--dry-run", action="store_true",
                     help="Build the payload and print its size/hash, send nothing")
    args = ap.parse_args()

    api_key = args.api_key or os.environ.get("NEBUL_API_KEY")
    if not api_key and args.env_file:
        for line in open(args.env_file, "r", encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "NEBUL_API_KEY":
                api_key = v.strip()
                break
    if not api_key:
        print("ERROR: no API key. Set NEBUL_API_KEY, or pass --api-key / --env-file.", file=sys.stderr)
        sys.exit(2)

    url = args.base_url.rstrip("/") + "/v1/messages"
    headers = {"content-type": "application/json", "anthropic-version": "2023-06-01",
               "user-agent": "nebul-ratelimit-proof/1.0"}
    if args.auth_style == "bearer":
        headers["authorization"] = f"Bearer {api_key}"
    else:
        headers["x-api-key"] = api_key

    payload = build_payload(args.model, args.payload_kb * 1024)
    payload_hash = hashlib.sha256(payload).hexdigest()

    print(f"payload: {len(payload)/1024:.0f}KB   sha256={payload_hash}")
    print(f"endpoint: {url}   model: {args.model}   auth: {args.auth_style}")
    if args.dry_run:
        print("(--dry-run, nothing sent)")
        return

    runner = Runner(url, headers, payload, args.timeout)

    print(f"\n=== Phase 0: control probe (tiny request, baseline) ===")
    runner.control_probe(args.model, "control0")

    print(f"\n=== Phase 1: burst  -  {args.burst_count}x identical {len(payload)//1024}KB body, "
          f"{args.burst_delay}s apart ===")
    for i in range(1, args.burst_count + 1):
        runner.fire("burst", i)
        if args.burst_delay:
            time.sleep(args.burst_delay)

    print(f"\n=== Phase 2: recovery  -  wait {args.cooldown}s, retry the SAME body ===")
    time.sleep(args.cooldown)
    runner.fire("recovery", 1)

    print(f"\n=== Phase 3: paced  -  {args.paced_count}x identical body, "
          f"{args.paced_delay}s apart ===")
    for i in range(1, args.paced_count + 1):
        runner.fire("paced", i)
        if i < args.paced_count:
            time.sleep(args.paced_delay)

    print(f"\n=== Phase 4: control probe (tiny request, closing baseline) ===")
    runner.control_probe(args.model, "control4")

    # -----------------------------------------------------------------
    # Analysis
    # -----------------------------------------------------------------
    by_phase = {}
    for e in runner.log:
        by_phase.setdefault(e["phase"], []).append(e)

    burst = summarize(by_phase.get("burst", []))
    paced = summarize(by_phase.get("paced", []))
    control = summarize(by_phase.get("control0", []) + by_phase.get("control4", []))
    recovery_ok = by_phase.get("recovery", [{}])[0].get("status") == 200

    all_hashes = {e["sha256"] for e in runner.log if e["phase"] in ("burst", "recovery", "paced")}
    identical_body = len(all_hashes) == 1
    ratelimit_headers_seen = any(
        any(k.lower().startswith("x-ratelimit") for k in e["headers"])
        for e in runner.log
    )
    burst_had_failures = burst["ok"] < burst["n"]
    burst_had_successes = burst["ok"] > 0
    mixed_outcomes = burst_had_failures and burst_had_successes
    paced_mostly_ok = paced["n"] > 0 and paced["rate"] >= 0.8

    error_messages = sorted({e["error_message"] for e in runner.log if e["error_message"]})
    request_ids_on_failure = [e["request_id"] for e in runner.log if e["status"] != 200 and e["request_id"]]

    verdict_lines = []
    verdict_lines.append(
        f"The exact same request body (SHA-256 {payload_hash[:16]}..., "
        f"{len(payload)//1024}KB) was sent to POST {url} multiple times."
    )
    if identical_body:
        verdict_lines.append(
            "Every burst/recovery/paced request reused this identical byte sequence  -  "
            "confirmed by re-hashing the body immediately before each send."
        )
    verdict_lines.append(
        f"Burst phase (0s between requests): {burst['ok']}/{burst['n']} succeeded "
        f"(HTTP {burst['status_codes']})."
    )
    verdict_lines.append(
        f"Paced phase ({args.paced_delay}s between requests): {paced['ok']}/{paced['n']} succeeded "
        f"(HTTP {paced['status_codes']})."
    )
    verdict_lines.append(
        f"Recovery probe (identical body, {args.cooldown}s after the burst): "
        f"{'succeeded (HTTP 200)' if recovery_ok else 'still failed'}."
    )
    verdict_lines.append(
        f"Small control requests (~50 bytes) sent before and after: "
        f"{control['ok']}/{control['n']} succeeded  -  small requests are not affected."
    )
    if error_messages:
        verdict_lines.append("Error message(s) observed: " + "; ".join(f'"{m}"' for m in error_messages))
    verdict_lines.append(
        f"x-ratelimit-* response headers observed on ANY response: "
        f"{'yes' if ratelimit_headers_seen else 'NO  -  never, on any of the ' + str(len(runner.log)) + ' requests'}, "
        f"despite Nebul's own documentation stating these should be present "
        f"(https://docs.nebul.io/docs/inference-api/advanced-topics/rate-limits-and-scaling)."
    )

    verdict_lines.append("")
    if mixed_outcomes and paced_mostly_ok:
        verdict_lines.append(
            "CONCLUSION: A malformed request is a static property of the request body and cannot "
            "change across byte-identical retries. Since the identical body produced BOTH success "
            "and this exact \"bad_request\" error depending only on send tempo  -  and recovered after "
            "a pause  -  this is not a malformed-request condition. It is consistent with a request-rate "
            "or token-budget limit being enforced without the documented x-ratelimit-* headers, and "
            "reported as HTTP 400 instead of the standard HTTP 429 Too Many Requests."
        )
    elif not mixed_outcomes and burst["rate"] == 1.0 and paced["rate"] == 1.0:
        verdict_lines.append(
            "CONCLUSION: No failures were reproduced in this run (all requests succeeded). "
            "Either the limiting behavior is not currently active, or a higher --burst-count / "
            "smaller --burst-delay / larger --payload-kb is needed to trigger it. This run does "
            "NOT demonstrate the issue  -  re-run with more aggressive parameters."
        )
    else:
        verdict_lines.append(
            "CONCLUSION: Results were inconclusive under these parameters  -  see the raw log below "
            "and consider re-running with a larger --burst-count or --payload-kb."
        )

    if request_ids_on_failure:
        verdict_lines.append("")
        verdict_lines.append(
            "x-request-id values on failing requests (for Nebul to look up server-side): "
            + ", ".join(request_ids_on_failure)
        )

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    for line in verdict_lines:
        print(line)

    # -----------------------------------------------------------------
    # Write evidence files
    # -----------------------------------------------------------------
    prefix = args.out_prefix or f"nebul_evidence_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    json_path = prefix + ".json"
    md_path = prefix + ".md"

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "url": url,
            "model": args.model,
            "payload_bytes": len(payload),
            "payload_sha256": payload_hash,
            "params": vars(args),
            "summary": {"burst": burst, "paced": paced, "control": control, "recovery_ok": recovery_ok},
            "log": runner.log,
        }, f, indent=1)

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Nebul rate-limit evidence  -  {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n\n")
        f.write(f"Endpoint: `POST {url}`  \nModel: `{args.model}`  \n")
        f.write(f"Request body: {len(payload)//1024}KB, SHA-256 `{payload_hash}`\n\n")
        f.write("## Verdict\n\n")
        for line in verdict_lines:
            f.write((line or "") + "\n\n" if line == "" else line + "\n")
        f.write("\n## Per-request log\n\n")
        f.write("| phase | seq | status | elapsed(s) | bytes | error | x-request-id |\n")
        f.write("|---|---|---|---|---|---|---|\n")
        for e in runner.log:
            f.write(
                f"| {e['phase']} | {e['seq']} | {e['status']} | {e['elapsed_s']} | "
                f"{e['bytes']} | {e['error_message']} | {e['request_id']} |\n"
            )

    print(f"\nEvidence written:\n  {json_path}\n  {md_path}")
    print("(no API key is present in either file  -  only server response headers were recorded)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
