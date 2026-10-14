/**
 * `src/tui/view-model` — the PURE half of the TUI (roadmap WS1, ADR-0005).
 *
 * Everything here is a plain function over plain data: `SessionEvent`s in,
 * render-ready `SessionState` out. No react, no ink, no fs, no process — the
 * Ink components (`App.ts`, `components.ts`) subscribe to an event feed and
 * render this state; `ink-testing-library` tests and plain unit tests drive
 * the same reducer without a TTY.
 *
 * Event sources all normalize into `SessionEvent` (see `events.ts`):
 * - live runs: `EngineEvent`s + permission records from `runTask` callbacks;
 * - replay: `ThreadEvent`s read back from the thread store.
 *
 * Rendering notes carried by the state:
 * - live assistant text streams via `streaming` and is flushed into an entry
 *   by the next boundary event (tool call / stop), mirroring how
 *   `app/stream-json` batches text — one visual block per streamed message;
 * - tool calls are one-line entries (name + input summary) with a status;
 *   expansion (input JSON + result summary) is view state, not session state;
 * - permission DENIALS are first-class entries (prominent); allows are not
 *   rendered at all (noise). P3 permission dialogs will hook the same
 *   permission events before they reach this reducer.
 */

import type { ToolInput, UsageRecord } from "../contracts";

// ---------------------------------------------------------------------------
// Events (the normalized input union)
// ---------------------------------------------------------------------------

/** One normalized session event; produced by the mappers in `events.ts`. */
export type SessionEvent =
  | {
      readonly type: "session_init";
      readonly threadId: string;
      readonly model: string;
      /** Workspace root; empty string when unknown (replay) — rendered as "—". */
      readonly workspaceRoot: string;
    }
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "assistant_text_delta"; readonly text: string }
  | { readonly type: "assistant_text_complete"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly toolUseId: string;
      readonly name: string;
      readonly input: ToolInput;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly summary: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "permission_denied";
      readonly tool: string;
      /** The rule engine's action that denied it: "reject" | "ask" | "delegate". */
      readonly decision: string;
      readonly reason: string;
      readonly message?: string;
    }
  | { readonly type: "usage"; readonly usage: UsageRecord }
  | {
      /** ADR-0008: the conversation prefix was replaced by a summary. */
      readonly type: "compacted";
      readonly trigger: "threshold" | "manual";
      readonly summarizedTurns: number;
      readonly keptTurns: number;
      /** The summarization call's own usage (live engine events only). */
      readonly usage?: UsageRecord;
    }
  | { readonly type: "engine_stopped"; readonly reason: string; readonly message?: string }
  | { readonly type: "run_started"; readonly task: string }
  | {
      readonly type: "run_finished";
      readonly exitCode: 0 | 1 | 2 | 3;
      readonly stopReason: string;
      readonly numTurns: number;
      readonly durationMs: number;
    }
  | { readonly type: "run_error"; readonly message: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Header facts (thread / model / workspace), from init or thread metadata. */
export interface SessionHeader {
  readonly threadId: string;
  readonly model: string;
  readonly workspaceRoot: string;
}

/** Cumulative token totals for the footer. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rounds: number;
}

/** The result-event footer: one per completed run (live or follow-up). */
export interface RunFooter {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stopReason: string;
  readonly numTurns: number;
  readonly durationMs: number;
}

/** Lifecycle of a tool entry. */
export type ToolEntryStatus = "running" | "ok" | "error";

/** One renderable transcript row. */
export type SessionEntry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolUseId: string;
      readonly name: string;
      /** One-line input summary (see {@link summarizeToolInput}). */
      readonly inputSummary: string;
      /** Full input JSON for the expanded view (see {@link formatInputJson}). */
      readonly inputJson: string;
      readonly status: ToolEntryStatus;
      readonly resultSummary?: string;
    }
  | {
      readonly kind: "permission";
      readonly tool: string;
      readonly decision: string;
      readonly reason: string;
      readonly message?: string;
    }
  /** Dim informational row (e.g. "history compacted", ADR-0008). */
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/** The whole session view-model the Ink layer renders. */
export interface SessionState {
  readonly header: SessionHeader | null;
  readonly entries: readonly SessionEntry[];
  /** In-flight streamed assistant text (live only; empty at rest). */
  readonly streaming: string;
  readonly running: boolean;
  readonly totals: UsageTotals | null;
  /** Last engine stop reason ("end_turn", "provider_error", guards…). */
  readonly stopReason: string | null;
  readonly footer: RunFooter | null;
}

