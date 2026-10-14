/**
 * `src/settings/discover` — settings file discovery (ADR-0006).
 *
 * Two layers:
 *
 * - **user**: `<dir>/void/settings.json` where `<dir>` is `$XDG_CONFIG_HOME`
 *   (only when absolute, per the XDG spec — same rule as `store/dataDir.ts`)
 *   or `~/.config`. JSONC is supported everywhere: when the JSON file is
 *   absent but `settings.jsonc` exists, that is the file (the loader logs an
 *   info line for the fallback).
 * - **workspace**: `.void/settings.json` or `.void/settings.jsonc`, found by
 *   walking cwd up to — and including — the first ancestor containing `.git`
 *   (a worktree's `.git` file counts), or to the filesystem root when no git
 *   root exists — the exact walk semantics of `src/context/agents-md.ts`.
 *
 * JSON beats JSONC: when BOTH `settings.json` and `settings.jsonc` exist in
 * the same directory, JSON wins and JSONC is ignored (ADR-0006 amendment).
 * A malformed file is never skipped in favor of the other syntax or an
 * ancestor's file — discovery reports what it found; the LOADER fails loud
 * on it (malformed files are loud, never silent-fallback).
 *
 * Discovery is pure filesystem probing: existence checks only, no reading,
 * no validation. All I/O seams are injectable for tests.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The directory name workspace settings live in (`.void/settings.json*`). */
export const WORKSPACE_SETTINGS_DIR = ".void";

/** File base names per directory, in priority order: JSON wins over JSONC. */
const SETTINGS_FILE_NAMES: readonly { readonly name: string; readonly format: "json" | "jsonc" }[] =
  [
    { name: "settings.json", format: "json" },
    { name: "settings.jsonc", format: "jsonc" },
  ];

/** One located settings file. */
export interface FoundSettingsFile {
  /** Absolute path of the file that exists and was chosen. */
  readonly path: string;
  /** Syntax of the chosen file. */
  readonly format: "json" | "jsonc";
  /** True when the JSONC fallback engaged (settings.json absent). */
  readonly jsoncFallback: boolean;
}

/** Injectability seams (tests); defaults touch the real filesystem. */
export interface DiscoverOptions {
  /** Existence probe; default `node:fs` existsSync. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Resolve the user-scope settings DIRECTORY (not file): `$XDG_CONFIG_HOME/void`
 * when XDG_CONFIG_HOME is set AND absolute (XDG spec: non-absolute values are
 * ignored), else `$HOME/.config/void`, else `homedir()/.config/void`. Mirrors
 * `store/dataDir.ts` precedence so config and data live by one convention.
 */
export function userSettingsDir(
  env: Readonly<Record<string, string | undefined>> = {},
  home: () => string = homedir,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return resolve(xdg, "void");
  }
  const homeDir = env.HOME?.trim();
  const base = homeDir !== undefined && homeDir !== "" ? homeDir : home();
  return resolve(base, ".config", "void");
}

/** Probe one directory for a settings file: JSON first, JSONC fallback. */
function probeDir(dir: string, exists: (path: string) => boolean): FoundSettingsFile | undefined {
  for (const candidate of SETTINGS_FILE_NAMES) {
    const path = join(dir, candidate.name);
    if (exists(path)) {
      return { path, format: candidate.format, jsoncFallback: candidate.format === "jsonc" };
    }
  }
  return undefined;
}

/**
 * The user-scope settings file, or undefined when neither syntax exists.
 * (When absent, callers report the JSON path as the canonical would-be
 * location — that is the file `void settings edit` creates.)
 */
export function findUserSettingsFile(
  env: Readonly<Record<string, string | undefined>> = {},
  options: DiscoverOptions = {},
): FoundSettingsFile | undefined {
  const exists = options.exists ?? existsSync;
  return probeDir(userSettingsDir(env), exists);
}

/**
 * Ancestor chain of `startDir` (inclusive), deepest first — the same walk as
 * `context/agents-md.ts`: STOPS at, and includes, the first ancestor with a
 * `.git` entry (directory or worktree file); without any `.git` the walk
 * continues to the filesystem root (ADR-0006 amendment: match AGENTS.md
 * semantics). An unreadable probe counts as absent (never fatal).
 */
function ancestorChain(startDir: string, exists: (path: string) => boolean): string[] {
  let current: string;
  try {
    current = realpathSync(startDir);
  } catch {
    current = resolve(startDir);
  }
  const chain: string[] = [];
  for (;;) {
    chain.push(current);
    if (exists(join(current, ".git"))) {
      return chain; // `current` is the git root: nothing above it is admitted
    }
    const parent = dirname(current);
    if (parent === current) {
      return chain; // filesystem root without a git root: documented fallback
    }
    current = parent;
  }
}

/**
 * The workspace-scope settings file, or undefined when no level has one.
 * The walk is deepest-first: the first directory on the cwd-to-git-root chain
 * containing `.void/settings.json` (preferred) or `.void/settings.jsonc`
 * (fallback) wins — deepest is most specific. Existence alone decides; a
 * malformed found file is the loader's loud error, never walked past.
 */
export function findWorkspaceSettingsFile(
  startDir: string,
  options: DiscoverOptions = {},
): FoundSettingsFile | undefined {
  const exists = options.exists ?? existsSync;
  for (const dir of ancestorChain(startDir, exists)) {
    const found = probeDir(join(dir, WORKSPACE_SETTINGS_DIR), exists);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
