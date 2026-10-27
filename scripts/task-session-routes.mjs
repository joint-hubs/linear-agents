// scripts/task-session-routes.mjs — the per-session answer routes shared by
// both ends of the API → task-session host hop (FOC-1112).
//
// cockpit-routes.mjs forwards a task cockpit's answers to
// `/sessions/:sid<suffix>` and task-session-host.mjs routes the same suffixes
// to the session's controller. The two used to spell them separately and
// drifted: the API sent /dialog/answer and /dialog/ask, the host only knew
// POST /dialog and /ask, so every answer from a dialog or ask card came back
// 404 not-found (FOC-789 Day 5, rc.9). One table, imported by both, makes that
// drift impossible; the tests hold each side to it.

export const SESSION_ANSWER_ROUTES = Object.freeze({
  // A permission dialog answer: { id, choice, note? }.
  dialog: "/dialog/answer",
  // A Supervisor ask answer: { questions, answers }.
  ask: "/dialog/ask",
});
