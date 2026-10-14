/**
 * Hermetic tests for the `task` builtin (ADR-0013): input validation, the
 * child runConversation's isolation properties (system prompt framing,
 * message isolation, the fixed read-only tool subset), the subagent
 * permission gate (caller "subagent" carried on every evaluation), and the
 * result/error mapping (natural stop, budget guards, provider errors,
 * wall-clock timeout). The provider is scripted; the read-only child tools
 * are the REAL ones (read_file against fixture files), so these run under
 * both vitest and bun:test.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ChatRequest,
  PermissionRule,
  Provider,
  StreamEvent,
  ToolContext,
  ToolResult,
  UsageRecord,
} from "../contracts";
import { DEFAULT_RULES, evaluate } from "../permissions";
import {
  buildSubagentGate,
  createTaskTool,
  TASK_DESCRIPTION_MAX_CHARS,
  TASK_MAX_TOOL_ROUNDS,
  TASK_STOP_BUDGET,
  TASK_TIMEOUT_MS,
  type TaskToolDeps,
} from "./task";

const base = realpathSync(tmpdir());
const workspace = mkdtempSync(join(base, "void-task-ws-"));
const fixturePath = join(workspace, "facts.txt");
writeFileSync(fixturePath, "task-fixture-marker-line\nsecond line\n");

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeCtx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: workspace,
    workingDir: workspace,
    env: {},
    requestPermission: async () => ({ action: "allow" }),
    outputLimits: { maxTotalChars: 100_000, maxSectionChars: 10_000 },
    ...partial,
  };
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Scripted provider: every request is captured; each queue entry is one
// round of StreamEvents.
// ---------------------------------------------------------------------------

const USAGE: UsageRecord = { inputTokens: 10, outputTokens: 5 };

function textRound(textValue: string): StreamEvent[] {
  return [
    { type: "text_delta", text: textValue },
    { type: "usage", usage: USAGE },
    { type: "turn_complete", stopReason: "end_turn" },
  ];
}

function toolRound(id: string, name: string, input: Record<string, string>): StreamEvent[] {
  return [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, name, input },
    { type: "usage", usage: USAGE },
    { type: "turn_complete", stopReason: "tool_use" },
  ];
}

function errorRound(message: string, retryable: boolean): StreamEvent[] {
  return [{ type: "error", error: { message, retryable, code: "overloaded" } }];
}

interface ScriptedProvider extends Provider {
  /** Every captured child request, in order. */
  readonly requests: readonly ChatRequest[];
}

function scriptProvider(rounds: readonly StreamEvent[][]): ScriptedProvider {
  const requests: ChatRequest[] = [];
  const queue = [...rounds];
  const provider: ScriptedProvider = {
    id: "scripted",
    requests,
    stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      requests.push(request);
      const events = queue.shift() ?? [];
      return (async function* (): AsyncIterable<StreamEvent> {
        yield* events;
      })();
    },
    async complete() {
      throw new Error("complete() is not used by the task child path");
    },
  };
  return provider;
}

interface Harness {
  readonly provider: ScriptedProvider;
  readonly deps: TaskToolDeps;
  readonly rules: readonly PermissionRule[];
}

function makeHarness(
  rounds: readonly StreamEvent[][],
  overrides: Partial<TaskToolDeps> = {},
  rules: readonly PermissionRule[] = DEFAULT_RULES,
): Harness {
  const provider = scriptProvider(rounds);
  return {
    provider,
    rules,
    deps: {
      provider,
      model: "anthropic/test-model",
      rules,
      workspaceRoot: workspace,
      ...overrides,
    },
  };
}

const VALID_INPUT = {
  description: "check the fixture",
  prompt: "Read facts.txt in the workspace and report the marker.",
};

