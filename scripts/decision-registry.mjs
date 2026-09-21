// scripts/decision-registry.mjs — the decision & node registry loader (FOC-448).
//
// config/decisions.json is the one typed place for every model-made judgment
// and every v2 graph-node step: the seven PLAN entries carry the ADR-0012 D7
// contract copied verbatim from docs/plans/graph-json-v2-design.md §3.1–§3.9,
// and the three transport entries (gate.screen, extraction,
// prompt-refinement) carry the question set their call-site sends to the
// decision-call seam. This module loads + validates that file fail-closed —
// a registry that does not parse, does not pass its schema, or carries an
// id that disagrees with its key is a typed error, never a guessed lookup —
// exposes lookup by id, resolves concrete question sets for the seam, and
// instantiates the per-candidate/per-feature question templates for the
// migrated FOC-401 steps.
//
// Import direction (no cycles): this loader must NOT import
// decision-call.mjs. The anti-drift check of the registry's question values
// against the seam's own question schema lives in
// scripts/decisions-registry.test.mjs; a decisionId call re-validates its
// resolved questions against the seam's input schema at call time, so a
// drifted registry fails closed at the seam too.
//
// Template conventions (transport entries with per-instance questions):
//   · a question-template KEY may carry `{i}` — replaced by the instance
//     index ("q{i}" → q0..qN-1, "rel{i}" → rel0..relN);
//   · a template VALUE may carry `{{var}}` placeholders — substituted from
//     the per-instance vars; an unresolved placeholder fails closed.
// A concrete entry (no {i} keys, no {{var}}) is served verbatim.
//
// Errors use the shared typed families (scripts/mcp/envelope.mjs
// ERROR_CODES): unknown id / template misuse → invalid_input; a registry
// file that is missing or unreadable → provider_error; unparseable JSON,
// schema-invalid entries or a non-compilable output schema →
// schema_invalid. Messages quote ids and paths, never question content
// (ids are caller-supplied, so they are scrubbed).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { TypedError } from "./mcp/envelope.mjs";
import { scrub } from "./mcp/scrub.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = join(__dir, "..", "config", "decisions.json");

// ── per-entry schema (one source: the loader enforces it at load, the ───────
// registry test re-asserts it and adds the seed-set content pins)

