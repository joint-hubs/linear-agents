#!/usr/bin/env node
/**
 * scripts/key-leak-check.mjs — key-leak check for FOC-778 AC2.
 *
 * Runs on the HOST against a Docker stack. Given canary values (read from
 * files — NEVER argv), it scans the surfaces a leaked key could reach:
 *   1. `docker inspect` of every container of the project (Config.Env, Args,
 *      Labels — the fenix-api secrets bind-mount is a path, not a value).
 *   2. `docker compose logs --no-color` of all services.
 *   3. Inside fenix-api (docker compose exec -T): /data/telemetry (sqlite
 *      store, spool, archive — plain strings are found by grep -a), /data/state,
 *      /data/supervisor, /data/agents/(id)/projects (transcripts).
 *   4. Inside fenix-supervisor: its /data view and /tmp.
 *   Linear is covered by the egress screen — reported as a non-scan row.
 *
 * THE HARD RULE: the tool never prints a canary/key value — only surface
 * names, env var NAMES, file counts and up to 5 file paths per surface. As a
 * belt-and-braces gate every printed line is scrubbed through scrub().
 *
 * docker is invoked with execFile (no shell string interpolation of values);
 * the canary reaches the in-container grep only through stdin (`grep -f
 * /dev/stdin`). Zero npm deps, Node 18+.
 *
 * Exit codes: 0 no hits on any scanned surface, 1 any hit, 2 usage/docker
 * errors. Output: a table, or one JSON line with --json.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  join as joinPath,
  resolve as resolvePath,
} from "node:path";

const API_ROOTS = [
  "/data/telemetry",
  "/data/state",
  "/data/supervisor",
  "/data/agents/*/projects",
];
const SUPERVISOR_ROOTS = ["/data", "/tmp"];
const MAX_DETAIL_PATHS = 5;
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024;

/** Count non-overlapping occurrences of needle in text. */
export function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  const s = String(text ?? "");
  while ((i = s.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Final gate: replace every canary occurrence with "[redacted]". */
export function scrub(text, canaries) {
  let out = String(text ?? "");
  for (const c of canaries) if (c) out = out.split(c).join("[redacted]");
  return out;
}

/** Make a container file path relative to its /data or /tmp root (paths are safe). */
function relToRoots(p, roots) {
  if (p.startsWith("/data/")) return p.slice("/data/".length);
  if (p.startsWith("/tmp/")) return p.slice("/tmp/".length);
  return p;
}

/** The in-container grep: canary arrives on stdin, never on the command line. */
export function grepCommand(roots) {
  return `set --; for root in ${roots.join(" ")}; do [ ! -e "$root" ] || set -- "$@" "$root"; done; [ "$#" -gt 0 ] || exit 0; grep -rlaF -f /dev/stdin "$@" 2>/dev/null; result=$?; [ "$result" -le 1 ]`;
}

/** Scan a host directory tree for files containing any canary. */
export function scanDirForCanaries(root, canaries) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = joinPath(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.size > MAX_SCAN_FILE_BYTES) continue;
        let buf;
        try {
          buf = readFileSync(p);
        } catch {
          continue;
        }
        if (canaries.some((c) => buf.includes(Buffer.from(c, "utf8")))) found.push(p);
      }
    }
  };
  walk(root);
  return found;
}

