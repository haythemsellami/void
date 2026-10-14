/**
 * OpenAI-compat core — the shared implementation behind every provider that
 * speaks the OpenAI `/chat/completions` SSE wire (roadmap workstream 5, P1).
 *
 * Extracted verbatim from the Ollama adapter (its tests pass UNMODIFIED
 * through the wrapper): request mapping, the tiny local SSE parser, streamed
 * tool-call accumulation, usage/stop mapping, and the loud-truncation /
 * loud-error-frame semantics the v0.1.0 review fixes pinned. Thin adapters
 * (`providers/ollama.ts`, `providers/openai.ts`) supply only what actually
 * differs between services:
 *
 * - `providerId` — the registry id AND the label in every error message
 *   ("cannot reach ollama at …", "openai HTTP 401"), so users see which
 *   service failed;
 * - `endpoint` — the fully normalized `…/chat/completions` URL (adapters own
 *   base-URL defaults and env resolution; {@link normalizeBaseUrl} is shared);
 * - `modelPrefix` — the ModelRef prefix stripped before the id goes on the
 *   wire ("ollama/", "openai/"); bare ids pass through unchanged;
 * - `headers` — extra request headers (e.g. `authorization: Bearer …`);
 *   content-type/accept are fixed here;
 * - `makeCallError` — the adapter-typed error `complete()` throws.
 *
 * Design notes carried over from the Ollama adapter (behavioral contract of
 * this module, pinned by both adapters' tests):
 * - Every OpenAI-wire type is file-local; no vendor vocabulary leaks into the
 *   contracts layer (wire fields are read through optional chaining plus
 *   `typeof` guards after a single documented `unknown` cast at the JSON
 *   boundary, the escape ADR-0001 allows).
 * - `fetchImpl` is injectable so tests run fully offline against scripted SSE
 *   bodies; adapters default it to the global fetch.
 * - Streamed tool-call arguments are accumulated per `index` and parsed once
 *   the call completes (the stream moves to another index, a finish_reason
 *   arrives, or the stream ends); a parse failure ends the stream with a
 *   non-retryable `protocol` error.
 * - Error frames never vanish: a chunk carrying a top-level `error` member
 *   (OpenAI shape, `{"error": {...}}` or `{"error": "text"}`) ends the stream
 *   with a final `error` event built from the error body. The wire carries no
 *   status on these frames, so the event uses code "server"; it is marked
 *   retryable ONLY when the error's type/code text clearly names a transient
 *   condition (timeout / overload / rate limit / temporary) — deterministic
 *   server-side failures (model not found, malformed request) would fail
 *   identically on retry, so they stay non-retryable.
 * - Truncation is loud, never silent: when the stream ends (body EOF or the
 *   `[DONE]` sentinel) after text or tool events were emitted but no
 *   finish_reason was ever observed, the stream ends with a non-retryable
 *   `protocol` error ("stream ended before finish_reason") instead of
 *   inventing `end_turn`. The one exception: a completely empty stream (no
 *   content, no finish_reason) still completes as a zero-usage `end_turn`
 *   turn, matching observed behavior for immediately-done requests.
 * - Services frequently omit usage on streamed turns: a zero usage event is
 *   always emitted before turn_complete so consumers never see one without
 *   the other.
 */
import type {
  AssistantContentBlock,
  AssistantMessage,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ModelRef,
  ProviderCallError,
  ProviderError,
  ProviderErrorEvent,
  StopReason,
  StreamEvent,
  ToolUseBlock,
  UsageRecord,
  UserContentBlock,
} from "../contracts/provider";
import type { JsonSchema, ToolInput, ToolResultContentBlock, ToolSpec } from "../contracts/tools";

/** Minimal fetch signature the wire client needs; the global fetch satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Deadline for one request (connect + headers + the entire streamed body). */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Builds the adapter-typed error `complete()` throws when the stream ended in
 * an error event. Structural on purpose (see ProviderCallError): the core
 * never assumes a concrete class.
 */
export type CallErrorFactory = (error: ProviderError) => ProviderCallError;

/** Everything an OpenAI-wire adapter supplies; see the module doc. */
export interface OpenAiCompatOptions {
  /** Registry id ("ollama", "openai"); also the label in error messages. */
  readonly providerId: string;
  /** Fully normalized endpoint URL, ending in `/chat/completions`. */
  readonly endpoint: string;
  /** ModelRef prefix stripped before the id goes on the wire; "" for none. */
  readonly modelPrefix: string;
  /** Fetch implementation; adapters inject tests' fakes or default to global. */
  readonly fetchImpl: FetchLike;
  /** Deadline for one request; on expiry the stream ends with a retryable `timeout` error. */
  readonly timeoutMs: number;
  /** Extra request headers (authorization etc.); content-type/accept are fixed. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Builds the error `complete()` throws on a failed stream. */
  readonly makeCallError: CallErrorFactory;
}

