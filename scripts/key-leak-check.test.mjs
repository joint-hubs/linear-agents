#!/usr/bin/env node
/**
 * Tests for scripts/key-leak-check.mjs (FOC-778 AC2).
 *
 * A fake docker runner returns canned stdout per argv — no real Docker.
 * Asserted invariants: per-surface hit counting, exit codes (0/1/2), the
 * canary value NEVER appears in stdout/stderr/JSON output, the canary reaches
 * the in-container grep only via stdin (argv never contains it), and a
 * missing canary file exits 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
  collectSurfaces,
  grepCommand,
  runCli,
  countOccurrences,
} from "./key-leak-check.mjs";

const CANARY = "CANARY-SECRET-9f3a7b-DO-NOT-PRINT";
const CANARY2 = "sk-or-CANARY-SECOND-VALUE-77";

/** Fake docker runner: routes matched by predicate, records all calls. */
function fakeRunner(routes = []) {
  const calls = [];
  const fn = async (argv, opts = {}) => {
    calls.push({ argv, opts });
    for (const r of routes) {
      if (r.match(argv, opts)) {
        return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

// argv matchers against the runner's argv (the "docker" binary is implied)
const isPs = (a) => a[0] === "compose" && a.includes("ps") && a.includes("-q");
const isInspect = (a) => a[0] === "inspect";
const isLogs = (a) => a.includes("logs") && a.includes("--no-color");
const isApiGrep = (a) => a.includes("exec") && a.includes("fenix-api") && /grep/.test(a.at(-1));
const isApiProbe = (a) => a.includes("exec") && a.includes("fenix-api") && a.at(-1) === "true";
const isSupGrep = (a) =>
  a.includes("exec") && a.includes("fenix-supervisor") && /grep/.test(a.at(-1));

function containerFixture(overrides = {}) {
  return {
    Name: "/fenix-api-1",
    Config: {
      Env: ["PATH=/usr/local/bin", "HOME=/root"],
      Labels: { "com.docker.compose.service": "fenix-api" },
      Hostname: "fenix-api-1",
    },
    Args: [],
    ...overrides,
  };
}

test("countOccurrences counts non-overlapping matches", () => {
  assert.equal(countOccurrences("aXbXc", "X"), 2);
  assert.equal(countOccurrences("aaa", "aa"), 1);
  assert.equal(countOccurrences("abc", ""), 0);
});

test("grep command puts patterns on stdin (-f /dev/stdin) and includes roots", () => {
  const cmd = grepCommand(["/data/state", "/tmp"]);
  assert.match(cmd, /for root in \/data\/state \/tmp/);
  assert.match(cmd, /grep -rlaF -f \/dev\/stdin/);
  assert.doesNotMatch(cmd, /CANARY/);
});

test("collectSurfaces: zero hits → all scanned surfaces clean, linear is a non-scan row", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: isLogs, stdout: "fenix-api-1 | all quiet\n" },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  const byName = Object.fromEntries(surfaces.map((s) => [s.surface, s]));
  assert.equal(byName.containers.scanned, true);
  assert.equal(byName.containers.hits, 0);
  assert.equal(byName.logs.scanned, true);
  assert.equal(byName.logs.hits, 0);
  assert.equal(byName["fenix-api:/data"].scanned, true);
  assert.equal(byName["fenix-api:/data"].hits, 0);
  assert.equal(byName["fenix-supervisor:/data+tmp"].scanned, true);
  assert.equal(byName.linear.scanned, false);
  assert.match(byName.linear.detail, /egress-screen/);
});

test("collectSurfaces: hit in Config.Env counts and detail names the env KEY, not the value", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    {
      match: isInspect,
      stdout: JSON.stringify([
        containerFixture({ Config: { Env: [`FENIX_PROVIDER_KEY=${CANARY}`], Labels: {} } }),
        containerFixture({ Name: "/fenix-supervisor-1" }),
      ]),
    },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  const containers = surfaces.find((s) => s.surface === "containers");
  assert.equal(containers.hits, 1);
  assert.match(containers.detail, /fenix-api-1/);
  assert.match(containers.detail, /FENIX_PROVIDER_KEY/);
  assert.doesNotMatch(containers.detail, /9f3a7b/);
});

test("collectSurfaces: hits in Args and Labels are counted", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    {
      match: isInspect,
      stdout: JSON.stringify([
        containerFixture({
          Args: ["--token", CANARY],
          Config: { Env: [], Labels: { note: `leak=${CANARY}` } },
        }),
      ]),
    },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  assert.equal(surfaces.find((s) => s.surface === "containers").hits, 2);
});

