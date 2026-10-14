/**
 * examples/examples.test.ts — keeps the shipped examples honest.
 *
 * Three gates (one per example, all offline — safe for the `offline` CI job):
 *
 * 1. `consume-stream.sh`: `bash -n` syntax gate always; when `jq` exists,
 *    the full behavioral pass — feed a fixture stream-JSON session
 *    (docs/stream-json.md v1.1 shapes) through the script and assert the
 *    rendered lines and the exit-code propagation from the `result` event.
 * 2. `mcp-server-config`: the settings JSON must validate against the REAL
 *    settings schema (src/settings/schema.ts), and the server script must
 *    complete the REAL handshake (src/mcp/client.ts McpStdioServer) and
 *    answer both tools.
 * 3. `permissions`: both layered files validate against the real schema;
 *    the worked merge-order claims in the README are asserted against the
 *    actual evaluate() engine over the merged arrays.
 *
 * Runtime-agnostic (Bun `bun test` and Node vitest): child spawning uses
 * node:child_process, and the runner binary for the MCP server is
 * process.execPath (both runtimes can execute the dependency-free .mjs).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../src/contracts/permissions";
import type { JsonObject } from "../src/contracts/tools";
import { McpStdioServer } from "../src/mcp/client";
import { DEFAULT_RULES } from "../src/permissions";
import { validateSettings } from "../src/settings/schema";

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)));
const CLI_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

/** Run a command, return {code, stdout, stderr} without throwing. */
function run(bin: string, args: readonly string[], input?: string) {
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    input: input ?? "",
    env: CLI_ENV,
    timeout: 30_000,
  });
  return {
    code: res.status,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
  };
}

/** jq presence gate for the consume-stream behavioral pass. */
const haveJq = run("jq", ["--version"]).code === 0;

/** A minimal but complete v1.1 session covering every event type. */
const FIXTURE_SESSION = [
  {
    type: "system",
    subtype: "init",
    thread_id: "thr_fixture",
    model: "anthropic/claude-sonnet-4-5",
    workspace_root: "/work/demo",
    tools: ["bash", "edit_file", "grep", "read_file"],
    resumed_from: null,
    version: "0.0.0",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Checking the README first." }],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "read_file",
          input: { path: "/work/demo/README.md" },
        },
      ],
    },
  },
  {
    type: "permission",
    decision: "ask",
    headless_denied: true,
    tool: "bash",
    input: { command: "git push origin main" },
    reason: 'rule[1] (tool "bash") matched input key "command" → ask',
    message: "denied headless",
  },
  { type: "compaction", summarized_turns: 12, kept_turns: 2, trigger: "threshold" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    exit_code: 0,
    thread_id: "thr_fixture",
    duration_ms: 1840,
    num_turns: 3,
    stop_reason: "end_turn",
    total_usage: { input_tokens: 4310, output_tokens: 212 },
    result: "All done.",
  },
].map((event) => JSON.stringify(event));

