/**
 * Tests for the stream-JSON contract translation (M4 freeze; v1.1 additive
 * bump per ADR-0008): event ordering and shapes through a real runTask run
 * (fake provider), the exit-code to result.subtype mapping, the compaction
 * event emission, and the machine-readable schema object — including a
 * byte-for-byte pin of the five frozen v1 variant schemas so the bump can
 * only ever be additive.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatCompletion, ChatRequest, Provider, StreamEvent } from "../contracts";
import { runTask } from "./runner";
import {
  resultSubtypeFor,
  STREAM_JSON_SCHEMA,
  StreamJsonEmitter,
  streamJsonSchemaText,
} from "./stream-json";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-sjs-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Minimal fake provider: one tool round, one text round. */
class TwoRoundProvider implements Provider {
  readonly id = "fake";
  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown>,
  ) {}
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    if (request.messages.length <= 1) {
      yield { type: "text_delta", text: "working" };
      yield { type: "tool_use_start", id: "t1", name: this.toolName };
      yield {
        type: "tool_use_end",
        id: "t1",
        name: this.toolName,
        input: this.input as never,
      };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } };
      yield { type: "turn_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "all done" };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 6 } };
    yield { type: "turn_complete", stopReason: "end_turn" };
  }
  async complete(): Promise<ChatCompletion> {
    throw new Error("not used");
  }
}

