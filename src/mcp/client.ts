/**
 * `src/mcp/client` — hand-rolled MCP stdio client (ADR-0011 P1).
 *
 * One instance owns one server child for its whole lifetime: spawn via
 * `node:child_process` (the runtime-agnostic precedent of src/sandbox/run.ts
 * — no Bun.* globals, works under both the Bun-built binary and plain-Node
 * test workers), newline-delimited JSON-RPC 2.0 over the child's stdin/stdout
 * (framed by the buffered parser in ./frame), stderr captured into a bounded
 * diagnostics tail for `void mcp doctor`.
 *
 * Lifecycle: `connect()` spawns and drives the handshake — `initialize`
 * (protocolVersion negotiation; clientInfo {name:"void"}) →
 * `notifications/initialized` → `tools/list` — under ONE startup deadline
 * (default 10s). `callTool()` sends `tools/call` under a per-call deadline
 * (default 30s) and honors AbortSignal by emitting `notifications/cancelled`
 * to the server. `shutdown()` closes stdin, then SIGTERM, then SIGKILL after
 * a grace period — idempotent, safe at process exit.
 *
 * SANDBOX NOTE (ADR-0011): MCP servers run UNSANDBOXED by design. They are
 * user-configured infrastructure — long-lived helpers the user deliberately
 * installs, like the Void CLI itself — not model-authored commands, so the
 * OS sandbox that governs `bash` does not apply. The trust boundary for MCP
 * is configuration review + the permission gate on every TOOL CALL
 * (mcp__<server>__<tool> rules), plus the constructed child environment
 * (./env): a server sees only PATH/HOME/TMPDIR plus exactly what the user
 * configured for it — never the CLI's credentials.
 *
 * Robustness rules the protocol subset relies on:
 *
 * - Responses may arrive in any order; requests are matched by id.
 * - Server-initiated REQUESTS (sampling, roots — unsupported at P1) get a
 *   JSON-RPC -32601 reply instead of silence: a request MUST be answered.
 * - Server notifications are counted, not acted on (`tools/list_changed`
 *   re-fetch is P2 lifecycle work).
 * - stdout lines that are not JSON objects count as noise and are ignored —
 *   a server printing a startup banner to stdout must not kill the session.
 * - Child exit settles every pending call with a structured error and marks
 *   the server closed; later calls fail fast without touching a dead pipe.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { JsonObject, ToolErrorCode, ToolResult } from "../contracts";
import { VERSION } from "../version";
import { buildChildEnv, type ExpandedServerConfig, expandServerConfig } from "./env";
import { createLineFrameParser } from "./frame";

/** Protocol revision we ask for; the server's answer is recorded verbatim. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** One overall deadline for spawn + initialize + tools/list (ADR-0011: 10s). */
export const MCP_STARTUP_TIMEOUT_MS = 10_000;
/** Per tools/call deadline (ADR-0011: 30s). */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Grace between SIGTERM and SIGKILL at shutdown (mirrors sandbox/run.ts). */
export const MCP_SHUTDOWN_GRACE_MS = 3_000;
/**
 * `tools/list` pagination cap: we follow `nextCursor` pages up to this many
 * requests. A catalog still offering a cursor at the cap is NOT silently
 * truncated — a loud warning is recorded (surfaced on stderr, in
 * `void mcp list`/`doctor`, and on the manager status).
 */
export const MAX_TOOLS_LIST_PAGES = 20;
/** Bounded stderr retained for diagnostics (`void mcp doctor`). */
const STDERR_TAIL_LIMIT = 8_000;

/** A tool as reported by `tools/list`. */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject;
}

/** What `initialize` told us about the server. */
export interface McpServerInfo {
  readonly protocolVersion?: string;
  readonly name?: string;
  readonly version?: string;
}

/** Options for {@link McpStdioServer.connect}. */
export interface McpConnectOptions {
  /** Settings-level server name (naming, diagnostics, error messages). */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** CLI environment: ${VAR} expansion source + minimal base. Injected, never process.env. */
  readonly cliEnv: Readonly<Record<string, string | undefined>>;
  readonly startupTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Working directory for the child; defaults to the parent's. */
  readonly cwd?: string;
  /** Client identity sent in `initialize`; default {name:"void", version:"0.1.0"}. */
  readonly clientInfo?: Readonly<{ readonly name: string; readonly version: string }>;
}

