/**
 * Unit tests for the shared SSE frame parser. The hard cases are byte-chunk
 * boundaries that split mid-line, mid-frame, mid-terminator (including CRLF
 * split across chunks) and mid multi-byte UTF-8 sequence. All input is
 * synthetic — these tests never touch the network.
 */
import { describe, expect, it } from "vitest";
import { parseSSE, type SSEEvent } from "./sse";

const encoder = new TextEncoder();

/** Build a byte stream that enqueues one chunk per given string. */
function streamOfStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build a byte stream from pre-made byte chunks (for byte-level splits). */
function streamOfBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Split text into fixed-size chunks (the every-N-characters stress split). */
function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSE(stream)) {
    events.push(event);
  }
  return events;
}

const TWO_FRAMES = 'event: message_start\ndata: {"a":1}\n\nevent: message_stop\ndata: {"b":2}\n\n';

describe("parseSSE", () => {
  it("parses named frames with their data payloads", async () => {
    const events = await collect(streamOfStrings([TWO_FRAMES]));
    expect(events).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "message_stop", data: '{"b":2}' },
    ]);
  });

  it("joins multi-line data with newlines", async () => {
    const events = await collect(streamOfStrings(["event: x\ndata: line1\ndata: line2\n\n"]));
    expect(events).toEqual([{ event: "x", data: "line1\nline2" }]);
  });

  it("ignores comments and keepalive-only frames", async () => {
    const events = await collect(
      streamOfStrings([": open stream\n\n", "data: real\n\n", ": keepalive\n\n"]),
    );
    expect(events).toEqual([{ data: "real" }]);
  });

  it("reassembles frames when chunks split mid-line (1 and 3 char chunks)", async () => {
    for (const size of [1, 3]) {
      const events = await collect(streamOfStrings(splitEvery(TWO_FRAMES, size)));
      expect(events).toEqual([
        { event: "message_start", data: '{"a":1}' },
        { event: "message_stop", data: '{"b":2}' },
      ]);
    }
  });

  it("handles a chunk boundary splitting the blank-line terminator", async () => {
    const events = await collect(streamOfStrings(["event: x\ndata: 1\n", "\ndata: 2\n\n"]));
    expect(events).toEqual([{ event: "x", data: "1" }, { data: "2" }]);
  });

  it("handles CRLF terminators, including CRLF split across chunks", async () => {
    const events = await collect(
      streamOfStrings(["event: a\r", "\ndata: 1\r", "\n\r", "\nevent: b\r\ndata: 2\r\n\r\n"]),
    );
    expect(events).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("handles lone CR terminators and mixed terminator styles", async () => {
    const events = await collect(streamOfStrings(["data: a\r\r", "data: b\n\n"]));
    expect(events).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("flushes a trailing frame that never got its blank line", async () => {
    const events = await collect(streamOfStrings(["event: tail\ndata: partial"]));
    expect(events).toEqual([{ event: "tail", data: "partial" }]);
  });

  it("decodes multi-byte UTF-8 characters split across chunks", async () => {
    // "é" encodes as two bytes (0xC3 0xA9); split the stream between them.
    const bytes = encoder.encode("data: héllo\n\n");
    const splitAt = 8; // after "data: h" + the first byte of "é"
    const events = await collect(streamOfBytes([bytes.slice(0, splitAt), bytes.slice(splitAt)]));
    expect(events).toEqual([{ data: "héllo" }]);
  });

  it("strips one space after the colon and keeps the rest", async () => {
    const events = await collect(
      streamOfStrings(["data:nospace\ndata:  onetwo\ndata:   three\n\n"]),
    );
    expect(events).toEqual([{ data: "nospace\n onetwo\n  three" }]);
  });

  it("resets the event name after each frame", async () => {
    const events = await collect(streamOfStrings(["event: named\ndata: 1\n\ndata: 2\n\n"]));
    expect(events).toStrictEqual([{ event: "named", data: "1" }, { data: "2" }]);
  });

  it("does not dispatch frames with no data lines", async () => {
    const events = await collect(streamOfStrings(["event: only-a-name\n\n", "event: other\n\n"]));
    expect(events).toEqual([]);
  });

  it("ignores id and retry fields", async () => {
    const events = await collect(
      streamOfStrings(["id: 42\nretry: 1000\nevent: e\ndata: kept\n\n"]),
    );
    expect(events).toEqual([{ event: "e", data: "kept" }]);
  });

  it("yields nothing for an empty stream", async () => {
    const events = await collect(streamOfStrings([]));
    expect(events).toEqual([]);
  });
});
