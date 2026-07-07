import React from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Live from './screens/Live.jsx';
import Timeline from './screens/Timeline.jsx';
import Runs from './screens/Runs.jsx';
import RunDetail from './screens/RunDetail.jsx';
import Costs from './screens/Costs.jsx';
import Tasks from './screens/Tasks.jsx';
import Flow from './screens/Flow.jsx';

// Minimal 17px stroke icons (no icon-lib dependency).
const I = {
  live: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  timeline: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="16" y2="18" />
    </svg>
  ),
  runs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18M3 12h18M3 19h18" />
      <circle cx="3" cy="5" r="0.5" />
    </svg>
  ),
  costs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 10l2 2 4-4" />
    </svg>
  ),
  flow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7 7.5 10.5 16M17 7.5 13.5 16" />
    </svg>
  ),
};

function NavItem({ to, end, icon, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => (isActive ? 'nav-item nav-item-active' : 'nav-item')}
    >
      {icon}
      <span>{children}</span>
    </NavLink>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">F</div>
            <div>
              <div className="brand-name">Fenix</div>
              <div className="brand-sub">agent observability</div>
            </div>
          </div>
          <nav className="nav">
            <NavItem to="/" end icon={I.live}>Live</NavItem>
            <NavItem to="/timeline" icon={I.timeline}>Timeline</NavItem>
            <NavItem to="/runs" icon={I.runs}>Runs</NavItem>
            <NavItem to="/costs" icon={I.costs}>Costs</NavItem>
            <NavItem to="/tasks" icon={I.tasks}>Tasks</NavItem>
            <NavItem to="/flow" icon={I.flow}>Flow</NavItem>
          </nav>
          <div className="sidebar-foot">
            <span className="dot dot-ok" style={{ width: 7, height: 7 }} />
            <span>telemetry :7331</span>
          </div>
        </aside>
        <div className="main">
          <div className="page">
            <Routes>
              <Route path="/" element={<Live />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/costs" element={<Costs />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/flow" element={<Flow />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </BrowserRouter>
  );
}
