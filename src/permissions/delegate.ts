/**
 * Delegate runner — the `delegate` permission action
 * (docs/architecture.md §permissions: matchers with "an escape hatch to
 * external delegate commands").
 *
 * Protocol (stable surface for external approvers):
 *
 * - `rule.to` is executed as `["/bin/sh", "-c", to]` so a single string can
 *   carry the command and its arguments.
 * - Environment: the parent environment plus `AGENT="void"`,
 *   `VOID_THREAD_ID`, `VOID_TOOL_NAME`, `VOID_TOOL_USE_ID` (empty string when
 *   a value is unknown — the four keys are always present so approvers can
 *   rely on them).
 * - stdin receives the tool call as JSON: `{"tool": string, "input": object}`.
 * - Exit code decides: 0 = allow, 1 = ask, anything else (including timeout
 *   or spawn failure) = reject. Fail-closed is the point of delegation: an
 *   approver that cannot run is an approver that said no.
 *
 * Spawning uses `node:child_process`, not `Bun.spawn`: the runtime is Bun,
 * but the test suite executes under Node workers, and the node: builtin
 * behaves identically in both — one code path, no runtime branching.
 */
import { spawn } from "node:child_process";
import type { PermissionDecision, PermissionRule } from "../contracts/permissions";
import type { JsonObject } from "../contracts/tools";

/** Default wall-clock budget for a delegate decision. */
export const DELEGATE_TIMEOUT_MS = 10_000;

/** Rolling cap on delegate output collected from each stream. */
const MAX_COLLECTED_CHARS = 8_192;

/** Cap on delegate output retained in decision messages. */
const OUTPUT_EXCERPT_CHARS = 400;

/** The tool call handed to a delegate for a decision. */
export interface DelegateToolCall {
  readonly tool: string;
  readonly input: JsonObject;
}

/** Session facts surfaced to the delegate through the environment. */
export interface DelegateContext {
  readonly threadId?: string;
  readonly toolUseId?: string;
}

const DELEGATE_SHELL = "/bin/sh";

/** How the delegate process finished. */
type DelegateExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly error: Error };

/**
 * Run the delegate command of `rule` and map its outcome to a decision.
 * `timeoutMs` is overridable so tests stay fast; production callers use the
 * {@link DELEGATE_TIMEOUT_MS} default.
 */
export async function runDelegate(
  rule: PermissionRule,
  toolCall: DelegateToolCall,
  ctx: DelegateContext = {},
  timeoutMs: number = DELEGATE_TIMEOUT_MS,
): Promise<PermissionDecision> {
  const command = rule.to;
  if (typeof command !== "string" || command.trim() === "") {
    return {
      action: "reject",
      message: "delegate rule has no `to` command — refusing to allow the call",
    };
  }

  const payload = JSON.stringify({ tool: toolCall.tool, input: toolCall.input });
  const env = {
    ...process.env,
    AGENT: "void",
    VOID_THREAD_ID: ctx.threadId ?? "",
    VOID_TOOL_NAME: toolCall.tool,
    VOID_TOOL_USE_ID: ctx.toolUseId ?? "",
  };

  const child = spawn(DELEGATE_SHELL, ["-c", command], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Rolling collectors keep a chatty approver from growing memory without
  // bound; only the tail is ever useful for a decision message.
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-MAX_COLLECTED_CHARS);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_COLLECTED_CHARS);
  });
  child.stdin?.on("error", () => {
    // EPIPE when the delegate exits before reading stdin; the exit code decides.
  });
  child.stdin?.end(payload);

  const outcome: DelegateExit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: a hung approver must not stretch the budget.
      child.kill("SIGKILL");
      resolve({ kind: "timeout" });
    }, timeoutMs);
    const finish = (exit: DelegateExit): void => {
      clearTimeout(timer);
      resolve(exit);
    };
    // "close" (not "exit") so both output streams have flushed first.
    child.on("close", (code) => finish({ kind: "exited", code: code ?? -1 }));
    child.on("error", (error) => finish({ kind: "error", error }));
  });

  switch (outcome.kind) {
    case "timeout":
      return {
        action: "reject",
        to: command,
        message: `delegate command "${command}" timed out after ${timeoutMs}ms`,
      };
    case "error":
      return {
        action: "reject",
        to: command,
        message: `failed to run delegate command "${command}": ${outcome.error.message}`,
      };
    case "exited": {
      const excerpt = excerptOf(stdout, stderr);
      if (outcome.code === 0) {
        return delegateDecision("allow", command, "approved by delegate (exit 0)", excerpt);
      }
      if (outcome.code === 1) {
        return delegateDecision(
          "ask",
          command,
          "delegate requests a human decision (exit 1)",
          excerpt,
        );
      }
      return delegateDecision(
        "reject",
        command,
        `denied by delegate (exit ${outcome.code})`,
        excerpt,
      );
    }
  }
}

function delegateDecision(
  action: "allow" | "ask" | "reject",
  to: string,
  verdict: string,
  excerpt: string,
): PermissionDecision {
  const message = excerpt === "" ? verdict : `${verdict}\ndelegate output: ${excerpt}`;
  return { action, to, message };
}

/** Bounded, whitespace-normalized tail of the delegate's output. */
function excerptOf(stdout: string, stderr: string): string {
  const text = [stdout.trim(), stderr.trim()].filter((part) => part !== "").join("\n");
  return text.length <= OUTPUT_EXCERPT_CHARS ? text : text.slice(-OUTPUT_EXCERPT_CHARS);
}
