/**
 * `src/mcp/registry` — bridge from configured MCP servers to Void's tool
 * registry (ADR-0011 P1).
 *
 * `connectMcpServers` takes the effective settings' `mcpServers` record,
 * connects every server (parallel, one structured failure never fails the
 * run) and returns a manager whose `specs()` yields ToolSpec entries for the
 * model registry:
 *
 * - Connected servers contribute one spec per discovered tool, named
 *   `mcp__<server>__<tool>` — the naming the permission defaults and docs
 *   already assume. Every call goes through the SAME permission gate as the
 *   builtins (the runner wraps these specs identically) and through the
 *   per-call 30s timeout + AbortSignal cancellation of the client.
 * - A server that fails to start/handshake surfaces as ONE tool
 *   `mcp__<server>__unavailable` whose call returns a structured error
 *   naming the server and pointing at `void mcp doctor`, so the MODEL can
 *   see and react to the degradation instead of the tool silently missing.
 *
 * Config comes from ADR-0006 effective settings (per-name workspace-over-user
 * merge done by the loader); only servers present there are connected.
 */
import type { JsonObject, ToolResult, ToolSpec } from "../contracts";
import type { McpServerConfig } from "../settings/schema";
import { McpServerError, McpStdioServer, type McpToolInfo } from "./client";