describe("StreamJsonEmitter through runTask", () => {
  it("emits init first, batched assistant/user/permission events, result last", async () => {
    const ws = mkdtempSync(join(scratch, "ws-"));
    writeFileSync(join(ws, "f.txt"), "alpha\n");
    const dataDir = mkdtempSync(join(scratch, "data-"));
    const lines: string[] = [];
    const emitter = new StreamJsonEmitter((line) => {
      lines.push(line);
    });

    // The CLI pattern: pre-generate the thread id so init can precede the
    // run (engine/permission events fire DURING runTask).
    emitter.init({
      threadId: "sjs-thread-1",
      model: "anthropic/claude-sonnet-4-5",
      workspaceRoot: ws,
      tools: ["bash", "read_file"],
      resumed: false,
      version: "0.0.0",
    });

    const outcome = await runTask({
      task: "read the file",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: new TwoRoundProvider("read_file", { path: join(ws, "f.txt") }),
      dataDir,
      systemPrompt: "p",
      newId: () => "sjs-thread-1",
      onEngineEvent: (event) => {
        emitter.engineEvent(event);
      },
      onPermission: (record) => {
        emitter.permission({
          tool: record.tool,
          input: record.input,
          decision: record.action,
          headlessDenied: record.headlessDenied,
          reason: record.reason,
          ...(record.message !== undefined ? { message: record.message } : {}),
        });
      },
    });
    emitter.finish({
      exitCode: outcome.exitCode,
      threadId: outcome.threadId,
      result: outcome.result,
      startedAtMs: 1_000,
      finishedAtMs: 1_500,
    });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    // init first, result last
    expect(parsed[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(parsed.at(-1)?.type).toBe("result");

    const types = parsed.map((line) => `${line.type}${line.subtype ? `:${line.subtype}` : ""}`);
    expect(types).toEqual([
      "system:init",
      "assistant",
      "assistant",
      "permission",
      "user",
      "assistant",
      "result:success",
    ]);

    // init facts
    const init = parsed[0];
    expect(init?.thread_id).toBe("sjs-thread-1");
    expect(init?.workspace_root).toBe(ws);
    expect(init?.tools).toEqual(["bash", "read_file"]); // sorted
    expect(init?.resumed_from).toBeNull();
    expect(init?.version).toBe("0.0.0");

    // text batched into one assistant message before the tool_use event
    expect(parsed[1]).toEqual({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    });
    expect(parsed[2]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: join(ws, "f.txt") } },
        ],
      },
    });

    // permission event for the allowed read
    expect(parsed[3]).toMatchObject({
      type: "permission",
      decision: "allow",
      headless_denied: false,
      tool: "read_file",
    });

    // tool result as a user event
    expect(parsed[4]).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: expect.stringContaining("alpha"),
            is_error: false,
          },
        ],
      },
    });

    // result carries totals and the final text
    const result = parsed.at(-1);
    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      exit_code: 0,
      thread_id: "sjs-thread-1",
      duration_ms: 500,
      num_turns: 2,
      stop_reason: "end_turn",
      total_usage: { input_tokens: 22, output_tokens: 10 },
      result: "all done",
    });
    expect(result).not.toHaveProperty("error");

    // Every line is a JSON object of one line (no embedded newlines).
    for (const line of lines) {
      expect(line.includes("\n")).toBe(false);
    }
  });

  it("emits permission ask events and error results on the ask path", async () => {
    const ws = mkdtempSync(join(scratch, "ask-ws-"));
    const dataDir = mkdtempSync(join(scratch, "ask-data-"));
    const lines: string[] = [];
    const emitter = new StreamJsonEmitter((line) => {
      lines.push(line);
    });
    emitter.init({
      threadId: "sjs-ask-1",
      model: "m",
      workspaceRoot: ws,
      tools: [],
      resumed: false,
      version: "0.0.0",
    });

    const outcome = await runTask({
      task: "push",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: {
        id: "fake",
        async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
          if (request.messages.length <= 1) {
            yield { type: "tool_use_start", id: "p1", name: "bash" };
            yield {
              type: "tool_use_end",
              id: "p1",
              name: "bash",
              input: { command: "git push origin main" },
            };
            yield { type: "turn_complete", stopReason: "tool_use" };
            return;
          }
          yield { type: "turn_complete", stopReason: "end_turn" };
        },
        async complete(): Promise<ChatCompletion> {
          throw new Error("not used");
        },
      },
      dataDir,
      systemPrompt: "p",
      newId: () => "sjs-ask-1",
      onEngineEvent: (event) => {
        emitter.engineEvent(event);
      },
      onPermission: (record) => {
        emitter.permission({
          tool: record.tool,
          input: record.input,
          decision: record.action,
          headlessDenied: record.headlessDenied,
          reason: record.reason,
          ...(record.message !== undefined ? { message: record.message } : {}),
        });
      },
    });

    emitter.finish({
      exitCode: outcome.exitCode,
      threadId: outcome.threadId,
      result: outcome.result,
      startedAtMs: 0,
      finishedAtMs: 5,
    });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const permission = parsed.find((line) => line.type === "permission");
    expect(permission).toMatchObject({
      decision: "ask",
      headless_denied: true,
      tool: "bash",
    });
    expect(permission?.message).toEqual(expect.stringContaining("headless"));

    const deniedUser = parsed.find(
      (line) => line.type === "user" && JSON.stringify(line).includes("permission_denied"),
    );
    expect(deniedUser).toBeDefined();
    expect(JSON.stringify(deniedUser)).toContain('"is_error":true');

    expect(parsed.at(-1)).toMatchObject({
      type: "result",
      subtype: "error_ask_required",
      is_error: true,
      exit_code: 1,
    });
  });
});

describe("StreamJsonEmitter tool_result is_error", () => {
  it("uses the engine's isError flag, not the summary text (summary starting with 'error')", () => {
    const lines: string[] = [];
    const emitter = new StreamJsonEmitter((line) => {
      lines.push(line);
    });
    // A SUCCESSFUL read of errors.md: summary text begins with "error", the
    // result is not an error result. The old derivation reported true here.
    emitter.engineEvent({
      type: "tool_call_finished",
      toolUseId: "t9",
      name: "read_file",
      resultSummary: "error log line one\nerror log line two",
      isError: false,
    });
    emitter.engineEvent({
      type: "tool_call_finished",
      toolUseId: "t10",
      name: "bash",
      resultSummary: "error(execution_failed): command crashed",
      isError: true,
    });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const blocks = parsed.map(
      (line) => (line.message as { content: { type: string; is_error?: boolean }[] }).content[0],
    );
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "t9", is_error: false });
    expect(blocks[1]).toMatchObject({ type: "tool_result", tool_use_id: "t10", is_error: true });
  });

  it("reports is_error:false end-to-end for a successful read of a file whose content starts with 'error'", async () => {
    const ws = mkdtempSync(join(scratch, "err-ws-"));
    writeFileSync(join(ws, "errors.md"), "error: this file merely documents errors\n");
    const dataDir = mkdtempSync(join(scratch, "err-data-"));
    const lines: string[] = [];
    const emitter = new StreamJsonEmitter((line) => {
      lines.push(line);
    });
    const outcome = await runTask({
      task: "read the error log",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: new TwoRoundProvider("read_file", { path: join(ws, "errors.md") }),
      dataDir,
      systemPrompt: "p",
      newId: () => "sjs-err-1",
      onEngineEvent: (event) => {
        emitter.engineEvent(event);
      },
    });
    emitter.finish({
      exitCode: outcome.exitCode,
      threadId: outcome.threadId,
      result: outcome.result,
      startedAtMs: 0,
      finishedAtMs: 1,
    });

    const toolResultLine = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === "user");
    const block = (toolResultLine?.message as { content: { type: string; is_error?: boolean }[] })
      ?.content[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.is_error).toBe(false);
  });
});

