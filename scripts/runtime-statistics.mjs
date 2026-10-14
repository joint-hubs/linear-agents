// Runtime statistics aggregation (PRD "Task workspace, concurrent supervisors,
// manager tool config, statistics & semantic map" — §9 events, §10 metrics, phase P3).
//
// Pure module: no I/O, no store access, no network, no wall-clock inference.
// Timing math uses only measured evidence:
//   - supervisor_started/stopped lifecycle pairs bound each actor's eligible lifetime;
//   - claude_code.interaction spans are the measured known windows;
//   - claude_code.llm_request + claude_code.tool.execution form the busy union,
//     clipped to known time; Agent/Task delegation execution is waiting-on-child,
//     excluded from the lead's busy time;
//   - open spans are never extended; uncovered gaps stay unknown;
//   - a missing denominator renders null percentages, never 0 or 100.
//
// Window semantics: keep lifecycle boundaries; count choices/revisions/returns in
// the window and completed routes by their explicit completion timestamp.

export const EVENT_TYPES = [
  'supervisor_started',
  'actor_started',
  'actor_stopped',
  'workflow_completed',
  'supervisor_stopped',
  'actor_state_changed',
  'workflow_selected',
  'workflow_revised',
  'stage_attempt_started',
  'stage_attempt_completed',
  'return_to_dev',
];

export const SPAN_NAMES = [
  'claude_code.interaction',
  'claude_code.llm_request',
  'claude_code.tool.execution',
  'claude_code.tool.blocked_on_user',
];

export const PAYLOAD_KEYS = [
  'state', 'stages', 'fromAttemptId', 'toAttemptId', 'source', 'reason', 'evidenceRef', 'status', 'evidenceKind', 'dependsOnAttemptIds',
];

const INTERACTION = 'claude_code.interaction';
const TOOL_EXECUTION = 'claude_code.tool.execution';
const BLOCKED_ON_USER = 'claude_code.tool.blocked_on_user';

const DELEGATION_TOOLS = new Set(['agent', 'task']);
const REWORK_REASONS = ['review', 'test', 'human', 'other', 'unknown'];
const REWORK_SOURCES = ['direct', 'inferred'];

const round2 = (x) => Math.round(x * 100) / 100;
const pct = (num, den) => (den != null && den > 0 ? round2((100 * num) / den) : null);
const eventOrd = (e) => (e.seq != null ? e.seq : e.occurredAt);

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// ---------------------------------------------------------------- sanitizing

function sanitizeEvent(raw) {
  if (!raw || !EVENT_TYPES.includes(raw.type ?? raw.eventType) || raw.eventId == null) return null;
  const occurredAt = toMs(raw.occurredAt);
  if (occurredAt == null) return null;
  const source = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const payload = {};
  for (const key of PAYLOAD_KEYS) if (source[key] !== undefined) payload[key] = source[key];
  return {
    type: raw.type ?? raw.eventType,
    eventId: String(raw.eventId),
    taskKey: raw.taskKey ?? null,
    supervisorSessionId: raw.supervisorSessionId ?? null,
    workflowRunId: raw.workflowRunId ?? null,
    attemptId: raw.attemptId ?? null,
    actorId: raw.actorId ?? null,
    role: raw.role ?? null,
    parentActorId: raw.parentActorId ?? null,
    seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : null,
    occurredAt,
    payload,
  };
}

function sanitizeSpan(raw) {
  if (!raw || raw.spanId == null || !SPAN_NAMES.includes(raw.name)) return null;
  const startAt = toMs(raw.startAt);
  const endAt = toMs(raw.endAt);
  if (startAt == null || endAt == null || endAt < startAt) return null; // open/invalid spans are never extended
  return {
    traceId: raw.traceId ?? "legacy",
    spanId: String(raw.spanId),
    parentSpanId: raw.parentSpanId ?? null,
    taskKey: raw.taskKey ?? null,
    supervisorSessionId: raw.supervisorSessionId ?? null,
    workflowRunId: raw.workflowRunId ?? null,
    attemptId: raw.attemptId ?? null,
    actorId: raw.actorId ?? null,
    role: raw.role ?? null,
    parentActorId: raw.parentActorId ?? null,
    name: raw.name,
    startAt,
    endAt,
    model: raw.model ?? null,
    toolName: raw.toolName ?? null,
    agentId: raw.agentId ?? null,
    status: raw.status ?? null,
  };
}

