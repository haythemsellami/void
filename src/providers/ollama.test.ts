/**
 * Tests for the Ollama provider (src/providers/ollama.ts).
 *
 * Fully offline: every test injects a `fetchImpl` fake returning scripted SSE
 * bodies, so no request ever leaves the process (ADR-0002's verification
 * posture). The fakes stream bodies through a real ReadableStream in small
 * chunks so the incremental SSE parser — including chunk-split events and
 * \r\n line endings — is exercised on the public API.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatRequest,
  Provider,
  ProviderCallError,
  StopReason,
  StreamEvent,
} from "../contracts/provider";
import type { ToolSpec } from "../contracts/tools";
import type { FetchLike } from "./ollama";
import { OllamaProvider, OllamaProviderError } from "./ollama";

// Manual env stubbing (savedEnv + afterEach restore): vi.stubEnv is
// vitest-only and absent from bun:test's compatibility layer, and this suite
// must stay green under both runners.
const savedEnv = new Map<string, string | undefined>();

function stubEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly url: string;
  readonly body: unknown;
}

function recordingFetch(respond: (url: string, body: unknown) => Response | Promise<Response>): {
  fetch: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const body: unknown = raw.length > 0 ? safeJsonParse(raw) : undefined;
    requests.push({ url, body });
    return respond(url, body);
  };
  return { fetch: impl, requests };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Wraps raw text in a streaming 200 SSE Response, `chunkSize` bytes per read. */
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
  const raw = events.map((event) => `${event}\n\n`).join("");
  return streamResponse(raw, chunkSize);
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

async function collect(provider: Provider, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    events.push(event);
  }
  return events;
}

function lastEvent(events: readonly StreamEvent[]): StreamEvent {
  const last = events[events.length - 1];
  if (last === undefined) {
    throw new Error("expected at least one stream event");
  }
  return last;
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
    model: "ollama/llama3.2",
    system: "You are Void.",
    messages: [{ role: "user", content: [{ type: "text", text: "list the files" }] }],
    ...overrides,
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

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

// ---------------------------------------------------------------------------
// Text turns and request mapping
// ---------------------------------------------------------------------------

describe("ollama provider", () => {
  it("exposes the ollama registry id and satisfies the Provider interface", () => {
    const provider: Provider = new OllamaProvider();
    expect(provider.id).toBe("ollama");
  });

  it("streams a plain text turn into contracts events and maps the request", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([
        data({
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        }),
        data(textChunk("Hello")),
        data(textChunk(" world")),
        data(finishChunk("stop", { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })),
        DONE,
      ]),
    );
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "usage",
      "turn_complete",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: " world" });
    expect(events[2]).toEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 4 } });
    expect(events[3]).toEqual({ type: "turn_complete", stopReason: "end_turn" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const body = wireBody(requests[0]);
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are Void." },
      { role: "user", content: "list the files" },
    ]);
    expect("tools" in body).toBe(false);
  });

  it("strips the ollama/ ModelRef prefix and passes bare model ids through", async () => {
    const prefixed = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    const bare = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));

    await collect(new OllamaProvider({ fetchImpl: prefixed.fetch }), makeRequest());
    await collect(
      new OllamaProvider({ fetchImpl: bare.fetch }),
      makeRequest({ model: "qwen3:4b" }),
    );

    expect(wireBody(prefixed.requests[0]).model).toBe("llama3.2");
    expect(wireBody(bare.requests[0]).model).toBe("qwen3:4b");
  });

  it("normalizes base URLs: trailing slash, missing /v1, existing /v1", async () => {
    for (const baseUrl of [
      "http://localhost:11434",
      "http://localhost:11434/",
      "http://localhost:11434/v1",
      "http://localhost:11434/v1/",
    ]) {
      const { fetch, requests } = recordingFetch(() =>
        sseResponse([data(finishChunk("stop")), DONE]),
      );
      await collect(new OllamaProvider({ baseUrl, fetchImpl: fetch }), makeRequest());
      expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    }
  });

  it("resolves the base URL from VOID_OLLAMA_URL, with opts taking precedence", async () => {
    stubEnv("VOID_OLLAMA_URL", "http://envhost:1234");
    const fromEnv = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(new OllamaProvider({ fetchImpl: fromEnv.fetch }), makeRequest());
    expect(fromEnv.requests[0]?.url).toBe("http://envhost:1234/v1/chat/completions");

    const fromOpts = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(
      new OllamaProvider({ baseUrl: "http://optshost:1", fetchImpl: fromOpts.fetch }),
      makeRequest(),
    );
    expect(fromOpts.requests[0]?.url).toBe("http://optshost:1/v1/chat/completions");
  });

  it("maps tools and generation params onto the wire request", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    await collect(
      provider,
      makeRequest({
        tools: [bashTool],
        params: { temperature: 0.2, maxOutputTokens: 512, stopSequences: ["END"] },
      }),
    );

    const body = wireBody(requests[0]);
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
    expect("reasoning_effort" in body).toBe(false);
  });

  it("maps history: assistant text+tool_use and user tool_result blocks", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    await collect(
      provider,
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
          { role: "user", content: [{ type: "text", text: "thanks" }] },
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
      { role: "user", content: "thanks" },
    ]);
  });

  it("maps a tool-only assistant message to null content with tool_calls", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    await collect(
      provider,
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
});

