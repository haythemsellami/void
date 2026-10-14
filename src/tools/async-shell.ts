/**
 * Async shell tool family (ADR-0007): background commands with pollable
 * handles — `async_shell_command`, `async_shell_command_status`,
 * `async_shell_command_kill`.
 *
 * Semantics the engine relies on:
 * - `execute()` never throws; expected failures are ToolResults with
 *   structured codes: invalid_input, not_found, sandbox_blocked,
 *   execution_failed (contracts/tools.ts).
 * - `async_shell_command` returns immediately after spawn with a handle; the
 *   command keeps running sandboxed in the background under a lifetime
 *   ceiling (default 30 min, hard cap 4 h — the settings home is the key
 *   `asyncShell.maxLifetimeMs`, ADR-0006; until the settings loader lands the
 *   value comes from the maxLifetimeMs input or the
 *   VOID_ASYNC_MAX_LIFETIME_MS env).
 * - `async_shell_command_status` delivers only NEW output since the last poll
 *   (cursor model — bytes are never re-sent) plus the running state; one
 *   final poll after exit drains the rest and consumes the handle.
 * - `async_shell_command_kill` kills the process group with the same
 *   escalation as sync bash's timeout path (SIGTERM → 3 s grace → SIGKILL).
 *
 * ## Capture model: a shared append fd, not pipes
 *
 * Both stdout and stderr of the sandboxed child are THE SAME append-mode file
 * descriptor, so the OS serializes writes into one per-handle log file in
 * arrival order — interleaving that is at least as faithful as the
 * "order chunks were read from the pipes (poll granularity)" the ADR accepts.
 *
 * Pipes were ruled out empirically: a ReadableStream reader over a subprocess
 * pipe holds the host's event loop open, so a long-lived child would keep the
 * whole CLI alive after its task finished and the before-exit reap hook could
 * never fire. With fd capture + `proc.unref()` + unref'd timers, nothing here
 * holds the loop: when the CLI's own work drains, `beforeExit` fires and
 * reaps every child (best-effort; `exit` follows with a synchronous SIGKILL
 * sweep and temp-dir cleanup).
 *
 * There are also no pipes to destroy on kill: the run.ts review fix (pipe
 * destruction at KILL escalation so an escaped setsid grandchild cannot hang
 * the capture) is preserved structurally — capture is a file the parent reads
 * at poll time, so no grandchild can block it.
 *
 * ## Buffer cap and cursors
 *
 * Each handle keeps at most MAX_PENDING_BYTES (1 MiB) of written-but-undelivered
 * output: when a poll finds more pending than that, the OLDEST bytes are
 * dropped (counted loudly, surfaced as a marker in that poll's result) and the
 * cursor jumps forward — status output stays bounded no matter how chatty the
 * child is. The cursor advances by exactly the bytes delivered, so
 * OutputLimits truncation (per-poll cap with a `[truncated at N bytes]`
 * marker) defers the remainder to the next poll instead of losing or
 * re-sending it.
 *
 * ## Registry
 *
 * The handle registry is a plain in-process Map — NOT persisted. A resumed
 * thread starts no processes; every handle mentions this on lookup failure.
 * At most MAX_OPEN_HANDLES (3) stay open; starting another kills the oldest
 * and discards its unpolled output, loudly noted in the spawn result.
 */
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  OutputLimits,
  TextResultBlock,
  ToolContext,
  ToolError,
  ToolInput,
  ToolResult,
  ToolSpec,
} from "../contracts";
import { detectSandbox, SANDBOX_INSTALL_GUIDANCE, type SandboxDetection } from "../sandbox/detect";
import { buildBwrapArgs } from "../sandbox/linux";
import { generateMacosProfile } from "../sandbox/macos";
import { canonicalPath } from "../sandbox/paths";
import { SandboxUnavailableError } from "../sandbox/run";

/** Default lifetime ceiling: 30 minutes (ADR-0006 `asyncShell.maxLifetimeMs` default). */
export const DEFAULT_MAX_LIFETIME_MS = 1_800_000;
/** Hard lifetime ceiling: 4 hours. */
export const MAX_LIFETIME_MS = 14_400_000;
/** Longest a status poll may block waiting for output (ADR-0007). */
export const MAX_WAIT_MS = 30_000;
/** Open handles allowed at once; a further spawn kills the oldest (ADR-0007). */
export const MAX_OPEN_HANDLES = 3;
/** Undelivered-output window kept per handle; older bytes are dropped loudly. */
export const MAX_PENDING_BYTES = 1_048_576;

