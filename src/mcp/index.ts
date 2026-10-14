/**
 * `src/mcp` — the MCP stdio client workstream (ADR-0011 P1, roadmap WS3).
 *
 * - `frame.ts`   buffered newline framing for the JSON-RPC stdio transport
 * - `env.ts`     ${VAR} expansion + the constructed child-env policy
 * - `client.ts`  per-server child: handshake, tools/list, tools/call,
 *                cancellation, timeouts, graceful shutdown
 * - `registry.ts` configured servers → ToolSpec entries (mcp__<server>__<tool>)
 * - `cli.ts`     the `void mcp list|doctor` subcommand handlers
 * - `exit.ts`    zombie-server prevention (signal-driven cleanup)
 */
export * from "./client";
export * from "./env";
export * from "./exit";
export * from "./frame";
export * from "./registry";
