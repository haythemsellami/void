/**
 * CLI composition tests — AGENTS.md working agreement: changes to `src/cli.ts`
 * (or the runner wiring under it) need tests driving the REAL composition
 * path, not injected component seams. Everything here goes through
 * `runCli` → `runTask` → engine → real builtin tools with only the
 * documented injection seams (`deps.env`, `deps.fetchImpl`, `deps.dataDir`)
 * — the v0.1.0 review found two shipped blockers (flags parsed but never
 * read; env available but never forwarded) that component tests missed.
 *
 * - The `run --thread` suites script the provider through the REAL anthropic
 *   adapter (injected fetch, scripted SSE) and run under both test runners.
 * - The env-forwarding suites execute real tool children (Bun.spawn inside
 *   bash/grep) and therefore run only under Bun; plain-Node vitest workers
 *   skip them (same gating pattern as src/tools/*.test.ts).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildToolEnv, type CliDeps, runCli, toolEnvWithSettings } from "../cli";
import type { Provider, StreamEvent } from "../contracts";
import { DEFAULT_RULES } from "../permissions";
import { detectSandbox } from "../sandbox/detect";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-cli-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const bunRuntime = typeof Bun !== "undefined";
const runtimeDescribe = bunRuntime ? describe : describe.skip;
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");

/**
 * Loopback capability probe for the spawn-based suite below — a FULL
 * ROUND-TRIP, not just a bind: Linux network namespaces with the loopback
 * interface down (CI's offline job runs inside `unshare -Urn`) still allow
 * BINDING 127.0.0.1, but connecting is impossible, so only a completed
 * request/response proves the spawned CLI could reach the local
 * Ollama-protocol provider server. Where the round-trip cannot complete the
 * test skips instead of failing. The fetch timeout guards against a
 * pathological environment hanging the module's top-level await.
 */
const loopbackUsable: boolean = await (async (): Promise<boolean> => {
  if (!bunRuntime) {
    return false;
  }
  const server = (() => {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("probe"),
      });
    } catch {
      return null; // cannot even bind
    }
  })();
  if (server === null) {
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/probe`, {
      signal: AbortSignal.timeout(2_000),
    });
    await response.text();
    return true;
  } catch {
    return false;
  } finally {
    server.stop(true);
  }
})();

// ---------------------------------------------------------------------------
// Scripted anthropic SSE (the real adapter parses these)
// ---------------------------------------------------------------------------

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textRoundSse(text: string): string {
  return [
    frame("message_start", {
      type: "message_start",
      message: { id: "msg_1", role: "assistant", usage: { input_tokens: 25, output_tokens: 1 } },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

function toolRoundSse(id: string, name: string, input: Record<string, string>): string {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

// ---------------------------------------------------------------------------
// runCli harness: injected deps.env + scripted provider fetch, real everything else
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
  /** Every provider request body, in order (for folded-history assertions). */
  readonly requests: string[];
  /** Every provider request URL, in order (for base-URL routing assertions). */
  readonly urls: string[];
}

function makeHarness(options: {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly rounds: readonly string[];
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const urls: string[] = [];
  const queue = [...options.rounds];
  const deps: CliDeps = {
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      err.push(line);
    },
    env: options.env,
    cwd: options.cwd,
    dataDir: mkdtempSync(join(scratch, "data-")),
    fetchImpl: (url: string, init?: RequestInit) => {
      urls.push(url);
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push(body);
      return Promise.resolve(
        new Response(queue.shift() ?? textRoundSse("unexpected extra round"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  };
  return { deps, out, err, requests, urls };
}

/** Parse the emitted stream-JSON lines. */
function events(out: readonly string[]): Record<string, unknown>[] {
  return out.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function initEvent(out: readonly string[]): Record<string, unknown> {
  const first = events(out)[0];
  expect(first?.type).toBe("system");
  return first as Record<string, unknown>;
}

function resultEvent(out: readonly string[]): Record<string, unknown> {
  const last = events(out).at(-1);
  expect(last?.type).toBe("result");
  return last as Record<string, unknown>;
}

/** The FULL tool-result text sent back to the provider (uncapped, unlike the stream summary). */
function fullToolResult(
  requests: readonly string[],
  toolUseId: string,
): { readonly text: string; readonly isError: boolean } {
  for (const body of requests) {
    const parsed = JSON.parse(body) as {
      messages?: readonly {
        role?: string;
        content?: readonly {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: readonly { text?: string }[] | string;
        }[];
      }[];
    };
    for (const message of parsed.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          const text =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? []).map((part) => part.text ?? "").join("\n");
          return { text, isError: block.is_error === true };
        }
      }
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in any provider request`);
}

