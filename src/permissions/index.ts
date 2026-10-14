/**
 * `src/permissions` — the ordered-rules permission engine
 * (docs/architecture.md §permissions). Public surface for `core/` and the
 * CLI: matchers, evaluator, defaults, delegate runner, and the pure helper
 * behind `void permissions test`.
 */

export { DEFAULT_RULES } from "./defaults";
export type { DelegateContext, DelegateToolCall } from "./delegate";
export { DELEGATE_TIMEOUT_MS, runDelegate } from "./delegate";
export type { EvaluateContext, RuleValidationError } from "./evaluate";
export {
  DEFAULT_NO_MATCH,
  DEFAULT_NO_MATCH_ACTION,
  evaluate,
  toolMatches,
  validateRules,
} from "./evaluate";
export type { InputMatchDetail } from "./match";
export {
  globToRegExp,
  isGlobPattern,
  looksLikeRegexLiteral,
  matchInput,
  matchInputDetailed,
  matchValue,
  parseRegexLiteral,
} from "./match";
export type { PermissionsTestResult } from "./permissionsTest";
export { PERMISSIONS_TEST_EXIT_CODES, testPermission } from "./permissionsTest";
