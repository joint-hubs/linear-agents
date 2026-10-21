// scripts/mcp/server-fenix-control.mjs — the fenix-control MCP host (FOC-958).
//
// Stdio entry over the fenix-control tool table (fenix-control-tools.mjs):
// ten thin calls to the running telemetry server's own routes, so a local MCP
// client (Claude Code, Codex) can steer a running Fenix today — the remote
// HTTP transport is phase C. The tool table owns the behaviour; this file only
// wires stdio: stdout is protocol, every log line goes to stderr.

import { serveStdio } from "./jsonrpc.mjs";
import { createFenixControlServer, SERVER_INFO } from "./fenix-control-tools.mjs";

if (process.argv[1] && process.argv[1].endsWith("server-fenix-control.mjs")) {
  const server = createFenixControlServer();
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — API ${process.env.FENIX_CONTROL_API_URL ?? `http://127.0.0.1:${parseInt(process.env.TELEMETRY_PORT, 10) || 7331}`}, actor ${server.actor()}`);
  await serveStdio(server.handleLine);
}