// ---------------------------------------------------------------------------
// OpenAI-wire types (file-local by design — never exported, never in contracts)
// ---------------------------------------------------------------------------

interface WireRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

type WireMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly WireRequestToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface WireToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
}

interface WireChatRequest {
  readonly model: string;
  readonly stream: true;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly WireToolSpec[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stop?: readonly string[];
}

interface WireStreamToolCall {
  readonly index: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface WireStreamDelta {
  readonly role?: string;
  readonly content?: string | null;
  readonly tool_calls?: readonly WireStreamToolCall[];
}

interface WireStreamChoice {
  readonly index?: number;
  readonly delta?: WireStreamDelta;
  readonly finish_reason?: string | null;
}

interface WireUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

/** OpenAI-style error body: `{"error": {"message": …, "type": …, "code": …}}`. */
interface WireError {
  readonly message?: unknown;
  readonly type?: unknown;
  readonly code?: unknown;
}

interface WireStreamChunk {
  readonly choices?: readonly WireStreamChoice[];
  readonly usage?: WireUsage | null;
  readonly error?: WireError | string | null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE: UsageRecord = { inputTokens: 0, outputTokens: 0 };

/**
 * Normalize a service base URL: trim, strip trailing slashes, and append the
 * conventional `/v1` suffix when the user's value lacks one — so
 * `http://h:11434`, `http://h:11434/`, `http://h:11434/v1`, and
 * `http://h:11434/v1/` all hit the same endpoint, and service paths that
 * already end in `/v1` (OpenAI, Moonshot, Groq's `/openai/v1`, OpenRouter's
 * `/api/v1`) pass through untouched.
 */
export function normalizeBaseUrl(raw: string): string {
  let base = raw.trim();
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  if (!base.endsWith("/v1")) {
    base += "/v1";
  }
  return base;
}

/** Strip the adapter's ModelRef prefix; bare model ids pass through unchanged. */
export function stripModelPrefix(model: ModelRef, prefix: string): string {
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** Internal sentinel: a malformed wire payload that ends the stream as `protocol`. */
class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolViolation";
  }
}

// ---------------------------------------------------------------------------
// Request mapping (contracts -> wire)
// ---------------------------------------------------------------------------

function buildWireRequest(request: ChatRequest, modelPrefix: string): WireChatRequest {
  const params = request.params;
  return {
    model: stripModelPrefix(request.model, modelPrefix),
    stream: true,
    messages: mapMessages(request.system, request.messages),
    ...(request.tools !== undefined && request.tools.length > 0
      ? { tools: mapTools(request.tools) }
      : {}),
    ...(params?.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params?.maxOutputTokens !== undefined ? { max_tokens: params.maxOutputTokens } : {}),
    ...(params?.stopSequences !== undefined && params.stopSequences.length > 0
      ? { stop: [...params.stopSequences] }
      : {}),
  };
}

function mapTools(tools: readonly ToolSpec[]): readonly WireToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function mapMessages(system: string | undefined, messages: readonly ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system !== undefined && system.length > 0) {
    wire.push({ role: "system", content: system });
  }
  for (const message of messages) {
    if (message.role === "assistant") {
      wire.push(mapAssistantMessage(message));
    } else {
      mapUserBlocks(message.content, wire);
    }
  }
  return wire;
}

function mapAssistantMessage(message: AssistantMessage): WireMessage {
  const texts: string[] = [];
  const toolCalls: WireRequestToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  const content = texts.join("\n");
  return {
    role: "assistant",
    content: content.length > 0 ? content : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function mapUserBlocks(blocks: readonly UserContentBlock[], out: WireMessage[]): void {
  let pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length > 0) {
      out.push({ role: "user", content: pendingText.join("\n") });
      pendingText = [];
    }
  };
  for (const block of blocks) {
    if (block.type === "text") {
      pendingText.push(block.text);
    } else {
      flushText();
      out.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: summarizeResultContent(block.content),
      });
    }
  }
  flushText();
}

