/**
 * `src/app/runner` — the composition root (docs/architecture.md §interface,
 * ADR-0003). Wires the frozen wave-1 components into one runnable task:
 * provider by ModelRef prefix, the builtin tools behind a permission
 * gate, context assembly (repo system prompt + AGENTS.md chain), the turn
 * engine, and thread persistence.
 *
 * Pure and testable: no `process.*` reads, no console — everything injectable
 * (provider, fetch, store, clock, id source), observation through callbacks.
 *
 * Permission model: every tool call is evaluated against the ordered rules
 * BEFORE execution (the gate wraps each ToolSpec). `allow` proceeds; `reject`
 * and — headless, ADR-0003 — `ask`/`delegate` come back to the model as a
 * structured `permission_denied` tool result with remediation text, while the
 * gate records what happened for the stream-JSON layer and the exit code:
 *
 *   exit 2 (rejected) > exit 1 (ask hit headless) > exit 3 (provider/stream
 *   error) > exit 0 (success; includes local guard stops like max_tool_rounds,
 *   which surface via stopReason instead of a nonzero exit).
 */

import { collectAgentsContext } from "../context/agents-md";
import { loadCompactionPrompt, loadDefaultPrompt } from "../context/prompts";
import type { ThreadStore } from "../contracts";
import {
  threadId as brandThreadId,
  type ChatMessage,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRequestCallback,
  type PermissionRule,
  type Provider,
  type ThreadEvent,
  type ThreadId,
  type ToolContext,
  type ToolInput,
  type ToolResult,
  type ToolResultBlock,
  type ToolSpec,
  type UsageRecord,
  type UserMessage,
} from "../contracts";
import { splitForCompaction, summaryMessage } from "../core/compaction";
import {
  type CompactionConfig,
  type CompactionRecord,
  type ConversationResult,
  createToolRegistry,
  type EngineEvent,
  runConversation,
  type ToolRegistry,
} from "../core/engine";
import { DEFAULT_RULES, evaluate } from "../permissions";
import { createAnthropicProvider } from "../providers/anthropic";
import { OllamaProvider } from "../providers/ollama";
import { OpenAIProvider } from "../providers/openai";
import type { DiscoveredSkill, DiscoverSkillsOptions, SkillsRunContext } from "../skills";
import { skillsPromptSection } from "../skills/render";
import { JsonlThreadStore } from "../store/jsonl";
import {
  asyncShellCommandKillTool,
  asyncShellCommandStatusTool,
  asyncShellCommandTool,
} from "../tools/async-shell";
import { bashTool } from "../tools/bash";
import { editFileTool } from "../tools/edit_file";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { readFileTool } from "../tools/read_file";
import { createSkillTools } from "../tools/skill";
import { createTaskTool, type TaskToolDeps } from "../tools/task";
import { CUSTOM_FALLBACK_CONTEXT_WINDOW, resolveModel } from "./models";

