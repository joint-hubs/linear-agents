// scripts/mcp/steps.mjs — the two built decision steps of the FOC-401 family
// (docs/mcp-decision-steps-catalog.md is the catalog; this file is the build).
//
// A step is config plus deterministic code:
//   · inputSchema / outputSchema — JSON Schema, enforced fail-closed by
//     envelope.mjs; outputs stay SHORT per ADR-0012 D5;
//   · toJev(input) / fromJev(answers, mapped) — the mapping onto the tier-1
//     Jev Decisions API. The deterministic part of the work stays code (the
//     candidate split for extraction, the size→squads routing map for prompt
//     refinement); the model only verifies/scores/classifies — the [J] shape
//     of ADR-0012 D1 and GAPS §3.2;
//   · offlineDecide(input) — the deterministic path (no model call): the
//     extraction candidates returned unverified, and a clearly labeled sample
//     for prompt refinement. Both still pass the output schema.
//
// Full schemas (with field-by-field rationale) live in the catalog; these
// objects are the executable source of truth.

import { TypedError } from "./envelope.mjs";
import { probabilityOf, choiceOf, confidenceOf } from "./provider-jev.mjs";

export const SIZES = ["small", "medium", "large"];
export const RELATIONS = ["standalone", "extension", "alternative"];

// ADR-0009 amendment (2026-09-19, FOC-383): engagement depth per task size.
// The Supervisor keeps its standing duties in every scenario; this map is the
// [D] half of the routing — the model classifies, the code routes.
const SQUADS_BY_SIZE = {
  small: [],
  medium: ["dev", "test"],
  large: ["plan", "dev", "review", "test"],
};

export function squadsForSize(size) {
  return [...(SQUADS_BY_SIZE[size] ?? [])];
}

/**
 * [D] candidate split for extraction: dictated text in, candidate fragments
 * out. Deliberately naive and replaceable (newline / semicolon / comma /
 * common PL+EN conjunctions) — Jev §3.1: the deterministic part stays code,
 * the model only verifies. Duplicate neighbours collapse; output is capped.
 */
export function splitCandidates(text, { maxCandidates = 12, maxNameLength = 120 } = {}) {
  const out = [];
  for (const piece of String(text).split(/\r?\n+|;+|,+|\s+(?:i|oraz|a|ale|plus|potem|and|also|then)\s+/gi)) {
    const name = piece.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (out.length >= maxCandidates) break;
    if (out[out.length - 1] === name) continue;
    out.push(name.slice(0, maxNameLength));
  }
  return out;
}

// ── extraction ──────────────────────────────────────────────────────────────
// Dictated free text in, short typed JSON of expected features out.
// Cascade entry: tier-1 Jev verifies each code-split candidate (noul);
// the enumeration itself is code, not a model call.

