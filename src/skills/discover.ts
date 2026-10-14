/**
 * `src/skills/discover` — skill discovery across the ADR-0012 roots
 * (in order, FIRST WINS per name):
 *
 *  1. workspace: `.agents/skills/` and `skills/` subdirectory roots, found by
 *     walking from the workspace root up to — and including — the first
 *     ancestor containing `.git` (a worktree's `.git` file counts; without a
 *     git root the walk continues to the filesystem root). Per ancestor level
 *     (deepest first — deepest is most specific, the same direction as the
 *     settings and AGENTS.md walks) `.agents/skills` precedes `skills`.
 *  2. user: `<user config dir>/skills` where the config dir is resolved with
 *     the exact `settings/discover.ts` XDG rule (reused, not reimplemented:
 *     `$XDG_CONFIG_HOME/void/skills` when absolute, else `$HOME/.config/void/skills`).
 *  3. every entry of the settings `skills.path` string: colon-separated root
 *     directories, `~`-expanded, relative entries resolved against the
 *     workspace root, in order.
 *
 * A root's immediate subdirectories are skill candidates; a candidate counts
 * when it contains `SKILL.md` or `skill.md` (upper-case file wins when both
 * exist). Subdirectories are scanned in name order for determinism. The
 * skill's `name` comes from the FRONTMATTER, never the directory name.
 *
 * Failure policy (settings posture, ADR-0012 "loud, never silently load"):
 * a candidate that exists but is unreadable, oversized, or invalid produces a
 * structured {@link SkillProblem} (file + key + problem) and is excluded from
 * the valid list; callers turn any problem into a loud failure. A LATER
 * candidate whose name already appeared earlier is shadowed (excluded,
 * recorded in `shadowed` — not an error: shadowing is the documented
 * first-wins semantics). Missing roots are never fatal.
 *
 * NOTE: `ancestorChain` below is the third cwd-to-git-root walk in the
 * codebase (`context/agents-md.ts`, `settings/discover.ts`, here). Kept
 * deliberately consistent with both (same stop-at-git-root semantics,
 * realpath-then-resolve fallback); consolidating the three into one shared
 * walker is a recorded follow-up — not done in this workstream to avoid
 * churning the other components' territory.
 *
 * Pure and fully injectable: every filesystem touch is a seam, mirroring
 * `settings/load.ts` (async reads, sync existence probes).
 */
import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userSettingsDir } from "../settings/discover";
import type { SkillParseProblem } from "./validate";
import { MAX_SKILL_BYTES, parseSkillDocument, skillByteLength } from "./validate";

/** Workspace skill-root directory names, in per-level priority order. */
const WORKSPACE_SKILL_DIRS: readonly string[] = [join(".agents", "skills"), "skills"];

/** Candidate skill file names, in priority order (upper-case wins). */
const SKILL_FILE_NAMES: readonly string[] = ["SKILL.md", "skill.md"];

/** Minimal directory-entry shape the seams exchange (easy to fake in tests). */
export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** True for regular files (symlinks are neither files nor directories here). */
  readonly isFile: boolean;
}

/** Injectability seams (tests); defaults touch the real filesystem. */
export interface SkillsFsSeams {
  /** Existence probe; default `node:fs` existsSync. */
  readonly exists?: (path: string) => boolean;
  /** Directory listing; default `node:fs/promises` readdir(withFileTypes). */
  readonly readDir?: (path: string) => Promise<readonly DirEntry[]>;
  /** Read seam; default `node:fs/promises` readFile(utf8). */
  readonly readFile?: (path: string) => Promise<string>;
}

/** Where one skills root came from (ADR-0012 discovery tiers). */
export type SkillSource = "workspace" | "user" | "settings-path";

/** One scanned skills root, in first-wins order. */
export interface SkillsRoot {
  readonly kind: SkillSource;
  /** Human label for listings (`.agents/skills`, `skills`, `user`, `skills.path[i]`). */
  readonly label: string;
  /** Absolute root directory. */
  readonly path: string;
  /** False when a configured root directory does not exist (informational). */
  readonly found: boolean;
}

/** One structured problem with a discovered skill candidate. */
export interface SkillProblem {
  /** The SKILL.md file the problem was found in. */
  readonly path: string;
  /** Frontmatter key, `(frontmatter)`, `(body)`, or `(file)`. */
  readonly key: string;
  readonly message: string;
}

/** One valid, first-wins skill. */
export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  /** The instruction payload (loaded lazily by the `skill` tool, not the prompt). */
  readonly body: string;
  /** Absolute path of the SKILL.md file. */
  readonly path: string;
  /** Absolute path of the containing skill directory. */
  readonly dir: string;
  /** Which discovery tier supplied this skill. */
  readonly source: SkillSource;
}

/** A later candidate whose name was already taken by an earlier root. */
export interface ShadowedSkill {
  readonly name: string;
  readonly path: string;
}

