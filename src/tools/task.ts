/**
 * `task` builtin (ADR-0013) — scoped subagents with mode presets.
 *
 * One `task` call spawns a CHILD `runConversation` with the SAME provider as
 * the parent and three isolation properties, each enforced by construction:
 *
 * 1. MESSAGE isolation: the child's history starts from the mode preset
 *    (system) and the task assignment — the parent's transcript never enters
 *    the child, and the child's messages never enter the parent's provider
 *    requests; only the child's FINAL assistant text (+ a one-line usage
 *    summary) returns as this tool's result. No thread persistence either:
 *    the parent's JSONL records the `task` call and its outcome, not a child
 *    thread.
 * 2. TOOL isolation: the child registry is the fixed read-only list below
 *    (`read_file`/`grep`/`glob` + the async status/kill pair). `bash`,
 *    `edit_file`, and the async SPAWNER are absent, so a child cannot mutate
 *    anything or start processes; `task` itself is absent, so a child cannot
 *    spawn grandchildren — recursion is impossible by construction, not by
 *    policy. Status/kill share the process-wide async handle registry, so a
 *    child may monitor or stop commands the PARENT already started, nothing
 *    more.
 * 3. PERMISSION isolation via context: every child tool call is evaluated by
 *    a child gate over the SAME ordered rules array as the parent, with
 *    `caller: "subagent"` on every evaluation (ADR-0013's seam — rules
 *    scoped `context: "subagent"` can restrict children independently).
 *
 * Budgets are tool-level constants, deliberately NOT tool input (ADR-0013:
 * inherited defaults; the model must not negotiate its own limits):
 * maxToolRounds 10 (vs the parent's 25), a token stopBudget, and a wall-clock
 * timeout. Exceeded budgets stop the child and return a structured error
 * naming the budget that fired; the wall-clock cap races the conversation
 * and returns a structured timeout result (abandonment is safe: every child
 * tool is read-only, so an orphaned child can have no side effects).
 *
 * The child's engine events are NOT forwarded (ADR-0013: no incremental
 * visibility at P1; the stream contract gains only this tool_call/tool_result
 * pair) and the child runs WITHOUT compaction — its budgets are small enough
 * that the threshold could not honestly trip before they stop it.
 */

import { isTaskMode, loadModePrompt, TASK_MODES, type TaskMode } from "../context/prompts";
import type {
  GenerationParams,
  ModelRef,
  OutputLimits,
  PermissionAction,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestCallback,
  PermissionRule,
  Provider,
  ProviderError,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolSpec,
} from "../contracts";
import {
  type ConversationResult,
  createToolRegistry,
  runConversation,
  type ToolRegistry,
} from "../core/engine";
import { evaluate } from "../permissions";
import { asyncShellCommandKillTool, asyncShellCommandStatusTool } from "./async-shell";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readFileTool } from "./read_file";

/** Hard cap on `description` — a label, not a second prompt. */
export const TASK_DESCRIPTION_MAX_CHARS = 500;

/**
 * Child budgets (ADR-0013: "inherited defaults"). Constants, not tool input
 * and not runner config — the parent's own maxToolRounds/stopBudget do not
 * apply to children (they cover a whole conversation; a scoped subtask gets
 * deliberately smaller caps).
 */
export const TASK_MAX_TOOL_ROUNDS = 10;
/** Token stopBudget for the child (input + output summed, engine semantics). */
export const TASK_STOP_BUDGET = 200_000;
/** Wall-clock cap on one child conversation. */
export const TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The child's ENTIRE toolset. Absent by construction: `bash`, `edit_file`,
 * `async_shell_command` (spawn), MCP tools, and `task` itself — see the
 * module doc. This list is the isolation boundary; do not add a mutating
 * tool here without re-reading ADR-0013.
 */
const CHILD_TOOLS: readonly ToolSpec[] = [
  readFileTool,
  globTool,
  grepTool,
  asyncShellCommandStatusTool,
  asyncShellCommandKillTool,
];

// ---------------------------------------------------------------------------
// Child permission gate — same rules, caller "subagent" on every evaluation
// ---------------------------------------------------------------------------

/** One child-gate decision, recorded for tests and future observability. */
export interface SubagentPermissionRecord {
  readonly tool: string;
  readonly input: ToolInput;
  /** Always "subagent": the ADR-0013 marker carried into evaluate(). */
  readonly caller: "subagent";
  /** The rule engine's action before headless mapping. */
  readonly action: PermissionAction;
  /** True when the call did NOT run (everything but allow, headless). */
  readonly headlessDenied: boolean;
  /** evaluate()'s audit line (matched rule / default policy). */
  readonly reason: string;
}

