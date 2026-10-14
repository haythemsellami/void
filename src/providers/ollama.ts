/**
 * Ollama provider — the local-model adapter that proves ADR-0002's offline
 * property (docs/adr/0002-local-first-architecture.md): a full agent turn with
 * tool use runs against a local Ollama instance, the only egress.
 *
 * A thin wrapper over the shared OpenAI-wire core (`src/providers/openai-compat.ts`,
 * extracted from this file in roadmap workstream 5): the core owns request
 * mapping, SSE chunk parsing, tool-call accumulation, usage/stop mapping, and
 * the loud-EOF / loud-error-frame semantics; the tests that pin them live in
 * `ollama.test.ts` and pass UNMODIFIED through this wrapper. This file owns
 * only what is Ollama-specific:
 *
 * - Base URL resolution: `opts.baseUrl` ?? env `VOID_OLLAMA_URL` ??
 *   `http://127.0.0.1:11434` (read once at construction; opts win). Trailing
 *   slashes are stripped and a missing `/v1` suffix is appended via the shared
 *   {@link normalizeBaseUrl}, so `http://h:11434`, `http://h:11434/`,
 *   `http://h:11434/v1`, and `http://h:11434/v1/` all hit the same endpoint.
 * - ModelRef form is `ollama/<model>`; the prefix is stripped by the core
 *   before the id goes on the wire. Bare model ids pass through unchanged.
 * - Error message wording ("cannot reach ollama at …", "ollama HTTP …") and
 *   the `OllamaProviderError` class `complete()` throws.
 * - No auth: local Ollama needs no key, so no Authorization header is sent.
 */
import type {
  ChatCompletion,
  ChatRequest,
  Provider,
  ProviderCallError,
  StreamEvent,
} from "../contracts/provider";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  normalizeBaseUrl,
  OpenAiCompatClient,
} from "./openai-compat";

export type { FetchLike };

export interface OllamaProviderOptions {
  /** Ollama base URL; defaults to env VOID_OLLAMA_URL, then http://127.0.0.1:11434. */
  readonly baseUrl?: string;
  /** Fetch implementation; defaults to the global fetch. Injected by tests. */
  readonly fetchImpl?: FetchLike;
  /**
   * Deadline for one request, covering connect + headers + the entire streamed
   * body (the signal stays attached to the body, so a stalled SSE stream also
   * aborts). On expiry the stream ends with a retryable `timeout` error event
   * instead of hanging forever. Default 120_000 ms.
   */
  readonly timeoutMs?: number;
}

/**
 * Thrown by `complete()` when the underlying stream ended in an error event.
 * Satisfies the contract's ProviderCallError shape via `providerError`; the
 * `retryable`/`code` fields predate it and stay for backwards compatibility.
 */
export class OllamaProviderError extends Error implements ProviderCallError {
  readonly retryable: boolean;
  readonly code: string | undefined;
  readonly providerError: ProviderCallError["providerError"];

  constructor(error: {
    readonly message: string;
    readonly retryable: boolean;
    readonly code?: string;
  }) {
    super(error.message);
    this.name = "OllamaProviderError";
    this.retryable = error.retryable;
    this.code = error.code;
    this.providerError = {
      message: error.message,
      retryable: error.retryable,
      ...(error.code !== undefined ? { code: error.code } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

function envBaseUrl(): string | undefined {
  const value = process.env.VOID_OLLAMA_URL;
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements Provider {
  readonly id = "ollama";

  private readonly client: OpenAiCompatClient;

  constructor(options: OllamaProviderOptions = {}) {
    const raw = options.baseUrl ?? envBaseUrl() ?? DEFAULT_BASE_URL;
    this.client = new OpenAiCompatClient({
      providerId: "ollama",
      endpoint: `${normalizeBaseUrl(raw)}/chat/completions`,
      modelPrefix: "ollama/",
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      makeCallError: (error) => new OllamaProviderError(error),
    });
  }

  stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    return this.client.stream(request);
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    return this.client.complete(request);
  }
}
