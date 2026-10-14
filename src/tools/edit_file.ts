/**
 * `edit_file` builtin (docs/architecture.md §tools): replace an exact text
 * snippet in one workspace file and return a unified diff of the change.
 *
 * MVP write-confinement policy (deliberate, see final report): the target
 * must resolve inside ToolContext.workspaceRoot — lexical resolve plus a
 * realpath containment check (symlink escapes rejected). Writes outside are
 * a structured invalid_input error, not a sandbox concern (that is bash's
 * job in M3).
 *
 * Write safety: files are read as bytes and must be valid UTF-8 (a lossy
 * decode used to corrupt non-UTF-8 files); inputs over an output-limits-
 * derived byte cap are refused; hard-linked files (st_nlink > 1) are
 * refused; and the new content lands via write-to-temp + rename(2) in the
 * same directory, so a crash mid-write can never truncate the target. The
 * residual check-to-use race is accepted (the OS sandbox confines the
 * blast radius — see the TOCTOU note in execute()).
 *
 * The diff comes from an in-repo minimal line differ: common prefix/suffix
 * trim, then a classic LCS table over the remaining lines (with a
 * whole-hunk fallback above a size cap), rendered as unified-diff hunks
 * with 3 context lines. Zero runtime dependencies.
 */

import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ToolContext, ToolInput, ToolResult, ToolSpec } from "../contracts/tools";
import {
  clipToOutputLimit,
  errnoCode,
  isProbablyBinary,
  optionalBoolean,
  resolveInsideWorkspace,
  textResult,
  toDisplayPath,
  toolError,
} from "./paths";

/* ------------------------------------------------------------------ differ */

/** One line of a file, remembering whether it ended with a newline. */
interface SplitLine {
  readonly text: string;
  readonly nl: boolean;
}

const EMPTY_LINE: SplitLine = { text: "", nl: false };

