/**
 * `src/settings/load` — read, validate, and merge the settings layers
 * (ADR-0006). Layer precedence for any single-valued key:
 *
 *     user  <  workspace  <  VOID_* env shadows
 *
 * Two keys merge structurally instead of by replacement:
 *
 * - `permissions`: CONCATENATED in first-match-wins order — workspace rules
 *   FIRST, then user rules (ADR-0006 amendment: order IS semantics, workspace
 *   outranks user). The CLI appends `DEFAULT_RULES` as the fallback tail.
 * - `mcpServers`: merged per server name — a workspace entry with the same
 *   name replaces the user entry, names only present in one layer survive.
 *
 * Env shadows are settings-shaped `VOID_*` vars resolved HERE, at the
 * CLI/runner layer, before any adapter construction (ADR-0006 Consequences:
 * adapters' own env reads are construction-time fallbacks only and never
 * participate in file precedence). At settingsVersion 1 the only shadow is
 * `VOID_DEFAULT_MODEL` → `defaultModel`. `$VOID_MODEL` is NOT a settings
 * layer member: it stays the pre-existing scriptable model override,
 * applied at its existing call site (and therefore still outranks the
 * file layers for model resolution — documented in the CLI help).
 *
 * Failure policy (ADR-0006): missing files are never fatal — an absent
 * layer contributes nothing. A file that EXISTS but is unreadable,
 * oversized, syntactically broken, or schema-invalid is a LOUD failure:
 * it lands in `problems` (file + key + problem), is excluded from the
 * merge entirely (fail closed — a half-valid file never half-applies),
 * and callers turn any problem into an error. Malformed JSON never falls
 * back to the JSONC twin or an ancestor file — the file that was found is
 * the file that must be valid.
 *
 * The loader never throws and never reads `process.*` — all I/O is injected.
 */
import type { PermissionRule } from "../contracts/permissions";
import type { FoundSettingsFile } from "./discover";
import {
  findUserSettingsFile,
  findWorkspaceSettingsFile,
  userSettingsDir,
  WORKSPACE_SETTINGS_DIR,
} from "./discover";
import { MAX_SETTINGS_BYTES, parseJsonc, settingsByteLength } from "./jsonc";
import type { SettingsValidationError } from "./schema";
import {
  DEFAULT_ASYNC_SHELL_MAX_LIFETIME_MS,
  DEFAULT_COMPACTION_KEEP_TURNS,
  type McpServerConfig,
  type SettingsFile,
  validateSettings,
} from "./schema";

/** One settings-shaped env shadow currently supported (see module doc). */
const ENV_SHADOWS: readonly { readonly envKey: string; readonly settingsKey: "defaultModel" }[] = [
  { envKey: "VOID_DEFAULT_MODEL", settingsKey: "defaultModel" },
];

/** One structured problem with an existing settings file. */
export interface SettingsProblem {
  /** The file the problem was found in. */
  readonly path: string;
  /** Dotted key path (`defaultModel`, `permissions[2]`), or `(syntax)`/`(file)`. */
  readonly key: string;
  readonly message: string;
}

/** Where a layer's file search landed, for `void settings path`/rendering. */
export interface SettingsLayerInfo {
  readonly scope: "user" | "workspace";
  /** The file that exists and was used; undefined when the layer is absent. */
  readonly found: FoundSettingsFile | undefined;
  /** Canonical would-be path (the JSON file) when nothing was found. */
  readonly canonicalPath: string;
}

/** Which layer won (or contributed to) one effective key. */
export interface KeyProvenance {
  readonly key: string;
  readonly source: "user" | "workspace" | "env";
  /** File that supplied the value (user/workspace). */
  readonly path?: string;
  /** Env var that supplied the value (env layer). */
  readonly envKey?: string;
  /** Layers that contributed to a merged key (permissions/mcpServers), in merge order. */
  readonly contributors?: readonly {
    readonly layer: "user" | "workspace";
    readonly path: string;
  }[];
}

