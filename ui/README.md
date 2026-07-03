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