// ---------------------------------------------------------------------------
// `run --thread <id>` — real dispatch path (both runners)
// ---------------------------------------------------------------------------

describe("CLI composition: run --thread (real dispatch path)", () => {
  it("run --thread <existing> resumes: init resumed_from set and folded history reaches the provider", async () => {
    const workspace = mkdtempSync(join(scratch, "thread-ws-"));
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      rounds: [textRoundSse("first reply"), textRoundSse("second reply")],
    });

    const first = await runCli(["run", "--workspace", workspace, "first task"], harness.deps);
    expect(first).toBe(0);
    const id = initEvent(harness.out).thread_id;
    expect(typeof id).toBe("string");

    const outCount = harness.out.length;
    const second = await runCli(
      ["run", "--thread", id as string, "--workspace", workspace, "second task"],
      harness.deps,
    );
    expect(second).toBe(0);

    // The continuation's init event declares the resumed thread…
    expect(initEvent(harness.out.slice(outCount)).resumed_from).toBe(id);

    // …and the provider's second request carries the folded prior exchange.
    const secondRequest = JSON.parse(harness.requests[1] as string) as {
      messages?: { role: string }[];
    };
    const roles = (secondRequest.messages ?? []).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(harness.requests[1]).toContain("first task");
    expect(harness.requests[1]).toContain("first reply");
  });

  it("run --thread <unknown id> fails loudly: exit 3, result error names the thread", async () => {
    const workspace = mkdtempSync(join(scratch, "thread-missing-"));
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      rounds: [],
    });

    const code = await runCli(
      ["run", "--thread", "no-such-thread-xyz", "--workspace", workspace, "task"],
      harness.deps,
    );
    expect(code).toBe(3);

    const init = initEvent(harness.out);
    expect(init.resumed_from).toBe("no-such-thread-xyz");
    const result = resultEvent(harness.out);
    expect(result.subtype).toBe("error_run");
    expect(result.error).toContain("no-such-thread-xyz");
    expect(harness.err.join("\n")).toContain("no-such-thread-xyz");
    // No provider round was spent on a thread that cannot be resumed.
    expect(harness.requests).toHaveLength(0);
  });

  it("plain run stays fresh: new id, resumed_from null, no history folding", async () => {
    const workspace = mkdtempSync(join(scratch, "thread-plain-"));
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      rounds: [textRoundSse("ok"), textRoundSse("ok again")],
    });

    const first = await runCli(["run", "--workspace", workspace, "one"], harness.deps);
    expect(first).toBe(0);
    const firstId = initEvent(harness.out).thread_id;

    const outCount = harness.out.length;
    const second = await runCli(["run", "--workspace", workspace, "two"], harness.deps);
    expect(second).toBe(0);

    const secondInit = initEvent(harness.out.slice(outCount));
    expect(secondInit.resumed_from).toBeNull();
    expect(secondInit.thread_id).not.toBe(firstId);
    // Second request contains ONLY the new task — no folded history.
    const secondRequest = JSON.parse(harness.requests[1] as string) as {
      messages?: { role: string }[];
    };
    expect((secondRequest.messages ?? []).map((m) => m.role)).toEqual(["user"]);
    expect(harness.requests[1]).not.toContain('"one"');
  });
});

// ---------------------------------------------------------------------------
// VOID_ANTHROPIC_BASE_URL routing (env → provider request URL)
// ---------------------------------------------------------------------------

