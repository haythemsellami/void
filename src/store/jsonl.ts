/**
 * `src/store/jsonl` — the JSONL-backed `ThreadStore`
 * (docs/architecture.md §store/, ADR-0002 property 6: threads are local
 * files).
 *
 * Layout: one file per thread at `<dataDir>/threads/<threadId>.jsonl`, one
 * JSON `ThreadEvent` per line, every append ending in a newline. The first
 * line of every file is its `thread_metadata` event (contract requirement,
 * enforced on append AND on replay). Events are persisted verbatim — `at`
 * timestamps are the caller's; line order is event order. A
 * `thread_metadata` event is only ever valid as that first line: appending
 * one to a non-empty log is rejected (`invalid_event`), which closes the
 * two-writers double-metadata hole.
 *
 * Concurrency: appends to the same thread are serialized through a per-thread
 * promise queue (chained in call order), so concurrent appends never
 * interleave bytes and the first-append metadata check has no TOCTOU window.
 *
 * Failure policy: loud, with one deliberate exception. Corrupt lines MID-file
 * fail `replay()` with a structured `ThreadStoreError` carrying the file path
 * and 1-based line number. The exception is a TORN FINAL line — a crash or
 * power loss mid-append can leave the last line half-written, and treating it
 * as fatal would permanently brick resume for that thread. `replay()` skips a
 * torn final line and surfaces it through the optional `onReplayWarning`
 * constructor hook (implementation-level: the frozen `ThreadStore` interface
 * carries no such field, unlike `onListWarning`). To keep the tolerated tail
 * from becoming fatal MID-file corruption later, `append()` first inspects an
 * existing file's tail and, when it does not end with a complete parseable
 * line, REPAIRS the file by atomically rewriting it without the torn tail
 * (temp file + rename, preserving every complete line) before appending.
 *
 * `list()` must survive a single corrupt file — such files are skipped and
 * surfaced through the optional `onListWarning` hook.
 *
 * No runtime dependencies: `node:fs/promises` only.
 */
import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type ThreadEvent,
  type ThreadId,
  type ThreadListWarning,
  type ThreadMetadataEvent,
  type ThreadStore,
  type ThreadSummary,
  threadId,
} from "../contracts/thread";
import { resolveDataDir } from "./dataDir";
import { ThreadStoreError } from "./errors";

/**
 * The only characters a thread id may contain (mirrors the charset the
 * contract's `threadId()` helper enforces). Validated before ANY path use;
 * rejects `.` and `/` etc., so `../` traversal and dotfiles are impossible.
 */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Known `type` discriminators of the ThreadEvent union (runtime mirror). */
const THREAD_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread_metadata",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "usage",
  // ADR-0008 (v1.1 additive): must move in the SAME commit as the contracts
  // union, or append() rejects the new event kind.
  "compaction",
]);

const THREADS_DIR_NAME = "threads";
const THREAD_FILE_EXTENSION = ".jsonl";
const FIRST_LINE_CHUNK_BYTES = 4096;

/** Re-exported from the contract so existing imports keep working. */
export type { ThreadListWarning };

export interface JsonlThreadStoreOptions {
  /**
   * Data directory to use instead of `resolveDataDir()` (tests, `--data-dir`
   * flags). Holds `<dataDir>/threads/`; created on first write.
   */
  readonly dataDir?: string;
  /**
   * Called once per file `list()` skips (unreadable, corrupt first line,
   * metadata mismatch). `list()` itself never throws for a bad file.
   */
  readonly onListWarning?: (warning: ThreadListWarning) => void;
  /**
   * Called when `replay()` skips a TORN FINAL line (crash-truncated tail) or
   * when `append()` repairs one before appending. Implementation-level option:
   * the frozen `ThreadStore` interface carries no such field (unlike
   * `onListWarning`), so this capability is visible only here.
   */
  readonly onReplayWarning?: (warning: ThreadListWarning) => void;
}

/**
 * `ThreadStore` over one JSONL file per thread under `<dataDir>/threads/`.
 * Constructing the store touches no disk; directories appear on first write.
 */
export class JsonlThreadStore implements ThreadStore {
  /** Contract surface for the list() warning sink (set from constructor options). */
  readonly onListWarning: ((warning: ThreadListWarning) => void) | undefined;
  /** Implementation-level warning sink for torn-tail skips/repairs (see options). */
  readonly onReplayWarning: ((warning: ThreadListWarning) => void) | undefined;
  readonly #queues = new Map<string, Promise<void>>();
  #dataDir: string | undefined;

