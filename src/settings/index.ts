/**
 * `src/settings` — the layered settings substrate (ADR-0006, roadmap WS0).
 * Public surface for the CLI: JSONC parsing, the settingsVersion-1 schema
 * validator, two-layer file discovery (user XDG + workspace git-root walk),
 * the precedence merge with per-key provenance, output renderers, and the
 * 0600 skeleton writer behind `void settings edit`.
 */

export type { DiscoverOptions, FoundSettingsFile } from "./discover";
export {
  findUserSettingsFile,
  findWorkspaceSettingsFile,
  userSettingsDir,
  WORKSPACE_SETTINGS_DIR,
} from "./discover";
export type { EnsureSettingsFileOptions, EnsureSettingsFileResult } from "./edit";
export { ensureSettingsFile, SETTINGS_SKELETON } from "./edit";
export { MAX_SETTINGS_BYTES, parseJsonc, stripJsoncComments } from "./jsonc";
export type {
  EffectiveSettings,
  KeyProvenance,
  LoadSettingsOptions,
  SettingsLayerInfo,
  SettingsLoadResult,
  SettingsProblem,
} from "./load";
export { loadSettings } from "./load";
export { formatSettingsProblems, renderSettingsEffective, renderSettingsPaths } from "./render";
export type {
  McpServerConfig,
  SettingsFile,
  SettingsValidationError,
  SettingsValidationResult,
} from "./schema";
export {
  DEFAULT_ASYNC_SHELL_MAX_LIFETIME_MS,
  DEFAULT_COMPACTION_KEEP_TURNS,
  MAX_ASYNC_SHELL_MAX_LIFETIME_MS,
  SETTINGS_VERSION,
  validateSettings,
} from "./schema";