/** Grace between SIGTERM and SIGKILL — mirrors sandbox/run.ts escalation. */
const KILL_GRACE_MS = 3_000;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/usr/sbin:/sbin";
const HANDLE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const OUTPUT_LOG_NAME = "async-output.log";
/**
 * Interim lifetime override until the settings loader ships (it will map the
 * `asyncShell.maxLifetimeMs` key onto the same value).
 */
const ENV_LIFETIME_KEY = "VOID_ASYNC_MAX_LIFETIME_MS";
const UNSANDBOXED_MARKER =
  "[VOID] UNSANDBOXED EXECUTION — VOID_ALLOW_UNSANDBOXED=1 bypassed the OS sandbox for this background command.";
const NOT_PERSISTED_NOTE =
  "handles are in-process only: they are not persisted across restarts (a resumed thread starts no " +
  "processes), and a handle disappears once its process has exited and its output is fully drained.";

// ---------------------------------------------------------------------------
// Injection seams (hermetic tests; production uses the real spawners below)
// ---------------------------------------------------------------------------

/**
 * The process surface this module needs from a spawned child. Bun.Subprocess
 * satisfies it structurally; tests substitute fakes that write to the same
 * output fd.
 */
export interface AsyncSubprocessLike {
  readonly pid: number;
  /** Resolves when the process exits (exit code, or null-equivalent on signal). */
  readonly exited: Promise<number>;
  /** Exit code; null while running or when killed by a signal. */
  readonly exitCode: number | null;
  /** Terminal signal, when the process died to one. */
  readonly signalCode: NodeJS.Signals | number | null;
  kill(exitCode?: number | NodeJS.Signals): void;
}

/** What the spawner needs: the command plus where it runs and where output goes. */
export interface AsyncSpawnRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workspaceRoot: string;
  /** Per-handle temp dir (sandbox-writable; also the child's TMPDIR). */
  readonly tempDir: string;
  /** Append-mode fd: becomes BOTH stdout and stderr of the child. */
  readonly outputFd: number;
}

export interface AsyncSpawnOutcome {
  readonly proc: AsyncSubprocessLike;
  readonly unsandboxed: boolean;
}

export interface AsyncShellDeps {
  readonly detect?: () => SandboxDetection;
  readonly spawn?: (req: AsyncSpawnRequest, detection: SandboxDetection) => AsyncSpawnOutcome;
  readonly spawnDirect?: (req: AsyncSpawnRequest) => AsyncSpawnOutcome;
  readonly newHandleId?: () => string;
}

// ---------------------------------------------------------------------------
// Real spawners — identical sandbox wrappers to the bash tool
// ---------------------------------------------------------------------------

function spawnDetached(argv: readonly string[], req: AsyncSpawnRequest): AsyncSubprocessLike {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd: req.cwd,
    env: { ...req.env },
    stdin: "ignore",
    stdout: req.outputFd,
    stderr: req.outputFd,
    detached: true,
  });
  // The child must not hold the CLI's event loop: capture is fd-based, so an
  // unref'd child lets the loop drain (reap hook) while it keeps running.
  proc.unref();
  return proc;
}

/** Spawn through the OS sandbox wrapper, exactly like the bash tool's run path. */
function spawnSandboxedProcess(
  req: AsyncSpawnRequest,
  detection: SandboxDetection,
): AsyncSpawnOutcome {
  if (detection.kind === null || detection.binaryPath === null) {
    throw new SandboxUnavailableError(
      `no OS sandbox binary found (platform: ${detection.platform}); refusing to run unsandboxed. ${SANDBOX_INSTALL_GUIDANCE[detection.platform]}`,
    );
  }
  const argv =
    detection.kind === "sandbox-exec"
      ? [
          detection.binaryPath,
          "-p",
          generateMacosProfile({
            workspaceRoot: req.workspaceRoot,
            tempDir: req.tempDir,
            allowNetwork: false,
          }),
          "/bin/bash",
          "-c",
          req.command,
        ]
      : [
          detection.binaryPath,
          ...buildBwrapArgs({
            workspaceRoot: req.workspaceRoot,
            tempDir: req.tempDir,
            allowNetwork: false,
            command: req.command,
          }),
        ];
  return { proc: spawnDetached(argv, req), unsandboxed: false };
}

/** Spawn with no sandbox — only via the explicit VOID_ALLOW_UNSANDBOXED=1 opt-in. */
function spawnUnsandboxedProcess(req: AsyncSpawnRequest): AsyncSpawnOutcome {
  return { proc: spawnDetached(["/bin/bash", "-c", req.command], req), unsandboxed: true };
}

