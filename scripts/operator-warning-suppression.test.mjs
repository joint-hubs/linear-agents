// scripts/operator-warning-suppression.test.mjs — FOC-1055: the operator-facing
// CLIs run with `--disable-warning=ExperimentalWarning`, the test suite does not.
//
// `node:sqlite` is experimental and prints `ExperimentalWarning` on stderr the
// moment a helper opens the store. In `fenix doctor` that lands in the middle of
// the OK/WARN/FAIL report. The fix is at the launch boundary (the `fenix`
// launcher, `docker/entrypoint.sh`'s operator cases, and the `bin/*.bat` squad
// wrappers) — never in the scripts themselves, because the same scripts run
// inside the suite and there the warnings are wanted on purpose.
//
// Run: node scripts/operator-warning-suppression.test.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAG = "--disable-warning=ExperimentalWarning";

// Scripts the operator runs as a report/tool and whose output must stay free of
// Node's experimental noise. The suite runner is deliberately NOT in this list.
const OPERATOR_ENTRYPOINTS = [
  "scripts/fenix-doctor.mjs",
  "scripts/supervisor-cleanup.mjs",
  "scripts/agent-tools.mjs",
  "scripts/fenix-projects.mjs",
];

// Suite runners — these must keep Node's warnings, per the ticket ("keep
// warnings in the suite"). A test that watches a CLI child's stderr depends on
// the ExperimentalWarning being there (see agent-state*.test.mjs).
const SUITE_RUNNERS = ["docker/test-in-container.sh", "scripts/test-run.mjs"];

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => {
  throw new Error(msg);
};
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ── 1. The launchers carry the flag ──────────────────────────────────────────
console.log("\nlauncher scripts carry the flag");

test("docker/entrypoint.sh: every operator-facing node call carries the flag", () => {
  const text = read("docker/entrypoint.sh");
  for (const script of OPERATOR_ENTRYPOINTS) {
    // Find the node line that runs this script and require the flag before it.
    const re = new RegExp(
      String.raw`(?:^|\n)\s*(?:exec\s+)?node\s+${FLAG}\s+(?:"\$LA_ROOT/)?${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "m",
    );
    if (!re.test(text)) {
      fail(`docker/entrypoint.sh: ${script} is not launched with ${FLAG}`);
    }
  }
});

test("docker/entrypoint.sh: the suite runners stay unflagged", () => {
  // The entrypoint itself has no suite runner, but a future move of
  // test-in-container.sh behind it must not silently quiet the suite. This
  // assertion is on the suite runner files themselves, below; here we only
  // assert the entrypoint does not export a blanket NODE_OPTIONS.
  const text = read("docker/entrypoint.sh");
  if (/^\s*(export\s+)?NODE_OPTIONS=/m.test(text)) {
    fail("docker/entrypoint.sh exports NODE_OPTIONS — that would silence every node, suite included");
  }
});

test("the fenix launcher: in_container_node carries the flag", () => {
  const text = read("fenix");
  const re = new RegExp(
    String.raw`docker compose run --rm --no-deps -T --entrypoint node fenix-api ${FLAG} "/opt/fenix/\$script"`,
  );
  if (!re.test(text)) {
    fail(`fenix: in_container_node does not pass ${FLAG} to node`);
  }
});

test("the fenix launcher: cmd_doctor reaches the container through the flag", () => {
  // cmd_doctor delegates to $ENTRYPOINT doctor inside fenix-api; the container's
  // entrypoint (checked above) carries the flag for the doctor case. What this
  // launcher must not do is spawn a bare `node` doctor of its own.
  const text = read("fenix");
  if (/^\s*node\s+scripts\/fenix-doctor\.mjs/m.test(text)) {
    fail("fenix: a bare `node scripts/fenix-doctor.mjs` escaped the flagged entrypoint");
  }
});

test("every bin/*.bat squad wrapper carries the flag before squad-start.mjs", () => {
  const bin = join(ROOT, "bin");
  const bad = [];
  for (const f of readdirSync(bin).filter((n) => n.endsWith(".bat"))) {
    const text = read(join("bin", f));
    const nodeLines = text
      .split(/\r?\n/)
      .filter((l) => /^\s*node\s+/.test(l) && /squad-start\.mjs/.test(l));
    for (const line of nodeLines) {
      if (!line.includes(FLAG)) bad.push(`${f}: ${line.trim()}`);
    }
  }
  if (bad.length) {
    fail(`squad wrapper node lines missing ${FLAG}:\n       ${bad.join("\n       ")}`);
  }
});

// ── 2. The suite keeps its warnings ─────────────────────────────────────────
console.log("\nsuite runners keep Node's warnings");

for (const runner of SUITE_RUNNERS) {
  test(`${runner} does not carry ${FLAG}`, () => {
    if (!existsSync(join(ROOT, runner))) {
      fail(`${runner} is gone — the suite entry point changed, update this test`);
    }
    const text = read(runner);
    if (text.includes(FLAG)) {
      fail(`${runner} carries ${FLAG} — the suite must keep experimental warnings`);
    }
    if (/^\s*(export\s+)?NODE_OPTIONS=.*disable-warning/m.test(text)) {
      fail(`${runner} sets NODE_OPTIONS with disable-warning — same effect as the flag`);
    }
  });
}

test("scripts/test-run.mjs does not disable warnings", () => {
  const text = read("scripts/test-run.mjs");
  if (text.includes("disable-warning")) {
    fail("scripts/test-run.mjs mentions disable-warning — the suite must keep its warnings");
  }
});

// ── 3. Live: the flag silences node:sqlite's ExperimentalWarning ────────────
console.log("\nlive doctor output");

const doctor = join(ROOT, "scripts", "fenix-doctor.mjs");

if (!existsSync(doctor)) {
  console.log("  SKIP live doctor check — scripts/fenix-doctor.mjs not on disk");
} else {
  test("the flagged doctor prints no ExperimentalWarning", () => {
    const r = spawnSync(process.execPath, [FLAG, doctor], { encoding: "utf8", timeout: 120000 });
    if (r.status !== 0) {
      fail(`exit ${r.status}\n       stderr: ${r.stderr}`);
    }
    if (/ExperimentalWarning/.test(r.stderr ?? "")) {
      fail(`flagged doctor still warns:\n       ${(r.stderr ?? "").slice(0, 400)}`);
    }
    if (!/^OK\s|WARN\s|FAIL\s/m.test(r.stdout ?? "")) {
      fail(`no OK/WARN/FAIL report on stdout:\n       ${(r.stdout ?? "").slice(0, 400)}`);
    }
  });

  test("the bare doctor still warns (the suite's view of the same code)", () => {
    const r = spawnSync(process.execPath, [doctor], { encoding: "utf8", timeout: 120000 });
    if (r.status !== 0) {
      fail(`exit ${r.status}\n       stderr: ${r.stderr}`);
    }
    if (!/ExperimentalWarning/.test(r.stderr ?? "")) {
      fail("the bare doctor no longer warns — the suite's stderr assertions would rot");
    }
  });
}

// ── summary ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nOK: ${passed} checks passed`);
