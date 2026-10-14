/**
 * `src/mcp/frame` — buffered line parser for MCP stdio framing (ADR-0011).
 *
 * MCP stdio transports newline-delimited JSON-RPC 2.0 messages over the
 * child's stdin/stdout. OS pipes deliver arbitrary CHUNKS, not lines: one
 * write may carry half a JSON object, several objects, or a trailing fragment
 * with no newline yet. This parser is the single buffering point — it
 * accumulates bytes and emits exactly one callback per complete line, so the
 * client never sees a torn frame no matter how the pipe chunks the stream
 * (the chunk-split survival tests pin this byte-by-byte).
 *
 * Tolerances, deliberate:
 *
 * - `\r\n` line endings are accepted (trailing `\r` stripped) — the MCP spec
 *   says `\n`, but servers written against LSP-style tooling sometimes emit
 *   CRLF, and a stray `\r` would corrupt JSON.parse.
 * - Blank/whitespace-only lines are dropped silently (servers may pad).
 * - A final fragment with no trailing newline stays buffered in `pending`
 *   (never emitted as a line) — a JSON-RPC message is only complete once its
 *   newline arrives.
 *
 * Pure: no I/O; the caller owns the streams. Works with string chunks (the
 * client decodes stdout as UTF-8 incrementally, keeping multi-byte sequences
 * intact across chunk boundaries).
 */
export interface LineFrameParser {
  /** Feed one decoded chunk; emits zero or more complete lines. */
  push(chunk: string): void;
  /**
   * The not-yet-terminated trailing fragment (empty when the stream ended on
   * a line boundary). Diagnostic only — never dispatched as a message.
   */
  readonly pending: string;
}

/** Create a buffered line parser; `onLine` fires once per complete line. */
export function createLineFrameParser(onLine: (line: string) => void): LineFrameParser {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const raw = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim().length > 0) {
          onLine(line);
        }
        newlineAt = buffer.indexOf("\n");
      }
    },
    get pending(): string {
      return buffer;
    },
  };
}
