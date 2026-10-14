/**
 * Tests for the shared OpenAI-wire core (src/providers/openai-compat.ts) —
 * the logic extracted from the Ollama adapter in roadmap workstream 5 P1.
 *
 * Drives {@link OpenAiCompatClient} directly with a synthetic provider label
 * ("testwire") and model prefix ("tw/") so the parameterization itself is
 * pinned: error messages carry the label, the prefix is stripped, extra
 * headers ride along. Fully offline like every provider suite: scripted SSE
 * bodies through a fake fetch, streamed through a real ReadableStream in
 * small chunks so the incremental parser (chunk-split events, \r\n endings)
 * runs on the public API.
 *
 * Regression note: the ollama adapter's own suite (ollama.test.ts, 34 tests)
 * passes UNMODIFIED over the same core through its wrapper — that is the
 * proof the extraction changed nothing for Ollama; this file pins the core's
 * generalized behaviors (label/prefix/headers/factory), the review-fix
 * semantics (loud EOF, loud error frames), and the HTTP error taxonomy
 * including the 401/403 → auth mapping the generic provider relies on.
 */
import { describe, expect, it } from "vitest";
import type {
  ChatRequest,
  ProviderCallError,
  ProviderError,
  StopReason,
  StreamEvent,
} from "../contracts/provider";
import type { ToolSpec } from "../contracts/tools";
import type { FetchLike } from "./openai-compat";
import { normalizeBaseUrl, OpenAiCompatClient, stripModelPrefix } from "./openai-compat";

// ---------------------------------------------------------------------------
// Test harness: a synthetic "testwire" adapter over the shared core
// ---------------------------------------------------------------------------

const LABEL = "testwire";
const PREFIX = "tw/";
const ENDPOINT = "http://wire.test/v1/chat/completions";

/** The factory-built error complete() throws in these tests. */
class TestWireError extends Error implements ProviderCallError {
  readonly providerError: ProviderError;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = "TestWireError";
    this.providerError = error;
  }
}

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  readonly body: unknown;
}

function recordingFetch(respond: (request: CapturedRequest) => Response | Promise<Response>): {
  fetch: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = raw;
    try {
      body = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const headers =
      init?.headers !== undefined && typeof init.headers === "object"
        ? (init.headers as Record<string, string>)
        : undefined;
    const captured: CapturedRequest = { url, headers, body };
    requests.push(captured);
    return respond(captured);
  };
  return { fetch: impl, requests };
}

function streamResponse(raw: string, chunkSize = 4096): Response {
  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= raw.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(raw.slice(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseResponse(events: readonly string[], chunkSize?: number): Response {
  return streamResponse(events.map((event) => `${event}\n\n`).join(""), chunkSize);
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

const DONE = "data: [DONE]";

function textChunk(content: string): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

function finishChunk(finishReason: string, usage?: unknown): unknown {
  return {
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function toolCallChunk(toolCall: unknown, finishReason: string | null = null): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [toolCall] },
        ...(finishReason === null ? {} : { finish_reason: finishReason }),
      },
    ],
  };
}

function makeClient(options: {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly modelPrefix?: string;
  readonly endpoint?: string;
}): OpenAiCompatClient {
  return new OpenAiCompatClient({
    providerId: LABEL,
    endpoint: options.endpoint ?? ENDPOINT,
    modelPrefix: options.modelPrefix ?? PREFIX,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    makeCallError: (error) => new TestWireError(error),
  });
}

async function collect(client: OpenAiCompatClient, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.stream(request)) {
    events.push(event);
  }
  return events;
}

function wireBody(request: CapturedRequest | undefined): Record<string, unknown> {
  if (request === undefined || typeof request.body !== "object" || request.body === null) {
    throw new Error("captured request body is not an object");
  }
  return request.body as Record<string, unknown>;
}

