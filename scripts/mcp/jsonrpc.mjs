// scripts/mcp/jsonrpc.mjs — the minimal MCP surface, hand-rolled on purpose.
//
// The repo is zero-dependency ESM (node: builtins only) and the decision
// servers need three methods, so @modelcontextprotocol/sdk would pull a
// dependency tree for a surface this small. MCP is JSON-RPC 2.0 over
// newline-delimited stdio with initialize / tools/list / tools/call — exactly
// what a decision server per ADR-0012 D5 needs, nothing more: the caller
// receives only the final typed JSON.
//
// The handler is exported programmatically on purpose: tests and the shadow
// run exercise the real message path without spawning a process. Only the
// stdio loop (serveStdio) touches process streams, and everything it logs
// goes to stderr — stdout is protocol, never log.

export const PROTOCOL_VERSION = "2025-06-18";

const JSONRPC_ERRORS = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
};

/**
 * Build the MCP message handler.
 *
 *   serverInfo — { name, version } reported from `initialize`
 *   tools      — [{ name, description, inputSchema }]
 *   callTool   — async (name, args) → decision envelope ({ok:...}); never
 *                throws. An ok:false envelope becomes a tools/call result
 *                with isError:true whose text IS the typed error — the
 *                fail-closed contract crosses the protocol boundary intact.
 */
export function createMcpHandler({ serverInfo, tools, callTool }) {
  async function handleMessage(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return error(null, JSONRPC_ERRORS.invalidRequest, "request must be a JSON-RPC 2.0 object");
    }
    const { jsonrpc, id, method, params } = request;
    if (jsonrpc !== "2.0") {
      return error(id, JSONRPC_ERRORS.invalidRequest, 'jsonrpc must be "2.0"');
    }
    if (typeof method !== "string") {
      return error(id, JSONRPC_ERRORS.invalidRequest, "method must be a string");
    }
    // A request without an id is a notification: never responded to.
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !tools.some((t) => t.name === name)) {
          if (isNotification) return null;
          return error(id, JSONRPC_ERRORS.invalidParams, `unknown tool: ${String(name ?? "(none)")}`);
        }
        const envelope = await callTool(name, params?.arguments ?? {});
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          isError: envelope.ok === false,
        });
      }
      default:
        if (isNotification) return null;
        return error(id, JSONRPC_ERRORS.methodNotFound, `unknown method: ${method}`);
    }
  }

  // One JSON document per line, one response line per request line. A
  // malformed line is a parse error with a null id — the stream stays usable.
  async function handleLine(line) {
    const text = line.trim();
    if (!text) return null;
    let request;
    try {
      request = JSON.parse(text);
    } catch (err) {
      const detail = err.message.length > 120 ? `${err.message.slice(0, 117)}...` : err.message;
      return serialize(error(null, JSONRPC_ERRORS.parse, detail));
    }
    const response = await handleMessage(request);
    return response ? serialize(response) : null;
  }

  return { handleMessage, handleLine };
}

/**
 * Newline-delimited stdio transport. Streams are injectable; production uses
 * process.stdin/stdout and exits when stdin closes.
 */
export async function serveStdio(handleLine, { input = process.stdin, output = process.stdout } = {}) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const response = await handleLine(line);
    if (response !== null && response !== undefined) output.write(`${response}\n`);
  }
}

function result(id, resultValue) {
  return { jsonrpc: "2.0", id, result: resultValue };
}

function error(id, definition, detail) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: definition.code, message: definition.message, ...(detail ? { data: detail } : {}) },
  };
}

function serialize(response) {
  return JSON.stringify(response);
}
