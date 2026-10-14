#!/usr/bin/env bun
/**
 * `void` — the headless CLI (ADR-0003: stream-JSON on stdout, logs on stderr).
 *
 * Subcommands:
 *   void run <task...>                  run a task in a new (or --thread) thread
 *   void resume <threadId> <task...>    continue an existing thread
 *   void threads list                   list thread summaries as JSONL
 *   void permissions test <tool> <json> evaluate a tool call, no execution
 *   void settings <path|effective|edit> inspect / merge / edit layered settings
 *   void skills list                    list discovered skills + validation status
 *   void mcp <list|doctor>              inspect configured MCP servers (ADR-0011)
 *   void schema                         print the stream-JSON contract schema
 *   void ui [--thread <id>] [--task <text>]  interactive session view (TUI)
 *   void --version | --help
 *
 * `void --help` lists every subcommand with a one-liner; `void <subcommand>
 * --help` (or `-h`) prints that subcommand's usage — flags table and
 * examples — and exits 0. Rendering is hand-rolled from the SUBCOMMANDS
 * table below (zero runtime dependencies, single source of truth).
 *
 * Flags (run/resume): --model <ref> --workspace <dir> --thread <id> --text.
 * --text adds a human-readable progress summary on stderr; stdout stays the
 * machine contract either way.
 *
 * Settings (ADR-0006): user `$XDG_CONFIG_HOME/void/settings.json` and
 * workspace `.void/settings.json|.jsonc` (cwd-to-git-root walk) layer under
 * `VOID_*` env shadows under CLI flags. For run/resume, user+workspace
 * `permissions` rules are merged WORKSPACE-FIRST into the gate before
 * DEFAULT_RULES; `defaultModel`/`providerTimeoutMs` apply unless overridden.
 * `$VOID_MODEL` stays the pre-existing scriptable model override and still
 * outranks the file layers (applied at this layer, per ADR-0006
 * Consequences); `VOID_DEFAULT_MODEL` is the settings-shaped env shadow.
 *
 * Exit codes: 0 success · 1 permission ask blocked headless · 2 rejected ·
 * 3 provider/stream or run error, INCLUDING malformed settings files
 * (missing files are never fatal) · 64 usage error, including `settings
 * edit` with $EDITOR unset. (`permissions test` uses its own stable codes:
 * 0 allow · 1 ask · 2 reject.) When stdout/stderr is a pipe whose reader
 * closes early (`void schema | head`), the process exits 141 (conventional
 * SIGPIPE, 128+13) instead of crashing — see the entry block at the bottom.
 *
 * Parsing is a hand-rolled pure function (`parseArgs`) and dispatch is fully
 * injected (`runCli`) so tests drive the CLI without a process boundary; the
 * `import.meta.main` guard is the only place `process` is touched.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL_REF } from "./app/models";
import { type AppFetchLike, runTask } from "./app/runner";
import { StreamJsonEmitter, streamJsonSchemaText } from "./app/stream-json";
import type { JsonObject } from "./contracts";
import { runMcpDoctor, runMcpList } from "./mcp/cli";
import { installMcpExitHooks, registerMcpCleaner } from "./mcp/exit";
import { connectMcpServers } from "./mcp/registry";
import { DEFAULT_RULES } from "./permissions";
import { testPermission } from "./permissions/permissionsTest";
import {
  ensureSettingsFile,
  findUserSettingsFile,
  findWorkspaceSettingsFile,
  formatSettingsProblems,
  loadSettings,
  renderSettingsEffective,
  renderSettingsPaths,
  type SettingsLoadResult,
  userSettingsDir,
  WORKSPACE_SETTINGS_DIR,
} from "./settings";
import {
  discoverSkills,
  formatSkillsProblems,
  loadSkillsContext,
  renderSkillsList,
} from "./skills";
import { JsonlThreadStore } from "./store/jsonl";

/** CLI version — keep in sync with package.json. */
export const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Help rendering (hand-rolled; the SUBCOMMANDS table is the source of truth)
// ---------------------------------------------------------------------------

/** One flag row of a subcommand's usage table. */
interface FlagDoc {
  readonly name: string;
  /** Value placeholder shown after the flag; null for boolean flags. */
  readonly arg: string | null;
  readonly description: string;
}

/** Usage documentation for one subcommand. */
interface SubcommandDoc {
  /** Invocation as shown in the bare-help list (name + positionals). */
  readonly label: string;
  readonly summary: string;
  readonly usage: readonly string[];
  readonly flags: readonly FlagDoc[];
  readonly examples: readonly { readonly command: string; readonly note: string }[];
}

const RUN_FLAGS: readonly FlagDoc[] = [
  {
    name: "--model",
    arg: "<ref>",
    description: "Provider/model ref, e.g. anthropic/claude-sonnet-4-5 or ollama/<id>.",
  },
  { name: "--workspace", arg: "<dir>", description: "Workspace root (default: the cwd)." },
  {
    name: "--thread",
    arg: "<id>",
    description: "Continue this thread instead of starting a new one.",
  },
  {
    name: "--text",
    arg: null,
    description: "Add a human-readable progress summary on stderr.",
  },
];

const UI_FLAGS: readonly FlagDoc[] = [
  {
    name: "--thread",
    arg: "<id>",
    description: "View (and continue) this thread; omit with --task for a new one.",
  },
  {
    name: "--task",
    arg: "<text>",
    description: "Start a live run with this task (otherwise replay-only).",
  },
  {
    name: "--model",
    arg: "<ref>",
    description: "Provider/model ref (default: the thread's, or VOID_MODEL).",
  },
  { name: "--workspace", arg: "<dir>", description: "Workspace root (default: the cwd)." },
];

