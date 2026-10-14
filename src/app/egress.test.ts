/**
 * Egress end-to-end tests — ADR-0002 property 5 made falsifiable.
 *
 * Three layers, each necessary:
 *
 * 1. Fixture integrity ("control"): one deliberate fetch through the plain
 *    global reference — the exact call shape a rogue component would make —
 *    MUST be recorded and rejected. If the patch mechanism ever rots, this
 *    test fails instead of the no-egress assertions silently passing.
 * 2. Full offline `runTask` runs under the monitor: the scripted provider +
 *    every builtin tool that can execute in the current runtime, with zero
 *    real-fetch attempts. Components that legitimately need HTTP go through
 *    the runner's `fetchImpl` injection seam, which the monitor never sees.
 * 3. CLI paths that must never fetch: --version, schema, threads list,
 *    permissions test (driven through `runCli` with injected I/O).
 *
 * The OS-level counterpart (kernel network denial around the whole suite)
 * lives in CI: `sandbox-exec -p '(version 1)(allow default)(deny network*)'`
 * on macOS, `unshare -Urn` on Linux. See tests/support/egress-monitor.ts for
 * the coverage boundary between the two layers.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertNoEgress, installEgressMonitor } from "../../tests/support/egress-monitor";
import { runCli } from "../cli";
import type {
  AssistantContentBlock,
  ChatCompletion,
  ChatRequest,
  Provider,
  StreamEvent,
  ToolInput,
  UsageRecord,
} from "../contracts";
import { DEFAULT_RULES } from "../permissions";
import { whichBinary } from "../sandbox/detect";
import { runTask } from "./runner";

// ---------------------------------------------------------------------------
// Scripted provider (in-repo, network-free — same event shapes as the M1 mock)
// ---------------------------------------------------------------------------

class ScriptedProvider implements Provider {
  readonly id = "scripted-egress";
  readonly requests: ChatRequest[] = [];
  readonly #rounds: readonly (readonly StreamEvent[])[];

  constructor(rounds: readonly (readonly StreamEvent[])[]) {
    this.#rounds = rounds;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.requests.push(request);
    const round = this.#rounds[this.requests.length - 1];
    if (round === undefined) {
      yield {
        type: "error",
        error: { message: "scripted provider: no round scripted for this call", retryable: false },
      };
      return;
    }
    for (const event of round) {
      yield event;
    }
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const events: StreamEvent[] = [];
    for await (const event of this.stream(request)) {
      events.push(event);
    }
    const content: AssistantContentBlock[] = [];
    let usage: UsageRecord = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "end_turn";
    for (const event of events) {
      if (event.type === "text_delta") {
        const last = content.at(-1);
        if (last !== undefined && last.type === "text") {
          content[content.length - 1] = { type: "text", text: `${last.text}${event.text}` };
        } else {
          content.push({ type: "text", text: event.text });
        }
      } else if (event.type === "tool_use_end") {
        content.push({
          type: "tool_use",
          id: event.id,
          ...(event.name !== undefined ? { name: event.name } : { name: "unknown" }),
          input: event.input,
        });
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "turn_complete") {
        stopReason = event.stopReason;
      }
    }
    return { content, usage, stopReason };
  }
}

const toolRound = (id: string, name: string, input: ToolInput): readonly StreamEvent[] => [
  { type: "text_delta", text: `using ${name}\n` },
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, name, input },
  { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
  { type: "turn_complete", stopReason: "tool_use" },
];

const textRound = (text: string): readonly StreamEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage: { inputTokens: 150, outputTokens: 30 } },
  { type: "turn_complete", stopReason: "end_turn" },
];

// ---------------------------------------------------------------------------
// Fixtures and capability gates
// ---------------------------------------------------------------------------

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "void-egress-")));
afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

const bunRuntime = typeof Bun !== "undefined";

/**
 * On macOS, applying a SECOND sandbox-exec profile from inside an already
 * sandboxed process fails with `sandbox_apply: Operation not permitted`
 * (exit 71) for the profile shapes this suite generates (file-write denies
 * with subpath re-allows) whenever the current profile already contains deny
 * rules. The composition rules are undocumented and not purely semantic
 * (verified empirically 2026-10-12: nesting an identical `(deny network*)`
 * succeeds, nesting `(allow default)` or any file-write-deny profile under a
 * deny-bearing outer fails). CI's network-blocked wrapper is exactly that
 * outer, so the real-bash variant probes for the capability and skips when
 * it is gone — the pure-tools variant still proves the zero-egress property
 * there, and the bash path's no-fetch property runs in the unwrapped suites.
 */
