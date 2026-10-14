/**
 * Sandboxed command execution: spawn a shell command under the OS sandbox
 * (sandbox-exec on macOS, bwrap on Linux), capture output, enforce timeouts
 * by killing the whole process group.
 *
 * ADR-0002 property 3: no sandbox binary -> no execution. `runSandboxed`
 * throws `SandboxUnavailableError` (with install guidance) rather than ever
 * running a command unsandboxed; the explicit, loud opt-out lives one layer
 * up in `tools/bash.ts` (VOID_ALLOW_UNSANDBOXED=1 -> `runUnsandboxed`).
 *
 * Process-group semantics: children are spawned `detached: true`, which
 * calls setsid(2) — the child becomes its own process-group leader, so
 * `kill(-pid)` reaches the shell and every descendant. On timeout the group
 * gets SIGTERM, then SIGKILL after a 3s grace; and when the SIGKILL fires
 * the stdout/stderr pipe handles are DESTROYED (stream cancel + settle), so
 * a grandchild that double-setsid'd out of the process group and still
 * holds the pipes cannot keep the capture pending forever — the run
 * resolves within timeout + grace with the output collected so far
 * (verified empirically; see the escaped-grandchild timeout test).
 *
 * Shell form: `/bin/bash -c <command>` (via the platform sandbox binary).
 * A login shell (-l) is deliberately NOT used: it sources /etc/profile and
 * ~/.profile, adding startup side effects and latency a scripted command
 * does not need; -c is the standard non-interactive form.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSandbox, SANDBOX_INSTALL_GUIDANCE } from "./detect";
import { buildBwrapArgs } from "./linux";
import { generateMacosProfile } from "./macos";
import { canonicalPath } from "./paths";

export interface SandboxRunOptions {
  /** Workspace root: the primary writable area in the sandbox. */
  readonly workspaceRoot: string;
  /**
   * Writable temp dir. macOS: defaults to the canonical per-user temp base.
   * Linux: never the host /tmp — when omitted, a per-call mkdtemp under
   * os.tmpdir() is created, bound exactly, and removed after the run
   * (see runSandboxed).
   */
  readonly tempDir?: string;
  /** Allow outbound network (default false; listening stays denied on macOS). */
  readonly allowNetwork?: boolean;
  /** Kill the process group after this long; default 30s. */
  readonly timeoutMs?: number;
  /** Working directory for the command; defaults to workspaceRoot. */
  readonly cwd?: string;
  /**
   * Environment for the command. When omitted, a minimal default env is used
   * (PATH + TMPDIR) — the parent environment is never implicitly inherited.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxRunResult {
  /** Process exit code; null when the process died to a signal (timeout kill). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** No usable OS sandbox on this machine; the command was NOT executed. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** The sandboxed process could not be spawned at the OS level. */
export class CommandSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandSpawnError";
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 3_000;

const MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** node:child_process under both runtimes (Bun implements it natively) — the
 * sandbox runner must stay runtime-agnostic so Node-vitest executes the real
 * sandbox paths instead of failing on a Bun-only global (review follow-up to
 * the settings merge: macOS tests had passed VACUOUSLY because the spawn
 * error contained "sandbox-exec" and tripped the defensive guards). */
type SandboxedSubprocess = ChildProcess;

function signalGroup(proc: SandboxedSubprocess, signal: NodeJS.Signals): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Process group already gone.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited.
  }
}

/** Resolves with the exit code (null when killed by a signal) — node's
 * "exit" event equivalent of Bun's `proc.exited`/`exitCode`. */
function exitedWithCode(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    proc.once("exit", (code) => resolve(code));
  });
}

/**
 * One subprocess output pipe being captured incrementally. `stop()` destroys
 * the pipe handle (stream cancel): a pending read resolves as done, the
 * accumulated text settles, and a process still holding the write end
 * (e.g. a setsid grandchild that escaped the group kill) can no longer hang
 * the capture. Data already written but not yet read is best-effort.
 */
interface PipeCapture {
  readonly text: Promise<string>;
  readonly stop: () => void;
}

function capturePipe(stream: import("node:stream").Readable | null): PipeCapture {
  const parts: string[] = [];
  let settle!: (text: string) => void;
  let stopped = false;
  const text = new Promise<string>((resolve) => {
    settle = (value: string) => {
      stopped = true;
      resolve(value);
    };
  });
  if (stream !== null) {
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream) {
          if (stopped) break;
          if (chunk instanceof Uint8Array && chunk.length > 0) {
            parts.push(decoder.decode(chunk));
          }
        }
      } catch {
        // Pipe torn down mid-read (stop() destroyed it): keep what we have.
      } finally {
        settle(parts.join(""));
      }
    })();
  } else {
    settle("");
  }
  return {
    text,
    stop: () => {
      if (stopped) return;
      // Destroy the pipe handle so a pending read unblocks (a grandchild
      // holding the write end cannot hang the capture), then settle
      // immediately with everything decoded so far.
      try {
        stream?.destroy();
      } catch {
        // already closed
      }
      settle(parts.join(""));
    },
  };
}