/** The merged, in-effect settings (nested pinned defaults materialized). */
export interface EffectiveSettings {
  readonly settingsVersion: 1;
  readonly defaultModel?: string;
  /** Workspace rules first, then user rules (gate appends DEFAULT_RULES). */
  readonly permissions?: readonly PermissionRule[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly skills?: { readonly path: string };
  readonly providerTimeoutMs?: number;
  /** keepTurns materialized with its pinned default when a block exists. */
  readonly compaction?: { readonly thresholdPercent: number; readonly keepTurns: number };
  /** maxLifetimeMs materialized with its pinned default when a block exists. */
  readonly asyncShell?: { readonly maxLifetimeMs: number };
}

/** Everything {@link loadSettings} learned in one pass. */
export interface SettingsLoadResult {
  readonly effective: EffectiveSettings;
  readonly layers: Readonly<{
    readonly user: SettingsLayerInfo;
    readonly workspace: SettingsLayerInfo;
  }>;
  /** One entry per effective key that any layer set. */
  readonly provenance: readonly KeyProvenance[];
  /** Empty when every existing file is valid; any entry is a loud failure. */
  readonly problems: readonly SettingsProblem[];
}

/** Injectability seams (tests); defaults touch the real filesystem. */
export interface LoadSettingsOptions {
  /** Environment for XDG/HOME resolution and VOID_* shadows. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Workspace walk start (the CLI's resolved cwd). */
  readonly cwd: string;
  /** Read seam; default node:fs/promises readFile(utf8). */
  readonly readFile?: (path: string) => Promise<string>;
  /** Existence seam (discovery); default node:fs existsSync. */
  readonly exists?: (path: string) => boolean;
  /** Info-line sink (JSONC fallback notices); default: no-op. */
  readonly log?: (line: string) => void;
}

/** Read+parse one file, collecting problems instead of throwing. */
async function readLayerFile(
  found: FoundSettingsFile,
  readFile: (path: string) => Promise<string>,
): Promise<{ text?: string; problems: SettingsProblem[] }> {
  const problems: SettingsProblem[] = [];
  let text: string;
  try {
    text = await readFile(found.path);
  } catch (cause) {
    return {
      problems: [
        {
          path: found.path,
          key: "(file)",
          message: `could not read settings file: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }
  if (settingsByteLength(text) > MAX_SETTINGS_BYTES) {
    return {
      problems: [
        {
          path: found.path,
          key: "(file)",
          message: `settings file exceeds the ${MAX_SETTINGS_BYTES}-byte cap`,
        },
      ],
    };
  }
  return { text, problems };
}

/** Parse per syntax: `.json` is strict JSON; `.jsonc` allows comments. */
function parseLayerText(
  found: FoundSettingsFile,
  text: string,
): { value?: unknown; problems: SettingsProblem[] } {
  try {
    return { value: found.format === "jsonc" ? parseJsonc(text) : JSON.parse(text), problems: [] };
  } catch (cause) {
    return {
      problems: [
        {
          path: found.path,
          key: "(syntax)",
          message: `not valid ${found.format === "jsonc" ? "JSONC" : "JSON"}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      ],
    };
  }
}

/** Validate one parsed file, prefixing every error with its source path. */
function validateLayerFile(
  found: FoundSettingsFile,
  value: unknown,
): { settings?: SettingsFile; problems: SettingsProblem[] } {
  const result = validateSettings(value);
  if (result.ok) {
    return { settings: result.settings, problems: [] };
  }
  return {
    problems: result.errors.map(
      (error: SettingsValidationError): SettingsProblem => ({
        path: found.path,
        key: error.key,
        message: error.message,
      }),
    ),
  };
}

/** Load one scope end-to-end: find → read → parse → validate. */
async function loadLayer(
  scope: "user" | "workspace",
  find: () => FoundSettingsFile | undefined,
  canonicalPath: string,
  options: LoadSettingsOptions,
): Promise<{ info: SettingsLayerInfo; settings?: SettingsFile; problems: SettingsProblem[] }> {
  const found = find();
  const info: SettingsLayerInfo = { scope, found, canonicalPath };
  if (found === undefined) {
    return { info, problems: [] }; // absent layer: never fatal, contributes nothing
  }
  if (found.jsoncFallback) {
    options.log?.(`void: using JSONC settings at ${found.path} (settings.json not found there)`);
  }
  const read = await readLayerFile(found, options.readFile ?? defaultReadFile);
  if (read.problems.length > 0) {
    return { info, problems: read.problems };
  }
  const parsed = parseLayerText(found, read.text ?? "");
  if (parsed.problems.length > 0) {
    return { info, problems: parsed.problems };
  }
  const validated = validateLayerFile(found, parsed.value);
  return {
    info,
    ...(validated.settings !== undefined ? { settings: validated.settings } : {}),
    problems: validated.problems,
  };
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

/** Single-layer provenance entry (path included only when the file exists). */
function provenanceFor(
  key: string,
  source: "user" | "workspace",
  layer: SettingsLayerInfo,
): KeyProvenance {
  return {
    key,
    source,
    ...(layer.found !== undefined ? { path: layer.found.path } : {}),
  };
}

/**
 * Discover, read, validate, and merge both layers plus the env shadow layer.
 * Never throws: every failure is a structured {@link SettingsProblem}; a
 * layer with problems is excluded from the merge (fail closed).
 */
export async function loadSettings(options: LoadSettingsOptions): Promise<SettingsLoadResult> {
  const problems: SettingsProblem[] = [];
  const discoverOptions = {
    ...(options.exists !== undefined ? { exists: options.exists } : {}),
  };
  const user = await loadLayer(
    "user",
    () => findUserSettingsFile(options.env, discoverOptions),
    `${userSettingsDir(options.env)}/settings.json`,
    options,
  );
  const workspace = await loadLayer(
    "workspace",
    () => findWorkspaceSettingsFile(options.cwd, discoverOptions),
    `${options.cwd}/${WORKSPACE_SETTINGS_DIR}/settings.json`,
    options,
  );
  problems.push(...user.problems, ...workspace.problems);

  const userFile = user.settings;
  const workspaceFile = workspace.settings;
  const provenance: KeyProvenance[] = [];

  // --- scalar/override keys: workspace over user ---
  const defaultModelFromFiles = workspaceFile?.defaultModel ?? userFile?.defaultModel;
  let defaultModel = defaultModelFromFiles;
  let defaultModelSource: KeyProvenance["source"] | undefined =
    defaultModelFromFiles === undefined
      ? undefined
      : workspaceFile?.defaultModel !== undefined
        ? "workspace"
        : "user";
  let defaultModelPath: string | undefined =
    defaultModelSource === "workspace"
      ? workspace.info.found?.path
      : defaultModelSource === "user"
        ? user.info.found?.path
        : undefined;

  // --- env shadow layer (settings-shaped VOID_* vars, top of file precedence) ---
  for (const shadow of ENV_SHADOWS) {
    const value = options.env[shadow.envKey]?.trim();
    if (value === undefined || value === "") {
      continue; // unset or empty = not set (consistent with buildToolEnv)
    }
    if (shadow.settingsKey === "defaultModel") {
      defaultModel = value;
      defaultModelSource = "env";
      defaultModelPath = undefined;
    }
    provenance.push({ key: shadow.settingsKey, source: "env", envKey: shadow.envKey });
  }

  // --- permissions: workspace rules FIRST, then user rules ---
  const workspaceRules = workspaceFile?.permissions ?? [];
  const userRules = userFile?.permissions ?? [];
  const permissions =
    workspaceRules.length + userRules.length > 0 ? [...workspaceRules, ...userRules] : undefined;
  if (permissions !== undefined) {
    const contributors: { layer: "user" | "workspace"; path: string }[] = [];
    if (workspaceRules.length > 0 && workspace.info.found !== undefined) {
      contributors.push({ layer: "workspace", path: workspace.info.found.path });
    }
    if (userRules.length > 0 && user.info.found !== undefined) {
      contributors.push({ layer: "user", path: user.info.found.path });
    }
    provenance.unshift({
      key: "permissions",
      source: contributors[0]?.layer ?? "user",
      contributors,
    });
  }

  // --- mcpServers: per-name, workspace entry replaces the user entry ---
  let mcpServers: Record<string, McpServerConfig> | undefined;
  const mcpContributors: { layer: "user" | "workspace"; path: string }[] = [];
  if (userFile?.mcpServers !== undefined || workspaceFile?.mcpServers !== undefined) {
    mcpServers = { ...(userFile?.mcpServers ?? {}) };
    if (userFile?.mcpServers !== undefined && user.info.found !== undefined) {
      mcpContributors.push({ layer: "user", path: user.info.found.path });
    }
    const wsServers = workspaceFile?.mcpServers;
    if (wsServers !== undefined) {
      if (workspace.info.found !== undefined) {
        mcpContributors.push({ layer: "workspace", path: workspace.info.found.path });
      }
      for (const [name, entry] of Object.entries(wsServers)) {
        mcpServers[name] = entry;
      }
    }
    provenance.push({
      key: "mcpServers",
      source: mcpContributors.at(-1)?.layer ?? "user",
      contributors: mcpContributors,
    });
  }

  // --- leaf-merged single-object keys: workspace leaf over user leaf ---
  const leafProvenance = (key: string, workspaceWins: boolean): void => {
    provenance.push(
      workspaceWins
        ? provenanceFor(key, "workspace", workspace.info)
        : provenanceFor(key, "user", user.info),
    );
  };
  const skillsPath = workspaceFile?.skills?.path ?? userFile?.skills?.path;
  if (skillsPath !== undefined) {
    leafProvenance("skills.path", workspaceFile?.skills?.path !== undefined);
  }
  const thresholdPercent =
    workspaceFile?.compaction?.thresholdPercent ?? userFile?.compaction?.thresholdPercent;
  const keepTurns =
    workspaceFile?.compaction?.keepTurns ??
    userFile?.compaction?.keepTurns ??
    DEFAULT_COMPACTION_KEEP_TURNS;
  const compaction = thresholdPercent !== undefined ? { thresholdPercent, keepTurns } : undefined;
  if (compaction !== undefined) {
    leafProvenance("compaction", workspaceFile?.compaction !== undefined);
  }
  const maxLifetimeMs =
    workspaceFile?.asyncShell?.maxLifetimeMs ??
    userFile?.asyncShell?.maxLifetimeMs ??
    DEFAULT_ASYNC_SHELL_MAX_LIFETIME_MS;
  const asyncShell =
    userFile?.asyncShell !== undefined || workspaceFile?.asyncShell !== undefined
      ? { maxLifetimeMs }
      : undefined;
  if (asyncShell !== undefined) {
    leafProvenance("asyncShell", workspaceFile?.asyncShell !== undefined);
  }
  const providerTimeoutMs = workspaceFile?.providerTimeoutMs ?? userFile?.providerTimeoutMs;
  if (providerTimeoutMs !== undefined) {
    leafProvenance("providerTimeoutMs", workspaceFile?.providerTimeoutMs !== undefined);
  }

  const effective: EffectiveSettings = {
    settingsVersion: 1,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(skillsPath !== undefined ? { skills: { path: skillsPath } } : {}),
    ...(providerTimeoutMs !== undefined ? { providerTimeoutMs } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(asyncShell !== undefined ? { asyncShell } : {}),
  };
  if (defaultModel !== undefined && defaultModelSource !== undefined) {
    provenance.unshift({
      key: "defaultModel",
      source: defaultModelSource,
      ...(defaultModelPath !== undefined ? { path: defaultModelPath } : {}),
    });
  }

  return {
    effective,
    layers: { user: user.info, workspace: workspace.info },
    provenance,
    problems,
  };
}