export const initialSessionState: SessionState = {
  header: null,
  entries: [],
  streaming: "",
  running: false,
  totals: null,
  stopReason: null,
  footer: null,
};

/** Fold one event into the state (pure; returns the same ref when unchanged). */
export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "session_init":
      return {
        ...state,
        header: {
          threadId: event.threadId,
          model: event.model,
          workspaceRoot: event.workspaceRoot,
        },
      };
    case "user_message":
      return withEntry(flushStreaming(state), { kind: "user", text: event.text });
    case "assistant_text_delta":
      return event.text.length === 0
        ? state
        : { ...state, streaming: state.streaming + event.text };
    case "assistant_text_complete":
      return event.text.length === 0
        ? state
        : withEntry(flushStreaming(state), { kind: "assistant", text: event.text });
    case "tool_call":
      return withEntry(flushStreaming(state), {
        kind: "tool",
        toolUseId: event.toolUseId,
        name: event.name,
        inputSummary: summarizeToolInput(event.name, event.input),
        inputJson: formatInputJson(event.input),
        status: "running",
      });
    case "tool_result":
      return attachToolResult(state, event);
    case "permission_denied":
      return withEntry(flushStreaming(state), {
        kind: "permission",
        tool: event.tool,
        decision: event.decision,
        reason: event.reason,
        ...(event.message !== undefined ? { message: event.message } : {}),
      });
    case "usage":
      return {
        ...state,
        totals: {
          inputTokens: (state.totals?.inputTokens ?? 0) + event.usage.inputTokens,
          outputTokens: (state.totals?.outputTokens ?? 0) + event.usage.outputTokens,
          rounds: (state.totals?.rounds ?? 0) + 1,
        },
      };
    case "compacted":
      return {
        ...withEntry(flushStreaming(state), {
          kind: "notice",
          text: `history compacted (${event.trigger}): ${event.summarizedTurns} turn${event.summarizedTurns === 1 ? "" : "s"} summarized, ${event.keptTurns} kept`,
        }),
        ...(event.usage !== undefined
          ? {
              totals: {
                inputTokens: (state.totals?.inputTokens ?? 0) + event.usage.inputTokens,
                outputTokens: (state.totals?.outputTokens ?? 0) + event.usage.outputTokens,
                rounds: (state.totals?.rounds ?? 0) + 1,
              },
            }
          : {}),
      };
    case "engine_stopped":
      return event.reason === "provider_error"
        ? withEntry(flushStreaming({ ...state, stopReason: event.reason }), {
            kind: "error",
            text: `provider error${event.message !== undefined ? `: ${event.message}` : ""}`,
          })
        : { ...state, stopReason: event.reason };
    case "run_started":
      // The seed user message of a live run is not an EngineEvent — the run
      // lifecycle events carry it (follow-up turns reuse the same path).
      return {
        ...withEntry(flushStreaming(state), { kind: "user", text: event.task }),
        running: true,
      };
    case "run_finished":
      return {
        ...flushStreaming(state),
        running: false,
        stopReason: event.stopReason,
        footer: {
          exitCode: event.exitCode,
          stopReason: event.stopReason,
          numTurns: event.numTurns,
          durationMs: event.durationMs,
        },
      };
    case "run_error":
      return withEntry(flushStreaming(state), { kind: "error", text: event.message });
  }
}

/** Append an entry (helper; keeps reducers one-liners). */
function withEntry(state: SessionState, entry: SessionEntry): SessionState {
  return { ...state, entries: [...state.entries, entry] };
}

/**
 * Move buffered streaming text into a completed assistant entry. Mirrors the
 * stream-JSON emitter: text batches until the next boundary event.
 */
function flushStreaming(state: SessionState): SessionState {
  if (state.streaming.length === 0) {
    return state;
  }
  return {
    ...state,
    entries: [...state.entries, { kind: "assistant", text: state.streaming }],
    streaming: "",
  };
}

