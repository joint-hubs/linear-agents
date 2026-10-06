#!/usr/bin/env node
/**
 * scripts/plan-intent-gate.mjs — the gate1 conversation surface (FOC-517).
 *
 * Two pure functions over the FOC-516 selection output:
 *   - renderGate1Display: the Polish ≤14-line display of what PLAN understood,
 *     plus the `presented[round]` slice the display implies — the write side
 *     of run-record.gate.plan.gate1.presented (items ACTUALLY shown; anything
 *     dropped by the budget is not presented and must re-ask next round).
 *   - parseGate1Answer: the answer parser over one round's presented slice —
 *     structured picks ("1b 2a"), corrections ("c nie …"), the whole-"ok"
 *     accept, and the free-text fallback that routes the answer to the
 *     plan.intent.reply annotation instead of the fold.
 *
 * The parser is deliberately strict: anything it cannot pin to exactly one
 * presented item — leading prose, trailing prose after a pick, a duplicate
 * pick, an out-of-range letter — makes the WHOLE answer free text. A half-
 * parsed dictated answer would fold half a sentence onto the wrong points.
 */

// The display budget (design doc §3.6): header + three blocks + optional
// overflow marker, never more than 14 lines.
export const GATE1_MAX_LINES = 14;
export const GATE1_MAX_ROUNDS = 3;

const IN_ID = /^IN-([1-9]|1[0-2])$/;

// ── display ──────────────────────────────────────────────────────────────────

function claimLine(prefix, item, quotes) {
  const quote = quotes.get(item.id);
  return quote ? `${prefix}${item.claim} — „${quote}"` : `${prefix}${item.claim}`;
}

/**
 * Render the round's display and return the presented slice it implies.
 *
 * `selection` is the plan.intent.select record's OUTPUT ({mapVersion,
 * questions, confirmations, understood, assumptions}); `interpretations` is
 * the plan.intent record's map (quote lookup by id). Priority when the budget
 * bites: questions > "Założyłem" > "Rozumiem tak"; drops always come from the
 * end of the lowest-priority block that still has items, and a question is
 * never split from its options line.
 */
