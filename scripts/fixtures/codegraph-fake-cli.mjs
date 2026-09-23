// scripts/fixtures/codegraph-fake-cli.mjs — a fake `codegraph` CLI for the
// focused test suites. Two consumers with one contract:
//
//   · code-intel.test.mjs — pins that the wrapper addresses ONE root for
//     baseline/status/sync/query (the log is the evidence; the real CLI has
//     no such log and a wrong root answers confidently, which is the bug).
//   · supervisor-spawn.test.mjs — exercises the launch-readiness preflight
//     (init/status/sync against a child worktree) without indexing a real
//     repo, which `initialize: true` would otherwise do to every fixture.
//
// makeFakeCodegraphCli({ dir, mode, logPath }) writes a shim directory to
// PREPEND to PATH, carrying ONLY the shim the current platform resolves (a
// bare POSIX `codegraph` in the same dir would win PATH order on win32 —
// `where` lists it first — and a shell script is not a spawnable PE there):
//   win32: <dir>/codegraph.cmd — must carry `"%~dp0fake-cli.js"` in exactly
//          the shape resolveCodegraphCommand unwraps (node.exe + JS entry,
//          shell:false); the fake never needs cmd.exe to run it, but the
//          UNWRAP must succeed, because that is the path production takes.
//   POSIX: <dir>/codegraph — shebang, +x, spawned directly.
//   <dir>/fake-cli.js — the handler. Reads behavior from the environment so
//                        one physical template serves every test:
//     FAKE_CODEGRAPH_MODE  ready     status: initialized, pending 0, lastIndexed
//                                   in the future, extraction schema consistent
//                          dirty     pending 1 while <root>/.codegraph/fake-dirty
//                                   exists; `sync` clears the marker — the
//                                   settle-then-answer path, end to end
//                          degraded  pending 1 forever; sync exits 0 but the
//                                   counts never settle (pending-after-sync)
//                          schema    status reports a schema-stale `index`
//                                   block (reindexRecommended=true, extraction
//                                   pair mismatched, state partial, a ref
//                                   pending) while <root>/.codegraph/fake-schema-ok
//                                   is absent; `init` and `index` write that
//                                   marker (a fresh build lands on the current
//                                   schema), `sync` deliberately does NOT —
//                                   a schema gap is closed by a rebuild, not
//                                   a sync
//                          hang      status/sync answer normally, but QUERY
//                                   verbs never answer (they outlive any
//                                   sane budget) — pins that a bounded caller
//                                   times out into UNKNOWN instead of hanging
//     FAKE_CODEGRAPH_LOG   append one JSON line per invocation: {cmd, args}
//
// Index state lives in the TARGET root (<root>/.codegraph/fake-initialized),
// written by `init`/`index`, read by `status` — so "is there an index" is a
// real property of the root under test, not of the fake's own directory.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HANDLER = `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODE = process.env.FAKE_CODEGRAPH_MODE ?? "ready";
const LOG = process.env.FAKE_CODEGRAPH_LOG;
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

// codegraph takes the root as the FIRST positional; flags may follow.
const rootArg = rest.find((a) => !a.startsWith("-"));
const log = (out) => {
  const line = JSON.stringify({ cmd, args: rest });
  if (LOG) appendFileSync(LOG, line + "\\n");
  return out;
};

if (cmd === "init" && rest.includes("--help")) {
  log();
  // The installed 1.6.0 help shape — the runtime discovers -y from this.
  process.stdout.write("Usage: codegraph init [options] [path]\\n  -y, --yes   skip prompts\\n");
  process.exit(0);
}

