/**
 * Pure decision helper behind the wave-2 `void permissions test` CLI
 * subcommand (docs/architecture.md §permissions: "testable by users and CI
 * alike"). STABLE CONTRACT — scripts and CI pipelines key off these codes:
 *
 *   exit 0 = allow
 *   exit 1 = ask
 *   exit 2 = reject
 *
 * Delegates are not executed here (running an approver would make the test
 * neither pure nor offline-safe); a `delegate` decision reports as ask.
 */
import type { PermissionRule } from "../contracts/permissions";
import type { JsonObject } from "../contracts/tools";
import { evaluate } from "./evaluate";

/** The stable exit-code mapping of `void permissions test`. */
export const PERMISSIONS_TEST_EXIT_CODES = {
  allow: 0,
  ask: 1,
  reject: 2,
} as const;

/** Result reported by the test subcommand: code for the shell, text for humans. */
export interface PermissionsTestResult {
  readonly exitCode: 0 | 1 | 2;
  readonly explanation: string;
}

/**
 * Evaluate one tool call against a rule list without running anything.
 * Mirrors {@link evaluate} exactly; `delegate` outcomes map to ask with an
 * explicit note.
 */
export function testPermission(
  toolName: string,
  input: JsonObject,
  rules: readonly PermissionRule[],
): PermissionsTestResult {
  const outcome = evaluate(toolName, input, rules);
  const { action } = outcome.decision;
  const exitCode: 0 | 1 | 2 =
    action === "allow" ? 0 : action === "reject" ? 2 : PERMISSIONS_TEST_EXIT_CODES.ask;

  const parts = [outcome.reason];
  if (outcome.decision.message !== undefined) {
    parts.push(outcome.decision.message);
  }
  if (action === "delegate") {
    parts.push("delegate rules are not executed by the test subcommand; reporting as ask (exit 1)");
  }
  return { exitCode, explanation: parts.join(" — ") };
}