export interface SubagentGate {
  /** Callback the child engine AND child tool wrappers consult. */
  readonly requestPermission: PermissionRequestCallback;
  /** Every decision taken, in order (caller is always "subagent"). */
  readonly records: readonly SubagentPermissionRecord[];
}

export interface BuildSubagentGateOptions {
  /** Workspace root for path-glob `context` rules (same value as the parent). */
  readonly workspaceRoot?: string;
}

const SUBAGENT_HEADLESS_NOTE =
  "This tool call runs inside a task subagent, which cannot ask interactively; " +
  "the call was denied. Adjust the permission rules to allow it for subagents.";

/**
 * Build the child's permission gate: re-evaluates the SAME ordered rules
 * array as the parent for every child tool call, stamping
 * `caller: "subagent"` into each evaluation so `context: "subagent"` rules
 * can scope children (ADR-0013). Headless mapping mirrors the runner's
 * buildPermissionGate (allow proceeds; ask/delegate/reject become a
 * structured rejection with remediation) — duplicated here on purpose:
 * tools may not import the composition root (runner → tools is the only
 * direction), and the parent gate must keep its own exit-code state clean of
 * child decisions (a child denial is the child's tool result, not the
 * parent's exit 1/2).
 */
export function buildSubagentGate(
  rules: readonly PermissionRule[],
  options: BuildSubagentGateOptions = {},
): SubagentGate {
  const records: SubagentPermissionRecord[] = [];
  const gate: SubagentGate = {
    records,
    requestPermission: async (request: PermissionRequest): Promise<PermissionDecision> => {
      const outcome = evaluate(request.tool, request.input, rules, {
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        caller: "subagent",
      });
      const action = outcome.decision.action;
      const decision: PermissionDecision =
        action === "allow"
          ? { action: "allow" }
          : {
              action: "reject",
              message:
                action === "reject"
                  ? `${outcome.decision.message ?? outcome.reason} — denied by a permission rule.`
                  : `${outcome.decision.message ?? outcome.reason} — ${SUBAGENT_HEADLESS_NOTE}`,
            };
      records.push({
        tool: request.tool,
        input: request.input,
        caller: "subagent",
        action,
        headlessDenied: action !== "allow",
        reason: outcome.reason,
      });
      return decision;
    },
  };
  return gate;
}

/** Wrap one spec so the child gate evaluates every call before execution. */
function gateWrap(spec: ToolSpec, gate: SubagentGate): ToolSpec {
  return {
    ...spec,
    async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const decision = await gate.requestPermission({
        tool: spec.name,
        input,
        reason: `subagent tool call "${spec.name}" requires a permission decision`,
      });
      if (decision.action === "allow") {
        return spec.execute(input, ctx);
      }
      const message =
        decision.message ??
        `permission for "${spec.name}" was denied before execution; adjust the rules and re-run`;
      return {
        content: [{ type: "text", text: `Permission denied for ${spec.name}: ${message}` }],
        isError: true,
        error: { code: "permission_denied", message, retryable: false },
      };
    },
  };
}

/** Build the child registry: the fixed read-only list behind the child gate. */
function buildChildRegistry(gate: SubagentGate): ToolRegistry {
  return createToolRegistry(CHILD_TOOLS.map((spec) => gateWrap(spec, gate)));
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** Dependencies the composition root injects (provider etc. live here, not
 * in ToolContext — the contract shape stays untouched). */
export interface TaskToolDeps {
  /** The parent's provider: the child runs on the SAME one (ADR-0013). */
  readonly provider: Provider;
  /** The parent's model ref. */
  readonly model: ModelRef;
  /** The SAME ordered rules array the parent gate evaluates. */
  readonly rules: readonly PermissionRule[];
  /** Workspace root (child tool paths, path-glob permission contexts). */
  readonly workspaceRoot: string;
  /** Environment handed to child tools; default {} (engine semantics). */
  readonly env?: Readonly<Record<string, string>>;
  /** Output caps for child tools; default the engine's DEFAULT_OUTPUT_LIMITS. */
  readonly outputLimits?: OutputLimits;
  /** Generation params forwarded to every child provider request. */
  readonly params?: GenerationParams;
  /** Mode-preset loader; default `loadModePrompt` (tests inject fixtures). */
  readonly loadModePrompt?: (mode: TaskMode) => Promise<string>;
  /**
   * Budget/timeout override seams — TEST-ONLY DI, never tool input (ADR-0013
   * fixes the defaults; the runner passes none of these).
   */
  readonly maxToolRounds?: number;
  readonly stopBudget?: number;
  readonly timeoutMs?: number;
}

/** Validated `task` input. */
interface TaskCall {
  readonly description: string;
  readonly prompt: string;
  readonly mode: TaskMode;
}

/** Parse and validate the tool input; returns an error result on bad shape. */
function parseTaskInput(
  input: ToolInput,
): { readonly ok: true; call: TaskCall } | { readonly ok: false; error: ToolResult } {
  const description = input.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      ok: false,
      error: toolErrorResult("invalid_input", "description must be a non-empty string"),
    };
  }
  if (description.length > TASK_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: toolErrorResult(
        "invalid_input",
        `description must be at most ${TASK_DESCRIPTION_MAX_CHARS} characters (got ${description.length}); put the detail in prompt`,
      ),
    };
  }
  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return {
      ok: false,
      error: toolErrorResult("invalid_input", "prompt must be a non-empty string"),
    };
  }
  // Absent mode defaults; a present-but-invalid one (wrong string, null,
  // number…) fails loudly listing the valid modes — never a silent fallback.
  if (input.mode !== undefined && !isTaskMode(input.mode)) {
    return {
      ok: false,
      error: toolErrorResult(
        "invalid_input",
        `mode must be one of ${TASK_MODES.join(" | ")} (got ${JSON.stringify(input.mode)})`,
      ),
    };
  }
  const mode: TaskMode = isTaskMode(input.mode) ? input.mode : "explorer";
  return { ok: true, call: { description: description.trim(), prompt, mode } };
}

