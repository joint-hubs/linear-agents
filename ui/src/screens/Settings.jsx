// Settings (FOC-786, dashboard-v2-spec §4.6) — /settings/:section with the
// sections keys, provider (provider + the lead-model routing table), repos and
// retention. Each section renders inside its own PanelBoundary — a render
// error costs the section, not the page. The v1 SquadConfig (/squad-config)
// and Prompts (/prompts) screens stay as the area's "Advanced routing" and
// "Squads & prompts" tabs; an unknown section falls back to Keys.

import { useParams, Navigate } from 'react-router-dom';
import './settings.css';
import PanelBoundary from '../components/cockpit/PanelBoundary';
import KeysPanel from '../components/settings/KeysPanel';
import ProviderPanel from '../components/settings/ProviderPanel';
import RoutingPanel from '../components/settings/RoutingPanel';
import ReposPanel from '../components/settings/ReposPanel';
import RetentionPanel from '../components/settings/RetentionPanel';

const SECTIONS = {
  keys: { label: 'Keys', panels: [KeysPanel] },
  provider: { label: 'Provider & routing', panels: [ProviderPanel, RoutingPanel] },
  repos: { label: 'Repositories', panels: [ReposPanel] },
  retention: { label: 'Retention', panels: [RetentionPanel] },
};

export default function Settings() {
  const { section } = useParams();
  const def = SECTIONS[section];
  if (!def) return <Navigate to="/settings/keys" replace />;
  return (
    <div className="settings">
      <div className="section-h">Settings · {def.label}</div>
      {def.panels.map((Panel, i) => (
        <PanelBoundary key={i} label={`Settings — ${def.label}`}>
          <Panel />
        </PanelBoundary>
      ))}
    </div>
  );
}
