// Runtime statistics (PRD "Task workspace, concurrent supervisors, manager
// tool config, statistics & semantic map" §9–10, phase P3) — the /insights/runtime
// screen (App/nav wiring lives in the parent slice). Polls
// /api/runtime-statistics every 15 s (usePoll aborts in-flight requests and
// keeps the last data on a failed fetch — a bad poll never blanks the view).
//
// Filters live in the URL via filtersFromQuery / queryFromFilters (timeframe
// 24h/7d/all + taskKey), so a refresh or a shared link keeps the view.
//
// Honesty rules rendered from statisticsModel.js: a missing denominator reads
// "Unavailable", never 0; coverage shows known and unknown durations adjacent;
// planned proportions, observed completed routes and in-progress routes stay
// in separate sections; the data-quality banner explains every partial counter
// instead of advertising global counts.

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './statistics.css';
import { usePoll } from '../hooks/usePoll';
import {
  TIMEFRAMES,
  OCCUPANCY_NOTE,
  getRuntimeStatistics,
  filtersFromQuery,
  queryFromFilters,
  actorRows,
  roleRows,
  teamRow,
  plannedRows,
  completedRouteRows,
  inProgressRouteRows,
  revisionRows,
  reworkSummary,
  reworkReasonRows,
  reworkSourceRows,
  reworkEventRows,
  coverageWarnings,
  formatDuration,
  formatPct,
  formatCount,
  textOr,
} from '../statisticsModel';

