import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getLinearQueue, getRuns, postLaunch } from '../api';
import { linearUrl, WORKSPACES, DEFAULT_WORKSPACE } from '../config';
import { fmtTime, elapsed, taskLabel } from '../utils';

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
function NextUpRow({ task, onLaunch }) {
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
function WaitingRow({ task }) {
  const nl = needsLabel(task);
  return (
    <div className="task-row">
      <div className="task-row-main">
        <TaskChip id={task.identifier} />
        {nl && <span className="badge badge-warn">{nl}</span>}
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

  useEffect(() => {
    let alive = true;
    const tick = () => {
      // allSettled: a Linear outage must NOT take down the active-runs (W TOKU)
      // view — queue degrades to an error note, runs still render. Mirrors Live's
      // budget-is-non-fatal pattern (JOI-66→67).
      Promise.allSettled([getLinearQueue(workspace), getRuns()]).then(([qRes, rRes]) => {
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

      {/* NEXT UP */}
      <div className="section">
        <div className="section-h">NEXT UP <span className="muted">(wg handoff-rules)</span></div>
        {queueError && <div className="empty">Linear unavailable: {queueError}</div>}
        {!queueError && nextUp.length === 0 && <div className="empty">No tasks ready to hand off.</div>}
        {nextUp.map((t) => (
          <NextUpRow key={t.id} task={t} onLaunch={setModalTask} />
        ))}
      </div>

      {/* CZEKA NA CIEBIE */}
      <div className="section">
        <div className="section-h">CZEKA NA CIEBIE <span className="muted">(needs:*)</span></div>
        {waiting.length === 0 && <div className="empty">Nothing blocked on you.</div>}
        {waiting.map((t) => (
          <WaitingRow key={t.id} task={t} />
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
