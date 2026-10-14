/**
 * Tests for `permissions/evaluate.ts`: ordering, tool selectors, context
 * scoping, the default no-match policy, and rule validation.
 */
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../contracts/permissions";
import {
  DEFAULT_NO_MATCH,
  DEFAULT_NO_MATCH_ACTION,
  evaluate,
  toolMatches,
  validateRules,
} from "./evaluate";

const allowLs: PermissionRule = { tool: "bash", matches: { command: "ls" }, action: "allow" };
const askAllBash: PermissionRule = { tool: "bash", matches: "*", action: "ask" };

describe("toolMatches", () => {
  it("matches exact tool names", () => {
    expect(toolMatches("bash", "bash")).toBe(true);
    expect(toolMatches("bash", "bashx")).toBe(false);
    expect(toolMatches("edit_file", "edit_file")).toBe(true);
  });

  it("matches any tool with *", () => {
    expect(toolMatches("*", "bash")).toBe(true);
    expect(toolMatches("*", "mcp__gh__pr")).toBe(true);
  });

  it("matches one trailing-* as a prefix", () => {
    expect(toolMatches("mcp__server__*", "mcp__server__tool_a")).toBe(true);
    expect(toolMatches("mcp__server__*", "mcp__server__")).toBe(true);
    expect(toolMatches("mcp__server__*", "mcp__other__x")).toBe(false);
    expect(toolMatches("bash*", "bash")).toBe(true);
    expect(toolMatches("bash*", "bash_x")).toBe(true);
  });

  it("treats a mid-string * as a literal (never matches a real tool name)", () => {
    expect(toolMatches("ba*sh", "bash")).toBe(false);
    expect(toolMatches("*x", "x")).toBe(false); // leading * is not a suffix form
  });
});

describe("evaluate ordering and outcomes", () => {
  it("first match wins — an earlier ask shadows a later allow", () => {
    const rules = [askAllBash, allowLs];
    const outcome = evaluate("bash", { command: "ls" }, rules);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBe(0);
    expect(outcome.matchedRule).toBe(askAllBash);
  });

  it("later rules decide when earlier ones do not match", () => {
    const rules = [allowLs, askAllBash];
    const outcome = evaluate("bash", { command: "curl example.com" }, rules);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBe(1);
  });

  it("records which rule and key produced the decision", () => {
    const rules: readonly PermissionRule[] = [
      {
        tool: "bash",
        matches: { command: "/\\bgit\\s+push\\b/" },
        action: "reject",
        message: "no pushing",
      },
      allowLs,
    ];
    const outcome = evaluate("bash", { command: "git push origin" }, rules);
    expect(outcome.decision.action).toBe("reject");
    expect(outcome.decision.message).toBe("no pushing");
    expect(outcome.matchedRuleIndex).toBe(0);
    expect(outcome.reason).toContain("rule[0]");
    expect(outcome.reason).toContain('input key "command"');
    expect(outcome.reason).toContain("reject");
  });

  it("carries `to` only for delegate actions", () => {
    const delegate: PermissionRule = {
      tool: "bash",
      matches: "*",
      action: "delegate",
      to: "void-approver --stdin",
    };
    const withTo = evaluate("bash", {}, [delegate]);
    expect(withTo.decision.action).toBe("delegate");
    expect(withTo.decision.to).toBe("void-approver --stdin");

    const askWithStrayTo: PermissionRule = { ...askAllBash, to: "ignored" };
    const outcome = evaluate("bash", {}, [askWithStrayTo]);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.decision.to).toBeUndefined();
  });

  it("skips rules whose input matchers fail, across tools", () => {
    const rules: readonly PermissionRule[] = [
      { tool: "edit_file", matches: { "file.path": "src/**" }, action: "ask" },
      { tool: "read_file", matches: "*", action: "allow" },
    ];
    const outcome = evaluate("read_file", { path: "/etc/hosts" }, rules);
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.matchedRuleIndex).toBe(1);
  });

  it("wildcard tool rules compete positionally with specific ones", () => {
    const rules: readonly PermissionRule[] = [
      { tool: "mcp__github__*", matches: "*", action: "ask" },
      { tool: "*", matches: "*", action: "allow" },
    ];
    expect(evaluate("mcp__github__pr", {}, rules).decision.action).toBe("ask");
    expect(evaluate("read_file", {}, rules).decision.action).toBe("allow");
  });
});

