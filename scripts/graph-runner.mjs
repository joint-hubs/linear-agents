// scripts/graph-runner.mjs — the graph.json v2 executor (FOC-397).
//
// Runs the PLAN subgraph (config/graph.json "plan" node: steps + stepFlow) as
// a resumable state machine over a JSONL run-record store (GAPS §3.4): every
// step execution appends ONE typed record keyed by its dotted step key, and a
// run resumes by reading the LATEST record per key — done steps are skipped
// (never re-executed), handed-off/gate-pending steps wait for an external
// resolution record, failed/gate-rejected runs stay stopped.
//
// Step kinds (the D7 contract, config/graph.json + config/decisions.json):
//   [J] plan.dor, plan.decompose — one decision-call seam call by registry id
//       with runner-built questions (graph-node entries carry no question set
//       of their own; resolveEntryQuestions refuses them by design, so the
//       questions come from the runner and the id governs provenance and
//       autonomy). plan.ready (FOC-476) is the exception: it is served through
//       its own transport entry (plan.readiness) whose question set the seam
//       instantiates — the plan.ac ↔ plan.ac.testable pattern. Every plan J
//       entry is autonomy A0 with threshold null, so a served answer is
//       recorded as an ANNOTATION and the step is handed to the frontman —
//       never auto-acted. Cascade ladder: tier 1 = the seam call (the seam
//       owns its own retries), tier 2 is dead by contract (every entry pins
//       fallback.tier2 "disabled", FOC-473), tier 3 = frontman hand-off
//       carrying the triggering envelope error.
//   [G] plan.dod, plan.ac — ONE schema-validated model call through the
//       injectable generator; the result is validated against the step's
//       output schema and recorded done. The default generator is a single
//       chat/completions POST with response_format json_schema (strict, the
//       step's output schema) on the cheap tier from config/models.json
//       (routing.plan.discovery) — UNMEASURED (FOC-473 posture: no measured
//       call, no pricing row); tests inject a generator or an injected
//       fetch. It rides the registry: the entry for the step id owns the
//       prompt, and the message is composed from the RESOLVED reads — the
//       declared inputs, never the whole run state. A successful call
//       appends ONE FOC-449 event line to the run's decisions.jsonl (input
//       as sent, mask-only scrubbed, parsed output as `answers`, usage/
//       cost, latency); a failed or unparseable call appends NOTHING — the
//       typed failure record in the run store is the only trace.
//       Deliberately NOT the decision-call seam: the seam's contract is
//       typed question/answer sets, and a [G] output (an open checklist or
//       AC list) is not a decision — routing it through would misstate what
//       served the call. And [G] answers persist as event lines, never as
//       outcome labels: the label machinery stays [J]/gate-only (ADR-0012
//       D7 — a [G] node never decides a gate).
//   [A] plan.spec — stop + hand-off record: the work belongs to an agent
//       outside the runner; the deciding agent writes <step>.resolution and
//       the next run resumes.
//   [H] plan.gate1, draft-approval — stop + supervisor-gate emit (kind = the
//       step id, already in supervisor-gate.mjs KINDS; the gate record lives
//       in .state/supervisor/<runId>/). A resolution with approved:true
//       completes the gate; approved:false records gate-rejected and stops,
//       handing the record to the frontman. draft-approval (FOC-476) carries
//       ADR-0012 D5 semantics: the whole rendered artifact rides the gate
//       record (--artifact), the answer is approve/reject.
//   [D] plan.render, plan.push — deterministic code. plan.render (FOC-520)
//       composes the Linear issue text from the resolved reads: pure code, no
//       model call, no boundary — the same reads always render byte-identical
//       text, and malformed reads fail closed. plan.push executes over a
//       strictly injectable Linear boundary (linearEffect); the pushed
//       issueText is plan.render's output VERBATIM — the text draft-approval
//       approved is exactly the text written to Linear. The DEFAULT boundary
//       refuses: the runner NEVER writes to Linear on its own — a real write
//       is the caller's injected effect, and the refusal is a typed failure
//       record + stop.
//
// Resolution records (type "graph.resolution", key "<key>.resolution") are
// written BY the deciding agent (frontman, supervisor, Mateusz) — the runner
// consumes them, never creates them. A resolution's output is validated
// against the step's output schema; an INVALID one is refused (typed error,
// nothing appended) so a corrected resolution can be appended afterwards —
// appending a failed record would brick the step, because failed is terminal
// on resume.
//
// Every unexpected state (missing read, resolution without a base record,
// corrupt store line, store I/O failure, a throwing injected dependency,
// unknown record status) becomes a typed failure record appended to the
// store; the run stops and hands the triggering record to the frontman. The
// runner never invents an answer, never writes to Linear, and never acts on
// an A0 annotation.
//
// CLI:
//   node scripts/graph-runner.mjs run    --run-id <id> [--inputs @path.json] [--store <path>]
//   node scripts/graph-runner.mjs decide --edge <registry-entry-id> --run-id <id> --state "..." [--store <path>]
//   node scripts/graph-runner.mjs status --run-id <id> [--store <path>]

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { TypedError } from "./mcp/envelope.mjs";
import { scrub, scrubMask } from "./mcp/scrub.mjs";
import { appendShadow, canonicalJson, createDecisionCaller, DECISION_STEP, SHADOW_EVENT_TYPE, usageOf } from "./decision-call.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { getRegistryEntry, loadRegistry } from "./decision-registry.mjs";
import { appendLabel, RUNS_DIR } from "./decision-log.mjs";
import { AC_TESTABLE_DECISION, runPlanAcNode } from "./plan-ac.mjs";
import { foldGateAnswers, runPlanIntentNode } from "./plan-intent.mjs";
import { runPlanIntentSelectNode, SELECT_SCORE_DECISION, selectDeltaLabel } from "./plan-intent-select.mjs";
import { parseGate1Answer, renderGate1Display, GATE1_MAX_ROUNDS } from "./plan-intent-gate.mjs";
import { runPlanRenderNode } from "./plan-render.mjs";
import { PLAN_READINESS_DECISION, PLAN_READY_STEP, READY_MAX_ATTEMPTS, readyRetriesPathFor, runPlanReadyNode } from "./plan-ready.mjs";
import { KINDS } from "./supervisor-gate.mjs";
import { holdsForCompletion } from "./supervisor-lib.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// The cascade ladder is fixed by the registry contract: tier 1 = the seam
// call, tier 2 = dead (FOC-473 — every entry pins fallback.tier2 "disabled"),
// tier 3 = the frontman. Recorded on handed-off records as the rung the step
// ended on.
const TIER_SEAM = 1;
const TIER_FRONTMAN = 3;

// The handed-off record extras shared by runJStep ([J] steps) and decideEdge —
// both stop on the same A0/frontman contract, so both build the same typed
// payload rather than two hand-rolled copies that drift apart.
function handOffFields(stepId, envelope) {
  if (envelope.ok) {
    return {
      stepId,
      reason: "A0 — annotation recorded, decision handed to the frontman (never auto-acted; threshold null)",
      annotation: envelope.annotation,
      // FOC-451: the shadow event's id — the join key for the FOC-449 label
      // the frontman later records against this decision.
      eventId: envelope.eventId ?? null,
      tier: TIER_SEAM,
    };
  }
  return {
    stepId,
    reason: "cascade exhausted — tier 2 is disabled (FOC-473), tier 3 = frontman",
    error: envelope.error,
    tier: TIER_FRONTMAN,
  };
}

// Terminal statuses: a run that stops on one stays stopped on resume —
// recovering is the frontman's decision, never the runner's initiative.
const TERMINAL_STATUSES = new Set(["failed", "gate-rejected"]);

// The statuses that WAIT for an external actor: handed-off and gate-pending
// steps resolve through a <key>.resolution record.
const WAITING_STATUSES = new Set(["handed-off", "gate-pending"]);

// FOC-517: "reset" is not a status a step ends on — the runner appends one per
// re-entered step when the gate1 conversation turns back to plan.intent. The
// latest record per key being a reset record means RE-EXECUTE this step; the
// append-only stores the step carries forward (plan.intent's maps, gate1's
// presented + the round's answers/corrections) ride on the record and
// intentStores/resolveRead read them back.
const RESET_STATUS = "reset";

// FOC-517: the gate1 conversation's free-text classifier — one seam call per
// unparseable answer, annotation only (A0), settled by the frontman's answer,
// never by the call itself.
const REPLY_DECISION = "plan.intent.reply";

// FOC-474 eval — 7/12 calls timed out at 120 s, 12/12 succeeded at 300 s with a max of 299.2 s; 420 s leaves headroom.
export const G_TIMEOUT_MS = 420000;

// ── runner-built questions (FOC-397) ─────────────────────────────────────────
// plan.dor and plan.decompose carry no registry question set — the runner
// builds these. plan.decompose mirrors the prompt-refinement family (size +
// relations) so the decompose decision reads the same bands the frontman
// already calibrates against. Validated against the seam's question schema at
// construction: a malformed runner question is a runner bug and fails the
// factory, never a live call.

