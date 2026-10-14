/**
 * Anthropic Messages API adapter — implements the vendor-neutral `Provider`
 * contract (docs/architecture.md §providers) against `POST {baseURL}/v1/messages`
 * with `stream: true`, translating the vendor's SSE event stream into
 * contract `StreamEvent`s.
 *
 * Design rules honored here:
 * - Zero runtime dependencies (ADR-0001): global `fetch` (Bun) + the shared
 *   SSE parser in `./sse`; no vendor SDK.
 * - Keys stay local (ADR-0002): `opts.apiKey ?? VOID_ANTHROPIC_KEY ??
 *   ANTHROPIC_API_KEY`, read once at construction and only ever sent to the
 *   Anthropic endpoint in the `x-api-key` header.
 * - Contracts stay vendor-free: every Anthropic wire shape below is a local
 *   interface; translation happens entirely inside this file.
 * - Error contract: expected failures surface as a single final `error`
 *   stream event, never a throw; `complete()` surfaces the same failure by
 *   throwing `AnthropicCallError` carrying the structured `ProviderError`
 *   (the contract's ProviderCallError shape).
 */
import type {
  AssistantContentBlock,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  GenerationParams,
  ModelRef,
  Provider,
  ProviderCallError,
  ProviderError,
  ProviderErrorEvent,
  StopReason,
  StreamEvent,
  UsageRecord,
} from "../contracts/provider";
import type { JsonSchema, ToolInput, ToolSpec } from "../contracts/tools";
import { parseSSE } from "./sse";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";
/** The API requires `max_tokens` on every request. */
const DEFAULT_MAX_TOKENS = 8192;
/** Default deadline for one request: connect + headers + the whole streamed body. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Narrow fetch signature so tests (and callers) can inject a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
  /** Base URL; default `https://api.anthropic.com`. Overridable for tests. */
  readonly baseURL?: string;
  /** `anthropic-version` header value; default `2023-06-01`. */
  readonly apiVersion?: string;
  /** Fetch implementation; default the global `fetch`. Never hits the network in tests. */
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
 * Thrown by `complete()` when the turn ended with an error event instead of a
 * completion. Satisfies the contract's ProviderCallError shape.
 */
export class AnthropicCallError extends Error implements ProviderCallError {
  readonly providerError: ProviderError;

  constructor(providerError: ProviderError) {
    super(providerError.message);
    this.name = "AnthropicCallError";
    this.providerError = providerError;
  }
}

// ---------------------------------------------------------------------------
// Anthropic wire shapes (local to this adapter — never exported through contracts)
// ---------------------------------------------------------------------------

interface WireUsage {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_read_input_tokens?: number | undefined;
  readonly cache_creation_input_tokens?: number | undefined;
}

interface WireTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface WireToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: ToolInput;
}

interface WireToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: readonly WireTextBlock[];
  readonly is_error?: boolean;
}

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly (WireTextBlock | WireToolUseBlock | WireToolResultBlock)[];
}

interface WireTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

interface WireRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly WireTool[];
  readonly stream: true;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop_sequences?: readonly string[];
}

/** Normalized vendor stream events, parsed from SSE data payloads. */
type WireStreamEvent =
  | { readonly type: "message_start"; readonly usage?: WireUsage | undefined }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly toolUse?: { readonly id: string; readonly name: string } | undefined;
    }
  | {
      readonly type: "content_block_delta";
      readonly index: number;
      readonly textDelta?: string | undefined;
      readonly inputDelta?: string | undefined;
    }
  | { readonly type: "content_block_stop"; readonly index: number }
  | {
      readonly type: "message_delta";
      readonly stopReason?: string | undefined;
      readonly usage?: WireUsage | undefined;
    }
  | { readonly type: "message_stop" }
  | {
      readonly type: "stream_error";
      readonly errorType?: string | undefined;
      readonly errorMessage?: string | undefined;
    };

