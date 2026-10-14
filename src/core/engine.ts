/**
 * `src/core/engine.ts` — the local turn engine (docs/architecture.md §core).
 *
 * Per turn: assemble a ChatRequest (system + history + tool specs + params) →
 * stream from the provider → aggregate text / tool-use / usage → dispatch each
 * tool call sequentially → append the assistant message and a tool-result user
 * message → repeat until the model ends its turn or a local guard
 * (`maxToolRounds` / `stopBudget`) fires. Budget and stop conditions are local
 * config (ADR-0002 property 1: the agent loop is this local process).
 *
 * Pure orchestration: no fs, no network, no console — all observation flows
 * through the `onEvent` callback and every dependency (provider, tools,
 * config) is injected. No globals. Expected tool failures (structured
 * ToolError) and unexpected throws both become `isError` tool results; the
 * loop never crashes on a tool. A round that ends without dispatching its
 * tool calls (provider error, truncated stream, guard, or terminal stop)
 * still records synthesized error tool results for every tool_use it
 * emitted, so the transcript never contains an unpaired tool_use block —
 * providers reject those on replay (Anthropic 400s).
 *
 * Event lifecycle emitted through `onEvent` (the surface wave-2's CLI
 * translates to stream-JSON):
 *
 * 1. `assistant_text_delta` — zero or more, as streamed;
 * 2. `turn_finished` — once per completed provider round, with cumulative
 *    usage totals (not emitted when the round failed);
 * 3. `tool_call_started` / `tool_call_finished` — around each execution,
 *    in dispatch order;
 * 4. `engine_stopped` — exactly once, always the final event, stating why the
 *    conversation ended (natural stop, provider error, or guard).
 */
import type {
  AssistantContentBlock,
  ChatMessage,
  GenerationParams,
  ModelRef,
  OutputLimits,
  PermissionRequestCallback,
  Provider,
  ProviderError,
  StopReason,
  TextResultBlock,
  ToolContext,
  ToolErrorCode,
  ToolInput,
  ToolResult,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
  UsageRecord,
  UserMessage,
} from "../contracts";
import { assembleChatRequest } from "./assemble";
import {
  type CompactionError,
  DEFAULT_COMPACTION_KEEP_TURNS,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  estimateContextTokens,
  meetsCompactionThreshold,
  messageChars,
  splitForCompaction,
  summarizePrefix,
  summaryMessage,
} from "./compaction";

// ---------------------------------------------------------------------------
// Public surface: registry, config, events, results
// ---------------------------------------------------------------------------

/** Tool lookup by name; built with {@link createToolRegistry}. */
export type ToolRegistry = Map<string, ToolSpec>;

/** Build a registry from specs, keyed by tool name; fails loudly on duplicates. */
export function createToolRegistry(specs: readonly ToolSpec[] = []): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const spec of specs) {
    if (registry.has(spec.name)) {
      throw new Error(`duplicate tool registration: "${spec.name}"`);
    }
    registry.set(spec.name, spec);
  }
  return registry;
}

/** Default cap on tool-execution rounds per conversation (docs §core). */
export const DEFAULT_MAX_TOOL_ROUNDS = 25;

/**
 * Fallback workspace root when config omits one. The engine is a pure module
 * and never reads `process.*`; the CLI layer must pass the real root.
 */
export const DEFAULT_WORKSPACE_ROOT = "/";

/** Default output caps handed to tools (docs §tools: limits are config, not magic). */
export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxTotalChars: 20_000,
  maxSectionChars: 2_000,
};

/**
 * Why a conversation ended: a natural provider stop, a provider/stream error,
 * or a local guard (`max_tool_rounds`, `budget_exceeded`).
 */
export type ConversationStopReason =
  | Exclude<StopReason, "tool_use">
  | "provider_error"
  | "max_tool_rounds"
  | "budget_exceeded";

/** Why a single turn (one provider round) ended. */
export type TurnStopReason = StopReason | "provider_error";

/**
 * Compaction policy (ADR-0008). Owned by the ENGINE loop: the check runs
 * before starting a new round. Absent config = compaction disabled.
 */
