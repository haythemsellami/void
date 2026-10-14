/**
 * Value and input matchers for the ordered-rules permission engine
 * (docs/architecture.md §permissions).
 *
 * Semantics follow `src/contracts/permissions.ts` exactly:
 *
 * - A `ValueMatcher` string is interpreted by shape:
 *   - `"/pattern/flags"` (leading + trailing slash, valid flag chars only) is a
 *     regex literal tested against string values;
 *   - a string containing glob metacharacters (`*`, `?`, `[`) is a glob
 *     (`*` = any run within one path segment, `**` = anything including `/`,
 *     `?` = one non-separator char, `[...]` / `[!...]` = character class);
 *   - `"*"` alone matches any value;
 *   - any other string is an exact match.
 * - `number`, `boolean`, `null` matchers use strict equality.
 * - An array matcher is an OR over its entries.
 * - A `Record` `InputMatchSpec` ANDs across its dotted-path entries; `"*"`
 *   matches any input.
 *
 * Zero runtime dependencies; deliberately no caching (regexes are compiled per
 * call so `g`/`y` flags can never leak `lastIndex` state between checks).
 */
import type { InputMatchSpec, ValueMatcher } from "../contracts/permissions";
import type { JsonObject, JsonValue } from "../contracts/tools";

/** Characters that switch a string matcher from exact-match to glob mode. */
const GLOB_METACHARS = /[*?[]/;

/** A regex-literal-shaped matcher: `/pattern/` with optional flag suffix. */
const REGEX_LITERAL_SHAPE = /^\/(.*)\/([dgimsuvy]*)$/s;

/** True when the string contains a glob metacharacter (`*`, `?`, `[`). */
export function isGlobPattern(value: string): boolean {
  return GLOB_METACHARS.test(value);
}

/**
 * True when the string has the `/…/flags` *shape* (regardless of whether the
 * pattern compiles). Used by `validateRules` to flag malformed regex literals;
 * matching itself uses {@link parseRegexLiteral}, which returns `undefined`
 * for non-literal or non-compiling strings.
 */
export function looksLikeRegexLiteral(value: string): boolean {
  return value.startsWith("/") && /\/[dgimsuvy]*$/.test(value) && value.length >= 2;
}

/**
 * Parse a `"/pattern/flags"` matcher string into a RegExp.
 *
 * Returns `undefined` when the string is not regex-literal-shaped (then it is
 * a glob or exact matcher) or when the pattern fails to compile (then it is a
 * malformed rule — it never matches anything and `validateRules` reports it).
 *
 * Disambiguation notes (tested in match.test.ts):
 * - `"/etc/hosts"` is NOT a regex literal — its trailing run (`hosts`) is not
 *   a valid flag sequence — so it falls through to exact-match.
 * - Pattern-internal slashes are fine because the shape regex is greedy: the
 *   last `/` before a valid flag run is the terminator.
 */
export function parseRegexLiteral(value: string): RegExp | undefined {
  const match = REGEX_LITERAL_SHAPE.exec(value);
  if (match === null) {
    return undefined;
  }
  const pattern = match[1] ?? "";
  const flags = match[2] ?? "";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

/** Escape one character for inclusion in a regex outside a character class. */
function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile a glob pattern into an anchored RegExp. Supports `*` (any run of
 * non-`/` characters), `**` (anything, including `/`), `?` (one non-`/`
 * character) and `[...]` / `[!...]` character classes. Everything else is
 * literal. The match is always anchored (full string).
 *
 * Throws `Error` on an unterminated character class — callers treat a
 * malformed glob as "never matches" and surface it via `validateRules`.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        source += "[\\S\\s]*"; // ** spans path separators too
        i += 2;
      } else {
        source += "[^/]*"; // * stays within one path segment
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const { classSource, nextIndex } = compileCharClass(glob, i);
      source += classSource;
      i = nextIndex;
      continue;
    }
    source += escapeRegexChar(ch);
    i += 1;
  }
  return new RegExp(`${source}$`);
}

