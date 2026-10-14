/**
 * Unit tests for the Anthropic provider adapter. Every "HTTP" interaction is
 * a scripted fake: `fetchImpl` returns `Response`s built from synthetic SSE
 * strings, so these tests never touch the network. Env vars are sanitized
 * around each test so the developer machine cannot leak a real key in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatRequest,
  GenerationParams,
  Provider,
  ProviderCallError,
  StreamEvent,
} from "../contracts/provider";
import type { ToolSpec } from "../contracts/tools";
import { AnthropicCallError, createAnthropicProvider, type FetchLike } from "./anthropic";

// ---------------------------------------------------------------------------
// Scripted-SSE helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Build a Response whose body enqueues the SSE text in fixed-size chunks. */
function sseResponse(frames: string, status = 200, chunkSize?: number): Response {
  const chunks =
    chunkSize === undefined
      ? [frames]
      : (frames.match(new RegExp(`.{1,${chunkSize}}`, "gs")) ?? [""]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** A fetch fake that records calls and always returns the given Response factory. */
function fakeFetch(makeResponse: () => Response): {
  impl: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(makeResponse());
  };
  return { impl, calls };
}

function sentBody(calls: { init: RequestInit }[]): Record<string, unknown> {
  const raw = calls.at(-1)?.init.body;
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

function sentHeaders(calls: { init: RequestInit }[]): Record<string, string> {
  const headers = calls.at(-1)?.init.headers;
  expect(typeof headers).toBe("object");
  return headers as Record<string, string>;
}

async function collect(provider: Provider, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    events.push(event);
  }
  return events;
}

function makeRequest(overrides?: {
  model?: string;
  system?: string;
  messages?: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  params?: GenerationParams;
}): ChatRequest {
  const o = overrides ?? {};
  return {
    model: o.model ?? "anthropic/claude-sonnet-4-5",
    messages: o.messages ?? [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(o.system !== undefined ? { system: o.system } : {}),
    ...(o.tools !== undefined ? { tools: o.tools } : {}),
    ...(o.params !== undefined ? { params: o.params } : {}),
  };
}

function makeToolSpec(name: string): ToolSpec {
  return {
    name,
    description: `Test tool ${name}.`,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "Command to run." } },
      required: ["command"],
    },
    source: "builtin",
    async execute() {
      return { content: [], isError: false };
    },
  };
}

/** Narrow an unknown thrown value to the contract's ProviderCallError shape. */
function asProviderCallError(value: unknown): ProviderCallError {
  if (
    value instanceof Error &&
    typeof (value as ProviderCallError).providerError === "object" &&
    (value as ProviderCallError).providerError !== null
  ) {
    return value as ProviderCallError;
  }
  throw new Error(`expected a ProviderCallError, got ${String(value)}`);
}

// Scripted streams (real Messages API event shapes).

const TEXT_TURN = [
  frame("message_start", {
    type: "message_start",
    message: { id: "msg_1", role: "assistant", usage: { input_tokens: 25, output_tokens: 1 } },
  }),
  frame("ping", { type: "ping" }),
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " there" },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  }),
  frame("message_stop", { type: "message_stop" }),
].join("");

const TOOL_TURN = [
  frame("message_start", {
    type: "message_start",
    message: { usage: { input_tokens: 40, output_tokens: 1 } },
  }),
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Running " },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_01", name: "bash", input: {} },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "" },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"comm' },
  }),
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'and": "ls"}' },
  }),
  frame("content_block_stop", { type: "content_block_stop", index: 1 }),
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 12 },
  }),
  frame("message_stop", { type: "message_stop" }),
].join("");

// Env sanitization: the API key resolution reads process.env at construction.

