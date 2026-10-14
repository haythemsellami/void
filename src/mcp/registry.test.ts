/**
 * MCP registry-bridge tests (ADR-0011): configured servers → ToolSpec
 * entries. Real fixture children again (no mocks of the child boundary);
 * the denylist/env/refusal paths are covered in env.test.ts and
 * client.test.ts — here we prove the BRIDGE: mcp__ naming, schema
 * passthrough, the unavailable-server degradation tool the MODEL sees,
 * warnings surfacing, and the output cap applied to server results.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../contracts";
import { connectMcpServers, mcpToolName } from "./registry";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "void-mcp-reg-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/support/mcp-fixture-server.mjs",
);
const CLI_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/Users/void", TMPDIR: "/tmp" };

/** Minimal ToolContext for direct spec.execute calls (the runner builds these). */
function testContext(limits?: Partial<ToolContext["outputLimits"]>): ToolContext {
  return {
    workspaceRoot: scratch,
    workingDir: scratch,
    env: {},
    requestPermission: async () => ({ action: "allow" }),
    outputLimits: { maxTotalChars: 20_000, maxSectionChars: 2_000, ...limits },
  };
}

describe("mcp registry bridge", () => {
  it("mcpToolName composes the mcp__<server>__<tool> naming", () => {
    expect(mcpToolName("github", "create_pr")).toBe("mcp__github__create_pr");
  });

  it("registers every discovered tool with passthrough schema and mcp source", async () => {
    const manager = await connectMcpServers(
      { fixture: { command: process.execPath, args: [FIXTURE] } },
      { cliEnv: CLI_ENV },
    );
    try {
      const echo = manager.specs().find((spec) => spec.name === "mcp__fixture__echo");
      expect(echo).toBeDefined();
      expect(echo?.source).toBe("mcp");
      expect(echo?.inputSchema).toEqual({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      });
      expect(echo?.description).toContain("Echo");
      // The run path got exactly one entry per tool.
      expect(manager.specs().length).toBe(8);
      const status = manager.statuses[0];
      expect(status?.status).toBe("connected");
      expect(status?.tools).toContain("mcp__fixture__echo");
      expect(status?.protocolVersion).toBe("2025-06-18");
    } finally {
      await manager.shutdown();
    }
  });

  it("a spec.execute round-trips a real tools/call through the bridge", async () => {
    const manager = await connectMcpServers(
      { fixture: { command: process.execPath, args: [FIXTURE] } },
      { cliEnv: CLI_ENV },
    );
    try {
      const echo = manager.specs().find((spec) => spec.name === "mcp__fixture__echo");
      const result = await echo?.execute({ message: "via bridge" }, testContext());
      expect(result?.isError).toBe(false);
      expect(result?.content[0]?.text).toContain("echo: via bridge");
    } finally {
      await manager.shutdown();
    }
  });

  it("server results honor the context output cap with an explicit marker", async () => {
    const manager = await connectMcpServers(
      { fixture: { command: process.execPath, args: [FIXTURE] } },
      { cliEnv: CLI_ENV },
    );
    try {
      const echo = manager.specs().find((spec) => spec.name === "mcp__fixture__echo");
      const result = await echo?.execute(
        { message: "x".repeat(200) },
        testContext({ maxTotalChars: 50 }),
      );
      expect(result?.content[0]?.truncated).toBe(true);
      expect(result?.content[0]?.text).toContain("truncated: MCP result exceeded 50 bytes");
    } finally {
      await manager.shutdown();
    }
  });

  it("a failed server degrades to mcp__<name>__unavailable with structured diagnostics", async () => {
    const logs: string[] = [];
    const manager = await connectMcpServers(
      { broken: { command: "void-no-such-binary-xyz" } },
      { cliEnv: CLI_ENV, log: (line) => logs.push(line) },
    );
    try {
      const specs = manager.specs();
      expect(specs.map((spec) => spec.name)).toEqual(["mcp__broken__unavailable"]);
      expect(specs[0]?.source).toBe("mcp");
      const result = await specs[0]?.execute({}, testContext());
      expect(result?.isError).toBe(true);
      expect(result?.error?.code).toBe("execution_failed");
      expect(result?.error?.message).toContain("broken");
      expect(result?.error?.message).toContain("void mcp doctor");
      expect(result?.error?.details).toEqual({ server: "broken", hint: "void mcp doctor" });
      // The failure was loud on the log sink too.
      expect(logs.join("\n")).toContain('mcp server "broken" unavailable');
      expect(manager.statuses[0]?.status).toBe("failed");
    } finally {
      await manager.shutdown();
    }
  });

  it("an undefined env reference fails exactly its own server, naming the variable", async () => {
    const manager = await connectMcpServers(
      {
        bad: {
          command: process.execPath,
          args: [FIXTURE, "--token", ["$", "{", "VOID_MISSING_SECRET", "}"].join("")],
        },
        good: { command: process.execPath, args: [FIXTURE] },
      },
      { cliEnv: CLI_ENV },
    );
    try {
      const names = manager.specs().map((spec) => spec.name);
      expect(names).toContain("mcp__good__echo"); // the good server is unaffected
      expect(names).toContain("mcp__bad__unavailable");
      const failed = manager.statuses.find((status) => status.server === "bad");
      expect(failed?.error).toContain("VOID_MISSING_SECRET");
      expect(failed?.error).toContain("mcpServers.bad.args[2]");
    } finally {
      await manager.shutdown();
    }
  });

  it("a credential env reference is refused even though the variable exists", async () => {
    const manager = await connectMcpServers(
      {
        sneaky: {
          command: process.execPath,
          args: [FIXTURE, "--key", ["$", "{", "VOID_ANTHROPIC_KEY", "}"].join("")],
        },
      },
      { cliEnv: { ...CLI_ENV, VOID_ANTHROPIC_KEY: "sk-live" } },
    );
    try {
      const failed = manager.statuses[0];
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toContain("VOID_ANTHROPIC_KEY");
      expect(failed?.error).toContain("refusing");
    } finally {
      await manager.shutdown();
    }
  });

  it("a truncated catalog (pagination cap) is loud: status warnings + log lines", async () => {
    const logs: string[] = [];
    const manager = await connectMcpServers(
      { endless: { command: process.execPath, args: [FIXTURE, "--endless-pagination"] } },
      { cliEnv: CLI_ENV, log: (line) => logs.push(line) },
    );
    try {
      const status = manager.statuses[0];
      expect(status?.status).toBe("connected");
      expect(status?.warnings?.[0]).toContain("TRUNCATED");
      expect(logs.join("\n")).toContain("TRUNCATED");
    } finally {
      await manager.shutdown();
    }
  });

  it("zero configured servers yields an empty, fully-shutdown manager", async () => {
    const manager = await connectMcpServers({}, { cliEnv: CLI_ENV });
    expect(manager.specs()).toEqual([]);
    expect(manager.statuses).toEqual([]);
    await manager.shutdown();
  });
});
