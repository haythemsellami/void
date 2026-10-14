/**
 * `src/context/agents-md` — AGENTS.md discovery and concatenation
 * (docs/architecture.md §context).
 *
 * Walks from the start directory (the workspace root) up to — and
 * including — the first ancestor that contains a `.git` directory-or-file
 * (a git worktree's `.git` file counts). Instructions from OUTSIDE the
 * project's git root are not admitted (review minor: the walk used to
 * climb to the filesystem root, contradicting the documented cwd ->
 * git-root intent and pulling in instructions from unrelated directories
 * above the checkout). When no `.git` exists on the chain (the workspace
 * is not inside any checkout), the walk continues to the filesystem root —
 * documented fallback, so bare directories still collect their chain.
 *
 * At each level both `AGENTS.md` and `.agents/AGENTS.md` are collected when
 * present (`AGENTS.md` first). Unreadable directories/files are skipped,
 * not fatal: an agent must still run when one ancestor denies reads.
 *
 * MVP semantics (deliberate simplifications, see mvp-scope.md):
 * - YAML frontmatter is parsed-and-ignored: a leading `---` block is
 *   stripped, its `globs` conditional inclusion is NOT evaluated (fast-follow).
 * - Files are included unconditionally, deepest last (deepest = most specific
 *   instructions, so they read as taking precedence).
 * - Total size is capped (default 64 KiB) with an explicit truncation note.
 *
 * Path-traversal safety: no caller-supplied file names ever reach the
 * filesystem — only the fixed names `AGENTS.md` / `.agents/AGENTS.md` under
 * the ancestors of the (realpath'd) start directory. The start directory
 * itself comes from the CLI's `--workspace` resolution, never from model
 * output.
 */
import { Buffer } from "node:buffer";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Default cap on the concatenated AGENTS.md context, in bytes. */
export const DEFAULT_AGENTS_MAX_BYTES = 64 * 1024;

/** Minimum remaining budget (bytes) below which a partial file is not worth including. */
const MIN_PARTIAL_FILE_BYTES = 512;

/** Fixed candidate names per directory level, in collection order. */
const LEVEL_FILE_NAMES: readonly string[] = ["AGENTS.md", join(".agents", "AGENTS.md")];

/** Result of {@link collectAgentsContext}. */
export interface AgentsContext {
  /** Concatenated, per-file-headered text; empty string when nothing was found. */
  readonly text: string;
  /** Included files in output order (shallowest first, deepest last). */
  readonly files: readonly string[];
  /** True when the byte cap dropped one or more discovered files (or file tails). */
  readonly truncated: boolean;
  /** Files discovered but omitted by the cap, in discovery (deepest-first) order. */
  readonly omitted: readonly string[];
}

export interface CollectAgentsOptions {
  /** Total byte cap; default {@link DEFAULT_AGENTS_MAX_BYTES}. */
  readonly maxTotalBytes?: number;
  /** Read seam for tests; defaults to `node:fs/promises` readFile(utf8). */
  readonly readFile?: (path: string) => Promise<string>;
}

interface DiscoveredFile {
  readonly path: string;
  readonly body: string;
  /** Ancestor level: 0 = start dir (deepest), +1 per step toward `/`. */
  readonly depth: number;
}

/**
 * Discover, strip, order, and cap the AGENTS.md chain for `startDir`.
 * Never throws for a missing/unreadable file or directory — those levels
 * simply contribute nothing.
 */