const bashTool: ToolSpec = {
  name: "bash",
  description: "Run a shell command.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  source: "builtin",
  execute: async () => ({ content: [], isError: false }),
};

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: "tw/model-x",
    system: "You are Void.",
    messages: [{ role: "user", content: [{ type: "text", text: "list the files" }] }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

describe("openai-compat config helpers", () => {
  it("normalizeBaseUrl: strips trailing slashes and appends /v1 only when missing", () => {
    expect(normalizeBaseUrl("http://h:11434")).toBe("http://h:11434/v1");
    expect(normalizeBaseUrl("http://h:11434/")).toBe("http://h:11434/v1");
    expect(normalizeBaseUrl("http://h:11434/v1")).toBe("http://h:11434/v1");
    expect(normalizeBaseUrl("http://h:11434/v1/")).toBe("http://h:11434/v1");
    expect(normalizeBaseUrl("  https://api.openai.com/v1  ")).toBe("https://api.openai.com/v1");
  });

  it("normalizeBaseUrl: service paths already ending in /v1 pass through verbatim", () => {
    // OpenRouter and Groq mount the OpenAI API under a deeper path — the
    // suffix check must not double-append.
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("https://api.groq.com/openai/v1/")).toBe(
      "https://api.groq.com/openai/v1",
    );
  });

  it("stripModelPrefix: strips the adapter prefix, passes bare ids through", () => {
    expect(stripModelPrefix("tw/model-x", PREFIX)).toBe("model-x");
    expect(stripModelPrefix("qwen3:4b", PREFIX)).toBe("qwen3:4b");
    expect(stripModelPrefix("any/id", "")).toBe("any/id");
  });
});

// ---------------------------------------------------------------------------
// Request mapping (contracts -> wire)
// ---------------------------------------------------------------------------

describe("openai-compat request mapping", () => {
  it("maps a full request: model prefix stripped, system message, tools, params", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(makeClient({ fetchImpl: fetch }), {
      model: "tw/model-x",
      system: "You are Void.",
      messages: [{ role: "user", content: [{ type: "text", text: "run ls" }] }],
      tools: [bashTool],
      params: { temperature: 0.2, maxOutputTokens: 512, stopSequences: ["END"] },
    });

    expect(requests[0]?.url).toBe(ENDPOINT);
    const body = wireBody(requests[0]);
    expect(body.model).toBe("model-x");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are Void." },
      { role: "user", content: "run ls" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command.",
          parameters: bashTool.inputSchema,
        },
      },
    ]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
    expect(body.stop).toEqual(["END"]);
  });

  it("maps history: assistant text+tool_use and user tool_result blocks", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(
      makeClient({ fetchImpl: fetch }),
      makeRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "run ls" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "On it." },
              { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: [
                  { type: "text", text: "file-a" },
                  { type: "text", text: "file-b" },
                ],
                isError: false,
              },
            ],
          },
        ],
      }),
    );

    expect(wireBody(requests[0]).messages).toEqual([
      { role: "system", content: "You are Void." },
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        content: "On it.",
        tool_calls: [
          {
            id: "tu_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "tu_1", content: "file-a\nfile-b" },
    ]);
  });

  it("maps a tool-only assistant message to null content with tool_calls", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(
      makeClient({ fetchImpl: fetch }),
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_9", name: "read_file", input: { path: "/x" } }],
          },
        ],
      }),
    );

    expect(wireBody(requests[0]).messages).toEqual([
      { role: "system", content: "You are Void." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tu_9",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/x"}' },
          },
        ],
      },
    ]);
  });

  it("merges adapter headers into the fixed content-type/accept pair", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(
      makeClient({
        fetchImpl: fetch,
        headers: { authorization: "Bearer sk-test", "x-custom": "1" },
      }),
      makeRequest(),
    );

    expect(requests[0]?.headers).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer sk-test",
      "x-custom": "1",
    });
  });
});

// ---------------------------------------------------------------------------
// Chunk mapping and tool-call accumulation
// ---------------------------------------------------------------------------