const SUBCOMMANDS: Readonly<Record<Subcommand, SubcommandDoc>> = {
  run: {
    label: "run <task...>",
    summary: "run a task in a new (or --thread) thread",
    usage: ["void run <task...> [--model <ref>] [--workspace <dir>] [--thread <id>] [--text]"],
    flags: RUN_FLAGS,
    examples: [
      {
        command: 'void run "explain what this repo does"',
        note: "one-shot task, exit 0 on success",
      },
      {
        command: 'void run --model ollama/llama3 "add a test"',
        note: "local model via Ollama — fully offline",
      },
      {
        command: 'void run --thread <id> "keep going"',
        note: "continue a thread (same as void resume)",
      },
    ],
  },
  resume: {
    label: "resume <threadId> <task...>",
    summary: "continue an existing thread",
    usage: [
      "void resume <threadId> <task...> [--model <ref>] [--workspace <dir>] [--text] [--compact]",
    ],
    flags: [
      ...RUN_FLAGS.filter((flag) => flag.name !== "--thread"),
      {
        name: "--compact",
        arg: null,
        description: "Compact the thread (summarize older turns) before continuing (ADR-0008).",
      },
    ],
    examples: [
      {
        command: 'void resume thr_abc123 "next step"',
        note: "replays the thread history and continues it",
      },
      {
        command: 'void resume thr_abc123 "next step" --compact',
        note: "summarize the older turns first, then continue",
      },
    ],
  },
  threads: {
    label: "threads list",
    summary: "list thread summaries as JSONL",
    usage: ["void threads list"],
    flags: [],
    examples: [
      { command: "void threads list", note: "one JSON object per line (id, title, createdAt)" },
    ],
  },
  permissions: {
    label: "permissions test <tool> <input-json>",
    summary: "evaluate a tool call, no execution",
    usage: ["void permissions test <tool> <input-json>"],
    flags: [],
    examples: [
      {
        command: 'void permissions test bash \'{"command":"ls -la"}\'',
        note: "exit 0 allow / 1 ask / 2 reject",
      },
    ],
  },
  settings: {
    label: "settings <path|effective|edit>",
    summary: "inspect and edit layered settings files",
    usage: ["void settings path", "void settings effective", "void settings edit [--workspace]"],
    flags: [
      {
        name: "--workspace",
        arg: null,
        description: "(edit) target the workspace layer instead of the user layer.",
      },
    ],
    examples: [
      {
        command: "void settings path",
        note: "print both layers' files and which exist (exit 0 always)",
      },
      {
        command: "void settings effective",
        note: "merged settings + provenance; user < workspace < VOID_* env < flags. Malformed file: exit 3, stderr names file+key+problem",
      },
      {
        command: "void settings edit --workspace",
        note: "create .void/settings.json (0600 skeleton) when absent, then open $EDITOR ($EDITOR unset: exit 64; editor failure: exit 3)",
      },
    ],
  },
  mcp: {
    label: "mcp <list|doctor>",
    summary: "inspect configured MCP servers (ADR-0011)",
    usage: ["void mcp list", "void mcp doctor"],
    flags: [],
    examples: [
      {
        command: "void mcp list",
        note: "one JSONL line per server in settings mcpServers: status + discovered tool names",
      },
      {
        command: "void mcp doctor",
        note: "per-server handshake diagnostics incl. stderr tail; exit 0 healthy / 1 any failure / 3 bad settings",
      },
    ],
  },
  schema: {
    label: "schema",
    summary: "print the stream-JSON contract schema",
    usage: ["void schema"],
    flags: [],
    examples: [{ command: "void schema", note: "the JSON Schema for docs/stream-json.md" }],
  },
  skills: {
    label: "skills list",
    summary: "list discovered skills and their validation status",
    usage: ["void skills list"],
    flags: [],
    examples: [
      {
        command: "void skills list",
        note: "roots in first-wins order, then every skill (name, source, path); invalid entries name file+key (exit 0 always — this is the diagnostic view)",
      },
      {
        command: "void run 'use the commit-style skill'",
        note: "runs discover skills from the same roots; the prompt lists them and the skill tool loads bodies on demand (ADR-0012)",
      },
    ],
  },
  ui: {
    label: "ui [--thread <id>] [--task <text>]",
    summary: "interactive session view (TUI)",
    usage: ["void ui [--thread <id>] [--task <text>] [--model <ref>] [--workspace <dir>]"],
    flags: UI_FLAGS,
    examples: [
      {
        command: 'void ui --task "explain what this repo does"',
        note: "live run rendered in the TUI; prompt submits follow-up turns",
      },
      {
        command: "void ui --thread thr_abc123",
        note: "replay an existing thread read-only, then continue it",
      },
    ],
  },
};

/** The subcommands that have a dedicated help page. */
export type Subcommand =
  | "run"
  | "resume"
  | "threads"
  | "permissions"
  | "settings"
  | "skills"
  | "mcp"
  | "schema"
  | "ui";

/** Column width for the flag table: longest "name <arg>" plus two spaces. */
function flagColumnWidth(flags: readonly FlagDoc[]): number {
  return Math.max(
    ...flags.map((flag) => (flag.arg === null ? flag.name : `${flag.name} ${flag.arg}`).length),
  );
}