/** Compile the `[...]` character class starting at `start` in `glob`. */
function compileCharClass(glob: string, start: number): { classSource: string; nextIndex: number } {
  let j = start + 1;
  let body = "";
  if (glob.charAt(j) === "!" || glob.charAt(j) === "^") {
    body = "^"; // glob negation marker becomes the regex one
    j += 1;
  }
  if (glob.charAt(j) === "]") {
    // A `]` as the first (or post-negation) class character is literal.
    body += "\\]";
    j += 1;
  }
  while (j < glob.length && glob.charAt(j) !== "]") {
    const c = glob.charAt(j);
    body += c === "\\" ? "\\\\" : c === "^" && body === "" ? "\\^" : c;
    j += 1;
  }
  if (j >= glob.length) {
    throw new Error(`unterminated character class in glob: ${glob}`);
  }
  if (body === "" || body === "^") {
    throw new Error(`empty character class in glob: ${glob}`);
  }
  return { classSource: `[${body}]`, nextIndex: j + 1 };
}

/** Narrow an unknown JSON value to a plain (non-array) object. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Match one value of a tool input against one {@link ValueMatcher}.
 *
 * `undefined` matcher means "field unconstrained" and always matches. A
 * non-string value never matches regex/glob matchers; primitives match only
 * primitives of the same type and value (strict equality).
 */
export function matchValue(
  matcher: ValueMatcher | undefined,
  value: JsonValue | undefined,
): boolean {
  if (matcher === undefined) {
    return true;
  }
  if (Array.isArray(matcher)) {
    return matcher.some((entry) => matchValue(entry, value));
  }
  if (matcher === "*") {
    return true;
  }
  if (typeof matcher === "string") {
    const asRegex = parseRegexLiteral(matcher);
    if (asRegex !== undefined) {
      return typeof value === "string" && asRegex.test(value);
    }
    if (isGlobPattern(matcher)) {
      try {
        const glob = globToRegExp(matcher);
        return typeof value === "string" && glob.test(value);
      } catch {
        return false; // malformed glob never matches; validateRules reports it
      }
    }
    return value === matcher;
  }
  return value === matcher; // number | boolean | null — strict equality
}

/** Result of an input-spec match, including which key decided it (audit trail). */
export interface InputMatchDetail {
  readonly matched: boolean;
  /** The spec key that matched or first failed; `"*"` for wildcard specs. */
  readonly key?: string;
}

/** Lookup outcome for a dotted path into a tool input object. */
interface PathLookup {
  readonly found: boolean;
  readonly value: JsonValue;
}

/**
 * Resolve a dotted path (`"file.path"`) into a nested tool input. Numeric
 * segments index arrays (`"items.0.name"`). Missing keys, non-object
 * traversal, and out-of-bounds indexes return `found: false`.
 */
function lookupPath(input: JsonObject, dottedPath: string): PathLookup {
  let current: JsonValue = input;
  for (const segment of dottedPath.split(".")) {
    if (isJsonObject(current)) {
      const next: JsonValue | undefined = current[segment];
      if (next === undefined) {
        return { found: false, value: null };
      }
      current = next;
    } else if (Array.isArray(current) && /^[0-9]+$/.test(segment)) {
      const item: JsonValue | undefined = current[Number(segment)];
      if (item === undefined) {
        return { found: false, value: null };
      }
      current = item;
    } else {
      return { found: false, value: null };
    }
  }
  return { found: true, value: current };
}

/**
 * Match an {@link InputMatchSpec} against a tool input object.
 *
 * - `"*"` matches any input.
 * - A record ANDs across its entries: every dotted path must resolve and its
 *   matcher must pass. A missing key fails the entry — unless the matcher is
 *   `undefined` (field unconstrained), in which case the entry passes.
 * - An empty record matches vacuously (every entry of zero entries passed);
 *   `validateRules` flags it as an authoring error so configs say `"*"`
 *   explicitly instead.
 */
export function matchInputDetailed(spec: InputMatchSpec, input: JsonObject): InputMatchDetail {
  if (spec === "*") {
    return { matched: true, key: "*" };
  }
  let firstKey = "*";
  for (const [key, declared] of Object.entries(spec)) {
    if (firstKey === "*") {
      firstKey = key;
    }
    // Runtime tolerance: a JS caller (or hand-edited config) may carry an
    // explicit `undefined` — defined semantics is "unconstrained".
    const matcher = declared as ValueMatcher | undefined;
    const lookup = lookupPath(input, key);
    if (!lookup.found) {
      if (matcher === undefined) {
        continue;
      }
      return { matched: false, key };
    }
    if (!matchValue(matcher, lookup.value)) {
      return { matched: false, key };
    }
  }
  return { matched: true, key: firstKey };
}

/** Boolean convenience wrapper over {@link matchInputDetailed}. */
export function matchInput(spec: InputMatchSpec, input: JsonObject): boolean {
  return matchInputDetailed(spec, input).matched;
}
