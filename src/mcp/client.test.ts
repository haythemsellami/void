/**
 * MCP stdio client tests (ADR-0011) against the REAL in-repo fixture server
 * (tests/support/mcp-fixture-server.mjs) spawned as a REAL child — no mocks
 * of the child boundary, no network (CI's offline jobs deny egress; the
 * fixture is a local script, never `npx`). The fixture runs under
 * process.execPath, which is Node under vitest and Bun under `bun test`; it
 * is written runtime-agnostic on purpose.
 *
 * The pure mapping functions (content blocks → ToolResult, JSON-RPC error →
 * ToolError) are tested without spawning anything.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  jsonRpcErrorToToolError,
  MAX_TOOLS_LIST_PAGES,
  McpStdioServer,
  mapMcpCallResult,
} from "./client";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/support/mcp-fixture-server.mjs",
);
const CLI_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/Users/void", TMPDIR: "/tmp" };

/** Connect the fixture with a mode argument; caller must shutdown(). */
function connectFixture(mode = "", extra: Record<string, unknown> = {}): Promise<McpStdioServer> {
  return McpStdioServer.connect({
    name: "fixture",
    command: process.execPath,
    ...(mode !== "" ? { args: [FIXTURE, mode] } : { args: [FIXTURE] }),
    cliEnv: CLI_ENV,
    startupTimeoutMs: 8_000,
    ...extra,
  });
}