export async function collectAgentsContext(
  startDir: string,
  options: CollectAgentsOptions = {},
): Promise<AgentsContext> {
  const cap = options.maxTotalBytes ?? DEFAULT_AGENTS_MAX_BYTES;
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));

  const discovered = await discoverFiles(startDir, read); // deepest-first, level-grouped
  const included: DiscoveredFile[] = [];
  const omitted: string[] = [];
  let truncated = false;
  let used = 0;

  // Budget is spent deepest-first (most specific files survive the cap)…
  for (const file of discovered.flat()) {
    const size = byteLength(file.body);
    if (used + size <= cap) {
      included.push(file);
      used += size;
      continue;
    }
    truncated = true;
    const remaining = cap - used;
    if (remaining >= MIN_PARTIAL_FILE_BYTES) {
      included.push({ ...file, body: cutToBytes(file.body, remaining) });
      used = cap;
    }
    omitted.push(file.path);
  }

  // …but output is shallowest-first so the deepest file reads last (most
  // specific instructions take precedence in the concatenated context).
  // Stable sort keeps the per-level name order (AGENTS.md before .agents/).
  const ordered = [...included].sort((a, b) => b.depth - a.depth);

  const files = ordered.map((file) => file.path);
  const sections = ordered.map((file) => headerFor(file.path, file.body));
  if (truncated) {
    sections.push(
      `<!-- void: AGENTS.md context truncated at ${cap} bytes; omitted ${omitted.length} ` +
        `further file(s): ${omitted.join(", ")} -->`,
    );
  }
  return {
    text: sections.length === 0 ? "" : `${sections.join("\n\n")}\n`,
    files,
    truncated,
    omitted,
  };
}

/**
 * Ancestor chain of `startDir` (inclusive), deepest first. The chain STOPS
 * at — and includes — the first ancestor containing a `.git` entry
 * (directory for normal checkouts, file for git worktrees); without any
 * `.git` on the way up it ends at the filesystem root (documented
 * fallback). An unreadable `.git` probe counts as absent (never fatal).
 */
function ancestorChain(startDir: string): string[] {
  let current: string;
  try {
    current = realpathSync(startDir);
  } catch {
    current = resolve(startDir);
  }
  const chain: string[] = [];
  for (;;) {
    chain.push(current);
    if (existsSync(join(current, ".git"))) {
      return chain; // `current` is the git root: nothing above it is admitted
    }
    const parent = dirname(current);
    if (parent === current) {
      return chain; // reached the filesystem root without a git root
    }
    current = parent;
  }
}

/**
 * Read every existing AGENTS.md / .agents/AGENTS.md on the chain, grouped per
 * directory level, deepest level first; within a level `AGENTS.md` precedes
 * `.agents/AGENTS.md`.
 */
async function discoverFiles(
  startDir: string,
  read: (path: string) => Promise<string>,
): Promise<DiscoveredFile[][]> {
  const levels: DiscoveredFile[][] = [];
  const chain = ancestorChain(startDir); // index 0 = deepest
  for (let i = 0; i < chain.length; i += 1) {
    const dir = chain[i];
    if (dir === undefined) {
      continue;
    }
    const found: DiscoveredFile[] = [];
    for (const name of LEVEL_FILE_NAMES) {
      const path = join(dir, name);
      const body = await tryRead(path, read);
      if (body !== undefined) {
        found.push({ path, body: stripFrontmatter(body), depth: i });
      }
    }
    if (found.length > 0) {
      levels.push(found);
    }
  }
  return levels;
}

/** Read one file; undefined when missing or unreadable (never fatal). */
async function tryRead(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return await read(path);
  } catch {
    return undefined;
  }
}

/**
 * Remove a YAML frontmatter block: a first line of exactly `---` up to the
 * next `---` line. Parsed-and-ignored at MVP (the `globs` conditional is a
 * documented fast-follow); a missing closing fence leaves the text intact.
 */
export function stripFrontmatter(text: string): string {
  const leading = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (leading === null) {
    return text;
  }
  const afterOpen = text.slice(leading[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(afterOpen);
  if (close === null) {
    return text; // unterminated frontmatter: treat the whole file as body
  }
  return afterOpen.slice((close.index ?? 0) + close[0].length).replace(/^\r?\n/, "");
}

/** Per-file section with a stable header naming the absolute path. */
function headerFor(path: string, body: string): string {
  const trimmed = body.trim();
  return `# AGENTS.md — ${path}\n\n${trimmed}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Longest string prefix whose UTF-8 byte length is <= budget. */
function cutToBytes(text: string, budget: number): string {
  const exact = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // A byte-budgeted cut can split a code point; trim the replacement char it produces.
  return exact.endsWith("\uFFFD") ? exact.slice(0, -1) : exact;
}
