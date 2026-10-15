// Tests for scripts/runtime-statistics.mjs (PRD §10 metrics, AC-8).
// All fixtures are hand-calculated; timestamps are epoch milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRuntimeStatistics } from './runtime-statistics.mjs';

const ev = (over = {}) => ({
  type: 'supervisor_started',
  eventId: 'e',
  occurredAt: 0,
  ...over,
});
const span = (over = {}) => ({
  name: 'claude_code.interaction',
  spanId: 's',
  startAt: 0,
  endAt: 0,
  ...over,
});

test('overlapping/nested spans: busy union clipped to known, delegation excluded from busy', () => {
  const events = [
    ev({ eventId: 'e1', type: 'supervisor_started', actorId: 'lead-1', role: 'supervisor', taskKey: 'T-1', supervisorSessionId: 's1', workflowRunId: 'r1', seq: 1, occurredAt: 0 }),
    ev({ eventId: 'e2', type: 'supervisor_stopped', actorId: 'lead-1', role: 'supervisor', taskKey: 'T-1', seq: 20, occurredAt: 1000 }),
  ];
  const base = { taskKey: 'T-1', supervisorSessionId: 's1', workflowRunId: 'r1', attemptId: 'a1', actorId: 'lead-1', role: 'supervisor' };
  const spans = [
    span({ ...base, spanId: 'i1', name: 'claude_code.interaction', startAt: 100, endAt: 300 }),
    span({ ...base, spanId: 'i2', name: 'claude_code.interaction', startAt: 500, endAt: 700 }),
    span({ ...base, spanId: 'l1', name: 'claude_code.llm_request', startAt: 100, endAt: 200 }),
    span({ ...base, spanId: 't1', name: 'claude_code.tool.execution', startAt: 150, endAt: 350, toolName: 'Read' }),
    span({ ...base, spanId: 'l2', name: 'claude_code.llm_request', startAt: 550, endAt: 600 }),
    span({ ...base, spanId: 't2', name: 'claude_code.tool.execution', startAt: 500, endAt: 700, toolName: 'Agent', agentId: 'child-9' }),
    span({ ...base, spanId: 't3', name: 'claude_code.tool.execution', startAt: 800, endAt: 900, toolName: 'Bash' }),
    span({ ...base, spanId: 'l1', name: 'claude_code.llm_request', startAt: 100, endAt: 200 }), // duplicate id
  ];

  const stats = aggregateRuntimeStatistics({ events, spans, from: 0, to: 1000 });

  const actor = stats.actors[0];
  assert.equal(actor.actorId, 'lead-1');
  assert.equal(actor.eligibleMs, 1000); // lifecycle pair 0..1000
  assert.equal(actor.knownMs, 400); // [100,300] + [500,700]
  assert.equal(actor.busyMs, 250); // ([100,200]∪[150,350])∩known = 200, plus [550,600] = 50
  assert.equal(actor.waitingOnChildMs, 200); // Agent delegation [500,700], not busy
  assert.equal(actor.waitingOnHumanMs, 0);
  assert.equal(actor.unknownMs, 600); // 1000 - 400
  assert.equal(actor.activePct, 62.5); // 100 * 250 / 400
  assert.equal(actor.coveragePct, 40); // 100 * 400 / 1000
  assert.equal(stats.coverage.duplicateSpanIds, 1);
  assert.equal(stats.team.actors, 1);
  assert.equal(stats.team.busyMs, 250);
});

