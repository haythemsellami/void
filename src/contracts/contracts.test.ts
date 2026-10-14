/**
 * Smoke test for `src/contracts`: proves the module compiles under strict TS,
 * exports the expected surface, and that its shapes are constructible and
 * implementable. Type-level conformance is asserted via `satisfies` and
 * discriminated-union narrowing (checked by `tsc --noEmit`); runtime shape is
 * asserted with expect(). Kept runner-agnostic on purpose.
 */
import { describe, expect, it } from "vitest";
import { VERSION } from "../cli";
import type {
  ChatRequest,
  OutputLimits,
  PermissionRule,
  Provider,
  StopReason,
  StreamEvent,
  ThreadEvent,
  ThreadId,
  ToolContext,
  ToolResultBlock,
  ToolSpec,
  ToolUseEndEvent,
} from "./index";
import { threadId } from "./index";

const bashTool: ToolSpec = {
  name: "bash",
  description: "Run a shell command inside the OS sandbox.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
    },
    required: ["command"],
  },
  source: "builtin",
  async execute(input, ctx) {
    // Structured errors for expected failures — never throw (contract).
    if (typeof input.command !== "string") {
      return {
        content: [],
        isError: true,
        error: { code: "invalid_input", message: "command must be a string", retryable: false },
      };
    }
    return {
      content: [
        { type: "text", text: `ran ${input.command} in ${ctx.workingDir}`, truncated: false },
      ],
      isError: false,
    };
  },
};

const toolContext: ToolContext = {
  workspaceRoot: "/tmp/workspace",
  workingDir: "/tmp/workspace",
  env: { PATH: "/usr/bin:/bin" },
  requestPermission: async (request) => ({
    action: "allow",
    message: `auto-allowed ${request.tool}`,
  }),
  outputLimits: { maxTotalChars: 2000, maxSectionChars: 2000 },
};

const chatRequest: ChatRequest = {
  model: "anthropic/claude-sonnet-4",
  system: "You are Void, a local-first coding agent.",
  messages: [{ role: "user", content: [{ type: "text", text: "list the files" }] }],
  tools: [bashTool],
  params: { maxOutputTokens: 1024, reasoningEffort: "medium" },
};

const permissionRules: readonly PermissionRule[] = [
  {
    tool: "bash",
    matches: { command: "/\\bgit\\s+push\\b/" },
    action: "reject",
    message: "pushing is manual-only",
  },
  { tool: "bash", matches: { command: ["git status", "git diff*"] }, action: "allow" },
  { tool: "edit_file", matches: { "file.path": "src/**" }, action: "ask" },
  { tool: "read_file", matches: "*", action: "allow" },
];

const threadEvents: readonly ThreadEvent[] = [
  {
    type: "thread_metadata",
    threadId: threadId("t_123"),
    title: "hello task",
    model: "anthropic/claude-sonnet-4",
    createdAt: "2026-10-10T00:00:00.000Z",
    at: "2026-10-10T00:00:00.000Z",
  },
  {
    type: "user_message",
    message: { role: "user", content: [{ type: "text", text: "list the files" }] },
    at: "2026-10-10T00:00:01.000Z",
  },
  {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
    at: "2026-10-10T00:00:02.000Z",
  },
  {
    type: "tool_call",
    toolUseId: "tu_1",
    name: "bash",
    input: { command: "ls" },
    at: "2026-10-10T00:00:03.000Z",
  },
  {
    type: "tool_result",
    toolUseId: "tu_1",
    result: {
      content: [{ type: "text", text: "src docs", truncated: false }],
      isError: false,
    },
    at: "2026-10-10T00:00:04.000Z",
  },
  {
    type: "usage",
    usage: { inputTokens: 120, outputTokens: 34 },
    at: "2026-10-10T00:00:05.000Z",
  },
];

