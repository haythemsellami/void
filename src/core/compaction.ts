/**
 * `src/core/compaction` — context-compaction helpers for the turn engine
 * (ADR-0008): token estimation, the keep-newest-turns split, the summary
 * message replay materializes, and the summarization provider call.
 *
 * Pure policy plus ONE injected provider call: no fs, no globals. The engine
 * owns WHEN (its loop checks before every round); this module defines HOW.
 * Fail-loud discipline: summarization failures throw {@link CompactionError}
 * carrying a vendor-neutral ProviderError; the engine converts that into a
 * `provider_error` stop — never a silent truncation.
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
  UsageRecord,
  UserMessage,
} from "../contracts";

/**
 * Conservative chars-per-token ratio for locally-appended content (tool
 * results, synthesized messages). Deliberately a rough OVER-estimate of
 * context growth: compacting early is cheap, compacting late is fatal.
 */
export const CHARS_PER_TOKEN = 4;

/** Default percent of the context window that trips threshold compaction. */
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 90;

/** Default number of newest turns compaction keeps verbatim. */
export const DEFAULT_COMPACTION_KEEP_TURNS = 2;

/**
 * The exact one-line marker prefixing a summary message in the folded
 * transcript (amended ADR-0008: the summary materializes as a USER message
 * whose text is `[compaction summary]\n<summary>` — ChatMessage has no system
 * role mid-conversation). Pinned so the engine's live view and replayFold's
 * rendering stay byte-identical.
 */
export const COMPACTION_SUMMARY_MARKER = "[compaction summary]";

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/** Inputs to {@link estimateContextTokens}. */
export interface ContextEstimateInput {
  /**
   * Last provider-reported usage for this conversation, when a round has
   * completed. `inputTokens` covers everything sent; `outputTokens` the
   * assistant turn it produced — their sum approximates the next request's
   * input.
   */
  readonly lastUsage?: UsageRecord;
  /**
   * Characters appended to the conversation SINCE that usage report (tool
   * results, synthesized results; assistant output is covered by
   * `outputTokens` when the provider reported usage).
   */
  readonly localChars: number;
}

/**
 * Estimate the context the NEXT request would carry: last reported
 * `input + output` tokens plus chars/4 for local additions. Conservative by
 * construction — both terms round toward compacting early.
 */
export function estimateContextTokens(input: ContextEstimateInput): number {
  const base =
    input.lastUsage === undefined ? 0 : input.lastUsage.inputTokens + input.lastUsage.outputTokens;
  return base + Math.ceil(input.localChars / CHARS_PER_TOKEN);
}

/** Total JSON chars of the given messages (the chars/4 numerator). */
export function messageChars(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += JSON.stringify(message).length;
  }
  return total;
}

/**
 * Threshold check in exact integer arithmetic (`estimate*100 >= window*pct`)
 * so the boundary has no float drift: an estimate of exactly
 * `window * percent / 100` trips; one token below does not.
 */
export function meetsCompactionThreshold(
  estimatedTokens: number,
  contextWindow: number,
  thresholdPercent: number,
): boolean {
  if (contextWindow <= 0 || thresholdPercent <= 0) {
    return false;
  }
  return estimatedTokens * 100 >= contextWindow * thresholdPercent;
}

// ---------------------------------------------------------------------------
// Splitting: which turns does compaction summarize, which does it keep?
// ---------------------------------------------------------------------------

/** Result of {@link splitForCompaction}. */
export interface CompactionSplit {
  /** Conversation prefix to summarize (always starts at the first message). */
  readonly prefix: readonly ChatMessage[];
  /**
   * Newest turns kept verbatim: the last `keepTurns` assistant rounds plus
   * anything trailing them (the current task message is never summarized).
   */
  readonly kept: readonly ChatMessage[];
  /** Total provider turns (assistant messages) in the input list. */
  readonly totalTurns: number;
}

/**
 * Split a conversation for compaction: everything older than the newest
 * `keepTurns` assistant rounds becomes the prefix; the tail is kept verbatim.
 * `keepTurns === 0` keeps only what trails the final round — the current task
 * message is never summarized away. Returns undefined when there is nothing
 * to shrink (total turns <= keepTurns) — the engine treats that as a no-op
 * (Amp's COMPACTION_CANNOT_SHRINK posture: proceed, never fail, never loop).
 */
