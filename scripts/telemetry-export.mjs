#!/usr/bin/env node
// telemetry-export.mjs — export the central telemetry projection.

import { resolve } from "node:path";
import { exportTelemetry, openTelemetryDb } from "./telemetry-store.mjs";

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const args = process.argv.slice(2);
const format = value(args, "--format");
const output = value(args, "--output");

if (!format || !output || !["jsonl", "csv", "sqlite"].includes(format)) {
  console.error("Usage: node scripts/telemetry-export.mjs --format <jsonl|csv|sqlite> --output <path>");
  process.exit(2);
}

const db = openTelemetryDb();
try {
  const result = exportTelemetry(db, format, resolve(output));
  console.log(JSON.stringify(result));
} finally {
  db.close();
}