test('half-known coverage plus zero and missing denominators; pooled role/team sums', () => {
  const events = [
    ev({ eventId: 's1', type: 'supervisor_started', actorId: 'a-lead', role: 'lead', occurredAt: 0 }),
    ev({ eventId: 's2', type: 'supervisor_stopped', actorId: 'a-lead', role: 'lead', occurredAt: 1000 }),
    ev({ eventId: 's3', type: 'supervisor_started', actorId: 'a-out', role: 'lead', occurredAt: 2000 }),
    ev({ eventId: 's4', type: 'supervisor_stopped', actorId: 'a-out', role: 'lead', occurredAt: 3000 }),
  ];
  const spans = [
    span({ spanId: 'k1', actorId: 'a-lead', role: 'lead', startAt: 400, endAt: 600 }),
    span({ spanId: 'b1', actorId: 'a-lead', role: 'lead', name: 'claude_code.llm_request', startAt: 450, endAt: 500 }),
    span({ spanId: 'k2', actorId: 'a-nolc', role: 'worker', startAt: 0, endAt: 100 }),
    span({ spanId: 'b2', actorId: 'a-nolc', role: 'worker', name: 'claude_code.llm_request', startAt: 0, endAt: 50 }),
  ];

  const stats = aggregateRuntimeStatistics({ events, spans, from: 0, to: 1000 });
  const byId = new Map(stats.actors.map((a) => [a.actorId, a]));

  assert.deepEqual([byId.get('a-lead').eligibleMs, byId.get('a-lead').knownMs], [1000, 200]);
  assert.equal(byId.get('a-lead').activePct, 25); // 100 * 50 / 200
  assert.equal(byId.get('a-lead').coveragePct, 20); // 100 * 200 / 1000
  assert.equal(byId.get('a-nolc').eligibleMs, null); // no lifecycle -> denominator missing
  assert.equal(byId.get('a-nolc').coveragePct, null);
  assert.equal(byId.get('a-nolc').activePct, 50); // 100 * 50 / 100
  assert.equal(byId.get('a-out').eligibleMs, 0); // lifecycle entirely outside window
  assert.equal(byId.get('a-out').coveragePct, null); // zero denominator -> null
  assert.equal(byId.get('a-out').activePct, null); // no known time

  const lead = stats.roles.find((r) => r.role === 'lead');
  assert.equal(lead.actors, 2);
  assert.equal(lead.eligibleMs, 1000); // pool sums durations, not percentages
  assert.equal(lead.knownMs, 200);
  assert.equal(lead.activePct, 25);
  assert.equal(lead.coveragePct, 20);

  const worker = stats.roles.find((r) => r.role === 'worker');
  assert.equal(worker.eligibleMs, null);
  assert.equal(worker.activePct, 50);
  assert.equal(worker.coveragePct, null);

  assert.equal(stats.team.actors, 3);
  assert.equal(stats.team.eligibleMs, null);
  assert.equal(stats.team.knownMs, 300);
  assert.equal(stats.team.busyMs, 100);
  assert.equal(stats.team.activePct, 33.33); // 100 * 100 / 300
  assert.equal(stats.team.coveragePct, null); // one actor has no lifecycle denominator
  assert.equal(stats.coverage.actorsWithoutEligible, 1); // a-nolc only
});

test('duplicate event ids dedup idempotently; only the first workflow_selected counts', () => {
  const events = [
    ev({ eventId: 'sel1', type: 'workflow_selected', workflowRunId: 'r1', taskKey: 'T-1', seq: 1, payload: { stages: ['plan', 'dev'] } }),
    ev({ eventId: 'sel1', type: 'workflow_selected', workflowRunId: 'r1', taskKey: 'T-1', seq: 2, payload: { stages: ['dev', 'test'] } }), // replay: first wins
    ev({ eventId: 'sel2', type: 'workflow_selected', workflowRunId: 'r1', taskKey: 'T-1', seq: 3, payload: { stages: ['dev', 'test'] } }), // later selection ignored
    ev({ eventId: 'sa1', type: 'stage_attempt_started', workflowRunId: 'r1', taskKey: 'T-1', attemptId: 'a1', actorId: 'sup', seq: 4, payload: { stages: ['plan'] } }),
    ev({ eventId: 'sc1', type: 'stage_attempt_completed', workflowRunId: 'r1', taskKey: 'T-1', attemptId: 'a1', actorId: 'sup', seq: 5, payload: { stages: ['plan'], status: 'ok' } }),
    ev({ eventId: 'sc1', type: 'stage_attempt_completed', workflowRunId: 'r1', taskKey: 'T-1', attemptId: 'a1', actorId: 'sup', seq: 6, payload: { stages: ['plan'], status: 'ok' } }), // replay
  ];

  const stats = aggregateRuntimeStatistics({ events });
  assert.equal(stats.coverage.duplicateEventIds, 2);
  assert.equal(stats.workflows.initialChoice.runsTotal, 1);
  assert.equal(stats.workflows.initialChoice.runsKnown, 1);
  assert.deepEqual(stats.workflows.initialChoice.proportions, [
    { stages: ['plan', 'dev'], runs: 1, pct: 100 },
  ]);
  assert.deepEqual(stats.workflows.observedRoutes.inProgress, [{ route: 'plan', runs: 1 }]);
  assert.equal(stats.workflows.observedRoutes.completedRuns, 0); // no completion event
});