/**
 * Attach a tool result to its (last, still-open) call entry. Results whose
 * call was never seen are ignored: log order guarantees tool_use precedes
 * tool_result both live (engine events) and in replay (thread events), so a
 * miss means a malformed stream, not a rendering concern.
 */
function attachToolResult(
  state: SessionState,
  event: Extract<SessionEvent, { type: "tool_result" }>,
): SessionState {
  let updated = false;
  const entries = state.entries.map((entry) => {
    if (
      !updated &&
      entry.kind === "tool" &&
      entry.toolUseId === event.toolUseId &&
      entry.status === "running"
    ) {
      updated = true;
      return {
        ...entry,
        status: (event.isError ? "error" : "ok") as ToolEntryStatus,
        resultSummary: event.summary,
      };
    }
    return entry;
  });
  return updated ? { ...state, entries } : state;
}

// ---------------------------------------------------------------------------
// Tool input summaries (pure formatting)
// ---------------------------------------------------------------------------

/** Input field shown first per builtin tool (fallback: compact JSON). */
const TOOL_INPUT_KEYS: Readonly<Record<string, string>> = {
  bash: "command",
  read_file: "path",
  edit_file: "path",
  glob: "pattern",
  grep: "pattern",
};

/** Collapse whitespace and clip to one line of `max` characters. */
export function singleLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** One-line input summary for a collapsed tool row. */
export function summarizeToolInput(name: string, input: ToolInput): string {
  const key = TOOL_INPUT_KEYS[name];
  const value = key === undefined ? undefined : input[key];
  const raw = typeof value === "string" && value.length > 0 ? value : JSON.stringify(input);
  return singleLine(raw, 80);
}

/** Full input JSON for the expanded tool row (clipped at a generous cap). */
export function formatInputJson(input: ToolInput): string {
  return singleLine(JSON.stringify(input), 500);
}

// ---------------------------------------------------------------------------
// View state: cursor / scrollback / expansion (pure)
// ---------------------------------------------------------------------------

/** Scrollback + cursor + expansion state (component-local, not session state). */
export interface ViewState {
  /**
   * Cursor anchor, an index into entries. While `stick` is true the cursor
   * follows the newest entry and this value is ignored.
   */
  readonly cursor: number;
  /** First visible entry (kept stable while the cursor moves inside it). */
  readonly windowStart: number;
  /** Follow-the-tail: newest entries stay visible as they arrive. */
  readonly stick: boolean;
  /** toolUseIds whose rows are expanded. */
  readonly expanded: readonly string[];
}

export const initialViewState: ViewState = { cursor: 0, windowStart: 0, stick: true, expanded: [] };

export type ViewAction =
  | { readonly type: "cursor-down" }
  | { readonly type: "cursor-up" }
  | { readonly type: "page-down" }
  | { readonly type: "page-up" }
  | { readonly type: "top" }
  | { readonly type: "bottom" }
  | { readonly type: "toggle-expand"; readonly toolUseId: string };

/** The visible slice plus the effective cursor index. */
export interface VisibleWindow {
  readonly start: number;
  /** Exclusive end (slice bound). */
  readonly end: number;
  /** Effective cursor (follows the tail while stuck). */
  readonly cursor: number;
}

/**
 * Compute the visible window: while stuck, the newest `rows` entries; once
 * unstuck, a stable window that always keeps the effective cursor visible.
 * Pure — the component calls it every render, so growth-while-stuck and
 * clamping against shrinking histories fall out for free.
 */
export function visibleWindow(view: ViewState, entryCount: number, rows: number): VisibleWindow {
  const count = Math.max(entryCount, 0);
  const height = Math.max(rows, 1);
  const cursor = view.stick
    ? Math.max(count - 1, 0)
    : Math.min(view.cursor, Math.max(count - 1, 0));
  let start: number;
  if (view.stick) {
    start = Math.max(0, count - height);
  } else {
    start = Math.min(view.windowStart, Math.max(0, count - height));
    if (cursor < start) {
      start = cursor;
    }
    if (cursor > start + height - 1) {
      start = Math.max(0, cursor - height + 1);
    }
  }
  return { start, end: Math.min(count, start + height), cursor };
}

/** Effective cursor against a live entry count (exported for key handling). */
export function effectiveCursor(view: ViewState, entryCount: number): number {
  return visibleWindow(view, entryCount, 1).cursor;
}