export function renderGate1Display({ round, maxRounds = GATE1_MAX_ROUNDS, selection, interpretations = [] }) {
  if (!selection || typeof selection !== "object") {
    throw Object.assign(new Error("renderGate1Display needs the plan.intent.select record's output"), { code: "invalid_input" });
  }
  if (!Number.isInteger(round) || round < 1) {
    throw Object.assign(new Error("renderGate1Display needs an integer round"), { code: "invalid_input" });
  }
  const quotes = new Map((interpretations ?? []).filter((i) => i && IN_ID.test(i.id ?? "")).map((i) => [i.id, i.quote]));

  const questions = (selection.questions ?? []).filter((q) => q && IN_ID.test(q.id) && Array.isArray(q.options));
  const confirmations = (selection.confirmations ?? []).filter((c) => c && IN_ID.test(c.id));
  const assumptions = (selection.assumptions ?? []).filter((a) => a && IN_ID.test(a.id));
  const understood = (selection.understood ?? []).filter((u) => u && IN_ID.test(u.id));

  // Candidate lines, cheapest to drop last: questions carry 2 lines each and
  // the highest priority; the assumption block 1 line per item; understood 1
  // line per item and the lowest priority.
  const renderQuestion = (q, n) => [
    `${n}) ${q.claim}`,
    "   " + q.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o.text}${o.recommended ? " ◀ rekomendowane" : ""}`).join("   "),
  ];
  const renderBlock2 = (item, letter) => `${letter}) ${item.claim}`;

  let shownQ = [...questions];
  let shownC = [...confirmations];
  let shownA = [...assumptions];
  let shownU = [...understood];
  let dropped = 0;
  const countLines = () =>
    1 /* header */
    + (shownQ.length ? 1 + shownQ.reduce((n, q) => n + 2, 0) : 0)
    + (shownC.length + shownA.length ? 1 + shownC.length + shownA.length : 0)
    + (shownU.length ? 1 + shownU.length : 0)
    + (dropped ? 1 : 0);
  while (countLines() > GATE1_MAX_LINES) {
    if (shownU.length) {
      shownU.pop();
    } else if (shownA.length) {
      shownA.pop();
    } else if (shownC.length) {
      shownC.pop();
    } else if (shownQ.length) {
      shownQ.pop();
    } else {
      break; // cannot happen at these caps (1 + 8 + 5 + 13 + 1 ≤ 14 fails only past the caps)
    }
    dropped++;
  }

  const lines = [`Czy dobrze rozumiem? (runda ${round}/${maxRounds})`];
  if (shownU.length) {
    lines.push("Rozumiem tak:");
    for (const item of shownU) lines.push(claimLine("• ", item, quotes));
  }
  if (shownC.length || shownA.length) {
    lines.push("Założyłem — popraw, jeśli źle:");
    [...shownC, ...shownA].forEach((item, i) => lines.push(renderBlock2(item, String.fromCharCode(97 + i))));
  }
  if (shownQ.length) {
    lines.push("Pytania:");
    shownQ.forEach((q, i) => lines.push(...renderQuestion(q, i + 1)));
  }
  if (dropped) lines.push(`… (+${dropped} w rekordzie)`);

  const presented = {
    mapVersion: selection.mapVersion,
    understood: shownU.map((u) => ({ id: u.id, claim: u.claim })),
    confirmations: shownC.map((c) => ({ id: c.id, claim: c.claim })),
    assumptions: shownA.map((a) => ({ id: a.id, claim: a.claim })),
    questions: shownQ.map((q) => ({
      id: q.id,
      claim: q.claim,
      options: q.options.map((o) => ({ text: o.text, recommended: Boolean(o.recommended) })),
    })),
  };
  return { display: lines.join("\n"), presented, dropped };
}

// ── answer parsing ───────────────────────────────────────────────────────────

const PICK_RE = /\b(1[0-2]|[1-9])\s*([a-d])\b/gi;
const CORRECTION_RE = /\b([a-z])\s+nie\b/gi;
const OK_RE = /^ok[.!]?$/i;

function acceptAllAnswers(round, mapVersion, questions) {
  return questions.map((q) => {
    const rec = q.options.find((o) => o.recommended) ?? q.options[0];
    return {
      round,
      mapVersion,
      interpretationId: q.id,
      about: { claim: q.claim, option: rec.text },
      answer: rec.text,
      acceptedOptions: [rec.text],
    };
  });
}

/**
 * Parse one answer against one round's presented slice.
 *
 * Returns {kind:"structured", answers, corrections} when every part of the
 * answer pins to exactly one presented item, or {kind:"free"} when any part
 * does not — the whole answer then routes to the plan.intent.reply annotation.
 * `round` and `mapVersion` stamp every record so the fold's reference triple
 * and its presented[round] cross-check resolve.
 */
export function parseGate1Answer(raw, round, presented) {
  if (!presented || typeof presented !== "object" || !Number.isInteger(presented.mapVersion)) {
    throw Object.assign(new Error("parseGate1Answer needs the round's presented slice"), { code: "invalid_input" });
  }
  const mapVersion = presented.mapVersion;
  const questions = presented.questions ?? [];
  const block2 = [
    ...(presented.confirmations ?? []).map((c) => ({ ...c, kind: "confirmation" })),
    ...(presented.assumptions ?? []).map((a) => ({ ...a, kind: "assumption" })),
  ];
  const text = String(raw ?? "").trim();

  if (OK_RE.test(text)) {
    return { kind: "structured", answers: acceptAllAnswers(round, mapVersion, questions), corrections: [] };
  }

  // Rebuild the address space the display showed: block-2 letters a.. over
  // confirmations-then-assumptions, question numbers 1.. in display order,
  // option letters a.. per question.
  const byLetter = new Map(block2.map((item, i) => [String.fromCharCode(97 + i), item]));
  const byNumber = new Map(questions.map((q, i) => [String(i + 1), q]));

  const picks = [];
  for (const m of text.matchAll(PICK_RE)) {
    picks.push({ index: m.index, len: m[0].length, number: m[1], letter: m[2].toLowerCase() });
  }
  const starts = [];
  for (const m of text.matchAll(CORRECTION_RE)) {
    starts.push({ index: m.index, len: m[0].length, letter: m[1].toLowerCase() });
  }

  const markers = [
    ...picks.map((p) => ({ ...p, type: "pick" })),
    ...starts.map((s) => ({ ...s, type: "correction" })),
  ].sort((a, b) => a.index - b.index);

  // Anything before the first marker is prose — the whole answer is free text.
  if (markers.length && text.slice(0, markers[0].index).trim().length) {
    return { kind: "free" };
  }
  if (!markers.length) return { kind: "free" };

  const seenNumbers = new Set();
  const answers = [];
  const corrections = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const body = i + 1 < markers.length ? text.slice(marker.index, markers[i + 1].index) : text.slice(marker.index);
    if (marker.type === "pick") {
      const q = byNumber.get(marker.number);
      if (!q) return { kind: "free" };
      const optIdx = marker.letter.charCodeAt(0) - 97;
      const opt = (q.options ?? [])[optIdx];
      if (!opt) return { kind: "free" };
      if (seenNumbers.has(marker.number)) return { kind: "free" };
      seenNumbers.add(marker.number);
      // Prose between a pick and the next marker is trailing prose.
      if (body.slice(marker.len).trim().length) return { kind: "free" };
      answers.push({
        round,
        mapVersion,
        interpretationId: q.id,
        about: { claim: q.claim, option: opt.text },
        answer: opt.text,
        acceptedOptions: [opt.text],
      });
    } else {
      const item = byLetter.get(marker.letter);
      if (!item) return { kind: "free" };
      const corrected = body.slice(marker.len).trim();
      if (!corrected.length) return { kind: "free" };
      corrections.push({
        round,
        mapVersion,
        interpretationId: item.id,
        about: { claim: item.claim },
        corrected,
      });
    }
  }

  return { kind: "structured", answers, corrections };
}
