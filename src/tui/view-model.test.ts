/**
 * View-model tests: the pure session reducer, scrollback window, key maps,
 * and formatting helpers — the whole TUI minus Ink (no renderer needed).
 */
import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionState } from "./view-model";
import {
  effectiveCursor,
  formatDuration,
  formatTokens,
  formatUsage,
  initialSessionState,
  initialViewState,
  sessionReducer,
  singleLine,
  summarizeToolInput,
  transcriptKeyToAction,
  viewReducer,
  visibleWindow,
} from "./view-model";

/** Fold events through the reducer left-to-right. */
function reduce(...events: readonly SessionEvent[]): SessionState {
  return events.reduce(sessionReducer, initialSessionState);
}

describe("sessionReducer", () => {
  it("replays a stored conversation into ordered user/assistant/tool entries", () => {
    const state = reduce(
      { type: "session_init", threadId: "thr_1", model: "anthropic/x", workspaceRoot: "" },
      { type: "user_message", text: "list the files" },
      { type: "assistant_text_complete", text: "I'll look." },
      { type: "tool_call", toolUseId: "t1", name: "bash", input: { command: "ls -la" } },
      { type: "tool_result", toolUseId: "t1", summary: "12 files", isError: false },
      { type: "assistant_text_complete", text: "There are 12 files." },
    );
    expect(state.header).toEqual({ threadId: "thr_1", model: "anthropic/x", workspaceRoot: "" });
    expect(state.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const tool = state.entries[2];
    expect(tool?.kind === "tool" && tool.inputSummary).toBe("ls -la");
    expect(tool?.kind === "tool" && tool.status).toBe("ok");
    expect(tool?.kind === "tool" && tool.resultSummary).toBe("12 files");
  });

  it("batches live text deltas into one assistant entry flushed by the next boundary", () => {
    const state = reduce(
      { type: "assistant_text_delta", text: "Hello" },
      { type: "assistant_text_delta", text: " world" },
    );
    expect(state.entries).toEqual([]);
    expect(state.streaming).toBe("Hello world");

    const flushed = sessionReducer(state, {
      type: "tool_call",
      toolUseId: "t1",
      name: "read_file",
      input: { path: "/tmp/x" },
    });
    expect(flushed.streaming).toBe("");
    expect(flushed.entries[0]).toEqual({ kind: "assistant", text: "Hello world" });
    expect(flushed.entries[1]?.kind).toBe("tool");
  });

  it("marks a failed tool result as an error entry with its summary", () => {
    const state = reduce(
      { type: "tool_call", toolUseId: "t9", name: "bash", input: { command: "boom" } },
      { type: "tool_result", toolUseId: "t9", summary: "exit 1", isError: true },
    );
    const tool = state.entries[0];
    expect(tool?.kind === "tool" && tool.status).toBe("error");
    expect(tool?.kind === "tool" && tool.resultSummary).toBe("exit 1");
  });

  it("ignores tool results whose call was never seen", () => {
    const state = reduce({ type: "tool_result", toolUseId: "ghost", summary: "x", isError: false });
    expect(state.entries).toEqual([]);
  });

  it("run_started appends the user row and flags running; run_finished closes it with a footer", () => {
    const running = reduce({ type: "run_started", task: "do it" });
    expect(running.running).toBe(true);
    expect(running.entries).toEqual([{ kind: "user", text: "do it" }]);

    const done = sessionReducer(running, {
      type: "run_finished",
      exitCode: 0,
      stopReason: "end_turn",
      numTurns: 2,
      durationMs: 1500,
    });
    expect(done.running).toBe(false);
    expect(done.stopReason).toBe("end_turn");
    expect(done.footer).toEqual({
      exitCode: 0,
      stopReason: "end_turn",
      numTurns: 2,
      durationMs: 1500,
    });
  });

  it("accumulates usage across rounds", () => {
    const state = reduce(
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } },
    );
    expect(state.totals).toEqual({ inputTokens: 17, outputTokens: 8, rounds: 2 });
  });

  it("renders compaction as a dim notice and books the summarization usage (ADR-0008)", () => {
    const live = reduce({
      type: "compacted",
      trigger: "threshold",
      summarizedTurns: 4,
      keptTurns: 2,
      usage: { inputTokens: 30, outputTokens: 10 },
    });
    expect(live.entries).toEqual([
      { kind: "notice", text: "history compacted (threshold): 4 turns summarized, 2 kept" },
    ]);
    expect(live.totals).toEqual({ inputTokens: 30, outputTokens: 10, rounds: 1 });

    // replay variant: no usage rides the thread-log compaction event
    const replayed = reduce({
      type: "compacted",
      trigger: "manual",
      summarizedTurns: 1,
      keptTurns: 0,
    });
    expect(replayed.entries).toEqual([
      { kind: "notice", text: "history compacted (manual): 1 turn summarized, 0 kept" },
    ]);
    expect(replayed.totals).toBeNull();
  });

  it("records permission denials as prominent entries with remediation", () => {
    const state = reduce({
      type: "permission_denied",
      tool: "bash",
      decision: "ask",
      reason: "bash requires approval",
      message: "adjust the rules",
    });
    expect(state.entries).toEqual([
      {
        kind: "permission",
        tool: "bash",
        decision: "ask",
        reason: "bash requires approval",
        message: "adjust the rules",
      },
    ]);
  });

  it("engine_stopped sets the stop reason and surfaces provider errors as rows", () => {
    const guard = reduce({ type: "engine_stopped", reason: "max_tool_rounds" });
    expect(guard.stopReason).toBe("max_tool_rounds");
    expect(guard.entries).toEqual([]);

    const provider = reduce({
      type: "engine_stopped",
      reason: "provider_error",
      message: "connection reset",
    });
    expect(provider.stopReason).toBe("provider_error");
    expect(provider.entries).toEqual([{ kind: "error", text: "provider error: connection reset" }]);
  });
});

