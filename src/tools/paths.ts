/**
 * Shared helpers for the file tools (`read_file`, `edit_file`, `glob`,
 * `grep`; docs/architecture.md §tools):
 *
 * - input-path resolution (absolute, or resolved against the workspace root);
 * - `resolveInsideWorkspace`: the write-confinement check used by `edit_file`
 *   (lexical resolve, then a realpath comparison so symlink chains that
 *   escape the workspace are rejected);
 * - display-path shortening, binary sniffing, and OutputLimits clipping;
 * - structured-result constructors (tools never throw for expected failures).
 *
 * Pure utilities; no tool registration happens here.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue, OutputLimits, ToolErrorCode, ToolResult } from "../contracts/tools";

/** Byte window examined by the binary sniff (NUL byte => assume binary). */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Resolve `input` (absolute, or relative to `root`) and verify the result
 * stays inside `root` even through symlinks. The check runs on the deepest
 * *existing* ancestor of the resolved path, so not-yet-created targets can
 * still be validated (their existing prefix is what could escape).
 *
 * On success returns the canonical (realpath) target plus the realpath'd
 * root — display paths must be computed against the latter, since the
 * target may live under a symlinked prefix (e.g. /var vs /private/var).
 * Failures carry a human-readable reason; callers map to a ToolError.
 */
export type ResolveInsideResult =
  | { readonly ok: true; readonly path: string; readonly root: string }
  | { readonly ok: false; readonly reason: string };

export function resolveInsideWorkspace(input: string, root: string): ResolveInsideResult {
  if (input.includes("\0")) return { ok: false, reason: "path contains a NUL byte" };
  if (input.trim() === "") return { ok: false, reason: "path is empty" };

  const joined = isAbsolute(input) ? resolve(input) : resolve(root, input);

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: `workspace root does not exist or is not accessible: ${root}` };
  }

  // Walk up to the deepest existing ancestor; the non-existing tail is then
  // appended to a realpath-verified prefix.
  let anchor = joined;
  let tail = "";
  for (;;) {
    try {
      const realAnchor = realpathSync(anchor);
      const realJoined = tail === "" ? realAnchor : join(realAnchor, tail);
      if (realJoined === realRoot || realJoined.startsWith(`${realRoot}${sep}`)) {
        return { ok: true, path: realJoined, root: realRoot };
      }
      return {
        ok: false,
        reason: `path resolves outside the workspace root (${input} -> ${realJoined})`,
      };
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        return { ok: false, reason: `cannot resolve path ${input}: ${String(err)}` };
      }
      const parent = dirname(anchor);
      if (parent === anchor) {
        return { ok: false, reason: `cannot resolve path ${input}: no existing ancestor` };
      }
      tail = tail === "" ? basename(anchor) : join(basename(anchor), tail);
      anchor = parent;
    }
  }
}

/**
 * Resolve a read-style input path (absolute, or relative to `root`).
 * Reads are not workspace-confined; callers stat it themselves.
 */
export function resolveInputPath(input: string, root: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(root, input);
}

/** Shorten `absPath` for model-facing output: relative to `root` when inside it. */
export function toDisplayPath(absPath: string, root: string): string {
  const rel = relative(root, absPath);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absPath;
  return rel.split(sep).join("/");
}

/** True when a NUL byte appears in the first 8 KiB (cheap binary sniff). */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Text plus whether it was clipped at an output cap. */
export interface ClippedText {
  readonly text: string;
  readonly truncated: boolean;
}

const CLIP_MARKER = "… [truncated]";

/**
 * Enforce OutputLimits on one text section: a single content block pays both
 * the section cap and the total cap, so the effective limit is the minimum.
 * When clipping, room is reserved so the marker itself fits inside the cap.
 */
export function clipToOutputLimit(text: string, limits: OutputLimits): ClippedText {
  const cap = Math.max(0, Math.min(limits.maxTotalChars, limits.maxSectionChars));
  if (text.length <= cap) return { text, truncated: false };
  if (cap <= CLIP_MARKER.length) return { text: text.slice(0, cap), truncated: true };
  return { text: `${text.slice(0, cap - CLIP_MARKER.length)}${CLIP_MARKER}`, truncated: true };
}

/** Successful single-block result. */
export function textResult(text: string, truncated: boolean): ToolResult {
  return { content: [{ type: "text", text, truncated }], isError: false };
}

/** Structured-error result (expected failures are returned, never thrown). */
export function toolError(code: ToolErrorCode, message: string, retryable = false): ToolResult {
  return { content: [], isError: true, error: { code, message, retryable } };
}

/** Extract a Node errno code ("ENOENT", "EACCES", ...) from an unknown throw. */
export function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Validated optional positive-integer input (offsets, limits, caps). */
export type OptionalIntResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly reason: string };

export function optionalPositiveInt(value: JsonValue | undefined, name: string): OptionalIntResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, reason: `${name} must be a positive integer` };
  }
  return { ok: true, value };
}

/** Validated optional boolean input. */
export type OptionalBoolResult =
  | { readonly ok: true; readonly value: boolean | undefined }
  | { readonly ok: false; readonly reason: string };

export function optionalBoolean(value: JsonValue | undefined, name: string): OptionalBoolResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, reason: `${name} must be a boolean` };
  return { ok: true, value };
}