type ParsedWireEvent =
  | { readonly ok: true; readonly event?: WireStreamEvent | undefined }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// Small unknown-narrowing helpers (strict TS; no `any`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonObject(value: unknown): value is ToolInput {
  return isRecord(value) && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function wireUsage(value: unknown): WireUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    input_tokens: num(value.input_tokens),
    output_tokens: num(value.output_tokens),
    cache_read_input_tokens: num(value.cache_read_input_tokens),
    cache_creation_input_tokens: num(value.cache_creation_input_tokens),
  };
}

/**
 * Parse one SSE data payload into a normalized wire event. Malformed JSON (or
 * a non-object payload) is a protocol error; recognized noise (`ping`) and
 * unknown/future event types (e.g. extended-thinking deltas) are ignored.
 */
function parseWireEvent(data: string): ParsedWireEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, message: "malformed JSON in stream event payload" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: "stream event payload is not a JSON object" };
  }
  const index = num(parsed.index) ?? 0;
  switch (parsed.type) {
    case "message_start": {
      const message = isRecord(parsed.message) ? parsed.message : undefined;
      return { ok: true, event: { type: "message_start", usage: wireUsage(message?.usage) } };
    }
    case "content_block_start": {
      const block = isRecord(parsed.content_block) ? parsed.content_block : undefined;
      if (block !== undefined && block.type === "tool_use") {
        return {
          ok: true,
          event: {
            type: "content_block_start",
            index,
            toolUse: { id: str(block.id) ?? "", name: str(block.name) ?? "" },
          },
        };
      }
      return { ok: true, event: { type: "content_block_start", index } }; // text / thinking / future
    }
    case "content_block_delta": {
      const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
      if (delta?.type === "text_delta") {
        return {
          ok: true,
          event: { type: "content_block_delta", index, textDelta: str(delta.text) ?? "" },
        };
      }
      if (delta?.type === "input_json_delta") {
        return {
          ok: true,
          event: { type: "content_block_delta", index, inputDelta: str(delta.partial_json) ?? "" },
        };
      }
      return { ok: true, event: { type: "content_block_delta", index } }; // thinking_delta / signature_delta / future
    }
    case "content_block_stop":
      return { ok: true, event: { type: "content_block_stop", index } };
    case "message_delta": {
      const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
      const stopReason = delta === undefined ? undefined : str(delta.stop_reason);
      return {
        ok: true,
        event: { type: "message_delta", stopReason, usage: wireUsage(parsed.usage) },
      };
    }
    case "message_stop":
      return { ok: true, event: { type: "message_stop" } };
    case "ping":
      return { ok: true }; // heartbeat
    case "error": {
      const error = isRecord(parsed.error) ? parsed.error : undefined;
      return {
        ok: true,
        event: {
          type: "stream_error",
          errorType: error === undefined ? undefined : str(error.type),
          errorMessage: error === undefined ? undefined : str(error.message),
        },
      };
    }
    default:
      return { ok: true }; // unknown/future event types are ignored
  }
}

// ---------------------------------------------------------------------------
// Request translation (contract -> wire)
// ---------------------------------------------------------------------------

/** `anthropic/<model-id>` ModelRefs lose the provider prefix; bare ids pass through. */
function resolveModel(model: ModelRef): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

function toWireMessage(message: ChatMessage): WireMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((block) =>
        block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "tool_use" as const, id: block.id, name: block.name, input: block.input },
      ),
    };
  }
  return {
    role: "user",
    content: message.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : {
            type: "tool_result" as const,
            tool_use_id: block.toolUseId,
            content: block.content.map((part) => ({ type: "text" as const, text: part.text })),
            is_error: block.isError,
          },
    ),
  };
}

