/**
 * Ordered-rules evaluator — the permissions engine's decision core
 * (docs/architecture.md §permissions).
 *
 * `core/` calls {@link evaluate} before every `spec.execute`. Rules are walked
 * in order and the FIRST match wins (tool name + optional `context` path glob
 * + input matchers all have to pass). When nothing matches, the
 * {@link DEFAULT_NO_MATCH} policy applies: `ask` at MVP — the safe direction
 * for a local-first agent (an unmatched tool call escalates instead of
 * silently running).
 */
import { isAbsolute, join, normalize, relative } from "node:path";
import type {
  EvaluateOutcome,
  InputMatchSpec,
  PermissionAction,
  PermissionDecision,
  PermissionRule,
} from "../contracts/permissions";
import type { JsonObject, JsonValue } from "../contracts/tools";
import {
  globToRegExp,
  isGlobPattern,
  isJsonObject,
  looksLikeRegexLiteral,
  matchInputDetailed,
  parseRegexLiteral,
} from "./match";

/** Extra state the evaluator needs beyond the rule list. */
export interface EvaluateContext {
  /**
   * Absolute workspace root. Required for rules that carry a `context` path
   * glob: such a rule only applies when the tool input references paths that
   * (a) resolve inside the workspace and (b) match the glob relative to it.
   * Without a workspace root, context-scoped rules never apply.
   */
  readonly workspaceRoot?: string;
  /**
   * Who is making the evaluated call (ADR-0013). `"subagent"` marks
   * evaluations for tool calls dispatched inside a `task` tool's CHILD
   * conversation; undefined is the ordinary parent conversation. Rules
   * scoped `context: "subagent"` apply only to subagent calls — the seam for
   * stricter subagent policies (e.g. rejecting a tool inside children while
   * the parent keeps it).
   */
  readonly caller?: "subagent";
}

/**
 * The one non-path `context` selector (ADR-0013): a rule with
 * `context: "subagent"` matches by WHO is calling, not by paths — it applies
 * only when the evaluation carries `caller: "subagent"`.
 */
export const SUBAGENT_CONTEXT = "subagent";

/**
 * Does `ruleTool` select `toolName`? Exact match, `"*"` for any tool, or a
 * single trailing-`*` prefix (e.g. `mcp__server__*`). A `*` anywhere else is
 * treated as a literal character (never matches a real tool name) and is
 * reported by `validateRules`.
 */
export function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === "*") {
    return true;
  }
  if (ruleTool.endsWith("*") && ruleTool.length > 1) {
    return toolName.startsWith(ruleTool.slice(0, -1));
  }
  return ruleTool === toolName;
}

/** Decision carried over from the matched rule (message/to only when present). */
function decisionFor(rule: PermissionRule): PermissionDecision {
  return {
    action: rule.action,
    ...(rule.message !== undefined ? { message: rule.message } : {}),
    ...(rule.action === "delegate" && rule.to !== undefined ? { to: rule.to } : {}),
  };
}

/**
 * Evaluate the ordered rule list against one tool call. First match wins; no
 * match falls through to {@link DEFAULT_NO_MATCH}. Pure and synchronous —
 * `delegate` actions are returned as decisions; running the delegate command
 * is a separate step (`permissions/delegate.ts`).
 */
export function evaluate(
  toolName: string,
  toolInput: JsonObject,
  rules: readonly PermissionRule[],
  ctx?: EvaluateContext,
): EvaluateOutcome {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule === undefined) {
      continue;
    }
    if (!toolMatches(rule.tool, toolName)) {
      continue;
    }
    if (rule.context !== undefined) {
      if (rule.context === SUBAGENT_CONTEXT) {
        // Caller-scoped rule (ADR-0013): applies only to subagent calls —
        // the parent conversation never matches it, workspace root or not.
        if (ctx?.caller !== SUBAGENT_CONTEXT) {
          continue;
        }
      } else {
        const workspaceRoot = ctx?.workspaceRoot;
        if (
          workspaceRoot === undefined ||
          !contextApplies(rule.context, toolInput, workspaceRoot)
        ) {
          continue;
        }
      }
    }
    const detail = matchInputDetailed(rule.matches, toolInput);
    if (!detail.matched) {
      continue;
    }
    const scope = rule.context !== undefined ? `, context "${rule.context}"` : "";
    return {
      decision: decisionFor(rule),
      matchedRule: rule,
      matchedRuleIndex: index,
      reason:
        `rule[${index}] (tool "${rule.tool}"${scope}) ` +
        `matched input key "${detail.key ?? "*"}" → ${rule.action}`,
    };
  }
  return DEFAULT_NO_MATCH(toolName);
}