// ---------------------------------------------------------------------------
// Handle registry
// ---------------------------------------------------------------------------

type KillReason = "lifetime" | "kill-tool" | "eviction";

interface AsyncHandle {
  readonly id: string;
  readonly proc: AsyncSubprocessLike;
  readonly startedAt: number;
  readonly tempDir: string;
  readonly logPath: string;
  appendFd: number;
  readFd: number;
  /** Absolute byte offset delivered to the model so far (never re-sent). */
  cursor: number;
  /** Cumulative bytes dropped unread (buffer-cap overflow). */
  droppedBytes: number;
  running: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  killReason: KillReason | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  tornDown: boolean;
}

/** Registries of every live family instance, reaped together at process exit. */
const allRegistries = new Set<Map<string, AsyncHandle>>();
let reapHookInstalled = false;

function signalGroup(proc: AsyncSubprocessLike, signal: NodeJS.Signals): void {
  // detached: true made the child its own process-group leader, so kill(-pid)
  // reaches the shell and every descendant (same as sandbox/run.ts).
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // Process group already gone.
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited.
  }
}

function unrefTimer(ms: number, fire: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fire, ms);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function clearTimers(h: AsyncHandle): void {
  if (h.lifetimeTimer !== undefined) {
    clearTimeout(h.lifetimeTimer);
    h.lifetimeTimer = undefined;
  }
  if (h.graceTimer !== undefined) {
    clearTimeout(h.graceTimer);
    h.graceTimer = undefined;
  }
}

