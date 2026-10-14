/**
 * `src/tui/events` — normalization + the session feed (roadmap WS1).
 *
 * Three producers feed one `SessionEvent` stream (consumed by the pure
 * reducer in `view-model.ts`):
 *
 * 1. live runs — `EngineEvent`s and permission records, the same callbacks
 *    `runTask` already exposes to the stream-JSON CLI (the TUI subscribes
 *    DIRECTLY, never by parsing stdout — ADR-0003: it is just another
 *    consumer of the same runner surface);
 * 2. replay — `ThreadEvent`s read back from the thread store
 *    (`tool_call` log events are derived data and skipped, like
 *    `replayFold`: their tool_use blocks already live in the
 *    assistant_message events);
 * 3. lifecycle — run_started/run_finished, synthesized by the TUI entry.
 *
 * `createEventQueue` is the tiniest possible glue: a synchronous
 * subscribe/push hub that REPLAYS its backlog to late subscribers, so the
 * entry can push replayed history before the Ink tree mounts without a
 * special "initial state" path.
 */

import type { PermissionGateRecord } from "../app/runner";
import type { ThreadEvent } from "../contracts";
import type { EngineEvent } from "../core/engine";
import { type SessionEvent, singleLine } from "./view-model";

// ---------------------------------------------------------------------------
// Live-run mapping
// ---------------------------------------------------------------------------

/** Map one `EngineEvent` (runTask `onEngineEvent`) to a SessionEvent. */
export function engineEventToSession(event: EngineEvent): SessionEvent {
  switch (event.type) {
    case "assistant_text_delta":
      return { type: "assistant_text_delta", text: event.text };
    case "tool_call_started":
      return {
        type: "tool_call",
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "tool_call_finished":
      return {
        type: "tool_result",
        toolUseId: event.toolUseId,
        summary: event.resultSummary,
        isError: event.isError,
      };
    case "turn_finished":
      return { type: "usage", usage: event.usage };
    case "compaction":
      // ADR-0008: a summarization call replaced the prefix; its own token
      // spend rides the engine event (the thread-log variant carries no
      // usage — a separate usage event follows it in the log).
      return {
        type: "compacted",
        trigger: event.trigger,
        summarizedTurns: event.summarizedTurns,
        keptTurns: event.keptTurns,
        usage: event.usage,
      };
    case "engine_stopped":
      return {
        type: "engine_stopped",
        reason: event.reason,
        ...(event.message !== undefined ? { message: event.message } : {}),
      };
  }
}

/**
 * Map a permission-gate record (`runTask` `onPermission`) to a SessionEvent.
 * ALLOWED calls are not rendered (noise); every denial — reject, or
 * ask/delegate hitting the still-headless gate — becomes a prominent entry.
 * P3 permission dialogs intercept the same records here, before reduction.
 */
export function permissionRecordToSession(record: PermissionGateRecord): SessionEvent | null {
  if (!record.headlessDenied) {
    return null;
  }
  return {
    type: "permission_denied",
    tool: record.tool,
    decision: record.action,
    reason: record.reason,
    ...(record.message !== undefined ? { message: record.message } : {}),
  };
}

// ---------------------------------------------------------------------------
// Replay mapping (thread store → session events)
// ---------------------------------------------------------------------------

/** First text block of a persisted tool result, as a one-line summary. */
function summarizeResultContent(
  content: readonly { readonly type: "text"; readonly text: string }[],
): string {
  for (const block of content) {
    if (block.text.trim().length > 0) {
      return singleLine(block.text, 80);
    }
  }
  return "(no output)";
}

/**
 * Map a thread log back to session events for the P1 viewer. Order is log
 * order; `tool_call` events are skipped (derived — the assistant_message
 * events carry the tool_use blocks).
 */
export function threadEventsToSessionEvents(events: readonly ThreadEvent[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "thread_metadata":
        out.push({
          type: "session_init",
          threadId: event.threadId,
          model: event.model ?? "unknown",
          workspaceRoot: "",
        });
        break;
      case "user_message": {
        const text = event.message.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (text.length > 0) {
          out.push({ type: "user_message", text });
        }
        break;
      }
      case "assistant_message":
        for (const block of event.message.content) {
          if (block.type === "text" && block.text.length > 0) {
            out.push({ type: "assistant_text_complete", text: block.text });
          } else if (block.type === "tool_use") {
            out.push({
              type: "tool_call",
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        break;
      case "tool_call":
        break; // derived data; see module doc
      case "compaction":
        // ADR-0008 log event: the summarized events STAY in the log around
        // it, so this renders a notice in place; usage follows separately.
        out.push({
          type: "compacted",
          trigger: event.trigger,
          summarizedTurns: event.summarizedTurns,
          keptTurns: event.keptTurns,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          toolUseId: event.toolUseId,
          summary: summarizeResultContent(event.result.content),
          isError: event.result.isError,
        });
        break;
      case "usage":
        out.push({ type: "usage", usage: event.usage });
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The feed (synchronous hub with backlog replay for late subscribers)
// ---------------------------------------------------------------------------

export type SessionListener = (event: SessionEvent) => void;

export interface EventQueue {
  /** Deliver one event to every subscriber (and remember it for late joiners). */
  push(event: SessionEvent): void;
  /**
   * Subscribe; the listener FIRST receives every already-pushed event
   * synchronously (backlog), then live events. Returns an unsubscribe.
   */
  subscribe(listener: SessionListener): () => void;
}

/** Build a session feed. */
export function createEventQueue(): EventQueue {
  const backlog: SessionEvent[] = [];
  const listeners = new Set<SessionListener>();
  return {
    push(event: SessionEvent): void {
      backlog.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener: SessionListener): () => void {
      for (const event of backlog) {
        listener(event);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
