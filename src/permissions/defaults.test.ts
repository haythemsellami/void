/**
 * Sanity spot-checks for DEFAULT_RULES: the postures the architecture doc
 * promises (read-only allowed, shared-state asks, catastrophes rejected,
 * everything else falls to the default ask).
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../contracts/tools";
import { DEFAULT_RULES } from "./defaults";
import { evaluate, validateRules } from "./evaluate";

const ctx = { workspaceRoot: "/tmp/void-ws" };

function actionOf(tool: string, input: JsonObject): string {
  return evaluate(tool, input, DEFAULT_RULES, ctx).decision.action;
}

describe("DEFAULT_RULES structure", () => {
  it("is structurally valid (self-check through the validator)", () => {
    expect(validateRules(DEFAULT_RULES)).toEqual([]);
  });

  it("keeps rejects ahead of allows so they cannot be shadowed", () => {
    expect(DEFAULT_RULES[0]?.action).toBe("reject");
    const actions = DEFAULT_RULES.map((rule) => rule.action);
    expect(actions.indexOf("reject")).toBeLessThan(actions.indexOf("allow"));
  });
});

describe("DEFAULT_RULES bash posture", () => {
  it("rejects catastrophic rm -rf against home or root", () => {
    expect(actionOf("bash", { command: "rm -rf ~/" })).toBe("reject");
    expect(actionOf("bash", { command: "rm -rf ~" })).toBe("reject");
    expect(actionOf("bash", { command: "rm -rf /" })).toBe("reject");
    expect(actionOf("bash", { command: "rm -rf $HOME" })).toBe("reject");
    expect(actionOf("bash", { command: "rm -fr ~" })).toBe("reject");
    expect(actionOf("bash", { command: "rm -RF /" })).toBe("reject"); // case-insensitive flags
    expect(actionOf("bash", { command: "sudo rm -rf /" })).toBe("reject");
  });

  it("lets scoped rm fall through to ask instead of reject", () => {
    expect(actionOf("bash", { command: "rm -rf ./build" })).toBe("ask");
    expect(actionOf("bash", { command: "rm -rf /tmp/void-cache" })).toBe("ask");
    expect(actionOf("bash", { command: "rm file.txt" })).toBe("ask");
  });

  it("rejects fork bombs, dd to disk devices, and chmod -R 777 /", () => {
    expect(actionOf("bash", { command: ":(){ :|:& };:" })).toBe("reject");
    expect(actionOf("bash", { command: "dd if=/dev/zero of=/dev/disk0" })).toBe("reject");
    expect(actionOf("bash", { command: "dd of=/dev/nvme0n1" })).toBe("reject");
    expect(actionOf("bash", { command: "chmod -R 777 /" })).toBe("reject");
    // Non-catastrophic variants ask rather than reject.
    expect(actionOf("bash", { command: "dd if=a of=b.iso" })).toBe("ask");
    expect(actionOf("bash", { command: "chmod -R 777 ./site" })).toBe("ask");
  });

  it("asks for git commit/push and package-manager installs", () => {
    expect(actionOf("bash", { command: "git push origin main" })).toBe("ask");
    expect(actionOf("bash", { command: "git commit -m 'x'" })).toBe("ask");
    expect(actionOf("bash", { command: "cd sub && git push" })).toBe("ask"); // unanchored on purpose
    expect(actionOf("bash", { command: "npm install" })).toBe("ask");
    expect(actionOf("bash", { command: "npm ci" })).toBe("ask");
    expect(actionOf("bash", { command: "pnpm remove lodash" })).toBe("ask");
    expect(actionOf("bash", { command: "bun add left-pad" })).toBe("ask");
    expect(actionOf("bash", { command: "yarn add react" })).toBe("ask");
    expect(actionOf("bash", { command: "npm uninstall jest" })).toBe("ask");
  });

  it("allows curated read-only commands", () => {
    expect(actionOf("bash", { command: "cat" })).toBe("allow");
    expect(actionOf("bash", { command: "cat src/foo.ts" })).toBe("allow");
    expect(actionOf("bash", { command: "ls -la" })).toBe("allow");
    expect(actionOf("bash", { command: "head -n 5 CHANGELOG.md" })).toBe("allow");
    expect(actionOf("bash", { command: "wc -l src/a.ts" })).toBe("allow");
    expect(actionOf("bash", { command: "pwd" })).toBe("allow");
    expect(actionOf("bash", { command: "echo done" })).toBe("allow");
    expect(actionOf("bash", { command: "rg TODO src/" })).toBe("allow");
    expect(actionOf("bash", { command: "git status" })).toBe("allow");
    expect(actionOf("bash", { command: "git diff --stat" })).toBe("allow");
    expect(actionOf("bash", { command: "git log --oneline -5" })).toBe("allow");
    expect(actionOf("bash", { command: "git show HEAD" })).toBe("allow");
    expect(actionOf("bash", { command: "node --version" })).toBe("allow");
    expect(actionOf("bash", { command: "python3 --version" })).toBe("allow");
    expect(actionOf("bash", { command: "python -V" })).toBe("allow");
  });

  it("makes every find invocation ask — action flags make read-only classification unsound", () => {
    // Review major 7: bare `find` used to sit in the read-only allowlist, so
    // `find -delete` and `find . -exec rm {} \;` were silently allowed —
    // find's action flags mutate the filesystem while the command shape
    // still looks read-only. find now falls through to the default ask.
    expect(actionOf("bash", { command: "find . -name void*.ts" })).toBe("ask");
    expect(actionOf("bash", { command: "find . -type f -delete" })).toBe("ask");
    expect(actionOf("bash", { command: "find . -exec rm {} \\;" })).toBe("ask");
    expect(actionOf("bash", { command: "find . -name '*.tmp' -fprint /etc/pwned" })).toBe("ask");
  });

  it("does not allow chains, redirects, or substitution riding behind read-only verbs", () => {
    expect(actionOf("bash", { command: "cat a; cat b" })).toBe("ask");
    expect(actionOf("bash", { command: "cat f | wc -l" })).toBe("ask");
    expect(actionOf("bash", { command: "ls > files.txt" })).toBe("ask");
    expect(actionOf("bash", { command: "echo $(whoami)" })).toBe("ask");
    expect(actionOf("bash", { command: "cat <(rm -rf ~)" })).toBe("ask");
    expect(actionOf("bash", { command: "node script.js" })).toBe("ask"); // not a version check
    expect(actionOf("bash", { command: "curl https://example.com" })).toBe("ask");
  });
});

describe("DEFAULT_RULES async shell family (ADR-0007)", () => {
  it("classifies async_shell_command with full bash parity", () => {
    // Read-only prefixes allow, exactly like bash.
    expect(actionOf("async_shell_command", { command: "ls -la" })).toBe("allow");
    expect(actionOf("async_shell_command", { command: "cat src/foo.ts" })).toBe("allow");
    expect(actionOf("async_shell_command", { command: "git status" })).toBe("allow");
    expect(actionOf("async_shell_command", { command: "rg TODO src/" })).toBe("allow");
    // Shared-state mutations ask.
    expect(actionOf("async_shell_command", { command: "npm run dev" })).toBe("ask");
    expect(actionOf("async_shell_command", { command: "git push origin main" })).toBe("ask");
    expect(actionOf("async_shell_command", { command: "pnpm add react" })).toBe("ask");
    // find asks for the same reason it does for bash: action flags make
    // read-only classification unsound.
    expect(actionOf("async_shell_command", { command: "find . -name void*.ts" })).toBe("ask");
    expect(actionOf("async_shell_command", { command: "find . -type f -delete" })).toBe("ask");
    // Catastrophes reject.
    expect(actionOf("async_shell_command", { command: "rm -rf ~/" })).toBe("reject");
    expect(actionOf("async_shell_command", { command: "dd of=/dev/disk0" })).toBe("reject");
    // Chains never ride in behind a read-only verb.
    expect(actionOf("async_shell_command", { command: "cat a; cat b" })).toBe("ask");
  });

  it("allows status and kill outright — no async default falls to ask (headless stays usable)", () => {
    expect(actionOf("async_shell_command_status", { handle: "as_deadbeef" })).toBe("allow");
    expect(actionOf("async_shell_command_status", { handle: "as_x", waitMs: 500 })).toBe("allow");
    expect(actionOf("async_shell_command_kill", { handle: "as_deadbeef" })).toBe("allow");
    // Command matchers cannot classify status/kill (no command key), and the
    // catastrophic patterns must not leak onto them through any other rule.
    const outcome = evaluate(
      "async_shell_command_status",
      { handle: "as_x", command: "rm -rf /" },
      DEFAULT_RULES,
      ctx,
    );
    expect(outcome.decision.action).toBe("allow"); // matched the status allow rule
  });
});

describe("DEFAULT_RULES read-only tools", () => {
  it("allows read_file, grep, glob outright — including outside the workspace", () => {
    expect(actionOf("read_file", { path: "/etc/hosts" })).toBe("allow");
    expect(actionOf("grep", { pattern: "TODO" })).toBe("allow");
    expect(actionOf("glob", { pattern: "src/**" })).toBe("allow");
  });
});

describe("DEFAULT_RULES task tool (ADR-0013)", () => {
  it("allows spawning a task child outright", () => {
    const outcome = evaluate(
      "task",
      { description: "check the config", prompt: "read the config and report" },
      DEFAULT_RULES,
      ctx,
    );
    expect(outcome.decision.action).toBe("allow");
  });

  it('classifies the child\'s read-only calls identically under caller "subagent"', () => {
    // The child gate re-evaluates the SAME array with caller "subagent":
    // every tool the child can dispatch stays allow-classified, so a child
    // never hits a headless ask.
    const sub = { ...ctx, caller: "subagent" as const };
    expect(evaluate("read_file", { path: "/etc/hosts" }, DEFAULT_RULES, sub).decision.action).toBe(
      "allow",
    );
    expect(evaluate("grep", { pattern: "x" }, DEFAULT_RULES, sub).decision.action).toBe("allow");
    expect(evaluate("glob", { pattern: "*.ts" }, DEFAULT_RULES, sub).decision.action).toBe("allow");
    expect(
      evaluate("async_shell_command_status", { handle: "as_x" }, DEFAULT_RULES, sub).decision
        .action,
    ).toBe("allow");
    expect(
      evaluate("async_shell_command_kill", { handle: "as_x" }, DEFAULT_RULES, sub).decision.action,
    ).toBe("allow");
  });
});

describe("DEFAULT_RULES edit_file posture", () => {
  it("asks on .git internals and dotfiles", () => {
    expect(actionOf("edit_file", { path: ".git/config" })).toBe("ask");
    expect(actionOf("edit_file", { path: ".git" })).toBe("ask");
    expect(actionOf("edit_file", { path: "src/.git/hooks/pre-commit" })).toBe("ask");
    expect(actionOf("edit_file", { path: ".env" })).toBe("ask");
    expect(actionOf("edit_file", { path: ".env.local" })).toBe("ask");
    expect(actionOf("edit_file", { path: ".gitignore" })).toBe("ask");
    expect(actionOf("edit_file", { file: { path: ".env" } })).toBe("ask"); // nested key variant
  });

  it("allows regular edits inside the workspace via the context glob", () => {
    expect(actionOf("edit_file", { path: "src/a.ts" })).toBe("allow");
    expect(actionOf("edit_file", { path: "/tmp/void-ws/README.md" })).toBe("allow");
    expect(actionOf("edit_file", { file: { path: "src/a.ts" } })).toBe("allow");
  });

  it("falls to the default ask outside the workspace or without a workspace root", () => {
    expect(actionOf("edit_file", { path: "/etc/passwd" })).toBe("ask");
    const noCtx = evaluate("edit_file", { path: "src/a.ts" }, DEFAULT_RULES);
    expect(noCtx.decision.action).toBe("ask"); // context rule cannot apply without workspaceRoot
  });

  it("does not treat dot-adjacent names as dotfiles", () => {
    expect(actionOf("edit_file", { path: "a.gitignore.backup" })).toBe("allow");
    expect(actionOf("edit_file", { path: "src/.gitignore" })).toBe("ask"); // any dotfile final segment asks
    expect(actionOf("edit_file", { path: "package.json" })).toBe("allow");
  });
});

describe("DEFAULT_RULES fall-through", () => {
  it("asks for unknown tools and unmatched commands", () => {
    const outcome = evaluate("some_tool", { x: 1 }, DEFAULT_RULES, ctx);
    expect(outcome.decision.action).toBe("ask");
    expect(outcome.matchedRuleIndex).toBeUndefined();
  });
});

describe("DEFAULT_RULES MCP tools (ADR-0011)", () => {
  it("allows mcp__<server>__<tool> calls — the trust act is the user's mcpServers config", () => {
    expect(actionOf("mcp__fixture__echo", { message: "hi" })).toBe("allow");
    expect(actionOf("mcp__github__create_pr", { title: "x" })).toBe("allow");
    // The rule is a prefix match on the mcp__ namespace, not a tool list.
    const outcome = evaluate("mcp__anything__else", {}, DEFAULT_RULES, ctx);
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.matchedRule?.tool).toBe("mcp__*");
  });

  it("a user rule placed BEFORE the defaults still restricts a server (mcp__server__*)", () => {
    const rules = [
      { tool: "mcp__dangerous__*", matches: "*", action: "reject" as const } as const,
      ...DEFAULT_RULES,
    ];
    expect(evaluate("mcp__dangerous__run", {}, rules, ctx).decision.action).toBe("reject");
    // Other servers keep the default allow.
    expect(evaluate("mcp__fixture__echo", {}, rules, ctx).decision.action).toBe("allow");
  });
});
