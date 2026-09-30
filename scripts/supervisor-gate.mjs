// scripts/supervisor-gate.mjs — the child asks, Mateusz answers, the file remembers.
//
//   node scripts/supervisor-gate.mjs emit   --kind <k> --summary "..." [--question "..." ...]
//                                           [--artifact <path> ...] [--facts <json|@file>]
//                                           [--decision-event <eventId> ...] [--decision-run <runId> ...]
//                                           [--child <id>] [--run <id>]
//   node scripts/supervisor-gate.mjs answer --gate <gateId> --text "..." [--note "..."] [--run <id>]
//   node scripts/supervisor-gate.mjs answer --hold <holdId> --text "..." [--note "..."] [--run <id>]
//   node scripts/supervisor-gate.mjs hold   --origin <who|what> --question "..." --recommendation "..."
//                                           --option '<json>' [--option ...] [--impact high|medium|low]
//                                           [--resolution <action>] [--run <id>]
//   node scripts/supervisor-gate.mjs defer  --hold <holdId> --until <ISO> [--run <id>]
//   node scripts/supervisor-gate.mjs list   [--run <id>] [--status pending|answered] [--child <id>]
//   node scripts/supervisor-gate.mjs list   --open [--run <id>]
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
//
// ── holds (FOC-612) ──────────────────────────────────────────────────────────
//
// A hold is a decision the Supervisor owes Mateusz that does NOT stop the run:
// work that does not depend on the answer keeps going, and only queue items
// that name the hold wait (supervisor-lib.partitionByHolds). Unlike a gate's
// neutral options, a hold carries ONE recommended option — with its costed
// alternatives alongside (the sign-off is recorded in
// agents/supervisor/CLAUDE.md <supervisor_holds>). Costs are priced through
// config/models.json only; a missing price row is UNKNOWN plus the model name,
// never zero and never the stream's reported figure.
//
// `answer` stays the ONE answer verb: --gate answers a gate record, --hold
// answers a hold. One subcommand, one dispatch — never two answer paths for a
// reader to guess between. Holds live in ONE versioned file
// (`<run>/holds.json`, supervisor-lib), not one-file-per-record like gates; the
// shape difference is documented at supervisor-lib's holds section.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  AFFIRMATIVE,
  NEGATIVE,
  HOLD_IMPACTS,
  HOLDS_SCHEMA_VERSION,
  ensureRunDir,
  failJson,
  gatePath,
  gatesDir,
  hasPriceRow,
  holdIsPresentable,
  holdsPath,
  isAffirmative,
  isNegative,
  nextHoldId,
  openHolds,
  parseArgs,
  patchHold,
  readHolds,
  readRegistry,
  writeHolds,
} from "./supervisor-lib.mjs";
import { autoLabel, pairDecisionEvents } from "./decision-log.mjs";
import { atomicWriteJSON } from "./utils.mjs";

// The well-known set (§2.6). Extending it is a script edit plus a spec note —
// deliberately not config, because every kind implies a different thing the
// Supervisor must do with the answer, and that behaviour lives in code.
const KINDS = [
  "plan.gate1",
  "plan.gate2",
  "question",
  "push-approval",
  "pr-approval",
  // FOC-167. Unlike the others this one is emitted BY the Supervisor, not by a
  // child: the child whose tree is being reclaimed is the last party that should
  // be asking for permission to reclaim it.
  "cleanup-approval",
  // FOC-400, ADR-0012 D5. Unlike `question`, which asks something open, this one
  // submits a whole artifact — an ADR draft, a squad-prompt draft — for
  // approve/reject. No new record fields and no answer-phrasing rule: the
  // artifact rides on the existing --artifact list, and the answer is free text.
  "draft-approval",
];

const STATUSES = ["pending", "answered"];

const REPEATABLE = new Set(["question", "artifact", "decision-event", "decision-run", "option"]);

const asList = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);

const requireText = (value, flag) => {
  if (!value || value === true) failJson(`--${flag} "..." is required`);
  return String(value);
};

/**
 * `--facts <json>` or `--facts @<path>` — a structured payload stored verbatim
 * on the record.
 *
 * Why a gate needs this at all: `summary` and `questions` are prose for a human
 * to read, and prose is exactly what an approval must NOT be decided from when
 * the thing being approved is destructive. The cleanup gate records the tree's
 * HEAD and its dirty paths here, and supervisor-cleanup.mjs re-checks them
 * against the tree before it removes anything — so a yes covers the tree
 * Mateusz was shown, not whatever the tree became afterwards.
 *
 * Refuses non-objects: `facts` is merged into a record whose other keys are
 * load-bearing, and an array or a bare string there would read as a field name
 * collision waiting to happen.
 */