/**
 * One discovered candidate that FAILED validation (or could not be read).
 * Never loadable; the `problems` list carries the same information keyed for
 * loud failure reporting, while `name` (when it parsed) lets callers — e.g.
 * the `skill` tool — match an by-now-invalid skill BY NAME so their error
 * names the file and key instead of a bare not-found.
 */
export interface InvalidSkill {
  /** Absolute path of the SKILL.md file. */
  readonly path: string;
  /** The frontmatter name when it parsed and was non-empty. */
  readonly name?: string;
  readonly problems: readonly SkillProblem[];
}

/** Everything {@link discoverSkills} learned in one pass. */
export interface SkillsDiscoveryResult {
  /** Valid skills in first-wins discovery order (name-unique). */
  readonly skills: readonly DiscoveredSkill[];
  /** Empty when every discovered candidate is valid; any entry is a loud failure. */
  readonly problems: readonly SkillProblem[];
  /** Later same-name duplicates excluded by first-wins (observability). */
  readonly shadowed: readonly ShadowedSkill[];
  /** Discovered-but-invalid candidates, in discovery order (same facts as `problems`). */
  readonly invalid: readonly InvalidSkill[];
  /** Every root considered, in order, including missing-but-configured ones. */
  readonly roots: readonly SkillsRoot[];
}

/** Discovery inputs; the same options object later drives the lazy tools. */
export interface DiscoverSkillsOptions {
  /** Workspace root: walk start for the workspace tier and base for relative `skills.path` entries. */
  readonly workspaceRoot: string;
  /** Environment for XDG/HOME resolution and `~` expansion in `skills.path`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The settings `skills.path` value: colon-separated root directories. */
  readonly skillsPath?: string;
  /** Injectability seams; each falls back to the real filesystem. */
  readonly fs?: SkillsFsSeams;
}

interface ResolvedSeams {
  readonly exists: (path: string) => boolean;
  readonly readDir: (path: string) => Promise<readonly DirEntry[]>;
  readonly readFile: (path: string) => Promise<string>;
}

async function defaultReadDir(path: string): Promise<readonly DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  // readdir Dirents carry lstat semantics: a symlink reports neither
  // isDirectory nor isFile — symlinks therefore match nothing downstream
  // and are skipped everywhere (never followed, never listed).
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  }));
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

function resolveSeams(fs?: SkillsFsSeams): ResolvedSeams {
  return {
    exists: fs?.exists ?? existsSync,
    readDir: fs?.readDir ?? defaultReadDir,
    readFile: fs?.readFile ?? defaultReadFile,
  };
}

/**
 * Ancestor chain of `startDir` (inclusive), deepest first — the same walk as
 * `context/agents-md.ts` and `settings/discover.ts`: stops at, and includes,
 * the first ancestor with a `.git` entry; without one it ends at the
 * filesystem root. An unreadable probe counts as absent (never fatal).
 * (Third instance; see the module note about the consolidation candidate.)
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
      return chain;
    }
    const parent = dirname(current);
    if (parent === current) {
      return chain;
    }
    current = parent;
  }
}

/** Expand a leading `~` (`~` or `~/…`) to the home directory; else unchanged. */
export function expandTilde(
  entry: string,
  env: Readonly<Record<string, string | undefined>> = {},
  home: () => string = homedir,
): string {
  if (entry === "~") {
    return homeDir(env, home);
  }
  if (entry.startsWith("~/")) {
    return join(homeDir(env, home), entry.slice(2));
  }
  return entry;
}

function homeDir(env: Readonly<Record<string, string | undefined>>, home: () => string): string {
  const fromEnv = env.HOME?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : home();
}

/**
 * Enumerate every skills root in first-wins order. Workspace roots are only
 * listed when they exist (the walk may cross several ancestors); the user
 * root and `skills.path` entries are always listed — with `found: false`
 * when absent — because they are explicitly configured locations the user
 * should see in `void skills list`.
 */
function enumerateRoots(
  options: DiscoverSkillsOptions,
  exists: (p: string) => boolean,
): SkillsRoot[] {
  const env = options.env ?? {};
  const roots: SkillsRoot[] = [];

  for (const dir of ancestorChain(options.workspaceRoot, exists)) {
    for (const sub of WORKSPACE_SKILL_DIRS) {
      const path = join(dir, sub);
      if (exists(path)) {
        roots.push({ kind: "workspace", label: sub, path, found: true });
      }
    }
  }

  const userPath = join(userSettingsDir(env), "skills");
  roots.push({ kind: "user", label: "user", path: userPath, found: exists(userPath) });

  const raw = options.skillsPath;
  if (raw !== undefined) {
    let index = 0;
    for (const entryRaw of raw.split(":")) {
      const entry = expandTilde(entryRaw.trim(), env);
      if (entry === "") {
        continue; // empty colon segments ("a::b") contribute nothing
      }
      const path = isAbsolute(entry) ? resolve(entry) : resolve(options.workspaceRoot, entry);
      roots.push({
        kind: "settings-path",
        label: `skills.path[${index}]`,
        path,
        found: exists(path),
      });
      index += 1;
    }
  }
  return roots;
}

