/**
 * Tests for the composition root (`src/app/runner`): end-to-end task runs
 * against a scripted fake Provider (network-free), the permission-gated tool
 * registry, exit-code computation, thread persistence + resume-by-replay, and
 * the persistence adapter units. Real-OS-sandbox coverage runs on machines
 * that have sandbox-exec/bwrap under the Bun runtime (gated below).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  AssistantContentBlock,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  Provider,
  StreamEvent,
  ToolInput,
  UsageRecord,
} from "../contracts";
import { threadId } from "../contracts";
import { whichBinary } from "../sandbox/detect";
import {
  buildPermissionGate,
  conversationToEvents,
  RunnerError,
  replayFold,
  resolveProvider,
  runTask,
} from "./runner";

// ---------------------------------------------------------------------------
// Scripted fake provider (in-repo, network-free)
// ---------------------------------------------------------------------------

class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  readonly #rounds: readonly (readonly StreamEvent[])[];

  constructor(rounds: readonly (readonly StreamEvent[])[]) {
    this.#rounds = rounds;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.requests.push(request);
    const round = this.#rounds[this.requests.length - 1];
    if (round === undefined) {
      yield {
        type: "error",
        error: { message: "scripted provider: no round scripted for this call", retryable: false },
      };
      return;
    }
    for (const event of round) {
      yield event;
    }
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const events: StreamEvent[] = [];
    for await (const event of this.stream(request)) {
      events.push(event);
    }
    const content: AssistantContentBlock[] = [];
    let usage: UsageRecord = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "end_turn";
    for (const event of events) {
      if (event.type === "text_delta") {
        const text = content.at(-1);
        if (text !== undefined && text.type === "text") {
          content[content.length - 1] = { type: "text", text: `${text.text}${event.text}` };
        } else {
          content.push({ type: "text", text: event.text });
        }
      } else if (event.type === "tool_use_end") {
        content.push({
          type: "tool_use",
          id: event.id,
          ...(event.name !== undefined ? { name: event.name } : { name: "unknown" }),
          input: event.input,
        });
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "turn_complete") {
        stopReason = event.stopReason;
      }
    }
    return { content, usage, stopReason };
  }
}

const toolRound = (id: string, name: string, input: ToolInput): readonly StreamEvent[] => [
  { type: "text_delta", text: `using ${name}\n` },
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, name, input },
  { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
  { type: "turn_complete", stopReason: "tool_use" },
];

const textRound = (text: string): readonly StreamEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage: { inputTokens: 150, outputTokens: 30 } },
  { type: "turn_complete", stopReason: "end_turn" },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "void-runner-")));
const workspaces: string[] = [];
const dataDirs: string[] = [];
afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function makeWorkspace(name: string): string {
  const ws = mkdtempSync(join(scratchRoot, `${name}-ws-`));
  workspaces.push(ws);
  return ws;
}

function makeDataDir(name: string): string {
  const dir = mkdtempSync(join(scratchRoot, `${name}-data-`));
  dataDirs.push(dir);
  return dir;
}

const FIXED_NOW = "2026-10-10T12:00:00.000Z";

// Real sandbox suites need Bun (Bun.spawn) + the platform binary; plain-Node
// vitest runs skip them (same gating pattern as src/sandbox/run.test.ts).
const bunRuntime = typeof Bun !== "undefined";
const onMacosSandbox =
  bunRuntime && process.platform === "darwin" && whichBinary("sandbox-exec") !== null;
const onLinuxBwrap = bunRuntime && process.platform === "linux" && whichBinary("bwrap") !== null;
const realSandbox = onMacosSandbox || onLinuxBwrap;

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

describe("runTask end-to-end (scripted provider, network-free)", () => {
  it("runs a read_file + edit_file conversation: files change, thread persists, exit 0", async () => {
    const ws = makeWorkspace("e2e");
    const dataDir = makeDataDir("e2e");
    writeFileSync(join(ws, "notes.txt"), "hello world\nsecond line\n");

    const provider = new ScriptedProvider([
      toolRound("call-1", "read_file", { path: join(ws, "notes.txt") }),
      toolRound("call-2", "edit_file", {
        path: join(ws, "notes.txt"),
        old_str: "hello world",
        new_str: "hello void",
      }),
      textRound("done editing"),
    ]);

    const events: string[] = [];
    const outcome = await runTask({
      task: "edit the note",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "test prompt",
      now: () => FIXED_NOW,
      newId: () => "e2e-thread-1",
      onEngineEvent: (event) => {
        events.push(event.type);
      },
    });

    // Task completed: file changed, exit 0.
    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(join(ws, "notes.txt"), "utf8")).toBe("hello void\nsecond line\n");
    expect(outcome.result.stopReason).toBe("end_turn");
    expect(outcome.askOccurred).toBe(false);
    expect(outcome.rejectedOccurred).toBe(false);

    // Engine events flowed through (read + edit executed and finished).
    expect(events.filter((type) => type === "tool_call_started").length).toBe(2);
    expect(events.filter((type) => type === "tool_call_finished").length).toBe(2);
    expect(events.at(-1)).toBe("engine_stopped");

    // The provider saw the system prompt override and the task as messages.
    expect(provider.requests[0]?.system).toBe("test prompt");
    expect(provider.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "edit the note" }],
    });

    // Thread JSONL exists, starts with metadata, replays, and folds.
    const log = readFileSync(join(dataDir, "threads", "e2e-thread-1.jsonl"), "utf8");
    const lines = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines[0]?.type).toBe("thread_metadata");
    expect(lines[1]?.type).toBe("user_message");
    const types = lines.map((line) => line.type);
    expect(types).toEqual([
      "thread_metadata",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      "assistant_message",
      "usage",
    ]);

    const { JsonlThreadStore } = await import("../store/jsonl");
    const store = new JsonlThreadStore({ dataDir });
    const replayed = await store.replay(outcome.threadId);
    const folded = replayFold(replayed);
    // user, assistant(+tool_use), user(tool_result), assistant(+tool_use), user(tool_result), assistant(text)
    expect(folded.length).toBe(6);
    expect(folded[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "edit the note" }],
    });
    const firstAssistant = folded[1];
    expect(firstAssistant?.role).toBe("assistant");
    const toolUses = (firstAssistant?.content ?? []).filter((block) => block.type === "tool_use");
    expect(toolUses.length).toBe(1);
    const secondMessage = folded[2];
    expect(secondMessage?.role).toBe("user");
    const resultBlocks = (secondMessage?.content ?? []).filter(
      (block) => block.type === "tool_result",
    );
    expect(resultBlocks.length).toBe(1);
  });

  it("persists usage deltas per round (not cumulative)", async () => {
    const ws = makeWorkspace("usage");
    const dataDir = makeDataDir("usage");
    const provider = new ScriptedProvider([
      toolRound("c1", "read_file", { path: join(ws, "missing-ok.txt") }),
      textRound("done"),
    ]);
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      newId: () => "usage-thread-1",
    });
    const { JsonlThreadStore } = await import("../store/jsonl");
    const events = await new JsonlThreadStore({ dataDir }).replay(outcome.threadId);
    const usageEvents = events.filter((event) => event.type === "usage");
    expect(usageEvents.length).toBe(2);
    const round1 = usageEvents[0];
    const round2 = usageEvents[1];
    expect(round1?.type === "usage" && round1.usage.inputTokens).toBe(100);
    expect(round2?.type === "usage" && round2.usage.inputTokens).toBe(150);
  });

  it("assembles the default context: repo system prompt + AGENTS.md chain", async () => {
    const ws = makeWorkspace("ctx");
    writeFileSync(join(ws, "AGENTS.md"), "always answer in haiku for this project");
    const provider = new ScriptedProvider([textRound("done")]);
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir: makeDataDir("ctx"),
      newId: () => "ctx-thread-1",
    });
    expect(outcome.exitCode).toBe(0);
    // The engine (and thus the provider) saw BOTH the repo prompt and the
    // discovered AGENTS.md, deepest instructions last.
    expect(outcome.systemPrompt).toContain("You are Void");
    expect(outcome.systemPrompt).toContain("# Project instructions (AGENTS.md)");
    expect(outcome.systemPrompt).toContain("always answer in haiku");
    expect(provider.requests[0]?.system).toBe(outcome.systemPrompt);
  });

  it.skipIf(!realSandbox)(
    "runs bash inside the real OS sandbox writing inside the workspace",
    async () => {
      const ws = makeWorkspace("sandbox");
      const dataDir = makeDataDir("sandbox");
      const provider = new ScriptedProvider([
        toolRound("c1", "bash", { command: "echo sandbox-written > from-bash.txt" }),
        textRound("bash done"),
      ]);
      const outcome = await runTask({
        task: "write via bash",
        workspaceRoot: ws,
        modelRef: "anthropic/claude-sonnet-4-5",
        provider,
        dataDir,
        // DEFAULT_RULES ask on any non-read-only bash (unknown = ask); this
        // rule is the user-side unblock that lets the sandboxed write run.
        rules: [{ tool: "bash", matches: { command: "/^echo sandbox-written/" }, action: "allow" }],
        systemPrompt: "p",
        newId: () => "sandbox-thread-1",
      });
      expect(outcome.exitCode).toBe(0);
      expect(readFileSync(join(ws, "from-bash.txt"), "utf8")).toBe("sandbox-written\n");
    },
  );
});

// ---------------------------------------------------------------------------
// Permission paths
// ---------------------------------------------------------------------------

describe("runTask permission paths (DEFAULT_RULES)", () => {
  it("headless ask: git push is denied with remediation, exit 1, permission event recorded", async () => {
    const ws = makeWorkspace("ask");
    const dataDir = makeDataDir("ask");
    const provider = new ScriptedProvider([
      toolRound("c1", "bash", { command: "git push origin main" }),
      textRound("stopped by denial"),
    ]);
    const permissionRecords: string[] = [];
    const outcome = await runTask({
      task: "push it",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      newId: () => "ask-thread-1",
      onPermission: (record) => {
        permissionRecords.push(record.action);
      },
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.askOccurred).toBe(true);
    expect(outcome.rejectedOccurred).toBe(false);
    expect(permissionRecords).toEqual(["ask"]);

    // The model saw a denied tool result carrying the ask remediation.
    const denialMessage = outcome.result.messages.find(
      (message) => message.role === "user" && message.content.some((b) => b.type === "tool_result"),
    );
    expect(denialMessage).toBeDefined();
    const denied = outcome.result.messages.at(-2);
    const text = JSON.stringify(denied ?? {});
    expect(text).toContain("Permission denied for bash");
    expect(text).toContain("headless");
  });

  it("rule reject: catastrophic rm -rf is denied, exit 2", async () => {
    const ws = makeWorkspace("reject");
    const dataDir = makeDataDir("reject");
    const provider = new ScriptedProvider([
      toolRound("c1", "bash", { command: "rm -rf ~" }),
      textRound("stopped"),
    ]);
    const outcome = await runTask({
      task: "destroy",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      newId: () => "reject-thread-1",
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.rejectedOccurred).toBe(true);
    expect(outcome.permissions[0]?.action).toBe("reject");
    expect(outcome.permissions[0]?.headlessDenied).toBe(true);
  });

  it("provider/stream error: exit 3", async () => {
    const ws = makeWorkspace("perr");
    const dataDir = makeDataDir("perr");
    const provider = new ScriptedProvider([
      [
        {
          type: "error",
          error: { message: "boom: upstream 500", retryable: false, code: "overload" },
        },
      ],
    ]);
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      newId: () => "perr-thread-1",
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.stopReason).toBe("provider_error");
  });

  it("reject wins over ask when both occur (precedence 2 > 1)", async () => {
    const rules = [
      { tool: "bash", matches: { command: "/git push/" }, action: "ask" as const },
      { tool: "bash", matches: { command: "/rm -rf ~/" }, action: "reject" as const },
    ];
    const ws = makeWorkspace("precedence");
    const provider = new ScriptedProvider([
      toolRound("c1", "bash", { command: "git push" }),
      toolRound("c2", "bash", { command: "rm -rf ~" }),
      textRound("stopped"),
    ]);
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir: makeDataDir("precedence"),
      rules,
      systemPrompt: "p",
      newId: () => "prec-thread-1",
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.askOccurred).toBe(true);
    expect(outcome.rejectedOccurred).toBe(true);
  });

  it("reads are allowed without permission friction (exit 0, all allows)", async () => {
    const ws = makeWorkspace("allow");
    const provider = new ScriptedProvider([
      toolRound("c1", "read_file", { path: join(ws, "x.txt") }),
      textRound("ok"),
    ]);
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir: makeDataDir("allow"),
      systemPrompt: "p",
      newId: () => "allow-thread-1",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.permissions.map((record) => record.action)).toEqual(["allow"]);
    expect(outcome.permissions[0]?.headlessDenied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("runTask resume", () => {
  it("folds prior thread history into the provider request (resume = replay)", async () => {
    const ws = makeWorkspace("resume");
    const dataDir = makeDataDir("resume");
    writeFileSync(join(ws, "a.txt"), "alpha\n");

    const first = await runTask({
      task: "first task",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: new ScriptedProvider([
        toolRound("r1", "read_file", { path: join(ws, "a.txt") }),
        textRound("first done"),
      ]),
      dataDir,
      systemPrompt: "p",
      now: () => FIXED_NOW,
      newId: () => "resume-thread-1",
    });
    expect(first.exitCode).toBe(0);

    const secondProvider = new ScriptedProvider([textRound("second done")]);
    const second = await runTask({
      task: "second task",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: secondProvider,
      dataDir,
      threadId: first.threadId,
      systemPrompt: "p",
      now: () => FIXED_NOW,
    });
    expect(second.exitCode).toBe(0);
    expect(second.resumed).toBe(true);

    const messages = secondProvider.requests[0]?.messages ?? [];
    // first user, assistant(+tool_use), user(tool_result), assistant(text), second user = 5
    expect(messages.length).toBe(5);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "first task" }] });
    const priorResults = messages.find(
      (message): message is Extract<ChatMessage, { role: "user" }> =>
        message.role === "user" && message.content.some((block) => block.type === "tool_result"),
    );
    expect(priorResults).toBeDefined();
    expect(JSON.stringify(priorResults)).toContain("r1");
    expect(JSON.stringify(priorResults)).toContain("alpha");
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "second task" }],
    });
  });

  it("resuming an unknown thread throws RunnerError(unknown_thread)", async () => {
    const ws = makeWorkspace("unknown");
    await expect(
      runTask({
        task: "t",
        workspaceRoot: ws,
        modelRef: "anthropic/claude-sonnet-4-5",
        provider: new ScriptedProvider([]),
        dataDir: makeDataDir("unknown"),
        threadId: "does-not-exist",
        systemPrompt: "p",
      }),
    ).rejects.toMatchObject({ code: "unknown_thread", name: "RunnerError" });
  });

  it("resumes a crash-torn thread with an orphan tool_use via a synthesized result", async () => {
    const ws = makeWorkspace("torn");
    const dataDir = makeDataDir("torn");
    // Seed the store by hand: the process died after the model asked for a
    // tool but before the result was persisted (orphan tool_use in the log).
    const orphanUse = {
      type: "tool_use",
      id: "tu_orphan",
      name: "bash",
      input: { command: "ls" },
    };
    const lines = [
      JSON.stringify({
        type: "thread_metadata",
        threadId: "torn-thread-1",
        createdAt: FIXED_NOW,
        at: FIXED_NOW,
      }),
      JSON.stringify({
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "first task" }] },
        at: FIXED_NOW,
      }),
      JSON.stringify({
        type: "assistant_message",
        message: { role: "assistant", content: [orphanUse] },
        at: FIXED_NOW,
      }),
      JSON.stringify({
        type: "tool_call",
        toolUseId: "tu_orphan",
        name: "bash",
        input: { command: "ls" },
        at: FIXED_NOW,
      }),
    ];
    mkdirSync(join(dataDir, "threads"), { recursive: true });
    writeFileSync(join(dataDir, "threads", "torn-thread-1.jsonl"), `${lines.join("\n")}\n`);

    const provider = new ScriptedProvider([textRound("resumed fine")]);
    const outcome = await runTask({
      task: "continue",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      threadId: "torn-thread-1",
      systemPrompt: "p",
      now: () => FIXED_NOW,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.resumed).toBe(true);

    // The resumed request pairs the orphan tool_use with a synthesized error
    // result — without it Anthropic would 400 the whole resume.
    const messages = provider.requests[0]?.messages ?? [];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    const resultMessage = messages[2];
    const block = resultMessage?.content[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type === "tool_result") {
      expect(block.toolUseId).toBe("tu_orphan");
      expect(block.isError).toBe(true);
      expect(block.content[0]?.text).toContain("Tool call not executed");
    }
  });
});

// ---------------------------------------------------------------------------
// Composition units
// ---------------------------------------------------------------------------

describe("resolveProvider", () => {
  it("rejects unknown provider prefixes with guidance", () => {
    expect(() => resolveProvider("mystery/gpt-5")).toThrow(RunnerError);
    expect(() => resolveProvider("mystery/gpt-5")).toThrow(/anthropic\/<model-id>/);
  });

  it("builds anthropic and ollama adapters without throwing", () => {
    expect(resolveProvider("anthropic/claude-sonnet-4-5").id).toBe("anthropic");
    expect(resolveProvider("ollama/llama3").id).toBe("ollama");
  });

  it("builds the openai adapter without throwing (ADR-0010)", () => {
    expect(resolveProvider("openai/gpt-5").id).toBe("openai");
  });
});

describe("buildPermissionGate", () => {
  it("maps ask to a headless reject carrying remediation", async () => {
    const gate = buildPermissionGate(undefined, { workspaceRoot: "/ws" });
    const decision = await gate.requestPermission({
      tool: "bash",
      input: { command: "git push" },
      reason: "test",
    });
    expect(decision.action).toBe("reject");
    expect(decision.message).toContain("headless");
    expect(gate.state.askOccurred).toBe(true);
    expect(gate.records[0]?.action).toBe("ask");
  });

  it("records rejects separately from asks", async () => {
    const gate = buildPermissionGate(undefined, { workspaceRoot: "/ws" });
    await gate.requestPermission({ tool: "bash", input: { command: "rm -rf ~" }, reason: "t" });
    expect(gate.state.rejectedOccurred).toBe(true);
    expect(gate.state.askOccurred).toBe(false);
  });
});

describe("conversationToEvents / replayFold", () => {
  const AT = (): string => FIXED_NOW;

  it("round-trips an assistant tool_use + tool_result conversation", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "editing" },
          { type: "tool_use", id: "t1", name: "edit_file", input: { path: "/ws/a" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: [{ type: "text", text: "diff applied" }],
            isError: false,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const events = conversationToEvents(messages, [{ inputTokens: 5, outputTokens: 2 }], AT);
    expect(events.map((event) => event.type)).toEqual([
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      "assistant_message",
    ]);

    const folded = replayFold([
      {
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        at: FIXED_NOW,
      },
      ...events,
    ]);
    expect(folded).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      messages[0],
      messages[1],
      messages[2],
    ]);
  });

  it("groups consecutive tool_result events into one user message", () => {
    const folded = replayFold([
      {
        type: "thread_metadata",
        threadId: threadId("x"),
        createdAt: FIXED_NOW,
        at: FIXED_NOW,
      },
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "bash", input: {} },
            { type: "tool_use", id: "b", name: "grep", input: {} },
          ],
        },
        at: FIXED_NOW,
      },
      { type: "tool_call", toolUseId: "a", name: "bash", input: {}, at: FIXED_NOW },
      {
        type: "tool_result",
        toolUseId: "a",
        result: { content: [{ type: "text", text: "out a" }], isError: false },
        at: FIXED_NOW,
      },
      { type: "tool_call", toolUseId: "b", name: "grep", input: {}, at: FIXED_NOW },
      {
        type: "tool_result",
        toolUseId: "b",
        result: { content: [{ type: "text", text: "out b" }], isError: true },
        at: FIXED_NOW,
      },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 }, at: FIXED_NOW },
    ]);
    expect(folded.length).toBe(2);
    const results = folded[1];
    expect(results?.role).toBe("user");
    expect(results?.content.length).toBe(2);
    expect(JSON.stringify(folded[1])).toContain('"isError":true');
  });

  it("synthesizes an error result for an orphan tool_use (crash-torn log)", () => {
    const folded = replayFold([
      {
        type: "thread_metadata",
        threadId: threadId("torn"),
        createdAt: FIXED_NOW,
        at: FIXED_NOW,
      },
      {
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        at: FIXED_NOW,
      },
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          ],
        },
        at: FIXED_NOW,
      },
      { type: "tool_call", toolUseId: "t1", name: "bash", input: { command: "ls" }, at: FIXED_NOW },
      // Crash: no tool_result for t1 was ever persisted.
    ]);
    expect(folded.length).toBe(3);
    const synthesized = folded[2];
    expect(synthesized?.role).toBe("user");
    const block = synthesized?.content[0];
    expect(block).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      isError: true,
    });
    expect(JSON.stringify(block)).toContain("Tool call not executed");
  });

  it("synthesizes only for missing ids when some results were persisted", () => {
    const folded = replayFold([
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "bash", input: {} },
            { type: "tool_use", id: "b", name: "grep", input: {} },
          ],
        },
        at: FIXED_NOW,
      },
      {
        type: "tool_result",
        toolUseId: "a",
        result: { content: [{ type: "text", text: "out a" }], isError: false },
        at: FIXED_NOW,
      },
    ]);
    expect(folded.length).toBe(2);
    const results = folded[1];
    expect(results?.role).toBe("user");
    expect(
      results?.content.map((block) => (block.type === "tool_result" ? block.toolUseId : "")),
    ).toEqual(["a", "b"]);
    const synthesized = results?.content[1];
    expect(synthesized?.type === "tool_result" && synthesized.isError).toBe(true);
  });

  it("inserts the synthesized result before a later message, keeping the fold ordered", () => {
    const folded = replayFold([
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "o1", name: "bash", input: {} }],
        },
        at: FIXED_NOW,
      },
      {
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: "next task" }] },
        at: FIXED_NOW,
      },
    ]);
    expect(folded.map((message) => message.role)).toEqual(["assistant", "user", "user"]);
    const synthesized = folded[1]?.content[0];
    expect(synthesized?.type === "tool_result" && synthesized.toolUseId).toBe("o1");
    expect(folded[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "next task" }],
    });
  });
});
