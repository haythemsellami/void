/**
 * `glob` builtin (docs/architecture.md §tools): find files by glob pattern
 * using a pure in-process walker — no shelling out, zero runtime deps.
 *
 * Pattern language: `**` (any depth, may match zero segments), `*` and `?`
 * within one segment, `{a,b}` alternation (per segment, one level of
 * nesting via recursion, expansion-capped), and `[abc]`/`[a-z]`/`[!a-z]`
 * character classes. Anything else is literal.
 *
 * Walker rules (gitignore-lite): `node_modules` and `.git` are always
 * skipped; entries starting with "." are skipped unless the pattern's first
 * segment itself starts with "."; directory symlinks are not followed
 * (cycle safety). During the walk, `.gitignore` files are honored — a
 * documented SUBSET of git semantics: simple per-segment globs (`*`, `?`,
 * `[...]`), `!` negation (last matching rule wins), trailing-`/` for
 * directory-only patterns, and slash-anchored patterns tied to the
 * .gitignore's own directory. NOT supported: `**` inside ignore patterns,
 * backslash escapes, per-rule `[attr]` macros, and git's re-include
 * exception — an ignored directory is never descended into, so `!` cannot
 * rescue files inside one. Results are sorted fewest-path-segments first,
 * then lexicographically, capped with an explicit truncation marker, and
 * directories are suffixed with `/` (consistent with read_file's listings).
 */

import type { Dirent, Stats } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ToolContext, ToolInput, ToolResult, ToolSpec } from "../contracts/tools";
import {
  clipToOutputLimit,
  errnoCode,
  resolveInputPath,
  textResult,
  toDisplayPath,
  toolError,
} from "./paths";

/** Hard cap on returned paths; longer result sets are truncated with a marker. */
export const MAX_GLOB_RESULTS = 500;

/* ------------------------------------------------------------- translator */

/** Escape a literal char for use in a RegExp body (metacharacters only). */
function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** Translate one bracket expression `[...]` starting at `i`; null if unclosed. */
function translateCharClass(seg: string, i: number): { src: string; next: number } | null {
  // seg[i] === "["
  let j = i + 1;
  let negated = false;
  if (seg[j] === "!" || seg[j] === "^") {
    negated = true;
    j++;
  }
  let body = "";
  let closed = false;
  for (; j < seg.length; j++) {
    const c = seg[j];
    if (c === "]" && body !== "") {
      closed = true;
      j++;
      break;
    }
    if (c === "\\") body += "\\\\";
    else if (c === "]") body += "\\]";
    else if (c === "[") body += "\\[";
    else if (c === "^" && body !== "") body += "\\^";
    else body += c;
  }
  if (!closed) return null;
  return { src: `[${negated ? "^" : ""}${body}]`, next: j };
}

const BRACE_MAX_ALTERNATIVES = 16;
const BRACE_MAX_DEPTH = 3;

/**
 * Translate one path segment to a RegExp fragment (no separators inside).
 * Handles braces by expanding `{a,b}` alternatives recursively; `*`, `?`,
 * and `[...]` are translated per-char. Returns null when the pattern is
 * unsupported (unbalanced brackets/braces, expansion overflow).
 */
function translateSegment(seg: string, depth: number): string | null {
  const open = findTopLevelBrace(seg);
  if (open !== null) {
    const { start, end, alts } = open;
    if (alts === null || alts.length > BRACE_MAX_ALTERNATIVES || depth >= BRACE_MAX_DEPTH) {
      return null;
    }
    const prefix = seg.slice(0, start);
    const suffix = seg.slice(end + 1);
    const parts: string[] = [];
    for (const alt of alts) {
      const part = translateSegment(`${prefix}${alt}${suffix}`, depth + 1);
      if (part === null) return null;
      parts.push(part);
    }
    return `(?:${parts.join("|")})`;
  }

  let out = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i] ?? "";
    if (c === "*") {
      out += "[^/]*";
      i++;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      const cls = translateCharClass(seg, i);
      if (cls === null) {
        out += "\\[";
        i++;
      } else {
        out += cls.src;
        i = cls.next;
      }
    } else {
      out += escapeRegexChar(c);
      i++;
    }
  }
  return out;
}