function toWireTool(tool: ToolSpec): WireTool {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function buildRequestBody(request: ChatRequest): WireRequestBody {
  const params: GenerationParams = request.params ?? {};
  const body: {
    model: string;
    max_tokens: number;
    messages: readonly WireMessage[];
    stream: true;
    system?: string;
    tools?: readonly WireTool[];
    temperature?: number;
    top_p?: number;
    stop_sequences?: readonly string[];
  } = {
    model: resolveModel(request.model),
    max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map(toWireMessage),
    stream: true,
  };
  if (request.system !== undefined) {
    body.system = request.system;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map(toWireTool);
  }
  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  if (params.topP !== undefined) {
    body.top_p = params.topP;
  }
  if (params.stopSequences !== undefined) {
    body.stop_sequences = params.stopSequences;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Error translation (wire/HTTP -> contract ProviderError)
// ---------------------------------------------------------------------------

function errorEvent(error: ProviderError): ProviderErrorEvent {
  return { type: "error", error };
}

function networkErrorEvent(cause: unknown): ProviderErrorEvent {
  const message =
    cause instanceof Error && cause.message !== "" ? cause.message : "network request failed";
  return errorEvent({ message, retryable: true, code: "network" });
}

/**
 * True when the error is an abort raised by the request deadline
 * (`AbortSignal.timeout` rejects with a `TimeoutError` DOMException; a
 * cooperatively-aborting fetch surfaces `AbortError`).
 */
function isTimeoutAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

/** Final error event for an expired request deadline; retryable by design. */
function timeoutErrorEvent(timeoutMs: number): ProviderErrorEvent {
  return errorEvent({
    message: `Anthropic request timed out after ${timeoutMs}ms`,
    retryable: true,
    code: "timeout",
  });
}

/** Map an HTTP status + body detail onto the contract error shape. */
function httpErrorEvent(status: number, detail: string): ProviderErrorEvent {
  let retryable = false;
  let code = "request";
  if (status === 401 || status === 403) {
    code = "auth";
  } else if (status === 429) {
    retryable = true;
    code = "rate_limit";
  } else if (status === 529) {
    retryable = true;
    code = "overload"; // Anthropic's overloaded status
  } else if (status >= 500) {
    retryable = true;
    code = "server";
  } else if (status === 408) {
    retryable = true;
    code = "network";
  }
  const message =
    detail === ""
      ? `Anthropic API returned HTTP ${status}`
      : `Anthropic API returned HTTP ${status}: ${detail}`;
  return errorEvent({ message, retryable, code });
}

/** Map a mid-stream `error` frame onto the contract error shape. */
function streamErrorEvent(
  errorType: string | undefined,
  message: string | undefined,
): ProviderErrorEvent {
  // Undocumented mid-stream errors are predominantly transient (overload).
  let retryable = true;
  let code = "server";
  switch (errorType) {
    case "overloaded_error":
      code = "overload";
      break;
    case "rate_limit_error":
      code = "rate_limit";
      break;
    case "timeout_error":
      code = "network";
      break;
    case "authentication_error":
    case "permission_error":
      retryable = false;
      code = "auth";
      break;
    case "invalid_request_error":
    case "not_found_error":
      retryable = false;
      code = "request";
      break;
    default:
      break;
  }
  const detail = message ?? errorType ?? "stream error";
  return errorEvent({ message: `Anthropic stream error: ${detail}`, retryable, code });
}

/** Cap for error response bodies embedded in error messages. */
const MAX_ERROR_DETAIL_CHARS = 2048;

async function readErrorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return ""; // body unreadable; status alone still maps
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error)) {
        const message = str(error.message);
        if (message !== undefined && message !== "") {
          return capDetail(message);
        }
      }
      const message = str(parsed.message);
      if (message !== undefined && message !== "") {
        return capDetail(message);
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return capDetail(text);
}

/**
 * Keep embedded error bodies bounded (~2 KiB) with an explicit marker, so a
 * verbose HTML error page cannot flood transcripts, logs, and the model's
 * context through the error message.
 */
function capDetail(text: string): string {
  return text.length > MAX_ERROR_DETAIL_CHARS
    ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…[truncated, ${text.length} chars]`
    : text;
}

// ---------------------------------------------------------------------------
// Usage accumulation (message_start snapshot + message_delta revisions)
// ---------------------------------------------------------------------------

interface UsageAccumulator {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
}

function mergeUsage(acc: UsageAccumulator, wire: WireUsage | undefined): void {
  if (wire === undefined) {
    return;
  }
  if (wire.input_tokens !== undefined) {
    acc.inputTokens = wire.input_tokens;
  }
  if (wire.output_tokens !== undefined) {
    acc.outputTokens = wire.output_tokens;
  }
  if (wire.cache_read_input_tokens !== undefined) {
    acc.cacheReadTokens = wire.cache_read_input_tokens;
  }
  if (wire.cache_creation_input_tokens !== undefined) {
    acc.cacheCreationTokens = wire.cache_creation_input_tokens;
  }
}

function usageRecord(acc: UsageAccumulator): UsageRecord {
  return {
    inputTokens: acc.inputTokens ?? 0,
    outputTokens: acc.outputTokens ?? 0,
    ...(acc.cacheReadTokens !== undefined ? { cacheReadTokens: acc.cacheReadTokens } : {}),
    ...(acc.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: acc.cacheCreationTokens }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Stop reason + tool input
// ---------------------------------------------------------------------------

// Vendor stop reasons map 1:1 onto the contract literals; unknown/future
// reasons (e.g. "refusal") pass through VERBATIM because the StopReason
// contract is open (`| (string & {})`) — no mapping helper is needed.

/** Parse a tool-use block's accumulated `partial_json` into a contract ToolInput. */
function parseToolInput(json: string): ToolInput | undefined {
  const text = json.trim() === "" ? "{}" : json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isJsonObject(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";

  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.VOID_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Stream one turn. The HTTP request fires on the first pull of the returned
   * iterable (generator semantics); the iterable then ends with either
   * `turn_complete` or a single final `error` event.
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    if (this.apiKey === undefined) {
      yield errorEvent({
        message: "missing Anthropic API key (set VOID_ANTHROPIC_KEY or ANTHROPIC_API_KEY)",
        retryable: false,
        code: "auth",
      });
      return;
    }

    // Tolerate a base URL that already carries the versioned root (/v1):
    // mirror the Ollama adapter's normalizeBaseUrl semantics so both env
    // overrides behave the same (VOID_ANTHROPIC_BASE_URL=.../v1 must not
    // produce /v1/v1/messages).
    const base = this.baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${base}/v1/messages`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(buildRequestBody(request)),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      if (isTimeoutAbort(cause)) {
        yield timeoutErrorEvent(this.timeoutMs);
      } else {
        yield networkErrorEvent(cause);
      }
      return;
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      yield httpErrorEvent(response.status, detail);
      return;
    }

    const body = response.body;
    if (body === null) {
      yield errorEvent({
        message: "stream response has no body",
        retryable: false,
        code: "protocol",
      });
      return;
    }

    yield* streamBody(body, this.timeoutMs);
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const blocks: AssistantContentBlock[] = [];
    const toolNames = new Map<string, string>();
    let usage: UsageRecord = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason | undefined;

    for await (const event of this.stream(request)) {
      switch (event.type) {
        case "text_delta": {
          const last = blocks.at(-1);
          if (last !== undefined && last.type === "text") {
            blocks[blocks.length - 1] = { type: "text", text: last.text + event.text };
          } else {
            blocks.push({ type: "text", text: event.text });
          }
          break;
        }
        case "tool_use_start":
          toolNames.set(event.id, event.name);
          break;
        case "tool_use_end": {
          const name = toolNames.get(event.id);
          if (name === undefined) {
            throw new AnthropicCallError({
              message: `tool_use_end for unknown block ${event.id}`,
              retryable: false,
              code: "protocol",
            });
          }
          blocks.push({ type: "tool_use", id: event.id, name, input: event.input });
          break;
        }
        case "usage":
          usage = event.usage;
          break;
        case "turn_complete":
          stopReason = event.stopReason;
          break;
        case "error":
          throw new AnthropicCallError(event.error);
        default:
          break; // tool_use_delta: aggregated already at tool_use_end
      }
    }

    if (stopReason === undefined) {
      throw new AnthropicCallError({
        message: "stream ended without turn_complete",
        retryable: false,
        code: "protocol",
      });
    }
    return { content: blocks, usage, stopReason };
  }
}