/** Pure view-state transition; `entryCount`/`rows` clamp and page. */
export function viewReducer(
  state: ViewState,
  action: ViewAction,
  entryCount: number,
  rows: number,
): ViewState {
  const count = Math.max(entryCount, 0);
  const height = Math.max(rows, 1);
  const eff = effectiveCursor(state, count);
  switch (action.type) {
    case "cursor-down": {
      // Moving ONTO the newest entry re-sticks to the tail (chat behavior:
      // you only leave the tail scrolling up, and return by reaching it).
      const next = eff + 1;
      if (state.stick || next >= count - 1) {
        return state.stick ? state : { ...state, stick: true };
      }
      return { ...state, cursor: next, stick: false };
    }
    case "cursor-up":
      if (eff <= 0) {
        return state;
      }
      return { ...state, cursor: eff - 1, stick: false };
    case "page-down": {
      const target = Math.min(eff + height, Math.max(count - 1, 0));
      return target >= count - 1
        ? { ...state, stick: true }
        : { ...state, cursor: target, stick: false };
    }
    case "page-up": {
      const target = Math.max(eff - height, 0);
      return { ...state, cursor: target, stick: false };
    }
    case "top":
      return count === 0 ? state : { ...state, cursor: 0, stick: false };
    case "bottom":
      return state.stick ? state : { ...state, stick: true };
    case "toggle-expand": {
      const expanded = state.expanded.includes(action.toolUseId)
        ? state.expanded.filter((id) => id !== action.toolUseId)
        : [...state.expanded, action.toolUseId];
      return { ...state, expanded };
    }
  }
}

// ---------------------------------------------------------------------------
// Key maps (pure; the Ink layer supplies its key object, structurally)
// ---------------------------------------------------------------------------

/**
 * The subset of ink's `Key` the maps below read. Declared locally (not
 * imported from ink) so this module stays dependency-free and the key maps
 * unit-test without a renderer.
 */
export interface TuiKey {
  readonly up?: boolean;
  readonly down?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly tab?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

/** What a transcript-mode keypress means (resolved against the view state). */
export type TranscriptAction =
  | { readonly type: "view"; readonly view: ViewAction }
  /** Toggle expansion of the entry under the effective cursor. */
  | { readonly type: "toggle-expand" }
  | { readonly type: "focus-prompt" }
  | { readonly type: "quit" };

/**
 * Transcript-mode keys: j/k move, pgup/pgdn (or u/d) page, g/G top/bottom,
 * return expands the cursor row, i focuses the prompt, q or ctrl+c quits
 * (prompt-mode ctrl+c interrupts first — see `promptKeyToResult`).
 */
export function transcriptKeyToAction(input: string, key: TuiKey): TranscriptAction | null {
  if (key.ctrl && input === "c") {
    return { type: "quit" };
  }
  if (key.up || input === "k") {
    return { type: "view", view: { type: "cursor-up" } };
  }
  if (key.down || input === "j") {
    return { type: "view", view: { type: "cursor-down" } };
  }
  if (key.pageUp || input === "u") {
    return { type: "view", view: { type: "page-up" } };
  }
  if (key.pageDown || input === "d") {
    return { type: "view", view: { type: "page-down" } };
  }
  if (input === "g") {
    return { type: "view", view: { type: "top" } };
  }
  if (input === "G") {
    return { type: "view", view: { type: "bottom" } };
  }
  if (key.return) {
    return { type: "toggle-expand" };
  }
  if (input === "i") {
    return { type: "focus-prompt" };
  }
  if (input === "q") {
    return { type: "quit" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Footer formatting (pure)
// ---------------------------------------------------------------------------

/** 1234 → "1.2k"-style compact token counts. */
export function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(n);
}

/** Footer usage label, e.g. "in 1.2k · out 340 · 3 turns". */
export function formatUsage(totals: UsageTotals | null): string {
  if (totals === null) {
    return "no usage recorded";
  }
  return `in ${formatTokens(totals.inputTokens)} · out ${formatTokens(totals.outputTokens)} · ${totals.rounds} turn${totals.rounds === 1 ? "" : "s"}`;
}

/** Duration label: sub-second in ms, else seconds with one decimal. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