const ENV_KEYS = ["VOID_ANTHROPIC_KEY", "ANTHROPIC_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  savedEnv = {};
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicProvider.stream", () => {
  it("streams a text-only turn end to end", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "test-key", fetchImpl: impl });

    const events = await collect(provider, makeRequest({ system: "You are Void." }));

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " there" },
      { type: "usage", usage: { inputTokens: 25, outputTokens: 7 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = sentHeaders(calls);
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    const body = sentBody(calls);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
    expect(body.system).toBe("You are Void.");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("produces identical events when the SSE body arrives in tiny chunks", async () => {
    const whole = await collect(
      createAnthropicProvider({
        apiKey: "k",
        fetchImpl: fakeFetch(() => sseResponse(TOOL_TURN)).impl,
      }),
      makeRequest(),
    );
    const split = await collect(
      createAnthropicProvider({
        apiKey: "k",
        fetchImpl: fakeFetch(() => sseResponse(TOOL_TURN, 200, 5)).impl,
      }),
      makeRequest(),
    );
    expect(split).toEqual(whole);
  });

  it("strips the anthropic/ ModelRef prefix and passes bare model ids through", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    await collect(provider, makeRequest({ model: "anthropic/claude-opus-4-5" }));
    expect(sentBody(calls).model).toBe("claude-opus-4-5");

    await collect(provider, makeRequest({ model: "claude-3-5-haiku-latest" }));
    expect(sentBody(calls).model).toBe("claude-3-5-haiku-latest");
  });

  it("honors generation params (max tokens, temperature, top_p, stop sequences)", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    await collect(
      provider,
      makeRequest({
        params: {
          maxOutputTokens: 1234,
          temperature: 0.2,
          topP: 0.9,
          stopSequences: ["\n\nHuman:"],
        },
      }),
    );

    const body = sentBody(calls);
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(["\n\nHuman:"]);
  });

  it("maps ToolSpecs to the wire tools format", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    await collect(provider, makeRequest({ tools: [makeToolSpec("bash")] }));

    expect(sentBody(calls).tools).toEqual([
      {
        name: "bash",
        description: "Test tool bash.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string", description: "Command to run." } },
          required: ["command"],
        },
      },
    ]);
  });

  it("maps prior assistant tool_use and user tool_result messages", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    await collect(
      provider,
      makeRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "run ls" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "on it" },
              { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "toolu_01",
                content: [{ type: "text", text: "src docs", truncated: false }],
                isError: false,
              },
            ],
          },
        ],
      }),
    );

    expect(sentBody(calls).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "run ls" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: [{ type: "text", text: "src docs" }],
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("streams tool_use with split partial_json deltas and parsed input at end", async () => {
    const { impl } = fakeFetch(() => sseResponse(TOOL_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "Running " },
      { type: "tool_use_start", id: "toolu_01", name: "bash" },
      { type: "tool_use_delta", id: "toolu_01", inputDelta: "" },
      { type: "tool_use_delta", id: "toolu_01", inputDelta: '{"comm' },
      { type: "tool_use_delta", id: "toolu_01", inputDelta: 'and": "ls"}' },
      { type: "tool_use_end", id: "toolu_01", name: "bash", input: { command: "ls" } },
      { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
      { type: "turn_complete", stopReason: "tool_use" },
    ]);
  });

  it("maps max_tokens and stop_sequence stop reasons", async () => {
    const stopReasonTurn = (reason: string): string =>
      [
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "cut " },
        }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "###" : null },
          usage: { output_tokens: 2 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ].join("");

    for (const reason of ["max_tokens", "stop_sequence", "end_turn"] as const) {
      const { impl } = fakeFetch(() => sseResponse(stopReasonTurn(reason)));
      const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });
      const events = await collect(provider, makeRequest());
      expect(events.at(-1)).toEqual({ type: "turn_complete", stopReason: reason });
    }
  });

  it("passes unknown vendor stop reasons through verbatim (no end_turn degradation)", async () => {
    const scripted = [
      frame("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 5 } },
      }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events.at(-1)).toEqual({ type: "turn_complete", stopReason: "refusal" });
  });

  it("emits cache token usage and revised input counts (last seen wins)", async () => {
    const scripted = [
      frame("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 25,
            output_tokens: 1,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        },
      }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 30, output_tokens: 9 },
      }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 30,
          outputTokens: 9,
          cacheReadTokens: 5,
          cacheCreationTokens: 3,
        },
      },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("maps mid-stream error frames (overloaded) to a single retryable error", async () => {
    const scripted = [
      frame("message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
      frame("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
      frame("message_stop", { type: "message_stop" }), // must NOT produce turn_complete
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "error",
        error: { message: "Anthropic stream error: Overloaded", retryable: true, code: "overload" },
      },
    ]);
  });

  it("maps HTTP 401 to a non-retryable auth error with the body detail", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
          { status: 401 },
        ),
    );
    const provider = createAnthropicProvider({ apiKey: "bad", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: "Anthropic API returned HTTP 401: invalid x-api-key",
          retryable: false,
          code: "auth",
        },
      },
    ]);
  });

  it("maps HTTP 429, 529 and 500 to retryable errors", async () => {
    const cases: { status: number; code: string }[] = [
      { status: 429, code: "rate_limit" },
      { status: 529, code: "overload" },
      { status: 500, code: "server" },
    ];
    for (const { status, code } of cases) {
      const { impl } = fakeFetch(() => new Response("nope", { status }));
      const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });
      const events = await collect(provider, makeRequest());
      expect(events).toEqual([
        {
          type: "error",
          error: {
            message: `Anthropic API returned HTTP ${status}: nope`,
            retryable: true,
            code,
          },
        },
      ]);
    }
  });

  it("maps HTTP 400 to a non-retryable request error", async () => {
    const { impl } = fakeFetch(() => new Response("bad request", { status: 400 }));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.retryable).toBe(false);
      expect(events[0].error.code).toBe("request");
    }
  });

  it("maps thrown fetch (network failure/abort) to a retryable network error", async () => {
    const impl: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: { message: "fetch failed", retryable: true, code: "network" },
      },
    ]);
  });

  it("maps a body read failure mid-stream to a retryable network error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("message_start", { type: "message_start" })));
        controller.error(new TypeError("connection reset"));
      },
    });
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: { message: "connection reset", retryable: true, code: "network" },
      },
    ]);
  });

  it("reports a missing API key as a non-retryable auth error without calling fetch", async () => {
    let called = false;
    const impl: FetchLike = () => {
      called = true;
      return Promise.reject(new Error("fetch must not be called"));
    };
    const provider = createAnthropicProvider({ fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(called).toBe(false);
    expect(events).toHaveLength(1);
    if (events[0]?.type === "error") {
      expect(events[0].error.code).toBe("auth");
      expect(events[0].error.retryable).toBe(false);
      expect(events[0].error.message).toMatch(/API key/);
    }
  });

  it("resolves the API key from VOID_ANTHROPIC_KEY, then ANTHROPIC_API_KEY, with opts first", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));

    process.env.VOID_ANTHROPIC_KEY = "env-primary";
    process.env.ANTHROPIC_API_KEY = "env-secondary";
    await collect(createAnthropicProvider({ fetchImpl: impl }), makeRequest());
    expect(sentHeaders(calls)["x-api-key"]).toBe("env-primary");

    delete process.env.VOID_ANTHROPIC_KEY;
    await collect(createAnthropicProvider({ fetchImpl: impl }), makeRequest());
    expect(sentHeaders(calls)["x-api-key"]).toBe("env-secondary");

    process.env.VOID_ANTHROPIC_KEY = "env-primary";
    await collect(createAnthropicProvider({ apiKey: "opts-key", fetchImpl: impl }), makeRequest());
    expect(sentHeaders(calls)["x-api-key"]).toBe("opts-key");
  });

  it("reports a protocol error for malformed accumulated tool JSON", async () => {
    const scripted = [
      frame("message_start", { type: "message_start" }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bad", name: "bash", input: {} },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"comm' },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_stop", { type: "message_stop" }), // must NOT produce turn_complete
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "tool_use_start", id: "toolu_bad", name: "bash" },
      { type: "tool_use_delta", id: "toolu_bad", inputDelta: '{"comm' },
      {
        type: "error",
        error: {
          message: "tool_use block toolu_bad streamed malformed JSON input",
          retryable: false,
          code: "protocol",
        },
      },
    ]);
  });

  it("reports a protocol error when the stream ends before message_stop", async () => {
    const scripted = [
      frame("message_start", { type: "message_start" }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "truncated" },
      }),
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "truncated" },
      {
        type: "error",
        error: { message: "stream ended before message_stop", retryable: false, code: "protocol" },
      },
    ]);
  });

  it("reports a protocol error when the stream ends inside a tool_use block (orphan start)", async () => {
    // content_block_start(tool_use) arrives, then the stream dies before the
    // block's content_block_stop: loud, never a silent drop.
    const scripted = [
      frame("message_start", { type: "message_start" }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_cut", name: "bash", input: {} },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"comm' },
      }),
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "tool_use_start", id: "toolu_cut", name: "bash" },
      { type: "tool_use_delta", id: "toolu_cut", inputDelta: '{"comm' },
      {
        type: "error",
        error: {
          message: expect.stringContaining("stream ended inside a tool_use block"),
          retryable: false,
          code: "protocol",
        },
      },
    ]);
    if (events[2]?.type === "error") {
      expect(events[2].error.message).toContain("toolu_cut");
    }
  });

  it("caps embedded error response bodies at ~2 KiB with an explicit marker", async () => {
    const hugeDetail = "x".repeat(5000);
    const { impl } = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: hugeDetail } }), { status: 500 }),
    );
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toHaveLength(1);
    if (events[0]?.type === "error") {
      const message = events[0].error.message;
      expect(message.startsWith(`Anthropic API returned HTTP 500: ${"x".repeat(2048)}`)).toBe(true);
      expect(message.endsWith("…[truncated, 5000 chars]")).toBe(true);
      expect(message).not.toContain("x".repeat(2049)); // the tail was dropped, not kept
    }
  });

  it("skips unknown/extended event types (thinking deltas, signatures, pings)", async () => {
    const scripted = [
      frame("message_start", { type: "message_start" }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "internal" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");
    const { impl } = fakeFetch(() => sseResponse(scripted));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "answer" },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("honors a baseURL override (proxies, wave-2 integration harness)", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({
      apiKey: "k",
      baseURL: "http://127.0.0.1:9999/base/",
      fetchImpl: impl,
    });

    await collect(provider, makeRequest());

    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/base/v1/messages");
  });

  it("tolerates a baseURL that already ends in /v1 (no /v1/v1 doubling)", async () => {
    const { impl, calls } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({
      apiKey: "k",
      baseURL: "https://api.z.ai/anthropic/v1/",
      fetchImpl: impl,
    });

    await collect(provider, makeRequest());

    expect(calls[0]?.url).toBe("https://api.z.ai/anthropic/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// Request deadline (timeoutMs)
// ---------------------------------------------------------------------------

/**
 * A fetch that never resolves on its own and only rejects when the request's
 * abort signal fires (with the signal's own reason, like a real fetch). Used
 * with real timers + a 50ms deadline: the stream must END, not hang.
 */
function stalledFetch(): FetchLike {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal ?? null;
      if (signal === null) return; // no signal: stall forever (test bug)
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

/** A 200 response whose body never yields a byte and errors when the signal fires. */
function stalledBodyFetch(): FetchLike {
  return (_url, init) => {
    const signal = init.signal ?? null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = (): void => controller.error(signal?.reason);
        if (signal === null) return;
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  };
}

describe("AnthropicProvider request deadline", () => {
  it("attaches an abort signal to the fetch init", async () => {
    const inits: RequestInit[] = [];
    const impl: FetchLike = (_url, init) => {
      inits.push(init);
      return Promise.resolve(sseResponse(TEXT_TURN));
    };
    const provider = createAnthropicProvider({
      apiKey: "k",
      fetchImpl: impl,
      timeoutMs: 60_000,
    });
    await collect(provider, makeRequest());
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ends a never-resolving fetch with a retryable timeout error (real timers)", async () => {
    const provider = createAnthropicProvider({
      apiKey: "k",
      fetchImpl: stalledFetch(),
      timeoutMs: 50,
    });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: expect.stringContaining("timed out after 50ms"),
          retryable: true,
          code: "timeout",
        },
      },
    ]);
  });

  it("ends a stalled SSE body with a retryable timeout error (real timers)", async () => {
    const provider = createAnthropicProvider({
      apiKey: "k",
      fetchImpl: stalledBodyFetch(),
      timeoutMs: 50,
    });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: expect.stringContaining("timed out after 50ms"),
          retryable: true,
          code: "timeout",
        },
      },
    ]);
  });
});

