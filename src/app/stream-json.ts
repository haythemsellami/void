/**
 * `src/app/stream-json` — the headless event contract (ADR-0003, M4 freeze;
 * v1.1 additive bump per ADR-0008).
 *
 * Translates runner-level records and `EngineEvent`s into Claude-Code-shaped
 * stream-JSON: ONE JSON object per line on stdout, first event
 * `{"type":"system","subtype":"init",…}`, last event `{"type":"result",…}`.
 * Message bodies use Anthropic-style content blocks (`text` / `tool_use` /
 * `tool_result`) so Claude-Code-compatible consumers parse them unchanged.
 *
 * THE CONTRACT IS FROZEN AT v1; v1.1 (ADR-0008) adds exactly one event type
 * (`compaction`) additively — every v1 event's shape is byte-identical. The
 * authoritative documentation (event list, fields, exit-code matrix,
 * examples, machine-readable schema) is docs/stream-json.md;
 * {@link STREAM_JSON_SCHEMA} is the same schema as an object, printable via
 * `void schema`. Additive fields may be appended; the listed fields and
 * their meanings never change.
 */

import type { JsonObject, JsonValue, ToolInput, UsageRecord } from "../contracts";
import type { ConversationResult, ConversationStopReason, EngineEvent } from "../core/engine";

/** Sink for finished lines (no trailing newline; the sink adds it). */
export type LineWriter = (line: string) => void;

/** Session facts for the init event. */
export interface StreamJsonInit {
  readonly threadId: string;
  readonly model: string;
  readonly workspaceRoot: string;
  /** Names of the tools the model may call, sorted. */
  readonly tools: readonly string[];
  /** True when this run continued an existing thread. */
  readonly resumed: boolean;
  readonly version: string;
}

/** A permission decision record (see runner's PermissionGateRecord). */
export interface StreamJsonPermission {
  readonly tool: string;
  readonly input: ToolInput;
  /** The rule engine's action: allow | reject | ask | delegate. */
  readonly decision: "allow" | "reject" | "ask" | "delegate";
  /** True when the call did not run (everything but allow in headless mode). */
  readonly headlessDenied: boolean;
  readonly reason: string;
  readonly message?: string;
}

/** Final result info; subtype is derived from the run outcome. */
export interface StreamJsonFinish {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly threadId: string;
  readonly result: ConversationResult;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** Extra error line for run-level failures (unknown thread/provider). */
  readonly runError?: string;
}

/** result.subtype values, keyed to the exit code. */
export type ResultSubtype =
  | "success"
  | "error_ask_required"
  | "error_permission_rejected"
  | "error_provider"
  | "error_run";

/**
 * Map a run outcome to its result subtype. Guard stops (`max_tool_rounds`,
 * `budget_exceeded`) are `success` — the run completed locally and the reason
 * rides the `stop_reason` field; they are not permission or provider errors.
 */
export function resultSubtypeFor(
  exitCode: 0 | 1 | 2 | 3,
  stopReason: ConversationStopReason,
): ResultSubtype {
  if (exitCode === 2) {
    return "error_permission_rejected";
  }
  if (exitCode === 1) {
    return "error_ask_required";
  }
  if (exitCode === 3) {
    return stopReason === "provider_error" ? "error_provider" : "error_run";
  }
  return "success";
}

/** Usage → the wire shape (snake_case; cache fields only when nonzero). */
function usageToJson(usage: UsageRecord): JsonObject {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0
      ? { cache_read_input_tokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheCreationTokens !== undefined && usage.cacheCreationTokens > 0
      ? { cache_creation_input_tokens: usage.cacheCreationTokens }
      : {}),
  };
}

/** Final assistant text of the conversation (the "result" field payload). */
function finalText(result: ConversationResult): string {
  for (let i = result.messages.length - 1; i >= 0; i -= 1) {
    const message = result.messages[i];
    if (message?.role !== "assistant") {
      continue;
    }
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j];
      if (block?.type === "text" && block.text.trim().length > 0) {
        return block.text;
      }
    }
  }
  return "";
}

