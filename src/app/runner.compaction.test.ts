/**
 * Runner-level compaction tests (ADR-0008): end-to-end runs where the
 * scripted provider crosses the threshold mid-conversation, the compacted
 * thread's JSONL layout (append-only + chronologically interleaved compaction
 * event), resume of a compacted thread through replayFold, the manual force
 * (`void resume --compact` shape), the fail-loud stop, and the fallback
 * context-window policy for registry-passthrough model refs. Network-free.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  Provider,
  StreamEvent,
  ToolInput,
  UsageRecord,
  UserMessage,
} from "../contracts";
import type { CompactionRecord, EngineEvent } from "../core/engine";
import { JsonlThreadStore } from "../store/jsonl";
import { CUSTOM_FALLBACK_CONTEXT_WINDOW } from "./models";
import {
  conversationToEvents,
  conversationToEventsWithCompactions,
  replayFold,
  runTask,
} from "./runner";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Scripts stream rounds AND complete() (summarization) calls; records both. */
class CompactingProvider implements Provider {
  readonly id = "compacting";
  readonly streamRequests: ChatRequest[] = [];
  readonly completeRequests: ChatRequest[] = [];
  readonly #rounds: readonly (readonly StreamEvent[])[];
  readonly #completions: readonly (ChatCompletion | Error)[];
  #round = 0;
  #completion = 0;

  constructor(
    rounds: readonly (readonly StreamEvent[])[],
    completions: readonly (ChatCompletion | Error)[] = [],
  ) {
    this.#rounds = rounds;
    this.#completions = completions;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.streamRequests.push(request);
    const script = this.#rounds[this.#round];
    this.#round += 1;
    if (script === undefined) {
      yield {
        type: "error",
        error: { message: "CompactingProvider: no round scripted", retryable: false },
      };
      return;
    }
    yield* script;
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    this.completeRequests.push(request);
    const next = this.#completions[this.#completion];
    this.#completion += 1;
    if (next instanceof Error) {
      throw Object.assign(new Error(next.message), {
        providerError: { message: next.message, retryable: false, code: "summary_down" },
      });
    }
    if (next === undefined) {
      throw new Error("CompactingProvider: no completion scripted");
    }
    return next;
  }
}

function toolRound(
  id: string,
  input: ToolInput,
  usage: UsageRecord,
  text = `using ${id}`,
): readonly StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_end", id, name: "bash", input },
    { type: "usage", usage },
    { type: "turn_complete", stopReason: "tool_use" },
  ];
}

function textRound(text: string, usage: UsageRecord): readonly StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", usage },
    { type: "turn_complete", stopReason: "end_turn" },
  ];
}

function summaryCompletion(text: string): ChatCompletion {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 700, outputTokens: 80 },
    stopReason: "end_turn",
  };
}

// Round usage chosen against the real registry window (anthropic = 200_000,
// threshold 90% = 180_000): the estimate is the LAST round's report, whose
// inputTokens cover the whole context sent that round — so one round at
// ~180_040 is already over the line. Rounds 1-2 sit over it too, but the
// engine's cannot-shrink no-op (<= keepTurns=2 turns) keeps them running
// until round 3 makes the conversation shrinkable.
const BIG = { inputTokens: 179_900, outputTokens: 140 };

const COMPACTION_PROMPT = "TEST COMPACTION PROMPT";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "void-runner-compaction-")));
const dirs: string[] = [];
afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = mkdtempSync(join(scratchRoot, `${name}-`));
  dirs.push(dir);
  return dir;
}

const FIXED_NOW = "2026-10-12T09:00:00.000Z";

