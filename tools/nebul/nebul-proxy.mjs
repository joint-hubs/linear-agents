#!/usr/bin/env node
// Logging proxy in front of nebul. Forwards everything untouched and dumps any
// request that comes back non-200, so the failing body can be inspected.
//
//   node nebul-proxy.mjs            → listens on http://localhost:8899
//
// Point the provider's baseUrl at http://localhost:8899 and run the squad
// normally. Failing requests land in ./nebul-fail-<n>.json next to this file.
//
// The Authorization header is forwarded but NEVER logged or written to disk.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.NEBUL_UPSTREAM || "https://api.inference.nebul.io";
const PORT = Number(process.env.NEBUL_PROXY_PORT || 8899);

// Nebul sheds load by answering HTTP 400 with a parse-error message instead of
// HTTP 429. Proven 2026-08-27: bodies rejected this way were replayed byte-for-byte
// (SHA-256 re-verified) and accepted 6/6, and the rejection comes back in ~180ms —
// far too fast for the server to have read a 190KB body. Because 400 is not a
// retryable status, the Claude Code SDK correctly refuses to retry and the agent
// turn dies. We retry it here, where we can prove the body is fine.
// Set NEBUL_PROXY_NO_RETRY=1 to disable and observe the raw behaviour.
const SHED_MESSAGE = "failed to extract prompt from request body";
const RETRY_DELAYS_MS = [400, 1200, 3000];
const RETRY_ENABLED = process.env.NEBUL_PROXY_NO_RETRY !== "1";
let retried = 0;
let retryRecovered = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True only for the exact load-shedding signature — never for a real 400. */
function isShedResponse(status, bodyText) {
  return status === 400 && bodyText.includes(SHED_MESSAGE);
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

// The first version of this proxy recorded response headers only. That gap cost a
// day: every replay of a rejected body therefore carried OUR headers, so a
// header-gated server behaviour could not have shown up in one. Claude Code sends
// eight anthropic-beta flags, two of which (context-management-2025-06-27 and
// mid-conversation-system-2026-04-07) activate the exact features these bodies use.
// Credential values are never stored — only the header's presence and length.
function safeRequestHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase())
      ? `<redacted len=${String(v).length}>`
      : v;
  }
  return out;
}

let n = 0;