/** Render one subcommand's full help page (flags table + examples). */
export function renderSubcommandHelp(subcommand: Subcommand): string {
  const doc = SUBCOMMANDS[subcommand];
  const width = doc.flags.length > 0 ? flagColumnWidth(doc.flags) : 0;
  const lines: string[] = [`void ${doc.label} — ${doc.summary}`, "", "Usage:"];
  for (const usage of doc.usage) {
    lines.push(`  ${usage}`);
  }
  if (doc.flags.length > 0) {
    lines.push("", "Flags:");
    for (const flag of doc.flags) {
      const left = flag.arg === null ? flag.name : `${flag.name} ${flag.arg}`;
      lines.push(`  ${left.padEnd(width)}  ${flag.description}`);
    }
  }
  lines.push("", "Examples:");
  for (const example of doc.examples) {
    lines.push(`  ${example.command}`);
    lines.push(`      ${example.note}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Render the bare `void --help` page: every subcommand with a one-liner. */
export function renderMainHelp(): string {
  const width = Math.max(...Object.values(SUBCOMMANDS).map((doc) => doc.label.length));
  const lines: string[] = [
    `void ${VERSION} — local-first agentic coding CLI (headless, stream-JSON)`,
    "",
    "Usage: void <subcommand> [flags] — run `void <subcommand> --help` for details",
    "",
    "Subcommands:",
  ];
  for (const doc of Object.values(SUBCOMMANDS)) {
    lines.push(`  ${doc.label.padEnd(width)}  ${doc.summary}`);
  }
  lines.push(`  ${"--version | -v".padEnd(width)}  print the version`);
  lines.push(
    "",
    "stdout is always stream-JSON (see docs/stream-json.md); --text adds a human",
    "summary on stderr. Exit codes: 0 success, 1 ask blocked, 2 rejected,",
    "3 provider/run error, 64 usage (permissions test: 0/1/2).",
    "",
  );
  return lines.join("\n");
}

/** Tools the builtin registry exposes (sorted; matches the init event).
 * Anti-drift: pinned equal to the registry's names by cli-composition.test.ts —
 * extend BOTH when adding a builtin. Exported for the mcp-aware init-tools
 * pin (mcp-composition.test.ts asserts init.tools == builtins + connected
 * MCP servers' registered names). `task` (ADR-0013) is always wired by
 * runTask, so it is advertised unconditionally. The ADR-0012 skill pair is
 * appended by the run path only when at least one valid skill was discovered
 * (see SKILL_TOOL_NAMES); with zero skills the list stays exactly this. */
export const BUILTIN_TOOLS = [
  "async_shell_command",
  "async_shell_command_kill",
  "async_shell_command_status",
  "bash",
  "edit_file",
  "glob",
  "grep",
  "read_file",
  "task",
];

/** The lazy-injection pair (ADR-0012), appended to the init event's tool list
 * when discovery found at least one valid skill. */
const SKILL_TOOL_NAMES = ["reload_skills", "skill"] as const;

// ---------------------------------------------------------------------------
// Argument parsing (pure)
// ---------------------------------------------------------------------------

/** Parsed command line — the discriminated union runCli dispatches on. */
export type ParsedCommand =
  | {
      readonly kind: "run";
      readonly task: string;
      readonly model?: string;
      readonly workspace?: string;
      /** `--thread <id>`: continue this thread (same semantics as resume). */
      readonly threadId?: string;
      readonly text: boolean;
    }
  | {
      readonly kind: "resume";
      readonly threadId: string;
      readonly task: string;
      readonly model?: string;
      readonly workspace?: string;
      readonly text: boolean;
      /** `--compact`: force one compaction before continuing (ADR-0008). */
      readonly compact: boolean;
    }
  | { readonly kind: "threadsList" }
  | { readonly kind: "permissionsTest"; readonly tool: string; readonly inputJson: string }
  | { readonly kind: "settingsPath" }
  | { readonly kind: "settingsEffective" }
  | { readonly kind: "settingsEdit"; readonly workspace: boolean }
  | { readonly kind: "skillsList" }
  | { readonly kind: "mcpList" }
  | { readonly kind: "mcpDoctor" }
  | { readonly kind: "schema" }
  | {
      /** Interactive session view (TUI) — dispatched via lazy tui import. */
      readonly kind: "ui";
      readonly threadId?: string;
      readonly task?: string;
      readonly model?: string;
      readonly workspace?: string;
    }
  | { readonly kind: "subcommandHelp"; readonly subcommand: Subcommand }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "usageError"; readonly message: string };

interface FlagValues {
  readonly model?: string;
  readonly workspace?: string;
  readonly thread?: string;
  readonly text: boolean;
  readonly compact: boolean;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--model", "--workspace", "--thread"]);

/**
 * Parse `run`/`resume`-style argument tails: `--flag value` / `--flag=value`
 * plus boolean flags; leftover positionals are the task words. Unknown or
 * valueless flags are usage errors.
 */
function parseFlagsAndPositionals(
  args: readonly string[],
):
  | { readonly ok: true; flags: FlagValues; positionals: string[] }
  | { readonly ok: false; message: string } {
  const flags: {
    model?: string;
    workspace?: string;
    thread?: string;
    text: boolean;
    compact: boolean;
  } = { text: false, compact: false };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      if (name === "--text") {
        flags.text = true;
        continue;
      }
      if (name === "--compact") {
        flags.compact = true;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const value = inlineValue ?? args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, message: `flag ${name} requires a value` };
        }
        if (inlineValue === undefined) {
          i += 1;
        }
        if (name === "--model") {
          flags.model = value;
        } else if (name === "--workspace") {
          flags.workspace = value;
        } else {
          flags.thread = value;
        }
        continue;
      }
      return { ok: false, message: `unknown flag ${JSON.stringify(name)}` };
    }
    positionals.push(arg);
  }
  return { ok: true, flags, positionals };
}

/**
 * True when any argument of a subcommand's tail is a bare `--help`/`-h`
 * token: those flag positions are otherwise rejected or consumed as values,
 * so an explicit help request anywhere in the tail is unambiguous and wins
 * (checked before flag validation so `void run --model m --help`,
 * `void schema --help`, `void permissions test bash --help` all work).
 */
function tailRequestsHelp(rest: readonly string[]): boolean {
  return rest.some((arg) => arg === "--help" || arg === "-h");
}

/** Parse an argv (without the binary name) into a {@link ParsedCommand}. */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return { kind: "help" };
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { kind: "version" };
  }
  if (first === "schema") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "schema" };
    }
    return parseNoArgs(argv.slice(1), { kind: "schema" });
  }
  if (first === "threads") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "threads" };
    }
    const second = argv[1];
    if (second === "list") {
      return parseNoArgs(argv.slice(2), { kind: "threadsList" });
    }
    return { kind: "usageError", message: "threads expects exactly: threads list" };
  }
  if (first === "skills") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "skills" };
    }
    if (argv[1] === "list") {
      return parseNoArgs(argv.slice(2), { kind: "skillsList" });
    }
    return {
      kind: "usageError",
      message:
        "skills expects exactly: skills list (no install command at P1 — manage the directories yourself)",
    };
  }
  if (first === "permissions") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "permissions" };
    }
    if (argv[1] !== "test") {
      return {
        kind: "usageError",
        message: "permissions expects exactly: permissions test <tool> <input-json>",
      };
    }
    const tool = argv[2];
    const inputJson = argv[3];
    if (tool === undefined || inputJson === undefined || argv.length > 4) {
      return { kind: "usageError", message: "permissions test requires <tool> and <input-json>" };
    }
    return { kind: "permissionsTest", tool, inputJson };
  }
  if (first === "settings") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "settings" };
    }
    const second = argv[1];
    if (second === "path") {
      return parseNoArgs(argv.slice(2), { kind: "settingsPath" });
    }
    if (second === "effective") {
      return parseNoArgs(argv.slice(2), { kind: "settingsEffective" });
    }
    if (second === "edit") {
      const rest = argv.slice(2);
      if (rest.length === 0) {
        return { kind: "settingsEdit", workspace: false };
      }
      if (rest.length === 1 && rest[0] === "--workspace") {
        return { kind: "settingsEdit", workspace: true };
      }
      return { kind: "usageError", message: "settings edit accepts at most one flag: --workspace" };
    }
    return {
      kind: "usageError",
      message: "settings expects exactly: settings <path|effective|edit> [--workspace]",
    };
  }
  if (first === "mcp") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "mcp" };
    }
    const second = argv[1];
    if (second === "list") {
      return parseNoArgs(argv.slice(2), { kind: "mcpList" });
    }
    if (second === "doctor") {
      return parseNoArgs(argv.slice(2), { kind: "mcpDoctor" });
    }
    return { kind: "usageError", message: "mcp expects exactly: mcp <list|doctor>" };
  }
  if (first === "run") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "run" };
    }
    const parsed = parseFlagsAndPositionals(argv.slice(1));
    if (!parsed.ok) {
      return { kind: "usageError", message: parsed.message };
    }
    const task = parsed.positionals.join(" ");
    if (task.length === 0) {
      return { kind: "usageError", message: "run requires a task: void run <task...>" };
    }
    if (parsed.flags.compact) {
      return {
        kind: "usageError",
        message: "--compact is only valid with resume: void resume <threadId> <task...> --compact",
      };
    }
    return {
      kind: "run",
      task,
      ...(parsed.flags.model !== undefined ? { model: parsed.flags.model } : {}),
      ...(parsed.flags.workspace !== undefined ? { workspace: parsed.flags.workspace } : {}),
      ...(parsed.flags.thread !== undefined ? { threadId: parsed.flags.thread } : {}),
      text: parsed.flags.text,
    };
  }
  if (first === "resume") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "resume" };
    }
    const tail = argv.slice(1);
    const threadId = tail[0];
    if (threadId === undefined || threadId.startsWith("--")) {
      return {
        kind: "usageError",
        message: "resume requires a thread id: void resume <threadId> <task...>",
      };
    }
    const parsed = parseFlagsAndPositionals(tail.slice(1));
    if (!parsed.ok) {
      return { kind: "usageError", message: parsed.message };
    }
    const task = parsed.positionals.join(" ");
    if (task.length === 0) {
      return {
        kind: "usageError",
        message: "resume requires a task: void resume <threadId> <task...>",
      };
    }
    return {
      kind: "resume",
      threadId,
      task,
      ...(parsed.flags.model !== undefined ? { model: parsed.flags.model } : {}),
      ...(parsed.flags.workspace !== undefined ? { workspace: parsed.flags.workspace } : {}),
      text: parsed.flags.text,
      compact: parsed.flags.compact,
    };
  }
  if (first === "ui") {
    if (tailRequestsHelp(argv.slice(1))) {
      return { kind: "subcommandHelp", subcommand: "ui" };
    }
    return parseUiTail(argv.slice(1));
  }
  return { kind: "usageError", message: `unknown command ${JSON.stringify(first)}` };
}

function parseNoArgs(rest: readonly string[], command: ParsedCommand): ParsedCommand {
  return rest.length === 0
    ? command
    : { kind: "usageError", message: `${rest[0]}: unexpected argument` };
}

/**
 * Parse the `ui` tail: `--thread/--task/--model/--workspace` value flags
 * (`--flag value` or `--flag=value`), no positionals. Dedicated parser so the
 * run/resume grammar (task words as positionals) stays untouched; requires at
 * least `--thread` or `--task` so a bare `void ui` cannot start an empty
 * session.
 */
function parseUiTail(tail: readonly string[]): ParsedCommand {
  const flags: { threadId?: string; task?: string; model?: string; workspace?: string } = {};
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--")) {
      return {
        kind: "usageError",
        message: `ui takes flags, not positionals: ${JSON.stringify(arg)} (task text goes in --task)`,
      };
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name !== "--thread" && name !== "--task" && name !== "--model" && name !== "--workspace") {
      return { kind: "usageError", message: `unknown flag ${JSON.stringify(name)}` };
    }
    const value = inlineValue ?? tail[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "usageError", message: `flag ${name} requires a value` };
    }
    if (inlineValue === undefined) {
      i += 1;
    }
    if (name === "--thread") {
      flags.threadId = value;
    } else if (name === "--task") {
      flags.task = value;
    } else if (name === "--model") {
      flags.model = value;
    } else {
      flags.workspace = value;
    }
  }
  if (flags.threadId === undefined && flags.task === undefined) {
    return { kind: "usageError", message: "ui requires --thread <id> or --task <text>" };
  }
  return {
    kind: "ui",
    ...(flags.threadId !== undefined ? { threadId: flags.threadId } : {}),
    ...(flags.task !== undefined ? { task: flags.task } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
  };
}

// ---------------------------------------------------------------------------
// Dispatch (injected I/O; no process access beyond the optional cwd default)
// ---------------------------------------------------------------------------

export interface CliDeps {
  /** Line sink for stdout (stream-JSON, or command output). */
  readonly stdout: (line: string) => void;
  /** Line sink for stderr (errors, --text summaries). */
  readonly stderr: (line: string) => void;
  /** Environment (VOID_MODEL, VOID_DATA_DIR, provider keys, EDITOR, XDG). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Working directory for --workspace resolution; default process.cwd(). */
  readonly cwd?: string;
  /** Data-dir override (tests); default resolves via the store/env. */
  readonly dataDir?: string;
  /** Fetch injection for providers (tests). */
  readonly fetchImpl?: AppFetchLike;
  /**
   * Editor runner for `void settings edit` (tests); resolves to the editor's
   * exit code. Default: a real `node:child_process` spawn with stdio
   * inherited — the one place the dispatch layer touches child processes.
   */
  readonly runEditor?: (editor: string, path: string) => Promise<number>;
}

/** Run the CLI; resolves to the process exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const command = parseArgs(argv);
  switch (command.kind) {
    case "help":
      for (const line of renderMainHelp().split("\n")) {
        deps.stdout(line);
      }
      return 0;
    case "subcommandHelp":
      for (const line of renderSubcommandHelp(command.subcommand).split("\n")) {
        deps.stdout(line);
      }
      return 0;
    case "version":
      deps.stdout(`void ${VERSION}`);
      return 0;
    case "schema":
      for (const line of streamJsonSchemaText().split("\n")) {
        deps.stdout(line);
      }
      return 0;
    case "threadsList":
      return await runThreadsList(deps);
    case "permissionsTest":
      return runPermissionsTest(command.tool, command.inputJson, deps);
    case "settingsPath":
      return await runSettingsPath(deps);
    case "settingsEffective":
      return await runSettingsEffective(deps);
    case "settingsEdit":
      return await runSettingsEdit(command.workspace, deps);
    case "skillsList":
      return await runSkillsList(deps);
    case "mcpList":
      return await runMcpList(deps);
    case "mcpDoctor":
      return await runMcpDoctor(deps);
    case "run":
    case "resume":
      return await runTaskCommand(command, deps);
    case "ui":
      return await runUiCommand(command, deps);
    case "usageError":
      deps.stderr(`void: ${command.message}`);
      deps.stderr("Run 'void --help' for usage.");
      return 64;
  }
}

async function runThreadsList(deps: CliDeps): Promise<number> {
  const store = new JsonlThreadStore({ ...(deps.dataDir ? { dataDir: deps.dataDir } : {}) });
  const threads = await store.list();
  for (const thread of threads) {
    deps.stdout(
      JSON.stringify({
        id: thread.id,
        ...(thread.title !== undefined ? { title: thread.title } : {}),
        createdAt: thread.createdAt,
      }),
    );
  }
  return 0;
}

function runPermissionsTest(tool: string, inputJson: string, deps: CliDeps): Promise<number> {
  return Promise.resolve().then<number>(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch (cause) {
      deps.stderr(
        `void: <input-json> is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return 64;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      deps.stderr("void: <input-json> must be a JSON object");
      return 64;
    }
    const outcome = testPermission(tool, parsed as JsonObject, DEFAULT_RULES);
    deps.stdout(outcome.explanation);
    return outcome.exitCode;
  });
}