async function runTask(harness: Harness, input: Record<string, unknown>): Promise<ToolResult> {
  const tool = createTaskTool(harness.deps);
  return tool.execute(input as never, makeCtx());
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("task input validation", () => {
  it("rejects a missing or non-string description", async () => {
    const harness = makeHarness([]);
    for (const bad of [undefined, "", "   ", 42]) {
      const result = await runTask(harness, { description: bad, prompt: "p" });
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("invalid_input");
      expect(result.error?.message).toContain("description");
    }
    expect(harness.provider.requests).toHaveLength(0); // failed before any child round
  });

  it(`rejects a description longer than ${TASK_DESCRIPTION_MAX_CHARS} characters`, async () => {
    const harness = makeHarness([]);
    const result = await runTask(harness, {
      description: "x".repeat(TASK_DESCRIPTION_MAX_CHARS + 1),
      prompt: "p",
    });
    expect(result.isError).toBe(true);
    expect(result.error?.message).toContain(`${TASK_DESCRIPTION_MAX_CHARS}`);
  });

  it("rejects a missing or empty prompt", async () => {
    const harness = makeHarness([]);
    for (const bad of [undefined, "", "\n\t"]) {
      const result = await runTask(harness, { description: "d", prompt: bad });
      expect(result.isError).toBe(true);
      expect(result.error?.message).toContain("prompt");
    }
  });

  it("rejects an unknown mode, naming the valid ones; absent mode defaults to explorer", async () => {
    const harness = makeHarness([]);
    for (const bad of ["researcher", null, 7]) {
      const result = await runTask(harness, { description: "d", prompt: "p", mode: bad });
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("invalid_input");
      expect(result.error?.message).toContain("explorer");
      expect(result.error?.message).toContain("planner");
    }
    expect(harness.provider.requests).toHaveLength(0);

    const ok = makeHarness([textRound("done")]);
    const defaulted = await runTask(ok, { description: "d", prompt: "p" });
    expect(defaulted.isError).toBe(false);
    expect(ok.provider.requests[0]?.system).toContain("explorer subagent");
  });
});

// ---------------------------------------------------------------------------
// Child conversation: prompt framing, isolation, tool subset
// ---------------------------------------------------------------------------

describe("task child conversation", () => {
  it("system prompt = mode preset + description/prompt framing; defaults to explorer", async () => {
    const harness = makeHarness([textRound("done")]);
    const result = await runTask(harness, VALID_INPUT);
    expect(result.isError).toBe(false);

    const request = harness.provider.requests[0];
    expect(request).toBeDefined();
    expect(request?.system).toContain("explorer subagent"); // the preset (marker)
    expect(request?.system).toContain(VALID_INPUT.description);
    expect(request?.system).toContain(VALID_INPUT.prompt);
  });

  it('mode "planner" loads the planner preset', async () => {
    const harness = makeHarness([textRound("plan ready")]);
    const result = await runTask(harness, { ...VALID_INPUT, mode: "planner" });
    expect(result.isError).toBe(false);
    expect(harness.provider.requests[0]?.system).toContain("planner subagent");
    expect(harness.provider.requests[0]?.system).not.toContain("explorer subagent");
  });

  it("messages are isolated: exactly the kickoff user message, no parent history", async () => {
    const harness = makeHarness([
      toolRound("t1", "read_file", { path: fixturePath }),
      textRound("ok"),
    ]);
    await runTask(harness, VALID_INPUT);

    for (const request of harness.provider.requests) {
      expect(request.messages[0]?.role).toBe("user");
      const first = request.messages[0]?.content[0];
      expect(first && first.type === "text" ? first.text : "").toBe("Begin the task now.");
    }
    // The child's second request is its own transcript: kickoff, its tool_use
    // round, and the tool_result — roles exactly [user, assistant, user].
    const second = harness.provider.requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    // The parent's assignment lives ONLY in the system prompt (asserted in the
    // framing test): the child's message list never carries it.
    expect(VALID_INPUT.prompt).not.toHaveLength(0);
    expect(
      second?.messages.some((message) => JSON.stringify(message).includes(VALID_INPUT.prompt)),
    ).toBe(false);
  });

  it("child tool subset: read-only + async status/kill present; bash/edit_file/task/spawner absent", async () => {
    const harness = makeHarness([textRound("done")]);
    await runTask(harness, VALID_INPUT);

    const names = (harness.provider.requests[0]?.tools ?? []).map((spec) => spec.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("glob");
    expect(names).toContain("async_shell_command_status");
    expect(names).toContain("async_shell_command_kill");
    // Recursion and mutation are impossible by construction: absent, not gated.
    expect(names).not.toContain("task");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("async_shell_command");
    expect(names).toHaveLength(5);
  });

  it("the real read_file runs inside the child and its findings reach the parent result", async () => {
    const harness = makeHarness([
      toolRound("t1", "read_file", { path: fixturePath }),
      textRound("FINDINGS: the marker is task-fixture-marker-line"),
    ]);
    const result = await runTask(harness, VALID_INPUT);

    expect(result.isError).toBe(false);
    expect(text(result)).toContain("FINDINGS: the marker is task-fixture-marker-line");
    // The accounting tail: mode, stop reason, rounds, usage.
    expect(text(result)).toContain(
      "[task mode=explorer stop=end_turn rounds=2 tokens_in=20 tokens_out=10]",
    );
  });

  it("a child that ends without text is reported, not silently empty", async () => {
    const harness = makeHarness([
      toolRound("t1", "read_file", { path: fixturePath }),
      // final round: tool_use only would loop; use a no-text end via stop_sequence
      [
        { type: "usage", usage: USAGE },
        { type: "turn_complete", stopReason: "stop_sequence" },
      ],
    ]);
    const result = await runTask(harness, VALID_INPUT);
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("ended without a final message");
    expect(text(result)).toContain("stop=stop_sequence");
  });
});

// ---------------------------------------------------------------------------
// Subagent permission gate (ADR-0013 seam)
// ---------------------------------------------------------------------------

describe("task subagent permission gate", () => {
  it('records carry caller "subagent" on every evaluation', async () => {
    const gate = buildSubagentGate(DEFAULT_RULES, { workspaceRoot: workspace });
    const decision = await gate.requestPermission({
      tool: "read_file",
      input: { path: fixturePath },
      reason: "test",
    });
    expect(decision.action).toBe("allow");
    expect(gate.records).toHaveLength(1);
    expect(gate.records[0]?.caller).toBe("subagent");
    expect(gate.records[0]?.tool).toBe("read_file");
    expect(gate.records[0]?.headlessDenied).toBe(false);
  });

  it("maps ask to a headless rejection without executing", async () => {
    const askRules: readonly PermissionRule[] = [
      { tool: "read_file", matches: "*", action: "ask", message: "confirm reads" },
    ];
    const gate = buildSubagentGate(askRules, { workspaceRoot: workspace });
    const decision = await gate.requestPermission({
      tool: "read_file",
      input: { path: fixturePath },
      reason: "test",
    });
    expect(decision.action).toBe("reject");
    expect(decision.message).toContain("confirm reads");
    expect(gate.records[0]?.action).toBe("ask");
    expect(gate.records[0]?.headlessDenied).toBe(true);
  });

  it('a context:"subagent" rule in the SAME rules array restricts the child only', async () => {
    // The recording rules array: the subagent-scoped reject rule fires for the
    // child's read_file (proving caller "subagent" reached evaluate), while
    // the trailing allow keeps parent-context evaluations untouched.
    const rules: readonly PermissionRule[] = [
      {
        tool: "read_file",
        matches: "*",
        context: "subagent",
        action: "reject",
        message: "no reads inside subagents",
      },
      { tool: "read_file", matches: "*", action: "allow" },
    ];
    const harness = makeHarness(
      [toolRound("t1", "read_file", { path: fixturePath }), textRound("could not read")],
      {},
      rules,
    );
    const result = await runTask(harness, VALID_INPUT);

    // The child round 2 request carries the denial as the tool_result.
    const denial = JSON.stringify(harness.provider.requests[1]);
    expect(denial).toContain("Permission denied for read_file");
    expect(denial).toContain("no reads inside subagents");
    expect(denial).not.toContain("task-fixture-marker-line"); // the read never executed
    expect(result.isError).toBe(false); // the task itself completed; the child reported the denial

    // Parent-context evaluation of the SAME rules array leaves read_file allowed.
    const parent = evaluate("read_file", { path: fixturePath }, rules);
    expect(parent.decision.action).toBe("allow");
    expect(parent.matchedRuleIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error mapping: budgets, provider errors, timeout
// ---------------------------------------------------------------------------

describe("task result mapping for guard stops and errors", () => {
  it(`budget exceeded → structured error naming the budget (${TASK_STOP_BUDGET})`, async () => {
    // One round reporting 5000 tokens against a tiny injected stopBudget.
    const spendy: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_end", id: "t1", name: "read_file", input: { path: fixturePath } },
      { type: "usage", usage: { inputTokens: 4_000, outputTokens: 1_500 } },
      { type: "turn_complete", stopReason: "tool_use" },
    ];
    const harness = makeHarness([spendy, textRound("never reached")], { stopBudget: 5_000 });
    const result = await runTask(harness, VALID_INPUT);

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("execution_failed");
    expect(result.error?.message).toContain("token budget of 5000 exceeded");
    expect(result.error?.message).toContain("used 5500 tokens");
    expect(result.error?.details).toMatchObject({
      stopReason: "budget_exceeded",
      budget: 5_000,
      usedTokens: 5_500,
    });
  });

  it(`max tool rounds → structured error naming the rounds cap (${TASK_MAX_TOOL_ROUNDS})`, async () => {
    const harness = makeHarness(
      [
        toolRound("t1", "read_file", { path: fixturePath }),
        toolRound("t2", "read_file", { path: fixturePath }),
      ],
      { maxToolRounds: 1 },
    );
    const result = await runTask(harness, VALID_INPUT);

    expect(result.isError).toBe(true);
    expect(result.error?.message).toContain("max tool rounds (1) reached");
    expect(result.error?.details).toMatchObject({
      stopReason: "max_tool_rounds",
      maxToolRounds: 1,
    });
  });

  it("provider error → structured error carrying retryability", async () => {
    const retryable = makeHarness([errorRound("upstream overloaded", true)]);
    const retryableResult = await runTask(retryable, VALID_INPUT);
    expect(retryableResult.isError).toBe(true);
    expect(retryableResult.error?.message).toContain("provider error");
    expect(retryableResult.error?.message).toContain("upstream overloaded");
    expect(retryableResult.error?.retryable).toBe(true);
    expect(retryableResult.error?.details).toMatchObject({
      stopReason: "provider_error",
      providerCode: "overloaded",
    });

    const fatal = makeHarness([errorRound("invalid api key", false)]);
    const fatalResult = await runTask(fatal, VALID_INPUT);
    expect(fatalResult.error?.retryable).toBe(false);
  });

  it(`wall-clock timeout (default ${TASK_TIMEOUT_MS} ms) → structured timeout result via the DI seam`, async () => {
    // A provider round that never completes; the tiny timeoutMs override
    // (test-only DI) fires the race first.
    const requests: ChatRequest[] = [];
    const hanging: Provider = {
      id: "hanging",
      stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        requests.push(request);
        return (async function* (): AsyncIterable<StreamEvent> {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          yield* textRound("too late");
        })();
      },
      async complete() {
        throw new Error("unused");
      },
    };
    const harness: Harness = {
      provider: { ...hanging, requests } as ScriptedProvider,
      rules: DEFAULT_RULES,
      deps: {
        provider: hanging,
        model: "anthropic/test-model",
        rules: DEFAULT_RULES,
        workspaceRoot: workspace,
        timeoutMs: 25,
      },
    };
    const result = await runTask(harness, VALID_INPUT);

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.message).toContain("25 ms");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.details).toMatchObject({ timeoutMs: 25 });
  });

  it("an unreadable mode preset → loud structured error, no child round", async () => {
    const harness = makeHarness([]);
    const broken = {
      ...harness.deps,
      loadModePrompt: async () => Promise.reject(new Error("ENOENT")),
    };
    const result = await createTaskTool(broken).execute(VALID_INPUT as never, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.message).toContain("mode preset");
    expect(harness.provider.requests).toHaveLength(0);
  });
});