/**
 * Emitter: feed it session lifecycle + engine events; it writes exactly one
 * JSON object per line through the injected {@link LineWriter}. Pure — no
 * stdout access, no globals; the CLI owns the process boundary.
 */
export class StreamJsonEmitter {
  readonly #write: LineWriter;
  #pendingText = "";

  constructor(write: LineWriter) {
    this.#write = write;
  }

  /** Emit the init event (must be the first line of a session). */
  init(info: StreamJsonInit): void {
    this.emit({
      type: "system",
      subtype: "init",
      thread_id: info.threadId,
      model: info.model,
      workspace_root: info.workspaceRoot,
      tools: [...info.tools].sort(),
      resumed_from: info.resumed ? info.threadId : null,
      version: info.version,
    });
  }

  /** Translate one engine event (assistant text batches until the next event). */
  engineEvent(event: EngineEvent): void {
    switch (event.type) {
      case "assistant_text_delta":
        this.#pendingText += event.text;
        break;
      case "tool_call_started":
        this.#flushText();
        this.emit({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: event.toolUseId, name: event.name, input: event.input },
            ],
          },
        });
        break;
      case "tool_call_finished":
        this.emit({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: event.toolUseId,
                content: event.resultSummary,
                // From the engine's ToolResult flag, NOT the summary text —
                // a successful result whose content merely starts with
                // "error" (e.g. reading errors.md) is NOT an error result.
                is_error: event.isError,
              },
            ],
          },
        });
        break;
      case "turn_finished":
        this.#flushText();
        break;
      case "compaction":
        this.#flushText();
        // ADR-0008 v1.1 additive event: mid-session marker that the context
        // prefix was replaced by a summary. Optional assumed_context_window
        // appears only when the threshold ran against the fallback window.
        this.emit({
          type: "compaction",
          summarized_turns: event.summarizedTurns,
          kept_turns: event.keptTurns,
          trigger: event.trigger,
          ...(event.assumedContextWindow ? { assumed_context_window: true } : {}),
        });
        break;
      case "engine_stopped":
        this.#flushText();
        break;
    }
  }

  /** Emit a permission decision event (one per evaluated tool call). */
  permission(record: StreamJsonPermission): void {
    this.emit({
      type: "permission",
      decision: record.decision,
      headless_denied: record.headlessDenied,
      tool: record.tool,
      input: record.input,
      reason: record.reason,
      ...(record.message !== undefined ? { message: record.message } : { message: null }),
    });
  }

  /** Emit the final result event (must be the last line of a session). */
  finish(info: StreamJsonFinish): void {
    this.#flushText();
    const subtype = resultSubtypeFor(info.exitCode, info.result.stopReason);
    this.emit({
      type: "result",
      subtype,
      is_error: info.exitCode !== 0,
      exit_code: info.exitCode,
      thread_id: info.threadId,
      duration_ms: Math.max(0, info.finishedAtMs - info.startedAtMs),
      num_turns: info.result.rounds,
      stop_reason: info.result.stopReason,
      total_usage: usageToJson(info.result.totalUsage),
      ...(subtype === "success" ? { result: finalText(info.result) } : {}),
      ...(info.exitCode !== 0
        ? { error: info.runError ?? info.result.error?.message ?? subtype }
        : {}),
    });
  }

  /** Flush buffered assistant text as one assistant message event. */
  #flushText(): void {
    if (this.#pendingText.length === 0) {
      return;
    }
    this.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: this.#pendingText }] },
    });
    this.#pendingText = "";
  }

  emit(event: JsonObject): void {
    this.#write(JSON.stringify(event));
  }
}

// ---------------------------------------------------------------------------
// The frozen schema (docs/stream-json.md is the human contract; this is the
// machine-readable mirror printed by `void schema`)
// ---------------------------------------------------------------------------

const schemaFor = (properties: JsonObject, required: readonly string[]): JsonObject => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