function parseFacts(raw) {
  if (raw === undefined) return {};
  if (raw === true) failJson("--facts needs a value: inline JSON, or @<path> to a JSON file");

  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    if (!existsSync(path)) failJson(`--facts @${path} does not exist`);
    text = readFileSync(path, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    failJson(`--facts is not readable JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failJson(`--facts must be a JSON object (got ${Array.isArray(parsed) ? "an array" : typeof parsed})`);
  }
  return parsed;
}

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

  // Flags are validated before any state is read: a malformed --facts should say
  // so whether or not the registry happens to know this child.
  const facts = parseFacts(args.facts);

  // FOC-449: explicit decision provenance — the decision events this gate's
  // answer will label. Validated with the other flags, before any state is
  // read: a malformed pairing must be refused whether or not the registry
  // knows this child. No flags → no provenance on the record at all.
  let decisionEvents = [];
  try {
    decisionEvents = pairDecisionEvents(asList(args["decision-event"]), asList(args["decision-run"]));
  } catch (err) {
    failJson(err.message);
  }

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
  if (kind === "draft-approval" && !artifacts.length) {
    // Also not fatal: ADR-0012 D5 specifies no new required fields, and a hard
    // requirement here would refuse a gate the ADR says is well-formed. But the
    // artifact is the whole point of this kind — without one, Mateusz is asked
    // to approve a draft he cannot see.
    warnings.push(
      "no --artifact given: a draft-approval gate submits a full artifact for approve/reject, " +
        "so without one there is nothing to approve",
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
    facts,
    status: "pending",
    createdAt: new Date().toISOString(),
    answer: null,
    // FOC-449: the decision events this gate's answer will label. The key is
    // added only when provenance was given — a gate without it stays
    // byte-identical.
    ...(decisionEvents.length ? { decisionEvents } : {}),
  };

  ensureRunDir(runId);
  atomicWriteJSON(path, record);

  for (const w of warnings) console.error(`[gate] ${w}`);
  console.log(JSON.stringify({ ok: true, path, warnings, ...record }, null, 2));
}

// ── hold (FOC-612) ───────────────────────────────────────────────────────────

/**
 * One `--option <json>`: `{ "label": "...", "model": "...", "costUsd": 0.01 }`.
 *
 * Why the model is required even when the cost is given: the FOC-165 rule —
 * a hold's costs are PRICED numbers, and "priced" means priced through
 * config/models.json. An option's costUsd is stored only when the model it is
 * priced against actually has a row there; without the row the figure would be
 * an unpriced guess wearing a price's clothes, and costUsdReported (the
 * stream's own figure) is refused outright — it is not a measurement.
 */
function parseOption(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failJson(`--option is not readable JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failJson(`--option must be a JSON object ({ label, model, costUsd }), got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }
  if ("costUsdReported" in parsed) {
    failJson(`--option "${parsed.label ?? "?"}" carries costUsdReported — the stream's figure is not a price and never enters a hold`, {
      hint: "price the cost yourself from token counts through config/models.json, or omit costUsd to record UNKNOWN",
    });
  }
  if (typeof parsed.label !== "string" || !parsed.label.trim()) failJson('--option needs a non-empty "label"');
  if (typeof parsed.model !== "string" || !parsed.model.trim()) {
    failJson(`--option "${parsed.label}" needs "model" — the model its cost is priced against`);
  }
  let costUsd = null;
  let unpricedModel = null;
  if (parsed.costUsd !== undefined && parsed.costUsd !== null) {
    if (typeof parsed.costUsd !== "number" || !Number.isFinite(parsed.costUsd) || parsed.costUsd < 0) {
      failJson(`--option "${parsed.label}" costUsd must be a number >= 0`);
    }
    const priced = hasPriceRow(parsed.model);
    if (priced.error) failJson(`cannot price option "${parsed.label}": ${priced.error}`, { hint: "fix config/models.json — a hold's costs are priced against it" });
    if (!priced.priced) {
      failJson(`option "${parsed.label}" gives costUsd for ${parsed.model}, but config/models.json has no price row for it — a hold's costs are priced numbers only`, {
        hint: `add ${parsed.model} to pricing in config/models.json, or drop costUsd to record UNKNOWN (never zero, never the stream's figure)`,
      });
    }
    costUsd = parsed.costUsd;
  } else {
    // No figure given: UNKNOWN, naming the model — never zero, never guessed
    // from the stream. At least one option must still be costed (cmdHold
    // refuses a hold whose options are all UNKNOWN).
    unpricedModel = parsed.model;
  }
  return { label: parsed.label, model: parsed.model, costUsd, ...(unpricedModel ? { unpricedModel } : {}) };
}