describe("examples/consume-stream.sh", () => {
  it("passes bash -n (syntax)", () => {
    const res = run("bash", ["-n", join(EXAMPLES_DIR, "consume-stream.sh")]);
    expect(res.code).toBe(0);
  });

  it.skipIf(!haveJq)("renders every event kind and propagates exit 0", () => {
    const res = run(
      "bash",
      [join(EXAMPLES_DIR, "consume-stream.sh")],
      `${FIXTURE_SESSION.join("\n")}\n`,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("anthropic/claude-sonnet-4-5");
    expect(res.stdout).toContain("thread thr_fixture");
    expect(res.stdout).toContain("Checking the README first.");
    expect(res.stdout).toContain("read_file");
    expect(res.stdout).toContain("denied headless");
    expect(res.stdout).toContain("compacted: 12 turns summarized");
    expect(res.stdout).toContain("All done.");
  });

  it.skipIf(!haveJq)("propagates a nonzero result exit code", () => {
    const failing = FIXTURE_SESSION.slice(0, -1).concat(
      JSON.stringify({
        type: "result",
        subtype: "error_permission_rejected",
        is_error: true,
        exit_code: 2,
        thread_id: "thr_fixture",
        duration_ms: 100,
        num_turns: 1,
        stop_reason: "end_turn",
        total_usage: { input_tokens: 10, output_tokens: 2 },
        error: "a rule rejected the call",
      }),
    );
    const res = run("bash", [join(EXAMPLES_DIR, "consume-stream.sh")], `${failing.join("\n")}\n`);
    expect(res.code).toBe(2);
    expect(res.stdout).toContain("error_permission_rejected");
  });

  it.skipIf(!haveJq)("exits 3 on a stream with no result event", () => {
    const truncated = FIXTURE_SESSION.slice(0, 2);
    const res = run("bash", [join(EXAMPLES_DIR, "consume-stream.sh")], `${truncated.join("\n")}\n`);
    expect(res.code).toBe(3);
  });
});

describe("examples/mcp-server-config", () => {
  it("settings.json validates against the real settings schema", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "mcp-server-config", "settings.json"), "utf8");
    const result = validateSettings(JSON.parse(raw));
    if (!result.ok) console.error(result.errors.map((e) => `${e.key}: ${e.message}`).join("\n"));
    expect(result.ok).toBe(true);
  });

  it("server.mjs completes the real Void handshake and answers both tools", async () => {
    const server = await McpStdioServer.connect({
      name: "example",
      command: process.execPath,
      args: [join(EXAMPLES_DIR, "mcp-server-config", "server.mjs")],
      cliEnv: CLI_ENV,
      startupTimeoutMs: 10_000,
    });
    try {
      const names = server.tools.map((t) => t.name).sort();
      expect(names).toEqual(["add", "hello"]);

      const hello = await server.callTool("hello", { name: "Void" });
      expect(hello.isError).toBe(false);
      expect(hello.content).toEqual([{ type: "text", text: "hello, Void!" }]);

      const sum = await server.callTool("add", { a: 2, b: 40 });
      expect(sum.content).toEqual([{ type: "text", text: "42" }]);

      const bad = await server.callTool("add", { a: "x" });
      expect(bad.isError).toBe(true);
    } finally {
      await server.shutdown();
    }
  });

  it("server.mjs runs standalone from a shell (offline smoke)", () => {
    const script = join(EXAMPLES_DIR, "mcp-server-config", "server.mjs");
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n");
    const res = run(process.execPath, [script], `${lines}\n`);
    expect(res.code).toBe(0);
    const replies = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies[0]?.result?.serverInfo?.name).toBe("void-example-server");
    expect(
      (replies[1]?.result?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name).sort(),
    ).toEqual(["add", "hello"]);
  });
});

describe("examples/permissions", () => {
  const userFile = JSON.parse(
    readFileSync(join(EXAMPLES_DIR, "permissions", "user-settings.json"), "utf8"),
  );
  const workspaceFile = JSON.parse(
    readFileSync(join(EXAMPLES_DIR, "permissions", "workspace-settings.json"), "utf8"),
  );

  it("both layers validate against the real settings schema", () => {
    for (const body of [userFile, workspaceFile]) {
      const result = validateSettings(body);
      if (!result.ok) console.error(result.errors.map((e) => `${e.key}: ${e.message}`).join("\n"));
      expect(result.ok).toBe(true);
    }
  });

  it("merges workspace-first and the README's worked outcomes hold", async () => {
    // The documented merge order (ADR-0006): workspace rules, then user
    // rules, then DEFAULT_RULES — first match wins.
    const merged: PermissionRule[] = [
      ...workspaceFile.permissions,
      ...userFile.permissions,
      ...DEFAULT_RULES,
    ];
    const { evaluate } = await import("../src/permissions");
    const decide = (tool: string, input: JsonObject) =>
      evaluate(tool, input, merged, { workspaceRoot: "/work/demo" }).decision.action;

    expect(decide("bash", { command: "bun run test" })).toBe("allow"); // user allow
    expect(decide("bash", { command: "bun run deploy prod" })).toBe("ask"); // workspace shadows user
    expect(decide("bash", { command: "sudo id" })).toBe("reject"); // user reject
    expect(decide("bash", { command: "npm install" })).toBe("allow"); // workspace shadows default ask
  });
});
