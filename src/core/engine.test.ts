/**
 * Unit tests for `src/core` (turn engine + request assembly).
 *
 * The provider is a scripted fake implementing the Provider contract with
 * planned StreamEvent sequences per round; tools are recording fakes. The
 * engine is pure orchestration, so these tests exercise control flow and
 * aggregation only — deterministic, network-free, no filesystem.
 */
import { describe, expect, it } from "vitest";
import type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  Provider,
  StreamEvent,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolResultBlock,
  ToolSpec,
  UsageRecord,
} from "../contracts";
import { assembleChatRequest } from "./assemble";
import {
  type ConversationResult,
  createToolRegistry,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_OUTPUT_LIMITS,
  type EngineConfig,
  type EngineEvent,
  runConversation,
  runTurn,
} from "./engine";

// ---------------------------------------------------------------------------
// Scripted fakes
// ---------------------------------------------------------------------------

/** Yields the planned event sequence for each round; records every request. */
class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private nextRound = 0;

  constructor(private readonly scripts: readonly (readonly StreamEvent[])[]) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    const round = this.nextRound;
    this.nextRound += 1;
    const script = this.scripts[round];
    if (script === undefined) {
      throw new Error(`ScriptedProvider: no script prepared for round ${round + 1}`);
    }
    yield* script;
  }

  async complete(): Promise<ChatCompletion> {
    throw new Error("ScriptedProvider.complete is not used by the engine");
  }
}