const RUNNER_QUESTIONS = {
  "plan.dor": {
    q_ready: {
      type: "noul",
      instructions:
        "Assess the dictated entry against the Definition of Ready (FENIX_WORKFLOW §3.1): " +
        "does it name a concrete, verifiable outcome with no open question blocking it?",
      criteria: {
        true: "DoR met — the entry is actionable as a Linear issue without further clarification",
        false: "DoR unmet — at least one §3.1 criterion fails; name the gaps in the resolution",
      },
    },
  },
  "plan.decompose": {
    q_size: {
      type: "choice",
      instructions: "Pick the dominant size band for the decomposed tasks (ADR-0009 amendment).",
      criteria: {
        small: "single-file, mechanical — worker/flash tier",
        medium: "one concern, bounded file set — implementer tier",
        large: "multi-file or cross-cutting — slice before committing",
      },
    },
    q_relations: {
      type: "choice",
      instructions: "How do the decomposed tasks relate to each other?",
      criteria: {
        standalone: "children can be picked in any order",
        extension: "children share context but follow one ordering",
        alternative: "children are either/or alternatives",
      },
    },
  },
};

// ── run-record store (GAPS §3.4) ─────────────────────────────────────────────

function createStore({ path }) {
  const empty = () => ({ steps: new Map(), resolutions: new Map() });

  // The store is append-only; the run state is the LATEST record per key.
  // A corrupt line is never skipped silently — it is the run's history, and
  // reading past it would resume the run on invented state.
  function load() {
    const state = empty();
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return state;
      throw new TypedError("provider_error", `run store ${path} is not readable: ${scrub(err.message)}`);
    }
    const lines = text.split("\n").filter((l) => l.trim().length);
    for (let i = 0; i < lines.length; i++) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        throw new TypedError("schema_invalid", `run store ${path} line ${i + 1} is not readable JSON`);
      }
      if (!record || typeof record !== "object" || typeof record.type !== "string") {
        throw new TypedError("schema_invalid", `run store ${path} line ${i + 1} carries no record type`);
      }
      if (record.type === "graph.step") {
        if (typeof record.key !== "string" || typeof record.status !== "string") {
          throw new TypedError("schema_invalid", `run store ${path} line ${i + 1} carries no step key or status`);
        }
        state.steps.set(record.key, record);
      } else if (record.type === "graph.resolution") {
        if (typeof record.key !== "string") {
          throw new TypedError("schema_invalid", `run store ${path} line ${i + 1} resolution carries no key`);
        }
        state.resolutions.set(record.key, record);
      } else {
        throw new TypedError("schema_invalid", `run store ${path} line ${i + 1} has unknown record type "${scrub(String(record.type))}"`);
      }
    }
    return state;
  }

  function append(record) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch (err) {
      throw new TypedError("provider_error", `run store ${path} write failed: ${scrub(err.message)}`);
    }
  }

  return { path, load, append };
}

function stepRecord(runId, now, key, status, extra = {}) {
  return { type: "graph.step", runId, ts: now(), key, status, ...extra };
}

// ── reads resolution ─────────────────────────────────────────────────────────
// A read is dotted: a run input ("inbox.entry"), a step output property
// ("plan.ac.acs"), or a whole record ("plan.spec.record",
// "gate.plan.gate1.record"). A record's operative output is its done output;
// an A0 annotation is deliberately NOT an output — downstream steps cannot
// read a decision the frontman has not made.

// plan.intent is the one step with round-dependent reads (design doc §3.12):
// round 1 reads the inbox entry, the DoR gaps and the task type; from round 2
// the gate1 answers and corrections join. The task type and the two gate1
// fields are therefore ABSENT in round 1, and that absence is a round marker
// rather than missing input — the read loop below must not fail the step over
// them. Everything else stays fail-closed: a step never guesses a read. The
// missing task type is not a hole either: the node takes the explicit
// "unknown" path and requires all eight perspectives.
const OPTIONAL_INTENT_READS = new Set([
  "intake.taskType",
  "gate.plan.gate1.answers",
  "gate.plan.gate1.corrections",
]);

// plan.intent.select joins that round-dependence (FOC-516): the two gate1
// fields are its dedupe evidence and are absent in round 1. Their absence is
// the round marker, not a missing input; the map record itself is mandatory.
const OPTIONAL_SELECT_READS = new Set([
  "gate.plan.gate1.answers",
  "gate.plan.gate1.corrections",
]);

// The answer contract's two run-record stores, read back from the step records
// this run has already appended (design doc §3.12):
//   - `run-record.plan.intent.maps[mapVersion]` — the maps the node persisted.
//     A done record carries the WHOLE store (append-only per conversation, a
//     persisted version immutable once written), so the latest one IS the
//     store and nothing has to walk the log.
//   - `run-record.gate.plan.gate1.presented[round]` — the exact items and
//     option texts put to the user, on the gate record's output where the read
//     surface resolves the sibling `answers`/`corrections`. Its write side is
//     FOC-517's; until that lands it is empty and every round-2 reference
//     folds STALE, which is the fail-closed answer rather than a silent pass.
function intentStores(records) {
  let maps = {};
  for (const record of records?.values?.() ?? []) {
    if (record?.stepId === "plan.intent" && record.maps) maps = record.maps;
  }
  return { maps, presented: records?.get?.("gate.plan.gate1")?.output?.presented ?? {} };
}

function resolveRead(read, { inputs, steps }) {
  if (Object.prototype.hasOwnProperty.call(inputs, read)) return inputs[read];
  // FOC-517: an EXACT record-key read binds to that record before any prefix
  // search — "plan.intent.confirmed" is the runner-appended derived record's
  // key, and the longest-prefix rule would otherwise dig plan.intent's output
  // for a "confirmed" property that is not there. Only a done record has an
  // operative output.
  if (steps.has(read)) {
    const exact = steps.get(read);
    return exact.status === "done" ? exact.output : undefined;
  }
  // Longest record-key prefix wins: "gate.plan.gate1.record" binds to the
  // record keyed "gate.plan.gate1", not to a hypothetical node "gate".
  let head = null;
  for (const key of steps.keys()) {
    if (read.startsWith(`${key}.`) && (head === null || key.length > head.length)) head = key;
  }
  if (head === null) return undefined;
  const rest = read.slice(head.length + 1);
  const record = steps.get(head);
  if (!record) return undefined;
  if (rest === "record") {
    return {
      stepId: record.stepId ?? head,
      key: record.key,
      status: record.status,
      output: record.output,
      ...(record.resolvedBy ? { resolvedBy: record.resolvedBy } : {}),
      // FOC-516: plan.intent's fold carries its STALE log on the record (never
      // in the output). It rides the record view so the selection's dedupe can
      // exclude refused answers — a stale answer's point must re-ask, never
      // silently disappear from the selection.
      ...(Array.isArray(record.stale) && record.stale.length ? { stale: record.stale } : {}),
    };
  }
  let value = record.output;
  for (const seg of rest.split(".")) {
    if (value === null || typeof value !== "object" || !(seg in value)) return undefined;
    value = value[seg];
  }
  return value;
}

// ── the default Linear boundary ──────────────────────────────────────────────
// [D] steps execute deterministic code through this boundary; the default
// refuses every action. The runner never writes to Linear on its own — a real
// push is the caller's injected effect (tests stub it; production callers own
// the decision to act).

function defaultLinearEffect() {
  return async ({ action }) => {
    throw new TypedError(
      "provider_error",
      `plan.push refuses "${scrub(String(action))}": the default Linear boundary performs no writes (FOC-397) — inject a linearEffect to act`,
    );
  };
}

// ── the default gate emitter ─────────────────────────────────────────────────
// [H] steps stop the run and submit the question through supervisor-gate.mjs
// (kind = the step id — plan.gate1/draft-approval are well-known kinds). The
// emitter spawns the CLI with the supervisor run/child env the runner already
// executes under; tests inject gateEmitter instead of registering children.
// A gate carrying an artifact (FOC-476, ADR-0012 D5) passes it through so the
// gate record attaches the WHOLE artifact, not a summary of it.

function defaultGateEmitter() {
  return ({ stepId, summary, facts, artifact = null }) => {
    const runId = process.env.LA_SUPERVISOR_RUN;
    const childId = process.env.LA_SUPERVISOR_CHILD;
    if (!runId || !childId) {
      throw new TypedError(
        "provider_error",
        `gate emit for "${stepId}" needs LA_SUPERVISOR_RUN and LA_SUPERVISOR_CHILD (or an injected gateEmitter)`,
      );
    }
    const args = [
      join(__dir, "supervisor-gate.mjs"), "emit",
      "--run", runId,
      "--child", childId,
      "--kind", stepId,
      "--summary", summary,
      "--facts", JSON.stringify(facts),
    ];
    if (artifact) args.push("--artifact", artifact);
    const res = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (res.status !== 0) {
      throw new TypedError(
        "provider_error",
        `supervisor-gate emit for "${stepId}" failed (exit ${res.status}): ${scrub((res.stderr || res.stdout || "").trim())}`,
      );
    }
    let gateId = null;
    try {
      gateId = JSON.parse(res.stdout).gateId ?? null;
    } catch {
      // the gate FILE is the authoritative record; the id here is provenance
    }
    return { gateId };
  };
}