// ── hold rendering (FOC-612) ─────────────────────────────────────────────────

// The human-readable presentation Mateusz is read. Numeric costs carry the
// "wycenione" label on purpose: it says the figure came from
// config/models.json, not from a stream or a guess (FOC-165).
function renderHold(hold) {
  const lines = [
    `[${hold.id}] (${hold.state} · impact: ${hold.impact})`,
    `Pytanie: ${hold.question}`,
    `Pochodzenie: ${hold.origin}`,
    "Opcje (koszt wyceniony z config/models.json):",
  ];
  for (const [i, option] of hold.options.entries()) {
    lines.push(
      option.costUsd === null
        ? `  ${i + 1}) ${option.label} — model ${option.model} — koszt: UNKNOWN (brak wiersza wyceny dla ${option.unpricedModel ?? option.model} w config/models.json)`
        : `  ${i + 1}) ${option.label} — model ${option.model} — koszt: $${option.costUsd.toFixed(4)} (wycenione)`,
    );
  }
  lines.push(`Rekomendacja: ${hold.recommendation}`);
  if (hold.until) lines.push(`Odroczone do: ${hold.until}`);
  return lines.join("\n");
}

/**
 * `hold` — raise a non-blocking decision record.
 *
 * WHY a hold and not a gate: a gate stops a child's turn; a hold does not stop
 * the run — work that does not name it keeps going, and `blocks: null` (below)
 * is what makes several open holds safe at once. Refusals fire BEFORE any
 * write, exactly like cmdEmit's: a hold that cannot be priced or one without
 * its alternatives must never reach Mateusz's screen half-formed.
 */
function cmdHold(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  const origin = requireText(args.origin, "origin");
  const question = requireText(args.question, "question");
  const recommendation = requireText(args.recommendation, "recommendation");
  const impact = args.impact && args.impact !== true ? args.impact : "medium";
  if (!HOLD_IMPACTS.includes(impact)) {
    failJson(`--impact must be one of ${HOLD_IMPACTS.join(" | ")}`);
  }
  const resolution = args.resolution && args.resolution !== true ? args.resolution : null;

  const rawOptions = asList(args.option);
  if (!rawOptions.length) failJson('--option <json> is required at least once — a recommendation without its alternatives is a fail');
  const options = rawOptions.map(parseOption);

  // Decision 1 (FOC-612): a recommendation without costed alternatives is a
  // fail — refused at WRITE time, not rendered. UNKNOWN options are allowed
  // alongside a priced one; a hold where nothing is priced is not.
  if (!options.some((o) => o.costUsd !== null)) {
    failJson("no option carries a priced cost — a recommendation without costed options is a fail", {
      hint: "price at least one option through config/models.json (its model needs a price row)",
    });
  }

  // Validate FIRST (writeHolds validates the whole store), then write. A
  // resolution naming a neverCovers action is refused by the store validation
  // — same refusal at load, so a hand-edited hold cannot honour one either.
  // The throw is converted to the JSON contract here — the CLI never prints a
  // stack (supervisor-lib style: the lib throws, the CLI layer failJson's).
  let store;
  try {
    store = readHolds(runId);
  } catch (err) {
    failJson(`the holds store for run ${runId} is unreadable: ${err.message}`, {
      hint: "fix or delete holds.json — a store nobody can parse is not a store",
    });
  }
  const id = nextHoldId(runId);
  const now = new Date().toISOString();
  const hold = {
    id,
    origin,
    question,
    options,
    recommendation,
    impact,
    resolution,
    state: "open",
    createdAt: now,
    // Presentation is tracked, not assumed: the guard blocks on a hold that is
    // open and not yet presented (owed work, exactly like a pending gate), and
    // `list --open` is the act that stamps this.
    presentedAt: null,
    until: null,
    answer: null,
    // FOC-612 decision 2: `blocks: null` is what makes several open holds safe
    // at once. null means NOTHING waits on this hold — only queue items that
    // explicitly name it (partitionByHolds) ever populate it, so the
    // "one hold presented per turn" rule cannot silently stop unrelated work.
    blocks: null,
    history: [{ event: "created", at: now }],
  };

  const updated = { version: HOLDS_SCHEMA_VERSION, holds: [...store.holds, hold] };
  try {
    writeHolds(runId, updated);
  } catch (err) {
    failJson(`hold ${id} could not be written: ${err.message}`);
  }

  console.log(JSON.stringify({ ok: true, path: holdsPath(runId), rendered: renderHold(hold), ...updated }, null, 2));
}

