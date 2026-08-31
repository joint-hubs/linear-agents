# HTTP 400 "failed to extract prompt from request body" is load shedding, not a malformed request

**Endpoint:** `POST https://api.inference.nebul.io/v1/messages?beta=true`
**Model:** `zai-org/GLM-5.2-FP8`
**Date of evidence:** 2026-08-27
**Client:** Claude Code (Anthropic Messages API), through a local logging proxy that
forwards requests unmodified and stores the raw bytes of anything non-200.

Support classified this error as a malformed request. The evidence below rules that
out three separate ways. Every request in this report was captured on the wire, and
every replay was byte-verified with SHA-256 recomputed immediately before sending.

---

## 1. The rejected bytes are accepted when resent unchanged

Two independent captures, hours apart. In both cases the exact byte sequence that was
rejected was replayed later with no modification whatsoever — same file, same digest,
no re-serialization — and was accepted every time.

### Capture A

| | |
|---|---|
| Body | 196 326 bytes |
| SHA-256 | `0f089462073c2cdb87994cf739123d41f30db1930f432ea0384516bec2d83d5b` |
| Rejected at | 2026-08-27T15:59:18.807Z |
| `x-request-id` of the **400** | `5bfbeb9f83ddd20a5466af1b2ae7d22b` |

Replayed 3×, identical bytes — **all HTTP 200**:

```
x-request-id  c373de79cb8e4499d6775dc2ba1a03b6
x-request-id  af08f76b068ec9477c745f65dce210d7
x-request-id  39dad8207ae2421fa11ec0d9a158c5ab
```

### Capture B

| | |
|---|---|
| Body | 192 479 bytes |
| SHA-256 | `1d2b3796f7d11a9c6c16b6e2d78507afc0ffbea09b4adcd29ea30873bf5e4497` |
| Rejected at | 2026-08-27T17:09:53.935Z |
| `x-request-id` of the **400** | `814114808f677edd9066ae400c42d57a` |

Replayed 3×, identical bytes — **all HTTP 200**:

```
x-request-id  ffa483aec06ff3515128d712b425d9b9
x-request-id  e36f8e57bb166c22bd7e84c57f90fd35
x-request-id  8a71949328941e5c2c93448e20fba213
```

A malformed body is a static property of the bytes. These bytes were rejected once and
accepted three times each, with nothing changed but the moment they were sent.

Both bodies are ordinary documented requests: `model`, `max_tokens`, `system`, `tools`,
`stream: true`, and `messages` using only the `user` and `assistant` roles.

---

## 2. The rejection arrives too fast to be a parse attempt

Both 400s were returned in under 200 ms. Successful responses to bodies of that size
take seconds, because the server actually prefills them.

```
#147  190KB -> 200    1 835 ms
#148  192KB -> 400      192 ms   <-- rejected
#149  252KB -> 200   10 351 ms

#241  150KB -> 200    4 100 ms
#242  188KB -> 400      176 ms   <-- rejected
#243  345KB -> 200   22 724 ms
```

Across 217 successful `POST /v1/messages` in this session the median latency was
2 829 ms, p90 12 131 ms, max 69 728 ms. For bodies over 150 KB the median was 3 835 ms.

A 176 ms response to a 188 KB body is not the result of reading that body and failing to
find a prompt in it. It is an admission-control decision taken before the work started.

---

## 3. A larger request succeeds immediately afterwards

In both cases the very next request was **bigger** than the one that was rejected —
252 KB after a rejected 192 KB, and 345 KB after a rejected 188 KB — and both succeeded.
Neither body size nor body content can explain the rejection.

Note also what the successful neighbours cost: 10.4 s and 22.7 s respectively, well above
the 2.8 s median. Both rejections happened exactly where the backend was slowest. The
pattern is consistent with a queue at capacity shedding a request rather than queuing it.

---

## What we are asking for

**1. Return HTTP 429, not HTTP 400.**

This is the part that actually breaks client applications, and it is not cosmetic. HTTP
429 is a retryable status: an SDK backs off and retries, and the user never sees it. HTTP
400 means "your request is invalid", so a correct client does **not** retry — it fails the
operation and surfaces the error. In an agent session that kills the turn and loses the
work in progress. Returning 429 with `Retry-After` would make this condition invisible to
end users instead of fatal.

If the current behaviour is genuinely a parse failure on your side under load, the
message is still wrong: the request parses fine milliseconds later.

**2. Send the `x-ratelimit-*` headers your documentation promises.**

<https://docs.nebul.io/docs/inference-api/advanced-topics/rate-limits-and-scaling>
documents six of them (`x-ratelimit-remaining-tokens` and others). We checked every
response header on every request in this session. The complete set returned is:

```
connection, content-length, content-type, date, strict-transport-security, x-request-id
```

No `x-ratelimit-*` header appeared on any response, successful or failed, and no
`Retry-After` on any failure. Without them a client has no way to pace itself against the
budget — it can only discover the limit by being rejected.

---

## Reproducing this yourself

The capture and replay tooling is a single Python file with no third-party dependencies
(standard library only, Python 3.8+), so it runs unmodified on your machines:

```
python nebul_ratelimit_repro.py --api-key <key> --replay-file <captured>.bin
```

It also has a `--watch` mode that re-sends one fixed body on an interval and records the
moment the same bytes start being rejected, and a load mode that drives unique large
requests to try to trigger the condition on demand.

One caveat worth stating, because it cost us a day: **do not test this with identical
request bodies.** Your prefix cache serves them almost entirely from cache — we measured
`"usage": {"input_tokens": 74, "cache_read_input_tokens": 41216}` on a 270 KB body, and
100 consecutive identical 270 KB requests all returned 200 while costing you 74 fresh
tokens each. A load test built that way measures nothing. The tool therefore makes every
load request unique by placing a random nonce in the first message, and reports the cache
hit ratio so a passing run cannot be mistaken for a negative result.