describe("summarizeToolInput", () => {
  it("picks the meaningful field per builtin tool", () => {
    expect(summarizeToolInput("bash", { command: "rg -n foo src/" })).toBe("rg -n foo src/");
    expect(summarizeToolInput("read_file", { path: "/a/b/c.txt" })).toBe("/a/b/c.txt");
    expect(summarizeToolInput("grep", { pattern: "TODO", path: "." })).toBe("TODO");
  });

  it("falls back to compact JSON for unknown tools and collapses + clips long input", () => {
    expect(summarizeToolInput("web_fetch", { url: "https://x.dev" })).toBe(
      '{"url":"https://x.dev"}',
    );
    const long = "x".repeat(120);
    expect(summarizeToolInput("bash", { command: long })).toBe(`${"x".repeat(79)}…`);
    expect(summarizeToolInput("bash", { command: "a\n  b\tc" })).toBe("a b c");
  });

  it("singleLine clips and trims without the ellipsis under the cap", () => {
    expect(singleLine("  hi  ", 10)).toBe("hi");
    expect(singleLine("abcdef", 4)).toBe("abc…");
  });
});

describe("visibleWindow + viewReducer (scrollback)", () => {
  it("sticks to the bottom while entries grow", () => {
    const view = initialViewState;
    const first = visibleWindow(view, 5, 3);
    expect(first).toEqual({ start: 2, end: 5, cursor: 4 });
    const grown = visibleWindow(view, 9, 3);
    expect(grown).toEqual({ start: 6, end: 9, cursor: 8 });
  });

  it("cursor-up unsticks; moving back onto the newest entry re-sticks", () => {
    let view = viewReducer(initialViewState, { type: "cursor-up" }, 10, 3);
    expect(view.stick).toBe(false);
    expect(effectiveCursor(view, 10)).toBe(8);

    view = viewReducer(view, { type: "cursor-down" }, 10, 3);
    expect(view.stick).toBe(true);
  });

  it("page-up moves a page and keeps the cursor visible; clamped at the top", () => {
    let view = viewReducer(initialViewState, { type: "page-up" }, 10, 3);
    expect(effectiveCursor(view, 10)).toBe(6);
    const window = visibleWindow(view, 10, 3);
    expect(window.cursor).toBeGreaterThanOrEqual(window.start);
    expect(window.cursor).toBeLessThan(window.end);

    view = viewReducer(view, { type: "page-up" }, 10, 3);
    view = viewReducer(view, { type: "page-up" }, 10, 3);
    expect(effectiveCursor(view, 10)).toBe(0);
    const clamped = viewReducer(view, { type: "cursor-up" }, 10, 3);
    expect(clamped).toBe(view);
  });

  it("page-down onto the last entry re-sticks to the tail", () => {
    let view = viewReducer(initialViewState, { type: "page-up" }, 10, 3);
    view = viewReducer(view, { type: "page-down" }, 10, 3);
    expect(view.stick).toBe(true);
  });

  it("g/top and G/bottom jump to the history ends", () => {
    const top = viewReducer(initialViewState, { type: "top" }, 10, 3);
    expect(effectiveCursor(top, 10)).toBe(0);
    expect(top.stick).toBe(false);
    const bottom = viewReducer(top, { type: "bottom" }, 10, 3);
    expect(bottom.stick).toBe(true);
  });

  it("toggle-expand flips tool ids and is idempotent per id", () => {
    let view = viewReducer(initialViewState, { type: "toggle-expand", toolUseId: "a" }, 0, 3);
    expect(view.expanded).toEqual(["a"]);
    view = viewReducer(view, { type: "toggle-expand", toolUseId: "b" }, 0, 3);
    expect(view.expanded).toEqual(["a", "b"]);
    view = viewReducer(view, { type: "toggle-expand", toolUseId: "a" }, 0, 3);
    expect(view.expanded).toEqual(["b"]);
  });
});