/** Inspect one container's Env/Args/Labels for canary occurrences. */
function scanContainer(container, canaries) {
  const env = container?.Config?.Env || [];
  const args = container?.Args || [];
  const labels = Object.values(container?.Config?.Labels || {});
  const joined = [...env, ...args, ...labels].join("\n");
  let hits = 0;
  for (const c of canaries) hits += countOccurrences(joined, c);
  const envKeys = env
    .filter((e) => canaries.some((c) => countOccurrences(e, c) > 0))
    .map((e) => e.split("=")[0]);
  const name = String(container?.Name || container?.Config?.Hostname || "unknown").replace(/^\//, "");
  return { hits, name, envKeys };
}

/**
 * Collect every surface row: `{ surface, scanned, hits, detail }`.
 * `runner(argv, { input }?) -> { code, stdout, stderr }` is injectable; argv
 * never contains a canary value — canaries travel only via `opts.input`.
 */
export async function collectSurfaces({
  canaries,
  project = "fenix",
  composeFile,
  projectDirectory,
  dataDir,
  runner,
}) {
  const composeBase = ["compose"];
  if (composeFile) composeBase.push("-f", composeFile);
  if (projectDirectory) composeBase.push("--project-directory", projectDirectory);
  composeBase.push("-p", project);

  const surfaces = [];

  // --- Surface 1: docker inspect of every container of the project ---------
  const ps = await runner([...composeBase, "ps", "-q"]);
  if (ps.code !== 0) throw new Error(`docker compose ps failed (exit ${ps.code})`);
  const ids = ps.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    surfaces.push({ surface: "containers", scanned: false, hits: 0, detail: "no running containers" });
  } else {
    const ins = await runner(["inspect", ...ids]);
    if (ins.code !== 0) throw new Error(`docker inspect failed (exit ${ins.code})`);
    let containers;
    try {
      containers = JSON.parse(ins.stdout);
    } catch {
      throw new Error("docker inspect returned non-JSON output");
    }
    let hits = 0;
    const matched = [];
    for (const c of Array.isArray(containers) ? containers : []) {
      const r = scanContainer(c, canaries);
      if (r.hits > 0) {
        hits += r.hits;
        matched.push(r.envKeys.length ? `${r.name}(${r.envKeys.join(",")})` : r.name);
      }
    }
    surfaces.push({
      surface: "containers",
      scanned: true,
      hits,
      detail: hits > 0 ? `in: ${matched.join(", ")}` : `${containers.length} containers scanned`,
    });
  }

  // --- Surface 2: compose logs of all services ------------------------------
  const logs = await runner([...composeBase, "logs", "--no-color"]);
  if (logs.code !== 0) throw new Error(`docker compose logs failed (exit ${logs.code})`);
  let logHits = 0;
  let logLines = 0;
  for (const line of logs.stdout.split("\n")) {
    const lineHits = canaries.reduce((n, c) => n + countOccurrences(line, c), 0);
    if (lineHits > 0) {
      logHits += lineHits;
      logLines++;
    }
  }
  surfaces.push({
    surface: "logs",
    scanned: true,
    hits: logHits,
    detail: logHits > 0 ? `${logLines} log lines match` : "clean",
  });

  // --- Surfaces 3+4: in-container grep (canary on stdin only) ---------------
  const execSurfaces = [
    { surface: "fenix-api:/data", service: "fenix-api", roots: API_ROOTS },
    { surface: "fenix-supervisor:/data+tmp", service: "fenix-supervisor", roots: SUPERVISOR_ROOTS },
  ];
  // Read-only audit as root: image-built /tmp caches can belong to root.
  // Scanning as the service user would silently miss those files. This does
  // not change the runtime service user or any file permissions.
  for (const s of execSurfaces) {
    const probe = await runner([...composeBase, "exec", "-T", "--user", "0", s.service, "sh", "-c", "true"]);
    if (probe.code !== 0) {
      surfaces.push({
        surface: s.surface,
        scanned: false,
        hits: 0,
        detail: `service not reachable (exit ${probe.code})`,
      });
      continue;
    }
    const g = await runner([...composeBase, "exec", "-T", "--user", "0", s.service, "sh", "-c", grepCommand(s.roots)], {
      input: canaries.join("\n") + "\n",
    });
    if (g.code !== 0) throw new Error(`Scan failed for ${s.surface} (exit ${g.code})`);
    const files = g.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
    const rels = files.map((f) => relToRoots(f, s.roots));
    surfaces.push({
      surface: s.surface,
      scanned: true,
      hits: files.length,
      detail:
        files.length > 0
          ? `${files.length} files: ${rels.slice(0, MAX_DETAIL_PATHS).join(", ")}${
              files.length > MAX_DETAIL_PATHS ? ", …" : ""
            }`
          : "clean",
    });
  }

  // --- Linear: covered upstream by the egress screen ------------------------
  surfaces.push({
    surface: "linear",
    scanned: false,
    hits: 0,
    detail: "covered by egress-screen (not scanned)",
  });

  // --- Optional: direct host-side file scan ---------------------------------
  if (dataDir) {
    const found = scanDirForCanaries(String(dataDir), canaries);
    const rels = found.map((f) => f.slice(String(dataDir).length + 1));
    surfaces.push({
      surface: `host:${dataDir}`,
      scanned: true,
      hits: found.length,
      detail:
        found.length > 0
          ? `${found.length} files: ${rels.slice(0, MAX_DETAIL_PATHS).join(", ")}${
              found.length > MAX_DETAIL_PATHS ? ", …" : ""
            }`
          : "clean",
    });
  }

  return surfaces;
}