export interface CompactionConfig {
  /**
   * Resolved model context window in tokens — the threshold base. Unknown
   * windows (ollama passthrough) never trip the threshold; manual
   * {@link force} still works without one.
   */
  readonly contextWindow?: number;
  /** Percent of the window that trips compaction (default 90). */
  readonly thresholdPercent?: number;
  /** Newest turns kept verbatim after compaction (default 2). */
  readonly keepTurns?: number;
  /** The versioned summarization prompt (prompts/compaction.md). */
  readonly prompt: string;
  /** Force one compaction before the first round (`void resume --compact`). */
  readonly force?: boolean;
  /**
   * True when {@link contextWindow} came from the registry fallback rather
   * than a known model entry (ollama/openai passthrough). Reported verbatim
   * on compaction events so the assumption is consumer-visible.
   */
  readonly assumedContextWindow?: boolean;
}

/** One compaction executed during a conversation, in execution order. */
export interface CompactionRecord {
  readonly trigger: "threshold" | "manual";
  readonly summary: string;
  /** Provider turns (assistant rounds) this compaction replaced. */
  readonly summarizedTurns: number;
  /** Turns kept verbatim after the summary. */
  readonly keptTurns: number;
  /**
   * Conversation rounds completed when the compaction ran — the persistence
   * layer interleaves the compaction ThreadEvent after exactly that many
   * rounds' events, keeping the log chronologically ordered.
   */
  readonly afterRounds: number;
  /** Usage of the summarization call (recorded in usage events). */
  readonly usage: UsageRecord;
  /** Whether the threshold was computed against the fallback window. */
  readonly assumedContextWindow: boolean;
}

/** Progress events emitted through `EngineConfig.onEvent`; see module doc. */
export type EngineEvent =
  | { readonly type: "assistant_text_delta"; readonly text: string }
  | {
      readonly type: "tool_call_started";
      readonly toolUseId: string;
      readonly name: string;
      readonly input: ToolInput;
    }
  | {
      readonly type: "tool_call_finished";
      readonly toolUseId: string;
      readonly name: string;
      readonly resultSummary: string;
      /** Whether the finished result is an error result (from ToolResult.isError). */
      readonly isError: boolean;
    }
  | { readonly type: "turn_finished"; readonly stopReason: StopReason; readonly usage: UsageRecord }
  | {
      /** ADR-0008: the conversation prefix was replaced by a summary. */
      readonly type: "compaction";
      readonly trigger: "threshold" | "manual";
      readonly summary: string;
      readonly summarizedTurns: number;
      readonly keptTurns: number;
      readonly usage: UsageRecord;
      /** Whether the threshold was computed against the fallback window. */
      readonly assumedContextWindow: boolean;
    }
  | {
      readonly type: "engine_stopped";
      readonly reason: ConversationStopReason;
      readonly message?: string;
    };

/** Engine behavior knobs; everything optional, all locals (no globals). */
export interface EngineConfig {
  /** Max tool-execution rounds before the engine stops (default 25). */
  readonly maxToolRounds?: number;
  /**
   * Guard on cumulative usage: the engine stops (skipping queued tool calls)
   * once summed `inputTokens + outputTokens` across rounds EXCEEDS this.
   */
  readonly stopBudget?: number;
  /** Progress observer; must not throw (engine treats it as fire-and-forget). */
  readonly onEvent?: (event: EngineEvent) => void;
  /** Generation params passed through to every provider request. */
  readonly params?: GenerationParams;
  /** Workspace root used for the ToolContext handed to tools (default "/"). */
  readonly workspaceRoot?: string;
  /** Explicit tool environment (never implicitly `process.env`; default {}). */
  readonly env?: Readonly<Record<string, string>>;
  /** Permission escalation callback for `ask` outcomes (default: reject). */
  readonly requestPermission?: PermissionRequestCallback;
  /** Output caps for tools (default {@link DEFAULT_OUTPUT_LIMITS}). */
  readonly outputLimits?: OutputLimits;
  /**
   * Compaction policy (ADR-0008): the engine checks before every round
   * whether the estimated context has crossed the threshold (and honors a
   * one-shot force). Absent = compaction disabled.
   */
  readonly compaction?: CompactionConfig;
}

/** Inputs to {@link runConversation} and {@link runTurn}. */
export interface RunConversationOptions {
  readonly provider: Provider;
  readonly model: ModelRef;
  readonly registry: ToolRegistry;
  readonly system?: string;
  /** Initial history; usually one user message. The engine never mutates it. */
  readonly messages: readonly ChatMessage[];
  readonly config?: EngineConfig;
}