async function spawnAndCollect(
  argv: readonly string[],
  opts: SandboxRunOptions,
  tempDir: string,
): Promise<SandboxRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env === undefined ? { PATH: MINIMAL_PATH, TMPDIR: tempDir } : { ...opts.env };
  const start = Date.now();

  let proc: SandboxedSubprocess;
  try {
    // (command, args, options) form: the bundled types accept it under both
    // runtimes; argv[0] is always present at the call sites (guarded anyway).
    proc = spawn(argv[0] ?? "/bin/sh", argv.slice(1), {
      cwd: opts.cwd ?? opts.workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"] as const,
      detached: true,
    });
  } catch (cause) {
    const binary = argv[0] ?? "<unknown>";
    throw new CommandSpawnError(`failed to spawn ${binary}: ${String(cause)}`);
  }
  const exited = exitedWithCode(proc);

  // Concurrent incremental capture; each text promise settles at pipe EOF
  // or when stop() destroys the handle.
  const stdoutCapture = capturePipe(proc.stdout);
  const stderrCapture = capturePipe(proc.stderr);

  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalGroup(proc, "SIGTERM");
    graceTimer = setTimeout(() => {
      signalGroup(proc, "SIGKILL");
      // Destroy the pipe handles at kill-escalation time: grandchildren that
      // escaped the process group (their own setsid) would otherwise hold
      // the capture open past the timeout forever.
      stdoutCapture.stop();
      stderrCapture.stop();
    }, KILL_GRACE_MS);
  }, timeoutMs);

  try {
    const exitCode = await exited;
    await Promise.all([stdoutCapture.text, stderrCapture.text]);
    return {
      exitCode,
      stdout: await stdoutCapture.text,
      stderr: await stderrCapture.text,
      timedOut,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
  }
}

/**
 * Run `command` inside the OS sandbox. Throws SandboxUnavailableError when
 * the platform has no sandbox binary (the caller decides how to surface it)
 * and CommandSpawnError when the sandboxed process cannot be spawned.
 */
export async function runSandboxed(
  command: string,
  opts: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const detection = detectSandbox();
  if (detection.kind === null || detection.binaryPath === null) {
    throw new SandboxUnavailableError(
      `no OS sandbox binary found (platform: ${detection.platform}); refusing to run unsandboxed. ${SANDBOX_INSTALL_GUIDANCE[detection.platform]}`,
    );
  }
  const tempDir = opts.tempDir ?? canonicalPath(tmpdir());
  if (detection.kind === "sandbox-exec") {
    const profile = generateMacosProfile({
      workspaceRoot: opts.workspaceRoot,
      tempDir,
      allowNetwork: opts.allowNetwork ?? false,
    });
    return spawnAndCollect(
      [detection.binaryPath, "-p", profile, "/bin/bash", "-c", command],
      opts,
      tempDir,
    );
  }
  // Linux posture (review minor): never bind the host /tmp wholesale — that
  // would re-expose the shared host /tmp read-write over the fresh tmpfs and
  // defeat the isolation macOS keeps via its per-user temp base. The caller's
  // per-call temp dir (tools/bash.ts always passes one) is bound exactly;
  // when a direct runSandboxed caller omits it, we create the same kind of
  // per-call mkdtemp under os.tmpdir() and remove it after the run.
  const explicitTemp = opts.tempDir;
  const perCallTemp = explicitTemp ?? mkdtempSync(join(canonicalPath(tmpdir()), "void-sandbox-"));
  try {
    return await spawnAndCollect(
      [
        detection.binaryPath,
        ...buildBwrapArgs({
          workspaceRoot: opts.workspaceRoot,
          tempDir: perCallTemp,
          allowNetwork: opts.allowNetwork ?? false,
          command,
        }),
      ],
      opts,
      perCallTemp,
    );
  } finally {
    if (explicitTemp === undefined) {
      rmSync(perCallTemp, { recursive: true, force: true });
    }
  }
}

/**
 * Run `command` with NO sandbox. Only reachable through the explicit
 * VOID_ALLOW_UNSANDBOXED=1 opt-out in tools/bash.ts — never call this as a
 * fallback because a sandbox was missing or failed (ADR-0002 property 3).
 */
export async function runUnsandboxed(
  command: string,
  opts: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const tempDir = opts.tempDir ?? canonicalPath(tmpdir());
  return spawnAndCollect(["/bin/bash", "-c", command], opts, tempDir);
}