describe("openai-compat chunk mapping", () => {
  it("streams a text turn into contracts events with usage and stop mapping", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(textChunk("Hello")),
        data(textChunk(" world")),
        data(finishChunk("stop", { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })),
        DONE,
      ]),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 4 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("accumulates fragmented tool arguments and parses them once at the end", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: "" },
          }),
        ),
        data(toolCallChunk({ index: 0, function: { arguments: '{"comm' } })),
        data(toolCallChunk({ index: 0, function: { arguments: 'and": "ls"}' } })),
        data(finishChunk("tool_calls", { prompt_tokens: 42, completion_tokens: 7 })),
        DONE,
      ]),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "tool_use_start", id: "call_1", name: "bash" },
      { type: "tool_use_delta", id: "call_1", inputDelta: '{"comm' },
      { type: "tool_use_delta", id: "call_1", inputDelta: 'and": "ls"}' },
      { type: "tool_use_end", id: "call_1", name: "bash", input: { command: "ls" } },
      { type: "usage", usage: { inputTokens: 42, outputTokens: 7 } },
      { type: "turn_complete", stopReason: "tool_use" },
    ]);
  });

  it("finalizes an open tool call when the stream moves to the next index", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "bash", arguments: '{"x":1}' },
          }),
        ),
        data(
          toolCallChunk({
            index: 1,
            id: "call_b",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/f"}' },
          }),
        ),
        data(finishChunk("tool_calls")),
        DONE,
      ]),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    const ends = events.filter((event) => event.type === "tool_use_end");
    expect(ends).toEqual([
      { type: "tool_use_end", id: "call_a", name: "bash", input: { x: 1 } },
      { type: "tool_use_end", id: "call_b", name: "read_file", input: { path: "/f" } },
    ]);
  });

  it("maps finish_reason values onto StopReason; absent reason completes as end_turn", async () => {
    const cases: readonly (readonly [string | undefined, StopReason])[] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
      [undefined, "end_turn"],
    ];
    for (const [finishReason, expected] of cases) {
      const events = finishReason === undefined ? [DONE] : [data(finishChunk(finishReason)), DONE];
      const { fetch } = recordingFetch(() => sseResponse(events));
      const collected = await collect(makeClient({ fetchImpl: fetch }), makeRequest());
      expect(collected.at(-1)).toEqual({ type: "turn_complete", stopReason: expected });
    }
  });

  it("always emits a zero usage event when the server never sends usage", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([data(textChunk("hi")), data(finishChunk("stop")), DONE]),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events.slice(-2)).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("parses SSE split across chunk boundaries with CRLF endings; stops at [DONE]", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
      'data: {"choices":[{"index":0,"delta":{"content":"AFTER"}}]}\r\n\r\n',
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw, 7));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "A" },
      { type: "text_delta", text: "B" },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Review-fix semantics: loud truncation, loud error frames
// ---------------------------------------------------------------------------