/** Translate the vendor SSE body into contract events (module-level: no `this`). */
async function* streamBody(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
): AsyncGenerator<StreamEvent, void, unknown> {
  // Tool-use blocks are tracked by the wire's block `index`; the id and name
  // (needed by contract events) only appear on content_block_start.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  const usage: UsageAccumulator = {};
  let stopReason: StopReason | undefined;

  try {
    for await (const frame of parseSSE(body)) {
      const parsed = parseWireEvent(frame.data);
      if (!parsed.ok) {
        yield errorEvent({ message: parsed.message, retryable: false, code: "protocol" });
        return;
      }
      const event = parsed.event;
      if (event === undefined) {
        continue;
      }
      switch (event.type) {
        case "message_start":
          mergeUsage(usage, event.usage);
          break;
        case "content_block_start":
          if (event.toolUse !== undefined) {
            toolBlocks.set(event.index, {
              id: event.toolUse.id,
              name: event.toolUse.name,
              json: "",
            });
            yield { type: "tool_use_start", id: event.toolUse.id, name: event.toolUse.name };
          }
          break;
        case "content_block_delta": {
          if (event.textDelta !== undefined) {
            yield { type: "text_delta", text: event.textDelta };
          }
          if (event.inputDelta !== undefined) {
            const tool = toolBlocks.get(event.index);
            if (tool !== undefined) {
              tool.json += event.inputDelta;
              yield { type: "tool_use_delta", id: tool.id, inputDelta: event.inputDelta };
            }
          }
          break;
        }
        case "content_block_stop": {
          const tool = toolBlocks.get(event.index);
          if (tool !== undefined) {
            toolBlocks.delete(event.index);
            const input = parseToolInput(tool.json);
            if (input === undefined) {
              yield errorEvent({
                message: `tool_use block ${tool.id} streamed malformed JSON input`,
                retryable: false,
                code: "protocol",
              });
              return;
            }
            yield { type: "tool_use_end", id: tool.id, name: tool.name, input };
          }
          break;
        }
        case "message_delta":
          mergeUsage(usage, event.usage);
          if (event.stopReason !== undefined) {
            // Known literals map 1:1; unknown vendor reasons pass through
            // verbatim (stop-reason note in the section header above).
            stopReason = event.stopReason;
          }
          break;
        case "message_stop":
          yield { type: "usage", usage: usageRecord(usage) };
          yield { type: "turn_complete", stopReason: stopReason ?? "end_turn" };
          return;
        case "stream_error":
          yield streamErrorEvent(event.errorType, event.errorMessage);
          return;
      }
    }
  } catch (cause) {
    // Body read failed mid-stream: the request deadline expiring (abort) or a
    // connection reset both land here; timeouts get their own event.
    if (isTimeoutAbort(cause)) {
      yield timeoutErrorEvent(timeoutMs);
    } else {
      yield networkErrorEvent(cause);
    }
    return;
  }

  if (toolBlocks.size > 0) {
    // The stream died inside a tool_use block (start seen, stop never
    // arrived): the partial call is unusable and must be LOUD, not dropped —
    // a silent drop would look like the model never asked for the tool.
    yield errorEvent({
      message: `stream ended inside a tool_use block (${[...toolBlocks.values()].map((tool) => tool.id).join(", ")}); no content_block_stop arrived`,
      retryable: false,
      code: "protocol",
    });
    return;
  }

  yield errorEvent({
    message: "stream ended before message_stop",
    retryable: false,
    code: "protocol",
  });
}

/** Factory: the exported entrypoint for the provider registry. */
export function createAnthropicProvider(options?: AnthropicProviderOptions): Provider {
  return new AnthropicProvider(options);
}
