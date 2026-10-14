/**
 * MCP composition tests (ADR-0011) — the AGENTS.md working agreement applied
 * to this workstream: changes to `src/cli.ts` / `src/app/runner.ts`
 * composition need tests driving the REAL path. Everything here goes through
 * `runCli` → `runTask` → engine → permission gate → the REAL MCP client
 * spawning the REAL in-repo fixture server
 * (tests/support/mcp-fixture-server.mjs) as a child process — no mocks of
 * the child boundary, no network (offline CI jobs deny egress; the fixture
 * is a local script, never `npx`).
 *
 * Proves end-to-end:
 * - a settings `mcpServers` entry joins the run: init event advertises the
 *   mcp__ tools, a scripted model round calls mcp__fixture__echo, the real
 *   child round-trips, and the result reaches the provider request;
 * - the env policy holds on the real path (${VAR} expansion from the CLI env
 *   reached the child; the CLI's credentials did NOT);
 * - a failed server degrades to mcp__<name>__unavailable, the run still
 *   exits 0, and the MODEL sees the structured error naming the server;
 * - `void mcp list` / `void mcp doctor` output shapes and exit codes.
 *
 * Init-tools coordination note (reviewer focus): init.tools = builtin names
 * + connected servers' registered names (sorted by the emitter), and a
 * failed server contributes exactly mcp__<name>__unavailable — pinned below
 * against the fixture's known catalog, the same anti-drift pattern as the
 * builtin-only pin in cli-composition.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, type CliDeps, runCli } from "../cli";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-mcp-comp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/support/mcp-fixture-server.mjs",
);

/** The fixture's fixed tool catalog, in the server's declared order. */
const FIXTURE_TOOLS = [
  "echo",
  "fail",
  "slow",
  "env_report",
  "handshake_report",
  "cancel_report",
  "mixed",
  "die",
].map((tool) => `mcp__fixture__${tool}`);

/** A literal `${NAME}` reference, built where the linter cannot misread it. */
const varRef = (name: string): string => ["$", "{", name, "}"].join("") as string;

// ---------------------------------------------------------------------------
// Scripted anthropic SSE (the real adapter parses these) — same shapes as
// cli-composition.test.ts.
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
// Workspace + harness helpers
// ---------------------------------------------------------------------------

/** A workspace with .void/settings.json configuring the fixture server. */
function mcpWorkspace(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
): string {
  const workspace = mkdtempSync(join(scratch, "ws-"));
  mkdirSync(join(workspace, ".void"));
  writeFileSync(
    join(workspace, ".void", "settings.json"),
    JSON.stringify({ settingsVersion: 1, mcpServers: servers }),
  );
  return workspace;
}

/** Isolated XDG config home (no user-scope settings bleed into the tests). */
const emptyXdg = mkdtempSync(join(scratch, "xdg-"));

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly requests: string[];
}