test('workflow proportions, separate revisions, unattributed runs, task filter', () => {
  const events = [
    ev({ eventId: 'w1', type: 'workflow_selected', workflowRunId: 'r1', taskKey: 'T-1', seq: 1, payload: { stages: ['plan', 'dev', 'review', 'test'] } }),
    ev({ eventId: 'w2', type: 'workflow_selected', workflowRunId: 'r2', taskKey: 'T-1', seq: 2, payload: { stages: ['dev', 'test'] } }),
    ev({ eventId: 'w3', type: 'workflow_revised', workflowRunId: 'r2', taskKey: 'T-1', seq: 3, payload: { stages: ['dev', 'review', 'test'] } }),
    ev({ eventId: 'w4', type: 'workflow_selected', workflowRunId: 'r3', seq: 4, payload: { stages: ['dev', 'test'] } }), // no taskKey
    ev({ eventId: 'w5', type: 'workflow_revised', workflowRunId: 'r4', taskKey: 'T-2', seq: 5, payload: { stages: ['dev', 'test'] } }), // no initial choice
  ];

  const all = aggregateRuntimeStatistics({ events });
  assert.equal(all.workflows.initialChoice.runsTotal, 4);
  assert.equal(all.workflows.initialChoice.runsKnown, 3);
  assert.equal(all.workflows.initialChoice.runsUnknownChoice, 1);
  assert.deepEqual(all.workflows.initialChoice.proportions, [
    { stages: ['dev', 'test'], runs: 2, pct: 66.67 },
    { stages: ['plan', 'dev', 'review', 'test'], runs: 1, pct: 33.33 },
  ]);
  assert.deepEqual(all.workflows.revisions, {
    count: 2,
    byTarget: [
      { stages: ['dev', 'review', 'test'], count: 1 },
      { stages: ['dev', 'test'], count: 1 },
    ],
  });
  assert.equal(all.workflows.observedRoutes.unattributedRuns, 1); // r3

  const filtered = aggregateRuntimeStatistics({ events, taskKey: 'T-1' });
  assert.equal(filtered.workflows.initialChoice.runsTotal, 2);
  assert.equal(filtered.workflows.initialChoice.runsKnown, 2);
  assert.equal(filtered.workflows.initialChoice.runsUnknownChoice, 0);
  assert.deepEqual(filtered.workflows.initialChoice.proportions, [
    { stages: ['dev', 'test'], runs: 1, pct: 50 },
    { stages: ['plan', 'dev', 'review', 'test'], runs: 1, pct: 50 },
  ]);
  assert.equal(filtered.workflows.observedRoutes.unattributedRuns, 0);
});