// ---------------------------------------------------------------------------
// Tool-call streaming
// ---------------------------------------------------------------------------

describe("ollama provider tool streaming", () => {
  it("emits start/delta/end with the parsed input for fragmented arguments", async () => {
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
        data(
          finishChunk("tool_calls", { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }),
        ),
        DONE,
      ]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "tool_use_delta",
      "tool_use_end",
      "usage",
      "turn_complete",
    ]);
    expect(events[0]).toEqual({ type: "tool_use_start", id: "call_1", name: "bash" });
    expect(events[1]).toEqual({ type: "tool_use_delta", id: "call_1", inputDelta: '{"comm' });
    expect(events[2]).toEqual({ type: "tool_use_delta", id: "call_1", inputDelta: 'and": "ls"}' });
    expect(events[3]).toEqual({
      type: "tool_use_end",
      id: "call_1",
      name: "bash",
      input: { command: "ls" },
    });
    expect(events[4]).toEqual({ type: "usage", usage: { inputTokens: 42, outputTokens: 7 } });
    expect(events[5]).toEqual({ type: "turn_complete", stopReason: "tool_use" });
  });

  it("ends a tool call when the stream moves on to the next index", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "bash", arguments: '{"x":' },
          }),
        ),
        data(toolCallChunk({ index: 0, function: { arguments: "1}" } })),
        data(
          toolCallChunk({
            index: 1,
            id: "call_b",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/tmp/f"}' },
          }),
        ),
        data(finishChunk("tool_calls")),
        DONE,
      ]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "tool_use_delta",
      "tool_use_end", // call_a closes when index 1 first appears
      "tool_use_start",
      "tool_use_delta",
      "tool_use_end", // call_b closes on finish_reason
      "usage",
      "turn_complete",
    ]);
    const ends = events.filter((event) => event.type === "tool_use_end");
    expect(ends[0]).toEqual({ type: "tool_use_end", id: "call_a", name: "bash", input: { x: 1 } });
    expect(ends[1]).toEqual({
      type: "tool_use_end",
      id: "call_b",
      name: "read_file",
      input: { path: "/tmp/f" },
    });
  });

  it("synthesizes an id when the server omits one", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(toolCallChunk({ index: 0, type: "function", function: { name: "bash" } })),
        data(finishChunk("tool_calls")),
        DONE,
      ]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events[0]).toEqual({ type: "tool_use_start", id: "tcall_0", name: "bash" });
    expect(events[1]).toEqual({ type: "tool_use_end", id: "tcall_0", name: "bash", input: {} });
  });

  it("treats empty accumulated arguments as an empty input object", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(
          toolCallChunk({
            index: 0,
            id: "call_e",
            function: { name: "status", arguments: "" },
          }),
        ),
        data(finishChunk("stop")),
        DONE,
      ]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.filter((event) => event.type === "tool_use_end")).toEqual([
      { type: "tool_use_end", id: "call_e", name: "status", input: {} },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Termination semantics
// ---------------------------------------------------------------------------

describe("ollama provider termination", () => {
  it("maps finish_reason values onto StopReason", async () => {
    const cases: readonly (readonly [string | undefined, StopReason])[] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
      [undefined, "end_turn"],
    ];
    for (const [finishReason, expected] of cases) {
      const events = finishReason === undefined ? [DONE] : [data(finishChunk(finishReason)), DONE];
      const { fetch } = recordingFetch(() => sseResponse(events));
      const provider = new OllamaProvider({ fetchImpl: fetch });
      const collected = await collect(provider, makeRequest());
      const last = lastEvent(collected);
      expect(last).toEqual({ type: "turn_complete", stopReason: expected });
    }
  });

  it("emits a zero usage event when the server never sends usage", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([data(textChunk("hi")), data(finishChunk("stop")), DONE]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.slice(-2)).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("stops at data: [DONE] and ignores anything after it", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[{"index":0,"delta":{"content":"AFTER"},"finish_reason":null}]}\n\n',
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual(["text_delta", "usage", "turn_complete"]);
    expect(events[0]).toEqual({ type: "text_delta", text: "ok" });
    expect(events.at(-1)).toEqual({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("treats a body EOF after content with no finish_reason as a torn stream (protocol error)", async () => {
    // Content arrives, then the connection simply ends: no finish_reason, no [DONE].
    const raw =
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    const { fetch } = recordingFetch(() => streamResponse(raw));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "error",
        error: {
          message: "stream ended before finish_reason",
          retryable: false,
          code: "protocol",
        },
      },
    ]);
  });

  it("treats [DONE] after content with no finish_reason as a torn stream too", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        message: "stream ended before finish_reason",
        retryable: false,
        code: "protocol",
      },
    });
  });

  it("flags a torn tool stream: tool events emitted but no finish_reason", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_t","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    // The completed tool call is reported (consumers saw it), then the
    // truncation is loud — never a silent end_turn with tool_use pending.
    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "tool_use_end",
      "error",
    ]);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        message: "stream ended before finish_reason",
        retryable: false,
        code: "protocol",
      },
    });
  });

  it("pins the empty-stream behavior: no content, no finish_reason still completes as end_turn", async () => {
    const { fetch } = recordingFetch(() => sseResponse([DONE]));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
      { type: "turn_complete", stopReason: "end_turn" },
    ]);
  });

  it("parses SSE bodies split across chunk boundaries with CRLF endings", async () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ].join("");
    const { fetch } = recordingFetch(() => streamResponse(raw, 7)); // 7 bytes per read
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "usage",
      "turn_complete",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", text: "A" });
    expect(events[1]).toEqual({ type: "text_delta", text: "B" });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("ollama provider errors", () => {
  it("maps connection failures to a retryable network error and ends the stream", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const provider = new OllamaProvider({ fetchImpl: failing });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: expect.stringContaining("cannot reach ollama"),
          retryable: true,
          code: "network",
        },
      },
    ]);
  });

  it("maps HTTP 404 to a non-retryable model_not_found error", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: "model 'nope' not found, try pulling it first" }), {
          status: 404,
        }),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      error: {
        message: expect.stringContaining("not found"),
        retryable: false,
        code: "model_not_found",
      },
    });
  });

  it("maps HTTP 5xx to a retryable server error", async () => {
    const { fetch } = recordingFetch(() => new Response("internal", { status: 500 }));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      error: { message: expect.any(String), retryable: true, code: "server" },
    });
  });

  it("reports unparseable streamed tool arguments as a protocol error", async () => {
    const { fetch } = recordingFetch(() =>
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
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "error",
    ]);
    expect(events[2]).toEqual({
      type: "error",
      error: {
        message: expect.stringContaining("not valid JSON"),
        retryable: false,
        code: "protocol",
      },
    });
  });

  it("reports tool arguments that are valid JSON but not an object as a protocol error", async () => {
    const { fetch } = recordingFetch(() =>
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
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "error",
    ]);
    expect(events[2]).toEqual({
      type: "error",
      error: {
        message: expect.stringContaining("not a JSON object"),
        retryable: false,
        code: "protocol",
      },
    });
  });

  it("reports non-JSON SSE payloads as a protocol error", async () => {
    const { fetch } = recordingFetch(() => sseResponse(["data: {oops", DONE]));
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      error: { message: expect.any(String), retryable: false, code: "protocol" },
    });
  });

  it("surfaces an OpenAI-style error frame as the final error event", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(textChunk("before the failure")),
        data({
          error: { message: "model llama3.2 is not available", type: "api_error", code: 404 },
        }),
      ]),
    );
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "before the failure" },
      {
        type: "error",
        error: {
          message: "ollama stream error: model llama3.2 is not available",
          retryable: false,
          code: "server",
        },
      },
    ]);
  });

  it("maps a string-shaped error frame and flags clearly transient ones retryable", async () => {
    const stringFrame = recordingFetch(() => sseResponse([data({ error: "boom: bad request" })]));
    const transientFrame = recordingFetch(() =>
      sseResponse([
        data({
          error: { message: "server overloaded", type: "overloaded_error", code: "overloaded" },
        }),
      ]),
    );

    const failure = await collect(
      new OllamaProvider({ fetchImpl: stringFrame.fetch }),
      makeRequest(),
    );
    expect(failure).toEqual([
      {
        type: "error",
        error: {
          message: "ollama stream error: boom: bad request",
          retryable: false,
          code: "server",
        },
      },
    ]);

    const transient = await collect(
      new OllamaProvider({ fetchImpl: transientFrame.fetch }),
      makeRequest(),
    );
    expect(transient.at(-1)).toEqual({
      type: "error",
      error: {
        message: "ollama stream error: server overloaded",
        retryable: true,
        code: "server",
      },
    });
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
      const signal = init?.signal ?? null;
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
    const signal = init?.signal ?? null;
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

describe("ollama provider request deadline", () => {
  it("attaches an abort signal to the fetch init", async () => {
    const inits: RequestInit[] = [];
    const capturing: FetchLike = async (_url, init) => {
      inits.push(init ?? {});
      return sseResponse([data(finishChunk("stop")), DONE]);
    };
    const provider = new OllamaProvider({ fetchImpl: capturing, timeoutMs: 60_000 });
    await collect(provider, makeRequest());
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ends a never-resolving fetch with a retryable timeout error (real timers)", async () => {
    const provider = new OllamaProvider({ fetchImpl: stalledFetch(), timeoutMs: 50 });

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
    const provider = new OllamaProvider({ fetchImpl: stalledBodyFetch(), timeoutMs: 50 });

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

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

describe("ollama provider complete()", () => {
  it("aggregates its own stream into a ChatCompletion", async () => {
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
    const provider = new OllamaProvider({ fetchImpl: fetch });

    const completion = await provider.complete(makeRequest());

    expect(completion.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(completion.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(completion.stopReason).toBe("tool_use");
  });

  it("throws a typed error when the stream ends in an error event", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const provider = new OllamaProvider({ fetchImpl: failing });

    await expect(provider.complete(makeRequest())).rejects.toBeInstanceOf(OllamaProviderError);
    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      retryable: true,
      code: "network",
    });
  });

  it("satisfies the contract's ProviderCallError shape (structural narrowing)", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const provider = new OllamaProvider({ fetchImpl: failing });

    const failure = await provider.complete(makeRequest()).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    // The contract says: narrow on the providerError property, not instanceof.
    const callError = asProviderCallError(failure);
    expect(callError).toBeInstanceOf(OllamaProviderError);
    expect(callError.providerError.retryable).toBe(true);
    expect(callError.providerError.code).toBe("network");
    expect(callError.providerError.message).toContain("cannot reach ollama");
    expect(callError.message).toBe(callError.providerError.message);
    // Backwards-compatible fields survive and agree with the carrier.
    if (failure instanceof OllamaProviderError) {
      expect(failure.retryable).toBe(callError.providerError.retryable);
      expect(failure.code).toBe(callError.providerError.code);
    }
  });
});