function summarizeResultContent(content: readonly ToolResultContentBlock[]): string {
  return content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// SSE parsing (tiny local parser; src/providers/sse.ts is another agent's file)
// ---------------------------------------------------------------------------

interface EventBoundary {
  readonly index: number;
  readonly length: number;
}

function findEventBoundary(buffer: string): EventBoundary | null {
  const candidates: readonly EventBoundary[] = [
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ];
  let best: EventBoundary | null = null;
  for (const candidate of candidates) {
    if (candidate.index === -1) {
      continue;
    }
    if (best === null || candidate.index < best.index) {
      best = candidate;
    }
  }
  return best;
}

function dataLinesOf(block: string): string[] {
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.startsWith(":")) {
      continue; // comment / keepalive
    }
    if (line.startsWith("data:")) {
      const payload = line.slice("data:".length);
      data.push(payload.startsWith(" ") ? payload.slice(1) : payload);
    }
    // Other SSE fields (event:, id:, retry:) carry nothing we need.
  }
  return data;
}

/**
 * Yields the `data:` payload of every SSE event in `body`, stopping at (and
 * swallowing) the `data: [DONE]` sentinel. Tolerates events split across
 * stream chunks and \n / \r\n / \r line endings, and processes a trailing
 * unterminated event at stream end.
 */
async function* sseDataPayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findEventBoundary(buffer);
      while (boundary !== null) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        for (const data of dataLinesOf(block)) {
          if (data === "[DONE]") {
            return;
          }
          yield data;
        }
        boundary = findEventBoundary(buffer);
      }
    }
    buffer += decoder.decode(); // flush any pending multi-byte sequence
    if (buffer.length > 0) {
      for (const data of dataLinesOf(buffer)) {
        if (data === "[DONE]") {
          return;
        }
        yield data;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Chunk mapping (wire -> contracts events)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function parseChunk(data: string): WireStreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ProtocolViolation(`SSE data payload is not valid JSON: ${data.slice(0, 120)}`);
  }
  if (!isRecord(parsed)) {
    throw new ProtocolViolation("SSE data payload is not a JSON object");
  }
  // Vendor-schema boundary (ADR-0001's documented escape): every field below
  // is read through optional chaining and typeof guards, so the cast cannot
  // turn into a runtime crash on unexpected shapes.
  return parsed as unknown as WireStreamChunk;
}

function mapUsage(usage: WireUsage): UsageRecord {
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
  };
}

function mapFinishReason(finishReason: string): StopReason {
  switch (finishReason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      // "stop" and any unrecognized value: the model ended its turn.
      return "end_turn";
  }
}

function protocolErrorEvent(message: string): ProviderErrorEvent {
  return { type: "error", error: { message, retryable: false, code: "protocol" } };
}

/**
 * Build the final error event for an OpenAI-style `error` frame that arrived
 * mid-stream. Retryability policy (documented in the module header): frames
 * carry no HTTP status, so the event uses code "server" and is retryable only
 * when the body's type/code text clearly names a transient condition.
 */
function streamFrameErrorEvent(label: string, error: WireError | string): ProviderErrorEvent {
  let body: string;
  if (typeof error === "string") {
    body = error;
  } else if (typeof error.message === "string" && error.message.length > 0) {
    body = error.message;
  } else {
    body = JSON.stringify(error);
  }
  if (body.length > 300) {
    body = `${body.slice(0, 300)}…`;
  }
  const kind =
    typeof error === "string" ? "" : `${String(error.type ?? "")} ${String(error.code ?? "")}`;
  const transient = /timeout|overload|rate.?limit|temporar/.test(kind.toLowerCase());
  return {
    type: "error",
    error: {
      message: `${label} stream error: ${body}`,
      retryable: transient,
      code: "server",
    },
  };
}

function networkErrorEvent(label: string, endpoint: string, err: unknown): ProviderErrorEvent {
  return {
    type: "error",
    error: {
      message: `cannot reach ${label} at ${endpoint}: ${errorMessage(err)}`,
      retryable: true,
      code: "network",
    },
  };
}

/**
 * True when the error is an abort raised by the request deadline
 * (`AbortSignal.timeout` rejects with a `TimeoutError` DOMException; a
 * cooperatively-aborting fetch surfaces `AbortError`).
 */
function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Final error event for an expired request deadline; retryable by design. */
function timeoutErrorEvent(label: string, endpoint: string, timeoutMs: number): ProviderErrorEvent {
  return {
    type: "error",
    error: {
      message: `${label} request to ${endpoint} timed out after ${timeoutMs}ms`,
      retryable: true,
      code: "timeout",
    },
  };
}