describe("transcriptKeyToAction", () => {
  it("maps vi keys, page keys, and terminal keys to actions", () => {
    expect(transcriptKeyToAction("j", {})).toEqual({ type: "view", view: { type: "cursor-down" } });
    expect(transcriptKeyToAction("k", {})).toEqual({ type: "view", view: { type: "cursor-up" } });
    expect(transcriptKeyToAction("u", {})).toEqual({ type: "view", view: { type: "page-up" } });
    expect(transcriptKeyToAction("", { pageUp: true })).toEqual({
      type: "view",
      view: { type: "page-up" },
    });
    expect(transcriptKeyToAction("", { pageDown: true })).toEqual({
      type: "view",
      view: { type: "page-down" },
    });
    expect(transcriptKeyToAction("", { up: true })).toEqual({
      type: "view",
      view: { type: "cursor-up" },
    });
    expect(transcriptKeyToAction("g", {})).toEqual({ type: "view", view: { type: "top" } });
    expect(transcriptKeyToAction("G", {})).toEqual({ type: "view", view: { type: "bottom" } });
    expect(transcriptKeyToAction("", { return: true })).toEqual({ type: "toggle-expand" });
    expect(transcriptKeyToAction("i", {})).toEqual({ type: "focus-prompt" });
    expect(transcriptKeyToAction("q", {})).toEqual({ type: "quit" });
    expect(transcriptKeyToAction("c", { ctrl: true })).toEqual({ type: "quit" });
    expect(transcriptKeyToAction("x", {})).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("compacts token counts and formats usage + durations", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatUsage(null)).toBe("no usage recorded");
    expect(formatUsage({ inputTokens: 1200, outputTokens: 40, rounds: 1 })).toBe(
      "in 1.2k · out 40 · 1 turn",
    );
    expect(formatUsage({ inputTokens: 1200, outputTokens: 40, rounds: 3 })).toBe(
      "in 1.2k · out 40 · 3 turns",
    );
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1500)).toBe("1.5s");
  });
});