/**
 * Client identity default. Keep the version in sync with package.json and
 * the CLI VERSION constant (single source would import from src/cli.ts,
 * which imports this module — the constant duplication is the lesser evil).
 */
export const DEFAULT_MCP_CLIENT_INFO: Readonly<{
  readonly name: string;
  readonly version: string;
}> = { name: "void", version: VERSION };

/** Structured failure of a server interaction (mapped to ToolError at the edges). */
export class McpServerError extends Error {
  /** Bounded stderr/noise snapshot at failure time (for `void mcp doctor`). */
  readonly diagnostics?: string;

  constructor(
    message: string,
    readonly code: ToolErrorCode,
    readonly retryable: boolean,
    diagnostics?: string,
  ) {
    super(message);
    this.name = "McpServerError";
    if (diagnostics !== undefined) {
      this.diagnostics = diagnostics;
    }
  }
}

/** JSON-RPC 2.0 error object as a server sends it. */
interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `setTimeout` that never keeps the event loop alive (both runtimes). */
function armTimer(ms: number, fire: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fire, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Map a JSON-RPC error code onto our ToolError taxonomy (ADR-0011). */
export function jsonRpcErrorToToolError(
  server: string,
  error: JsonRpcErrorShape,
): {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error.code === -32601) {
    return {
      code: "not_found",
      message: `MCP server "${server}": method not found (${error.message})`,
      retryable: false,
    };
  }
  if (error.code === -32602 || error.code === -32700) {
    return {
      code: "invalid_input",
      message: `MCP server "${server}" rejected the call: ${error.message}`,
      retryable: true,
    };
  }
  return {
    code: "execution_failed",
    message: `MCP server "${server}" error ${error.code}: ${error.message}`,
    retryable: true,
  };
}

/** Placeholder for content blocks we cannot represent at P1 (text-only ToolResult). */
function nonTextPlaceholder(blockType: unknown): string {
  const label = typeof blockType === "string" ? blockType : String(blockType);
  return `[unsupported MCP content block type: ${label}]`;
}

/**
 * Map one `tools/call` RESULT onto our ToolResult: text blocks joined with
 * newlines (non-text blocks become explicit placeholders), `isError` honored
 * as a structured execution_failed error naming server and tool. Pure — the
 * content-mapping tests exercise it without spawning anything.
 */
export function mapMcpCallResult(server: string, tool: string, result: unknown): ToolResult {
  const parts: string[] = [];
  if (isJsonObject(result) && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else {
        parts.push(nonTextPlaceholder(isJsonObject(block) ? block.type : typeof block));
      }
    }
  }
  const text = parts.length > 0 ? parts.join("\n") : "(no content returned)";
  if (isJsonObject(result) && result.isError === true) {
    return {
      content: [{ type: "text", text }],
      isError: true,
      error: {
        code: "execution_failed",
        message: `MCP tool "${server}__${tool}" reported an error: ${text}`,
        retryable: false,
        details: { server, tool },
      },
    };
  }
  return { content: [{ type: "text", text }], isError: false };
}

/** One pending JSON-RPC request awaiting its response. */
interface PendingRequest {
  /** For diagnostics: the method (and tool) this call was issued for. */
  readonly method: string;
  readonly onResult: (result: unknown) => void;
  readonly onError: (error: McpServerError) => void;
  readonly onFinally: () => void;
}

/**
 * A connected MCP stdio server. Obtain via {@link McpStdioServer.connect};
 * the constructor is private because an unconnected instance would own a
 * child with no handshake driven.
 */
export class McpStdioServer {
  private readonly name: string;
  private readonly child: ChildProcess;
  private readonly callTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrParts: string[] = [];
  private stderrBytes = 0;
  private nextRequestId = 1;
  private closed = false;
  private exitCode: number | null | undefined;
  private stdoutNoiseLines = 0;
  private notificationsReceived = 0;
  private toolsDiscovered: readonly McpToolInfo[] = [];
  private info: McpServerInfo = {};
  private readonly warningsList: string[] = [];
  private readonly exitedPromise: Promise<number | null>;

  /** Discovered tools, in the server's declared order. */
  get tools(): readonly McpToolInfo[] {
    return this.toolsDiscovered;
  }

  /** What the handshake learned (protocol version, server name/version). */
  get serverInfo(): McpServerInfo {
    return this.info;
  }

  /** Loud, non-fatal notes (e.g. a tools/list pagination cap was hit). */
  get warnings(): readonly string[] {
    return this.warningsList;
  }

