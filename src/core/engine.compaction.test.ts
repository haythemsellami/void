/**
 * Engine-level compaction tests (ADR-0008): the pre-round threshold check,
 * the manual force, the compacted view vs the full transcript, usage
 * accounting for summary calls, the cannot-shrink no-op, and the fail-loud
 * stop. Providers are scripted fakes covering BOTH `stream` (conversation
 * rounds) and `complete` (summarization calls).
 */
import { describe, expect, it } from "vitest";
import type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  Provider,
  StreamEvent,
  ToolResult,
  ToolSpec,
  UserMessage,
} from "../contracts";
import { type CompactionConfig, type EngineEvent, runConversation } from "./engine";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Scripts stream rounds and complete() calls independently; records both. */
class CompactingScriptedProvider implements Provider {
  readonly id = "compacting-scripted";
  readonly streamRequests: ChatRequest[] = [];
  readonly completeRequests: ChatRequest[] = [];
  readonly #rounds: readonly (readonly StreamEvent[])[];
  readonly #completions: readonly (ChatCompletion | Error)[];
  #nextRound = 0;
  #nextCompletion = 0;

  constructor(
    rounds: readonly (readonly StreamEvent[])[],
    completions: readonly (ChatCompletion | Error)[] = [],
  ) {
    this.#rounds = rounds;
    this.#completions = completions;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.streamRequests.push(request);
    const round = this.#rounds[this.#nextRound];
    this.#nextRound += 1;
    if (round === undefined) {
      yield {
        type: "error",
        error: {
          message: `CompactingScriptedProvider: no round scripted for call ${this.#nextRound}`,
          retryable: false,
        },
      };
      return;
    }
    yield* round;
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    this.completeRequests.push(request);
    const next = this.#completions[this.#nextCompletion];
    this.#nextCompletion += 1;
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error("CompactingScriptedProvider: no completion scripted");
    }
    return next;
  }
}

const echoTool: ToolSpec = {
  name: "echo",
  description: "echoes its input",
  inputSchema: { type: "object", properties: {}, required: [] },
  source: "builtin",
  async execute(_: unknown): Promise<ToolResult> {
    return { content: [{ type: "text", text: "ok" }], isError: false };
  },
};

function toolRound(id: string, input: number, output: number): readonly StreamEvent[] {
  return [
    { type: "text_delta", text: `round ${id}` },
    { type: "tool_use_start", id, name: "echo" },
    { type: "tool_use_end", id, name: "echo", input: {} },
    { type: "usage", usage: { inputTokens: input, outputTokens: output } },
    { type: "turn_complete", stopReason: "tool_use" },
  ];
}

function textRound(text: string, input = 10, output = 5): readonly StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: input, outputTokens: output } },
    { type: "turn_complete", stopReason: "end_turn" },
  ];
}

function summaryCompletion(text: string, input = 7, output = 3): ChatCompletion {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: input, outputTokens: output },
    stopReason: "end_turn",
  };
}

const PROMPT = "TEST COMPACTION PROMPT";

function config(overrides: Partial<CompactionConfig> = {}): { compaction: CompactionConfig } {
  return { compaction: { prompt: PROMPT, ...overrides } };
}

const seed: UserMessage = { role: "user", content: [{ type: "text", text: "do the task" }] };

async function run(
  provider: Provider,
  options: {
    readonly messages?: readonly ChatMessage[];
    readonly compaction?: CompactionConfig;
  } = {},
): Promise<{ events: EngineEvent[] }> {
  const events: EngineEvent[] = [];
  await runConversation({
    provider,
    model: "mock/model",
    registry: new Map([[echoTool.name, echoTool]]),
    system: "You are Void.",
    messages: options.messages ?? [seed],
    config: {
      onEvent: (event) => events.push(event),
      ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    },
  });
  return { events };
}

// ---------------------------------------------------------------------------
// Threshold trigger
// ---------------------------------------------------------------------------