const scriptedProvider: Provider = {
  id: "mock",
  async *stream() {
    yield { type: "text_delta", text: "listing" };
    yield { type: "tool_use_start", id: "tu_1", name: "bash" };
    yield { type: "tool_use_delta", id: "tu_1", inputDelta: '{"command":"ls"}' };
    yield { type: "tool_use_end", id: "tu_1", input: { command: "ls" } };
    yield {
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
      },
    };
    yield { type: "turn_complete", stopReason: "tool_use" };
  },
  async complete() {
    return {
      content: [{ type: "text", text: "done" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    };
  },
};

describe("contracts smoke test", () => {
  it("exports the CLI version constant matching package.json", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default;
    expect(VERSION).toBe(pkg.version);
  });

  it("constructs a ChatRequest with tools and generation params", () => {
    expect(chatRequest.model).toBe("anthropic/claude-sonnet-4");
    expect(chatRequest.messages).toHaveLength(1);
    expect(chatRequest.tools?.[0]?.name).toBe("bash");
    expect(chatRequest.params?.reasoningEffort).toBe("medium");
  });

  it("executes a ToolSpec with structured results", async () => {
    const ok = await bashTool.execute({ command: "ls" }, toolContext);
    expect(ok.isError).toBe(false);
    expect(ok.content[0]?.type).toBe("text");
    expect(ok.content[0]?.truncated).toBe(false);

    const bad = await bashTool.execute({}, toolContext);
    expect(bad.isError).toBe(true);
    expect(bad.error?.code).toBe("invalid_input");
    expect(bad.error?.retryable).toBe(false);
  });

  it("constructs PermissionRules with every matcher form", () => {
    expect(permissionRules).toHaveLength(4);
    expect(permissionRules[0]?.action).toBe("reject");
    expect(permissionRules[0]?.matches).toEqual({ command: "/\\bgit\\s+push\\b/" });
    expect(permissionRules[1]?.matches).toEqual({ command: ["git status", "git diff*"] });
    expect(permissionRules[2]?.matches).toEqual({ "file.path": "src/**" });
    expect(permissionRules[3]?.matches).toBe("*");
  });

  it("constructs a full ThreadEvent log", () => {
    expect(threadEvents.map((event) => event.type)).toEqual([
      "thread_metadata",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
    ]);
    const metadata = threadEvents[0];
    if (metadata?.type === "thread_metadata") {
      expect(metadata.threadId).toBe("t_123");
    }
  });

  it("supports a minimal Provider implementation with a full event turn", async () => {
    const seen: StreamEvent["type"][] = [];
    for await (const event of scriptedProvider.stream(chatRequest)) {
      seen.push(event.type);
    }
    expect(seen).toEqual([
      "text_delta",
      "tool_use_start",
      "tool_use_delta",
      "tool_use_end",
      "usage",
      "turn_complete",
    ]);

    const completion = await scriptedProvider.complete(chatRequest);
    expect(completion.stopReason).toBe("end_turn");
    expect(completion.usage.inputTokens).toBe(10);
  });

  it("narrows StreamEvent variants by discriminator", () => {
    const event: StreamEvent = { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    if (event.type === "usage") {
      expect(event.usage.inputTokens).toBe(1);
    }
    const delta: StreamEvent = { type: "text_delta", text: "hi" };
    if (delta.type === "text_delta") {
      expect(delta.text).toBe("hi");
    }
  });

  it("constructs the wave-2 additive fields", () => {
    const resultBlock: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "tu_1",
      content: [{ type: "text", text: "command timed out" }],
      isError: true,
      error: {
        code: "timeout",
        message: "command timed out after 30000ms",
        retryable: true,
        details: { timedOut: true },
      },
    };
    expect(resultBlock.error?.details).toEqual({ timedOut: true });

    const end: ToolUseEndEvent = { type: "tool_use_end", id: "tu_1", name: "bash", input: {} };
    expect(end.name).toBe("bash");

    const limits: OutputLimits = { maxTotalChars: 100, maxSectionChars: 100, maxLines: 50 };
    expect(limits.maxLines).toBe(50);

    const refusal: StopReason = "refusal"; // unknown vendor reason, verbatim
    expect(refusal).toBe("refusal");

    const ctx: ToolContext = { ...toolContext, signal: new AbortController().signal };
    expect(ctx.signal?.aborted).toBe(false);

    const offlineTool: ToolSpec = { ...bashTool, network: false };
    expect(offlineTool.network).toBe(false);
  });
});

