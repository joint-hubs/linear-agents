#!/usr/bin/env node
// Capture what Claude Code ACTUALLY puts on the wire, without spending a cent.
//
//   node tools/nebul/nebul-capture-headers.mjs      → listens on 127.0.0.1:8901
//
// Nothing is forwarded anywhere. Every request is answered locally with a valid
// (empty) Anthropic SSE stream, so the client sees a normal short reply and
// exits cleanly. The request headers and body shape are written to
// ./claude-wire-<n>.json next to this file.
//
// Why this exists: nebul-proxy.mjs recorded RESPONSE headers only. Replays of a
// rejected body therefore carried OUR headers, not Claude Code's — so a
// header-gated server behaviour (e.g. anthropic-beta activating the
// `context_management` edit path) could never show up in a replay.
//
// Credential headers are recorded by NAME and LENGTH only. No value is ever
// written to disk or printed.

import { createServer } from "node:http";
import { writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAPTURE_PORT || 8901);

const SECRET_HEADERS = new Set([
  "authorization", "x-api-key", "proxy-authorization", "cookie",
]);

let n = 0;
try {
  for (const f of readdirSync(HERE)) {
    const m = /^claude-wire-(\d+)\.json$/.exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
} catch { /* first run */ }

/** Redact values, keep the shape: a header's presence and size are the evidence. */
function safeHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase())
      ? `<redacted len=${String(v).length}>`
      : v;
  }
  return out;
}

function sseReply(res, text) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_capture", type: "message", role: "assistant",
      model: "capture", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  send("content_block_start", {
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  });
  send("content_block_delta", {
    type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }

    const id = ++n;
    let parsed = null;
    try { parsed = JSON.parse(body.toString("utf8")); } catch { /* keep raw */ }

    const record = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      // rawHeaders preserves ORDER and ORIGINAL CASE, which the normalized
      // `headers` object destroys — both can matter to a picky gateway.
      rawHeaderOrder: req.rawHeaders.filter((_, i) => i % 2 === 0),
      headers: safeHeaders(req.headers),
      bodyBytes: body.length,
      bodyShape: parsed ? {
        topLevelKeys: Object.keys(parsed),
        model: parsed.model,
        stream: parsed.stream,
        thinking: parsed.thinking,
        output_config: parsed.output_config,
        context_management: parsed.context_management,
        messageRoles: (parsed.messages || []).map((m) => m.role),
      } : "unparseable",
    };

    const file = join(HERE, `claude-wire-${id}.json`);
    writeFileSync(file, JSON.stringify(record, null, 1));

    console.log(`#${id} ${req.method} ${req.url} HTTP/${req.httpVersion} ${body.length}B -> ${file}`);
    const beta = req.headers["anthropic-beta"];
    if (beta) console.log(`     anthropic-beta: ${beta}`);
    if (parsed) console.log(`     top-level: ${Object.keys(parsed).join(", ")}`);

    sseReply(res, "ok");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`capture server: http://127.0.0.1:${PORT}  (forwards NOTHING, costs NOTHING)`);
  console.log(`records land in ${join(HERE, "claude-wire-<n>.json")} (next: ${n + 1})`);
  console.log("credential headers are stored as <redacted len=N>, never by value.");
});