/** Close fds and remove the per-handle temp dir (idempotent; timers untouched). */
function releaseResources(h: AsyncHandle): void {
  if (h.tornDown) {
    return;
  }
  h.tornDown = true;
  for (const fd of [h.appendFd, h.readFd]) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
  h.appendFd = -1;
  h.readFd = -1;
  try {
    rmSync(h.tempDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function teardownHandle(h: AsyncHandle): void {
  clearTimers(h);
  releaseResources(h);
}

/** Watch for exit and snapshot the terminal state (kill/signal included). */
function watchExit(h: AsyncHandle): void {
  void h.proc.exited
    .then(() => {
      h.running = false;
      h.exitCode = h.proc.exitCode;
      h.exitSignal = h.proc.signalCode;
      clearTimers(h);
    })
    .catch(() => {
      h.running = false;
      h.exitCode = null;
      h.exitSignal = null;
      clearTimers(h);
    });
}

/**
 * Kill a handle's group in the background (TERM, KILL after the grace) and
 * drop it from its registry. Used by the open-handle cap and disposeAll;
 * the caller surfaces the eviction loudly.
 */
function evictHandle(h: AsyncHandle, registry: Map<string, AsyncHandle>, reason: KillReason): void {
  if (h.killReason === null) {
    h.killReason = reason;
  }
  const { proc, running } = h;
  registry.delete(h.id);
  teardownHandle(h);
  if (running) {
    signalGroup(proc, "SIGTERM");
    // Escalation timer only touches the captured proc; it must survive
    // teardown (which cleared the timer slots first, above).
    unrefTimer(KILL_GRACE_MS, () => {
      signalGroup(proc, "SIGKILL");
    });
  }
}

/**
 * Reap every child before the process exits. Reachable because nothing in
 * this module holds the event loop (see the capture-model note): once the
 * CLI's own work drains, beforeExit fires, we TERM everything, and the exit
 * hook guarantees the KILL plus temp-dir cleanup. Best-effort by design.
 */
function installReapHook(): void {
  if (reapHookInstalled) {
    return;
  }
  reapHookInstalled = true;
  process.on("beforeExit", () => {
    for (const registry of allRegistries) {
      for (const h of registry.values()) {
        if (h.running) {
          signalGroup(h.proc, "SIGTERM");
        }
      }
    }
  });
  process.on("exit", () => {
    for (const registry of allRegistries) {
      for (const h of registry.values()) {
        signalGroup(h.proc, "SIGKILL");
        releaseResources(h);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Output polling: UTF-8-safe slicing over the append-only log
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(lead: number): number {
  if (lead >= 0xf0) {
    return 4;
  }
  if (lead >= 0xe0) {
    return 3;
  }
  if (lead >= 0xc0) {
    return 2;
  }
  return 1;
}

/**
 * Largest end ≤ `end` such that buf[start..end) does not end inside a UTF-8
 * sequence: a writer mid-sequence at the read boundary is deferred to the
 * next poll instead of being delivered as a broken character.
 */
function utf8SafeEnd(buf: Buffer, start: number, end: number): number {
  if (end <= start) {
    return end;
  }
  let continuationRun = 0;
  while (end - 1 - continuationRun > start && isUtf8Continuation(buf[end - 1 - continuationRun])) {
    continuationRun += 1;
  }
  if (continuationRun === 0) {
    return end; // last byte is a lead byte — already a boundary
  }
  const leadIndex = end - 1 - continuationRun;
  if (leadIndex < start) {
    return start; // continuation run with no lead in range; defer everything
  }
  const expected = utf8SequenceLength(buf[leadIndex] ?? 0);
  return continuationRun + 1 < expected ? leadIndex : end;
}

function logSize(h: AsyncHandle): number {
  if (h.readFd < 0) {
    return h.cursor;
  }
  try {
    return fstatSync(h.readFd).size;
  } catch {
    return h.cursor;
  }
}

interface PollSlice {
  readonly text: string;
  readonly droppedNow: number;
  readonly truncated: boolean;
}

/**
 * Deliver the bytes written since the cursor, enforcing both per-handle and
 * per-result caps. Oldest-first drops (buffer cap) and OutputLimits
 * truncation both advance the cursor by exactly the bytes delivered or
 * discarded, so no byte is ever re-sent and truncated remainders flow into
 * the next poll.
 */
function pollOutput(h: AsyncHandle, limits: OutputLimits): PollSlice {
  const size = logSize(h);
  let droppedNow = 0;

  // Per-handle cap: keep at most MAX_PENDING_BYTES undelivered, drop oldest.
  if (size - h.cursor > MAX_PENDING_BYTES) {
    const drop = size - h.cursor - MAX_PENDING_BYTES;
    h.cursor += drop;
    h.droppedBytes += drop;
    droppedNow = drop;
  }

  const want = Math.min(size - h.cursor, MAX_PENDING_BYTES);
  if (want <= 0 || h.readFd < 0) {
    return { text: "", droppedNow, truncated: false };
  }
  const buf = Buffer.alloc(want);
  let got = 0;
  try {
    got = readSync(h.readFd, buf, 0, want, h.cursor);
  } catch {
    got = 0;
  }

  // A drop can land mid-character; skip the orphaned continuation bytes.
  let start = 0;
  while (start < got && isUtf8Continuation(buf[start])) {
    start += 1;
    h.cursor += 1;
    h.droppedBytes += 1;
    droppedNow += 1;
  }
  const end = utf8SafeEnd(buf, start, got);

  // OutputLimits cap for this result; the remainder stays pending.
  const cap = Math.max(0, limits.maxSectionChars);
  if (end - start > cap) {
    let cut = start + cap;
    while (cut > start && isUtf8Continuation(buf[cut])) {
      cut -= 1;
    }
    const text = `${buf.subarray(start, cut).toString("utf8")}\n[truncated at ${cut - start} bytes; more output remains — poll again]`;
    h.cursor += cut - start;
    return { text, droppedNow, truncated: true };
  }
  const text = buf.subarray(start, end).toString("utf8");
  h.cursor += end - start;
  return { text, droppedNow, truncated: false };
}

/** Block until new output arrives, the process exits, or the budget runs out. */
async function waitForActivity(h: AsyncHandle, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (!h.running || logSize(h) > h.cursor) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    await sleep(Math.min(20, remaining));
  }
}

/** True once the exited promise settles within `ms` (loser timer cleared). */
async function settleExit(h: AsyncHandle, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      h.proc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared result formatting
// ---------------------------------------------------------------------------

function errorResult(code: ToolError["code"], message: string, retryable: boolean): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, retryable },
  };
}

function textBlock(text: string, truncated: boolean): TextResultBlock {
  return truncated ? { type: "text", text, truncated } : { type: "text", text };
}

function unknownHandleResult(handle: string): ToolResult {
  return errorResult("not_found", `unknown handle "${handle}" — ${NOT_PERSISTED_NOTE}`, false);
}

function stateLine(h: AsyncHandle): string {
  if (h.running) {
    const uptimeMs = Math.max(0, Date.now() - h.startedAt);
    return `running (pid ${h.proc.pid}, up ${Math.round(uptimeMs / 1000)}s)`;
  }
  const code =
    h.exitCode === null
      ? `killed by signal ${String(h.exitSignal ?? "unknown")}`
      : `exit code ${h.exitCode}`;
  const reason =
    h.killReason === "lifetime"
      ? " — max lifetime exceeded; group killed (TERM → 3s → KILL)"
      : h.killReason === "kill-tool"
        ? " — killed by async_shell_command_kill"
        : h.killReason === "eviction"
          ? " — evicted by the open-handle cap"
          : "";
  return `exited (${code}${reason})`;
}

// ---------------------------------------------------------------------------
// Input parsing (mirrors the bash tool's rules)
// ---------------------------------------------------------------------------

type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolResult };

interface SpawnInput {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly workdir: string;
}

/** Same rules as the bash tool's workdir: existing directory inside the workspace. */
function resolveWorkdir(
  workdir: string | undefined,
  root: string,
): { readonly dir: string } | { readonly problem: string } {
  const candidate =
    workdir === undefined ? root : isAbsolute(workdir) ? workdir : resolve(root, workdir);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { problem: `workdir does not exist: ${candidate}` };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { problem: `workdir is not a directory: ${real}` };
    }
  } catch {
    return { problem: `workdir is not accessible: ${real}` };
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    return {
      problem: `workdir is outside the workspace: ${real} (workspace root: ${root}); use a directory inside the workspace`,
    };
  }
  return { dir: real };
}

function lifetimeFromEnv(env: Readonly<Record<string, string>>): ParseOutcome<number | undefined> {
  const raw = env[ENV_LIFETIME_KEY];
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: errorResult(
        "invalid_input",
        `${ENV_LIFETIME_KEY} must be a positive integer (milliseconds) — got ${JSON.stringify(raw)}. ` +
          `This is the interim env form of the settings key asyncShell.maxLifetimeMs.`,
        false,
      ),
    };
  }
  return { ok: true, value: parsed };
}