// Continue the capture numbering past whatever is already on disk. A restart that
// reset this to 0 would overwrite existing nebul-fail-<n> captures — the evidence
// this proxy exists to collect.
let failures = 0;
try {
  for (const f of readdirSync(HERE)) {
    // Match .bin as well as .json: a capture directory can hold a raw body whose
    // metadata was moved elsewhere, and numbering past only the .json files would
    // then overwrite it. Losing evidence to a counter reset has happened once.
    const m = /^nebul-fail-(\d+)\.(json|bin)$/.exec(f);
    if (m) failures = Math.max(failures, Number(m[1]));
  }
} catch { /* first run, nothing to scan */ }

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const url = UPSTREAM + req.url;
    const id = ++n;

    // Forward headers verbatim except host (and never log authorization).
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];

    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch (e) {
      console.log(`#${id} ${req.method} ${req.url} -> PROXY ERROR ${e.message}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy upstream failure", detail: e.message }));
      return;
    }

    // Only NON-200 responses are buffered. Draining a 200 here would hold the whole
    // SSE stream until generation finished, so the client's time-to-first-byte became
    // its time-to-LAST-byte: 9-53s on a live squad. Claude Code's auto-mode permission
    // classifier has its own timeout and started failing every tool call with
    // "temporarily unavailable (timed out)". Error bodies are a few hundred bytes, so
    // buffering those costs nothing and keeps the capture and retry logic intact.
    let respBuf = upstream.status === 200
      ? Buffer.alloc(0)
      : Buffer.from(await upstream.arrayBuffer());
    let attempts = 0;

    // Retry the load-shedding 400 with the SAME bytes. Anything else — a real 400,
    // a 404, a 5xx — is passed through untouched on the first response.
    while (
      RETRY_ENABLED
      && isShedResponse(upstream.status, respBuf.toString("utf8"))
      && attempts < RETRY_DELAYS_MS.length
    ) {
      const delay = RETRY_DELAYS_MS[attempts];
      attempts++;
      retried++;
      console.log(`#${id} ${req.method} ${req.url} ${(body.length / 1024).toFixed(0)}KB -> 400 load-shed, ponawiam za ${delay}ms (proba ${attempts}/${RETRY_DELAYS_MS.length})`);
      await sleep(delay);
      try {
        upstream = await fetch(url, { method: req.method, headers, body });
        respBuf = upstream.status === 200
          ? Buffer.alloc(0)
          : Buffer.from(await upstream.arrayBuffer());
      } catch (e) {
        console.log(`#${id} ponowienie nie powiodlo sie: ${e.message}`);
        break;
      }
      if (upstream.status === 200) {
        retryRecovered++;
        console.log(`#${id} ODZYSKANE po ${attempts} ponowieniu/ach -> 200 (te same bajty)`);
      }
    }

    const ms = Date.now() - started;
    const kb = (body.length / 1024).toFixed(0);

    // Response headers are the evidence that no x-ratelimit-* is ever sent.
    const respHeaders = {};
    for (const [k, v] of upstream.headers) respHeaders[k] = v;

    if (upstream.status === 200 && attempts > 0) {
      console.log(`#${id} ${req.method} ${req.url} ${kb}KB -> 200 po ${attempts} ponowieniu/ach (${ms}ms lacznie)  [odzyskane: ${retryRecovered}/${retried}]`);
    }

    // A zero-length body is Claude Code's connectivity probe (Bun/1.4.1 HEAD-style
    // check). It 404s by design and is not evidence; capturing it only adds noise.
    if (upstream.status !== 200 && body.length > 0) {
      failures++;
      const file = join(HERE, `nebul-fail-${failures}.json`);
      // The RAW bytes, untouched. Replaying a re-serialized JSON.parse() would
      // not be byte-identical, which is exactly the claim we need to defend.
      const rawFile = join(HERE, `nebul-fail-${failures}.bin`);
      const sha256 = createHash("sha256").update(body).digest("hex");
      writeFileSync(rawFile, body);
      let parsed = null;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { /* keep raw */ }
      writeFileSync(file, JSON.stringify({
        status: upstream.status,
        at: new Date().toISOString(),
        path: req.url,
        // How long upstream took to refuse. The refusals measured so far come back
        // in 173–196ms, while a trivial 5-token request to the same endpoint needs
        // 510–560ms — so the refusal is FASTER than a normal round trip and cannot
        // involve anything that read the body. Recording it makes that checkable.
        elapsedMs: ms,
        retryAttempts: attempts,
        httpVersion: req.httpVersion,
        requestHeaders: safeRequestHeaders(req.headers),
        requestHeaderOrder: req.rawHeaders.filter((_, i) => i % 2 === 0),
        rawBodyFile: rawFile,
        rawBodySha256: sha256,
        requestId: respHeaders["x-request-id"] || null,
        responseHeaders: respHeaders,
        rateLimitHeaders: Object.keys(respHeaders).filter((k) => k.toLowerCase().startsWith("x-ratelimit")),
        upstreamBody: respBuf.toString("utf8").slice(0, 4000),
        requestBytes: body.length,
        // Structural summary first — quick to read without opening the whole dump.
        summary: parsed ? {
          model: parsed.model,
          stream: parsed.stream,
          max_tokens: parsed.max_tokens,
          toolCount: (parsed.tools || []).length,
          toolNames: (parsed.tools || []).map((t) => t.name),
          messageCount: (parsed.messages || []).length,
          systemType: Array.isArray(parsed.system) ? `array(${parsed.system.length})` : typeof parsed.system,
          lastMessage: parsed.messages?.length
            ? {
                role: parsed.messages.at(-1).role,
                blocks: Array.isArray(parsed.messages.at(-1).content)
                  ? parsed.messages.at(-1).content.map((b) => b.type)
                  : "string",
              }
            : null,
          topLevelKeys: Object.keys(parsed),
        } : "unparseable JSON",
        request: parsed ?? body.toString("utf8").slice(0, 200000),
      }, null, 1));
      console.log(`#${id} ${req.method} ${req.url} ${kb}KB -> ${upstream.status} (${ms}ms)  ZAPISANO: ${file}`);
      console.log(`     surowe bajty: ${rawFile}  sha256=${sha256.slice(0, 16)}...`);
      console.log(`     upstream: ${respBuf.toString("utf8").slice(0, 200)}`);
      console.log(`     ODTWORZ TE SAME BAJTY POZNIEJ:`);
      console.log(`       python nebul_ratelimit_repro.py --env-file .env --replay-file "${rawFile}"`);
    } else {
      console.log(`#${id} ${req.method} ${req.url} ${kb}KB -> 200 (${ms}ms do naglowkow, strumien leci dalej)`);
    }

    const outHeaders = {};
    for (const [k, v] of upstream.headers) {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    res.writeHead(upstream.status, outHeaders);

    // A 200 is piped straight through so SSE events reach the client as they are
    // produced. Anything else was already buffered above and is answered whole.
    if (upstream.status === 200 && upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }
    res.end(respBuf);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nebul proxy: http://localhost:${PORT}  ->  ${UPSTREAM}`);
  console.log(`nieudane zadania trafia do ${join(HERE, "nebul-fail-<n>.json")} (nastepny numer: ${failures + 1})`);
  console.log(RETRY_ENABLED
    ? `ponawianie 400 "${SHED_MESSAGE}": WLACZONE (${RETRY_DELAYS_MS.join("ms, ")}ms) — NEBUL_PROXY_NO_RETRY=1 wylacza`
    : 'ponawianie 400: WYLACZONE (NEBUL_PROXY_NO_RETRY=1)');
  console.log("naglowek Authorization jest przekazywany, ale nigdy nie logowany ani zapisywany.");
});
