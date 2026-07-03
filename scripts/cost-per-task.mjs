// Cost per task (W6): report USD cost grouped by Linear task ID.
//
//   node scripts/cost-per-task.mjs [--since=YYYY-MM-DD] [--task=PISI-98] [--json]
//
// Reads local run manifests and transcripts. Zero runtime deps.

import { scanRuns, aggregateByTask } from "./ledger.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = { since: null, task: null, json: false };
  for (const a of args) {
    if (a === "--json") flags.json = true;
    else if (a.startsWith("--since=")) flags.since = a.slice(8);
    else if (a.startsWith("--task=")) flags.task = a.slice(7);
  }
  return flags;
}

const fmtInt = (n) => Number(n).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(buckets) {
  const out = (s) => process.stdout.write(s + "\n");

  const cols = [
    { key: "task", label: "TASK", width: 20 },
    { key: "runs", label: "RUNS", width: 6, align: "right" },
    { key: "cost", label: "COST USD", width: 10, align: "right" },
    { key: "inTok", label: "IN TOK", width: 12, align: "right" },
    { key: "outTok", label: "OUT TOK", width: 12, align: "right" },
    { key: "period", label: "FIRST..LAST", width: 21 },
    { key: "squads", label: "SQUADS", width: 0 },
  ];

  const header = cols.map((c) => c.label.padStart(c.align === "right" ? c.width : 0).padEnd(c.width)).join(" ");
  const sep = "─".repeat(header.length);

  out("");
  out(header);
  out(sep);

  let totalRuns = 0;
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const [taskId, bucket] of Object.entries(buckets)) {
    const taskLabel = taskId.length > 20 ? taskId.slice(0, 20) : taskId.padEnd(20);
    const runsStr = String(bucket.runs).padStart(6);
    const costStr = `$${bucket.costUSD.toFixed(2)}`.padStart(10);
    const inStr = fmtInt(bucket.inputTokens).padStart(12);
    const outStr = fmtInt(bucket.outputTokens).padStart(12);
    const first = bucket.firstStartedAt ? bucket.firstStartedAt.slice(0, 10) : "?";
    const last = bucket.lastEndedAt ? bucket.lastEndedAt.slice(0, 10) : "running";
    const periodStr = `${first}..${last}`.padEnd(21);
    const squadsStr = Object.entries(bucket.squads)
      .map(([s, v]) => `${s}:${v.runs}`)
      .join(", ");

    out(`${taskLabel} ${runsStr} ${costStr} ${inStr} ${outStr} ${periodStr} ${squadsStr}`);

    totalRuns += bucket.runs;
    totalCost += bucket.costUSD;
    totalIn += bucket.inputTokens;
    totalOut += bucket.outputTokens;
  }

  out(sep);

  const totalRow = [
    "TOTAL".padEnd(20),
    String(totalRuns).padStart(6),
    `$${totalCost.toFixed(2)}`.padStart(10),
    fmtInt(totalIn).padStart(12),
    fmtInt(totalOut).padStart(12),
    "".padEnd(21),
    "",
  ].join(" ");
  out(totalRow);
  out("");
}

function printJson(buckets, since, task) {
  let totalCost = 0;
  const tasks = {};
  for (const [taskId, bucket] of Object.entries(buckets)) {
    totalCost += bucket.costUSD;
    tasks[taskId] = {
      runs: bucket.runs,
      costUSD: bucket.costUSD,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      firstStartedAt: bucket.firstStartedAt,
      lastEndedAt: bucket.lastEndedAt,
      squads: bucket.squads,
    };
  }

  const obj = {
    meta: {
      since: since || null,
      task: task || null,
      total_cost: totalCost,
    },
    tasks,
  };

  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  // Validate --since
  if (flags.since) {
    const d = new Date(flags.since + "T00:00:00Z");
    if (isNaN(d.getTime())) {
      console.error(
        `Invalid --since value: ${flags.since} (use ISO 8601, e.g. 2026-06-01)`,
      );
      process.exit(1);
    }
  }

  // Normalize --task to uppercase
  if (flags.task) {
    flags.task = flags.task.toUpperCase();
  }

  const runs = await scanRuns();

  // Filter by --since
  let filtered = runs;
  if (flags.since) {
    const since = new Date(flags.since + "T00:00:00Z");
    filtered = runs.filter((r) => {
      if (!r.startedAt) return false;
      return new Date(r.startedAt) >= since;
    });
  }

  const byTask = aggregateByTask(filtered);

  // Filter by --task
  if (flags.task) {
    if (byTask[flags.task]) {
      // Keep only the requested task
      const single = {};
      single[flags.task] = byTask[flags.task];
      if (flags.json) {
        const _stdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (s) => process.stderr.write(s);
        printTable(single);
        process.stdout.write = _stdout;
        printJson(single, flags.since, flags.task);
      } else {
        printTable(single);
      }
    } else {
      // No runs for this task
      if (flags.json) {
        const _stdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (s) => process.stderr.write(s);
        console.log(`No runs for task ${flags.task}`);
        process.stdout.write = _stdout;
        const obj = {
          meta: { since: flags.since || null, task: flags.task, total_cost: 0 },
          tasks: {},
        };
        process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
      } else {
        console.log(`No runs for task ${flags.task}`);
      }
      process.exit(0);
    }
  } else if (flags.json) {
    const _stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => process.stderr.write(s);
    printTable(byTask);
    process.stdout.write = _stdout;
    printJson(byTask, flags.since, null);
  } else {
    printTable(byTask);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