function parseSpawnInput(input: ToolInput, root: string): ParseOutcome<SpawnInput> {
  const { command } = input;
  if (typeof command !== "string" || command.trim().length === 0) {
    return {
      ok: false,
      error: errorResult("invalid_input", "input.command must be a non-empty string", false),
    };
  }

  const rawEnv = input.env;
  const env: Record<string, string> = {};
  if (rawEnv !== undefined) {
    if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
      return {
        ok: false,
        error: errorResult("invalid_input", "input.env must be an object of string values", false),
      };
    }
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: errorResult(
            "invalid_input",
            `input.env[${key}] must be a string (got ${typeof value})`,
            false,
          ),
        };
      }
      env[key] = value;
    }
  }

  const rawWorkdir = input.workdir;
  if (rawWorkdir !== undefined && typeof rawWorkdir !== "string") {
    return {
      ok: false,
      error: errorResult("invalid_input", "input.workdir must be a string", false),
    };
  }
  const workdir = resolveWorkdir(rawWorkdir, root);
  if ("problem" in workdir) {
    return { ok: false, error: errorResult("invalid_input", workdir.problem, false) };
  }

  return {
    ok: true,
    value: { command, env, workdir: workdir.dir },
  };
}

// ---------------------------------------------------------------------------
// Tool family factory
// ---------------------------------------------------------------------------

/** The three async tools plus test aids (`openHandles`, `disposeAll`). */
export interface AsyncShellTools {
  readonly spawnTool: ToolSpec;
  readonly statusTool: ToolSpec;
  readonly killTool: ToolSpec;
  /** Open handle ids, oldest first. */
  openHandles(): readonly string[];
  /** Kill and tear down every handle of this family (tests, teardown). */
  disposeAll(): void;
}

const SPAWN_DESCRIPTION =
  "Run a shell command in the background (dev servers, watchers, long test runs) and get a " +
  "handle back immediately instead of waiting for it to finish. Runs through the same OS sandbox " +
  "as the bash tool: file writes limited to the workspace and temp dirs, network denied. Poll " +
  "async_shell_command_status for new output BEFORE acting on it — output you never poll is lost " +
  "when the handle closes or the 1 MiB output cap drops the oldest bytes. Stop a process with " +
  "async_shell_command_kill. At most 3 handles stay open (starting a 4th kills the oldest), and " +
  "every process is killed after maxLifetimeMs (default 30 min, hard cap 4 h; settings key " +
  "asyncShell.maxLifetimeMs). Handles are not persisted — resuming a conversation starts no processes.";

const STATUS_DESCRIPTION =
  "Fetch the output a background handle produced SINCE your last poll (already-polled output is " +
  "never re-sent) plus its running state and exit code. Optionally block briefly (waitMs, max " +
  "30000) waiting for more output or exit. When the process has exited, one final call returns " +
  "the remaining output and closes the handle. Poll before acting: only 1 MiB of undelivered " +
  "output is kept per handle — beyond that the OLDEST bytes are dropped, and the poll that sees " +
  "the drop says so with a loud marker.";

