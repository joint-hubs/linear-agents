// Task cockpit (task workspaces, PRD §3–5) — one task's own Supervisor
// session: chat, terminal, needs-you inbox and live children, every call
// scoped to that session's identity ({ sessionId, taskKey }). Rendered by
// screens/Cockpit.jsx when the route is /work/:taskKey/cockpit; the unscoped
// legacy overview stays at /cockpit.
//
// Identity comes from the route's taskKey resolved against GET
// /api/supervisor/sessions — never from a title or a native Claude session id
// (PRD §5). Explicit states: loading, no session yet (never auto-starts — a
// costly spawn must not happen just because someone opened the URL), session
// error, ambiguity. Switching tasks navigates to the other taskKey's URL; the
// Supervisor panel is keyed by sessionId so a switch remounts it — the
// conversation cursor, pending input and the terminal socket close with it.

import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getCockpit, getSupervisorSessions, postSupervisorStop, getSupervisorProfilePreview, postSupervisorResume } from '../../api';
import { usePoll } from '../../hooks/usePoll';
import { cockpitPrefill } from '../../cockpitModel';
import {
  cockpitUrl,
  resolveTaskSession,
  sessionChip,
  sessionTitle,
  switcherModelForPayload,
} from '../../taskCockpitModel';
import SupervisorPanel from './SupervisorPanel';
import ChatView from './ChatView';
import NeedsYouInbox from './NeedsYouInbox';
import LiveChildren from './LiveChildren';
import PanelBoundary from './PanelBoundary';

const COUNT_LABELS = [
  ['needsYou', 'needs you'],
  ['running', 'running'],
  ['stalled', 'stalled'],
  ['waitingGate', 'waiting on a gate'],
  ['unknown', 'unknown'],
];

const COUNT_TONE = {
  needsYou: 'waiting',
  running: 'running',
  stalled: 'danger',
  waitingGate: 'waiting',
  unknown: 'neutral',
};

// The Tasks switcher: every session (queued visible — AC-3), each linking to
// its own cockpit; the current one is marked, not linked. cap from the
// payload's maxActive (default 2 server-side) — shown, not enforced here
// (the coordinator owns the quota, PRD §6).
function TasksSwitcher({ model }) {
  if (model.items.length === 0) return null;
  return (
    <div className="ck-tasks" role="navigation" aria-label="Tasks">
      <span className="muted" style={{ fontSize: 11 }}>
        Tasks ({model.items.length}
        {model.cap != null ? ' · cap ' + model.cap : ''}):
      </span>
      {model.items.map((it) =>
        it.current ? (
          <span key={it.taskKey} className="ck-task-chip ck-task-chip-current" aria-current="page">
            <span className={`ck-chip ck-tone-${it.chip.tone}`}>{it.chip.label}</span>
            <code className="ck-mono-small">{it.taskKey}</code>
            {it.title && it.title !== it.taskKey && <span className="ck-task-title">{it.title}</span>}
          </span>
        ) : (
          <Link
            key={it.taskKey}
            to={cockpitUrl(it.taskKey)}
            className="ck-task-chip"
            title="Open this task's cockpit"
          >
            <span className={`ck-chip ck-tone-${it.chip.tone}`}>{it.chip.label}</span>
            <code className="ck-mono-small">{it.taskKey}</code>
            {it.title && it.title !== it.taskKey && <span className="ck-task-title">{it.title}</span>}
          </Link>
        ),
      )}
    </div>
  );
}