function sandboxApplyAvailable(): boolean {
  if (process.platform !== "darwin") {
    return true; // the nesting restriction is a macOS seatbelt behavior
  }
  const binary = whichBinary("sandbox-exec");
  if (binary === null) {
    return false;
  }
  // Probe with the shape the real suites need (a write-restricting profile),
  // not a trivially-composable one, so the answer matches reality.
  const probe = spawnSync(binary, [
    "-p",
    "(version 1)(allow default)(deny file-write*)",
    "/usr/bin/true",
  ]);
  return probe.status === 0;
}

function sandboxToolRunnable(): boolean {
  if (!bunRuntime) {
    return false; // bash/grep execution needs Bun.spawn
  }
  const sandboxBinary =
    process.platform === "darwin"
      ? whichBinary("sandbox-exec") !== null
      : whichBinary("bwrap") !== null;
  if (!sandboxBinary) {
    return false;
  }
  return sandboxApplyAvailable();
}

/** bash + grep need the Bun runtime, a sandbox binary, and (grep) rg on PATH. */
const canRunBashAndGrep =
  sandboxToolRunnable() && typeof Bun !== "undefined" && Bun.which("rg") !== null;

// ---------------------------------------------------------------------------
// 1. Fixture integrity: the monitor must fire on a real global fetch
// ---------------------------------------------------------------------------

describe("egress monitor fixture integrity", () => {
  it("detects and rejects one deliberate fetch through the plain global reference", async () => {
    const before = globalThis.fetch;
    const monitor = installEgressMonitor();
    try {
      expect(globalThis.fetch).not.toBe(before); // the patch actually applied
      // The bare identifier resolves through globalThis at call time — the
      // same path a component that skipped the fetchImpl seam would take.
      await expect(fetch("https://void-egress-control.invalid/probe")).rejects.toThrow(
        /egress monitor.*unexpected real network fetch/s,
      );
      expect(monitor.attempts.length).toBe(1);
      expect(monitor.attempts[0]?.url).toBe("https://void-egress-control.invalid/probe");
      expect(monitor.attempts[0]?.stack).toBeTruthy(); // capture site is diagnosable
    } finally {
      monitor.restore();
    }
    expect(globalThis.fetch).toBe(before); // restore is exact
  });
});

// ---------------------------------------------------------------------------
// 2. runTask under the monitor
// ---------------------------------------------------------------------------

