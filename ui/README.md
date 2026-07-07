# LA Observability

Vite + React dashboard for Linear Agents telemetry.

## Run

**Terminal 1** — start the telemetry server:

```
node scripts/telemetry-server.mjs
```

**Terminal 2** — start the dev server:

```
cd ui
npm install
npm run dev
```

Open http://localhost:5173.

The `/api` path is proxied to `http://localhost:7331` in dev mode. Override the API base URL by setting the `VITE_API_BASE` environment variable.

## Flow screen

`/flow` renders the Fenix pipeline (PLAN → DEV → REVIEW → TEST + CADENCE) as an
interactive diagram. Every node is a subagent role (mirrors
`docs/diagrams/00_overview.puml`); node badges show executions × cost × dominant
model. Clicking a node lists its executions across all runs; each execution
expands into a full log of model responses (text + tool calls) pulled from the
session transcript via `GET /api/flow` and `GET /api/flow/log?runId=…&agent=…`.
