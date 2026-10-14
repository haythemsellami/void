#!/usr/bin/env node
/**
 * Scripted MCP stdio server fixture (ADR-0011) — a small, dependency-free
 * Node script speaking the protocol over stdin/stdout. The MCP unit and
 * composition tests spawn it as a REAL child (no network, no mocks of the
 * child boundary). Runtime-agnostic on purpose: it runs under plain Node
 * (vitest workers spawn process.execPath) and under Bun (`bun test`) using
 * only process.stdin/stdout and TextDecoder.
 *
 * Modes (first CLI argument):
 *   (none)                well-behaved server (full handshake + tools)
 *   --handshake-fail      answer `initialize` with a JSON-RPC error
 *   --hang                read everything, answer nothing (startup-timeout path)
 *   --garbage             print a non-JSON banner line first (stdout-noise path)
 *   --old-protocol        answer `initialize` with protocolVersion "2024-11-05"
 *   --paginated           serve tools/list in two pages via nextCursor
 *   --endless-pagination  always offer another cursor (pagination-cap path)
 *
 * Tools exposed (all modes but --hang/--handshake-fail):
 *   echo {message}        TWO text blocks (proves multi-block joining):
 *                         "echo: <message>" and the raw arguments JSON.
 *   fail {message?}       result with isError: true.
 *   slow {delayMs, msg?}  sleeps delayMs before replying (timeout path).
 *   env_report {}         one text block: sorted child process.env as JSON
 *                         (the env-denylist assertions read this).
 *   handshake_report {}   one text block: the initialize params we received
 *                         (clientInfo.name, requested protocolVersion).
 *   cancel_report {}      one text block: ids of requests cancelled so far.
 *   mixed {}              text block + image block (non-text placeholder path).
 *   die {}                exits the process with code 7 mid-session.
 *
 * Every server also writes one line to stderr at startup ("fixture-server
 * ready") so stderr capture has something real to tail.
 */
const mode = process.argv[2] ?? "";
if (process.stderr.writable) {
  process.stderr.write("fixture-server ready\n");
}

const PROTOCOL = "2025-06-18";
const cancelledIds = [];
let initializeParams = null;

const TOOLS = [
  {
    name: "echo",
    description: "Echo the message back across two text blocks.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "fail",
    description: "Always fails with isError set.",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
  {
    name: "slow",
    description: "Replies after delayMs milliseconds.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number" }, message: { type: "string" } },
    },
  },
  {
    name: "env_report",
    description: "Report the child environment as sorted JSON.",
    inputSchema: { type: "object" },
  },
  {
    name: "handshake_report",
    description: "Report the initialize params this server received.",
    inputSchema: { type: "object" },
  },
  {
    name: "cancel_report",
    description: "Report request ids the client cancelled.",
    inputSchema: { type: "object" },
  },
  {
    name: "mixed",
    description: "Text plus a non-text content block.",
    inputSchema: { type: "object" },
  },
  { name: "die", description: "Exit the server process.", inputSchema: { type: "object" } },
];

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(texts, extra = {}) {
  return { content: texts.map((text) => ({ type: "text", text })), ...extra };
}

function callTool(name, args) {
  switch (name) {
    case "echo":
      return textResult([`echo: ${String(args.message ?? "")}`, `args: ${JSON.stringify(args)}`]);
    case "fail":
      return textResult([`fixture failure${args.message ? `: ${args.message}` : ""}`], {
        isError: true,
      });
    case "slow":
      return new Promise((resolve) => {
        setTimeout(
          () => resolve(textResult([`slow done: ${String(args.message ?? "ok")}`])),
          args.delayMs ?? 0,
        );
      });
    case "env_report":
      return textResult([
        JSON.stringify(
          Object.fromEntries(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))),
        ),
      ]);
    case "handshake_report":
      return textResult([JSON.stringify(initializeParams)]);
    case "cancel_report":
      return textResult([JSON.stringify(cancelledIds)]);
    case "mixed":
      return {
        content: [
          { type: "text", text: "the text part" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      };
    case "die":
      process.exit(7);
      return textResult(["unreachable"]);
    default:
      return { error: { code: -32601, message: `unknown tool: ${name}` } };
  }
}

function handleMessage(message) {
  if (message.method === "initialize" && message.id !== undefined) {
    if (mode === "--handshake-fail") {
      replyError(message.id, -32000, "fixture refuses to initialize");
      return;
    }
    initializeParams = {
      protocolVersion: message.params?.protocolVersion,
      clientInfo: message.params?.clientInfo,
    };
    reply(message.id, {
      protocolVersion: mode === "--old-protocol" ? "2024-11-05" : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-server", version: "1.2.3" },
    });
    return;
  }
  if (message.method === "tools/list" && message.id !== undefined) {
    if (mode === "--paginated") {
      const cursor = message.params?.cursor;
      if (cursor === undefined) {
        reply(message.id, { tools: TOOLS.slice(0, 3), nextCursor: "page-2" });
      } else if (cursor === "page-2") {
        reply(message.id, { tools: TOOLS.slice(3), nextCursor: "page-3" });
      } else {
        reply(message.id, { tools: [] }); // page 3: empty terminator page
      }
      return;
    }
    if (mode === "--endless-pagination") {
      // A server whose catalog never ends: every page offers a fresh cursor.
      reply(message.id, { tools: [TOOLS[0]], nextCursor: `page-${Math.random()}` });
      return;
    }
    reply(message.id, { tools: TOOLS });
    return;
  }
  if (message.method === "tools/call" && message.id !== undefined) {
    const outcome = callTool(message.params?.name, message.params?.arguments ?? {});
    Promise.resolve(outcome).then((result) => {
      if (result?.error) {
        replyError(message.id, result.error.code, result.error.message);
      } else {
        reply(message.id, result);
      }
    });
    return;
  }
  if (message.method === "notifications/cancelled") {
    cancelledIds.push(message.params?.requestId ?? null);
    return; // notifications get no reply
  }
  if (message.method?.startsWith("notifications/")) {
    return;
  }
  if (message.id !== undefined) {
    replyError(message.id, -32601, `fixture does not implement ${String(message.method)}`);
  }
}

// Buffered line reader over stdin (mirrors the client-side frame parser).
const decoder = new TextDecoder();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let at = buffer.indexOf("\n");
  while (at !== -1) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (line.trim().length > 0 && mode !== "--hang") {
      try {
        const message = JSON.parse(line);
        if (message && typeof message === "object") {
          handleMessage(message);
        }
      } catch {
        /* not JSON: ignore, like any tolerant server */
      }
    }
    at = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0); // stdin closed = client went away
});

if (mode === "--garbage") {
  process.stdout.write("fixture-server banner: this line is NOT JSON\n");
}
