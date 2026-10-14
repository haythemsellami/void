/**
 * Delegate runner tests: exit-code mapping, stdin payload, environment,
 * timeout, spawn failure. Fixtures are tiny /bin/sh scripts written to a
 * per-run temp dir — local process execution only, no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PermissionRule } from "../contracts/permissions";
import { runDelegate } from "./delegate";

const fixtureDir = mkdtempSync(join(tmpdir(), "void-delegate-"));

/** Write an executable /bin/sh fixture and return a quoted path for rule.to. */
function fixture(name: string, body: string): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `"${path}"`;
}

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

const rule = (to: string): PermissionRule => ({
  tool: "bash",
  matches: "*",
  action: "delegate",
  to,
});

const toolCall = { tool: "bash", input: { command: "git push" } };
const ctx = { threadId: "t_123", toolUseId: "tu_9" };

describe("runDelegate exit-code mapping", () => {
  it("exit 0 → allow", async () => {
    const decision = await runDelegate(rule(fixture("allow.sh", "exit 0")), toolCall, ctx);
    expect(decision.action).toBe("allow");
    expect(decision.to).toBeDefined();
    expect(decision.message).toContain("exit 0");
  });

  it("exit 1 → ask", async () => {
    const decision = await runDelegate(rule(fixture("ask.sh", "exit 1")), toolCall, ctx);
    expect(decision.action).toBe("ask");
    expect(decision.message).toContain("exit 1");
  });

  it("any other exit code → reject", async () => {
    for (const code of [2, 3, 42]) {
      const decision = await runDelegate(
        rule(fixture(`reject-${code}.sh`, `exit ${code}`)),
        toolCall,
        ctx,
      );
      expect(decision.action).toBe("reject");
      expect(decision.message).toContain(`exit ${code}`);
    }
  });

  it("a missing command (sh exit 127) → reject", async () => {
    const decision = await runDelegate(rule("/no/such/void-delegate-binary"), toolCall, ctx);
    expect(decision.action).toBe("reject");
    expect(decision.message).toContain("127");
  });

  it("rejects a delegate rule with no `to` command", async () => {
    const empty = { ...rule("x"), to: undefined } as unknown as PermissionRule;
    const noTo = await runDelegate(empty, toolCall, ctx);
    expect(noTo.action).toBe("reject");
    expect(noTo.message).toContain("no `to` command");
  });
});

describe("runDelegate protocol", () => {
  it("delivers the tool call as JSON on stdin", async () => {
    const capture = join(fixtureDir, "stdin.json");
    const to = fixture("capture.sh", `cat > "${capture}"\nexit 0`);
    const decision = await runDelegate(
      rule(to),
      { tool: "edit_file", input: { path: "src/a.ts" } },
      ctx,
    );
    expect(decision.action).toBe("allow");
    const received = JSON.parse(readFileSync(capture, "utf8")) as {
      tool: string;
      input: { path: string };
    };
    expect(received).toEqual({ tool: "edit_file", input: { path: "src/a.ts" } });
  });

  it("exports AGENT and VOID_* variables", async () => {
    const envCapture = join(fixtureDir, "env.txt");
    const to = fixture(
      "env.sh",
      `printf '%s' "$AGENT|$VOID_THREAD_ID|$VOID_TOOL_NAME|$VOID_TOOL_USE_ID" > "${envCapture}"\nexit 0`,
    );
    const decision = await runDelegate(rule(to), toolCall, ctx);
    expect(decision.action).toBe("allow");
    expect(readFileSync(envCapture, "utf8")).toBe("void|t_123|bash|tu_9");
  });

  it("keeps the VOID_* keys present but empty when ctx lacks values", async () => {
    const envCapture = join(fixtureDir, "env-empty.txt");
    const to = fixture(
      "env-empty.sh",
      `printf '%s' "|$VOID_THREAD_ID|$VOID_TOOL_USE_ID" > "${envCapture}"\nexit 1`,
    );
    const decision = await runDelegate(rule(to), toolCall, {});
    expect(decision.action).toBe("ask");
    expect(readFileSync(envCapture, "utf8")).toBe("||");
  });

  it("includes a bounded excerpt of delegate output in the message", async () => {
    const to = fixture("talk.sh", `echo "needs review: production deploy"\nexit 1`);
    const decision = await runDelegate(rule(to), toolCall, ctx);
    expect(decision.action).toBe("ask");
    expect(decision.message).toContain("needs review: production deploy");
  });
});

describe("runDelegate failure modes", () => {
  it("times out and rejects (fail-closed)", async () => {
    const to = fixture("sleep.sh", "sleep 30");
    const startedAt = Date.now();
    const decision = await runDelegate(rule(to), toolCall, ctx, 150);
    const elapsed = Date.now() - startedAt;
    expect(decision.action).toBe("reject");
    expect(decision.message).toContain("timed out after 150ms");
    expect(elapsed).toBeLessThan(5_000); // did not wait for the 30s sleep
  });

  it("lets a delegate that exits before reading stdin decide by exit code", async () => {
    const to = fixture("early-exit.sh", "exit 1");
    const decision = await runDelegate(rule(to), toolCall, ctx);
    expect(decision.action).toBe("ask");
  });
});
