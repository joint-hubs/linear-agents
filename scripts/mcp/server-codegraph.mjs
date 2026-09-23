// scripts/mcp/server-codegraph.mjs — fail-closed MCP boundary over the real
// CodeGraph stdio server (plan 2026-09-23 §4 "Cover both access paths").
//
// WHY A BOUNDARY SERVER (and not a PreToolUse hook): the official hooks
// contract (https://code.claude.com/docs/en/hooks#timeouts) makes an ordinary
// command PreToolUse hook FAIL OPEN on launch failure and on its own timeout —
// the two states where a freshness guard is most needed are exactly the states
// in which it silently stops guarding. A hook therefore cannot ENFORCE
// freshness; it can only decorate it. This server can: it sits on the only
// path the query can take (stdio between the MCP client and codegraph), so
// "the guard did not run" and "the query did not run" are the same event.
//
// WHAT IT IS: a thin JSON-RPC proxy, not a reimplementation. The installed
// `codegraph serve --mcp` keeps its own tools, schemas, instructions,
// allowlist (CODEGRAPH_MCP_TOOLS), watcher, daemon and query engine — every
// handshake, tools/list, notification, error and server-initiated request
// (e.g. roots/list) passes through untouched. The boundary adds exactly one
// policy, applied to the seven index-query tools (codegraph_status is the
// guard's own instrument and stays exempt, mirroring scripts/code-intel.mjs):
//
//   1. resolve ONE canonical target root at startup
//      (runtime.resolveProjectRoot({projectRoot, cwd}) — the server's cwd is
//      the project the MCP client launched it in, so a worktree gets the
//      WORKTREE, never tooling-main);
//   2. before EVERY gated tools/call, await the shared readiness guard
//      (runtime.ensureCodegraphReady({initialize:false}) — the same
//      CLI-guard algorithm code-intel.mjs proved; the boundary never
//      re-implements freshness itself and NEVER auto-inits on the query path);
//   3. inject the checked root as the call's projectPath — the same root that
//      was proven is the root that is sent. A caller-supplied projectPath is
//      accepted only when it canonicalizes to the same root; anything else is
//      a typed refusal (conflicting project identity), never a silent
//      answer from another checkout;
//   4. if the guard cannot PROVE freshness (or throws, or times out), answer
//      an explicit MCP isError UNKNOWN envelope — never a stale forward,
//      never "symbol not found". UNKNOWN is distinguishable from an empty
//      result by construction;
//   5. if upstream flags the response (per-file stale banner, on-disk drift
//      markers, borrowed-worktree notice), the content is NOT served as-is:
//      bounded re-gate + retry, then UNKNOWN. The degraded banner (watcher
//      off) is passed through as information — the independent gate remains
//      the freshness proof there.
//   6. an unknown codegraph_* tool is refused typed
//      (unsupported-guarded-tool), never forwarded: a surface this boundary
//      does not gate cannot be proven fresh, and CODEGRAPH_MCP_TOOLS is not
//      a way around the gate. codegraph_status stays the only exemption.
//
// FAIRNESS OF SCOPE: the check→query race is not globally atomic — files can
// change between the guard and the answer. The contract is bounded honesty:
// upstream's own staleness banners close that window, a bounded retry absorbs
// the watcher's debounce, and a persistently-moving tree gets UNKNOWN, never
// a confidently wrong relationship.
//
// Protocol notes (verified against the installed 1.6.0 dist):
//   · framing is newline-delimited JSON-RPC 2.0 on both sides;
//   · the server may send requests TO the client (roots/list) mid-call, so no
//     handler may block the line pumps — the deadlock upstream's own socket
//     transport warns about is real;
//   · upstream answers tools/call tool-failures as results with isError:true
//     (protocol errors are JSON-RPC error objects) — the boundary forwards
//     both verbatim and only ever synthesizes ITS OWN refusals as
//     isError:true results;
//   · `serve --mcp --path <root>` makes upstream's WATCHED default project the
//     boundary's target (the watcher-driven stale banner only fires on the
//     default project — a projectPath-only server would run watcher-less and
//     blind), and keys the shared daemon per-project exactly as
//     spawnDetachedDaemon itself does.
//
// Stdio discipline: stdout is protocol, never log — every diagnostic goes to
// stderr with a [codegraph-boundary] prefix. Non-JSON lines arriving on the
// UPSTREAM's stdout are dropped with a stderr note so this server's stdout
// stays clean JSON-RPC even if upstream ever chatters.
//
// No dependencies beyond node builtins. The runtime contract lives in
// scripts/codegraph-runtime.mjs (shared with the CLI/spawn path):
//   resolveProjectRoot({projectRoot, cwd}) -> canonical root or throw
//   ensureCodegraphReady({projectRoot, cwd, initialize, timeoutMs})
//     -> {ok, root, reason, synced, initialized, version?}
//   resolveCodegraphCommand() -> {command, args}  (spawn shell:false)
// Until that module lands, or when CODEGRAPH_MCP_RUNTIME points elsewhere,
// the boundary still runs — fail-closed: without the runtime every gated call
// answers guard-unavailable UNKNOWN, and handshake forwarding degrades with a
// typed error instead of guessing a binary (the 1.5.0/1.6.0 PATH discrepancy
// is a diagnosis, not a default).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── gated surface ────────────────────────────────────────────────────────────
// The eight tools CODEGRAPH_MCP_TOOLS re-enables in .mcp.json; everything the
// index ANSWERS from is gated. codegraph_status is exempt — it IS the guard's
// instrument (same split as code-intel.mjs's QUERY_VERBS vs `status`).
export const GATED_TOOLS = new Set([
  "codegraph_explore",
  "codegraph_node",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_files",
]);
export const EXEMPT_TOOLS = ["codegraph_status"];

