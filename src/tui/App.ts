/**
 * `src/tui/App` — the interactive session root (roadmap WS1 P1-P2).
 *
 * Owns the wiring, no formatting: it folds feed events through the pure
 * `sessionReducer`, keeps cursor/scroll/expansion in `viewReducer`, routes
 * keypresses through the pure key maps (`transcriptKeyToAction`,
 * `promptKeyToResult`), and renders the dumb components. Everything
 * interesting is a pure function — this file is the only stateful citizen
 * and stays small enough to cover with `ink-testing-library` render tests.
 *
 * P2 semantics: submissions (prompt enter) start a follow-up `runTask` turn
 * on the same thread via the `onSubmit` prop and render the new round live.
 * P3 (permission dialogs, steering) will hook in here: dialogs intercept the
 * permission records at the feed boundary; mid-run queued input (steering)
 * needs an engine queued-input extension and is deliberately NOT built.
 */

import { Box, type Key, useInput } from "ink";
import { createElement, type ReactElement, useEffect, useReducer, useState } from "react";
import { FooterLine, HeaderLine, HintsLine, PromptLine, Transcript } from "./components";
import type { EventQueue } from "./events";
import {
  initialPromptState,
  type PromptKeyResult,
  type PromptState,
  promptKeyToResult,
  promptReducer,
  promptSubmitValue,
} from "./prompt";
import {
  effectiveCursor,
  initialSessionState,
  initialViewState,
  sessionReducer,
  type TranscriptAction,
  type TuiKey,
  transcriptKeyToAction,
  type ViewState,
  viewReducer,
  visibleWindow,
} from "./view-model";

/** Transcript window height (rows); P4 wires real terminal geometry. */
export const DEFAULT_VIEWPORT_ROWS = 20;

export interface AppProps {
  /** The session feed (subscribe-only here; the entry pushes). */
  readonly feed: EventQueue;
  /** Submit a follow-up turn on the session thread (P2). */
  readonly onSubmit: (text: string) => void;
  /** Leave the TUI; receives the last run's exit code (0 when none ran). */
  readonly onQuit: (exitCode: number) => void;
  readonly viewportRows?: number;
  readonly version?: string;
}

/** Map ink's Key onto the dependency-free {@link TuiKey} subset. */
function toTuiKey(key: Key): TuiKey {
  return {
    up: key.upArrow,
    down: key.downArrow,
    pageUp: key.pageUp,
    pageDown: key.pageDown,
    return: key.return,
    escape: key.escape,
    backspace: key.backspace,
    delete: key.delete,
    tab: key.tab,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
  };
}

export function App(props: AppProps): ReactElement {
  const rows = props.viewportRows ?? DEFAULT_VIEWPORT_ROWS;
  const [session, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [view, setView] = useState<ViewState>(initialViewState);
  const [mode, setMode] = useState<"transcript" | "prompt">("transcript");
  const [prompt, setPrompt] = useState<PromptState>(initialPromptState);

  // Feed → reducer. The queue replays its backlog to this subscriber, so
  // events pushed before mount (replayed history) arrive in order.
  useEffect(() => props.feed.subscribe(dispatch), [props.feed]);

  const win = visibleWindow(view, session.entries.length, rows);
  const expandedSet = view.expanded;

  const applyView = (action: Parameters<typeof viewReducer>[1]): void => {
    setView((previous) => viewReducer(previous, action, session.entries.length, rows));
  };

  const handleTranscriptAction = (action: TranscriptAction): void => {
    switch (action.type) {
      case "view":
        applyView(action.view);
        return;
      case "toggle-expand": {
        const entry = session.entries[effectiveCursor(view, session.entries.length)];
        if (entry !== undefined && entry.kind === "tool") {
          applyView({ type: "toggle-expand", toolUseId: entry.toolUseId });
        }
        return;
      }
      case "focus-prompt":
        if (!session.running) {
          setPrompt({ ...prompt, interrupted: false });
          setMode("prompt");
        }
        return;
      case "quit":
        props.onQuit(session.footer?.exitCode ?? 0);
        return;
    }
  };

  const handlePromptKey = (result: PromptKeyResult): void => {
    switch (result.type) {
      case "none":
        return;
      case "action":
        setPrompt((previous) => promptReducer(previous, result.action));
        return;
      case "submit": {
        const value = promptSubmitValue(prompt);
        if (value !== null && !session.running) {
          props.onSubmit(value);
          setPrompt(initialPromptState);
        }
        return;
      }
      case "interrupt":
        // ctrl+c with a focused prompt: clear it and drop back to transcript
        // (a second ctrl+c there quits). An already-empty prompt just unfocuses.
        setPrompt((previous) =>
          previous.text.length > 0 ? promptReducer(previous, { type: "clear" }) : previous,
        );
        setMode("transcript");
        return;
      case "unfocus":
        setMode("transcript");
        return;
    }
  };

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(HeaderLine, { header: session.header, version: props.version ?? "" }),
    createElement(InputController, {
      mode,
      onTranscriptAction: handleTranscriptAction,
      onPromptKey: handlePromptKey,
    }),
    createElement(Transcript, {
      entries: session.entries,
      window: win,
      expanded: expandedSet,
      streaming: session.streaming,
    }),
    createElement(FooterLine, { state: session }),
    createElement(HintsLine, {
      mode,
      running: session.running,
      interrupted: prompt.interrupted,
    }),
    !session.running && mode === "prompt"
      ? createElement(PromptLine, { state: prompt, focused: true })
      : null,
  );
}

interface InputControllerProps {
  readonly mode: "transcript" | "prompt";
  readonly onTranscriptAction: (action: TranscriptAction) => void;
  readonly onPromptKey: (result: PromptKeyResult) => void;
}

/**
 * Keypress router. Isolated so the `useInput` hook lives in a component
 * rendered exactly once (never conditionally), with routing by `mode`.
 */
function InputController({ mode, onTranscriptAction, onPromptKey }: InputControllerProps): null {
  useInput((input, key) => {
    const tuiKey = toTuiKey(key);
    if (mode === "prompt") {
      onPromptKey(promptKeyToResult(input, tuiKey));
      return;
    }
    const action = transcriptKeyToAction(input, tuiKey);
    if (action !== null) {
      onTranscriptAction(action);
    }
  });
  return null;
}