function splitKeepEnds(content: string): SplitLine[] {
  if (content === "") return [];
  const parts = content.split("\n");
  const out: SplitLine[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push({ text: parts[i] ?? "", nl: true });
  const last = parts[parts.length - 1] ?? "";
  if (last !== "") out.push({ text: last, nl: false });
  return out;
}

function lineEq(a: SplitLine, b: SplitLine): boolean {
  return a.nl === b.nl && a.text === b.text;
}

interface DiffOp {
  readonly kind: "eq" | "del" | "add";
  readonly line: SplitLine;
}

/** Above this many LCS cells the differ falls back to one whole-hunk diff. */
const LCS_CELL_CAP = 4_000_000;

/** Edit script between two line arrays via an LCS table (no dependencies). */
function diffOps(a: readonly SplitLine[], b: readonly SplitLine[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  if (n * m > LCS_CELL_CAP) {
    for (const line of a) ops.push({ kind: "del", line });
    for (const line of b) ops.push({ kind: "add", line });
    return ops;
  }
  // dp[i * w + j] = LCS length of a[i..] and b[j..]
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const la = a[i] ?? EMPTY_LINE;
      const lb = b[j] ?? EMPTY_LINE;
      dp[i * w + j] = lineEq(la, lb) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const la = a[i] ?? EMPTY_LINE;
    const lb = b[j] ?? EMPTY_LINE;
    if (lineEq(la, lb)) {
      ops.push({ kind: "eq", line: la });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "del", line: la });
      i++;
    } else {
      ops.push({ kind: "add", line: lb });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", line: a[i] ?? EMPTY_LINE });
  for (; j < m; j++) ops.push({ kind: "add", line: b[j] ?? EMPTY_LINE });
  return ops;
}

/** Context lines around each change cluster in unified-diff hunks. */
export const DIFF_CONTEXT = 3;

/**
 * Minimal unified diff between two file contents: 3-line context hunks,
 * standard `@@ -start,count +start,count @@` headers, git-style
 * "\ No newline at end of file" markers. Exported for tests.
 */
export function computeUnifiedDiff(oldText: string, newText: string, pathLabel: string): string {
  const a = splitKeepEnds(oldText);
  const b = splitKeepEnds(newText);

  // Trim the maximal common prefix/suffix so the LCS only sees the middle.
  let p = 0;
  while (p < a.length && p < b.length && lineEq(a[p] ?? EMPTY_LINE, b[p] ?? EMPTY_LINE)) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    lineEq(a[a.length - 1 - s] ?? EMPTY_LINE, b[b.length - 1 - s] ?? EMPTY_LINE)
  ) {
    s++;
  }

  const ops: DiffOp[] = [];
  for (let k = 0; k < p; k++) ops.push({ kind: "eq", line: a[k] ?? EMPTY_LINE });
  ops.push(...diffOps(a.slice(p, a.length - s), b.slice(p, b.length - s)));
  for (let k = a.length - s; k < a.length; k++) {
    ops.push({ kind: "eq", line: a[k] ?? EMPTY_LINE });
  }

  // How many old/new lines each op consumed before a given op index
  // (add ops consume only new lines, del ops only old lines).
  const oldBefore: number[] = new Array(ops.length + 1).fill(0);
  const newBefore: number[] = new Array(ops.length + 1).fill(0);
  for (let idx = 0; idx < ops.length; idx++) {
    const kind = ops[idx]?.kind;
    oldBefore[idx + 1] = (oldBefore[idx] ?? 0) + (kind === "add" ? 0 : 1);
    newBefore[idx + 1] = (newBefore[idx] ?? 0) + (kind === "del" ? 0 : 1);
  }

  // Cluster consecutive non-eq ops; expand each cluster by DIFF_CONTEXT and
  // merge clusters whose expansions overlap or abut.
  const clusters: Array<{ cs: number; ce: number }> = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.kind === "eq") {
      k++;
      continue;
    }
    const cs = k;
    while (k < ops.length && ops[k]?.kind !== "eq") k++;
    clusters.push({ cs, ce: k });
  }
  const regions: Array<{ s: number; e: number }> = [];
  for (const { cs, ce } of clusters) {
    const s2 = Math.max(0, cs - DIFF_CONTEXT);
    const e2 = Math.min(ops.length, ce + DIFF_CONTEXT);
    const last = regions[regions.length - 1];
    if (last && s2 <= last.e) last.e = Math.max(last.e, e2);
    else regions.push({ s: s2, e: e2 });
  }

  const out: string[] = [`--- a/${pathLabel}`, `+++ b/${pathLabel}`];
  for (const region of regions) {
    let oldCount = 0;
    let newCount = 0;
    for (let idx = region.s; idx < region.e; idx++) {
      const kind = ops[idx]?.kind;
      if (kind !== "add") oldCount++;
      if (kind !== "del") newCount++;
    }
    const beforeOld = oldBefore[region.s] ?? 0;
    const beforeNew = newBefore[region.s] ?? 0;
    const oldStart = oldCount > 0 ? beforeOld + 1 : beforeOld;
    const newStart = newCount > 0 ? beforeNew + 1 : beforeNew;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let idx = region.s; idx < region.e; idx++) {
      const op = ops[idx];
      if (!op) continue;
      const prefix = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
      out.push(`${prefix}${op.line.text}`);
      if (!op.line.nl) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n");
}

/* ------------------------------------------------------------- edit logic */

/** Non-overlapping occurrence offsets of `needle` in `haystack`. Exported for tests. */
export function findOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** 1-based line number of the line containing byte offset `idx`. */
function lineNumberOf(haystack: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) {
    if (haystack.charCodeAt(i) === 10) n++;
  }
  return n;
}

