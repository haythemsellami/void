/**
 * Thread contract: the append-only event log every conversation persists as.
 *
 * Interface (plus the one runtime helper that brands ThreadIds). Implemented
 * by `store/` (one JSONL file per thread under the platform data dir —
 * docs/architecture.md §store, ADR-0002 property 6). Written by `core/`,
 * read by `void resume` (resume = replay) and export.
 *
 * Types only, apart from {@link threadId}; imports are the provider/tool
 * shapes events carry.
 */
import type { AssistantMessage, ModelRef, UsageRecord, UserMessage } from "./provider";
import type { ToolInput, ToolResult } from "./tools";

/**
 * Opaque thread identifier, assigned by the store and stable across sessions.
 * Branded: construct values with {@link threadId} (which enforces the store
 * charset). A ThreadId is assignable to plain `string`, never the reverse —
 * APIs taking a ThreadId must receive helper-branded values.
 */
export type ThreadId = string & { readonly __brand: "ThreadId" };

/** The only characters a thread id may contain (also the stores' filename guard). */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate and brand a thread id. Throws on any character outside
 * `[A-Za-z0-9_-]` — the same charset every ThreadStore enforces (rejecting
 * `.`, `/`, whitespace etc. is also what blocks path traversal when the id
 * becomes a file name).
 */
export function threadId(raw: string): ThreadId {
  if (!THREAD_ID_PATTERN.test(raw)) {
    throw new Error(
      `invalid thread id ${JSON.stringify(raw)}: must match ${THREAD_ID_PATTERN.toString()}`,
    );
  }
  return raw as ThreadId;
}

/** First event of every thread file: identity and creation metadata. */
export interface ThreadMetadataEvent {
  readonly type: "thread_metadata";
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly model?: ModelRef;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp assigned by the store at append time. */
  readonly at: string;
}

/** A user message entered the conversation. */
export interface UserMessageEvent {
  readonly type: "user_message";
  readonly message: UserMessage;
  readonly at: string;
}

/** A complete assistant message (post-stream, including its tool_use blocks). */
export interface AssistantMessageEvent {
  readonly type: "assistant_message";
  readonly message: AssistantMessage;
  readonly at: string;
}

/** The model initiated a tool call. */
export interface ToolCallEvent {
  readonly type: "tool_call";
  readonly toolUseId: string;
  readonly name: string;
  readonly input: ToolInput;
  readonly at: string;
}

/** A tool call finished with this result. */
export interface ToolResultEvent {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly result: ToolResult;
  readonly at: string;
}

/** Usage accounting recorded for one provider turn. */
export interface UsageRecordedEvent {
  readonly type: "usage";
  readonly usage: UsageRecord;
  readonly at: string;
}

/**
 * A compaction replaced the conversation prefix with a model-generated
 * summary (ADR-0008). The events it summarizes STAY in the log — compaction
 * is a view, not a rewrite — and replay folds this event into a summary
 * message ahead of the kept turns. Additive v1.1 event kind; every v1 kind's
 * shape is unchanged.
 */
export interface CompactionEvent {
  readonly type: "compaction";
  readonly at: string;
  /** Working-state summary standing in for the summarized prefix. */
  readonly summary: string;
  /** Provider turns (assistant rounds) replaced by the summary. */
  readonly summarizedTurns: number;
  /** Newest turns kept verbatim after the summary. */
  readonly keptTurns: number;
  /** Why compaction ran: the context threshold tripped, or a manual request. */
  readonly trigger: "threshold" | "manual";
  /**
   * Present (true) when the threshold was computed against the fallback
   * context window because the model registry does not know the resolved
   * model's real window (ollama/openai passthrough refs — ADR-0008 policy:
   * undefined windows fall back to the registry's 200_000 default rather
   * than disabling compaction, and the assumption is visible here).
   */
  readonly assumedContextWindow?: boolean;
}

/**
 * Discriminated union of everything appendable to a thread log. Line order in
 * the JSONL file is event order; `at` timestamps are for audit, not ordering.
 */
export type ThreadEvent =
  | ThreadMetadataEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageRecordedEvent
  | CompactionEvent;

/** Listing entry for `ThreadStore.list()`. */
export interface ThreadSummary {
  readonly id: ThreadId;
  readonly title?: string;
  readonly createdAt: string;
}

/** Machine-readable failure codes of the thread store. */
export type ThreadStoreErrorCode =
  /** threadId failed the charset check — rejected before any path use (traversal guard). */
  | "invalid_thread_id"
  /** Appended value is not a member of the ThreadEvent union (unknown `type`). */
  | "invalid_event"
  /** First event appended to a new thread was not a thread_metadata event. */
  | "invalid_first_event"
  /** thread_metadata.threadId differs from the thread it was appended to. */
  | "metadata_thread_mismatch"
  /** replay() was called for a thread that has no log. */
  | "unknown_thread"
  /** A log line is unparseable JSON, blank, or has an unknown `type`. */
  | "corrupt_thread_line";

/**
 * Structural error shape ThreadStore methods throw: a machine-readable code
 * plus, where relevant, the file path and 1-based line number localizing the
 * failure. Structural on purpose — the JSONL store's error class and any
 * future implementation satisfy it without sharing a base class; narrow by
 * reading `code`, not by `instanceof`.
 */
export interface ThreadStoreErrorShape {
  readonly code: ThreadStoreErrorCode;
  readonly message: string;
  /** Absolute path of the offending file, when one is known. */
  readonly path?: string | undefined;
  /** 1-based line number within `path`, when the error localizes to a line. */
  readonly line?: number | undefined;
}

/** A thread file `list()` skipped; never fatal to the listing itself. */
export interface ThreadListWarning {
  /** Absolute path of the skipped file. */
  readonly path: string;
  /** Why it was skipped (human-readable; the read failure's message). */
  readonly reason: string;
}

/**
 * Persistence surface for threads. The JSONL-backed implementation lands with
 * `store/` in a later workstream; `core/` codes against this interface only.
 */
export interface ThreadStore {
  /**
   * Optional warning sink for {@link list}: implementations that support it
   * call it once per thread file the listing skipped (unreadable, corrupt
   * first line, metadata mismatch), typically accepting the callback as a
   * constructor option and exposing it here so the capability is visible.
   */
  readonly onListWarning?: ((warning: ThreadListWarning) => void) | undefined;
  /**
   * Append an event to a thread's log. Appending to an unknown id creates the
   * log; the first event appended for a thread must be a ThreadMetadataEvent.
   *
   * Events are persisted VERBATIM: the store never stamps `at` — the CALLER
   * constructs complete events with their own timestamps (core builds each
   * event when the message/tool call it describes finishes). Line order in
   * the log is event order; `at` is audit metadata.
   */
  append(threadId: ThreadId, event: ThreadEvent): Promise<void>;
  /** Read a thread's full event log in order; resume = replay these events. */
  replay(threadId: ThreadId): Promise<readonly ThreadEvent[]>;
  /**
   * List known threads (ordering is implementation-defined; newest-first
   * recommended). Never throws for a single bad file: unreadable or corrupt
   * logs are skipped and surfaced through {@link onListWarning} instead.
   */
  list(): Promise<readonly ThreadSummary[]>;
}