// ---------------------------------------------------------------------------
// `void settings` — layered settings inspection/editing (ADR-0006)
// ---------------------------------------------------------------------------

/** Shared load for the settings subcommands: env + cwd from the injected deps. */
function loadSettingsFromDeps(deps: CliDeps): Promise<SettingsLoadResult> {
  return loadSettings({
    env: deps.env,
    cwd: deps.cwd ?? process.cwd(),
    // JSONC-fallback notices and other info logs go to stderr (ADR-0003:
    // stdout is reserved for command output / the machine contract).
    log: (line) => {
      deps.stderr(line);
    },
  });
}

/** `void settings path`: both layers' files + existence; always exit 0. */
async function runSettingsPath(deps: CliDeps): Promise<number> {
  const settings = await loadSettingsFromDeps(deps);
  for (const line of renderSettingsPaths(settings)) {
    deps.stdout(line);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `void skills` — discovery listing (ADR-0012)
// ---------------------------------------------------------------------------

/** XDG/HOME subset skills discovery consumes (never the whole ambient env). */
function skillsEnv(deps: CliDeps): Readonly<Record<string, string | undefined>> {
  return { XDG_CONFIG_HOME: deps.env.XDG_CONFIG_HOME, HOME: deps.env.HOME };
}

/**
 * `void skills list`: the diagnostic discovery map (ADR-0012) — roots in
 * first-wins order, valid skills (name, source tier, path), invalid entries
 * naming file + key, and shadowed duplicates. Exit 0 always: this command
 * exists to SHOW the state, including the broken parts. Settings problems
 * do not fail the listing either — they only mean `skills.path` cannot be
 * read; they are noted on stderr.
 */
async function runSkillsList(deps: CliDeps): Promise<number> {
  const workspaceRoot = resolve(deps.cwd ?? process.cwd());
  const settings = await loadSettings({ env: deps.env, cwd: workspaceRoot });
  if (settings.problems.length > 0) {
    for (const line of formatSettingsProblems(settings.problems)) {
      deps.stderr(`${line} — skills.path cannot be read until this file is fixed`);
    }
  }
  const result = await discoverSkills({
    workspaceRoot,
    env: skillsEnv(deps),
    ...(settings.effective.skills?.path !== undefined
      ? { skillsPath: settings.effective.skills.path }
      : {}),
  });
  for (const line of renderSkillsList(result)) {
    deps.stdout(line);
  }
  return 0;
}

/**
 * `void settings effective`: the merged view with provenance comments. A
 * malformed existing file is a LOUD failure: structured problems on stderr,
 * exit 3, nothing on stdout (ADR-0006).
 */
async function runSettingsEffective(deps: CliDeps): Promise<number> {
  const settings = await loadSettingsFromDeps(deps);
  if (settings.problems.length > 0) {
    for (const line of formatSettingsProblems(settings.problems)) {
      deps.stderr(line);
    }
    return 3;
  }
  for (const line of renderSettingsEffective(settings)) {
    deps.stdout(line);
  }
  return 0;
}

/**
 * Real $EDITOR spawn for `void settings edit` (the default behind the
 * `runEditor` seam): `EDITOR` may carry arguments ("code -w"), so it is split
 * on whitespace and the file appended; stdio is inherited so the editor is
 * fully interactive. Resolves to the editor's exit code.
 */
const defaultRunEditor = (editor: string, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = editor.split(/\s+/);
    if (command === undefined || command === "") {
      reject(new Error("EDITOR resolved to an empty command"));
      return;
    }
    const child = spawn(command, [...args, path], { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

/**
 * `void settings edit [--workspace]`: open the layer's file in $EDITOR,
 * creating it first (0600 skeleton, exclusive) when absent. The target is
 * the file discovery actually found (JSON or JSONC at any walk level); an
 * absent layer gets its canonical JSON path. $EDITOR unset fails fast with
 * exit 64 BEFORE any file is created; an editor that fails or exits nonzero
 * is a structured error naming editor and path (exit 3).
 */
async function runSettingsEdit(workspace: boolean, deps: CliDeps): Promise<number> {
  const editor = deps.env.EDITOR?.trim();
  if (editor === undefined || editor === "") {
    deps.stderr("void: $EDITOR is not set — set it (e.g. EDITOR=vim) to edit settings files");
    return 64;
  }
  const cwd = resolve(deps.cwd ?? process.cwd());
  const target = workspace
    ? (findWorkspaceSettingsFile(cwd)?.path ?? join(cwd, WORKSPACE_SETTINGS_DIR, "settings.json"))
    : (findUserSettingsFile(deps.env)?.path ?? join(userSettingsDir(deps.env), "settings.json"));
  try {
    const ensured = await ensureSettingsFile(target);
    if (ensured.created) {
      deps.stderr(`void: created ${target} (0600 skeleton)`);
    }
  } catch (cause) {
    deps.stderr(
      `void: could not create settings file ${target}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return 3;
  }
  try {
    const code = await (deps.runEditor ?? defaultRunEditor)(editor, target);
    if (code !== 0) {
      deps.stderr(`void: editor "${editor}" exited with code ${code} while editing ${target}`);
      return 3;
    }
    return 0;
  } catch (cause) {
    deps.stderr(
      `void: could not run editor "${editor}" on ${target}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return 3;
  }
}

interface TaskCommand {
  readonly kind: "run" | "resume";
  readonly task: string;
  readonly model?: string;
  readonly workspace?: string;
  readonly text: boolean;
  readonly threadId?: string;
  /** resume --compact: force one compaction before the first round (ADR-0008). */
  readonly compact?: boolean;
}

/**
 * The deliberate allowlist of ambient environment the CLI forwards into the
 * tool context (runTask `env` → EngineConfig.env → ToolContext.env — the
 * runner and engine never read `process.env` themselves):
 *
 * - `PATH` — grep shells out to `rg` (Bun.which over ctx.env.PATH) and bash
 *   children need the user's PATH, not the minimal fallback
 *   (/usr/local/bin:…) that misses /opt/homebrew/bin and ~/.local/bin.
 * - `HOME` — bash children get it when present (resolving `~` etc.).
 * - `TMPDIR` — spawned tool children (rg) honor it.
 * - `VOID_ALLOW_UNSANDBOXED` — the documented loud unsandboxed opt-out
 *   (bash checks ctx.env.VOID_ALLOW_UNSANDBOXED === "1").
 *
 * Everything else — provider keys, tokens, ambient secrets — stays in the CLI
 * process and is NEVER handed to tool children; provider credentials travel
 * only through runTask's explicit apiKey/ollamaBaseUrl options. Extend this
 * list only with a named, justified key; never widen it to a copy of env.
 */
const TOOL_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "VOID_ALLOW_UNSANDBOXED",
  // Safe tuning knob (a duration, never a secret) documented by ADR-0007's
  // async_shell_command lifetime precedence; listed so the env form actually
  // reaches the tool through the curated env.
  "VOID_ASYNC_MAX_LIFETIME_MS",
];

/**
 * Project the injected env down to {@link TOOL_ENV_ALLOWLIST}. Keys that are
 * absent (or set to the empty string, which tools treat as unset) are
 * omitted, never forwarded as empties.
 */
export function buildToolEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of TOOL_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

/**
 * The tool env with settings-derived knobs layered in (review N1): a
 * `asyncShell.maxLifetimeMs` setting becomes the `VOID_ASYNC_MAX_LIFETIME_MS`
 * env form the async tool reads — but a REAL environment value always wins
 * (env outranks files per ADR-0006), and the explicit tool input outranks
 * both (ADR-0007 precedence: input > env > default).
 */
export function toolEnvWithSettings(
  env: Readonly<Record<string, string | undefined>>,
  effective: { readonly asyncShell?: { readonly maxLifetimeMs?: number } },
): Record<string, string> {
  const forwarded = buildToolEnv(env);
  const fromSettings = effective.asyncShell?.maxLifetimeMs;
  if (fromSettings !== undefined && (env.VOID_ASYNC_MAX_LIFETIME_MS ?? "") === "") {
    forwarded.VOID_ASYNC_MAX_LIFETIME_MS = String(fromSettings);
  }
  return forwarded;
}

async function runTaskCommand(command: TaskCommand, deps: CliDeps): Promise<number> {
  const workspaceRoot = resolve(deps.cwd ?? process.cwd(), command.workspace ?? ".");
  // Settings (ADR-0006): user + workspace files, merged under VOID_* env
  // shadows. loadSettings never throws — existing-but-invalid files come
  // back as structured problems and fail the run loudly below; missing
  // files are never fatal. Info logs (JSONC fallback) go to stderr.
  const settings = await loadSettings({
    env: deps.env,
    cwd: workspaceRoot,
    log: (line) => {
      deps.stderr(line);
    },
  });
  // Skills (ADR-0012): ONE discovery over the root tiers, consuming the
  // settings `skills.path` key here (the key was validated when the settings
  // workstream landed; this is its consumer — `void settings effective` must
  // never display inert keys). The result feeds the prompt list, the init
  // event's tool list, and the lazy skill/reload_skills tools in runTask;
  // problems fail the run loudly below.
  const skillsContext = await loadSkillsContext({
    workspaceRoot,
    env: skillsEnv(deps),
    ...(settings.effective.skills?.path !== undefined
      ? { skillsPath: settings.effective.skills.path }
      : {}),
  });
  // Model precedence: --model > $VOID_MODEL > settings defaultModel >
  // builtin. VOID_MODEL stays the pre-existing scriptable override, applied
  // here at the CLI layer (ADR-0006 Consequences: env shadows resolve before
  // adapter construction; adapters' own env reads are fallbacks only).
  const voidModel = deps.env.VOID_MODEL?.trim();
  const modelRef =
    command.model ??
    (voidModel !== undefined && voidModel !== "" ? voidModel : undefined) ??
    settings.effective.defaultModel ??
    DEFAULT_MODEL_REF;
  // Pre-generate the thread id so the init event can precede the run.
  const generatedId = crypto.randomUUID();
  const threadId = command.threadId ?? generatedId;
  const emitter = new StreamJsonEmitter((line) => {
    deps.stdout(line);
  });
  // Init is emitted ONCE, after the malformed-settings check, through the
  // helper below — carrying builtins + discovered MCP names + the skills pair
  // when skills were found (the union of both merge sides' intents).
  const baseTools = [
    ...BUILTIN_TOOLS,
    ...(skillsContext.discovered.skills.length > 0 ? [...SKILL_TOOL_NAMES] : []),
  ].sort();
  const emitInit = (tools: readonly string[]): void => {
    emitter.init({
      threadId,
      model: modelRef,
      workspaceRoot,
      tools,
      // resume and `run --thread <id>` share one continuation path: both pass
      // the existing id to runTask, which folds the thread history and fails
      // loudly (exit 3, RunnerError unknown_thread) when the id does not exist.
      resumed: command.threadId !== undefined,
      version: VERSION,
    });
  };
  const startedAtMs = Date.now();
  // Malformed settings are loud (ADR-0006): stream consumers get the
  // standard error envelope; stderr carries every structured problem.
  if (settings.problems.length > 0) {
    for (const line of formatSettingsProblems(settings.problems)) {
      deps.stderr(line);
    }
    const first = settings.problems[0];
    const summary =
      first === undefined
        ? "invalid settings"
        : `invalid settings: ${first.path}: ${first.key}: ${first.message}`;
    emitInit(baseTools);
    emitter.finish({
      exitCode: 3,
      threadId,
      result: {
        messages: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
        rounds: 0,
      },
      startedAtMs,
      finishedAtMs: Date.now(),
      runError: summary,
    });
    deps.stderr(`void: ${summary}`);
    return 3;
  }
  // Malformed skills are loud too (ADR-0012: "fail loud, never silently
  // load" — an invalid skill's instructions must not silently not apply).
  // Same envelope as settings problems: stderr carries every structured
  // problem, stream consumers get the error_run result, exit 3.
  if (skillsContext.discovered.problems.length > 0) {
    for (const line of formatSkillsProblems(skillsContext.discovered.problems)) {
      deps.stderr(line);
    }
    const first = skillsContext.discovered.problems[0];
    const summary =
      first === undefined
        ? "invalid skills"
        : `invalid skills: ${first.path}: ${first.key}: ${first.message}`;
    emitter.finish({
      exitCode: 3,
      threadId,
      result: {
        messages: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
        rounds: 0,
      },
      startedAtMs,
      finishedAtMs: Date.now(),
      runError: summary,
    });
    deps.stderr(`void: ${summary}`);
    return 3;
  }

  // MCP servers (ADR-0011): connect every server in effective settings
  // BEFORE the run so their tools join both the registry and the init event
  // (the emitter sorts the names). Per-server failures degrade to a
  // structured mcp__<name>__unavailable tool — never a failed run — with one
  // stderr line per failure; every child is shut down in the finally below.
  const mcp = await connectMcpServers(settings.effective.mcpServers ?? {}, {
    cliEnv: deps.env,
    cwd: workspaceRoot,
    log: (line) => {
      deps.stderr(line);
    },
  });
  // Zombie prevention (ADR-0011): if a signal tears the CLI down mid-run,
  // the exit hooks still run this cleanup (unregistered on the normal path).
  const unregisterMcpCleaner = registerMcpCleaner(() => mcp.shutdown());
  const mcpTools = mcp.specs();
  emitInit([...baseTools, ...mcpTools.map((spec) => spec.name)].sort());

  const textSummary = (line: string): void => {
    if (command.text) {
      deps.stderr(line);
    }
  };

  try {
    const outcome = await runTask({
      task: command.task,
      workspaceRoot,
      modelRef,
      // An explicit thread id (resume positional or `run --thread`) continues
      // that thread; only a plain run generates a fresh one.
      ...(command.threadId !== undefined
        ? { threadId: command.threadId }
        : { newId: () => generatedId }),
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      // Map provider credentials from the injected env (the runner is pure
      // and never reads process.env itself).
      ...(deps.env.VOID_ANTHROPIC_KEY !== undefined || deps.env.ANTHROPIC_API_KEY !== undefined
        ? { apiKey: (deps.env.VOID_ANTHROPIC_KEY ?? deps.env.ANTHROPIC_API_KEY) as string }
        : {}),
      ...(deps.env.VOID_OLLAMA_URL !== undefined
        ? { ollamaBaseUrl: deps.env.VOID_OLLAMA_URL }
        : {}),
      ...(deps.env.VOID_ANTHROPIC_BASE_URL !== undefined
        ? { anthropicBaseUrl: deps.env.VOID_ANTHROPIC_BASE_URL }
        : {}),
      ...(deps.env.VOID_OPENAI_BASE_URL !== undefined
        ? { openaiBaseUrl: deps.env.VOID_OPENAI_BASE_URL }
        : {}),
      ...(deps.env.VOID_OPENAI_KEY !== undefined ? { openaiApiKey: deps.env.VOID_OPENAI_KEY } : {}),
      // Settings wiring (ADR-0006): workspace-then-user permission rules in
      // front of the builtin fallback tail (first-match-wins, so the order
      // IS the precedence — workspace outranks user), plus the provider
      // deadline when a layer set one. No rules in any file → runTask's own
      // DEFAULT_RULES default, unchanged.
      ...(settings.effective.permissions !== undefined
        ? { rules: [...settings.effective.permissions, ...DEFAULT_RULES] }
        : {}),
      // MCP server tools (ADR-0011): appended after the builtins; the
      // runner's gate wraps them identically (mcp__* defaults allow).
      extraTools: mcpTools,
      ...(settings.effective.providerTimeoutMs !== undefined
        ? { providerTimeoutMs: settings.effective.providerTimeoutMs }
        : {}),
      // Curated tool environment (see TOOL_ENV_ALLOWLIST): PATH/HOME/TMPDIR
      // plus the unsandboxed opt-out — never ambient secrets. Without this,
      // ToolContext.env defaults to {} and grep cannot find rg, bash children
      // get the minimal fallback PATH, and VOID_ALLOW_UNSANDBOXED is dead.
      // The async lifetime knob additionally flows from settings when the
      // real environment doesn't carry it (ADR-0006 transparency: `settings
      // effective` must not display keys that do nothing — review N1).
      env: toolEnvWithSettings(deps.env, settings.effective),
      // `void resume --compact` (ADR-0008): one forced compaction of the
      // replayed history before the run continues.
      ...(command.compact ? { forceCompaction: true } : {}),
      // Compaction policy from settings (reviewer R1, same transparency
      // rule): the plain options stay the engine seam; the settings layers
      // just feed them. thresholdPercent is required inside the settings
      // block, so the mapping is total.
      ...(settings.effective.compaction !== undefined
        ? {
            compactionThresholdPercent: settings.effective.compaction.thresholdPercent,
            keepTurns: settings.effective.compaction.keepTurns,
          }
        : {}),
      // Skills context (ADR-0012): the discovery pass from above — the
      // system prompt gains the name+description list and (when any skill
      // exists) the registry gains the lazy skill/reload_skills pair.
      skills: skillsContext,
      onEngineEvent: (event) => {
        if (event.type === "tool_call_started") {
          textSummary(`-> ${event.name} ${JSON.stringify(event.input)}`);
        } else if (event.type === "tool_call_finished") {
          textSummary(`<- ${event.name}: ${event.resultSummary}`);
        } else if (event.type === "turn_finished") {
          textSummary(`.. turn finished (${event.stopReason})`);
        } else if (event.type === "compaction") {
          textSummary(
            `:: compacted ${event.summarizedTurns} turns into a summary ` +
              `(kept ${event.keptTurns}, ${event.trigger})`,
          );
        } else if (event.type === "engine_stopped") {
          textSummary(`:: stopped (${event.reason}${event.message ? `: ${event.message}` : ""})`);
        }
        emitter.engineEvent(event);
      },
      onPermission: (record) => {
        emitter.permission({
          tool: record.tool,
          input: record.input,
          decision: record.action,
          headlessDenied: record.headlessDenied,
          reason: record.reason,
          ...(record.message !== undefined ? { message: record.message } : {}),
        });
      },
    });
    emitter.finish({
      exitCode: outcome.exitCode,
      threadId: outcome.threadId,
      result: outcome.result,
      startedAtMs,
      finishedAtMs: Date.now(),
    });
    textSummary(`thread ${outcome.threadId} — exit ${outcome.exitCode}`);
    return outcome.exitCode;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emitter.finish({
      exitCode: 3,
      threadId,
      result: {
        messages: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
        rounds: 0,
      },
      startedAtMs,
      finishedAtMs: Date.now(),
      runError: message,
    });
    deps.stderr(`void: ${message}`);
    return 3;
  } finally {
    // MCP children are process infrastructure, but never outlive the run
    // (ADR-0011): graceful SIGTERM→grace→SIGKILL on every exit path, and the
    // signal-hook registration goes away with the normal-path shutdown.
    await mcp.shutdown();
    unregisterMcpCleaner();
  }
}

// ---------------------------------------------------------------------------
// `void ui` — interactive session view (ADR-0005: the TUI dependency island)
// ---------------------------------------------------------------------------

/** The parsed `ui` command (see {@link parseUiTail}). */
interface UiCommand {
  readonly kind: "ui";
  readonly threadId?: string;
  readonly task?: string;
  readonly model?: string;
  readonly workspace?: string;
}

/**
 * Dispatch `void ui`. The TUI entry is imported LAZILY (`await import`) so no
 * static import chain reaches react/ink from this file: every headless
 * subcommand — and a headless build with the TUI deps absent — stays
 * untouched (ADR-0005 rules 1+3; enforced by src/tui/dependency-audit.test).
 * Environment policy (model default, credential + tool-env mapping) stays
 * here with the rest of the CLI's env handling; the session gets everything
 * injected.
 */
async function runUiCommand(command: UiCommand, deps: CliDeps): Promise<number> {
  const workspaceRoot = resolve(deps.cwd ?? process.cwd(), command.workspace ?? ".");
  // Settings (ADR-0006), same shape as runTaskCommand: layers merge under
  // VOID_* env shadows; malformed existing files are LOUD (stderr problems,
  // exit 3) before any rendering; missing files are never fatal.
  const settings = await loadSettings({
    env: deps.env,
    cwd: workspaceRoot,
    log: (line) => {
      deps.stderr(line);
    },
  });
  if (settings.problems.length > 0) {
    for (const line of formatSettingsProblems(settings.problems)) {
      deps.stderr(line);
    }
    const first = settings.problems[0];
    deps.stderr(
      `void: ${
        first === undefined
          ? "invalid settings"
          : `invalid settings: ${first.path}: ${first.key}: ${first.message}`
      }`,
    );
    return 3;
  }
  // Model precedence mirrors run/resume: --model > $VOID_MODEL > settings
  // defaultModel > builtin (ADR-0006 Consequences).
  const voidModel = deps.env.VOID_MODEL?.trim();
  const modelRef =
    command.model ??
    (voidModel !== undefined && voidModel !== "" ? voidModel : undefined) ??
    settings.effective.defaultModel ??
    DEFAULT_MODEL_REF;
  const { runUiSession } = await import("./tui/entry");
  return await runUiSession({
    ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
    ...(command.task !== undefined ? { task: command.task } : {}),
    ...(command.model !== undefined ? { modelRef: command.model } : {}),
    defaultModelRef: modelRef,
    workspaceRoot,
    ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    // Parity with runTaskCommand (review N1): the async lifetime knob flows
    // from settings when the env doesn't carry it — TUI sessions get the
    // same curated env as headless runs.
    toolEnv: toolEnvWithSettings(deps.env, settings.effective),
    ...(deps.env.VOID_ANTHROPIC_KEY !== undefined || deps.env.ANTHROPIC_API_KEY !== undefined
      ? { apiKey: (deps.env.VOID_ANTHROPIC_KEY ?? deps.env.ANTHROPIC_API_KEY) as string }
      : {}),
    ...(deps.env.VOID_OLLAMA_URL !== undefined ? { ollamaBaseUrl: deps.env.VOID_OLLAMA_URL } : {}),
    ...(deps.env.VOID_ANTHROPIC_BASE_URL !== undefined
      ? { anthropicBaseUrl: deps.env.VOID_ANTHROPIC_BASE_URL }
      : {}),
    ...(deps.env.VOID_OPENAI_BASE_URL !== undefined
      ? { openaiBaseUrl: deps.env.VOID_OPENAI_BASE_URL }
      : {}),
    ...(deps.env.VOID_OPENAI_KEY !== undefined ? { openaiApiKey: deps.env.VOID_OPENAI_KEY } : {}),
    // Settings wiring (ADR-0006): workspace-then-user rules over the builtin
    // tail; provider deadline when a layer set one.
    ...(settings.effective.permissions !== undefined
      ? { rules: [...settings.effective.permissions, ...DEFAULT_RULES] }
      : {}),
    ...(settings.effective.providerTimeoutMs !== undefined
      ? { providerTimeoutMs: settings.effective.providerTimeoutMs }
      : {}),
    stderr: deps.stderr,
    version: VERSION,
  });
}

// ---------------------------------------------------------------------------
// Process boundary — the ONLY place `process` is touched.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // EPIPE: when stdout/stderr is a pipe whose reader closes early
  // (`void schema | head -3`), a write fails with EPIPE and the runtime
  // would crash with a stack trace. A deliberate early close by the consumer
  // is not our failure, so exit quietly with the conventional SIGPIPE code
  // 141 (128+13). Entry path only — runCli and everything below it stay pure
  // and library-embeddable.
  const exitOnEpipe = (error: Error): void => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(141);
    }
    throw error; // any other stream error is a real bug: crash loudly
  };
  process.stdout.on("error", exitOnEpipe);
  process.stderr.on("error", exitOnEpipe);
  // MCP zombie prevention (ADR-0011): Ctrl-C/SIGTERM mid-run still runs the
  // registered server shutdowns before the process dies (bounded; the
  // client's own shutdown escalates to SIGKILL). Entry path only.
  installMcpExitHooks();
  const code = await runCli(process.argv.slice(2), {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
  });
  process.exitCode = code;
}
