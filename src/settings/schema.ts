/**
 * `src/settings/schema` — the settings file schema and its hand-rolled
 * validator (ADR-0006: "hand-rolled validator (zero runtime deps, same style
 * as `validateRules`) producing precise errors naming the offending key").
 *
 * settingsVersion 1 keys (adding a key is additive; removing/renaming one
 * requires a version bump + migration note, per ADR-0006):
 *
 * - `settingsVersion` — REQUIRED, must be the literal number 1.
 * - `permissions`     — ordered {@link PermissionRule} list; structural
 *                       validation reuses `validateRules` from the
 *                       permissions engine (same engine, same errors).
 * - `defaultModel`    — non-empty model ref string.
 * - `mcpServers`      — record of stdio server configs. Validated by this
 *                       schema and CONSUMED by src/mcp (ADR-0011): run/resume
 *                       connect the servers and register their tools, and
 *                       `void mcp list|doctor` inspects them.
 * - `skills.path`     — non-empty string. Consumed by the skills workstream
 *                       (roadmap WS2).
 * - `providerTimeoutMs`      — positive integer.
 * - `compaction.thresholdPercent` — integer 0–100; `compaction.keepTurns` —
 *                       positive integer, default 2. Consumed by the
 *                       compaction workstream (roadmap WS4).
 * - `asyncShell.maxLifetimeMs` — positive integer, default 1_800_000 ms,
 *                       capped at 14_400_000 (4 h). Validated now; consumed
 *                       when the async-shell workstream lands.
 *
 * Unknown keys are REJECTED, not ignored — a typo must never silently
 * no-op ("the user asked for something we don't do" is a fact they need).
 */
import type { PermissionRule } from "../contracts/permissions";
import { validateRules } from "../permissions/evaluate";

/** The one settings schema version this build speaks. */
export const SETTINGS_VERSION = 1;

/** Default for `compaction.keepTurns` when a compaction block omits it. */
export const DEFAULT_COMPACTION_KEEP_TURNS = 2;

/** Default for `asyncShell.maxLifetimeMs` when an asyncShell block omits it. */
export const DEFAULT_ASYNC_SHELL_MAX_LIFETIME_MS = 1_800_000;

/** Cap for `asyncShell.maxLifetimeMs` (4 hours, per ADR-0006). */
export const MAX_ASYNC_SHELL_MAX_LIFETIME_MS = 14_400_000;

/** One stdio MCP server entry (`mcpServers.<name>`). */
export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A fully valid `settings.json` body (settingsVersion 1). */
export interface SettingsFile {
  readonly settingsVersion: typeof SETTINGS_VERSION;
  readonly permissions?: readonly PermissionRule[];
  readonly defaultModel?: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly skills?: { readonly path: string };
  readonly providerTimeoutMs?: number;
  readonly compaction?: {
    readonly thresholdPercent: number;
    readonly keepTurns?: number;
  };
  readonly asyncShell?: { readonly maxLifetimeMs?: number };
}

/** One validation problem: the offending key path plus what is wrong. */
export interface SettingsValidationError {
  /** Dotted key path into the file, e.g. `mcpServers.fancy.args` or `(root)`. */
  readonly key: string;
  /** What is wrong and (when useful) how to fix it. */
  readonly message: string;
}

/** Result of {@link validateSettings}: either a typed file or its problems. */
export type SettingsValidationResult =
  | { readonly ok: true; readonly settings: SettingsFile }
  | { readonly ok: false; readonly errors: readonly SettingsValidationError[] };

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "settingsVersion",
  "permissions",
  "defaultModel",
  "mcpServers",
  "skills",
  "providerTimeoutMs",
  "compaction",
  "asyncShell",
]);

const MCP_SERVER_KEYS: ReadonlySet<string> = new Set(["command", "args", "env"]);

/**
 * Validate one parsed settings file body. Collects every problem (zod-style
 * full report, not first-error) so one editing pass can fix them all.
 */