interface TopLevelBrace {
  readonly start: number;
  readonly end: number;
  readonly alts: readonly string[] | null;
}

/** Find the first non-nested `{a,b}` group in a segment; null when absent. */
function findTopLevelBrace(seg: string): TopLevelBrace | null {
  const start = seg.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let sawComma = false;
  for (let i = start; i < seg.length; i++) {
    const c = seg[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return { start, end: -1, alts: null };
    }
  }
  if (end === -1) return { start, end: -1, alts: null };
  // Split the inner text on top-level commas; nested braces stay whole.
  const inner = seg.slice(start + 1, end);
  const alts: string[] = [];
  let cur = "";
  let d = 0;
  for (const c of inner) {
    if (c === "{") d++;
    if (c === "}") d--;
    if (c === "," && d === 0) {
      alts.push(cur);
      cur = "";
      sawComma = true;
    } else {
      cur += c;
    }
  }
  alts.push(cur);
  if (!sawComma || alts.some((a) => a === "")) return { start, end: -1, alts: null };
  return { start, end, alts };
}

/** Strip "./" and leading "/" prefixes so patterns are root-relative. */
export function normalizeGlobPattern(pattern: string): string {
  let p = pattern;
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

/**
 * Compile a glob pattern into an anchored RegExp over POSIX-style relative
 * paths. Returns null for unsupported/invalid patterns. Exported for tests
 * and the translator matrix.
 */
export function globToRegExp(pattern: string): RegExp | null {
  if (pattern.includes("\0")) return null;
  const p = normalizeGlobPattern(pattern);
  if (p === "") return null;

  const segs = p.split("/");
  let out = "";
  let first = true;
  // Set after a non-last "**" (it already emitted its trailing separator);
  // a last "**" emits its own leading separator instead.
  let afterGlobstar = false;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k] ?? "";
    const isLast = k === segs.length - 1;
    if (seg === "**") {
      if (first && isLast) out += ".*";
      else if (first) out += "(?:.*/)?";
      else if (isLast) out += "(?:/.*)?";
      else out += "/(?:.*/)?";
      afterGlobstar = !isLast;
      first = false;
      continue;
    }
    if (seg === "") return null; // "//" or trailing "/" — reject
    const lit = translateSegment(seg, 0);
    if (lit === null) return null;
    if (!first && !afterGlobstar) out += "/";
    out += lit;
    afterGlobstar = false;
    first = false;
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- walker */

const ALWAYS_SKIP = new Set(["node_modules", ".git"]);

/* ------------------------------------------------------- gitignore (lite) */

/** One parsed `.gitignore` line. */
interface IgnoreRule {
  /** Started with `!`: re-includes instead of ignores (last match wins). */
  readonly negated: boolean;
  /** Ended with `/`: matches directories only. */
  readonly dirOnly: boolean;
  /** Had a leading or interior `/`: tied to the owning .gitignore's dir. */
  readonly anchored: boolean;
  /** Absolute directory of the .gitignore this rule came from. */
  readonly base: string;
  /** Anchored: `^seg/seg$`. Unanchored: matches any path-suffix at a segment boundary. */
  readonly source: RegExp;
}

/**
 * Compile one ignore pattern body (no `!`, trailing `/` handled) into a
 * RegExp, or null when it uses something outside the documented subset
 * (the rule is then skipped, never fatal). `**` is treated as two `*`s —
 * i.e. within-segment only — which is the documented subset limitation.
 */
function compileIgnorePattern(body: string, anchored: boolean): RegExp | null {
  const segs = body.split("/");
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg === "") return null; // "//" or a stray separator: unsupported shape
    const lit = translateSegment(seg, 0);
    if (lit === null) return null;
    parts.push(lit);
  }
  const joined = parts.join("/");
  return anchored ? new RegExp(`^${joined}$`) : new RegExp(`^(?:.*/)?${joined}$`);
}