// ── answer (Supervisor side) ─────────────────────────────────────────────────

function cmdAnswer(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  // ONE answer verb, two record types: --gate answers a gate record, --hold
  // answers a hold (FOC-612). Mutually exclusive — one answer per invocation,
  // so the reader never guesses which record an answer landed on.
  if (args.gate && args.hold && args.gate !== true && args.hold !== true) {
    failJson("--gate and --hold are mutually exclusive — one answer per invocation");
  }
  if (args.hold && args.hold !== true) return cmdAnswerHold(args, runId, args.hold);

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

  // A cleanup-approval answer is acted on by supervisor-cleanup.mjs, which only
  // accepts a whole yes/no token. Recording anything else used to succeed here
  // and fail there — and since a gate is answered once, the gate was burnt and
  // had to be proposed again (gate-dev-5-2, run a93f). Refuse it BEFORE writing.
  // The reasoning behind the answer belongs in --note, which cleanup never reads.
  if (gate.kind === "cleanup-approval" && !isAffirmative(text) && !isNegative(text)) {
    failJson(`a cleanup-approval answer must be a single yes/no token, got "${text}" — nothing was recorded`, {
      gateId,
      accepted: { yes: AFFIRMATIVE, no: NEGATIVE },
      hint: 'put the basis for the answer in --note: --text "tak" --note "TEST Done, tree clean, fingerprint …"',
    });
  }

  const note = args.note && args.note !== true ? String(args.note) : null;
  const updated = {
    ...gate,
    status: "answered",
    answer: { text, ...(note ? { note } : {}), answeredAt: new Date().toISOString() },
  };
  atomicWriteJSON(gatePath(runId, gateId), updated);

  // FOC-449 auto-join: the recorded answer IS the outcome for every decision
  // event the gate carried provenance for — outcome = the answer value,
  // by:"human", via:"gate". Never derived from the event's own answers. A
  // failed label is a warning on stderr, never a broken answer (the gate
  // record is the primary flow); a gate without provenance labels nothing.
  const labelWarnings = autoLabel(gate.decisionEvents, { outcome: text, by: "human", via: "gate" }).warnings;
  for (const w of labelWarnings) console.error(`[gate] ${w}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: gatePath(runId, gateId),
        // Recording is not delivering. Say so on every answer, because the gap
        // between the two is where a child sits waiting on an answer that
        // technically exists.
        next: `deliver it: node scripts/supervisor-followup.mjs --child ${gate.childId} --gate ${gateId} --prompt "<the answer>"`,
        warnings: labelWarnings,
        ...updated,
      },
      null,
      2,
    ),
  );
}

// ── answer --hold (FOC-612) ──────────────────────────────────────────────────

function cmdAnswerHold(args, runId, holdId) {
  const text = requireText(args.text, "text");
  const note = args.note && args.note !== true ? String(args.note) : null;
  const now = new Date().toISOString();

  let store;
  try {
    store = readHolds(runId);
  } catch (err) {
    failJson(`the holds store for run ${runId} is unreadable: ${err.message}`, {
      hint: "fix or delete holds.json — a store nobody can parse is not a store",
    });
  }
  const hold = store.holds.find((h) => h.id === holdId);
  if (!hold) {
    failJson(`hold ${holdId} does not exist in run ${runId}`, {
      known: store.holds.map((h) => h.id),
    });
  }

  // Same rule as a gate: a hold is answered once. Re-answering would overwrite
  // the record of what Mateusz actually said. Versioning keeps the rule honest:
  // the answer in force is NAMED in the refusal, and the history stays
  // append-only — the fix for a wrong answer is a new turn, not a rewrite.
  if (hold.state !== "open") {
    failJson(`hold ${holdId} is already answered — the answer in force is "${hold.answer.text}" (recorded ${hold.answer.answeredAt})`, {
      hint: "a hold is answered once; to change course, raise a new hold",
    });
  }

  const answer = { text, ...(note ? { note } : {}), answeredAt: now };
  // An answer is a new history entry, never an overwrite — the file read back
  // after this shows created AND answered, in order. (A throw here is the
  // store validation refusing; converted to the JSON contract, never a stack.)
  let updated;
  try {
    updated = patchHold(runId, holdId, { state: "answered", answer }, { event: "answered", at: now, text });
  } catch (err) {
    failJson(`hold ${holdId} could not be updated: ${err.message}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: holdsPath(runId),
        // Recording is the whole act for a hold: unlike a gate there is no
        // followup delivery step — queue items that named this hold may proceed.
        next: "the answer is in force; dependent queue items may proceed",
        hold: updated,
      },
      null,
      2,
    ),
  );
}