/** Final aggregate of a full conversation (all rounds). */
export interface ConversationResult {
  /**
   * Full history including every assistant message and tool-result user
   * message. Under compaction (ADR-0008) this is the NEVER-compacted
   * transcript — the compacted view providers saw ([summary, kept turns, …])
   * is engine-internal; persistence and replay reconstruct it from the log.
   */
  readonly messages: readonly ChatMessage[];
  /** Usage summed across every completed round (cache fields kept when > 0). */
  readonly totalUsage: UsageRecord;
  readonly stopReason: ConversationStopReason;
  /** Provider calls made (= provider rounds; summarization calls excluded). */
  readonly rounds: number;
  /** Compactions executed during the conversation, in order (ADR-0008). */
  readonly compactions?: readonly CompactionRecord[];
  /** Provider/stream error detail; present iff stopReason is "provider_error". */
  readonly error?: ProviderError;
}

/** Outcome of a single provider round, including its tool dispatch. */
export interface TurnResult {
  readonly messages: readonly ChatMessage[];
  readonly stopReason: TurnStopReason;
  readonly usage: UsageRecord;
  readonly executedToolCalls: number;
  readonly error?: ProviderError;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a conversation to completion: provider rounds + tool dispatch, looping
 * until the model ends its turn, errors, or a guard (`maxToolRounds` /
 * `stopBudget`) fires. Queued tool calls skipped by a guard are reported back
 * as `isError` tool results so the history stays a valid provider transcript.
 *
 * Compaction (ADR-0008): when configured, the engine checks BEFORE every
 * round whether the estimated context crossed the threshold (or a one-shot
 * force is pending) and replaces the conversation PREFIX with a summary from
 * the same provider. Two message lists are maintained: `messages` is the
 * NEVER-compacted full transcript (returned for persistence), while requests
 * carry the compacted VIEW ([summary, kept turns, …]) — the view always
 * shares the full list's tail, so rounds append to both at once. Summarization
 * failure stops the run (`provider_error`, remediation text, nothing
 * truncated).
 */
export async function runConversation(
  options: RunConversationOptions,
): Promise<ConversationResult> {
  const ctx = createRoundContext(options);
  const messages: ChatMessage[] = [...options.messages];
  let viewStart = 0; // messages before this index were summarized away
  let viewNote: UserMessage | undefined; // the summary message heading the view
  const view = (): readonly ChatMessage[] =>
    viewNote === undefined ? messages.slice(viewStart) : [viewNote, ...messages.slice(viewStart)];

  const compactions: CompactionRecord[] = [];
  let toolRounds = 0;
  let rounds = 0;
  let stop: ConversationStopReason | undefined;
  let error: ProviderError | undefined;

  while (stop === undefined) {
    // ADR-0008: the compaction check is owned by this loop and runs BEFORE a
    // new round starts — the previous round's usage is then known, and the
    // next request never carries turns that are about to be summarized.
    if (ctx.compaction !== undefined) {
      const check = await checkCompaction(ctx, view(), rounds);
      if (check.error !== undefined) {
        error = check.error;
        stop = "provider_error";
        break;
      }
      if (check.applied !== undefined) {
        viewNote = check.applied.note;
        viewStart = messages.length - check.applied.keptCount;
        compactions.push(check.applied.record);
      }
    }

    const outcome = await streamRound(ctx, view());
    messages.push(...outcome.appended);
    rounds += 1;

    if (outcome.error !== undefined) {
      error = outcome.error;
      // The round may have emitted tool_use blocks before failing; pair them
      // with synthesized error results so the transcript stays a valid
      // provider message sequence (Anthropic rejects unpaired tool_use).
      pushAppended(
        ctx,
        messages,
        buildUnpairedToolResultsMessage(
          outcome.toolCalls,
          `provider error: ${outcome.error.message}`,
        ),
      );
      stop = "provider_error";
      break;
    }
    const reason = outcome.stopReason;
    if (reason === undefined) {
      const truncated = truncatedStreamError();
      error = truncated;
      pushAppended(
        ctx,
        messages,
        buildUnpairedToolResultsMessage(outcome.toolCalls, truncated.message),
      );
      stop = "provider_error";
      break;
    }
    if (reason !== "tool_use") {
      // Terminal stop: any known literal or an unknown vendor reason passed
      // through verbatim (StopReason is open) ends the conversation like
      // "end_turn" — only "tool_use" continues with dispatch.
      pushAppended(
        ctx,
        messages,
        buildUnpairedToolResultsMessage(
          outcome.toolCalls,
          `model stopped with reason "${reason}" before tool results`,
        ),
      );
      stop = reason;
      break;
    }
    if (outcome.toolCalls.length === 0) {
      error = malformedToolUseError();
      stop = "provider_error";
      break;
    }

    if (ctx.stopBudget !== undefined && totalTokens(ctx.totals) > ctx.stopBudget) {
      pushAppended(
        ctx,
        messages,
        buildSkippedToolResultsMessage(
          outcome.toolCalls,
          `token budget of ${ctx.stopBudget} exceeded`,
        ),
      );
      stop = "budget_exceeded";
      break;
    }
    if (toolRounds >= ctx.maxToolRounds) {
      pushAppended(
        ctx,
        messages,
        buildSkippedToolResultsMessage(
          outcome.toolCalls,
          `max tool rounds (${ctx.maxToolRounds}) reached`,
        ),
      );
      stop = "max_tool_rounds";
      break;
    }

    toolRounds += 1;
    pushAppended(ctx, messages, await dispatchToolCalls(ctx, outcome.toolCalls));
  }

  const finalReason: ConversationStopReason = stop ?? "end_turn";
  const message = engineStopMessage(finalReason, error, ctx);
  emit(ctx, {
    type: "engine_stopped",
    reason: finalReason,
    ...(message !== undefined ? { message } : {}),
  });

  return {
    messages,
    totalUsage: toUsageRecord(ctx.totals),
    stopReason: finalReason,
    rounds,
    ...(compactions.length > 0 ? { compactions } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Run exactly one provider round over the given history: assemble → stream →
 * aggregate → (when the model asked for tools) execute them and append
 * results. Conversation-level guards — and compaction — do not apply; the
 * caller decides whether to continue with another round. Emits
 * stream/tool/turn_finished events but never `engine_stopped` (that event
 * belongs to the conversation loop) and never `compaction`.
 */
export async function runTurn(options: RunConversationOptions): Promise<TurnResult> {
  const ctx = createRoundContext(options);
  const messages: ChatMessage[] = [...options.messages];
  const outcome = await streamRound(ctx, messages);
  messages.push(...outcome.appended);
  let error = outcome.error;
  let executedToolCalls = 0;
  let stopReason: TurnStopReason;

  if (outcome.error !== undefined) {
    pushAppended(
      ctx,
      messages,
      buildUnpairedToolResultsMessage(
        outcome.toolCalls,
        `provider error: ${outcome.error.message}`,
      ),
    );
    stopReason = "provider_error";
  } else if (outcome.stopReason === undefined) {
    const truncated = truncatedStreamError();
    error = truncated;
    pushAppended(
      ctx,
      messages,
      buildUnpairedToolResultsMessage(outcome.toolCalls, truncated.message),
    );
    stopReason = "provider_error";
  } else if (outcome.stopReason !== "tool_use") {
    pushAppended(
      ctx,
      messages,
      buildUnpairedToolResultsMessage(
        outcome.toolCalls,
        `model stopped with reason "${outcome.stopReason}" before tool results`,
      ),
    );
    stopReason = outcome.stopReason;
  } else if (outcome.toolCalls.length === 0) {
    error = malformedToolUseError();
    stopReason = "provider_error";
  } else {
    pushAppended(ctx, messages, await dispatchToolCalls(ctx, outcome.toolCalls));
    executedToolCalls = outcome.toolCalls.length;
    stopReason = "tool_use";
  }

  return {
    messages,
    stopReason,
    usage: toUsageRecord(ctx.totals),
    executedToolCalls,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Append an engine-built message to the transcript and charge its chars. */
function pushAppended(
  ctx: RoundContext,
  messages: ChatMessage[],
  appended: ChatMessage | undefined,
): void {
  if (appended === undefined) {
    return;
  }
  messages.push(appended);
  ctx.charsSinceUsage += messageChars([appended]);
}

/** Clip length for `tool_call_finished` result summaries. */
const MAX_SUMMARY_CHARS = 120;

/**
 * One-line human/machine summary of a tool result for progress events:
 * `error(code): message` for failures, else the text content clipped to 120
 * chars. Deterministic — safe for stream-JSON emission.
 */
export function summarizeToolResult(result: ToolResult): string {
  if (result.isError) {
    const error = result.error;
    return error === undefined
      ? "error: tool reported an error without structured detail"
      : `error(${error.code}): ${error.message}`;
  }
  const text = result.content
    .filter((block): block is TextResultBlock => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  if (text.length === 0) return "(no output)";
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
}

// ---------------------------------------------------------------------------
// Internals: per-round context, streaming, dispatch
// ---------------------------------------------------------------------------

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Compaction policy after defaults/validation (see resolveCompactionConfig). */
interface ResolvedCompaction {
  /** Positive token count, or undefined when the model's window is unknown. */
  readonly contextWindow: number | undefined;
  readonly thresholdPercent: number;
  readonly keepTurns: number;
  readonly prompt: string;
  /** Whether `contextWindow` is the registry fallback rather than a known entry. */
  readonly assumedContextWindow: boolean;
}

interface RoundContext {
  readonly provider: Provider;
  readonly model: ModelRef;
  readonly system: string | undefined;
  readonly registry: ToolRegistry;
  readonly params: GenerationParams | undefined;
  readonly maxToolRounds: number;
  readonly stopBudget: number | undefined;
  readonly onEvent: ((event: EngineEvent) => void) | undefined;
  readonly toolContext: ToolContext;
  readonly totals: UsageTotals;
  /** Resolved compaction policy; undefined = disabled (ADR-0008). */
  readonly compaction?: ResolvedCompaction | undefined;
  /** One-shot manual force (`--compact`); cleared by the first check. */
  forceCompaction: boolean;
  /** Last provider-reported per-round usage (the estimation base). */
  lastUsage: UsageRecord | undefined;
  /** Chars appended since that report (chars/4 estimation numerator). */
  charsSinceUsage: number;
}

function createRoundContext(options: RunConversationOptions): RoundContext {
  const config = options.config;
  const workspaceRoot = config?.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const compaction = resolveCompactionConfig(config?.compaction);
  return {
    provider: options.provider,
    model: options.model,
    system: options.system,
    registry: options.registry,
    params: config?.params,
    maxToolRounds: config?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    stopBudget: config?.stopBudget,
    onEvent: config?.onEvent,
    toolContext: {
      workspaceRoot,
      workingDir: workspaceRoot,
      env: config?.env ?? {},
      requestPermission: config?.requestPermission ?? denyEscalationByDefault,
      outputLimits: config?.outputLimits ?? DEFAULT_OUTPUT_LIMITS,
    },
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ...(compaction !== undefined ? { compaction } : {}),
    forceCompaction: config?.compaction?.force ?? false,
    lastUsage: undefined,
    charsSinceUsage: 0,
  };
}

/**
 * Validate and resolve {@link CompactionConfig} into the context's policy.
 * Fail-loud on nonsensical knobs (bad config is a programming error, never a
 * runtime guess): empty prompt, negative keepTurns, out-of-range percent,
 * non-positive context window.
 */
function resolveCompactionConfig(
  config: CompactionConfig | undefined,
): ResolvedCompaction | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (config.prompt.trim().length === 0) {
    throw new Error("compaction.prompt must be a non-empty summarization prompt");
  }
  const keepTurns = config.keepTurns ?? DEFAULT_COMPACTION_KEEP_TURNS;
  if (!Number.isInteger(keepTurns) || keepTurns < 0) {
    throw new Error(`compaction.keepTurns must be a non-negative integer (got ${keepTurns})`);
  }
  const thresholdPercent = config.thresholdPercent ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT;
  if (thresholdPercent <= 0 || thresholdPercent > 100) {
    throw new Error(`compaction.thresholdPercent must be in (0, 100] (got ${thresholdPercent})`);
  }
  if (config.contextWindow !== undefined && config.contextWindow <= 0) {
    throw new Error(
      `compaction.contextWindow must be a positive token count (got ${config.contextWindow})`,
    );
  }
  return {
    contextWindow: config.contextWindow,
    thresholdPercent,
    keepTurns,
    prompt: config.prompt,
    assumedContextWindow: config.assumedContextWindow ?? false,
  };
}

// ---------------------------------------------------------------------------
// Compaction (ADR-0008): the pre-round check
// ---------------------------------------------------------------------------

/** Outcome of {@link checkCompaction}. */
interface CompactionCheck {
  /** Summarization failed: the caller must stop with `provider_error`. */
  readonly error?: ProviderError;
  /** Compaction applied: the view becomes [note, …kept tail]. */
  readonly applied?: {
    readonly note: UserMessage;
    readonly keptCount: number;
    readonly record: CompactionRecord;
  };
}

/**
 * The engine's pre-round compaction step (ADR-0008): estimate the context,
 * trip on the threshold or a pending manual force, summarize the prefix with
 * the SAME provider, and report the new view. A no-op when the estimate is
 * under the threshold or the conversation cannot shrink (turns <= keepTurns)
 * — the cannot-shrink no-op is also the re-trigger guard: a fresh compaction
 * leaves exactly `keepTurns` turns, so an estimate still over the threshold
 * cannot loop.
 */
async function checkCompaction(
  ctx: RoundContext,
  view: readonly ChatMessage[],
  roundsCompleted: number,
): Promise<CompactionCheck> {
  const policy = ctx.compaction;
  if (policy === undefined) {
    return {};
  }
  const forced = ctx.forceCompaction;
  ctx.forceCompaction = false; // one-shot: "before the next round", not forever
  const estimated = estimateContextTokens({
    ...(ctx.lastUsage !== undefined ? { lastUsage: ctx.lastUsage } : {}),
    localChars: ctx.charsSinceUsage,
  });
  const overThreshold =
    policy.contextWindow !== undefined &&
    meetsCompactionThreshold(estimated, policy.contextWindow, policy.thresholdPercent);
  if (!forced && !overThreshold) {
    return {};
  }

  const split = splitForCompaction(view, policy.keepTurns);
  if (split === undefined) {
    return {}; // nothing shrinkable: proceed (COMPACTION_CANNOT_SHRINK posture)
  }

  try {
    const { summary, usage } = await summarizePrefix({
      provider: ctx.provider,
      model: ctx.model,
      prompt: policy.prompt,
      prefix: split.prefix,
      ...(ctx.params !== undefined ? { params: ctx.params } : {}),
    });
    const summarizedTurns = split.totalTurns - policy.keepTurns;
    const record: CompactionRecord = {
      trigger: forced ? "manual" : "threshold",
      summary,
      summarizedTurns,
      keptTurns: policy.keepTurns,
      afterRounds: roundsCompleted,
      usage,
      assumedContextWindow: policy.assumedContextWindow,
    };
    accumulateUsage(ctx.totals, usage);
    emit(ctx, {
      type: "compaction",
      trigger: record.trigger,
      summary,
      summarizedTurns,
      keptTurns: record.keptTurns,
      usage,
      assumedContextWindow: policy.assumedContextWindow,
    });
    return {
      applied: { note: summaryMessage(summary), keptCount: split.kept.length, record },
    };
  } catch (cause) {
    return {
      error: isCompactionError(cause) ? cause.compactionError : unknownCompactionError(cause),
    };
  }
}

function isCompactionError(value: unknown): value is CompactionError {
  return (
    value instanceof Error &&
    "compactionError" in value &&
    typeof (value as CompactionError).compactionError === "object" &&
    (value as CompactionError).compactionError !== null
  );
}

function unknownCompactionError(cause: unknown): ProviderError {
  return {
    message:
      `compaction summarization failed unexpectedly: ${messageOf(cause)} — ` +
      "the conversation was NOT truncated; re-run to retry",
    retryable: false,
    code: "compaction_failed",
  };
}

/**
 * Default permission escalation answer: reject with remediation text. An
 * escalation must never silently succeed just because nobody wired a handler
 * (headless `ask` fails loudly — ADR-0003).
 */
const denyEscalationByDefault: PermissionRequestCallback = async (request) => ({
  action: "reject",
  message:
    `No permission handler is configured, so "${request.tool}" cannot be approved at runtime. ` +
    "Adjust permission rules or configure requestPermission.",
});

interface RoundStreamOutcome {
  /** Messages this round appended (the assistant message, if any). */
  readonly appended: readonly ChatMessage[];
  readonly stopReason: StopReason | undefined;
  readonly error: ProviderError | undefined;
  readonly toolCalls: readonly ToolUseBlock[];
}

/**
 * One provider call: assemble (from the given request messages — the full
 * list or the compacted view), stream, aggregate into an appended assistant
 * message + tool calls. Feeds the compaction estimator: a reported usage
 * event becomes the estimation base (its own output included via
 * `outputTokens`); without one, the appended message is charged at chars/4.
 */
async function streamRound(
  ctx: RoundContext,
  requestMessages: readonly ChatMessage[],
): Promise<RoundStreamOutcome> {
  const request = assembleChatRequest({
    model: ctx.model,
    system: ctx.system,
    messages: requestMessages,
    tools: registryToolSpecs(ctx.registry),
    params: ctx.params,
  });

  const textParts: string[] = [];
  const openToolCalls = new Map<string, string>(); // toolUseId -> name
  const toolCalls: ToolUseBlock[] = [];
  let usage: UsageRecord | undefined;
  let stopReason: StopReason | undefined;
  let error: ProviderError | undefined;

  try {
    for await (const event of ctx.provider.stream(request)) {
      switch (event.type) {
        case "text_delta":
          textParts.push(event.text);
          emit(ctx, { type: "assistant_text_delta", text: event.text });
          break;
        case "tool_use_start":
          openToolCalls.set(event.id, event.name);
          break;
        case "tool_use_delta":
          break; // providers deliver the parsed input with tool_use_end
        case "tool_use_end": {
          // Prefer the provider-supplied name, fall back to the start event;
          // an orphan end (start never seen) recovers when it carries a name.
          const name = event.name ?? openToolCalls.get(event.id);
          openToolCalls.delete(event.id);
          if (name !== undefined) {
            toolCalls.push({ type: "tool_use", id: event.id, name, input: event.input });
          }
          break;
        }
        case "usage":
          usage = event.usage; // one authoritative record per round; last wins
          break;
        case "turn_complete":
          stopReason = event.stopReason;
          break;
        case "error":
          error = event.error;
          break;
      }
      if (stopReason !== undefined || error !== undefined) break; // stream is over
    }
  } catch (thrown) {
    // Contract says errors arrive as events, but a throwing iterable must not
    // crash the loop either.
    error = {
      message: `provider stream threw instead of emitting an error event: ${messageOf(thrown)}`,
      retryable: false,
      code: "stream_failure",
    };
  }

  const content: AssistantContentBlock[] = [];
  const text = textParts.join("");
  if (text.length > 0) content.push({ type: "text", text });
  content.push(...toolCalls);

  const appended: ChatMessage[] = [];
  if (content.length > 0) appended.push({ role: "assistant", content });

  accumulateUsage(ctx.totals, usage ?? { inputTokens: 0, outputTokens: 0 });
  if (usage !== undefined) {
    ctx.lastUsage = usage;
    ctx.charsSinceUsage = 0; // this round's own output rides in outputTokens
  } else if (appended.length > 0) {
    // No usage report: charge the assistant message at chars/4 (conservative).
    ctx.charsSinceUsage += messageChars(appended);
  }
  if (stopReason !== undefined) {
    emit(ctx, { type: "turn_finished", stopReason, usage: toUsageRecord(ctx.totals) });
  }

  return { appended, stopReason, error, toolCalls };
}

/** Execute queued tool calls sequentially; returns their results user message. */
async function dispatchToolCalls(
  ctx: RoundContext,
  calls: readonly ToolUseBlock[],
): Promise<ChatMessage | undefined> {
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    emit(ctx, {
      type: "tool_call_started",
      toolUseId: call.id,
      name: call.name,
      input: call.input,
    });
    const result = await executeRegisteredTool(ctx, call);
    results.push({
      type: "tool_result",
      toolUseId: call.id,
      content: result.content,
      isError: result.isError,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    emit(ctx, {
      type: "tool_call_finished",
      toolUseId: call.id,
      name: call.name,
      resultSummary: summarizeToolResult(result),
      isError: result.isError,
    });
  }
  return buildToolResultsMessage(results);
}

/** Run one registered tool call; every failure path returns an error result. */
async function executeRegisteredTool(ctx: RoundContext, call: ToolUseBlock): Promise<ToolResult> {
  const spec = ctx.registry.get(call.name);
  if (spec === undefined) {
    return errorResult("invalid_input", `unknown tool "${call.name}"`, false);
  }
  try {
    const result = await spec.execute(call.input, ctx.toolContext);
    if (result === null || typeof result !== "object") {
      throw new Error(`tool returned ${typeof result} instead of a ToolResult`);
    }
    return result;
  } catch (thrown) {
    // Unexpected throw (a tool bug): surface as a structured error result so
    // the loop continues and the model can react.
    return errorResult(
      "execution_failed",
      `tool "${call.name}" threw: ${messageOf(thrown)}`,
      false,
    );
  }
}

/** The user message carrying finished tool results; undefined when empty. */
function buildToolResultsMessage(results: readonly ToolResultBlock[]): ChatMessage | undefined {
  if (results.length === 0) {
    return undefined;
  }
  return { role: "user", content: [...results] };
}

/** Guard stops skip execution but still record isError results for each call. */
function buildSkippedToolResultsMessage(
  calls: readonly ToolUseBlock[],
  reason: string,
): ChatMessage | undefined {
  const text = `Tool call not executed: ${reason}`;
  const results = calls.map(
    (call): ToolResultBlock => ({
      type: "tool_result",
      toolUseId: call.id,
      content: [{ type: "text", text }],
      isError: true,
    }),
  );
  return buildToolResultsMessage(results);
}

/**
 * Pair tool_use blocks a round emitted but never had dispatched (the stream
 * errored, truncated, or stopped before results) with synthesized error
 * results, mirroring the guard-skip pattern: the transcript must stay a valid
 * provider message sequence — Anthropic rejects a tool_use without its
 * matching tool_result on the next request. No-op when the round emitted no
 * tool calls.
 */
function buildUnpairedToolResultsMessage(
  calls: readonly ToolUseBlock[],
  stopText: string,
): ChatMessage | undefined {
  const reason = stopText.length > 200 ? `${stopText.slice(0, 200)}…` : stopText;
  return buildSkippedToolResultsMessage(calls, reason);
}

function emit(ctx: RoundContext, event: EngineEvent): void {
  ctx.onEvent?.(event);
}

function engineStopMessage(
  reason: ConversationStopReason,
  error: ProviderError | undefined,
  ctx: RoundContext,
): string | undefined {
  switch (reason) {
    case "provider_error":
      return error?.message ?? "provider error";
    case "budget_exceeded":
      return `cumulative usage of ${totalTokens(ctx.totals)} tokens exceeded the stopBudget of ${ctx.stopBudget}`;
    case "max_tool_rounds":
      return `stopped after reaching the max of ${ctx.maxToolRounds} tool rounds`;
    default:
      return undefined; // natural provider stop; the reason field says it all
  }
}

function truncatedStreamError(): ProviderError {
  return {
    message: "provider stream ended without turn_complete or error",
    retryable: false,
    code: "truncated_stream",
  };
}

function malformedToolUseError(): ProviderError {
  return {
    message:
      'provider stopped with reason "tool_use" but the stream contained no complete tool calls',
    retryable: false,
    code: "malformed_turn",
  };
}

function errorResult(code: ToolErrorCode, message: string, retryable: boolean): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, retryable },
  };
}

/** Registry specs as a deterministically ordered (name-sorted) list; undefined when empty. */
function registryToolSpecs(registry: ToolRegistry): ToolSpec[] | undefined {
  if (registry.size === 0) return undefined;
  const specs = [...registry.values()];
  specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return specs;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function accumulateUsage(totals: UsageTotals, record: UsageRecord): void {
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cacheReadTokens += record.cacheReadTokens ?? 0;
  totals.cacheCreationTokens += record.cacheCreationTokens ?? 0;
}

/** Tokens counted against `stopBudget`: input + output (cache fields excluded). */
function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

function toUsageRecord(totals: UsageTotals): UsageRecord {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.cacheReadTokens > 0 ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(totals.cacheCreationTokens > 0 ? { cacheCreationTokens: totals.cacheCreationTokens } : {}),
  };
}
