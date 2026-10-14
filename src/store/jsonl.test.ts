/**
 * Tests for `src/store/jsonl` — the JSONL-backed ThreadStore. Deterministic
 * and network-free: every store gets its own `fs.mkdtemp` dir as `dataDir`.
 *
 * Covers (mission list): roundtrip fidelity, first-event-must-be-metadata,
 * corrupt-line errors carrying path + 1-based line, thread-id traversal
 * guard, append serialization under concurrency, resilient list(), and the
 * empty store.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ThreadEvent,
  ThreadId,
  ThreadMetadataEvent,
  ThreadSummary,
  UsageRecordedEvent,
  UserMessageEvent,
} from "../contracts/thread";
import { threadId } from "../contracts/thread";
import { ThreadStoreError, type ThreadStoreErrorCode } from "./errors";
import type { ThreadListWarning } from "./jsonl";
import { JsonlThreadStore } from "./jsonl";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "void-store-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("JsonlThreadStore", () => {
  describe("append/replay roundtrip", () => {
    it("replays the identical event sequence in order, one JSON line per event", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_roundtrip");
      const events: readonly ThreadEvent[] = [
        metadata(id, "demo thread"),
        userEvent("list the files"),
        assistantEvent("on it"),
        usageEvent(120, 34),
      ];
      for (const event of events) {
        await store.append(id, event);
      }

      await expect(store.replay(id)).resolves.toEqual(events);

      const raw = await readFile(threadPath(id), "utf8");
      expect(raw).toBe(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    });

    it("rejects replay of an unknown thread with a structured error naming the path", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.replay(threadId("never-created")),
        "unknown_thread",
      );
      expect(error.path).toBe(threadPath("never-created"));
    });

    it("accepts and replays the v1.1 compaction event (ADR-0008 mirror moves atomically)", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_compaction");
      const events: readonly ThreadEvent[] = [
        metadata(id),
        userEvent("a long task"),
        {
          type: "compaction",
          summary: "Goal: ship compaction. Files changed: src/store/jsonl.ts.",
          summarizedTurns: 4,
          keptTurns: 2,
          trigger: "manual",
          at: "2026-01-01T00:00:04.000Z",
        },
      ];
      for (const event of events) {
        await store.append(id, event);
      }
      await expect(store.replay(id)).resolves.toEqual(events);
    });
  });

  describe("first event must be thread_metadata", () => {
    it("rejects a non-metadata first append and writes nothing", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.append(threadId("t_first"), userEvent("hi")),
        "invalid_first_event",
      );
      expect(error.message).toContain("thread_metadata");

      await expect(readdir(join(dataDir, "threads"))).resolves.toEqual([]);
      await expect(store.replay(threadId("t_first"))).rejects.toThrow(ThreadStoreError);
    });

    it("accepts the same event once the log exists (rule applies to the first event only)", async () => {
      const store = new JsonlThreadStore({ dataDir });
      await store.append(threadId("t_first"), metadata("t_first"));
      await store.append(threadId("t_first"), userEvent("hi"));
      const types = (await store.replay(threadId("t_first"))).map((event) => event.type);
      expect(types).toEqual(["thread_metadata", "user_message"]);
    });

    it("rejects metadata whose threadId does not match the appended thread", async () => {
      const store = new JsonlThreadStore({ dataDir });
      await captureStoreError(
        store.append(threadId("t_a"), metadata("t_b")),
        "metadata_thread_mismatch",
      );
      await expect(readdir(join(dataDir, "threads"))).resolves.toEqual([]);
    });
  });

  describe("corrupt logs fail loudly on replay", () => {
    it("reports file path and 1-based line for an unparseable mid-file line", async () => {
      await writeThreadLog("t_corrupt", [
        JSON.stringify(metadata("t_corrupt")),
        "{not json",
        JSON.stringify(usageEvent(1, 1)), // good line AFTER the bad one: corruption is mid-file
      ]);
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.replay(threadId("t_corrupt")),
        "corrupt_thread_line",
      );
      expect(error.path).toBe(threadPath("t_corrupt"));
      expect(error.line).toBe(2);
      expect(error.message).toContain("t_corrupt.jsonl:2");
    });

    it("reports an unknown event type discriminator the same way", async () => {
      await writeThreadLog("t_unknown", [
        JSON.stringify(metadata("t_unknown")),
        '{"type":"banana","at":"2026-01-01T00:00:00.000Z"}',
        JSON.stringify(usageEvent(1, 1)),
      ]);
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.replay(threadId("t_unknown")),
        "corrupt_thread_line",
      );
      expect(error.line).toBe(2);
      expect(error.message).toContain("banana");
    });

    it("treats a blank line mid-file as corruption, not silence", async () => {
      await writeThreadLog("t_blank", [
        JSON.stringify(metadata("t_blank")),
        "",
        JSON.stringify(usageEvent(1, 1)),
      ]);
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.replay(threadId("t_blank")),
        "corrupt_thread_line",
      );
      expect(error.line).toBe(2);
    });
  });

  describe("torn final line (crash-truncated tail)", () => {
    it("replay skips a torn final line and surfaces a warning", async () => {
      const warnings: ThreadListWarning[] = [];
      const store = new JsonlThreadStore({
        dataDir,
        onReplayWarning: (warning) => warnings.push(warning),
      });
      // Crash mid-append: the last line is half-written.
      await seedRawThread(
        "t_torn",
        `${JSON.stringify(metadata("t_torn"))}\n${JSON.stringify(userEvent("hi")).slice(0, 24)}`,
      );

      const replayed = await store.replay(threadId("t_torn"));

      expect(replayed).toHaveLength(1); // metadata survived; the torn line was skipped
      expect(replayed[0]?.type).toBe("thread_metadata");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.path).toBe(threadPath("t_torn"));
      expect(warnings[0]?.reason).toContain("torn final line 2");
    });

    it("replay tolerates a torn final line even without a warning sink", async () => {
      await writeThreadLog("t_torn_quiet", [JSON.stringify(metadata("t_torn_quiet")), "{not json"]);
      const store = new JsonlThreadStore({ dataDir });

      const replayed = await store.replay(threadId("t_torn_quiet"));

      expect(replayed.map((event) => event.type)).toEqual(["thread_metadata"]);
    });

    it("append repairs a torn tail before appending; replay is clean afterwards", async () => {
      const warnings: ThreadListWarning[] = [];
      const store = new JsonlThreadStore({
        dataDir,
        onReplayWarning: (warning) => warnings.push(warning),
      });
      const id = threadId("t_repair");
      // Seed: one complete event, then a torn tail (no trailing newline).
      await seedRawThread("t_repair", `${JSON.stringify(metadata("t_repair"))}\n{"type":"user_mes`);

      await store.append(id, userEvent("after repair"));

      // The repair warning fired, and the file now replays cleanly: the torn
      // tail is gone, the new event landed, and every line is complete.
      expect(warnings.map((warning) => warning.reason).join("\n")).toContain("repaired torn tail");
      const replayed = await store.replay(id);
      expect(replayed.map((event) => event.type)).toEqual(["thread_metadata", "user_message"]);
      const raw = await readFile(threadPath("t_repair"), "utf8");
      for (const line of raw.trimEnd().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(raw.endsWith("\n")).toBe(true);
    });

    it("append repairs down to an empty file when even the first line is torn", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_repair_all");
      await seedRawThread("t_repair_all", '{"type":"thread_met');

      // The emptied log must be created by metadata again.
      await captureStoreError(store.append(id, userEvent("too early")), "invalid_first_event");
      await store.append(id, metadata("t_repair_all"));
      await store.append(id, userEvent("ok now"));
      expect((await store.replay(id)).map((event) => event.type)).toEqual([
        "thread_metadata",
        "user_message",
      ]);
    });

    it("append does not touch a healthy file (no repair warning)", async () => {
      const warnings: ThreadListWarning[] = [];
      const store = new JsonlThreadStore({
        dataDir,
        onReplayWarning: (warning) => warnings.push(warning),
      });
      const id = threadId("t_healthy");
      await store.append(id, metadata("t_healthy"));
      await store.append(id, userEvent("fine"));
      expect(warnings).toHaveLength(0);
      expect((await store.replay(id)).map((event) => event.type)).toEqual([
        "thread_metadata",
        "user_message",
      ]);
    });
  });

  describe("thread_metadata placement rules", () => {
    it("rejects thread_metadata appended to a non-empty log (invalid_event)", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_double_meta");
      await store.append(id, metadata("t_double_meta"));
      await store.append(id, userEvent("hi"));

      const error = await captureStoreError(
        store.append(id, metadata("t_double_meta")),
        "invalid_event",
      );
      expect(error.message).toContain("FIRST event");
      // The rejected append wrote nothing; the log is unchanged.
      expect((await store.replay(id)).map((event) => event.type)).toEqual([
        "thread_metadata",
        "user_message",
      ]);
    });

    it("replay throws invalid_first_event when the first event is not thread_metadata", async () => {
      await writeThreadLog("t_no_meta_first", [
        JSON.stringify(userEvent("no metadata")),
        JSON.stringify(usageEvent(1, 1)),
      ]);
      const store = new JsonlThreadStore({ dataDir });
      const error = await captureStoreError(
        store.replay(threadId("t_no_meta_first")),
        "invalid_first_event",
      );
      expect(error.path).toBe(threadPath("t_no_meta_first"));
      expect(error.line).toBe(1);
      expect(error.message).toContain("thread_metadata");
    });
  });

  describe("thread id validation (path traversal guard)", () => {
    it("rejects ids outside /^[A-Za-z0-9_-]+$/ before any file access", async () => {
      const store = new JsonlThreadStore({ dataDir });
      for (const raw of ["../escape", "a/b", "a.b", "a b", "", "."]) {
        // Branded ids must come from threadId(); these tests deliberately
        // smuggle invalid raws past the type (the store re-validates).
        const id = raw as ThreadId;
        await captureStoreError(store.append(id, metadata(raw)), "invalid_thread_id");
        await captureStoreError(store.replay(id), "invalid_thread_id");
      }
      expect(await pathExists(join(dataDir, "..", "escape.jsonl"))).toBe(false);
      expect(await pathExists(join(dataDir, "a.b.jsonl"))).toBe(false);
    });

    it("accepts the full allowed alphabet (alnum, underscore, hyphen)", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("Az09_-thread");
      await store.append(id, metadata(id));
      expect((await store.replay(id))[0]?.type).toBe("thread_metadata");
    });
  });

  describe("concurrent appends", () => {
    it("serializes 50 concurrent appends; replay sees them in call order", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_concurrent");
      await store.append(id, metadata(id));
      const payloads = Array.from({ length: 50 }, (_, index) => `msg-${index}`);

      await Promise.all(payloads.map((payload) => store.append(id, userEvent(payload))));

      const replayed = await store.replay(id);
      expect(replayed).toHaveLength(51);
      expect(replayed.slice(1).map(userText)).toEqual(payloads);
    });

    it("has no TOCTOU on the first append: queued metadata-then-user both land", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_race");
      await Promise.all([
        store.append(id, metadata("t_race")),
        store.append(id, userEvent("after metadata")),
      ]);
      expect((await store.replay(id)).map((event) => event.type)).toEqual([
        "thread_metadata",
        "user_message",
      ]);
    });

    it("a failed append does not poison the queue for appends behind it", async () => {
      const store = new JsonlThreadStore({ dataDir });
      const id = threadId("t_poison");
      const results = await Promise.allSettled([
        store.append(id, userEvent("too early")),
        store.append(id, metadata("t_poison")),
      ]);
      // The first append rejects (non-metadata first event, nothing written);
      // the queued metadata append behind it still lands — the queue recovered.
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]?.status).toBe("fulfilled");
      expect((await store.replay(id)).map((event) => event.type)).toEqual(["thread_metadata"]);
    });
  });

  describe("list", () => {
    it("returns [] for an empty store (no threads dir yet)", async () => {
      const store = new JsonlThreadStore({ dataDir });
      await expect(store.list()).resolves.toEqual([]);
    });

    it("lists healthy threads newest-activity-first with id/title/createdAt", async () => {
      const store = new JsonlThreadStore({ dataDir });
      await store.append(threadId("t_a"), metadata("t_a", "Alpha"));
      await store.append(threadId("t_b"), metadata("t_b"));
      await store.append(threadId("t_c"), metadata("t_c", "Gamma"));
      const base = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
      const when = (seconds: number) => new Date((base + seconds) * 1000);
      await utimes(threadPath("t_a"), when(1), when(1));
      await utimes(threadPath("t_b"), when(2), when(2));
      await utimes(threadPath("t_c"), when(3), when(3));

      const listed = await store.list();
      expect(listed.map((summary: ThreadSummary) => summary.id)).toEqual(["t_c", "t_b", "t_a"]);
      expect(listed[0]).toEqual({ id: "t_c", title: "Gamma", createdAt: CREATED_AT });
      expect(listed[1]).toEqual({ id: "t_b", createdAt: CREATED_AT });
    });

    it("skips corrupt files with a warning while still listing the rest", async () => {
      const warnings: ThreadListWarning[] = [];
      const store = new JsonlThreadStore({
        dataDir,
        onListWarning: (warning) => warnings.push(warning),
      });
      await store.append(threadId("t_a"), metadata("t_a", "Alpha"));
      await store.append(threadId("t_bad"), metadata("t_bad"));
      await store.append(threadId("t_c"), metadata("t_c"));
      await writeFile(threadPath("t_bad"), "garbage, not even json\n"); // corrupt first line
      await writeFile(threadPath("we ird"), "irrelevant\n"); // invalid id in file name
      // Deterministic mtimes (CI fix): on fast Linux filesystems the appends
      // land within one mtime granularity, leaving list()'s newest-first
      // order at the mercy of its id tiebreak. Explicit distinct stamps pin
      // the intended order on every platform (same pattern as the test above).
      const base = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
      const when = (seconds: number) => new Date((base + seconds) * 1000);
      await utimes(threadPath("t_a"), when(2), when(2));
      await utimes(threadPath("t_c"), when(1), when(1));

      const listed = await store.list();

      expect(listed.map((summary) => summary.id)).toEqual(["t_a", "t_c"]);
      // list() emits warnings in readdir enumeration order, and readdir order
      // is filesystem-defined (creation order on APFS, hash order on ext4 —
      // the bun-on-Linux CI failure). Compare as an exact per-path set with
      // per-path reasons instead of a creation-ordered array.
      const reasonByPath = new Map(warnings.map((warning) => [warning.path, warning.reason]));
      expect([...reasonByPath.keys()].sort()).toEqual(
        [threadPath("t_bad"), threadPath("we ird")].sort(),
      );
      expect(reasonByPath.get(threadPath("t_bad"))).toContain("not valid JSON");
      expect(reasonByPath.get(threadPath("we ird"))).toContain("not a valid thread id");
    });

    it("skips (with warning) a file whose first event is not metadata", async () => {
      const warnings: ThreadListWarning[] = [];
      const store = new JsonlThreadStore({
        dataDir,
        onListWarning: (warning) => warnings.push(warning),
      });
      await writeThreadLog("t_nometa", [JSON.stringify(userEvent("no metadata here"))]);

      await expect(store.list()).resolves.toEqual([]);
      expect(warnings[0]?.path).toBe(threadPath("t_nometa"));
      expect(warnings[0]?.reason).toContain("not thread_metadata");
    });
  });
});

// --- fixtures and helpers ---------------------------------------------------

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function metadata(raw: string, title?: string): ThreadMetadataEvent {
  return {
    type: "thread_metadata",
    // Fixtures may hold ids the store must reject; bypass the brand helper
    // deliberately (the store re-validates every id before any path use).
    threadId: raw as ThreadId,
    ...(title === undefined ? {} : { title }),
    createdAt: CREATED_AT,
    at: CREATED_AT,
  };
}

function userEvent(text: string): UserMessageEvent {
  return {
    type: "user_message",
    message: { role: "user", content: [{ type: "text", text }] },
    at: "2026-01-01T00:00:01.000Z",
  };
}

function assistantEvent(text: string): ThreadEvent {
  return {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text }] },
    at: "2026-01-01T00:00:02.000Z",
  };
}

function usageEvent(inputTokens: number, outputTokens: number): UsageRecordedEvent {
  return { type: "usage", usage: { inputTokens, outputTokens }, at: "2026-01-01T00:00:03.000Z" };
}

function userText(event: ThreadEvent): string | undefined {
  if (event.type !== "user_message") {
    return undefined;
  }
  const block = event.message.content[0];
  return block?.type === "text" ? block.text : undefined;
}

function threadPath(id: string): string {
  return join(dataDir, "threads", `${id}.jsonl`);
}

/** Hand-craft a thread log (bypassing the store) to simulate corruption. */
async function writeThreadLog(id: string, lines: readonly string[]): Promise<void> {
  await seedRawThread(id, `${lines.join("\n")}\n`);
}

/** Hand-craft raw file bytes (torn tails need control over the final newline). */
async function seedRawThread(id: string, raw: string): Promise<void> {
  await mkdir(join(dataDir, "threads"), { recursive: true });
  await writeFile(threadPath(id), raw);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Await a promise that must reject with ThreadStoreError of the given code. */
async function captureStoreError(
  promise: Promise<unknown>,
  code: ThreadStoreErrorCode,
): Promise<ThreadStoreError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ThreadStoreError)) {
      throw new Error(`expected ThreadStoreError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected promise to reject with ThreadStoreError(${code})`);
}
