/**
 * `bash` builtin tool: run a shell command in the workspace, inside the OS
 * sandbox (ADR-0002 property 3 — sandbox by default, never a silent
 * unsandboxed fallback; docs/architecture.md §tools/§sandbox).
 *
 * Semantics the engine relies on:
 * - `execute()` never throws; expected failures come back as ToolResult with
 *   structured ToolError codes: invalid_input, sandbox_blocked, timeout,
 *   execution_failed (contracts/tools.ts).
 * - A command that simply exits non-zero is a VALID observation, not a tool
 *   failure: isError stays false and the exit code is visible in the text
 *   result — the model must see command failures to reason about them.
 * - stdout/stderr are capped by ctx.outputLimits with explicit
 *   `[truncated at N bytes]` markers (and `truncated: true` on the block).
 * - If no sandbox binary exists, the call fails sandbox_blocked with install
 *   guidance — unless ctx.env.VOID_ALLOW_UNSANDBOXED === "1", in which case
 *   the command runs unsandboxed with a loud marker line prepended to the
 *   output. Unsandboxed execution is opt-in and loud, never silent.
 */
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  JsonObject,
  OutputLimits,
  TextResultBlock,
  ToolContext,
  ToolError,
  ToolInput,
  ToolResult,
  ToolSpec,
} from "../contracts";
import { detectSandbox, SANDBOX_INSTALL_GUIDANCE, type SandboxDetection } from "../sandbox/detect";
import { canonicalPath } from "../sandbox/paths";
import {
  DEFAULT_TIMEOUT_MS,
  runSandboxed,
  runUnsandboxed,
  type SandboxRunOptions,
  type SandboxRunResult,
  SandboxUnavailableError,
} from "../sandbox/run";

export const MAX_TIMEOUT_MS = 120_000;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const UNSANDBOXED_MARKER =
  "[VOID] UNSANDBOXED EXECUTION — VOID_ALLOW_UNSANDBOXED=1 bypassed the OS sandbox for this command.";

/**
 * Injection seams so tests can exercise validation, error mapping, and the
 * unsandboxed gate without a real sandbox (also works under bun:test, which
 * has no vi.mock). Production uses the real functions.
 */
export interface BashToolDeps {
  readonly detect?: () => SandboxDetection;
  readonly run?: (command: string, opts: SandboxRunOptions) => Promise<SandboxRunResult>;
  readonly runDirect?: (command: string, opts: SandboxRunOptions) => Promise<SandboxRunResult>;
}

type Runner = (command: string, opts: SandboxRunOptions) => Promise<SandboxRunResult>;

function errorResult(code: ToolError["code"], message: string, retryable: boolean): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, retryable },
  };
}

/**
 * Structured `details` for bash failures: the exit code (when the process
 * produced one) and the timed-out flag (when set). Other error paths carry
 * no details — the payload stays minimal on purpose.
 */
function runErrorDetails(result: SandboxRunResult): JsonObject {
  const details: { exitCode?: number; timedOut?: boolean } = {};
  if (result.exitCode !== null) {
    details.exitCode = result.exitCode;
  }
  if (result.timedOut) {
    details.timedOut = true;
  }
  return details;
}

function textBlock(text: string, truncated: boolean): TextResultBlock {
  return truncated ? { type: "text", text, truncated } : { type: "text", text };
}

interface ParsedInput {
  readonly command: string;
  readonly timeoutMs: number;
  readonly env: Record<string, string>;
  readonly workdir: string;
}

type ParseOutcome =
  | { readonly ok: true; readonly value: ParsedInput }
  | { readonly ok: false; readonly error: ToolResult };

/** Resolve and validate `workdir` against the canonical workspace root. */
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

function parseInput(input: ToolInput, root: string): ParseOutcome {
  const { command } = input;
  if (typeof command !== "string" || command.trim().length === 0) {
    return {
      ok: false,
      error: errorResult("invalid_input", "input.command must be a non-empty string", false),
    };
  }

  const rawTimeout = input.timeoutMs;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0) {
      return {
        ok: false,
        error: errorResult(
          "invalid_input",
          "input.timeoutMs must be a positive integer (milliseconds)",
          false,
        ),
      };
    }
    timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);
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

  return { ok: true, value: { command, timeoutMs, env, workdir: workdir.dir } };
}

/**
 * Byte-safe truncation. OutputLimits are byte caps (per the contract); this
 * never splits a UTF-8 sequence and keeps the marker honest ("N bytes"). The
 * marker itself is metadata and may exceed the cap.
 */
