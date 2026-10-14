/**
 * Minimal server-sent-events (SSE) frame parser shared by streaming provider
 * adapters (anthropic today; other adapters may reuse it). Zero runtime
 * dependencies (ADR-0001): WHATWG `ReadableStream` + `TextDecoder` only.
 *
 * Implements the WHATWG SSE parsing rules as far as Void needs them:
 * - A frame is terminated by a blank line; line terminators may be `\n`,
 *   `\r\n` or a lone `\r`.
 * - `data:` lines accumulate and are joined with `\n` (multi-line data).
 * - One optional space after the field colon is stripped; the rest is kept.
 * - Lines starting with `:` are comments/keepalives and are ignored.
 * - `event:` names are surfaced when present; `id:`/`retry:` are ignored.
 * - A frame with no `data:` lines is not dispatched (per spec).
 * - If the stream ends with a pending frame that never received its blank
 *   line, that frame is flushed — robustness against truncated feeds.
 */

/** One dispatched SSE frame: accumulated `data` payload plus its event name, if any. */
export interface SSEEvent {
  readonly event?: string;
  readonly data: string;
}

/**
 * Parse an SSE byte stream into dispatched frames. Decoding is incremental
 * (`TextDecoder` streaming mode), so chunk boundaries may fall anywhere:
 * mid-line, mid-terminator, or mid multi-byte UTF-8 sequence.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const decoder = new TextDecoder("utf-8");
  let pending = ""; // tail of the current (possibly partial) line
  let eventName: string | undefined;
  const dataLines: string[] = [];

  /** Process one complete line; returns a frame to dispatch on blank lines. */
  const processLine = (line: string): SSEEvent | undefined => {
    if (line === "") {
      // Blank line: end of frame. Buffers reset either way (spec).
      if (dataLines.length === 0) {
        eventName = undefined;
        return undefined;
      }
      const data = dataLines.join("\n");
      dataLines.length = 0;
      const event = eventName;
      eventName = undefined;
      return event === undefined ? { data } : { event, data };
    }
    if (line.startsWith(":")) {
      return undefined; // comment / keepalive
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1); // exactly one optional space after the colon
    }
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value;
    }
    // `id:` / `retry:` / unknown fields: intentionally ignored.
    return undefined;
  };

  /** Feed decoded text, dispatching any frames it completes. */
  const feed = function* feed(text: string): Generator<SSEEvent, void, unknown> {
    pending += text;
    for (;;) {
      const terminator = pending.search(/\r|\n/);
      if (terminator === -1) {
        return;
      }
      const isCR = pending.charAt(terminator) === "\r";
      // A CR in final position may be the first half of a CRLF pair split
      // across chunks: wait for more input instead of a phantom blank line.
      if (isCR && terminator === pending.length - 1) {
        return;
      }
      const skip = isCR && pending.charAt(terminator + 1) === "\n" ? 2 : 1;
      const line = pending.slice(0, terminator);
      pending = pending.slice(terminator + skip);
      const frame = processLine(line);
      if (frame !== undefined) {
        yield frame;
      }
    }
  };

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        yield* feed(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush the decoder (a multi-byte sequence split at the very end), then any
  // trailing frame whose blank-line terminator never arrived.
  yield* feed(decoder.decode());
  if (pending !== "") {
    const frame = processLine(pending);
    pending = "";
    if (frame !== undefined) {
      yield frame;
    }
  }
  const tail = processLine("");
  if (tail !== undefined) {
    yield tail;
  }
}