  constructor(options: JsonlThreadStoreOptions = {}) {
    this.#dataDir = options.dataDir;
    this.onListWarning = options.onListWarning;
    this.onReplayWarning = options.onReplayWarning;
  }

  async append(threadId: ThreadId, event: ThreadEvent): Promise<void> {
    assertValidThreadId(threadId);
    assertValidEvent(event);
    await this.#enqueue(threadId, async () => {
      const threadsDir = await this.#ensureThreadsDir();
      const path = join(threadsDir, `${threadId}${THREAD_FILE_EXTENSION}`);
      // A crash-torn tail must never graduate into mid-file corruption:
      // repair (drop the torn tail, atomically) BEFORE appending behind it.
      await this.#repairTornTail(path);
      if ((await fileSize(path)) === 0) {
        // Contract: a log is created by its metadata event, nothing else.
        if (event.type !== "thread_metadata") {
          throw new ThreadStoreError(
            "invalid_first_event",
            `first event for thread ${threadId} must be a thread_metadata event ` +
              `(got "${event.type}"); no file was written`,
            { path },
          );
        }
        if (event.threadId !== threadId) {
          throw new ThreadStoreError(
            "metadata_thread_mismatch",
            `thread_metadata.threadId (${JSON.stringify(event.threadId)}) does not match ` +
              `the thread it was appended to (${JSON.stringify(threadId)}); no file was written`,
            { path },
          );
        }
      } else if (event.type === "thread_metadata") {
        // Two writers on one thread would each try to stamp metadata; the
        // second append is a protocol violation, not a new thread.
        throw new ThreadStoreError(
          "invalid_event",
          `thread_metadata may only be the FIRST event of a thread log; ` +
            `thread ${threadId} already has events (got a second thread_metadata)`,
          { path },
        );
      }
      await appendFile(path, `${JSON.stringify(event)}\n`);
    });
  }

  async replay(threadId: ThreadId): Promise<readonly ThreadEvent[]> {
    assertValidThreadId(threadId);
    const path = join(await this.#threadsDirPath(), `${threadId}${THREAD_FILE_EXTENSION}`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new ThreadStoreError(
          "unknown_thread",
          `no thread log for id ${JSON.stringify(threadId)} (expected ${path})`,
          { path, cause: error },
        );
      }
      throw error;
    }
    return parseThreadLog(raw, path, this.onReplayWarning);
  }

  async list(): Promise<readonly ThreadSummary[]> {
    const threadsDir = join(await this.#threadsDirPath());
    let entries: readonly Dirent[];
    try {
      entries = await readdir(threadsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return []; // No threads directory yet: empty store, not an error.
      }
      throw error;
    }

    const listed: { readonly summary: ThreadSummary; readonly mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(THREAD_FILE_EXTENSION)) {
        continue;
      }
      const path = join(threadsDir, entry.name);
      const id = entry.name.slice(0, -THREAD_FILE_EXTENSION.length);
      if (!THREAD_ID_PATTERN.test(id)) {
        this.#warn(path, "file name is not a valid thread id");
        continue;
      }
      const outcome = await summarizeThreadFile(path, id);
      if (outcome.kind === "skip") {
        this.#warn(path, outcome.reason);
        continue;
      }
      listed.push({ summary: outcome.summary, mtimeMs: outcome.mtimeMs });
    }

    // Newest activity first (file mtime = last append); id breaks mtime ties.
    listed.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.summary.id < b.summary.id ? -1 : 1));
    return listed.map((item) => item.summary);
  }

  /** Serialize a task behind every append already queued for this thread. */
  #enqueue(threadId: string, task: () => Promise<void>): Promise<void> {
    const tail = this.#queues.get(threadId) ?? Promise.resolve();
    // A failed append must not poison the queue for appends behind it.
    const run = tail.then(task, task);
    this.#queues.set(threadId, run);
    return run.finally(() => {
      if (this.#queues.get(threadId) === run) {
        this.#queues.delete(threadId);
      }
    });
  }

  async #threadsDirPath(): Promise<string> {
    return join(await this.#resolveDataDir(), THREADS_DIR_NAME);
  }

  /**
   * Ensure an existing file ends with a complete, parseable line; when it
   * does not (crash-torn tail), atomically rewrite it without the torn tail
   * (temp file + rename in the same directory, so the swap is atomic on
   * POSIX). No-op for absent, empty, or healthy files. Runs inside the
   * per-thread append queue, so no other append can interleave.
   */
  async #repairTornTail(path: string): Promise<void> {
    if ((await fileSize(path)) === 0) {
      return;
    }
    const raw = await readFile(path, "utf8");
    const trimmed = trimToCompleteLines(raw);
    if (trimmed === null) {
      return; // healthy tail
    }
    const temp = `${path}.repair-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temp, trimmed.kept);
      await rename(temp, path);
    } catch (error) {
      await rmQuietly(temp);
      throw error;
    }
    this.onReplayWarning?.({
      path,
      reason:
        `repaired torn tail before append: dropped ${trimmed.droppedBytes} bytes ` +
        `(${trimmed.droppedLines} incomplete line${trimmed.droppedLines === 1 ? "" : "s"})`,
    });
  }

  async #ensureThreadsDir(): Promise<string> {
    const threadsDir = await this.#threadsDirPath();
    await mkdir(threadsDir, { recursive: true });
    return threadsDir;
  }

  async #resolveDataDir(): Promise<string> {
    this.#dataDir ??= await resolveDataDir();
    return this.#dataDir;
  }

  #warn(path: string, reason: string): void {
    this.onListWarning?.({ path, reason });
  }
}

function assertValidThreadId(threadId: ThreadId): void {
  const value: unknown = threadId;
  if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) {
    throw new ThreadStoreError(
      "invalid_thread_id",
      `thread id ${JSON.stringify(value)} is invalid: must match ` +
        `${THREAD_ID_PATTERN.toString()} (also blocks path traversal); it was rejected before any file access`,
    );
  }
}

function assertValidEvent(event: ThreadEvent): void {
  const value: unknown = event;
  const type =
    typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !THREAD_EVENT_TYPES.has(type)) {
    throw new ThreadStoreError(
      "invalid_event",
      `not a ThreadEvent: unknown or missing "type" discriminator (${JSON.stringify(type)})`,
    );
  }
}

/**
 * Parse a thread log. Mid-file corruption throws loudly (path + 1-based
 * line). The FINAL line is the one deliberate exception: a crash-truncated
 * tail is skipped with a warning through `onWarning` instead of bricking
 * resume forever. The documented first-line contract (thread_metadata first)
 * is enforced on replay as well: a log whose first event is not metadata is
 * `invalid_first_event`.
 */
function parseThreadLog(
  raw: string,
  path: string,
  onWarning?: (warning: ThreadListWarning) => void,
): readonly ThreadEvent[] {
  if (raw.length === 0) {
    return [];
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop(); // Every append ends with a newline; tolerate its absence on read.
  }
  const events: ThreadEvent[] = [];
  const lastIndex = lines.length - 1;
  for (let index = 0; index <= lastIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const lineNumber = index + 1;
    if (index === lastIndex) {
      // Torn-tail tolerance: a crash can leave the final line half-written.
      // Skip it (with a warning) rather than fail the whole replay; the next
      // append repairs the file so the tail never becomes mid-file rot.
      try {
        events.push(parseEventLine(line, path, lineNumber));
      } catch (cause) {
        onWarning?.({
          path,
          reason: `skipped torn final line ${lineNumber}: ${errorMessage(cause)}`,
        });
      }
      continue;
    }
    events.push(parseEventLine(line, path, lineNumber));
  }
  const first = events[0];
  if (first !== undefined && first.type !== "thread_metadata") {
    throw new ThreadStoreError(
      "invalid_first_event",
      `corrupt thread log ${path}:1: first event is not thread_metadata ` +
        `(got "${first.type}"); a thread log is created by its metadata event`,
      { path, line: 1 },
    );
  }
  return events;
}

function parseEventLine(line: string, path: string, lineNumber: number): ThreadEvent {
  if (line.trim().length === 0) {
    throw new ThreadStoreError(
      "corrupt_thread_line",
      `corrupt thread log ${path}:${lineNumber}: blank line`,
      { path, line: lineNumber },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new ThreadStoreError(
      "corrupt_thread_line",
      `corrupt thread log ${path}:${lineNumber}: not valid JSON`,
      { path, line: lineNumber, cause },
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new ThreadStoreError(
      "corrupt_thread_line",
      `corrupt thread log ${path}:${lineNumber}: line is not a JSON object`,
      { path, line: lineNumber },
    );
  }
  const type = (value as { readonly type?: unknown }).type;
  if (typeof type !== "string" || !THREAD_EVENT_TYPES.has(type)) {
    throw new ThreadStoreError(
      "corrupt_thread_line",
      `corrupt thread log ${path}:${lineNumber}: unknown event type ${JSON.stringify(type)}`,
      { path, line: lineNumber },
    );
  }
  // Discriminator validated above; deeper shape is the writer's contract
  // (this store only writes events it received as ThreadEvent).
  return value as ThreadEvent;
}

/** A line is tail-complete when it parses as an event line (never throws). */
function isCompleteEventLine(line: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }
  try {
    parseEventLine(line, "", 0);
    return true;
  } catch {
    return false;
  }
}

interface TornTail {
  /** The file content reduced to its complete lines (newline-terminated). */
  readonly kept: string;
  readonly droppedBytes: number;
  readonly droppedLines: number;
}

/**
 * Drop trailing incomplete/unparseable lines so the remainder ends with a
 * complete event line. Returns null when the raw content is already healthy
 * (ends with a newline AND its final line parses). Only the TAIL is examined:
 * mid-file corruption with a healthy tail is left alone for replay() to fail
 * on loudly.
 */
function trimToCompleteLines(raw: string): TornTail | null {
  if (raw.length === 0) {
    return null;
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop(); // trailing newline is the terminator, not a line
  }
  let droppedLines = 0;
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last === undefined) {
      break;
    }
    if (last === "" || !isCompleteEventLine(last)) {
      lines.pop();
      droppedLines += 1;
      continue;
    }
    break;
  }
  const kept = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (kept.length === raw.length) {
    return null; // nothing dropped: healthy tail
  }
  return { kept, droppedBytes: raw.length - kept.length, droppedLines };
}

/** Best-effort temp-file cleanup; never masks the original error. */
async function rmQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // ignore: cleanup is best-effort
  }
}

type FirstLineOutcome =
  | { readonly kind: "ok"; readonly summary: ThreadSummary; readonly mtimeMs: number }
  | { readonly kind: "skip"; readonly reason: string };

/** Read only the first line + mtime of a thread file; never throws. */
async function summarizeThreadFile(path: string, id: string): Promise<FirstLineOutcome> {
  let firstLine: string;
  let mtimeMs: number;
  try {
    const handle = await open(path, "r");
    try {
      firstLine = await readFirstLineFrom(handle);
      mtimeMs = (await handle.stat()).mtimeMs;
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { kind: "skip", reason: `unreadable: ${errorMessage(error)}` };
  }

  let value: unknown;
  try {
    value = JSON.parse(firstLine);
  } catch {
    return { kind: "skip", reason: "first line is not valid JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { kind: "skip", reason: "first line is not a JSON object" };
  }
  if ((value as { readonly type?: unknown }).type !== "thread_metadata") {
    return { kind: "skip", reason: "first event is not thread_metadata" };
  }
  const metadata = value as ThreadMetadataEvent;
  if (metadata.threadId !== id) {
    return {
      kind: "skip",
      reason: `thread_metadata.threadId (${JSON.stringify(metadata.threadId)}) does not match file name`,
    };
  }
  if (typeof metadata.createdAt !== "string" || metadata.createdAt === "") {
    return { kind: "skip", reason: "thread_metadata.createdAt is missing" };
  }

  const summary: ThreadSummary = {
    // `id` was already validated against the thread charset by the caller.
    id: threadId(id),
    ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
    createdAt: metadata.createdAt,
  };
  return { kind: "ok", summary, mtimeMs };
}

/** Read up to (and excluding) the first `\n`; the whole file if it has none. */
async function readFirstLineFrom(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const parts: Buffer[] = [];
  const chunk = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, FIRST_LINE_CHUNK_BYTES, null);
    if (bytesRead === 0) {
      return Buffer.concat(parts).toString("utf8");
    }
    const read = chunk.subarray(0, bytesRead);
    const newlineAt = read.indexOf(0x0a);
    if (newlineAt !== -1) {
      parts.push(Buffer.from(read.subarray(0, newlineAt)));
      return Buffer.concat(parts).toString("utf8");
    }
    parts.push(Buffer.from(read)); // copy: `chunk` is reused on the next read
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFoundError(error)) {
      return 0;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
