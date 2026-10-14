/**
 * `src/mcp/env` — environment policy for MCP server children (ADR-0011).
 *
 * Two independent rules, both load-bearing:
 *
 * 1. `${VAR}` expansion in `args`/`env` VALUES (not the command — the
 *    executable is a literal the user audited) resolves against the CLI's
 *    environment. An undefined variable is a LOUD error naming the variable
 *    and its settings location (`McpEnvError`), never an empty string —
 *    `npx ${MISSING_TOKEN}` silently half-working is exactly the failure
 *    mode ADR-0011 refuses to ship.
 * 2. The child env is CONSTRUCTED, never inherited: a minimal base
 *    (PATH/HOME/TMPDIR, each only when the CLI itself has it) plus exactly
 *    what the user configured. The CLI's credential variables cannot leak
 *    because they are structurally never copied — and
 *    {@link MCP_CREDENTIAL_ENV_DENYLIST} is a second, explicit lock on the
 *    same door: those names are stripped from the final env even when a
 *    settings file asks for them by key, and `${VAR}` references to them are
 *    REFUSED at expansion time (a credential must not be resolved into argv,
 *    where `ps` and server-side logs can read it), so a copy-pasted
 *    `mcpServers` block cannot forward Void's key material to a server child
 *    by any route. Amp strips its API key from child envs the same way
 *    — we strip everything not explicitly configured.
 *
 * Pure module: no `process.*` reads — the CLI injects its env.
 */
import type { McpServerConfig } from "../settings/schema";

/** One stdio server config with every `${VAR}` already expanded. */
export interface ExpandedServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Loud failure expanding a server config: names the variable and its location. */
export class McpEnvError extends Error {
  constructor(
    /** The undefined variable name, e.g. `MISSING_TOKEN`. */
    readonly variable: string,
    /** Where it was referenced, e.g. `mcpServers.github.args[1]`. */
    readonly location: string,
  ) {
    super(
      `${location}: environment variable ${variable} is not set — ` +
        `\${VAR} references must resolve against the CLI environment ` +
        "(set the variable or remove the reference)",
    );
    this.name = "McpEnvError";
  }
}

/**
 * The explicit credential/control denylist for MCP server children — Void's
 * OWN environment, never a server's business. Belt AND suspenders: the child
 * env is built from a minimal base (PATH/HOME/TMPDIR) plus user config, so
 * none of these can arrive implicitly; the list exists so they cannot arrive
 * EXPLICITLY either (a settings entry naming one of these keys is dropped).
 *
 * - VOID_ANTHROPIC_KEY / ANTHROPIC_API_KEY — Anthropic credentials.
 * - VOID_OPENAI_KEY / OPENAI_API_KEY — OpenAI-compatible credentials.
 * - VOID_ANTHROPIC_BASE_URL / VOID_OPENAI_BASE_URL / VOID_OLLAMA_URL —
 *   provider endpoint overrides (can carry proxy auth paths).
 * - VOID_MODEL / VOID_DEFAULT_MODEL — model selection (CLI control, not server data).
 * - VOID_DATA_DIR — thread storage location (not a server's concern).
 * - VOID_ALLOW_UNSANDBOXED / VOID_ASYNC_MAX_LIFETIME_MS — sandbox and tool
 *   knobs; a server child must never observe or act on Void's own tool policy.
 */
export const MCP_CREDENTIAL_ENV_DENYLIST: readonly string[] = [
  "VOID_ANTHROPIC_KEY",
  "ANTHROPIC_API_KEY",
  "VOID_OPENAI_KEY",
  "OPENAI_API_KEY",
  "VOID_ANTHROPIC_BASE_URL",
  "VOID_OPENAI_BASE_URL",
  "VOID_OLLAMA_URL",
  "VOID_MODEL",
  "VOID_DEFAULT_MODEL",
  "VOID_DATA_DIR",
  "VOID_ALLOW_UNSANDBOXED",
  "VOID_ASYNC_MAX_LIFETIME_MS",
];

/** The minimal base every server child gets (each key only when the CLI has it). */
const BASE_ENV_KEYS: readonly string[] = ["PATH", "HOME", "TMPDIR"];

/** Denylist as a Set for the expansion-time credential refusal. */
const credentialVars: ReadonlySet<string> = new Set(MCP_CREDENTIAL_ENV_DENYLIST);

/**
 * Refusing to expand a denylisted credential variable into server config.
 * Distinct from {@link McpEnvError} (a config bug): this is a security
 * refusal — the value EXISTS, but inlining it into argv/env would expose the
 * CLI's key material in `ps` output and server-side logs.
 */
export class McpCredentialRefusalError extends Error {
  constructor(
    readonly variable: string,
    readonly location: string,
  ) {
    super(
      `${location}: refusing to expand \${${variable}} — it names one of Void's ` +
        "own credential/control variables (see the denylist in src/mcp/env.ts), " +
        "which must never reach an MCP server, not even as an inlined argument " +
        "(argv is visible in `ps`). Give the server its own secret variable.",
    );
    this.name = "McpCredentialRefusalError";
  }
}

/**
 * Expand every `${VAR}` in `value` from `env`. Only the braced form expands —
 * `$VAR` stays literal (deliberate: auditable, and matches the ADR-0011
 * wording). An undefined variable throws {@link McpEnvError}; a DENYLISTED
 * variable (even when defined) throws {@link McpCredentialRefusalError} —
 * credential values must never be resolved into argv where `ps` can see them.
 */
export function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  location: string,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
    if (credentialVars.has(variable)) {
      throw new McpCredentialRefusalError(variable, location);
    }
    const resolved = env[variable];
    if (resolved === undefined || resolved === "") {
      throw new McpEnvError(variable, location);
    }
    return resolved;
  });
}

/**
 * Expand one server's config for spawning: `args` elements and `env` values
 * get `${VAR}` expansion (errors name `mcpServers.<name>.args[i]` /
 * `mcpServers.<name>.env.<KEY>`); `command` stays literal by design.
 */
export function expandServerConfig(
  name: string,
  config: McpServerConfig,
  cliEnv: Readonly<Record<string, string | undefined>>,
): ExpandedServerConfig {
  const where = `mcpServers.${name}`;
  const args = (config.args ?? []).map((arg, index) =>
    expandEnvVars(arg, cliEnv, `${where}.args[${index}]`),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env ?? {})) {
    env[key] = expandEnvVars(value, cliEnv, `${where}.env.${key}`);
  }
  return { command: config.command, args, env };
}

/**
 * Build the server child's environment: minimal base + exactly the configured
 * (already-expanded) entries, minus the credential denylist. The CLI's own
 * environment is otherwise invisible to the child.
 */
export function buildChildEnv(
  cliEnv: Readonly<Record<string, string | undefined>>,
  configured: Readonly<Record<string, string>>,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = cliEnv[key];
    if (value !== undefined && value !== "") {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(configured)) {
    childEnv[key] = value;
  }
  for (const denied of MCP_CREDENTIAL_ENV_DENYLIST) {
    delete childEnv[denied];
  }
  return childEnv;
}
