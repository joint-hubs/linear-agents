// scripts/supervisor-gate.mjs — the child asks, Mateusz answers, the file remembers.
//
//   node scripts/supervisor-gate.mjs emit   --kind <k> --summary "..." [--question "..." ...]
//                                           [--artifact <path> ...] [--child <id>] [--run <id>]
//   node scripts/supervisor-gate.mjs answer --gate <gateId> --text "..." [--run <id>]
//   node scripts/supervisor-gate.mjs list   [--run <id>] [--status pending|answered] [--child <id>]
//
// THE FILE IS THE SOURCE OF TRUTH (spec §2.6). Not Linear: there is deliberately
// no `needs:*` mirror in MVP. Not the transcript: a question a child only wrote
// into its output is a question nobody is holding.
//
// Two sides, and they must stay two:
//   · `emit` is the CHILD's. It runs with LA_SUPERVISOR_CHILD/RUN in the env
//     (supervisor-spawn sets both), writes a `pending` record, and the child ends
//     its turn. Writing the record is the whole act — the child does not wait.
//   · `answer` is the SUPERVISOR's, after Mateusz has actually answered. It only
//     records; DELIVERY to the child is always supervisor-followup.mjs --resume
//     carrying the text and referencing the gateId. Recording and delivering are
//     separate on purpose: a delivered answer nobody wrote down is an audit hole,
//     and a recorded answer nobody delivered leaves a child waiting forever.
//
// Redaction: `list` returns gate text VERBATIM, unlike supervisor-status.mjs
// which redacts its snippets. That is deliberate. The Supervisor's hard rule is
// to relay a child's question word for word, and a relay through a redactor is
// not a relay. The control against leaking is "never put secrets in Linear
// comments", which lives where the leak would happen, not here.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  ensureRunDir,
  failJson,
  gatePath,
  gatesDir,
  parseArgs,
  readRegistry,
} from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

// The well-known set (§2.6). Extending it is a script edit plus a spec note —
// deliberately not config, because every kind implies a different thing the
// Supervisor must do with the answer, and that behaviour lives in code.
const KINDS = ["plan.gate1", "plan.gate2", "question", "push-approval", "pr-approval"];

const STATUSES = ["pending", "answered"];

const REPEATABLE = new Set(["question", "artifact"]);

const asList = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);

function readGate(runId, gateId) {
  const path = gatePath(runId, gateId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    failJson(`gate ${gateId} is not readable JSON: ${err.message}`, { path });
  }
}

function allGates(runId) {
  const dir = gatesDir(runId);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(resolve(dir, file), "utf8")));
    } catch {
      // A malformed file must not hide the well-formed ones — same rule
      // supervisor-status.mjs follows for the same directory.
      out.push({ gateId: file.replace(/\.json$/, ""), kind: "unreadable", status: "unreadable" });
    }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// gate-<childId>-<seq>, seq counted from what is already on disk for that child.
// Not a timestamp and not a uuid: the Supervisor reads these ids aloud to
// Mateusz and types them back into `answer`, so they have to be sayable.
function nextGateId(runId, childId) {
  const prefix = `gate-${childId}-`;
  const used = allGates(runId)
    .map((g) => String(g.gateId || ""))
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  return `${prefix}${(used.length ? Math.max(...used) : 0) + 1}`;
}

// ── emit (child side) ────────────────────────────────────────────────────────

