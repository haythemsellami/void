/**
 * `src/tui/prompt` — the prompt input line as a pure state machine (P2).
 *
 * Key handling is split from rendering exactly like the transcript maps in
 * `view-model.ts`: `promptKeyToResult` turns an ink keypress into an intent,
 * `promptReducer` edits the text, `promptSubmitValue` guards the submit
 * (enter on empty/blank is a no-op). The component applies the intents; the
 * tests drive the functions without a renderer.
 *
 * ctrl+c contract (mission P2): while the prompt is focused and holds text,
 * the FIRST ctrl+c interrupts the prompt (clears it, unfocuses); with the
 * prompt empty or unfocused, ctrl+c quits. P3 steering (queueing input
 * mid-run) needs an engine queued-input extension and is NOT wired here —
 * submissions only start when the previous run has finished.
 */

import type { TuiKey } from "./view-model";

/** Prompt-line state. */
export interface PromptState {
  readonly text: string;
  /** True after a ctrl+c interrupt; the UI shows a one-shot hint. */
  readonly interrupted: boolean;
}

export const initialPromptState: PromptState = { text: "", interrupted: false };

export type PromptAction =
  | { readonly type: "char"; readonly ch: string }
  | { readonly type: "backspace" }
  | { readonly type: "clear" };

/** Edit the prompt line (pure). */
export function promptReducer(state: PromptState, action: PromptAction): PromptState {
  switch (action.type) {
    case "char":
      return action.ch.length === 0 ? state : { text: state.text + action.ch, interrupted: false };
    case "backspace":
      return state.text.length === 0
        ? state
        : { text: state.text.slice(0, -1), interrupted: false };
    case "clear":
      return state.text.length === 0 ? state : { text: "", interrupted: true };
  }
}

/** The value enter would submit, or null when the line is blank (no-op). */
export function promptSubmitValue(state: PromptState): string | null {
  const trimmed = state.text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** What a prompt-mode keypress means. */
export type PromptKeyResult =
  | { readonly type: "none" }
  | { readonly type: "action"; readonly action: PromptAction }
  | { readonly type: "submit" }
  /** ctrl+c with text: clear + unfocus (a second ctrl+c then quits). */
  | { readonly type: "interrupt" }
  /** escape/tab: back to transcript mode. */
  | { readonly type: "unfocus" };

/**
 * Prompt-mode keys: printable input appends (paste-sized strings too),
 * backspace/delete edit, enter submits, ctrl+c interrupts (or unfocuses an
 * empty prompt so the next ctrl+c quits), escape/tab unfocuses.
 */
export function promptKeyToResult(input: string, key: TuiKey): PromptKeyResult {
  if (key.ctrl && input === "c") {
    return { type: "interrupt" };
  }
  if (key.return) {
    return { type: "submit" };
  }
  if (key.backspace || key.delete) {
    return { type: "action", action: { type: "backspace" } };
  }
  if (key.escape || key.tab) {
    return { type: "unfocus" };
  }
  if (key.ctrl || key.meta || key.up || key.down || key.pageUp || key.pageDown) {
    return { type: "none" };
  }
  if (input.length > 0) {
    return { type: "action", action: { type: "char", ch: input } };
  }
  return { type: "none" };
}