function prepareEvents(rawEvents) {
  const seen = new Set();
  const events = [];
  const unknownTypes = new Map();
  let duplicateEventIds = 0;
  let invalidEvents = 0;
  for (const raw of rawEvents) {
    if (raw && raw.type && !EVENT_TYPES.includes(raw.type)) {
      unknownTypes.set(raw.type, (unknownTypes.get(raw.type) ?? 0) + 1);
    }
    const event = sanitizeEvent(raw);
    if (!event) { invalidEvents++; continue; }
    if (seen.has(event.eventId)) { duplicateEventIds++; continue; } // idempotent replay: first wins
    seen.add(event.eventId);
    events.push(event);
  }
  return {
    events,
    duplicateEventIds,
    invalidEvents,
    unknownEventTypes: [...unknownTypes].map(([type, count]) => ({ type, count })),
  };
}

// Native OTLP puts actor/tool identity on parent spans, sometimes in later batches.
// Resolve by trace-scoped parent edges at read time, never by adjacent timestamps.
export function attributeRuntimeSpans(rawSpans) {
  const map=new Map(rawSpans.map(s=>[(s.traceId??'legacy')+':'+s.spanId,{...s}]));
  const visiting=new Set(), done=new Set();
  const resolve=(key)=>{
    const s=map.get(key); if(!s || done.has(key) || visiting.has(key))return s;
    visiting.add(key);
    const parent=s.parentSpanId?resolve((s.traceId??'legacy')+':'+s.parentSpanId):null;
    if(parent && parent.taskKey===s.taskKey && parent.supervisorSessionId===s.supervisorSessionId){
      if(!s.agentId && s.baseActorId){s.actorId=parent.actorId;s.role=parent.role;s.parentActorId=parent.parentActorId;}
      if(s.agentId && s.actorId!==parent.actorId){s.parentActorId??=parent.actorId;s.role='unknown';}
      if(!s.toolName && ['claude_code.tool.execution','claude_code.tool.blocked_on_user'].includes(s.name))s.toolName=parent.toolName??null;
    } else if(s.baseActorId && s.parentSpanId && !s.agentId) {
      // A truncated export cannot prove which actor owned this descendant.
      s.actorId=null;
    }
    if(s.agentId && s.actorId!==s.baseActorId && s.role==='supervisor')s.role='unknown';
    visiting.delete(key);done.add(key);return s;
  };
  return [...map.keys()].map(resolve);
}

function prepareSpans(rawSpans) {
  const seen = new Set();
  const spans = [];
  const unknownNames = new Map();
  let duplicateSpanIds = rawSpans.length - new Set(rawSpans.map(s => `${s.traceId??'legacy'}:${s.spanId}`)).size;
  let openSpansDropped = 0;
  let spansWithoutActor = 0;
  for (const raw of attributeRuntimeSpans(rawSpans)) {
    if (raw && raw.name && !SPAN_NAMES.includes(raw.name)) {
      unknownNames.set(raw.name, (unknownNames.get(raw.name) ?? 0) + 1);
      continue;
    }
    const span = sanitizeSpan(raw);
    if (!span) { openSpansDropped++; continue; }
    if (span.actorId == null) { spansWithoutActor++; continue; }
    if (seen.has(`${span.traceId}:${span.spanId}`)) { duplicateSpanIds++; continue; }
    seen.add(`${span.traceId}:${span.spanId}`);
    spans.push(span);
  }
  return {
    spans,
    duplicateSpanIds,
    openSpansDropped,
    spansWithoutActor,
    unknownSpanNames: [...unknownNames].map(([name, count]) => ({ name, count })),
  };
}