export default function TaskCockpit({ taskKey }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [resumePreview, setResumePreview] = useState(null);
  const [tab, setTab] = useState('chat');
  const [draft, setDraft] = useState('');
  const [stopBusy, setStopBusy] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [stopStatus, setStopStatus] = useState(null); // { kind, text }

  // The task's sessions (all of them — the switcher reads the same poll).
  const sessions = usePoll((signal) => getSupervisorSessions(signal), 5000, []);

  const { session, ambiguous, ready } = resolveTaskSession(sessions.data, taskKey, selectedSessionId);
  const historical = session && ['completed', 'stopped', 'failed'].includes(session.status);
  const history = (sessions.data?.sessions || []).filter(s => s.taskKey === taskKey);
  const scope = session ? { sessionId: session.sessionId, taskKey } : null;

  // The scoped snapshot — only once the session exists; re-armed per session
  // so a switch refetches from the new session's own snapshot.
  const snap = usePoll(
    (signal) => (scope ? getCockpit(signal, scope).then(data => ({ sessionId: scope.sessionId, data })) : Promise.resolve(null)),
    5000,
    [session ? session.sessionId : null],
  );

  // Start in Cockpit: a ?prompt= on the cockpit URL drafts into THIS task's
  // composer — never sent, the human still presses Send. Mount only.
  useEffect(() => {
    const prefill = cockpitPrefill(location.search);
    if (prefill) {
      setDraft(prefill);
      setTab('chat');
      navigate(cockpitUrl(taskKey), { replace: true });
    }
    // mount-only: the prefill is decided by the URL the screen mounted with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The route keys this component by taskKey, so task switches start with fresh state.

  const refreshAll = () => {
    sessions.refresh();
    snap.refresh();
  };

  const stopTask = async () => {
    if (!scope) return;
    const label = sessionTitle(session) || taskKey;
    // Scoped cancel (PRD §6) — deliberate, with the concrete task named;
    // history and run ids are kept, this stops the process only.
    if (!window.confirm('Stop the Supervisor session for ' + label + '? Its history and run IDs are kept.')) {
      return;
    }
    setStopBusy(true);
    setStopStatus(null);
    try {
      await postSupervisorStop(scope);
      setStopStatus({ kind: 'ok', text: 'Stop sent to ' + taskKey });
      refreshAll();
    } catch (e) {
      setStopStatus({ kind: 'err', text: e.data?.error || e.message || String(e) });
    } finally {
      setStopBusy(false);
    }
  };

  const resumeTask = async (confirm=false) => {
    setStopBusy(true);setStopStatus(null);
    try {
      if(!confirm){setResumePreview(await getSupervisorProfilePreview(scope));return;}
      await postSupervisorResume(scope,resumePreview.revision);setResumePreview(null);setDraft('');setSelectedSessionId(session.sessionId);refreshAll();
    }catch(error){setStopStatus({kind:'err',text:error.data?.error||error.message});setResumePreview(null);}finally{setStopBusy(false);}
  };
  const chip = sessionChip(session);
  const snapData = snap.data?.sessionId === session?.sessionId ? snap.data.data : null;
  const sup = snapData?.supervisor || null;
  const counts = snapData?.counts || {};

  return (
    <div className="cockpit">
      {/* Header: task + Supervisor identity + model health (PRD §4). */}
      <div className="ck-sup-head">
        <div className="section-h" style={{ marginBottom: 0 }}>Task cockpit</div>
        <code className="ck-mono">{taskKey}</code>
        {session && session.title !== taskKey && (
          <span style={{ fontSize: 12.5 }}>{session.title}</span>
        )}
        {session && (
          <>
            <span className={`ck-chip ck-tone-${chip.tone}`}>{chip.label}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              Supervisor <code className="ck-mono-small">{session.sessionId}</code>
            </span>
            {session.workspace && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                {session.workspace}
                {session.issueId ? ' · ' + session.issueId : ''}
              </span>
            )}
          </>
        )}
        {sup && sup.model && <span className="chip ck-mono-small">{sup.model}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={refreshAll}
        >
          Refresh
        </button>
        {session && !historical && (
          <button
            type="button"
            className="btn-secondary ck-stop-btn"
            style={{ fontSize: 11, padding: '3px 10px' }}
            disabled={stopBusy}
            onClick={stopTask}
            title="Stop this task's Supervisor session (history and run IDs are kept)"
          >
            {stopBusy ? 'Stopping…' : 'Stop ' + taskKey}
          </button>
        )}
      </div>

      {(stopStatus || sessions.error) && (
        <div
          className={
            (stopStatus ? stopStatus.kind : 'err') === 'ok' ? 'banner banner-ok' : 'banner banner-warn'
          }
          style={{ marginTop: 8 }}
        >
          {stopStatus
            ? stopStatus.text
            : 'Sessions unavailable: ' +
              (sessions.error.data?.error || sessions.error.message) +
              ' — retrying.'}
        </div>
      )}

      <TasksSwitcher model={switcherModelForPayload(sessions.data, taskKey)} />
      {history.length > 0 && <label className="ck-history">Session history{' '}
        <select aria-label="Session history" value={selectedSessionId || ''} onChange={e => { setSelectedSessionId(e.target.value || null); setDraft(''); setStopStatus(null); }}>
          <option value="">Current / latest</option>
          {history.map(s => <option key={s.sessionId} value={s.sessionId}>{s.createdAt} · {s.status} · {s.sessionId}</option>)}
        </select>
      </label>}
      {historical && <div className="banner">Historical session — read only. {session.status === 'stopped' && <button className="btn-secondary" disabled={stopBusy} onClick={()=>resumeTask()}>Resume this history</button>} Start from the board for a fresh conversation.</div>}
      {resumePreview && <div className="banner"><strong>Tools for the resumed process</strong><pre style={{whiteSpace:'pre-wrap'}}>{resumePreview.changes.length ? JSON.stringify(resumePreview.changes,null,2) : 'No tool profile changes.'}</pre><button className="btn" disabled={stopBusy} onClick={()=>resumeTask(true)}>Resume with these tools</button>{' '}<button className="btn-secondary" onClick={()=>setResumePreview(null)}>Cancel</button></div>}

      {/* Explicit states — never a silent blank and never an auto-start.
          `ready` (the sessions payload arrived) drives these, not the poll's
          loading flag — a background refetch must not flicker them away. */}
      {sessions.loading && !sessions.data && (
        <div className="muted" style={{ padding: '20px 0' }}>
          Loading task sessions…
        </div>
      )}

      {ready && ambiguous && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          More than one session claims {taskKey} — this should not happen. Nothing opened: pick a
          task from the board instead of guessing.
        </div>
      )}

      {ready && !ambiguous && !session && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          <div>
            This task has no Supervisor session yet — nothing was started by opening this page.
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Start it from the board: open the ticket detail and press Start.
          </div>
          <div style={{ marginTop: 8 }}>
            <Link className="link" to="/work">
              Back to the board
            </Link>
          </div>
        </div>
      )}

      {session && (
        <>
          {snap.loading && !snapData && (
            <div className="muted" style={{ padding: '12px 0' }}>Checking the session…</div>
          )}
          {snap.error && (
            <div className="banner banner-warn" style={{ marginTop: 10 }}>
              Cockpit snapshot unavailable: {snap.error.data?.error || snap.error.message}
            </div>
          )}

          <div className="ck-counts">
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className="ck-count">
                <span className={`ck-chip ck-tone-${COUNT_TONE[key]}`}>{counts[key] ?? 0}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>{label}</span>
              </div>
            ))}
          </div>

          {/* key={sessionId}: a switch remounts the panel — the conversation
              cursor, pending input and the terminal WebSocket close with the
              old session (no cross-task leaks). */}
          <div className="ck-grid">
            <PanelBoundary label="Supervisor">
              {historical ? <ChatView key={session.sessionId} scope={scope} supervisor={sup} readOnly draft="" onDraftChange={() => {}} /> : <SupervisorPanel
                key={session.sessionId}
                supervisor={sup}
                scope={scope}
                tab={tab}
                onTabChange={setTab}
                draft={draft}
                onDraftChange={setDraft}
                onRefresh={refreshAll}
              />}
            </PanelBoundary>
            <PanelBoundary label="Needs you">
              <NeedsYouInbox
                items={historical ? [] : (snapData?.needsYou || [])}
                scope={scope}
                onAskSupervisor={(text) => {
                  setDraft(text);
                  setTab('chat');
                }}
                onRefresh={refreshAll}
              />
            </PanelBoundary>
          </div>

          <PanelBoundary label="Live children">
            <LiveChildren items={snapData?.children || []} />
          </PanelBoundary>
        </>
      )}
    </div>
  );
}