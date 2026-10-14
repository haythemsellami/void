/**
 * Frame parser unit tests (ADR-0011): the buffered line parser must survive
 * EVERY chunking an OS pipe can produce — half a JSON object, several
 * objects in one chunk, CRLF endings, blank padding, and a trailing fragment
 * that never gets its newline. Pure: no I/O, no spawn.
 */
import { describe, expect, it } from "vitest";
import { createLineFrameParser } from "./frame";

describe("mcp frame parser", () => {
  it("emits one line per complete newline-terminated frame", () => {
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    parser.push('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n');
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":2}']);
  });

  it("survives chunk-split lines: a frame split at EVERY character boundary", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: ["echo"] } });
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    // Byte-by-byte across two frames, splitting mid-multi-byte UTF-8 too.
    const stream = `${payload}\n${payload}\n`;
    for (const char of stream) {
      parser.push(char);
    }
    expect(lines).toEqual([payload, payload]);
    expect(parser.pending).toBe("");
  });

  it("survives chunk splits inside a multi-byte UTF-8 payload", () => {
    const payload = JSON.stringify({ text: "héllo — ✓ mcp" });
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    const stream = `${payload}\n`;
    // Split at every CODE UNIT boundary (the decoder is stream-mode on the
    // client; here the parser sees already-decoded text, so unit splits are
    // the harshest cut it must handle).
    for (let i = 1; i <= stream.length; i += 1) {
      parser.push(stream.slice(i - 1, i));
    }
    expect(lines).toEqual([payload]);
  });

  it("strips a trailing \\r (CRLF-tolerant) and drops blank lines", () => {
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    parser.push('{"a":1}\r\n\r\n\n   \n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers a trailing fragment without newline in `pending`, never emits it", () => {
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    parser.push('{"complete":true}\n{"partial":tru');
    expect(lines).toEqual(['{"complete":true}']);
    expect(parser.pending).toBe('{"partial":tru');
    // The fragment completes only when its newline finally arrives.
    parser.push("e}\n");
    expect(lines).toEqual(['{"complete":true}', '{"partial":true}']);
    expect(parser.pending).toBe("");
  });

  it("handles \\r\\n split across chunks (\\r end of one chunk, \\n start of next)", () => {
    const lines: string[] = [];
    const parser = createLineFrameParser((line) => {
      lines.push(line);
    });
    parser.push('{"x":1}\r');
    expect(lines).toEqual([]);
    parser.push('\n{"y":2}\n');
    expect(lines).toEqual(['{"x":1}', '{"y":2}']);
  });
});
