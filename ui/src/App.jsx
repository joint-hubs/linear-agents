import TaskMap from './screens/TaskMap.jsx';
import Statistics from './screens/Statistics.jsx';
import React from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import Cockpit from './screens/Cockpit.jsx';
import Manager from './screens/Manager.jsx';
import Team from './screens/Team.jsx';
import Live from './screens/Live.jsx';
import Timeline from './screens/Timeline.jsx';
import Runs from './screens/Runs.jsx';
import RunDetail from './screens/RunDetail.jsx';
import CostsQuality from './screens/CostsQuality.jsx';
import Analysis from './screens/Analysis.jsx';
import Work from './screens/Work.jsx';
import Flow from './screens/Flow.jsx';
import SquadConfig from './screens/SquadConfig.jsx';
import Prompts from './screens/Prompts.jsx';
import Settings from './screens/Settings.jsx';
import Ft from './screens/Ft.jsx';
import AreaTabs from './components/AreaTabs.jsx';
import { NAV_AREAS, areaForPath } from './navAreas';
import { getCockpit } from './api';
import { usePoll } from './hooks/usePoll';

// Minimal 17px stroke icons (no icon-lib dependency). One per nav area; the
// v1 sub-page tabs are text-only.
const I = {
  cockpit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12 15.5 8.5" />
      <path d="M12 3v3M21 12h-3M12 21v-3M3 12h3" />
    </svg>
  ),
  manager: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="8" height="7" rx="1.5" />
      <rect x="13" y="4" width="8" height="7" rx="1.5" />
      <rect x="8" y="14" width="8" height="7" rx="1.5" />
    </svg>
  ),
  costs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  analysis: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="7" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
      <path d="M7.5 12.5v-2M10.5 12.5v-4M13.5 12.5v-3" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 10l2 2 4-4" />
    </svg>
  ),
  config: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

// Needs-you count on the Cockpit nav item (spec §2). Lightweight poll every
// 15 s; an old server without /api/cockpit (404) or a down API must never
// break the navigation — the error is swallowed and the badge simply stays
// hidden until a poll succeeds.
function NeedsYouBadge() {
  const { data } = usePoll((signal) => getCockpit(signal), 15000, []);
  const n = data?.counts?.needsYou;
  if (!n) return null;
  return (
    <span
      style={{
        background: 'var(--warn, #b45309)',
        color: '#fff',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        padding: '0 6px',
        lineHeight: '16px',
        marginLeft: 'auto',
      }}
      aria-label={`${n} item${n === 1 ? '' : 's'} need you`}
    >
      {n}
    </span>
  );
}

// The six-area navigation (FOC-804 + task workspaces, PRD §3). Highlighting is
// driven by areaForPath(), not by the link's own route match — e.g. /runs/:id,
// /work/:ticket and the task cockpit /work/:taskKey/cockpit must light up Work
// even though the Work item links to /work. Live (/live) and Fine-tune (/ft)
// keep their routes but no longer appear here.
function Sidebar({ pathname }) {
  const active = areaForPath(pathname);
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">F</div>
        <div>
          <div className="brand-name">Fenix</div>
          <div className="brand-sub">agent observability</div>
        </div>
      </div>
      <nav className="nav">
        {NAV_AREAS.map((area) => (
          <Link
            key={area.id}
            to={area.defaultRoute}
            className={area.id === active ? 'nav-item nav-item-active' : 'nav-item'}
          >
            {I[area.icon]}
            <span>{area.label}</span>
            {area.id === 'cockpit' && <NeedsYouBadge />}
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="dot dot-ok" style={{ width: 7, height: 7 }} />
        <span>telemetry :7331</span>
      </div>
    </aside>
  );
}

// Router context (useLocation) needs a component below <BrowserRouter>, so the
// shell reads the pathname here and hands it to the sidebar; AreaTabs renders
// above the screen content for areas with more than one page (Work, Insights,
// Settings) — the v1 screens themselves stay untouched.
function EnvironmentBanner() {
  const { data } = usePoll(signal => fetch('/api/environment', {signal}).then(r=>r.ok?r.json():null), 60000, []);
  return data?.mode && data.mode !== 'live' ? <div role="status" style={{padding:'8px 14px',background:'var(--warn-bg, #4a361c)',borderRadius:6,marginBottom:12}}>Test environment · model execution may be simulated. Data and results are for acceptance testing.</div> : null;
}

function Shell() {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <Sidebar pathname={pathname} />
      <div className="main">
        <div className="page">
          <EnvironmentBanner />
          <AreaTabs pathname={pathname} />
          <Routes>
            {/* Board is home (task workspaces, PRD §3): / and /work alias to
                the same board. The legacy global Cockpit overview keeps an
                explicit route at /cockpit; a task's own cockpit lives at
                /work/:taskKey/cockpit — one active Supervisor per task, the
                header carries task + Supervisor identity. */}
            <Route path="/" element={<Work />} />
            <Route path="/work" element={<Work />} />
            <Route path="/work/:ticket" element={<Work />} />
            <Route path="/work/:taskKey/cockpit" element={<Cockpit />} />
            <Route path="/cockpit" element={<Cockpit />} />
            <Route path="/manager" element={<Manager />} />
            <Route path="/live" element={<Live />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/costs" element={<CostsQuality />} />
            <Route path="/insights/map" element={<TaskMap />} />
            <Route path="/insights/runtime" element={<Statistics />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/flow" element={<Flow />} />
            <Route path="/squad-config" element={<SquadConfig />} />
            <Route path="/prompts" element={<Prompts />} />
            {/* Settings (FOC-786): /settings lands on the keys section; the
                v1 SquadConfig / Prompts screens stay as sub-tabs. */}
            <Route path="/settings" element={<Navigate to="/settings/keys" replace />} />
            <Route path="/settings/:section" element={<Settings />} />
            <Route path="/ft" element={<Ft />} />
            {/* Area shortcuts (FOC-804): land on the area's default route.
                /work is a real route now (the board) — no shortcut needed. */}
            <Route path="/tasks" element={<Navigate to="/work" replace />} />
            <Route path="/team" element={<Team />} />
            <Route path="/insights" element={<Navigate to="/analysis" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