describe("resultSubtypeFor", () => {
  it("maps the exit-code matrix", () => {
    expect(resultSubtypeFor(0, "end_turn")).toBe("success");
    expect(resultSubtypeFor(0, "max_tool_rounds")).toBe("success"); // guard stops are local, not errors
    expect(resultSubtypeFor(1, "end_turn")).toBe("error_ask_required");
    expect(resultSubtypeFor(2, "end_turn")).toBe("error_permission_rejected");
    expect(resultSubtypeFor(3, "provider_error")).toBe("error_provider");
    expect(resultSubtypeFor(3, "end_turn")).toBe("error_run");
  });
});

describe("STREAM_JSON_SCHEMA", () => {
  it("round-trips through JSON and covers the six event types (v1.1)", () => {
    const text = streamJsonSchemaText();
    const parsed = JSON.parse(text) as { items?: { oneOf?: { properties?: unknown }[] } };
    const variants = parsed.items?.oneOf ?? [];
    expect(variants.length).toBe(6);
    const constTypes = variants.map(
      (variant) =>
        (variant as { properties?: { type?: { const?: string } } }).properties?.type?.const,
    );
    expect(constTypes).toEqual([
      "system",
      "assistant",
      "user",
      "permission",
      "compaction",
      "result",
    ]);
  });

  it("pins the five v1 variant schemas byte-for-byte (v1.1 is additive only)", () => {
    const text = streamJsonSchemaText();
    const parsed = JSON.parse(text) as {
      items?: { oneOf?: Record<string, unknown>[] };
    };
    const variants = parsed.items?.oneOf ?? [];
    const byConst = new Map(
      variants
        .map((variant) => {
          const type = (variant as { properties?: { type?: { const?: string } } }).properties?.type
            ?.const;
          return type !== undefined ? ([type, variant] as const) : undefined;
        })
        .filter(
          (entry): entry is readonly [string, Record<string, unknown>] => entry !== undefined,
        ),
    );
    // The frozen v1 shapes, transcribed from the M4 freeze. Any change to a
    // v1 event's schema — field, required flag, const value — fails here.
    expect(byConst.get("system")).toEqual(V1_SYSTEM_SCHEMA);
    expect(byConst.get("assistant")).toEqual(V1_ASSISTANT_SCHEMA);
    expect(byConst.get("user")).toEqual(V1_USER_SCHEMA);
    expect(byConst.get("permission")).toEqual(V1_PERMISSION_SCHEMA);
    expect(byConst.get("result")).toEqual(V1_RESULT_SCHEMA);
  });

  it("documents the v1.1 compaction variant with the ADR-0008 shape", () => {
    const text = streamJsonSchemaText();
    const parsed = JSON.parse(text) as {
      items?: { oneOf?: Record<string, unknown>[] };
    };
    const compaction = parsed.items?.oneOf?.find(
      (variant) =>
        (variant as { properties?: { type?: { const?: string } } }).properties?.type?.const ===
        "compaction",
    );
    expect(compaction).toEqual({
      type: "object",
      properties: {
        type: { const: "compaction" },
        summarized_turns: { type: "integer", minimum: 0 },
        kept_turns: { type: "integer", minimum: 0 },
        trigger: { enum: ["threshold", "manual"] },
        assumed_context_window: { type: "boolean" },
      },
      required: ["type", "summarized_turns", "kept_turns", "trigger"],
      additionalProperties: false,
    });
  });

  it("emits the compaction event with snake_case fields and the optional fallback flag", () => {
    const lines: string[] = [];
    const emitter = new StreamJsonEmitter((line) => {
      lines.push(line);
    });
    emitter.init({
      threadId: "sjs-compaction-1",
      model: "anthropic/claude-sonnet-4-5",
      workspaceRoot: "/ws",
      tools: [],
      resumed: true,
      version: "0.0.0",
    });
    emitter.engineEvent({
      type: "compaction",
      trigger: "threshold",
      summary: "Goal: ship compaction.",
      summarizedTurns: 12,
      keptTurns: 2,
      usage: { inputTokens: 700, outputTokens: 80 },
      assumedContextWindow: false,
    });
    emitter.engineEvent({
      type: "compaction",
      trigger: "manual",
      summary: "Assumed window.",
      summarizedTurns: 3,
      keptTurns: 2,
      usage: { inputTokens: 700, outputTokens: 80 },
      assumedContextWindow: true,
    });
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[1]).toEqual({
      type: "compaction",
      summarized_turns: 12,
      kept_turns: 2,
      trigger: "threshold",
    });
    expect(parsed[2]).toEqual({
      type: "compaction",
      summarized_turns: 3,
      kept_turns: 2,
      trigger: "manual",
      assumed_context_window: true,
    });
  });

  it("validates a sample session against the emitted lines' shapes (spot check)", () => {
    const line = JSON.stringify({
      type: "permission",
      decision: "ask",
      headless_denied: true,
      tool: "bash",
      input: { command: "git push" },
      reason: "test",
      message: null,
    }) as string;
    expect(() => JSON.parse(line)).not.toThrow();
    expect(STREAM_JSON_SCHEMA.type).toBe("array");
  });
});