test('observed routes: parallel branches preserved as a group, in-progress separate', () => {
  const base = { taskKey: 'T-1', supervisorSessionId: 's1', workflowRunId: 'r1' };
  const events = [
    ev({ ...base, eventId: '1', type: 'stage_attempt_started', attemptId: 'a1', actorId: 'sup', role: 'supervisor', seq: 1, payload: { stages: ['plan'] } }),
    ev({ ...base, eventId: '2', type: 'stage_attempt_completed', attemptId: 'a1', actorId: 'sup', role: 'supervisor', seq: 2, payload: { status: 'ok' } }),
    ev({ ...base, eventId: '3', type: 'stage_attempt_started', attemptId: 'a2', actorId: 'w1', role: 'worker', parentActorId: 'sup', seq: 3, payload: { stages: ['dev'], dependsOnAttemptIds: ['a1'] } }),
    ev({ ...base, eventId: '4', type: 'stage_attempt_started', attemptId: 'a3', actorId: 'w2', role: 'worker', parentActorId: 'sup', seq: 4, payload: { stages: ['test'], dependsOnAttemptIds: ['a1'] } }),
    ev({ ...base, eventId: '5', type: 'stage_attempt_completed', attemptId: 'a3', actorId: 'w2', role: 'worker', parentActorId: 'sup', seq: 5, payload: { status: 'ok' } }),
    ev({ ...base, eventId: '6', type: 'stage_attempt_completed', attemptId: 'a2', actorId: 'w1', role: 'worker', parentActorId: 'sup', seq: 6, payload: { status: 'ok' } }),
    ev({ ...base, eventId: '7', type: 'stage_attempt_started', attemptId: 'a4', actorId: 'sup', role: 'supervisor', seq: 7, payload: { stages: ['review'], dependsOnAttemptIds: ['a2','a3'] } }),
    ev({ ...base, eventId: '8', type: 'stage_attempt_completed', attemptId: 'a4', actorId: 'sup', role: 'supervisor', seq: 8, payload: { status: 'ok' } }),
    ev({ ...base, eventId: '9', type: 'supervisor_stopped', actorId: 'sup', role: 'supervisor', seq: 9, occurredAt: 900, payload: { status: 'completed' } }),
    // in-progress run: started prefix only
    ev({ taskKey: 'T-1', workflowRunId: 'r2', eventId: '10', type: 'stage_attempt_started', attemptId: 'a5', actorId: 'sup', role: 'supervisor', seq: 1, payload: { stages: ['plan'] } }),
    // unattributed completed run: no taskKey at all
    ev({ workflowRunId: 'r3', eventId: '11', type: 'stage_attempt_started', attemptId: 'a6', actorId: 'sup', role: 'supervisor', seq: 1, payload: { stages: ['plan'] } }),
    ev({ workflowRunId: 'r3', eventId: '12', type: 'stage_attempt_completed', attemptId: 'a6', actorId: 'sup', role: 'supervisor', seq: 2, payload: { status: 'ok' } }),
    ev({ workflowRunId: 'r3', eventId: '13', type: 'supervisor_stopped', actorId: 'sup', role: 'supervisor', seq: 3, payload: { status: 'completed' } }),
  ];

  const stats = aggregateRuntimeStatistics({ events });
  assert.equal(stats.workflows.observedRoutes.completedRuns, 1); // unattributed r3 stays out
  assert.deepEqual(stats.workflows.observedRoutes.completed, [
    { route: 'plan > dev|test > review', runs: 1, pct: 100 }, // a3 starts (4) before a2 completes (6): parallel
  ]);
  assert.deepEqual(stats.workflows.observedRoutes.inProgress, [{ route: 'plan', runs: 1 }]);
  assert.equal(stats.workflows.observedRoutes.unattributedRuns, 1);

  const filtered = aggregateRuntimeStatistics({ events, taskKey: 'T-1' });
  assert.equal(filtered.workflows.observedRoutes.unattributedRuns, 0);
  assert.equal(filtered.workflows.observedRoutes.completedRuns, 1);
});