/**
 * Gate policy per tools/call name — default-deny for the codegraph surface.
 * "unsupported" means: a codegraph_* tool this boundary does not know —
 * refuse it typed instead of forwarding it ungated (a future tool is not a
 * hole in the gate; enabling one is a deliberate act: extend GATED_TOOLS,
 * then CODEGRAPH_MCP_TOOLS, then the boundary tests, in that order).
 */
export function toolPolicy(name) {
  if (typeof name !== "string") return "passthrough";
  if (EXEMPT_TOOLS.includes(name)) return "exempt";
  if (GATED_TOOLS.has(name)) return "gated";
  if (name.startsWith("codegraph_")) return "unsupported";
  return "passthrough";
}

// ── upstream response markers (verified in installed 1.6.0) ─────────────────
// Built by concatenation on purpose: if this file's own source contained a
// marker verbatim, a codegraph query ABOUT this adapter would echo the marker
// back and self-trip the detector. Split parts keep the wire-matching exact
// while keeping the literal out of the indexed bytes.
//
// Heads are anchored positionally, so they must survive upstream cosmetics:
// ANSI sequences are stripped and leading whitespace is trimmed before the
// startsWith check (a colored or padded banner still trips the classifier).
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // colors/cursor (letter final byte)
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC (BEL/ST-terminated)
function stripAnsi(text) {
  return String(text).replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}
const STALE_BANNER_HEAD =
  "⚠️ Some files referenced below were edited since the last" +
  " index sync — their codegraph entries may be stale:";
const DEGRADED_BANNER_HEAD =
  "⚠️ CodeGraph auto-sync is" + " DISABLED — live file watching stopped";
const WORKTREE_NOTICE_HEAD =
  "⚠ CodeGraph results below come from a different git" + " worktree (";
const DRIFT_MARKERS = [
  // explore per-file suffix: "…the symbol list may be outdated" — the
  // relationship data itself is stale even where the source re-read is fresh.
  ["⚠ changed since last", " index sync"],
  // explore stale-omitted header + the response-level summary footer.
  ["⚠ changed on disk after the last", " index sync"],
  // codegraph_node notices: indexed line range no longer matches.
  ["changed on disk after it was last", " indexed"],
].map(([a, b]) => new RegExp(a + b, "i"));