describe("runConversation compaction (threshold, ADR-0008)", () => {
  it("does not compact below the threshold (just-below wiring)", async () => {
    const provider = new CompactingScriptedProvider([
      toolRound("t1", 400, 20),
      toolRound("t2", 400, 20),
      toolRound("t3", 400, 20),
      textRound("done"),
    ]);
    // 3 rounds ≈ 420 tokens + tiny local chars — far below 90% of 1000.
    const { events } = await run(provider, config({ contextWindow: 1000, thresholdPercent: 90 }));

    expect(provider.completeRequests).toEqual([]);
    expect(events.filter((event) => event.type === "compaction")).toEqual([]);
  });

  it("compacts before the next round once the estimate crosses the threshold", async () => {
    const provider = new CompactingScriptedProvider(
      [
        toolRound("t1", 300, 50),
        toolRound("t2", 300, 50),
        toolRound("t3", 300, 50),
        textRound("done"),
      ],
      [summaryCompletion("SUMMARY TEXT")],
    );
    // After round 3: estimate = 350 + chars/4 of round-3 results (~385) —
    // over 90% of a 300-token window; earlier checks cannot shrink (<= 2 turns).
    const { events } = await run(
      provider,
      config({ contextWindow: 300, thresholdPercent: 90, keepTurns: 2 }),
    );

    // The summarization call: same provider, compaction prompt as system,
    // prefix = [seed, round1 assistant, round1 results], no tools.
    expect(provider.completeRequests.length).toBe(1);
    const summaryRequest = provider.completeRequests[0];
    expect(summaryRequest?.system).toBe(PROMPT);
    expect(summaryRequest?.tools).toBeUndefined();
    expect(summaryRequest?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    // The next conversation request carries [summary, kept rounds 2+3].
    const lastRequest = provider.streamRequests.at(-1);
    const roles = lastRequest?.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const note = lastRequest?.messages[0]?.content[0];
    expect(note?.type === "text" && note.text).toBe("[compaction summary]\nSUMMARY TEXT");

    // The engine event carries the ADR numbers and the summary call's usage.
    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction).toMatchObject({
      trigger: "threshold",
      summarizedTurns: 1,
      keptTurns: 2,
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it("counts local additions (chars/4) when the final round reports no usage", async () => {
    // Round 3 omits its usage event: its 3000-char assistant text plus the
    // dispatched tool result are charged at chars/4 (~800 tokens) — over 90%
    // of a 100-token window even though no usage record backs them.
    const roundWithoutUsage: readonly StreamEvent[] = [
      { type: "text_delta", text: "x".repeat(3_000) },
      { type: "tool_use_start", id: "t3", name: "echo" },
      { type: "tool_use_end", id: "t3", name: "echo", input: {} },
      { type: "turn_complete", stopReason: "tool_use" },
    ];
    const provider = new CompactingScriptedProvider([
      toolRound("t1", 300, 50),
      toolRound("t2", 300, 50),
      roundWithoutUsage,
      textRound("done"),
    ]);
    await run(provider, config({ contextWindow: 100, thresholdPercent: 90, keepTurns: 2 }));
    expect(provider.completeRequests.length).toBe(1);
  });

  it("compacts again only after another round completes (cannot-shrink no-op between)", async () => {
    const provider = new CompactingScriptedProvider(
      [
        toolRound("t1", 300, 50),
        toolRound("t2", 300, 50),
        toolRound("t3", 300, 50),
        toolRound("t4", 300, 50),
        textRound("done"),
      ],
      [summaryCompletion("SUMMARY ONE"), summaryCompletion("SUMMARY TWO")],
    );
    const { events } = await run(
      provider,
      config({ contextWindow: 300, thresholdPercent: 90, keepTurns: 2 }),
    );
    const compactionEvents = events.filter((event) => event.type === "compaction");
    // One compaction per check that can shrink: after round 3, then again
    // after round 4 — but NEVER two summarization calls back-to-back (the
    // post-compaction view holds exactly keepTurns turns, so the next check
    // is a cannot-shrink no-op until a round adds a turn).
    expect(provider.completeRequests.length).toBe(2);
    expect(compactionEvents).toHaveLength(2);
    // The second summary summarizes the previous summary note plus the
    // oldest kept round: its prefix starts with the FIRST summary marker.
    const secondPrefix = provider.completeRequests[1]?.messages;
    expect(secondPrefix?.[0]?.content[0]).toMatchObject({ type: "text" });
    const text = secondPrefix?.[0]?.content[0];
    expect(text?.type === "text" && text.text).toContain("[compaction summary]");
    // The 2nd compaction summarized exactly one round of the live view.
    expect(compactionEvents[1]).toMatchObject({ summarizedTurns: 1, keptTurns: 2 });
  });
});

// ---------------------------------------------------------------------------
// Manual force
// ---------------------------------------------------------------------------

describe("runConversation compaction (manual force)", () => {
  const history: readonly ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "original task" }] },
    { role: "assistant", content: [{ type: "text", text: "round 1" }] },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "round 2" }] },
    { role: "assistant", content: [{ type: "text", text: "round 3" }] },
    { role: "user", content: [{ type: "text", text: "continue with step 2" }] },
  ];

  it("forces one compaction before the first round (resume --compact shape)", async () => {
    const provider = new CompactingScriptedProvider(
      [textRound("done")],
      [summaryCompletion("FORCED SUMMARY")],
    );
    const { events } = await run(provider, {
      messages: history,
      compaction: { prompt: PROMPT, force: true },
    });

    expect(provider.completeRequests.length).toBe(1);
    const summaryRequest = provider.completeRequests[0];
    // Boundary keeps rounds 2+3 and the trailing new task message, so the
    // summarized prefix is [original task, round 1, round-1 results].
    expect(summaryRequest?.messages.length).toBe(3);
    expect(summaryRequest?.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "round 1" }],
    });
    expect(summaryRequest?.messages.at(-1)?.role).toBe("user");

    const first = provider.streamRequests[0];
    expect(first?.messages.map((message) => message.role)).toEqual([
      "user", // summary note
      "assistant", // round 2
      "assistant", // round 3
      "user", // continue with step 2
    ]);
    const note = first?.messages[0]?.content[0];
    expect(note?.type === "text" && note.text).toBe("[compaction summary]\nFORCED SUMMARY");

    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction).toMatchObject({ trigger: "manual", summarizedTurns: 1, keptTurns: 2 });
  });

  it("is a no-op (not an error) when the conversation cannot shrink", async () => {
    const small: readonly ChatMessage[] = history.slice(0, 4); // 2 rounds + seed
    const provider = new CompactingScriptedProvider([textRound("done")]);
    const { events } = await run(provider, {
      messages: small,
      compaction: { prompt: PROMPT, force: true },
    });
    expect(provider.completeRequests).toEqual([]);
    expect(events.filter((event) => event.type === "compaction")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Result shape, usage accounting, fail-loud
// ---------------------------------------------------------------------------

describe("runConversation compaction (result + failures)", () => {
  it("returns the never-compacted transcript and afterRounds for persistence", async () => {
    const provider = new CompactingScriptedProvider(
      [
        toolRound("t1", 300, 50),
        toolRound("t2", 300, 50),
        toolRound("t3", 300, 50),
        textRound("done"),
      ],
      [summaryCompletion("SUMMARY TEXT")],
    );
    const result = await runConversation({
      provider,
      model: "mock/model",
      registry: new Map([[echoTool.name, echoTool]]),
      messages: [seed],
      config: {
        compaction: { prompt: PROMPT, contextWindow: 300, thresholdPercent: 90 },
      },
    });

    expect(result.compactions).toEqual([
      {
        trigger: "threshold",
        summary: "SUMMARY TEXT",
        summarizedTurns: 1,
        keptTurns: 2,
        afterRounds: 3,
        usage: { inputTokens: 7, outputTokens: 3 },
        assumedContextWindow: false,
      },
    ]);
    // Full transcript: seed + 3 tool rounds + final text round — nothing lost.
    expect(result.messages[0]).toEqual(seed);
    expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(4);
    // Rounds counts conversation rounds only, not the summarization call.
    expect(result.rounds).toBe(4);
  });

  it("includes the summarization call's usage in totalUsage", async () => {
    const provider = new CompactingScriptedProvider(
      [
        toolRound("t1", 300, 50),
        toolRound("t2", 300, 50),
        toolRound("t3", 300, 50),
        textRound("done", 400, 60),
      ],
      [summaryCompletion("SUMMARY TEXT", 7, 3)],
    );
    const result = await runConversation({
      provider,
      model: "mock/model",
      registry: new Map([[echoTool.name, echoTool]]),
      messages: [seed],
      config: {
        compaction: { prompt: PROMPT, contextWindow: 300, thresholdPercent: 90 },
      },
    });
    // 4 conversation rounds (350*3 + 460) + summary (7 + 3) = 1520.
    expect(result.totalUsage).toEqual({ inputTokens: 1307, outputTokens: 213 });
  });

  it("stops the run with provider_error when summarization fails — nothing truncated", async () => {
    const thrown = Object.assign(new Error("summary endpoint 500"), {
      providerError: { message: "summary endpoint 500", retryable: true, code: "overload" },
    });
    const provider = new CompactingScriptedProvider([textRound("done")], [thrown]);
    const { events } = await run(provider, {
      messages: [
        { role: "user", content: [{ type: "text", text: "task" }] },
        { role: "assistant", content: [{ type: "text", text: "r1" }] },
        { role: "assistant", content: [{ type: "text", text: "r2" }] },
        { role: "assistant", content: [{ type: "text", text: "r3" }] },
      ],
      compaction: { prompt: PROMPT, force: true },
    });

    const stopped = events.at(-1);
    expect(stopped).toMatchObject({ type: "engine_stopped", reason: "provider_error" });
    const message = stopped !== undefined && "message" in stopped ? stopped.message : undefined;
    expect(message).toContain("compaction summarization failed");
    expect(message).toContain("summary endpoint 500");
    expect(message).toContain("NOT truncated");
    expect(events.filter((event) => event.type === "compaction")).toEqual([]);
  });

  it("propagates assumedContextWindow from the config to events and records", async () => {
    const provider = new CompactingScriptedProvider(
      [
        toolRound("t1", 300, 50),
        toolRound("t2", 300, 50),
        toolRound("t3", 300, 50),
        textRound("done"),
      ],
      [summaryCompletion("SUMMARY TEXT")],
    );
    const { events } = await run(
      provider,
      config({ contextWindow: 300, thresholdPercent: 90, assumedContextWindow: true }),
    );
    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction).toMatchObject({ type: "compaction", assumedContextWindow: true });
  });

  it("rejects invalid compaction config loudly (fail-loud knobs)", async () => {
    const provider = new CompactingScriptedProvider([]);
    await expect(
      run(provider, { compaction: { prompt: "  ", contextWindow: 100 } }),
    ).rejects.toThrow("compaction.prompt");
    await expect(run(provider, { compaction: { prompt: PROMPT, keepTurns: -1 } })).rejects.toThrow(
      "keepTurns",
    );
    await expect(
      run(provider, { compaction: { prompt: PROMPT, thresholdPercent: 0 } }),
    ).rejects.toThrow("thresholdPercent");
    await expect(
      run(provider, { compaction: { prompt: PROMPT, contextWindow: -5 } }),
    ).rejects.toThrow("contextWindow");
  });
});