// Bar + text pair: the bar never replaces the number (colour/shape is never
// the only signal, spec §7).
function Bar({ pct, title }) {
  return (
    <span className="stats-bar" title={title}>
      <span className="stats-bar-fill" style={{ width: pct + '%' }} />
    </span>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="stats-panel">
      <h3 className="stats-panel-title">{title}</h3>
      {note ? <p className="stats-panel-note">{note}</p> : null}
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="stats-empty">{children}</p>;
}

export default function Statistics() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const filters = filtersFromQuery(searchParams.toString());
  // deps key: a filter change re-arms the poll (immediate fetch + fresh
  // interval); the fetcher itself always sees the latest filters.
  const filtersKey = queryFromFilters(filters);

  const { data, error, loading } = usePoll(
    (signal) => getRuntimeStatistics(filters, signal),
    15000,
    [filtersKey],
  );

  // The taskKey draft: free-form while typing, applied only when canonical
  // (a non-canonical value navigates nowhere — the URL never carries a key
  // the API would 400 on).
  const [taskKeyDraft, setTaskKeyDraft] = useState(filters.taskKey || '');
  const applyTaskKey = () => {
    const value = taskKeyDraft.trim();
    navigate('/insights/runtime' + queryFromFilters({ ...filters, taskKey: value || null }));
  };

  const statistics = data?.statistics || null;
  const query = data?.query || null;
  const team = teamRow(statistics);
  const actors = actorRows(statistics);
  const roles = roleRows(statistics);
  const planned = plannedRows(statistics);
  const completed = completedRouteRows(statistics);
  const inProgress = inProgressRouteRows(statistics);
  const revisions = revisionRows(statistics);
  const rework = reworkSummary(statistics?.rework);
  const reworkEvents = reworkEventRows(statistics?.rework);
  const warnings = coverageWarnings(statistics);
  const partial = Boolean(query?.truncated) || warnings.length > 0;

  const setTimeframe = (key) =>
    navigate('/insights/runtime' + queryFromFilters({ ...filters, timeframe: key }));

  return (
    <div className="stats">
      <div className="stats-head">
        <h2 className="stats-title">Runtime statistics</h2>
        <p className="stats-sub">
          Supervisor workflow activity for the selected window. {OCCUPANCY_NOTE}
        </p>
      </div>

      <div className="stats-filters">
        <div className="stats-timeframes" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={'stats-chip' + (filters.timeframe === t.key ? ' stats-chip-active' : '')}
              onClick={() => setTimeframe(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <form
          className="stats-taskkey"
          onSubmit={(e) => { e.preventDefault(); applyTaskKey(); }}
        >
          <input
            type="text"
            value={taskKeyDraft}
            placeholder="taskKey (workspace:issueId)"
            aria-label="Filter by task key"
            onChange={(e) => setTaskKeyDraft(e.target.value)}
          />
          <button type="submit">Filter</button>
          {filters.taskKey ? (
            <button
              type="button"
              onClick={() => { setTaskKeyDraft(''); navigate('/insights/runtime' + queryFromFilters({ ...filters, taskKey: null })); }}
            >
              Clear
            </button>
          ) : null}
        </form>
      </div>

      {error ? (
        <p className="stats-banner stats-banner-error" role="alert">
          Failed to load statistics: {error.message || String(error)}
          {data ? ' — showing the last loaded data.' : ''}
        </p>
      ) : null}
      {partial ? (
        <p className="stats-banner stats-banner-partial">
          Partial data for this window — some results may be incomplete:
          {query?.truncated ? ' the store hit the 10 000-record query bound;' : ''}
          {warnings.length ? ' ' + warnings.join('; ') + '.' : ''}
        </p>
      ) : null}

      {loading && !data ? (
        <p className="stats-empty">Loading statistics…</p>
      ) : null}

      {data && !statistics ? <Empty>Statistics payload is malformed.</Empty> : null}

      {statistics ? (
        <>
          <Panel
            title="Team"
            note="Pooled over every actor with recorded activity in the window."
          >
            {team && team.actorsCount > 0 ? (
              <div className="stats-tiles">
                <div className="stats-tile" title="Actors with recorded activity in the window">
                  <span className="stats-tile-value">{formatCount(team.actorsCount)}</span>
                  <span className="stats-tile-label">Actors</span>
                </div>
                <div
                  className="stats-tile"
                  title="Busy time (LLM requests + tool execution, incl. model latency) / known interaction time"
                >
                  <span className="stats-tile-value">{textOr(team.activeText)}</span>
                  <span className="stats-tile-label">Active share</span>
                  <Bar pct={team.activeBarPct} title="Busy / known interaction time" />
                </div>
                <div
                  className="stats-tile"
                  title={`Coverage: known interaction time / eligible lifetime — known ${textOr(team.knownText)}, unknown ${textOr(team.unknownText)}`}
                >
                  <span className="stats-tile-value">{textOr(team.coverageText)}</span>
                  <span className="stats-tile-label">Coverage</span>
                  <span className="stats-tile-sub">
                    known {textOr(team.knownText)} / unknown {textOr(team.unknownText)}
                  </span>
                </div>
                <div className="stats-tile" title="Time blocked on child agents (delegation execution)">
                  <span className="stats-tile-value">{textOr(team.waitingOnChildText)}</span>
                  <span className="stats-tile-label">Waiting on child</span>
                </div>
                <div className="stats-tile" title="Time blocked on a human gate">
                  <span className="stats-tile-value">{textOr(team.waitingOnHumanText)}</span>
                  <span className="stats-tile-label">Waiting on human</span>
                </div>
              </div>
            ) : (
              <Empty>No runtime activity recorded in this window.</Empty>
            )}
          </Panel>

          <Panel
            title="Actors"
            note="Active share = busy / known interaction time (model interaction, not CPU); coverage = known / eligible lifetime — known and unknown durations always shown beside it."
          >
            {actors.length === 0 ? (
              <Empty>No actor activity recorded in this window.</Empty>
            ) : (
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Actor</th>
                    <th>Role</th>
                    <th title="Busy (LLM + tool execution, incl. model latency) / known interaction time">Active</th>
                    <th title="Known interaction time / eligible lifetime">Coverage</th>
                    <th title="Known interaction time — the denominator of Active">Known</th>
                    <th title="Eligible lifetime minus known">Unknown</th>
                    <th title="Eligible lifetime (bounded by supervisor lifecycle and the window)">Eligible</th>
                    <th title="Busy time (LLM + tool execution)">Busy</th>
                    <th title="Time blocked on child agents">Wait child</th>
                    <th title="Time blocked on a human gate">Wait human</th>
                  </tr>
                </thead>
                <tbody>
                  {actors.map((a) => (
                    <tr key={a.actorId}>
                      <td className="stats-mono">{a.actorId}</td>
                      <td>{a.role}</td>
                      <td>
                        {textOr(a.activeText)}
                        <Bar pct={a.activeBarPct} title="Busy / known interaction time" />
                      </td>
                      <td title={`known ${textOr(a.knownText)} / unknown ${textOr(a.unknownText)} of eligible ${textOr(a.eligibleText)}`}>
                        {textOr(a.coverageText)}
                      </td>
                      <td>{textOr(a.knownText)}</td>
                      <td>{textOr(a.unknownText)}</td>
                      <td>{textOr(a.eligibleText)}</td>
                      <td>{textOr(formatDuration(a.busyMs))}</td>
                      <td>{textOr(a.waitingOnChildText)}</td>
                      <td>{textOr(a.waitingOnHumanText)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Roles"
            note="Duration pools summed per role — never averages of percentages."
          >
            {roles.length === 0 ? (
              <Empty>No role pools recorded in this window.</Empty>
            ) : (
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Actors</th>
                    <th title="Busy (LLM + tool execution) / known interaction time">Active</th>
                    <th title="Known interaction time / eligible lifetime">Coverage</th>
                    <th title="Known interaction time">Known</th>
                    <th title="Eligible lifetime minus known">Unknown</th>
                    <th title="Time blocked on child agents">Wait child</th>
                    <th title="Time blocked on a human gate">Wait human</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.role}>
                      <td>{r.role}</td>
                      <td>{textOr(formatCount(r.actorsCount))}</td>
                      <td>
                        {textOr(r.activeText)}
                        <Bar pct={r.activeBarPct} title="Busy / known interaction time" />
                      </td>
                      <td>{textOr(r.coverageText)}</td>
                      <td>{textOr(r.knownText)}</td>
                      <td>{textOr(r.unknownText)}</td>
                      <td>{textOr(r.waitingOnChildText)}</td>
                      <td>{textOr(r.waitingOnHumanText)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Workflows"
            note="Planned choices, observed completed routes and in-progress routes are separate counts — never one mixed list."
          >
            <h4 className="stats-subhead">
              Planned — initial choice{' '}
              <span className="stats-denom">
                (share of runs with a known choice:{' '}
                {textOr(formatCount(planned.runsKnown), 'unknown')} of{' '}
                {textOr(formatCount(planned.runsTotal), 'unknown')};
                {' '}{textOr(formatCount(planned.runsUnknownChoice), 'unknown')} unknown)
              </span>
            </h4>
            {planned.rows.length === 0 ? (
              <Empty>No workflow choice recorded in this window.</Empty>
            ) : (
              <ul className="stats-bars">
                {planned.rows.map((p) => (
                  <li key={p.stagesText}>
                    <span className="stats-bars-label">{p.stagesText}</span>
                    <Bar pct={p.barPct} title={`${p.runsText} of ${textOr(formatCount(planned.runsKnown), 'unknown')} runs with a known choice`} />
                    <span className="stats-bars-value">{textOr(p.pctText)} ({textOr(p.runsText)})</span>
                  </li>
                ))}
              </ul>
            )}

            <h4 className="stats-subhead">
              Observed — completed routes{' '}
              <span className="stats-denom">
                (share of {textOr(formatCount(completed.completedRuns), 'unknown')} completed runs)
              </span>
            </h4>
            {completed.rows.length === 0 ? (
              <Empty>No completed run observed in this window.</Empty>
            ) : (
              <ul className="stats-bars">
                {completed.rows.map((r) => (
                  <li key={r.route}>
                    <span className="stats-bars-label">{r.route}</span>
                    <Bar pct={r.barPct} title={`${r.runsText} of ${textOr(formatCount(completed.completedRuns), 'unknown')} completed runs`} />
                    <span className="stats-bars-value">{textOr(r.pctText)} ({textOr(r.runsText)})</span>
                  </li>
                ))}
              </ul>
            )}

            <h4 className="stats-subhead">In progress — started routes (counts only)</h4>
            {inProgress.rows.length === 0 ? (
              <Empty>No run currently in progress.</Empty>
            ) : (
              <ul className="stats-bars">
                {inProgress.rows.map((r) => (
                  <li key={r.route}>
                    <span className="stats-bars-label">{r.route}</span>
                    <span className="stats-bars-value">{textOr(r.runsText)} runs</span>
                  </li>
                ))}
              </ul>
            )}
            {inProgress.unattributedRuns != null && inProgress.unattributedRuns > 0 ? (
              <p className="stats-note">
                {formatCount(inProgress.unattributedRuns)} runs in progress without a task attribution (shown separately, never as "other").
              </p>
            ) : null}

            <h4 className="stats-subhead">
              Revisions{' '}
              <span className="stats-denom">
                ({textOr(formatCount(revisions.count))} workflow_revised events)
              </span>
            </h4>
            {revisions.rows.length === 0 ? (
              <Empty>No workflow revision recorded in this window.</Empty>
            ) : (
              <ul className="stats-plain">
                {revisions.rows.map((r) => (
                  <li key={r.stagesText}>
                    {r.stagesText}: {textOr(r.countText)}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Rework"
            note="return_to_dev transitions that are real rework — infrastructure retries and same-attempt pairs are excluded, and the exclusions stay visible."
          >
            {rework ? (
              <>
                <div className="stats-tiles">
                  <div className="stats-tile" title="Counted return_to_dev transitions after exclusions">
                    <span className="stats-tile-value">{textOr(rework.countText)}</span>
                    <span className="stats-tile-label">Rework transitions</span>
                  </div>
                  <div
                    className="stats-tile"
                    title={`Completed tasks affected / completed tasks: ${textOr(rework.completedTasksAffectedText)} of ${textOr(rework.completedTasksText)}`}
                  >
                    <span className="stats-tile-value">{textOr(rework.affectedPctText)}</span>
                    <span className="stats-tile-label">Completed tasks affected</span>
                    <span className="stats-tile-sub">
                      {textOr(rework.completedTasksAffectedText)} of {textOr(rework.completedTasksText)} completed
                    </span>
                  </div>
                </div>
                <div className="stats-cols">
                  <div>
                    <h4 className="stats-subhead">By reason</h4>
                    <ul className="stats-plain">
                      {reworkReasonRows(statistics.rework).map((r) => (
                        <li key={r.reason}>{r.reason}: {r.countText}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="stats-subhead">By source</h4>
                    <ul className="stats-plain">
                      {reworkSourceRows(statistics.rework).map((r) => (
                        <li key={r.source}>{r.source}: {r.countText}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="stats-subhead">Excluded (not rework)</h4>
                    <ul className="stats-plain">
                      <li>Infrastructure retry: {formatCount(rework.excluded.infrastructureRetry)}</li>
                      <li>Same attempt: {formatCount(rework.excluded.sameAttempt)}</li>
                      <li>Incomplete records: {formatCount(rework.excluded.incomplete)}</li>
                      <li>Unattributed (no taskKey): {formatCount(rework.excluded.unattributed)}</li>
                    </ul>
                  </div>
                </div>
                {reworkEvents.length > 0 ? (
                  <>
                    <h4 className="stats-subhead">Transitions</h4>
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Workflow run</th>
                          <th>From attempt</th>
                          <th>To attempt</th>
                          <th>Reason</th>
                          <th>Source</th>
                          <th>Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reworkEvents.map((e) => (
                          <tr key={e.key}>
                            <td>
                              {e.taskKeyHref ? (
                                <a className="stats-link" href={e.taskKeyHref}>{e.taskKey}</a>
                              ) : (
                                textOr(e.taskKey, 'unattributed')
                              )}
                            </td>
                            <td className="stats-mono">{textOr(e.workflowRunId)}</td>
                            <td className="stats-mono">{textOr(e.fromAttemptId)}</td>
                            <td className="stats-mono">{textOr(e.toAttemptId)}</td>
                            <td>{textOr(e.reason)}</td>
                            <td>{textOr(e.source)}</td>
                            <td className="stats-mono">{textOr(e.evidenceRef)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : null}
              </>
            ) : (
              <Empty>No rework data in this window.</Empty>
            )}
          </Panel>

          <Panel
            title="Data quality"
            note="Coverage and record hygiene for this window — the numbers above are only as complete as this says."
          >
            {statistics.coverage ? (
              <ul className="stats-plain">
                <li>
                  Coverage: {textOr(formatPct(statistics.coverage.coveragePct))}
                  {' '}— known {textOr(formatDuration(statistics.coverage.knownMs))} /
                  unknown {textOr(formatDuration(statistics.coverage.unknownMs))} of
                  eligible {textOr(formatDuration(statistics.coverage.eligibleMs))}
                </li>
                <li>Duplicate event records ignored: {formatCount(statistics.coverage.duplicateEventIds)}</li>
                <li>Duplicate span records ignored: {formatCount(statistics.coverage.duplicateSpanIds)}</li>
                <li>Malformed event records dropped: {formatCount(statistics.coverage.invalidEvents)}</li>
                <li>Open/invalid spans dropped: {formatCount(statistics.coverage.openSpansDropped)}</li>
                <li>Spans without an actor dropped: {formatCount(statistics.coverage.spansWithoutActor)}</li>
                <li>Attempt events without an attemptId: {formatCount(statistics.coverage.attemptEventsWithoutId)}</li>
                <li>Actors without an eligible lifetime: {formatCount(statistics.coverage.actorsWithoutEligible)}</li>
                {(statistics.coverage.unknownEventTypes || []).map((u) => (
                  <li key={u.type}>Unknown event type "{u.type}" ignored: {formatCount(u.count)}</li>
                ))}
                {(statistics.coverage.unknownSpanNames || []).map((u) => (
                  <li key={u.name}>Unknown span name "{u.name}" ignored: {formatCount(u.count)}</li>
                ))}
                {query ? (
                  <li>
                    Query bound: {formatCount(query.limit)} records per source —
                    events truncated: {query.eventsTruncated ? 'yes' : 'no'},
                    spans truncated: {query.spansTruncated ? 'yes' : 'no'}
                  </li>
                ) : null}
              </ul>
            ) : (
              <Empty>No data-quality information in this payload.</Empty>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}