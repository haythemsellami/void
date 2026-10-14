/**
 * Provider contract: the single streaming interface every LLM adapter
 * implements (docs/architecture.md §providers).
 *
 * Implemented by `providers/` (MVP: anthropic + ollama, plus an in-repo mock
 * provider for tests). Consumed by `core/` (turn engine). Deliberately
 * provider-agnostic: no field or event may encode vendor-specific wire detail —
 * adapters translate to/from their own wire format internally.
 *
 * Types only; imports are the tool shapes referenced by requests and messages.
 */
import type { ToolError, ToolInput, ToolResultContentBlock, ToolSpec } from "./tools";

/** Model reference as resolved from the local model registry (e.g. "anthropic/claude-…"). */
export type ModelRef = string;

/** Reasoning-effort hint for models that support it; providers ignore it when unsupported. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Generation parameters; all optional (provider defaults apply). */
export interface GenerationParams {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * Nucleus sampling cutoff. Per-provider best-effort: adapters forward it
   * only when their backend supports it (the ollama adapter currently drops
   * it; the anthropic adapter maps it to `top_p`).
   */
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  /**
   * Reasoning-effort hint. Per-provider best-effort: adapters ignore it for
   * models without a reasoning knob (the ollama adapter currently drops it).
   */
  readonly reasoningEffort?: ReasoningEffort;
}

/** A plain text block. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** A completed tool call as emitted by the model. */
export interface ToolUseBlock {
  readonly type: "tool_use";
  /** Provider-assigned id, echoed by the matching tool_result block. */
  readonly id: string;
  readonly name: string;
  /** Parsed input object (providers accumulate streamed JSON into this). */
  readonly input: ToolInput;
}

/**
 * The outcome of a tool call, sent back to the model in the next request.
 *
 * Cross-provider convention: `isError` has no representation on the OpenAI
 * wire — the ollama adapter flattens error results into plain text content,
 * while the anthropic adapter maps this field to `is_error`. Engine →
 * provider direction only.
 */
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: readonly ToolResultContentBlock[];
  readonly isError: boolean;
  /**
   * Structured provider-facing failure detail, populated by the engine from
   * the executed tool's `ToolResult.error`. Present iff `isError` is true and
   * structured detail exists; providers that cannot carry it flatten the
   * message into text (see the convention note above).
   */
  readonly error?: ToolError;
}

/** Blocks a user message may contain. */
export type UserContentBlock = TextBlock | ToolResultBlock;

/** Blocks an assistant message may contain. */
export type AssistantContentBlock = TextBlock | ToolUseBlock;

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly UserContentBlock[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AssistantContentBlock[];
}

export type ChatMessage = UserMessage | AssistantMessage;

/** One request to a provider: everything a single turn needs. */
export interface ChatRequest {
  readonly model: ModelRef;
  /**
   * System prompt. ADR-0002 property 2: always a versioned repo file (or user
   * override) — never assembled remotely.
   */
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  /** Tools the model may call this turn (providers read name/description/inputSchema). */
  readonly tools?: readonly ToolSpec[];
  readonly params?: GenerationParams;
}

/** Token usage for one turn, as reported by the provider. */
export interface UsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

/**
 * Why the model's turn ended. The literal members exhaust the cases the MVP
 * providers produce; unknown vendor reasons pass through VERBATIM via the
 * open `(string & {})` tail (e.g. anthropic's `"refusal"`). Consumers MUST
 * treat any value outside the literals as a terminal natural end, exactly
 * like `"end_turn"` — never as an error. Cross-provider convention:
 * `"stop_sequence"` is unreachable from ollama (its OpenAI-compatible wire
 * reports no equivalent finish reason).
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | (string & {});

/** Vendor-neutral error surfaced mid-stream or from a failed request. */
export interface ProviderError {
  readonly message: string;
  /** True when an identical retry could succeed (rate limit, transient network). */
  readonly retryable: boolean;
  /** Free-form machine-readable hint (e.g. "auth", "overload"); vendor-neutral. */
  readonly code?: string;
}

/**
 * Structural error type `complete()` implementations THROW when the turn
 * ended in a provider failure instead of a completion: an Error carrying the
 * vendor-neutral {@link ProviderError} the stream would have reported as its
 * final error event. Structural on purpose — do not rely on `instanceof`
 * across adapter modules; narrow on the `providerError` property.
 */
export interface ProviderCallError extends Error {
  readonly providerError: ProviderError;
}

/** Incremental text from the assistant. */
export interface TextDeltaEvent {
  readonly type: "text_delta";
  readonly text: string;
}

/** A tool-use block opened by the model. */
export interface ToolUseStartEvent {
  readonly type: "tool_use_start";
  readonly id: string;
  readonly name: string;
}

/** Raw partial JSON text appended to a tool-use block's input. */
export interface ToolUseDeltaEvent {
  readonly type: "tool_use_delta";
  readonly id: string;
  readonly inputDelta: string;
}

/** A tool-use block completed; `input` is the fully parsed object. */
export interface ToolUseEndEvent {
  readonly type: "tool_use_end";
  readonly id: string;
  /**
   * The tool's name, when the provider knows it at block completion.
   * Optional for compatibility with streams that only deliver the name on
   * `tool_use_start`; consumers may use it to recover an orphan end event
   * (an end whose matching start was never seen).
   */
  readonly name?: string;
  readonly input: ToolInput;
}

/** Usage accounting (typically one record per completed turn). */
export interface UsageEvent {
  readonly type: "usage";
  readonly usage: UsageRecord;
}

/** The model finished its turn; the stream ends after this event. */
export interface TurnCompleteEvent {
  readonly type: "turn_complete";
  readonly stopReason: StopReason;
}

/** A recoverable or fatal error reported through the stream itself. */
export interface ProviderErrorEvent {
  readonly type: "error";
  readonly error: ProviderError;
}

/**
 * Streaming events of one turn, as a discriminated union on `type`. Ordering
 * contract: text_delta/tool_use_* interleave as emitted; a usage event and then
 * turn_complete (or a final error event) terminate the stream.
 */
export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseEndEvent
  | UsageEvent
  | TurnCompleteEvent
  | ProviderErrorEvent;

/** Final aggregate of one non-streamed (or aggregated) turn. */
export interface ChatCompletion {
  readonly content: readonly AssistantContentBlock[];
  readonly usage: UsageRecord;
  readonly stopReason: StopReason;
}

/**
 * The provider interface. MVP adapters: anthropic, ollama, mock (in-repo).
 *
 * Error channels are asymmetric BY CONTRACT: `stream()` reports expected
 * failures as a final `error` event, while `complete()` throws.
 */
export interface Provider {
  /** Registry key of this adapter (e.g. "anthropic", "ollama"). */
  readonly id: string;
  /**
   * Stream one turn. Expected errors arrive as a final `error` event, not by
   * throwing; the iterable ends after turn_complete or error.
   */
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  /**
   * Non-streaming convenience: aggregate the turn into a ChatCompletion.
   *
   * Error channel: unlike `stream()`, `complete()` THROWS on expected
   * failures — specifically a {@link ProviderCallError}-shaped Error whose
   * `providerError` field carries the structured detail the stream would
   * have delivered as its final error event.
   */
  complete(request: ChatRequest): Promise<ChatCompletion>;
}