function cmdEmit(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  const childId = args.child || process.env.LA_SUPERVISOR_CHILD;

  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  if (!childId) failJson("--child <childId> is required (or set LA_SUPERVISOR_CHILD)");

  const kind = args.kind;
  if (!kind || kind === true) failJson(`--kind is required, one of ${KINDS.join(" | ")}`);
  if (!KINDS.includes(kind)) {
    failJson(`--kind "${kind}" is not a known gate kind (${KINDS.join(" | ")})`, {
      hint: "extending the set is a change to scripts/supervisor-gate.mjs plus a spec note, not a flag",
    });
  }

  const summary = args.summary;
  if (!summary || summary === true) failJson('--summary "..." is required');

  // The registry is what makes a gate routable: it says which squad asked and
  // about which issue. A gate from a child nobody registered cannot be answered,
  // because there is no session to deliver the answer back to.
  const entry = readRegistry(runId).children[childId];
  if (!entry) {
    failJson(`child "${childId}" is not in the registry for run ${runId}`, {
      hint: "emit runs inside a spawned child; LA_SUPERVISOR_CHILD is set for you",
    });
  }

  // Relative artifact paths are resolved against the CHILD's worktree, not the
  // cwd of whoever runs this. The child names `docs/foo.md` meaning its own
  // checkout, and the Supervisor reads the gate from the main repo, where that
  // same relative path is a different file.
  const artifacts = asList(args.artifact).map((p) =>
    isAbsolute(p) || !entry.worktree ? p : resolve(entry.worktree, p),
  );

  const questions = asList(args.question);
  const warnings = [];
  if (!questions.length) {
    // Not fatal — the AC requires only kind and summary — but worth saying out
    // loud. A gate with nothing to answer pushes the Supervisor towards
    // inventing the question, which is the one thing it must never do.
    warnings.push(
      "no --question given: the Supervisor can only relay questions verbatim, so a gate without one " +
        "gives Mateusz nothing to answer",
    );
  }

  const gateId = nextGateId(runId, childId);
  const path = gatePath(runId, gateId);
  if (existsSync(path)) {
    // Cannot happen with the sequence above unless two writers raced. Refuse
    // rather than overwrite: the file IS the record, and a clobbered gate is a
    // question that silently stopped existing.
    failJson(`gate ${gateId} already exists — refusing to overwrite a gate record`, { path });
  }

  const record = {
    gateId,
    childId,
    squad: entry.squad ?? null,
    runId,
    taskId: entry.taskId ?? null,
    kind,
    summary,
    questions,
    artifacts,
    status: "pending",
    createdAt: new Date().toISOString(),
    answer: null,
  };

  ensureRunDir(runId);
  atomicWriteJSON(path, record);

  for (const w of warnings) console.error(`[gate] ${w}`);
  console.log(JSON.stringify({ ok: true, path, warnings, ...record }, null, 2));
}

// ── answer (Supervisor side) ─────────────────────────────────────────────────

function cmdAnswer(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  const gateId = args.gate;
  if (!gateId || gateId === true) failJson("--gate <gateId> is required");
  const text = args.text;
  if (!text || text === true) failJson('--text "..." is required');

  const gate = readGate(runId, gateId);
  if (!gate) {
    failJson(`gate ${gateId} does not exist in run ${runId}`, {
      known: allGates(runId).map((g) => g.gateId),
    });
  }
  // Re-answering would overwrite the record of what Mateusz actually said, and
  // the first answer may already have been delivered to the child. If the answer
  // was wrong, the fix is a new turn, not a rewritten history.
  if (gate.status !== "pending") {
    failJson(`gate ${gateId} is already ${gate.status} — a gate is answered once`, {
      existingAnswer: gate.answer,
      hint: "to correct a delivered answer, send another turn with supervisor-followup.mjs",
    });
  }

  const updated = {
    ...gate,
    status: "answered",
    answer: { text, answeredAt: new Date().toISOString() },
  };
  atomicWriteJSON(gatePath(runId, gateId), updated);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: gatePath(runId, gateId),
        // Recording is not delivering. Say so on every answer, because the gap
        // between the two is where a child sits waiting on an answer that
        // technically exists.
        next: `deliver it: node scripts/supervisor-followup.mjs --child ${gate.childId} --gate ${gateId} --prompt "<the answer>"`,
        ...updated,
      },
      null,
      2,
    ),
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

function cmdList(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  const status = args.status && args.status !== true ? args.status : null;
  if (status && !STATUSES.includes(status)) {
    failJson(`--status must be one of ${STATUSES.join(" | ")}`);
  }
  const childId = args.child && args.child !== true ? args.child : null;

  let gates = allGates(runId);
  if (status) gates = gates.filter((g) => g.status === status);
  if (childId) gates = gates.filter((g) => g.childId === childId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        filter: { status, childId },
        counts: {
          pending: allGates(runId).filter((g) => g.status === "pending").length,
          answered: allGates(runId).filter((g) => g.status === "answered").length,
        },
        gates,
      },
      null,
      2,
    ),
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2), REPEATABLE);
  const cmd = args._[0];

  if (cmd === "emit") return cmdEmit(args);
  if (cmd === "answer") return cmdAnswer(args);
  if (cmd === "list") return cmdList(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected emit | answer | list`);
}

export { KINDS, allGates, nextGateId };

if (process.argv[1]?.endsWith("supervisor-gate.mjs")) main();