export const ENTRY_SCHEMA = {
  type: "object",
  required: ["id", "kind", "owner", "hookPoint", "autonomy", "threshold", "fallback", "metrics", "criteriaVersion"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$" },
    kind: { enum: ["D", "J", "A", "H", "G"] },
    owner: { type: "string", minLength: 1, maxLength: 200 },
    hookPoint: { type: "string", minLength: 1, maxLength: 300 },
    autonomy: { enum: ["A0", "A1", "A2", null] },
    threshold: { type: ["number", "null"] },
    fallback: {
      type: "object",
      required: ["tier2", "onModelFailure"],
      additionalProperties: false,
      properties: {
        // "disabled" is the only loadable state while FALLBACK_MODEL is null
        // (FOC-473); re-arming tier 2 is a deliberate change to this schema
        // AND the shipped entries together, pinned by the registry test.
        tier2: { const: "disabled" },
        onModelFailure: { type: "string", minLength: 1, maxLength: 300 },
        note: { type: "string", maxLength: 300 },
      },
    },
    metrics: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: { enum: ["durationMs", "inputTokens", "outputTokens", "cost", "confidence"] },
    },
    criteriaVersion: { type: "integer", minimum: 1 },
    // D7 node fields (graph-node entries) — copied verbatim into
    // config/graph.json v2 step objects by the runner (FOC-397).
    reads: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
    output: { type: "object" },
    tier: {
      oneOf: [
        { type: "null" },
        { const: "cheap" },
        { const: "agent" },
        {
          type: "object",
          additionalProperties: false,
          required: ["cascade", "min"],
          properties: { cascade: { const: true }, min: { type: "integer", minimum: 1, maximum: 3 } },
        },
      ],
    },
    failure: { enum: ["stop", "escalate"] },
    writes: { enum: ["run-record", "envelope", "graph-state"] },
    // [G] seed prompt (plan.ac only, pending FOC-397).
    prompt: { type: "string", minLength: 1, maxLength: 4000 },
    // Transport question set — structural only here. The full question
    // contract is decision-call's own schema: the registry test validates
    // the shipped file against it (anti-drift), and a decisionId call
    // re-validates the resolved set at the seam on every call.
    questions: { type: "object", minProperties: 1, maxProperties: 12, additionalProperties: true },
  },
  allOf: [
    // D7 node entry (reads present): the full D7 list is required and the
    // question set is not allowed next to it.
    {
      if: { required: ["reads"] },
      then: { required: ["output", "tier", "failure", "writes"], not: { required: ["questions"] } },
    },
    // Transport entry (questions present): no D7 fields, no prompt.
    {
      if: { required: ["questions"] },
      then: {
        not: {
          anyOf: [
            { required: ["reads"] },
            { required: ["output"] },
            { required: ["tier"] },
            { required: ["failure"] },
            { required: ["writes"] },
            { required: ["prompt"] },
          ],
        },
      },
    },
    // prompt exists only on a [G] generator, and a [G] entry carries one.
    { if: { required: ["prompt"] }, then: { properties: { kind: { const: "G" } } } },
    { if: { properties: { kind: { const: "G" } }, required: ["kind"] }, then: { required: ["prompt"] } },
    // Tier per kind (design doc §6.3): [D]/[H] make no model call, [J] pins
    // the cascade minimum, [G] is cheap-tier, [A] is agent work.
    { if: { properties: { kind: { enum: ["D", "H"] } }, required: ["kind"] }, then: { properties: { tier: { type: "null" } } } },
    {
      if: { properties: { kind: { const: "J" } }, required: ["kind"] },
      then: {
        properties: {
          tier: {
            type: "object",
            additionalProperties: false,
            required: ["cascade", "min"],
            properties: { cascade: { const: true }, min: { type: "integer", minimum: 1, maximum: 3 } },
          },
        },
      },
    },
    { if: { properties: { kind: { const: "G" } }, required: ["kind"] }, then: { properties: { tier: { const: "cheap" } } } },
    { if: { properties: { kind: { const: "A" } }, required: ["kind"] }, then: { properties: { tier: { const: "agent" } } } },
    // Metrics: [D]/[H] make no model call; [J] decisions carry measured
    // confidence; [G]/[A] report usage facts without a decision confidence.
    // (`type: "array"` on every metrics subschema keeps ajv strict mode quiet.)
    { if: { properties: { kind: { enum: ["D", "H"] } }, required: ["kind"] }, then: { properties: { metrics: { type: "array", maxItems: 0 } } } },
    { if: { properties: { kind: { const: "J" } }, required: ["kind"] }, then: { properties: { metrics: { type: "array", contains: { const: "confidence" } } } } },
    { if: { properties: { kind: { enum: ["G", "A"] } }, required: ["kind"] }, then: { properties: { metrics: { type: "array", not: { contains: { const: "confidence" } } } } } },
  ],
};

export const REGISTRY_SCHEMA = {
  type: "object",
  required: ["_doc", "entries"],
  additionalProperties: false,
  properties: {
    _doc: { type: "object" },
    entries: { type: "object", minProperties: 1, additionalProperties: ENTRY_SCHEMA },
  },
};

const ajv = new Ajv({ allErrors: false });
let validateRegistry = null;

// Loose structural check on question values. The full contract check lives
// at the seam (input schema, per call) and in the registry test (anti-drift
// against decision-call's own question schema); this only catches gross
// malformation at load time without duplicating the seam's schema.
function assertQuestionShape(entryId, qid, q) {
  const ok = q && typeof q === "object" && !Array.isArray(q)
    && (q.type === "noul" || q.type === "choice" || q.type === "score")
    && typeof q.instructions === "string" && q.instructions.length > 0
    && q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria)
    && Object.keys(q.criteria).length > 0;
  if (!ok) {
    throw new TypedError("schema_invalid", `decision registry: entry "${entryId}" question "${qid}" is not a typed question (type/instructions/criteria)`);
  }
}

/**
 * Load + validate the registry. Throws TypedError on any failure — a broken
 * registry never degrades into a guessed lookup.
 */
