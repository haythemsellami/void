/**
 * Prompt state-machine tests (P2): typing, backspace, the blank-submit guard,
 * the ctrl+c interrupt contract, and unfocus keys — all without a renderer.
 */
import { describe, expect, it } from "vitest";
import {
  initialPromptState,
  type PromptAction,
  type PromptState,
  promptKeyToResult,
  promptReducer,
  promptSubmitValue,
} from "./prompt";

/** Apply a list of prompt actions. */
function edit(...actions: readonly PromptAction[]): PromptState {
  return actions.reduce(promptReducer, initialPromptState);
}

describe("promptReducer", () => {
  it("appends characters and handles paste-sized input", () => {
    expect(edit({ type: "char", ch: "h" }, { type: "char", ch: "i" }).text).toBe("hi");
    expect(edit({ type: "char", ch: "hello world" }).text).toBe("hello world");
    expect(edit({ type: "char", ch: "" })).toEqual(initialPromptState);
  });

  it("backspace removes the last character and is a no-op when empty", () => {
    const typed = edit({ type: "char", ch: "abc" });
    expect(promptReducer(typed, { type: "backspace" }).text).toBe("ab");
    expect(promptReducer(initialPromptState, { type: "backspace" })).toEqual(initialPromptState);
  });

  it("clear sets the one-shot interrupted hint and typing clears it", () => {
    const cleared = promptReducer(edit({ type: "char", ch: "x" }), { type: "clear" });
    expect(cleared).toEqual({ text: "", interrupted: true });
    expect(promptReducer(cleared, { type: "char", ch: "y" }).interrupted).toBe(false);
    // clearing an already-empty prompt is a no-op (no spurious hint)
    expect(promptReducer(initialPromptState, { type: "clear" })).toEqual(initialPromptState);
  });
});

describe("promptSubmitValue", () => {
  it("returns the trimmed text, or null for blank lines", () => {
    expect(promptSubmitValue({ text: "  fix the bug ", interrupted: false })).toBe("fix the bug");
    expect(promptSubmitValue({ text: "   ", interrupted: false })).toBeNull();
    expect(promptSubmitValue(initialPromptState)).toBeNull();
  });
});

describe("promptKeyToResult", () => {
  it("routes edit keys, submit, interrupt, and unfocus", () => {
    expect(promptKeyToResult("a", {})).toEqual({
      type: "action",
      action: { type: "char", ch: "a" },
    });
    expect(promptKeyToResult("", { backspace: true })).toEqual({
      type: "action",
      action: { type: "backspace" },
    });
    expect(promptKeyToResult("", { delete: true })).toEqual({
      type: "action",
      action: { type: "backspace" },
    });
    expect(promptKeyToResult("", { return: true })).toEqual({ type: "submit" });
    expect(promptKeyToResult("c", { ctrl: true })).toEqual({ type: "interrupt" });
    expect(promptKeyToResult("", { escape: true })).toEqual({ type: "unfocus" });
    expect(promptKeyToResult("", { tab: true })).toEqual({ type: "unfocus" });
  });

  it("swallows navigation and modifier combinations", () => {
    expect(promptKeyToResult("", { up: true })).toEqual({ type: "none" });
    expect(promptKeyToResult("", { pageUp: true })).toEqual({ type: "none" });
    expect(promptKeyToResult("a", { ctrl: true })).toEqual({ type: "none" });
    expect(promptKeyToResult("a", { meta: true })).toEqual({ type: "none" });
    expect(promptKeyToResult("", {})).toEqual({ type: "none" });
  });
});