export function splitForCompaction(
  messages: readonly ChatMessage[],
  keepTurns: number,
): CompactionSplit | undefined {
  const assistantIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndexes.push(index);
    }
  }
  if (assistantIndexes.length <= keepTurns) {
    return undefined;
  }
  const lastAssistant = assistantIndexes[assistantIndexes.length - 1];
  if (lastAssistant === undefined) {
    return undefined;
  }
  let boundary: number;
  if (keepTurns > 0) {
    // The assistant opening the keepTurns-th-from-last round starts the kept
    // window; guaranteed defined because length > keepTurns.
    boundary = assistantIndexes[assistantIndexes.length - keepTurns] ?? messages.length;
  } else {
    // Keep zero rounds: only messages AFTER the final round survive (a
    // trailing user task, if any). Walk past the final round's result run so
    // kept never starts with an orphan tool_result.
    boundary = lastAssistant + 1;
    while (boundary < messages.length) {
      const message = messages[boundary];
      if (
        message?.role === "user" &&
        message.content.some((block) => block.type === "tool_result")
      ) {
        boundary += 1;
        continue;
      }
      break;
    }
  }
  return {
    prefix: messages.slice(0, boundary),
    kept: messages.slice(boundary),
    totalTurns: assistantIndexes.length,
  };
}

/**
 * The user message a summary becomes in the conversation view AND in the
 * replay fold: text exactly `[compaction summary]\n<summary>`
 * (amended ADR-0008 — ChatMessage has no system role mid-conversation).
 */
export function summaryMessage(summary: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${COMPACTION_SUMMARY_MARKER}\n${summary}` }],
  };
}

// ---------------------------------------------------------------------------
// The summarization call
// ---------------------------------------------------------------------------

/** Options for {@link summarizePrefix}. */
export interface SummarizePrefixOptions {
  readonly provider: Provider;
  readonly model: ModelRef;
  /** The versioned compaction prompt (prompts/compaction.md), as system. */
  readonly prompt: string;
  /** The conversation prefix to summarize. */
  readonly prefix: readonly ChatMessage[];
  /** Generation params forwarded from the engine config, when set. */
  readonly params?: GenerationParams | undefined;
}

/** A successful summarization: the summary text and the call's usage. */
export interface PrefixSummary {
  readonly summary: string;
  readonly usage: UsageRecord;
}

/**
 * Thrown by {@link summarizePrefix}: carries the vendor-neutral
 * {@link ProviderError} (with compaction remediation text) the engine
 * converts into a `provider_error` stop. Structural like
 * ProviderCallError — narrow on `compactionError`, not `instanceof`.
 */
export interface CompactionError extends Error {
  readonly compactionError: ProviderError;
}

const REMEDIATION =
  "the conversation was NOT truncated and the thread log is intact; " +
  "re-run to retry, or resume with a smaller keepTurns window";

function compactionError(message: string, retryable: boolean, code: string): CompactionError {
  const error: CompactionError = Object.assign(new Error(message), {
    name: "CompactionError",
    compactionError: { message, retryable, code },
  });
  return error;
}

function isProviderCallError(value: unknown): value is ProviderCallError {
  return (
    value instanceof Error &&
    "providerError" in value &&
    typeof (value as ProviderCallError).providerError === "object" &&
    (value as ProviderCallError).providerError !== null
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask the SAME provider (non-streaming `complete()`) to summarize the prefix,
 * using the versioned compaction prompt as the system message and NO tools.
 * Throws {@link CompactionError} on any failure — the caller stops the run.
 */
export async function summarizePrefix(options: SummarizePrefixOptions): Promise<PrefixSummary> {
  const request: ChatRequest = {
    model: options.model,
    system: options.prompt,
    messages: options.prefix,
    ...(options.params !== undefined ? { params: options.params } : {}),
  };

  let completion: ChatCompletion;
  try {
    completion = await options.provider.complete(request);
  } catch (cause) {
    const detail = isProviderCallError(cause) ? cause.providerError : undefined;
    throw compactionError(
      `compaction summarization failed: ${detail?.message ?? messageOf(cause)} — ${REMEDIATION}`,
      detail?.retryable ?? false,
      "compaction_failed",
    );
  }

  const textBlocks = completion.content.filter(
    (block): block is Extract<AssistantContentBlock, { type: "text" }> => block.type === "text",
  );
  const summary = textBlocks
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (summary.length === 0) {
    throw compactionError(
      `compaction summarization failed: the model returned an empty summary — ${REMEDIATION}`,
      true,
      "compaction_empty_summary",
    );
  }
  return { summary, usage: completion.usage };
}