describe("DEFAULT_NO_MATCH", () => {
  it("recommends ask at MVP", () => {
    expect(DEFAULT_NO_MATCH_ACTION).toBe("ask");
  });

  it("returns an ask outcome that names the tool, with no matched rule", () => {
    const outcome = DEFAULT_NO_MATCH("bash");
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.decision.message).toContain("bash");
    expect(outcome.matchedRule).toBeUndefined();
    expect(outcome.matchedRuleIndex).toBeUndefined();
    expect(outcome.reason).toContain("no rule matched");
  });

  it("applies when no rule matches — including for empty rule lists", () => {
    const outcome = evaluate("bash", { command: "anything" }, []);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBeUndefined();

    const noneMatch = evaluate("bash", { command: "shred /dev/sda" }, [allowLs]);
    expect(noneMatch.decision.action).toBe("ask");
    expect(noneMatch.reason).toContain("default policy");
  });
});

describe("context scoping", () => {
  const rules: readonly PermissionRule[] = [
    { tool: "edit_file", matches: "*", context: "src/**", action: "allow" },
    { tool: "edit_file", matches: "*", action: "ask" },
  ];
  const ctx = { workspaceRoot: "/tmp/void-ws" };

  it("applies the scoped rule when the referenced path matches the glob", () => {
    const outcome = evaluate("edit_file", { path: "src/a.ts" }, rules, ctx);
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.matchedRuleIndex).toBe(0);
    expect(outcome.reason).toContain('context "src/**"');
  });

  it("falls through when the path is inside the workspace but off-glob", () => {
    const outcome = evaluate("edit_file", { path: "docs/a.md" }, rules, ctx);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBe(1);
  });

  it("resolves absolute paths and nested path keys against the workspace root", () => {
    expect(
      evaluate("edit_file", { path: "/tmp/void-ws/src/deep/a.ts" }, rules, ctx).decision.action,
    ).toBe("allow");
    expect(evaluate("edit_file", { file: { path: "src/x.ts" } }, rules, ctx).decision.action).toBe(
      "allow",
    );
  });

  it("ignores paths that escape the workspace or use home shorthands", () => {
    expect(evaluate("edit_file", { path: "../../etc/passwd" }, rules, ctx).decision.action).toBe(
      "ask",
    );
    expect(evaluate("edit_file", { path: "/etc/passwd" }, rules, ctx).decision.action).toBe("ask");
    expect(evaluate("edit_file", { path: "~/src/a.ts" }, rules, ctx).decision.action).toBe("ask");
  });

  it("never applies a context rule without a workspace root in ctx", () => {
    const outcome = evaluate("edit_file", { path: "src/a.ts" }, rules);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBe(1);
  });

  it("a ** context covers the whole workspace", () => {
    const anyFile: readonly PermissionRule[] = [
      { tool: "edit_file", matches: "*", context: "**", action: "allow" },
    ];
    expect(evaluate("edit_file", { path: "src/a.ts" }, anyFile, ctx).decision.action).toBe("allow");
    expect(evaluate("edit_file", { path: "docs/x.md" }, anyFile, ctx).decision.action).toBe(
      "allow",
    );
  });
});