export function loadRegistry({ path = DEFAULT_REGISTRY_PATH } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new TypedError("provider_error", `decision registry not readable: ${scrub(String(err?.code || err?.message || path))}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new TypedError("schema_invalid", `decision registry is not valid JSON: ${scrub(err?.message || "")}`);
  }
  if (!validateRegistry) validateRegistry = ajv.compile(REGISTRY_SCHEMA);
  if (!validateRegistry(data)) {
    const summary = (validateRegistry.errors || []).slice(0, 3)
      .map((e) => `${e.instancePath || "(root)"}: ${e.keyword}`).join("; ");
    throw new TypedError("schema_invalid", `decision registry failed its schema: ${scrub(summary)}`);
  }
  for (const [key, entry] of Object.entries(data.entries)) {
    if (entry.id !== key) {
      throw new TypedError("schema_invalid", `decision registry: entry id "${entry.id}" does not match its key "${key}"`);
    }
    if (entry.questions) {
      for (const [qid, q] of Object.entries(entry.questions)) assertQuestionShape(entry.id, qid, q);
    }
    if (entry.output) {
      try {
        ajv.compile(entry.output);
      } catch (err) {
        throw new TypedError("schema_invalid", `decision registry: entry "${entry.id}" output is not a compilable JSON Schema: ${scrub(err?.message || "")}`);
      }
    }
  }
  return data;
}

/**
 * Lookup by id. Unknown / non-string ids fail closed (invalid_input).
 * opts.path is a TEST SEAM (a fixture registry file); production callers
 * never set it.
 */
export function getRegistryEntry(id, { path } = {}) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypedError("invalid_input", "decision id must be a non-empty string");
  }
  const registry = loadRegistry({ path });
  const entry = registry.entries[id];
  if (!entry) throw new TypedError("invalid_input", `unknown decision id: ${scrub(id)}`);
  return entry;
}

function containsPlaceholder(value) {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some((v) => containsPlaceholder(v));
  if (value && typeof value === "object") return Object.values(value).some((v) => containsPlaceholder(v));
  return false;
}

/**
 * The CONCRETE question set a decisionId call sends to the decision-call
 * seam, with the autonomy facts the seam needs. Entries without a question
 * set (graph-node entries — the runner builds their questions) and entries
 * carrying per-instance templates (the owning step instantiates them) fail
 * closed: the seam never sends a half-resolved question to the model.
 */
export function resolveEntryQuestions(id, opts = {}) {
  const entry = getRegistryEntry(id, opts);
  if (!entry.questions) {
    // Messages stay under the scrub cap (MAX_ERROR_TEXT) so the provenance
    // marker survives to the caller at the decision-call seam.
    throw new TypedError("invalid_input", `decision entry "${entry.id}" carries no question set — graph-node questions are built in the runner (FOC-397)`);
  }
  const templateKey = Object.keys(entry.questions).find((k) => k.includes("{i}"));
  if (templateKey || containsPlaceholder(entry.questions)) {
    throw new TypedError("invalid_input", `decision entry "${entry.id}" carries question templates — instantiate via the registry loader (FOC-448)`);
  }
  return { questions: entry.questions, autonomy: entry.autonomy, criteriaVersion: entry.criteriaVersion };
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function substitute(text, vars, entryId, qkey) {
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (!(name in vars)) {
      throw new TypedError("invalid_input", `decision entry "${entryId}" question "${qkey}": unresolved placeholder {{${name}}}`);
    }
    return String(vars[name]);
  });
}

function substituteQuestion(value, vars, entryId, qkey) {
  if (typeof value === "string") return substitute(value, vars, entryId, qkey);
  if (Array.isArray(value)) return value.map((v) => substituteQuestion(v, vars, entryId, qkey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteQuestion(v, vars, entryId, qkey)]));
  }
  return value;
}

/**
 * Instantiate a transport entry's question templates. `instances` is an
 * array of var records ({name: "..."}); a template key carrying {i} fans
 * out one question per instance ("q{i}" with two instances → q0, q1);
 * fixed keys are copied verbatim and must not carry placeholders. This is
 * how the migrated FOC-401 steps build their question records
 * (per-candidate / per-feature instantiation stays in the step).
 */
export function instantiateEntryQuestions(id, instances, opts = {}) {
  const entry = getRegistryEntry(id, opts);
  if (!entry.questions) {
    throw new TypedError("invalid_input", `decision entry "${entry.id}" carries no question templates`);
  }
  if (!Array.isArray(instances)) {
    throw new TypedError("invalid_input", "instances must be an array of var records");
  }
  const questions = {};
  for (const [key, template] of Object.entries(entry.questions)) {
    if (key.includes("{i}")) {
      instances.forEach((vars, i) => {
        if (!vars || typeof vars !== "object") {
          throw new TypedError("invalid_input", `decision entry "${entry.id}": instance ${i} is not a var record`);
        }
        questions[key.replace("{i}", String(i))] = substituteQuestion(template, vars, entry.id, key);
      });
    } else {
      if (containsPlaceholder(template)) {
        throw new TypedError("invalid_input", `decision entry "${entry.id}": fixed question "${key}" carries an unresolved {{placeholder}}`);
      }
      questions[key] = template;
    }
  }
  if (Object.keys(questions).length === 0) {
    throw new TypedError("invalid_input", `decision entry "${entry.id}": instantiation produced an empty question set`);
  }
  return questions;
}
