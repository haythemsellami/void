/**
 * Tests for the `bash` tool. Most cases run hermetically through injected
 * deps (createBashTool) — no sandbox binary needed, works under both vitest
 * and bun:test. A final suite exercises the real macOS sandbox end-to-end.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolInput, ToolResult } from "../contracts";
import { type SandboxDetection, whichBinary } from "../sandbox/detect";
import {
  type SandboxRunOptions,
  type SandboxRunResult,
  SandboxUnavailableError,
} from "../sandbox/run";
import { type BashToolDeps, bashTool, createBashTool, MAX_TIMEOUT_MS } from "./bash";

const base = realpathSync(tmpdir());
const workspace = mkdtempSync(join(base, "void-bash-ws-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeCtx(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: workspace,
    workingDir: workspace,
    env: { PATH: "/usr/bin:/bin" },
    requestPermission: async () => ({ action: "allow" }),
    outputLimits: { maxTotalChars: 100_000, maxSectionChars: 10_000 },
    ...partial,
  };
}

interface RecordedCall {
  readonly command: string;
  readonly opts: SandboxRunOptions;
}

function fakeDeps(
  result: Partial<SandboxRunResult> = {},
  detection: SandboxDetection = {
    platform: "darwin",
    kind: "sandbox-exec",
    binaryPath: "/usr/bin/sandbox-exec",
  },
): {
  readonly deps: BashToolDeps;
  readonly calls: RecordedCall[];
  readonly directCalls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const directCalls: RecordedCall[] = [];
  const outcome: SandboxRunResult = {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    timedOut: false,
    durationMs: 5,
    ...result,
  };
  const deps: BashToolDeps = {
    detect: () => detection,
    run: async (command, opts) => {
      calls.push({ command, opts });
      return outcome;
    },
    runDirect: async (command, opts) => {
      directCalls.push({ command, opts });
      return outcome;
    },
  };
  return { deps, calls, directCalls };
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

describe("bash tool spec shape", () => {
  it("registers with the contract shape", () => {
    expect(bashTool.name).toBe("bash");
    expect(bashTool.source).toBe("builtin");
    expect(typeof bashTool.execute).toBe("function");
    const schema = bashTool.inputSchema as { readonly required?: readonly string[] };
    expect(schema.required).toEqual(["command"]);
    // The description must teach the non-error semantics of exit codes.
    expect(bashTool.description).toContain("sandbox");
    expect(bashTool.description).toContain("non-zero");
  });
});

describe("bash tool input validation", () => {
  const tool = createBashTool(fakeDeps().deps);
  const cases: readonly (readonly [string, ToolInput])[] = [
    ["a missing command", { timeoutMs: 1000 }],
    ["a non-string command", { command: 42 }],
    ["an empty command", { command: "   " }],
    ["a zero timeoutMs", { command: "ls", timeoutMs: 0 }],
    ["a negative timeoutMs", { command: "ls", timeoutMs: -1 }],
    ["a fractional timeoutMs", { command: "ls", timeoutMs: 1.5 }],
    ["a non-numeric timeoutMs", { command: "ls", timeoutMs: "soon" }],
    ["non-string env values", { command: "ls", env: { A: 1 } }],
    ["a non-object env", { command: "ls", env: ["A=1"] }],
    ["a non-string workdir", { command: "ls", workdir: 3 }],
  ];

  for (const [name, input] of cases) {
    it(`rejects ${name} with invalid_input`, async () => {
      const result = await tool.execute(input, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("invalid_input");
      expect(result.error?.retryable).toBe(false);
    });
  }

  it("rejects a workdir outside the workspace", async () => {
    const result = await tool.execute({ command: "ls", workdir: "/tmp" }, makeCtx());
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toContain("outside the workspace");
  });

  it("rejects a nonexistent workdir", async () => {
    const result = await tool.execute({ command: "ls", workdir: "no/such/dir" }, makeCtx());
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toContain("does not exist");
  });
});

describe("bash tool execution plumbing", () => {
  it("passes command, cwd and merged env to the sandboxed runner", async () => {
    const sub = join(workspace, "sub");
    mkdirSync(sub, { recursive: true });
    const { deps, calls, directCalls } = fakeDeps();
    const result = await createBashTool(deps).execute(
      { command: "pwd", workdir: "sub", env: { FOO: "bar" } },
      makeCtx({ env: { PATH: "/usr/bin:/bin", HOME: "/Users/example" } }),
    );
    expect(result.isError).toBe(false);
    expect(directCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("runner was not called");
    expect(call.command).toBe("pwd");
    expect(call.opts.cwd).toBe(realpathSync(sub));
    expect(call.opts.workspaceRoot).toBe(workspace);
    expect(call.opts.allowNetwork).toBe(false);
    expect(call.opts.env?.FOO).toBe("bar");
    expect(call.opts.env?.PATH).toBe("/usr/bin:/bin");
    expect(call.opts.env?.HOME).toBe("/Users/example");
    expect(call.opts.env?.TMPDIR).toBe(call.opts.tempDir);
    expect(call.opts.timeoutMs).toBe(30_000);
  });

  it("defaults workdir to the canonical workspace root", async () => {
    const { deps, calls } = fakeDeps();
    await createBashTool(deps).execute({ command: "ls" }, makeCtx());
    expect(calls[0]?.opts.cwd).toBe(workspace);
  });

  it("clamps timeoutMs to MAX_TIMEOUT_MS", async () => {
    const { deps, calls } = fakeDeps();
    await createBashTool(deps).execute({ command: "ls", timeoutMs: 10_000_000 }, makeCtx());
    expect(calls[0]?.opts.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("creates a per-call temp dir (also TMPDIR) and removes it afterwards", async () => {
    const { deps } = fakeDeps();
    let seenTemp: string | null = null;
    const probe: BashToolDeps = {
      ...deps,
      run: async (_command, opts) => {
        seenTemp = opts.tempDir ?? null;
        expect(existsSync(seenTemp ?? "/")).toBe(true);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
    };
    await createBashTool(probe).execute({ command: "ls" }, makeCtx());
    expect(seenTemp).not.toBeNull();
    expect(existsSync(seenTemp ?? "/")).toBe(false);
  });

  it("returns a structured execution_failed error when the temp dir cannot be created", async () => {
    // Point TMPDIR at a regular file: mkdtemp under it fails with ENOTDIR,
    // deterministically on every platform and for every euid (permission
    // tricks would be bypassed by the root user on the Linux CI job).
    const { deps, calls, directCalls } = fakeDeps();
    const notADir = join(workspace, "not-a-dir.txt");
    writeFileSync(notADir, "x");
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = notADir;
    try {
      const result = await createBashTool(deps).execute({ command: "ls" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("execution_failed");
      expect(result.error?.message).toContain("temp dir");
      expect(calls).toHaveLength(0);
      expect(directCalls).toHaveLength(0);
    } finally {
      if (prevTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = prevTmp;
      }
    }
  });

  it("does not leak VOID_ALLOW_UNSANDBOXED into the child env", async () => {
    const { deps, calls } = fakeDeps();
    await createBashTool(deps).execute(
      { command: "ls" },
      makeCtx({ env: { PATH: "/usr/bin:/bin", VOID_ALLOW_UNSANDBOXED: "1" } }),
    );
    expect(calls[0]?.opts.env?.VOID_ALLOW_UNSANDBOXED).toBeUndefined();
  });
});

describe("bash tool result formatting", () => {
  it("treats a non-zero exit as a valid observation (isError stays false)", async () => {
    const { deps } = fakeDeps({ exitCode: 2, stdout: "partial\n", stderr: "boom\n" });
    const result = await createBashTool(deps).execute({ command: "make" }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.error).toBeUndefined();
    const output = text(result);
    expect(output).toContain("exit code: 2");
    expect(output).toContain("partial");
    expect(output).toContain("boom");
  });

  it("marks empty sections explicitly", async () => {
    const { deps } = fakeDeps({ stdout: "", stderr: "" });
    const output = text(await createBashTool(deps).execute({ command: "true" }, makeCtx()));
    expect(output).toContain("--- stdout ---\n(empty)");
    expect(output).toContain("--- stderr ---\n(empty)");
  });

  it("truncates long stdout with an explicit marker and truncated flag", async () => {
    const { deps } = fakeDeps({ stdout: "a".repeat(100) });
    const result = await createBashTool(deps).execute(
      { command: "cat big" },
      makeCtx({ outputLimits: { maxSectionChars: 20, maxTotalChars: 100_000 } }),
    );
    const stdoutBlock = result.content[1];
    expect(stdoutBlock?.truncated).toBe(true);
    expect(stdoutBlock?.text).toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(stdoutBlock?.text).toContain("[truncated at 20 bytes]");
    expect(result.content[2]?.truncated).toBeUndefined(); // set only when clipped
  });

  it("truncates multi-byte output without splitting a UTF-8 sequence", async () => {
    // 6 x 'é' = 12 bytes; a 7-byte cut would split the last sequence.
    const { deps } = fakeDeps({ stdout: "é".repeat(6) });
    const result = await createBashTool(deps).execute(
      { command: "cat unicode" },
      makeCtx({ outputLimits: { maxSectionChars: 7, maxTotalChars: 100_000 } }),
    );
    const stdoutBlock = result.content[1];
    expect(stdoutBlock?.truncated).toBe(true);
    expect(stdoutBlock?.text).toContain("ééé"); // 6 bytes survive
    expect(stdoutBlock?.text).toContain("[truncated at 6 bytes]");
  });

  it("applies the total cap across stdout and stderr", async () => {
    const { deps } = fakeDeps({ stdout: "o".repeat(300), stderr: "e".repeat(300) });
    const result = await createBashTool(deps).execute(
      { command: "x" },
      makeCtx({ outputLimits: { maxSectionChars: 10_000, maxTotalChars: 100 } }),
    );
    const combined =
      Buffer.byteLength(result.content[1]?.text ?? "") +
      Buffer.byteLength(result.content[2]?.text ?? "");
    expect(combined).toBeLessThanOrEqual(100 + 128); // truncation markers may exceed
    expect(result.content.some((block) => block.truncated)).toBe(true);
  });

  it("maps a timed-out run to a structured timeout error with partial output", async () => {
    const { deps } = fakeDeps({ timedOut: true, exitCode: null, stdout: "partial" });
    const result = await createBashTool(deps).execute(
      { command: "sleep 60", timeoutMs: 500 },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.retryable).toBe(true);
    // Structured details (contracts gap #2): timedOut is set, exitCode is
    // only present when the process actually produced one (null here).
    expect(result.error?.details).toEqual({ timedOut: true });
    const output = text(result);
    expect(output).toContain("timed out after 500ms");
    expect(output).toContain("partial");
  });
});

describe("bash tool sandbox gate (ADR-0002 property 3)", () => {
  const noSandbox: SandboxDetection = { platform: "darwin", kind: null, binaryPath: null };

  it("fails sandbox_blocked with install guidance when no sandbox binary exists", async () => {
    const { deps, calls, directCalls } = fakeDeps({}, noSandbox);
    const result = await createBashTool(deps).execute({ command: "ls" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("sandbox_blocked");
    expect(result.error?.retryable).toBe(false);
    expect(text(result)).toContain("sandbox-exec"); // darwin guidance text
    expect(text(result)).toContain("VOID_ALLOW_UNSANDBOXED");
    expect(calls).toHaveLength(0);
    expect(directCalls).toHaveLength(0);
  });

  it("refuses on unsupported platforms too", async () => {
    const { deps } = fakeDeps({}, { platform: "unsupported", kind: null, binaryPath: null });
    const result = await createBashTool(deps).execute({ command: "ls" }, makeCtx());
    expect(result.error?.code).toBe("sandbox_blocked");
  });

  it("runs unsandboxed ONLY with VOID_ALLOW_UNSANDBOXED=1, with a loud marker", async () => {
    const { deps, calls, directCalls } = fakeDeps({}, noSandbox);
    const result = await createBashTool(deps).execute(
      { command: "ls" },
      makeCtx({ env: { PATH: "/usr/bin:/bin", VOID_ALLOW_UNSANDBOXED: "1" } }),
    );
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(0);
    expect(directCalls).toHaveLength(1);
    expect(text(result)).toContain("[VOID] UNSANDBOXED EXECUTION");
  });

  it("maps a SandboxUnavailableError from the runner to sandbox_blocked", async () => {
    const deps: BashToolDeps = {
      detect: presentDetection,
      run: async () => {
        throw new SandboxUnavailableError(
          "no OS sandbox binary found (platform: darwin); refusing to run unsandboxed. guidance…",
        );
      },
    };
    const result = await createBashTool(deps).execute({ command: "ls" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("sandbox_blocked");
  });

  it("maps unexpected runner failures to execution_failed", async () => {
    const deps: BashToolDeps = {
      detect: presentDetection,
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    };
    const result = await createBashTool(deps).execute({ command: "ls" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("execution_failed");
    expect(result.error?.message).toContain("spawn ENOENT");
  });

  function presentDetection(): SandboxDetection {
    return { platform: "darwin", kind: "sandbox-exec", binaryPath: "/usr/bin/sandbox-exec" };
  }
});

// Real spawns need Bun.spawn: run for real under `bun test`, skip under
// plain-Node vitest (hermetic suites above still run everywhere).
const onMacosSandbox =
  typeof Bun !== "undefined" &&
  process.platform === "darwin" &&
  whichBinary("sandbox-exec") !== null;

describe.skipIf(!onMacosSandbox)("bash tool end-to-end on macOS (real sandbox)", () => {
  it("runs echo through the real sandbox", async () => {
    const result = await bashTool.execute({ command: "echo hi" }, makeCtx());
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("exit code: 0");
    expect(text(result)).toContain("hi");
  });

  it("reports a blocked outside write as a normal non-zero observation", async () => {
    const result = await bashTool.execute(
      { command: "touch /private/tmp/void-tool-blocked" },
      makeCtx(),
    );
    expect(result.isError).toBe(false); // the sandbox denial is an observation
    expect(text(result)).toContain("exit code: 1");
    expect(text(result)).toContain("Operation not permitted");
    expect(existsSync("/private/tmp/void-tool-blocked")).toBe(false);
  });

  it("writes files inside the workspace", async () => {
    const result = await bashTool.execute(
      { command: "echo content > toolfile.txt && cat toolfile.txt" },
      makeCtx(),
    );
    expect(text(result)).toContain("exit code: 0");
    expect(text(result)).toContain("content");
    expect(existsSync(join(workspace, "toolfile.txt"))).toBe(true);
  });

  it("honours workdir without cd", async () => {
    const sub = join(workspace, "wd-sub");
    mkdirSync(sub, { recursive: true });
    const result = await bashTool.execute({ command: "pwd", workdir: "wd-sub" }, makeCtx());
    expect(text(result)).toContain("wd-sub");
  });

  it("passes merged env into the sandboxed command", async () => {
    const result = await bashTool.execute(
      { command: 'printf "%s" "$VOID_FOO"', env: { VOID_FOO: "bar" } },
      makeCtx(),
    );
    expect(text(result)).toContain("bar");
  });

  it("times out and kills the command", async () => {
    const result = await bashTool.execute({ command: "sleep 60", timeoutMs: 400 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("timeout");
  });
});
