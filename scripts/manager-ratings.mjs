// manager-ratings — the POST /api/manager/ratings body contract (FOC-225
// slice 3; extracted from telemetry-server.mjs in review round 5 so the
// allowlist's fail-closed branch is testable without starting the HTTP
// server).
//
// Ratings are subjective 1..5 + note — never points; the squad must be a
// configured one. Returns validateLaunch's { status, error } convention on
// rejection and { rating } on success.

import { readSquadConfig } from "./squad-config.mjs";

export function validateRating(body, { squadConfig = readSquadConfig } = {}) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim().toLowerCase() : '';
  if (!subject) return { status: 400, error: 'subject (squad) is required' };
  let known = null;
  try {
    known = Object.keys(squadConfig().squads || {});
  } catch {
    // Fail CLOSED: without a readable config the subject cannot be validated,
    // so the route must deny — never award authoring rights to an unvalidated
    // squad (review round 5; the v1 catch returned null and the route failed
    // open).
    return { status: 503, error: 'squad configuration unavailable — cannot validate the rating subject' };
  }
  if (!known.includes(subject)) return { status: 400, error: `unknown squad: ${subject}` };
  // Strictly a number: Number() coercion accepted "3" or [3] (review round 5).
  const rating = body?.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { status: 400, error: 'rating must be an integer 1..5' };
  }
  const note = body?.note == null ? null : String(body.note);
  if (note != null && note.length > 500) return { status: 400, error: 'note must be at most 500 characters' };
  const taskId = body?.taskId == null ? null : String(body.taskId).trim().toUpperCase();
  if (taskId && !/^[A-Z][A-Z0-9-]{1,19}$/.test(taskId)) return { status: 400, error: 'taskId must look like a task identifier' };
  const runId = body?.runId == null ? null : String(body.runId).trim();
  if (runId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) return { status: 400, error: 'runId must be a run identifier' };
  return { rating: { subject, taskId: taskId || null, runId: runId || null, rating, note } };
}
