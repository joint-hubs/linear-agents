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
//       autonomy). Every plan J entry is autonomy A0 with threshold null, so
//       a served answer is recorded as an ANNOTATION and the step is handed
//       to the frontman — never auto-acted. Cascade ladder: tier 1 = the seam
//       call (the seam owns its own retries), tier 2 is dead by contract
//       (every entry pins fallback.tier2 "disabled", FOC-473), tier 3 =
//       frontman hand-off carrying the triggering envelope error.
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
//   [H] plan.gate1, plan.gate2 — stop + supervisor-gate emit (kind = the step
//       id, already in supervisor-gate.mjs KINDS; the gate record lives in
//       .state/supervisor/<runId>/). A resolution with approved:true completes
//       the gate; approved:false records gate-rejected and stops, handing the
//       record to the frontman.
//   [D] plan.push — deterministic code over a strictly injectable Linear
//       boundary (linearEffect). The DEFAULT boundary refuses: the runner
//       NEVER writes to Linear on its own — a real write is the caller's
//       injected effect, and the refusal is a typed failure record + stop.
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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { TypedError } from "./mcp/envelope.mjs";
import { scrub, scrubMask } from "./mcp/scrub.mjs";
import { appendShadow, canonicalJson, createDecisionCaller, DECISION_STEP, SHADOW_EVENT_TYPE, usageOf } from "./decision-call.mjs";
import { loadGraph, validateGraph } from "./graph-validate.mjs";
import { getRegistryEntry, loadRegistry } from "./decision-registry.mjs";
import { KINDS } from "./supervisor-gate.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// The cascade ladder is fixed by the registry contract: tier 1 = the seam
// call, tier 2 = dead (FOC-473 — every entry pins fallback.tier2 "disabled"),
// tier 3 = the frontman. Recorded on handed-off records as the rung the step
// ended on.
const TIER_SEAM = 1;
const TIER_FRONTMAN = 3;

// Terminal statuses: a run that stops on one stays stopped on resume —
// recovering is the frontman's decision, never the runner's initiative.
const TERMINAL_STATUSES = new Set(["failed", "gate-rejected"]);

// The statuses that WAIT for an external actor: handed-off and gate-pending
// steps resolve through a <key>.resolution record.
const WAITING_STATUSES = new Set(["handed-off", "gate-pending"]);

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