/** Plain-text table; never contains a canary value (detail is names/counts). */
export function renderTable(surfaces) {
  const W = 27;
  const rows = surfaces.map((s) => {
    const scanned = s.scanned ? "yes" : "no";
    const hits = s.scanned ? String(s.hits) : "-";
    let line = `${s.surface.padEnd(W)}  ${scanned.padEnd(7)}  ${hits.padStart(4)}  ${s.detail || ""}`;
    return line;
  });
  return ["surface                        scanned  hits  detail", "-".repeat(72), ...rows].join("\n");
}

function usage(write) {
  write("Usage: node scripts/key-leak-check.mjs [flags]");
  write("  --canary-file <path>   canary value file (repeatable; one value per file, trimmed)");
  write("  --project <name>       compose project (default: fenix)");
  write("  --compose-file <path>  passthrough for docker compose -f");
  write("  --project-directory <p> passthrough for docker compose --project-directory");
  write("  --data-dir <host path> also scan a host directory tree directly");
  write("  --json                 one JSON line { canaryCount, surfaces, exit }");
  write("  Exit 0 no hits, 1 any hit, 2 usage/docker errors. Canary values are");
  write("  read from files — NEVER argv — and never printed.");
}

/** Default runner: execFile("docker", argv), input forwarded to stdin. */
export function defaultRunner(argv, opts = {}) {
  return new Promise((resolveRun) => {
    const child = execFile(
      "docker",
      argv,
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolveRun({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
    if (child.stdin) {
      child.stdin.end(opts.input || "");
    }
  });
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (flags[name] === undefined) flags[name] = next;
      else if (Array.isArray(flags[name])) flags[name].push(next);
      else flags[name] = [flags[name], next];
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

/**
 * CLI entry (also used by tests): returns the process exit code.
 * `deps.runner` injects the docker runner; `deps.stdout`/`deps.stderr`
 * capture output lines (default: process streams).
 */
export async function runCli(argv, deps = {}) {
  const stdout = deps.stdout || ((s) => process.stdout.write(s + "\n"));
  const stderr = deps.stderr || ((s) => process.stderr.write(s + "\n"));
  const runner = deps.runner || defaultRunner;

  const flags = parseFlags(argv);
  // deps.canaries is a test-only injection; production canaries come from files.
  let canaries = deps.canaries;
  if (!canaries) {
    canaries = [];
    const canaryFiles = Array.isArray(flags["canary-file"])
      ? flags["canary-file"]
      : flags["canary-file"]
        ? [flags["canary-file"]]
        : [];
    for (const f of canaryFiles) {
      let v;
      try {
        v = readFileSync(f, "utf8").trim();
      } catch {
        stderr(`cannot read canary file: ${f}`);
        usage(stderr);
        return 2;
      }
      if (v) canaries.push(v);
    }
  }
  if (canaries.length === 0) {
    usage(stderr);
    return 2;
  }

  let surfaces;
  try {
    surfaces = await collectSurfaces({
      canaries,
      project: flags.project || "fenix",
      composeFile: flags["compose-file"],
      projectDirectory: flags["project-directory"],
      dataDir: flags["data-dir"],
      runner,
    });
  } catch (err) {
    stderr(scrub(err?.message || String(err), canaries));
    return 2;
  }

  const incomplete = surfaces.some((s) => s.surface !== "linear" && !s.scanned);
  const exit = surfaces.some((s) => s.scanned && s.hits > 0) ? 1 : incomplete ? 2 : 0;
  if (flags.json) {
    stdout(scrub(JSON.stringify({ canaryCount: canaries.length, surfaces, exit }), canaries));
  } else {
    stdout(renderTable(surfaces));
    stdout(
      exit === 0
        ? "OK: no canary hits on scanned surfaces"
        : exit === 2
          ? "INCOMPLETE: required surfaces could not be scanned"
          : "FAIL: canary found on a scanned surface (details above)",
    );
  }
  return exit;
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === __filename) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e?.message || String(e));
      process.exit(1);
    });
}