/** List one directory's entries sorted by name; empty when unreadable/missing. */
async function listSorted(
  dir: string,
  readDir: (path: string) => Promise<readonly DirEntry[]>,
): Promise<readonly DirEntry[]> {
  try {
    const entries = await readDir(dir);
    return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return []; // unreadable root: skip, never fatal (settings posture)
  }
}

/** The skill file inside a candidate directory: SKILL.md beats skill.md. */
function skillFileIn(dir: string, exists: (p: string) => boolean): string | undefined {
  for (const name of SKILL_FILE_NAMES) {
    const path = join(dir, name);
    if (exists(path)) {
      return path;
    }
  }
  return undefined;
}

/**
 * Discover, read, and validate every skill across the roots, applying
 * first-wins per name. Never throws: existing-but-broken candidates land in
 * `problems`; absent roots simply contribute nothing.
 */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<SkillsDiscoveryResult> {
  const seams = resolveSeams(options.fs);
  const roots = enumerateRoots(options, seams.exists);
  const byName = new Map<string, DiscoveredSkill>();
  const problems: SkillProblem[] = [];
  const shadowed: ShadowedSkill[] = [];
  const invalid: InvalidSkill[] = [];

  for (const root of roots) {
    if (!root.found) {
      continue;
    }
    for (const entry of await listSorted(root.path, seams.readDir)) {
      if (!entry.isDirectory) {
        continue;
      }
      const dir = join(root.path, entry.name);
      const file = skillFileIn(dir, seams.exists);
      if (file === undefined) {
        continue; // a subdirectory without SKILL.md|skill.md is not a skill
      }
      let text: string;
      try {
        text = await seams.readFile(file);
      } catch (cause) {
        const readProblem: SkillProblem = {
          path: file,
          key: "(file)",
          message: `could not read skill file: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
        problems.push(readProblem);
        invalid.push({ path: file, problems: [readProblem] });
        continue;
      }
      if (skillByteLength(text) > MAX_SKILL_BYTES) {
        const sizeProblem: SkillProblem = {
          path: file,
          key: "(file)",
          message: `skill file exceeds the ${MAX_SKILL_BYTES}-byte cap`,
        };
        problems.push(sizeProblem);
        invalid.push({ path: file, problems: [sizeProblem] });
        continue;
      }
      const parsed = parseSkillDocument(text);
      if (!parsed.ok) {
        const fileProblems = parsed.problems.map(
          (problem: SkillParseProblem): SkillProblem => ({
            path: file,
            key: problem.key,
            message: problem.message,
          }),
        );
        problems.push(...fileProblems);
        invalid.push({
          path: file,
          ...(parsed.partial.name !== undefined ? { name: parsed.partial.name } : {}),
          problems: fileProblems,
        });
        continue;
      }
      if (byName.has(parsed.skill.name)) {
        shadowed.push({ name: parsed.skill.name, path: file });
        continue;
      }
      byName.set(parsed.skill.name, {
        name: parsed.skill.name,
        description: parsed.skill.description,
        body: parsed.skill.body,
        path: file,
        dir,
        source: root.kind,
      });
    }
  }

  return { skills: [...byName.values()], problems, shadowed, invalid, roots };
}

/** Cap on resource entries listed per skill (bounded model-facing listing). */
export const MAX_RESOURCE_ENTRIES = 200;

/** Bounded resource listing for one skill directory. */
export interface SkillResources {
  /** Relative POSIX paths of regular files (recursively), sorted. */
  readonly files: readonly string[];
  /** True when more than {@link MAX_RESOURCE_ENTRIES} entries existed. */
  readonly truncated: boolean;
}

/**
 * List the resource files bundled under a skill directory (ADR-0012:
 * "optional sibling resources"), relative to the skill dir, POSIX-style,
 * sorted, excluding the SKILL.md itself. Directory symlinks are never
 * followed (cycle safety, same rule as the glob walker); the listing is
 * capped with an explicit truncation flag. Never throws — unreadable
 * subtrees contribute nothing.
 */
export async function listSkillResources(
  skillDir: string,
  fs?: SkillsFsSeams,
): Promise<SkillResources> {
  const seams = resolveSeams(fs);
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (files.length >= MAX_RESOURCE_ENTRIES) {
      truncated = true;
      return;
    }
    for (const entry of await listSorted(dir, seams.readDir)) {
      if (files.length >= MAX_RESOURCE_ENTRIES) {
        truncated = true;
        return;
      }
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth < 8) {
          await walk(join(dir, entry.name), rel, depth + 1);
        }
        continue;
      }
      if (!entry.isFile) {
        continue; // symlinks and special entries are never listed as resources
      }
      if (depth === 0 && SKILL_FILE_NAMES.includes(entry.name)) {
        continue; // the skill file itself is not a resource
      }
      files.push(rel);
    }
  };
  await walk(skillDir, "", 0);
  return { files, truncated };
}