describe("CLI composition: VOID_ANTHROPIC_BASE_URL routing (real dispatch path)", () => {
  it("routes provider requests to the custom base URL host when set (GLM via Z.AI)", async () => {
    const workspace = mkdtempSync(join(scratch, "glm-ws-"));
    const harness = makeHarness({
      env: {
        VOID_ANTHROPIC_KEY: "zai-key",
        VOID_ANTHROPIC_BASE_URL: "https://api.z.ai/anthropic",
      },
      cwd: workspace,
      rounds: [textRoundSse("glm reply")],
    });

    const code = await runCli(
      ["run", "--model", "anthropic/glm-4.6", "--workspace", workspace, "glm task"],
      harness.deps,
    );
    expect(code).toBe(0);

    // The scripted provider's captured request URL targets the custom host.
    expect(harness.urls).toHaveLength(1);
    expect(harness.urls[0]).toBe("https://api.z.ai/anthropic/v1/messages");
    expect(harness.urls[0]).not.toContain("api.anthropic.com");
  });

  it("defaults to api.anthropic.com when VOID_ANTHROPIC_BASE_URL is absent", async () => {
    const workspace = mkdtempSync(join(scratch, "anthropic-default-ws-"));
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      rounds: [textRoundSse("ok")],
    });

    const code = await runCli(
      ["run", "--model", "anthropic/glm-4.7", "--workspace", workspace, "plain task"],
      harness.deps,
    );
    expect(code).toBe(0);

    expect(harness.urls).toHaveLength(1);
    expect(harness.urls[0]).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// Curated tool env forwarding (FIX: CLI never passed env into runTask)
// ---------------------------------------------------------------------------

describe("CLI composition: buildToolEnv allowlist (unit)", () => {
  it("forwards exactly the allowlisted keys; absent and empty-string values are dropped", () => {
    expect(buildToolEnv({})).toEqual({});
    expect(
      buildToolEnv({ PATH: "/p", HOME: "/h", TMPDIR: "/t", VOID_ALLOW_UNSANDBOXED: "1" }),
    ).toEqual({ PATH: "/p", HOME: "/h", TMPDIR: "/t", VOID_ALLOW_UNSANDBOXED: "1" });
    // Everything ambient — credentials, model config, secrets — stays out.
    expect(
      buildToolEnv({
        PATH: "/p",
        SECRET_TOKEN: "canary",
        ANTHROPIC_API_KEY: "sk-x",
        VOID_ANTHROPIC_KEY: "sk-y",
        VOID_OLLAMA_URL: "http://127.0.0.1:1",
        VOID_MODEL: "ollama/x",
        VOID_DATA_DIR: "/somewhere",
      }),
    ).toEqual({ PATH: "/p" });
    // Empty string is treated as absent (tools check for emptiness).
    expect(buildToolEnv({ HOME: "", PATH: "/p" })).toEqual({ PATH: "/p" });
  });

  it("toolEnvWithSettings: settings knob flows when env lacks it; real env wins; empty env loses", () => {
    expect(toolEnvWithSettings({ PATH: "/p" }, { asyncShell: { maxLifetimeMs: 123456 } })).toEqual({
      PATH: "/p",
      VOID_ASYNC_MAX_LIFETIME_MS: "123456",
    });
    expect(
      toolEnvWithSettings(
        { PATH: "/p", VOID_ASYNC_MAX_LIFETIME_MS: "777777" },
        { asyncShell: { maxLifetimeMs: 123456 } },
      ),
    ).toEqual({ PATH: "/p", VOID_ASYNC_MAX_LIFETIME_MS: "777777" });
    expect(
      toolEnvWithSettings(
        { PATH: "/p", VOID_ASYNC_MAX_LIFETIME_MS: "" },
        { asyncShell: { maxLifetimeMs: 1 } },
      ),
    ).toEqual({ PATH: "/p", VOID_ASYNC_MAX_LIFETIME_MS: "1" });
    expect(toolEnvWithSettings({ PATH: "/p" }, {})).toEqual({ PATH: "/p" });
  });

  it("includes the async lifetime knob (a duration, never a secret)", () => {
    expect(buildToolEnv({ PATH: "/p", VOID_ASYNC_MAX_LIFETIME_MS: "60000" })).toEqual({
      PATH: "/p",
      VOID_ASYNC_MAX_LIFETIME_MS: "60000",
    });
  });
});

// ---------------------------------------------------------------------------
// Anti-drift pin: the init event's `tools` must equal the real registry
// (reviewer block on feat/async-shell — the CLI advertised 5 tools while the
// registry registered 8, and nothing functional failed, so only this pin
// catches the class).
// ---------------------------------------------------------------------------
describe("CLI composition: init event tools field matches the registry", () => {
  it("BUILTIN_TOOLS equals the builtin registry's names, sorted", async () => {
    const { buildPermissionGate, buildToolRegistry } = await import("./runner");
    const workspace = mkdtempSync(join(scratch, "tools-pin-ws-"));
    // Task-tool wiring as runTask builds it (ADR-0013): the registry gains
    // `task` whenever the provider/model/rules deps are available. The stub
    // provider is never called — only its identity matters for the pin.
    const stubProvider: Provider = {
      id: "stub",
      async *stream(): AsyncIterable<StreamEvent> {
        // empty on purpose: no child round is ever run through this stub
      },
      async complete() {
        throw new Error("stub provider is never completed");
      },
    };
    const registry = buildToolRegistry(buildPermissionGate(), {
      taskDeps: {
        provider: stubProvider,
        model: "anthropic/stub",
        rules: DEFAULT_RULES,
        workspaceRoot: workspace,
      },
    });
    const registryNames = [...registry.keys()].sort();
    expect(registryNames.length).toBeGreaterThan(5);
    expect(registryNames).toContain("task");

    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "pin-key" },
      cwd: workspace,
      rounds: [textRoundSse("hi")],
    });
    const code = await runCli(["run", "--workspace", workspace, "hi"], harness.deps);
    expect(code).toBe(0);

    const init = initEvent(harness.out);
    expect(init.tools).toEqual(registryNames);
  });
});