/** The registered name for a server tool: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Connection outcome of one configured server (for `void mcp list`/`doctor`). */
export interface McpServerStatus {
  readonly server: string;
  readonly command: string;
  readonly status: "connected" | "failed";
  /** Registered tool names (mcp__<server>__<tool>); empty when failed. */
  readonly tools: readonly string[];
  /** Why the server failed (status "failed" only). */
  readonly error?: string;
  /** Bounded stderr + noise summary (status "failed" only, when available). */
  readonly diagnostics?: string;
  /** Loud non-fatal notes from a CONNECTED server (e.g. catalog truncation). */
  readonly warnings?: readonly string[];
  readonly protocolVersion?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

/** Options for {@link connectMcpServers}. */
export interface McpManagerOptions {
  /** CLI environment (expansion source + minimal base); injected, never process.env. */
  readonly cliEnv: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly startupTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Info-line sink (stderr in the CLI): one line per failed server. */
  readonly log?: (line: string) => void;
}

/** Everything a run needs from the connected MCP fleet. */
export interface McpManager {
  readonly statuses: readonly McpServerStatus[];
  /** ToolSpec entries to append to the builtin registry. */
  specs(): readonly ToolSpec[];
  /** Graceful shutdown of every child; always safe to call. */
  shutdown(): Promise<void>;
}

/** Fallback schema when a server's tool omits (or malforms) its inputSchema. */
const OBJECT_SCHEMA: JsonObject = { type: "object" };

/** Cap one text block at the context's total-output budget (explicit marker). */
function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxBytes)}\n…[truncated: MCP result exceeded ${maxBytes} bytes]`,
    truncated: true,
  };
}

/** One ToolSpec wrapping a discovered server tool. */
function serverToolSpec(server: McpStdioServer, serverName: string, tool: McpToolInfo): ToolSpec {
  const schema = tool.inputSchema;
  return {
    name: mcpToolName(serverName, tool.name),
    description:
      tool.description ??
      `MCP tool "${tool.name}" provided by the configured server "${serverName}".`,
    inputSchema: schema !== undefined && schema.type === "object" ? schema : OBJECT_SCHEMA,
    source: "mcp",
    execute: async (input, ctx): Promise<ToolResult> => {
      const result = await server.callTool(tool.name, input, ctx.signal);
      if (result.content.length === 1 && result.content[0]?.type === "text") {
        const capped = capText(result.content[0].text, ctx.outputLimits.maxTotalChars);
        if (capped.truncated) {
          return {
            ...result,
            content: [{ type: "text", text: capped.text, truncated: true }],
          };
        }
      }
      return result;
    },
  };
}

/** The degradation tool for a server that never handshook (ADR-0011). */
function unavailableServerSpec(serverName: string, error: string): ToolSpec {
  const message =
    `MCP server "${serverName}" is unavailable: ${error} ` +
    "Its tools could not be discovered; run `void mcp doctor` for handshake diagnostics.";
  return {
    name: mcpToolName(serverName, "unavailable"),
    description: `Placeholder for MCP server "${serverName}", which failed to start. Calling it returns diagnostics.`,
    inputSchema: OBJECT_SCHEMA,
    source: "mcp",
    execute: async (): Promise<ToolResult> => ({
      content: [{ type: "text", text: message }],
      isError: true,
      error: {
        code: "execution_failed",
        message,
        retryable: false,
        details: { server: serverName, hint: "void mcp doctor" },
      },
    }),
  };
}

/**
 * Connect every configured server in parallel. NEVER throws: a failed server
 * becomes a status + an `mcp__<name>__unavailable` tool, and one info line
 * on the log sink; a bad `${VAR}` reference fails exactly its own server.
 */
export async function connectMcpServers(
  configs: Readonly<Record<string, McpServerConfig>>,
  options: McpManagerOptions,
): Promise<McpManager> {
  const names = Object.keys(configs).sort();
  const servers: { name: string; server?: McpStdioServer; status: McpServerStatus }[] =
    await Promise.all(
      names.map(
        async (
          name,
        ): Promise<{ name: string; server?: McpStdioServer; status: McpServerStatus }> => {
          const config = configs[name];
          if (config === undefined) {
            // Unreachable (names come from the record); kept for noUncheckedIndexedAccess.
            throw new Error(`mcp: missing config for ${name}`);
          }
          try {
            const server = await McpStdioServer.connect({
              name,
              command: config.command,
              ...(config.args !== undefined ? { args: config.args } : {}),
              ...(config.env !== undefined ? { env: config.env } : {}),
              cliEnv: options.cliEnv,
              ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
              ...(options.startupTimeoutMs !== undefined
                ? { startupTimeoutMs: options.startupTimeoutMs }
                : {}),
              ...(options.callTimeoutMs !== undefined
                ? { callTimeoutMs: options.callTimeoutMs }
                : {}),
            });
            const status: McpServerStatus = {
              server: name,
              command: config.command,
              status: "connected",
              tools: server.tools.map((tool) => mcpToolName(name, tool.name)),
              ...(server.serverInfo.protocolVersion !== undefined
                ? { protocolVersion: server.serverInfo.protocolVersion }
                : {}),
              ...(server.serverInfo.name !== undefined
                ? { serverName: server.serverInfo.name }
                : {}),
              ...(server.serverInfo.version !== undefined
                ? { serverVersion: server.serverInfo.version }
                : {}),
              ...(server.warnings.length > 0 ? { warnings: [...server.warnings] } : {}),
            };
            // Loud, non-fatal notes also reach stderr immediately — a
            // truncated catalog must never hide in a status object.
            for (const warning of server.warnings) {
              options.log?.(`void: mcp server "${name}": ${warning}`);
            }
            return { name, server, status };
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            options.log?.(`void: mcp server "${name}" unavailable: ${message}`);
            const diagnostics =
              cause instanceof McpServerError && cause.diagnostics !== undefined
                ? cause.diagnostics
                : undefined;
            return {
              name,
              status: {
                server: name,
                command: config.command,
                status: "failed",
                tools: [mcpToolName(name, "unavailable")],
                error: message,
                ...(diagnostics !== undefined ? { diagnostics } : {}),
              },
            };
          }
        },
      ),
    );

  return {
    statuses: servers.map((entry) => entry.status),
    specs: (): ToolSpec[] => {
      const specs: ToolSpec[] = [];
      for (const entry of servers) {
        if (entry.server !== undefined) {
          for (const tool of entry.server.tools) {
            specs.push(serverToolSpec(entry.server, entry.name, tool));
          }
        } else {
          specs.push(unavailableServerSpec(entry.name, entry.status.error ?? "unknown failure"));
        }
      }
      return specs;
    },
    shutdown: async (): Promise<void> => {
      await Promise.allSettled(
        servers.flatMap((entry) => (entry.server !== undefined ? [entry.server.shutdown()] : [])),
      );
    },
  };
}