export function validateSettings(value: unknown): SettingsValidationResult {
  const errors: SettingsValidationError[] = [];
  const report = (key: string, message: string): void => {
    errors.push({ key, message });
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: [{ key: "(root)", message: "settings must be a JSON object" }],
    };
  }
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      report(
        key,
        `Unknown setting "${key}" — not part of settingsVersion ${SETTINGS_VERSION} ` +
          "(see void settings --help for the supported keys)",
      );
    }
  }

  const version = raw.settingsVersion;
  if (version === undefined) {
    report(
      "settingsVersion",
      `must be present and set to ${SETTINGS_VERSION} (this file's schema version)`,
    );
  } else if (version !== SETTINGS_VERSION || typeof version !== "number") {
    report(
      "settingsVersion",
      `must be the number ${SETTINGS_VERSION} — got ${JSON.stringify(version)}`,
    );
  }

  let permissions: readonly PermissionRule[] | undefined;
  if (raw.permissions !== undefined) {
    permissions = validatePermissions(raw.permissions, report);
  }

  let defaultModel: string | undefined;
  if (raw.defaultModel !== undefined) {
    if (typeof raw.defaultModel !== "string" || raw.defaultModel.trim() === "") {
      report("defaultModel", "must be a non-empty string (a model ref, e.g. ollama/qwen3:14b)");
    } else {
      defaultModel = raw.defaultModel;
    }
  }

  let mcpServers: Readonly<Record<string, McpServerConfig>> | undefined;
  if (raw.mcpServers !== undefined) {
    mcpServers = validateMcpServers(raw.mcpServers, report);
  }

  let skills: { readonly path: string } | undefined;
  if (raw.skills !== undefined) {
    const path = validateSkills(raw.skills, report);
    if (path !== undefined) {
      skills = { path };
    }
  }

  let providerTimeoutMs: number | undefined;
  if (raw.providerTimeoutMs !== undefined) {
    const timeout = raw.providerTimeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      report("providerTimeoutMs", "must be a positive integer (milliseconds)");
    } else {
      providerTimeoutMs = timeout;
    }
  }

  let compaction: { readonly thresholdPercent: number; readonly keepTurns?: number } | undefined;
  if (raw.compaction !== undefined) {
    const validated = validateCompaction(raw.compaction, report);
    if (validated !== undefined) {
      compaction = {
        thresholdPercent: validated.thresholdPercent,
        ...(validated.keepTurns !== undefined ? { keepTurns: validated.keepTurns } : {}),
      };
    }
  }

  let asyncShell: { readonly maxLifetimeMs?: number } | undefined;
  if (raw.asyncShell !== undefined) {
    const validated = validateAsyncShell(raw.asyncShell, report);
    if (validated.valid) {
      asyncShell = {
        ...(validated.maxLifetimeMs !== undefined
          ? { maxLifetimeMs: validated.maxLifetimeMs }
          : {}),
      };
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const settings: SettingsFile = {
    settingsVersion: SETTINGS_VERSION,
    ...(permissions !== undefined ? { permissions } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(providerTimeoutMs !== undefined ? { providerTimeoutMs } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(asyncShell !== undefined ? { asyncShell } : {}),
  };
  return { ok: true, settings };
}

/** `permissions`: array of rule objects; each rule checked by validateRules. */
function validatePermissions(
  value: unknown,
  report: (key: string, message: string) => void,
): readonly PermissionRule[] | undefined {
  if (!Array.isArray(value)) {
    report("permissions", "must be an array of permission rules");
    return undefined;
  }
  let allObjects = true;
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report(`permissions[${i}]`, "must be a permission rule object");
      allObjects = false;
    }
  }
  if (!allObjects) {
    return undefined;
  }
  const rules = value as PermissionRule[];
  const ruleErrors = validateRules(rules);
  if (ruleErrors.length > 0) {
    for (const error of ruleErrors) {
      report(`permissions[${error.ruleIndex}]`, error.message);
    }
    return undefined;
  }
  return rules;
}

/** `mcpServers`: record of per-server configs, unknown server keys rejected. */
function validateMcpServers(
  value: unknown,
  report: (key: string, message: string) => void,
): Readonly<Record<string, McpServerConfig>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report("mcpServers", "must be an object mapping server names to configs");
    return undefined;
  }
  const out: Record<string, McpServerConfig> = {};
  let valid = true;
  for (const [name, entry] of Object.entries(value)) {
    const where = `mcpServers.${name}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report(where, "must be an object with at least a command");
      valid = false;
      continue;
    }
    const server = entry as Record<string, unknown>;
    for (const key of Object.keys(server)) {
      if (!MCP_SERVER_KEYS.has(key)) {
        report(where, `Unknown setting "${key}" — mcpServers entries allow command, args, env`);
        valid = false;
      }
    }
    let ok = true;
    const command = server.command;
    if (typeof command !== "string" || command.trim() === "") {
      report(`${where}.command`, "must be a non-empty string (the executable to spawn)");
      ok = false;
    }
    let args: readonly string[] | undefined;
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) {
        report(`${where}.args`, "must be an array of strings");
        ok = false;
      } else {
        args = server.args as readonly string[];
      }
    }
    let env: Readonly<Record<string, string>> | undefined;
    if (server.env !== undefined) {
      if (
        typeof server.env !== "object" ||
        server.env === null ||
        Array.isArray(server.env) ||
        Object.values(server.env).some((v) => typeof v !== "string")
      ) {
        report(`${where}.env`, "must be an object mapping variable names to strings");
        ok = false;
      } else {
        env = server.env as Record<string, string>;
      }
    }
    if (ok && typeof command === "string") {
      out[name] = {
        command,
        ...(args !== undefined ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
      };
    } else {
      valid = false; // one bad server invalidates the whole layer (fail closed)
    }
  }
  return valid ? out : undefined;
}

/** `skills`: object with a required non-empty `path`. */
function validateSkills(
  value: unknown,
  report: (key: string, message: string) => void,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report("skills", "must be an object with a path field");
    return undefined;
  }
  const skills = value as Record<string, unknown>;
  let valid = true;
  for (const key of Object.keys(skills)) {
    if (key !== "path") {
      report("skills", `Unknown setting "${key}" — skills allows path`);
      valid = false;
    }
  }
  const path = skills.path;
  if (typeof path !== "string" || path.trim() === "") {
    report("skills.path", "must be a non-empty string (a directory of skill folders)");
    return undefined;
  }
  return valid ? path : undefined;
}

/**
 * `compaction`: required integer `thresholdPercent` in 0–100 plus optional
 * positive integer `keepTurns` (default {@link DEFAULT_COMPACTION_KEEP_TURNS}).
 */
function validateCompaction(
  value: unknown,
  report: (key: string, message: string) => void,
): { readonly thresholdPercent: number; readonly keepTurns?: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report("compaction", "must be an object with a thresholdPercent field");
    return undefined;
  }
  const compaction = value as Record<string, unknown>;
  let valid = true;
  for (const key of Object.keys(compaction)) {
    if (key !== "thresholdPercent" && key !== "keepTurns") {
      report(
        "compaction",
        `Unknown setting "${key}" — compaction allows thresholdPercent, keepTurns`,
      );
      valid = false;
    }
  }
  const threshold = compaction.thresholdPercent;
  if (
    typeof threshold !== "number" ||
    !Number.isInteger(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) {
    report("compaction.thresholdPercent", "must be an integer between 0 and 100 (percent)");
    valid = false;
  }
  let keepTurns: number | undefined;
  if (compaction.keepTurns !== undefined) {
    const turns = compaction.keepTurns;
    if (typeof turns !== "number" || !Number.isInteger(turns) || turns <= 0) {
      report("compaction.keepTurns", "must be a positive integer (number of turns)");
      valid = false;
    } else {
      keepTurns = turns;
    }
  }
  if (!valid || typeof threshold !== "number") {
    return undefined;
  }
  return {
    thresholdPercent: threshold,
    ...(keepTurns !== undefined ? { keepTurns } : {}),
  };
}

/**
 * `asyncShell`: optional positive integer `maxLifetimeMs`, default
 * {@link DEFAULT_ASYNC_SHELL_MAX_LIFETIME_MS}, capped at
 * {@link MAX_ASYNC_SHELL_MAX_LIFETIME_MS} (4 h, per ADR-0006). An empty
 * block is valid (all defaults); the field is only checked when present.
 */
function validateAsyncShell(
  value: unknown,
  report: (key: string, message: string) => void,
): { readonly valid: boolean; readonly maxLifetimeMs?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report("asyncShell", "must be an object with a maxLifetimeMs field");
    return { valid: false };
  }
  const asyncShell = value as Record<string, unknown>;
  let valid = true;
  for (const key of Object.keys(asyncShell)) {
    if (key !== "maxLifetimeMs") {
      report("asyncShell", `Unknown setting "${key}" — asyncShell allows maxLifetimeMs`);
      valid = false;
    }
  }
  const lifetime = asyncShell.maxLifetimeMs;
  if (lifetime === undefined) {
    return { valid };
  }
  if (
    typeof lifetime !== "number" ||
    !Number.isInteger(lifetime) ||
    lifetime <= 0 ||
    lifetime > MAX_ASYNC_SHELL_MAX_LIFETIME_MS
  ) {
    report(
      "asyncShell.maxLifetimeMs",
      `must be a positive integer of at most ${MAX_ASYNC_SHELL_MAX_LIFETIME_MS} ` +
        "(milliseconds; 4-hour cap)",
    );
    return { valid: false };
  }
  return { valid, maxLifetimeMs: lifetime };
}