// ── defer (FOC-612) ──────────────────────────────────────────────────────────

/**
 * `defer --until <ISO>` — quiet the hold's turn-end block until the timestamp
 * arrives, then it resurfaces (an `until` in the past resurfaces immediately —
 * that is the mechanism AC2 tests, not a corner case). Deferral never answers:
 * a deferred hold still keeps the run from completing (the completion check
 * refuses while any hold is open), and an un-presented hold keeps blocking the
 * turn end even when deferred — the presentation itself is still owed.
 */
function cmdDefer(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  const holdId = args.hold && args.hold !== true ? args.hold : null;
  if (!holdId) failJson("--hold <holdId> is required");
  const until = args.until && args.until !== true ? args.until : null;
  if (!until) failJson("--until <ISO timestamp> is required — say when the hold resurfaces");
  if (Number.isNaN(Date.parse(until))) {
    failJson(`--until "${until}" is not a parseable timestamp`);
  }

  let store;
  try {
    store = readHolds(runId);
  } catch (err) {
    failJson(`the holds store for run ${runId} is unreadable: ${err.message}`, {
      hint: "fix or delete holds.json — a store nobody can parse is not a store",
    });
  }
  const hold = store.holds.find((h) => h.id === holdId);
  if (!hold) {
    failJson(`hold ${holdId} does not exist in run ${runId}`, {
      known: store.holds.map((h) => h.id),
    });
  }
  if (hold.state !== "open") {
    failJson(`hold ${holdId} is already answered — its answer is in force; deferring is for open holds`, {
      answerInForce: hold.answer,
    });
  }

  const now = new Date().toISOString();
  let updated;
  try {
    updated = patchHold(runId, holdId, { until }, { event: "deferred", at: now, until });
  } catch (err) {
    failJson(`hold ${holdId} could not be updated: ${err.message}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: holdsPath(runId),
        next: `the hold resurfaces after ${until} — until then the turn-end guard leaves it alone; the run still cannot complete while it is open`,
        hold: updated,
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

  // `list --open` is the holds presentation surface — NOT a passive read. It
  // renders the ONE hold to put to Mateusz this turn (impact first) and stamps
  // `presentedAt` on it: the reading and the presenting are the same act, and
  // the stamp is what stops the turn-end guard from treating the hold as work
  // nobody has shown yet. A second hold waits for the next invocation — one per
  // turn is the whole point (FOC-612 decision 2).
  if (args.open === true) return cmdListOpenHolds(args, runId);

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

function cmdListOpenHolds(args, runId) {
  let store;
  try {
    store = readHolds(runId);
  } catch (err) {
    failJson(`the holds store for run ${runId} is unreadable: ${err.message}`, {
      hint: "fix or delete holds.json — a store nobody can parse is not a store",
    });
  }

  const now = new Date();
  // Impact first (high > medium > low, oldest tiebreak): the presentation order
  // is the impact order — one hold per invocation, the next `list --open` gives
  // the next one.
  const open = openHolds(runId);
  const presentNext = open.find((h) => holdIsPresentable(h, now)) ?? null;

  let stamped = null;
  if (presentNext && presentNext.presentedAt === null) {
    // Stamp the showing. Resurfaced holds keep their original presentedAt —
    // their resurfacing is carried by `until`, not by a second stamp.
    stamped = presentNext.id;
    try {
      patchHold(runId, presentNext.id, { presentedAt: now.toISOString() }, { event: "presented", at: now.toISOString() });
    } catch (err) {
      failJson(`hold ${presentNext.id} could not be marked presented: ${err.message}`);
    }
  }

  const target = stamped ? { ...presentNext, presentedAt: now.toISOString() } : presentNext;
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        counts: { open: open.length },
        // All open holds, ordered — `presentNext` is the ONE to put to Mateusz.
        open,
        presentNext: target ? target.id : null,
        rendered: target ? renderHold(target) : null,
        note:
          open.length && !target
            ? "every open hold has been presented — present the record fields directly, then answer or defer it"
            : null,
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
  if (cmd === "hold") return cmdHold(args);
  if (cmd === "defer") return cmdDefer(args);
  if (cmd === "list") return cmdList(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected emit | answer | list (gate records) or hold | defer | list --open (holds, FOC-612)`);
}

export { KINDS, allGates, nextGateId };

if (process.argv[1]?.endsWith("supervisor-gate.mjs")) main();
