/**
 * `src/mcp/cli` — handlers for the `void mcp` subcommands (ADR-0011):
 *
 * - `void mcp list`   — one JSONL line per configured server on stdout:
 *   name, command, connection status, and the REGISTERED tool names
 *   (mcp__<server>__<tool>), so scripts consume exactly what the model sees.
 *   Exit 0 (connection failures are data on their line, not fatal — the
 *   degraded posture matches the run path); malformed settings files are the
 *   loud exception: stderr + exit 3, same policy as `settings effective`.
 * - `void mcp doctor` — human-readable per-server handshake diagnostics:
 *   protocol version, server identity, discovered tools, loud warnings
 *   (e.g. a truncated catalog), and on failure the cause with its bounded
 *   stderr tail. Exit 0 when every configured server handshakes, 1 when any
 *   fails (a health check should fail healthily).
 *
 * Both connect the REAL configured servers (real children, no network) and
 * shut them down afterwards; the cleaner registration is the zombie guard
 * for a signal mid-command. Argument parsing and help rendering live in
 * src/cli.ts (SUBCOMMANDS is the single source of truth); only the
 * deps-shaped handlers live here — the type-only CliDeps import keeps this
 * cycle-free.
 */
import type { CliDeps } from "../cli";
import { formatSettingsProblems, loadSettings } from "../settings";
import type { McpServerConfig } from "../settings/schema";
import { registerMcpCleaner } from "./exit";
import { connectMcpServers, type McpManager, type McpServerStatus } from "./registry";

/** stderr budget for one doctor block (the client retains 8 KiB). */
const DOCTOR_STDERR_CHARS = 500;

/** Settings load shared by both handlers: problems → stderr + exit 3. */
async function loadSettingsForMcp(
  deps: CliDeps,
): Promise<number | Readonly<Record<string, McpServerConfig>>> {
  const settings = await loadSettings({
    env: deps.env,
    cwd: deps.cwd ?? process.cwd(),
    log: (line) => {
      deps.stderr(line);
    },
  });
  if (settings.problems.length > 0) {
    for (const line of formatSettingsProblems(settings.problems)) {
      deps.stderr(line);
    }
    return 3;
  }
  return settings.effective.mcpServers ?? {};
}

/** Connect + own a manager for one command; the caller must run `close()`. */
async function connectOwned(
  configs: Readonly<Record<string, McpServerConfig>>,
  deps: CliDeps,
): Promise<{ manager: McpManager; close: () => Promise<void> }> {
  const manager = await connectMcpServers(configs, { cliEnv: deps.env });
  const unregister = registerMcpCleaner(() => manager.shutdown());
  return {
    manager,
    close: async (): Promise<void> => {
      await manager.shutdown();
      unregister();
    },
  };
}

/** `void mcp list` — JSONL per server: configured, connection status, tool names. */
export async function runMcpList(deps: CliDeps): Promise<number> {
  const loaded = await loadSettingsForMcp(deps);
  if (typeof loaded === "number") {
    return loaded;
  }
  const { manager, close } = await connectOwned(loaded, deps);
  try {
    for (const status of manager.statuses) {
      deps.stdout(
        JSON.stringify({
          server: status.server,
          command: status.command,
          status: status.status,
          tools: status.tools,
          ...(status.error !== undefined ? { error: status.error } : {}),
          ...(status.protocolVersion !== undefined
            ? { protocolVersion: status.protocolVersion }
            : {}),
          ...(status.warnings !== undefined ? { warnings: status.warnings } : {}),
        }),
      );
    }
    return 0;
  } finally {
    await close();
  }
}

/** `void mcp doctor` — per-server handshake diagnostics; 0 all healthy, 1 any failure. */
export async function runMcpDoctor(deps: CliDeps): Promise<number> {
  const loaded = await loadSettingsForMcp(deps);
  if (typeof loaded === "number") {
    return loaded;
  }
  if (Object.keys(loaded).length === 0) {
    deps.stdout("no MCP servers configured (mcpServers is empty or absent in settings)");
    return 0;
  }
  const { manager, close } = await connectOwned(loaded, deps);
  try {
    let failures = 0;
    for (const status of manager.statuses) {
      if (status.status === "failed") {
        failures += 1;
      }
      for (const line of doctorBlock(status)) {
        deps.stdout(line);
      }
    }
    return failures > 0 ? 1 : 0;
  } finally {
    await close();
  }
}

/** One server's doctor block: identity when healthy, cause + stderr tail when not. */
function doctorBlock(status: McpServerStatus): string[] {
  const lines = [
    `${status.server}: ${status.status === "connected" ? "CONNECTED" : "FAILED"}`,
    `  command: ${status.command}`,
  ];
  if (status.status === "connected") {
    const identity =
      status.serverName !== undefined || status.serverVersion !== undefined
        ? `${status.serverName ?? "?"} ${status.serverVersion ?? ""}`.trim()
        : undefined;
    if (identity !== undefined) {
      lines.push(`  server: ${identity}`);
    }
    if (status.protocolVersion !== undefined) {
      lines.push(`  protocol: ${status.protocolVersion}`);
    }
    lines.push(`  tools (${status.tools.length}): ${status.tools.join(", ")}`);
    for (const warning of status.warnings ?? []) {
      lines.push(`  WARNING: ${warning}`);
    }
    return lines;
  }
  lines.push(`  error: ${status.error ?? "unknown failure"}`);
  lines.push(
    `  hint: verify command/args; the model sees this server as a structured ` +
      `mcp__${status.server}__unavailable tool error`,
  );
  const stderrTail = tailOf(status.diagnostics);
  if (stderrTail !== undefined) {
    lines.push(`  stderr (tail): ${stderrTail}`);
  }
  return lines;
}

/** Pull the stderr line out of the client's diagnostics summary, bounded. */
function tailOf(diagnostics: string | undefined): string | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const stderrLine = diagnostics.split("\n").find((line) => line.startsWith("stderr tail: "));
  const tail = stderrLine?.slice("stderr tail: ".length);
  if (tail === undefined || tail === "(empty)") {
    return undefined;
  }
  return tail.length > DOCTOR_STDERR_CHARS ? tail.slice(-DOCTOR_STDERR_CHARS) : tail;
}
