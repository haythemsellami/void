/**
 * Unit tests for `src/core/compaction` (ADR-0008): token estimation and its
 * exact trigger boundary, the keep-newest-turns split, the pinned summary
 * message text, and the summarization provider call's success/failure paths.
 * Pure functions plus scripted fakes — deterministic, network-free.
 */
import { describe, expect, it } from "vitest";
import type { ChatCompletion, ChatRequest, Provider, StreamEvent, UsageRecord } from "../contracts";
import {
  CHARS_PER_TOKEN,
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
// Fakes
// ---------------------------------------------------------------------------

class CompleteScriptedProvider implements Provider {
  readonly id = "complete-scripted";
  readonly completeRequests: ChatRequest[] = [];
  readonly #completions: readonly (ChatCompletion | Error)[];

  constructor(completions: readonly (ChatCompletion | Error)[]) {
    this.#completions = completions;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    yield {
      type: "error",
      error: { message: "stream is not used by these tests", retryable: false },
    };
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    this.completeRequests.push(request);
    const next = this.#completions[this.completeRequests.length - 1];
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error("CompleteScriptedProvider: no completion scripted");
    }
    return next;
  }
}

const completion = (text: string, usage: UsageRecord = { inputTokens: 5, outputTokens: 2 }) => ({
  content: [{ type: "text" as const, text }],
  usage,
  stopReason: "end_turn" as const,
});

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

describe("estimateContextTokens", () => {
  it("returns chars/4 (rounded up) when no provider usage exists yet", () => {
    expect(estimateContextTokens({ localChars: 0 })).toBe(0);
    expect(estimateContextTokens({ localChars: CHARS_PER_TOKEN })).toBe(1);
    expect(estimateContextTokens({ localChars: CHARS_PER_TOKEN + 1 })).toBe(2);
    expect(estimateContextTokens({ localChars: 999 })).toBe(250);
  });

  it("sums last input + output tokens plus chars/4 for local additions", () => {
    const estimate = estimateContextTokens({
      lastUsage: { inputTokens: 850, outputTokens: 40 },
      localChars: 100,
    });
    expect(estimate).toBe(850 + 40 + 25);
  });

  it("is conservative: output tokens count toward the next request's context", () => {
    expect(
      estimateContextTokens({ lastUsage: { inputTokens: 0, outputTokens: 500 }, localChars: 0 }),
    ).toBe(500);
  });

  it("keeps cache fields out of the estimate (they are not charged twice)", () => {
    const estimate = estimateContextTokens({
      lastUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 9_000,
        cacheCreationTokens: 800,
      },
      localChars: 0,
    });
    expect(estimate).toBe(15);
  });
});

describe("messageChars", () => {
  it("counts the JSON chars of every message", () => {
    const chars = messageChars([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(chars).toBe(
      JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }).length +
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }).length,
    );
  });
});

// ---------------------------------------------------------------------------
// Trigger boundary (exact integer arithmetic)
// ---------------------------------------------------------------------------