/**
 * Classify a tools/call result the boundary is about to forward.
 * Position-anchored heads are matched against the first text block only
 * (upstream prepends its banners there), ANSI-stripped and leading-trimmed
 * first; drift markers are searched across all text blocks case-insensitively
 * (also ANSI-stripped). Error results are classified too — harmless:
 * upstream never prepends banners to isError results.
 */
export function classifyToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const firstText = blocks.find((b) => b && b.type === "text")?.text ?? "";
  const head = stripAnsi(firstText).trimStart();
  const allText = stripAnsi(
    blocks
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  );
  if (head.startsWith(WORKTREE_NOTICE_HEAD)) {
    return { wrongCheckout: true, stale: false, degraded: false, evidence: "worktree-mismatch notice" };
  }
  const degraded = head.startsWith(DEGRADED_BANNER_HEAD);
  if (head.startsWith(STALE_BANNER_HEAD)) {
    return { wrongCheckout: false, stale: true, degraded, evidence: "per-file stale banner" };
  }
  for (const re of DRIFT_MARKERS) {
    if (re.test(allText)) {
      return { wrongCheckout: false, stale: true, degraded, evidence: `on-disk drift marker (${re.source.split(" ").slice(0, 4).join(" ")}…)` };
    }
  }
  return { wrongCheckout: false, stale: false, degraded };
}

// ── typed UNKNOWN envelope ──────────────────────────────────────────────────
// Every refusal: (a) says UNKNOWN and its type, (b) names the fix, (c) never
// names the queried symbol (code-intel's no-leak convention), (d) is
// distinguishable from an empty result, (e) sanctions the direct-file
// fallback so the agent is never left with "no answer and no next step".
export function unknownEnvelope(type, detail, fix) {
  const text = [
    `{"boundary":"codegraph-mcp","status":"UNKNOWN","type":${JSON.stringify(type)}}`,
    "",
    "[codegraph-boundary] UNKNOWN — freshness or availability could not be proven, so this query was NOT answered.",
    "",
    detail,
    "",
    'This is not a "no results" answer: nothing was determined about the query itself.',
    "Sanctioned fallback: use Read/Grep/Glob directly for this question.",
    `Fix: ${fix}`,
  ].join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

function envelopeFix(type, context) {
  switch (type) {
    case "guard-unavailable":
      return "the shared freshness runtime could not be loaded — see this server's stderr; CODEGRAPH_MCP_RUNTIME may point at a runtime module.";
    case "root-unresolved":
      return "run this MCP server with its cwd inside the target project (a worktree's own root), or pass --root <path>.";
    case "project-mismatch":
      return `this guarded server answers only for ${context.root}; query ${context.other} from a server whose cwd is in that project.`;
    case "not-ready":
      return `make the index provably fresh: codegraph init (if ${context.root} has no .codegraph/), codegraph sync <root> when changes are pending, and a committed git baseline (the pending signal is computed against it — see scripts/code-intel.mjs).`;
    case "unsupported-guarded-tool":
      return `"${context.other}" is outside this boundary's GATED_TOOLS/EXEMPT_TOOLS — extend scripts/mcp/server-codegraph.mjs's gate and its tests before enabling the tool in CODEGRAPH_MCP_TOOLS.`;
    case "wrong-checkout":
      return `the resolved index belongs to a different git worktree — run "codegraph init -i" in ${context.root} for a worktree-local index.`;
    case "stale-after-retry":
      return "the tree kept changing during the query (upstream's stale banner persisted after a bounded re-sync and retry); retry once the tree is quiescent.";
    case "upstream-timeout":
      return `no answer from the codegraph server within ${context.timeoutMs}ms — retry once; if it persists, check "codegraph daemon" and this server's stderr.`;
    case "upstream-unavailable":
    case "upstream-exited":
      return "the codegraph server process is gone; the MCP client should restart it (this boundary exits after reporting so the restart is clean).";
    default:
      return "report this with the server's stderr trace.";
  }
}

// ── configuration ────────────────────────────────────────────────────────────
export function readBoundaryConfig(env = process.env) {
  const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = parseInt(env[name], 10);
    if (Number.isNaN(raw) || raw < min) return fallback;
    return Math.min(raw, max);
  };
  return {
    // The guard's own budget (contract default 30s).
    gateTimeoutMs: int("CODEGRAPH_MCP_GATE_TIMEOUT_MS", 30_000, { min: 1 }),
    // One forwarded tools/call — generous: explore on a cold index can take a
    // while; the point is a BOUND, not a latency target.
    callTimeoutMs: int("CODEGRAPH_MCP_CALL_TIMEOUT_MS", 120_000, { min: 1 }),
    // initialize / tools/list / ping / any other forwarded request.
    requestTimeoutMs: int("CODEGRAPH_MCP_REQUEST_TIMEOUT_MS", 30_000, { min: 1 }),
    // Bounded stale-retry: re-gate + re-send at most this many times.
    staleRetries: int("CODEGRAPH_MCP_STALE_RETRIES", 1, { min: 0, max: 5 }),
    // Settle before a stale retry so upstream's watcher debounce
    // (default ~2s, CODEGRAPH_WATCH_DEBOUNCE_MS upstream) can clear its
    // pending set — a retry inside the debounce window would just re-read
    // the same banner and burn the budget.
    staleRetryDelayMs: int("CODEGRAPH_MCP_STALE_RETRY_DELAY_MS", 2_500, { min: 0 }),
  };
}

