// Area sub-page tabs (FOC-804) — above the screen content for areas with more
// than one page (Work, Insights, Settings), the v1 screens shown as the area's
// sub-pages until the area is rebuilt (spec §3). Rendered from the App layout,
// never from inside a screen. Pure navAreas.js drives the map and the active
// page; an unknown pathname renders nothing.

import { Link } from 'react-router-dom';
import { NAV_AREAS, areaForPath } from '../navAreas';

export default function AreaTabs({ pathname }) {
  const area = NAV_AREAS.find((a) => a.id === areaForPath(pathname));
  if (!area || area.pages.length < 2) return null;
  return (
    <div className="area-tabs" role="tablist" aria-label={`${area.label} pages`}>
      {area.pages.map((page) => {
        const active = pathname === page.path || pathname.startsWith(page.path + '/');
        return (
          <Link
            key={page.path}
            to={page.path}
            className={active ? 'area-tab area-tab-active' : 'area-tab'}
            aria-current={active ? 'page' : undefined}
          >
            {page.label}
          </Link>
        );
      })}
    </div>
  );
}