/** Fetch signature both provider adapters accept (init always passed by them). */
export type AppFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Setup failures of the composition root (mapped by the CLI to exit 3). */
export class RunnerError extends Error {
  constructor(
    readonly code: "unknown_provider" | "unknown_thread",
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

/** Provider construction options (pure: credentials are passed in, never read from env here). */
export interface ProviderOptions {
  readonly fetchImpl?: AppFetchLike;
  /** Anthropic API key; default: the adapter's env lookup (VOID_ANTHROPIC_KEY/ANTHROPIC_API_KEY). */
  readonly apiKey?: string;
  /** Ollama base URL; default: the adapter's env lookup (VOID_OLLAMA_URL). */
  readonly ollamaBaseUrl?: string;
  /** OpenAI-compatible base URL; default: the adapter's env lookup (VOID_OPENAI_BASE_URL). */
  readonly openaiBaseUrl?: string;
  /** OpenAI-compatible API key; default: the adapter's env lookup (VOID_OPENAI_KEY). */
  readonly openaiApiKey?: string;
  /**
   * Anthropic base URL; default: the adapter's `https://api.anthropic.com`.
   * Set for Anthropic-compatible endpoints (e.g. Z.AI's
   * `https://api.z.ai/anthropic` for the GLM registry entries).
   */
  readonly anthropicBaseUrl?: string;
  /**
   * Per-request deadline handed to BOTH adapters (connect + full streamed
   * body). Default: each adapter's own 120_000 ms. On expiry the provider
   * stream ends with a retryable `timeout` error instead of hanging.
   */
  readonly timeoutMs?: number;
}

/** Resolve a ModelRef to its provider adapter by prefix. Throws RunnerError on unknown prefixes. */
export function resolveProvider(modelRef: string, options: ProviderOptions = {}): Provider {
  const entry = resolveModel(modelRef);
  if (entry.providerKind === "anthropic") {
    return createAnthropicProvider({
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.anthropicBaseUrl !== undefined ? { baseURL: options.anthropicBaseUrl } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (entry.providerKind === "ollama") {
    return new OllamaProvider({
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.ollamaBaseUrl !== undefined ? { baseUrl: options.ollamaBaseUrl } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (entry.providerKind === "openai") {
    // ADR-0010: the generic OpenAI-compatible adapter; endpoint binding is
    // env/option-driven (ADR-0009), never registry-driven.
    return new OpenAIProvider({
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.openaiBaseUrl !== undefined ? { baseUrl: options.openaiBaseUrl } : {}),
      ...(options.openaiApiKey !== undefined ? { apiKey: options.openaiApiKey } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  throw new RunnerError(
    "unknown_provider",
    `unknown provider in model ref ${JSON.stringify(modelRef)}: the MVP ships ` +
      `"anthropic/<model-id>", "ollama/<model-id>", and "openai/<model-id>" ` +
      "(set --model or VOID_MODEL)",
  );
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

/** One evaluated tool-call decision, recorded for the stream and the exit code. */
export interface PermissionGateRecord {
  readonly tool: string;
  readonly input: ToolInput;
  /** The rule engine's action ("allow" | "reject" | "ask" | "delegate"). */
  readonly action: PermissionDecision["action"];
  /** True when the call did NOT run (everything but allow in headless mode). */
  readonly headlessDenied: boolean;
  /** evaluate()'s audit line (matched rule / default policy). */
  readonly reason: string;
  readonly message?: string;
}

/** Live state the exit-code computation reads after the run. */
export interface PermissionGateState {
  askOccurred: boolean;
  rejectedOccurred: boolean;
}

export interface PermissionGate {
  /** Callback the engine AND the tool wrappers consult. */
  readonly requestPermission: PermissionRequestCallback;
  /** Every decision taken, in order. */
  readonly records: readonly PermissionGateRecord[];
  readonly state: PermissionGateState;
}

export interface BuildPermissionGateOptions {
  /** Workspace root for `context`-scoped rules. */
  readonly workspaceRoot?: string;
  /** Live decision sink (stream-JSON emission). */
  readonly onRecord?: (record: PermissionGateRecord) => void;
}

const HEADLESS_DENIAL_NOTE =
  "Void is running headless and cannot ask interactively (ADR-0003), so the call was denied. " +
  "Adjust the permission rules to allow this call, then re-run.";

/**
 * Build the permission gate over an ordered rule list: re-evaluates the rules
 * for every escalation (tool calls route through it via the wrapped registry)
 * and maps decisions for headless use — allow proceeds, everything else is a
 * structured denial carrying the rule's reason and remediation.
 */
export function buildPermissionGate(
  rules: readonly PermissionRule[] = DEFAULT_RULES,
  options: BuildPermissionGateOptions = {},
): PermissionGate {
  const state: PermissionGateState = { askOccurred: false, rejectedOccurred: false };
  const records: PermissionGateRecord[] = [];
  const gate: PermissionGate = {
    state,
    records,
    requestPermission: async (request: PermissionRequest): Promise<PermissionDecision> => {
      const outcome = evaluate(request.tool, request.input, rules, {
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
      });
      const action = outcome.decision.action;
      if (action === "reject") {
        state.rejectedOccurred = true;
      }
      if (action === "ask" || action === "delegate") {
        state.askOccurred = true; // headless: asking IS denying (ADR-0003)
      }
      const decision: PermissionDecision =
        action === "allow"
          ? { action: "allow" }
          : {
              action: "reject",
              message:
                action === "reject"
                  ? `${outcome.decision.message ?? outcome.reason} — denied by a permission rule.`
                  : `${outcome.decision.message ?? outcome.reason} — ${HEADLESS_DENIAL_NOTE}`,
            };
      const record: PermissionGateRecord = {
        tool: request.tool,
        input: request.input,
        action,
        headlessDenied: action !== "allow",
        reason: outcome.reason,
        ...(decision.message !== undefined ? { message: decision.message } : {}),
      };
      records.push(record);
      options.onRecord?.(record);
      return decision;
    },
  };
  return gate;
}

/** The ToolResult a denied call returns to the model (never a throw). */
function permissionDeniedResult(tool: string, decision: PermissionDecision): ToolResult {
  const message =
    decision.message ??
    `permission for "${tool}" was denied before execution; adjust the rules and re-run`;
  return {
    content: [{ type: "text", text: `Permission denied for ${tool}: ${message}` }],
    isError: true,
    error: { code: "permission_denied", message, retryable: false },
  };
}

/**
 * Registry of the builtins with every call permission-gated: the wrapper
 * routes through the gate BEFORE the real execute; allow runs, anything else
 * returns the structured denial. The engine's own escalation path is the same
 * gate, so a tool-initiated ask gets an identical answer.
 *
 * Consolidated options shape (reviewer N1, 2026-10-14 — task and skills
 * each evolved the signature in parallel; this is the reconciled API):
 * - `extraTools` (ADR-0011): MCP specs appended after the builtins; a name
 *   collision with a builtin fails loudly in createToolRegistry.
 * - `skills` (ADR-0012): adds the lazy-injection pair (`skill` +
 *   `reload_skills`). Pass only when at least one valid skill was
 *   discovered — with zero skills the tools would be dead entries enlarging
 *   every provider request (lazy injection keeps default context small).
 * - `taskDeps` (ADR-0013): the `task` builtin joins when provided — it needs
 *   the provider/model/rules the parent run has, which a bare test build
 *   does not. The runner ALWAYS provides them; BUILTIN_TOOLS advertises
 *   `task` unconditionally and the anti-drift pin builds with stub wiring.
 */
export function buildToolRegistry(
  gate: PermissionGate,
  options: {
    readonly extraTools?: readonly ToolSpec[];
    readonly skills?: DiscoverSkillsOptions;
    readonly taskDeps?: TaskToolDeps;
  } = {},
): ToolRegistry {
  const wrap = (spec: ToolSpec): ToolSpec => ({
    ...spec,
    async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const decision = await gate.requestPermission({
        tool: spec.name,
        input,
        reason: `tool call "${spec.name}" requires a permission decision`,
      });
      if (decision.action === "allow") {
        return spec.execute(input, ctx);
      }
      return permissionDeniedResult(spec.name, decision);
    },
  });
  const specs: ToolSpec[] = [
    bashTool,
    asyncShellCommandTool,
    asyncShellCommandStatusTool,
    asyncShellCommandKillTool,
    editFileTool,
    globTool,
    grepTool,
    readFileTool,
    // The spawn itself is gated by the PARENT gate like any builtin; the
    // child conversation inside runs its own subagent gate (tools/task).
    ...(options.taskDeps !== undefined ? [createTaskTool(options.taskDeps)] : []),
    ...extraToolsSafe(options),
  ];
  if (options.skills !== undefined) {
    const tools = createSkillTools(options.skills);
    specs.push(tools.skill, tools.reloadSkills);
  }
  return createToolRegistry(specs.map(wrap));
}

/** extraTools with a default that keeps the spread above type-safe. */
function extraToolsSafe(options: {
  readonly extraTools?: readonly ToolSpec[];
}): readonly ToolSpec[] {
  return options.extraTools ?? [];
}

// ---------------------------------------------------------------------------
// Thread persistence adapter
// ---------------------------------------------------------------------------

/** Timestamp source for persisted events (ISO-8601); caller stamps `at`. */
export type NowFn = () => string;

export interface ThreadAdapterOptions {
  readonly store: ThreadStore;
  readonly now: NowFn;
}

/** Open (or continue) a thread: metadata first for new threads, then the user turn. */
async function appendThreadStart(
  adapter: ThreadAdapterOptions,
  id: ThreadId,
  task: string,
  modelRef: string,
  isNew: boolean,
): Promise<void> {
  if (isNew) {
    const at = adapter.now();
    await adapter.store.append(id, {
      type: "thread_metadata",
      threadId: id,
      title: task.slice(0, 80),
      model: modelRef,
      createdAt: at,
      at,
    });
  }
  await adapter.store.append(id, {
    type: "user_message",
    message: { role: "user", content: [{ type: "text", text: task }] },
    at: adapter.now(),
  });
}

/**
 * Map the messages a run APPENDED (excluding the seed user message and any
 * replayed history) to ThreadEvents: one `assistant_message` per turn plus a
 * `tool_call` per tool_use block, `tool_result` per result block, and one
 * `usage` event per provider round (the per-round delta of the engine's
 * cumulative turn_finished usage).
 */
export function conversationToEvents(
  messages: readonly ChatMessage[],
  roundUsage: readonly UsageRecord[],
  at: NowFn,
): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  let round = 0; // assistant messages seen; roundUsage[round - 1] is its delta
  let roundOpen = false;
  const closeRound = (): void => {
    if (!roundOpen) {
      return;
    }
    const usage = roundUsage[round - 1];
    if (usage !== undefined) {
      events.push({ type: "usage", usage, at: at() });
    }
    roundOpen = false;
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      closeRound();
      events.push({ type: "assistant_message", message, at: at() });
      round += 1;
      roundOpen = true;
      for (const block of message.content) {
        if (block.type === "tool_use") {
          events.push({
            type: "tool_call",
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            at: at(),
          });
        }
      }
      continue;
    }
    const results = message.content.filter(
      (block): block is ToolResultBlock => block.type === "tool_result",
    );
    if (results.length > 0) {
      for (const block of results) {
        events.push({
          type: "tool_result",
          toolUseId: block.toolUseId,
          result: {
            content: block.content,
            isError: block.isError,
            ...(block.error !== undefined ? { error: block.error } : {}),
          },
          at: at(),
        });
      }
      closeRound();
    } else {
      events.push({ type: "user_message", message, at: at() });
    }
  }
  closeRound();
  return events;
}

/** Sum two usage records (cache fields kept only when the sum is positive). */
function addUsage(left: UsageRecord, right: UsageRecord): UsageRecord {
  const cacheRead = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0);
  const cacheCreation = (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
  };
}

/**
 * {@link conversationToEvents} plus compaction interleaving (ADR-0008): each
 * {@link CompactionRecord} is persisted as a `compaction` ThreadEvent —
 * followed by a `usage` event for the summarization call — directly after the
 * `afterRounds` conversation rounds that existed when it ran, so the log's
 * event order is exactly the run's chronological order. The summarized
 * rounds' events stay in the log (append-only, never rewritten); replayFold
 * derives the compacted view from the compaction event.
 */
export function conversationToEventsWithCompactions(
  messages: readonly ChatMessage[],
  compactions: readonly CompactionRecord[],
  roundUsage: readonly UsageRecord[],
  at: NowFn,
): ThreadEvent[] {
  if (compactions.length === 0) {
    return conversationToEvents(messages, roundUsage, at);
  }

  // Segment this run's messages into rounds: each assistant message opens a
  // round that swallows the non-assistant messages behind it; anything before
  // the first assistant is a prelude persisted as-is.
  const rounds: ChatMessage[][] = [];
  let firstAssistant = messages.length;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "assistant") {
      firstAssistant = index;
      break;
    }
  }
  const prelude = messages.slice(0, firstAssistant);
  for (let index = firstAssistant; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "assistant" || rounds.length === 0) {
      rounds.push([message]);
    } else {
      rounds[rounds.length - 1]?.push(message);
    }
  }

  const events: ThreadEvent[] = conversationToEvents(prelude, [], at);
  let flushed = 0;
  const flushRoundsThrough = (target: number): void => {
    while (flushed < target && flushed < rounds.length) {
      const round = rounds[flushed];
      if (round !== undefined) {
        const usage = roundUsage[flushed];
        events.push(...conversationToEvents(round, usage === undefined ? [] : [usage], at));
      }
      flushed += 1;
    }
  };
  for (const record of compactions) {
    flushRoundsThrough(record.afterRounds);
    events.push({
      type: "compaction",
      summary: record.summary,
      summarizedTurns: record.summarizedTurns,
      keptTurns: record.keptTurns,
      trigger: record.trigger,
      ...(record.assumedContextWindow ? { assumedContextWindow: true } : {}),
      at: at(),
    });
    events.push({ type: "usage", usage: record.usage, at: at() });
  }
  flushRoundsThrough(rounds.length);
  return events;
}

/**
 * Fold a thread log back into provider-ready ChatMessages (resume = replay):
 * `user_message`/`assistant_message` events become messages verbatim;
 * consecutive `tool_result` events group into one user tool-result message;
 * `tool_call` events are derived data (their tool_use blocks already live in
 * the assistant_message) and `usage`/`thread_metadata` carry no message
 * content — all three are skipped.
 *
 * Crash-torn defense: any tool_use block that never received its tool_result
 * event (the process died mid-dispatch before persisting) is paired with a
 * synthesized error result at the fold boundary, so the replayed history is
 * always a valid provider message sequence — the same invariant the engine
 * maintains for live runs. Without this, resuming a torn thread would replay
 * an unpaired tool_use that Anthropic rejects with a 400.
 */
export function replayFold(events: readonly ThreadEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pending: ToolResultBlock[] = [];
  // tool_use ids of the most recent assistant message still awaiting results.
  let openToolUses: string[] = [];
  const synthesizeMissing = (): void => {
    const answered = new Set(pending.map((block) => block.toolUseId));
    for (const id of openToolUses) {
      if (!answered.has(id)) {
        pending.push({
          type: "tool_result",
          toolUseId: id,
          content: [
            { type: "text", text: "Tool call not executed: result missing from thread log" },
          ],
          isError: true,
        });
      }
    }
    openToolUses = [];
  };
  const flush = (): void => {
    synthesizeMissing();
    if (pending.length > 0) {
      messages.push({ role: "user", content: pending });
      pending = [];
    }
  };
  for (const event of events) {
    switch (event.type) {
      case "user_message":
      case "assistant_message":
        flush();
        messages.push(event.message);
        if (event.message.role === "assistant") {
          openToolUses = event.message.content
            .filter((block) => block.type === "tool_use")
            .map((block) => block.id);
        }
        break;
      case "tool_result":
        pending.push({
          type: "tool_result",
          toolUseId: event.toolUseId,
          content: event.result.content,
          isError: event.result.isError,
          ...(event.result.error !== undefined ? { error: event.result.error } : {}),
        });
        break;
      case "compaction": {
        flush();
        // ADR-0008: compaction is a view, not a rewrite — everything folded
        // so far collapses to the summary message plus the newest keptTurns
        // rounds (keptTurns 0: only the post-round tail), mirroring the
        // engine's live split exactly, so a resumed compacted thread replays
        // transparently to providers. Multiple compactions chain naturally:
        // each one re-collapses whatever precedes it.
        const split = splitForCompaction(messages, event.keptTurns);
        const kept = split === undefined ? [...messages] : split.kept;
        const note = summaryMessage(event.summary);
        messages.length = 0;
        messages.push(note, ...kept);
        break;
      }
      case "thread_metadata":
      case "tool_call":
      case "usage":
        break;
      default: {
        // Exhaustiveness (amended ADR-0008): a future ThreadEvent kind must
        // fail LOUDLY here, never compile clean and fold silently. The
        // `never` assignment below only type-checks while every kind has a
        // case above.
        const unhandled: never = event;
        throw new Error(
          `replayFold: unhandled ThreadEvent kind ${(unhandled as ThreadEvent).type}`,
        );
      }
    }
  }
  flush();
  return messages;
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

export interface RunTaskOptions {
  /** The user's task text (becomes this run's user_message). */
  readonly task: string;
  /** Absolute workspace root (tools, permissions scoping, AGENTS.md walk). */
  readonly workspaceRoot: string;
  readonly modelRef: string;
  /** Existing thread to continue; omit to start a new one. */
  readonly threadId?: ThreadId | string;
  /** Injected provider (tests); default resolves from modelRef. */
  readonly provider?: Provider;
  readonly fetchImpl?: AppFetchLike;
  /** Anthropic key override (the CLI maps env here; the runner never reads env). */
  readonly apiKey?: string;
  /** Ollama base URL override (the CLI maps env here). */
  readonly ollamaBaseUrl?: string;
  /** OpenAI-compatible base URL override (the CLI maps env here; ADR-0010). */
  readonly openaiBaseUrl?: string;
  /** OpenAI-compatible API key override (the CLI maps env here; ADR-0010). */
  readonly openaiApiKey?: string;
  /**
   * Anthropic base URL override (the CLI maps env here); routes the
   * Anthropic-protocol adapter to a compatible endpoint (e.g. Z.AI for GLM).
   */
  readonly anthropicBaseUrl?: string;
  /**
   * Per-request provider deadline (connect + full streamed body), forwarded to
   * the adapter built from modelRef. Ignored when `provider` is injected.
   * Default: the adapters' own 120_000 ms.
   */
  readonly providerTimeoutMs?: number;
  /** Ordered permission rules; default DEFAULT_RULES. */
  readonly rules?: readonly PermissionRule[];
  /**
   * ToolSpec entries appended to the builtins in the run's registry
   * (ADR-0011: the CLI passes MCP server tools here, already
   * permission-gated by the same wrapper as the builtins). Default: none.
   */
  readonly extraTools?: readonly ToolSpec[];
  /** Thread store override; default JsonlThreadStore over dataDir. */
  readonly store?: ThreadStore;
  readonly dataDir?: string;
  /** Full system-prompt override (tests); default: repo prompt + AGENTS.md. */
  readonly systemPrompt?: string;
  /** AGENTS.md text override (tests); default: discovery from workspaceRoot. */
  readonly agentsText?: string;
  /** Environment handed to tools (bash PATH etc.); default {}. */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxToolRounds?: number;
  /** Engine event observer (stream-JSON emission). */
  readonly onEngineEvent?: (event: EngineEvent) => void;
  /** Permission decision observer (stream-JSON emission). */
  readonly onPermission?: (record: PermissionGateRecord) => void;
  /** ISO timestamp source for persisted events (tests). */
  readonly now?: NowFn;
  /** New-thread id source (tests); default crypto.randomUUID(). */
  readonly newId?: () => string;
  /**
   * Context-usage percent that triggers compaction (ADR-0008; default 90 of
   * the resolved model's context window). Plain option now — the settings
   * loader (ADR-0006 key `compaction.thresholdPercent`) wires in later.
   */
  readonly compactionThresholdPercent?: number;
  /**
   * Newest turns kept verbatim by compaction (ADR-0008; default 2). Future
   * settings key: `compaction.keepTurns`.
   */
  readonly keepTurns?: number;
  /** Force one compaction before the first round (`void resume --compact`). */
  readonly forceCompaction?: boolean;
  /** Compaction-prompt override (tests); default: prompts/compaction.md. */
  readonly compactionPrompt?: string;
  /**
   * Skills context (ADR-0012): the discovery result the run starts from
   * (prompt list + problems, already loud-checked by the CLI) plus the
   * options the lazy `skill`/`reload_skills` tools rescan with. Omit for the
   * no-skills baseline (no prompt section, no skill tools).
   */
  readonly skills?: SkillsRunContext;
}

/** Everything a caller (CLI, tests) needs after a run. */
export interface RunTaskOutcome {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly threadId: ThreadId;
  readonly result: ConversationResult;
  readonly resumed: boolean;
  readonly askOccurred: boolean;
  readonly rejectedOccurred: boolean;
  readonly permissions: readonly PermissionGateRecord[];
  /** The exact system prompt the engine ran with (auditability). */
  readonly systemPrompt: string;
}

/**
 * Assemble the full system prompt: repo default + AGENTS.md chain (if any) +
 * the skills list (if any). The skills section is names and descriptions
 * ONLY — ADR-0012 lazy injection: bodies load on demand through the `skill`
 * tool, never here. A full `systemPrompt` override wins over everything
 * (documented: callers overriding the prompt own its entire content).
 */
export async function assembleSystemPrompt(
  workspaceRoot: string,
  overrides: {
    readonly systemPrompt?: string;
    readonly agentsText?: string;
    /** Valid, first-wins skills (the run's discovery result). */
    readonly skills?: readonly DiscoveredSkill[];
  } = {},
): Promise<string> {
  if (overrides.systemPrompt !== undefined) {
    return overrides.systemPrompt;
  }
  const prompt = await loadDefaultPrompt();
  const agents =
    overrides.agentsText !== undefined
      ? overrides.agentsText
      : (await collectAgentsContext(workspaceRoot)).text;
  const parts: string[] = [prompt];
  if (agents.length > 0) {
    parts.push(`# Project instructions (AGENTS.md)\n\n${agents}`);
  }
  if (overrides.skills !== undefined && overrides.skills.length > 0) {
    parts.push(skillsPromptSection(overrides.skills));
  }
  return parts.join("\n\n");
}

/**
 * Run one task end-to-end: resolve thread (new or resumed), assemble context,
 * run the engine with the permission-gated registry, persist the conversation
 * to the thread log, and compute the exit code (rejected 2 > ask 1 >
 * provider/stream error 3 > success 0).
 */
export async function runTask(options: RunTaskOptions): Promise<RunTaskOutcome> {
  const workspaceRoot = options.workspaceRoot;
  const model = resolveModel(options.modelRef);
  if (options.provider === undefined && model.providerKind === "custom") {
    throw new RunnerError(
      "unknown_provider",
      `unknown provider in model ref ${JSON.stringify(options.modelRef)}: the MVP ships ` +
        `"anthropic/<model-id>", "ollama/<model-id>", and "openai/<model-id>" ` +
        "(set --model or VOID_MODEL)",
    );
  }
  const provider =
    options.provider ??
    resolveProvider(options.modelRef, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.ollamaBaseUrl !== undefined ? { ollamaBaseUrl: options.ollamaBaseUrl } : {}),
      ...(options.anthropicBaseUrl !== undefined
        ? { anthropicBaseUrl: options.anthropicBaseUrl }
        : {}),
      ...(options.openaiBaseUrl !== undefined ? { openaiBaseUrl: options.openaiBaseUrl } : {}),
      ...(options.openaiApiKey !== undefined ? { openaiApiKey: options.openaiApiKey } : {}),
      ...(options.providerTimeoutMs !== undefined ? { timeoutMs: options.providerTimeoutMs } : {}),
    });
  const store =
    options.store ??
    new JsonlThreadStore({ ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const now = options.now ?? (() => new Date().toISOString());

  const isResume = options.threadId !== undefined;
  const id = brandThreadId(
    isResume ? (options.threadId as string) : (options.newId?.() ?? crypto.randomUUID()),
  );

  let history: ChatMessage[] = [];
  if (isResume) {
    try {
      history = replayFold(await store.replay(id));
    } catch (cause) {
      throw new RunnerError(
        "unknown_thread",
        `cannot resume thread ${JSON.stringify(id)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  const adapter: ThreadAdapterOptions = { store, now };
  await appendThreadStart(adapter, id, options.task, options.modelRef, !isResume);

  const gate = buildPermissionGate(options.rules ?? DEFAULT_RULES, {
    workspaceRoot,
    ...(options.onPermission !== undefined ? { onRecord: options.onPermission } : {}),
  });
  // ADR-0013: the `task` builtin spawns child conversations on the SAME
  // provider/model/rules as this parent run (budgets stay the tool's own
  // inherited constants — deliberately not forwarded from options).
  const taskDeps: TaskToolDeps = {
    provider,
    model: options.modelRef,
    rules: options.rules ?? DEFAULT_RULES,
    workspaceRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
  };
  // Skills wiring (ADR-0012): the prompt gains the name+description list
  // ONLY (bodies load lazily via the skill tool), and the lazy-injection
  // tool pair joins the registry — both only when at least one valid skill
  // was discovered; zero skills leave the baseline prompt/registry untouched.
  const skillsContext = options.skills;
  const skillList: readonly DiscoveredSkill[] = skillsContext?.discovered.skills ?? [];
  const registry = buildToolRegistry(gate, {
    ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {}),
    ...(skillsContext !== undefined && skillList.length > 0
      ? { skills: skillsContext.options }
      : {}),
    taskDeps,
  });
  const systemPrompt = await assembleSystemPrompt(workspaceRoot, {
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.agentsText !== undefined ? { agentsText: options.agentsText } : {}),
    ...(skillList.length > 0 ? { skills: skillList } : {}),
  });

  // Per-round usage deltas: the engine reports cumulative totals per
  // turn_finished; persistence stores one usage event per round.
  const roundUsage: UsageRecord[] = [];
  let cumulative: UsageRecord | undefined;
  const onEvent = (event: EngineEvent): void => {
    if (event.type === "compaction") {
      // The engine folds summary usage into its cumulative totals; bump the
      // per-round baseline by the same amount so the next turn_finished delta
      // stays a pure per-round delta. The summary's cost itself is persisted
      // from the compaction record (a usage event behind the compaction
      // event), never double-counted as a round.
      cumulative = cumulative === undefined ? event.usage : addUsage(cumulative, event.usage);
    }
    if (event.type === "turn_finished") {
      const previous = cumulative ?? { inputTokens: 0, outputTokens: 0 };
      const cacheRead = (event.usage.cacheReadTokens ?? 0) - (previous.cacheReadTokens ?? 0);
      const cacheCreation =
        (event.usage.cacheCreationTokens ?? 0) - (previous.cacheCreationTokens ?? 0);
      cumulative = event.usage;
      if (
        event.usage.inputTokens - previous.inputTokens > 0 ||
        event.usage.outputTokens - previous.outputTokens > 0 ||
        cacheRead > 0 ||
        cacheCreation > 0
      ) {
        roundUsage.push({
          inputTokens: event.usage.inputTokens - previous.inputTokens,
          outputTokens: event.usage.outputTokens - previous.outputTokens,
          ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
        });
      }
    }
    options.onEngineEvent?.(event);
  };

  const seed: UserMessage = {
    role: "user",
    content: [{ type: "text", text: options.task }],
  };
  // ADR-0008 compaction policy: always armed — unknown registry windows
  // (ollama/openai passthrough) fall back to the registry's 200_000 default
  // rather than disabling compaction, and the assumption is reported on
  // every compaction event (`assumedContextWindow`) so it is visible.
  const contextWindow = model.contextWindow ?? CUSTOM_FALLBACK_CONTEXT_WINDOW;
  const compaction: CompactionConfig = {
    contextWindow,
    prompt: options.compactionPrompt ?? (await loadCompactionPrompt()),
    ...(options.compactionThresholdPercent !== undefined
      ? { thresholdPercent: options.compactionThresholdPercent }
      : {}),
    ...(options.keepTurns !== undefined ? { keepTurns: options.keepTurns } : {}),
    ...(options.forceCompaction ? { force: true } : {}),
    ...(model.contextWindow === undefined ? { assumedContextWindow: true } : {}),
  };
  const result = await runConversation({
    provider,
    model: options.modelRef,
    registry,
    system: systemPrompt,
    messages: [...history, seed],
    config: {
      workspaceRoot,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
      requestPermission: gate.requestPermission,
      onEvent,
      compaction,
    },
  });

  for (const event of conversationToEventsWithCompactions(
    result.messages.slice(history.length + 1),
    result.compactions ?? [],
    roundUsage,
    now,
  )) {
    await store.append(id, event);
  }

  const exitCode: 0 | 1 | 2 | 3 = gate.state.rejectedOccurred
    ? 2
    : gate.state.askOccurred
      ? 1
      : result.stopReason === "provider_error"
        ? 3
        : 0;

  return {
    exitCode,
    threadId: id,
    result,
    resumed: isResume && history.length > 0,
    askOccurred: gate.state.askOccurred,
    rejectedOccurred: gate.state.rejectedOccurred,
    permissions: gate.records,
    systemPrompt,
  };
}