function resolveRead(read, { inputs, steps }) {
  if (Object.prototype.hasOwnProperty.call(inputs, read)) return inputs[read];
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
// (kind = the step id — plan.gate1/plan.gate2 are well-known kinds). The
// emitter spawns the CLI with the supervisor run/child env the runner already
// executes under; tests inject gateEmitter instead of registering children.

function defaultGateEmitter() {
  return ({ stepId, summary, facts }) => {
    const runId = process.env.LA_SUPERVISOR_RUN;
    const childId = process.env.LA_SUPERVISOR_CHILD;
    if (!runId || !childId) {
      throw new TypedError(
        "provider_error",
        `gate emit for "${stepId}" needs LA_SUPERVISOR_RUN and LA_SUPERVISOR_CHILD (or an injected gateEmitter)`,
      );
    }
    const res = spawnSync(
      process.execPath,
      [
        join(__dir, "supervisor-gate.mjs"), "emit",
        "--run", runId,
        "--child", childId,
        "--kind", stepId,
        "--summary", summary,
        "--facts", JSON.stringify(facts),
      ],
      { encoding: "utf8" },
    );
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
  timeoutMs = 120000,
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
  // and full coverage) into the execution order the run loop follows.
  const order = [];
  if (flow.length) {
    const next = new Map(flow.map((e) => [e.from, e.to]));
    let cursor = Object.keys(steps).find((id) => !flow.some((e) => e.to === id));
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
      if (!RUNNER_QUESTIONS[id]) throw new TypedError("schema_invalid", `step "${id}" has no runner-built question set`);
      if (!questionValidate(RUNNER_QUESTIONS[id])) {
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

  const emitGate = gateEmitter ?? defaultGateEmitter();
  const linear = linearEffect ?? defaultLinearEffect();
  const store = createStore({ path: storePath ?? join(root, ".state", "runs", runId, "graph-steps.jsonl") });
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
  // the run and carries the triggering cause for the frontman.
  function failRecord(stepId, error) {
    return stepRecord(runId, now, recordKey(stepId), "failed", { stepId, error });
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
    if (envelope.ok) {
      return stepRecord(runId, now, stepId, "handed-off", {
        stepId,
        reason: "A0 — annotation recorded, decision handed to the frontman (never auto-acted; threshold null)",
        annotation: envelope.annotation,
        tier: TIER_SEAM,
      });
    }
    return stepRecord(runId, now, stepId, "handed-off", {
      stepId,
      reason: "cascade exhausted — tier 2 is disabled (FOC-473), tier 3 = frontman",
      error: envelope.error,
      tier: TIER_FRONTMAN,
    });
  }

  // [G] — one schema-validated model call; the runner validates whatever the
  // generator returns against the step's output schema (single choke point).
  async function runGStep(stepId, step, reads) {
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
    "plan.gate1": "Approve the SPEC hand-off (plan.spec) before decomposition",
    "plan.gate2": "Approve the decomposition (plan.decompose) before the Linear push",
  };
  async function runHStep(stepId, reads) {
    const summary = GATE_SUMMARIES[stepId] ?? `Approve "${stepId}" before the run continues`;
    let emitted;
    try {
      emitted = await emitGate({ stepId, gateKind: stepId, summary, facts: { runId, reads } });
    } catch (err) {
      return failRecord(stepId, errorOf(err, "gate emitter threw"));
    }
    return stepRecord(runId, now, `gate.${stepId}`, "gate-pending", {
      stepId,
      gateKind: stepId,
      gateId: emitted?.gateId ?? null,
      summary,
    });
  }

  // [D] — deterministic code over the injectable Linear boundary. The payload
  // is shaped here (deterministically, from the resolved reads); the boundary
  // performs whatever writes it was injected to perform.
  async function runDStep(stepId, reads) {
    const decompose = reads["plan.decompose.record"];
    const gate2 = reads["gate.plan.gate2.record"];
    const payload = {
      runId,
      epicTitle: `Plan — dictated entry (run ${runId})`,
      children: (decompose?.output?.tasks ?? []).map((t) => ({ title: t.title, size: t.size, labels: t.labels, relations: t.relations })),
      handoffComment: `Planned by the FOC-397 graph runner (run ${runId}); gate plan.gate2 ${gate2?.status ?? "unknown"}.`,
    };
    let result;
    try {
      result = await linear({ action: "push-plan", payload });
    } catch (err) {
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
    const rec = envelope.ok
      ? stepRecord(runId, now, key, "handed-off", {
          stepId: registryId,
          reason: "A0 — annotation recorded, decision handed to the frontman (never auto-acted; threshold null)",
          annotation: envelope.annotation,
          // FOC-451: the shadow event's id — the join key for the FOC-449 label
          // the frontman later records against this decision.
          eventId: envelope.eventId ?? null,
          tier: TIER_SEAM,
        })
      : stepRecord(runId, now, key, "handed-off", {
          stepId: registryId,
          reason: "cascade exhausted — tier 2 is disabled (FOC-473), tier 3 = frontman",
          error: envelope.error,
          tier: TIER_FRONTMAN,
        });
    store.append(rec);
    return { status: "handed-off", record: rec };
  }

  async function run({ inputs = {} } = {}) {
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
        const output = requireResolutionOutput(stepId, resolution); // throws on invalid — nothing appended
        if (step.kind === "H" && output.approved === false) {
          const rejected = stepRecord(runId, now, key, "gate-rejected", { stepId, reason: "gate answered rejected — handed to the frontman", output });
          store.append(rejected);
          return { status: "stopped", stepId, record: rejected };
        }
        const done = stepRecord(runId, now, key, "done", { stepId, output, resolvedBy: resolution.by ?? null });
        store.append(done);
        state.steps.set(key, done);
        continue;
      }

      if (record?.status === "done") continue;

      if (record) {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `step "${stepId}" is in unknown record status "${scrub(String(record.status))}"` }));
      }

      if (resolution) {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `resolution "${key}.resolution" exists with no run record for "${stepId}"` }));
      }

      // Execute. Reads resolve before the step runs; a missing read is a
      // typed failure record, never a guess.
      const reads = {};
      for (const read of step.reads ?? []) {
        const value = resolveRead(read, { inputs, steps: state.steps });
        if (value === undefined) {
          return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `read "${read}" is not available for step "${stepId}" — no resolved run record or run input supplies it` }));
        }
        reads[read] = value;
      }

      let next;
      if (step.kind === "J") next = await runJStep(stepId, step, reads);
      else if (step.kind === "G") next = await runGStep(stepId, step, reads);
      else if (step.kind === "A") next = runAStep(stepId, reads);
      else if (step.kind === "H") next = await runHStep(stepId, reads);
      else if (step.kind === "D") next = await runDStep(stepId, reads);
      else {
        return stopped(stepId, failRecord(stepId, { code: "invalid_input", message: `step "${stepId}" has unknown kind "${scrub(String(step.kind))}"` }));
      }

      store.append(next);
      state.steps.set(next.key, next);

      if (next.status !== "done") {
        return { status: "stopped", stepId, record: next };
      }
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

function createLiveCaller() {
  return createDecisionCaller({ apiKey: process.env.OPENROUTER_API_KEY });
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
    caller: createLiveCaller(),
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