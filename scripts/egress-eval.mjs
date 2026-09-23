#!/usr/bin/env node
// scripts/egress-eval.mjs — score the egress screen against labelled sets (FOC-450)
//
// Two populations, per the FOC-450 AC4 contract:
//   1. SYNTHETIC — committed, unmistakably fake, in
//      scripts/fixtures/egress-eval-synthetic.mjs. Always present.
//   2. REAL — past Linear comments, labelled by hand. Lives at
//      .state/egress-eval-real.json (gitignored; the repo is public, so real
//      comment text must never be committed). The file is ABSENT on a clean
//      clone and the scorer skips it gracefully, saying so. Path override for
//      tests: EGRESS_EVAL_REAL_FILE=<path>.
//
// Real-file format: a JSON array of { id, text, label: "secret"|"clean",
// family?: <one of the five families> }. Label the texts by hand BEFORE
// scoring — labels independent of the detector — and never commit the file.
//
// Honesty note baked into the report: synthetic labels are authored against
// the written family contract, so synthetic precision measures
// contract-conformance, not real-world precision; the real population (when
// present) is what measures real-world performance.
//
// Usage: node scripts/egress-eval.mjs
// Exit 0 always — this is a reporting tool; threshold enforcement lives in
// egress-screen.test.mjs so a detector regression fails the suite.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanEgress } from "./egress-screen.mjs";
import { SYNTHETIC_SET } from "./fixtures/egress-eval-synthetic.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

const FAMILIES = ["key-prefix", "pem", "env-assignment", "jwt", "high-entropy"];

/**
 * Real-population path — read at call time (not module load) so tests can
 * point EGRESS_EVAL_REAL_FILE at a temp file. Default lives under .state/
 * (gitignored): real comment text never leaves this machine.
 */
function realPath() {
  return process.env.EGRESS_EVAL_REAL_FILE || join(ROOT, ".state", "egress-eval-real.json");
}

/**
 * Load both labelled populations. The real file is optional by contract.
 * @returns {{ synthetic: object[], real: object[], realSource: string|null, realError?: string }}
 */
export function loadLabelledSets() {
  const synthetic = SYNTHETIC_SET;
  const path = realPath();
  let real = [];
  let realSource = null;
  let realError = null;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("top-level value must be an array");
      for (const e of parsed) {
        if (!e || typeof e.text !== "string" || !["secret", "clean"].includes(e.label)) {
          throw new Error(`bad entry ${e && e.id ? e.id : "(no id)"} — needs text + label secret|clean`);
        }
      }
      real = parsed;
      realSource = path;
    } catch (err) {
      realError = err.message;
    }
  }
  return { synthetic, real, realSource, realError, realPath: path };
}

/**
 * Score one labelled population. A text is "predicted secret" when
 * scanEgress emits at least one hit.
 * @param {object[]} entries  { id, text, label, family? }
 * @returns {{ total, secrets, clean, tp, fp, fn, tn, precision, recall,
 *   perFamily: Record<string, { labelled, caught, caughtAny, fp }> }}
 */
export function scoreSet(entries) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const perFamily = Object.fromEntries(
    FAMILIES.map((f) => [f, { labelled: 0, caught: 0, caughtAny: 0, fp: 0 }]),
  );
  for (const e of entries) {
    const hits = scanEgress(e.text);
    const families = new Set(hits.map((h) => h.family));
    if (e.label === "secret") {
      if (hits.length > 0) tp++;
      else fn++;
      if (e.family && perFamily[e.family]) {
        perFamily[e.family].labelled++;
        if (families.has(e.family)) perFamily[e.family].caught++;
        if (hits.length > 0) perFamily[e.family].caughtAny++;
      }
    } else {
      if (hits.length > 0) {
        fp++;
        for (const f of families) {
          if (perFamily[f]) perFamily[f].fp++;
        }
      } else {
        tn++;
      }
    }
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { total: entries.length, secrets: tp + fn, clean: fp + tn, tp, fp, fn, tn, precision, recall, perFamily };
}

const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

function printReport(name, s) {
  console.log(`\n=== ${name} ===`);
  console.log(`texts: ${s.total} (secret ${s.secrets}, clean ${s.clean})`);
  console.log(`precision: ${pct(s.precision)}  recall: ${pct(s.recall)}  (TP ${s.tp} · FP ${s.fp} · FN ${s.fn} · TN ${s.tn})`);
  console.log("per family:  labelled → caught-by-that-family | caught-by-any | FP-from-clean");
  for (const [f, v] of Object.entries(s.perFamily)) {
    console.log(`  ${f.padEnd(15)} ${v.labelled} → ${v.caught} | ${v.caughtAny} | FP ${v.fp}`);
  }
}

async function main() {
  const { synthetic, real, realSource, realError, realPath } = loadLabelledSets();

  console.log("egress screen evaluation (detector: scripts/egress-screen.mjs — local, offline)");
  const synScore = scoreSet(synthetic);
  printReport(`synthetic (committed fixture, fake-by-construction): ${synthetic.length} texts`, synScore);

  if (realSource) {
    const realScore = scoreSet(real);
    printReport(`real (past comments, hand-labelled, gitignored): ${real.length} texts from ${realSource}`, realScore);
  } else if (realError) {
    console.log(`\nreal population: PRESENT but unreadable — ${realError} (skipped; fix the file, never commit it)`);
  } else {
    console.log(`\nreal population: absent (${realPath}) — clean clone, skipped by contract. ` +
      "Label past comments into that file to measure real-world precision/recall.");
  }

  const combined = scoreSet([...synthetic, ...real]);
  printReport(`combined (${synthetic.length} synthetic + ${real.length} real)`, combined);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
