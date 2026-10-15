// Cockpit screen — two bodies, one route entry (task workspaces, PRD §3):
// - /work/:taskKey/cockpit → the task cockpit (components/cockpit/TaskCockpit):
//   one task's own Supervisor session, scoped end to end.
// - /cockpit (and nothing else now) → the legacy global overview below: what
//   needs me, what is running, the single global Supervisor. The board is home
//   since P1; this screen is reachable explicitly, never by accident.

import { useState, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import './cockpit.css';
import { getCockpit } from '../api';
import { usePoll } from '../hooks/usePoll';
import { cockpitPrefill } from '../cockpitModel';
import SupervisorPanel from '../components/cockpit/SupervisorPanel';
import NeedsYouInbox from '../components/cockpit/NeedsYouInbox';
import LiveChildren from '../components/cockpit/LiveChildren';
import PanelBoundary from '../components/cockpit/PanelBoundary';
import TaskCockpit from '../components/cockpit/TaskCockpit';

const COUNT_LABELS = [
  ['needsYou', 'needs you'],
  ['running', 'running'],
  ['stalled', 'stalled'],
  ['waitingGate', 'waiting on a gate'],
  ['unknown', 'unknown'],
];

// Counts that deserve attention get a tone; running is informational.
const COUNT_TONE = {
  needsYou: 'waiting',
  running: 'running',
  stalled: 'danger',
  waitingGate: 'waiting',
  unknown: 'neutral',
};

export default function Cockpit() {
  const { taskKey } = useParams();
  if (taskKey) return <TaskCockpit key={taskKey} taskKey={taskKey} />;
  return <CockpitOverview />;
}

// The legacy global overview (FOC-783, dashboard-v2-spec §4.1) — what needs
// me, what is running, what the (single, global) Supervisor is doing. Polls
// /api/cockpit every 5 s (usePoll pauses while the tab is hidden); the five
// counts lead the page, the Supervisor panel and the needs-you inbox sit side
// by side on desktop, and the live children table closes the page.
function CockpitOverview() {
  const { data, error, loading, refresh } = usePoll((signal) => getCockpit(signal), 5000, []);
  const [tab, setTab] = useState('chat');
  const [draft, setDraft] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  // Start in Cockpit (FOC-804): the legacy hand-off lands here with
  // /cockpit?prompt=… . Once on mount the text goes into the same composer
  // draft the quick prompts fill, the Chat tab opens, and the parameter
  // leaves the URL — the message is NEVER sent automatically; the human
  // still presses Send. (Task hand-offs land on the task cockpit instead.)
  useEffect(() => {
    const prefill = cockpitPrefill(location.search);
    if (prefill) {
      setDraft(prefill);
      setTab('chat');
      navigate('/cockpit', { replace: true });
    }
    // mount-only: the prefill is decided by the URL the screen mounted with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = data?.counts || {};
  const supervisor = data?.supervisor || null;

  const askSupervisor = (text) => {
    setDraft(text);
    setTab('chat');
  };

  return (
    <div className="cockpit">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div className="section-h" style={{ marginBottom: 2 }}>Cockpit</div>
        <span className="muted" style={{ fontSize: 12 }}>
          {data?.checkedAt ? 'checked ' + new Date(data.checkedAt).toLocaleTimeString() : loading ? 'checking…' : '—'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          Cockpit unavailable: {error.data?.error || error.message}
          {error.status === 404 ? ' (an older server without /api/cockpit — Live (v1) still works)' : ''}
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

      {/* Each panel in its own boundary — one bad item shape blanks a panel,
          never the whole Cockpit (PanelBoundary). */}
      <div className="ck-grid">
        <PanelBoundary label="Supervisor">
          <SupervisorPanel
            supervisor={supervisor}
            tab={tab}
            onTabChange={setTab}
            draft={draft}
            onDraftChange={setDraft}
            onRefresh={refresh}
          />
        </PanelBoundary>
        <PanelBoundary label="Needs you">
          <NeedsYouInbox items={data?.needsYou || []} onAskSupervisor={askSupervisor} onRefresh={refresh} />
        </PanelBoundary>
      </div>

      <PanelBoundary label="Live children">
        <LiveChildren items={data?.children || []} />
      </PanelBoundary>
    </div>
  );
}