// ----------------------------------------------------------- interval helpers

function windowClip(intervals, win) {
  const [from, to] = win;
  const out = [];
  for (const [start, end] of intervals) {
    const s = from == null ? start : Math.max(start, from);
    const e = to == null ? end : Math.min(end, to);
    if (e > s) out.push([s, e]);
  }
  return out;
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

const totalMs = (intervals) => intervals.reduce((acc, [s, e]) => acc + (e - s), 0);

function intersectIntervals(intervals, bounds) {
  const out = [];
  for (const [s, e] of intervals) {
    for (const [bs, be] of bounds) {
      const lo = Math.max(s, bs);
      const hi = Math.min(e, be);
      if (hi > lo) out.push([lo, hi]);
    }
  }
  return mergeIntervals(out);
}

function intersectMs(intervals, bounds) {
  if (bounds.length === 0) return 0;
  let sum = 0;
  for (const [s, e] of intervals) {
    for (const [bs, be] of bounds) {
      const lo = Math.max(s, bs);
      const hi = Math.min(e, be);
      if (hi > lo) sum += hi - lo;
    }
  }
  return sum;
}

// Pair i-th supervisor_started with the first later supervisor_stopped.
// An unmatched start leaves an open lifetime [start, null] (bounded by the
// window's `to` later; if the window has no `to`, the denominator is unknown).
function pairLifecycle(events) {
  const starts = events.filter((e) => e.type === 'supervisor_started').map((e) => e.occurredAt).sort((a, b) => a - b);
  const stops = events.filter((e) => e.type === 'supervisor_stopped').map((e) => e.occurredAt).sort((a, b) => a - b);
  const pairs = [];
  let j = 0;
  for (const start of starts) {
    while (j < stops.length && stops[j] < start) j++;
    if (j < stops.length) { pairs.push([start, stops[j]]); j++; }
    else pairs.push([start, null]);
  }
  return pairs;
}

function clipLifecycle(pairs, win) {
  if (pairs.length === 0) return null; // no lifecycle evidence -> eligible unknown
  const bounded = [];
  for (const [start, end] of pairs) {
    if (end == null && win[1] == null) return null; // open lifetime, no window bound -> unknown
    bounded.push([start, end ?? win[1]]);
  }
  return mergeIntervals(windowClip(bounded, win));
}

// -------------------------------------------------------------- actor metrics

const isDelegation = (span) =>
  DELEGATION_TOOLS.has(String(span.toolName ?? '').toLowerCase());

function actorTimeStats(spans, lifecyclePairs, win) {
  const interaction = [];
  const blockedOnUser = [];
  const busy = [];
  const delegation = [];
  for (const span of spans) {
    const [iv] = windowClip([[span.startAt, span.endAt]], win);
    if (!iv) continue;
    if (span.name === INTERACTION) interaction.push(iv);
    else if (span.name === BLOCKED_ON_USER) blockedOnUser.push(iv);
    else if (span.name === TOOL_EXECUTION && isDelegation(span)) delegation.push(iv);
    else busy.push(iv); // llm_request + non-delegation tool.execution
  }
  const eligible = clipLifecycle(lifecyclePairs, win);
  let known = mergeIntervals(interaction.length ? [...interaction, ...blockedOnUser] : [...busy, ...delegation, ...blockedOnUser]);
  if (eligible) known = intersectIntervals(known, eligible);
  const knownMs = totalMs(known);
  const eligibleMs = eligible == null ? null : totalMs(eligible);
  const busyMs = intersectMs(mergeIntervals(busy), known); // merge first: overlaps must not double-count
  return {
    eligibleMs,
    knownMs,
    unknownMs: eligibleMs == null ? null : Math.max(0, eligibleMs - knownMs),
    busyMs,
    waitingOnChildMs: intersectMs(mergeIntervals(delegation), known),
    waitingOnHumanMs: intersectMs(mergeIntervals(blockedOnUser), known),
    activePct: pct(busyMs, knownMs),
    coveragePct: pct(knownMs, eligibleMs),
  };
}

function computeActors(events, spans, win) {
  const map = new Map();
  const touch = (actorId) => {
    let rec = map.get(actorId);
    if (!rec) { rec = { role: null, lifecycle: [], spans: [] }; map.set(actorId, rec); }
    return rec;
  };
  for (const event of events) {
    if (event.actorId == null) continue;
    const rec = touch(event.actorId);
    if (rec.role == null && event.role != null) rec.role = event.role;
    if (['supervisor_started','supervisor_stopped','actor_started','actor_stopped'].includes(event.type)) rec.lifecycle.push({ ...event, type: event.type.replace(/^actor_/, 'supervisor_') });
    rec.taskKey = event.taskKey;
    rec.supervisorSessionId = event.supervisorSessionId;
  }
  for (const span of spans) {
    const rec = touch(span.actorId);
    if (rec.role == null && span.role != null) rec.role = span.role;
    rec.taskKey ??= span.taskKey;
    rec.supervisorSessionId ??= span.supervisorSessionId;
    rec.spans.push(span);
  }
  const actors = [];
  for (const actorId of [...map.keys()].sort()) {
    const rec = map.get(actorId);
    actors.push({
      actorId,
      role: rec.role ?? 'unknown',
      taskKey: rec.taskKey ?? null,
      supervisorSessionId: rec.supervisorSessionId ?? null,
      ...actorTimeStats(rec.spans, pairLifecycle(rec.lifecycle), win),
    });
  }
  return actors;
}

// Duration pools (sums), never averages of percentages (PRD §10).
function pooled(entries) {
  const sum = (key) => entries.reduce((acc, x) => acc + (x[key] ?? 0), 0);
  const hasEligible = entries.length > 0 && entries.every((x) => x.eligibleMs != null);
  const eligibleMs = hasEligible ? sum('eligibleMs') : null;
  const knownMs = sum('knownMs');
  const busyMs = sum('busyMs');
  return {
    actors: entries.length,
    eligibleMs,
    knownMs,
    unknownMs: eligibleMs == null ? null : Math.max(0, eligibleMs - knownMs),
    busyMs,
    waitingOnChildMs: sum('waitingOnChildMs'),
    waitingOnHumanMs: sum('waitingOnHumanMs'),
    activePct: pct(busyMs, knownMs),
    coveragePct: pct(knownMs, eligibleMs),
  };
}

// ------------------------------------------------------------------ workflows

const validStages = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string' && s !== '')
    ? value.map(String)
    : null;

function pairStageAttempts(run) {
  const map = new Map();
  for (const event of run.attemptEvents) {
    let rec = map.get(event.attemptId);
    if (!rec) {
      rec = { attemptId: event.attemptId, stages: null, started: null, completed: null };
      map.set(event.attemptId, rec);
    }
    if (!rec.stages) rec.stages = validStages(event.payload.stages);
    const ord = eventOrd(event);
    if (event.type === 'stage_attempt_started') {
      if (!rec.started || ord < rec.started.ord) {
        rec.started = { ord, actorId: event.actorId, parentActorId: event.parentActorId, dependsOnAttemptIds: event.payload.dependsOnAttemptIds ?? (event.payload.fromAttemptId ? [event.payload.fromAttemptId] : []) };
      }
    } else if (!rec.completed || ord < rec.completed.ord) {
      rec.completed = { ord };
    }
  }
  for (const rec of map.values()) if (rec.stages == null) rec.stages = ['unknown'];
  return [...map.values()];
}

// A layered route requires explicit dependencies between every adjacent layer.
// Partial DAGs and missing edges remain unordered instead of inventing a join.
function buildRouteGroups(attempts) {
  const unknown = () => { const group=[...attempts].sort((a,b)=>a.attemptId.localeCompare(b.attemptId));group.unordered=true;return [group]; };
  if (!attempts.length) return [];
  const pending=new Map(attempts.map(a=>[a.attemptId,a])), all=new Set(pending.keys()), done=new Set(), groups=[];
  while(pending.size) {
    const next=[...pending.values()].filter(a=>(a.dependsOnAttemptIds??[]).every(id=>done.has(id)));
    if(!next.length) return unknown();
    if(groups.length===0 && next.length>1) return unknown();
    if(groups.length && next.some(a=>groups.at(-1).some(prev=>!(a.dependsOnAttemptIds??[]).includes(prev.attemptId)))) return unknown();
    if(next.some(a=>(a.dependsOnAttemptIds??[]).some(id=>!all.has(id)))) return unknown();
    next.sort((a,b)=>a.attemptId.localeCompare(b.attemptId));groups.push(next);
    for(const item of next){pending.delete(item.attemptId);done.add(item.attemptId);}
  }
  return groups;
}

function routeString(groups) {
  if (groups.length === 0) return null;
  return groups
    .map((g) => {
      const seen = new Set();
      const stages = [];
      for (const member of [...g].sort((a, b) => a.startOrd - b.startOrd)) {
        for (const stage of member.stages) if (!seen.has(stage)) { seen.add(stage); stages.push(stage); }
      }
      return (g.unordered ? 'unordered: ' : '') + stages.join('|');
    })
    .filter((part,index,parts)=>index===0 || part!==parts[index-1])
    .join(' > ');
}

const inWindow = (event, win) => (win[0] == null || event.occurredAt >= win[0]) && (win[1] == null || event.occurredAt <= win[1]);

function collectWorkflows(events, win) {
  const runs = new Map();
  let attemptEventsWithoutId = 0;
  for (const event of events) {
    if (event.workflowRunId == null) continue;
    let run = runs.get(event.workflowRunId);
    if (!run) {
      run = { taskKeys: new Set(), selected: [], revised: [], attemptEvents: [], completed: false, completedAt: null, sawWorkflowEvent: false, inWindow: false };
      runs.set(event.workflowRunId, run);
    }
    if (event.type !== 'supervisor_stopped') run.sawWorkflowEvent = true;
    run.taskKeys.add(event.taskKey);
    if (inWindow(event, win)) run.inWindow = true;
    if (event.type === 'workflow_selected') run.selected.push(event);
    else if (event.type === 'workflow_revised') run.revised.push(event);
    else if (event.type === 'stage_attempt_started' || event.type === 'stage_attempt_completed') {
      if (event.attemptId == null) { attemptEventsWithoutId++; continue; }
      run.attemptEvents.push(event);
    } else if ((event.type === 'workflow_completed' || (event.type === 'supervisor_stopped' && event.payload.status === 'completed'))) {
      if (win[1] == null || event.occurredAt <= win[1]) { run.completed = true; run.completedAt = event.occurredAt; }
    }
  }

  // Initial choice: first workflow_selected per run; proportions among runs
  // with a known choice. Revisions are counted separately.
  const proportions = new Map();
  let runsKnown = 0;
  for (const run of runs.values()) {
    const first = [...run.selected].sort((a, b) => eventOrd(a) - eventOrd(b) || (a.eventId < b.eventId ? -1 : 1))[0];
    const stages = first ? validStages(first.payload.stages) : null;
    if (!stages || !inWindow(first, win)) continue;
    runsKnown++;
    const key = stages.join(' > ');
    const entry = proportions.get(key) ?? { stages, runs: 0 };
    entry.runs++;
    proportions.set(key, entry);
  }
  const runsTotal = [...runs.values()].filter(r => { const first=[...r.selected].sort((a,b)=>eventOrd(a)-eventOrd(b))[0];return first ? inWindow(first,win) : r.sawWorkflowEvent && r.inWindow; }).length;
  const proportionList = [...proportions.values()]
    .sort((a, b) => b.runs - a.runs || a.stages.join(' > ').localeCompare(b.stages.join(' > ')))
    .map((e) => ({ stages: e.stages, runs: e.runs, pct: pct(e.runs, runsKnown) }));

  const revisionsByTarget = new Map();
  for (const run of runs.values()) {
    for (const rev of run.revised.filter(e=>inWindow(e,win))) {
      const stages = validStages(rev.payload.stages) ?? ['unknown'];
      const key = stages.join(' > ');
      const entry = revisionsByTarget.get(key) ?? { stages, count: 0 };
      entry.count++;
      revisionsByTarget.set(key, entry);
    }
  }
  const revisionList = [...revisionsByTarget.values()]
    .sort((a, b) => b.count - a.count || a.stages.join(' > ').localeCompare(b.stages.join(' > ')));

  // Observed routes from paired stage attempts; runs without a completion event
  // stay in progress; runs without any taskKey are unattributed, never "other".
  const completedRoutes = new Map();
  const inProgressRoutes = new Map();
  let completedRuns = 0;
  let completedUnknownRoutes = 0;
  let unattributedRuns = 0;
  for (const run of runs.values()) {
    if (!run.inWindow) continue;
    if (![...run.taskKeys].some(Boolean)) { unattributedRuns++; continue; }
    const attempts = pairStageAttempts(run);
    if (run.completed) {
      if (!inWindow({occurredAt:run.completedAt},win)) continue;
      completedRuns++;
      const paired = attempts
        .filter((a) => a.started && a.completed)
        .map((a) => ({
          attemptId: a.attemptId,
          stages: a.stages,
          actorId: a.started.actorId,
          parentActorId: a.started.parentActorId,
          startOrd: a.started.ord,
          dependsOnAttemptIds: a.started.dependsOnAttemptIds,
          completeOrd: a.completed.ord,
        }));
      const route = routeString(buildRouteGroups(paired));
      if (route) completedRoutes.set(route, (completedRoutes.get(route) ?? 0) + 1);
      else completedUnknownRoutes++;
    } else if (run.attemptEvents.length > 0) {
      const started = attempts
        .filter((a) => a.started)
        .map((a) => ({
          attemptId: a.attemptId,
          stages: a.stages,
          actorId: a.started.actorId,
          parentActorId: a.started.parentActorId,
          startOrd: a.started.ord,
          dependsOnAttemptIds: a.started.dependsOnAttemptIds,
          completeOrd: a.completed ? a.completed.ord : Infinity,
        }));
      const route = routeString(buildRouteGroups(started));
      if (route) inProgressRoutes.set(route, (inProgressRoutes.get(route) ?? 0) + 1);
    }
  }
  const toRouteList = (map, denominator) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([route, runs]) => ({ route, runs, pct: denominator != null && denominator > 0 ? pct(runs, denominator) : null }));

  return {
    workflows: {
      initialChoice: {
        runsTotal,
        runsKnown,
        runsUnknownChoice: runsTotal - runsKnown,
        proportions: proportionList,
      },
      revisions: { count: revisionList.reduce((acc, e) => acc + e.count, 0), byTarget: revisionList },
      observedRoutes: {
        completedRuns,
        completedUnknownRoutes,
        completed: toRouteList(completedRoutes, completedRuns),
        inProgress: toRouteList(inProgressRoutes, null).map(({ route, runs }) => ({ route, runs })),
        unattributedRuns,
      },
    },
    attemptEventsWithoutId,
  };
}