describe("openai-compat truncation and error frames", () => {
  it("treats body EOF after content with no finish_reason as a torn stream (protocol error)", async () => {
    const raw =
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    const { fetch } = recordingFetch(() => streamResponse(raw));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "error",
        error: { message: "stream ended before finish_reason", retryable: false, code: "protocol" },
      },
    ]);
  });

  it("treats [DONE] after content with no finish_reason as a torn stream too", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events.at(-1)).toEqual({
      type: "error",
      error: { message: "stream ended before finish_reason", retryable: false, code: "protocol" },
    });
  });

  it("flags a torn tool stream: tool events emitted but no finish_reason", async () => {
    const raw =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_t","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":null}]}\n\n';
    const { fetch } = recordingFetch(() => streamResponse(raw));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "tool_use_end",
      "error",
    ]);
  });

  it("pins the empty-stream behavior: no content, no finish_reason still completes", async () => {
    const { fetch } = recordingFetch(() => sseResponse([DONE]));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("surfaces an OpenAI-style error frame with the provider label in the message", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(textChunk("before the failure")),
        data({
          error: { message: "model x is not available", type: "api_error", code: 404 },
        }),
      ]),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "before the failure" },
      {
        type: "error",
        error: {
          message: "testwire stream error: model x is not available",
          retryable: false,
          code: "server",
        },
      },
    ]);
  });

  it("maps string-shaped error frames and flags clearly transient ones retryable", async () => {
    const stringFrame = recordingFetch(() => sseResponse([data({ error: "boom: bad request" })]));
    const transientFrame = recordingFetch(() =>
      sseResponse([
        data({
          error: { message: "server overloaded", type: "overloaded_error", code: "overloaded" },
        }),
      ]),
    );

    const failure = await collect(makeClient({ fetchImpl: stringFrame.fetch }), makeRequest());
    expect(failure).toEqual([
      {
        type: "error",
        error: {
          message: "testwire stream error: boom: bad request",
          retryable: false,
          code: "server",
        },
      },
    ]);

    const transient = await collect(makeClient({ fetchImpl: transientFrame.fetch }), makeRequest());
    expect(transient.at(-1)).toEqual({
      type: "error",
      error: {
        message: "testwire stream error: server overloaded",
        retryable: true,
        code: "server",
      },
    });
  });

  it("reports malformed streamed tool arguments as protocol errors", async () => {
    const invalidJson = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_bad",
            function: { name: "bash", arguments: '{"comm' },
          }),
        ),
        data(finishChunk("stop")),
        DONE,
      ]),
    );
    const notObject = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_scalar",
            function: { name: "bash", arguments: "5" },
          }),
        ),
        data(finishChunk("stop")),
        DONE,
      ]),
    );

    const invalid = await collect(makeClient({ fetchImpl: invalidJson.fetch }), makeRequest());
    expect(invalid.at(-1)).toMatchObject({
      type: "error",
      error: {
        retryable: false,
        code: "protocol",
        message: expect.stringContaining("not valid JSON"),
      },
    });

    const scalar = await collect(makeClient({ fetchImpl: notObject.fetch }), makeRequest());
    expect(scalar.at(-1)).toMatchObject({
      type: "error",
      error: {
        retryable: false,
        code: "protocol",
        message: expect.stringContaining("not a JSON object"),
      },
    });
  });

  it("reports non-JSON SSE payloads as a protocol error", async () => {
    const { fetch } = recordingFetch(() => sseResponse(["data: {oops", DONE]));

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { retryable: false, code: "protocol" },
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP error taxonomy (incl. the 401/403 -> auth mapping)
// ---------------------------------------------------------------------------

describe("openai-compat HTTP error taxonomy", () => {
  const cases: readonly (readonly [number, string, boolean])[] = [
    [401, "auth", false],
    [403, "auth", false],
    [404, "model_not_found", false],
    [429, "rate_limit", true],
    [500, "server", true],
    [400, "invalid_request", false],
  ];

  it.each(cases)("HTTP %i maps to code %s (retryable %s)", async (status, code, retryable) => {
    const { fetch } = recordingFetch(() => new Response("nope", { status }));
    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());
    expect(events).toEqual([
      {
        type: "error",
        error: { message: `testwire HTTP ${status}: nope`, retryable, code },
      },
    ]);
  });

  it("extracts the message from an OpenAI-style object error body", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Incorrect API key provided",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          }),
          {
            status: 401,
          },
        ),
    );

    const events = await collect(makeClient({ fetchImpl: fetch }), makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: "testwire HTTP 401: Incorrect API key provided",
          retryable: false,
          code: "auth",
        },
      },
    ]);
  });

  it("maps connection failures to a retryable network error naming the provider and endpoint", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };

    const events = await collect(makeClient({ fetchImpl: failing }), makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: `cannot reach testwire at ${ENDPOINT}: fetch failed`,
          retryable: true,
          code: "network",
        },
      },
    ]);
  });

  it("ends a never-resolving fetch with a retryable timeout error (real timers)", async () => {
    const stalled: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        if (signal === null) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    const events = await collect(makeClient({ fetchImpl: stalled, timeoutMs: 50 }), makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: `testwire request to ${ENDPOINT} timed out after 50ms`,
          retryable: true,
          code: "timeout",
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// complete() aggregation
// ---------------------------------------------------------------------------

describe("openai-compat complete()", () => {
  it("aggregates text and tool_use blocks with usage and stop reason", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(textChunk("Hello")),
        data(
          toolCallChunk({
            index: 0,
            id: "call_1",
            function: { name: "bash", arguments: '{"comm' },
          }),
        ),
        data(toolCallChunk({ index: 0, function: { arguments: 'and":"ls"}' } })),
        data(finishChunk("tool_calls", { prompt_tokens: 42, completion_tokens: 7 })),
        DONE,
      ]),
    );

    const completion = await makeClient({ fetchImpl: fetch }).complete(makeRequest());

    expect(completion.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(completion.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(completion.stopReason).toBe("tool_use");
  });

  it("throws the factory-built ProviderCallError when the stream ends in an error event", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const client = makeClient({ fetchImpl: failing });

    const failure = await client.complete(makeRequest()).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    // Structural narrowing per the contract: providerError, not instanceof.
    if (
      !(failure instanceof Error) ||
      typeof (failure as ProviderCallError).providerError !== "object"
    ) {
      throw new Error(`expected a ProviderCallError, got ${String(failure)}`);
    }
    const callError = failure as ProviderCallError;
    expect(callError).toBeInstanceOf(TestWireError);
    expect(callError.providerError).toEqual({
      message: `cannot reach testwire at ${ENDPOINT}: fetch failed`,
      retryable: true,
      code: "network",
    });
    expect(callError.message).toBe(callError.providerError.message);
  });
});
