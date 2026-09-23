// scripts/mcp/test/runtime-fake.mjs — an injectable stand-in for the shared
// scripts/codegraph-runtime.mjs contract (resolveProjectRoot /
// ensureCodegraphReady / resolveCodegraphCommand), used via
// CODEGRAPH_MCP_RUNTIME by the spawn-based boundary tests. The unit tests
// build smaller inline fakes; this one is a full module because a spawned
// boundary process can only receive a runtime by import.
//
// Env knobs:
//   FAKE_RUNTIME_ROOT     the canonical guarded root (default: cwd)
//   FAKE_RUNTIME_READY    ok (default) | notready | throw
//   FAKE_RUNTIME_REASON   the not-ready reason to report
//   FAKE_RUNTIME_LOG      append one JSON line per runtime call to this file
//                         (spawn tests read it back to assert the gate ran
//                         with the exact contract arguments)
//
// The fake is async on ensureCodegraphReady on purpose: the contract allows
// a synchronous function, and the boundary must await either shape.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = process.env.FAKE_RUNTIME_ROOT ?? process.cwd();
const MODE = process.env.FAKE_RUNTIME_READY ?? "ok";
const LOG = process.env.FAKE_RUNTIME_LOG;

function log(fn, payload) {
  const line = JSON.stringify({ fn, ...payload });
  console.error(`[fake-runtime] ${line}`);
  if (LOG) appendFileSync(LOG, `${line}\n`);
}

// Canonicalization good enough to exercise the boundary's same-root policy:
// trailing-slash and case/spelling differences fold onto ROOT; anything else
// is returned untouched so the boundary refuses it as a mismatch.
const canon = (p) => String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

export function resolveProjectRoot({ projectRoot, cwd } = {}) {
  const base = projectRoot ?? cwd ?? process.cwd();
  log("resolveProjectRoot", { base });
  if (canon(base) === canon(ROOT)) return ROOT;
  return base;
}

export async function ensureCodegraphReady({ projectRoot, initialize = false, timeoutMs } = {}) {
  log("ensureCodegraphReady", { projectRoot, initialize, timeoutMs });
  if (MODE === "throw") throw new Error("fake runtime: readiness check exploded");
  if (MODE === "notready") {
    return {
      ok: false,
      root: projectRoot ?? ROOT,
      reason: process.env.FAKE_RUNTIME_REASON ?? "fake: pending changes never settle",
      synced: false,
      initialized: true,
      version: "1.6.0-fake",
    };
  }
  return { ok: true, root: projectRoot ?? ROOT, reason: "fake: fresh", synced: false, initialized: true, version: "1.6.0-fake" };
}

export function resolveCodegraphCommand() {
  log("resolveCodegraphCommand", {});
  // Point the boundary's `serve --mcp …` append at the fake upstream binary;
  // the fake reads its own behavior from FAKE_UPSTREAM_* env.
  return { command: process.execPath, args: [fileURLToPath(new URL("./fake-upstream.mjs", import.meta.url))] };
}