// ---------------------------------------------------------------------------
// The frozen v1 variant schemas (M4 freeze), transcribed verbatim from the
// pre-v1.1 contract. The additivity pin above compares against these —
// update NOTHING here without a contract ADR.
// ---------------------------------------------------------------------------

const schemaFor = (properties: Record<string, unknown>, required: readonly string[]) => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

const V1_TEXT_BLOCK = schemaFor({ type: { const: "text" }, text: { type: "string" } }, [
  "type",
  "text",
]);

const V1_TOOL_USE_BLOCK = schemaFor(
  {
    type: { const: "tool_use" },
    id: { type: "string" },
    name: { type: "string" },
    input: { type: "object" },
  },
  ["type", "id", "name", "input"],
);

const V1_TOOL_RESULT_BLOCK = schemaFor(
  {
    type: { const: "tool_result" },
    tool_use_id: { type: "string" },
    content: { type: "string" },
    is_error: { type: "boolean" },
  },
  ["type", "tool_use_id", "content", "is_error"],
);

const V1_SYSTEM_SCHEMA = schemaFor(
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
  ["type", "subtype", "thread_id", "model", "workspace_root", "tools", "resumed_from", "version"],
);

const V1_ASSISTANT_SCHEMA = schemaFor(
  {
    type: { const: "assistant" },
    message: {
      type: "object",
      properties: {
        role: { const: "assistant" },
        content: { type: "array", items: { oneOf: [V1_TEXT_BLOCK, V1_TOOL_USE_BLOCK] } },
      },
      required: ["role", "content"],
      additionalProperties: false,
    },
  },
  ["type", "message"],
);

const V1_USER_SCHEMA = schemaFor(
  {
    type: { const: "user" },
    message: {
      type: "object",
      properties: {
        role: { const: "user" },
        content: { type: "array", items: V1_TOOL_RESULT_BLOCK },
      },
      required: ["role", "content"],
      additionalProperties: false,
    },
  },
  ["type", "message"],
);

const V1_PERMISSION_SCHEMA = schemaFor(
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
);

const V1_RESULT_SCHEMA = schemaFor(
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
);
