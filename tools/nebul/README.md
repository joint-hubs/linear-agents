# Nebul diagnostics

Tooling for the open Nebul support ticket: `POST /v1/messages` intermittently
returns **HTTP 400 `failed to extract prompt from request body`** for a request
body that is valid.

Run everything from the repo root. The Python tools are standard library only
(Python 3.8+) — no `pip install`, so Nebul can run them unmodified too. None of
them ever prints or writes the API key; only server *response* headers and
redacted request-header names are recorded.

## What is established

- **The rejected bytes are valid.** Four bodies captured on the wire at the
  moment of rejection were replayed byte-for-byte, SHA-256 re-verified before
  each send, and accepted **10 times out of 10**.
- **The headers are not the trigger.** Those replays originally used our own
  minimal header set, which was a real gap: claude-cli sends eight
  `anthropic-beta` flags, two of which (`context-management-2025-06-27`,
  `mid-conversation-system-2026-04-07`) activate the exact features these bodies
  use. Resending one capture 13 times under the full captured header set, with
  each beta ablated in turn, returned **200 thirteen times out of thirteen**.
- **The transport is not the trigger.** Slow upload (67 KB/s), chunked
  transfer-encoding, connection reuse, 8-way concurrency and cache-miss bodies
  were all accepted.
- **`max_tokens` is not validated.** Sweeping it from 32 000 to 400 000 on an
  unchanged message list returned 200 every time.
- **It is not a token-rate limit.** 1 744 815 fresh input tokens in about a
  minute at concurrency 8, and later 5 454 656 at concurrency 32, with zero
  failures. Nebul support also states it is not a rate limit on their side.
- **The refusal is faster than a model-registry lookup.** A request for a
  nonexistent model is refused in 495 ms and a 5-token completion takes
  510–560 ms, while the four shed 400s came back in 173–196 ms. Whatever
  produces them sits in front of both the inference service and the registry.
- **No `x-ratelimit-*` header is ever returned**, on any response, despite six
  being documented. The full set observed is `connection`, `content-length`,
  `content-type`, `date`, `strict-transport-security`, `x-request-id`.

Not established, and worth saying plainly: **the failure has never been
reproduced on demand.** 440 requests across every variable we control were sent
on 2026-08-28 without triggering it. The eight real occurrences cluster in bursts
minutes apart, and four of them predate any proxy on this machine by two days.

`NEBUL_SUPPORT_REPORT.md` is the write-up for the vendor; `NEBUL_400_LOG.txt` is
the timestamped log to send them.

## Two traps that invalidate naive tests

**Identical bodies measure nothing.** Nebul's prefix cache serves them almost
entirely from cache — measured `"usage": {"input_tokens": 74,
"cache_read_input_tokens": 41216}` on a 270 KB body. 100 consecutive identical
270 KB requests all returned 200 while costing 74 fresh tokens each. A flat
~0.57 s latency on a large body is the tell. Every tool here makes load requests
unique via a nonce in the *first* message (caches match from the start of the
conversation) and reports the cache hit ratio.

**Cache reads are still billed** — 0.76 vs 1.91 USD/M on nebul. A "cheap" probe
loop left running is not cheap: 48 000 cached tokens every 6 s is roughly
22 USD/hour. Everything here that loops takes a spend cap.

## Tools

### `nebul-proxy.mjs` — capture failures from real traffic

Forwards to Nebul unmodified and stores the **raw bytes** of anything non-200,
plus the redacted request headers, their wire order, and the upstream latency.
Also retries the load-shedding 400 transparently (400 ms → 1.2 s → 3 s), which
keeps an agent turn alive; genuine 400s such as `model not found` pass straight
through untouched.

```bash
node tools/nebul/nebul-proxy.mjs        # listens on 127.0.0.1:8899
```

Point `providers.nebul.baseUrl` in `config/models.json` at
`http://127.0.0.1:8899` while capturing. Use `127.0.0.1`, **not** `localhost` —
on Windows `localhost` tries `::1` first and adds ~2 s per request (measured
2.55 s vs 0.47 s). Set `NEBUL_PROXY_NO_RETRY=1` to observe the raw behaviour.

Failures land in `nebul-fail-<n>.bin` (raw body) plus `nebul-fail-<n>.json` next
to the script. The counter continues past existing `.bin` and `.json` files, so a
restart never overwrites evidence.

### `nebul-capture-headers.mjs` — see what Claude Code actually sends

Answers every request locally with a valid empty SSE stream and records the
request headers. **Forwards nothing and costs nothing.** This is how the
`anthropic-beta` set above was obtained.

```bash
node tools/nebul/nebul-capture-headers.mjs     # 127.0.0.1:8901
ANTHROPIC_BASE_URL=http://127.0.0.1:8901 ANTHROPIC_AUTH_TOKEN=dummy claude -p "hi"
```

### `nebul_wire_repro.py` — same bytes, different headers

Replays a capture under an `anthropic-beta` ablation matrix. Reads only the
status line, so nothing is generated and only input is billed.

```bash
python tools/nebul/nebul_wire_repro.py --env-file .env --dry-run
```

### `nebul_transport_repro.py` — same bytes, different wire behaviour

Cache-miss, slow upload, chunked encoding, connection reuse and concurrent burst.

```bash
python tools/nebul/nebul_transport_repro.py --env-file .env --phases slow,chunked
```

### `nebul_limits_probe.py` — find a size or parameter boundary

Sweeps `max_tokens` (cache hits, cheap) and optionally grows the conversation
itself (`--grow 2,3,4`, billed as fresh tokens).

### `nebul_replica_hunt.py` — sample the backend pool cheaply

Many small unique requests instead of a few large ones, to catch an unhealthy
replica. 400 probes cost about two cents.

```bash
python tools/nebul/nebul_replica_hunt.py --env-file .env --count 400 --stop-on-shed
```

### `nebul_ratelimit_repro.py` / `nebul_ratelimit_proof.py`

The earlier generation: byte-identical replay, a `--watch` monitor with
`--max-spend-usd`, and the `--identical-load` mode that demonstrates the caching
trap above.

### `nebul_saturation_repro.py` — find the concurrency threshold

Ramps concurrency with unique large bodies and names the level at which HTTP 400
first appears. Estimates the spend first and refuses to start above
`--budget-usd` (default $4) without `--yes`.