/** A provider whose stream throws mid-iteration (contract violation). */
class ThrowingProvider implements Provider {
  readonly id = "throwing";
  readonly requests: ChatRequest[] = [];

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    yield { type: "text_delta", text: "starting" };
    throw new Error("socket hung up");
  }

  async complete(): Promise<ChatCompletion> {
    throw new Error("ThrowingProvider.complete is not used by the engine");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userTurn(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function usage(inputTokens: number, outputTokens: number): UsageRecord {
  return { inputTokens, outputTokens };
}

function cachedUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): UsageRecord {
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/** A text-only round, streamed as two deltas to exercise accumulation. */
function textRound(text: string, record: UsageRecord = usage(10, 5)): StreamEvent[] {
  const half = Math.floor(text.length / 2);
  const events: StreamEvent[] = [];
  if (text.slice(0, half).length > 0)
    events.push({ type: "text_delta", text: text.slice(0, half) });
  if (text.slice(half).length > 0) events.push({ type: "text_delta", text: text.slice(half) });
  events.push({ type: "usage", usage: record }, { type: "turn_complete", stopReason: "end_turn" });
  return events;
}

/** A tool-use round with the full start → delta → end event triple. */
function toolUseRound(
  call: { id: string; name: string; input: ToolInput; text?: string },
  record: UsageRecord = usage(10, 5),
): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (call.text !== undefined) events.push({ type: "text_delta", text: call.text });
  events.push(
    { type: "tool_use_start", id: call.id, name: call.name },
    { type: "tool_use_delta", id: call.id, inputDelta: JSON.stringify(call.input) },
    { type: "tool_use_end", id: call.id, input: call.input },
    { type: "usage", usage: record },
    { type: "turn_complete", stopReason: "tool_use" },
  );
  return events;
}

interface RecordedCall {
  readonly input: ToolInput;
  readonly ctx: ToolContext;
}

function recordingTool(
  name: string,
  calls: RecordedCall[],
  result: ToolResult = { content: [{ type: "text", text: "ok" }], isError: false },
): ToolSpec {
  return {
    name,
    description: `recording test tool ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    async execute(input, ctx) {
      calls.push({ input, ctx });
      return result;
    },
  };
}

function throwingTool(name: string): ToolSpec {
  return {
    name,
    description: `throwing test tool ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    async execute() {
      throw new Error("boom: tool bug");
    },
  };
}

/** Appends to a shared log so execution order (and its sequentiality) is observable. */
function orderTool(name: string, order: string[]): ToolSpec {
  return {
    name,
    description: `order-tracking test tool ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    async execute() {
      order.push(`start:${name}`, `end:${name}`);
      return { content: [{ type: "text", text: `${name} ok` }], isError: false };
    },
  };
}

async function runScripted(
  scripts: readonly (readonly StreamEvent[])[],
  tools: readonly ToolSpec[] = [],
  config: EngineConfig = {},
): Promise<{ result: ConversationResult; provider: ScriptedProvider; events: EngineEvent[] }> {
  const provider = new ScriptedProvider(scripts);
  const events: EngineEvent[] = [];
  const result = await runConversation({
    provider,
    model: "mock/test-model",
    registry: createToolRegistry(tools),
    system: "You are Void.",
    messages: [userTurn("list the files")],
    config: { ...config, onEvent: (event) => events.push(event) },
  });
  return { result, provider, events };
}

function asToolResult(message: ChatMessage | undefined): ToolResultBlock | undefined {
  const block = message?.content[0];
  return block?.type === "tool_result" ? block : undefined;
}

// ---------------------------------------------------------------------------
// assembleChatRequest
// ---------------------------------------------------------------------------

describe("assembleChatRequest", () => {
  it("includes every provided part", () => {
    const request = assembleChatRequest({
      model: "mock/test-model",
      system: "You are Void.",
      messages: [userTurn("hi")],
      tools: [recordingTool("bash", [])],
      params: { temperature: 0.2, maxOutputTokens: 512 },
    });
    expect(request.model).toBe("mock/test-model");
    expect(request.system).toBe("You are Void.");
    expect(request.messages).toHaveLength(1);
    expect(request.tools?.map((tool) => tool.name)).toEqual(["bash"]);
    expect(request.params).toEqual({ temperature: 0.2, maxOutputTokens: 512 });
  });

  it("omits absent or empty optional parts", () => {
    const request = assembleChatRequest({ model: "m", messages: [], tools: [], system: "" });
    expect(request.system).toBeUndefined();
    expect(request.tools).toBeUndefined();
    expect(request.params).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createToolRegistry
// ---------------------------------------------------------------------------

describe("createToolRegistry", () => {
  it("registers tools by name", () => {
    const registry = createToolRegistry([
      recordingTool("bash", []),
      recordingTool("read_file", []),
    ]);
    expect([...registry.keys()].sort()).toEqual(["bash", "read_file"]);
  });

  it("rejects duplicate tool names", () => {
    const tool = recordingTool("bash", []);
    expect(() => createToolRegistry([tool, tool])).toThrow("duplicate tool registration");
  });

  it("exposes the documented engine defaults", () => {
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBe(25);
    expect(DEFAULT_OUTPUT_LIMITS.maxTotalChars).toBeGreaterThan(0);
    expect(DEFAULT_OUTPUT_LIMITS.maxSectionChars).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runConversation
// ---------------------------------------------------------------------------

describe("runConversation", () => {
  it("completes a text-only turn", async () => {
    const { result, provider, events } = await runScripted([
      textRound("Hello world", usage(10, 5)),
    ]);

    expect(result.stopReason).toBe("end_turn");
    expect(result.rounds).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    });
    expect(result.totalUsage).toStrictEqual({ inputTokens: 10, outputTokens: 5 });
    expect(events.map((event) => event.type)).toEqual([
      "assistant_text_delta",
      "assistant_text_delta",
      "turn_finished",
      "engine_stopped",
    ]);
    expect(provider.requests[0]?.system).toBe("You are Void.");
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it("executes one tool round and feeds results back", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls, {
      content: [{ type: "text", text: "file1\nfile2" }],
      isError: false,
    });
    const { result, provider, events } = await runScripted(
      [
        toolUseRound(
          { id: "tu_1", name: "bash", input: { command: "ls" }, text: "Checking." },
          usage(10, 5),
        ),
        textRound("All done.", usage(20, 7)),
      ],
      [bash],
      { workspaceRoot: "/tmp/ws", env: { PATH: "/usr/bin" } },
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.rounds).toBe(2);
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.messages[1]?.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(result.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "tu_1",
        content: [{ type: "text", text: "file1\nfile2" }],
        isError: false,
      },
    ]);
    expect(result.totalUsage).toStrictEqual({ inputTokens: 30, outputTokens: 12 });

    // Tool ran exactly once, with the parsed input and the configured context.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ command: "ls" });
    expect(calls[0]?.ctx.workspaceRoot).toBe("/tmp/ws");
    expect(calls[0]?.ctx.workingDir).toBe("/tmp/ws");
    expect(calls[0]?.ctx.env).toEqual({ PATH: "/usr/bin" });
    expect(calls[0]?.ctx.outputLimits).toEqual(DEFAULT_OUTPUT_LIMITS);

    // The second provider call saw the full history including the tool result.
    expect(provider.requests[1]?.messages).toHaveLength(3);
    expect(asToolResult(provider.requests[1]?.messages[2])?.toolUseId).toBe("tu_1");
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["bash"]);

    const started = events.find((event) => event.type === "tool_call_started");
    expect(started).toMatchObject({
      type: "tool_call_started",
      toolUseId: "tu_1",
      name: "bash",
      input: { command: "ls" },
    });
    const finished = events.find((event) => event.type === "tool_call_finished");
    expect(finished).toMatchObject({ type: "tool_call_finished", name: "bash" });
    if (finished?.type === "tool_call_finished") {
      expect(finished.resultSummary).toContain("file1");
      expect(finished.isError).toBe(false); // success result flagged success
    }
  });

  it("runs multiple tool rounds sequentially", async () => {
    const order: string[] = [];
    const bash = orderTool("bash", order);
    const readFile = orderTool("read_file", order);
    const { result, provider } = await runScripted(
      [
        toolUseRound({ id: "t1", name: "bash", input: { n: 1 } }, usage(10, 1)),
        toolUseRound({ id: "t2", name: "read_file", input: { n: 2 } }, usage(10, 1)),
        toolUseRound({ id: "t3", name: "bash", input: { n: 3 } }, usage(10, 1)),
        textRound("finished", usage(10, 1)),
      ],
      [readFile, bash], // registered out of order on purpose
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.rounds).toBe(4);
    // Sequential dispatch: each tool's start/end pair never interleaves.
    expect(order).toEqual([
      "start:bash",
      "end:bash",
      "start:read_file",
      "end:read_file",
      "start:bash",
      "end:bash",
    ]);
    // user + 3 x (assistant + tool results) + final assistant
    expect(result.messages).toHaveLength(8);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
    });
    // Tool specs reach the provider in a deterministic (name-sorted) order.
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["bash", "read_file"]);
  });

  it("stops gracefully on a mid-stream error event", async () => {
    const script: StreamEvent[] = [
      { type: "text_delta", text: "partial answer" },
      { type: "error", error: { message: "overloaded", retryable: true, code: "overload" } },
    ];
    const { result, provider, events } = await runScripted([script]);

    expect(result.stopReason).toBe("provider_error");
    expect(result.error?.message).toBe("overloaded");
    expect(result.error?.retryable).toBe(true);
    expect(result.rounds).toBe(1);
    expect(provider.requests).toHaveLength(1); // no retry loop
    // Partial text is preserved as an assistant message.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
    });
    expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "engine_stopped",
      reason: "provider_error",
      message: "overloaded",
    });
  });

  it("pairs tool_use blocks with error results when the round fails mid-stream", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const script: StreamEvent[] = [
      { type: "text_delta", text: "let me check" },
      { type: "tool_use_start", id: "tu_1", name: "bash" },
      { type: "tool_use_end", id: "tu_1", input: { command: "ls" } },
      { type: "error", error: { message: "upstream exploded", retryable: true, code: "server" } },
    ];
    const { result } = await runScripted([script], [bash]);

    expect(result.stopReason).toBe("provider_error");
    // The tool never ran…
    expect(calls).toHaveLength(0);
    // …but its tool_use is paired with a synthesized error result, so the
    // transcript stays a valid provider message sequence.
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const block = asToolResult(result.messages[2]);
    expect(block?.toolUseId).toBe("tu_1");
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toBe(
      "Tool call not executed: provider error: upstream exploded",
    );
  });

  it("pairs tool_use blocks when the stream truncates before turn_complete", async () => {
    const script: StreamEvent[] = [
      { type: "tool_use_start", id: "tu_t", name: "bash" },
      { type: "tool_use_end", id: "tu_t", input: { command: "ls" } },
      { type: "usage", usage: usage(10, 5) },
      // no turn_complete and no error: the stream just ends (torn transport)
    ];
    const { result } = await runScripted([script]);

    expect(result.stopReason).toBe("provider_error");
    expect(result.error?.code).toBe("truncated_stream");
    const block = asToolResult(result.messages[2]);
    expect(block?.toolUseId).toBe("tu_t");
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain("Tool call not executed:");
    expect(block?.content[0]?.text).toContain("without turn_complete");
  });

  it("pairs tool_use blocks when the model stops with a terminal reason after tool calls", async () => {
    const script: StreamEvent[] = [
      { type: "tool_use_start", id: "tu_x", name: "bash" },
      { type: "tool_use_end", id: "tu_x", input: {} },
      { type: "usage", usage: usage(1, 1) },
      { type: "turn_complete", stopReason: "max_tokens" },
    ];
    const { result } = await runScripted([script]);

    expect(result.stopReason).toBe("max_tokens");
    const block = asToolResult(result.messages[2]);
    expect(block?.toolUseId).toBe("tu_x");
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain('model stopped with reason "max_tokens"');
  });

  it("keeps failed-round transcripts provider-valid through the anthropic request mapper", async () => {
    // Error after tool_use, engine-side pairing, then prove the folded
    // transcript maps to Anthropic wire messages where every tool_use has
    // its tool_result — the exact replay shape Anthropic 400s when broken.
    const script: StreamEvent[] = [
      { type: "tool_use_start", id: "tu_v", name: "bash" },
      { type: "tool_use_end", id: "tu_v", input: { command: "ls" } },
      { type: "error", error: { message: "torn", retryable: false, code: "protocol" } },
    ];
    const { result } = await runScripted([script]);

    const { createAnthropicProvider } = await import("../providers/anthropic");
    const bodies: unknown[] = [];
    const provider = createAnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        const raw = typeof init.body === "string" ? init.body : "";
        bodies.push(raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined);
        return new Response(null, { status: 500 });
      },
    });
    // Drain the stream; only the request mapping matters here.
    for await (const _event of provider.stream({
      model: "anthropic/claude-sonnet-4-5",
      messages: result.messages,
    })) {
      // consume
    }

    const wire = bodies[0] as { messages: { role: string; content: { type: string }[] }[] };
    expect(wire.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const assistantBlocks = wire.messages[1]?.content ?? [];
    const resultBlocks = wire.messages[2]?.content ?? [];
    expect(assistantBlocks.some((block) => block.type === "tool_use")).toBe(true);
    const resultBlock = resultBlocks.find((block) => block.type === "tool_result");
    expect(resultBlock).toBeDefined();
  });

  it("converts a throwing provider stream into a provider error", async () => {
    const provider = new ThrowingProvider();
    const result = await runConversation({
      provider,
      model: "mock/test-model",
      registry: createToolRegistry(),
      messages: [userTurn("hi")],
    });

    expect(result.stopReason).toBe("provider_error");
    expect(result.error?.message).toContain("socket hung up");
    expect(result.rounds).toBe(1);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "starting" }],
    });
  });

  it("stops at maxToolRounds and skips the queued calls", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const { result, events } = await runScripted(
      [
        toolUseRound({ id: "t1", name: "bash", input: { n: 1 } }, usage(10, 1)),
        toolUseRound({ id: "t2", name: "bash", input: { n: 2 } }, usage(10, 1)),
        toolUseRound({ id: "t3", name: "bash", input: { n: 3 } }, usage(10, 1)),
        textRound("done"),
      ],
      [bash],
      { maxToolRounds: 2 },
    );

    expect(result.stopReason).toBe("max_tool_rounds");
    expect(result.rounds).toBe(3); // two tool rounds ran; the third was refused
    expect(calls.map((call) => call.input)).toEqual([{ n: 1 }, { n: 2 }]);

    const last = result.messages.at(-1);
    expect(last?.role).toBe("user");
    const block = asToolResult(last);
    expect(block?.toolUseId).toBe("t3");
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain("max tool rounds (2) reached");

    expect(events.at(-1)).toMatchObject({ type: "engine_stopped", reason: "max_tool_rounds" });
    const stopped = events.at(-1);
    if (stopped?.type === "engine_stopped") {
      expect(stopped.message).toContain("2 tool rounds");
    }
  });

  it("stops when the token budget is exceeded", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const { result, events } = await runScripted(
      [
        toolUseRound({ id: "t1", name: "bash", input: { n: 1 } }, usage(20, 5)), // total 25 ≤ 30
        toolUseRound({ id: "t2", name: "bash", input: { n: 2 } }, usage(8, 2)), // total 35 > 30
      ],
      [bash],
      { stopBudget: 30 },
    );

    expect(result.stopReason).toBe("budget_exceeded");
    expect(result.rounds).toBe(2);
    expect(calls.map((call) => call.input)).toEqual([{ n: 1 }]); // second round skipped
    expect(result.totalUsage).toStrictEqual({ inputTokens: 28, outputTokens: 7 });

    const block = asToolResult(result.messages.at(-1));
    expect(block?.toolUseId).toBe("t2");
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain("token budget of 30 exceeded");

    expect(events.at(-1)).toMatchObject({ type: "engine_stopped", reason: "budget_exceeded" });
    const stopped = events.at(-1);
    if (stopped?.type === "engine_stopped") {
      expect(stopped.message).toContain("35 tokens");
    }
  });

  it("aggregates usage across rounds including cache fields", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const { result, events } = await runScripted(
      [
        toolUseRound({ id: "t1", name: "bash", input: {} }, cachedUsage(10, 5, 2, 1)),
        textRound("done", cachedUsage(20, 7, 4, 0)),
      ],
      [bash],
    );

    expect(result.totalUsage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 6,
      cacheCreationTokens: 1,
    });
    const finished = events.filter((event) => event.type === "turn_finished");
    expect(finished.at(-1)).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 12, cacheReadTokens: 6, cacheCreationTokens: 1 },
    });
  });

  it("turns an unexpected tool throw into an error result and continues", async () => {
    const boom = throwingTool("bash");
    const { result, provider, events } = await runScripted(
      [
        toolUseRound({ id: "t1", name: "bash", input: { command: "oops" } }, usage(10, 5)),
        textRound("recovered", usage(10, 5)),
      ],
      [boom],
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.rounds).toBe(2);

    const block = asToolResult(result.messages[2]);
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain("boom: tool bug");

    // The provider saw the error result in round 2's history.
    expect(asToolResult(provider.requests[1]?.messages[2])?.isError).toBe(true);

    const finished = events.find((event) => event.type === "tool_call_finished");
    if (finished?.type === "tool_call_finished") {
      expect(finished.name).toBe("bash");
      expect(finished.resultSummary).toContain("boom: tool bug");
      expect(finished.isError).toBe(true); // error result flagged error
    }
  });

  it("reports unknown tools as error results and continues", async () => {
    const { result } = await runScripted([
      toolUseRound({ id: "t1", name: "teleport", input: { where: "moon" } }, usage(10, 5)),
      textRound("fine", usage(10, 5)),
    ]);

    expect(result.stopReason).toBe("end_turn");
    const block = asToolResult(result.messages[2]);
    expect(block?.isError).toBe(true);
    expect(block?.content[0]?.text).toContain('unknown tool "teleport"');
  });

  it("does not append an empty assistant message", async () => {
    const { result } = await runScripted([
      [
        { type: "usage", usage: usage(3, 1) },
        { type: "turn_complete", stopReason: "end_turn" },
      ],
    ]);

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages).toHaveLength(1);
    expect(result.totalUsage).toStrictEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("flags a tool_use stop with no complete tool calls", async () => {
    const script: StreamEvent[] = [
      { type: "tool_use_end", id: "orphan", input: { a: 1 } }, // no matching start → dropped
      { type: "usage", usage: usage(1, 1) },
      { type: "turn_complete", stopReason: "tool_use" },
    ];
    const { result } = await runScripted([script]);

    expect(result.stopReason).toBe("provider_error");
    expect(result.error?.message).toContain("no complete tool calls");
    expect(result.messages).toHaveLength(1);
  });

  it("recovers an orphan tool_use_end that carries the tool name (contracts gap #3)", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const script: StreamEvent[] = [
      { type: "tool_use_end", id: "tu_orphan", name: "bash", input: { command: "ls" } }, // no start
      { type: "usage", usage: usage(10, 5) },
      { type: "turn_complete", stopReason: "tool_use" },
    ];
    const { result } = await runScripted([script, textRound("recovered", usage(10, 5))], [bash]);

    expect(result.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ command: "ls" });
    expect(result.messages[1]?.content).toContainEqual({
      type: "tool_use",
      id: "tu_orphan",
      name: "bash",
      input: { command: "ls" },
    });
    expect(asToolResult(result.messages[2])?.toolUseId).toBe("tu_orphan");
  });

  it("populates ToolResultBlock.error from the tool's structured error (contracts gap #2)", async () => {
    const calls: RecordedCall[] = [];
    const failing = recordingTool("bash", calls, {
      content: [{ type: "text", text: "command timed out" }],
      isError: true,
      error: {
        code: "timeout",
        message: "command timed out after 30000ms",
        retryable: true,
        details: { timedOut: true },
      },
    });
    const { result, provider } = await runScripted(
      [
        toolUseRound({ id: "tu_1", name: "bash", input: { command: "sleep 60" } }, usage(10, 5)),
        textRound("noted the failure", usage(10, 5)),
      ],
      [failing],
    );

    const block = asToolResult(result.messages[2]);
    expect(block?.isError).toBe(true);
    expect(block?.error).toEqual({
      code: "timeout",
      message: "command timed out after 30000ms",
      retryable: true,
      details: { timedOut: true },
    });
    // The structured error reaches the next provider request verbatim.
    expect(asToolResult(provider.requests[1]?.messages[2])?.error?.code).toBe("timeout");

    // Successful results still carry no error field.
    const ok = recordingTool("read_file", [], {
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const second = await runScripted(
      [
        toolUseRound({ id: "tu_2", name: "read_file", input: {} }, usage(10, 5)),
        textRound("done", usage(10, 5)),
      ],
      [ok],
    );
    expect(asToolResult(second.result.messages[2])?.error).toBeUndefined();
  });

  it("treats an unknown (pass-through) stop reason as a terminal end (contracts gap #7)", async () => {
    const script: StreamEvent[] = [
      { type: "text_delta", text: "declining this one" },
      { type: "usage", usage: usage(10, 5) },
      { type: "turn_complete", stopReason: "refusal" },
    ];
    const calls: RecordedCall[] = [];
    const { result, events } = await runScripted(
      [script, textRound("never", usage(1, 1))],
      [recordingTool("bash", calls)],
    );

    expect(result.stopReason).toBe("refusal");
    expect(result.rounds).toBe(1); // terminal: no second provider round
    expect(calls).toHaveLength(0); // nothing dispatched, no guards fired
    expect(result.error).toBeUndefined();
    expect(
      events.some((event) => event.type === "turn_finished" && event.stopReason === "refusal"),
    ).toBe(true);
    const stopped = events.at(-1);
    expect(stopped).toMatchObject({ type: "engine_stopped", reason: "refusal" });
    if (stopped?.type === "engine_stopped") {
      expect(stopped.message).toBeUndefined(); // natural stop: the reason says it all
    }
  });
});

// ---------------------------------------------------------------------------
// runTurn
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  it("executes exactly one round including its tool calls", async () => {
    const calls: RecordedCall[] = [];
    const bash = recordingTool("bash", calls);
    const provider = new ScriptedProvider([
      toolUseRound({ id: "t1", name: "bash", input: { command: "ls" } }, usage(9, 4)),
      textRound("never reached"),
    ]);
    const events: EngineEvent[] = [];
    const turn = await runTurn({
      provider,
      model: "mock/test-model",
      registry: createToolRegistry([bash]),
      system: "You are Void.",
      messages: [userTurn("go")],
      config: { onEvent: (event) => events.push(event) },
    });

    expect(turn.stopReason).toBe("tool_use"); // the conversation may continue
    expect(turn.executedToolCalls).toBe(1);
    expect(turn.messages).toHaveLength(3); // user + assistant + tool results
    expect(turn.usage).toStrictEqual({ inputTokens: 9, outputTokens: 4 });
    expect(provider.requests).toHaveLength(1); // exactly one provider call
    expect(events.map((event) => event.type)).not.toContain("engine_stopped");
    expect(asToolResult(turn.messages.at(-1))?.toolUseId).toBe("t1");
  });

  it("surfaces provider errors without dispatching tools", async () => {
    const provider = new ScriptedProvider([
      [{ type: "error", error: { message: "bad key", retryable: false, code: "auth" } }],
    ]);
    const turn = await runTurn({
      provider,
      model: "mock/test-model",
      registry: createToolRegistry(),
      messages: [userTurn("go")],
    });

    expect(turn.stopReason).toBe("provider_error");
    expect(turn.error?.code).toBe("auth");
    expect(turn.executedToolCalls).toBe(0);
    expect(turn.messages).toHaveLength(1);
  });

  it("pairs tool_use blocks with error results on a failed single turn", async () => {
    const calls: RecordedCall[] = [];
    const provider = new ScriptedProvider([
      [
        { type: "tool_use_start", id: "tu_r", name: "bash" },
        { type: "tool_use_end", id: "tu_r", input: { command: "ls" } },
        { type: "error", error: { message: "boom", retryable: false, code: "server" } },
      ],
    ]);
    const turn = await runTurn({
      provider,
      model: "mock/test-model",
      registry: createToolRegistry([recordingTool("bash", calls)]),
      messages: [userTurn("go")],
    });

    expect(turn.stopReason).toBe("provider_error");
    expect(turn.executedToolCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(turn.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(asToolResult(turn.messages.at(-1))?.toolUseId).toBe("tu_r");
    expect(asToolResult(turn.messages.at(-1))?.isError).toBe(true);
  });
});