  /** Record one loud, non-fatal warning (deduplicated). */
  addWarning(text: string): void {
    if (!this.warningsList.includes(text)) {
      this.warningsList.push(text);
    }
  }

  private constructor(options: McpConnectOptions, child: ChildProcess) {
    this.name = options.name;
    this.child = child;
    this.callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
    this.exitedPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        this.exitCode = code;
        this.closed = true;
        this.failAllPending(
          new McpServerError(
            `MCP server "${this.name}" exited unexpectedly (code ${code ?? "null"})`,
            "execution_failed",
            false,
          ),
        );
        resolve(code);
      });
      // A failed spawn (ENOENT & friends) emits 'error' and NEVER 'exit' —
      // settle the exited promise so shutdown() cannot await forever. The
      // connect() error handler owns failing the pending handshake.
      child.once("error", () => {
        resolve(null);
      });
    });
    const decoder = new TextDecoder();
    const parser = createLineFrameParser((line) => {
      this.handleLine(line);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      parser.push(decoder.decode(chunk, { stream: true }));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.appendStderr(decoder.decode(chunk, { stream: true }));
    });
  }

  /** Resolves when the child has exited, with its exit code (null = signal). */
  whenExited(): Promise<number | null> {
    return this.exitedPromise;
  }

  /** Bounded stderr tail + protocol noise counts, for `void mcp doctor`. */
  diagnostics(): string {
    const tail = this.stderrParts.join("");
    const lines = [`stderr tail: ${tail.length > 0 ? tail : "(empty)"}`];
    if (this.stdoutNoiseLines > 0) {
      lines.push(`non-JSON stdout lines ignored: ${this.stdoutNoiseLines}`);
    }
    lines.push(`server notifications received: ${this.notificationsReceived}`);
    return lines.join("\n");
  }

  /**
   * Spawn a server child and drive the full handshake (initialize →
   * notifications/initialized → tools/list) under the startup deadline.
   * Failures are loud here (bad ${VAR}, spawn error, handshake error,
   * startup timeout); the registry layer catches per server and degrades to
   * a structured unavailable tool. Any failure shuts the child down first.
   */
  static async connect(options: McpConnectOptions): Promise<McpStdioServer> {
    const startupTimeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;
    // McpEnvError propagates untouched: nothing was spawned, and the message
    // already names the variable and its settings location.
    const expanded: ExpandedServerConfig = expandServerConfig(
      options.name,
      options,
      options.cliEnv,
    );
    const childEnv = buildChildEnv(options.cliEnv, expanded.env);
    let child: ChildProcess;
    try {
      child = spawn(expanded.command, [...expanded.args], {
        stdio: ["pipe", "pipe", "pipe"] as const,
        env: childEnv,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
    } catch (cause) {
      throw new McpServerError(
        `MCP server "${options.name}" (${expanded.command}) failed to spawn: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "execution_failed",
        false,
      );
    }
    const server = new McpStdioServer(options, child);

    // Spawn errors (ENOENT & friends) arrive asynchronously as an 'error'
    // event; capture them so the handshake races spawn-failure explicitly.
    let spawnError: Error | undefined;
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        spawnError = error;
        // The exit handler never fires for a failed spawn — settle pending.
        server.closed = true;
        server.failAllPending(
          new McpServerError(
            `MCP server "${options.name}" (${expanded.command}) failed to spawn: ${error.message}`,
            "execution_failed",
            false,
          ),
        );
        reject(error);
      });
    });
    const startupDeadline = new Promise<never>((_, reject) => {
      armTimer(startupTimeoutMs, () => {
        reject(
          new McpServerError(
            `MCP server "${options.name}" did not finish its handshake ` +
              `(initialize + tools/list) within ${startupTimeoutMs}ms`,
            "timeout",
            true,
          ),
        );
      });
    });

    try {
      const initResult = await Promise.race([
        server.request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo:
              options.clientInfo !== undefined
                ? { ...options.clientInfo }
                : { ...DEFAULT_MCP_CLIENT_INFO },
          },
          startupTimeoutMs,
        ),
        spawnFailed,
        startupDeadline,
      ]);
      if (!isJsonObject(initResult)) {
        throw new McpServerError(
          `MCP server "${options.name}" returned a malformed initialize result`,
          "execution_failed",
          false,
        );
      }
      const rawInfo = isJsonObject(initResult.serverInfo) ? initResult.serverInfo : {};
      server.info = {
        ...(typeof initResult.protocolVersion === "string"
          ? { protocolVersion: initResult.protocolVersion }
          : {}),
        ...(typeof rawInfo.name === "string" ? { name: rawInfo.name } : {}),
        ...(typeof rawInfo.version === "string" ? { version: rawInfo.version } : {}),
      };
      server.notify("notifications/initialized");
      // tools/list with pagination: follow nextCursor pages; hitting the page
      // cap while a cursor remains is a LOUD warning, never a silent cut.
      const discovered: McpToolInfo[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const listResult = await Promise.race([
          server.request("tools/list", cursor !== undefined ? { cursor } : {}, startupTimeoutMs),
          spawnFailed,
          startupDeadline,
        ]);
        pages += 1;
        discovered.push(...parseToolsList(listResult));
        if (!isJsonObject(listResult)) {
          server.addWarning("tools/list returned a malformed result; catalog may be incomplete");
          break;
        }
        cursor =
          typeof listResult.nextCursor === "string" && listResult.nextCursor.length > 0
            ? listResult.nextCursor
            : undefined;
        if (cursor === undefined) {
          break;
        }
        if (pages >= MAX_TOOLS_LIST_PAGES) {
          server.addWarning(
            `tools/list pagination cap (${MAX_TOOLS_LIST_PAGES} pages) reached while the ` +
              "server still offers a cursor — the tool catalog is TRUNCATED",
          );
          break;
        }
      }
      server.toolsDiscovered = dedupeTools(discovered);
      return server;
    } catch (cause) {
      // Snapshot diagnostics while the child's pipes still hold them.
      const diagnostics = server.diagnostics();
      // Never leave a half-connected child behind; teardown is best-effort.
      await server.shutdown().catch(() => {});
      if (cause instanceof McpServerError) {
        throw new McpServerError(cause.message, cause.code, cause.retryable, diagnostics);
      }
      const detail = spawnError instanceof Error ? spawnError.message : String(cause);
      throw new McpServerError(
        `MCP server "${options.name}" (${expanded.command}) failed to start: ${detail}`,
        "execution_failed",
        false,
        diagnostics,
      );
    }
  }

  // --- frame I/O ------------------------------------------------------------

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.stdoutNoiseLines += 1;
      return;
    }
    if (!isJsonObject(message)) {
      this.stdoutNoiseLines += 1;
      return;
    }
    if (typeof message.id === "number") {
      if (message.result !== undefined || message.error !== undefined) {
        this.settleResponse(message.id, message);
        return;
      }
      if (typeof message.method === "string") {
        this.replyMethodNotFound(message.id, message.method);
        return;
      }
      this.stdoutNoiseLines += 1;
      return;
    }
    if (typeof message.method === "string") {
      this.notificationsReceived += 1;
      return; // P1: notifications are counted, not acted on
    }
    this.stdoutNoiseLines += 1;
  }

  private settleResponse(id: number, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return; // late response to a cancelled/timed-out call: drop it
    }
    this.pending.delete(id);
    if (message.error !== undefined) {
      const shape = isJsonObject(message.error) ? message.error : {};
      const jsonRpcError: JsonRpcErrorShape =
        typeof shape.code === "number" && typeof shape.message === "string"
          ? { code: shape.code, message: shape.message }
          : { code: -32603, message: JSON.stringify(message.error) };
      const mapped = jsonRpcErrorToToolError(this.name, jsonRpcError);
      pending.onError(new McpServerError(mapped.message, mapped.code, mapped.retryable));
      pending.onFinally();
      return;
    }
    pending.onResult(message.result);
    pending.onFinally();
  }

  /** A request MUST be answered; unsupported server requests get -32601. */
  private replyMethodNotFound(id: number, method: string): void {
    this.writeFrame({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `void (MCP P1) does not implement server requests (${method})`,
      },
    });
  }

  private request(
    method: string,
    params: JsonObject | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new McpServerError(
          `MCP server "${this.name}" is not connected (${method})`,
          "execution_failed",
          false,
        ),
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const timer = armTimer(timeoutMs, () => {
        // Tell the server we gave up so it can stop working; a late response
        // is dropped by the missing pending entry.
        this.writeFrame({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client timeout" },
        });
        cleanup();
        reject(
          new McpServerError(
            `MCP server "${this.name}" timed out on ${method} after ${timeoutMs}ms`,
            "timeout",
            true,
          ),
        );
      });
      this.pending.set(id, { method, onResult: resolve, onError: reject, onFinally: cleanup });
      this.writeFrame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  private notify(method: string, params?: JsonObject): void {
    this.writeFrame({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  private writeFrame(frame: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (stdin === null || this.closed) {
      return;
    }
    try {
      stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // Pipe torn down mid-write: the exit handler fails pending calls.
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrParts.push(chunk);
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > STDERR_TAIL_LIMIT && this.stderrParts.length > 1) {
      const dropped = this.stderrParts.shift();
      this.stderrBytes -= dropped?.length ?? 0;
    }
  }

  private failAllPending(error: McpServerError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.onError(error);
      entry.onFinally();
    }
  }

  // --- public API -----------------------------------------------------------

  /**
   * Call one tool; resolves with our ToolResult (never throws — expected
   * failures are structured error results, per the ToolSpec contract):
   * content blocks mapped by {@link mapMcpCallResult}, JSON-RPC errors mapped
   * by {@link jsonRpcErrorToToolError}, the per-call timeout and AbortSignal
   * cancellation both notified to the server via `notifications/cancelled`.
   */
  async callTool(tool: string, input: JsonObject, signal?: AbortSignal): Promise<ToolResult> {
    if (this.closed) {
      const exited = this.exitCode !== undefined ? ` (child exited, code ${this.exitCode})` : "";
      return errorResult(
        new McpServerError(
          `MCP server "${this.name}" is no longer connected${exited}`,
          "execution_failed",
          false,
        ),
        this.name,
        tool,
      );
    }
    if (signal?.aborted) {
      return cancelledResult(this.name, tool, "the call was already aborted before it was sent");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      const timer = armTimer(this.callTimeoutMs, () => {
        this.writeFrame({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client timeout" },
        });
        finish(
          errorResult(
            new McpServerError(
              `MCP server "${this.name}" timed out on tools/call (${tool}) ` +
                `after ${this.callTimeoutMs}ms`,
              "timeout",
              true,
            ),
            this.name,
            tool,
          ),
        );
      });
      const onAbort = (): void => {
        this.writeFrame({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client aborted" },
        });
        finish(cancelledResult(this.name, tool, "the call was aborted (AbortSignal)"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method: `tools/call (${tool})`,
        onResult: (result) => {
          finish(mapMcpCallResult(this.name, tool, result));
        },
        onError: (error) => {
          finish(errorResult(error, this.name, tool));
        },
        onFinally: () => {
          /* finish() owns cleanup for tool calls */
        },
      });
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: input },
      });
    });
  }

  /**
   * Graceful shutdown: close stdin (EOF), SIGTERM the child, escalate to
   * SIGKILL after {@link MCP_SHUTDOWN_GRACE_MS}. Idempotent; always resolves
   * once the child is gone (or was never successfully spawned).
   */
  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.exitedPromise.catch(() => {});
      return;
    }
    this.closed = true;
    this.failAllPending(
      new McpServerError(`MCP server "${this.name}" was shut down`, "execution_failed", false),
    );
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    const killTimer = armTimer(MCP_SHUTDOWN_GRACE_MS, () => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    });
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await this.exitedPromise.catch(() => {});
    clearTimeout(killTimer);
  }
}

/** Tolerant `tools/list` page parser: named objects kept, anything else skipped. */
function parseToolsList(result: unknown): readonly McpToolInfo[] {
  if (!isJsonObject(result) || !Array.isArray(result.tools)) {
    return [];
  }
  const tools: McpToolInfo[] = [];
  for (const entry of result.tools) {
    if (isJsonObject(entry) && typeof entry.name === "string") {
      tools.push({
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(isJsonObject(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
      });
    }
  }
  return tools;
}

/** Dedupe aggregated tools across pages (first occurrence wins). */
function dedupeTools(tools: readonly McpToolInfo[]): readonly McpToolInfo[] {
  const seen = new Set<string>();
  const out: McpToolInfo[] = [];
  for (const tool of tools) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      out.push(tool);
    }
  }
  return out;
}

function errorResult(error: McpServerError, server: string, tool: string): ToolResult {
  return {
    content: [{ type: "text", text: `MCP ${server}__${tool}: ${error.message}` }],
    isError: true,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: { server, tool },
    },
  };
}

function cancelledResult(server: string, tool: string, why: string): ToolResult {
  const message = `MCP tool "${server}__${tool}" call was cancelled: ${why}`;
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: {
      code: "execution_failed",
      message,
      retryable: true,
      details: { server, tool },
    },
  };
}