describe("AnthropicProvider.complete", () => {
  it("aggregates text and tool_use blocks into a ChatCompletion", async () => {
    const { impl } = fakeFetch(() => sseResponse(TOOL_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const completion = await provider.complete(makeRequest());

    expect(completion).toEqual({
      content: [
        { type: "text", text: "Running " },
        { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
      ],
      usage: { inputTokens: 40, outputTokens: 12 },
      stopReason: "tool_use",
    });
  });

  it("merges consecutive text deltas into one text block", async () => {
    const { impl } = fakeFetch(() => sseResponse(TEXT_TURN));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const completion = await provider.complete(makeRequest());

    expect(completion.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(completion.stopReason).toBe("end_turn");
  });

  it("throws AnthropicCallError carrying the structured ProviderError", async () => {
    const { impl } = fakeFetch(() => new Response("boom", { status: 500 }));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const failure = await provider.complete(makeRequest()).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(AnthropicCallError);
    if (failure instanceof AnthropicCallError) {
      expect(failure.providerError).toEqual({
        message: "Anthropic API returned HTTP 500: boom",
        retryable: true,
        code: "server",
      });
      expect(failure.message).toBe(failure.providerError.message);
    }
  });

  it("satisfies the contract's ProviderCallError shape (structural narrowing)", async () => {
    const { impl } = fakeFetch(() => new Response("denied", { status: 401 }));
    const provider = createAnthropicProvider({ apiKey: "k", fetchImpl: impl });

    const failure = await provider.complete(makeRequest()).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    // The contract says: narrow on the providerError property, not instanceof.
    const callError = asProviderCallError(failure);
    expect(callError).toBeInstanceOf(Error);
    expect(callError.providerError).toEqual({
      message: "Anthropic API returned HTTP 401: denied",
      retryable: false,
      code: "auth",
    });
    expect(callError.message).toBe(callError.providerError.message);
  });
});
