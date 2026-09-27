// scripts/utils.test.mjs — FOC-600: atomicWriteJSON survives transient
// Windows EPERM/EACCES on rename.
//
// On Windows, renameSync over an existing destination fails transiently with
// EPERM/EACCES while another process (AV scan, indexer, parallel run) holds
// the file open. These tests pin the retry contract: only those two codes
// retry (bounded, capped deterministic backoff), exhaustion cleans the tmp
// file up and rethrows with path + attempt count, non-transient codes fail
// immediately and unchanged, and the default path round-trips byte-identical.
// The rename/sleep seams are injected — nothing here touches the real
// `.state/` stores, telemetry or the network, and every temp dir is cleaned.
//
// Run: node scripts/utils.test.mjs

import { readFileSync, writeFileSync, rmSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJSON } from "./utils.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const deepEq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}: ${sa} !== ${sb}`);
};

// A realistic rename-shaped fs error (code is what the retry policy reads).
const fsError = (code, syscall = "rename") =>
  Object.assign(new Error(`${code}: operation not permitted, ${syscall}`), { code, errno: -40, syscall });

// Tracked temp dirs — swept at the end, nothing left behind anywhere.
const dirs = [];
const tmpDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), tag));
  dirs.push(d);
  return d;
};
// Every test must leave its temp dir holding exactly the one destination file.
const onlyFile = (dir, name) => eq(readdirSync(dir).sort().join(","), name, `exactly one file in ${dir}`);

console.log("\nutils: atomicWriteJSON retry on transient EPERM/EACCES (injected rename)");

test("retries a transient EPERM N-1 times, then lands the write with no tmp residue", () => {
  const dir = tmpDir("utils-test-perm-");
  const dest = join(dir, "target.json");
  writeFileSync(dest, '{"old":true}\n', "utf8");
  const sleeps = [];
  let attempts = 0;
  // Fail EPERM on the first 4 attempts, then perform the REAL rename so the
  // write actually lands and the residue check is honest.
  atomicWriteJSON(dest, { answer: 42 }, {
    rename: (tmp, destPath) => {
      attempts++;
      if (attempts < 5) throw fsError("EPERM");
      renameSync(tmp, destPath);
    },
    sleep: (ms) => sleeps.push(ms),
  });
  eq(attempts, 5, "attempts until success");
  eq(readFileSync(dest, "utf8"), JSON.stringify({ answer: 42 }, null, 2) + "\n", "destination has the new JSON");
  deepEq(sleeps, [25, 50, 100, 100], "capped deterministic backoff");
  onlyFile(dir, "target.json");
});

test("retries EACCES the same way (both transient codes are covered)", () => {
  const dir = tmpDir("utils-test-eacces-");
  const dest = join(dir, "target.json");
  let attempts = 0;
  atomicWriteJSON(dest, { e: "acces" }, {
    rename: (tmp, destPath) => {
      attempts++;
      if (attempts === 1) throw fsError("EACCES");
      renameSync(tmp, destPath);
    },
    sleep: () => {},
  });
  eq(attempts, 2, "one retry, then success");
  onlyFile(dir, "target.json");
});

test("exhausted retries: clean tmp, path + attempt count in the message, destination untouched", () => {
  const dir = tmpDir("utils-test-exhaust-");
  const dest = join(dir, "target.json");
  writeFileSync(dest, '{"old":true}\n', "utf8");
  const sleeps = [];
  let attempts = 0;
  let thrown = null;
  try {
    atomicWriteJSON(dest, { never: "lands" }, {
      rename: () => { attempts++; throw fsError("EPERM"); },
      sleep: (ms) => sleeps.push(ms),
    });
  } catch (err) {
    thrown = err;
  }
  eq(attempts, 5, "exactly 5 attempts, no more");
  deepEq(sleeps, [25, 50, 100, 100], "4 backoffs between 5 attempts");
  if (!thrown) fail("must throw once retries are exhausted");
  if (!thrown.message.includes(dest)) fail(`error message must carry the destination path: ${thrown.message}`);
  if (!thrown.message.includes("5 attempts")) fail(`error message must carry the attempt count: ${thrown.message}`);
  eq(thrown.code, "EPERM", "original code preserved");
  eq(readFileSync(dest, "utf8"), '{"old":true}\n', "destination untouched (old content)");
  onlyFile(dir, "target.json");
});

console.log("\nutils: atomicWriteJSON non-transient errors fail fast and unchanged");

test("ENOENT fails on the first attempt: no retry, no sleep, message unmutated", () => {
  const dir = tmpDir("utils-test-enoent-");
  const dest = join(dir, "target.json");
  let attempts = 0;
  let sleeps = 0;
  let thrown = null;
  try {
    atomicWriteJSON(dest, { x: 1 }, {
      rename: () => { attempts++; throw fsError("ENOENT"); },
      sleep: () => { sleeps++; },
    });
  } catch (err) {
    thrown = err;
  }
  eq(attempts, 1, "exactly one rename attempt");
  eq(sleeps, 0, "no backoff sleeps");
  if (!thrown) fail("must throw");
  eq(thrown.code, "ENOENT", "code preserved");
  if (thrown.message.includes("atomicWriteJSON:")) fail(`non-transient error must stay unmutated: ${thrown.message}`);
});

console.log("\nutils: atomicWriteJSON default path (no options) is unchanged");

test("plain success round-trips the exact JSON formatting", () => {
  const dir = tmpDir("utils-test-default-");
  const dest = join(dir, "target.json");
  const data = { nested: { b: 2, a: 1 }, list: [1, 2, 3] };
  atomicWriteJSON(dest, data);
  eq(readFileSync(dest, "utf8"), JSON.stringify(data, null, 2) + "\n", "byte-identical formatting");
  onlyFile(dir, "target.json");
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\nutils: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
