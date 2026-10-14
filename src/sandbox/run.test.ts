/**
 * Execution tests for the sandboxed runner.
 *
 * The macOS suite runs REAL sandbox-exec invocations (allowed and required
 * on this machine) using only safe commands: echo, touch, mktemp, pwd, curl
 * to a loopback port (the sandbox denial happens before any packet leaves
 * the host; the "allowed" variant reaches the loopback stack and is refused
 * — no network dependency either way). The Linux suite runs real bwrap only
 * when the binary exists (CI linux), skipped elsewhere.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { whichBinary } from "./detect";
import { runSandboxed } from "./run";

const base = realpathSync(tmpdir());
const workspace = mkdtempSync(join(base, "void-run-ws-"));
const scratch: string[] = [];

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real spawns need Bun.spawn, so these suites require the Bun runtime: under
// plain-Node vitest they skip; under `bun test` they run for real.
const bunRuntime = typeof Bun !== "undefined";
const onMacosSandbox =
  bunRuntime && process.platform === "darwin" && whichBinary("sandbox-exec") !== null;
const onLinuxBwrap = bunRuntime && process.platform === "linux" && whichBinary("bwrap") !== null;

describe.skipIf(!onMacosSandbox)("runSandboxed on macOS (real sandbox-exec)", () => {
  it("runs a simple echo and captures stdout", async () => {
    const result = await runSandboxed("echo hi", { workspaceRoot: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("captures stderr and propagates exit codes", async () => {
    const result = await runSandboxed("echo oops >&2; exit 42", { workspaceRoot: workspace });
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe("oops\n");
  });

  it("allows writes inside the workspace", async () => {
    const target = join(workspace, "inside.txt");
    const result = await runSandboxed(`touch ${target}`, { workspaceRoot: workspace });
    expect(result.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("BLOCKS writes outside the sandbox roots (/private/tmp)", async () => {
    const target = "/private/tmp/void-should-fail";
    const result = await runSandboxed(`touch ${target}`, { workspaceRoot: workspace });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Operation not permitted");
    expect(existsSync(target)).toBe(false);
  });

  it("BLOCKS writes to HOME outside the sandbox roots", async () => {
    // Scratch HOME under /private/tmp: writable by the user, but NOT one of
    // the profile's allowed roots (unlike the per-user temp base).
    const home = mkdtempSync("/private/tmp/void-run-home-XXXXXX");
    scratch.push(home);
    const result = await runSandboxed('touch "$HOME/leaked"', {
      workspaceRoot: workspace,
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Operation not permitted");
    expect(existsSync(join(home, "leaked"))).toBe(false);
  });

  it("allows the per-user temp base (confstr temp tools like mktemp work)", async () => {
    const result = await runSandboxed("mktemp", { workspaceRoot: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("allows writing to /dev/null (redirections keep working)", async () => {
    const result = await runSandboxed("echo x > /dev/null", { workspaceRoot: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("passes an explicit environment to the command", async () => {
    const result = await runSandboxed('printf "%s" "$VOID_FOO"', {
      workspaceRoot: workspace,
      env: { PATH: "/usr/bin:/bin", VOID_FOO: "bar" },
    });
    expect(result.stdout).toBe("bar");
  });

  it("runs in the workspace root by default", async () => {
    const result = await runSandboxed("pwd", { workspaceRoot: workspace });
    expect(result.stdout.trim()).toBe(workspace);
  });

  it("kills a timed-out command (single process)", async () => {
    const result = await runSandboxed("sleep 60", {
      workspaceRoot: workspace,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("kills the whole process group (backgrounded children die too)", async () => {
    // Without a group kill, the two sleeps would hold the output pipes open
    // and the run could not resolve until they exit on their own. The tool
    // RESULT must come back promptly (< ~5s) with timedOut set.
    const result = await runSandboxed("sleep 30 & sleep 30 & wait; echo done", {
      workspaceRoot: workspace,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
    expect(result.stdout).toBe("");
  });

  it("returns within timeout+grace when a grandchild escapes the group and holds the pipes", {
    timeout: 15_000,
  }, async () => {
    // The perl grandchild calls setsid(2) itself, leaving the child's
    // process group: the group SIGTERM/SIGKILL never reaches it and it
    // keeps the stdout pipe open. The kill escalation destroys the pipe
    // handles (stream cancel), so the capture settles at ~timeout+3s
    // instead of hanging for the grandchild's full 30s runtime.
    const result = await runSandboxed(
      "echo start; perl -e 'use POSIX qw(setsid); setsid(); sleep(30);' & wait",
      { workspaceRoot: workspace, timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
    expect(result.durationMs).toBeLessThan(5_000); // far below the 30s hold
    expect(result.stdout).toContain("start"); // output before the destroy survived
  });
});

describe.skipIf(!onMacosSandbox || !existsSync("/usr/bin/curl"))(
  "runSandboxed network policy on macOS (loopback only, no real network needed)",
  () => {
    const loopback = "/usr/bin/curl -sv --max-time 2 -o /dev/null http://127.0.0.1:9/";

    it("denies network by default (EPERM before any packet)", async () => {
      const result = await runSandboxed(loopback, { workspaceRoot: workspace });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Operation not permitted");
    });

    it("allows outbound connections when allowNetwork is set", async () => {
      const result = await runSandboxed(loopback, {
        workspaceRoot: workspace,
        allowNetwork: true,
      });
      // Loopback port 9 is closed: the connect() itself succeeds at the
      // sandbox layer and is refused by the stack — the discriminator vs EPERM.
      expect(result.stderr).not.toContain("Operation not permitted");
      expect(result.stderr).toContain("Failed to connect");
    });
  },
);

describe.skipIf(!onLinuxBwrap)("runSandboxed on Linux (real bwrap)", () => {
  it("runs echo through bwrap", async () => {
    const tempDir = mkdtempSync(join(realpathSync(tmpdir()), "void-bwrap-"));
    try {
      const result = await runSandboxed("echo ok", { workspaceRoot: workspace, tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