function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const bytes = Buffer.from(text, "utf8");
  let cut = Math.min(maxBytes, bytes.length);
  while (cut > 0 && ((bytes[cut] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    cut -= 1;
  }
  return {
    text: `${bytes.subarray(0, cut).toString("utf8")}\n[truncated at ${cut} bytes]`,
    truncated: true,
  };
}

interface Section {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Per-section cap, then a total cap across stdout+stderr. When the two
 * sections together exceed maxTotalChars, the total budget is split: the
 * smaller section keeps up to a third of it, the larger gets the rest minus a
 * reserve for the truncation markers (both sections shrink when a single one
 * already exceeds the budget). Sections already within their allocation are
 * left untouched.
 */
function applyLimits(
  stdout: string,
  stderr: string,
  limits: OutputLimits,
): { readonly stdout: Section; readonly stderr: Section } {
  const cap = Math.max(0, limits.maxSectionChars);
  const total = Math.max(0, limits.maxTotalChars);
  const len = (s: string): number => Buffer.byteLength(s);
  let out = truncateBytes(stdout, cap);
  let errOut = truncateBytes(stderr, cap);
  if (len(out.text) + len(errOut.text) > total) {
    const stdoutIsLarger = len(out.text) >= len(errOut.text);
    const smallAlloc = Math.min(
      stdoutIsLarger ? len(errOut.text) : len(out.text),
      Math.floor(total / 3),
      cap,
    );
    const largeAlloc = Math.max(0, Math.min(total - smallAlloc - 96, cap));
    if (stdoutIsLarger) {
      out = truncateBytes(stdout, largeAlloc);
      errOut = truncateBytes(stderr, smallAlloc);
    } else {
      errOut = truncateBytes(stderr, largeAlloc);
      out = truncateBytes(stdout, smallAlloc);
    }
  }
  return { stdout: out, stderr: errOut };
}

function formatResult(
  result: SandboxRunResult,
  opts: {
    readonly unsandboxed: boolean;
    readonly limits: OutputLimits;
    readonly timeoutMs: number;
  },
): ToolResult {
  const { stdout, stderr } = applyLimits(result.stdout, result.stderr, opts.limits);
  const prefix = opts.unsandboxed ? `${UNSANDBOXED_MARKER}\n` : "";
  const sections = [
    textBlock(`--- stdout ---\n${stdout.text === "" ? "(empty)" : stdout.text}`, stdout.truncated),
    textBlock(`--- stderr ---\n${stderr.text === "" ? "(empty)" : stderr.text}`, stderr.truncated),
  ];
  if (result.timedOut) {
    return {
      content: [
        textBlock(
          `${prefix}timed out after ${opts.timeoutMs}ms — process group terminated (SIGTERM, then SIGKILL after a 3s grace)`,
          false,
        ),
        ...sections,
      ],
      isError: true,
      error: {
        code: "timeout",
        message: `command timed out after ${opts.timeoutMs}ms and the process group was killed`,
        retryable: true,
        details: runErrorDetails(result),
      },
    };
  }
  const exit = result.exitCode === null ? "none (killed by signal)" : String(result.exitCode);
  return {
    content: [
      textBlock(`${prefix}exit code: ${exit}\nduration: ${result.durationMs}ms`, false),
      ...sections,
    ],
    isError: false,
  };
}

/** Build a `bash` ToolSpec; `bashTool` below is the production instance. */
export function createBashTool(deps: BashToolDeps = {}): ToolSpec {
  const detect: () => SandboxDetection = deps.detect ?? detectSandbox;
  const run: Runner = deps.run ?? runSandboxed;
  const runDirect: Runner = deps.runDirect ?? runUnsandboxed;

  return {
    name: "bash",
    description:
      "Run a shell command in the workspace inside an OS sandbox (file writes restricted to " +
      "the workspace and temp dirs, network access disabled). Prefer the workdir parameter " +
      "over cd. A non-zero exit code is a normal observation reported in the output, not a " +
      "tool error. Output beyond the configured limits is truncated with an explicit marker.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run (executed by /bin/bash -c).",
        },
        workdir: {
          type: "string",
          description:
            "Working directory for the command: absolute or relative to the workspace root. " +
            "Must be inside the workspace; defaults to the workspace root.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Kill the process group after this many milliseconds. Default 30000, capped at 120000.",
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
      const parsed = parseInput(input, root);
      if (!parsed.ok) {
        return parsed.error;
      }
      const { command, timeoutMs, env, workdir } = parsed.value;

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

      // Per-call writable temp dir (also the command's TMPDIR), removed after.
      // Guarded (review minor): a temp-dir failure is a structured
      // execution_failed error, never a throw out of the tool.
      let tempDir: string;
      try {
        tempDir = mkdtempSync(join(canonicalPath(tmpdir()), "void-bash-"));
      } catch (err) {
        return errorResult(
          "execution_failed",
          `failed to create a per-call temp dir under ${canonicalPath(tmpdir())}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }
      const childEnv: Record<string, string> = {
        // Minimal inherited env from ctx.env (never implicitly process.env):
        PATH: ctx.env.PATH ?? FALLBACK_PATH,
        ...(ctx.env.HOME === undefined ? {} : { HOME: ctx.env.HOME }),
        TMPDIR: tempDir,
        ...env,
      };
      const runOpts: SandboxRunOptions = {
        workspaceRoot: root,
        tempDir,
        allowNetwork: false, // network stays off at MVP; future permission-gated flag
        timeoutMs,
        cwd: workdir,
        env: childEnv,
      };

      try {
        const result = sandboxMissing
          ? await runDirect(command, runOpts)
          : await run(command, runOpts);
        return formatResult(result, {
          unsandboxed: sandboxMissing,
          limits: ctx.outputLimits,
          timeoutMs,
        });
      } catch (cause) {
        if (cause instanceof SandboxUnavailableError) {
          return errorResult("sandbox_blocked", cause.message, false);
        }
        return errorResult(
          "execution_failed",
          `failed to execute command: ${cause instanceof Error ? cause.message : String(cause)}`,
          false,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

/** The `bash` tool as registered in the builtin tool registry. */
export const bashTool: ToolSpec = createBashTool();
