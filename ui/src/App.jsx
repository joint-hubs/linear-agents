import React from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Live from './screens/Live.jsx';
import Timeline from './screens/Timeline.jsx';
import Runs from './screens/Runs.jsx';
import RunDetail from './screens/RunDetail.jsx';
import Costs from './screens/Costs.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="topnav">
          <span className="topnav-brand">LA Observability</span>
          <div className="topnav-tabs">
            <NavLink to="/" end className={({ isActive }) => isActive ? 'tab tab-active' : 'tab'}>
              Live
            </NavLink>
            <NavLink to="/timeline" className={({ isActive }) => isActive ? 'tab tab-active' : 'tab'}>
              Timeline
            </NavLink>
            <NavLink to="/runs" className={({ isActive }) => isActive ? 'tab tab-active' : 'tab'}>
              Runs
            </NavLink>
            <NavLink to="/costs" className={({ isActive }) => isActive ? 'tab tab-active' : 'tab'}>
              Costs
            </NavLink>
          </div>
        </nav>
        <div className="page">
          <Routes>
            <Route path="/" element={<Live />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