// ── runtime loading ──────────────────────────────────────────────────────────
// CODEGRAPH_MCP_RUNTIME (test/probe injection) wins; then the shared
// ../codegraph-runtime.mjs. No runtime is a valid, fail-closed state — the
// boundary must not guess a binary.
export async function loadRuntime(env = process.env, baseDir = __dir) {
  const fromEnv = env.CODEGRAPH_MCP_RUNTIME;
  const target = fromEnv
    ? pathToFileURL(fromEnv.startsWith("/") || fromEnv.includes("\\") || fromEnv.includes(":") ? fromEnv : join(process.cwd(), fromEnv)).href
    : pathToFileURL(join(baseDir, "..", "codegraph-runtime.mjs")).href;
  if (!fromEnv && !existsSync(join(baseDir, "..", "codegraph-runtime.mjs"))) {
    return null;
  }
  try {
    const mod = await import(target);
    if (typeof mod.resolveProjectRoot !== "function" || typeof mod.ensureCodegraphReady !== "function" || typeof mod.resolveCodegraphCommand !== "function") {
      throw new Error("module does not export the runtime contract (resolveProjectRoot / ensureCodegraphReady / resolveCodegraphCommand)");
    }
    return mod;
  } catch {
    return null;
  }
}

// ── the boundary ─────────────────────────────────────────────────────────────
/**
 * Build the boundary. Everything process-shaped is injected: tests drive the
 * same message path with a fake upstream seam and a fake runtime, without
 * spawning; the stdio entry below is the only place real streams are touched.
 *
 *   runtime      — null or the shared contract module/object.
 *   root         — canonical target root (string) or null when unresolved.
 *   rootDetail   — why root is null, for the typed refusal.
 *   upstream     — { send(line), kill() } seam over the spawned server.
 *   writeClient  — (line: string) sink for client-bound JSON-RPC lines.
 *   log          — stderr sink.
 *   config       — readBoundaryConfig() shape.
 *   onUpstreamDied — fired once when the upstream process exits unexpectedly;
 *                  the stdio entry flushes and exits so the client restarts
 *                  a clean pair instead of talking to a boundary whose
 *                  backend is gone.
 */
