# FOC-804 — dashboard v2 navigation: six areas, v1 screens parked under them

Date: 2026-10-12. Spec: `docs/ui/dashboard-v2-spec.md` §2 (areas) and §3 (v1 → v2 mapping). Order agreed with Mateusz:
this navigation first, then Work (FOC-784), then Settings (FOC-786) — configuration works in the terminal meanwhile.

## Navigation

| area | default route | v1 screens shown as its sub-pages until the area is rebuilt |
|---|---|---|
| Cockpit | `/` | — (v2, FOC-783) |
| Work | `/tasks` | Tickets (`/tasks`), Runs (`/runs`, `/runs/:id`), Timeline (`/timeline`) — FOC-784 |
| Team | `/manager` | Manager — FOC-791 |
| Costs & quality | `/costs` | v1 Costs with an "unreconciled" banner — FOC-785 |
| Insights | `/analysis` | Analysis, Flow — FOC-787 |
| Settings | `/squad-config` | Models & routing (`/squad-config`), Squads & prompts (`/prompts`) — FOC-786 |

Hidden from the navigation, routes kept: Live (`/live`, merged into the Cockpit) and Fine-tune (`/ft`, after 1.0).
One pure module (`ui/src/navAreas.js`) holds the map; the left navigation and the sub-page tabs read it, and
`areaForPath()` decides which area is active (`/runs/:id` belongs to Work). `/work`, `/team`, `/insights`, `/settings`
redirect to the area's default route.

## Starting a ticket in Docker

v1 Tasks → Start calls `POST /api/launch`, which opens a Windows console running `bin/<squad>.bat`. In a container (or
any non-Windows host) that cannot work. `GET /api/environment` → `{ inContainer, platform, launchSupported }`
(`launchSupported` = Windows and not in a container); `POST /api/launch` answers 501 `launch-unsupported` when it is
false (dry runs still work). Tasks then offers **Start in Cockpit**: it opens `/?prompt=Start ticket FOC-…: <title>` and
the Cockpit puts that text in the chat composer — the human still presses Send (the Supervisor never picks tickets on its
own).

## Docs

QUICKSTART gains "Fenix on a VM (GCP)"; ACCESS.md records `fenix-vm`.
