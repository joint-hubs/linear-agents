// Navigation areas (FOC-804 + task workspaces, PRD §3). One pure module holds
// the map; the left navigation and the sub-page tabs (components/AreaTabs.jsx)
// both read it. No React, no router imports — the plain-node tests
// (_tests_nav.mjs) pin the table and areaForPath outside Vite.
//
// The board is home (PRD §3: `/` → Board, `/work` alias): Work leads the nav.
// The old global Cockpit overview is no longer the primary screen — it keeps
// an explicit route at /cockpit and a nav item behind Work. Task cockpits live
// at /work/:taskKey/cockpit and light up the Work area.
//
// The v2 screens live here as they are rebuilt (Work board → FOC-784, Costs &
// quality → FOC-785, Settings → FOC-786); the remaining v1 screens stay
// reachable as an area's `pages` until rebuilt (Team → FOC-791, Insights →
// FOC-787). Timeline stays routable but out of the navigation (/tasks
// redirects to the board); Live (/live) and Fine-tune (/ft) are hidden too —
// routes not in `pages` map to no area in areaForPath, so nothing lights up
// for them.

export const NAV_AREAS = [
  {
    id: 'work',
    label: 'Work',
    defaultRoute: '/',
    icon: 'tasks',
    pages: [
      { path: '/work', label: 'Board' },
      { path: '/runs', label: 'Runs' },
    ],
  },
  {
    id: 'cockpit',
    label: 'Cockpit',
    defaultRoute: '/cockpit',
    icon: 'cockpit',
    pages: [{ path: '/cockpit', label: 'Overview' }],
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
    pages: [{ path: '/costs', label: 'Costs & quality' }],
  },
  {
    id: 'insights',
    label: 'Insights',
    defaultRoute: '/analysis',
    icon: 'analysis',
    pages: [
      { path: '/insights/runtime', label: 'Runtime statistics' },
      { path: '/insights/map', label: 'Task map' },
      { path: '/analysis', label: 'Analysis' },
      { path: '/flow', label: 'Flow' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    defaultRoute: '/settings/keys',
    icon: 'config',
    pages: [
      { path: '/settings/keys', label: 'Keys' },
      { path: '/settings/provider', label: 'Provider & routing' },
      { path: '/settings/repos', label: 'Repositories' },
      { path: '/settings/retention', label: 'Retention' },
      { path: '/squad-config', label: 'Advanced routing (v1)' },
      { path: '/prompts', label: 'Squads & prompts (v1)' },
    ],
  },
];

// Which nav item is highlighted for a location. An area owns its pages and
// everything below them (/work/:ticket, /work/:taskKey/cockpit and /runs/:id
// belong to Work); `/` — the board's home route, an alias of /work — belongs
// to Work too. An unknown path — or one kept out of the navigation like /live,
// /ft, /timeline (routable but unlisted) and /tasks (redirects to the board) —
// belongs to no area.
export function areaForPath(pathname) {
  const p = pathname == null ? '/' : pathname;
  if (p === '/') return 'work';
  for (const area of NAV_AREAS) {
    for (const page of area.pages) {
      if (p === page.path || p.startsWith(page.path + '/')) return area.id;
    }
  }
  return null;
}