describe("threadId helper (contracts gap #4)", () => {
  it("brands valid ids and keeps them assignable to plain strings", () => {
    const id = threadId("Az09_-thread");
    const asString: string = id; // ThreadId -> string is always allowed
    expect(asString).toBe("Az09_-thread");
  });

  it("accepts the full allowed alphabet", () => {
    expect(threadId("a")).toBe("a");
    expect(threadId("0123456789")).toBe("0123456789");
    expect(threadId("t_with-dots_none")).toBe("t_with-dots_none");
  });

  it("rejects ids outside the store charset (traversal, dotfiles, whitespace)", () => {
    for (const bad of ["", "../escape", "a/b", "a.b", "a b", ".", "t\n1", "idé"]) {
      expect(() => threadId(bad)).toThrow(/invalid thread id/);
    }
  });

  it("returns a value usable where ThreadId is required", () => {
    const metadata: ThreadEvent = {
      type: "thread_metadata",
      threadId: threadId("t_brand"),
      createdAt: "2026-10-10T00:00:00.000Z",
      at: "2026-10-10T00:00:00.000Z",
    };
    const id: ThreadId = metadata.threadId;
    expect(id).toBe("t_brand");
  });
});

// ---------------------------------------------------------------------------
// v1.1 additivity (ADR-0008): the compaction event kind is ADDED; every v1
// event kind's shape is unchanged. The v1 fixture above ("constructs a full
// ThreadEvent log") still asserts the frozen v1 discriminator sequence; these
// tests pin that the union only grew.
// ---------------------------------------------------------------------------

describe("ThreadEvent v1.1 additivity (ADR-0008)", () => {
  it("still constructs every v1 event kind exactly as frozen in v1", () => {
    // Mirrors the v1 fixture: the six original kinds, no field changes.
    expect(threadEvents.map((event) => event.type)).toEqual([
      "thread_metadata",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
    ]);
    // Compile-time conformance of each v1 shape (tsc --noEmit enforces).
    const v1: readonly ThreadEvent[] = threadEvents;
    expect(v1.length).toBe(6);
  });

  it("adds exactly one new kind, compaction, with the ADR-0008 shape", () => {
    const compaction: ThreadEvent = {
      type: "compaction",
      at: "2026-10-10T00:00:06.000Z",
      summary: "Goal: ship compaction. Files changed: src/contracts/thread.ts.",
      summarizedTurns: 3,
      keptTurns: 2,
      trigger: "threshold",
    };
    if (compaction.type === "compaction") {
      expect(compaction.summary).toContain("ship compaction");
      expect(compaction.summarizedTurns).toBe(3);
      expect(compaction.keptTurns).toBe(2);
      expect(compaction.trigger).toBe("threshold");
    }
    // The manual trigger value is a first-class member.
    const manual: ThreadEvent = { ...compaction, trigger: "manual" };
    expect(manual.type).toBe("compaction");

    // The optional fallback-window flag (ollama/openai passthrough policy).
    const assumed: ThreadEvent = { ...compaction, assumedContextWindow: true };
    if (assumed.type === "compaction") {
      expect(assumed.assumedContextWindow).toBe(true);
    }
    expect(compaction.assumedContextWindow).toBeUndefined();
  });

  it("keeps the v1 kind set unchanged (runtime discriminator census)", () => {
    // Every kind the v1 fixture exercises, asserted against the literal v1
    // list — a removed or renamed kind fails here AND in tsc.
    const kinds: Set<string> = new Set(threadEvents.map((event) => event.type));
    for (const kind of [
      "thread_metadata",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(kinds.has("compaction")).toBe(false); // the fixture is pure v1
  });
});
