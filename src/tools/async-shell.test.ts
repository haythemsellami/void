/**
 * Tests for the async shell tool family. The hermetic suites run the REAL
 * registry, cursor, buffer-cap, eviction, and kill machinery against fake
 * subprocesses that write to the real per-handle output log — no sandbox or
 * Bun.spawn needed, so they run under both vitest and bun:test. A final suite
 * spawns real processes through the real macOS sandbox (Bun only, skip under
 * plain-Node vitest), mirroring the bash tool's split.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildPermissionGate, buildToolRegistry } from "../app/runner";
import type { ToolContext, ToolInput, ToolResult } from "../contracts";
import { type SandboxDetection, whichBinary } from "../sandbox/detect";
import { SandboxUnavailableError } from "../sandbox/run";
import {
  type AsyncShellDeps,
  type AsyncShellTools,
  type AsyncSpawnOutcome,
  type AsyncSpawnRequest,
  type AsyncSubprocessLike,
  createAsyncShellTools,
  DEFAULT_MAX_LIFETIME_MS,
  MAX_LIFETIME_MS,
  MAX_OPEN_HANDLES,
  MAX_PENDING_BYTES,
} from "./async-shell";

const base = realpathSync(tmpdir());
const workspace = mkdtempSync(join(base, "void-async-ws-"));

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

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function handleOf(result: ToolResult): string {
  const match = /handle: (as_[A-Za-z0-9_-]+)/.exec(text(result));
  if (match === null || match[1] === undefined) {
    throw new Error(`no handle in result: ${text(result)}`);
  }
  return match[1];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fake subprocess: writes to the real output fd on a timeline, dies on kill
// ---------------------------------------------------------------------------

interface PlanEvent {
  readonly atMs: number;
  readonly write?: string;
  readonly exit?: number;
}

function presentDetection(): SandboxDetection {
  return { platform: "darwin", kind: "sandbox-exec", binaryPath: "/usr/bin/sandbox-exec" };
}

const noSandboxDetection = (): SandboxDetection => ({
  platform: "darwin",
  kind: null,
  binaryPath: null,
});

function makeFakeSpawn(plan: readonly PlanEvent[]): {
  readonly spawn: NonNullable<AsyncShellDeps["spawn"]>;
  readonly spawnDirect: NonNullable<AsyncShellDeps["spawnDirect"]>;
  readonly signals: string[];
  readonly requests: AsyncSpawnRequest[];
} {
  const signals: string[] = [];
  const requests: AsyncSpawnRequest[] = [];
  const makeProc = (req: AsyncSpawnRequest): AsyncSubprocessLike => {
    const started = Date.now();
    const state = {
      exited: false,
      exitCode: null as number | null,
      signal: null as NodeJS.Signals | null,
    };
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fire = (ev: PlanEvent): void => {
      if (state.exited) {
        return;
      }
      if (ev.write !== undefined) {
        try {
          writeSync(req.outputFd, ev.write);
        } catch {
          // fd closed (handle torn down) — dead processes write nothing.
        }
      }
      if (ev.exit !== undefined) {
        state.exited = true;
        state.exitCode = ev.exit;
        resolveExit(ev.exit);
        for (const timer of timers) {
          clearTimeout(timer);
        }
      }
    };
    for (const ev of plan) {
      timers.push(setTimeout(() => fire(ev), Math.max(0, ev.atMs - (Date.now() - started))));
    }
    const proc: AsyncSubprocessLike = {
      pid: 4242,
      exited,
      get exitCode(): number | null {
        return state.exitCode;
      },
      get signalCode(): NodeJS.Signals | number | null {
        return state.signal;
      },
      kill(signal?: number | NodeJS.Signals): void {
        signals.push(String(signal ?? "SIGTERM"));
        if (state.exited) {
          return;
        }
        state.exited = true;
        state.exitCode = null;
        state.signal = (signal ?? "SIGTERM") as NodeJS.Signals;
        resolveExit(0);
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    };
    return proc;
  };
  return {
    spawn: (req: AsyncSpawnRequest): AsyncSpawnOutcome => {
      requests.push(req);
      return { proc: makeProc(req), unsandboxed: false };
    },
    spawnDirect: (req: AsyncSpawnRequest): AsyncSpawnOutcome => {
      requests.push(req);
      return { proc: makeProc(req), unsandboxed: true };
    },
    signals,
    requests,
  };
}

const liveFamilies: AsyncShellTools[] = [];

afterEach(() => {
  for (const family of liveFamilies.splice(0)) {
    family.disposeAll();
  }
});

function fakeFamily(
  plan: readonly PlanEvent[] = [],
  extra: Partial<AsyncShellDeps> = {},
): { family: AsyncShellTools; fake: ReturnType<typeof makeFakeSpawn> } {
  const fake = makeFakeSpawn(plan);
  const family = createAsyncShellTools({
    detect: () => presentDetection(),
    spawn: fake.spawn,
    spawnDirect: fake.spawnDirect,
    ...extra,
  });
  liveFamilies.push(family);
  return { family, fake };
}

// ---------------------------------------------------------------------------
// Spec shapes
// ---------------------------------------------------------------------------

describe("async shell spec shapes", () => {
  it("registers three builtins with handle-oriented schemas", () => {
    const { family } = fakeFamily();
    const spawnSchema = family.spawnTool.inputSchema as { readonly required?: readonly string[] };
    const statusSchema = family.statusTool.inputSchema as { readonly required?: readonly string[] };
    const killSchema = family.killTool.inputSchema as { readonly required?: readonly string[] };
    expect(family.spawnTool.name).toBe("async_shell_command");
    expect(family.statusTool.name).toBe("async_shell_command_status");
    expect(family.killTool.name).toBe("async_shell_command_kill");
    for (const spec of [family.spawnTool, family.statusTool, family.killTool]) {
      expect(spec.source).toBe("builtin");
      expect(typeof spec.execute).toBe("function");
    }
    expect(spawnSchema.required).toEqual(["command"]);
    expect(statusSchema.required).toEqual(["handle"]);
    expect(killSchema.required).toEqual(["handle"]);
  });

  it("descriptions state the poll-before-acting contract and non-persistence", () => {
    const { family } = fakeFamily();
    expect(family.spawnTool.description).toContain("async_shell_command_status");
    expect(family.spawnTool.description).toContain("not persisted");
    expect(family.statusTool.description).toContain("never re-sent");
    expect(family.killTool.description).toContain("async_shell_command_status");
  });
});

// ---------------------------------------------------------------------------
// async_shell_command: validation, sandbox gate, spawn result
// ---------------------------------------------------------------------------

describe("async_shell_command validation and lifetime", () => {
  const { family } = fakeFamily();

  const badCases: readonly (readonly [string, ToolInput])[] = [
    ["a missing command", { maxLifetimeMs: 1000 }],
    ["an empty command", { command: "   " }],
    ["a zero maxLifetimeMs", { command: "ls", maxLifetimeMs: 0 }],
    ["a negative maxLifetimeMs", { command: "ls", maxLifetimeMs: -1 }],
    ["a fractional maxLifetimeMs", { command: "ls", maxLifetimeMs: 1.5 }],
    ["a non-numeric maxLifetimeMs", { command: "ls", maxLifetimeMs: "soon" }],
    ["non-string env values", { command: "ls", env: { A: 1 } }],
    ["a non-string workdir", { command: "ls", workdir: 3 }],
  ];

  for (const [name, input] of badCases) {
    it(`rejects ${name} with invalid_input`, async () => {
      const result = await family.spawnTool.execute(input, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("invalid_input");
      expect(result.error?.retryable).toBe(false);
    });
  }

  it("rejects a workdir outside the workspace and a nonexistent one", async () => {
    const outside = await family.spawnTool.execute({ command: "ls", workdir: "/tmp" }, makeCtx());
    expect(outside.error?.message).toContain("outside the workspace");
    const missing = await family.spawnTool.execute(
      { command: "ls", workdir: "no/such/dir" },
      makeCtx(),
    );
    expect(missing.error?.message).toContain("does not exist");
  });

  it("defaults the lifetime to 30 min and clamps to the 4 h cap", async () => {
    const longRun: readonly PlanEvent[] = [{ atMs: 60_000, exit: 0 }];
    const withDefault = fakeFamily(longRun);
    const result = await withDefault.family.spawnTool.execute({ command: "sleep 60" }, makeCtx());
    expect(text(result)).toContain(`max lifetime: ${DEFAULT_MAX_LIFETIME_MS}ms`);
    const clamped = await withDefault.family.spawnTool.execute(
      { command: "sleep 60", maxLifetimeMs: 99_999_999 },
      makeCtx(),
    );
    expect(text(clamped)).toContain(`max lifetime: ${MAX_LIFETIME_MS}ms`);
  });

  it("honours the VOID_ASYNC_MAX_LIFETIME_MS env override and rejects a malformed one", async () => {
    const { family: envFamily } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    const ok = await envFamily.spawnTool.execute(
      { command: "sleep 60" },
      makeCtx({ env: { PATH: "/usr/bin:/bin", VOID_ASYNC_MAX_LIFETIME_MS: "60000" } }),
    );
    expect(text(ok)).toContain("max lifetime: 60000ms");
    const bad = await envFamily.spawnTool.execute(
      { command: "sleep 60" },
      makeCtx({ env: { PATH: "/usr/bin:/bin", VOID_ASYNC_MAX_LIFETIME_MS: "soon" } }),
    );
    expect(bad.error?.code).toBe("invalid_input");
    expect(bad.error?.message).toContain("VOID_ASYNC_MAX_LIFETIME_MS");
    expect(bad.error?.message).toContain("asyncShell.maxLifetimeMs");
  });
});

describe("async_shell_command spawn behaviour", () => {
  it("returns a handle immediately for a still-running process", async () => {
    const { family } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    const started = Date.now();
    const result = await family.spawnTool.execute({ command: "sleep 60" }, makeCtx());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBe(false);
    const output = text(result);
    expect(output).toMatch(/handle: as_[A-Za-z0-9_-]+/);
    expect(output).toContain("pid: 4242");
    expect(output).toContain("in the OS sandbox");
    expect(output).toContain("hint: poll async_shell_command_status");
    expect(family.openHandles()).toEqual([handleOf(result)]);
  });

  it("merges the minimal env and never leaks VOID_ALLOW_UNSANDBOXED", async () => {
    const { family, fake } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    await family.spawnTool.execute(
      { command: "ls", env: { FOO: "bar" } },
      makeCtx({
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/example", VOID_ALLOW_UNSANDBOXED: "1" },
      }),
    );
    const req = fake.requests[0];
    if (req === undefined) {
      throw new Error("spawner was not called");
    }
    expect(req.cwd).toBe(workspace);
    expect(req.workspaceRoot).toBe(workspace);
    expect(req.env.FOO).toBe("bar");
    expect(req.env.PATH).toBe("/usr/bin:/bin");
    expect(req.env.HOME).toBe("/Users/example");
    expect(req.env.TMPDIR).toBe(req.tempDir);
    expect(req.env.VOID_ALLOW_UNSANDBOXED).toBeUndefined();
  });

  it("fails sandbox_blocked with guidance when no sandbox binary exists", async () => {
    const { fake } = fakeFamily([]);
    const gated = createAsyncShellTools({
      detect: noSandboxDetection,
      spawn: fake.spawn,
      spawnDirect: fake.spawnDirect,
    });
    liveFamilies.push(gated);
    const result = await gated.spawnTool.execute({ command: "ls" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("sandbox_blocked");
    expect(text(result)).toContain("sandbox-exec");
    expect(text(result)).toContain("VOID_ALLOW_UNSANDBOXED");
    expect(fake.requests).toHaveLength(0);
  });

  it("runs unsandboxed ONLY with VOID_ALLOW_UNSANDBOXED=1, with a loud marker", async () => {
    const { fake } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    const gated = createAsyncShellTools({
      detect: noSandboxDetection,
      spawn: fake.spawn,
      spawnDirect: fake.spawnDirect,
    });
    liveFamilies.push(gated);
    const result = await gated.spawnTool.execute(
      { command: "ls" },
      makeCtx({ env: { PATH: "/usr/bin:/bin", VOID_ALLOW_UNSANDBOXED: "1" } }),
    );
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("[VOID] UNSANDBOXED EXECUTION");
    expect(fake.requests).toHaveLength(1);
  });

  it("maps spawner failures to structured errors", async () => {
    const throwing = createAsyncShellTools({
      detect: () => presentDetection(),
      spawn: (): AsyncSpawnOutcome => {
        throw new Error("spawn ENOENT");
      },
    });
    liveFamilies.push(throwing);
    const failed = await throwing.spawnTool.execute({ command: "ls" }, makeCtx());
    expect(failed.error?.code).toBe("execution_failed");
    expect(failed.error?.message).toContain("spawn ENOENT");

    const unavailable = createAsyncShellTools({
      detect: () => presentDetection(),
      spawn: (): AsyncSpawnOutcome => {
        throw new SandboxUnavailableError("no OS sandbox binary found");
      },
    });
    liveFamilies.push(unavailable);
    const blocked = await unavailable.spawnTool.execute({ command: "ls" }, makeCtx());
    expect(blocked.error?.code).toBe("sandbox_blocked");
  });

  it("returns execution_failed when the temp dir cannot be created", async () => {
    const { family } = fakeFamily([]);
    const notADir = join(workspace, "not-a-dir.txt");
    writeFileSync(notADir, "x");
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = notADir;
    try {
      const result = await family.spawnTool.execute({ command: "ls" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("execution_failed");
      expect(result.error?.message).toContain("temp dir");
    } finally {
      if (prevTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = prevTmp;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// async_shell_command_status: cursor, waitMs, truncation, buffer cap
// ---------------------------------------------------------------------------

describe("async_shell_command_status cursor model", () => {
  it("delivers disjoint incremental slices, then drains and consumes on exit", async () => {
    const { family } = fakeFamily([
      { atMs: 0, write: "alpha\n" },
      { atMs: 250, write: "beta\n" },
      { atMs: 700, exit: 0 },
    ]);
    const spawn = await family.spawnTool.execute({ command: "tail -f log" }, makeCtx());
    const handle = handleOf(spawn);

    const first = await family.statusTool.execute({ handle }, makeCtx());
    expect(text(first)).toContain("alpha");
    expect(text(first)).not.toContain("beta");
    expect(text(first)).toContain("state: running");

    await sleep(320); // beta written, process still running (exits at 700ms)
    const second = await family.statusTool.execute({ handle }, makeCtx());
    expect(text(second)).toContain("beta");
    expect(text(second)).not.toContain("alpha"); // cursor never re-sends
    expect(text(second)).toContain("state: running");

    await sleep(450); // exit has happened
    const third = await family.statusTool.execute({ handle }, makeCtx());
    expect(text(third)).toContain("state: exited (exit code 0)");
    expect(text(third)).toContain("handle closed");
    expect(family.openHandles()).toEqual([]);

    const fourth = await family.statusTool.execute({ handle }, makeCtx());
    expect(fourth.error?.code).toBe("not_found");
    expect(fourth.error?.message).toContain("not persisted");
  });

  it("waitMs blocks until new output arrives, then a final poll drains the exit", async () => {
    const { family } = fakeFamily([
      { atMs: 350, write: "late\n" },
      { atMs: 550, exit: 3 },
    ]);
    const handle = handleOf(await family.spawnTool.execute({ command: "x" }, makeCtx()));
    const started = Date.now();
    const waited = await family.statusTool.execute({ handle, waitMs: 2_000 }, makeCtx());
    // Woken by the write at ~350ms — well before the 2s budget and before exit.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(text(waited)).toContain("late");
    const final = await family.statusTool.execute({ handle, waitMs: 1_000 }, makeCtx());
    expect(text(final)).toContain("state: exited (exit code 3)"); // non-zero exit is an observation
    expect(text(final)).toContain("handle closed");
  });

  it("waitMs returns as soon as output arrives instead of burning the budget", async () => {
    const { family } = fakeFamily([{ atMs: 100, write: "quick\n", exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "x" }, makeCtx()));
    const started = Date.now();
    const result = await family.statusTool.execute({ handle, waitMs: 10_000 }, makeCtx());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(text(result)).toContain("quick");
  });

  it("reports no new output without erroring", async () => {
    const { family } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "x" }, makeCtx()));
    const result = await family.statusTool.execute({ handle }, makeCtx());
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("(none)");
  });

  it("truncates at the section cap and continues exactly where it stopped", async () => {
    // Six 100-byte runs of the same digit: each poll delivers exactly one run.
    const write = Array.from({ length: 6 }, (_, i) => String(i % 10).repeat(100)).join("");
    const { family } = fakeFamily([{ atMs: 0, write, exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "cat big" }, makeCtx()));
    const limits = { maxTotalChars: 100_000, maxSectionChars: 100 };

    const first = await family.statusTool.execute({ handle }, makeCtx({ outputLimits: limits }));
    const firstBlock = first.content[first.content.length - 1];
    expect(firstBlock?.truncated).toBe(true);
    expect(firstBlock?.text).toContain("0000000000");
    expect(firstBlock?.text).toContain(
      "[truncated at 100 bytes; more output remains — poll again]",
    );
    expect(firstBlock?.text).not.toContain("1111111111");

    const second = await family.statusTool.execute({ handle }, makeCtx({ outputLimits: limits }));
    const secondBlock = second.content[second.content.length - 1];
    expect(secondBlock?.text).toContain("1111111111");
    expect(secondBlock?.text).not.toContain("0000000000"); // the cursor advanced past run 0
  });

  it("never splits a UTF-8 sequence at a truncation boundary", async () => {
    const { family } = fakeFamily([{ atMs: 0, write: "é".repeat(600), exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "cat unicode" }, makeCtx()));
    const result = await family.statusTool.execute(
      { handle },
      makeCtx({ outputLimits: { maxTotalChars: 100_000, maxSectionChars: 7 } }),
    );
    const block = result.content[result.content.length - 1];
    expect(block?.truncated).toBe(true);
    expect(block?.text).toContain("ééé"); // 6 bytes survive, not a broken char
    expect(block?.text).toContain("[truncated at 6 bytes");
  });

  it("drops the OLDEST bytes with a loud marker when the 1 MiB cap overflows", async () => {
    const chunk = MAX_PENDING_BYTES / 2; // 512 KiB runs: A, B, T = 1.5 MiB pending
    const write = "A".repeat(chunk) + "B".repeat(chunk) + "T".repeat(chunk);
    const { family } = fakeFamily([{ atMs: 0, write, exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "flood" }, makeCtx()));
    const result = await family.statusTool.execute({ handle }, makeCtx());
    const output = text(result);
    expect(output).toContain("dropped the oldest 524288 bytes");
    expect(output).toContain("total dropped so far: 524288");
    expect(output).toContain("BBBB"); // the retained window begins mid-stream
    expect(output).not.toContain("AAAA"); // the oldest run was dropped, not delivered
    expect(output).not.toContain("TTTT"); // still pending for later polls
  });

  it("validates handle and waitMs inputs", async () => {
    const { family } = fakeFamily([]);
    const badHandle = await family.statusTool.execute({ handle: "as_bad!/rm" }, makeCtx());
    expect(badHandle.error?.code).toBe("invalid_input");
    expect(badHandle.error?.message).toContain("[A-Za-z0-9_-]");
    const missing = await family.statusTool.execute({}, makeCtx());
    expect(missing.error?.code).toBe("invalid_input");
    const badWait = await family.statusTool.execute({ handle: "as_ok", waitMs: -5 }, makeCtx());
    expect(badWait.error?.code).toBe("invalid_input");
    const unknown = await family.statusTool.execute({ handle: "as_nope" }, makeCtx());
    expect(unknown.error?.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// async_shell_command_kill
// ---------------------------------------------------------------------------

describe("async_shell_command_kill", () => {
  it("TERMs a running group, keeps the handle open for draining", async () => {
    const { family, fake } = fakeFamily([{ atMs: 60_000, exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "sleep 60" }, makeCtx()));

    const kill = await family.killTool.execute({ handle }, makeCtx());
    expect(kill.isError).toBe(false);
    expect(fake.signals[0]).toBe("SIGTERM");
    expect(text(kill)).toContain("died within the 3s SIGTERM grace");
    expect(text(kill)).toContain("killed by signal SIGTERM — killed by async_shell_command_kill");
    expect(family.openHandles()).toEqual([handle]); // still open until drained

    const drain = await family.statusTool.execute({ handle }, makeCtx());
    expect(text(drain)).toContain("handle closed");
    expect(family.openHandles()).toEqual([]);
  });

  it("is a no-op observation for an already-exited process", async () => {
    const { family, fake } = fakeFamily([{ atMs: 10, exit: 0 }]);
    const handle = handleOf(await family.spawnTool.execute({ command: "true" }, makeCtx()));
    await sleep(150);
    const kill = await family.killTool.execute({ handle }, makeCtx());
    expect(kill.isError).toBe(false);
    expect(fake.signals).toHaveLength(0);
    expect(text(kill)).toContain("already exited");
    expect(text(kill)).toContain("exit code 0");
  });

  it("validates the handle and reports unknown handles as not_found", async () => {
    const { family } = fakeFamily([]);
    const invalid = await family.killTool.execute({ handle: "bad handle" }, makeCtx());
    expect(invalid.error?.code).toBe("invalid_input");
    const unknown = await family.killTool.execute({ handle: "as_ghost" }, makeCtx());
    expect(unknown.error?.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Open-handle cap
// ---------------------------------------------------------------------------

describe("open-handle cap", () => {
  it("evicts the oldest handle loudly when a fourth spawn arrives", async () => {
    const ids = ["h1", "h2", "h3", "h4"];
    let next = 0;
    const { family } = fakeFamily([{ atMs: 60_000, exit: 0 }], {
      newHandleId: () => ids[next++] ?? "hx",
    });
    const one = handleOf(await family.spawnTool.execute({ command: "sleep 60" }, makeCtx()));
    await family.spawnTool.execute({ command: "sleep 60" }, makeCtx());
    await family.spawnTool.execute({ command: "sleep 60" }, makeCtx());
    expect(family.openHandles()).toHaveLength(MAX_OPEN_HANDLES);

    const fourth = await family.spawnTool.execute({ command: "sleep 60" }, makeCtx());
    expect(fourth.isError).toBe(false);
    expect(text(fourth)).toContain(`open-handle cap (${MAX_OPEN_HANDLES}) exceeded`);
    expect(text(fourth)).toContain(one); // the oldest handle is named loudly
    expect(family.openHandles()).toEqual(["as_h2", "as_h3", "as_h4"]);

    const evicted = await family.statusTool.execute({ handle: one }, makeCtx());
    expect(evicted.error?.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Composition: the runner registers the family behind the permission gate
// ---------------------------------------------------------------------------

describe("async shell registry composition", () => {
  it("registers all three tools in buildToolRegistry, gated by the default rules", async () => {
    const registry = buildToolRegistry(buildPermissionGate());
    expect(registry.has("async_shell_command")).toBe(true);
    expect(registry.has("async_shell_command_status")).toBe(true);
    expect(registry.has("async_shell_command_kill")).toBe(true);
    expect(registry.has("bash")).toBe(true);

    // Allowed through the gate (read-only prefix) and executes the real tool.
    const allowed = await registry
      .get("async_shell_command_status")
      ?.execute({ handle: "as_composition" }, makeCtx());
    expect(allowed?.isError).toBe(true);
    expect(allowed?.error?.code).toBe("not_found"); // gate passed; tool answered

    // Rejected by the gate (catastrophic command) and never executes.
    const rejected = await registry
      .get("async_shell_command")
      ?.execute({ command: "rm -rf ~/" }, makeCtx());
    expect(rejected?.isError).toBe(true);
    expect(rejected?.error?.code).toBe("permission_denied");
  });
});

// ---------------------------------------------------------------------------
// Real macOS sandbox end-to-end (Bun only — needs Bun.spawn + sandbox-exec)
// ---------------------------------------------------------------------------

const onMacosSandbox =
  typeof Bun !== "undefined" &&
  process.platform === "darwin" &&
  whichBinary("sandbox-exec") !== null;

describe.skipIf(!onMacosSandbox)("async shell end-to-end on macOS (real sandbox)", () => {
  it("spawns sleep+echo and returns the handle immediately", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const started = Date.now();
    const result = await family.spawnTool.execute(
      { command: "echo first; sleep 2; echo second" },
      makeCtx(),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBe(false);
    const output = text(result);
    expect(output).toMatch(/handle: as_[A-Za-z0-9_-]+/);
    expect(output).toMatch(/pid: \d+/);
  });

  it("delivers disjoint slices across polls and drains on exit", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const handle = handleOf(
      await family.spawnTool.execute(
        { command: "echo one; sleep 0.8; echo two; sleep 0.8; echo three" },
        makeCtx(),
      ),
    );

    const first = await family.statusTool.execute({ handle, waitMs: 500 }, makeCtx());
    expect(text(first)).toContain("one");
    expect(text(first)).not.toContain("two");

    await sleep(1_000);
    const second = await family.statusTool.execute({ handle }, makeCtx());
    expect(text(second)).toContain("two");
    expect(text(second)).not.toContain("one");

    const final = await family.statusTool.execute({ handle, waitMs: 3_000 }, makeCtx());
    expect(text(final)).toContain("three");
    expect(text(final)).toContain("state: exited (exit code 0)");
    expect(text(final)).toContain("handle closed");
    const gone = await family.statusTool.execute({ handle }, makeCtx());
    expect(gone.error?.code).toBe("not_found");
  });

  it("interleaves stdout and stderr by arrival", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const handle = handleOf(
      await family.spawnTool.execute({ command: "echo A; echo B 1>&2; echo C" }, makeCtx()),
    );
    const result = await family.statusTool.execute({ handle, waitMs: 2_000 }, makeCtx());
    const output = text(result);
    const [a, b, c] = [output.indexOf("A"), output.indexOf("B"), output.indexOf("C")];
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("waitMs blocks for more output", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const handle = handleOf(
      await family.spawnTool.execute({ command: "sleep 0.5; echo late" }, makeCtx()),
    );
    const started = Date.now();
    const result = await family.statusTool.execute({ handle, waitMs: 3_000 }, makeCtx());
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(text(result)).toContain("late");
  });

  it("kill terminates the whole process group", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const spawn = await family.spawnTool.execute({ command: "sleep 30 & sleep 30" }, makeCtx());
    const handle = handleOf(spawn);
    const pid = Number(/pid: (\d+)/.exec(text(spawn))?.[1] ?? 0);
    expect(pid).toBeGreaterThan(1);

    const kill = await family.killTool.execute({ handle }, makeCtx());
    expect(kill.isError).toBe(false);
    expect(text(kill)).toContain("state after kill: exited");
    expect(() => process.kill(pid, 0)).toThrow(); // the shell itself is gone
  });

  it("enforces the lifetime cap with the TERM → KILL escalation", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const handle = handleOf(
      await family.spawnTool.execute({ command: "sleep 30", maxLifetimeMs: 400 }, makeCtx()),
    );
    const deadline = Date.now() + 4_000;
    let state = "";
    while (Date.now() < deadline) {
      const result = await family.statusTool.execute({ handle, waitMs: 500 }, makeCtx());
      state = text(result);
      if (state.includes("exited")) {
        break;
      }
    }
    expect(state).toContain("max lifetime exceeded");
    expect(state).toContain("killed by signal");
  });

  it("blocks writes outside the workspace but allows writes inside it", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const blocked = handleOf(
      await family.spawnTool.execute(
        { command: "touch /private/tmp/void-async-blocked" },
        makeCtx(),
      ),
    );
    const blockedResult = await family.statusTool.execute(
      { handle: blocked, waitMs: 2_000 },
      makeCtx(),
    );
    const blockedText = text(blockedResult);
    expect(blockedText).toContain("Operation not permitted");
    expect(blockedText).not.toContain("exit code 0");
    expect(existsSync("/private/tmp/void-async-blocked")).toBe(false);

    const inside = handleOf(
      await family.spawnTool.execute({ command: "echo content > async-file.txt" }, makeCtx()),
    );
    const insideResult = await family.statusTool.execute(
      { handle: inside, waitMs: 2_000 },
      makeCtx(),
    );
    expect(text(insideResult)).toContain("state: exited (exit code 0)");
    expect(existsSync(join(workspace, "async-file.txt"))).toBe(true);
  });

  it("evicts the oldest handle loudly at the 3-handle cap", async () => {
    const family = createAsyncShellTools();
    liveFamilies.push(family);
    const one = handleOf(await family.spawnTool.execute({ command: "sleep 10" }, makeCtx()));
    await family.spawnTool.execute({ command: "sleep 10" }, makeCtx());
    await family.spawnTool.execute({ command: "sleep 10" }, makeCtx());
    const fourth = await family.spawnTool.execute({ command: "sleep 10" }, makeCtx());
    expect(text(fourth)).toContain("open-handle cap (3) exceeded");
    expect(text(fourth)).toContain(one);
    expect(family.openHandles()).toHaveLength(3);
    expect(family.openHandles()).not.toContain(one);
  });
});
