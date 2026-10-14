/**
 * Tests for the pure `void permissions test` helper: exit-code mapping
 * (allow=0, ask=1, reject=2 — a stable CLI contract) and explanation text.
 */
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../contracts/permissions";
import { DEFAULT_RULES } from "./defaults";
import { testPermission } from "./permissionsTest";

describe("testPermission exit codes", () => {
  it("maps allow → 0", () => {
    const result = testPermission("bash", { command: "cat notes.txt" }, DEFAULT_RULES);
    expect(result.exitCode).toBe(0);
  });

  it("maps ask → 1 (explicit rule and default no-match)", () => {
    expect(testPermission("bash", { command: "git push" }, DEFAULT_RULES).exitCode).toBe(1);
    expect(testPermission("bash", { command: "curl example.com" }, DEFAULT_RULES).exitCode).toBe(1);
    expect(testPermission("mystery_tool", {}, DEFAULT_RULES).exitCode).toBe(1);
    expect(testPermission("bash", {}, []).exitCode).toBe(1); // empty rule list
  });

  it("maps reject → 2", () => {
    const result = testPermission("bash", { command: "rm -rf ~/" }, DEFAULT_RULES);
    expect(result.exitCode).toBe(2);
  });

  it("maps delegate → 1 without executing the approver", () => {
    const rules: readonly PermissionRule[] = [
      { tool: "bash", matches: "*", action: "delegate", to: "approver --stdin" },
    ];
    const result = testPermission("bash", { command: "anything" }, rules);
    expect(result.exitCode).toBe(1);
    expect(result.explanation).toContain("delegate rules are not executed");
  });

  it("honors user rule ordering over the defaults tail", () => {
    const userFirst: readonly PermissionRule[] = [
      {
        tool: "bash",
        matches: { command: "/\\bgit\\s+push\\b/" },
        action: "allow",
        message: "this repo auto-allows pushes",
      },
      ...DEFAULT_RULES,
    ];
    const result = testPermission("bash", { command: "git push" }, userFirst);
    expect(result.exitCode).toBe(0);
    expect(result.explanation).toContain("rule[0]");
  });
});

describe("testPermission explanations", () => {
  it("carries the evaluation reason and rule message", () => {
    const result = testPermission("bash", { command: "git push" }, DEFAULT_RULES);
    expect(result.explanation).toContain("rule[1]");
    expect(result.explanation).toContain("git commit/push");
  });

  it("names the tool on the default no-match path", () => {
    const result = testPermission("some_tool", {}, DEFAULT_RULES);
    expect(result.explanation).toContain("some_tool");
    expect(result.explanation).toContain("default policy");
  });
});
