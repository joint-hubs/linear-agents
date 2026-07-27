import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getLinearQueue, getRuns, postLaunch, getTerminals, focusTerminal, stopTerminal } from '../api';
import { linearUrl, WORKSPACES, DEFAULT_WORKSPACE } from '../config';
import { fmtTime, elapsed, taskLabel, fmtUSD, fmtCost, costValue, isStale } from '../utils';

const POLL_MS = 10000;

// Squads that have a launcher (bin/<squad>.bat) AND a HOW-TO §4 kickoff. Must
// match SQUAD_ALLOWLIST in scripts/launch.mjs — a Launch click sends one of these
// to POST /api/launch. `cadence` is weekly (no taskId) so it's not launched from
// a task row; `plan` is reached via Todo+dor-ok→dev in handoff-rules, not directly.
const LAUNCHABLE_SQUADS = ['dev', 'review', 'test'];

// needs:* label display (any separator — handoff-rules matches both `needs:answer`
// and `needs-decision`). Pulled out so the CZEKA section can surface it.
function needsLabel(task) {
  return (task.labels || []).find((l) => l.startsWith('needs:') || l.startsWith('needs-'));
}

// Task chip — ↗ link to Linear when the prefix is known (reuses config.js).
function TaskChip({ id }) {
  const url = linearUrl(id);
  if (url) {
    return (
      <a className="link" href={url} target="_blank" rel="noopener noreferrer">
        {id} ↗
      </a>
    );
  }
  return <span>{id || '—'}</span>;
}

// One NEXT UP row: identifier, title, state · labels, →SQUAD, Launch button.
function NextUpRow({ task, onLaunch, taskCost }) {
  const squad = task.suggestedSquad;
  return (
    <div className="task-row">
      <div className="task-row-main">
        <TaskChip id={task.identifier} />
        <span className="muted">
          {task.state}
          {task.estimate != null ? ` · ${task.estimate}pt` : ''}
        </span>
        <span className="pill">→ {squad}</span>
        {taskCost && taskCost.runs > 0 && (
          <span className="muted" style={{ fontSize: 11 }} title={`${taskCost.runs} previous run${taskCost.runs === 1 ? '' : 's'}`}>
            {fmtUSD(taskCost.cost)} · {taskCost.runs}r
          </span>
        )}
      </div>
      <div className="task-row-title">{task.title}</div>
      <div className="task-row-foot">
        <button className="launch-btn" onClick={() => onLaunch(task)}>
          ▶ Launch local
        </button>
      </div>
    </div>
  );
}

// One CZEKA NA CIEBIE row: a blocked (needs:*) task — NO Launch, only Linear link.
function WaitingRow({ task, taskCost }) {
  const nl = needsLabel(task);
  return (
    <div className="task-row">
      <div className="task-row-main">
        <TaskChip id={task.identifier} />
        {nl && <span className="badge badge-warn">{nl}</span>}
        {taskCost && taskCost.runs > 0 && (
          <span className="muted" style={{ fontSize: 11 }} title={`${taskCost.runs} previous run${taskCost.runs === 1 ? '' : 's'}`}>
            {fmtUSD(taskCost.cost)} · {taskCost.runs}r
          </span>
        )}
      </div>
      <div className="task-row-title">{task.title}</div>
      <div className="task-row-foot">
        <a className="link" href={task.url || linearUrl(task.identifier)} target="_blank" rel="noopener noreferrer">
          otwórz w Linear ↗
        </a>
      </div>
    </div>
  );
}

// One W TOKU row: an active run (agent working) — pulled from /api/runs (Live).
function ActiveRow({ run }) {
  const taskId = taskLabel(run);
  return (
    <div className="task-row">
      <div className="task-row-main">
        <span className="dot dot-ok" />
        <span className="run-card-squad">{run.squad || '—'}</span>
        <TaskChip id={taskId} />
        <span className="muted">running {elapsed(run.startedAt, run.endedAt)}</span>
      </div>
      <div className="task-row-foot">
        <Link className="link" to={`/runs/${run.runId}`}>
          open in Live
        </Link>
      </div>
    </div>
  );
}