const KILL_DESCRIPTION =
  "Stop a background process started with async_shell_command: the whole process group receives " +
  "SIGTERM, escalating to SIGKILL after a 3-second grace. Returns the final state. The handle " +
  "stays open — call async_shell_command_status once more to drain any remaining output.";

/**
 * Build the async tool family sharing one in-process registry. Production
 * imports the prebuilt specs below (a single shared registry); tests build
 * isolated families with injected spawners.
 */
export function createAsyncShellTools(deps: AsyncShellDeps = {}): AsyncShellTools {
  const detect: () => SandboxDetection = deps.detect ?? detectSandbox;
  const spawn = deps.spawn ?? spawnSandboxedProcess;
  const spawnDirect = deps.spawnDirect ?? spawnUnsandboxedProcess;
  const newHandleId: () => string =
    deps.newHandleId ?? ((): string => crypto.randomUUID().replace(/-/g, "").slice(0, 12));

  const registry = new Map<string, AsyncHandle>();
  allRegistries.add(registry);

  function parseHandle(input: ToolInput): ParseOutcome<string> {
    const { handle } = input;
    if (typeof handle !== "string" || !HANDLE_ID_PATTERN.test(handle)) {
      return {
        ok: false,
        error: errorResult(
          "invalid_input",
          "input.handle must be a handle string returned by async_shell_command " +
            "(non-empty, characters [A-Za-z0-9_-] only)",
          false,
        ),
      };
    }
    return { ok: true, value: handle };
  }

  const spawnTool: ToolSpec = {
    name: "async_shell_command",
    description: SPAWN_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run in the background (executed by /bin/bash -c).",
        },
        workdir: {
          type: "string",
          description:
            "Working directory for the command: absolute or relative to the workspace root. " +
            "Must be inside the workspace; defaults to the workspace root.",
        },
        maxLifetimeMs: {
          type: "number",
          description:
            "Kill the process group after this many milliseconds even if it is still healthy. " +
            `Default ${DEFAULT_MAX_LIFETIME_MS} (30 min), capped at ${MAX_LIFETIME_MS} (4 h); ` +
            "overrides the asyncShell.maxLifetimeMs setting.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Extra environment variables for the command, merged over the minimal inherited " +
            "environment (PATH, HOME, TMPDIR).",
        },
      },
      required: ["command"],
    },
    source: "builtin",
    async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const root = canonicalPath(ctx.workspaceRoot);

      const rawLifetime = input.maxLifetimeMs;
      if (
        rawLifetime !== undefined &&
        (typeof rawLifetime !== "number" || !Number.isInteger(rawLifetime) || rawLifetime <= 0)
      ) {
        return errorResult(
          "invalid_input",
          "input.maxLifetimeMs must be a positive integer (milliseconds)",
          false,
        );
      }
      const fromEnv = lifetimeFromEnv(ctx.env);
      if (!fromEnv.ok) {
        return fromEnv.error;
      }
      const effectiveLifetime = Math.min(
        rawLifetime ?? fromEnv.value ?? DEFAULT_MAX_LIFETIME_MS,
        MAX_LIFETIME_MS,
      );

      const parsed = parseSpawnInput(input, root);
      if (!parsed.ok) {
        return parsed.error;
      }
      const { command, env, workdir } = parsed.value;

      const detection = detect();
      const unsandboxedOptIn = ctx.env.VOID_ALLOW_UNSANDBOXED === "1";
      const sandboxMissing = detection.kind === null || detection.binaryPath === null;
      if (sandboxMissing && !unsandboxedOptIn) {
        return errorResult(
          "sandbox_blocked",
          `OS sandbox unavailable (platform: ${detection.platform}); Void refuses to run shell commands unsandboxed. ${SANDBOX_INSTALL_GUIDANCE[detection.platform]}`,
          false,
        );
      }
      installReapHook();

      // Per-handle temp dir: the child's TMPDIR, the sandbox-writable scratch
      // area, and the home of the output log. Removed when the handle closes.
      let tempDir: string;
      try {
        tempDir = mkdtempSync(join(canonicalPath(tmpdir()), "void-async-"));
      } catch (err) {
        return errorResult(
          "execution_failed",
          `failed to create a per-handle temp dir under ${canonicalPath(tmpdir())}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }
      const logPath = join(tempDir, OUTPUT_LOG_NAME);
      let appendFd: number;
      try {
        appendFd = openSync(logPath, "a");
      } catch (err) {
        rmSync(tempDir, { recursive: true, force: true });
        return errorResult(
          "execution_failed",
          `failed to open the output log at ${logPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }

      const childEnv: Record<string, string> = {
        // Minimal inherited env from ctx.env (never implicitly process.env).
        PATH: ctx.env.PATH ?? FALLBACK_PATH,
        ...(ctx.env.HOME === undefined ? {} : { HOME: ctx.env.HOME }),
        TMPDIR: tempDir,
        ...env,
      };
      const req: AsyncSpawnRequest = {
        command,
        cwd: workdir,
        env: childEnv,
        workspaceRoot: root,
        tempDir,
        outputFd: appendFd,
      };

      let outcome: AsyncSpawnOutcome;
      try {
        outcome = sandboxMissing ? spawnDirect(req) : spawn(req, detection);
      } catch (cause) {
        try {
          closeSync(appendFd);
        } catch {
          // Already closed.
        }
        rmSync(tempDir, { recursive: true, force: true });
        if (cause instanceof SandboxUnavailableError) {
          return errorResult("sandbox_blocked", cause.message, false);
        }
        return errorResult(
          "execution_failed",
          `failed to start the background command: ${cause instanceof Error ? cause.message : String(cause)}`,
          false,
        );
      }

      const id = `as_${newHandleId()}`;
      const handle: AsyncHandle = {
        id,
        proc: outcome.proc,
        startedAt: Date.now(),
        tempDir,
        logPath,
        appendFd,
        readFd: -1,
        cursor: 0,
        droppedBytes: 0,
        running: true,
        exitCode: null,
        exitSignal: null,
        killReason: null,
        lifetimeTimer: undefined,
        graceTimer: undefined,
        tornDown: false,
      };
      try {
        handle.readFd = openSync(logPath, "r");
      } catch (err) {
        teardownHandle(handle);
        return errorResult(
          "execution_failed",
          `failed to open the output log for reading at ${logPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }

      // Enforce the open-handle cap: kill the OLDEST loudly and note it here.
      let evicted: string | null = null;
      while (registry.size >= MAX_OPEN_HANDLES) {
        const oldestId = registry.keys().next().value;
        if (oldestId === undefined) {
          break;
        }
        const oldest = registry.get(oldestId);
        if (oldest === undefined) {
          break;
        }
        evictHandle(oldest, registry, "eviction");
        evicted = oldestId;
      }

      registry.set(id, handle);
      watchExit(handle);
      handle.lifetimeTimer = unrefTimer(effectiveLifetime, () => {
        if (!handle.running || handle.tornDown) {
          return;
        }
        handle.killReason = "lifetime";
        signalGroup(handle.proc, "SIGTERM");
        handle.graceTimer = unrefTimer(KILL_GRACE_MS, () => {
          if (handle.running) {
            signalGroup(handle.proc, "SIGKILL");
          }
        });
      });

      const content: TextResultBlock[] = [];
      if (outcome.unsandboxed) {
        content.push(textBlock(UNSANDBOXED_MARKER, false));
      }
      content.push(
        textBlock(
          `started background command${
            outcome.unsandboxed ? "" : " in the OS sandbox (workspace-write, network denied)"
          }\nhandle: ${id}\npid: ${outcome.proc.pid}\nmax lifetime: ${effectiveLifetime}ms (then TERM → 3s → KILL)\nhint: poll async_shell_command_status for NEW output before acting on it — unpolled output is lost when the handle closes or the output cap drops the oldest bytes.`,
          false,
        ),
      );
      if (evicted !== null) {
        content.push(
          textBlock(
            `[VOID] open-handle cap (${MAX_OPEN_HANDLES}) exceeded — killed and closed the oldest handle ${evicted}; its unpolled output was DISCARDED. At most ${MAX_OPEN_HANDLES} handles stay open.`,
            false,
          ),
        );
      }
      return { content, isError: false };
    },
  };

  const statusTool: ToolSpec = {
    name: "async_shell_command_status",
    description: STATUS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Handle returned by async_shell_command ([A-Za-z0-9_-]+).",
        },
        waitMs: {
          type: "number",
          description:
            `Block up to this many milliseconds (max ${MAX_WAIT_MS}) waiting for new output or ` +
            "process exit before answering; 0 (default) answers immediately.",
        },
      },
      required: ["handle"],
    },
    source: "builtin",
    async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
      const parsedHandle = parseHandle(input);
      if (!parsedHandle.ok) {
        return parsedHandle.error;
      }
      const rawWait = input.waitMs;
      if (
        rawWait !== undefined &&
        (typeof rawWait !== "number" || !Number.isInteger(rawWait) || rawWait < 0)
      ) {
        return errorResult(
          "invalid_input",
          "input.waitMs must be a non-negative integer (milliseconds)",
          false,
        );
      }
      const waitMs = Math.min(rawWait ?? 0, MAX_WAIT_MS);

      const h = registry.get(parsedHandle.value);
      if (h === undefined) {
        return unknownHandleResult(parsedHandle.value);
      }

      // Let the exit watcher settle so a just-exited child is observed now.
      await sleep(0);
      if (waitMs > 0) {
        await waitForActivity(h, waitMs);
      }

      const slice = pollOutput(h, ctx.outputLimits);
      const drained = !h.running && h.cursor >= logSize(h);
      if (drained) {
        registry.delete(h.id);
        teardownHandle(h);
      }

      const content: TextResultBlock[] = [
        textBlock(`handle: ${h.id}\nstate: ${stateLine(h)}`, false),
      ];
      if (slice.droppedNow > 0) {
        content.push(
          textBlock(
            `[VOID] output cap exceeded — dropped the oldest ${slice.droppedNow} bytes ` +
              `(total dropped so far: ${h.droppedBytes}) before they were read. Poll more often or ` +
              "redirect the command's output to a file.",
            false,
          ),
        );
      }
      content.push(
        textBlock(
          `--- new output since last poll ---\n${slice.text === "" ? "(none)" : slice.text}`,
          slice.truncated,
        ),
      );
      if (drained) {
        content.push(
          textBlock(
            `handle closed: the process exited and its output is fully drained — ${h.id} no longer exists.`,
            false,
          ),
        );
      }
      return { content, isError: false };
    },
  };

  const killTool: ToolSpec = {
    name: "async_shell_command_kill",
    description: KILL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Handle returned by async_shell_command ([A-Za-z0-9_-]+).",
        },
      },
      required: ["handle"],
    },
    source: "builtin",
    async execute(input: ToolInput): Promise<ToolResult> {
      const parsedHandle = parseHandle(input);
      if (!parsedHandle.ok) {
        return parsedHandle.error;
      }
      const h = registry.get(parsedHandle.value);
      if (h === undefined) {
        return unknownHandleResult(parsedHandle.value);
      }

      if (!h.running) {
        return {
          content: [
            textBlock(
              `handle: ${h.id}\nstate: ${stateLine(h)}\nthe process already exited — no signal was sent. Poll async_shell_command_status to drain the remaining output.`,
              false,
            ),
          ],
          isError: false,
        };
      }

      h.killReason = "kill-tool";
      clearTimers(h);
      signalGroup(h.proc, "SIGTERM");
      let escalated = false;
      if (!(await settleExit(h, KILL_GRACE_MS))) {
        escalated = true;
        signalGroup(h.proc, "SIGKILL");
        await settleExit(h, 2_000);
      }
      await sleep(0); // let the exit watcher snapshot the terminal state

      return {
        content: [
          textBlock(
            `handle: ${h.id}\nsent SIGTERM to the process group (pid ${h.proc.pid})\n` +
              (escalated
                ? "the group did not die within the 3s grace — escalated to SIGKILL\n"
                : "the group died within the 3s SIGTERM grace\n") +
              `state after kill: ${stateLine(h)}\n` +
              "hint: poll async_shell_command_status once more to drain any remaining output (the handle stays open until drained).",
            false,
          ),
        ],
        isError: false,
      };
    },
  };

  return {
    spawnTool,
    statusTool,
    killTool,
    openHandles: (): readonly string[] => [...registry.keys()],
    disposeAll: (): void => {
      for (const h of [...registry.values()]) {
        evictHandle(h, registry, "eviction");
      }
    },
  };
}

/**
 * The production family: the three specs as registered in the builtin tool
 * registry, sharing one process-wide handle registry.
 */
const productionFamily = createAsyncShellTools();

/** The `async_shell_command` tool as registered in the builtin tool registry. */
export const asyncShellCommandTool: ToolSpec = productionFamily.spawnTool;
/** The `async_shell_command_status` tool as registered in the builtin tool registry. */
export const asyncShellCommandStatusTool: ToolSpec = productionFamily.statusTool;
/** The `async_shell_command_kill` tool as registered in the builtin tool registry. */
export const asyncShellCommandKillTool: ToolSpec = productionFamily.killTool;
