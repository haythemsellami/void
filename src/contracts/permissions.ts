/**
 * Permissions contract: the ordered rule list that gates every tool call.
 *
 * Implemented by `permissions/` (ordered rules engine, first match wins —
 * docs/architecture.md §permissions). Evaluated by `core/` before tool dispatch;
 * `ask` outcomes surface to the user through the permission-request callback
 * defined in tools.ts (headless `ask` fails with remediation text, ADR-0003).
 *
 * Pure types only — no imports, no runtime behavior.
 */

/** What happens when a rule matches a tool call. */
export type PermissionAction = "allow" | "reject" | "ask" | "delegate";

/**
 * One ordered rule as authored in user/project config. Evaluation walks rules
 * in order and the first match wins.
 */
export interface PermissionRule {
  /**
   * Tool name the rule applies to (exact match, e.g. "bash", "edit_file").
   * `"*"` matches any tool.
   */
  readonly tool: string;
  /**
   * What part of the tool input this rule constrains. `"*"` matches any input;
   * otherwise every entry of the record must match (AND across entries).
   */
  readonly matches: InputMatchSpec;
  /** Action taken when the rule matches. */
  readonly action: PermissionAction;
  /**
   * Optional path glob (e.g. "src/**") scoping the rule: it applies only when
   * the tool input references matching paths within the workspace. The one
   * non-path literal is `"subagent"` (ADR-0013): such a rule applies only to
   * tool calls made inside a `task` tool's child conversation.
   */
  readonly context?: string;
  /** Target of a `delegate` action (approver/agent id). Reserved; unused at MVP. */
  readonly to?: string;
  /** Human-readable rationale surfaced when this rule rejects or asks. */
  readonly message?: string;
}

/**
 * Matcher over a tool's input object.
 *
 * - `"*"` matches any input.
 * - A record maps *dotted paths* into the input (e.g. `"command"`, `"file.path"`)
 *   to value matchers; every entry must match.
 */
export type InputMatchSpec = "*" | Readonly<Record<string, ValueMatcher>>;

/**
 * Matches a single JSON value at one input path. String shape decides the mode:
 *
 * - `"/pattern/flags"` (leading + trailing slash) is a regex literal, e.g.
 *   `"/^git\\s+push/"`;
 * - a string containing glob metacharacters (`*`, `?`, `[`) is a glob;
 * - any other string, plus `number`, `boolean`, `null`, is an exact match.
 *
 * An array is an OR: the value matches if any element matches.
 */
export type ValueMatcher = string | number | boolean | null | readonly ValueMatcher[];

/** The decision for one tool call, produced by rule evaluation or a runtime ask. */
export interface PermissionDecision {
  readonly action: PermissionAction;
  /**
   * Guidance text surfaced with `reject`/`ask` (headless `ask` fails with this
   * text — ADR-0003) and echoed in logs for auditability.
   */
  readonly message?: string;
  /** Delegate target; present only when action is "delegate". */
  readonly to?: string;
}

/**
 * Result of evaluating the ordered rule list against a tool call: the decision
 * plus which rule produced it and why (auditability is a local-first property).
 */
export interface EvaluateOutcome {
  readonly decision: PermissionDecision;
  /** The rule that produced the decision; undefined when the default policy applied. */
  readonly matchedRule?: PermissionRule;
  /** Index of the matched rule in the ordered list; undefined for the default policy. */
  readonly matchedRuleIndex?: number;
  /** Human-readable explanation of why this decision was reached. */
  readonly reason: string;
}