// Launch confirmation modal (control-plane-plan §3.3). Shows squad + task +
// target + the kickoff prompt preview (fetched dryRun). Confirm fires the real
// POST /api/launch (dryRun:false) → a new console window opens; the task then
// appears in Live once the run manifest starts.
function LaunchModal({ task, onClose, onLaunched }) {
  const squad = task.suggestedSquad;
  const [preview, setPreview] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [launching, setLaunching] = useState(false);

  // Fetch the dryRun preview when the modal opens so Mateusz sees the exact
  // kickoff prompt (HOW-TO §4 with {taskId} substituted) before committing.
  useEffect(() => {
    let alive = true;
    setLoadErr(null);
    postLaunch({ taskId: task.identifier, squad, target: 'local', dryRun: true })
      .then((d) => alive && setPreview(d))
      .catch((e) => alive && setLoadErr(e.message));
    return () => { alive = false; };
  }, [task.identifier, squad]);

  const confirm = async () => {
    setLaunching(true);
    try {
      await postLaunch({ taskId: task.identifier, squad, target: 'local', dryRun: false });
      onLaunched({ ok: true, squad, taskId: task.identifier });
    } catch (e) {
      onLaunched({ ok: false, error: e.message });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">Launch {squad} squad</div>
        <div className="modal-grid">
          <span className="muted">Task</span>
          <span><TaskChip id={task.identifier} /> — {task.title}</span>
          <span className="muted">Squad</span>
          <span>{squad}</span>
          <span className="muted">Target</span>
          <span>local <span className="muted">(VM: L2 — not provisioned)</span></span>
          <span className="muted">Kickoff</span>
          <span className="modal-prompt">
            {loadErr && <span className="badge badge-fail">preview failed: {loadErr}</span>}
            {!loadErr && !preview && <span className="muted">loading preview…</span>}
            {preview && <code>{preview.kickoffPrompt}</code>}
          </span>
        </div>
        <div className="modal-foot">
          <button className="btn-secondary" onClick={onClose} disabled={launching}>Cancel</button>
          <button className="launch-btn" onClick={confirm} disabled={launching || !preview}>
            {launching ? 'Launching…' : 'Confirm & Launch'}
          </button>
        </div>
        <div className="muted modal-note">
          Opens a new console window with the kickoff prompt. The run appears in
          Live after the manifest starts (≤5 s).
        </div>
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const cls = toast.ok ? 'toast toast-ok' : 'toast toast-fail';
  return (
    <div className={cls}>
      {toast.ok
        ? `Launched ${toast.squad} for ${toast.taskId} — see Live`
        : `Launch failed: ${toast.error}`}
    </div>
  );
}

export default function Tasks() {
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const [tasks, setTasks] = useState([]);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [modalTask, setModalTask] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // Terminale
  const [terminals, setTerminals] = useState([]);
  const [terminalError, setTerminalError] = useState(null);
  const [stopConfirm, setStopConfirm] = useState(null); // runId to confirm stop
  const [focusError, setFocusError] = useState(null); // {runId, message}
  const [relaunchConfirm, setRelaunchConfirm] = useState(null); // terminal to relaunch

  useEffect(() => {
    let alive = true;
    const tick = () => {
      // allSettled: a Linear outage must NOT take down the active-runs (W TOKU)
      // view — queue degrades to an error note, runs still render. Mirrors Live's
      // budget-is-non-fatal pattern (JOI-66→67).
      Promise.allSettled([getLinearQueue(workspace), getRuns(), getTerminals()]).then(([qRes, rRes, tRes]) => {
        if (!alive) return;
        if (qRes.status === 'fulfilled') {
          setTasks(qRes.value?.tasks || []);
          setQueueError(qRes.value?.error || null);
          setLastUpdated(new Date());
          setError(null);
        } else {
          // Server unreachable (fetch rejected) — surface the api-down banner
          // like Live does. A Linear-side degrade (200 + error field) is handled
          // above as queueError, NOT here.
          setError(qRes.reason?.message || String(qRes.reason));
        }
        if (rRes.status === 'fulfilled') {
          setRuns(rRes.value || []);
        }
        if (tRes.status === 'fulfilled') {
          setTerminals(tRes.value || []);
          setTerminalError(null);
        } else {
          setTerminalError(tRes.reason?.message || String(tRes.reason));
        }
      });
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [workspace]);

  // Show + auto-dismiss the toast. Cleared on manual dismiss too.
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [toast]);

  const onLaunched = (res) => {
    setModalTask(null);
    setToast(res);
  };

  // Section buckets. NEXT UP = handoff rules route to a launchable squad.
  // CZEKA = needs:* (human). W TOKU = active runs from Live.
  const nextUp = tasks.filter((t) => LAUNCHABLE_SQUADS.includes(t.suggestedSquad));
  const waiting = tasks.filter((t) => t.suggestedSquad === 'human');
  const active = runs.filter((r) => !r.endedAt);

  // Per-task cost summary from historical runs (computed client-side from runs).
  const taskCosts = {};
  for (const r of runs) {
    if (!r.taskId) continue;
    if (!taskCosts[r.taskId]) taskCosts[r.taskId] = { runs: 0, cost: 0 };
    taskCosts[r.taskId].runs += 1;
    taskCosts[r.taskId].cost += costValue(r.totals);
  }

  // Terminal handlers
  const handleFocus = async (runId) => {
    try {
      await focusTerminal(runId);
      setFocusError(null);
    } catch (e) {
      setFocusError({ runId, message: e.message || String(e) });
    }
  };

  const handleStop = async (runId) => {
    setStopConfirm(null);
    try {
      await stopTerminal(runId);
    } catch (e) {
      // surface error — terminal may already be gone
      setTerminalError(e.message || String(e));
    }
  };

  const handleRelaunch = async (t) => {
    setRelaunchConfirm(null);
    try {
      await postLaunch({ squad: t.squad, taskId: t.taskId, target: 'local', dryRun: false });
      setToast({ ok: true, squad: t.squad, taskId: t.taskId });
    } catch (e) {
      setToast({ ok: false, error: e.message });
    }
  };

  // Health stats.
  const now = new Date();
  const staleRuns = runs.filter((r) => isStale(r, now));
  const untaggedRuns = runs.filter((r) => !r.taskId && costValue(r.totals) > 0);
  const untaggedCost = untaggedRuns.reduce((a, r) => a + costValue(r.totals), 0);
  const failedRuns = runs.filter((r) => r.status === 'failed');
  const failedCost = failedRuns.reduce((a, r) => a + costValue(r.totals), 0);
  const hasHealthIssues = staleRuns.length > 0 || untaggedRuns.length > 0 || failedRuns.length > 0;

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <div className="page-title">Tasks</div>
          <div className="page-sub">Linear queue · handoff-rules · poll {POLL_MS / 1000}s</div>
        </div>
        <select
          className="filter-sel"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          title="Linear workspace"
        >
          {WORKSPACES.map((w) => (
            <option key={w.id} value={w.id}>{w.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="card api-down">
          <div className="card-h">Telemetry server unreachable</div>
          <div>Start it: <code>node scripts/telemetry-server.mjs</code></div>
        </div>
      )}

      {/* TERMINALE */}
      <div className="section">
        <div className="section-h">
          Terminale{' '}
          <span className="muted">
            ({terminals.filter((t) => t.alive).length} żywych)
          </span>
        </div>
        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text)' }}>
            Jak z tego korzystać?
          </summary>
          <div className="muted" style={{ marginTop: 8, lineHeight: 1.65, fontSize: 13 }}>
            <p style={{ marginTop: 0 }}>
              Ten ekran to pilot do agentów. Na górze widzisz <b>terminale</b> — czyli agentów,
              którzy pracują teraz. Niżej <b>kolejkę zadań</b> z Linear, gotowych do wzięcia.
            </p>

            <p><b>Co jest czym</b></p>
            <ul style={{ marginTop: 4, paddingLeft: 18 }}>
              <li><b>Skład</b> (plan, dev, review, test, cadence) — zespół agentów od jednego etapu
                pracy. Plan rozpisuje zadania, dev koduje, review recenzuje, test wdraża,
                cadence robi tygodniowe podsumowanie.</li>
              <li><b>Przebieg</b> — jedno uruchomienie składu. Ma swój koszt, czas i przypisane zadanie.</li>
              <li><b>Terminal</b> — okno, w którym ten przebieg naprawdę działa na Twoim komputerze.</li>
              <li><b>Zadanie</b> (np. <code>JOI-53</code>) — pozycja z Linear. Agent uruchomiony stąd
                dostaje ją automatycznie przypisaną, więc koszt trafia we właściwe miejsce.</li>
            </ul>

            <p><b>Co możesz zrobić</b></p>
            <ul style={{ marginTop: 4, paddingLeft: 18 }}>
              <li><b>Pokaż okno</b> — podnosi okno agenta na wierzch. Jeśli system odmówi,
                zamiast tego zamiga przyciskiem na pasku zadań, żebyś je znalazł wzrokiem.</li>
              <li><b>Zatrzymaj</b> — zamyka okno i przerywa pracę agenta. Wymaga potwierdzenia,
                bo przerwana praca nie jest zapisywana.</li>
              <li><b>Launch local</b> przy zadaniu — otwiera nowe okno agenta i od razu wkleja mu
                polecenie startowe. Skład jest podpowiadany z reguł handoffu.</li>
              <li><b>Uruchom ponownie</b> w zwiniętej liście zakończonych — startuje ten sam skład
                z tym samym zadaniem.</li>
            </ul>

            <p><b>Warto wiedzieć</b></p>
            <ul style={{ marginTop: 4, paddingLeft: 18 }}>
              <li><b>uruchomiony ręcznie</b> — agent odpalony poza dashboardem (np. w terminalu
                VS Code). Taki nie jest osobnym oknem systemu, więc nie da się go podnieść;
                pokazujemy katalog roboczy, żebyś go rozpoznał.</li>
              <li>Dashboard <b>nie prowadzi rozmowy za Ciebie</b> — pytania agenta (np. bramki
                w składzie plan) odpowiadasz w jego oknie.</li>
              <li>Lista odświeża się co 10 sekund. Zakończone przebiegi są zwinięte, żeby nie
                zaśmiecać widoku.</li>
            </ul>
          </div>
        </details>

        {terminalError && (
          <div className="banner banner-warn" style={{ marginBottom: 10 }}>
            Błąd terminali: {terminalError}
          </div>
        )}

        {/* Live terminals */}
        {terminals.filter((t) => t.alive).length === 0 && (
          <div className="empty">Żaden agent nie działa.</div>
        )}
        {terminals
          .filter((t) => t.alive)
          .map((t) => (
            <div className="task-row" key={t.runId}>
              <div className="task-row-main">
                <span className="dot dot-ok" />
                <span className="run-card-squad">{t.squad || '—'}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                  {t.taskId || '—'}
                </span>
                <span className="muted">{elapsed(t.startedAt, null)}</span>
                <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtCost(t)}
                </span>
                {t.status && (
                  <span
                    className={
                      'badge ' +
                      (t.status === 'failed' ? 'badge-fail' : t.status === 'running' ? 'badge-run' : 'badge-ok')
                    }
                  >
                    {t.status}
                  </span>
                )}
              </div>
              <div className="task-row-foot">
                {t.launchedBy === 'dashboard' ? (
                  <>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 12 }}
                      onClick={() => handleFocus(t.runId)}
                    >
                      Pokaż okno
                    </button>
                    {focusError && focusError.runId === t.runId && (
                      <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                        {focusError.message}
                      </span>
                    )}
                  </>
                ) : (
                  <span
                    className="muted"
                    style={{ fontSize: 11 }}
                    title={t.cwd || ''}
                  >
                    uruchomiony ręcznie
                    {t.cwd ? ' · ' + (t.cwd.length > 30 ? '…' + t.cwd.slice(-28) : t.cwd) : ''}
                  </span>
                )}
                {stopConfirm === t.runId ? (
                  <>
                    <span style={{ fontSize: 12, color: 'var(--warn)', fontWeight: 600 }}>
                      Zatrzymać agenta?
                    </span>
                    <button
                      className="launch-btn"
                      style={{ background: 'var(--danger)', fontSize: 11, padding: '4px 10px' }}
                      onClick={() => handleStop(t.runId)}
                    >
                      Tak, zatrzymaj
                    </button>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => setStopConfirm(null)}
                    >
                      Anuluj
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 12 }}
                    onClick={() => setStopConfirm(t.runId)}
                  >
                    Zatrzymaj
                  </button>
                )}
              </div>
            </div>
          ))}

        {/* Recently finished */}
        {(() => {
          const finished = terminals.filter((t) => !t.alive).slice(0, 15);
          if (finished.length === 0) return null;
          return (
            <details
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '10px 14px',
                marginTop: 12,
                fontSize: 13,
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text-2)' }}>
                Ostatnio zakończone ({finished.length})
              </summary>
              <div style={{ marginTop: 8 }}>
                {finished.map((t) => (
                  <div
                    key={t.runId}
                    className="task-row"
                    style={{ marginBottom: 6, opacity: 0.75 }}
                  >
                    <div className="task-row-main">
                      <span className="dot" style={{ background: 'var(--faint)' }} />
                      <span className="run-card-squad">{t.squad || '—'}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {t.taskId || '—'}
                      </span>
                      <span className="muted">{elapsed(t.startedAt, t.endedAt)}</span>
                      <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtCost(t)}
                      </span>
                    </div>
                    <div className="task-row-foot">
                      {relaunchConfirm && relaunchConfirm.runId === t.runId ? (
                        <>
                          <span style={{ fontSize: 12, color: 'var(--warn)', fontWeight: 600 }}>
                            Uruchomić ponownie?
                          </span>
                          <button
                            className="launch-btn"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => handleRelaunch(t)}
                          >
                            Tak, uruchom
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => setRelaunchConfirm(null)}
                          >
                            Anuluj
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11 }}
                          onClick={() => setRelaunchConfirm(t)}
                        >
                          Uruchom ponownie z tym zadaniem
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          );
        })()}
      </div>

      {/* NEXT UP */}
      <div className="section">
        <div className="section-h">NEXT UP <span className="muted">(wg handoff-rules)</span></div>
        {queueError && <div className="empty">Linear unavailable: {queueError}</div>}
        {!queueError && nextUp.length === 0 && <div className="empty">No tasks ready to hand off.</div>}
        {nextUp.map((t) => (
          <NextUpRow key={t.id} task={t} onLaunch={setModalTask} taskCost={taskCosts[t.identifier]} />
        ))}
      </div>

      {/* CZEKA NA CIEBIE */}
      <div className="section">
        <div className="section-h">CZEKA NA CIEBIE <span className="muted">(needs:*)</span></div>
        {waiting.length === 0 && <div className="empty">Nothing blocked on you.</div>}
        {waiting.map((t) => (
          <WaitingRow key={t.id} task={t} taskCost={taskCosts[t.identifier]} />
        ))}
      </div>

      {/* W TOKU */}
      <div className="section">
        <div className="section-h">W TOKU <span className="muted">(agent pracuje — z Live)</span></div>
        {active.length === 0 && <div className="empty">No agents running.</div>}
        {active.map((r) => (
          <ActiveRow key={r.runId} run={r} />
        ))}
      </div>

      {/* HEALTH — stale runs, untagged cost, failed cost */}
      {hasHealthIssues && (
        <div className="section">
          <div className="section-h">⚠ Health</div>
          {staleRuns.length > 0 && (
            <div className="task-row" style={{ borderLeft: '3px solid var(--yellow, #d97706)' }}>
              <div className="task-row-main">
                <span className="badge badge-warn">stale</span>
                <span>{staleRuns.length} run{staleRuns.length === 1 ? '' : 's'} active &gt; 2h</span>
              </div>
              <div className="task-row-title">
                {staleRuns.map((r) => (
                  <span key={r.runId} style={{ marginRight: 12 }}>
                    <Link className="link" to={`/runs/${r.runId}`}>{r.squad} {r.taskId || '(untagged)'}</Link>
                    {' '}<span className="muted">{elapsed(r.startedAt, null)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {untaggedRuns.length > 0 && (
            <div className="task-row" style={{ borderLeft: '3px solid var(--yellow, #d97706)' }}>
              <div className="task-row-main">
                <span className="badge badge-warn">untagged</span>
                <span>{fmtUSD(untaggedCost)} in {untaggedRuns.length} run{untaggedRuns.length === 1 ? '' : 's'} without taskId</span>
              </div>
              <div className="task-row-title muted" style={{ fontSize: 12 }}>
                Runs started without a Linear task — cost is not attributed. Launch via Tasks screen to auto-tag.
              </div>
            </div>
          )}
          {failedRuns.length > 0 && (
            <div className="task-row" style={{ borderLeft: '3px solid var(--red, #dc2626)' }}>
              <div className="task-row-main">
                <span className="badge badge-fail">failed</span>
                <span>{fmtUSD(failedCost)} lost in {failedRuns.length} failed run{failedRuns.length === 1 ? '' : 's'}</span>
              </div>
              <div className="task-row-title">
                {failedRuns.map((r) => (
                  <span key={r.runId} style={{ marginRight: 12 }}>
                    <Link className="link" to={`/runs/${r.runId}`}>{r.squad} {r.taskId || '(untagged)'}</Link>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="muted" style={{ marginTop: 16 }}>
        updated {lastUpdated ? fmtTime(lastUpdated.toISOString()) : '—'}
      </div>

      {modalTask && (
        <LaunchModal task={modalTask} onClose={() => setModalTask(null)} onLaunched={onLaunched} />
      )}
      <Toast toast={toast} />
    </div>
  );
}
