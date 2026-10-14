/**
 * `read_file` builtin (docs/architecture.md §tools): read a UTF-8 text file
 * with 1-based line numbers, or list directory entries when the path is a
 * directory. Reads may target anywhere; writes are what the workspace
 * confinement applies to (edit_file).
 *
 * Output conventions:
 * - every rendered line is `${lineNumber}│ ${text}` with the number padded to
 *   the width of the largest displayed line number (directories: entry count);
 * - the first line is a header with the display path and line range;
 * - omitted ranges are stated explicitly (`… lines A-B not shown`), and the
 *   content block's `truncated` flag is set whenever anything was clipped.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { ToolContext, ToolInput, ToolResult, ToolSpec } from "../contracts/tools";
import {
  clipToOutputLimit,
  errnoCode,
  isProbablyBinary,
  optionalPositiveInt,
  resolveInputPath,
  textResult,
  toDisplayPath,
  toolError,
} from "./paths";

/** Default lines per read (Amp-style sub-context window; configurable per call). */
export const DEFAULT_LINE_LIMIT = 500;
/** Default byte ceiling per read. */
export const DEFAULT_MAX_BYTES = 256 * 1024;

function numberedLine(n: number, width: number, text: string): string {
  return `${String(n).padStart(width)}│ ${text}`;
}

function finish(text: string, truncated: boolean, ctx: ToolContext): ToolResult {
  const clipped = clipToOutputLimit(text, ctx.outputLimits);
  return textResult(clipped.text, truncated || clipped.truncated);
}

/** Result of one capped read: kept bytes, file size, and the TRUE line count. */
interface CappedRead {
  readonly data: Uint8Array;
  readonly size: number;
  /**
   * Total lines in the WHOLE file, not just the kept bytes: when the byte cap
   * truncates the read, the remainder is still scanned for newlines (without
   * being retained) so the header can report "lines X-Y of Z" honestly.
   */
  readonly totalLines: number;
}

/** Count 0x0A bytes in data[0..end). Safe for UTF-8: continuation bytes are >= 0x80. */
function countNewlines(data: Uint8Array, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) {
    if (data[i] === 0x0a) n++;
  }
  return n;
}

/** Read at most `maxBytes` from `abs`; throws fs errors to the caller's catch. */
function readCapped(abs: string, maxBytes: number): CappedRead {
  const fd = openSync(abs, "r");
  try {
    const size = fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const buf = new Uint8Array(want);
    let done = 0;
    while (done < want) {
      const n = readSync(fd, buf, done, want - done, done);
      if (n === 0) break;
      done += n;
    }
    let newlines = countNewlines(buf, done);
    let lastByte = done > 0 ? buf[done - 1] : -1;
    // Cheap true-total scan: keep reading past the cap in chunks, counting
    // newlines without retaining the bytes.
    if (done < size) {
      const chunk = new Uint8Array(64 * 1024);
      let pos = done;
      for (;;) {
        let n = 0;
        let eof = false;
        while (n < chunk.length) {
          const r = readSync(fd, chunk, n, chunk.length - n, pos + n);
          if (r === 0) {
            eof = true;
            break;
          }
          n += r;
        }
        if (n > 0) {
          newlines += countNewlines(chunk, n);
          lastByte = chunk[n - 1] ?? -1;
          pos += n;
        }
        if (eof) break;
      }
    }
    const totalLines = size === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1);
    return { data: buf.subarray(0, done), size, totalLines };
  } finally {
    closeSync(fd);
  }
}

function readTextFile(
  abs: string,
  display: string,
  ctx: ToolContext,
  offset: number,
  limit: number,
  maxBytes: number,
): ToolResult {
  const { data, size, totalLines: total } = readCapped(abs, maxBytes);
  if (isProbablyBinary(data)) {
    return toolError(
      "invalid_input",
      `${display} appears to be a binary file (NUL byte in the first 8 KiB); ` +
        "use grep or glob to inspect it instead of read_file",
    );
  }

  const byteTruncated = data.length < size;
  const text = new TextDecoder("utf-8").decode(data);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // `total` is the TRUE whole-file line count (readCapped scans past the
  // byte cap); `lines.length` is what is actually displayable from the
  // bytes we kept. The header reports "lines X-Y of Z" against the true Z.
  const visible = lines.length;

  const out: string[] = [];
  if (total === 0) {
    out.push(byteTruncated ? `${display} (empty or fully byte-capped)` : `${display} (empty file)`);
    return finish(out.join("\n"), byteTruncated, ctx);
  }

  const from = offset;
  if (from > total) {
    return finish(`${display} (no lines in range: file has ${total} lines)`, false, ctx);
  }
  if (from > visible) {
    return finish(
      `${display} (no lines in range within the ${data.length}-byte cap: file has ${total} lines)`,
      true,
      ctx,
    );
  }
  const to = Math.min(offset + limit - 1, visible);

  out.push(`${display} (lines ${from}-${to} of ${total})`);
  if (from > 1) out.push(`… lines 1-${from - 1} not shown`);
  const width = String(to).length;
  for (let n = from; n <= to; n++) {
    out.push(numberedLine(n, width, lines[n - 1] ?? ""));
  }
  let truncated = byteTruncated;
  if (to < total) {
    out.push(`… lines ${to + 1}-${total} not shown`);
    truncated = true;
  }
  if (byteTruncated) {
    out.push(`… byte cap reached: read ${data.length} of ${size} bytes`);
  }
  return finish(out.join("\n"), truncated, ctx);
}