test('rework: explicit events only, infrastructure retry excluded, affected completed tasks', () => {
  const events = [
    ev({ eventId: 'st1', type: 'supervisor_stopped', taskKey: 'T-1', workflowRunId: 'r1', payload: { status: 'completed' } }),
    ev({ eventId: 'st2', type: 'supervisor_stopped', taskKey: 'T-2', workflowRunId: 'r9', payload: { status: 'completed' } }),
    ev({ eventId: 'ret1', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a1', toAttemptId: 'a2', source: 'direct', reason: 'review', evidenceRef: 'ev-1' } }),
    ev({ eventId: 'ret2', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a2', toAttemptId: 'a3', source: 'inferred', reason: 'test', evidenceRef: 'ev-2' } }),
    ev({ eventId: 'ret3', type: 'return_to_dev', taskKey: 'T-3', workflowRunId: 'r3', payload: { fromAttemptId: 'a1', toAttemptId: 'a2', source: 'direct', reason: 'deploy-failed', evidenceRef: 'ev-3' } }),
    ev({ eventId: 'ret4', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a3', toAttemptId: 'a4', source: 'infrastructure', reason: 'other', evidenceRef: 'ev-4' } }),
    ev({ eventId: 'ret5', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a4', toAttemptId: 'a5', source: 'direct', reason: 'human', evidenceRef: 'ev-5' } }),
    ev({ eventId: 'ret6', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a5', toAttemptId: 'a6', source: 'direct', reason: 'test' } }), // no evidenceRef
    ev({ eventId: 'ret7', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a1', toAttemptId: 'a1', source: 'direct', reason: 'test', evidenceRef: 'ev-7' } }),
    ev({ eventId: 'ret8', type: 'return_to_dev', workflowRunId: 'r5', payload: { fromAttemptId: 'a1', toAttemptId: 'a2', source: 'direct', reason: 'test', evidenceRef: 'ev-8' } }), // no taskKey
    ev({ eventId: 'ret9', type: 'return_to_dev', taskKey: 'T-1', workflowRunId: 'r1', payload: { fromAttemptId: 'a6', toAttemptId: 'a7', source: 'direct', reason: 'unknown', evidenceRef: 'ev-9' } }),
  ];

  const stats = aggregateRuntimeStatistics({ events });
  assert.equal(stats.rework.count, 6); // ret1, ret2, ret3, ret5, ret8, ret9
  assert.deepEqual(stats.rework.byReason, { review: 1, test: 2, human: 1, other: 1, unknown: 1 });
  assert.deepEqual(stats.rework.bySource, { direct: 5, inferred: 1, other: 0 });
  assert.equal(stats.rework.completedTasks, 2);
  assert.equal(stats.rework.completedTasksAffected, 1); // only T-1
  assert.equal(stats.rework.affectedPct, 50); // 100 * 1 / 2
  assert.deepEqual(stats.rework.excluded, { infrastructureRetry: 1, sameAttempt: 1, incomplete: 1, unattributed: 1 });
});

test('window clips lifecycle and spans; open busy spans are never extended', () => {
  const events = [
    ev({ eventId: 's1', type: 'supervisor_started', actorId: 'a-1', role: 'lead', occurredAt: -500 }),
    ev({ eventId: 's2', type: 'supervisor_stopped', actorId: 'a-1', role: 'lead', occurredAt: 500 }),
    ev({ eventId: 's3', type: 'supervisor_started', actorId: 'a-2', role: 'lead', occurredAt: 0 }),
    ev({ eventId: 's4', type: 'supervisor_stopped', actorId: 'a-2', role: 'lead', occurredAt: 1000 }),
  ];
  const spans = [
    span({ spanId: 'i1', actorId: 'a-1', role: 'lead', startAt: -100, endAt: 100 }),
    span({ spanId: 'b1', actorId: 'a-1', role: 'lead', name: 'claude_code.llm_request', startAt: -50, endAt: 50 }),
    span({ spanId: 'i2', actorId: 'a-2', role: 'lead', startAt: 0, endAt: 1000 }),
    span({ spanId: 'b2', actorId: 'a-2', role: 'lead', name: 'claude_code.llm_request', startAt: 500, endAt: null }), // open: dropped
  ];

  const stats = aggregateRuntimeStatistics({ events, spans, from: 0, to: 1000 });
  const byId = new Map(stats.actors.map((a) => [a.actorId, a]));

  assert.equal(byId.get('a-1').eligibleMs, 500); // [-500,500] clipped to [0,1000]
  assert.equal(byId.get('a-1').knownMs, 100); // [-100,100] clipped to [0,100]
  assert.equal(byId.get('a-1').busyMs, 50);
  assert.equal(byId.get('a-1').activePct, 50);
  assert.equal(byId.get('a-1').coveragePct, 20);

  assert.equal(byId.get('a-2').busyMs, 0); // open llm_request contributes nothing
  assert.equal(byId.get('a-2').activePct, 0); // known > 0, busy 0
  assert.equal(byId.get('a-2').coveragePct, 100);
  assert.equal(stats.coverage.openSpansDropped, 1);
});

test('empty inputs produce null percentages and zero counts', () => {
  const stats = aggregateRuntimeStatistics({});

  assert.deepEqual(stats.actors, []);
  assert.deepEqual(stats.roles, []);
  assert.equal(stats.team.actors, 0);
  assert.equal(stats.team.eligibleMs, null);
  assert.equal(stats.team.activePct, null);
  assert.equal(stats.team.coveragePct, null);
  assert.deepEqual(stats.workflows.initialChoice, { runsTotal: 0, runsKnown: 0, runsUnknownChoice: 0, proportions: [] });
  assert.deepEqual(stats.workflows.observedRoutes, { completedRuns: 0, completedUnknownRoutes: 0, completed: [], inProgress: [], unattributedRuns: 0 });
  assert.equal(stats.rework.count, 0);
  assert.equal(stats.rework.affectedPct, null);
  assert.equal(stats.coverage.knownMs, 0);
  assert.equal(stats.coverage.eligibleMs, null);
  assert.equal(stats.coverage.coveragePct, null);

  const withUnknown = aggregateRuntimeStatistics({ events: [ev({ eventId: 'x1', type: 'bogus_event' })] });
  assert.deepEqual(withUnknown.coverage.unknownEventTypes, [{ type: 'bogus_event', count: 1 }]);
  assert.equal(withUnknown.coverage.invalidEvents, 1);
});

test('task filter excludes other tasks from actors and workflows', () => {
  const events = [
    ev({ eventId: 's1', type: 'supervisor_started', actorId: 'a-1', role: 'lead', taskKey: 'T-1', occurredAt: 0 }),
    ev({ eventId: 's2', type: 'supervisor_started', actorId: 'a-2', role: 'lead', taskKey: 'T-2', occurredAt: 0 }),
    ev({ eventId: 'w1', type: 'workflow_selected', workflowRunId: 'r2', taskKey: 'T-2', seq: 1, payload: { stages: ['dev', 'test'] } }),
  ];
  const spans = [
    span({ spanId: 'k1', actorId: 'a-1', role: 'lead', taskKey: 'T-1', startAt: 0, endAt: 100 }),
    span({ spanId: 'k2', actorId: 'a-2', role: 'lead', taskKey: 'T-2', startAt: 0, endAt: 100 }),
  ];

  const stats = aggregateRuntimeStatistics({ events, spans, taskKey: 'T-1' });
  assert.deepEqual(stats.actors.map((a) => a.actorId), ['a-1']);
  assert.equal(stats.workflows.initialChoice.runsTotal, 0);
  assert.equal(stats.team.knownMs, 100);
});

test('windowed choices and completed routes retain boundary attempts without counting old choices',()=>{
 const base={taskKey:'ws:one',workflowRunId:'r'};
 const events=[ev({...base,eventId:'old',type:'workflow_selected',occurredAt:0,payload:{stages:['dev']}}),ev({...base,eventId:'start',type:'stage_attempt_started',attemptId:'dev1',occurredAt:10,payload:{stages:['dev']}}),ev({...base,eventId:'finish',type:'stage_attempt_completed',attemptId:'dev1',occurredAt:110}),ev({...base,eventId:'done',type:'workflow_completed',occurredAt:120})];
 const s=aggregateRuntimeStatistics({events,from:100,to:200});assert.equal(s.workflows.initialChoice.runsKnown,0);assert.equal(s.workflows.observedRoutes.completedRuns,1);assert.equal(s.workflows.observedRoutes.completed[0].route,'dev');
 assert.equal(aggregateRuntimeStatistics({events,from:200,to:300}).workflows.observedRoutes.completedRuns,0);
});
test('actor-local sequences cannot invent cross-actor stage order',()=>{
 const events=['dev','review'].flatMap((stage,i)=>[ev({eventId:'s'+i,taskKey:'w:t',workflowRunId:'r',type:'stage_attempt_started',actorId:stage,attemptId:stage,seq:i+1,payload:{stages:[stage]}}),ev({eventId:'e'+i,taskKey:'w:t',workflowRunId:'r',type:'stage_attempt_completed',actorId:stage,attemptId:stage,seq:i+2})]);
 events.push(ev({eventId:'done',taskKey:'w:t',workflowRunId:'r',type:'workflow_completed'}));
 assert.match(aggregateRuntimeStatistics({events}).workflows.observedRoutes.completed[0].route,/^unordered:/);
});

test('native tool descendants inherit actor and tool through trace parents, child requests stay separate',()=>{
 const base={traceId:'t',taskKey:'w:t',supervisorSessionId:'s',baseActorId:'lead',role:'supervisor',actorId:'lead'};
 const spans=[span({...base,spanId:'i',startAt:0,endAt:100}),span({...base,spanId:'tool',parentSpanId:'i',name:'claude_code.tool',toolName:'Agent',startAt:10,endAt:90}),span({...base,spanId:'exec',parentSpanId:'tool',name:'claude_code.tool.execution',startAt:10,endAt:90}),span({...base,spanId:'child',parentSpanId:'exec',actorId:'lead:child',agentId:'child',name:'claude_code.llm_request',startAt:20,endAt:80})];
 const s=aggregateRuntimeStatistics({spans,from:0,to:100});const lead=s.actors.find(a=>a.actorId==='lead'),child=s.actors.find(a=>a.actorId==='lead:child');assert.equal(lead.busyMs,0);assert.equal(lead.waitingOnChildMs,80);assert.equal(child.busyMs,60);assert.equal(child.role,'unknown');assert.equal(child.knownMs,60);assert.equal(child.coveragePct,null);
});