// ── the default [G] generator — UNMEASURED (FOC-473 posture) ─────────────────
// One chat/completions POST with a strict json_schema response format, on the
// cheap tier from config/models.json (routing.plan.discovery → z-ai/
// glm-5.3-flash). No measured call backs this transport; it exists so the CLI
// can run end-to-end and says so. Tests inject a generator and only the
// plan-dod tests reach this code, on an injected fetch.
//
// The generator rides the registry: the entry for stepId owns the prompt (the
// words the model is asked) and the criteria version; the runner hands the
// RESOLVED reads over, and the message is composed from exactly those — the
// declared inputs, never the whole run state. A successful call (HTTP ok,
// parseable content) appends ONE FOC-449 event line to the run's
// decisions.jsonl through decision-call's own writer: the input AS SENT
// (mask-only scrub), the parsed output as `answers`, usage/cost, latency.
// [G] answers persist as event lines, never as outcome labels — the label
// machinery stays [J]/gate-only (ADR-0012 D7: a [G] node never decides a
// gate). A failed/unparseable call appends NOTHING: the step's typed failure
// record in the run store is the only trace, and no fabricated answers are
// ever written. Constructed with the run id it runs under — the event line
// keys to it like every seam-driven line.

// Node's abort timeout rejects with an AbortError (or TimeoutError through
// some adapters); either way the call never completed — a provider failure,
// not an output-shape failure.
function isAbort(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

export function createDefaultGenerator({
  apiKey,
  runId = process.env.LA_RUN_ID,
  taskKey = process.env.LA_TASK_ID ?? null,
  shadowDir = runId ? join(root, ".state", "runs", runId) : null,
  fetchImpl = fetch,
  timeoutMs = G_TIMEOUT_MS,
  now = () => new Date().toISOString(),
} = {}) {
  return async function generate({ stepId, step, reads }) {
    if (!apiKey) throw new TypedError("auth_missing", "OPENROUTER_API_KEY is absent — [G] generation fails closed");
    const startedAt = Date.now();
    // The registry entry owns the prompt; an unknown stepId is a typed
    // failure (the runner turns it into one failed record — never a guessed
    // message on the wire).
    const entry = getRegistryEntry(stepId);

    let models;
    try {
      models = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    } catch (err) {
      throw new TypedError("provider_error", `config/models.json is not readable: ${scrub(err.message)}`);
    }
    const alias = models.routing?.plan?.discovery;
    const model = models.ids?.[alias];
    if (!model) {
      throw new TypedError("provider_error", `config/models.json has no ids row for routing.plan.discovery ("${scrub(String(alias))}")`);
    }

    const message = [
      entry.prompt,
      "",
      `Produce the "${stepId}" step output for the declared inputs below. Respond with JSON matching the schema exactly.`,
      "",
      "INPUTS (declared reads, in order):",
      ...step.reads.map((r) => `- ${r}: ${JSON.stringify(reads[r] ?? null)}`),
    ].join("\n");

    let res;
    try {
      res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: message }],
          response_format: { type: "json_schema", json_schema: { name: stepId, strict: true, schema: step.output } },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isAbort(err)) throw new TypedError("provider_error", `[G] ${stepId} request timed out after ${timeoutMs}ms`);
      throw new TypedError("provider_error", `[G] ${stepId} request failed: ${scrub(err?.message || "network error")}`);
    }
    if (!res.ok) throw new TypedError("provider_error", `[G] ${stepId} returned HTTP ${res.status}`);

    let body;
    try {
      body = await res.json();
    } catch (err) {
      // The abort can fire while the body streams — a timed-out read is a
      // provider failure (measured on the eval's first pass: FOC-443 took
      // 119.9s), never a claim that the response "was not JSON".
      if (isAbort(err)) throw new TypedError("provider_error", `[G] ${stepId} request timed out after ${timeoutMs}ms`);
      throw new TypedError("unparseable_output", `[G] ${stepId} response is not JSON: ${scrub(err.message)}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new TypedError("unparseable_output", `[G] ${stepId} response carries no message content`);
    }
    let output;
    try {
      output = JSON.parse(content);
    } catch (err) {
      throw new TypedError("unparseable_output", `[G] ${stepId} content is not JSON: ${scrub(err.message)}`);
    }

    // Success ⇒ the FOC-449 event line. Input AS SENT, mask-only scrubbed
    // (no error-text cap — the cap bounds an error path, not a record whose
    // point is the complete input); questions stays null because a [G]
    // generation sends no question set. The hash mirrors inputsHash's join
    // key (model + state + questions) with the [G] call's own resolved model
    // in place of the pinned one — inputsHash hardcodes JEV_MODEL, which is
    // not what served here. Best-effort, like every shadow write.
    const usage = usageOf(body?.usage);
    const servedModel = typeof body?.model === "string" && body.model ? body.model : model;
    const eventId = shadowDir ? randomUUID() : null;
    const note = "state masked via mcp/scrub.mjs key patterns (variant: mask-only, no error-text cap); questions null — a [G] generation sends no question set";
    let input;
    try {
      input = { state: scrubMask(message), redacted: false, note };
    } catch {
      input = { state: "[REDACTED]", redacted: true, note: `${note}; unserializable input redacted in full` };
    }
    appendShadow(shadowDir, {
      ts: now(),
      runId: runId ?? null,
      hash: createHash("sha256").update(canonicalJson({ model, questions: null, state: message })).digest("hex"),
      pinnedModel: null,
      model: servedModel,
      tier: "cheap",
      mode: "live",
      ok: true,
      answers: output,
      confidence: null,
      formatConfidence: null,
      usage,
      responseId: typeof body?.id === "string" ? body.id : null,
      error: null,
      decisionId: stepId,
      criteriaVersion: entry.criteriaVersion,
      type: SHADOW_EVENT_TYPE,
      eventId,
      input: { state: input.state, questions: null },
      scrub: { variant: "mask-only", redacted: input.redacted, note: input.note },
      taskKey: taskKey ?? null,
      durationMs: Date.now() - startedAt,
    });
    return output;
  };
}

// ── the runner factory ───────────────────────────────────────────────────────

export function createGraphRunner({
  graph,
  graphPath = join(root, "config", "graph.json"),
  nodeName = "plan",
  registryPath,
  runId,
  storePath,
  caller,
  generator,
  gateEmitter,
  linearEffect,
  // FOC-612: the completion check's view of the holds store, injectable so
  // tests never touch the supervisor state home. The default reads
  // <supervisorStateHome>/<runId>/holds.json (absent store = no holds).
  listOpenHolds = holdsForCompletion,
  // FOC-516: where the gate1 selection-delta label lands (decision-log.mjs
  // layout — one decisions.jsonl per run id). Injectable so tests never write
  // the live .state/runs ledger.
  decisionRunsDir = RUNS_DIR,
  now = () => new Date().toISOString(),
} = {}) {
  if (!runId || typeof runId !== "string") {
    throw new TypedError("invalid_input", "createGraphRunner needs a runId — the run records are keyed to it");
  }
  const g = graph ?? loadGraph(graphPath);
  const problems = validateGraph(g);
  if (problems.length) {
    throw new TypedError("schema_invalid", `graph failed validation (${problems.length} problem(s)): ${problems[0]}`);
  }
  const registry = loadRegistry(registryPath ? { path: registryPath } : undefined);
  const node = g.nodes?.[nodeName];
  if (!node?.steps) {
    throw new TypedError("invalid_input", `node "${nodeName}" carries no steps — nothing to run`);
  }
  const steps = node.steps;
  const flow = node.stepFlow ?? [];

  // Walk the chain head → tail (validateGraph guarantees a single head/tail
  // and full coverage) into the execution order the run loop follows. FOC-517:
  // reentry edges (gate → earlier step) are NOT walked — the re-entry loop
  // re-walks this same order after a reset.
  const order = [];
  if (flow.length) {
    const seq = flow.filter((e) => e.type === "sequence");
    const next = new Map(seq.map((e) => [e.from, e.to]));
    let cursor = Object.keys(steps).find((id) => !seq.some((e) => e.to === id));
    while (cursor) {
      order.push(cursor);
      cursor = next.get(cursor);
    }
  } else {
    order.push(...Object.keys(steps));
  }

  const ajv = new Ajv();
  const outputValidate = new Map();
  for (const [id, step] of Object.entries(steps)) {
    outputValidate.set(id, ajv.compile(step.output ?? { type: "object" }));
  }
  const questionValidate = ajv.compile(DECISION_STEP.inputSchema.properties.questions);

  // The J/G/H contracts the runner executes are pinned at construction —
  // drift between graph.json and the registry (or a kind the runner cannot
  // honestly serve) is a construction failure, never a mid-run surprise.
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind === "J") {
      const entry = registry.entries[id];
      if (!entry) throw new TypedError("schema_invalid", `step "${id}" has no registry entry`);
      if (entry.autonomy !== "A0") throw new TypedError("schema_invalid", `step "${id}" is not an A0 entry — the runner serves annotations only`);
      if (entry.threshold !== null) throw new TypedError("schema_invalid", `step "${id}" carries a threshold — the runner never auto-acts`);
      if (entry.fallback?.tier2 !== "disabled") throw new TypedError("schema_invalid", `step "${id}" carries an enabled tier 2 — the ladder contract is broken`);
      // FOC-476: plan.ready is served through its transport entry's question
      // set (plan.readiness — instantiateEntryQuestions), not runner-built
      // questions; every other [J] step carries its questions here.
      if (id !== PLAN_READY_STEP && !RUNNER_QUESTIONS[id]) {
        throw new TypedError("schema_invalid", `step "${id}" has no runner-built question set`);
      }
      if (id !== PLAN_READY_STEP && !questionValidate(RUNNER_QUESTIONS[id])) {
        throw new TypedError("schema_invalid", `runner-built questions for "${id}" fail the seam's question schema`);
      }
    }
    if (step.kind === "H" && !KINDS.includes(id)) {
      throw new TypedError("schema_invalid", `gate step "${id}" is not a supervisor-gate kind (${KINDS.join(" | ")})`);
    }
  }
  for (const edge of g.decisionEdges ?? []) {
    const entry = registry.entries[edge.registry];
    if (!entry) throw new TypedError("schema_invalid", `decision edge "${edge.id}" has no registry entry`);
    if (entry.autonomy !== "A0" || entry.threshold !== null || entry.fallback?.tier2 !== "disabled") {
      throw new TypedError("schema_invalid", `decision edge "${edge.id}" binds an entry the runner cannot honestly serve (A0, threshold null, tier 2 disabled)`);
    }
  }

  const jStepIds = order.filter((id) => steps[id].kind === "J");
  const gStepIds = order.filter((id) => steps[id].kind === "G");
  if (jStepIds.length && typeof caller !== "function") {
    throw new TypedError("invalid_input", `the "${nodeName}" subgraph carries [J] steps (${jStepIds.join(", ")}) — inject a caller (createDecisionCaller)`);
  }
  if (gStepIds.length && typeof generator !== "function") {
    throw new TypedError("invalid_input", `the "${nodeName}" subgraph carries [G] steps (${gStepIds.join(", ")}) — inject a generator`);
  }
  // plan.ac is a [G] step that ALSO runs the node-internal testable gate
  // (FOC-475) through the seam — the same A0, threshold-null, tier-2-dead
  // posture the [J] steps pin, checked here so drift is a construction
  // failure, never a mid-run surprise.
  if (steps["plan.ac"]?.kind === "G") {
    const gateEntry = registry.entries[AC_TESTABLE_DECISION];
    if (typeof caller !== "function") {
      throw new TypedError("invalid_input", `step "plan.ac" runs the node-internal ${AC_TESTABLE_DECISION} gate — inject a caller (createDecisionCaller)`);
    }
    if (!gateEntry || gateEntry.autonomy !== "A0" || gateEntry.threshold !== null || gateEntry.fallback?.tier2 !== "disabled") {
      throw new TypedError("schema_invalid", `step "plan.ac" binds a ${AC_TESTABLE_DECISION} entry the runner cannot honestly serve (A0, threshold null, tier 2 disabled)`);
    }
  }
  // plan.intent.select is the second [G] step with a node-internal [J] call
  // (FOC-516): plan.intent.select.score scores every interpretation, the same
  // A0, threshold-null, tier-2-dead posture pinned at construction.
  if (steps["plan.intent.select"]?.kind === "G") {
    const scoreEntry = registry.entries[SELECT_SCORE_DECISION];
    if (typeof caller !== "function") {
      throw new TypedError("invalid_input", `step "plan.intent.select" runs the node-internal ${SELECT_SCORE_DECISION} call — inject a caller (createDecisionCaller)`);
    }
    if (!scoreEntry || scoreEntry.autonomy !== "A0" || scoreEntry.threshold !== null || scoreEntry.fallback?.tier2 !== "disabled") {
      throw new TypedError("schema_invalid", `step "plan.intent.select" binds a ${SELECT_SCORE_DECISION} entry the runner cannot honestly serve (A0, threshold null, tier 2 disabled)`);
    }
  }
  // plan.gate1 is the [H] step with a node-internal [J] call (FOC-517): a
  // free-text answer is classified by plan.intent.reply — the same A0,
  // threshold-null, tier-2-dead posture pinned at construction. The
  // annotation never settles the round; the frontman's answer does.
  if (steps["plan.gate1"]?.kind === "H") {
    const replyEntry = registry.entries[REPLY_DECISION];
    if (typeof caller !== "function") {
      throw new TypedError("invalid_input", `step "plan.gate1" runs the node-internal ${REPLY_DECISION} call for free-text answers — inject a caller (createDecisionCaller)`);
    }
    if (!replyEntry || replyEntry.autonomy !== "A0" || replyEntry.threshold !== null || replyEntry.fallback?.tier2 !== "disabled") {
      throw new TypedError("schema_invalid", `step "plan.gate1" binds a ${REPLY_DECISION} entry the runner cannot honestly serve (A0, threshold null, tier 2 disabled)`);
    }
  }
  // plan.ready is the [J] step served through its transport entry (FOC-476):
  // the plan.readiness seam call judges the artefacts against the confirmed
  // intent — the same A0, threshold-null, tier-2-dead posture pinned here, and
  // the question set comes from the entry itself (the plan.ac ↔
  // plan.ac.testable pattern), not from RUNNER_QUESTIONS.
  if (steps[PLAN_READY_STEP]?.kind === "J") {
    const readinessEntry = registry.entries[PLAN_READINESS_DECISION];
    if (!readinessEntry || readinessEntry.autonomy !== "A0" || readinessEntry.threshold !== null || readinessEntry.fallback?.tier2 !== "disabled") {
      throw new TypedError("schema_invalid", `step "${PLAN_READY_STEP}" binds a ${PLAN_READINESS_DECISION} entry the runner cannot honestly serve (A0, threshold null, tier 2 disabled)`);
    }
  }

  const emitGate = gateEmitter ?? defaultGateEmitter();
  const linear = linearEffect ?? defaultLinearEffect();
  const store = createStore({ path: storePath ?? join(root, ".state", "runs", runId, "graph-steps.jsonl") });
  // FOC-476: the readiness retry budget lives next to the run store — per run
  // by construction, dies with the run directory.
  const readyRetriesPath = readyRetriesPathFor(store.path);
  const recordKey = (stepId) => (steps[stepId]?.kind === "H" ? `gate.${stepId}` : stepId);

  // Validate a resolution's output against the step's output schema. An
  // invalid resolution is REFUSED, not recorded: failed is terminal on
  // resume, so a bricked step would need a hand-edit; a refusal leaves the
  // waiting record in place for a corrected resolution.
  function requireResolutionOutput(stepId, resolution) {
    const output = resolution.output;
    if (output === undefined || !outputValidate.get(stepId)(output)) {
      throw new TypedError(
        "schema_invalid",
        `resolution "${resolution.key}" carries no output matching the "${stepId}" output schema — fix the resolution and append it again`,
      );
    }
    return output;
  }

  // Executors RETURN records; run() is the only writer. A failed record stops
  // the run and carries the triggering cause for the frontman. Extra typed
  // payload (e.g. the plan.ac escalation detail) rides on the record.
  function failRecord(stepId, error, extra = {}) {
    return stepRecord(runId, now, recordKey(stepId), "failed", { stepId, error, ...extra });
  }
  // A stop the runner ITSELF produced (unexpected state) is appended here so
  // the store carries the triggering record even though no step executed.
  function stopped(stepId, record) {
    store.append(record);
    return { status: "stopped", stepId, record };
  }
  function errorOf(err, fallback) {
    return { code: err instanceof Error && err.code ? err.code : "provider_error", message: scrub(err?.message || fallback) };
  }

  // Compose the seam state string: canonical JSON of the read map in the
  // step's read order — deterministic and lossless. Over the seam's state cap
  // it fails closed rather than truncating (a truncated situation produces
  // confidently wrong decisions).
  function composeState(stepId, step, reads) {
    const composed = JSON.stringify(Object.fromEntries(step.reads.map((r) => [r, reads[r]])));
    const cap = DECISION_STEP.inputSchema.properties.state.maxLength;
    if (composed.length > cap) {
      throw new TypedError("invalid_input", `composed state for "${stepId}" exceeds the seam's state cap (${composed.length} > ${cap})`);
    }
    return composed;
  }

  // [J] — one seam call by registry id with runner-built questions; A0 ⇒ the
  // annotation is recorded and the step is handed to the frontman. The
  // ladder: tier 1 = the seam (it owns its own retries), tier 2 is dead by
  // contract, tier 3 = the frontman carrying the triggering error.
  async function runJStep(stepId, step, reads) {
    let envelope;
    try {
      envelope = await caller({ state: composeState(stepId, step, reads), decisionId: stepId, questions: RUNNER_QUESTIONS[stepId] });
    } catch (err) {
      return failRecord(stepId, errorOf(err, "caller threw"));
    }
    return stepRecord(runId, now, stepId, "handed-off", handOffFields(stepId, envelope));
  }

  // [J] FOC-476 — plan.ready, the readiness gate. ONE plan.readiness seam call
  // per attempt; the node returns the outcome and the runner turns it into
  // records:
  //   done      → the ready:true record (or the ready:false record that is
  //               only ever intermediate — see retry)
  //   retry     → the ready:false done record + ONE reset record for the
  //               failed step (carrying the reason) + one for plan.ready; the
  //               run re-walks — this is the step-level decide edge at runtime
  //               (the reason rides the reset record; the plan.spec [A]
  //               hand-off regenerates with the re-executed chain)
  //   escalate  → ONE failed record, code "readiness_escalated" — the SECOND
  //               ready:false in a run, terminal (failed is terminal on
  //               resume); over-escalation is fail-safe
  //   failed    → the node's typed failure (compose/serve/counter/schema)
  async function runPlanReadyStep(stepId, step, reads) {
    let result;
    try {
      result = await runPlanReadyNode({
        stepId,
        reads,
        caller,
        validate: (raw) => outputValidate.get(stepId)(raw),
        retriesPath: readyRetriesPath,
        runId,
        decisionRunsDir,
      });
    } catch (err) {
      return { record: failRecord(stepId, errorOf(err, "plan.ready node threw")) };
    }
    if (result.status === "failed") return { record: failRecord(stepId, result.error) };
    const extras = {
      output: result.output,
      eventId: result.eventId ?? null,
      confidence: result.confidence ?? null,
      attempt: result.attempt,
      ...(result.labels?.length ? { labels: result.labels } : {}),
      ...(result.labelWarnings?.length ? { labelWarnings: result.labelWarnings } : {}),
    };
    if (result.status === "done") {
      return { record: stepRecord(runId, now, stepId, "done", { stepId, ...extras }) };
    }
    if (result.status === "escalate") {
      return {
        record: failRecord(stepId, {
          code: "readiness_escalated",
          message: `plan.ready escalated after ${result.attempt} attempt(s): ${result.output.reason}`,
        }, { ...extras, escalation: result.escalation }),
      };
    }
    // retry — the first ready:false. The failed step's reset record carries
    // the reason (the re-executed step's own trail shows why it is redoing
    // work); plan.ready's reset marks the re-ask.
    const doneRecord = stepRecord(runId, now, stepId, "done", {
      stepId,
      ...extras,
      reason: "ready:false — the step-level decide edge re-enters the failed step (second ready:false escalates)",
    });
    const resets = [
      stepRecord(runId, now, result.failedStep, RESET_STATUS, {
        stepId: result.failedStep,
        output: { readyReason: result.output.reason },
      }),
      stepRecord(runId, now, stepId, RESET_STATUS, { stepId }),
    ];
    return { retry: true, done: doneRecord, resets };
  }

  // [G] — one schema-validated model call; the runner validates whatever the
  // generator returns against the step's output schema (single choke point).
  // plan.ac is the ONE [G] step with a node-internal quality loop (FOC-475):
  // the FOC-452 plan.ac.testable gate scores every generated criterion, the
  // node regenerates once carrying the gate's reasons, then escalates typed.
  // The loop is node-internal — the graph-level retry EDGE is FOC-476's, and
  // no graph edge is added here.
  async function runGStep(stepId, step, reads, records) {
    if (stepId === "plan.intent") {
      // plan.intent carries the answer contract's two run-record stores
      // (design doc §3.12): its own persisted maps, append-only per
      // conversation, and gate1's `presented` (FOC-517's write side). Each
      // done record carries the WHOLE map store, so the latest record is the
      // store — round 1 sees both empty and the fold is a no-op.
      let result;
      try {
        result = await runPlanIntentNode({
          stepId,
          step,
          reads,
          generator,
          validate: (raw) => outputValidate.get(stepId)(raw),
          ...intentStores(records),
        });
      } catch (err) {
        return failRecord(stepId, errorOf(err, "plan.intent node threw"));
      }
      const stale = result.fold?.stale ?? [];
      if (result.status === "done") {
        return stepRecord(runId, now, stepId, "done", {
          stepId,
          output: result.output,
          mapVersion: result.mapVersion,
          maps: result.maps,
          ...(stale.length ? { stale } : {}),
        });
      }
      return failRecord(stepId, result.error, {
        ...(stale.length ? { stale } : {}),
        ...(result.problems?.length ? { problems: result.problems } : {}),
      });
    }
    if (stepId === "plan.intent.select") {
      // FOC-516: the selection over the persisted map. No [G] model call —
      // deterministic routing plus the node-internal [J] scoring call; the
      // result carries the [J] eventId (the FOC-449 join key for the gate1
      // delta label) and the deduped ids the policy filtered out.
      let result;
      try {
        result = await runPlanIntentSelectNode({
          stepId,
          reads,
          caller,
          validate: (raw) => outputValidate.get(stepId)(raw),
        });
      } catch (err) {
        return failRecord(stepId, errorOf(err, "plan.intent.select node threw"));
      }
      if (result.status === "done") {
        return stepRecord(runId, now, stepId, "done", {
          stepId,
          output: result.output,
          eventId: result.eventId ?? null,
          ...(result.scores?.length ? { scores: result.scores } : {}),
          ...(result.dedupedIds?.length ? { dedupedIds: result.dedupedIds } : {}),
        });
      }
      return failRecord(stepId, result.error);
    }
    if (stepId === "plan.ac") {
      let result;
      try {
        result = await runPlanAcNode({
          stepId,
          step,
          reads,
          generator,
          caller,
          validate: (raw) => outputValidate.get(stepId)(raw),
        });
      } catch (err) {
        return failRecord(stepId, errorOf(err, "plan.ac node threw"));
      }
      if (result.status === "done") {
        return stepRecord(runId, now, stepId, "done", { stepId, output: result.output });
      }
      return failRecord(stepId, result.error, result.escalation ? { escalation: result.escalation } : {});
    }
    let raw;
    try {
      raw = await generator({ stepId, step, reads });
    } catch (err) {
      return failRecord(stepId, errorOf(err, "generator threw"));
    }
    if (!outputValidate.get(stepId)(raw)) {
      return failRecord(stepId, { code: "schema_invalid", message: `[G] ${stepId} output failed the step's output schema` });
    }
    return stepRecord(runId, now, stepId, "done", { stepId, output: raw });
  }

  // [A] — the work belongs to an agent outside the runner; record the
  // hand-off with the resolved reads the agent needs, and stop.
  function runAStep(stepId, reads) {
    return stepRecord(runId, now, stepId, "handed-off", {
      stepId,
      reason: "[A] step — work handed to the deciding agent; write <step>.resolution to resume",
      handoff: { stepId, reads },
    });
  }

  // [H] — stop and emit the supervisor gate; the gate record lives in the
  // supervisor run directory, the run record marks the run as waiting.
  const GATE_SUMMARIES = {
    "plan.gate1": "Answer the intent conversation (FOC-517) — confirm what PLAN understood or correct it; ≤3 rounds before the DoD/AC/spec hand-off",
    "draft-approval": "Approve the rendered issue (plan.render) before the Linear push",
  };
  async function runHStep(stepId, reads, state) {
    const summary = GATE_SUMMARIES[stepId] ?? `Approve "${stepId}" before the run continues`;
    let facts = { runId, reads };
    let pendingOutput;
    if (stepId === "plan.gate1") {
      // FOC-517: the round number and the displayed slice are runner-computed
      // from the accumulated presented store — the round the display shows is
      // the round the answer contract settles against. The gate facts carry
      // the display so the supervisor gate file shows what was asked.
      const prior = state.steps.get(`gate.${stepId}`);
      const accumulated = prior?.output?.presented ?? {};
      const round = Object.keys(accumulated).length + 1;
      const selection = reads["plan.intent.select.record"];
      const intent = reads["plan.intent.record"];
      let view;
      try {
        view = renderGate1Display({
          round,
          selection: selection?.output ?? null,
          interpretations: intent?.output?.interpretations ?? [],
        });
      } catch (err) {
        return failRecord(stepId, errorOf(err, "gate1 display render threw"));
      }
      facts = { ...facts, display: view.display, round };
      pendingOutput = {
        round,
        presented: { ...accumulated, [String(round)]: view.presented },
        display: view.display,
      };
      if (view.dropped) pendingOutput.dropped = view.dropped;
    }
    if (stepId === "draft-approval") {
      // FOC-476: ADR-0012 D5 — the gate record carries the WHOLE artifact. The
      // rendered issue text is written to the run dir and the gate facts point
      // at the file; the reads in the facts still carry the text itself, so
      // the record shows exactly what was asked. A missing/empty text is a
      // typed failure, never an artifact-less gate.
      const issueText = reads["plan.render.issueText"];
      if (typeof issueText !== "string" || !issueText.trim()) {
        return failRecord(stepId, { code: "invalid_input", message: 'draft-approval: the "plan.render.issueText" read is missing or empty — a draft gate approves a rendered artifact, never nothing' });
      }
      try {
        const artifactPath = join(dirname(store.path), "draft-approval-issue.md");
        writeFileSync(artifactPath, issueText, "utf8");
        facts = { ...facts, artifact: artifactPath };
      } catch (err) {
        return failRecord(stepId, errorOf(err, "the draft-approval artifact could not be written"));
      }
    }
    let emitted;
    try {
      emitted = await emitGate({ stepId, gateKind: stepId, summary, facts, artifact: facts.artifact ?? null });
    } catch (err) {
      return failRecord(stepId, errorOf(err, "gate emitter threw"));
    }
    return stepRecord(runId, now, `gate.${stepId}`, "gate-pending", {
      stepId,
      gateKind: stepId,
      gateId: emitted?.gateId ?? null,
      summary,
      ...(pendingOutput ? { output: pendingOutput } : {}),
    });
  }

  // FOC-476: the no-push outcomes (draft-approval answered reject, an
  // egress-blocked push) carry their FOC-449 label on the plan.ready event —
  // the readiness attempt's seam event is the run's last [J] decision. By
  // vocabulary: a human gate answer labels "human", a code-side refusal
  // "agent". Best-effort — a failed label is a warning on the record, never a
  // broken primary flow; no plan.ready event → nothing labelled, nothing
  // warned.
  function labelPlanReadyEvent(state, outcome, by, via) {
    const eventId = state.steps.get(PLAN_READY_STEP)?.eventId ?? null;
    if (!eventId) return null;
    const label = { eventId, outcome, by, via };
    try {
      const res = appendLabel({ eventId, outcome, by, source: "auto", via, runId, runsDir: decisionRunsDir });
      return { ...label, written: res.path };
    } catch (err) {
      return { ...label, warning: err?.message ?? "label write failed" };
    }
  }

  // [D] — deterministic code. plan.render (FOC-520) composes the Linear issue
  // text from the resolved reads — no model call, no boundary; the same reads
  // always render byte-identical text and malformed reads fail closed. The
  // draft-approval facts carry the rendered text, and plan.push's payload
  // takes it VERBATIM — what the gate approved is what would be written to
  // Linear, no rewording anywhere. plan.push's payload is shaped here
  // (deterministically, from the resolved reads); the injectable Linear
  // boundary performs whatever writes it was injected to perform, and its
  // egress screen (FOC-450/473 discipline) refusing the payload is a typed
  // EGRESS_BLOCKED failure — no mutation, run stops, outcome labelled on the
  // plan.ready event. Any other [D] step id has no runner implementation and
  // fails typed — never a guessed execution.
  async function runDStep(stepId, reads, state) {
    if (stepId === "plan.render") {
      let result;
      try {
        result = runPlanRenderNode({ stepId, reads, validate: (raw) => outputValidate.get(stepId)(raw) });
      } catch (err) {
        return failRecord(stepId, errorOf(err, "plan.render node threw"));
      }
      if (result.status === "done") {
        return stepRecord(runId, now, stepId, "done", { stepId, output: result.output });
      }
      return failRecord(stepId, result.error);
    }
    if (stepId !== "plan.push") {
      return failRecord(stepId, { code: "invalid_input", message: `[D] step "${scrub(String(stepId))}" has no runner implementation — a [D] step is plan.render or plan.push` });
    }
    const decompose = reads["plan.decompose.record"];
    const gate = reads["gate.draft-approval.record"];
    const payload = {
      runId,
      epicTitle: `Plan — dictated entry (run ${runId})`,
      issueText: reads["plan.render.issueText"],
      children: (decompose?.output?.tasks ?? []).map((t) => ({ title: t.title, size: t.size, labels: t.labels, relations: t.relations })),
      handoffComment: `Planned by the FOC-397 graph runner (run ${runId}); gate draft-approval ${gate?.status ?? "unknown"}.`,
    };
    let result;
    try {
      result = await linear({ action: "push-plan", payload });
    } catch (err) {
      if (err?.code === "EGRESS_BLOCKED") {
        // FOC-476: the boundary's egress screen refused the payload — fail
        // closed before any mutation, stop the run, and carry the outcome on
        // the plan.ready event (best-effort; the store's typed failure is the
        // authoritative trace).
        const label = labelPlanReadyEvent(state, "plan.push.egress_blocked", "agent", "egress-screen");
        return failRecord(stepId, errorOf(err, "the Linear boundary refused the payload (egress screen)"), label ? { label } : {});
      }
      return failRecord(stepId, errorOf(err, "linear effect threw"));
    }
    const output = {
      epicId: result?.epicId,
      childrenIds: result?.childrenIds,
      handoffCommentPosted: result?.handoffCommentPosted,
    };
    if (!outputValidate.get(stepId)(output)) {
      return failRecord(stepId, { code: "schema_invalid", message: `[D] ${stepId} linear effect returned a shape that fails the step's output schema` });
    }
    return stepRecord(runId, now, stepId, "done", { stepId, output });
  }

  // One decide-edge call (D4), addressed BY REGISTRY ID: decisionEdges bind
  // graph edges to registry entries, and the caller names the entry (e.g.
  // "orchestration.next_step"). The entry carries its own question set, so
  // the seam serves it through resolveEntryQuestions — no runner-built
  // questions here. A0 ⇒ annotation + frontman hand-off, never auto-act; the
  // ladder behaves exactly as for a [J] step.
  async function decideEdge(registryId, { state } = {}) {
    const edge = (g.decisionEdges ?? []).find((e) => e.registry === registryId);
    if (!edge) throw new TypedError("invalid_input", `no decision edge binds registry entry "${scrub(String(registryId))}"`);
    const key = `decide.${registryId}`;
    const current = store.load();
    const record = current.steps.get(key);
    if (record) {
      const resolution = current.resolutions.get(`${key}.resolution`);
      return resolution ? { status: "resolved", record, resolution } : { status: "handed-off", record };
    }
    let envelope;
    try {
      envelope = await caller({ state: String(state ?? ""), decisionId: registryId });
    } catch (err) {
      const rec = stepRecord(runId, now, key, "failed", { stepId: registryId, error: errorOf(err, "caller threw") });
      store.append(rec);
      return { status: "stopped", stepId: key, record: rec };
    }
    const rec = stepRecord(runId, now, key, "handed-off", handOffFields(registryId, envelope));
    store.append(rec);
    return { status: "handed-off", record: rec };
  }

  // ── FOC-517: the gate1 conversation ─────────────────────────────────────────
  // ONE plan.intent.reply seam call per free-text (unparseable) answer: the
  // raw dictated answer plus the round's presented slice go in, the
  // classification + touched ids come out as an ANNOTATION (A0 — recorded next
  // to the answer, shown to the frontman, never acted on). The call failing
  // closed throws — the round cannot settle on an invented classification.
  async function annotateReply(round, shown, answer) {
    const instances = [
      ...(shown.understood ?? []),
      ...(shown.confirmations ?? []),
      ...(shown.assumptions ?? []),
      ...(shown.questions ?? []).map((q) => ({ id: q.id, claim: q.claim })),
    ].slice(0, 12);
    const state = canonicalJson({ round, answer, presented: shown });
    const cap = DECISION_STEP.inputSchema.properties.state.maxLength;
    if (state.length > cap) {
      throw new TypedError("invalid_input", `plan.intent.reply: the annotation state exceeds the seam's state cap (${state.length} > ${cap})`);
    }
    let envelope;
    try {
      envelope = await caller({ state, decisionId: REPLY_DECISION, instances });
    } catch (err) {
      throw new TypedError(
        err instanceof Error && err.code ? err.code : "provider_error",
        `plan.gate1: the ${REPLY_DECISION} call failed closed: ${err?.message || "caller threw"}`,
      );
    }
    if (!envelope.ok) {
      throw new TypedError(
        envelope.error?.code ?? "provider_error",
        `plan.gate1: the ${REPLY_DECISION} call returned an error envelope: ${envelope.error?.message ?? "unknown"}`,
      );
    }
    const answers = envelope.annotation?.answers ?? {};
    const touched = instances
      .map((inst, i) => (answers[`touched${i}`]?.noul === true ? inst.id : null))
      .filter((id) => id !== null);
    return {
      classification: answers.reply?.choice ?? null,
      touched,
      eventId: envelope.eventId ?? null,
      confidence: envelope.annotation?.confidence ?? null,
    };
  }

  // The gate1 settlement: a resolution answers ONE presented round. The runner
  // — never the deciding agent — computes confirmed, the round bookkeeping and
  // the parsed answers/corrections; an agent-supplied copy of a computed field
  // is cross-checked and refused on mismatch. A resolution older than the
  // pending record is STALE (it answered an earlier round; the re-entry
  // re-emits the gate) and waits without being applied. Outcomes:
  //   confirmed      → done record + the plan.intent.confirmed record; the
  //                    chain continues (plan.dod reads the confirmed map)
  //   not confirmed  → done record + one reset record per re-entered step;
  //                    run() re-walks the chain. ≤3 rounds, then a typed
  //                    intent_not_settled stop — the plan is never built on
  //                    an unconfirmed intent
  //   free text      → one plan.intent.reply annotation on a handed-off
  //                    record; the frontman settles the round by appending a
  //                    NEW resolution carrying answers/corrections — the raw
  //                    answer is kept verbatim, the annotation only pre-fills
  //                    the next round
  async function settleGate1({ state, record, resolution }) {
    const output = requireResolutionOutput("plan.gate1", resolution); // throws on invalid — nothing appended
    if (output.approved === false) {
      const rejected = stepRecord(runId, now, "gate.plan.gate1", "gate-rejected", {
        stepId: "plan.gate1",
        reason: "gate answered rejected — handed to the frontman",
        output,
      });
      store.append(rejected);
      state.steps.set("gate.plan.gate1", rejected);
      return { action: "stopped", record: rejected };
    }
    const resTs = Date.parse(resolution.ts ?? "");
    const pendingTs = Date.parse(record.ts ?? "");
    if (Number.isFinite(resTs) && Number.isFinite(pendingTs) && resTs < pendingTs) {
      return { action: "waiting", record };
    }

    const round = record.output?.round;
    const presented = record.output?.presented ?? {};
    const shown = presented[round];
    if (!Number.isInteger(round) || !shown) {
      throw new TypedError(
        "schema_invalid",
        `the pending plan.gate1 record carries no presented slice for round ${scrub(String(round))} — the conversation cannot be settled against nothing`,
      );
    }
    const maps = intentStores(state.steps).maps;
    const parsed = parseGate1Answer(output.answer, round, shown);

    let answers;
    let corrections;
    let reply = record.output?.reply ?? null;
    if (parsed.kind === "free") {
      answers = output.answers ?? [];
      corrections = output.corrections ?? [];
      if (!answers.length && !corrections.length) {
        if (record.status === "handed-off" && record.output?.answer === output.answer) {
          return { action: "waiting", record }; // already annotated, nothing new
        }
        reply = await annotateReply(round, shown, output.answer);
        const handedOff = stepRecord(runId, now, "gate.plan.gate1", "handed-off", {
          stepId: "plan.gate1",
          reason: "free-text answer — the plan.intent.reply annotation is recorded; the frontman settles the round with answers/corrections in a NEW gate.plan.gate1.resolution (the annotation never settles it)",
          tier: TIER_SEAM,
          output: { approved: true, answer: output.answer, round, presented, reply },
        });
        store.append(handedOff);
        state.steps.set("gate.plan.gate1", handedOff);
        return { action: "waiting", record: handedOff };
      }
    } else {
      answers = parsed.answers;
      corrections = parsed.corrections;
      // An agent-supplied copy of a runner-computed field is cross-checked —
      // a mismatch is a refused resolution, not a silent overwrite.
      for (const [field, computed] of [["answers", parsed.answers], ["corrections", parsed.corrections]]) {
        if (output[field] !== undefined && canonicalJson(output[field]) !== canonicalJson(computed)) {
          throw new TypedError(
            "schema_invalid",
            `the resolution's ${field} do not match what the runner parsed from the answer — fix the resolution or drop the field (the runner computes ${field})`,
          );
        }
      }
    }

    // Fold-validate every answer/correction against the presented slice and
    // the persisted map — the same reference contract the round-2 fold
    // applies. STALE references are recorded (the point re-asks next round),
    // never silently dropped.
    const fold = foldGateAnswers({ round, maps, presented, answers, corrections });
    const settledAnswers = fold.valid.filter((v) => v.kind === "answer").map((v) => v.record);
    const settledCorrections = fold.valid.filter((v) => v.kind === "correction").map((v) => v.record);
    const stale = fold.stale;

    const answeredIds = new Set(settledAnswers.map((a) => a.interpretationId));
    const confirmed = settledCorrections.length === 0
      && (shown.questions ?? []).every((q) => answeredIds.has(q.id));
    if (output.confirmed !== undefined && output.confirmed !== confirmed) {
      throw new TypedError(
        "schema_invalid",
        `the resolution claims confirmed=${String(output.confirmed)} but the runner computes confirmed=${String(confirmed)} — confirmed is always runner-computed`,
      );
    }

    if (!confirmed && round >= GATE1_MAX_ROUNDS) {
      const failed = failRecord("plan.gate1", {
        code: "intent_not_settled",
        message: `the intent conversation did not settle in ${GATE1_MAX_ROUNDS} rounds — round ${round} still carries corrections or unanswered presented questions; the plan is never built on an unconfirmed intent`,
      }, {
        output: {
          approved: true,
          answer: output.answer,
          confirmed: false,
          round,
          answers: settledAnswers,
          corrections: settledCorrections,
          presented,
          ...(reply ? { reply } : {}),
          ...(stale.length ? { stale } : {}),
        },
      });
      store.append(failed);
      state.steps.set("gate.plan.gate1", failed);
      return { action: "stopped", record: failed };
    }

    const doneOutput = {
      approved: true,
      answer: output.answer,
      confirmed,
      round,
      answers: settledAnswers,
      corrections: settledCorrections,
      presented,
      ...(reply ? { reply } : {}),
    };
    const done = stepRecord(runId, now, "gate.plan.gate1", "done", {
      stepId: "plan.gate1",
      output: doneOutput,
      resolvedBy: resolution.by ?? null,
      ...(stale.length ? { stale } : {}),
    });
    // FOC-516: the FOC-449 selection delta is labelled wherever Mateusz's
    // answers exist — the settled records replace the old run-input path. A
    // failed write is a warning on the record, never a broken primary flow.
    const sel = state.steps.get("plan.intent.select");
    const label = selectDeltaLabel({
      selection: sel?.output ?? null,
      answers: settledAnswers,
      corrections: settledCorrections,
      eventId: sel?.eventId ?? null,
    });
    if (label) {
      let written = null;
      let warning = null;
      try {
        const res = appendLabel({
          eventId: label.eventId,
          outcome: label.outcome,
          by: label.by,
          source: label.source,
          via: label.via,
          runId,
          runsDir: decisionRunsDir,
        });
        written = res.path;
      } catch (err) {
        warning = err?.message ?? "label write failed";
      }
      done.deltaLabel = label;
      if (written) done.deltaLabelWritten = written;
      if (warning) done.deltaLabelWarning = warning;
    }
    store.append(done);
    state.steps.set("gate.plan.gate1", done);

    if (confirmed) {
      // The chain continues on the CONFIRMED intent only: the derived record
      // is what plan.dod/plan.ac/plan.spec read from here on.
      const intentOut = state.steps.get("plan.intent")?.output ?? {};
      const confirmedRecord = stepRecord(runId, now, "plan.intent.confirmed", "done", {
        stepId: "plan.intent.confirmed",
        output: {
          goal: intentOut.goal ?? null,
          why: intentOut.why ?? null,
          mapVersion: shown.mapVersion,
          interpretations: intentOut.interpretations ?? [],
          answers: settledAnswers,
          corrections: settledCorrections,
          round,
        },
      });
      store.append(confirmedRecord);
      state.steps.set("plan.intent.confirmed", confirmedRecord);
      return { action: "continue" };
    }

    // Re-entry: the round folds into plan.intent — the map regenerates with
    // the answers/corrections folded (round-2 reads resolve from the reset
    // record's output), plan.intent.select re-asks, gate1 shows round n+1.
    const resets = [
      stepRecord(runId, now, "plan.intent", RESET_STATUS, { stepId: "plan.intent", maps }),
      stepRecord(runId, now, "plan.intent.select", RESET_STATUS, { stepId: "plan.intent.select" }),
      stepRecord(runId, now, "gate.plan.gate1", RESET_STATUS, {
        stepId: "plan.gate1",
        output: {
          presented,
          answers: settledAnswers,
          corrections: settledCorrections,
          ...(stale.length ? { stale } : {}),
        },
      }),
    ];
    for (const reset of resets) {
      store.append(reset);
      state.steps.set(reset.key, reset);
    }
    return { action: "reenter" };
  }

  async function run({ inputs = {} } = {}, reentries = 0, readyRetries = 0) {
    const state = store.load();

    for (const stepId of order) {
      const step = steps[stepId];
      const key = recordKey(stepId);
      const record = state.steps.get(key);
      const resolution = state.resolutions.get(`${key}.resolution`);

      if (record && TERMINAL_STATUSES.has(record.status)) {
        return { status: "stopped", stepId, record };
      }

      if (record?.status === "skipped") continue; // resolved out-of-band, no output

      if (record && WAITING_STATUSES.has(record.status)) {
        if (!resolution) return { status: "stopped", stepId, record };
        // FOC-517: gate1's conversation has its own settlement (the parsed
        // answer, the round bookkeeping, the re-entry) — every other waiting
        // step keeps the generic resolution path below.
        if (step.kind === "H" && stepId === "plan.gate1") {
          const outcome = await settleGate1({ state, record, resolution });
          if (outcome.action === "stopped") return { status: "stopped", stepId, record: outcome.record };
          if (outcome.action === "waiting") return { status: "stopped", stepId, record: outcome.record };
          if (outcome.action === "reenter") {
            // An unconfirmed round re-enters plan.intent: re-walk the chain
            // from the top on a freshly loaded store. Rounds are bounded (≤3),
            // so re-entries are too — the cap here is the walk breaking loose,
            // not the conversation.
            if (reentries + 1 > GATE1_MAX_ROUNDS - 1) {
              return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: "gate1 re-entry exceeded the round cap — round accounting is broken" }));
            }
            return run({ inputs }, reentries + 1);
          }
          continue; // confirmed — the chain continues on the confirmed intent
        }
        const output = requireResolutionOutput(stepId, resolution); // throws on invalid — nothing appended
        if (step.kind === "H" && output.approved === false) {
          const rejected = stepRecord(runId, now, key, "gate-rejected", { stepId, reason: "gate answered rejected — handed to the frontman", output });
          // FOC-476: a rejected draft never pushes — the outcome label rides
          // the plan.ready event (best-effort).
          const noPushLabel = labelPlanReadyEvent(state, "plan.ready.approved=false", "human", "gate");
          if (noPushLabel) rejected.noPushLabel = noPushLabel;
          store.append(rejected);
          return { status: "stopped", stepId, record: rejected };
        }
        const done = stepRecord(runId, now, key, "done", { stepId, output, resolvedBy: resolution.by ?? null });
        store.append(done);
        state.steps.set(key, done);
        continue;
      }

      if (record?.status === "done") continue;

      if (record?.status === RESET_STATUS) {
        // FOC-517 re-entry: the latest record for this step is a reset marker
        // — re-execute the step. The append-only stores it carries forward
        // (plan.intent's maps, gate1's presented + the round's answers/
        // corrections) are read back by intentStores and resolveRead from
        // this same record.
      } else if (record) {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `step "${stepId}" is in unknown record status "${scrub(String(record.status))}"` }));
      }

      // A resolution with no run record at all is a typed failure. A record
      // that is a reset marker re-executes instead — its earlier round's
      // resolution was already consumed by that settlement and stays in the
      // append-only store; it is history, not a pending answer (FOC-517).
      if (!record && resolution) {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `resolution "${key}.resolution" exists with no run record for "${stepId}"` }));
      }

      // Execute. Reads resolve before the step runs; a missing read is a
      // typed failure record, never a guess.
      const reads = {};
      for (const read of step.reads ?? []) {
        const value = resolveRead(read, { inputs, steps: state.steps });
        if (value === undefined) {
          // Round-dependent reads of plan.intent and plan.intent.select are
          // absent by design in round 1; the key stays out of the read map and
          // the nodes read that as "round 1" and "task type unknown".
          if (stepId === "plan.intent" && OPTIONAL_INTENT_READS.has(read)) continue;
          if (stepId === "plan.intent.select" && OPTIONAL_SELECT_READS.has(read)) continue;
          return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `read "${read}" is not available for step "${stepId}" — no resolved run record or run input supplies it` }));
        }
        reads[read] = value;
      }

      let next;
      if (stepId === PLAN_READY_STEP) {
        // FOC-476: the readiness gate has its own executor — the retry path
        // appends THREE records (the ready:false done record, the failed
        // step's reset, plan.ready's reset) and re-walks; every other outcome
        // is a single record.
        const outcome = await runPlanReadyStep(stepId, step, reads);
        if (outcome.retry) {
          store.append(outcome.done);
          state.steps.set(outcome.done.key, outcome.done);
          for (const reset of outcome.resets) {
            store.append(reset);
            state.steps.set(reset.key, reset);
          }
          // The decide-edge walk is bounded twice over: the per-run counter
          // makes the second ready:false escalate (never a third walk), and
          // this cap catches a counter that somehow failed to persist.
          if (readyRetries + 1 > READY_MAX_ATTEMPTS - 1) {
            return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: "plan.ready re-entry exceeded the retry budget — the attempt counter is broken" }));
          }
          return run({ inputs }, reentries, readyRetries + 1);
        }
        next = outcome.record;
      } else if (step.kind === "J") next = await runJStep(stepId, step, reads);
      else if (step.kind === "G") next = await runGStep(stepId, step, reads, state.steps);
      else if (step.kind === "A") next = runAStep(stepId, reads);
      else if (step.kind === "H") next = await runHStep(stepId, reads, state);
      else if (step.kind === "D") next = await runDStep(stepId, reads, state);
      else {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `step "${stepId}" has unknown kind "${scrub(String(step.kind))}"` }));
      }

      store.append(next);
      state.steps.set(next.key, next);

      if (next.status !== "done") {
        return { status: "stopped", stepId, record: next };
      }
    }

    // FOC-612: a run is not complete while a hold is open. Deliberately a RUN
    // rule at the close point, not a turn-end rule — the guard only blocks on
    // holds that still owe their presentation, because a hold deferred 30 days
    // must not wedge every turn end forever. Completion is stricter: even a
    // deferred hold is unanswered, and a run that closed over an open question
    // would report Done work nobody decided on. The refusal is returned, not
    // appended: a wait is not a failure, and the holds store itself is the
    // persistent record of what is owed — appending a failed record per
    // attempt would pollute the store every retry.
    const holds = listOpenHolds(runId);
    if (holds.error) {
      return {
        status: "stopped",
        stepId: "holds.close",
        record: failRecord("holds.close", {
          code: "holds_unreadable",
          message: `the holds store for run ${runId} could not be read: ${holds.error} — a store nobody can parse is not a store`,
        }),
      };
    }
    if (holds.open.length) {
      return {
        status: "stopped",
        stepId: "holds.close",
        record: failRecord("holds.close", {
          code: "holds_open",
          message:
            `run ${runId} is not complete while ${holds.open.length} hold(s) are open: ` +
            `${holds.open.map((h) => h.id).join(", ")} — answer them ` +
            `(node scripts/supervisor-gate.mjs answer --hold <id>) or the run stays open`,
        }, {
          openHolds: holds.open.map((h) => ({ id: h.id, question: h.question })),
        }),
      };
    }
    return { status: "completed", runId };
  }

  return { runId, run, decideEdge, storePath: store.path, order };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// The live CLI wires the real seam caller and the (unmeasured) default