function normalizeWs(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(s: string): string[] {
  return normalizeWs(s)
    .split(" ")
    .filter((t) => t.length > 0);
}

function clipSnippet(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export interface ClosestMatch {
  readonly line: number;
  readonly text: string;
  readonly onlyWhitespaceOrCase: boolean;
}

const HINT_SCAN_CAP = 5000;
const HINT_SCORE_THRESHOLD = 0.4;

/**
 * Best-effort near-miss hint for a zero-match edit: the first line that is
 * equal modulo whitespace/case, else the line with the highest token
 * Jaccard similarity above a threshold. Deterministic; scans at most
 * HINT_SCAN_CAP lines. Exported for tests.
 */
export function findClosestMatchLine(content: string, oldStr: string): ClosestMatch | null {
  const firstMeaningful = oldStr.split("\n").find((l) => l.trim() !== "") ?? "";
  const target = normalizeWs(firstMeaningful);
  if (target === "") return null;
  const targetTokens = new Set(tokenize(firstMeaningful));

  const lines = content.split("\n");
  const scan = Math.min(lines.length, HINT_SCAN_CAP);
  let best: ClosestMatch | null = null;
  let bestScore = 0;
  for (let i = 0; i < scan; i++) {
    const line = lines[i] ?? "";
    if (normalizeWs(line) === target) {
      return { line: i + 1, text: clipSnippet(line), onlyWhitespaceOrCase: true };
    }
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    let shared = 0;
    for (const t of tokens) {
      if (targetTokens.has(t)) shared++;
    }
    const score = shared / (targetTokens.size + tokens.length - shared);
    if (score > bestScore) {
      bestScore = score;
      best = { line: i + 1, text: clipSnippet(line), onlyWhitespaceOrCase: false };
    }
  }
  return bestScore >= HINT_SCORE_THRESHOLD ? best : null;
}

/* ---------------------------------------------------------------- the tool */

/**
 * The edit_file ToolSpec the engine registers (`tools/` registry, M3).
 * Helpers above are exported for tests and reuse.
 */
export const editFileTool: ToolSpec = {
  name: "edit_file",
  description:
    "Replace an exact text snippet in one file and return a unified diff. " +
    "path must be absolute and inside the workspace root; writes outside " +
    "the workspace are rejected (MVP confinement policy). old_str must " +
    "match exactly once — include surrounding lines to disambiguate; " +
    "multiple matches are an error unless replace_all is true, and zero " +
    "matches return the closest similar line as a hint. Indentation and " +
    "whitespace must match byte-for-byte, so read_file the region first " +
    "when unsure. Prefer edit_file over bash for text changes.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the file to edit, inside the workspace.",
      },
      old_str: {
        type: "string",
        description: "Exact text to replace (must be unique unless replace_all).",
      },
      new_str: { type: "string", description: 'Replacement text ("" deletes old_str).' },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match.",
      },
    },
    required: ["path", "old_str", "new_str"],
  },
  source: "builtin",
  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const pathInput = input.path;
    if (typeof pathInput !== "string" || pathInput.length === 0) {
      return toolError("invalid_input", "path must be a non-empty string");
    }
    if (typeof input.old_str !== "string" || input.old_str.length === 0) {
      return toolError("invalid_input", "old_str must be a non-empty string");
    }
    if (typeof input.new_str !== "string") {
      return toolError("invalid_input", 'new_str must be a string ("" deletes old_str)');
    }
    const flags = optionalBoolean(input.replace_all, "replace_all");
    if (!flags.ok) return toolError("invalid_input", flags.reason);
    const replaceAll = flags.value === true;
    const oldStr: string = input.old_str;
    const newStr: string = input.new_str;
    if (oldStr === newStr) {
      return toolError("invalid_input", "new_str is identical to old_str; nothing to change");
    }

    const inside = resolveInsideWorkspace(pathInput, ctx.workspaceRoot);
    if (!inside.ok) {
      return toolError(
        "invalid_input",
        `refusing to edit outside the workspace: ${inside.reason} ` +
          `(writes are restricted to the workspace root ${ctx.workspaceRoot})`,
      );
    }
    const abs = inside.path;
    const display = toDisplayPath(abs, inside.root);

    let st: Stats;
    try {
      st = statSync(abs);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        return toolError("not_found", `file not found: ${display} (edit_file cannot create files)`);
      }
      return toolError("execution_failed", `cannot stat ${display}: ${String(err)}`, true);
    }
    if (st.isDirectory()) {
      return toolError("invalid_input", `path is a directory, not a file: ${display}`);
    }
    if (!st.isFile()) {
      return toolError("invalid_input", `path is not a regular file: ${display}`);
    }

    // Hard-link hole (review minor): st_nlink > 1 means other names share
    // this inode. The atomic rename below replaces only THIS directory
    // entry, so the other links would keep the old content while this one
    // diverges — surprising enough to refuse. Cheap heuristic, not a
    // boundary: a racing link(2) after the check still slips through (see
    // the TOCTOU note below).
    if (st.nlink > 1) {
      return toolError(
        "invalid_input",
        `${display} has ${st.nlink} hard links (st_nlink > 1); ` +
          "edit_file only edits files with a single name — copy the file first " +
          "or use bash if editing a shared-inode file is intentional",
      );
    }

    // Input size cap before reading/decoding (review minor): never load an
    // unbounded file into memory just to edit it. The budget is
    // outputLimits.maxTotalChars x 4 bytes — a byte budget that roughly
    // equals the character cap for ASCII text and is stricter for multi-byte
    // scripts.
    const byteCap = ctx.outputLimits.maxTotalChars * 4;
    if (st.size > byteCap) {
      return toolError(
        "invalid_input",
        `${display} is ${st.size} bytes, over the ${byteCap}-byte edit cap ` +
          "(outputLimits.maxTotalChars x 4); edit_file refuses to load it — " +
          "edit the region with bash or raise the configured output limits",
      );
    }

    // Residual check-to-use race (TOCTOU): stat/read/validate and the write
    // below are not one atomic filesystem transaction, so a concurrent
    // writer can change the file in between. ACCEPTED at MVP: the OS sandbox
    // confines every writer to the workspace and temp dirs, so the blast
    // radius of a lost update is the workspace itself, and the atomic
    // rename guarantees the file on disk is always either the old or the new
    // content, never a torn mix.

    // Read as BYTES and validate UTF-8 strictly before touching anything:
    // the old flow decoded with a lossy UTF-8 decoder and the write
    // re-encoded the whole file, replacing every non-UTF-8 byte with U+FFFD
    // far beyond the edited region (review major 6). A file that is not
    // valid UTF-8 is now a clean rejection with the file left unchanged.
    let raw: Buffer;
    try {
      raw = readFileSync(abs);
    } catch (err) {
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot read ${display}: permission denied`);
      }
      return toolError("execution_failed", `cannot read ${display}: ${String(err)}`, true);
    }
    if (isProbablyBinary(raw)) {
      return toolError(
        "invalid_input",
        `${display} appears to be a binary file (NUL byte in the first 8 KiB); ` +
          "edit_file only edits UTF-8 text",
      );
    }
    let oldContent: string;
    try {
      oldContent = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return toolError(
        "invalid_input",
        `${display} is not valid UTF-8; edit_file only edits UTF-8 text ` +
          "(convert the file or edit it with bash if this is intentional)",
      );
    }

    const occurrences = findOccurrences(oldContent, oldStr);
    if (occurrences.length === 0) {
      const hint = findClosestMatchLine(oldContent, oldStr);
      const hintMsg = hint
        ? hint.onlyWhitespaceOrCase
          ? ` Line ${hint.line} matches except for whitespace or case: "${hint.text}".`
          : ` Closest similar line ${hint.line}: "${hint.text}".`
        : "";
      return {
        content: [],
        isError: true,
        error: {
          code: "invalid_input",
          message:
            `old_str not found in ${display}.${hintMsg} Read the region with read_file and retry ` +
            "with the exact text, including indentation.",
          retryable: false,
          details: { matchCount: 0 },
        },
      };
    }
    if (occurrences.length > 1 && !replaceAll) {
      const lineNumbers = occurrences
        .slice(0, 20)
        .map((idx) => lineNumberOf(oldContent, idx))
        .join(", ");
      const more = occurrences.length > 20 ? ", …" : "";
      return {
        content: [],
        isError: true,
        error: {
          code: "invalid_input",
          message:
            `old_str matches ${occurrences.length} locations in ${display} ` +
            `(lines ${lineNumbers}${more}). Add surrounding context to make the match unique, ` +
            "or set replace_all: true to replace every occurrence.",
          retryable: false,
          details: {
            matchCount: occurrences.length,
            lineNumbers: occurrences.slice(0, 20).map((idx) => lineNumberOf(oldContent, idx)),
          },
        },
      };
    }

    const first = occurrences[0] ?? 0;
    const newContent = replaceAll
      ? oldContent.split(oldStr).join(newStr)
      : oldContent.slice(0, first) + newStr + oldContent.slice(first + oldStr.length);

    // Atomic write (review minor): the new content goes to a sibling temp
    // file (`<name>.voidtmp.<rand>`, same directory so rename(2) stays on one
    // filesystem) and is then renamed over the target. A crash mid-write can
    // only ever leave the original intact plus a stray temp — the target is
    // never truncated. Failure paths remove the temp best-effort.
    const tmpPath = `${abs}.voidtmp.${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tmpPath, newContent, "utf8");
      renameSync(tmpPath, abs);
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort cleanup; the sandbox confines any stray temp anyway.
      }
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot write ${display}: permission denied`);
      }
      return toolError("execution_failed", `failed to write ${display}: ${String(err)}`, true);
    }

    const count = replaceAll ? occurrences.length : 1;
    const summary = `Edited ${display}: ${count} replacement${count === 1 ? "" : "s"} applied`;
    const rendered = `${summary}\n${computeUnifiedDiff(oldContent, newContent, display)}`;
    const clipped = clipToOutputLimit(rendered, ctx.outputLimits);
    return textResult(clipped.text, clipped.truncated);
  },
};
