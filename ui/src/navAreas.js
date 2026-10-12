// Navigation areas (FOC-804, dashboard-v2-spec §2/§3). One pure module holds
// the map; the left navigation and the sub-page tabs (components/AreaTabs.jsx)
// both read it. No React, no router imports — the plain-node tests
// (_tests_nav.mjs) pin the table and areaForPath outside Vite.
//
// The v1 screens stay reachable as an area's `pages` until the area is rebuilt
// (Work → FOC-784, Team → FOC-791, Costs & quality → FOC-785, Insights →
// FOC-787, Settings → FOC-786). Live (/live) and Fine-tune (/ft) are hidden
// from the navigation but their routes keep working — areaForPath maps them
// to null so no area lights up.

export const NAV_AREAS = [
  { id: 'cockpit', label: 'Cockpit', defaultRoute: '/', icon: 'cockpit', pages: [] },
  {
    id: 'work',
    label: 'Work',
    defaultRoute: '/tasks',
    icon: 'tasks',
    pages: [
      { path: '/tasks', label: 'Tickets' },
      { path: '/runs', label: 'Runs' },
      { path: '/timeline', label: 'Timeline' },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    defaultRoute: '/manager',
    icon: 'manager',
    pages: [{ path: '/manager', label: 'Manager (v1)' }],
  },
  {
    id: 'costs',
    label: 'Costs & quality',
    defaultRoute: '/costs',
    icon: 'costs',
    pages: [{ path: '/costs', label: 'Costs (v1)' }],
  },
  {
    id: 'insights',
    label: 'Insights',
    defaultRoute: '/analysis',
    icon: 'analysis',
    pages: [
      { path: '/analysis', label: 'Analysis' },
      { path: '/flow', label: 'Flow' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    defaultRoute: '/squad-config',
    icon: 'config',
    pages: [
      { path: '/squad-config', label: 'Models & routing' },
      { path: '/prompts', label: 'Squads & prompts' },
    ],
  },
];

// Which nav item is highlighted for a location. An area owns its pages and
// everything below them (/runs/:id belongs to Work); an unknown path — or one
// kept out of the navigation like /live and /ft — belongs to no area.
export function areaForPath(pathname) {
  const p = pathname == null ? '/' : pathname;
  if (p === '/') return 'cockpit';
  for (const area of NAV_AREAS) {
    for (const page of area.pages) {
      if (p === page.path || p.startsWith(page.path + '/')) return area.id;
    }
  }
  return null;
}