describe("mcp pure result mapping (no spawn)", () => {
  it("joins multiple text blocks with newlines", () => {
    const result = mapMcpCallResult("srv", "t", {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "first\nsecond" }]);
  });

  it("non-text blocks become explicit placeholders (P1 ToolResult is text-only)", () => {
    const result = mapMcpCallResult("srv", "t", {
      content: [
        { type: "text", text: "keep" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    });
    expect(result.content[0]?.text).toBe("keep\n[unsupported MCP content block type: image]");
  });

  it("missing/empty content maps to an explicit no-content marker, not silence", () => {
    expect(mapMcpCallResult("srv", "t", {}).content[0]?.text).toBe("(no content returned)");
    expect(mapMcpCallResult("srv", "t", { content: [] }).content[0]?.text).toBe(
      "(no content returned)",
    );
  });

  it("isError: true is honored as a structured execution_failed error naming server+tool", () => {
    const result = mapMcpCallResult("srv", "t", {
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe("execution_failed");
    expect(result.error?.message).toContain("srv__t");
    expect(result.error?.message).toContain("boom");
    expect(result.error?.details).toEqual({ server: "srv", tool: "t" });
  });

  it("JSON-RPC error codes map onto our ToolError taxonomy", () => {
    expect(jsonRpcErrorToToolError("s", { code: -32601, message: "no method" })).toMatchObject({
      code: "not_found",
      retryable: false,
    });
    expect(jsonRpcErrorToToolError("s", { code: -32602, message: "bad params" })).toMatchObject({
      code: "invalid_input",
      retryable: true,
    });
    expect(jsonRpcErrorToToolError("s", { code: -32700, message: "parse" })).toMatchObject({
      code: "invalid_input",
    });
    expect(jsonRpcErrorToToolError("s", { code: -32000, message: "custom" })).toMatchObject({
      code: "execution_failed",
      retryable: true,
    });
  });
});

describe("mcp stdio client against the real fixture child", () => {
  it("handshakes (initialize → initialized → tools/list) and discovers the catalog", async () => {
    const server = await connectFixture();
    try {
      const names = server.tools.map((tool) => tool.name);
      expect(names).toContain("echo");
      expect(names).toContain("env_report");
      expect(server.serverInfo).toEqual({
        protocolVersion: "2025-06-18",
        name: "fixture-server",
        version: "1.2.3",
      });
      // The client identified itself as void and requested our protocol revision.
      const report = await server.callTool("handshake_report", {});
      const seen = JSON.parse(report.content[0]?.text ?? "{}") as {
        protocolVersion?: string;
        clientInfo?: { name?: string };
      };
      expect(seen.protocolVersion).toBe("2025-06-18");
      expect(seen.clientInfo?.name).toBe("void");
    } finally {
      await server.shutdown();
    }
  });

  it("follows tools/list pagination pages to the end of the catalog", async () => {
    const server = await connectFixture("--paginated");
    try {
      expect(server.tools.length).toBe(8); // both pages aggregated
      expect(server.warnings).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it("a catalog that never stops paginating hits the cap LOUDLY, not silently", async () => {
    const server = await connectFixture("--endless-pagination");
    try {
      expect(server.warnings.length).toBe(1);
      expect(server.warnings[0]).toContain("TRUNCATED");
      expect(server.warnings[0]).toContain(String(MAX_TOOLS_LIST_PAGES));
      // Deduped across pages: the fixture repeats one tool name every page.
      expect(server.tools.map((tool) => tool.name)).toEqual(["echo"]);
    } finally {
      await server.shutdown();
    }
  });

  it("tools/call maps multi-block text results and echoes arguments", async () => {
    const server = await connectFixture();
    try {
      const result = await server.callTool("echo", { message: "hi mcp" });
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain("echo: hi mcp");
      expect(result.content[0]?.text).toContain('args: {"message":"hi mcp"}');
    } finally {
      await server.shutdown();
    }
  });

  it("server-side isError arrives as a structured error result (no throw)", async () => {
    const server = await connectFixture();
    try {
      const result = await server.callTool("fail", { message: "deliberate" });
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe("execution_failed");
      expect(result.content[0]?.text).toContain("fixture failure: deliberate");
    } finally {
      await server.shutdown();
    }
  });

  it("child env is constructed: configured env present, CLI credentials ABSENT", async () => {
    const server = await McpStdioServer.connect({
      name: "fixture",
      command: process.execPath,
      args: [FIXTURE],
      cliEnv: {
        ...CLI_ENV,
        VOID_ANTHROPIC_KEY: "sk-void",
        ANTHROPIC_API_KEY: "sk-ambient",
        VOID_OPENAI_KEY: "sk-openai",
      },
      env: { FIXTURE_TOKEN: "from-config", DENIED_TOO: "x" },
    });
    try {
      const report = await server.callTool("env_report", {});
      const childEnv = JSON.parse(report.content[0]?.text ?? "{}") as Record<string, string>;
      expect(childEnv.FIXTURE_TOKEN).toBe("from-config");
      expect(childEnv.PATH).toBe(CLI_ENV.PATH);
      expect(childEnv.HOME).toBe("/Users/void");
      expect(childEnv.TMPDIR).toBe("/tmp");
      // The credential envs existed in the CLI process but must not exist in
      // the child — the whole denylist, checked on a REAL spawned process.
      expect(childEnv.VOID_ANTHROPIC_KEY).toBeUndefined();
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.VOID_OPENAI_KEY).toBeUndefined();
      expect(Object.keys(childEnv).filter((key) => key.startsWith("VOID_"))).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it("per-call timeout returns a structured timeout result and the server stays usable", async () => {
    const server = await connectFixture("", { callTimeoutMs: 150 });
    try {
      const timedOut = await server.callTool("slow", { delayMs: 5_000 });
      expect(timedOut.isError).toBe(true);
      expect(timedOut.error?.code).toBe("timeout");
      expect(timedOut.error?.retryable).toBe(true);
      // The client told the server it cancelled, and the session survived.
      const report = await server.callTool("cancel_report", {});
      expect(JSON.parse(report.content[0]?.text ?? "[]")).toEqual([3]); // id of tools/call
      const after = await server.callTool("echo", { message: "still alive" });
      expect(after.isError).toBe(false);
      expect(after.content[0]?.text).toContain("still alive");
    } finally {
      await server.shutdown();
    }
  });

  it("AbortSignal cancellation sends notifications/cancelled and resolves structured", async () => {
    const server = await connectFixture();
    try {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 60);
      const result = await server.callTool("slow", { delayMs: 10_000 }, controller.signal);
      expect(result.isError).toBe(true);
      expect(result.error?.message).toContain("aborted");
      const report = await server.callTool("cancel_report", {});
      expect(JSON.parse(report.content[0]?.text ?? "[]")).toEqual([3]);
    } finally {
      await server.shutdown();
    }
  });
});

describe("mcp stdio client failure paths (real children)", () => {
  it("a missing binary fails loudly naming the command", async () => {
    await expect(
      McpStdioServer.connect({
        name: "ghost",
        command: "void-no-such-binary-xyz",
        cliEnv: CLI_ENV,
        startupTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/ghost.*void-no-such-binary-xyz.*(failed to start|failed to spawn)/s);
  });

  it("a handshake JSON-RPC error surfaces verbatim", async () => {
    await expect(connectFixture("--handshake-fail")).rejects.toThrow(
      /fixture refuses to initialize/,
    );
  });

  it("a silent server hits the startup deadline with a timeout naming the handshake", async () => {
    await expect(connectFixture("--hang", { startupTimeoutMs: 250 })).rejects.toThrow(
      /fixture.*handshake.*250ms/s,
    );
  });

  it("non-JSON stdout noise is ignored (diagnostics count it), stderr is captured", async () => {
    const server = await connectFixture("--garbage");
    try {
      expect(server.tools.length).toBe(8); // session unaffected by the banner
      const diagnostics = server.diagnostics();
      expect(diagnostics).toContain("non-JSON stdout lines ignored: 1");
      expect(diagnostics).toContain("fixture-server ready"); // stderr tail
    } finally {
      await server.shutdown();
    }
  });

  it("the server's protocolVersion answer is recorded even when older than ours", async () => {
    const server = await connectFixture("--old-protocol");
    try {
      expect(server.serverInfo.protocolVersion).toBe("2024-11-05");
    } finally {
      await server.shutdown();
    }
  });

  it("mid-session child exit fails the pending call, then fails fast", async () => {
    const server = await connectFixture();
    const died = await server.callTool("die", {});
    expect(died.isError).toBe(true);
    expect(died.error?.message).toContain("exited");
    const after = await server.callTool("echo", { message: "nope" });
    expect(after.isError).toBe(true);
    expect(after.error?.message).toContain("no longer connected");
    expect(after.error?.message).toContain("7"); // the fixture's exit code
    await server.shutdown(); // idempotent on an already-dead child
  });

  it("shutdown terminates a server that ignores stdin EOF (SIGTERM path)", async () => {
    const server = await connectFixture();
    const exit = server.whenExited();
    await server.shutdown();
    // Resolves once the child is reaped — no zombie pending forever. The
    // fixture exits 0 on stdin EOF; null means SIGTERM won the race. Either
    // way the await itself proves the child was collected.
    expect([0, null]).toContain(await exit);
    // A second shutdown is a no-op that still resolves.
    await server.shutdown();
  });
});