if (cmd === "status") {
  log();
  const initialized = existsSync(join(rootArg, ".codegraph", "fake-initialized"));
  if (!initialized) {
    process.stdout.write(JSON.stringify({ version: "fake-1.6.0", initialized: false }));
    process.exit(0);
  }
  const dirty = MODE === "dirty" && existsSync(join(rootArg, ".codegraph", "fake-dirty"));
  const pending = MODE === "degraded" || dirty ? { added: 1, modified: 0, removed: 0 } : { added: 0, modified: 0, removed: 0 };
  // A schema gap only while the marker is absent: init/index clear it, sync
  // never does (a rebuild closes a schema gap; a sync cannot).
  const schemaStale = MODE === "schema" && !existsSync(join(rootArg, ".codegraph", "fake-schema-ok"));
  process.stdout.write(
    JSON.stringify({
      version: "fake-1.6.0",
      initialized: true,
      pendingChanges: pending,
      // 1h in the future: never triggers a time-based staleness sync.
      lastIndexed: new Date(Date.now() + 3_600_000).toISOString(),
      worktreeMismatch: null,
      ...(schemaStale
        ? {
            index: {
              builtWithVersion: "fake-1.6.0",
              builtWithExtractionVersion: 23,
              currentExtractionVersion: 24,
              reindexRecommended: true,
              state: "partial",
              pendingRefs: 1,
            },
          }
        : {
            index: {
              builtWithVersion: "fake-1.6.0",
              builtWithExtractionVersion: 24,
              currentExtractionVersion: 24,
              reindexRecommended: false,
              state: "complete",
              pendingRefs: 0,
            },
          }),
    }),
  );
  process.exit(0);
}

// A FULL rebuild (the installed 1.5's own index --help: "Rebuild the full
// index from scratch (same result as a fresh init)") — lands on the current
// extraction schema and clears any dirt, unlike a sync.
if (cmd === "index") {
  log();
  mkdirSync(join(rootArg, ".codegraph"), { recursive: true });
  writeFileSync(join(rootArg, ".codegraph", "fake-initialized"), "fake\\n");
  writeFileSync(join(rootArg, ".codegraph", "fake-schema-ok"), "ok\\n");
  rmSync(join(rootArg, ".codegraph", "fake-dirty"), { force: true });
  process.stdout.write("fake full index ok\\n");
  process.exit(0);
}

if (cmd === "init") {
  log();
  mkdirSync(join(rootArg, ".codegraph"), { recursive: true });
  writeFileSync(join(rootArg, ".codegraph", "fake-initialized"), "fake\\n");
  writeFileSync(join(rootArg, ".codegraph", "fake-schema-ok"), "ok\\n");
  process.stdout.write("fake init ok\\n");
  process.exit(0);
}

if (cmd === "sync") {
  log();
  if (MODE === "dirty") rmSync(join(rootArg, ".codegraph", "fake-dirty"), { force: true });
  process.stdout.write("fake sync ok\\n");
  process.exit(0);
}

// query verbs (node/explore/callers/...) — print an answer naming the args, so
// a test can pin WHICH root and symbol the wrapper actually asked about.
log();
if (MODE === "hang") {
  // Never answer: a bounded caller must kill the spawn and report UNKNOWN, a
  // caller without a budget must still not wait forever. 30s, not eternity.
  setTimeout(() => process.exit(3), 30_000);
} else {
  process.stdout.write("fake-codegraph-answer " + args.join(" ") + "\\n");
  process.exit(0);
}
`;

/**
 * Write the fake CLI into `dir` and return it (the directory to prepend to PATH).
 */
export function makeFakeCodegraphCli({ dir, mode = "ready", logPath = null } = {}) {
  mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    // Never executed — resolveCodegraphCommand unwraps it to node.exe +
    // fake-cli.js — but the "%~dp0<file>.js" shape must parse.
    writeFileSync(
      join(dir, "codegraph.cmd"),
      ['@echo off', 'node "%~dp0fake-cli.js" %*'].join("\r\n") + "\r\n",
    );
  } else {
    // Spawned directly, so it needs the shebang and the exec bit.
    writeFileSync(
      join(dir, "codegraph"),
      '#!/bin/sh\nexec node "$(dirname "$0")/fake-cli.js" "$@"\n',
      { mode: 0o755 },
    );
  }
  writeFileSync(join(dir, "fake-cli.js"), HANDLER);

  if (logPath) writeFileSync(logPath, "");
  return {
    dir,
    env: {
      FAKE_CODEGRAPH_MODE: mode,
      ...(logPath ? { FAKE_CODEGRAPH_LOG: logPath } : {}),
    },
    // Read the invocation log back as parsed JSON lines.
    readLog: (readFileSync) => {
      try {
        return readFileSync(logPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