async function httpErrorEvent(label: string, response: Response): Promise<ProviderErrorEvent> {
  const status = response.status;
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  let serverMessage = body;
  const parsed: unknown = body.length > 0 ? safeJsonParse(body) : undefined;
  if (isRecord(parsed) && typeof parsed.error === "string") {
    serverMessage = parsed.error;
  } else if (
    isRecord(parsed) &&
    isRecord(parsed.error) &&
    typeof parsed.error.message === "string"
  ) {
    // OpenAI-style object error body: {"error": {"message": …}}.
    serverMessage = parsed.error.message;
  }
  if (serverMessage.length > 300) {
    serverMessage = serverMessage.slice(0, 300);
  }
  const message =
    serverMessage.length > 0
      ? `${label} HTTP ${status}: ${serverMessage}`
      : `${label} HTTP ${status}`;
  let code: string;
  let retryable: boolean;
  if (status === 404) {
    code = "model_not_found";
    retryable = false;
  } else if (status === 401 || status === 403) {
    code = "auth";
    retryable = false;
  } else if (status === 429) {
    code = "rate_limit";
    retryable = true;
  } else if (status >= 500) {
    code = "server";
    retryable = true;
  } else {
    code = "invalid_request";
    retryable = false;
  }
  return { type: "error", error: { message, retryable, code } };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Streamed tool-call accumulation
// ---------------------------------------------------------------------------

interface ToolCallDraft {
  readonly id: string;
  name: string;
  args: string;
  started: boolean;
}

function parseToolArguments(draft: ToolCallDraft): ToolInput {
  const raw = draft.args.trim();
  if (raw.length === 0) {
    // Servers may open a tool call and close it with no arguments at all.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolViolation(
      `tool call ${draft.id} (${draft.name}): streamed arguments are not valid JSON: ${raw.slice(0, 120)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProtocolViolation(
      `tool call ${draft.id} (${draft.name}): streamed arguments are not a JSON object`,
    );
  }
  return parsed as ToolInput;
}

/**
 * Accumulator state shared by the stream loop: drafts for calls that opened
 * but have not emitted their `tool_use_end` yet, keyed by wire index.
 */
interface ToolCallAccumulator {
  readonly open: ToolCallDraft[];
  readonly byIndex: Map<number, ToolCallDraft>;
}

function continueOrCreate(
  toolCall: WireStreamToolCall,
  acc: ToolCallAccumulator,
  finalizeOpen: () => StreamEvent[],
): StreamEvent[] {
  const existing = acc.byIndex.get(toolCall.index);
  if (existing !== undefined) {
    return continueCall(existing, toolCall);
  }
  // A new index means every previously open call is complete.
  const events = finalizeOpen();
  const draft: ToolCallDraft = {
    id: toolCall.id ?? `tcall_${toolCall.index}`,
    name: toolCall.function?.name ?? "",
    args: toolCall.function?.arguments ?? "",
    started: false,
  };
  acc.byIndex.set(toolCall.index, draft);
  acc.open.push(draft);
  if (draft.name.length > 0) {
    draft.started = true;
    events.push({ type: "tool_use_start", id: draft.id, name: draft.name });
    if (draft.args.length > 0) {
      events.push({ type: "tool_use_delta", id: draft.id, inputDelta: draft.args });
    }
  }
  return events;
}

function continueCall(draft: ToolCallDraft, toolCall: WireStreamToolCall): StreamEvent[] {
  const events: StreamEvent[] = [];
  const name = toolCall.function?.name;
  if (!draft.started && name !== undefined && name.length > 0) {
    // Name arrived in a later fragment: open the block now, then flush the
    // arguments buffered before it as one delta.
    draft.name = name;
    draft.started = true;
    events.push({ type: "tool_use_start", id: draft.id, name });
    if (draft.args.length > 0) {
      events.push({ type: "tool_use_delta", id: draft.id, inputDelta: draft.args });
    }
  }
  const fragment = toolCall.function?.arguments;
  if (fragment !== undefined && fragment.length > 0) {
    draft.args += fragment;
    if (draft.started) {
      events.push({ type: "tool_use_delta", id: draft.id, inputDelta: fragment });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// The shared wire client
// ---------------------------------------------------------------------------

/**
 * The shared OpenAI-wire client behind the ollama and openai adapters. Not a
 * `Provider` itself — adapters wrap it, owning their id, defaults, env
 * resolution, and error class. Behavior (and its pinned tests) is exactly the
 * Ollama adapter's, generalized per {@link OpenAiCompatOptions}.
 */
export class OpenAiCompatClient {
  private readonly options: OpenAiCompatOptions;

  constructor(options: OpenAiCompatOptions) {
    this.options = options;
  }

  stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    return this.runStream(request);
  }

  private async *runStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const { providerId, endpoint, fetchImpl, timeoutMs, headers } = this.options;
    const wireRequest = buildWireRequest(request, this.options.modelPrefix);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
        body: JSON.stringify(wireRequest),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeoutAbort(err)) {
        yield timeoutErrorEvent(providerId, endpoint, timeoutMs);
      } else {
        yield networkErrorEvent(providerId, endpoint, err);
      }
      return;
    }
    if (!response.ok) {
      yield await httpErrorEvent(providerId, response);
      return;
    }
    const body = response.body;
    if (body === null) {
      yield protocolErrorEvent(`${providerId} returned an empty body from ${endpoint}`);
      return;
    }

    const acc: ToolCallAccumulator = { open: [], byIndex: new Map() };
    const finalizeOpen = (): StreamEvent[] => {
      const events: StreamEvent[] = [];
      for (const draft of acc.open) {
        if (!draft.started) {
          // The call closes without a name ever arriving; open it with the
          // (empty) accumulated name so start/end pairing stays intact.
          draft.started = true;
          events.push({ type: "tool_use_start", id: draft.id, name: draft.name });
        }
        events.push({
          type: "tool_use_end",
          id: draft.id,
          name: draft.name,
          input: parseToolArguments(draft),
        });
      }
      acc.open.length = 0;
      acc.byIndex.clear();
      return events;
    };

    let stopReason: StopReason | undefined;
    let usage: UsageRecord | undefined;
    let sawContent = false; // any text_delta or tool event emitted this stream
    try {
      for await (const data of sseDataPayloads(body)) {
        const chunk = parseChunk(data);
        if (chunk.error != null) {
          // An OpenAI-style error frame ends the turn; it must surface, not
          // vanish into the choices-less-chunk `continue` below.
          yield streamFrameErrorEvent(providerId, chunk.error);
          return;
        }
        if (chunk.usage != null) {
          usage = mapUsage(chunk.usage);
        }
        const choice = chunk.choices?.[0];
        if (choice === undefined) {
          continue;
        }
        const delta = choice.delta;
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          sawContent = true;
          yield { type: "text_delta", text: delta.content };
        }
        if (delta?.tool_calls !== undefined) {
          for (const toolCall of delta.tool_calls) {
            for (const event of continueOrCreate(toolCall, acc, finalizeOpen)) {
              sawContent = true;
              yield event;
            }
          }
        }
        const finishReason = choice.finish_reason;
        if (typeof finishReason === "string" && finishReason.length > 0) {
          stopReason = mapFinishReason(finishReason);
          for (const event of finalizeOpen()) {
            yield event;
          }
        }
      }
      for (const event of finalizeOpen()) {
        yield event;
      }
      if (stopReason === undefined && sawContent) {
        // Torn stream: the server delivered content (now fully reported,
        // including any open tool calls above) but never said why the turn
        // ended — no finish_reason before EOF/[DONE]. Fail loudly instead of
        // inventing end_turn; an empty stream (no content) still completes
        // normally, pinned by tests.
        yield protocolErrorEvent("stream ended before finish_reason");
        return;
      }
      yield { type: "usage", usage: usage ?? ZERO_USAGE };
      yield { type: "turn_complete", stopReason: stopReason ?? "end_turn" };
    } catch (err) {
      if (isTimeoutAbort(err)) {
        // The deadline aborted the fetch or a stalled body read mid-stream.
        yield timeoutErrorEvent(providerId, endpoint, timeoutMs);
      } else if (err instanceof ProtocolViolation) {
        yield protocolErrorEvent(err.message);
      } else {
        yield {
          type: "error",
          error: {
            message: `${providerId} stream failed: ${errorMessage(err)}`,
            retryable: true,
            code: "network",
          },
        };
      }
    }
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    let text = "";
    const drafts = new Map<string, { name: string; input: ToolInput }>();
    let usage: UsageRecord = ZERO_USAGE;
    let stopReason: StopReason = "end_turn";
    for await (const event of this.stream(request)) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "tool_use_start":
          drafts.set(event.id, { name: event.name, input: {} });
          break;
        case "tool_use_delta":
          break; // the parsed input arrives with tool_use_end
        case "tool_use_end": {
          const draft = drafts.get(event.id);
          if (draft !== undefined) {
            draft.input = event.input;
          }
          break;
        }
        case "usage":
          usage = event.usage;
          break;
        case "turn_complete":
          stopReason = event.stopReason;
          break;
        case "error":
          throw this.options.makeCallError(event.error);
      }
    }
    const content: AssistantContentBlock[] = [];
    if (text.length > 0) {
      content.push({ type: "text", text });
    }
    for (const [id, draft] of drafts) {
      const toolUse: ToolUseBlock = { type: "tool_use", id, name: draft.name, input: draft.input };
      content.push(toolUse);
    }
    return { content, usage, stopReason };
  }
}