function makeHarness(options: {
  readonly cwd: string;
  readonly rounds: readonly string[];
  readonly extraEnv?: Record<string, string | undefined>;
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const queue = [...options.rounds];
  const deps: CliDeps = {
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      err.push(line);
    },
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      XDG_CONFIG_HOME: emptyXdg,
      VOID_ANTHROPIC_KEY: "test-key",
      ...(options.extraEnv ?? {}),
    },
    cwd: options.cwd,
    dataDir: mkdtempSync(join(scratch, "data-")),
    fetchImpl: (url: string, init?: RequestInit) => {
      void url;
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
  return { deps, out, err, requests };
}

function events(out: readonly string[]): Record<string, unknown>[] {
  return out.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function initEvent(out: readonly string[]): Record<string, unknown> {
  const first = events(out)[0];
  expect(first?.type).toBe("system");
  return first as Record<string, unknown>;
}

/** The FULL uncapped tool-result text sent back to the provider. */
function fullToolResult(
  requests: readonly string[],
  toolUseId: string,
): { text: string; isError: boolean } {
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
// run/resume with a configured MCP server — the real dispatch path
// ---------------------------------------------------------------------------

describe("CLI composition: MCP servers in a real run (ADR-0011)", () => {
  it("a model round calls mcp__fixture__echo through a REAL server child", async () => {
    const workspace = mcpWorkspace({ fixture: { command: process.execPath, args: [FIXTURE] } });
    const harness = makeHarness({
      cwd: workspace,
      rounds: [
        toolRoundSse("toolu_1", "mcp__fixture__echo", { message: "hello from the model" }),
        textRoundSse("done after the tool round"),
      ],
    });

    const code = await runCli(["run", "--workspace", workspace, "use the fixture"], harness.deps);
    expect(code).toBe(0);

    // Init advertises EXACTLY builtins + the fixture's full catalog (the
    // emitter sorts; a healthy server ships no `unavailable` degradation
    // tool). This is the mcp-aware extension of the builtin-only anti-drift
    // pin in cli-composition.test.ts: init.tools == the run's registry.
    const init = initEvent(harness.out);
    expect(init.tools).toEqual([...BUILTIN_TOOLS, ...FIXTURE_TOOLS].sort());
    expect((init.tools as string[]).filter((name) => name.startsWith("mcp__"))).toEqual(
      [...FIXTURE_TOOLS].sort(),
    );

    // The real child round-trip reached the provider request verbatim.
    const result = fullToolResult(harness.requests, "toolu_1");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("echo: hello from the model");
    expect(result.text).toContain("args: ");
  });

  it("env policy on the real path: braced env expanded into the child, CLI credentials absent", async () => {
    const workspace = mcpWorkspace({
      fixture: {
        command: process.execPath,
        args: [FIXTURE],
        env: { FIXTURE_TOKEN: varRef("FIXTURE_SECRET") },
      },
    });
    const harness = makeHarness({
      cwd: workspace,
      rounds: [toolRoundSse("toolu_env", "mcp__fixture__env_report", {}), textRoundSse("done")],
      extraEnv: { FIXTURE_SECRET: "expanded-secret-value" },
    });

    const code = await runCli(["run", "--workspace", workspace, "inspect env"], harness.deps);
    expect(code).toBe(0);
    const result = fullToolResult(harness.requests, "toolu_env");
    // The child SAW the expanded configured token…
    expect(result.text).toContain('"FIXTURE_TOKEN":"expanded-secret-value"');
    // …and none of the CLI's credential env, which existed in the CLI process.
    expect(result.text).not.toContain("VOID_ANTHROPIC_KEY");
    expect(result.text).not.toContain("ANTHROPIC_API_KEY");
    expect(result.text).not.toContain("test-key");
  });

  it("a failed server degrades to mcp__<name>__unavailable; the run exits 0 and the model sees the error", async () => {
    const workspace = mcpWorkspace({
      fixture: { command: process.execPath, args: [FIXTURE] },
      broken: { command: "void-no-such-binary-xyz" },
    });
    const harness = makeHarness({
      cwd: workspace,
      rounds: [
        toolRoundSse("toolu_dead", "mcp__broken__unavailable", {}),
        textRoundSse("noted the server is down"),
      ],
    });

    const code = await runCli(
      ["run", "--workspace", workspace, "call the broken one"],
      harness.deps,
    );
    expect(code).toBe(0); // a degraded server is not a failed run

    const init = initEvent(harness.out);
    const tools = init.tools as string[];
    expect(tools).toContain("mcp__broken__unavailable");
    expect(tools).toContain("mcp__fixture__echo"); // the healthy server still shipped
    expect(tools.filter((name) => name.startsWith("mcp__broken__"))).toEqual([
      "mcp__broken__unavailable",
    ]);

    const result = fullToolResult(harness.requests, "toolu_dead");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("broken");
    expect(result.text).toContain("void mcp doctor");
    // The failure was loud on stderr during the run.
    expect(harness.err.join("\n")).toContain('mcp server "broken" unavailable');
  });

  it("the mcp__* permission default allows the call through the real gate", async () => {
    const workspace = mcpWorkspace({ fixture: { command: process.execPath, args: [FIXTURE] } });
    const harness = makeHarness({
      cwd: workspace,
      rounds: [
        toolRoundSse("toolu_perm", "mcp__fixture__echo", { message: "gate check" }),
        textRoundSse("ok"),
      ],
    });
    const code = await runCli(["run", "--workspace", workspace, "gate check"], harness.deps);
    expect(code).toBe(0); // an ask would have been a headless denial → exit 1
    const permissions = events(harness.out).filter((event) => event.type === "permission");
    expect(permissions.some((event) => event.decision === "allow")).toBe(true);
    expect(fullToolResult(harness.requests, "toolu_perm").text).toContain("gate check");
  });
});

// ---------------------------------------------------------------------------
// `void mcp list` / `void mcp doctor`
// ---------------------------------------------------------------------------

describe("CLI composition: void mcp list (ADR-0011)", () => {
  it("prints one JSONL line per server: status + registered tool names; exit 0", async () => {
    const workspace = mcpWorkspace({
      fixture: { command: process.execPath, args: [FIXTURE] },
      broken: { command: "void-no-such-binary-xyz" },
    });
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "list"], harness.deps);
    expect(code).toBe(0);

    const lines = harness.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2); // sorted by server name: broken, fixture
    const broken = lines[0];
    const fixture = lines[1];
    expect(broken?.server).toBe("broken");
    expect(broken?.status).toBe("failed");
    expect(String(broken?.error)).toContain("void-no-such-binary-xyz");
    expect(broken?.tools).toEqual(["mcp__broken__unavailable"]);
    expect(fixture?.server).toBe("fixture");
    expect(fixture?.status).toBe("connected");
    expect(fixture?.protocolVersion).toBe("2025-06-18");
    expect(fixture?.tools).toEqual(FIXTURE_TOOLS);
  });

  it("no configured servers: empty stdout, exit 0", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-empty-"));
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "list"], harness.deps);
    expect(code).toBe(0);
    expect(harness.out).toEqual([]);
  });

  it("malformed settings: stderr problems + exit 3, nothing on stdout", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-bad-"));
    mkdirSync(join(workspace, ".void"));
    writeFileSync(
      join(workspace, ".void", "settings.json"),
      JSON.stringify({ settingsVersion: 1, mcpServers: { nope: { args: ["x"] } } }),
    );
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "list"], harness.deps);
    expect(code).toBe(3);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("\n")).toContain("mcpServers.nope.command");
  });
});