runtimeDescribe("CLI composition: env forwarding into tools (real path)", () => {
  /**
   * Plant an `rg` binary into dir: symlink to the ambient rg when this host
   * has one; otherwise an rg-shaped shim that emits one --json match event
   * for the searched path (keeps the suite green on hosts without ripgrep
   * while still proving PATH forwarding — without a forwarded PATH, findRg
   * gets undefined and grep fails with the "rg not found" error).
   */
  function plantRg(dir: string): void {
    const ambient = Bun.which("rg");
    if (ambient !== null) {
      symlinkSync(ambient, join(dir, "rg"));
      return;
    }
    const shim = [
      "#!/bin/sh",
      "# test shim: one rg --json match event for the search path (last arg)",
      'for last in "$@"; do :; done',
      `printf '{"type":"match","data":{"path":{"text":"%s"},"line_number":2,"lines":{"text":"needle-composition-marker"}}}\\n' "$last"`,
      `printf '{"type":"summary","data":{"stats":{"matches":1}}}\\n'`,
      "",
    ].join("\n");
    writeFileSync(join(dir, "rg"), shim, { mode: 0o755 });
  }

  /**
   * Plant a `wc` that dumps the child environment (/usr/bin/env). The default
   * permission rules allow single read-only verbs only — no `$`, pipes, or
   * `printenv` — so shadowing an allowlisted verb is the honest way to
   * observe the sandboxed child's real environment through this path. `wc`
   * is not a bash builtin, so PATH resolution finds the planted script only
   * when the forwarded PATH actually contains its directory.
   */
  function plantEnvDumpingWc(dir: string): void {
    writeFileSync(join(dir, "wc"), "#!/bin/sh\nexec /usr/bin/env\n", { mode: 0o755 });
  }

  /**
   * The platform's sandbox binary, resolved exactly the way the bash tool
   * resolves it at run time (same process, same detect module). Where no
   * sandbox binary exists (Linux CI images without bubblewrap) the tool
   * fails closed — sandbox_blocked, no sandboxed child whose PATH could be
   * observed — so those runs skip instead of failing. Same gating as
   * src/tools/bash.test.ts and src/app/runner.test.ts ("real sandbox").
   */
  const sandboxBinaryPath: string | null = bunRuntime ? detectSandbox().binaryPath : null;

  /**
   * Plant the bin dir a sandboxed child must see INSIDE the test workspace:
   * the workspace root is bound read-write by both sandboxes, while Linux
   * bwrap hardening mounts a fresh tmpfs over /tmp (anything planted under
   * os.tmpdir() outside the workspace is invisible to the child, and PATH
   * resolution silently falls through to the system binary — observed on
   * CI as the real `wc` counting empty input).
   */
  const workspaceBinDir = (workspace: string): string => {
    const binDir = join(workspace, "comp-bin");
    mkdirSync(binDir);
    return binDir;
  };

  /**
   * Forwarded PATH for the sandboxed-child tests: the planted dir first
   * (the thing under test), then the sandbox binary's own directory (so the
   * tool can actually run the child even on minimal-PATH CI images), then
   * the ambient PATH.
   */
  const sandboxedForwardedPath = (plantedDir: string): string =>
    [plantedDir, sandboxBinaryPath !== null ? dirname(sandboxBinaryPath) : null, process.env.PATH]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join(":");

  it("forwards PATH so grep finds rg through the real tool path", async () => {
    const binDir = mkdtempSync(join(scratch, "rgbin-"));
    plantRg(binDir);
    const workspace = mkdtempSync(join(scratch, "grep-ws-"));
    writeFileSync(join(workspace, "notes.txt"), "alpha\nneedle-composition-marker\nomega\n");

    const harness = makeHarness({
      env: {
        PATH: [binDir, process.env.PATH].filter(Boolean).join(":"),
        VOID_ANTHROPIC_KEY: "test-key",
      },
      cwd: workspace,
      rounds: [
        toolRoundSse("call-grep-1", "grep", {
          pattern: "needle-composition-marker",
          path: join(workspace, "notes.txt"),
        }),
        textRoundSse("found it"),
      ],
    });

    const code = await runCli(["run", "--workspace", workspace, "find the marker"], harness.deps);
    expect(code).toBe(0);

    const result = fullToolResult(harness.requests, "call-grep-1");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("notes.txt:2:needle-composition-marker");
    expect(result.text).not.toContain("not found on PATH");
  });

  it.skipIf(sandboxBinaryPath === null)(
    "forwards the planted PATH (and HOME) into the sandboxed bash child",
    async () => {
      const workspace = mkdtempSync(join(scratch, "bash-ws-"));
      const binDir = workspaceBinDir(workspace);
      plantEnvDumpingWc(binDir);
      symlinkSync("/bin/echo", join(binDir, "head"));
      const forwardedPath = sandboxedForwardedPath(binDir);

      const harness = makeHarness({
        env: { PATH: forwardedPath, HOME: "/void-comp-home", VOID_ANTHROPIC_KEY: "test-key" },
        cwd: workspace,
        rounds: [
          toolRoundSse("call-bash-dump", "bash", { command: "wc -l" }),
          toolRoundSse("call-bash-symlink", "bash", { command: "head PLANTED_SYMLINK_RAN" }),
          textRoundSse("done"),
        ],
      });

      const code = await runCli(
        ["run", "--workspace", workspace, "inspect the shell"],
        harness.deps,
      );
      expect(code).toBe(0);

      // The env dump: the sandboxed child saw the FORWARDED PATH (planted dir
      // first) and the allowlisted HOME — not the minimal fallback PATH.
      const dump = fullToolResult(harness.requests, "call-bash-dump");
      expect(dump.isError).toBe(false);
      expect(dump.text).toContain(`PATH=${binDir}:`);
      expect(dump.text).toContain("HOME=/void-comp-home");

      // A symlinked binary in the planted (non-system) dir resolves and runs.
      const marker = fullToolResult(harness.requests, "call-bash-symlink");
      expect(marker.isError).toBe(false);
      expect(marker.text).toContain("PLANTED_SYMLINK_RAN");
    },
  );

  it.skipIf(sandboxBinaryPath === null)(
    "ambient env outside the allowlist never leaks into bash children",
    async () => {
      const workspace = mkdtempSync(join(scratch, "leak-ws-"));
      const binDir = workspaceBinDir(workspace);
      plantEnvDumpingWc(binDir);

      const harness = makeHarness({
        env: {
          PATH: sandboxedForwardedPath(binDir),
          VOID_ANTHROPIC_KEY: "test-key",
          ANTHROPIC_API_KEY: "ambient-style-key",
          SECRET_TOKEN: "void-leak-canary-3f9a",
          VOID_OLLAMA_URL: "http://127.0.0.1:1",
        },
        cwd: workspace,
        rounds: [toolRoundSse("call-bash-env", "bash", { command: "wc -l" }), textRoundSse("done")],
      });

      const code = await runCli(["run", "--workspace", workspace, "dump the env"], harness.deps);
      expect(code).toBe(0);

      const dump = fullToolResult(harness.requests, "call-bash-env").text;
      expect(dump).toContain("PATH=");
      for (const leaked of [
        "SECRET_TOKEN",
        "void-leak-canary-3f9a",
        "ANTHROPIC",
        "test-key",
        "ambient-style-key",
        "VOID_OLLAMA_URL",
      ]) {
        expect(dump).not.toContain(leaked);
      }
    },
  );

  it.skipIf(!loopbackUsable)(
    "VOID_ALLOW_UNSANDBOXED=1 reaches the tool env: loud unsandboxed marker; without it, sandbox refusal",
    async () => {
      // The flag's consumption (src/tools/bash.ts) only engages when no OS
      // sandbox is detectable, and Bun.which — used by detectSandbox — ignores
      // post-startup env mutations. A spawned CLI that STARTS with a PATH
      // containing no sandbox binary is therefore the one honest way to drive
      // the marker through the real entry point; the provider is a local
      // Ollama-protocol server so the child stays fully offline. Guarded on
      // loopbackUsable: CI's offline job (unshare -Urn, lo down) cannot host
      // that server, so it skips there and runs in the plain jobs on both OSes.
      const workspace = mkdtempSync(join(scratch, "unsbx-ws-"));
      const dataDir = mkdtempSync(join(scratch, "unsbx-data-"));
      const emptyPathDir = mkdtempSync(join(scratch, "unsbx-emptybin-"));

      const ollamaToolRound = (id: string, command: string): string => {
        const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
        return [
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id,
                      type: "function",
                      function: { name: "bash", arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
              },
            ],
          }),
          chunk({
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
          }),
          "data: [DONE]\n\n",
        ].join("");
      };
      const ollamaTextRound = (text: string): string => {
        const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
        return [
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ].join("");
      };

      const spawnCli = (
        extraEnv: Record<string, string>,
      ): { bodies: string[]; exit: Promise<number> } => {
        const bodies: string[] = [];
        let round = 0;
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            bodies.push(await request.text());
            round += 1;
            const body =
              round === 1
                ? ollamaToolRound("call-unsbx", "echo VOID_OPT_OUT_FORWARDED")
                : ollamaTextRound("done");
            return new Response(body, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          },
        });
        const proc = Bun.spawn(
          [process.execPath, cliPath, "run", "--workspace", workspace, "probe the shell"],
          {
            cwd: workspace,
            env: {
              PATH: emptyPathDir,
              VOID_MODEL: "ollama/void-comp-model",
              VOID_OLLAMA_URL: `http://127.0.0.1:${server.port}`,
              VOID_DATA_DIR: dataDir,
              ...extraEnv,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        // Drain output so the child never blocks on a full pipe, and stop the
        // server once the process is done.
        const drained = Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]).then(([, , code]) => {
          server.stop(true);
          return code;
        });
        return { bodies, exit: drained };
      };

      // With the opt-out: the loud marker prefixes the command's output.
      const optOut = spawnCli({ VOID_ALLOW_UNSANDBOXED: "1" });
      expect(await optOut.exit).toBe(0);
      expect(optOut.bodies[1]).toContain("[VOID] UNSANDBOXED EXECUTION");
      expect(optOut.bodies[1]).toContain("VOID_OPT_OUT_FORWARDED");

      // Without the opt-out and no sandbox on PATH: a loud refusal, no run.
      const refusal = spawnCli({});
      expect(await refusal.exit).toBe(0); // tool error result, permission allowed
      expect(refusal.bodies[1]).toContain("OS sandbox unavailable");
      expect(refusal.bodies[1]).not.toContain("UNSANDBOXED EXECUTION —");
      // The command never ran: no bash result sections in the tool output.
      expect(refusal.bodies[1]).not.toContain("--- stdout ---");
    },
  );
});