/** The action the no-match fallback recommends. MVP posture: ask, never guess. */
export const DEFAULT_NO_MATCH_ACTION: PermissionAction = "ask";

/**
 * The policy applied when no rule matches a tool call: surface an `ask`
 * decision telling the user/agent to add an explicit rule. A function (not a
 * constant) so the outcome can name the unmatched tool.
 */
export const DEFAULT_NO_MATCH = (toolName: string): EvaluateOutcome => ({
  decision: {
    action: DEFAULT_NO_MATCH_ACTION,
    message:
      `No permission rule matched "${toolName}". Void asks before running ` +
      "unmatched tools — add an explicit rule to allow or reject it.",
  },
  reason: `no rule matched tool "${toolName}"; default policy is ${DEFAULT_NO_MATCH_ACTION}`,
});

// ---------------------------------------------------------------------------
// `context` scoping — "the tool input references matching paths within the
// workspace". MVP semantics, kept deliberately simple and documented:
//
// 0. The one non-path selector is the literal "subagent" (ADR-0013): such a
//    rule applies by CALLER — only when the evaluation carries
//    `ctx.caller: "subagent"` (a task tool's child conversation) — and never
//    consults paths or the workspace root.
// 1. Candidate paths are collected by walking the input: string values under
//    path-ish keys (path/file/file_path/filepath/cwd/dir/directory/root/
//    workspace), plus any string that contains "/" or starts with "." or "~"
//    (absolute paths, nested relative paths, home shorthands). For the bash
//    tool a command string will often qualify — that is an acceptable
//    heuristic for a scoping layer, not a parser.
// 2. Each candidate is resolved against the workspace root (absolute ones
//    kept as-is; "~…" skipped — not resolvable here, therefore outside).
// 3. The rule applies only if some resolved candidate stays inside the
//    workspace AND its workspace-relative path matches the context glob.
// ---------------------------------------------------------------------------

const PATH_LIKE_KEYS: ReadonlySet<string> = new Set([
  "path",
  "file",
  "file_path",
  "filepath",
  "cwd",
  "dir",
  "directory",
  "root",
  "workspace",
]);

function collectPathCandidates(value: JsonValue, out: string[]): void {
  if (typeof value === "string") {
    if (value.includes("/") || value.startsWith(".") || value.startsWith("~")) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, out);
    }
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && PATH_LIKE_KEYS.has(key)) {
        out.push(child);
      } else {
        collectPathCandidates(child, out);
      }
    }
  }
}