describe("CLI composition: void mcp doctor (ADR-0011)", () => {
  it("healthy server: CONNECTED block with identity, protocol, tools; exit 0", async () => {
    const workspace = mcpWorkspace({ fixture: { command: process.execPath, args: [FIXTURE] } });
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "doctor"], harness.deps);
    expect(code).toBe(0);
    const text = harness.out.join("\n");
    expect(text).toContain("fixture: CONNECTED");
    expect(text).toContain("fixture-server 1.2.3");
    expect(text).toContain("protocol: 2025-06-18");
    expect(text).toContain(`tools (${FIXTURE_TOOLS.length}): ${FIXTURE_TOOLS.join(", ")}`);
  });

  it("any failed server: FAILED block with error + hint, exit 1", async () => {
    const workspace = mcpWorkspace({
      fixture: { command: process.execPath, args: [FIXTURE] },
      broken: { command: "void-no-such-binary-xyz" },
    });
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "doctor"], harness.deps);
    expect(code).toBe(1);
    const text = harness.out.join("\n");
    expect(text).toContain("fixture: CONNECTED");
    expect(text).toContain("broken: FAILED");
    expect(text).toContain("error: ");
    expect(text).toContain("mcp__broken__unavailable");
  });

  it("no configured servers: informative line, exit 0", async () => {
    const workspace = mkdtempSync(join(scratch, "ws-doc-empty-"));
    const harness = makeHarness({ cwd: workspace, rounds: [] });
    const code = await runCli(["mcp", "doctor"], harness.deps);
    expect(code).toBe(0);
    expect(harness.out.join("\n")).toContain("no MCP servers configured");
  });
});

// ---------------------------------------------------------------------------
// Subcommand plumbing (house style: parse + help)
// ---------------------------------------------------------------------------

describe("CLI composition: mcp subcommand plumbing", () => {
  it("`void mcp --help` renders the subcommand page and exits 0", async () => {
    const harness = makeHarness({ cwd: scratch, rounds: [] });
    const code = await runCli(["mcp", "--help"], harness.deps);
    expect(code).toBe(0);
    const text = harness.out.join("\n");
    expect(text).toContain("void mcp <list|doctor>");
    expect(text).toContain("void mcp list");
    expect(text).toContain("void mcp doctor");
  });

  it("the bare `void --help` list includes the mcp subcommand", async () => {
    const harness = makeHarness({ cwd: scratch, rounds: [] });
    const code = await runCli(["--help"], harness.deps);
    expect(code).toBe(0);
    expect(harness.out.join("\n")).toContain("mcp <list|doctor>");
  });

  it("`void mcp bogus` is a usage error (exit 64)", async () => {
    const harness = makeHarness({ cwd: scratch, rounds: [] });
    const code = await runCli(["mcp", "bogus"], harness.deps);
    expect(code).toBe(64);
    expect(harness.err.join("\n")).toContain("mcp expects exactly");
  });

  it("`void mcp list --extra` is a usage error (exit 64)", async () => {
    const harness = makeHarness({ cwd: scratch, rounds: [] });
    const code = await runCli(["mcp", "list", "--extra"], harness.deps);
    expect(code).toBe(64);
  });
});
