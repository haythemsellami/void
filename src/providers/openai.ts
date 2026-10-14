/**
 * Generic OpenAI-compatible provider — roadmap workstream 5, phase P1
 * (docs/post-mvp-roadmap.md §5): any endpoint speaking the OpenAI
 * `/v1/chat/completions` SSE wire becomes a usable model source.
 *
 * A thin wrapper over the shared OpenAI-wire core
 * (`src/providers/openai-compat.ts`), exactly like the Ollama adapter. This
 * file owns only what is service-specific:
 *
 * - Base URL: `opts.baseUrl` ?? env `VOID_OPENAI_BASE_URL` ??
 *   `https://api.openai.com/v1` (read once at construction; opts win). The
 *   shared normalizer strips trailing slashes and appends `/v1` only when
 *   missing, so every documented service base works verbatim:
 *
 *     OpenAI          https://api.openai.com/v1            (default)
 *     Kimi/Moonshot   https://api.moonshot.ai/v1
 *     Groq            https://api.groq.com/openai/v1
 *     OpenRouter      https://openrouter.ai/api/v1
 *     LM Studio       http://localhost:1234/v1
 *     vLLM            http://localhost:8000/v1
 *
 * - API key: `opts.apiKey` ?? env `VOID_OPENAI_KEY`, sent as
 *   `Authorization: Bearer …`. Deliberately optional — keyless local servers
 *   (LM Studio, vLLM) work without one; when the key IS required but wrong,
 *   the service answers 401 and the shared taxonomy maps it to a
 *   non-retryable `auth` error.
 * - ModelRef form is `openai/<model-id>`; the prefix is stripped by the core
 *   before the id goes on the wire. Bare ids pass through unchanged.
 * - Error taxonomy is the shared core's (network / model_not_found / auth /
 *   rate_limit / server / invalid_request / protocol / timeout), with this
 *   adapter's label in every message ("openai HTTP 401: …") so multi-provider
 *   users can tell which service failed.
 */
import type {
  ChatCompletion,
  ChatRequest,
  Provider,
  ProviderCallError,
  ProviderError,
  StreamEvent,
} from "../contracts/provider";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  normalizeBaseUrl,
  OpenAiCompatClient,
} from "./openai-compat";

/** Default endpoint: OpenAI's own API. Everything else comes via baseUrl. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIProviderOptions {
  /**
   * Service base URL; defaults to env VOID_OPENAI_BASE_URL, then
   * {@link DEFAULT_OPENAI_BASE_URL}. Trailing-slash tolerant; `/v1` is
   * appended only when missing.
   */
  readonly baseUrl?: string;
  /**
   * API key sent as `Authorization: Bearer …`; defaults to env
   * VOID_OPENAI_KEY. Optional: keyless local servers (LM Studio, vLLM) send
   * no Authorization header.
   */
  readonly apiKey?: string;
  /** Fetch implementation; defaults to the global fetch. Injected by tests. */
  readonly fetchImpl?: FetchLike;
  /**
   * Deadline for one request, covering connect + headers + the entire streamed
   * body. On expiry the stream ends with a retryable `timeout` error event
   * instead of hanging forever. Default 120_000 ms.
   */
  readonly timeoutMs?: number;
}

/**
 * Thrown by `complete()` when the underlying stream ended in an error event.
 * Satisfies the contract's ProviderCallError shape via `providerError`; the
 * `retryable`/`code` fields mirror the Ollama adapter's error for
 * cross-adapter consistency.
 */
export class OpenAIProviderError extends Error implements ProviderCallError {
  readonly retryable: boolean;
  readonly code: string | undefined;
  readonly providerError: ProviderError;

  constructor(error: {
    readonly message: string;
    readonly retryable: boolean;
    readonly code?: string;
  }) {
    super(error.message);
    this.name = "OpenAIProviderError";
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

function envBaseUrl(): string | undefined {
  const value = process.env.VOID_OPENAI_BASE_URL;
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envApiKey(): string | undefined {
  const value = process.env.VOID_OPENAI_KEY;
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements Provider {
  readonly id = "openai";

  private readonly client: OpenAiCompatClient;

  constructor(options: OpenAIProviderOptions = {}) {
    const raw = options.baseUrl ?? envBaseUrl() ?? DEFAULT_OPENAI_BASE_URL;
    const apiKey = options.apiKey ?? envApiKey();
    this.client = new OpenAiCompatClient({
      providerId: "openai",
      endpoint: `${normalizeBaseUrl(raw)}/chat/completions`,
      modelPrefix: "openai/",
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(apiKey !== undefined ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      makeCallError: (error) => new OpenAIProviderError(error),
    });
  }

  stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    return this.client.stream(request);
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    return this.client.complete(request);
  }
}