describe("meetsCompactionThreshold", () => {
  it("trips exactly AT the threshold (90% of 1000 = 900)", () => {
    expect(meetsCompactionThreshold(900, 1000, 90)).toBe(true);
  });

  it("does not trip one token below (899 of 1000 at 90%)", () => {
    expect(meetsCompactionThreshold(899, 1000, 90)).toBe(false);
  });

  it("trips one token above (901 of 1000 at 90%)", () => {
    expect(meetsCompactionThreshold(901, 1000, 90)).toBe(true);
  });

  it("handles non-round percentages without float drift (37% of 200000)", () => {
    expect(meetsCompactionThreshold(73_999, 200_000, 37)).toBe(false);
    expect(meetsCompactionThreshold(74_000, 200_000, 37)).toBe(true);
  });

  it("never trips with a non-positive window or percent", () => {
    expect(meetsCompactionThreshold(1_000_000, 0, 90)).toBe(false);
    expect(meetsCompactionThreshold(1_000_000, 1000, 0)).toBe(false);
  });

  it("exposes the ADR defaults (90 percent, 2 kept turns)", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD_PERCENT).toBe(90);
    expect(DEFAULT_COMPACTION_KEEP_TURNS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The keep-newest-turns split
// ---------------------------------------------------------------------------

const textMessage = (role: "user" | "assistant", text: string) => ({
  role,
  content: [{ type: "text" as const, text }],
});

describe("splitForCompaction", () => {
  const seed = textMessage("user", "do the task");
  const a1 = textMessage("assistant", "round 1");
  const u1 = {
    role: "user" as const,
    content: [{ type: "tool_result" as const, toolUseId: "t1", content: [], isError: false }],
  };
  const a2 = textMessage("assistant", "round 2");
  const a3 = textMessage("assistant", "round 3");
  const u1again = {
    role: "user" as const,
    content: [{ type: "tool_result" as const, toolUseId: "t2", content: [], isError: false }],
  };
  const nextTask = textMessage("user", "and now step 2");

  it("summarizes everything older than the newest keepTurns rounds", () => {
    const split = splitForCompaction([seed, a1, u1, a2, a3, nextTask], 2);
    expect(split).toBeDefined();
    // Rounds: a1, a2, a3 — keep 2 → boundary at a2.
    expect(split?.prefix).toEqual([seed, a1, u1]);
    expect(split?.kept).toEqual([a2, a3, nextTask]);
    expect(split?.totalTurns).toBe(3);
  });

  it("keeps a trailing user task message verbatim (never summarized)", () => {
    const split = splitForCompaction([seed, a1, u1, a2, a3, nextTask], 2);
    const lastKept = split?.kept.at(-1);
    expect(lastKept).toEqual(nextTask);
  });

  it("returns undefined when the conversation cannot shrink (turns <= keepTurns)", () => {
    expect(splitForCompaction([seed, a1, u1, a2], 2)).toBeUndefined();
    expect(splitForCompaction([seed], 0)).toBeUndefined();
    expect(splitForCompaction([], 2)).toBeUndefined();
  });

  it("keepTurns 0 summarizes every round but never the trailing task message", () => {
    const split = splitForCompaction([seed, a1, u1, a2, a3, nextTask], 0);
    expect(split?.prefix).toEqual([seed, a1, u1, a2, a3]);
    expect(split?.kept).toEqual([nextTask]);
    expect(split?.totalTurns).toBe(3);
  });

  it("keepTurns 0 keeps nothing when the conversation ends inside the last round", () => {
    const split = splitForCompaction([seed, a1, u1, a2, u1again], 0);
    expect(split?.kept).toEqual([]);
    expect(split?.prefix).toEqual([seed, a1, u1, a2, u1again]);
  });
});

describe("summaryMessage", () => {
  it("materializes as a user message with the pinned marker text (amended ADR-0008)", () => {
    const message = summaryMessage("Goal: ship it.");
    expect(message.role).toBe("user");
    expect(message.content).toEqual([
      { type: "text", text: "[compaction summary]\nGoal: ship it." },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The summarization call
// ---------------------------------------------------------------------------

describe("summarizePrefix", () => {
  const prefix = [textMessage("user", "task"), textMessage("assistant", "did things")];

  it("calls complete() with the compaction prompt as system, the prefix as messages, and no tools", async () => {
    const provider = new CompleteScriptedProvider([completion("SUMMARY")]);
    const result = await summarizePrefix({
      provider,
      model: "mock/model",
      prompt: "SUMMARIZE PROMPT",
      prefix,
      params: { temperature: 0.1 },
    });

    expect(result.summary).toBe("SUMMARY");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    const request = provider.completeRequests[0];
    expect(request?.model).toBe("mock/model");
    expect(request?.system).toBe("SUMMARIZE PROMPT");
    expect(request?.messages).toEqual(prefix);
    expect(request?.tools).toBeUndefined();
    expect(request?.params).toEqual({ temperature: 0.1 });
  });

  it("joins multiple text blocks and trims surrounding whitespace", async () => {
    const provider = new CompleteScriptedProvider([
      {
        content: [
          { type: "text", text: "  part one  " },
          { type: "text", text: "part two" },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      },
    ]);
    const result = await summarizePrefix({
      provider,
      model: "m",
      prompt: "p",
      prefix,
    });
    expect(result.summary).toBe("part one  \npart two"); // ends trimmed, inner text verbatim
  });

  it("fails loud on an empty summary (never an empty replacement)", async () => {
    const provider = new CompleteScriptedProvider([completion("   \n ")]);
    await expect(
      summarizePrefix({ provider, model: "m", prompt: "p", prefix }),
    ).rejects.toMatchObject({
      name: "CompactionError",
      compactionError: { code: "compaction_empty_summary", retryable: true },
    });
  });

  it("maps a thrown ProviderCallError to compaction_failed with remediation", async () => {
    const thrown = Object.assign(new Error("upstream 500"), {
      providerError: { message: "upstream 500", retryable: true, code: "overload" },
    });
    const provider = new CompleteScriptedProvider([thrown]);
    const failure = await summarizePrefix({ provider, model: "m", prompt: "p", prefix }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "CompactionError",
      compactionError: { code: "compaction_failed", retryable: true },
    });
    const message = (failure as { compactionError: { message: string } }).compactionError.message;
    expect(message).toContain("compaction summarization failed: upstream 500");
    expect(message).toContain("NOT truncated");
  });

  it("maps an arbitrary throw to a non-retryable compaction failure", async () => {
    const provider = new CompleteScriptedProvider([new Error("socket exploded")]);
    await expect(
      summarizePrefix({ provider, model: "m", prompt: "p", prefix }),
    ).rejects.toMatchObject({
      compactionError: { code: "compaction_failed", retryable: false },
    });
  });
});