test("collectSurfaces: log hits are counted as matching LINES, never echoed", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: isLogs, stdout: `a | ok\nb | key=${CANARY}\nc | still ${CANARY} here\n` },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  const logs = surfaces.find((s) => s.surface === "logs");
  assert.equal(logs.hits, 2);
  assert.match(logs.detail, /2 log lines/);
});

test("collectSurfaces: in-container grep reports a file COUNT and relative paths", async () => {
  const runner = fakeRunner([
    { match: isApiProbe, code: 0 },
    {
      match: isApiGrep,
      stdout: [
        "/data/telemetry/store.db",
        "/data/state/supervisor/registry.json",
        "/data/agents/dev-1/projects/transcript.jsonl",
        "/data/state/ledger-2.jsonl",
        "/data/telemetry/spool/a.json",
        "/data/state/6th-file",
      ].join("\n"),
    },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  const api = surfaces.find((s) => s.surface === "fenix-api:/data");
  assert.equal(api.hits, 6);
  assert.match(api.detail, /^6 files: /);
  assert.match(api.detail, /telemetry\/store\.db/);
  assert.match(api.detail, /agents\/dev-1\/projects\/transcript\.jsonl/);
  assert.ok(api.detail.split(",").length - 1 <= 5, "at most 5 paths listed");
});

test("collectSurfaces: canary reaches the container grep ONLY via stdin", async () => {
  const runner = fakeRunner([
    { match: isApiProbe, code: 0 },
    { match: isApiGrep, stdout: "" },
    { match: isSupGrep, stdout: "" },
  ]);
  await collectSurfaces({ canaries: [CANARY, CANARY2], runner });
  for (const { argv, opts } of runner.calls) {
    assert.doesNotMatch(argv.join(" "), /9f3a7b|SECOND-VALUE/, "argv must not contain canaries");
    if (isApiGrep(argv) || isSupGrep(argv)) {
      assert.match(argv.at(-1), /-f \/dev\/stdin/);
      assert.equal(opts.input, `${CANARY}\n${CANARY2}\n`, "canaries delivered on stdin");
    }
  }
});

test("collectSurfaces: unreachable fenix-supervisor → scanned:false, not fatal", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: isLogs, stdout: "" },
    { match: isApiProbe, code: 0 },
    { match: isApiGrep, stdout: "" },
    { match: (a) => a.includes("fenix-supervisor"), code: 1 },
  ]);
  const surfaces = await collectSurfaces({ canaries: [CANARY], runner });
  const sup = surfaces.find((s) => s.surface === "fenix-supervisor:/data+tmp");
  assert.equal(sup.scanned, false);
  assert.match(sup.detail, /not reachable/);
});

test("collectSurfaces: --data-dir host scan counts files containing the canary", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "leak-check-"));
  try {
    writeFileSync(joinPath(dir, "a.txt"), `hello ${CANARY} world\n`);
    writeFileSync(joinPath(dir, "b.txt"), "clean\n");
    const runner = fakeRunner([{ match: isPs, code: 0 }, { match: isLogs, stdout: "" }]);
    const surfaces = await collectSurfaces({ canaries: [CANARY], runner, dataDir: dir });
    const host = surfaces.find((s) => s.surface === `host:${dir}`);
    assert.equal(host.scanned, true);
    assert.equal(host.hits, 1);
    assert.match(host.detail, /a\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: zero hits → exit 0 and canary never in output", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: isLogs, stdout: "fine\n" },
  ]);
  const out = [];
  const err = [];
  const code = await runCli([], { canaries: [CANARY], runner, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  assert.equal(code, 0);
  assert.doesNotMatch(out.join("\n") + err.join("\n"), /9f3a7b/);
});