const textBlockSchema = schemaFor({ type: { const: "text" }, text: { type: "string" } }, [
  "type",
  "text",
]);
const toolUseBlockSchema = schemaFor(
  {
    type: { const: "tool_use" },
    id: { type: "string" },
    name: { type: "string" },
    input: { type: "object" },
  },
  ["type", "id", "name", "input"],
);
const toolResultBlockSchema = schemaFor(
  {
    type: { const: "tool_result" },
    tool_use_id: { type: "string" },
    content: { type: "string" },
    is_error: { type: "boolean" },
  },
  ["type", "tool_use_id", "content", "is_error"],
);

/**
 * The stream-JSON line schema: a JSON array — each element validates one line;
 * every line of a session matches exactly one element. Frozen with M4.
 */
export const STREAM_JSON_SCHEMA: JsonObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Void stream-JSON contract (v1.1; v1 frozen, one additive event)",
  description:
    "One JSON object per line on stdout. First line: system/init. Last line: result. " +
    "v1.1 (ADR-0008) adds the compaction event; every v1 event shape is unchanged. " +
    "Additive fields may appear; documented fields never change. See docs/stream-json.md.",
  type: "array",
  items: {
    oneOf: [
      schemaFor(
        {
          type: { const: "system" },
          subtype: { const: "init" },
          thread_id: { type: "string" },
          model: { type: "string" },
          workspace_root: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          resumed_from: { type: ["string", "null"] },
          version: { type: "string" },
        },
        [
          "type",
          "subtype",
          "thread_id",
          "model",
          "workspace_root",
          "tools",
          "resumed_from",
          "version",
        ],
      ),
      schemaFor(
        {
          type: { const: "assistant" },
          message: {
            type: "object",
            properties: {
              role: { const: "assistant" },
              content: {
                type: "array",
                items: { oneOf: [textBlockSchema, toolUseBlockSchema] },
              },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
        },
        ["type", "message"],
      ),
      schemaFor(
        {
          type: { const: "user" },
          message: {
            type: "object",
            properties: {
              role: { const: "user" },
              content: { type: "array", items: toolResultBlockSchema },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
        },
        ["type", "message"],
      ),
      schemaFor(
        {
          type: { const: "permission" },
          decision: { enum: ["allow", "reject", "ask", "delegate"] },
          headless_denied: { type: "boolean" },
          tool: { type: "string" },
          input: { type: "object" },
          reason: { type: "string" },
          message: { type: ["string", "null"] },
        },
        ["type", "decision", "headless_denied", "tool", "input", "reason", "message"],
      ),
      schemaFor(
        {
          type: { const: "compaction" },
          summarized_turns: { type: "integer", minimum: 0 },
          kept_turns: { type: "integer", minimum: 0 },
          trigger: { enum: ["threshold", "manual"] },
          assumed_context_window: { type: "boolean" },
        },
        ["type", "summarized_turns", "kept_turns", "trigger"],
      ),
      schemaFor(
        {
          type: { const: "result" },
          subtype: {
            enum: [
              "success",
              "error_ask_required",
              "error_permission_rejected",
              "error_provider",
              "error_run",
            ],
          },
          is_error: { type: "boolean" },
          exit_code: { enum: [0, 1, 2, 3] },
          thread_id: { type: "string" },
          duration_ms: { type: "integer", minimum: 0 },
          num_turns: { type: "integer", minimum: 0 },
          stop_reason: { type: "string" },
          total_usage: {
            type: "object",
            properties: {
              input_tokens: { type: "integer", minimum: 0 },
              output_tokens: { type: "integer", minimum: 0 },
              cache_read_input_tokens: { type: "integer", minimum: 0 },
              cache_creation_input_tokens: { type: "integer", minimum: 0 },
            },
            required: ["input_tokens", "output_tokens"],
            additionalProperties: false,
          },
          result: { type: "string" },
          error: { type: "string" },
        },
        [
          "type",
          "subtype",
          "is_error",
          "exit_code",
          "thread_id",
          "duration_ms",
          "num_turns",
          "stop_reason",
          "total_usage",
        ],
      ),
    ],
  },
};

/** The schema as a printable JSON document (`void schema`). */
export function streamJsonSchemaText(): string {
  return JSON.stringify(STREAM_JSON_SCHEMA, null, 2);
}

/** Type guard used by tests/consumers: a value that is a JSON object. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
