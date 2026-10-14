/**
 * `src/context/prompts` — system-prompt loading (ADR-0002 property 2).
 *
 * Versioned prompts live in `prompts/` and are resolved relative to THIS
 * module so the CLI works from any cwd and from source checkouts alike.
 * Compiled binaries (`bun build --compile`) have no source tree, so they fall
 * back to embedded copies generated at build time (`bun run sync-prompt`; a
 * drift test fails the build if the two diverge):
 *
 * - `prompts/default.md` → {@link loadDefaultPrompt} (the system prompt) with
 *   embedded fallback {@link EMBEDDED_DEFAULT_PROMPT};
 * - `prompts/compaction.md` → {@link loadCompactionPrompt} (the ADR-0008
 *   summarization prompt) with embedded fallback {@link EMBEDDED_COMPACTION_PROMPT};
 * - `prompts/modes/<mode>.md` → {@link loadModePrompt} (the ADR-0013 task
 *   mode presets) with embedded fallbacks {@link EMBEDDED_EXPLORER_MODE_PROMPT}
 *   / {@link EMBEDDED_PLANNER_MODE_PROMPT}.
 *
 * Override hooks are documented in the prompt files' headers but deliberately
 * not built at MVP; the options are:
 *
 * - default: live repo file when readable, else the embedded copy;
 * - `path`: read an explicit file (tests, future user config) — file only,
 *   never the embedded fallback: asking for a specific file must fail loudly.
 *
 * The loader is runtime-agnostic (node:fs/promises; works under Bun and
 * plain-Node vitest) and fails loudly on a missing/unreadable/empty prompt —
 * an agent must never run on an empty or silently-substituted prompt.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_COMPACTION_PROMPT } from "./compaction-prompt";
import { EMBEDDED_DEFAULT_PROMPT } from "./default-prompt";
import { EMBEDDED_EXPLORER_MODE_PROMPT } from "./explorer-mode-prompt";
import { EMBEDDED_PLANNER_MODE_PROMPT } from "./planner-mode-prompt";

/** Directory of this module: `<repo>/src/context`. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the built-in system prompt (ADR-0002 property 2). */
export const DEFAULT_PROMPT_PATH = join(MODULE_DIR, "..", "..", "prompts", "default.md");

/** Absolute path of the compaction summarization prompt (ADR-0008). */
export const COMPACTION_PROMPT_PATH = join(MODULE_DIR, "..", "..", "prompts", "compaction.md");

/** Absolute path of the task-tool mode presets directory (ADR-0013). */
export const MODE_PROMPTS_DIR = join(MODULE_DIR, "..", "..", "prompts", "modes");

/**
 * The task tool's mode presets (ADR-0013): P1 ships `explorer` (read-only
 * investigation, returns findings) and `planner` (produces a step plan).
 * Each mode maps to `prompts/modes/<mode>.md`, loaded by
 * {@link loadModePrompt} as the child conversation's system prompt.
 */
export const TASK_MODES = ["explorer", "planner"] as const;

/** One member of {@link TASK_MODES}. */
export type TaskMode = (typeof TASK_MODES)[number];

/** Is `value` a known task mode (used by input validation in tools/task)? */
export function isTaskMode(value: unknown): value is TaskMode {
  return typeof value === "string" && (TASK_MODES as readonly string[]).includes(value);
}

/** File-read seam so tests can load fixtures without touching the repo file. */
export type ReadFileLike = (path: string) => Promise<string>;

export interface LoadPromptOptions {
  /** Explicit prompt file to read instead of the built-in default. */
  readonly path?: string;
  /** Read implementation; defaults to `node:fs/promises` readFile(utf8). */
  readonly readFile?: ReadFileLike;
}

/** Thrown when a prompt cannot be loaded — never degrade silently. */
export class PromptLoadError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PromptLoadError";
  }
}

/** One versioned prompt file plus its compiled-binary embedded fallback. */
interface PromptFile {
  /** Default location (the versioned repo file). */
  readonly path: string;
  /** Embedded copy for compiled binaries; empty string disables the fallback. */
  readonly embedded: string;
  /** Human name used in error messages ("system prompt", "compaction prompt"). */
  readonly label: string;
}

/**
 * Shared loader for one {@link PromptFile}. Reads the file's default location
 * unless `options.path` names another file. Rejects with
 * {@link PromptLoadError} when the file is missing, unreadable, or empty.
 */
async function loadPromptFile(file: PromptFile, options: LoadPromptOptions): Promise<string> {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));

  if (options.path === undefined) {
    let text: string;
    try {
      text = await read(file.path);
    } catch {
      // Compiled binary: no source tree on disk — use the embedded copy.
      if (file.embedded.trim().length > 0) return file.embedded;
      throw new PromptLoadError(
        `cannot load ${file.label} from ${file.path} and no embedded fallback is available`,
        file.path,
      );
    }
    if (text.trim().length === 0) {
      throw new PromptLoadError(`${file.label} at ${file.path} is empty`, file.path);
    }
    return text;
  }

  let text: string;
  try {
    text = await read(options.path);
  } catch (cause) {
    throw new PromptLoadError(
      `cannot load ${file.label} from ${options.path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      options.path,
    );
  }
  if (text.trim().length === 0) {
    throw new PromptLoadError(`${file.label} at ${options.path} is empty`, options.path);
  }
  return text;
}

/**
 * Load the system prompt text. Reads {@link DEFAULT_PROMPT_PATH} unless
 * `options.path` names another file. Rejects with {@link PromptLoadError}
 * when the file is missing, unreadable, or empty.
 */
export function loadDefaultPrompt(options: LoadPromptOptions = {}): Promise<string> {
  return loadPromptFile(
    { path: DEFAULT_PROMPT_PATH, embedded: EMBEDDED_DEFAULT_PROMPT, label: "system prompt" },
    options,
  );
}

/**
 * Load the compaction summarization prompt (ADR-0008). Same semantics as
 * {@link loadDefaultPrompt}: live `prompts/compaction.md` by default,
 * embedded fallback for compiled binaries, loud failure on missing/empty.
 */
export function loadCompactionPrompt(options: LoadPromptOptions = {}): Promise<string> {
  return loadPromptFile(
    {
      path: COMPACTION_PROMPT_PATH,
      embedded: EMBEDDED_COMPACTION_PROMPT,
      label: "compaction prompt",
    },
    options,
  );
}

/** Embedded fallback per mode, keyed by {@link TaskMode} (ADR-0013). */
const MODE_EMBEDDED: Readonly<Record<TaskMode, string>> = {
  explorer: EMBEDDED_EXPLORER_MODE_PROMPT,
  planner: EMBEDDED_PLANNER_MODE_PROMPT,
};

/**
 * Load a task-tool mode preset (ADR-0013): the child conversation's system
 * prompt for `task` calls in this mode. Same semantics as
 * {@link loadDefaultPrompt}: live `prompts/modes/<mode>.md` by default,
 * embedded fallback for compiled binaries, loud failure on missing/empty.
 */
export function loadModePrompt(mode: TaskMode, options: LoadPromptOptions = {}): Promise<string> {
  return loadPromptFile(
    {
      path: join(MODE_PROMPTS_DIR, `${mode}.md`),
      embedded: MODE_EMBEDDED[mode],
      label: `${mode} mode preset`,
    },
    options,
  );
}