export function createBoundary({
  runtime,
  root,
  rootDetail = null,
  upstream,
  writeClient,
  log = () => {},
  config = readBoundaryConfig(),
  onUpstreamDied = null,
}) {
  const pending = new Map(); // client id (raw JSON value) -> { kind, resolve, timer }
  let upstreamDead = false;
  let shuttingDown = false;

  const sendClient = (line) => writeClient(line);
  const sendUpstream = (line) => {
    if (upstreamDead || !upstream) return false;
    try {
      upstream.send(line);
      return true;
    } catch {
      return false;
    }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const clientError = (id, type, detail) =>
    sendClient(
      JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32603, message: `codegraph boundary: ${type}`, data: { type, detail } },
      }),
    );

  // The typed refusal for a gated tools/call — isError:true per the MCP
  // tool-error convention; a protocol-level error would teach the client the
  // TOOL is broken rather than the ANSWER is unproven.
  const refuse = (id, type, detail, context = {}) => {
    const fix = envelopeFix(type, { root, timeoutMs: config.callTimeoutMs, ...context });
    log(`UNKNOWN ${type} (id ${JSON.stringify(id) ?? "null"}): ${detail}`);
    sendClient(
      JSON.stringify({ jsonrpc: "2.0", id, result: unknownEnvelope(type, detail, fix) }),
    );
  };

  // Register the in-flight request; the resolve fires exactly once with
  // {msg} | {timeout:true} | {died:true}.
  const register = (id, kind, timeoutMs) =>
    new Promise((resolve) => {
      if (pending.has(id)) log(`overwriting in-flight id ${JSON.stringify(id)} — a client reused a live id`);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true });
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { kind, resolve, timer });
    });
  const settle = (id, outcome) => {
    const entry = pending.get(id);
    if (!entry) return false; // late/unmatched — dropped by the caller
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(outcome);
    return true;
  };

  // ── client → upstream ──────────────────────────────────────────────────
  function handleClientLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      sendClient(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", data: String(err.message).slice(0, 200) } }),
      );
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
      const id = msg && typeof msg === "object" && !Array.isArray(msg) && "id" in msg ? msg.id : null;
      sendClient(
        JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } }),
      );
      return;
    }
    // A client RESPONSE to a server-initiated request (id, no method): pure
    // passthrough — routing it would eat the answer to upstream's roots/list.
    if (typeof msg.method !== "string") {
      if (!("id" in msg)) {
        sendClient(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
        return;
      }
      sendUpstream(text);
      return;
    }
    // Notifications: forwarded, never answered.
    if (msg.id === undefined || msg.id === null) {
      sendUpstream(text);
      return;
    }
    // Requests.
    if (msg.method === "tools/call") {
      const policy = toolPolicy(msg.params?.name);
      if (policy === "gated") {
        void gatedCall(msg).catch((err) =>
          clientError(msg.id, "boundary-internal", String(err?.message ?? err)),
        );
        return;
      }
      if (policy === "unsupported") {
        // An unknown codegraph_* tool would be an ungated index query — the
        // boundary refuses it typed rather than forward what it cannot guard.
        refuse(
          msg.id,
          "unsupported-guarded-tool",
          `"${msg.params?.name}" is a codegraph tool this boundary does not gate — refusing rather than answering ungated`,
          { other: msg.params?.name },
        );
        return;
      }
    }
    void forwardPlain(msg, text).catch(() => {});
  }

  async function forwardPlain(msg, text) {
    if (upstreamDead || !upstream) {
      clientError(msg.id, "upstream-unavailable", "the codegraph server is not running (spawn failed or it exited)");
      return;
    }
    const outcome = register(msg.id, "plain", config.requestTimeoutMs);
    if (!sendUpstream(text)) {
      settle(msg.id, { died: true });
    }
    const res = await outcome;
    if (res.timeout) {
      clientError(msg.id, "upstream-timeout", `no answer for "${msg.method}" within ${config.requestTimeoutMs}ms`);
      return;
    }
    if (res.died) {
      clientError(msg.id, "upstream-unavailable", "the codegraph server exited before answering");
      return;
    }
    sendClient(JSON.stringify(res.msg));
  }

  async function gatedCall(msg) {
    const id = msg.id;
    const tool = msg.params?.name;
    const args = { ...(msg.params?.arguments ?? {}) };

    // 1. runtime present?
    if (!runtime) {
      refuse(id, "guard-unavailable", "the shared freshness runtime is not loaded, so no freshness can be proven");
      return;
    }
    // 2. target root resolved?
    if (!root) {
      refuse(id, "root-unresolved", rootDetail || "the canonical target project could not be resolved at startup");
      return;
    }
    // 3. caller-supplied projectPath: same canonical root or a typed refusal.
    //    Never silently fall back to tooling-main (or anywhere else).
    if (args.projectPath !== undefined && args.projectPath !== null && args.projectPath !== "") {
      let canonical = null;
      let why = "";
      try {
        canonical = runtime.resolveProjectRoot({ projectRoot: args.projectPath, cwd: process.cwd() });
      } catch (err) {
        why = String(err?.message ?? err);
      }
      if (canonical !== root) {
        refuse(
          id,
          "project-mismatch",
          why
            ? `projectPath ${args.projectPath} was refused: ${why}`
            : `projectPath ${args.projectPath} canonicalizes to ${canonical}, but this server guards ${root}`,
          { other: args.projectPath },
        );
        return;
      }
    }
    // 4. the gate — shared algorithm, no boundary-side freshness logic. The
    //    root the gate proves is the root the call carries.
    let ready;
    try {
      ready = await runtime.ensureCodegraphReady({
        projectRoot: root,
        initialize: false,
        timeoutMs: config.gateTimeoutMs,
      });
    } catch (err) {
      refuse(id, "guard-error", `the readiness guard threw: ${String(err?.message ?? err)}`);
      return;
    }
    if (!ready || ready.ok !== true) {
      const reason = ready?.reason ? String(ready.reason) : "the guard returned no verdict";
      const version = ready?.version ? ` (codegraph CLI ${ready.version})` : "";
      refuse(id, "not-ready", `index freshness for ${root} could not be proven: ${reason}${version}`);
      return;
    }
    const useRoot = ready.root ?? root;
    if (useRoot !== root) {
      refuse(id, "project-mismatch", `the guard canonicalized ${root} to ${useRoot}; refusing to answer from a different root than the guarded target`);
      return;
    }
    if (upstreamDead || !upstream) {
      refuse(id, "upstream-unavailable", "the codegraph server is not running (spawn failed or it exited)");
      return;
    }

    const forwarded = {
      ...msg,
      params: { ...msg.params, arguments: { ...args, projectPath: useRoot } },
    };
    const attempts = 1 + config.staleRetries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const outcome = register(id, "gated", config.callTimeoutMs);
      if (!sendUpstream(JSON.stringify(forwarded))) {
        settle(id, { died: true });
      }
      const res = await outcome;
      if (res.timeout) {
        refuse(id, "upstream-timeout", `no answer for "${tool}" within ${config.callTimeoutMs}ms`);
        return;
      }
      if (res.died) {
        refuse(id, "upstream-exited", "the codegraph server exited before answering");
        return;
      }
      const resp = res.msg;
      // Upstream's own protocol errors (unknown tool, disabled via
      // CODEGRAPH_MCP_TOOLS, malformed params): verbatim, not our verdict.
      if (resp.error) {
        sendClient(JSON.stringify(resp));
        return;
      }
      const cls = classifyToolResult(resp.result);
      if (cls.wrongCheckout) {
        // Structural, not a race: a retry cannot fix a borrowed index.
        refuse(id, "wrong-checkout", `upstream reported: ${cls.evidence} (upstream's notice names both trees — a wrong-branch answer was withheld)`);
        return;
      }
      if (cls.stale) {
        if (attempt < attempts) {
          log(`stale response for "${tool}" (${cls.evidence}); re-gating and retrying (attempt ${attempt + 1}/${attempts})`);
          await sleep(config.staleRetryDelayMs);
          let recheck;
          try {
            recheck = await runtime.ensureCodegraphReady({
              projectRoot: root,
              initialize: false,
              timeoutMs: config.gateTimeoutMs,
            });
          } catch (err) {
            refuse(id, "guard-error", `the readiness guard threw during stale retry: ${String(err?.message ?? err)}`);
            return;
          }
          if (!recheck || recheck.ok !== true) {
            refuse(id, "not-ready", `index went unprovable during a stale retry: ${recheck?.reason ?? "no verdict"}`);
            return;
          }
          continue;
        }
        refuse(
          id,
          "stale-after-retry",
          `upstream still flags the answer (${cls.evidence}) after ${attempts} attempt(s) with a re-sync in between; serving it would risk a confidently wrong relationship`,
        );
        return;
      }
      // Clean, or degraded-only (watcher off — informational; the independent
      // gate above is the freshness proof on that path). Verbatim.
      sendClient(JSON.stringify(resp));
      return;
    }
  }

  // ── upstream → client ──────────────────────────────────────────────────
  function handleUpstreamLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // Stdout must stay clean JSON-RPC: never forward upstream chatter.
      log(`dropped non-JSON upstream stdout line (${text.slice(0, 120)}…)`);
      return;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      log(`dropped malformed upstream line (${text.slice(0, 120)}…)`);
      return;
    }
    // A response to something we forwarded.
    if (typeof msg.method !== "string") {
      if (!("id" in msg) || !("result" in msg) && !("error" in msg)) return;
      if (!settle(msg.id, { msg })) {
        log(`dropped unmatched upstream response id ${JSON.stringify(msg.id)} (timed out or already settled)`);
      }
      return;
    }
    // Server-initiated request or notification: verbatim passthrough —
    // ids stay in their origin's namespace, so no rewriting is needed.
    sendClient(text);
  }

  function handleUpstreamExit(code, signal) {
    // Idempotent: a duplicated exit event (or 'exit' racing the EPIPE kill
    // during shutdown) must not re-fire onUpstreamDied or re-resolve flushed
    // pendings.
    if (shuttingDown || upstreamDead) return;
    upstreamDead = true;
    log(`codegraph server exited (code=${code ?? "?"} signal=${signal ?? "?"}); failing in-flight calls and shutting down`);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ died: true });
    }
    pending.clear();
    onUpstreamDied?.(code, signal);
  }

  function close() {
    shuttingDown = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ died: true });
    }
    pending.clear();
    try {
      upstream?.kill?.();
    } catch {
      /* already gone */
    }
  }

  return {
    handleClientLine,
    handleUpstreamLine,
    handleUpstreamExit,
    close,
    get pendingCount() {
      return pending.size;
    },
  };
}