/** Parse a .gitignore body into rules (comments/blanks skipped, subset only). */
function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    let body = line;
    if (body.startsWith("!")) {
      negated = true;
      body = body.slice(1);
    }
    if (body === "") continue;
    let dirOnly = false;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (body === "") continue;
    const anchored = body.startsWith("/") || body.includes("/");
    const source = compileIgnorePattern(body.replace(/^\//, ""), anchored);
    if (source === null) continue; // outside the subset: rule ignored
    rules.push({ negated, dirOnly, anchored, base, source });
  }
  return rules;
}

/**
 * Last-match-wins ignore decision for one candidate, evaluating inherited
 * rules shallow-to-deep and file order within each .gitignore.
 */
function isIgnoredBy(
  rules: readonly IgnoreRule[],
  abs: string,
  relToRoot: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const rel = rule.anchored ? relFromBase(rule.base, abs) : relToRoot;
    if (rel === null) continue;
    if (rule.source.test(rel)) ignored = !rule.negated;
  }
  return ignored;
}

/** Path of `abs` relative to `base` (posix separators); null when not inside. */
function relFromBase(base: string, abs: string): string | null {
  const rel = relative(base, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/** Read one .gitignore, returning rules (empty when missing/unreadable). */
function readIgnoreRules(dir: string): IgnoreRule[] {
  try {
    return parseIgnoreFile(readFileSync(join(dir, ".gitignore"), "utf8"), dir);
  } catch {
    return [];
  }
}

/** Detailed walk result: every listed path plus which of them are directories. */
export interface WalkResult {
  readonly paths: string[];
  readonly dirs: ReadonlySet<string>;
}

/**
 * Walk `root` depth-first without following directory symlinks, collecting
 * POSIX-style paths relative to `root` and honoring `.gitignore` files
 * along the way (documented subset — see the module header). `allowDot`
 * keeps dot-entries (still skipping node_modules/.git) for patterns like
 * ".github/**"; `.gitignore` files are always READ for rules even when not
 * listed. Unreadable subdirectories are skipped; an unreadable root throws.
 */
export function walkTreeDetailed(root: string, allowDot: boolean): WalkResult {
  const paths: string[] = [];
  const dirs = new Set<string>();
  const stack: Array<{ dir: string; rules: readonly IgnoreRule[] }> = [
    { dir: root, rules: readIgnoreRules(root) },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    const { dir, rules } = frame;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subdir: skip, keep walking
    }
    for (const entry of entries) {
      const name = entry.name;
      if (ALWAYS_SKIP.has(name)) continue;
      if (!allowDot && name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (rel.startsWith("..")) continue; // defensive; join/relative stay inside
      const relPosix = rel.split("\\").join("/");
      const isDir = entry.isDirectory();
      if (isIgnoredBy(rules, abs, relPosix, isDir)) continue; // ignored: skip, no descent
      paths.push(relPosix);
      if (isDir) {
        dirs.add(relPosix);
        // An ignored directory is never descended into — the documented
        // subset keeps git's "no re-include inside an ignored dir" stance.
        stack.push({ dir: abs, rules: [...rules, ...readIgnoreRules(abs)] });
      }
      // Symlinks are listed as entries but never descended into.
    }
  }
  return { paths, dirs };
}

/** Plain-path walker (no dir suffixes) — the legacy view of {@link walkTreeDetailed}. */
export function walkTree(root: string, allowDot: boolean): string[] {
  return walkTreeDetailed(root, allowDot).paths;
}

function comparePaths(a: string, b: string): number {
  const depthDiff = a.split("/").length - b.split("/").length;
  if (depthDiff !== 0) return depthDiff;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when the pattern's first segment is a dot-segment (hidden lookup). */
function patternAllowsDot(pattern: string): boolean {
  const firstSeg = normalizeGlobPattern(pattern).split("/")[0] ?? "";
  return firstSeg.startsWith(".");
}

/* ---------------------------------------------------------------- the tool */

/** The glob ToolSpec the engine registers (`tools/` registry, M3). */
export const globTool: ToolSpec = {
  name: "glob",
  description:
    "Find files by glob pattern and list matching paths, searched from the " +
    "workspace root or from path when given. Patterns support ** (any " +
    "depth, including zero), * and ? within one segment, {a,b} alternation " +
    "and [abc]/[a-z]/[!a-z] classes. The in-process walker always skips " +
    "node_modules and .git, honors .gitignore files (a documented subset: " +
    "simple globs, ! negation, trailing-/ dir-only — no ** in ignore " +
    "patterns), and skips hidden dot-entries unless the pattern itself " +
    "starts with a dot segment (e.g. .github/**). Directories are listed " +
    "with a trailing /. Results are sorted by path depth then name, and " +
    "capped with a truncation marker. Use glob to find files by name and " +
    "grep to find content.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern relative to the search root, e.g. "src/**/*.ts".',
      },
      path: {
        type: "string",
        description: "Directory to search (default: the workspace root).",
      },
    },
    required: ["pattern"],
  },
  source: "builtin",
  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return toolError("invalid_input", "pattern must be a non-empty string");
    }
    const rootInput = input.path;
    let root: string;
    if (rootInput === undefined) {
      root = ctx.workspaceRoot;
    } else if (typeof rootInput === "string" && rootInput.length > 0) {
      root = resolveInputPath(rootInput, ctx.workspaceRoot);
    } else {
      return toolError("invalid_input", "path must be a non-empty string when given");
    }
    const display = toDisplayPath(root, ctx.workspaceRoot);

    let st: Stats;
    try {
      st = statSync(root);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        return toolError("not_found", `search root not found: ${display}`);
      }
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot access ${display}: permission denied`);
      }
      return toolError("execution_failed", `cannot stat ${display}: ${String(err)}`, true);
    }
    if (!st.isDirectory()) {
      return toolError("invalid_input", `search root must be a directory, got a file: ${display}`);
    }

    const re = globToRegExp(pattern);
    if (re === null) {
      return toolError(
        "invalid_input",
        `invalid or unsupported glob pattern: "${pattern}" (supported: **, *, ?, {a,b}, [class])`,
      );
    }

    let walked: WalkResult;
    try {
      walked = walkTreeDetailed(root, patternAllowsDot(pattern));
    } catch (err) {
      if (errnoCode(err) === "EACCES" || errnoCode(err) === "EPERM") {
        return toolError("permission_denied", `cannot list ${display}: permission denied`);
      }
      return toolError("execution_failed", `failed to walk ${display}: ${String(err)}`, true);
    }

    const matches = walked.paths.filter((rel) => re.test(rel)).sort(comparePaths);
    const capped = matches.slice(0, MAX_GLOB_RESULTS);
    // Directories render with a trailing / (consistent with read_file's
    // directory listings) so they are distinguishable from files.
    const rendered = capped.map((rel) => (walked.dirs.has(rel) ? `${rel}/` : rel));
    const scope = root === ctx.workspaceRoot ? "" : ` under ${display}`;
    const countLabel =
      capped.length === 0 ? "No paths" : `${capped.length} path${capped.length === 1 ? "" : "s"}`;
    const out: string[] = [`${countLabel} matched "${pattern}"${scope}`];
    out.push(...rendered);
    let truncated = false;
    if (matches.length > capped.length) {
      out.push(
        `… results capped at ${MAX_GLOB_RESULTS}; ${matches.length - capped.length} more omitted`,
      );
      truncated = true;
    }
    const clipped = clipToOutputLimit(out.join("\n"), ctx.outputLimits);
    return textResult(clipped.text, truncated || clipped.truncated);
  },
};