test("runCli: a hit → exit 1; canary never in stdout/stderr/table/JSON", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    {
      match: isInspect,
      stdout: JSON.stringify([containerFixture({ Config: { Env: [`K=${CANARY}`], Labels: {} } })]),
    },
    { match: isLogs, stdout: `x ${CANARY2} y\n` },
    { match: isApiProbe, code: 0 },
    { match: isApiGrep, stdout: "" },
  ]);
  let jsonOut = [];
  for (const extra of [[], ["--json"]]) {
    const out = [];
    const err = [];
    const code = await runCli(extra, {
      canaries: [CANARY, CANARY2],
      runner,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    assert.equal(code, 1, `exit 1 with args ${JSON.stringify(extra)}`);
    const everything = out.join("\n") + err.join("\n");
    assert.doesNotMatch(everything, /9f3a7b/, "canary 1 leaked into output");
    assert.doesNotMatch(everything, /SECOND-VALUE/, "canary 2 leaked into output");
    jsonOut = out;
  }
  const json = JSON.parse(jsonOut.at(-1));
  assert.equal(json.canaryCount, 2);
  assert.equal(json.exit, 1);
  assert.ok(Array.isArray(json.surfaces) && json.surfaces.length >= 5);
});

test("runCli: no canary file / unreadable canary file → exit 2 with usage", async () => {
  const runner = fakeRunner();
  const err = [];
  const code = await runCli(["--canary-file", "Z:/definitely/missing/path.txt"], {
    runner,
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  assert.equal(code, 2);
  assert.match(err.join("\n"), /cannot read canary file/);
  assert.match(err.join("\n"), /Usage/);
  const empty = mkdtempSync(joinPath(tmpdir(), "leak-check-"));
  try {
    writeFileSync(joinPath(empty, "blank.txt"), "   \n");
    const code2 = await runCli(["--canary-file", joinPath(empty, "blank.txt")], {
      runner,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    assert.equal(code2, 2);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("runCli: docker infra failure (compose ps) → exit 2", async () => {
  const runner = fakeRunner([{ match: isPs, code: 125 }]);
  const out = [];
  const code = await runCli([], {
    canaries: [CANARY],
    runner,
    stdout: (s) => out.push(s),
    stderr: (s) => out.push(s),
  });
  assert.equal(code, 2);
  assert.match(out.join("\n"), /docker compose ps failed/);
});

test("runCli: reads canaries from real files and flags pass through to compose argv", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "leak-check-"));
  try {
    const f1 = joinPath(dir, "c1.txt");
    writeFileSync(f1, `  ${CANARY}  \n`); // trimmed
    const runner = fakeRunner([
      { match: isPs, stdout: "id1\n" },
      { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
      { match: isLogs, stdout: "" },
    ]);
    const out = [];
    const code = await runCli(
      ["--canary-file", f1, "--compose-file", "compose.yaml", "--project-directory", "/x", "--project", "fenix"],
      { runner, stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
    );
    assert.equal(code, 0);
    const psCall = runner.calls.find((c) => isPs(c.argv));
    assert.deepEqual(psCall.argv.slice(0, 8), [
      "compose",
      "-f",
      "compose.yaml",
      "--project-directory",
      "/x",
      "-p",
      "fenix",
      "ps",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("runCli refuses a clean result when a required container surface is unavailable", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: (a) => a.includes("fenix-supervisor"), code: 1 },
  ]);
  const out = [];
  const code = await runCli([], { canaries: [CANARY], runner, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
  assert.equal(code, 2);
  assert.match(out.join("\n"), /INCOMPLETE/);
  assert.doesNotMatch(out.join("\n"), /OK: no canary/);
});

test("a failed container grep is an infrastructure error, not an empty clean scan", async () => {
  const runner = fakeRunner([
    { match: isPs, stdout: "abc123\n" },
    { match: isInspect, stdout: JSON.stringify([containerFixture()]) },
    { match: isApiGrep, code: 2, stderr: "unreadable fixture" },
  ]);
  const code = await runCli([], { canaries: [CANARY], runner, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 2);
});