function readLogEvents(dataDir: string, id: string): { type: string }[] {
  const raw = readFileSync(join(dataDir, "threads", `${id}.jsonl`), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
}

// ---------------------------------------------------------------------------
// End-to-end: threshold compaction inside runTask
// ---------------------------------------------------------------------------

describe("runTask compaction end-to-end (ADR-0008)", () => {
  it("compacts at the threshold, persists the event in order, and replays the compacted view", async () => {
    const ws = makeDir("e2e-ws");
    const dataDir = makeDir("e2e-data");
    const provider = new CompactingProvider(
      [
        toolRound("c1", { command: "ls" }, BIG, "step one"),
        toolRound("c2", { command: "ls -la" }, BIG, "step two"),
        toolRound("c3", { command: "pwd" }, BIG, "step three"),
        textRound("all done", { inputTokens: 500, outputTokens: 60 }),
      ],
      [summaryCompletion("Goal reached; three steps verified.")],
    );
    const engineEvents: EngineEvent[] = [];
    const outcome = await runTask({
      task: "run three steps",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      compactionPrompt: COMPACTION_PROMPT,
      now: () => FIXED_NOW,
      newId: () => "compaction-e2e-1",
      onEngineEvent: (event) => engineEvents.push(event),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.stopReason).toBe("end_turn");

    // The summarization call: same provider, versioned prompt as system.
    expect(provider.completeRequests.length).toBe(1);
    expect(provider.completeRequests[0]?.system).toBe(COMPACTION_PROMPT);

    // The final conversation request carries [summary, kept rounds 2+3].
    const last = provider.streamRequests.at(-1);
    expect(last?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(last?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "[compaction summary]\nGoal reached; three steps verified.",
    });

    // The engine surfaced the compaction to the stream layer.
    const compactionEvent = engineEvents.find((event) => event.type === "compaction");
    expect(compactionEvent).toMatchObject({
      trigger: "threshold",
      summarizedTurns: 1,
      keptTurns: 2,
      assumedContextWindow: false,
    });

    // Thread JSONL: append-only — the summarized rounds stay, the compaction
    // event (and its usage event) land right after round 3, chronologically.
    const types = readLogEvents(dataDir, "compaction-e2e-1").map((event) => event.type);
    expect(types).toEqual([
      "thread_metadata",
      "user_message",
      // round 1 (summarized, still in the log)
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      // round 2 (kept)
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      // round 3 (kept) — estimate crossed 90% of 200k here
      "assistant_message",
      "tool_call",
      "tool_result",
      "usage",
      // the compaction marker + the summarization call's usage
      "compaction",
      "usage",
      // round 4 (post-compaction)
      "assistant_message",
      "usage",
    ]);

    // The persisted compaction event carries the ADR-0008 shape.
    const raw = readFileSync(join(dataDir, "threads", "compaction-e2e-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    const compactionSaved = raw.find((event) => event.type === "compaction");
    expect(compactionSaved).toMatchObject({
      type: "compaction",
      summary: "Goal reached; three steps verified.",
      summarizedTurns: 1,
      keptTurns: 2,
      trigger: "threshold",
      at: FIXED_NOW,
    });

    // Summary-call usage is recorded as its own usage event (700 + 80).
    const compactionIndex = raw.findIndex((event) => event.type === "compaction");
    expect(raw[compactionIndex + 1]).toMatchObject({ type: "usage" });

    // Resume = replay: the fold reproduces exactly what the provider saw.
    const store = new JsonlThreadStore({ dataDir });
    const folded = replayFold(await store.replay(outcome.threadId));
    expect(folded.map((message) => message.role)).toEqual([
      "user", // summary note
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant", // final text round
    ]);
    expect(folded[0]).toEqual(last?.messages[0]);
  });

  it("stops with exit 3 when summarization fails, and the log stays intact", async () => {
    const ws = makeDir("fail-ws");
    const dataDir = makeDir("fail-data");
    const provider = new CompactingProvider(
      [
        toolRound("c1", { command: "ls" }, BIG),
        toolRound("c2", { command: "ls" }, BIG),
        toolRound("c3", { command: "ls" }, BIG),
      ],
      [new Error("summary endpoint exploded")],
    );
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider,
      dataDir,
      systemPrompt: "p",
      compactionPrompt: COMPACTION_PROMPT,
      now: () => FIXED_NOW,
      newId: () => "compaction-fail-1",
    });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.stopReason).toBe("provider_error");
    expect(outcome.result.error?.message).toContain("compaction summarization failed");
    expect(outcome.result.error?.message).toContain("NOT truncated");

    // No compaction event was persisted; every completed round still is.
    const types = readLogEvents(dataDir, "compaction-fail-1").map((event) => event.type);
    expect(types.filter((type) => type === "compaction")).toEqual([]);
    expect(types.filter((type) => type === "assistant_message")).toHaveLength(3);
  });

  it("falls back to the 200k window for registry passthrough refs and reports the assumption", async () => {
    const ws = makeDir("ollama-ws");
    const dataDir = makeDir("ollama-data");
    const provider = new CompactingProvider(
      [
        toolRound("c1", { command: "ls" }, BIG),
        toolRound("c2", { command: "ls" }, BIG),
        toolRound("c3", { command: "ls" }, BIG),
        textRound("done", { inputTokens: 10, outputTokens: 2 }),
      ],
      [summaryCompletion("Assumed-window summary.")],
    );
    const engineEvents: EngineEvent[] = [];
    const outcome = await runTask({
      task: "t",
      workspaceRoot: ws,
      modelRef: "ollama/qwen3:14b", // passthrough: no registry window
      provider,
      dataDir,
      systemPrompt: "p",
      compactionPrompt: COMPACTION_PROMPT,
      now: () => FIXED_NOW,
      newId: () => "compaction-ollama-1",
      onEngineEvent: (event) => engineEvents.push(event),
    });

    expect(outcome.exitCode).toBe(0);
    const compactionEvent = engineEvents.find((event) => event.type === "compaction");
    // The fallback policy is explicit: CUSTOM_FALLBACK_CONTEXT_WINDOW (200k)
    // stood in for the unknown window, and the event says so.
    expect(CUSTOM_FALLBACK_CONTEXT_WINDOW).toBe(200_000);
    expect(compactionEvent).toMatchObject({ assumedContextWindow: true });
    const raw = readFileSync(join(dataDir, "threads", "compaction-ollama-1.jsonl"), "utf8");
    expect(raw).toContain('"assumedContextWindow":true');
  });
});

// ---------------------------------------------------------------------------
// Manual force (the `void resume --compact` shape) at the runner level
// ---------------------------------------------------------------------------

describe("runTask forceCompaction (manual, resume shape)", () => {
  it("compacts the replayed history before the first round of the resumed run", async () => {
    const ws = makeDir("manual-ws");
    const dataDir = makeDir("manual-data");

    // Seed: a first run that leaves three rounds in the thread.
    const first = await runTask({
      task: "first task",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: new CompactingProvider([
        toolRound("r1", { command: "ls" }, { inputTokens: 10, outputTokens: 2 }),
        toolRound("r2", { command: "ls" }, { inputTokens: 10, outputTokens: 2 }),
        textRound("first done", { inputTokens: 10, outputTokens: 2 }),
      ]),
      dataDir,
      systemPrompt: "p",
      compactionPrompt: COMPACTION_PROMPT,
      now: () => FIXED_NOW,
      newId: () => "manual-thread-1",
    });
    expect(first.exitCode).toBe(0);

    // Resume with the forced compaction.
    const second = new CompactingProvider(
      [textRound("second done", { inputTokens: 10, outputTokens: 2 })],
      [summaryCompletion("First task complete; two commands ran.")],
    );
    const outcome = await runTask({
      task: "second task",
      workspaceRoot: ws,
      modelRef: "anthropic/claude-sonnet-4-5",
      provider: second,
      dataDir,
      threadId: "manual-thread-1",
      systemPrompt: "p",
      compactionPrompt: COMPACTION_PROMPT,
      now: () => FIXED_NOW,
      forceCompaction: true,
    });

    expect(outcome.exitCode).toBe(0);
    // The summary call ran BEFORE the first round, over the replayed prefix
    // (seed + round 1; rounds 2-3 kept, plus the new task trailing).
    expect(second.completeRequests.length).toBe(1);
    expect(second.completeRequests[0]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    // The resumed conversation request = [summary, kept rounds 2+3 (with
    // round 2's tool result), new task].
    const request = second.streamRequests[0];
    expect(request?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(request?.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: "[compaction summary]\nFirst task complete; two commands ran.",
    });

    // The log gains compaction + usage BEFORE the new round's events.
    const types = readLogEvents(dataDir, "manual-thread-1").map((event) => event.type);
    const compactionAt = types.indexOf("compaction");
    expect(compactionAt).toBeGreaterThan(0);
    expect(types[compactionAt + 1]).toBe("usage");
    expect(types.slice(compactionAt + 2)).toEqual(["assistant_message", "usage"]);
    // The manual trigger is recorded.
    const raw = readFileSync(join(dataDir, "threads", "manual-thread-1.jsonl"), "utf8");
    expect(raw).toContain('"trigger":"manual"');
  });
});

// ---------------------------------------------------------------------------
// conversationToEventsWithCompactions + replayFold units
// ---------------------------------------------------------------------------

describe("conversationToEventsWithCompactions", () => {
  const AT = (): string => FIXED_NOW;
  const round = (id: string): ChatMessage[] => [
    { role: "assistant", content: [{ type: "text", text: id }] },
  ];
  const record = (
    afterRounds: number,
    trigger: "threshold" | "manual" = "threshold",
  ): CompactionRecord => ({
    trigger,
    summary: `summary after ${afterRounds}`,
    summarizedTurns: afterRounds,
    keptTurns: 2,
    afterRounds,
    usage: { inputTokens: 9, outputTokens: 4 },
    assumedContextWindow: false,
  });

  it("equals conversationToEvents when no compaction ran", () => {
    const messages = [...round("a"), ...round("b")];
    const usage = [{ inputTokens: 1, outputTokens: 1 }];
    expect(conversationToEventsWithCompactions(messages, [], usage, AT)).toEqual(
      conversationToEvents(messages, usage, AT),
    );
  });

  it("interleaves the compaction + usage events right after the recorded rounds", () => {
    const messages = [...round("a"), ...round("b"), ...round("c")];
    const events = conversationToEventsWithCompactions(
      messages,
      [record(2)],
      [
        { inputTokens: 1, outputTokens: 1 },
        { inputTokens: 2, outputTokens: 1 },
        { inputTokens: 3, outputTokens: 1 },
      ],
      AT,
    );
    expect(events.map((event) => event.type)).toEqual([
      "assistant_message",
      "usage",
      "assistant_message",
      "usage",
      "compaction",
      "usage",
      "assistant_message",
      "usage",
    ]);
  });

  it("supports a compaction before any round (afterRounds 0, forced resume)", () => {
    const events = conversationToEventsWithCompactions(
      [...round("a")],
      [record(0, "manual")],
      [{ inputTokens: 1, outputTokens: 1 }],
      AT,
    );
    expect(events.map((event) => event.type)).toEqual([
      "compaction",
      "usage",
      "assistant_message",
      "usage",
    ]);
  });

  it("carries assumedContextWindow only when the window was the fallback", () => {
    const events = conversationToEventsWithCompactions(
      [...round("a"), ...round("b"), ...round("c")],
      [{ ...record(2), assumedContextWindow: true }],
      [],
      AT,
    );
    const compaction = events.find((event) => event.type === "compaction");
    expect(JSON.stringify(compaction)).toContain('"assumedContextWindow":true');
    const known = conversationToEventsWithCompactions(
      [...round("a"), ...round("b"), ...round("c")],
      [record(2)],
      [],
      AT,
    );
    expect(JSON.stringify(known.find((event) => event.type === "compaction"))).not.toContain(
      "assumedContextWindow",
    );
  });
});

describe("replayFold with compaction events", () => {
  const userText = (text: string): UserMessage => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const assistant = (text: string): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  it("replaces the folded prefix with the summary message ahead of the kept rounds", () => {
    const folded = replayFold([
      {
        type: "user_message",
        message: userText("original task"),
        at: FIXED_NOW,
      },
      { type: "assistant_message", message: assistant("r1"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r2"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r3"), at: FIXED_NOW },
      { type: "user_message", message: userText("next task"), at: FIXED_NOW },
      {
        type: "compaction",
        summary: "Did r1-r3.",
        summarizedTurns: 1,
        keptTurns: 2,
        trigger: "threshold",
        at: FIXED_NOW,
      },
    ]);
    expect(folded.map((message) => (message.role === "assistant" ? "a" : "u"))).toEqual([
      "u",
      "a",
      "a",
      "u",
    ]);
    expect(folded[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[compaction summary]\nDid r1-r3." }],
    });
    expect(folded[1]).toEqual(assistant("r2"));
    expect(folded[3]).toEqual(userText("next task"));
  });

  it("chains: a later compaction re-collapses the earlier summary and rounds", () => {
    const folded = replayFold([
      { type: "user_message", message: userText("task"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r1"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r2"), at: FIXED_NOW },
      {
        type: "compaction",
        summary: "first summary",
        summarizedTurns: 1,
        keptTurns: 1,
        trigger: "threshold",
        at: FIXED_NOW,
      },
      { type: "assistant_message", message: assistant("r3"), at: FIXED_NOW },
      {
        type: "compaction",
        summary: "second summary",
        summarizedTurns: 1,
        keptTurns: 1,
        trigger: "threshold",
        at: FIXED_NOW,
      },
    ]);
    // After the 2nd compaction: [note2, r3] — the first summary and r2 are gone.
    expect(folded).toEqual([
      { role: "user", content: [{ type: "text", text: "[compaction summary]\nsecond summary" }] },
      assistant("r3"),
    ]);
  });

  it("keeps everything when the folded history cannot shrink (keptTurns >= rounds)", () => {
    const folded = replayFold([
      { type: "assistant_message", message: assistant("r1"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r2"), at: FIXED_NOW },
      {
        type: "compaction",
        summary: "s",
        summarizedTurns: 0,
        keptTurns: 2,
        trigger: "manual",
        at: FIXED_NOW,
      },
    ]);
    expect(folded.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("flushes a torn orphan tool_use before collapsing (log stays provider-valid)", () => {
    const folded = replayFold([
      { type: "user_message", message: userText("task"), at: FIXED_NOW },
      {
        type: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "o1", name: "bash", input: { command: "ls" } },
          ],
        },
        at: FIXED_NOW,
      },
      // Crash: no tool_result persisted; then a later session compacted.
      { type: "assistant_message", message: assistant("r2"), at: FIXED_NOW },
      { type: "assistant_message", message: assistant("r3"), at: FIXED_NOW },
      {
        type: "compaction",
        summary: "s",
        summarizedTurns: 1,
        keptTurns: 2,
        trigger: "threshold",
        at: FIXED_NOW,
      },
    ]);
    // The synthesized orphan result rides inside the summarized prefix; the
    // kept window [r2, r3] has no unpaired tool_use.
    expect(folded.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(JSON.stringify(folded[0])).toContain("[compaction summary]");
  });
});