// generator; every other dependency keeps its fail-closed default. Failures
// print one typed JSON envelope to stdout and exit 1 — the same contract as
// the rest of the scripts family.

function failCli(err) {
  console.log(JSON.stringify({ ok: false, error: { code: err?.code ?? "provider_error", message: err?.message ?? String(err) } }, null, 2));
  process.exit(1);
}

function parseValue(raw, flagName) {
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    failCli(new TypeError(`--${flagName} is not readable JSON: ${err.message}`));
  }
}

// The seam logs its event lines under the run it is given; without the
// explicit runId the [J] events key to an ambient LA_RUN_ID instead of the
// CLI's --run-id.
export function createLiveCaller({ runId, apiKey = process.env.OPENROUTER_API_KEY, create = createDecisionCaller } = {}) {
  return create({ apiKey, runId });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("usage: node scripts/graph-runner.mjs <run|decide|status> --run-id <id> [--inputs @path.json] [--edge <registry-entry-id>] [--state ...] [--store <path>]");
    return 0;
  }

  const runId = flag("run-id");
  if (!runId) failCli(new TypeError("--run-id <supervisorRunId> is required — the run records are keyed by it"));
  const runner = createGraphRunner({
    runId,
    storePath: flag("store"),
    caller: createLiveCaller({ runId }),
    generator: createDefaultGenerator({ apiKey: process.env.OPENROUTER_API_KEY, runId }),
  });

  if (cmd === "run") {
    const raw = flag("inputs");
    const result = await runner.run({ inputs: raw ? parseValue(raw, "inputs") : {} });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  }
  if (cmd === "decide") {
    const registryId = flag("edge");
    if (!registryId) failCli(new TypeError("--edge <registry entry id> is required (e.g. orchestration.next_step)"));
    const result = await runner.decideEdge(registryId, { state: flag("state") ?? "" });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  }
  if (cmd === "status") {
    const state = createStore({ path: runner.storePath }).load();
    console.log(JSON.stringify({
      ok: true,
      runId,
      steps: [...state.steps.values()].map((r) => ({ key: r.key, status: r.status, ts: r.ts })),
      resolutions: [...state.resolutions.keys()],
    }, null, 2));
    return 0;
  }
  failCli(new TypeError(`unknown subcommand "${scrub(String(cmd))}" — run | decide | status`));
}

if (process.argv[1]?.endsWith("graph-runner.mjs")) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => failCli(err),
  );
}