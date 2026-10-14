#!/usr/bin/env node
/**
 * examples/mcp-server-config/server.mjs — a trivial, dependency-free MCP
 * stdio server for trying Void's MCP support (ADR-0011) offline.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout (stderr is free
 * for log lines — `void mcp doctor` tails it). It implements the exact
 * handshake Void drives:
 *
 *   initialize -> {protocolVersion, capabilities, serverInfo}
 *   notifications/initialized            (notification: no reply)
 *   tools/list  -> {tools: [...]}
 *   tools/call  -> {content: [{type: "text", text}]}
 *
 * Tools:
 *   hello {name?}  greet the caller (or the world)
 *   add  {a, b}    add two numbers
 *
 * Run standalone for a smoke test:
 *   printf '%s\n' \
 *     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 *     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 *     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 *     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hello","arguments":{"name":"Void"}}}' \
 *   | node server.mjs
 *
 * Tested by examples/examples.test.ts, which connects the REAL Void client
 * (src/mcp/client.ts) to this script — no network anywhere.
 */

const PROTOCOL_VERSION = "2025-06-18"; // what Void requests (src/mcp/client.ts)

const TOOLS = [
  {
    name: "hello",
    description: "Greet someone (default: the world).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Who to greet." } },
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
];

function rpcResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function rpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function callTool(name, args) {
  if (name === "hello") {
    const who = typeof args?.name === "string" && args.name !== "" ? args.name : "world";
    return { content: [{ type: "text", text: `hello, ${who}!` }] };
  }
  if (name === "add") {
    const a = Number(args?.a);
    const b = Number(args?.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { isError: true, content: [{ type: "text", text: "add needs numeric a and b" }] };
    }
    return { content: [{ type: "text", text: String(a + b) }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${String(name)}` }] };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\n");
  while (at !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line !== "") handleMessage(line);
    at = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`example-server: ignoring non-JSON line\n`);
    return;
  }
  // Notifications (no id) are acknowledged by silence per JSON-RPC 2.0.
  if (msg.id === undefined || msg.id === null) return;

  try {
    switch (msg.method) {
      case "initialize":
        rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "void-example-server", version: "1.0.0" },
        });
        break;
      case "tools/list":
        rpcResult(msg.id, { tools: TOOLS });
        break;
      case "tools/call":
        rpcResult(msg.id, callTool(msg.params?.name, msg.params?.arguments));
        break;
      default:
        rpcError(msg.id, -32601, `method not found: ${String(msg.method)}`);
    }
  } catch (err) {
    rpcError(msg.id, -32603, `internal error: ${String(err)}`);
  }
}

process.stderr.write("example-server ready\n");