describe("validateRules", () => {
  it("accepts a well-formed list covering every action", () => {
    const rules: readonly PermissionRule[] = [
      { tool: "bash", matches: { command: "/\\bgit\\s+push\\b/" }, action: "reject" },
      { tool: "bash", matches: { command: "git diff*" }, action: "allow" },
      { tool: "*", matches: "*", action: "ask" },
      { tool: "mcp__gh__*", matches: "*", action: "delegate", to: "approver" },
      {
        tool: "edit_file",
        matches: { path: ["src/**", "/\\.env/"] },
        context: "src/**",
        action: "allow",
      },
    ];
    expect(validateRules(rules)).toEqual([]);
  });

  it("flags bad actions", () => {
    const bad = [
      { tool: "bash", matches: "*", action: "maybe" },
    ] as unknown as readonly PermissionRule[];
    const errors = validateRules(bad);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ruleIndex).toBe(0);
    expect(errors[0]?.message).toContain("maybe");
  });

  it("flags malformed regex literals", () => {
    const bad = [{ tool: "bash", matches: { command: "/x(/" }, action: "allow" }] as const;
    expect(validateRules(bad)[0]?.message).toContain("malformed regex");
  });

  it("flags malformed globs", () => {
    const bad = [{ tool: "bash", matches: { command: "a[b*c" }, action: "allow" }] as const;
    expect(validateRules(bad)[0]?.message).toContain("malformed glob");
    const badContext = [
      { tool: "edit_file", matches: "*", context: "a[b", action: "allow" },
    ] as const;
    expect(validateRules(badContext)[0]?.message).toContain("context");
  });

  it("flags delegate rules missing `to`", () => {
    const bad = [{ tool: "bash", matches: "*", action: "delegate" }] as const;
    expect(validateRules(bad)[0]?.message).toContain("requires rule.to");
  });

  it("flags bad tool selectors and empty match records", () => {
    const bad = [
      { tool: "", matches: "*", action: "allow" },
      { tool: "ba*sh", matches: "*", action: "allow" },
      { tool: "bash", matches: {}, action: "allow" },
      { tool: "bash", matches: "read_file" as unknown as never, action: "allow" },
    ] as unknown as readonly PermissionRule[];
    const messages = validateRules(bad).map((error) => error.message);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("non-empty string");
    expect(messages[1]).toContain("wildcard");
    expect(messages[2]).toContain("empty object");
    expect(messages[3]).toContain('must be "*" or an object');
  });

  it("flags empty matcher arrays and reports each rule by index", () => {
    const bad = [
      { tool: "read_file", matches: "*", action: "allow" },
      { tool: "bash", matches: { command: [] }, action: "allow" },
    ] as const;
    const errors = validateRules(bad);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ruleIndex).toBe(1);
    expect(errors[0]?.message).toContain("empty array");
  });

  it("accepts undefined matchers and primitive matchers", () => {
    const odd = [
      { tool: "bash", matches: { command: undefined }, action: "allow" },
      { tool: "tool", matches: { retries: 3, strict: true, fallback: null }, action: "allow" },
    ] as unknown as readonly PermissionRule[];
    expect(validateRules(odd)).toEqual([]);
  });
});

describe("subagent context (ADR-0013)", () => {
  // A "stricter future policy" in miniature: read_file is fine for the
  // parent but rejected inside task children.
  const rules: readonly PermissionRule[] = [
    {
      tool: "read_file",
      matches: "*",
      context: "subagent",
      action: "reject",
      message: "no reads in subagents",
    },
    { tool: "read_file", matches: "*", action: "allow" },
  ];

  it('a context:"subagent" rule fires only for caller:"subagent" evaluations', () => {
    const child = evaluate("read_file", { path: "/any/file" }, rules, {
      caller: "subagent",
    });
    expect(child.decision.action).toBe("reject");
    expect(child.matchedRuleIndex).toBe(0);
    expect(child.reason).toContain('context "subagent"');
    expect(child.decision.message).toBe("no reads in subagents");
  });

  it("the same rules array leaves the parent conversation untouched", () => {
    const parent = evaluate("read_file", { path: "/any/file" }, rules);
    expect(parent.decision.action).toBe("allow");
    expect(parent.matchedRuleIndex).toBe(1);
  });

  it('caller:"subagent" alone changes nothing for ordinary path-glob context rules', () => {
    const scoped: readonly PermissionRule[] = [
      { tool: "edit_file", matches: "*", context: "src/**", action: "allow" },
    ];
    const ctx = { workspaceRoot: "/tmp/void-ws" };
    // Subagent calls run in the same workspace: the path glob still applies.
    const inSrc = evaluate("edit_file", { path: "src/a.ts" }, scoped, {
      ...ctx,
      caller: "subagent",
    });
    expect(inSrc.decision.action).toBe("allow");
    const offGlob = evaluate("edit_file", { path: "docs/a.md" }, scoped, {
      ...ctx,
      caller: "subagent",
    });
    expect(offGlob.decision.action).toBe("ask");
  });

  it("a subagent-scoped rule needs no workspace root", () => {
    const child = evaluate("read_file", { path: "/any/file" }, rules, {
      caller: "subagent",
    });
    expect(child.decision.action).toBe("reject");
  });

  it("validateRules accepts the subagent context selector", () => {
    expect(validateRules(rules)).toEqual([]);
  });
});