// --------------------------------------------------------------------- rework

function collectRework(events, win) {
  const counted = [];
  const byReason = { review: 0, test: 0, human: 0, other: 0, unknown: 0 };
  const bySource = { direct: 0, inferred: 0, other: 0 };
  const completedTasks = new Set();
  const affectedTasks = new Set();
  let count = 0;
  let infrastructureRetry = 0;
  let sameAttempt = 0;
  let incomplete = 0;
  let unattributed = 0;

  for (const event of events) {
    if ((event.type === 'workflow_completed' || (event.type === 'supervisor_stopped' && event.payload.status === 'completed')) && event.taskKey && inWindow(event, win)) {
      completedTasks.add(event.taskKey);
    }
  }
  for (const event of events) {
    if (event.type !== 'return_to_dev' || !inWindow(event, win)) continue;
    const p = event.payload;
    if (!p.fromAttemptId || !p.toAttemptId || !p.source || !p.reason || !p.evidenceRef) { incomplete++; continue; }
    if (p.source === 'infrastructure' || p.reason === 'infrastructure_retry') { infrastructureRetry++; continue; } // same-stage infra retry is not rework
    if (p.fromAttemptId === p.toAttemptId) { sameAttempt++; continue; }
    const reason = REWORK_REASONS.includes(p.source) ? p.source : (REWORK_REASONS.includes(p.reason) ? p.reason : 'other');
    byReason[reason]++;
    bySource[p.evidenceKind === 'inferred' || p.source === 'inferred' ? 'inferred' : 'direct']++;
    count++;
    counted.push(event);
    if (event.taskKey) affectedTasks.add(event.taskKey);
    else unattributed++;
  }
  // "% of completed tasks affected": only completed tasks count in the numerator
  const affectedCompleted = [...affectedTasks].filter((t) => completedTasks.has(t)).length;
  return {
    count,
    byReason,
    bySource,
    events: counted.map(e => ({eventId:e.eventId,occurredAt:e.occurredAt,taskKey:e.taskKey,workflowRunId:e.workflowRunId,...e.payload})),
    completedTasks: completedTasks.size,
    completedTasksAffected: affectedCompleted,
    affectedPct: pct(affectedCompleted, completedTasks.size),
    excluded: { infrastructureRetry, sameAttempt, incomplete, unattributed },
  };
}