// ---------------------------------------------------------------------------
// `resume --compact` — real dispatch path (ADR-0008)
// ---------------------------------------------------------------------------

describe("CLI composition: resume --compact (real dispatch path)", () => {
  it("compacts the replayed history before continuing: stream event, summary call, kept rounds", async () => {
    const workspace = mkdtempSync(join(scratch, "compact-ws-"));
    writeFileSync(join(workspace, "note.txt"), "hello\n");
    const harness = makeHarness({
      env: { VOID_ANTHROPIC_KEY: "test-key" },
      cwd: workspace,
      // Run 1: three rounds (tool, tool, text). Resume --compact: the
      // summarization call (adapter complete() aggregates one SSE round)
      // then the continuation round.
      rounds: [
        toolRoundSse("call-1", "read_file", { path: join(workspace, "note.txt") }),
        toolRoundSse("call-2", "read_file", { path: join(workspace, "note.txt") }),
        textRoundSse("first done"),
        textRoundSse("SUMMARY: two reads, one note."),
        textRoundSse("second done"),
      ],
    });

    const first = await runCli(["run", "--workspace", workspace, "first task"], harness.deps);
    expect(first).toBe(0);
    const id = initEvent(harness.out).thread_id;
    const requestCount = harness.requests.length;
    const outCount = harness.out.length;

    const exit = await runCli(
      ["resume", id as string, "--workspace", workspace, "--compact", "second task"],
      harness.deps,
    );
    expect(exit).toBe(0);

    // The stream gained exactly one compaction event with the v1.1 shape,
    // emitted after init and before the result.
    const session = events(harness.out.slice(outCount));
    const compaction = session.filter((event) => event.type === "compaction");
    expect(compaction).toEqual([
      {
        type: "compaction",
        summarized_turns: 1,
        kept_turns: 2,
        trigger: "manual",
      },
    ]);
    expect(session[0]?.type).toBe("system");
    expect(session.at(-1)?.type).toBe("result");

    // The summarization call: same provider, prompts/compaction.md as the
    // system prompt, summarizing [first task, round 1, round-1 results].
    const summaryRequest = JSON.parse(harness.requests[requestCount] as string) as {
      system?: string;
      messages?: { role?: string }[];
    };
    expect(summaryRequest.system).toContain("working-state handoff");
    expect(summaryRequest.system).toContain("ONLY the summary");
    expect(summaryRequest.messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(harness.requests[requestCount]).toContain("first task");

    // The continuation request: [summary note, kept rounds 2+3, new task].
    const continuation = JSON.parse(harness.requests[requestCount + 1] as string) as {
      messages?: { role?: string; content?: { text?: string }[] }[];
    };
    expect(continuation.messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(continuation.messages?.[0]?.content?.[0]?.text).toBe(
      "[compaction summary]\nSUMMARY: two reads, one note.",
    );
    expect(harness.requests[requestCount + 1]).toContain("second task");

    // The thread log gained the compaction + summary usage events, and the
    // original rounds are still there (append-only).
    const logPath = join(harness.deps.dataDir ?? "", "threads", `${id}.jsonl`);
    const log = readFileSync(logPath, "utf8");
    const types = log
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    const compactionAt = types.indexOf("compaction");
    expect(compactionAt).toBeGreaterThan(0);
    expect(types[compactionAt + 1]).toBe("usage");
    expect(types.filter((type) => type === "assistant_message").length).toBe(4);
    expect(log).toContain('"trigger":"manual"');
  });
});