function toolErrorResult(
  code: "invalid_input" | "timeout" | "execution_failed",
  message: string,
): ToolResult {
  return { content: [], isError: true, error: { code, message, retryable: false } };
}

/**
 * Assemble the child's system prompt: the mode preset (its file is the
 * versioned source of truth) plus the task framing built from the call.
 */
function childSystemPrompt(preset: string, call: TaskCall): string {
  return (
    `${preset}\n\n---\n\n# Task\n\n` +
    `**Description:** ${call.description}\n\n**Prompt:**\n\n${call.prompt}`
  );
}

/** The last assistant message's text — what the child "returns". */
function finalAssistantText(result: ConversationResult): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role === "assistant") {
      return message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
  }
  return "";
}

/** One-line machine-readable accounting appended to every task result. */
function taskLine(call: TaskCall, result: ConversationResult): string {
  const usage = result.totalUsage;
  return (
    `[task mode=${call.mode} stop=${result.stopReason} rounds=${result.rounds} ` +
    `tokens_in=${usage.inputTokens} tokens_out=${usage.outputTokens}]`
  );
}

/** A failed ToolResult whose content still carries the child's partial text. */
function failedResult(
  code: "timeout" | "execution_failed",
  message: string,
  retryable: boolean,
  details: Readonly<Record<string, string | number>> | undefined,
  partialText: string,
): ToolResult {
  const text = partialText.length > 0 ? `${partialText}\n\n${message}` : message;
  return {
    content: [{ type: "text", text }],
    isError: true,
    error: {
      code,
      message,
      retryable,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

/** The caps actually in effect for one child run (test seams may override). */
interface EffectiveBudgets {
  readonly maxToolRounds: number;
  readonly stopBudget: number;
}

/** Map a finished child conversation onto the parent's ToolResult. */
function childToResult(
  call: TaskCall,
  result: ConversationResult,
  budgets: EffectiveBudgets,
): ToolResult {
  const text = finalAssistantText(result);
  const tail = taskLine(call, result);
  if (result.stopReason === "budget_exceeded") {
    const usedTokens = result.totalUsage.inputTokens + result.totalUsage.outputTokens;
    return failedResult(
      "execution_failed",
      `task "${call.description}" stopped early: token budget of ${budgets.stopBudget} exceeded ` +
        `(used ${usedTokens} tokens across ${result.rounds} round(s))`,
      false,
      {
        stopReason: result.stopReason,
        budget: budgets.stopBudget,
        usedTokens,
        rounds: result.rounds,
      },
      text,
    );
  }
  if (result.stopReason === "max_tool_rounds") {
    return failedResult(
      "execution_failed",
      `task "${call.description}" stopped early: max tool rounds (${budgets.maxToolRounds}) reached ` +
        `after ${result.rounds} provider round(s); narrow the prompt or raise the cap`,
      false,
      {
        stopReason: result.stopReason,
        maxToolRounds: budgets.maxToolRounds,
        rounds: result.rounds,
      },
      text,
    );
  }
  if (result.stopReason === "provider_error") {
    const providerError: ProviderError | undefined = result.error;
    return failedResult(
      "execution_failed",
      `task "${call.description}" failed with a provider error: ${providerError?.message ?? "unknown provider error"}`,
      providerError?.retryable ?? false,
      {
        stopReason: result.stopReason,
        ...(providerError?.code !== undefined ? { providerCode: providerError.code } : {}),
        rounds: result.rounds,
      },
      text,
    );
  }
  // Natural stop (end_turn and friends): the final message IS the deliverable.
  const body = text.length > 0 ? text : "(the subagent ended without a final message)";
  return { content: [{ type: "text", text: `${body}\n\n${tail}` }], isError: false };
}

/** Structured result for the wall-clock timeout path. */
function timeoutResult(call: TaskCall, timeoutMs: number): ToolResult {
  return failedResult(
    "timeout",
    `task "${call.description}" exceeded its wall-clock limit of ${timeoutMs} ms and was abandoned ` +
      "(the child's tools are read-only, so an abandoned child has no side effects)",
    true,
    { timeoutMs },
    "",
  );
}

/**
 * Build the `task` ToolSpec. The spec is a builtin like any other: the
 * parent registry wraps it in the PARENT gate (the spawn itself is a
 * permission decision — allow by default), and its execute runs the child
 * conversation described in the module doc.
 */
export function createTaskTool(deps: TaskToolDeps): ToolSpec {
  const loadPreset = deps.loadModePrompt ?? ((mode: TaskMode) => loadModePrompt(mode));
  return {
    name: "task",
    description:
      "Run a scoped subagent on the same model and read-only toolset, with no " +
      "access to this conversation's history. Input: a short description " +
      `(<=${TASK_DESCRIPTION_MAX_CHARS} chars, labels the run), a prompt (the full, self-contained ` +
      "assignment — the child sees ONLY this), and an optional mode. Modes: " +
      '"explorer" (default; investigates read-only and returns structured ' +
      'findings with file/line evidence) and "planner" (reads the code and ' +
      "returns a numbered step plan with risks and assumptions). The child's " +
      "final message plus a usage line comes back as this tool's result. Keep " +
      "prompts self-contained: the child cannot see anything you know.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: `Short label for the subtask (max ${TASK_DESCRIPTION_MAX_CHARS} characters).`,
        },
        prompt: {
          type: "string",
          description:
            "The complete, self-contained assignment for the child: question to answer or plan to produce, plus every name/path/context it needs.",
        },
        mode: {
          type: "string",
          enum: [...TASK_MODES],
          description: `Mode preset for the child (default "explorer").`,
        },
      },
      required: ["description", "prompt"],
    },
    source: "builtin",
    async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseTaskInput(input);
      if (!parsed.ok) {
        return parsed.error;
      }
      const call = parsed.call;

      let preset: string;
      try {
        preset = await loadPreset(call.mode);
      } catch (cause) {
        return toolErrorResult(
          "execution_failed",
          `cannot load the ${call.mode} mode preset: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }

      const gate = buildSubagentGate(deps.rules, { workspaceRoot: deps.workspaceRoot });
      const timeoutMs = deps.timeoutMs ?? TASK_TIMEOUT_MS;
      const maxToolRounds = deps.maxToolRounds ?? TASK_MAX_TOOL_ROUNDS;
      const stopBudget = deps.stopBudget ?? TASK_STOP_BUDGET;

      // Wall-clock race. The engine has no abort signal (MVP), so a timeout
      // resolves this call while the child keeps running to its own end —
      // nobody observes it afterwards (onEvent is not forwarded) and every
      // child tool is read-only, so abandonment is side-effect-free. The
      // trailing no-op catch keeps a late failure from becoming an unhandled
      // rejection.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const conversation: Promise<ConversationResult> = runConversation({
        provider: deps.provider,
        model: deps.model,
        registry: buildChildRegistry(gate),
        system: childSystemPrompt(preset, call),
        // Isolated history: ONLY the kickoff message — no parent turns. The
        // assignment itself lives in the system prompt (see childSystemPrompt).
        messages: [{ role: "user", content: [{ type: "text", text: "Begin the task now." }] }],
        config: {
          maxToolRounds,
          stopBudget,
          workspaceRoot: deps.workspaceRoot,
          ...(deps.env !== undefined ? { env: deps.env } : {}),
          ...(deps.outputLimits !== undefined ? { outputLimits: deps.outputLimits } : {}),
          ...(deps.params !== undefined ? { params: deps.params } : {}),
          requestPermission: gate.requestPermission,
          // No onEvent: child events are not streamed (ADR-0013). No
          // compaction: child budgets stop it long before its context could
          // honestly cross a compaction threshold.
        },
      });
      conversation.catch(() => {
        // observed through the race below; this only silences a late loss
      });

      const winner: ConversationResult | "timeout" = await Promise.race([conversation, timedOut]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (winner === "timeout") {
        return timeoutResult(call, timeoutMs);
      }
      return childToResult(call, winner, { maxToolRounds, stopBudget });
    },
  };
}