// ------------------------------------------------------------------ aggregate

export function aggregateRuntimeStatistics({ events = [], spans = [], from = null, to = null, taskKey = null } = {}) {
  const win = [toMs(from), toMs(to)];
  const preparedEvents = prepareEvents(events);
  const preparedSpans = prepareSpans(spans);
  const filteredEvents = taskKey != null
    ? preparedEvents.events.filter((e) => e.taskKey === taskKey)
    : preparedEvents.events;
  const filteredSpans = taskKey != null
    ? preparedSpans.spans.filter((s) => s.taskKey === taskKey)
    : preparedSpans.spans;

  const actors = computeActors(filteredEvents, filteredSpans, win);
  const rolesMap = new Map();
  for (const actor of actors) {
    const list = rolesMap.get(actor.role) ?? [];
    list.push(actor);
    rolesMap.set(actor.role, list);
  }
  const roles = [...rolesMap.keys()].sort().map((role) => ({ role, ...pooled(rolesMap.get(role)) }));
  const team = pooled(actors);
  const { workflows, attemptEventsWithoutId } = collectWorkflows(filteredEvents, win);
  const rework = collectRework(filteredEvents, win);

  return {
    window: { from: win[0], to: win[1] },
    actors,
    roles,
    team,
    workflows,
    rework,
    coverage: {
      eligibleMs: team.eligibleMs,
      knownMs: team.knownMs,
      unknownMs: team.unknownMs,
      coveragePct: team.coveragePct,
      duplicateEventIds: preparedEvents.duplicateEventIds,
      duplicateSpanIds: preparedSpans.duplicateSpanIds,
      invalidEvents: preparedEvents.invalidEvents,
      openSpansDropped: preparedSpans.openSpansDropped,
      spansWithoutActor: preparedSpans.spansWithoutActor,
      attemptEventsWithoutId,
      actorsWithoutEligible: actors.filter((a) => a.eligibleMs == null).length,
      unknownEventTypes: preparedEvents.unknownEventTypes,
      unknownSpanNames: preparedSpans.unknownSpanNames,
    },
  };
}