function contextApplies(
  contextGlob: string,
  toolInput: JsonObject,
  workspaceRoot: string,
): boolean {
  let contextRegex: RegExp;
  try {
    contextRegex = globToRegExp(contextGlob);
  } catch {
    return false; // malformed context glob never applies; validateRules reports it
  }
  const root = normalize(workspaceRoot);
  const candidates: string[] = [];
  collectPathCandidates(toolInput, candidates);
  for (const candidate of candidates) {
    if (candidate.startsWith("~")) {
      continue; // home shorthand is never "within the workspace"
    }
    const resolved = normalize(isAbsolute(candidate) ? candidate : join(root, candidate));
    let rel = relative(root, resolved);
    if (rel === "") {
      rel = "."; // the workspace root itself
    }
    if (rel.startsWith("..") || isAbsolute(rel)) {
      continue; // escapes the workspace
    }
    if (contextRegex.test(rel)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule validation — structural checks for user/project config, run before the
// rules are ever consulted. Returns one entry per problem (empty = valid).
// ---------------------------------------------------------------------------

/** One structural problem found in a rule list. */
export interface RuleValidationError {
  /** Index of the offending rule in the list. */
  readonly ruleIndex: number;
  /** What is wrong and (when useful) how to fix it. */
  readonly message: string;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["allow", "reject", "ask", "delegate"]);

/**
 * Validate rule structure: tool selectors, actions, matcher shapes (regex
 * literals must compile, globs must be well-formed), `context` globs, and the
 * delegate `to` requirement. Non-structural style is left alone.
 */
export function validateRules(rules: readonly PermissionRule[]): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  rules.forEach((rule, index) => {
    const report = (message: string): void => {
      errors.push({ ruleIndex: index, message });
    };

    if (typeof rule.tool !== "string" || rule.tool.trim() === "") {
      report("rule.tool must be a non-empty string");
    } else {
      const starAt = rule.tool.indexOf("*");
      const wildcardOk = rule.tool === "*" || starAt === rule.tool.length - 1;
      if (starAt !== -1 && !wildcardOk) {
        report(
          `rule.tool "${rule.tool}" uses an unsupported wildcard — only "*" alone ` +
            'or a single trailing "*" (prefix match, e.g. "mcp__server__*") are valid',
        );
      }
    }

    if (!VALID_ACTIONS.has(String(rule.action))) {
      report(`rule.action "${String(rule.action)}" is not one of allow|reject|ask|delegate`);
    }

    validateMatches(rule.matches).forEach(report);

    if (rule.context !== undefined) {
      if (typeof rule.context !== "string" || rule.context.trim() === "") {
        report("rule.context must be a non-empty path glob when present");
      } else if (rule.context === SUBAGENT_CONTEXT) {
        // Valid caller-scoped selector (ADR-0013); nothing further to check.
      } else {
        try {
          globToRegExp(rule.context);
        } catch (error) {
          report(`rule.context "${rule.context}" is not a valid glob: ${(error as Error).message}`);
        }
      }
    }

    if (rule.action === "delegate" && (typeof rule.to !== "string" || rule.to.trim() === "")) {
      report('rule.action "delegate" requires rule.to — the command to run for a decision');
    }

    if (rule.message !== undefined && typeof rule.message !== "string") {
      report("rule.message must be a string when present");
    }
  });
  return errors;
}

function validateMatches(matches: InputMatchSpec): string[] {
  if (matches === "*") {
    return [];
  }
  if (typeof matches !== "object" || matches === null || Array.isArray(matches)) {
    return ['rule.matches must be "*" or an object mapping input paths to matchers'];
  }
  const entries = Object.entries(matches);
  if (entries.length === 0) {
    return [
      'rule.matches is an empty object (vacuously matches every input) — use "*" to say that explicitly',
    ];
  }
  const problems: string[] = [];
  for (const [key, matcher] of entries) {
    for (const problem of validateMatcher(matcher, `rule.matches["${key}"]`)) {
      problems.push(problem);
    }
  }
  return problems;
}

function validateMatcher(matcher: unknown, where: string): string[] {
  if (matcher === undefined) {
    return []; // defined semantics: field unconstrained
  }
  if (Array.isArray(matcher)) {
    if (matcher.length === 0) {
      return [`${where} is an empty array — an empty OR matches nothing`];
    }
    return matcher.flatMap((entry, i) => validateMatcher(entry, `${where}[${i}]`));
  }
  if (matcher === "*") {
    return [];
  }
  if (typeof matcher === "string") {
    if (looksLikeRegexLiteral(matcher) && parseRegexLiteral(matcher) === undefined) {
      return [
        `${where} is a malformed regex literal — it has the /pattern/flags shape but does not compile`,
      ];
    }
    if (isGlobPattern(matcher)) {
      try {
        globToRegExp(matcher);
      } catch (error) {
        return [`${where} is a malformed glob: ${(error as Error).message}`];
      }
    }
    return [];
  }
  if (typeof matcher === "number" || typeof matcher === "boolean" || matcher === null) {
    return [];
  }
  return [`${where} must be a string, number, boolean, null, or an array of those`];
}
