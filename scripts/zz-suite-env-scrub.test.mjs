// scripts/zz-suite-env-scrub.test.mjs — probe: no LA_SUPERVISOR* may reach a suite file.
//
// test-all.mjs strips LA_SUPERVISOR* before spawning each suite file (FOC-295):
// the runner usually runs inside a supervised child, and supervisor-cleanup's
// FOC-167 identity guard refuses there. This file fails if any of the variables
// leaks past the scrub into a spawned test process.
//
// Not for solo runs: executed directly inside a supervised child it fails by
// design — that leak is exactly what it exists to catch. It is spawned (with a
// poisoned env on top of the runner's scrub) by test-all.test.mjs, and sorts
// last in the full suite because of the zz- prefix.
//
// Run: node scripts/test-all.mjs zz-suite-env-scrub

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
const fail = (msg) => { throw new Error(msg); };

test("no LA_SUPERVISOR* variable in the suite environment", () => {
  const leaked = Object.keys(process.env).filter((k) => k.startsWith("LA_SUPERVISOR"));
  if (leaked.length) fail(`leaked into the suite env: ${leaked.join(", ")}`);
});

console.log(`\n${passed}/1 passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}