describe("runTask under the egress monitor (scripted provider, network-free)", () => {
  it("read_file + glob + edit_file conversation: zero real-fetch attempts", async () => {
    const ws = mkdtempSync(join(scratchRoot, "pure-ws-"));
    writeFileSync(join(ws, "notes.txt"), "alpha needle\nbeta line\n");
    const provider = new ScriptedProvider([
      toolRound("c1", "read_file", { path: join(ws, "notes.txt") }),
      toolRound("c2", "glob", { pattern: "*.txt" }),
      toolRound("c3", "edit_file", {
        path: join(ws, "notes.txt"),
        old_str: "alpha needle",
        new_str: "alpha void",
      }),
      textRound("done without any network"),
    ]);

    const monitor = installEgressMonitor();
    try {
      const outcome = await runTask({
        task: "work on the notes",
        workspaceRoot: ws,
        modelRef: "anthropic/claude-sonnet-4-5",
        provider,
        dataDir: mkdtempSync(join(scratchRoot, "pure-data-")),
        systemPrompt: "egress test prompt",
        newId: () => "egress-pure-thread",
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result.stopReason).toBe("end_turn");
      expect(readFileSync(join(ws, "notes.txt"), "utf8")).toBe("alpha void\nbeta line\n");
      expect(outcome.permissions.map((record) => record.tool)).toEqual([
        "read_file",
        "glob",
        "edit_file",
      ]);
      assertNoEgress(monitor, "runTask (pure tools)");
    } finally {
      monitor.restore();
    }
  });

  it.skipIf(!canRunBashAndGrep)(
    "all five builtin tools (incl. sandboxed bash and rg grep): zero real-fetch attempts",
    async () => {
      const ws = mkdtempSync(join(scratchRoot, "full-ws-"));
      writeFileSync(join(ws, "haystack.txt"), "egress-needle here\nplain line\n");
      const provider = new ScriptedProvider([
        toolRound("c1", "read_file", { path: join(ws, "haystack.txt") }),
        toolRound("c2", "glob", { pattern: "**/*.txt" }),
        toolRound("c3", "grep", { pattern: "egress-needle" }),
        toolRound("c4", "bash", { command: "printf egress-bash > from-bash.txt" }),
        toolRound("c5", "edit_file", {
          path: join(ws, "haystack.txt"),
          old_str: "plain line",
          new_str: "edited line",
        }),
        textRound("all five tools done offline"),
      ]);

      const monitor = installEgressMonitor();
      try {
        const outcome = await runTask({
          task: "exercise every builtin tool",
          workspaceRoot: ws,
          modelRef: "anthropic/claude-sonnet-4-5",
          provider,
          dataDir: mkdtempSync(join(scratchRoot, "full-data-")),
          systemPrompt: "egress test prompt",
          newId: () => "egress-full-thread",
          // PATH carries rg to the grep tool's strict lookup; the bash child
          // env is assembled from this too.
          env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
          // printf … > file is a write, so DEFAULT_RULES would ask (headless
          // deny): prepend one rule allowing this exact scripted command and
          // keep the defaults for everything else.
          rules: [
            { tool: "bash", matches: { command: "/^printf egress-bash/" }, action: "allow" },
            ...DEFAULT_RULES,
          ],
        });
        expect(outcome.exitCode).toBe(0);
        expect(readFileSync(join(ws, "from-bash.txt"), "utf8")).toBe("egress-bash");
        expect(readFileSync(join(ws, "haystack.txt"), "utf8")).toBe(
          "egress-needle here\nedited line\n",
        );
        expect(outcome.permissions.map((record) => record.tool)).toEqual([
          "read_file",
          "glob",
          "grep",
          "bash",
          "edit_file",
        ]);
        // The sandboxed bash round actually executed (not denied, not errored).
        const bashResult = outcome.result.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.some((block) => block.type === "tool_result" && !block.isError),
        );
        expect(bashResult).toBeDefined();
        assertNoEgress(monitor, "runTask (all five tools incl. sandboxed bash)");
      } finally {
        monitor.restore();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. CLI paths that must never fetch
// ---------------------------------------------------------------------------

describe("CLI paths under the egress monitor", () => {
  it("--version, --help, schema, threads list, permissions test: zero real-fetch attempts", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      stdout: (line: string): void => {
        out.push(line);
      },
      stderr: (line: string): void => {
        err.push(line);
      },
      env: {} as Record<string, string | undefined>,
      dataDir: mkdtempSync(join(scratchRoot, "cli-data-")),
    };

    const monitor = installEgressMonitor();
    try {
      await expect(runCli(["--version"], deps)).resolves.toBe(0);
      await expect(runCli(["--help"], deps)).resolves.toBe(0);
      await expect(runCli(["run", "--help"], deps)).resolves.toBe(0);
      await expect(runCli(["schema"], deps)).resolves.toBe(0);
      await expect(runCli(["threads", "list"], deps)).resolves.toBe(0);
      await expect(
        runCli(["permissions", "test", "bash", '{"command":"ls -la"}'], deps),
      ).resolves.toBe(0);
      expect(out.length).toBeGreaterThan(0); // the commands produced output
      assertNoEgress(monitor, "CLI offline subcommands");
    } finally {
      monitor.restore();
    }
  });
});
