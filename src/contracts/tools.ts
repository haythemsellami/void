/**
 * Tools contract: registry entries (ToolSpec) plus the context and result
 * shapes every tool executes with.
 *
 * Implemented by `tools/` (registry + builtins: bash, edit_file, read_file,
 * grep/glob — docs/architecture.md §tools). Executed by `core/` after the
 * permissions engine allows the call; results feed both the provider (as
 * tool_result messages) and the thread store.
 *
 * Types only; the single import is the permissions decision used by the
 * permission-request callback.
 */
import type { PermissionDecision } from "./permissions";

/** A JSON value, as accepted/emitted by tools and serialized into threads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * A tool's input is always a JSON object: providers parse the streamed
 * tool-use JSON into this shape before dispatch.
 */
export type ToolInput = JsonObject;

/**
 * Plain JSON-Schema-shaped object describing a tool input. Top level must
 * describe a JSON object (`type: "object"`); providers may pass it through
 * without resolving `$ref`s (builtin schemas are self-contained).
 */
export type JsonSchema = JsonObject;

/**
 * Provenance of a registered tool. MVP shipped builtins only; ADR-0011 added
 * `"mcp"` for tools discovered from configured MCP servers (registered as
 * `mcp__<server>__<tool>`). Declaration-only — no runtime consumer branches
 * on it (providers serialize name/description/inputSchema only).
 */
export type ToolSource = "builtin" | "mcp";

/** Registry entry — the exact shape `tools/` registers. */
export interface ToolSpec {
  /** Stable tool name exposed to the model (e.g. "bash", "edit_file"). */
  readonly name: string;
  /** Short description the model reads to decide when to call the tool. */
  readonly description: string;
  /** JSON Schema for the tool's input object. */
  readonly inputSchema: JsonSchema;
  readonly source: ToolSource;
  /**
   * Declaration-only capability marker (MVP): `true` states that the tool
   * wants network access. It grants nothing by itself — bash keeps its
   * sandbox deny-by-default and permission-gated network is post-MVP; the
   * flag exists so policy layers have something to read.
   */
  readonly network?: boolean;
  /**
   * Execute the tool. Async by contract; MUST NOT throw for expected failures —
   * return a ToolResult with `isError` and a structured error instead.
   * Throwing is reserved for bugs in the tool implementation itself.
   */
  execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>;
}

/** Escalation payload used when a permission rule evaluates to `ask`. */
export interface PermissionRequest {
  /** Tool name about to execute. */
  readonly tool: string;
  /** The exact input that would be executed. */
  readonly input: ToolInput;
  /** Why permission is needed (the matched rule / sensitive operation). */
  readonly reason: string;
}

/** Answers a PermissionRequest; `ask` fails headless runs with remediation text (ADR-0003). */
export type PermissionRequestCallback = (request: PermissionRequest) => Promise<PermissionDecision>;

/** Output caps for tool results — config, not magic (docs/architecture.md §tools). */
export interface OutputLimits {
  /**
   * Maximum size in BYTES retained across all content blocks of one result
   * (byte caps are conservative for multi-byte UTF-8; the field name
   * predates the byte decision and is kept for compatibility). Truncation
   * markers are metadata and may exceed the cap.
   */
  readonly maxTotalChars: number;
  /** Maximum size in BYTES retained per logical section (stdout, stderr, each file). */
  readonly maxSectionChars: number;
  /**
   * Optional cap on the number of lines (or entries) a tool may return in
   * one result; line-shaped tools (read_file) read it from the context and
   * fall back to their own default when absent.
   */
  readonly maxLines?: number;
}

/** Runtime context handed to every tool execution. */
export interface ToolContext {
  /** Absolute path of the workspace the session operates on. */
  readonly workspaceRoot: string;
  /** Absolute working directory for this execution. */
  readonly workingDir: string;
  /** Explicit environment for the execution (never implicitly process.env). */
  readonly env: Readonly<Record<string, string>>;
  /** Permission escalation path for `ask` outcomes. */
  readonly requestPermission: PermissionRequestCallback;
  /** Caps applied to tool output before it enters the conversation. */
  readonly outputLimits: OutputLimits;
  /**
   * Cancellation signal for this execution. Tools that run long-lived work
   * (child processes, large scans) SHOULD observe it and abort early, then
   * return a structured error result; tools may ignore it where aborting is
   * not meaningful. Absent = no cancellation is requested (MVP default).
   */
  readonly signal?: AbortSignal;
}

/** Text content block in a tool result (image blocks may be added later). */
export interface TextResultBlock {
  readonly type: "text";
  readonly text: string;
  /** Set when `text` was clipped at a configured output cap (explicit truncation marker). */
  readonly truncated?: boolean;
}

export type ToolResultContentBlock = TextResultBlock;

/** Machine-readable failure category for structured errors. */
export type ToolErrorCode =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "sandbox_blocked"
  | "timeout"
  | "execution_failed";

/** Structured error carried by a failed ToolResult (never thrown). */
export interface ToolError {
  readonly code: ToolErrorCode;
  /** Human-readable failure description. */
  readonly message: string;
  /** Whether retrying the identical call could succeed. */
  readonly retryable: boolean;
  /**
   * Optional machine-readable payload localizing the failure (exit codes,
   * match counts, line numbers). Schema is per tool and code; must stay JSON
   * so it can cross into provider tool_result blocks and thread logs.
   */
  readonly details?: JsonObject;
}

/**
 * Result of one tool execution: content blocks returned to the model plus
 * explicit truncation markers, or a structured error for expected failures.
 */
export interface ToolResult {
  readonly content: readonly ToolResultContentBlock[];
  /** True when the tool could not complete as asked (expected failure). */
  readonly isError: boolean;
  /** Structured error detail; present iff `isError`. */
  readonly error?: ToolError;
}
