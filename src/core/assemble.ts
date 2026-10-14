/**
 * `src/core/assemble.ts` — pure ChatRequest assembly (docs/architecture.md §core).
 *
 * Keeps the engine lean: building the request object (system prompt + message
 * history + tool specs + generation params) is a pure transformation carrying
 * no engine state. Optional parts that are absent (or empty) are omitted from
 * the request so providers never see empty strings/lists where they expect
 * `undefined`.
 */
import type { ChatMessage, ChatRequest, GenerationParams, ModelRef, ToolSpec } from "../contracts";

/** The pieces a ChatRequest is assembled from; every optional part may be omitted. */
export interface ChatRequestParts {
  readonly model: ModelRef;
  /**
   * System prompt (ADR-0002 property 2: a versioned repo file or user
   * override). Explicitly accepts `undefined` so pass-through callers do not
   * need conditional spreads (exactOptionalPropertyTypes).
   */
  readonly system?: string | undefined;
  /** Full message history for this request, newest message last. */
  readonly messages: readonly ChatMessage[];
  /** Tool specs exposed to the model this turn; an empty list is treated as absent. */
  readonly tools?: readonly ToolSpec[] | undefined;
  readonly params?: GenerationParams | undefined;
}

/** Assemble a ChatRequest from parts, omitting absent or empty optional fields. */
export function assembleChatRequest(parts: ChatRequestParts): ChatRequest {
  const { model, system, messages, tools, params } = parts;
  return {
    model,
    ...(system !== undefined && system.length > 0 ? { system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(params !== undefined ? { params } : {}),
  };
}