// ── stdio entry ─────────────────────────────────────────────────────────────
// .mcp.json wires: node scripts/mcp/server-codegraph.mjs  (project-relative,
// so each worktree runs the worktree's own copy and resolves its OWN root).
// Optional: --root <path> pins the target explicitly (tests, probes, unusual
// launchers). Env: CODEGRAPH_MCP_TOOLS (passthrough to upstream), the four
// timeout knobs in readBoundaryConfig, CODEGRAPH_MCP_RUNTIME for an injected
// runtime module.

function spawnUpstreamSeam({ command, argv, cwd, onLine, onExit, log }) {
  const child = spawn(command, argv, {
    cwd,
    env: process.env, // inherits CODEGRAPH_MCP_TOOLS and every upstream knob
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const outRl = createInterface({ input: child.stdout });
  outRl.on("line", (line) => onLine(line));
  const errRl = createInterface({ input: child.stderr });
  errRl.on("line", (line) => log(`[upstream] ${line}`));
  child.on("error", (err) => log(`[upstream] spawn/pipe error: ${err.message}`));
  child.stdin?.on?.("error", () => {});
  child.on("exit", (code, signal) => onExit(code, signal));
  return {
    send: (line) => child.stdin.write(`${line}\n`),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

// The seam-callback indirection the entry needs: spawnUpstreamSeam is called
// before createBoundary exists, so its pumps delegate to these mutable
// handlers, which main() retargets once the boundary is built.
const seamHandlers = {
  onLine: () => {},
  onExit: () => {},
};

async function main() {
  // EPIPE when the client is already gone must not turn into an uncaught
  // exception; the stdin-close handler does the real teardown.
  process.stdout.on("error", () => {});
  process.stdin.on("error", () => {});
  const log = (msg) => process.stderr.write(`[codegraph-boundary] ${msg}\n`);
  const config = readBoundaryConfig();

  const argvRootIdx = process.argv.indexOf("--root");
  const argRoot = argvRootIdx !== -1 ? process.argv[argvRootIdx + 1] : undefined;

  const runtime = await loadRuntime();
  if (!runtime) {
    log(
      "freshness runtime unavailable: scripts/codegraph-runtime.mjs is absent and CODEGRAPH_MCP_RUNTIME is unset — " +
        "gated queries will answer UNKNOWN (fail-closed) until the shared runtime lands",
    );
  }

  let root = null;
  let rootDetail = null;
  if (runtime) {
    try {
      root = runtime.resolveProjectRoot({ projectRoot: argRoot, cwd: process.cwd() });
      log(`guarding project root: ${root}`);
    } catch (err) {
      rootDetail = `resolveProjectRoot threw at startup: ${String(err?.message ?? err)}`;
      log(rootDetail);
    }
  }

  // Upstream spawn. --path pins upstream's WATCHED default project to the
  // guarded root (verified in 1.6.0: the stale banner only fires on the
  // watched default instance, and the shared daemon is keyed per-project —
  // the same way spawnDetachedDaemon itself re-invokes serve). Without a
  // resolved root the boundary still proxies (diagnostics stay reachable)
  // but every gated call refuses with root-unresolved first.
  let upstream = null;
  if (runtime) {
    try {
      const { command, args } = runtime.resolveCodegraphCommand();
      const argv = root
        ? [...args, "serve", "--mcp", "--path", root]
        : [...args, "serve", "--mcp"];
      upstream = spawnUpstreamSeam({
        command,
        argv,
        cwd: root ?? process.cwd(),
        log,
        onLine: (line) => seamHandlers.onLine(line), // retargeted to the boundary below
        onExit: (code, signal) => seamHandlers.onExit(code, signal),
      });
    } catch (err) {
      log(`upstream spawn unavailable: ${String(err?.message ?? err)}`);
    }
  }

  const boundary = createBoundary({
    runtime,
    root,
    rootDetail,
    upstream,
    writeClient: (line) => process.stdout.write(`${line}\n`),
    log,
    config,
    onUpstreamDied: (code) => {
      // Mirror the death so the client restarts a clean pair instead of
      // talking to a backend-less boundary. The typed refusals above were
      // written to a Windows pipe (async flush), so give them a beat before
      // exiting. The detached daemon (if any) is intentionally NOT killed —
      // it is refcounted and shared by design.
      const exitCode = code === 0 ? 1 : (code ?? 1);
      setTimeout(() => process.exit(exitCode), 150);
    },
  });

  // Single spawn, single wiring: retarget the seam's pumps at the boundary.
  seamHandlers.onLine = (line) => boundary.handleUpstreamLine(line);
  seamHandlers.onExit = (code, signal) => boundary.handleUpstreamExit(code, signal);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => void boundary.handleClientLine(line));
  const shutdown = (reason, code = 0) => {
    log(`shutting down: ${reason}`);
    boundary.close();
    // close() resolves in-flight calls as died, and their typed refusals go
    // through the async pipe flush — give them a beat before exiting.
    setTimeout(() => process.exit(code), 100);
  };
  rl.on("close", () => shutdown("stdin closed"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => boundary.close());

  log(
    `on stdio — root=${root ?? "UNRESOLVED"} runtime=${runtime ? "loaded" : "MISSING"} ` +
      `upstream=${upstream ? "spawned" : "none"} gateTimeout=${config.gateTimeoutMs}ms callTimeout=${config.callTimeoutMs}ms`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("server-codegraph.mjs")) {
  void main();
}