function listDirectory(
  abs: string,
  display: string,
  ctx: ToolContext,
  offset: number,
  limit: number,
): ToolResult {
  const entries = readdirSync(abs, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const total = entries.length;

  const from = Math.min(offset, Math.max(total, 1));
  const to = Math.min(offset + limit - 1, total);
  const out: string[] = [`${display} (directory, ${total} entries)`];
  if (from > 1) out.push(`… entries 1-${from - 1} not shown`);
  const width = String(Math.max(to, 1)).length;
  for (let n = from; n <= to; n++) {
    const entry = entries[n - 1];
    if (entry) out.push(numberedLine(n, width, `${entry.name}${entry.isDir ? "/" : ""}`));
  }
  let truncated = false;
  if (to < total) {
    out.push(`… ${total - to} more entries not shown`);
    truncated = true;
  }
  return finish(out.join("\n"), truncated, ctx);
}

/** The read_file ToolSpec the engine registers (`tools/` registry, M3). */
export const readFileTool: ToolSpec = {
  name: "read_file",
  description:
    "Read a UTF-8 text file with 1-based line numbers, or list a directory's " +
    "entries when the path is a directory (directories get a trailing /). " +
    "Give absolute paths; relative paths resolve against the workspace root, " +
    "and reads outside the workspace are allowed. Page large files with " +
    "offset and limit (default: first 500 lines) and bound size with " +
    "maxBytes; truncation markers note anything omitted, and binary files " +
    "are refused with a pointer to grep/glob. Locate files first with glob " +
    "(by name) or grep (by content) instead of reading blindly; use " +
    "edit_file to change text whose exact form you already know.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file or directory path to read." },
      offset: { type: "integer", description: "1-based first line/entry to show (default 1)." },
      limit: {
        type: "integer",
        description: `Max lines/entries to show (default: outputLimits.maxLines, else ${DEFAULT_LINE_LIMIT}).`,
      },
      maxBytes: {
        type: "integer",
        description: `Max bytes to read (default ${DEFAULT_MAX_BYTES}).`,
      },
    },
    required: ["path"],
  },
  source: "builtin",
  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const pathInput = input.path;
    if (typeof pathInput !== "string" || pathInput.length === 0) {
      return toolError("invalid_input", "path must be a non-empty string");
    }
    for (const [value, name] of [
      [input.offset, "offset"],
      [input.limit, "limit"],
      [input.maxBytes, "maxBytes"],
    ] as const) {
      const parsed = optionalPositiveInt(value, name);
      if (!parsed.ok) return toolError("invalid_input", parsed.reason);
    }
    const offset = typeof input.offset === "number" ? input.offset : 1;
    // Per-call limit wins; otherwise the context's OutputLimits.maxLines (gap
    // #5), otherwise the tool's own default.
    const limit =
      typeof input.limit === "number"
        ? input.limit
        : (ctx.outputLimits.maxLines ?? DEFAULT_LINE_LIMIT);
    const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : DEFAULT_MAX_BYTES;

    const abs = resolveInputPath(pathInput, ctx.workspaceRoot);
    const display = toDisplayPath(abs, ctx.workspaceRoot);

    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(abs);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        return toolError("not_found", `path not found: ${display}`);
      }
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot access ${display}: permission denied`);
      }
      return toolError("execution_failed", `cannot stat ${display}: ${String(err)}`, true);
    }
    if (!isDir && !isFile) {
      return toolError(
        "invalid_input",
        `path is not a regular file or directory: ${display} ` +
          "(special files such as sockets, fifos and devices are not readable)",
      );
    }

    try {
      if (isDir) return listDirectory(abs, display, ctx, offset, limit);
      return readTextFile(abs, display, ctx, offset, limit, maxBytes);
    } catch (err) {
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot read ${display}: permission denied`);
      }
      return toolError("execution_failed", `failed to read ${display}: ${String(err)}`, true);
    }
  },
};
