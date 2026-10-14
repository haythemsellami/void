/**
 * Tests for the generic OpenAI-compatible provider
 * (src/providers/openai.ts) — roadmap workstream 5, phase P1.
 *
 * Mirrors the Ollama suite's shape (same offline posture: scripted SSE bodies
 * through an injected `fetchImpl`, streamed via real ReadableStreams) but
 * pins what is specific to this adapter: env resolution
 * (VOID_OPENAI_BASE_URL / VOID_OPENAI_KEY, read at construction, opts win),
 * Bearer authentication (present with a key, absent for keyless local
 * servers), `openai/` ModelRef stripping, the api.openai.com default base
 * URL, and the shared taxonomy's 401 → auth mapping. The wire mechanics
 * themselves are the shared core's, pinned separately in
 * openai-compat.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatRequest,
  Provider,
  ProviderCallError,
  StopReason,
  StreamEvent,
} from "../contracts/provider";
import { DEFAULT_OPENAI_BASE_URL, OpenAIProvider, OpenAIProviderError } from "./openai";
import type { FetchLike } from "./openai-compat";

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

async function collect(provider: Provider, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
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

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: "openai/gpt-test-4o",
    system: "You are Void.",
    messages: [{ role: "user", content: [{ type: "text", text: "list the files" }] }],
    ...overrides,
  };
}

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
// Identity, base URL, and authentication
// ---------------------------------------------------------------------------

describe("openai provider config", () => {
  it("exposes the openai registry id and satisfies the Provider interface", () => {
    const provider: Provider = new OpenAIProvider({ fetchImpl: async () => sseResponse([DONE]) });
    expect(provider.id).toBe("openai");
  });

  it("defaults to the official api.openai.com/v1 endpoint", async () => {
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(new OpenAIProvider({ fetchImpl: fetch }), makeRequest());
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(DEFAULT_OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("normalizes base URLs: trailing slash, missing /v1, existing /v1, deep /v1 paths", async () => {
    const bases: readonly [string, string][] = [
      ["https://api.openai.com", "https://api.openai.com/v1/chat/completions"],
      ["https://api.openai.com/", "https://api.openai.com/v1/chat/completions"],
      ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
      ["https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"],
      ["https://api.moonshot.ai/v1", "https://api.moonshot.ai/v1/chat/completions"],
      ["https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1/chat/completions"],
      ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"],
      ["http://localhost:1234/v1", "http://localhost:1234/v1/chat/completions"],
    ];
    for (const [baseUrl, expectedUrl] of bases) {
      const { fetch, requests } = recordingFetch(() =>
        sseResponse([data(finishChunk("stop")), DONE]),
      );
      await collect(new OpenAIProvider({ baseUrl, fetchImpl: fetch }), makeRequest());
      expect(requests[0]?.url).toBe(expectedUrl);
    }
  });

  it("resolves the base URL from VOID_OPENAI_BASE_URL, with opts taking precedence", async () => {
    stubEnv("VOID_OPENAI_BASE_URL", "https://api.moonshot.ai/v1");
    const fromEnv = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(new OpenAIProvider({ fetchImpl: fromEnv.fetch }), makeRequest());
    expect(fromEnv.requests[0]?.url).toBe("https://api.moonshot.ai/v1/chat/completions");

    const fromOpts = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(
      new OpenAIProvider({ baseUrl: "http://vllm.local:8000/v1", fetchImpl: fromOpts.fetch }),
      makeRequest(),
    );
    expect(fromOpts.requests[0]?.url).toBe("http://vllm.local:8000/v1/chat/completions");
  });

  it("sends the key from VOID_OPENAI_KEY as a Bearer Authorization header", async () => {
    stubEnv("VOID_OPENAI_KEY", "sk-env-secret");
    const { fetch, requests } = recordingFetch(() =>
      sseResponse([data(finishChunk("stop")), DONE]),
    );
    await collect(new OpenAIProvider({ fetchImpl: fetch }), makeRequest());

    expect(requests[0]?.headers?.authorization).toBe("Bearer sk-env-secret");
    expect(requests[0]?.headers?.["content-type"]).toBe("application/json");
  });

  it("opts apiKey wins over env", async () => {
    stubEnv("VOID_OPENAI_KEY", "sk-env-secret");
    const fromOpts = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(
      new OpenAIProvider({ apiKey: "sk-opt", fetchImpl: fromOpts.fetch }),
      makeRequest(),
    );
    expect(fromOpts.requests[0]?.headers?.authorization).toBe("Bearer sk-opt");
  });

  it("sends no Authorization header when no key is set (keyless local servers)", async () => {
    // LM Studio / vLLM: no VOID_OPENAI_KEY, no opts key — the request must
    // still work, just unauthenticated.
    const keyless = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    await collect(
      new OpenAIProvider({
        baseUrl: "http://localhost:1234/v1",
        fetchImpl: keyless.fetch,
      }),
      makeRequest(),
    );
    expect(keyless.requests[0]?.headers?.authorization).toBeUndefined();
  });

  it("strips the openai/ ModelRef prefix and passes bare model ids through", async () => {
    const prefixed = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));
    const bare = recordingFetch(() => sseResponse([data(finishChunk("stop")), DONE]));

    await collect(new OpenAIProvider({ fetchImpl: prefixed.fetch }), makeRequest());
    await collect(
      new OpenAIProvider({ fetchImpl: bare.fetch }),
      makeRequest({ model: "moonshot-v1-auto" }),
    );

    expect(wireBody(prefixed.requests[0]).model).toBe("gpt-test-4o");
    expect(wireBody(bare.requests[0]).model).toBe("moonshot-v1-auto");
  });
});

// ---------------------------------------------------------------------------
// Turns (wire behavior is the shared core's; these pin the provider path)
// ---------------------------------------------------------------------------

describe("openai provider turns", () => {
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
    const provider = new OpenAIProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "usage",
      "turn_complete",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[2]).toEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 4 } });
    expect(events[3]).toEqual({ type: "turn_complete", stopReason: "end_turn" });

    const body = wireBody(requests[0]);
    expect(body.model).toBe("gpt-test-4o");
    expect(body.messages).toEqual([
      { role: "system", content: "You are Void." },
      { role: "user", content: "list the files" },
    ]);
  });

  it("emits start/delta/end with the parsed input for fragmented tool arguments", async () => {
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
    const provider = new OpenAIProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events.map((event) => event.type)).toEqual([
      "tool_use_start",
      "tool_use_delta",
      "tool_use_delta",
      "tool_use_end",
      "usage",
      "turn_complete",
    ]);
    const end = events.find((event) => event.type === "tool_use_end");
    expect(end).toEqual({
      type: "tool_use_end",
      id: "call_1",
      name: "bash",
      input: { command: "ls" },
    });
    expect(events.at(-1)).toEqual({ type: "turn_complete", stopReason: "tool_use" });
  });

  it("maps finish_reason values onto StopReason", async () => {
    const cases: readonly (readonly [string, StopReason])[] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
    ];
    for (const [finishReason, expected] of cases) {
      const { fetch } = recordingFetch(() => sseResponse([data(finishChunk(finishReason)), DONE]));
      const provider = new OpenAIProvider({ fetchImpl: fetch });
      const events = await collect(provider, makeRequest());
      expect(events.at(-1)).toEqual({ type: "turn_complete", stopReason: expected });
    }
  });
});

// ---------------------------------------------------------------------------
// Loud truncation and error frames (review-fix behaviors over this adapter)
// ---------------------------------------------------------------------------

describe("openai provider truncation and error frames", () => {
  it("treats a body EOF after content with no finish_reason as a torn stream (protocol error)", async () => {
    const raw =
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    const { fetch } = recordingFetch(() => streamResponse(raw));
    const provider = new OpenAIProvider({ fetchImpl: fetch });

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
    const provider = new OpenAIProvider({ fetchImpl: fetch });

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

  it("surfaces an OpenAI-style error frame as the final error event", async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse([
        data(textChunk("before the failure")),
        data({
          error: {
            message: "The model `gpt-test-4o` does not exist",
            type: "invalid_request_error",
          },
        }),
      ]),
    );
    const provider = new OpenAIProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      { type: "text_delta", text: "before the failure" },
      {
        type: "error",
        error: {
          message: "openai stream error: The model `gpt-test-4o` does not exist",
          retryable: false,
          code: "server",
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// HTTP errors, network, timeout
// ---------------------------------------------------------------------------

describe("openai provider errors", () => {
  it("maps HTTP 401 to a non-retryable auth error naming the service", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "Incorrect API key provided", type: "invalid_request_error" },
          }),
          { status: 401 },
        ),
    );
    const provider = new OpenAIProvider({ fetchImpl: fetch });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: "openai HTTP 401: Incorrect API key provided",
          retryable: false,
          code: "auth",
        },
      },
    ]);
  });

  it("maps HTTP 404 to model_not_found and 429 to a retryable rate_limit error", async () => {
    const notFound = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "The model `nope` does not exist" } }), {
          status: 404,
        }),
    );
    const rateLimited = recordingFetch(() => new Response("limit exceeded", { status: 429 }));

    const nf = await collect(new OpenAIProvider({ fetchImpl: notFound.fetch }), makeRequest());
    expect(nf).toEqual([
      {
        type: "error",
        error: {
          message: expect.stringContaining("does not exist"),
          retryable: false,
          code: "model_not_found",
        },
      },
    ]);

    const rl = await collect(new OpenAIProvider({ fetchImpl: rateLimited.fetch }), makeRequest());
    expect(rl).toEqual([
      {
        type: "error",
        error: {
          message: "openai HTTP 429: limit exceeded",
          retryable: true,
          code: "rate_limit",
        },
      },
    ]);
  });

  it("maps connection failures to a retryable network error and ends the stream", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const provider = new OpenAIProvider({ fetchImpl: failing });

    const events = await collect(provider, makeRequest());

    expect(events).toEqual([
      {
        type: "error",
        error: {
          message: expect.stringContaining("cannot reach openai"),
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
    const provider = new OpenAIProvider({ fetchImpl: stalled, timeoutMs: 50 });

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

describe("openai provider complete()", () => {
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
    const provider = new OpenAIProvider({ fetchImpl: fetch });

    const completion = await provider.complete(makeRequest());

    expect(completion.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(completion.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(completion.stopReason).toBe("tool_use");
  });

  it("throws a typed error satisfying the contract's ProviderCallError shape", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const provider = new OpenAIProvider({ fetchImpl: failing });

    await expect(provider.complete(makeRequest())).rejects.toBeInstanceOf(OpenAIProviderError);

    const failure = await provider.complete(makeRequest()).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const callError = asProviderCallError(failure);
    expect(callError).toBeInstanceOf(OpenAIProviderError);
    expect(callError.providerError.retryable).toBe(true);
    expect(callError.providerError.code).toBe("network");
    expect(callError.providerError.message).toContain("cannot reach openai");
    expect(callError.message).toBe(callError.providerError.message);
  });
});