export const EXTRACTION_STEP = {
  name: "extraction",
  inputSchema: {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: {
      text: { type: "string", minLength: 1, maxLength: 8000 },
      language: { type: "string", enum: ["pl", "en", "auto"] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["features"],
    additionalProperties: false,
    properties: {
      features: {
        type: "array",
        minItems: 0,
        maxItems: 12,
        items: {
          type: "object",
          required: ["name", "kind"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            kind: { enum: ["feature", "constraint", "question"] },
            confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
          },
        },
      },
      notes: { type: ["string", "null"], maxLength: 300 },
    },
  },
  toJev(input) {
    const candidates = splitCandidates(input.text);
    if (!candidates.length) {
      throw new TypedError("invalid_input", "dictated text produced no candidate fragments");
    }
    // Measured live contract (2026-09-19): questions is a record keyed by id,
    // criteria a record of label → description; a noul question's labels are
    // exactly "true"/"false". Ids are position-stable (q0..qN) and carry no
    // user content.
    const ids = candidates.map((_, i) => `q${i}`);
    const state = [
      'Dictated user text (verbatim; may contain corrupted dictation such as "kif i czeryf" for "feature"):',
      input.text,
      input.language ? `Language hint: ${input.language}` : "",
    ].filter(Boolean).join("\n");
    return {
      state,
      questions: Object.fromEntries(candidates.map((name, i) => [
        ids[i],
        {
          type: "noul",
          instructions: `Is this dictated fragment a concrete, buildable expectation? Fragment: "${name}". Answer true only if a developer could open a task from it without asking the user what the words mean.`,
          criteria: {
            true: "concrete expected feature or change",
            false: "greeting, context, meta-talk, or unactionable fragment",
          },
        },
      ])),
      ids,
      candidates,
    };
  },
  fromJev(body, mapped) {
    // Response shape measured live (2026-09-19): answers is a RECORD keyed by
    // the question ids. Anything else is a shape change of the alpha endpoint
    // and stays a typed error (the Path B trigger), never a guess.
    const answers = body?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new TypedError(
        "unparseable_output",
        `decisions answers: expected a record keyed by question id, got ${Array.isArray(answers) ? "an array" : typeof answers}`,
      );
    }
    const features = [];
    const measured = [];
    mapped.ids.forEach((id, i) => {
      const p = probabilityOf(answers[id]);
      if (p === null) {
        throw new TypedError("unparseable_output", `decisions answers[${id}]: no numeric noul probability in [0,1]`);
      }
      // Envelope confidence must express certainty of the VERDICT (accept or
      // reject), not the probability of "true": a rejected candidate with
      // p=0.05 is a confident rejection (certainty 0.95), so the per-answer
      // figure is max(p, 1−p) — the distance from the coin flip — and the
      // aggregate below is the min of those. A raw min(p) over all answers
      // inverted this and reported probability-of-wrongness as the envelope
      // confidence (measured live 2026-09-19: features accepted at 0.87/0.85
      // under an envelope confidence of 0.05/0.04). Still native probabilities
      // only — nothing estimated (ADR-0012 D3.6).
      measured.push(Math.max(p, 1 - p));
      // p > 0.5 is the coin-flip reading of the native probability, NOT a
      // calibrated auto-fire threshold — those stay deferred until the ECE/
      // Brier calibration task (ADR-0012 D2). Consumers treat the decision
      // as a proposal carrying its measurement.
      if (p > 0.5) {
        features.push({ name: mapped.candidates[i], kind: "feature", confidence: p });
      }
    });
    return {
      decision: { features, notes: null },
      confidence: measured.length ? Math.min(...measured) : null,
    };
  },
  offlineDecide(input) {
    const features = splitCandidates(input.text).map((name) => ({
      name,
      kind: "feature",
      confidence: null,
    }));
    return {
      decision: {
        features,
        notes: "offline path: candidates from deterministic splitting, not model-verified",
      },
      confidence: null,
    };
  },
};

// ── prompt refinement ───────────────────────────────────────────────────────
// Squad prompt + features in, overall size (ADR-0009 amendment) + feature
// relations out. Cascade entry: tier-1 Jev classifies size and per-feature
// relation (choice, measured confidence); the size→squads routing is code.

export const PROMPT_REFINEMENT_STEP = {
  name: "prompt-refinement",
  inputSchema: {
    type: "object",
    required: ["prompt"],
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 8000 },
      features: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            size: { enum: SIZES },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["size", "squads"],
    additionalProperties: false,
    properties: {
      size: { enum: SIZES },
      squads: {
        type: "array",
        maxItems: 4,
        uniqueItems: true,
        items: { enum: ["plan", "dev", "review", "test"] },
      },
      relations: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["name", "relation"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            relation: { enum: RELATIONS },
          },
        },
      },
      rationale: { type: ["string", "null"], maxLength: 300 },
      confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    },
  },
  toJev(input) {
    const features = input.features ?? [];
    const state = [
      "Squad prompt (drafted by the squad lead):",
      input.prompt,
      features.length ? "Features:" : "",
      ...features.map((f) => `- ${f.name}${f.size ? ` (size: ${f.size})` : ""}`),
    ].filter(Boolean).join("\n");
    // Measured live contract (2026-09-19): questions is a record keyed by id;
    // stable ids ("size", "rel0..relN") carry no user content.
    const questions = {
      size: {
        type: "choice",
        instructions: "Classify the overall task size for frontman engagement (ADR-0009 amendment).",
        criteria: {
          small: "small and easy — the Supervisor does the work itself, no squads",
          medium: "medium or complicated — DEV + TEST squads",
          large: "large and very complex — full triage PLAN → DEV → REVIEW → TEST",
        },
      },
    };
    const ids = ["size"];
    features.forEach((f, i) => {
      const id = `rel${i}`;
      ids.push(id);
      questions[id] = {
        type: "choice",
        instructions: `How does the feature "${f.name}" relate to the other features in this task?`,
        criteria: {
          standalone: "independent of the other features",
          extension: "extends or refines another feature listed here",
          alternative: "an alternative to another feature (either/or)",
        },
      };
    });
    return { state, questions, ids, features };
  },
  fromJev(body, mapped) {
    // Response shape measured live (2026-09-19): answers is a RECORD keyed by
    // the question ids — an array is the pre-change shape and must fail closed.
    const answers = body?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new TypedError(
        "unparseable_output",
        `decisions answers: expected a record keyed by question id, got ${Array.isArray(answers) ? "an array" : typeof answers}`,
      );
    }
    const size = choiceOf(answers[mapped.ids[0]], SIZES);
    if (!size) {
      throw new TypedError("unparseable_output", "size answer carries no parsable choice");
    }
    const relations = [];
    const measured = [];
    const sizeConfidence = confidenceOf(answers[mapped.ids[0]]);
    if (sizeConfidence !== null) measured.push(sizeConfidence);
    mapped.features.forEach((f, i) => {
      const id = mapped.ids[i + 1];
      const relation = choiceOf(answers[id], RELATIONS);
      if (!relation) {
        throw new TypedError("unparseable_output", `relation answer ${id} is not parsable`);
      }
      const c = confidenceOf(answers[id]);
      if (c !== null) measured.push(c);
      relations.push({ name: f.name, relation });
    });
    // rationale stays null: Jev's Decisions API returns measured choices, not
    // prose — a synthesized rationale would be fabricated text (D3.6 spirit).
    return {
      decision: {
        size,
        squads: squadsForSize(size),
        relations,
        rationale: null,
        confidence: measured.length ? Math.min(...measured) : null,
      },
      confidence: measured.length ? Math.min(...measured) : null,
    };
  },
  offlineDecide() {
    // Static sample — clearly labeled, never presented as a model answer.
    return {
      decision: {
        size: "medium",
        squads: squadsForSize("medium"),
        relations: [
          { name: "kif (feature extraction)", relation: "standalone" },
          { name: "czeryf (feature extraction)", relation: "standalone" },
          { name: "webhook retry", relation: "extension" },
        ],
        rationale: null,
        confidence: null,
      },
      confidence: null,
    };
  },
};
