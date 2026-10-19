#!/usr/bin/env node
// scripts/vm-sampler-report.test.mjs — FOC-809 slice A: unit tests for the VM sampler report.
//
// isolation: mkdtemp/tmpdir fixtures only (a fixture registry's children.json and marks.jsonl
// under a temp dir); pure unit tests over literal sample vectors; no child processes, no docker,
// no ports, no real-repo-path writes, no telemetry DB.
//
// Run: node scripts/test-run.mjs vm-sampler

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildReport,
  loadMarks,
  loadRegistryTurns,
  percentile,
  phaseOf,
  renderMarkdown,
} from "./vm-sampler-report.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

// ── the fixture ──────────────────────────────────────────────────────────────

// 12 samples one minute apart from 2026-10-19T10:00:00Z (10:00 … 10:11). The supervisor
// container carries cpu 12 on the 10:01 sample only (everywhere else cpu 1 < threshold 5);
// mem_used_mb climbs 1000 + i × 100 so the dev-child band is hand-checkable.
const T = (hhmm) => `2026-10-19T${hhmm}:00Z`;
const samples = [];
for (let i = 0; i < 12; i++) {
  samples.push({
    ts: T(`10:${String(i).padStart(2, "0")}`),
    load1: 0.1 + i / 100,
    load5: 0.2 + i / 200,
    mem_used_mb: 1000 + i * 100,
    mem_avail_mb: 5000,
    mem_cache_mb: 700,
    disk_used_mb: 9000,
    containers: [
      { name: "fenix-fenix-supervisor-1", cpu_pct: i === 1 ? 12 : 1, mem_mb: 200 + i },
      { name: "fenix-fenix-api-1", cpu_pct: 0.2, mem_mb: 90 },
    ],
    claude_procs: 1,
    top_rss: [{ rss_mb: 180.2, comm: "claude" }],
  });
}

// Fixture registry on disk: one run with a closed dev-1 turn (10:03–10:06), an exited test-1
// child whose turn started 10:08 and ended 10:09, and a plan-1 child whose turn is still open
// (no endedAt) from 10:14 — open turns match any later sample.
const registryDir = mkdtempSync(path.join(tmpdir(), "vm-sampler-test-"));
mkdirSync(path.join(registryDir, "run-a"), { recursive: true });
writeFileSync(
  path.join(registryDir, "run-a", "children.json"),
  JSON.stringify({
    children: {
      "dev-1": { childId: "dev-1", squad: "dev", status: "running", turns: [{ startedAt: T("10:03"), endedAt: T("10:06") }] },
      "test-1": { childId: "test-1", squad: "test", status: "exited", turns: [{ startedAt: T("10:08"), endedAt: T("10:09") }] },
      "plan-1": { childId: "plan-1", squad: "plan", status: "running", turns: [{ startedAt: T("10:14") }] },
    },
  }),
);
writeFileSync(
  path.join(registryDir, "marks.jsonl"),
  `${JSON.stringify({ ts: T("10:10"), phase: "image-build", event: "start" })}\n${JSON.stringify({ ts: T("10:11"), phase: "image-build", event: "end" })}\n`,
);

const turns = loadRegistryTurns(registryDir);
const marks = loadMarks(path.join(registryDir, "marks.jsonl"));
const ctx = { marks, turns, threshold: 5 };

// ── the tests ────────────────────────────────────────────────────────────────

test("percentile: [1..5] interpolates linearly (p20 1.8, p50 3, p80 4.2)", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 20), 1.8);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 80), 4.2);
});

test("percentile: empty vector → null, single value → that value", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 20), 7);
  assert.equal(percentile([7], 90), 7);
});

test("phaseOf: mark windows, child turns, supervisor cpu, idle — first match wins", () => {
  const phase = (i) => phaseOf(samples[i], ctx);
  assert.equal(phase(0), "idle"); // 10:00
  assert.equal(phase(1), "supervisor-active"); // 10:01 — supervisor cpu 12 >= 5
  assert.equal(phase(2), "idle"); // 10:02 — cpu 1 < 5
  for (let i = 3; i <= 6; i++) assert.equal(phase(i), "dev-child"); // dev-1 turn 10:03–10:06
  assert.equal(phase(7), "idle"); // 10:07 — between turns
  for (let i = 8; i <= 9; i++) assert.equal(phase(i), "test-child"); // test-1 turn 10:08–10:09
  for (let i = 10; i <= 11; i++) assert.equal(phase(i), "image-build"); // mark window 10:10–10:11
});

test("phaseOf: an open turn (endedAt absent) matches any later sample", () => {
  const openTurns = [{ runId: "run-a", childId: "plan-1", squad: "plan", startedAt: T("10:14"), endedAt: undefined }];
  assert.equal(phaseOf({ ts: T("10:15"), containers: [] }, { turns: openTurns }), "plan-child");
});

test("buildReport: counts per phase and thin flags", () => {
  const report = buildReport(samples, ctx);
  // recount over the fixture: 10:00 idle, 10:01 supervisor-active, 10:02 idle, 10:03–10:06
  // dev-child, 10:07 idle, 10:08–10:09 test-child, 10:10–10:11 image-build
  // → idle 3 (not 4 — the plan sketched one idle sample too many), supervisor-active 1,
  //   dev-child 4, test-child 2, image-build 2 = 12 samples
  assert.equal(report.phases.idle.n, 3);
  assert.equal(report.phases["supervisor-active"].n, 1);
  assert.equal(report.phases["dev-child"].n, 4);
  assert.equal(report.phases["test-child"].n, 2);
  assert.equal(report.phases["image-build"].n, 2);
  assert.deepEqual(report.thin, ["dev-child", "idle", "image-build", "supervisor-active", "test-child"]);
});

test("buildReport: mem_used_mb band for dev-child, hand-computed", () => {
  // samples 10:03–10:06 carry mem_used_mb 1300 / 1400 / 1500 / 1600 (1000 + i × 100, i = 3…6);
  // sorted [1300, 1400, 1500, 1600], rank = p/100 × 3:
  //   p20 → rank 0.6 → 1300 + 100 × 0.6 = 1360;  p50 → rank 1.5 → 1450;
  //   p80 → rank 2.4 → 1540; peak = max = 1600
  const report = buildReport(samples, ctx);
  assert.deepEqual(report.phases["dev-child"].metrics.mem_used_mb, {
    n: 4,
    p20: 1360,
    p50: 1450,
    p80: 1540,
    peak: 1600,
  });
});

test("renderMarkdown: header row and a dev-child row", () => {
  const md = renderMarkdown(buildReport(samples, ctx));
  assert.ok(md.includes("| phase | metric | n | p20 | p50 | p80 | peak |"), "header row");
  assert.match(md, /^\| dev-child \| mem_used_mb \| 4 \| 1360\.0 \| 1450\.0 \| 1540\.0 \| 1600\.0 \|$/m);
});

test("loadRegistryTurns: skips a corrupt children.json without throwing", () => {
  mkdirSync(path.join(registryDir, "run-bad"), { recursive: true });
  writeFileSync(path.join(registryDir, "run-bad", "children.json"), "{ not json");
  const all = loadRegistryTurns(registryDir);
  assert.equal(all.length, 3); // dev-1, test-1, plan-1 — run-bad silently skipped
  assert.ok(all.every((t) => t.runId !== "run-bad"));
});

// ── cleanup + summary ────────────────────────────────────────────────────────

rmSync(registryDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}