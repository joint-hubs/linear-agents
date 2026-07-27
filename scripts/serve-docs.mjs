#!/usr/bin/env node
/**
 * scripts/serve-docs.mjs — static file server for docs/, localhost only.
 *
 * Standalone HTML tools under docs/ui/ (model-explorer.html) need to be served
 * over http rather than opened via file://, because file:// blocks enough of the
 * page to make it untestable. This exists so they can be opened and verified
 * without touching the telemetry server on :7331, which serves the built
 * dashboard and has no business knowing about docs.
 *
 * Read-only, no directory traversal, binds 127.0.0.1 only.
 *
 * Usage: node scripts/serve-docs.mjs [port]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PORT = Number(process.argv[2] || process.env.PORT || 7444);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!rel) rel = "ui/model-explorer.html";

    const target = resolve(ROOT, rel);
    // Traversal guard: the resolved path must stay under docs/.
    const inside = relative(ROOT, target);
    if (inside.startsWith("..") || (inside.includes(":") && !inside.startsWith(sep))) {
      res.writeHead(403).end("forbidden");
      return;
    }

    let file = target;
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, "index.html");

    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`docs served: http://localhost:${PORT}/  (root: ${ROOT})`);
  console.log(`model explorer: http://localhost:${PORT}/ui/model-explorer.html`);
});
